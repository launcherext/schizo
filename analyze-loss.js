const https = require('https');

const WALLET = 'GDh3oZJLhCbBXSvVJ97xqbvSwVKERe3P9bsVQ7ayBVdv';
const url = `https://api.helius.xyz/v0/addresses/${WALLET}/transactions?api-key=dd091d8d-f7eb-4d3c-83fc-87cc3232f4f6&limit=50`;

https.get(url, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    const txs = JSON.parse(data);
    let totalSolOut = 0;
    let totalSolIn = 0;
    let totalFees = 0;

    console.log('=== ANALYZING TRANSACTIONS ===\n');

    const swaps = [];

    txs.forEach((tx, i) => {
      const fee = tx.fee / 1e9;
      totalFees += fee;

      let solOut = 0;
      let solIn = 0;

      // Check native transfers
      if (tx.nativeTransfers) {
        tx.nativeTransfers.forEach(nt => {
          const amt = nt.amount / 1e9;
          if (nt.fromUserAccount === WALLET) {
            solOut += amt;
            totalSolOut += amt;
          }
          if (nt.toUserAccount === WALLET) {
            solIn += amt;
            totalSolIn += amt;
          }
        });
      }

      // Track swaps
      if (tx.type === 'SWAP') {
        swaps.push({
          index: i + 1,
          description: (tx.description || 'No description').substring(0, 80),
          fee: fee,
          solOut: solOut,
          solIn: solIn,
          net: solIn - solOut - fee,
          tokenTransfers: tx.tokenTransfers || []
        });
      }
    });

    // Show all swaps with their P/L
    console.log('=== SWAP DETAILS ===\n');
    swaps.forEach(s => {
      console.log(`[${s.index}] ${s.description}`);
      console.log(`    SOL Out: ${s.solOut.toFixed(6)}, SOL In: ${s.solIn.toFixed(6)}, Fee: ${s.fee.toFixed(6)}`);
      console.log(`    Net: ${s.net.toFixed(6)} SOL`);
      if (s.tokenTransfers.length > 0) {
        s.tokenTransfers.forEach(tt => {
          const dir = tt.fromUserAccount === WALLET ? 'SOLD' : 'BOUGHT';
          console.log(`    Token ${dir}: ${tt.tokenAmount} of ${tt.mint.substring(0,8)}...`);
        });
      }
      console.log('');
    });

    console.log('=== SUMMARY ===');
    console.log(`Total SOL OUT: ${totalSolOut.toFixed(6)} SOL`);
    console.log(`Total SOL IN:  ${totalSolIn.toFixed(6)} SOL`);
    console.log(`Total Fees:    ${totalFees.toFixed(6)} SOL`);
    console.log(`Net P/L:       ${(totalSolIn - totalSolOut - totalFees).toFixed(6)} SOL`);

    // Group by token
    console.log('\n=== BY TOKEN ===');
    const byToken = {};
    swaps.forEach(s => {
      s.tokenTransfers.forEach(tt => {
        const mint = tt.mint;
        if (!byToken[mint]) {
          byToken[mint] = { bought: 0, sold: 0, solSpent: 0, solReceived: 0, fees: 0 };
        }
        if (tt.fromUserAccount === WALLET) {
          byToken[mint].sold += tt.tokenAmount;
          byToken[mint].solReceived += s.solIn;
        } else {
          byToken[mint].bought += tt.tokenAmount;
          byToken[mint].solSpent += s.solOut;
        }
        byToken[mint].fees += s.fee;
      });
    });

    Object.entries(byToken).forEach(([mint, data]) => {
      const net = data.solReceived - data.solSpent - data.fees;
      console.log(`\n${mint.substring(0,12)}...`);
      console.log(`  SOL Spent: ${data.solSpent.toFixed(6)}, Received: ${data.solReceived.toFixed(6)}`);
      console.log(`  P/L: ${net.toFixed(6)} SOL (${net >= 0 ? 'PROFIT' : 'LOSS'})`);
    });
  });
}).on('error', console.error);
