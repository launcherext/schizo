const https = require('https');

const WALLET = 'GDh3oZJLhCbBXSvVJ97xqbvSwVKERe3P9bsVQ7ayBVdv';
const url = `https://api.helius.xyz/v0/addresses/${WALLET}/transactions?api-key=dd091d8d-f7eb-4d3c-83fc-87cc3232f4f6&limit=50`;

console.log('Fetching:', url);

https.get(url, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    console.log('Status:', res.statusCode);
    console.log('Response length:', data.length);

    try {
      const txs = JSON.parse(data);
      console.log('Number of transactions:', txs.length);

      if (txs.length > 0) {
        console.log('\nFirst transaction sample:');
        console.log(JSON.stringify(txs[0], null, 2));
      } else {
        console.log('\nRaw response:', data.substring(0, 500));
      }
    } catch (e) {
      console.log('Parse error:', e.message);
      console.log('Raw:', data.substring(0, 500));
    }
  });
}).on('error', e => console.error('Request error:', e));
