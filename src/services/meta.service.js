const crypto = require('crypto');
const pool = require('../config/db');
const api = require('../integrations/meta/graph');
const { cifrar, decifrar, cryptoDisponivel } = require('../utils/crypto');
const { HttpError, badRequest, conflict } = require('../utils/http-error');
const SCOPES = ['business_management', 'ads_read', 'ads_management', 'pages_show_list',
  'pages_read_engagement', 'pages_manage_metadata', 'leads_retrieval'];
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

function diagnostico() {
  const c = api.config();
  return { appConfigurado: !!(c.appId && c.secret && c.redirectUri && c.verifyToken && cryptoDisponivel() && process.env.FRONTEND_URL),
    versao: c.versao, callbackUrl: c.redirectUri || null,
    webhookUrl: process.env.PUBLIC_API_URL ? `${process.env.PUBLIC_API_URL.replace(/\/+$/, '')}/integracoes/meta/webhook` : null,
    permissoes: SCOPES };
}
async function status() {
  const conexao = (await pool.query('SELECT usuario_meta_id, nome, expira_em, atualizado_em FROM meta_conexoes WHERE id=1')).rows[0];
  const fila = (await pool.query(`SELECT count(*) FILTER (WHERE concluido_em IS NULL)::int AS pendentes,
    count(*) FILTER (WHERE concluido_em IS NULL AND tentativas > 0)::int AS com_erro,
    count(*) FILTER (WHERE concluido_em IS NOT NULL)::int AS processados FROM meta_lead_eventos`)).rows[0];
  return { ...diagnostico(), conectado: !!conexao, conexao: conexao || null, fila };
}
async function tokenUsuario() {
  const row = (await pool.query('SELECT token_cifrado, expira_em FROM meta_conexoes WHERE id=1')).rows[0];
  if (!row || (row.expira_em && new Date(row.expira_em) <= new Date())) throw new HttpError(401, 'Conecte ou renove sua conta Facebook.');
  return decifrar(row.token_cifrado).access_token;
}
async function iniciarOAuth(usuario) {
  if (!diagnostico().appConfigurado) throw new HttpError(503, 'Configure o aplicativo Meta, URLs públicas e chave de criptografia no servidor.');
  const c = api.config();
  const state = crypto.randomBytes(32).toString('hex');
  await pool.query('DELETE FROM meta_oauth_estados WHERE expira_em < now()');
  await pool.query("INSERT INTO meta_oauth_estados(hash,usuario_id,expira_em) VALUES($1,$2,now()+interval '10 minutes')", [hash(state), usuario.id]);
  const url = new URL(`https://www.facebook.com/${c.versao}/dialog/oauth`);
  url.search = new URLSearchParams({ client_id: c.appId, redirect_uri: c.redirectUri, response_type: 'code', state,
    scope: SCOPES.join(','), auth_type: 'rerequest' }).toString();
  return { url: url.href };
}
async function callback(query) {
  if (!/^[a-f0-9]{64}$/.test(String(query.state || ''))) throw badRequest('Estado OAuth inválido.');
  // DELETE RETURNING é atômico, impede replay e funciona entre réplicas.
  const row = (await pool.query('DELETE FROM meta_oauth_estados WHERE hash=$1 AND expira_em>now() RETURNING usuario_id', [hash(query.state)])).rows[0];
  if (!row) throw badRequest('Conexão expirada ou já utilizada. Inicie novamente.');
  const user = (await pool.query("SELECT id FROM usuarios WHERE id=$1 AND ativo AND perfil='admin'", [row.usuario_id])).rows[0];
  if (!user) throw new HttpError(403, 'Administrador sem acesso.');
  if (query.error || !query.code || typeof query.code !== 'string') throw badRequest('Autorização Facebook cancelada.');
  const c = api.config();
  const curto = await api.graph('oauth/access_token', null, { client_id: c.appId, client_secret: c.secret, redirect_uri: c.redirectUri, code: query.code });
  const longo = await api.graph('oauth/access_token', null, { grant_type: 'fb_exchange_token', client_id: c.appId, client_secret: c.secret, fb_exchange_token: curto.access_token });
  if (!longo.access_token) throw new HttpError(502, 'Meta não retornou credencial de acesso.');
  const permissoes = await api.listar('me/permissions', longo.access_token);
  const faltantes = SCOPES.filter(scope => !permissoes.some(p => p.permission === scope && p.status === 'granted'));
  if (faltantes.length) throw new HttpError(422, 'Permissões Meta incompletas. Refaça a conexão autorizando os recursos solicitados.', { faltantes });
  const me = await api.graph('me', longo.access_token, { fields: 'id,name' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const anterior = (await client.query('SELECT usuario_meta_id FROM meta_conexoes WHERE id=1 FOR UPDATE')).rows[0];
    if (anterior && anterior.usuario_meta_id !== me.id) throw conflict('Já existe outra conta conectada. Preserve o recebimento de leads e revise a troca com o administrador.');
    await client.query(`INSERT INTO meta_conexoes(id,usuario_meta_id,nome,token_cifrado,expira_em,conectado_por)
      VALUES(1,$1,$2,$3,$4,$5) ON CONFLICT(id) DO UPDATE SET usuario_meta_id=excluded.usuario_meta_id,
      nome=excluded.nome,token_cifrado=excluded.token_cifrado,expira_em=excluded.expira_em,
      conectado_por=excluded.conectado_por, atualizado_em=now()`, [me.id, me.name, cifrar({ access_token: longo.access_token }),
      longo.expires_in ? new Date(Date.now() + Number(longo.expires_in) * 1000) : null, user.id]);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}
async function negocios() { return api.listar('me/businesses', await tokenUsuario(), { fields: 'id,name' }); }
async function contas(businessId) {
  const token = await tokenUsuario();
  if (!businessId) return api.listar('me/adaccounts', token, { fields: 'id,name,currency,timezone_name,account_status' });
  api.idMeta(businessId);
  const bms = await negocios();
  if (!bms.some(b => b.id === businessId)) throw new HttpError(403, 'BM fora da conta conectada.');
  const fields = 'id,name,currency,timezone_name,account_status';
  const [owned, client] = await Promise.all([
    api.listar(`${businessId}/owned_ad_accounts`, token, { fields }), api.listar(`${businessId}/client_ad_accounts`, token, { fields })
  ]);
  return [...new Map([...owned, ...client].map(a => [a.id, a])).values()];
}
async function paginas() {
  const pages = await api.listar('me/accounts', await tokenUsuario(), { fields: 'id,name,access_token,tasks' });
  const inscritas = (await pool.query('SELECT id,inscrita FROM meta_paginas')).rows;
  return pages.map(p => ({ id: p.id, name: p.name, tasks: p.tasks, inscrita: !!inscritas.find(i => i.id === p.id)?.inscrita }));
}
async function assinarPagina(pageId) {
  api.idMeta(pageId);
  const pages = await api.listar('me/accounts', await tokenUsuario(), { fields: 'id,name,access_token' });
  const p = pages.find(p => p.id === pageId);
  if (!p?.access_token) throw new HttpError(403, 'Página sem acesso na conta conectada.');
  // Persistir token antes da assinatura: um evento pode chegar imediatamente.
  await pool.query(`INSERT INTO meta_paginas(id,nome,token_cifrado) VALUES($1,$2,$3)
    ON CONFLICT(id) DO UPDATE SET nome=excluded.nome,token_cifrado=excluded.token_cifrado,atualizado_em=now()`, [p.id,p.name,cifrar({ access_token: p.access_token })]);
  const r = await api.graph(`${p.id}/subscribed_apps`, p.access_token, { subscribed_fields: 'leadgen' }, 'POST');
  if (r.success !== true) throw new HttpError(502, 'A Meta não confirmou a assinatura da página.');
  await pool.query('UPDATE meta_paginas SET inscrita=true WHERE id=$1', [p.id]);
  return { ok: true };
}
async function tokenPagina(pageId) {
  api.idMeta(pageId);
  const p = (await pool.query('SELECT token_cifrado FROM meta_paginas WHERE id=$1', [pageId])).rows[0];
  if (!p) throw new HttpError(403, 'Página não conectada para recebimento de leads.');
  return decifrar(p.token_cifrado).access_token;
}
async function formularios(pageId) {
  return api.listar(`${api.idMeta(pageId)}/leadgen_forms`, await tokenPagina(pageId), { fields: 'id,name,status' });
}
async function recuperarLeads(pageId, formId) {
  api.idMeta(formId);
  const forms = await formularios(pageId);
  if (!forms.some(f => f.id === formId)) throw new HttpError(403, 'Formulário fora da página selecionada.');
  const leads = await api.listar(`${formId}/leads`, await tokenPagina(pageId), { fields: 'id' });
  for (const lead of leads) api.idMeta(lead.id);
  const rows = leads.map(lead => ({ lead_id: lead.id, page_id: pageId,
    payload: { leadgen_id: lead.id, page_id: pageId, form_id: formId, recuperado: true } }));
  const r = await pool.query(`INSERT INTO meta_lead_eventos(lead_id,page_id,payload)
    SELECT x.lead_id,x.page_id,x.payload FROM jsonb_to_recordset($1::jsonb) AS x(lead_id text,page_id text,payload jsonb)
    ON CONFLICT(lead_id) DO NOTHING RETURNING lead_id`, [JSON.stringify(rows)]);
  return { encontrados: leads.length, enfileirados: r.rowCount };
}
async function validarConta(accountId) {
  if (!/^act_\d{1,40}$/.test(String(accountId))) throw badRequest('Conta de anúncios inválida.');
  const accounts = await contas();
  const account = accounts.find(a => a.id === accountId);
  if (!account) throw new HttpError(403, 'Conta de anúncios fora da conexão atual.');
  return account;
}
async function campanhas(accountId) {
  await validarConta(accountId);
  return api.listar(`${accountId}/campaigns`, await tokenUsuario(), { fields: 'id,name,status,effective_status,objective,daily_budget,lifetime_budget' });
}
async function custos(accountId, desde, ate) {
  await validarConta(accountId);
  const valid = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s)) && !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().slice(0,10) === s;
  if (!valid(desde) || !valid(ate) || desde > ate || Date.parse(ate)-Date.parse(desde)>366*86400000) throw badRequest('Período inválido; use até 366 dias.');
  return api.listar(`${accountId}/insights`, await tokenUsuario(), { level: 'campaign',
    fields: 'campaign_id,campaign_name,spend,impressions,clicks,cpc,cpm,actions,cost_per_action_type,date_start,date_stop',
    time_range: { since: desde, until: ate } });
}
function dadosCampanha(body) {
  const nome = typeof body.nome === 'string' ? body.nome.trim() : '';
  if (!nome || nome.length > 200) throw badRequest('Informe um nome de campanha com até 200 caracteres.');
  if (!Number.isSafeInteger(body.orcamentoCentavos) || body.orcamentoCentavos < 100 || body.orcamentoCentavos > 100000000) throw badRequest('Orçamento diário inválido; informe centavos inteiros.');
  return { name: nome, objective: 'OUTCOME_LEADS', status: 'PAUSED', special_ad_categories: ['HOUSING'],
    daily_budget: body.orcamentoCentavos, bid_strategy: 'LOWEST_COST_WITHOUT_CAP', is_adset_budget_sharing_enabled: false };
}
async function operacaoUnica(chave, usuario, dados, executar) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(chave))) throw badRequest('Chave de operação inválida.');
  const digest = hash(JSON.stringify(dados));
  const r = await pool.query('INSERT INTO meta_operacoes(chave,usuario_id,hash) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING chave', [chave, usuario.id, digest]);
  if (!r.rowCount) {
    const anterior = (await pool.query('SELECT * FROM meta_operacoes WHERE chave=$1', [chave])).rows[0];
    if (anterior.usuario_id !== usuario.id || anterior.hash !== digest) throw conflict('Chave já utilizada para outra operação.');
    if (anterior.status === 'CONCLUIDA') return anterior.resultado;
    throw conflict('Operação pendente ou de resultado incerto. Confira na Meta antes de tentar com outra chave.');
  }
  // Em falha de rede, manter PENDENTE: retentar automaticamente criaria duplicata.
  const resultado = await executar();
  await pool.query("UPDATE meta_operacoes SET status='CONCLUIDA',resultado=$2 WHERE chave=$1", [chave, JSON.stringify(resultado)]);
  return resultado;
}
async function criarCampanha(accountId, body, usuario) {
  const conta = await validarConta(accountId);
  if (conta.currency !== 'BRL') throw badRequest('Criação com orçamento em centavos disponível para contas em BRL.');
  const dados = dadosCampanha(body);
  return operacaoUnica(body.chave, usuario, { accountId, ...dados }, async () => api.graph(`${accountId}/campaigns`, await tokenUsuario(), dados, 'POST'));
}
async function editarCampanha(accountId, campaignId, body, usuario) {
  api.idMeta(campaignId);
  const lista = await campanhas(accountId);
  const campanha = lista.find(c => c.id === campaignId);
  if (!campanha) throw new HttpError(403, 'Campanha fora da conta selecionada.');
  const dados = {};
  if (body.status !== undefined) {
    if (!['ACTIVE', 'PAUSED'].includes(body.status)) throw badRequest('Status inválido.');
    if (body.status === 'ACTIVE' && body.confirmarGasto !== true) throw badRequest('Confirme a ativação com possibilidade de cobrança pela Meta.');
    dados.status = body.status;
  }
  if (body.orcamentoCentavos !== undefined) {
    const conta = await validarConta(accountId);
    if (conta.currency !== 'BRL') throw badRequest('Edição de orçamento em centavos disponível para contas em BRL.');
    if (!campanha.daily_budget || Number(campanha.daily_budget) <= 0) throw badRequest('Esta campanha usa orçamento em conjuntos ou vitalício. Gerencie esse orçamento no Meta Ads Manager.');
    dados.daily_budget = dadosCampanha({ nome: campanha.name, orcamentoCentavos: body.orcamentoCentavos }).daily_budget;
  }
  if (!Object.keys(dados).length) throw badRequest('Nenhuma alteração informada.');
  return operacaoUnica(body.chave, usuario, { accountId, campaignId, ...dados }, async () => api.graph(campaignId, await tokenUsuario(), dados, 'POST'));
}
module.exports = { diagnostico, status, iniciarOAuth, callback, negocios, contas, paginas, assinarPagina,
  formularios, recuperarLeads, tokenPagina, campanhas, custos, criarCampanha, editarCampanha, dadosCampanha, operacaoUnica };
