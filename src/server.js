const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const pool = require('./config/db');
const authRoutes = require('./routes/auth.routes');
const usuariosRoutes = require('./routes/usuarios.routes');
const vendasRoutes = require('./routes/vendas.routes');
const dashboardRoutes = require('./routes/dashboard.routes');
const filiaisRoutes = require('./routes/filiais.routes');
const app = express();

app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));
app.use('/auth', authRoutes);
app.use('/filiais', filiaisRoutes);
app.use('/usuarios', usuariosRoutes);
app.use('/vendas', vendasRoutes);
app.use('/dashboard', dashboardRoutes);

app.get('/', async (req, res) => {
  res.json({
    ok: true,
    message: 'API Gold Leste rodando'
  });
});

app.get('/teste-db', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW() as agora');

    res.json({
      ok: true,
      message: 'Banco conectado com sucesso',
      data: result.rows[0]
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      ok: false,
      message: 'Erro ao conectar no banco',
      error: error.message
    });
  }
});

const PORT = process.env.PORT || 4000;

app.listen(PORT, () => {
  console.log(`🚀 API rodando na porta ${PORT}`);
});