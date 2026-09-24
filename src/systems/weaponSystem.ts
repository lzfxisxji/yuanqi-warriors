/**
 * 武器击发系统：把"武器定义 + 强化"翻译成实际的弹丸 / 光束效果，
 * 并处理后坐、枪口火焰、抛壳、屏幕震动与音效，保证每种武器的反馈都不同。
 */
import { TAU, angleDelta, clamp, distPointToSegment, normalize } from '../core/math';
import { MELEE_CHARGE_MAX_MUL, MELEE_CHARGE_MIN_HOLD, MELEE_CHARGE_TIME, TILE } from '../data/config';
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
  /**
   * 近战扇形砍击时对**可破坏障碍（木箱）**造成伤害；由场景注入，负责破坏表现与掉落。
   * 参数：玩家坐标、瞄准角、扇形半角(rad)、判定半径(px)、单次伤害。
   */
  damageObstacles?: (x: number, y: number, angle: number, halfArc: number, range: number, damage: number) => void;
  /**
   * 圆形环境伤害（爆炸同款）：用于持续光束之类的"线状/点状"武器破坏木箱。
   * 参数：圆心、半径(px)、单次伤害。木箱不是实体，只能靠这个入口破坏。
   */
  damageEnvironment?: (x: number, y: number, radius: number, damage: number) => void;
  dt: number;
  time: number;
}

const BEAM_AMMO_PER_SECOND = 26;

/**
 * 持续光束的伤害数字节流（秒，需求 33）。
 *
 * 光束每帧都在结算伤害，若每帧弹一个数字，屏幕上会糊成一片。
 * 同一个目标在这个窗口内的伤害会**合并成一个数字**（见 `DamageNumbers.add`），
 * 读起来就是"每 0.25 秒涨一跳"。窗口按真实秒算，与帧率无关。
 */
const BEAM_NUMBER_INTERVAL = 0.25;

let shellAlternator = 0;

/** 根据当前武器状态执行击发（每帧调用一次）。 */
export function updateWeapon(fire: WeaponFireContext, firing: boolean): void {
  const { player, ctx } = fire;
  const w = player.currentWeapon;
  const def = w.def;

  if (player.dead) {
    player.beamActive = false;
    player.meleeCharge = 0; // 死亡即清空蓄力，避免复活/重开时残留一段"免费重击"
    return;
  }

  if (def.kind === 'beam') {
    updateBeam(fire, firing);
    return;
  }

  if (def.kind === 'melee') {
    updateMelee(fire, firing);
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
      ownerTeam: player.team,
    });
    // 需求 33：伤害真的算进去了，就必须让人**看得见**。
    // 训练营的木桩血条恒满（`infiniteHp`），没有浮空数字时玩家只会觉得"这武器没伤害"。
    ctx.numbers.add(t.x, t.y - 26, dmg, crit, def.colors.glow, t, BEAM_NUMBER_INTERVAL);
    if (Math.random() < fire.dt * 9) {
      ctx.particles.hitSparks(t.x, t.y, player.aimAngle, def.colors.glow, 3, 0.6);
    }
  }

  // 需求 34：持续光束也能破坏木箱。
  // `raycastStatic` 在撞到第一块静态遮挡时就停下，而木箱本身也是遮挡（isBlockingTile 含 Crate），
  // 所以命中点 (bx,by) 一定落在木箱边缘。沿此处给一个圆形环境伤害即可破箱——
  // 木箱是瓦片不是实体，只有 `damageEnvironment` / `damageObstacles` 这两个入口能破坏它。
  // 仅在「光束真的撞到遮挡」(hit 非 null) 时才触发：开阔地(命中落空)端点只是空地，无需扫箱。
  if (fire.damageEnvironment && hit) {
    fire.damageEnvironment(bx, by, TILE * 0.8, dps * fire.dt);
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
  // 需求 32：棱镜激光**不做屏幕震动**。
  // 这里原本有一句"每帧" `ctx.shake.add(0.008)`，但 `ScreenShake.update` 是按**真实时间**衰减的
  // （每帧 `dt × 1.7`）。在 219 FPS（截图实测）下加入速率 ≈ 0.008 × 219 = 1.75/s 已超过 1.7/s 的衰减，
  // trauma 于是持续攀升 → 长按一两秒后整屏开始抖；而 60 FPS 下加入 0.48/s 远小于衰减，完全不抖。
  // 也就是"是否震屏取决于帧率"的隐性 bug。持续光束本身不需要震屏，故整条移除。
}

