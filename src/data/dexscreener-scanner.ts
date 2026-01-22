import { EventEmitter } from 'events';
import { createChildLogger } from '../utils/logger';

const logger = createChildLogger('dexscreener-scanner');

export interface TrendingTokenData {
  mint: string;
  symbol: string;
  name: string;
  volume24h: number;
  buyPressure: number;
  priceChange5m: number;
  priceChange1h: number;
  liquidityUsd: number;
  marketCapUsd: number;
}

interface DexScreenerPair {
  baseToken: {
    address: string;
    symbol: string;
    name: string;
  };
  quoteToken: {
    address: string;
    symbol: string;
  };
  priceUsd: string;
  priceNative: string;
  volume: {
    h24: number;
    h1: number;
    m5: number;
  };
  priceChange: {
    m5: number;
    h1: number;
    h24: number;
  };
  txns: {
    m5: { buys: number; sells: number };
    h1: { buys: number; sells: number };
    h24: { buys: number; sells: number };
  };
  liquidity: {
    usd: number;
  };
  fdv: number;
  marketCap: number;
}

interface DexScreenerResponse {
  pairs: DexScreenerPair[];
}

export class DexScreenerScanner extends EventEmitter {
  private scanInterval: NodeJS.Timeout | null = null;
  private seenTokens: Set<string> = new Set();
  private scanIntervalMs = 120000; // 2 minutes between scans
  private maxSeenTokens = 1000;

  constructor() {
    super();
  }

  async start(): Promise<void> {
    logger.info('Starting DexScreener scanner');

    // Initial scan
    await this.scanTrending();

    // Periodic scans
    this.scanInterval = setInterval(() => {
      this.scanTrending().catch(err =>
        logger.error({ err }, 'DexScreener scan failed')
      );
    }, this.scanIntervalMs);

    logger.info({ intervalMs: this.scanIntervalMs }, 'DexScreener scanner started');
  }

  stop(): void {
    if (this.scanInterval) {
      clearInterval(this.scanInterval);
      this.scanInterval = null;
    }
    logger.info('DexScreener scanner stopped');
  }

  private async scanTrending(): Promise<void> {
    try {
      // Fetch top Solana pairs by 24h volume
      const response = await fetch(
        'https://api.dexscreener.com/latest/dex/tokens/solana',
        {
          headers: {
            'Accept': 'application/json',
          },
        }
      );

      if (!response.ok) {
        logger.warn({ status: response.status }, 'DexScreener API returned non-OK status');
        return;
      }

      const data = await response.json() as DexScreenerResponse;

      if (!data.pairs || !Array.isArray(data.pairs)) {
        logger.warn('No pairs in DexScreener response');
        return;
      }

      let foundCount = 0;

      // Process top 50 pairs by volume
      for (const pair of data.pairs.slice(0, 50)) {
        if (!pair.baseToken?.address || !pair.txns?.m5) continue;

        const mint = pair.baseToken.address;

        // Skip if we've already seen this token recently
        if (this.seenTokens.has(mint)) continue;

        // Check if it meets our entry conditions
        if (this.meetsEntryConditions(pair)) {
          const buyPressure = pair.txns.m5.buys / (pair.txns.m5.buys + pair.txns.m5.sells + 0.001);

          const trendingData: TrendingTokenData = {
            mint,
            symbol: pair.baseToken.symbol || 'UNKNOWN',
            name: pair.baseToken.name || 'Unknown',
            volume24h: pair.volume?.h24 || 0,
            buyPressure,
            priceChange5m: pair.priceChange?.m5 || 0,
            priceChange1h: pair.priceChange?.h1 || 0,
            liquidityUsd: pair.liquidity?.usd || 0,
            marketCapUsd: pair.marketCap || pair.fdv || 0,
          };

          logger.info({
            mint: mint.substring(0, 15),
            symbol: trendingData.symbol,
            buyPressure: (buyPressure * 100).toFixed(0) + '%',
            priceChange5m: trendingData.priceChange5m.toFixed(1) + '%',
            volume24h: trendingData.volume24h.toFixed(0),
          }, 'Trending token detected');

          this.seenTokens.add(mint);
          this.emit('trendingToken', trendingData);
          foundCount++;
        }
      }

      if (foundCount > 0) {
        logger.info({ found: foundCount }, 'DexScreener scan completed');
      }

      // Cleanup old seen tokens
      if (this.seenTokens.size > this.maxSeenTokens) {
        const arr = Array.from(this.seenTokens);
        const toRemove = arr.slice(0, arr.length - 500);
        for (const mint of toRemove) {
          this.seenTokens.delete(mint);
        }
      }

    } catch (error) {
      logger.error({ error }, 'Failed to scan DexScreener');
    }
  }

  private meetsEntryConditions(pair: DexScreenerPair): boolean {
    // Must have transaction data
    if (!pair.txns?.m5) return false;

    const buys = pair.txns.m5.buys || 0;
    const sells = pair.txns.m5.sells || 0;
    const total = buys + sells;

    // Must have activity
    if (total < 5) return false;

    // 60%+ buy pressure in last 5 min
    const buyPressure = buys / (total + 0.001);
    if (buyPressure < 0.6) return false;

    // Positive price change but not already mooned (< 50%)
    const priceChange5m = pair.priceChange?.m5 || 0;
    if (priceChange5m < 0 || priceChange5m > 50) return false;

    // Minimum liquidity
    const liquidityUsd = pair.liquidity?.usd || 0;
    if (liquidityUsd < 5000) return false;

    // Not too large (avoid already-established tokens)
    const marketCap = pair.marketCap || pair.fdv || 0;
    if (marketCap > 10_000_000) return false; // Under $10M mcap

    return true;
  }

  // Manual trigger for testing
  async scanNow(): Promise<void> {
    await this.scanTrending();
  }
}

export const dexscreenerScanner = new DexScreenerScanner();
