/**
 * Type definitions for Phase 2 analysis capabilities.
 * 
 * Includes types for:
 * - Token safety analysis (honeypot detection)
 * - Wallet performance analysis (P&L calculation)
 * - Smart money identification
 */

/**
 * Response from Helius DAS API getAsset method.
 * Source: QuickNode DAS API docs / Helius DAS API
 */
export interface GetAssetResponse {
  interface: string;
  id: string;
  content: {
    metadata: { name: string; symbol: string };
  };
  authorities: Array<{ address: string; scopes: string[] }>;
  ownership: {
    frozen: boolean;
    owner: string;
  };
  token_info?: {
    supply: number;
    decimals: number;
    token_program: string;
    mint_authority: string | null;
    freeze_authority: string | null;
  };
  mint_extensions?: {
    permanent_delegate?: { delegate: string };
    transfer_fee_config?: {
      transfer_fee_basis_points: number;
      maximum_fee: number;
    };
    transfer_hook?: { program_id: string };
  };
  mutable: boolean;
}

/**
 * Token risk types for honeypot detection.
 */
export type TokenRisk =
  | 'MINT_AUTHORITY_ACTIVE'
  | 'FREEZE_AUTHORITY_ACTIVE'
  | 'PERMANENT_DELEGATE'
  | 'HIGH_TRANSFER_FEE'
  | 'TRANSFER_HOOK'
  | 'MUTABLE_METADATA';

/**
 * Result of token safety analysis.
 */
export interface TokenSafetyResult {
  mint: string;
  isSafe: boolean;
  risks: TokenRisk[];
  authorities: {
    mintAuthority: string | null;
    freezeAuthority: string | null;
    updateAuthority: string | null;
  };
  extensions: {
    hasPermanentDelegate: boolean;
    hasTransferFee: boolean;
    hasTransferHook: boolean;
    permanentDelegateAddress?: string;
    transferFeePercent?: number;
  };
  metadata: {
    isMutable: boolean;
  };
  timestamp: number;
}

/**
 * Parsed trade from transaction history.
 */
export interface ParsedTrade {
  signature: string;
  timestamp: number;
  type: 'BUY' | 'SELL';
  tokenMint: string;
  tokenAmount: number;
  solAmount: number;
  pricePerToken: number;
  dex: string;
}

/**
 * Position tracking for P&L calculation.
 */
export interface Position {
  tokenMint: string;
  entries: ParsedTrade[];
  exits: ParsedTrade[];
  realizedPnL: number;
  isOpen: boolean;
}

/**
 * Wallet analysis result with trading metrics.
 */
export interface WalletAnalysis {
  address: string;
  metrics: {
    totalTrades: number;
    wins: number;
    losses: number;
    winRate: number;
    totalRealizedPnL: number;
    totalROI: number;
    avgHoldTime: number;
    tokensTraded: number;
  };
  tradingPattern: 'sniper' | 'holder' | 'flipper' | 'unknown';
  isSmartMoney: boolean;
  smartMoneyScore: number;
  lastAnalyzed: number;
}

/**
 * Thresholds for smart money classification.
 */
export interface SmartMoneyThresholds {
  minTrades: number;
  minWinRate: number;
  minRealizedPnL: number;
  minROI: number;
  analysisWindowDays: number;
}

/**
 * Default smart money thresholds.
 * Source: Nansen methodology
 */
export const DEFAULT_THRESHOLDS: SmartMoneyThresholds = {
  minTrades: 10,
  minWinRate: 0.65,
  minRealizedPnL: 50,
  minROI: 100,
  analysisWindowDays: 30,
};

/**
 * Cache TTL recommendations for different analysis types.
 */
export const CACHE_TTL = {
  tokenSafety: 24 * 60 * 60 * 1000,     // 24 hours
  walletAnalysis: 6 * 60 * 60 * 1000,   // 6 hours
  smartMoney: 24 * 60 * 60 * 1000,      // 24 hours
};
