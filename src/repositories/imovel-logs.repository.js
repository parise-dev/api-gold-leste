const pool = require('../config/db');

/**
 * Auditoria do imóvel. Não é event sourcing: guardamos quem, quando,
 * que tipo de alteração e um resumo legível.
 */
async function registrar(
  { imovelId, usuario, acao, resumo, campo = null, valorAnterior = null, valorNovo = null },
  client = pool
) {
  if (!imovelId || !acao) return null;

  const result = await client.query(
    `
    INSERT INTO imovel_logs (
      imovel_id, usuario_id, usuario_nome, acao, resumo, campo, valor_anterior, valor_novo
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING id
    `,
    [
      imovelId,
      usuario?.id || null,
      usuario?.nome || null,
      acao,
      resumo ? String(resumo).slice(0, 400) : null,
      campo,
      valorAnterior === null || valorAnterior === undefined ? null : String(valorAnterior).slice(0, 2000),
      valorNovo === null || valorNovo === undefined ? null : String(valorNovo).slice(0, 2000)
    ]
  );

  return result.rows[0];
}

/** Diff campo a campo para registrar apenas o que realmente mudou. */
const CAMPOS_AUDITADOS = {
  status: 'STATUS',
  ativo: 'ATIVACAO',
  valor_venda: 'PRECO',
  valor_locacao: 'PRECO',
  oportunidade: 'EDICAO',
  destaque: 'EDICAO',
  exclusivo: 'EDICAO',
  lancamento: 'EDICAO',
  visibilidade: 'EDICAO',
  corretor_id: 'EDICAO',
  publicar_site: 'EDICAO'
};

const ROTULOS = {
  status: 'Status comercial',
  ativo: 'Ativo',
  valor_venda: 'Valor de venda',
  valor_locacao: 'Valor de locação',
  oportunidade: 'Oportunidade',
  destaque: 'Destaque',
  exclusivo: 'Exclusivo',
  lancamento: 'Lançamento',
  visibilidade: 'Visibilidade',
  corretor_id: 'Corretor responsável',
  publicar_site: 'Publicar no site'
};

async function registrarAlteracoes({ imovelId, usuario, anterior, novo }, client = pool) {
  if (!anterior || !novo) return;

  for (const [campo, acao] of Object.entries(CAMPOS_AUDITADOS)) {
    const de = anterior[campo];
    const para = novo[campo];

    const iguais = de === para || String(de ?? '') === String(para ?? '');
    if (iguais) continue;

    let acaoFinal = acao;

    if (campo === 'ativo') {
      acaoFinal = para ? 'ATIVACAO' : 'DESATIVACAO';
    }

    await registrar(
      {
        imovelId,
        usuario,
        acao: acaoFinal,
        resumo: `${ROTULOS[campo] || campo}: ${de ?? '—'} → ${para ?? '—'}`,
        campo,
        valorAnterior: de,
        valorNovo: para
      },
      client
    );
  }
}

async function listar(imovelId, limite = 50) {
  const result = await pool.query(
    `
    SELECT id, usuario_id, usuario_nome, acao, resumo, campo,
           valor_anterior, valor_novo, criado_em
    FROM imovel_logs
    WHERE imovel_id = $1
    ORDER BY criado_em DESC
    LIMIT $2
    `,
    [imovelId, Math.min(Number(limite) || 50, 200)]
  );

  return result.rows;
}

module.exports = { registrar, registrarAlteracoes, listar };
