const pool = require('../config/db');
const { STATUS_INDISPONIVEIS } = require('../validators/imovel.constants');

/**
 * Acesso a dados da carteira de imóveis.
 *
 * TODA regra de escopo/visibilidade é aplicada aqui, em SQL. O front
 * apenas esconde botões; quem barra o acesso é o banco + estas cláusulas.
 */

const COLUNAS_IMOVEL = `
  i.id, i.codigo, i.referencia_externa, i.slug, i.titulo, i.descricao,
  i.descricao_resumida, i.finalidade, i.tipo, i.subtipo, i.situacao, i.status,
  i.origem_carteira, i.ativo, i.destaque, i.oportunidade, i.exclusivo,
  i.lancamento, i.publicar_site, i.prioridade_manual,
  i.valor_venda, i.valor_locacao, i.valor_condominio, i.valor_iptu,
  i.iptu_periodo, i.outras_taxas, i.valor_minimo, i.aceita_financiamento,
  i.aceita_fgts, i.aceita_permuta, i.comissao_percentual, i.comissao_valor,
  i.observacoes_internas,
  i.dormitorios, i.suites, i.banheiros, i.vagas, i.area_util, i.area_total,
  i.area_construida, i.area_terreno, i.andar, i.total_andares,
  i.ano_construcao, i.mobiliado, i.elevador, i.pet_friendly,
  i.cep, i.logradouro, i.numero, i.complemento, i.bairro, i.cidade, i.uf,
  i.latitude, i.longitude, i.exibir_endereco_completo,
  i.filial_id, i.corretor_id, i.captador_id, i.gerente_id, i.venda_id,
  i.empreendimento_legado_id, i.empreendimento_nome, i.unidade_legado_id,
  i.unidade_identificacao, i.proprietario_legado_id, i.proprietario_nome,
  i.proprietario_telefone, i.proprietario_email, i.dados_kenlo,
  i.visibilidade, i.qualidade_score, i.oportunidade_score,
  i.total_visualizacoes, i.total_leads,
  i.created_by, i.updated_by, i.created_at, i.updated_at, i.deleted_at
`;

const JOINS_PADRAO = `
  LEFT JOIN filiais  f  ON f.id  = i.filial_id
  LEFT JOIN usuarios uc ON uc.id = i.corretor_id
  LEFT JOIN usuarios ug ON ug.id = i.gerente_id
  LEFT JOIN usuarios ucap ON ucap.id = i.captador_id
`;

const COLUNAS_RELACIONADAS = `
  f.nome    AS filial_nome,
  uc.nome   AS corretor_nome,
  ug.nome   AS gerente_nome,
  ucap.nome AS captador_nome,
  (
    SELECT m.url_web
    FROM imovel_midias m
    WHERE m.imovel_id = i.id AND m.capa AND m.tipo = 'IMAGEM'
    LIMIT 1
  ) AS capa_url_web,
  (
    SELECT COALESCE(m.url_thumb, m.url_web, m.url)
    FROM imovel_midias m
    WHERE m.imovel_id = i.id AND m.capa AND m.tipo = 'IMAGEM'
    LIMIT 1
  ) AS capa_url_thumb,
  (
    SELECT COALESCE(m.url_web, m.url)
    FROM imovel_midias m
    WHERE m.imovel_id = i.id AND m.tipo = 'IMAGEM'
    ORDER BY m.capa DESC, m.ordem ASC, m.created_at ASC
    LIMIT 1
  ) AS primeira_foto_url,
  (
    SELECT COUNT(*) FROM imovel_midias m
    WHERE m.imovel_id = i.id AND m.tipo = 'IMAGEM'
  )::int AS total_fotos,
  (
    SELECT COUNT(*) FROM imovel_portais ip
    WHERE ip.imovel_id = i.id AND ip.habilitado
  )::int AS total_portais_habilitados,
  (
    SELECT COUNT(*) FROM imovel_portais ip
    WHERE ip.imovel_id = i.id AND ip.status = 'PUBLICADO'
  )::int AS total_portais_publicados,
  (
    SELECT COUNT(*) FROM imovel_portais ip
    WHERE ip.imovel_id = i.id AND ip.status IN ('ERRO', 'INVALIDO')
  )::int AS total_portais_erro
`;

