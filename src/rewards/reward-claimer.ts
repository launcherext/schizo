/**
 * Reward Claimer - Autonomous Revenue Capture
 *
 * Automatically claims:
 * - Pump.fun creator fees
 * - Pump.fun referral fees
 * - Meteora DBC fees (if configured)
 *
 * Emits detailed events for frontend observability.
 */

import { agentEvents } from '../events/emitter.js';
import { logger } from '../lib/logger.js';
import type { PumpPortalClient } from '../trading/pumpportal-client.js';

/**
 * Reward source types
 */
export type RewardSource = 'pump_creator' | 'pump_referral' | 'meteora_dbc';

/**
 * Configuration for the reward claimer
 */
export interface RewardClaimerConfig {
  enabled: boolean;
  claimIntervalMs: number;          // How often to attempt claims (default: 5 minutes)
  minClaimThreshold: number;        // Minimum SOL to bother claiming (default: 0.001)
  maxRetries: number;               // Max retries on failure
  retryDelayMs: number;             // Delay between retries
  claimPumpCreator: boolean;        // Claim pump.fun creator fees
  claimPumpReferral: boolean;       // Claim pump.fun referral fees
  claimMeteoraDbc: boolean;         // Claim meteora DBC fees
}

const DEFAULT_CONFIG: RewardClaimerConfig = {
  enabled: true,
  claimIntervalMs: 5 * 60 * 1000,   // 5 minutes
  minClaimThreshold: 0.001,         // 0.001 SOL (~$0.17)
  maxRetries: 3,
  retryDelayMs: 5000,               // 5 seconds
  claimPumpCreator: true,
  claimPumpReferral: false,         // Disabled by default (separate contract)
  claimMeteoraDbc: false,           // Disabled by default
};

/**
 * Claim result
 */
interface ClaimResult {
  success: boolean;
  signature?: string;
  amountSol?: number;
  error?: string;
}

/**
 * Reward Claimer Service
 *
 * Handles automatic claiming of protocol rewards (creator fees, referrals).
 * Designed for production with proper error handling and observability.
 */
export class RewardClaimer {
  private config: RewardClaimerConfig;
  private pumpPortal: PumpPortalClient;
  private claimInterval?: NodeJS.Timeout;
  private isRunning = false;
  private claimLogs: string[] = [];
  private totalClaimedSol = 0;
  private claimCount = 0;

  constructor(
    pumpPortal: PumpPortalClient,
    config: Partial<RewardClaimerConfig> = {}
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.pumpPortal = pumpPortal;

    logger.info({
      config: this.config,
    }, 'RewardClaimer initialized');
  }

  /**
   * Start the reward claiming service
   */
  start(): void {
    if (this.isRunning) {
      logger.warn('RewardClaimer already running');
      return;
    }

    if (!this.config.enabled) {
      logger.info('RewardClaimer disabled in config');
      return;
    }

    this.isRunning = true;
    this.claimLogs = [];

    logger.info({
      intervalMs: this.config.claimIntervalMs,
      sources: {
        pumpCreator: this.config.claimPumpCreator,
        pumpReferral: this.config.claimPumpReferral,
        meteoraDbc: this.config.claimMeteoraDbc,
      },
    }, 'Starting RewardClaimer');

    // Initial claim after 30 seconds (let system stabilize)
    setTimeout(() => {
      this.claimAllRewards().catch(err => {
        logger.error({ error: err }, 'Initial reward claim failed');
      });
    }, 30000);

    // Then claim on interval
    this.claimInterval = setInterval(() => {
      this.claimAllRewards().catch(err => {
        logger.error({ error: err }, 'Scheduled reward claim failed');
      });
    }, this.config.claimIntervalMs);

    logger.info('RewardClaimer started successfully');
  }

  /**
   * Stop the reward claiming service
   */
  stop(): void {
    if (!this.isRunning) return;

    this.isRunning = false;
    if (this.claimInterval) {
      clearInterval(this.claimInterval);
      this.claimInterval = undefined;
    }

    logger.info({
      totalClaimedSol: this.totalClaimedSol,
      claimCount: this.claimCount,
    }, 'RewardClaimer stopped');
  }

  /**
   * Claim all configured reward sources
   */
  async claimAllRewards(): Promise<void> {
    this.claimLogs = [];
    this.claimLogs.push(`Claim cycle started at ${new Date().toISOString()}`);

    logger.debug('Starting reward claim cycle');

    // Claim Pump.fun creator fees
    if (this.config.claimPumpCreator) {
      await this.claimWithRetry('pump_creator', () => this.claimPumpCreatorFees());
    }

    // Claim Pump.fun referral fees (if enabled)
    if (this.config.claimPumpReferral) {
      await this.claimWithRetry('pump_referral', () => this.claimPumpReferralFees());
    }

    // Claim Meteora DBC fees (if enabled)
    if (this.config.claimMeteoraDbc) {
      await this.claimWithRetry('meteora_dbc', () => this.claimMeteoraDbcFees());
    }

    this.claimLogs.push(`Claim cycle completed`);
    logger.debug({ totalClaimed: this.totalClaimedSol }, 'Reward claim cycle complete');
  }

