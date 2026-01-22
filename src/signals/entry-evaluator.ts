import { createChildLogger } from '../utils/logger';
import { pumpDetector } from './pump-detector';
import { velocityTracker } from './velocity-tracker';
import { priceFeed } from '../data/price-feed';
import { tokenWatchlist } from './token-watchlist';
import { EntryResult, PumpMetrics } from './types';
import { config } from '../config/settings';

const logger = createChildLogger('entry-evaluator');

export class EntryEvaluator {
  constructor() {}

  /**
   * Unified entry evaluation:
   * - If token has price history → use pump detector
   * - If new token → check velocity tracker
   */
  evaluate(mint: string, marketCapSol?: number): EntryResult {
    // Check if we have price history for pump analysis
    const priceHistory = priceFeed.getPriceHistory(mint, 300);
    const hasPriceHistory = priceHistory.length >= 10;

    logger.debug({
      mint: mint.substring(0, 12),
      priceHistoryLen: priceHistory.length,
      hasPriceHistory,
      hasVelocityData: velocityTracker.hasTradeData(mint),
    }, 'Evaluating entry');

    // Path 1: Token has sufficient price history → use pump detector
    if (hasPriceHistory) {
      const pumpMetrics = pumpDetector.analyzePump(mint);
      const isGoodEntry = pumpDetector.isGoodEntry(pumpMetrics);

      logger.info({
        mint: mint.substring(0, 12),
        source: 'pump_detector',
        phase: pumpMetrics.phase,
        heat: pumpMetrics.heat.toFixed(1),
        confidence: pumpMetrics.confidence.toFixed(2),
        isGoodEntry,
      }, 'Pump detector evaluation');

      return {
        canEnter: isGoodEntry,
        source: 'pump_detector',
        reason: isGoodEntry
          ? `Pump OK: ${pumpMetrics.phase} phase, heat=${pumpMetrics.heat.toFixed(0)}`
          : `Pump rejected: ${pumpMetrics.phase} phase, heat=${pumpMetrics.heat.toFixed(0)}, conf=${pumpMetrics.confidence.toFixed(2)}`,
        metrics: pumpMetrics,
      };
    }

    // Path 2: New token without price history → check velocity
    const velocityResult = velocityTracker.hasGoodVelocity(mint, marketCapSol);

    logger.info({
      mint: mint.substring(0, 12),
      source: 'velocity',
      hasGoodVelocity: velocityResult.hasGoodVelocity,
      reason: velocityResult.reason,
      metrics: velocityResult.metrics ? {
        txCount: velocityResult.metrics.txCount,
        uniqueBuyers: velocityResult.metrics.uniqueBuyers.size,
        buyPressure: (velocityResult.metrics.buyPressure * 100).toFixed(0) + '%',
      } : null,
    }, 'Velocity evaluation');

    return {
      canEnter: velocityResult.hasGoodVelocity,
      source: velocityResult.hasGoodVelocity ? 'velocity' : 'none',
      reason: velocityResult.reason,
      metrics: velocityResult.metrics || undefined,
    };
  }

  /**
   * Get pump metrics (for logging/display even if using velocity path)
   */
  getPumpMetrics(mint: string): PumpMetrics {
    return pumpDetector.analyzePump(mint);
  }
}

export const entryEvaluator = new EntryEvaluator();
