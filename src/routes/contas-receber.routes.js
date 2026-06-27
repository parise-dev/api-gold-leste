const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const pool = require('../config/db');
const { authMiddleware, somentePerfis } = require('../middlewares/auth.middleware');

const router = express.Router();

router.use(authMiddleware);
router.use(somentePerfis('admin'));

const comprovantesDir = path.join(__dirname, '..', '..', 'uploads', 'contas-receber');

if (!fs.existsSync(comprovantesDir)) {
  fs.mkdirSync(comprovantesDir, { recursive: true });
}

const storageComprovantes = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, comprovantesDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);

    const nomeSeguro = file.originalname
      .replace(ext, '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9]/g, '-')
      .replace(/-+/g, '-')
      .toLowerCase();

    cb(null, `${Date.now()}-${nomeSeguro}${ext}`);
  }
});

const uploadComprovante = multer({
  storage: storageComprovantes,
  limits: {
    fileSize: 10 * 1024 * 1024
  },
  fileFilter: (req, file, cb) => {
    const tiposPermitidos = [
      'application/pdf',
      'image/jpeg',
      'image/png',
      'image/webp'
    ];

    if (!tiposPermitidos.includes(file.mimetype)) {
      return cb(new Error('Arquivo inválido. Envie PDF, JPG, PNG ou WEBP.'));
    }

    cb(null, true);
  }
});

function statusApiParaBanco(status) {
  if (status === 'PAGO' || status === 'PAID' || status === 'Recebido') {
    return 'Recebido';
  }

  if (status === 'PARCIAL' || status === 'PARTIAL' || status === 'Parcial') {
    return 'Parcial';
  }

  if (status === 'CANCELADO' || status === 'CANCELLED' || status === 'Cancelado') {
    return 'Cancelado';
  }

  return 'Parcial';
}

function statusBancoParaApi(status) {
  if (status === 'Recebido') {
    return 'PAGO';
  }

  if (status === 'Cancelado') {
    return 'CANCELADO';
  }

  return 'PARCIAL';
}

function valorTotalReceberSql(alias = 'v') {
  return `
    COALESCE(${alias}.valor_comissao_total, 0)
  `;
}

function montarFiltrosRecebimentos(req) {
  const params = [];
  const where = [];

  const {
    paidFrom,
    paidTo,
    dataInicio,
    dataFim,
    status,
    category,
    branchId,
    search,
    vendaId
  } = req.query;

  const dataPagamentoInicio = paidFrom || dataInicio;
  const dataPagamentoFim = paidTo || dataFim;

  if (dataPagamentoInicio) {
    params.push(dataPagamentoInicio);
    where.push(`cr.data_recebimento >= $${params.length}`);
  }

  if (dataPagamentoFim) {
    params.push(dataPagamentoFim);
    where.push(`cr.data_recebimento <= $${params.length}`);
  }

  if (status) {
    params.push(statusApiParaBanco(status));
    where.push(`cr.status = $${params.length}`);
  }

  if (category) {
    params.push(category);
    where.push(`cr.categoria = $${params.length}`);
  }

  if (branchId) {
    params.push(branchId);
    where.push(`cr.filial_id = $${params.length}`);
  }

  if (vendaId) {
    params.push(vendaId);
    where.push(`cr.venda_id = $${params.length}`);
  }

  if (search) {
    params.push(`%${String(search).toLowerCase()}%`);

    where.push(`
      (
        LOWER(COALESCE(v.cliente, '')) LIKE $${params.length}
        OR LOWER(COALESCE(v.empreendimento_rua, '')) LIKE $${params.length}
        OR LOWER(COALESCE(v.numero_unidade, '')) LIKE $${params.length}
        OR LOWER(COALESCE(cr.observacoes, '')) LIKE $${params.length}
        OR LOWER(COALESCE(cr.forma_pagamento, '')) LIKE $${params.length}
      )
    `);
  }

  return {
    params,
    whereSql: where.length ? `WHERE ${where.join(' AND ')}` : ''
  };
}

