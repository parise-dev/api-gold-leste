-- =====================================================================
-- Gold Leste — ROLLBACK da Fila de Leads / Próximos Corretores
-- Arquivo: sql/20260830_fila_leads_rollback.sql
-- Data....: 2026-08-30
--
-- ATENÇÃO — ESTE SCRIPT APAGA DADOS.
--   Derruba a fila e todo o histórico de distribuição.
--   Faça backup antes. Nenhuma automação executou nada aqui.
--
--   Nenhum lead, imóvel ou usuário é apagado. As colunas adicionadas em
--   `usuarios` e `portal_leads` são removidas — se quiser preservar o
--   histórico de distribuição já gravado nos leads, comente o bloco 2.
-- =====================================================================

BEGIN;

-- 1. Tabelas e sequência da fila -------------------------------------
DROP TABLE    IF EXISTS lead_distribuicao_logs CASCADE;
DROP TABLE    IF EXISTS lead_fila_corretores   CASCADE;
DROP SEQUENCE IF EXISTS lead_fila_ordem_seq;

-- 2. Colunas aditivas -------------------------------------------------
ALTER TABLE portal_leads
  DROP COLUMN IF EXISTS distribuicao_pendente_desde,
  DROP COLUMN IF EXISTS distribuicao_tipo,
  DROP COLUMN IF EXISTS distribuicao_posicao;

DROP INDEX IF EXISTS idx_usuarios_ultima_atividade;

ALTER TABLE usuarios
  DROP COLUMN IF EXISTS ultima_atividade_em;

COMMIT;

-- =====================================================================
-- FIM.
-- =====================================================================
