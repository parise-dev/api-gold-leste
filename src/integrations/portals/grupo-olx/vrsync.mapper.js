/**
 * Mapeamento Gold Leste -> VRSync (Grupo OLX: ZAP Imóveis / Viva Real).
 *
 * Fonte oficial consultada em 2026-08-16:
 *   https://developers.grupozap.com/feeds/xml-formats/
 *   https://developers.grupozap.com/feeds/vrsync/elements/header.html
 *   https://developers.grupozap.com/feeds/vrsync/elements/listing.html
 *   https://developers.grupozap.com/feeds/vrsync/elements/details.html
 *
 * Nada aqui é inventado: tags, atributos e valores enumerados vêm da
 * documentação acima. Onde o Gold Leste não tem equivalente exato, o
 * campo é omitido (é opcional) em vez de preenchido com um chute.
 */

const { escaparXml, cdata, tag, declaracao } = require('../../../utils/xml');

const NAMESPACE = 'http://www.vivareal.com/schemas/1.0/VRSync';
const SCHEMA_LOCATION = 'http://www.vivareal.com/schemas/1.0/VRSync http://xml.vivareal.com/vrsync.xsd';

/** TransactionType — valores oficiais. */
const TRANSACTION_TYPE = {
  VENDA: 'For Sale',
  LOCACAO: 'For Rent',
  VENDA_LOCACAO: 'Sale/Rent'
};

/** PropertyType — "Uso / Tipo", conforme documentação de Details. */
const PROPERTY_TYPE = {
  APARTAMENTO: 'Residential / Apartment',
  CASA: 'Residential / Home',
  SOBRADO: 'Residential / Home',
  COBERTURA: 'Residential / Penthouse',
  STUDIO: 'Residential / Kitnet',
  KITNET: 'Residential / Kitnet',
  LOFT: 'Residential / Loft',
  FLAT: 'Residential / Flat',
  TERRENO: 'Residential / Land Lot',
  CHACARA: 'Residential / Country House',
  SITIO: 'Residential / Farm Ranch',
  FAZENDA: 'Residential / Farm Ranch',
  COMERCIAL: 'Commercial / Building',
  SALA: 'Commercial / Office',
  GALPAO: 'Commercial / Industrial',
  OUTRO: 'Residential / Home'
};

/** UsageType — Residential | Commercial | Residential / Commercial. */
const USAGE_TYPE = {
  APARTAMENTO: 'Residential',
  CASA: 'Residential',
  SOBRADO: 'Residential',
  COBERTURA: 'Residential',
  STUDIO: 'Residential',
  KITNET: 'Residential',
  LOFT: 'Residential',
  FLAT: 'Residential',
  TERRENO: 'Residential',
  CHACARA: 'Residential',
  SITIO: 'Residential',
  FAZENDA: 'Residential',
  COMERCIAL: 'Commercial',
  SALA: 'Commercial',
  GALPAO: 'Commercial',
  OUTRO: 'Residential'
};

/**
 * PublicationType oficial: STANDARD | PREMIUM | SUPER_PREMIUM |
 * PREMIERE_1 | PREMIERE_2 | TRIPLE.
 */
const PUBLICATION_TYPES = [
  'STANDARD', 'PREMIUM', 'SUPER_PREMIUM', 'PREMIERE_1', 'PREMIERE_2', 'TRIPLE'
];

/**
 * displayAddress: All | Street | Neighborhood.
 * Precisa refletir o que realmente é enviado: quando o imóvel não
 * autoriza endereço completo, <Address>/<StreetNumber> são omitidos e
 * o valor correto passa a ser "Neighborhood".
 */
function displayAddress(imovel) {
  return imovel.exibir_endereco_completo ? 'All' : 'Neighborhood';
}

/**
 * Feature — o Grupo OLX aceita um conjunto pré-definido de valores.
 * Só mapeamos as características cujo equivalente oficial conhecemos;
 * as demais ficam de fora do feed (e continuam na página pública).
 */
