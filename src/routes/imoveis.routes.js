const express = require('express');

const { authMiddleware, somentePerfis } = require('../middlewares/auth.middleware');
const { uploadImagensImovel } = require('../middlewares/upload.middleware');
const { rateLimitUpload } = require('../middlewares/rate-limit.middleware');
const { asyncHandler } = require('../utils/async-handler');
const { resolverPaginacao, montarResultadoPaginado } = require('../utils/pagination');
const { notFound, badRequest, forbidden } = require('../utils/http-error');

const imoveisRepo = require('../repositories/imoveis.repository');
const midiasRepo = require('../repositories/imovel-midias.repository');
const logsRepo = require('../repositories/imovel-logs.repository');
const leadsRepo = require('../repositories/portal-leads.repository');

const imoveisService = require('../services/imoveis.service');
const midiasService = require('../services/imovel-midias.service');
const portaisService = require('../services/portais.service');
const scoreService = require('../services/imovel-score.service');
const leadIngress = require('../services/portal-lead-ingress.service');

const {
  exigirUuid,
  uuidOuNulo,
  numeroOuNulo,
  inteiroOuNulo,
  booleanoOuNulo,
  normalizarImovel,
  normalizarCaracteristicas,
  normalizarVisibilidade
} = require('../validators/imovel.validator');

const constantes = require('../validators/imovel.constants');

const router = express.Router();

router.use(authMiddleware);
router.use(somentePerfis('admin'));

// ---------------------------------------------------------------------
// Metadados do domínio (alimenta selects do front)
// ---------------------------------------------------------------------
router.get('/metadados', (req, res) => {
  res.json({
    tipos: constantes.TIPOS,
    finalidades: constantes.FINALIDADES,
    status: constantes.STATUS_COMERCIAIS,
    situacoes: constantes.SITUACOES,
    origensCarteira: constantes.ORIGENS_CARTEIRA,
    visibilidades: constantes.VISIBILIDADES,
    ufs: constantes.UFS,
    criteriosQualidade: scoreService.CRITERIOS_QUALIDADE.map((criterio) => ({
      chave: criterio.chave,
      label: criterio.label,
      peso: criterio.peso
    }))
  });
});

router.get(
  '/caracteristicas',
  asyncHandler(async (req, res) => {
    const pool = require('../config/db');

    const result = await pool.query(
      `SELECT slug, label, grupo, ordem FROM caracteristicas WHERE ativo ORDER BY ordem ASC, label ASC`
    );

    res.json(result.rows);
  })
);

// ---------------------------------------------------------------------
// Filtros de listagem
// ---------------------------------------------------------------------
function montarFiltrosDaQuery(query, usuario) {
  const listaOuNulo = (valor) => {
    if (!valor) return null;
    const itens = String(valor).split(',').map((item) => item.trim().toUpperCase()).filter(Boolean);
    return itens.length ? itens : null;
  };

  return {
    busca: query.busca || query.q || null,
    codigo: query.codigo || null,
    titulo: query.titulo || null,
    finalidade: query.finalidade ? String(query.finalidade).toUpperCase() : null,
    situacao: query.situacao ? String(query.situacao).toUpperCase() : null,
    origemCarteira: query.origemCarteira ? String(query.origemCarteira).toUpperCase() : null,
    tipo: query.tipo ? String(query.tipo).toUpperCase() : null,
    tipos: listaOuNulo(query.tipos),
    status: listaOuNulo(query.status),
    cidade: query.cidade || null,
    bairro: query.bairro || null,
    uf: query.uf ? String(query.uf).toUpperCase() : null,
    empreendimentoId: query.empreendimentoId || null,
    corretorId: uuidOuNulo(query.corretorId),
    captadorId: uuidOuNulo(query.captadorId),
    filialId: uuidOuNulo(query.filialId),
    vendaId: uuidOuNulo(query.vendaId),
    valorMinimo: numeroOuNulo(query.valorMinimo),
    valorMaximo: numeroOuNulo(query.valorMaximo),
    dormitoriosMinimo: inteiroOuNulo(query.dormitorios),
    vagasMinimo: inteiroOuNulo(query.vagas),
    areaMinima: numeroOuNulo(query.areaMinima),
    ativo: booleanoOuNulo(query.ativo),
    oportunidade: query.oportunidade === 'true' ? true : null,
    destaque: query.destaque === 'true' ? true : null,
    exclusivo: query.exclusivo === 'true' ? true : null,
    lancamento: query.lancamento === 'true' ? true : null,
    publicado: booleanoOuNulo(query.publicado),
    portalSlug: query.portal ? String(query.portal).toLowerCase().slice(0, 40) : null,
    comErroPortal: query.comErroPortal === 'true' ? true : null,
    semFotos: query.semFotos === 'true' ? true : null,
    qualidadeMaxima: inteiroOuNulo(query.qualidadeMaxima),
    favoritosDoUsuario: query.favoritos === 'true' ? usuario.id : null,
    disponiveis: query.disponiveis === 'true' ? true : null
  };
}

