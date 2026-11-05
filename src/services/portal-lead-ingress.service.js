const pool = require('../config/db');
const leadsRepo = require('../repositories/portal-leads.repository');
const imoveisRepo = require('../repositories/imoveis.repository');
const portaisRepo = require('../repositories/portais.repository');
const { sanitizarPayload, hashIp, limparTexto } = require('../utils/sanitize');
const { emailOuNulo, telefoneOuNulo } = require('../validators/imovel.validator');
const { badRequest } = require('../utils/http-error');
const distribuicao = require('./lead-distribution.service');
const filaRepo = require('../repositories/lead-queue.repository');
const filaConfig = require('../config/lead-distribution.config');

/**
 * Camada de ENTRADA de leads.
 *
 * Independente do CRM legado (jmapi.ensuo.com.br) de propósito: o lead é
 * persistido primeiro na base nova, com origem e rastreabilidade
 * completas. O encaminhamento para o CRM atual é um passo posterior e
 * OPCIONAL — hoje ele não está implementado porque não há contrato de
 * ingestão documentado no backend legado. Enquanto isso, o lead fica
 * disponível em `portal_leads` e no painel, com
 * `encaminhado_crm_em = NULL`, sem integração fictícia.
 */

const CAMPOS_UTM = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];

function extrairUtms(origem = {}) {
  const utms = {};

  for (const campo of CAMPOS_UTM) {
    const camel = campo.replace(/_([a-z])/g, (_, letra) => letra.toUpperCase());
    utms[campo] = limparTexto(origem[campo] ?? origem[camel], 160);
  }

  return utms;
}

function dadosDaRequisicao(req) {
  return {
    ip_hash: hashIp(req.ip || req.headers['x-forwarded-for'] || null),
    user_agent: limparTexto(req.headers['user-agent'], 300),
    referer: limparTexto(req.headers.referer || req.headers.referrer, 300)
  };
}

/**
 * Regra de responsável por IMÓVEL (estratégia legada, ainda suportada):
 *   1. corretor responsável pelo imóvel;
 *   2. captador;
 *   3. gerente do imóvel;
 *   4. ninguém — o painel mostra "sem responsável".
 */
function definirResponsavel(imovel) {
  if (!imovel) return { responsavelId: null, filialId: null };

  return {
    responsavelId: imovel.corretor_id || imovel.captador_id || imovel.gerente_id || null,
    filialId: imovel.filial_id || null
  };
}

/**
 * Estratégia de entrada do lead.
 *
 * FILA (padrão): o lead nasce SEM responsável e marcado como aguardando
 * distribuição. Logo após o COMMIT ele passa pela fila circular, que
 * escolhe o próximo corretor online de forma atômica. Se ninguém estiver
 * online o lead permanece aguardando — nunca é perdido e nunca vai para
 * um corretor offline.
 *
 * IMOVEL: comportamento anterior à fila, preservado por configuração.
 */
async function responsavelInicial(imovel) {
  if (require('./operacao/entrada').ativo()) return { responsavelId: null, filialId: imovel?.filial_id || null,
    colunasDistribuicao: { distribuicao_pendente_desde: new Date(), distribuicao_tipo: null } };
  // Enquanto sql/20260830_fila_leads.sql não for executado, as colunas de
  // distribuição não existem: o lead é gravado exatamente como antes.
  const filaAtiva = filaConfig.ESTRATEGIA === 'FILA' && (await filaRepo.filaDisponivel());

  if (!filaAtiva) {
    const { responsavelId, filialId } = definirResponsavel(imovel);

    return {
      responsavelId,
      filialId,
      colunasDistribuicao: (await filaRepo.filaDisponivel())
        ? {
            distribuicao_pendente_desde: responsavelId ? null : new Date(),
            distribuicao_tipo: responsavelId ? 'IMOVEL' : null
          }
        : {}
    };
  }

  return {
    responsavelId: null,
    filialId: imovel?.filial_id || null,
    colunasDistribuicao: {
      distribuicao_pendente_desde: new Date(),
      distribuicao_tipo: null
    }
  };
}

/**
 * Roda a fila depois que o lead já está gravado.
 * Falha aqui NUNCA derruba o cadastro do lead: ele fica pendente e é
 * distribuído na próxima rodada (heartbeat de corretor ou ação do gestor).
 */
