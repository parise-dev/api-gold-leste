// Marcas de acentuação combinantes (resultado do normalize('NFD')).
const REGEX_ACENTOS = new RegExp('[\\u0300-\\u036f]', 'g');

/**
 * Slug amigável para SEO da página pública do imóvel.
 * Ex.: apartamento-2-dormitorios-vila-matilde-sp-gl000123
 */
function slugificar(texto) {
  if (!texto) return '';

  return String(texto)
    .normalize('NFD')
    .replace(REGEX_ACENTOS, '')
    .replace(/[^a-zA-Z0-9\s-]/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

const TIPOS_LEGIVEIS = {
  APARTAMENTO: 'apartamento',
  CASA: 'casa',
  SOBRADO: 'sobrado',
  TERRENO: 'terreno',
  COMERCIAL: 'imovel-comercial',
  SALA: 'sala-comercial',
  GALPAO: 'galpao',
  CHACARA: 'chacara',
  SITIO: 'sitio',
  FAZENDA: 'fazenda',
  COBERTURA: 'cobertura',
  STUDIO: 'studio',
  KITNET: 'kitnet',
  LOFT: 'loft',
  FLAT: 'flat',
  OUTRO: 'imovel'
};

/**
 * Monta o slug do imóvel a partir de tipo, dormitórios, bairro, cidade, UF
 * e código. O código no final garante unicidade estável mesmo se o título mudar.
 */
function montarSlugImovel(imovel) {
  const partes = [];

  partes.push(TIPOS_LEGIVEIS[imovel.tipo] || slugificar(imovel.tipo) || 'imovel');

  const dormitorios = Number(imovel.dormitorios || 0);
  if (dormitorios > 0) {
    partes.push(`${dormitorios}-${dormitorios === 1 ? 'dormitorio' : 'dormitorios'}`);
  }

  if (imovel.bairro) partes.push(slugificar(imovel.bairro));
  if (imovel.cidade) partes.push(slugificar(imovel.cidade));
  if (imovel.uf) partes.push(slugificar(imovel.uf));
  if (imovel.codigo) partes.push(slugificar(imovel.codigo));

  return partes
    .filter(Boolean)
    .join('-')
    .replace(/-+/g, '-')
    .slice(0, 200);
}

module.exports = { slugificar, montarSlugImovel };
