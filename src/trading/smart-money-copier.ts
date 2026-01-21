/**
 * Smart Money Copy Trader - Proactively watches wallets and copies their trades
 *
 * Instead of: "New token detected → check smart money"
 * This does: "Smart money bought → we buy"
 *
 * Monitors a curated list of proven profitable wallets and mirrors their trades.
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { createLogger } from '../lib/logger.js';
import { HeliusClient } from '../api/helius.js';
import { agentEvents } from '../events/emitter.js';

const logger = createLogger('smart-money-copier');

/**
 * A tracked wallet with performance metrics
 */
export interface TrackedWallet {
  address: string;
  label?: string;          // e.g., "Whale #1", "Top Trader"
  pnlSol: number;          // Historical profit in SOL
  winRate: number;         // 0-1
  avgHoldTime: number;     // Average hold time in ms
  lastUpdated: number;     // When metrics were last updated
  isActive: boolean;       // Currently monitoring
  totalTrades: number;
  recentTrades: WalletTrade[];
}

/**
 * A trade made by a tracked wallet
 */
export interface WalletTrade {
  signature: string;
  timestamp: number;
  tokenMint: string;
  tokenSymbol?: string;
  type: 'buy' | 'sell';
  solAmount: number;
  tokenAmount: number;
  pricePerToken: number;
}

/**
 * Copy trade signal emitted when smart money buys
 */
export interface CopyTradeSignal {
  wallet: TrackedWallet;
  trade: WalletTrade;
  confidence: number;      // 0-100 based on wallet metrics
  suggestedSize: number;   // Suggested position in SOL
  reasons: string[];
}

/**
 * Configuration for the copy trader
 */
export interface SmartMoneyCopierConfig {
  /** Minimum wallet PnL to copy (SOL) */
  minWalletPnl: number;
  /** Minimum wallet win rate to copy */
  minWinRate: number;
  /** Maximum age of trade to copy (ms) - don't copy old trades */
  maxTradeAge: number;
  /** Poll interval for checking wallet activity (ms) */
  pollIntervalMs: number;
  /** Maximum position size when copying (SOL) */
  maxCopySize: number;
  /** Minimum position size (SOL) */
  minCopySize: number;
  /** Scale position by wallet confidence */
  scaleByConfidence: boolean;
}

const DEFAULT_CONFIG: SmartMoneyCopierConfig = {
  minWalletPnl: 10,           // 10 SOL minimum profit
  minWinRate: 0.5,            // 50% win rate
  maxTradeAge: 60000,         // 1 minute - must be fast
  pollIntervalMs: 5000,       // Check every 5 seconds
  maxCopySize: 0.1,           // 0.1 SOL max per copy
  minCopySize: 0.01,          // 0.01 SOL min
  scaleByConfidence: true,
};

/**
 * Smart Money Copy Trader
 *
 * Watches a list of profitable wallets and emits signals when they trade.
 */
export class SmartMoneyCopier {
  private config: SmartMoneyCopierConfig;
  private helius: HeliusClient;
  private trackedWallets: Map<string, TrackedWallet> = new Map();
  private lastSeenSignatures: Map<string, string> = new Map(); // wallet -> last sig
  private isRunning = false;
  private pollInterval?: NodeJS.Timeout;
  private onSignalCallbacks: ((signal: CopyTradeSignal) => void)[] = [];

  constructor(helius: HeliusClient, config?: Partial<SmartMoneyCopierConfig>) {
    this.helius = helius;
    this.config = { ...DEFAULT_CONFIG, ...config };

    logger.info({ config: this.config }, 'SmartMoneyCopier initialized');
  }

  /**
   * Add a wallet to track.
   */
  addWallet(wallet: Omit<TrackedWallet, 'recentTrades' | 'lastUpdated' | 'isActive'>): void {
    const tracked: TrackedWallet = {
      ...wallet,
      recentTrades: [],
      lastUpdated: Date.now(),
      isActive: true,
    };

    this.trackedWallets.set(wallet.address, tracked);
    logger.info({ wallet: wallet.address, label: wallet.label }, 'Added wallet to tracking');
  }

