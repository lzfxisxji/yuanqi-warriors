/** 实体基类：位置、速度、击退、受击闪烁等所有角色共享的通用状态。 */
import { TAU, clamp, normalize } from '../core/math';
import type { Team } from '../core/types';

export abstract class Entity {
  x = 0;
  y = 0;
  vx = 0;
  vy = 0;
  /** 击退速度，独立于主动速度衰减 */
  knockVx = 0;
  knockVy = 0;
  radius = 16;
  hp = 1;
  maxHp = 1;
  dead = false;
  team: Team = 'enemy';
  facing = -Math.PI / 2;
  /** 受击闪白剩余时间 */
  hitFlash = 0;
  hitFlashColor = '#ffffff';
  /** 击退抗性 0..1，1 表示几乎不被推动 */
  knockbackResist = 0;
  /** 用于渲染的动画相位 */
  animTime = Math.random() * TAU;

  get alive(): boolean {
    return !this.dead;
  }

  applyKnockback(dirX: number, dirY: number, force: number): void {
    if (force <= 0) return;
    const n = normalize(dirX, dirY);
    const mul = 1 - clamp(this.knockbackResist, 0, 0.95);
    this.knockVx += n.x * force * mul;
    this.knockVy += n.y * force * mul;
  }

  /** 每帧更新通用部分：击退衰减、受击闪烁。 */
  protected updateCommon(dt: number, knockDecay = 7.5): void {
    this.animTime += dt;
    const damp = Math.exp(-knockDecay * dt);
    this.knockVx *= damp;
    this.knockVy *= damp;
    if (Math.abs(this.knockVx) < 1) this.knockVx = 0;
    if (Math.abs(this.knockVy) < 1) this.knockVy = 0;
    if (this.hitFlash > 0) this.hitFlash = Math.max(0, this.hitFlash - dt);
  }

  get moveVel(): { x: number; y: number } {
    return { x: this.vx + this.knockVx, y: this.vy + this.knockVy };
  }

  distanceTo(o: { x: number; y: number }): number {
    return Math.hypot(o.x - this.x, o.y - this.y);
  }
}
