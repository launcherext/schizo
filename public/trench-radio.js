/**
 * Trench Radio - Dynamic Audio Environment
 *
 * Audio states based on trading activity:
 * - SCANNING: Low-fi ambient, radar/sonar vibes
 * - POSITION_UP: High-energy phonk/hardstyle, bass boost
 * - POSITION_DOWN: Distorted, slowed (chopped & screwed), reverb
 * - CRASH: Dial-up sound then silence
 */

class TrenchRadio {
  constructor() {
    this.audioContext = null;
    this.masterGain = null;
    this.currentState = 'SCANNING';
    this.isEnabled = false;
    this.volume = 0.5;

    // Audio nodes for effects
    this.lowPassFilter = null;
    this.highPassFilter = null;
    this.distortion = null;
    this.convolver = null; // For reverb
    this.compressor = null;

    // Audio sources
    this.currentSource = null;
    this.audioBuffers = {};

    // Oscillators for procedural audio
    this.oscillators = [];
    this.noiseNode = null;

    // State tracking
    this.positionPnL = 0;
    this.hasActivePosition = false;
    this.crashTimeout = null;
  }

  /**
   * Initialize the audio context (must be called after user interaction)
   */
  async init() {
    if (this.audioContext) return;

    try {
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();

      // Create master gain
      this.masterGain = this.audioContext.createGain();
      this.masterGain.gain.value = this.volume;
      this.masterGain.connect(this.audioContext.destination);

      // Create compressor for overall dynamics
      this.compressor = this.audioContext.createDynamicsCompressor();
      this.compressor.threshold.value = -24;
      this.compressor.knee.value = 30;
      this.compressor.ratio.value = 12;
      this.compressor.attack.value = 0.003;
      this.compressor.release.value = 0.25;
      this.compressor.connect(this.masterGain);

      // Create filters
      this.lowPassFilter = this.audioContext.createBiquadFilter();
      this.lowPassFilter.type = 'lowpass';
      this.lowPassFilter.frequency.value = 20000;
      this.lowPassFilter.Q.value = 1;
      this.lowPassFilter.connect(this.compressor);

      this.highPassFilter = this.audioContext.createBiquadFilter();
      this.highPassFilter.type = 'highpass';
      this.highPassFilter.frequency.value = 20;
      this.highPassFilter.Q.value = 1;
      this.highPassFilter.connect(this.lowPassFilter);

      // Create distortion
      this.distortion = this.audioContext.createWaveShaper();
      this.distortion.curve = this.makeDistortionCurve(0);
      this.distortion.oversample = '4x';
      this.distortion.connect(this.highPassFilter);

      // Create convolver for reverb
      this.convolver = this.audioContext.createConvolver();
      this.convolver.buffer = await this.createReverbImpulse(2, 2);

      // Dry/wet mix for reverb
      this.reverbGain = this.audioContext.createGain();
      this.reverbGain.gain.value = 0;
      this.convolver.connect(this.reverbGain);
      this.reverbGain.connect(this.lowPassFilter);

      // Dry signal
      this.dryGain = this.audioContext.createGain();
      this.dryGain.gain.value = 1;
      this.dryGain.connect(this.distortion);

      console.log('Trench Radio initialized');

      // Start with scanning state
      if (this.isEnabled) {
        this.setState('SCANNING');
      }
    } catch (error) {
      console.error('Failed to initialize Trench Radio:', error);
    }
  }

  /**
   * Create distortion curve
   */
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

  /**
   * Create reverb impulse response
   */
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

  /**
   * Enable/disable the radio
   */
  toggle() {
    this.isEnabled = !this.isEnabled;

    if (this.isEnabled) {
      this.init().then(() => {
        this.setState(this.currentState);
      });
    } else {
      this.stopAllAudio();
    }

    return this.isEnabled;
  }

  /**
   * Set volume (0-1)
   */
  setVolume(vol) {
    this.volume = Math.max(0, Math.min(1, vol));
    if (this.masterGain) {
      this.masterGain.gain.setTargetAtTime(this.volume, this.audioContext.currentTime, 0.1);
    }
  }

  /**
   * Stop all audio
   */
  stopAllAudio() {
    this.oscillators.forEach(osc => {
      try { osc.stop(); } catch (e) {}
    });
    this.oscillators = [];

    if (this.noiseNode) {
      try { this.noiseNode.stop(); } catch (e) {}
      this.noiseNode = null;
    }
  }

