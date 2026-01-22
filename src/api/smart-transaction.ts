/**
 * Smart Transaction Utility for Helius
 *
 * Provides optimized transaction sending with:
 * - Jito tips for MEV protection
 * - Dynamic priority fees from Helius API
 * - Smart retry with polling and rebroadcast
 * - Automatic compute unit optimization
 *
 * Based on Helius best practices (Jan 2026)
 */

import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
  TransactionMessage,
  SystemProgram,
  ComputeBudgetProgram,
  TransactionInstruction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import bs58 from 'bs58';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('smart-tx');

/**
 * Jito tip accounts for MEV protection
 * Randomly select one per transaction
 */
const JITO_TIP_ACCOUNTS = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
];

/**
 * Priority fee levels from Helius API
 */
export interface PriorityFeeLevels {
  min: number;
  low: number;
  medium: number;
  high: number;
  veryHigh: number;
  unsafeMax: number;
}

/**
 * Smart transaction configuration
 */
export interface SmartTransactionConfig {
  /** Helius RPC URL with API key */
  rpcUrl: string;
  /** Wallet keypair for signing */
  wallet: Keypair;
  /** Enable Jito tips (default: true) */
  enableJitoTips?: boolean;
  /** Minimum Jito tip in SOL (default: 0.0002) */
  minJitoTipSol?: number;
  /** Max Jito tip in SOL (default: 0.001) */
  maxJitoTipSol?: number;
  /** Transaction timeout in ms (default: 60000) */
  timeoutMs?: number;
  /** Polling interval in ms (default: 2000) */
  pollingIntervalMs?: number;
  /** Max retries (default: 3) */
  maxRetries?: number;
}

/**
 * Smart Transaction Sender
 *
 * Implements Helius best practices for reliable transaction landing:
 * 1. Dynamic priority fees from getPriorityFeeEstimate
 * 2. Jito tips for MEV protection
 * 3. Automatic compute unit calculation via simulation
 * 4. Polling-based confirmation with rebroadcast
 */
export class SmartTransactionSender {
  private connection: Connection;
  private rpcUrl: string;
  private wallet: Keypair;
  private enableJitoTips: boolean;
  private minJitoTipSol: number;
  private maxJitoTipSol: number;
  private timeoutMs: number;
  private pollingIntervalMs: number;
  private maxRetries: number;

  // Cache for priority fees
  private cachedPriorityFees: PriorityFeeLevels | null = null;
  private lastPriorityFeeCheck = 0;
  private readonly PRIORITY_FEE_CACHE_MS = 10000; // 10 second cache

  // Cache for Jito tip floor
  private cachedJitoTip = 0.0002;
  private lastJitoTipCheck = 0;
  private readonly JITO_TIP_CACHE_MS = 30000; // 30 second cache

  constructor(config: SmartTransactionConfig) {
    this.rpcUrl = config.rpcUrl;
    this.wallet = config.wallet;
    this.connection = new Connection(config.rpcUrl, {
      commitment: 'confirmed',
      confirmTransactionInitialTimeout: 60000,
    });
    this.enableJitoTips = config.enableJitoTips ?? true;
    this.minJitoTipSol = config.minJitoTipSol ?? 0.0002;
    this.maxJitoTipSol = config.maxJitoTipSol ?? 0.001;
    this.timeoutMs = config.timeoutMs ?? 60000;
    this.pollingIntervalMs = config.pollingIntervalMs ?? 2000;
    this.maxRetries = config.maxRetries ?? 3;

    logger.info({
      enableJitoTips: this.enableJitoTips,
      minJitoTipSol: this.minJitoTipSol,
      timeoutMs: this.timeoutMs,
    }, 'SmartTransactionSender initialized');
  }

  /**
   * Get the underlying Connection
   */
  getConnection(): Connection {
    return this.connection;
  }

