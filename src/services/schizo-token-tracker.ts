/**
 * $SCHIZO Token Tracker
 * Fetches live price data for the $SCHIZO token and broadcasts to dashboard
 */

import { dexscreener, type TokenMetadata } from '../api/dexscreener.js';
import { createLogger } from '../lib/logger.js';
import type { AgentEventEmitter } from '../events/emitter.js';

const logger = createLogger('schizo-token-tracker');

/**
 * Configuration for the tracker
 */
export interface SchizoTokenTrackerConfig {
  tokenMint: string;
  updateIntervalMs: number;
  enabled: boolean;
}

/**
 * Data structure for token card updates
 */
export interface SchizoTokenData {
  ca: string;
  price: number;
  priceChange24h: number;
  priceChange1h: number;
  marketCap: number;
  volume24h: number;
  liquidity: number;
  holders?: number;
  live: boolean;
  dexUrl?: string;
  imageUrl?: string;
}

/**
 * Tracks $SCHIZO token price and broadcasts updates
 */
export class SchizoTokenTracker {
  private config: SchizoTokenTrackerConfig;
  private eventEmitter: AgentEventEmitter;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private lastData: SchizoTokenData | null = null;
  private isLive = false;

  constructor(config: SchizoTokenTrackerConfig, eventEmitter: AgentEventEmitter) {
    this.config = config;
    this.eventEmitter = eventEmitter;
  }

  /**
   * Start periodic tracking
   */
  start(): void {
    if (!this.config.enabled) {
      logger.info('$SCHIZO token tracker disabled');
      return;
    }

    if (!this.config.tokenMint || this.config.tokenMint === 'your-schizo-token-mint-here') {
      logger.info('$SCHIZO token mint not configured yet - tracker waiting for token drop');
      return;
    }

    logger.info({
      mint: this.config.tokenMint,
      intervalMs: this.config.updateIntervalMs
    }, '$SCHIZO token tracker started');

    // Broadcast CA immediately so frontend can show it even if token isn't live yet
    this.broadcastUpdate({
      ca: this.config.tokenMint,
      price: 0,
      priceChange24h: 0,
      priceChange1h: 0,
      marketCap: 0,
      volume24h: 0,
      liquidity: 0,
      live: false,
    });

    // Fetch immediately
    this.fetchAndBroadcast();

    // Then periodically
    this.intervalId = setInterval(() => {
      this.fetchAndBroadcast();
    }, this.config.updateIntervalMs);
  }

  /**
   * Stop tracking
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      logger.info('$SCHIZO token tracker stopped');
    }
  }

  /**
   * Fetch token data and broadcast update
   */
  private async fetchAndBroadcast(): Promise<void> {
    try {
      const metadata = await dexscreener.getTokenMetadata(this.config.tokenMint);

      if (!metadata) {
        // Token not yet on DexScreener (still on pump.fun bonding curve or not launched)
        if (!this.isLive) {
          logger.debug('$SCHIZO token not yet on DexScreener - still bonding or not launched');
        }
        return;
      }

      // Token is live!
      if (!this.isLive) {
        this.isLive = true;
        logger.info({
          price: metadata.priceUsd,
          marketCap: metadata.marketCap
        }, '$SCHIZO token is LIVE on DexScreener!');
      }

      const data: SchizoTokenData = {
        ca: this.config.tokenMint,
        price: metadata.priceUsd,
        priceChange24h: metadata.priceChange24h,
        priceChange1h: metadata.priceChange1h,
        marketCap: metadata.marketCap,
        volume24h: metadata.volume24h,
        liquidity: metadata.liquidity,
        live: true,
        dexUrl: metadata.dexUrl,
        imageUrl: metadata.imageUrl,
      };

      // Only broadcast if data changed meaningfully
      if (this.hasDataChanged(data)) {
        this.lastData = data;
        this.broadcastUpdate(data);
      }
    } catch (error) {
      logger.error({ error }, 'Error fetching $SCHIZO token data');
    }
  }

  /**
   * Check if data changed enough to warrant an update
   */
  private hasDataChanged(newData: SchizoTokenData): boolean {
    if (!this.lastData) return true;

    // Always update if live status changed
    if (this.lastData.live !== newData.live) return true;

    // Check for meaningful price change (> 0.1%)
    const priceChange = Math.abs(newData.price - this.lastData.price) / (this.lastData.price || 1);
    if (priceChange > 0.001) return true;

    // Check for meaningful volume change
    const volumeChange = Math.abs(newData.volume24h - this.lastData.volume24h) / (this.lastData.volume24h || 1);
    if (volumeChange > 0.05) return true;

    // Check for mcap change
    const mcapChange = Math.abs(newData.marketCap - this.lastData.marketCap) / (this.lastData.marketCap || 1);
    if (mcapChange > 0.01) return true;

    return false;
  }

  /**
   * Broadcast token update event
   */
  private broadcastUpdate(data: SchizoTokenData): void {
    this.eventEmitter.emit({
      type: 'SCHIZO_TOKEN_UPDATE' as any,
      timestamp: Date.now(),
      data: data as any,
    });

    logger.debug({
      price: data.price.toFixed(8),
      mcap: data.marketCap.toFixed(0)
    }, '$SCHIZO token update broadcast');
  }

  /**
   * Force a refresh
   */
  async refresh(): Promise<SchizoTokenData | null> {
    await this.fetchAndBroadcast();
    return this.lastData;
  }

  /**
   * Get current token data
   */
  getCurrentData(): SchizoTokenData | null {
    return this.lastData;
  }

  /**
   * Check if token is live
   */
  isTokenLive(): boolean {
    return this.isLive;
  }
}

/**
 * Create tracker with default config from env
 */
export function createSchizoTokenTracker(eventEmitter: AgentEventEmitter): SchizoTokenTracker {
  const config: SchizoTokenTrackerConfig = {
    tokenMint: process.env.SCHIZO_TOKEN_MINT || '',
    updateIntervalMs: parseInt(process.env.SCHIZO_TOKEN_UPDATE_INTERVAL || '10000', 10), // 10s default
    enabled: process.env.SCHIZO_TOKEN_TRACKER_ENABLED !== 'false', // enabled by default
  };

  return new SchizoTokenTracker(config, eventEmitter);
}
