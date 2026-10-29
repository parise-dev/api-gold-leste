-- =====================================================================
-- Gold Leste — Fila de Leads / Próximos Corretores (round-robin)
-- Arquivo: sql/20260830_fila_leads.sql
-- Data....: 2026-08-30
--
-- ATENÇÃO
--   Este script NÃO foi executado por nenhuma automação.
--   Revise integralmente antes de rodar em produção.
--   Rollback disponível em: sql/20260830_fila_leads_rollback.sql
--
--   O script é ADITIVO: só cria tabelas/sequência novas e adiciona
--   colunas nulas em tabelas existentes. Nenhuma coluna é removida,
--   renomeada ou alterada de tipo. Nenhum CHECK existente é mexido.
--   O sistema em produção continua funcionando antes e depois dele.
--
-- Pré-requisitos:
--   * tabela public.usuarios      (id UUID)
--   * tabela public.portal_leads  (criada em 20260816_imoveis_portais.sql)
--   * extensão uuid-ossp
-- =====================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ---------------------------------------------------------------------
-- 0. PRÉ-VOO — aborta cedo e com mensagem clara.
-- ---------------------------------------------------------------------
DO $preflight$
DECLARE
  v_tipo TEXT;
BEGIN
  SELECT data_type INTO v_tipo
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'usuarios' AND column_name = 'id';

  IF v_tipo IS NULL THEN
    RAISE EXCEPTION 'Tabela public.usuarios não encontrada. Abortando.';
  END IF;

  IF v_tipo <> 'uuid' THEN
    RAISE EXCEPTION 'usuarios.id é % e não uuid. Ajuste as FKs deste script.', v_tipo;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'portal_leads'
  ) THEN
    RAISE EXCEPTION
      'Tabela public.portal_leads não encontrada. Execute antes sql/20260816_imoveis_portais.sql.';
  END IF;
END
$preflight$;

-- ---------------------------------------------------------------------
-- 1. PRESENÇA DO USUÁRIO
--    `ultima_atividade_em` é alimentada pelo heartbeat do frontend.
--    Sessão antiga NÃO significa online: o corte é sempre por tempo.
-- ---------------------------------------------------------------------
ALTER TABLE usuarios
  ADD COLUMN IF NOT EXISTS ultima_atividade_em TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_usuarios_ultima_atividade
  ON usuarios (ultima_atividade_em DESC)
  WHERE ativo;

COMMENT ON COLUMN usuarios.ultima_atividade_em IS
  'Último heartbeat recebido. NULL = offline (logout explícito ou nunca conectou). '
  'A janela de presença fica em src/config/lead-distribution.config.js.';

-- ---------------------------------------------------------------------
-- 2. FILA DE DISTRIBUIÇÃO
--
--    Modelo: uma linha por corretor. `ordem` é um contador monotônico
--    (sequência). Menor `ordem` = próximo a receber lead.
--
--    Receber um lead  -> ordem = nextval(...)  (vai para o fim)
--    Voltar a ficar online -> ordem = nextval(...) (entra no fim)
--
--    Assim a rotação nunca precisa renumerar a tabela inteira e não
--    depende de ORDER BY em `usuarios`.
-- ---------------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS lead_fila_ordem_seq AS BIGINT START WITH 1 INCREMENT BY 1;

