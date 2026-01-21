// WebSocket client and UI logic for $SCHIZO dashboard

let ws;
let isPaused = false;
let isTokensPaused = false;
let buybackCount = 0;

// Get WebSocket URL based on environment
function getWebSocketUrl() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = window.location.host;

  // Local development
  if (host.includes('localhost') || host.includes('127.0.0.1')) {
    return 'ws://localhost:8080';
  }

  // Production - use same host
  return `${protocol}//${host}`;
}

// Connect to WebSocket server
function connect() {
  const wsUrl = getWebSocketUrl();
  console.log('Connecting to:', wsUrl);
  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    console.log('Connected to $SCHIZO agent');
    updateStatus('Connected', true);
  };

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    handleEvent(data);
  };

  ws.onerror = (error) => {
    console.error('WebSocket error:', error);
    updateStatus('Error', false);
  };

  ws.onclose = () => {
    console.log('Disconnected from $SCHIZO agent');
    updateStatus('Disconnected', false);
    // Attempt to reconnect after 5 seconds
    setTimeout(connect, 5000);
  };
}

// Handle incoming events
function handleEvent(event) {
  switch (event.type) {
    case 'CONNECTED':
      addToFeed('🟢 Connected to agent', 'system');
      break;
    case 'INITIAL_TRADES':
      // Load recent trades on connect/reconnect
      if (event.data.trades && event.data.trades.length > 0) {
        loadInitialTrades(event.data.trades);
      }
      break;
    case 'ANALYSIS_START':
      // Silent - the ANALYSIS_THOUGHT events show the live analysis
      break;
    case 'POSITIONS_UPDATE':
      updateHoldings(event.data.positions);
      // Update Trench Radio based on position state
      updateTrenchRadioFromPositions(event.data.positions);
      break;
    case 'ANALYSIS_THOUGHT':
      // SCHIZO's live analysis thoughts - show in feed!
      const stageEmojis = {
        scanning: '🔍',
        safety: '🛡️',
        smart_money: '🐋',
        decision: '🎯'
      };
      const stageLabels = {
        scanning: 'SCANNING',
        safety: 'SAFETY',
        smart_money: 'WHALES',
        decision: 'VERDICT'
      };
      const emoji = stageEmojis[event.data.stage] || '🤔';
      const label = stageLabels[event.data.stage] || 'ANALYSIS';
      addToFeed(`${emoji} [${label}] ${event.data.symbol}: "${event.data.thought}"`, `analysis-${event.data.stage}`, event.data.mint);
      break;
    case 'SAFETY_CHECK':
      // Silent - ANALYSIS_THOUGHT handles the voiced commentary
      break;
    case 'SMART_MONEY_CHECK':
      // Silent - ANALYSIS_THOUGHT handles the voiced commentary
      break;
    case 'TRADE_DECISION':
      // Silent - ANALYSIS_THOUGHT handles the voiced commentary
      break;
    case 'TRADE_EXECUTED':
      const tradeEmoji = event.data.type === 'BUY' ? '💰' : '💸';
      addToFeed(`${tradeEmoji} ${event.data.type}: ${event.data.amount.toFixed(2)} SOL - ${formatMint(event.data.mint)}`, 'trade', event.data.mint);
      addToTradesTable(event.data);
      break;
    case 'BUYBACK_TRIGGERED':
      addToFeed(`🔄 BUYBACK: ${event.data.amount.toFixed(2)} SOL (profit: ${event.data.profit.toFixed(2)} SOL)`, 'buyback');
      if (event.data.reasoning) {
        addToFeed(`   └─ ${event.data.reasoning}`, 'buyback-detail');
      }
      buybackCount = (buybackCount || 0) + 1;
      updateBuybackCount();
      break;
    case 'BUYBACK_FAILED':
      addToFeed(`❌ BUYBACK FAILED: Attempted ${event.data.attemptedAmount.toFixed(4)} SOL - ${event.data.error}`, 'error');
      break;
    case 'FEE_CLAIMED':
      addToFeed(`💰 FEES CLAIMED: ${formatSignature(event.data.signature)}`, 'system');
      break;
    case 'REWARD_CLAIMED':
      addToFeed(`💎 REWARD CLAIMED: ${event.data.amountSol.toFixed(4)} SOL from ${event.data.source}`, 'reward');
      break;
    case 'REWARD_FAILED':
      addToFeed(`❌ REWARD FAILED: ${event.data.source} - ${event.data.error}`, 'error');
      break;
    case 'SCAN':
      // Token scan event with full context
      addToFeed(`📡 [SCAN] ${event.data.symbol} from ${event.data.source} - ${event.data.reasoning}`, 'scan', event.data.mint);
      break;
    case 'REJECT':
      // Token rejection with reason
      addToFeed(`❌ [REJECT] ${event.data.symbol}: ${event.data.rejectReason} (stage: ${event.data.stage})`, 'reject', event.data.mint);
      break;
    case 'MOOD_CHANGE':
      // Agent mood changed
      addToFeed(`🧠 MOOD: ${event.data.previous} → ${event.data.current} (${(event.data.intensity * 100).toFixed(0)}%)`, 'mood');
      updateMoodDisplay(event.data.current, event.data.intensity);
      break;
    case 'SIMULATE_ACK':
      // Simulation acknowledgment
      console.log('🧪 Simulation:', event.data.action, '-', event.data.message);
      addToFeed(`🧪 [TEST] ${event.data.message}`, 'test');
      break;
    case 'STATS_UPDATE':
      updateStats(event.data);
      break;
    case 'STOP_LOSS':
      addToFeed(`🛑 STOP-LOSS: ${formatMint(event.data.mint)} @ ${event.data.lossPercent.toFixed(1)}% loss`, 'stop-loss', event.data.mint);
      // Trigger Trench Radio crash sound
      if (window.trenchRadio) {
        window.trenchRadio.triggerCrash();
      }
      break;
    case 'TAKE_PROFIT':
      addToFeed(`🎯 TAKE-PROFIT: ${formatMint(event.data.mint)} @ +${event.data.profitPercent.toFixed(1)}% gain`, 'take-profit', event.data.mint);
      break;
    case 'SCHIZO_SPEAKS':
      // Voice only - no text in feed
      break;
    case 'SCHIZO_COMMENTARY':
      // Voice only - no text in feed
      break;
    case 'SCHIZO_LEARNING':
      // Voice only - no text in feed
      break;
    case 'CHAT_RECEIVED':
      const chatUser = event.data.username || 'anon';
      addToChat(`💬 @${chatUser}: ${event.data.message}`, 'user-message');
      break;
    case 'CHAT_RESPONSE':
      hideTypingIndicator();
      addToChat(`🤖 $SCHIZO: ${event.data.response}`, 'schizo-response');
      break;
    case 'CHAT_TYPING':
      if (event.data.typing) {
        showTypingIndicator();
      } else {
        hideTypingIndicator();
      }
      break;
    case 'VOICE_AUDIO':
      playVoiceAudio(event.data);
      break;
    case 'ANALYSIS_THOUGHT':
      // Only show tokens entering analysis (scanning stage)
      if (event.data.stage === 'scanning') {
        addToAnalysisStream(event.data);
      }
      break;
    case 'TOKEN_COMMENTARY':
      // Claude's random commentary on tokens (voice only, but show in stream)
      highlightTokenCommentary(event.data.mint, event.data.commentary);
      break;
    case 'SCHIZO_TOKEN_UPDATE':
      // Live $SCHIZO token data from backend
      updateSchizoTokenCard(event.data);
      break;
  }
}

