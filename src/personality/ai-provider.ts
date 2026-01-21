/**
 * Multi-provider AI Client - Supports Claude, Groq (free), and Gemini (free)
 *
 * When Anthropic credits run out, switch to a free provider in .env:
 *   AI_PROVIDER=groq   (or gemini)
 *   GROQ_API_KEY=your-key
 */

import { logger } from '../lib/logger.js';

export type AIProvider = 'claude' | 'groq' | 'gemini';

export interface AIProviderConfig {
  provider: AIProvider;
  apiKey: string;
  model?: string;
  maxTokens?: number;
}

export interface AIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AIResponse {
  content: string;
  provider: AIProvider;
}

/**
 * Default models per provider
 */
const DEFAULT_MODELS: Record<AIProvider, string> = {
  claude: 'claude-sonnet-4-20250514',
  groq: 'llama-3.1-70b-versatile',  // Fast & free
  gemini: 'gemini-1.5-flash',        // Fast & free
};

/**
 * Universal AI Provider Client
 */
export class AIProviderClient {
  private provider: AIProvider;
  private apiKey: string;
  private model: string;
  private maxTokens: number;

  constructor(config: AIProviderConfig) {
    this.provider = config.provider;
    this.apiKey = config.apiKey;
    this.model = config.model || DEFAULT_MODELS[config.provider];
    this.maxTokens = config.maxTokens || 200;

    logger.info({
      provider: this.provider,
      model: this.model
    }, 'AI Provider initialized');
  }

  /**
   * Generate a completion with system prompt
   */
  async complete(systemPrompt: string, userMessage: string): Promise<string> {
    try {
      switch (this.provider) {
        case 'claude':
          return await this.completeClaude(systemPrompt, userMessage);
        case 'groq':
          return await this.completeGroq(systemPrompt, userMessage);
        case 'gemini':
          return await this.completeGemini(systemPrompt, userMessage);
        default:
          throw new Error(`Unknown provider: ${this.provider}`);
      }
    } catch (error) {
      logger.error({ error, provider: this.provider }, 'AI completion failed');
      throw error;
    }
  }

  /**
   * Generate with message history
   */
  async completeWithHistory(
    systemPrompt: string,
    messages: Array<{ role: 'user' | 'assistant'; content: string }>
  ): Promise<string> {
    try {
      switch (this.provider) {
        case 'claude':
          return await this.completeClaudeWithHistory(systemPrompt, messages);
        case 'groq':
          return await this.completeGroqWithHistory(systemPrompt, messages);
        case 'gemini':
          return await this.completeGeminiWithHistory(systemPrompt, messages);
        default:
          throw new Error(`Unknown provider: ${this.provider}`);
      }
    } catch (error) {
      logger.error({ error, provider: this.provider }, 'AI completion with history failed');
      throw error;
    }
  }

  // ============ CLAUDE ============
  private async completeClaude(systemPrompt: string, userMessage: string): Promise<string> {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: this.maxTokens,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Claude API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    return data.content?.[0]?.text || '';
  }

  private async completeClaudeWithHistory(
    systemPrompt: string,
    messages: Array<{ role: 'user' | 'assistant'; content: string }>
  ): Promise<string> {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: this.maxTokens,
        system: systemPrompt,
        messages,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Claude API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    return data.content?.[0]?.text || '';
  }

  // ============ GROQ (FREE) ============
  private async completeGroq(systemPrompt: string, userMessage: string): Promise<string> {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: this.maxTokens,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Groq API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content || '';
  }

  private async completeGroqWithHistory(
    systemPrompt: string,
    messages: Array<{ role: 'user' | 'assistant'; content: string }>
  ): Promise<string> {
    const formattedMessages = [
      { role: 'system', content: systemPrompt },
      ...messages,
    ];

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: this.maxTokens,
        messages: formattedMessages,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Groq API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content || '';
  }

  // ============ GEMINI (FREE) ============
  private async completeGemini(systemPrompt: string, userMessage: string): Promise<string> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ parts: [{ text: userMessage }] }],
        generationConfig: {
          maxOutputTokens: this.maxTokens,
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Gemini API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  }

  private async completeGeminiWithHistory(
    systemPrompt: string,
    messages: Array<{ role: 'user' | 'assistant'; content: string }>
  ): Promise<string> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;

    // Gemini uses 'model' instead of 'assistant'
    const contents = messages.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents,
        generationConfig: {
          maxOutputTokens: this.maxTokens,
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Gemini API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  }

  /**
   * Get current provider name
   */
  getProvider(): AIProvider {
    return this.provider;
  }
}

/**
 * Create AI provider from environment variables
 */
export function createAIProvider(): AIProviderClient | null {
  const provider = (process.env.AI_PROVIDER || 'claude').toLowerCase() as AIProvider;

  let apiKey: string | undefined;
  let model: string | undefined;

  switch (provider) {
    case 'groq':
      apiKey = process.env.GROQ_API_KEY;
      model = process.env.GROQ_MODEL;
      break;
    case 'gemini':
      apiKey = process.env.GEMINI_API_KEY;
      model = process.env.GEMINI_MODEL;
      break;
    case 'claude':
    default:
      apiKey = process.env.ANTHROPIC_API_KEY;
      model = process.env.CLAUDE_MODEL;
      break;
  }

  if (!apiKey) {
    logger.warn({ provider }, `No API key found for ${provider} - AI features disabled`);
    return null;
  }

  return new AIProviderClient({
    provider,
    apiKey,
    model,
    maxTokens: 200,
  });
}
