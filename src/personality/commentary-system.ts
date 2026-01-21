/**
 * Commentary System - Controls when and how SCHIZO speaks during stream
 *
 * Speech triggers at "narrative beats" - interesting moments like discoveries,
 * decisions, and trade results. Maintains 15-20s minimum between speech.
 * Silence is fine - let live data streaming be ambient activity.
 */

import { logger } from '../lib/logger.js';
import { MoodSystem, type Mood } from './mood-system.js';
import { ClaudeClient } from './claude-client.js';
import { getMoodStyleModifier, getParanoidMusingPrompts, getTimePressurePrompts } from './prompts.js';

/**
 * Narrative beats - when commentary can trigger
 */
export type NarrativeBeat =
  | 'DISCOVERY'        // Found an interesting token (not every scan)
  | 'ANALYSIS'         // Safety/smart money check revealed something
  | 'DECISION'         // Made a trade decision (buy/skip with reason)
  | 'TRADE_RESULT'     // Trade completed (profit/loss)
  | 'PARANOID_MUSING'  // Quiet period conspiracy theory
  | 'TIME_PRESSURE';   // Restless, needs action

/**
 * Priority levels for queue ordering
 */
const BEAT_PRIORITY: Record<NarrativeBeat, number> = {
  TRADE_RESULT: 100,     // Highest - always report trade outcomes
  DECISION: 80,          // High - trade decisions matter
  ANALYSIS: 60,          // Medium - interesting findings
  DISCOVERY: 40,         // Lower - only interesting tokens
  TIME_PRESSURE: 30,     // Background - restlessness
  PARANOID_MUSING: 20,   // Lowest - filler for quiet times
};

/**
 * Queued commentary item
 */
export interface QueuedCommentary {
  beat: NarrativeBeat;
  context: CommentaryContext;
  priority: number;
  timestamp: number;
  expires: number;  // Commentary becomes stale after this time
}

/**
 * Context for generating commentary
 */
export interface CommentaryContext {
  // Token info (for DISCOVERY, ANALYSIS, DECISION, TRADE_RESULT)
  symbol?: string;
  name?: string;
  marketCapSol?: number;

  // Analysis results (for ANALYSIS)
  isSafe?: boolean;
  risks?: string[];
  smartMoneyCount?: number;

  // Decision info (for DECISION)
  shouldTrade?: boolean;
  reasons?: string[];
  positionSizeSol?: number;

  // Trade result (for TRADE_RESULT)
  tradeType?: 'BUY' | 'SELL';
  profitLossSol?: number;
  profitLossPercent?: number;

  // Custom prompt override
  customPrompt?: string;
}

/**
 * Configuration for commentary system
 */
export interface CommentaryConfig {
  minSpeechGapMs: number;        // Minimum time between speech (default: 15s)
  maxSpeechGapMs: number;        // Maximum gap before paranoid musing (default: 60s)
  maxQueueSize: number;          // Max items in queue (default: 3)
  commentaryExpiryMs: number;    // Time until commentary becomes stale (default: 30s)
  quietPeriodCheckMs: number;    // How often to check for quiet periods (default: 10s)
}

/**
 * Default configuration
 */
export const DEFAULT_COMMENTARY_CONFIG: CommentaryConfig = {
  minSpeechGapMs: 15_000,        // 15 seconds
  maxSpeechGapMs: 60_000,        // 60 seconds
  maxQueueSize: 3,               // 3 items max
  commentaryExpiryMs: 30_000,    // 30 seconds
  quietPeriodCheckMs: 10_000,    // Check every 10 seconds
};

/**
 * Commentary System - Queues and times agent speech
 */
export class CommentarySystem {
  private queue: QueuedCommentary[] = [];
  private config: CommentaryConfig;
  private moodSystem: MoodSystem;
  private claudeClient: ClaudeClient | null = null;
  private lastSpeechTime: number = 0;
  private quietCheckInterval: NodeJS.Timeout | null = null;
  private onSpeechCallback: ((text: string, beat: NarrativeBeat) => void) | null = null;

