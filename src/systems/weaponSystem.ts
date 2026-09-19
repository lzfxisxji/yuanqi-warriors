/**
 * 武器击发系统：把"武器定义 + 强化"翻译成实际的弹丸 / 光束效果，
 * 并处理后坐、枪口火焰、抛壳、屏幕震动与音效，保证每种武器的反馈都不同。
 */
import { TAU, clamp, distPointToSegment, normalize } from '../core/math';
import type { Player } from '../entities/player';
import type { ProjectileSystem } from '../entities/projectile';
import type { Boss } from '../entities/boss';
import type { Enemy } from '../entities/enemy';
import type { HitEntity } from './combat';
import type { DamageContext } from './combat';
import type { Room } from '../dungeon/room';

export interface WeaponFireContext {
  player: Player;
  room: Room;
  ctx: DamageContext;
  projectiles: ProjectileSystem;
  /** 所有可被玩家伤害的目标（敌人 + Boss） */
  targets: HitEntity[];
  dt: number;
  time: number;
}

const BEAM_AMMO_PER_SECOND = 26;

let shellAlternator = 0;

/** 根据当前武器状态执行击发（每帧调用一次）。 */
export function updateWeapon(fire: WeaponFireContext, firing: boolean): void {
  const { player, ctx } = fire;
  const w = player.currentWeapon;
  const def = w.def;

  if (player.dead) {
    player.beamActive = false;
    return;
  }

  if (def.kind === 'beam') {
    updateBeam(fire, firing);
    return;
  }

  player.beamActive = false;

  if (!firing) return;
  if (!player.canFire()) return;

  const mods = player.mods;
  const damageMul = mods.damageMul;
  const critChance = clamp(def.crit + mods.critAdd, 0, 0.95);
  const range = def.range * mods.rangeMul;
  const speed = def.bulletSpeed * (1 + (mods.rangeMul - 1) * 0.35);
  const pellets = Math.max(1, def.pellets + mods.multishotAdd);
  const extraSpread = mods.multishotAdd > 0 ? 0.035 * mods.multishotAdd : 0;
  const spread = def.spread + extraSpread;
  const muzzle = player.muzzlePosition();
  const baseAngle = player.aimAngle;

  for (let i = 0; i < pellets; i++) {
    // 多弹丸时均匀铺开，单弹丸时纯随机
    const offset =
      pellets > 1
        ? ((i / (pellets - 1)) - 0.5) * spread * 2 + (Math.random() - 0.5) * spread * 0.45
        : (Math.random() - 0.5) * spread * 2;
    const angle = baseAngle + offset;
    const crit = Math.random() < critChance;
    const damage = def.damage * damageMul;

    if (def.kind === 'grenade') {
      fire.projectiles.spawn({
        kind: 'grenade',
        team: player.team,
        x: muzzle.x,
        y: muzzle.y,
        angle,
        speed,
        damage,
        radius: def.projectileRadius,
        life: range / Math.max(1, speed),
        bounce: def.bounce + player.mods.bounceAdd,
        knockback: def.knockback,
        crit,
        color: def.colors.core,
        glow: def.colors.glow,
        trail: def.colors.trail,
        explosive: def.explosive,
        arc: 26,
        spin: 5,
      });
    } else if (def.kind === 'flame') {
      fire.projectiles.spawn({
        kind: 'flameJet',
        team: player.team,
        x: muzzle.x,
        y: muzzle.y,
        angle,
        speed: speed * (0.7 + Math.random() * 0.6),
        damage,
        radius: def.projectileRadius * (0.7 + Math.random() * 0.6),
        life: range / Math.max(1, speed),
        pierce: def.pierce + player.mods.pierceAdd,
        knockback: def.knockback,
        crit,
        color: def.colors.core,
        glow: def.colors.glow,
        trail: def.colors.trail,
        burn: def.burn,
      });
      ctx.particles.flameJet(muzzle.x, muzzle.y, angle, def.colors.glow, def.spread * 1.6, speed * 0.55);
    } else {
      fire.projectiles.spawn({
        kind: def.shape === 'shell' ? 'shell' : def.shape === 'pellet' ? 'pellet' : 'bolt',
        team: player.team,
        x: muzzle.x,
        y: muzzle.y,
        angle,
        speed,
        damage,
        radius: def.projectileRadius,
        life: range / Math.max(1, speed),
        pierce: def.pierce + player.mods.pierceAdd,
        bounce: def.bounce + player.mods.bounceAdd,
        knockback: def.knockback,
        crit,
        color: def.colors.core,
        glow: def.colors.glow,
        trail: def.colors.trail,
      });
    }
  }

  player.consumeShot(1);
  ctx.particles.muzzleFlash(muzzle.x, muzzle.y, baseAngle, def.muzzleScale, def.colors.core, def.colors.glow);
  if (def.kind === 'bullet' && def.fireRate <= 8) {
    shellAlternator ^= 1;
    const side = shellAlternator ? 1 : -1;
    const perp = baseAngle + Math.PI / 2 * side;
    ctx.particles.shellCasing(
      player.x + Math.cos(perp) * 12,
      player.y + Math.sin(perp) * 12,
      baseAngle,
    );
  }
  ctx.shake.add(def.shakeAmount * (def.pellets > 1 ? 1 + (def.pellets - 1) * 0.05 : 1));
  ctx.audio.play(def.sound, def.kind === 'grenade' ? 1 : 0.9);

  // 自身后坐：重型武器会把玩家往后推
  if (def.recoil > 0.3) {
    player.applyKnockback(-Math.cos(baseAngle), -Math.sin(baseAngle), def.recoil * 118);
  }
}

