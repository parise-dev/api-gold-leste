const pool = require('../config/db');
const imoveisRepo = require('../repositories/imoveis.repository');
const midiasRepo = require('../repositories/imovel-midias.repository');
const logsRepo = require('../repositories/imovel-logs.repository');
const { calcularQualidade, calcularOportunidade } = require('./imovel-score.service');
const { montarSlugImovel } = require('../utils/slug');
const { notFound, forbidden, conflict } = require('../utils/http-error');
const { labelDoTipo, STATUS_INDISPONIVEIS } = require('../validators/imovel.constants');

const numero = (valor) => (valor === null || valor === undefined ? null : Number(valor));

/** Campos internos que corretor não deve ver em imóvel de terceiros. */
function podeVerDadosInternos(usuario, row) {
  if (!usuario) return false;
  if (usuario.perfil === 'admin' || usuario.perfil === 'gerente') return true;

  return (
    String(row.corretor_id || '') === String(usuario.id) ||
    String(row.captador_id || '') === String(usuario.id) ||
    String(row.created_by || '') === String(usuario.id)
  );
}

/** Endereço exibido conforme a preferência de privacidade do imóvel. */
function montarEnderecoExibicao(row, { publico = false } = {}) {
  const partes = [];

  if (!publico || row.exibir_endereco_completo) {
    if (row.logradouro) partes.push(row.logradouro);
    if (row.numero && (!publico || row.exibir_endereco_completo)) partes.push(row.numero);
  }

  if (row.bairro) partes.push(row.bairro);
  if (row.cidade) partes.push(row.cidade);
  if (row.uf) partes.push(row.uf);

  return partes.filter(Boolean).join(', ');
}

/** Badges do card. Ordem = prioridade visual. */
function montarBadges(row) {
  const badges = [];

  if (row.oportunidade) badges.push({ chave: 'OPORTUNIDADE', label: 'Oportunidade' });
  if (row.exclusivo) badges.push({ chave: 'EXCLUSIVO', label: 'Exclusivo' });
  if (row.lancamento) badges.push({ chave: 'LANCAMENTO', label: 'Lançamento' });
  if (row.destaque) badges.push({ chave: 'DESTAQUE', label: 'Destaque' });

  const criadoEm = row.created_at ? new Date(row.created_at) : null;

  if (criadoEm && !Number.isNaN(criadoEm.getTime())) {
    const dias = (Date.now() - criadoEm.getTime()) / (1000 * 60 * 60 * 24);
    if (dias <= 15) badges.push({ chave: 'NOVO', label: 'Novo' });
  }

  if (Number(row.total_leads || 0) >= 5) {
    badges.push({ chave: 'ALTA_PROCURA', label: 'Alta procura' });
  }

  return badges;
}

