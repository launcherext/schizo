/**
 * Moralis API client for Solana token discovery
 *
 * Features:
 * - Trending tokens
 * - Top gainers/losers
 * - Token search
 * - Security scores
 *
 * Docs: https://docs.moralis.com/web3-data-api/solana
 */

import { createLogger } from '../lib/logger.js';

const logger = createLogger('moralis');

const BASE_URL = 'https://deep-index.moralis.io/api/v2.2';

/**
 * Moralis token response
 */
export interface MoralisToken {
  tokenAddress: string;
  name: string;
  symbol: string;
  logo?: string;
  decimals: number;
  priceUsd: number;
  priceChange24h?: number;
  priceChange1h?: number;
  priceChange5m?: number;
  volume24h?: number;
  volume1h?: number;
  marketCap?: number;
  fullyDilutedValuation?: number;
  liquidity?: number;
  securityScore?: number;
  holders?: number;
  buyers24h?: number;
  sellers24h?: number;
  buyVolume24h?: number;
  sellVolume24h?: number;
  netVolume24h?: number;
  experiencedBuyerCount?: number;
  // Timestamps
  createdAt?: string;
  // Social links
  twitter?: string;
  telegram?: string;
  website?: string;
}

/**
 * Trending token with additional metadata
 */
export interface TrendingToken extends MoralisToken {
  rank: number;
  trendingScore?: number;
}

/**
 * Top gainer/loser token
 */
export interface GainerLoserToken extends MoralisToken {
  priceChangePercent: number;
  timeFrame: string;
}

/**
 * Moralis API response wrapper
 */
interface MoralisResponse<T> {
  result: T[];
  cursor?: string;
  page?: number;
  pageSize?: number;
}

/**
 * Configuration for Moralis client
 */
export interface MoralisConfig {
  apiKey: string;
  /** Rate limit delay between requests (ms) */
  rateLimitDelayMs?: number;
}

/**
 * Options for trending tokens
 */
export interface TrendingOptions {
  limit?: number;
  /** Minimum security score (0-100) */
  minSecurityScore?: number;
  /** Minimum market cap in USD */
  minMarketCap?: number;
  /** Minimum liquidity in USD */
  minLiquidity?: number;
}

/**
 * Options for top gainers/losers
 */
export interface GainersLosersOptions {
  limit?: number;
  /** Time frame: 5m, 1h, 4h, 12h, 24h */
  timeFrame?: '5m' | '1h' | '4h' | '12h' | '24h';
  /** Minimum security score (0-100) */
  minSecurityScore?: number;
  /** Minimum market cap in USD */
  minMarketCap?: number;
}

/**
 * Moralis API client
 */
export class MoralisClient {
  private apiKey: string;
  private rateLimitDelayMs: number;
  private lastRequestTime = 0;

  constructor(config: MoralisConfig) {
    this.apiKey = config.apiKey;
    this.rateLimitDelayMs = config.rateLimitDelayMs ?? 200;

    logger.info('MoralisClient initialized');
  }

  /**
   * Enforce rate limiting
   */
  private async enforceRateLimit(): Promise<void> {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;

    if (timeSinceLastRequest < this.rateLimitDelayMs) {
      await this.sleep(this.rateLimitDelayMs - timeSinceLastRequest);
    }

    this.lastRequestTime = Date.now();
  }

