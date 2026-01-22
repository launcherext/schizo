/**
 * Quick test script for velocity tracker
 * Run with: npx ts-node src/test-velocity.ts
 */

import { velocityTracker } from './signals/velocity-tracker';
import { config } from './config/settings';

const TEST_MINT = 'TestToken123pump';

console.log('\n=== Velocity Tracker Test ===\n');
console.log('Config thresholds:', config.velocityEntry);

// Test 1: No trades - should fail
console.log('\n--- Test 1: No trades ---');
let result = velocityTracker.hasGoodVelocity(TEST_MINT, 5);
console.log('Result:', result.hasGoodVelocity ? 'PASS' : 'FAIL');
console.log('Reason:', result.reason);

// Test 2: Add some trades but not enough
console.log('\n--- Test 2: Only 3 trades (below threshold) ---');
velocityTracker.recordTrade({ mint: TEST_MINT, txType: 'buy', traderPublicKey: 'wallet1', marketCapSol: 5 });
velocityTracker.recordTrade({ mint: TEST_MINT, txType: 'buy', traderPublicKey: 'wallet2', marketCapSol: 5 });
velocityTracker.recordTrade({ mint: TEST_MINT, txType: 'buy', traderPublicKey: 'wallet3', marketCapSol: 5 });

result = velocityTracker.hasGoodVelocity(TEST_MINT, 5);
console.log('Result:', result.hasGoodVelocity ? 'PASS' : 'FAIL');
console.log('Reason:', result.reason);
console.log('Metrics:', result.metrics ? {
  txCount: result.metrics.txCount,
  uniqueBuyers: result.metrics.uniqueBuyers.size,
  buyPressure: (result.metrics.buyPressure * 100).toFixed(0) + '%'
} : null);

// Test 3: Add enough trades with good buy pressure
console.log('\n--- Test 3: 6 trades, 4 buyers, 83% buys ---');
velocityTracker.recordTrade({ mint: TEST_MINT, txType: 'buy', traderPublicKey: 'wallet4', marketCapSol: 5 });
velocityTracker.recordTrade({ mint: TEST_MINT, txType: 'buy', traderPublicKey: 'wallet1', marketCapSol: 5 }); // repeat buyer
velocityTracker.recordTrade({ mint: TEST_MINT, txType: 'sell', traderPublicKey: 'seller1', marketCapSol: 5 });

result = velocityTracker.hasGoodVelocity(TEST_MINT, 5);
console.log('Result:', result.hasGoodVelocity ? 'PASS' : 'FAIL');
console.log('Reason:', result.reason);
console.log('Metrics:', result.metrics ? {
  txCount: result.metrics.txCount,
  uniqueBuyers: result.metrics.uniqueBuyers.size,
  buyPressure: (result.metrics.buyPressure * 100).toFixed(0) + '%'
} : null);

// Test 4: Too high market cap
console.log('\n--- Test 4: Market cap too high (15 SOL > 10 SOL limit) ---');
result = velocityTracker.hasGoodVelocity(TEST_MINT, 15);
console.log('Result:', result.hasGoodVelocity ? 'PASS' : 'FAIL');
console.log('Reason:', result.reason);

// Test 5: Low buy pressure (too many sells)
console.log('\n--- Test 5: Low buy pressure scenario ---');
const TEST_MINT2 = 'TestToken456pump';
velocityTracker.recordTrade({ mint: TEST_MINT2, txType: 'buy', traderPublicKey: 'wallet1', marketCapSol: 5 });
velocityTracker.recordTrade({ mint: TEST_MINT2, txType: 'buy', traderPublicKey: 'wallet2', marketCapSol: 5 });
velocityTracker.recordTrade({ mint: TEST_MINT2, txType: 'sell', traderPublicKey: 'wallet3', marketCapSol: 5 });
velocityTracker.recordTrade({ mint: TEST_MINT2, txType: 'sell', traderPublicKey: 'wallet4', marketCapSol: 5 });
velocityTracker.recordTrade({ mint: TEST_MINT2, txType: 'sell', traderPublicKey: 'wallet5', marketCapSol: 5 });

result = velocityTracker.hasGoodVelocity(TEST_MINT2, 5);
console.log('Result:', result.hasGoodVelocity ? 'PASS' : 'FAIL');
console.log('Reason:', result.reason);
console.log('Metrics:', result.metrics ? {
  txCount: result.metrics.txCount,
  uniqueBuyers: result.metrics.uniqueBuyers.size,
  buyPressure: (result.metrics.buyPressure * 100).toFixed(0) + '%'
} : null);

// Test 6: Perfect scenario
console.log('\n--- Test 6: Perfect entry scenario ---');
const TEST_MINT3 = 'PerfectToken789pump';
for (let i = 0; i < 8; i++) {
  velocityTracker.recordTrade({ mint: TEST_MINT3, txType: 'buy', traderPublicKey: `buyer${i}`, marketCapSol: 3 });
}
velocityTracker.recordTrade({ mint: TEST_MINT3, txType: 'sell', traderPublicKey: 'seller1', marketCapSol: 3 });
velocityTracker.recordTrade({ mint: TEST_MINT3, txType: 'sell', traderPublicKey: 'seller2', marketCapSol: 3 });

result = velocityTracker.hasGoodVelocity(TEST_MINT3, 3);
console.log('Result:', result.hasGoodVelocity ? 'PASS' : 'FAIL');
console.log('Reason:', result.reason);
console.log('Metrics:', result.metrics ? {
  txCount: result.metrics.txCount,
  uniqueBuyers: result.metrics.uniqueBuyers.size,
  uniqueSellers: result.metrics.uniqueSellers.size,
  buyPressure: (result.metrics.buyPressure * 100).toFixed(0) + '%',
  txPerMinute: result.metrics.txPerMinute.toFixed(1)
} : null);

console.log('\n=== Test Complete ===\n');
