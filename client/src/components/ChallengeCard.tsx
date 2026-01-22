import React, { useEffect, useState } from 'react';
import type { Stats } from '../types';

interface ChallengeCardProps {
  stats: Stats;
}

export const ChallengeCard: React.FC<ChallengeCardProps> = ({ stats }) => {
  const multiplier = parseFloat(stats.multiplier || "1");
  const equity = parseFloat(stats.currentEquity || stats.initialCapital || "1");
  const initial = parseFloat(stats.initialCapital || "1");
  
  // Progress calculation (logarithmic scale feels better but linear for now as per original)
  // Max at 100x
  const progress = Math.min(100, Math.max(1, multiplier));

  const [displayMultiplier, setDisplayMultiplier] = useState(multiplier);
  
  useEffect(() => {
    setDisplayMultiplier(multiplier);
  }, [multiplier]);

  return (
    <div className="card">
      <div className="challenge-card">
        <div className="challenge-label">THE 1 → 100 CHALLENGE</div>
        <div className="challenge-value animate-number">
          {displayMultiplier.toFixed(2)}<span>x</span>
        </div>
        <div className="challenge-sub">
          {equity.toFixed(2)} SOL from {initial} SOL start
        </div>
        <div className="progress-bar-container">
          <div className="progress-bar">
            <div 
              className="progress-fill" 
              style={{ width: `${progress}%` }}
            ></div>
          </div>
          <div className="progress-markers">
            <span className={multiplier >= 1 ? 'active' : ''}>1x</span>
            <span className={multiplier >= 10 ? 'active' : ''}>10x</span>
            <span className={multiplier >= 25 ? 'active' : ''}>25x</span>
            <span className={multiplier >= 50 ? 'active' : ''}>50x</span>
            <span className={multiplier >= 100 ? 'active' : ''}>100x</span>
          </div>
        </div>
      </div>
    </div>
  );
};
