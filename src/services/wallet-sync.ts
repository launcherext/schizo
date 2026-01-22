import { EventEmitter } from 'events';
import { createChildLogger } from '../utils/logger';
import { txManager } from '../execution/tx-manager';
import { positionManager } from '../risk/position-manager';
import { repository } from '../db/repository';

const logger = createChildLogger('wallet-sync');

export interface WalletState {
  solBalance: number;
  tokenBalances: Map<string, number>;
  lastSync: Date;
}

export interface TokenDiscrepancy {
  mint: string;
  positionId: string;
  expectedAmount: number;
  actualAmount: number;
  difference: number;
  percentDiff: number;
}

export interface SyncResult {
  solBalance: number;
  tokenPositions: { mint: string; expected: number; actual: number }[];
  discrepancies: TokenDiscrepancy[];
  syncTime: Date;
}

export class WalletSync extends EventEmitter {
  private syncInterval: NodeJS.Timeout | null = null;
  private lastState: WalletState | null = null;
  private isRunning = false;

  constructor() {
    super();
  }

  async start(intervalMs: number = 30000): Promise<void> {
    if (this.isRunning) {
      logger.warn('Wallet sync already running');
      return;
    }

    this.isRunning = true;

    // Initial sync
    await this.sync();

    // Start periodic sync
    this.syncInterval = setInterval(async () => {
      try {
        await this.sync();
      } catch (error) {
        logger.error({ error }, 'Wallet sync failed');
      }
    }, intervalMs);

    logger.info({ intervalMs }, 'Wallet sync started');
  }

  stop(): void {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }
    this.isRunning = false;
    logger.info('Wallet sync stopped');
  }

  async sync(): Promise<SyncResult> {
    const syncTime = new Date();

    // Get actual SOL balance from wallet
    const solBalance = await txManager.getWalletBalance();

    // Get all open positions
    const positions = positionManager.getOpenPositions();

    // Get actual token balances for each position
    const tokenPositions: { mint: string; expected: number; actual: number }[] = [];
    const discrepancies: TokenDiscrepancy[] = [];
    const tokenBalances = new Map<string, number>();

    for (const position of positions) {
      const actualBalance = await txManager.getTokenBalance(position.mint);
      tokenBalances.set(position.mint, actualBalance);

      const expected = position.amount;
      const actual = actualBalance;

      tokenPositions.push({
        mint: position.mint,
        expected,
        actual,
      });

      // Check for significant discrepancy (more than 1% or position amount is 0)
      const difference = actual - expected;
      const percentDiff = expected > 0 ? (difference / expected) * 100 : (actual === 0 ? -100 : 100);

      if (Math.abs(percentDiff) > 1 || (expected > 0 && actual === 0)) {
        const discrepancy: TokenDiscrepancy = {
          mint: position.mint,
          positionId: position.id,
          expectedAmount: expected,
          actualAmount: actual,
          difference,
          percentDiff,
        };

        discrepancies.push(discrepancy);

        logger.warn({
          mint: position.mint.substring(0, 15),
          positionId: position.id,
          expected: expected.toFixed(4),
          actual: actual.toFixed(4),
          percentDiff: percentDiff.toFixed(2),
        }, 'Token balance discrepancy detected');

        // AUTO-CLOSE GHOST POSITIONS: If actual balance is 0 but we expect tokens,
        // the position is a "ghost" - close it immediately to stop sell loops
        if (actual === 0 && expected > 0) {
          logger.warn({
            positionId: position.id,
            mint: position.mint.substring(0, 15),
            expectedAmount: expected,
          }, 'Ghost position detected (0 tokens on-chain) - auto-closing');

          // Close the ghost position - this will mark it as closed without trying to sell
          try {
            await positionManager.closeGhostPosition(position.id);
            logger.info({ positionId: position.id }, 'Ghost position closed successfully');
          } catch (err) {
            logger.error({ positionId: position.id, error: err }, 'Failed to close ghost position');
          }
        }
      }
    }

    // Update state
    this.lastState = {
      solBalance,
      tokenBalances,
      lastSync: syncTime,
    };

    // Log to database
    await repository.insertWalletSyncLog({
      sol_balance: solBalance,
      token_positions_json: JSON.stringify(tokenPositions),
      discrepancies_json: JSON.stringify(discrepancies),
    });

    // Emit events
    this.emit('synced', { solBalance, tokenPositions, discrepancies, syncTime });

    if (discrepancies.length > 0) {
      this.emit('discrepancies', discrepancies);
    }

    logger.debug({
      solBalance: solBalance.toFixed(4),
      positionCount: positions.length,
      discrepancyCount: discrepancies.length,
    }, 'Wallet synced');

    return {
      solBalance,
      tokenPositions,
      discrepancies,
      syncTime,
    };
  }

  getState(): WalletState | null {
    return this.lastState;
  }

  getSolBalance(): number {
    return this.lastState?.solBalance || 0;
  }

  getTokenBalance(mint: string): number {
    return this.lastState?.tokenBalances.get(mint) || 0;
  }

  getLastSyncTime(): Date | null {
    return this.lastState?.lastSync || null;
  }

  isHealthy(): boolean {
    if (!this.lastState) return false;

    // Check if last sync was within 2 minutes
    const timeSinceSync = Date.now() - this.lastState.lastSync.getTime();
    return timeSinceSync < 120000;
  }
}

export const walletSync = new WalletSync();