// Current token being viewed
let currentToken = null;

// Add token to the analysis stream (tokens SCHIZO is considering)
function addToAnalysisStream(token) {
  if (isTokensPaused) return;

  currentToken = token;

  const container = document.getElementById('token-stream');
  if (!container) return;

  // Check if this token is already in the stream (by mint)
  const existingEl = document.getElementById(`token-${token.mint}`);
  if (existingEl) {
    // Update existing element with flash
    existingEl.classList.add('token-new');
    setTimeout(() => existingEl.classList.remove('token-new'), 2000);
    return;
  }

  const tokenEl = document.createElement('div');
  tokenEl.className = 'token-stream-item analyzing';
  tokenEl.id = `token-${token.mint}`;
  tokenEl.onclick = () => openChart(token.mint);

  const priceChangeClass = (token.priceChange5m || 0) >= 0 ? 'price-up' : 'price-down';
  const priceChangeSign = (token.priceChange5m || 0) >= 0 ? '+' : '';
  const mcapDisplay = token.marketCapSol ? token.marketCapSol.toFixed(1) + ' SOL' : '-';
  const liquidityDisplay = token.liquidity ? '$' + formatNumber(token.liquidity) : '-';

  tokenEl.innerHTML = `
    <div class="token-stream-left">
      <div class="token-stream-img-placeholder analyzing-pulse">👁️</div>
      <div class="token-stream-info">
        <span class="token-stream-symbol">${token.symbol || 'UNK'}</span>
        <span class="token-stream-name">${(token.name || 'Unknown').slice(0, 20)}</span>
        <span class="token-stream-ca clickable-ca" data-ca="${token.mint}" title="Click to copy CA">${formatMint(token.mint)}</span>
      </div>
    </div>
    <div class="token-stream-right">
      <span class="token-stream-price">${liquidityDisplay}</span>
      <span class="token-stream-mcap">${mcapDisplay}</span>
      <span class="token-stream-change ${priceChangeClass}">${priceChangeSign}${(token.priceChange5m || 0).toFixed(1)}%</span>
    </div>
    <div class="analysis-thought" title="SCHIZO's thought">${truncateThought(token.thought)}</div>
  `;

  // Add click handler for CA copy (stop propagation to not trigger chart open)
  const caElement = tokenEl.querySelector('.clickable-ca');
  if (caElement) {
    caElement.addEventListener('click', (e) => {
      e.stopPropagation();
      copyToClipboard(token.mint, caElement);
    });
  }

  // Add to top of stream
  container.insertBefore(tokenEl, container.firstChild);

  // Limit to 15 items (fewer since they have more content)
  while (container.children.length > 15) {
    container.removeChild(container.lastChild);
  }

  // Flash effect for new token
  tokenEl.classList.add('token-new');
  setTimeout(() => tokenEl.classList.remove('token-new'), 2000);
}

