import { EventEmitter } from 'events';
import { createChildLogger } from '../utils/logger';
import { config } from '../config/settings';

const logger = createChildLogger('c100-tracker');

export interface C100TokenData {
  mint: string;
  name: string;
  symbol: string;
  priceSol: number;
  priceUsd: number;
  marketCapUsd: number;
  volume24h: number;
  priceChange24h: number;
  lastUpdated: Date;
}

export class C100Tracker extends EventEmitter {
  private tokenData: C100TokenData | null = null;
  private updateInterval: NodeJS.Timeout | null = null;
  private isRunning = false;

  constructor() {
    super();
  }

  async start(intervalMs: number = 30000): Promise<void> {
    if (!config.c100?.tokenMint) {
      logger.info('C100 tracking disabled - no token mint configured');
      return;
    }

    if (this.isRunning) {
      logger.warn('C100 tracker already running');
      return;
    }

    this.isRunning = true;
    logger.info({ mint: config.c100.tokenMint }, 'Starting C100 price tracker');

    // Initial fetch
    await this.fetchPrice();

    // Start periodic updates
    this.updateInterval = setInterval(async () => {
      try {
        await this.fetchPrice();
      } catch (error) {
        logger.error({ error }, 'Failed to fetch C100 price');
      }
    }, intervalMs);
  }

  stop(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
    this.isRunning = false;
    logger.info('C100 tracker stopped');
  }

  private async fetchPrice(): Promise<void> {
    if (!config.c100?.tokenMint) return;

    try {
      const response = await fetch(
        `https://api.dexscreener.com/latest/dex/tokens/${config.c100.tokenMint}`
      );

      if (!response.ok) {
        throw new Error(`DexScreener API error: ${response.status}`);
      }

      const data = await response.json() as { pairs?: any[] };

      if (!data.pairs || data.pairs.length === 0) {
        logger.warn({ mint: config.c100.tokenMint }, 'No pairs found for C100 token');
        return;
      }

      // Use the pair with highest liquidity
      const pair = data.pairs.reduce((best: any, current: any) => {
        const bestLiq = best?.liquidity?.usd || 0;
        const currLiq = current?.liquidity?.usd || 0;
        return currLiq > bestLiq ? current : best;
      }, data.pairs[0]);

      this.tokenData = {
        mint: config.c100.tokenMint,
        name: pair.baseToken?.name || 'C100',
        symbol: pair.baseToken?.symbol || 'C100',
        priceSol: parseFloat(pair.priceNative) || 0,
        priceUsd: parseFloat(pair.priceUsd) || 0,
        marketCapUsd: pair.marketCap || pair.fdv || 0,
        volume24h: pair.volume?.h24 || 0,
        priceChange24h: pair.priceChange?.h24 || 0,
        lastUpdated: new Date(),
      };

      this.emit('priceUpdate', this.tokenData);

      logger.debug({
        symbol: this.tokenData.symbol,
        priceSol: this.tokenData.priceSol.toExponential(4),
        priceUsd: this.tokenData.priceUsd.toFixed(8),
        marketCap: this.tokenData.marketCapUsd,
      }, 'C100 price updated');
    } catch (error) {
      logger.error({ error }, 'Failed to fetch C100 price from DexScreener');
    }
  }

  private async getSolPrice(): Promise<number> {
    try {
      const response = await fetch(
        'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd'
      );
      const data = await response.json() as { solana?: { usd?: number } };
      return data.solana?.usd || 200;
    } catch {
      return 200; // Fallback
    }
  }

  getTokenData(): C100TokenData | null {
    return this.tokenData;
  }

  isEnabled(): boolean {
    return !!config.c100?.tokenMint && config.c100?.enabled !== false;
  }
}

export const c100Tracker = new C100Tracker();
