import { EventEmitter } from 'events';
import { createChildLogger } from '../utils/logger';
import { config } from '../config/settings';
import { repository } from '../db/repository';
import { txManager } from '../execution/tx-manager';
import { c100Tracker } from './c100-tracker';

const logger = createChildLogger('c100-buyback');

export interface BuybackResult {
  success: boolean;
  amountSol: number;
  amountTokens: number;
  priceSol: number;
  source: 'profit_share' | 'manual';
  signature?: string;
  error?: string;
}

export interface BuybackStats {
  totalBuybackSol: number;
  totalTokensBought: number;
  buybackCount: number;
  lastBuybackTime: Date | null;
  avgPriceSol: number;
}

export class C100Buyback extends EventEmitter {
  private stats: BuybackStats = {
    totalBuybackSol: 0,
    totalTokensBought: 0,
    buybackCount: 0,
    lastBuybackTime: null,
    avgPriceSol: 0,
  };
  private isInitialized = false;

  constructor() {
    super();
  }

  async initialize(): Promise<void> {
    if (!config.c100?.buyback?.enabled) {
      logger.info('C100 buyback disabled in config');
      return;
    }

    // Load historical stats from DB
    await this.loadStats();
    this.isInitialized = true;
    logger.info('C100 buyback initialized');
  }

  private async loadStats(): Promise<void> {
    try {
      const totals = await repository.getC100BuybackTotals();

      this.stats.totalBuybackSol = totals.total_sol;
      this.stats.totalTokensBought = totals.total_tokens;
      this.stats.buybackCount = totals.count;

      if (totals.total_tokens > 0 && totals.total_sol > 0) {
        this.stats.avgPriceSol = totals.total_sol / totals.total_tokens;
      }

      const recentBuybacks = await repository.getRecentC100Buybacks(1);
      if (recentBuybacks.length > 0) {
        this.stats.lastBuybackTime = new Date(recentBuybacks[0].timestamp);
      }

      logger.info({
        totalBuybackSol: this.stats.totalBuybackSol.toFixed(4),
        totalTokens: this.stats.totalTokensBought.toFixed(0),
        buybackCount: this.stats.buybackCount,
      }, 'Loaded buyback stats from database');
    } catch (error) {
      logger.error({ error }, 'Failed to load buyback stats');
    }
  }

  async executeBuyback(amountSol: number, source: 'profit_share' | 'manual'): Promise<BuybackResult> {
    if (!config.c100?.tokenMint) {
      return {
        success: false,
        amountSol,
        amountTokens: 0,
        priceSol: 0,
        source,
        error: 'C100 token mint not configured',
      };
    }

    if (!config.c100?.buyback?.enabled) {
      return {
        success: false,
        amountSol,
        amountTokens: 0,
        priceSol: 0,
        source,
        error: 'Buyback disabled in config',
      };
    }

    // Check minimum buyback amount
    const minBuyback = config.c100.buyback.minBuybackSol || 0.01;
    if (amountSol < minBuyback) {
      logger.debug({ amountSol, minBuyback }, 'Buyback amount below minimum');
      return {
        success: false,
        amountSol,
        amountTokens: 0,
        priceSol: 0,
        source,
        error: `Amount ${amountSol} below minimum ${minBuyback}`,
      };
    }

    try {
      logger.info({ amountSol, source }, 'Executing C100 buyback');

      // Get current price for logging
      const tokenData = c100Tracker.getTokenData();
      const priceBefore = tokenData?.priceSol || 0;

      // Execute buy via Jupiter (C100 should be graduated/on DEX)
      const result = await txManager.executeBuy(config.c100.tokenMint, amountSol, {
        slippageBps: 1500, // 15% slippage for potentially low liquidity
        maxRetries: 3,
      });

      if (!result.success) {
        // Log failed buyback
        await repository.insertC100Buyback({
          amount_sol: amountSol,
          source,
          status: 'failed',
        });

        return {
          success: false,
          amountSol,
          amountTokens: 0,
          priceSol: priceBefore,
          source,
          signature: result.signature,
          error: result.error,
        };
      }

      // Wait for settlement and get actual balance
      await new Promise(r => setTimeout(r, 2000));
      const tokensReceived = await txManager.getTokenBalance(config.c100.tokenMint);

      // Calculate actual price
      const actualPrice = tokensReceived > 0 ? amountSol / tokensReceived : priceBefore;

      // Log to database
      await repository.insertC100Buyback({
        amount_sol: amountSol,
        amount_tokens: tokensReceived,
        price_sol: actualPrice,
        source,
        signature: result.signature,
        status: 'success',
      });

      // Update stats
      this.stats.totalBuybackSol += amountSol;
      this.stats.totalTokensBought += tokensReceived;
      this.stats.buybackCount++;
      this.stats.lastBuybackTime = new Date();
      this.stats.avgPriceSol = this.stats.totalBuybackSol / this.stats.totalTokensBought;

      const buybackResult: BuybackResult = {
        success: true,
        amountSol,
        amountTokens: tokensReceived,
        priceSol: actualPrice,
        source,
        signature: result.signature,
      };

      this.emit('buybackSuccess', buybackResult);

      logger.info({
        amountSol: amountSol.toFixed(6),
        tokensReceived: tokensReceived.toFixed(0),
        price: actualPrice.toExponential(4),
        signature: result.signature,
      }, 'C100 buyback successful');

      return buybackResult;
    } catch (error: any) {
      logger.error({ error: error.message, amountSol, source }, 'C100 buyback failed');

      // Log failed buyback
      await repository.insertC100Buyback({
        amount_sol: amountSol,
        source,
        status: 'failed',
      });

      return {
        success: false,
        amountSol,
        amountTokens: 0,
        priceSol: 0,
        source,
        error: error.message,
      };
    }
  }

  // Called when a position closes with profit
  async onProfitableClose(pnlSol: number): Promise<void> {
    if (!config.c100?.buyback?.enabled) return;
    if (pnlSol <= 0) return;

    const buybackPercent = config.c100.buyback.profitSharePercent || 0.10;
    const buybackAmount = pnlSol * buybackPercent;

    logger.info({
      pnlSol: pnlSol.toFixed(6),
      buybackPercent: (buybackPercent * 100).toFixed(0) + '%',
      buybackAmount: buybackAmount.toFixed(6),
    }, 'Processing profit share buyback');

    await this.executeBuyback(buybackAmount, 'profit_share');
  }

  getStats(): BuybackStats {
    return { ...this.stats };
  }

  isEnabled(): boolean {
    return config.c100?.buyback?.enabled === true && !!config.c100?.tokenMint;
  }
}

export const c100Buyback = new C100Buyback();
