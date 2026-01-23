import { EventEmitter } from 'events';
import { config, SOL_MINT } from '../config/settings';
import { createChildLogger } from '../utils/logger';
import { PriceData, HolderInfo, LiquidityPool, TokenInfo } from './types';
import { pumpPortalWs } from './pumpportal-ws';

const logger = createChildLogger('price-feed');

interface JupiterPriceResponse {
  data: {
    [mint: string]: {
      id: string;
      mintSymbol: string;
      vsToken: string;
      vsTokenSymbol: string;
      price: number;
    };
  };
  timeTaken: number;
}

interface DexScreenerPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  baseToken: {
    address: string;
    name: string;
    symbol: string;
  };
  quoteToken?: {
    address: string;
    name: string;
    symbol: string;
  };
  priceNative: string;
  priceUsd: string;
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
  liquidity: {
    usd: number;
    base: number;
    quote: number;
  };
  fdv: number;
  marketCap: number;
  txns: {
    m5: { buys: number; sells: number };
    h1: { buys: number; sells: number };
    h24: { buys: number; sells: number };
  };
}

interface DexScreenerResponse {
  schemaVersion: string;
  pairs: DexScreenerPair[] | null;
}

export class PriceFeed extends EventEmitter {
  private priceCache: Map<string, PriceData> = new Map();
  private priceHistory: Map<string, PriceData[]> = new Map();
  private watchList: Set<string> = new Set();
  private updateInterval: NodeJS.Timeout | null = null;
  private solPrice: number = 0;

  constructor() {
    super();
  }

  async start(): Promise<void> {
    // Get initial SOL price
    await this.updateSolPrice();

    // Start periodic updates
    this.updateInterval = setInterval(() => {
      this.updateWatchedTokens();
    }, config.priceCheckIntervalMs);

    logger.info('Price feed started');
  }

  stop(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
    logger.info('Price feed stopped');
  }

  addToWatchList(mint: string): void {
    this.watchList.add(mint);
    logger.debug({ mint }, 'Added to watch list');
    // Fetch immediately
    this.fetchTokenPrice(mint);
  }

  removeFromWatchList(mint: string): void {
    this.watchList.delete(mint);
    this.priceCache.delete(mint);
    this.priceHistory.delete(mint);
    logger.debug({ mint }, 'Removed from watch list');
  }

  getPrice(mint: string): PriceData | null {
    return this.priceCache.get(mint) || null;
  }

  getPriceHistory(mint: string, limit: number = 60): PriceData[] {
    const history = this.priceHistory.get(mint) || [];
    return history.slice(-limit);
  }

  getSolPrice(): number {
    return this.solPrice;
  }

  private async updateSolPrice(): Promise<void> {
    try {
      // Use DexScreener for SOL price (free API)
      const response = await fetch(
        `${config.dexScreenerApi}/${SOL_MINT}`
      );
      const data = await response.json() as DexScreenerResponse;

      if (data.pairs && data.pairs.length > 0) {
        // Get SOL/USDT or SOL/USDC pair price
        const usdPair = data.pairs.find(p =>
          p.quoteToken?.symbol === 'USDT' || p.quoteToken?.symbol === 'USDC'
        );
        if (usdPair) {
          this.solPrice = parseFloat(usdPair.priceUsd) || 0;
          return;
        }
      }

      // Fallback: hardcoded reasonable price if API fails
      if (this.solPrice === 0) {
        this.solPrice = 130; // Approximate SOL price as fallback
        logger.warn('Using fallback SOL price');
      }
    } catch (error) {
      logger.error({ error }, 'Failed to fetch SOL price');
      if (this.solPrice === 0) {
        this.solPrice = 130; // Fallback
      }
    }
  }

  private async updateWatchedTokens(): Promise<void> {
    // Update SOL price every 10 iterations
    if (Math.random() < 0.1) {
      await this.updateSolPrice();
    }

    // Update all watched tokens
    const promises = Array.from(this.watchList).map((mint) =>
      this.fetchTokenPrice(mint).catch((err) =>
        logger.error({ mint, error: err.message }, 'Failed to update price')
      )
    );

    await Promise.all(promises);
  }

