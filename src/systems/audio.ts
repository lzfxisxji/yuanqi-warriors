/**
 * 音效系统：100% 使用 WebAudio 程序化合成，不依赖任何外部音频文件。
 * 每种武器 / 反馈都有独立的合成配方，因此射击反馈在听觉上也能区分。
 */

export interface AudioSettings {
  master: number;
  sfx: number;
  music: number;
}

export type SoundName =
  | 'pistol'
  | 'rifle'
  | 'shotgun'
  | 'sniper'
  | 'smg'
  | 'laser'
  | 'flame'
  | 'launcher'
  | 'enemyHit'
  | 'enemyDie'
  | 'playerHurt'
  | 'explosion'
  | 'pickup'
  | 'gold'
  | 'door'
  | 'doorLock'
  | 'reload'
  | 'skill'
  | 'dash'
  | 'bossRoar'
  | 'bossDie'
  | 'click'
  | 'buy'
  | 'error'
  | 'chest'
  | 'upgrade'
  | 'win'
  | 'lose'
  | 'summon';

const NOTE: Record<string, number> = {
  C3: 130.81,
  D3: 146.83,
  E3: 164.81,
  F3: 174.61,
  G3: 196.0,
  A3: 220.0,
  B3: 246.94,
  C4: 261.63,
  D4: 293.66,
  E4: 329.63,
  F4: 349.23,
  G4: 392.0,
  A4: 440.0,
  B4: 493.88,
  C5: 523.25,
  E5: 659.25,
  G5: 783.99,
};

/** 4 小节循环：Am - F - C - G（各一小节内为 4 拍） */
const MUSIC_CHORDS: number[][] = [
  [NOTE.A3!, NOTE.C4!, NOTE.E4!],
  [NOTE.F3!, NOTE.A3!, NOTE.C4!],
  [NOTE.C4!, NOTE.E4!, NOTE.G4!],
  [NOTE.G3!, NOTE.B3!, NOTE.D4!],
];
const MUSIC_BASS = [NOTE.A3!, NOTE.F3!, NOTE.C4!, NOTE.G3!];
const MUSIC_ARP = [NOTE.E4!, NOTE.C5!, NOTE.A4!, NOTE.G4!, NOTE.C5!, NOTE.E5!, NOTE.C5!, NOTE.G4!];

export class AudioSystem {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private sfxGain: GainNode | null = null;
  private musicGain: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private musicTimer = 0;
  private beat = 0;
  private musicPlaying = false;
  /** 0 = 探索，1 = Boss 战 */
  private intensity = 0;
  private lastPlay: Record<string, number> = {};
  settings: AudioSettings = { master: 0.8, sfx: 0.75, music: 0.28 };

  get ready(): boolean {
    return this.ctx !== null;
  }

  init(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    type AudioCtor = typeof AudioContext;
    const w = window as unknown as { AudioContext?: AudioCtor; webkitAudioContext?: AudioCtor };
    const Ctor = w.AudioContext ?? w.webkitAudioContext;
    if (!Ctor) return;
    try {
      this.ctx = new Ctor();
    } catch {
      return;
    }
    this.masterGain = this.ctx.createGain();
    this.sfxGain = this.ctx.createGain();
    this.musicGain = this.ctx.createGain();
    this.sfxGain.connect(this.masterGain);
    this.musicGain.connect(this.masterGain);
    this.masterGain.connect(this.ctx.destination);
    this.applySettings();

    const len = Math.floor(this.ctx.sampleRate * 0.6);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    this.noiseBuffer = buf;
  }

  applySettings(): void {
    if (!this.masterGain || !this.sfxGain || !this.musicGain) return;
    this.masterGain.gain.value = this.settings.master;
    this.sfxGain.gain.value = this.settings.sfx;
    this.musicGain.gain.value = this.musicPlaying ? this.settings.music : 0;
  }

  setSettings(s: Partial<AudioSettings>): void {
    this.settings = { ...this.settings, ...s };
    this.applySettings();
  }

