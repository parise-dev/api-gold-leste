const express = require('express');
const pool = require('../config/db');
const { authMiddleware } = require('../middlewares/auth.middleware');

const router = express.Router();

router.use(authMiddleware);

function montarFiltrosPeriodo(req, alias = '') {
  const params = [];
  const where = [];

  const prefixo = alias ? `${alias}.` : '';
  const dataBase = `COALESCE(${prefixo}assinatura_ccv, ${prefixo}created_at)::date`;

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

  return { params, where };
}

function montarFiltrosDashboard(req, alias = '') {
  const { params, where } = montarFiltrosPeriodo(req, alias);

  const prefixo = alias ? `${alias}.` : '';

  if (req.user.perfil === 'corretor') {
    params.push(req.user.id);
    const idx = params.length;

    where.push(`
      (
        ${prefixo}corretor_id = $${idx}
        OR ${prefixo}corretor_2_id = $${idx}
        OR ${prefixo}captador_id = $${idx}
        OR ${prefixo}puxador_id = $${idx}
        OR EXISTS (
          SELECT 1
          FROM venda_corretores vc
          WHERE vc.venda_id = ${prefixo}id
            AND vc.corretor_id = $${idx}
        )
      )
    `);
  }

  if (req.user.perfil === 'gerente') {
    params.push(req.user.id);
    const idx = params.length;

    where.push(`
      (
        ${prefixo}created_by = $${idx}
        OR ${prefixo}updated_by = $${idx}
        OR EXISTS (
          SELECT 1
          FROM usuarios c
          WHERE c.id IN (${prefixo}corretor_id, ${prefixo}corretor_2_id, ${prefixo}captador_id, ${prefixo}puxador_id)
            AND c.gerente_id = $${idx}
        )
        OR EXISTS (
          SELECT 1
          FROM venda_corretores vc
          INNER JOIN usuarios c ON c.id = vc.corretor_id
          WHERE vc.venda_id = ${prefixo}id
            AND c.gerente_id = $${idx}
        )
      )
    `);
  }

  return {
    params,
    whereSql: where.length ? `WHERE ${where.join(' AND ')}` : ''
  };
}

function wherePeriodoSql(req, alias = 'v') {
  const { params, where } = montarFiltrosPeriodo(req, alias);

  return {
    params,
    whereSql: where.length ? `WHERE ${where.join(' AND ')}` : ''
  };
}

