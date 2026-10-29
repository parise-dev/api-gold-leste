-- =====================================================================
-- Gold Leste — Domínio de Imóveis, Mídias, Visibilidade, Portais e Leads
-- Arquivo: sql/20260816_imoveis_portais.sql
-- Data....: 2026-08-16
--
-- ATENÇÃO
--   Este script NÃO foi executado por nenhuma automação.
--   Revise integralmente antes de rodar em produção.
--   Rollback disponível em: sql/20260816_imoveis_portais_rollback.sql
--
-- Premissas verificadas no código-fonte da API:
--   * usuarios.id  -> UUID   (vide scripts/migrate-ajustes-cliente.js)
--   * vendas.id    -> UUID   (vide scripts/migrate-ajustes-cliente.js)
--   * filiais.id   -> UUID   (usuarios.filial_id referencia filiais.id)
--   * extensão uuid-ossp já em uso (uuid_generate_v4 em venda_logs)
--
--   Empreendimentos / unidades / clientes ainda vivem na API LEGADA
--   (jmapi.ensuo.com.br) e NÃO possuem tabela neste banco. Por isso são
--   referenciados apenas por identificador textual, SEM foreign key.
-- =====================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ---------------------------------------------------------------------
-- 0. PRÉ-VOO — aborta cedo e com mensagem clara se o banco não bater
--    com as premissas de tipo assumidas acima.
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
    RAISE EXCEPTION
      'usuarios.id é % e não uuid. Ajuste os tipos das FKs deste script antes de executar.', v_tipo;
  END IF;

  SELECT data_type INTO v_tipo
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'filiais' AND column_name = 'id';

  IF v_tipo IS NULL THEN
    RAISE EXCEPTION 'Tabela public.filiais não encontrada. Abortando.';
  END IF;

  IF v_tipo <> 'uuid' THEN
    RAISE EXCEPTION
      'filiais.id é % e não uuid. Ajuste os tipos das FKs deste script antes de executar.', v_tipo;
  END IF;

  SELECT data_type INTO v_tipo
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'vendas' AND column_name = 'id';

  IF v_tipo IS NOT NULL AND v_tipo <> 'uuid' THEN
    RAISE EXCEPTION
      'vendas.id é % e não uuid. Ajuste a FK imoveis.venda_id antes de executar.', v_tipo;
  END IF;
END
$preflight$;

