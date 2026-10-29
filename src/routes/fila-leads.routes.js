const express = require('express');

const { authMiddleware, somentePerfis } = require('../middlewares/auth.middleware');
const { asyncHandler } = require('../utils/async-handler');
const { exigirUuid } = require('../validators/imovel.validator');
const { notFound } = require('../utils/http-error');

const distribuicao = require('../services/lead-distribution.service');
const filaRepo = require('../repositories/lead-queue.repository');
const config = require('../config/lead-distribution.config');

const router = express.Router();

router.use(authMiddleware);

/**
 * Fila de Leads / Próximos Corretores.
 *
 * Presença: qualquer usuário autenticado bate o heartbeat (é o mesmo
 * mecanismo de "estou usando o sistema"); apenas os perfis da fila
 * entram no rodízio.
 *
 * Painel e operações de fila: gestão (admin/gerente), seguindo o mesmo
 * critério já usado em /integracoes.
 */
const gestao = somentePerfis('admin');

/**
 * Barra as rotas que dependem das tabelas da fila enquanto
 * sql/20260830_fila_leads.sql não tiver sido executado. Melhor um 503
 * explicando o que fazer do que um 500 de tabela inexistente.
 */
const exigirFila = asyncHandler(async (req, res, next) => {
  if (await filaRepo.filaDisponivel()) return next();

  return res.status(503).json({
    message:
      'Fila de leads ainda não instalada no banco. Execute sql/20260830_fila_leads.sql da API.',
    indisponivel: true
  });
});

// ---------------------------------------------------------------------
// PRESENÇA
// ---------------------------------------------------------------------
router.post(
  '/presenca',
  asyncHandler(async (req, res) => {
    const estado = await distribuicao.registrarPresenca(req.user);

    res.json({
      online: true,
      naFila: estado.naFila,
      entrouNaFila: estado.entrouNaFila,
      leadsPendentesDistribuidos: estado.leadsPendentesDistribuidos,
      proximoHeartbeatEmSegundos: config.HEARTBEAT_INTERVALO_SEGUNDOS
    });
  })
);

/** Logout / fechamento da aba: sai da fila imediatamente. */
router.post(
  '/presenca/sair',
  asyncHandler(async (req, res) => {
    await distribuicao.registrarSaida(req.user);
    res.json({ online: false });
  })
);

// ---------------------------------------------------------------------
// PAINEL
// ---------------------------------------------------------------------
router.get(
  '/',
  gestao,
  asyncHandler(async (req, res) => {
    res.json(await distribuicao.estadoDaFila());
  })
);

/** Somente os corretores online — usado por telas menores e integrações. */
router.get(
  '/online',
  gestao,
  exigirFila,
  asyncHandler(async (req, res) => {
    const estado = await distribuicao.estadoDaFila();

    res.json({
      total: estado.corretoresOnline,
      corretores: estado.fila
    });
  })
);

/** Espia o próximo da fila sem alterar nada. */
router.get(
  '/proximo',
  gestao,
  exigirFila,
  asyncHandler(async (req, res) => {
    const proximo = await filaRepo.proximoElegivel();

    if (!proximo) {
      return res.json({ proximo: null, mensagem: 'Nenhum corretor disponível no momento.' });
    }

    return res.json({
      proximo: {
        usuarioId: proximo.usuario_id,
        nome: proximo.nome,
        iniciais: distribuicao.montarIniciais(proximo.nome),
        posicao: 1
      }
    });
  })
);

router.get(
  '/pendentes',
  gestao,
  exigirFila,
  asyncHandler(async (req, res) => {
    const linhas = await filaRepo.leadsPendentes(req.query.limite);

    res.json(
      linhas.map((row) => ({
        id: row.id,
        nome: row.nome,
        email: row.email,
        telefone: row.telefone,
        origem: row.origem,
        portalSlug: row.portal_slug,
        imovelId: row.imovel_id,
        imovelCodigo: row.imovel_codigo,
        imovelTitulo: row.imovel_titulo,
        recebidoEm: row.recebido_em,
        aguardandoDesde: row.distribuicao_pendente_desde
      }))
    );
  })
);

router.get(
  '/historico',
  gestao,
  exigirFila,
  asyncHandler(async (req, res) => {
    const linhas = await filaRepo.historico({
      limite: req.query.limite,
      usuarioId: req.query.usuarioId || null,
      leadId: req.query.leadId || null
    });

    res.json(linhas.map(distribuicao.mapearHistorico));
  })
);

// ---------------------------------------------------------------------
// OPERAÇÕES
// ---------------------------------------------------------------------

/** Força a distribuição de um lead específico para o próximo da fila. */
router.post(
  '/leads/:id/distribuir',
  gestao,
  exigirFila,
  asyncHandler(async (req, res) => {
    const id = exigirUuid(req.params.id, 'lead');

    const resultado = await distribuicao.distribuirLead(id, {
      tipo: 'REDISTRIBUICAO',
      motivo: `Distribuição acionada manualmente por ${req.user.nome}.`
    });

    if (resultado.motivo === 'LEAD_INEXISTENTE') {
      throw notFound('Lead não encontrado.');
    }

    res.json({
      atribuido: resultado.atribuido,
      corretor: resultado.corretor,
      motivo: resultado.motivo
    });
  })
);

/** Escoa todos os leads que estavam aguardando corretor. */
router.post(
  '/pendentes/distribuir',
  gestao,
  exigirFila,
  asyncHandler(async (req, res) => {
    const distribuidos = await distribuicao.distribuirPendentes();

    res.json({
      total: distribuidos.length,
      leads: distribuidos.map((item) => ({
        leadId: item.lead.id,
        corretor: item.corretor
      }))
    });
  })
);

/** Atribuição manual — não corrompe a fila automática (ver service). */
router.post(
  '/leads/:id/atribuir',
  gestao,
  exigirFila,
  asyncHandler(async (req, res) => {
    const id = exigirUuid(req.params.id, 'lead');
    const usuarioId = exigirUuid(req.body.usuarioId || req.body.corretorId, 'corretor');

    const resultado = await distribuicao.atribuirManual({
      leadId: id,
      usuarioId,
      usuario: req.user,
      motivo: req.body.motivo || null
    });

    res.json({
      atribuido: true,
      corretor: resultado.corretor,
      posicao: resultado.posicao
    });
  })
);

module.exports = router;
