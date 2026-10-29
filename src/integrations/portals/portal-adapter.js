/**
 * Contrato base de um provider de portal imobiliário.
 *
 * Nem todo portal implementa todos os métodos. Os que não implementa
 * devolvem `naoSuportado()` — NUNCA um sucesso falso. O painel de
 * integrações mostra exatamente isso ao usuário.
 *
 * Status possíveis do adapter:
 *   IMPLEMENTADO          — conforme documentação oficial vigente
 *   PARCIAL               — parte do fluxo oficialmente documentada
 *   PENDING_CONFIGURATION — pronto, aguardando credenciais/homologação
 *   PENDING_SPECIFICATION — sem especificação pública suficiente
 */
class PortalAdapter {
  constructor({
    slug,
    nome,
    modoIntegracao = 'FEED_XML',
    statusImplementacao = 'PENDING_CONFIGURATION',
    documentacaoUrl = null,
    pendencias = []
  }) {
    this.slug = slug;
    this.nome = nome;
    this.modoIntegracao = modoIntegracao;
    this.statusImplementacao = statusImplementacao;
    this.documentacaoUrl = documentacaoUrl;
    this.pendencias = pendencias;
  }

  /** Capacidades reais deste adapter — usadas pelo front para habilitar botões. */
  capacidades() {
    return {
      feed: false,
      publish: false,
      update: false,
      deactivate: false,
      publicationStatus: false,
      importLeads: false,
      testConnection: false
    };
  }

  /**
   * Valida um imóvel contra as exigências documentadas do portal.
   * @returns {{ ok: boolean, erros: Array<{campo:string,mensagem:string}>, avisos: Array }}
   */
  // eslint-disable-next-line no-unused-vars
  validateProperty(contexto) {
    return { ok: true, erros: [], avisos: [] };
  }

  /** Converte o imóvel interno para a estrutura do portal. */
  // eslint-disable-next-line no-unused-vars
  mapProperty(contexto) {
    throw new Error(`mapProperty não implementado para o portal ${this.slug}.`);
  }

  /** Gera o feed completo (string XML/JSON). */
  // eslint-disable-next-line no-unused-vars
  async generateFeed(contexto) {
    return this.naoSuportado('generateFeed');
  }

  // eslint-disable-next-line no-unused-vars
  async publish(contexto) {
    return this.naoSuportado('publish');
  }

  // eslint-disable-next-line no-unused-vars
  async update(contexto) {
    return this.naoSuportado('update');
  }

  // eslint-disable-next-line no-unused-vars
  async deactivate(contexto) {
    return this.naoSuportado('deactivate');
  }

  // eslint-disable-next-line no-unused-vars
  async getPublicationStatus(contexto) {
    return this.naoSuportado('getPublicationStatus');
  }

  // eslint-disable-next-line no-unused-vars
  async importLeads(contexto) {
    return this.naoSuportado('importLeads');
  }

  // eslint-disable-next-line no-unused-vars
  async testConnection(contexto) {
    return this.naoSuportado('testConnection');
  }

  /** Campos de configuração que o painel deve renderizar. */
  camposConfiguracao() {
    return [];
  }

  /**
   * Resposta padrão para operação não disponível.
   * Deliberadamente NÃO lança: o painel precisa mostrar o motivo.
   */
  naoSuportado(operacao) {
    return {
      ok: false,
      suportado: false,
      status: this.statusImplementacao,
      operacao,
      mensagem:
        `A operação "${operacao}" não está disponível para ${this.nome}. ` +
        `Status do adapter: ${this.statusImplementacao}.`,
      pendencias: this.pendencias
    };
  }

  resumo() {
    return {
      slug: this.slug,
      nome: this.nome,
      modoIntegracao: this.modoIntegracao,
      statusImplementacao: this.statusImplementacao,
      documentacaoUrl: this.documentacaoUrl,
      pendencias: this.pendencias,
      capacidades: this.capacidades(),
      camposConfiguracao: this.camposConfiguracao()
    };
  }
}

module.exports = { PortalAdapter };