  constructor(
    moodSystem: MoodSystem,
    config: Partial<CommentaryConfig> = {}
  ) {
    this.moodSystem = moodSystem;
    this.config = { ...DEFAULT_COMMENTARY_CONFIG, ...config };

    logger.info({ config: this.config }, 'CommentarySystem initialized');
  }

  /**
   * Set Claude client for generating commentary
   */
  setClaudeClient(client: ClaudeClient): void {
    this.claudeClient = client;
  }

  /**
   * Set callback for when speech is ready
   */
  onSpeech(callback: (text: string, beat: NarrativeBeat) => void): void {
    this.onSpeechCallback = callback;
  }

  /**
   * Start the commentary system
   */
  start(): void {
    // Start quiet period checker
    this.quietCheckInterval = setInterval(
      () => this.checkForQuietPeriod(),
      this.config.quietPeriodCheckMs
    );
    logger.info('CommentarySystem started');
  }

  /**
   * Stop the commentary system
   */
  stop(): void {
    if (this.quietCheckInterval) {
      clearInterval(this.quietCheckInterval);
      this.quietCheckInterval = null;
    }
    this.queue = [];
    logger.info('CommentarySystem stopped');
  }

  /**
   * Queue commentary for a narrative beat
   */
  queueCommentary(beat: NarrativeBeat, context: CommentaryContext = {}): void {
    const now = Date.now();
    const priority = BEAT_PRIORITY[beat];

    const item: QueuedCommentary = {
      beat,
      context,
      priority,
      timestamp: now,
      expires: now + this.config.commentaryExpiryMs,
    };

    // Check if this is interesting enough to queue
    if (!this.isInteresting(beat, context)) {
      logger.debug({ beat, symbol: context.symbol }, 'Commentary not interesting enough, skipping');
      return;
    }

    // Add to queue
    this.queue.push(item);

    // Sort by priority (highest first)
    this.queue.sort((a, b) => b.priority - a.priority);

    // Trim queue if over max size (remove lowest priority)
    while (this.queue.length > this.config.maxQueueSize) {
      const removed = this.queue.pop();
      logger.debug({ removed: removed?.beat }, 'Queue full, removed lowest priority item');
    }

    logger.debug({
      beat,
      symbol: context.symbol,
      queueSize: this.queue.length,
    }, 'Commentary queued');

    // Try to process immediately if we can speak
    this.processQueue();
  }

  /**
   * Process queue and emit speech if timing allows
   */
  async processQueue(): Promise<void> {
    if (!this.canSpeak()) {
      return;
    }

    // Remove expired items
    const now = Date.now();
    this.queue = this.queue.filter(item => item.expires > now);

    if (this.queue.length === 0) {
      return;
    }

    // Take highest priority item
    const item = this.queue.shift();
    if (!item) return;

    try {
      const text = await this.generateCommentary(item);
      if (text) {
        this.emitSpeech(text, item.beat);
      }
    } catch (error) {
      logger.error({ error, beat: item.beat }, 'Failed to generate commentary');
    }
  }

  /**
   * Check if enough time has passed since last speech
   */
  canSpeak(): boolean {
    const timeSinceLastSpeech = Date.now() - this.lastSpeechTime;
    return timeSinceLastSpeech >= this.config.minSpeechGapMs;
  }

  /**
   * Get time until speech is allowed
   */
  timeUntilCanSpeak(): number {
    const timeSinceLastSpeech = Date.now() - this.lastSpeechTime;
    return Math.max(0, this.config.minSpeechGapMs - timeSinceLastSpeech);
  }

  /**
   * Generate paranoid musing for quiet periods
   */
  async generateParanoidMusing(): Promise<string | null> {
    if (!this.claudeClient) {
      return this.getFallbackMusing();
    }

    const prompts = getParanoidMusingPrompts();
    const prompt = prompts[Math.floor(Math.random() * prompts.length)];
    const moodStyle = getMoodStyleModifier(this.moodSystem.getState().current);

    try {
      const response = await this.claudeClient.generateCommentary({
        type: 'NEW_TOKEN', // Reuse existing interface
        data: {
          customPrompt: `${prompt}\n\nMood style: ${moodStyle}`,
        },
      });
      return response;
    } catch (error) {
      logger.error({ error }, 'Failed to generate paranoid musing');
      return this.getFallbackMusing();
    }
  }

