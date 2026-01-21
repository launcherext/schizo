/**
 * Shill Queue Watcher
 *
 * Monitors the burn wallet for $SCHIZO token burns with memos
 * containing Contract Addresses (CAs) to analyze
 */

import { Connection, PublicKey, Logs } from '@solana/web3.js';
import { createLogger } from '../lib/logger.js';
import type { ShillQueueWatcherConfig, ShillRequest } from './types.js';
import type { ShillQueue } from './shill-queue.js';

const logger = createLogger('shill-watcher');

/** Memo Program ID */
const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

/** Solana address regex (base58, 32-44 chars) */
const SOLANA_ADDRESS_REGEX = /[1-9A-HJ-NP-Za-km-z]{32,44}/;

/**
 * ShillQueueWatcher - Watches burn wallet for $SCHIZO burns with CA memos
 */
export class ShillQueueWatcher {
  private config: ShillQueueWatcherConfig;
  private connection: Connection;
  private shillQueue: ShillQueue;
  private subscriptionId: number | null = null;
  private isRunning = false;

  /** Cooldown tracking per wallet */
  private walletCooldowns: Map<string, number> = new Map();

  /** Processed signatures to avoid duplicates */
  private processedSignatures = new Set<string>();

  constructor(
    config: ShillQueueWatcherConfig,
    connection: Connection,
    shillQueue: ShillQueue
  ) {
    this.config = config;
    this.connection = connection;
    this.shillQueue = shillQueue;

    logger.info({
      burnWallet: config.burnWalletAddress,
      minAmount: config.minShillAmountTokens,
      cooldownMs: config.cooldownPerWalletMs,
    }, 'ShillQueueWatcher initialized');
  }

  /**
   * Start watching the burn wallet
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('ShillQueueWatcher already running');
      return;
    }

    if (!this.config.enabled) {
      logger.info('ShillQueueWatcher disabled');
      return;
    }

    this.isRunning = true;

    try {
      const burnWalletPubkey = new PublicKey(this.config.burnWalletAddress);

      this.subscriptionId = this.connection.onLogs(
        burnWalletPubkey,
        (logs: Logs) => this.handleLogNotification(logs),
        'confirmed'
      );

      logger.info({
        burnWallet: this.config.burnWalletAddress.slice(0, 8) + '...',
        subscriptionId: this.subscriptionId,
      }, 'ShillQueueWatcher WebSocket subscription active');

    } catch (error) {
      logger.error({ error }, 'Failed to start ShillQueueWatcher');
      this.isRunning = false;
    }
  }

  /**
   * Stop watching
   */
  async stop(): Promise<void> {
    if (!this.isRunning) return;

    this.isRunning = false;

    if (this.subscriptionId !== null) {
      try {
        await this.connection.removeOnLogsListener(this.subscriptionId);
      } catch (err) {
        logger.warn({ error: err }, 'Failed to remove logs listener');
      }
      this.subscriptionId = null;
    }

    logger.info('ShillQueueWatcher stopped');
  }

  /**
   * Handle real-time log notification
   */
  private async handleLogNotification(logs: Logs): Promise<void> {
    if (logs.err) {
      logger.debug({ signature: logs.signature }, 'Ignoring failed transaction');
      return;
    }

    if (this.processedSignatures.has(logs.signature)) {
      return;
    }
    this.processedSignatures.add(logs.signature);

    // Limit cache size
    if (this.processedSignatures.size > 1000) {
      const entries = Array.from(this.processedSignatures);
      this.processedSignatures = new Set(entries.slice(-500));
    }

    // Check if this looks like a token transfer with memo
    const hasMemo = logs.logs.some(log =>
      log.includes(MEMO_PROGRAM_ID) ||
      log.includes('Program log: Memo')
    );

    const hasTokenTransfer = logs.logs.some(log =>
      log.includes('Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') ||
      log.includes('Transfer')
    );

    if (!hasMemo || !hasTokenTransfer) {
      logger.debug({ signature: logs.signature }, 'Transaction does not contain memo + token transfer');
      return;
    }

    logger.info({ signature: logs.signature }, 'Potential shill transaction detected');

    // Parse the full transaction
    try {
      const shillRequest = await this.parseShillTransaction(logs.signature);

      if (shillRequest) {
        logger.info({
          sender: shillRequest.senderWallet.slice(0, 8) + '...',
          ca: shillRequest.contractAddress.slice(0, 8) + '...',
          amount: shillRequest.schizoAmountBurned,
        }, 'Valid shill request detected!');

        // Add to queue
        this.shillQueue.enqueue(shillRequest);
      }
    } catch (error) {
      logger.error({ error, signature: logs.signature }, 'Failed to parse shill transaction');
    }
  }