/**
 * Cláusula de escopo por perfil.
 *
 *  admin    -> tudo
 *  gerente  -> imóveis da própria filial, dos seus corretores, criados por
 *              ele ou onde é o gerente responsável
 *  corretor -> respeita `visibilidade` do imóvel
 *
 * @returns {string|null} SQL ou null quando não há restrição.
 */
function clausulaEscopo(usuario, params, alias = 'i') {
  if (!usuario) return `${alias}.id IS NULL`;          // sem usuário, sem dados
  if (usuario.perfil === 'admin') return null;

  const p = `${alias}.`;

  if (usuario.perfil === 'gerente') {
    params.push(usuario.id);
    const idUsuario = params.length;

    return `(
      ${p}gerente_id = $${idUsuario}
      OR ${p}created_by = $${idUsuario}
      OR ${p}corretor_id = $${idUsuario}
      OR ${p}captador_id = $${idUsuario}
      OR EXISTS (
        SELECT 1 FROM usuarios ue
        WHERE ue.id IN (${p}corretor_id, ${p}captador_id)
          AND ue.gerente_id = $${idUsuario}
      )
      OR (
        ${p}filial_id IS NOT NULL
        AND ${p}filial_id = (SELECT ug2.filial_id FROM usuarios ug2 WHERE ug2.id = $${idUsuario})
      )
    )`;
  }

  // corretor
  params.push(usuario.id);
  const idUsuario = params.length;

  return `(
    ${p}corretor_id = $${idUsuario}
    OR ${p}captador_id = $${idUsuario}
    OR ${p}visibilidade = 'TODOS'
    OR (
      ${p}visibilidade = 'FILIAL'
      AND (
        (
          ${p}filial_id IS NOT NULL
          AND ${p}filial_id = (SELECT uf2.filial_id FROM usuarios uf2 WHERE uf2.id = $${idUsuario})
        )
        OR EXISTS (
          SELECT 1 FROM imovel_visibilidades iv
          WHERE iv.imovel_id = ${p}id
            AND iv.filial_id = (SELECT uf3.filial_id FROM usuarios uf3 WHERE uf3.id = $${idUsuario})
        )
      )
    )
    OR (
      ${p}visibilidade = 'SELECIONADOS'
      AND EXISTS (
        SELECT 1 FROM imovel_visibilidades iv
        WHERE iv.imovel_id = ${p}id
          AND iv.usuario_id = $${idUsuario}
      )
    )
  )`;
}

/** Escopo de ESCRITA: quem pode editar/excluir o imóvel. */
function podeEditar(usuario, imovel) {
  if (!usuario || !imovel) return false;
  if (usuario.perfil === 'admin') return true;

  if (usuario.perfil === 'gerente') {
    return (
      String(imovel.gerente_id || '') === String(usuario.id) ||
      String(imovel.created_by || '') === String(usuario.id) ||
      String(imovel.corretor_id || '') === String(usuario.id) ||
      String(imovel.captador_id || '') === String(usuario.id) ||
      (!!imovel.filial_id && String(imovel.filial_id) === String(usuario.filialId || ''))
    );
  }

  // Corretor edita apenas o que captou ou o que está sob sua responsabilidade.
  return (
    String(imovel.corretor_id || '') === String(usuario.id) ||
    String(imovel.captador_id || '') === String(usuario.id) ||
    String(imovel.created_by || '') === String(usuario.id)
  );
}

