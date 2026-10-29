/**
 * Mapeamento Gold Leste -> XML de importação de imóveis da OLX.
 *
 * Fonte oficial consultada em 2026-08-16:
 *   https://developers.olx.com.br/anuncio/home.html
 *   https://developers.olx.com.br/anuncio/xml/real_estate/home.html
 *   https://developers.olx.com.br/anuncio/api/real_estate/home.html
 *
 * Tags implementadas: as documentadas na página de importação via XML
 * para Imóveis. `SubTipoImovel` é o campo que define a categoria; a
 * documentação remete a páginas por subcategoria para a lista exata de
 * valores, então o mapeamento abaixo é CONFIGURÁVEL por integração
 * (config.subtipos) e o default cobre os casos comuns. Quando não há
 * mapeamento, a validação falha explicitamente — o feed nunca sai com
 * uma categoria inventada.
 */

const { cdata, tag, declaracao, escaparXml } = require('../../../utils/xml');

/** Categorias oficiais de Imóveis na OLX (códigos numéricos). */
const CATEGORIAS = {
  APARTAMENTOS: 1020,
  CASAS: 1040,
  ALUGUEL_QUARTOS: 1060,
  TEMPORADA: 1080,
  TERRENOS_SITIOS_FAZENDAS: 1100,
  COMERCIO_INDUSTRIA: 1120
};

const CATEGORIA_POR_TIPO = {
  APARTAMENTO: CATEGORIAS.APARTAMENTOS,
  COBERTURA: CATEGORIAS.APARTAMENTOS,
  STUDIO: CATEGORIAS.APARTAMENTOS,
  KITNET: CATEGORIAS.APARTAMENTOS,
  LOFT: CATEGORIAS.APARTAMENTOS,
  FLAT: CATEGORIAS.APARTAMENTOS,
  CASA: CATEGORIAS.CASAS,
  SOBRADO: CATEGORIAS.CASAS,
  TERRENO: CATEGORIAS.TERRENOS_SITIOS_FAZENDAS,
  CHACARA: CATEGORIAS.TERRENOS_SITIOS_FAZENDAS,
  SITIO: CATEGORIAS.TERRENOS_SITIOS_FAZENDAS,
  FAZENDA: CATEGORIAS.TERRENOS_SITIOS_FAZENDAS,
  COMERCIAL: CATEGORIAS.COMERCIO_INDUSTRIA,
  SALA: CATEGORIAS.COMERCIO_INDUSTRIA,
  GALPAO: CATEGORIAS.COMERCIO_INDUSTRIA
};

/**
 * Valores default de SubTipoImovel.
 * Sobrescrevíveis por integração via `config.subtipos` — assim, quando
 * o portal confirmar a tabela exata para a conta do cliente, basta
 * ajustar a configuração, sem alterar código.
 */
const SUBTIPO_PADRAO = {
  APARTAMENTO: 'Apartamento',
  COBERTURA: 'Cobertura',
  STUDIO: 'Kitnet',
  KITNET: 'Kitnet',
  LOFT: 'Loft',
  FLAT: 'Flat',
  CASA: 'Casa',
  SOBRADO: 'Sobrado',
  TERRENO: 'Terreno',
  CHACARA: 'Chácara',
  SITIO: 'Sítio',
  FAZENDA: 'Fazenda',
  COMERCIAL: 'Ponto Comercial',
  SALA: 'Sala Comercial',
  GALPAO: 'Galpão'
};

function inteiroPositivo(valor) {
  const numero = Number(valor);
  if (!Number.isFinite(numero) || numero <= 0) return null;
  return Math.round(numero);
}

function resolverSubtipo(imovel, integracao) {
  const configurados = integracao?.config?.subtipos || {};
  return configurados[imovel.tipo] || SUBTIPO_PADRAO[imovel.tipo] || null;
}

function validar({ imovel, midias = [], integracao }) {
  const erros = [];
  const avisos = [];

  if (!imovel.codigo || String(imovel.codigo).length > 20) {
    erros.push({
      campo: 'codigo',
      mensagem: 'CodigoImovel deve ter no máximo 20 caracteres.'
    });
  }

  if (!resolverSubtipo(imovel, integracao)) {
    erros.push({
      campo: 'tipo',
      mensagem:
        `Tipo "${imovel.tipo}" não possui SubTipoImovel configurado para a OLX. ` +
        'Defina o mapeamento em Integrações > OLX > Configuração.'
    });
  }

  if (!CATEGORIA_POR_TIPO[imovel.tipo]) {
    erros.push({
      campo: 'tipo',
      mensagem: `Tipo "${imovel.tipo}" sem categoria OLX correspondente.`
    });
  }

  const cep = String(imovel.cep || '').replace(/\D/g, '');

  if (cep.length !== 8) {
    erros.push({ campo: 'cep', mensagem: 'CEP é obrigatório para a OLX (8 dígitos).' });
  }

  const descricao = String(imovel.descricao || '').trim();

  if (descricao.length < 20) {
    erros.push({
      campo: 'descricao',
      mensagem: 'Observacao (descrição) é obrigatória para a OLX.'
    });
  }

  if (descricao.length > 6000) {
    avisos.push({
      campo: 'descricao',
      mensagem: 'Observacao acima de 6.000 caracteres será truncada.'
    });
  }

  const titulo = String(imovel.titulo || '').trim();

  if (titulo.length > 90) {
    avisos.push({
      campo: 'titulo',
      mensagem: 'TituloAnuncio acima de 90 caracteres será truncado.'
    });
  }

  const temPreco =
    inteiroPositivo(imovel.valor_venda) || inteiroPositivo(imovel.valor_locacao);

  if (!temPreco) {
    erros.push({
      campo: 'valorVenda',
      mensagem: 'Informe PrecoVenda ou PrecoLocacao.'
    });
  }

  const imagens = midias.filter((midia) => midia.tipo === 'IMAGEM' && midia.publica);

  if (!imagens.length) {
    erros.push({ campo: 'midias', mensagem: 'Envie ao menos uma foto.' });
  }

  if (imagens.length > 20) {
    avisos.push({
      campo: 'midias',
      mensagem: 'A OLX aceita no máximo 20 imagens. As excedentes serão ignoradas.'
    });
  }

  return { ok: erros.length === 0, erros, avisos };
}

