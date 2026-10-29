/* eslint-disable no-console */
/**
 * Exporta/importa a carteira Kenlo e os imóveis compartilhados já publicados.
 *
 * Exportação (banco local):
 *   node scripts/migrar-carteira-producao.js --export tmp/kenlo-producao.json
 *
 * Importação (VPS, depois das migrations):
 *   node scripts/migrar-carteira-producao.js --import /tmp/kenlo-producao.json
 *
 * A importação é aditiva: nunca apaga nem atualiza imóveis já existentes.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const pool = require('../src/config/db');

const [modo, arquivoInformado] = process.argv.slice(2);
const arquivo = path.resolve(arquivoInformado || path.join('tmp', 'kenlo-producao.json'));
const referenciasAtivasPath = path.join(__dirname, 'kenlo-referencias-ativas.json');

function placeholders(total) {
  return Array.from({ length: total }, (_, indice) => `$${indice + 1}`).join(', ');
}

async function colunasDaTabela(client, tabela) {
  const resultado = await client.query(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1`,
    [tabela]
  );
  return new Set(resultado.rows.map((row) => row.column_name));
}

function registroFiltrado(registro, colunas, excluir = []) {
  const bloqueadas = new Set(excluir);
  return Object.fromEntries(
    Object.entries(registro).filter(([chave]) => colunas.has(chave) && !bloqueadas.has(chave))
  );
}

async function exportar() {
  const referenciasAtivas = JSON.parse(fs.readFileSync(referenciasAtivasPath, 'utf8'))
    .map((referencia) => String(referencia).trim().toUpperCase());

  if (new Set(referenciasAtivas).size !== 332) {
    throw new Error(`Lista ativa inválida: esperado 332, recebido ${new Set(referenciasAtivas).size}.`);
  }

  const imoveis = await pool.query(
    `SELECT *
       FROM imoveis
      WHERE deleted_at IS NULL
        AND (
          UPPER(referencia_externa) = ANY($1::text[])
          OR dados_kenlo->>'midiaOrigem' = 'Kenlo Imob'
        )
      ORDER BY created_at, id`,
    [referenciasAtivas]
  );

  // 613 imóveis da base da imobiliária + 20 compartilhados que já estavam
  // publicados no portal. Os dois registros locais sem referência ficam fora.
  if (imoveis.rows.length !== 633) {
    throw new Error(`Carteira inválida: esperado 633 imóveis com referência, recebido ${imoveis.rows.length}.`);
  }

  const ids = imoveis.rows.map((imovel) => imovel.id);
  const [midias, caracteristicas] = await Promise.all([
    pool.query(
      'SELECT * FROM imovel_midias WHERE imovel_id = ANY($1::uuid[]) ORDER BY imovel_id, ordem, created_at',
      [ids]
    ),
    pool.query(
      'SELECT * FROM imovel_caracteristicas WHERE imovel_id = ANY($1::uuid[]) ORDER BY imovel_id, slug',
      [ids]
    )
  ]);

  const payload = {
    versao: 1,
    geradoEm: new Date().toISOString(),
    origem: 'Gold Leste local - carteira Kenlo validada',
    totais: {
      imoveis: imoveis.rows.length,
      midias: midias.rows.length,
      caracteristicas: caracteristicas.rows.length
    },
    imoveis: imoveis.rows,
    midias: midias.rows,
    caracteristicas: caracteristicas.rows
  };

  fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  fs.writeFileSync(arquivo, JSON.stringify(payload));
  console.log(JSON.stringify({ arquivo, ...payload.totais }, null, 2));
}

async function localizarExistente(client, imovel) {
  const resultado = await client.query(
    `SELECT id
       FROM imoveis
      WHERE deleted_at IS NULL
        AND (
          ($1::text IS NOT NULL AND UPPER(referencia_externa) = UPPER($1))
          OR LOWER(codigo) = LOWER($2)
          OR LOWER(slug) = LOWER($3)
        )
      ORDER BY CASE WHEN $1::text IS NOT NULL AND UPPER(referencia_externa) = UPPER($1) THEN 0 ELSE 1 END
      LIMIT 1`,
    [imovel.referencia_externa || null, imovel.codigo, imovel.slug]
  );
  return resultado.rows[0]?.id || null;
}

async function inserirDinamico(client, tabela, registro) {
  const nomes = Object.keys(registro);
  const valores = Object.values(registro);
  const resultado = await client.query(
    `INSERT INTO ${tabela} (${nomes.map((nome) => `"${nome}"`).join(', ')})
     VALUES (${placeholders(nomes.length)})
     RETURNING id`,
    valores
  );
  return resultado.rows[0]?.id;
}

async function importar() {
  const payload = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
  if (payload?.versao !== 1 || !Array.isArray(payload.imoveis) || payload.imoveis.length !== 633) {
    throw new Error('Arquivo de carteira inválido ou incompleto.');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const administrador = await client.query(
      `SELECT id
         FROM usuarios
        WHERE perfil = 'admin' AND COALESCE(ativo, TRUE) = TRUE
        ORDER BY created_at
        LIMIT 1`
    );
    if (!administrador.rows[0]) throw new Error('Nenhum administrador ativo encontrado em produção.');
    const administradorId = administrador.rows[0].id;

    const colunasImoveis = await colunasDaTabela(client, 'imoveis');
    const colunasMidias = await colunasDaTabela(client, 'imovel_midias');
    const colunasCaracteristicas = await colunasDaTabela(client, 'imovel_caracteristicas');

    const mapaIds = new Map();
    const idsNovos = new Set();
    let criados = 0;
    let existentes = 0;

    for (const imovelOriginal of payload.imoveis) {
      const existenteId = await localizarExistente(client, imovelOriginal);
      if (existenteId) {
        mapaIds.set(imovelOriginal.id, existenteId);
        existentes += 1;
        continue;
      }

      const imovel = registroFiltrado(imovelOriginal, colunasImoveis);
      const colisaoId = await client.query('SELECT 1 FROM imoveis WHERE id = $1', [imovel.id]);
      if (colisaoId.rowCount) imovel.id = crypto.randomUUID();

      imovel.filial_id = null;
      imovel.corretor_id = null;
      imovel.captador_id = null;
      imovel.gerente_id = null;
      imovel.venda_id = null;
      imovel.created_by = administradorId;
      imovel.updated_by = administradorId;

      const novoId = await inserirDinamico(client, 'imoveis', imovel);
      mapaIds.set(imovelOriginal.id, novoId);
      idsNovos.add(imovelOriginal.id);
      criados += 1;
    }

    let midiasCriadas = 0;
    for (const midiaOriginal of payload.midias || []) {
      if (!idsNovos.has(midiaOriginal.imovel_id)) continue;
      const midia = registroFiltrado(midiaOriginal, colunasMidias, ['id']);
      midia.imovel_id = mapaIds.get(midiaOriginal.imovel_id);
      midia.created_by = administradorId;

      const duplicada = await client.query(
        'SELECT 1 FROM imovel_midias WHERE bucket = $1 AND object_key = $2',
        [midia.bucket, midia.object_key]
      );
      if (duplicada.rowCount) continue;
      await inserirDinamico(client, 'imovel_midias', midia);
      midiasCriadas += 1;
    }

    let caracteristicasCriadas = 0;
    for (const caracteristicaOriginal of payload.caracteristicas || []) {
      if (!idsNovos.has(caracteristicaOriginal.imovel_id)) continue;
      const caracteristica = registroFiltrado(caracteristicaOriginal, colunasCaracteristicas, ['id']);
      caracteristica.imovel_id = mapaIds.get(caracteristicaOriginal.imovel_id);
      // O catálogo é semeado independentemente em cada banco, portanto os UUIDs
      // não são portáveis. Slug/label/grupo preservam a característica sem FK.
      caracteristica.caracteristica_id = null;
      const nomes = Object.keys(caracteristica);
      const valores = Object.values(caracteristica);
      const resultado = await client.query(
        `INSERT INTO imovel_caracteristicas (${nomes.map((nome) => `"${nome}"`).join(', ')})
         VALUES (${placeholders(nomes.length)})
         ON CONFLICT (imovel_id, slug) DO NOTHING`,
        valores
      );
      caracteristicasCriadas += resultado.rowCount;
    }

    await client.query('COMMIT');
    console.log(JSON.stringify({
      arquivo,
      criados,
      existentes,
      midiasCriadas,
      caracteristicasCriadas
    }, null, 2));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  if (modo === '--export') return exportar();
  if (modo === '--import') return importar();
  throw new Error('Use --export ou --import seguido do caminho do arquivo.');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
