/**
 * Entertainment Mode - Degen trading for activity over profit
 *
 * Purpose: Make the agent trade frequently (3-5/hour) with micro bets
 * so it's entertaining to watch, even if individual trades aren't optimal.
 */

import { MoodSystem, type MoodEffects } from '../personality/mood-system.js';
import { logger } from '../lib/logger.js';

/**
 * Token context for entertainment mode evaluation
 */
export interface TokenContext {
  mint: string;
  name?: string;
  symbol?: string;
  priceUsd?: number;
  volumeUsd24h?: number;
  liquiditySol?: number;
  holderCount?: number;
  createdAt?: number;
  hasMinAuthorities?: boolean; // Mint auth present
  hasFreezeAuth?: boolean;
}

/**
 * Entertainment mode configuration
 */
export interface EntertainmentConfig {
  enabled: boolean;

  // Micro betting
  minPositionSol: number;       // Minimum bet (default: 0.01)
  maxPositionSol: number;       // Maximum bet (default: 0.05)

  // Time pressure
  quietPeriodMs: number;        // Time before restlessness (default: 5 min)
  maxQuietPeriodMs: number;     // Maximum time before forced trade (default: 15 min)

  // Risk thresholds
  baseRiskThreshold: number;    // Starting risk threshold (default: 6/10)
  minRiskThreshold: number;     // Minimum when desperate (default: 4/10)

  // Degen moments
  degenChance: number;          // Chance of random ape (default: 0.08 = 8%)

  // Rate limiting
  cooldownMs: number;           // Minimum time between trades (default: 5 min)
  maxTradesPerHour: number;     // Maximum trades per hour (default: 6)

  // Volume/hype detection
  minVolumeForHype: number;     // USD volume to consider "hype" (default: 10000)
  minHolderCountForHype: number; // Holder count for legitimacy (default: 50)
}

/**
 * Default entertainment config
 */
export const DEFAULT_ENTERTAINMENT_CONFIG: EntertainmentConfig = {
  enabled: false,

  // Micro positions: 0.01-0.05 SOL (~$2-10 at $200/SOL)
  minPositionSol: 0.01,
  maxPositionSol: 0.05,

  // Time pressure builds over 5-15 minutes
  quietPeriodMs: 5 * 60 * 1000,       // 5 minutes
  maxQuietPeriodMs: 15 * 60 * 1000,   // 15 minutes

  // Risk threshold: 6/10 base, drops to 4/10 when desperate
  baseRiskThreshold: 0.6,
  minRiskThreshold: 0.4,

  // 8% chance of random degen ape
  degenChance: 0.08,

  // Rate limiting: 5 min cooldown, 6 trades/hour max
  cooldownMs: 5 * 60 * 1000,          // 5 minutes
  maxTradesPerHour: 6,

  // Hype detection thresholds
  minVolumeForHype: 10000,            // $10k volume
  minHolderCountForHype: 50,          // 50 holders
};

/**
 * Entertainment decision result
 */
export interface EntertainmentDecision {
  shouldTrade: boolean;
  positionSizeSol: number;
  reason: string;
  isDegenMoment: boolean;
  isHypeTrade: boolean;
  timePressure: number;          // 0-1
  currentRiskThreshold: number;  // Adjusted threshold
}

/**
 * Internal tracking for rate limiting
 */
interface TradeRecord {
  timestamp: number;
  mint: string;
}

/**
 * EntertainmentMode - Degen trading decisions for activity
 */
export class EntertainmentMode {
  private config: EntertainmentConfig;
  private moodSystem?: MoodSystem;
  private lastTradeTime: number = 0;
  private recentTrades: TradeRecord[] = [];

  constructor(config: Partial<EntertainmentConfig> = {}, moodSystem?: MoodSystem) {
    this.config = { ...DEFAULT_ENTERTAINMENT_CONFIG, ...config };
    this.moodSystem = moodSystem;

    logger.info({
      config: this.config,
      hasMoodSystem: !!moodSystem
    }, 'EntertainmentMode initialized');
  }

