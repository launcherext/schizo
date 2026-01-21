/**
 * GeckoTerminal API Client
 * https://www.geckoterminal.com/dex-api
 *
 * Free tier: 30 req/min
 * With CoinGecko Pro API key: 500 req/min
 */

import { createLogger } from '../lib/logger.js';
import type { TokenMetadata } from './dexscreener.js';

const logger = createLogger('gecko-terminal');

const BASE_URL = 'https://api.geckoterminal.com/api/v2';

// CoinGecko API key enables higher rate limits on GeckoTerminal
const COINGECKO_API_KEY = process.env.COIN_GECKO_api || process.env.COINGECKO_API_KEY;

interface GeckoPool {
  id: string;
  attributes: {
    base_token_price_usd: string;
    address: string;
    name: string;
    pool_created_at: string;
    volume_usd: {
      h1: string;
      h24: string;
    };
    price_change_percentage: {
      h1: string;
      h24: string;
    };
    reserve_in_usd: string; // Liquidity
    fdv_usd: string;
    transactions: {
      h1: {
        buys: number;
        sells: number;
      };
      h24: {
        buys: number;
        sells: number;
      };
    };
  };
  relationships: {
    base_token: {
      data: {
        id: string; // usually solana_ADDRESS
      };
    };
    quote_token: {
      data: {
        id: string;
      };
    };
  };
}

export class GeckoTerminalClient {
  /**
   * Get trending pools on Solana
   */
  async getTrendingPools(limit: number = 20): Promise<TokenMetadata[]> {
    try {
      // Build headers - add API key if available for higher rate limits
      const headers: Record<string, string> = {
        'Accept': 'application/json',
        'User-Agent': 'SchizoAgent/1.0'
      };

      // CoinGecko Pro API key unlocks higher rate limits (500 req/min vs 30)
      if (COINGECKO_API_KEY) {
        headers['x-cg-pro-api-key'] = COINGECKO_API_KEY;
        logger.debug('Using CoinGecko Pro API key for GeckoTerminal');
      }

      const response = await fetch(`${BASE_URL}/networks/solana/trending_pools`, {
        headers
      });

      if (!response.ok) {
        const text = await response.text();
        logger.warn({ 
            status: response.status, 
            statusText: response.statusText,
            responseBody: text.slice(0, 200) // Log first 200 chars of body
        }, 'Failed to fetch GeckoTerminal trending pools');
        return [];
      }

      const body = await response.json() as { data: GeckoPool[] };
      const pools = body.data || [];

      return pools.map(pool => this.poolToMetadata(pool));
    } catch (error) {
      logger.error({ error }, 'Error fetching GeckoTerminal trending pools');
      return [];
    }
  }

  /**
   * Get new pools on Solana (recently created)
   * Great for finding new opportunities
   */
  async getNewPools(limit: number = 20): Promise<TokenMetadata[]> {
    try {
      const headers: Record<string, string> = {
        'Accept': 'application/json',
        'User-Agent': 'SchizoAgent/1.0'
      };

      if (COINGECKO_API_KEY) {
        headers['x-cg-pro-api-key'] = COINGECKO_API_KEY;
      }

      const response = await fetch(`${BASE_URL}/networks/solana/new_pools?page=1`, {
        headers
      });

      if (!response.ok) {
        logger.warn({ status: response.status }, 'Failed to fetch GeckoTerminal new pools');
        return [];
      }

      const body = await response.json() as { data: GeckoPool[] };
      const pools = (body.data || []).slice(0, limit);

      logger.info({ count: pools.length }, 'Fetched new pools from GeckoTerminal');
      return pools.map(pool => this.poolToMetadata(pool));
    } catch (error) {
      logger.error({ error }, 'Error fetching GeckoTerminal new pools');
      return [];
    }
  }

