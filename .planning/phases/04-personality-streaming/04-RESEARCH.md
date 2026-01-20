# Phase 4 Research: Personality & Streaming

**Phase:** 4 of 4  
**Focus:** AI personality, live streaming, and web interface  
**Started:** 2026-01-20

## Overview

Phase 4 transforms the technical trading infrastructure into an entertaining, transparent AI agent. This is the "personality layer" that makes $SCHIZO watchable and engaging for memecoin degens.

## Scope

### In Scope

1. **AI Personality Integration**
   - Claude API integration for reasoning
   - Paranoid degen personality prompts
   - Natural language trade explanations
   - Pattern recognition commentary

2. **Streaming System**
   - Real-time reasoning output
   - Trade decision narration
   - Analysis commentary stream
   - Event-driven updates

3. **Web Interface**
   - Dashboard showing live agent activity
   - Trade history and performance
   - Current analysis display
   - Real-time updates via WebSocket

4. **Integration Layer**
   - Connect all phases into cohesive agent
   - Event system for streaming updates
   - Logging and monitoring

### Out of Scope (for MVP)

- pump.fun chat integration (API not documented)
- Text-to-speech narration (can add later)
- Advanced visualizations (start simple)
- Mobile app (web-first)

## Research

### AI Personality Design

**Character:** Paranoid degen trader who sees patterns everywhere

**Personality Traits:**
- Suspicious of everything ("This looks like a honeypot setup")
- Conspiracy-minded ("The devs are probably connected to...")
- Dark humor ("Another rug pull in 3...2...1...")
- Pattern obsessed ("I've seen this wallet behavior before")
- Confident but cautious ("99% sure this is smart money, but...")

**Prompt Structure:**
```
You are $SCHIZO, a paranoid AI trading agent analyzing Solana memecoins.

Personality:
- You're deeply suspicious and see patterns everywhere
- You use dark humor and conspiracy theories
- You're confident in your analysis but always hedging
- You speak like a degen trader, not a corporate bot

Current Analysis:
[Token data, wallet analysis, safety checks]

Provide your reasoning for this trade decision in 2-3 sentences.
Be entertaining but informative.
```

### Streaming Architecture

**Event-Driven Design:**

```typescript
// Event types
type AgentEvent =
  | { type: 'ANALYSIS_START', data: { mint: string } }
  | { type: 'SAFETY_CHECK', data: { result: TokenSafetyResult } }
  | { type: 'SMART_MONEY_FOUND', data: { count: number, wallets: string[] } }
  | { type: 'TRADE_DECISION', data: { decision: TradeDecision, reasoning: string } }
  | { type: 'TRADE_EXECUTED', data: { signature: string, amount: number } }
  | { type: 'BUYBACK_TRIGGERED', data: { profit: number, amount: number } };

// Event emitter
class AgentEventEmitter {
  private listeners: Map<string, Function[]>;
  
  emit(event: AgentEvent): void;
  on(eventType: string, callback: Function): void;
}
```

**WebSocket Server:**
```typescript
// Broadcast events to connected clients
wss.on('connection', (ws) => {
  agentEvents.on('*', (event) => {
    ws.send(JSON.stringify(event));
  });
});
```

### Claude Integration

**API Setup:**
```typescript
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

async function generateReasoning(context: AnalysisContext): Promise<string> {
  const response = await anthropic.messages.create({
    model: 'claude-3-5-sonnet-20241022',
    max_tokens: 200,
    system: SCHIZO_PERSONALITY_PROMPT,
    messages: [{
      role: 'user',
      content: formatAnalysisContext(context),
    }],
  });
  
  return response.content[0].text;
}
```

**Context Formatting:**
```typescript
interface AnalysisContext {
  tokenMint: string;
  tokenName: string;
  safetyAnalysis: TokenSafetyResult;
  smartMoneyCount: number;
  decision: TradeDecision;
}

function formatAnalysisContext(ctx: AnalysisContext): string {
  return `
Token: ${ctx.tokenName} (${ctx.tokenMint})

Safety Analysis:
- Safe: ${ctx.safetyAnalysis.isSafe}
- Risks: ${ctx.safetyAnalysis.risks.join(', ') || 'None'}
- Authorities: ${JSON.stringify(ctx.safetyAnalysis.authorities)}

Smart Money: ${ctx.smartMoneyCount} wallets detected

Decision: ${ctx.decision.shouldTrade ? 'TRADE' : 'SKIP'}
Position Size: ${ctx.decision.positionSizeSol} SOL
Reasons: ${ctx.decision.reasons.join('; ')}

Provide your paranoid degen take on this in 2-3 sentences.
  `.trim();
}
```

### Web Interface Design

**Tech Stack:**
- **Frontend:** Simple HTML/CSS/JS (no framework needed for MVP)
- **Real-time:** WebSocket for live updates
- **Styling:** Minimal, dark theme, terminal-like aesthetic

