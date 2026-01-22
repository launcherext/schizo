/**
 * Helius API client using official helius-sdk.
 *
 * Features:
 * - Official SDK with built-in methods
 * - TTL-based response caching
 * - Circuit breaker for cascading failure protection
 * - @solana/web3.js Connection integration
 * - Smart transaction support with Jito tips
 * - Optimized priority fee estimation
 *
 * Optimized for Developer tier (Jan 2026):
 * - RPC: 50/sec
 * - sendTransaction: 5/sec
 * - Sender: 15/sec
 */

import { createHelius, type HeliusClient as SdkHeliusClient } from 'helius-sdk';
import CircuitBreaker from 'opossum';
import { Connection, PublicKey, Keypair, VersionedTransaction, TransactionInstruction, type ConfirmedSignatureInfo } from '@solana/web3.js';
import { TTLCache } from './cache.js';
import { createLogger } from '../lib/logger.js';
import { GetAssetResponse } from '../analysis/types.js';
import { SmartTransactionSender, PriorityFeeLevels, createSmartTransactionSender } from './smart-transaction.js';

const logger = createLogger('helius');

/**
 * Helius subscription tiers for rate limit configuration
 */
type HeliusTier = 'free' | 'developer' | 'business' | 'professional';

/**
 * Configuration for HeliusClient.
 */
interface HeliusClientConfig {
  /** Helius API key */
  apiKey: string;
  /** Helius subscription tier (affects rate limits) */
  tier?: HeliusTier;
  /** Cache TTL in milliseconds (default: 30000 = 30 seconds) */
  cacheTTL?: number;
  /** Wallet keypair for smart transactions (optional) */
  wallet?: Keypair;
  /** Enable Jito tips for transactions (default: true) */
  enableJitoTips?: boolean;
}

/**
 * Simplified transaction result structure.
 */
interface TransactionResult {
  /** Transaction signature (base58 encoded) */
  signature: string;
  /** Unix timestamp when transaction was processed */
  timestamp: number;
  /** Transaction type (e.g., 'TRANSFER', 'SWAP', 'UNKNOWN') */
  type: string;
  /** Whether the transaction succeeded */
  success: boolean;
  /** Fee paid in lamports */
  fee?: number;
  /** Block slot */
  slot?: number;
}

/**
 * Response from getTransactionsForAddress API.
 */
interface TransactionsResponse {
  data: TransactionResult[];
  paginationToken?: string;
}

/**
 * Options for getTransactionsForAddress.
 */
interface GetTransactionsOptions {
  /** Maximum transactions to return (1-100) */
  limit?: number;
  /** Pagination token for fetching next page */
  paginationToken?: string;
}

/**
 * Token holder information
 */
interface TokenHolder {
  owner: string;
  amount: number;
  uiAmount: number;
  percentage: number;
}

/**
 * Token holders response
 */
interface TokenHoldersResponse {
  holders: TokenHolder[];
  totalHolders: number;
  totalSupply: number;
}

/**
 * Token account from SDK
 */
interface TokenAccount {
  owner?: string;
  amount?: string;
}

/**
 * Helius API client using official SDK with resilience patterns.
 *
 * @example
 * const helius = new HeliusClient({
 *   apiKey: process.env.HELIUS_API_KEY!,
 *   tier: 'developer',
 *   cacheTTL: 30000
 * });
 *
 * const txs = await helius.getTransactionsForAddress('wallet-address');
 * const connection = helius.getConnection();
 */
class HeliusClient {
  private sdk: SdkHeliusClient;
  private apiKey: string;
  private cache: TTLCache<unknown>;
  private circuitBreaker: CircuitBreaker;
  private cacheHits = 0;
  private cacheMisses = 0;
  private _connection: Connection;
  private smartTxSender: SmartTransactionSender | null = null;
  private rpcUrl: string;

