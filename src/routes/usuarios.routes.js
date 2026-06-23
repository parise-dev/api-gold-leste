const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../config/db');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { authMiddleware, somentePerfis } = require('../middlewares/auth.middleware');

const router = express.Router();

router.use(authMiddleware);

const comprovantesDir = path.join(__dirname, '..', '..', 'uploads', 'comprovantes');

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

const SENHA_PADRAO = '123456';

function mapUsuario(row) {
  return {
    id: row.id,

    nome: row.nome,
    name: row.nome,

    email: row.email,
    perfil: row.perfil,

    cpf: row.cpf,
    creci: row.creci,

    telefone: row.telefone,
    cellphone: row.telefone,

    dataAdmissao: row.data_admissao,
    admissionDate: row.data_admissao,

    endereco: row.endereco,
    address: row.endereco,

    filialId: row.filial_id,
    filial: row.filial_id,
    filialNome: row.filial_nome,

    gerenteId: row.gerente_id,
    managerId: row.gerente_id,
    gerenteNome: row.gerente_nome,

    ativo: row.ativo,
    hidden: !row.ativo,

    primeiroAcesso: !!row.primeiro_acesso,
    deveTrocarSenha: !!row.deve_trocar_senha,

    criadoEm: row.created_at,
    atualizadoEm: row.updated_at
  };
}

function podeVisualizarUsuario(req, usuarioId) {
  if (req.user.perfil === 'admin') {
    return true;
  }

  if (req.user.perfil === 'gerente') {
    return true;
  }

  return String(req.user.id) === String(usuarioId);
}

function somenteAdmin(req, res) {
  if (req.user.perfil !== 'admin') {
    res.status(403).json({
      message: 'Acesso restrito ao administrador'
    });

    return false;
  }

  return true;
}

async function recalcularStatusComissaoVenda(vendaId) {
  if (!vendaId) {
    return;
  }

  const result = await pool.query(
    `
    SELECT
      v.id,
      COALESCE(v.valor_repasse_corretor, 0)::NUMERIC AS valor_repasse_corretor,
      COALESCE(SUM(c.valor), 0)::NUMERIC AS total_pago
    FROM vendas v
    LEFT JOIN usuarios_comprovantes c ON c.venda_id = v.id
    WHERE v.id = $1
    GROUP BY v.id, v.valor_repasse_corretor
    `,
    [vendaId]
  );

  if (!result.rows.length) {
    return;
  }

  const row = result.rows[0];

  const valorComissao = Number(row.valor_repasse_corretor || 0);
  const totalPago = Number(row.total_pago || 0);

  let status = 'Pendente';
  let dataPagamento = null;

  if (totalPago > 0 && totalPago < valorComissao) {
    status = 'Parcial';
  }

  if (valorComissao > 0 && totalPago >= valorComissao) {
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

async function buscarCorretoresDaVenda(vendaId) {
  const result = await pool.query(
    `
    SELECT
      vc.corretor_id,
      vc.corretor_nome,
      vc.ordem,
      COALESCE(vc.valor_repasse, 0)::NUMERIC AS valor_repasse
    FROM venda_corretores vc
    WHERE vc.venda_id = $1

    UNION

    SELECT
      v.corretor_id,
      COALESCE(v.corretor_nome, v.corretor, 'Corretor principal') AS corretor_nome,
      1 AS ordem,
      COALESCE(v.valor_repasse_corretor, 0)::NUMERIC AS valor_repasse
    FROM vendas v
    WHERE v.id = $1
      AND v.corretor_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM venda_corretores vc
        WHERE vc.venda_id = v.id
          AND vc.corretor_id = v.corretor_id
      )

    ORDER BY ordem
    `,
    [vendaId]
  );

  return result.rows;
}

async function corretorPertenceVenda(vendaId, usuarioId) {
  if (!vendaId || !usuarioId) {
    return false;
  }

  const result = await pool.query(
    `
    SELECT 1
    FROM venda_corretores
    WHERE venda_id = $1
      AND corretor_id = $2

    UNION

    SELECT 1
    FROM vendas
    WHERE id = $1
      AND corretor_id = $2

    LIMIT 1
    `,
    [vendaId, usuarioId]
  );

  return result.rows.length > 0;
}

async function recalcularStatusComissaoVendaCorretor(vendaId, usuarioId) {
  if (!vendaId || !usuarioId) {
    return;
  }

  const corretorResult = await pool.query(
    `
    SELECT
      COALESCE(vc.valor_repasse, v.valor_repasse_corretor, 0)::NUMERIC AS valor_repasse
    FROM vendas v
    LEFT JOIN venda_corretores vc
      ON vc.venda_id = v.id
      AND vc.corretor_id = $2
    WHERE v.id = $1
    LIMIT 1
    `,
    [vendaId, usuarioId]
  );

  if (!corretorResult.rows.length) {
    return;
  }

  const valorRepasse = Number(corretorResult.rows[0].valor_repasse || 0);

  const pagamentosResult = await pool.query(
    `
    SELECT COALESCE(SUM(valor), 0)::NUMERIC AS total_pago
    FROM usuarios_comprovantes
    WHERE venda_id = $1
      AND usuario_id = $2
    `,
    [vendaId, usuarioId]
  );

  const totalPago = Number(pagamentosResult.rows[0]?.total_pago || 0);
  const saldo = Math.max(valorRepasse - totalPago, 0);

  let status = 'Pendente';

  if (totalPago > 0 && totalPago < valorRepasse) {
    status = 'Parcial';
  }

  if (valorRepasse > 0 && totalPago >= valorRepasse) {
    status = 'Pago';
  }

  await pool.query(
    `
    UPDATE venda_corretores
    SET
      valor_pago = $1,
      saldo_pendente = $2,
      status_pagamento = $3,
      updated_at = NOW()
    WHERE venda_id = $4
      AND corretor_id = $5
    `,
    [totalPago, saldo, status, vendaId, usuarioId]
  );

  await recalcularStatusComissaoVendaGeral(vendaId);
}

async function recalcularStatusComissaoVendaGeral(vendaId) {
  if (!vendaId) {
    return;
  }

  const result = await pool.query(
    `
    SELECT
      COALESCE(SUM(vc.valor_repasse), v.valor_repasse_corretor, 0)::NUMERIC AS total_repasse,
      COALESCE(SUM(vc.valor_pago), 0)::NUMERIC AS total_pago
    FROM vendas v
    LEFT JOIN venda_corretores vc ON vc.venda_id = v.id
    WHERE v.id = $1
    GROUP BY v.id
    `,
    [vendaId]
  );

  if (!result.rows.length) {
    return;
  }

  const totalRepasse = Number(result.rows[0].total_repasse || 0);
  const totalPago = Number(result.rows[0].total_pago || 0);

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

router.get('/', somentePerfis('admin', 'gerente'), async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT
        u.id,
        u.nome,
        u.email,
        u.perfil,
        u.ativo,
        u.cpf,
        u.creci,
        u.telefone,
        u.data_admissao,
        u.endereco,
        u.filial_id,
        f.nome AS filial_nome,
        u.gerente_id,
        g.nome AS gerente_nome,
        u.primeiro_acesso,
        u.deve_trocar_senha,
        u.created_at,
        u.updated_at
      FROM usuarios u
      LEFT JOIN filiais f ON f.id = u.filial_id
      LEFT JOIN usuarios g ON g.id = u.gerente_id
      ORDER BY u.nome ASC
      `
    );

    return res.json(result.rows.map(mapUsuario));
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: 'Erro ao listar usuários'
    });
  }
});

router.get('/gerentes', somentePerfis('admin', 'gerente'), async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT id, nome, email
      FROM usuarios
      WHERE perfil = 'gerente'
        AND ativo = TRUE
      ORDER BY nome ASC
      `
    );

    return res.json(result.rows.map(row => ({
      id: row.id,
      nome: row.nome,
      name: row.nome,
      email: row.email
    })));
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: 'Erro ao listar gerentes'
    });
  }
});