function mapRecebimento(row) {
  return {
    id: row.id,

    vendaId: row.venda_id,
    saleId: row.venda_id,

    filialId: row.filial_id,
    branchId: row.filial_id,
    filialNome: row.filial_nome,

    vendaCliente: row.venda_cliente,
    empreendimentoRua: row.empreendimento_rua,
    numeroUnidade: row.numero_unidade,

    descricao: row.descricao,
    description: row.descricao,

    dataPagamento: row.data_recebimento,
    paidDate: row.data_recebimento,

    dataCompetencia: row.data_competencia,
    competenceDate: row.data_competencia,

    dataVencimento: row.data_vencimento,
    dueDate: row.data_vencimento,

    createdAt: row.created_at,

    categoria: row.categoria,
    category: row.categoria,

    status: statusBancoParaApi(row.status),
    statusLabel: row.status,

    valorTotal: Number(row.valor_total || row.valor_total_receber || 0),
    totalAmount: Number(row.valor_total || row.valor_total_receber || 0),

    valorRecebido: Number(row.valor_recebido || 0),
    receivedAmount: Number(row.valor_recebido || 0),
    amount: Number(row.valor_recebido || 0),

    valorComissaoImobiliaria: Number(row.valor_total_receber || row.valor_total || 0),
    saleCommissionAmount: Number(row.valor_total_receber || row.valor_total || 0),

    valorPendenteVenda: Number(row.valor_pendente || 0),
    pendingAmount: Number(row.valor_pendente || 0),

    formaPagamento: row.forma_pagamento,
    paymentMethod: row.forma_pagamento,

    observacoes: row.observacoes,
    observations: row.observacoes,

    arquivoNome: row.arquivo_nome,
    arquivoUrl: row.arquivo_url,
    arquivoMime: row.arquivo_mime,
    arquivoTamanho: row.arquivo_tamanho
  };
}

async function buscarRecebimentoPorId(id) {
  const result = await pool.query(
    `
    SELECT
      cr.*,
      f.nome AS filial_nome,
      v.cliente AS venda_cliente,
      v.empreendimento_rua,
      v.numero_unidade,
      (${valorTotalReceberSql('v')})::NUMERIC AS valor_total_receber
    FROM contas_receber cr
    LEFT JOIN vendas v ON v.id = cr.venda_id
    LEFT JOIN filiais f ON f.id = cr.filial_id
    WHERE cr.id = $1
    LIMIT 1
    `,
    [id]
  );

  return result.rows[0] || null;
}

router.get('/summary', async (req, res) => {
  try {
    const result = await pool.query(
      `
      WITH vendas_base AS (
        SELECT
          v.id,
          (${valorTotalReceberSql('v')})::NUMERIC AS valor_total_receber
        FROM vendas v
      ),
      recebimentos AS (
        SELECT
          cr.venda_id,
          COALESCE(SUM(cr.valor_recebido), 0)::NUMERIC AS valor_recebido
        FROM contas_receber cr
        INNER JOIN vendas_base vb ON vb.id = cr.venda_id
        WHERE cr.status IN ('Recebido', 'Parcial')
        GROUP BY cr.venda_id
      )
      SELECT
        COALESCE(SUM(vb.valor_total_receber), 0)::NUMERIC AS total_a_receber,

        COALESCE(SUM(COALESCE(r.valor_recebido, 0)), 0)::NUMERIC AS total_recebido,

        GREATEST(
          COALESCE(SUM(vb.valor_total_receber), 0)
          - COALESCE(SUM(COALESCE(r.valor_recebido, 0)), 0),
          0
        )::NUMERIC AS total_falta_receber,

        COUNT(*) FILTER (
          WHERE GREATEST(vb.valor_total_receber - COALESCE(r.valor_recebido, 0), 0) > 0
        )::INT AS vendas_com_saldo
      FROM vendas_base vb
      LEFT JOIN recebimentos r ON r.venda_id = vb.id
      `
    );

    const row = result.rows[0];

    return res.json({
      totalAReceber: Number(row.total_a_receber || 0),
      totalRecebido: Number(row.total_recebido || 0),
      totalFaltaReceber: Number(row.total_falta_receber || 0),
      vendasComSaldo: Number(row.vendas_com_saldo || 0)
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: 'Erro ao carregar resumo do contas a receber'
    });
  }
});