// ---------------------------------------------------------------------
// FILTROS DE LISTAGEM
// ---------------------------------------------------------------------
function montarFiltros(filtros = {}, params, where) {
  const adicionar = (sql, valor) => {
    params.push(valor);
    where.push(sql.replace('$?', `$${params.length}`));
  };

  if (filtros.busca) {
    params.push(`%${String(filtros.busca).trim()}%`);
    const idx = params.length;
    where.push(`(
      i.codigo ILIKE $${idx}
      OR i.titulo ILIKE $${idx}
      OR i.bairro ILIKE $${idx}
      OR i.cidade ILIKE $${idx}
      OR i.empreendimento_nome ILIKE $${idx}
      OR i.referencia_externa ILIKE $${idx}
    )`);
  }

  if (filtros.codigo) adicionar('i.codigo ILIKE $?', `%${filtros.codigo}%`);
  if (filtros.titulo) adicionar('i.titulo ILIKE $?', `%${filtros.titulo}%`);
  if (filtros.finalidade) adicionar('i.finalidade = $?', filtros.finalidade);
  if (filtros.situacao) adicionar('i.situacao = $?', filtros.situacao);
  if (filtros.origemCarteira) adicionar('i.origem_carteira = $?', filtros.origemCarteira);
  if (filtros.cidade) adicionar('i.cidade ILIKE $?', `%${filtros.cidade}%`);
  if (filtros.bairro) adicionar('i.bairro ILIKE $?', `%${filtros.bairro}%`);
  if (filtros.uf) adicionar('i.uf = $?', filtros.uf);
  if (filtros.empreendimentoId) adicionar('i.empreendimento_legado_id = $?', filtros.empreendimentoId);
  if (filtros.corretorId) adicionar('i.corretor_id = $?', filtros.corretorId);
  if (filtros.captadorId) adicionar('i.captador_id = $?', filtros.captadorId);
  if (filtros.filialId) adicionar('i.filial_id = $?', filtros.filialId);
  if (filtros.vendaId) adicionar('i.venda_id = $?', filtros.vendaId);

  if (Array.isArray(filtros.tipos) && filtros.tipos.length) {
    adicionar('i.tipo = ANY($?)', filtros.tipos);
  } else if (filtros.tipo) {
    adicionar('i.tipo = $?', filtros.tipo);
  }

  if (Array.isArray(filtros.status) && filtros.status.length) {
    adicionar('i.status = ANY($?)', filtros.status);
  } else if (filtros.statusUnico) {
    adicionar('i.status = $?', filtros.statusUnico);
  }

  if (filtros.valorMinimo !== null && filtros.valorMinimo !== undefined) {
    adicionar('COALESCE(i.valor_venda, i.valor_locacao) >= $?', filtros.valorMinimo);
  }

  if (filtros.valorMaximo !== null && filtros.valorMaximo !== undefined) {
    adicionar('COALESCE(i.valor_venda, i.valor_locacao) <= $?', filtros.valorMaximo);
  }

  if (filtros.dormitoriosMinimo !== null && filtros.dormitoriosMinimo !== undefined) {
    adicionar('i.dormitorios >= $?', filtros.dormitoriosMinimo);
  }

  if (filtros.vagasMinimo !== null && filtros.vagasMinimo !== undefined) {
    adicionar('i.vagas >= $?', filtros.vagasMinimo);
  }

  if (filtros.areaMinima !== null && filtros.areaMinima !== undefined) {
    adicionar('COALESCE(i.area_util, i.area_total) >= $?', filtros.areaMinima);
  }

  if (filtros.ativo !== null && filtros.ativo !== undefined) {
    adicionar('i.ativo = $?', filtros.ativo);
  }

  if (filtros.oportunidade === true) where.push('i.oportunidade = TRUE');
  if (filtros.destaque === true) where.push('i.destaque = TRUE');
  if (filtros.exclusivo === true) where.push('i.exclusivo = TRUE');
  if (filtros.lancamento === true) where.push('i.lancamento = TRUE');

  if (filtros.publicado === true) {
    where.push(`EXISTS (
      SELECT 1 FROM imovel_portais ip
      WHERE ip.imovel_id = i.id AND ip.status = 'PUBLICADO'
    )`);
  }

  if (filtros.publicado === false) {
    where.push(`NOT EXISTS (
      SELECT 1 FROM imovel_portais ip
      WHERE ip.imovel_id = i.id AND ip.status = 'PUBLICADO'
    )`);
  }

  if (filtros.portalSlug) {
    adicionar(
      `EXISTS (
        SELECT 1 FROM imovel_portais ip
        INNER JOIN portais p ON p.id = ip.portal_id
        WHERE ip.imovel_id = i.id AND ip.habilitado AND p.slug = $?
      )`,
      filtros.portalSlug
    );
  }

  if (filtros.comErroPortal === true) {
    where.push(`EXISTS (
      SELECT 1 FROM imovel_portais ip
      WHERE ip.imovel_id = i.id AND ip.status IN ('ERRO', 'INVALIDO')
    )`);
  }

  if (filtros.semFotos === true) {
    where.push(`NOT EXISTS (
      SELECT 1 FROM imovel_midias m
      WHERE m.imovel_id = i.id AND m.tipo = 'IMAGEM'
    )`);
  }

  if (filtros.qualidadeMaxima !== null && filtros.qualidadeMaxima !== undefined) {
    adicionar('i.qualidade_score <= $?', filtros.qualidadeMaxima);
  }

  if (filtros.favoritosDoUsuario) {
    adicionar(
      `EXISTS (SELECT 1 FROM imovel_favoritos fv WHERE fv.imovel_id = i.id AND fv.usuario_id = $?)`,
      filtros.favoritosDoUsuario
    );
  }

  if (filtros.disponiveis === true) {
    params.push(STATUS_INDISPONIVEIS);
    where.push(`i.status <> ALL($${params.length}) AND i.ativo = TRUE`);
  }
}

