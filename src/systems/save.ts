/**
 * 存档：使用浏览器 localStorage，保存设置 / 已解锁角色 / 已发现武器 / 历史最高进度 / 未完成的远征。
 * 存储层做了抽象，便于在 Node 环境下用内存实现做单元测试。
 */
import type { UpgradeStack } from '../data/upgrades';
import { CHECKIN_CYCLE, DAILY_CHECKIN } from '../data/config';
import { TALENTS, clampLevel } from '../data/talents';
import {
  SAVED_RUN_VERSION,
  type RunState,
  type SavedRoomFlags,
  type SavedRun,
  type SavedWeapon,
} from './run';

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

/**
 * 全局钱包：跨局、跨会话持久化的货币。
 *
 * 需求 35 新增。注意它与「局内金币」（`SavedRun.gold`，每局重新计算、随远征结束清零）是**两个独立概念**：
 * 这里的是玩家账户里长期累积的余额，目前由「每日签到」发放，UI 在主菜单常驻显示。
 */
export interface Wallet {
  /** 钻石：稀有货币，签到第 3/6/7 天发放。 */
  diamonds: number;
  /** 金币：常见货币，签到多数天数发放。 */
  coins: number;
}

/**
 * 每日签到状态（需求 35）。
 *
 * - `lastDate`：最近一次成功签到的本地日期，格式 `YYYY-MM-DD`（见 `localDateKey`）。
 *   与今天相同即视为「今日已签到」，不可重复领取。
 * - `streak`：当前连续签到**已经签到的第几天**（1..CHECKIN_CYCLE）。下一次签到会据此推算下一天：
 *   连续则 `(streak % CYCLE) + 1`（第 8 天回第 1 天循环），断签（与上次间隔 > 1 天）则重置为 1。
 */
export interface CheckInState {
  lastDate: string;
  streak: number;
}

export interface SaveData {
  version: number;
  settings: GameSettings;
  unlockedCharacters: string[];
  discoveredWeapons: string[];
  progress: GameProgress;
  /** 全局钱包（需求 35）。 */
  wallet: Wallet;
  /** 每日签到状态（需求 35）。 */
  checkIn: CheckInState;
  /**
   * 天赋等级表（需求 37）：talentId → 已投入层级。账户级、跨局持久化。
   * 缺省为 `{}`（所有天赋 0 级）。解析时只保留已知 id 且层级夹取 0..maxLevel。
   */
  talents: Record<string, number>;
  /**
   * **每名角色各存一份**未完成的远征（单机），键 = 角色 id。
   *
   * 需求 20 之前这里是单个 `run: SavedRun | null` 槽位：换角色开新局会把上一个人的
   * 进度直接挤掉。改成按角色分槽后，推到第 2 层的奶龙和刚开始的噜噜可以同时留着，
   * 存档管理页里也能逐份删除。
   */
  runs: Record<string, SavedRun>;
}

export const SAVE_KEY = 'yuanqi-warriors:save:v1';
export const SAVE_VERSION = 3;

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
    wallet: { diamonds: 0, coins: 0 },
    checkIn: { lastDate: '', streak: 0 },
    talents: {},
    runs: {},
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

