/**
 * Trench Radio - Dynamic Audio Environment
 *
 * Audio states based on trading activity:
 * - SCANNING: Low-fi ambient (Synthesis)
 * - POSITION_UP: High-energy Phonk Playlist
 * - POSITION_DOWN: Sad/Slow Playlist
 * - CRASH: Dial-up sound (Synthesis)
 */

class TrenchRadio {
  constructor() {
    this.audioContext = null;
    this.masterGain = null;
    this.currentState = 'SCANNING';
    this.isEnabled = false;
    this.volume = 0.5;

    // Audio nodes for effects (Synthesis)
    this.lowPassFilter = null;
    this.highPassFilter = null;
    this.distortion = null;
    this.convolver = null;
    this.compressor = null;
    this.oscillators = [];
    this.noiseNode = null;

    // State tracking
    this.positionPnL = 0;
    this.hasActivePosition = false;
    this.crashTimeout = null;
    this.isAudioPlaying = false;
    
    // File Playback
    this.audioElement = new Audio();
    this.audioElement.loop = false;
    this.audioElement.volume = this.volume;
    this.currentSource = 'SYNTH'; // 'SYNTH' or 'FILE'

    this.playlists = {
        'POSITION_UP': [
            'audio/pumping_1.mp3',
            'audio/pumping_2.mp3', 
            'audio/pumping_3.mp3'
        ],
        'POSITION_DOWN': [
            'audio/dumping_1.mp3',
            'audio/dumping_2.mp3',
            'audio/dumping_3.mp3'
        ]
    };
    this.currentPlaylistIndex = 0;

    this.audioElement.addEventListener('ended', () => {
        this.playNextInPlaylist();
    });
  }

  async init() {
    if (this.audioContext) return;

    try {
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();

      // Create master gain
      this.masterGain = this.audioContext.createGain();
      this.masterGain.gain.value = this.volume;
      this.masterGain.connect(this.audioContext.destination);

      // Create compressor
      this.compressor = this.audioContext.createDynamicsCompressor();
      this.compressor.connect(this.masterGain);

      // Create filters
      this.lowPassFilter = this.audioContext.createBiquadFilter();
      this.lowPassFilter.type = 'lowpass';
      this.lowPassFilter.connect(this.compressor);

      this.highPassFilter = this.audioContext.createBiquadFilter();
      this.highPassFilter.type = 'highpass';
      this.highPassFilter.connect(this.lowPassFilter);

      // Create distortion
      this.distortion = this.audioContext.createWaveShaper();
      this.distortion.curve = this.makeDistortionCurve(0);
      this.distortion.connect(this.highPassFilter);

      // Create convolver
      this.convolver = this.audioContext.createConvolver();
      this.convolver.buffer = await this.createReverbImpulse(2, 2);

      // Effect mix
      this.reverbGain = this.audioContext.createGain();
      this.reverbGain.gain.value = 0;
      this.convolver.connect(this.reverbGain);
      this.reverbGain.connect(this.lowPassFilter);

      this.dryGain = this.audioContext.createGain();
      this.dryGain.gain.value = 1;
      this.dryGain.connect(this.distortion);

      console.log('Trench Radio initialized');

      if (this.isEnabled) {
        this.setState(this.currentState);
      }
    } catch (error) {
      console.error('Failed to initialize Trench Radio:', error);
    }
  }

  makeDistortionCurve(amount) {
    const k = typeof amount === 'number' ? amount : 50;
    const n_samples = 44100;
    const curve = new Float32Array(n_samples);
    const deg = Math.PI / 180;
    for (let i = 0; i < n_samples; i++) {
      const x = (i * 2) / n_samples - 1;
      curve[i] = ((3 + k) * x * 20 * deg) / (Math.PI + k * Math.abs(x));
    }
    return curve;
  }

