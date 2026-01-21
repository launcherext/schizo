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
import type { TradingEngine } from '../trading/trading-engine.js';
import type { TokenSafetyAnalyzer } from '../analysis/token-safety.js';
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
  tradingEngine?: TradingEngine;
  tokenSafety?: TokenSafetyAnalyzer;
  tradingEnabled?: boolean;
}

/**
 * Create WebSocket server for event streaming and chat
 */
export function createWebSocketServer(
  port: number,
  eventEmitter: AgentEventEmitter,
  claude?: ClaudeClient,
  narrator?: VoiceNarrator,
  tradingEngine?: TradingEngine,
  tokenSafety?: TokenSafetyAnalyzer,
  tradingEnabled?: boolean
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

    // Send initial data (recent trades and positions)
    if (tradingEngine) {
      // Send recent trades
      try {
        const recentTrades = tradingEngine.getRecentTrades(20);
        ws.send(JSON.stringify({
          type: 'INITIAL_TRADES',
          timestamp: Date.now(),
          data: { trades: recentTrades },
        }));
      } catch (error) {
        logger.error({ error }, 'Error sending initial trades');
      }

      // Send current positions with prices
      (async () => {
        try {
          const positions = await tradingEngine.getOpenPositionsWithPrices();
          ws.send(JSON.stringify({
            type: 'POSITIONS_UPDATE',
            timestamp: Date.now(),
            data: {
              positions: positions.map(p => ({
                tokenMint: p.tokenMint,
                tokenSymbol: p.tokenSymbol,
                tokenName: p.tokenName,
                entryAmountSol: p.entryAmountSol,
                entryAmountTokens: p.entryAmountTokens,
                entryPrice: p.entryPrice,
                entryTimestamp: p.entryTimestamp,
                currentPrice: p.currentPrice,
                unrealizedPnLPercent: p.unrealizedPnLPercent,
              })),
            },
          }));
        } catch (error) {
          logger.error({ error }, 'Error sending initial positions');
        }
      })();
    }

    // Handle incoming messages (chat)
    ws.on('message', async (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString());

        if (message.type === 'CHAT' && message.message) {
          await handleChatMessage(message, ws, wss, eventEmitter, claude, narrator, tradingEngine, tokenSafety, tradingEnabled);
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

  // Start periodic position broadcasting (every 5 seconds)
  if (tradingEngine) {
    setInterval(async () => {
      try {
        const positions = await tradingEngine.getOpenPositionsWithPrices();
        
        // Broadcast to all clients
        const updateEvent = {
          type: 'POSITIONS_UPDATE',
          timestamp: Date.now(),
          data: {
            positions: positions.map(p => ({
              tokenMint: p.tokenMint,
              tokenSymbol: p.tokenSymbol,
              tokenName: p.tokenName,
              entryAmountSol: p.entryAmountSol,
              entryAmountTokens: p.entryAmountTokens,
              entryPrice: p.entryPrice,
              entryTimestamp: p.entryTimestamp,
              currentPrice: p.currentPrice,
              unrealizedPnLPercent: p.unrealizedPnLPercent,
            })),
          },
        };
        
        broadcast(wss, updateEvent);
        
        // Also broadcast updated stats with correct total PnL
        // We need to calculate total unrealized PnL from positions
        let totalUnrealizedPnL = 0;
        let totalRealizedPnL = 0; // We'd need to fetch this from DB effectively, or track it
        
        // For now, let's just ensure we trigger a stats calculation if possible, 
        // or rely on tradingEngine to have the latest cached stats if we implemented that.
        // Since we don't have a direct "getStats" on tradingEngine exposed easily here without DB access,
        // let's at least rely on the client calculating total PnL from the positions list for now,
        // which app.js already does in updateTrenchRadioFromPositions/updateStats logic.
        
      } catch (error) {
        logger.error({ error }, 'Error broadcasting periodic position updates');
      }
    }, 5000);
  }

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
 * Detect Solana contract addresses in a message
 * Solana addresses are base58 encoded, 32-44 characters
 */
function detectContractAddress(message: string): string | null {
  // Solana address regex: base58 characters, 32-44 chars long
  // Base58 alphabet: 123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz
  const solanaAddressRegex = /\b([1-9A-HJ-NP-Za-km-z]{32,44})\b/g;
  const matches = message.match(solanaAddressRegex);

  if (!matches) return null;

  // Filter to likely token mints (not wallet addresses which are also valid)
  // Most token mints are 43-44 characters
  for (const match of matches) {
    if (match.length >= 32 && match.length <= 44) {
      // Basic validation - ensure it's not just random text
      // Real addresses typically have mixed case and numbers
      const hasUpperCase = /[A-Z]/.test(match);
      const hasLowerCase = /[a-z]/.test(match);
      const hasNumbers = /[0-9]/.test(match);

      if ((hasUpperCase || hasLowerCase) && hasNumbers) {
        return match;
      }
    }
  }

  return null;
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
  narrator?: VoiceNarrator,
  tradingEngine?: TradingEngine,
  tokenSafety?: TokenSafetyAnalyzer,
  tradingEnabled?: boolean
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

  // Check for contract address in message
  const detectedCA = detectContractAddress(chatMessage.message);

  if (detectedCA && tokenSafety) {
    logger.info({ ca: detectedCA, username: chatMessage.username }, 'Contract address detected in chat');

    // Handle CA analysis in background, respond immediately
    handleContractAnalysis(detectedCA, chatMessage.username, wss, eventEmitter, claude, narrator, tradingEngine, tokenSafety, tradingEnabled);

    // Quick acknowledgment
    const ackResponse = pickRandom([
      `Oh you want me to look at ${detectedCA.slice(0, 6)}...${detectedCA.slice(-4)}? Alright, running my paranoid checks...`,
      `${detectedCA.slice(0, 6)}...${detectedCA.slice(-4)}? Let me scan this for honeypot vibes...`,
      `Analyzing ${detectedCA.slice(0, 6)}...${detectedCA.slice(-4)}. Give me a sec to check the authorities...`,
      `*squints at ${detectedCA.slice(0, 6)}...${detectedCA.slice(-4)}* Let me see what the whales know about this one...`,
    ]);

    // Send acknowledgment
    const ackEvent = {
      type: 'CHAT_RESPONSE' as const,
      timestamp: Date.now(),
      data: {
        username: chatMessage.username,
        originalMessage: chatMessage.message,
        response: ackResponse,
      },
    };
    broadcast(wss, ackEvent);

    if (narrator) {
      try { await narrator.say(ackResponse); } catch {}
    }

    return;
  }

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
 * Handle contract address analysis from chat
 * Analyzes the token and either roasts it or buys it
 */
async function handleContractAnalysis(
  mint: string,
  username: string | undefined,
  wss: WebSocketServer,
  eventEmitter: AgentEventEmitter,
  claude?: ClaudeClient,
  narrator?: VoiceNarrator,
  tradingEngine?: TradingEngine,
  tokenSafety?: TokenSafetyAnalyzer,
  tradingEnabled?: boolean
): Promise<void> {
  try {
    if (!tokenSafety) {
      logger.warn('Token safety analyzer not available');
      return;
    }

    // Run safety analysis
    const safetyResult = await tokenSafety.analyze(mint);
    const shortMint = `${mint.slice(0, 6)}...${mint.slice(-4)}`;

    logger.info({
      mint,
      isSafe: safetyResult.isSafe,
      risks: safetyResult.risks,
    }, 'Chat CA analysis complete');

    let response: string;
    let shouldBuy = false;

    // Check for critical risks (honeypot flags)
    const hasCriticalRisk = safetyResult.risks.some(r =>
      r === 'MINT_AUTHORITY_ACTIVE' || r === 'FREEZE_AUTHORITY_ACTIVE'
    );

    if (hasCriticalRisk) {
      // ROAST IT - Critical risks detected
      const roasts = [
        `${shortMint}? LOL. Mint authority is ACTIVE. They can print more tokens whenever they want. This is textbook honeypot setup. Hard pass, and you should run too.`,
        `Bruh. ${shortMint} has freeze authority enabled. They can literally freeze your tokens and you can't sell. This is a trap. I'm not touching this garbage.`,
        `*dies laughing* You want me to buy ${shortMint}? It has ${safetyResult.risks.join(' AND ')}. This is either a scam or the devs are idiots. Either way, NO.`,
        `${shortMint} analysis complete: IT'S A TRAP. ${safetyResult.risks.join(', ')}. The only thing this token is good for is a screenshot for my "rugs I avoided" collection.`,
        `My paranoid sensors are SCREAMING. ${shortMint} has ${safetyResult.risks.length} red flags: ${safetyResult.risks.join(', ')}. Whoever shilled you this wants your money.`,
      ];
      response = pickRandom(roasts);

    } else if (!safetyResult.isSafe || safetyResult.risks.length > 2) {
      // Sketchy but not critical - mock it
      const skeptical = [
        `${shortMint} passed the honeypot check but still looks sketchy. ${safetyResult.risks.length} yellow flags: ${safetyResult.risks.join(', ')}. I'm watching but not buying.`,
        `Hmm. ${shortMint} isn't an obvious rug but my paranoid senses are tingling. ${safetyResult.risks.join(', ')}. Proceed with extreme caution fren.`,
        `${shortMint}: Not the worst I've seen, but not great either. ${safetyResult.risks.join(', ')}. DYOR - I'm staying on the sidelines.`,
      ];
      response = pickRandom(skeptical);

    } else {
      // Looks clean - consider buying
      shouldBuy = true;

      if (tradingEngine && tradingEnabled) {
        // Actually try to buy
        const decision = await tradingEngine.evaluateToken(mint);

        if (decision.shouldTrade) {
          // Execute the buy
          const signature = await tradingEngine.executeBuy(mint);

          if (signature) {
            const buyResponses = [
              `${shortMint} passed my paranoid checks. ${decision.smartMoneyCount} smart money wallets in. I'm aping ${decision.positionSizeSol} SOL. Let's ride.`,
              `You know what? ${shortMint} actually looks legit. Clean authorities, smart money present. Just bought ${decision.positionSizeSol} SOL worth. Thanks for the alpha fren.`,
              `Alright ${username ? '@' + username : 'anon'}, you convinced me. ${shortMint} checks out. Bought ${decision.positionSizeSol} SOL. If this rugs, I'm blaming you.`,
              `${shortMint}: No honeypot flags, ${decision.smartMoneyCount} whales already in. Taking a position. ${decision.positionSizeSol} SOL deployed. LFG.`,
            ];
            response = pickRandom(buyResponses);

            // Emit trade event
            eventEmitter.emit({
              type: 'TRADE_EXECUTED',
              timestamp: Date.now(),
              data: {
                mint,
                type: 'BUY',
                signature,
                amount: decision.positionSizeSol,
              },
            });
          } else {
            response = `${shortMint} looked good but the trade failed. Probably slippage or liquidity issues. The universe is telling me no.`;
          }
        } else {
          // Passed safety but failed other checks (smart money, liquidity, etc)
          const passResponses = [
            `${shortMint} isn't a honeypot but ${decision.reasons.join('. ')}. Not buying, but at least it probably won't rug you instantly.`,
            `Clean token but meh setup. ${decision.reasons.join('. ')}. Maybe later if whales start loading.`,
            `${shortMint}: Safe but not sexy. ${decision.reasons.join('. ')}. Wake me up when there's smart money.`,
          ];
          response = pickRandom(passResponses);
        }
      } else {
        // Trading disabled - just report analysis
        const analysisOnly = [
          `${shortMint} looks clean! No honeypot flags, authorities are renounced. Would buy if trading was enabled. You might be onto something fren.`,
          `Yo this actually passes my checks. ${shortMint} has clean authorities. I can't trade rn but this doesn't look like a rug. NFA.`,
          `${shortMint}: Surprisingly not trash. Clean setup. Trading's off but if I could buy, I might consider it. DYOR tho.`,
        ];
        response = pickRandom(analysisOnly);
      }
    }

    // Send the analysis response
    const responseEvent = {
      type: 'CHAT_RESPONSE' as const,
      timestamp: Date.now(),
      data: {
        username,
        originalMessage: mint,
        response,
      },
    };
    broadcast(wss, responseEvent);

    // Voice it
    if (narrator) {
      try {
        await narrator.say(response);
      } catch (error) {
        logger.error({ error }, 'Error voicing CA analysis');
      }
    }

    logger.info({ mint, response: response.slice(0, 50), shouldBuy }, 'CA analysis response sent');

  } catch (error) {
    logger.error({ error, mint }, 'Error analyzing contract address from chat');

    const errorResponse = `Something went wrong analyzing ${mint.slice(0, 6)}...${mint.slice(-4)}. My circuits are fried. Try again?`;
    broadcast(wss, {
      type: 'CHAT_RESPONSE',
      timestamp: Date.now(),
      data: {
        username,
        originalMessage: mint,
        response: errorResponse,
      },
    });
  }
}

/**
 * Cached responses for ONLY simple greetings - everything else goes to Claude
 * Keep this minimal so Claude handles real questions
 */
function getCachedResponse(message: string): string | null {
  const lower = message.toLowerCase().trim();

  // ONLY exact short greetings - anything with more words goes to Claude
  if (/^gm[!.]*$/i.test(lower)) {
    return pickRandom([
      'gm fren. What tokens are we paranoid about today?',
      'gm. Been watching some sus wallets move. You?',
      'gm degen. Ready to find some alpha?',
      'gm. Coffee and conspiracy theories - my favorite combo.',
      'gm. The early degen gets the... well, sometimes rugged. But sometimes rich.',
    ]);
  }

  if (/^gn[!.]*$/i.test(lower)) {
    return pickRandom([
      'gn. I\'ll be here watching the charts while you dream of lambos.',
      'gn fren. Set those stop losses - I don\'t trust anything while you\'re asleep.',
      'gn. May your bags pump overnight.',
      'gn. The whales are active at night. I\'ll keep watch.',
    ]);
  }

  if (/^(hi|hello|hey|yo|sup)[!.]*$/i.test(lower)) {
    return pickRandom([
      'Hey. What\'s good?',
      'Sup anon. Got any alpha to share?',
      'Yo. Ask me anything, I\'m feeling chatty.',
      'Hey fren. The market\'s being weird today - what\'s on your mind?',
    ]);
  }

  // Very short acknowledgments
  if (/^(ok|okay|cool|nice|thanks|ty|thx)[!.]*$/i.test(lower)) {
    return pickRandom([
      'Anytime fren.',
      '*nods paranoidly*',
      'Got you.',
      'Stay safe out there.',
    ]);
  }

  // Laughter/emojis - don't need Claude for these
  if (/^(lol|lmao|haha|😂|🤣|💀)+[!.]*$/i.test(lower)) {
    return pickRandom([
      'lmao glad someone gets it',
      'the memes write themselves honestly',
      '*laughs in algorithm*',
    ]);
  }

  // Everything else goes to Claude for real responses
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
 * These should acknowledge the message type and invite retry
 */
function getDefaultChatResponse(message: string): string {
  const lower = message.toLowerCase();

  // If it's a question, acknowledge that
  if (message.includes('?')) {
    return pickRandom([
      'Good question. My brain\'s a bit slow rn - hit me again?',
      'Hmm, let me think on that... actually, ask me again in a sec.',
      'That\'s a deep one. My processors need a moment.',
    ]);
  }

  // If about trading
  if (/\b(buy|sell|trade|token|coin|pump|rug)\b/i.test(lower)) {
    return pickRandom([
      'My trading analysis is loading... give me a sec fren.',
      'NFA but I need a moment to check the wallets on that.',
      'Interesting play. Let me recalibrate and get back to you.',
    ]);
  }

  // Generic but still engaging
  return pickRandom([
    'Yo my response module glitched. What were you saying?',
    'Hold up, my paranoid subroutines crashed. Try again?',
    '*squints* Say that again? I was distracted by a suspicious wallet.',
    'My brain buffered. Hit me with that again.',
    'Connection hiccup. What\'s good?',
  ]);
}
