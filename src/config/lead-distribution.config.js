/**
 * Configuração ÚNICA da fila de leads.
 *
 * Regra do projeto: a janela de presença não pode ficar espalhada em
 * vários arquivos. Backend e frontend leem sempre daqui (o frontend
 * recebe os valores por `GET /fila-leads`, campo `configuracao`).
 */

const inteiro = (valor, padrao) => {
  const numero = Number(valor);
  return Number.isFinite(numero) && numero > 0 ? Math.trunc(numero) : padrao;
};

/** Tempo sem heartbeat até o corretor ser considerado offline. */
const PRESENCA_TIMEOUT_SEGUNDOS = inteiro(process.env.FILA_PRESENCA_TIMEOUT_SEGUNDOS, 120);

/**
 * Intervalo sugerido de heartbeat do frontend.
 * Fica confortavelmente abaixo do timeout para tolerar uma falha isolada
 * de rede sem derrubar o corretor da fila.
 */
const HEARTBEAT_INTERVALO_SEGUNDOS = inteiro(
  process.env.FILA_HEARTBEAT_INTERVALO_SEGUNDOS,
  Math.max(15, Math.floor(PRESENCA_TIMEOUT_SEGUNDOS / 3))
);

/** Intervalo de atualização do painel (polling leve). */
const PAINEL_POLL_SEGUNDOS = inteiro(process.env.FILA_PAINEL_POLL_SEGUNDOS, 5);

/** Perfis que participam do rodízio. Gerente/admin não entram na fila. */
const PERFIS_NA_FILA = ['corretor'];

/**
 * Estratégia de distribuição de leads novos:
 *   FILA   — rodízio entre corretores online (padrão, comportamento novo);
 *   IMOVEL — responsável do imóvel, como antes da fila existir.
 *
 * Mantida configurável para permitir voltar ao comportamento anterior
 * sem alterar código, caso a operação peça.
 */
const ESTRATEGIA = String(process.env.LEAD_DISTRIBUICAO_ESTRATEGIA || 'FILA').toUpperCase() === 'IMOVEL'
  ? 'IMOVEL'
  : 'FILA';

/**
 * Chave do advisory lock que serializa a distribuição.
 * Constante fixa: dois processos da API precisam usar o MESMO número.
 */
const LOCK_KEY_DISTRIBUICAO = 918273645;

/** Quantidade máxima de leads pendentes processados por rodada. */
const MAX_PENDENTES_POR_RODADA = inteiro(process.env.FILA_MAX_PENDENTES_RODADA, 25);

module.exports = {
  PRESENCA_TIMEOUT_SEGUNDOS,
  HEARTBEAT_INTERVALO_SEGUNDOS,
  PAINEL_POLL_SEGUNDOS,
  PERFIS_NA_FILA,
  ESTRATEGIA,
  LOCK_KEY_DISTRIBUICAO,
  MAX_PENDENTES_POR_RODADA,

  /** Objeto enviado ao frontend — nada de segredo aqui. */
  publico() {
    return {
      presencaTimeoutSegundos: PRESENCA_TIMEOUT_SEGUNDOS,
      heartbeatIntervaloSegundos: HEARTBEAT_INTERVALO_SEGUNDOS,
      painelPollSegundos: PAINEL_POLL_SEGUNDOS,
      estrategia: ESTRATEGIA
    };
  }
};