-- ---------------------------------------------------------------------
-- 1. IMÓVEIS
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS imoveis (
  id                        UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- Identificação -----------------------------------------------------
  codigo                    VARCHAR(30)  NOT NULL,               -- ex.: GL000123
  referencia_externa        VARCHAR(60),                         -- código do cliente/parceiro
  slug                      VARCHAR(220) NOT NULL,
  titulo                    VARCHAR(160) NOT NULL,
  descricao                 TEXT,
  descricao_resumida        VARCHAR(400),

  -- Classificação -----------------------------------------------------
  -- Guardados como texto livre validado na aplicação, para permitir novos
  -- valores sem ALTER TABLE. Os CHECKs abaixo cobrem apenas os campos
  -- cujo domínio é estável e usado em regra de negócio.
  finalidade                VARCHAR(20)  NOT NULL DEFAULT 'VENDA',
  tipo                      VARCHAR(40)  NOT NULL DEFAULT 'APARTAMENTO',
  subtipo                   VARCHAR(40),
  situacao                  VARCHAR(30)  NOT NULL DEFAULT 'USADO',   -- NOVO | USADO | NA_PLANTA | EM_CONSTRUCAO
  status                    VARCHAR(20)  NOT NULL DEFAULT 'DISPONIVEL',
  origem_carteira           VARCHAR(20)  NOT NULL DEFAULT 'AVULSO',  -- AVULSO | EMPREENDIMENTO | TERCEIRO | CAPTADO

  ativo                     BOOLEAN      NOT NULL DEFAULT TRUE,
  destaque                  BOOLEAN      NOT NULL DEFAULT FALSE,
  oportunidade              BOOLEAN      NOT NULL DEFAULT FALSE,
  exclusivo                 BOOLEAN      NOT NULL DEFAULT FALSE,
  lancamento                BOOLEAN      NOT NULL DEFAULT FALSE,
  publicar_site             BOOLEAN      NOT NULL DEFAULT TRUE,     -- página pública /imovel/:slug

  prioridade_manual         SMALLINT     NOT NULL DEFAULT 0,        -- boost de oportunidade (admin/gerente)

  -- Comercial ---------------------------------------------------------
  valor_venda               NUMERIC(14,2),
  valor_locacao             NUMERIC(14,2),
  valor_condominio          NUMERIC(14,2),
  valor_iptu                NUMERIC(14,2),
  iptu_periodo              VARCHAR(10)  NOT NULL DEFAULT 'ANUAL',   -- ANUAL | MENSAL
  outras_taxas              NUMERIC(14,2),
  valor_minimo              NUMERIC(14,2),
  aceita_financiamento      BOOLEAN      NOT NULL DEFAULT FALSE,
  aceita_fgts               BOOLEAN      NOT NULL DEFAULT FALSE,
  aceita_permuta            BOOLEAN      NOT NULL DEFAULT FALSE,
  comissao_percentual       NUMERIC(6,3),
  comissao_valor            NUMERIC(14,2),
  observacoes_internas      TEXT,

  -- Características estruturadas --------------------------------------
  dormitorios               SMALLINT,
  suites                    SMALLINT,
  banheiros                 SMALLINT,
  vagas                     SMALLINT,
  area_util                 NUMERIC(12,2),
  area_total                NUMERIC(12,2),
  area_construida           NUMERIC(12,2),
  area_terreno              NUMERIC(12,2),
  andar                     SMALLINT,
  total_andares             SMALLINT,
  ano_construcao            SMALLINT,
  mobiliado                 BOOLEAN      NOT NULL DEFAULT FALSE,
  elevador                  BOOLEAN      NOT NULL DEFAULT FALSE,
  pet_friendly              BOOLEAN      NOT NULL DEFAULT FALSE,

  -- Endereço ----------------------------------------------------------
  cep                       VARCHAR(9),
  logradouro                VARCHAR(180),
  numero                    VARCHAR(20),
  complemento               VARCHAR(120),
  bairro                    VARCHAR(120),
  cidade                    VARCHAR(120),
  uf                        CHAR(2),
  latitude                  NUMERIC(10,7),
  longitude                 NUMERIC(10,7),
  exibir_endereco_completo  BOOLEAN      NOT NULL DEFAULT FALSE,

  -- Relacionamentos ---------------------------------------------------
  filial_id                 UUID REFERENCES filiais(id)  ON DELETE SET NULL,
  corretor_id               UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  captador_id               UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  gerente_id                UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  venda_id                  UUID,                                    -- FK adicionada condicionalmente abaixo

  -- Módulos legados (API jmapi) — sem FK de propósito
  empreendimento_legado_id  VARCHAR(60),
  empreendimento_nome       VARCHAR(180),
  unidade_legado_id         VARCHAR(60),
  unidade_identificacao     VARCHAR(60),
  proprietario_legado_id    VARCHAR(60),
  proprietario_nome         VARCHAR(180),
  proprietario_telefone     VARCHAR(40),
  proprietario_email        VARCHAR(180),
  dados_kenlo               JSONB        NOT NULL DEFAULT '{}'::jsonb,

  -- Visibilidade ------------------------------------------------------
  visibilidade              VARCHAR(20)  NOT NULL DEFAULT 'TODOS',

  -- Métricas / score --------------------------------------------------
  qualidade_score           SMALLINT     NOT NULL DEFAULT 0,          -- 0..100 (recalculado pela API)
  oportunidade_score        NUMERIC(7,2) NOT NULL DEFAULT 0,
  total_visualizacoes       INTEGER      NOT NULL DEFAULT 0,
  total_leads               INTEGER      NOT NULL DEFAULT 0,

  -- Auditoria ---------------------------------------------------------
  created_by                UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  updated_by                UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  created_at                TIMESTAMP    NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMP    NOT NULL DEFAULT NOW(),
  deleted_at                TIMESTAMP,

  CONSTRAINT chk_imoveis_finalidade
    CHECK (finalidade IN ('VENDA', 'LOCACAO', 'VENDA_LOCACAO')),

  CONSTRAINT chk_imoveis_status
    CHECK (status IN ('DISPONIVEL', 'RESERVADO', 'EM_NEGOCIACAO', 'VENDIDO', 'ALUGADO', 'SUSPENSO', 'INATIVO')),

  CONSTRAINT chk_imoveis_origem_carteira
    CHECK (origem_carteira IN ('AVULSO', 'EMPREENDIMENTO', 'TERCEIRO', 'CAPTADO')),

  CONSTRAINT chk_imoveis_visibilidade
    CHECK (visibilidade IN ('TODOS', 'FILIAL', 'SELECIONADOS', 'GERENCIA', 'PRIVADO')),

  CONSTRAINT chk_imoveis_iptu_periodo
    CHECK (iptu_periodo IN ('ANUAL', 'MENSAL')),

  CONSTRAINT chk_imoveis_qualidade
    CHECK (qualidade_score BETWEEN 0 AND 100)
);

