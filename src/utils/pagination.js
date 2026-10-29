const PAGE_SIZE_PADRAO = 24;
const PAGE_SIZE_MAXIMO = 100;

/**
 * Paginação server-side com teto rígido: o cliente nunca consegue pedir
 * "todos os imóveis" e derrubar a API.
 */
function resolverPaginacao(query = {}, pageSizePadrao = PAGE_SIZE_PADRAO) {
  const paginaBruta = Number(query.page ?? query.pagina ?? 1);
  const tamanhoBruto = Number(query.pageSize ?? query.tamanho ?? pageSizePadrao);

  const page = Number.isFinite(paginaBruta) && paginaBruta > 0
    ? Math.floor(paginaBruta)
    : 1;

  const pageSize = Number.isFinite(tamanhoBruto) && tamanhoBruto > 0
    ? Math.min(Math.floor(tamanhoBruto), PAGE_SIZE_MAXIMO)
    : pageSizePadrao;

  return {
    page,
    pageSize,
    offset: (page - 1) * pageSize
  };
}

function montarResultadoPaginado(items, total, { page, pageSize }) {
  const totalNumerico = Number(total || 0);

  return {
    items,
    page,
    pageSize,
    total: totalNumerico,
    totalPages: pageSize > 0 ? Math.ceil(totalNumerico / pageSize) : 0
  };
}

module.exports = {
  PAGE_SIZE_PADRAO,
  PAGE_SIZE_MAXIMO,
  resolverPaginacao,
  montarResultadoPaginado
};
