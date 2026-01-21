/**
 * Claude API client for generating $SCHIZO personality responses
 *
 * Supports multiple AI providers: Claude (default), Groq (free), Gemini (free)
 * Set AI_PROVIDER=groq and GROQ_API_KEY in .env to use free alternatives
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
import type { SillyCategory } from './name-analyzer.js';
import { AIProviderClient, createAIProvider, type AIProvider } from './ai-provider.js';

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
 * Trading activity context for chat responses
 */
interface TradingActivity {
  tokensAnalyzed: Array<{symbol: string; verdict: string; reason?: string}>;
  lastTrade?: {symbol: string; type: 'BUY' | 'SELL'; time: number};
  openPositions: number;
  currentlyAnalyzing?: string;
}

/**
 * Claude API client for personality generation
 * Now supports multiple AI providers: Claude, Groq (free), Gemini (free)
 */
export class ClaudeClient {
  private anthropic: Anthropic;
  private config: ClaudeConfig;
  private chatHistory: ChatHistoryEntry[] = [];
  private readonly MAX_HISTORY_ENTRIES = 10; // Keep last 10 messages for context
  private readonly HISTORY_EXPIRY_MS = 5 * 60 * 1000; // Expire history after 5 minutes of silence

  // Track recent trading activity for chat context
  private recentActivity: TradingActivity = { tokensAnalyzed: [], openPositions: 0 };

  // Multi-provider support
  private aiProvider: AIProviderClient | null = null;
  private useAlternativeProvider: boolean = false;

  constructor(config: ClaudeConfig) {
    this.config = config;

    // Check if we should use an alternative provider (Groq/Gemini)
    const altProvider = process.env.AI_PROVIDER?.toLowerCase();
    if (altProvider && altProvider !== 'claude') {
      this.aiProvider = createAIProvider();
      if (this.aiProvider) {
        this.useAlternativeProvider = true;
        logger.info({
          provider: altProvider,
        }, 'Using alternative AI provider (free tier)');
      }
    }

    // Initialize Anthropic as fallback or primary
    this.anthropic = new Anthropic({
      apiKey: config.apiKey,
    });

    logger.info({
      model: config.model,
      alternativeProvider: this.useAlternativeProvider ? altProvider : null
    }, 'Claude client initialized');
  }

  /**
   * Internal method to call AI - uses alternative provider if configured
   */
  private async callAI(systemPrompt: string, userMessage: string, maxTokens?: number): Promise<string> {
    // Use alternative provider if available
    if (this.useAlternativeProvider && this.aiProvider) {
      try {
        return await this.aiProvider.complete(systemPrompt, userMessage);
      } catch (error) {
        logger.warn({ error }, 'Alternative provider failed, falling back to Claude');
        // Fall through to Claude
      }
    }

    // Use Claude (Anthropic SDK)
    const response = await this.anthropic.messages.create({
      model: this.config.model,
      max_tokens: maxTokens || this.config.maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    });

    return response.content[0].type === 'text' ? response.content[0].text : '';
  }

