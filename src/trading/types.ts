/**
 * Trading-related type definitions
 */

/**
 * Token information from PumpPortal
 */
export interface TokenInfo {
  mint: string;
  name: string;
  symbol: string;
  price: number; // in SOL
  liquidity: number; // in SOL
  holderCount: number;
}

/**
 * Parameters for executing a trade
 */
export interface TradeParams {
  mint: string;
  amount: number;
  slippage: number; // 0-1, e.g., 0.05 for 5%
}

/**
 * Result of a trade execution
 */
export interface TradeResult {
  signature: string;
  timestamp: number;
  mint: string;
  amount: number;
  price: number;
}

/**
 * Trade action type
 */
export type TradeAction = 'buy' | 'sell';
