import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { createChildLogger } from '../utils/logger';

const logger = createChildLogger('pumpportal-ws');

const PUMPPORTAL_WS_URL = 'wss://pumpportal.fun/api/data';

// Response from subscribeNewToken
export interface PumpPortalNewToken {
  mint: string;
  bondingCurveKey: string;
  traderPublicKey: string;
  marketCapSol: number;
  vSolInBondingCurve: number;
  vTokensInBondingCurve: number;
  initialBuy: number;
  signature: string;
  txType: 'create';
}

// Response from subscribeTokenTrade
export interface PumpPortalTrade {
  mint: string;
  bondingCurveKey: string;
  traderPublicKey: string;
  marketCapSol: number;
  vSolInBondingCurve: number;
  vTokensInBondingCurve: number;
  tokenAmount: number;
  newTokenBalance: number;
  signature: string;
  txType: 'buy' | 'sell';
}

// Calculated bonding curve data
export interface BondingCurveData {
  mint: string;
  marketCapSol: number;
  vSolInBondingCurve: number;
  vTokensInBondingCurve: number;
  priceSol: number;
  liquiditySol: number;
  bondingCurveKey: string;
  isGraduated: boolean;
  timestamp: Date;
}

export class PumpPortalWs extends EventEmitter {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectDelay = 5000;
  private isConnected = false;
  private subscribedTokens: Set<string> = new Set();

  // Cache for bonding curve data
  private bondingCurveCache: Map<string, BondingCurveData> = new Map();
  private cacheExpiry = 120000; // 2 minutes instead of 30 seconds

