import { createChildLogger } from '../utils/logger';
import { config } from '../config/settings';
import { VelocityMetrics, VelocityResult } from './types';

const logger = createChildLogger('velocity-tracker');

interface TradeEvent {
  mint: string;
  txType: 'buy' | 'sell';
  traderPublicKey: string;
  marketCapSol: number;
  timestamp: number;
}

export class VelocityTracker {
  // Rolling window of trades per token
  private tokenTrades: Map<string, TradeEvent[]> = new Map();
  private windowMs = 60000; // 60-second rolling window

  constructor() {}

  /**
   * Record a trade event from PumpPortal WebSocket
   */
  recordTrade(data: {
    mint: string;
    txType: 'buy' | 'sell';
    traderPublicKey: string;
    marketCapSol: number;
  }): void {
    const trade: TradeEvent = {
      ...data,
      timestamp: Date.now(),
    };

    let trades = this.tokenTrades.get(data.mint);
    if (!trades) {
      trades = [];
      this.tokenTrades.set(data.mint, trades);
    }

    trades.push(trade);

    // Prune old trades outside the window
    this.pruneOldTrades(data.mint);

    logger.debug({
      mint: data.mint.substring(0, 12),
      txType: data.txType,
      totalTrades: trades.length,
    }, 'Trade recorded');
  }

  /**
   * Remove trades outside the rolling window
   */
  private pruneOldTrades(mint: string): void {
    const trades = this.tokenTrades.get(mint);
    if (!trades) return;

    const cutoff = Date.now() - this.windowMs;
    const filtered = trades.filter(t => t.timestamp >= cutoff);
    this.tokenTrades.set(mint, filtered);
  }

  /**
   * Get velocity metrics for a token
   */
  getMetrics(mint: string): VelocityMetrics | null {
    this.pruneOldTrades(mint);
    const trades = this.tokenTrades.get(mint);

    if (!trades || trades.length === 0) {
      return null;
    }

    const uniqueBuyers = new Set<string>();
    const uniqueSellers = new Set<string>();
    let buyCount = 0;
    let sellCount = 0;

    for (const trade of trades) {
      if (trade.txType === 'buy') {
        buyCount++;
        uniqueBuyers.add(trade.traderPublicKey);
      } else {
        sellCount++;
        uniqueSellers.add(trade.traderPublicKey);
      }
    }

    const txCount = trades.length;
    const windowSeconds = this.windowMs / 1000;
    const txPerMinute = (txCount / windowSeconds) * 60;
    const buyPressure = txCount > 0 ? buyCount / txCount : 0;

    return {
      mint,
      txCount,
      buyCount,
      sellCount,
      uniqueBuyers,
      uniqueSellers,
      txPerMinute,
      buyPressure,
      windowStartTime: Date.now() - this.windowMs,
    };
  }

