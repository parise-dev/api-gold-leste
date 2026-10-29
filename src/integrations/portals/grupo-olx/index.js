const { PortalAdapter } = require('../portal-adapter');
const mapper = require('./vrsync.mapper');

/**
 * Grupo OLX — ZAP Imóveis / Viva Real.
 *
 * Modo oficial suportado: feed XML VRSync publicado em URL pública, que
 * o portal processa a cada 12h. A URL do feed é cadastrada pelo cliente
 * no Canal Pro / junto ao portal.
 *
 * Não existe, na documentação pública, endpoint de publicação unitária
 * nem de importação de leads — por isso publish/importLeads permanecem
 * como não suportados em vez de "simulados".
 */
class GrupoOlxAdapter extends PortalAdapter {
  constructor() {
    super({
      slug: 'grupo-olx',
      nome: 'Grupo OLX (ZAP Imóveis / Viva Real)',
      modoIntegracao: 'FEED_XML',
      statusImplementacao: 'IMPLEMENTADO',
      documentacaoUrl: 'https://developers.grupozap.com/feeds/xml-formats/',
      pendencias: [
        'Cadastrar a URL do feed gerado por esta API junto ao Grupo OLX (Canal Pro).',
        'Leads do portal chegam pelo Canal Pro; não há API pública de importação documentada.'
      ]
    });
  }

  capacidades() {
    return {
      feed: true,
      publish: false,
      update: false,
      deactivate: false,
      publicationStatus: false,
      importLeads: false,
      testConnection: true
    };
  }

  camposConfiguracao() {
    return [
      { chave: 'contato_nome', label: 'Nome da imobiliária', tipo: 'texto', obrigatorio: true },
      { chave: 'contato_email', label: 'E-mail de contato', tipo: 'email', obrigatorio: true },
      { chave: 'contato_telefone', label: 'Telefone', tipo: 'texto', obrigatorio: true },
      { chave: 'contato_site', label: 'Site', tipo: 'url' },
      { chave: 'contato_logo_url', label: 'URL do logo', tipo: 'url' },
      { chave: 'contato_cep', label: 'CEP', tipo: 'texto' },
      { chave: 'contato_endereco', label: 'Endereço', tipo: 'texto' },
      { chave: 'contato_bairro', label: 'Bairro', tipo: 'texto' },
      { chave: 'contato_cidade', label: 'Cidade', tipo: 'texto', obrigatorio: true },
      { chave: 'contato_uf', label: 'UF', tipo: 'uf', obrigatorio: true }
    ];
  }

  validateProperty(contexto) {
    return mapper.validar(contexto);
  }

  mapProperty(contexto) {
    return mapper.montarListing({
      imovel: contexto.imovel,
      midias: contexto.midias || [],
      caracteristicas: contexto.caracteristicas || [],
      integracao: contexto.integracao,
      tipoPublicacao: contexto.tipoPublicacao
    });
  }

  async generateFeed({ integracao, itens }) {
    const xml = mapper.montarFeed({ integracao, itens });

    return {
      ok: true,
      suportado: true,
      contentType: 'application/xml; charset=utf-8',
      conteudo: xml,
      totalAnuncios: itens.length
    };
  }

  /**
   * "Testar" aqui significa: a configuração está completa o suficiente
   * para gerar um feed aceito pelo portal? Não fazemos chamada externa
   * porque o portal não expõe endpoint de validação público.
   */
  async testConnection({ integracao, feedUrl, totalHabilitados = 0 }) {
    const faltando = this.camposConfiguracao()
      .filter((campo) => campo.obrigatorio && !integracao?.[campo.chave])
      .map((campo) => campo.label);

    if (faltando.length) {
      return {
        ok: false,
        suportado: true,
        mensagem: `Configuração incompleta. Preencha: ${faltando.join(', ')}.`
      };
    }

    if (!integracao.feed_habilitado || !integracao.feed_token) {
      return {
        ok: false,
        suportado: true,
        mensagem: 'Feed desabilitado ou sem token. Gere o token do feed antes de informar a URL ao portal.'
      };
    }

    return {
      ok: true,
      suportado: true,
      mensagem:
        `Configuração válida. Informe a URL do feed ao Grupo OLX. ` +
        `Imóveis habilitados para este canal: ${totalHabilitados}.`,
      feedUrl
    };
  }
}

module.exports = { GrupoOlxAdapter };
