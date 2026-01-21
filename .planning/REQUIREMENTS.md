# Requirements: $SCHIZO

**Defined:** 2026-01-20
**Core Value:** Self-funding AI trader with deep wallet forensics and entertaining paranoid personality

## v1 Requirements

### Foundation

- [x] **FOUND-01**: Encrypted keystore for wallet private key management
- [x] **FOUND-02**: SQLite state store for trades, analysis results, and P&L tracking
- [x] **FOUND-03**: Rate-limited Helius client with caching layer for API efficiency

### Analysis

- [x] **ANAL-01**: Token safety checks (honeypot detection, rug indicators)
- [x] **ANAL-02**: Deep forensic wallet analysis using getTransactionsForAddress (full history patterns)
- [x] **ANAL-03**: Smart money wallet tracking (identify and follow winning wallets)

### Trading

- [x] **TRADE-01**: DEX execution via PumpPortal API (buy/sell memecoins)
- [x] **TRADE-02**: Position sizing limits (max per trade, total exposure caps)
- [x] **TRADE-03**: Stop-loss and take-profit automatic exit rules

### Economic Loop

- [x] **ECON-01**: Auto-claim pump.fun creator fees via PumpPortal collectCreatorFee
- [x] **ECON-02**: Configurable fee split between creator wallet and agent trading wallet
- [x] **ECON-03**: Buyback mechanism - profits trigger $SCHIZO token purchases

### Personality & Streaming

- [x] **PERS-01**: Paranoid degen personality in all Claude outputs
- [x] **PERS-02**: Live reasoning stream to pump.fun token page
- [x] **PERS-03**: Web dashboard showing real-time analysis, trades, and P&L
- [x] **PERS-04**: Voice output via TTS (ElevenLabs or similar) for stream narration
- [x] **PERS-05**: Streamable terminal/code view showing agent in action

## v2 Requirements

### Enhanced Safety

- **SAFE-01**: MEV protection via Jito bundles
- **SAFE-02**: Advanced rug detection (liquidity lock analysis, dev wallet patterns)

### Enhanced Analysis

- **ANAL-04**: Trust scoring system for tokens based on holder/dev behavior
- **ANAL-05**: Cabal detection (coordinated wallet networks)

### Enhanced Personality

- **PERS-06**: Interactive chat responses (viewers can ask questions)
- **PERS-07**: Mood system based on P&L (more paranoid when losing)

## Out of Scope

| Feature | Reason |
|---------|--------|
| X/Twitter integration | API costs prohibitive |
| Mobile app | Web-first, streaming focus |
| Multi-chain support | Solana only for v1 |
| Copy-trading for users | Focus on agent trading first |
| LaserStream integration | Requires higher Helius tier |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| FOUND-01 | Phase 1 | Complete |
| FOUND-02 | Phase 1 | Complete |
| FOUND-03 | Phase 1 | Complete |
| ANAL-01 | Phase 2 | Complete |
| ANAL-02 | Phase 2 | Complete |
| ANAL-03 | Phase 2 | Complete |
| TRADE-01 | Phase 3 | Complete |
| TRADE-02 | Phase 3 | Complete |
| TRADE-03 | Phase 3 | Complete |
| ECON-01 | Phase 3 | Complete |
| ECON-02 | Phase 3 | Complete |
| ECON-03 | Phase 3 | Complete |
| PERS-01 | Phase 4 | Complete |
| PERS-02 | Phase 4 | Complete |
| PERS-03 | Phase 4 | Complete |
| PERS-04 | Phase 4 | Complete |
| PERS-05 | Phase 4 | Complete |

**Coverage:**
- v1 requirements: 17 total
- Mapped to phases: 17
- Complete: 17

---
*Requirements defined: 2026-01-20*
*Last updated: 2026-01-21 after Phase 4 completion*