  /**
   * Get top gainers on Solana (by price change)
   * Note: GeckoTerminal only supports volume/tx sorting, so we fetch trending and filter client-side
   */
  async getTopGainers(duration: '5m' | '1h' | '6h' | '24h' = '1h', limit: number = 20): Promise<TokenMetadata[]> {
    try {
      const headers: Record<string, string> = {
        'Accept': 'application/json',
        'User-Agent': 'SchizoAgent/1.0'
      };

      if (COINGECKO_API_KEY) {
        headers['x-cg-pro-api-key'] = COINGECKO_API_KEY;
      }

      // Fetch high-volume pools (most likely to have significant price moves)
      const response = await fetch(
        `${BASE_URL}/networks/solana/pools?page=1&sort=h24_volume_usd_desc`,
        { headers }
      );

      if (!response.ok) {
        logger.warn({ status: response.status }, 'Failed to fetch GeckoTerminal pools for gainers');
        return [];
      }

      const body = await response.json() as { data: GeckoPool[] };
      const pools = body.data || [];

      // Convert to metadata and filter for actual gainers
      const allTokens = pools.map(pool => this.poolToMetadata(pool));

      // Sort by price change (based on duration) and filter positive gains
      const priceChangeKey = duration === '24h' ? 'priceChange24h' : 'priceChange1h';
      const gainers = allTokens
        .filter(token => token[priceChangeKey] > 0)
        .sort((a, b) => b[priceChangeKey] - a[priceChangeKey])
        .slice(0, limit);

      logger.info({ count: gainers.length, duration }, 'Fetched top gainers from GeckoTerminal');
      return gainers;
    } catch (error) {
      logger.error({ error }, 'Error fetching GeckoTerminal top gainers');
      return [];
    }
  }

  /**
   * Search for pools by token address or name
   */
  async searchPools(query: string, limit: number = 10): Promise<TokenMetadata[]> {
    try {
      const headers: Record<string, string> = {
        'Accept': 'application/json',
        'User-Agent': 'SchizoAgent/1.0'
      };

      if (COINGECKO_API_KEY) {
        headers['x-cg-pro-api-key'] = COINGECKO_API_KEY;
      }

      const response = await fetch(
        `${BASE_URL}/search/pools?query=${encodeURIComponent(query)}&network=solana`,
        { headers }
      );

      if (!response.ok) {
        logger.warn({ status: response.status, query }, 'Failed to search GeckoTerminal pools');
        return [];
      }

      const body = await response.json() as { data: GeckoPool[] };
      const pools = (body.data || []).slice(0, limit);

      return pools.map(pool => this.poolToMetadata(pool));
    } catch (error) {
      logger.error({ error, query }, 'Error searching GeckoTerminal pools');
      return [];
    }
  }

  /**
   * Convert GeckoPool to TokenMetadata (compatible with our system)
   */
  private poolToMetadata(pool: GeckoPool): TokenMetadata {
    const attr = pool.attributes;
    // base_token id in relationships is usually "solana_MINTADDRESS"
    // We try to parse the mint from the pool data or base token data
    // The pool ID is usually "solana_POOLADDRESS"
    
    // We need the BASE TOKEN MINT. 
    // Usually Gecko API includes included resources for tokens, but we didn't fetch included=base_token.
    // However, for trading we need the mint. 
    // Let's rely on the fact that for most pairs, we can verify the mint later or assume the implementation.
    // Wait - GeckoTerminal doesn't always return the mint in the primary object easily without 'included'.
    // BUT! We can use the 'base_token.data.id'. It is often "solana_MINT".
    
    let mint = 'unknown';
    if (pool.relationships?.base_token?.data?.id) {
       mint = pool.relationships.base_token.data.id.replace('solana_', '');
    }

    const now = Date.now();
    const createdAt = attr.pool_created_at ? new Date(attr.pool_created_at).getTime() : undefined;
    const ageMinutes = createdAt ? Math.floor((now - createdAt) / 60000) : undefined;

    return {
      mint,
      name: attr.name.split(' / ')[0] || 'Unknown', // "BONK / SOL" -> "BONK"
      symbol: attr.name.split(' / ')[0] || 'Unknown',
      priceUsd: parseFloat(attr.base_token_price_usd) || 0,
      priceChange5m: 0, // Not available
      priceChange1h: parseFloat(attr.price_change_percentage?.h1 || '0'),
      priceChange24h: parseFloat(attr.price_change_percentage?.h24 || '0'),
      volume24h: parseFloat(attr.volume_usd?.h24 || '0'),
      volume1h: parseFloat(attr.volume_usd?.h1 || '0'),
      liquidity: parseFloat(attr.reserve_in_usd || '0'),
      marketCap: parseFloat(attr.fdv_usd || '0'), // Using FDV as proxy for MC
      fdv: parseFloat(attr.fdv_usd || '0'),
      buys5m: 0,
      sells5m: 0,
      buys1h: attr.transactions?.h1?.buys || 0,
      sells1h: attr.transactions?.h1?.sells || 0,
      pairAddress: pool.attributes.address,
      dexUrl: `https://www.geckoterminal.com/solana/pools/${pool.attributes.address}`,
      imageUrl: undefined, // Need 'included' to fetch images, skipping for now
      createdAt,
      ageMinutes,
    };
  }
}

export const geckoTerminal = new GeckoTerminalClient();
