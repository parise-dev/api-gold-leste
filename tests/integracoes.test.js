const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const { PGlite } = require('@electric-sql/pglite');
require('dotenv').config = () => ({ parsed: {} });

// PostgreSQL embarcado em memória. Não lê .env nem abre conexão com banco real.
process.env.INTEGRACOES_CRYPTO_KEY = 'a'.repeat(64);
process.env.JWT_SECRET = 'segredo-exclusivo-dos-testes';
process.env.META_APP_ID = '123456';
process.env.META_APP_SECRET = 'meta-secret-de-teste';
process.env.META_WEBHOOK_VERIFY_TOKEN = 'webhook-test';
process.env.META_REDIRECT_URI = 'https://api.example.test/integracoes/meta/callback';
process.env.FRONTEND_URL = 'https://painel.example.test';
process.env.PUBLIC_API_URL = 'https://api.example.test';
process.env.LEAD_DISTRIBUICAO_ESTRATEGIA = 'IMOVEL';
process.env.META_LEADS_WORKER_ENABLED = 'false';
process.env.OPERACAO_LEADS_ENABLED = 'false';
const db = new PGlite();
// O PGlite usa uma conexão. Adaptador serializa transações como o pool pg.
let tail = Promise.resolve();
async function acquire() {
  const anterior = tail;
  let release;
  tail = new Promise(resolve => { release = resolve; });
  await anterior;
  return release;
}
async function query(text, values) {
  const r = await db.query(text, values);
  return { ...r, rowCount: r.affectedRows ?? r.rows.length };
}
const pool = {
  async query(text, values) { const release = await acquire(); try { return await query(text, values); } finally { release(); } },
  async connect() { const release = await acquire(); return { query, release }; }
};
require.cache[require.resolve('../src/config/db')] = { id: require.resolve('../src/config/db'), filename: require.resolve('../src/config/db'), loaded: true, exports: pool };
const safety = require('../src/services/feed-safety.service');
const portais = require('../src/services/portais.service');
const ingress = require('../src/services/portal-lead-ingress.service');
const meta = require('../src/services/meta.service');
const metaLeads = require('../src/services/meta-leads.service');
const graph = require('../src/integrations/meta/graph');
const { cifrar } = require('../src/utils/crypto');
const adminId = '00000000-0000-4000-8000-000000000001';
const propertyId = '00000000-0000-4000-8000-000000000002';
const usuario = { id: adminId, perfil: 'admin' };
const tokenFeed = 'a'.repeat(48);
let portalId, server, base;
const realFetch = global.fetch;
let graphHandler;
function migration(name) {
  return fs.readFileSync(path.join(__dirname, '../sql', name), 'utf8').replace(/CREATE EXTENSION IF NOT EXISTS "uuid-ossp";/g, '');
}
async function http(url, options = {}) {
  return realFetch(base + url, { ...options, headers: { Authorization: `Bearer ${jwt.sign({ id: adminId }, process.env.JWT_SECRET)}`, ...options.headers } });
}
const officialLead = { leadOrigin: 'Grupo OLX', originLeadId: 'lead-olx-01', clientListingId: 'KENLO-123', originListingId: '999', name: 'Pessoa Teste', email: 'lead@example.test', ddd: '11', phone: '999999999', message: 'Tenho interesse' };

