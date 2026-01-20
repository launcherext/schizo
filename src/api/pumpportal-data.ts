/**
 * PumpPortal Data API - WebSocket client for real-time new token events
 * https://pumpportal.fun/data-api/real-time
 */

import WebSocket from 'ws';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('pumpportal-data');

const WS_URL = 'wss://pumpportal.fun/api/data';

/**
 * New token event from PumpPortal
 */
export interface PumpNewTokenEvent {
  mint: string;
  name: string;
  symbol: string;
  uri: string;
  traderPublicKey: string;
  initialBuy: number;
  bondingCurveKey: string;
  vTokensInBondingCurve: number;
  vSolInBondingCurve: number;
  marketCapSol: number;
  signature: string;
  imageUrl?: string; // Fetched from metadata URI
}

/**
 * Fetch token image from metadata URI
 */
async function fetchTokenImage(uri: string): Promise<string | undefined> {
  if (!uri) return undefined;

  try {
    // Handle IPFS URIs
    let fetchUrl = uri;
    if (uri.startsWith('ipfs://')) {
      fetchUrl = uri.replace('ipfs://', 'https://ipfs.io/ipfs/');
    }

    const response = await fetch(fetchUrl, {
      signal: AbortSignal.timeout(3000) // 3 second timeout
    });

    if (!response.ok) return undefined;

    const metadata = await response.json();
    let imageUrl = metadata.image || metadata.imageUrl;

    // Convert IPFS image URLs too
    if (imageUrl?.startsWith('ipfs://')) {
      imageUrl = imageUrl.replace('ipfs://', 'https://ipfs.io/ipfs/');
    }

    return imageUrl;
  } catch (error) {
    // Silently fail - image is optional
    return undefined;
  }
}

/**
 * Trade event from PumpPortal
 */
export interface PumpTradeEvent {
  mint: string;
  traderPublicKey: string;
  txType: 'buy' | 'sell';
  tokenAmount: number;
  solAmount: number;
  bondingCurveKey: string;
  vTokensInBondingCurve: number;
  vSolInBondingCurve: number;
  marketCapSol: number;
  signature: string;
}

/**
 * Callback types
 */
type NewTokenCallback = (token: PumpNewTokenEvent) => void;
type TradeCallback = (trade: PumpTradeEvent) => void;

/**
 * PumpPortal Data WebSocket Client
 */
export class PumpPortalDataClient {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectDelayMs = 5000;
  private isConnected = false;

  private newTokenCallbacks: NewTokenCallback[] = [];
  private tradeCallbacks: Map<string, TradeCallback[]> = new Map();
  private subscribedTokens: Set<string> = new Set();

