import { EventEmitter } from 'events';
import { createChildLogger } from '../utils/logger';
import { config } from '../config/settings';
import { jupiterSwap } from './jupiter-swap';
import { pumpFunSwap } from './pumpfun-swap';
import { jitoBundle } from './jito-bundle';
import { SwapResult, PendingTransaction, ExecutionMetrics } from './types';

const logger = createChildLogger('tx-manager');

// Track which tokens are on bonding curve vs graduated
const bondingCurveTokens: Set<string> = new Set();

export class TransactionManager extends EventEmitter {
  private pendingTxs: Map<string, PendingTransaction> = new Map();
  private metrics: ExecutionMetrics = {
    totalTransactions: 0,
    successRate: 0,
    avgSlippage: 0,
    avgConfirmationTime: 0,
    totalFeesPaid: 0,
    jitoSuccessRate: 0,
  };
  private successCount = 0;
  private jitoSuccessCount = 0;
  private jitoAttemptCount = 0;
  private slippageSum = 0;
  private confirmationTimeSum = 0;

  constructor() {
    super();
  }

  async initialize(): Promise<void> {
    jupiterSwap.initialize();
    pumpFunSwap.initialize();
    await jitoBundle.initialize();
    logger.info('Transaction manager initialized');
  }

  // Mark a token as being on bonding curve (not graduated yet)
  markAsBondingCurve(mint: string): void {
    bondingCurveTokens.add(mint);
  }

  // Mark a token as graduated (now on Raydium)
  markAsGraduated(mint: string): void {
    bondingCurveTokens.delete(mint);
  }

  // Check if token is on bonding curve
  isOnBondingCurve(mint: string): boolean {
    // If we've explicitly tracked it, use that
    if (bondingCurveTokens.has(mint)) return true;

    // Default: assume pump.fun tokens ending in "pump" are on bonding curve
    // unless we know they've graduated
    return mint.endsWith('pump');
  }

