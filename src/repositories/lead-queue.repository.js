const pool = require('../config/db');
const config = require('../config/lead-distribution.config');

/**
 * Acesso a dados da fila de distribuição de leads.
 *
 * Regras de leitura que valem para TODAS as consultas daqui:
 *   - só participa quem tem perfil da fila (config.PERFIS_NA_FILA);
 *   - só participa quem está `ativo` no cadastro;
 *   - só participa quem está online (heartbeat dentro da janela);
 *   - a ordem é sempre `lead_fila_corretores.ordem ASC` — nunca nome,
 *     nunca quantidade de leads, nunca performance.
 */

// ---------------------------------------------------------------------
// DISPONIBILIDADE DO SCHEMA
//
// A API pode subir ANTES de sql/20260830_fila_leads.sql ser executado.
// Enquanto as estruturas não existirem, a fila fica desligada e o sistema
// continua funcionando exatamente como antes — nada de erro 500 na
// captação de lead ou no login por causa de tabela ausente.
// ---------------------------------------------------------------------
let filaDisponivelCache = null;
let filaVerificacaoEmAndamento = null;

async function filaDisponivel() {
  if (filaDisponivelCache !== null) return filaDisponivelCache;

  if (!filaVerificacaoEmAndamento) {
    filaVerificacaoEmAndamento = (async () => {
      try {
        const result = await pool.query(`
          SELECT
            to_regclass('public.lead_fila_corretores') IS NOT NULL AS tem_fila,
            to_regclass('public.lead_distribuicao_logs') IS NOT NULL AS tem_logs,
            EXISTS (
              SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public'
                AND table_name = 'usuarios'
                AND column_name = 'ultima_atividade_em'
            ) AS tem_presenca,
            EXISTS (
              SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public'
                AND table_name = 'portal_leads'
                AND column_name = 'distribuicao_pendente_desde'
            ) AS tem_colunas_lead
        `);

        const linha = result.rows[0];

        filaDisponivelCache =
          !!linha.tem_fila && !!linha.tem_logs && !!linha.tem_presenca && !!linha.tem_colunas_lead;

        if (!filaDisponivelCache) {
          console.warn(
            '[fila-leads] Estruturas ausentes. Execute sql/20260830_fila_leads.sql. ' +
              'A distribuição por fila permanece DESLIGADA até lá.'
          );
        }
      } catch (error) {
        console.error('[fila-leads] Falha ao verificar o schema da fila:', error.message);
        filaDisponivelCache = false;
      } finally {
        filaVerificacaoEmAndamento = null;
      }

      return filaDisponivelCache;
    })();
  }

  return filaVerificacaoEmAndamento;
}

/** Usado pelos testes/rotas para forçar nova verificação após a migration. */
function reavaliarDisponibilidade() {
  filaDisponivelCache = null;
}

/** Fragmento reutilizado: condição de "corretor elegível e online". */
const CONDICAO_ELEGIVEL = `
  f.na_fila
  AND u.ativo
  AND u.perfil = ANY($1::text[])
  AND u.ultima_atividade_em IS NOT NULL
  AND u.ultima_atividade_em > NOW() - ($2::int * INTERVAL '1 second')
`;

function parametrosElegibilidade() {
  return [config.PERFIS_NA_FILA, config.PRESENCA_TIMEOUT_SEGUNDOS];
}

// ---------------------------------------------------------------------
// PRESENÇA
// ---------------------------------------------------------------------

/**
 * Registra heartbeat e mantém a fila coerente.
 *
 * Se o usuário estava offline (sem heartbeat ou fora da janela), ele
 * entra no FIM da fila — nunca recupera a posição antiga. Se já estava
 * online, a posição é preservada.
 *
 * Retorna { online, entrouNaFila, perfil, ativo } ou null se o usuário
 * não existir.
 */