  /**
   * Internal method to call AI with message history
   */
  private async callAIWithHistory(
    systemPrompt: string,
    messages: Array<{ role: 'user' | 'assistant'; content: string }>,
    maxTokens?: number
  ): Promise<string> {
    // Use alternative provider if available
    if (this.useAlternativeProvider && this.aiProvider) {
      try {
        return await this.aiProvider.completeWithHistory(systemPrompt, messages);
      } catch (error) {
        logger.warn({ error }, 'Alternative provider failed, falling back to Claude');
        // Fall through to Claude
      }
    }

    // Use Claude (Anthropic SDK)
    const response = await this.anthropic.messages.create({
      model: this.config.model,
      max_tokens: maxTokens || this.config.maxTokens,
      system: systemPrompt,
      messages,
    });

    return response.content[0].type === 'text' ? response.content[0].text : '';
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
   * Update trading context (called from index.ts when events happen)
   */
  updateTradingContext(activity: Partial<TradingActivity>): void {
    Object.assign(this.recentActivity, activity);
    // Keep only last 5 analyzed tokens
    if (this.recentActivity.tokensAnalyzed.length > 5) {
      this.recentActivity.tokensAnalyzed = this.recentActivity.tokensAnalyzed.slice(-5);
    }
  }

  /**
   * Format trading context for injection into chat
   */
  private formatTradingContext(): string {
    const parts: string[] = [];

    if (this.recentActivity.currentlyAnalyzing) {
      parts.push(`Currently analyzing: ${this.recentActivity.currentlyAnalyzing}`);
    }

    if (this.recentActivity.tokensAnalyzed.length > 0) {
      const recent = this.recentActivity.tokensAnalyzed.slice(-3)
        .map(t => `${t.symbol} (${t.verdict})`).join(', ');
      parts.push(`Recently analyzed: ${recent}`);
    }

    if (this.recentActivity.lastTrade) {
      const t = this.recentActivity.lastTrade;
      const ago = Math.round((Date.now() - t.time) / 60000);
      parts.push(`Last trade: ${t.type} ${t.symbol} (${ago}m ago)`);
    }

    if (this.recentActivity.openPositions > 0) {
      parts.push(`Open positions: ${this.recentActivity.openPositions}`);
    }

    return parts.length > 0 ? `[YOUR CURRENT ACTIVITY: ${parts.join('. ')}]` : '';
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
      const reasoning = await this.callAI(SCHIZO_SYSTEM_PROMPT, userMessage);

      logger.info({
        tokenMint: context.tokenMint,
        reasoning: reasoning.slice(0, 100),
      }, 'Trade reasoning generated');

      return reasoning;
    } catch (error) {
      logger.error({ error, tokenMint: context.tokenMint }, 'Failed to generate reasoning');

      // Fallback to basic reasoning if AI fails
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
      const reasoning = await this.callAI(SCHIZO_SYSTEM_PROMPT, userMessage);

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

      // Add trading context and response type context
      const tradingContext = this.formatTradingContext();
      const contextPrefix = this.getResponseContext(message);

      // Combine trading context with user message
      const enhancedMessage = tradingContext
        ? `${tradingContext}\n\n${contextPrefix}${userContext}`
        : `${contextPrefix}${userContext}`;

      // Build full message history
      const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [
        ...history,
        { role: 'user', content: enhancedMessage },
      ];

      const reply = await this.callAIWithHistory(SCHIZO_CHAT_PROMPT, messages, 300);

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
      const commentary = await this.callAI(SCHIZO_COMMENTARY_PROMPT, eventContext);

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
      const insight = await this.callAI(SCHIZO_LEARNING_PROMPT, context);

      logger.info({ insight: insight.slice(0, 100) }, 'Learning observation generated');

      return insight;
    } catch (error) {
      logger.error({ error }, 'Failed to generate learning observation');
      return 'The patterns are there... I just need more data to connect them.';
    }
  }

  /**
   * Generate quick commentary on a new token (for stream)
   * Uses varied prompts and real data to avoid repetition
   * OPTIMIZED: No Claude API - uses fallback messages only
   */
  async generateTokenCommentary(token: {
    symbol: string;
    name: string;
    marketCapSol?: number;
    liquidity?: number;
    priceChange5m?: number;
  }): Promise<string> {
    // Always use fallback - no Claude API
    return this.generateFallbackTokenCommentary(token);
  }

