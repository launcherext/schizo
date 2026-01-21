
/**
 * Market Watcher - Observes market activity and learns patterns
 *
 * Watches:
 * - New token launches
 * - Price movements
 * - Whale activity
 * - Rug pulls
 * - Smart money movements
 *
 * Learns:
 * - Timing patterns
 * - Wallet behaviors
 * - Token lifecycle patterns
 * - Correlation between signals and outcomes
 */

import { createLogger } from '../lib/logger.js';
import { agentEvents } from '../events/emitter.js';
import type { ClaudeClient, MarketEvent, MarketObservation } from '../personality/claude-client.js';
import type { VoiceNarrator } from '../personality/deepgram-tts.js';
import type { DatabaseWithRepositories } from '../db/database-with-repos.js';

const logger = createLogger('market-watcher');

/**
 * Observed token data
 */
interface ObservedToken {
  mint: string;
  name?: string;
  symbol?: string;
  firstSeenAt: number;
  lastSeenAt: number;
  initialPrice?: number;
  currentPrice?: number;
  priceHistory: Array<{ price: number; timestamp: number }>;
  events: MarketEvent[];
  outcome?: 'PUMP' | 'DUMP' | 'RUG' | 'STABLE' | 'UNKNOWN';
}

/**
 * Learned pattern
 */
interface LearnedPattern {
  id: string;
  type: 'TIMING' | 'WALLET' | 'TOKEN' | 'PRICE' | 'CORRELATION';
  description: string;
  confidence: number; // 0-1
  occurrences: number;
  lastSeen: number;
  examples: string[];
}

/**
 * Market Watcher configuration
 */
export interface MarketWatcherConfig {
  observationInterval: number; // How often to observe (ms)
  learningInterval: number; // How often to generate learnings (ms)
  maxObservations: number; // Max observations to keep
  minPatternsForLearning: number; // Min observations before learning
  voiceEnabled: boolean; // Whether to voice observations
  commentaryEnabled: boolean; // Whether to generate commentary
}

/**
 * Default configuration
 */
export const DEFAULT_WATCHER_CONFIG: MarketWatcherConfig = {
  observationInterval: 30000, // 30 seconds
  learningInterval: 300000, // 5 minutes
  maxObservations: 1000,
  minPatternsForLearning: 10,
  voiceEnabled: false, // Disabled - index.ts handles voice via event handlers
  commentaryEnabled: true,
};

/**
 * Market Watcher - Observes and learns from market activity
 */
export class MarketWatcher {
  private config: MarketWatcherConfig;
  private claude?: ClaudeClient;
  private narrator?: VoiceNarrator;
  private db?: DatabaseWithRepositories;

  private observedTokens = new Map<string, ObservedToken>();
  private observations: MarketObservation[] = [];
  private learnedPatterns: LearnedPattern[] = [];

  private observeIntervalId?: NodeJS.Timeout;
  private learnIntervalId?: NodeJS.Timeout;
  private isRunning = false;

  constructor(
    config: Partial<MarketWatcherConfig> = {},
    claude?: ClaudeClient,
    narrator?: VoiceNarrator,
    db?: DatabaseWithRepositories
  ) {
    this.config = { ...DEFAULT_WATCHER_CONFIG, ...config };
    this.claude = claude;
    this.narrator = narrator;
    this.db = db;

    // Subscribe to agent events
    this.subscribeToEvents();

    logger.info({ config: this.config }, 'Market Watcher initialized');
  }

  /**
   * Start watching the market
   */
  start(): void {
    if (this.isRunning) {
      logger.warn('Market watcher already running');
      return;
    }

    this.isRunning = true;
    logger.info('Starting market watcher...');

    // Start observation interval
    this.observeIntervalId = setInterval(() => {
      this.performObservation().catch(err => {
        logger.error({ error: err }, 'Error in observation cycle');
      });
    }, this.config.observationInterval);

    // Start learning interval
    this.learnIntervalId = setInterval(() => {
      this.performLearning().catch(err => {
        logger.error({ error: err }, 'Error in learning cycle');
      });
    }, this.config.learningInterval);

    logger.info('Market watcher started');
  }

  /**
   * Stop watching
   */
  stop(): void {
    if (!this.isRunning) return;

    this.isRunning = false;

    if (this.observeIntervalId) {
      clearInterval(this.observeIntervalId);
      this.observeIntervalId = undefined;
    }

    if (this.learnIntervalId) {
      clearInterval(this.learnIntervalId);
      this.learnIntervalId = undefined;
    }

    logger.info('Market watcher stopped');
  }

  /**
   * Subscribe to agent events
   */
  private subscribeToEvents(): void {
    agentEvents.onAny((event) => {
      this.processEvent(event);
    });
  }

  /**
   * Process an incoming event
   */
  private processEvent(event: any): void {
    const mint = event.data?.mint;

    switch (event.type) {
      case 'ANALYSIS_START':
        this.trackToken(mint);
        break;

      case 'SAFETY_CHECK':
        this.recordSafetyResult(mint, event.data.result);
        break;

      case 'TRADE_EXECUTED':
        this.recordTrade(event.data);
        break;

      case 'STOP_LOSS':
        this.recordLoss(event.data);
        break;

      case 'TAKE_PROFIT':
        this.recordWin(event.data);
        break;
    }
  }

  /**
   * Track a new token
   */
  private trackToken(mint: string): void {
    if (!mint || this.observedTokens.has(mint)) return;

    this.observedTokens.set(mint, {
      mint,
      firstSeenAt: Date.now(),
      lastSeenAt: Date.now(),
      priceHistory: [],
      events: [],
    });

    logger.debug({ mint }, 'Now tracking token');
  }

