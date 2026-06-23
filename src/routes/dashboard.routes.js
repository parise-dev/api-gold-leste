const express = require('express');
const pool = require('../config/db');
const { authMiddleware } = require('../middlewares/auth.middleware');

const router = express.Router();

router.use(authMiddleware);

function montarFiltrosDashboard(req, alias = '') {
  const params = [];
  const where = [];

  const prefixo = alias ? `${alias}.` : '';
  const dataBase = `COALESCE(${prefixo}assinatura_ccv, ${prefixo}created_at)::date`;

  if (req.user.perfil === 'corretor') {
    params.push(req.user.id);
    where.push(`${prefixo}corretor_id = $${params.length}`);
  }

  const periodo = req.query.periodo || 'mesAtual';
  const dataInicio = req.query.dataInicio;
  const dataFim = req.query.dataFim;
  const ano = req.query.ano || new Date().getFullYear();

  if (periodo === 'semana') {
    where.push(`
      ${dataBase} >= DATE_TRUNC('week', CURRENT_DATE)::date
      AND ${dataBase} < (DATE_TRUNC('week', CURRENT_DATE)::date + INTERVAL '7 days')
    `);
  }

  if (periodo === 'mesAtual') {
    where.push(`
      ${dataBase} >= DATE_TRUNC('month', CURRENT_DATE)::date
      AND ${dataBase} < (DATE_TRUNC('month', CURRENT_DATE)::date + INTERVAL '1 month')
    `);
  }

  if (periodo === 'ano') {
    params.push(Number(ano));
    where.push(`EXTRACT(YEAR FROM ${dataBase})::INT = $${params.length}`);
  }

  if (periodo === 'personalizado' && dataInicio && dataFim) {
    params.push(dataInicio);
    where.push(`${dataBase} >= $${params.length}`);

    params.push(dataFim);
    where.push(`${dataBase} <= $${params.length}`);
  }

  return {
    params,
    whereSql: where.length ? `WHERE ${where.join(' AND ')}` : ''
  };
}

router.get('/resumo', async (req, res) => {
  try {
    const { params, whereSql } = montarFiltrosDashboard(req);

    const result = await pool.query(
      `
      SELECT
        COUNT(*)::INT AS total_vendas,

        COUNT(*) FILTER (WHERE situacao = 'Concluído' OR situacao = 'Concluido')::INT AS total_concluidas,
        COUNT(*) FILTER (WHERE situacao = 'Em processo')::INT AS total_em_processo,
        COUNT(*) FILTER (WHERE situacao = 'IR Futuro')::INT AS total_ir_futuro,
        COUNT(*) FILTER (WHERE situacao = 'Caiu')::INT AS total_caiu,

        COALESCE(SUM(valor_comissao_total), 0)::NUMERIC AS total_comissao,
        COALESCE(SUM(valor_imovel_venda), 0)::NUMERIC AS total_vendido,

        COALESCE(SUM(valor_repasse_corretor), 0)::NUMERIC AS total_repasse_corretor,
        COALESCE(SUM(valor_repasse_gerencia), 0)::NUMERIC AS total_repasse_gerencia,
        COALESCE(SUM(valor_repasse_imobiliaria), 0)::NUMERIC AS total_repasse_imobiliaria,

        COALESCE(SUM(valor_repasse_corretor) FILTER (WHERE status_comissao_corretor = 'Pendente'), 0)::NUMERIC AS comissao_a_receber,
        COALESCE(SUM(valor_repasse_corretor) FILTER (WHERE status_comissao_corretor = 'Pago'), 0)::NUMERIC AS comissao_paga
      FROM vendas
      ${whereSql}
      `,
      params
    );

    const row = result.rows[0];

    return res.json({
      totalVendas: Number(row.total_vendas || 0),
      totalConcluidas: Number(row.total_concluidas || 0),
      totalEmProcesso: Number(row.total_em_processo || 0),
      totalIrFuturo: Number(row.total_ir_futuro || 0),
      totalCaiu: Number(row.total_caiu || 0),

      totalComissao: Number(row.total_comissao || 0),
      totalVendido: Number(row.total_vendido || 0),

      totalRepasseCorretor: Number(row.total_repasse_corretor || 0),
      totalRepasseGerencia: Number(row.total_repasse_gerencia || 0),
      totalRepasseImobiliaria: Number(row.total_repasse_imobiliaria || 0),

      comissaoAReceber: Number(row.comissao_a_receber || 0),
      comissaoPaga: Number(row.comissao_paga || 0)
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: 'Erro ao carregar resumo'
    });
  }
});

