import { createChildLogger } from '../utils/logger';
import Groq from 'groq-sdk';

const logger = createChildLogger('news-sensor');

// Setup Groq for LLM analysis (faster + more generous free tier)
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

export interface NewsSignal {
  bullishness: number; // -1 to 1
  marketFocus: string[]; // e.g. ["Regulation", "Solana Congestion"]
  breakingNews: boolean;
  headline: string;
}

export class NewsSensor {

  // News API endpoints (fallback chain)
  private readonly NEWS_APIS = [
    'https://free-crypto-news.vercel.app/api/news',
    'https://min-api.cryptocompare.com/data/v2/news/?lang=EN&sortOrder=popular'
  ];

  async getMarketNewsSignal(): Promise<NewsSignal> {
    try {
      // 1. Fetch raw news - try multiple APIs with fallback
      let articles: Array<{ title: string; source: string }> = [];

      for (const apiUrl of this.NEWS_APIS) {
        try {
          const response = await fetch(apiUrl, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
              'Accept': 'application/json'
            }
          });

          if (!response.ok) {
            logger.debug({ apiUrl, status: response.status }, 'API failed, trying next...');
            continue;
          }

          const data = await response.json() as Record<string, unknown>;

          // Handle different API response formats
          if (data.articles && Array.isArray(data.articles)) {
            // free-crypto-news format
            articles = (data.articles as Array<{ title: string; source: string }>).map(a => ({
              title: a.title || '',
              source: a.source || ''
            }));
          } else if (data.Data && Array.isArray(data.Data)) {
            // CryptoCompare format
            articles = (data.Data as Array<{ title: string; source_info?: { name: string } }>).map(a => ({
              title: a.title || '',
              source: a.source_info?.name || 'CryptoCompare'
            }));
          }

          if (articles.length > 0) {
            logger.debug({ apiUrl, count: articles.length }, 'News fetched successfully');
            break;
          }
        } catch (e) {
          logger.debug({ apiUrl, error: e }, 'API error, trying next...');
          continue;
        }
      }

      if (articles.length === 0) {
        logger.warn('All news APIs failed');
        return this.getNeutralSignal();
      }

      // Filter for only recent news
      const recentArticles = articles
        .slice(0, 15)
        .map((a) => `- ${a.title} (${a.source})`)
        .join('\n');

      if (!recentArticles) return this.getNeutralSignal();

      // 2. Ask Groq LLM to analyze it
      const prompt = `Analyze these crypto news headlines for a trading bot.

Headlines:
${recentArticles}

Task:
1. Determine global crypto sentiment (-1.0 to 1.0).
2. Identify if there is Breaking News that invalidates technical analysis (SEC lawsuits, exchange hacks, etc).
3. Extract top 2 market themes.

Output JSON only: { "score": number, "isBreaking": boolean, "themes": string[] }`;

      const completion = await groq.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 200,
        response_format: { type: 'json_object' }
      });

      const text = completion.choices[0]?.message?.content || '{}';
      const analysis = JSON.parse(text);

      logger.info({ analysis }, 'News analysis complete');

      return {
        bullishness: analysis.score || 0,
        breakingNews: analysis.isBreaking || false,
        marketFocus: analysis.themes || [],
        headline: articles[0]?.title || ''
      };

    } catch (error) {
      logger.error({ error }, 'Failed to fetch or analyze news');
      return this.getNeutralSignal();
    }
  }

  private getNeutralSignal(): NewsSignal {
    return { bullishness: 0, marketFocus: [], breakingNews: false, headline: '' };
  }
}

export const newsSensor = new NewsSensor();