router.get('/vendas-pendentes', async (req, res) => {
  try {
    const result = await pool.query(
      `
      WITH vendas_base AS (
        SELECT
          v.id,
          v.cliente,
          v.empreendimento_rua,
          v.numero_unidade,
          v.assinatura_ccv,
          (${valorTotalReceberSql('v')})::NUMERIC AS valor_total_receber
        FROM vendas v
      ),
      recebimentos AS (
        SELECT
          cr.venda_id,
          COALESCE(SUM(cr.valor_recebido), 0)::NUMERIC AS valor_recebido
        FROM contas_receber cr
        WHERE cr.status IN ('Recebido', 'Parcial')
        GROUP BY cr.venda_id
      )
      SELECT
        vb.*,
        COALESCE(r.valor_recebido, 0)::NUMERIC AS valor_recebido_imobiliaria,
        GREATEST(vb.valor_total_receber - COALESCE(r.valor_recebido, 0), 0)::NUMERIC AS saldo_total_receber
      FROM vendas_base vb
      LEFT JOIN recebimentos r ON r.venda_id = vb.id
      WHERE GREATEST(vb.valor_total_receber - COALESCE(r.valor_recebido, 0), 0) > 0
      ORDER BY vb.assinatura_ccv DESC NULLS LAST, vb.cliente ASC
      `
    );

    return res.json(result.rows.map(row => ({
      id: row.id,
      cliente: row.cliente,
      empreendimentoRua: row.empreendimento_rua,
      numeroUnidade: row.numero_unidade,
      assinaturaCcv: row.assinatura_ccv,

      valorComissaoImobiliaria: Number(row.valor_total_receber || 0),
      valorRecebidoImobiliaria: Number(row.valor_recebido_imobiliaria || 0),
      saldoComissaoImobiliaria: Number(row.saldo_total_receber || 0)
    })));
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: 'Erro ao listar vendas pendentes'
    });
  }
});

router.get('/', async (req, res) => {
  try {
    const page = Number(req.query.page || 1);
    const pageSize = Number(req.query.pageSize || 50);
    const offset = (page - 1) * pageSize;

    const { params, whereSql } = montarFiltrosRecebimentos(req);

    const countResult = await pool.query(
      `
      SELECT COUNT(*)::INT AS total
      FROM contas_receber cr
      LEFT JOIN vendas v ON v.id = cr.venda_id
      LEFT JOIN filiais f ON f.id = cr.filial_id
      ${whereSql}
      `,
      params
    );

    const listResult = await pool.query(
      `
      WITH recebidos_venda AS (
        SELECT
          venda_id,
          COALESCE(SUM(valor_recebido), 0)::NUMERIC AS total_recebido
        FROM contas_receber
        WHERE status IN ('Recebido', 'Parcial')
        GROUP BY venda_id
      )
      SELECT
        cr.*,
        f.nome AS filial_nome,
        v.cliente AS venda_cliente,
        v.empreendimento_rua,
        v.numero_unidade,
        (${valorTotalReceberSql('v')})::NUMERIC AS valor_total_receber,

        GREATEST(
          (${valorTotalReceberSql('v')}) - COALESCE(rv.total_recebido, 0),
          0
        )::NUMERIC AS valor_pendente

      FROM contas_receber cr
      LEFT JOIN vendas v ON v.id = cr.venda_id
      LEFT JOIN filiais f ON f.id = cr.filial_id
      LEFT JOIN recebidos_venda rv ON rv.venda_id = cr.venda_id
      ${whereSql}
      ORDER BY cr.data_recebimento DESC NULLS LAST, cr.created_at DESC
      LIMIT $${params.length + 1}
      OFFSET $${params.length + 2}
      `,
      [...params, pageSize, offset]
    );

    return res.json({
      items: listResult.rows.map(mapRecebimento),
      total: Number(countResult.rows[0]?.total || 0)
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: 'Erro ao listar recebimentos'
    });
  }
});

