/**
 * Manual Trigger - Dry Run Testing Without Real SOL
 *
 * This script allows testing the full pipeline:
 * Database -> Logic -> Events -> WebSocket -> Frontend
 *
 * WITHOUT spending any real SOL.
 *
 * Usage:
 *   npx tsx src/test/manual-trigger.ts --scan
 *   npx tsx src/test/manual-trigger.ts --buy
 *   npx tsx src/test/manual-trigger.ts --sell
 *   npx tsx src/test/manual-trigger.ts --mood paranoid
 *   npx tsx src/test/manual-trigger.ts --buyback
 *   npx tsx src/test/manual-trigger.ts --reward
 *
 * Or use curl to hit the simulation endpoints:
 *   curl -X POST http://localhost:3500/api/simulate/scan
 *   curl -X POST http://localhost:3500/api/simulate/trade -d '{"type":"BUY"}'
 *   curl -X POST http://localhost:3500/api/simulate/mood -d '{"mood":"PARANOID"}'
 */

import 'dotenv/config';
import { agentEvents } from '../events/emitter.js';
import type { ScanEvent, RejectEvent, MoodChangeEvent } from '../events/types.js';

/**
 * Generate a fake token mint address (looks real but isn't)
 */
function generateFakeMint(): string {
  const chars = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let result = '';
  for (let i = 0; i < 44; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/**
 * Generate a fake transaction signature
 */
function generateFakeSignature(): string {
  const chars = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let result = '';
  for (let i = 0; i < 88; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/**
 * Random token names for testing
 */
const FAKE_TOKENS = [
  { symbol: 'DOGE420', name: 'Doge 420 Moon' },
  { symbol: 'PEPEAI', name: 'Pepe Artificial Intelligence' },
  { symbol: 'BONKCAT', name: 'Bonk Cat' },
  { symbol: 'SCHIZOTEST', name: 'Schizo Test Token' },
  { symbol: 'FAKERUG', name: 'Definitely Not A Rug' },
  { symbol: 'MOON2025', name: 'Moon Mission 2025' },
  { symbol: 'AIDOG', name: 'AI Dog Meme' },
  { symbol: 'WOJAK', name: 'Wojak Finance' },
];

/**
 * Simulate a token scan event
 */
export function simulateScan(): void {
  const token = FAKE_TOKENS[Math.floor(Math.random() * FAKE_TOKENS.length)];
  const mint = generateFakeMint();
  const liquidity = Math.floor(Math.random() * 50000) + 5000;
  const marketCap = liquidity * (2 + Math.random() * 10);

  const scanEvent: ScanEvent = {
    type: 'SCAN',
    timestamp: Date.now(),
    data: {
      reasoning: `Scanning ${token.symbol} from PumpPortal WebSocket feed`,
      logs: [
        `Token detected: ${token.symbol}`,
        `Mint: ${mint}`,
        `Liquidity: $${liquidity.toLocaleString()}`,
        `Market Cap: $${marketCap.toLocaleString()}`,
        'Running safety checks...',
      ],
      mint,
      symbol: token.symbol,
      name: token.name,
      source: 'PUMP_PORTAL',
      liquidity,
      marketCap,
    },
  };

  console.log('📡 Emitting SCAN event:', scanEvent.data.symbol);
  agentEvents.emit(scanEvent);

  // Also emit analysis thought for frontend
  agentEvents.emit({
    type: 'ANALYSIS_THOUGHT',
    timestamp: Date.now(),
    data: {
      mint,
      symbol: token.symbol,
      name: token.name,
      marketCapSol: marketCap / 170,
      liquidity,
      stage: 'scanning',
      thought: `Looking at ${token.symbol}... Let me check if this is worth anything or just another rug.`,
    },
  });
}

/**
 * Simulate a token rejection
 */
export function simulateReject(): void {
  const token = FAKE_TOKENS[Math.floor(Math.random() * FAKE_TOKENS.length)];
  const mint = generateFakeMint();
  const reasons = [
    'MINT_AUTHORITY_ACTIVE',
    'FREEZE_AUTHORITY_ACTIVE',
    'LOW_LIQUIDITY',
    'HIGH_HOLDER_CONCENTRATION',
    'CIRCUIT_BREAKER_TRIGGERED',
  ];
  const rejectReason = reasons[Math.floor(Math.random() * reasons.length)];
  const stages: Array<'filter' | 'safety' | 'liquidity' | 'concentration' | 'circuit_breaker'> = [
    'filter', 'safety', 'liquidity', 'concentration', 'circuit_breaker'
  ];
  const stage = stages[Math.floor(Math.random() * stages.length)];

  const rejectEvent: RejectEvent = {
    type: 'REJECT',
    timestamp: Date.now(),
    data: {
      reasoning: `Rejected ${token.symbol} due to ${rejectReason}`,
      logs: [
        `Token: ${token.symbol}`,
        `Mint: ${mint}`,
        `Failed at stage: ${stage}`,
        `Reason: ${rejectReason}`,
      ],
      mint,
      symbol: token.symbol,
      rejectReason,
      stage,
    },
  };

  console.log('❌ Emitting REJECT event:', token.symbol, rejectReason);
  agentEvents.emit(rejectEvent);

  // Also emit analysis thought
  agentEvents.emit({
    type: 'ANALYSIS_THOUGHT',
    timestamp: Date.now(),
    data: {
      mint,
      symbol: token.symbol,
      stage: 'decision',
      thought: `NOPE. ${token.symbol} has ${rejectReason}. Hard pass.`,
      details: { shouldTrade: false, reasons: [rejectReason] },
    },
  });
}

/**
 * Simulate a buy trade
 */
export function simulateBuy(): void {
  const token = FAKE_TOKENS[Math.floor(Math.random() * FAKE_TOKENS.length)];
  const mint = generateFakeMint();
  const signature = generateFakeSignature();
  const amount = 0.05 + Math.random() * 0.2;

  console.log('💰 Emitting BUY event:', token.symbol, amount.toFixed(3), 'SOL');

  // Emit analysis decision
  agentEvents.emit({
    type: 'ANALYSIS_THOUGHT',
    timestamp: Date.now(),
    data: {
      mint,
      symbol: token.symbol,
      stage: 'decision',
      thought: `${token.symbol} passes all checks. BUYING.`,
      details: { shouldTrade: true },
    },
  });

  // Emit trade executed
  agentEvents.emit({
    type: 'TRADE_EXECUTED',
    timestamp: Date.now(),
    data: {
      mint,
      type: 'BUY',
      signature,
      amount,
      reasoning: `Executed buy of ${token.symbol} - passed safety checks, smart money detected`,
      logs: [
        `Token: ${token.symbol}`,
        `Mint: ${mint}`,
        `Amount: ${amount.toFixed(4)} SOL`,
        `Signature: ${signature.slice(0, 20)}...`,
      ],
    },
  });
}

/**
 * Simulate a sell trade (stop-loss or take-profit)
 */
export function simulateSell(isProfit: boolean = true): void {
  const token = FAKE_TOKENS[Math.floor(Math.random() * FAKE_TOKENS.length)];
  const mint = generateFakeMint();
  const signature = generateFakeSignature();
  const entryPrice = 0.00001 + Math.random() * 0.0001;
  const pnlPercent = isProfit ? 30 + Math.random() * 50 : -(10 + Math.random() * 20);
  const exitPrice = entryPrice * (1 + pnlPercent / 100);

  if (isProfit) {
    console.log('🎯 Emitting TAKE_PROFIT event:', token.symbol, `+${pnlPercent.toFixed(1)}%`);
    agentEvents.emit({
      type: 'TAKE_PROFIT',
      timestamp: Date.now(),
      data: {
        mint,
        entryPrice,
        exitPrice,
        profitPercent: pnlPercent,
        signature,
        reasoning: `Take-profit triggered at +${pnlPercent.toFixed(1)}% (threshold: +30%)`,
        logs: [
          `Token: ${token.symbol}`,
          `Entry: $${entryPrice.toFixed(8)}`,
          `Exit: $${exitPrice.toFixed(8)}`,
          `P&L: +${pnlPercent.toFixed(1)}%`,
        ],
      },
    });
  } else {
    console.log('🛑 Emitting STOP_LOSS event:', token.symbol, `${pnlPercent.toFixed(1)}%`);
    agentEvents.emit({
      type: 'STOP_LOSS',
      timestamp: Date.now(),
      data: {
        mint,
        entryPrice,
        exitPrice,
        lossPercent: pnlPercent,
        signature,
        reasoning: `Stop-loss triggered at ${pnlPercent.toFixed(1)}% (threshold: -10%)`,
        logs: [
          `Token: ${token.symbol}`,
          `Entry: $${entryPrice.toFixed(8)}`,
          `Exit: $${exitPrice.toFixed(8)}`,
          `P&L: ${pnlPercent.toFixed(1)}%`,
        ],
      },
    });
  }
}

/**
 * Simulate a buyback event
 */
export function simulateBuyback(): void {
  const signature = generateFakeSignature();
  const profit = 0.1 + Math.random() * 0.5;
  const buybackAmount = profit * 0.10; // 10% of profit

  console.log('🔄 Emitting BUYBACK_TRIGGERED event:', buybackAmount.toFixed(4), 'SOL');

  agentEvents.emit({
    type: 'BUYBACK_TRIGGERED',
    timestamp: Date.now(),
    data: {
      profit,
      amount: buybackAmount,
      signature,
      reasoning: `Buyback triggered: 10% of ${profit.toFixed(4)} SOL profit = ${buybackAmount.toFixed(4)} SOL`,
      logs: [
        `Profit: ${profit.toFixed(4)} SOL`,
        `Buyback percentage: 10% (HARDCODED)`,
        `Buyback amount: ${buybackAmount.toFixed(4)} SOL`,
        `Signature: ${signature.slice(0, 20)}...`,
      ],
    },
  });
}

/**
 * Simulate a mood change
 */
export function simulateMoodChange(newMood?: string): void {
  const moods = ['CONFIDENT', 'PARANOID', 'MANIC', 'DEPRESSED', 'EUPHORIC', 'ANXIOUS'];
  const previousMood = moods[Math.floor(Math.random() * moods.length)];
  const currentMood = newMood || moods[Math.floor(Math.random() * moods.length)];
  const intensity = 0.3 + Math.random() * 0.7;

  const moodEvent: MoodChangeEvent = {
    type: 'MOOD_CHANGE',
    timestamp: Date.now(),
    data: {
      previous: previousMood,
      current: currentMood,
      intensity,
      trigger: 'manual_test',
      reasoning: `Mood shifted from ${previousMood} to ${currentMood} (intensity: ${(intensity * 100).toFixed(0)}%)`,
      logs: [
        `Previous mood: ${previousMood}`,
        `New mood: ${currentMood}`,
        `Intensity: ${(intensity * 100).toFixed(0)}%`,
        `Trigger: Manual test`,
      ],
    },
  };

  console.log('🧠 Emitting MOOD_CHANGE event:', previousMood, '->', currentMood);
  agentEvents.emit(moodEvent);
}

/**
 * Simulate a reward claim
 */
export function simulateRewardClaim(success: boolean = true): void {
  const signature = generateFakeSignature();
  const amountSol = 0.01 + Math.random() * 0.1;

  if (success) {
    console.log('💎 Emitting REWARD_CLAIMED event:', amountSol.toFixed(4), 'SOL');
    agentEvents.emit({
      type: 'REWARD_CLAIMED',
      timestamp: Date.now(),
      data: {
        reasoning: `Successfully claimed pump_creator rewards`,
        logs: [
          `Source: pump_creator`,
          `Amount: ${amountSol.toFixed(4)} SOL`,
          `Signature: ${signature.slice(0, 20)}...`,
        ],
        signature,
        amountSol,
        source: 'pump_creator',
      },
    });
  } else {
    console.log('❌ Emitting REWARD_FAILED event');
    agentEvents.emit({
      type: 'REWARD_FAILED',
      timestamp: Date.now(),
      data: {
        reasoning: `Failed to claim pump_creator rewards after 3 attempts`,
        logs: [
          `Source: pump_creator`,
          `Attempts: 3`,
          `Error: Transaction simulation failed`,
        ],
        source: 'pump_creator',
        error: 'Transaction simulation failed',
      },
    });
  }
}

/**
 * Run full pipeline test
 */
export async function runFullPipelineTest(): Promise<void> {
  console.log('\n🧪 Running Full Pipeline Test\n');
  console.log('================================\n');

  // 1. Scan
  console.log('1️⃣ Simulating token scan...');
  simulateScan();
  await sleep(1000);

  // 2. Reject some
  console.log('\n2️⃣ Simulating token rejection...');
  simulateReject();
  await sleep(1000);

  // 3. Buy
  console.log('\n3️⃣ Simulating buy trade...');
  simulateBuy();
  await sleep(1000);

  // 4. Take profit
  console.log('\n4️⃣ Simulating take-profit...');
  simulateSell(true);
  await sleep(1000);

  // 5. Buyback
  console.log('\n5️⃣ Simulating buyback...');
  simulateBuyback();
  await sleep(1000);

  // 6. Mood change
  console.log('\n6️⃣ Simulating mood change...');
  simulateMoodChange('PARANOID');
  await sleep(1000);

  // 7. Reward claim
  console.log('\n7️⃣ Simulating reward claim...');
  simulateRewardClaim(true);
  await sleep(1000);

  // 8. Stop loss
  console.log('\n8️⃣ Simulating stop-loss...');
  simulateSell(false);
  await sleep(1000);

  console.log('\n================================');
  console.log('✅ Full Pipeline Test Complete\n');
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// CLI entry point
async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  console.log('🧪 Manual Trigger - Dry Run Testing\n');

  switch (command) {
    case '--scan':
      simulateScan();
      break;
    case '--reject':
      simulateReject();
      break;
    case '--buy':
      simulateBuy();
      break;
    case '--sell':
      simulateSell(args[1] !== 'loss');
      break;
    case '--buyback':
      simulateBuyback();
      break;
    case '--mood':
      simulateMoodChange(args[1]?.toUpperCase());
      break;
    case '--reward':
      simulateRewardClaim(args[1] !== 'fail');
      break;
    case '--full':
    case '--all':
      await runFullPipelineTest();
      break;
    default:
      console.log('Usage:');
      console.log('  npx tsx src/test/manual-trigger.ts --scan');
      console.log('  npx tsx src/test/manual-trigger.ts --reject');
      console.log('  npx tsx src/test/manual-trigger.ts --buy');
      console.log('  npx tsx src/test/manual-trigger.ts --sell [loss]');
      console.log('  npx tsx src/test/manual-trigger.ts --buyback');
      console.log('  npx tsx src/test/manual-trigger.ts --mood [PARANOID|CONFIDENT|...]');
      console.log('  npx tsx src/test/manual-trigger.ts --reward [fail]');
      console.log('  npx tsx src/test/manual-trigger.ts --full');
      break;
  }

  // Keep process alive briefly for events to emit
  await sleep(500);
}

// Export functions for programmatic use
export {
  generateFakeMint,
  generateFakeSignature,
  FAKE_TOKENS,
};

main().catch(console.error);
