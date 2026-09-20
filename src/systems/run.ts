/** 单次远征的状态：楼层、金币、强化、武器、统计与得分。 */
import { RNG, clamp } from '../core/math';
import type { CharacterDef } from '../data/characters';
import { addUpgrade, computeMods, defaultMods, rollUpgradeChoices, type Mods, type UpgradeStack } from '../data/upgrades';
import type { DungeonPlan } from '../dungeon/dungeon';
import { generateDungeon } from '../dungeon/dungeon';
import { Player, createWeaponInstance } from '../entities/player';

export interface RunResult {
  floor: number;
  won: boolean;
  timeSec: number;
  kills: number;
  rooms: number;
  gold: number;
  score: number;
  characterId: string;
}

/**
 * 存档版本：结构变化时递增。解析时缺失字段一律走默认值，因此旧档不会崩。
 */
export const SAVED_RUN_VERSION = 1;

export interface SavedWeapon {
  id: string;
  ammo: number;
}

/** 房间级的交互标志：避免续玩时重开已开的宝箱 / 重复触发事件与首领补给站。 */
export interface SavedRoomFlags {
  rewardDropped?: boolean;
  interacted?: boolean;
  prepShown?: boolean;
}

/**
 * 一次远征的完整存档。
 *
 * 刻意**不存**房间内的瞬时对象（敌人 / 弹丸 / 地面掉落）：
 * 地牢由 `seed + floor` 完全决定，恢复时按同一种子重新生成，
 * 玩家回到存档时所在房间的入口重新开打即可 —— 体积小且不会版本漂移。
 */
export interface SavedRun {
  version: number;
  characterId: string;
  seed: number;
  floor: number;
  gold: number;
  upgrades: UpgradeStack[];
  weapons: SavedWeapon[];
  weaponIndex: number;
  hp: number;
  shield: number;
  barrier: number;
  timeSec: number;
  bossDefeated: boolean;
  currentRoomKey: string;
  visited: string[];
  /** 已清场的房间 key（Boss 房重进时据此补传送门） */
  cleared: string[];
  rooms: Record<string, SavedRoomFlags>;
  stats: RunState['stats'];
  /** 存档时间戳，用于菜单显示 */
  savedAt: number;
}

/**
 * 得分的**唯一出处**：`RunState.score`（局内实时）与存档管理页的「得分」
 * 共用这一个函数 —— 之前公式只长在 getter 里，存档列表要显示得分就只能再抄一遍，
 * 抄完迟早跟这边对不上。
 */
export function computeScore(s: {
  floor: number;
  gold: number;
  timeSec: number;
  bossDefeated: boolean;
  stats: { kills: number; rooms: number };
}): number {
  return Math.round(
    s.stats.kills * 12 +
      s.stats.rooms * 34 +
      s.gold * 0.6 +
      s.floor * 420 +
      (s.bossDefeated ? 900 : 0) +
      Math.max(0, 1800 - s.timeSec * 1.4),
  );
}

export class RunState {
  readonly character: CharacterDef;
  readonly seed: number;
  floor = 1;
  gold = 0;
  upgrades: UpgradeStack[] = [];
  mods: Mods = defaultMods();
  plan: DungeonPlan;
  player: Player;
  currentRoomKey: string;
  visited = new Set<string>();
  timeSec = 0;
  bossDefeated = false;
  /** 每层专属 RNG（保证同种子可复现） */
  rng: RNG;
  stats = {
    kills: 0,
    rooms: 0,
    damageDealt: 0,
    damageTaken: 0,
    goldEarned: 0,
    shotsFired: 0,
  };

  constructor(character: CharacterDef, seed: number) {
    this.character = character;
    this.seed = seed >>> 0;
    this.rng = new RNG(this.seed);
    this.player = new Player(character);
    this.plan = generateDungeon({ seed: this.seedForFloor(1), floor: 1 });
    this.currentRoomKey = this.plan.startKey;
    this.player.refreshFromMods(this.mods);
    this.player.hp = this.player.maxHp;
    this.visited.add(this.plan.startKey);
  }

  seedForFloor(floor: number): number {
    return (this.seed + floor * 2654435761) >>> 0;
  }

  /** 进入新一层：保留强化与武器，重生成地牢，恢复部分状态。 */
  advanceFloor(): void {
    this.floor += 1;
    this.bossDefeated = false;
    this.plan = generateDungeon({ seed: this.seedForFloor(this.floor), floor: this.floor });
    this.currentRoomKey = this.plan.startKey;
    this.visited.clear();
    this.visited.add(this.plan.startKey);
    this.rng = new RNG(this.seedForFloor(this.floor) ^ 0xabcdef);
    // 层间补给：回满护盾并回复 40% 生命
    this.player.hp = Math.min(this.player.maxHp, this.player.hp + this.player.maxHp * 0.4);
    this.player.shield = this.player.maxShield;
    this.player.barrier = 0;
  }