before(async () => {
  await db.exec(`CREATE FUNCTION uuid_generate_v4() RETURNS uuid LANGUAGE SQL AS 'SELECT gen_random_uuid()';
    CREATE TABLE filiais(id uuid PRIMARY KEY, nome text);
    CREATE TABLE usuarios(id uuid PRIMARY KEY, nome text, email text, perfil text, ativo boolean DEFAULT true, filial_id uuid, gerente_id uuid, ultimo_login timestamp, created_at timestamp DEFAULT now());
    CREATE TABLE vendas(id uuid PRIMARY KEY);
    INSERT INTO usuarios(id,nome,email,perfil) VALUES('${adminId}','Admin','admin@example.test','admin');`);
  await db.exec(migration('20260816_imoveis_portais.sql'));
  portalId = (await pool.query("SELECT id FROM portais WHERE slug='grupo-olx'")).rows[0].id;
  await pool.query(`INSERT INTO portal_integracoes(portal_id,habilitado,feed_habilitado,feed_token,contato_nome,contato_email,contato_telefone)
    VALUES($1,true,true,$2,'Gold Teste','contato@example.test','11999999999')`, [portalId, tokenFeed]);
  await pool.query(`INSERT INTO imoveis(id,codigo,slug,titulo,descricao,finalidade,tipo,valor_venda,area_util,cidade,uf,bairro,cep)
    VALUES($1,'GL001','apartamento-teste','Apartamento de teste bem localizado',$2,'VENDA','APARTAMENTO',500000,80,'São Paulo','SP','Vila Teste','03510000')`, [propertyId, 'Apartamento de teste com dois dormitórios e uma vaga, próximo ao metrô e comércio.']);
  await pool.query("INSERT INTO imovel_portais(imovel_id,portal_id,habilitado,status) VALUES($1,$2,true,'AGUARDANDO')", [propertyId,portalId]);
  for (let i=0;i<5;i++) await pool.query(`INSERT INTO imovel_midias(imovel_id,bucket,object_key,url,ordem,capa)
    VALUES($1,'teste',$2,$3,$4,$5)`, [propertyId,`foto-${i}`,`https://images.example.test/${i}.jpg`,i,i===0]);
  global.fetch = async (url, options) => {
    if (new URL(url).hostname !== 'graph.facebook.com') throw new Error('Rede externa bloqueada no teste');
    return graphHandler(url, options);
  };
  const app = require('../src/app');
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { global.fetch = realFetch; if(server) await new Promise(resolve=>server.close(resolve)); await db.close(); });

test('feed legado funciona antes da nova migração e recusa XML parcial sem marcar anúncios publicados', async () => {
  const resultado=await portais.gerarFeed({portalSlug:'grupo-olx',token:tokenFeed});
  assert.equal(resultado.totalAnuncios,1);
  assert.match(resultado.conteudo,/<ListingID>GL001/);
  assert.equal((await pool.query('SELECT status FROM imovel_portais')).rows[0].status,'AGUARDANDO');
  await pool.query("UPDATE imoveis SET titulo='x' WHERE id=$1",[propertyId]);
  await assert.rejects(()=>portais.gerarFeed({portalSlug:'grupo-olx',token:tokenFeed}),e=>e.status===503);
  await pool.query("UPDATE imoveis SET titulo='Apartamento de teste bem localizado' WHERE id=$1",[propertyId]);
});

test('migração aditiva repetível preserva imóveis, seleções, token e status', async () => {
  const antes = (await pool.query('SELECT * FROM imoveis')).rows;
  const selecoes = (await pool.query('SELECT * FROM imovel_portais')).rows;
  await db.exec(migration('20261029_integracoes_seguras.sql'));
  await db.exec(migration('20261029_integracoes_seguras.sql'));
  assert.deepEqual((await pool.query('SELECT * FROM imoveis')).rows, antes);
  const depois = (await pool.query('SELECT * FROM imovel_portais')).rows[0];
  assert.equal(depois.status, selecoes[0].status);
  assert.equal(depois.habilitado, true);
  assert.equal((await pool.query('SELECT feed_token FROM portal_integracoes')).rows[0].feed_token, tokenFeed);
});

test('mapear ListingID original, gerar prévia e baixar XML não publica nem muda a carteira', async () => {
  const r = await http(`/integracoes/portais/${portalId}/feed/codigos`, { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({itens:[{imovelId:propertyId,listingId:'KENLO-123'}]}) });
  assert.equal(r.status,200,await r.text());
  const previa = await safety.previa(portalId);
  assert.equal(previa.totalAnuncios,1);
  assert.match(previa.xml,/<ListingID>KENLO-123<\/ListingID>/);
  assert.match(previa.xml,/<Country abbreviation="BR">Brasil/);
  assert.equal((await pool.query('SELECT status FROM imovel_portais')).rows[0].status,'AGUARDANDO');
  await assert.rejects(()=>safety.aprovar(portalId,{hash:previa.hash},usuario), /inventário/);
  await assert.rejects(()=>safety.aprovar(portalId,{hash:previa.hash,inventarioConferido:true,idsAtuais:['CODIGO-AUSENTE']},usuario), /ausentes/);
});

test('aprovação detecta carteira alterada e preserva todos os códigos existentes', async () => {
  const previa = await safety.previa(portalId);
  await pool.query("UPDATE imoveis SET titulo='Apartamento com título atualizado' WHERE id=$1", [propertyId]);
  await assert.rejects(()=>safety.aprovar(portalId,{hash:previa.hash,inventarioConferido:true,idsAtuais:['KENLO-123']},usuario), /carteira mudou/);
  const nova = await safety.previa(portalId);
  await safety.aprovar(portalId,{hash:nova.hash,inventarioConferido:true,idsAtuais:['KENLO-123']},usuario);
  const feed = await portais.gerarFeed({portalSlug:'grupo-olx',token:tokenFeed});
  assert.match(feed.conteudo,/<ListingID>KENLO-123/);
  assert.equal((await pool.query('SELECT status FROM imovel_portais')).rows[0].status,'AGUARDANDO');
});

test('versão aprovada continua disponível após invalidação, exclusão ou desmarcação do imóvel', async () => {
  const antes = await portais.gerarFeed({portalSlug:'grupo-olx',token:tokenFeed});
  await pool.query("UPDATE imoveis SET titulo='x' WHERE id=$1",[propertyId]);
  let previa = await safety.previa(portalId);
  assert.equal(previa.rejeitados.length,1);
  await assert.rejects(()=>safety.aprovar(portalId,{hash:previa.hash},usuario),/inválido/);
  await pool.query('UPDATE imovel_portais SET habilitado=false WHERE imovel_id=$1',[propertyId]);
  await pool.query('UPDATE imoveis SET deleted_at=now() WHERE id=$1',[propertyId]);
  previa = await safety.previa(portalId);
  assert.deepEqual(previa.removidos,['KENLO-123']);
  const r=await http(`/public/feeds/grupo-olx/${tokenFeed}.xml`);
  assert.equal(r.status,200); assert.equal(await r.text(),antes.conteudo);
  assert.equal((await pool.query('SELECT count(*)::int n FROM portal_feed_versoes')).rows[0].n,1);
  await assert.rejects(()=>portais.salvarConfiguracao({portalId,body:{regenerarToken:true},usuario}),/protegido/);
  await pool.query("UPDATE imoveis SET titulo='Apartamento com título atualizado',deleted_at=NULL WHERE id=$1",[propertyId]);
  await pool.query('UPDATE imovel_portais SET habilitado=true WHERE imovel_id=$1',[propertyId]);
});

test('webhook OLX reconhece payload oficial, código original e DDD; retries simultâneos não duplicam', async () => {
  const post=()=>http(`/public/leads/grupo-olx/${tokenFeed}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(officialLead)});
  const responses=await Promise.all([post(),post(),post(),post()]);
  assert.equal(responses.filter(r=>r.status===201).length,1);
  assert.equal(responses.filter(r=>r.status===200).length,3);
  const rows=(await pool.query("SELECT * FROM portal_leads WHERE external_lead_id='lead-olx-01'")).rows;
  assert.equal(rows.length,1); assert.equal(rows[0].imovel_id,propertyId); assert.equal(rows[0].telefone,'11999999999');
  assert.equal(rows[0].external_listing_id,'KENLO-123');
});

test('OLX rejeita anúncio sem código e aceita MCMV sem imóvel, preservando o contrato genérico', async () => {
  const post=body=>http(`/public/leads/grupo-olx/${tokenFeed}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await post({...officialLead,originLeadId:'invalid',clientListingId:undefined})).status,400);
  const r=await post({...officialLead,originLeadId:'mcmv-01',leadOrigin:'MCMV_OLX',clientListingId:undefined});
  assert.equal(r.status,201,await r.text());
  assert.equal((await pool.query("SELECT erro_processamento FROM portal_leads WHERE external_lead_id='mcmv-01'")).rows[0].erro_processamento,null);
  assert.equal((await post({externalLeadId:'legacy-01',externalListingId:'GL001',nome:'Legado',telefone:'11999999999'})).status,201);
});