const ORDENACOES = {
  recentes: 'i.created_at DESC',
  antigos: 'i.created_at ASC',
  valorAsc: 'COALESCE(i.valor_venda, i.valor_locacao) ASC NULLS LAST',
  valorDesc: 'COALESCE(i.valor_venda, i.valor_locacao) DESC NULLS LAST',
  codigo: 'i.codigo ASC',
  titulo: 'i.titulo ASC',
  areaDesc: 'COALESCE(i.area_util, i.area_total) DESC NULLS LAST',
  qualidade: 'i.qualidade_score DESC',
  oportunidade: 'i.oportunidade_score DESC, i.created_at DESC'
};

function resolverOrdenacao(chave) {
  return ORDENACOES[chave] || ORDENACOES.recentes;
}

// ---------------------------------------------------------------------
// CONSULTAS
// ---------------------------------------------------------------------
async function listar({ usuario, filtros = {}, ordenacao, page, pageSize, offset }) {
  const params = [];
  const where = ['i.deleted_at IS NULL'];

  const escopo = clausulaEscopo(usuario, params, 'i');
  if (escopo) where.push(escopo);

  montarFiltros(filtros, params, where);

  const whereSql = where.join('\n  AND ');

  const totalResult = await pool.query(
    `SELECT COUNT(*)::int AS total FROM imoveis i WHERE ${whereSql}`,
    params
  );

  const paramsPagina = [...params, pageSize, offset];

  const result = await pool.query(
    `
    SELECT ${COLUNAS_IMOVEL}, ${COLUNAS_RELACIONADAS}
    FROM imoveis i
    ${JOINS_PADRAO}
    WHERE ${whereSql}
    ORDER BY ${resolverOrdenacao(ordenacao)}
    LIMIT $${paramsPagina.length - 1} OFFSET $${paramsPagina.length}
    `,
    paramsPagina
  );

  return {
    rows: result.rows,
    total: totalResult.rows[0]?.total || 0,
    page,
    pageSize
  };
}