/** Card / listagem. */
function mapearResumo(row, { usuario = null, favoritos = null } = {}) {
  const interno = podeVerDadosInternos(usuario, row);

  return {
    id: row.id,
    codigo: row.codigo,
    slug: row.slug,
    titulo: row.titulo,
    descricaoResumida: row.descricao_resumida,

    finalidade: row.finalidade,
    tipo: row.tipo,
    tipoLabel: labelDoTipo(row.tipo),
    situacao: row.situacao,
    status: row.status,
    origemCarteira: row.origem_carteira,

    ativo: row.ativo,
    destaque: row.destaque,
    oportunidade: row.oportunidade,
    exclusivo: row.exclusivo,
    lancamento: row.lancamento,
    publicarSite: row.publicar_site,

    valorVenda: numero(row.valor_venda),
    valorLocacao: numero(row.valor_locacao),
    valorCondominio: numero(row.valor_condominio),
    valorIptu: numero(row.valor_iptu),

    comissaoPercentual: interno ? numero(row.comissao_percentual) : null,
    comissaoValor: interno ? numero(row.comissao_valor) : null,

    dormitorios: row.dormitorios,
    suites: row.suites,
    banheiros: row.banheiros,
    vagas: row.vagas,
    areaUtil: numero(row.area_util),
    areaTotal: numero(row.area_total),

    bairro: row.bairro,
    cidade: row.cidade,
    uf: row.uf,
    enderecoExibicao: montarEnderecoExibicao(row),

    filialId: row.filial_id,
    filialNome: row.filial_nome || null,
    corretorId: row.corretor_id,
    corretorNome: row.corretor_nome || null,

    capaUrl: row.capa_url_web || row.primeira_foto_url || null,
    capaThumbUrl: row.capa_url_thumb || row.primeira_foto_url || null,
    totalFotos: row.total_fotos ?? 0,

    totalPortaisHabilitados: row.total_portais_habilitados ?? 0,
    totalPortaisPublicados: row.total_portais_publicados ?? 0,
    totalPortaisComErro: row.total_portais_erro ?? 0,

    qualidadeScore: row.qualidade_score,
    oportunidadeScore: numero(row.oportunidade_score),
    totalLeads: row.total_leads,
    totalVisualizacoes: row.total_visualizacoes,

    badges: montarBadges(row),
    favorito: favoritos ? favoritos.has(row.id) : undefined,

    vendaId: row.venda_id,
    empreendimentoLegadoId: row.empreendimento_legado_id,
    empreendimentoNome: row.empreendimento_nome,

    criadoEm: row.created_at,
    atualizadoEm: row.updated_at
  };
}

/** Detalhe completo (painel interno). */
function mapearDetalhe(row, extras = {}, usuario = null) {
  const interno = podeVerDadosInternos(usuario, row);
  const resumo = mapearResumo(row, { usuario });

  return {
    ...resumo,

    descricao: row.descricao,
    referenciaExterna: row.referencia_externa,
    subtipo: row.subtipo,

    outrasTaxas: numero(row.outras_taxas),
    iptuPeriodo: row.iptu_periodo,
    valorMinimo: interno ? numero(row.valor_minimo) : null,
    aceitaFinanciamento: row.aceita_financiamento,
    aceitaFgts: row.aceita_fgts,
    aceitaPermuta: row.aceita_permuta,
    observacoesInternas: interno ? row.observacoes_internas : null,

    areaConstruida: numero(row.area_construida),
    areaTerreno: numero(row.area_terreno),
    andar: row.andar,
    totalAndares: row.total_andares,
    anoConstrucao: row.ano_construcao,
    mobiliado: row.mobiliado,
    elevador: row.elevador,
    petFriendly: row.pet_friendly,

    cep: row.cep,
    logradouro: row.logradouro,
    numero: row.numero,
    complemento: row.complemento,
    latitude: numero(row.latitude),
    longitude: numero(row.longitude),
    exibirEnderecoCompleto: row.exibir_endereco_completo,

    captadorId: row.captador_id,
    captadorNome: row.captador_nome || null,
    gerenteId: row.gerente_id,
    gerenteNome: row.gerente_nome || null,

    unidadeLegadoId: row.unidade_legado_id,
    unidadeIdentificacao: row.unidade_identificacao,

    proprietarioLegadoId: interno ? row.proprietario_legado_id : null,
    proprietarioNome: interno ? row.proprietario_nome : null,
    proprietarioTelefone: interno ? row.proprietario_telefone : null,
    proprietarioEmail: interno ? row.proprietario_email : null,
    dadosKenlo: interno ? (row.dados_kenlo || {}) : {},

    visibilidade: row.visibilidade,
    prioridadeManual: row.prioridade_manual,

    midias: extras.midias || [],
    caracteristicas: extras.caracteristicas || [],
    visibilidadeDetalhe: extras.visibilidade || null,
    qualidade: extras.qualidade || null,
    portais: extras.portais || [],
    leads: extras.leads || [],
    historico: extras.historico || []
  };
}

