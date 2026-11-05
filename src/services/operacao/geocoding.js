const {HttpError,badRequest}=require('../../utils/http-error');
async function buscar(endereco){
 if(typeof endereco!=='string'||endereco.trim().length<10||endereco.length>500)throw badRequest('Informe endereço completo com número, cidade e UF.');
 if(!process.env.GOOGLE_GEOCODING_API_KEY)throw new HttpError(503,'Configure GOOGLE_GEOCODING_API_KEY no servidor ou confirme coordenadas manualmente.');
 const url=new URL('https://maps.googleapis.com/maps/api/geocode/json');
 url.search=new URLSearchParams({address:endereco,key:process.env.GOOGLE_GEOCODING_API_KEY,region:'br',language:'pt-BR'});
 const r=await fetch(url,{signal:AbortSignal.timeout(15000)});if(!r.ok)throw new HttpError(502,'Geocodificação indisponível.');
 const json=await r.json();const item=json.results?.[0];if(json.status!=='OK'||!item)throw badRequest('Endereço não localizado. Revise número, cidade e UF.');
 const numero=item.address_components?.find(c=>c.types.includes('street_number'))?.long_name;
 const preciso=!!numero&&!item.partial_match&&item.geometry.location_type==='ROOFTOP';
 return {latitude:item.geometry.location.lat,longitude:item.geometry.location.lng,endereco:item.formatted_address,
  numero,preciso,tipo:item.geometry.location_type,aviso:preciso?null:'Resultado aproximado. Confira o ponto no mapa antes de salvar.'};
}
const pool=require('../../config/db');
function endereco(i){return [i.logradouro,i.numero,i.bairro,i.cidade,i.uf,i.cep].filter(Boolean).join(', ');}
function campos(i){return [i.logradouro,i.numero,i.bairro,i.cidade,i.uf,i.cep];}
async function processarUm(){
 const job=(await pool.query(`UPDATE gl_geocode_jobs SET tentativas=tentativas+1,proxima_em=now()+interval '2 minutes'
  WHERE imovel_id=(SELECT imovel_id FROM gl_geocode_jobs WHERE status='PENDENTE' AND proxima_em<=now()
  ORDER BY proxima_em,imovel_id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`)).rows[0];
 if(!job)return false;
 const imovel=(await pool.query('SELECT * FROM imoveis WHERE id=$1 AND deleted_at IS NULL',[job.imovel_id])).rows[0];
 if(!imovel||(imovel.latitude!==null&&imovel.longitude!==null)){await pool.query("UPDATE gl_geocode_jobs SET status='CONCLUIDO' WHERE imovel_id=$1",[job.imovel_id]);return true;}
 try{
  const p=await buscar(endereco(imovel));
  const mesmoNumero=String(p.numero||'').replace(/\D/g,'')===String(imovel.numero||'').replace(/\D/g,'');
  if(p.preciso&&mesmoNumero){
   const r=await pool.query(`UPDATE imoveis SET latitude=$2,longitude=$3 WHERE id=$1 AND latitude IS NULL AND longitude IS NULL
    AND jsonb_build_array(logradouro,numero,bairro,cidade,uf,cep)=$4::jsonb RETURNING id`,[imovel.id,p.latitude,p.longitude,JSON.stringify(campos(imovel))]);
   await pool.query('UPDATE gl_geocode_jobs SET status=$2,candidato=$3,erro=$4 WHERE imovel_id=$1',[imovel.id,r.rowCount?'CONCLUIDO':'REVISAO',JSON.stringify(p),r.rowCount?null:'Cadastro alterado durante a busca. Confira o endereço.']);
  }else await pool.query("UPDATE gl_geocode_jobs SET status='REVISAO',candidato=$2,erro='Ponto ou número aproximado; confirme no cadastro.' WHERE imovel_id=$1",[imovel.id,JSON.stringify(p)]);
 }catch(e){await pool.query("UPDATE gl_geocode_jobs SET status=CASE WHEN tentativas>=3 THEN 'REVISAO' ELSE 'PENDENTE' END,proxima_em=now()+interval '15 minutes',erro=$2 WHERE imovel_id=$1",[imovel.id,e.status?e.message:'Falha temporária na geocodificação.']);}
 return true;
}
module.exports={buscar,processarUm,endereco,campos};
