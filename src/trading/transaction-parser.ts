/**
 * Transaction Parser - Extracts actual token amounts from confirmed transactions
 */

import { Connection, PublicKey, ParsedTransactionWithMeta } from '@solana/web3.js';
import { logger } from '../lib/logger.js';

/**
 * Parsed trade result with actual amounts
 */
export interface ParsedTradeResult {
  signature: string;
  success: boolean;
  tokenMint: string;
  tokenAmount: number;      // Actual tokens received/sent
  solAmount: number;        // Actual SOL spent/received
  pricePerToken: number;    // SOL per token
  fee: number;              // Transaction fee in SOL
  error?: string;
}

/**
 * Transaction Parser
 *
 * Parses confirmed Solana transactions to extract actual trade amounts.
 * This is critical for accurate P&L tracking since slippage means
 * requested amounts != actual amounts.
 */
export class TransactionParser {
  private connection: Connection;

  constructor(connection: Connection) {
    this.connection = connection;
  }

  /**
   * Parse a trade transaction to get actual amounts
   *
   * @param signature - Transaction signature
   * @param walletAddress - Our wallet address
   * @param expectedTokenMint - The token we expected to trade
   * @param tradeType - 'buy' or 'sell'
   */
  async parseTradeTransaction(
    signature: string,
    walletAddress: string,
    expectedTokenMint: string,
    tradeType: 'buy' | 'sell'
  ): Promise<ParsedTradeResult> {
    logger.debug({ signature, tradeType }, 'Parsing trade transaction');

    try {
      // Fetch the parsed transaction
      const tx = await this.connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      });

      if (!tx) {
        return {
          signature,
          success: false,
          tokenMint: expectedTokenMint,
          tokenAmount: 0,
          solAmount: 0,
          pricePerToken: 0,
          fee: 0,
          error: 'Transaction not found',
        };
      }

      if (tx.meta?.err) {
        return {
          signature,
          success: false,
          tokenMint: expectedTokenMint,
          tokenAmount: 0,
          solAmount: 0,
          pricePerToken: 0,
          fee: tx.meta.fee / 1e9,
          error: `Transaction failed: ${JSON.stringify(tx.meta.err)}`,
        };
      }

      // Extract balance changes
      const balanceChanges = this.extractBalanceChanges(tx, walletAddress);

      // Find the token balance change
      const tokenChange = balanceChanges.tokens.find(
        t => t.mint.toLowerCase() === expectedTokenMint.toLowerCase()
      );

      const solChange = balanceChanges.sol;
      const fee = (tx.meta?.fee || 0) / 1e9;

      // Calculate amounts based on trade type
      let tokenAmount = 0;
      let solAmount = 0;

      if (tradeType === 'buy') {
        // For buy: we spend SOL, receive tokens
        tokenAmount = tokenChange ? Math.abs(tokenChange.change) : 0;
        solAmount = Math.abs(solChange) - fee; // Exclude fee from cost basis
      } else {
        // For sell: we spend tokens, receive SOL
        tokenAmount = tokenChange ? Math.abs(tokenChange.change) : 0;
        solAmount = Math.abs(solChange) + fee; // Add fee back for accurate proceeds
      }

      // Calculate price per token
      const pricePerToken = tokenAmount > 0 ? solAmount / tokenAmount : 0;

      logger.info({
        signature,
        tradeType,
        tokenAmount,
        solAmount,
        pricePerToken,
        fee,
      }, 'Trade transaction parsed successfully');

      return {
        signature,
        success: true,
        tokenMint: expectedTokenMint,
        tokenAmount,
        solAmount,
        pricePerToken,
        fee,
      };
    } catch (error) {
      logger.error({ signature, error }, 'Failed to parse trade transaction');
      return {
        signature,
        success: false,
        tokenMint: expectedTokenMint,
        tokenAmount: 0,
        solAmount: 0,
        pricePerToken: 0,
        fee: 0,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Extract balance changes from a parsed transaction
   */
  private extractBalanceChanges(
    tx: ParsedTransactionWithMeta,
    walletAddress: string
  ): {
    sol: number;
    tokens: Array<{ mint: string; change: number }>;
  } {
    const result = {
      sol: 0,
      tokens: [] as Array<{ mint: string; change: number }>,
    };

    if (!tx.meta) return result;

    // Find wallet index in account keys
    const accountKeys = tx.transaction.message.accountKeys;
    const walletIndex = accountKeys.findIndex(
      key => key.pubkey.toBase58() === walletAddress
    );

    if (walletIndex === -1) {
      logger.warn({ walletAddress }, 'Wallet not found in transaction accounts');
      return result;
    }

    // Calculate SOL change
    const preBalance = tx.meta.preBalances[walletIndex] || 0;
    const postBalance = tx.meta.postBalances[walletIndex] || 0;
    result.sol = (postBalance - preBalance) / 1e9; // Convert lamports to SOL

    // Calculate token balance changes
    const preTokenBalances = tx.meta.preTokenBalances || [];
    const postTokenBalances = tx.meta.postTokenBalances || [];

    // Create a map of pre-balances
    const preBalanceMap = new Map<string, number>();
    for (const balance of preTokenBalances) {
      if (balance.owner === walletAddress) {
        const amount = parseFloat(balance.uiTokenAmount.uiAmountString || '0');
        preBalanceMap.set(balance.mint, amount);
      }
    }

    // Calculate changes from post-balances
    for (const balance of postTokenBalances) {
      if (balance.owner === walletAddress) {
        const postAmount = parseFloat(balance.uiTokenAmount.uiAmountString || '0');
        const preAmount = preBalanceMap.get(balance.mint) || 0;
        const change = postAmount - preAmount;

        if (change !== 0) {
          result.tokens.push({
            mint: balance.mint,
            change,
          });
        }
      }
    }

    // Check for tokens that existed before but not after (full sells)
    for (const [mint, preAmount] of preBalanceMap) {
      const hasPostBalance = postTokenBalances.some(
        b => b.mint === mint && b.owner === walletAddress
      );
      if (!hasPostBalance && preAmount > 0) {
        result.tokens.push({
          mint,
          change: -preAmount,
        });
      }
    }

    return result;
  }

  /**
   * Wait for transaction confirmation and parse it
   * Useful when you want to ensure the transaction is finalized before parsing
   */
  async waitAndParse(
    signature: string,
    walletAddress: string,
    expectedTokenMint: string,
    tradeType: 'buy' | 'sell',
    maxWaitMs: number = 30000
  ): Promise<ParsedTradeResult> {
    const startTime = Date.now();
    const pollInterval = 2000; // 2 seconds

    while (Date.now() - startTime < maxWaitMs) {
      const result = await this.parseTradeTransaction(
        signature,
        walletAddress,
        expectedTokenMint,
        tradeType
      );

      if (result.success || result.error?.includes('failed')) {
        return result;
      }

      // Wait before retrying
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }

    return {
      signature,
      success: false,
      tokenMint: expectedTokenMint,
      tokenAmount: 0,
      solAmount: 0,
      pricePerToken: 0,
      fee: 0,
      error: 'Transaction parsing timed out',
    };
  }
}