  async executeBuy(
    mint: string,
    amountSol: number,
    options: {
      slippageBps?: number;
      useJito?: boolean;
      maxRetries?: number;
    } = {}
  ): Promise<SwapResult> {
    const {
      slippageBps = 100,
      useJito = config.enableJito && amountSol > 0.1,
      maxRetries = 3,
    } = options;

    const txId = `buy_${mint}_${Date.now()}`;

    const pendingTx: PendingTransaction = {
      id: txId,
      type: 'buy',
      mint,
      inputAmount: amountSol,
      expectedOutput: 0, // Will be set after quote
      status: 'pending',
      retries: 0,
      createdAt: new Date(),
    };

    this.pendingTxs.set(txId, pendingTx);
    this.emit('txPending', pendingTx);

    let result: SwapResult;
    let lastError: string | undefined;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const startTime = Date.now();

        // Route to appropriate exchange
        const useBondingCurve = this.isOnBondingCurve(mint);
        if (useBondingCurve) {
          logger.info({ mint, amountSol }, 'Routing buy to PumpFun (bonding curve)');
          result = await pumpFunSwap.buy(mint, amountSol, slippageBps / 100); // Convert bps to %
        } else {
          logger.info({ mint, amountSol }, 'Routing buy to Jupiter (graduated)');
          result = await jupiterSwap.buy(mint, amountSol, slippageBps);
        }

        if (result.success) {
          pendingTx.status = 'confirmed';
          pendingTx.signature = result.signature;
          pendingTx.confirmedAt = new Date();

          this.updateMetrics(result, Date.now() - startTime, false);
          this.emit('txConfirmed', { ...pendingTx, result });

          logger.info({
            txId,
            mint,
            amountSol,
            outputAmount: result.outputAmount,
            signature: result.signature,
          }, 'Buy executed');

          return result;
        }

        lastError = result.error;
        pendingTx.retries++;

        logger.warn({
          txId,
          attempt: attempt + 1,
          error: lastError,
        }, 'Buy attempt failed, retrying');

        // Wait before retry
        await this.sleep(1000 * Math.pow(2, attempt));
      } catch (error: any) {
        lastError = error.message;
        pendingTx.retries++;
      }
    }

    pendingTx.status = 'failed';
    pendingTx.error = lastError;
    this.emit('txFailed', pendingTx);

    return {
      success: false,
      inputAmount: amountSol,
      outputAmount: 0,
      priceImpact: 0,
      fees: { platformFee: 0, networkFee: 0, priorityFee: 0, totalFee: 0 },
      error: lastError,
      timestamp: new Date(),
    };
  }

  async executeSell(
    mint: string,
    amountTokens: number,
    decimals: number,
    options: {
      slippageBps?: number;
      useJito?: boolean;
      maxRetries?: number;
      skipBalanceCheck?: boolean;  // Trust position amount when RPC is unreliable
    } = {}
  ): Promise<SwapResult> {
    const {
      slippageBps = config.defaultSlippageBps,  // Use config default (15%) for volatile tokens
      useJito = config.enableJito,
      maxRetries = 3,
      skipBalanceCheck = false,
    } = options;

    // Verify actual token balance before selling (with retry)
    let actualBalance = 0;
    let balanceCheckFailed = false;

    if (!skipBalanceCheck) {
      // Try balance check with retries
      for (let i = 0; i < 3; i++) {
        actualBalance = await this.getTokenBalance(mint);
        if (actualBalance > 0) break;

        // Wait and retry - RPC might be slow
        if (i < 2) {
          logger.debug({ mint, attempt: i + 1 }, 'Balance check returned 0, retrying...');
          await this.sleep(1000 * (i + 1));
        }
      }

      if (actualBalance === 0) {
        balanceCheckFailed = true;
        logger.warn({ mint, requestedAmount: amountTokens },
          'Balance check returned 0 after retries - proceeding with tracked amount');
      }
    }

    if (!skipBalanceCheck && !balanceCheckFailed && actualBalance < amountTokens * 0.99) {  // 1% tolerance
      logger.warn({ mint, requested: amountTokens, actual: actualBalance },
        'Insufficient token balance - adjusting sell amount');

      if (actualBalance > 0) {
        // Sell what we actually have
        amountTokens = actualBalance;
      }
      // If actualBalance is 0 but balanceCheckFailed is true, we proceed with tracked amount
    }

    // If balance check completely failed, proceed anyway with tracked amount
    // The swap API will fail if we truly have no tokens, but at least we try
    if (balanceCheckFailed || skipBalanceCheck) {
      logger.info({ mint, amountTokens, balanceCheckFailed, skipBalanceCheck },
        'Proceeding with sell using tracked position amount');
    }

    const txId = `sell_${mint}_${Date.now()}`;

    const pendingTx: PendingTransaction = {
      id: txId,
      type: 'sell',
      mint,
      inputAmount: amountTokens,
      expectedOutput: 0,
      status: 'pending',
      retries: 0,
      createdAt: new Date(),
    };

    this.pendingTxs.set(txId, pendingTx);
    this.emit('txPending', pendingTx);

    let result: SwapResult;
    let lastError: string | undefined;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const startTime = Date.now();

        // Route to appropriate exchange
        // For sells, use 'auto' pool in PumpPortal which handles both
        const useBondingCurve = this.isOnBondingCurve(mint);
        if (useBondingCurve) {
          logger.info({ mint, amountTokens }, 'Routing sell to PumpFun (auto-detect pool)');
          result = await pumpFunSwap.sell(mint, amountTokens, slippageBps / 100);
        } else {
          logger.info({ mint, amountTokens }, 'Routing sell to Jupiter (graduated)');
          result = await jupiterSwap.sell(mint, amountTokens, decimals, slippageBps);
        }

        if (result.success) {
          pendingTx.status = 'confirmed';
          pendingTx.signature = result.signature;
          pendingTx.confirmedAt = new Date();

          this.updateMetrics(result, Date.now() - startTime, false);
          this.emit('txConfirmed', { ...pendingTx, result });

          logger.info({
            txId,
            mint,
            amountTokens,
            outputSol: result.outputAmount,
            signature: result.signature,
          }, 'Sell executed');

          return result;
        }

        lastError = result.error;
        pendingTx.retries++;

        logger.warn({
          txId,
          attempt: attempt + 1,
          error: lastError,
        }, 'Sell attempt failed, retrying');

        await this.sleep(1000 * Math.pow(2, attempt));
      } catch (error: any) {
        lastError = error.message;
        pendingTx.retries++;
      }
    }

    pendingTx.status = 'failed';
    pendingTx.error = lastError;
    this.emit('txFailed', pendingTx);

    return {
      success: false,
      inputAmount: amountTokens,
      outputAmount: 0,
      priceImpact: 0,
      fees: { platformFee: 0, networkFee: 0, priorityFee: 0, totalFee: 0 },
      error: lastError,
      timestamp: new Date(),
    };
  }

  private updateMetrics(result: SwapResult, confirmationTime: number, usedJito: boolean): void {
    this.metrics.totalTransactions++;

    if (result.success) {
      this.successCount++;
      this.slippageSum += result.priceImpact;
      this.confirmationTimeSum += confirmationTime;
      this.metrics.totalFeesPaid += result.fees.totalFee;
    }

    if (usedJito) {
      this.jitoAttemptCount++;
      if (result.success) {
        this.jitoSuccessCount++;
      }
    }

    // Update rates
    this.metrics.successRate = this.successCount / this.metrics.totalTransactions;
    this.metrics.avgSlippage = this.successCount > 0 ? this.slippageSum / this.successCount : 0;
    this.metrics.avgConfirmationTime = this.successCount > 0
      ? this.confirmationTimeSum / this.successCount
      : 0;
    this.metrics.jitoSuccessRate = this.jitoAttemptCount > 0
      ? this.jitoSuccessCount / this.jitoAttemptCount
      : 0;
  }

  getPendingTransactions(): PendingTransaction[] {
    return Array.from(this.pendingTxs.values()).filter((tx) => tx.status === 'pending');
  }

  getMetrics(): ExecutionMetrics {
    return { ...this.metrics };
  }

  async getWalletBalance(): Promise<number> {
    return jupiterSwap.getBalance();
  }

  async getTokenBalance(mint: string): Promise<number> {
    return jupiterSwap.getTokenBalance(mint);
  }

  getWalletAddress(): string | null {
    return jupiterSwap.getWalletAddress();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  cleanupOldTransactions(maxAge: number = 3600000): void {
    const cutoff = Date.now() - maxAge;

    for (const [id, tx] of this.pendingTxs.entries()) {
      if (tx.createdAt.getTime() < cutoff && tx.status !== 'pending') {
        this.pendingTxs.delete(id);
      }
    }
  }
}

export const txManager = new TransactionManager();