  async createReverbImpulse(duration, decay) {
    const sampleRate = this.audioContext.sampleRate;
    const length = sampleRate * duration;
    const impulse = this.audioContext.createBuffer(2, length, sampleRate);
    for (let channel = 0; channel < 2; channel++) {
      const channelData = impulse.getChannelData(channel);
      for (let i = 0; i < length; i++) {
        channelData[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
      }
    }
    return impulse;
  }

  async toggle() {
    this.isEnabled = !this.isEnabled;
    
    if (this.isEnabled) {
      // Ensure AudioContext is ready and running
      if (!this.audioContext) {
        await this.init();
      }
      
      if (this.audioContext && this.audioContext.state === 'suspended') {
        await this.audioContext.resume();
      }

      this.setState(this.currentState);

      // Try to play if file source is active
      if (this.currentSource === 'FILE' && this.audioElement.paused) {
          this.audioElement.play().catch(e => console.error('Play failed', e));
      }
    } else {
      this.stopAllAudio();
    }
    return this.isEnabled;
  }

  setVolume(vol) {
    this.volume = Math.max(0, Math.min(1, vol));
    if (this.masterGain) {
      this.masterGain.gain.setTargetAtTime(this.volume, this.audioContext.currentTime || 0, 0.1);
    }
    if (this.audioElement) {
        this.audioElement.volume = this.volume;
    }
  }

  stopAllAudio() {
    // Stop Synthesis
    this.oscillators.forEach(osc => {
      try { osc.stop(); } catch (e) {}
    });
    this.oscillators = [];
    if (this.noiseNode) {
      try { this.noiseNode.stop(); } catch (e) {}
      this.noiseNode = null;
    }

    // Stop File
    if (this.audioElement) {
        this.audioElement.pause();
    }

    this.isAudioPlaying = false;
  }

  setState(state) {
    // Only skip if state is the same AND audio is already playing
    if (this.currentState === state && this.isAudioPlaying) return;

    const prevState = this.currentState;
    this.currentState = state;
    console.log(`Trench Radio: ${prevState} -> ${state}`);

    if (this.crashTimeout) {
      clearTimeout(this.crashTimeout);
      this.crashTimeout = null;
    }

    if (!this.isEnabled) {
      this.isAudioPlaying = false;
      return;
    }

    this.stopAllAudio();
    this.isAudioPlaying = true;

    switch (state) {
      case 'SCANNING':
        this.currentSource = 'SYNTH';
        this.playScanningAmbient();
        break;
      case 'POSITION_UP':
        this.currentSource = 'FILE';
        this.currentPlaylistIndex = 0; // Reset to start of playlist
        this.playPlaylist(state);
        break;
      case 'POSITION_DOWN':
        this.currentSource = 'FILE';
        this.currentPlaylistIndex = 0;
        this.playPlaylist(state);
        break;
      case 'CRASH':
        this.currentSource = 'SYNTH';
        this.playCrash();
        break;
    }
  }
  
  // --- PLAYLIST LOGIC ---
  
  playPlaylist(state) {
      const playlist = this.playlists[state];
      if (!playlist || playlist.length === 0) return;
      
      const file = playlist[this.currentPlaylistIndex];
      this.audioElement.src = file;
      this.audioElement.play().catch(err => {
          console.warn('Playback failed:', err);
          // Fallback to next track if file missing?
      });
  }
  
  playNextInPlaylist() {
      if (this.currentSource !== 'FILE') return;
      const playlist = this.playlists[this.currentState];
      if (!playlist) return;
      
      this.currentPlaylistIndex = (this.currentPlaylistIndex + 1) % playlist.length;
      this.playPlaylist(this.currentState);
  }

  // --- SYNTHESIS METHODS ---

  playScanningAmbient() {
    if (!this.audioContext) return;
    // Simple Lofi Synth setup
    this.lowPassFilter.frequency.setTargetAtTime(2500, this.audioContext.currentTime, 0.5);
    this.reverbGain.gain.setTargetAtTime(0.25, this.audioContext.currentTime, 0.5);
    
    this.noiseNode = this.createVinylCrackle();
    
    // Start procedural beat
    this.playLofiBeat(75);
    this.playLofiChords(75);
  }

  createVinylCrackle() {
      // Simplified crackle
      const bufferSize = 2 * this.audioContext.sampleRate;
      const noiseBuffer = this.audioContext.createBuffer(1, bufferSize, this.audioContext.sampleRate);
      const output = noiseBuffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) {
          output[i] = (Math.random() * 2 - 1) * 0.02;
          if (Math.random() < 0.0003) output[i] = (Math.random() * 2 - 1) * 0.3;
      }
      const noise = this.audioContext.createBufferSource();
      noise.buffer = noiseBuffer;
      noise.loop = true;
      const vinylGain = this.audioContext.createGain();
      vinylGain.gain.value = 0.15;
      noise.connect(vinylGain);
      vinylGain.connect(this.dryGain);
      noise.start();
      return noise;
  }
  
