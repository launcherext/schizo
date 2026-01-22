import { Header } from './components/Header';
import { StatsGrid } from './components/StatsGrid';
import { ChallengeCard } from './components/ChallengeCard';
import { TokenScanner } from './components/TokenScanner';
import { TradeList } from './components/TradeList';
import { AIStatus } from './components/AIStatus';
import { Watchlist } from './components/Watchlist';
import { Positions } from './components/Positions';
import { EquityChart } from './components/EquityChart';
import { C100Card } from './components/C100Card';
import { useSocket } from './hooks/useSocket';

function App() {
  const {
    isConnected,
    stats,
    trades,
    positions,
    positionsSummary,
    walletState,
    equityHistory,
    scannerData,
    isScanning,
    toasts,
    aiDecision,
    watchlistTokens,
    watchlistStats,
    c100Data
  } = useSocket();

  return (
    <>
      <div className="dashboard">
        <Header isConnected={isConnected} />
        
        <StatsGrid stats={stats} />

        <C100Card data={c100Data} />

        <div className="main-grid">
          <div className="left-column">
            <ChallengeCard stats={stats} />
            <TokenScanner data={scannerData || undefined} isScanning={isScanning} tokensScanned={stats.tokensScanned} />
            <EquityChart history={equityHistory} walletBalance={walletState?.solBalance} />
            <Positions positions={positions} summary={positionsSummary} />
          </div>

          <div className="right-column">
            <TradeList trades={trades} />
            <AIStatus stats={stats} decision={aiDecision} />
            <Watchlist tokens={watchlistTokens} stats={watchlistStats} />
          </div>
        </div>
      </div>

      <div className="toast-container">
        {toasts.map((toast, i) => (
          <div key={i} className={`toast ${toast.type}`}>
            <div className="toast-title">{toast.title}</div>
            <div className="toast-message">{toast.message}</div>
          </div>
        ))}
      </div>

      <a href="https://x.com/100xClaude" target="_blank" rel="noopener noreferrer" className="x-profile-link">
        <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor">
          <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
        </svg>
      </a>
    </>
  );
}

export default App;