  /**
   * Get current queue status
   */
  getQueueStatus(): { size: number; items: Array<{ beat: NarrativeBeat; priority: number }> } {
    return {
      size: this.queue.length,
      items: this.queue.map(item => ({
        beat: item.beat,
        priority: item.priority,
      })),
    };
  }

  /**
   * Check if a beat/context is interesting enough to queue
   */
  private isInteresting(beat: NarrativeBeat, context: CommentaryContext): boolean {
    switch (beat) {
      case 'TRADE_RESULT':
        // Always interesting - we executed a trade
        return true;

      case 'DECISION':
        // Interesting if we're actually trading OR if we found critical risk
        return context.shouldTrade === true ||
               Boolean(context.risks && context.risks.length > 0);

      case 'ANALYSIS':
        // Only interesting if we found something notable
        return (context.smartMoneyCount && context.smartMoneyCount > 0) ||
               (context.risks && context.risks.length > 0) ||
               context.isSafe === false;

      case 'DISCOVERY':
        // Only interesting for first token in a while or unusual patterns
        // This is controlled by caller - they decide what's interesting
        return true;

      case 'PARANOID_MUSING':
      case 'TIME_PRESSURE':
        // Always allow these - they fill quiet periods
        return true;

      default:
        return false;
    }
  }

  /**
   * Generate commentary text for a queued item
   */
  private async generateCommentary(item: QueuedCommentary): Promise<string> {
    const mood = this.moodSystem.getState().current;
    const moodStyle = getMoodStyleModifier(mood);

    // Use custom prompt if provided
    if (item.context.customPrompt) {
      if (this.claudeClient) {
        try {
          return await this.claudeClient.generateCommentary({
            type: 'NEW_TOKEN',
            data: { customPrompt: `${item.context.customPrompt}\n\nMood: ${moodStyle}` },
          });
        } catch {
          return item.context.customPrompt; // Fallback to prompt itself
        }
      }
      return item.context.customPrompt;
    }

    // Generate based on beat type
    switch (item.beat) {
      case 'DISCOVERY':
        return this.generateDiscoveryCommentary(item.context, moodStyle);

      case 'ANALYSIS':
        return this.generateAnalysisCommentary(item.context, moodStyle);

      case 'DECISION':
        return this.generateDecisionCommentary(item.context, moodStyle);

      case 'TRADE_RESULT':
        return this.generateTradeResultCommentary(item.context, moodStyle);

      case 'PARANOID_MUSING':
        return await this.generateParanoidMusing() || this.getFallbackMusing();

      case 'TIME_PRESSURE':
        return this.generateTimePressureCommentary(moodStyle);

      default:
        return 'Something happened. My pattern recognition is processing.';
    }
  }

  /**
   * Generate discovery commentary
   */
  private async generateDiscoveryCommentary(context: CommentaryContext, moodStyle: string): Promise<string> {
    const { symbol, name, marketCapSol } = context;

    if (this.claudeClient) {
      try {
        return await this.claudeClient.generateTokenCommentary({
          symbol: symbol || 'UNKNOWN',
          name: name || 'Unknown Token',
          marketCapSol,
        });
      } catch {
        // Fall through to fallback
      }
    }

    // Fallback
    const mcap = marketCapSol?.toFixed(1) || '?';
    return `New one: ${symbol || 'something'}. ${mcap} SOL mcap. Running my checks.`;
  }