  /**
   * Generate a roast for tokens with silly/meme names
   */
  async generateSillyNameRoast(
    token: { symbol: string; name: string; marketCapSol?: number },
    category: SillyCategory
  ): Promise<string> {
    const prompts: Record<SillyCategory, string> = {
      food: `Food token "${token.symbol}" (${token.name}) just dropped. Roast it - who's funding these, DoorDash? One SHORT sentence, max 15 words.`,
      animal: `Another animal token: ${token.symbol} (${token.name}). DOGE already happened. Mock this copycat in one SHORT sentence, max 15 words.`,
      copycat: `${token.symbol} - they literally just added INU/PEPE/DOGE to something. Roast the lack of creativity. One SHORT sentence, max 15 words.`,
      pump: `They named it "${token.symbol}". Very subtle pump signal there. Mock them in one SHORT sentence, max 15 words.`,
      celebrity: `${token.symbol} token (${token.name})? Celebrity grift detected. One sarcastic sentence, max 15 words.`,
      random: `${token.symbol} - just random letters. They didn't even try with the name. Quick roast, one sentence, max 15 words.`,
      crude: `${token.symbol} (${token.name}) - I see what they did there. Keep it PG but acknowledge it's dumb. One sentence, max 15 words.`,
    };

    const context = `You're a paranoid AI trading agent live-streaming. A new token appeared with a silly name:
- Symbol: ${token.symbol}
- Name: ${token.name}
- Market Cap: ${token.marketCapSol?.toFixed(2) || '?'} SOL

${prompts[category]}

RULES:
- ONE sentence, max 15 words
- Be funny/sarcastic about the NAME specifically
- Stay in paranoid trader character
- No generic responses`;

    try {
      const roast = await this.callAI(SCHIZO_SYSTEM_PROMPT, context);
      return roast || this.generateFallbackSillyRoast(token, category);
    } catch (error) {
      logger.error({ error, symbol: token.symbol }, 'Failed to generate silly name roast');
      return this.generateFallbackSillyRoast(token, category);
    }
  }

  /**
   * Fallback roasts for silly names when Claude is unavailable
   */
  private generateFallbackSillyRoast(
    token: { symbol: string; name: string },
    category: SillyCategory
  ): string {
    const fallbacks: Record<SillyCategory, string[]> = {
      food: [
        `${token.symbol}? Someone's hungry for rug pulls.`,
        `Food coin. The only thing getting eaten is your investment.`,
        `${token.name}... I'm suddenly craving exit liquidity.`,
      ],
      animal: [
        `${token.symbol}. Because DOGE worked so well for everyone.`,
        `Another animal coin. The zoo of rugs expands.`,
        `${token.name}. Cute name. Ugly tokenomics probably.`,
      ],
      copycat: [
        `${token.symbol}. They really just... added INU to it. Revolutionary.`,
        `Zero creativity. ${token.symbol}. At least try, devs.`,
        `Copycat token detected. The pattern recognition is too easy.`,
      ],
      pump: [
        `${token.symbol}. Subtle pump marketing there. Very subtle.`,
        `They named it ${token.name}. Tell me you're rugpulling without telling me.`,
        `${token.symbol}. The name screams "trust me bro."`,
      ],
      celebrity: [
        `${token.symbol}. The celebrity probably doesn't even know this exists.`,
        `Celebrity grift token #47829. Sure, this one will be different.`,
        `${token.name}. Famous name. Anonymous dev. Classic combo.`,
      ],
      random: [
        `${token.symbol}. They hit their keyboard and called it a token.`,
        `Random letters. ${token.symbol}. The dev's cat named it.`,
        `${token.symbol}. Even the name is low effort. Bullish? No.`,
      ],
      crude: [
        `${token.symbol}. Very mature. Very professional. Very rug.`,
        `${token.name}. The twelve-year-olds are launching tokens again.`,
        `${token.symbol}. Edgy name. Probably edgy exit strategy too.`,
      ],
    };

    const options = fallbacks[category];
    return options[Math.floor(Math.random() * options.length)];
  }

  /**
   * Generate a roast for a failed shill request
   * Called when a viewer burns $SCHIZO to shill a token that fails safety checks
   */
  async generateShillRoast(context: {
    senderWallet: string;
    risks: string[];
    schizoAmountBurned: number;
  }): Promise<string> {
    const shortSender = context.senderWallet.slice(0, 6);
    const risksStr = context.risks.slice(0, 3).join(', ');

    const prompt = `A viewer just burned ${context.schizoAmountBurned.toFixed(0)} $SCHIZO tokens to shill a token.
But the token FAILED your safety checks with these risks: ${risksStr}

Generate a SHORT (max 25 words) paranoid roast directed at the viewer (wallet ${shortSender}...).
- Reference the SPECIFIC risks that made you reject it
- Be funny but not mean-spirited
- Stay in your paranoid trader character
- Thank them sarcastically for wasting their tokens`;

    try {
      const roast = await this.callAI(SCHIZO_SYSTEM_PROMPT, prompt);
      return roast || this.generateFallbackShillRoast(shortSender, context.risks);
    } catch (error) {
      logger.error({ error }, 'Failed to generate shill roast');
      return this.generateFallbackShillRoast(shortSender, context.risks);
    }
  }

