-- =====================================================================
-- Gold Leste — ROLLBACK do domínio de Imóveis / Portais
-- Arquivo: sql/20260816_imoveis_portais_rollback.sql
-- Data....: 2026-08-16
--
-- ATENÇÃO — ESTE SCRIPT APAGA DADOS.
--   Ele derruba todas as tabelas criadas em 20260816_imoveis_portais.sql,
--   incluindo imóveis, mídias e leads já cadastrados.
--   Faça backup antes. Nenhuma automação executou nada aqui.
--
--   Nenhuma tabela pré-existente (usuarios, filiais, vendas, contas_receber,
--   venda_corretores, venda_logs, usuarios_comprovantes) é tocada.
--
--   Os objetos do MinIO (bucket "empreendimentos", prefixo "imoveis/")
--   NÃO são removidos por este script. Limpe-os manualmente se desejar.
-- =====================================================================

BEGIN;

DROP TABLE IF EXISTS portal_sync_logs        CASCADE;
DROP TABLE IF EXISTS portal_leads            CASCADE;
DROP TABLE IF EXISTS demo_solicitacoes       CASCADE;
DROP TABLE IF EXISTS imovel_portais          CASCADE;
DROP TABLE IF EXISTS portal_integracoes      CASCADE;
DROP TABLE IF EXISTS portais                 CASCADE;

DROP TABLE IF EXISTS imovel_logs             CASCADE;
DROP TABLE IF EXISTS imovel_favoritos        CASCADE;
DROP TABLE IF EXISTS imovel_visibilidades    CASCADE;
DROP TABLE IF EXISTS imovel_midias           CASCADE;
DROP TABLE IF EXISTS imovel_caracteristicas  CASCADE;
DROP TABLE IF EXISTS caracteristicas         CASCADE;

-- imoveis por último: as demais referenciam esta tabela.
DROP TABLE IF EXISTS imoveis                 CASCADE;

DROP SEQUENCE IF EXISTS imoveis_codigo_seq;

COMMIT;

-- =====================================================================
-- FIM.
-- =====================================================================
