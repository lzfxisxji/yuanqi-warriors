/** 单次远征的状态：楼层、金币、强化、武器、统计与得分。 */
import { RNG } from '../core/math';
import type { CharacterDef } from '../data/characters';
import { addUpgrade, computeMods, defaultMods, rollUpgradeChoices, type Mods, type UpgradeStack } from '../data/upgrades';
import type { DungeonPlan } from '../dungeon/dungeon';
import { generateDungeon } from '../dungeon/dungeon';
import { Player } from '../entities/player';

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
    const s = this.stats;
    return Math.round(
      s.kills * 12 +
        s.rooms * 34 +
        this.gold * 0.6 +
        this.floor * 420 +
        (this.bossDefeated ? 900 : 0) +
        Math.max(0, 1800 - this.timeSec * 1.4),
    );
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
}
