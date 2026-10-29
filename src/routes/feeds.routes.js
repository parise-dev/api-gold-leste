const express = require('express');

const { asyncHandler } = require('../utils/async-handler');
const { rateLimitFeed } = require('../middlewares/rate-limit.middleware');
const { badRequest } = require('../utils/http-error');
const portaisService = require('../services/portais.service');

const router = express.Router();

/**
 * Feeds públicos consumidos pelos portais.
 *
 * Sem JWT (o portal é um robô externo), mas protegidos por:
 *   - token opaco de 48 caracteres na URL;
 *   - integração precisa estar habilitada;
 *   - rate limiting;
 *   - somente imóveis habilitados para o canal e válidos entram.
 *
 * GET /public/feeds/:portalSlug/:token.xml
 */
router.get(
  '/:portalSlug/:arquivo',
  rateLimitFeed,
  asyncHandler(async (req, res) => {
    const portalSlug = String(req.params.portalSlug).toLowerCase().slice(0, 40);
    const arquivo = String(req.params.arquivo);

    if (!arquivo.endsWith('.xml')) {
      throw badRequest('Formato de feed inválido. Utilize a URL terminada em .xml.');
    }

    const token = arquivo.slice(0, -4);

    if (!/^[a-f0-9]{16,64}$/i.test(token)) {
      throw badRequest('Token de feed inválido.');
    }

    const resultado = await portaisService.gerarFeed({ portalSlug, token });

    res.setHeader('Content-Type', resultado.contentType);
    res.setHeader('Cache-Control', 'public, max-age=600');
    res.setHeader('X-Total-Anuncios', String(resultado.totalAnuncios));

    res.send(resultado.conteudo);
  })
);

module.exports = router;
