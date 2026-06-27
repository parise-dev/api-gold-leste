const express = require('express');
const pool = require('../config/db');
const { authMiddleware, somentePerfis } = require('../middlewares/auth.middleware');

const router = express.Router();

router.use(authMiddleware);

function normalizarSituacao(situacao) {
  return situacao || 'Em processo';
}

function montarFiltroEscopo(req, params, alias = 'v') {
  const where = [];
  const prefixo = alias ? `${alias}.` : '';

  if (req.user.perfil === 'corretor') {
    params.push(req.user.id);
    const idx = params.length;

    where.push(`
      (
        ${prefixo}corretor_id = $${idx}
        OR EXISTS (
          SELECT 1
          FROM venda_corretores vc_escopo
          WHERE vc_escopo.venda_id = ${prefixo}id
            AND vc_escopo.corretor_id = $${idx}
        )
      )
    `);
  }

  if (req.user.perfil === 'gerente') {
    params.push(req.user.id);
    const idx = params.length;

    where.push(`
      (
        EXISTS (
          SELECT 1
          FROM usuarios c_escopo
          WHERE c_escopo.id = ${prefixo}corretor_id
            AND c_escopo.gerente_id = $${idx}
        )
        OR EXISTS (
          SELECT 1
          FROM venda_corretores vc_escopo
          INNER JOIN usuarios c_escopo ON c_escopo.id = vc_escopo.corretor_id
          WHERE vc_escopo.venda_id = ${prefixo}id
            AND c_escopo.gerente_id = $${idx}
        )
      )
    `);
  }

  return where;
}

async function vendaPertenceAoEscopo(req, vendaId) {
  if (req.user.perfil === 'admin') {
    return true;
  }

  const params = [vendaId];
  const where = [`v.id = $1`];
  where.push(...montarFiltroEscopo(req, params, 'v'));

  const result = await pool.query(
    `
    SELECT 1
    FROM vendas v
    WHERE ${where.join(' AND ')}
    LIMIT 1
    `,
    params
  );

  return result.rows.length > 0;
}

async function validarCorretoresParaUsuario(req, corretores = []) {
  const ids = corretores
    .map(item => item?.corretorId)
    .filter(Boolean)
    .map(String);

  if (!ids.length) {
    return {
      ok: true
    };
  }

  if (req.user.perfil === 'admin') {
    return {
      ok: true
    };
  }

  const result = await pool.query(
    `
    SELECT id
    FROM usuarios
    WHERE perfil = 'corretor'
      AND gerente_id = $1
      AND id = ANY($2::uuid[])
    `,
    [req.user.id, ids]
  );

  if (result.rows.length !== ids.length) {
    return {
      ok: false,
      message: 'Gerente só pode movimentar vendas de corretores da própria equipe'
    };
  }

  return {
    ok: true
  };
}

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

