import { Header } from './components/Header';
import { StatsGrid } from './components/StatsGrid';
import { ChallengeCard } from './components/ChallengeCard';
import { TokenScanner } from './components/TokenScanner';
import { TradeList } from './components/TradeList';
import { AIStatus } from './components/AIStatus';
import { Watchlist } from './components/Watchlist';
import { Positions } from './components/Positions';
import { EquityChart } from './components/EquityChart';
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
    watchlistStats
  } = useSocket();

  return (
    <>
      <div className="dashboard">
        <Header isConnected={isConnected} />
        
        <StatsGrid stats={stats} />

        <div className="main-grid">
          <div className="left-column">
            <ChallengeCard stats={stats} />
            <EquityChart history={equityHistory} walletBalance={walletState?.solBalance} />
            <Positions positions={positions} summary={positionsSummary} />
            <TokenScanner data={scannerData || undefined} isScanning={isScanning} />
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
