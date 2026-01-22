import { EventEmitter } from 'events';
import { Connection, Keypair, PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL } from '@solana/web3.js';
import bs58 from 'bs58';
import { createChildLogger } from '../utils/logger';
import { config } from '../config/settings';
import { repository } from '../db/repository';

const logger = createChildLogger('reward-claimer');

// Pump.fun program addresses
const PUMP_FUN_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const PUMP_FUN_FEE_ACCOUNT = new PublicKey('CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM');

export interface ClaimResult {
  success: boolean;
  source: string;
  amountSol: number;
  signature?: string;
  error?: string;
}

export interface ClaimStats {
  totalClaimedSol: number;
  claimCount: number;
  lastClaimTime: Date | null;
  sources: {
    pump_creator: number;
    pump_referral: number;
    meteora_dbc: number;
  };
}

export class RewardClaimer extends EventEmitter {
  private connection: Connection;
  private wallet: Keypair | null = null;
  private claimInterval: NodeJS.Timeout | null = null;
  private isRunning = false;
  private stats: ClaimStats = {
    totalClaimedSol: 0,
    claimCount: 0,
    lastClaimTime: null,
    sources: {
      pump_creator: 0,
      pump_referral: 0,
      meteora_dbc: 0,
    },
  };

  constructor() {
    super();
    this.connection = new Connection(config.solanaRpcUrl, 'confirmed');
  }

  async start(intervalMs: number = 5 * 60 * 1000): Promise<void> {
    if (!config.c100?.autoClaim?.enabled) {
      logger.info('Auto-claim disabled in config');
      return;
    }

    if (this.isRunning) {
      logger.warn('Reward claimer already running');
      return;
    }

    // Initialize wallet
    if (config.privateKey) {
      try {
        const secretKey = bs58.decode(config.privateKey);
        this.wallet = Keypair.fromSecretKey(secretKey);
        logger.info({ publicKey: this.wallet.publicKey.toBase58() }, 'Reward claimer wallet initialized');
      } catch (error) {
        logger.error({ error }, 'Failed to initialize reward claimer wallet');
        return;
      }
    } else {
      logger.warn('No private key configured - reward claimer cannot start');
      return;
    }

    // Load historical stats from DB
    await this.loadStats();

    this.isRunning = true;
    logger.info({ intervalMs }, 'Starting reward claimer');

    // Initial claim attempt
    await this.claimAllRewards();

    // Start periodic claiming
    this.claimInterval = setInterval(async () => {
      try {
        await this.claimAllRewards();
      } catch (error) {
        logger.error({ error }, 'Failed to claim rewards');
      }
    }, intervalMs);
  }

  stop(): void {
    if (this.claimInterval) {
      clearInterval(this.claimInterval);
      this.claimInterval = null;
    }
    this.isRunning = false;
    logger.info('Reward claimer stopped');
  }

  private async loadStats(): Promise<void> {
    try {
      const totals = await repository.getC100ClaimTotals();
      const recentClaims = await repository.getRecentC100Claims(100);

      this.stats.totalClaimedSol = totals.total_sol;
      this.stats.claimCount = totals.count;

      // Calculate per-source totals
      for (const claim of recentClaims) {
        const source = claim.source as keyof typeof this.stats.sources;
        if (source in this.stats.sources) {
          this.stats.sources[source] += parseFloat(claim.amount_sol.toString());
        }
      }

      if (recentClaims.length > 0) {
        this.stats.lastClaimTime = new Date(recentClaims[0].timestamp);
      }

      logger.info({
        totalClaimed: this.stats.totalClaimedSol.toFixed(4),
        claimCount: this.stats.claimCount,
      }, 'Loaded claim stats from database');
    } catch (error) {
      logger.error({ error }, 'Failed to load claim stats');
    }
  }

  async claimAllRewards(): Promise<ClaimResult[]> {
    const results: ClaimResult[] = [];
    logger.info('Starting claim cycle');

    // Claim pump.fun creator fees if enabled
    if (config.c100?.autoClaim?.claimPumpCreator) {
      try {
        const result = await this.claimPumpCreatorFees();
        if (result.amountSol > 0) {
          results.push(result);
        }
      } catch (error) {
        logger.error({ error }, 'Failed to claim pump creator fees');
      }
    }

    // Log total claimed this cycle
    const totalClaimed = results.reduce((sum, r) => sum + (r.success ? r.amountSol : 0), 0);
    if (totalClaimed > 0) {
      logger.info({
        totalClaimed: totalClaimed.toFixed(6),
        claims: results.length,
      }, 'Claim cycle completed');

      this.emit('claimCycleComplete', { totalClaimed, results });
    }

    return results;
  }

  async claimPumpCreatorFees(): Promise<ClaimResult> {
    if (!this.wallet) {
      return { success: false, source: 'pump_creator', amountSol: 0, error: 'Wallet not initialized' };
    }

    try {
      // Check if there are claimable fees
      // Pump.fun creator fees are stored in PDAs derived from the token mint
      // For now, we'll check the wallet balance change after claiming

      const balanceBefore = await this.connection.getBalance(this.wallet.publicKey);

      // Try to claim via PumpPortal API
      const response = await fetch('https://pumpportal.fun/api/claim-creator-fees', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          publicKey: this.wallet.publicKey.toBase58(),
        }),
      });

      if (!response.ok) {
        // No fees to claim or endpoint not available
        const text = await response.text();
        logger.debug({ status: response.status, text }, 'No pump creator fees to claim');
        return { success: true, source: 'pump_creator', amountSol: 0 };
      }

      // Check balance after
      await new Promise(r => setTimeout(r, 2000));
      const balanceAfter = await this.connection.getBalance(this.wallet.publicKey);
      const amountClaimed = (balanceAfter - balanceBefore) / LAMPORTS_PER_SOL;

      if (amountClaimed > 0) {
        // Log to database
        await repository.insertC100Claim({
          source: 'pump_creator',
          amount_sol: amountClaimed,
          status: 'success',
        });

        // Update stats
        this.stats.totalClaimedSol += amountClaimed;
        this.stats.claimCount++;
        this.stats.sources.pump_creator += amountClaimed;
        this.stats.lastClaimTime = new Date();

        this.emit('claimSuccess', {
          source: 'pump_creator',
          amountSol: amountClaimed,
        });

        logger.info({ amountSol: amountClaimed.toFixed(6) }, 'Pump creator fees claimed');

        return {
          success: true,
          source: 'pump_creator',
          amountSol: amountClaimed,
        };
      }

      return { success: true, source: 'pump_creator', amountSol: 0 };
    } catch (error: any) {
      logger.error({ error: error.message }, 'Failed to claim pump creator fees');
      return {
        success: false,
        source: 'pump_creator',
        amountSol: 0,
        error: error.message,
      };
    }
  }

  getStats(): ClaimStats {
    return { ...this.stats };
  }

  isEnabled(): boolean {
    return config.c100?.autoClaim?.enabled === true;
  }
}

export const rewardClaimer = new RewardClaimer();
