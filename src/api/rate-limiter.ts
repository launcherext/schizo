/**
 * Rate limiter configuration for Helius API calls.
 *
 * Uses Bottleneck to prevent rate limit errors (429) by throttling
 * requests according to Helius tier limits.
 */

import Bottleneck from 'bottleneck';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('rate-limiter');

/**
 * Configuration for a Bottleneck rate limiter.
 */
interface RateLimiterConfig {
  /** Maximum number of concurrent requests */
  maxConcurrent: number;
  /** Minimum milliseconds between requests */
  minTime: number;
  /** Initial number of requests allowed (token bucket) */
  reservoir?: number;
  /** Number of tokens to add on refresh */
  reservoirRefreshAmount?: number;
  /** Milliseconds between reservoir refreshes */
  reservoirRefreshInterval?: number;
}

/**
 * Helius API tier levels.
 *
 * Rate limits differ significantly between tiers:
 * - free: 10 RPC/s, 2 Enhanced/s
 * - developer: 50 RPC/s, 10 Enhanced/s
 * - business: 200 RPC/s, 50 Enhanced/s
 */
type HeliusTier = 'free' | 'developer' | 'business';

/**
 * Get rate limiter configurations for a Helius tier.
 *
 * Applies 80% safety margin to prevent hitting actual limits.
 *
 * @param tier - The Helius subscription tier
 * @returns Configuration objects for RPC and Enhanced API limiters
 */
function getConfigForTier(tier: HeliusTier): {
  rpc: RateLimiterConfig;
  enhanced: RateLimiterConfig;
} {
  // Tier limits with 80% safety margin
  const configs: Record<HeliusTier, { rpc: RateLimiterConfig; enhanced: RateLimiterConfig }> = {
    free: {
      rpc: {
        maxConcurrent: 5,
        minTime: 150, // ~6-7 RPS (80% of 10)
        reservoir: 8,
        reservoirRefreshAmount: 8,
        reservoirRefreshInterval: 1000,
      },
      enhanced: {
        maxConcurrent: 1,
        minTime: 625, // ~1.6 RPS (80% of 2)
        reservoir: 1,
        reservoirRefreshAmount: 1,
        reservoirRefreshInterval: 625,
      },
    },
    developer: {
      rpc: {
        maxConcurrent: 10,
        minTime: 25, // ~40 RPS (80% of 50)
        reservoir: 40,
        reservoirRefreshAmount: 40,
        reservoirRefreshInterval: 1000,
      },
      enhanced: {
        maxConcurrent: 5,
        minTime: 125, // ~8 RPS (80% of 10)
        reservoir: 8,
        reservoirRefreshAmount: 8,
        reservoirRefreshInterval: 1000,
      },
    },
    business: {
      rpc: {
        maxConcurrent: 25,
        minTime: 6, // ~160 RPS (80% of 200)
        reservoir: 160,
        reservoirRefreshAmount: 160,
        reservoirRefreshInterval: 1000,
      },
      enhanced: {
        maxConcurrent: 15,
        minTime: 25, // ~40 RPS (80% of 50)
        reservoir: 40,
        reservoirRefreshAmount: 40,
        reservoirRefreshInterval: 1000,
      },
    },
  };

  return configs[tier];
}

/**
 * Create a Bottleneck rate limiter with 429 error handling.
 *
 * The limiter automatically backs off on 429 errors and retries.
 *
 * @param config - Rate limiter configuration
 * @param name - Optional name for logging
 * @returns Configured Bottleneck instance
 *
 * @example
 * const limiter = createRateLimiter({ maxConcurrent: 10, minTime: 25 }, 'helius-rpc');
 * const result = await limiter.schedule(() => fetch(url));
 */
function createRateLimiter(config: RateLimiterConfig, name?: string): Bottleneck {
  const limiter = new Bottleneck({
    maxConcurrent: config.maxConcurrent,
    minTime: config.minTime,
    reservoir: config.reservoir,
    reservoirRefreshAmount: config.reservoirRefreshAmount,
    reservoirRefreshInterval: config.reservoirRefreshInterval,
  });

  // Handle 429 rate limit errors with automatic backoff
  limiter.on('failed', async (error: Error & { status?: number }, jobInfo) => {
    // Check for rate limit error (429)
    if (error.status === 429 || error.message?.includes('429') || error.message?.includes('rate limit')) {
      const delay = 5000; // 5 second backoff
      logger.warn(
        {
          limiter: name,
          attempt: jobInfo.retryCount + 1,
          delay,
        },
        'Rate limited (429), backing off'
      );
      return delay; // Return delay in ms to retry
    }
    // Don't retry other errors
    return undefined;
  });

  // Log when limiter is depleted (hitting limits)
  limiter.on('depleted', () => {
    logger.debug({ limiter: name }, 'Rate limiter reservoir depleted, queuing requests');
  });

  return limiter;
}

export { createRateLimiter, getConfigForTier, RateLimiterConfig, HeliusTier };