router.get('/corretores', somentePerfis('admin', 'gerente'), async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT id, nome, email
      FROM usuarios
      WHERE perfil = 'corretor'
      AND ativo = TRUE
      ORDER BY nome ASC
      `
    );

    return res.json(result.rows);
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: 'Erro ao listar corretores'
    });
  }
});

router.post('/', somentePerfis('admin'), async (req, res) => {
  try {
    const nome = req.body.nome || req.body.name;
    const email = req.body.email;
    const perfil = req.body.perfil || req.body.cargo;

    const cpf = req.body.cpf || null;
    const creci = req.body.creci || null;
    const telefone = req.body.telefone || req.body.cellphone || null;
    const dataAdmissao = req.body.dataAdmissao || req.body.admissionDate || null;
    const endereco = req.body.endereco || req.body.address || null;

    const filialId = req.body.filialId || req.body.filial || null;
    const gerenteId = req.body.gerenteId || req.body.managerId || null;

    const ativo = typeof req.body.ativo === 'boolean'
      ? req.body.ativo
      : req.body.hidden !== undefined
        ? !req.body.hidden
        : true;

    if (!nome || !email || !perfil) {
      return res.status(400).json({
        message: 'Nome completo, e-mail e cargo são obrigatórios'
      });
    }

    if (!['admin', 'gerente', 'corretor'].includes(perfil)) {
      return res.status(400).json({
        message: 'Cargo inválido'
      });
    }

    if (filialId) {
      const filialResult = await pool.query(
        `
        SELECT id
        FROM filiais
        WHERE id = $1
          AND ativo = TRUE
        LIMIT 1
        `,
        [filialId]
      );

      if (!filialResult.rows.length) {
        return res.status(400).json({
          message: 'Filial inválida ou inativa'
        });
      }
    }

    if (gerenteId) {
      const gerenteResult = await pool.query(
        `
        SELECT id
        FROM usuarios
        WHERE id = $1
          AND perfil = 'gerente'
          AND ativo = TRUE
        LIMIT 1
        `,
        [gerenteId]
      );

      if (!gerenteResult.rows.length) {
        return res.status(400).json({
          message: 'Gerente inválido ou inativo'
        });
      }
    }

    const senhaHash = await bcrypt.hash(SENHA_PADRAO, 10);

    const result = await pool.query(
      `
      INSERT INTO usuarios (
        nome,
        email,
        senha_hash,
        perfil,
        ativo,
        cpf,
        creci,
        telefone,
        data_admissao,
        endereco,
        filial_id,
        gerente_id,
        primeiro_acesso,
        deve_trocar_senha,
        created_at,
        updated_at
      )
      VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9, $10,
        $11, $12, TRUE, TRUE, NOW(), NOW()
      )
      RETURNING
        id,
        nome,
        email,
        perfil,
        ativo,
        cpf,
        creci,
        telefone,
        data_admissao,
        endereco,
        filial_id,
        gerente_id,
        primeiro_acesso,
        deve_trocar_senha,
        created_at,
        updated_at
      `,
      [
        nome,
        email,
        senhaHash,
        perfil,
        ativo,
        cpf,
        creci,
        telefone,
        dataAdmissao,
        endereco,
        filialId || null,
        gerenteId || null
      ]
    );

    return res.status(201).json({
      ...mapUsuario(result.rows[0]),
      senhaPadrao: SENHA_PADRAO
    });
  } catch (error) {
    console.error(error);

    if (error.code === '23505') {
      return res.status(409).json({
        message: 'Este e-mail já está cadastrado'
      });
    }

    return res.status(500).json({
      message: 'Erro ao criar usuário'
    });
  }
});

router.put('/:id', somentePerfis('admin'), async (req, res) => {
  try {
    const { id } = req.params;

    const nome = req.body.nome || req.body.name;
    const email = req.body.email;
    const perfil = req.body.perfil || req.body.cargo;

    const cpf = req.body.cpf || null;
    const creci = req.body.creci || null;
    const telefone = req.body.telefone || req.body.cellphone || null;
    const dataAdmissao = req.body.dataAdmissao || req.body.admissionDate || null;
    const endereco = req.body.endereco || req.body.address || null;

    const filialId = req.body.filialId || req.body.filial || null;
    const gerenteId = req.body.gerenteId || req.body.managerId || null;

    const ativo = typeof req.body.ativo === 'boolean'
      ? req.body.ativo
      : req.body.hidden !== undefined
        ? !req.body.hidden
        : true;

    if (!nome || !email || !perfil) {
      return res.status(400).json({
        message: 'Nome completo, e-mail e cargo são obrigatórios'
      });
    }

    if (!['admin', 'gerente', 'corretor'].includes(perfil)) {
      return res.status(400).json({
        message: 'Cargo inválido'
      });
    }

    if (filialId) {
      const filialResult = await pool.query(
        `
        SELECT id
        FROM filiais
        WHERE id = $1
          AND ativo = TRUE
        LIMIT 1
        `,
        [filialId]
      );

      if (!filialResult.rows.length) {
        return res.status(400).json({
          message: 'Filial inválida ou inativa'
        });
      }
    }

    if (gerenteId) {
      const gerenteResult = await pool.query(
        `
        SELECT id
        FROM usuarios
        WHERE id = $1
          AND perfil = 'gerente'
          AND ativo = TRUE
        LIMIT 1
        `,
        [gerenteId]
      );

      if (!gerenteResult.rows.length) {
        return res.status(400).json({
          message: 'Gerente inválido ou inativo'
        });
      }
    }

    const result = await pool.query(
      `
      UPDATE usuarios
      SET
        nome = $1,
        email = $2,
        perfil = $3,
        ativo = $4,
        cpf = $5,
        creci = $6,
        telefone = $7,
        data_admissao = $8,
        endereco = $9,
        filial_id = $10,
        gerente_id = $11,
        updated_at = NOW()
      WHERE id = $12
      RETURNING
        id,
        nome,
        email,
        perfil,
        ativo,
        cpf,
        creci,
        telefone,
        data_admissao,
        endereco,
        filial_id,
        gerente_id,
        primeiro_acesso,
        deve_trocar_senha,
        created_at,
        updated_at
      `,
      [
        nome,
        email,
        perfil,
        ativo,
        cpf,
        creci,
        telefone,
        dataAdmissao,
        endereco,
        filialId || null,
        gerenteId || null,
        id
      ]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        message: 'Usuário não encontrado'
      });
    }

    return res.json(mapUsuario(result.rows[0]));
  } catch (error) {
    console.error(error);

    if (error.code === '23505') {
      return res.status(409).json({
        message: 'Este e-mail já está cadastrado'
      });
    }

    return res.status(500).json({
      message: 'Erro ao atualizar usuário'
    });
  }
});

router.patch('/:id/resetar-senha', somentePerfis('admin'), async (req, res) => {
  try {
    const { id } = req.params;

    const senhaHash = await bcrypt.hash(SENHA_PADRAO, 10);

    const result = await pool.query(
      `
      UPDATE usuarios
      SET
        senha_hash = $1,
        primeiro_acesso = TRUE,
        deve_trocar_senha = TRUE,
        senha_resetada_em = NOW(),
        updated_at = NOW()
      WHERE id = $2
      RETURNING
        id,
        nome,
        email,
        perfil,
        ativo,
        primeiro_acesso,
        deve_trocar_senha,
        senha_resetada_em,
        updated_at
      `,
      [senhaHash, id]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        message: 'Usuário não encontrado'
      });
    }

    return res.json({
      message: 'Senha resetada para 123456. No próximo acesso, o usuário deverá trocar a senha.',
      usuario: {
        id: result.rows[0].id,
        nome: result.rows[0].nome,
        name: result.rows[0].nome,
        email: result.rows[0].email,
        perfil: result.rows[0].perfil,
        ativo: result.rows[0].ativo,
        hidden: !result.rows[0].ativo,
        primeiroAcesso: !!result.rows[0].primeiro_acesso,
        deveTrocarSenha: !!result.rows[0].deve_trocar_senha,
        senhaResetadaEm: result.rows[0].senha_resetada_em,
        atualizadoEm: result.rows[0].updated_at
      }
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: 'Erro ao resetar senha'
    });
  }
});

router.get('/:id/perfil', async (req, res) => {
  try {
    const { id } = req.params;

    if (!podeVisualizarUsuario(req, id)) {
      return res.status(403).json({
        message: 'Você não tem permissão para visualizar este usuário'
      });
    }

    const usuarioResult = await pool.query(
      `
      SELECT
        u.id,
        u.nome,
        u.email,
        u.perfil,
        u.ativo,
        u.telefone,
        u.cpf,
        u.endereco,
        u.data_admissao,
        u.gerente_id,
        g.nome AS gerente_nome,
        u.created_at,
        u.updated_at,

        u.pix_chave,
        u.pix_tipo,
        u.banco_nome,
        u.banco_agencia,
        u.banco_conta,
        u.banco_tipo_conta,
        u.banco_titular_nome,
        u.banco_titular_documento,
        u.pix_atualizado_em,
        u.pix_atualizado_por,
        up.nome AS pix_atualizado_por_nome

      FROM usuarios u
      LEFT JOIN usuarios g ON g.id = u.gerente_id
      LEFT JOIN usuarios up ON up.id = u.pix_atualizado_por
      WHERE u.id = $1
      LIMIT 1
      `,
      [id]
    );

    if (!usuarioResult.rows.length) {
      return res.status(404).json({
        message: 'Usuário não encontrado'
      });
    }

    const resumoResult = await pool.query(
  `
  SELECT
    COUNT(DISTINCT v.id)::INT AS total_vendas,

    COUNT(DISTINCT v.id) FILTER (WHERE v.situacao = 'Concluído' OR v.situacao = 'Concluido')::INT AS total_concluidas,
    COUNT(DISTINCT v.id) FILTER (WHERE v.situacao = 'Em processo')::INT AS total_em_processo,
    COUNT(DISTINCT v.id) FILTER (WHERE v.situacao = 'IR Futuro')::INT AS total_ir_futuro,
    COUNT(DISTINCT v.id) FILTER (WHERE v.situacao = 'Caiu')::INT AS total_caiu,

    COALESCE(SUM(v.valor_imovel_venda), 0)::NUMERIC AS total_vendido,
    COALESCE(SUM(v.valor_comissao_total), 0)::NUMERIC AS total_comissao,
    COALESCE(SUM(vc.valor_repasse), 0)::NUMERIC AS total_repasse,

    COALESCE(SUM(vc.saldo_pendente), 0)::NUMERIC AS comissao_a_receber,
    COALESCE(SUM(vc.valor_pago), 0)::NUMERIC AS comissao_paga
  FROM venda_corretores vc
  INNER JOIN vendas v ON v.id = vc.venda_id
  WHERE vc.corretor_id = $1
  `,
  [id]
);

    const vendasRecentesResult = await pool.query(
  `
  SELECT
    v.id,
    v.cliente,
    v.cpf_cliente,
    v.empreendimento_rua,
    v.numero_unidade,
    v.situacao,
    v.assinatura_ccv,
    v.valor_imovel_venda,
    v.valor_comissao_total,
    vc.valor_repasse AS valor_repasse_corretor,
    vc.valor_pago AS valor_pago_comprovantes,
    vc.saldo_pendente,
    vc.status_pagamento AS status_comissao_corretor,
    v.created_at
  FROM venda_corretores vc
  INNER JOIN vendas v ON v.id = vc.venda_id
  WHERE vc.corretor_id = $1
  ORDER BY v.assinatura_ccv DESC NULLS LAST, v.created_at DESC
  LIMIT 8
  `,
  [id]
);

    const comprovantesRecentesResult = await pool.query(
      `
      SELECT
        c.id,
        c.tipo,
        c.descricao,
        c.valor,
        c.data_pagamento,
        c.arquivo_nome,
        c.arquivo_url,
        c.arquivo_mime,
        c.arquivo_tamanho,
        c.criado_em,
        c.criado_por,
        u.nome AS criado_por_nome
      FROM usuarios_comprovantes c
      LEFT JOIN usuarios u ON u.id = c.criado_por
      WHERE c.usuario_id = $1
      ORDER BY c.criado_em DESC
      LIMIT 8
      `,
      [id]
    );

    const usuario = usuarioResult.rows[0];
    const resumo = resumoResult.rows[0];

    return res.json({
      usuario: {
        id: usuario.id,
        nome: usuario.nome,
        email: usuario.email,
        perfil: usuario.perfil,
        ativo: usuario.ativo,
        telefone: usuario.telefone,
        cpf: usuario.cpf,
        endereco: usuario.endereco,
        dataAdmissao: usuario.data_admissao,
        gerenteId: usuario.gerente_id,
        gerenteNome: usuario.gerente_nome,
        criadoEm: usuario.created_at,
        atualizadoEm: usuario.updated_at,

        dadosBancarios: {
          pixChave: usuario.pix_chave,
          pixTipo: usuario.pix_tipo,
          bancoNome: usuario.banco_nome,
          bancoAgencia: usuario.banco_agencia,
          bancoConta: usuario.banco_conta,
          bancoTipoConta: usuario.banco_tipo_conta,
          bancoTitularNome: usuario.banco_titular_nome,
          bancoTitularDocumento: usuario.banco_titular_documento,
          pixAtualizadoEm: usuario.pix_atualizado_em,
          pixAtualizadoPor: usuario.pix_atualizado_por,
          pixAtualizadoPorNome: usuario.pix_atualizado_por_nome
        }
      },

      resumo: {
        totalVendas: Number(resumo.total_vendas || 0),
        totalConcluidas: Number(resumo.total_concluidas || 0),
        totalEmProcesso: Number(resumo.total_em_processo || 0),
        totalIrFuturo: Number(resumo.total_ir_futuro || 0),
        totalCaiu: Number(resumo.total_caiu || 0),
        totalVendido: Number(resumo.total_vendido || 0),
        totalComissao: Number(resumo.total_comissao || 0),
        totalRepasse: Number(resumo.total_repasse || 0),
        comissaoAReceber: Number(resumo.comissao_a_receber || 0),
        comissaoPaga: Number(resumo.comissao_paga || 0)
      },

      vendasRecentes: vendasRecentesResult.rows.map(row => ({
  id: row.id,
  cliente: row.cliente,
  cpfCliente: row.cpf_cliente,
  empreendimentoRua: row.empreendimento_rua,
  numeroUnidade: row.numero_unidade,
  situacao: row.situacao,
  assinaturaCcv: row.assinatura_ccv,
  valorImovelVenda: Number(row.valor_imovel_venda || 0),
  valorComissaoTotal: Number(row.valor_comissao_total || 0),
  valorRepasseCorretor: Number(row.valor_repasse_corretor || 0),

  valorPagoComprovantes: Number(row.valor_pago_comprovantes || 0),
  saldoPendente: Number(row.saldo_pendente || 0),
  criadoEm: row.created_at,

  statusComissaoCorretor: row.status_comissao_corretor
})),

      comprovantesRecentes: comprovantesRecentesResult.rows.map(row => ({
        id: row.id,
        tipo: row.tipo,
        descricao: row.descricao,
        valor: Number(row.valor || 0),
        dataPagamento: row.data_pagamento,
        arquivoNome: row.arquivo_nome,
        arquivoUrl: row.arquivo_url,
        arquivoMime: row.arquivo_mime,
        arquivoTamanho: row.arquivo_tamanho,
        criadoEm: row.criado_em,
        criadoPor: row.criado_por,
        criadoPorNome: row.criado_por_nome
      }))
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: 'Erro ao carregar perfil do usuário'
    });
  }
});

router.get('/:id/vendas', async (req, res) => {
  try {
    const { id } = req.params;

    if (!podeVisualizarUsuario(req, id)) {
      return res.status(403).json({
        message: 'Você não tem permissão para visualizar vendas deste usuário'
      });
    }

    const result = await pool.query(
  `
  SELECT
    v.id,
    v.cliente,
    v.cpf_cliente,
    v.empreendimento_rua,
    v.numero_unidade,
    v.situacao,
    v.assinatura_ccv,
    v.valor_imovel_venda,
    v.valor_comissao_total,
    vc.valor_repasse AS valor_repasse_corretor,
    v.valor_repasse_gerencia,
    v.valor_repasse_imobiliaria,
    v.modalidade_imovel,
    vc.status_pagamento AS status_comissao_corretor,
    v.data_pagamento_comissao,
    v.created_at,

    COALESCE(vc.valor_pago, 0)::NUMERIC AS valor_pago_comprovantes,
    COALESCE(vc.saldo_pendente, vc.valor_repasse, 0)::NUMERIC AS saldo_pendente

  FROM venda_corretores vc
  INNER JOIN vendas v ON v.id = vc.venda_id
  WHERE vc.corretor_id = $1
  ORDER BY v.assinatura_ccv DESC NULLS LAST, v.created_at DESC
  `,
  [id]
);

   return res.json(result.rows.map(row => ({
  id: row.id,
  cliente: row.cliente,
  cpfCliente: row.cpf_cliente,
  empreendimentoRua: row.empreendimento_rua,
  numeroUnidade: row.numero_unidade,
  situacao: row.situacao,
  assinaturaCcv: row.assinatura_ccv,
  valorImovelVenda: Number(row.valor_imovel_venda || 0),
  valorComissaoTotal: Number(row.valor_comissao_total || 0),
  valorRepasseCorretor: Number(row.valor_repasse_corretor || 0),
  valorRepasseGerencia: Number(row.valor_repasse_gerencia || 0),
  valorRepasseImobiliaria: Number(row.valor_repasse_imobiliaria || 0),
  valorPagoComprovantes: Number(row.valor_pago_comprovantes || 0),
  saldoPendente: Number(row.saldo_pendente || 0),
  modalidadeImovel: row.modalidade_imovel,
  statusComissaoCorretor: row.status_comissao_corretor,
  dataPagamentoComissao: row.data_pagamento_comissao,
  criadoEm: row.created_at
})));
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: 'Erro ao carregar vendas do usuário'
    });
  }
});

router.get('/:id/comprovantes', async (req, res) => {
  try {
    const { id } = req.params;

    if (!podeVisualizarUsuario(req, id)) {
      return res.status(403).json({
        message: 'Você não tem permissão para visualizar comprovantes deste usuário'
      });
    }

    const result = await pool.query(
      `
      SELECT
        c.id,
        c.usuario_id,
        c.corretor_id,
        c.venda_id,
        c.tipo,
        c.descricao,
        c.valor,
        c.data_pagamento,
        c.arquivo_nome,
        c.arquivo_url,
        c.arquivo_mime,
        c.arquivo_tamanho,
        c.criado_em,
        c.criado_por,

        v.empreendimento_rua,
        v.numero_unidade,

        u.nome AS criado_por_nome

      FROM usuarios_comprovantes c
      LEFT JOIN vendas v ON v.id = c.venda_id
      LEFT JOIN usuarios u ON u.id = c.criado_por

      WHERE c.usuario_id = $1
         OR c.corretor_id = $1

      ORDER BY c.data_pagamento DESC NULLS LAST, c.criado_em DESC
      `,
      [id]
    );

    return res.json(result.rows.map(row => ({
      id: row.id,

      usuarioId: row.usuario_id,
      corretorId: row.corretor_id,
      vendaId: row.venda_id,

      tipo: row.tipo,
      descricao: row.descricao,
      valor: Number(row.valor || 0),
      dataPagamento: row.data_pagamento,

      empreendimentoRua: row.empreendimento_rua || '-',
      numeroUnidade: row.numero_unidade || '-',

      arquivoNome: row.arquivo_nome,
      arquivoUrl: row.arquivo_url,
      arquivoMime: row.arquivo_mime,
      arquivoTamanho: row.arquivo_tamanho,

      criadoEm: row.criado_em,
      criadoPor: row.criado_por,
      criadoPorNome: row.criado_por_nome
    })));
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: 'Erro ao carregar comprovantes'
    });
  }
});

router.post('/:id/comprovantes', uploadComprovante.single('arquivo'), async (req, res) => {
  try {
    const { id } = req.params;

    if (!podeVisualizarUsuario(req, id)) {
      return res.status(403).json({
        message: 'Você não tem permissão para lançar pagamento para este usuário'
      });
    }

    const tipo = req.body.tipo || 'Comissão paga';
    const descricao = req.body.descricao || '';
    const valor = Number(req.body.valor || 0);
    const dataPagamento = req.body.dataPagamento || null;
    const vendaId = req.body.vendaId || null;

    if (!valor || valor <= 0) {
      return res.status(400).json({
        message: 'Informe o valor do pagamento'
      });
    }

    if (vendaId) {
      const pertence = await corretorPertenceVenda(vendaId, id);

      if (!pertence) {
        return res.status(400).json({
          message: 'Este corretor não pertence a esta venda'
        });
      }
    }

    const arquivoUrl = req.file ? `/uploads/comprovantes/${req.file.filename}` : null;

    const result = await pool.query(
      `
      INSERT INTO usuarios_comprovantes (
        usuario_id,
        corretor_id,
        venda_id,
        tipo,
        descricao,
        valor,
        data_pagamento,
        arquivo_nome,
        arquivo_url,
        arquivo_mime,
        arquivo_tamanho,
        criado_por
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      RETURNING *
      `,
      [
        id,
        id,
        vendaId,
        tipo,
        descricao,
        valor,
        dataPagamento,
        req.file ? req.file.originalname : null,
        arquivoUrl,
        req.file ? req.file.mimetype : null,
        req.file ? req.file.size : null,
        req.user.id
      ]
    );

    const row = result.rows[0];

    if (vendaId) {
      await recalcularStatusComissaoVendaCorretor(vendaId, id);
    }

    return res.status(201).json({
      id: row.id,
      usuarioId: row.usuario_id,
      corretorId: row.corretor_id,
      vendaId: row.venda_id,
      tipo: row.tipo,
      descricao: row.descricao,
      valor: Number(row.valor || 0),
      dataPagamento: row.data_pagamento,
      arquivoNome: row.arquivo_nome,
      arquivoUrl: row.arquivo_url,
      arquivoMime: row.arquivo_mime,
      arquivoTamanho: row.arquivo_tamanho,
      criadoEm: row.criado_em,
      criadoPor: row.criado_por
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: 'Erro ao lançar pagamento'
    });
  }
});

router.patch('/:id/dados-bancarios', async (req, res) => {
  try {
    const { id } = req.params;

    if (!somenteAdmin(req, res)) {
      return;
    }

    const {
      pixChave,
      pixTipo,
      bancoNome,
      bancoAgencia,
      bancoConta,
      bancoTipoConta,
      bancoTitularNome,
      bancoTitularDocumento
    } = req.body;

    const result = await pool.query(
      `
      UPDATE usuarios
      SET
        pix_chave = $1,
        pix_tipo = $2,
        banco_nome = $3,
        banco_agencia = $4,
        banco_conta = $5,
        banco_tipo_conta = $6,
        banco_titular_nome = $7,
        banco_titular_documento = $8,
        pix_atualizado_em = NOW(),
        pix_atualizado_por = $9,
        updated_at = NOW()
      WHERE id = $10
      RETURNING
        id,
        pix_chave,
        pix_tipo,
        banco_nome,
        banco_agencia,
        banco_conta,
        banco_tipo_conta,
        banco_titular_nome,
        banco_titular_documento,
        pix_atualizado_em,
        pix_atualizado_por
      `,
      [
        pixChave || null,
        pixTipo || null,
        bancoNome || null,
        bancoAgencia || null,
        bancoConta || null,
        bancoTipoConta || null,
        bancoTitularNome || null,
        bancoTitularDocumento || null,
        req.user.id,
        id
      ]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        message: 'Usuário não encontrado'
      });
    }

    const row = result.rows[0];

    return res.json({
      id: row.id,
      pixChave: row.pix_chave,
      pixTipo: row.pix_tipo,
      bancoNome: row.banco_nome,
      bancoAgencia: row.banco_agencia,
      bancoConta: row.banco_conta,
      bancoTipoConta: row.banco_tipo_conta,
      bancoTitularNome: row.banco_titular_nome,
      bancoTitularDocumento: row.banco_titular_documento,
      pixAtualizadoEm: row.pix_atualizado_em,
      pixAtualizadoPor: row.pix_atualizado_por
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: 'Erro ao atualizar dados bancários'
    });
  }
});

router.delete('/:id/comprovantes/:comprovanteId', async (req, res) => {
  try {
    const { id, comprovanteId } = req.params;

    const comprovanteResult = await pool.query(
      `
      SELECT
        id,
        usuario_id,
        venda_id,
        arquivo_url,
        criado_por
      FROM usuarios_comprovantes
      WHERE id = $1
        AND usuario_id = $2
      LIMIT 1
      `,
      [comprovanteId, id]
    );

    if (!comprovanteResult.rows.length) {
      return res.status(404).json({
        message: 'Comprovante não encontrado'
      });
    }

    const comprovante = comprovanteResult.rows[0];

    const podeExcluir =
      req.user.perfil === 'admin' ||
      String(comprovante.criado_por) === String(req.user.id);

    if (!podeExcluir) {
      return res.status(403).json({
        message: 'Você só pode excluir comprovantes anexados por você'
      });
    }

    await pool.query(
      `
      DELETE FROM usuarios_comprovantes
      WHERE id = $1
        AND usuario_id = $2
      `,
      [comprovanteId, id]
    );

    if (comprovante.arquivo_url) {
      const caminhoArquivo = path.join(
        __dirname,
        '..',
        '..',
        comprovante.arquivo_url.replace(/^\/+/, '')
      );

      if (fs.existsSync(caminhoArquivo)) {
        fs.unlinkSync(caminhoArquivo);
      }
    }

    if (comprovante.venda_id) {
  await recalcularStatusComissaoVendaCorretor(
    comprovante.venda_id,
    comprovante.usuario_id
  );
}

    return res.json({
      message: 'Comprovante excluído com sucesso'
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: 'Erro ao excluir comprovante'
    });
  }
});

router.get('/:id/vendas/:vendaId/pagamentos', async (req, res) => {
  try {
    const { id, vendaId } = req.params;

    if (!podeVisualizarUsuario(req, id)) {
      return res.status(403).json({
        message: 'Você não tem permissão para visualizar pagamentos deste usuário'
      });
    }

    const pertence = await corretorPertenceVenda(vendaId, id);

    if (!pertence) {
      return res.status(404).json({
        message: 'Venda não encontrada para este corretor'
      });
    }

    const result = await pool.query(
  `
  SELECT
    c.id,
    c.usuario_id,
    c.corretor_id,
    c.venda_id,
    c.tipo,
    c.descricao,
    c.valor,
    c.data_pagamento,
    c.arquivo_nome,
    c.arquivo_url,
    c.arquivo_mime,
    c.arquivo_tamanho,
    c.criado_em,
    c.criado_por,

    recebedor.nome AS corretor_nome,
    u.nome AS criado_por_nome

  FROM usuarios_comprovantes c
  LEFT JOIN usuarios recebedor ON recebedor.id = COALESCE(c.corretor_id, c.usuario_id)
  LEFT JOIN usuarios u ON u.id = c.criado_por

  WHERE c.venda_id = $1
    AND (
      c.usuario_id = $2
      OR c.corretor_id = $2
    )

  ORDER BY c.data_pagamento DESC NULLS LAST, c.criado_em DESC
  `,
  [vendaId, id]
);

    return res.json(result.rows.map(row => ({
      id: row.id,
      usuarioId: row.usuario_id,
      corretorId: row.corretor_id,
      vendaId: row.venda_id,
      corretorNome: row.corretor_nome || '-',
      tipo: row.tipo,
      descricao: row.descricao,
      valor: Number(row.valor || 0),
      dataPagamento: row.data_pagamento,
      arquivoNome: row.arquivo_nome,
      arquivoUrl: row.arquivo_url,
      arquivoMime: row.arquivo_mime,
      arquivoTamanho: row.arquivo_tamanho,
      criadoEm: row.criado_em,
      criadoPor: row.criado_por,
      criadoPorNome: row.criado_por_nome
    })));
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: 'Erro ao carregar pagamentos da venda'
    });
  }
});

router.patch('/:id/comprovantes/:comprovanteId/documento', uploadComprovante.single('arquivo'), async (req, res) => {
  try {
    const { id, comprovanteId } = req.params;

    if (!req.file) {
      return res.status(400).json({
        message: 'Envie o arquivo do documento'
      });
    }

    const comprovanteResult = await pool.query(
      `
      SELECT
        id,
        usuario_id,
        venda_id,
        criado_por,
        arquivo_url
      FROM usuarios_comprovantes
      WHERE id = $1
        AND usuario_id = $2
      LIMIT 1
      `,
      [comprovanteId, id]
    );

    if (!comprovanteResult.rows.length) {
      return res.status(404).json({
        message: 'Pagamento não encontrado'
      });
    }

    const comprovante = comprovanteResult.rows[0];

    const podeAlterar =
      req.user.perfil === 'admin' ||
      req.user.perfil === 'gerente' ||
      String(comprovante.criado_por) === String(req.user.id);

    if (!podeAlterar) {
      return res.status(403).json({
        message: 'Você não tem permissão para anexar documento neste pagamento'
      });
    }

    if (comprovante.arquivo_url) {
      const caminhoAntigo = path.join(
        __dirname,
        '..',
        '..',
        comprovante.arquivo_url.replace(/^\/+/, '')
      );

      if (fs.existsSync(caminhoAntigo)) {
        fs.unlinkSync(caminhoAntigo);
      }
    }

    const arquivoUrl = `/uploads/comprovantes/${req.file.filename}`;

    const result = await pool.query(
      `
      UPDATE usuarios_comprovantes
      SET
        arquivo_nome = $1,
        arquivo_url = $2,
        arquivo_mime = $3,
        arquivo_tamanho = $4
      WHERE id = $5
        AND usuario_id = $6
      RETURNING *
      `,
      [
        req.file.originalname,
        arquivoUrl,
        req.file.mimetype,
        req.file.size,
        comprovanteId,
        id
      ]
    );

    const row = result.rows[0];

    return res.json({
      id: row.id,
      usuarioId: row.usuario_id,
      corretorId: row.corretor_id,
      vendaId: row.venda_id,
      tipo: row.tipo,
      descricao: row.descricao,
      valor: Number(row.valor || 0),
      dataPagamento: row.data_pagamento,
      arquivoNome: row.arquivo_nome,
      arquivoUrl: row.arquivo_url,
      arquivoMime: row.arquivo_mime,
      arquivoTamanho: row.arquivo_tamanho,
      criadoEm: row.criado_em,
      criadoPor: row.criado_por
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: 'Erro ao anexar documento ao pagamento'
    });
  }
});

module.exports = router;