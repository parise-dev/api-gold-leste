const pool = require('../config/db');
const portaisRepo = require('../repositories/portais.repository');
const midiasRepo = require('../repositories/imovel-midias.repository');
const imoveisRepo = require('../repositories/imoveis.repository');
const logsImovelRepo = require('../repositories/imovel-logs.repository');
const { obterAdapter, resumoAdapters } = require('../integrations/portals/registry');
const { notFound, badRequest, HttpError } = require('../utils/http-error');
const { sanitizarPayload, mascararSegredo } = require('../utils/sanitize');
const { cifrar, decifrar, gerarToken, cryptoDisponivel } = require('../utils/crypto');

function baseUrlPublica() {
  return (process.env.PUBLIC_API_URL || 'https://api.gold-leste.online').replace(/\/+$/, '');
}

function montarUrlFeed(portalSlug, token) {
  if (!token) return null;
  return `${baseUrlPublica()}/public/feeds/${portalSlug}/${token}.xml`;
}

/** Nunca devolve credencial — só metadados e máscara. */
function mapearPortal(row) {
  const adapter = obterAdapter(row.slug);

  return {
    id: row.id,
    slug: row.slug,
    nome: row.nome,
    descricao: row.descricao,
    modoIntegracao: row.modo_integracao,
    statusImplementacao: row.status_implementacao,
    documentacaoUrl: row.documentacao_url,
    ativo: row.ativo,

    capacidades: adapter ? adapter.capacidades() : null,
    pendencias: adapter ? adapter.pendencias : [],
    camposConfiguracao: adapter ? adapter.camposConfiguracao() : [],

    integracao: {
      id: row.integracao_id || null,
      habilitado: !!row.integracao_habilitada,
      status: row.integracao_status || 'PENDING_CONFIGURATION',
      feedHabilitado: !!row.feed_habilitado,
      webhookUrl: (row.webhook_token || row.feed_token) ? `${baseUrlPublica()}/public/leads/${row.slug}/${row.webhook_token || row.feed_token}` : null,
      feedUrl: row.feed_habilitado ? montarUrlFeed(row.slug, row.feed_token) : null,
      possuiToken: !!row.feed_token,
      contatoNome: row.contato_nome,
      contatoEmail: row.contato_email,
      contatoTelefone: row.contato_telefone,
      contatoSite: row.contato_site,
      contatoLogoUrl: row.contato_logo_url,
      contatoCidade: row.contato_cidade,
      contatoUf: row.contato_uf,
      contatoBairro: row.contato_bairro,
      contatoEndereco: row.contato_endereco,
      contatoCep: row.contato_cep,
      config: row.config || {},
      credenciaisResumo: row.credenciais_resumo || {},
      ultimaSincronizacao: row.ultima_sincronizacao,
      ultimoErro: row.ultimo_erro,
      ultimoTesteEm: row.ultimo_teste_em,
      ultimoTesteOk: row.ultimo_teste_ok
    },

    metricas: {
      selecionados: row.total_selecionados || 0,
      publicados: row.total_publicados || 0,
      comErro: row.total_com_erro || 0,
      leadsRecebidos: row.total_leads || 0
    }
  };
}

async function listar() {
  const rows = await portaisRepo.listarPortais();
  return rows.map(mapearPortal);
}

async function detalhar(portalId) {
  const rows = await portaisRepo.listarPortais();
  const row = rows.find((item) => item.id === portalId);

  if (!row) throw notFound('Portal não encontrado.');

  return mapearPortal(row);
}

const CAMPOS_CONTATO = [
  'contato_nome', 'contato_email', 'contato_telefone', 'contato_site',
  'contato_logo_url', 'contato_cidade', 'contato_uf', 'contato_bairro',
  'contato_endereco', 'contato_cep'
];

/**
 * Salva configuração da integração.
 * Credenciais entram cifradas; o que volta para a API é só um resumo
 * mascarado ("abc***xyz") — o valor completo nunca sai do servidor.
 */
