import { pumpPortalData, type PumpNewTokenEvent } from '../api/pumpportal-data.js';
import { logger } from '../lib/logger.js';
import { TokenValidator, type ValidatorConfig } from './token-validator.js';
import type { TradingEngine } from './trading-engine.js';
import { agentEvents } from '../events/emitter.js';
import { TokenSafetyAnalyzer } from '../analysis/token-safety.js';

export interface SniperPipelineConfig {
  validationDelayMs: number;
  maxQueueSize: number;
  enableTrading: boolean;
}

const DEFAULT_CONFIG: SniperPipelineConfig = {
  validationDelayMs: 300000, // 5 minutes default
  maxQueueSize: 1000,
  enableTrading: false,
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
    this.validator = new TokenValidator(validatorConfig);
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
   */
  private enqueueToken(token: PumpNewTokenEvent): void {
    // Basic deduplication
    if (this.queue.some(t => t.token.mint === token.mint)) return;

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

    logger.debug({ 
      mint: token.mint, 
      symbol: token.symbol,
      queueSize: this.queue.length 
    }, 'Token queued for delayed validation');
  }

  /**
   * Process mature tokens in the queue
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;

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
   */
  private async validateAndExecute(queued: QueuedToken): Promise<void> {
    const { token } = queued;

    // 3. The Validator (DexScreener)
    const result = await this.validator.validate(token.mint);

    if (result.passes) {
      logger.info({
        mint: token.mint,
        symbol: token.symbol,
        liquidity: result.metadata?.liquidity,
        volume: result.metadata?.volume1h,
        reason: 'Passed DexScreener validation'
      }, '✅ Token validated! Passing to Execution...');

      // Notify system
      agentEvents.emit({
        type: 'TOKEN_DISCOVERED',
        timestamp: Date.now(),
        data: {
          ...result.metadata!,
          source: 'SNIPER_PIPELINE'
        } as any // Cast to any to bypass strict type check for now
      });

      // 4. The Executor (Helius via TradingEngine)
      if (this.config.enableTrading && this.tradingEngine) {
        if (this.tokenSafety) {
            // Safety check overlap (double check just in case)
            const safety = await this.tokenSafety.analyze(token.mint);
            if (!safety.isSafe) {
                logger.warn({ mint: token.mint, risks: safety.risks }, '❌ Safety check failed after validation');
                return;
            }
        }

        // Execute via Trading Engine
        this.tradingEngine.executeBuy(token.mint, {
             // Pass known data to speed up engine (approx 170 USD/SOL)
             marketCapSol: result.metadata?.marketCap ? result.metadata.marketCap / 170 : 0,
             liquidity: result.metadata?.liquidity
        });
      }

    } else {
      // Validation failed
      logger.debug({
        mint: token.mint,
        symbol: token.symbol,
        reason: result.reason
      }, '❌ Token rejected by validator');
    }
  }
}