  async fetchTokenPrice(mint: string): Promise<PriceData | null> {
    try {
      // For Pump.fun tokens, try PumpPortal first (bonding curve tokens aren't on DEX)
      if (mint.endsWith('pump')) {
        const pumpData = this.fetchFromPumpPortal(mint);
        if (pumpData) {
          this.updateCache(mint, pumpData);
          return pumpData;
        }
      }

      // Use DexScreener for price data (free API)
      const dexData = await this.fetchFromDexScreener(mint);
      if (dexData) {
        this.updateCache(mint, dexData);
        return dexData;
      }

      return null;
    } catch (error) {
      logger.error({ mint, error }, 'Failed to fetch token price');
      return null;
    }
  }

  private fetchFromPumpPortal(mint: string): PriceData | null {
    const bondingCurve = pumpPortalWs.getBondingCurveData(mint);
    if (!bondingCurve) {
      return null;
    }

    const prevData = this.priceCache.get(mint);
    const history = this.priceHistory.get(mint) || [];

    // Calculate price changes from history
    const price1mAgo = history.length >= 6 ? history[history.length - 6]?.priceSol : bondingCurve.priceSol;
    const price5mAgo = history.length >= 30 ? history[history.length - 30]?.priceSol : bondingCurve.priceSol;

    const priceData: PriceData = {
      mint,
      priceUsd: bondingCurve.priceSol * this.solPrice,
      priceSol: bondingCurve.priceSol,
      volume24h: 0, // Not available from bonding curve
      marketCapSol: bondingCurve.marketCapSol,
      liquidity: bondingCurve.liquiditySol * this.solPrice,
      priceChange1m: price1mAgo > 0 ? ((bondingCurve.priceSol - price1mAgo) / price1mAgo) * 100 : 0,
      priceChange5m: price5mAgo > 0 ? ((bondingCurve.priceSol - price5mAgo) / price5mAgo) * 100 : 0,
      priceChange1h: 0, // Not available
      timestamp: bondingCurve.timestamp,
    };

    return priceData;
  }

  private async fetchFromDexScreener(mint: string): Promise<PriceData | null> {
    try {
      const response = await fetch(`${config.dexScreenerApi}/${mint}`);
      const data = await response.json() as DexScreenerResponse;

      if (!data.pairs || data.pairs.length === 0) {
        return null;
      }

      // Get the pair with highest liquidity
      const pair = data.pairs.reduce((best, current) =>
        (current.liquidity?.usd || 0) > (best.liquidity?.usd || 0) ? current : best
      );

      const priceSol = parseFloat(pair.priceNative) || 0;
      const priceUsd = parseFloat(pair.priceUsd) || priceSol * this.solPrice;

      const prevData = this.priceCache.get(mint);
      const history = this.priceHistory.get(mint) || [];

      // Calculate price changes
      const price1mAgo = history.length >= 6 ? history[history.length - 6]?.priceSol : priceSol;
      const price5mAgo = history.length >= 30 ? history[history.length - 30]?.priceSol : priceSol;

      const priceData: PriceData = {
        mint,
        priceUsd,
        priceSol,
        volume24h: pair.volume?.h24 || 0,
        marketCapSol: pair.fdv ? pair.fdv / this.solPrice : 0,
        liquidity: pair.liquidity?.usd || 0,
        priceChange1m: price1mAgo > 0 ? ((priceSol - price1mAgo) / price1mAgo) * 100 : 0,
        priceChange5m: price5mAgo > 0 ? ((priceSol - price5mAgo) / price5mAgo) * 100 : 0,
        priceChange1h: pair.priceChange?.h1 || 0,
        timestamp: new Date(),
      };

      return priceData;
    } catch (error) {
      logger.debug({ mint, error }, 'DexScreener fetch failed');
      return null;
    }
  }

