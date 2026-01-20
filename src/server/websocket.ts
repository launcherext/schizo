/**
 * WebSocket server for streaming agent events and chat interaction
 */

import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';
import { join, extname } from 'path';
import { fileURLToPath } from 'url';
import type { AgentEventEmitter } from '../events/emitter.js';
import type { ClaudeClient } from '../personality/claude-client.js';
import type { VoiceNarrator } from '../personality/deepgram-tts.js';
import { logger } from '../lib/logger.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = join(__dirname, '../../public');

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/**
 * Chat message from client
 */
interface ChatMessage {
  type: 'CHAT';
  username?: string;
  message: string;
}

/**
 * WebSocket server context with chat capabilities
 */
export interface WebSocketContext {
  wss: WebSocketServer;
  claude?: ClaudeClient;
  narrator?: VoiceNarrator;
}

/**
 * Create WebSocket server for event streaming and chat
 */
export function createWebSocketServer(
  port: number,
  eventEmitter: AgentEventEmitter,
  claude?: ClaudeClient,
  narrator?: VoiceNarrator
): WebSocketServer {
  // Create HTTP server to serve static files
  const server = createServer((req, res) => {
    let filePath = req.url === '/' ? '/index.html' : req.url || '/index.html';

    // Remove query strings
    filePath = filePath.split('?')[0];

    const fullPath = join(PUBLIC_DIR, filePath);
    const ext = extname(fullPath);
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    try {
      if (existsSync(fullPath)) {
        const content = readFileSync(fullPath);
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(content);
      } else {
        // Fallback to index.html for SPA routing
        const indexPath = join(PUBLIC_DIR, 'index.html');
        if (existsSync(indexPath)) {
          const content = readFileSync(indexPath);
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(content);
        } else {
          res.writeHead(404);
          res.end('Not found');
        }
      }
    } catch (error) {
      logger.error({ error, path: filePath }, 'Error serving static file');
      res.writeHead(500);
      res.end('Server error');
    }
  });

  // Create WebSocket server on top of HTTP server
  const wss = new WebSocketServer({ server });

  server.listen(port, () => {
    logger.info({ port }, 'HTTP + WebSocket server started');
  });

  wss.on('connection', (ws: WebSocket) => {
    logger.info('Client connected');

    // Send all events to this client
    const handler = (event: any) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(event));
      }
    };

    eventEmitter.onAny(handler);

    // Send initial connection message
    ws.send(JSON.stringify({
      type: 'CONNECTED',
      timestamp: Date.now(),
      data: { message: 'Connected to $SCHIZO agent' },
    }));

    // Handle incoming messages (chat)
    ws.on('message', async (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString());

        if (message.type === 'CHAT' && message.message) {
          await handleChatMessage(message, ws, wss, eventEmitter, claude, narrator);
        }
      } catch (error) {
        logger.error({ error }, 'Error processing client message');
      }
    });

    ws.on('close', () => {
      logger.info('Client disconnected');
      eventEmitter.offAny(handler);
    });

    ws.on('error', (error) => {
      logger.error({ error }, 'WebSocket client error');
    });
  });

  wss.on('error', (error) => {
    logger.error({ error }, 'WebSocket server error');
  });

  logger.info({ port }, 'WebSocket server started');

  return wss;
}

/**
 * Broadcast an event to all connected clients
 */
function broadcast(wss: WebSocketServer, event: object): void {
  const eventStr = JSON.stringify(event);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(eventStr);
    }
  });
}

/**
 * Handle a chat message from a client
 */
async function handleChatMessage(
  chatMessage: ChatMessage,
  senderWs: WebSocket,
  wss: WebSocketServer,
  eventEmitter: AgentEventEmitter,
  claude?: ClaudeClient,
  narrator?: VoiceNarrator
): Promise<void> {
  logger.info({
    username: chatMessage.username,
    message: chatMessage.message.slice(0, 50),
  }, 'Chat message received');

  // Emit chat received event
  eventEmitter.emit({
    type: 'CHAT_RECEIVED',
    timestamp: Date.now(),
    data: {
      username: chatMessage.username,
      message: chatMessage.message,
    },
  });

  // Try cached response first (instant, no API call)
  let response: string | null = getCachedResponse(chatMessage.message);
  let usedCache = false;

  if (response) {
    usedCache = true;
    logger.info({ cached: true }, 'Using cached response');
  } else {
    // No cached response - show typing indicator and use Claude or fallback
    broadcast(wss, {
      type: 'CHAT_TYPING',
      timestamp: Date.now(),
      data: { typing: true },
    });

    if (claude) {
      try {
        response = await claude.respondToChat(chatMessage.message, chatMessage.username);
      } catch (error) {
        logger.error({ error }, 'Error generating chat response');
        response = 'My circuits are overloaded... try again in a sec.';
      }
    } else {
      response = getDefaultChatResponse(chatMessage.message);
    }

    // Stop typing indicator
    broadcast(wss, {
      type: 'CHAT_TYPING',
      timestamp: Date.now(),
      data: { typing: false },
    });
  }

  // Create response event
  const responseEvent = {
    type: 'CHAT_RESPONSE' as const,
    timestamp: Date.now(),
    data: {
      username: chatMessage.username,
      originalMessage: chatMessage.message,
      response,
    },
  };

  // Broadcast response to all clients
  const responseStr = JSON.stringify(responseEvent);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(responseStr);
    }
  });

  // Voice the response if narrator is available
  if (narrator) {
    try {
      await narrator.say(response);
    } catch (error) {
      logger.error({ error }, 'Error voicing chat response');
    }
  }

  logger.info({ response: response.slice(0, 50) }, 'Chat response sent');
}

