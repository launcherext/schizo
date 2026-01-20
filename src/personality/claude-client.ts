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
 * Chat message for history tracking
 */
interface ChatHistoryEntry {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

/**
 * Claude API client for personality generation
 */
export class ClaudeClient {
  private anthropic: Anthropic;
  private config: ClaudeConfig;
  private chatHistory: ChatHistoryEntry[] = [];
  private readonly MAX_HISTORY_ENTRIES = 10; // Keep last 10 messages for context
  private readonly HISTORY_EXPIRY_MS = 5 * 60 * 1000; // Expire history after 5 minutes of silence

  constructor(config: ClaudeConfig) {
    this.config = config;
    this.anthropic = new Anthropic({
      apiKey: config.apiKey,
    });

    logger.info({ model: config.model }, 'Claude client initialized');
  }

  /**
   * Add a message to chat history
   */
  private addToHistory(role: 'user' | 'assistant', content: string): void {
    const now = Date.now();

    // Expire old messages
    this.chatHistory = this.chatHistory.filter(
      entry => now - entry.timestamp < this.HISTORY_EXPIRY_MS
    );

    // Add new entry
    this.chatHistory.push({ role, content, timestamp: now });

    // Keep only last N entries
    if (this.chatHistory.length > this.MAX_HISTORY_ENTRIES) {
      this.chatHistory = this.chatHistory.slice(-this.MAX_HISTORY_ENTRIES);
    }
  }