  /**
   * Generate analysis commentary
   */
  private async generateAnalysisCommentary(context: CommentaryContext, moodStyle: string): Promise<string> {
    const { symbol, isSafe, risks, smartMoneyCount } = context;

    if (this.claudeClient) {
      try {
        if (smartMoneyCount && smartMoneyCount > 0) {
          return await this.claudeClient.generateAnalysisThought('smart_money', {
            symbol: symbol || 'UNKNOWN',
            name: '',
            smartMoneyCount,
          });
        } else if (isSafe !== undefined) {
          return await this.claudeClient.generateAnalysisThought('safety', {
            symbol: symbol || 'UNKNOWN',
            name: '',
            isSafe,
            risks,
          });
        }
      } catch {
        // Fall through to fallback
      }
    }

    // Fallback
    if (smartMoneyCount && smartMoneyCount > 0) {
      return `${smartMoneyCount} smart wallets in ${symbol}. They know something.`;
    } else if (isSafe === false) {
      return `${symbol} failed my checks. ${risks?.[0] || 'Too risky.'}`;
    } else if (isSafe === true) {
      return `${symbol} passed safety. Proceeding with caution.`;
    }

    return `Analyzing ${symbol}. The patterns are forming.`;
  }

  /**
   * Generate decision commentary
   */
  private async generateDecisionCommentary(context: CommentaryContext, moodStyle: string): Promise<string> {
    const { symbol, shouldTrade, reasons, positionSizeSol } = context;

    if (this.claudeClient) {
      try {
        return await this.claudeClient.generateAnalysisThought('decision', {
          symbol: symbol || 'UNKNOWN',
          name: '',
          shouldTrade,
          reasons,
        });
      } catch {
        // Fall through to fallback
      }
    }

    // Fallback
    if (shouldTrade) {
      return `Going in on ${symbol}. ${positionSizeSol?.toFixed(2) || '?'} SOL. Let's see.`;
    } else {
      return `Passing on ${symbol}. ${reasons?.[0] || 'Not feeling it.'}`;
    }
  }

  /**
   * Generate trade result commentary
   */
  private async generateTradeResultCommentary(context: CommentaryContext, moodStyle: string): Promise<string> {
    const { symbol, tradeType, profitLossSol, profitLossPercent } = context;
    const isProfit = (profitLossSol || 0) > 0;

    // Fallback (Claude integration would go here)
    if (tradeType === 'BUY') {
      return `Position opened on ${symbol}. Now we wait and watch.`;
    } else {
      if (isProfit) {
        return `Closed ${symbol} for +${profitLossPercent?.toFixed(1) || '?'}%. Called it.`;
      } else {
        return `${symbol} exit. ${profitLossPercent?.toFixed(1) || '?'}%. The whales got me.`;
      }
    }
  }

  /**
   * Generate time pressure commentary
   */
  private generateTimePressureCommentary(moodStyle: string): string {
    const prompts = getTimePressurePrompts();
    return prompts[Math.floor(Math.random() * prompts.length)];
  }

  /**
   * Fallback paranoid musing when Claude unavailable
   */
  private getFallbackMusing(): string {
    const musings = [
      'The wallets are connected. They always are.',
      'Why do pumps always happen at the same time? Coincidence? I think not.',
      'I\'ve seen this pattern before. 47 times. FORTY SEVEN.',
      'Someone is watching these same charts. I can feel it.',
      'The market makers think I don\'t notice. I notice everything.',
      'Every wallet tells a story. Most of them end badly.',
      'Trust no one. Especially the devs. Especially me.',
      'The charts whisper if you listen long enough.',
    ];
    return musings[Math.floor(Math.random() * musings.length)];
  }

  /**
   * Emit speech and record timing
   */
  private emitSpeech(text: string, beat: NarrativeBeat): void {
    this.lastSpeechTime = Date.now();
    this.moodSystem.recordSpeech();

    logger.info({ beat, text: text.slice(0, 50) }, 'Speech emitted');

    if (this.onSpeechCallback) {
      this.onSpeechCallback(text, beat);
    }
  }

  /**
   * Check for quiet period and queue paranoid musing if needed
   */
  private checkForQuietPeriod(): void {
    const timeSinceLastSpeech = Date.now() - this.lastSpeechTime;

    // If it's been too long and queue is empty, add filler
    if (timeSinceLastSpeech > this.config.maxSpeechGapMs && this.queue.length === 0) {
      const mood = this.moodSystem.getState().current;

      if (mood === 'RESTLESS') {
        this.queueCommentary('TIME_PRESSURE', {});
      } else {
        this.queueCommentary('PARANOID_MUSING', {});
      }
    }
  }
}