  /**
   * Connect to PumpPortal WebSocket
   */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.isConnected && this.ws) {
        resolve();
        return;
      }

      logger.info('Connecting to PumpPortal WebSocket...');

      this.ws = new WebSocket(WS_URL);

      this.ws.on('open', () => {
        logger.info('Connected to PumpPortal WebSocket');
        this.isConnected = true;
        this.reconnectAttempts = 0;
        resolve();
      });

      this.ws.on('message', (data: WebSocket.Data) => {
        try {
          const message = JSON.parse(data.toString());
          this.handleMessage(message);
        } catch (error) {
          logger.error({ error }, 'Error parsing WebSocket message');
        }
      });

      this.ws.on('close', () => {
        logger.warn('PumpPortal WebSocket disconnected');
        this.isConnected = false;
        this.attemptReconnect();
      });

      this.ws.on('error', (error) => {
        logger.error({ error }, 'PumpPortal WebSocket error');
        if (!this.isConnected) {
          reject(error);
        }
      });
    });
  }

  /**
   * Attempt to reconnect
   */
  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.error('Max reconnect attempts reached');
      return;
    }

    this.reconnectAttempts++;
    logger.info({ attempt: this.reconnectAttempts }, 'Attempting to reconnect...');

    setTimeout(async () => {
      try {
        await this.connect();

        // Re-subscribe to new tokens
        if (this.newTokenCallbacks.length > 0) {
          this.subscribeNewTokens();
        }

        // Re-subscribe to token trades
        if (this.subscribedTokens.size > 0) {
          this.subscribeTokenTrades(Array.from(this.subscribedTokens));
        }
      } catch (error) {
        logger.error({ error }, 'Reconnect failed');
      }
    }, this.reconnectDelayMs);
  }

  /**
   * Handle incoming message
   */
  private async handleMessage(message: any): Promise<void> {
    // Check if it's a new token creation event (txType === 'create')
    if (message.txType === 'create' && message.mint && message.bondingCurveKey) {
      // This is a new token creation event
      const tokenEvent: PumpNewTokenEvent = {
        mint: message.mint,
        name: message.name || 'Unknown',
        symbol: message.symbol || 'UNK',
        uri: message.uri || '',
        traderPublicKey: message.traderPublicKey || '',
        initialBuy: message.initialBuy || 0,
        bondingCurveKey: message.bondingCurveKey,
        vTokensInBondingCurve: message.vTokensInBondingCurve || 0,
        vSolInBondingCurve: message.vSolInBondingCurve || 0,
        marketCapSol: message.marketCapSol || 0,
        signature: message.signature || '',
      };

      // Fetch image from metadata URI (with short timeout)
      if (message.uri) {
        try {
          const imageUrl = await fetchTokenImage(message.uri);
          if (imageUrl) {
            tokenEvent.imageUrl = imageUrl;
          }
        } catch {
          // Ignore image fetch errors
        }
      }

      logger.info({
        mint: tokenEvent.mint,
        symbol: tokenEvent.symbol,
        name: tokenEvent.name,
        marketCapSol: tokenEvent.marketCapSol,
        hasImage: !!tokenEvent.imageUrl,
      }, 'New token detected!');

      // Notify all callbacks
      for (const callback of this.newTokenCallbacks) {
        try {
          callback(tokenEvent);
        } catch (error) {
          logger.error({ error }, 'Error in new token callback');
        }
      }
    }

    // Check if it's a trade event
    if (message.txType && (message.txType === 'buy' || message.txType === 'sell')) {
      const tradeEvent: PumpTradeEvent = {
        mint: message.mint,
        traderPublicKey: message.traderPublicKey || '',
        txType: message.txType,
        tokenAmount: message.tokenAmount || 0,
        solAmount: message.solAmount || 0,
        bondingCurveKey: message.bondingCurveKey || '',
        vTokensInBondingCurve: message.vTokensInBondingCurve || 0,
        vSolInBondingCurve: message.vSolInBondingCurve || 0,
        marketCapSol: message.marketCapSol || 0,
        signature: message.signature || '',
      };

      // Notify callbacks for this specific token
      const callbacks = this.tradeCallbacks.get(message.mint);
      if (callbacks) {
        for (const callback of callbacks) {
          try {
            callback(tradeEvent);
          } catch (error) {
            logger.error({ error }, 'Error in trade callback');
          }
        }
      }
    }
  }

  /**
   * Subscribe to new token creation events
   */
  subscribeNewTokens(): void {
    if (!this.ws || !this.isConnected) {
      logger.warn('Cannot subscribe - not connected');
      return;
    }

    const payload = {
      method: 'subscribeNewToken',
    };

    this.ws.send(JSON.stringify(payload));
    logger.info('Subscribed to new token events');
  }

  /**
   * Subscribe to trades for specific tokens
   */
  subscribeTokenTrades(mints: string[]): void {
    if (!this.ws || !this.isConnected) {
      logger.warn('Cannot subscribe - not connected');
      return;
    }

    const payload = {
      method: 'subscribeTokenTrade',
      keys: mints,
    };

    this.ws.send(JSON.stringify(payload));

    // Track subscribed tokens
    for (const mint of mints) {
      this.subscribedTokens.add(mint);
    }

    logger.info({ count: mints.length }, 'Subscribed to token trades');
  }

  /**
   * Register callback for new token events
   */
  onNewToken(callback: NewTokenCallback): void {
    this.newTokenCallbacks.push(callback);
  }

  /**
   * Register callback for trade events on a specific token
   */
  onTrade(mint: string, callback: TradeCallback): void {
    if (!this.tradeCallbacks.has(mint)) {
      this.tradeCallbacks.set(mint, []);
    }
    this.tradeCallbacks.get(mint)!.push(callback);
  }

  /**
   * Disconnect
   */
  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.isConnected = false;
  }

  /**
   * Check if connected
   */
  get connected(): boolean {
    return this.isConnected;
  }
}

// Singleton instance
export const pumpPortalData = new PumpPortalDataClient();
