/**
 * Birdeye API client for trending tokens and market data
 * https://docs.birdeye.so/
 */

import { logger } from '../lib/logger.js';

const log = logger.child({ module: 'birdeye' });

/**
 * Birdeye API configuration
 */
export interface BirdeyeConfig {
  apiKey: string;
  baseUrl?: string;
}

/**
 * Trending token from Birdeye
 */
export interface BirdeyeToken {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  logoURI?: string;
  // Price data
  price: number;
  priceChange24h: number;
  priceChange1h?: number;
  // Volume & liquidity
  volume24h: number;
  liquidity: number;
  // Market data
  marketCap?: number;
  holder?: number;
  // Social/metadata
  website?: string;
  twitter?: string;
  telegram?: string;
  // Trade data
  trade24h?: number;
  buy24h?: number;
  sell24h?: number;
}

/**
 * Token overview response
 */
export interface TokenOverview {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  price: number;
  priceChange24h: number;
  volume24h: number;
  liquidity: number;
  marketCap: number;
  holder: number;
  trade24h: number;
  buy24h: number;
  sell24h: number;
  // Extensions from Birdeye
  extensions?: {
    website?: string;
    twitter?: string;
    telegram?: string;
    discord?: string;
    description?: string;
  };
}

/**
 * Top traders response
 */
export interface TopTrader {
  address: string;
  volume: number;
  trades: number;
  pnl: number;
  pnlPercent: number;
}

/**
 * Birdeye API client
 */
export class BirdeyeClient {
  private apiKey: string;
  private baseUrl: string;
  private lastRequestTime = 0;
  private readonly MIN_REQUEST_DELAY_MS = 200; // Rate limiting

  constructor(config: BirdeyeConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl || 'https://public-api.birdeye.so';

    log.info('Birdeye client initialized');
  }

  /**
   * Get trending tokens on Solana
   * @param limit - Number of tokens to return (max 50)
   * @param offset - Pagination offset
   */
  async getTrendingTokens(limit: number = 20, offset: number = 0): Promise<BirdeyeToken[]> {
    await this.enforceRateLimit();

    try {
      const response = await fetch(
        `${this.baseUrl}/defi/token_trending?sort_by=rank&sort_type=asc&offset=${offset}&limit=${limit}`,
        {
          headers: {
            'X-API-KEY': this.apiKey,
            'x-chain': 'solana',
          },
        }
      );

      if (!response.ok) {
        throw new Error(`Birdeye API error: ${response.status}`);
      }

      const data = await response.json() as {
        success: boolean;
        data: { tokens: Array<{
          address: string;
          symbol: string;
          name: string;
          decimals: number;
          logoURI?: string;
          price: number;
          price_change_24h_percent?: number;
          volume_24h_usd?: number;
          liquidity?: number;
          mc?: number;
        }> };
      };

      if (!data.success || !data.data?.tokens) {
        return [];
      }

      return data.data.tokens.map(t => ({
        address: t.address,
        symbol: t.symbol,
        name: t.name,
        decimals: t.decimals,
        logoURI: t.logoURI,
        price: t.price || 0,
        priceChange24h: t.price_change_24h_percent || 0,
        volume24h: t.volume_24h_usd || 0,
        liquidity: t.liquidity || 0,
        marketCap: t.mc,
      }));
    } catch (error) {
      log.error({ error }, 'Failed to fetch trending tokens');
      return [];
    }
  }

  /**
   * Get top gainers on Solana
   * @param limit - Number of tokens to return
   * @param timeframe - 1h, 4h, 12h, 24h
   */
  async getTopGainers(limit: number = 20, timeframe: '1h' | '4h' | '12h' | '24h' = '1h'): Promise<BirdeyeToken[]> {
    await this.enforceRateLimit();

    try {
      const response = await fetch(
        `${this.baseUrl}/defi/token_top_gainers?sort_by=price_change_${timeframe}_percent&sort_type=desc&offset=0&limit=${limit}`,
        {
          headers: {
            'X-API-KEY': this.apiKey,
            'x-chain': 'solana',
          },
        }
      );

      if (!response.ok) {
        throw new Error(`Birdeye API error: ${response.status}`);
      }

      const data = await response.json() as {
        success: boolean;
        data: { tokens: Array<{
          address: string;
          symbol: string;
          name: string;
          decimals: number;
          logoURI?: string;
          price: number;
          price_change_24h_percent?: number;
          price_change_1h_percent?: number;
          volume_24h_usd?: number;
          liquidity?: number;
          mc?: number;
        }> };
      };

      if (!data.success || !data.data?.tokens) {
        return [];
      }

      return data.data.tokens.map(t => ({
        address: t.address,
        symbol: t.symbol,
        name: t.name,
        decimals: t.decimals,
        logoURI: t.logoURI,
        price: t.price || 0,
        priceChange24h: t.price_change_24h_percent || 0,
        priceChange1h: t.price_change_1h_percent,
        volume24h: t.volume_24h_usd || 0,
        liquidity: t.liquidity || 0,
        marketCap: t.mc,
      }));
    } catch (error) {
      log.error({ error }, 'Failed to fetch top gainers');
      return [];
    }
  }