function montarImovel({ imovel, midias = [], integracao }) {
  const indent = '    ';
  const filho = '      ';

  const linhas = [`${indent}<Imovel>\n`];

  linhas.push(tag('CodigoImovel', imovel.codigo, { indent: filho, obrigatoria: true }));
  linhas.push(tag('SubTipoImovel', resolverSubtipo(imovel, integracao), { indent: filho, obrigatoria: true }));
  linhas.push(tag('CategoriaImovel', CATEGORIA_POR_TIPO[imovel.tipo], { indent: filho }));

  linhas.push(
    `${filho}<TituloAnuncio>${cdata(String(imovel.titulo || '').slice(0, 90))}</TituloAnuncio>\n`
  );

  linhas.push(
    `${filho}<Observacao>${cdata(String(imovel.descricao || '').slice(0, 6000))}</Observacao>\n`
  );

  linhas.push(tag('CEP', String(imovel.cep || '').replace(/\D/g, ''), { indent: filho, obrigatoria: true }));
  linhas.push(tag('UF', imovel.uf, { indent: filho }));
  linhas.push(tag('Cidade', imovel.cidade, { indent: filho }));
  linhas.push(tag('Bairro', imovel.bairro, { indent: filho }));

  if (imovel.exibir_endereco_completo) {
    linhas.push(tag('Endereco', imovel.logradouro, { indent: filho }));
    linhas.push(tag('Numero', imovel.numero, { indent: filho }));
    linhas.push(tag('Complemento', imovel.complemento, { indent: filho }));
  }

  linhas.push(tag('Latitude', imovel.latitude, { indent: filho }));
  linhas.push(tag('Longitude', imovel.longitude, { indent: filho }));

  // PrecoLocacao é ignorado pela OLX quando PrecoVenda está preenchido.
  linhas.push(tag('PrecoVenda', inteiroPositivo(imovel.valor_venda), { indent: filho }));

  if (!inteiroPositivo(imovel.valor_venda)) {
    linhas.push(tag('PrecoLocacao', inteiroPositivo(imovel.valor_locacao), { indent: filho }));
  }

  linhas.push(tag('PrecoCondominio', inteiroPositivo(imovel.valor_condominio), { indent: filho }));
  linhas.push(tag('ValorIPTU', inteiroPositivo(imovel.valor_iptu), { indent: filho }));

  const areaTotal = inteiroPositivo(imovel.area_total);
  const areaUtil = inteiroPositivo(imovel.area_util);

  linhas.push(tag('AreaTotal', areaTotal, { indent: filho }));

  if (!areaTotal) {
    linhas.push(tag('AreaUtil', areaUtil, { indent: filho }));
  }

  linhas.push(tag('QtdDormitorios', inteiroPositivo(imovel.dormitorios), { indent: filho }));
  linhas.push(tag('QtdSuites', inteiroPositivo(imovel.suites), { indent: filho }));
  linhas.push(tag('QtdBanheiros', inteiroPositivo(imovel.banheiros), { indent: filho }));
  linhas.push(tag('QtdVagas', inteiroPositivo(imovel.vagas), { indent: filho }));

  if (integracao?.contato_telefone) {
    linhas.push(
      tag('Telefone', String(integracao.contato_telefone).replace(/\D/g, ''), { indent: filho })
    );
  }

  const imagens = midias
    .filter((midia) => midia.tipo === 'IMAGEM' && midia.publica)
    .sort((a, b) => (b.capa ? 1 : 0) - (a.capa ? 1 : 0) || a.ordem - b.ordem)
    .slice(0, 20);

  if (imagens.length) {
    linhas.push(`${filho}<Fotos>\n`);

    for (const [indice, foto] of imagens.entries()) {
      linhas.push(`${filho}  <Foto>\n`);
      linhas.push(tag('URLArquivo', foto.url, { indent: `${filho}    `, obrigatoria: true }));

      if (foto.capa || indice === 0) {
        linhas.push(tag('Principal', '1', { indent: `${filho}    ` }));
      }

      linhas.push(`${filho}  </Foto>\n`);
    }

    linhas.push(`${filho}</Fotos>\n`);
  }

  const video = midias.find((midia) => midia.tipo === 'VIDEO' && midia.url_externa);

  if (video) {
    linhas.push(`${filho}<Videos>\n`);
    linhas.push(`${filho}  <Video>${escaparXml(video.url_externa)}</Video>\n`);
    linhas.push(`${filho}</Videos>\n`);
  }

  linhas.push(`${indent}</Imovel>\n`);

  return linhas.join('');
}

function montarFeed({ integracao, itens }) {
  const linhas = [declaracao('utf-8')];

  linhas.push('<Carga>\n');
  linhas.push('  <Imoveis>\n');

  for (const item of itens) {
    linhas.push(montarImovel({ ...item, integracao }));
  }

  linhas.push('  </Imoveis>\n');
  linhas.push('</Carga>\n');

  return linhas.join('');
}

module.exports = {
  CATEGORIAS,
  CATEGORIA_POR_TIPO,
  SUBTIPO_PADRAO,
  validar,
  montarImovel,
  montarFeed,
  resolverSubtipo
};