// Truncate long thoughts for display
function truncateThought(thought) {
  if (!thought) return '';
  return thought.length > 80 ? thought.slice(0, 77) + '...' : thought;
}

// Highlight token when Claude comments on it
function highlightTokenCommentary(mint, commentary) {
  const tokenEl = document.getElementById(`token-${mint}`);
  if (tokenEl) {
    tokenEl.classList.add('token-commented');

    // Add commentary bubble
    const bubble = document.createElement('div');
    bubble.className = 'token-commentary-bubble';
    bubble.textContent = commentary.slice(0, 100) + (commentary.length > 100 ? '...' : '');
    tokenEl.appendChild(bubble);

    // Remove after 8 seconds
    setTimeout(() => {
      tokenEl.classList.remove('token-commented');
      bubble.remove();
    }, 8000);
  }
}

// Format large numbers
function formatNumber(num) {
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
  if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
  return num.toFixed(0);
}

// Open chart popup
function openChart(mint, dexUrl) {
  const popup = document.getElementById('chart-popup');
  const iframe = document.getElementById('chart-iframe');

  // Use DexScreener embed
  iframe.src = `https://dexscreener.com/solana/${mint}?embed=1&theme=dark&trades=0&info=0`;
  popup.classList.add('visible');
}

// Close chart popup
function closeChart() {
  const popup = document.getElementById('chart-popup');
  const iframe = document.getElementById('chart-iframe');
  popup.classList.remove('visible');
  iframe.src = '';
}

// Audio queue to prevent overlapping speech
let audioQueue = [];
let isPlayingAudio = false;
let currentAudio = null;

// Play voice audio from base64 - queued to prevent overlap
function playVoiceAudio(data) {
  audioQueue.push(data);
  processAudioQueue();
}

function processAudioQueue() {
  if (isPlayingAudio || audioQueue.length === 0) return;

  isPlayingAudio = true;
  const data = audioQueue.shift();

  try {
    // Stop any currently playing audio
    if (currentAudio) {
      currentAudio.pause();
      currentAudio = null;
    }

    currentAudio = new Audio(`data:audio/mp3;base64,${data.audio}`);

    currentAudio.onended = () => {
      isPlayingAudio = false;
      currentAudio = null;
      // Small delay between speeches
      setTimeout(processAudioQueue, 300);
    };

    currentAudio.onerror = () => {
      console.error('Audio playback error');
      isPlayingAudio = false;
      currentAudio = null;
      processAudioQueue();
    };

    currentAudio.play().catch(err => {
      console.log('Audio autoplay blocked:', err);
      isPlayingAudio = false;
      currentAudio = null;
      processAudioQueue();
    });
  } catch (error) {
    console.error('Error playing audio:', error);
    isPlayingAudio = false;
    processAudioQueue();
  }
}

