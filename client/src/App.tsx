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

      <div className="floating-controls">
        <div 
          className="wallet-pill" 
          onClick={() => {
            navigator.clipboard.writeText('8FvP3dYCYf1gaQ1DnXyjERkDvmFK1odrQepcVQLvHDxB');
            // You might want to add a toast here, but for now a simple console log or visual usage is fine
            // Since we don't have direct access to `setToast` here without prop drilling or context moving, 
            // we'll rely on the visual feedback defined in CSS (:active state)
          }}
          title="Click to copy address"
        >
          <span className="wallet-label">DONATE</span>
          <span className="wallet-address">8FvP...HDxB</span>
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
          </svg>
        </div>

        <a href="https://x.com/100xClaude" target="_blank" rel="noopener noreferrer" className="x-profile-link">
          <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor">
            <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
          </svg>
        </a>
      </div>
    </>
  );
}

export default App;
