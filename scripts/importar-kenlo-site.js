/* eslint-disable no-console */
/**
 * Importa a carteira ativa da Gold Leste no Kenlo a partir do site público.
 *
 * O arquivo kenlo-referencias-ativas.json é a lista conferida no painel
 * autenticado. Ela evita importar imóveis de parceiros exibidos no site.
 *
 * Uso:
 *   node scripts/importar-kenlo-site.js             # conferência, sem gravar
 *   node scripts/importar-kenlo-site.js --apply     # grava sem publicar
 *   node scripts/importar-kenlo-site.js --apply --publish
 *   node scripts/importar-kenlo-site.js --apply --slow # detalhes com intervalo seguro
 *   node scripts/importar-kenlo-site.js --apply --slow --missing-details-only
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const pool = require('../src/config/db');
const imoveisService = require('../src/services/imoveis.service');
const { normalizarImovel, normalizarCaracteristicas } = require('../src/validators/imovel.validator');

const SITE = 'https://www.goldlesteimoveis.com.br';
const SITEMAP = `${SITE}/sitemap.xml`;
const USER_AGENT = 'GoldLesteMigration/1.0 (+https://www.goldlesteimoveis.com.br)';
const REFERENCIAS_PATH = path.join(__dirname, 'kenlo-referencias-ativas.json');

const args = new Set(process.argv.slice(2));
const APPLY = args.has('--apply');
const PUBLISH = args.has('--publish');
const SKIP_DETAILS = args.has('--skip-details');
const SLOW = args.has('--slow');
const MISSING_DETAILS_ONLY = args.has('--missing-details-only');

const ROTULOS_TIPO = {
  APARTAMENTO: 'Apartamento',
  CASA: 'Casa',
  SOBRADO: 'Sobrado',
  COBERTURA: 'Cobertura',
  STUDIO: 'Studio',
  KITNET: 'Kitnet',
  LOFT: 'Loft',
  FLAT: 'Flat',
  TERRENO: 'Terreno',
  CHACARA: 'Chácara',
  SITIO: 'Sítio',
  FAZENDA: 'Fazenda',
  COMERCIAL: 'Imóvel comercial',
  SALA: 'Sala comercial',
  GALPAO: 'Galpão',
  OUTRO: 'Imóvel'
};

const TIPOS_KENLO = {
  APARTMENT: 'APARTAMENTO',
  GARDEN_APARTMENT: 'APARTAMENTO',
  DUPLEX_APARTMENT: 'APARTAMENTO',
  TRIPLEX_APARTMENT: 'APARTAMENTO',
  PENTHOUSE: 'COBERTURA',
  STUDIO: 'STUDIO',
  KITNET: 'KITNET',
  LOFT: 'LOFT',
  FLAT: 'FLAT',
  HOUSE: 'CASA',
  TWO_STORY_HOUSE: 'SOBRADO',
  TOWNHOUSE: 'SOBRADO',
  SMALL_FARM: 'CHACARA',
  FARMHOUSE: 'SITIO',
  FARM: 'FAZENDA',
  LAND: 'TERRENO',
  LOT: 'TERRENO',
  COMMERCIAL_LAND: 'TERRENO',
  COMMERCIAL_ROOM: 'SALA',
  OFFICE: 'SALA',
  STORE: 'COMERCIAL',
  POINT: 'COMERCIAL',
  COMMERCIAL_POINT: 'COMERCIAL',
  HALL: 'COMERCIAL',
  SHED: 'GALPAO',
  WAREHOUSE: 'GALPAO',
  INDUSTRIAL_WAREHOUSE: 'GALPAO',
  AREA: 'OUTRO',
  OUTHOUSE: 'GALPAO'
};

const TIPOS_PREFIXO = {
  AP: 'APARTAMENTO', GD: 'APARTAMENTO', AD: 'APARTAMENTO',
  CA: 'CASA', SO: 'SOBRADO', ST: 'STUDIO', CH: 'CHACARA',
  SL: 'SALA', GA: 'GALPAO', TE: 'TERRENO', AR: 'OUTRO'
};

const AMENIDADES_IGNORADAS = new Set([
  'PICTURES', 'TAG_FULL_URL', 'TAG_SITE', 'FEATURED', 'SUPER_FEATURED',
  'EXCLUSIVE', 'NO_CONDO', 'ACCEPT_FINANCING', 'EXCHANGE', 'PET_FRIENDLY',
  'ELEVATOR', 'FURNISHED'
]);

const AMENIDADES = {
  ACADEMY: 'Academia',
  ACCEPT_FINANCING: 'Aceita financiamento',
  ACCESSIBILITY: 'Acessibilidade',
  AIR_CONDITIONING: 'Ar-condicionado',
  ALARM_SYSTEM: 'Sistema de alarme',
  ARTESIAN_WELL: 'Poço artesiano',
  BACKYARD: 'Quintal',
  BALCONY: 'Sacada',
  BARBECUE_GRILL: 'Churrasqueira',
  BARN: 'Celeiro',
  BICYCLE_PATH: 'Ciclovia',
  BIKE_RACK: 'Bicicletário',
  CABINET_BATHROOM: 'Armários no banheiro',
  CABINET_BEDROOM: 'Armários nos quartos',
  CABINET_CLOSET: 'Armários no closet',
  CABINET_HALLWAY: 'Armários no corredor',
  CABINET_HOME_THEATER: 'Armários no home theater',
  CABINET_KITCHEN: 'Armários na cozinha',
  CABINET_LAUNDRY_ROOM: 'Armários na lavanderia',
  CABINET_LIVING_ROOM: 'Armários na sala',
  CABINET_MAID_ROOM: 'Armários no quarto de serviço',
  CABINET_OFFICE: 'Armários no escritório',
  CABLE_TV: 'TV a cabo',
  CAR_WASH: 'Lava-rápido',
  CARETAKER: 'Zelador',
  CCTV: 'Circuito de segurança',
  CHILDREN_SWIMMING_POOL: 'Piscina infantil',
  CINEMA_ROOM: 'Sala de cinema',
  CLOAKROOM: 'Lavabo',
  CLUB: 'Clube',
  CONCIERGE_24_7: 'Portaria 24 horas',
  COVERED_GARAGE: 'Garagem coberta',
  ELECTRIC_FENCE: 'Cerca elétrica',
  ELECTRIC_GATE: 'Portão eletrônico',
  ELECTRIC_GENERATOR: 'Gerador',
  ELEVATOR: 'Elevador',
  FIREPLACE: 'Lareira',
  FITNESS_ROOM: 'Sala de ginástica',
  FLOOR_BOARD: 'Piso de tábua',
  FLOOR_BURNT_CEMENT: 'Piso de cimento queimado',
  FLOOR_CERAMIC_TILES: 'Piso cerâmico',
  FLOOR_GRANITE: 'Piso de granito',
  FLOOR_LAMINATE: 'Piso laminado',
  FLOOR_MARBLE: 'Piso de mármore',
  FLOOR_PORCELAIN_TILES: 'Piso de porcelanato',
  FLOOR_SLATE: 'Piso de ardósia',
  FLOOR_VINYL: 'Piso vinílico',
  FLOOR_WOOD: 'Piso de madeira',
  FLOOR_WOODEN_CARPET: 'Carpete de madeira',
  FURNISHED: 'Mobiliado',
  GAMES_ROOM: 'Salão de jogos',
  GARDEN: 'Jardim',
  GAS_HEATING: 'Aquecimento a gás',
  GATED_COMMUNITY: 'Condomínio fechado',
  GOURMET: 'Espaço gourmet',
  GOURMET_BALCONY: 'Varanda gourmet',
  GUARDHOUSE: 'Guarita',
  GYM_ROOM: 'Academia',
  HEATED_SWIMMING_POOL: 'Piscina aquecida',
  HOME_THEATER: 'Home theater',
  HOT_TUB: 'Ofurô',
  HYDROMASSAGE_BATHTUB: 'Banheira de hidromassagem',
  INDIVIDUAL_WATER_METER: 'Água individualizada',
  INTERPHONE: 'Interfone',
  INTERNET_FACILITIES: 'Internet',
  INTERNAL_SECURITY: 'Segurança interna',
  JOGGING_TRACK: 'Pista de caminhada',
  KITCHEN: 'Cozinha',
  LAKE: 'Lago',
  LAUNDRY_ROOM: 'Lavanderia',
  LAUNDRY_ROOM_BR: 'Área de serviço',
  MAID_BATHROOM: 'Banheiro de serviço',
  MAID_ROOM: 'Quarto de serviço',
  MASSAGE_ROOM: 'Sala de massagem',
  MEETING_ROOM: 'Sala de reunião',
  MEZZANINE: 'Mezanino',
  OFFICE: 'Escritório',
  ORCHARD: 'Pomar',
  PARTY_ROOM: 'Salão de festas',
  PAVED_ROAD: 'Acesso pavimentado',
  PAVED_STREET: 'Rua pavimentada',
  PET_FRIENDLY: 'Aceita pets',
  PLAYGROUND: 'Playground',
  PRIVATE_ELEVATOR: 'Elevador privativo',
  PROPERTY_SECURITY: 'Segurança patrimonial',
  PUBLIC_LAUNDRY: 'Lavanderia coletiva',
  RIVER: 'Rio',
  SAUNA: 'Sauna',
  SAUNA_DRY: 'Sauna seca',
  SAUNA_WET: 'Sauna úmida',
  SEA_VIEW: 'Vista para o mar',
  SECURITY_SYSTEM: 'Sistema de segurança',
  SEWER: 'Rede de esgoto',
  SOCCER_FIELD: 'Campo de futebol',
  SOLAR_HEATING: 'Aquecimento solar',
  SOLARIUM: 'Solarium',
  SPA: 'Spa',
  SPORTS_COURT: 'Quadra esportiva',
  SQUASH_COURT: 'Quadra de squash',
  SWIMMING_POOL: 'Piscina',
  TENNIS_COURT: 'Quadra de tênis',
  TOY_LIBRARY: 'Brinquedoteca',
  UNIVERSAL_ACCESSIBILITY: 'Acessibilidade universal',
  VALET_PARKING: 'Manobrista',
  VERANDA: 'Varanda',
  VISITOR_PARKING: 'Estacionamento para visitantes',
  WATER: 'Água',
  WATER_TANK: 'Caixa d’água',
  WIFI: 'Wi-Fi',
  WINECELLAR: 'Adega',
  WOOD_OVEN: 'Forno a lenha',
  YARD: 'Pátio'
};

const GRUPOS = {
  LEISURE: 'LAZER',
  SECURITY: 'SEGURANCA',
  INFRASTRUCTURE: 'CONDOMINIO',
  SERVICES: 'CONDOMINIO',
  SOCIAL: 'IMOVEL',
  INTIMATE: 'IMOVEL',
  CABINETS: 'IMOVEL',
  FLOOR: 'IMOVEL',
  FINISH: 'IMOVEL',
  STRUCTURE: 'IMOVEL',
  CONDITIONS: 'IMOVEL'
};

function normalizarEspacos(valor) {
  return String(valor || '').replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
}

function primeiroNumero(valor) {
  if (Array.isArray(valor)) {
    const numero = valor.map(Number).find((item) => Number.isFinite(item) && item > 0);
    return numero ?? null;
  }
  const numero = Number(valor);
  return Number.isFinite(numero) && numero > 0 ? numero : null;
}

function inteiro(valor) {
  const numero = primeiroNumero(valor);
  return numero === null ? null : Math.round(numero);
}

function baseReferencia(item) {
  return String(item.property_reference || item.property_full_reference || '')
    .split('-')[0]
    .trim()
    .toUpperCase();
}

function tipoLocal(item) {
  const referencia = baseReferencia(item);
  const prefixo = (referencia.match(/^[A-Z]+/) || [''])[0];
  return TIPOS_KENLO[item.property_type] || TIPOS_PREFIXO[prefixo] || 'OUTRO';
}

function textoSemPreco(texto) {
  return normalizarEspacos(texto)
    .replace(/,?\s*(à|a) venda(?:\s+por)?\s+R\$.*$/i, '')
    .replace(/,?\s*para venda.*$/i, '')
    .trim();
}

function montarTitulo(item) {
  const tipo = tipoLocal(item);
  const quartos = inteiro(item.bedrooms);
  const area = primeiroNumero(item.usable_floor_area || item.area || item.gross_floor_area);
  const bairro = item.neighborhood_display || item.neighborhood;
  const partes = [ROTULOS_TIPO[tipo] || 'Imóvel'];
  if (quartos) partes.push(`com ${quartos} ${quartos === 1 ? 'dormitório' : 'dormitórios'}`);
  let titulo = partes.join(' ');
  if (area) titulo += `, ${Number(area).toLocaleString('pt-BR')} m²`;
  if (bairro) titulo += `, em ${bairro}`;
  return titulo.slice(0, 160);
}

function endereco(item) {
  const primeiraParte = normalizarEspacos(item.full_address).split(' - ')[0] || null;
  if (!primeiraParte) return null;
  if (item.street_type && !primeiraParte.toLowerCase().startsWith(String(item.street_type).toLowerCase())) {
    return `${item.street_type} ${primeiraParte}`.slice(0, 180);
  }
  return primeiraParte.slice(0, 180);
}

function resumoDescricao(descricao) {
  const limpo = normalizarEspacos(descricao).replace(/\n+/g, ' ');
  if (!limpo) return null;
  return limpo.length <= 400 ? limpo : `${limpo.slice(0, 397).trim()}...`;
}

function grupoAmenidade(codigo, catalogos) {
  for (const catalogo of catalogos) {
    if (catalogo && catalogo[codigo]) return GRUPOS[catalogo[codigo]] || 'IMOVEL';
  }
  if (/^(POOL|SWIMMING|PLAYGROUND|PARTY|GAMES|SPORTS|SAUNA|SPA|BARBECUE|FITNESS|ACADEMY)/.test(codigo)) return 'LAZER';
  if (/(SECURITY|GUARD|CCTV|ALARM|CONCIERGE)/.test(codigo)) return 'SEGURANCA';
  return 'IMOVEL';
}

function caracteristicas(item, catalogos = []) {
  const lista = [];
  for (const codigo of Array.isArray(item.amenities) ? item.amenities : []) {
    if (AMENIDADES_IGNORADAS.has(codigo)) continue;
    const label = AMENIDADES[codigo];
    if (!label) continue;
    lista.push({ slug: codigo, label, grupo: grupoAmenidade(codigo, catalogos) });
  }
  return normalizarCaracteristicas(lista) || [];
}

function mapearImovel(item, { publish, existente, catalogos = [] }) {
  const amenities = new Set(Array.isArray(item.amenities) ? item.amenities : []);
  const referencia = baseReferencia(item);
  const suites = inteiro(item.suites) || 0;
  const dormitorios = Math.max(inteiro(item.bedrooms) || 0, suites);
  const descricao = normalizarEspacos(item.listing_description);
  const purposes = Array.isArray(item.property_purposes)
    ? item.property_purposes
    : [item.property_purposes].filter(Boolean);
  const urlOrigem = item.url ? new URL(item.url, SITE).toString() : null;

  return {
    body: {
      titulo: montarTitulo(item),
      referenciaExterna: referencia,
      descricao: descricao || null,
      descricaoResumida: resumoDescricao(descricao),
      finalidade: 'VENDA',
      tipo: tipoLocal(item),
      subtipo: item.property_type || null,
      situacao: purposes.includes('NEW') || item.__lancamento ? 'NOVO' : 'USADO',
      status: 'DISPONIVEL',
      origemCarteira: 'TERCEIRO',
      visibilidade: 'TODOS',
      ativo: true,
      destaque: amenities.has('FEATURED') || amenities.has('SUPER_FEATURED'),
      oportunidade: false,
      exclusivo: amenities.has('EXCLUSIVE'),
      lancamento: purposes.includes('NEW') || Boolean(item.__lancamento),
      publicarSite: publish ? true : Boolean(existente?.publicar_site),
      valorVenda: primeiroNumero(item.sale_price),
      valorLocacao: null,
      valorCondominio: primeiroNumero(item.condo_fees),
      valorIptu: primeiroNumero(item.property_tax || item.property_taxes || item.property_tax_value),
      iptuPeriodo: item.property_tax_payment === 'MONTHLY' ? 'MENSAL' : 'ANUAL',
      aceitaFinanciamento: amenities.has('ACCEPT_FINANCING'),
      aceitaFgts: amenities.has('ACCEPT_FGTS') || amenities.has('USE_FGTS'),
      aceitaPermuta: amenities.has('EXCHANGE'),
      dormitorios,
      suites,
      banheiros: inteiro(item.bathrooms),
      vagas: inteiro(item.garages),
      areaUtil: primeiroNumero(item.usable_floor_area || item.area),
      areaTotal: primeiroNumero(item.gross_floor_area || item.area),
      areaConstruida: primeiroNumero(item.private_floor_area),
      areaTerreno: primeiroNumero(item.land_area),
      andar: inteiro(item.floor),
      totalAndares: inteiro(item.total_floors),
      anoConstrucao: inteiro(item.year_built),
      mobiliado: amenities.has('FURNISHED'),
      elevador: amenities.has('ELEVATOR'),
      petFriendly: amenities.has('PET_FRIENDLY'),
      logradouro: endereco(item),
      numero: null,
      complemento: null,
      bairro: item.neighborhood_display || item.neighborhood || null,
      cidade: item.city || null,
      uf: item.state || null,
      latitude: item.latitude || null,
      longitude: item.longitude || null,
      exibirEnderecoCompleto: false,
      empreendimentoLegadoId: item.building_cid ? String(item.building_cid) : null,
      empreendimentoNome: item.building || null,
      unidadeLegadoId: item.property_cid ? `KENLO:${item.property_cid}` : null,
      unidadeIdentificacao: item.property_full_reference || referencia,
      observacoesInternas: [
        'Importado da carteira Kenlo.',
        item.property_cid ? `CID: ${item.property_cid}.` : null,
        item.property_full_reference ? `Referência completa: ${item.property_full_reference}.` : null,
        urlOrigem ? `Origem: ${urlOrigem}` : null
      ].filter(Boolean).join(' ')
    },
    caracteristicas: caracteristicas(item, catalogos)
  };
}

async function fetchText(url, tentativa = 1) {
  const response = await fetch(url, {
    headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xml;q=0.9,*/*;q=0.8' },
    signal: AbortSignal.timeout(30000)
  });
  if (!response.ok) {
    const limite = response.status === 429 ? 7 : 4;
    if (tentativa < limite && (response.status === 429 || response.status >= 500)) {
      const retryAfter = Number(response.headers.get('retry-after'));
      const espera = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : response.status === 429
          ? Math.min(15000, tentativa * 2000)
          : tentativa * 700;
      await new Promise((resolve) => setTimeout(resolve, espera));
      return fetchText(url, tentativa + 1);
    }
    throw new Error(`HTTP ${response.status} em ${url}`);
  }
  return response.text();
}

