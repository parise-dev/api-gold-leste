const pool = require('../../config/db');
const ativo = () => process.env.OPERACAO_LEADS_ENABLED === 'true';
async function preparar(dados, client = pool) {
  if (!ativo() || dados.tipo_lead === 'CAPTACAO_IMOVEL') return dados;
  const filial = dados.filial_id || (await client.query('SELECT filial_padrao_id FROM gl_operacao_config WHERE id=1')).rows[0]?.filial_padrao_id;
  const proprio = !!dados.posse_permanente && !!dados.criado_por_id;
  return { ...dados, filial_id: filial || null, operacao_gerenciada: true, etapa: 'NOVO',
    etapa_em: new Date(), prazo_em: null, responsavel_id: proprio ? dados.criado_por_id : null,
    atribuido_em: proprio ? new Date() : null, status_processamento: proprio ? 'ATRIBUIDO' : 'RECEBIDO',
    distribuicao_pendente_desde: proprio ? null : new Date() };
}
module.exports = { ativo, preparar };
