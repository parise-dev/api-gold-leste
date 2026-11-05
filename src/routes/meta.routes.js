const express = require('express');
const { authMiddleware, somentePerfis } = require('../middlewares/auth.middleware');
const { asyncHandler } = require('../utils/async-handler');
const { rateLimitWebhookLeads } = require('../middlewares/rate-limit.middleware');
const { config } = require('../integrations/meta/graph');
const meta = require('../services/meta.service');
const leads = require('../services/meta-leads.service');
const router = express.Router();

// Montada antes de express.json: a assinatura usa exatamente os bytes recebidos.
const webhookRouter = express.Router();
webhookRouter.get('/webhook', (req, res) => {
  const c = config();
  if (c.verifyToken && req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === c.verifyToken &&
      typeof req.query['hub.challenge'] === 'string') return res.status(200).type('text/plain').send(req.query['hub.challenge']);
  return res.sendStatus(403);
});
webhookRouter.post('/webhook', rateLimitWebhookLeads, express.raw({ type: 'application/json', limit: '2mb' }), asyncHandler(async (req, res) => {
  if (!Buffer.isBuffer(req.body)) return res.status(415).json({ message: 'Use application/json.' });
  let body;
  try { body = JSON.parse(req.body.toString('utf8')); } catch (_) { return res.sendStatus(400); }
  res.status(200).json(await leads.receber(req.body, req.headers['x-hub-signature-256'], body));
}));
webhookRouter.get('/callback', asyncHandler(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  // Somente destino fixo do servidor, sem aceitar redirect do cliente.
  if (!process.env.FRONTEND_URL) return res.status(503).send('Configure FRONTEND_URL no servidor.');
  try {
    await meta.callback(req.query);
    return res.redirect(303, `${process.env.FRONTEND_URL.replace(/\/+$/, '')}/integracoes/facebook?meta=conectado`);
  } catch (_) {
    return res.redirect(303, `${process.env.FRONTEND_URL.replace(/\/+$/, '')}/integracoes/facebook?meta=erro`);
  }
}));

router.use(authMiddleware, somentePerfis('admin'));
router.use((req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
router.get('/status', asyncHandler(async (req, res) => res.json(await meta.status())));
router.post('/conectar', asyncHandler(async (req, res) => res.json(await meta.iniciarOAuth(req.user))));
router.get('/negocios', asyncHandler(async (req, res) => res.json(await meta.negocios())));
router.get('/contas', asyncHandler(async (req, res) => res.json(await meta.contas(req.query.businessId))));
router.get('/paginas', asyncHandler(async (req, res) => res.json(await meta.paginas())));
router.post('/paginas/:id/assinar', asyncHandler(async (req, res) => res.json(await meta.assinarPagina(req.params.id))));
router.get('/paginas/:id/formularios', asyncHandler(async (req, res) => res.json(await meta.formularios(req.params.id))));
router.post('/paginas/:id/formularios/:formId/recuperar', asyncHandler(async (req, res) => res.json(await meta.recuperarLeads(req.params.id, req.params.formId))));
router.get('/contas/:id/campanhas', asyncHandler(async (req, res) => res.json(await meta.campanhas(req.params.id))));
router.get('/contas/:id/custos', asyncHandler(async (req, res) => res.json(await meta.custos(req.params.id, req.query.desde, req.query.ate))));
router.post('/contas/:id/campanhas', asyncHandler(async (req, res) => res.status(201).json(await meta.criarCampanha(req.params.id, req.body, req.user))));
router.patch('/contas/:id/campanhas/:campaignId', asyncHandler(async (req, res) => res.json(await meta.editarCampanha(req.params.id, req.params.campaignId, req.body, req.user))));
router.post('/leads/processar', asyncHandler(async (req, res) => { await leads.rodada(); res.json({ ok: true }); }));
module.exports = { router, webhookRouter };