  /**
   * Make authenticated request to Moralis API
   */
  private async request<T>(endpoint: string, params?: Record<string, string | number>): Promise<T> {
    await this.enforceRateLimit();

    const url = new URL(`${BASE_URL}${endpoint}`);

    // Add query params
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null) {
          url.searchParams.set(key, String(value));
        }
      }
    }

    // Always add chain=solana for our use case
    url.searchParams.set('chain', 'solana');

    logger.debug({ endpoint, params }, 'Moralis API request');

    const response = await fetch(url.toString(), {
      headers: {
        'X-API-Key': this.apiKey,
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error({ status: response.status, error: errorText }, 'Moralis API error');
      throw new Error(`Moralis API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    return data as T;
  }

  /**
   * Get trending tokens on Solana
   *
   * Returns tokens trending based on trading activity, volume, and liquidity.
   */
  async getTrendingTokens(options?: TrendingOptions): Promise<TrendingToken[]> {
    const params: Record<string, string | number> = {
      limit: options?.limit ?? 25,
    };

    if (options?.minSecurityScore) {
      params.security_score = options.minSecurityScore;
    }

    if (options?.minMarketCap) {
      params.min_market_cap = options.minMarketCap;
    }

    if (options?.minLiquidity) {
      params.min_liquidity = options.minLiquidity;
    }

    try {
      const response = await this.request<MoralisResponse<TrendingToken>>(
        '/discovery/tokens/trending',
        params
      );

      const tokens = response.result || [];

      logger.info({ count: tokens.length }, 'Fetched trending tokens from Moralis');

      return tokens.map((token, index) => ({
        ...token,
        rank: index + 1,
      }));
    } catch (error) {
      logger.error({ error }, 'Failed to fetch trending tokens');
      throw error;
    }
  }

  /**
   * Get top gaining tokens on Solana
   */
  async getTopGainers(options?: GainersLosersOptions): Promise<GainerLoserToken[]> {
    const params: Record<string, string | number> = {
      limit: options?.limit ?? 25,
      time_frame: options?.timeFrame ?? '24h',
    };

    if (options?.minSecurityScore) {
      params.security_score = options.minSecurityScore;
    }

    if (options?.minMarketCap) {
      params.min_market_cap = options.minMarketCap;
    }

    try {
      const response = await this.request<MoralisResponse<GainerLoserToken>>(
        '/discovery/tokens/top-gainers',
        params
      );

      const tokens = response.result || [];

      logger.info({
        count: tokens.length,
        timeFrame: options?.timeFrame ?? '24h',
      }, 'Fetched top gainers from Moralis');

      return tokens;
    } catch (error) {
      logger.error({ error }, 'Failed to fetch top gainers');
      throw error;
    }
  }

  /**
   * Get top losing tokens on Solana
   */
  async getTopLosers(options?: GainersLosersOptions): Promise<GainerLoserToken[]> {
    const params: Record<string, string | number> = {
      limit: options?.limit ?? 25,
      time_frame: options?.timeFrame ?? '24h',
    };

    if (options?.minSecurityScore) {
      params.security_score = options.minSecurityScore;
    }

    if (options?.minMarketCap) {
      params.min_market_cap = options.minMarketCap;
    }

    try {
      const response = await this.request<MoralisResponse<GainerLoserToken>>(
        '/discovery/tokens/top-losers',
        params
      );

      const tokens = response.result || [];

      logger.info({
        count: tokens.length,
        timeFrame: options?.timeFrame ?? '24h',
      }, 'Fetched top losers from Moralis');

      return tokens;
    } catch (error) {
      logger.error({ error }, 'Failed to fetch top losers');
      throw error;
    }
  }

  /**
   * Search for tokens by name or symbol
   */
  async searchTokens(query: string, limit: number = 10): Promise<MoralisToken[]> {
    try {
      const response = await this.request<MoralisResponse<MoralisToken>>(
        '/tokens/search',
        { query, limit }
      );

      return response.result || [];
    } catch (error) {
      logger.error({ query, error }, 'Failed to search tokens');
      throw error;
    }
  }

  /**
   * Get token metadata by address
   */
  async getToken(tokenAddress: string): Promise<MoralisToken | null> {
    try {
      const response = await this.request<MoralisToken>(
        `/tokens/${tokenAddress}`
      );

      return response;
    } catch (error) {
      logger.warn({ tokenAddress, error }, 'Failed to fetch token');
      return null;
    }
  }

  /**
   * Get token security score
   * Higher = safer (0-100)
   */
  async getSecurityScore(tokenAddress: string): Promise<number | null> {
    const token = await this.getToken(tokenAddress);
    return token?.securityScore ?? null;
  }

  /**
   * Get token bonding status
   * Returns whether token is in bonding phase, graduated, or unknown
   */
  async getTokenBondingStatus(tokenAddress: string): Promise<{
    status: 'bonding' | 'graduated' | 'unknown';
    exchange?: string;
    bondingProgress?: number;
    graduatedAt?: string;
  }> {
    try {
      const response = await this.request<{
        status: string;
        exchange?: string;
        bondingProgress?: number;
        graduatedAt?: string;
      }>(`/token/mainnet/${tokenAddress}/bonding-status`);

      return {
        status: response.status === 'bonding' ? 'bonding'
          : response.status === 'graduated' ? 'graduated'
          : 'unknown',
        exchange: response.exchange,
        bondingProgress: response.bondingProgress,
        graduatedAt: response.graduatedAt,
      };
    } catch (error) {
      logger.debug({ tokenAddress, error }, 'Failed to get bonding status');
      return { status: 'unknown' };
    }
  }

  /**
   * Get tokens currently in bonding phase on an exchange
   * Useful for finding new opportunities
   */
  async getBondingTokens(exchange: 'pumpfun' | 'meteora' = 'pumpfun', limit: number = 20): Promise<MoralisToken[]> {
    try {
      const response = await this.request<MoralisResponse<MoralisToken>>(
        `/token/mainnet/exchange/${exchange}/bonding`,
        { limit }
      );

      logger.info({ exchange, count: response.result?.length ?? 0 }, 'Fetched bonding tokens');
      return response.result || [];
    } catch (error) {
      logger.error({ exchange, error }, 'Failed to fetch bonding tokens');
      return [];
    }
  }

  /**
   * Get recently graduated tokens from an exchange
   * These have moved from bonding curve to DEX (Raydium/Jupiter tradeable)
   */
  async getGraduatedTokens(exchange: 'pumpfun' | 'meteora' = 'pumpfun', limit: number = 20): Promise<MoralisToken[]> {
    try {
      const response = await this.request<MoralisResponse<MoralisToken>>(
        `/token/mainnet/exchange/${exchange}/graduated`,
        { limit }
      );

      logger.info({ exchange, count: response.result?.length ?? 0 }, 'Fetched graduated tokens');
      return response.result || [];
    } catch (error) {
      logger.error({ exchange, error }, 'Failed to fetch graduated tokens');
      return [];
    }
  }

  /**
   * Get new tokens from an exchange
   * Returns the most recently created tokens
   */
  async getNewTokens(exchange: 'pumpfun' | 'meteora' | 'raydium' = 'pumpfun', limit: number = 20): Promise<MoralisToken[]> {
    try {
      const response = await this.request<MoralisResponse<MoralisToken>>(
        `/token/mainnet/exchange/${exchange}/new`,
        { limit }
      );

      logger.info({ exchange, count: response.result?.length ?? 0 }, 'Fetched new tokens');
      return response.result || [];
    } catch (error) {
      logger.error({ exchange, error }, 'Failed to fetch new tokens');
      return [];
    }
  }

  /**
   * Get swaps/trades for a token
   * Useful for analyzing trading patterns
   */
  async getTokenSwaps(tokenAddress: string, limit: number = 50): Promise<Array<{
    signature: string;
    timestamp: number;
    type: 'buy' | 'sell';
    solAmount: number;
    tokenAmount: number;
    wallet: string;
  }>> {
    try {
      interface SwapResponse {
        signature: string;
        blockTime: number;
        side: string;
        solAmount: number;
        tokenAmount: number;
        wallet: string;
      }

      const response = await this.request<{ result: SwapResponse[] }>(
        `/token/mainnet/${tokenAddress}/swaps`,
        { limit }
      );

      return (response.result || []).map(swap => ({
        signature: swap.signature,
        timestamp: swap.blockTime * 1000,
        type: swap.side === 'buy' ? 'buy' : 'sell',
        solAmount: swap.solAmount,
        tokenAmount: swap.tokenAmount,
        wallet: swap.wallet,
      }));
    } catch (error) {
      logger.debug({ tokenAddress, error }, 'Failed to fetch token swaps');
      return [];
    }
  }

  /**
   * Convert Moralis token to format compatible with trading loop
   */
  static toTradingLoopFormat(token: MoralisToken | TrendingToken): {
    address: string;
    symbol: string;
    name: string;
    price: number;
    priceChange24h: number;
    priceChange1h: number;
    priceChange5m: number;
    volume24h: number;
    volume1h: number;
    liquidity: number;
    marketCap: number;
    securityScore: number;
    holders: number;
  } {
    return {
      address: token.tokenAddress,
      symbol: token.symbol,
      name: token.name,
      price: token.priceUsd ?? 0,
      priceChange24h: token.priceChange24h ?? 0,
      priceChange1h: token.priceChange1h ?? 0,
      priceChange5m: token.priceChange5m ?? 0,
      volume24h: token.volume24h ?? 0,
      volume1h: token.volume1h ?? 0,
      liquidity: token.liquidity ?? 0,
      marketCap: token.marketCap ?? 0,
      securityScore: token.securityScore ?? 0,
      holders: token.holders ?? 0,
    };
  }

  /**
   * Utility sleep function
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Singleton instance (will be initialized when API key is available)
let moralisClient: MoralisClient | null = null;

/**
 * Get or create Moralis client singleton
 * Auto-initializes from MORALIS_API_KEY environment variable
 */
export function getMoralisClient(): MoralisClient | null {
  if (moralisClient) return moralisClient;

  const apiKey = process.env.MORALIS_API_KEY;
  if (!apiKey) {
    return null;
  }

  moralisClient = new MoralisClient({ apiKey });
  return moralisClient;
}

/**
 * Initialize the Moralis client with explicit API key
 */
export function initMoralisClient(apiKey: string): MoralisClient {
  moralisClient = new MoralisClient({ apiKey });
  return moralisClient;
}
