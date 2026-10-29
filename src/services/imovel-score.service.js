/**
 * Qualidade do anúncio e score de oportunidade.
 *
 * Ambos os cálculos são deliberadamente simples e explícitos para que
 * possam ser ajustados sem efeitos colaterais. Os pesos ficam todos
 * nas constantes abaixo.
 */

// ---------------------------------------------------------------------
// QUALIDADE DO ANÚNCIO (0..100)
// Soma dos critérios atendidos / soma total dos pesos.
// ---------------------------------------------------------------------
const CRITERIOS_QUALIDADE = [
  {
    chave: 'titulo',
    peso: 8,
    label: 'Título com pelo menos 20 caracteres',
    avaliar: (imovel) => String(imovel.titulo || '').trim().length >= 20
  },
  {
    chave: 'descricao',
    peso: 12,
    label: 'Descrição com pelo menos 200 caracteres',
    avaliar: (imovel) => String(imovel.descricao || '').trim().length >= 200
  },
  {
    chave: 'capa',
    peso: 14,
    label: 'Foto de capa definida',
    avaliar: (imovel, contexto) => !!contexto.temCapa
  },
  {
    chave: 'fotosMinimas',
    peso: 16,
    label: 'Pelo menos 5 fotos (mínimo exigido pelo Grupo OLX)',
    avaliar: (imovel, contexto) => Number(contexto.totalFotos || 0) >= 5
  },
  {
    chave: 'fotosIdeais',
    peso: 6,
    label: 'Pelo menos 10 fotos',
    avaliar: (imovel, contexto) => Number(contexto.totalFotos || 0) >= 10
  },
  {
    chave: 'endereco',
    peso: 12,
    label: 'Cidade, UF e bairro preenchidos',
    avaliar: (imovel) => !!(imovel.cidade && imovel.uf && imovel.bairro)
  },
  {
    chave: 'valor',
    peso: 14,
    label: 'Valor compatível com a finalidade',
    avaliar: (imovel) => {
      const venda = Number(imovel.valor_venda || 0) > 0;
      const locacao = Number(imovel.valor_locacao || 0) > 0;

      if (imovel.finalidade === 'VENDA') return venda;
      if (imovel.finalidade === 'LOCACAO') return locacao;
      return venda || locacao;
    }
  },
  {
    chave: 'metragem',
    peso: 8,
    label: 'Área útil ou área total informada',
    avaliar: (imovel) =>
      Number(imovel.area_util || 0) > 0 || Number(imovel.area_total || 0) > 0
  },
  {
    chave: 'dormitorios',
    peso: 5,
    label: 'Dormitórios informados (ou tipo sem dormitório)',
    avaliar: (imovel) => {
      const semDormitorio = ['TERRENO', 'GALPAO', 'SALA', 'COMERCIAL'].includes(imovel.tipo);
      return semDormitorio || Number(imovel.dormitorios || 0) > 0;
    }
  },
  {
    chave: 'caracteristicas',
    peso: 5,
    label: 'Pelo menos 3 características cadastradas',
    avaliar: (imovel, contexto) => Number(contexto.totalCaracteristicas || 0) >= 3
  }
];

const PESO_TOTAL_QUALIDADE = CRITERIOS_QUALIDADE.reduce((total, item) => total + item.peso, 0);

/**
 * @param imovel   linha da tabela imoveis (snake_case)
 * @param contexto { totalFotos, temCapa, totalCaracteristicas }
 */
function calcularQualidade(imovel, contexto = {}) {
  const itens = CRITERIOS_QUALIDADE.map((criterio) => {
    let atendido = false;

    try {
      atendido = !!criterio.avaliar(imovel, contexto);
    } catch (error) {
      atendido = false;
    }

    return {
      chave: criterio.chave,
      label: criterio.label,
      peso: criterio.peso,
      atendido
    };
  });

  const somaAtendida = itens
    .filter((item) => item.atendido)
    .reduce((total, item) => total + item.peso, 0);

  const score = Math.round((somaAtendida / PESO_TOTAL_QUALIDADE) * 100);

  return {
    score: Math.max(0, Math.min(100, score)),
    itens,
    pendencias: itens.filter((item) => !item.atendido).map((item) => item.label)
  };
}

