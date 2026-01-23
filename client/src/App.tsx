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


    </>
  );
}

export default App;
