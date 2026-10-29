const { PortalAdapter } = require('../portal-adapter');
const mapper = require('./cnm-xml.mapper');

/**
 * Chaves na Mão.
 *
 * Documentação oficial pública consultada em 2026-08-16:
 *   https://tecnologiacnm.github.io/cnm-xml-documentation/
 *
 * O portal consome um XML publicado em URL pública; o processamento
 * ocorre em horários fixos definidos pelo portal. A URL do feed precisa
 * ser enviada ao atendimento do Chaves na Mão pelo cliente — não há
 * endpoint público de cadastro automático, e por isso `publish` continua
 * não suportado (o feed é o mecanismo oficial).
 */
class ChavesNaMaoAdapter extends PortalAdapter {
  constructor() {
    super({
      slug: 'chaves-na-mao',
      nome: 'Chaves na Mão',
      modoIntegracao: 'FEED_XML',
      statusImplementacao: 'IMPLEMENTADO',
      documentacaoUrl: 'https://tecnologiacnm.github.io/cnm-xml-documentation/',
      pendencias: [
        'Enviar a URL do feed ao atendimento do Chaves na Mão para habilitar a leitura.',
        'Tipos comerciais: informar em Configuração o valor exato da tabela do portal (grafia com acentos).',
        'Não há API pública documentada de status de publicação nem de importação de leads.'
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
      { chave: 'contato_telefone', label: 'Telefone', tipo: 'texto' },
      {
        chave: 'config:tipos',
        label: 'Mapeamento de tipos (JSON) — ex.: {"SALA":"Sala Comercial"}',
        tipo: 'json',
        ajuda: 'Use exatamente a grafia da tabela oficial do portal, com acentos e espaços.'
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
        mensagem: 'Feed desabilitado ou sem token. Gere o token antes de enviar a URL ao portal.'
      };
    }

    return {
      ok: true,
      suportado: true,
      mensagem:
        `Feed pronto. Envie a URL para atendimento@chavesnamao.com.br informando responsável e CNPJ/CPF. ` +
        `Imóveis habilitados para este canal: ${totalHabilitados}.`,
      feedUrl
    };
  }
}

module.exports = { ChavesNaMaoAdapter };
