/**
 * Mapeamento Gold Leste -> XML Chaves na Mão.
 *
 * Fonte oficial consultada em 2026-08-16:
 *   https://tecnologiacnm.github.io/cnm-xml-documentation/
 *   .../arquivo/document.html        -> raiz <Document>
 *   .../arquivo/imoveis.html         -> <imoveis> / <imovel>
 *   .../arquivo/especificacoes/especificacoes-tags.html
 *   .../arquivo/especificacoes/especificacoes-fotos.html
 *   .../arquivo/dados-suportados/residencial.html
 *
 * Observações da documentação respeitadas aqui:
 *   - as tags são case-sensitive e devem aparecer mesmo quando vazias;
 *   - `tipo` precisa bater exatamente com a tabela do portal (acentos e
 *     espaços inclusos);
 *   - máximo de 30 fotos por imóvel; JPG/JPEG/WEBP; a URL precisa conter
 *     a extensão do arquivo.
 */

const { cdata, tag, declaracao } = require('../../../utils/xml');

/** transacao: V (venda) | L (locação). */
const TRANSACAO = { VENDA: 'V', LOCACAO: 'L', VENDA_LOCACAO: 'V' };

/** finalidade: RE (residencial) | CO (comercial) | RU (rural). */
const FINALIDADE = {
  APARTAMENTO: 'RE',
  CASA: 'RE',
  SOBRADO: 'RE',
  COBERTURA: 'RE',
  STUDIO: 'RE',
  KITNET: 'RE',
  LOFT: 'RE',
  FLAT: 'RE',
  TERRENO: 'RE',
  CHACARA: 'RE',
  SITIO: 'RU',
  FAZENDA: 'RU',
  COMERCIAL: 'CO',
  SALA: 'CO',
  GALPAO: 'CO'
};

/**
 * `tipo` — valores residenciais oficiais do portal. Grafia exata,
 * conforme a tabela de "Dados suportados / Residencial".
 */
const TIPO_RESIDENCIAL = {
  APARTAMENTO: 'Apartamento',
  CASA: 'Casa / Sobrado',
  SOBRADO: 'Casa / Sobrado',
  COBERTURA: 'Cobertura',
  FLAT: 'Flat',
  STUDIO: 'Kitnet / Stúdio',
  KITNET: 'Kitnet / Stúdio',
  LOFT: 'Loft',
  CHACARA: 'Sítio / Chácara',
  TERRENO: 'Terreno / Lote'
};

/**
 * Tipos rurais e comerciais: as tabelas correspondentes do portal são
 * consultadas na documentação de "Comercial"/"Rural". Quando não houver
 * mapeamento confirmado, a integração deve informar o valor exato em
 * `config.tipos` — sem palpite silencioso.
 */
const TIPO_RURAL = {
  SITIO: 'Sítio / Chácara',
  FAZENDA: 'Fazenda'
};

function resolverTipo(imovel, integracao) {
  const configurados = integracao?.config?.tipos || {};

  if (configurados[imovel.tipo]) return configurados[imovel.tipo];

  const finalidade = FINALIDADE[imovel.tipo];

  if (finalidade === 'RE') return TIPO_RESIDENCIAL[imovel.tipo] || null;
  if (finalidade === 'RU') return TIPO_RURAL[imovel.tipo] || null;

  // Comercial: a tabela oficial varia por conta; exigimos configuração.
  return null;
}

function numeroDecimal(valor) {
  const numero = Number(valor);
  if (!Number.isFinite(numero) || numero <= 0) return null;
  return numero.toFixed(2);
}

function inteiroPositivo(valor) {
  const numero = Number(valor);
  if (!Number.isFinite(numero) || numero <= 0) return null;
  return Math.round(numero);
}

function urlComExtensao(url) {
  if (!url) return false;
  return /\.(jpg|jpeg|webp|png)(\?|$)/i.test(String(url));
}