// GET /imoveis — carteira paginada
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const paginacao = resolverPaginacao(req.query);
    const filtros = montarFiltrosDaQuery(req.query, req.user);

    const resultado = await imoveisRepo.listar({
      usuario: req.user,
      filtros,
      ordenacao: req.query.ordenacao,
      ...paginacao
    });

    const favoritos = await imoveisRepo.idsFavoritos(
      req.user.id,
      resultado.rows.map((row) => row.id)
    );

    const items = resultado.rows.map((row) =>
      imoveisService.mapearResumo(row, { usuario: req.user, favoritos })
    );

    res.json(montarResultadoPaginado(items, resultado.total, paginacao));
  })
);

// GET /imoveis/contadores — cards de resumo da carteira
router.get(
  '/contadores',
  asyncHandler(async (req, res) => {
    const filtros = montarFiltrosDaQuery(req.query, req.user);
    const contadores = await imoveisRepo.contadores({ usuario: req.user, filtros });

    res.json(contadores);
  })
);

// GET /imoveis/oportunidades — home do corretor
router.get(
  '/oportunidades',
  asyncHandler(async (req, res) => {
    const paginacao = resolverPaginacao(req.query, 12);

    const filtros = {
      ...montarFiltrosDaQuery(req.query, req.user),
      // Regras fixas da vitrine: nunca traz vendido/alugado/inativo/suspenso.
      disponiveis: true,
      ativo: true,
      publicado: null
    };

    const foco = String(req.query.foco || '').toLowerCase();

    if (foco === 'exclusivos') filtros.exclusivo = true;
    if (foco === 'lancamentos') filtros.lancamento = true;
    if (foco === 'destaques') filtros.destaque = true;
    if (foco === 'favoritos') filtros.favoritosDoUsuario = req.user.id;
    if (foco === 'meus') filtros.corretorId = req.user.id;

    let ordenacao = req.query.ordenacao || 'oportunidade';

    if (foco === 'novidades') ordenacao = 'recentes';
    if (foco === 'comissao') ordenacao = 'oportunidade';

    const resultado = await imoveisRepo.listar({
      usuario: req.user,
      filtros,
      ordenacao,
      ...paginacao
    });

    const favoritos = await imoveisRepo.idsFavoritos(
      req.user.id,
      resultado.rows.map((row) => row.id)
    );

    const items = resultado.rows.map((row) => {
      const resumo = imoveisService.mapearResumo(row, { usuario: req.user, favoritos });

      // Comissão potencial só quando o corretor tem direito a ver o dado.
      const base = Number(row.valor_venda || row.valor_locacao || 0);
      const percentual = Number(row.comissao_percentual || 0);

      resumo.comissaoPotencial =
        resumo.comissaoPercentual !== null && base > 0 && percentual > 0
          ? Math.round(base * (percentual / 100) * 100) / 100
          : null;

      resumo.linkPublico = row.publicar_site ? `/imovel/${row.slug}` : null;

      return resumo;
    });

    res.json(montarResultadoPaginado(items, resultado.total, paginacao));
  })
);

