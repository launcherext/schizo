# Analysis Architecture Diagram

## Current Integration Status

```mermaid
flowchart TB
    subgraph "Data Sources"
        PP[("🔌 PumpPortal<br/>New Tokens")]
        DS[("📊 DexScreener<br/>Market Data")]
        HL[("⚡ Helius<br/>On-chain Data")]
    end

    subgraph "Trading Pipeline"
        SP["🎯 Sniper Pipeline"]
        TV["Token Validator"]
        TE["Trading Engine"]
        SE["Scoring Engine"]
    end

    subgraph "Analysis Module" 
        direction TB
        TS["✅ TokenSafetyAnalyzer<br/>INTEGRATED"]
        SM["✅ SmartMoneyTracker<br/>INTEGRATED"]
        WA["⚠️ WalletAnalyzer<br/>via SmartMoney only"]
        
        MS["❌ MomentumScanner<br/>NOT INTEGRATED"]
        BD["❌ BundleDetector<br/>NOT INTEGRATED"]
        MW["❌ MarketWatcher<br/>Passive observer"]
        LE["❌ LearningEngine<br/>NOT INTEGRATED"]
    end

    PP --> SP
    SP --> TV
    TV --> DS
    TV -->|"passes"| TS
    TS --> TE
    TE --> SE
    SE --> SM
    SM --> WA
    HL --> TS
    HL --> WA

    style TS fill:#28a745,color:white
    style SM fill:#28a745,color:white
    style WA fill:#ffc107,color:black
    style MS fill:#dc3545,color:white
    style BD fill:#dc3545,color:white
    style MW fill:#dc3545,color:white
    style LE fill:#dc3545,color:white
```

---

## What TokenSafetyAnalyzer Checks ✅ (Updated)

```mermaid
flowchart LR
    subgraph "✅ ON-CHAIN AUTHORITIES"
        A1["Mint Authority"]
        A2["Freeze Authority"]
        A3["Permanent Delegate"]
        A4["Transfer Fee"]
        A5["Transfer Hook"]
    end
    
    subgraph "✅ HOLDER DISTRIBUTION (NEW)"
        B1["Top Holder % > 30%"]
        B2["Top 10 Holders % > 50%"]
        B3["Insider Concentration"]
    end
    
    subgraph "❌ STILL MISSING"
        C1["Bundle Detection"]
        C2["Momentum Analysis"]
    end
    
    style A1 fill:#28a745,color:white
    style A2 fill:#28a745,color:white
    style A3 fill:#28a745,color:white
    style A4 fill:#28a745,color:white
    style A5 fill:#28a745,color:white
    style B1 fill:#28a745,color:white
    style B2 fill:#28a745,color:white
    style B3 fill:#28a745,color:white
    style C1 fill:#dc3545,color:white
    style C2 fill:#dc3545,color:white
```

---

## Why 43% Insider Token Got Through

```mermaid
sequenceDiagram
    participant PP as PumpPortal
    participant SP as Sniper Pipeline
    participant DS as DexScreener
    participant TS as TokenSafetyAnalyzer
    participant TE as Trading Engine
    
    PP->>SP: New token detected
    SP->>SP: Wait 30s-2min
    SP->>DS: Get market data
    DS-->>SP: Liquidity ✓, Volume ✓
    SP->>TS: Analyze safety
    Note over TS: Only checks:<br/>- Mint authority ✓<br/>- Freeze authority ✓<br/>- Token-2022 ✓
    Note over TS: DOES NOT CHECK:<br/>- Top holder %<br/>- Insider %
    TS-->>SP: isSafe: true
    SP->>TE: Execute Buy
    Note over TE: 43% insider token<br/>BOUGHT! 💀
```

---

## Orphaned Code (Exists but Not Connected)

```mermaid
flowchart TB
    subgraph "Files Exist in src/analysis/"
        BD["bundle-detector.ts<br/>352 lines"]
        MS["momentum-scanner.ts<br/>444 lines"]
        LE["learning-engine.ts<br/>439 lines"]
    end
    
    subgraph "Trading Pipeline"
        TE["Trading Engine"]
    end
    
    BD -.->|"// Would need BundleDetector"| TE
    MS -.->|"// Would need MomentumScanner"| TE
    LE -.->|"Not called anywhere"| TE
    
    style BD fill:#6c757d,color:white
    style MS fill:#6c757d,color:white
    style LE fill:#6c757d,color:white
```

---

## Summary Table

| Analyzer | Lines | Purpose | Status |
|----------|-------|---------|--------|
| TokenSafetyAnalyzer | 157 | On-chain authority checks | ✅ Integrated |
| SmartMoneyTracker | 203 | Identify profitable wallets | ✅ Integrated |
| WalletAnalyzer | 310 | Parse wallet P&L | ⚠️ Indirect |
| MomentumScanner | 444 | Heat/buy pressure | ❌ Orphaned |
| BundleDetector | 352 | Detect coordinated buys | ❌ Orphaned |
| MarketWatcher | 532 | Passive learning | ❌ Passive |
| LearningEngine | 439 | Adjust weights | ❌ Orphaned |
