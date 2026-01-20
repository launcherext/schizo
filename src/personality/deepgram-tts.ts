/**
 * Deepgram Text-to-Speech client for $SCHIZO voice output
 */

import { createLogger } from '../lib/logger.js';
import { agentEvents } from '../events/emitter.js';

const logger = createLogger('deepgram-tts');

/**
 * Deepgram TTS configuration
 */
export interface DeepgramTTSConfig {
  apiKey: string;
  model?: string;
  voice?: string;
}

/**
 * Default TTS configuration
 */
export const DEFAULT_TTS_CONFIG: Omit<DeepgramTTSConfig, 'apiKey'> = {
  model: 'aura-2-aries-en', // Natural sounding voice
  voice: 'asteria', // Can be: asteria, luna, stella, athena, hera, orion, arcas, perseus, angus, orpheus
};

/**
 * Deepgram TTS client for generating speech from text
 */
export class DeepgramTTS {
  private config: DeepgramTTSConfig;
  private baseUrl = 'https://api.deepgram.com/v1/speak';

  constructor(config: DeepgramTTSConfig) {
    this.config = {
      ...DEFAULT_TTS_CONFIG,
      ...config,
    };

    logger.info({ model: this.config.model, voice: this.config.voice }, 'Deepgram TTS initialized');
  }

