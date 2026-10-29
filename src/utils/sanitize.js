const crypto = require('crypto');

const CHAVES_SENSIVEIS = [
  'password', 'senha', 'senhahash', 'secret', 'clientsecret', 'secretkey',
  'accesskey', 'accesstoken', 'refreshtoken', 'token', 'authorization',
  'apikey', 'jwt', 'credenciais', 'credenciaiscifradas', 'privatekey'
];

// Caracteres de controle (C0 + DEL + C1). Escrito via string escapada de
// propósito: literais de controle no fonte tornam o arquivo binário.
const REGEX_CONTROLE = new RegExp('[\\u0000-\\u001F\\u007F-\\u009F]', 'g');

function ehChaveSensivel(chave) {
  const normalizada = String(chave).toLowerCase().replace(/[^a-z]/g, '');
  return CHAVES_SENSIVEIS.some((sensivel) => normalizada.includes(sensivel));
}

/**
 * Remove segredos de qualquer payload antes de gravar em log/banco.
 * Profundidade limitada para não explodir com estruturas grandes/cíclicas.
 */
function sanitizarPayload(valor, profundidade = 0) {
  if (profundidade > 6) return '[profundidade máxima]';
  if (valor === null || valor === undefined) return valor;

  if (Array.isArray(valor)) {
    return valor.slice(0, 200).map((item) => sanitizarPayload(item, profundidade + 1));
  }

  if (valor instanceof Date) return valor.toISOString();

  if (typeof valor === 'object') {
    const saida = {};

    for (const [chave, item] of Object.entries(valor)) {
      saida[chave] = ehChaveSensivel(chave)
        ? '[REDACTED]'
        : sanitizarPayload(item, profundidade + 1);
    }

    return saida;
  }

  if (typeof valor === 'string' && valor.length > 4000) {
    return `${valor.slice(0, 4000)}…[truncado]`;
  }

  return valor;
}

/** Mostra só as pontas de um segredo já salvo: "abc***xyz". */
function mascararSegredo(valor) {
  if (!valor) return null;

  const texto = String(valor);
  if (texto.length <= 6) return '***';

  return `${texto.slice(0, 3)}***${texto.slice(-3)}`;
}

/** Nunca guardamos IP puro — apenas hash com sal do ambiente. */
function hashIp(ip) {
  if (!ip) return null;

  const sal = process.env.LEAD_IP_SALT || process.env.JWT_SECRET || 'gold-leste';

  return crypto
    .createHash('sha256')
    .update(`${sal}:${ip}`)
    .digest('hex')
    .slice(0, 64);
}

/** Remove caracteres de controle e limita o tamanho de texto vindo de fora. */
function limparTexto(valor, tamanhoMaximo = 500) {
  if (valor === null || valor === undefined) return null;

  const texto = String(valor).replace(REGEX_CONTROLE, '').trim();

  if (!texto) return null;

  return texto.length > tamanhoMaximo ? texto.slice(0, tamanhoMaximo) : texto;
}

module.exports = {
  sanitizarPayload,
  mascararSegredo,
  hashIp,
  limparTexto
};
