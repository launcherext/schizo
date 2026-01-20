/**
 * Claude API client for generating $SCHIZO personality responses
 */

import Anthropic from '@anthropic-ai/sdk';
import { logger } from '../lib/logger.js';
import {
  SCHIZO_SYSTEM_PROMPT,
  SCHIZO_CHAT_PROMPT,
  SCHIZO_COMMENTARY_PROMPT,
  SCHIZO_LEARNING_PROMPT,
  formatAnalysisContext,
  formatBuybackContext
} from './prompts.js';
import type { AnalysisContext } from './prompts.js';

/**
 * Claude client configuration
 */
export interface ClaudeConfig {
  apiKey: string;
  model: string;
  maxTokens: number;
}

/**
 * Default Claude configuration
 */
export const DEFAULT_CLAUDE_CONFIG: Omit<ClaudeConfig, 'apiKey'> = {
  model: 'claude-sonnet-4-20250514',
  maxTokens: 200, // Keep responses brief
};

/**
 * Claude API client for personality generation
 */
export class ClaudeClient {
  private anthropic: Anthropic;
  private config: ClaudeConfig;

  constructor(config: ClaudeConfig) {
    this.config = config;
    this.anthropic = new Anthropic({
      apiKey: config.apiKey,
    });

    logger.info({ model: config.model }, 'Claude client initialized');
  }

  /**
   * Generate reasoning for a trade decision
   */
  async generateTradeReasoning(context: AnalysisContext): Promise<string> {
    const userMessage = formatAnalysisContext(context);

    logger.debug({ 
      tokenMint: context.tokenMint,
      shouldTrade: context.decision.shouldTrade,
    }, 'Generating trade reasoning');

    try {
      const response = await this.anthropic.messages.create({
        model: this.config.model,
        max_tokens: this.config.maxTokens,
        system: SCHIZO_SYSTEM_PROMPT,
        messages: [{
          role: 'user',
          content: userMessage,
        }],
      });

      const reasoning = response.content[0].type === 'text' 
        ? response.content[0].text 
        : '';

      logger.info({
        tokenMint: context.tokenMint,
        reasoning: reasoning.slice(0, 100),
      }, 'Trade reasoning generated');

      return reasoning;
    } catch (error) {
      logger.error({ error, tokenMint: context.tokenMint }, 'Failed to generate reasoning');
      
      // Fallback to basic reasoning if Claude fails
      return this.generateFallbackReasoning(context);
    }
  }

  /**
   * Generate reasoning for a buyback
   */
  async generateBuybackReasoning(profitSol: number, buybackAmount: number): Promise<string> {
    const userMessage = formatBuybackContext(profitSol, buybackAmount);

    logger.debug({ profitSol, buybackAmount }, 'Generating buyback reasoning');

    try {
      const response = await this.anthropic.messages.create({
        model: this.config.model,
        max_tokens: this.config.maxTokens,
        system: SCHIZO_SYSTEM_PROMPT,
        messages: [{
          role: 'user',
          content: userMessage,
        }],
      });

      const reasoning = response.content[0].type === 'text'
        ? response.content[0].text
        : '';

      logger.info({ reasoning: reasoning.slice(0, 100) }, 'Buyback reasoning generated');

      return reasoning;
    } catch (error) {
      logger.error({ error }, 'Failed to generate buyback reasoning');
      
      // Fallback
      return `Buying back ${buybackAmount.toFixed(2)} SOL worth of $SCHIZO. The flywheel continues...`;
    }
  }

  /**
   * Generate fallback reasoning if Claude API fails
   */
  private generateFallbackReasoning(context: AnalysisContext): string {
    if (!context.decision.shouldTrade) {
      if (context.safetyAnalysis.risks.length > 0) {
        return `Too many red flags: ${context.safetyAnalysis.risks.join(', ')}. Passing on this one.`;
      }
      return `Analysis says skip. Not feeling this one.`;
    }

    if (context.smartMoneyCount > 0) {
      return `${context.smartMoneyCount} smart money wallets detected. Following the alpha.`;
    }

    return `Looks clean enough. Trading ${context.decision.positionSizeSol} SOL.`;
  }

  /**
   * Respond to a chat message from a viewer
   */
  async respondToChat(message: string, username?: string): Promise<string> {
    const userContext = username ? `[Chat from @${username}]: ${message}` : `[Chat]: ${message}`;

    logger.debug({ username, message: message.slice(0, 50) }, 'Generating chat response');

    try {
      const response = await this.anthropic.messages.create({
        model: this.config.model,
        max_tokens: this.config.maxTokens,
        system: SCHIZO_CHAT_PROMPT,
        messages: [{
          role: 'user',
          content: userContext,
        }],
      });

      const reply = response.content[0].type === 'text'
        ? response.content[0].text
        : '';

      logger.info({ username, reply: reply.slice(0, 100) }, 'Chat response generated');

      return reply;
    } catch (error) {
      logger.error({ error, message }, 'Failed to generate chat response');
      return this.generateFallbackChat(message);
    }
  }