async function distribuirAposCadastro(lead) {
  if (lead?.operacao_gerenciada) {
    try { await require('./operacao/fila').distribuir();
      return (await pool.query('SELECT * FROM portal_leads WHERE id=$1',[lead.id])).rows[0] || lead;
    } catch (_) { console.error('[operacao] Lead preservado; aguardando distribuição.'); return lead; }
  }
  if (filaConfig.ESTRATEGIA !== 'FILA' || !lead || lead.responsavel_id) return lead;
  if (!(await filaRepo.filaDisponivel())) return lead;

  try {
    const resultado = await distribuicao.distribuirLead(lead.id, { tipo: 'AUTOMATICA' });
    return resultado.lead || lead;
  } catch (error) {
    console.error('[leads] Falha ao distribuir lead pela fila:', error.message);
    return lead;
  }
}

/** Lead vindo da página pública do imóvel. */
async function registrarInteressePublico({ imovel, body, req }) {
  const nome = limparTexto(body.nome, 180);
  const telefone = telefoneOuNulo(body.telefone);
  const email = emailOuNulo(body.email);

  if (!nome || nome.length < 3) {
    throw badRequest('Informe seu nome.');
  }

  if (!telefone && !email) {
    throw badRequest('Informe ao menos um telefone ou e-mail para contato.');
  }

  const { responsavelId, filialId, colunasDistribuicao } = await responsavelInicial(imovel);
  const utms = extrairUtms(body);

  const client = await pool.connect();
  let liberado=false;

  try {
    await client.query('BEGIN');

    const lead = await leadsRepo.inserir(
      {
        origem: limparTexto(body.origem, 30) === 'LANDING' ? 'LANDING' : 'SITE',
        imovel_id: imovel.id,
        imovel_codigo: imovel.codigo,
        nome,
        email,
        telefone,
        mensagem: limparTexto(body.mensagem, 2000),
        pagina: limparTexto(body.pagina, 300) || `/imovel/${imovel.slug}`,
        ...utms,
        ...dadosDaRequisicao(req),
        payload_original: JSON.stringify(sanitizarPayload(body)),
        status_processamento: responsavelId ? 'ATRIBUIDO' : 'VALIDADO',
        responsavel_id: responsavelId,
        filial_id: filialId,
        atribuido_em: responsavelId ? new Date() : null,
        ...colunasDistribuicao
      },
      client
    );

    await imoveisRepo.recontarLeads(imovel.id, client);

    await client.query('COMMIT');
    client.release(); liberado=true;

    // Fora da transação: o lead já está salvo. A fila é atômica por si.
    return await distribuirAposCadastro(lead);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    if(!liberado) client.release();
  }
}

/**
 * Lead vindo do site institucional (home da imobiliária), sem imóvel
 * obrigatório. Se o visitante informar um código de imóvel, o lead é
 * vinculado a ele; caso contrário entra como contato geral.
 */
async function registrarContatoPublico({ body, req }) {
  const nome = limparTexto(body.nome, 180);
  const telefone = telefoneOuNulo(body.telefone ?? body.whatsapp);
  const email = emailOuNulo(body.email);

  if (!nome || nome.length < 3) {
    throw badRequest('Informe seu nome.');
  }

  if (!telefone && !email) {
    throw badRequest('Informe ao menos um telefone ou e-mail para contato.');
  }

  const codigo = limparTexto(body.codigoImovel ?? body.codigo, 30);

  let imovel = null;

  if (codigo) {
    const busca = await pool.query(
      `
      SELECT * FROM imoveis
      WHERE deleted_at IS NULL
        AND (LOWER(codigo) = LOWER($1) OR LOWER(referencia_externa) = LOWER($1))
      LIMIT 1
      `,
      [codigo]
    );

    imovel = busca.rows[0] || null;
  }

  const { responsavelId, filialId, colunasDistribuicao } = await responsavelInicial(imovel);
  const utms = extrairUtms(body);
  const origem = limparTexto(body.origem, 30) === 'LANDING' ? 'LANDING' : 'SITE';

  const client = await pool.connect();
  let liberado=false;

  try {
    await client.query('BEGIN');

    const lead = await leadsRepo.inserir(
      {
        origem,
        imovel_id: imovel?.id || null,
        imovel_codigo: imovel?.codigo || codigo || null,
        nome,
        email,
        telefone,
        mensagem: limparTexto(body.mensagem, 2000),
        pagina: limparTexto(body.pagina, 300) || '/solucoes',
        ...utms,
        ...dadosDaRequisicao(req),
        payload_original: JSON.stringify(sanitizarPayload(body)),
        status_processamento: responsavelId ? 'ATRIBUIDO' : 'VALIDADO',
        responsavel_id: responsavelId,
        filial_id: filialId,
        atribuido_em: responsavelId ? new Date() : null,
        ...colunasDistribuicao
      },
      client
    );

    if (imovel) {
      await imoveisRepo.recontarLeads(imovel.id, client);
    }

    await client.query('COMMIT');
    client.release(); liberado=true;

    return await distribuirAposCadastro(lead);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    if(!liberado) client.release();
  }
}

