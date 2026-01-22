const { Client } = require('pg');

const client = new Client({
  connectionString: 'postgresql://postgres:NajctWeCLYaSywSNHKxkWElcSbTsDSPc@caboose.proxy.rlwy.net:58182/railway'
});

async function analyze() {
  await client.connect();

  // Get all trades with details
  const result = await client.query(`
    SELECT
      id,
      mint,
      symbol,
      action,
      entry_price,
      exit_price,
      amount,
      amount_sol,
      entry_time,
      exit_time,
      pnl_sol,
      pnl_percent,
      exit_reason,
      fees
    FROM trades
    ORDER BY entry_time DESC
    LIMIT 50
  `);

  console.log('=== TRADE HISTORY ===\n');

  let totalBuys = 0;
  let totalSells = 0;
  let totalPnL = 0;
  let totalFees = 0;

  result.rows.forEach((t, i) => {
    const action = t.action === 0 ? 'BUY' : 'SELL';
    console.log(`[${i+1}] ${action} - ${t.symbol || t.mint.substring(0,12)}...`);
    console.log(`    SOL: ${parseFloat(t.amount_sol || 0).toFixed(6)}, Tokens: ${parseFloat(t.amount || 0).toFixed(2)}`);
    console.log(`    Entry: ${t.entry_price}, Exit: ${t.exit_price || 'N/A'}`);
    console.log(`    P/L: ${parseFloat(t.pnl_sol || 0).toFixed(6)} SOL (${parseFloat(t.pnl_percent || 0).toFixed(2)}%)`);
    console.log(`    Reason: ${t.exit_reason || 'N/A'}, Fees: ${parseFloat(t.fees || 0).toFixed(6)}`);
    console.log(`    Time: ${t.entry_time}`);
    console.log('');

    if (t.action === 0) { // BUY
      totalBuys += parseFloat(t.amount_sol || 0);
    } else { // SELL
      totalSells += parseFloat(t.amount_sol || 0);
    }
    totalPnL += parseFloat(t.pnl_sol || 0);
    totalFees += parseFloat(t.fees || 0);
  });

  console.log('=== TRADE SUMMARY ===');
  console.log(`Total SOL spent on buys: ${totalBuys.toFixed(6)} SOL`);
  console.log(`Total SOL from sells: ${totalSells.toFixed(6)} SOL`);
  console.log(`Recorded P/L sum: ${totalPnL.toFixed(6)} SOL`);
  console.log(`Total fees recorded: ${totalFees.toFixed(6)} SOL`);

  // Also check positions
  console.log('\n=== POSITIONS ===\n');
  const positions = await client.query(`
    SELECT
      id,
      mint,
      symbol,
      status,
      entry_price,
      current_price,
      amount,
      amount_sol,
      highest_price,
      lowest_price,
      entry_time,
      last_update
    FROM positions
    ORDER BY entry_time DESC
    LIMIT 20
  `);

  let positionBuys = 0;
  let openPositionValue = 0;

  positions.rows.forEach((p, i) => {
    const entrySol = parseFloat(p.amount_sol || 0);
    const tokens = parseFloat(p.amount || 0);
    const currentPrice = parseFloat(p.current_price || 0);
    const entryPrice = parseFloat(p.entry_price || 0);
    const currentValue = tokens * currentPrice;
    const pnl = entryPrice > 0 ? ((currentPrice - entryPrice) / entryPrice * 100) : 0;

    console.log(`[${i+1}] ${p.status.toUpperCase()} - ${p.symbol || p.mint.substring(0,12)}...`);
    console.log(`    Entry SOL: ${entrySol.toFixed(6)}, Tokens: ${tokens.toFixed(2)}`);
    console.log(`    Entry Price: ${entryPrice.toFixed(12)}, Current: ${currentPrice.toFixed(12)}`);
    console.log(`    High: ${p.highest_price}, Low: ${p.lowest_price}`);
    console.log(`    Unrealized P/L: ${pnl.toFixed(2)}%`);
    console.log(`    Entered: ${p.entry_time}`);
    console.log('');

    positionBuys += entrySol;
    if (p.status === 'open') {
      openPositionValue += currentValue;
    }
  });

  console.log('=== POSITION SUMMARY ===');
  console.log(`Total position entries: ${positionBuys.toFixed(6)} SOL`);
  console.log(`Open position token value (approx): ${openPositionValue.toFixed(6)} SOL`);

  // Count by status
  const statusCounts = await client.query(`
    SELECT status, COUNT(*) as count, SUM(amount_sol::numeric) as total_sol
    FROM positions
    GROUP BY status
  `);
  console.log('\n=== POSITION COUNTS ===');
  statusCounts.rows.forEach(r => {
    console.log(`  ${r.status}: ${r.count} positions, ${parseFloat(r.total_sol || 0).toFixed(6)} SOL`);
  });

  await client.end();
}

analyze().catch(console.error);