// ---------------------------------------------------------------------
// Detalhe
// ---------------------------------------------------------------------
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = exigirUuid(req.params.id, 'imóvel');

    const row = await imoveisRepo.buscarPorId(id, { usuario: req.user });

    if (!row) {
      throw notFound('Imóvel não encontrado ou fora do seu escopo de acesso.');
    }

    const [midias, caracteristicas, visibilidade, portais, leads, historico] = await Promise.all([
      midiasRepo.listar(id),
      imoveisRepo.listarCaracteristicas(id),
      imoveisRepo.listarVisibilidade(id),
      portaisService.listarPortaisDoImovel(id),
      leadsRepo.listarPorImovel(id, 20),
      logsRepo.listar(id, 30)
    ]);

    const qualidade = scoreService.calcularQualidade(row, {
      totalFotos: midias.filter((midia) => midia.tipo === 'IMAGEM').length,
      temCapa: midias.some((midia) => midia.capa),
      totalCaracteristicas: caracteristicas.length
    });

    const favoritos = await imoveisRepo.idsFavoritos(req.user.id, [id]);

    const detalhe = imoveisService.mapearDetalhe(
      row,
      {
        midias: midias.map(imoveisService.mapearMidia),
        caracteristicas,
        visibilidade,
        qualidade,
        portais,
        leads: leads.map(leadIngress.mapearLead),
        historico
      },
      req.user
    );

    detalhe.favorito = favoritos.has(id);
    detalhe.podeEditar = imoveisRepo.podeEditar(req.user, row);
    detalhe.linkPublico = row.publicar_site ? `/imovel/${row.slug}` : null;

    res.json(detalhe);
  })
);

// ---------------------------------------------------------------------
// Criação / edição
// ---------------------------------------------------------------------
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const dados = normalizarImovel(req.body, { parcial: false });
    const captacaoId = req.body.captacaoId
      ? exigirUuid(req.body.captacaoId, 'captação')
      : null;

    const caracteristicas = normalizarCaracteristicas(req.body.caracteristicas);
    const visibilidade = normalizarVisibilidade(req.body.visibilidadeDetalhe);

    const id = await imoveisService.criar({
      dados,
      caracteristicas,
      visibilidade,
      captacaoId,
      usuario: req.user
    });

    const row = await imoveisRepo.buscarPorId(id, { ignorarEscopo: true });

    res.status(201).json(imoveisService.mapearDetalhe(row, {}, req.user));
  })
);

router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = exigirUuid(req.params.id, 'imóvel');

    const dados = normalizarImovel(req.body, { parcial: false });
    const caracteristicas = normalizarCaracteristicas(req.body.caracteristicas);
    const visibilidade = normalizarVisibilidade(req.body.visibilidadeDetalhe);

    // Prioridade manual é decisão de gestão.
    if (req.user.perfil === 'corretor') {
      delete dados.prioridade_manual;
    }

    // Vínculos que o formulário não edita não podem ser apagados só por
    // não terem sido enviados no corpo do PUT. Sem isso, salvar o
    // cadastro desvinculava o imóvel da venda e perdia a referência do
    // proprietário no sistema legado.
    for (const [campo, coluna] of [
      ['vendaId', 'venda_id'],
      ['proprietarioLegadoId', 'proprietario_legado_id'],
      ['subtipo', 'subtipo']
    ]) {
      if (!Object.prototype.hasOwnProperty.call(req.body, campo)) {
        delete dados[coluna];
      }
    }

    await imoveisService.atualizar({
      id,
      dados,
      caracteristicas,
      visibilidade,
      usuario: req.user
    });

    const row = await imoveisRepo.buscarPorId(id, { ignorarEscopo: true });

    res.json(imoveisService.mapearDetalhe(row, {}, req.user));
  })
);

router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = exigirUuid(req.params.id, 'imóvel');

    const dados = normalizarImovel(req.body, { parcial: true });

    if (req.user.perfil === 'corretor') {
      delete dados.prioridade_manual;
    }

    const caracteristicas = req.body.caracteristicas
      ? normalizarCaracteristicas(req.body.caracteristicas)
      : null;

    const visibilidade = req.body.visibilidadeDetalhe
      ? normalizarVisibilidade(req.body.visibilidadeDetalhe)
      : null;

    await imoveisService.atualizar({
      id,
      dados,
      caracteristicas,
      visibilidade,
      usuario: req.user
    });

    const row = await imoveisRepo.buscarPorId(id, { ignorarEscopo: true });

    res.json(imoveisService.mapearDetalhe(row, {}, req.user));
  })
);

router.patch(
  '/:id/status',
  asyncHandler(async (req, res) => {
    const id = exigirUuid(req.params.id, 'imóvel');
    const status = String(req.body.status || '').toUpperCase();

    if (!constantes.STATUS_COMERCIAIS.includes(status)) {
      throw badRequest(
        `Status inválido. Valores aceitos: ${constantes.STATUS_COMERCIAIS.join(', ')}.`
      );
    }

    const atualizado = await imoveisService.alterarStatus({ id, status, usuario: req.user });

    res.json({ id: atualizado.id, status: atualizado.status });
  })
);