function mapVenda(row, req) {
  const isCorretor = req?.user?.perfil === 'corretor';

  if (isCorretor) {
    return {
      id: row.id,
      situacao: normalizarSituacao(row.situacao),

      cliente: row.cliente,
      cpfCliente: row.cpf_cliente,
      empreendimentoRua: row.empreendimento_rua,
      numeroUnidade: row.numero_unidade,

      corretorId: row.usuario_corretor_id || row.corretor_id,
      corretor: row.usuario_corretor_nome || row.corretor_nome || 'Corretor',

      corretor2Id: null,
      corretor2: '',
      valorRepasseCorretor2: 0,

      captacao: '',
      valorCaptacao: 0,

      valorComissaoTotal: Number(row.valor_repasse_usuario || 0),

      nota: '',
      valorNota: 0,

      assinaturaCcv: row.assinatura_ccv,

      fechador: '',
      valorFechador: 0,

      irFuturo: row.ir_futuro,

      valorImovelVenda: Number(row.valor_imovel_venda || 0),
      modalidadeImovel: row.modalidade_imovel,

      valorRepasseCorretor: Number(row.valor_repasse_usuario || 0),
      valorRepasseGerencia: 0,
      valorRepasseImobiliaria: 0,

      valorPagoComprovantes: Number(row.valor_pago_usuario || 0),
      saldoPendente: Number(row.saldo_pendente_usuario || 0),

      documentacaoValorCliente: 0,
      documentacaoValorSobra: 0,

      statusComissaoCorretor: row.status_pagamento_usuario || row.status_comissao_corretor,
      dataPagamentoComissao: row.data_pagamento_comissao,

      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  return {
    id: row.id,
    situacao: normalizarSituacao(row.situacao),

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

    where.push(...montarFiltroEscopo(req, params, 'v'));

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
      const situacaoNormalizada = normalizarSituacao(situacao);
      params.push(situacaoNormalizada);

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

    const usuarioParamIndex = params.length + 1;
    const queryParams = [...params, req.user.id];
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const result = await pool.query(
      `
      SELECT
        v.*,

        pu.corretor_id AS usuario_corretor_id,
        pu.corretor_nome AS usuario_corretor_nome,
        COALESCE(pu.valor_repasse, 0)::NUMERIC AS valor_repasse_usuario,
        COALESCE(pu.valor_pago, 0)::NUMERIC AS valor_pago_usuario,
        COALESCE(pu.saldo_pendente, 0)::NUMERIC AS saldo_pendente_usuario,
        pu.status_pagamento AS status_pagamento_usuario,

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
              AND EXISTS (
                SELECT 1
                FROM usuarios u
                WHERE u.id = COALESCE(c.usuario_id, c.corretor_id)
                  AND u.perfil = 'corretor'
              )
          ), 0),
          0
        )::NUMERIC AS saldo_pendente

      FROM vendas v
      LEFT JOIN LATERAL (
        SELECT
          vc.corretor_id,
          vc.corretor_nome,
          vc.valor_repasse,
          vc.valor_pago,
          vc.saldo_pendente,
          vc.status_pagamento
        FROM venda_corretores vc
        WHERE vc.venda_id = v.id
          AND vc.corretor_id = $${usuarioParamIndex}

        UNION ALL

        SELECT
          v.corretor_id,
          v.corretor_nome,
          COALESCE(v.valor_repasse_corretor, 0)::NUMERIC,
          COALESCE((
            SELECT SUM(c.valor)
            FROM usuarios_comprovantes c
            WHERE c.venda_id = v.id
              AND (c.usuario_id = $${usuarioParamIndex} OR c.corretor_id = $${usuarioParamIndex})
          ), 0)::NUMERIC,
          GREATEST(
            COALESCE(v.valor_repasse_corretor, 0) - COALESCE((
              SELECT SUM(c.valor)
              FROM usuarios_comprovantes c
              WHERE c.venda_id = v.id
                AND (c.usuario_id = $${usuarioParamIndex} OR c.corretor_id = $${usuarioParamIndex})
            ), 0),
            0
          )::NUMERIC,
          v.status_comissao_corretor
        WHERE v.corretor_id = $${usuarioParamIndex}
          AND NOT EXISTS (
            SELECT 1
            FROM venda_corretores vc2
            WHERE vc2.venda_id = v.id
              AND vc2.corretor_id = $${usuarioParamIndex}
          )
        LIMIT 1
      ) pu ON TRUE
      ${whereSql}
      ORDER BY v.assinatura_ccv DESC NULLS LAST, v.created_at DESC
      `,
      queryParams
    );

    return res.json(result.rows.map(row => mapVenda(row, req)));
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
    const body = req.body;

    if (!body.cliente) {
      return res.status(400).json({
        message: 'Cliente é obrigatório'
      });
    }

    const permissaoCorretores = await validarCorretoresParaUsuario(req, [
      {
        corretorId: body.corretorId
      },
      {
        corretorId: body.corretor2Id
      }
    ]);

    if (!permissaoCorretores.ok) {
      return res.status(403).json({
        message: permissaoCorretores.message
      });
    }

    await client.query('BEGIN');

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
        normalizarSituacao(body.situacao),
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
        0::NUMERIC AS valor_pago_comprovantes,
        0::NUMERIC AS saldo_pendente
      FROM vendas v
      WHERE v.id = $1
      `,
      [vendaCriada.id]
    );

    return res.status(201).json(mapVenda(vendaAtualizadaResult.rows[0], req));
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
    const { id } = req.params;
    const body = req.body;

    const pertence = await vendaPertenceAoEscopo(req, id);

    if (!pertence) {
      return res.status(403).json({
        message: 'Você não tem permissão para editar esta venda'
      });
    }

    const permissaoCorretores = await validarCorretoresParaUsuario(req, [
      {
        corretorId: body.corretorId
      },
      {
        corretorId: body.corretor2Id
      }
    ]);

    if (!permissaoCorretores.ok) {
      return res.status(403).json({
        message: permissaoCorretores.message
      });
    }

    await client.query('BEGIN');

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
        normalizarSituacao(body.situacao),
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
        0::NUMERIC AS saldo_pendente
      FROM vendas v
      WHERE v.id = $1
      `,
      [id]
    );

    return res.json(mapVenda(vendaAtualizadaResult.rows[0], req));
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
    const pertence = await vendaPertenceAoEscopo(req, id);

    if (!pertence) {
      return res.status(403).json({
        message: 'Você não tem permissão para lançar pagamento nesta venda'
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

router.delete('/:id', somentePerfis('admin'), async (req, res) => {
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