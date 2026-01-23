import React, { useState } from 'react';

interface HeaderProps {
  isConnected: boolean;
}

export const Header: React.FC<HeaderProps> = ({ isConnected }) => {
  const [showComingSoon, setShowComingSoon] = useState(false);

  const handleJoinWorld = () => {
    setShowComingSoon(true);
    setTimeout(() => setShowComingSoon(false), 2000);
  };

  return (
    <header className="header">
      {/* Left side - Social buttons */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        marginLeft: '20px'
      }}>
        <a
          href="https://x.com/BloxBotTrades"
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '40px',
            height: '40px',
            borderRadius: '10px',
            background: 'rgba(0, 0, 0, 0.6)',
            border: '1px solid rgba(255, 255, 255, 0.2)',
            cursor: 'pointer',
            transition: 'all 0.2s ease',
            textDecoration: 'none'
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'rgba(29, 161, 242, 0.3)';
            e.currentTarget.style.borderColor = '#1DA1F2';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'rgba(0, 0, 0, 0.6)';
            e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.2)';
          }}
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="white"
          >
            <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
          </svg>
        </a>
        <button
          onClick={handleJoinWorld}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '8px',
            padding: '10px 20px',
            borderRadius: '10px',
            background: showComingSoon
              ? 'linear-gradient(135deg, #666 0%, #444 100%)'
              : 'linear-gradient(135deg, #FFD700 0%, #FFA500 100%)',
            border: 'none',
            cursor: 'pointer',
            transition: 'all 0.2s ease',
            fontFamily: "'Fredoka', sans-serif",
            fontSize: '14px',
            fontWeight: 600,
            color: showComingSoon ? '#fff' : '#000',
            textShadow: showComingSoon ? 'none' : '0 1px 2px rgba(255,255,255,0.3)',
            boxShadow: showComingSoon
              ? '0 4px 15px rgba(0, 0, 0, 0.3)'
              : '0 4px 15px rgba(255, 215, 0, 0.4)',
          }}
          onMouseEnter={(e) => {
            if (!showComingSoon) {
              e.currentTarget.style.transform = 'scale(1.05)';
              e.currentTarget.style.boxShadow = '0 6px 20px rgba(255, 215, 0, 0.5)';
            }
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.transform = 'scale(1)';
            e.currentTarget.style.boxShadow = showComingSoon
              ? '0 4px 15px rgba(0, 0, 0, 0.3)'
              : '0 4px 15px rgba(255, 215, 0, 0.4)';
          }}
        >
          <span>{showComingSoon ? 'Coming Soon!' : 'Join World'}</span>
        </button>
      </div>

      {/* Center - Logo */}
      <div style={{
        position: 'absolute',
        left: '50%',
        transform: 'translateX(-50%)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '16px'
      }}>
        <img
          src="/blox-icon.png"
          alt="Blox Bot"
          style={{
            height: '70px',
            width: 'auto',
            objectFit: 'contain',
            borderRadius: '12px',
            boxShadow: '0 4px 20px rgba(0, 209, 102, 0.3)'
          }}
        />
        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
          <h1 style={{
            margin: 0,
            fontFamily: "'Fredoka', sans-serif",
            fontSize: '32px',
            fontWeight: 700,
            color: '#ffffff',
            textShadow: '0 2px 4px rgba(0,0,0,0.3), 0 0 20px rgba(0, 209, 102, 0.4)',
            letterSpacing: '0.02em'
          }}>
            BLOX BOT
          </h1>
          <span style={{
            fontFamily: "'Fredoka', sans-serif",
            fontSize: '12px',
            fontWeight: 500,
            color: '#00d166',
            textTransform: 'uppercase',
            letterSpacing: '0.15em'
          }}>
            Roblox Trading Agent
          </span>
        </div>
      </div>

      {/* Right side - Status badge */}
      <div
        className="live-badge"
        style={{
          background: isConnected ? 'rgba(0, 255, 136, 0.15)' : 'rgba(255, 71, 87, 0.15)',
          borderColor: isConnected ? '#00ff88' : '#ff4757',
          color: isConnected ? '#00ff88' : '#ff4757'
        }}
      >
        {isConnected && <span className="live-dot"></span>}
        <span>{isConnected ? 'Playing' : 'Offline'}</span>
      </div>
    </header>
  );
};