function extrairJsonMarko(html, prefixo) {
  const regexp = new RegExp(`window\\.markoVars\\['${prefixo}-[^']+'\\]\\s*=\\s*`);
  const match = regexp.exec(html);
  if (!match) throw new Error(`Objeto ${prefixo} não encontrado na página.`);

  const inicio = match.index + match[0].length;
  let profundidade = 0;
  let emString = false;
  let escape = false;

  for (let indice = inicio; indice < html.length; indice += 1) {
    const caractere = html[indice];
    if (emString) {
      if (escape) escape = false;
      else if (caractere === '\\') escape = true;
      else if (caractere === '"') emString = false;
      continue;
    }

    if (caractere === '"') emString = true;
    else if (caractere === '{') profundidade += 1;
    else if (caractere === '}') {
      profundidade -= 1;
      if (profundidade === 0) return JSON.parse(html.slice(inicio, indice + 1));
    }
  }

  throw new Error(`JSON ${prefixo} incompleto.`);
}

function urlsXml(xml) {
  return [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map((match) => match[1].replace(/&amp;/g, '&'));
}

function urlListagemDoSitemap(url) {
  const objeto = new URL(url);
  objeto.pathname = objeto.pathname.replace(/^\/sitemap/, '').replace(/\.xml$/i, '');
  objeto.search = '';
  return objeto.toString();
}

async function mapLimit(itens, limite, fn) {
  const resultados = new Array(itens.length);
  let proximo = 0;
  async function worker() {
    while (proximo < itens.length) {
      const indice = proximo;
      proximo += 1;
      resultados[indice] = await fn(itens[indice], indice);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limite, itens.length) }, worker));
  return resultados;
}

