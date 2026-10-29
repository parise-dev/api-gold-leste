const rateLimit = require('express-rate-limit');

function mensagem(texto) {
  return (req, res) => res.status(429).json({ message: texto });
}

/** Formulários públicos (interesse no imóvel, demonstração). */
const rateLimitFormularioPublico = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: Number(process.env.RATE_LIMIT_FORM_PUBLICO || 10),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: mensagem('Muitas solicitações em pouco tempo. Aguarde alguns minutos e tente novamente.')
});

/** Leitura pública (página do imóvel, busca pública). */
const rateLimitLeituraPublica = rateLimit({
  windowMs: 60 * 1000,
  limit: Number(process.env.RATE_LIMIT_LEITURA_PUBLICA || 120),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: mensagem('Limite de requisições atingido. Tente novamente em instantes.')
});

/** Feeds XML — poucos acessos legítimos por hora (portais). */
const rateLimitFeed = rateLimit({
  windowMs: 60 * 1000,
  limit: Number(process.env.RATE_LIMIT_FEED || 30),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: mensagem('Limite de requisições do feed atingido.')
});

/** Webhooks de leads de portais. */
const rateLimitWebhookLeads = rateLimit({
  windowMs: 60 * 1000,
  limit: Number(process.env.RATE_LIMIT_WEBHOOK_LEADS || 120),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: mensagem('Limite de requisições atingido.')
});

/** Upload de mídias (autenticado, mas custoso). */
const rateLimitUpload = rateLimit({
  windowMs: 60 * 1000,
  limit: Number(process.env.RATE_LIMIT_UPLOAD || 60),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: mensagem('Muitos uploads em sequência. Aguarde um instante.')
});

module.exports = {
  rateLimitFormularioPublico,
  rateLimitLeituraPublica,
  rateLimitFeed,
  rateLimitWebhookLeads,
  rateLimitUpload
};
