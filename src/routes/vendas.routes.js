const express = require('express');
const pool = require('../config/db');
const { authMiddleware, somentePerfis } = require('../middlewares/auth.middleware');

const router = express.Router();

router.use(authMiddleware);

async function salvarCorretoresVenda(vendaId, corretores = []) {
  await pool.query(
    `
    DELETE FROM venda_corretores
    WHERE venda_id = $1
    `,
    [vendaId]
  );

  const listaValida = corretores
    .filter(item => item.corretorId)
    .slice(0, 2);

  for (let index = 0; index < listaValida.length; index++) {
    const item = listaValida[index];

    const usuarioResult = await pool.query(
      `
      SELECT id, nome
      FROM usuarios
      WHERE id = $1
        AND perfil = 'corretor'
      LIMIT 1
      `,
      [item.corretorId]
    );

    if (!usuarioResult.rows.length) {
      continue;
    }

    const usuario = usuarioResult.rows[0];
    const valorRepasse = Number(item.valorRepasse || 0);

    await pool.query(
      `
      INSERT INTO venda_corretores (
        venda_id,
        corretor_id,
        corretor_nome,
        ordem,
        valor_repasse,
        valor_pago,
        saldo_pendente,
        status_pagamento
      ) VALUES ($1,$2,$3,$4,$5,0,$5,'Pendente')
      ON CONFLICT (venda_id, corretor_id)
      DO UPDATE SET
        corretor_nome = EXCLUDED.corretor_nome,
        ordem = EXCLUDED.ordem,
        valor_repasse = EXCLUDED.valor_repasse,
        saldo_pendente = GREATEST(EXCLUDED.valor_repasse - venda_corretores.valor_pago, 0),
        status_pagamento = CASE
          WHEN venda_corretores.valor_pago <= 0 THEN 'Pendente'
          WHEN venda_corretores.valor_pago < EXCLUDED.valor_repasse THEN 'Parcial'
          ELSE 'Pago'
        END,
        updated_at = NOW()
      `,
      [
        vendaId,
        usuario.id,
        usuario.nome,
        index + 1,
        valorRepasse
      ]
    );
  }

  await sincronizarCamposLegadosVenda(vendaId);
  await recalcularStatusComissaoVendaGeral(vendaId);
}

async function sincronizarCamposLegadosVenda(vendaId) {
  const result = await pool.query(
    `
    SELECT *
    FROM venda_corretores
    WHERE venda_id = $1
    ORDER BY ordem ASC
    `,
    [vendaId]
  );

  const principal = result.rows[0] || null;
  const segundo = result.rows[1] || null;

  const totalRepasse = result.rows.reduce((total, item) => {
    return total + Number(item.valor_repasse || 0);
  }, 0);

  await pool.query(
    `
    UPDATE vendas
    SET
      corretor_id = $1,
      corretor_nome = $2,
      corretor_2_id = $3,
      corretor_2_nome = $4,
      valor_repasse_corretor_2 = $5,
      valor_repasse_corretor = $6
    WHERE id = $7
    `,
    [
      principal?.corretor_id || null,
      principal?.corretor_nome || null,
      segundo?.corretor_id || null,
      segundo?.corretor_nome || null,
      Number(segundo?.valor_repasse || 0),
      totalRepasse,
      vendaId
    ]
  );
}

async function recalcularStatusComissaoVendaGeral(vendaId) {
  if (!vendaId) {
    return;
  }

  const result = await pool.query(
    `
    SELECT
      COALESCE(SUM(vc.valor_repasse), 0)::NUMERIC AS total_repasse,
      COALESCE(SUM(vc.valor_pago), 0)::NUMERIC AS total_pago
    FROM venda_corretores vc
    WHERE vc.venda_id = $1
    `,
    [vendaId]
  );

  const totalRepasse = Number(result.rows[0]?.total_repasse || 0);
  const totalPago = Number(result.rows[0]?.total_pago || 0);

  let status = 'Pendente';
  let dataPagamento = null;

  if (totalPago > 0 && totalPago < totalRepasse) {
    status = 'Parcial';
  }

  if (totalRepasse > 0 && totalPago >= totalRepasse) {
    status = 'Pago';
    dataPagamento = new Date();
  }

  await pool.query(
    `
    UPDATE vendas
    SET
      status_comissao_corretor = $1,
      data_pagamento_comissao = $2
    WHERE id = $3
    `,
    [status, dataPagamento, vendaId]
  );
}

