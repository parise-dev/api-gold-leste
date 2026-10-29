const pool = require('../config/db');

async function listar(imovelId, { somentePublicas = false } = {}, client = pool) {
  const where = ['imovel_id = $1'];
  if (somentePublicas) where.push('publica = TRUE');

  const result = await client.query(
    `
    SELECT *
    FROM imovel_midias
    WHERE ${where.join(' AND ')}
    ORDER BY capa DESC, ordem ASC, created_at ASC
    `,
    [imovelId]
  );

  return result.rows;
}

async function buscarPorId(imovelId, mediaId, client = pool) {
  const result = await client.query(
    `SELECT * FROM imovel_midias WHERE id = $1 AND imovel_id = $2 LIMIT 1`,
    [mediaId, imovelId]
  );

  return result.rows[0] || null;
}

async function proximaOrdem(imovelId, client = pool) {
  const result = await client.query(
    `SELECT COALESCE(MAX(ordem), -1) + 1 AS proxima FROM imovel_midias WHERE imovel_id = $1`,
    [imovelId]
  );

  return Number(result.rows[0].proxima || 0);
}

async function contarImagens(imovelId, client = pool) {
  const result = await client.query(
    `SELECT COUNT(*)::int AS total FROM imovel_midias WHERE imovel_id = $1 AND tipo = 'IMAGEM'`,
    [imovelId]
  );

  return result.rows[0].total;
}

async function existeCapa(imovelId, client = pool) {
  const result = await client.query(
    `SELECT 1 FROM imovel_midias WHERE imovel_id = $1 AND capa LIMIT 1`,
    [imovelId]
  );

  return result.rows.length > 0;
}

async function inserir(dados, client = pool) {
  const colunas = Object.keys(dados);
  const valores = colunas.map((coluna) => dados[coluna]);
  const placeholders = colunas.map((_, indice) => `$${indice + 1}`);

  const result = await client.query(
    `
    INSERT INTO imovel_midias (${colunas.join(', ')}, created_at, updated_at)
    VALUES (${placeholders.join(', ')}, NOW(), NOW())
    RETURNING *
    `,
    valores
  );

  return result.rows[0];
}

async function atualizar(mediaId, dados, client = pool) {
  const colunas = Object.keys(dados);
  if (!colunas.length) return null;

  const atribuicoes = colunas.map((coluna, indice) => `${coluna} = $${indice + 1}`);
  const valores = colunas.map((coluna) => dados[coluna]);
  valores.push(mediaId);

  const result = await client.query(
    `
    UPDATE imovel_midias
    SET ${atribuicoes.join(', ')}, updated_at = NOW()
    WHERE id = $${valores.length}
    RETURNING *
    `,
    valores
  );

  return result.rows[0] || null;
}

/** Índice parcial único garante uma capa por imóvel: limpa antes de marcar. */
async function definirCapa(imovelId, mediaId, client) {
  await client.query(
    `UPDATE imovel_midias SET capa = FALSE, updated_at = NOW() WHERE imovel_id = $1 AND capa`,
    [imovelId]
  );

  const result = await client.query(
    `
    UPDATE imovel_midias
    SET capa = TRUE, updated_at = NOW()
    WHERE id = $1 AND imovel_id = $2
    RETURNING *
    `,
    [mediaId, imovelId]
  );

  return result.rows[0] || null;
}

async function promoverPrimeiraComoCapa(imovelId, client) {
  const jaTem = await existeCapa(imovelId, client);
  if (jaTem) return null;

  const candidata = await client.query(
    `
    SELECT id FROM imovel_midias
    WHERE imovel_id = $1 AND tipo = 'IMAGEM'
    ORDER BY ordem ASC, created_at ASC
    LIMIT 1
    `,
    [imovelId]
  );

  if (!candidata.rows.length) return null;

  return definirCapa(imovelId, candidata.rows[0].id, client);
}

async function reordenar(imovelId, ordemIds = [], client) {
  for (let indice = 0; indice < ordemIds.length; indice += 1) {
    await client.query(
      `UPDATE imovel_midias SET ordem = $1, updated_at = NOW() WHERE id = $2 AND imovel_id = $3`,
      [indice, ordemIds[indice], imovelId]
    );
  }

  return listar(imovelId, {}, client);
}

async function remover(imovelId, mediaId, client = pool) {
  const result = await client.query(
    `DELETE FROM imovel_midias WHERE id = $1 AND imovel_id = $2 RETURNING *`,
    [mediaId, imovelId]
  );

  return result.rows[0] || null;
}

module.exports = {
  listar,
  buscarPorId,
  proximaOrdem,
  contarImagens,
  existeCapa,
  inserir,
  atualizar,
  definirCapa,
  promoverPrimeiraComoCapa,
  reordenar,
  remover
};