/**
 * Solicitação de um proprietário para anunciar um imóvel.
 *
 * Este fluxo é deliberadamente separado dos leads de compradores: não
 * entra no rodízio de corretores e não cria um imóvel. Um administrador
 * analisa a captação, entra em contato e só depois a converte no cadastro
 * completo do anúncio.
 */
async function registrarCaptacaoImovel({ body, req }) {
  const nome = limparTexto(body.nome, 180);
  const telefone = telefoneOuNulo(body.telefone ?? body.whatsapp);
  const email = emailOuNulo(body.email);

  if (!nome || nome.length < 3) {
    throw badRequest('Informe seu nome.');
  }

  if (!telefone && !email) {
    throw badRequest('Informe ao menos um telefone ou e-mail para contato.');
  }

  const utms = extrairUtms(body);

  return leadsRepo.inserir({
    tipo_lead: 'CAPTACAO_IMOVEL',
    captacao_status: 'NOVA',
    origem: 'LANDING',
    nome,
    email,
    telefone,
    mensagem: limparTexto(body.mensagem, 2000),
    pagina: limparTexto(body.pagina, 300) || '/anuncie-seu-imovel',
    ...utms,
    ...dadosDaRequisicao(req),
    payload_original: JSON.stringify(sanitizarPayload(body)),
    status_processamento: 'RECEBIDO',
    responsavel_id: null,
    filial_id: null,
    atribuido_em: null,
    distribuicao_pendente_desde: null,
    distribuicao_tipo: null
  });
}

/**
 * Lead vindo de um portal (webhook).
 * Idempotente por (portal_slug, external_lead_id).
 */