/** 激光类：持续光束 + 穿透伤害。 */
function updateBeam(fire: WeaponFireContext, firing: boolean): void {
  const { player, ctx, room } = fire;
  const w = player.currentWeapon;
  const def = w.def;
  const canShoot = firing && !player.dead && w.reloadTimer <= 0;

  if (!canShoot || !player.drainAmmoPerSecond(fire.dt, BEAM_AMMO_PER_SECOND)) {
    player.beamActive = false;
    return;
  }

  const muzzle = player.muzzlePosition();
  const range = def.range * player.mods.rangeMul;
  const endX = muzzle.x + Math.cos(player.aimAngle) * range;
  const endY = muzzle.y + Math.sin(player.aimAngle) * range;
  const hit = room.raycastStatic(muzzle.x, muzzle.y, endX, endY, 10);
  const bx = hit ? hit.x : endX;
  const by = hit ? hit.y : endY;

  player.beamActive = true;
  player.beamEndX = bx;
  player.beamEndY = by;
  player.beamWidth = def.beamWidth ?? 8;
  player.beamCore = def.colors.core;
  player.beamGlow = def.colors.glow;

  const dps = (def.beamDps ?? 40) * player.mods.damageMul;
  const critChance = clamp(def.crit + player.mods.critAdd, 0, 0.95);
  const halfWidth = (def.beamWidth ?? 8) * 0.72;

  for (const t of fire.targets) {
    if (t.dead || t.team === player.team) continue;
    const d = distPointToSegment(t.x, t.y, muzzle.x, muzzle.y, bx, by);
    if (d > t.radius + halfWidth) continue;
    const crit = Math.random() < critChance;
    const dmg = dps * fire.dt * (crit ? 1.6 : 1);
    const n = normalize(t.x - muzzle.x, t.y - muzzle.y);
    t.applyDamage(dmg, {
      crit,
      source: 'beam',
      dirX: n.x,
      dirY: n.y,
      knockback: 6,
      color: def.colors.glow,
    });
    if (Math.random() < fire.dt * 9) {
      ctx.particles.hitSparks(t.x, t.y, player.aimAngle, def.colors.glow, 3, 0.6);
    }
  }

  // 光束自身的视觉与反馈
  if (Math.random() < fire.dt * 90) {
    ctx.particles.spawn({
      kind: 'ember',
      x: muzzle.x + Math.cos(player.aimAngle) * Math.random() * range * 0.9,
      y: muzzle.y + Math.sin(player.aimAngle) * Math.random() * range * 0.9,
      life: 0.16,
      size: 4,
      sizeEnd: 0,
      color: def.colors.glow,
      alpha0: 0.7,
      alpha1: 0,
      drag: 0,
    });
  }
  ctx.particles.spawn({
    kind: 'glow',
    x: muzzle.x,
    y: muzzle.y,
    life: 0.07,
    size: 20,
    sizeEnd: 8,
    color: def.colors.glow,
    alpha0: 0.5,
    alpha1: 0,
    drag: 0,
  });
  ctx.audio.play('laser', 0.35);
  ctx.shake.add(0.008);
}

export { TAU };