router.get('/resumo', async (req, res) => {
  try {
    const { params, whereSql } = montarFiltrosDashboard(req, 'v');
    const usuarioParamIndex = params.length + 1;
    const queryParams = [...params, req.user.id];

    const result = await pool.query(
      `
      WITH vendas_base AS (
        SELECT v.*
        FROM vendas v
        ${whereSql}
      ),

      vendedores AS (
        SELECT
          vc.venda_id,
          vc.corretor_id,
          COALESCE(vc.valor_repasse, 0)::NUMERIC AS valor_repasse
        FROM venda_corretores vc
        INNER JOIN vendas_base vb ON vb.id = vc.venda_id

        UNION ALL

        SELECT
          vb.id AS venda_id,
          vb.corretor_id,
          COALESCE(vb.valor_repasse_corretor, 0)::NUMERIC AS valor_repasse
        FROM vendas_base vb
        WHERE vb.corretor_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM venda_corretores vc
            WHERE vc.venda_id = vb.id
              AND vc.corretor_id = vb.corretor_id
          )
      ),

      captacoes AS (
        SELECT
          vb.id AS venda_id,
          vb.captador_id AS corretor_id,
          COALESCE(vb.valor_captacao, 0)::NUMERIC AS valor_repasse
        FROM vendas_base vb
        WHERE vb.captacao = 'Sim'
          AND vb.captador_id IS NOT NULL
          AND COALESCE(vb.valor_captacao, 0) > 0
      ),

      puxadores AS (
        SELECT
          vb.id AS venda_id,
          vb.puxador_id AS corretor_id,
          COALESCE(vb.valor_fechador, 0)::NUMERIC AS valor_repasse
        FROM vendas_base vb
        WHERE vb.fechador = 'Sim'
          AND vb.puxador_id IS NOT NULL
          AND COALESCE(vb.valor_fechador, 0) > 0
      ),

      repasses_usuario AS (
        SELECT venda_id, corretor_id, valor_repasse, 'venda' AS tipo FROM vendedores
        UNION ALL
        SELECT venda_id, corretor_id, valor_repasse, 'captacao' AS tipo FROM captacoes
        UNION ALL
        SELECT venda_id, corretor_id, valor_repasse, 'puxador' AS tipo FROM puxadores
      ),

      repasses_por_venda AS (
        SELECT
          r.venda_id,

          COALESCE(SUM(r.valor_repasse), 0)::NUMERIC AS total_repasse_corretores_e_captacao,

          COALESCE(SUM(r.valor_repasse) FILTER (WHERE r.tipo = 'captacao'), 0)::NUMERIC AS total_repasse_captacao,

          COALESCE(SUM(r.valor_repasse) FILTER (WHERE r.corretor_id = $${usuarioParamIndex}), 0)::NUMERIC AS repasse_usuario,

          BOOL_OR(r.tipo = 'venda' AND r.corretor_id = $${usuarioParamIndex}) AS usuario_vendeu,

          BOOL_OR(r.tipo = 'captacao' AND r.corretor_id = $${usuarioParamIndex}) AS usuario_captou,

          BOOL_OR(r.tipo = 'puxador' AND r.corretor_id = $${usuarioParamIndex}) AS usuario_puxou
        FROM repasses_usuario r
        GROUP BY r.venda_id
      ),

      pagamentos_usuario AS (
        SELECT
          uc.venda_id,
          COALESCE(SUM(uc.valor), 0)::NUMERIC AS total_pago
        FROM usuarios_comprovantes uc
        INNER JOIN vendas_base vb ON vb.id = uc.venda_id
        WHERE uc.usuario_id = $${usuarioParamIndex}
          OR uc.corretor_id = $${usuarioParamIndex}
        GROUP BY uc.venda_id
      ),

      pagamentos_corretores AS (
        SELECT
          uc.venda_id,
          COALESCE(SUM(uc.valor), 0)::NUMERIC AS total_pago
        FROM usuarios_comprovantes uc
        INNER JOIN vendas_base vb ON vb.id = uc.venda_id
        INNER JOIN usuarios u ON u.id = COALESCE(uc.usuario_id, uc.corretor_id)
        WHERE u.perfil = 'corretor'
        GROUP BY uc.venda_id
      ),

      pagamentos_gerencia AS (
        SELECT
          uc.venda_id,
          COALESCE(SUM(uc.valor), 0)::NUMERIC AS total_pago
        FROM usuarios_comprovantes uc
        INNER JOIN vendas_base vb ON vb.id = uc.venda_id
        INNER JOIN usuarios u ON u.id = COALESCE(uc.usuario_id, uc.corretor_id)
        WHERE u.perfil = 'gerente'
        GROUP BY uc.venda_id
      ),

      recebimentos_imobiliaria AS (
        SELECT
          cr.venda_id,
          COALESCE(SUM(cr.valor_recebido), 0)::NUMERIC AS total_recebido
        FROM contas_receber cr
        INNER JOIN vendas_base vb ON vb.id = cr.venda_id
        WHERE cr.status IN ('Recebido', 'Parcial')
        GROUP BY cr.venda_id
      )

      SELECT
        COUNT(vb.id)::INT AS total_vendas_geral,

        COUNT(vb.id) FILTER (
          WHERE COALESCE(rpv.usuario_vendeu, false)
        )::INT AS total_vendas_usuario,

        COUNT(vb.id) FILTER (
          WHERE COALESCE(rpv.usuario_captou, false)
        )::INT AS total_captacoes_usuario,

        COUNT(vb.id) FILTER (
          WHERE vb.captacao = 'Sim'
            AND COALESCE(vb.valor_captacao, 0) > 0
        )::INT AS total_captacoes_geral,

        COALESCE(SUM(
          CASE
            WHEN COALESCE(rpv.usuario_captou, false)
            THEN COALESCE(vb.valor_captacao, 0)
            ELSE 0
          END
        ), 0)::NUMERIC AS total_valor_captacao_usuario,

        COALESCE(SUM(
          CASE
            WHEN vb.captacao = 'Sim'
              AND COALESCE(vb.valor_captacao, 0) > 0
            THEN COALESCE(vb.valor_captacao, 0)
            ELSE 0
          END
        ), 0)::NUMERIC AS total_valor_captacao_geral,

        COUNT(vb.id) FILTER (
          WHERE vb.situacao = 'Concluído'
             OR vb.situacao = 'Concluido'
        )::INT AS total_concluidas_geral,

        COUNT(vb.id) FILTER (
          WHERE (vb.situacao = 'Concluído' OR vb.situacao = 'Concluido')
            AND COALESCE(rpv.usuario_vendeu, false)
        )::INT AS total_concluidas_usuario,

        COUNT(vb.id) FILTER (
          WHERE vb.situacao = 'Em processo'
        )::INT AS total_em_processo_geral,

        COUNT(vb.id) FILTER (
          WHERE vb.situacao = 'Em processo'
            AND COALESCE(rpv.usuario_vendeu, false)
        )::INT AS total_em_processo_usuario,

        COUNT(vb.id) FILTER (
          WHERE vb.situacao = 'IR Futuro'
        )::INT AS total_ir_futuro_geral,

        COUNT(vb.id) FILTER (
          WHERE vb.situacao = 'IR Futuro'
            AND COALESCE(rpv.usuario_vendeu, false)
        )::INT AS total_ir_futuro_usuario,

        COUNT(vb.id) FILTER (
          WHERE vb.situacao = 'Distrato'
        )::INT AS total_distrato_geral,

        COUNT(vb.id) FILTER (
          WHERE vb.situacao = 'Distrato'
            AND COALESCE(rpv.usuario_vendeu, false)
        )::INT AS total_distrato_usuario,

        COALESCE(SUM(vb.valor_comissao_total), 0)::NUMERIC AS total_comissao_bruta,

        COALESCE(SUM(vb.valor_imovel_venda), 0)::NUMERIC AS total_vendido_geral,

        COALESCE(SUM(
          CASE
            WHEN COALESCE(rpv.usuario_vendeu, false)
            THEN COALESCE(vb.valor_imovel_venda, 0)
            ELSE 0
          END
        ), 0)::NUMERIC AS total_vendido_usuario,

        COALESCE(SUM(COALESCE(rpv.total_repasse_corretores_e_captacao, 0)), 0)::NUMERIC AS total_repasse_corretores,

        COALESCE(SUM(COALESCE(rpv.total_repasse_captacao, 0)), 0)::NUMERIC AS total_repasse_captacao,

        COALESCE(SUM(COALESCE(rpv.repasse_usuario, 0)), 0)::NUMERIC AS repasse_usuario,

        COALESCE(SUM(vb.valor_repasse_gerencia), 0)::NUMERIC AS total_repasse_gerencia,

        COALESCE(SUM(vb.valor_repasse_imobiliaria), 0)::NUMERIC AS total_repasse_imobiliaria,

        COALESCE(SUM(COALESCE(pu.total_pago, 0)), 0)::NUMERIC AS pago_usuario,

        COALESCE(SUM(COALESCE(pc.total_pago, 0)), 0)::NUMERIC AS pago_corretores,

        COALESCE(SUM(COALESCE(pg.total_pago, 0)), 0)::NUMERIC AS pago_gerencia,

        COALESCE(SUM(COALESCE(ri.total_recebido, 0)), 0)::NUMERIC AS total_recebido_imobiliaria

      FROM vendas_base vb
      LEFT JOIN repasses_por_venda rpv ON rpv.venda_id = vb.id
      LEFT JOIN pagamentos_usuario pu ON pu.venda_id = vb.id
      LEFT JOIN pagamentos_corretores pc ON pc.venda_id = vb.id
      LEFT JOIN pagamentos_gerencia pg ON pg.venda_id = vb.id
      LEFT JOIN recebimentos_imobiliaria ri ON ri.venda_id = vb.id
      `,
      queryParams
    );

    const row = result.rows[0] || {};
    const perfil = req.user.perfil;

    const totalComissaoBruta = Number(row.total_comissao_bruta || 0);
    const totalRepasseCorretores = Number(row.total_repasse_corretores || 0);
    const totalRepasseCaptacao = Number(row.total_repasse_captacao || 0);
    const totalRepasseGerencia = Number(row.total_repasse_gerencia || 0);
    const totalRepasseImobiliaria = Number(row.total_repasse_imobiliaria || 0);

    const repasseUsuario = Number(row.repasse_usuario || 0);
    const pagoUsuario = Number(row.pago_usuario || 0);
    const pagoCorretores = Number(row.pago_corretores || 0);
    const pagoGerencia = Number(row.pago_gerencia || 0);
    const totalRecebidoImobiliaria = Number(row.total_recebido_imobiliaria || 0);

    const totalCaptacoesUsuario = Number(row.total_captacoes_usuario || 0);
    const totalCaptacoesGeral = Number(row.total_captacoes_geral || 0);

    const totalValorCaptacaoUsuario = Number(row.total_valor_captacao_usuario || 0);
    const totalValorCaptacaoGeral = Number(row.total_valor_captacao_geral || 0);

    let totalComissao = totalComissaoBruta;
    let totalRepasseCorretor = totalRepasseCorretores;
    let comissaoPaga = pagoCorretores + pagoGerencia;
    let comissaoAReceber = Math.max(
      totalRepasseCorretores + totalRepasseGerencia - pagoCorretores - pagoGerencia,
      0
    );

    if (perfil === 'gerente') {
      totalComissao = totalRepasseGerencia;
      totalRepasseCorretor = 0;
      comissaoPaga = pagoUsuario;
      comissaoAReceber = Math.max(totalRepasseGerencia - pagoUsuario, 0);
    }

    if (perfil === 'corretor') {
      totalComissao = repasseUsuario;
      totalRepasseCorretor = repasseUsuario;
      comissaoPaga = pagoUsuario;
      comissaoAReceber = Math.max(repasseUsuario - pagoUsuario, 0);
    }

    return res.json({
      totalVendas: perfil === 'corretor'
        ? Number(row.total_vendas_usuario || 0)
        : Number(row.total_vendas_geral || 0),

      totalConcluidas: perfil === 'corretor'
        ? Number(row.total_concluidas_usuario || 0)
        : Number(row.total_concluidas_geral || 0),

      totalEmProcesso: perfil === 'corretor'
        ? Number(row.total_em_processo_usuario || 0)
        : Number(row.total_em_processo_geral || 0),

      totalIrFuturo: perfil === 'corretor'
        ? Number(row.total_ir_futuro_usuario || 0)
        : Number(row.total_ir_futuro_geral || 0),

      totalDistrato: perfil === 'corretor'
        ? Number(row.total_distrato_usuario || 0)
        : Number(row.total_distrato_geral || 0),

      totalCaptacoes: perfil === 'corretor'
        ? totalCaptacoesUsuario
        : totalCaptacoesGeral,

      totalValorCaptacaoUsuario: perfil === 'corretor'
        ? totalValorCaptacaoUsuario
        : totalValorCaptacaoGeral,

      totalComissao,

      totalVendido: perfil === 'corretor'
        ? Number(row.total_vendido_usuario || 0)
        : Number(row.total_vendido_geral || 0),

      totalRepasseCorretor,
      totalRepasseGerencia,
      totalRepasseImobiliaria,

      totalRepasseCaptacao: perfil === 'corretor'
        ? totalValorCaptacaoUsuario
        : totalRepasseCaptacao,

      totalPagoCaptacao: 0,

      totalPendenteCaptacao: perfil === 'corretor'
        ? totalValorCaptacaoUsuario
        : totalRepasseCaptacao,

      comissaoAReceber,
      comissaoPaga,

      totalRecebidoImobiliaria,

      totalFaltaReceberImobiliaria: Math.max(
        totalComissaoBruta - totalRecebidoImobiliaria,
        0
      ),

      totalPagoCorretores: pagoCorretores,

      totalPendenteCorretores: Math.max(
        totalRepasseCorretores - pagoCorretores,
        0
      ),

      totalPagoGerencia: pagoGerencia,

      totalPendenteGerencia: Math.max(
        totalRepasseGerencia - pagoGerencia,
        0
      ),

      resultadoPrevistoImobiliaria: totalComissaoBruta,
      resultadoRecebidoImobiliaria: totalRecebidoImobiliaria
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
    const { params, whereSql } = wherePeriodoSql(req, 'v');

    const result = await pool.query(
      `
      WITH vendas_base AS (
        SELECT v.*
        FROM vendas v
        ${whereSql}
      ),

      vendedores AS (
        SELECT
          vc.corretor_id,
          vb.id AS venda_id,
          vb.situacao,
          vb.valor_imovel_venda,
          vb.valor_comissao_total,
          COALESCE(vc.valor_repasse, 0)::NUMERIC AS valor_repasse,
          'venda' AS tipo
        FROM vendas_base vb
        INNER JOIN venda_corretores vc ON vc.venda_id = vb.id

        UNION ALL

        SELECT
          vb.corretor_id,
          vb.id AS venda_id,
          vb.situacao,
          vb.valor_imovel_venda,
          vb.valor_comissao_total,
          COALESCE(vb.valor_repasse_corretor, 0)::NUMERIC AS valor_repasse,
          'venda' AS tipo
        FROM vendas_base vb
        WHERE vb.corretor_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM venda_corretores vc
            WHERE vc.venda_id = vb.id
              AND vc.corretor_id = vb.corretor_id
          )

        UNION ALL

        SELECT
          vb.captador_id AS corretor_id,
          vb.id AS venda_id,
          vb.situacao,
          0::NUMERIC AS valor_imovel_venda,
          0::NUMERIC AS valor_comissao_total,
          COALESCE(vb.valor_captacao, 0)::NUMERIC AS valor_repasse,
          'captacao' AS tipo
        FROM vendas_base vb
        WHERE vb.captacao = 'Sim'
          AND vb.captador_id IS NOT NULL
          AND COALESCE(vb.valor_captacao, 0) > 0

        UNION ALL

        SELECT
          vb.puxador_id AS corretor_id,
          vb.id AS venda_id,
          vb.situacao,
          0::NUMERIC AS valor_imovel_venda,
          0::NUMERIC AS valor_comissao_total,
          COALESCE(vb.valor_fechador, 0)::NUMERIC AS valor_repasse,
          'puxador' AS tipo
        FROM vendas_base vb
        WHERE vb.fechador = 'Sim'
          AND vb.puxador_id IS NOT NULL
          AND COALESCE(vb.valor_fechador, 0) > 0
      )

      SELECT
        u.id AS corretor_id,
        u.nome AS corretor_nome,
        g.nome AS gerente_nome,

        COUNT(v.venda_id) FILTER (WHERE v.tipo = 'venda')::INT AS total_vendas,

        COUNT(v.venda_id) FILTER (
          WHERE v.tipo = 'venda'
            AND (v.situacao = 'Concluído' OR v.situacao = 'Concluido')
        )::INT AS vendas_concluidas,

        COALESCE(SUM(v.valor_imovel_venda) FILTER (WHERE v.tipo = 'venda'), 0)::NUMERIC AS total_vendido,

        COALESCE(SUM(v.valor_comissao_total) FILTER (WHERE v.tipo = 'venda'), 0)::NUMERIC AS total_comissao,

        COALESCE(SUM(v.valor_repasse), 0)::NUMERIC AS total_repasse,

        COALESCE(SUM(pg.total_pago), 0)::NUMERIC AS comissao_paga,

        GREATEST(
          COALESCE(SUM(v.valor_repasse), 0) - COALESCE(SUM(pg.total_pago), 0),
          0
        )::NUMERIC AS comissao_a_receber

      FROM vendedores v
      INNER JOIN usuarios u ON u.id = v.corretor_id
      LEFT JOIN usuarios g ON g.id = u.gerente_id

      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(uc.valor), 0)::NUMERIC AS total_pago
        FROM usuarios_comprovantes uc
        WHERE uc.venda_id = v.venda_id
          AND (uc.usuario_id = v.corretor_id OR uc.corretor_id = v.corretor_id)
      ) pg ON TRUE

      GROUP BY u.id, u.nome, g.nome
      ORDER BY total_repasse DESC, total_vendas DESC
      LIMIT 20
      `,
      params
    );

    return res.json(result.rows.map(row => ({
      corretorId: row.corretor_id,
      corretorNome: row.corretor_nome,
      gerenteNome: row.gerente_nome,
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

router.get('/ranking-captacao', async (req, res) => {
  try {
    const { params, whereSql } = wherePeriodoSql(req, 'v');

    const result = await pool.query(
      `
      WITH vendas_base AS (
        SELECT v.*
        FROM vendas v
        ${whereSql}
      )

      SELECT
        u.id AS captador_id,
        COALESCE(u.nome, vb.captador_nome, vb.captador_parceiro_nome, 'Captação') AS captador_nome,
        g.nome AS gerente_nome,
        COUNT(vb.id)::INT AS total_captacoes,
        COALESCE(SUM(vb.valor_captacao), 0)::NUMERIC AS total_valor_captacao,
        COALESCE(SUM(pg.total_pago), 0)::NUMERIC AS total_pago,

        GREATEST(
          COALESCE(SUM(vb.valor_captacao), 0) - COALESCE(SUM(pg.total_pago), 0),
          0
        )::NUMERIC AS total_pendente

      FROM vendas_base vb
      LEFT JOIN usuarios u ON u.id = vb.captador_id
      LEFT JOIN usuarios g ON g.id = u.gerente_id

      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(uc.valor), 0)::NUMERIC AS total_pago
        FROM usuarios_comprovantes uc
        WHERE uc.venda_id = vb.id
          AND vb.captador_id IS NOT NULL
          AND (uc.usuario_id = vb.captador_id OR uc.corretor_id = vb.captador_id)
      ) pg ON TRUE

      WHERE vb.captacao = 'Sim'
        AND COALESCE(vb.valor_captacao, 0) > 0
        AND (
          vb.captador_id IS NOT NULL
          OR COALESCE(vb.captador_nome, vb.captador_parceiro_nome) IS NOT NULL
        )

      GROUP BY
        u.id,
        COALESCE(u.nome, vb.captador_nome, vb.captador_parceiro_nome, 'Captação'),
        g.nome

      ORDER BY total_valor_captacao DESC, total_captacoes DESC
      LIMIT 20
      `,
      params
    );

    return res.json(result.rows.map(row => ({
      captadorId: row.captador_id,
      captadorNome: row.captador_nome,
      gerenteNome: row.gerente_nome,
      totalCaptacoes: Number(row.total_captacoes || 0),
      totalValorCaptacao: Number(row.total_valor_captacao || 0),
      totalPago: Number(row.total_pago || 0),
      totalPendente: Number(row.total_pendente || 0)
    })));
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: 'Erro ao carregar ranking de captação'
    });
  }
});

router.get('/evolucao-mensal', async (req, res) => {
  try {
    const { params, whereSql } = montarFiltrosDashboard(req, 'v');

    const result = await pool.query(
      `
      SELECT
        TO_CHAR(DATE_TRUNC('month', COALESCE(v.assinatura_ccv, v.created_at)), 'YYYY-MM') AS mes,
        TO_CHAR(DATE_TRUNC('month', COALESCE(v.assinatura_ccv, v.created_at)), 'MM/YYYY') AS mes_label,
        COUNT(*)::INT AS total_vendas,
        COUNT(*) FILTER (WHERE v.situacao = 'Concluído' OR v.situacao = 'Concluido')::INT AS vendas_concluidas,
        COALESCE(SUM(v.valor_imovel_venda), 0)::NUMERIC AS total_vendido,
        COALESCE(SUM(v.valor_comissao_total), 0)::NUMERIC AS total_comissao,
        COALESCE(SUM(v.valor_repasse_corretor), 0)::NUMERIC AS total_repasse_corretor
      FROM vendas v
      ${whereSql}
      GROUP BY DATE_TRUNC('month', COALESCE(v.assinatura_ccv, v.created_at))
      ORDER BY DATE_TRUNC('month', COALESCE(v.assinatura_ccv, v.created_at))
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
    const { params, whereSql } = montarFiltrosDashboard(req, 'v');

    const result = await pool.query(
      `
      SELECT
        COALESCE(NULLIF(TRIM(v.empreendimento_rua), ''), 'Não informado') AS empreendimento,
        COUNT(*)::INT AS total_vendas,
        COALESCE(SUM(v.valor_imovel_venda), 0)::NUMERIC AS total_vendido,
        COALESCE(SUM(v.valor_comissao_total), 0)::NUMERIC AS total_comissao
      FROM vendas v
      ${whereSql}
      GROUP BY COALESCE(NULLIF(TRIM(v.empreendimento_rua), ''), 'Não informado')
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
    const { params, whereSql } = montarFiltrosDashboard(req, 'v');

    const result = await pool.query(
      `
      SELECT
        COALESCE(NULLIF(TRIM(v.modalidade_imovel), ''), 'Não informado') AS modalidade,
        COUNT(*)::INT AS total_vendas,
        COALESCE(SUM(v.valor_imovel_venda), 0)::NUMERIC AS total_vendido,
        COALESCE(SUM(v.valor_comissao_total), 0)::NUMERIC AS total_comissao
      FROM vendas v
      ${whereSql}
      GROUP BY COALESCE(NULLIF(TRIM(v.modalidade_imovel), ''), 'Não informado')
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
    const { params, whereSql } = montarFiltrosDashboard(req, 'v');
    const usuarioParamIndex = params.length + 1;
    const queryParams = [...params, req.user.id];

    const result = await pool.query(
      `
      WITH vendas_base AS (
        SELECT
          v.*,
          DATE_TRUNC('month', COALESCE(v.assinatura_ccv, v.created_at)) AS mes_ref
        FROM vendas v
        ${whereSql}
      ),

      repasses AS (
        SELECT
          vc.venda_id,
          vc.corretor_id,
          COALESCE(vc.valor_repasse, 0)::NUMERIC AS valor_repasse
        FROM venda_corretores vc
        INNER JOIN vendas_base vb ON vb.id = vc.venda_id

        UNION ALL

        SELECT
          vb.id,
          vb.corretor_id,
          COALESCE(vb.valor_repasse_corretor, 0)::NUMERIC
        FROM vendas_base vb
        WHERE vb.corretor_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM venda_corretores vc
            WHERE vc.venda_id = vb.id
              AND vc.corretor_id = vb.corretor_id
          )

        UNION ALL

        SELECT
          vb.id,
          vb.captador_id,
          COALESCE(vb.valor_captacao, 0)::NUMERIC
        FROM vendas_base vb
        WHERE vb.captacao = 'Sim'
          AND vb.captador_id IS NOT NULL

        UNION ALL

        SELECT
          vb.id,
          vb.puxador_id,
          COALESCE(vb.valor_fechador, 0)::NUMERIC
        FROM vendas_base vb
        WHERE vb.fechador = 'Sim'
          AND vb.puxador_id IS NOT NULL
      ),

      repasses_por_venda AS (
        SELECT
          r.venda_id,
          COALESCE(SUM(r.valor_repasse), 0)::NUMERIC AS total_repasse_corretores,
          COALESCE(SUM(r.valor_repasse) FILTER (WHERE r.corretor_id = $${usuarioParamIndex}), 0)::NUMERIC AS repasse_usuario
        FROM repasses r
        GROUP BY r.venda_id
      ),

      pagamentos_por_venda AS (
        SELECT
          uc.venda_id,
          COALESCE(SUM(uc.valor) FILTER (WHERE u.perfil = 'corretor'), 0)::NUMERIC AS pago_corretores,
          COALESCE(SUM(uc.valor) FILTER (WHERE u.perfil = 'gerente'), 0)::NUMERIC AS pago_gerencia,
          COALESCE(SUM(uc.valor) FILTER (WHERE uc.usuario_id = $${usuarioParamIndex} OR uc.corretor_id = $${usuarioParamIndex}), 0)::NUMERIC AS pago_usuario
        FROM usuarios_comprovantes uc
        INNER JOIN vendas_base vb ON vb.id = uc.venda_id
        INNER JOIN usuarios u ON u.id = COALESCE(uc.usuario_id, uc.corretor_id)
        GROUP BY uc.venda_id
      )

      SELECT
        TO_CHAR(vb.mes_ref, 'YYYY-MM') AS mes,
        TO_CHAR(vb.mes_ref, 'MM/YYYY') AS mes_label,
        COALESCE(SUM(COALESCE(rpv.total_repasse_corretores, 0)), 0)::NUMERIC AS total_repasse_corretores,
        COALESCE(SUM(vb.valor_repasse_gerencia), 0)::NUMERIC AS total_repasse_gerencia,
        COALESCE(SUM(COALESCE(rpv.repasse_usuario, 0)), 0)::NUMERIC AS repasse_usuario,
        COALESCE(SUM(COALESCE(ppv.pago_corretores, 0)), 0)::NUMERIC AS pago_corretores,
        COALESCE(SUM(COALESCE(ppv.pago_gerencia, 0)), 0)::NUMERIC AS pago_gerencia,
        COALESCE(SUM(COALESCE(ppv.pago_usuario, 0)), 0)::NUMERIC AS pago_usuario
      FROM vendas_base vb
      LEFT JOIN repasses_por_venda rpv ON rpv.venda_id = vb.id
      LEFT JOIN pagamentos_por_venda ppv ON ppv.venda_id = vb.id
      GROUP BY vb.mes_ref
      ORDER BY vb.mes_ref
      `,
      queryParams
    );

    const perfil = req.user.perfil;

    return res.json(result.rows.map(row => {
      const totalRepasseCorretores = Number(row.total_repasse_corretores || 0);
      const totalRepasseGerencia = Number(row.total_repasse_gerencia || 0);
      const repasseUsuario = Number(row.repasse_usuario || 0);
      const pagoCorretores = Number(row.pago_corretores || 0);
      const pagoGerencia = Number(row.pago_gerencia || 0);
      const pagoUsuario = Number(row.pago_usuario || 0);

      let comissaoTotal = totalRepasseCorretores + totalRepasseGerencia;
      let comissaoPaga = pagoCorretores + pagoGerencia;

      if (perfil === 'gerente') {
        comissaoTotal = totalRepasseGerencia;
        comissaoPaga = pagoUsuario;
      }

      if (perfil === 'corretor') {
        comissaoTotal = repasseUsuario;
        comissaoPaga = pagoUsuario;
      }

      const comissaoPendente = Math.max(comissaoTotal - comissaoPaga, 0);

      return {
        mes: row.mes,
        mesLabel: row.mes_label,
        comissaoPendente,
        comissaoPaga,
        comissaoTotal
      };
    }));
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: 'Erro ao carregar comissões por mês'
    });
  }
});

module.exports = router;