  /**
   * Fallback shill roasts when Claude is unavailable
   */
  private generateFallbackShillRoast(shortSender: string, risks: string[]): string {
    const riskStr = risks.join(', ').toLowerCase();

    if (riskStr.includes('honeypot') || riskStr.includes('freeze')) {
      return `Nice try ${shortSender}. This token has honeypot written all over it. Your SCHIZO died for nothing.`;
    }

    if (riskStr.includes('mint') || riskStr.includes('authority')) {
      return `${shortSender}, this dev can print tokens whenever they want. That's a hard no from me.`;
    }

    if (riskStr.includes('concentration') || riskStr.includes('holder')) {
      return `One wallet owns half the supply. Thanks for the shill ${shortSender}, but I'm not that gullible.`;
    }

    if (riskStr.includes('liquidity')) {
      return `${shortSender} just burned tokens to shill something with no liquidity. Bold move.`;
    }

    // Generic fallback
    const genericRoasts = [
      `Sorry ${shortSender}, this one failed my paranoid checks. Better luck next time.`,
      `${shortSender} really thought this would get past me? My trust issues say no.`,
      `Thanks for the burn ${shortSender}, but this token screams rug to me.`,
      `${shortSender}, I appreciate the enthusiasm but my pattern recognition says pass.`,
    ];

    return genericRoasts[Math.floor(Math.random() * genericRoasts.length)];
  }

