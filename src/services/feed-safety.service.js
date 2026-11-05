const crypto = require('crypto');
const pool = require('../config/db');
const { obterAdapter } = require('../integrations/portals/registry');
const { HttpError, conflict, notFound, badRequest } = require('../utils/http-error');

function compararIds(atuais, anteriores) {
  const conjunto = new Set(atuais);
  const vistos = new Set();
  const duplicados = [];
  for (const id of atuais) { if (vistos.has(id)) duplicados.push(id); vistos.add(id); }
  return { removidos: anteriores.filter(id => !conjunto.has(id)), duplicados };
}

function fingerprint(xml) {
  return crypto.createHash('sha256').update(xml.replace(/<PublishDate>[^<]*<\/PublishDate>/g, '<PublishDate/>')).digest('hex');
}

async function construir(portalId, client = pool) {
  const { rows } = await client.query(`SELECT pi.*, p.slug AS portal_slug FROM portal_integracoes pi
    JOIN portais p ON p.id=pi.portal_id WHERE pi.portal_id=$1 AND pi.filial_id IS NULL`, [portalId]);
  const integracao = rows[0];
  if (!integracao) throw notFound('Configure a integração antes de preparar o feed.');
  const adapter = obterAdapter(integracao.portal_slug);
  if (!adapter?.capacidades().feed) throw badRequest('Portal sem geração de feed.');
  // Sem LIMIT: truncar a carteira retiraria anúncios do portal.
  const imoveis = await client.query(`SELECT i.*, ip.tipo_publicacao,
      COALESCE(to_jsonb(ip)->>'listing_id_exportacao', i.codigo) AS listing_id_exportacao
    FROM imoveis i JOIN imovel_portais ip ON ip.imovel_id=i.id AND ip.portal_id=$1
    WHERE ip.habilitado AND i.deleted_at IS NULL AND i.ativo
      AND i.status NOT IN ('VENDIDO','ALUGADO','SUSPENSO','INATIVO') ORDER BY i.id`, [portalId]);
  const ids = imoveis.rows.map(i => i.id);
  const midias = await client.query('SELECT * FROM imovel_midias WHERE imovel_id=ANY($1::uuid[]) AND publica ORDER BY capa DESC, ordem, id', [ids]);
  const caracteristicas = await client.query('SELECT * FROM imovel_caracteristicas WHERE imovel_id=ANY($1::uuid[]) ORDER BY imovel_id, slug', [ids]);
  const agrupar = rows => {
    const mapa = new Map();
    for (const row of rows) { if (!mapa.has(row.imovel_id)) mapa.set(row.imovel_id, []); mapa.get(row.imovel_id).push(row); }
    return mapa;
  };
  const fotos = agrupar(midias.rows), detalhes = agrupar(caracteristicas.rows);
  const itens = [], rejeitados = [];
  for (const original of imoveis.rows) {
    const imovel = { ...original, codigo: original.listing_id_exportacao };
    const contexto = { imovel, integracao, tipoPublicacao: original.tipo_publicacao,
      midias: fotos.get(imovel.id) || [], caracteristicas: detalhes.get(imovel.id) || [] };
    const validacao = adapter.validateProperty(contexto);
    if (!validacao.ok) rejeitados.push({ codigo: imovel.codigo, erros: validacao.erros });
    itens.push(contexto);
  }
  const listingIds = itens.map(i => i.imovel.codigo);
  const comparacao = compararIds(listingIds, []);
  let resultado = null;
  if (!rejeitados.length && itens.length && !comparacao.duplicados.length) resultado = await adapter.generateFeed({ integracao, itens });
  return { integracao, resultado, rejeitados, listingIds, duplicados: comparacao.duplicados,
    hash: resultado ? fingerprint(resultado.conteudo) : null };
}