  /**
   * Parse a transaction to extract shill request details
   */
  private async parseShillTransaction(signature: string): Promise<ShillRequest | null> {
    const tx = await this.connection.getParsedTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed',
    });

    if (!tx || !tx.meta || tx.meta.err) {
      return null;
    }

    // Find memo instruction
    let memo: string | null = null;
    const instructions = tx.transaction.message.instructions;

    for (const ix of instructions) {
      // Check if this is a Memo instruction
      const programId = 'programId' in ix ? ix.programId.toString() : '';

      if (programId === MEMO_PROGRAM_ID) {
        // Parsed memo instruction has 'parsed' field with the memo string
        if ('parsed' in ix) {
          memo = ix.parsed as string;
        } else if ('data' in ix) {
          // Raw instruction - decode base58/base64 data
          const ixData = ix.data as string;
          try {
            // Try UTF-8 decode directly (memo data is often just the string)
            memo = Buffer.from(ixData, 'base64').toString('utf-8');
          } catch {
            // Try base58 decode
            try {
              const bs58 = await import('bs58');
              memo = Buffer.from(bs58.default.decode(ixData)).toString('utf-8');
            } catch {
              logger.warn({ signature }, 'Failed to decode memo data');
            }
          }
        }
        break;
      }
    }

    if (!memo) {
      logger.debug({ signature }, 'No memo found in transaction');
      return null;
    }

    // Extract CA from memo
    const caMatch = memo.match(SOLANA_ADDRESS_REGEX);
    if (!caMatch) {
      logger.debug({ signature, memo: memo.slice(0, 50) }, 'No valid CA found in memo');
      return null;
    }

    const contractAddress = caMatch[0];

    // Find sender and $SCHIZO amount
    const preTokenBalances = tx.meta.preTokenBalances || [];
    const postTokenBalances = tx.meta.postTokenBalances || [];

    // Find $SCHIZO token transfer to burn wallet
    let senderWallet: string | null = null;
    let schizoAmountBurned = 0;

    for (const pre of preTokenBalances) {
      if (pre.mint !== this.config.schizoTokenMint) continue;
      if (pre.owner === this.config.burnWalletAddress) continue;

      // Check if this wallet's balance decreased (they sent tokens)
      const post = postTokenBalances.find(
        p => p.mint === pre.mint && p.owner === pre.owner
      );

      const preBal = parseFloat(pre.uiTokenAmount?.uiAmountString || '0');
      const postBal = post ? parseFloat(post.uiTokenAmount?.uiAmountString || '0') : 0;
      const diff = preBal - postBal;

      if (diff > 0) {
        senderWallet = pre.owner || null;
        schizoAmountBurned = diff;
        break;
      }
    }

    if (!senderWallet) {
      logger.debug({ signature }, 'Could not identify sender wallet');
      return null;
    }

    // Validate minimum amount
    if (schizoAmountBurned < this.config.minShillAmountTokens) {
      logger.info({
        signature,
        amount: schizoAmountBurned,
        required: this.config.minShillAmountTokens,
      }, 'Shill amount below minimum');
      return null;
    }

    // Check cooldown
    const lastShillTime = this.walletCooldowns.get(senderWallet) || 0;
    const now = Date.now();

    if (now - lastShillTime < this.config.cooldownPerWalletMs) {
      const remainingMs = this.config.cooldownPerWalletMs - (now - lastShillTime);
      logger.info({
        sender: senderWallet.slice(0, 8) + '...',
        remainingMs,
      }, 'Wallet on cooldown');
      return null;
    }

    // Update cooldown
    this.walletCooldowns.set(senderWallet, now);

    // Clean up old cooldowns periodically
    if (this.walletCooldowns.size > 500) {
      const cutoff = now - this.config.cooldownPerWalletMs * 2;
      for (const [wallet, time] of this.walletCooldowns) {
        if (time < cutoff) {
          this.walletCooldowns.delete(wallet);
        }
      }
    }

    return {
      senderWallet,
      contractAddress,
      schizoAmountBurned,
      signature,
      timestamp: tx.blockTime ? tx.blockTime * 1000 : now,
    };
  }
}
