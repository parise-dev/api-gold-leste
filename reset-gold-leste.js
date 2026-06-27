let bcrypt;

try {
  bcrypt = require('bcryptjs');
} catch (error) {
  bcrypt = require('bcrypt');
}

let pool;

try {
  pool = require('./src/config/db');
} catch (error) {
  pool = require('./config/db');
}

const ADMIN = {
  nome: 'Victor Hilário',
  email: 'victor.admin@goldleste.com.br',
  senha: '123456',
  perfil: 'admin'
};

async function getUsuarioColumns(client) {
  const result = await client.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'usuarios'
  `);

  return result.rows.map((row) => row.column_name);
}

async function resetarBanco() {
  const client = await pool.connect();

  try {
    console.log('Iniciando reset do banco...');

    await client.query('BEGIN');

    await client.query(`
      DO $$
      DECLARE
        tabelas TEXT;
      BEGIN
        SELECT string_agg(format('%I.%I', schemaname, tablename), ', ')
        INTO tabelas
        FROM pg_tables
        WHERE schemaname = 'public'
          AND tablename NOT IN (
            'knex_migrations',
            'knex_migrations_lock',
            'SequelizeMeta'
          );

        IF tabelas IS NOT NULL THEN
          EXECUTE 'TRUNCATE TABLE ' || tabelas || ' RESTART IDENTITY CASCADE';
        END IF;
      END $$;
    `);

    const senhaHash = await bcrypt.hash(ADMIN.senha, 10);
    const columns = await getUsuarioColumns(client);

    const insertColumns = [];
    const values = [];
    const params = [];

    function addColumn(column, value) {
      if (!columns.includes(column)) {
        return;
      }

      insertColumns.push(column);

      if (value && value.__raw) {
        values.push(value.value);
        return;
      }

      params.push(value);
      values.push(`$${params.length}`);
    }

    addColumn('nome', ADMIN.nome);
    addColumn('email', ADMIN.email);
    addColumn('senha_hash', senhaHash);
    addColumn('perfil', ADMIN.perfil);
    addColumn('ativo', true);

    addColumn('primeiro_acesso', false);
    addColumn('deve_trocar_senha', false);

    addColumn('created_at', { __raw: true, value: 'NOW()' });
    addColumn('updated_at', { __raw: true, value: 'NOW()' });

    const insertSql = `
      INSERT INTO usuarios (${insertColumns.join(', ')})
      VALUES (${values.join(', ')})
      RETURNING id, nome, email, perfil, ativo
    `;

    const adminResult = await client.query(insertSql, params);

    await client.query('COMMIT');

    console.log('');
    console.log('Banco zerado com sucesso.');
    console.log('Admin criado:');
    console.table(adminResult.rows);
    console.log('');
    console.log('Login:', ADMIN.email);
    console.log('Senha:', ADMIN.senha);
    console.log('');
  } catch (error) {
    await client.query('ROLLBACK');

    console.error('Erro ao resetar banco:');
    console.error(error);

    process.exitCode = 1;
  } finally {
    client.release();

    if (pool.end) {
      await pool.end();
    }
  }
}

resetarBanco();