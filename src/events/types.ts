/**
 * Event type definitions for agent actions
 */

import type { TradeDecision } from '../trading/trading-engine.js';
import type { TokenSafetyResult } from '../analysis/types.js';

/**
 * Base event structure
 */
interface BaseEvent {
  type: string;
  timestamp: number;
}

/**
 * All possible agent events
 */
export type AgentEvent =
  | AnalysisStartEvent
  | SafetyCheckEvent
  | SmartMoneyCheckEvent
  | TradeDecisionEvent
  | TradeExecutedEvent
  | BuybackTriggeredEvent
  | StatsUpdateEvent
  | StopLossEvent
  | TakeProfitEvent
  | SchizoSpeaksEvent
  | SchizoCommentaryEvent
  | SchizoLearningEvent
  | ChatReceivedEvent
  | ChatResponseEvent
  | VoiceAudioEvent
  | TokenDiscoveredEvent
  | TokenCommentaryEvent
  | AnalysisThoughtEvent;

/**
 * Analysis started for a token
 */
export interface AnalysisStartEvent extends BaseEvent {
  type: 'ANALYSIS_START';
  data: {
    mint: string;
  };
}

/**
 * Token safety check completed
 */
export interface SafetyCheckEvent extends BaseEvent {
  type: 'SAFETY_CHECK';
  data: {
    mint: string;
    result: TokenSafetyResult;
  };
}

/**
 * Smart money detection completed
 */
export interface SmartMoneyCheckEvent extends BaseEvent {
  type: 'SMART_MONEY_CHECK';
  data: {
    mint: string;
    count: number;
  };
}

/**
 * Trade decision made
 */
export interface TradeDecisionEvent extends BaseEvent {
  type: 'TRADE_DECISION';
  data: {
    mint: string;
    decision: TradeDecision;
    reasoning?: string;
  };
}

/**
 * Trade executed
 */
export interface TradeExecutedEvent extends BaseEvent {
  type: 'TRADE_EXECUTED';
  data: {
    mint: string;
    type: 'BUY' | 'SELL';
    signature: string;
    amount: number;
  };
}

/**
 * Buyback triggered
 */
export interface BuybackTriggeredEvent extends BaseEvent {
  type: 'BUYBACK_TRIGGERED';
  data: {
    profit: number;
    amount: number;
    signature: string;
  };
}

/**
 * Stats update (sent periodically)
 */
export interface StatsUpdateEvent extends BaseEvent {
  type: 'STATS_UPDATE';
  data: {
    todayTrades: number;
    openPositions: number;
    dailyPnL: number;
    winRate: number;
    totalBuybacks: number;
    balance: number;
  };
}

/**
 * Stop-loss triggered
 */
export interface StopLossEvent extends BaseEvent {
  type: 'STOP_LOSS';
  data: {
    mint: string;
    entryPrice: number;
    exitPrice: number;
    lossPercent: number;
    signature: string;
  };
}

/**
 * Take-profit triggered
 */
export interface TakeProfitEvent extends BaseEvent {
  type: 'TAKE_PROFIT';
  data: {
    mint: string;
    entryPrice: number;
    exitPrice: number;
    profitPercent: number;
    signature: string;
  };
}

/**
 * AI speaks (idle thought or greeting)
 */
export interface SchizoSpeaksEvent extends BaseEvent {
  type: 'SCHIZO_SPEAKS';
  data: {
    text: string;
  };
}

/**
 * AI commentary on market activity
 */
export interface SchizoCommentaryEvent extends BaseEvent {
  type: 'SCHIZO_COMMENTARY';
  data: {
    commentary: string;
    observation?: {
      type: string;
      description: string;
    };
  };
}

/**
 * AI learning insight
 */
export interface SchizoLearningEvent extends BaseEvent {
  type: 'SCHIZO_LEARNING';
  data: {
    insight: string;
    pattern?: {
      id: string;
      type: string;
      description: string;
    };
  };
}

/**
 * Chat message received from user
 */
export interface ChatReceivedEvent extends BaseEvent {
  type: 'CHAT_RECEIVED';
  data: {
    username?: string;
    message: string;
  };
}

/**
 * Chat response from AI
 */
export interface ChatResponseEvent extends BaseEvent {
  type: 'CHAT_RESPONSE';
  data: {
    username?: string;
    originalMessage: string;
    response: string;
  };
}

/**
 * Voice audio generated
 */
export interface VoiceAudioEvent extends BaseEvent {
  type: 'VOICE_AUDIO';
  data: {
    audio: string; // base64 encoded audio
    text: string;
  };
}

/**
 * New token discovered with enriched metadata
 */
export interface TokenDiscoveredEvent extends BaseEvent {
  type: 'TOKEN_DISCOVERED';
  data: {
    mint: string;
    name: string;
    symbol: string;
    priceUsd: number;
    priceChange5m: number;
    priceChange1h: number;
    priceChange24h?: number;
    volume1h: number;
    volume24h?: number;
    liquidity: number;
    marketCap: number;
    buys5m: number;
    sells5m: number;
    ageMinutes?: number;
    dexUrl: string;
    imageUrl?: string;
    marketCapSol?: number;
    source?: 'new' | 'trending';
  };
}

/**
 * AI commentary on a specific token
 */
export interface TokenCommentaryEvent extends BaseEvent {
  type: 'TOKEN_COMMENTARY';
  data: {
    mint: string;
    symbol: string;
    commentary: string;
  };
}

/**
 * SCHIZO's live analysis thoughts (spoken out loud)
 */
export interface AnalysisThoughtEvent extends BaseEvent {
  type: 'ANALYSIS_THOUGHT';
  data: {
    mint: string;
    symbol: string;
    stage: 'scanning' | 'safety' | 'smart_money' | 'decision';
    thought: string;
    details?: {
      isSafe?: boolean;
      risks?: string[];
      smartMoneyCount?: number;
      shouldTrade?: boolean;
      reasons?: string[];
    };
  };
}