test('segredos e APIs de gestão exigem autenticação e administrador', async () => {
  const r=await realFetch(base+'/integracoes/meta/status'); assert.equal(r.status,401);
  const id='00000000-0000-4000-8000-000000000003';
  await pool.query("INSERT INTO usuarios(id,nome,perfil) VALUES($1,'Corretor','corretor')",[id]);
  const resp=await realFetch(base+'/integracoes/meta/status',{headers:{Authorization:`Bearer ${jwt.sign({id},process.env.JWT_SECRET)}`}});
  assert.equal(resp.status,403);
  const status=await (await http('/integracoes/meta/status')).json();
  assert.equal(status.appConfigurado,true);
  assert.equal(JSON.stringify(status).includes(process.env.META_APP_SECRET),false);
});

test('OAuth usa estado único, troca token no backend e não expõe credenciais ao frontend', async () => {
  graphHandler=async(url)=>{
    const u=new URL(url);
    if(u.pathname.endsWith('/oauth/access_token')) return Response.json({access_token:'secret-meta-token',expires_in:3600});
    if(u.pathname.endsWith('/permissions')) return Response.json({data:meta.diagnostico().permissoes.map(permission=>({permission,status:'granted'}))});
    return Response.json({id:'1001',name:'Pessoa Administradora'});
  };
  const inicio=await meta.iniciarOAuth(usuario); const state=new URL(inicio.url).searchParams.get('state');
  assert.equal(new URL(inicio.url).hostname,'www.facebook.com');
  await meta.callback({state,code:'code-test'});
  await assert.rejects(()=>meta.callback({state,code:'code-test'}),/expirada/);
  const stored=(await pool.query('SELECT token_cifrado FROM meta_conexoes')).rows[0].token_cifrado;
  assert.equal(stored.includes('secret-meta-token'),false);
  const status=await meta.status(); assert.equal(status.conectado,true); assert.equal(JSON.stringify(status).includes('secret-meta-token'),false);
});

