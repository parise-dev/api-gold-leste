const express = require('express');
const pool = require('../config/db');

const { asyncHandler } = require('../utils/async-handler');
const { notFound, badRequest } = require('../utils/http-error');
const { resolverPaginacao, montarResultadoPaginado } = require('../utils/pagination');
const { limparTexto, sanitizarPayload, hashIp } = require('../utils/sanitize');
const { emailOuNulo, telefoneOuNulo, numeroOuNulo, inteiroOuNulo } = require('../validators/imovel.validator');

const {
  rateLimitFormularioPublico,
  rateLimitLeituraPublica,
  rateLimitWebhookLeads
} = require('../middlewares/rate-limit.middleware');

const imoveisRepo = require('../repositories/imoveis.repository');
const midiasRepo = require('../repositories/imovel-midias.repository');
const imoveisService = require('../services/imoveis.service');
const leadIngress = require('../services/portal-lead-ingress.service');

const router = express.Router();

/**
 * Rotas públicas — SEM JWT.
 * Regras aplicadas em todas elas:
 *   - rate limiting;
 *   - validação e sanitização da entrada;
 *   - nenhum dado interno do imóvel é devolvido;
 *   - honeypot nos formulários.
 */

// ---------------------------------------------------------------------
// Busca pública de imóveis (usada pela landing e por links compartilhados)
// ---------------------------------------------------------------------
router.get(
  '/imoveis',
  rateLimitLeituraPublica,
  asyncHandler(async (req, res) => {
    const paginacao = resolverPaginacao(req.query, 12);

    const params = [];
    const where = [
      'i.deleted_at IS NULL',
      'i.ativo = TRUE',
      'i.publicar_site = TRUE',
      `i.finalidade IN ('VENDA', 'VENDA_LOCACAO')`,
      'i.valor_venda IS NOT NULL',
      `i.status NOT IN ('VENDIDO', 'ALUGADO', 'SUSPENSO', 'INATIVO')`
    ];

    if (req.query.cidade) {
      params.push(`%${limparTexto(req.query.cidade, 120)}%`);
      where.push(`i.cidade ILIKE $${params.length}`);
    }

    if (req.query.bairro) {
      params.push(`%${limparTexto(req.query.bairro, 120)}%`);
      where.push(`i.bairro ILIKE $${params.length}`);
    }

    if (req.query.tipo) {
      params.push(String(req.query.tipo).toUpperCase().slice(0, 40));
      where.push(`i.tipo = $${params.length}`);
    }

    // Busca pelo código do imóvel (campo "Cód." do site).
    if (req.query.codigo) {
      params.push(limparTexto(req.query.codigo, 30));
      where.push(`(LOWER(i.codigo) = LOWER($${params.length})
                   OR LOWER(i.referencia_externa) = LOWER($${params.length}))`);
    }

    // Busca livre por título, bairro ou cidade.
    if (req.query.busca) {
      params.push(`%${limparTexto(req.query.busca, 120)}%`);
      const idx = params.length;
      where.push(`(i.titulo ILIKE $${idx} OR i.bairro ILIKE $${idx} OR i.cidade ILIKE $${idx})`);
    }

    // A operação pública da Gold Leste é exclusivamente de venda.
    // O parâmetro finalidade pode continuar chegando de links antigos,
    // mas nunca abre imóveis cadastrados apenas para locação.

    // Atalho usado pelo site público para a vitrine de lançamentos.
    const somenteLancamentos = String(req.query.lancamento ?? req.query.lancamentos ?? '')
      .trim()
      .toLowerCase();

    if (['1', 'true', 'sim'].includes(somenteLancamentos)) {
      where.push('i.lancamento = TRUE');
    }

    const valorMaximo = numeroOuNulo(req.query.valorMaximo);

    if (valorMaximo !== null) {
      params.push(valorMaximo);
      where.push(`COALESCE(i.valor_venda, i.valor_locacao) <= $${params.length}`);
    }

    const valorMinimo = numeroOuNulo(req.query.valorMinimo);

    if (valorMinimo !== null) {
      params.push(valorMinimo);
      where.push(`COALESCE(i.valor_venda, i.valor_locacao) >= $${params.length}`);
    }

    const dormitorios = inteiroOuNulo(req.query.dormitorios);

    if (dormitorios !== null) {
      params.push(dormitorios);
      where.push(`i.dormitorios >= $${params.length}`);
    }

    const whereSql = where.join(' AND ');

    const total = await pool.query(
      `SELECT COUNT(*)::int AS total FROM imoveis i WHERE ${whereSql}`,
      params
    );

    const paramsPagina = [...params, paginacao.pageSize, paginacao.offset];

    const ordenacoesPublicas = {
      recentes: 'i.destaque DESC, i.created_at DESC',
      valorAsc: 'COALESCE(i.valor_venda, i.valor_locacao) ASC NULLS LAST',
      valorDesc: 'COALESCE(i.valor_venda, i.valor_locacao) DESC NULLS LAST'
    };
    const ordenacao = ordenacoesPublicas[req.query.ordenacao] || ordenacoesPublicas.recentes;

    const result = await pool.query(
      `
      SELECT i.id, i.codigo, i.slug, i.titulo, i.descricao_resumida, i.finalidade,
             i.tipo, i.situacao, i.lancamento, i.destaque,
             i.valor_venda, i.valor_locacao, i.valor_condominio,
             i.dormitorios, i.suites, i.banheiros, i.vagas,
             i.area_util, i.area_total, i.bairro, i.cidade, i.uf,
             (
               SELECT COALESCE(m.url_web, m.url)
               FROM imovel_midias m
               WHERE m.imovel_id = i.id AND m.tipo = 'IMAGEM' AND m.publica
               ORDER BY m.capa DESC, m.ordem ASC
               LIMIT 1
             ) AS capa_url
      FROM imoveis i
      WHERE ${whereSql}
      ORDER BY ${ordenacao}
      LIMIT $${paramsPagina.length - 1} OFFSET $${paramsPagina.length}
      `,
      paramsPagina
    );

    const items = result.rows.map((row) => ({
      codigo: row.codigo,
      slug: row.slug,
      titulo: row.titulo,
      descricaoResumida: row.descricao_resumida,
      finalidade: row.finalidade,
      tipo: row.tipo,
      situacao: row.situacao,
      lancamento: row.lancamento,
      destaque: row.destaque,
      valorVenda: row.valor_venda === null ? null : Number(row.valor_venda),
      valorLocacao: row.valor_locacao === null ? null : Number(row.valor_locacao),
      valorCondominio: row.valor_condominio === null ? null : Number(row.valor_condominio),
      dormitorios: row.dormitorios,
      suites: row.suites,
      banheiros: row.banheiros,
      vagas: row.vagas,
      areaUtil: row.area_util === null ? null : Number(row.area_util),
      areaTotal: row.area_total === null ? null : Number(row.area_total),
      bairro: row.bairro,
      cidade: row.cidade,
      uf: row.uf,
      capaUrl: row.capa_url,
      link: `/imovel/${row.slug}`
    }));

    res.json(montarResultadoPaginado(items, total.rows[0].total, paginacao));
  })
);

