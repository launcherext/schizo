import { TwitterApi } from 'twitter-api-v2';
import { logger } from '../lib/logger.js';
import type { ClaudeClient } from './claude-client.js';

export interface TwitterConfig {
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessSecret: string;
  maxTweetsPerDay: number;
}

export class TwitterClient {
  private client: TwitterApi;
  private config: TwitterConfig;
  private claude?: ClaudeClient;
  private tweetQueue: string[] = [];
  private isProcessingQueue = false;
  private dailyTweetCount = 0;
  private lastResetTime = Date.now();

  constructor(config: TwitterConfig, claude?: ClaudeClient) {
    this.config = config;
    this.claude = claude;
    this.client = new TwitterApi({
      appKey: config.apiKey,
      appSecret: config.apiSecret,
      accessToken: config.accessToken,
      accessSecret: config.accessSecret,
    });

    logger.info('Twitter client initialized');
  }

  /**
   * Post a tweet (with queueing and rate limit checks)
   */
  async postTweet(content: string): Promise<boolean> {
    // Reset daily counter if a new day has started
    if (Date.now() - this.lastResetTime > 24 * 60 * 60 * 1000) {
      this.dailyTweetCount = 0;
      this.lastResetTime = Date.now();
    }

    if (this.dailyTweetCount >= this.config.maxTweetsPerDay) {
      logger.warn('Daily tweet limit reached, skipping tweet');
      return false;
    }

    this.tweetQueue.push(content);
    this.processQueue().catch(err => logger.error({ err }, 'Error processing tweet queue'));
    return true;
  }

  /**
   * Post a trade update
   */
  async postTradeUpdate(
    type: 'BUY' | 'SELL', 
    tokenMint: string, 
    amountSol: number, 
    reasoning?: string
  ): Promise<void> {
    const action = type === 'BUY' ? 'APEING INTO' : 'DUMPING';
    const mintDisplay = tokenMint.slice(0, 8);
    
    let tweet = `🚨 ${action} $${mintDisplay} 🚨\n\n`;
    tweet += `Amount: ${amountSol.toFixed(2)} SOL\n`;
    
    if (reasoning) {
        // Use provided reasoning or ask Claude to generate a tweet-sized version
        tweet += `\n"${reasoning.slice(0, 150)}..."\n`;
    }

    tweet += `\n#Solana #Memecoins $SCHIZO`;
    
    await this.postTweet(tweet);
  }

  /**
   * Process the tweet queue sequentially
   */
  private async processQueue() {
    if (this.isProcessingQueue) return;
    this.isProcessingQueue = true;

    while (this.tweetQueue.length > 0) {
      const content = this.tweetQueue.shift();
      if (!content) continue;

      try {
        await this.client.v2.tweet(content);
        logger.info({ content: content.slice(0, 50) }, 'Tweet posted successfully');
        this.dailyTweetCount++;
        
        // Wait a bit between tweets to avoid spam flags
        await new Promise(resolve => setTimeout(resolve, 30000)); 
      } catch (error) {
        logger.error({ error, content }, 'Failed to post tweet');
      }
    }

    this.isProcessingQueue = false;
  }
}