  constructor(config: HeliusClientConfig) {
    this.apiKey = config.apiKey;
    this.rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${config.apiKey}`;

    // Initialize official Helius SDK
    this.sdk = createHelius({ apiKey: config.apiKey });

    // Create optimized connection with Helius RPC
    // Optimized config based on Helius best practices (Jan 2026)
    this._connection = new Connection(this.rpcUrl, {
      commitment: 'confirmed',
      confirmTransactionInitialTimeout: 60000, // 60s for slow txs
      disableRetryOnRateLimit: false, // Let Connection handle rate limits
    });

    // Initialize smart transaction sender if wallet provided
    if (config.wallet) {
      this.smartTxSender = createSmartTransactionSender(config.apiKey, config.wallet, {
        enableJitoTips: config.enableJitoTips ?? true,
      });
      logger.info('Smart transaction sender initialized with Jito tips');
    }

    // Initialize cache
    this.cache = new TTLCache<unknown>(config.cacheTTL ?? 30000);

    // Create circuit breaker for API calls
    this.circuitBreaker = new CircuitBreaker(
      async <T>(fn: () => Promise<T>) => fn(),
      {
        timeout: 15000, // 15s timeout per request
        errorThresholdPercentage: 50, // Open after 50% failures
        resetTimeout: 30000, // Try again after 30s
        volumeThreshold: 5, // Minimum calls before tripping
      }
    );

    // Wire circuit breaker events to logger
    this.circuitBreaker.on('open', () => {
      logger.error('Circuit breaker OPEN - Helius API appears down');
    });

    this.circuitBreaker.on('halfOpen', () => {
      logger.info('Circuit breaker HALF-OPEN - testing Helius API');
    });

    this.circuitBreaker.on('close', () => {
      logger.info('Circuit breaker CLOSED - Helius API recovered');
    });

    logger.info(
      {
        tier: config.tier ?? 'developer',
        cacheTTL: config.cacheTTL ?? 30000,
        hasSmartTx: !!config.wallet,
        jitoTipsEnabled: config.enableJitoTips ?? true,
      },
      'HeliusClient initialized with official SDK (optimized for Jan 2026)'
    );
  }

  /**
   * Get the underlying Helius SDK instance for advanced operations.
   */
  getSdk(): SdkHeliusClient {
    return this.sdk;
  }

  /**
   * Get transactions for a wallet address using SDK.
   */
  async getTransactionsForAddress(
    address: string,
    options?: GetTransactionsOptions
  ): Promise<TransactionsResponse> {
    const limit = options?.limit ?? 100;
    const cacheKey = `txs:${address}:${limit}`;

    // Check cache first (skip for pagination requests)
    if (!options?.paginationToken) {
      const cached = this.cache.get(cacheKey) as TransactionsResponse | undefined;
      if (cached) {
        this.cacheHits++;
        logger.debug({ address, cacheHit: true }, 'Cache hit for transactions');
        return cached;
      }
    }

    this.cacheMisses++;

    // Execute via circuit breaker using SDK
    const result = await this.circuitBreaker.fire(async () => {
      // Use getTransactionsForAddress from SDK if available, otherwise use Connection
      const response = await this._connection.getSignaturesForAddress(
        new PublicKey(address),
        { limit }
      );

      // Map response to our format
      const data: TransactionResult[] = response.map((sig: ConfirmedSignatureInfo) => ({
        signature: sig.signature,
        timestamp: sig.blockTime ? sig.blockTime * 1000 : Date.now(),
        type: 'UNKNOWN', // Would need parsing for type
        success: sig.err === null,
        slot: sig.slot,
      }));

      return { data };
    }) as TransactionsResponse;

    // Cache result (skip for paginated requests)
    if (!options?.paginationToken && result.data && result.data.length > 0) {
      this.cache.set(cacheKey, result);
    }

    return result;
  }

  /**
   * Get token metadata using Helius DAS API via SDK.
   */
  async getAsset(mintAddress: string): Promise<GetAssetResponse> {
    const cacheKey = `asset:${mintAddress}`;

    const cached = this.cache.get(cacheKey) as GetAssetResponse | undefined;
    if (cached) {
      this.cacheHits++;
      return cached;
    }

    this.cacheMisses++;

    const result = await this.circuitBreaker.fire(async () => {
      const asset = await this.sdk.getAsset({ id: mintAddress });

      logger.debug({ mintAddress }, 'Successfully fetched asset metadata via SDK');
      return asset as unknown as GetAssetResponse;
    }) as GetAssetResponse;

    this.cache.set(cacheKey, result);
    return result;
  }

  /**
   * Get multiple assets in batch using SDK.
   */
  async getAssetBatch(mintAddresses: string[]): Promise<GetAssetResponse[]> {
    return this.circuitBreaker.fire(async () => {
      const assets = await this.sdk.getAssetBatch({ ids: mintAddresses });
      return assets as unknown as GetAssetResponse[];
    }) as Promise<GetAssetResponse[]>;
  }

  /**
   * Get a Solana Connection using Helius RPC.
   */
  getConnection(): Connection {
    return this._connection;
  }

  /**
   * Get cache statistics.
   */
  getCacheStats(): {
    size: number;
    hits: number;
    misses: number;
    hitRate: number;
  } {
    const cacheStats = this.cache.getStats();
    const total = this.cacheHits + this.cacheMisses;
    return {
      size: cacheStats.size,
      hits: this.cacheHits,
      misses: this.cacheMisses,
      hitRate: total > 0 ? this.cacheHits / total : 0,
    };
  }

  /**
   * Clear the cache.
   */
  clearCache(): void {
    this.cache.clear();
    this.cacheHits = 0;
    this.cacheMisses = 0;
    logger.info('Cache cleared');
  }

  /**
   * Get token holders using Helius DAS API.
   */
  async getTokenHolders(
    mintAddress: string,
    limit: number = 20
  ): Promise<TokenHoldersResponse> {
    const cacheKey = `holders:${mintAddress}:${limit}`;

    const cached = this.cache.get(cacheKey) as TokenHoldersResponse | undefined;
    if (cached) {
      this.cacheHits++;
      return cached;
    }

    this.cacheMisses++;

    const result = await this.circuitBreaker.fire(async () => {
      // Use SDK's getTokenAccounts method
      const response = await this.sdk.getTokenAccounts({
        mint: mintAddress,
        limit,
        options: { showZeroBalance: false },
      });

      const accounts = (response as { token_accounts?: TokenAccount[]; total?: number }).token_accounts || [];
      const totalHolders = (response as { total?: number }).total || accounts.length;

      // Calculate total supply from holder amounts
      let totalSupply = 0;
      for (const account of accounts) {
        totalSupply += parseFloat(account.amount || '0');
      }

      // Map to TokenHolder with percentages
      const holders: TokenHolder[] = accounts.map((account: TokenAccount) => {
        const amount = parseFloat(account.amount || '0');
        return {
          owner: account.owner || '',
          amount,
          uiAmount: amount / 1e6, // Assuming 6 decimals (common for pump.fun)
          percentage: totalSupply > 0 ? (amount / totalSupply) * 100 : 0,
        };
      });

      // Sort by amount descending
      holders.sort((a, b) => b.amount - a.amount);

      logger.debug({ mintAddress, holderCount: holders.length }, 'Fetched token holders via SDK');

      return {
        holders,
        totalHolders,
        totalSupply,
      };
    }) as TokenHoldersResponse;

    this.cache.set(cacheKey, result);
    return result;
  }

  /**
   * Check if a token is a Pump.fun Mayhem Mode token
   * Mayhem Mode tokens have 2 billion supply (vs 1 billion for regular pump.fun)
   */
  async isMayhemModeToken(mintAddress: string): Promise<boolean> {
    try {
      const response = await this.getConnection().getTokenSupply(
        new PublicKey(mintAddress)
      );

      const supply = response.value.uiAmount;

      // Mayhem Mode tokens have exactly 2 billion supply
      const isMayhem = supply !== null && supply >= 1_999_999_999 && supply <= 2_000_000_001;

      if (isMayhem) {
        logger.warn(
          {
            mintAddress,
            supply,
          },
          'Mayhem Mode token detected (2B supply)'
        );
      }

      return isMayhem;
    } catch (error) {
      logger.debug({ mintAddress, error }, 'Failed to check token supply for Mayhem Mode');
      return false;
    }
  }

  /**
   * Get priority fee estimate using Helius API.
   *
   * Optimized for Jan 2026: Uses serialized transaction when available
   * for more accurate fee estimation.
   *
   * @param serializedTx - Base64 serialized transaction (most accurate)
   * @param accountKeys - Fallback to account keys if no transaction
   */
  async getPriorityFeeEstimate(
    serializedTx?: string,
    accountKeys?: string[]
  ): Promise<PriorityFeeLevels> {
    // Use smart tx sender if available (has caching)
    if (this.smartTxSender) {
      return this.smartTxSender.getPriorityFeeEstimate(serializedTx, accountKeys);
    }

    // Fallback to direct API call
    const result = await this.circuitBreaker.fire(async () => {
      const params: any = {
        options: { includeAllPriorityFeeLevels: true },
      };

      if (serializedTx) {
        params.transaction = serializedTx;
      } else if (accountKeys && accountKeys.length > 0) {
        params.accountKeys = accountKeys;
      }

      const response = await fetch(this.rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'priority-fee',
          method: 'getPriorityFeeEstimate',
          params: [params],
        }),
      });

      return response.json();
    }) as { result?: { priorityFeeLevels?: Record<string, number>; priorityFeeEstimate?: number } };

    // Map response to our format
    if (result.result?.priorityFeeLevels) {
      const levels = result.result.priorityFeeLevels;
      return {
        min: levels.min || 0,
        low: levels.low || 1000,
        medium: levels.medium || 10000,
        high: levels.high || 100000,
        veryHigh: levels.veryHigh || 500000,
        unsafeMax: levels.unsafeMax || 1000000,
      };
    }

    // Fallback single value
    const base = result.result?.priorityFeeEstimate || 10000;
    return {
      min: Math.floor(base * 0.5),
      low: Math.floor(base * 0.75),
      medium: base,
      high: Math.floor(base * 1.5),
      veryHigh: Math.floor(base * 2),
      unsafeMax: Math.floor(base * 3),
    };
  }

  /**
   * Get the smart transaction sender for optimized transaction sending.
   * Returns null if no wallet was provided in config.
   */
  getSmartTxSender(): SmartTransactionSender | null {
    return this.smartTxSender;
  }

  /**
   * Send a transaction using smart transaction pattern with Jito tips.
   * Includes automatic retry, polling, and rebroadcast.
   *
   * @param transaction - Signed VersionedTransaction
   * @param options - Send options
   */
  async sendSmartTransaction(
    transaction: VersionedTransaction,
    options?: {
      urgent?: boolean;
      skipPreflight?: boolean;
    }
  ): Promise<string> {
    if (!this.smartTxSender) {
      // Fallback to regular send if no smart tx sender
      logger.warn('No smart tx sender - using basic sendTransaction');
      const signature = await this._connection.sendTransaction(transaction, {
        skipPreflight: options?.skipPreflight ?? false,
      });
      return signature;
    }

    return this.smartTxSender.sendExternalTransaction(transaction, options);
  }

  /**
   * Build and send a smart transaction from instructions.
   * Automatically adds Jito tips and optimal priority fees.
   *
   * @param instructions - Transaction instructions
   * @param options - Build and send options
   */
  async buildAndSendSmartTransaction(
    instructions: TransactionInstruction[],
    options?: {
      urgent?: boolean;
      priorityLevel?: 'low' | 'medium' | 'high' | 'veryHigh';
      skipJitoTip?: boolean;
    }
  ): Promise<string> {
    if (!this.smartTxSender) {
      throw new Error('Smart transaction sender not initialized - provide wallet in config');
    }

    return this.smartTxSender.buildAndSendSmartTransaction(instructions, options);
  }

  /**
   * Get circuit breaker status.
   */
  getCircuitBreakerStatus(): {
    state: string;
    stats: {
      fires: number;
      failures: number;
      fallbacks: number;
      successes: number;
      rejects: number;
      timeouts: number;
    };
  } {
    return {
      state: this.circuitBreaker.opened
        ? 'OPEN'
        : this.circuitBreaker.halfOpen
          ? 'HALF-OPEN'
          : 'CLOSED',
      stats: {
        fires: this.circuitBreaker.stats.fires,
        failures: this.circuitBreaker.stats.failures,
        fallbacks: this.circuitBreaker.stats.fallbacks,
        successes: this.circuitBreaker.stats.successes,
        rejects: this.circuitBreaker.stats.rejects,
        timeouts: this.circuitBreaker.stats.timeouts,
      },
    };
  }

  /**
   * Get all token assets owned by a wallet using Helius DAS API.
   * More efficient than RPC getParsedTokenAccountsByOwner.
   */
  async getAssetsByOwner(ownerAddress: string): Promise<Array<{ mint: string; balance: number }>> {
    return this.circuitBreaker.fire(async () => {
      const response = await this.sdk.rpc.getAssetsByOwner({
        ownerAddress,
        page: 1,
        limit: 1000,
        displayOptions: {
          showFungible: true,
        },
      });

      // Filter for fungible tokens and map to simple format
      const tokens = (response.items || [])
        .filter((asset: any) => 
          (asset.interface === 'FungibleToken' || asset.interface === 'FungibleAsset') &&
          asset.token_info?.balance
        )
        .map((asset: any) => ({
          mint: asset.id,
          balance: parseFloat(asset.token_info.balance) / Math.pow(10, asset.token_info.decimals || 6),
        }))
        .filter((token: any) => token.balance > 0);

      logger.info({ ownerAddress, tokenCount: tokens.length, tokens: tokens.slice(0, 3) }, 'Fetched wallet tokens via DAS API');
      return tokens;
    }) as Promise<Array<{ mint: string; balance: number }>>;
  }
}

export {
  HeliusClient,
  HeliusClientConfig,
  HeliusTier,
  TransactionResult,
  TransactionsResponse,
  GetTransactionsOptions,
  TokenHolder,
  TokenHoldersResponse,
  PriorityFeeLevels,
};

// Re-export smart transaction utilities
export { SmartTransactionSender, createSmartTransactionSender } from './smart-transaction.js';