// ---------------------------------------------------------------------
// Filtros reais do site (cidades, bairros e tipos com imóvel publicado).
//
// Precisa vir ANTES de '/imoveis/:slug', senão "filtros" seria tratado
// como slug de imóvel.
// ---------------------------------------------------------------------
router.get(
  '/imoveis/filtros',
  rateLimitLeituraPublica,
  asyncHandler(async (req, res) => {
    const filtroBase = `
      i.deleted_at IS NULL
      AND i.ativo = TRUE
      AND i.publicar_site = TRUE
      AND i.finalidade IN ('VENDA', 'VENDA_LOCACAO')
      AND i.valor_venda IS NOT NULL
      AND i.status NOT IN ('VENDIDO', 'ALUGADO', 'SUSPENSO', 'INATIVO')
    `;

    const [cidades, bairros, tipos, faixas] = await Promise.all([
      pool.query(`
        SELECT i.cidade, i.uf, COUNT(*)::int AS total
        FROM imoveis i
        WHERE ${filtroBase} AND i.cidade IS NOT NULL
        GROUP BY i.cidade, i.uf
        ORDER BY total DESC, i.cidade ASC
        LIMIT 40
      `),
      pool.query(`
        SELECT i.bairro, i.cidade, i.uf, COUNT(*)::int AS total
        FROM imoveis i
        WHERE ${filtroBase} AND i.bairro IS NOT NULL
        GROUP BY i.bairro, i.cidade, i.uf
        ORDER BY total DESC, i.bairro ASC
        LIMIT 60
      `),
      pool.query(`
        SELECT i.tipo, COUNT(*)::int AS total
        FROM imoveis i
        WHERE ${filtroBase}
        GROUP BY i.tipo
        ORDER BY total DESC
      `),
      pool.query(`
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE i.finalidade IN ('VENDA', 'VENDA_LOCACAO'))::int  AS venda,
          COUNT(*) FILTER (WHERE i.finalidade IN ('LOCACAO', 'VENDA_LOCACAO'))::int AS locacao,
          COUNT(*) FILTER (WHERE i.lancamento)::int AS lancamentos
        FROM imoveis i
        WHERE ${filtroBase}
      `)
    ]);

    res.json({
      cidades: cidades.rows.map((row) => ({
        cidade: row.cidade,
        uf: row.uf,
        total: row.total
      })),
      bairros: bairros.rows.map((row) => ({
        bairro: row.bairro,
        cidade: row.cidade,
        uf: row.uf,
        total: row.total
      })),
      tipos: tipos.rows.map((row) => ({ tipo: row.tipo, total: row.total })),
      resumo: faixas.rows[0]
    });
  })
);

