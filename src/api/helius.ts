/**
 * Helius API client with caching, rate limiting, and resilience.
 *
 * Features:
 * - TTL-based response caching
 * - Tier-aware rate limiting via Bottleneck
 * - Automatic retry with exponential backoff
 * - Circuit breaker for cascading failure protection
 * - @solana/web3.js Connection integration
 */

import Bottleneck from 'bottleneck';
import pRetry, { AbortError } from 'p-retry';
import CircuitBreaker from 'opossum';
import { Connection } from '@solana/web3.js';
import { TTLCache } from './cache.js';
import { createRateLimiter, getConfigForTier, HeliusTier } from './rate-limiter.js';
import { createLogger } from '../lib/logger.js';
import { GetAssetResponse } from '../analysis/types.js';

const logger = createLogger('helius');

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
  /** Base URL for Helius API (default: mainnet) */
  baseUrl?: string;
}

/**
 * Simplified transaction result structure.
 * Additional fields will be added in Phase 2 for full wallet analysis.
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
 * Rate-limited, cached Helius API client with resilience patterns.
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
  private apiKey: string;
  private baseUrl: string;
  private cache: TTLCache<TransactionsResponse>;
  private rpcLimiter: Bottleneck;
  private enhancedLimiter: Bottleneck;
  private circuitBreaker: CircuitBreaker;
  private cacheHits = 0;
  private cacheMisses = 0;

  constructor(config: HeliusClientConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl || 'https://mainnet.helius-rpc.com';

    // Initialize cache
    this.cache = new TTLCache<TransactionsResponse>(config.cacheTTL ?? 30000);

    // Create tier-appropriate rate limiters
    const tierConfig = getConfigForTier(config.tier ?? 'developer');
    this.rpcLimiter = createRateLimiter(tierConfig.rpc, 'helius-rpc');
    this.enhancedLimiter = createRateLimiter(tierConfig.enhanced, 'helius-enhanced');

    // Create circuit breaker for API calls
    this.circuitBreaker = new CircuitBreaker(this.executeRequest.bind(this), {
      timeout: 15000, // 15s timeout per request
      errorThresholdPercentage: 50, // Open after 50% failures
      resetTimeout: 30000, // Try again after 30s
      volumeThreshold: 5, // Minimum calls before tripping
    });

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

    this.circuitBreaker.on('fallback', () => {
      logger.warn('Circuit breaker fallback triggered');
    });

    logger.info(
      {
        tier: config.tier ?? 'developer',
        cacheTTL: config.cacheTTL ?? 30000,
        baseUrl: this.baseUrl,
      },
      'HeliusClient initialized'
    );
  }

  /**
   * Get transactions for a wallet address.
   *
   * Uses caching, rate limiting, retry logic, and circuit breaker.
   *
   * @param address - Solana wallet address (base58)
   * @param options - Query options
   * @returns Transactions response with pagination
   */
  async getTransactionsForAddress(
    address: string,
    options?: GetTransactionsOptions
  ): Promise<TransactionsResponse> {
    const limit = options?.limit ?? 100;
    const cacheKey = `txs:${address}:${limit}`;

    // Check cache first (skip for pagination requests)
    if (!options?.paginationToken) {
      const cached = this.cache.get(cacheKey);
      if (cached) {
        this.cacheHits++;
        logger.debug({ address, cacheHit: true }, 'Cache hit for transactions');
        return cached;
      }
    }

    this.cacheMisses++;

    // Build request body
    const body = {
      jsonrpc: '2.0',
      id: 1,
      method: 'getTransactionsForAddress',
      params: [
        address,
        {
          limit,
          ...(options?.paginationToken && { paginationToken: options.paginationToken }),
        },
      ],
    };

    // Execute via circuit breaker with rate limiting
    const result = (await this.circuitBreaker.fire(body)) as TransactionsResponse;

    // Cache result (skip for paginated requests - they're partial)
    if (!options?.paginationToken && result.data && result.data.length > 0) {
      this.cache.set(cacheKey, result);
    }

    return result;
  }

  /**
   * Execute a request with rate limiting and retry.
   * This is wrapped by the circuit breaker.
   */
  private async executeRequest(body: object): Promise<TransactionsResponse> {
    return this.rpcLimiter.schedule(() => this.fetchWithRetry(body));
  }

  /**
   * Fetch with exponential backoff retry.
   */
  private async fetchWithRetry(body: object): Promise<TransactionsResponse> {
    const url = `${this.baseUrl}/?api-key=${this.apiKey}`;

    return pRetry(
      async () => {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });

        // Retry on rate limit or server errors
        if (response.status === 429) {
          const error = new Error('Rate limited (429)');
          (error as Error & { status: number }).status = 429;
          throw error;
        }

        if (response.status >= 500) {
          throw new Error(`Server error (${response.status})`);
        }

        // Don't retry client errors (400, 401, 403, 404)
        if (!response.ok) {
          throw new AbortError(`Client error (${response.status})`);
        }

        const json = (await response.json()) as {
          result?: { data?: TransactionResult[]; paginationToken?: string };
          error?: { message: string };
        };

        if (json.error) {
          throw new AbortError(`API error: ${json.error.message}`);
        }

        // Map response to our format
        return {
          data: json.result?.data ?? [],
          paginationToken: json.result?.paginationToken,
        };
      },
      {
        retries: 3,
        minTimeout: 1000, // Start with 1s
        maxTimeout: 10000, // Max 10s between retries
        factor: 2, // Double each time
        onFailedAttempt: (error) => {
          logger.warn(
            {
              attempt: error.attemptNumber,
              retriesLeft: error.retriesLeft,
              error: error.message,
            },
            'Request failed, retrying'
          );
        },
      }
    );
  }

  /**
   * Get token metadata using Helius DAS API.
   * 
   * Uses rate limiting and retry logic (without circuit breaker).
   * 
   * @param mintAddress - Token mint address (base58)
   * @returns Token metadata including authorities and extensions
   */
  async getAsset(mintAddress: string): Promise<GetAssetResponse> {
    const body = {
      jsonrpc: '2.0',
      id: 1,
      method: 'getAsset',
      params: { id: mintAddress },
    };

    // Use enhanced API limiter (DAS API is part of Enhanced tier)
    return this.enhancedLimiter.schedule(() => this.fetchAssetWithRetry(body, mintAddress));
  }

  /**
   * Fetch asset with exponential backoff retry.
   * Does not use circuit breaker (different API endpoint).
   */
  private async fetchAssetWithRetry(body: object, mintAddress: string): Promise<GetAssetResponse> {
    const url = `${this.baseUrl}/?api-key=${this.apiKey}`;

    return pRetry(
      async () => {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });

        // Retry on rate limit or server errors
        if (response.status === 429) {
          const error = new Error('Rate limited (429)');
          (error as Error & { status: number }).status = 429;
          throw error;
        }

        if (response.status >= 500) {
          throw new Error(`Server error (${response.status})`);
        }

        // Don't retry client errors
        if (!response.ok) {
          throw new AbortError(`Client error (${response.status})`);
        }

        const json = (await response.json()) as {
          result?: GetAssetResponse;
          error?: { message: string };
        };

        if (json.error) {
          logger.warn({ mintAddress, error: json.error.message }, 'getAsset API error');
          throw new AbortError(`API error: ${json.error.message}`);
        }

        if (!json.result) {
          throw new AbortError('No result in getAsset response');
        }

        logger.debug({ mintAddress }, 'Successfully fetched asset metadata');
        return json.result;
      },
      {
        retries: 3,
        minTimeout: 1000,
        maxTimeout: 10000,
        factor: 2,
        onFailedAttempt: (error) => {
          logger.warn(
            {
              mintAddress,
              attempt: error.attemptNumber,
              retriesLeft: error.retriesLeft,
              error: error.message,
            },
            'getAsset request failed, retrying'
          );
        },
      }
    );
  }

  /**
   * Get a Solana Connection using Helius RPC.
   *
   * @returns Connection configured for Helius RPC
   */
  getConnection(): Connection {
    return new Connection(`${this.baseUrl}/?api-key=${this.apiKey}`, 'confirmed');
  }

  /**
   * Get cache statistics.
   *
   * @returns Object with cache metrics
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
   *
   * @param mintAddress - Token mint address
   * @param limit - Maximum holders to return (default 20)
   * @returns Top token holders with ownership percentages
   */
  async getTokenHolders(
    mintAddress: string,
    limit: number = 20
  ): Promise<TokenHoldersResponse> {
    const body = {
      jsonrpc: '2.0',
      id: 1,
      method: 'getTokenAccounts',
      params: {
        mint: mintAddress,
        limit,
        options: {
          showZeroBalance: false,
        },
      },
    };

    return this.enhancedLimiter.schedule(async () => {
      const url = `${this.baseUrl}/?api-key=${this.apiKey}`;

      const response = await pRetry(
        async () => {
          const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });

          if (res.status === 429) {
            throw new Error('Rate limited (429)');
          }

          if (!res.ok) {
            throw new AbortError(`HTTP error (${res.status})`);
          }

          const json = (await res.json()) as {
            result?: {
              token_accounts?: Array<{
                owner: string;
                amount: string;
              }>;
              total?: number;
            };
            error?: { message: string };
          };

          if (json.error) {
            throw new AbortError(`API error: ${json.error.message}`);
          }

          return json.result;
        },
        {
          retries: 3,
          minTimeout: 1000,
          maxTimeout: 10000,
          factor: 2,
        }
      );

      const accounts = response?.token_accounts || [];
      const totalHolders = response?.total || accounts.length;

      // Calculate total supply from holder amounts
      let totalSupply = 0;
      for (const account of accounts) {
        totalSupply += parseFloat(account.amount);
      }

      // Map to TokenHolder with percentages
      const holders: TokenHolder[] = accounts.map(account => {
        const amount = parseFloat(account.amount);
        return {
          owner: account.owner,
          amount,
          uiAmount: amount / 1e6, // Assuming 6 decimals (common for pump.fun)
          percentage: totalSupply > 0 ? (amount / totalSupply) * 100 : 0,
        };
      });

      // Sort by amount descending
      holders.sort((a, b) => b.amount - a.amount);

      logger.debug({ mintAddress, holderCount: holders.length }, 'Fetched token holders');

      return {
        holders,
        totalHolders,
        totalSupply,
      };
    });
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
}

export {
  HeliusClient,
  HeliusClientConfig,
  TransactionResult,
  TransactionsResponse,
  GetTransactionsOptions,
  TokenHolder,
  TokenHoldersResponse,
};