/** 校验一份远征存档；任何关键字段不合法就整份丢弃（宁可从头开始，也不要加载出坏档）。 */
export function parseSavedRun(raw: unknown): SavedRun | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const characterId = typeof o.characterId === 'string' ? o.characterId : '';
  const seed = typeof o.seed === 'number' && Number.isFinite(o.seed) ? o.seed >>> 0 : NaN;
  const currentRoomKey = typeof o.currentRoomKey === 'string' ? o.currentRoomKey : '';
  if (!characterId || Number.isNaN(seed) || !currentRoomKey) return null;

  const upgrades: UpgradeStack[] = [];
  if (Array.isArray(o.upgrades)) {
    for (const u of o.upgrades) {
      if (!u || typeof u !== 'object') continue;
      const rec = u as Record<string, unknown>;
      if (typeof rec.id !== 'string') continue;
      upgrades.push({ id: rec.id, stacks: Math.max(1, Math.floor(num(rec.stacks, 1))) });
    }
  }

  const weapons: SavedWeapon[] = [];
  if (Array.isArray(o.weapons)) {
    for (const w of o.weapons) {
      if (!w || typeof w !== 'object') continue;
      const rec = w as Record<string, unknown>;
      if (typeof rec.id !== 'string') continue;
      weapons.push({ id: rec.id, ammo: Math.max(0, Math.floor(num(rec.ammo, 0))) });
    }
  }
  if (!weapons.length) return null;

  const rooms: Record<string, SavedRoomFlags> = {};
  if (o.rooms && typeof o.rooms === 'object') {
    for (const [key, flags] of Object.entries(o.rooms as Record<string, unknown>)) {
      if (!flags || typeof flags !== 'object') continue;
      const f = flags as Record<string, unknown>;
      rooms[key] = {
        rewardDropped: f.rewardDropped === true,
        interacted: f.interacted === true,
        prepShown: f.prepShown === true,
      };
    }
  }

  const statsRaw = (o.stats ?? {}) as Record<string, unknown>;
  const base = defaultRunStats();

  return {
    version: SAVED_RUN_VERSION,
    characterId,
    seed,
    floor: Math.max(1, Math.floor(num(o.floor, 1))),
    gold: Math.max(0, Math.floor(num(o.gold, 0))),
    upgrades,
    weapons,
    weaponIndex: Math.max(0, Math.floor(num(o.weaponIndex, 0))),
    hp: Math.max(1, num(o.hp, 1)),
    shield: Math.max(0, num(o.shield, 0)),
    barrier: Math.max(0, num(o.barrier, 0)),
    timeSec: Math.max(0, num(o.timeSec, 0)),
    bossDefeated: o.bossDefeated === true,
    currentRoomKey,
    visited: strArray(o.visited),
    cleared: strArray(o.cleared),
    rooms,
    stats: {
      kills: Math.max(0, Math.floor(num(statsRaw.kills, base.kills))),
      rooms: Math.max(0, Math.floor(num(statsRaw.rooms, base.rooms))),
      damageDealt: Math.max(0, num(statsRaw.damageDealt, base.damageDealt)),
      damageTaken: Math.max(0, num(statsRaw.damageTaken, base.damageTaken)),
      goldEarned: Math.max(0, Math.floor(num(statsRaw.goldEarned, base.goldEarned))),
      shotsFired: Math.max(0, Math.floor(num(statsRaw.shotsFired, base.shotsFired))),
    },
    savedAt: Math.max(0, num(o.savedAt, 0)),
  };
}

function defaultRunStats(): RunState['stats'] {
  return { kills: 0, rooms: 0, damageDealt: 0, damageTaken: 0, goldEarned: 0, shotsFired: 0 };
}

/**
 * 解析「每角色一份」的远征存档表。
 *
 * - 非法条目直接丢弃（`parseSavedRun` 已经把坏档挡掉了）；
 * - **键必须与存档自己记录的 characterId 一致**，对不上就丢弃而不是改写 ——
 *   宁可少一份档，也不要出现「点奶龙却载入噜噜」这种张冠李戴；
 * - `legacyRun` 是旧版（SAVE_VERSION ≤ 2）的单个 `run` 槽位，迁移进新结构，
 *   老玩家升级后原有的续玩进度不会丢。
 */
function parseWallet(raw: unknown): Wallet {
  if (!raw || typeof raw !== 'object') return { diamonds: 0, coins: 0 };
  const o = raw as Record<string, unknown>;
  return {
    diamonds: Math.max(0, Math.floor(num(o.diamonds, 0))),
    coins: Math.max(0, Math.floor(num(o.coins, 0))),
  };
}

function parseCheckIn(raw: unknown): CheckInState {
  if (!raw || typeof raw !== 'object') return { lastDate: '', streak: 0 };
  const o = raw as Record<string, unknown>;
  const lastDate = typeof o.lastDate === 'string' ? o.lastDate : '';
  // 日期格式必须是 YYYY-MM-DD，脏数据直接丢弃（避免把非法串当成「已签到」）
  const okDate = /^\d{4}-\d{2}-\d{2}$/.test(lastDate) ? lastDate : '';
  return {
    lastDate: okDate,
    streak: Math.max(0, Math.floor(num(o.streak, 0))),
  };
}

/** 天赋等级表：只保留已知 id，层级夹取 0..maxLevel；脏 / 未知字段丢弃。 */
function parseTalents(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const o = raw as Record<string, unknown>;
  for (const t of TALENTS) {
    const lvl = clampLevel(o[t.id], t.maxLevel);
    if (lvl > 0) out[t.id] = lvl;
  }
  return out;
}