// Update dashboard stats
function updateStats(stats) {
  document.getElementById('winRate').textContent = stats.winRate.toFixed(1) + '%';
  
  // Calculate PnL breakdown
  const realizedPnL = stats.realizedPnL ?? 0;
  const unrealizedPnL = stats.unrealizedPnL ?? 0;
  const totalPnL = realizedPnL + unrealizedPnL;
  
  const pnlElement = document.getElementById('pnl');
  
  // Format PnL values with sign
  const formatPnL = (val) => (val >= 0 ? '+' : '') + val.toFixed(3);
  
  // Display breakdown: Compact vertical stack with grid
  // R: +0.000
  // U: +0.000
  // T: +0.000
  pnlElement.textContent = formatPnL(totalPnL) + (stats.balance !== undefined ? ' SOL' : '');
  pnlElement.className = totalPnL >= 0 ? 'positive' : 'negative';
  
  if (stats.totalBuybackSol && stats.totalBuybackSol > 0) {
    document.getElementById('buybacks').textContent = `${stats.totalBuybacks} (${stats.totalBuybackSol.toFixed(2)} SOL)`;
  } else {
    document.getElementById('buybacks').textContent = stats.totalBuybacks;
  }
  if (stats.balance !== undefined) {
    document.getElementById('balance').textContent = stats.balance.toFixed(4) + ' SOL';
  }
}

// Add event to feed
function addToFeed(message, className = '', mint = null) {
  if (isPaused) return;

  const feed = document.getElementById('feed');
  const div = document.createElement('div');
  div.className = `event ${className}`;

  const timestamp = new Date().toLocaleTimeString();

  // If mint provided, make it clickable
  if (mint) {
    const formattedMint = formatMint(mint);
    const clickableMint = `<span class="clickable-ca" data-ca="${mint}" title="Click to copy CA">${formattedMint}</span>`;
    message = message.replace(formattedMint, clickableMint);
  }

  div.innerHTML = `<span class="timestamp">[${timestamp}]</span>${message}`;

  // Add click handler for CA if present
  const caElement = div.querySelector('.clickable-ca');
  if (caElement) {
    caElement.addEventListener('click', (e) => {
      copyToClipboard(caElement.dataset.ca, caElement);
    });
  }

  feed.appendChild(div);

  // Auto-scroll to bottom
  feed.scrollTop = feed.scrollHeight;

  // Limit feed to 100 items
  while (feed.children.length > 100) {
    feed.removeChild(feed.firstChild);
  }
}

// Add message to chat box
function addToChat(message, className = '') {
  const chatBox = document.getElementById('chat-messages');
  const div = document.createElement('div');
  div.className = `chat-msg ${className}`;

  const timestamp = new Date().toLocaleTimeString();
  div.innerHTML = `<span class="timestamp">[${timestamp}]</span>${message}`;

  chatBox.appendChild(div);

  // Auto-scroll to bottom
  chatBox.scrollTop = chatBox.scrollHeight;

  // Limit chat to 50 items
  while (chatBox.children.length > 50) {
    chatBox.removeChild(chatBox.firstChild);
  }
}

// Typing indicator
function showTypingIndicator() {
  const chatBox = document.getElementById('chat-messages');

  // Don't add if already showing
  if (document.getElementById('typing-indicator')) return;

  const div = document.createElement('div');
  div.id = 'typing-indicator';
  div.className = 'chat-msg typing-indicator';
  div.innerHTML = `<span class="typing-dots">🤖 $SCHIZO is typing<span>.</span><span>.</span><span>.</span></span>`;

  chatBox.appendChild(div);
  chatBox.scrollTop = chatBox.scrollHeight;
}

function hideTypingIndicator() {
  const indicator = document.getElementById('typing-indicator');
  if (indicator) {
    indicator.remove();
  }
}

// Add trade to table
function addToTradesTable(trade) {
  const tbody = document.querySelector('#trades tbody');
  const row = document.createElement('tr');

  const time = new Date(trade.timestamp || Date.now()).toLocaleTimeString();
  const typeClass = trade.type === 'BUY' ? 'trade-buy' : 'trade-sell';
  const signature = formatSignature(trade.signature);

  row.innerHTML = `
    <td>${time}</td>
    <td class="${typeClass}">${trade.type}</td>
    <td><span class="clickable-ca" data-ca="${trade.mint}" title="Click to copy CA">${formatMint(trade.mint)}</span></td>
    <td>${trade.amount.toFixed(2)} SOL</td>
    <td><a href="https://solscan.io/tx/${trade.signature}" target="_blank">${signature}</a></td>
  `;

  // Add click handler for CA copy
  const caElement = row.querySelector('.clickable-ca');
  if (caElement) {
    caElement.addEventListener('click', (e) => {
      copyToClipboard(trade.mint, caElement);
    });
  }

  tbody.insertBefore(row, tbody.firstChild);

  // Limit table to 20 rows
  while (tbody.children.length > 20) {
    tbody.removeChild(tbody.lastChild);
  }
}

