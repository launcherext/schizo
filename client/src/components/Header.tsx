import React from 'react';

interface HeaderProps {
  isConnected: boolean;
}

export const Header: React.FC<HeaderProps> = ({ isConnected }) => {
  return (
    <header className="header">
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