  /**
   * Claim with retry logic
   */
  private async claimWithRetry(
    source: RewardSource,
    claimFn: () => Promise<ClaimResult>
  ): Promise<void> {
    let attempt = 0;
    let lastError: string | undefined;

    while (attempt < this.config.maxRetries) {
      attempt++;
      this.claimLogs.push(`Attempting ${source} claim (attempt ${attempt}/${this.config.maxRetries})`);

      try {
        const result = await claimFn();

        if (result.success && result.signature) {
          // Success!
          this.totalClaimedSol += result.amountSol || 0;
          this.claimCount++;

          this.claimLogs.push(`SUCCESS: ${source} claimed - ${result.signature}`);

          // Emit success event
          agentEvents.emit({
            type: 'REWARD_CLAIMED',
            timestamp: Date.now(),
            data: {
              reasoning: `Successfully claimed ${source} rewards`,
              logs: [...this.claimLogs],
              signature: result.signature,
              amountSol: result.amountSol || 0,
              source,
            },
          });

          logger.info({
            source,
            signature: result.signature,
            amountSol: result.amountSol,
          }, 'Reward claimed successfully');

          return; // Success, exit retry loop
        } else if (!result.success && result.error?.includes('no fees')) {
          // No fees to claim - not an error
          this.claimLogs.push(`${source}: No fees to claim at this time`);
          logger.debug({ source }, 'No fees to claim');
          return;
        } else {
          lastError = result.error || 'Unknown error';
          this.claimLogs.push(`${source} attempt ${attempt} failed: ${lastError}`);
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        this.claimLogs.push(`${source} attempt ${attempt} threw: ${lastError}`);
        logger.warn({ source, attempt, error }, 'Reward claim attempt failed');
      }

      // Wait before retry
      if (attempt < this.config.maxRetries) {
        await new Promise(r => setTimeout(r, this.config.retryDelayMs));
      }
    }

    // All retries exhausted
    this.claimLogs.push(`FAILED: ${source} claim failed after ${this.config.maxRetries} attempts`);

    // Emit failure event
    agentEvents.emit({
      type: 'REWARD_FAILED',
      timestamp: Date.now(),
      data: {
        reasoning: `Failed to claim ${source} rewards after ${this.config.maxRetries} attempts`,
        logs: [...this.claimLogs],
        source,
        error: lastError || 'Max retries exceeded',
      },
    });

    logger.error({
      source,
      attempts: this.config.maxRetries,
      lastError,
    }, 'Reward claim failed after all retries');
  }

  /**
   * Claim Pump.fun creator fees
   */
  private async claimPumpCreatorFees(): Promise<ClaimResult> {
    try {
      const signature = await this.pumpPortal.claimFees('pump');

      if (signature && signature.length > 0) {
        return {
          success: true,
          signature,
          // Note: Pump.fun doesn't tell us the amount pre-claim
          // We'd need to parse the transaction to get exact amount
          amountSol: undefined,
        };
      } else {
        return {
          success: false,
          error: 'No signature returned - possibly no fees to claim',
        };
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);

      // Check if it's a "no fees" situation (not really an error)
      if (errorMsg.includes('no claimable') || errorMsg.includes('insufficient')) {
        return {
          success: false,
          error: 'no fees to claim',
        };
      }

      return {
        success: false,
        error: errorMsg,
      };
    }
  }

  /**
   * Claim Pump.fun referral fees
   *
   * Note: This is a separate mechanism from creator fees.
   * Requires referral program enrollment.
   */
  private async claimPumpReferralFees(): Promise<ClaimResult> {
    // Pump.fun referral fees are claimed through a different mechanism
    // For now, this is a placeholder - implement when referral program is active
    logger.debug('Pump.fun referral fee claiming not yet implemented');
    return {
      success: false,
      error: 'Referral fee claiming not implemented',
    };
  }

  /**
   * Claim Meteora DBC (Dynamic Bonding Curve) fees
   *
   * Note: Meteora DBC is a separate protocol from Pump.fun.
   * Requires separate integration.
   */
  private async claimMeteoraDbcFees(): Promise<ClaimResult> {
    try {
      const signature = await this.pumpPortal.claimFees('meteora-dbc');

      if (signature && signature.length > 0) {
        return {
          success: true,
          signature,
          amountSol: undefined,
        };
      } else {
        return {
          success: false,
          error: 'No signature returned',
        };
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: errorMsg,
      };
    }
  }

  /**
   * Get statistics
   */
  getStats(): {
    isRunning: boolean;
    totalClaimedSol: number;
    claimCount: number;
    lastLogs: string[];
  } {
    return {
      isRunning: this.isRunning,
      totalClaimedSol: this.totalClaimedSol,
      claimCount: this.claimCount,
      lastLogs: [...this.claimLogs],
    };
  }

  /**
   * Force a claim cycle (for testing)
   */
  async forceClaimCycle(): Promise<void> {
    logger.info('Force claim cycle triggered');
    await this.claimAllRewards();
  }
}