async function salvarConfiguracao({ portalId, body, usuario }) {
  const portal = await portaisRepo.buscarPortalPorId(portalId);
  if (!portal) throw notFound('Portal não encontrado.');

  const dados = { updated_by: usuario.id };

  for (const campo of CAMPOS_CONTATO) {
    const chaveCamel = campo.replace(/_([a-z])/g, (_, letra) => letra.toUpperCase());

    if (Object.prototype.hasOwnProperty.call(body, chaveCamel)) {
      dados[campo] = body[chaveCamel] ? String(body[chaveCamel]).slice(0, 300) : null;
    }
  }

  if (Object.prototype.hasOwnProperty.call(body, 'habilitado')) {
    dados.habilitado = !!body.habilitado;
  }

  if (Object.prototype.hasOwnProperty.call(body, 'feedHabilitado')) {
    dados.feed_habilitado = !!body.feedHabilitado;
  }

  if (body.config && typeof body.config === 'object') {
    dados.config = JSON.stringify(body.config);
  }

  // Token do feed: gerado quando o feed é habilitado, ou sob pedido.
  const integracaoAtual = await portaisRepo.buscarIntegracao(portalId);

  // Migração aditiva opcional: manter URL anterior válida, mas separar novos
  // webhooks do token do XML. Sem migração, o contrato legado continua igual.
  if (integracaoAtual && Object.prototype.hasOwnProperty.call(integracaoAtual, 'webhook_token') && !integracaoAtual.webhook_token) {
    dados.webhook_token = gerarToken(24);
  }

  if (integracaoAtual?.feed_versao_id && (body.regenerarToken === true || dados.habilitado === false || dados.feed_habilitado === false)) {
    throw new HttpError(409, 'Feed aprovado protegido: não é permitido desativar ou trocar seu token durante a homologação.');
  }

  const precisaToken =
    (dados.feed_habilitado || integracaoAtual?.feed_habilitado) &&
    !integracaoAtual?.feed_token;

  if (precisaToken || body.regenerarToken === true) {
    dados.feed_token = gerarToken(24);
  }

  if (body.credenciais && typeof body.credenciais === 'object') {
    if (!cryptoDisponivel()) {
      throw new HttpError(
        503,
        'INTEGRACOES_CRYPTO_KEY não configurada na API. Defina a variável de ambiente antes de salvar credenciais.'
      );
    }

    const anteriores = integracaoAtual?.credenciais_cifradas
      ? decifrar(integracaoAtual.credenciais_cifradas)
      : {};

    const mescladas = { ...anteriores };

    for (const [chave, valor] of Object.entries(body.credenciais)) {
      // String vazia = "remover"; ausência = "manter o que já existe".
      if (valor === '' || valor === null) {
        delete mescladas[chave];
      } else {
        mescladas[chave] = String(valor);
      }
    }

    dados.credenciais_cifradas = Object.keys(mescladas).length ? cifrar(mescladas) : null;

    const resumo = {};

    for (const [chave, valor] of Object.entries(mescladas)) {
      resumo[chave] = mascararSegredo(valor);
    }

    resumo.atualizadoEm = new Date().toISOString();

    dados.credenciais_resumo = JSON.stringify(resumo);
  }

  // Status da integração reflete o adapter + completude da configuração.
  const adapter = obterAdapter(portal.slug);

  if (adapter && adapter.statusImplementacao === 'PENDING_SPECIFICATION') {
    dados.status = 'PENDING_SPECIFICATION';
  } else if (dados.habilitado === false) {
    dados.status = 'INATIVO';
  } else if (dados.habilitado === true) {
    dados.status = 'ATIVO';
  }

  const salva = await portaisRepo.salvarIntegracao(portalId, dados);

  await portaisRepo.registrarLog({
    portalId,
    portalSlug: portal.slug,
    operacao: 'CONFIG',
    status: 'OK',
    mensagem: 'Configuração da integração atualizada.',
    usuarioId: usuario.id,
    detalhes: sanitizarPayload({ campos: Object.keys(dados) })
  });

  return detalhar(portalId).then((detalhe) => ({
    ...detalhe,
    feedUrlGerada: salva.feed_token ? montarUrlFeed(portal.slug, salva.feed_token) : null
  }));
}

async function credenciaisDaIntegracao(integracao) {
  if (!integracao?.credenciais_cifradas) return null;

  try {
    return decifrar(integracao.credenciais_cifradas);
  } catch (error) {
    console.error('[portais] Falha ao decifrar credenciais:', error.message);
    throw new HttpError(
      500,
      'Não foi possível ler as credenciais salvas. Reconfigure a integração (a chave de criptografia pode ter mudado).'
    );
  }
}

