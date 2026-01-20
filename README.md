# $SCHIZO Agent

Paranoid AI trading agent with deep wallet forensics and entertaining personality.

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment

Create `.env` file (already created with your Helius key):

```bash
# Get Anthropic API key from: https://console.anthropic.com/
ANTHROPIC_API_KEY=your-key-here

# Your $SCHIZO token mint address
SCHIZO_TOKEN_MINT=your-token-mint-here
```

### 3. Run the Agent

```bash
npm run dev
```

### 4. Open Dashboard

Open `public/index.html` in your browser to see the live dashboard at `ws://localhost:8080`

## What You Have

✅ **Phase 1: Foundation**
- SQLite database for persistence
- Helius API integration
- Secure logging

✅ **Phase 2: Analysis**
- Token safety analyzer (honeypot detection)
- Wallet analyzer (P&L calculation)
- Smart money tracker

✅ **Phase 3: Trading & Economic Loop**
- PumpPortal client (ready for trading)
- Trading Engine with risk management
- Fee claiming and buyback system

✅ **Phase 4: Personality & Streaming**
- Claude AI personality integration
- Real-time event streaming via WebSocket
- Live web dashboard

## Getting Your API Keys

### Anthropic API Key (Required for AI Personality)

1. Go to https://console.anthropic.com/
2. Sign up for an account
3. Navigate to API Keys
4. Create a new key
5. Copy to `.env` file

**Cost:** $5 free credit, then pay-as-you-go (~$0.003 per response)

### Your Token Mint (Optional)

If you have a $SCHIZO token deployed:
1. Get the mint address from pump.fun or Solscan
2. Add to `.env` as `SCHIZO_TOKEN_MINT`

## Project Structure

```
src/
├── index.ts              # Main entry point
├── api/                  # Helius API client
├── db/                   # SQLite database
├── analysis/             # Token safety & smart money
├── trading/              # Trading engine & PumpPortal
├── personality/          # Claude AI integration
├── events/               # Event system
└── server/               # WebSocket server

public/
├── index.html            # Dashboard
├── styles.css            # $SCHIZO branding
└── app.js                # WebSocket client
```

## Next Steps

1. **Get Anthropic API key** - Add to `.env`
2. **Test the dashboard** - Open `public/index.html`
3. **Analyze a token** - Use the analysis modules
4. **Deploy** - Railway, Render, or VPS

## Development

```bash
# Run with TypeScript compilation
npm run dev

# Build for production
npm run build

# Run tests
npm run dev -- --test
```

## Notes

- **Read-only mode**: No PumpPortal API needed for analysis
- **Safe to test**: All analysis is read-only via Helius
- **AI optional**: Agent works without Claude, just less entertaining

---

Built with paranoia and pattern recognition 🔍
