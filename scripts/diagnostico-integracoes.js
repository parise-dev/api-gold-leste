// Somente leitura. Não executa migrações, imports, seeds ou acesso aos portais.
require('dotenv').config();
const pool = require('../src/config/db');
const meta = require('../src/services/meta.service');
async function main() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SET LOCAL statement_timeout='10s'");
    const carteira = await client.query(`SELECT count(*)::int AS cadastrados,
      count(*) FILTER(WHERE deleted_at IS NULL AND ativo)::int AS ativos FROM imoveis`);
    const portais = await client.query(`SELECT p.slug, pi.habilitado,pi.feed_habilitado,
      (pi.feed_token IS NOT NULL) AS possui_token,
      count(ip.id) FILTER(WHERE ip.habilitado)::int AS selecionados
      FROM portais p LEFT JOIN portal_integracoes pi ON pi.portal_id=p.id AND pi.filial_id IS NULL
      LEFT JOIN imovel_portais ip ON ip.portal_id=p.id
      GROUP BY p.slug,pi.habilitado,pi.feed_habilitado,pi.feed_token ORDER BY p.slug`);
    const schema = await client.query("SELECT to_regclass('public.meta_conexoes') IS NOT NULL AS meta, to_regclass('public.portal_feed_versoes') IS NOT NULL AS feed_seguro");
    console.log(JSON.stringify({ carteira: carteira.rows[0], portais: portais.rows, schema: schema.rows[0], meta: meta.diagnostico() }, null, 2));
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}
main().catch(e => { console.error('Diagnóstico indisponível:', e.code || 'ERRO', e.code === 'ECONNREFUSED' ? 'Banco recusou a conexão.' : 'Confira acesso ao banco e as migrações.'); process.exitCode=1; }).finally(()=>pool.end());
