const pool = require('../config/db');
const filaRepo = require('../repositories/lead-queue.repository');
const config = require('../config/lead-distribution.config');
const { badRequest, notFound } = require('../utils/http-error');

/**
 * Distribuição sequencial de leads (fila circular / round-robin).
 *
 * CONCORRÊNCIA
 *   Toda distribuição roda dentro de UMA transação protegida por
 *   `pg_advisory_xact_lock`. Dois leads que chegam no mesmo instante são
 *   serializados pelo banco: o segundo só escolhe o próximo corretor
 *   depois que o primeiro já moveu o seu para o fim da fila.
 *
 *   Escolher o corretor + atribuir o lead + rotacionar a fila + gravar a
 *   auditoria acontecem na MESMA transação. Ou tudo acontece, ou nada.
 *
 *   O lead é gravado ANTES (transação própria da ingestão) e só então
 *   distribuído. Assim uma falha na distribuição nunca perde o lead —
 *   ele fica pendente e é distribuído quando houver corretor elegível.
 */

const LOCK_SQL = 'SELECT pg_advisory_xact_lock($1)';

// ---------------------------------------------------------------------
// PRESENÇA
// ---------------------------------------------------------------------

/**
 * Heartbeat. Retorna o estado do usuário na fila.
 * Se o corretor acabou de entrar online, tenta escoar leads pendentes.
 */
async function registrarPresenca(usuario) {
  if (!(await filaRepo.filaDisponivel())) {
    return { naFila: false, entrouNaFila: false, leadsPendentesDistribuidos: 0, indisponivel: true };
  }

  const estado = await filaRepo.registrarPresenca(usuario.id);

  if (!estado) {
    throw notFound('Usuário não encontrado.');
  }

  let distribuidos = 0;

  if (estado.naFila) {
    // Corretor voltou a ficar online, ou há leads que ficaram para trás
    // (ex.: falha momentânea de banco na hora em que o lead chegou).
    // A contagem usa índice parcial e é barata o bastante para o heartbeat.
    const pendentes = estado.entrouNaFila ? 1 : await filaRepo.contarPendentes();

    if (pendentes > 0) {
      distribuidos = (await distribuirPendentes()).length;
    }
  }

  return { ...estado, leadsPendentesDistribuidos: distribuidos };
}

async function registrarSaida(usuario) {
  if (!(await filaRepo.filaDisponivel())) return;

  await filaRepo.marcarOffline(usuario.id);
}

// ---------------------------------------------------------------------
// DISTRIBUIÇÃO
// ---------------------------------------------------------------------

/**
 * Marca o lead como aguardando corretor disponível.
 * Idempotente: só grava a primeira vez, para não reescrever o relógio
 * de espera a cada nova tentativa.
 */
async function marcarPendente(leadId, client) {
  await client.query(
    `
    UPDATE portal_leads
    SET distribuicao_pendente_desde = COALESCE(distribuicao_pendente_desde, NOW()),
        updated_at = NOW()
    WHERE id = $1
      AND responsavel_id IS NULL
    `,
    [leadId]
  );
}

/**
 * Distribui UM lead para o próximo corretor da fila.
 *
 * @returns {Promise<{atribuido: boolean, lead: object|null, corretor: object|null, motivo: string}>}
 */