function mapearMidia(row) {
  return {
    id: row.id,
    tipo: row.tipo,
    url: row.url,
    urlWeb: row.url_web || row.url,
    urlThumb: row.url_thumb || row.url_web || row.url,
    urlExterna: row.url_externa,
    legenda: row.legenda,
    altText: row.alt_text,
    ordem: row.ordem,
    capa: row.capa,
    publica: row.publica,
    largura: row.largura,
    altura: row.altura,
    tamanhoBytes: row.tamanho_bytes ? Number(row.tamanho_bytes) : null,
    mimeType: row.mime_type,
    processamento: row.processamento,
    processamentoErro: row.processamento_erro,
    criadoEm: row.created_at
  };
}

/** Página pública: nunca expõe dado interno. */
function mapearPublico(row, midias = [], caracteristicas = []) {
  return {
    id: row.id,
    codigo: row.codigo,
    slug: row.slug,
    titulo: row.titulo,
    descricao: row.descricao,
    descricaoResumida: row.descricao_resumida,

    finalidade: row.finalidade,
    tipo: row.tipo,
    tipoLabel: labelDoTipo(row.tipo),
    situacao: row.situacao,
    lancamento: row.lancamento,
    destaque: row.destaque,

    valorVenda: numero(row.valor_venda),
    valorLocacao: numero(row.valor_locacao),
    valorCondominio: numero(row.valor_condominio),
    valorIptu: numero(row.valor_iptu),
    iptuPeriodo: row.iptu_periodo,
    aceitaFinanciamento: row.aceita_financiamento,
    aceitaFgts: row.aceita_fgts,

    dormitorios: row.dormitorios,
    suites: row.suites,
    banheiros: row.banheiros,
    vagas: row.vagas,
    areaUtil: numero(row.area_util),
    areaTotal: numero(row.area_total),
    andar: row.andar,
    anoConstrucao: row.ano_construcao,
    mobiliado: row.mobiliado,
    elevador: row.elevador,
    petFriendly: row.pet_friendly,

    // Endereço respeitando exibirEnderecoCompleto
    logradouro: row.exibir_endereco_completo ? row.logradouro : null,
    numero: row.exibir_endereco_completo ? row.numero : null,
    complemento: null,
    bairro: row.bairro,
    cidade: row.cidade,
    uf: row.uf,
    cep: row.exibir_endereco_completo ? row.cep : null,
    enderecoExibicao: montarEnderecoExibicao(row, { publico: true }),
    latitude: numero(row.latitude),
    longitude: numero(row.longitude),
    exibirEnderecoCompleto: row.exibir_endereco_completo,

    empreendimentoNome: row.empreendimento_nome,

    corretorNome: row.corretor_nome || null,
    corretorCreci: row.corretor_creci || null,
    filialNome: row.filial_nome || null,

    midias: midias.map((midia) => ({
      id: midia.id,
      tipo: midia.tipo,
      url: midia.url_web || midia.url,
      urlThumb: midia.url_thumb || midia.url_web || midia.url,
      urlExterna: midia.url_externa,
      legenda: midia.legenda,
      altText: midia.alt_text || row.titulo,
      capa: midia.capa
    })),

    caracteristicas: caracteristicas.map((item) => ({
      slug: item.slug,
      label: item.label,
      grupo: item.grupo
    })),

    atualizadoEm: row.updated_at
  };
}

// ---------------------------------------------------------------------
// SCORES — recalculados sempre que o imóvel ou suas mídias mudam.
// ---------------------------------------------------------------------
async function recalcularScores(imovelId, client = pool) {
  const imovel = await imoveisRepo.buscarBruto(imovelId, client);
  if (!imovel) return null;

  const totalFotos = await midiasRepo.contarImagens(imovelId, client);
  const temCapa = await midiasRepo.existeCapa(imovelId, client);

  const caracteristicas = await client.query(
    `SELECT COUNT(*)::int AS total FROM imovel_caracteristicas WHERE imovel_id = $1`,
    [imovelId]
  );

  const qualidade = calcularQualidade(imovel, {
    totalFotos,
    temCapa,
    totalCaracteristicas: caracteristicas.rows[0].total
  });

  const oportunidade = calcularOportunidade(imovel, {
    qualidadeScore: qualidade.score
  });

  await client.query(
    `UPDATE imoveis SET qualidade_score = $1, oportunidade_score = $2 WHERE id = $3`,
    [qualidade.score, oportunidade.score, imovelId]
  );

  return { qualidade, oportunidade };
}