async function previa(portalId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const atual = await construir(portalId, client);
    const anterior = atual.integracao.feed_versao_id ? (await client.query('SELECT listing_ids FROM portal_feed_versoes WHERE id=$1', [atual.integracao.feed_versao_id])).rows[0] : null;
    const comparacao = compararIds(atual.listingIds, anterior?.listing_ids || []);
    await client.query('COMMIT');
    return { totalAnuncios: atual.listingIds.length, listingIds: atual.listingIds, hash: atual.hash,
      rejeitados: atual.rejeitados, duplicados: atual.duplicados, removidos: comparacao.removidos,
      possuiVersaoAprovada: !!anterior, podeAprovar: !!atual.resultado?.ok && !comparacao.removidos.length,
      xml: atual.resultado?.conteudo || null };
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

async function aprovar(portalId, body, usuario) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await client.query('SELECT id FROM portal_integracoes WHERE portal_id=$1 AND filial_id IS NULL FOR UPDATE', [portalId]);
    const atual = await construir(portalId, client);
    if (!atual.integracao.habilitado || !atual.integracao.feed_habilitado || !atual.integracao.feed_token) {
      throw conflict('Habilite a integração e o feed antes de aprovar uma versão.');
    }
    if (!atual.resultado?.ok || !atual.listingIds.length || atual.duplicados.length) throw conflict('Feed vazio, inválido ou com códigos duplicados. Nenhuma versão foi substituída.');
    if (!body.hash || body.hash !== atual.hash) throw conflict('A carteira mudou. Gere e revise uma nova prévia.');
    let baseline;
    if (atual.integracao.feed_versao_id) {
      baseline = (await client.query('SELECT listing_ids FROM portal_feed_versoes WHERE id=$1', [atual.integracao.feed_versao_id])).rows[0].listing_ids;
    } else {
      if (body.inventarioConferido !== true || !Array.isArray(body.idsAtuais) || !body.idsAtuais.length ||
          body.idsAtuais.some(id => typeof id !== 'string' || !id.trim())) {
        throw conflict('Informe todos os códigos atuais do portal e confirme a conferência do inventário antes da primeira aprovação.');
      }
      baseline = body.idsAtuais;
    }
    const { removidos } = compararIds(atual.listingIds, baseline);
    if (removidos.length) throw conflict('Aprovação bloqueada: anúncios atuais ficariam ausentes.', { removidos });
    const versao = (await client.query(`INSERT INTO portal_feed_versoes(portal_id,conteudo,content_type,listing_ids,hash,aprovado_por)
      VALUES($1,$2,$3,$4,$5,$6) RETURNING id`, [portalId, atual.resultado.conteudo, atual.resultado.contentType,
      JSON.stringify(atual.listingIds), atual.hash, usuario.id])).rows[0];
    await client.query('UPDATE portal_integracoes SET feed_versao_id=$2, updated_at=now() WHERE portal_id=$1 AND filial_id IS NULL', [portalId, versao.id]);
    await client.query(`INSERT INTO portal_sync_logs(portal_id,portal_slug,operacao,status,mensagem,usuario_id)
      VALUES($1,$2,'FEED_APPROVE','OK',$3,$4)`, [portalId, atual.integracao.portal_slug,
      `XML aprovado com ${atual.listingIds.length} anúncios. A publicação depende do processamento do portal.`, usuario.id]);
    await client.query('COMMIT');
    return { id: versao.id, totalAnuncios: atual.listingIds.length, hash: atual.hash };
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

async function obterAprovado(integracao) {
  if (!integracao.feed_versao_id) return null;
  const row = (await pool.query('SELECT * FROM portal_feed_versoes WHERE id=$1 AND portal_id=$2', [integracao.feed_versao_id, integracao.portal_id])).rows[0];
  if (!row) throw new HttpError(503, 'Versão aprovada indisponível. Feed preservado; não será enviado XML vazio.');
  return { ok: true, conteudo: row.conteudo, contentType: row.content_type, totalAnuncios: row.listing_ids.length };
}

module.exports = { compararIds, fingerprint, construir, previa, aprovar, obterAprovado };
