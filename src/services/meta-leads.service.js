const pool = require('../config/db');
const { graph, assinaturaValida, idMeta } = require('../integrations/meta/graph');
const meta = require('./meta.service');
const ingress = require('./portal-lead-ingress.service');
const { badRequest, HttpError } = require('../utils/http-error');

async function receber(rawBody, signature, body) {
  if (!assinaturaValida(rawBody, signature)) throw new HttpError(401, 'Assinatura Meta inválida.');
  if (body.object !== 'page' || !Array.isArray(body.entry)) throw badRequest('Evento Meta inválido.');
  const client = await pool.connect();
  let total = 0;
  try {
    await client.query('BEGIN');
    for (const entry of body.entry) {
      for (const change of entry.changes || []) {
        if (change.field !== 'leadgen') continue;
        const value = change.value || {};
        const leadId = idMeta(value.leadgen_id);
        const pageId = idMeta(value.page_id || entry.id);
        if (String(entry.id) !== pageId) throw badRequest('Página inconsistente no evento.');
        const pagina = (await client.query('SELECT id FROM meta_paginas WHERE id=$1', [pageId])).rows[0];
        if (!pagina) throw new HttpError(403, 'Página não conectada ao Gold Leste.');
        const r = await client.query(`INSERT INTO meta_lead_eventos(lead_id,page_id,payload) VALUES($1,$2,$3)
          ON CONFLICT(lead_id) DO NOTHING RETURNING lead_id`, [leadId, pageId, JSON.stringify(value)]);
        total += r.rowCount;
      }
    }
    await client.query('COMMIT');
    return { recebidos: total };
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

function normalizarLead(lead, evento) {
  const campos = Object.fromEntries((lead.field_data || []).map(f => [f.name, (f.values || []).join(' ')]));
  const nome = campos.full_name || [campos.first_name, campos.last_name].filter(Boolean).join(' ');
  return { nome, email: campos.email, telefone: campos.phone_number,
    mensagem: Object.entries(campos).filter(([k]) => !['full_name','first_name','last_name','email','phone_number'].includes(k)).map(([k,v]) => `${k}: ${v}`).join('\n'),
    externalLeadId: lead.id, contatoGeral: true,
    utm_source: lead.platform || 'facebook', utm_medium: 'paid_social', utm_campaign: lead.campaign_name || lead.campaign_id,
    utm_content: lead.ad_name || lead.ad_id, meta: { ...evento.payload, campaign_id: lead.campaign_id, campaign_name: lead.campaign_name,
      ad_id: lead.ad_id, adset_id: lead.adset_id, form_id: lead.form_id, created_time: lead.created_time, platform: lead.platform },
    field_data: lead.field_data };
}

async function processarUm() {
  // Lease atômico entre processos. Nunca remove o evento; retries sem limite
  // com atraso máximo de 15 minutos, inclusive após expiração de token.
  const evento = (await pool.query(`UPDATE meta_lead_eventos SET tentativas=tentativas+1,
      proxima_tentativa=now()+interval '2 minutes'
    WHERE lead_id=(SELECT lead_id FROM meta_lead_eventos
      WHERE concluido_em IS NULL AND proxima_tentativa<=now()
      ORDER BY recebido_em FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`)).rows[0];
  if (!evento) return false;
  try {
    const lead = await graph(evento.lead_id, await meta.tokenPagina(evento.page_id), {
      fields: 'id,created_time,field_data,ad_id,ad_name,adset_id,campaign_id,campaign_name,form_id,platform'
    });
    if (String(lead.id) !== evento.lead_id || !Array.isArray(lead.field_data)) throw new HttpError(502, 'Lead Meta incompleto.');
    await ingress.registrarLeadDePortal({ portalSlug: 'facebook', body: normalizarLead(lead, evento),
      req: { ip: null, headers: { 'user-agent': 'Meta Lead Ads webhook' } } });
    await pool.query('UPDATE meta_lead_eventos SET concluido_em=now(),ultimo_erro=NULL WHERE lead_id=$1', [evento.lead_id]);
  } catch (e) {
    const atraso = Math.min(900, 15 * Math.pow(2, Math.min(evento.tentativas, 6)));
    await pool.query("UPDATE meta_lead_eventos SET ultimo_erro=$2,proxima_tentativa=now()+($3 * interval '1 second') WHERE lead_id=$1",
      [evento.lead_id, e instanceof HttpError ? e.message : 'Falha interna. Evento preservado para nova tentativa.', atraso]);
  }
  return true;
}

let executando = false;
async function rodada(limite = 10) {
  if (executando) return;
  executando = true;
  try { for (let i = 0; i < limite; i++) if (!await processarUm()) break; }
  finally { executando = false; }
}
function iniciarWorker() {
  if (process.env.META_LEADS_WORKER_ENABLED !== 'true') return;
  const executar = () => rodada().catch(() => console.error('[meta-leads] Falha na fila. Eventos preservados.'));
  executar();
  const timer = setInterval(executar, 15000);
  timer.unref();
}
module.exports = { receber, normalizarLead, processarUm, rodada, iniciarWorker };