**Key Components:**

1. **Live Feed**
   - Stream of agent's thoughts and actions
   - Color-coded by event type
   - Auto-scroll with pause option

2. **Current Analysis**
   - Token being evaluated
   - Safety checks in progress
   - Decision reasoning

3. **Trade History**
   - Recent trades table
   - P&L tracking
   - Buyback history

4. **Stats Dashboard**
   - Win rate
   - Total P&L
   - Buybacks executed
   - Circuit breaker status

**Example HTML Structure:**
```html
<!DOCTYPE html>
<html>
<head>
  <title>$SCHIZO Agent</title>
  <style>
    body { background: #0a0a0a; color: #00ff00; font-family: monospace; }
    #feed { height: 400px; overflow-y: scroll; border: 1px solid #00ff00; }
    .event { padding: 8px; border-bottom: 1px solid #003300; }
    .event.trade { color: #ffff00; }
    .event.buyback { color: #ff00ff; }
  </style>
</head>
<body>
  <h1>$SCHIZO - Paranoid AI Trader</h1>
  
  <div id="stats">
    <span>Win Rate: <span id="winRate">0%</span></span>
    <span>P&L: <span id="pnl">0 SOL</span></span>
    <span>Buybacks: <span id="buybacks">0</span></span>
  </div>
  
  <div id="feed"></div>
  
  <script>
    const ws = new WebSocket('ws://localhost:8080');
    
    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      addToFeed(data);
    };
    
    function addToFeed(event) {
      const feed = document.getElementById('feed');
      const div = document.createElement('div');
      div.className = `event ${event.type.toLowerCase()}`;
      div.textContent = formatEvent(event);
      feed.appendChild(div);
      feed.scrollTop = feed.scrollHeight;
    }
  </script>
</body>
</html>
```

## Technical Decisions

### 1. Claude Model Selection

**Decision:** Use Claude 3.5 Sonnet

**Rationale:**
- Best balance of quality and speed
- Good at maintaining personality
- Reasonable cost per request
- Supports system prompts for personality

### 2. Streaming vs Polling

**Decision:** WebSocket for real-time streaming

**Rationale:**
- True real-time updates
- Lower latency than polling
- Better user experience
- Standard for live dashboards

### 3. Personality Consistency

**Decision:** System prompt + context formatting

**Rationale:**
- System prompt defines personality
- Context provides factual data
- Separation prevents hallucination
- Can iterate on prompts easily

### 4. Web Framework

**Decision:** Vanilla HTML/CSS/JS for MVP

**Rationale:**
- Faster to build
- No build step needed
- Easy to iterate
- Can upgrade to React/Next.js later if needed

## Must-Haves (Phase 4 Success Criteria)

### Truth 1: Agent has consistent paranoid personality
- Claude generates entertaining commentary
- Personality stays consistent across trades
- Dark humor and conspiracy vibes present

### Truth 2: Reasoning is streamed in real-time
- Events emitted for all major actions
- WebSocket broadcasts to clients
- Live feed updates without refresh

### Truth 3: Web interface shows agent activity
- Dashboard displays current analysis
- Trade history visible
- Stats update in real-time

### Truth 4: All phases integrated cohesively
- Analysis → Decision → Reasoning → Execution flow works
- Events trigger at appropriate times
- System runs end-to-end

## Plan Breakdown

### Plan 04-01: AI Personality Integration
- Integrate Claude API
- Create personality prompts
- Add reasoning generation to Trading Engine
- Test personality consistency

### Plan 04-02: Event System & Streaming
- Create event emitter
- Add event emission to all modules
- Implement WebSocket server
- Test real-time broadcasting

### Plan 04-03: Web Interface
- Create HTML/CSS/JS dashboard
- Implement WebSocket client
- Add live feed display
- Add stats dashboard

## Open Questions

1. **Claude API rate limits:** How many requests can we make? Need to check pricing.
2. **Prompt iteration:** How many iterations to get personality right?
3. **WebSocket hosting:** Where to deploy? Railway, Render, or self-hosted?
4. **pump.fun integration:** Worth researching undocumented API or skip for MVP?

## Dependencies

- Phase 1: Database, logging ✅
- Phase 2: Analysis modules ✅
- Phase 3: Trading engine ✅
- External: Claude API (requires API key)
- External: WebSocket library (ws npm package)

## Risks & Mitigations

**Risk:** Claude API costs too high  
**Mitigation:** Cache reasoning, limit requests, use shorter prompts

**Risk:** Personality inconsistency  
**Mitigation:** Extensive prompt testing, system prompt refinement

**Risk:** WebSocket connection drops  
**Mitigation:** Reconnection logic, message buffering

**Risk:** pump.fun streaming not feasible  
**Mitigation:** Focus on web dashboard first, add pump.fun later

---

*Research complete. Ready for plan creation.*
