const express = require('express');

const pool = require('../config/db');
const { authMiddleware, somentePerfis } = require('../middlewares/auth.middleware');
const { asyncHandler } = require('../utils/async-handler');
const { resolverPaginacao, montarResultadoPaginado } = require('../utils/pagination');
const { limparTexto } = require('../utils/sanitize');
const { exigirUuid } = require('../validators/imovel.validator');
const { badRequest, notFound, conflict } = require('../utils/http-error');

const router = express.Router();

router.use(authMiddleware);
router.use(somentePerfis('admin'));

const STATUS = ['NOVA', 'EM_CONTATO', 'APROVADA', 'RECUSADA', 'CONVERTIDA'];

function mapear(row) {
  const payload = row.payload_original && typeof row.payload_original === 'object'
    ? row.payload_original
    : {};

  return {
    id: row.id,
    status: row.captacao_status || 'NOVA',
    nome: row.nome,
    telefone: row.telefone,
    email: row.email,
    tipo: payload.tipo || null,
    cidade: payload.cidade || null,
    bairro: payload.bairro || null,
    endereco: payload.endereco || null,
    complemento: payload.complemento || null,
    dormitorios: payload.dormitorios ?? null,
    vagas: payload.vagas ?? null,
    area: payload.area ?? null,
    valorPretendido: payload.valorPretendido ?? null,
    observacoesProprietario: payload.observacoes || null,
    observacoesInternas: row.captacao_observacoes || null,
    pagina: row.pagina,
    utmSource: row.utm_source,
    utmMedium: row.utm_medium,
    utmCampaign: row.utm_campaign,
    recebidoEm: row.recebido_em,
    contatadoEm: row.captacao_contatado_em,
    aprovadoEm: row.captacao_aprovada_em,
    recusadoEm: row.captacao_recusada_em,
    convertidoEm: row.captacao_convertida_em,
    imovelId: row.captacao_imovel_id,
    imovelCodigo: row.imovel_codigo_convertido || null,
    imovelTitulo: row.imovel_titulo_convertido || null
  };
}

const SELECT_BASE = `
  SELECT pl.*,
         i.codigo AS imovel_codigo_convertido,
         i.titulo AS imovel_titulo_convertido
  FROM portal_leads pl
  LEFT JOIN imoveis i ON i.id = pl.captacao_imovel_id
`;

router.get(
  '/resumo',
  asyncHandler(async (req, res) => {
    const result = await pool.query(`
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE captacao_status = 'NOVA')::int AS novas,
             COUNT(*) FILTER (WHERE captacao_status = 'EM_CONTATO')::int AS em_contato,
             COUNT(*) FILTER (WHERE captacao_status = 'APROVADA')::int AS aprovadas,
             COUNT(*) FILTER (WHERE captacao_status = 'RECUSADA')::int AS recusadas,
             COUNT(*) FILTER (WHERE captacao_status = 'CONVERTIDA')::int AS convertidas
      FROM portal_leads
      WHERE tipo_lead = 'CAPTACAO_IMOVEL'
    `);

    res.json(result.rows[0]);
  })
);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const paginacao = resolverPaginacao(req.query, 20);
    const params = [];
    const where = [`pl.tipo_lead = 'CAPTACAO_IMOVEL'`];

    if (req.query.status) {
      const status = String(req.query.status).toUpperCase();
      if (!STATUS.includes(status)) throw badRequest('Status de captação inválido.');
      params.push(status);
      where.push(`pl.captacao_status = $${params.length}`);
    }

    if (req.query.busca) {
      params.push(`%${limparTexto(req.query.busca, 160)}%`);
      const indice = params.length;
      where.push(`(
        pl.nome ILIKE $${indice}
        OR pl.email ILIKE $${indice}
        OR pl.telefone ILIKE $${indice}
        OR pl.payload_original->>'bairro' ILIKE $${indice}
        OR pl.payload_original->>'cidade' ILIKE $${indice}
      )`);
    }

    const whereSql = where.join(' AND ');
    const total = await pool.query(
      `SELECT COUNT(*)::int AS total FROM portal_leads pl WHERE ${whereSql}`,
      params
    );

    const paramsPagina = [...params, paginacao.pageSize, paginacao.offset];
    const result = await pool.query(
      `${SELECT_BASE}
       WHERE ${whereSql}
       ORDER BY
         CASE pl.captacao_status
           WHEN 'NOVA' THEN 1
           WHEN 'EM_CONTATO' THEN 2
           WHEN 'APROVADA' THEN 3
           WHEN 'RECUSADA' THEN 4
           WHEN 'CONVERTIDA' THEN 5
           ELSE 6
         END,
         pl.recebido_em DESC
       LIMIT $${paramsPagina.length - 1} OFFSET $${paramsPagina.length}`,
      paramsPagina
    );

    res.json(
      montarResultadoPaginado(
        result.rows.map(mapear),
        total.rows[0].total,
        paginacao
      )
    );
  })
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = exigirUuid(req.params.id, 'captação');
    const result = await pool.query(
      `${SELECT_BASE}
       WHERE pl.id = $1 AND pl.tipo_lead = 'CAPTACAO_IMOVEL'
       LIMIT 1`,
      [id]
    );

    if (!result.rows.length) throw notFound('Captação de imóvel não encontrada.');
    res.json(mapear(result.rows[0]));
  })
);

