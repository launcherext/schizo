import { pumpPortalData, type PumpNewTokenEvent } from '../api/pumpportal-data.js';
import { logger } from '../lib/logger.js';
import { TokenValidator, type ValidatorConfig } from './token-validator.js';
import type { TradingEngine } from './trading-engine.js';
import { agentEvents } from '../events/emitter.js';
import { TokenSafetyAnalyzer } from '../analysis/token-safety.js';
import type { RiskProfile } from './types.js';

export interface SniperPipelineConfig {
  riskProfile: RiskProfile;
  validationDelayMs: number; // Will be auto-set by risk profile if default
  maxQueueSize: number;
  enableTrading: boolean;
  maxRetries: number;
  retryDelayMs: number;
}

const DEFAULT_CONFIG: SniperPipelineConfig = {
  riskProfile: 'BALANCED',
  validationDelayMs: 0, // 0 = Auto-calculate based on risk
  maxQueueSize: 1000,
  enableTrading: false,
  // Smarter retry logic - use env var, default to 5 (was 10)
  // Most tokens that fail validation will never pass - reduce wasted API calls
  maxRetries: parseInt(process.env.MAX_VALIDATION_RETRIES || '5', 10),
  retryDelayMs: 30000,   // 30 seconds between retries
};

export interface QueuedToken {
  token: PumpNewTokenEvent;
  receivedAt: number;
  validateAfter: number;
  retryCount: number;
}

/**
 * Sniper Pipeline
 * "Filter-First" architecture: 
 * PumpPortal (Trigger) -> Wait (Filter) -> DexScreener (Validate) -> Helius (Execute)
 */
export class SniperPipeline {
  private config: SniperPipelineConfig;
  private validator: TokenValidator;
  private tradingEngine?: TradingEngine;
  private tokenSafety?: TokenSafetyAnalyzer;
  
  private queue: QueuedToken[] = [];
  private isProcessing = false;
  private processingInterval?: NodeJS.Timeout;
  private isRunning = false;

  constructor(
    config: Partial<SniperPipelineConfig>,
    validatorConfig: Partial<ValidatorConfig>,
    tradingEngine?: TradingEngine,
    tokenSafety?: TokenSafetyAnalyzer
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    
    // Auto-set delay based on risk profile if not explicitly set
    if (this.config.validationDelayMs === 0) {
        if (this.config.riskProfile === 'AGGRESSIVE') {
            this.config.validationDelayMs = 30000; // 30 seconds
        } else if (this.config.riskProfile === 'CONSERVATIVE') {
            this.config.validationDelayMs = 300000; // 5 minutes
        } else {
            this.config.validationDelayMs = 120000; // 2 minutes (Balanced)
        }
    }
    
    // Pass risk profile to validator
    this.validator = new TokenValidator({
        ...validatorConfig,
        riskProfile: this.config.riskProfile
    });
    
    this.tradingEngine = tradingEngine;
    this.tokenSafety = tokenSafety;

    logger.info({ 
      pipelineConfig: this.config,
      validatorConfig 
    }, 'Sniper Pipeline initialized');
  }

  /**
   * Start the pipeline
   */
  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    logger.info('Starting Sniper Pipeline...');

    // 1. Connect to PumpPortal (The Trigger)
    try {
      await pumpPortalData.connect();
      pumpPortalData.subscribeNewTokens();
      
      pumpPortalData.onNewToken((token) => {
        this.enqueueToken(token);
      });

      logger.info('🔌 Connected to PumpPortal - Listening for new tokens');
    } catch (error) {
      logger.error({ error }, 'Failed to connect to PumpPortal');
    }

    // 2. Start Processing Loop (The Wait Filter)
    this.processingInterval = setInterval(() => {
      this.processQueue();
    }, 10000); // Check queue every 10 seconds

