/** 战斗结算：伤害上下文、爆炸范围伤害、伤害数字与反馈的统一入口。 */
import type { EventBus } from '../core/eventbus';
import { GameEvents } from '../core/eventbus';
import type { DamageResult, Team } from '../core/types';
import type { AudioSystem } from './audio';
import type { DamageNumbers, FlashOverlay, ScreenShake, TimeControl } from './effects';
import type { ParticleSystem } from './particles';

export interface DamageContext {
  particles: ParticleSystem;
  bus: EventBus;
  shake: ScreenShake;
  numbers: DamageNumbers;
  flash: FlashOverlay;
  time: TimeControl;
  audio: AudioSystem;
}

export type DamageSource =
  | 'bullet'
  | 'explosion'
  | 'contact'
  | 'burn'
  | 'thorns'
  | 'beam'
  | 'melee'
  /** 冲刺类技能（蛮牛冲撞 / 重拳突进）撞到敌人的那一下。 */
  | 'dash';

export interface HitOptions {
  crit: boolean;
  source: DamageSource;
  dirX: number;
  dirY: number;
  knockback: number;
  /** 命中粒子颜色 */
  color?: string;
  /**
   * 施加者的阵营（= 归属玩家）。
   *
   * 自由混战（PK）里每个玩家的 `team` 就是自己的 peerId，所以这一个字段就足以
   * 把「这一下是谁打的」记在敌人身上（`Enemy.killedByTeam`），
   * 结算时按人头判定胜负才公平 —— 否则所有击杀都会被记到房主头上。
   * 单机 / 合作模式不需要，可以不传。
   */
  ownerTeam?: Team;
}

export interface HitEntity {
  x: number;
  y: number;
  radius: number;
  hp: number;
  dead: boolean;
  team: Team;
  applyDamage(amount: number, opts: HitOptions): DamageResult;
}

export interface EnvironmentDamage {
  /** 对范围类的可破坏场景物（木箱等）造成伤害 */
  damageInRadius(x: number, y: number, radius: number, damage: number, ctx: DamageContext): void;
}

export function defaultHitOptions(partial: Partial<HitOptions> = {}): HitOptions {
  return {
    crit: false,
    source: 'bullet',
    dirX: 0,
    dirY: 0,
    knockback: 0,
    ...partial,
  };
}

export interface ExplosionOptions {
  x: number;
  y: number;
  radius: number;
  damage: number;
  /** 施加者阵营；只伤害不同阵营的目标 */
  team: Team;
  targets: readonly HitEntity[];
  ctx: DamageContext;
  color?: string;
  coreColor?: string;
  /** 冲击力 */
  knockback?: number;
  environment?: EnvironmentDamage;
  /** 是否震屏（默认 true） */
  shake?: boolean;
  /** 伤害是否随距离衰减 */
  falloff?: boolean;
}

/** 范围爆炸：对范围内所有敌对目标造成伤害并推开。 */
export function explode(opts: ExplosionOptions): number {
  const {
    x,
    y,
    radius,
    damage,
    team,
    targets,
    ctx,
    color = '#ff8a3c',
    coreColor = '#fff3c4',
    knockback = 200,
    environment,
    shake = true,
    falloff = true,
  } = opts;

  ctx.particles.explosion(x, y, radius, color, coreColor);
  ctx.audio.play('explosion', 0.85);
  if (shake) ctx.shake.add(0.42);
  if (ctx.time) ctx.time.hitStop(0.045, 0.12);

  let hits = 0;
  for (const t of targets) {
    if (t.dead || t.team === team) continue;
    const d = Math.hypot(t.x - x, t.y - y);
    const reach = radius + t.radius;
    if (d > reach) continue;
    const falloffMul = falloff ? 0.45 + 0.55 * (1 - Math.min(1, d / reach)) : 1;
    const dir = d > 0.001 ? { x: (t.x - x) / d, y: (t.y - y) / d } : { x: 0, y: 0 };
    t.applyDamage(damage * falloffMul, {
      crit: false,
      source: 'explosion',
      dirX: dir.x,
      dirY: dir.y,
      knockback: knockback * falloffMul,
      color: coreColor,
    });
    hits++;
  }

  if (environment) environment.damageInRadius(x, y, radius, damage, ctx);
  ctx.bus.emit(GameEvents.Explosion, { x, y, radius });
  return hits;
}

/** 计算暴击伤害倍率。 */
export const CRIT_MULTIPLIER = 2;

export function applyCrit(base: number, crit: boolean): number {
  return crit ? base * CRIT_MULTIPLIER : base;
}

/** 让受到的伤害对护盾/生命做分配，返回实际扣除量。 */
export function distributeDamage(
  amount: number,
  shield: number,
): { toShield: number; toHp: number; shieldLeft: number } {
  const toShield = Math.min(shield, amount);
  const toHp = Math.max(0, amount - toShield);
  return { toShield, toHp, shieldLeft: shield - toShield };
}
