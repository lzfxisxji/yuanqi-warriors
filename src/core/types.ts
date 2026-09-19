/** 跨模块共享的枚举与轻量类型定义。 */

/**
 * 阵营。
 * 单人模式只用 'player' / 'enemy' / 'neutral'；
 * 联机 PK 模式下每名玩家用各自的 peerId 作为阵营（自由混战，互相可伤害），
 * 因此这里放宽为字符串，既保留字面量提示，又允许任意标识。
 */
export type Team = 'player' | 'enemy' | 'neutral' | (string & {});

/** 合作模式所有玩家共用的阵营标识。 */
export const TEAM_HEROES = 'heroes';

export type Dir4 = 'n' | 'e' | 's' | 'w';

export const DIRS: readonly Dir4[] = ['n', 'e', 's', 'w'];

export const DIR_VECTORS: Record<Dir4, { x: number; y: number }> = {
  n: { x: 0, y: -1 },
  e: { x: 1, y: 0 },
  s: { x: 0, y: 1 },
  w: { x: -1, y: 0 },
};

export const OPPOSITE_DIR: Record<Dir4, Dir4> = { n: 's', s: 'n', e: 'w', w: 'e' };

export type RoomType =
  | 'start'
  | 'combat'
  | 'elite'
  | 'treasure'
  | 'shop'
  | 'event'
  | 'boss';

/** 具备战斗与奖励流程的房间类型（进入后锁门、清场、发奖）。 */
export const COMBAT_ROOM_TYPES: readonly RoomType[] = ['combat', 'elite', 'boss'];

export function isCombatRoom(t: RoomType): boolean {
  return t === 'combat' || t === 'elite' || t === 'boss';
}

/** 通用实体接口，碰撞与战斗系统只依赖它。 */
export interface Damageable {
  x: number;
  y: number;
  radius: number;
  hp: number;
  maxHp: number;
  dead: boolean;
  team: Team;
}

export interface DamageResult {
  applied: number;
  crit: boolean;
  killed: boolean;
  blocked: boolean;
  /** 是否因闪避而免伤 */
  dodged: boolean;
}
