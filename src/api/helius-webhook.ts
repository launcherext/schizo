/**
 * Helius Webhooks Handler
 * Real-time tracking of wallet transactions for instant P&L updates
 */

import { createLogger } from '../lib/logger.js';
import { agentEvents } from '../events/emitter.js';

const logger = createLogger('helius-webhook');

export interface HeliusWebhookEvent {
  type: 'TRANSFER' | 'TOKEN_TRANSFER' | 'NFT_SALE' | 'SWAP';
  signature: string;
  timestamp: number;
  feePayer: string;
  slot: number;
  nativeTransfers?: Array<{
    fromUserAccount: string;
    toUserAccount: string;
    amount: number;
  }>;
  tokenTransfers?: Array<{
    fromUserAccount: string;
    toUserAccount: string;
    mint: string;
    tokenAmount: number;
    tokenStandard: string;
  }>;
  accountData?: Array<{
    account: string;
    nativeBalanceChange: number;
    tokenBalanceChanges?: Array<{
      mint: string;
      rawTokenAmount: {
        tokenAmount: string;
        decimals: number;
      };
      userAccount: string;
    }>;
  }>;
}

/**
 * Handle incoming Helius webhook events
 */
export async function handleHeliusWebhook(
  events: HeliusWebhookEvent[],
  walletAddress: string
): Promise<void> {
  for (const event of events) {
    logger.info({
      type: event.type,
      signature: event.signature,
      timestamp: event.timestamp,
    }, 'Received webhook event');

    // Track token transfers involving our wallet
    if (event.tokenTransfers) {
      for (const transfer of event.tokenTransfers) {
        const isSell = transfer.fromUserAccount === walletAddress;
        const isBuy = transfer.toUserAccount === walletAddress;

        if (isSell || isBuy) {
          logger.info({
            type: isSell ? 'SELL' : 'BUY',
            mint: transfer.mint,
            amount: transfer.tokenAmount,
            signature: event.signature,
          }, '💰 Wallet trade detected');

          // Emit event for real-time P&L update
          agentEvents.emit({
            type: 'WALLET_TRANSACTION',
            timestamp: event.timestamp,
            data: {
              signature: event.signature,
              slot: event.slot,
              timestamp: event.timestamp,
              type: isSell ? 'TRANSFER' : 'TRANSFER',
              description: `${isSell ? 'Sell' : 'Buy'} ${transfer.tokenAmount} tokens`,
              accountData: [{
                account: walletAddress,
                nativeBalanceChange: 0,
                tokenBalanceChanges: [{
                  mint: transfer.mint,
                  rawTokenAmount: {
                    tokenAmount: transfer.tokenAmount.toString(),
                    decimals: 6,
                  },
                }],
              }],
            },
          });
        }
      }
    }

    // Track SOL balance changes
    if (event.accountData) {
      for (const account of event.accountData) {
        if (account.account === walletAddress && account.nativeBalanceChange !== 0) {
          const solChange = account.nativeBalanceChange / 1e9; // Convert lamports to SOL

          logger.info({
            signature: event.signature,
            solChange: solChange.toFixed(4),
          }, solChange > 0 ? '💸 SOL received' : '💰 SOL spent');

          // Track token balance changes within the same transaction
          if (account.tokenBalanceChanges) {
            for (const tokenChange of account.tokenBalanceChanges) {
              logger.info({
                mint: tokenChange.mint,
                amount: tokenChange.rawTokenAmount.tokenAmount,
                signature: event.signature,
              }, '🪙 Token balance changed');
            }
          }
        }
      }
    }
  }
}

/**
 * Create Helius webhook configuration
 */
export function createWebhookConfig(walletAddress: string, webhookUrl: string) {
  return {
    webhookURL: webhookUrl,
    transactionTypes: ['TRANSFER', 'TOKEN_TRANSFER', 'SWAP'],
    accountAddresses: [walletAddress],
    webhookType: 'enhanced', // Enhanced webhooks include decoded transaction data
    authHeader: process.env.HELIUS_WEBHOOK_SECRET || undefined,
  };
}

/**
 * Verify Helius webhook signature (if auth header is configured)
 */
export function verifyWebhookSignature(
  body: string,
  signature: string | undefined
): boolean {
  const secret = process.env.HELIUS_WEBHOOK_SECRET;
  
  if (!secret) {
    // No signature verification if secret not configured
    return true;
  }

  if (!signature) {
    logger.warn('Webhook signature missing but secret is configured');
    return false;
  }

  // Helius uses HMAC-SHA256 for webhook signing
  const crypto = require('crypto');
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(body);
  const expectedSignature = hmac.digest('hex');

  return signature === expectedSignature;
}