  recomputeMods(): void {
    const prevMaxHp = this.player.maxHp;
    this.mods = computeMods(this.upgrades);
    this.player.refreshFromMods(this.mods, true);
    // 生命上限提升时直接补满新增部分
    if (this.player.maxHp > prevMaxHp) {
      this.player.hp = Math.min(this.player.maxHp, this.player.hp + (this.player.maxHp - prevMaxHp));
    }
  }

  addUpgrade(id: string): void {
    addUpgrade(this.upgrades, id);
    this.recomputeMods();
  }

  rollUpgrades(count: number): string[] {
    return rollUpgradeChoices(this.upgrades, count, (weights) => this.rng.weightedIndex(weights));
  }

  addGold(amount: number): number {
    const final = Math.max(0, Math.round(amount * this.mods.goldMul));
    this.gold += final;
    this.stats.goldEarned += final;
    return final;
  }

  spendGold(amount: number): boolean {
    if (this.gold < amount) return false;
    this.gold -= amount;
    return true;
  }

  get score(): number {
    return computeScore(this);
  }

  result(won: boolean): RunResult {
    return {
      floor: this.floor,
      won,
      timeSec: this.timeSec,
      kills: this.stats.kills,
      rooms: this.stats.rooms,
      gold: this.gold,
      score: this.score,
      characterId: this.character.id,
    };
  }

  // ------------------------------------------------------------- 存档

  /** 把当前远征序列化成可落盘的快照。 */
  snapshotRun(rooms: Record<string, SavedRoomFlags> = {}, savedAt = Date.now()): SavedRun {
    const cleared: string[] = [];
    for (const n of this.plan.nodes.values()) if (n.cleared) cleared.push(n.key);
    return {
      version: SAVED_RUN_VERSION,
      characterId: this.character.id,
      seed: this.seed,
      floor: this.floor,
      gold: this.gold,
      upgrades: this.upgrades.map((u) => ({ id: u.id, stacks: u.stacks })),
      weapons: this.player.weapons.map((w) => ({ id: w.def.id, ammo: w.ammo })),
      weaponIndex: this.player.weaponIndex,
      hp: this.player.hp,
      shield: this.player.shield,
      barrier: this.player.barrier,
      timeSec: this.timeSec,
      bossDefeated: this.bossDefeated,
      currentRoomKey: this.currentRoomKey,
      visited: [...this.visited],
      cleared,
      rooms,
      stats: { ...this.stats },
      savedAt,
    };
  }

  /**
   * 用存档恢复远征状态。
   * 必须在构造完 RunState 之后、进入房间之前调用（`this.plan` 与 `this.player` 都会被重写）。
   */
  restoreRun(saved: SavedRun): void {
    this.floor = Math.max(1, Math.floor(saved.floor) || 1);
    this.plan = generateDungeon({ seed: this.seedForFloor(this.floor), floor: this.floor });
    for (const key of saved.cleared) {
      const n = this.plan.nodes.get(key);
      if (n) n.cleared = true;
    }
    this.visited = new Set(saved.visited.filter((k) => this.plan.nodes.has(k)));
    this.currentRoomKey = this.plan.nodes.has(saved.currentRoomKey) ? saved.currentRoomKey : this.plan.startKey;
    this.visited.add(this.currentRoomKey);
    this.plan.nodes.get(this.currentRoomKey)!.visited = true;
    this.gold = Math.max(0, Math.floor(saved.gold) || 0);
    this.upgrades = saved.upgrades.map((u) => ({ id: u.id, stacks: u.stacks }));
    // 先按强化重算派生属性，再用同样的 mods 建枪（弹匣扩容才生效）
    this.recomputeMods();
    const weapons = saved.weapons.length ? saved.weapons : [{ id: this.character.startWeapon, ammo: 0 }];
    this.player.weapons = weapons.map((w) => {
      const inst = createWeaponInstance(w.id, this.mods);
      if (Number.isFinite(w.ammo)) inst.ammo = clamp(Math.floor(w.ammo), 0, inst.magSize);
      return inst;
    });
    this.player.weaponIndex = clamp(Math.floor(saved.weaponIndex) || 0, 0, this.player.weapons.length - 1);
    this.player.hp = clamp(Math.round(saved.hp) || this.player.maxHp, 1, this.player.maxHp);
    this.player.shield = clamp(Math.round(saved.shield) || 0, 0, this.player.maxShield);
    this.player.barrier = Math.max(0, Math.round(saved.barrier) || 0);
    this.timeSec = Math.max(0, Number(saved.timeSec) || 0);
    this.bossDefeated = saved.bossDefeated === true;
    this.stats = { ...this.stats, ...saved.stats };
    this.rng = new RNG(this.seedForFloor(this.floor) ^ 0xabcdef);
  }
}