-- FK para vendas só se a tabela existir neste banco.
DO $fk_venda$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = 'vendas')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_imoveis_venda')
  THEN
    ALTER TABLE imoveis
      ADD CONSTRAINT fk_imoveis_venda
      FOREIGN KEY (venda_id) REFERENCES vendas(id) ON DELETE SET NULL;
  END IF;
END
$fk_venda$;

-- Unicidade só entre registros vivos (soft delete não bloqueia reuso).
CREATE UNIQUE INDEX IF NOT EXISTS ux_imoveis_codigo_ativo
  ON imoveis (LOWER(codigo)) WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_imoveis_slug_ativo
  ON imoveis (LOWER(slug)) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_imoveis_status          ON imoveis (status)          WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_imoveis_finalidade      ON imoveis (finalidade)      WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_imoveis_tipo            ON imoveis (tipo)            WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_imoveis_cidade_bairro   ON imoveis (cidade, bairro)  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_imoveis_filial          ON imoveis (filial_id);
CREATE INDEX IF NOT EXISTS idx_imoveis_corretor        ON imoveis (corretor_id);
CREATE INDEX IF NOT EXISTS idx_imoveis_captador        ON imoveis (captador_id);
CREATE INDEX IF NOT EXISTS idx_imoveis_gerente         ON imoveis (gerente_id);
CREATE INDEX IF NOT EXISTS idx_imoveis_venda           ON imoveis (venda_id);
CREATE INDEX IF NOT EXISTS idx_imoveis_empreendimento  ON imoveis (empreendimento_legado_id);
CREATE INDEX IF NOT EXISTS idx_imoveis_valor_venda     ON imoveis (valor_venda)     WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_imoveis_valor_locacao   ON imoveis (valor_locacao)   WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_imoveis_dormitorios     ON imoveis (dormitorios)     WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_imoveis_oportunidade    ON imoveis (oportunidade_score DESC) WHERE deleted_at IS NULL AND ativo;
CREATE INDEX IF NOT EXISTS idx_imoveis_created_at      ON imoveis (created_at DESC);

COMMENT ON TABLE  imoveis IS 'Carteira profissional de imóveis (independe de venda). Soft delete via deleted_at.';
COMMENT ON COLUMN imoveis.origem_carteira IS 'AVULSO | EMPREENDIMENTO | TERCEIRO | CAPTADO — empreendimento/unidade vivem na API legada.';
COMMENT ON COLUMN imoveis.qualidade_score IS '0..100, recalculado pela API a cada gravação (services/imovel-qualidade.service.js).';

-- ---------------------------------------------------------------------
-- 2. CARACTERÍSTICAS
--    Catálogo + vínculo. Novas características não exigem ALTER TABLE.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS caracteristicas (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  slug        VARCHAR(60)  NOT NULL,
  label       VARCHAR(120) NOT NULL,
  grupo       VARCHAR(40)  NOT NULL DEFAULT 'IMOVEL',   -- IMOVEL | CONDOMINIO | LAZER | SEGURANCA
  ordem       SMALLINT     NOT NULL DEFAULT 0,
  ativo       BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMP    NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMP    NOT NULL DEFAULT NOW(),

  CONSTRAINT ux_caracteristicas_slug UNIQUE (slug)
);

