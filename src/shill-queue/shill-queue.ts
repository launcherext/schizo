/**
 * Shill Queue - Processes viewer shill requests
 *
 * When a viewer burns $SCHIZO with a CA in the memo:
 * 1. Announce receipt via TTS
 * 2. Run safety analysis
 * 3. If FAIL: Generate roast, speak it
 * 4. If PASS: Execute lotto buy
 */

import { createLogger } from '../lib/logger.js';
import { agentEvents } from '../events/emitter.js';
import type { TradingEngine } from '../trading/trading-engine.js';
import type { TokenSafetyAnalyzer } from '../analysis/token-safety.js';
import type { ClaudeClient } from '../personality/claude-client.js';
import type { VoiceNarrator } from '../personality/deepgram-tts.js';
import type { CommentarySystem } from '../personality/commentary-system.js';
import type {
  ShillQueueConfig,
  ShillRequest,
  ShillAnalysisResult,
  DEFAULT_SHILL_QUEUE_CONFIG,
} from './types.js';

const logger = createLogger('shill-queue');

/**
 * ShillQueue - Processes viewer shill requests
 */
export class ShillQueue {
  private config: ShillQueueConfig;
  private tradingEngine: TradingEngine | undefined;
  private tokenSafety: TokenSafetyAnalyzer;
  private claude: ClaudeClient | undefined;
  private narrator: VoiceNarrator | undefined;
  private commentarySystem: CommentarySystem | undefined;

  /** Queue of pending shill requests */
  private queue: ShillRequest[] = [];

  /** Is currently processing */
  private isProcessing = false;

  /** Processed CAs to avoid duplicates */
  private processedCAs = new Set<string>();

  constructor(
    config: ShillQueueConfig,
    tradingEngine: TradingEngine | undefined,
    tokenSafety: TokenSafetyAnalyzer,
    claude?: ClaudeClient,
    narrator?: VoiceNarrator,
    commentarySystem?: CommentarySystem
  ) {
    this.config = config;
    this.tradingEngine = tradingEngine;
    this.tokenSafety = tokenSafety;
    this.claude = claude;
    this.narrator = narrator;
    this.commentarySystem = commentarySystem;

    logger.info({
      maxQueueSize: config.maxQueueSize,
      lottoSize: config.lottoPositionSol,
    }, 'ShillQueue initialized');
  }

  /**
   * Add a shill request to the queue
   */
  enqueue(request: ShillRequest): void {
    // Check for duplicate CA
    if (this.processedCAs.has(request.contractAddress)) {
      logger.info({
        ca: request.contractAddress.slice(0, 8) + '...',
      }, 'CA already processed, skipping');
      return;
    }

    // Check queue size
    if (this.queue.length >= this.config.maxQueueSize) {
      logger.warn({
        queueSize: this.queue.length,
        maxSize: this.config.maxQueueSize,
      }, 'Queue full, dropping oldest shill');
      this.queue.shift();
    }

    this.queue.push(request);
    this.processedCAs.add(request.contractAddress);

    // Clean up old CAs periodically
    if (this.processedCAs.size > 100) {
      const entries = Array.from(this.processedCAs);
      this.processedCAs = new Set(entries.slice(-50));
    }

    logger.info({
      sender: request.senderWallet.slice(0, 8) + '...',
      ca: request.contractAddress.slice(0, 8) + '...',
      amount: request.schizoAmountBurned,
      queueSize: this.queue.length,
    }, 'Shill request queued');

    // Start processing if not already
    this.processQueue();
  }