async function contadores({ usuario, filtros = {} }) {
  const params = [];
  const where = ['i.deleted_at IS NULL'];

  const escopo = clausulaEscopo(usuario, params, 'i');
  if (escopo) where.push(escopo);

  montarFiltros(filtros, params, where);

  const result = await pool.query(
    `
    SELECT
      COUNT(*)::int                                                            AS total,
      COUNT(*) FILTER (WHERE i.ativo)::int                                     AS ativos,
      COUNT(*) FILTER (WHERE i.status = 'DISPONIVEL')::int                     AS disponiveis,
      COUNT(*) FILTER (WHERE i.status = 'RESERVADO')::int                      AS reservados,
      COUNT(*) FILTER (WHERE i.status = 'EM_NEGOCIACAO')::int                  AS em_negociacao,
      COUNT(*) FILTER (WHERE i.status = 'VENDIDO')::int                        AS vendidos,
      COUNT(*) FILTER (WHERE i.status = 'ALUGADO')::int                        AS alugados,
      COUNT(*) FILTER (WHERE i.oportunidade)::int                              AS oportunidades,
      COUNT(*) FILTER (WHERE i.exclusivo)::int                                 AS exclusivos,
      COUNT(*) FILTER (WHERE i.lancamento)::int                                AS lancamentos,
      COUNT(*) FILTER (WHERE i.destaque)::int                                  AS destaques,
      COUNT(*) FILTER (WHERE i.qualidade_score < 60)::int                      AS baixa_qualidade,
      COUNT(*) FILTER (
        WHERE NOT EXISTS (
          SELECT 1 FROM imovel_midias m WHERE m.imovel_id = i.id AND m.tipo = 'IMAGEM'
        )
      )::int                                                                   AS sem_fotos,
      COUNT(*) FILTER (
        WHERE EXISTS (
          SELECT 1 FROM imovel_portais ip WHERE ip.imovel_id = i.id AND ip.status = 'PUBLICADO'
        )
      )::int                                                                   AS publicados,
      COUNT(*) FILTER (
        WHERE NOT EXISTS (
          SELECT 1 FROM imovel_portais ip WHERE ip.imovel_id = i.id AND ip.status = 'PUBLICADO'
        )
      )::int                                                                   AS nao_publicados,
      COUNT(*) FILTER (
        WHERE EXISTS (
          SELECT 1 FROM imovel_portais ip
          WHERE ip.imovel_id = i.id AND ip.status IN ('ERRO', 'INVALIDO')
        )
      )::int                                                                   AS com_erro_portal,
      COALESCE(SUM(i.total_leads), 0)::int                                     AS total_leads
    FROM imoveis i
    WHERE ${where.join('\n      AND ')}
    `,
    params
  );

  return result.rows[0];
}

async function buscarPorId(id, { usuario, ignorarEscopo = false } = {}) {
  const params = [id];
  const where = ['i.id = $1', 'i.deleted_at IS NULL'];

  if (!ignorarEscopo) {
    const escopo = clausulaEscopo(usuario, params, 'i');
    if (escopo) where.push(escopo);
  }

  const result = await pool.query(
    `
    SELECT ${COLUNAS_IMOVEL}, ${COLUNAS_RELACIONADAS}
    FROM imoveis i
    ${JOINS_PADRAO}
    WHERE ${where.join(' AND ')}
    LIMIT 1
    `,
    params
  );

  return result.rows[0] || null;
}

