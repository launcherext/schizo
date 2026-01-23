import { createChildLogger } from '../utils/logger';
import { priceFeed } from '../data/price-feed';
import { PriceData } from '../data/types';
import { PumpPhase, PumpMetrics } from './types';
import { config } from '../config/settings';

const logger = createChildLogger('pump-detector');

export class PumpDetector {
  private pumpHistories: Map<string, PumpMetrics[]> = new Map();
  private maxHistory = 60; // 1 minute of history

  constructor() {}

  analyzePump(mint: string): PumpMetrics {
    const history = priceFeed.getPriceHistory(mint, 300);

    if (history.length < 10) {
      return this.getDefaultMetrics();
    }

    // Calculate volume ratio (1min / 5min)
    const volume1m = this.getVolumeWindow(history, 60);
    const volume5m = this.getVolumeWindow(history, 300);
    const volumeRatio = volume5m > 0 ? volume1m / volume5m : 0;

    // Calculate heat metric
    const heat = volumeRatio * 100;

    // Determine phase based on heat and price velocity
    const priceVelocity = this.calculatePriceVelocity(history);
    const buyPressure = this.calculateBuyPressure(history);

    const phase = this.determinePhase(heat, priceVelocity, buyPressure);
    const confidence = this.calculateConfidence(history, phase);

    const metrics: PumpMetrics = {
      phase,
      heat,
      volumeRatio,
      priceVelocity,
      buyPressure,
      confidence,
    };

    // Update history
    this.updateHistory(mint, metrics);

    logger.debug({ mint, phase, heat: heat.toFixed(1), confidence: confidence.toFixed(2) }, 'Pump analysis');

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

  private calculateBuyPressure(history: PriceData[]): number {
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

  private determinePhase(heat: number, priceVelocity: number, buyPressure: number): PumpPhase {
    // Phase determination based on heat metric and supporting indicators

    // Dumping: negative velocity with selling pressure
    if (priceVelocity < -1 && buyPressure < 0.3) {
      return 'dumping';
    }

    // Peak: very high heat but slowing
    if (heat > 100 && priceVelocity < 0.5) {
      return 'peak';
    }

    // Hot: high heat with positive momentum
    if (heat >= 48 && heat <= 100 && buyPressure > 0.5) {
      return 'hot';
    }

    // Building: moderate heat with buying
    if (heat >= 33 && heat < 48 && buyPressure > 0.45) {
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
    // CRITICAL: Reject cold phase tokens - they have no momentum data
    // Analysis showed 100% of trades entering in "cold" phase lost money
    if ((config as any).requireNonColdPhase && metrics.phase === 'cold') {
      logger.debug({ phase: metrics.phase, heat: metrics.heat }, 'Rejecting cold phase token');
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

    if (metrics.phase === 'hot' && metrics.heat < 60 && metrics.confidence > 0.5) {
      return true;
    }

    return false;
  }

  shouldExit(metrics: PumpMetrics): boolean {
    // Exit signals
    if (metrics.phase === 'peak' || metrics.phase === 'dumping') {
      return true;
    }

    if (metrics.priceVelocity < -2 && metrics.confidence > 0.5) {
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
  }
}

export const pumpDetector = new PumpDetector();