  /**
   * Convert text to speech and return audio buffer
   */
  async speak(text: string): Promise<Buffer> {
    logger.debug({ text: text.slice(0, 50) }, 'Generating speech');

    try {
      const url = `${this.baseUrl}?model=${this.config.model}`;

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Token ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Deepgram API error: ${response.status} ${errorText}`);
      }

      const audioBuffer = Buffer.from(await response.arrayBuffer());

      logger.info({ textLength: text.length, audioSize: audioBuffer.length }, 'Speech generated');

      return audioBuffer;
    } catch (error) {
      logger.error({ error, text: text.slice(0, 50) }, 'Failed to generate speech');
      throw error;
    }
  }

  /**
   * Speak text and broadcast audio via WebSocket
   */
  async speakAndBroadcast(text: string, wss?: any): Promise<void> {
    try {
      const audioBuffer = await this.speak(text);

      if (wss && wss.clients) {
        // Broadcast audio to all connected clients
        const audioBase64 = audioBuffer.toString('base64');

        const message = JSON.stringify({
          type: 'VOICE_AUDIO',
          timestamp: Date.now(),
          data: {
            text,
            audio: audioBase64,
            format: 'mp3',
          },
        });

        wss.clients.forEach((client: any) => {
          if (client.readyState === 1) { // WebSocket.OPEN
            client.send(message);
          }
        });

        logger.info({ clientCount: wss.clients.size }, 'Voice broadcast sent');
      }

      // Also emit event for the feed
      agentEvents.emit({
        type: 'SCHIZO_SPEAKS',
        timestamp: Date.now(),
        data: { text },
      });
    } catch (error) {
      logger.error({ error }, 'Failed to speak and broadcast');
    }
  }

  /**
   * Get available voices
   */
  getAvailableVoices(): string[] {
    return [
      'asteria',  // Default, warm female
      'luna',     // Soft female
      'stella',   // Professional female
      'athena',   // Confident female
      'hera',     // Mature female
      'orion',    // Deep male
      'arcas',    // Friendly male
      'perseus',  // Strong male
      'angus',    // Scottish accent
      'orpheus',  // Dramatic male
    ];
  }

  /**
   * Update voice
   */
  setVoice(voice: string): void {
    this.config.voice = voice;
    this.config.model = `aura-${voice}-en`;
    logger.info({ voice }, 'Voice updated');
  }
}

/**
 * Create a voice narrator that speaks the agent's thoughts
 */
export class VoiceNarrator {
  private tts: DeepgramTTS;
  private wss?: any;
  private speakQueue: string[] = [];
  private enabled = true;
  private processingPromise: Promise<void> | null = null;
  private recentSpoken: Map<string, number> = new Map(); // text hash -> timestamp
  private readonly DEDUPE_WINDOW_MS = 30000; // 30 seconds deduplication window

  constructor(tts: DeepgramTTS, wss?: any) {
    this.tts = tts;
    this.wss = wss;

    // Cleanup old entries periodically
    setInterval(() => this.cleanupRecentSpoken(), 60000);

    logger.info('Voice narrator initialized with deduplication');
  }

  /**
   * Simple hash for deduplication
   */
  private hashText(text: string): string {
    // Use first 50 chars + length as a simple hash
    return `${text.slice(0, 50).toLowerCase()}_${text.length}`;
  }

  /**
   * Cleanup old entries from deduplication map
   */
  private cleanupRecentSpoken(): void {
    const now = Date.now();
    for (const [hash, timestamp] of this.recentSpoken) {
      if (now - timestamp > this.DEDUPE_WINDOW_MS * 2) {
        this.recentSpoken.delete(hash);
      }
    }
  }

  /**
   * Enable/disable voice
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    logger.info({ enabled }, 'Voice narrator enabled state changed');
  }

  /**
   * Set WebSocket server for broadcasting
   */
  setWebSocket(wss: any): void {
    this.wss = wss;
  }

  /**
   * Clean text for speech - remove asterisk actions and other non-speech content
   */
  private cleanTextForSpeech(text: string): string {
    // Remove asterisk actions like *neural networks flickering*
    let cleaned = text.replace(/\*[^*]+\*/g, '');
    // Remove multiple spaces
    cleaned = cleaned.replace(/\s+/g, ' ').trim();
    return cleaned;
  }

  /**
   * Queue text to be spoken
   */
  async say(text: string): Promise<void> {
    if (!this.enabled) {
      logger.debug('Voice disabled, skipping');
      return;
    }

    // Clean the text before queuing
    const cleanedText = this.cleanTextForSpeech(text);
    if (!cleanedText) {
      logger.debug('Text empty after cleaning, skipping');
      return;
    }

    // Check for duplicate/similar text recently spoken
    const hash = this.hashText(cleanedText);
    const lastSpoken = this.recentSpoken.get(hash);
    if (lastSpoken && Date.now() - lastSpoken < this.DEDUPE_WINDOW_MS) {
      logger.debug({ text: cleanedText.slice(0, 30) }, 'Skipping duplicate speech');
      return;
    }

    // Mark as spoken (even before actual speech to prevent queue duplicates)
    this.recentSpoken.set(hash, Date.now());

    // Limit queue size to prevent buildup
    if (this.speakQueue.length >= 3) {
      logger.warn({ queueLength: this.speakQueue.length }, 'Speech queue full, dropping oldest');
      this.speakQueue.shift();
    }

    this.speakQueue.push(cleanedText);
    // Don't await - let queue process in background
    this.processQueue();
  }

  /**
   * Process the speak queue - ensures only one speech at a time
   */
  private processQueue(): void {
    // If already processing, the loop will pick up new items
    if (this.processingPromise) {
      return;
    }

    this.processingPromise = this.doProcessQueue().finally(() => {
      this.processingPromise = null;
    });
  }

  private async doProcessQueue(): Promise<void> {
    while (this.speakQueue.length > 0) {
      const text = this.speakQueue.shift()!;

      try {
        logger.info({ queueLength: this.speakQueue.length }, 'Speaking next in queue');
        await this.tts.speakAndBroadcast(text, this.wss);

        // Add delay between speeches to prevent overlap
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (error) {
        logger.error({ error }, 'Error speaking text');
      }
    }
  }

  /**
   * Clear the speak queue
   */
  clearQueue(): void {
    this.speakQueue = [];
    logger.info('Speak queue cleared');
  }

  /**
   * Get queue length
   */
  getQueueLength(): number {
    return this.speakQueue.length;
  }
}