const FEATURES = {
  piscina: 'Pool',
  academia: 'Gym',
  churrasqueira: 'Barbecue Grill',
  'salao-festas': 'Party Hall',
  playground: 'Playground',
  quadra: 'Sports Court',
  sauna: 'Sauna',
  'portaria-24h': 'Concierge 24h',
  'circuito-cameras': 'Security Camera',
  seguranca: 'Security',
  'ar-condicionado': 'Air Conditioning',
  closet: 'Closet',
  varanda: 'Balcony',
  'varanda-gourmet': 'Gourmet Balcony',
  sacada: 'Balcony',
  'area-servico': 'Service Area',
  'espaco-gourmet': 'Gourmet Space',
  'cozinha-planejada': 'Fitted Kitchen',
  'aquecimento-solar': 'Solar Energy',
  lareira: 'Fireplace',
  despensa: 'Pantry',
  elevador: 'Elevator',
  'elevador-social': 'Elevator',
  acessibilidade: 'Disabled Access',
  'condominio-fechado': 'Gated Community',
  'portao-eletronico': 'Electronic Gate',
  gerador: 'Generator',
  coworking: 'Coworking'
};

function inteiroPositivo(valor) {
  const numero = Number(valor);
  if (!Number.isFinite(numero) || numero <= 0) return null;
  return Math.round(numero);
}

/**
 * Regras de validação retiradas da documentação oficial.
 * Devolver erro aqui evita XML inválido chegando ao portal.
 */
function validar({ imovel, midias = [], integracao }) {
  const erros = [];
  const avisos = [];

  const titulo = String(imovel.titulo || '').trim();

  if (titulo.length < 10 || titulo.length > 100) {
    erros.push({
      campo: 'titulo',
      mensagem: 'Title deve ter entre 10 e 100 caracteres (regra oficial VRSync).'
    });
  }

  const descricao = String(imovel.descricao || '').trim();

  if (descricao.length < 50) {
    erros.push({
      campo: 'descricao',
      mensagem: 'Description deve ter no mínimo 50 caracteres (regra oficial VRSync).'
    });
  }

  if (descricao.length > 3000) {
    avisos.push({
      campo: 'descricao',
      mensagem: 'Description acima de 3.000 caracteres será truncada no feed.'
    });
  }

  if (!imovel.cidade) erros.push({ campo: 'cidade', mensagem: 'Location/City é obrigatório.' });
  if (!imovel.uf) erros.push({ campo: 'uf', mensagem: 'Location/State é obrigatório.' });
  if (!imovel.bairro) {
    erros.push({ campo: 'bairro', mensagem: 'Location/Neighborhood é obrigatório.' });
  }

  if (!TRANSACTION_TYPE[imovel.finalidade]) {
    erros.push({ campo: 'finalidade', mensagem: 'Finalidade sem equivalente em TransactionType.' });
  }

  if (!PROPERTY_TYPE[imovel.tipo]) {
    erros.push({
      campo: 'tipo',
      mensagem: `Tipo "${imovel.tipo}" ainda não possui mapeamento oficial para PropertyType.`
    });
  }

  const precisaVenda = imovel.finalidade === 'VENDA' || imovel.finalidade === 'VENDA_LOCACAO';
  const precisaLocacao = imovel.finalidade === 'LOCACAO' || imovel.finalidade === 'VENDA_LOCACAO';

  if (precisaVenda && !inteiroPositivo(imovel.valor_venda)) {
    erros.push({ campo: 'valorVenda', mensagem: 'ListPrice é obrigatório para venda.' });
  }

  if (precisaLocacao && !inteiroPositivo(imovel.valor_locacao)) {
    erros.push({ campo: 'valorLocacao', mensagem: 'RentalPrice é obrigatório para locação.' });
  }

  const semArea = !inteiroPositivo(imovel.area_util) && !inteiroPositivo(imovel.area_total);

  if (semArea) {
    erros.push({
      campo: 'areaUtil',
      mensagem: 'LivingArea é obrigatório para a maioria dos tipos. Informe área útil ou total.'
    });
  }

  const imagens = midias.filter((midia) => midia.tipo === 'IMAGEM' && midia.publica);

  if (imagens.length < 5) {
    erros.push({
      campo: 'midias',
      mensagem: `Mínimo de 5 fotos exigido pelo Grupo OLX (o imóvel possui ${imagens.length}).`
    });
  }

  if (!imagens.some((midia) => midia.capa)) {
    avisos.push({
      campo: 'midias',
      mensagem: 'Sem foto de capa definida: a primeira foto será enviada como primary.'
    });
  }

  if (imovel.tipo === 'KITNET' || imovel.tipo === 'STUDIO') {
    if (inteiroPositivo(imovel.dormitorios)) {
      avisos.push({
        campo: 'dormitorios',
        mensagem: 'Para Residential/Kitnet o portal exige Bedrooms = 0. O feed enviará 0.'
      });
    }
  }

  if (!integracao?.contato_nome || !integracao?.contato_email) {
    erros.push({
      campo: 'integracao',
      mensagem: 'ContactInfo (nome e e-mail da imobiliária) é obrigatório. Configure em Integrações > Portais.'
    });
  }

  const videos = midias.filter((midia) => midia.tipo === 'VIDEO' && midia.url_externa);

  if (videos.length > 1) {
    avisos.push({
      campo: 'midias',
      mensagem: 'O portal aceita apenas 1 vídeo por anúncio. Apenas o primeiro será enviado.'
    });
  }

  return { ok: erros.length === 0, erros, avisos };
}

