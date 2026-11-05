const http2=require('node:http2');
const fs=require('node:fs');
const jwt=require('jsonwebtoken');
const pool=require('../../config/db');
const {decifrar}=require('../../utils/crypto');
let cacheToken=null,cacheEm=0;
function configurado(){return !!(process.env.APNS_TEAM_ID&&process.env.APNS_KEY_ID&&process.env.APNS_BUNDLE_ID&&process.env.APNS_KEY_PATH);}
function autorizacao(){
 if(cacheToken&&Date.now()-cacheEm<45*60000)return cacheToken;
 cacheToken=jwt.sign({iss:process.env.APNS_TEAM_ID,iat:Math.floor(Date.now()/1000)},fs.readFileSync(process.env.APNS_KEY_PATH),{
  algorithm:'ES256',header:{alg:'ES256',kid:process.env.APNS_KEY_ID}});cacheEm=Date.now();return cacheToken;
}
function enviar(token,ambiente,payload,collapse){
 return new Promise((resolve,reject)=>{
  const host=ambiente==='production'?'https://api.push.apple.com':'https://api.sandbox.push.apple.com';
  const conn=http2.connect(host);let terminou=false;
  const fim=(error,value)=>{if(terminou)return;terminou=true;clearTimeout(timer);conn.close();error?reject(error):resolve(value);};
  const timer=setTimeout(()=>{conn.destroy();fim(new Error('APNS_TIMEOUT'));},20000);
  conn.on('error',()=>fim(new Error('APNS_CONNECTION')));
  let req;try{req=conn.request({':method':'POST',':path':'/3/device/'+token,'authorization':'bearer '+autorizacao(),
   'apns-topic':process.env.APNS_BUNDLE_ID,'apns-push-type':'alert','apns-priority':'10',
   'apns-expiration':String(Math.floor(Date.now()/1000)+300),'apns-collapse-id':collapse});}catch(e){fim(e);return;}
  let status=0,body='';req.setEncoding('utf8');req.on('response',headers=>{status=headers[':status'];});
  req.on('data',chunk=>{body+=chunk;});req.on('error',()=>fim(new Error('APNS_STREAM')));
  req.on('end',()=>{let reason;try{reason=JSON.parse(body).reason;}catch(_){}fim(null,{status,reason});});req.end(JSON.stringify(payload));
 });
}
async function processarUm(transport=enviar){
 if(!configurado())return false;
 const job=(await pool.query(`UPDATE gl_push_outbox SET tentativas=tentativas+1,proxima_em=now()+interval '2 minutes'
  WHERE id=(SELECT id FROM gl_push_outbox WHERE enviado_em IS NULL AND cancelado_em IS NULL AND proxima_em<=now()
  ORDER BY proxima_em,id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`)).rows[0];
 if(!job)return false;
 const dado=(await pool.query(`SELECT d.*,l.responsavel_id,l.versao_atendimento,s.revogada_em,s.expira_em,u.ativo AS usuario_ativo
  FROM gl_dispositivos d JOIN usuarios u ON u.id=d.usuario_id JOIN gl_sessoes s ON s.id=d.sessao_id JOIN portal_leads l ON l.id=$2 WHERE d.id=$1`,[job.dispositivo_id,job.lead_id])).rows[0];
 if(!dado||!dado.ativo||!dado.usuario_ativo||dado.usuario_id!==job.usuario_id||dado.revogada_em||new Date(dado.expira_em)<=new Date()||dado.responsavel_id!==job.usuario_id||dado.versao_atendimento!==job.versao){
  await pool.query('UPDATE gl_push_outbox SET cancelado_em=now(),erro=$2 WHERE id=$1',[job.id,'Atribuição ou sessão não está mais ativa.']);return true;
 }
 try{
  const r=await transport(decifrar(dado.token_cifrado).token,dado.ambiente,{aps:{alert:{title:'Sua próxima oportunidade',body:'Você recebeu um novo lead. Abra o Gold Leste para atender.'},sound:'default'},leadId:job.lead_id,versao:job.versao},job.id);
  if(r.status===200)await pool.query('UPDATE gl_push_outbox SET enviado_em=now(),erro=NULL WHERE id=$1',[job.id]);
  else if(r.status===410||['BadDeviceToken','DeviceTokenNotForTopic','Unregistered'].includes(r.reason)){
   await pool.query('UPDATE gl_dispositivos SET ativo=false WHERE id=$1',[job.dispositivo_id]);
   await pool.query('UPDATE gl_push_outbox SET cancelado_em=now(),erro=$2 WHERE id=$1',[job.id,'Dispositivo inválido ou desregistrado.']);
  }else throw new Error('APNS_STATUS_'+r.status);
 }catch(_){await pool.query(`UPDATE gl_push_outbox SET erro='Falha no APNs; aguardando nova tentativa.',
  proxima_em=now()+($2*interval '1 second') WHERE id=$1`,[job.id,Math.min(900,15*2**Math.min(job.tentativas,6))]);}
 return true;
}
module.exports={configurado,enviar,processarUm};