// Load initial trades from server (on connect/reconnect)
function loadInitialTrades(trades) {
  const tbody = document.querySelector('#trades tbody');

  // Clear existing trades
  tbody.innerHTML = '';

  // Add trades in reverse order (oldest first, so newest ends up at top)
  trades.slice().reverse().forEach(trade => {
    addToTradesTable(trade);
  });
}

// Update status indicator
function updateStatus(status, connected) {
  const statusEl = document.getElementById('status');
  statusEl.textContent = status;
  statusEl.className = connected ? 'status-connected' : 'status-disconnected';
}

// Update buyback count
function updateBuybackCount() {
  document.getElementById('buybacks').textContent = buybackCount;
}

// Format mint address
function formatMint(mint) {
  return mint.slice(0, 4) + '...' + mint.slice(-4);
}

// Format signature
function formatSignature(sig) {
  return sig.slice(0, 8) + '...';
}

// Copy to clipboard with visual feedback
function copyToClipboard(text, element) {
  navigator.clipboard.writeText(text).then(() => {
    // Show toast notification
    showCopyToast('CA Copied!');

    // Add visual feedback to clicked element
    if (element) {
      element.classList.add('copy-success');
      setTimeout(() => element.classList.remove('copy-success'), 1500);
    }
  }).catch(err => {
    console.error('Failed to copy:', err);
  });
}

// Show copy toast notification
function showCopyToast(message) {
  // Remove existing toast
  const existingToast = document.querySelector('.copy-toast');
  if (existingToast) existingToast.remove();

  const toast = document.createElement('div');
  toast.className = 'copy-toast';
  toast.textContent = message;
  document.body.appendChild(toast);

  // Trigger animation
  setTimeout(() => toast.classList.add('show'), 10);

  // Remove after animation
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, 1500);
}

// Pause/Resume feed
document.getElementById('pauseBtn').addEventListener('click', () => {
  isPaused = !isPaused;
  const btn = document.getElementById('pauseBtn');
  btn.textContent = isPaused ? 'Resume' : 'Pause';
});

// Pause/Resume tokens stream
document.getElementById('pauseTokensBtn')?.addEventListener('click', () => {
  isTokensPaused = !isTokensPaused;
  const btn = document.getElementById('pauseTokensBtn');
  btn.textContent = isTokensPaused ? 'Resume' : 'Pause';
});

// Chat functionality
const chatInput = document.getElementById('chatInput');
const sendBtn = document.getElementById('sendBtn');

function sendChatMessage() {
  const message = chatInput.value.trim();
  if (!message || ws.readyState !== WebSocket.OPEN) return;

  ws.send(JSON.stringify({
    type: 'CHAT',
    message: message,
    username: getUsername() // Use dynamic username
  }));

  chatInput.value = '';
}

sendBtn.addEventListener('click', sendChatMessage);

// Get username with fallback
function getUsername() {
  const input = document.getElementById('usernameInput');
  return input && input.value.trim() ? input.value.trim() : 'anon';
}

// Handle username changes
const usernameInput = document.getElementById('usernameInput');
if (usernameInput) {
  // Load saved username
  const savedName = localStorage.getItem('schizo_username');
  if (savedName) {
    usernameInput.value = savedName;
  }

  // Save on change
  usernameInput.addEventListener('change', () => {
    localStorage.setItem('schizo_username', usernameInput.value.trim());
  });
}

chatInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') {
    sendChatMessage();
  }
});

// Connect on page load
connect();

// Fetch $SCHIZO CA on page load
fetch('/api/schizo-ca')
  .then(res => res.json())
  .then(data => {
    if (data.ca) {
      updateSchizoTokenCard({ ca: data.ca, live: data.live });
    }
  })
  .catch(err => console.log('CA fetch failed:', err));

