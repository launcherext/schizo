export interface TokenInfo {
  mint: string;
  name: string;
  symbol: string;
  decimals: number;
  supply: number;
  createdAt: Date;
  creator: string;
  mintAuthorityRevoked: boolean;
  freezeAuthorityRevoked: boolean;
  imageUrl?: string | null;
}

export interface PriceData {
  mint: string;
  priceUsd: number;
  priceSol: number;
  volume24h: number;
  marketCapSol: number;
  liquidity: number;
  priceChange1m: number;
  priceChange5m: number;
  priceChange1h: number;
  timestamp: Date;
}

export interface TradeData {
  signature: string;
  mint: string;
  side: 'buy' | 'sell';
  amountToken: number;
  amountSol: number;
  trader: string;
  timestamp: Date;
}

export interface WhaleActivity {
  wallet: string;
  action: 'buy' | 'sell' | 'transfer';
  mint: string;
  amount: number;
  amountSol: number;
  timestamp: Date;
}

export interface HolderInfo {
  mint: string;
  totalHolders: number;
  top10Concentration: number;
  top10Holders: Array<{
    address: string;
    balance: number;
    percentage: number;
  }>;
}

export interface LiquidityPool {
  mint: string;
  poolAddress: string;
  dex: string;
  liquiditySol: number;
  liquidityToken: number;
  lpLocked: boolean;
  lpLockedPercent: number;
}

export interface NewTokenEvent {
  mint: string;
  signature: string;
  timestamp: Date;
  creator: string;
  name?: string;
  symbol?: string;
  imageUrl?: string | null;
}

export type DataEventType = 'new_token' | 'price_update' | 'trade' | 'whale_activity';

export interface DataEvent {
  type: DataEventType;
  data: TokenInfo | PriceData | TradeData | WhaleActivity | NewTokenEvent;
  timestamp: Date;
}