CREATE TABLE IF NOT EXISTS lead_fila_corretores (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  usuario_id         UUID NOT NULL UNIQUE REFERENCES usuarios(id) ON DELETE CASCADE,

  -- Posição relativa. Menor = próximo da fila.
  ordem              BIGINT NOT NULL,

  -- Presença registrada na última vez que o corretor entrou na fila.
  na_fila            BOOLEAN NOT NULL DEFAULT TRUE,
  entrou_em          TIMESTAMP NOT NULL DEFAULT NOW(),
  saiu_em            TIMESTAMP,

  ultimo_lead_id     UUID REFERENCES portal_leads(id) ON DELETE SET NULL,
  ultimo_lead_em     TIMESTAMP,
  total_leads        INTEGER NOT NULL DEFAULT 0,

  created_at         TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lead_fila_ordem
  ON lead_fila_corretores (ordem ASC)
  WHERE na_fila;

COMMENT ON TABLE lead_fila_corretores IS
  'Fila circular (round-robin) de distribuição de leads. Menor "ordem" é o próximo a receber.';

COMMENT ON COLUMN lead_fila_corretores.ordem IS
  'Contador monotônico (lead_fila_ordem_seq). Receber lead ou reentrar online joga o corretor para o fim.';

-- ---------------------------------------------------------------------
-- 3. AUDITORIA DA DISTRIBUIÇÃO
--    Histórico imutável: reorganizar a fila NUNCA apaga estes registros.
--    Nome do usuário é desnormalizado de propósito para o histórico
--    sobreviver à exclusão/inativação do cadastro.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lead_distribuicao_logs (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  lead_id            UUID REFERENCES portal_leads(id) ON DELETE SET NULL,
  usuario_id         UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  usuario_nome       VARCHAR(180),

  -- Posição que o corretor ocupava na fila no momento da distribuição.
  posicao            INTEGER,

  tipo               VARCHAR(20) NOT NULL,   -- AUTOMATICA | MANUAL | REDISTRIBUICAO | SEM_CORRETOR

  origem_lead        VARCHAR(30),            -- SITE | PORTAL | LANDING | MANUAL
  portal_slug        VARCHAR(40),
  imovel_id          UUID,

  alterado_por       UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  alterado_por_nome  VARCHAR(180),

  corretores_online  INTEGER,
  motivo             TEXT,

  criado_em          TIMESTAMP NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_lead_distribuicao_tipo
    CHECK (tipo IN ('AUTOMATICA', 'MANUAL', 'REDISTRIBUICAO', 'SEM_CORRETOR'))
);

CREATE INDEX IF NOT EXISTS idx_lead_distribuicao_logs_criado
  ON lead_distribuicao_logs (criado_em DESC);

CREATE INDEX IF NOT EXISTS idx_lead_distribuicao_logs_usuario
  ON lead_distribuicao_logs (usuario_id, criado_em DESC);

CREATE INDEX IF NOT EXISTS idx_lead_distribuicao_logs_lead
  ON lead_distribuicao_logs (lead_id, criado_em DESC);

COMMENT ON TABLE lead_distribuicao_logs IS
  'Auditoria de distribuição de leads. Nunca é apagada ao reorganizar a fila.';

-- ---------------------------------------------------------------------
-- 4. LEADS — colunas de apoio à distribuição
--
--    Nenhum CHECK existente é alterado. Um lead "aguardando corretor"
--    é aquele com distribuicao_pendente_desde IS NOT NULL e
--    responsavel_id IS NULL — sem precisar de novo status_processamento.
-- ---------------------------------------------------------------------
ALTER TABLE portal_leads
  ADD COLUMN IF NOT EXISTS distribuicao_pendente_desde TIMESTAMP,
  ADD COLUMN IF NOT EXISTS distribuicao_tipo           VARCHAR(20),
  ADD COLUMN IF NOT EXISTS distribuicao_posicao        INTEGER;

CREATE INDEX IF NOT EXISTS idx_portal_leads_pendentes
  ON portal_leads (distribuicao_pendente_desde ASC)
  WHERE distribuicao_pendente_desde IS NOT NULL AND responsavel_id IS NULL;

COMMENT ON COLUMN portal_leads.distribuicao_pendente_desde IS
  'Preenchido quando o lead chega e não há corretor elegível online. Zerado ao distribuir.';

COMMENT ON COLUMN portal_leads.distribuicao_tipo IS
  'AUTOMATICA (fila) | MANUAL (gestor escolheu) | REDISTRIBUICAO | IMOVEL (responsável do imóvel).';

-- ---------------------------------------------------------------------
-- 5. CARGA INICIAL DA FILA
--
--    Todos os corretores ativos entram na fila uma única vez, em ordem
--    estável (ultimo_login, depois created_at). Eles só APARECEM no
--    painel quando estiverem realmente online (heartbeat), então esta
--    carga não distribui nada sozinha — apenas evita fila vazia no
--    primeiro dia.
-- ---------------------------------------------------------------------
INSERT INTO lead_fila_corretores (usuario_id, ordem, na_fila, entrou_em)
SELECT
  u.id,
  nextval('lead_fila_ordem_seq'),
  TRUE,
  NOW()
FROM (
  SELECT id
  FROM usuarios
  WHERE perfil = 'corretor'
    AND ativo
  ORDER BY COALESCE(ultimo_login, created_at) ASC NULLS LAST, created_at ASC
) AS u
ON CONFLICT (usuario_id) DO NOTHING;

COMMIT;

-- =====================================================================
-- Conferência rápida após executar:
--
--   SELECT COUNT(*) FROM lead_fila_corretores;
--   SELECT column_name FROM information_schema.columns
--     WHERE table_name = 'portal_leads' AND column_name LIKE 'distribuicao%';
--   SELECT column_name FROM information_schema.columns
--     WHERE table_name = 'usuarios' AND column_name = 'ultima_atividade_em';
-- =====================================================================
