const { badRequest, unprocessable } = require('../utils/http-error');
const { limparTexto } = require('../utils/sanitize');
const {
  FINALIDADES,
  STATUS_COMERCIAIS,
  SITUACOES,
  ORIGENS_CARTEIRA,
  VISIBILIDADES,
  IPTU_PERIODOS,
  TIPOS_VALIDOS,
  UFS
} = require('./imovel.constants');

const REGEX_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function ehUuid(valor) {
  return typeof valor === 'string' && REGEX_UUID.test(valor.trim());
}

function exigirUuid(valor, campo = 'id') {
  if (!ehUuid(valor)) {
    throw badRequest(`Identificador inválido para ${campo}.`);
  }

  return String(valor).trim();
}

function uuidOuNulo(valor) {
  if (valor === null || valor === undefined || valor === '') return null;
  if (!ehUuid(valor)) return null;
  return String(valor).trim();
}

function booleano(valor, padrao = false) {
  if (valor === true || valor === false) return valor;
  if (valor === 'true' || valor === '1' || valor === 1) return true;
  if (valor === 'false' || valor === '0' || valor === 0) return false;
  return padrao;
}

function booleanoOuNulo(valor) {
  if (valor === null || valor === undefined || valor === '') return null;
  return booleano(valor, null);
}

/**
 * Converte valores monetários/numéricos vindos do front.
 * Aceita number ou string "1.250.000,50" / "1250000.50".
 * NUNCA devolve string formatada — o banco guarda numeric.
 */
function numeroOuNulo(valor) {
  if (valor === null || valor === undefined || valor === '') return null;

  if (typeof valor === 'number') {
    return Number.isFinite(valor) ? valor : null;
  }

  let texto = String(valor).trim().replace(/[R$\s]/gi, '');

  if (!texto) return null;

  const temVirgula = texto.includes(',');
  const temPonto = texto.includes('.');

  if (temVirgula && temPonto) {
    // "1.250.000,50" -> separador decimal é a vírgula
    texto = texto.replace(/\./g, '').replace(',', '.');
  } else if (temVirgula) {
    texto = texto.replace(',', '.');
  }

  const numero = Number(texto);

  return Number.isFinite(numero) ? numero : null;
}

function inteiroOuNulo(valor) {
  const numero = numeroOuNulo(valor);
  if (numero === null) return null;
  return Math.trunc(numero);
}

function enumOuPadrao(valor, permitidos, padrao, campo) {
  if (valor === null || valor === undefined || valor === '') return padrao;

  const normalizado = String(valor).trim().toUpperCase();

  if (!permitidos.includes(normalizado)) {
    throw badRequest(
      `Valor inválido para ${campo}: "${valor}". Valores aceitos: ${permitidos.join(', ')}.`
    );
  }

  return normalizado;
}

function ufOuNulo(valor) {
  if (!valor) return null;

  const normalizado = String(valor).trim().toUpperCase();

  if (!UFS.includes(normalizado)) {
    throw badRequest(`UF inválida: "${valor}".`);
  }

  return normalizado;
}

function cepOuNulo(valor) {
  if (!valor) return null;

  const digitos = String(valor).replace(/\D/g, '');

  if (!digitos) return null;

  if (digitos.length !== 8) {
    throw badRequest('CEP inválido. Informe 8 dígitos.');
  }

  return `${digitos.slice(0, 5)}-${digitos.slice(5)}`;
}

function coordenadaOuNulo(valor, minimo, maximo, campo) {
  const numero = numeroOuNulo(valor);
  if (numero === null) return null;

  if (numero < minimo || numero > maximo) {
    throw badRequest(`${campo} fora do intervalo permitido (${minimo} a ${maximo}).`);
  }

  return numero;
}

function emailOuNulo(valor) {
  if (!valor) return null;

  const texto = String(valor).trim().toLowerCase();

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(texto)) return null;

  return texto.slice(0, 180);
}

function telefoneOuNulo(valor) {
  if (!valor) return null;

  const digitos = String(valor).replace(/\D/g, '');

  if (digitos.length < 8 || digitos.length > 15) return null;

  return String(valor).trim().slice(0, 40);
}

/**
 * Campos complementares do formulário Kenlo.
 * Ficam agrupados em JSONB para preservar a paridade sem misturar dados
 * confidenciais/documentais com as colunas públicas do anúncio.
 */
