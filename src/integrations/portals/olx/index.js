const { PortalAdapter } = require('../portal-adapter');
const mapper = require('./olx-xml.mapper');

/**
 * OLX (separado do Grupo OLX porque o mecanismo é outro).
 *
 * Documentação oficial consultada em 2026-08-16:
 *   https://developers.olx.com.br/
 *   https://developers.olx.com.br/anuncio/xml/real_estate/home.html
 *   https://developers.olx.com.br/anuncio/api/import.html
 *
 * Situação real:
 *   - FEED XML: implementado conforme documentação de importação via XML.
 *   - API autoupload (PUT https://apps.olx.com.br/autoupload/import):
 *     documentada, mas exige OAuth com escopo `autoupload` em nome de um
 *     usuário OLX. Sem client_id/client_secret + token do cliente não há
 *     como chamar. O adapter deixa o ponto de extensão pronto e devolve
 *     PENDING_CONFIGURATION em vez de simular uma publicação.
 */
const ENDPOINT_AUTOUPLOAD = 'https://apps.olx.com.br/autoupload/import';

class OlxAdapter extends PortalAdapter {
  constructor() {
    super({
      slug: 'olx',
      nome: 'OLX',
      modoIntegracao: 'HIBRIDO',
      statusImplementacao: 'PARCIAL',
      documentacaoUrl: 'https://developers.olx.com.br/anuncio/home.html',
      pendencias: [
        'Feed XML: pronto. Basta informar a URL do feed à OLX.',
        'Publicação via API autoupload exige OAuth (escopo "autoupload") com credenciais do cliente — não configuradas.',
        'A tabela exata de SubTipoImovel por subcategoria é fornecida pelo portal; o mapeamento default é ajustável em Configuração.'
      ]
    });
  }

  capacidades() {
    return {
      feed: true,
      publish: false,          // habilita quando houver OAuth configurado
      update: false,
      deactivate: false,
      publicationStatus: false,
      importLeads: false,
      testConnection: true
    };
  }

  camposConfiguracao() {
    return [
      { chave: 'contato_telefone', label: 'Telefone do anúncio (DDD + número)', tipo: 'texto', obrigatorio: true },
      { chave: 'contato_email', label: 'E-mail de contato', tipo: 'email' },
      {
        chave: 'credencial:client_id',
        label: 'OAuth client_id (opcional — publicação via API)',
        tipo: 'segredo'
      },
      {
        chave: 'credencial:client_secret',
        label: 'OAuth client_secret (opcional — publicação via API)',
        tipo: 'segredo'
      },
      {
        chave: 'credencial:access_token',
        label: 'OAuth access_token com escopo autoupload (opcional)',
        tipo: 'segredo'
      }
    ];
  }

  validateProperty(contexto) {
    return mapper.validar(contexto);
  }

  mapProperty(contexto) {
    return mapper.montarImovel(contexto);
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
   * Publicação via API. Só é possível com token OAuth do cliente.
   * Sem credenciais, informa exatamente o que falta — não simula sucesso.
   */
  async publish({ credenciais }) {
    if (!credenciais || !credenciais.access_token) {
      return {
        ok: false,
        suportado: false,
        status: 'PENDING_CONFIGURATION',
        operacao: 'publish',
        mensagem:
          'Publicação via API da OLX requer access_token OAuth com escopo "autoupload". ' +
          'Cadastre as credenciais em Integrações > OLX ou utilize o feed XML.',
        endpointDocumentado: ENDPOINT_AUTOUPLOAD,
        pendencias: this.pendencias
      };
    }

    // Ponto de extensão: com token válido, montar o body { access_token, ad_list }
    // e enviar PUT para ENDPOINT_AUTOUPLOAD. Mantido desabilitado até haver
    // credenciais reais e homologação com o portal.
    return {
      ok: false,
      suportado: false,
      status: 'PENDING_CONFIGURATION',
      operacao: 'publish',
      mensagem:
        'Credenciais presentes, mas a publicação via API ainda não foi homologada com a OLX. ' +
        'Utilize o feed XML enquanto a homologação não estiver concluída.',
      endpointDocumentado: ENDPOINT_AUTOUPLOAD
    };
  }

  async testConnection({ integracao, feedUrl, totalHabilitados = 0 }) {
    if (!integracao?.contato_telefone) {
      return {
        ok: false,
        suportado: true,
        mensagem: 'Informe o telefone de contato do anúncio — campo obrigatório na OLX.'
      };
    }

    if (!integracao.feed_habilitado || !integracao.feed_token) {
      return {
        ok: false,
        suportado: true,
        mensagem: 'Feed desabilitado ou sem token. Gere o token antes de informar a URL à OLX.'
      };
    }

    return {
      ok: true,
      suportado: true,
      mensagem:
        `Feed XML pronto. Imóveis habilitados para este canal: ${totalHabilitados}. ` +
        'Publicação via API permanece pendente de credenciais OAuth.',
      feedUrl
    };
  }
}

module.exports = { OlxAdapter, ENDPOINT_AUTOUPLOAD };