async function coletarListagens() {
  const indiceXml = await fetchText(SITEMAP);
  const sitemaps = urlsXml(indiceXml).filter((url) =>
    /\/sitemap\/imoveis\/(a-venda|novos)\//i.test(url) && !/para-alugar/i.test(url)
  );
  const bases = [...new Set(sitemaps.map(urlListagemDoSitemap))];
  const encontrados = new Map();

  console.log(`Fontes públicas de venda: ${bases.length}`);

  for (const [indice, base] of bases.entries()) {
    const primeiraHtml = await fetchText(base);
    const primeira = extrairJsonMarko(primeiraHtml, 'listings');
    const total = Number(primeira.settings?.listings?.count || 0);
    const primeiraPagina = primeira.settings?.listings?.data || [];
    const porPagina = Math.max(primeiraPagina.length, 12);
    const paginas = Math.max(1, Math.ceil(total / porPagina));
    const urls = Array.from({ length: Math.max(0, paginas - 1) }, (_, pagina) => `${base}?pagina=${pagina + 2}`);
    const demais = await mapLimit(urls, 5, async (url) => {
      const html = await fetchText(url);
      return extrairJsonMarko(html, 'listings').settings?.listings?.data || [];
    });
    const todos = [primeiraPagina, ...demais].flat();
    const lancamento = /\/novos\//i.test(base);

    for (const item of todos) {
      const ref = baseReferencia(item);
      if (!ref) continue;
      const anterior = encontrados.get(ref);
      encontrados.set(ref, { ...anterior, ...item, __lancamento: lancamento || anterior?.__lancamento });
    }

    console.log(`[${indice + 1}/${bases.length}] ${base.replace(SITE, '')}: ${total}`);
  }

  return encontrados;
}

