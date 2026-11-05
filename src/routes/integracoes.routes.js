const express = require('express');

const { authMiddleware, somentePerfis } = require('../middlewares/auth.middleware');
const { asyncHandler } = require('../utils/async-handler');
const { resolverPaginacao, montarResultadoPaginado } = require('../utils/pagination');
const { exigirUuid } = require('../validators/imovel.validator');

const portaisService = require('../services/portais.service');
const leadsRepo = require('../repositories/portal-leads.repository');
const leadIngress = require('../services/portal-lead-ingress.service');
const minio = require('../services/minio.service');
const imagem = require('../services/imagem.service');

const router = express.Router();

router.use(authMiddleware);
router.use(somentePerfis('admin'));

router.get('/portais/:id/feed/previa', asyncHandler(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(await require('../services/feed-safety.service').previa(exigirUuid(req.params.id, 'portal')));
}));
router.post('/portais/:id/feed/aprovar', asyncHandler(async (req, res) => {
  res.json(await require('../services/feed-safety.service').aprovar(exigirUuid(req.params.id, 'portal'), req.body, req.user));
}));
// Mapeia o código original do integrador antigo. Não usa external_id, que
// pode conter o ID interno do portal, diferente do ListingID do XML.
router.put('/portais/:id/feed/codigos', asyncHandler(async (req, res) => {
  const { badRequest, conflict } = require('../utils/http-error');
  const pool = require('../config/db');
  const portalId = exigirUuid(req.params.id, 'portal');
  const itens = req.body.itens;
  if (!Array.isArray(itens) || !itens.length || itens.length > 10000) throw badRequest('Informe a lista de imóveis e códigos originais.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const pi = (await client.query('SELECT feed_versao_id FROM portal_integracoes WHERE portal_id=$1 AND filial_id IS NULL FOR UPDATE', [portalId])).rows[0];
    if (!pi || pi.feed_versao_id) throw conflict('Mapeamento permitido antes da primeira aprovação do feed.');
    for (const item of itens) {
      const imovelId = exigirUuid(item.imovelId, 'imóvel');
      if (typeof item.listingId !== 'string' || !/^[^<>\x00-\x1f]{1,50}$/.test(item.listingId) || item.listingId.trim() !== item.listingId) throw badRequest('ListingID inválido.');
      const r = await client.query('UPDATE imovel_portais SET listing_id_exportacao=$3 WHERE portal_id=$1 AND imovel_id=$2 RETURNING id', [portalId, imovelId, item.listingId]);
      if (!r.rowCount) throw badRequest('Selecione o imóvel para o portal antes de mapear seu código.');
    }
    await client.query('COMMIT');
    res.json({ ok: true, total: itens.length });
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}));

/**
 * Central de integrações.
 * Configuração de portal é operação de gestão: admin e gerente.
 * Corretor não configura credencial de portal (regra do produto).
 */
const gestao = somentePerfis('admin');

router.get(
  '/portais',
  gestao,
  asyncHandler(async (req, res) => {
    res.json(await portaisService.listar());
  })
);

/** Catálogo dos adapters: o que cada portal realmente suporta hoje. */
router.get('/portais/catalogo', gestao, (req, res) => {
  res.json(portaisService.catalogoAdapters());
});

router.get(
  '/portais/:id',
  gestao,
  asyncHandler(async (req, res) => {
    const id = exigirUuid(req.params.id, 'portal');
    res.json(await portaisService.detalhar(id));
  })
);

// Só admin altera configuração/credenciais de portal.
router.put(
  '/portais/:id',
  somentePerfis('admin'),
  asyncHandler(async (req, res) => {
    const id = exigirUuid(req.params.id, 'portal');

    res.json(
      await portaisService.salvarConfiguracao({ portalId: id, body: req.body, usuario: req.user })
    );
  })
);

router.post(
  '/portais/:id/testar',
  gestao,
  asyncHandler(async (req, res) => {
    const id = exigirUuid(req.params.id, 'portal');

    const resultado = await portaisService.testar({ portalId: id, usuario: req.user });

    res.status(resultado.ok ? 200 : 422).json(resultado);
  })
);

router.get(
  '/portais/:id/logs',
  gestao,
  asyncHandler(async (req, res) => {
    const id = exigirUuid(req.params.id, 'portal');

    const logs = await portaisService.listarLogs(id, {
      limite: req.query.limite,
      imovelId: req.query.imovelId || null
    });

    res.json(logs);
  })
);

// ---------------------------------------------------------------------
// Leads recebidos (portais + site público)
// ---------------------------------------------------------------------
router.get(
  '/leads',
  asyncHandler(async (req, res) => {
    const paginacao = resolverPaginacao(req.query, 25);

    const resultado = await leadsRepo.listar({
      usuario: req.user,
      filtros: {
        imovelId: req.query.imovelId || null,
        portalSlug: req.query.portal || null,
        origem: req.query.origem ? String(req.query.origem).toUpperCase() : null,
        status: req.query.status ? String(req.query.status).toUpperCase() : null,
        busca: req.query.busca || null
      },
      ...paginacao
    });

    res.json(
      montarResultadoPaginado(
        resultado.rows.map(leadIngress.mapearLead),
        resultado.total,
        paginacao
      )
    );
  })
);

router.get(
  '/leads/resumo',
  gestao,
  asyncHandler(async (req, res) => {
    res.json(await leadsRepo.resumoPorPortal());
  })
);

router.post(
  '/leads/:id/atendimento',
  asyncHandler(async (req, res) => {
    const id = exigirUuid(req.params.id, 'lead');

    const lead = await leadIngress.marcarPrimeiroAtendimento(id, req.user);

    if (!lead) {
      return res.status(404).json({ message: 'Lead não encontrado.' });
    }

    return res.json(leadIngress.mapearLead(lead));
  })
);

// ---------------------------------------------------------------------
// Diagnóstico do armazenamento (sem expor segredo algum)
// ---------------------------------------------------------------------
router.get(
  '/armazenamento',
  gestao,
  asyncHandler(async (req, res) => {
    const resumo = minio.resumoConfiguracao();

    let conexao = { ok: false, mensagem: 'Não testado.' };

    if (resumo.credenciaisConfiguradas) {
      try {
        conexao = await minio.testarConexao();
      } catch (error) {
        conexao = { ok: false, mensagem: error.message };
      }
    } else {
      conexao = {
        ok: false,
        mensagem: 'MINIO_ACCESS_KEY/MINIO_SECRET_KEY não configuradas no ambiente da API.'
      };
    }

    res.json({
      minio: resumo,
      conexao,
      processamentoImagem: {
        disponivel: imagem.disponivel(),
        motivo: imagem.disponivel() ? null : imagem.motivoIndisponivel(),
        larguraWeb: imagem.LARGURA_WEB,
        larguraThumb: imagem.LARGURA_THUMB
      }
    });
  })
);

module.exports = router;