// ---------------------------------------------------------------------
// Página pública do imóvel
// ---------------------------------------------------------------------
router.get(
  '/imoveis/:slug',
  rateLimitLeituraPublica,
  asyncHandler(async (req, res) => {
    const slug = limparTexto(req.params.slug, 220);

    if (!slug) throw badRequest('Endereço inválido.');

    const row = await imoveisRepo.buscarPublicoPorSlug(slug);

    if (!row) throw notFound('Imóvel não encontrado ou não disponível.');

    const [midias, caracteristicas] = await Promise.all([
      midiasRepo.listar(row.id, { somentePublicas: true }),
      imoveisRepo.listarCaracteristicas(row.id)
    ]);

    // Contador de visualizações não pode derrubar a página.
    imoveisRepo.incrementarVisualizacao(row.id).catch((error) => {
      console.error('[public] Falha ao contabilizar visualização:', error.message);
    });

    res.json(imoveisService.mapearPublico(row, midias, caracteristicas));
  })
);

// ---------------------------------------------------------------------
// Formulário "Tenho interesse"
// ---------------------------------------------------------------------
router.post(
  '/imoveis/:slug/interesse',
  rateLimitFormularioPublico,
  asyncHandler(async (req, res) => {
    // Honeypot: campo invisível preenchido = bot. Responde 200 para não
    // dar feedback ao robô, mas não grava nada.
    if (req.body.website || req.body.empresa_site) {
      return res.status(200).json({ message: 'Recebemos seu contato.' });
    }

    const slug = limparTexto(req.params.slug, 220);
    const imovel = await imoveisRepo.buscarPublicoPorSlug(slug);

    if (!imovel) throw notFound('Imóvel não encontrado ou não disponível.');

    await leadIngress.registrarInteressePublico({ imovel, body: req.body, req });

    return res.status(201).json({
      message: 'Recebemos seu contato. Um corretor falará com você em breve.'
    });
  })
);

// ---------------------------------------------------------------------
// Formulário de contato do site da imobiliária.
//
// Diferente de /demo (solicitação comercial da plataforma): aqui a
// entrada vira LEAD de verdade em portal_leads e passa pela fila de
// distribuição — pronto para o corretor atender.
// ---------------------------------------------------------------------
router.post(
  '/anunciar-imovel',
  rateLimitFormularioPublico,
  asyncHandler(async (req, res) => {
    if (req.body.website || req.body.empresa_site) {
      return res.status(200).json({ message: 'Recebemos o cadastro do seu imóvel.' });
    }

    const tipo = limparTexto(req.body.tipo, 40);
    const cidade = limparTexto(req.body.cidade, 120);
    const bairro = limparTexto(req.body.bairro, 120);

    if (!tipo) throw badRequest('Informe o tipo do imóvel.');
    if (!cidade || !bairro) throw badRequest('Informe a cidade e o bairro do imóvel.');

    const valorPretendido = numeroOuNulo(req.body.valorPretendido);
    const dormitorios = inteiroOuNulo(req.body.dormitorios);
    const vagas = inteiroOuNulo(req.body.vagas);
    const area = numeroOuNulo(req.body.area);
    const endereco = limparTexto(req.body.endereco, 220);
    const complemento = limparTexto(req.body.complemento, 120);
    const observacoes = limparTexto(req.body.observacoes, 1200);

    const detalhes = [
      '[CAPTAÇÃO DE IMÓVEL PARA VENDA]',
      `Tipo: ${tipo}`,
      `Localização: ${bairro}, ${cidade}`,
      endereco ? `Endereço: ${endereco}${complemento ? ` — ${complemento}` : ''}` : null,
      dormitorios !== null ? `Dormitórios: ${dormitorios}` : null,
      vagas !== null ? `Vagas: ${vagas}` : null,
      area !== null ? `Área aproximada: ${area} m²` : null,
      valorPretendido !== null ? `Valor pretendido: R$ ${valorPretendido.toFixed(2)}` : null,
      observacoes ? `Observações: ${observacoes}` : null
    ].filter(Boolean).join('\n');

    await leadIngress.registrarCaptacaoImovel({
      body: {
        ...req.body,
        origem: 'LANDING',
        tipoLead: 'CAPTACAO_PROPRIETARIO',
        finalidade: 'VENDA',
        tipo,
        cidade,
        bairro,
        endereco,
        complemento,
        dormitorios,
        vagas,
        area,
        valorPretendido,
        observacoes,
        mensagem: detalhes,
        pagina: limparTexto(req.body.pagina, 300) || '/anuncie-seu-imovel'
      },
      req
    });

    return res.status(201).json({
      message: 'Cadastro recebido. Um especialista da Gold Leste entrará em contato para avaliar o imóvel.'
    });
  })
);