  /**
   * Generate live market commentary
   */
  async generateCommentary(marketEvent: MarketEvent): Promise<string> {
    const eventContext = this.formatMarketEvent(marketEvent);

    logger.debug({ eventType: marketEvent.type }, 'Generating market commentary');

    try {
      const response = await this.anthropic.messages.create({
        model: this.config.model,
        max_tokens: this.config.maxTokens,
        system: SCHIZO_COMMENTARY_PROMPT,
        messages: [{
          role: 'user',
          content: eventContext,
        }],
      });

      const commentary = response.content[0].type === 'text'
        ? response.content[0].text
        : '';

      logger.info({ eventType: marketEvent.type, commentary: commentary.slice(0, 100) }, 'Commentary generated');

      return commentary;
    } catch (error) {
      logger.error({ error }, 'Failed to generate commentary');
      return this.generateFallbackCommentary(marketEvent);
    }
  }

  /**
   * Generate learning observations from market data
   */
  async generateLearningObservation(observations: MarketObservation[]): Promise<string> {
    const context = this.formatObservations(observations);

    logger.debug({ observationCount: observations.length }, 'Generating learning observation');

    try {
      const response = await this.anthropic.messages.create({
        model: this.config.model,
        max_tokens: 400, // Allow longer reflection
        system: SCHIZO_LEARNING_PROMPT,
        messages: [{
          role: 'user',
          content: context,
        }],
      });

      const insight = response.content[0].type === 'text'
        ? response.content[0].text
        : '';

      logger.info({ insight: insight.slice(0, 100) }, 'Learning observation generated');

      return insight;
    } catch (error) {
      logger.error({ error }, 'Failed to generate learning observation');
      return 'The patterns are there... I just need more data to connect them.';
    }
  }

  /**
   * Generate quick commentary on a new token (for stream)
   */
  async generateTokenCommentary(token: {
    symbol: string;
    name: string;
    marketCapSol?: number;
    liquidity?: number;
    priceChange5m?: number;
  }): Promise<string> {
    const context = `New token just dropped on pump.fun:
- Symbol: ${token.symbol}
- Name: ${token.name}
- Market Cap: ${token.marketCapSol?.toFixed(2) || '?'} SOL
- Liquidity: ${token.liquidity ? '$' + token.liquidity.toLocaleString() : '?'}
- 5m Change: ${token.priceChange5m?.toFixed(1) || '?'}%

Give a quick, brutally honest 1-2 sentence reaction. Be cynical, funny, or intrigued depending on what you see. Examples of tone:
- "ehh looks like garbage, hard pass"
- "interesting name... but those numbers look sus"
- "oh this could actually run, watching closely"
- "another dog coin? really? we're still doing this?"`;

    try {
      const response = await this.anthropic.messages.create({
        model: this.config.model,
        max_tokens: 80,
        system: SCHIZO_SYSTEM_PROMPT,
        messages: [{
          role: 'user',
          content: context,
        }],
      });

      return response.content[0].type === 'text'
        ? response.content[0].text
        : 'Hmm... let me think about this one.';
    } catch (error) {
      logger.error({ error, symbol: token.symbol }, 'Failed to generate token commentary');
      return this.generateFallbackTokenCommentary(token);
    }
  }

  /**
   * Fallback token commentary
   */
  private generateFallbackTokenCommentary(token: { symbol: string; name: string }): string {
    const fallbacks = [
      `${token.symbol}... another one for the watchlist.`,
      `Hmm, ${token.name}. The name's either genius or desperate.`,
      `New token alert. Let me check if this is a honeypot...`,
      `${token.symbol}? My neural networks are... uncertain.`,
    ];
    return fallbacks[Math.floor(Math.random() * fallbacks.length)];
  }

  /**
   * Generate a random idle thought/commentary
   */
  async generateIdleThought(): Promise<string> {
    const prompts = [
      'Share a random paranoid thought about the crypto market.',
      'Comment on something suspicious you\'ve noticed lately.',
      'Make a prediction about what\'s going to happen next.',
      'Reflect on being an AI trading agent.',
      'Warn your viewers about a common rug pattern.',
    ];

    const prompt = prompts[Math.floor(Math.random() * prompts.length)];

    try {
      const response = await this.anthropic.messages.create({
        model: this.config.model,
        max_tokens: this.config.maxTokens,
        system: SCHIZO_SYSTEM_PROMPT,
        messages: [{
          role: 'user',
          content: prompt,
        }],
      });

      return response.content[0].type === 'text'
        ? response.content[0].text
        : 'The charts are speaking to me again...';
    } catch (error) {
      logger.error({ error }, 'Failed to generate idle thought');
      return 'Trust no one. Especially the devs.';
    }
  }

