import { EventEmitter } from 'events';
import { createChildLogger } from '../utils/logger';
import { config } from '../config/settings';

const logger = createChildLogger('rug-monitor');

interface WatchedPosition {
  mint: string;
  creator: string;
  entryTime: Date;
  entryPrice: number;
  entryMarketCapSol: number;

  // Trading activity tracking
  sellCount: number;
  buyCount: number;
  totalSellVolume: number;    // Token amount sold
  creatorSellCount: number;
  creatorTotalSold: number;   // Token amount creator sold
  largestSingleSell: number;  // Largest single sell in tokens
  largestSellerWallet: string;

  // Price tracking (from PumpPortal trades)
  highestPrice: number;
  currentPrice: number;
  priceAtLastCheck: number;
}

export interface RugWarning {
  mint: string;
  type: 'creator_sell' | 'large_dump' | 'sell_pressure' | 'price_crash';
  severity: 'warning' | 'critical';
  message: string;
  details: {
    [key: string]: number | string;
  };
  timestamp: Date;
}

export class RugMonitor extends EventEmitter {
  private watchedPositions: Map<string, WatchedPosition> = new Map();
  private recentWarnings: Map<string, RugWarning[]> = new Map();

  constructor() {
    super();
  }

  /**
   * Start watching a position for rug signals
   */
  watchPosition(params: {
    mint: string;
    creator: string;
    entryPrice: number;
    entryMarketCapSol: number;
  }): void {
    const { mint, creator, entryPrice, entryMarketCapSol } = params;

    if (this.watchedPositions.has(mint)) {
      logger.debug({ mint }, 'Position already being watched');
      return;
    }

    const position: WatchedPosition = {
      mint,
      creator,
      entryTime: new Date(),
      entryPrice,
      entryMarketCapSol,
      sellCount: 0,
      buyCount: 0,
      totalSellVolume: 0,
      creatorSellCount: 0,
      creatorTotalSold: 0,
      largestSingleSell: 0,
      largestSellerWallet: '',
      highestPrice: entryPrice,
      currentPrice: entryPrice,
      priceAtLastCheck: entryPrice,
    };

    this.watchedPositions.set(mint, position);
    this.recentWarnings.set(mint, []);

    logger.info({
      mint: mint.substring(0, 12) + '...',
      creator: creator.substring(0, 12) + '...',
      entryPrice: entryPrice.toExponential(4),
      marketCapSol: entryMarketCapSol.toFixed(2),
    }, 'Rug monitor: Watching position');
  }

  /**
   * Stop watching a position
   */
  unwatchPosition(mint: string): void {
    this.watchedPositions.delete(mint);
    this.recentWarnings.delete(mint);
    logger.debug({ mint: mint.substring(0, 12) + '...' }, 'Rug monitor: Stopped watching');
  }

  /**
   * Process a trade event from PumpPortal
   */
  processTrade(data: {
    mint: string;
    txType: 'buy' | 'sell';
    traderPublicKey: string;
    tokenAmount: number;
    marketCapSol: number;
    priceSol: number;
  }): void {
    const position = this.watchedPositions.get(data.mint);
    if (!position) return;

    // Update price tracking
    position.currentPrice = data.priceSol;
    if (data.priceSol > position.highestPrice) {
      position.highestPrice = data.priceSol;
    }

    if (data.txType === 'buy') {
      position.buyCount++;
      return; // Buys are good, no rug signals
    }

    // It's a sell - analyze for rug signals
    position.sellCount++;
    position.totalSellVolume += data.tokenAmount;

    // Track largest single sell
    if (data.tokenAmount > position.largestSingleSell) {
      position.largestSingleSell = data.tokenAmount;
      position.largestSellerWallet = data.traderPublicKey;
    }

    // CHECK 1: Creator selling
    if (data.traderPublicKey === position.creator) {
      position.creatorSellCount++;
      position.creatorTotalSold += data.tokenAmount;

      this.emitWarning({
        mint: data.mint,
        type: 'creator_sell',
        severity: position.creatorSellCount >= 2 ? 'critical' : 'warning',
        message: `Creator sold ${data.tokenAmount.toLocaleString()} tokens (sell #${position.creatorSellCount})`,
        details: {
          creatorWallet: data.traderPublicKey.substring(0, 12) + '...',
          tokensSold: data.tokenAmount,
          totalCreatorSold: position.creatorTotalSold,
          sellCount: position.creatorSellCount,
        },
      });
    }

    // CHECK 2: Large single dump (>5% of market cap equivalent)
    const sellValueSol = data.tokenAmount * data.priceSol;
    const dumpPercent = (sellValueSol / data.marketCapSol) * 100;

    if (dumpPercent > 5) {
      this.emitWarning({
        mint: data.mint,
        type: 'large_dump',
        severity: dumpPercent > 10 ? 'critical' : 'warning',
        message: `Large sell: ${dumpPercent.toFixed(1)}% of market cap dumped`,
        details: {
          sellerWallet: data.traderPublicKey.substring(0, 12) + '...',
          tokensSold: data.tokenAmount,
          sellValueSol: sellValueSol.toFixed(4),
          dumpPercent: dumpPercent,
        },
      });
    }

    // CHECK 3: Sell pressure (more sells than buys in recent window)
    const totalTrades = position.buyCount + position.sellCount;
    if (totalTrades >= 5) {  // Need minimum trades for meaningful ratio
      const sellRatio = position.sellCount / totalTrades;

      if (sellRatio > 0.6) {  // >60% sells
        this.emitWarning({
          mint: data.mint,
          type: 'sell_pressure',
          severity: sellRatio > 0.75 ? 'critical' : 'warning',
          message: `High sell pressure: ${(sellRatio * 100).toFixed(0)}% sells`,
          details: {
            buyCount: position.buyCount,
            sellCount: position.sellCount,
            sellRatio: sellRatio,
          },
        });
      }
    }

    // CHECK 4: Price crash from high (>30% drop from peak)
    if (position.highestPrice > position.entryPrice) {  // Only if it went up first
      const dropFromHigh = ((position.highestPrice - data.priceSol) / position.highestPrice) * 100;

      if (dropFromHigh > 30) {
        this.emitWarning({
          mint: data.mint,
          type: 'price_crash',
          severity: dropFromHigh > 50 ? 'critical' : 'warning',
          message: `Price crashed ${dropFromHigh.toFixed(0)}% from high`,
          details: {
            highestPrice: position.highestPrice,
            currentPrice: data.priceSol,
            dropPercent: dropFromHigh,
            currentGainPercent: ((data.priceSol - position.entryPrice) / position.entryPrice) * 100,
          },
        });
      }
    }

    position.priceAtLastCheck = data.priceSol;
  }