test('paginação Meta recupera todas as páginas sem seguir URL/token externo', async () => {
  const urls=[];
  graphHandler=async(url,options)=>{ urls.push(url.href); assert.equal(options.headers.Authorization,'Bearer token');
    return Response.json(url.searchParams.has('after')?{data:[{id:'2'}]}:{data:[{id:'1'}],paging:{next:'https://evil.example/?access_token=secret',cursors:{after:'cursor-2'}}}); };
  const r=await graph.listar('me/businesses','token'); assert.deepEqual(r.map(x=>x.id),['1','2']);
  assert.equal(urls.every(u=>new URL(u).hostname==='graph.facebook.com'),true);
});

test('campanha nasce pausada com categoria Moradia e criação idempotente', async () => {
  const posts=[];
  graphHandler=async(url,options)=>{
    if(url.pathname.endsWith('/adaccounts')) return Response.json({data:[{id:'act_123',name:'Conta',currency:'BRL'}]});
    posts.push(Object.fromEntries(options.body)); return Response.json({id:'9001'});
  };
  const body={nome:'Campanha de teste',orcamentoCentavos:2000,chave:crypto.randomUUID()};
  const r=await meta.criarCampanha('act_123',body,usuario);
  assert.equal(r.id,'9001'); await meta.criarCampanha('act_123',body,usuario);
  assert.equal(posts.length,1); assert.equal(posts[0].status,'PAUSED'); assert.equal(posts[0].daily_budget,'2000');
  assert.equal(posts[0].special_ad_categories,'["HOUSING"]');
  await assert.rejects(()=>meta.criarCampanha('act_999',body,usuario),/fora da conexão/);
  await assert.rejects(()=>meta.criarCampanha('act_123',{...body,orcamentoCentavos:-5},usuario),/Orçamento/);
});

test('POST de campanha com resultado incerto não é reenviado automaticamente', async () => {
  let posts=0;
  graphHandler=async(url)=>{ if(url.pathname.endsWith('/adaccounts')) return Response.json({data:[{id:'act_123',currency:'BRL'}]}); posts++; throw new Error('timeout'); };
  const body={nome:'Timeout',orcamentoCentavos:1000,chave:crypto.randomUUID()};
  await assert.rejects(()=>meta.criarCampanha('act_123',body,usuario),/tempo esgotado/);
  await assert.rejects(()=>meta.criarCampanha('act_123',body,usuario),/resultado incerto/);
  assert.equal(posts,1);
});