async function listarDetalhesPendentes(conjunto) {
  const result = await pool.query(
    `SELECT referencia_externa, observacoes_internas
     FROM imoveis
     WHERE deleted_at IS NULL
       AND unidade_legado_id IS NULL
       AND UPPER(referencia_externa) = ANY($1::text[])
     ORDER BY referencia_externa`,
    [[...conjunto]]
  );
  const encontrados = new Map();
  for (const row of result.rows) {
    const match = String(row.observacoes_internas || '').match(/Origem:\s*(https:\/\/\S+)/i);
    if (!match) continue;
    const referencia = String(row.referencia_externa).toUpperCase();
    encontrados.set(referencia, {
      property_reference: referencia,
      property_full_reference: referencia,
      property_purposes: ['FOR_SALE'],
      url: match[1],
      __detalhePendente: true
    });
  }
  return encontrados;
}

async function enriquecerDetalhe(item) {
  if (SKIP_DETAILS || !item.url) return { item, catalogos: [] };
  const url = new URL(item.url, SITE).toString();
  try {
    if (SLOW) await new Promise((resolve) => setTimeout(resolve, 750));
    const html = await fetchText(url);
    const detalhe = extrairJsonMarko(html, 'listing-details');
    const listagem = detalhe.settings?.listing;
    if (!Array.isArray(listagem) || !listagem[0]) return { item, catalogos: [] };
    return {
      item: { ...item, ...listagem[0], __lancamento: item.__lancamento },
      catalogos: listagem.slice(1).filter((valor) => valor && typeof valor === 'object')
    };
  } catch (error) {
    console.warn(`  Aviso: detalhe ${baseReferencia(item)} indisponível: ${error.message}`);
    if (item.__detalhePendente && /HTTP 429/.test(error.message)) throw error;
    return item.__detalhePendente ? null : { item, catalogos: [] };
  }
}

