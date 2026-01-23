import { createChildLogger } from '../utils/logger';
import { priceFeed } from '../data/price-feed';
import { PriceData } from '../data/types';
import { PumpPhase, PumpMetrics } from './types';
import { config } from '../config/settings';
import { velocityTracker } from './velocity-tracker';

const logger = createChildLogger('pump-detector');

export class PumpDetector {
  private pumpHistories: Map<string, PumpMetrics[]> = new Map();
  private maxHistory = 60; // 1 minute of history
  private tokenLows: Map<string, number> = new Map(); // Track lowest price seen

  constructor() {}

  analyzePump(mint: string): PumpMetrics {
    const history = priceFeed.getPriceHistory(mint, 300);

    if (history.length < 10) {
      return this.getDefaultMetrics();
    }

    // Track lowest price seen for this token
    const currentPrice = history[history.length - 1].priceSol;
    const lowestInHistory = Math.min(...history.map(h => h.priceSol));
    const existingLow = this.tokenLows.get(mint);
    const lowestPrice = existingLow ? Math.min(existingLow, lowestInHistory) : lowestInHistory;
    this.tokenLows.set(mint, lowestPrice);

    // Calculate how much it's already pumped from the low
    const pumpFromLow = lowestPrice > 0 ? (currentPrice - lowestPrice) / lowestPrice : 0;

    // Calculate volume ratio (1min / 5min)
    // PREFER real trade count from velocity tracker when available
    let volumeRatio: number;
    const velocityMetrics = velocityTracker.getMetrics(mint);

    if (velocityMetrics && velocityMetrics.txCount >= 5) {
      // Use real trade intensity: trades per minute normalized
      // 10+ trades/min = hot, 5+ = building, <5 = cold
      const tradesPerMin = velocityMetrics.txPerMinute;
      volumeRatio = tradesPerMin / 10;  // Normalize so 10 trades/min = 1.0
      logger.debug({
        mint: mint.substring(0, 12),
        source: 'velocity_tracker',
        tradesPerMin: tradesPerMin.toFixed(1),
        volumeRatio: volumeRatio.toFixed(2),
      }, 'Using real trade count for volume');
    } else {
      // FALLBACK: Use price-based volume proxy
      const volume1m = this.getVolumeWindow(history, 60);
      const volume5m = this.getVolumeWindow(history, 300);
      volumeRatio = volume5m > 0 ? volume1m / volume5m : 0;
    }

    // Calculate heat metric
    const heat = volumeRatio * 100;

    // Determine phase based on heat and price velocity
    const priceVelocity = this.calculatePriceVelocity(history);
    const buyPressure = this.calculateBuyPressure(history, mint);  // Pass mint for real trade data

    // Check for momentum decay (heat fading from previous highs)
    const pumpHistory = this.pumpHistories.get(mint) || [];
    const recentHeatPeak = pumpHistory.length >= 3
      ? Math.max(...pumpHistory.slice(-10).map(h => h.heat))
      : heat;
    const heatDecay = recentHeatPeak > 0 ? (recentHeatPeak - heat) / recentHeatPeak : 0;

    // Check for buy pressure decay
    const recentBuyPressurePeak = pumpHistory.length >= 3
      ? Math.max(...pumpHistory.slice(-10).map(h => h.buyPressure))
      : buyPressure;
    const buyPressureDecay = recentBuyPressurePeak > 0.5
      ? (recentBuyPressurePeak - buyPressure) / recentBuyPressurePeak
      : 0;

    const phase = this.determinePhase(heat, priceVelocity, buyPressure, pumpFromLow, heatDecay);
    const confidence = this.calculateConfidence(history, phase);

    const metrics: PumpMetrics = {
      phase,
      heat,
      volumeRatio,
      priceVelocity,
      buyPressure,
      confidence,
      // NEW: Track pump position and decay
      pumpFromLow,
      heatDecay,
      buyPressureDecay,
    };

    // Update history
    this.updateHistory(mint, metrics);

    logger.debug({
      mint,
      phase,
      heat: heat.toFixed(1),
      pumpFromLow: (pumpFromLow * 100).toFixed(0) + '%',
      heatDecay: (heatDecay * 100).toFixed(0) + '%',
      buyPressureDecay: (buyPressureDecay * 100).toFixed(0) + '%',
    }, 'Pump analysis');

    return metrics;
  }

