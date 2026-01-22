const { Client } = require('pg');

const client = new Client({
  connectionString: 'postgresql://postgres:NajctWeCLYaSywSNHKxkWElcSbTsDSPc@caboose.proxy.rlwy.net:58182/railway'
});

async function checkSchema() {
  await client.connect();

  // Get trades columns
  console.log('=== TRADES TABLE COLUMNS ===');
  const tradesSchema = await client.query(`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_name = 'trades'
    ORDER BY ordinal_position
  `);
  tradesSchema.rows.forEach(r => console.log(`  ${r.column_name}: ${r.data_type}`));

  // Get positions columns
  console.log('\n=== POSITIONS TABLE COLUMNS ===');
  const positionsSchema = await client.query(`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_name = 'positions'
    ORDER BY ordinal_position
  `);
  positionsSchema.rows.forEach(r => console.log(`  ${r.column_name}: ${r.data_type}`));

  await client.end();
}

checkSchema().catch(console.error);
