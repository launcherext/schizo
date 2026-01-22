import WebSocket from 'ws';
import { EventEmitter } from 'events';
import bs58 from 'bs58';
import { config } from '../config/settings';
import { createChildLogger } from '../utils/logger';
import { NewTokenEvent } from './types';
import { repository } from '../db/repository';

const logger = createChildLogger('helius-ws');

// Metadata cache to avoid redundant fetches
const metadataCache = new Map<string, { name: string; symbol: string; imageUrl: string | null }>();

// CreateEvent discriminator from pump.fun IDL (sha256 hash of "event:CreateEvent" first 8 bytes)
const CREATE_EVENT_DISCRIMINATOR = Buffer.from([27, 114, 169, 77, 222, 235, 99, 118]);

interface LogsNotification {
  jsonrpc: string;
  method: string;
  params: {
    result: {
      value: {
        signature: string;
        err: null | unknown;
        logs: string[];
      };
    };
    subscription: number;
  };
}

interface TokenData {
  name: string;
  symbol: string;
  uri: string;
  mint: string;
  bondingCurve: string;
  creator: string;
}

interface TokenMetadata {
  name?: string;
  symbol?: string;
  image?: string;
}

async function fetchTokenMetadata(uri: string, mint: string): Promise<{ name: string; symbol: string; imageUrl: string | null } | null> {
  // Check cache first
  const cached = metadataCache.get(mint);
  if (cached) return cached;

  try {
    // Handle IPFS URIs
    let fetchUrl = uri;
    if (uri.startsWith('ipfs://')) {
      fetchUrl = `https://ipfs.io/ipfs/${uri.slice(7)}`;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(fetchUrl, {
      signal: controller.signal,
      headers: { 'Accept': 'application/json' }
    });
    clearTimeout(timeout);

    if (!response.ok) {
      logger.debug({ mint, uri, status: response.status }, 'Failed to fetch metadata');
      return null;
    }

    const metadata = await response.json() as TokenMetadata;

    // Extract image URL, handling IPFS
    let imageUrl = metadata.image || null;
    if (imageUrl && imageUrl.startsWith('ipfs://')) {
      imageUrl = `https://ipfs.io/ipfs/${imageUrl.slice(7)}`;
    }

    const result = {
      name: metadata.name || '',
      symbol: metadata.symbol || '',
      imageUrl
    };

    // Cache the result
    metadataCache.set(mint, result);

    // Limit cache size
    if (metadataCache.size > 1000) {
      const firstKey = metadataCache.keys().next().value;
      if (firstKey) metadataCache.delete(firstKey);
    }

    return result;
  } catch (error) {
    logger.debug({ mint, uri, error }, 'Error fetching token metadata');
    return null;
  }
}

export class HeliusWebSocket extends EventEmitter {
  private ws: WebSocket | null = null;
  private subscriptionId: number | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectDelay = 1000;
  private pingInterval: NodeJS.Timeout | null = null;
  private isConnected = false;

  constructor() {
    super();
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const wsUrl = config.heliusWsUrl;

      if (!wsUrl) {
        reject(new Error('HELIUS_WS_URL not configured'));
        return;
      }

      logger.info({ url: wsUrl.substring(0, 50) + '...' }, 'Connecting to Helius WebSocket');

      this.ws = new WebSocket(wsUrl);

      this.ws.on('open', () => {
        logger.info('WebSocket connected');
        this.isConnected = true;
        this.reconnectAttempts = 0;
        this.setupPing();
        this.subscribeToPumpFun();
        resolve();
      });

      this.ws.on('message', (data: WebSocket.Data) => {
        this.handleMessage(data.toString());
      });

      this.ws.on('error', (error) => {
        logger.error({ error: error.message }, 'WebSocket error');
        if (!this.isConnected) {
          reject(error);
        }
      });

      this.ws.on('close', (code, reason) => {
        logger.warn({ code, reason: reason.toString() }, 'WebSocket closed');
        this.isConnected = false;
        this.cleanup();
        this.attemptReconnect();
      });

      setTimeout(() => {
        if (!this.isConnected) {
          reject(new Error('WebSocket connection timeout'));
        }
      }, 30000);
    });
  }

  private setupPing(): void {
    this.pingInterval = setInterval(() => {
      if (this.ws && this.isConnected) {
        this.ws.ping();
      }
    }, 30000);
  }

  private subscribeToPumpFun(): void {
    if (!this.ws) return;

    // Use logsSubscribe (available on free tier) to monitor pump.fun program
    const subscribeMessage = {
      jsonrpc: '2.0',
      id: 420,
      method: 'logsSubscribe',
      params: [
        { mentions: [config.pumpFunProgram] },
        { commitment: 'confirmed' },
      ],
    };

    this.ws.send(JSON.stringify(subscribeMessage));
    logger.info({ program: config.pumpFunProgram }, 'Subscribed to Pump.fun logs');
  }

  private handleMessage(data: string): void {
    try {
      const message = JSON.parse(data);

      // Handle subscription confirmation
      if (message.id === 420 && message.result !== undefined) {
        this.subscriptionId = message.result;
        logger.info({ subscriptionId: this.subscriptionId }, 'Subscription confirmed');
        return;
      }

      // Handle logs notifications
      if (message.method === 'logsNotification') {
        this.processLogs(message as LogsNotification);
      }
    } catch (error) {
      logger.error({ error, data: data.substring(0, 200) }, 'Failed to parse WebSocket message');
    }
  }

  private processLogs(notification: LogsNotification): void {
    try {
      const { signature, logs, err } = notification.params?.result?.value || {};

      if (err || !logs || logs.length === 0) return;

      const logsJoined = logs.join(' ');

      // Check for Create/CreateV2 instruction (new token)
      // CreateV2 is the newer pump.fun instruction that contains the CreateEvent
      const isCreate = logsJoined.includes('Instruction: Create') || logsJoined.includes('Instruction: CreateV2');

      if (isCreate) {
        // Find and decode Program data
        for (const log of logs) {
          if (log.startsWith('Program data: ')) {
            const base64Data = log.substring('Program data: '.length);
            const tokenData = this.decodeCreateEvent(base64Data);

            if (tokenData && tokenData.mint.endsWith('pump')) {
              // Fetch metadata asynchronously (don't block event emission)
              this.fetchAndStoreMetadata(tokenData);

              const event: NewTokenEvent = {
                mint: tokenData.mint,
                signature,
                timestamp: new Date(),
                creator: tokenData.creator,
                name: tokenData.name,
                symbol: tokenData.symbol,
              };

              logger.info({
                mint: tokenData.mint,
                name: tokenData.name,
                symbol: tokenData.symbol,
                creator: tokenData.creator.substring(0, 10) + '...',
                signature: signature.substring(0, 15),
              }, 'NEW PUMP.FUN TOKEN');

              this.emit('newToken', event);
              break; // Only emit once per transaction
            }
          }
        }
      }

      // Emit buy/sell events for trading analysis
      const isBuy = logsJoined.includes('Instruction: Buy');
      const isSell = logsJoined.includes('Instruction: Sell');

      if (isBuy || isSell) {
        this.emit('trade', { type: isBuy ? 'buy' : 'sell', signature, logs });
      }
    } catch (error) {
      logger.error({ error }, 'Failed to process logs');
    }
  }

  /**
   * Decode base64 Program data from pump.fun CreateEvent
   * Structure:
   * - 8 bytes: discriminator
   * - 4 bytes + N bytes: name (length-prefixed string)
   * - 4 bytes + N bytes: symbol (length-prefixed string)
   * - 4 bytes + N bytes: uri (length-prefixed string)
   * - 32 bytes: mint pubkey
   * - 32 bytes: bonding curve pubkey
   * - 32 bytes: user/creator pubkey
   */
  private decodeCreateEvent(base64Data: string): TokenData | null {
    try {
      const data = Buffer.from(base64Data, 'base64');

      // Check discriminator
      const discriminator = data.subarray(0, 8);
      if (!discriminator.equals(CREATE_EVENT_DISCRIMINATOR)) {
        return null;
      }

      let offset = 8;

      // Parse name (4-byte little-endian length prefix + string)
      const nameLen = data.readUInt32LE(offset);
      offset += 4;
      const name = data.subarray(offset, offset + nameLen).toString('utf-8');
      offset += nameLen;

      // Parse symbol
      const symbolLen = data.readUInt32LE(offset);
      offset += 4;
      const symbol = data.subarray(offset, offset + symbolLen).toString('utf-8');
      offset += symbolLen;

      // Parse URI
      const uriLen = data.readUInt32LE(offset);
      offset += 4;
      const uri = data.subarray(offset, offset + uriLen).toString('utf-8');
      offset += uriLen;

      // Parse mint (32 bytes)
      const mintBytes = data.subarray(offset, offset + 32);
      const mint = bs58.encode(mintBytes);
      offset += 32;

      // Parse bonding curve (32 bytes)
      const bondingCurveBytes = data.subarray(offset, offset + 32);
      const bondingCurve = bs58.encode(bondingCurveBytes);
      offset += 32;

      // Parse creator/user (32 bytes)
      const creatorBytes = data.subarray(offset, offset + 32);
      const creator = bs58.encode(creatorBytes);

      return { name, symbol, uri, mint, bondingCurve, creator };
    } catch (error) {
      logger.debug({ error, data: base64Data.substring(0, 50) }, 'Failed to decode CreateEvent');
      return null;
    }
  }

  private async fetchAndStoreMetadata(tokenData: TokenData): Promise<void> {
    try {
      const metadata = await fetchTokenMetadata(tokenData.uri, tokenData.mint);
      if (metadata && metadata.imageUrl) {
        await repository.updateTokenMetadata(tokenData.mint, {
          name: metadata.name || tokenData.name,
          symbol: metadata.symbol || tokenData.symbol,
          image_url: metadata.imageUrl
        });

        // Emit metadata update event for real-time UI updates
        this.emit('tokenMetadataUpdated', {
          mint: tokenData.mint,
          name: metadata.name || tokenData.name,
          symbol: metadata.symbol || tokenData.symbol,
          imageUrl: metadata.imageUrl
        });

        logger.debug({
          mint: tokenData.mint.substring(0, 10) + '...',
          hasImage: !!metadata.imageUrl
        }, 'Token metadata fetched');
      }
    } catch (error) {
      logger.debug({ mint: tokenData.mint, error }, 'Failed to fetch/store token metadata');
    }
  }

  private cleanup(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    this.subscriptionId = null;
  }

  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.error('Max reconnection attempts reached');
      this.emit('maxReconnectAttemptsReached');
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);

    logger.info({ attempt: this.reconnectAttempts, delay }, 'Attempting to reconnect');

    setTimeout(() => {
      this.connect().catch((err) => {
        logger.error({ error: err.message }, 'Reconnection failed');
      });
    }, delay);
  }

  async disconnect(): Promise<void> {
    this.cleanup();

    if (this.ws) {
      if (this.subscriptionId !== null) {
        const unsubscribe = {
          jsonrpc: '2.0',
          id: 2,
          method: 'logsUnsubscribe',
          params: [this.subscriptionId],
        };
        this.ws.send(JSON.stringify(unsubscribe));
      }

      this.ws.close();
      this.ws = null;
    }

    this.isConnected = false;
    logger.info('WebSocket disconnected');
  }
}

export const heliusWs = new HeliusWebSocket();