  playLofiBeat(bpm) {
      // Recursive beat scheduler
      const beatLength = 60 / bpm;
      let beat = 0;
      const playBeat = () => {
          if (this.currentState !== 'SCANNING' || !this.isEnabled) return;
          const time = this.audioContext.currentTime;
          
          if (beat % 4 === 0 || beat % 4 === 2.5) this.playLofiKick(time);
          if (beat % 4 === 1 || beat % 4 === 3) this.playLofiSnare(time + Math.random()*0.02);
          this.playLofiHat(time, beat % 2 === 1 ? 0.06 : 0.03);
          
          beat = (beat + 0.5) % 8;
          setTimeout(playBeat, (beatLength / 2) * 1000);
      };
      playBeat();
  }
  
  playLofiKick(time) {
      const osc = this.audioContext.createOscillator();
      const gain = this.audioContext.createGain();
      osc.frequency.setValueAtTime(100, time);
      osc.frequency.exponentialRampToValueAtTime(40, time + 0.15);
      gain.gain.setValueAtTime(0.4, time);
      gain.gain.exponentialRampToValueAtTime(0.001, time + 0.25);
      const filter = this.audioContext.createBiquadFilter();
      filter.type = 'lowpass'; filter.frequency.value = 200;
      osc.connect(filter); filter.connect(gain); gain.connect(this.dryGain);
      osc.start(time); osc.stop(time + 0.25);
  }
  
  playLofiSnare(time) {
      // Noise burst
      const bufSize = this.audioContext.sampleRate * 0.15;
      const buf = this.audioContext.createBuffer(1, bufSize, this.audioContext.sampleRate);
      const data = buf.getChannelData(0);
      for(let i=0; i<bufSize; i++) data[i] = Math.random()*2-1;
      const noise = this.audioContext.createBufferSource();
      noise.buffer = buf;
      const filter = this.audioContext.createBiquadFilter();
      filter.type = 'bandpass'; filter.frequency.value = 1200;
      const gain = this.audioContext.createGain();
      gain.gain.setValueAtTime(0.12, time);
      gain.gain.exponentialRampToValueAtTime(0.001, time + 0.12);
      noise.connect(filter); filter.connect(gain); gain.connect(this.dryGain); gain.connect(this.convolver);
      noise.start(time);
  }
  
  playLofiHat(time, vol) {
      const bufSize = this.audioContext.sampleRate * 0.05;
      const buf = this.audioContext.createBuffer(1, bufSize, this.audioContext.sampleRate);
      const data = buf.getChannelData(0);
      for(let i=0; i<bufSize; i++) data[i] = Math.random()*2-1;
      const noise = this.audioContext.createBufferSource();
      noise.buffer = buf;
      const filter = this.audioContext.createBiquadFilter();
      filter.type = 'highpass'; filter.frequency.value = 6000;
      const gain = this.audioContext.createGain();
      gain.gain.setValueAtTime(vol, time);
      gain.gain.exponentialRampToValueAtTime(0.001, time + 0.04);
      noise.connect(filter); filter.connect(gain); gain.connect(this.dryGain);
      noise.start(time);
  }
  