  /**
   * Main evaluation method - decides if we should trade this token
   */
  evaluate(context: TokenContext): EntertainmentDecision {
    // Get time pressure and mood effects
    const timePressure = this.calculateTimePressure();
    const moodEffects = this.getMoodEffects();

    // Calculate adjusted risk threshold based on time pressure and mood
    const currentRiskThreshold = this.calculateRiskThreshold(timePressure, moodEffects);

    // Check cooldown first
    if (!this.canTradeYet()) {
      const cooldownRemaining = this.config.cooldownMs - (Date.now() - this.lastTradeTime);
      return {
        shouldTrade: false,
        positionSizeSol: 0,
        reason: `Cooldown active (${Math.ceil(cooldownRemaining / 1000)}s remaining)`,
        isDegenMoment: false,
        isHypeTrade: false,
        timePressure,
        currentRiskThreshold,
      };
    }

    // Check hourly limit
    if (this.isHourlyLimitReached()) {
      return {
        shouldTrade: false,
        positionSizeSol: 0,
        reason: `Hourly limit reached (${this.config.maxTradesPerHour} trades)`,
        isDegenMoment: false,
        isHypeTrade: false,
        timePressure,
        currentRiskThreshold,
      };
    }

    // Check for degen moment (random ape)
    const isDegenMoment = this.checkDegenMoment();
    if (isDegenMoment) {
      const position = this.calculatePosition(timePressure, moodEffects, true);
      return {
        shouldTrade: true,
        positionSizeSol: position,
        reason: 'DEGEN MOMENT - random ape activated',
        isDegenMoment: true,
        isHypeTrade: false,
        timePressure,
        currentRiskThreshold,
      };
    }

    // Check for critical risks (even in entertainment mode, we avoid honeypots)
    if (context.hasMinAuthorities || context.hasFreezeAuth) {
      return {
        shouldTrade: false,
        positionSizeSol: 0,
        reason: 'Critical risk (mint/freeze authority) - even degens have limits',
        isDegenMoment: false,
        isHypeTrade: false,
        timePressure,
        currentRiskThreshold,
      };
    }

    // Check for hype (volume + holders)
    const isHypeTrade = this.detectHype(context);
    if (isHypeTrade) {
      const position = this.calculatePosition(timePressure, moodEffects, false);
      return {
        shouldTrade: true,
        positionSizeSol: position,
        reason: `HYPE detected - volume: $${context.volumeUsd24h?.toFixed(0) || 'N/A'}, holders: ${context.holderCount || 'N/A'}`,
        isDegenMoment: false,
        isHypeTrade: true,
        timePressure,
        currentRiskThreshold,
      };
    }

    // Calculate a "quality score" for the token (simplified)
    const qualityScore = this.calculateQualityScore(context);

    // With time pressure, our standards drop
    if (qualityScore >= currentRiskThreshold) {
      const position = this.calculatePosition(timePressure, moodEffects, false);
      return {
        shouldTrade: true,
        positionSizeSol: position,
        reason: `Quality score ${(qualityScore * 10).toFixed(1)}/10 passes threshold ${(currentRiskThreshold * 10).toFixed(1)}/10`,
        isDegenMoment: false,
        isHypeTrade: false,
        timePressure,
        currentRiskThreshold,
      };
    }

    // Didn't pass threshold
    return {
      shouldTrade: false,
      positionSizeSol: 0,
      reason: `Quality score ${(qualityScore * 10).toFixed(1)}/10 below threshold ${(currentRiskThreshold * 10).toFixed(1)}/10`,
      isDegenMoment: false,
      isHypeTrade: false,
      timePressure,
      currentRiskThreshold,
    };
  }