  /**
   * Check if a token has good velocity for entry
   */
  hasGoodVelocity(mint: string, marketCapSol?: number): VelocityResult {
    const metrics = this.getMetrics(mint);
    const thresholds = config.velocityEntry;

    if (!metrics) {
      return {
        hasGoodVelocity: false,
        metrics: null,
        reason: 'No trade data available',
      };
    }

    // Check market cap limit (only for early tokens)
    if (marketCapSol !== undefined && marketCapSol > thresholds.maxMarketCapSol) {
      return {
        hasGoodVelocity: false,
        metrics,
        reason: `Market cap ${marketCapSol.toFixed(2)} SOL exceeds ${thresholds.maxMarketCapSol} SOL limit`,
      };
    }

    // Check minimum transaction count
    if (metrics.txCount < thresholds.minTxCount) {
      return {
        hasGoodVelocity: false,
        metrics,
        reason: `Only ${metrics.txCount} txs, need ${thresholds.minTxCount}`,
      };
    }

    // Check unique buyers
    if (metrics.uniqueBuyers.size < thresholds.minUniqueBuyers) {
      return {
        hasGoodVelocity: false,
        metrics,
        reason: `Only ${metrics.uniqueBuyers.size} unique buyers, need ${thresholds.minUniqueBuyers}`,
      };
    }

    // Check buy pressure
    if (metrics.buyPressure < thresholds.minBuyPressure) {
      return {
        hasGoodVelocity: false,
        metrics,
        reason: `Buy pressure ${(metrics.buyPressure * 100).toFixed(0)}% below ${(thresholds.minBuyPressure * 100).toFixed(0)}%`,
      };
    }

    // All checks passed
    logger.info({
      mint: mint.substring(0, 12),
      txCount: metrics.txCount,
      uniqueBuyers: metrics.uniqueBuyers.size,
      buyPressure: (metrics.buyPressure * 100).toFixed(0) + '%',
      txPerMinute: metrics.txPerMinute.toFixed(1),
    }, 'Good velocity detected');

    return {
      hasGoodVelocity: true,
      metrics,
      reason: `Velocity OK: ${metrics.txCount} txs, ${metrics.uniqueBuyers.size} buyers, ${(metrics.buyPressure * 100).toFixed(0)}% buys`,
    };
  }

  /**
   * Check if we have any trade data for a token
   */
  hasTradeData(mint: string): boolean {
    const trades = this.tokenTrades.get(mint);
    return trades !== undefined && trades.length > 0;
  }

  /**
   * Clear data for a token (after position closed or rejected)
   */
  clearToken(mint: string): void {
    this.tokenTrades.delete(mint);
  }

  /**
   * Get status for logging
   */
  getStatus(): string {
    return `Tracking ${this.tokenTrades.size} tokens`;
  }

  /**
   * Get momentum strength for dynamic take profit decisions
   * Returns: 'strong' | 'medium' | 'weak' | 'unknown'
   *
   * STRONG: Hold longer, TP at +150-200%
   * MEDIUM: Normal TP at +100%
   * WEAK: Take profit early at +50%
   */
  getMomentumStrength(mint: string): {
    strength: 'strong' | 'medium' | 'weak' | 'unknown';
    buyPressure: number;
    txPerMinute: number;
    uniqueBuyers: number;
    reason: string;
  } {
    const metrics = this.getMetrics(mint);

    if (!metrics || metrics.txCount < 3) {
      return {
        strength: 'unknown',
        buyPressure: 0,
        txPerMinute: 0,
        uniqueBuyers: 0,
        reason: 'Insufficient data',
      };
    }

    const buyPressure = metrics.buyPressure;
    const txPerMinute = metrics.txPerMinute;
    const uniqueBuyers = metrics.uniqueBuyers.size;

    // STRONG momentum: >70% buys, >10 tx/min, growing buyer base
    if (buyPressure >= 0.70 && txPerMinute >= 10 && uniqueBuyers >= 5) {
      return {
        strength: 'strong',
        buyPressure,
        txPerMinute,
        uniqueBuyers,
        reason: `Strong: ${(buyPressure * 100).toFixed(0)}% buys, ${txPerMinute.toFixed(0)} tx/min, ${uniqueBuyers} buyers`,
      };
    }

    // WEAK momentum: <50% buys OR very low activity
    if (buyPressure < 0.50 || txPerMinute < 3) {
      return {
        strength: 'weak',
        buyPressure,
        txPerMinute,
        uniqueBuyers,
        reason: `Weak: ${(buyPressure * 100).toFixed(0)}% buys, ${txPerMinute.toFixed(0)} tx/min`,
      };
    }

    // MEDIUM: everything in between
    return {
      strength: 'medium',
      buyPressure,
      txPerMinute,
      uniqueBuyers,
      reason: `Medium: ${(buyPressure * 100).toFixed(0)}% buys, ${txPerMinute.toFixed(0)} tx/min`,
    };
  }
}

export const velocityTracker = new VelocityTracker();