  /**
   * Record safety analysis result
   */
  private recordSafetyResult(mint: string, result: any): void {
    const token = this.observedTokens.get(mint);
    if (!token) return;

    token.lastSeenAt = Date.now();
    token.events.push({
      type: 'NEW_TOKEN',
      data: { mint, safetyResult: result },
      timestamp: Date.now(),
    });

    // Record observation
    if (!result.isSafe) {
      this.addObservation({
        type: 'TOKEN_LIFECYCLE',
        description: `Token ${mint.slice(0, 8)} flagged unsafe: ${result.risks.join(', ')}`,
        token: mint,
        timestamp: Date.now(),
      });
    }
  }

  /**
   * Record a trade
   */
  private recordTrade(tradeData: any): void {
    const mint = tradeData.mint;
    const token = this.observedTokens.get(mint);

    if (token) {
      token.lastSeenAt = Date.now();
      token.events.push({
        type: 'TRADE_EXECUTED',
        data: tradeData,
        timestamp: Date.now(),
      });
    }

    this.addObservation({
      type: 'WALLET_BEHAVIOR',
      description: `Executed ${tradeData.type} of ${tradeData.amount} SOL on ${mint?.slice(0, 8) || 'token'}`,
      token: mint,
      timestamp: Date.now(),
      metadata: tradeData,
    });
  }

  /**
   * Record a loss (stop-loss triggered)
   */
  private recordLoss(data: any): void {
    const token = this.observedTokens.get(data.mint);

    if (token) {
      token.outcome = 'DUMP';
      token.events.push({
        type: 'PRICE_DUMP',
        data,
        timestamp: Date.now(),
      });
    }

    this.addObservation({
      type: 'TOKEN_LIFECYCLE',
      description: `Stop-loss on ${data.mint?.slice(0, 8)}: ${data.lossPercent?.toFixed(1)}% loss`,
      token: data.mint,
      timestamp: Date.now(),
      metadata: data,
    });
  }

  /**
   * Record a win (take-profit triggered)
   */
  private recordWin(data: any): void {
    const token = this.observedTokens.get(data.mint);

    if (token) {
      token.outcome = 'PUMP';
      token.events.push({
        type: 'PRICE_PUMP',
        data,
        timestamp: Date.now(),
      });
    }

    this.addObservation({
      type: 'TOKEN_LIFECYCLE',
      description: `Take-profit on ${data.mint?.slice(0, 8)}: +${data.profitPercent?.toFixed(1)}% gain`,
      token: data.mint,
      timestamp: Date.now(),
      metadata: data,
    });
  }

  /**
   * Add an observation
   */
  private addObservation(observation: MarketObservation): void {
    this.observations.push(observation);

    // Trim if over limit
    if (this.observations.length > this.config.maxObservations) {
      this.observations = this.observations.slice(-this.config.maxObservations);
    }

    logger.debug({ type: observation.type, description: observation.description.slice(0, 50) }, 'Observation added');
  }

  /**
   * Perform observation cycle
   */
  private async performObservation(): Promise<void> {
    logger.debug('Performing observation cycle...');

    // Commentary disabled to reduce Claude API usage
    // index.ts handles voice via event handlers instead
    logger.debug('Observation cycle complete (commentary disabled)');
  }

  /**
   * Perform learning cycle
   */
  private async performLearning(): Promise<void> {
    logger.debug('Performing learning cycle...');

    if (this.observations.length < this.config.minPatternsForLearning) {
      logger.debug({ count: this.observations.length, required: this.config.minPatternsForLearning }, 'Not enough observations for learning');
      return;
    }

    // Learning disabled to reduce Claude API usage
    logger.debug('Learning cycle skipped (Claude API disabled for routine learning)');
  }

  /**
   * Map observation type to market event type
   */
  private mapObservationToEventType(type: string): MarketEvent['type'] {
    switch (type) {
      case 'TOKEN_LIFECYCLE':
        return 'NEW_TOKEN';
      case 'WALLET_BEHAVIOR':
        return 'WHALE_ACTIVITY';
      case 'PRICE':
        return 'PRICE_PUMP';
      default:
        return 'NEW_TOKEN';
    }
  }

  /**
   * Get statistics
   */
  getStats(): {
    tokensTracked: number;
    observationCount: number;
    patternsLearned: number;
    wins: number;
    losses: number;
  } {
    let wins = 0;
    let losses = 0;

    for (const [, token] of this.observedTokens) {
      if (token.outcome === 'PUMP') wins++;
      if (token.outcome === 'DUMP' || token.outcome === 'RUG') losses++;
    }

    return {
      tokensTracked: this.observedTokens.size,
      observationCount: this.observations.length,
      patternsLearned: this.learnedPatterns.length,
      wins,
      losses,
    };
  }

  /**
   * Get recent observations
   */
  getRecentObservations(count: number = 10): MarketObservation[] {
    return this.observations.slice(-count);
  }

  /**
   * Get learned patterns
   */
  getLearnedPatterns(): LearnedPattern[] {
    return this.learnedPatterns;
  }

  /**
   * Generate a market summary
   */
  async generateMarketSummary(): Promise<string> {
    const stats = this.getStats();
    const recentObs = this.getRecentObservations(5);

    // Generate basic summary without Claude API
    const summary = `Market Summary:
- Tokens tracked: ${stats.tokensTracked}
- Observations: ${stats.observationCount}
- Patterns learned: ${stats.patternsLearned}
- Wins: ${stats.wins} | Losses: ${stats.losses}

Recent activity:
${recentObs.map(o => `• ${o.description}`).join('\n')}`;

    return summary;
  }
}