async function registrarLeadDePortal({ portalSlug, body, req }) {
  if (portalSlug === 'grupo-olx') {
    body = require('../integrations/portals/grupo-olx/lead.mapper').normalizarLead(body);
  }
  const portal = await portaisRepo.buscarPortalPorSlug(portalSlug);

  const externalListingId = limparTexto(
    body.externalListingId ?? body.listingId ?? body.codigoImovel,
    120
  );

  let imovel = null;

  if (externalListingId) {
    const busca = await pool.query(
      `
      SELECT * FROM imoveis
      WHERE deleted_at IS NULL
        AND (LOWER(codigo) = LOWER($1) OR LOWER(referencia_externa) = LOWER($1)
          OR EXISTS (SELECT 1 FROM imovel_portais ip JOIN portais p ON p.id=ip.portal_id
            WHERE ip.imovel_id=imoveis.id AND p.slug=$2 AND to_jsonb(ip)->>'listing_id_exportacao'=$1))
      LIMIT 1
      `,
      [externalListingId, portalSlug]
    );

    imovel = busca.rows[0] || null;
  }

  const { responsavelId, filialId, colunasDistribuicao } = await responsavelInicial(imovel);
  const utms = extrairUtms(body);

  const dados = {
    portal_id: portal?.id || null,
    portal_slug: portalSlug,
    origem: 'PORTAL',
    imovel_id: imovel?.id || null,
    imovel_codigo: imovel?.codigo || externalListingId,
    nome: limparTexto(body.nome ?? body.name, 180),
    email: emailOuNulo(body.email),
    telefone: telefoneOuNulo(body.telefone ?? body.phone),
    mensagem: limparTexto(body.mensagem ?? body.message, 2000),
    external_lead_id: limparTexto(body.externalLeadId ?? body.leadId ?? body.id, 120),
    external_listing_id: externalListingId,
    ...utms,
    ...dadosDaRequisicao(req),
    payload_original: JSON.stringify(sanitizarPayload(body)),
    status_processamento: imovel ? (responsavelId ? 'ATRIBUIDO' : 'VALIDADO') : 'RECEBIDO',
    responsavel_id: responsavelId,
    filial_id: filialId,
    atribuido_em: responsavelId ? new Date() : null,
    ...colunasDistribuicao,
    erro_processamento: imovel || body.contatoGeral
      ? null
      : `Imóvel não localizado para o identificador externo "${externalListingId || 'não informado'}".`
  };

  const client = await pool.connect();
  let lead, duplicado;
  try {
    await client.query('BEGIN');
    ({ lead, duplicado } = await leadsRepo.inserirIdempotente(dados, client));
    if (!duplicado && imovel) await imoveisRepo.recontarLeads(imovel.id, client);
    await portaisRepo.registrarLog({
      portalId: portal?.id || null, portalSlug, imovelId: imovel?.id || null,
      operacao: 'IMPORT_LEADS', status: duplicado ? 'IGNORADO' : (imovel || body.contatoGeral ? 'OK' : 'AVISO'),
      mensagem: duplicado ? 'Lead já registrado anteriormente (idempotência).' : 'Lead recebido e persistido.',
      externalId: dados.external_lead_id, detalhes: sanitizarPayload(body)
    }, client);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
  // Libera a conexão antes de acionar o rodízio. O lead e seu log já
  // estão confirmados; uma indisponibilidade da fila não perde o contato.
  const final = duplicado ? lead : await distribuirAposCadastro(lead);
  return { lead: final, duplicado };
}

/** Marca o primeiro atendimento — base para SLA futuro. */
async function marcarPrimeiroAtendimento(leadId, usuario) {
  const atual=(await pool.query('SELECT * FROM portal_leads WHERE id=$1',[leadId])).rows[0];
  if(atual?.operacao_gerenciada){
    if(!atual.responsavel_id)throw badRequest('Este lead deve ser atribuído pela fila antes do atendimento.');
    await require('./operacao/fila').editar(leadId,{etapa:atual.etapa==='NOVO'?'EM_ATENDIMENTO':atual.etapa,
      descricao:'Primeiro atendimento registrado pelo painel.',versao:atual.versao_atendimento},usuario);
    return (await pool.query('SELECT * FROM portal_leads WHERE id=$1',[leadId])).rows[0];
  }
  // A coluna de distribuição só existe depois da migration da fila.
  const limparPendencia = (await filaRepo.filaDisponivel())
    ? 'distribuicao_pendente_desde = NULL,'
    : '';

  const result = await pool.query(
    `
    UPDATE portal_leads
    SET primeiro_atendimento_em = COALESCE(primeiro_atendimento_em, NOW()),
        responsavel_id = COALESCE(responsavel_id, $2),
        atribuido_em = COALESCE(atribuido_em, NOW()),
        ${limparPendencia}
        status_processamento = CASE
          WHEN status_processamento IN ('RECEBIDO', 'VALIDADO') THEN 'ATRIBUIDO'
          ELSE status_processamento
        END,
        updated_at = NOW()
    WHERE id = $1
    RETURNING *
    `,
    [leadId, usuario.id]
  );

  return result.rows[0] || null;
}

function mapearLead(row) {
  return {
    id: row.id,
    nome: row.nome,
    email: row.email,
    telefone: row.telefone,
    mensagem: row.mensagem,
    origem: row.origem,
    distribuicaoTipo: row.distribuicao_tipo || null,
    distribuicaoPosicao: row.distribuicao_posicao ?? null,
    aguardandoDistribuicaoDesde: row.distribuicao_pendente_desde || null,
    portalSlug: row.portal_slug,
    portalNome: row.portal_nome || null,
    imovelId: row.imovel_id,
    imovelCodigo: row.imovel_codigo_atual || row.imovel_codigo,
    imovelTitulo: row.imovel_titulo || null,
    imovelSlug: row.imovel_slug || null,
    pagina: row.pagina,
    utmSource: row.utm_source,
    utmMedium: row.utm_medium,
    utmCampaign: row.utm_campaign,
    utmContent: row.utm_content,
    utmTerm: row.utm_term,
    statusProcessamento: row.status_processamento,
    erroProcessamento: row.erro_processamento,
    responsavelId: row.responsavel_id,
    responsavelNome: row.responsavel_nome || null,
    recebidoEm: row.recebido_em,
    atribuidoEm: row.atribuido_em,
    primeiroAtendimentoEm: row.primeiro_atendimento_em,
    encaminhadoCrmEm: row.encaminhado_crm_em
  };
}

module.exports = {
  registrarInteressePublico,
  registrarContatoPublico,
  registrarCaptacaoImovel,
  registrarLeadDePortal,
  marcarPrimeiroAtendimento,
  mapearLead,
  definirResponsavel,
  responsavelInicial,
  distribuirAposCadastro
};