function mapVenda(row) {
  return {
    id: row.id,
    situacao: row.situacao,

    cliente: row.cliente,
    cpfCliente: row.cpf_cliente,
    empreendimentoRua: row.empreendimento_rua,
    numeroUnidade: row.numero_unidade,

    corretorId: row.corretor_id,
    corretor: row.corretor_nome,

    corretor2Id: row.corretor_2_id,
    corretor2: row.corretor_2_nome,
    valorRepasseCorretor2: Number(row.valor_repasse_corretor_2 || 0),

    captacao: row.captacao,
    valorCaptacao: Number(row.valor_captacao || 0),

    valorComissaoTotal: Number(row.valor_comissao_total || 0),

    nota: row.nota,
    valorNota: Number(row.valor_nota || 0),

    assinaturaCcv: row.assinatura_ccv,

    fechador: row.fechador,
    valorFechador: Number(row.valor_fechador || 0),

    irFuturo: row.ir_futuro,

    valorImovelVenda: Number(row.valor_imovel_venda || 0),
    modalidadeImovel: row.modalidade_imovel,

    valorRepasseCorretor: Number(row.valor_repasse_corretor || 0),
    valorRepasseGerencia: Number(row.valor_repasse_gerencia || 0),
    valorRepasseImobiliaria: Number(row.valor_repasse_imobiliaria || 0),

    valorPagoComprovantes: Number(row.valor_pago_comprovantes || 0),
    saldoPendente: Number(row.saldo_pendente || 0),

    documentacaoValorCliente: Number(row.documentacao_valor_cliente || 0),
    documentacaoValorSobra: Number(row.documentacao_valor_sobra || 0),

    statusComissaoCorretor: row.status_comissao_corretor,
    dataPagamentoComissao: row.data_pagamento_comissao,

    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

router.get('/', async (req, res) => {
  try {
    const {
      busca,
      situacao,
      mes,
      dataInicio,
      dataFim,
      corretorId,
      statusComissao
    } = req.query;

    const params = [];
    const where = [];

    if (req.user.perfil === 'corretor') {
      params.push(req.user.id);
      where.push(`
        EXISTS (
          SELECT 1
          FROM venda_corretores vc
          WHERE vc.venda_id = v.id
            AND vc.corretor_id = $${params.length}
        )
      `);
    }

    if (corretorId && ['admin', 'gerente'].includes(req.user.perfil)) {
      params.push(corretorId);
      where.push(`
        EXISTS (
          SELECT 1
          FROM venda_corretores vc
          WHERE vc.venda_id = v.id
            AND vc.corretor_id = $${params.length}
        )
      `);
    }

    if (busca) {
      params.push(`%${String(busca).toLowerCase()}%`);
      where.push(`
        (
          LOWER(v.cliente) LIKE $${params.length}
          OR LOWER(v.cpf_cliente) LIKE $${params.length}
          OR LOWER(v.empreendimento_rua) LIKE $${params.length}
          OR LOWER(v.corretor_nome) LIKE $${params.length}
          OR LOWER(COALESCE(v.corretor_2_nome, '')) LIKE $${params.length}
          OR LOWER(v.numero_unidade) LIKE $${params.length}
        )
      `);
    }

    if (situacao) {
      params.push(situacao);
      where.push(`v.situacao = $${params.length}`);
    }

    if (statusComissao) {
      params.push(statusComissao);
      where.push(`v.status_comissao_corretor = $${params.length}`);
    }

    if (dataInicio) {
      params.push(dataInicio);
      where.push(`v.assinatura_ccv >= $${params.length}`);
    }

    if (dataFim) {
      params.push(dataFim);
      where.push(`v.assinatura_ccv <= $${params.length}`);
    }

    if (mes && !dataInicio && !dataFim) {
      params.push(Number(mes));
      where.push(`EXTRACT(MONTH FROM v.assinatura_ccv) = $${params.length}`);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const result = await pool.query(
      `
      SELECT
        v.*,

        COALESCE((
          SELECT SUM(c.valor)
          FROM usuarios_comprovantes c
          WHERE c.venda_id = v.id
        ), 0)::NUMERIC AS valor_pago_comprovantes,

        GREATEST(
          COALESCE(v.valor_repasse_corretor, 0) - COALESCE((
            SELECT SUM(c.valor)
            FROM usuarios_comprovantes c
            WHERE c.venda_id = v.id
          ), 0),
          0
        )::NUMERIC AS saldo_pendente

      FROM vendas v
      ${whereSql}
      ORDER BY v.assinatura_ccv DESC NULLS LAST, v.created_at DESC
      `,
      params
    );

    return res.json(result.rows.map(mapVenda));
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: 'Erro ao listar vendas'
    });
  }
});

router.post('/', somentePerfis('admin', 'gerente'), async (req, res) => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const body = req.body;

    if (!body.cliente) {
      await client.query('ROLLBACK');

      return res.status(400).json({
        message: 'Cliente é obrigatório'
      });
    }

    const result = await client.query(
      `
      INSERT INTO vendas (
        cliente,
        cpf_cliente,
        empreendimento_rua,
        numero_unidade,
        corretor_id,
        corretor_nome,
        corretor_2_id,
        corretor_2_nome,
        valor_repasse_corretor_2,
        situacao,
        captacao,
        valor_captacao,
        valor_comissao_total,
        nota,
        valor_nota,
        assinatura_ccv,
        fechador,
        valor_fechador,
        ir_futuro,
        valor_imovel_venda,
        modalidade_imovel,
        valor_repasse_corretor,
        valor_repasse_gerencia,
        valor_repasse_imobiliaria,
        documentacao_valor_cliente,
        documentacao_valor_sobra,
        created_by,
        updated_by
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
        $11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
        $21,$22,$23,$24,$25,$26,$27,$28
      )
      RETURNING *
      `,
      [
        body.cliente,
        body.cpfCliente || null,
        body.empreendimentoRua || null,
        body.numeroUnidade || null,
        body.corretorId || null,
        body.corretor || null,
        body.corretor2Id || null,
        body.corretor2 || null,
        body.valorRepasseCorretor2 || 0,
        body.situacao || 'Em processo',
        body.captacao || 'Não',
        body.valorCaptacao || 0,
        body.valorComissaoTotal || 0,
        body.nota || 'Não',
        body.valorNota || 0,
        body.assinaturaCcv || null,
        body.fechador || 'Não',
        body.valorFechador || 0,
        body.irFuturo || 'Não',
        body.valorImovelVenda || 0,
        body.modalidadeImovel || '',
        body.valorRepasseCorretor || 0,
        body.valorRepasseGerencia || 0,
        body.valorRepasseImobiliaria || 0,
        body.documentacaoValorCliente || 0,
        body.documentacaoValorSobra || 0,
        req.user.id,
        req.user.id
      ]
    );

    const vendaCriada = result.rows[0];

    await client.query('COMMIT');

    await salvarCorretoresVenda(vendaCriada.id, [
      {
        corretorId: body.corretorId,
        valorRepasse: body.valorRepasseCorretor
      },
      {
        corretorId: body.corretor2Id,
        valorRepasse: body.valorRepasseCorretor2
      }
    ]);

    const vendaAtualizadaResult = await pool.query(
      `
      SELECT
        v.*,

        COALESCE((
          SELECT SUM(c.valor)
          FROM usuarios_comprovantes c
          WHERE c.venda_id = v.id
        ), 0)::NUMERIC AS valor_pago_comprovantes,

        GREATEST(
          COALESCE(v.valor_repasse_corretor, 0) - COALESCE((
            SELECT SUM(c.valor)
            FROM usuarios_comprovantes c
            WHERE c.venda_id = v.id
          ), 0),
          0
        )::NUMERIC AS saldo_pendente

      FROM vendas v
      WHERE v.id = $1
      `,
      [vendaCriada.id]
    );

    return res.status(201).json(mapVenda(vendaAtualizadaResult.rows[0]));
  } catch (error) {
    await client.query('ROLLBACK');

    console.error(error);

    return res.status(500).json({
      message: 'Erro ao criar venda'
    });
  } finally {
    client.release();
  }
});

