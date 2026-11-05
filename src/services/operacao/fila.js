const pool=require('../../config/db');
const {ativo}=require('./entrada');
const {coordenadas,distanciaM,prazo,ETAPAS}=require('./regras');
const {badRequest,forbidden,notFound,HttpError}=require('../../utils/http-error');
const LOCK=6301030;
async function transacao(fn){ const c=await pool.connect();try{await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock($1)',[LOCK]);const r=await fn(c);await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();} }
function exigirAtivo(){if(!ativo())throw new HttpError(503,'Operação mobile ainda não habilitada no ambiente.');}
const ELEGIVEIS=`SELECT m.*,u.nome,u.foto_url,f.nome AS filial_nome FROM gl_fila_membros m
 JOIN usuarios u ON u.id=m.usuario_id JOIN filiais f ON f.id=m.filial_id
 JOIN gl_sessoes s ON s.id=m.sessao_id
 WHERE m.ativo AND u.ativo AND u.perfil='corretor' AND f.ativo
 AND u.filial_id=m.filial_id AND s.usuario_id=u.id AND s.revogada_em IS NULL AND s.expira_em>now()
 AND m.localizado_em>now()-interval '15 minutes' AND m.precisao_m BETWEEN 0 AND 100
 AND f.latitude IS NOT NULL AND f.longitude IS NOT NULL
 AND EXISTS(SELECT 1 FROM gl_dispositivos d WHERE d.usuario_id=u.id AND d.sessao_id=s.id AND d.ativo)
 ORDER BY m.ordem,m.usuario_id`;
async function elegiveis(c=pool){
 const rows=(await c.query(ELEGIVEIS)).rows;
 if(!rows.length)return [];
 const filiais=(await c.query('SELECT id,latitude,longitude FROM filiais')).rows;
 return rows.filter(m=>{const f=filiais.find(f=>f.id===m.filial_id);return f&&distanciaM(m,f)+Number(m.precisao_m)<=1000;});
}
async function historico(c,lead,tipo,texto,usuario=null,anterior=null,nova=null){await c.query(`INSERT INTO gl_lead_historico(lead_id,usuario_id,tipo,descricao,etapa_anterior,etapa_nova)
 VALUES($1,$2,$3,$4,$5,$6)`,[lead,tipo==='SISTEMA'?null:usuario,tipo,texto,anterior,nova]);}
async function localizar(usuario,body,ativar=false){
 exigirAtivo();if(!usuario.sessaoId)throw forbidden('Use uma sessão do aplicativo para entrar na fila.');
 if(ativar&&!require('./apns').configurado())throw new HttpError(503,'O envio APNs precisa ser configurado no servidor antes de ativar o recebimento.');
 const ponto=coordenadas(body);
 const resultado=await transacao(async c=>{
  const f=(await c.query(`SELECT f.*,u.filial_id FROM usuarios u JOIN filiais f ON f.id=u.filial_id
   WHERE u.id=$1 AND u.ativo AND f.ativo`,[usuario.id])).rows[0];
  if(!f || f.latitude===null || f.longitude===null)throw badRequest('Sua filial precisa estar vinculada e ter geolocalização cadastrada.');
  const distancia=distanciaM(ponto,f), dentro=distancia+ponto.precisaoM<=1000;
  const push=(await c.query('SELECT id FROM gl_dispositivos WHERE usuario_id=$1 AND sessao_id=$2 AND ativo LIMIT 1',[usuario.id,usuario.sessaoId])).rows.length>0;
  if(ativar && usuario.perfil!=='corretor')throw forbidden('Somente corretores participam da fila.');
  if(ativar && (!dentro || !push))throw badRequest(!dentro?'Você está fora do raio de 1 km da sua filial.':'Ative as notificações nativas antes de receber leads.');
  const anterior=(await c.query('SELECT * FROM gl_fila_membros WHERE usuario_id=$1 FOR UPDATE',[usuario.id])).rows[0];
  const manter=!!anterior?.ativo&&anterior.sessao_id===usuario.sessaoId&&anterior.filial_id===f.id&&new Date(anterior.localizado_em)>new Date(Date.now()-900000);
  const ligado=dentro&&push&&(ativar||manter);
  await c.query(`INSERT INTO gl_fila_membros(usuario_id,sessao_id,filial_id,latitude,longitude,precisao_m,localizado_em,ativo)
   VALUES($1,$2,$3,$4,$5,$6,now(),$7) ON CONFLICT(usuario_id) DO UPDATE SET
   sessao_id=excluded.sessao_id,filial_id=excluded.filial_id,latitude=excluded.latitude,longitude=excluded.longitude,
   precisao_m=excluded.precisao_m,localizado_em=now(),ativo=excluded.ativo,
   ordem=CASE WHEN $8 THEN gl_fila_membros.ordem ELSE nextval('gl_fila_ordem_seq') END,
   entrou_em=CASE WHEN $8 THEN gl_fila_membros.entrou_em ELSE now() END`,[usuario.id,usuario.sessaoId,f.id,ponto.latitude,ponto.longitude,ponto.precisaoM,ligado,manter]);
  return {dentroRaio:dentro,distanciaM:Math.round(distancia),filialId:f.id,filialNome:f.nome,notificacoesAtivas:push,recebendo:ligado,
   filialLatitude:f.latitude,filialLongitude:f.longitude};
 });
 if(resultado.recebendo)await distribuir();return resultado;
}
async function desativar(usuario){await pool.query('UPDATE gl_fila_membros SET ativo=false WHERE usuario_id=$1',[usuario.id]);}
async function devolver(c,lead,motivo,descartado=false,usuario=null){
 if(lead.posse_permanente || lead.etapa==='VENDA')return false;
 if(descartado&&lead.responsavel_id)await c.query(`INSERT INTO gl_lead_exclusoes(lead_id,usuario_id,motivo) VALUES($1,$2,$3)
  ON CONFLICT DO NOTHING`,[lead.id,lead.responsavel_id,motivo]);
 await c.query(`UPDATE portal_leads SET ultimo_responsavel_id=responsavel_id,responsavel_id=NULL,prazo_em=NULL,
  etapa='NOVO',etapa_em=now(),visita_em=NULL,status_processamento='RECEBIDO',distribuicao_pendente_desde=now(),
  distribuicao_tipo=NULL,updated_at=now() WHERE id=$1`,[lead.id]);
 await historico(c,lead.id,usuario?'ETAPA':'SISTEMA',motivo,usuario,lead.etapa,descartado?'DESCARTADO':'NOVO');
 return true;
}
async function distribuir(){
 if(!ativo())return [];
 return transacao(async c=>{
  const vencidos=(await c.query(`SELECT * FROM portal_leads WHERE operacao_gerenciada AND NOT posse_permanente
    AND etapa<>'VENDA' AND responsavel_id IS NOT NULL AND prazo_em<=now() ORDER BY prazo_em,id FOR UPDATE LIMIT 100`)).rows;
  for(const lead of vencidos)await devolver(c,lead,'Prazo da etapa expirado; aguardando o próximo corretor.');
  const online=await elegiveis(c), resultados=[];
  const padrao=(await c.query('SELECT filial_padrao_id FROM gl_operacao_config WHERE id=1')).rows[0]?.filial_padrao_id;
  const leads=(await c.query(`SELECT l.* FROM portal_leads l WHERE l.operacao_gerenciada AND l.responsavel_id IS NULL
    AND l.etapa<>'VENDA' AND COALESCE(l.tipo_lead,'')<>'CAPTACAO_IMOVEL' AND l.status_processamento<>'DESCARTADO'
    AND EXISTS(SELECT 1 FROM gl_fila_membros m WHERE m.usuario_id=ANY($1::uuid[])
      AND m.filial_id=COALESCE(l.filial_id,$2) AND m.usuario_id IS DISTINCT FROM l.ultimo_responsavel_id
      AND NOT EXISTS(SELECT 1 FROM gl_lead_exclusoes ex WHERE ex.lead_id=l.id AND ex.usuario_id=m.usuario_id))
    ORDER BY COALESCE(l.distribuicao_pendente_desde,l.recebido_em),l.id FOR UPDATE LIMIT 100`,[online.map(m=>m.usuario_id),padrao||null])).rows;
  for(const lead of leads){
   const filial=lead.filial_id||padrao;if(!filial)continue;
   const exclusoes=(await c.query('SELECT usuario_id FROM gl_lead_exclusoes WHERE lead_id=$1',[lead.id])).rows.map(r=>r.usuario_id);
   const indice=online.findIndex(u=>u.filial_id===filial && u.usuario_id!==lead.ultimo_responsavel_id&&!exclusoes.includes(u.usuario_id));
   if(indice<0)continue;
   const corretor=online.splice(indice,1)[0];online.push(corretor);
   const r=(await c.query(`UPDATE portal_leads SET responsavel_id=$2,filial_id=$3,atribuido_em=now(),etapa='NOVO',
    etapa_em=now(),prazo_em=now()+interval '5 minutes',versao_atendimento=versao_atendimento+1,
    distribuicao_pendente_desde=NULL,distribuicao_tipo='AUTOMATICA',status_processamento='ATRIBUIDO',updated_at=now()
    WHERE id=$1 RETURNING *`,[lead.id,corretor.usuario_id,filial])).rows[0];
   await c.query(`UPDATE gl_fila_membros SET ordem=nextval('gl_fila_ordem_seq'),total_recebidos=total_recebidos+1,
    ultimo_lead_em=now() WHERE usuario_id=$1`,[corretor.usuario_id]);
   await historico(c,lead.id,'SISTEMA','Lead atribuído a '+corretor.nome+'; corretor movido para o final da fila.',null,lead.etapa,'NOVO');
   await c.query(`INSERT INTO gl_push_outbox(lead_id,usuario_id,versao,dispositivo_id)
    SELECT $1,$2,$3,d.id FROM gl_dispositivos d WHERE d.usuario_id=$2 AND d.sessao_id=$4 AND d.ativo
    ON CONFLICT DO NOTHING`,[lead.id,corretor.usuario_id,r.versao_atendimento,corretor.sessao_id]);
   resultados.push({lead:r,corretor:{id:corretor.usuario_id,nome:corretor.nome},atribuido:true});
  }
  return resultados;
 });
}
function podeVer(lead,u){return u.perfil==='admin'||lead.responsavel_id===u.id||(u.perfil==='gerente'&&u.filialId&&lead.filial_id===u.filialId);}
async function editar(leadId,body,usuario){
 exigirAtivo();
 const r=await transacao(async c=>{
  const lead=(await c.query('SELECT * FROM portal_leads WHERE id=$1 FOR UPDATE',[leadId])).rows[0];
  if(!lead||!lead.operacao_gerenciada)throw notFound('Lead operacional não encontrado.');
  if(!podeVer(lead,usuario))throw forbidden();
  if(usuario.perfil==='gerente'&&lead.responsavel_id!==usuario.id)throw forbidden('Histórico e etapas são registrados pelo responsável ou administrador.');
  if(body.versao!==lead.versao_atendimento)throw new HttpError(409,'Responsável ou versão do atendimento mudou. Atualize o lead.');
  const texto=String(body.descricao||'').trim();if(texto.length<3||texto.length>4000)throw badRequest('Registre um histórico entre 3 e 4.000 caracteres.');
  const etapa=body.etapa||lead.etapa;if(!ETAPAS.includes(etapa))throw badRequest('Etapa inválida.');
  if(!lead.responsavel_id&&etapa!=='NOVO')throw badRequest('Aguarde a atribuição de um responsável antes de mudar a etapa.');
  if(lead.etapa==='VENDA'&&etapa!=='VENDA')throw badRequest('Lead vendido possui vínculo permanente.');
  if(etapa==='DESCARTADO'&&!lead.posse_permanente){
   await devolver(c,lead,texto,true,usuario.id);return {redistribuido:true};
  }
  const visita=etapa==='VISITA'?(body.visitaEm||lead.visita_em?.toISOString?.()||lead.visita_em):null;
  const mudou=etapa!==lead.etapa;
  let limite=lead.prazo_em;
  if(mudou||etapa==='EM_ATENDIMENTO'||(etapa==='VISITA'&&body.visitaEm))limite=prazo(etapa,new Date(),visita,lead.posse_permanente);
  await c.query(`UPDATE portal_leads SET etapa=$2,prazo_em=$3,visita_em=$4,
   etapa_em=CASE WHEN $5 THEN now() ELSE etapa_em END,updated_at=now(),
   primeiro_atendimento_em=COALESCE(primeiro_atendimento_em,now()) WHERE id=$1`,[lead.id,etapa,limite,visita,mudou]);
  await historico(c,lead.id,mudou?'ETAPA':'HISTORICO',texto,usuario.id,lead.etapa,etapa);
  return {ok:true};
 });await distribuir();return r;
}
async function estado(usuario){
 if(usuario.perfil!=='admin'&&!usuario.filialId)return {fila:[],proximo:null,minhaPosicao:null,leadsAguardando:0,atualizadoEm:new Date().toISOString()};
 const fila=(await elegiveis()).filter(m=>usuario.perfil==='admin'||m.filial_id===usuario.filialId);
 const rows=fila.map((m,i)=>({posicao:i+1,usuarioId:m.usuario_id,nome:m.nome,fotoUrl:m.foto_url,filialId:m.filial_id,
  filialNome:m.filial_nome,entrouEm:m.entrou_em,totalRecebidos:m.total_recebidos,ultimoLeadEm:m.ultimo_lead_em}));
 const p=await pool.query(`SELECT count(*)::int n FROM portal_leads WHERE operacao_gerenciada AND responsavel_id IS NULL
  AND etapa<>'VENDA' AND ($1::uuid IS NULL OR filial_id=$1)`,[usuario.perfil==='admin'?null:usuario.filialId]);
 return {fila:rows,proximo:rows[0]||null,minhaPosicao:rows.find(m=>m.usuarioId===usuario.id)?.posicao||null,
  leadsAguardando:p.rows[0].n,atualizadoEm:new Date().toISOString()};
}
module.exports={LOCK,transacao,exigirAtivo,localizar,desativar,distribuir,editar,estado,podeVer,historico,elegiveis};