router.post('/', uploadComprovante.single('arquivo'), async (req, res) => {
  try {
    const vendaId = req.body.vendaId || req.body.saleId;
    const filialId = req.body.filialId || req.body.branchId || null;

    const categoria = req.body.categoria || req.body.category || 'COMISSAO';

    const valorRecebido = Number(
      req.body.valorRecebido ||
      req.body.receivedAmount ||
      req.body.amount ||
      req.body.valor ||
      0
    );

    const dataRecebimento =
      req.body.dataPagamento ||
      req.body.dataRecebimento ||
      req.body.paidDate ||
      null;

    const formaPagamento =
      req.body.formaPagamento ||
      req.body.paymentMethod ||
      null;

    const observacoes =
      req.body.observacoes ||
      req.body.observations ||
      null;

    if (!vendaId) {
      return res.status(400).json({
        message: 'Selecione uma venda'
      });
    }

    if (!valorRecebido || valorRecebido <= 0) {
      return res.status(400).json({
        message: 'Informe o valor recebido'
      });
    }

    if (!dataRecebimento) {
      return res.status(400).json({
        message: 'Informe a data do pagamento'
      });
    }

    const vendaResult = await pool.query(
      `
      SELECT
        v.id,
        v.cliente,
        v.empreendimento_rua,
        v.numero_unidade,
        (${valorTotalReceberSql('v')})::NUMERIC AS valor_total_receber
      FROM vendas v
      WHERE v.id = $1
      LIMIT 1
      `,
      [vendaId]
    );

    if (!vendaResult.rows.length) {
      return res.status(404).json({
        message: 'Venda não encontrada'
      });
    }

    const venda = vendaResult.rows[0];
    const valorTotalReceber = Number(venda.valor_total_receber || 0);

    const recebidosResult = await pool.query(
      `
      SELECT COALESCE(SUM(valor_recebido), 0)::NUMERIC AS total_recebido
      FROM contas_receber
      WHERE venda_id = $1
        AND status IN ('Recebido', 'Parcial')
      `,
      [vendaId]
    );

    const totalRecebidoAntes = Number(recebidosResult.rows[0]?.total_recebido || 0);
    const saldoAntes = Math.max(valorTotalReceber - totalRecebidoAntes, 0);

    if (saldoAntes <= 0) {
      return res.status(400).json({
        message: 'Essa venda já está totalmente recebida'
      });
    }

    if (valorRecebido > saldoAntes) {
      return res.status(400).json({
        message: `O valor recebido não pode ser maior que o saldo pendente da venda. Saldo atual: R$ ${saldoAntes.toFixed(2)}`
      });
    }

    const saldoDepois = Math.max(saldoAntes - valorRecebido, 0);
    const statusFinal = saldoDepois <= 0 ? 'Recebido' : 'Parcial';

    const arquivoUrl = req.file
      ? `/uploads/contas-receber/${req.file.filename}`
      : null;

    const descricao = [
      'Recebimento de comissão total',
      venda.cliente,
      venda.empreendimento_rua,
      venda.numero_unidade ? `Unidade ${venda.numero_unidade}` : ''
    ]
      .filter(Boolean)
      .join(' - ');

    const insertResult = await pool.query(
      `
      INSERT INTO contas_receber (
        venda_id,
        filial_id,
        descricao,
        categoria,
        valor_total,
        valor_recebido,
        valor_pendente,
        data_competencia,
        data_vencimento,
        data_recebimento,
        status,
        forma_pagamento,
        observacoes,
        arquivo_nome,
        arquivo_url,
        arquivo_mime,
        arquivo_tamanho,
        criado_por,
        atualizado_por,
        created_at,
        updated_at
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,NULL,$9,
        $10,$11,$12,$13,$14,$15,$16,$17,$18,NOW(),NOW()
      )
      RETURNING id
      `,
      [
        vendaId,
        filialId,
        descricao,
        categoria,
        valorTotalReceber,
        valorRecebido,
        saldoDepois,
        dataRecebimento,
        dataRecebimento,
        statusFinal,
        formaPagamento,
        observacoes,
        req.file ? req.file.originalname : null,
        arquivoUrl,
        req.file ? req.file.mimetype : null,
        req.file ? req.file.size : null,
        req.user.id,
        req.user.id
      ]
    );

    const recebimento = await buscarRecebimentoPorId(insertResult.rows[0].id);

    return res.status(201).json(mapRecebimento(recebimento));
  } catch (error) {
    console.error('ERRO AO CRIAR RECEBIMENTO:', error);

    return res.status(500).json({
      message: error?.message || 'Erro ao criar recebimento'
    });
  }
});

