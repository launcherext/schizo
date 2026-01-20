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
