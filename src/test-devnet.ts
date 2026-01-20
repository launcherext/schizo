/**
 * Devnet Integration Test
 *
 * Verifies all Phase 1 systems work together:
 * - Encrypted keystore for wallet management
 * - SQLite database for trade persistence
 * - Helius/Solana connection for transactions
 *
 * Run: npx tsx src/test-devnet.ts
 */

import {
  Keypair,
  Connection,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
  PublicKey,
} from '@solana/web3.js';
import { createKeystore, saveKeystore, loadKeystore } from './keystore/index.js';
import { createDatabase } from './db/database.js';
import { TradeRepository } from './db/repositories/trades.js';
import { StateRepository } from './db/repositories/state.js';
import { HeliusClient } from './api/index.js';
import { createLogger } from './lib/logger.js';
import * as fs from 'fs';
import * as path from 'path';

// Module logger
const log = createLogger('test-devnet');

// Test configuration
const KEYSTORE_PATH = './test-keystore.json';
const DATABASE_PATH = './test-agent.db';
const TEST_PASSWORD = 'test-password-12345'; // OK for devnet test
const DEVNET_URL = process.env.HELIUS_API_KEY
  ? `https://devnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`
  : 'https://api.devnet.solana.com';

// Mock mode for testing when airdrop is unavailable
const MOCK_MODE = process.argv.includes('--mock');

/**
 * Run the devnet integration test.
 *
 * This test verifies:
 * 1. Keystore create/save/load with encryption
 * 2. Database persistence across restarts
 * 3. Solana devnet transaction signing and submission
 * 4. Trade recording in SQLite
 */