router.get('/ranking-corretores', async (req, res) => {
  try {
    if (req.user.perfil === 'corretor') {
      return res.status(403).json({
        message: 'Acesso restrito a admin e gerente'
      });
    }

    const { params, whereSql } = montarFiltrosDashboard(req, 'v');

    const result = await pool.query(
      `
      SELECT
        COALESCE(u.id, v.corretor_id) AS corretor_id,
        COALESCE(u.nome, v.corretor_nome, 'Sem corretor') AS corretor_nome,

        COUNT(v.id)::INT AS total_vendas,
        COUNT(v.id) FILTER (WHERE v.situacao = 'Concluído' OR v.situacao = 'Concluido')::INT AS vendas_concluidas,

        COALESCE(SUM(v.valor_imovel_venda), 0)::NUMERIC AS total_vendido,
        COALESCE(SUM(v.valor_comissao_total), 0)::NUMERIC AS total_comissao,
        COALESCE(SUM(v.valor_repasse_corretor), 0)::NUMERIC AS total_repasse,

        COALESCE(SUM(v.valor_repasse_corretor) FILTER (WHERE v.status_comissao_corretor = 'Pendente'), 0)::NUMERIC AS comissao_a_receber,
        COALESCE(SUM(v.valor_repasse_corretor) FILTER (WHERE v.status_comissao_corretor = 'Pago'), 0)::NUMERIC AS comissao_paga

      FROM vendas v
      LEFT JOIN usuarios u ON u.id = v.corretor_id
      ${whereSql}
      GROUP BY COALESCE(u.id, v.corretor_id), COALESCE(u.nome, v.corretor_nome, 'Sem corretor')
      ORDER BY total_vendido DESC, total_vendas DESC
      LIMIT 10
      `,
      params
    );

    return res.json(result.rows.map(row => ({
      corretorId: row.corretor_id,
      corretorNome: row.corretor_nome,
      totalVendas: Number(row.total_vendas || 0),
      vendasConcluidas: Number(row.vendas_concluidas || 0),
      totalVendido: Number(row.total_vendido || 0),
      totalComissao: Number(row.total_comissao || 0),
      totalRepasse: Number(row.total_repasse || 0),
      comissaoAReceber: Number(row.comissao_a_receber || 0),
      comissaoPaga: Number(row.comissao_paga || 0)
    })));
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: 'Erro ao carregar ranking'
    });
  }
});

router.get('/evolucao-mensal', async (req, res) => {
  try {
    const { params, whereSql } = montarFiltrosDashboard(req);

    const result = await pool.query(
      `
      SELECT
        TO_CHAR(DATE_TRUNC('month', COALESCE(assinatura_ccv, created_at)), 'YYYY-MM') AS mes,
        TO_CHAR(DATE_TRUNC('month', COALESCE(assinatura_ccv, created_at)), 'MM/YYYY') AS mes_label,

        COUNT(*)::INT AS total_vendas,
        COUNT(*) FILTER (WHERE situacao = 'Concluído' OR situacao = 'Concluido')::INT AS vendas_concluidas,

        COALESCE(SUM(valor_imovel_venda), 0)::NUMERIC AS total_vendido,
        COALESCE(SUM(valor_comissao_total), 0)::NUMERIC AS total_comissao,
        COALESCE(SUM(valor_repasse_corretor), 0)::NUMERIC AS total_repasse_corretor

      FROM vendas
      ${whereSql}
      GROUP BY DATE_TRUNC('month', COALESCE(assinatura_ccv, created_at))
      ORDER BY DATE_TRUNC('month', COALESCE(assinatura_ccv, created_at))
      `,
      params
    );

    return res.json(result.rows.map(row => ({
      mes: row.mes,
      mesLabel: row.mes_label,
      totalVendas: Number(row.total_vendas || 0),
      vendasConcluidas: Number(row.vendas_concluidas || 0),
      totalVendido: Number(row.total_vendido || 0),
      totalComissao: Number(row.total_comissao || 0),
      totalRepasseCorretor: Number(row.total_repasse_corretor || 0)
    })));
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: 'Erro ao carregar evolução mensal'
    });
  }
});