// $SCHIZO Token Card - Update function for when token goes live
function updateSchizoTokenCard(data) {
  if (data.price) {
    document.getElementById('schizo-price').textContent =
      data.price < 0.0001 ? '$' + data.price.toExponential(2) : '$' + data.price.toFixed(6);
  }
  if (data.marketCap) {
    document.getElementById('schizo-mcap').textContent = '$' + formatNumber(data.marketCap);
  }
  if (data.holders) {
    document.getElementById('schizo-holders').textContent = formatNumber(data.holders);
  }
  if (data.volume24h) {
    document.getElementById('schizo-volume').textContent = '$' + formatNumber(data.volume24h);
  }
  if (data.ca) {
    const caInput = document.getElementById('schizo-ca-input');
    if (caInput) {
      caInput.value = data.ca;
      caInput.onclick = () => {
        caInput.select();
        navigator.clipboard.writeText(data.ca);
        
        // Visual feedback
        const oldVal = caInput.value;
        const hint = document.querySelector('.copy-hint');
        if (hint) {
            const originalText = hint.textContent;
            hint.textContent = 'COPIED!';
            hint.style.color = '#4ade80';
            setTimeout(() => {
                hint.textContent = originalText;
                hint.style.color = '';
            }, 1500);
        }
      };
    }
    
    // Hide "Coming Soon" badge when CA is available
    const statusEl = document.querySelector('.token-card-status');
    if (statusEl) {
      statusEl.style.display = 'none';
    }
  }
  if (data.live) {
    const statusEl = document.querySelector('.token-card-status');
    if (statusEl) {
      statusEl.textContent = 'Live';
      statusEl.classList.add('live');
      statusEl.style.display = ''; // Show it again as "Live"
    }
    
    // Update button text/link if needed
    const buyBtn = document.querySelector('.btn-primary');
    if (buyBtn && data.dexUrl) {
        buyBtn.href = data.dexUrl;
        buyBtn.textContent = 'BUY NOW';
    }
  }
}

// Handle SCHIZO_TOKEN_UPDATE event from server (when token goes live)
// This will be emitted by the server when fetching data from DexScreener/PumpPortal

// ============================================
// TERMINAL LOGIC
// ============================================
const terminalMessages = [
    '> SEARCHING FOR ALPHA...',
    '> ERROR: TRUST NO ONE.',
    '> DETECTING JEETS...',
    '> SCANNING MEMPOOL...',
    '> ANALYZING WHALE MOVEMENTS...',
    '> SYSTEM INTEGRITY: COMPROMISED',
    '> THE BLOCKCHAIN IS WATCHING',
    '> ENCRYPTING THOUGHTS...',
    '> DECODING SMART MONEY...',
    '> PARANOIA LEVEL: CRITICAL',
    '> BUY SIGNALS DETECTED',
    '> IGNORING FUD...',
    '> EXECUTING STRATEGY 99...',
    '> CHECKING WALLET SECURITY...'
];

function initTerminal() {
    const terminal = document.getElementById('terminal-content');
    if (!terminal) return;

    function addLine(text) {
        const line = document.createElement('div');
        line.className = 'terminal-line';
        terminal.appendChild(line);
        
        let i = 0;
        const speed = 30 + Math.random() * 40;
        
        const interval = setInterval(() => {
            line.textContent += text.charAt(i);
            i++;
            if (i >= text.length) clearInterval(interval);
        }, speed);

        // Keep last 6 lines
        while (terminal.children.length > 6) {
            terminal.removeChild(terminal.firstChild);
        }
    }

    // Random interval
    function scheduleNext() {
        const delay = 1500 + Math.random() * 2500;
        setTimeout(() => {
            const msg = terminalMessages[Math.floor(Math.random() * terminalMessages.length)];
            addLine(msg);
            scheduleNext();
        }, delay);
    }
    
    scheduleNext();
}

// ============================================
// EYE TRACKING LOGIC
// ============================================
function initEyeTracking() {
    const logo = document.getElementById('hero-logo');
    if (!logo) return;

    document.addEventListener('mousemove', (e) => {
        const rect = logo.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;

        const deltaX = e.clientX - centerX;
        const deltaY = e.clientY - centerY;

        // Limit movement magnitude
        const moveX = Math.min(Math.max(deltaX / 25, -12), 12);
        const moveY = Math.min(Math.max(deltaY / 25, -12), 12);

        logo.style.transform = `translate(${moveX}px, ${moveY}px)`;
    });
}

// Initialize new features when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    initTerminal();
    initEyeTracking();
    initPanelTabs();
});

