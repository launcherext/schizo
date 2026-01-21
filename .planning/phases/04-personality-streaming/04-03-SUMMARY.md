---
phase: 04-personality-streaming
plan: 03
subsystem: personality
tags: [commentary, speech-timing, narrative-beats, mood-integration]

# Dependency graph
requires:
  - phase: 04-01
    provides: MoodSystem for style modifiers and timing
provides:
  - CommentarySystem class for speech timing and queueing
  - Priority-based commentary queue
  - Mood-aware prompt helpers
  - Paranoid musing and time pressure prompts
affects: [04-streaming-integration, frontend-tts]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - Narrative beat pattern for speech triggers
    - Priority queue with expiry for commentary
    - Callback pattern for speech emission

key-files:
  created:
    - src/personality/commentary-system.ts
  modified:
    - src/personality/prompts.ts
    - src/personality/index.ts

key-decisions:
  - "Commentary only triggers at narrative beats (DISCOVERY, ANALYSIS, DECISION, TRADE_RESULT, PARANOID_MUSING, TIME_PRESSURE)"
  - "15 second minimum gap between speech events"
  - "Priority order: TRADE_RESULT > DECISION > ANALYSIS > DISCOVERY > TIME_PRESSURE > PARANOID_MUSING"
  - "Queue max size 3, lowest priority dropped when full"
  - "isInteresting() filter prevents commentary on every token scan"

patterns-established:
  - "NarrativeBeat enum for categorizing speech triggers"
  - "Commentary queue with priority and expiry timestamps"
  - "Mood style modifiers injected into prompts"

# Metrics
duration: 5min
completed: 2026-01-20
---

# Phase 4 Plan 3: Commentary System Summary

**CommentarySystem class controlling when/how SCHIZO speaks with priority queue, timing enforcement, and mood-aware prompts**

## Performance

- **Duration:** 5 min
- **Started:** 2026-01-20
- **Completed:** 2026-01-20
- **Tasks:** 3
- **Files modified:** 3

## Accomplishments
- Created CommentarySystem class with priority-based commentary queue
- Enforces 15-20 second minimum gap between speech events
- NarrativeBeat enum: DISCOVERY, ANALYSIS, DECISION, TRADE_RESULT, PARANOID_MUSING, TIME_PRESSURE
- Priority system ensures trade results always reported, low-priority filler dropped when busy
- isInteresting() filter prevents commentary spam on every token scan
- Automatic paranoid musings during quiet periods (60s+ without speech)
- Added getMoodStyleModifier() with distinct styles for all 6 moods
- Added getParanoidMusingPrompts() (15 conspiracy-themed prompts)
- Added getTimePressurePrompts() (12 restlessness prompts)

## Task Commits

Each task was committed atomically:

1. **Task 1: Create CommentarySystem class** - `2f72124` (feat)
2. **Task 2: Add mood-aware prompts** - `30cd9f2` (feat)
3. **Task 3: Export CommentarySystem** - `b114f58` (feat)

## Files Created/Modified
- `src/personality/commentary-system.ts` - CommentarySystem class with queue, timing, and generation
- `src/personality/prompts.ts` - Added getMoodStyleModifier, getParanoidMusingPrompts, getTimePressurePrompts
- `src/personality/index.ts` - Export all new components

## Decisions Made
- Commentary triggers only at "narrative beats" - not every token scan
- 15s minimum gap is enforced by canSpeak() check
- Queue max size 3 prevents buildup, lowest priority items dropped
- Commentary expires after 30s to prevent stale context
- Quiet period check runs every 10s, triggers musing after 60s silence
- Mood style modifiers are injected into prompts for consistent personality

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- CommentarySystem ready for integration with streaming frontend
- Works with MoodSystem for timing and style
- Ready for TTS integration (onSpeech callback)
- Trading engine can call queueCommentary() at narrative beats

---
*Phase: 04-personality-streaming*
*Completed: 2026-01-20*