  private updateCache(mint: string, data: PriceData): void {
    const prevPrice = this.priceCache.get(mint);
    this.priceCache.set(mint, data);

    // Update history
    let history = this.priceHistory.get(mint) || [];
    history.push(data);

    // Keep last 5 minutes of data at 1-second intervals (300 entries)
    if (history.length > 300) {
      history = history.slice(-300);
    }
    this.priceHistory.set(mint, history);

    // Emit price update event
    this.emit('priceUpdate', data);

    // Emit significant price change events
    if (prevPrice) {
      const change = ((data.priceSol - prevPrice.priceSol) / prevPrice.priceSol) * 100;
      if (Math.abs(change) >= 5) {
        this.emit('significantPriceChange', { mint, change, data });
      }
    }
  }

  async getHolderInfo(mint: string): Promise<HolderInfo | null> {
    try {
      // Use Helius DAS getTokenAccounts API - more reliable than getTokenLargestAccounts
      const response = await fetch(
        `https://mainnet.helius-rpc.com/?api-key=${config.heliusApiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 'holder-check',
            method: 'getTokenAccounts',
            params: {
              mint: mint,
              limit: 100,  // Get top 100 holders - enough for concentration check
              displayOptions: {},
            },
          }),
        }
      );

      const data = await response.json() as any;

      if (data.error) {
        logger.warn({ mint: mint.substring(0, 15), error: data.error }, 'Helius DAS error getting holders');
        return null;
      }

      // DAS API returns data in result.token_accounts
      const tokenAccounts = data.result?.token_accounts;
      if (!tokenAccounts || tokenAccounts.length === 0) {
        logger.debug({ mint: mint.substring(0, 15) }, 'No token accounts found via DAS (token may be new)');
        return null;
      }

      // Sort by amount descending to get largest holders
      const sortedAccounts = tokenAccounts.sort((a: any, b: any) => b.amount - a.amount);

      // Calculate total supply from all fetched accounts
      const totalSupply = sortedAccounts.reduce(
        (sum: number, h: { amount: number }) => sum + h.amount,
        0
      );

      const top10 = sortedAccounts.slice(0, 10);
      const top10Supply = top10.reduce(
        (sum: number, h: { amount: number }) => sum + h.amount,
        0
      );

      const concentration = totalSupply > 0 ? top10Supply / totalSupply : 1;

      logger.info({
        mint: mint.substring(0, 15),
        totalHolders: sortedAccounts.length,
        top10Concentration: (concentration * 100).toFixed(1) + '%',
        top1Balance: top10[0]?.amount || 0,
      }, 'Holder info fetched via Helius DAS');

      return {
        mint,
        totalHolders: sortedAccounts.length,
        top10Concentration: concentration,
        top10Holders: top10.map((h: { owner: string; amount: number }) => ({
          address: h.owner,
          balance: h.amount,
          percentage: totalSupply > 0 ? h.amount / totalSupply : 0,
        })),
      };
    } catch (error) {
      logger.error({ mint: mint.substring(0, 15), error }, 'Failed to get holder info');
      return null;
    }
  }

  async getTokenInfo(mint: string): Promise<TokenInfo | null> {
    try {
      const response = await fetch(
        `https://mainnet.helius-rpc.com/?api-key=${config.heliusApiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getAsset',
            params: { id: mint },
          }),
        }
      );

      const data = await response.json() as any;

      if (!data.result) {
        return null;
      }

      const asset = data.result;

      return {
        mint,
        name: asset.content?.metadata?.name || '',
        symbol: asset.content?.metadata?.symbol || '',
        decimals: asset.token_info?.decimals || 9,
        supply: asset.token_info?.supply || 0,
        createdAt: new Date(),
        creator: asset.authorities?.[0]?.address || '',
        mintAuthorityRevoked: !asset.authorities?.some(
          (a: { scopes: string[] }) => a.scopes?.includes('mint')
        ),
        freezeAuthorityRevoked: !asset.authorities?.some(
          (a: { scopes: string[] }) => a.scopes?.includes('freeze')
        ),
      };
    } catch (error) {
      logger.error({ mint, error }, 'Failed to get token info');
      return null;
    }
  }
}

export const priceFeed = new PriceFeed();