// ============================================
// PANEL TABS LOGIC
// ============================================
function initPanelTabs() {
    const tabs = document.querySelectorAll('.panel-tab');

    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const targetTab = tab.dataset.tab;

            // Update tab active states
            tabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');

            // Update content visibility
            const tokenStream = document.getElementById('token-stream');
            const holdingsStream = document.getElementById('holdings-stream');

            if (targetTab === 'analyzing') {
                tokenStream.classList.add('active');
                holdingsStream.classList.remove('active');
            } else if (targetTab === 'holdings') {
                tokenStream.classList.remove('active');
                holdingsStream.classList.add('active');
            }
        });
    });
}

// ============================================
// HOLDINGS DISPLAY LOGIC
// ============================================
let currentHoldings = [];

function updateHoldings(positions) {
    currentHoldings = positions;
    const container = document.getElementById('holdings-stream');
    const countEl = document.getElementById('holdings-count');

    if (!container) return;

    // Update count in tab
    if (countEl) {
        countEl.textContent = `(${positions.length})`;
    }

    // Clear container
    container.innerHTML = '';

    // Show empty state if no holdings
    if (positions.length === 0) {
        container.innerHTML = `
            <div class="holdings-empty">
                <div class="holdings-empty-icon">
                    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                        <rect x="2" y="7" width="20" height="14" rx="2" ry="2"></rect>
                        <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"></path>
                    </svg>
                </div>
                <div>No active holdings</div>
                <div style="font-size: 0.85em; opacity: 0.7;">Positions will appear here when trades are executed</div>
            </div>
        `;
        return;
    }

    // Render each holding
    positions.forEach(pos => {
        const holdingEl = document.createElement('div');
        holdingEl.className = 'holding-item';
        holdingEl.onclick = () => openChart(pos.tokenMint);

        // Use actual symbol if available, fallback to truncated mint
        const symbol = pos.tokenSymbol || pos.tokenMint.slice(0, 6);
        // Use name if available, otherwise show CA
        const name = pos.tokenName || formatMint(pos.tokenMint);
        const pnlPercent = pos.unrealizedPnLPercent || 0;
        const pnlClass = pnlPercent >= 0 ? 'profit' : 'loss';
        const pnlSign = pnlPercent >= 0 ? '+' : '';
        const entryAge = getTimeAgo(pos.entryTimestamp);

        // Show actual token image if available, otherwise fallback to $ icon
        const imageHtml = pos.tokenImage
            ? `<img src="${pos.tokenImage}" alt="${symbol}" class="holding-token-img" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
               <div class="holding-icon-fallback" style="display:none;">$</div>`
            : `<div class="holding-icon-fallback">$</div>`;

        holdingEl.innerHTML = `
            <div class="holding-left">
                <div class="holding-icon">${imageHtml}</div>
                <div class="holding-info">
                    <span class="holding-symbol">${symbol}</span>
                    <span class="holding-name">${name}</span>
                    <span class="holding-ca clickable-ca" data-ca="${pos.tokenMint}" title="Click to copy CA">${formatMint(pos.tokenMint)}</span>
                </div>
            </div>
            <div class="holding-right">
                <span class="holding-value">${pos.entryAmountSol.toFixed(3)} SOL</span>
                <span class="holding-pnl ${pnlClass}">${pnlSign}${pnlPercent.toFixed(1)}%</span>
                <span class="holding-entry">Entry: ${entryAge}</span>
            </div>
        `;

        // Add click handler for CA copy
        const caElement = holdingEl.querySelector('.clickable-ca');
        if (caElement) {
            caElement.addEventListener('click', (e) => {
                e.stopPropagation();
                copyToClipboard(pos.tokenMint, caElement);
            });
        }

        container.appendChild(holdingEl);
    });
}

// Helper to get time ago string
function getTimeAgo(timestamp) {
    const now = Date.now();
    const diff = now - timestamp;

    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (days > 0) return `${days}d ago`;
    if (hours > 0) return `${hours}h ago`;
    if (minutes > 0) return `${minutes}m ago`;
    return 'Just now';
}

// ============================================
// TRENCH RADIO INTEGRATION
// ============================================

/**
 * Update Trench Radio state based on positions
 */