function parseRuns(raw: unknown, legacyRun: unknown): Record<string, SavedRun> {
  const runs: Record<string, SavedRun> = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      const parsed = parseSavedRun(value);
      if (parsed && parsed.characterId === key) runs[key] = parsed;
    }
  }
  const legacy = parseSavedRun(legacyRun);
  if (legacy && !runs[legacy.characterId]) runs[legacy.characterId] = legacy;
  return runs;
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
    wallet: parseWallet(obj.wallet),
    checkIn: parseCheckIn(obj.checkIn),
    talents: parseTalents(obj.talents),
    runs: parseRuns(obj.runs, obj.run),
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

  // ------------------------------------------------------------- 远征存档

  /** 某角色未完成的远征；没有就返回 null。 */
  getRun(characterId: string): SavedRun | null {
    return this.data.runs[characterId] ?? null;
  }

  /** 全部未完成的远征，按落盘时间**由新到旧**排序（主菜单取 [0] 当「继续远征」）。 */
  listRuns(): SavedRun[] {
    return Object.values(this.data.runs).sort((a, b) => b.savedAt - a.savedAt);
  }

  /** 是否存在任意可续玩的进度。 */
  get hasAnyRun(): boolean {
    return Object.keys(this.data.runs).length > 0;
  }

  /** 最近一次落盘的进度。 */
  get latestRun(): SavedRun | null {
    return this.listRuns()[0] ?? null;
  }

  /** 覆盖写入某角色的远征进度（自动存档点：进新房间 / 定时心跳）。 */
  setRun(run: SavedRun): void {
    this.data.runs[run.characterId] = run;
    this.save();
  }

  /**
   * 删除**某一名角色**的存档（存档管理页的「删除」/ 该角色开新局 / 该角色打完一局）。
   * 只影响这一个键，其它角色的进度原样保留。
   */
  deleteRun(characterId: string): void {
    if (!Object.prototype.hasOwnProperty.call(this.data.runs, characterId)) return;
    delete this.data.runs[characterId];
    this.save();
  }

  /** 删除全部角色的存档（存档管理页的「清空全部存档」）。设置与历史统计不动。 */
  clearAllRuns(): void {
    if (!this.hasAnyRun) return;
    this.data.runs = {};
    this.save();
  }

  // ------------------------------------------------------------- 每日签到（需求 35）

  /**
   * 当前签到状态，供主菜单与签到面板读取。
   * - `canClaim`：今天是否还能签（与 `lastDate===今天` 相反）。
   * - `day`：今天**应该签到的第几天**——已签时等于已签到的那一天；未签时是「下一次该领的那天」。
   *   面板用它决定高亮哪一格、以及显示「连签 N 天 / 今日可领」。
   */
  getCheckIn(now: Date = new Date()): {
    lastDate: string;
    streak: number;
    day: number;
    canClaim: boolean;
  } {
    const today = localDateKey(now);
    const claimedToday = this.data.checkIn.lastDate === today;
    const day = claimedToday
      ? this.data.checkIn.streak
      : (this.data.checkIn.streak % CHECKIN_CYCLE) + 1;
    return {
      lastDate: this.data.checkIn.lastDate,
      streak: this.data.checkIn.streak,
      day,
      canClaim: !claimedToday,
    };
  }

  /**
   * 领取今日签到奖励。成功返回发放明细（第几天 + 金币 + 钻石），今天已签过则返回 null。
   * `now` 可注入（默认 `new Date()`），便于测试模拟跨天连续 / 断签。
   */
  claimDailyCheckIn(now: Date = new Date()): { day: number; coins: number; diamonds: number } | null {
    const today = localDateKey(now);
    if (this.data.checkIn.lastDate === today) return null; // 今日已签，不可重复

    const last = this.data.checkIn.lastDate;
    let nextDay: number;
    if (!last) {
      nextDay = 1; // 首次签到
    } else {
      const gap = daysBetween(last, today);
      // 仅当恰好隔 1 天算「连续」，否则（隔多天 / 脏日期）一律断签重置为第 1 天
      nextDay = gap === 1 ? (this.data.checkIn.streak % CHECKIN_CYCLE) + 1 : 1;
    }

    const reward = DAILY_CHECKIN[nextDay - 1]!;
    this.data.wallet.coins += reward.coins;
    this.data.wallet.diamonds += reward.diamonds;
    this.data.checkIn.streak = nextDay;
    this.data.checkIn.lastDate = today;
    this.save();
    return { day: nextDay, coins: reward.coins, diamonds: reward.diamonds };
  }
}

/** 本地日期键 `YYYY-MM-DD`（按运行环境本地时区；签到按「本地一天」计）。 */
export function localDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 两个 `YYYY-MM-DD` 相差天数（b - a，四舍五入取整）；任一非法日期返回 NaN。 */
export function daysBetween(a: string, b: string): number {
  const pa = Date.parse(`${a}T00:00:00`);
  const pb = Date.parse(`${b}T00:00:00`);
  if (Number.isNaN(pa) || Number.isNaN(pb)) return NaN;
  return Math.round((pb - pa) / 86_400_000);
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