test('webhook Meta valida assinatura e persiste antes do aceite; worker retenta e centraliza leads', async () => {
  await pool.query('INSERT INTO meta_paginas(id,nome,token_cifrado) VALUES($1,$2,$3)',['5001','Página',cifrar({access_token:'page-token'})]);
  const body={object:'page',entry:[{id:'5001',changes:[{field:'leadgen',value:{page_id:'5001',leadgen_id:'6001',form_id:'7001'}}]}]};
  const raw=JSON.stringify(body); const signature='sha256='+crypto.createHmac('sha256',process.env.META_APP_SECRET).update(raw).digest('hex');
  const post=sig=>http('/integracoes/meta/webhook',{method:'POST',headers:{'Content-Type':'application/json','X-Hub-Signature-256':sig},body:raw});
  assert.equal((await post('sha256='+'0'.repeat(64))).status,401);
  assert.equal((await pool.query('SELECT count(*)::int n FROM meta_lead_eventos')).rows[0].n,0);
  assert.equal((await post(signature)).status,200); assert.equal((await post(signature)).status,200);
  assert.equal((await pool.query('SELECT count(*)::int n FROM meta_lead_eventos')).rows[0].n,1);
  graphHandler=async()=>Response.json({error:{code:190}},{status:401});
  await metaLeads.processarUm();
  let evento=(await pool.query('SELECT * FROM meta_lead_eventos')).rows[0]; assert.equal(evento.concluido_em,null); assert.equal(evento.tentativas,1);
  await pool.query('UPDATE meta_lead_eventos SET proxima_tentativa=now()');
  graphHandler=async()=>Response.json({id:'6001',field_data:[{name:'full_name',values:['Contato Facebook']},{name:'email',values:['fb@example.test']},{name:'phone_number',values:['+5511999999999']}],campaign_id:'9001',campaign_name:'Imóveis',form_id:'7001',platform:'instagram'});
  await metaLeads.processarUm();
  evento=(await pool.query('SELECT * FROM meta_lead_eventos')).rows[0]; assert.ok(evento.concluido_em);
  const leads=await (await http('/integracoes/leads?portal=facebook')).json();
  assert.equal(leads.total,1); assert.equal(leads.items[0].portalSlug,'facebook'); assert.equal(leads.items[0].nome,'Contato Facebook');
  assert.equal(leads.items[0].utmCampaign,'Imóveis');
  assert.equal(leads.items[0].erroProcessamento,null);
});

