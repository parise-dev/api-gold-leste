require('dotenv').config();
const app = require('./app');
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`API Gold Leste na porta ${PORT}`);
  require('./services/meta-leads.service').iniciarWorker();
  require('./services/operacao/worker').iniciar();
});