  /**
   * Process the queue one at a time
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessing || this.queue.length === 0) {
      return;
    }

    this.isProcessing = true;

    try {
      while (this.queue.length > 0) {
        const request = this.queue.shift()!;
        await this.processShill(request);
      }
    } catch (error) {
      logger.error({ error }, 'Error processing shill queue');
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Process a single shill request
   */
  private async processShill(request: ShillRequest): Promise<ShillAnalysisResult> {
    const startTime = Date.now();
    const shortSender = request.senderWallet.slice(0, 6);
    const shortCA = request.contractAddress.slice(0, 8);

    logger.info({
      sender: shortSender,
      ca: shortCA,
      amount: request.schizoAmountBurned,
    }, 'Processing shill request');

    // 1. Emit SHILL_RECEIVED event
    agentEvents.emit({
      type: 'SHILL_RECEIVED',
      timestamp: Date.now(),
      data: {
        reasoning: `Viewer ${shortSender}... burned ${request.schizoAmountBurned.toFixed(0)} $SCHIZO to shill ${shortCA}...`,
        logs: [`Shill from ${request.senderWallet}`, `CA: ${request.contractAddress}`],
        senderWallet: request.senderWallet,
        contractAddress: request.contractAddress,
        schizoAmountBurned: request.schizoAmountBurned,
      },
    });

    // 2. Announce receipt via TTS
    const announcement = `Incoming shill from wallet ${shortSender}. They burned ${request.schizoAmountBurned.toFixed(0)} SCHIZO tokens. Let me check this one out.`;

    if (this.narrator) {
      await this.narrator.say(announcement);
    }

    // 3. Run safety analysis
    logger.info({ ca: request.contractAddress }, 'Running safety analysis on shilled token');

    let safetyResult;
    try {
      safetyResult = await Promise.race([
        this.tokenSafety.analyze(request.contractAddress),
        new Promise<null>((_, reject) =>
          setTimeout(() => reject(new Error('Analysis timeout')), this.config.processingTimeoutMs)
        ),
      ]);
    } catch (error) {
      logger.error({ error, ca: request.contractAddress }, 'Safety analysis failed/timeout');

      // Treat timeout/error as unsafe
      const roast = 'This token is taking too long to analyze. Probably hiding something. Hard pass.';

      agentEvents.emit({
        type: 'SHILL_ROAST',
        timestamp: Date.now(),
        data: {
          reasoning: 'Token analysis timed out - treating as unsafe',
          logs: ['Analysis timeout'],
          senderWallet: request.senderWallet,
          contractAddress: request.contractAddress,
          roastMessage: roast,
          risks: ['Analysis timeout'],
        },
      });

      if (this.narrator) {
        await this.narrator.say(roast);
      }

      return {
        request,
        isSafe: false,
        risks: ['Analysis timeout'],
        roastMessage: roast,
      };
    }

    if (!safetyResult) {
      const roast = `Couldn't find any info on ${shortCA}. Probably a ghost token. Next!`;

      agentEvents.emit({
        type: 'SHILL_ROAST',
        timestamp: Date.now(),
        data: {
          reasoning: 'Token not found',
          logs: ['No data returned from safety analysis'],
          senderWallet: request.senderWallet,
          contractAddress: request.contractAddress,
          roastMessage: roast,
          risks: ['Token not found'],
        },
      });

      if (this.narrator) {
        await this.narrator.say(roast);
      }

      return {
        request,
        isSafe: false,
        risks: ['Token not found'],
        roastMessage: roast,
      };
    }

    // 4. Check if safe
    if (!safetyResult.isSafe) {
      logger.info({
        ca: shortCA,
        risks: safetyResult.risks,
      }, 'Shilled token FAILED safety check');

      // Generate roast
      const roast = await this.generateRoast(request, safetyResult.risks);

      agentEvents.emit({
        type: 'SHILL_ROAST',
        timestamp: Date.now(),
        data: {
          reasoning: `Token ${safetyResult.symbol || shortCA} failed safety checks`,
          logs: safetyResult.risks,
          tokenSymbol: safetyResult.symbol,
          senderWallet: request.senderWallet,
          contractAddress: request.contractAddress,
          roastMessage: roast,
          risks: safetyResult.risks,
        },
      });

      if (this.narrator) {
        await this.narrator.say(roast);
      }

      return {
        request,
        isSafe: false,
        risks: safetyResult.risks,
        tokenInfo: {
          symbol: safetyResult.symbol || 'UNKNOWN',
          name: safetyResult.name || 'Unknown',
          marketCapSol: safetyResult.marketCapSol,
          liquidity: safetyResult.liquidity,
        },
        roastMessage: roast,
      };
    }

    // 5. Token passed! Execute lotto buy
    logger.info({
      ca: shortCA,
      symbol: safetyResult.symbol,
    }, 'Shilled token PASSED safety check - executing lotto buy');

    let buySignature: string | null = null;

    if (this.tradingEngine) {
      try {
        const successMsg = `${safetyResult.symbol || shortCA} passed my paranoid checks. Aping in with a lotto position.`;

        if (this.narrator) {
          await this.narrator.say(successMsg);
        }

        buySignature = await this.tradingEngine.executeBuy(
          request.contractAddress,
          {
            symbol: safetyResult.symbol,
            name: safetyResult.name,
            marketCapSol: safetyResult.marketCapSol,
            liquidity: safetyResult.liquidity,
          },
          true, // Skip evaluation (we already did safety)
          this.config.lottoPositionSol // Override position size to lotto size
        );

        if (buySignature) {
          agentEvents.emit({
            type: 'SHILL_BUY',
            timestamp: Date.now(),
            data: {
              reasoning: `Viewer shill ${safetyResult.symbol || shortCA} passed safety - bought ${this.config.lottoPositionSol} SOL`,
              logs: [`Buy signature: ${buySignature}`],
              tokenSymbol: safetyResult.symbol,
              senderWallet: request.senderWallet,
              contractAddress: request.contractAddress,
              buySignature,
              positionSizeSol: this.config.lottoPositionSol,
            },
          });

          const confirmMsg = `Bought! ${this.config.lottoPositionSol} SOL on ${safetyResult.symbol || shortCA}. Thanks for the tip, ${shortSender}.`;
          if (this.narrator) {
            await this.narrator.say(confirmMsg);
          }
        }
      } catch (error) {
        logger.error({ error, ca: request.contractAddress }, 'Failed to execute shill buy');

        const failMsg = `Trade execution failed. The blockchain gods are not pleased today.`;
        if (this.narrator) {
          await this.narrator.say(failMsg);
        }
      }
    } else {
      const noTradeMsg = `${safetyResult.symbol || shortCA} looks clean, but trading is disabled. Nice find though, ${shortSender}.`;
      if (this.narrator) {
        await this.narrator.say(noTradeMsg);
      }
    }

    const elapsed = Date.now() - startTime;
    logger.info({
      ca: shortCA,
      elapsedMs: elapsed,
      bought: !!buySignature,
    }, 'Shill processing complete');

    return {
      request,
      isSafe: true,
      risks: [],
      tokenInfo: {
        symbol: safetyResult.symbol || 'UNKNOWN',
        name: safetyResult.name || 'Unknown',
        marketCapSol: safetyResult.marketCapSol,
        liquidity: safetyResult.liquidity,
      },
      buySignature: buySignature || undefined,
      positionSizeSol: buySignature ? this.config.lottoPositionSol : undefined,
    };
  }

  /**
   * Generate a roast for a failed shill
   */
  private async generateRoast(request: ShillRequest, risks: string[]): Promise<string> {
    const shortSender = request.senderWallet.slice(0, 6);

    // Try Claude for a personalized roast
    if (this.claude) {
      try {
        const roast = await this.claude.generateShillRoast({
          senderWallet: request.senderWallet,
          risks,
          schizoAmountBurned: request.schizoAmountBurned,
        });
        return roast;
      } catch (error) {
        logger.warn({ error }, 'Failed to generate Claude roast, using fallback');
      }
    }

    // Fallback roasts based on risk type
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

    // Generic roast
    return `Sorry ${shortSender}, this one failed my paranoid checks. Better luck next time. Risks: ${risks.slice(0, 2).join(', ')}.`;
  }

  /**
   * Get current queue status
   */
  getQueueStatus(): { size: number; processing: boolean } {
    return {
      size: this.queue.length,
      processing: this.isProcessing,
    };
  }
}
