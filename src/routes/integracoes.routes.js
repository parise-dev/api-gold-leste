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
