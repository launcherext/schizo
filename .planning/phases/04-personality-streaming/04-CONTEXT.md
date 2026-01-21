# Phase 4: Personality & Streaming - Context

**Gathered:** 2026-01-20
**Status:** Ready for planning

<domain>
## Phase Boundary

Agent has a distinctive paranoid personality and streams its reasoning live. Includes: Claude personality system, live streaming to pump.fun, web dashboard with real-time data, TTS voice narration, and streamable terminal view.

**Core Problem Being Solved:**
Current implementation is boring because:
1. Agent rarely trades (too conservative)
2. Not enough visible activity in the feed
3. Voice triggers too frequently when data is shown, feels unnatural

</domain>

<decisions>
## Implementation Decisions

### Trading Behavior (Entertainment Mode)
- **Degen gambler style** — Takes risks, trades frequently, big swings are entertainment
- **Target: 3-5 trades per hour** — Active trading, willing to take L's for entertainment
- **Micro bets: 0.01-0.05 SOL per trade** — Can make many trades, losses don't hurt
- **Calculated chaos justification** — "Risk score is 7/10 but position size is small... let's see what happens"

### Trade Trigger Adjustments
- **Time-based pressure** — If no trade in 5-10 minutes, lower risk threshold ("It's been too quiet... I need to make a move")
- **Volume/hype signals** — If token has momentum/volume, trade even if risk score is mediocre
- **Random degen moments** — Occasionally just ape with minimal analysis ("you know what, I'm feeling it")

### Commentary System
- **Narrative beats** — Speaks at story moments: starting analysis, finding something, making decision, trade result
- **Paranoid musings interleaved** — Conspiracy theories about wallets, market manipulation takes, degen wisdom during quiet moments
- **Running commentary on discoveries** — Claude narrates as data appears: "checking wallets... oh that's interesting..."
- **15-20 second minimum gap** — Never speak more than once per 15-20 seconds, queue if needed
- **Silence is fine** — Let the live data streaming be the ambient activity, no thinking sounds/text needed

### Loss Reactions
- **Paranoid blame** — "The whales got me... they KNEW I was watching that one"
- Blame market manipulation, coordinated rugs, insider trading

### Mood System
- **Visible moods that affect trading** — Confident after wins, paranoid after losses, bored/antsy during quiet periods
- Moods should be displayed and influence decision-making style

### Visual Focus
- **Token analysis as main content** — Show the detective work (wallet forensics, risk scores, connections)
- **Live data streaming** — Numbers updating real-time, wallet connections appearing, risk scores climbing
- **Frontend is fine as-is** — Backend changes needed, not UI restructuring

### Claude's Discretion
- Exact mood transition logic
- Specific paranoid phrases and conspiracy theories
- How to queue/prioritize speech when multiple events happen
- Visual styling of mood indicators

</decisions>

<specifics>
## Specific Ideas

- Entertainment rhythm: Scan (silent, data streaming) → Discovery (Claude speaks) → Decision (Claude speaks) → Result (Claude speaks)
- Time pressure creates natural drama: "It's been 8 minutes... I'm getting antsy... this next token better be tradeable"
- Losses should fuel paranoia: "This was coordinated. I saw the wallet cluster. They wanted this."
- Wins should build confidence: mood shifts to more aggressive trading temporarily

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 04-personality-streaming*
*Context gathered: 2026-01-20*