router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = exigirUuid(req.params.id, 'captação');
    const status = req.body.status ? String(req.body.status).toUpperCase() : null;

    if (status && !STATUS.includes(status)) throw badRequest('Status de captação inválido.');
    if (status === 'CONVERTIDA') {
      throw badRequest('A captação só é convertida quando o cadastro completo do imóvel é salvo.');
    }

    const atual = await pool.query(
      `SELECT id, captacao_status FROM portal_leads
       WHERE id = $1 AND tipo_lead = 'CAPTACAO_IMOVEL' LIMIT 1`,
      [id]
    );

    if (!atual.rows.length) throw notFound('Captação de imóvel não encontrada.');
    if (atual.rows[0].captacao_status === 'CONVERTIDA') {
      throw conflict('Esta captação já foi convertida em imóvel.');
    }

    const observacoes = Object.prototype.hasOwnProperty.call(req.body, 'observacoes')
      ? limparTexto(req.body.observacoes, 4000)
      : null;

    const result = await pool.query(
      `UPDATE portal_leads
       SET captacao_status = COALESCE($2, captacao_status),
           captacao_observacoes = CASE WHEN $3::boolean THEN $4 ELSE captacao_observacoes END,
           captacao_contatado_em = CASE
             WHEN $2 = 'EM_CONTATO' THEN COALESCE(captacao_contatado_em, NOW())
             ELSE captacao_contatado_em
           END,
           captacao_aprovada_em = CASE WHEN $2 = 'APROVADA' THEN NOW() ELSE captacao_aprovada_em END,
           captacao_recusada_em = CASE WHEN $2 = 'RECUSADA' THEN NOW() ELSE captacao_recusada_em END,
           status_processamento = CASE
             WHEN $2 = 'RECUSADA' THEN 'DESCARTADO'
             WHEN $2 IN ('EM_CONTATO', 'APROVADA') THEN 'VALIDADO'
             ELSE status_processamento
           END,
           captacao_atualizada_por = $5,
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [
        id,
        status,
        Object.prototype.hasOwnProperty.call(req.body, 'observacoes'),
        observacoes,
        req.user.id
      ]
    );

    const detalhe = await pool.query(
      `${SELECT_BASE} WHERE pl.id = $1 LIMIT 1`,
      [result.rows[0].id]
    );

    res.json(mapear(detalhe.rows[0]));
  })
);

module.exports = router;