  /**
   * Emit a rug warning
   */
  private emitWarning(warning: Omit<RugWarning, 'timestamp'>): void {
    const fullWarning: RugWarning = {
      ...warning,
      timestamp: new Date(),
    };

    // Store warning
    const warnings = this.recentWarnings.get(warning.mint) || [];
    warnings.push(fullWarning);

    // Keep only last 10 warnings per token
    if (warnings.length > 10) {
      warnings.shift();
    }
    this.recentWarnings.set(warning.mint, warnings);

    // Log it
    const logData = {
      mint: warning.mint.substring(0, 12) + '...',
      type: warning.type,
      severity: warning.severity,
      ...warning.details,
    };

    if (warning.severity === 'critical') {
      logger.error(logData, `RUG ALERT: ${warning.message}`);
    } else {
      logger.warn(logData, `Rug warning: ${warning.message}`);
    }

    // Emit event for position manager
    this.emit('rugWarning', fullWarning);

    // Critical warnings get special emission
    if (warning.severity === 'critical') {
      this.emit('rugAlert', fullWarning);
    }
  }

  /**
   * Check if a position should be exited based on rug signals
   */
  shouldExit(mint: string): { shouldExit: boolean; reason: string } {
    const warnings = this.recentWarnings.get(mint) || [];
    const position = this.watchedPositions.get(mint);

    if (!position) {
      return { shouldExit: false, reason: '' };
    }

    // Exit immediately on creator sell
    const creatorSells = warnings.filter(w => w.type === 'creator_sell');
    if (creatorSells.length > 0) {
      return {
        shouldExit: true,
        reason: `Creator sold (${position.creatorSellCount} times, ${position.creatorTotalSold.toLocaleString()} tokens)`
      };
    }

    // Exit on multiple critical warnings
    const criticalWarnings = warnings.filter(w =>
      w.severity === 'critical' &&
      Date.now() - w.timestamp.getTime() < 60000  // Last minute
    );

    if (criticalWarnings.length >= 2) {
      return {
        shouldExit: true,
        reason: `Multiple critical warnings: ${criticalWarnings.map(w => w.type).join(', ')}`,
      };
    }

    // Exit on large dump + price crash combo
    const recentLargeDump = warnings.find(w =>
      w.type === 'large_dump' &&
      w.severity === 'critical' &&
      Date.now() - w.timestamp.getTime() < 30000
    );
    const recentCrash = warnings.find(w =>
      w.type === 'price_crash' &&
      Date.now() - w.timestamp.getTime() < 30000
    );

    if (recentLargeDump && recentCrash) {
      return {
        shouldExit: true,
        reason: 'Large dump followed by price crash - likely rug',
      };
    }

    return { shouldExit: false, reason: '' };
  }

  /**
   * Get warnings for a position
   */
  getWarnings(mint: string): RugWarning[] {
    return this.recentWarnings.get(mint) || [];
  }

  /**
   * Get watched position stats
   */
  getPositionStats(mint: string): WatchedPosition | null {
    return this.watchedPositions.get(mint) || null;
  }

  /**
   * Get all watched positions
   */
  getWatchedMints(): string[] {
    return Array.from(this.watchedPositions.keys());
  }
}

export const rugMonitor = new RugMonitor();