  /**
   * Calculate time pressure (0-1) based on time since last trade
   * 0 = just traded, 1 = max quiet period reached
   */
  calculateTimePressure(): number {
    if (this.lastTradeTime === 0) {
      // Never traded - start with some pressure
      return 0.5;
    }

    const timeSinceTrade = Date.now() - this.lastTradeTime;

    // No pressure during cooldown
    if (timeSinceTrade < this.config.cooldownMs) {
      return 0;
    }

    // Pressure builds between quiet period start and max
    const pressureStart = this.config.quietPeriodMs;
    const pressureEnd = this.config.maxQuietPeriodMs;

    if (timeSinceTrade < pressureStart) {
      return 0;
    }

    if (timeSinceTrade >= pressureEnd) {
      return 1;
    }

    // Linear interpolation between start and end
    return (timeSinceTrade - pressureStart) / (pressureEnd - pressureStart);
  }

  /**
   * Check for degen moment (random chance to ape)
   */
  checkDegenMoment(): boolean {
    // Get mood-adjusted degen chance
    const moodEffects = this.getMoodEffects();

    // MANIC mood doubles degen chance, PARANOID halves it
    let adjustedChance = this.config.degenChance;
    if (moodEffects) {
      if (moodEffects.urgency >= 0.9) {
        adjustedChance *= 2; // MANIC doubles
      } else if (moodEffects.riskMultiplier < 0.7) {
        adjustedChance *= 0.5; // PARANOID halves
      }
    }

    const roll = Math.random();
    const isDegen = roll < adjustedChance;

    if (isDegen) {
      logger.info({
        roll: roll.toFixed(4),
        threshold: adjustedChance.toFixed(4)
      }, 'DEGEN MOMENT triggered');

      // Also trigger manic mood if we have mood system
      this.moodSystem?.triggerManicEpisode('degen moment in entertainment mode');
    }

    return isDegen;
  }

  /**
   * Record that a trade was made (for cooldown/rate limiting)
   */
  recordTrade(mint: string): void {
    const now = Date.now();
    this.lastTradeTime = now;
    this.recentTrades.push({ timestamp: now, mint });

    // Clean up old trades (keep last hour)
    const oneHourAgo = now - 60 * 60 * 1000;
    this.recentTrades = this.recentTrades.filter(t => t.timestamp > oneHourAgo);

    logger.debug({
      mint,
      tradesLastHour: this.recentTrades.length
    }, 'Trade recorded in entertainment mode');
  }

  /**
   * Get current stats for debugging
   */
  getStats(): {
    enabled: boolean;
    lastTradeTime: number;
    timeSinceLastTrade: number;
    timePressure: number;
    tradesLastHour: number;
    canTradeNow: boolean;
    currentRiskThreshold: number;
    moodActive: boolean;
  } {
    const timePressure = this.calculateTimePressure();
    const moodEffects = this.getMoodEffects();

    return {
      enabled: this.config.enabled,
      lastTradeTime: this.lastTradeTime,
      timeSinceLastTrade: this.lastTradeTime === 0 ? -1 : Date.now() - this.lastTradeTime,
      timePressure,
      tradesLastHour: this.getTradesInLastHour(),
      canTradeNow: this.canTradeYet() && !this.isHourlyLimitReached(),
      currentRiskThreshold: this.calculateRiskThreshold(timePressure, moodEffects),
      moodActive: !!this.moodSystem,
    };
  }

  /**
   * Update configuration at runtime
   */
  setConfig(config: Partial<EntertainmentConfig>): void {
    this.config = { ...this.config, ...config };
    logger.info({ config: this.config }, 'EntertainmentMode config updated');
  }

  /**
   * Set or update mood system reference
   */
  setMoodSystem(moodSystem: MoodSystem): void {
    this.moodSystem = moodSystem;
    logger.debug('MoodSystem attached to EntertainmentMode');
  }

  // ============ Private Methods ============

  /**
   * Get mood effects (if mood system available)
   */
  private getMoodEffects(): MoodEffects | null {
    return this.moodSystem?.getEffects() || null;
  }