/** Leitura crua, sem escopo — uso interno (edição, feeds, publicação). */
async function buscarBruto(id, client = pool) {
  const result = await client.query(
    `SELECT * FROM imoveis WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
    [id]
  );

  return result.rows[0] || null;
}

/** Página pública: só imóvel ativo, disponível e liberado para o site. */
async function buscarPublicoPorSlug(slug) {
  const result = await pool.query(
    `
    SELECT ${COLUNAS_IMOVEL},
      f.nome AS filial_nome,
      uc.nome AS corretor_nome,
      uc.telefone AS corretor_telefone,
      uc.creci AS corretor_creci
    FROM imoveis i
    LEFT JOIN filiais f   ON f.id = i.filial_id
    LEFT JOIN usuarios uc ON uc.id = i.corretor_id
    WHERE LOWER(i.slug) = LOWER($1)
      AND i.deleted_at IS NULL
      AND i.ativo = TRUE
      AND i.publicar_site = TRUE
      AND i.finalidade IN ('VENDA', 'VENDA_LOCACAO')
      AND i.valor_venda IS NOT NULL
      AND i.status NOT IN ('VENDIDO', 'ALUGADO', 'SUSPENSO', 'INATIVO')
    LIMIT 1
    `,
    [slug]
  );

  return result.rows[0] || null;
}

async function slugExiste(slug, ignorarId = null) {
  const params = [slug];
  let sql = 'SELECT 1 FROM imoveis WHERE LOWER(slug) = LOWER($1) AND deleted_at IS NULL';

  if (ignorarId) {
    params.push(ignorarId);
    sql += ` AND id <> $2`;
  }

  const result = await pool.query(`${sql} LIMIT 1`, params);
  return result.rows.length > 0;
}

async function proximoCodigo(client = pool) {
  const prefixo = process.env.IMOVEL_CODIGO_PREFIXO || 'GL';
  const result = await client.query(`SELECT nextval('imoveis_codigo_seq') AS numero`);
  const numero = Number(result.rows[0].numero);

  return `${prefixo}${String(numero).padStart(6, '0')}`;
}

// ---------------------------------------------------------------------
// ESCRITA
// ---------------------------------------------------------------------
async function inserir(dados, client = pool) {
  const colunas = Object.keys(dados);
  const valores = colunas.map((coluna) => dados[coluna]);
  const placeholders = colunas.map((_, indice) => `$${indice + 1}`);

  const result = await client.query(
    `
    INSERT INTO imoveis (${colunas.join(', ')}, created_at, updated_at)
    VALUES (${placeholders.join(', ')}, NOW(), NOW())
    RETURNING *
    `,
    valores
  );

  return result.rows[0];
}

async function atualizar(id, dados, client = pool) {
  const colunas = Object.keys(dados);

  if (!colunas.length) return buscarBruto(id, client);

  const atribuicoes = colunas.map((coluna, indice) => `${coluna} = $${indice + 1}`);
  const valores = colunas.map((coluna) => dados[coluna]);
  valores.push(id);

  const result = await client.query(
    `
    UPDATE imoveis
    SET ${atribuicoes.join(', ')}, updated_at = NOW()
    WHERE id = $${valores.length} AND deleted_at IS NULL
    RETURNING *
    `,
    valores
  );

  return result.rows[0] || null;
}

/** Soft delete. Imóvel com histórico nunca é removido fisicamente. */
async function inativar(id, usuarioId, client = pool) {
  const result = await client.query(
    `
    UPDATE imoveis
    SET ativo = FALSE,
        status = 'INATIVO',
        deleted_at = NOW(),
        updated_by = $2,
        updated_at = NOW()
    WHERE id = $1 AND deleted_at IS NULL
    RETURNING id, codigo, titulo
    `,
    [id, usuarioId]
  );

  return result.rows[0] || null;
}

async function incrementarVisualizacao(id) {
  await pool.query(
    `UPDATE imoveis SET total_visualizacoes = total_visualizacoes + 1 WHERE id = $1`,
    [id]
  );
}

async function recontarLeads(imovelId, client = pool) {
  await client.query(
    `
    UPDATE imoveis
    SET total_leads = (
      SELECT COUNT(*) FROM portal_leads pl WHERE pl.imovel_id = imoveis.id
    )
    WHERE id = $1
    `,
    [imovelId]
  );
}

// ---------------------------------------------------------------------
// CARACTERÍSTICAS / VISIBILIDADE / FAVORITOS
// ---------------------------------------------------------------------
async function listarCaracteristicas(imovelId, client = pool) {
  const result = await client.query(
    `
    SELECT slug, label, grupo, valor
    FROM imovel_caracteristicas
    WHERE imovel_id = $1
    ORDER BY grupo ASC, label ASC
    `,
    [imovelId]
  );

  return result.rows;
}

async function substituirCaracteristicas(imovelId, caracteristicas, client) {
  await client.query('DELETE FROM imovel_caracteristicas WHERE imovel_id = $1', [imovelId]);

  if (!caracteristicas || !caracteristicas.length) return;

  for (const item of caracteristicas) {
    await client.query(
      `
      INSERT INTO imovel_caracteristicas (imovel_id, caracteristica_id, slug, label, grupo, valor)
      VALUES (
        $1,
        (SELECT id FROM caracteristicas WHERE slug = $2 LIMIT 1),
        $2, $3, $4, $5
      )
      ON CONFLICT (imovel_id, slug) DO UPDATE
      SET label = EXCLUDED.label, grupo = EXCLUDED.grupo, valor = EXCLUDED.valor
      `,
      [imovelId, item.slug, item.label, item.grupo, item.valor]
    );
  }
}

async function listarVisibilidade(imovelId, client = pool) {
  const result = await client.query(
    `
    SELECT iv.usuario_id, iv.filial_id, u.nome AS usuario_nome, f.nome AS filial_nome
    FROM imovel_visibilidades iv
    LEFT JOIN usuarios u ON u.id = iv.usuario_id
    LEFT JOIN filiais  f ON f.id = iv.filial_id
    WHERE iv.imovel_id = $1
    `,
    [imovelId]
  );

  return {
    usuarios: result.rows
      .filter((row) => row.usuario_id)
      .map((row) => ({ id: row.usuario_id, nome: row.usuario_nome })),
    filiais: result.rows
      .filter((row) => row.filial_id)
      .map((row) => ({ id: row.filial_id, nome: row.filial_nome }))
  };
}

async function substituirVisibilidade(imovelId, visibilidade, client) {
  await client.query('DELETE FROM imovel_visibilidades WHERE imovel_id = $1', [imovelId]);

  if (!visibilidade) return;

  for (const usuarioId of visibilidade.usuarios || []) {
    await client.query(
      `INSERT INTO imovel_visibilidades (imovel_id, usuario_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [imovelId, usuarioId]
    );
  }

  for (const filialId of visibilidade.filiais || []) {
    await client.query(
      `INSERT INTO imovel_visibilidades (imovel_id, filial_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [imovelId, filialId]
    );
  }
}

async function alternarFavorito(imovelId, usuarioId) {
  const existente = await pool.query(
    `SELECT id FROM imovel_favoritos WHERE imovel_id = $1 AND usuario_id = $2 LIMIT 1`,
    [imovelId, usuarioId]
  );

  if (existente.rows.length) {
    await pool.query('DELETE FROM imovel_favoritos WHERE id = $1', [existente.rows[0].id]);
    return { favorito: false };
  }

  await pool.query(
    `INSERT INTO imovel_favoritos (imovel_id, usuario_id) VALUES ($1, $2)`,
    [imovelId, usuarioId]
  );

  return { favorito: true };
}

async function idsFavoritos(usuarioId, imovelIds = []) {
  if (!usuarioId || !imovelIds.length) return new Set();

  const result = await pool.query(
    `SELECT imovel_id FROM imovel_favoritos WHERE usuario_id = $1 AND imovel_id = ANY($2::uuid[])`,
    [usuarioId, imovelIds]
  );

  return new Set(result.rows.map((row) => row.imovel_id));
}

module.exports = {
  COLUNAS_IMOVEL,
  clausulaEscopo,
  podeEditar,
  listar,
  contadores,
  buscarPorId,
  buscarBruto,
  buscarPublicoPorSlug,
  slugExiste,
  proximoCodigo,
  inserir,
  atualizar,
  inativar,
  incrementarVisualizacao,
  recontarLeads,
  listarCaracteristicas,
  substituirCaracteristicas,
  listarVisibilidade,
  substituirVisibilidade,
  alternarFavorito,
  idsFavoritos,
  resolverOrdenacao
};