function normalizarDadosKenlo(entrada) {
  const body = entrada && typeof entrada === 'object' && !Array.isArray(entrada) ? entrada : {};
  const dados = {};

  const textos = {
    proprietarioTelefoneResidencial: 40,
    proprietarioTelefoneComercial: 40,
    proprietarioCelular: 40,
    midiaOrigem: 100,
    frequenciaFeedbackProprietario: 30,
    finalidadeEstrutural: 30,
    buscaEnderecoPor: 20,
    pais: 80,
    referenciaAlternativa: 60,
    statusCadastro: 30,
    condicaoIptu: 20,
    padraoImovel: 30,
    padraoLocalizacao: 30,
    situacaoImovel: 40,
    zoneamento: 120,
    localChaves: 30,
    linkVideoYoutube: 500,
    tourVirtual: 500,
    descricaoSite: 8000,
    tipoPlaca: 30,
    classificacaoPlaca: 30,
    condicaoComercial: 4000,
    codigoIptu: 80,
    numeroMatricula: 80,
    cartorio: 180,
    codigoRedeEletricidade: 80,
    codigoRedeAgua: 80,
    titulosDireitos: 60,
    observacoesDocumentacao: 4000
  };

  for (const [campo, tamanho] of Object.entries(textos)) {
    dados[campo] = limparTexto(body[campo], tamanho);
  }

  for (const campo of [
    'locado', 'autorizadoComercializacao', 'usouFgtsUltimosTresAnos',
    'anunciar', 'superDestaque', 'placaNoLocal'
  ]) {
    dados[campo] = booleano(body[campo], false);
  }

  for (const campo of ['aprovadoOrgaoAmbiental', 'projetoAprovado']) {
    dados[campo] = booleanoOuNulo(body[campo]);
  }

  for (const campo of [
    'valorSeguroFianca', 'valorSeguroIncendio', 'valorVendaAvaliado'
  ]) {
    const valor = numeroOuNulo(body[campo]);
    dados[campo] = valor !== null && valor >= 0 ? valor : null;
  }

  const anoReforma = inteiroOuNulo(body.anoReforma);
  dados.anoReforma = anoReforma !== null && anoReforma >= 1800 && anoReforma <= 2200
    ? anoReforma
    : null;

  dados.marcadores = Array.isArray(body.marcadores)
    ? body.marcadores.map((item) => limparTexto(item, 80)).filter(Boolean).slice(0, 30)
    : [];

  dados.comissoes = Array.isArray(body.comissoes)
    ? body.comissoes.slice(0, 30).map((item) => ({
        tipo: limparTexto(item?.tipo, 40),
        corretorId: uuidOuNulo(item?.corretorId),
        pretensao: 'VENDA',
        percentual: numeroOuNulo(item?.percentual),
        incluidoEm: limparTexto(item?.incluidoEm, 10),
        midiaOrigem: limparTexto(item?.midiaOrigem, 100)
      }))
    : [];

  return dados;
}

/**
 * Normaliza e valida o corpo de criação/edição do imóvel.
 * `parcial = true` (PATCH) só considera as chaves realmente enviadas.
 */