  playLofiChords(bpm) {
      const bar = (60/bpm)*4;
      const chords = [
          [146.83, 174.61, 220, 261.63],
          [196, 246.94, 293.66, 349.23],
          [130.81, 164.81, 196, 246.94],
          [220, 261.63, 329.63, 392]
      ];
      let idx = 0;
      const play = () => {
          if (this.currentState !== 'SCANNING' || !this.isEnabled) return;
          const time = this.audioContext.currentTime;
          chords[idx].forEach((freq, i) => this.playLofiNote(freq, time + i*0.03, bar*0.9));
          idx = (idx+1)%chords.length;
          setTimeout(play, bar*1000);
      };
      setTimeout(play, (60/bpm)*1000);
  }
  
  playLofiNote(freq, time, dur) {
      const osc = this.audioContext.createOscillator(); osc.type = 'triangle'; osc.frequency.value = freq;
      const osc2 = this.audioContext.createOscillator(); osc2.type = 'triangle'; osc2.frequency.value = freq*1.002;
      const gain = this.audioContext.createGain();
      gain.gain.setValueAtTime(0, time);
      gain.gain.linearRampToValueAtTime(0.08, time+0.05);
      gain.gain.exponentialRampToValueAtTime(0.001, time+dur);
      const filter = this.audioContext.createBiquadFilter();
      filter.type = 'lowpass'; filter.frequency.value = 1500;
      osc.connect(filter); osc2.connect(filter); filter.connect(gain);
      gain.connect(this.dryGain); gain.connect(this.convolver);
      osc.start(time); osc.stop(time+dur); osc2.start(time); osc2.stop(time+dur);
  }

  playCrash() {
    if (!this.audioContext) return;
    // Dial-up logic
    const time = this.audioContext.currentTime;
    const carrier = this.audioContext.createOscillator();
    carrier.type = 'sine'; carrier.frequency.value = 1070;
    const mod = this.audioContext.createOscillator();
    mod.type = 'sine'; mod.frequency.value = 400;
    const modGain = this.audioContext.createGain();
    modGain.gain.value = 500;
    mod.connect(modGain); modGain.connect(carrier.frequency);
    const mainGain = this.audioContext.createGain();
    mainGain.gain.setValueAtTime(0.3, time);
    carrier.connect(mainGain); mainGain.connect(this.masterGain);
    carrier.start(time); mod.start(time);
    carrier.stop(time+3); mod.stop(time+3);
    this.oscillators.push(carrier, mod);
    
    this.crashTimeout = setTimeout(() => {
        this.stopAllAudio();
        this.crashTimeout = setTimeout(() => {
            if (this.isEnabled && this.currentState === 'CRASH') this.setState('SCANNING');
        }, 5000);
    }, 3000);
  }
  
  updatePositionPnL(pnl, hasPosition) {
    this.positionPnL = pnl;
    this.hasActivePosition = hasPosition;
  }
  
  initTrenchRadio() {
      const toggleBtn = document.getElementById('trench-radio-toggle');
      const volumeSlider = document.getElementById('trench-radio-volume');
      const stateEl = document.getElementById('trench-radio-state');
      const panel = document.getElementById('trench-radio-controls');
      const iconOff = document.getElementById('radio-icon-off');
      const iconOn = document.getElementById('radio-icon-on');

      if (!toggleBtn || !volumeSlider) return;

      toggleBtn.addEventListener('click', async () => {
          const isEnabled = await this.toggle();
          toggleBtn.classList.toggle('active', isEnabled);
          panel.classList.toggle('active', isEnabled);
          iconOff.style.display = isEnabled ? 'none' : 'block';
          iconOn.style.display = isEnabled ? 'block' : 'none';

          if (isEnabled) {
              stateEl.textContent = this.currentState;
              stateEl.classList.add('scanning');
          } else {
              stateEl.textContent = 'OFF';
              stateEl.classList.remove('scanning', 'position-up', 'position-down', 'crash');
          }
      });

      volumeSlider.addEventListener('input', (e) => {
          this.setVolume(parseInt(e.target.value) / 100);
      });
      this.setVolume(parseInt(volumeSlider.value) / 100);
  }
}

document.addEventListener('DOMContentLoaded', () => {
    window.trenchRadio = new TrenchRadio();
    window.trenchRadio.initTrenchRadio();
});
