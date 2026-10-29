/**
 * Domínio do imóvel.
 *
 * A lista de TIPOS é aberta de propósito: novos tipos podem ser incluídos
 * aqui (e nos mapeamentos dos adapters de portal) sem migração de banco,
 * porque a coluna `imoveis.tipo` é VARCHAR sem CHECK.
 * Já finalidade/status/visibilidade possuem CHECK no banco e regra de
 * negócio associada — por isso são fechados.
 */

const FINALIDADES = ['VENDA', 'LOCACAO', 'VENDA_LOCACAO'];

const STATUS_COMERCIAIS = [
  'DISPONIVEL',
  'RESERVADO',
  'EM_NEGOCIACAO',
  'VENDIDO',
  'ALUGADO',
  'SUSPENSO',
  'INATIVO'
];

/** Status que tiram o imóvel de oportunidades, feeds e página pública. */
const STATUS_INDISPONIVEIS = ['VENDIDO', 'ALUGADO', 'SUSPENSO', 'INATIVO'];

const SITUACOES = ['NOVO', 'USADO', 'NA_PLANTA', 'EM_CONSTRUCAO'];

const ORIGENS_CARTEIRA = ['AVULSO', 'EMPREENDIMENTO', 'TERCEIRO', 'CAPTADO'];

const VISIBILIDADES = ['TODOS', 'FILIAL', 'SELECIONADOS', 'GERENCIA', 'PRIVADO'];

const IPTU_PERIODOS = ['ANUAL', 'MENSAL'];

const TIPOS = [
  { valor: 'APARTAMENTO', label: 'Apartamento',      uso: 'RESIDENCIAL' },
  { valor: 'APARTAMENTO_DUPLEX', label: 'Apartamento Duplex', uso: 'RESIDENCIAL' },
  { valor: 'APARTAMENTO_GARDEN', label: 'Apartamento Garden', uso: 'RESIDENCIAL' },
  { valor: 'APARTAMENTO_TRIPLEX', label: 'Apartamento Triplex', uso: 'RESIDENCIAL' },
  { valor: 'AREA',        label: 'Área',             uso: 'RESIDENCIAL' },
  { valor: 'BANGALO',     label: 'Bangalô',          uso: 'RESIDENCIAL' },
  { valor: 'BOX_GARAGEM', label: 'Box/Garagem',      uso: 'RESIDENCIAL' },
  { valor: 'CASA',        label: 'Casa',             uso: 'RESIDENCIAL' },
  { valor: 'SOBRADO',     label: 'Sobrado',          uso: 'RESIDENCIAL' },
  { valor: 'COBERTURA',   label: 'Cobertura',        uso: 'RESIDENCIAL' },
  { valor: 'EDICULA',     label: 'Edícula',          uso: 'RESIDENCIAL' },
  { valor: 'STUDIO',      label: 'Studio',           uso: 'RESIDENCIAL' },
  { valor: 'KITNET',      label: 'Kitnet',           uso: 'RESIDENCIAL' },
  { valor: 'LOFT',        label: 'Loft',             uso: 'RESIDENCIAL' },
  { valor: 'FLAT',        label: 'Flat',             uso: 'RESIDENCIAL' },
  { valor: 'ILHA',        label: 'Ilha',             uso: 'RESIDENCIAL' },
  { valor: 'PENTHOUSE',   label: 'Penthouse',        uso: 'RESIDENCIAL' },
  { valor: 'RANCHO',      label: 'Rancho',           uso: 'RESIDENCIAL' },
  { valor: 'TERRENO',     label: 'Terreno',          uso: 'RESIDENCIAL' },
  { valor: 'VILLAGE',     label: 'Village',          uso: 'RESIDENCIAL' },
  { valor: 'CHACARA',     label: 'Chácara',          uso: 'RESIDENCIAL' },
  { valor: 'SITIO',       label: 'Sítio',            uso: 'RURAL' },
  { valor: 'FAZENDA',     label: 'Fazenda',          uso: 'RURAL' },
  { valor: 'HARAS',       label: 'Haras',            uso: 'RURAL' },
  { valor: 'COMERCIAL',   label: 'Imóvel comercial', uso: 'COMERCIAL' },
  { valor: 'ANDAR_CORPORATIVO', label: 'Andar Corporativo', uso: 'COMERCIAL' },
  { valor: 'BARRACAO',    label: 'Barracão',         uso: 'COMERCIAL' },
  { valor: 'CONJUNTO',    label: 'Conjunto',         uso: 'COMERCIAL' },
  { valor: 'SALA',        label: 'Sala comercial',   uso: 'COMERCIAL' },
  { valor: 'GALPAO',      label: 'Galpão',           uso: 'COMERCIAL' },
  { valor: 'HOTEL',       label: 'Hotel',            uso: 'COMERCIAL' },
  { valor: 'LAJE',        label: 'Laje',             uso: 'COMERCIAL' },
  { valor: 'LOJA',        label: 'Loja',             uso: 'COMERCIAL' },
  { valor: 'PAVILHAO',    label: 'Pavilhão',         uso: 'COMERCIAL' },
  { valor: 'PONTO',       label: 'Ponto',            uso: 'COMERCIAL' },
  { valor: 'POUSADA',     label: 'Pousada',          uso: 'COMERCIAL' },
  { valor: 'PREDIO',      label: 'Prédio',           uso: 'COMERCIAL' },
  { valor: 'RESORT',      label: 'Resort',           uso: 'COMERCIAL' },
  { valor: 'SALAO',       label: 'Salão',            uso: 'COMERCIAL' },
  { valor: 'OUTRO',       label: 'Outro',            uso: 'RESIDENCIAL' }
];

const TIPOS_VALIDOS = TIPOS.map((tipo) => tipo.valor);

/** Tipos que não têm dormitórios/banheiros — usado na validação de portais. */
const TIPOS_SEM_DORMITORIO = ['TERRENO', 'GALPAO', 'SALA', 'COMERCIAL'];

const UFS = [
  'AC', 'AL', 'AM', 'AP', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MG', 'MS',
  'MT', 'PA', 'PB', 'PE', 'PI', 'PR', 'RJ', 'RN', 'RO', 'RR', 'RS', 'SC',
  'SE', 'SP', 'TO'
];

function usoDoTipo(tipo) {
  const encontrado = TIPOS.find((item) => item.valor === tipo);
  return encontrado ? encontrado.uso : 'RESIDENCIAL';
}

function labelDoTipo(tipo) {
  const encontrado = TIPOS.find((item) => item.valor === tipo);
  return encontrado ? encontrado.label : tipo;
}

module.exports = {
  FINALIDADES,
  STATUS_COMERCIAIS,
  STATUS_INDISPONIVEIS,
  SITUACOES,
  ORIGENS_CARTEIRA,
  VISIBILIDADES,
  IPTU_PERIODOS,
  TIPOS,
  TIPOS_VALIDOS,
  TIPOS_SEM_DORMITORIO,
  UFS,
  usoDoTipo,
  labelDoTipo
};