function montarLocation(imovel, indent) {
  const linhas = [];

  linhas.push(tag('Country', 'BR', { indent, obrigatoria: true }));
  linhas.push(tag('State', imovel.uf, { indent, obrigatoria: true }));
  linhas.push(tag('City', imovel.cidade, { indent, obrigatoria: true }));
  linhas.push(tag('Neighborhood', imovel.bairro, { indent, obrigatoria: true }));

  if (imovel.exibir_endereco_completo) {
    linhas.push(tag('Address', imovel.logradouro, { indent }));
    linhas.push(tag('StreetNumber', imovel.numero, { indent }));
    linhas.push(tag('Complement', imovel.complemento, { indent }));
  }

  linhas.push(tag('PostalCode', imovel.cep ? String(imovel.cep).replace(/\D/g, '') : null, { indent }));
  linhas.push(tag('Latitude', imovel.latitude, { indent }));
  linhas.push(tag('Longitude', imovel.longitude, { indent }));

  return linhas.join('');
}

function montarDetails(imovel, caracteristicas, indent) {
  const linhas = [];

  linhas.push(tag('PropertyType', PROPERTY_TYPE[imovel.tipo], { indent, obrigatoria: true }));
  linhas.push(tag('UsageType', USAGE_TYPE[imovel.tipo] || 'Residential', { indent }));

  const descricao = String(imovel.descricao || '').trim().slice(0, 3000);
  linhas.push(`${indent}<Description>${cdata(descricao)}</Description>\n`);

  const area = inteiroPositivo(imovel.area_util) || inteiroPositivo(imovel.area_total);

  if (area) {
    linhas.push(tag('LivingArea', area, { indent, attrs: { unit: 'square metres' }, obrigatoria: true }));
  }

  const areaTotal = inteiroPositivo(imovel.area_total);

  if (areaTotal && areaTotal !== area) {
    linhas.push(tag('LotArea', areaTotal, { indent, attrs: { unit: 'square metres' } }));
  }

  if (imovel.finalidade === 'VENDA' || imovel.finalidade === 'VENDA_LOCACAO') {
    linhas.push(
      tag('ListPrice', inteiroPositivo(imovel.valor_venda), { indent, attrs: { currency: 'BRL' } })
    );
  }

  if (imovel.finalidade === 'LOCACAO' || imovel.finalidade === 'VENDA_LOCACAO') {
    linhas.push(
      tag('RentalPrice', inteiroPositivo(imovel.valor_locacao), {
        indent,
        attrs: { currency: 'BRL', period: 'Monthly' }
      })
    );
  }

  linhas.push(
    tag('PropertyAdministrationFee', inteiroPositivo(imovel.valor_condominio), {
      indent,
      attrs: { currency: 'BRL' }
    })
  );

  linhas.push(
    tag('Iptu', inteiroPositivo(imovel.valor_iptu), {
      indent,
      attrs: { currency: 'BRL', period: imovel.iptu_periodo === 'MENSAL' ? 'Monthly' : 'Yearly' }
    })
  );

  const semDormitorio = imovel.tipo === 'KITNET' || imovel.tipo === 'STUDIO';

  linhas.push(
    tag('Bedrooms', semDormitorio ? 0 : inteiroPositivo(imovel.dormitorios), {
      indent,
      obrigatoria: semDormitorio
    })
  );

  linhas.push(tag('Bathrooms', inteiroPositivo(imovel.banheiros), { indent }));
  linhas.push(tag('Suites', inteiroPositivo(imovel.suites), { indent }));
  linhas.push(tag('Garage', inteiroPositivo(imovel.vagas), { indent }));
  linhas.push(tag('UnitFloor', inteiroPositivo(imovel.andar), { indent }));
  linhas.push(tag('Floors', inteiroPositivo(imovel.total_andares), { indent }));
  linhas.push(tag('YearBuilt', inteiroPositivo(imovel.ano_construcao), { indent }));

  const features = [...new Set(
    (caracteristicas || [])
      .map((item) => FEATURES[item.slug])
      .filter(Boolean)
  )];

  if (imovel.elevador && !features.includes('Elevator')) features.push('Elevator');
  if (imovel.mobiliado) features.push('Furnished');
  if (imovel.pet_friendly) features.push('Pets Allowed');

  if (features.length) {
    linhas.push(`${indent}<Features>\n`);

    for (const feature of features) {
      linhas.push(tag('Feature', feature, { indent: `${indent}  ` }));
    }

    linhas.push(`${indent}</Features>\n`);
  }

  return linhas.join('');
}

