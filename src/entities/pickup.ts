/** 拾取物：金币、生命、弹药、护盾、武器底座、强化宝珠、宝箱、传送门。 */
import { RNG, TAU, clamp, dist } from '../core/math';
import { PICKUP_MAGNET_RANGE, PICKUP_RANGE } from '../data/config';
import type { Room } from '../dungeon/room';
import { moveCircle } from '../systems/collision';

export type PickupKind = 'gold' | 'heart' | 'ammo' | 'shield' | 'weapon' | 'upgradeOrb' | 'chest' | 'portal';

export interface PickupData {
  weaponId?: string;
  upgradeId?: string;
  amount?: number;
  label?: string;
  price?: number;
  /** 商店商品是否已售出 */
  sold?: boolean;
}

export class Pickup {
  kind: PickupKind;
  x: number;
  y: number;
  vx = 0;
  vy = 0;
  radius = 12;
  bobPhase = Math.random() * TAU;
  /** 0 表示永久存在 */
  life = 0;
  age = 0;
  data: PickupData;
  /** 需要按 E 交互 */
  interactive = false;
  /** 是否正在被磁力吸引 */
  magnetized = false;
  collected = false;
  /** 出现动画 */
  spawnTimer = 0.35;
  locked = false;

  constructor(kind: PickupKind, x: number, y: number, data: PickupData = {}) {
    this.kind = kind;
    this.x = x;
    this.y = y;
    this.data = data;
    switch (kind) {
      case 'gold':
        this.radius = 9;
        this.life = 0;
        break;
      case 'heart':
      case 'shield':
        this.radius = 12;
        break;
      case 'ammo':
        this.radius = 12;
        break;
      case 'weapon':
      case 'chest':
      case 'upgradeOrb':
      case 'portal':
        this.radius = 20;
        this.interactive = true;
        break;
    }
    if (kind === 'gold') {
      const a = Math.random() * TAU;
      this.vx = Math.cos(a) * 90;
      this.vy = Math.sin(a) * 90;
    }
  }

  update(dt: number, player: { x: number; y: number; radius: number }, room: Room, magnetBonus = 0): void {
    this.age += dt;
    if (this.spawnTimer > 0) this.spawnTimer = Math.max(0, this.spawnTimer - dt);
    if (this.life > 0) this.life -= dt;

    const d = dist(this.x, this.y, player.x, player.y);
    if (this.kind === 'gold' || this.kind === 'heart' || this.kind === 'ammo' || this.kind === 'shield') {
      const range = PICKUP_MAGNET_RANGE + magnetBonus;
      if (d < range) {
        this.magnetized = true;
        const speed = clamp(520 - (d / range) * 260, 150, 560);
        const nx = (player.x - this.x) / (d || 1);
        const ny = (player.y - this.y) / (d || 1);
        this.x += nx * speed * dt;
        this.y += ny * speed * dt;
      } else {
        this.magnetized = false;
      }
    }

    if (this.vx !== 0 || this.vy !== 0) {
      const damp = Math.exp(-4.2 * dt);
      this.vx *= damp;
      this.vy *= damp;
      if (Math.abs(this.vx) < 2) this.vx = 0;
      if (Math.abs(this.vy) < 2) this.vy = 0;
      moveCircle(this, room, this.vx * dt, this.vy * dt);
    }
  }

  canCollect(player: { x: number; y: number; radius: number }): boolean {
    if (this.collected || this.locked) return false;
    if (this.spawnTimer > 0) return false;
    if (this.interactive) return false;
    return dist(this.x, this.y, player.x, player.y) < PICKUP_RANGE + player.radius;
  }

  canInteract(player: { x: number; y: number; radius: number }): boolean {
    if (this.collected || this.locked || !this.interactive) return false;
    if (this.data.sold) return false;
    if (this.spawnTimer > 0) return false;
    return dist(this.x, this.y, player.x, player.y) < 62;
  }

  get expired(): boolean {
    return this.life < 0;
  }
}

/** 掉落生成辅助。 */
export function rollGold(rng: RNG, min: number, max: number, goldMul: number): number {
  return Math.max(1, Math.round(rng.int(min, max) * goldMul));
}

export function scatterGold(
  out: Pickup[],
  rng: RNG,
  x: number,
  y: number,
  total: number,
): void {
  // 把总额拆成若干个金币，避免一坨数字
  const coins = clamp(Math.round(total / 6), 1, 5);
  const per = Math.max(1, Math.round(total / coins));
  for (let i = 0; i < coins; i++) {
    const a = rng.next() * TAU;
    const r = rng.range(6, 30);
    out.push(new Pickup('gold', x + Math.cos(a) * r, y + Math.sin(a) * r, { amount: per }));
  }
}