  /**
   * Set the current state and adjust audio accordingly
   */
  setState(state) {
    if (!this.isEnabled || !this.audioContext) return;

    const prevState = this.currentState;
    this.currentState = state;

    console.log(`Trench Radio: ${prevState} -> ${state}`);

    // Clear any crash timeout
    if (this.crashTimeout) {
      clearTimeout(this.crashTimeout);
      this.crashTimeout = null;
    }

    // Stop current audio
    this.stopAllAudio();

    switch (state) {
      case 'SCANNING':
        this.playScanningAmbient();
        break;
      case 'POSITION_UP':
        this.playPositionUp();
        break;
      case 'POSITION_DOWN':
        this.playPositionDown();
        break;
      case 'CRASH':
        this.playCrash();
        break;
    }
  }

  /**
   * State 1: "The Hunt" - Lofi hip-hop chill beats
   */
  playScanningAmbient() {
    if (!this.audioContext) return;

    // Lofi sound: warm, filtered, with vinyl crackle
    this.lowPassFilter.frequency.setTargetAtTime(2500, this.audioContext.currentTime, 0.5);
    this.distortion.curve = this.makeDistortionCurve(5); // Slight warmth
    this.reverbGain.gain.setTargetAtTime(0.25, this.audioContext.currentTime, 0.5);

    // Vinyl crackle (filtered noise)
    this.noiseNode = this.createVinylCrackle();

    // Start lofi beat
    this.playLofiBeat(75); // 75 BPM - chill tempo

    // Play lofi chords
    this.playLofiChords(75);
  }

  /**
   * Create vinyl crackle effect
   */
  createVinylCrackle() {
    const bufferSize = 2 * this.audioContext.sampleRate;
    const noiseBuffer = this.audioContext.createBuffer(1, bufferSize, this.audioContext.sampleRate);
    const output = noiseBuffer.getChannelData(0);

    // Create crackle pattern - mostly silent with occasional pops
    for (let i = 0; i < bufferSize; i++) {
      // Base vinyl hiss
      output[i] = (Math.random() * 2 - 1) * 0.02;

      // Random crackles/pops
      if (Math.random() < 0.0003) {
        output[i] = (Math.random() * 2 - 1) * 0.3;
      }
    }

    const noise = this.audioContext.createBufferSource();
    noise.buffer = noiseBuffer;
    noise.loop = true;

    // Bandpass filter for that vinyl character
    const vinylFilter = this.audioContext.createBiquadFilter();
    vinylFilter.type = 'bandpass';
    vinylFilter.frequency.value = 1500;
    vinylFilter.Q.value = 0.5;

    const vinylGain = this.audioContext.createGain();
    vinylGain.gain.value = 0.15;

    noise.connect(vinylFilter);
    vinylFilter.connect(vinylGain);
    vinylGain.connect(this.dryGain);
    noise.start();

    return noise;
  }

  /**
   * Play lofi boom-bap beat
   */
  playLofiBeat(bpm) {
    const beatLength = 60 / bpm;
    let beat = 0;

    const playBeat = () => {
      if (this.currentState !== 'SCANNING' || !this.isEnabled) return;

      const time = this.audioContext.currentTime;

      // Lofi kick - soft and warm
      if (beat % 4 === 0 || beat % 4 === 2.5) {
        this.playLofiKick(time);
      }

      // Lofi snare on 2 and 4 (with swing)
      if (beat % 4 === 1 || beat % 4 === 3) {
        this.playLofiSnare(time + (Math.random() * 0.02)); // Slight timing humanization
      }

      // Soft hi-hat with swing
      this.playLofiHat(time, beat % 2 === 1 ? 0.06 : 0.03);

      beat = (beat + 0.5) % 8; // Half-beat increments for swing
      setTimeout(playBeat, (beatLength / 2) * 1000);
    };

    playBeat();
  }

  /**
   * Soft lofi kick
   */
  playLofiKick(time) {
    const osc = this.audioContext.createOscillator();
    const gain = this.audioContext.createGain();

    osc.frequency.setValueAtTime(100, time);
    osc.frequency.exponentialRampToValueAtTime(40, time + 0.15);

    gain.gain.setValueAtTime(0.4, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.25);

    // Low pass for warmth
    const kickFilter = this.audioContext.createBiquadFilter();
    kickFilter.type = 'lowpass';
    kickFilter.frequency.value = 200;

    osc.connect(kickFilter);
    kickFilter.connect(gain);
    gain.connect(this.dryGain);

    osc.start(time);
    osc.stop(time + 0.25);
  }