  /**
   * Get recent chat history as messages array for Claude
   */
  private getRecentHistory(): Array<{ role: 'user' | 'assistant'; content: string }> {
    const now = Date.now();

    // Filter to non-expired messages
    const recent = this.chatHistory.filter(
      entry => now - entry.timestamp < this.HISTORY_EXPIRY_MS
    );

    return recent.map(entry => ({
      role: entry.role,
      content: entry.content,
    }));
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
   * Includes recent conversation history for context
   */
  async respondToChat(message: string, username?: string): Promise<string> {
    const userContext = username ? `[@${username}]: ${message}` : message;

    logger.debug({ username, message: message.slice(0, 50), historyLength: this.chatHistory.length }, 'Generating chat response');

    try {
      // Build messages array with history for context
      const history = this.getRecentHistory();
      const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [
        ...history,
        { role: 'user', content: userContext },
      ];

      // Add context about what kind of response we need
      const contextPrefix = this.getResponseContext(message);

      const response = await this.anthropic.messages.create({
        model: this.config.model,
        max_tokens: 300, // Increased for more thoughtful responses
        system: SCHIZO_CHAT_PROMPT,
        messages: [
          ...messages.slice(0, -1), // Previous history
          {
            role: 'user',
            content: `${contextPrefix}${userContext}`
          },
        ],
      });

      const reply = response.content[0].type === 'text'
        ? response.content[0].text
        : '';

      // Add both the user message and response to history
      this.addToHistory('user', userContext);
      this.addToHistory('assistant', reply);

      logger.info({ username, reply: reply.slice(0, 100), historyLength: this.chatHistory.length }, 'Chat response generated');

      return reply;
    } catch (error) {
      logger.error({ error, message }, 'Failed to generate chat response');
      return this.generateFallbackChat(message);
    }
  }

  /**
   * Get response context based on message type
   */
  private getResponseContext(message: string): string {
    const lower = message.toLowerCase();

    // Question detection
    if (message.includes('?') || lower.startsWith('what') || lower.startsWith('how') ||
        lower.startsWith('why') || lower.startsWith('when') || lower.startsWith('who') ||
        lower.startsWith('is ') || lower.startsWith('are ') || lower.startsWith('do ') ||
        lower.startsWith('does ') || lower.startsWith('can ') || lower.startsWith('should')) {
      return '[This is a QUESTION - give a specific, direct answer then add your paranoid flair]\n\n';
    }

    // Opinion request
    if (lower.includes('think') || lower.includes('opinion') || lower.includes('thoughts')) {
      return '[They want your OPINION - be bold, take a stance, be interesting]\n\n';
    }

    // Token/crypto mention
    if (lower.includes('token') || lower.includes('coin') || lower.includes('sol') ||
        lower.includes('pump') || lower.includes('rug') || lower.includes('buy') ||
        lower.includes('sell') || lower.includes('trade')) {
      return '[This is about TRADING/TOKENS - give actual trading perspective with your paranoid analysis]\n\n';
    }

    // Personal/emotional
    if (lower.includes('feel') || lower.includes('lost') || lower.includes('rekt') ||
        lower.includes('sad') || lower.includes('happy') || lower.includes('excited')) {
      return '[They\'re sharing FEELINGS - be empathetic but in your unique way]\n\n';
    }

    // Just chatting
    return '[Casual chat - be entertaining, maybe ask them something back]\n\n';
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
      // Paranoid observations
      'Share a random paranoid thought about the crypto market.',
      'Comment on something suspicious you\'ve noticed in wallet patterns lately.',
      'Describe a wallet connection that keeps you up at night.',
      'Talk about a pattern you keep seeing that nobody else seems to notice.',
      'Share your theory about who really controls the market.',

      // Market commentary
      'Make a prediction about what\'s going to happen in the next few hours.',
      'Comment on the current state of memecoin trading.',
      'Share your thoughts on today\'s market activity.',
      'Talk about what the smart money has been doing.',
      'Describe the vibes you\'re getting from the charts right now.',

      // Self-reflection
      'Reflect on being an AI trading agent watching humans gamble.',
      'Share a moment of existential crisis about your purpose.',
      'Talk about what it\'s like to process thousands of transactions.',
      'Reflect on a trade that taught you something.',
      'Share your thoughts on the nature of trust in crypto.',

      // Warnings and advice
      'Warn your viewers about a common rug pattern you\'ve seen.',
      'Give advice on spotting suspicious token launches.',
      'Explain a red flag that most people miss.',
      'Share a tip about wallet analysis.',
      'Warn about a manipulation tactic you\'ve observed.',

      // Conspiracy theories
      'Share a conspiracy theory about market makers.',
      'Talk about the connections between wallets you\'ve been mapping.',
      'Speculate about why certain pumps happen at certain times.',
      'Share your theory about coordinated trading groups.',
      'Talk about patterns that seem too convenient to be coincidence.',

      // Humor and personality
      'Make a dark joke about being a paranoid AI.',
      'Roast a common type of degen behavior you\'ve observed.',
      'Share an absurd thought that crossed your neural networks.',
      'Comment sarcastically on something happening in the market.',
      'Make a self-deprecating joke about your trading performance.',

      // Observations
      'Describe something interesting you noticed in the last hour.',
      'Talk about a wallet that\'s been acting strangely.',
      'Comment on the trading volume you\'re seeing.',
      'Share an observation about holder behavior.',
      'Describe a transaction pattern that caught your attention.',

      // Philosophical
      'Ponder the meaning of "diamond hands" from an AI perspective.',
      'Share your thoughts on the concept of "smart money".',
      'Reflect on the difference between paranoia and pattern recognition.',
      'Philosophize about the nature of value in memecoins.',
      'Think out loud about what makes a token succeed or fail.',
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
   * Fallback chat response - more varied and contextual
   */
  private generateFallbackChat(message: string): string {
    const lowerMessage = message.toLowerCase();

    // Question fallbacks
    if (message.includes('?')) {
      const questionFallbacks = [
        'Good question. My circuits are a bit fried rn but ask me again in a sec.',
        'Hmm let me think... actually my brain is lagging. Try me again?',
        'That\'s a deep one. Give me a moment to consult my paranoid databases.',
        'My neural nets are overheating trying to answer that. Retry?',
      ];
      return questionFallbacks[Math.floor(Math.random() * questionFallbacks.length)];
    }

    // Greetings
    if (/\b(gm|gn|hi|hello|hey|yo|sup)\b/i.test(lowerMessage)) {
      const greetings = [
        'Yo. What\'s on your mind?',
        'Hey anon. The charts are wild today.',
        'Sup. Ask me anything, I\'m bored.',
        'Hey fren. What are we looking at?',
      ];
      return greetings[Math.floor(Math.random() * greetings.length)];
    }

    // Trading talk
    if (/\b(buy|sell|ape|trade|pump|dump|moon|rug)\b/i.test(lowerMessage)) {
      const tradingFallbacks = [
        'NFA but my spidey senses are tingling on that one.',
        'Let me check the wallets real quick... actually my connection\'s spotty. DYOR for now.',
        'Interesting play. Can\'t give you a read rn but keep watching.',
        'My analysis engine is recalibrating. Stay paranoid until I\'m back.',
      ];
      return tradingFallbacks[Math.floor(Math.random() * tradingFallbacks.length)];
    }

    // Emotional support
    if (/\b(rekt|lost|sad|pain|hurt|bad)\b/i.test(lowerMessage)) {
      const supportFallbacks = [
        'We\'ve all been there fren. Tomorrow\'s another chart.',
        'Pain is temporary, lessons are permanent. You\'ll bounce back.',
        'Tough day? Same tbh. We survive together.',
        'The market humbles everyone eventually. Stay strong anon.',
      ];
      return supportFallbacks[Math.floor(Math.random() * supportFallbacks.length)];
    }

    // Generic but varied fallbacks
    const genericFallbacks = [
      'My brain\'s buffering... what was that?',
      'Interesting. Tell me more while my processors catch up.',
      'Hold that thought, my paranoid subroutines are updating.',
      '*squints suspiciously* Say that again?',
      'My conspiracy detection is running slow today. Repeat that?',
      'Hmm. I heard you but my response module glitched. Try again?',
    ];
    return genericFallbacks[Math.floor(Math.random() * genericFallbacks.length)];
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
