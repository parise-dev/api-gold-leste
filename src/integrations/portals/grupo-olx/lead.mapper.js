const { badRequest } = require('../../../utils/http-error');

// Aceita também o contrato genérico anterior para não interromper intermediários.
function normalizarLead(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('Lead deve ser um objeto JSON.');
  const oficial = body.originLeadId !== undefined || body.leadOrigin !== undefined;
  if (oficial && !String(body.originLeadId || '').trim()) throw badRequest('originLeadId é obrigatório.');
  if (oficial && body.leadOrigin !== 'MCMV_OLX' && !String(body.clientListingId || '').trim()) {
    throw badRequest('clientListingId é obrigatório para leads de anúncio.');
  }
  const telefone = String(body.phone || '').replace(/\D/g, '');
  const ddd = String(body.ddd || '').replace(/\D/g, '');
  return {
    ...body,
    externalLeadId: body.originLeadId ?? body.externalLeadId ?? body.leadId ?? body.id,
    externalListingId: body.clientListingId ?? body.externalListingId ?? body.listingId ?? body.codigoImovel,
    telefone: body.telefone || (ddd && telefone.length <= 9 ? ddd + telefone : telefone) || body.phoneNumber,
    contatoGeral: body.leadOrigin === 'MCMV_OLX'
  };
}

module.exports = { normalizarLead };