  /**
   * Calculate risk threshold based on time pressure and mood
   */
  private calculateRiskThreshold(timePressure: number, moodEffects: MoodEffects | null): number {
    // Base threshold drops with time pressure
    const base = this.config.baseRiskThreshold;
    const min = this.config.minRiskThreshold;

    // Linear decrease from base to min as pressure increases
    let threshold = base - (timePressure * (base - min));

    // Apply mood modifier
    if (moodEffects) {
      // Higher risk multiplier = we accept more risk = lower threshold
      // riskMultiplier of 1.5 means we accept 50% more risk
      // So threshold becomes threshold / riskMultiplier
      threshold = threshold / moodEffects.riskMultiplier;
    }

    // Clamp to valid range
    return Math.max(0.2, Math.min(0.8, threshold));
  }

  /**
   * Calculate position size based on pressure and mood
   */
  private calculatePosition(
    timePressure: number,
    moodEffects: MoodEffects | null,
    isDegen: boolean
  ): number {
    // Start with base position (middle of range)
    let position = (this.config.minPositionSol + this.config.maxPositionSol) / 2;

    // Degen moments use random position in range
    if (isDegen) {
      position = this.config.minPositionSol +
        (Math.random() * (this.config.maxPositionSol - this.config.minPositionSol));
    }

    // Apply mood multiplier
    if (moodEffects) {
      position *= moodEffects.positionSizeMultiplier;
    }

    // Clamp to configured range
    return Math.max(
      this.config.minPositionSol,
      Math.min(this.config.maxPositionSol, position)
    );
  }

  /**
   * Check if cooldown has passed
   */
  private canTradeYet(): boolean {
    if (this.lastTradeTime === 0) return true;
    return (Date.now() - this.lastTradeTime) >= this.config.cooldownMs;
  }

  /**
   * Check if hourly trade limit reached
   */
  private isHourlyLimitReached(): boolean {
    return this.getTradesInLastHour() >= this.config.maxTradesPerHour;
  }

  /**
   * Count trades in the last hour
   */
  private getTradesInLastHour(): number {
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    return this.recentTrades.filter(t => t.timestamp > oneHourAgo).length;
  }

  /**
   * Detect if token has hype (volume + holders)
   */
  private detectHype(context: TokenContext): boolean {
    const hasVolume = (context.volumeUsd24h || 0) >= this.config.minVolumeForHype;
    const hasHolders = (context.holderCount || 0) >= this.config.minHolderCountForHype;

    // Need both volume AND holders for hype (avoid wash trading)
    return hasVolume && hasHolders;
  }

  /**
   * Calculate a simple quality score for the token (0-1)
   */
  private calculateQualityScore(context: TokenContext): number {
    let score = 0.5; // Base score

    // Liquidity bonus (up to +0.2)
    if (context.liquiditySol) {
      if (context.liquiditySol >= 10) score += 0.2;
      else if (context.liquiditySol >= 5) score += 0.15;
      else if (context.liquiditySol >= 2) score += 0.1;
      else if (context.liquiditySol >= 1) score += 0.05;
    }

    // Holder count bonus (up to +0.15)
    if (context.holderCount) {
      if (context.holderCount >= 100) score += 0.15;
      else if (context.holderCount >= 50) score += 0.1;
      else if (context.holderCount >= 20) score += 0.05;
    }

    // Volume bonus (up to +0.15)
    if (context.volumeUsd24h) {
      if (context.volumeUsd24h >= 50000) score += 0.15;
      else if (context.volumeUsd24h >= 10000) score += 0.1;
      else if (context.volumeUsd24h >= 1000) score += 0.05;
    }

    // Age penalty for very new tokens (less than 1 hour)
    if (context.createdAt) {
      const ageMs = Date.now() - context.createdAt;
      if (ageMs < 60 * 60 * 1000) {
        score -= 0.1; // New token penalty
      }
    }

    return Math.max(0, Math.min(1, score));
  }
}