async function testar({ portalId, usuario }) {
  const portal = await portaisRepo.buscarPortalPorId(portalId);
  if (!portal) throw notFound('Portal não encontrado.');

  const adapter = obterAdapter(portal.slug);

  if (!adapter) {
    throw new HttpError(501, `Nenhum adapter registrado para o portal "${portal.slug}".`);
  }

  const integracao = await portaisRepo.buscarIntegracao(portalId);

  const totalHabilitados = await pool.query(
    `SELECT COUNT(*)::int AS total FROM imovel_portais WHERE portal_id = $1 AND habilitado`,
    [portalId]
  );

  const inicio = Date.now();

  const resultado = await adapter.testConnection({
    integracao: integracao || {},
    credenciais: await credenciaisDaIntegracao(integracao),
    feedUrl: integracao?.feed_token ? montarUrlFeed(portal.slug, integracao.feed_token) : null,
    totalHabilitados: totalHabilitados.rows[0].total
  });

  await portaisRepo.salvarIntegracao(portalId, {
    ultimo_teste_em: new Date(),
    ultimo_teste_ok: !!resultado.ok,
    ultimo_erro: resultado.ok ? null : String(resultado.mensagem || '').slice(0, 4000)
  });

  await portaisRepo.registrarLog({
    portalId,
    portalSlug: portal.slug,
    operacao: 'TEST',
    status: resultado.ok ? 'OK' : 'ERRO',
    mensagem: resultado.mensagem,
    usuarioId: usuario.id,
    duracaoMs: Date.now() - inicio,
    detalhes: sanitizarPayload(resultado)
  });

  return resultado;
}

// ---------------------------------------------------------------------
// VALIDAÇÃO / PUBLICAÇÃO POR IMÓVEL
// ---------------------------------------------------------------------
async function montarContextoImovel(imovelId, portal, integracao, tipoPublicacao) {
  const imovel = await imoveisRepo.buscarBruto(imovelId);
  if (!imovel) throw notFound('Imóvel não encontrado.');

  const midias = await midiasRepo.listar(imovelId, { somentePublicas: true });
  const caracteristicas = await imoveisRepo.listarCaracteristicas(imovelId);

  return {
    imovel,
    midias,
    caracteristicas,
    integracao: integracao || {},
    portal,
    tipoPublicacao: tipoPublicacao || 'STANDARD'
  };
}

async function validarImovelNoPortal({ imovelId, portalId }) {
  const portal = await portaisRepo.buscarPortalPorId(portalId);
  if (!portal) throw notFound('Portal não encontrado.');

  const adapter = obterAdapter(portal.slug);

  if (!adapter) {
    throw new HttpError(501, `Nenhum adapter registrado para o portal "${portal.slug}".`);
  }

  const integracao = await portaisRepo.buscarIntegracao(portalId);
  const contexto = await montarContextoImovel(imovelId, portal, integracao);

  const resultado = adapter.validateProperty(contexto);

  await portaisRepo.salvarVinculoImovelPortal(imovelId, portalId, {
    erros: JSON.stringify(resultado.erros || []),
    ultima_validacao_em: new Date(),
    status: resultado.ok ? 'AGUARDANDO' : 'INVALIDO'
  });

  await portaisRepo.registrarLog({
    portalId,
    portalSlug: portal.slug,
    imovelId,
    operacao: 'VALIDATE',
    status: resultado.ok ? 'OK' : 'ERRO',
    mensagem: resultado.ok
      ? 'Imóvel válido para o portal.'
      : `${resultado.erros.length} pendência(s) impedem a publicação.`,
    detalhes: sanitizarPayload(resultado)
  });

  return {
    ...resultado,
    portal: { id: portal.id, slug: portal.slug, nome: portal.nome }
  };
}

/**
 * Habilita/desabilita o imóvel em um portal.
 * Habilitar sempre valida antes — nada entra no feed com erro silencioso.
 */