async function distribuirLead(leadId, { tipo = 'AUTOMATICA', motivo = null } = {}) {
  if (!(await filaRepo.filaDisponivel())) {
    return { atribuido: false, lead: null, corretor: null, motivo: 'FILA_INDISPONIVEL' };
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query(LOCK_SQL, [config.LOCK_KEY_DISTRIBUICAO]);

    const leadResult = await client.query(
      `SELECT * FROM portal_leads WHERE id = $1 FOR UPDATE`,
      [leadId]
    );

    if (!leadResult.rows.length) {
      await client.query('ROLLBACK');
      return { atribuido: false, lead: null, corretor: null, motivo: 'LEAD_INEXISTENTE' };
    }

    const lead = leadResult.rows[0];

    // Já tem dono: nada a fazer. Protege contra corrida entre a
    // distribuição automática e uma atribuição manual simultânea.
    if (lead.responsavel_id) {
      await client.query('COMMIT');
      return { atribuido: false, lead, corretor: null, motivo: 'JA_ATRIBUIDO' };
    }

    const proximo = await filaRepo.proximoElegivel(client);

    if (!proximo) {
      const jaEstavaPendente = !!lead.distribuicao_pendente_desde;

      await marcarPendente(lead.id, client);

      if (!jaEstavaPendente) {
        await filaRepo.registrarLog(
          {
            leadId: lead.id,
            tipo: 'SEM_CORRETOR',
            origemLead: lead.origem,
            portalSlug: lead.portal_slug,
            imovelId: lead.imovel_id,
            corretoresOnline: 0,
            motivo: 'Nenhum corretor elegível online. Lead aguardando distribuição.'
          },
          client
        );
      }

      await client.query('COMMIT');

      return { atribuido: false, lead, corretor: null, motivo: 'SEM_CORRETOR_ONLINE' };
    }

    const online = await filaRepo.contarOnline(client);

    const atualizado = await client.query(
      `
      UPDATE portal_leads
      SET responsavel_id = $2,
          filial_id = COALESCE(filial_id, $3),
          atribuido_em = NOW(),
          status_processamento = CASE
            WHEN status_processamento IN ('RECEBIDO', 'VALIDADO') THEN 'ATRIBUIDO'
            ELSE status_processamento
          END,
          distribuicao_pendente_desde = NULL,
          distribuicao_tipo = $4,
          distribuicao_posicao = 1,
          updated_at = NOW()
      WHERE id = $1
      RETURNING *
      `,
      [lead.id, proximo.usuario_id, proximo.filial_id || null, tipo]
    );

    await filaRepo.moverParaFim({ usuarioId: proximo.usuario_id, leadId: lead.id }, client);

    await filaRepo.registrarLog(
      {
        leadId: lead.id,
        usuarioId: proximo.usuario_id,
        usuarioNome: proximo.nome,
        // Distribuição automática sempre entrega ao 1º da fila.
        posicao: 1,
        tipo,
        origemLead: lead.origem,
        portalSlug: lead.portal_slug,
        imovelId: lead.imovel_id,
        corretoresOnline: online,
        motivo
      },
      client
    );

    await client.query('COMMIT');

    return {
      atribuido: true,
      lead: atualizado.rows[0],
      corretor: { id: proximo.usuario_id, nome: proximo.nome },
      motivo: 'OK'
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Escoa a fila de leads que ficaram sem corretor.
 * Para no primeiro lead que não conseguir corretor — se não há ninguém
 * online, não adianta tentar os demais.
 */
async function distribuirPendentes({ limite = config.MAX_PENDENTES_POR_RODADA } = {}) {
  if (!(await filaRepo.filaDisponivel())) return [];

  const pendentes = await filaRepo.leadsPendentes(limite);
  const distribuidos = [];

  for (const pendente of pendentes) {
    const resultado = await distribuirLead(pendente.id, {
      tipo: 'REDISTRIBUICAO',
      motivo: 'Corretor ficou disponível; lead que aguardava foi distribuído.'
    });

    if (resultado.atribuido) {
      distribuidos.push(resultado);
      continue;
    }

    if (resultado.motivo === 'SEM_CORRETOR_ONLINE') break;
  }

  return distribuidos;
}

/**
 * Atribuição manual feita por gestor.
 *
 * NÃO rotaciona a fila automática de propósito: a decisão manual é uma
 * exceção pontual e não pode "gastar a vez" de quem está esperando nem
 * empurrar o escolhido para o fim. O evento fica registrado na auditoria
 * com o usuário que fez a alteração.
 */
async function atribuirManual({ leadId, usuarioId, usuario, motivo = null }) {
  if (!(await filaRepo.filaDisponivel())) {
    throw badRequest(
      'Fila de leads indisponível: execute sql/20260830_fila_leads.sql no banco para habilitar.'
    );
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query(LOCK_SQL, [config.LOCK_KEY_DISTRIBUICAO]);

    const leadResult = await client.query(
      `SELECT * FROM portal_leads WHERE id = $1 FOR UPDATE`,
      [leadId]
    );

    if (!leadResult.rows.length) {
      await client.query('ROLLBACK');
      throw notFound('Lead não encontrado.');
    }

    const lead = leadResult.rows[0];

    const destinoResult = await client.query(
      `SELECT id, nome, perfil, ativo, filial_id FROM usuarios WHERE id = $1 LIMIT 1`,
      [usuarioId]
    );

    if (!destinoResult.rows.length) {
      await client.query('ROLLBACK');
      throw notFound('Corretor não encontrado.');
    }

    const destino = destinoResult.rows[0];

    if (!destino.ativo) {
      await client.query('ROLLBACK');
      throw badRequest('Não é possível atribuir um lead para um usuário inativo.');
    }

    if (!config.PERFIS_NA_FILA.includes(destino.perfil)) {
      await client.query('ROLLBACK');
      throw badRequest(
        `Somente usuários com perfil ${config.PERFIS_NA_FILA.join('/')} podem receber leads.`
      );
    }

    // Garante que o corretor exista na fila para as próximas rodadas,
    // sem alterar a posição de ninguém.
    await filaRepo.garantirNaFila(destino.id, client);

    const posicao = await filaRepo.posicaoNaFila(destino.id, client);
    const online = await filaRepo.contarOnline(client);

    const atualizado = await client.query(
      `
      UPDATE portal_leads
      SET responsavel_id = $2,
          filial_id = COALESCE(filial_id, $3),
          atribuido_em = COALESCE(atribuido_em, NOW()),
          status_processamento = CASE
            WHEN status_processamento IN ('RECEBIDO', 'VALIDADO') THEN 'ATRIBUIDO'
            ELSE status_processamento
          END,
          distribuicao_pendente_desde = NULL,
          distribuicao_tipo = 'MANUAL',
          distribuicao_posicao = $4,
          updated_at = NOW()
      WHERE id = $1
      RETURNING *
      `,
      [lead.id, destino.id, destino.filial_id || null, posicao]
    );

    await filaRepo.registrarLog(
      {
        leadId: lead.id,
        usuarioId: destino.id,
        usuarioNome: destino.nome,
        posicao,
        tipo: 'MANUAL',
        origemLead: lead.origem,
        portalSlug: lead.portal_slug,
        imovelId: lead.imovel_id,
        alteradoPor: usuario?.id || null,
        alteradoPorNome: usuario?.nome || null,
        corretoresOnline: online,
        motivo:
          motivo ||
          (lead.responsavel_id
            ? 'Troca manual de responsável pelo gestor.'
            : 'Atribuição manual pelo gestor.')
      },
      client
    );

    await client.query('COMMIT');

    return { lead: atualizado.rows[0], corretor: { id: destino.id, nome: destino.nome }, posicao };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------
// PAINEL
// ---------------------------------------------------------------------

function mapearItemFila(row, indice) {
  return {
    posicao: indice + 1,
    usuarioId: row.usuario_id,
    nome: row.nome,
    iniciais: montarIniciais(row.nome),
    email: row.email || null,
    creci: row.creci || null,
    filialId: row.filial_id || null,
    online: true,
    entrouEm: row.entrou_em,
    ultimoLeadEm: row.ultimo_lead_em,
    ultimoLeadId: row.ultimo_lead_id,
    leadsHoje: Number(row.leads_hoje || 0),
    totalLeadsFila: Number(row.total_leads || 0)
  };
}

function montarIniciais(nome) {
  const partes = String(nome || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (!partes.length) return '--';
  if (partes.length === 1) return partes[0].slice(0, 2).toUpperCase();

  return `${partes[0][0]}${partes[partes.length - 1][0]}`.toUpperCase();
}

/** Estado completo consumido pelo painel de TV. */
async function estadoDaFila() {
  if (!(await filaRepo.filaDisponivel())) {
    return {
      atualizadoEm: new Date().toISOString(),
      configuracao: config.publico(),
      corretoresOnline: 0,
      fila: [],
      proximo: null,
      leadsAguardando: 0,
      indisponivel: true,
      mensagem:
        'Estruturas da fila ausentes no banco. Execute sql/20260830_fila_leads.sql para ativar.',
      metricas: {
        distribuidosHoje: 0,
        manuaisHoje: 0,
        recebidosHoje: 0,
        ultimaDistribuicaoEm: null
      }
    };
  }

  const [linhas, metricas, pendentes] = await Promise.all([
    filaRepo.listarFila(),
    filaRepo.metricasDoDia(),
    filaRepo.contarPendentes()
  ]);

  const fila = linhas.map(mapearItemFila);

  return {
    atualizadoEm: new Date().toISOString(),
    configuracao: config.publico(),
    corretoresOnline: fila.length,
    fila,
    proximo: fila[0] || null,
    leadsAguardando: pendentes,
    metricas: {
      distribuidosHoje: Number(metricas.distribuidos_hoje || 0),
      manuaisHoje: Number(metricas.manuais_hoje || 0),
      recebidosHoje: Number(metricas.recebidos_hoje || 0),
      ultimaDistribuicaoEm: metricas.ultima_distribuicao_em || null
    }
  };
}

function mapearHistorico(row) {
  return {
    id: row.id,
    leadId: row.lead_id,
    leadNome: row.lead_nome || null,
    leadOrigem: row.lead_origem || row.origem_lead || null,
    imovelCodigo: row.imovel_codigo || null,
    usuarioId: row.usuario_id,
    usuarioNome: row.usuario_nome,
    posicao: row.posicao,
    tipo: row.tipo,
    portalSlug: row.portal_slug,
    alteradoPor: row.alterado_por,
    alteradoPorNome: row.alterado_por_nome,
    corretoresOnline: row.corretores_online,
    motivo: row.motivo,
    criadoEm: row.criado_em
  };
}

module.exports = {
  registrarPresenca,
  registrarSaida,
  distribuirLead,
  distribuirPendentes,
  atribuirManual,
  estadoDaFila,
  mapearHistorico,
  montarIniciais
};
