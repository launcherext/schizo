import { createChildLogger } from '../utils/logger';
import { PositionSizeResult, MarketRegime } from './types';
import { regimeDetector } from './regime-detector';
import { config } from '../config/settings';

const logger = createChildLogger('position-sizer');

export class PositionSizer {
  private winHistory: boolean[] = [];
  private maxHistory = 100;

  constructor() {}

  calculateSize(
    availableCapital: number,
    winProbability?: number,
    avgWinLossRatio?: number,
    currentRegime?: MarketRegime,
    confidence?: number  // NEW: Use confidence as size multiplier
  ): PositionSizeResult {
    // Get regime multiplier
    const regime = currentRegime ?? regimeDetector.getCurrentRegime().regime;
    const regimeMultiplier = regimeDetector.getRegimeMultiplier(regime);

    // Calculate Kelly fraction
    const kellyFraction = this.calculateKellyFraction(winProbability, avgWinLossRatio);

    // NEW: Calculate confidence multiplier
    // 0.55 confidence → 0.55x size, 0.80 confidence → 1.0x size
    // Scale from 0.55-1.0 confidence to 0.6-1.0 multiplier
    let confidenceMultiplier = 1.0;
    if (confidence !== undefined) {
      // Clamp confidence to reasonable range
      const clampedConf = Math.max(0.4, Math.min(1.0, confidence));
      // Scale: 0.4 conf → 0.5x, 0.7 conf → 0.75x, 1.0 conf → 1.0x
      confidenceMultiplier = 0.5 + (clampedConf - 0.4) * (0.5 / 0.6);
    }

    // BASE_POSITION_SOL is the MINIMUM position size
    // Kelly/confidence can scale UP from base, but never below it
    const baseSize = config.tradeAmountSol; // 0.03 SOL from BASE_POSITION_SOL env

    // Kelly multiplier: 1.0 to 3.0x based on win rate and confidence
    // Higher kelly fraction + higher confidence = larger position
    const kellyMultiplier = 1.0 + (kellyFraction * 4) + (confidenceMultiplier - 0.5);
    const adjustedSize = baseSize * Math.min(3.0, Math.max(1.0, kellyMultiplier)) * regimeMultiplier;

    // Apply hard limits
    const maxSize = config.maxPositionSize * config.initialCapitalSol;

    const finalSize = Math.max(baseSize, Math.min(maxSize, adjustedSize));

    const reason = this.buildReason(kellyFraction, regimeMultiplier, adjustedSize, finalSize, confidenceMultiplier);

    const result: PositionSizeResult = {
      sizeSol: finalSize,
      kellyFraction,
      regimeMultiplier,
      riskAdjustedSize: adjustedSize,
      reason,
    };

    logger.debug({
      baseSize: baseSize.toFixed(4),
      kellyMultiplier: kellyMultiplier.toFixed(2),
      regimeMultiplier,
      confidenceMultiplier: confidenceMultiplier.toFixed(2),
      adjustedSize: adjustedSize.toFixed(4),
      finalSize: finalSize.toFixed(4),
    }, 'Position size calculated');

    return result;
  }

  private calculateKellyFraction(winProb?: number, winLossRatio?: number): number {
    // Default estimates if not provided
    const p = winProb ?? this.estimateWinProbability();
    const r = winLossRatio ?? 2.0; // Assume 2:1 reward:risk by default

    // Kelly formula: f = (p * r - (1 - p)) / r
    // Or: f = p - (1 - p) / r
    const kelly = p - (1 - p) / r;

    // Half-Kelly for safety
    const halfKelly = kelly / 2;

    // Clamp to reasonable range [0, 0.25] (max 25% of capital)
    return Math.max(0, Math.min(0.25, halfKelly));
  }

  private estimateWinProbability(): number {
    if (this.winHistory.length < 10) {
      return 0.4; // Conservative default
    }

    const wins = this.winHistory.filter(Boolean).length;
    return wins / this.winHistory.length;
  }

  recordTrade(isWin: boolean): void {
    this.winHistory.push(isWin);

    if (this.winHistory.length > this.maxHistory) {
      this.winHistory.shift();
    }
  }

  private buildReason(
    kellyFraction: number,
    regimeMultiplier: number,
    rawSize: number,
    finalSize: number,
    confidenceMultiplier?: number
  ): string {
    const parts: string[] = [];

    parts.push(`Kelly: ${(kellyFraction * 100).toFixed(1)}%`);
    parts.push(`Regime: ${regimeDetector.getRegimeName()} (${(regimeMultiplier * 100).toFixed(0)}%)`);

    if (confidenceMultiplier !== undefined && confidenceMultiplier !== 1.0) {
      parts.push(`Conf: ${(confidenceMultiplier * 100).toFixed(0)}%`);
    }

    if (finalSize < rawSize) {
      parts.push(`Capped from ${rawSize.toFixed(4)} SOL`);
    }

    return parts.join(', ');
  }

  // Calculate optimal size for a specific trade setup
  calculateForTrade(params: {
    entryPrice: number;
    stopLoss: number;
    takeProfit: number;
    availableCapital: number;
    confidence: number;
  }): PositionSizeResult {
    const { entryPrice, stopLoss, takeProfit, availableCapital, confidence } = params;

    // Calculate risk/reward
    const riskPercent = Math.abs((entryPrice - stopLoss) / entryPrice);
    const rewardPercent = Math.abs((takeProfit - entryPrice) / entryPrice);
    const riskRewardRatio = rewardPercent / riskPercent;

    // Adjust win probability by confidence
    const baseWinProb = 0.4;
    const adjustedWinProb = baseWinProb + (confidence - 0.5) * 0.2;

    // Calculate Kelly with trade-specific parameters
    return this.calculateSize(availableCapital, adjustedWinProb, riskRewardRatio);
  }

  // Get suggested position count based on portfolio theory
  getOptimalPositionCount(totalCapital: number): number {
    const regime = regimeDetector.getCurrentRegime().regime;

    // More concentrated in bull, more diversified in volatile/crash
    switch (regime) {
      case MarketRegime.BULL:
        return 3; // Concentrated bets
      case MarketRegime.VOLATILE:
        return 5; // Moderate diversification
      case MarketRegime.CRASH:
        return Math.min(config.maxConcurrentPositions, 2); // Very selective
      default:
        return 4;
    }
  }

  getWinRate(): number {
    if (this.winHistory.length === 0) return 0.5;
    return this.winHistory.filter(Boolean).length / this.winHistory.length;
  }

  clearHistory(): void {
    this.winHistory = [];
  }
}

export const positionSizer = new PositionSizer();