// Soft delete — imóvel com histórico nunca some do banco.
router.delete(
  '/:id',
  somentePerfis('admin', 'gerente'),
  asyncHandler(async (req, res) => {
    const id = exigirUuid(req.params.id, 'imóvel');

    const removido = await imoveisService.inativar({ id, usuario: req.user });

    if (!removido) throw notFound('Imóvel não encontrado.');

    res.json({
      message: `Imóvel ${removido.codigo} inativado. O histórico foi preservado.`,
      id: removido.id
    });
  })
);

router.post(
  '/:id/favorito',
  asyncHandler(async (req, res) => {
    const id = exigirUuid(req.params.id, 'imóvel');

    const row = await imoveisRepo.buscarPorId(id, { usuario: req.user });
    if (!row) throw notFound('Imóvel não encontrado ou fora do seu escopo de acesso.');

    const resultado = await imoveisRepo.alternarFavorito(id, req.user.id);

    res.json(resultado);
  })
);

router.get(
  '/:id/historico',
  asyncHandler(async (req, res) => {
    const id = exigirUuid(req.params.id, 'imóvel');

    const row = await imoveisRepo.buscarPorId(id, { usuario: req.user });
    if (!row) throw notFound('Imóvel não encontrado ou fora do seu escopo de acesso.');

    res.json(await logsRepo.listar(id, req.query.limite));
  })
);

// ---------------------------------------------------------------------
// MÍDIAS
// ---------------------------------------------------------------------
async function garantirEdicao(req) {
  const id = exigirUuid(req.params.id, 'imóvel');
  const imovel = await imoveisRepo.buscarBruto(id);

  if (!imovel) throw notFound('Imóvel não encontrado.');

  if (!imoveisRepo.podeEditar(req.user, imovel)) {
    throw forbidden('Você não tem permissão para alterar este imóvel.');
  }

  return imovel;
}

router.get(
  '/:id/midias',
  asyncHandler(async (req, res) => {
    const id = exigirUuid(req.params.id, 'imóvel');

    const row = await imoveisRepo.buscarPorId(id, { usuario: req.user });
    if (!row) throw notFound('Imóvel não encontrado ou fora do seu escopo de acesso.');

    const midias = await midiasRepo.listar(id);

    res.json(midias.map(imoveisService.mapearMidia));
  })
);

router.post(
  '/:id/midias',
  rateLimitUpload,
  uploadImagensImovel.array('arquivos', 20),
  asyncHandler(async (req, res) => {
    const imovel = await garantirEdicao(req);

    const arquivos = req.files || [];

    if (!arquivos.length) {
      throw badRequest('Envie ao menos um arquivo no campo "arquivos".');
    }

    const enviadas = [];
    const falhas = [];

    for (const arquivo of arquivos) {
      try {
        const midia = await midiasService.enviarImagem({
          imovelId: imovel.id,
          arquivo,
          usuario: req.user,
          legenda: req.body.legenda,
          altText: req.body.altText
        });

        enviadas.push(imoveisService.mapearMidia(midia));
      } catch (error) {
        // Falha individual não derruba o lote, mas é reportada ao usuário.
        falhas.push({
          arquivo: arquivo.originalname,
          mensagem: error.message,
          status: error.status || 500
        });

        console.error(`[imoveis] Falha ao enviar "${arquivo.originalname}":`, error);
      }
    }

    await imoveisService.recalcularScores(imovel.id);

    const status = enviadas.length ? (falhas.length ? 207 : 201) : 502;

    res.status(status).json({
      enviadas,
      falhas,
      message: falhas.length
        ? `${enviadas.length} foto(s) enviada(s), ${falhas.length} com erro.`
        : `${enviadas.length} foto(s) enviada(s).`
    });
  })
);

router.post(
  '/:id/midias/externa',
  asyncHandler(async (req, res) => {
    const imovel = await garantirEdicao(req);

    const midia = await midiasService.adicionarMidiaExterna({
      imovelId: imovel.id,
      tipo: String(req.body.tipo || '').toUpperCase(),
      url: req.body.url,
      legenda: req.body.legenda,
      usuario: req.user
    });

    res.status(201).json(imoveisService.mapearMidia(midia));
  })
);