  /**
   * Get detailed token overview including socials
   * @param address - Token mint address
   */
  async getTokenOverview(address: string): Promise<TokenOverview | null> {
    await this.enforceRateLimit();

    try {
      const response = await fetch(
        `${this.baseUrl}/defi/token_overview?address=${address}`,
        {
          headers: {
            'X-API-KEY': this.apiKey,
            'x-chain': 'solana',
          },
        }
      );

      if (!response.ok) {
        throw new Error(`Birdeye API error: ${response.status}`);
      }

      const data = await response.json() as {
        success: boolean;
        data: {
          address: string;
          symbol: string;
          name: string;
          decimals: number;
          price: number;
          priceChange24h: number;
          volume24h: number;
          liquidity: number;
          mc: number;
          holder: number;
          trade24h: number;
          buy24h: number;
          sell24h: number;
          extensions?: {
            website?: string;
            twitter?: string;
            telegram?: string;
            discord?: string;
            description?: string;
          };
        };
      };

      if (!data.success || !data.data) {
        return null;
      }

      const t = data.data;
      return {
        address: t.address,
        symbol: t.symbol,
        name: t.name,
        decimals: t.decimals,
        price: t.price,
        priceChange24h: t.priceChange24h,
        volume24h: t.volume24h,
        liquidity: t.liquidity,
        marketCap: t.mc,
        holder: t.holder,
        trade24h: t.trade24h,
        buy24h: t.buy24h,
        sell24h: t.sell24h,
        extensions: t.extensions,
      };
    } catch (error) {
      log.error({ address, error }, 'Failed to fetch token overview');
      return null;
    }
  }

  /**
   * Get token security info
   * @param address - Token mint address
   */
  async getTokenSecurity(address: string): Promise<{
    isHoneypot: boolean;
    hasFreezableToken: boolean;
    hasMintableToken: boolean;
    top10HolderPercent: number;
    creatorPercent: number;
  } | null> {
    await this.enforceRateLimit();

    try {
      const response = await fetch(
        `${this.baseUrl}/defi/token_security?address=${address}`,
        {
          headers: {
            'X-API-KEY': this.apiKey,
            'x-chain': 'solana',
          },
        }
      );

      if (!response.ok) {
        throw new Error(`Birdeye API error: ${response.status}`);
      }

      const data = await response.json() as {
        success: boolean;
        data: {
          ownerAddress: string;
          creatorAddress: string;
          isHoneypot: boolean;
          freezeable: boolean;
          mintable: boolean;
          top10HolderPercent: number;
          creatorPercent: number;
        };
      };

      if (!data.success || !data.data) {
        return null;
      }

      return {
        isHoneypot: data.data.isHoneypot,
        hasFreezableToken: data.data.freezeable,
        hasMintableToken: data.data.mintable,
        top10HolderPercent: data.data.top10HolderPercent,
        creatorPercent: data.data.creatorPercent,
      };
    } catch (error) {
      log.error({ address, error }, 'Failed to fetch token security');
      return null;
    }
  }

  /**
   * Get top traders for a token (potential smart money)
   * @param address - Token mint address
   * @param timeframe - 24h or 7d
   */
  async getTopTraders(address: string, timeframe: '24h' | '7d' = '24h'): Promise<TopTrader[]> {
    await this.enforceRateLimit();

    try {
      const response = await fetch(
        `${this.baseUrl}/defi/v2/tokens/${address}/top_traders?time_frame=${timeframe}`,
        {
          headers: {
            'X-API-KEY': this.apiKey,
            'x-chain': 'solana',
          },
        }
      );

      if (!response.ok) {
        throw new Error(`Birdeye API error: ${response.status}`);
      }

      const data = await response.json() as {
        success: boolean;
        data: { traders: Array<{
          address: string;
          volume: number;
          trade_count: number;
          pnl: number;
          pnl_percent: number;
        }> };
      };

      if (!data.success || !data.data?.traders) {
        return [];
      }

      return data.data.traders.map(t => ({
        address: t.address,
        volume: t.volume,
        trades: t.trade_count,
        pnl: t.pnl,
        pnlPercent: t.pnl_percent,
      }));
    } catch (error) {
      log.error({ address, error }, 'Failed to fetch top traders');
      return [];
    }
  }

  /**
   * Check if token has valid social presence
   */
  async hasValidSocials(address: string): Promise<{ valid: boolean; twitter?: string; website?: string }> {
    const overview = await this.getTokenOverview(address);

    if (!overview?.extensions) {
      return { valid: false };
    }

    const hasTwitter = !!overview.extensions.twitter;
    const hasWebsite = !!overview.extensions.website;

    return {
      valid: hasTwitter || hasWebsite,
      twitter: overview.extensions.twitter,
      website: overview.extensions.website,
    };
  }

  /**
   * Enforce rate limiting
   */
  private async enforceRateLimit(): Promise<void> {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;

    if (timeSinceLastRequest < this.MIN_REQUEST_DELAY_MS) {
      const delay = this.MIN_REQUEST_DELAY_MS - timeSinceLastRequest;
      await new Promise(resolve => setTimeout(resolve, delay));
    }

    this.lastRequestTime = Date.now();
  }
}

// Singleton instance
let birdeyeClient: BirdeyeClient | null = null;

/**
 * Get or create Birdeye client singleton
 */
export function getBirdeyeClient(): BirdeyeClient | null {
  if (birdeyeClient) return birdeyeClient;

  const apiKey = process.env.BIRDEYE_API_KEY;
  if (!apiKey) {
    return null;
  }

  birdeyeClient = new BirdeyeClient({ apiKey });
  return birdeyeClient;
}

export { birdeyeClient };
