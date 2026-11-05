const {test,before,after}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),jwt=require('jsonwebtoken'),bcrypt=require('bcryptjs');
const {PGlite}=require('@electric-sql/pglite');require('dotenv').config=()=>({parsed:{}});
process.env.OPERACAO_LEADS_ENABLED='true';process.env.INTEGRACOES_CRYPTO_KEY='b'.repeat(64);process.env.JWT_SECRET='teste-operacao';
process.env.APNS_TEAM_ID='TEST';process.env.APNS_KEY_ID='TEST';process.env.APNS_BUNDLE_ID='br.com.goldleste.mobile';process.env.APNS_KEY_PATH='somente-transporte-simulado';
const db=new PGlite();let tail=Promise.resolve();async function lock(){const prev=tail;let release;tail=new Promise(r=>release=r);await prev;return release;}
async function query(text,params){const r=await db.query(text,params);return {...r,rowCount:r.affectedRows??r.rows.length};}
const pool={async query(t,p){const release=await lock();try{return await query(t,p);}finally{release();}},async connect(){const release=await lock();return {query,release};}};
require.cache[require.resolve('../src/config/db')]={exports:pool};
const fila=require('../src/services/operacao/fila');const repo=require('../src/repositories/portal-leads.repository');const {cifrar}=require('../src/utils/crypto');
const {prazo,distanciaM}=require('../src/services/operacao/regras');
const ids=Array.from({length:10},(_,i)=>`00000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`);
const [admin,a,b,c,filial,outra]=ids;
const users={};let server,base;const realFetch=global.fetch;
async function http(route,usuario=admin,body,method){return realFetch(base+'/operacao'+route,{method:method||(body?'POST':'GET'),headers:{Authorization:'Bearer '+jwt.sign({id:usuario,sid:users[usuario]?.sessaoId},process.env.JWT_SECRET),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});}
const ponto={latitude:-23.55,longitude:-46.63,precisaoM:5};
async function inserirLead(extra={}){return repo.inserir({nome:'Contato teste',telefone:'11999999999',origem:'PORTAL',filial_id:filial,...extra});}
async function ativar(id){return fila.localizar(users[id],ponto,true);}
async function reset(){await pool.query('UPDATE gl_fila_membros SET ativo=false');await pool.query('UPDATE portal_leads SET prazo_em=NULL,operacao_gerenciada=false');}
before(async()=>{
 await db.exec(`CREATE FUNCTION uuid_generate_v4() RETURNS uuid LANGUAGE SQL AS 'SELECT gen_random_uuid()';
 CREATE TABLE filiais(id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),nome text,endereco text,telefone text,ativo boolean DEFAULT true,created_at timestamp DEFAULT now(),updated_at timestamp DEFAULT now());
 CREATE TABLE usuarios(id uuid PRIMARY KEY,nome text,email text,senha_hash text,perfil text,ativo boolean DEFAULT true,filial_id uuid,gerente_id uuid,ultimo_login timestamp,created_at timestamp DEFAULT now(),deve_trocar_senha boolean DEFAULT false);
 CREATE TABLE vendas(id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),corretor_id uuid,corretor_nome text,empreendimento_rua text,numero_unidade text,valor_imovel_venda numeric);`);
 const migrar=async file=>db.exec(fs.readFileSync(path.join(__dirname,'../sql',file),'utf8').replace(/CREATE EXTENSION IF NOT EXISTS "uuid-ossp";/g,''));
 await migrar('20260816_imoveis_portais.sql');await migrar('20260830_fila_leads.sql');await migrar('20261029_integracoes_seguras.sql');await migrar('20261030_operacao_mobile.sql');await migrar('20261030_operacao_mobile.sql');
 await pool.query("INSERT INTO filiais(id,nome,endereco,latitude,longitude) VALUES($1,'Matriz','Rua Teste, 10',-23.55,-46.63),($2,'Filial 2','Outra Rua',-23.55,-46.63)",[filial,outra]);
 const senha=await bcrypt.hash('senha-testes',4);
 for(const [id,nome,perfil,fid] of [[admin,'Admin','admin',filial],[a,'Corretor A','corretor',filial],[b,'Corretor B','corretor',filial],[c,'Corretor C','corretor',outra]]){
  await pool.query('INSERT INTO usuarios(id,nome,email,senha_hash,perfil,filial_id) VALUES($1,$2,$3,$4,$5,$6)',[id,nome,id+'@example.test',senha,perfil,fid]);
  const sid=(await pool.query("INSERT INTO gl_sessoes(usuario_id,expira_em) VALUES($1,now()+interval '1 day') RETURNING id",[id])).rows[0].id;
  users[id]={id,nome,perfil,filialId:fid,sessaoId:sid};
  await pool.query("INSERT INTO gl_dispositivos(usuario_id,sessao_id,token_cifrado,token_hash,ambiente) VALUES($1,$2,$3,$4,'sandbox')",[id,sid,cifrar({token:'a'.repeat(64)}),id]);
 }
 await pool.query('UPDATE gl_operacao_config SET filial_padrao_id=$1 WHERE id=1',[filial]);
 server=require('../src/app').listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base='http://127.0.0.1:'+server.address().port;
});
after(async()=>{global.fetch=realFetch;if(server)await new Promise(r=>server.close(r));await db.close();});
test('distância e prazos comerciais são calculados sem prazos para leads próprios ou vendidos',()=>{
 assert.equal(distanciaM(ponto,ponto),0);assert.ok(distanciaM(ponto,{latitude:-23.57,longitude:-46.63})>1000);
 const now=new Date('2026-10-30T12:00:00Z');assert.equal(prazo('NOVO',now).getTime()-now.getTime(),300000);
 assert.equal(prazo('EM_ATENDIMENTO',now).getTime()-now.getTime(),86400000);assert.equal(prazo('PROPOSTA_ENVIADA',now).getTime()-now.getTime(),432000000);
 assert.equal(prazo('NOVO',now,null,true),null);assert.equal(prazo('VENDA',now),null);assert.throws(()=>prazo('VISITA',now,'ontem'),/visita/);
});
test('fila exige sessão, permissão de notificação, raio, precisão e filial do usuário',async()=>{
 await reset();await assert.rejects(()=>fila.localizar({...users[a],sessaoId:null},ponto,true),/sessão/);
 await assert.rejects(()=>fila.localizar(users[a],{...ponto,precisaoM:500},true),/precisão/);
 await assert.rejects(()=>fila.localizar(users[a],{...ponto,latitude:-23.57},true),/raio/);
 await pool.query('UPDATE gl_dispositivos SET ativo=false WHERE usuario_id=$1',[a]);await assert.rejects(()=>ativar(a),/notificações/);
 await pool.query('UPDATE gl_dispositivos SET ativo=true WHERE usuario_id=$1',[a]);await ativar(a);assert.equal((await fila.estado(users[a])).minhaPosicao,1);
});
test('FIFO por filial: primeiro conectado recebe, novo vai para o final e recebimento rotaciona',async()=>{
 await reset();await ativar(a);await ativar(b);await ativar(c);
 const l1=await inserirLead(),l2=await inserirLead(),l3=await inserirLead();const r=await fila.distribuir();
 assert.deepEqual(r.filter(x=>[l1.id,l2.id,l3.id].includes(x.lead.id)).map(x=>x.corretor.id),[a,b,a]);
 const state=await fila.estado(users[a]);assert.deepEqual(state.fila.map(x=>x.usuarioId),[b,a]);
 assert.equal((await fila.estado(users[c])).fila.length,1);
 await fila.desativar(users[b]);await ativar(b);assert.deepEqual((await fila.estado(users[a])).fila.map(x=>x.usuarioId),[a,b]);
});
test('leitura expirada, sessão revogada e saída do raio tornam corretor inelegível',async()=>{
 await reset();await ativar(a);await pool.query("UPDATE gl_fila_membros SET localizado_em=now()-interval '16 minutes' WHERE usuario_id=$1",[a]);
 assert.equal((await fila.elegiveis()).length,0);await ativar(a);
 const r=await fila.localizar(users[a],{...ponto,latitude:-23.57});assert.equal(r.recebendo,false);assert.equal((await fila.elegiveis()).length,0);
 await ativar(a);await pool.query('UPDATE gl_sessoes SET revogada_em=now() WHERE id=$1',[users[a].sessaoId]);assert.equal((await fila.elegiveis()).length,0);
 await pool.query('UPDATE gl_sessoes SET revogada_em=NULL WHERE id=$1',[users[a].sessaoId]);
});
test('Novo vence em cinco minutos e vai ao próximo, sem reenviar ao corretor anterior',async()=>{
 await reset();await ativar(a);await ativar(b);const l=await inserirLead();await fila.distribuir();
 let row=(await pool.query('SELECT * FROM portal_leads WHERE id=$1',[l.id])).rows[0];assert.equal(row.responsavel_id,a);
 await pool.query("UPDATE portal_leads SET prazo_em=now()-interval '1 minute' WHERE id=$1",[l.id]);await fila.distribuir();
 row=(await pool.query('SELECT * FROM portal_leads WHERE id=$1',[l.id])).rows[0];assert.equal(row.responsavel_id,b);assert.equal(row.versao_atendimento,2);
 assert.equal((await pool.query('SELECT count(*)::int n FROM gl_lead_historico WHERE lead_id=$1',[l.id])).rows[0].n,3);
});
test('Em atendimento renova somente com histórico; proposta mantém o prazo de cinco dias',async()=>{
 await reset();await ativar(a);const l=await inserirLead();await fila.distribuir();const v=1;
 await fila.editar(l.id,{etapa:'EM_ATENDIMENTO',descricao:'Contato realizado',versao:v},users[a]);
 await pool.query("UPDATE portal_leads SET prazo_em=now()+interval '1 hour' WHERE id=$1",[l.id]);
 await fila.editar(l.id,{descricao:'Novo contato registrado',versao:v},users[a]);
 let row=(await pool.query('SELECT * FROM portal_leads WHERE id=$1',[l.id])).rows[0];assert.ok(new Date(row.prazo_em)-Date.now()>23*3600000);
 await assert.rejects(()=>fila.editar(l.id,{descricao:'',versao:v},users[a]),/histórico/);
 await fila.editar(l.id,{etapa:'PROPOSTA_ENVIADA',descricao:'Proposta enviada',versao:v},users[a]);
 const prazoOriginal=(await pool.query('SELECT prazo_em FROM portal_leads WHERE id=$1',[l.id])).rows[0].prazo_em;
 await fila.editar(l.id,{descricao:'Nota sem renovar proposta',versao:v},users[a]);
 assert.equal(String((await pool.query('SELECT prazo_em FROM portal_leads WHERE id=$1',[l.id])).rows[0].prazo_em),String(prazoOriginal));
});
test('Visita precisa de data futura; descarte exclui corretor permanentemente e mantém histórico',async()=>{
 await reset();await ativar(a);await ativar(b);const l=await inserirLead();await fila.distribuir();
 const futura=new Date(Date.now()+86400000).toISOString();await fila.editar(l.id,{etapa:'VISITA',visitaEm:futura,descricao:'Visita confirmada',versao:1},users[a]);
 assert.equal((await pool.query('SELECT etapa FROM portal_leads WHERE id=$1',[l.id])).rows[0].etapa,'VISITA');
 await fila.editar(l.id,{etapa:'DESCARTADO',descricao:'Cliente solicita outro atendimento',versao:1},users[a]);
 let row=(await pool.query('SELECT * FROM portal_leads WHERE id=$1',[l.id])).rows[0];assert.equal(row.responsavel_id,b);
 await pool.query("UPDATE portal_leads SET prazo_em=now()-interval '1 second' WHERE id=$1",[l.id]);await fila.distribuir();
 row=(await pool.query('SELECT * FROM portal_leads WHERE id=$1',[l.id])).rows[0];assert.equal(row.responsavel_id,null);
 assert.equal((await pool.query('SELECT usuario_id FROM gl_lead_exclusoes WHERE lead_id=$1',[l.id])).rows[0].usuario_id,a);
});
test('Venda e lead próprio não expiram nem mudam de dono',async()=>{
 await reset();await ativar(a);const proprio=await inserirLead({origem:'MANUAL',criado_por_id:a,posse_permanente:true});
 await pool.query("UPDATE portal_leads SET prazo_em=now()-interval '1 day' WHERE id=$1",[proprio.id]);await fila.distribuir();
 assert.equal((await pool.query('SELECT responsavel_id FROM portal_leads WHERE id=$1',[proprio.id])).rows[0].responsavel_id,a);
 const l=await inserirLead();await fila.distribuir();await fila.editar(l.id,{etapa:'VENDA',descricao:'Venda concluída',versao:1},users[a]);
 await pool.query("UPDATE portal_leads SET prazo_em=now()-interval '1 day' WHERE id=$1",[l.id]);await fila.distribuir();
 assert.equal((await pool.query('SELECT responsavel_id FROM portal_leads WHERE id=$1',[l.id])).rows[0].responsavel_id,a);
 await assert.rejects(()=>fila.editar(l.id,{etapa:'NOVO',descricao:'Reabrir',versao:1},users[a]),/permanente/);
});
test('tela manual é idempotente e corretor não acessa lead de outro; versões antigas são recusadas',async()=>{
 await reset();const chave=crypto.randomUUID();const r=await http('/leads',a,{nome:'Contato próprio',telefone:'11999999999',chave});assert.equal(r.status,201,await r.clone().text());
 const id=(await r.json()).id;assert.equal((await http('/leads',a,{nome:'Contato próprio',telefone:'11999999999',chave})).status,200);
 assert.equal((await http('/leads/'+id,b)).status,404);
 const l=await (await http('/leads/'+id,a)).json();assert.equal(l.posse_permanente,true);assert.equal(l.responsavel_id,a);
 assert.equal((await http('/leads/'+id,a,{etapa:'EM_ATENDIMENTO',descricao:'Contato',versao:99},'PATCH')).status,409);
});
test('integrações e site usam filial padrão; sem unidade configurada ficam pendentes sem cruzar filiais',async()=>{
 await reset();await ativar(a);const l=await inserirLead({filial_id:null});await fila.distribuir();assert.equal((await pool.query('SELECT filial_id FROM portal_leads WHERE id=$1',[l.id])).rows[0].filial_id,filial);
 await pool.query('UPDATE gl_operacao_config SET filial_padrao_id=NULL');const p=await inserirLead({filial_id:null});await fila.distribuir();assert.equal((await pool.query('SELECT responsavel_id FROM portal_leads WHERE id=$1',[p.id])).rows[0].responsavel_id,null);
 await pool.query('UPDATE gl_operacao_config SET filial_padrao_id=$1',[filial]);
});
test('push persistente cancela atribuição antiga e só aceita envio da versão atual',async()=>{
 await reset();await ativar(a);await ativar(b);const l=await inserirLead();await fila.distribuir();await pool.query("UPDATE portal_leads SET prazo_em=now()-interval '1 second' WHERE id=$1",[l.id]);await fila.distribuir();
 await pool.query('UPDATE gl_push_outbox SET cancelado_em=now() WHERE lead_id<>$1',[l.id]);
 const apns=require('../src/services/operacao/apns');let enviados=0;
 const transport=async(token,ambiente,payload)=>{assert.equal(token,'a'.repeat(64));assert.equal(payload.versao,2);enviados++;return {status:200};};
 while(await apns.processarUm(transport)){}
 assert.equal(enviados,1);const jobs=(await pool.query('SELECT * FROM gl_push_outbox WHERE lead_id=$1',[l.id])).rows;
 assert.equal(jobs.filter(j=>j.cancelado_em).length,1);assert.equal(jobs.filter(j=>j.enviado_em).length,1);
});
test('cadastro de venda gera evento atômico com foto e sem CPF ou dados do cliente',async()=>{
 await pool.query("UPDATE usuarios SET foto_url='https://example.test/foto.jpg' WHERE id=$1",[a]);
 await pool.query("INSERT INTO vendas(corretor_id,corretor_nome,empreendimento_rua,numero_unidade,valor_imovel_venda) VALUES($1,'Corretor A','Edifício Teste','10',500000)",[a]);
 const events=(await pool.query('SELECT * FROM gl_eventos')).rows;assert.equal(events.length,1);assert.equal(events[0].dados.fotoUrl,'https://example.test/foto.jpg');assert.equal(events[0].filial_id,filial);
 assert.equal(events[0].dados.valor,'500000');assert.equal(JSON.stringify(events[0].dados).includes('cpf'),false);
});
test('backlog sem elegíveis em outra filial não bloqueia os leads da unidade ativa',async()=>{
 await reset();await ativar(a);
 await pool.query(`INSERT INTO portal_leads(nome,origem,filial_id,operacao_gerenciada,recebido_em)
  SELECT 'Sem elegível','PORTAL',$1,true,now()-interval '1 day' FROM generate_series(1,120)`,[outra]);
 const l=await inserirLead();await fila.distribuir();assert.equal((await pool.query('SELECT responsavel_id FROM portal_leads WHERE id=$1',[l.id])).rows[0].responsavel_id,a);
});
test('ativação exige configuração APNs e token legado não pode entrar na fila geográfica',async()=>{
 await reset();const saved=process.env.APNS_KEY_ID;delete process.env.APNS_KEY_ID;await assert.rejects(()=>ativar(a),/APNs/);process.env.APNS_KEY_ID=saved;
 const r=await realFetch(base+'/operacao/fila/ativar',{method:'POST',headers:{Authorization:'Bearer '+jwt.sign({id:a},process.env.JWT_SECRET),'Content-Type':'application/json'},body:JSON.stringify(ponto)});
 assert.equal(r.status,403);
});
test('filial padrão e vínculo de usuário são administrativos e mudanças retiram o usuário da fila',async()=>{
 await reset();await ativar(a);assert.equal((await http('/configuracao',a,{filialPadraoId:outra},'PUT')).status,403);
 assert.equal((await http('/usuarios/'+a+'/filial',admin,{filialId:outra},'PUT')).status,200);
 assert.equal((await pool.query('SELECT ativo FROM gl_fila_membros WHERE usuario_id=$1',[a])).rows[0].ativo,false);
 await http('/usuarios/'+a+'/filial',admin,{filialId:filial},'PUT');
 assert.equal((await http('/configuracao',admin,{filialPadraoId:filial},'PUT')).status,200);
});
test('histórico de atendimento precisa respeitar o responsável e visita permanece até o fim do dia',async()=>{
 await reset();await ativar(a);const l=await inserirLead();await fila.distribuir();
 await assert.rejects(()=>fila.editar(l.id,{descricao:'Outro corretor',etapa:'EM_ATENDIMENTO',versao:1},users[b]),/permissão/);
 const futura=new Date(Date.now()+86400000).toISOString();await fila.editar(l.id,{etapa:'VISITA',visitaEm:futura,descricao:'Agendada',versao:1},users[a]);
 const row=(await pool.query('SELECT * FROM portal_leads WHERE id=$1',[l.id])).rows[0];
 assert.ok(new Date(row.prazo_em)>=new Date(row.visita_em));assert.equal(new Date(row.prazo_em).toISOString().slice(11),'02:59:59.999Z');
});
test('geocodificação aproximada vai para revisão, sem colocar imóvel no centro da rua',async()=>{
 await reset();process.env.GOOGLE_GEOCODING_API_KEY='chave-ficticia';
 const imovel=(await pool.query(`INSERT INTO imoveis(codigo,slug,titulo,logradouro,numero,bairro,cidade,uf,cep)
  VALUES('GEO1','geo1','Imóvel teste','Rua Teste','123','Centro','São Paulo','SP','03510000') RETURNING id`)).rows[0];
 await http('/imoveis/geocodificar-fila',admin,{});
 global.fetch=async()=>Response.json({status:'OK',results:[{formatted_address:'Rua Teste',partial_match:true,
  address_components:[],geometry:{location:{lat:-23.55,lng:-46.63},location_type:'GEOMETRIC_CENTER'}}]});
 try{await require('../src/services/operacao/geocoding').processarUm();}finally{global.fetch=realFetch;}
 const g=(await pool.query('SELECT * FROM gl_geocode_jobs WHERE imovel_id=$1',[imovel.id])).rows[0];assert.equal(g.status,'REVISAO');
 assert.equal((await pool.query('SELECT latitude FROM imoveis WHERE id=$1',[imovel.id])).rows[0].latitude,null);
 const r=await http('/imoveis/'+imovel.id+'/localizacao',admin,{latitude:-23.55,longitude:-46.63,confirmado:true},'PUT');assert.equal(r.status,200);
 assert.equal((await pool.query('SELECT status FROM gl_geocode_jobs WHERE imovel_id=$1',[imovel.id])).rows[0].status,'CONCLUIDO');
 delete process.env.GOOGLE_GEOCODING_API_KEY;
});
test('novo login revoga a sessão anterior e logout bloqueia acesso e recebimento',async()=>{
 const velho=jwt.sign({id:a,sid:users[a].sessaoId},process.env.JWT_SECRET);
 const r=await realFetch(base+'/operacao/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:a+'@example.test',senha:'senha-testes'})});
 assert.equal(r.status,200);const {token}=await r.json();
 assert.equal((await realFetch(base+'/operacao/estado',{headers:{Authorization:'Bearer '+velho}})).status,401);
 const logout=await realFetch(base+'/operacao/logout',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:'{}'});assert.equal(logout.status,200);
 assert.equal((await realFetch(base+'/operacao/estado',{headers:{Authorization:'Bearer '+token}})).status,401);
});
test('atalhos legados não atribuem lead operacional nem contornam a fila quando a flag é desligada',async()=>{
 await reset();const lead=await inserirLead();
 await assert.rejects(()=>require('../src/services/portal-lead-ingress.service').marcarPrimeiroAtendimento(lead.id,users[admin]),/fila/);
 process.env.OPERACAO_LEADS_ENABLED='false';
 try{
  await require('../src/services/lead-distribution.service').distribuirLead(lead.id);
  assert.equal((await pool.query('SELECT responsavel_id FROM portal_leads WHERE id=$1',[lead.id])).rows[0].responsavel_id,null);
  assert.equal((await require('../src/repositories/lead-queue.repository').leadsPendentes()).some(l=>l.id===lead.id),false);
 }finally{process.env.OPERACAO_LEADS_ENABLED='true';}
});
test('um token de dispositivo transferido para outro usuário não recebe a atribuição antiga',async()=>{
 await reset();await ativar(b);const lead=await inserirLead();await fila.distribuir();
 await pool.query('UPDATE gl_push_outbox SET cancelado_em=now() WHERE lead_id<>$1',[lead.id]);
 await pool.query('UPDATE gl_dispositivos SET usuario_id=$2,sessao_id=$3 WHERE usuario_id=$1',[b,c,users[c].sessaoId]);
 let envios=0;const apns=require('../src/services/operacao/apns');while(await apns.processarUm(async()=>{envios++;return {status:200};})){}
 assert.equal(envios,0);assert.ok((await pool.query('SELECT cancelado_em FROM gl_push_outbox WHERE lead_id=$1',[lead.id])).rows[0].cancelado_em);
});
test('HTTP de portal e formulário do site atribuem pela fila geográfica com a operação ligada',async()=>{
 await reset();await pool.query('UPDATE gl_dispositivos SET usuario_id=$1,sessao_id=$2 WHERE token_hash=$3',[b,users[b].sessaoId,b]);await ativar(b);
 const pid=(await pool.query("SELECT id FROM portais WHERE slug='grupo-olx'")).rows[0].id;const token='d'.repeat(48);
 await pool.query('INSERT INTO portal_integracoes(portal_id,habilitado,feed_token) VALUES($1,true,$2)',[pid,token]);
 const lead={leadOrigin:'Grupo OLX',originLeadId:'geo-http-olx',clientListingId:'REF-NAO-LOCALIZADA',name:'Lead integração geográfica',ddd:'11',phone:'999999999'};
 let r=await realFetch(base+'/public/leads/grupo-olx/'+token,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(lead)});assert.equal(r.status,201,await r.text());
 r=await realFetch(base+'/public/contato',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({nome:'Lead do formulário geográfico',telefone:'11999999999'})});assert.equal(r.status,201,await r.text());
 const rows=(await pool.query("SELECT * FROM portal_leads WHERE external_lead_id='geo-http-olx' OR nome='Lead do formulário geográfico'")).rows;
 assert.equal(rows.length,2);assert.ok(rows.every(l=>l.responsavel_id===b&&l.filial_id===filial&&l.operacao_gerenciada));
});
