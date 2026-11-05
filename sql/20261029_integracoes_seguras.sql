-- Migração ADITIVA. Não altera imóveis, seleções, tokens ou leads existentes.
-- Executar explicitamente após backup, nunca no startup da aplicação.
BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE TABLE IF NOT EXISTS portal_feed_versoes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  portal_id UUID NOT NULL REFERENCES portais(id),
  conteudo TEXT NOT NULL,
  content_type TEXT NOT NULL,
  listing_ids JSONB NOT NULL,
  hash TEXT NOT NULL,
  aprovado_por UUID REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_portal_feed_versao ON portal_feed_versoes(portal_id, criado_em DESC);
ALTER TABLE portal_integracoes ADD COLUMN IF NOT EXISTS feed_versao_id UUID REFERENCES portal_feed_versoes(id);
ALTER TABLE portal_integracoes ADD COLUMN IF NOT EXISTS webhook_token VARCHAR(64);
CREATE UNIQUE INDEX IF NOT EXISTS ux_portal_webhook_token ON portal_integracoes(webhook_token) WHERE webhook_token IS NOT NULL;
ALTER TABLE imovel_portais ADD COLUMN IF NOT EXISTS listing_id_exportacao VARCHAR(50);
CREATE UNIQUE INDEX IF NOT EXISTS ux_portal_listing_exportacao ON imovel_portais(portal_id, listing_id_exportacao)
  WHERE listing_id_exportacao IS NOT NULL;

CREATE TABLE IF NOT EXISTS meta_conexoes (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  usuario_meta_id TEXT NOT NULL,
  nome TEXT,
  token_cifrado TEXT NOT NULL,
  expira_em TIMESTAMPTZ,
  conectado_por UUID REFERENCES usuarios(id),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS meta_oauth_estados (
  hash TEXT PRIMARY KEY,
  usuario_id UUID NOT NULL REFERENCES usuarios(id),
  expira_em TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS meta_paginas (
  id TEXT PRIMARY KEY,
  nome TEXT,
  token_cifrado TEXT NOT NULL,
  inscrita BOOLEAN NOT NULL DEFAULT false,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Inbox durável: responder 200 só depois de gravar. Worker retenta a consulta
-- ao Graph e a entrada na fila; o ID externo garante idempotência no CRM.
CREATE TABLE IF NOT EXISTS meta_lead_eventos (
  lead_id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  tentativas INT NOT NULL DEFAULT 0,
  proxima_tentativa TIMESTAMPTZ NOT NULL DEFAULT now(),
  concluido_em TIMESTAMPTZ,
  ultimo_erro TEXT,
  recebido_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_meta_eventos_pendentes ON meta_lead_eventos(proxima_tentativa) WHERE concluido_em IS NULL;
-- Operações financeiras idempotentes: não repetir POST de resultado incerto.
CREATE TABLE IF NOT EXISTS meta_operacoes (
  chave UUID PRIMARY KEY,
  usuario_id UUID NOT NULL REFERENCES usuarios(id),
  hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDENTE',
  resultado JSONB,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO portais(slug, nome, descricao, modo_integracao, status_implementacao, documentacao_url, ordem)
VALUES ('facebook', 'Facebook / Instagram', 'Campanhas Meta e leads de formulários instantâneos.', 'API',
 'PENDING_CONFIGURATION', 'https://developers.facebook.com/docs/marketing-api/', 50)
ON CONFLICT (slug) DO NOTHING;
COMMIT;