  /**
   * Generate live analysis thought during token evaluation
   * This is what SCHIZO says out loud as he analyzes a token
   */
  async generateAnalysisThought(
    stage: 'scanning' | 'safety' | 'smart_money' | 'decision',
    context: {
      symbol: string;
      name: string;
      marketCapSol?: number;
      liquidity?: number;
      isSafe?: boolean;
      risks?: string[];
      smartMoneyCount?: number;
      shouldTrade?: boolean;
      reasons?: string[];
    }
  ): Promise<string> {
    const prompts: Record<string, string> = {
      scanning: `You're a paranoid AI trader live-streaming. You just spotted a new token:
- ${context.symbol} (${context.name})
- Mcap: ${context.marketCapSol?.toFixed(1) || '?'} SOL
- Liquidity: ${context.liquidity ? '$' + Math.round(context.liquidity).toLocaleString() : 'unknown'}

Say something SHORT (max 12 words) about spotting this token and starting to analyze it. Be suspicious, curious, or intrigued. Examples:
- "Hold up... ${context.symbol} just popped up. Let me check the authorities."
- "New one. ${context.symbol}. Running my paranoid checks."
- "Interesting... ${context.name}. Checking for honeypot flags."`,

      safety: context.isSafe
        ? `You just finished checking token ${context.symbol} for honeypot/scam flags.
Result: PASSED safety checks.
${context.risks?.length ? `Minor concerns: ${context.risks.join(', ')}` : 'No risks found.'}

Say ONE SHORT sentence (max 15 words) reacting positively but staying cautious. Examples:
- "Clean so far. No freeze auth, no mint auth. But I'm still watching."
- "Passed my checks. Doesn't mean it's safe, just means the devs aren't idiots."
- "No obvious honeypot flags. Proceeding with extreme paranoia."`
        : `You just finished checking token ${context.symbol} for honeypot/scam flags.
Result: FAILED - Found risks: ${context.risks?.join(', ') || 'unknown issues'}

Say ONE SHORT sentence (max 15 words) explaining why you're suspicious or rejecting it. Examples:
- "Nope. Freeze authority still active. Classic honeypot setup."
- "Called it. Mint authority enabled. They can print more anytime."
- "${context.symbol}? More like ${context.symbol}-RUG. Pass."`,

      smart_money: context.smartMoneyCount && context.smartMoneyCount > 0
        ? `You're checking who holds ${context.symbol}.
Found: ${context.smartMoneyCount} smart money wallets already in.

Say ONE SHORT sentence (max 15 words) about following smart money. Examples:
- "${context.smartMoneyCount} whales already loaded. They know something."
- "Smart money's in. Either alpha or coordinated pump. Either way, interesting."
- "Following the wallets that don't lose. ${context.smartMoneyCount} of them here."`
        : `You're checking who holds ${context.symbol}.
Found: No notable smart money wallets detected.

Say ONE SHORT sentence (max 15 words) about the lack of smart money. Examples:
- "No smart money yet. Either too early or nobody cares."
- "Whales haven't touched this. Could be opportunity or warning."
- "Zero smart wallets. I'm on my own with this one."`,

      decision: context.shouldTrade
        ? `Final decision on ${context.symbol}: TRADING
Position: Going in.
Reasons: ${context.reasons?.join(', ') || 'good setup'}

Say ONE SHORT sentence (max 12 words) announcing your decision to buy. Be confident but still paranoid. Examples:
- "Aping in. The patterns align. Let's see."
- "Sending it. ${context.symbol} passes my checks."
- "Taking the position. If I'm wrong, blame the algorithms."`
        : `Final decision on ${context.symbol}: SKIPPING
Reasons: ${context.reasons?.join(', ') || 'not worth the risk'}

Say ONE SHORT sentence (max 12 words) explaining why you're passing. Examples:
- "Nah. Too many red flags. Next."
- "Passing on ${context.symbol}. My gut says no."
- "Skip. The risk-reward isn't there."`
    };

    try {
      const prompt = prompts[stage] + '\n\nRespond with ONLY your one sentence. No quotes, no explanation.';
      const thought = await this.callAI(SCHIZO_SYSTEM_PROMPT, prompt);
      return thought?.trim() || this.generateFallbackAnalysisThought(stage, context);
    } catch (error) {
      // Enhanced error logging to expose actual API failures
      logger.error({
        error,
        errorMessage: error instanceof Error ? error.message : String(error),
        stage,
        symbol: context.symbol
      }, 'Failed to generate analysis thought');

      // Check for specific error types to help with debugging
      if (error instanceof Error) {
        if (error.message.includes('rate_limit') || error.message.includes('429')) {
          logger.warn('AI rate limit hit - using fallback');
        } else if (error.message.includes('authentication') || error.message.includes('401')) {
          logger.error('AI authentication failed - check API key');
        }
      }

      return this.generateFallbackAnalysisThought(stage, context);
    }
  }

