const pool = require('../config/db');

async function inserir(dados, client = pool) {
  dados = await require('../services/operacao/entrada').preparar(dados, client);
  const colunas = Object.keys(dados);
  const valores = colunas.map((coluna) => dados[coluna]);
  const placeholders = colunas.map((_, indice) => `$${indice + 1}`);

  const result = await client.query(
    `
    INSERT INTO portal_leads (${colunas.join(', ')})
    VALUES (${placeholders.join(', ')})
    RETURNING *
    `,
    valores
  );

  return result.rows[0];
}

/**
 * Idempotência: o mesmo external_lead_id do mesmo portal não pode virar
 * vários leads em caso de retry de webhook.
 */
async function inserirIdempotente(dados, client = pool) {
  if (!dados.external_lead_id || !dados.portal_slug) {
    return { lead: await inserir(dados, client), duplicado: false };
  }
  dados = await require('../services/operacao/entrada').preparar(dados, client);

  const colunas = Object.keys(dados);
  const r = await client.query(`INSERT INTO portal_leads (${colunas.join(', ')})
    VALUES (${colunas.map((_, i) => '$' + (i + 1)).join(', ')})
    ON CONFLICT (portal_slug, external_lead_id) WHERE external_lead_id IS NOT NULL
    DO NOTHING RETURNING *`, colunas.map(c => dados[c]));
  if (r.rows.length) return { lead: r.rows[0], duplicado: false };
  const existente = await client.query('SELECT * FROM portal_leads WHERE portal_slug=$1 AND external_lead_id=$2',
    [dados.portal_slug, dados.external_lead_id]);
  return { lead: existente.rows[0], duplicado: true };
}

async function listar({ filtros = {}, page, pageSize, offset, usuario }) {
  const params = [];
  const where = [`COALESCE(pl.tipo_lead, 'INTERESSE_IMOVEL') <> 'CAPTACAO_IMOVEL'`];

  if (usuario && usuario.perfil === 'corretor') {
    params.push(usuario.id);
    where.push(`(
      pl.responsavel_id = $${params.length}
      OR EXISTS (
        SELECT 1 FROM imoveis i
        WHERE i.id = pl.imovel_id
          AND (i.corretor_id = $${params.length} OR i.captador_id = $${params.length})
      )
    )`);
  }

  if (usuario && usuario.perfil === 'gerente') {
    params.push(usuario.id);
    where.push(`(
      pl.responsavel_id = $${params.length}
      OR EXISTS (
        SELECT 1 FROM usuarios u
        WHERE u.id = pl.responsavel_id AND u.gerente_id = $${params.length}
      )
      OR EXISTS (
        SELECT 1 FROM imoveis i
        WHERE i.id = pl.imovel_id
          AND (i.gerente_id = $${params.length} OR i.created_by = $${params.length})
      )
      OR pl.responsavel_id IS NULL
    )`);
  }

  if (filtros.imovelId) {
    params.push(filtros.imovelId);
    where.push(`pl.imovel_id = $${params.length}`);
  }

  if (filtros.portalSlug) {
    params.push(filtros.portalSlug);
    where.push(`pl.portal_slug = $${params.length}`);
  }

  if (filtros.origem) {
    params.push(filtros.origem);
    where.push(`pl.origem = $${params.length}`);
  }

  if (filtros.status) {
    params.push(filtros.status);
    where.push(`pl.status_processamento = $${params.length}`);
  }

  if (filtros.busca) {
    params.push(`%${filtros.busca}%`);
    const idx = params.length;
    where.push(`(pl.nome ILIKE $${idx} OR pl.email ILIKE $${idx} OR pl.telefone ILIKE $${idx})`);
  }

  const whereSql = where.join('\n  AND ');

  const total = await pool.query(
    `SELECT COUNT(*)::int AS total FROM portal_leads pl WHERE ${whereSql}`,
    params
  );

  const paramsPagina = [...params, pageSize, offset];

  const result = await pool.query(
    `
    SELECT pl.*,
           i.codigo AS imovel_codigo_atual,
           i.titulo AS imovel_titulo,
           i.slug   AS imovel_slug,
           u.nome   AS responsavel_nome,
           p.nome   AS portal_nome
    FROM portal_leads pl
    LEFT JOIN imoveis  i ON i.id = pl.imovel_id
    LEFT JOIN usuarios u ON u.id = pl.responsavel_id
    LEFT JOIN portais  p ON p.id = pl.portal_id
    WHERE ${whereSql}
    ORDER BY pl.recebido_em DESC
    LIMIT $${paramsPagina.length - 1} OFFSET $${paramsPagina.length}
    `,
    paramsPagina
  );

  return { rows: result.rows, total: total.rows[0].total, page, pageSize };
}

async function listarPorImovel(imovelId, limite = 20) {
  const result = await pool.query(
    `
    SELECT pl.id, pl.nome, pl.email, pl.telefone, pl.mensagem, pl.origem,
           pl.portal_slug, pl.status_processamento, pl.recebido_em,
           pl.atribuido_em, pl.primeiro_atendimento_em,
           u.nome AS responsavel_nome
    FROM portal_leads pl
    LEFT JOIN usuarios u ON u.id = pl.responsavel_id
    WHERE pl.imovel_id = $1
    ORDER BY pl.recebido_em DESC
    LIMIT $2
    `,
    [imovelId, Math.min(Number(limite) || 20, 100)]
  );

  return result.rows;
}

async function atualizar(id, dados) {
  const colunas = Object.keys(dados);
  if (!colunas.length) return null;

  const atribuicoes = colunas.map((coluna, indice) => `${coluna} = $${indice + 1}`);
  const valores = colunas.map((coluna) => dados[coluna]);
  valores.push(id);

  const result = await pool.query(
    `
    UPDATE portal_leads
    SET ${atribuicoes.join(', ')}, updated_at = NOW()
    WHERE id = $${valores.length}
    RETURNING *
    `,
    valores
  );

  return result.rows[0] || null;
}

async function resumoPorPortal() {
  const result = await pool.query(
    `
    SELECT COALESCE(pl.portal_slug, pl.origem) AS canal,
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE pl.recebido_em >= NOW() - INTERVAL '30 days')::int AS ultimos_30_dias,
           COUNT(*) FILTER (WHERE pl.responsavel_id IS NULL)::int AS sem_responsavel
    FROM portal_leads pl
    WHERE COALESCE(pl.tipo_lead, 'INTERESSE_IMOVEL') <> 'CAPTACAO_IMOVEL'
    GROUP BY 1
    ORDER BY total DESC
    `
  );

  return result.rows;
}

module.exports = {
  inserir,
  inserirIdempotente,
  listar,
  listarPorImovel,
  atualizar,
  resumoPorPortal
};
