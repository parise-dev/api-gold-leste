const { badRequest } = require('../../utils/http-error');
const ETAPAS=['NOVO','EM_ATENDIMENTO','VISITA','DESCARTADO','PROPOSTA_ENVIADA','VENDA'];
function distanciaM(a,b) {
  const r = n => n*Math.PI/180;
  const dlat=r(b.latitude-a.latitude),dlon=r(b.longitude-a.longitude);
  const h=Math.sin(dlat/2)**2+Math.cos(r(a.latitude))*Math.cos(r(b.latitude))*Math.sin(dlon/2)**2;
  return 6371000*2*Math.atan2(Math.sqrt(h),Math.sqrt(Math.max(0,1-h)));
}
function coordenadas(body) {
  const {latitude,longitude,precisaoM}=body;
  if (![latitude,longitude,precisaoM].every(n=>typeof n==='number'&&Number.isFinite(n)) ||
      Math.abs(latitude)>90 || Math.abs(longitude)>180 || precisaoM<0 || precisaoM>100) throw badRequest('Localização inválida ou precisão acima de 100 metros. Tente obter uma leitura melhor.');
  return {latitude,longitude,precisaoM};
}
function prazo(etapa, agora, visita, permanente=false) {
  if(!ETAPAS.includes(etapa)) throw badRequest('Etapa inválida.');
  if(etapa==='VISITA' && (!visita || !/T.*(Z|[+-]\d\d:\d\d)$/.test(String(visita)) || !Number.isFinite(Date.parse(visita)) || Date.parse(visita)<=agora.getTime())) throw badRequest('Informe data/hora futura da visita com fuso horário.');
  if(permanente || etapa==='VENDA' || etapa==='DESCARTADO') return null;
  const ms={NOVO:300000,EM_ATENDIMENTO:86400000,PROPOSTA_ENVIADA:5*86400000};
  if(etapa==='VISITA') {
    const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(visita));
    const v=tipo=>parts.find(p=>p.type===tipo).value;
    return new Date(`${v('year')}-${v('month')}-${v('day')}T23:59:59.999-03:00`);
  }
  return new Date(agora.getTime()+ms[etapa]);
}
module.exports={ETAPAS,distanciaM,coordenadas,prazo};
