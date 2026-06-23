const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const { authMiddleware } = require('../middlewares/auth.middleware');

const router = express.Router();

const SENHA_PADRAO = '123456';

router.post('/login', async (req, res) => {
  try {
    const { email, senha } = req.body;

    if (!email || !senha) {
      return res.status(400).json({
        message: 'E-mail e senha são obrigatórios'
      });
    }

    const result = await pool.query(
      `
      SELECT
        id,
        nome,
        email,
        senha_hash,
        perfil,
        ativo,
        primeiro_acesso,
        deve_trocar_senha,
        filial_id,
        gerente_id
      FROM usuarios
      WHERE email = $1
      LIMIT 1
      `,
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        message: 'E-mail ou senha inválidos'
      });
    }

    const usuario = result.rows[0];

    if (!usuario.ativo) {
      return res.status(403).json({
        message: 'Usuário inativo'
      });
    }

    const senhaValida = await bcrypt.compare(senha, usuario.senha_hash);

    if (!senhaValida) {
      return res.status(401).json({
        message: 'E-mail ou senha inválidos'
      });
    }

    await pool.query(
      `
      UPDATE usuarios
      SET ultimo_login = NOW()
      WHERE id = $1
      `,
      [usuario.id]
    );

    const token = jwt.sign(
      {
        id: usuario.id,
        nome: usuario.nome,
        email: usuario.email,
        perfil: usuario.perfil,
        deveTrocarSenha: !!usuario.deve_trocar_senha
      },
      process.env.JWT_SECRET,
      { expiresIn: '8h' }
    );

    return res.json({
      token,
      usuario: {
        id: usuario.id,
        nome: usuario.nome,
        email: usuario.email,
        perfil: usuario.perfil,

        primeiroAcesso: !!usuario.primeiro_acesso,
        deveTrocarSenha: !!usuario.deve_trocar_senha,

        filialId: usuario.filial_id,
        gerenteId: usuario.gerente_id
      }
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: 'Erro ao fazer login'
    });
  }
});

router.post('/trocar-senha-primeiro-acesso', authMiddleware, async (req, res) => {
  try {
    const { senhaAtual, novaSenha, confirmarSenha } = req.body;

    if (!senhaAtual || !novaSenha || !confirmarSenha) {
      return res.status(400).json({
        message: 'Senha atual, nova senha e confirmação são obrigatórias'
      });
    }

    if (novaSenha.length < 6) {
      return res.status(400).json({
        message: 'A nova senha precisa ter no mínimo 6 caracteres'
      });
    }

    if (novaSenha !== confirmarSenha) {
      return res.status(400).json({
        message: 'A confirmação da senha não confere'
      });
    }

    if (novaSenha === SENHA_PADRAO) {
      return res.status(400).json({
        message: 'A nova senha não pode ser igual à senha padrão'
      });
    }

    const usuarioResult = await pool.query(
      `
      SELECT id, nome, email, senha_hash, perfil, ativo
      FROM usuarios
      WHERE id = $1
      LIMIT 1
      `,
      [req.user.id]
    );

    if (!usuarioResult.rows.length) {
      return res.status(404).json({
        message: 'Usuário não encontrado'
      });
    }

    const usuario = usuarioResult.rows[0];

    if (!usuario.ativo) {
      return res.status(403).json({
        message: 'Usuário inativo'
      });
    }

    const senhaAtualValida = await bcrypt.compare(senhaAtual, usuario.senha_hash);

    if (!senhaAtualValida) {
      return res.status(401).json({
        message: 'Senha atual inválida'
      });
    }

    const senhaHash = await bcrypt.hash(novaSenha, 10);

    const result = await pool.query(
      `
      UPDATE usuarios
      SET
        senha_hash = $1,
        primeiro_acesso = FALSE,
        deve_trocar_senha = FALSE,
        updated_at = NOW()
      WHERE id = $2
      RETURNING
        id,
        nome,
        email,
        perfil,
        primeiro_acesso,
        deve_trocar_senha,
        filial_id,
        gerente_id
      `,
      [senhaHash, req.user.id]
    );

    const atualizado = result.rows[0];

    const token = jwt.sign(
      {
        id: atualizado.id,
        nome: atualizado.nome,
        email: atualizado.email,
        perfil: atualizado.perfil,
        deveTrocarSenha: false
      },
      process.env.JWT_SECRET,
      { expiresIn: '8h' }
    );

    return res.json({
      message: 'Senha alterada com sucesso',
      token,
      usuario: {
        id: atualizado.id,
        nome: atualizado.nome,
        email: atualizado.email,
        perfil: atualizado.perfil,

        primeiroAcesso: !!atualizado.primeiro_acesso,
        deveTrocarSenha: !!atualizado.deve_trocar_senha,

        filialId: atualizado.filial_id,
        gerenteId: atualizado.gerente_id
      }
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: 'Erro ao trocar senha'
    });
  }
});

router.post('/seed-admin', async (req, res) => {
  try {
    const senhaHash = await bcrypt.hash(SENHA_PADRAO, 10);

    const result = await pool.query(
      `
      INSERT INTO usuarios (
        nome,
        email,
        senha_hash,
        perfil,
        ativo,
        primeiro_acesso,
        deve_trocar_senha
      )
      VALUES ($1, $2, $3, $4, TRUE, FALSE, FALSE)
      ON CONFLICT (email) DO UPDATE
      SET senha_hash = EXCLUDED.senha_hash,
          perfil = EXCLUDED.perfil,
          ativo = TRUE,
          primeiro_acesso = FALSE,
          deve_trocar_senha = FALSE,
          updated_at = NOW()
      RETURNING id, nome, email, perfil
      `,
      ['Administrador', 'admin@goldleste.com.br', senhaHash, 'admin']
    );

    return res.json({
      message: 'Admin criado/atualizado com sucesso',
      usuario: result.rows[0],
      acesso: {
        email: 'admin@goldleste.com.br',
        senha: SENHA_PADRAO
      }
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: 'Erro ao criar admin'
    });
  }
});

module.exports = router;