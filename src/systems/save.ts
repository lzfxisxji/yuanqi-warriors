/**
 * 存档：使用浏览器 localStorage，保存设置 / 已解锁角色 / 已发现武器 / 历史最高进度。
 * 存储层做了抽象，便于在 Node 环境下用内存实现做单元测试。
 */

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface GameSettings {
  masterVolume: number;
  sfxVolume: number;
  musicVolume: number;
  screenShake: number;
  showDamageNumbers: boolean;
  showMinimap: boolean;
  /** 开启后游戏中始终保留系统鼠标光标（关闭时用自绘准星代替） */
  showSystemCursor: boolean;
}

export interface GameProgress {
  /** 历史抵达的最高楼层 */
  bestFloor: number;
  /** 通关次数（击败最终层 Boss） */
  wins: number;
  /** 总远征次数 */
  runs: number;
  /** 最快通关耗时（秒），未通关为 0 */
  bestTimeSec: number;
  totalKills: number;
  totalRooms: number;
  bestScore: number;
}

export interface SaveData {
  version: number;
  settings: GameSettings;
  unlockedCharacters: string[];
  discoveredWeapons: string[];
  progress: GameProgress;
}

export const SAVE_KEY = 'yuanqi-warriors:save:v1';
export const SAVE_VERSION = 1;

export function defaultSettings(): GameSettings {
  return {
    masterVolume: 0.8,
    sfxVolume: 0.75,
    musicVolume: 0.28,
    screenShake: 1,
    showDamageNumbers: true,
    showMinimap: true,
    showSystemCursor: false,
  };
}

export function defaultProgress(): GameProgress {
  return {
    bestFloor: 1,
    wins: 0,
    runs: 0,
    bestTimeSec: 0,
    totalKills: 0,
    totalRooms: 0,
    bestScore: 0,
  };
}

export function defaultSave(): SaveData {
  return {
    version: SAVE_VERSION,
    settings: defaultSettings(),
    unlockedCharacters: [],
    discoveredWeapons: [],
    progress: defaultProgress(),
  };
}

function clamp01(v: unknown, fallback: number): number {
  if (typeof v !== 'number' || Number.isNaN(v)) return fallback;
  return Math.max(0, Math.min(1, v));
}

function num(v: unknown, fallback: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return v;
}

function strArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

/** 反序列化并逐字段做健壮性校验，避免旧存档 / 脏数据导致崩溃。 */
export function parseSave(raw: unknown): SaveData {
  const base = defaultSave();
  if (!raw || typeof raw !== 'object') return base;
  const obj = raw as Record<string, unknown>;
  const settingsRaw = (obj.settings ?? {}) as Record<string, unknown>;
  const progressRaw = (obj.progress ?? {}) as Record<string, unknown>;

  return {
    version: SAVE_VERSION,
    settings: {
      masterVolume: clamp01(settingsRaw.masterVolume, base.settings.masterVolume),
      sfxVolume: clamp01(settingsRaw.sfxVolume, base.settings.sfxVolume),
      musicVolume: clamp01(settingsRaw.musicVolume, base.settings.musicVolume),
      screenShake: clamp01(settingsRaw.screenShake, base.settings.screenShake),
      showDamageNumbers:
        typeof settingsRaw.showDamageNumbers === 'boolean'
          ? settingsRaw.showDamageNumbers
          : base.settings.showDamageNumbers,
      showMinimap:
        typeof settingsRaw.showMinimap === 'boolean' ? settingsRaw.showMinimap : base.settings.showMinimap,
      showSystemCursor:
        typeof settingsRaw.showSystemCursor === 'boolean'
          ? settingsRaw.showSystemCursor
          : base.settings.showSystemCursor,
    },
    unlockedCharacters: strArray(obj.unlockedCharacters),
    discoveredWeapons: strArray(obj.discoveredWeapons),
    progress: {
      bestFloor: Math.max(1, Math.floor(num(progressRaw.bestFloor, 1))),
      wins: Math.max(0, Math.floor(num(progressRaw.wins, 0))),
      runs: Math.max(0, Math.floor(num(progressRaw.runs, 0))),
      bestTimeSec: Math.max(0, num(progressRaw.bestTimeSec, 0)),
      totalKills: Math.max(0, Math.floor(num(progressRaw.totalKills, 0))),
      totalRooms: Math.max(0, Math.floor(num(progressRaw.totalRooms, 0))),
      bestScore: Math.max(0, Math.floor(num(progressRaw.bestScore, 0))),
    },
  };
}

export class SaveManager {
  private storage: StorageLike | null;
  data: SaveData;

  constructor(storage?: StorageLike | null) {
    this.storage = storage === undefined ? detectStorage() : storage;
    this.data = this.read();
  }

  private read(): SaveData {
    if (!this.storage) return defaultSave();
    try {
      const raw = this.storage.getItem(SAVE_KEY);
      if (!raw) return defaultSave();
      return parseSave(JSON.parse(raw));
    } catch {
      return defaultSave();
    }
  }

  save(): void {
    if (!this.storage) return;
    try {
      this.storage.setItem(SAVE_KEY, JSON.stringify(this.data));
    } catch {
      /* 隐私模式 / 配额不足时静默失败，不影响游戏 */
    }
  }

  reset(): void {
    this.data = defaultSave();
    if (this.storage) {
      try {
        this.storage.removeItem(SAVE_KEY);
      } catch {
        /* ignore */
      }
    }
    this.save();
  }

  updateSettings(patch: Partial<GameSettings>): void {
    this.data.settings = { ...this.data.settings, ...patch };
    this.save();
  }

  discoverWeapon(id: string): void {
    if (!this.data.discoveredWeapons.includes(id)) {
      this.data.discoveredWeapons.push(id);
      this.save();
    }
  }

  unlockCharacter(id: string): void {
    if (!this.data.unlockedCharacters.includes(id)) {
      this.data.unlockedCharacters.push(id);
      this.save();
    }
  }

  /** 一次远征结束后更新历史进度。 */
  recordRun(result: {
    floor: number;
    won: boolean;
    timeSec: number;
    kills: number;
    rooms: number;
    score: number;
  }): void {
    const p = this.data.progress;
    p.runs += 1;
    p.bestFloor = Math.max(p.bestFloor, result.floor);
    if (result.won) {
      p.wins += 1;
      if (p.bestTimeSec === 0 || result.timeSec < p.bestTimeSec) {
        p.bestTimeSec = result.timeSec;
      }
    }
    p.totalKills += result.kills;
    p.totalRooms += result.rooms;
    p.bestScore = Math.max(p.bestScore, result.score);
    this.save();
  }
}

function detectStorage(): StorageLike | null {
  try {
    if (typeof localStorage !== 'undefined' && localStorage) return localStorage;
  } catch {
    /* 某些浏览器在禁用 cookie 时访问 localStorage 会抛错 */
  }
  return null;
}

/** 供测试使用的内存存储。 */
export function createMemoryStorage(): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    setItem: (k, v) => {
      map.set(k, v);
    },
    removeItem: (k) => {
      map.delete(k);
    },
  };
}
