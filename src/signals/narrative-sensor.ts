import { ApifyClient } from 'apify-client';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { createChildLogger } from '../utils/logger';

const logger = createChildLogger('narrative-sensor');

export interface NarrativeSignal {
  sentiment: 'bullish' | 'bearish' | 'neutral';
  bullishnessScore: number; // -1 to 1 (Granular score for Math)
  hypeScore: number;        // 0 to 1 (Volume/Excitement)
  volume: number;           // Number of tweets found
  keywords: string[];       // LLM-identified topics (e.g., "Congestion", "Burn")
  sampleTweets: string[];
}

export class NarrativeSensor {
  private apifyClient: ApifyClient;
  private genAI: GoogleGenerativeAI;
  private model: ReturnType<GoogleGenerativeAI['getGenerativeModel']>;
  private searchTerms: string[];
  private maxItems: number;

  constructor(
    searchTerms: string[] = ['$SOL', 'Solana', 'memecoin'],
    maxItems: number = 50
  ) {
    // 1. Setup Apify (The Eyes)
    const apifyToken = process.env.APIFY_API_TOKEN;
    if (!apifyToken) logger.warn('APIFY_API_TOKEN missing - Scraper will fail');
    this.apifyClient = new ApifyClient({ token: apifyToken });

    // 2. Setup Gemini (The Brain)
    const geminiKey = process.env.GEMINI_API_KEY || '';
    if (!geminiKey) logger.warn('GEMINI_API_KEY missing - Analysis will be "neutral"');
    this.genAI = new GoogleGenerativeAI(geminiKey);
    this.model = this.genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

    this.searchTerms = searchTerms;
    this.maxItems = maxItems;
  }

  // --- STEP 1: GET DATA (APIFY) ---
  async scrapeTweets(query?: string): Promise<string[]> {
    try {
      const terms = query ? [query] : this.searchTerms;

      logger.debug({ terms }, 'Starting Apify scrape');

      const run = await this.apifyClient.actor('apidojo/tweet-scraper').call({
        searchTerms: terms,
        maxItems: this.maxItems,
        sort: 'Latest',
        tweetLanguage: 'en',
      });

      const { items } = await this.apifyClient.dataset(run.defaultDatasetId).listItems();

      // Extract text and remove duplicates
      const tweets = items
        .map((item: Record<string, unknown>) => item.text as string)
        .filter((text): text is string => typeof text === 'string' && text.length > 10);

      const uniqueTweets = Array.from(new Set(tweets));

      logger.info({ count: uniqueTweets.length, query: terms[0] }, 'Tweets scraped successfully');
      return uniqueTweets;

    } catch (error) {
      logger.error({ error }, 'Apify scrape failed');
      return [];
    }
  }

  // --- STEP 2: ANALYZE DATA (LLM) ---
  async analyzeWithBrain(tweets: string[]): Promise<NarrativeSignal> {
    if (tweets.length === 0) return this.getNeutralSignal();

    try {
      // Prompt Engineering: Asking for specific JSON format
      const prompt = `
        Act as a degenerate Solana trader. Analyze these ${tweets.length} tweets.

        Tweets:
        ${tweets.slice(0, 40).join('\n---\n')}

        Output valid JSON only with no markdown:
        {
          "bullishnessScore": number, // -1.0 (Bearish) to 1.0 (Bullish)
          "hypeScore": number,        // 0.0 (Dead) to 1.0 (Viral)
          "keywords": string[]        // Top 3 specific narratives (e.g. "Network Congestion", "Bonk Listing")
        }
      `;

      const result = await this.model.generateContent(prompt);
      const text = result.response.text().replace(/```json|```/g, '').trim();
      const analysis = JSON.parse(text);

      // Determine explicit sentiment label based on score
      let sentiment: 'bullish' | 'bearish' | 'neutral' = 'neutral';
      if (analysis.bullishnessScore > 0.3) sentiment = 'bullish';
      if (analysis.bullishnessScore < -0.3) sentiment = 'bearish';

      return {
        sentiment,
        bullishnessScore: analysis.bullishnessScore,
        hypeScore: analysis.hypeScore,
        volume: tweets.length,
        keywords: analysis.keywords || [],
        sampleTweets: tweets.slice(0, 3)
      };

    } catch (error) {
      logger.error({ error }, 'LLM Analysis failed');
      return this.getNeutralSignal();
    }
  }

  // --- PUBLIC API ---
  async getNarrativeSignal(tokenSymbol?: string): Promise<NarrativeSignal> {
    const tweets = await this.scrapeTweets(tokenSymbol);
    return this.analyzeWithBrain(tweets);
  }

  private getNeutralSignal(): NarrativeSignal {
    return {
      sentiment: 'neutral',
      bullishnessScore: 0,
      hypeScore: 0,
      volume: 0,
      keywords: [],
      sampleTweets: []
    };
  }
}

export const narrativeSensor = new NarrativeSensor();