    logger.info(`⏳ Pipeline active. Tokens will be held for ${(this.config.validationDelayMs / 60000).toFixed(1)} minutes before validation.`);
  }

  /**
   * Stop the pipeline
   */
  stop(): void {
    this.isRunning = false;
    if (this.processingInterval) {
      clearInterval(this.processingInterval);
    }
    pumpPortalData.disconnect();
    logger.info('Sniper Pipeline stopped');
  }

  /**
   * Add new token to the delayed queue
   * Pre-filters tokens that are unlikely to pass validation
   */
  private enqueueToken(token: PumpNewTokenEvent): void {
    // Basic deduplication
    if (this.queue.some(t => t.token.mint === token.mint)) return;

    // PRE-FILTER: Skip tokens that are extremely unlikely to pass validation
    // This saves API calls and reduces queue congestion

    // 1. Minimum market cap filter - tokens below 30 SOL rarely survive
    const MIN_MCAP_SOL = 30;
    if (token.marketCapSol < MIN_MCAP_SOL) {
      logger.debug({
        mint: token.mint,
        symbol: token.symbol,
        marketCapSol: token.marketCapSol.toFixed(2)
      }, 'Skipped: Market cap too low for queue');
      return;
    }

    // 2. Suspicious name filter - common rug patterns
    const suspiciousPatterns = [/test/i, /rug/i, /scam/i, /honeypot/i, /fake/i];
    for (const pattern of suspiciousPatterns) {
      if (pattern.test(token.symbol) || pattern.test(token.name)) {
        logger.debug({
          mint: token.mint,
          symbol: token.symbol,
          name: token.name
        }, 'Skipped: Suspicious token name');
        return;
      }
    }

    // Queue limiting
    if (this.queue.length >= this.config.maxQueueSize) {
      // Remove oldest
      this.queue.shift();
    }

    const now = Date.now();
    this.queue.push({
      token,
      receivedAt: now,
      validateAfter: now + this.config.validationDelayMs,
      retryCount: 0,
    });

    logger.info({
      mint: token.mint,
      symbol: token.symbol,
      marketCapSol: token.marketCapSol.toFixed(2),
      queueSize: this.queue.length,
      validateAfter: new Date(now + this.config.validationDelayMs).toISOString()
    }, '📥 Token queued for delayed validation');
  }

  /**
   * Process mature tokens in the queue
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;

    // Log queue status every cycle for debugging
    if (this.queue.length > 0) {
      const now = Date.now();
      const readyCount = this.queue.filter(t => t.validateAfter <= now).length;
      logger.info({ queueSize: this.queue.length, readyForValidation: readyCount }, '⏰ Queue check');
    }

    try {
      const now = Date.now();
      
      // Find tokens ready for validation
      const readyTokens = this.queue.filter(t => t.validateAfter <= now);
      
      // Remove them from main queue
      if (readyTokens.length > 0) {
        this.queue = this.queue.filter(t => t.validateAfter > now);
        
        logger.info({ 
          count: readyTokens.length, 
          remainingInQueue: this.queue.length 
        }, 'Processing mature tokens...');

        // Process in batches to respect rate limits (DexScreener ~60/min)
        // We'll do 5 at a time
        const BATCH_SIZE = 5;
        for (let i = 0; i < readyTokens.length; i += BATCH_SIZE) {
          const batch = readyTokens.slice(i, i + BATCH_SIZE);
          await Promise.all(batch.map(t => this.validateAndExecute(t)));
          
          // Small delay between batches to be nice to APIs
          if (i + BATCH_SIZE < readyTokens.length) {
            await new Promise(r => setTimeout(r, 2000));
          }
        }
      }

    } catch (error) {
      logger.error({ error }, 'Error processing pipeline queue');
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Validate a single token and pass to execution if good
   * Emits SCAN event on entry, REJECT event on failure with full observability
   */
  private async validateAndExecute(queued: QueuedToken): Promise<void> {
    const { token } = queued;
    const analysisLogs: string[] = [];

    analysisLogs.push(`Token: ${token.symbol} (${token.mint.slice(0, 8)}...)`);
    analysisLogs.push(`Source: PUMP_FUN`);
    analysisLogs.push(`Wait time: ${(this.config.validationDelayMs / 60000).toFixed(1)} min`);

    // EMIT SCAN EVENT - Token is being analyzed
    agentEvents.emit({
      type: 'SCAN',
      timestamp: Date.now(),
      data: {
        reasoning: `Analyzing ${token.symbol} from PumpPortal - survived ${(this.config.validationDelayMs / 60000).toFixed(1)} min delay`,
        logs: [...analysisLogs],
        mint: token.mint,
        symbol: token.symbol,
        name: token.name,
        source: 'PUMP_FUN',
        liquidity: 0, // Will be updated after validation
        marketCap: token.marketCapSol * 170,
      },
    });

    // Stage 1: SCANNING - Emit for frontend "Currently Analyzing" display
    agentEvents.emit({
      type: 'ANALYSIS_THOUGHT',
      timestamp: Date.now(),
      data: {
        mint: token.mint,
        symbol: token.symbol,
        name: token.name,
        marketCapSol: token.marketCapSol,
        stage: 'scanning',
        thought: `Checking ${token.symbol}... survived the ${(this.config.validationDelayMs / 60000).toFixed(1)} min delay. Let's see if it's worth anything.`
      }
    });

    logger.info({ mint: token.mint, symbol: token.symbol, marketCapSol: token.marketCapSol.toFixed(2) }, '🔍 Validating bonding curve token...');

    // 3. The Validator (Bonding Curve - uses PumpPortal data, not DexScreener)
    // Bonding curve tokens have $0 DEX liquidity, so we validate using market cap and bonding progress
    const result = this.validator.validateBondingCurve(token);

    if (result.passes) {
      // Emit validation success for frontend
      agentEvents.emit({
        type: 'ANALYSIS_THOUGHT',
        timestamp: Date.now(),
        data: {
          mint: token.mint,
          symbol: token.symbol,
          name: token.name,
          liquidity: 0, // Bonding curve = no DEX liquidity
          marketCapSol: result.marketCapSol,
          stage: 'safety',
          thought: `${token.symbol} at ${result.marketCapSol.toFixed(1)} SOL mcap (${result.bondingProgress.toFixed(1)}% to graduation). Looking promising...`
        }
      });

      logger.info({
        mint: token.mint,
        symbol: token.symbol,
        marketCapSol: result.marketCapSol,
        bondingProgress: result.bondingProgress,
        reason: 'Passed bonding curve validation'
      }, '✅ Bonding curve token validated! Passing to Execution...');

      // Notify system
      agentEvents.emit({
        type: 'TOKEN_DISCOVERED',
        timestamp: Date.now(),
        data: {
          mint: token.mint,
          symbol: token.symbol,
          name: token.name,
          marketCapSol: result.marketCapSol,
          bondingProgress: result.bondingProgress,
          source: 'SNIPER_PIPELINE',
          isBondingCurve: true,
        } as any
      });

      // 4. The Executor (Helius via TradingEngine)
      if (this.config.enableTrading && this.tradingEngine) {
        if (this.tokenSafety) {
            // Safety check
            const safety = await this.tokenSafety.analyze(token.mint);
            analysisLogs.push(`Safety check: ${safety.isSafe ? 'PASSED' : 'FAILED'}`);

            if (!safety.isSafe) {
                const rejectReason = safety.risks.join(', ');
                analysisLogs.push(`Rejected: ${rejectReason}`);

                // Emit rejection with REJECT event
                agentEvents.emit({
                  type: 'REJECT',
                  timestamp: Date.now(),
                  data: {
                    reasoning: `${token.symbol} rejected due to safety risks: ${rejectReason}`,
                    logs: analysisLogs,
                    mint: token.mint,
                    symbol: token.symbol,
                    rejectReason,
                    stage: 'safety',
                  },
                });

                // Also emit ANALYSIS_THOUGHT for compatibility
                agentEvents.emit({
                  type: 'ANALYSIS_THOUGHT',
                  timestamp: Date.now(),
                  data: {
                    mint: token.mint,
                    symbol: token.symbol,
                    stage: 'decision',
                    thought: `NOPE. ${token.symbol} has ${safety.risks.join(', ')}. Hard pass.`,
                    details: { isSafe: false, risks: safety.risks, shouldTrade: false }
                  }
                });
                logger.warn({ mint: token.mint, risks: safety.risks }, '❌ Safety check failed after validation');
                return;
            }
        }

        // Emit decision to buy
        agentEvents.emit({
          type: 'ANALYSIS_THOUGHT',
          timestamp: Date.now(),
          data: {
            mint: token.mint,
            symbol: token.symbol,
            stage: 'decision',
            thought: `${token.symbol} passes all checks. BUYING.`,
            details: { shouldTrade: true }
          }
        });

        // Execute via Trading Engine (bonding curve token)
        this.tradingEngine.executeBuy(token.mint, {
             marketCapSol: result.marketCapSol,
             liquidity: 0, // Bonding curve = no DEX liquidity
             symbol: token.symbol,
             name: token.name,
             imageUrl: token.imageUrl,
        });
      }

    } else {
      const rejectReason = result.reason || 'Bonding curve validation failed';
      analysisLogs.push(`Validation: FAILED`);
      analysisLogs.push(`Rejected: ${rejectReason}`);

      // Validation failed - emit REJECT event
      agentEvents.emit({
        type: 'REJECT',
        timestamp: Date.now(),
        data: {
          reasoning: `${token.symbol} rejected: ${rejectReason}`,
          logs: analysisLogs,
          mint: token.mint,
          symbol: token.symbol,
          rejectReason,
          stage: 'validation',
        },
      });

      // Also emit ANALYSIS_THOUGHT for compatibility
      agentEvents.emit({
        type: 'ANALYSIS_THOUGHT',
        timestamp: Date.now(),
        data: {
          mint: token.mint,
          symbol: token.symbol,
          stage: 'decision',
          thought: `${token.symbol} rejected: ${result.reason}. Moving on.`,
          details: { shouldTrade: false, reasons: [result.reason || 'Unknown'] }
        }
      });

      // No retry needed for bonding curve validation - we already have all the data
      // Token either passes now (market cap + bonding progress criteria) or it doesn't
      logger.info({
        mint: token.mint,
        symbol: token.symbol,
        marketCapSol: result.marketCapSol.toFixed(2),
        bondingProgress: result.bondingProgress.toFixed(1),
        reason: result.reason
      }, `❌ Token rejected: ${result.reason}`);
    }
  }
}
