/**
 * Mood System - Tracks agent emotional state and affects behavior
 */

import { agentEvents } from '../events/emitter.js';
import { logger } from '../lib/logger.js';

/**
 * Agent moods - each affects trading and commentary differently
 */
export type Mood =
  | 'CONFIDENT'   // After wins - more aggressive, higher risk tolerance
  | 'PARANOID'    // After losses - blame market, more cautious
  | 'RESTLESS'    // During quiet periods - lower risk threshold, needs action
  | 'NEUTRAL'     // Default state
  | 'MANIC'       // Random degen moments - full ape mode
  | 'TILTED';     // After consecutive losses - erratic

/**
 * Mood state with metadata
 */
export interface MoodState {
  current: Mood;
  intensity: number;        // 0-1, how strong the mood is
  since: number;            // Timestamp when mood started
  trigger?: string;         // What caused this mood
  consecutiveWins: number;
  consecutiveLosses: number;
  lastTradeTime: number;
  lastSpeechTime: number;
}

/**
 * Mood effects on trading and behavior
 */
export interface MoodEffects {
  riskMultiplier: number;       // Multiplier for risk tolerance (1.0 = normal)
  positionSizeMultiplier: number; // Multiplier for position size
  speechStyle: string;          // Description of current speech style
  urgency: number;              // 0-1, how urgent to trade
}

/**
 * Mood system configuration
 */
export interface MoodConfig {
  quietPeriodMs: number;        // Time before restlessness kicks in (default: 5 min)
  maniacChance: number;         // Chance of random manic episode (default: 0.05)
  winsForConfident: number;     // Consecutive wins to trigger confident (default: 2)
  lossesForParanoid: number;    // Consecutive losses for paranoid (default: 1)
  lossesForTilted: number;      // Consecutive losses for tilted (default: 3)
  moodDecayMs: number;          // Time for mood to decay to neutral (default: 10 min)
}

const DEFAULT_CONFIG: MoodConfig = {
  quietPeriodMs: 5 * 60 * 1000,     // 5 minutes
  maniacChance: 0.05,               // 5% chance
  winsForConfident: 2,
  lossesForParanoid: 1,
  lossesForTilted: 3,
  moodDecayMs: 10 * 60 * 1000,      // 10 minutes
};

/**
 * MoodSystem - Tracks and manages agent emotional state
 */
export class MoodSystem {
  private state: MoodState;
  private config: MoodConfig;

  constructor(config: Partial<MoodConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.state = {
      current: 'NEUTRAL',
      intensity: 0.5,
      since: Date.now(),
      consecutiveWins: 0,
      consecutiveLosses: 0,
      lastTradeTime: 0,
      lastSpeechTime: 0,
    };

    logger.info({ config: this.config }, 'MoodSystem initialized');
  }

  /**
   * Get current mood state
   */
  getState(): MoodState {
    this.checkForMoodDecay();
    this.checkForRestlessness();
    return { ...this.state };
  }

  /**
   * Get current mood effects on behavior
   */
  getEffects(): MoodEffects {
    this.checkForMoodDecay();
    this.checkForRestlessness();

    const { current, intensity } = this.state;

    switch (current) {
      case 'CONFIDENT':
        return {
          riskMultiplier: 1.0 + (0.5 * intensity),      // Up to 1.5x risk
          positionSizeMultiplier: 1.0 + (0.3 * intensity), // Up to 1.3x position
          speechStyle: 'bold and self-assured, talks about reading the market',
          urgency: 0.3,
        };

      case 'PARANOID':
        return {
          riskMultiplier: 0.8 - (0.3 * intensity),      // Down to 0.5x risk
          positionSizeMultiplier: 0.9 - (0.2 * intensity), // Down to 0.7x position
          speechStyle: 'suspicious and accusatory, blames whales and manipulation',
          urgency: 0.2,
        };

      case 'RESTLESS':
        return {
          riskMultiplier: 1.2 + (0.3 * intensity),      // Up to 1.5x risk
          positionSizeMultiplier: 1.0,                   // Normal position
          speechStyle: 'antsy and impatient, talks about needing action',
          urgency: 0.7 + (0.3 * intensity),             // High urgency
        };

      case 'MANIC':
        return {
          riskMultiplier: 2.0,                          // 2x risk - full ape
          positionSizeMultiplier: 0.5,                  // But smaller positions
          speechStyle: 'chaotic and impulsive, just aping for fun',
          urgency: 1.0,                                 // Maximum urgency
        };

      case 'TILTED':
        return {
          riskMultiplier: 0.6,                          // Lower risk
          positionSizeMultiplier: 0.5,                  // Smaller positions
          speechStyle: 'erratic and bitter, everything is rigged',
          urgency: 0.4,
        };

      default: // NEUTRAL
        return {
          riskMultiplier: 1.0,
          positionSizeMultiplier: 1.0,
          speechStyle: 'analytical and watchful',
          urgency: 0.3,
        };
    }
  }