  private getDefaultMetrics(): PumpMetrics {
    return {
      phase: 'cold',
      heat: 0,
      volumeRatio: 0,
      priceVelocity: 0,
      buyPressure: 0.5,
      confidence: 0,
    };
  }

  private getVolumeWindow(history: PriceData[], seconds: number): number {
    const cutoff = Date.now() - seconds * 1000;
    const windowData = history.filter((h) => h.timestamp.getTime() >= cutoff);

    if (windowData.length < 2) return 0;

    // Sum of absolute price changes as volume proxy
    let volume = 0;
    for (let i = 1; i < windowData.length; i++) {
      volume += Math.abs(windowData[i].priceSol - windowData[i - 1].priceSol);
    }

    return volume;
  }

  private calculatePriceVelocity(history: PriceData[]): number {
    if (history.length < 10) return 0;

    // Price velocity = rate of price change over recent period
    const recent = history.slice(-30); // Last 30 seconds
    if (recent.length < 2) return 0;

    const startPrice = recent[0].priceSol;
    const endPrice = recent[recent.length - 1].priceSol;
    const timeDiff = (recent[recent.length - 1].timestamp.getTime() - recent[0].timestamp.getTime()) / 1000;

    if (timeDiff === 0 || startPrice === 0) return 0;

    // Percentage change per second
    const velocity = ((endPrice - startPrice) / startPrice) * 100 / timeDiff;

    return velocity;
  }

  private calculateBuyPressure(history: PriceData[], mint?: string): number {
    // PREFER real trade data from velocity tracker when available
    if (mint) {
      const velocityMetrics = velocityTracker.getMetrics(mint);
      if (velocityMetrics && velocityMetrics.txCount >= 5) {
        // Use actual buy/sell ratio from real trades
        logger.debug({
          mint: mint.substring(0, 12),
          source: 'velocity_tracker',
          buyPressure: velocityMetrics.buyPressure.toFixed(2),
          txCount: velocityMetrics.txCount,
        }, 'Using real trade data for buy pressure');
        return velocityMetrics.buyPressure;
      }
    }

    // FALLBACK: Infer from price movements (less accurate)
    if (history.length < 10) return 0.5;

    const recent = history.slice(-60); // Last minute
    let upMoves = 0;
    let downMoves = 0;

    for (let i = 1; i < recent.length; i++) {
      const change = recent[i].priceSol - recent[i - 1].priceSol;
      if (change > 0) upMoves++;
      else if (change < 0) downMoves++;
    }

    const total = upMoves + downMoves;
    if (total === 0) return 0.5;

    return upMoves / total;
  }

  private determinePhase(
    heat: number,
    priceVelocity: number,
    buyPressure: number,
    pumpFromLow: number = 0,
    heatDecay: number = 0
  ): PumpPhase {
    // Phase determination based on heat metric and supporting indicators

    // Dumping: negative velocity with strong selling pressure
    if (priceVelocity < -2 && buyPressure < 0.3) {
      return 'dumping';
    }

    // Peak: very high heat but clearly slowing
    if (heat > 120 && priceVelocity < 0) {
      return 'peak';
    }

    // Hot: high heat with momentum
    if (heat >= 48 && buyPressure > 0.45) {
      return 'hot';
    }

    // Building: moderate heat with buying
    if (heat >= 25 && buyPressure > 0.45) {
      return 'building';
    }

    // Cold: low activity
    return 'cold';
  }

  private calculateConfidence(history: PriceData[], phase: PumpPhase): number {
    if (history.length < 30) return 0.3;

    // Base confidence on data quality
    let confidence = Math.min(history.length / 100, 0.5);

    // Adjust based on signal clarity
    const recent = history.slice(-30);
    const priceChanges = [];

    for (let i = 1; i < recent.length; i++) {
      priceChanges.push((recent[i].priceSol - recent[i - 1].priceSol) / recent[i - 1].priceSol);
    }

    // Calculate consistency of direction
    const positiveChanges = priceChanges.filter((c) => c > 0).length;
    const consistency = Math.abs(positiveChanges / priceChanges.length - 0.5) * 2;

    confidence += consistency * 0.3;

    // Phase-specific adjustments
    if (phase === 'hot' || phase === 'peak') {
      confidence += 0.2;
    }

    return Math.min(confidence, 1);
  }

