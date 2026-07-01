require('dotenv').config();

const pool = require('../src/config/db');

async function main() {
  console.log('Iniciando migration ajustes cliente Gold Leste...');

  await pool.query('BEGIN');

  try {
    await pool.query(`
      ALTER TABLE vendas
        ADD COLUMN IF NOT EXISTS captador_id UUID NULL REFERENCES usuarios(id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS captador_nome VARCHAR(255),
        ADD COLUMN IF NOT EXISTS captador_tipo VARCHAR(30),
        ADD COLUMN IF NOT EXISTS captador_parceiro_nome VARCHAR(255),
        ADD COLUMN IF NOT EXISTS captacao_observacao TEXT,
        ADD COLUMN IF NOT EXISTS puxador_id UUID NULL REFERENCES usuarios(id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS puxador_nome VARCHAR(255),
        ADD COLUMN IF NOT EXISTS puxador_tipo VARCHAR(30),
        ADD COLUMN IF NOT EXISTS puxador_parceiro_nome VARCHAR(255),
        ADD COLUMN IF NOT EXISTS puxador_observacao TEXT,
        ADD COLUMN IF NOT EXISTS status_financeiro_comissao VARCHAR(30) DEFAULT 'Não pago';
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS venda_logs (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        venda_id UUID NOT NULL REFERENCES vendas(id) ON DELETE CASCADE,
        usuario_id UUID REFERENCES usuarios(id) ON DELETE SET NULL,
        usuario_nome VARCHAR(255),
        acao VARCHAR(50) NOT NULL,
        campo VARCHAR(100),
        valor_anterior TEXT,
        valor_novo TEXT,
        dados_anteriores JSONB,
        dados_novos JSONB,
        criado_em TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_vendas_captador_id ON vendas(captador_id);
      CREATE INDEX IF NOT EXISTS idx_vendas_puxador_id ON vendas(puxador_id);
      CREATE INDEX IF NOT EXISTS idx_venda_logs_venda_id ON venda_logs(venda_id);
      CREATE INDEX IF NOT EXISTS idx_venda_logs_criado_em ON venda_logs(criado_em);
    `);

    await pool.query(`
      UPDATE vendas
      SET
        captador_tipo = CASE
          WHEN captacao = 'Sim' AND captador_tipo IS NULL THEN 'corretor'
          ELSE captador_tipo
        END,
        puxador_tipo = CASE
          WHEN fechador = 'Sim' AND puxador_tipo IS NULL THEN 'corretor'
          ELSE puxador_tipo
        END,
        status_financeiro_comissao = COALESCE(status_financeiro_comissao, 'Não pago')
      WHERE captador_tipo IS NULL
         OR puxador_tipo IS NULL
         OR status_financeiro_comissao IS NULL;
    `);

    await pool.query('COMMIT');
    console.log('Migration concluída com sucesso.');
  } catch (error) {
    await pool.query('ROLLBACK');
    console.error('Erro na migration:', error);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();
