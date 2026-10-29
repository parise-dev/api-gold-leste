// Escape XML sem dependência externa. Feed inválido = anúncio recusado
// pelo portal, então tudo que vem do banco passa por aqui.

const REGEX_INVALIDOS_XML = new RegExp(
  '[^\\u0009\\u000A\\u000D\\u0020-\\uD7FF\\uE000-\\uFFFD]',
  'g'
);

function removerCaracteresInvalidos(texto) {
  return String(texto).replace(REGEX_INVALIDOS_XML, '');
}

function escaparXml(valor) {
  if (valor === null || valor === undefined) return '';

  return removerCaracteresInvalidos(valor)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** CDATA para descrições longas. "]]>" precisa ser quebrado. */
function cdata(valor) {
  if (valor === null || valor === undefined) return '<![CDATA[]]>';

  const texto = removerCaracteresInvalidos(valor).split(']]>').join(']]]]><![CDATA[>');

  return `<![CDATA[${texto}]]>`;
}

function atributos(mapa = {}) {
  return Object.entries(mapa)
    .filter(([, valor]) => valor !== null && valor !== undefined && valor !== '')
    .map(([chave, valor]) => ` ${chave}="${escaparXml(valor)}"`)
    .join('');
}

/**
 * Tag simples. Retorna string vazia quando o conteúdo é vazio e a tag é
 * opcional — evita <Bedrooms></Bedrooms> que alguns validadores recusam.
 */
function tag(nome, conteudo, opcoes = {}) {
  const { attrs = {}, raw = false, obrigatoria = false, indent = '' } = opcoes;

  const vazio = conteudo === null || conteudo === undefined || conteudo === '';

  if (vazio && !obrigatoria) return '';

  const corpo = vazio ? '' : (raw ? String(conteudo) : escaparXml(conteudo));

  return `${indent}<${nome}${atributos(attrs)}>${corpo}</${nome}>\n`;
}

function declaracao(encoding = 'UTF-8') {
  return `<?xml version="1.0" encoding="${encoding}"?>\n`;
}

module.exports = {
  escaparXml,
  cdata,
  atributos,
  tag,
  declaracao,
  removerCaracteresInvalidos
};
