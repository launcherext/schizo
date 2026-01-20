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
};
