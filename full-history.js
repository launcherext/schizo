const { Client } = require('pg');

const client = new Client({
  connectionString: 'postgresql://postgres:NajctWeCLYaSywSNHKxkWElcSbTsDSPc@caboose.proxy.rlwy.net:58182/railway'
});

async function fullHistory() {
  await client.connect();

  // Count all trades
  const tradeCount = await client.query(`SELECT COUNT(*) as count FROM trades`);
  console.log(`Total trades in DB: ${tradeCount.rows[0].count}`);

  // Count all positions
  const positionCount = await client.query(`SELECT COUNT(*) as count FROM positions`);
  console.log(`Total positions in DB: ${positionCount.rows[0].count}`);

  // Sum of all entry amounts
  const totalEntry = await client.query(`SELECT COALESCE(SUM(amount_sol::numeric), 0) as total FROM positions`);
  console.log(`Total SOL in positions: ${parseFloat(totalEntry.rows[0].total).toFixed(6)} SOL`);

  // Sum of all P/L
  const totalPnl = await client.query(`SELECT COALESCE(SUM(pnl_sol::numeric), 0) as total FROM trades`);
  console.log(`Total P/L in trades: ${parseFloat(totalPnl.rows[0].total).toFixed(6)} SOL`);

  // Get ALL trades, not just recent
  console.log('\n=== ALL TRADES ===\n');
  const allTrades = await client.query(`
    SELECT * FROM trades ORDER BY entry_time
  `);
  allTrades.rows.forEach((t, i) => {
    const action = t.action === 0 ? 'BUY' : 'SELL';
    console.log(`${i+1}. ${action} ${t.symbol || 'UNKNOWN'}: ${parseFloat(t.amount_sol || 0).toFixed(6)} SOL, P/L: ${parseFloat(t.pnl_sol || 0).toFixed(6)} (${t.exit_reason || 'N/A'})`);
  });

  // Get ALL positions
  console.log('\n=== ALL POSITIONS ===\n');
  const allPositions = await client.query(`
    SELECT * FROM positions ORDER BY entry_time
  `);
  allPositions.rows.forEach((p, i) => {
    console.log(`${i+1}. ${p.status} ${p.symbol || 'UNKNOWN'}: ${parseFloat(p.amount_sol || 0).toFixed(6)} SOL entry`);
  });

  // Check if there's a wallet_history table
  try {
    const walletHistory = await client.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
    `);
    console.log('\n=== ALL TABLES ===');
    walletHistory.rows.forEach(t => console.log(`  ${t.table_name}`));
  } catch (e) {
    console.log('Error checking tables:', e.message);
  }

  await client.end();
}

fullHistory().catch(console.error);