function normalizarImovel(body = {}, { parcial = false } = {}) {
  const enviado = (campo) => Object.prototype.hasOwnProperty.call(body, campo);
  const dados = {};
  const erros = [];

  if (!parcial || enviado('titulo')) {
    const titulo = limparTexto(body.titulo, 160);

    if (!titulo || titulo.length < 5) {
      erros.push({ campo: 'titulo', mensagem: 'Título é obrigatório (mínimo 5 caracteres).' });
    }

    dados.titulo = titulo;
  }

  if (!parcial || enviado('tipo')) {
    dados.tipo = enumOuPadrao(body.tipo, TIPOS_VALIDOS, 'APARTAMENTO', 'tipo');
  }

  if (!parcial || enviado('finalidade')) {
    dados.finalidade = enumOuPadrao(body.finalidade, FINALIDADES, 'VENDA', 'finalidade');
  }

  if (!parcial || enviado('status')) {
    dados.status = enumOuPadrao(body.status, STATUS_COMERCIAIS, 'DISPONIVEL', 'status');
  }

  if (!parcial || enviado('situacao')) {
    dados.situacao = enumOuPadrao(body.situacao, SITUACOES, 'USADO', 'situacao');
  }

  if (!parcial || enviado('origemCarteira')) {
    dados.origem_carteira = enumOuPadrao(
      body.origemCarteira, ORIGENS_CARTEIRA, 'AVULSO', 'origemCarteira'
    );
  }

  if (!parcial || enviado('visibilidade')) {
    dados.visibilidade = enumOuPadrao(body.visibilidade, VISIBILIDADES, 'TODOS', 'visibilidade');
  }

  if (!parcial || enviado('iptuPeriodo')) {
    dados.iptu_periodo = enumOuPadrao(body.iptuPeriodo, IPTU_PERIODOS, 'ANUAL', 'iptuPeriodo');
  }

  // Textos -----------------------------------------------------------
  const textos = [
    ['referenciaExterna', 'referencia_externa', 60],
    ['descricao', 'descricao', 8000],
    ['descricaoResumida', 'descricao_resumida', 400],
    ['subtipo', 'subtipo', 40],
    ['logradouro', 'logradouro', 180],
    ['numero', 'numero', 20],
    ['complemento', 'complemento', 120],
    ['bairro', 'bairro', 120],
    ['cidade', 'cidade', 120],
    ['observacoesInternas', 'observacoes_internas', 4000],
    ['empreendimentoLegadoId', 'empreendimento_legado_id', 60],
    ['empreendimentoNome', 'empreendimento_nome', 180],
    ['unidadeLegadoId', 'unidade_legado_id', 60],
    ['unidadeIdentificacao', 'unidade_identificacao', 60],
    ['proprietarioLegadoId', 'proprietario_legado_id', 60],
    ['proprietarioNome', 'proprietario_nome', 180]
  ];

  for (const [origem, coluna, tamanho] of textos) {
    if (!parcial || enviado(origem)) {
      dados[coluna] = limparTexto(body[origem], tamanho);
    }
  }

  if (!parcial || enviado('proprietarioEmail')) {
    dados.proprietario_email = emailOuNulo(body.proprietarioEmail);
  }

  if (!parcial || enviado('proprietarioTelefone')) {
    dados.proprietario_telefone = telefoneOuNulo(body.proprietarioTelefone);
  }

  if (!parcial || enviado('dadosKenlo')) {
    dados.dados_kenlo = normalizarDadosKenlo(body.dadosKenlo);
  }

  if (!parcial && !dados.proprietario_nome) {
    erros.push({ campo: 'proprietarioNome', mensagem: 'Nome do proprietário é obrigatório.' });
  }

  if (!parcial && !dados.dados_kenlo?.midiaOrigem) {
    erros.push({ campo: 'midiaOrigem', mensagem: 'Mídia de origem é obrigatória.' });
  }

  // Booleanos ---------------------------------------------------------
  const booleanos = [
    ['ativo', 'ativo', true],
    ['destaque', 'destaque', false],
    ['oportunidade', 'oportunidade', false],
    ['exclusivo', 'exclusivo', false],
    ['lancamento', 'lancamento', false],
    ['publicarSite', 'publicar_site', true],
    ['aceitaFinanciamento', 'aceita_financiamento', false],
    ['aceitaFgts', 'aceita_fgts', false],
    ['aceitaPermuta', 'aceita_permuta', false],
    ['mobiliado', 'mobiliado', false],
    ['elevador', 'elevador', false],
    ['petFriendly', 'pet_friendly', false],
    ['exibirEnderecoCompleto', 'exibir_endereco_completo', false]
  ];

  for (const [origem, coluna, padrao] of booleanos) {
    if (!parcial || enviado(origem)) {
      dados[coluna] = booleano(body[origem], padrao);
    }
  }

  // Valores -----------------------------------------------------------
  const numericos = [
    ['valorVenda', 'valor_venda'],
    ['valorLocacao', 'valor_locacao'],
    ['valorCondominio', 'valor_condominio'],
    ['valorIptu', 'valor_iptu'],
    ['outrasTaxas', 'outras_taxas'],
    ['valorMinimo', 'valor_minimo'],
    ['comissaoPercentual', 'comissao_percentual'],
    ['comissaoValor', 'comissao_valor'],
    ['areaUtil', 'area_util'],
    ['areaTotal', 'area_total'],
    ['areaConstruida', 'area_construida'],
    ['areaTerreno', 'area_terreno']
  ];

  for (const [origem, coluna] of numericos) {
    if (!parcial || enviado(origem)) {
      const numero = numeroOuNulo(body[origem]);

      if (numero !== null && numero < 0) {
        erros.push({ campo: origem, mensagem: 'Valor não pode ser negativo.' });
      }

      dados[coluna] = numero;
    }
  }

  const inteiros = [
    ['dormitorios', 'dormitorios', 0, 60],
    ['suites', 'suites', 0, 60],
    ['banheiros', 'banheiros', 0, 60],
    ['vagas', 'vagas', 0, 200],
    ['andar', 'andar', -10, 300],
    ['totalAndares', 'total_andares', 0, 300],
    ['anoConstrucao', 'ano_construcao', 1800, 2200],
    ['prioridadeManual', 'prioridade_manual', 0, 100]
  ];

  for (const [origem, coluna, minimo, maximo] of inteiros) {
    if (!parcial || enviado(origem)) {
      const numero = inteiroOuNulo(body[origem]);

      if (numero !== null && (numero < minimo || numero > maximo)) {
        erros.push({
          campo: origem,
          mensagem: `Valor fora do intervalo permitido (${minimo} a ${maximo}).`
        });
      }

      dados[coluna] = numero;
    }
  }

  if (dados.prioridade_manual === null || dados.prioridade_manual === undefined) {
    if (!parcial) dados.prioridade_manual = 0;
  }

  // Endereço ----------------------------------------------------------
  if (!parcial || enviado('cep')) dados.cep = cepOuNulo(body.cep);
  if (!parcial || enviado('uf')) dados.uf = ufOuNulo(body.uf);

  if (!parcial || enviado('latitude')) {
    dados.latitude = coordenadaOuNulo(body.latitude, -90, 90, 'latitude');
  }

  if (!parcial || enviado('longitude')) {
    dados.longitude = coordenadaOuNulo(body.longitude, -180, 180, 'longitude');
  }

  // Relacionamentos ----------------------------------------------------
  const relacionamentos = [
    ['filialId', 'filial_id'],
    ['corretorId', 'corretor_id'],
    ['captadorId', 'captador_id'],
    ['gerenteId', 'gerente_id'],
    ['vendaId', 'venda_id']
  ];

  for (const [origem, coluna] of relacionamentos) {
    if (!parcial || enviado(origem)) {
      const valor = body[origem];

      if (valor !== null && valor !== undefined && valor !== '' && !ehUuid(valor)) {
        erros.push({ campo: origem, mensagem: 'Identificador inválido.' });
      }

      dados[coluna] = uuidOuNulo(valor);
    }
  }

  // Coerência comercial ------------------------------------------------
  const finalidade = dados.finalidade;

  if (finalidade === 'VENDA' || finalidade === 'VENDA_LOCACAO') {
    if (!parcial && !dados.valor_venda) {
      erros.push({ campo: 'valorVenda', mensagem: 'Informe o valor de venda para imóveis à venda.' });
    }
  }

  if (finalidade === 'LOCACAO' || finalidade === 'VENDA_LOCACAO') {
    if (!parcial && !dados.valor_locacao) {
      erros.push({ campo: 'valorLocacao', mensagem: 'Informe o valor de locação para imóveis de locação.' });
    }
  }

  if (
    dados.suites !== null && dados.suites !== undefined &&
    dados.dormitorios !== null && dados.dormitorios !== undefined &&
    dados.suites > dados.dormitorios
  ) {
    erros.push({
      campo: 'suites',
      mensagem: 'Quantidade de suítes não pode ser maior que a de dormitórios.'
    });
  }

  if (erros.length) {
    throw unprocessable('Não foi possível salvar o imóvel. Revise os campos destacados.', erros);
  }

  return dados;
}