router.get('/empreendimentos-mais-vendidos', async (req, res) => {
  try {
    const { params, whereSql } = montarFiltrosDashboard(req);

    const result = await pool.query(
      `
      SELECT
        COALESCE(NULLIF(TRIM(empreendimento_rua), ''), 'Não informado') AS empreendimento,
        COUNT(*)::INT AS total_vendas,
        COALESCE(SUM(valor_imovel_venda), 0)::NUMERIC AS total_vendido,
        COALESCE(SUM(valor_comissao_total), 0)::NUMERIC AS total_comissao
      FROM vendas
      ${whereSql}
      GROUP BY COALESCE(NULLIF(TRIM(empreendimento_rua), ''), 'Não informado')
      ORDER BY total_vendas DESC, total_vendido DESC
      LIMIT 10
      `,
      params
    );

    return res.json(result.rows.map(row => ({
      empreendimento: row.empreendimento,
      totalVendas: Number(row.total_vendas || 0),
      totalVendido: Number(row.total_vendido || 0),
      totalComissao: Number(row.total_comissao || 0)
    })));
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: 'Erro ao carregar empreendimentos mais vendidos'
    });
  }
});

router.get('/modalidades', async (req, res) => {
  try {
    const { params, whereSql } = montarFiltrosDashboard(req);

    const result = await pool.query(
      `
      SELECT
        COALESCE(NULLIF(TRIM(modalidade_imovel), ''), 'Não informado') AS modalidade,
        COUNT(*)::INT AS total_vendas,
        COALESCE(SUM(valor_imovel_venda), 0)::NUMERIC AS total_vendido,
        COALESCE(SUM(valor_comissao_total), 0)::NUMERIC AS total_comissao
      FROM vendas
      ${whereSql}
      GROUP BY COALESCE(NULLIF(TRIM(modalidade_imovel), ''), 'Não informado')
      ORDER BY total_vendas DESC
      `,
      params
    );

    return res.json(result.rows.map(row => ({
      modalidade: row.modalidade,
      totalVendas: Number(row.total_vendas || 0),
      totalVendido: Number(row.total_vendido || 0),
      totalComissao: Number(row.total_comissao || 0)
    })));
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: 'Erro ao carregar modalidades'
    });
  }
});

router.get('/comissoes-mes', async (req, res) => {
  try {
    const { params, whereSql } = montarFiltrosDashboard(req);

    const result = await pool.query(
      `
      SELECT
        TO_CHAR(DATE_TRUNC('month', COALESCE(assinatura_ccv, created_at)), 'YYYY-MM') AS mes,
        TO_CHAR(DATE_TRUNC('month', COALESCE(assinatura_ccv, created_at)), 'MM/YYYY') AS mes_label,

        COALESCE(SUM(valor_repasse_corretor) FILTER (WHERE status_comissao_corretor = 'Pendente'), 0)::NUMERIC AS comissao_pendente,
        COALESCE(SUM(valor_repasse_corretor) FILTER (WHERE status_comissao_corretor = 'Pago'), 0)::NUMERIC AS comissao_paga,
        COALESCE(SUM(valor_repasse_corretor), 0)::NUMERIC AS comissao_total

      FROM vendas
      ${whereSql}
      GROUP BY DATE_TRUNC('month', COALESCE(assinatura_ccv, created_at))
      ORDER BY DATE_TRUNC('month', COALESCE(assinatura_ccv, created_at))
      `,
      params
    );

    return res.json(result.rows.map(row => ({
      mes: row.mes,
      mesLabel: row.mes_label,
      comissaoPendente: Number(row.comissao_pendente || 0),
      comissaoPaga: Number(row.comissao_paga || 0),
      comissaoTotal: Number(row.comissao_total || 0)
    })));
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: 'Erro ao carregar comissões por mês'
    });
  }
});

router.get('/minhas-comissoes', async (req, res) => {
  try {
    if (req.user.perfil !== 'corretor') {
      return res.status(403).json({
        message: 'Rota disponível apenas para corretores'
      });
    }

    const { params, whereSql } = montarFiltrosDashboard(req);

    const result = await pool.query(
      `
      SELECT
        id,
        cliente,
        empreendimento_rua,
        numero_unidade,
        assinatura_ccv,
        valor_imovel_venda,
        valor_repasse_corretor,
        status_comissao_corretor,
        data_pagamento_comissao
      FROM vendas
      ${whereSql}
      ORDER BY assinatura_ccv DESC NULLS LAST, created_at DESC
      `,
      params
    );

    return res.json(result.rows.map(row => ({
      id: row.id,
      cliente: row.cliente,
      empreendimentoRua: row.empreendimento_rua,
      numeroUnidade: row.numero_unidade,
      assinaturaCcv: row.assinatura_ccv,
      valorImovelVenda: Number(row.valor_imovel_venda || 0),
      valorRepasseCorretor: Number(row.valor_repasse_corretor || 0),
      statusComissaoCorretor: row.status_comissao_corretor,
      dataPagamentoComissao: row.data_pagamento_comissao
    })));
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: 'Erro ao carregar comissões do corretor'
    });
  }
});

module.exports = router;