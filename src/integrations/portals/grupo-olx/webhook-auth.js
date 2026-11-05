const crypto = require('crypto');
// O Grupo OLX fornece uma SECRET_KEY por CRM na homologação. O token da
// URL identifica a imobiliária; Basic valida o emissor. Opcional enquanto
// os intermediários legados continuam usando apenas o contrato anterior.
function autorizado(header, secret = process.env.GRUPO_OLX_WEBHOOK_SECRET_KEY) {
  if (!secret) return true;
  if (!/^Basic [a-zA-Z0-9+/=]+$/i.test(String(header || ''))) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const separator = decoded.indexOf(':');
  if (separator < 1) return false;
  const recebido = Buffer.from(decoded.slice(separator + 1));
  const esperado = Buffer.from(secret);
  return recebido.length === esperado.length && crypto.timingSafeEqual(recebido, esperado);
}
module.exports = { autorizado };