test('Grupo OLX valida Basic Auth quando a chave oficial está configurada', async () => {
  const { autorizado } = require('../src/integrations/portals/grupo-olx/webhook-auth');
  assert.equal(autorizado(undefined,'segredo'),false);
  assert.equal(autorizado('Basic '+Buffer.from('vivareal:errado').toString('base64'),'segredo'),false);
  assert.equal(autorizado('Basic '+Buffer.from('vivareal:segredo').toString('base64'),'segredo'),true);
  process.env.GRUPO_OLX_WEBHOOK_SECRET_KEY='segredo';
  try {
    const body=JSON.stringify({...officialLead,originLeadId:'basic-lead'});
    let r=await http(`/public/leads/grupo-olx/${tokenFeed}`,{method:'POST',headers:{'Content-Type':'application/json'},body});
    assert.equal(r.status,401);
    r=await http(`/public/leads/grupo-olx/${tokenFeed}`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Basic '+Buffer.from('vivareal:segredo').toString('base64')},body});
    assert.equal(r.status,201);
  } finally { delete process.env.GRUPO_OLX_WEBHOOK_SECRET_KEY; }
});

test('negócios carregam contas próprias e de clientes sem duplicação e recusam BM alheio', async () => {
  graphHandler=async(url)=>{
    if(url.pathname.endsWith('/businesses')) return Response.json({data:[{id:'8001',name:'BM de teste'}]});
    if(url.pathname.endsWith('/owned_ad_accounts')) return Response.json({data:[{id:'act_123',name:'Própria'}]});
    return Response.json({data:[{id:'act_123',name:'Própria'},{id:'act_124',name:'Cliente'}]});
  };
  assert.equal((await meta.negocios())[0].name,'BM de teste');
  assert.equal((await meta.contas('8001')).length,2);
  await assert.rejects(()=>meta.contas('8002'),/BM fora/);
});

test('assinatura de página guarda token cifrado; recuperação de formulários é idempotente', async () => {
  graphHandler=async(url,options)=>{
    if(url.pathname.endsWith('/accounts')) return Response.json({data:[{id:'5002',name:'Outra página',access_token:'another-page-token'}]});
    if(url.pathname.endsWith('/subscribed_apps')) { assert.equal(options.body.get('subscribed_fields'),'leadgen'); return Response.json({success:true}); }
    if(url.pathname.endsWith('/leadgen_forms')) return Response.json({data:[{id:'7002',name:'Formulário'}]});
    if(url.pathname.endsWith('/leads')) return Response.json({data:[{id:'6002'},{id:'6003'}]});
    throw new Error('Recurso não esperado no teste');
  };
  await meta.assinarPagina('5002');
  const page=(await pool.query("SELECT * FROM meta_paginas WHERE id='5002'")).rows[0];
  assert.equal(page.inscrita,true); assert.equal(page.token_cifrado.includes('another-page-token'),false);
  const res=await meta.recuperarLeads('5002','7002'); assert.equal(res.enfileirados,2);
  assert.equal((await meta.recuperarLeads('5002','7002')).enfileirados,0);
  await assert.rejects(()=>meta.recuperarLeads('5002','7003'),/fora da página/);
});

test('consulta de custos valida datas e alterações exigem campanha pertencente à conta', async () => {
  let posts=0;
  graphHandler=async(url,options)=>{
    if(options.method==='POST') { posts++; return Response.json({success:true}); }
    if(url.pathname.endsWith('/adaccounts')) return Response.json({data:[{id:'act_123',currency:'BRL'}]});
    if(url.pathname.endsWith('/insights')) return Response.json({data:[{campaign_id:'9001',spend:'12.34'}]});
    return Response.json({data:[{id:'9001',name:'Campanha',daily_budget:'2000'},{id:'9002',name:'ABO'}]});
  };
  assert.equal((await meta.custos('act_123','2026-10-01','2026-10-29'))[0].spend,'12.34');
  await assert.rejects(()=>meta.custos('act_123','2026-02-30','2026-10-29'),/Período inválido/);
  await assert.rejects(()=>meta.editarCampanha('act_123','9001',{status:'ACTIVE',chave:crypto.randomUUID()},usuario),/Confirme/);
  await assert.rejects(()=>meta.editarCampanha('act_123','9005',{status:'PAUSED',chave:crypto.randomUUID()},usuario),/fora da conta/);
  await assert.rejects(()=>meta.editarCampanha('act_123','9002',{orcamentoCentavos:2000,chave:crypto.randomUUID()},usuario),/conjuntos/);
  assert.equal(posts,0);
  await meta.editarCampanha('act_123','9001',{orcamentoCentavos:3000,chave:crypto.randomUUID()},usuario);
  await meta.editarCampanha('act_123','9001',{status:'ACTIVE',confirmarGasto:true,chave:crypto.randomUUID()},usuario);
  assert.equal(posts,2);
});

test('webhook verifica challenge e rejeita JSON incorreto ou página desconhecida sem confirmar aceite', async () => {
  const r=await realFetch(base+'/integracoes/meta/webhook?hub.mode=subscribe&hub.verify_token=webhook-test&hub.challenge=123');
  assert.equal(r.status,200); assert.equal(await r.text(),'123');
  assert.equal((await realFetch(base+'/integracoes/meta/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=123')).status,403);
  const raw=JSON.stringify({object:'page',entry:[{id:'99999',changes:[{field:'leadgen',value:{page_id:'99999',leadgen_id:'99998'}}]}]});
  const signature='sha256='+crypto.createHmac('sha256',process.env.META_APP_SECRET).update(raw).digest('hex');
  assert.equal((await http('/integracoes/meta/webhook',{method:'POST',headers:{'Content-Type':'application/json','X-Hub-Signature-256':signature},body:raw})).status,403);
  assert.equal((await pool.query("SELECT count(*)::int n FROM meta_lead_eventos WHERE lead_id='99998'")).rows[0].n,0);
  assert.equal((await http('/integracoes/meta/webhook',{method:'POST',headers:{'Content-Type':'application/json'},body:'{'})).status,400);
});

test('leads Meta entram no mesmo rodízio dos portais quando a fila está habilitada', async () => {
  await db.exec(migration('20260830_fila_leads.sql'));
  const config=require('../src/config/lead-distribution.config');
  const repo=require('../src/repositories/lead-queue.repository');
  const corretorId='00000000-0000-4000-8000-000000000003';
  await pool.query('UPDATE usuarios SET ultima_atividade_em=now() WHERE id=$1',[corretorId]);
  repo.reavaliarDisponibilidade();
  config.ESTRATEGIA='FILA';
  try {
    const r=await ingress.registrarLeadDePortal({portalSlug:'facebook',body:{externalLeadId:'fila-meta',nome:'Teste Fila',email:'fila@example.test',contatoGeral:true},req:{headers:{},ip:null}});
    assert.equal(r.lead.responsavel_id,corretorId);
    assert.equal(r.lead.distribuicao_tipo,'AUTOMATICA');
    const retry=await ingress.registrarLeadDePortal({portalSlug:'facebook',body:{externalLeadId:'fila-meta',nome:'Teste Fila',email:'fila@example.test',contatoGeral:true},req:{headers:{},ip:null}});
    assert.equal(retry.duplicado,true); assert.equal(retry.lead.responsavel_id,corretorId);
  } finally { config.ESTRATEGIA='IMOVEL'; }
});