router.post(
  '/contato',
  rateLimitFormularioPublico,
  asyncHandler(async (req, res) => {
    if (req.body.website || req.body.empresa_site) {
      return res.status(200).json({ message: 'Recebemos seu contato.' });
    }

    await leadIngress.registrarContatoPublico({ body: req.body, req });

    return res.status(201).json({
      message: 'Recebemos seu contato. Um corretor falará com você em breve.'
    });
  })
);

// ---------------------------------------------------------------------
// Formulário comercial da landing page
// ---------------------------------------------------------------------
router.post(
  '/demo',
  rateLimitFormularioPublico,
  asyncHandler(async (req, res) => {
    if (req.body.website || req.body.empresa_site) {
      return res.status(200).json({ message: 'Recebemos sua solicitação.' });
    }

    const nome = limparTexto(req.body.nome, 180);

    if (!nome || nome.length < 3) throw badRequest('Informe seu nome.');

    const email = emailOuNulo(req.body.email);
    const telefone = telefoneOuNulo(req.body.telefone ?? req.body.whatsapp);

    if (!email && !telefone) {
      throw badRequest('Informe um e-mail ou telefone/WhatsApp para contato.');
    }

    await pool.query(
      `
      INSERT INTO demo_solicitacoes (
        nome, empresa, telefone, email, cidade, qtd_corretores, mensagem,
        origem, pagina, utm_source, utm_medium, utm_campaign, utm_content, utm_term,
        referer, ip_hash, user_agent
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
      `,
      [
        nome,
        limparTexto(req.body.empresa, 180),
        telefone,
        email,
        limparTexto(req.body.cidade, 120),
        limparTexto(req.body.qtdCorretores ?? req.body.quantidadeCorretores, 40),
        limparTexto(req.body.mensagem, 2000),
        limparTexto(req.body.origem, 60) || 'LANDING',
        limparTexto(req.body.pagina, 300) || '/solucoes',
        limparTexto(req.body.utmSource ?? req.body.utm_source, 120),
        limparTexto(req.body.utmMedium ?? req.body.utm_medium, 120),
        limparTexto(req.body.utmCampaign ?? req.body.utm_campaign, 160),
        limparTexto(req.body.utmContent ?? req.body.utm_content, 160),
        limparTexto(req.body.utmTerm ?? req.body.utm_term, 160),
        limparTexto(req.headers.referer || req.headers.referrer, 300),
        hashIp(req.ip),
        limparTexto(req.headers['user-agent'], 300)
      ]
    );

    return res.status(201).json({
      message: 'Solicitação registrada. Nossa equipe entrará em contato.'
    });
  })
);

// ---------------------------------------------------------------------
// Webhook de leads de portais
//
// Segurança: exige o token de feed do portal na URL. Portais que não
// oferecem webhook documentado simplesmente não usarão esta rota — ela
// existe para os que oferecerem, e para integrações intermediárias.
// ---------------------------------------------------------------------
router.post(
  '/leads/:portalSlug/:token',
  rateLimitWebhookLeads,
  asyncHandler(async (req, res) => {
    const portalSlug = limparTexto(req.params.portalSlug, 40);
    const token = limparTexto(req.params.token, 80);

    const portaisRepo = require('../repositories/portais.repository');
    const integracao = await portaisRepo.buscarIntegracaoPorToken(token);

    if (!integracao || integracao.portal_slug !== portalSlug) {
      throw notFound('Endpoint não encontrado.');
    }

    if (!integracao.habilitado) {
      return res.status(403).json({ message: 'Integração desabilitada.' });
    }

    const { lead, duplicado } = await leadIngress.registrarLeadDePortal({
      portalSlug,
      body: sanitizarPayload(req.body || {}),
      req
    });

    return res.status(duplicado ? 200 : 201).json({
      message: duplicado ? 'Lead já registrado.' : 'Lead registrado.',
      id: lead.id,
      duplicado
    });
  })
);

module.exports = router;
