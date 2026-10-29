const { GrupoOlxAdapter } = require('./grupo-olx');
const { OlxAdapter } = require('./olx');
const { ChavesNaMaoAdapter } = require('./chaves-na-mao');
const { ImovelwebAdapter } = require('./imovelweb');

/**
 * Catálogo de adapters.
 *
 * Adicionar um portal novo = criar a pasta do adapter e registrar aqui.
 * O cadastro de imóveis não muda — esse é o motivo de existir o adapter.
 */
const adapters = new Map();

function registrar(adapter) {
  adapters.set(adapter.slug, adapter);
}

registrar(new GrupoOlxAdapter());
registrar(new OlxAdapter());
registrar(new ChavesNaMaoAdapter());
registrar(new ImovelwebAdapter());

function obterAdapter(slug) {
  return adapters.get(String(slug || '').toLowerCase()) || null;
}

function listarAdapters() {
  return [...adapters.values()];
}

function resumoAdapters() {
  return listarAdapters().map((adapter) => adapter.resumo());
}

module.exports = { obterAdapter, listarAdapters, resumoAdapters };
