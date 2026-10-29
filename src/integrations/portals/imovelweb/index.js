const { PortalAdapter } = require('../portal-adapter');

/**
 * Imovelweb.
 *
 * Situação verificada em 2026-08-16: NÃO foi localizada documentação
 * oficial pública de feed XML ou API de integração de imóveis para o
 * Imovelweb. O fluxo praticado no mercado é comercial — o cliente envia
 * a URL de sincronização ao suporte do portal, que define o formato
 * aceito na homologação.
 *
 * Por isso este adapter fica em PENDING_SPECIFICATION:
 *   - a estrutura, a configuração e a tela existem;
 *   - o mapeamento NÃO é inventado;
 *   - nenhuma operação retorna sucesso falso.
 *
 * Para ativar: obter a especificação oficial junto ao portal, criar
 * `imovelweb.mapper.js` no mesmo padrão dos demais e trocar
 * statusImplementacao/capacidades.
 */
class ImovelwebAdapter extends PortalAdapter {
  constructor() {
    super({
      slug: 'imovelweb',
      nome: 'Imovelweb',
      modoIntegracao: 'FEED_XML',
      statusImplementacao: 'PENDING_SPECIFICATION',
      documentacaoUrl: null,
      pendencias: [
        'Obter junto ao Imovelweb a especificação oficial do arquivo/feed de integração de imóveis.',
        'Confirmar formato (XML/JSON), campos obrigatórios, tabela de tipos e regras de mídia.',
        'Confirmar o mecanismo de recebimento de leads (webhook, e-mail ou painel).',
        'Após a homologação, implementar integrations/portals/imovelweb/imovelweb.mapper.js.'
      ]
    });
  }

  capacidades() {
    return {
      feed: false,
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
      { chave: 'contato_nome', label: 'Nome da imobiliária', tipo: 'texto' },
      { chave: 'contato_email', label: 'E-mail de contato', tipo: 'email' },
      { chave: 'contato_telefone', label: 'Telefone', tipo: 'texto' },
      {
        chave: 'config:observacoes',
        label: 'Observações da homologação',
        tipo: 'texto',
        ajuda: 'Registre aqui o retorno do portal sobre formato e campos exigidos.'
      }
    ];
  }

  validateProperty() {
    return {
      ok: false,
      erros: [
        {
          campo: 'integracao',
          mensagem:
            'Integração com o Imovelweb aguardando especificação oficial do portal. ' +
            'Nenhum imóvel pode ser validado até que o formato seja confirmado.'
        }
      ],
      avisos: []
    };
  }

  async testConnection() {
    return {
      ok: false,
      suportado: true,
      status: 'PENDING_SPECIFICATION',
      mensagem:
        'Não há especificação oficial pública de integração do Imovelweb. ' +
        'Solicite a documentação ao portal para concluir esta integração.',
      pendencias: this.pendencias
    };
  }
}

module.exports = { ImovelwebAdapter };