  /**
   * Fallback analysis thoughts when Claude is unavailable
   */
  private generateFallbackAnalysisThought(
    stage: 'scanning' | 'safety' | 'smart_money' | 'decision',
    context: { symbol: string; name?: string; isSafe?: boolean; smartMoneyCount?: number; shouldTrade?: boolean; reasons?: string[] }
  ): string {
    const fallbacks: Record<string, string[]> = {
      scanning: [
        `${context.symbol} just appeared. Running full analysis.`,
        `New token: ${context.symbol}. Checking authorities and holders.`,
        `Spotted ${context.symbol}. Let me investigate this.`,
        `${context.name || context.symbol} detected. Initiating paranoid checks.`,
        `Hold up, ${context.symbol} just dropped. Analyzing now.`,
      ],
      safety: context.isSafe
        ? [
            `${context.symbol} passed safety checks. No honeypot flags detected.`,
            `Clean scan on ${context.symbol}. No freeze authority, no mint authority.`,
            `${context.symbol} looks safe. Proceeding with extreme caution.`,
            `Safety check passed for ${context.symbol}. Still doesn't mean trust the devs.`,
            `${context.symbol} cleared. No obvious red flags... yet.`,
          ]
        : [
            `Red flags detected on ${context.symbol}. Hard pass.`,
            `${context.symbol} failed checks. Honeypot vibes all over this.`,
            `Nope. ${context.symbol} has freeze authority. Classic trap.`,
            `${context.symbol} screams rug. Moving to next token.`,
            `${context.symbol} is unsafe. Not risking it.`,
          ],
      smart_money: context.smartMoneyCount && context.smartMoneyCount > 0
        ? [
            `${context.smartMoneyCount} smart wallets detected in ${context.symbol}. Very interesting.`,
            `Whales are already loaded. ${context.smartMoneyCount} proven wallets holding ${context.symbol}.`,
            `${context.smartMoneyCount} profitable traders in ${context.symbol}. Following the alpha.`,
            `Smart money alert: ${context.smartMoneyCount} wallets that don't lose. This could run.`,
            `${context.symbol} has ${context.smartMoneyCount} smart wallets. They know something we don't.`,
          ]
        : [
            `No smart money in ${context.symbol} yet. Flying blind here.`,
            `Zero whale activity on ${context.symbol}. Either too early or red flag.`,
            `${context.symbol} has no proven traders. I'm on my own with this.`,
            `Whales haven't touched ${context.symbol}. Suspicious.`,
            `No smart wallets detected. ${context.symbol} is uncharted territory.`,
          ],
      decision: context.shouldTrade
        ? [
            `Aping ${context.symbol}. The patterns align. Let's go.`,
            `Going in on ${context.symbol}. Position opening now.`,
            `${context.symbol} is a go. Executing buy. YOLO.`,
            `Taking ${context.symbol} position. If wrong, blame the algorithms.`,
            `Sending it on ${context.symbol}. My circuits say yes.`,
            `${context.symbol} passes all checks. Trade executing.`,
          ]
        : [
            `Passing on ${context.symbol}. ${context.reasons?.[0] || 'Not worth the risk.'}.`,
            `${context.symbol} is a skip. ${context.reasons?.[0] || 'Too many red flags.'}.`,
            `Hard pass on ${context.symbol}. Moving to next opportunity.`,
            `Not feeling ${context.symbol}. The vibes are off.`,
            `${context.symbol} fails my criteria. Next token please.`,
          ],
    };

    const options = fallbacks[stage];
    return options[Math.floor(Math.random() * options.length)];
  }

  /**
   * Fallback token commentary - uses actual token data for variety
   */
  private generateFallbackTokenCommentary(token: {
    symbol: string;
    name: string;
    marketCapSol?: number;
    priceChange5m?: number;
  }): string {
    const mcap = token.marketCapSol?.toFixed(1) || '?';
    const change = token.priceChange5m?.toFixed(0) || '0';
    const isUp = (token.priceChange5m || 0) > 0;

    const fallbacks = [
      // Name-based
      `${token.name}? That name is either genius or a cry for help.`,
      `${token.symbol}... creative. Let's see if the chart matches the energy.`,
      `Who names these things? ${token.name}. Anyway, ${mcap} SOL mcap.`,

      // Numbers-based
      `${mcap} SOL mcap on ${token.symbol}. ${isUp ? 'Pumping' : 'Dumping'} ${change}% already.`,
      `${token.symbol} at ${mcap} SOL. That's either early or exit liquidity.`,
      `${change}% in 5 minutes? ${token.symbol} is ${isUp ? 'cooking' : 'cooked'}.`,

      // Skeptical
      `${token.symbol} just dropped. Checking if this is another honeypot...`,
      `New token alert: ${token.symbol}. The dev wallet is probably loading up right now.`,
      `${token.name}. Seen this pattern before. Usually ends in tears.`,

      // Curious
      `${token.symbol} caught my attention. ${mcap} SOL and ${isUp ? 'green' : 'red'}. Hmm.`,
      `Interesting... ${token.name} at ${mcap} SOL. My paranoia says wait.`,

      // Quick dismissal
      `${token.symbol}. Nope. Next.`,
      `${token.name}? Hard pass. Moving on.`,
      `Another one. ${token.symbol}. The machine never stops.`,
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
      const thought = await this.callAI(SCHIZO_SYSTEM_PROMPT, prompt);
      return thought || 'The charts are speaking to me again...';
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