/**
 * Slug único. Se o slug natural já existir, acrescenta sufixo numérico.
 * O código do imóvel já entra no slug, então colisão é rara.
 */
async function gerarSlugUnico(imovel, ignorarId = null) {
  const base = montarSlugImovel(imovel) || `imovel-${Date.now()}`;

  let candidato = base;
  let tentativa = 2;

  // Teto de 20 tentativas: acima disso algo está errado e é melhor falhar.
  while (await imoveisRepo.slugExiste(candidato, ignorarId)) {
    candidato = `${base}-${tentativa}`;
    tentativa += 1;

    if (tentativa > 20) {
      throw conflict('Não foi possível gerar um endereço público único para este imóvel.');
    }
  }

  return candidato;
}

// ---------------------------------------------------------------------
// CASOS DE USO
// ---------------------------------------------------------------------
async function criar({ dados, caracteristicas, visibilidade, captacaoId = null, usuario }) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    if (captacaoId) {
      const captacao = await client.query(
        `SELECT id, captacao_status
         FROM portal_leads
         WHERE id = $1 AND tipo_lead = 'CAPTACAO_IMOVEL'
         FOR UPDATE`,
        [captacaoId]
      );

      if (!captacao.rows.length) throw notFound('Captação de imóvel não encontrada.');
      if (captacao.rows[0].captacao_status !== 'APROVADA') {
        throw conflict('A captação precisa estar aprovada antes de criar o anúncio.');
      }
    }

    const codigo = await imoveisRepo.proximoCodigo(client);

    const slug = await gerarSlugUnico({ ...dados, codigo });

    const registro = await imoveisRepo.inserir(
      {
        ...dados,
        codigo,
        slug,
        created_by: usuario.id,
        updated_by: usuario.id
      },
      client
    );

    if (caracteristicas) {
      await imoveisRepo.substituirCaracteristicas(registro.id, caracteristicas, client);
    }

    if (visibilidade) {
      await imoveisRepo.substituirVisibilidade(registro.id, visibilidade, client);
    }

    await logsRepo.registrar(
      {
        imovelId: registro.id,
        usuario,
        acao: 'CRIACAO',
        resumo: `Imóvel ${codigo} cadastrado.`
      },
      client
    );

    await recalcularScores(registro.id, client);

    if (captacaoId) {
      await client.query(
        `UPDATE portal_leads
         SET captacao_status = 'CONVERTIDA',
             captacao_imovel_id = $1,
             captacao_convertida_em = NOW(),
             status_processamento = 'ENCAMINHADO',
             captacao_atualizada_por = $2,
             updated_at = NOW()
         WHERE id = $3`,
        [registro.id, usuario.id, captacaoId]
      );
    }

    await client.query('COMMIT');

    return registro.id;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function atualizar({ id, dados, caracteristicas, visibilidade, usuario }) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const anterior = await imoveisRepo.buscarBruto(id, client);

    if (!anterior) throw notFound('Imóvel não encontrado.');

    if (!imoveisRepo.podeEditar(usuario, anterior)) {
      throw forbidden('Você não tem permissão para editar este imóvel.');
    }

    // Slug só muda quando algo que o compõe muda — links públicos são estáveis.
    const mudouComposicaoSlug = ['tipo', 'dormitorios', 'bairro', 'cidade', 'uf'].some(
      (campo) => dados[campo] !== undefined && String(dados[campo] ?? '') !== String(anterior[campo] ?? '')
    );

    const dadosFinais = { ...dados, updated_by: usuario.id };

    if (mudouComposicaoSlug) {
      dadosFinais.slug = await gerarSlugUnico(
        { ...anterior, ...dados, codigo: anterior.codigo },
        id
      );
    }

    const novo = await imoveisRepo.atualizar(id, dadosFinais, client);

    if (!novo) throw notFound('Imóvel não encontrado.');

    if (caracteristicas) {
      await imoveisRepo.substituirCaracteristicas(id, caracteristicas, client);
    }

    if (visibilidade) {
      await imoveisRepo.substituirVisibilidade(id, visibilidade, client);
    }

    await logsRepo.registrarAlteracoes({ imovelId: id, usuario, anterior, novo }, client);

    // Imóvel vendido/alugado sai automaticamente das oportunidades e dos portais.
    if (STATUS_INDISPONIVEIS.includes(novo.status) && anterior.status !== novo.status) {
      await client.query(
        `UPDATE imoveis SET oportunidade = FALSE WHERE id = $1`,
        [id]
      );

      await client.query(
        `
        UPDATE imovel_portais
        SET status = 'REMOVIDO', updated_at = NOW()
        WHERE imovel_id = $1 AND status = 'PUBLICADO'
        `,
        [id]
      );
    }

    await recalcularScores(id, client);

    await client.query('COMMIT');

    return id;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function alterarStatus({ id, status, usuario }) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const anterior = await imoveisRepo.buscarBruto(id, client);
    if (!anterior) throw notFound('Imóvel não encontrado.');

    if (!imoveisRepo.podeEditar(usuario, anterior)) {
      throw forbidden('Você não tem permissão para alterar o status deste imóvel.');
    }

    const novo = await imoveisRepo.atualizar(
      id,
      { status, updated_by: usuario.id },
      client
    );

    await logsRepo.registrar(
      {
        imovelId: id,
        usuario,
        acao: 'STATUS',
        resumo: `Status alterado de ${anterior.status} para ${status}.`,
        campo: 'status',
        valorAnterior: anterior.status,
        valorNovo: status
      },
      client
    );

    if (STATUS_INDISPONIVEIS.includes(status)) {
      await client.query(`UPDATE imoveis SET oportunidade = FALSE WHERE id = $1`, [id]);

      await client.query(
        `
        UPDATE imovel_portais
        SET status = 'REMOVIDO', updated_at = NOW()
        WHERE imovel_id = $1 AND status = 'PUBLICADO'
        `,
        [id]
      );
    }

    await recalcularScores(id, client);

    await client.query('COMMIT');

    return novo;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function inativar({ id, usuario }) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const imovel = await imoveisRepo.buscarBruto(id, client);
    if (!imovel) throw notFound('Imóvel não encontrado.');

    if (usuario.perfil !== 'admin' && !imoveisRepo.podeEditar(usuario, imovel)) {
      throw forbidden('Você não tem permissão para excluir este imóvel.');
    }

    await logsRepo.registrar(
      {
        imovelId: id,
        usuario,
        acao: 'EXCLUSAO',
        resumo: `Imóvel ${imovel.codigo} inativado (soft delete).`
      },
      client
    );

    const removido = await imoveisRepo.inativar(id, usuario.id, client);

    await client.query(
      `
      UPDATE imovel_portais
      SET habilitado = FALSE, status = 'REMOVIDO', updated_at = NOW()
      WHERE imovel_id = $1
      `,
      [id]
    );

    await client.query('COMMIT');

    return removido;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  mapearResumo,
  mapearDetalhe,
  mapearMidia,
  mapearPublico,
  montarBadges,
  montarEnderecoExibicao,
  podeVerDadosInternos,
  recalcularScores,
  gerarSlugUnico,
  criar,
  atualizar,
  alterarStatus,
  inativar
};