function montarMedia(imovel, midias, indent) {
  const imagens = midias
    .filter((midia) => midia.tipo === 'IMAGEM' && midia.publica)
    .sort((a, b) => (b.capa ? 1 : 0) - (a.capa ? 1 : 0) || a.ordem - b.ordem);

  const videos = midias.filter((midia) => midia.tipo === 'VIDEO' && midia.url_externa).slice(0, 1);

  if (!imagens.length && !videos.length) return '';

  const linhas = [`${indent}<Media>\n`];
  const itemIndent = `${indent}  `;

  let jaMarcouPrimaria = false;

  for (const [indice, imagem] of imagens.entries()) {
    const primaria = imagem.capa || (!imagens.some((item) => item.capa) && indice === 0);
    const attrs = { medium: 'image' };

    if (imagem.legenda) attrs.caption = imagem.legenda;

    if (primaria && !jaMarcouPrimaria) {
      attrs.primary = 'true';
      jaMarcouPrimaria = true;
    }

    // O portal exige JPG. As derivadas WebP não servem: enviamos o original.
    const url = imagem.url;

    linhas.push(`${itemIndent}<Item${atributosOrdenados(attrs)}>${escaparXml(url)}</Item>\n`);
  }

  for (const video of videos) {
    linhas.push(
      `${itemIndent}<Item medium="video">${escaparXml(video.url_externa)}</Item>\n`
    );
  }

  linhas.push(`${indent}</Media>\n`);

  return linhas.join('');
}

function atributosOrdenados(mapa) {
  return Object.entries(mapa)
    .map(([chave, valor]) => ` ${chave}="${escaparXml(valor)}"`)
    .join('');
}

