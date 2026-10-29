-- Fluxo administrativo das solicitações enviadas por proprietários.
-- A solicitação só vira imóvel depois de aprovada e convertida por um admin.

ALTER TABLE portal_leads
  ADD COLUMN IF NOT EXISTS tipo_lead VARCHAR(30) NOT NULL DEFAULT 'INTERESSE_IMOVEL',
  ADD COLUMN IF NOT EXISTS captacao_status VARCHAR(25),
  ADD COLUMN IF NOT EXISTS captacao_observacoes TEXT,
  ADD COLUMN IF NOT EXISTS captacao_contatado_em TIMESTAMP,
  ADD COLUMN IF NOT EXISTS captacao_aprovada_em TIMESTAMP,
  ADD COLUMN IF NOT EXISTS captacao_recusada_em TIMESTAMP,
  ADD COLUMN IF NOT EXISTS captacao_convertida_em TIMESTAMP,
  ADD COLUMN IF NOT EXISTS captacao_imovel_id UUID REFERENCES imoveis(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS captacao_atualizada_por UUID REFERENCES usuarios(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_portal_leads_captacao
  ON portal_leads (captacao_status, recebido_em DESC)
  WHERE tipo_lead = 'CAPTACAO_IMOVEL';

COMMENT ON COLUMN portal_leads.tipo_lead IS
  'INTERESSE_IMOVEL para leads comuns; CAPTACAO_IMOVEL para proprietários que desejam anunciar.';

COMMENT ON COLUMN portal_leads.captacao_status IS
  'NOVA, EM_CONTATO, APROVADA, RECUSADA ou CONVERTIDA. Usado apenas em CAPTACAO_IMOVEL.';
