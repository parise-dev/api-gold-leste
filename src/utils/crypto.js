const crypto = require('crypto');

/**
 * Cifra simétrica para credenciais de portais.
 * A chave vem SOMENTE de INTEGRACOES_CRYPTO_KEY (env da VPS).
 * Formato armazenado: v1:<iv base64>:<tag base64>:<payload base64>
 */
const PREFIXO = 'v1';
const ALGORITMO = 'aes-256-gcm';

function obterChave() {
  const bruta = process.env.INTEGRACOES_CRYPTO_KEY;

  if (!bruta) {
    throw new Error(
      'INTEGRACOES_CRYPTO_KEY não configurada. Defina a variável de ambiente antes de salvar credenciais de portais.'
    );
  }

  // Aceita hex de 64 chars (32 bytes) ou qualquer string (derivada por SHA-256).
  if (/^[0-9a-fA-F]{64}$/.test(bruta)) {
    return Buffer.from(bruta, 'hex');
  }

  return crypto.createHash('sha256').update(bruta).digest();
}

function cifrar(objeto) {
  if (objeto === null || objeto === undefined) return null;

  const chave = obterChave();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITMO, chave, iv);

  const texto = JSON.stringify(objeto);
  const cifrado = Buffer.concat([cipher.update(texto, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    PREFIXO,
    iv.toString('base64'),
    tag.toString('base64'),
    cifrado.toString('base64')
  ].join(':');
}

function decifrar(valorArmazenado) {
  if (!valorArmazenado) return null;

  const partes = String(valorArmazenado).split(':');

  if (partes.length !== 4 || partes[0] !== PREFIXO) {
    throw new Error('Credenciais em formato desconhecido. Reconfigure a integração.');
  }

  const chave = obterChave();
  const iv = Buffer.from(partes[1], 'base64');
  const tag = Buffer.from(partes[2], 'base64');
  const payload = Buffer.from(partes[3], 'base64');

  const decipher = crypto.createDecipheriv(ALGORITMO, chave, iv);
  decipher.setAuthTag(tag);

  const aberto = Buffer.concat([decipher.update(payload), decipher.final()]);

  return JSON.parse(aberto.toString('utf8'));
}

function gerarToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('hex');
}

function cryptoDisponivel() {
  return !!process.env.INTEGRACOES_CRYPTO_KEY;
}

module.exports = { cifrar, decifrar, gerarToken, cryptoDisponivel };
