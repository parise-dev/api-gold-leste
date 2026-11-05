const express=require('express'),bcrypt=require('bcryptjs'),jwt=require('jsonwebtoken'),crypto=require('crypto');
const pool=require('../config/db');const {authMiddleware,somentePerfis}=require('../middlewares/auth.middleware');
const {asyncHandler:a}=require('../utils/async-handler');const {badRequest,forbidden,notFound}=require('../utils/http-error');
const {exigirUuid,emailOuNulo,telefoneOuNulo}=require('../validators/imovel.validator');const {limparTexto}=require('../utils/sanitize');
const {cifrar}=require('../utils/crypto');const fila=require('../services/operacao/fila');const leadsRepo=require('../repositories/portal-leads.repository');
const rateLimit=require('express-rate-limit');const router=express.Router();
router.post('/login',rateLimit({windowMs:600000,limit:20}),a(async(req,res)=>{
 fila.exigirAtivo();const email=String(req.body.email||'').trim().toLowerCase(),senha=req.body.senha;
 const u=(await pool.query('SELECT * FROM usuarios WHERE lower(email)=$1 LIMIT 1',[email])).rows[0];
 if(!u?.ativo||typeof senha!=='string'||!await bcrypt.compare(senha,u.senha_hash))return res.status(401).json({message:'E-mail ou senha inválidos.'});
 if(u.deve_trocar_senha)return res.status(403).json({message:'Atualize sua senha de primeiro acesso no painel web antes de usar o aplicativo.'});
 if(u.perfil==='corretor'&&!u.filial_id)throw badRequest('Peça ao administrador para vincular seu usuário a uma filial.');
 const sid=await fila.transacao(async c=>{
  await c.query('UPDATE gl_sessoes SET revogada_em=now() WHERE usuario_id=$1 AND revogada_em IS NULL',[u.id]);
  await c.query('UPDATE gl_fila_membros SET ativo=false WHERE usuario_id=$1',[u.id]);
  return (await c.query("INSERT INTO gl_sessoes(usuario_id,expira_em) VALUES($1,now()+interval '30 days') RETURNING id",[u.id])).rows[0].id;
 });
 res.json({token:jwt.sign({id:u.id,sid},process.env.JWT_SECRET,{expiresIn:'30d'}),usuario:{id:u.id,nome:u.nome,email:u.email,perfil:u.perfil,filialId:u.filial_id,fotoUrl:u.foto_url}});
}));
router.use(authMiddleware);
router.get('/capacidades',(req,res)=>res.json({habilitado:require('../services/operacao/entrada').ativo()}));
router.use((req,res,next)=>{res.setHeader('Cache-Control','no-store');next();});
router.get('/estado',a(async(req,res)=>{
 fila.exigirAtivo();const u=(await pool.query('SELECT foto_url FROM usuarios WHERE id=$1',[req.user.id])).rows[0];
 const f=req.user.filialId?(await pool.query('SELECT id,nome,endereco,latitude,longitude FROM filiais WHERE id=$1',[req.user.filialId])).rows[0]:null;
 const membro=(await pool.query('SELECT ativo,localizado_em FROM gl_fila_membros WHERE usuario_id=$1',[req.user.id])).rows[0];
 res.json({usuario:{...req.user,fotoUrl:u.foto_url},filial:f||null,membro:membro||null,apnsConfigurado:require('../services/operacao/apns').configurado(),fila:await fila.estado(req.user)});
}));
router.post('/logout',a(async(req,res)=>{
 if(req.user.sessaoId){await pool.query('UPDATE gl_sessoes SET revogada_em=now() WHERE id=$1',[req.user.sessaoId]);await pool.query('UPDATE gl_dispositivos SET ativo=false WHERE sessao_id=$1',[req.user.sessaoId]);}
 await fila.desativar(req.user);res.json({ok:true});
}));
router.post('/dispositivo',a(async(req,res)=>{
 fila.exigirAtivo();if(!req.user.sessaoId)throw forbidden('Use o login do aplicativo.');
 const {token,permissao}=req.body;const ambiente=process.env.APNS_ENVIRONMENT||'sandbox';
 if(permissao!==true||!/^([a-f0-9]{2}){16,128}$/i.test(String(token||'')))throw badRequest('Permissão ou token nativo APNs inválido.');
 await pool.query(`INSERT INTO gl_dispositivos(usuario_id,sessao_id,token_cifrado,token_hash,ambiente)
  VALUES($1,$2,$3,$4,$5) ON CONFLICT(token_hash) DO UPDATE SET usuario_id=excluded.usuario_id,sessao_id=excluded.sessao_id,
  token_cifrado=excluded.token_cifrado,ambiente=excluded.ambiente,ativo=true,atualizado_em=now()`,
  [req.user.id,req.user.sessaoId,cifrar({token}),crypto.createHash('sha256').update(token).digest('hex'),ambiente]);
 res.json({ok:true});
}));
router.post('/dispositivo/desativar',a(async(req,res)=>{
 await pool.query('UPDATE gl_dispositivos SET ativo=false WHERE sessao_id=$1',[req.user.sessaoId]);await fila.desativar(req.user);res.json({ok:true});
}));
router.post('/localizacao',a(async(req,res)=>res.json(await fila.localizar(req.user,req.body))));
router.post('/fila/ativar',a(async(req,res)=>res.json(await fila.localizar(req.user,req.body,true))));
router.post('/fila/desativar',a(async(req,res)=>{await fila.desativar(req.user);res.json({ok:true});}));
router.get('/fila',a(async(req,res)=>{fila.exigirAtivo();res.json(await fila.estado(req.user));}));
function escopo(u,alias='l'){
 if(u.perfil==='admin')return {sql:'true',params:[]};
 return u.perfil==='gerente'?{sql:`${alias}.filial_id=$1`,params:[u.filialId]}:{sql:`${alias}.responsavel_id=$1`,params:[u.id]};
}
router.get('/leads',a(async(req,res)=>{
 fila.exigirAtivo();const e=escopo(req.user);const page=Math.max(1,Number(req.query.page)||1),size=50;
 const params=[...e.params];let where=`COALESCE(l.tipo_lead,'')<>'CAPTACAO_IMOVEL' AND (${e.sql})`;
 if(req.query.busca){params.push('%'+String(req.query.busca).slice(0,100)+'%');where+=` AND (l.nome ILIKE $${params.length} OR l.email ILIKE $${params.length} OR l.telefone ILIKE $${params.length})`;}
 const total=(await pool.query(`SELECT count(*)::int n FROM portal_leads l WHERE ${where}`,params)).rows[0].n;
 const rows=(await pool.query(`SELECT l.*,u.nome AS responsavel_nome,i.titulo AS imovel_titulo FROM portal_leads l
  LEFT JOIN usuarios u ON u.id=l.responsavel_id LEFT JOIN imoveis i ON i.id=l.imovel_id WHERE ${where}
  ORDER BY l.recebido_em DESC,l.id LIMIT ${size} OFFSET ${(page-1)*size}`,params)).rows;
 res.json({items:rows,total,page,pageSize:size,totalPages:Math.ceil(total/size)});
}));
router.post('/leads',a(async(req,res)=>{
 fila.exigirAtivo();const nome=limparTexto(req.body.nome,180),email=emailOuNulo(req.body.email),telefone=telefoneOuNulo(req.body.telefone);
 if(!nome||nome.length<3||(!email&&!telefone))throw badRequest('Informe nome e telefone ou e-mail válido.');
 let filial=req.user.filialId;
 if(req.user.perfil==='admin'&&req.body.filialId)filial=exigirUuid(req.body.filialId,'filial');
 if(filial&&!(await pool.query('SELECT id FROM filiais WHERE id=$1 AND ativo',[filial])).rows.length)throw badRequest('Filial inválida.');
 const proprio=req.user.perfil==='corretor';
 const chave=req.body.chave?exigirUuid(req.body.chave,'operação'):crypto.randomUUID();
 const result=await fila.transacao(async c=>{
  const r=await leadsRepo.inserirIdempotente({nome,email,telefone,mensagem:limparTexto(req.body.mensagem,2000),origem:'MANUAL',
   criado_por_id:req.user.id,posse_permanente:proprio,filial_id:filial,recebido_em:new Date(),
   portal_slug:'manual',external_lead_id:req.user.id+':'+chave},c);
  if(!r.duplicado)await fila.historico(c,r.lead.id,'CRIACAO',proprio?'Lead próprio: vínculo permanente com o corretor criador.':'Lead criado pela gestão; aguardando fila.',req.user.id);
  return r;
 });
 await fila.distribuir();res.status(result.duplicado?200:201).json({id:result.lead.id});
}));
router.get('/leads/:id',a(async(req,res)=>{
 const l=(await pool.query('SELECT * FROM portal_leads WHERE id=$1',[exigirUuid(req.params.id,'lead')])).rows[0];
 if(!l||!fila.podeVer(l,req.user))throw notFound('Lead não encontrado.');
 const h=(await pool.query(`SELECT h.*,u.nome AS usuario_nome FROM gl_lead_historico h LEFT JOIN usuarios u ON u.id=h.usuario_id
  WHERE lead_id=$1 ORDER BY criado_em DESC,id`,[l.id])).rows;res.json({...l,historico:h});
}));
router.patch('/leads/:id',a(async(req,res)=>res.json(await fila.editar(exigirUuid(req.params.id,'lead'),req.body,req.user))));
router.get('/imoveis',a(async(req,res)=>{
 const page=Math.max(1,Number(req.query.page)||1),size=50;const e=req.user.perfil==='admin'?{sql:'true',params:[]}:
  {sql:"(i.filial_id=$1 OR (i.visibilidade='TODOS' AND i.publicar_site))",params:[req.user.filialId]};
 const where=`i.deleted_at IS NULL AND i.ativo AND (${e.sql})`;
 const rows=(await pool.query(`SELECT i.id,i.codigo,i.titulo,i.descricao,i.valor_venda,i.valor_locacao,i.finalidade,
  i.latitude,i.longitude,i.bairro,i.cidade,i.uf,i.area_util,i.dormitorios,i.vagas,i.oportunidade_score,
  i.qualidade_score,COALESCE((SELECT jsonb_agg(jsonb_build_object('id',m.id,'url',m.url,'urlWeb',m.url_web,'capa',m.capa) ORDER BY m.capa DESC,m.ordem)
  FROM imovel_midias m WHERE m.imovel_id=i.id AND m.publica AND m.tipo='IMAGEM'),'[]'::jsonb) AS imagens
  FROM imoveis i WHERE ${where} ORDER BY i.oportunidade_score DESC,i.id LIMIT ${size} OFFSET ${(page-1)*size}`,e.params)).rows;
 const total=(await pool.query(`SELECT count(*)::int n FROM imoveis i WHERE ${where}`,e.params)).rows[0].n;
 res.json({items:rows,page,total,totalPages:Math.ceil(total/size)});
}));
router.get('/eventos/cursor',a(async(req,res)=>{
 const p=req.user.perfil==='admin'?null:req.user.filialId;
 res.json({cursor:(await pool.query('SELECT COALESCE(max(id),0) AS cursor FROM gl_eventos WHERE filial_id=$1 OR $2::boolean',[p,req.user.perfil==='admin'])).rows[0].cursor});
}));
router.get('/eventos',a(async(req,res)=>{
 const after=Number(req.query.apos)||0;if(!Number.isSafeInteger(after)||after<0)throw badRequest('Cursor inválido.');
 const p=[after];let scope='true';if(req.user.perfil!=='admin'){p.push(req.user.filialId);scope='filial_id=$2';}
 const rows=(await pool.query(`SELECT * FROM gl_eventos WHERE id>$1 AND (${scope}) ORDER BY id LIMIT 100`,p)).rows;
 res.json({items:rows,cursor:rows.length?rows[rows.length-1].id:after});
}));
router.get('/filiais',a(async(req,res)=>{
 res.json((await pool.query(`SELECT id,nome,endereco,latitude,longitude,ativo FROM filiais WHERE $1::uuid IS NULL OR id=$1 ORDER BY nome`,[req.user.perfil==='admin'?null:req.user.filialId||req.user.id])).rows);
}));
router.put('/filiais/:id/localizacao',somentePerfis('admin'),a(async(req,res)=>{
 const {latitude,longitude}=req.body;if(![latitude,longitude].every(n=>typeof n==='number'&&Number.isFinite(n))||Math.abs(latitude)>90||Math.abs(longitude)>180)throw badRequest('Coordenadas inválidas.');
 const r=await pool.query(`UPDATE filiais SET latitude=$2,longitude=$3,endereco=COALESCE($4,endereco),updated_at=now() WHERE id=$1 RETURNING id`,[exigirUuid(req.params.id,'filial'),latitude,longitude,limparTexto(req.body.endereco,500)]);
 if(!r.rowCount)throw notFound();res.json({ok:true});
}));
router.get('/configuracao',somentePerfis('admin'),a(async(req,res)=>res.json((await pool.query('SELECT * FROM gl_operacao_config WHERE id=1')).rows[0])));
router.get('/usuarios',somentePerfis('admin'),a(async(req,res)=>res.json((await pool.query('SELECT id,nome,perfil,filial_id,foto_url FROM usuarios WHERE ativo ORDER BY nome')).rows)));
router.put('/usuarios/:id/filial',somentePerfis('admin'),a(async(req,res)=>{
 const filial=exigirUuid(req.body.filialId,'filial'),id=exigirUuid(req.params.id,'usuário');
 if(!(await pool.query('SELECT id FROM filiais WHERE id=$1 AND ativo',[filial])).rows.length)throw badRequest('Filial inválida.');
 await fila.transacao(async c=>{const r=await c.query('UPDATE usuarios SET filial_id=$2 WHERE id=$1 RETURNING id',[id,filial]);if(!r.rowCount)throw notFound();await c.query('UPDATE gl_fila_membros SET ativo=false WHERE usuario_id=$1',[id]);});
 res.json({ok:true});
}));
router.put('/configuracao',somentePerfis('admin'),a(async(req,res)=>{
 const id=req.body.filialPadraoId?exigirUuid(req.body.filialPadraoId,'filial'):null;
 if(id&&!(await pool.query('SELECT id FROM filiais WHERE id=$1 AND ativo',[id])).rows.length)throw badRequest('Filial inválida.');
 await pool.query('UPDATE gl_operacao_config SET filial_padrao_id=$1 WHERE id=1',[id]);res.json({ok:true});
}));
router.post('/geocodificar',somentePerfis('admin'),a(async(req,res)=>res.json(await require('../services/operacao/geocoding').buscar(req.body.endereco))));
router.post('/imoveis/geocodificar-fila',somentePerfis('admin'),a(async(req,res)=>{
 const r=await pool.query(`INSERT INTO gl_geocode_jobs(imovel_id) SELECT id FROM imoveis WHERE deleted_at IS NULL
  AND ativo AND (latitude IS NULL OR longitude IS NULL) ON CONFLICT DO NOTHING RETURNING imovel_id`);
 res.json({enfileirados:r.rowCount});
}));
router.get('/imoveis/geocodificacao',somentePerfis('admin'),a(async(req,res)=>res.json((await pool.query(`SELECT g.*,i.codigo,i.titulo FROM gl_geocode_jobs g
 JOIN imoveis i ON i.id=g.imovel_id ORDER BY CASE WHEN g.status='REVISAO' THEN 0 WHEN g.status='PENDENTE' THEN 1 ELSE 2 END,g.imovel_id LIMIT 100`)).rows)));