  /**
   * Record a trade result and update mood
   */
  recordTradeResult(isWin: boolean, profitPercent?: number): void {
    const now = Date.now();
    this.state.lastTradeTime = now;

    if (isWin) {
      this.state.consecutiveWins++;
      this.state.consecutiveLosses = 0;

      if (this.state.consecutiveWins >= this.config.winsForConfident) {
        this.setMood('CONFIDENT', 0.5 + (this.state.consecutiveWins * 0.1), `${this.state.consecutiveWins} consecutive wins`);
      }
    } else {
      this.state.consecutiveLosses++;
      this.state.consecutiveWins = 0;

      if (this.state.consecutiveLosses >= this.config.lossesForTilted) {
        this.setMood('TILTED', 0.8, `${this.state.consecutiveLosses} consecutive losses`);
      } else if (this.state.consecutiveLosses >= this.config.lossesForParanoid) {
        this.setMood('PARANOID', 0.5 + (this.state.consecutiveLosses * 0.15), 'lost trade');
      }
    }

    logger.info({
      isWin,
      profitPercent,
      mood: this.state.current,
      consecutiveWins: this.state.consecutiveWins,
      consecutiveLosses: this.state.consecutiveLosses,
    }, 'Trade result recorded');
  }

  /**
   * Record that speech happened (for timing)
   */
  recordSpeech(): void {
    this.state.lastSpeechTime = Date.now();
  }

  /**
   * Check if enough time has passed since last speech (15-20s minimum)
   */
  canSpeak(minimumGapMs: number = 15000): boolean {
    const timeSinceLastSpeech = Date.now() - this.state.lastSpeechTime;
    return timeSinceLastSpeech >= minimumGapMs;
  }

  /**
   * Get time until speech is allowed
   */
  timeUntilCanSpeak(minimumGapMs: number = 15000): number {
    const timeSinceLastSpeech = Date.now() - this.state.lastSpeechTime;
    return Math.max(0, minimumGapMs - timeSinceLastSpeech);
  }

  /**
   * Trigger a random manic episode (used for "degen moments")
   */
  triggerManicEpisode(reason: string = 'random degen moment'): boolean {
    if (Math.random() < this.config.maniacChance || reason !== 'random degen moment') {
      this.setMood('MANIC', 1.0, reason);
      return true;
    }
    return false;
  }

  /**
   * Force a specific mood (for testing or special events)
   */
  forceSetMood(mood: Mood, intensity: number = 0.7, trigger?: string): void {
    this.setMood(mood, intensity, trigger);
  }

  /**
   * Check if agent should lower risk threshold due to quiet period
   */
  shouldLowerRiskThreshold(): boolean {
    const effects = this.getEffects();
    return effects.urgency > 0.5;
  }

  /**
   * Get time since last trade
   */
  getTimeSinceLastTrade(): number {
    if (this.state.lastTradeTime === 0) return Infinity;
    return Date.now() - this.state.lastTradeTime;
  }

  /**
   * Internal: Set mood and emit event
   */
  private setMood(mood: Mood, intensity: number, trigger?: string): void {
    const previous = this.state.current;

    this.state.current = mood;
    this.state.intensity = Math.min(1, Math.max(0, intensity));
    this.state.since = Date.now();
    this.state.trigger = trigger;

    logger.info({
      from: previous,
      to: mood,
      intensity: this.state.intensity,
      trigger,
    }, 'Mood changed');

    // Emit mood change event
    agentEvents.emit({
      type: 'MOOD_CHANGE',
      timestamp: Date.now(),
      data: {
        previous,
        current: mood,
        intensity: this.state.intensity,
        trigger,
      },
    });
  }

  /**
   * Internal: Check if mood should decay to neutral
   */
  private checkForMoodDecay(): void {
    if (this.state.current === 'NEUTRAL') return;

    const moodAge = Date.now() - this.state.since;
    if (moodAge > this.config.moodDecayMs) {
      this.setMood('NEUTRAL', 0.5, 'mood decay');
    }
  }

  /**
   * Internal: Check if restlessness should kick in
   */
  private checkForRestlessness(): void {
    if (this.state.current !== 'NEUTRAL') return;

    const timeSinceTrade = this.getTimeSinceLastTrade();
    if (timeSinceTrade > this.config.quietPeriodMs) {
      const intensity = Math.min(1, (timeSinceTrade - this.config.quietPeriodMs) / this.config.quietPeriodMs);
      this.setMood('RESTLESS', 0.5 + (intensity * 0.5), `no trades for ${Math.floor(timeSinceTrade / 60000)} minutes`);
    }
  }
}