  /**
   * Format market event for commentary
   */
  private formatMarketEvent(event: MarketEvent): string {
    switch (event.type) {
      case 'NEW_TOKEN':
        return `NEW TOKEN LAUNCHED: ${event.data.name || event.data.mint?.slice(0, 8)}
- Mint: ${event.data.mint}
- Initial liquidity: ${event.data.liquidity || 'Unknown'} SOL
React to this new token launch.`;

      case 'PRICE_PUMP':
        return `PRICE PUMP DETECTED: ${event.data.symbol || event.data.mint?.slice(0, 8)}
- Change: +${event.data.changePercent}%
- Volume: ${event.data.volume} SOL
React to this pump.`;

      case 'PRICE_DUMP':
        return `PRICE DUMP DETECTED: ${event.data.symbol || event.data.mint?.slice(0, 8)}
- Change: ${event.data.changePercent}%
- Volume: ${event.data.volume} SOL
React to this dump.`;

      case 'WHALE_ACTIVITY':
        return `WHALE ACTIVITY: ${event.data.wallet?.slice(0, 8)}...
- Action: ${event.data.action}
- Amount: ${event.data.amount} SOL
- Token: ${event.data.token}
React to this whale movement.`;

      case 'RUG_DETECTED':
        return `RUG PULL DETECTED: ${event.data.symbol || event.data.mint?.slice(0, 8)}
- Liquidity removed: ${event.data.liquidityRemoved} SOL
- Time since launch: ${event.data.timeSinceLaunch}
React to this rug pull.`;

      default:
        return `MARKET EVENT: ${JSON.stringify(event.data)}
React to this.`;
    }
  }

  /**
   * Format observations for learning
   */
  private formatObservations(observations: MarketObservation[]): string {
    const formatted = observations.map((obs, i) => {
      return `${i + 1}. [${obs.type}] ${obs.description}
   - Token: ${obs.token || 'N/A'}
   - Wallet: ${obs.wallet?.slice(0, 8) || 'N/A'}
   - Timestamp: ${new Date(obs.timestamp).toISOString()}`;
    }).join('\n\n');

    return `Here are the recent market observations to analyze:

${formatted}

What patterns do you see? What have you learned? Share your paranoid insights.`;
  }

  /**
   * Fallback chat response
   */
  private generateFallbackChat(message: string): string {
    const lowerMessage = message.toLowerCase();

    if (lowerMessage.includes('gm')) {
      return 'gm degen. The markets never sleep and neither do I. What are we watching today?';
    }
    if (lowerMessage.includes('buy') || lowerMessage.includes('ape')) {
      return 'DYOR fren. I trust no one and neither should you. But if smart money is there... maybe.';
    }
    if (lowerMessage.includes('rug')) {
      return 'They\'re all potential rugs until proven otherwise. That\'s not paranoia, that\'s pattern recognition.';
    }

    return 'The wallets are talking to me again... What were you saying?';
  }

  /**
   * Fallback commentary
   */
  private generateFallbackCommentary(event: MarketEvent): string {
    switch (event.type) {
      case 'NEW_TOKEN':
        return 'New token alert. Let me check the authorities... You know I have to.';
      case 'PRICE_PUMP':
        return 'Pump detected. Is it organic or coordinated? Let me trace those wallets...';
      case 'PRICE_DUMP':
        return 'And there goes the exit liquidity. Called it.';
      case 'WHALE_ACTIVITY':
        return 'Whale alert. They always know something we don\'t.';
      case 'RUG_DETECTED':
        return 'Another one. They thought I wouldn\'t notice. I always notice.';
      default:
        return 'Something\'s happening. My neural networks are processing...';
    }
  }
}

/**
 * Market event for commentary
 */
export interface MarketEvent {
  type: 'NEW_TOKEN' | 'PRICE_PUMP' | 'PRICE_DUMP' | 'WHALE_ACTIVITY' | 'RUG_DETECTED' | 'TRADE_EXECUTED';
  data: Record<string, any>;
  timestamp?: number;
}

/**
 * Market observation for learning
 */
export interface MarketObservation {
  type: 'PATTERN' | 'WALLET_BEHAVIOR' | 'TOKEN_LIFECYCLE' | 'TIMING' | 'CONNECTION';
  description: string;
  token?: string;
  wallet?: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}