function validar({ imovel, midias = [], integracao }) {
  const erros = [];
  const avisos = [];

  if (!imovel.codigo) {
    erros.push({ campo: 'codigo', mensagem: 'referencia é obrigatória.' });
  }

  if (!TRANSACAO[imovel.finalidade]) {
    erros.push({ campo: 'finalidade', mensagem: 'Finalidade sem equivalente em "transacao".' });
  }

  if (!FINALIDADE[imovel.tipo]) {
    erros.push({
      campo: 'tipo',
      mensagem: `Tipo "${imovel.tipo}" sem finalidade (RE/CO/RU) mapeada.`
    });
  }

  if (!resolverTipo(imovel, integracao)) {
    erros.push({
      campo: 'tipo',
      mensagem:
        `Tipo "${imovel.tipo}" não possui valor oficial de "tipo" mapeado para o Chaves na Mão. ` +
        'Informe o valor exato da tabela do portal em Integrações > Chaves na Mão > Configuração.'
    });
  }

  if (!numeroDecimal(imovel.valor_venda) && !numeroDecimal(imovel.valor_locacao)) {
    erros.push({ campo: 'valorVenda', mensagem: '"valor" é obrigatório.' });
  }

  if (!imovel.uf) erros.push({ campo: 'uf', mensagem: '"estado" é obrigatório.' });
  if (!imovel.cidade) erros.push({ campo: 'cidade', mensagem: '"cidade" é obrigatória.' });
  if (!imovel.bairro) erros.push({ campo: 'bairro', mensagem: '"bairro" é obrigatório.' });

  const descricao = String(imovel.descricao || '').trim();

  if (!descricao) {
    erros.push({ campo: 'descricao', mensagem: '"descritivo" é obrigatório.' });
  }

  if (descricao.length > 3000) {
    avisos.push({
      campo: 'descricao',
      mensagem: '"descritivo" acima de 3.000 caracteres será truncado.'
    });
  }

  const imagens = midias.filter((midia) => midia.tipo === 'IMAGEM' && midia.publica);

  if (!imagens.length) {
    erros.push({ campo: 'midias', mensagem: 'Envie ao menos uma foto.' });
  }

  const semExtensao = imagens.filter((midia) => !urlComExtensao(midia.url));

  if (semExtensao.length) {
    avisos.push({
      campo: 'midias',
      mensagem: `${semExtensao.length} foto(s) sem extensão reconhecível na URL — o portal pode ignorá-las.`
    });
  }

  if (imagens.length > 30) {
    avisos.push({
      campo: 'midias',
      mensagem: 'O portal aceita no máximo 30 fotos. As excedentes serão ignoradas.'
    });
  }

  return { ok: erros.length === 0, erros, avisos };
}

/** Datas no formato AAAA-MM-DD HH:MM:SS exigido pelo portal. */
function formatarDataHora(data) {
  const referencia = data instanceof Date ? data : new Date(data || Date.now());

  const pad = (valor) => String(valor).padStart(2, '0');

  return (
    `${referencia.getFullYear()}-${pad(referencia.getMonth() + 1)}-${pad(referencia.getDate())} ` +
    `${pad(referencia.getHours())}:${pad(referencia.getMinutes())}:${pad(referencia.getSeconds())}`
  );
}

