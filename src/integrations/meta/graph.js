const crypto = require('crypto');
const { HttpError, badRequest } = require('../../utils/http-error');

function idMeta(value) {
  if (!/^\d{1,40}$/.test(String(value || ''))) throw badRequest('Identificador Meta inválido.');
  return String(value);
}
function config() {
  const versao = process.env.META_GRAPH_VERSION || 'v25.0';
  if (!/^v\d+\.0$/.test(versao)) throw new HttpError(503, 'META_GRAPH_VERSION inválida.');
  return { versao, appId: process.env.META_APP_ID, secret: process.env.META_APP_SECRET,
    redirectUri: process.env.META_REDIRECT_URI, verifyToken: process.env.META_WEBHOOK_VERIFY_TOKEN };
}
async function graph(path, token, params = {}, method = 'GET') {
  const { versao, secret } = config();
  if (!/^[a-zA-Z0-9_/-]+$/.test(path) || path.includes('..')) throw badRequest('Recurso Meta inválido.');
  const url = new URL(`https://graph.facebook.com/${versao}/${path}`);
  const dados = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) dados.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
  }
  if (token && secret) dados.set('appsecret_proof', crypto.createHmac('sha256', secret).update(token).digest('hex'));
  const options = { method, redirect: 'error', signal: AbortSignal.timeout(20000), headers: {} };
  if (token) options.headers.Authorization = `Bearer ${token}`;
  if (method === 'GET') url.search = dados.toString();
  else { options.body = dados; options.headers['Content-Type'] = 'application/x-www-form-urlencoded'; }
  let response;
  try { response = await fetch(url, options); }
  catch (_) { throw new HttpError(502, 'Meta indisponível ou tempo esgotado. Verifique o resultado antes de repetir uma alteração.'); }
  let body;
  try { body = await response.json(); } catch (_) { throw new HttpError(502, 'Resposta inválida da Meta.'); }
  if (!response.ok || body.error) {
    // Não repassar mensagens que possam carregar tokens/URLs da requisição.
    const code = Number(body.error?.code) || response.status;
    throw new HttpError(code === 190 ? 401 : 502,
      code === 190 ? 'Sessão Meta expirada. Reconecte a conta.' : `Meta recusou a operação (código ${code}, subcódigo ${Number(body.error?.error_subcode) || 0}). Confira permissões, ativos e a configuração do aplicativo.`);
  }
  return body;
}

// Reconstrói cada URL; nunca segue paging.next, que contém o token.
async function listar(path, token, params = {}) {
  const items = [];
  let after;
  const visitados = new Set();
  for (let pagina = 0; pagina < 100; pagina++) {
    const body = await graph(path, token, { limit: 100, ...params, after });
    if (!Array.isArray(body.data)) throw new HttpError(502, 'Lista inválida recebida da Meta.');
    items.push(...body.data);
    if (!body.paging?.next) return items;
    after = body.paging?.cursors?.after;
    if (!after || visitados.has(after)) throw new HttpError(502, 'Paginação Meta incompleta. Nenhum ativo será descartado silenciosamente.');
    visitados.add(after);
  }
  throw new HttpError(502, 'Quantidade de páginas Meta acima do limite. Refine a consulta.');
}
function assinaturaValida(raw, header, secret = config().secret) {
  if (!secret || !Buffer.isBuffer(raw) || !/^sha256=[a-f0-9]{64}$/.test(String(header || ''))) return false;
  const esperado = crypto.createHmac('sha256', secret).update(raw).digest();
  return crypto.timingSafeEqual(esperado, Buffer.from(header.slice(7), 'hex'));
}
module.exports = { graph, listar, config, idMeta, assinaturaValida };