  private now(): number {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  private tone(
    freq: number,
    dur: number,
    type: OscillatorType,
    gain: number,
    slideTo?: number,
    delay = 0,
  ): void {
    if (!this.ctx || !this.sfxGain) return;
    const t = this.now() + delay;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slideTo !== undefined) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), t + dur);
    }
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + Math.min(0.006, dur * 0.2));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g);
    g.connect(this.sfxGain);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  private noise(
    dur: number,
    filterFreq: number,
    gain: number,
    sweepTo?: number,
    q = 1,
    delay = 0,
  ): void {
    if (!this.ctx || !this.sfxGain || !this.noiseBuffer) return;
    const t = this.now() + delay;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(filterFreq, t);
    filter.Q.value = q;
    if (sweepTo !== undefined) {
      filter.frequency.exponentialRampToValueAtTime(Math.max(40, sweepTo), t + dur);
    }
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + Math.min(0.008, dur * 0.25));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(filter);
    filter.connect(g);
    g.connect(this.sfxGain);
    src.start(t);
    src.stop(t + dur + 0.02);
  }

  /** 同名音效在极短时间内的重复调用会被节流，避免连射时爆音。 */
  private throttle(name: string, ms: number): boolean {
    const t = performance.now();
    const last = this.lastPlay[name] ?? -1e9;
    if (t - last < ms) return true;
    this.lastPlay[name] = t;
    return false;
  }

  play(name: SoundName, volume = 1): void {
    if (!this.ctx) return;
    switch (name) {
      case 'pistol':
        if (this.throttle('pistol', 24)) return;
        this.noise(0.09, 1500, 0.24 * volume, 380, 1.1);
        this.tone(420, 0.07, 'square', 0.1 * volume, 130);
        break;
      case 'rifle':
        if (this.throttle('rifle', 22)) return;
        this.noise(0.075, 1900, 0.19 * volume, 520, 1.2);
        this.tone(520, 0.06, 'sawtooth', 0.075 * volume, 180);
        break;
      case 'smg':
        if (this.throttle('smg', 18)) return;
        this.noise(0.05, 2300, 0.13 * volume, 700, 1.4);
        this.tone(640, 0.04, 'square', 0.05 * volume, 240);
        break;
      case 'shotgun':
        this.noise(0.28, 900, 0.36 * volume, 140, 0.8);
        this.tone(180, 0.2, 'triangle', 0.16 * volume, 55);
        break;
      case 'sniper':
        this.noise(0.34, 2600, 0.3 * volume, 180, 1.6);
        this.tone(240, 0.3, 'sawtooth', 0.16 * volume, 60);
        this.tone(1400, 0.1, 'sine', 0.09 * volume, 400, 0.02);
        break;
      case 'laser':
        if (this.throttle('laser', 90)) return;
        this.tone(880, 0.24, 'sawtooth', 0.055 * volume, 1320);
        this.tone(1320, 0.2, 'sine', 0.03 * volume, 1760);
        break;
      case 'flame':
        if (this.throttle('flame', 70)) return;
        this.noise(0.2, 700, 0.13 * volume, 1500, 0.7);
        break;
      case 'launcher':
        this.tone(150, 0.22, 'square', 0.2 * volume, 60);
        this.noise(0.16, 620, 0.2 * volume, 200, 0.9);
        break;
      case 'enemyHit':
        if (this.throttle('enemyHit', 28)) return;
        this.noise(0.06, 2600, 0.11 * volume, 900, 1.3);
        this.tone(300, 0.05, 'triangle', 0.045 * volume, 170);
        break;
      case 'enemyDie':
        this.noise(0.3, 1200, 0.2 * volume, 220, 0.8);
        this.tone(220, 0.26, 'sawtooth', 0.1 * volume, 70);
        break;
      case 'playerHurt':
        this.tone(320, 0.2, 'square', 0.16 * volume, 110);
        this.noise(0.2, 800, 0.15 * volume, 260, 0.7);
        break;
      case 'explosion':
        this.noise(0.55, 320, 0.42 * volume, 70, 0.6);
        this.tone(90, 0.45, 'triangle', 0.24 * volume, 34);
        break;
      case 'pickup':
        this.tone(720, 0.12, 'sine', 0.1 * volume, 1180);
        break;
      case 'gold':
        this.tone(1180, 0.09, 'triangle', 0.075 * volume, 1620);
        this.tone(1560, 0.1, 'sine', 0.05 * volume, 2100, 0.05);
        break;
      case 'door':
        this.tone(150, 0.3, 'square', 0.09 * volume, 240);
        this.noise(0.3, 420, 0.08 * volume, 1200, 0.7);
        break;
      case 'doorLock':
        this.tone(90, 0.34, 'square', 0.14 * volume, 60);
        this.noise(0.26, 260, 0.16 * volume, 90, 0.9);
        break;
      case 'reload':
        this.noise(0.1, 1600, 0.1 * volume, 600, 1.2);
        this.tone(260, 0.08, 'square', 0.06 * volume, 180, 0.1);
        break;
      case 'skill':
        this.tone(400, 0.3, 'triangle', 0.14 * volume, 900);
        this.tone(600, 0.3, 'sine', 0.08 * volume, 1200, 0.05);
        break;
      case 'dash':
        this.noise(0.18, 1100, 0.14 * volume, 2600, 0.9);
        break;
      case 'summon':
        this.tone(180, 0.3, 'sine', 0.1 * volume, 420);
        this.tone(360, 0.24, 'triangle', 0.06 * volume, 620, 0.08);
        break;
      case 'bossRoar':
        this.tone(70, 1.1, 'sawtooth', 0.26 * volume, 44);
        this.tone(105, 0.9, 'square', 0.14 * volume, 60);
        this.noise(0.9, 260, 0.2 * volume, 90, 0.7);
        break;
      case 'bossDie':
        this.noise(1.5, 420, 0.4 * volume, 50, 0.6);
        this.tone(160, 1.3, 'sawtooth', 0.22 * volume, 34);
        this.tone(80, 1.6, 'triangle', 0.2 * volume, 26, 0.15);
        break;
      case 'click':
        this.tone(560, 0.05, 'square', 0.06 * volume, 720);
        break;
      case 'buy':
        this.tone(880, 0.08, 'triangle', 0.1 * volume, 1180);
        this.tone(1320, 0.12, 'sine', 0.07 * volume, 1660, 0.06);
        break;
      case 'error':
        this.tone(180, 0.16, 'square', 0.1 * volume, 120);
        break;
      case 'chest':
        this.noise(0.5, 900, 0.2 * volume, 2200, 0.8);
        this.tone(320, 0.5, 'triangle', 0.12 * volume, 980);
        break;
      case 'upgrade':
        this.tone(523, 0.16, 'triangle', 0.1 * volume, 660);
        this.tone(660, 0.16, 'triangle', 0.1 * volume, 784, 0.12);
        this.tone(880, 0.28, 'sine', 0.11 * volume, 1046, 0.24);
        break;
      case 'win':
        [523, 659, 784, 1046].forEach((f, i) => this.tone(f, 0.5, 'triangle', 0.14 * volume, f * 1.01, i * 0.16));
        break;
      case 'lose':
        [440, 392, 330, 262].forEach((f, i) => this.tone(f, 0.5, 'sawtooth', 0.12 * volume, f * 0.99, i * 0.2));
        break;
    }
  }

  // ---------------------------------------------------------------- 背景音乐

  startMusic(): void {
    if (!this.ctx) return;
    this.musicPlaying = true;
    this.musicTimer = 0;
    this.beat = 0;
    this.applySettings();
  }

  stopMusic(): void {
    this.musicPlaying = false;
    if (this.musicGain && this.ctx) {
      this.musicGain.gain.cancelScheduledValues(this.now());
      this.musicGain.gain.setTargetAtTime(0, this.now(), 0.12);
    }
  }

  setMusicIntensity(v: number): void {
    this.intensity = Math.max(0, Math.min(1, v));
  }

  /** 由主循环驱动，按节拍调度音符（避免 setInterval 漂移）。 */
  updateMusic(dt: number): void {
    if (!this.ctx || !this.musicPlaying || !this.musicGain) return;
    const bpm = 92 + this.intensity * 16;
    const beatDur = 60 / bpm;
    this.musicTimer += dt;
    while (this.musicTimer >= beatDur) {
      this.musicTimer -= beatDur;
      const beat = this.beat % 16;
      const bar = Math.floor(this.beat / 4) % 4;
      const chord = MUSIC_CHORDS[bar]!;
      if (beat % 4 === 0) {
        this.musicNote(MUSIC_BASS[bar]!, beatDur * 1.7, 'triangle', 0.5);
      }
      if (beat % 2 === 0 || this.intensity > 0.5) {
        const arp = MUSIC_ARP[(this.beat * 3) % MUSIC_ARP.length]!;
        this.musicNote(arp, beatDur * 0.6, 'sine', 0.22 + this.intensity * 0.16);
      }
      if (this.intensity > 0.35 && beat % 4 === 2) {
        this.musicNote(chord[2]!, beatDur * 0.9, 'sawtooth', 0.12, 0.35);
      }
      this.beat++;
    }
  }

  private musicNote(freq: number, dur: number, type: OscillatorType, gain: number, detune = 0): void {
    if (!this.ctx || !this.musicGain) return;
    const t = this.ctx.currentTime + 0.02;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 1800 + this.intensity * 1400;
    osc.type = type;
    osc.frequency.value = freq;
    osc.detune.value = detune;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(filter);
    filter.connect(g);
    g.connect(this.musicGain);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }
}