function montarContactInfo(integracao, indent) {
  const linhas = [`${indent}<ContactInfo>\n`];
  const filho = `${indent}  `;

  linhas.push(tag('Name', integracao.contato_nome, { indent: filho, obrigatoria: true }));
  linhas.push(tag('Email', integracao.contato_email, { indent: filho, obrigatoria: true }));
  linhas.push(tag('Website', integracao.contato_site, { indent: filho }));
  linhas.push(tag('Logo', integracao.contato_logo_url, { indent: filho }));
  linhas.push(tag('OfficeName', integracao.contato_nome, { indent: filho }));
  linhas.push(tag('Telephone', integracao.contato_telefone, { indent: filho }));

  const temLocation =
    integracao.contato_cidade || integracao.contato_uf || integracao.contato_bairro;

  if (temLocation) {
    linhas.push(`${filho}<Location>\n`);
    const neto = `${filho}  `;

    linhas.push(tag('Country', 'BR', { indent: neto }));
    linhas.push(tag('State', integracao.contato_uf, { indent: neto }));
    linhas.push(tag('City', integracao.contato_cidade, { indent: neto }));
    linhas.push(tag('Neighborhood', integracao.contato_bairro, { indent: neto }));
    linhas.push(tag('Address', integracao.contato_endereco, { indent: neto }));
    linhas.push(
      tag('PostalCode', integracao.contato_cep ? String(integracao.contato_cep).replace(/\D/g, '') : null, {
        indent: neto
      })
    );

    linhas.push(`${filho}</Location>\n`);
  }

  linhas.push(`${indent}</ContactInfo>\n`);

  return linhas.join('');
}

/** Um <Listing> completo. */
function montarListing({ imovel, midias, caracteristicas, integracao, tipoPublicacao }) {
  const indent = '    ';
  const filho = '      ';

  const linhas = [`${indent}<Listing>\n`];

  linhas.push(tag('ListingID', imovel.codigo, { indent: filho, obrigatoria: true }));
  linhas.push(`${filho}<Title>${cdata(String(imovel.titulo || '').slice(0, 100))}</Title>\n`);
  linhas.push(tag('TransactionType', TRANSACTION_TYPE[imovel.finalidade], { indent: filho, obrigatoria: true }));

  const publicacao = PUBLICATION_TYPES.includes(tipoPublicacao) ? tipoPublicacao : 'STANDARD';
  linhas.push(tag('PublicationType', publicacao, { indent: filho }));

  const tour = midias.find((midia) => midia.tipo === 'TOUR_360' && midia.url_externa);

  if (tour && String(tour.url_externa).startsWith('https://')) {
    linhas.push(tag('VirtualTourLink', tour.url_externa, { indent: filho }));
  }

  linhas.push(`${filho}<Location displayAddress="${displayAddress(imovel)}">\n`);
  linhas.push(montarLocation(imovel, `${filho}  `));
  linhas.push(`${filho}</Location>\n`);

  linhas.push(`${filho}<Details>\n`);
  linhas.push(montarDetails(imovel, caracteristicas, `${filho}  `));
  linhas.push(`${filho}</Details>\n`);

  linhas.push(montarContactInfo(integracao, filho));
  linhas.push(montarMedia(imovel, midias, filho));

  linhas.push(`${indent}</Listing>\n`);

  return linhas.join('');
}

/** Feed completo (Header + Listings). */
function montarFeed({ integracao, itens, publishDate = new Date() }) {
  const linhas = [declaracao('UTF-8')];

  linhas.push(
    `<ListingDataFeed xmlns="${NAMESPACE}" ` +
    `xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ` +
    `xsi:schemaLocation="${SCHEMA_LOCATION}">\n`
  );

  linhas.push('  <Header>\n');
  linhas.push(tag('Provider', integracao.contato_nome || 'Gold Leste', { indent: '    ', obrigatoria: true }));
  linhas.push(tag('Email', integracao.contato_email, { indent: '    ', obrigatoria: true }));
  linhas.push(tag('ContactName', integracao.contato_nome, { indent: '    ', obrigatoria: true }));
  linhas.push(
    tag('PublishDate', publishDate.toISOString().replace(/\.\d{3}Z$/, ''), {
      indent: '    ',
      obrigatoria: true
    })
  );
  linhas.push(tag('Telephone', integracao.contato_telefone, { indent: '    ', obrigatoria: true }));
  linhas.push('  </Header>\n');

  linhas.push('  <Listings>\n');

  for (const item of itens) {
    linhas.push(montarListing({ ...item, integracao }));
  }

  linhas.push('  </Listings>\n');
  linhas.push('</ListingDataFeed>\n');

  return linhas.join('');
}

module.exports = {
  NAMESPACE,
  TRANSACTION_TYPE,
  PROPERTY_TYPE,
  USAGE_TYPE,
  PUBLICATION_TYPES,
  FEATURES,
  validar,
  montarListing,
  montarFeed
};
