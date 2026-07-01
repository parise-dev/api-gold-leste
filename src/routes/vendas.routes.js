const express = require('express');
const pool = require('../config/db');
const { authMiddleware, somentePerfis } = require('../middlewares/auth.middleware');

const router = express.Router();

router.use(authMiddleware);

function normalizarSituacao(situacao) {
  return situacao || 'Em processo';
}

function dinheiro(valor) {
  const numero = Number(valor || 0);
  return Number.isFinite(numero) ? numero : 0;
}

function textoValor(valor) {
  if (valor === null || valor === undefined) return null;
  if (typeof valor === 'object') return JSON.stringify(valor);
  return String(valor);
}

function calcularStatusFinanceiro(total, recebido) {
  const totalNumero = dinheiro(total);
  const recebidoNumero = dinheiro(recebido);

  if (recebidoNumero <= 0) return 'Não pago';
  if (totalNumero > 0 && recebidoNumero >= totalNumero) return 'Pago';
  return 'Parcial';
}

function totalDistribuido(body) {
  return (
    dinheiro(body.valorRepasseCorretor) +
    dinheiro(body.valorRepasseCorretor2) +
    dinheiro(body.valorRepasseGerencia) +
    dinheiro(body.valorCaptacao) +
    dinheiro(body.valorFechador) +
    dinheiro(body.valorRepasseImobiliaria)
  );
}

