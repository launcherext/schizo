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
   * CRITICAL: Require minimum price data before allowing entry
   * Analysis showed 100% of "cold phase" trades lost money
   */
  evaluate(mint: string, marketCapSol?: number): EntryResult {
    // Get watchlist config minimums
    const watchlistConfig = (config as any).watchlist || {};
    const minDataPoints = watchlistConfig.minDataPoints || 30;

    // Check if we have enough price history
    const priceHistory = priceFeed.getPriceHistory(mint, 300);
    const hasSufficientData = priceHistory.length >= minDataPoints;

    logger.debug({
      mint: mint.substring(0, 12),
      priceHistoryLen: priceHistory.length,
      minRequired: minDataPoints,
      hasSufficientData,
      hasVelocityData: velocityTracker.hasTradeData(mint),
    }, 'Evaluating entry');

    // CRITICAL: Reject tokens without sufficient price data
    // Velocity-only entries were losing money - need real price action data
    if (!hasSufficientData) {
      logger.info({
        mint: mint.substring(0, 12),
        priceHistoryLen: priceHistory.length,
        minRequired: minDataPoints,
      }, 'REJECTED: Insufficient price data - need more history before entry');

      return {
        canEnter: false,
        source: 'none',
        reason: `Need ${minDataPoints} price points, only have ${priceHistory.length}`,
        metrics: undefined,
      };
    }

    // Token has sufficient price history → use pump detector
    const pumpMetrics = pumpDetector.analyzePump(mint);
    const isGoodEntry = pumpDetector.isGoodEntry(pumpMetrics);

    logger.info({
      mint: mint.substring(0, 12),
      source: 'pump_detector',
      phase: pumpMetrics.phase,
      heat: pumpMetrics.heat.toFixed(1),
      confidence: pumpMetrics.confidence.toFixed(2),
      buyPressure: (pumpMetrics.buyPressure * 100).toFixed(0) + '%',
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

  /**
   * Get pump metrics (for logging/display even if using velocity path)
   */
  getPumpMetrics(mint: string): PumpMetrics {
    return pumpDetector.analyzePump(mint);
  }
}

export const entryEvaluator = new EntryEvaluator();