router.put('/:id', uploadComprovante.single('arquivo'), async (req, res) => {
  try {
    const { id } = req.params;

    const recebimentoAtual = await buscarRecebimentoPorId(id);

    if (!recebimentoAtual) {
      return res.status(404).json({
        message: 'Recebimento não encontrado'
      });
    }

    const valorRecebido = Number(
      req.body.valorRecebido ||
      req.body.receivedAmount ||
      req.body.amount ||
      req.body.valor ||
      recebimentoAtual.valor_recebido ||
      0
    );

    const dataRecebimento =
      req.body.dataPagamento ||
      req.body.dataRecebimento ||
      req.body.paidDate ||
      recebimentoAtual.data_recebimento;

    const status = statusApiParaBanco(req.body.status || recebimentoAtual.status);
    const categoria = req.body.categoria || req.body.category || recebimentoAtual.categoria;
    const formaPagamento = req.body.formaPagamento || req.body.paymentMethod || recebimentoAtual.forma_pagamento;
    const observacoes = req.body.observacoes || req.body.observations || recebimentoAtual.observacoes;

    let arquivoNome = recebimentoAtual.arquivo_nome;
    let arquivoUrl = recebimentoAtual.arquivo_url;
    let arquivoMime = recebimentoAtual.arquivo_mime;
    let arquivoTamanho = recebimentoAtual.arquivo_tamanho;

    if (req.file) {
      if (arquivoUrl) {
        const caminhoAntigo = path.join(
          __dirname,
          '..',
          '..',
          arquivoUrl.replace(/^\/+/, '')
        );

        if (fs.existsSync(caminhoAntigo)) {
          fs.unlinkSync(caminhoAntigo);
        }
      }

      arquivoNome = req.file.originalname;
      arquivoUrl = `/uploads/contas-receber/${req.file.filename}`;
      arquivoMime = req.file.mimetype;
      arquivoTamanho = req.file.size;
    }

    const result = await pool.query(
      `
      UPDATE contas_receber
      SET
        data_recebimento = $1,
        categoria = $2,
        status = $3,
        valor_recebido = $4,
        forma_pagamento = $5,
        observacoes = $6,
        arquivo_nome = $7,
        arquivo_url = $8,
        arquivo_mime = $9,
        arquivo_tamanho = $10,
        atualizado_por = $11,
        updated_at = NOW()
      WHERE id = $12
      RETURNING id
      `,
      [
        dataRecebimento,
        categoria,
        status,
        valorRecebido,
        formaPagamento,
        observacoes,
        arquivoNome,
        arquivoUrl,
        arquivoMime,
        arquivoTamanho,
        req.user.id,
        id
      ]
    );

    const recebimento = await buscarRecebimentoPorId(result.rows[0].id);

    return res.json(mapRecebimento(recebimento));
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: 'Erro ao atualizar recebimento'
    });
  }
});

router.patch('/:id/receber', async (req, res) => {
  try {
    const { id } = req.params;

    const dataRecebimento =
      req.body.dataRecebimento ||
      req.body.receivedDate ||
      req.body.dataPagamento ||
      new Date().toISOString().slice(0, 10);

    const valorRecebido = Number(
      req.body.valorRecebido ||
      req.body.receivedAmount ||
      req.body.amount ||
      req.body.valor ||
      0
    );

    const recebimentoAtual = await buscarRecebimentoPorId(id);

    if (!recebimentoAtual) {
      return res.status(404).json({
        message: 'Recebimento não encontrado'
      });
    }

    const result = await pool.query(
      `
      UPDATE contas_receber
      SET
        data_recebimento = $1,
        valor_recebido = CASE WHEN $2 > 0 THEN $2 ELSE valor_recebido END,
        status = 'Recebido',
        atualizado_por = $3,
        updated_at = NOW()
      WHERE id = $4
      RETURNING id
      `,
      [
        dataRecebimento,
        valorRecebido,
        req.user.id,
        id
      ]
    );

    const recebimento = await buscarRecebimentoPorId(result.rows[0].id);

    return res.json(mapRecebimento(recebimento));
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: 'Erro ao confirmar recebimento'
    });
  }
});

router.get('/export/excel', async (req, res) => {
  try {
    const { params, whereSql } = montarFiltrosRecebimentos(req);

    const result = await pool.query(
      `
      SELECT
        cr.data_recebimento,
        cr.categoria,
        cr.status,
        cr.valor_recebido,
        cr.valor_pendente,
        cr.forma_pagamento,
        cr.observacoes,
        cr.arquivo_url,
        f.nome AS filial_nome,
        v.cliente AS venda_cliente,
        v.empreendimento_rua,
        v.numero_unidade
      FROM contas_receber cr
      LEFT JOIN vendas v ON v.id = cr.venda_id
      LEFT JOIN filiais f ON f.id = cr.filial_id
      ${whereSql}
      ORDER BY cr.data_recebimento DESC NULLS LAST, cr.created_at DESC
      `,
      params
    );

    const headers = [
      'Data Pagamento',
      'Cliente',
      'Empreendimento',
      'Unidade',
      'Filial',
      'Categoria',
      'Status',
      'Valor Recebido',
      'Saldo da Venda',
      'Forma Pagamento',
      'Observacoes',
      'Comprovante'
    ];

    const linhas = result.rows.map((row) => [
      row.data_recebimento ? String(row.data_recebimento).slice(0, 10) : '',
      row.venda_cliente || '',
      row.empreendimento_rua || '',
      row.numero_unidade || '',
      row.filial_nome || '',
      row.categoria || '',
      row.status || '',
      Number(row.valor_recebido || 0).toFixed(2),
      Number(row.valor_pendente || 0).toFixed(2),
      row.forma_pagamento || '',
      row.observacoes || '',
      row.arquivo_url || ''
    ]);

    const csv = [
      headers.join(';'),
      ...linhas.map((linha) =>
        linha
          .map((campo) => `"${String(campo).replace(/"/g, '""')}"`)
          .join(';')
      )
    ].join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="recebimentos-imobiliaria.csv"');

    return res.send('\uFEFF' + csv);
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: 'Erro ao exportar recebimentos'
    });
  }
});