/**
 * 近战类（需求 21 + 需求 30）：一次挥砍 = 一个**扇形判定**。
 *
 * 以瞄准方向为中线、总张角 `def.swingArc`、半径 `def.range` 的扇形内部，
 * 所有敌方目标当帧全部命中（近战天然"穿透"，所以不需要贯穿计数）。
 * 长枪把 swingArc 压到 0.42 rad，于是「中距离直线贯穿」这件事由扇形形状本身表达。
 *
 * 与远程最大的区别：**不产生任何弹丸**，也就不吃 pierce / bounce / spread；
 * 代价是必须贴脸，收益是单次伤害高、必定命中（没有飞行时间，敌人闪不掉）。
 *
 * 蓄力（需求 30）：`firing` 表示攻击键**当前是否被按住**。
 * - 按住 = 积累蓄力（每帧 +dt，封顶 `MELEE_CHARGE_TIME`），这一帧**不挥砍**；
 * - 松开 = 若蓄力 > 0 则释放一次挥砍，伤害 = 原伤害 × (1 + (MAX-1) × ratio)；
 *   按住时间过短（< `MELEE_CHARGE_MIN_HOLD`）视为"点按"，蓄力倍率就是 1×，保持原手感。
 * 这样"点一下打一下"和"按住蓄满再松手打出 2.5 倍重击"两种用法都成立。
 *
 * **攻击范围（需求 31）**：点按轻挥仍是「扇形」；但只要有蓄力（ratio > 0，即按住 ≥ MIN_HOLD），
 * 释放的就是一次 **360° 全向重击**——命中判定不再做任何角度过滤，敌方弹丸拦截（intercept）
 * 与木箱破坏（damageObstacles）也一并覆盖整圈。视觉上 `drawMeleeSwingArc` 会据此画整圈光环。
 *
 * 另外，挥砍的扇形/全向范围内**敌方弹丸（光波）会被直接打掉**（需求 30）：用 `ProjectileSystem.intercept`
 * 把非己方阵营、落在该范围内的弹丸一并清除，并给一点火花反馈。
 */
