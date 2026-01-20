
import 'dotenv/config';
import { TwitterClient } from '../src/personality/twitter-client.js';
import { createLogger } from '../src/lib/logger.js';

const log = createLogger('test-tweet');

async function main() {
  const config = {
    apiKey: process.env.TWITTER_API_KEY!,
    apiSecret: process.env.TWITTER_API_SECRET!,
    accessToken: process.env.TWITTER_ACCESS_TOKEN!,
    accessSecret: process.env.TWITTER_ACCESS_SECRET!,
    maxTweetsPerDay: 50,
  };

  if (!config.apiKey || !config.accessToken) {
    log.error('Missing Twitter API keys in .env');
    return;
  }

  log.info('Initializing Twitter Client...');
  const twitter = new TwitterClient(config);

  const timestamp = new Date().toISOString();
  const message = `🤖 $SCHIZO Agent Verification Tweet\n\nSystem Online.\nTimestamp: ${timestamp}\n\n#Solana #AI`;

  log.info({ message }, 'Sending test tweet...');
  
  try {
    const result = await twitter.postTweet(message);
    if (result) {
      log.info('✅ Tweet queued successfully! Waiting for background sending...');
      await new Promise(resolve => setTimeout(resolve, 5000));
    } else {
      log.error('❌ Failed to send tweet (Rate limited or error).');
    }
  } catch (error: any) {
    log.error({ error }, '❌ Exception sending tweet');
    const fs = await import('fs');
    fs.writeFileSync('debug_tweet_error.log', JSON.stringify(error, null, 2));
  }
}

main();
