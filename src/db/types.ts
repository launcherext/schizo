export interface DBConfig {
  postgresUrl: string;
  sqlitePath: string;
}

export interface TokenRecord {
  mint: string;
  name: string;
  symbol: string;
  decimals: number;
  created_at: Date;
  creator: string;
  mint_revoked: boolean;
  freeze_revoked: boolean;
  image_url: string | null;
  last_updated: Date;
}

export interface PriceRecord {
  id: number;
  mint: string;
  price_sol: number;
  price_usd: number;
  volume_24h: number;
  market_cap_sol: number;
  liquidity: number;
  timestamp: Date;
}

export interface TradeRecordDB {
  id: string;
  mint: string;
  symbol: string;
  action: number;
  entry_price: number;
  exit_price: number | null;
  amount: number;
  amount_sol: number;
  entry_time: Date;
  exit_time: Date | null;
  pnl_sol: number | null;
  pnl_percent: number | null;
  duration_ms: number | null;
  features_json: string;
  regime: number;
  pump_phase: string;
  exit_reason: string | null;
  slippage: number | null;
  fees: number | null;
}

export interface PositionRecord {
  id: string;
  mint: string;
  symbol: string;
  entry_price: number;
  current_price: number;
  amount: number;
  amount_sol: number;
  entry_time: Date;
  last_update: Date;
  highest_price: number;
  lowest_price: number;
  stop_loss: number;
  take_profit_json: string;
  tp_sold_json: string;
  trailing_stop: number | null;
  status: string;
  pool_type: string;
  // Performance-based TP tracking
  initial_recovered?: boolean;
  scaled_exits_taken?: number;
  initial_investment?: number;
  realized_pnl?: number;
}

export interface ModelRecord {
  id: number;
  version: number;
  weights_json: string;
  metrics_json: string;
  created_at: Date;
}

export interface ConfigRecord {
  key: string;
  value: string;
  updated_at: Date;
}

export interface EquitySnapshotRecord {
  id: number;
  timestamp: Date;
  wallet_balance_sol: number;
  positions_value_sol: number;
  total_equity_sol: number;
  unrealized_pnl_sol: number;
  position_count: number;
  source: 'periodic' | 'trade_close' | 'startup';
}

export interface PartialCloseRecord {
  id: number;
  position_id: string;
  mint: string;
  close_type: 'initial_recovery' | 'scaled_exit' | 'tp_level';
  sell_amount_tokens: number;
  sell_amount_sol: number;
  price_at_close: number;
  pnl_sol: number;
  fees_sol: number;
  timestamp: Date;
}

export interface WalletSyncLogRecord {
  id: number;
  timestamp: Date;
  sol_balance: number;
  token_positions_json: string;
  discrepancies_json: string;
}

export interface C100ClaimRecord {
  id: number;
  source: 'pump_creator' | 'pump_referral' | 'meteora_dbc';
  amount_sol: number;
  signature: string | null;
  status: 'success' | 'failed' | 'pending';
  timestamp: Date;
}

export interface C100BuybackRecord {
  id: number;
  amount_sol: number;
  amount_tokens: number | null;
  price_sol: number | null;
  source: 'profit_share' | 'manual';
  signature: string | null;
  status: 'success' | 'failed' | 'pending';
  timestamp: Date;
}
