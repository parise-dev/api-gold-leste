const express = require('express');
const pool = require('../config/db');
const { authMiddleware, somentePerfis } = require('../middlewares/auth.middleware');

const router = express.Router();

router.use(authMiddleware);

function mapFilial(row) {
  return {
    id: row.id,

    name: row.nome,
    nome: row.nome,

    phone: row.telefone,
    telefone: row.telefone,

    address: row.endereco,
    endereco: row.endereco,

    ativo: row.ativo,
    hidden: !row.ativo,

    criadoEm: row.created_at,
    atualizadoEm: row.updated_at
  };
}

router.get('/', somentePerfis('admin', 'gerente'), async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT
        id,
        nome,
        telefone,
        endereco,
        ativo,
        created_at,
        updated_at
      FROM filiais
      ORDER BY nome ASC
      `
    );

    return res.json(result.rows.map(mapFilial));
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: 'Erro ao listar filiais'
    });
  }
});

router.post('/', somentePerfis('admin'), async (req, res) => {
  try {
    const nome = req.body.nome ?? req.body.name;
    const telefone = req.body.telefone ?? req.body.phone ?? null;
    const endereco = req.body.endereco ?? req.body.address ?? null;

    if (!nome || !String(nome).trim()) {
      return res.status(400).json({
        message: 'Nome da filial é obrigatório'
      });
    }

    const result = await pool.query(
      `
      INSERT INTO filiais (
        nome,
        telefone,
        endereco,
        ativo,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, TRUE, NOW(), NOW())
      RETURNING *
      `,
      [
        String(nome).trim(),
        telefone || null,
        endereco || null
      ]
    );

    return res.status(201).json(mapFilial(result.rows[0]));
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: 'Erro ao criar filial'
    });
  }
});

router.put('/:id', somentePerfis('admin'), async (req, res) => {
  try {
    const { id } = req.params;

    const nome = req.body.nome ?? req.body.name;
    const telefone = req.body.telefone ?? req.body.phone ?? null;
    const endereco = req.body.endereco ?? req.body.address ?? null;

    const ativo = typeof req.body.ativo === 'boolean'
      ? req.body.ativo
      : req.body.hidden !== undefined
        ? !req.body.hidden
        : true;

    if (!nome || !String(nome).trim()) {
      return res.status(400).json({
        message: 'Nome da filial é obrigatório'
      });
    }

    const result = await pool.query(
      `
      UPDATE filiais
      SET
        nome = $1,
        telefone = $2,
        endereco = $3,
        ativo = $4,
        updated_at = NOW()
      WHERE id = $5
      RETURNING *
      `,
      [
        String(nome).trim(),
        telefone || null,
        endereco || null,
        ativo,
        id
      ]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        message: 'Filial não encontrada'
      });
    }

    return res.json(mapFilial(result.rows[0]));
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: 'Erro ao atualizar filial'
    });
  }
});

router.delete('/:id', somentePerfis('admin'), async (req, res) => {
  const client = await pool.connect();

  try {
    const { id } = req.params;

    await client.query('BEGIN');

    const filialResult = await client.query(
      `
      SELECT id
      FROM filiais
      WHERE id = $1
      LIMIT 1
      `,
      [id]
    );

    if (!filialResult.rows.length) {
      await client.query('ROLLBACK');

      return res.status(404).json({
        message: 'Filial não encontrada'
      });
    }

    await client.query(
      `
      UPDATE usuarios
      SET
        filial_id = NULL,
        updated_at = NOW()
      WHERE filial_id = $1
      `,
      [id]
    );

    await client.query(
      `
      DELETE FROM filiais
      WHERE id = $1
      `,
      [id]
    );

    await client.query('COMMIT');

    return res.json({
      message: 'Filial excluída definitivamente'
    });
  } catch (error) {
    await client.query('ROLLBACK');

    console.error(error);

    return res.status(500).json({
      message: 'Erro ao excluir filial'
    });
  } finally {
    client.release();
  }
});

module.exports = router;