-- ADITIVA: não redistribui leads anteriores, não altera anúncios nem feeds.
BEGIN;
SET LOCAL lock_timeout='5s';
ALTER TABLE filiais ADD COLUMN IF NOT EXISTS latitude double precision,
 ADD COLUMN IF NOT EXISTS longitude double precision;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS foto_url text;
ALTER TABLE portal_leads
 ADD COLUMN IF NOT EXISTS operacao_gerenciada boolean NOT NULL DEFAULT false,
 ADD COLUMN IF NOT EXISTS etapa text NOT NULL DEFAULT 'NOVO',
 ADD COLUMN IF NOT EXISTS criado_por_id uuid REFERENCES usuarios(id),
 ADD COLUMN IF NOT EXISTS posse_permanente boolean NOT NULL DEFAULT false,
 ADD COLUMN IF NOT EXISTS ultimo_responsavel_id uuid REFERENCES usuarios(id),
 ADD COLUMN IF NOT EXISTS etapa_em timestamptz,
 ADD COLUMN IF NOT EXISTS prazo_em timestamptz,
 ADD COLUMN IF NOT EXISTS visita_em timestamptz,
 ADD COLUMN IF NOT EXISTS versao_atendimento integer NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS gl_operacao_config (
 id integer PRIMARY KEY CHECK(id=1), filial_padrao_id uuid REFERENCES filiais(id)
);
CREATE TABLE IF NOT EXISTS gl_geocode_jobs (
 imovel_id uuid PRIMARY KEY REFERENCES imoveis(id), status text NOT NULL DEFAULT 'PENDENTE',
 candidato jsonb, tentativas integer NOT NULL DEFAULT 0, proxima_em timestamptz NOT NULL DEFAULT now(), erro text
);
INSERT INTO gl_operacao_config(id) VALUES(1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS gl_sessoes (
 id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), usuario_id uuid NOT NULL REFERENCES usuarios(id),
 expira_em timestamptz NOT NULL, revogada_em timestamptz, criado_em timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS gl_dispositivos (
 id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), usuario_id uuid NOT NULL REFERENCES usuarios(id),
 sessao_id uuid NOT NULL REFERENCES gl_sessoes(id), token_cifrado text NOT NULL, token_hash text NOT NULL UNIQUE,
 ambiente text NOT NULL CHECK(ambiente IN ('sandbox','production')), ativo boolean NOT NULL DEFAULT true,
 atualizado_em timestamptz NOT NULL DEFAULT now()
);
CREATE SEQUENCE IF NOT EXISTS gl_fila_ordem_seq;
CREATE TABLE IF NOT EXISTS gl_fila_membros (
 usuario_id uuid PRIMARY KEY REFERENCES usuarios(id), sessao_id uuid NOT NULL REFERENCES gl_sessoes(id),
 filial_id uuid NOT NULL REFERENCES filiais(id), ordem bigint NOT NULL DEFAULT nextval('gl_fila_ordem_seq'),
 ativo boolean NOT NULL DEFAULT false, latitude double precision, longitude double precision,
 precisao_m double precision, localizado_em timestamptz, entrou_em timestamptz NOT NULL DEFAULT now(),
 total_recebidos integer NOT NULL DEFAULT 0, ultimo_lead_em timestamptz
);
CREATE TABLE IF NOT EXISTS gl_lead_historico (
 id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), lead_id uuid NOT NULL REFERENCES portal_leads(id),
 usuario_id uuid REFERENCES usuarios(id), tipo text NOT NULL, descricao text NOT NULL,
 etapa_anterior text, etapa_nova text, criado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_gl_hist_lead ON gl_lead_historico(lead_id,criado_em DESC);
CREATE TABLE IF NOT EXISTS gl_lead_exclusoes (
 lead_id uuid NOT NULL REFERENCES portal_leads(id), usuario_id uuid NOT NULL REFERENCES usuarios(id),
 motivo text NOT NULL, criado_em timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(lead_id,usuario_id)
);
CREATE TABLE IF NOT EXISTS gl_push_outbox (
 id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), lead_id uuid NOT NULL REFERENCES portal_leads(id),
 usuario_id uuid NOT NULL REFERENCES usuarios(id), versao integer NOT NULL,
 dispositivo_id uuid NOT NULL REFERENCES gl_dispositivos(id), tentativas integer NOT NULL DEFAULT 0,
 proxima_em timestamptz NOT NULL DEFAULT now(), enviado_em timestamptz, cancelado_em timestamptz,
 erro text, UNIQUE(lead_id,versao,dispositivo_id)
);
CREATE INDEX IF NOT EXISTS idx_gl_push_pendente ON gl_push_outbox(proxima_em) WHERE enviado_em IS NULL AND cancelado_em IS NULL;
CREATE INDEX IF NOT EXISTS idx_gl_prazos ON portal_leads(prazo_em) WHERE operacao_gerenciada AND prazo_em IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_gl_pendentes ON portal_leads(recebido_em,id) WHERE operacao_gerenciada AND responsavel_id IS NULL;
CREATE TABLE IF NOT EXISTS gl_eventos (
 id bigserial PRIMARY KEY, tipo text NOT NULL, venda_id uuid UNIQUE, filial_id uuid REFERENCES filiais(id),
 dados jsonb NOT NULL, criado_em timestamptz NOT NULL DEFAULT now()
);
-- Captura vendas de qualquer tela/integração que grave na tabela original.
-- to_jsonb evita depender de campos opcionais de versões anteriores.
CREATE OR REPLACE FUNCTION gl_evento_venda() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v jsonb; uid uuid; foto text; fid uuid;
BEGIN
 v=to_jsonb(NEW); uid=NULLIF(v->>'corretor_id','')::uuid;
 SELECT foto_url, filial_id INTO foto,fid FROM usuarios WHERE id=uid;
 INSERT INTO gl_eventos(tipo,venda_id,filial_id,dados)
 VALUES('VENDA',NEW.id,fid,jsonb_build_object('vendaId',NEW.id,'corretorId',uid,
  'corretorNome',v->>'corretor_nome','fotoUrl',foto,'imovel',v->>'empreendimento_rua',
  'unidade',v->>'numero_unidade','valor',v->>'valor_imovel_venda',
  'vendasMes',(SELECT count(*)+1 FROM gl_eventos WHERE tipo='VENDA' AND dados->>'corretorId'=uid::text AND criado_em>=date_trunc('month',now())),
  'leadsRecebidos',COALESCE((SELECT total_recebidos FROM gl_fila_membros WHERE usuario_id=uid),0))) ON CONFLICT(venda_id) DO NOTHING;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS gl_nova_venda ON vendas;
CREATE TRIGGER gl_nova_venda AFTER INSERT ON vendas FOR EACH ROW EXECUTE FUNCTION gl_evento_venda();
COMMIT;
