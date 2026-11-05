const fila=require('./fila');const apns=require('./apns');const {ativo}=require('./entrada');
let filaOcupada=false,pushOcupado=false,geoOcupado=false;
async function rodadaFila(){if(filaOcupada||!ativo())return;filaOcupada=true;try{await fila.distribuir();}finally{filaOcupada=false;}}
async function rodadaPush(){if(pushOcupado||!ativo())return;pushOcupado=true;try{for(let i=0;i<5;i++)if(!await apns.processarUm())break;}finally{pushOcupado=false;}}
async function rodadaGeo(){if(geoOcupado||!ativo()||!process.env.GOOGLE_GEOCODING_API_KEY)return;geoOcupado=true;try{await require('./geocoding').processarUm();}finally{geoOcupado=false;}}
async function rodada(){await Promise.all([rodadaFila(),rodadaPush(),rodadaGeo()]);}
function iniciar(){if(!ativo())return;for(const work of [rodadaFila,rodadaPush,rodadaGeo]){const run=()=>work().catch(()=>console.error('[operacao] Falha no worker; dados mantidos para nova tentativa.'));run();const t=setInterval(run,15000);t.unref();}}
module.exports={rodada,iniciar};
