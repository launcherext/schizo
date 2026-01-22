const { Client } = require('pg');

const client = new Client({
  connectionString: 'postgresql://postgres:NajctWeCLYaSywSNHKxkWElcSbTsDSPc@caboose.proxy.rlwy.net:58182/railway'
});

async function checkEquity() {
  await client.connect();

  // Check equity snapshots
  console.log('=== EQUITY SNAPSHOTS ===\n');
  try {
    const equity = await client.query(`
      SELECT * FROM equity_snapshots ORDER BY timestamp DESC LIMIT 20
    `);
    if (equity.rows.length === 0) {
      console.log('No equity snapshots found');
    } else {
      equity.rows.forEach((e, i) => {
        console.log(`${i+1}. ${e.timestamp}: ${JSON.stringify(e)}`);
      });
    }
  } catch (e) {
    console.log('Error:', e.message);
  }

  // Check wallet sync log
  console.log('\n=== WALLET SYNC LOG ===\n');
  try {
    const sync = await client.query(`
      SELECT * FROM wallet_sync_log ORDER BY timestamp DESC LIMIT 20
    `);
    if (sync.rows.length === 0) {
      console.log('No wallet sync logs found');
    } else {
      sync.rows.forEach((s, i) => {
        console.log(`${i+1}. ${JSON.stringify(s)}`);
      });
    }
  } catch (e) {
    console.log('Error:', e.message);
  }

  // Check daily stats
  console.log('\n=== DAILY STATS ===\n');
  try {
    const stats = await client.query(`
      SELECT * FROM daily_stats ORDER BY date DESC LIMIT 10
    `);
    if (stats.rows.length === 0) {
      console.log('No daily stats found');
    } else {
      stats.rows.forEach((s, i) => {
        console.log(`${i+1}. ${s.date}: ${JSON.stringify(s)}`);
      });
    }
  } catch (e) {
    console.log('Error:', e.message);
  }

  // Check partial_closes
  console.log('\n=== PARTIAL CLOSES ===\n');
  try {
    const closes = await client.query(`
      SELECT * FROM partial_closes ORDER BY timestamp DESC LIMIT 20
    `);
    if (closes.rows.length === 0) {
      console.log('No partial closes found');
    } else {
      closes.rows.forEach((c, i) => {
        console.log(`${i+1}. ${JSON.stringify(c)}`);
      });
    }
  } catch (e) {
    console.log('Error:', e.message);
  }

  // Check config table for paper trading setting
  console.log('\n=== CONFIG ===\n');
  try {
    const config = await client.query(`SELECT * FROM config`);
    config.rows.forEach(c => console.log(`${c.key}: ${c.value}`));
  } catch (e) {
    console.log('Error:', e.message);
  }

  await client.end();
}

checkEquity().catch(console.error);