  /**
   * Add multiple wallets at once.
   */
  addWallets(wallets: Omit<TrackedWallet, 'recentTrades' | 'lastUpdated' | 'isActive'>[]): void {
    for (const wallet of wallets) {
      this.addWallet(wallet);
    }
  }

  /**
   * Remove a wallet from tracking.
   */
  removeWallet(address: string): void {
    this.trackedWallets.delete(address);
    this.lastSeenSignatures.delete(address);
    logger.info({ wallet: address }, 'Removed wallet from tracking');
  }

  /**
   * Get all tracked wallets.
   */
  getTrackedWallets(): TrackedWallet[] {
    return Array.from(this.trackedWallets.values());
  }

  /**
   * Register callback for copy trade signals.
   */
  onSignal(callback: (signal: CopyTradeSignal) => void): void {
    this.onSignalCallbacks.push(callback);
  }

  /**
   * Start monitoring wallets.
   */
  start(): void {
    if (this.isRunning) {
      logger.warn('SmartMoneyCopier already running');
      return;
    }

    this.isRunning = true;

    // Initialize last seen signatures
    this.initializeLastSeen().then(() => {
      // Start polling
      this.pollInterval = setInterval(() => {
        this.checkAllWallets();
      }, this.config.pollIntervalMs);

      logger.info({
        walletCount: this.trackedWallets.size,
        pollInterval: this.config.pollIntervalMs,
      }, 'SmartMoneyCopier started');
    });
  }

  /**
   * Stop monitoring.
   */
  stop(): void {
    this.isRunning = false;

    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = undefined;
    }