CREATE TABLE IF NOT EXISTS imovel_caracteristicas (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  imovel_id         UUID NOT NULL REFERENCES imoveis(id) ON DELETE CASCADE,
  caracteristica_id UUID REFERENCES caracteristicas(id) ON DELETE SET NULL,
  slug              VARCHAR(60)  NOT NULL,   -- desnormalizado: sobrevive à remoção do catálogo
  label             VARCHAR(120) NOT NULL,
  grupo             VARCHAR(40)  NOT NULL DEFAULT 'IMOVEL',
  valor             VARCHAR(120),            -- opcional (ex.: "2" churrasqueiras)
  created_at        TIMESTAMP    NOT NULL DEFAULT NOW(),

  CONSTRAINT ux_imovel_caracteristica UNIQUE (imovel_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_imovel_caracteristicas_imovel ON imovel_caracteristicas (imovel_id);
CREATE INDEX IF NOT EXISTS idx_imovel_caracteristicas_slug   ON imovel_caracteristicas (slug);

-- ---------------------------------------------------------------------
-- 3. MÍDIAS (MinIO)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS imovel_midias (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  imovel_id       UUID NOT NULL REFERENCES imoveis(id) ON DELETE CASCADE,

  tipo            VARCHAR(15)  NOT NULL DEFAULT 'IMAGEM',   -- IMAGEM | VIDEO | TOUR_360 | PLANTA | DOCUMENTO
  bucket          VARCHAR(80)  NOT NULL,
  object_key      VARCHAR(400) NOT NULL,                    -- imoveis/{imovelId}/{mediaId}/original.ext
  object_key_web  VARCHAR(400),                             -- .../large.webp
  object_key_thumb VARCHAR(400),                            -- .../thumb.webp

  url             TEXT         NOT NULL,
  url_web         TEXT,
  url_thumb       TEXT,
  url_externa     TEXT,                                     -- YouTube / tour 360 (não vai para o MinIO)

  mime_type       VARCHAR(80),
  extensao        VARCHAR(10),
  tamanho_bytes   BIGINT,
  largura         INTEGER,
  altura          INTEGER,
  processamento   VARCHAR(20)  NOT NULL DEFAULT 'PENDENTE', -- PENDENTE | COMPLETO | ORIGINAL_ONLY | ERRO
  processamento_erro TEXT,

  legenda         VARCHAR(160),
  alt_text        VARCHAR(200),
  ordem           SMALLINT     NOT NULL DEFAULT 0,
  capa            BOOLEAN      NOT NULL DEFAULT FALSE,
  publica         BOOLEAN      NOT NULL DEFAULT TRUE,       -- entra em feed/página pública

  created_by      UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  created_at      TIMESTAMP    NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMP    NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_imovel_midias_tipo
    CHECK (tipo IN ('IMAGEM', 'VIDEO', 'TOUR_360', 'PLANTA', 'DOCUMENTO')),

  CONSTRAINT chk_imovel_midias_processamento
    CHECK (processamento IN ('PENDENTE', 'COMPLETO', 'ORIGINAL_ONLY', 'ERRO'))
);

CREATE INDEX IF NOT EXISTS idx_imovel_midias_imovel ON imovel_midias (imovel_id, ordem);

-- No máximo uma capa por imóvel.
CREATE UNIQUE INDEX IF NOT EXISTS ux_imovel_midias_capa
  ON imovel_midias (imovel_id) WHERE capa;

CREATE UNIQUE INDEX IF NOT EXISTS ux_imovel_midias_object_key
  ON imovel_midias (bucket, object_key);

-- ---------------------------------------------------------------------
-- 4. VISIBILIDADE (quando imoveis.visibilidade = 'SELECIONADOS' ou 'FILIAL')
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS imovel_visibilidades (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  imovel_id   UUID NOT NULL REFERENCES imoveis(id) ON DELETE CASCADE,
  usuario_id  UUID REFERENCES usuarios(id) ON DELETE CASCADE,
  filial_id   UUID REFERENCES filiais(id)  ON DELETE CASCADE,
  created_at  TIMESTAMP NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_imovel_visibilidade_alvo
    CHECK (usuario_id IS NOT NULL OR filial_id IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_imovel_visibilidade_usuario
  ON imovel_visibilidades (imovel_id, usuario_id) WHERE usuario_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_imovel_visibilidade_filial
  ON imovel_visibilidades (imovel_id, filial_id) WHERE filial_id IS NOT NULL;

-- ---------------------------------------------------------------------
-- 5. FAVORITOS DO CORRETOR
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS imovel_favoritos (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  imovel_id   UUID NOT NULL REFERENCES imoveis(id)  ON DELETE CASCADE,
  usuario_id  UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  created_at  TIMESTAMP NOT NULL DEFAULT NOW(),

  CONSTRAINT ux_imovel_favorito UNIQUE (imovel_id, usuario_id)
);

CREATE INDEX IF NOT EXISTS idx_imovel_favoritos_usuario ON imovel_favoritos (usuario_id);

-- ---------------------------------------------------------------------
-- 6. AUDITORIA DO IMÓVEL
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS imovel_logs (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  imovel_id      UUID NOT NULL REFERENCES imoveis(id) ON DELETE CASCADE,
  usuario_id     UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  usuario_nome   VARCHAR(180),
  acao           VARCHAR(40)  NOT NULL,   -- CRIACAO | EDICAO | PRECO | STATUS | ATIVACAO | DESATIVACAO
                                          -- MIDIA | PUBLICACAO_PORTAL | REMOCAO_PORTAL | EXCLUSAO
  resumo         VARCHAR(400),
  campo          VARCHAR(80),
  valor_anterior TEXT,
  valor_novo     TEXT,
  criado_em      TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_imovel_logs_imovel ON imovel_logs (imovel_id, criado_em DESC);

-- ---------------------------------------------------------------------
-- 7. PORTAIS (catálogo) e INTEGRAÇÕES (configuração por portal)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS portais (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  slug            VARCHAR(40)  NOT NULL,
  nome            VARCHAR(120) NOT NULL,
  descricao       VARCHAR(400),
  -- FEED_XML: geramos um XML público consumido pelo portal
  -- API:      publicação ativa via API do portal
  -- HIBRIDO:  feed + API
  modo_integracao VARCHAR(20)  NOT NULL DEFAULT 'FEED_XML',
  -- IMPLEMENTADO             : adapter completo conforme documentação oficial
  -- PARCIAL                  : adapter gera saída oficial, parte do fluxo depende do portal
  -- PENDING_CONFIGURATION    : adapter pronto, faltam credenciais/homologação
  -- PENDING_SPECIFICATION    : não há especificação pública suficiente
  status_implementacao VARCHAR(30) NOT NULL DEFAULT 'PENDING_CONFIGURATION',
  documentacao_url VARCHAR(300),
  ordem           SMALLINT     NOT NULL DEFAULT 0,
  ativo           BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMP    NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMP    NOT NULL DEFAULT NOW(),

  CONSTRAINT ux_portais_slug UNIQUE (slug),
  CONSTRAINT chk_portais_modo
    CHECK (modo_integracao IN ('FEED_XML', 'API', 'HIBRIDO')),
  CONSTRAINT chk_portais_status_impl
    CHECK (status_implementacao IN ('IMPLEMENTADO', 'PARCIAL', 'PENDING_CONFIGURATION', 'PENDING_SPECIFICATION'))
);

CREATE TABLE IF NOT EXISTS portal_integracoes (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  portal_id           UUID NOT NULL REFERENCES portais(id) ON DELETE CASCADE,
  filial_id           UUID REFERENCES filiais(id) ON DELETE SET NULL,   -- NULL = configuração global

  habilitado          BOOLEAN      NOT NULL DEFAULT FALSE,
  status              VARCHAR(30)  NOT NULL DEFAULT 'PENDING_CONFIGURATION',

  -- Token do feed público: /public/feeds/:portalSlug/:token.xml
  feed_token          VARCHAR(64),
  feed_habilitado     BOOLEAN      NOT NULL DEFAULT FALSE,

  -- Dados de contato exigidos pelos formatos oficiais (VRSync Header/ContactInfo).
  contato_nome        VARCHAR(180),
  contato_email       VARCHAR(180),
  contato_telefone    VARCHAR(40),
  contato_site        VARCHAR(200),
  contato_logo_url    VARCHAR(300),
  contato_cidade      VARCHAR(120),
  contato_uf          CHAR(2),
  contato_bairro      VARCHAR(120),
  contato_endereco    VARCHAR(200),
  contato_cep         VARCHAR(9),

  -- Credenciais: NUNCA retornadas pela API. Guardadas cifradas
  -- (AES-256-GCM, chave em INTEGRACOES_CRYPTO_KEY).
  credenciais_cifradas TEXT,
  credenciais_resumo   JSONB NOT NULL DEFAULT '{}'::jsonb,  -- só metadados: {"client_id":"abc***","atualizado_em":"..."}

  -- Configuração não sensível do adapter (limites, mapeamentos, defaults).
  config              JSONB        NOT NULL DEFAULT '{}'::jsonb,

  ultima_sincronizacao TIMESTAMP,
  ultimo_erro          TEXT,
  ultimo_teste_em      TIMESTAMP,
  ultimo_teste_ok      BOOLEAN,

  created_by          UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  updated_by          UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  created_at          TIMESTAMP    NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMP    NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_portal_integracoes_status
    CHECK (status IN ('ATIVO', 'INATIVO', 'ERRO', 'PENDING_CONFIGURATION', 'PENDING_SPECIFICATION'))
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_portal_integracao_global
  ON portal_integracoes (portal_id) WHERE filial_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_portal_integracao_filial
  ON portal_integracoes (portal_id, filial_id) WHERE filial_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_portal_integracao_feed_token
  ON portal_integracoes (feed_token) WHERE feed_token IS NOT NULL;

COMMENT ON COLUMN portal_integracoes.credenciais_cifradas IS
  'AES-256-GCM. Chave em INTEGRACOES_CRYPTO_KEY (env). Nunca exposta por endpoint.';

-- ---------------------------------------------------------------------
-- 8. PUBLICAÇÃO POR IMÓVEL / PORTAL
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS imovel_portais (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  imovel_id            UUID NOT NULL REFERENCES imoveis(id) ON DELETE CASCADE,
  portal_id            UUID NOT NULL REFERENCES portais(id) ON DELETE CASCADE,

  habilitado           BOOLEAN      NOT NULL DEFAULT FALSE,
  status               VARCHAR(25)  NOT NULL DEFAULT 'NAO_PUBLICADO',
  tipo_publicacao      VARCHAR(20)  NOT NULL DEFAULT 'STANDARD',  -- VRSync PublicationType

  external_id          VARCHAR(120),
  external_url         TEXT,

  erros                JSONB        NOT NULL DEFAULT '[]'::jsonb, -- [{campo, mensagem}]
  ultima_validacao_em  TIMESTAMP,
  ultima_sincronizacao TIMESTAMP,
  ultimo_erro          TEXT,

  created_at           TIMESTAMP    NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMP    NOT NULL DEFAULT NOW(),

  CONSTRAINT ux_imovel_portal UNIQUE (imovel_id, portal_id),
  CONSTRAINT chk_imovel_portais_status
    CHECK (status IN ('NAO_PUBLICADO', 'AGUARDANDO', 'PUBLICADO', 'ERRO', 'REMOVIDO', 'INVALIDO'))
);

CREATE INDEX IF NOT EXISTS idx_imovel_portais_portal  ON imovel_portais (portal_id, habilitado, status);
CREATE INDEX IF NOT EXISTS idx_imovel_portais_imovel  ON imovel_portais (imovel_id);

-- ---------------------------------------------------------------------
-- 9. LOG DE SINCRONIZAÇÃO
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS portal_sync_logs (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  portal_id    UUID REFERENCES portais(id)  ON DELETE SET NULL,
  portal_slug  VARCHAR(40),
  imovel_id    UUID REFERENCES imoveis(id) ON DELETE SET NULL,

  operacao     VARCHAR(30)  NOT NULL,   -- FEED | PUBLISH | UPDATE | DEACTIVATE | VALIDATE | TEST | IMPORT_LEADS
  status       VARCHAR(20)  NOT NULL,   -- OK | ERRO | AVISO | IGNORADO
  mensagem     TEXT,
  external_id  VARCHAR(120),
  request_id   VARCHAR(80),
  detalhes     JSONB,                   -- payload JÁ sanitizado (sem tokens/senhas)
  duracao_ms   INTEGER,

  usuario_id   UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  executado_em TIMESTAMP    NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_portal_sync_logs_status
    CHECK (status IN ('OK', 'ERRO', 'AVISO', 'IGNORADO'))
);

CREATE INDEX IF NOT EXISTS idx_portal_sync_logs_portal ON portal_sync_logs (portal_id, executado_em DESC);
CREATE INDEX IF NOT EXISTS idx_portal_sync_logs_imovel ON portal_sync_logs (imovel_id, executado_em DESC);

COMMENT ON COLUMN portal_sync_logs.detalhes IS
  'Payload sanitizado. É proibido gravar token, senha ou secret aqui (utils/sanitize.js).';

-- ---------------------------------------------------------------------
-- 10. LEADS DE PORTAIS / SITE PÚBLICO
--     Camada de ENTRADA independente do CRM legado (jmapi).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS portal_leads (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  portal_id             UUID REFERENCES portais(id)  ON DELETE SET NULL,
  portal_slug           VARCHAR(40),
  origem                VARCHAR(30)  NOT NULL DEFAULT 'SITE',  -- SITE | PORTAL | LANDING | MANUAL

  imovel_id             UUID REFERENCES imoveis(id) ON DELETE SET NULL,
  imovel_codigo         VARCHAR(30),

  nome                  VARCHAR(180),
  email                 VARCHAR(180),
  telefone              VARCHAR(40),
  mensagem              TEXT,

  external_lead_id      VARCHAR(120),
  external_listing_id   VARCHAR(120),

  pagina                VARCHAR(300),
  utm_source            VARCHAR(120),
  utm_medium            VARCHAR(120),
  utm_campaign          VARCHAR(160),
  utm_content           VARCHAR(160),
  utm_term              VARCHAR(160),
  referer               VARCHAR(300),
  ip_hash               VARCHAR(64),          -- hash, nunca o IP puro
  user_agent            VARCHAR(300),

  payload_original      JSONB,                -- sanitizado

  -- Solicitações de captação enviadas pelo proprietário ----------------
  tipo_lead             VARCHAR(30)  NOT NULL DEFAULT 'INTERESSE_IMOVEL',
  captacao_status       VARCHAR(25),
  captacao_observacoes  TEXT,
  captacao_contatado_em TIMESTAMP,
  captacao_aprovada_em  TIMESTAMP,
  captacao_recusada_em  TIMESTAMP,
  captacao_convertida_em TIMESTAMP,
  captacao_imovel_id    UUID REFERENCES imoveis(id) ON DELETE SET NULL,
  captacao_atualizada_por UUID REFERENCES usuarios(id) ON DELETE SET NULL,

  -- Ciclo de vida / distribuição
  status_processamento  VARCHAR(25)  NOT NULL DEFAULT 'RECEBIDO',
  erro_processamento    TEXT,
  responsavel_id        UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  filial_id             UUID REFERENCES filiais(id)  ON DELETE SET NULL,
  atribuido_em          TIMESTAMP,
  primeiro_atendimento_em TIMESTAMP,
  encaminhado_crm_em    TIMESTAMP,
  crm_referencia        VARCHAR(120),

  recebido_em           TIMESTAMP    NOT NULL DEFAULT NOW(),
  created_at            TIMESTAMP    NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMP    NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_portal_leads_origem
    CHECK (origem IN ('SITE', 'PORTAL', 'LANDING', 'MANUAL')),

  CONSTRAINT chk_portal_leads_status
    CHECK (status_processamento IN ('RECEBIDO', 'VALIDADO', 'ATRIBUIDO', 'ENCAMINHADO', 'DUPLICADO', 'ERRO', 'DESCARTADO'))
);

-- Idempotência: um mesmo externalLeadId do mesmo portal não vira 15 leads.
CREATE UNIQUE INDEX IF NOT EXISTS ux_portal_leads_external
  ON portal_leads (portal_slug, external_lead_id)
  WHERE external_lead_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_portal_leads_imovel      ON portal_leads (imovel_id, recebido_em DESC);
CREATE INDEX IF NOT EXISTS idx_portal_leads_responsavel ON portal_leads (responsavel_id, status_processamento);
CREATE INDEX IF NOT EXISTS idx_portal_leads_recebido    ON portal_leads (recebido_em DESC);
CREATE INDEX IF NOT EXISTS idx_portal_leads_portal      ON portal_leads (portal_slug, recebido_em DESC);
CREATE INDEX IF NOT EXISTS idx_portal_leads_captacao
  ON portal_leads (captacao_status, recebido_em DESC)
  WHERE tipo_lead = 'CAPTACAO_IMOVEL';

-- ---------------------------------------------------------------------
-- 11. SOLICITAÇÕES DE DEMONSTRAÇÃO (landing page comercial)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS demo_solicitacoes (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  nome              VARCHAR(180) NOT NULL,
  empresa           VARCHAR(180),
  telefone          VARCHAR(40),
  email             VARCHAR(180),
  cidade            VARCHAR(120),
  qtd_corretores    VARCHAR(40),
  mensagem          TEXT,

  origem            VARCHAR(60)  NOT NULL DEFAULT 'LANDING',
  pagina            VARCHAR(300),
  utm_source        VARCHAR(120),
  utm_medium        VARCHAR(120),
  utm_campaign      VARCHAR(160),
  utm_content       VARCHAR(160),
  utm_term          VARCHAR(160),
  referer           VARCHAR(300),
  ip_hash           VARCHAR(64),
  user_agent        VARCHAR(300),

  status            VARCHAR(20)  NOT NULL DEFAULT 'NOVO',   -- NOVO | EM_CONTATO | CONVERTIDO | DESCARTADO
  observacoes       TEXT,

  created_at        TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMP NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_demo_status CHECK (status IN ('NOVO', 'EM_CONTATO', 'CONVERTIDO', 'DESCARTADO'))
);

CREATE INDEX IF NOT EXISTS idx_demo_solicitacoes_created ON demo_solicitacoes (created_at DESC);

-- ---------------------------------------------------------------------
-- 12. SEQUÊNCIA DO CÓDIGO DO IMÓVEL (GL000001, GL000002, ...)
-- ---------------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS imoveis_codigo_seq START WITH 1 INCREMENT BY 1;

-- ---------------------------------------------------------------------
-- 13. CARGA INICIAL — catálogo de portais e características
--     (dados de configuração do produto, não dados de cliente)
-- ---------------------------------------------------------------------
INSERT INTO portais (slug, nome, descricao, modo_integracao, status_implementacao, documentacao_url, ordem)
VALUES
  ('grupo-olx',      'Grupo OLX (ZAP Imóveis / Viva Real)',
   'Publicação via feed XML no formato oficial VRSync. Processamento do portal a cada 12h.',
   'FEED_XML', 'IMPLEMENTADO', 'https://developers.grupozap.com/feeds/xml-formats/', 10),

  ('olx',            'OLX',
   'Feed XML no formato oficial OLX para imóveis. A publicação via API autoupload exige OAuth com escopo autoupload.',
   'HIBRIDO',  'PARCIAL', 'https://developers.olx.com.br/anuncio/home.html', 20),

  ('chaves-na-mao',  'Chaves na Mão',
   'Feed XML no formato oficial documentado pelo portal. URL do feed deve ser cadastrada junto ao portal.',
   'FEED_XML', 'IMPLEMENTADO', 'https://tecnologiacnm.github.io/cnm-xml-documentation/', 30),

  ('imovelweb',      'Imovelweb',
   'Sem especificação pública de feed/API. Adapter preparado, aguardando documentação oficial do portal.',
   'FEED_XML', 'PENDING_SPECIFICATION', NULL, 40)
ON CONFLICT (slug) DO UPDATE
SET nome                 = EXCLUDED.nome,
    descricao            = EXCLUDED.descricao,
    modo_integracao      = EXCLUDED.modo_integracao,
    status_implementacao = EXCLUDED.status_implementacao,
    documentacao_url     = EXCLUDED.documentacao_url,
    ordem                = EXCLUDED.ordem,
    updated_at           = NOW();

INSERT INTO caracteristicas (slug, label, grupo, ordem) VALUES
  ('varanda',            'Varanda',              'IMOVEL',     10),
  ('varanda-gourmet',    'Varanda gourmet',      'IMOVEL',     11),
  ('sacada',             'Sacada',               'IMOVEL',     12),
  ('closet',             'Closet',               'IMOVEL',     13),
  ('despensa',           'Despensa',             'IMOVEL',     14),
  ('area-servico',       'Área de serviço',      'IMOVEL',     15),
  ('cozinha-planejada',  'Cozinha planejada',    'IMOVEL',     16),
  ('ar-condicionado',    'Ar-condicionado',      'IMOVEL',     17),
  ('aquecimento-solar',  'Aquecimento solar',    'IMOVEL',     18),
  ('churrasqueira',      'Churrasqueira',        'IMOVEL',     19),
  ('lareira',            'Lareira',              'IMOVEL',     20),
  ('piscina',            'Piscina',              'LAZER',      30),
  ('academia',           'Academia',             'LAZER',      31),
  ('salao-festas',       'Salão de festas',      'LAZER',      32),
  ('playground',         'Playground',           'LAZER',      33),
  ('quadra',             'Quadra poliesportiva', 'LAZER',      34),
  ('espaco-gourmet',     'Espaço gourmet',       'LAZER',      35),
  ('sauna',              'Sauna',                'LAZER',      36),
  ('coworking',          'Espaço coworking',     'LAZER',      37),
  ('portaria-24h',       'Portaria 24h',         'SEGURANCA',  50),
  ('seguranca',          'Segurança',            'SEGURANCA',  51),
  ('circuito-cameras',   'Circuito de câmeras',  'SEGURANCA',  52),
  ('portao-eletronico',  'Portão eletrônico',    'SEGURANCA',  53),
  ('condominio-fechado', 'Condomínio fechado',   'CONDOMINIO', 60),
  ('elevador-social',    'Elevador social',      'CONDOMINIO', 61),
  ('gerador',            'Gerador',              'CONDOMINIO', 62),
  ('acessibilidade',     'Acessibilidade',       'CONDOMINIO', 63)
ON CONFLICT (slug) DO UPDATE
SET label      = EXCLUDED.label,
    grupo      = EXCLUDED.grupo,
    ordem      = EXCLUDED.ordem,
    updated_at = NOW();

COMMIT;

-- =====================================================================
-- FIM. Nada aqui foi executado automaticamente.
-- =====================================================================