function updateMelee(fire: WeaponFireContext, firing: boolean): void {
  const { player, ctx } = fire;
  player.beamActive = false;

  if (player.dead) {
    player.meleeCharge = 0;
    return;
  }

  const def = player.currentWeapon.def;
  const mods = player.mods;
  const range = def.range * mods.rangeMul;
  const halfArc = Math.max(0.08, (def.swingArc ?? 1.2) * 0.5);
  const baseAngle = player.aimAngle;
  const baseDamage = def.damage * mods.damageMul;

  // —— 蓄力阶段：按住且能开火时累加，这一帧不挥砍 ——
  if (firing) {
    if (player.canFire()) {
      player.meleeCharge = Math.min(MELEE_CHARGE_TIME, player.meleeCharge + fire.dt);
    }
    return;
  }

  // —— 释放阶段：松开且此前在蓄力，才挥砍 ——
  if (player.meleeCharge <= 0) return;
  const held = player.meleeCharge;
  player.meleeCharge = 0;
  // 极短按压视为点按：不享受蓄力加成
  const ratio = held < MELEE_CHARGE_MIN_HOLD ? 0 : Math.min(1, held / MELEE_CHARGE_TIME);
  const chargeMul = 1 + (MELEE_CHARGE_MAX_MUL - 1) * ratio;
  const damage = baseDamage * chargeMul;
  const charged = ratio >= 1;
  // 需求 31：只要有蓄力（按住 ≥ MIN_HOLD），释放的就是 360° 全向重击，不再做角度过滤。
  const fullCircle = ratio > 0;

  if (!player.canFire()) return; // 理论上蓄力期间 cooldown 不会转好，但兜底防重击穿冷却

  player.consumeShot(1);
  player.startMeleeSwing(meleeSwingDuration(def.fireRate * mods.fireRateMul), fullCircle);

  let hits = 0;
  let critical = false;
  for (const t of fire.targets) {
    if (t.dead || t.team === player.team) continue;
    const dx = t.x - player.x;
    const dy = t.y - player.y;
    const d = Math.hypot(dx, dy);
    if (d > range + t.radius) continue;
    if (!fullCircle) {
      // 目标体积越大越容易"擦到边"：按半径给一点角度宽容，否则打大体型敌人时手感很苛刻。
      const slack = Math.min(0.5, t.radius / Math.max(1, d));
      if (Math.abs(angleDelta(baseAngle, Math.atan2(dy, dx))) > halfArc + slack) continue;
    }

    const n = d > 0.001 ? { x: dx / d, y: dy / d } : { x: Math.cos(baseAngle), y: Math.sin(baseAngle) };
    const crit = Math.random() < clamp(def.crit + mods.critAdd, 0, 0.95);
    critical = critical || crit;
    const dealt = damage * (crit ? 1.6 : 1);
    t.applyDamage(dealt, {
      crit,
      source: 'melee',
      dirX: n.x,
      dirY: n.y,
      knockback: def.knockback * (charged ? 1.4 : 1), // 满蓄力多带一点击退，重击感更强
      color: def.colors.glow,
      ownerTeam: player.team,
    });
    // 需求 33：近战一刀就该看得见一个数字。一次挥砍对同一目标只结算一次，
    // 所以不用传合并键（不会像光束那样每帧刷）。
    ctx.numbers.add(t.x, t.y - 26, dealt, crit, def.colors.glow);
    ctx.particles.hitSparks(t.x, t.y, baseAngle, def.colors.glow, crit ? 9 : 5, crit ? 1.15 : 0.85);
    hits++;
  }

  // 近战同样能劈开挡路的木箱（需求 23）：范围内的可破坏障碍一并受击。
  // 全向重击时把半角设为 π，让障碍破坏也覆盖整圈。
  // 不计入 `hits`，所以"只砍到箱子、没砍到人"时依然走抡空尘效，反馈不会被吞。
  fire.damageObstacles?.(player.x, player.y, baseAngle, fullCircle ? Math.PI : halfArc, range, damage);

  // 需求 30：挥砍范围内打掉敌方光波（弹丸）。非己方阵营 + 落在范围内即清除；
  // 全向重击时把半角设为 π，整圈光波一起清掉。
  fire.projectiles.intercept?.({
    team: player.team,
    x: player.x,
    y: player.y,
    angle: baseAngle,
    halfArc: fullCircle ? Math.PI : halfArc,
    range,
    onHit: (p) => {
      ctx.particles.hitSparks(p.x, p.y, baseAngle, '#ffffff', 6, 1.1);
      ctx.shake.add(0.1);
    },
  });

  // 抡空了也要有反馈：扬一小撮尘，提示"挥过去了但没碰到人"。
  // 全向重击时整圈撒一圈，普通扇形只在弧线前端撒。
  if (hits === 0) {
    const n = fullCircle ? 12 : 3;
    for (let i = 0; i < n; i++) {
      const a = fullCircle ? (i / n) * TAU : baseAngle + (Math.random() - 0.5) * halfArc * 2;
      ctx.particles.spawn({
        kind: 'ember',
        x: player.x + Math.cos(a) * range * 0.9,
        y: player.y + Math.sin(a) * range * 0.9,
        life: 0.2,
        size: 5,
        sizeEnd: 0,
        color: def.colors.glow,
        alpha0: 0.32,
        alpha1: 0,
        drag: 0,
      });
    }
  }

  if (charged) ctx.shake.add(0.25); // 满蓄力重击额外一顿
  ctx.shake.add(def.shakeAmount * (hits > 0 ? 1 + Math.min(0.6, hits * 0.12) : 0.5));
  ctx.audio.play(def.sound, critical || charged ? 1 : 0.9);
}

/**
 * 挥砍动画时长：约占一次挥砍周期的 55%，并夹在 0.28~0.5 秒之间。
 * 太快看不清弧光，太慢会跟不上 `cooldown`（下一次挥砍已经开始、上一次还没收势）。
 */
function meleeSwingDuration(rate: number): number {
  return clamp(0.55 / Math.max(0.2, rate), 0.28, 0.5);
}

export { TAU };