  private updateHistory(mint: string, metrics: PumpMetrics): void {
    let history = this.pumpHistories.get(mint) || [];
    history.push(metrics);

    if (history.length > this.maxHistory) {
      history = history.slice(-this.maxHistory);
    }

    this.pumpHistories.set(mint, history);
  }

  isGoodEntry(metrics: PumpMetrics): boolean {
    // Reject clearly dumping tokens
    if (metrics.phase === 'dumping') {
      logger.info({ phase: metrics.phase }, 'Rejecting - clearly dumping');
      return false;
    }

    // Reject if heat is below minimum threshold
    if (metrics.heat < (config as any).minPumpHeat) {
      logger.debug({ heat: metrics.heat, minRequired: (config as any).minPumpHeat }, 'Rejecting low heat token');
      return false;
    }

    // Good entry: building phase with decent confidence, or early hot
    if (metrics.phase === 'building' && metrics.confidence > 0.4 && metrics.buyPressure > 0.5) {
      return true;
    }

    if (metrics.phase === 'hot' && metrics.heat < 80 && metrics.confidence > 0.4) {
      return true;
    }

    // Allow entry if buy pressure is strong regardless of phase
    if (metrics.buyPressure > 0.65 && metrics.heat > 20) {
      return true;
    }

    return false;
  }

  shouldExit(metrics: PumpMetrics, profitPercent?: number): boolean {
    // CRITICAL: Only use pump exit signals if we're in decent profit
    // Don't panic sell at a loss just because momentum dipped - that locks in losses
    // and misses recovery pumps
    const inProfit = profitPercent !== undefined && profitPercent > 0.10; // Only exit on signals if +10%+

    // Exit signals - only trigger if clearly dumping
    if (metrics.phase === 'dumping') {
      logger.info({ phase: metrics.phase }, 'EXIT SIGNAL: Clearly dumping');
      return true;
    }

    // Rapid sustained price drop - only if REALLY fast
    if (metrics.priceVelocity < -5 && metrics.confidence > 0.6) {
      logger.info({ priceVelocity: metrics.priceVelocity }, 'EXIT SIGNAL: Rapid price crash');
      return true;
    }

    // CONSERVATIVE: Only exit on momentum decay if:
    // 1. We're in decent profit (don't lock in losses)
    // 2. The decay is severe (60%+, not just 40%)
    // 3. Price is also dropping (not just low volume consolidation)
    if (inProfit && metrics.heatDecay && metrics.heatDecay > 0.6 && metrics.priceVelocity < -1) {
      logger.info({
        heatDecay: (metrics.heatDecay * 100).toFixed(0) + '%',
        priceVelocity: metrics.priceVelocity.toFixed(2),
        profitPercent: profitPercent ? (profitPercent * 100).toFixed(0) + '%' : 'N/A',
      }, 'EXIT SIGNAL: Momentum fading with price dropping (while in profit)');
      return true;
    }

    // CONSERVATIVE: Buy pressure collapse - only if severe AND price dropping
    if (inProfit && metrics.buyPressureDecay && metrics.buyPressureDecay > 0.5
        && metrics.buyPressure < 0.35 && metrics.priceVelocity < -1) {
      logger.info({
        buyPressure: (metrics.buyPressure * 100).toFixed(0) + '%',
        buyPressureDecay: (metrics.buyPressureDecay * 100).toFixed(0) + '%',
        profitPercent: profitPercent ? (profitPercent * 100).toFixed(0) + '%' : 'N/A',
      }, 'EXIT SIGNAL: Buy pressure collapsed with price dropping');
      return true;
    }

    return false;
  }

  getPumpHistory(mint: string): PumpMetrics[] {
    return this.pumpHistories.get(mint) || [];
  }

  detectPhaseTransition(mint: string): { from: PumpPhase; to: PumpPhase } | null {
    const history = this.pumpHistories.get(mint);
    if (!history || history.length < 2) return null;

    const current = history[history.length - 1].phase;
    const previous = history[history.length - 2].phase;

    if (current !== previous) {
      logger.info({ mint, from: previous, to: current }, 'Phase transition detected');
      return { from: previous, to: current };
    }

    return null;
  }

  clearHistory(mint: string): void {
    this.pumpHistories.delete(mint);
    this.tokenLows.delete(mint);
  }
}

export const pumpDetector = new PumpDetector();