async function alterarPublicacao({ imovelId, portalId, habilitado, tipoPublicacao, usuario }) {
  const portal = await portaisRepo.buscarPortalPorId(portalId);
  if (!portal) throw notFound('Portal não encontrado.');

  const adapter = obterAdapter(portal.slug);

  if (!adapter) {
    throw new HttpError(501, `Nenhum adapter registrado para o portal "${portal.slug}".`);
  }

  const integracao = await portaisRepo.buscarIntegracao(portalId);

  if (habilitado && adapter.statusImplementacao === 'PENDING_SPECIFICATION') {
    throw badRequest(
      `${portal.nome} ainda está aguardando especificação oficial. ` +
      'Não é possível habilitar imóveis neste canal.'
    );
  }

  if (habilitado && !integracao?.habilitado) {
    throw badRequest(
      `A integração com ${portal.nome} não está habilitada. Configure-a em Integrações > Portais.`
    );
  }

  const dados = {
    habilitado: !!habilitado,
    tipo_publicacao: tipoPublicacao || 'STANDARD'
  };

  if (habilitado) {
    const contexto = await montarContextoImovel(imovelId, portal, integracao, tipoPublicacao);
    const validacao = adapter.validateProperty(contexto);

    dados.erros = JSON.stringify(validacao.erros || []);
    dados.ultima_validacao_em = new Date();
    dados.status = validacao.ok ? 'AGUARDANDO' : 'INVALIDO';

    if (!validacao.ok) {
      dados.ultimo_erro = validacao.erros.map((erro) => erro.mensagem).join(' | ').slice(0, 4000);
    } else {
      dados.ultimo_erro = null;
    }
  } else {
    dados.status = 'REMOVIDO';
    dados.erros = JSON.stringify([]);
  }

  const vinculo = await portaisRepo.salvarVinculoImovelPortal(imovelId, portalId, dados);

  await logsImovelRepo.registrar({
    imovelId,
    usuario,
    acao: habilitado ? 'PUBLICACAO_PORTAL' : 'REMOCAO_PORTAL',
    resumo: `${habilitado ? 'Habilitado' : 'Desabilitado'} em ${portal.nome}.`
  });

  await portaisRepo.registrarLog({
    portalId,
    portalSlug: portal.slug,
    imovelId,
    operacao: habilitado ? 'PUBLISH' : 'DEACTIVATE',
    status: vinculo.status === 'INVALIDO' ? 'AVISO' : 'OK',
    mensagem: habilitado
      ? `Imóvel habilitado para ${portal.nome} (status: ${vinculo.status}).`
      : `Imóvel removido de ${portal.nome}.`,
    usuarioId: usuario.id,
    detalhes: sanitizarPayload({ status: vinculo.status, erros: vinculo.erros })
  });

  return vinculo;
}

async function listarPortaisDoImovel(imovelId) {
  const rows = await portaisRepo.listarPortaisDoImovel(imovelId);

  return rows.map((row) => {
    const adapter = obterAdapter(row.slug);

    return {
      portalId: row.portal_id,
      slug: row.slug,
      nome: row.nome,
      modoIntegracao: row.modo_integracao,
      statusImplementacao: row.status_implementacao,
      documentacaoUrl: row.documentacao_url,
      integracaoHabilitada: !!row.integracao_habilitada,
      integracaoStatus: row.integracao_status || 'PENDING_CONFIGURATION',
      capacidades: adapter ? adapter.capacidades() : null,
      pendencias: adapter ? adapter.pendencias : [],

      habilitado: !!row.habilitado,
      status: row.status,
      tipoPublicacao: row.tipo_publicacao,
      externalId: row.external_id,
      externalUrl: row.external_url,
      erros: row.erros || [],
      ultimaValidacaoEm: row.ultima_validacao_em,
      ultimaSincronizacao: row.ultima_sincronizacao,
      ultimoErro: row.ultimo_erro
    };
  });
}

// ---------------------------------------------------------------------
// FEED PÚBLICO
// ---------------------------------------------------------------------
async function gerarFeed({ portalSlug, token }) {
  const integracao = await portaisRepo.buscarIntegracaoPorToken(token);

  if (!integracao || integracao.portal_slug !== portalSlug) {
    throw notFound('Feed não encontrado.');
  }

  if (!integracao.feed_habilitado || !integracao.habilitado) {
    throw new HttpError(403, 'Feed desabilitado.');
  }

  const adapter = obterAdapter(portalSlug);

  if (!adapter || !adapter.capacidades().feed) {
    throw new HttpError(
      501,
      `O portal "${portalSlug}" não possui geração de feed implementada. Status: ${adapter?.statusImplementacao || 'desconhecido'}.`
    );
  }

  const seguranca = require('./feed-safety.service');
  const aprovado = await seguranca.obterAprovado(integracao);
  if (aprovado) return aprovado;

  // Compatibilidade com feeds anteriores: mesmo endpoint e token. Nunca
  // devolver uma carteira parcial/vazia nem alterar status pelo simples GET.
  const previa = await seguranca.previa(integracao.portal_id);
  if (!previa.xml || previa.rejeitados.length || previa.duplicados.length) {
    throw new HttpError(503, 'Feed bloqueado para evitar retirada acidental de anúncios. Revise a prévia e aprove uma versão completa.',
      { rejeitados: previa.rejeitados, duplicados: previa.duplicados });
  }
  return { ok: true, conteudo: previa.xml, contentType: 'application/xml; charset=utf-8', totalAnuncios: previa.totalAnuncios };
}

async function listarLogs(portalId, opcoes) {
  return portaisRepo.listarLogs(portalId, opcoes);
}

function catalogoAdapters() {
  return resumoAdapters();
}

module.exports = {
  montarUrlFeed,
  listar,
  detalhar,
  salvarConfiguracao,
  testar,
  validarImovelNoPortal,
  alterarPublicacao,
  listarPortaisDoImovel,
  gerarFeed,
  listarLogs,
  catalogoAdapters
};