  /**
   * Soft lofi snare (more like a rim shot)
   */
  playLofiSnare(time) {
    // Noise burst for snare
    const bufferSize = this.audioContext.sampleRate * 0.15;
    const buffer = this.audioContext.createBuffer(1, bufferSize, this.audioContext.sampleRate);
    const data = buffer.getChannelData(0);

    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }

    const noise = this.audioContext.createBufferSource();
    noise.buffer = buffer;

    // Bandpass for that lofi snare character
    const snareFilter = this.audioContext.createBiquadFilter();
    snareFilter.type = 'bandpass';
    snareFilter.frequency.value = 1200;
    snareFilter.Q.value = 1;

    const gain = this.audioContext.createGain();
    gain.gain.setValueAtTime(0.12, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.12);

    noise.connect(snareFilter);
    snareFilter.connect(gain);
    gain.connect(this.dryGain);
    gain.connect(this.convolver); // Add reverb to snare

    noise.start(time);
  }

  /**
   * Soft lofi hi-hat
   */
  playLofiHat(time, volume) {
    const bufferSize = this.audioContext.sampleRate * 0.05;
    const buffer = this.audioContext.createBuffer(1, bufferSize, this.audioContext.sampleRate);
    const data = buffer.getChannelData(0);

    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }

    const noise = this.audioContext.createBufferSource();
    noise.buffer = buffer;

    const hatFilter = this.audioContext.createBiquadFilter();
    hatFilter.type = 'highpass';
    hatFilter.frequency.value = 6000;

    // Low pass to take off harsh highs (lofi character)
    const lofiFilter = this.audioContext.createBiquadFilter();
    lofiFilter.type = 'lowpass';
    lofiFilter.frequency.value = 8000;

    const gain = this.audioContext.createGain();
    gain.gain.setValueAtTime(volume, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.04);

    noise.connect(hatFilter);
    hatFilter.connect(lofiFilter);
    lofiFilter.connect(gain);
    gain.connect(this.dryGain);

    noise.start(time);
  }

  /**
   * Play lofi jazz chords
   */
  playLofiChords(bpm) {
    const barLength = (60 / bpm) * 4; // 4 beats per bar

    // Lofi jazz chord progression (ii-V-I-vi style, but chill)
    // Using frequencies for Dm7 - G7 - Cmaj7 - Am7
    const chordProgression = [
      [146.83, 174.61, 220, 261.63],     // Dm7 (D F A C)
      [196, 246.94, 293.66, 349.23],     // G7 (G B D F)
      [130.81, 164.81, 196, 246.94],     // Cmaj7 (C E G B)
      [220, 261.63, 329.63, 392],        // Am7 (A C E G)
    ];

    let chordIndex = 0;

    const playChord = () => {
      if (this.currentState !== 'SCANNING' || !this.isEnabled) return;

      const chord = chordProgression[chordIndex];
      const time = this.audioContext.currentTime;

      chord.forEach((freq, i) => {
        // Stagger note attacks slightly for human feel
        const noteTime = time + (i * 0.03);
        this.playLofiNote(freq, noteTime, barLength * 0.9);
      });

      chordIndex = (chordIndex + 1) % chordProgression.length;
      setTimeout(playChord, barLength * 1000);
    };

    // Start after a beat
    setTimeout(playChord, (60 / bpm) * 1000);
  }

  /**
   * Play a single lofi piano-like note
   */
  playLofiNote(freq, time, duration) {
    // Use triangle wave for soft piano-like tone
    const osc = this.audioContext.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = freq;

    // Add slight detune for warmth
    const osc2 = this.audioContext.createOscillator();
    osc2.type = 'triangle';
    osc2.frequency.value = freq * 1.002; // Slight detune

    const gain = this.audioContext.createGain();
    gain.gain.setValueAtTime(0, time);
    gain.gain.linearRampToValueAtTime(0.08, time + 0.05); // Soft attack
    gain.gain.exponentialRampToValueAtTime(0.04, time + 0.3); // Quick decay
    gain.gain.exponentialRampToValueAtTime(0.001, time + duration); // Release

    // Heavy low-pass for lofi warmth
    const noteFilter = this.audioContext.createBiquadFilter();
    noteFilter.type = 'lowpass';
    noteFilter.frequency.value = 1500;
    noteFilter.Q.value = 0.5;

    osc.connect(noteFilter);
    osc2.connect(noteFilter);
    noteFilter.connect(gain);
    gain.connect(this.dryGain);
    gain.connect(this.convolver); // Add reverb

    osc.start(time);
    osc2.start(time);
    osc.stop(time + duration);
    osc2.stop(time + duration);
  }

  /**
   * Create filtered noise
   */
  createFilteredNoise(cutoff, volume) {
    const bufferSize = 2 * this.audioContext.sampleRate;
    const noiseBuffer = this.audioContext.createBuffer(1, bufferSize, this.audioContext.sampleRate);
    const output = noiseBuffer.getChannelData(0);

    for (let i = 0; i < bufferSize; i++) {
      output[i] = Math.random() * 2 - 1;
    }

    const noise = this.audioContext.createBufferSource();
    noise.buffer = noiseBuffer;
    noise.loop = true;

    const noiseFilter = this.audioContext.createBiquadFilter();
    noiseFilter.type = 'lowpass';
    noiseFilter.frequency.value = cutoff;

    const noiseGain = this.audioContext.createGain();
    noiseGain.gain.value = volume;

    noise.connect(noiseFilter);
    noiseFilter.connect(noiseGain);
    noiseGain.connect(this.dryGain);
    noise.start();

    return noise;
  }

  /**
   * State 2a: "In Position" (UP) - High-energy phonk/hardstyle, bass boost
   */
  playPositionUp() {
    if (!this.audioContext) return;

    // Boost bass, open up highs
    this.lowPassFilter.frequency.setTargetAtTime(20000, this.audioContext.currentTime, 0.3);
    this.highPassFilter.frequency.setTargetAtTime(30, this.audioContext.currentTime, 0.3);
    this.distortion.curve = this.makeDistortionCurve(20); // Light saturation
    this.reverbGain.gain.setTargetAtTime(0.1, this.audioContext.currentTime, 0.3);

    // Driving bass pattern
    const bpm = 140;
    const beatLength = 60 / bpm;

    this.playPhonkBeat(bpm);
  }

  /**
   * Play phonk-style beat
   */
  playPhonkBeat(bpm) {
    const beatLength = 60 / bpm;
    let beat = 0;

    const playBeat = () => {
      if (this.currentState !== 'POSITION_UP' || !this.isEnabled) return;

      const time = this.audioContext.currentTime;

      // Kick on 1 and 3
      if (beat % 4 === 0 || beat % 4 === 2) {
        this.playKick(time);
      }

      // Hi-hat on off-beats
      if (beat % 2 === 1) {
        this.playHiHat(time);
      }

      // 808 bass slides
      if (beat % 8 === 0) {
        this.play808(time, 55, 0.5);
      } else if (beat % 8 === 4) {
        this.play808(time, 65, 0.3);
      }

      beat++;
      setTimeout(playBeat, beatLength * 1000);
    };

    playBeat();
  }

  /**
   * Play kick drum
   */
  playKick(time) {
    const osc = this.audioContext.createOscillator();
    const gain = this.audioContext.createGain();

    osc.frequency.setValueAtTime(150, time);
    osc.frequency.exponentialRampToValueAtTime(30, time + 0.1);

    gain.gain.setValueAtTime(0.8, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.3);

    osc.connect(gain);
    gain.connect(this.dryGain);

    osc.start(time);
    osc.stop(time + 0.3);
  }

  /**
   * Play hi-hat
   */
  playHiHat(time) {
    const bufferSize = this.audioContext.sampleRate * 0.05;
    const buffer = this.audioContext.createBuffer(1, bufferSize, this.audioContext.sampleRate);
    const data = buffer.getChannelData(0);

    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }

    const noise = this.audioContext.createBufferSource();
    noise.buffer = buffer;

    const hihatFilter = this.audioContext.createBiquadFilter();
    hihatFilter.type = 'highpass';
    hihatFilter.frequency.value = 7000;

    const gain = this.audioContext.createGain();
    gain.gain.setValueAtTime(0.15, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.05);

    noise.connect(hihatFilter);
    hihatFilter.connect(gain);
    gain.connect(this.dryGain);

    noise.start(time);
  }

  /**
   * Play 808 bass
   */
  play808(time, freq, duration) {
    const osc = this.audioContext.createOscillator();
    const gain = this.audioContext.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, time);
    osc.frequency.exponentialRampToValueAtTime(freq * 0.5, time + duration);

    gain.gain.setValueAtTime(0.6, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + duration);

    // Add some distortion for that 808 growl
    const dist = this.audioContext.createWaveShaper();
    dist.curve = this.makeDistortionCurve(50);

    osc.connect(dist);
    dist.connect(gain);
    gain.connect(this.dryGain);

    osc.start(time);
    osc.stop(time + duration);
  }

  /**
   * State 2b: "In Position" (DOWN) - Distorted, slowed, reverbed
   */
  playPositionDown() {
    if (!this.audioContext) return;

    // Heavy filtering, lots of reverb, distortion
    this.lowPassFilter.frequency.setTargetAtTime(800, this.audioContext.currentTime, 0.5);
    this.highPassFilter.frequency.setTargetAtTime(100, this.audioContext.currentTime, 0.5);
    this.distortion.curve = this.makeDistortionCurve(100);
    this.reverbGain.gain.setTargetAtTime(0.7, this.audioContext.currentTime, 0.5);

    // Slow, dark drone
    const bpm = 60; // Slowed down
    this.playChoppedBeat(bpm);
  }

  /**
   * Play chopped & screwed style beat
   */
  playChoppedBeat(bpm) {
    const beatLength = 60 / bpm;
    let beat = 0;

    // Deep, slow drone
    const drone = this.audioContext.createOscillator();
    drone.type = 'sawtooth';
    drone.frequency.value = 40;

    const droneGain = this.audioContext.createGain();
    droneGain.gain.value = 0.2;

    const droneFilter = this.audioContext.createBiquadFilter();
    droneFilter.type = 'lowpass';
    droneFilter.frequency.value = 200;

    drone.connect(droneFilter);
    droneFilter.connect(droneGain);
    droneGain.connect(this.dryGain);
    droneGain.connect(this.convolver);
    drone.start();
    this.oscillators.push(drone);

    // Slow, heavy kick
    const playBeat = () => {
      if (this.currentState !== 'POSITION_DOWN' || !this.isEnabled) return;

      const time = this.audioContext.currentTime;

      // Slow kick
      if (beat % 2 === 0) {
        this.playSlowKick(time);
      }

      // Warped vocal-like sound
      if (beat % 4 === 0) {
        this.playWarpedSound(time);
      }

      beat++;
      setTimeout(playBeat, beatLength * 1000);
    };

    playBeat();
  }

  /**
   * Play slow, heavy kick for down state
   */
  playSlowKick(time) {
    const osc = this.audioContext.createOscillator();
    const gain = this.audioContext.createGain();

    osc.frequency.setValueAtTime(80, time);
    osc.frequency.exponentialRampToValueAtTime(20, time + 0.5);

    gain.gain.setValueAtTime(0.5, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.8);

    osc.connect(gain);
    gain.connect(this.dryGain);
    gain.connect(this.convolver);

    osc.start(time);
    osc.stop(time + 0.8);
  }

  /**
   * Play warped/pitched down sound
   */
  playWarpedSound(time) {
    const osc = this.audioContext.createOscillator();
    const gain = this.audioContext.createGain();

    osc.type = 'square';
    osc.frequency.setValueAtTime(200, time);
    osc.frequency.exponentialRampToValueAtTime(50, time + 1);

    gain.gain.setValueAtTime(0.1, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 1);

    osc.connect(gain);
    gain.connect(this.convolver);

    osc.start(time);
    osc.stop(time + 1);
  }

  /**
   * State 3: "The Crash" - Dial-up then silence
   */
  playCrash() {
    if (!this.audioContext) return;

    // Reset effects first
    this.lowPassFilter.frequency.setTargetAtTime(20000, this.audioContext.currentTime, 0.1);
    this.reverbGain.gain.setTargetAtTime(0, this.audioContext.currentTime, 0.1);
    this.distortion.curve = this.makeDistortionCurve(0);

    // Play dial-up modem sound
    this.playDialUp();

    // After 3 seconds, go silent
    this.crashTimeout = setTimeout(() => {
      this.stopAllAudio();
      // Stay silent for 5 seconds then return to scanning
      this.crashTimeout = setTimeout(() => {
        if (this.isEnabled && this.currentState === 'CRASH') {
          this.setState('SCANNING');
        }
      }, 5000);
    }, 3000);
  }

  /**
   * Play dial-up modem sound
   */
  playDialUp() {
    const time = this.audioContext.currentTime;

    // Initial carrier tone
    const carrier = this.audioContext.createOscillator();
    carrier.type = 'sine';
    carrier.frequency.setValueAtTime(1070, time);

    // Modulating oscillator
    const modulator = this.audioContext.createOscillator();
    modulator.type = 'sine';
    modulator.frequency.setValueAtTime(400, time);

    const modGain = this.audioContext.createGain();
    modGain.gain.value = 500;

    modulator.connect(modGain);
    modGain.connect(carrier.frequency);

    // Noise bursts
    const noiseGain = this.audioContext.createGain();
    noiseGain.gain.setValueAtTime(0, time);

    // Create noise schedule
    const noiseBuffer = this.audioContext.createBuffer(1, this.audioContext.sampleRate * 3, this.audioContext.sampleRate);
    const noiseData = noiseBuffer.getChannelData(0);
    for (let i = 0; i < noiseData.length; i++) {
      noiseData[i] = Math.random() * 2 - 1;
    }

    const noise = this.audioContext.createBufferSource();
    noise.buffer = noiseBuffer;

    // Bandpass filter for modem character
    const bandpass = this.audioContext.createBiquadFilter();
    bandpass.type = 'bandpass';
    bandpass.frequency.value = 2000;
    bandpass.Q.value = 5;

    const carrierGain = this.audioContext.createGain();
    carrierGain.gain.setValueAtTime(0.3, time);
    carrierGain.gain.setValueAtTime(0.15, time + 0.5);
    carrierGain.gain.setValueAtTime(0.3, time + 1);
    carrierGain.gain.setValueAtTime(0, time + 2.5);

    carrier.connect(bandpass);
    noise.connect(bandpass);
    bandpass.connect(carrierGain);
    carrierGain.connect(this.dryGain);

    // Frequency sweeps (classic modem handshake)
    carrier.frequency.setValueAtTime(1070, time);
    carrier.frequency.setValueAtTime(1270, time + 0.3);
    carrier.frequency.setValueAtTime(2025, time + 0.6);
    carrier.frequency.setValueAtTime(2225, time + 0.9);
    carrier.frequency.linearRampToValueAtTime(1650, time + 1.5);
    carrier.frequency.linearRampToValueAtTime(1850, time + 2);
    carrier.frequency.linearRampToValueAtTime(1000, time + 2.5);

    modulator.frequency.setValueAtTime(400, time);
    modulator.frequency.setValueAtTime(0, time + 1);
    modulator.frequency.setValueAtTime(200, time + 1.5);
    modulator.frequency.setValueAtTime(0, time + 2);

    carrier.start(time);
    modulator.start(time);
    noise.start(time);

    carrier.stop(time + 3);
    modulator.stop(time + 3);
    noise.stop(time + 3);

    this.oscillators.push(carrier, modulator);
  }

  /**
   * Update based on position P&L
   */
  updatePositionPnL(pnl, hasPosition) {
    this.positionPnL = pnl;
    this.hasActivePosition = hasPosition;

    if (!this.isEnabled) return;

    if (!hasPosition) {
      if (this.currentState !== 'SCANNING' && this.currentState !== 'CRASH') {
        this.setState('SCANNING');
      }
    } else {
      if (pnl >= 0) {
        if (this.currentState !== 'POSITION_UP') {
          this.setState('POSITION_UP');
        }
      } else {
        if (this.currentState !== 'POSITION_DOWN') {
          this.setState('POSITION_DOWN');
        }
      }
    }
  }

  /**
   * Trigger crash sound (stop loss hit)
   */
  triggerCrash() {
    if (this.isEnabled) {
      this.setState('CRASH');
    }
  }

  /**
   * Get current state
   */
  getState() {
    return {
      enabled: this.isEnabled,
      state: this.currentState,
      volume: this.volume,
      pnl: this.positionPnL,
      hasPosition: this.hasActivePosition
    };
  }
}

// Global instance
const trenchRadio = new TrenchRadio();

// Export for use in app.js
window.trenchRadio = trenchRadio;
