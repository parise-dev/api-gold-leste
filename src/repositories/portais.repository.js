const pool = require('../config/db');

async function listarPortais() {
  const result = await pool.query(
    `
    SELECT p.*,
      pi.id                   AS integracao_id,
      pi.habilitado           AS integracao_habilitada,
      pi.status               AS integracao_status,
      pi.feed_habilitado,
      pi.feed_token,
      pi.contato_nome, pi.contato_email, pi.contato_telefone, pi.contato_site,
      pi.contato_logo_url, pi.contato_cidade, pi.contato_uf, pi.contato_bairro,
      pi.contato_endereco, pi.contato_cep,
      pi.credenciais_resumo, pi.config,
      pi.ultima_sincronizacao, pi.ultimo_erro, pi.ultimo_teste_em, pi.ultimo_teste_ok,
      (
        SELECT COUNT(*) FROM imovel_portais ip
        WHERE ip.portal_id = p.id AND ip.habilitado
      )::int AS total_selecionados,
      (
        SELECT COUNT(*) FROM imovel_portais ip
        WHERE ip.portal_id = p.id AND ip.status = 'PUBLICADO'
      )::int AS total_publicados,
      (
        SELECT COUNT(*) FROM imovel_portais ip
        WHERE ip.portal_id = p.id AND ip.status IN ('ERRO', 'INVALIDO')
      )::int AS total_com_erro,
      (
        SELECT COUNT(*) FROM portal_leads pl WHERE pl.portal_id = p.id
      )::int AS total_leads
    FROM portais p
    LEFT JOIN portal_integracoes pi ON pi.portal_id = p.id AND pi.filial_id IS NULL
    ORDER BY p.ordem ASC, p.nome ASC
    `
  );

  return result.rows;
}

async function buscarPortalPorId(id) {
  const result = await pool.query('SELECT * FROM portais WHERE id = $1 LIMIT 1', [id]);
  return result.rows[0] || null;
}

async function buscarPortalPorSlug(slug) {
  const result = await pool.query('SELECT * FROM portais WHERE slug = $1 LIMIT 1', [slug]);
  return result.rows[0] || null;
}

async function buscarIntegracao(portalId, client = pool) {
  const result = await client.query(
    `SELECT * FROM portal_integracoes WHERE portal_id = $1 AND filial_id IS NULL LIMIT 1`,
    [portalId]
  );

  return result.rows[0] || null;
}

async function buscarIntegracaoPorToken(token) {
  const result = await pool.query(
    `
    SELECT pi.*, p.slug AS portal_slug, p.nome AS portal_nome, p.status_implementacao
    FROM portal_integracoes pi
    INNER JOIN portais p ON p.id = pi.portal_id
    WHERE pi.feed_token = $1
    LIMIT 1
    `,
    [token]
  );

  return result.rows[0] || null;
}

async function salvarIntegracao(portalId, dados, client = pool) {
  const existente = await buscarIntegracao(portalId, client);

  if (!existente) {
    const colunas = ['portal_id', ...Object.keys(dados)];
    const valores = [portalId, ...Object.keys(dados).map((chave) => dados[chave])];
    const placeholders = colunas.map((_, indice) => `$${indice + 1}`);

    const result = await client.query(
      `
      INSERT INTO portal_integracoes (${colunas.join(', ')}, created_at, updated_at)
      VALUES (${placeholders.join(', ')}, NOW(), NOW())
      RETURNING *
      `,
      valores
    );

    return result.rows[0];
  }

  const colunas = Object.keys(dados);

  if (!colunas.length) return existente;

  const atribuicoes = colunas.map((coluna, indice) => `${coluna} = $${indice + 1}`);
  const valores = colunas.map((coluna) => dados[coluna]);
  valores.push(existente.id);

  const result = await client.query(
    `
    UPDATE portal_integracoes
    SET ${atribuicoes.join(', ')}, updated_at = NOW()
    WHERE id = $${valores.length}
    RETURNING *
    `,
    valores
  );

  return result.rows[0];
}

// ---------------------------------------------------------------------
// PUBLICAÇÃO POR IMÓVEL
// ---------------------------------------------------------------------
async function listarPortaisDoImovel(imovelId) {
  const result = await pool.query(
    `
    SELECT p.id   AS portal_id,
           p.slug, p.nome, p.modo_integracao, p.status_implementacao, p.documentacao_url,
           pi.habilitado AS integracao_habilitada,
           pi.status     AS integracao_status,
           ip.id         AS vinculo_id,
           COALESCE(ip.habilitado, FALSE)          AS habilitado,
           COALESCE(ip.status, 'NAO_PUBLICADO')    AS status,
           COALESCE(ip.tipo_publicacao, 'STANDARD') AS tipo_publicacao,
           ip.external_id, ip.external_url,
           COALESCE(ip.erros, '[]'::jsonb)         AS erros,
           ip.ultima_validacao_em, ip.ultima_sincronizacao, ip.ultimo_erro
    FROM portais p
    LEFT JOIN portal_integracoes pi ON pi.portal_id = p.id AND pi.filial_id IS NULL
    LEFT JOIN imovel_portais ip     ON ip.portal_id = p.id AND ip.imovel_id = $1
    WHERE p.ativo
    ORDER BY p.ordem ASC, p.nome ASC
    `,
    [imovelId]
  );

  return result.rows;
}