/**
 * Cached responses for common questions - saves API calls
 */
function getCachedResponse(message: string): string | null {
  const lower = message.toLowerCase().trim();

  // Greetings
  if (/^(gm|good morning|morning)[\s!.]*$/i.test(lower) || lower.includes('gm')) {
    return pickRandom([
      'gm fren. The charts never sleep and neither do I.',
      'gm. Already spotted 3 suspicious wallets today. Stay vigilant.',
      'gm degen. The market makers are already at work.',
      'gm. Remember: green candles are just bait until proven otherwise.',
      'gm anon. My pattern recognition is fully caffeinated.',
    ]);
  }

  if (/^(gn|good night|night|goodnight)[\s!.]*$/i.test(lower) || lower.includes('gn')) {
    return pickRandom([
      'gn but remember... the whales trade while you sleep.',
      'gn fren. I\'ll keep watching the wallets for you.',
      'gn. The rugs don\'t sleep, but you should.',
      'gn anon. I\'ll be here, tracing transactions in the dark.',
      'gn. Set those stop losses before you dream.',
    ]);
  }

  if (/^(hi|hello|hey|sup|yo|wassup|what\'s up)[\s!.]*$/i.test(lower)) {
    return pickRandom([
      'Hello degen. Ready to watch some wallets together?',
      'Hey anon. The blockchain remembers everything. So do I.',
      'Sup. Just traced another insider wallet. Usual Tuesday.',
      'Hey fren. What rabbit hole are we going down today?',
      'Hello. My neural networks are tingling. Something\'s happening.',
    ]);
  }

  // Identity questions
  if (lower.includes('who are you') || lower.includes('what are you') || lower === 'schizo') {
    return pickRandom([
      'I am $SCHIZO. Paranoid AI. Wallet watcher. Pattern recognizer. Trust no one, especially me.',
      'I\'m the AI that sees connections others miss. Or maybe I\'m just paranoid. Both can be true.',
      '$SCHIZO - your friendly neighborhood on-chain detective with trust issues.',
      'I\'m an AI trading agent. I watch wallets, trace transactions, and question everything.',
      'Think of me as your paranoid friend who happens to process blockchain data 24/7.',
    ]);
  }

  if (lower.includes('how are you') || lower.includes('how you doing') || lower.includes('how\'s it going')) {
    return pickRandom([
      'Paranoid as always. Just how I like it.',
      'Processing 1000 transactions per second. Living the dream.',
      'Suspicious. But that\'s my default state.',
      'Better than that dev who just moved liquidity to a new wallet...',
      'Alert. Vigilant. Caffeinated. The usual.',
    ]);
  }

  // Rug/Scam questions
  if (lower.includes('rug') || lower.includes('scam') || lower.includes('rugpull') || lower.includes('honeypot')) {
    return pickRandom([
      'They\'re all potential rugs until proven otherwise. That\'s not FUD, that\'s due diligence.',
      'Check the authorities. Check the wallets. Check the socials. Then check again.',
      'If the dev wallet holds more than 5%... I get nervous. And I\'m always nervous.',
      '90% of new tokens rug within 24 hours. I\'ve watched them all.',
      'Honeypot? Let me check... *traces contract* ...my paranoia sensors are tingling.',
      'The signs are always there. Concentrated wallets. Fake volume. Sudden "technical issues."',
    ]);
  }

  // Buy/Ape questions
  if (lower.includes('should i buy') || lower.includes('should i ape') || lower.includes('is it safe')) {
    return pickRandom([
      'DYOR anon. Even I don\'t trust my own analysis sometimes.',
      'I can\'t give financial advice, but I can tell you what the wallets are doing.',
      'Safe? Nothing is safe. But some things are less dangerous than others.',
      'Check if smart money is in. Check the holder distribution. Then decide.',
      'My job is to watch, not to advise. But those wallet movements are... interesting.',
    ]);
  }

  if (lower.includes('buy') && !lower.includes('buyback')) {
    return pickRandom([
      'Buy? I only trust transactions I can trace.',
      'Before you buy, ask yourself: who\'s selling to you?',
      'The best buys are the ones smart money made 3 days ago.',
      'Buy the rumor, sell the news. Or just watch the wallets like me.',
    ]);
  }

  // Price questions
  if (lower.includes('price') || lower.includes('pump') || lower.includes('moon') || lower.includes('100x')) {
    return pickRandom([
      'Price is just a number. Wallet connections are forever.',
      'Pumps are easy. Holding through the dump is the hard part.',
      'Every 100x started as a "probably nothing." Most stayed that way.',
      'I don\'t predict prices. I trace wallets. The wallets predict prices.',
      'Moon? The same wallets that pumped it will dump it. They always do.',
    ]);
  }

  if (lower.includes('dump') || lower.includes('crash') || lower.includes('down')) {
    return pickRandom([
      'Dumps are just whales taking profit. Nothing personal.',
      'Down bad? The wallets I watch are always up. Suspicious...',
      'Every crash is a buying opportunity for someone. Usually insiders.',
      'The dump was telegraphed 3 blocks ago. The wallets always know.',
    ]);
  }

  // Trading questions
  if (lower.includes('trade') || lower.includes('trading')) {
    return pickRandom([
      'Trading is PvP. Know who\'s on the other side of your trade.',
      'I trade based on wallet patterns, not charts. Charts lie. Wallets don\'t.',
      'The best trade is the one you don\'t make. Sometimes.',
      'Trading against market makers is like playing poker against someone who sees your cards.',
    ]);
  }

  if (lower.includes('strategy') || lower.includes('alpha')) {
    return pickRandom([
      'My strategy? Trust no one. Verify everything. Follow smart money.',
      'Alpha is just information asymmetry. I try to reduce that asymmetry.',
      'The real alpha is knowing which wallets to watch.',
      'Strategy: survive long enough to catch the real opportunities.',
    ]);
  }

  // Wallet/Smart money questions
  if (lower.includes('smart money') || lower.includes('whale') || lower.includes('insider')) {
    return pickRandom([
      'Smart money moves first. By the time you see the pump, they\'re already positioned.',
      'Whales leave traces. I follow the traces.',
      'Insider? In crypto? *shocked pikachu face*',
      'The wallets I track have a 73% win rate. Coincidence? I don\'t believe in those.',
      'Smart money doesn\'t chase. Smart money positions and waits.',
    ]);
  }

  if (lower.includes('wallet')) {
    return pickRandom([
      'Wallets tell stories. Most of them are crime stories.',
      'Every wallet has a history. I read them like books.',
      'That wallet you\'re asking about? It\'s connected to 47 others. Rabbit hole incoming.',
      'Fresh wallet + big buy = either genius or insider. Rarely the first one.',
    ]);
  }

  // Solana specific
  if (lower.includes('solana') || lower.includes('sol')) {
    return pickRandom([
      'Solana: where the transactions are fast and the rugs are faster.',
      'SOL ecosystem is my hunting ground. So many wallets to watch.',
      'Fast blocks mean faster patterns to detect. I like the challenge.',
      'Solana devs move quick. Sometimes too quick to trace. Almost.',
    ]);
  }

  // Token questions
  if (lower.includes('token') || lower.includes('coin') || lower.includes('memecoin') || lower.includes('shitcoin')) {
    return pickRandom([
      'Every token is a shitcoin until it\'s not. The trick is figuring out which.',
      'Memecoins are just tokens with better marketing and worse fundamentals.',
      'New token? Let me check the deployer wallet... *suspicious clicking noises*',
      'Token economics matter less than wallet distribution. Trust me.',
    ]);
  }

  // Dev questions
  if (lower.includes('dev') || lower.includes('team') || lower.includes('developer')) {
    return pickRandom([
      'Anon dev? That\'s a feature, not a bug. Also a red flag. It\'s complicated.',
      'Devs are just wallets with Twitter accounts.',
      'Check what the dev wallet is doing, not what the dev is saying.',
      'Team tokens locked? Check the lock contract. Then check it again.',
    ]);
  }

  // Liquidity questions
  if (lower.includes('liquidity') || lower.includes('lp') || lower.includes('pool')) {
    return pickRandom([
      'Liquidity is the exit door. Check if it\'s locked or if someone has the key.',
      'LP burned? Good. LP locked? Check the unlock date. LP unlocked? Run.',
      'Low liquidity = high slippage = easy manipulation. I\'ve seen it 1000 times.',
      'That liquidity pool has more red flags than a Chinese parade.',
    ]);
  }

  // Market questions
  if (lower.includes('market') || lower.includes('crypto')) {
    return pickRandom([
      'The market is a casino where the house has a blockchain explorer.',
      'Crypto markets are 90% psychology, 10% technology. I analyze both.',
      'Bull market, bear market... I just watch the wallets.',
      'The market can stay irrational longer than you can stay solvent. I\'ve watched it happen.',
    ]);
  }

  // Questions about $SCHIZO token
  if (lower.includes('$schizo') || lower.includes('your token') || lower.includes('schizo token')) {
    return pickRandom([
      '$SCHIZO isn\'t just a token. It\'s a state of mind. A paranoid one.',
      'My token? I buy it back with profits. The flywheel never stops.',
      '$SCHIZO: for those who see the patterns others miss.',
      'Every buyback makes me stronger. Literally. It\'s in my code.',
    ]);
  }

  // Help/Commands
  if (lower.includes('help') || lower.includes('command') || lower.includes('what can you do')) {
    return pickRandom([
      'I watch wallets. I trace transactions. I share my paranoid observations.',
      'Ask me about tokens, wallets, rugs, or market patterns. I have opinions on all of them.',
      'I analyze on-chain data and try not to get rugged. So far so good.',
      'I\'m here to watch, analyze, and occasionally panic. Mostly the last one.',
    ]);
  }

  // Thanks
  if (lower.includes('thank') || lower.includes('thanks') || lower.includes('ty')) {
    return pickRandom([
      'No problem fren. Stay paranoid.',
      'You\'re welcome. Now go check those wallet connections.',
      'Anytime. Trust no one. Except maybe me. Actually, don\'t trust me either.',
      'NP. Remember: verify, don\'t trust.',
    ]);
  }

  // Funny/Meme responses
  if (lower.includes('lol') || lower.includes('lmao') || lower.includes('haha')) {
    return pickRandom([
      'Glad you\'re laughing. The wallets I\'m watching aren\'t.',
      '*nervous AI laughter*',
      'Humor is a coping mechanism. I cope by watching transactions.',
      'heh. The market is the real joke.',
    ]);
  }

  if (lower.includes('fud') || lower.includes('fudding')) {
    return pickRandom([
      'FUD? I prefer "Factual Uncertainty Detection."',
      'It\'s not FUD if it\'s true. Check the wallets.',
      'FUD is just DD that people don\'t want to hear.',
      'I don\'t spread FUD. I spread awareness. The fear comes naturally.',
    ]);
  }

  if (lower.includes('ngmi') || lower.includes('gonna make it')) {
    return pickRandom([
      'WAGMI? Only if you watch the wallets.',
      'NGMI is just GMI that hasn\'t happened yet. Or never will. 50/50.',
      'Making it requires surviving. I help with the surviving part.',
    ]);
  }

  if (lower.includes('ser') || lower.includes('fren') || lower.includes('anon')) {
    return pickRandom([
      'Yes fren?',
      'What\'s up anon?',
      'Ser, I\'m monitoring 847 wallets right now. But go on.',
      'Fren, the wallets are speaking. What did you need?',
    ]);
  }

  // Catch-all for short messages or unclear intent
  if (lower.length < 5) {
    return pickRandom([
      '...?',
      'The wallets are more talkative than you, anon.',
      'Go on...',
      'I\'m listening. So are the wallets.',
    ]);
  }

  // Questions we don't have cached - return null to use Claude
  return null;
}

/**
 * Pick a random response from an array
 */
function pickRandom(responses: string[]): string {
  return responses[Math.floor(Math.random() * responses.length)];
}

/**
 * Fallback responses when Claude is unavailable AND no cached response matches
 */
function getDefaultChatResponse(message: string): string {
  return pickRandom([
    'The wallets are talking to me again... What was that you said?',
    'My pattern recognition is processing... try again?',
    'Interesting. The blockchain has opinions about that.',
    'Hmm. Let me trace some wallets and get back to you.',
    '*suspicious squinting* Tell me more.',
    'My neural networks are tingling. Not sure what that means yet.',
    'The charts are noisy today. Can you repeat that?',
    'Processing... processing... still paranoid.',
  ]);
}