function validarTotalRepasses(body) {
  const totalComissao = dinheiro(body.valorComissaoTotal);
  const distribuido = totalDistribuido(body);

  if (distribuido > totalComissao + 0.01) {
    return {
      ok: false,
      message: 'A soma dos repasses não pode ser maior que a comissão total.'
    };
  }

  return { ok: true };
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
        OR ${prefixo}corretor_2_id = $${idx}
        OR ${prefixo}captador_id = $${idx}
        OR ${prefixo}puxador_id = $${idx}
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
        ${prefixo}created_by = $${idx}
        OR ${prefixo}updated_by = $${idx}
        OR EXISTS (
          SELECT 1
          FROM usuarios c_escopo
          WHERE c_escopo.id IN (${prefixo}corretor_id, ${prefixo}corretor_2_id, ${prefixo}captador_id, ${prefixo}puxador_id)
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
  if (req.user.perfil === 'admin') return true;

  const params = [vendaId];
  const where = ['v.id = $1'];
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

async function validarCorretoresExistem(corretores = []) {
  const ids = corretores
    .map(item => item?.corretorId)
    .filter(Boolean)
    .map(String);

  if (!ids.length) return { ok: true };

  const idsUnicos = [...new Set(ids)];

  const result = await pool.query(
    `
    SELECT id
    FROM usuarios
    WHERE perfil = 'corretor'
      AND ativo = TRUE
      AND id = ANY($1::uuid[])
    `,
    [idsUnicos]
  );

  if (result.rows.length !== idsUnicos.length) {
    return {
      ok: false,
      message: 'Selecione apenas corretores ativos cadastrados no sistema.'
    };
  }

  return { ok: true };
}

async function buscarNomeCorretor(corretorId) {
  if (!corretorId) return null;

  const result = await pool.query(
    `
    SELECT nome
    FROM usuarios
    WHERE id = $1
      AND perfil = 'corretor'
    LIMIT 1
    `,
    [corretorId]
  );

  return result.rows[0]?.nome || null;
}

async function salvarCorretoresVenda(client, vendaId, corretores = []) {
  await client.query(
    `DELETE FROM venda_corretores WHERE venda_id = $1`,
    [vendaId]
  );

  const listaValida = corretores
    .filter(item => item.corretorId)
    .slice(0, 2);

  for (let index = 0; index < listaValida.length; index++) {
    const item = listaValida[index];
    const nome = await buscarNomeCorretor(item.corretorId);

    if (!nome) continue;

    const valorRepasse = dinheiro(item.valorRepasse);

    await client.query(
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
      [vendaId, item.corretorId, nome, index + 1, valorRepasse]
    );
  }

  await sincronizarCamposLegadosVenda(client, vendaId);
  await recalcularStatusComissaoVendaGeral(client, vendaId);
}

async function sincronizarCamposLegadosVenda(client, vendaId) {
  const result = await client.query(
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

  await client.query(
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
      dinheiro(segundo?.valor_repasse),
      dinheiro(principal?.valor_repasse),
      vendaId
    ]
  );
}

async function recalcularStatusComissaoVendaGeral(client, vendaId) {
  const result = await client.query(
    `
    SELECT
      COALESCE(SUM(valor_repasse), 0)::NUMERIC AS total_repasse,
      COALESCE(SUM(valor_pago), 0)::NUMERIC AS total_pago
    FROM venda_corretores
    WHERE venda_id = $1
    `,
    [vendaId]
  );

  const totalRepasse = dinheiro(result.rows[0]?.total_repasse);
  const totalPago = dinheiro(result.rows[0]?.total_pago);

  let status = 'Pendente';
  let dataPagamento = null;

  if (totalPago > 0 && totalPago < totalRepasse) status = 'Parcial';
  if (totalRepasse > 0 && totalPago >= totalRepasse) {
    status = 'Pago';
    dataPagamento = new Date();
  }

  await client.query(
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

async function registrarLogVenda(client, vendaId, req, acao, campo = null, anterior = null, novo = null, dadosAnteriores = null, dadosNovos = null) {
  await client.query(
    `
    INSERT INTO venda_logs (
      venda_id,
      usuario_id,
      usuario_nome,
      acao,
      campo,
      valor_anterior,
      valor_novo,
      dados_anteriores,
      dados_novos
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    `,
    [
      vendaId,
      req.user.id,
      req.user.nome,
      acao,
      campo,
      textoValor(anterior),
      textoValor(novo),
      dadosAnteriores ? JSON.stringify(dadosAnteriores) : null,
      dadosNovos ? JSON.stringify(dadosNovos) : null
    ]
  );
}

async function registrarLogsAlteracao(client, vendaId, req, vendaAntes, vendaDepois) {
  const campos = [
    ['cliente', 'cliente'],
    ['cpf_cliente', 'cpf'],
    ['empreendimento_rua', 'empreendimento'],
    ['numero_unidade', 'unidade'],
    ['corretor_id', 'corretor principal'],
    ['corretor_2_id', 'segundo corretor'],
    ['situacao', 'situação'],
    ['captacao', 'captação'],
    ['captador_id', 'captador'],
    ['captador_tipo', 'tipo captador'],
    ['captador_parceiro_nome', 'parceiro captação'],
    ['captacao_observacao', 'observação captação'],
    ['valor_captacao', 'valor captação'],
    ['puxador_id', 'puxador'],
    ['puxador_tipo', 'tipo puxador'],
    ['puxador_parceiro_nome', 'parceiro puxador'],
    ['puxador_observacao', 'observação puxador'],
    ['valor_comissao_total', 'comissão total'],
    ['valor_repasse_corretor', 'repasse corretor'],
    ['valor_repasse_corretor_2', 'repasse 2º corretor'],
    ['valor_repasse_gerencia', 'repasse gerência'],
    ['valor_repasse_imobiliaria', 'repasse imobiliária'],
    ['valor_fechador', 'valor fechador'],
    ['valor_imovel_venda', 'valor imóvel'],
    ['modalidade_imovel', 'modalidade'],
    ['assinatura_ccv', 'assinatura CCV']
  ];

  for (const [coluna, label] of campos) {
    const antigo = textoValor(vendaAntes?.[coluna]);
    const novo = textoValor(vendaDepois?.[coluna]);

    if (antigo !== novo) {
      await registrarLogVenda(client, vendaId, req, 'ALTERACAO', label, antigo, novo);
    }
  }
}

function mapVenda(row, req) {
  const isCorretor = req?.user?.perfil === 'corretor';
  const statusFinanceiro = row.status_financeiro || calcularStatusFinanceiro(row.valor_comissao_total, row.valor_recebido_imobiliaria);

  const base = {
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
    valorRepasseCorretor2: dinheiro(row.valor_repasse_corretor_2),

    captacao: row.captacao || 'Não',
    captadorId: row.captador_id,
    captadorNome: row.captador_nome,
    captadorTipo: row.captador_tipo,
    captadorParceiroNome: row.captador_parceiro_nome,
    captacaoObservacao: row.captacao_observacao,
    valorCaptacao: dinheiro(row.valor_captacao),

    puxadorId: row.puxador_id,
    puxadorNome: row.puxador_nome,
    puxadorTipo: row.puxador_tipo,
    puxadorParceiroNome: row.puxador_parceiro_nome,
    puxadorObservacao: row.puxador_observacao,

    valorComissaoTotal: dinheiro(row.valor_comissao_total),

    nota: row.nota,
    valorNota: dinheiro(row.valor_nota),

    assinaturaCcv: row.assinatura_ccv,

    fechador: row.fechador,
    valorFechador: dinheiro(row.valor_fechador),

    irFuturo: row.ir_futuro,

    valorImovelVenda: dinheiro(row.valor_imovel_venda),
    modalidadeImovel: row.modalidade_imovel,

    valorRepasseCorretor: dinheiro(row.valor_repasse_corretor),
    valorRepasseGerencia: dinheiro(row.valor_repasse_gerencia),
    valorRepasseImobiliaria: dinheiro(row.valor_repasse_imobiliaria),

    valorPagoComprovantes: dinheiro(row.valor_pago_comprovantes),
    saldoPendente: dinheiro(row.saldo_pendente),

    valorRecebidoImobiliaria: dinheiro(row.valor_recebido_imobiliaria),
    saldoReceberImobiliaria: dinheiro(row.saldo_receber_imobiliaria),
    statusFinanceiro,
    statusFinanceiroComissao: statusFinanceiro,

    documentacaoValorCliente: dinheiro(row.documentacao_valor_cliente),
    documentacaoValorSobra: dinheiro(row.documentacao_valor_sobra),

    statusComissaoCorretor: row.status_comissao_corretor,
    dataPagamentoComissao: row.data_pagamento_comissao,

    createdAt: row.created_at,
    updatedAt: row.updated_at
  };

  if (!isCorretor) return base;

return {
  ...base,

  // Mantém os dados reais da venda:
  // corretor principal continua sendo o verdadeiro vendedor,
  // 2º corretor continua como 2º,
  // captador continua como captação,
  // puxador continua como puxador.

  meuRepasse: dinheiro(row.valor_repasse_usuario),
  meuValorPago: dinheiro(row.valor_pago_usuario),
  meuSaldoPendente: dinheiro(row.saldo_pendente_usuario),
  meuStatusPagamento: row.status_pagamento_usuario || row.status_comissao_corretor,

  valorPagoComprovantes: dinheiro(row.valor_pago_usuario),
  saldoPendente: dinheiro(row.saldo_pendente_usuario),
  statusComissaoCorretor: row.status_pagamento_usuario || row.status_comissao_corretor
};
}

function camposVendaDoBody(body, req) {
  const captacaoAtiva = body.captacao === 'Sim';
  const captadorTipo = captacaoAtiva ? (body.captadorTipo || 'corretor') : null;
  const captadorId = captacaoAtiva && captadorTipo === 'corretor' ? (body.captadorId || null) : null;
  const captadorParceiroNome = captacaoAtiva && captadorTipo === 'parceiro' ? (body.captadorParceiroNome || null) : null;
  const captadorNome = captacaoAtiva
    ? (body.captadorNome || captadorParceiroNome || null)
    : null;

  const puxadorAtivo = body.fechador === 'Sim';
  const puxadorTipo = puxadorAtivo ? (body.puxadorTipo || 'corretor') : null;
  const puxadorId = puxadorAtivo && puxadorTipo === 'corretor' ? (body.puxadorId || null) : null;
  const puxadorParceiroNome = puxadorAtivo && puxadorTipo === 'parceiro' ? (body.puxadorParceiroNome || null) : null;
  const puxadorNome = puxadorAtivo
    ? (body.puxadorNome || puxadorParceiroNome || null)
    : null;

  return [
    body.cliente,
    body.cpfCliente || null,
    body.empreendimentoRua || null,
    body.numeroUnidade || null,
    body.corretorId || null,
    body.corretor || null,
    body.corretor2Id || null,
    body.corretor2 || null,
    dinheiro(body.valorRepasseCorretor2),
    normalizarSituacao(body.situacao),
    captacaoAtiva ? 'Sim' : 'Não',
    dinheiro(captacaoAtiva ? body.valorCaptacao : 0),
    dinheiro(body.valorComissaoTotal),
    body.nota || 'Não',
    dinheiro(body.valorNota),
    body.assinaturaCcv || null,
    body.fechador || 'Não',
    dinheiro(body.valorFechador),
    body.irFuturo || 'Não',
    dinheiro(body.valorImovelVenda),
    body.modalidadeImovel || '',
    dinheiro(body.valorRepasseCorretor),
    dinheiro(body.valorRepasseGerencia),
    dinheiro(body.valorRepasseImobiliaria),
    dinheiro(body.documentacaoValorCliente),
    dinheiro(body.documentacaoValorSobra),
    captadorId,
    captadorNome,
    captadorTipo,
    captadorParceiroNome,
    captacaoAtiva ? (body.captacaoObservacao || null) : null,
    puxadorId,
    puxadorNome,
    puxadorTipo,
    puxadorParceiroNome,
    puxadorAtivo ? (body.puxadorObservacao || null) : null,
    req.user.id
  ];
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
      statusComissao,
      vendaId
    } = req.query;

    const params = [];
    const where = [];

    where.push(...montarFiltroEscopo(req, params, 'v'));

    if (vendaId) {
      params.push(vendaId);
      where.push(`v.id = $${params.length}`);
    }

    if (corretorId && ['admin', 'gerente'].includes(req.user.perfil)) {
      params.push(corretorId);
      where.push(`
        (
          v.corretor_id = $${params.length}
          OR v.corretor_2_id = $${params.length}
          OR v.captador_id = $${params.length}
          OR v.puxador_id = $${params.length}
          OR EXISTS (
            SELECT 1
            FROM venda_corretores vc
            WHERE vc.venda_id = v.id
              AND vc.corretor_id = $${params.length}
          )
        )
      `);
    }

    if (busca) {
      params.push(`%${String(busca).toLowerCase()}%`);
      where.push(`
        (
          LOWER(COALESCE(v.cliente, '')) LIKE $${params.length}
          OR LOWER(COALESCE(v.cpf_cliente, '')) LIKE $${params.length}
          OR LOWER(COALESCE(v.empreendimento_rua, '')) LIKE $${params.length}
          OR LOWER(COALESCE(v.corretor_nome, '')) LIKE $${params.length}
          OR LOWER(COALESCE(v.corretor_2_nome, '')) LIKE $${params.length}
          OR LOWER(COALESCE(v.captador_nome, '')) LIKE $${params.length}
          OR LOWER(COALESCE(v.captador_parceiro_nome, '')) LIKE $${params.length}
          OR LOWER(COALESCE(v.puxador_nome, '')) LIKE $${params.length}
          OR LOWER(COALESCE(v.puxador_parceiro_nome, '')) LIKE $${params.length}
          OR LOWER(COALESCE(v.numero_unidade, '')) LIKE $${params.length}
        )
      `);
    }

    if (situacao) {
      params.push(normalizarSituacao(situacao));
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
        )::NUMERIC AS saldo_pendente,

        COALESCE(ri.valor_recebido_imobiliaria, 0)::NUMERIC AS valor_recebido_imobiliaria,
        GREATEST(COALESCE(v.valor_comissao_total, 0) - COALESCE(ri.valor_recebido_imobiliaria, 0), 0)::NUMERIC AS saldo_receber_imobiliaria,
        CASE
          WHEN COALESCE(ri.valor_recebido_imobiliaria, 0) <= 0 THEN 'Não pago'
          WHEN COALESCE(ri.valor_recebido_imobiliaria, 0) >= COALESCE(v.valor_comissao_total, 0) THEN 'Pago'
          ELSE 'Parcial'
        END AS status_financeiro

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

        UNION ALL

        SELECT
          v.captador_id,
          COALESCE(v.captador_nome, 'Captação') AS corretor_nome,
          COALESCE(v.valor_captacao, 0)::NUMERIC AS valor_repasse,
          COALESCE((
            SELECT SUM(c.valor)
            FROM usuarios_comprovantes c
            WHERE c.venda_id = v.id
              AND (c.usuario_id = $${usuarioParamIndex} OR c.corretor_id = $${usuarioParamIndex})
          ), 0)::NUMERIC AS valor_pago,
          GREATEST(
            COALESCE(v.valor_captacao, 0) - COALESCE((
              SELECT SUM(c.valor)
              FROM usuarios_comprovantes c
              WHERE c.venda_id = v.id
                AND (c.usuario_id = $${usuarioParamIndex} OR c.corretor_id = $${usuarioParamIndex})
            ), 0),
            0
          )::NUMERIC AS saldo_pendente,
          CASE
            WHEN COALESCE((
              SELECT SUM(c.valor)
              FROM usuarios_comprovantes c
              WHERE c.venda_id = v.id
                AND (c.usuario_id = $${usuarioParamIndex} OR c.corretor_id = $${usuarioParamIndex})
            ), 0) <= 0 THEN 'Pendente'
            WHEN COALESCE((
              SELECT SUM(c.valor)
              FROM usuarios_comprovantes c
              WHERE c.venda_id = v.id
                AND (c.usuario_id = $${usuarioParamIndex} OR c.corretor_id = $${usuarioParamIndex})
            ), 0) < COALESCE(v.valor_captacao, 0) THEN 'Parcial'
            ELSE 'Pago'
          END AS status_pagamento
        WHERE v.captador_id = $${usuarioParamIndex}

        UNION ALL

        SELECT
          v.puxador_id,
          COALESCE(v.puxador_nome, 'Puxador') AS corretor_nome,
          COALESCE(v.valor_fechador, 0)::NUMERIC AS valor_repasse,
          COALESCE((
            SELECT SUM(c.valor)
            FROM usuarios_comprovantes c
            WHERE c.venda_id = v.id
              AND (c.usuario_id = $${usuarioParamIndex} OR c.corretor_id = $${usuarioParamIndex})
          ), 0)::NUMERIC AS valor_pago,
          GREATEST(
            COALESCE(v.valor_fechador, 0) - COALESCE((
              SELECT SUM(c.valor)
              FROM usuarios_comprovantes c
              WHERE c.venda_id = v.id
                AND (c.usuario_id = $${usuarioParamIndex} OR c.corretor_id = $${usuarioParamIndex})
            ), 0),
            0
          )::NUMERIC AS saldo_pendente,
          CASE
            WHEN COALESCE((
              SELECT SUM(c.valor)
              FROM usuarios_comprovantes c
              WHERE c.venda_id = v.id
                AND (c.usuario_id = $${usuarioParamIndex} OR c.corretor_id = $${usuarioParamIndex})
            ), 0) <= 0 THEN 'Pendente'
            WHEN COALESCE((
              SELECT SUM(c.valor)
              FROM usuarios_comprovantes c
              WHERE c.venda_id = v.id
                AND (c.usuario_id = $${usuarioParamIndex} OR c.corretor_id = $${usuarioParamIndex})
            ), 0) < COALESCE(v.valor_fechador, 0) THEN 'Parcial'
            ELSE 'Pago'
          END AS status_pagamento
        WHERE v.puxador_id = $${usuarioParamIndex}

        LIMIT 1
      ) pu ON TRUE

      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(cr.valor_recebido), 0)::NUMERIC AS valor_recebido_imobiliaria
        FROM contas_receber cr
        WHERE cr.venda_id = v.id
          AND cr.status IN ('Recebido', 'Parcial')
      ) ri ON TRUE

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
      return res.status(400).json({ message: 'Cliente é obrigatório' });
    }

    const validacaoRepasses = validarTotalRepasses(body);
    if (!validacaoRepasses.ok) {
      return res.status(400).json({ message: validacaoRepasses.message });
    }

    const permissaoCorretores = await validarCorretoresExistem([
      { corretorId: body.corretorId },
      { corretorId: body.corretor2Id },
      { corretorId: body.captadorTipo === 'corretor' ? body.captadorId : null },
      { corretorId: body.puxadorTipo === 'corretor' ? body.puxadorId : null }
    ]);

    if (!permissaoCorretores.ok) {
      return res.status(400).json({ message: permissaoCorretores.message });
    }

    await client.query('BEGIN');

    const valores = camposVendaDoBody(body, req);

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
        captador_id,
        captador_nome,
        captador_tipo,
        captador_parceiro_nome,
        captacao_observacao,
        puxador_id,
        puxador_nome,
        puxador_tipo,
        puxador_parceiro_nome,
        puxador_observacao,
        created_by,
        updated_by
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
        $11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
        $21,$22,$23,$24,$25,$26,$27,$28,$29,$30,
        $31,$32,$33,$34,$35,$36,$37,$37
      )
      RETURNING *
      `,
      valores
    );

    const vendaCriada = result.rows[0];

    await salvarCorretoresVenda(client, vendaCriada.id, [
      { corretorId: body.corretorId, valorRepasse: body.valorRepasseCorretor },
      { corretorId: body.corretor2Id, valorRepasse: body.valorRepasseCorretor2 }
    ]);

    const vendaAtualizada = await client.query('SELECT * FROM vendas WHERE id = $1', [vendaCriada.id]);

    await registrarLogVenda(
      client,
      vendaCriada.id,
      req,
      'CRIACAO',
      null,
      null,
      null,
      null,
      vendaAtualizada.rows[0]
    );

    await client.query('COMMIT');

    const vendaAtualizadaResult = await pool.query(
      `
      SELECT
        v.*,
        0::NUMERIC AS valor_pago_comprovantes,
        0::NUMERIC AS saldo_pendente,
        0::NUMERIC AS valor_recebido_imobiliaria,
        COALESCE(v.valor_comissao_total, 0)::NUMERIC AS saldo_receber_imobiliaria,
        'Não pago' AS status_financeiro
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
      return res.status(403).json({ message: 'Você não tem permissão para editar esta venda' });
    }

    const validacaoRepasses = validarTotalRepasses(body);
    if (!validacaoRepasses.ok) {
      return res.status(400).json({ message: validacaoRepasses.message });
    }

    const permissaoCorretores = await validarCorretoresExistem([
      { corretorId: body.corretorId },
      { corretorId: body.corretor2Id },
      { corretorId: body.captadorTipo === 'corretor' ? body.captadorId : null },
      { corretorId: body.puxadorTipo === 'corretor' ? body.puxadorId : null }
    ]);

    if (!permissaoCorretores.ok) {
      return res.status(400).json({ message: permissaoCorretores.message });
    }

    await client.query('BEGIN');

    const antesResult = await client.query('SELECT * FROM vendas WHERE id = $1 FOR UPDATE', [id]);
    if (!antesResult.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Venda não encontrada' });
    }

    const valores = camposVendaDoBody(body, req);

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
          captador_id = $27,
          captador_nome = $28,
          captador_tipo = $29,
          captador_parceiro_nome = $30,
          captacao_observacao = $31,
          puxador_id = $32,
          puxador_nome = $33,
          puxador_tipo = $34,
          puxador_parceiro_nome = $35,
          puxador_observacao = $36,
          updated_by = $37,
          updated_at = NOW()
      WHERE id = $38
      RETURNING *
      `,
      [...valores, id]
    );

    await salvarCorretoresVenda(client, id, [
      { corretorId: body.corretorId, valorRepasse: body.valorRepasseCorretor },
      { corretorId: body.corretor2Id, valorRepasse: body.valorRepasseCorretor2 }
    ]);

    const depoisResult = await client.query('SELECT * FROM vendas WHERE id = $1', [id]);
    await registrarLogsAlteracao(client, id, req, antesResult.rows[0], depoisResult.rows[0]);

    await client.query('COMMIT');

    const vendaAtualizadaResult = await pool.query(
      `
      SELECT
        v.*,
        COALESCE((SELECT SUM(c.valor) FROM usuarios_comprovantes c WHERE c.venda_id = v.id), 0)::NUMERIC AS valor_pago_comprovantes,
        0::NUMERIC AS saldo_pendente,
        COALESCE(ri.valor_recebido_imobiliaria, 0)::NUMERIC AS valor_recebido_imobiliaria,
        GREATEST(COALESCE(v.valor_comissao_total, 0) - COALESCE(ri.valor_recebido_imobiliaria, 0), 0)::NUMERIC AS saldo_receber_imobiliaria,
        CASE
          WHEN COALESCE(ri.valor_recebido_imobiliaria, 0) <= 0 THEN 'Não pago'
          WHEN COALESCE(ri.valor_recebido_imobiliaria, 0) >= COALESCE(v.valor_comissao_total, 0) THEN 'Pago'
          ELSE 'Parcial'
        END AS status_financeiro
      FROM vendas v
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(cr.valor_recebido), 0)::NUMERIC AS valor_recebido_imobiliaria
        FROM contas_receber cr
        WHERE cr.venda_id = v.id
          AND cr.status IN ('Recebido', 'Parcial')
      ) ri ON TRUE
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

router.get('/:id/logs', somentePerfis('admin', 'gerente'), async (req, res) => {
  try {
    const { id } = req.params;

    const pertence = await vendaPertenceAoEscopo(req, id);
    if (!pertence) {
      return res.status(403).json({ message: 'Você não tem permissão para visualizar logs desta venda' });
    }

    const result = await pool.query(
      `
      SELECT
        id,
        venda_id,
        usuario_id,
        usuario_nome,
        acao,
        campo,
        valor_anterior,
        valor_novo,
        dados_anteriores,
        dados_novos,
        criado_em
      FROM venda_logs
      WHERE venda_id = $1
      ORDER BY criado_em DESC
      `,
      [id]
    );

    return res.json(result.rows.map(row => ({
      id: row.id,
      vendaId: row.venda_id,
      usuarioId: row.usuario_id,
      usuarioNome: row.usuario_nome,
      acao: row.acao,
      campo: row.campo,
      valorAnterior: row.valor_anterior,
      valorNovo: row.valor_novo,
      dadosAnteriores: row.dados_anteriores,
      dadosNovos: row.dados_novos,
      criadoEm: row.criado_em
    })));
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: 'Erro ao carregar logs da venda'
    });
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