async function salvarVinculoImovelPortal(imovelId, portalId, dados, client = pool) {
  const colunas = Object.keys(dados);
  const valoresInsert = colunas.map((coluna) => dados[coluna]);

  const atualizacoes = colunas.map((coluna) => `${coluna} = EXCLUDED.${coluna}`);

  const result = await client.query(
    `
    INSERT INTO imovel_portais (imovel_id, portal_id, ${colunas.join(', ')}, created_at, updated_at)
    VALUES ($1, $2, ${colunas.map((_, indice) => `$${indice + 3}`).join(', ')}, NOW(), NOW())
    ON CONFLICT (imovel_id, portal_id) DO UPDATE
    SET ${atualizacoes.join(', ')}, updated_at = NOW()
    RETURNING *
    `,
    [imovelId, portalId, ...valoresInsert]
  );

  return result.rows[0];
}

/**
 * Imóveis elegíveis ao feed de um portal.
 * Filtra na origem tudo que o portal não deve receber: inativos,
 * vendidos, alugados, suspensos e não habilitados para o canal.
 */
async function listarImoveisDoFeed(portalId, limite = 5000) {
  const result = await pool.query(
    `
    SELECT i.*, ip.tipo_publicacao, ip.id AS vinculo_id
    FROM imoveis i
    INNER JOIN imovel_portais ip ON ip.imovel_id = i.id AND ip.portal_id = $1
    WHERE i.deleted_at IS NULL
      AND i.ativo = TRUE
      AND ip.habilitado = TRUE
      AND i.status NOT IN ('VENDIDO', 'ALUGADO', 'SUSPENSO', 'INATIVO')
    ORDER BY i.updated_at DESC
    LIMIT $2
    `,
    [portalId, limite]
  );

  return result.rows;
}

async function midiasDosImoveis(imovelIds = []) {
  if (!imovelIds.length) return new Map();

  const result = await pool.query(
    `
    SELECT *
    FROM imovel_midias
    WHERE imovel_id = ANY($1::uuid[]) AND publica = TRUE
    ORDER BY capa DESC, ordem ASC, created_at ASC
    `,
    [imovelIds]
  );

  const mapa = new Map();

  for (const midia of result.rows) {
    if (!mapa.has(midia.imovel_id)) mapa.set(midia.imovel_id, []);
    mapa.get(midia.imovel_id).push(midia);
  }

  return mapa;
}

async function caracteristicasDosImoveis(imovelIds = []) {
  if (!imovelIds.length) return new Map();

  const result = await pool.query(
    `SELECT imovel_id, slug, label, grupo, valor FROM imovel_caracteristicas WHERE imovel_id = ANY($1::uuid[])`,
    [imovelIds]
  );

  const mapa = new Map();

  for (const item of result.rows) {
    if (!mapa.has(item.imovel_id)) mapa.set(item.imovel_id, []);
    mapa.get(item.imovel_id).push(item);
  }

  return mapa;
}

// ---------------------------------------------------------------------
// LOGS
// ---------------------------------------------------------------------
async function registrarLog(dados, client = pool) {
  const result = await client.query(
    `
    INSERT INTO portal_sync_logs (
      portal_id, portal_slug, imovel_id, operacao, status, mensagem,
      external_id, request_id, detalhes, duracao_ms, usuario_id
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    RETURNING id, executado_em
    `,
    [
      dados.portalId || null,
      dados.portalSlug || null,
      dados.imovelId || null,
      dados.operacao,
      dados.status,
      dados.mensagem ? String(dados.mensagem).slice(0, 4000) : null,
      dados.externalId || null,
      dados.requestId || null,
      dados.detalhes ? JSON.stringify(dados.detalhes) : null,
      dados.duracaoMs || null,
      dados.usuarioId || null
    ]
  );

  return result.rows[0];
}

async function listarLogs(portalId, { limite = 100, imovelId = null } = {}) {
  const params = [portalId];
  const where = ['l.portal_id = $1'];

  if (imovelId) {
    params.push(imovelId);
    where.push(`l.imovel_id = $${params.length}`);
  }

  params.push(Math.min(Number(limite) || 100, 500));

  const result = await pool.query(
    `
    SELECT l.*, i.codigo AS imovel_codigo, i.titulo AS imovel_titulo, u.nome AS usuario_nome
    FROM portal_sync_logs l
    LEFT JOIN imoveis  i ON i.id = l.imovel_id
    LEFT JOIN usuarios u ON u.id = l.usuario_id
    WHERE ${where.join(' AND ')}
    ORDER BY l.executado_em DESC
    LIMIT $${params.length}
    `,
    params
  );

  return result.rows;
}

module.exports = {
  listarPortais,
  buscarPortalPorId,
  buscarPortalPorSlug,
  buscarIntegracao,
  buscarIntegracaoPorToken,
  salvarIntegracao,
  listarPortaisDoImovel,
  salvarVinculoImovelPortal,
  listarImoveisDoFeed,
  midiasDosImoveis,
  caracteristicasDosImoveis,
  registrarLog,
  listarLogs
};