// ---------------------------------------------------------------------
// SCORE DE OPORTUNIDADE
//
//   score = base manual
//         + sinais de negócio (oportunidade/exclusivo/destaque/lançamento)
//         + faixa de comissão
//         + novidade (decai em 45 dias)
//         + engajamento (leads e visualizações, com teto)
//         + qualidade do anúncio (até 10)
//
// Escala prática: 0 a ~100. Nada de fórmula artificial: cada parcela é
// somada explicitamente e o detalhamento é retornado para depuração.
// ---------------------------------------------------------------------
const PESOS_OPORTUNIDADE = {
  oportunidadeManual: 25,
  exclusivo: 12,
  destaque: 8,
  lancamento: 8,
  comissaoMaxima: 15,     // atingido com comissão >= 6%
  novidadeMaxima: 12,     // imóvel recém-cadastrado
  leadMaximo: 10,         // teto do engajamento por leads
  visualizacaoMaxima: 5,  // teto do engajamento por visualizações
  qualidadeMaxima: 10,
  prioridadeManualMaxima: 20
};

const DIAS_NOVIDADE = Number(process.env.OPORTUNIDADE_DIAS_NOVIDADE || 45);

function diasDesde(data) {
  if (!data) return 9999;

  const referencia = data instanceof Date ? data : new Date(data);
  if (Number.isNaN(referencia.getTime())) return 9999;

  return Math.max(0, (Date.now() - referencia.getTime()) / (1000 * 60 * 60 * 24));
}

function calcularOportunidade(imovel, contexto = {}) {
  const parcelas = {};

  parcelas.oportunidadeManual = imovel.oportunidade ? PESOS_OPORTUNIDADE.oportunidadeManual : 0;
  parcelas.exclusivo = imovel.exclusivo ? PESOS_OPORTUNIDADE.exclusivo : 0;
  parcelas.destaque = imovel.destaque ? PESOS_OPORTUNIDADE.destaque : 0;
  parcelas.lancamento = imovel.lancamento ? PESOS_OPORTUNIDADE.lancamento : 0;

  const comissao = Number(imovel.comissao_percentual || 0);
  parcelas.comissao = Math.min(comissao / 6, 1) * PESOS_OPORTUNIDADE.comissaoMaxima;

  const dias = diasDesde(imovel.created_at);
  const fatorNovidade = Math.max(0, 1 - dias / DIAS_NOVIDADE);
  parcelas.novidade = fatorNovidade * PESOS_OPORTUNIDADE.novidadeMaxima;

  const leads = Number(contexto.totalLeads ?? imovel.total_leads ?? 0);
  parcelas.leads = Math.min(leads / 10, 1) * PESOS_OPORTUNIDADE.leadMaximo;

  const visualizacoes = Number(contexto.totalVisualizacoes ?? imovel.total_visualizacoes ?? 0);
  parcelas.visualizacoes = Math.min(visualizacoes / 500, 1) * PESOS_OPORTUNIDADE.visualizacaoMaxima;

  const qualidade = Number(contexto.qualidadeScore ?? imovel.qualidade_score ?? 0);
  parcelas.qualidade = (qualidade / 100) * PESOS_OPORTUNIDADE.qualidadeMaxima;

  const prioridade = Number(imovel.prioridade_manual || 0);
  parcelas.prioridadeManual =
    Math.min(prioridade / 100, 1) * PESOS_OPORTUNIDADE.prioridadeManualMaxima;

  const total = Object.values(parcelas).reduce((soma, valor) => soma + valor, 0);

  return {
    score: Math.round(total * 100) / 100,
    parcelas
  };
}

module.exports = {
  CRITERIOS_QUALIDADE,
  PESOS_OPORTUNIDADE,
  calcularQualidade,
  calcularOportunidade
};
