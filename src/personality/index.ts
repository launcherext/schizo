/**
 * Personality module exports
 */

export { ClaudeClient, DEFAULT_CLAUDE_CONFIG } from './claude-client.js';
export type { ClaudeConfig } from './claude-client.js';
export {
  SCHIZO_SYSTEM_PROMPT,
  formatAnalysisContext,
  formatBuybackContext,
  getMoodStyleModifier,
  getParanoidMusingPrompts,
  getTimePressurePrompts,
} from './prompts.js';
export type { AnalysisContext } from './prompts.js';
export { MoodSystem } from './mood-system.js';
export type { Mood, MoodState, MoodConfig, MoodEffects } from './mood-system.js';
export { CommentarySystem, DEFAULT_COMMENTARY_CONFIG } from './commentary-system.js';
export type { CommentaryConfig, NarrativeBeat, QueuedCommentary, CommentaryContext } from './commentary-system.js';