router.get('/export/pdf', async (req, res) => {
  try {
    const { params, whereSql } = montarFiltrosRecebimentos(req);

    const result = await pool.query(
      `
      SELECT
        cr.data_recebimento,
        cr.categoria,
        cr.status,
        cr.valor_recebido,
        cr.valor_pendente,
        cr.forma_pagamento,
        cr.observacoes,
        v.cliente AS venda_cliente,
        v.empreendimento_rua,
        v.numero_unidade
      FROM contas_receber cr
      LEFT JOIN vendas v ON v.id = cr.venda_id
      LEFT JOIN filiais f ON f.id = cr.filial_id
      ${whereSql}
      ORDER BY cr.data_recebimento DESC NULLS LAST, cr.created_at DESC
      `,
      params
    );

    const linhasHtml = result.rows.map((row) => {
      return `
        <tr>
          <td>${row.data_recebimento ? String(row.data_recebimento).slice(0, 10) : '-'}</td>
          <td>${row.venda_cliente || '-'}</td>
          <td>${row.empreendimento_rua || '-'}</td>
          <td>${row.numero_unidade || '-'}</td>
          <td>${row.categoria || '-'}</td>
          <td>${row.status || '-'}</td>
          <td>R$ ${Number(row.valor_recebido || 0).toFixed(2)}</td>
          <td>R$ ${Number(row.valor_pendente || 0).toFixed(2)}</td>
        </tr>
      `;
    }).join('');

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8" />
        <title>Recebimentos da Imobiliária</title>
        <style>
          body {
            font-family: Arial, sans-serif;
            padding: 24px;
            color: #222;
          }

          h1 {
            font-size: 22px;
            margin-bottom: 4px;
          }

          p {
            font-size: 13px;
            color: #666;
            margin-bottom: 24px;
          }

          table {
            width: 100%;
            border-collapse: collapse;
            font-size: 12px;
          }

          th, td {
            border: 1px solid #ddd;
            padding: 8px;
            text-align: left;
          }

          th {
            background: #f5f5f5;
          }
        </style>
      </head>
      <body>
        <h1>Recebimentos da Imobiliária</h1>
        <p>Histórico de pagamentos recebidos referente às comissões totais das vendas.</p>

        <table>
          <thead>
            <tr>
              <th>Pagamento</th>
              <th>Cliente</th>
              <th>Empreendimento</th>
              <th>Unidade</th>
              <th>Categoria</th>
              <th>Status</th>
              <th>Recebido</th>
              <th>Saldo</th>
            </tr>
          </thead>
          <tbody>
            ${linhasHtml || '<tr><td colspan="8">Nenhum registro encontrado.</td></tr>'}
          </tbody>
        </table>
      </body>
      </html>
    `;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="recebimentos-imobiliaria.html"');

    return res.send(html);
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: 'Erro ao exportar PDF de recebimentos'
    });
  }
});

router.post('/:id/comprovante', uploadComprovante.single('arquivo'), async (req, res) => {
  try {
    const { id } = req.params;

    if (!req.file) {
      return res.status(400).json({
        message: 'Envie um comprovante'
      });
    }

    const atualResult = await pool.query(
      `
      SELECT arquivo_url
      FROM contas_receber
      WHERE id = $1
      LIMIT 1
      `,
      [id]
    );

    if (!atualResult.rows.length) {
      return res.status(404).json({
        message: 'Recebimento não encontrado'
      });
    }

    const arquivoAntigo = atualResult.rows[0]?.arquivo_url;

    if (arquivoAntigo) {
      const caminhoAntigo = path.join(
        __dirname,
        '..',
        '..',
        arquivoAntigo.replace(/^\/+/, '')
      );

      if (fs.existsSync(caminhoAntigo)) {
        fs.unlinkSync(caminhoAntigo);
      }
    }

    const arquivoUrl = `/uploads/contas-receber/${req.file.filename}`;

    await pool.query(
      `
      UPDATE contas_receber
      SET
        arquivo_nome = $1,
        arquivo_url = $2,
        arquivo_mime = $3,
        arquivo_tamanho = $4,
        atualizado_por = $5,
        updated_at = NOW()
      WHERE id = $6
      `,
      [
        req.file.originalname,
        arquivoUrl,
        req.file.mimetype,
        req.file.size,
        req.user.id,
        id
      ]
    );

    const recebimento = await buscarRecebimentoPorId(id);

    return res.json(mapRecebimento(recebimento));
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: 'Erro ao anexar comprovante'
    });
  }
});

router.delete('/:id/comprovante', async (req, res) => {
  try {
    const { id } = req.params;

    const atualResult = await pool.query(
      `
      SELECT arquivo_url
      FROM contas_receber
      WHERE id = $1
      LIMIT 1
      `,
      [id]
    );

    if (!atualResult.rows.length) {
      return res.status(404).json({
        message: 'Recebimento não encontrado'
      });
    }

    const arquivoAntigo = atualResult.rows[0]?.arquivo_url;

    if (arquivoAntigo) {
      const caminhoAntigo = path.join(
        __dirname,
        '..',
        '..',
        arquivoAntigo.replace(/^\/+/, '')
      );

      if (fs.existsSync(caminhoAntigo)) {
        fs.unlinkSync(caminhoAntigo);
      }
    }

    await pool.query(
      `
      UPDATE contas_receber
      SET
        arquivo_nome = NULL,
        arquivo_url = NULL,
        arquivo_mime = NULL,
        arquivo_tamanho = NULL,
        atualizado_por = $1,
        updated_at = NOW()
      WHERE id = $2
      `,
      [req.user.id, id]
    );

    const recebimento = await buscarRecebimentoPorId(id);

    return res.json(mapRecebimento(recebimento));
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: 'Erro ao remover comprovante'
    });
  }
});

router.delete('/:id/documento', async (req, res) => {
  try {
    const { id } = req.params;

    const recebimento = await buscarRecebimentoPorId(id);

    if (!recebimento) {
      return res.status(404).json({
        message: 'Recebimento não encontrado'
      });
    }

    if (recebimento.arquivo_url) {
      const caminhoArquivo = path.join(
        __dirname,
        '..',
        '..',
        recebimento.arquivo_url.replace(/^\/+/, '')
      );

      if (fs.existsSync(caminhoArquivo)) {
        fs.unlinkSync(caminhoArquivo);
      }
    }

    await pool.query(
      `
      UPDATE contas_receber
      SET
        arquivo_nome = NULL,
        arquivo_url = NULL,
        arquivo_mime = NULL,
        arquivo_tamanho = NULL,
        atualizado_por = $1,
        updated_at = NOW()
      WHERE id = $2
      `,
      [req.user.id, id]
    );

    return res.json({
      message: 'Documento removido com sucesso'
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: 'Erro ao remover documento'
    });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const atualResult = await pool.query(
      `
      SELECT arquivo_url
      FROM contas_receber
      WHERE id = $1
      LIMIT 1
      `,
      [id]
    );

    if (!atualResult.rows.length) {
      return res.status(404).json({
        message: 'Recebimento não encontrado'
      });
    }

    const arquivoAntigo = atualResult.rows[0]?.arquivo_url;

    await pool.query(
      `
      DELETE FROM contas_receber
      WHERE id = $1
      `,
      [id]
    );

    if (arquivoAntigo) {
      const caminhoAntigo = path.join(
        __dirname,
        '..',
        '..',
        arquivoAntigo.replace(/^\/+/, '')
      );

      if (fs.existsSync(caminhoAntigo)) {
        fs.unlinkSync(caminhoAntigo);
      }
    }

    return res.json({
      message: 'Recebimento excluído com sucesso'
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: 'Erro ao excluir recebimento'
    });
  }
});

module.exports = router;