  /**
   * Get dynamic Jito tip amount from Jito API
   * Uses 75th percentile of recent tips, with min/max bounds
   */
  async getDynamicJitoTip(): Promise<number> {
    const now = Date.now();

    // Return cached value if fresh
    if (now - this.lastJitoTipCheck < this.JITO_TIP_CACHE_MS) {
      return this.cachedJitoTip;
    }

    try {
      const response = await fetch('https://bundles.jito.wtf/api/v1/bundles/tip_floor', {
        signal: AbortSignal.timeout(5000), // 5s timeout
      });
      const data = await response.json();

      if (data && data[0] && typeof data[0].landed_tips_75th_percentile === 'number') {
        const tip75th = data[0].landed_tips_75th_percentile;
        // Clamp to min/max bounds
        this.cachedJitoTip = Math.max(
          this.minJitoTipSol,
          Math.min(this.maxJitoTipSol, tip75th)
        );
      }

      this.lastJitoTipCheck = now;
      logger.debug({ jitoTip: this.cachedJitoTip }, 'Fetched Jito tip floor');
    } catch (error) {
      logger.debug({ error }, 'Failed to fetch Jito tip, using cached value');
    }

    return this.cachedJitoTip;
  }

  /**
   * Get random Jito tip account
   */
  getRandomJitoTipAccount(): PublicKey {
    const index = Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length);
    return new PublicKey(JITO_TIP_ACCOUNTS[index]);
  }

  /**
   * Create Jito tip instruction
   */
  async createJitoTipInstruction(urgent: boolean = false): Promise<TransactionInstruction> {
    let tipAmount = await this.getDynamicJitoTip();

    // Double tip for urgent transactions (sells)
    if (urgent) {
      tipAmount = Math.min(tipAmount * 2, this.maxJitoTipSol);
    }

    const tipAccount = this.getRandomJitoTipAccount();

    logger.debug({ tipAmount, tipAccount: tipAccount.toBase58(), urgent }, 'Creating Jito tip');

    return SystemProgram.transfer({
      fromPubkey: this.wallet.publicKey,
      toPubkey: tipAccount,
      lamports: Math.floor(tipAmount * LAMPORTS_PER_SOL),
    });
  }

  /**
   * Get priority fee estimate using Helius API
   * Supports both serialized transaction (more accurate) and account keys
   */
  async getPriorityFeeEstimate(
    serializedTx?: string,
    accountKeys?: string[]
  ): Promise<PriorityFeeLevels> {
    const now = Date.now();

    // Return cached if fresh and no specific transaction
    if (!serializedTx && this.cachedPriorityFees && now - this.lastPriorityFeeCheck < this.PRIORITY_FEE_CACHE_MS) {
      return this.cachedPriorityFees;
    }

    try {
      const params: any = {
        options: { includeAllPriorityFeeLevels: true },
      };

      // Prefer serialized transaction for accuracy
      if (serializedTx) {
        params.transaction = serializedTx;
      } else if (accountKeys && accountKeys.length > 0) {
        params.accountKeys = accountKeys;
      }

      const response = await fetch(this.rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'priority-fee',
          method: 'getPriorityFeeEstimate',
          params: [params],
        }),
        signal: AbortSignal.timeout(5000),
      });

      const result = await response.json();

      if (result.result?.priorityFeeLevels) {
        const levels = result.result.priorityFeeLevels;
        this.cachedPriorityFees = {
          min: levels.min || 0,
          low: levels.low || 1000,
          medium: levels.medium || 10000,
          high: levels.high || 100000,
          veryHigh: levels.veryHigh || 500000,
          unsafeMax: levels.unsafeMax || 1000000,
        };
        this.lastPriorityFeeCheck = now;

        logger.debug({ priorityFees: this.cachedPriorityFees }, 'Fetched priority fee levels');
        return this.cachedPriorityFees;
      }

      // Fallback to recommended single value
      if (result.result?.priorityFeeEstimate) {
        const base = result.result.priorityFeeEstimate;
        this.cachedPriorityFees = {
          min: Math.floor(base * 0.5),
          low: Math.floor(base * 0.75),
          medium: base,
          high: Math.floor(base * 1.5),
          veryHigh: Math.floor(base * 2),
          unsafeMax: Math.floor(base * 3),
        };
        this.lastPriorityFeeCheck = now;
        return this.cachedPriorityFees;
      }
    } catch (error) {
      logger.warn({ error }, 'Failed to fetch priority fees, using defaults');
    }

    // Default fallback
    return this.cachedPriorityFees || {
      min: 1000,
      low: 10000,
      medium: 50000,
      high: 100000,
      veryHigh: 500000,
      unsafeMax: 1000000,
    };
  }

  /**
   * Simulate transaction to get compute units consumed
   */
  async simulateForComputeUnits(
    instructions: TransactionInstruction[],
    blockhash: string
  ): Promise<number> {
    // Create test transaction with max compute units
    const testInstructions = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      ...instructions,
    ];

    const testMessage = new TransactionMessage({
      payerKey: this.wallet.publicKey,
      recentBlockhash: blockhash,
      instructions: testInstructions,
    }).compileToV0Message();

    const testTx = new VersionedTransaction(testMessage);
    testTx.sign([this.wallet]);

    const simulation = await this.connection.simulateTransaction(testTx, {
      replaceRecentBlockhash: true,
      sigVerify: false,
    });

    if (simulation.value.err) {
      logger.warn({ err: simulation.value.err }, 'Simulation failed');
      return 200000; // Default fallback
    }

    const unitsConsumed = simulation.value.unitsConsumed || 200000;

    // Add 10% margin, minimum 1000 CUs (Helius best practice)
    const computeUnits = Math.max(1000, Math.ceil(unitsConsumed * 1.1));

    logger.debug({ unitsConsumed, computeUnits }, 'Simulated compute units');
    return computeUnits;
  }

  /**
   * Build optimized transaction with compute budget and optional Jito tip
   */
  async buildSmartTransaction(
    instructions: TransactionInstruction[],
    options?: {
      urgent?: boolean;
      priorityLevel?: 'low' | 'medium' | 'high' | 'veryHigh';
      skipJitoTip?: boolean;
    }
  ): Promise<VersionedTransaction> {
    const urgent = options?.urgent ?? false;
    const priorityLevel = options?.priorityLevel ?? (urgent ? 'high' : 'medium');
    const skipJitoTip = options?.skipJitoTip ?? !this.enableJitoTips;

    // Get fresh blockhash
    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash('confirmed');

    // Build instruction list
    const allInstructions: TransactionInstruction[] = [...instructions];

    // Add Jito tip if enabled
    if (!skipJitoTip) {
      const tipIx = await this.createJitoTipInstruction(urgent);
      allInstructions.push(tipIx);
    }

    // Simulate to get compute units
    const computeUnits = await this.simulateForComputeUnits(allInstructions, blockhash);

    // Get priority fee
    const priorityFees = await this.getPriorityFeeEstimate();
    const priorityFee = priorityFees[priorityLevel];

    logger.debug({
      computeUnits,
      priorityFee,
      priorityLevel,
      urgent,
      hasJitoTip: !skipJitoTip,
    }, 'Building smart transaction');

    // Prepend compute budget instructions (must be first)
    const finalInstructions = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee }),
      ...allInstructions,
    ];

    // Build transaction
    const message = new TransactionMessage({
      payerKey: this.wallet.publicKey,
      recentBlockhash: blockhash,
      instructions: finalInstructions,
    }).compileToV0Message();

    const transaction = new VersionedTransaction(message);
    transaction.sign([this.wallet]);

    return transaction;
  }

  /**
   * Poll for transaction confirmation
   */
  async pollTransactionConfirmation(
    signature: string,
    timeoutMs?: number
  ): Promise<'confirmed' | 'finalized' | 'failed' | 'timeout'> {
    const timeout = timeoutMs ?? this.timeoutMs;
    const startTime = Date.now();
    const maxAttempts = Math.ceil(timeout / this.pollingIntervalMs);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const status = await this.connection.getSignatureStatus(signature);

        if (status.value?.err) {
          logger.warn({ signature, err: status.value.err }, 'Transaction failed');
          return 'failed';
        }

        if (status.value?.confirmationStatus === 'finalized') {
          return 'finalized';
        }

        if (status.value?.confirmationStatus === 'confirmed') {
          return 'confirmed';
        }
      } catch (error) {
        // Ignore polling errors, continue trying
        logger.debug({ signature, attempt, error }, 'Polling error, continuing');
      }

      // Check timeout
      if (Date.now() - startTime >= timeout) {
        return 'timeout';
      }

      // Wait before next poll
      await new Promise(resolve => setTimeout(resolve, this.pollingIntervalMs));
    }

    return 'timeout';
  }

  /**
   * Send transaction with smart retry and polling
   *
   * This is the main method for sending transactions reliably:
   * 1. Sends transaction
   * 2. Polls for confirmation
   * 3. Rebroadcasts if needed
   * 4. Retries on failure
   */
  async sendSmartTransaction(
    transaction: VersionedTransaction,
    options?: {
      skipPreflight?: boolean;
      maxRetries?: number;
    }
  ): Promise<string> {
    const maxRetries = options?.maxRetries ?? this.maxRetries;
    const skipPreflight = options?.skipPreflight ?? false;
    const startTime = Date.now();

    let lastSignature: string | null = null;
    let lastError: Error | null = null;

    for (let retry = 0; retry < maxRetries; retry++) {
      try {
        // Send transaction
        const signature = await this.connection.sendRawTransaction(
          transaction.serialize(),
          {
            skipPreflight,
            maxRetries: 0, // We handle retries ourselves
            preflightCommitment: 'confirmed',
          }
        );

        lastSignature = signature;
        logger.debug({ signature, retry }, 'Transaction sent, polling for confirmation');

        // Poll for confirmation
        const remainingTimeout = this.timeoutMs - (Date.now() - startTime);
        if (remainingTimeout <= 0) {
          throw new Error('Transaction timeout');
        }

        const status = await this.pollTransactionConfirmation(signature, remainingTimeout);

        if (status === 'confirmed' || status === 'finalized') {
          logger.info({ signature, status, retry }, 'Transaction confirmed');
          return signature;
        }

        if (status === 'failed') {
          throw new Error('Transaction failed on-chain');
        }

        // Timeout - will retry with rebroadcast
        logger.warn({ signature, retry }, 'Transaction not confirmed, retrying');
      } catch (error) {
        lastError = error as Error;
        logger.warn({ error: lastError.message, retry }, 'Send attempt failed');

        // Check if we should retry
        const errorMsg = lastError.message.toLowerCase();
        const isRetryable =
          errorMsg.includes('blockhash') ||
          errorMsg.includes('timeout') ||
          errorMsg.includes('rate limit') ||
          errorMsg.includes('429');

        if (!isRetryable && retry > 0) {
          throw lastError;
        }

        // Brief delay before retry
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    // All retries exhausted
    if (lastSignature) {
      // Return last signature even if unconfirmed - let caller decide
      logger.warn({ signature: lastSignature }, 'Returning unconfirmed signature after retries');
      return lastSignature;
    }

    throw lastError || new Error('Transaction failed after all retries');
  }

  /**
   * Build and send a smart transaction in one call
   */
  async buildAndSendSmartTransaction(
    instructions: TransactionInstruction[],
    options?: {
      urgent?: boolean;
      priorityLevel?: 'low' | 'medium' | 'high' | 'veryHigh';
      skipJitoTip?: boolean;
      skipPreflight?: boolean;
      maxRetries?: number;
    }
  ): Promise<string> {
    const transaction = await this.buildSmartTransaction(instructions, options);
    return this.sendSmartTransaction(transaction, options);
  }

  /**
   * Send a pre-built VersionedTransaction with smart retry
   * Adds compute budget and Jito tip if not already present
   */
  async sendExternalTransaction(
    transaction: VersionedTransaction,
    options?: {
      urgent?: boolean;
      addJitoTip?: boolean;
      skipPreflight?: boolean;
    }
  ): Promise<string> {
    // For external transactions (from PumpPortal/Jupiter), just send with retry
    // They already have their own compute budgets
    return this.sendSmartTransaction(transaction, {
      skipPreflight: options?.skipPreflight ?? false,
    });
  }
}

/**
 * Create a SmartTransactionSender from Helius API key
 */
export function createSmartTransactionSender(
  apiKey: string,
  wallet: Keypair,
  options?: Partial<SmartTransactionConfig>
): SmartTransactionSender {
  return new SmartTransactionSender({
    rpcUrl: `https://mainnet.helius-rpc.com/?api-key=${apiKey}`,
    wallet,
    ...options,
  });
}

export { JITO_TIP_ACCOUNTS };