async function registrarPresenca(usuarioId) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const anterior = await client.query(
      `
      SELECT id, perfil, ativo, ultima_atividade_em
      FROM usuarios
      WHERE id = $1
      FOR UPDATE
      `,
      [usuarioId]
    );

    if (!anterior.rows.length) {
      await client.query('ROLLBACK');
      return null;
    }

    const usuario = anterior.rows[0];

    await client.query(
      `UPDATE usuarios SET ultima_atividade_em = NOW() WHERE id = $1`,
      [usuarioId]
    );

    const participa = config.PERFIS_NA_FILA.includes(usuario.perfil) && usuario.ativo;

    if (!participa) {
      await client.query('COMMIT');

      return {
        perfil: usuario.perfil,
        ativo: usuario.ativo,
        naFila: false,
        entrouNaFila: false
      };
    }

    const ultima = usuario.ultima_atividade_em
      ? new Date(usuario.ultima_atividade_em).getTime()
      : null;

    const estavaOnline =
      ultima !== null && Date.now() - ultima <= config.PRESENCA_TIMEOUT_SEGUNDOS * 1000;

    const resultado = await client.query(
      `
      INSERT INTO lead_fila_corretores (usuario_id, ordem, na_fila, entrou_em)
      VALUES ($1, nextval('lead_fila_ordem_seq'), TRUE, NOW())
      ON CONFLICT (usuario_id) DO UPDATE
      SET
        ordem = CASE
                  WHEN $2::boolean THEN lead_fila_corretores.ordem
                  ELSE nextval('lead_fila_ordem_seq')
                END,
        entrou_em = CASE
                      WHEN $2::boolean THEN lead_fila_corretores.entrou_em
                      ELSE NOW()
                    END,
        na_fila = TRUE,
        saiu_em = NULL,
        updated_at = NOW()
      RETURNING ordem, (xmax = 0) AS inserido
      `,
      [usuarioId, estavaOnline]
    );

    await client.query('COMMIT');

    return {
      perfil: usuario.perfil,
      ativo: usuario.ativo,
      naFila: true,
      entrouNaFila: !estavaOnline,
      ordem: Number(resultado.rows[0].ordem)
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Logout / saída explícita: some da fila imediatamente, sem esperar o
 * timeout. Quando voltar, entra no fim (a posição é regravada no
 * próximo heartbeat porque `na_fila` volta a TRUE com nova ordem).
 */
async function marcarOffline(usuarioId) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    await client.query(
      `UPDATE usuarios SET ultima_atividade_em = NULL WHERE id = $1`,
      [usuarioId]
    );

    await client.query(
      `
      UPDATE lead_fila_corretores
      SET na_fila = FALSE,
          saiu_em = NOW(),
          updated_at = NOW()
      WHERE usuario_id = $1
      `,
      [usuarioId]
    );

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------
// LEITURA DA FILA
// ---------------------------------------------------------------------

/**
 * Fila atual, na ordem real de recebimento.
 * Traz leads do dia por corretor (dado existente, não estimado).
 */
async function listarFila(client = pool) {
  const result = await client.query(
    `
    SELECT
      f.usuario_id,
      f.ordem,
      f.entrou_em,
      f.ultimo_lead_em,
      f.ultimo_lead_id,
      f.total_leads,
      u.nome,
      u.email,
      u.creci,
      u.telefone,
      u.filial_id,
      u.ultima_atividade_em,
      (
        SELECT COUNT(*)::int
        FROM portal_leads pl
        WHERE pl.responsavel_id = f.usuario_id
          AND pl.atribuido_em >= date_trunc('day', NOW())
      ) AS leads_hoje
    FROM lead_fila_corretores f
    JOIN usuarios u ON u.id = f.usuario_id
    WHERE ${CONDICAO_ELEGIVEL}
    ORDER BY f.ordem ASC
    `,
    parametrosElegibilidade()
  );

  return result.rows;
}

/** Quantidade de corretores elegíveis e online neste instante. */
async function contarOnline(client = pool) {
  const result = await client.query(
    `
    SELECT COUNT(*)::int AS total
    FROM lead_fila_corretores f
    JOIN usuarios u ON u.id = f.usuario_id
    WHERE ${CONDICAO_ELEGIVEL}
    `,
    parametrosElegibilidade()
  );

  return result.rows[0].total;
}

/**
 * Próximo corretor elegível.
 * Usado tanto para "espiar" (peek) quanto dentro da transação de
 * distribuição — nesse caso recebe o client da transação.
 */
async function proximoElegivel(client = pool) {
  const result = await client.query(
    `
    SELECT f.usuario_id, f.ordem, u.nome, u.filial_id
    FROM lead_fila_corretores f
    JOIN usuarios u ON u.id = f.usuario_id
    WHERE ${CONDICAO_ELEGIVEL}
    ORDER BY f.ordem ASC
    LIMIT 1
    `,
    parametrosElegibilidade()
  );

  return result.rows[0] || null;
}

/** Posição (1-based) do corretor na fila no momento da consulta. */
async function posicaoNaFila(usuarioId, client = pool) {
  const result = await client.query(
    `
    SELECT posicao FROM (
      SELECT f.usuario_id,
             ROW_NUMBER() OVER (ORDER BY f.ordem ASC)::int AS posicao
      FROM lead_fila_corretores f
      JOIN usuarios u ON u.id = f.usuario_id
      WHERE ${CONDICAO_ELEGIVEL}
    ) AS fila
    WHERE usuario_id = $3
    `,
    [...parametrosElegibilidade(), usuarioId]
  );

  return result.rows[0] ? Number(result.rows[0].posicao) : null;
}

// ---------------------------------------------------------------------
// ESCRITA
// ---------------------------------------------------------------------

/** Move o corretor para o fim da fila e registra o lead recebido. */
async function moverParaFim({ usuarioId, leadId }, client = pool) {
  await client.query(
    `
    UPDATE lead_fila_corretores
    SET ordem = nextval('lead_fila_ordem_seq'),
        ultimo_lead_id = COALESCE($2, ultimo_lead_id),
        ultimo_lead_em = NOW(),
        total_leads = total_leads + 1,
        updated_at = NOW()
    WHERE usuario_id = $1
    `,
    [usuarioId, leadId || null]
  );
}

/** Garante linha na fila para um corretor (usado na atribuição manual). */
async function garantirNaFila(usuarioId, client = pool) {
  await client.query(
    `
    INSERT INTO lead_fila_corretores (usuario_id, ordem, na_fila, entrou_em)
    VALUES ($1, nextval('lead_fila_ordem_seq'), TRUE, NOW())
    ON CONFLICT (usuario_id) DO NOTHING
    `,
    [usuarioId]
  );
}

async function registrarLog(dados, client = pool) {
  const result = await client.query(
    `
    INSERT INTO lead_distribuicao_logs (
      lead_id, usuario_id, usuario_nome, posicao, tipo,
      origem_lead, portal_slug, imovel_id,
      alterado_por, alterado_por_nome, corretores_online, motivo
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    RETURNING *
    `,
    [
      dados.leadId || null,
      dados.usuarioId || null,
      dados.usuarioNome || null,
      dados.posicao ?? null,
      dados.tipo,
      dados.origemLead || null,
      dados.portalSlug || null,
      dados.imovelId || null,
      dados.alteradoPor || null,
      dados.alteradoPorNome || null,
      dados.corretoresOnline ?? null,
      dados.motivo || null
    ]
  );

  return result.rows[0];
}

// ---------------------------------------------------------------------
// LEADS PENDENTES E MÉTRICAS
// ---------------------------------------------------------------------

/** Leads que chegaram sem corretor disponível, mais antigos primeiro. */
async function leadsPendentes(limite = 25, client = pool) {
  const result = await client.query(
    `
    SELECT pl.id, pl.nome, pl.email, pl.telefone, pl.origem, pl.portal_slug,
           pl.imovel_id, pl.imovel_codigo, pl.recebido_em,
           pl.distribuicao_pendente_desde,
           i.titulo AS imovel_titulo
    FROM portal_leads pl
    LEFT JOIN imoveis i ON i.id = pl.imovel_id
    WHERE pl.responsavel_id IS NULL
      AND COALESCE((to_jsonb(pl)->>'operacao_gerenciada')::boolean, FALSE)=FALSE
      AND pl.distribuicao_pendente_desde IS NOT NULL
      AND pl.status_processamento NOT IN ('DESCARTADO', 'DUPLICADO')
    ORDER BY pl.distribuicao_pendente_desde ASC
    LIMIT $1
    `,
    [Math.min(Number(limite) || 25, 200)]
  );

  return result.rows;
}

async function contarPendentes(client = pool) {
  const result = await client.query(
    `
    SELECT COUNT(*)::int AS total
    FROM portal_leads
    WHERE responsavel_id IS NULL
      AND COALESCE((to_jsonb(portal_leads)->>'operacao_gerenciada')::boolean, FALSE)=FALSE
      AND distribuicao_pendente_desde IS NOT NULL
      AND status_processamento NOT IN ('DESCARTADO', 'DUPLICADO')
    `
  );

  return result.rows[0].total;
}

async function metricasDoDia(client = pool) {
  const result = await client.query(
    `
    SELECT
      (
        SELECT COUNT(*)::int
        FROM lead_distribuicao_logs
        WHERE criado_em >= date_trunc('day', NOW())
          AND tipo IN ('AUTOMATICA', 'REDISTRIBUICAO')
      ) AS distribuidos_hoje,
      (
        SELECT COUNT(*)::int
        FROM lead_distribuicao_logs
        WHERE criado_em >= date_trunc('day', NOW())
          AND tipo = 'MANUAL'
      ) AS manuais_hoje,
      (
        SELECT COUNT(*)::int
        FROM portal_leads
        WHERE recebido_em >= date_trunc('day', NOW())
      ) AS recebidos_hoje,
      (
        SELECT MAX(criado_em)
        FROM lead_distribuicao_logs
        WHERE tipo IN ('AUTOMATICA', 'REDISTRIBUICAO', 'MANUAL')
      ) AS ultima_distribuicao_em
    `
  );

  return result.rows[0];
}

async function historico({ limite = 50, usuarioId = null, leadId = null } = {}) {
  const params = [];
  const where = ['1 = 1'];

  if (usuarioId) {
    params.push(usuarioId);
    where.push(`l.usuario_id = $${params.length}`);
  }

  if (leadId) {
    params.push(leadId);
    where.push(`l.lead_id = $${params.length}`);
  }

  params.push(Math.min(Number(limite) || 50, 200));

  const result = await pool.query(
    `
    SELECT l.*,
           pl.nome  AS lead_nome,
           pl.origem AS lead_origem,
           pl.imovel_codigo
    FROM lead_distribuicao_logs l
    LEFT JOIN portal_leads pl ON pl.id = l.lead_id
    WHERE ${where.join(' AND ')}
    ORDER BY l.criado_em DESC
    LIMIT $${params.length}
    `,
    params
  );

  return result.rows;
}

module.exports = {
  filaDisponivel,
  reavaliarDisponibilidade,
  registrarPresenca,
  marcarOffline,
  listarFila,
  contarOnline,
  proximoElegivel,
  posicaoNaFila,
  moverParaFim,
  garantirNaFila,
  registrarLog,
  leadsPendentes,
  contarPendentes,
  metricasDoDia,
  historico
};