    logger.info('SmartMoneyCopier stopped');
  }

  /**
   * Initialize last seen signatures to avoid copying old trades on startup.
   */
  private async initializeLastSeen(): Promise<void> {
    const wallets = Array.from(this.trackedWallets.keys());

    for (const address of wallets) {
      try {
        const txs = await this.helius.getTransactionsForAddress(address, { limit: 1 });

        if (txs.data.length > 0) {
          this.lastSeenSignatures.set(address, txs.data[0].signature);
        }
      } catch (error) {
        logger.warn({ address, error }, 'Failed to initialize last seen for wallet');
      }

      // Small delay to avoid rate limits
      await this.sleep(200);
    }

    logger.info({ initialized: wallets.length }, 'Initialized last seen signatures');
  }

  /**
   * Check all wallets for new trades.
   */
  private async checkAllWallets(): Promise<void> {
    const wallets = Array.from(this.trackedWallets.entries())
      .filter(([_, w]) => w.isActive);

    for (const [address, wallet] of wallets) {
      try {
        await this.checkWallet(address, wallet);
      } catch (error) {
        logger.warn({ address, error }, 'Error checking wallet');
      }

      // Small delay between wallets
      await this.sleep(100);
    }
  }

  /**
   * Check a single wallet for new trades.
   */
  private async checkWallet(address: string, wallet: TrackedWallet): Promise<void> {
    const lastSeen = this.lastSeenSignatures.get(address);
    const txs = await this.helius.getTransactionsForAddress(address, { limit: 10 });

    if (txs.data.length === 0) return;

    // Find new transactions (since last seen)
    const newTxs = lastSeen
      ? txs.data.filter(tx => tx.signature !== lastSeen).slice(0, 5) // Max 5 new
      : [];

    // Update last seen
    this.lastSeenSignatures.set(address, txs.data[0].signature);

    // Process new transactions
    for (const tx of newTxs) {
      // Check if it's a buy (we only copy buys)
      const trade = await this.parseTradeFromTransaction(tx, address);

      if (trade && trade.type === 'buy') {
        // Check trade age
        const age = Date.now() - trade.timestamp;
        if (age > this.config.maxTradeAge) {
          logger.debug({ address, age }, 'Trade too old to copy');
          continue;
        }

        // Generate signal
        const signal = this.generateSignal(wallet, trade);

        if (signal) {
          this.emitSignal(signal);
        }
      }
    }
  }

  /**
   * Parse a trade from a raw transaction.
   * This is simplified - would need enhanced parsing for accuracy.
   */
  private async parseTradeFromTransaction(
    tx: { signature: string; timestamp: number; type: string; success: boolean },
    walletAddress: string
  ): Promise<WalletTrade | null> {
    // Skip failed transactions
    if (!tx.success) return null;

    // For now, we'll emit a simplified trade
    // In production, you'd parse the actual transaction to get token/amount
    // This would use Helius Enhanced API or parsed transactions

    // Placeholder - would need actual parsing
    return null;
  }

  /**
   * Generate a copy trade signal.
   */
  private generateSignal(wallet: TrackedWallet, trade: WalletTrade): CopyTradeSignal | null {
    // Check wallet meets criteria
    if (wallet.pnlSol < this.config.minWalletPnl) {
      return null;
    }

    if (wallet.winRate < this.config.minWinRate) {
      return null;
    }

    // Calculate confidence (0-100)
    const confidence = this.calculateConfidence(wallet);

    // Calculate suggested position size
    let suggestedSize = this.config.maxCopySize;

    if (this.config.scaleByConfidence) {
      // Scale by confidence: 50% confidence = 50% of max size
      suggestedSize = this.config.minCopySize +
        (this.config.maxCopySize - this.config.minCopySize) * (confidence / 100);
    }

    // Build reasons
    const reasons: string[] = [];

    if (wallet.winRate >= 0.7) {
      reasons.push(`High win rate: ${(wallet.winRate * 100).toFixed(0)}%`);
    }

    if (wallet.pnlSol >= 50) {
      reasons.push(`High PnL: ${wallet.pnlSol.toFixed(1)} SOL`);
    }

    if (wallet.totalTrades >= 100) {
      reasons.push(`Experienced: ${wallet.totalTrades} trades`);
    }

    return {
      wallet,
      trade,
      confidence,
      suggestedSize,
      reasons,
    };
  }

  /**
   * Calculate confidence score for a wallet.
   */
  private calculateConfidence(wallet: TrackedWallet): number {
    let score = 0;

    // Win rate (0-40 points)
    score += Math.min(40, wallet.winRate * 50);

    // PnL (0-30 points)
    const pnlScore = Math.min(30, (wallet.pnlSol / 100) * 30);
    score += pnlScore;

    // Trade count (0-20 points) - more trades = more reliable
    const tradeScore = Math.min(20, (wallet.totalTrades / 100) * 20);
    score += tradeScore;

    // Recency bonus (0-10 points) - recently active
    const hoursSinceUpdate = (Date.now() - wallet.lastUpdated) / (1000 * 60 * 60);
    if (hoursSinceUpdate < 24) {
      score += 10;
    } else if (hoursSinceUpdate < 72) {
      score += 5;
    }

    return Math.min(100, Math.round(score));
  }

  /**
   * Emit a signal to all listeners.
   */
  private emitSignal(signal: CopyTradeSignal): void {
    logger.info({
      wallet: signal.wallet.address,
      token: signal.trade.tokenMint,
      confidence: signal.confidence,
      suggestedSize: signal.suggestedSize,
    }, 'COPY TRADE SIGNAL');

    // Emit via event system (using proper event format)
    agentEvents.emit({
      type: 'COPY_TRADE_SIGNAL',
      timestamp: Date.now(),
      data: {
        mint: signal.trade.tokenMint,
        sourceWallet: signal.wallet.address,
        signature: signal.trade.signature,
        solSpent: signal.trade.solAmount,
      },
    });

    // Call registered callbacks
    for (const callback of this.onSignalCallbacks) {
      try {
        callback(signal);
      } catch (error) {
        logger.error({ error }, 'Error in signal callback');
      }
    }
  }

  /**
   * Utility sleep function.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get copier statistics.
   */
  getStats(): {
    trackedWallets: number;
    activeWallets: number;
    isRunning: boolean;
  } {
    const wallets = Array.from(this.trackedWallets.values());
    return {
      trackedWallets: wallets.length,
      activeWallets: wallets.filter(w => w.isActive).length,
      isRunning: this.isRunning,
    };
  }
}
