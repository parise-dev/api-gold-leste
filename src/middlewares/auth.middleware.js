const jwt = require('jsonwebtoken');
const pool = require('../config/db');

const JWT_SECRET = process.env.JWT_SECRET || 'gold_leste_secret';

async function authMiddleware(req, res, next) {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      return res.status(401).json({
        message: 'Token não informado'
      });
    }

    const parts = authHeader.split(' ');

    if (parts.length !== 2) {
      return res.status(401).json({
        message: 'Token inválido'
      });
    }

    const [scheme, token] = parts;

    if (!/^Bearer$/i.test(scheme)) {
      return res.status(401).json({
        message: 'Token mal formatado'
      });
    }

    const decoded = jwt.verify(token, JWT_SECRET);

    const result = await pool.query(
      `
      SELECT
        id,
        nome,
        email,
        perfil,
        ativo
      FROM usuarios
      WHERE id = $1
      LIMIT 1
      `,
      [decoded.id]
    );

    if (!result.rows.length) {
      return res.status(401).json({
        message: 'Usuário não encontrado ou sessão inválida'
      });
    }

    const usuario = result.rows[0];

    if (!usuario.ativo) {
      return res.status(403).json({
        message: 'Usuário inativo. Acesso bloqueado.'
      });
    }

    req.user = {
      id: usuario.id,
      nome: usuario.nome,
      email: usuario.email,
      perfil: usuario.perfil
    };

    next();
  } catch (error) {
    return res.status(401).json({
      message: 'Token inválido ou expirado'
    });
  }
}

function somentePerfis(...perfisPermitidos) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        message: 'Usuário não autenticado'
      });
    }

    if (!perfisPermitidos.includes(req.user.perfil)) {
      return res.status(403).json({
        message: 'Você não tem permissão para acessar este recurso'
      });
    }

    next();
  };
}

module.exports = {
  authMiddleware,
  somentePerfis
};