function montarImovel({ imovel, midias = [], caracteristicas = [], integracao }) {
  const indent = '    ';
  const filho = '      ';

  const linhas = [`${indent}<imovel>\n`];

  const vendaLocacao = imovel.finalidade === 'VENDA_LOCACAO';

  // A documentação pede que todas as tags apareçam, mesmo vazias.
  const obrigatoria = { indent: filho, obrigatoria: true };

  linhas.push(tag('referencia', imovel.codigo, obrigatoria));
  linhas.push(tag('codigo_cliente', imovel.referencia_externa, { indent: filho, obrigatoria: true }));
  linhas.push(tag('transacao', TRANSACAO[imovel.finalidade], obrigatoria));
  linhas.push(tag('transacao2', vendaLocacao ? 'L' : null, { indent: filho, obrigatoria: true }));
  linhas.push(tag('finalidade', FINALIDADE[imovel.tipo], obrigatoria));
  linhas.push(tag('finalidade2', null, { indent: filho, obrigatoria: true }));
  linhas.push(tag('destaque', imovel.destaque ? 1 : 0, obrigatoria));
  linhas.push(tag('tipo', resolverTipo(imovel, integracao), obrigatoria));

  linhas.push(tag('valor', numeroDecimal(imovel.valor_venda) || numeroDecimal(imovel.valor_locacao), obrigatoria));
  linhas.push(
    tag('valor_locacao', vendaLocacao ? numeroDecimal(imovel.valor_locacao) : null, {
      indent: filho,
      obrigatoria: true
    })
  );
  linhas.push(tag('valor_condominio', numeroDecimal(imovel.valor_condominio), { indent: filho, obrigatoria: true }));
  linhas.push(tag('valor_iptu', numeroDecimal(imovel.valor_iptu), { indent: filho, obrigatoria: true }));

  linhas.push(tag('estado', imovel.uf, obrigatoria));
  linhas.push(tag('cidade', imovel.cidade, obrigatoria));
  linhas.push(tag('bairro', imovel.bairro, obrigatoria));
  linhas.push(
    tag('endereco', imovel.exibir_endereco_completo ? imovel.logradouro : null, {
      indent: filho,
      obrigatoria: true
    })
  );
  linhas.push(
    tag('numero', imovel.exibir_endereco_completo ? imovel.numero : null, {
      indent: filho,
      obrigatoria: true
    })
  );
  linhas.push(tag('cep', imovel.cep ? String(imovel.cep).replace(/\D/g, '') : null, { indent: filho, obrigatoria: true }));
  linhas.push(tag('exibe_endereco', imovel.exibir_endereco_completo ? 1 : 0, { indent: filho, obrigatoria: true }));
  linhas.push(tag('latitude', imovel.latitude, { indent: filho, obrigatoria: true }));
  linhas.push(tag('longitude', imovel.longitude, { indent: filho, obrigatoria: true }));

  linhas.push(tag('quartos', inteiroPositivo(imovel.dormitorios) || 0, { indent: filho, obrigatoria: true }));
  linhas.push(tag('suites', inteiroPositivo(imovel.suites) || 0, { indent: filho, obrigatoria: true }));
  linhas.push(tag('banheiro', inteiroPositivo(imovel.banheiros) || 0, { indent: filho, obrigatoria: true }));
  linhas.push(tag('garagem', inteiroPositivo(imovel.vagas) || 0, { indent: filho, obrigatoria: true }));
  linhas.push(tag('area_util', numeroDecimal(imovel.area_util), { indent: filho, obrigatoria: true }));
  linhas.push(tag('area_total', numeroDecimal(imovel.area_total), { indent: filho, obrigatoria: true }));
  linhas.push(tag('aceita_pet', imovel.pet_friendly ? 1 : 0, { indent: filho, obrigatoria: true }));
  linhas.push(tag('mobiliado', imovel.mobiliado ? 1 : 0, { indent: filho, obrigatoria: true }));

  linhas.push(
    `${filho}<descritivo>${cdata(String(imovel.descricao || '').slice(0, 3000))}</descritivo>\n`
  );

  const video = midias.find((midia) => midia.tipo === 'VIDEO' && midia.url_externa);
  const tour = midias.find((midia) => midia.tipo === 'TOUR_360' && midia.url_externa);

  linhas.push(tag('video', video ? video.url_externa : null, { indent: filho, obrigatoria: true }));
  linhas.push(tag('tour_360', tour ? tour.url_externa : null, { indent: filho, obrigatoria: true }));

  linhas.push(tag('data_atualizacao', formatarDataHora(imovel.updated_at), { indent: filho, obrigatoria: true }));

  const imagens = midias
    .filter((midia) => midia.tipo === 'IMAGEM' && midia.publica)
    .sort((a, b) => (b.capa ? 1 : 0) - (a.capa ? 1 : 0) || a.ordem - b.ordem)
    .slice(0, 30);

  linhas.push(`${filho}<fotos_imovel>\n`);

  for (const foto of imagens) {
    linhas.push(`${filho}  <foto>\n`);
    linhas.push(tag('url', foto.url, { indent: `${filho}    `, obrigatoria: true }));
    linhas.push(
      tag('data_atualizacao', formatarDataHora(foto.updated_at || foto.created_at), {
        indent: `${filho}    `
      })
    );
    linhas.push(`${filho}  </foto>\n`);
  }

  linhas.push(`${filho}</fotos_imovel>\n`);

  linhas.push(`${indent}</imovel>\n`);

  return linhas.join('');
}

function montarFeed({ integracao, itens }) {
  const linhas = [declaracao('UTF-8')];

  linhas.push('<Document>\n');
  linhas.push('  <imoveis>\n');

  for (const item of itens) {
    linhas.push(montarImovel({ ...item, integracao }));
  }

  linhas.push('  </imoveis>\n');
  linhas.push('</Document>\n');

  return linhas.join('');
}

module.exports = {
  TRANSACAO,
  FINALIDADE,
  TIPO_RESIDENCIAL,
  TIPO_RURAL,
  resolverTipo,
  validar,
  montarImovel,
  montarFeed
};
