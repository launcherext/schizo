import { PublicKey } from '@solana/web3.js';

export interface SwapQuote {
  inputMint: string;
  outputMint: string;
  inputAmount: number;
  outputAmount: number;
  priceImpact: number;
  slippageBps: number;
  route: SwapRoute[];
  fees: SwapFees;
}

export interface SwapRoute {
  dex: string;
  poolAddress: string;
  inputMint: string;
  outputMint: string;
  inputAmount: number;
  outputAmount: number;
}

export interface SwapFees {
  platformFee: number;
  networkFee: number;
  priorityFee: number;
  totalFee: number;
}

export interface SwapResult {
  success: boolean;
  signature?: string;
  inputAmount: number;
  outputAmount: number;
  priceImpact: number;
  fees: SwapFees;
  error?: string;
  timestamp: Date;
}

export interface JitoBundleResult {
  success: boolean;
  bundleId?: string;
  signatures: string[];
  tipAmount: number;
  landedSlot?: number;
  error?: string;
}

export interface TransactionConfig {
  priorityFee: number;
  maxRetries: number;
  confirmationTimeout: number;
  useJito: boolean;
  jitoTip: number;
}

export interface PendingTransaction {
  id: string;
  signature?: string;
  type: 'buy' | 'sell';
  mint: string;
  inputAmount: number;
  expectedOutput: number;
  status: 'pending' | 'confirmed' | 'failed';
  retries: number;
  createdAt: Date;
  confirmedAt?: Date;
  error?: string;
}

export interface ExecutionMetrics {
  totalTransactions: number;
  successRate: number;
  avgSlippage: number;
  avgConfirmationTime: number;
  totalFeesPaid: number;
  jitoSuccessRate: number;
}
