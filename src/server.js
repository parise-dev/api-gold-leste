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
const contasReceberRoutes = require('./routes/contas-receber.routes');

// Domínio de imóveis / portais (novos módulos)
const imoveisRoutes = require('./routes/imoveis.routes');
const integracoesRoutes = require('./routes/integracoes.routes');
const publicRoutes = require('./routes/public.routes');
const filaLeadsRoutes = require('./routes/fila-leads.routes');
const feedsRoutes = require('./routes/feeds.routes');
const captacoesImoveisRoutes = require('./routes/captacoes-imoveis.routes');
const { errorMiddleware } = require('./middlewares/error.middleware');

const app = express();

// Rate limiting usa req.ip; atrás do Nginx é preciso confiar no proxy.
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 1));

app.use(cors());
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '2mb' }));
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));
app.use('/auth', authRoutes);
app.use('/filiais', filiaisRoutes);
app.use('/usuarios', usuariosRoutes);
app.use('/vendas', vendasRoutes);
app.use('/contas-receber', contasReceberRoutes);
app.use('/dashboard', dashboardRoutes);

app.use('/imoveis', imoveisRoutes);
app.use('/integracoes', integracoesRoutes);
app.use('/captacoes-imoveis', captacoesImoveisRoutes);

// Fila de leads / próximos corretores (presença + rodízio).
app.use('/fila-leads', filaLeadsRoutes);

// Públicas (sem JWT, com rate limit próprio)
app.use('/public/feeds', feedsRoutes);
app.use('/public', publicRoutes);

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

// Tratamento central de erros — precisa ficar depois de todas as rotas.
app.use(errorMiddleware);

const PORT = process.env.PORT || 4000;

app.listen(PORT, () => {
  console.log(`🚀 API rodando na porta ${PORT}`);
});