function updateTrenchRadioFromPositions(positions) {
    if (!window.trenchRadio) return;

    // Check if we have any active positions
    const hasPositions = positions && positions.length > 0;

    if (!hasPositions) {
        window.trenchRadio.updatePositionPnL(0, false);
        window.trenchRadio.setState('SCANNING');
        updateTrenchRadioUI('SCANNING');
        return;
    }

    // Calculate aggregate PnL across all positions
    let totalPnL = 0;
    let totalWeight = 0;

    positions.forEach(pos => {
        if (pos.unrealizedPnLPercent !== undefined) {
            const weight = pos.entryAmountSol || 1;
            totalPnL += pos.unrealizedPnLPercent * weight;
            totalWeight += weight;
        }
    });

    const avgPnL = totalWeight > 0 ? totalPnL / totalWeight : 0;

    // Link trench radio state to audio
    if (window.trenchRadio) {
        window.trenchRadio.updatePositionPnL(avgPnL, true);
        
        let newState = 'SCANNING';
        if (avgPnL >= 0) newState = 'POSITION_UP';
        else newState = 'POSITION_DOWN';
        
        window.trenchRadio.setState(newState);
        updateTrenchRadioUI(newState);
    }
}

/**
 * Update Trench Radio UI state indicator
 */
function updateTrenchRadioUI(state) {
    const stateEl = document.getElementById('trench-radio-state');
    if (!stateEl) return;

    // Remove all state classes
    stateEl.classList.remove('scanning', 'position-up', 'position-down', 'crash');

    // Update text and class based on state
    switch (state) {
        case 'SCANNING':
            stateEl.textContent = 'SCANNING';
            stateEl.classList.add('scanning');
            break;
        case 'POSITION_UP':
            stateEl.textContent = 'PUMPING';
            stateEl.classList.add('position-up');
            break;
        case 'POSITION_DOWN':
            stateEl.textContent = 'DUMPING';
            stateEl.classList.add('position-down');
            break;
        case 'CRASH':
            stateEl.textContent = 'REKT';
            stateEl.classList.add('crash');
            break;
        default:
            stateEl.textContent = 'OFF';
    }
}

// initTrenchRadio removed to avoid conflict with trench-radio.js logic

// ============================================
// MOOD DISPLAY
// ============================================

/**
 * Update the mood indicator display
 */
function updateMoodDisplay(mood, intensity) {
    const moodEl = document.getElementById('agent-mood');
    if (!moodEl) return;

    // Mood colors
    const moodColors = {
        'CONFIDENT': '#22c55e',
        'PARANOID': '#ef4444',
        'MANIC': '#f59e0b',
        'DEPRESSED': '#6b7280',
        'EUPHORIC': '#8b5cf6',
        'ANXIOUS': '#f97316',
    };

    const color = moodColors[mood] || '#94a3b8';

    moodEl.textContent = mood;
    moodEl.style.color = color;
    moodEl.style.textShadow = `0 0 ${intensity * 10}px ${color}`;
}

// ============================================
// SIMULATION HELPERS (for testing without real SOL)
// ============================================

/**
 * Send simulation request to server
 * Usage in browser console:
 *   simulateEvent('scan')
 *   simulateEvent('buy')
 *   simulateEvent('sell', { isProfit: true })
 *   simulateEvent('mood', { mood: 'PARANOID' })
 */
function simulateEvent(action, params = {}) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        console.error('WebSocket not connected');
        return;
    }

    ws.send(JSON.stringify({
        type: 'SIMULATE',
        action: action,
        params: params
    }));

    console.log(`🧪 Simulation request sent: ${action}`, params);
}

// Expose for console usage
window.simulateEvent = simulateEvent;

// Quick simulation shortcuts
window.simScan = () => simulateEvent('scan');
window.simReject = () => simulateEvent('reject');
window.simBuy = () => simulateEvent('buy');
window.simTakeProfit = () => simulateEvent('sell', { isProfit: true });
window.simStopLoss = () => simulateEvent('sell', { isProfit: false });
window.simBuyback = () => simulateEvent('buyback');
window.simMood = (mood) => simulateEvent('mood', { mood: mood || 'PARANOID' });
window.simReward = () => simulateEvent('reward');
window.simRewardFail = () => simulateEvent('reward', { success: false });

console.log('🧪 Simulation helpers loaded. Use these in console:');
console.log('   simScan() - Simulate token scan');
console.log('   simReject() - Simulate token rejection');
console.log('   simBuy() - Simulate buy trade');
console.log('   simTakeProfit() - Simulate take-profit exit');
console.log('   simStopLoss() - Simulate stop-loss exit');
console.log('   simBuyback() - Simulate buyback');
console.log('   simMood("PARANOID") - Simulate mood change');
console.log('   simReward() - Simulate reward claim');
console.log('   simRewardFail() - Simulate reward failure');

