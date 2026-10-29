function numeroMonetario(valor) {
  const numero = Number(valor || 0);
  return Number.isFinite(numero) ? numero : 0;
}

function possuiNota(nota) {
  return String(nota || '')
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase() === 'sim';
}

function calcularValorNota(nota, valorNota) {
  if (!possuiNota(nota)) {
    return 0;
  }

  return Math.max(numeroMonetario(valorNota), 0);
}

function calcularComissaoLiquida(valorComissaoTotal, nota, valorNota) {
  const comissaoBruta = Math.max(numeroMonetario(valorComissaoTotal), 0);
  return Math.max(comissaoBruta - calcularValorNota(nota, valorNota), 0);
}

module.exports = {
  calcularComissaoLiquida,
  calcularValorNota,
  possuiNota
};
