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
   * TWO-TIER entry evaluation:
   * 1. SNIPE MODE: Young tokens with EXCEPTIONAL velocity → fast entry
   * 2. SAFE MODE: Older tokens with sufficient data → pump analysis
   */
  evaluate(mint: string, marketCapSol?: number): EntryResult {
    const watchlistConfig = (config as any).watchlist || {};
    const snipeConfig = (config as any).snipeMode || {};
    const minDataPoints = watchlistConfig.minDataPoints || 20;

    // Get token data
    const priceHistory = priceFeed.getPriceHistory(mint, 300);
    const velocityMetrics = velocityTracker.getMetrics(mint);
    const tokenData = tokenWatchlist.getToken(mint);
    const tokenAgeSeconds = tokenData ? (Date.now() - tokenData.firstSeen) / 1000 : 999;

    logger.debug({
      mint: mint.substring(0, 12),
      priceHistoryLen: priceHistory.length,
      tokenAgeSeconds: tokenAgeSeconds.toFixed(0),
      hasVelocityData: !!velocityMetrics,
      marketCapSol: marketCapSol?.toFixed(2),
    }, 'Evaluating entry (two-tier)');

    // CRITICAL FIX: Minimum token age for ALL entries
    // Analysis showed trades under 3 seconds are catastrophic losers (-77% to -87%)
    // Let rugs reveal themselves before entering
    const minTokenAge = (config as any).minTokenAgeSeconds || 15;
    if (tokenAgeSeconds < minTokenAge) {
      return {
        canEnter: false,
        source: 'none',
        reason: `Token too young (${tokenAgeSeconds.toFixed(0)}s < ${minTokenAge}s minimum) - letting rugs reveal themselves`,
        metrics: undefined,
      };
    }

    // ========== TIER 1: SNIPE MODE ==========
    // Young tokens with exceptional velocity can enter fast
    if (snipeConfig.enabled && tokenAgeSeconds <= snipeConfig.maxAgeSeconds) {
      const snipeResult = this.evaluateSnipeMode(mint, velocityMetrics, marketCapSol, tokenData);

      if (snipeResult.canEnter) {
        // CRITICAL FIX: Check pump phase even in snipe mode
        // Analysis showed 100% of trades entered in "cold" phase because snipe mode bypassed this check
        const pumpMetrics = pumpDetector.analyzePump(mint);

        if ((config as any).requireNonColdPhase && pumpMetrics.phase === 'cold') {
          logger.info({
            mint: mint.substring(0, 12),
            phase: pumpMetrics.phase,
            heat: pumpMetrics.heat.toFixed(1),
            velocityOK: true,
          }, '🚫 SNIPE BLOCKED: Cold phase despite good velocity - waiting for momentum');

          // Fall through to safe mode or wait for better signals
        } else {
          logger.info({
            mint: mint.substring(0, 12),
            source: 'snipe_mode',
            tokenAgeSeconds: tokenAgeSeconds.toFixed(0),
            phase: pumpMetrics.phase,
            heat: pumpMetrics.heat.toFixed(1),
            ...snipeResult.details,
          }, '🎯 SNIPE MODE: Exceptional velocity + non-cold phase - fast entry');

          return {
            canEnter: true,
            source: 'snipe_mode',
            reason: snipeResult.reason,
            metrics: velocityMetrics || undefined,
          };
        }
      }

      // Token is young but doesn't qualify for snipe - let it age
      if (tokenAgeSeconds < 60) {
        return {
          canEnter: false,
          source: 'none',
          reason: `Young token (${tokenAgeSeconds.toFixed(0)}s) - waiting for better signals or more data`,
          metrics: undefined,
        };
      }
    }

    // ========== TIER 2: SAFE MODE ==========
    // Require sufficient price data for pump analysis
    if (priceHistory.length < minDataPoints) {
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
    }, 'Safe mode: Pump detector evaluation');

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
   * Evaluate if token qualifies for SNIPE MODE (exceptional velocity)
   */
  private evaluateSnipeMode(
    mint: string,
    velocityMetrics: any,
    marketCapSol?: number,
    tokenData?: any
  ): { canEnter: boolean; reason: string; details?: any } {
    const cfg = (config as any).snipeMode || {};

    // Must have velocity data
    if (!velocityMetrics) {
      return { canEnter: false, reason: 'No velocity data' };
    }

    const txCount = velocityMetrics.txCount || 0;
    const uniqueBuyers = velocityMetrics.uniqueBuyers?.size || 0;
    const buyPressure = velocityMetrics.buyPressure || 0;

    // Check market cap limit
    if (marketCapSol !== undefined && marketCapSol > cfg.maxMarketCapSol) {
      return {
        canEnter: false,
        reason: `Market cap ${marketCapSol.toFixed(0)} SOL > ${cfg.maxMarketCapSol} limit`
      };
    }

    // Check transaction count
    if (txCount < cfg.minTxCount) {
      return {
        canEnter: false,
        reason: `Only ${txCount} txs, need ${cfg.minTxCount}`
      };
    }

    // Check unique buyers
    if (uniqueBuyers < cfg.minUniqueBuyers) {
      return {
        canEnter: false,
        reason: `Only ${uniqueBuyers} unique buyers, need ${cfg.minUniqueBuyers}`
      };
    }

    // Check buy pressure
    if (buyPressure < cfg.minBuyPressure) {
      return {
        canEnter: false,
        reason: `Buy pressure ${(buyPressure * 100).toFixed(0)}% < ${(cfg.minBuyPressure * 100).toFixed(0)}%`
      };
    }

    // All snipe conditions met!
    return {
      canEnter: true,
      reason: `SNIPE: ${txCount} txs, ${uniqueBuyers} buyers, ${(buyPressure * 100).toFixed(0)}% buys`,
      details: {
        txCount,
        uniqueBuyers,
        buyPressure: (buyPressure * 100).toFixed(0) + '%',
        marketCapSol: marketCapSol?.toFixed(2),
      },
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