export async function runDevnetTest(): Promise<void> {
  log.info('===========================================');
  log.info('SCHIZO Agent - Devnet Integration Test');
  log.info('===========================================');

  // Step 1: Setup keystore
  log.info('Step 1: Setting up keystore...');
  let keypair: Keypair;

  if (fs.existsSync(KEYSTORE_PATH)) {
    log.info('Loading existing keystore...');
    keypair = loadKeystore(KEYSTORE_PATH, TEST_PASSWORD);
    log.info({ publicKey: keypair.publicKey.toBase58() }, 'Wallet loaded from keystore');
  } else {
    log.info('Creating new keystore...');
    const result = createKeystore(TEST_PASSWORD);
    keypair = result.keypair;
    saveKeystore(result.keystore, KEYSTORE_PATH);
    log.info({ publicKey: keypair.publicKey.toBase58() }, 'New wallet created and saved');
  }

  // Step 2: Setup database
  log.info('Step 2: Setting up database...');
  const db = createDatabase(DATABASE_PATH);
  const tradeRepo = new TradeRepository(db);
  const stateRepo = new StateRepository(db);

  // Check if this is a restart by reading agent state
  let runCount = 1;
  const existingRunCount = stateRepo.getState('test_run_count');
  if (existingRunCount) {
    runCount = parseInt(existingRunCount, 10) + 1;
  }
  stateRepo.setState('test_run_count', runCount.toString());
  log.info({ runCount }, 'Run count updated');

  // Verify persistence from previous runs
  if (runCount > 1) {
    const previousTrades = tradeRepo.getRecent(5);
    log.info({
      previousTradeCount: previousTrades.length,
      signatures: previousTrades.map(t => t.signature.slice(0, 16) + '...')
    }, 'Previous trades retrieved from database');
  }

  // Step 3: Check balance and request airdrop if needed
  log.info('Step 3: Connecting to Solana devnet...');
  const connection = new Connection(DEVNET_URL, 'confirmed');

  let balance = await connection.getBalance(keypair.publicKey);
  log.info({ balance: balance / LAMPORTS_PER_SOL }, 'Current balance (SOL)');

  if (balance < 0.1 * LAMPORTS_PER_SOL && !MOCK_MODE) {
    log.info('Balance low, requesting airdrop...');
    try {
      const airdropSignature = await connection.requestAirdrop(
        keypair.publicKey,
        LAMPORTS_PER_SOL // Request 1 SOL
      );
      log.info({ signature: airdropSignature }, 'Airdrop requested');

      // Wait for confirmation
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
      await connection.confirmTransaction({
        signature: airdropSignature,
        blockhash,
        lastValidBlockHeight,
      });
      log.info('Airdrop confirmed');

      // Update balance
      balance = await connection.getBalance(keypair.publicKey);
      log.info({ balance: balance / LAMPORTS_PER_SOL }, 'Updated balance (SOL)');
    } catch (error) {
      // Airdrop may fail due to rate limits - continue with existing balance
      log.warn({ error: (error as Error).message }, 'Airdrop failed (may be rate limited)');
      if (balance === 0) {
        log.warn('===========================================');
        log.warn('AIRDROP RATE LIMITED');
        log.warn('===========================================');
        log.warn(`Fund this wallet manually using the Solana Faucet:`);
        log.warn(`https://faucet.solana.com`);
        log.warn(`Wallet address: ${keypair.publicKey.toBase58()}`);
        log.warn('Or run with --mock flag to test without real transactions.');
        db.close();
        return;
      }
    }
  }

  // Step 4: Create and sign test transaction
  log.info('Step 4: Creating test transaction...');

  let signature: string;

  if (MOCK_MODE) {
    // Mock mode: simulate a transaction for testing without real devnet funds
    log.info('[MOCK MODE] Simulating transaction...');

    // Create a deterministic mock signature based on run count
    signature = `mock_tx_${Date.now()}_run${runCount}_${keypair.publicKey.toBase58().slice(0, 8)}`;

    // Verify we have the keypair by checking it has a valid secret key
    // (In real mode, the sendAndConfirmTransaction call would prove signing capability)
    if (!keypair.secretKey || keypair.secretKey.length !== 64) {
      throw new Error('Keypair does not have valid secret key');
    }
    log.info('[MOCK MODE] Keypair verified (has valid secret key)');
    log.info({ signature }, '[MOCK MODE] Simulated transaction signature');
  } else {
    // Real mode: submit actual transaction to devnet
    // Self-transfer (send small amount to self)
    const transferAmount = 0.001 * LAMPORTS_PER_SOL;

    const transaction = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: keypair.publicKey,
        toPubkey: keypair.publicKey, // Self-transfer
        lamports: transferAmount,
      })
    );

    log.info('Signing and submitting transaction...');
    try {
      signature = await sendAndConfirmTransaction(connection, transaction, [keypair]);
      log.info({ signature }, 'Transaction confirmed on devnet');
    } catch (error) {
      log.error({ error: (error as Error).message }, 'Transaction failed');
      db.close();
      throw error;
    }
  }

  // Step 5: Record trade in database
  log.info('Step 5: Recording trade in database...');
  const trade = {
    signature,
    timestamp: Math.floor(Date.now() / 1000),
    type: 'BUY' as const,
    tokenMint: '11111111111111111111111111111111', // Native SOL (system program)
    tokenSymbol: 'SOL',
    amountSol: 0.001,
    amountTokens: 0.001,
    pricePerToken: 1,
    feeSol: 0.000005, // Approximate fee
    metadata: {
      test: true,
      runCount,
      note: 'Devnet integration test self-transfer'
    }
  };

  tradeRepo.insert(trade);
  log.info({ signature: signature.slice(0, 16) + '...' }, 'Trade recorded in database');

  // Step 6: Verify state persistence
  log.info('Step 6: Verifying state persistence...');
  const retrievedTrade = tradeRepo.getBySignature(signature);
  if (!retrievedTrade) {
    throw new Error('Failed to retrieve trade from database');
  }
  log.info('Trade verified in database');

  // Count total trades
  const allTrades = tradeRepo.getRecent(100);
  log.info({ totalTrades: allTrades.length }, 'Total trades in database');

  // Step 7: Summary
  log.info('===========================================');
  log.info('Integration Test Complete');
  log.info('===========================================');
  log.info({
    publicKey: keypair.publicKey.toBase58(),
    balance: balance / LAMPORTS_PER_SOL,
    runCount,
    totalTrades: allTrades.length,
    latestSignature: signature,
  }, 'Test summary');

  if (!MOCK_MODE) {
    log.info('Verify transaction on Solana Explorer:');
    log.info(`https://explorer.solana.com/tx/${signature}?cluster=devnet`);
  } else {
    log.info('[MOCK MODE] No real transaction to verify on explorer.');
    log.info('[MOCK MODE] Run without --mock flag with funded wallet for real transaction.');
  }

  if (runCount === 1) {
    log.info('');
    log.info('Run this test again to verify persistence across restarts.');
    log.info('The run count should increment and previous trades should be visible.');
  }

  // Close database
  db.close();
  log.info('Database closed');
}

// Main execution
const scriptPath = new URL(import.meta.url).pathname;
const normalizedScriptPath = scriptPath.replace(/^\/([A-Z]:)/i, '$1');
const normalizedArgv = process.argv[1]?.replace(/\\/g, '/');

if (normalizedArgv?.includes('test-devnet') || process.argv[1]?.includes('test-devnet')) {
  runDevnetTest().catch((error) => {
    console.error('Test failed:', error);
    process.exit(1);
  });
}
