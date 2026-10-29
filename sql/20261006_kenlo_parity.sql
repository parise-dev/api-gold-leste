BEGIN;

ALTER TABLE imoveis
  ADD COLUMN IF NOT EXISTS dados_kenlo JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN imoveis.dados_kenlo IS
  'Campos complementares do cadastro de imóvel espelhados da Kenlo Imob.';

COMMIT;
