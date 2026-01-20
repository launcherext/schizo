/**
 * DexScreener API Client
 * https://docs.dexscreener.com/api/reference
 */

import { createLogger } from '../lib/logger.js';

const logger = createLogger('dexscreener');

const BASE_URL = 'https://api.dexscreener.com';

/**
 * Token pair data from DexScreener
 */
export interface DexPair {
  chainId: string;
  dexId: string;
  url: string;
  pairAddress: string;
  baseToken: {
    address: string;
    name: string;
    symbol: string;
  };
  quoteToken: {
    address: string;
    name: string;
    symbol: string;
  };
  priceNative: string;
  priceUsd: string;
  txns: {
    m5: { buys: number; sells: number };
    h1: { buys: number; sells: number };
    h6: { buys: number; sells: number };
    h24: { buys: number; sells: number };
  };
  volume: {
    h24: number;
    h6: number;
    h1: number;
    m5: number;
  };
  priceChange: {
    m5: number;
    h1: number;
    h6: number;
    h24: number;
  };
  liquidity?: {
    usd: number;
    base: number;
    quote: number;
  };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
  info?: {
    imageUrl?: string;
    websites?: { label: string; url: string }[];
    socials?: { type: string; url: string }[];
  };
  boosts?: {
    active: number;
  };
}

/**
 * Enriched token metadata
 */
export interface TokenMetadata {
  mint: string;
  name: string;
  symbol: string;
  priceUsd: number;
  priceChange5m: number;
  priceChange1h: number;
  priceChange24h: number;
  volume24h: number;
  volume1h: number;
  liquidity: number;
  marketCap: number;
  fdv: number;
  buys5m: number;
  sells5m: number;
  buys1h: number;
  sells1h: number;
  pairAddress: string;
  dexUrl: string;
  imageUrl?: string;
  createdAt?: number;
  ageMinutes?: number;
}

/**
 * DexScreener API Client
 */
export class DexScreenerClient {
  private cache = new Map<string, { data: TokenMetadata; timestamp: number }>();
  private cacheTtlMs = 30000; // 30 second cache

  /**
   * Get token metadata by mint address
   */
  async getTokenMetadata(mint: string): Promise<TokenMetadata | null> {
    // Check cache
    const cached = this.cache.get(mint);
    if (cached && Date.now() - cached.timestamp < this.cacheTtlMs) {
      return cached.data;
    }

    try {
      const response = await fetch(`${BASE_URL}/tokens/v1/solana/${mint}`);

      if (!response.ok) {
        logger.warn({ mint, status: response.status }, 'Failed to fetch token metadata');
        return null;
      }

      const pairs = await response.json() as DexPair[];

      if (!pairs || pairs.length === 0) {
        logger.debug({ mint }, 'No pairs found for token');
        return null;
      }

      // Use the pair with highest liquidity
      const pair = pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];

      const metadata = this.pairToMetadata(pair);

      // Cache it
      this.cache.set(mint, { data: metadata, timestamp: Date.now() });

      return metadata;
    } catch (error) {
      logger.error({ mint, error }, 'Error fetching token metadata');
      return null;
    }
  }

  /**
   * Get latest token pairs on Solana (for finding new tokens)
   */
  async getLatestTokens(limit: number = 20): Promise<TokenMetadata[]> {
    try {
      const response = await fetch(`${BASE_URL}/token-profiles/latest/v1`);

      if (!response.ok) {
        logger.warn({ status: response.status }, 'Failed to fetch latest tokens');
        return [];
      }

      const profiles = await response.json() as Array<{
        url: string;
        chainId: string;
        tokenAddress: string;
        icon?: string;
        description?: string;
      }>;

      // Filter for Solana tokens
      const solanaTokens = profiles
        .filter(p => p.chainId === 'solana')
        .slice(0, limit);

      // Fetch metadata for each
      const results: TokenMetadata[] = [];
      for (const token of solanaTokens) {
        const metadata = await this.getTokenMetadata(token.tokenAddress);
        if (metadata) {
          if (token.icon) metadata.imageUrl = token.icon;
          results.push(metadata);
        }
      }

      return results;
    } catch (error) {
      logger.error({ error }, 'Error fetching latest tokens');
      return [];
    }
  }

  /**
   * Get boosted tokens (paid promotion = often new launches)
   */
  async getBoostedTokens(): Promise<TokenMetadata[]> {
    try {
      const response = await fetch(`${BASE_URL}/token-boosts/latest/v1`);

      if (!response.ok) {
        logger.warn({ status: response.status }, 'Failed to fetch boosted tokens');
        return [];
      }

      const boosts = await response.json() as Array<{
        url: string;
        chainId: string;
        tokenAddress: string;
        amount: number;
        totalAmount: number;
        icon?: string;
      }>;

      // Filter for Solana
      const solanaBoosts = boosts.filter(b => b.chainId === 'solana');

      const results: TokenMetadata[] = [];
      for (const boost of solanaBoosts.slice(0, 10)) {
        const metadata = await this.getTokenMetadata(boost.tokenAddress);
        if (metadata) {
          if (boost.icon) metadata.imageUrl = boost.icon;
          results.push(metadata);
        }
      }

      return results;
    } catch (error) {
      logger.error({ error }, 'Error fetching boosted tokens');
      return [];
    }
  }

  /**
   * Search for tokens by name/symbol
   */
  async searchTokens(query: string): Promise<TokenMetadata[]> {
    try {
      const response = await fetch(`${BASE_URL}/latest/dex/search?q=${encodeURIComponent(query)}`);

      if (!response.ok) {
        return [];
      }

      const data = await response.json() as { pairs: DexPair[] };

      // Filter for Solana pairs
      const solanaPairs = (data.pairs || []).filter(p => p.chainId === 'solana');

      return solanaPairs.map(p => this.pairToMetadata(p));
    } catch (error) {
      logger.error({ query, error }, 'Error searching tokens');
      return [];
    }
  }

  /**
   * Convert DexPair to TokenMetadata
   */
  private pairToMetadata(pair: DexPair): TokenMetadata {
    const now = Date.now();
    const createdAt = pair.pairCreatedAt;
    const ageMinutes = createdAt ? Math.floor((now - createdAt) / 60000) : undefined;

    return {
      mint: pair.baseToken.address,
      name: pair.baseToken.name,
      symbol: pair.baseToken.symbol,
      priceUsd: parseFloat(pair.priceUsd) || 0,
      priceChange5m: pair.priceChange?.m5 || 0,
      priceChange1h: pair.priceChange?.h1 || 0,
      priceChange24h: pair.priceChange?.h24 || 0,
      volume24h: pair.volume?.h24 || 0,
      volume1h: pair.volume?.h1 || 0,
      liquidity: pair.liquidity?.usd || 0,
      marketCap: pair.marketCap || 0,
      fdv: pair.fdv || 0,
      buys5m: pair.txns?.m5?.buys || 0,
      sells5m: pair.txns?.m5?.sells || 0,
      buys1h: pair.txns?.h1?.buys || 0,
      sells1h: pair.txns?.h1?.sells || 0,
      pairAddress: pair.pairAddress,
      dexUrl: pair.url,
      imageUrl: pair.info?.imageUrl,
      createdAt,
      ageMinutes,
    };
  }

  /**
   * Clear the cache
   */
  clearCache(): void {
    this.cache.clear();
  }
}

// Singleton instance
export const dexscreener = new DexScreenerClient();