router.put('/imoveis/:id/localizacao',somentePerfis('admin'),a(async(req,res)=>{
 const id=exigirUuid(req.params.id,'imóvel');const {latitude,longitude}=req.body;
 if(![latitude,longitude].every(n=>typeof n==='number'&&Number.isFinite(n))||Math.abs(latitude)>90||Math.abs(longitude)>180||req.body.confirmado!==true)throw badRequest('Confira e confirme as coordenadas no mapa.');
 await fila.transacao(async c=>{const r=await c.query('UPDATE imoveis SET latitude=$2,longitude=$3 WHERE id=$1 AND deleted_at IS NULL RETURNING id',[id,latitude,longitude]);if(!r.rowCount)throw notFound();await c.query("UPDATE gl_geocode_jobs SET status='CONCLUIDO',erro=NULL WHERE imovel_id=$1",[id]);});res.json({ok:true});
}));
router.post('/imoveis/:id/geocodificar',somentePerfis('admin'),a(async(req,res)=>{
 const referencia=limparTexto(req.params.id,120);const i=(await pool.query('SELECT * FROM imoveis WHERE (id::text=$1 OR lower(codigo)=lower($1)) AND deleted_at IS NULL LIMIT 1',[referencia])).rows[0];if(!i)throw notFound();const id=i.id;
 const geo=require('../services/operacao/geocoding');const ponto=await geo.buscar(geo.endereco(i));
 const preciso=ponto.preciso&&String(ponto.numero||'').replace(/\D/g,'')===String(i.numero||'').replace(/\D/g,'');
 let salvo=false;
 if(preciso)salvo=!!(await pool.query(`UPDATE imoveis SET latitude=$2,longitude=$3 WHERE id=$1
  AND jsonb_build_array(logradouro,numero,bairro,cidade,uf,cep)=$4::jsonb RETURNING id`,[id,ponto.latitude,ponto.longitude,JSON.stringify(geo.campos(i))])).rowCount;
 res.json({...ponto,preciso,salvo});
}));
const upload=require('multer')({storage:require('multer').memoryStorage(),limits:{fileSize:8*1024*1024,files:1}});
router.post('/perfil/foto',upload.single('foto'),a(async(req,res)=>{
 if(!req.file)throw badRequest('Envie uma foto.');let buffer;try{buffer=await require('sharp')(req.file.buffer,{limitInputPixels:24000000}).rotate().resize(800,800,{fit:'cover'}).jpeg({quality:85}).toBuffer();}catch(_){throw badRequest('Foto inválida. Use JPEG ou PNG.');}
 const objeto=await require('../services/minio.service').enviarObjeto(`usuarios/${req.user.id}/${crypto.randomUUID()}.jpg`,buffer,'image/jpeg');
 await pool.query('UPDATE usuarios SET foto_url=$2 WHERE id=$1',[req.user.id,objeto.url]);res.json({fotoUrl:objeto.url});
}));
module.exports=router;