router.put(
  '/:id/midias/ordem',
  asyncHandler(async (req, res) => {
    const imovel = await garantirEdicao(req);

    const ordem = Array.isArray(req.body.ordem) ? req.body.ordem : req.body.midiaIds;

    if (!Array.isArray(ordem)) {
      throw badRequest('Envie o campo "ordem" com a lista de IDs das mídias.');
    }

    const midias = await midiasService.reordenar({
      imovelId: imovel.id,
      ordemIds: ordem,
      usuario: req.user
    });

    res.json(midias.map(imoveisService.mapearMidia));
  })
);

router.patch(
  '/:id/midias/:mediaId/capa',
  asyncHandler(async (req, res) => {
    const imovel = await garantirEdicao(req);
    const mediaId = exigirUuid(req.params.mediaId, 'mídia');

    const midia = await midiasService.definirCapa({
      imovelId: imovel.id,
      mediaId,
      usuario: req.user
    });

    await imoveisService.recalcularScores(imovel.id);

    res.json(imoveisService.mapearMidia(midia));
  })
);

router.patch(
  '/:id/midias/:mediaId',
  asyncHandler(async (req, res) => {
    const imovel = await garantirEdicao(req);
    const mediaId = exigirUuid(req.params.mediaId, 'mídia');

    const dados = {};

    if (req.body.legenda !== undefined) dados.legenda = req.body.legenda || null;
    if (req.body.altText !== undefined) dados.alt_text = req.body.altText || null;
    if (req.body.publica !== undefined) dados.publica = !!req.body.publica;

    if (!Object.keys(dados).length) {
      throw badRequest('Nada para atualizar. Envie legenda, altText ou publica.');
    }

    const atual = await midiasRepo.buscarPorId(imovel.id, mediaId);
    if (!atual) throw notFound('Mídia não encontrada para este imóvel.');

    const midia = await midiasRepo.atualizar(mediaId, dados);

    res.json(imoveisService.mapearMidia(midia));
  })
);

router.delete(
  '/:id/midias/:mediaId',
  asyncHandler(async (req, res) => {
    const imovel = await garantirEdicao(req);
    const mediaId = exigirUuid(req.params.mediaId, 'mídia');

    const resultado = await midiasService.removerMidia({
      imovelId: imovel.id,
      mediaId,
      usuario: req.user
    });

    await imoveisService.recalcularScores(imovel.id);

    res.json(resultado);
  })
);

// ---------------------------------------------------------------------
// PORTAIS DO IMÓVEL
// ---------------------------------------------------------------------
router.get(
  '/:id/portais',
  asyncHandler(async (req, res) => {
    const id = exigirUuid(req.params.id, 'imóvel');

    const row = await imoveisRepo.buscarPorId(id, { usuario: req.user });
    if (!row) throw notFound('Imóvel não encontrado ou fora do seu escopo de acesso.');

    res.json(await portaisService.listarPortaisDoImovel(id));
  })
);

router.post(
  '/:id/portais/:portalId/validar',
  somentePerfis('admin', 'gerente'),
  asyncHandler(async (req, res) => {
    const imovel = await garantirEdicao(req);
    const portalId = exigirUuid(req.params.portalId, 'portal');

    res.json(
      await portaisService.validarImovelNoPortal({ imovelId: imovel.id, portalId })
    );
  })
);

router.patch(
  '/:id/portais/:portalId',
  somentePerfis('admin', 'gerente'),
  asyncHandler(async (req, res) => {
    const imovel = await garantirEdicao(req);
    const portalId = exigirUuid(req.params.portalId, 'portal');

    const vinculo = await portaisService.alterarPublicacao({
      imovelId: imovel.id,
      portalId,
      habilitado: !!req.body.habilitado,
      tipoPublicacao: req.body.tipoPublicacao,
      usuario: req.user
    });

    res.json({
      portalId: vinculo.portal_id,
      habilitado: vinculo.habilitado,
      status: vinculo.status,
      tipoPublicacao: vinculo.tipo_publicacao,
      erros: vinculo.erros || [],
      ultimoErro: vinculo.ultimo_erro,
      ultimaValidacaoEm: vinculo.ultima_validacao_em
    });
  })
);

module.exports = router;