router.put('/:id', somentePerfis('admin', 'gerente'), async (req, res) => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const { id } = req.params;
    const body = req.body;

    const result = await client.query(
      `
      UPDATE vendas
      SET cliente = $1,
          cpf_cliente = $2,
          empreendimento_rua = $3,
          numero_unidade = $4,
          corretor_id = $5,
          corretor_nome = $6,
          corretor_2_id = $7,
          corretor_2_nome = $8,
          valor_repasse_corretor_2 = $9,
          situacao = $10,
          captacao = $11,
          valor_captacao = $12,
          valor_comissao_total = $13,
          nota = $14,
          valor_nota = $15,
          assinatura_ccv = $16,
          fechador = $17,
          valor_fechador = $18,
          ir_futuro = $19,
          valor_imovel_venda = $20,
          modalidade_imovel = $21,
          valor_repasse_corretor = $22,
          valor_repasse_gerencia = $23,
          valor_repasse_imobiliaria = $24,
          documentacao_valor_cliente = $25,
          documentacao_valor_sobra = $26,
          updated_by = $27,
          updated_at = NOW()
      WHERE id = $28
      RETURNING *
      `,
      [
        body.cliente,
        body.cpfCliente || null,
        body.empreendimentoRua || null,
        body.numeroUnidade || null,
        body.corretorId || null,
        body.corretor || null,
        body.corretor2Id || null,
        body.corretor2 || null,
        body.valorRepasseCorretor2 || 0,
        body.situacao || 'Em processo',
        body.captacao || 'Não',
        body.valorCaptacao || 0,
        body.valorComissaoTotal || 0,
        body.nota || 'Não',
        body.valorNota || 0,
        body.assinaturaCcv || null,
        body.fechador || 'Não',
        body.valorFechador || 0,
        body.irFuturo || 'Não',
        body.valorImovelVenda || 0,
        body.modalidadeImovel || '',
        body.valorRepasseCorretor || 0,
        body.valorRepasseGerencia || 0,
        body.valorRepasseImobiliaria || 0,
        body.documentacaoValorCliente || 0,
        body.documentacaoValorSobra || 0,
        req.user.id,
        id
      ]
    );

    if (result.rows.length === 0) {
      await client.query('ROLLBACK');

      return res.status(404).json({
        message: 'Venda não encontrada'
      });
    }

    await client.query('COMMIT');

    await salvarCorretoresVenda(id, [
      {
        corretorId: body.corretorId,
        valorRepasse: body.valorRepasseCorretor
      },
      {
        corretorId: body.corretor2Id,
        valorRepasse: body.valorRepasseCorretor2
      }
    ]);

    const vendaAtualizadaResult = await pool.query(
      `
      SELECT
        v.*,

        COALESCE((
          SELECT SUM(c.valor)
          FROM usuarios_comprovantes c
          WHERE c.venda_id = v.id
        ), 0)::NUMERIC AS valor_pago_comprovantes,

        GREATEST(
          COALESCE(v.valor_repasse_corretor, 0) - COALESCE((
            SELECT SUM(c.valor)
            FROM usuarios_comprovantes c
            WHERE c.venda_id = v.id
          ), 0),
          0
        )::NUMERIC AS saldo_pendente

      FROM vendas v
      WHERE v.id = $1
      `,
      [id]
    );

    return res.json(mapVenda(vendaAtualizadaResult.rows[0]));
  } catch (error) {
    await client.query('ROLLBACK');

    console.error(error);

    return res.status(500).json({
      message: 'Erro ao atualizar venda'
    });
  } finally {
    client.release();
  }
});

router.patch('/:id/pagar-comissao', somentePerfis('admin', 'gerente'), async (req, res) => {
  try {
    const { id } = req.params;

    const vendaResult = await pool.query(
      `
      SELECT *
      FROM vendas
      WHERE id = $1
      LIMIT 1
      `,
      [id]
    );

    if (!vendaResult.rows.length) {
      return res.status(404).json({
        message: 'Venda não encontrada'
      });
    }

    return res.status(400).json({
      message: 'Use o lançamento de pagamento pelo histórico. Esta rota antiga não deve mais ser usada.'
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: 'Erro ao marcar comissão como paga'
    });
  }
});

router.delete('/:id', somentePerfis('admin', 'gerente'), async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `
      DELETE FROM vendas
      WHERE id = $1
      RETURNING id
      `,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        message: 'Venda não encontrada'
      });
    }

    return res.json({
      message: 'Venda removida com sucesso'
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: 'Erro ao remover venda'
    });
  }
});

module.exports = router;