async function usuarioImportacao() {
  const result = await pool.query(
    `SELECT id, nome, perfil FROM usuarios
     WHERE perfil = 'admin' AND COALESCE(ativo, TRUE) = TRUE
     ORDER BY created_at ASC LIMIT 1`
  );
  if (!result.rows[0]) throw new Error('Nenhum usuário administrador ativo para auditar a importação.');
  return result.rows[0];
}

async function existentePorReferencia(referencia) {
  const result = await pool.query(
    `SELECT * FROM imoveis
     WHERE LOWER(referencia_externa) = LOWER($1) AND deleted_at IS NULL
     ORDER BY created_at ASC LIMIT 1`,
    [referencia]
  );
  return result.rows[0] || null;
}

function chaveMidia(referencia, tipo, url) {
  const hash = crypto.createHash('sha1').update(url).digest('hex');
  return `kenlo/${referencia.toLowerCase()}/${tipo.toLowerCase()}/${hash}`;
}

async function salvarMidias(imovelId, referencia, item, usuarioId) {
  const fotos = (Array.isArray(item.photos) ? item.photos : [])
    .filter((foto) => foto && (foto.picture_full || foto.picture_thumb));
  const jaTemCapa = await pool.query(
    `SELECT 1 FROM imovel_midias WHERE imovel_id = $1 AND capa LIMIT 1`, [imovelId]
  );
  let capaDisponivel = jaTemCapa.rowCount === 0;
  let salvas = 0;

  for (const [ordem, foto] of fotos.entries()) {
    const url = foto.picture_full || foto.picture_thumb;
    const thumb = foto.picture_thumb || url;
    const objectKey = chaveMidia(referencia, 'imagem', url);
    const existente = await pool.query(
      `SELECT id, capa FROM imovel_midias WHERE imovel_id = $1 AND bucket = 'external-kenlo' AND object_key = $2 LIMIT 1`,
      [imovelId, objectKey]
    );
    const capa = capaDisponivel && ordem === 0;

    if (existente.rows[0]) {
      await pool.query(
        `UPDATE imovel_midias
         SET url = $1, url_web = $1, url_thumb = $2, ordem = $3,
             legenda = $4, alt_text = $5, publica = TRUE, updated_at = NOW()
         WHERE id = $6`,
        [url, thumb, ordem, foto.picture_description || null,
          foto.picture_title || `Foto do imóvel ${referencia}`, existente.rows[0].id]
      );
    } else {
      await pool.query(
        `INSERT INTO imovel_midias
          (imovel_id, tipo, bucket, object_key, url, url_web, url_thumb, mime_type,
           extensao, processamento, legenda, alt_text, ordem, capa, publica, created_by)
         VALUES ($1, 'IMAGEM', 'external-kenlo', $2, $3, $3, $4, 'image/jpeg',
                 'jpg', 'COMPLETO', $5, $6, $7, $8, TRUE, $9)`,
        [imovelId, objectKey, url, thumb, foto.picture_description || null,
          foto.picture_title || `Foto do imóvel ${referencia}`, ordem, capa, usuarioId]
      );
      if (capa) capaDisponivel = false;
    }
    salvas += 1;
  }

  const externas = [
    ['VIDEO', item.video_url],
    ['TOUR_360', item.virtual_tour_url]
  ].filter(([, url]) => /^https:\/\//i.test(String(url || '')));

  for (const [tipo, url] of externas) {
    const objectKey = chaveMidia(referencia, tipo, url);
    const existente = await pool.query(
      `SELECT id FROM imovel_midias WHERE imovel_id = $1 AND bucket = 'external-kenlo' AND object_key = $2 LIMIT 1`,
      [imovelId, objectKey]
    );
    if (!existente.rows[0]) {
      await pool.query(
        `INSERT INTO imovel_midias
          (imovel_id, tipo, bucket, object_key, url, url_externa, processamento,
           legenda, ordem, capa, publica, created_by)
         VALUES ($1, $2, 'external-kenlo', $3, $4, $4, 'COMPLETO', $5, 999, FALSE, TRUE, $6)`,
        [imovelId, tipo, objectKey, url, `${tipo === 'VIDEO' ? 'Vídeo' : 'Tour virtual'} do imóvel ${referencia}`, usuarioId]
      );
    }
  }

  await imoveisService.recalcularScores(imovelId);
  return salvas;
}

async function importarUm(enriquecido, usuario) {
  const { item, catalogos } = enriquecido;
  const referencia = baseReferencia(item);
  const existente = await existentePorReferencia(referencia);
  const mapeado = mapearImovel(item, { publish: PUBLISH, existente, catalogos });
  const dados = normalizarImovel(mapeado.body, { parcial: false });
  let imovelId;
  let acao;

  if (existente) {
    imovelId = await imoveisService.atualizar({
      id: existente.id,
      dados,
      caracteristicas: mapeado.caracteristicas,
      usuario
    });
    acao = 'atualizado';
  } else {
    imovelId = await imoveisService.criar({
      dados,
      caracteristicas: mapeado.caracteristicas,
      usuario
    });
    acao = 'criado';
  }

  const fotos = await salvarMidias(imovelId, referencia, item, usuario.id);
  return { referencia, imovelId, acao, fotos };
}

async function main() {
  const referencias = JSON.parse(fs.readFileSync(REFERENCIAS_PATH, 'utf8'));
  const conjunto = new Set(referencias.map((ref) => String(ref).toUpperCase()));
  if (conjunto.size !== 332) throw new Error(`Lista ativa inválida: ${conjunto.size} referências.`);

  console.log(`Modo: ${APPLY ? 'IMPORTAÇÃO' : 'CONFERÊNCIA'}${PUBLISH ? ' + PUBLICAÇÃO' : ''}`);
  console.log(`Referências ativas conferidas no painel: ${conjunto.size}`);

  const somenteDetalhesPendentes = APPLY && MISSING_DETAILS_ONLY;
  const publicos = somenteDetalhesPendentes
    ? await listarDetalhesPendentes(conjunto)
    : await coletarListagens();
  const selecionados = [...publicos.values()].filter((item) => conjunto.has(baseReferencia(item)));
  const encontrados = new Set(selecionados.map(baseReferencia));
  const faltantes = somenteDetalhesPendentes
    ? []
    : [...conjunto].filter((ref) => !encontrados.has(ref));
  const terceirosIgnorados = [...publicos.keys()].filter((ref) => !conjunto.has(ref));
  const locacaoNaCarteira = selecionados.filter((item) => {
    const purposes = Array.isArray(item.property_purposes) ? item.property_purposes : [item.property_purposes];
    return !purposes.includes('FOR_SALE');
  });
  const somenteVenda = selecionados.filter((item) => !locacaoNaCarteira.includes(item));

  console.log(somenteDetalhesPendentes ? '\nComplementação:' : '\nConferência:');
  if (somenteDetalhesPendentes) {
    console.log(`  Imóveis ainda sem detalhe completo: ${selecionados.length}`);
  } else {
    console.log(`  Imóveis públicos localizados da carteira: ${selecionados.length}`);
    console.log(`  Imóveis de terceiros/compartilhados ignorados: ${terceirosIgnorados.length}`);
    console.log(`  Referências ativas sem anúncio público: ${faltantes.length}`);
    console.log(`  Registros sem finalidade de venda ignorados: ${locacaoNaCarteira.length}`);
    if (faltantes.length) console.log(`  Faltantes: ${faltantes.join(', ')}`);
  }

  if (!APPLY) {
    console.log('\nNada foi gravado. Execute novamente com --apply depois de validar a conferência.');
    return;
  }

  const usuario = await usuarioImportacao();
  let alvoImportacao = somenteVenda;
  if (MISSING_DETAILS_ONLY) {
    const pendentes = await pool.query(
      `SELECT UPPER(referencia_externa) AS referencia
       FROM imoveis
       WHERE deleted_at IS NULL
         AND unidade_legado_id IS NULL
         AND UPPER(referencia_externa) = ANY($1::text[])`,
      [[...conjunto]]
    );
    const refsPendentes = new Set(pendentes.rows.map((row) => row.referencia));
    alvoImportacao = somenteVenda.filter((item) => refsPendentes.has(baseReferencia(item)));
  }
  console.log(`\nBuscando detalhes de ${alvoImportacao.length} imóveis...`);
  let detalhados = 0;
  const enriquecidosBrutos = await mapLimit(alvoImportacao, SLOW ? 1 : 6, async (item) => {
    const resultado = await enriquecerDetalhe(item);
    detalhados += 1;
    if (detalhados % 25 === 0 || detalhados === alvoImportacao.length) {
      console.log(`  Detalhes: ${detalhados}/${alvoImportacao.length}`);
    }
    return resultado;
  });
  const enriquecidos = enriquecidosBrutos.filter(Boolean);
  if (enriquecidos.length !== enriquecidosBrutos.length) {
    console.warn(`  Detalhes adiados por limite temporário: ${enriquecidosBrutos.length - enriquecidos.length}`);
  }

  const resumo = { criados: 0, atualizados: 0, fotos: 0, erros: [] };
  for (const [indice, item] of enriquecidos.entries()) {
    try {
      const resultado = await importarUm(item, usuario);
      resumo[resultado.acao === 'criado' ? 'criados' : 'atualizados'] += 1;
      resumo.fotos += resultado.fotos;
    } catch (error) {
      resumo.erros.push({ referencia: baseReferencia(item.item), erro: error.message });
      console.error(`  Erro em ${baseReferencia(item.item)}: ${error.message}`);
    }
    if ((indice + 1) % 20 === 0 || indice + 1 === enriquecidos.length) {
      console.log(`  Gravação: ${indice + 1}/${enriquecidos.length}`);
    }
  }

  const validacao = await pool.query(
    `SELECT COUNT(*)::int AS imoveis,
            COUNT(*) FILTER (WHERE publicar_site)::int AS publicados,
            COALESCE(SUM((SELECT COUNT(*) FROM imovel_midias m WHERE m.imovel_id = i.id AND m.tipo = 'IMAGEM')), 0)::int AS fotos
     FROM imoveis i
     WHERE deleted_at IS NULL AND referencia_externa = ANY($1::text[])`,
    [[...conjunto]]
  );

  console.log('\nResultado da importação:');
  console.log(`  Criados: ${resumo.criados}`);
  console.log(`  Atualizados: ${resumo.atualizados}`);
  console.log(`  Fotos vinculadas: ${resumo.fotos}`);
  console.log(`  Erros: ${resumo.erros.length}`);
  console.log(`  Banco: ${validacao.rows[0].imoveis} imóveis, ${validacao.rows[0].fotos} fotos, ${validacao.rows[0].publicados} publicados.`);
  if (!PUBLISH) console.log('  Publicação automática desativada nesta execução.');
  if (resumo.erros.length) {
    console.log(JSON.stringify(resumo.erros, null, 2));
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error('\nFalha na importação:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
