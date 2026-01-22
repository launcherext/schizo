import puppeteer, { Browser, Page } from 'puppeteer';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { createChildLogger } from '../utils/logger';
import path from 'path';

const logger = createChildLogger('axiom-sensor');

// Setup Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

export interface AxiomNarrativeSignal {
  sentiment: 'bullish' | 'bearish' | 'neutral';
  bullishnessScore: number;
  hypeScore: number;
  keywords: string[];
  tweetCount: number;
  sampleTweets: string[];
}

export class AxiomSensor {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private readonly DASHBOARD_URL = 'https://axiom.trade/trackers?chain=sol';
  private headlessMode: boolean = false; // Set to true for headless once login is saved

  private findChrome(): string {
    // Find Chrome executable on Windows
    const possiblePaths = [
      process.env.CHROME_PATH || '',
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ];

    for (const chromePath of possiblePaths) {
      if (chromePath && require('fs').existsSync(chromePath)) {
        return chromePath;
      }
    }

    // Fallback - let Puppeteer find it
    return '';
  }

  async initialize(): Promise<void> {
    logger.info('Booting Axiom Sensor (Persistent Mode)...');

    // Use a dedicated profile directory for the bot
    const userDataDir = path.join(process.cwd(), 'puppeteer_data');
    const chromePath = this.findChrome();

    const launchOptions: Parameters<typeof puppeteer.launch>[0] = {
      headless: this.headlessMode,
      userDataDir,
      defaultViewport: null,
      args: [
        '--start-maximized',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        // Enable extensions so you can install Phantom
        '--enable-extensions'
      ]
    };

    if (chromePath) {
      launchOptions.executablePath = chromePath;
    }

    logger.info({ chromePath, userDataDir }, 'Launching Chrome');
    this.browser = await puppeteer.launch(launchOptions);

    this.page = await this.browser.newPage();

    try {
      logger.info('Navigating to Axiom...');
      await this.page.goto(this.DASHBOARD_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

      // Smart Login Check - check if we need manual login
      await this.waitForLogin();

      // Dismiss any promo modals
      await this.dismissModals();

    } catch (e) {
      logger.error({ error: e }, 'Initialization failed');
    }
  }

  private async waitForLogin(): Promise<void> {
    if (!this.page) return;

    const currentUrl = this.page.url();

    // Check if we are on login/connect page or if Sign Up modal is visible
    const needsLogin = await this.page.evaluate(`(() => {
      const url = window.location.href;
      if (url.includes('login') || url.includes('connect')) return true;

      // Check for Sign Up modal
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        if (btn.textContent?.includes('Sign Up') || btn.textContent?.includes('Connect with')) {
          return true;
        }
      }
      return false;
    })()`);

    if (needsLogin) {
      logger.warn('========================================');
      logger.warn('>>> ACTION REQUIRED <<<');
      logger.warn('Please log in manually in the browser window!');
      logger.warn('Waiting up to 120 seconds...');
      logger.warn('========================================');

      // Wait up to 120 seconds for the user to log in
      try {
        await this.page.waitForFunction(
          `(() => {
            // Check we're not on login page
            if (window.location.href.includes('login') || window.location.href.includes('connect')) {
              return false;
            }
            // Check Sign Up modal is gone
            const buttons = document.querySelectorAll('button');
            for (const btn of buttons) {
              if (btn.textContent === 'Sign Up') return false;
            }
            return true;
          })()`,
          { timeout: 120000 }
        );
        logger.info('Login detected! Session saved to ./puppeteer_data');
        logger.info('Future runs will be automatic.');
      } catch (e) {
        logger.error('Login timed out. Please run again and complete login.');
        throw new Error('Manual login timeout');
      }
    } else {
      logger.info('Already logged in (session restored from puppeteer_data)');
    }
  }

  private async dismissModals(): Promise<void> {
    if (!this.page) return;

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await new Promise(r => setTimeout(r, 1000));

        const dismissed = await this.page.evaluate(`(() => {
          const buttons = document.querySelectorAll('button');
          for (const btn of buttons) {
            const text = btn.textContent?.toLowerCase() || '';
            if (text.includes('finish') || text.includes('close') || text.includes('skip') ||
                text.includes('got it') || text.includes('cancel') || text.includes('dismiss')) {
              btn.click();
              return true;
            }
          }
          return false;
        })()`);

        if (dismissed) {
          logger.debug({ attempt }, 'Dismissed modal');
        } else {
          break;
        }
      } catch (e) {
        break;
      }
    }
  }

  async scrapeFeed(): Promise<string[]> {
    if (!this.page) await this.initialize();

    try {
      // 1. Click "Twitter Alerts" tab
      try {
        await this.page!.waitForFunction(
          `(() => {
            const els = document.querySelectorAll('*');
            for (const el of els) {
              if (el.textContent === 'Twitter Alerts' ||
                  (el.textContent?.includes('Twitter Alerts') && el.textContent.length < 30)) {
                return true;
              }
            }
            return false;
          })()`,
          { timeout: 5000 }
        );

        await this.page!.evaluate(`(() => {
          const els = document.querySelectorAll('*');
          for (const el of els) {
            if (el.textContent === 'Twitter Alerts' ||
                (el.textContent?.includes('Twitter Alerts') && el.textContent.length < 30)) {
              el.click();
              break;
            }
          }
        })()`);

        await new Promise(r => setTimeout(r, 2000));
        logger.debug('Clicked Twitter Alerts tab');
      } catch (e) {
        logger.debug('Tab interaction skipped (might already be active)');
      }

      // 2. Scrape tweet-like content from the feed
      const tweets = await this.page!.evaluate(`(() => {
        const results = [];
        const allElements = document.querySelectorAll('div, span, p');

        for (const el of allElements) {
          const text = el.textContent?.trim() || '';
          if (text.length > 40 && text.length < 400) {
            // Filter out UI elements
            if (!text.includes('Connect Wallet') &&
                !text.includes('Live Trades') &&
                !text.includes('Sign Up') &&
                !text.includes('Settings') &&
                !text.includes('Discover') &&
                !text.includes('Trackers') &&
                !text.includes('Perpetuals')) {
              results.push(text);
            }
          }
        }
        return results;
      })()`) as string[];

      const uniqueTweets = Array.from(new Set(tweets)).slice(0, 15);

      if (uniqueTweets.length === 0) {
        logger.warn('No tweets found - check if Twitter Alerts tab is visible');
      } else {
        logger.info({ count: uniqueTweets.length }, 'Scraped Axiom Twitter feed');
      }

      return uniqueTweets;

    } catch (e) {
      logger.error({ error: e }, 'Scrape failed');
      return [];
    }
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
    }
    this.browser = null;
    this.page = null;
  }

  // Take a screenshot for debugging
  async takeScreenshot(filename: string = 'axiom-debug.png'): Promise<void> {
    if (!this.page) await this.initialize();
    await this.page!.screenshot({ path: filename, fullPage: false });
    logger.info({ path: filename }, 'Screenshot saved');
  }

  // --- GEMINI ANALYSIS ---
  async getMarketSignal(): Promise<AxiomNarrativeSignal> {
    const tweets = await this.scrapeFeed();

    if (tweets.length === 0) {
      return {
        sentiment: 'neutral',
        bullishnessScore: 0,
        hypeScore: 0,
        keywords: [],
        tweetCount: 0,
        sampleTweets: []
      };
    }

    const prompt = `Analyze these crypto tweets from a trading alpha feed.

Tweets:
${tweets.join('\n---\n')}

Return JSON only (no markdown):
{ "bullishnessScore": number (-1 to 1), "hypeScore": number (0 to 1), "keywords": string[] }`;

    try {
      const result = await model.generateContent(prompt);
      const text = result.response.text().replace(/```json|```/g, '').trim();
      const data = JSON.parse(text);

      return {
        sentiment: data.bullishnessScore > 0.2 ? 'bullish' : data.bullishnessScore < -0.2 ? 'bearish' : 'neutral',
        bullishnessScore: data.bullishnessScore,
        hypeScore: data.hypeScore,
        keywords: data.keywords || [],
        tweetCount: tweets.length,
        sampleTweets: tweets.slice(0, 3)
      };
    } catch (e) {
      logger.error({ error: e }, 'Gemini analysis failed');
      return {
        sentiment: 'neutral',
        bullishnessScore: 0,
        hypeScore: 0,
        keywords: [],
        tweetCount: tweets.length,
        sampleTweets: tweets.slice(0, 3)
      };
    }
  }

  // Enable headless mode after first successful login
  setHeadless(enabled: boolean): void {
    this.headlessMode = enabled;
  }
}

export const axiomSensor = new AxiomSensor();