/** Características adicionais: [{ slug, label, grupo?, valor? }] */
function normalizarCaracteristicas(lista) {
  if (!Array.isArray(lista)) return null;

  const vistos = new Set();
  const saida = [];

  for (const item of lista.slice(0, 120)) {
    if (!item) continue;

    const bruto = typeof item === 'string' ? { slug: item, label: item } : item;

    const slug = limparTexto(bruto.slug || bruto.label, 60);
    if (!slug) continue;

    const chave = slug
      .normalize('NFD')
      .replace(new RegExp('[\\u0300-\\u036f]', 'g'), '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');

    if (!chave || vistos.has(chave)) continue;
    vistos.add(chave);

    saida.push({
      slug: chave,
      label: limparTexto(bruto.label || slug, 120) || chave,
      grupo: limparTexto(bruto.grupo, 40) || 'IMOVEL',
      valor: limparTexto(bruto.valor, 120)
    });
  }

  return saida;
}

/** Visibilidade explícita: { usuarios: [uuid], filiais: [uuid] } */
function normalizarVisibilidade(entrada) {
  if (!entrada || typeof entrada !== 'object') return null;

  const usuarios = Array.isArray(entrada.usuarios)
    ? [...new Set(entrada.usuarios.map(uuidOuNulo).filter(Boolean))].slice(0, 200)
    : [];

  const filiais = Array.isArray(entrada.filiais)
    ? [...new Set(entrada.filiais.map(uuidOuNulo).filter(Boolean))].slice(0, 50)
    : [];

  return { usuarios, filiais };
}

module.exports = {
  ehUuid,
  exigirUuid,
  uuidOuNulo,
  booleano,
  booleanoOuNulo,
  numeroOuNulo,
  inteiroOuNulo,
  emailOuNulo,
  telefoneOuNulo,
  cepOuNulo,
  ufOuNulo,
  normalizarImovel,
  normalizarDadosKenlo,
  normalizarCaracteristicas,
  normalizarVisibilidade
};
