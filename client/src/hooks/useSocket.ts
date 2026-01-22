import { useEffect, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import type { Stats, ScannerData, Trade, ToastData, AIDecisionData, NarrativeSignal, WatchlistToken, WatchlistStats, C100Data } from '../types';

export interface Position {
  id: string;
  mint: string;
  name?: string;
  symbol: string;
  imageUrl?: string | null;
  amount: number;
  amountSol: number;
  entryPrice: number;
  currentPrice: number;
  highestPrice: number;
  unrealizedPnl: number;
  unrealizedPnlPercent: number;
  realizedPnl?: number;
  totalPnl?: number;
  totalPnlPercent?: number;
  stopLoss: number;
  trailingStop?: number;
  initialRecovered?: boolean;
  scaledExitsTaken?: number;
  status: string;
  poolType: string;
  entryTime: string;
  holdTime: number;
}

export interface WalletState {
  solBalance: number;
  lastSync: string | null;
  isHealthy: boolean;
  totalEquity?: number;
}

export interface EquitySnapshot {
  timestamp: string;
  totalEquity: number;
  walletBalance: number;
  positionsValue: number;
  unrealizedPnl: number;
  positionCount: number;
}

interface UseSocketReturn {
  socket: Socket | null;
  isConnected: boolean;
  stats: Stats;
  trades: Trade[];
  positions: Position[];
  positionsSummary: { totalUnrealizedPnl: string; totalExposure: string; positionCount: number } | null;
  walletState: WalletState | null;
  equityHistory: EquitySnapshot[];
  scannerData: ScannerData | null;
  isScanning: boolean;
  toasts: ToastData[];
  aiDecision: AIDecisionData | null;
  narrativeSignal: NarrativeSignal | null;
  watchlistTokens: WatchlistToken[];
  watchlistStats: WatchlistStats;
  c100Data: C100Data | null;
  removeToast: (index: number) => void;
}

export const useSocket = (): UseSocketReturn => {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  
  // Data State
  const [stats, setStats] = useState<Stats>({
    multiplier: "1.00",
    currentEquity: "0",
    initialCapital: "0",
    winRate: "0",
    totalTrades: 0,
    tokensScanned: 0,
    winStreak: 0
  });
  const [trades, setTrades] = useState<Trade[]>([]);
  const [positions, setPositions] = useState<Position[]>([]);
  const [positionsSummary, setPositionsSummary] = useState<{ totalUnrealizedPnl: string; totalExposure: string; positionCount: number } | null>(null);
  const [walletState, setWalletState] = useState<WalletState | null>(null);
  const [equityHistory, setEquityHistory] = useState<EquitySnapshot[]>([]);
  const [scannerData, setScannerData] = useState<ScannerData | null>(null);
  const [isScanning, setIsScanning] = useState(true);
  const [toasts, setToasts] = useState<ToastData[]>([]);
  const [aiDecision, setAiDecision] = useState<AIDecisionData | null>(null);
  const [narrativeSignal, setNarrativeSignal] = useState<NarrativeSignal | null>(null);
  const [watchlistTokens, setWatchlistTokens] = useState<WatchlistToken[]>([]);
  const [watchlistStats, setWatchlistStats] = useState<WatchlistStats>({ total: 0, ready: 0, devSold: 0 });
  const [c100Data, setC100Data] = useState<C100Data | null>(null);

  // Use ref to access latest functions in event callbacks if needed, 
  // but state setters are stable.

  const addToast = (toast: ToastData) => {
    setToasts(prev => [...prev, toast]);
    // Auto remove after 4s
    setTimeout(() => {
      setToasts(prev => prev.slice(1)); // Simple FIFO removal, might change reference index
    }, 4000);
  };

  const removeToast = (index: number) => {
    setToasts(prev => prev.filter((_, i) => i !== index));
  };

  useEffect(() => {
    // Initial fetch
    const fetchData = async () => {
      try {
        const [statsRes, tradesRes, positionsRes, walletRes, equityRes, c100Res] = await Promise.all([
          fetch('/api/stats'),
          fetch('/api/trades?limit=10'),
          fetch('/api/positions/realtime'),
          fetch('/api/wallet'),
          fetch('/api/equity-history?hours=24'),
          fetch('/api/c100/status')
        ]);
        if (statsRes.ok) setStats(await statsRes.json());
        if (tradesRes.ok) setTrades(await tradesRes.json());
        if (positionsRes.ok) {
          const posData = await positionsRes.json();
          setPositions(posData.positions || []);
          setPositionsSummary(posData.summary || null);
        }
        if (walletRes.ok) {
          const walletData = await walletRes.json();
          setWalletState({
            solBalance: walletData.solBalance,
            lastSync: walletData.lastSync,
            isHealthy: walletData.isHealthy,
            totalEquity: walletData.equity?.total
          });
        }
        if (equityRes.ok) {
          const equityData = await equityRes.json();
          setEquityHistory(equityData.history || []);
        }
        if (c100Res.ok) {
          setC100Data(await c100Res.json());
        }
      } catch (err) {
        console.error("Failed to fetch initial data", err);
      }
    };
    fetchData();

    // Socket Connection
    // Note: In development with Vite proxy, '/' works if proxy is set.
    // Otherwise might need absolute URL.
    const newSocket = io('/', {
      transports: ['polling', 'websocket'],
      reconnectionAttempts: 5,
      upgrade: true,
    });

    newSocket.on('connect', () => {
      setIsConnected(true);
      fetchData(); // Refresh on reconnect
    });

    newSocket.on('disconnect', () => {
      setIsConnected(false);
    });

    // Event Handlers
    newSocket.on('stats:initial', (data: Stats) => setStats(data));
    newSocket.on('stats:update', (data: Stats) => setStats(data));
    
    // Trades
    newSocket.on('trades:initial', (data: Trade[]) => setTrades(data));
    
    newSocket.on('trade:open', (trade: Trade) => {
      addToast({
        type: 'info',
        title: 'Position Opened',
        message: `Bought ${trade.symbol || trade.mint.substring(0, 8)} for ${trade.amountSol} SOL`
      });
      // Trade list is usually updated via rest fetch or full list push? 
      // The original code didn't update the list on 'trade:open', only on 'trade:close'.
      // But let's verify if we should.
    });

    newSocket.on('trade:close', (trade: Trade) => {
      const pnl = parseFloat(trade.pnlSol || "0");
      if (pnl > 0) {
        addToast({
          type: 'success',
          title: `+${trade.pnlSol} SOL`,
          message: `${trade.symbol} closed at ${trade.pnlPercent}%`
        });
      } else {
        addToast({
          type: 'error',
          title: `${trade.pnlSol} SOL`,
          message: `${trade.symbol} stopped out`
        });
      }
      // Refresh trades list
      fetch('/api/trades?limit=10')
        .then(r => r.json())
        .then(data => setTrades(data));
    });

    // Scanner
    newSocket.on('scanner:token', (data: ScannerData) => {
      setScannerData(data);
      setIsScanning(false);
      // Also update tokenScanned count in stats immediately if provided in data
      if (data.tokensScanned) {
        setStats(prev => ({ ...prev, tokensScanned: data.tokensScanned }));
      }
    });

    newSocket.on('scanner:idle', (data: ScannerData) => {
      setScannerData(null);
      setIsScanning(true);
      if (data && data.tokensScanned) {
        setStats(prev => ({ ...prev, tokensScanned: data.tokensScanned }));
      }
    });

    newSocket.on('ai:decision', (data: AIDecisionData) => {
      setAiDecision(data);
    });

    newSocket.on('signal:narrative', (data: NarrativeSignal) => {
      setNarrativeSignal(data);
    });

    // Watchlist events
    newSocket.on('watchlist:update', (data: { tokens: WatchlistToken[]; stats: WatchlistStats }) => {
      setWatchlistTokens(data.tokens);
      setWatchlistStats(data.stats);
    });

    newSocket.on('watchlist:tokenAdded', (token: WatchlistToken) => {
      setWatchlistTokens(prev => {
        // Add or update token
        const exists = prev.findIndex(t => t.mint === token.mint);
        if (exists >= 0) {
          const updated = [...prev];
          updated[exists] = token;
          return updated;
        }
        return [token, ...prev].slice(0, 20); // Keep latest 20
      });
    });

    newSocket.on('watchlist:tokenRemoved', (data: { mint: string }) => {
      setWatchlistTokens(prev => prev.filter(t => t.mint !== data.mint));
    });

    newSocket.on('watchlist:devSold', (data: { mint: string }) => {
      setWatchlistTokens(prev => prev.map(t =>
        t.mint === data.mint ? { ...t, devSold: true, status: 'rejected' as const, rejectReason: 'Dev sold' } : t
      ));
    });

    newSocket.on('status:paused', (data: { reason: string }) => {
      addToast({
        type: 'warning',
        title: 'Trading Paused',
        message: data.reason
      });
    });

    newSocket.on('toast', (data: ToastData) => {
      addToast(data);
    });

    // Position updates (real-time PnL)
    newSocket.on('positions:initial', (data: { positions: Position[]; totalUnrealizedPnl: string; totalExposure: string; positionCount: number }) => {
      setPositions(data.positions || []);
      setPositionsSummary({ totalUnrealizedPnl: data.totalUnrealizedPnl, totalExposure: data.totalExposure, positionCount: data.positionCount });
    });

    newSocket.on('positions:update', (data: { positions: Position[]; totalUnrealizedPnl: string; totalExposure: string; positionCount: number }) => {
      setPositions(data.positions || []);
      setPositionsSummary({ totalUnrealizedPnl: data.totalUnrealizedPnl, totalExposure: data.totalExposure, positionCount: data.positionCount });
    });

    // Wallet updates
    newSocket.on('wallet:update', (data: WalletState) => {
      setWalletState(data);
    });

    // Equity snapshots
    newSocket.on('equity:snapshot', (snapshot: EquitySnapshot) => {
      setEquityHistory(prev => {
        const updated = [...prev, snapshot];
        // Keep last 1440 snapshots (24 hours at 1 min intervals)
        if (updated.length > 1440) {
          return updated.slice(-1440);
        }
        return updated;
      });
    });

    // Reconciliation notifications
    newSocket.on('reconciliation:phantoms', (data: { count: number; phantoms: any[] }) => {
      if (data.count > 0) {
        addToast({
          type: 'warning',
          title: 'Phantom Positions Detected',
          message: `Found ${data.count} position(s) with no tokens`
        });
      }
    });

    // C100 events
    newSocket.on('c100:update', (data: C100Data) => {
      setC100Data(data);
    });

    newSocket.on('c100:priceUpdate', (tokenData: any) => {
      setC100Data(prev => prev ? { ...prev, token: tokenData } : null);
    });

    newSocket.on('c100:claim', (data: { source: string; amountSol: number }) => {
      setC100Data(prev => {
        if (!prev) return null;
        return {
          ...prev,
          claims: {
            ...prev.claims,
            totalClaimedSol: prev.claims.totalClaimedSol + data.amountSol,
            claimCount: prev.claims.claimCount + 1,
            lastClaimTime: new Date().toISOString(),
          }
        };
      });
    });

    newSocket.on('c100:buyback', (data: { amountSol: number; amountTokens: number }) => {
      setC100Data(prev => {
        if (!prev) return null;
        return {
          ...prev,
          buybacks: {
            ...prev.buybacks,
            totalBuybackSol: prev.buybacks.totalBuybackSol + data.amountSol,
            totalTokensBought: prev.buybacks.totalTokensBought + data.amountTokens,
            buybackCount: prev.buybacks.buybackCount + 1,
            lastBuybackTime: new Date().toISOString(),
          }
        };
      });
    });

    setSocket(newSocket);

    return () => {
      newSocket.disconnect();
    };
  }, []);

  return {
    socket,
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
    narrativeSignal,
    watchlistTokens,
    watchlistStats,
    c100Data,
    removeToast
  };
};