  constructor() {
    super();
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        logger.info({ url: PUMPPORTAL_WS_URL }, 'Connecting to PumpPortal WebSocket');

        this.ws = new WebSocket(PUMPPORTAL_WS_URL);

        this.ws.on('open', () => {
          logger.info('PumpPortal WebSocket connected');
          this.isConnected = true;
          this.reconnectAttempts = 0;

          // Subscribe to new token events
          this.subscribeNewTokens();

          resolve();
        });

        this.ws.on('message', (data: WebSocket.Data) => {
          this.handleMessage(data);
        });

        this.ws.on('error', (error) => {
          logger.error({ error }, 'PumpPortal WebSocket error');
          if (!this.isConnected) {
            reject(error);
          }
        });

        this.ws.on('close', () => {
          logger.warn('PumpPortal WebSocket disconnected');
          this.isConnected = false;
          this.handleReconnect();
        });

      } catch (error) {
        logger.error({ error }, 'Failed to connect to PumpPortal');
        reject(error);
      }
    });
  }

  private subscribeNewTokens(): void {
    if (!this.ws || !this.isConnected) return;

    const payload = { method: 'subscribeNewToken' };
    this.ws.send(JSON.stringify(payload));
    logger.info('Subscribed to PumpPortal new token events');
  }

  subscribeToToken(mint: string): void {
    if (!this.ws || !this.isConnected) return;
    if (this.subscribedTokens.has(mint)) return;

    const payload = {
      method: 'subscribeTokenTrade',
      keys: [mint]
    };
    this.ws.send(JSON.stringify(payload));
    this.subscribedTokens.add(mint);
    logger.debug({ mint }, 'Subscribed to token trades');
  }

  unsubscribeFromToken(mint: string): void {
    if (!this.ws || !this.isConnected) return;
    if (!this.subscribedTokens.has(mint)) return;

    const payload = {
      method: 'unsubscribeTokenTrade',
      keys: [mint]
    };
    this.ws.send(JSON.stringify(payload));
    this.subscribedTokens.delete(mint);
    this.bondingCurveCache.delete(mint);
    logger.debug({ mint }, 'Unsubscribed from token trades');
  }

  private handleMessage(data: WebSocket.Data): void {
    try {
      const message = JSON.parse(data.toString());

      // Handle new token creation
      if (message.txType === 'create') {
        const tokenData = message as PumpPortalNewToken;
        const curveData = this.processBondingCurveData(tokenData);

        logger.info({
          mint: tokenData.mint.substring(0, 15),
          marketCapSol: curveData.marketCapSol.toFixed(2),
          liquiditySol: curveData.liquiditySol.toFixed(4),
          priceSol: curveData.priceSol.toExponential(4),
        }, 'PumpPortal: New token detected');

        this.emit('newToken', curveData);
      }

      // Handle trades (buy/sell)
      if (message.txType === 'buy' || message.txType === 'sell') {
        const tradeData = message as PumpPortalTrade;
        const curveData = this.processBondingCurveData(tradeData);

        // Update cache
        this.bondingCurveCache.set(tradeData.mint, curveData);

        this.emit('trade', {
          ...curveData,
          txType: tradeData.txType,
          tokenAmount: tradeData.tokenAmount,
          traderPublicKey: tradeData.traderPublicKey,
        });
      }

    } catch (error) {
      logger.error({ error, data: data.toString().substring(0, 200) }, 'Failed to parse PumpPortal message');
    }
  }

  private processBondingCurveData(data: PumpPortalNewToken | PumpPortalTrade): BondingCurveData {
    // Calculate price from virtual reserves
    // price = (vSol / 1e9) / (vTokens / 1e6)
    const vSol = data.vSolInBondingCurve;
    const vTokens = data.vTokensInBondingCurve;

    // Price in SOL per token
    const priceSol = vTokens > 0 ? (vSol / 1e9) / (vTokens / 1e6) : 0;

    // Liquidity is the SOL in the bonding curve
    // For new tokens, this starts around 30 SOL (virtual) + real SOL from buys
    const liquiditySol = vSol / 1e9;

    // Token graduates when bonding curve fills (~$69k mcap, ~400 SOL)
    // vSolInBondingCurve reaches ~85 SOL real + virtual when graduated
    const isGraduated = liquiditySol > 80;

    const curveData: BondingCurveData = {
      mint: data.mint,
      marketCapSol: data.marketCapSol,
      vSolInBondingCurve: vSol,
      vTokensInBondingCurve: vTokens,
      priceSol,
      liquiditySol,
      bondingCurveKey: data.bondingCurveKey,
      isGraduated,
      timestamp: new Date(),
    };

    // Cache the data
    this.bondingCurveCache.set(data.mint, curveData);

    return curveData;
  }

  // Get cached bonding curve data for a token
  getBondingCurveData(mint: string): BondingCurveData | null {
    const cached = this.bondingCurveCache.get(mint);
    if (!cached) return null;

    // Check if cache is expired
    const age = Date.now() - cached.timestamp.getTime();
    if (age > this.cacheExpiry) {
      this.bondingCurveCache.delete(mint);
      return null;
    }

    return cached;
  }

  // Check if we have recent data for a token
  hasRecentData(mint: string): boolean {
    return this.getBondingCurveData(mint) !== null;
  }

  private handleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.error('Max reconnect attempts reached for PumpPortal');
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);

    logger.info({ attempt: this.reconnectAttempts, delay }, 'Reconnecting to PumpPortal...');

    setTimeout(() => {
      this.connect().catch((error) => {
        logger.error({ error }, 'Reconnect failed');
      });
    }, delay);
  }

  async disconnect(): Promise<void> {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.isConnected = false;
    this.subscribedTokens.clear();
    this.bondingCurveCache.clear();
    logger.info('PumpPortal WebSocket disconnected');
  }

  getStatus(): string {
    return `PumpPortal: ${this.isConnected ? 'Connected' : 'Disconnected'}, ` +
           `Subscribed tokens: ${this.subscribedTokens.size}, ` +
           `Cached: ${this.bondingCurveCache.size}`;
  }
}

export const pumpPortalWs = new PumpPortalWs();
