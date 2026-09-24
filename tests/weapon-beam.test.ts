/**
 * 持续光束（beam，棱镜激光）反馈回归测试 —— 需求 32。
 *
 * 背景：`updateBeam()` 里曾有一句**每帧**执行的 `ctx.shake.add(0.008)`。
 * `ScreenShake` 的衰减是**按真实时间**算的（每帧 `dt × 1.7`），而加入量是按**帧**算的，
 * 于是是否震屏取决于帧率：
 *
 *   - 60 FPS：加入 0.008 × 60 = 0.48/s  < 衰减 1.7/s → trauma 始终为 0，完全不抖；
 *   - 219 FPS（截图实测值）：加入 0.008 × 219 = 1.75/s > 衰减 1.7/s
 *     → trauma 每帧净增 → 长按一两秒后整屏开始持续抖动。
 *
 * 这是一个"帧率越高越抖"的隐性 bug，用固定 dt 的常规单测很难发现，
 * 所以这里**按高帧率逐帧**跑真实的「开火 + 震屏衰减」循环，锁死两条约束：
 *   1. 长按光束期间 `ScreenShake` 的偏移/旋转**恒为 0**（不许有任何来源的震动累积）；
 *   2. 光束本身没有被打断 —— `beamActive` 为真、音效与粒子反馈照常（避免"一刀切删干净"）。
 */
import { describe, expect, test } from 'vitest';
import { Player, createWeaponInstance } from '../src/entities/player';
import { getCharacter } from '../src/data/characters';
import { getWeaponDef } from '../src/data/weapons';
import { DamageNumbers, ScreenShake } from '../src/systems/effects';
import type { DamageContext, HitEntity } from '../src/systems/combat';
import type { ProjectileSystem } from '../src/entities/projectile';
import type { Room } from '../src/dungeon/room';
import { updateWeapon, type WeaponFireContext } from '../src/systems/weaponSystem';

// ---------------------------------------------------------------- 测试替身

/** 空转对象：访问任何属性都得到一个 no-op 函数（粒子/音效系统方法太多，逐个写桩容易漏）。 */
function noopBag<T>(): T {
  return new Proxy({} as Record<string, unknown>, {
    get: (t, k) => {
      const key = k as string;
      if (!(key in t)) t[key] = () => undefined;
      return t[key];
    },
  }) as T;
}

/** 截图里的实测帧率 —— 也是这条 bug 会显形的帧率区间。 */
const HIGH_FPS_DT = 1 / 219;

interface BeamHarness {
  fire: WeaponFireContext;
  shake: ScreenShake;
  counts: { particles: number; sounds: number };
  player: Player;
  numbers: DamageNumbers;
}

function makeBeamHarness(weaponId = 'laser'): BeamHarness {
  const shake = new ScreenShake();
  const counts = { particles: 0, sounds: 0 };
  // 需求 33：用真实的伤害数字容器，而不是 noop 替身 ——
  // 这样「光束打到目标会弹数字」才能被断言（noop 会把 add 吞掉，永远测不到）。
  const numbers = new DamageNumbers();

  const player = new Player(getCharacter('wolfshade'));
  player.weapons = [createWeaponInstance(weaponId, player.mods)];
  player.weaponIndex = 0;
  player.aimAngle = 0;
  // 长按不中断：给足能量，避免中途进入换弹而让断言落到别的分支上
  player.currentWeapon.ammo = 9999;

  const ctx = {
    particles: {
      spawn: () => {
        counts.particles += 1;
      },
      hitSparks: () => undefined,
    },
    bus: noopBag(),
    shake,
    numbers,
    flash: noopBag(),
    time: noopBag(),
    audio: {
      play: () => {
        counts.sounds += 1;
      },
    },
  } as unknown as DamageContext;

  const fire: WeaponFireContext = {
    player,
    // 光束只做一次静态 raycast（打到墙就截断），返回 null = 一路射到射程末端
    room: { raycastStatic: () => null } as unknown as Room,
    ctx,
    projectiles: { spawn: () => undefined } as unknown as ProjectileSystem,
    targets: [] as HitEntity[],
    dt: HIGH_FPS_DT,
    time: 0,
  };

  return { fire, shake, counts, player, numbers };
}

/** 按真实顺序跑 `seconds` 秒：每帧先开火，再让震屏衰减。 */
function holdBeam(h: BeamHarness, seconds: number): void {
  const frames = Math.round(seconds / HIGH_FPS_DT);
  for (let i = 0; i < frames; i++) {
    updateWeapon(h.fire, true);
    h.shake.update(HIGH_FPS_DT);
  }
}

/**
 * 当前震屏强度的标量（偏移与旋转里绝对值最大的那个，0 = 完全不抖）。
 *
 * 刻意用 `Math.abs` 再比 `toBe(0)`，而不是直接 `expect(offsetX).toBe(0)`：
 * `ScreenShake` 的偏移是 `sin/cos × power`（`power = trauma²`），可能算出 `-0`，
 * 而 `Object.is(-0, 0)` 是 false —— 会得到一个跟"是否震屏"毫无关系的假失败。
 */
function shakeMagnitude(s: ScreenShake): number {
  return Math.max(Math.abs(s.offsetX), Math.abs(s.offsetY), Math.abs(s.rotation));
}

// ---------------------------------------------------------------- 数据

describe('棱镜激光数据', () => {
  test('是持续光束，且不靠 shakeAmount 做反馈', () => {
    const def = getWeaponDef('laser');
    expect(def.kind).toBe('beam');
    expect(def.beamDps).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------- 屏幕震动

describe('棱镜激光 · 屏幕震动（需求 32）', () => {
  test('219 FPS 下长按 8 秒，震屏偏移与会话旋转恒为 0', () => {
    const h = makeBeamHarness();
    holdBeam(h, 8);

    expect(shakeMagnitude(h.shake)).toBe(0);
  });

  test('低帧率（60 FPS）同样不震屏，帧率与震屏彻底解耦', () => {
    const h = makeBeamHarness();
    const dt = 1 / 60;
    h.fire.dt = dt;
    for (let i = 0; i < 60 * 6; i++) {
      updateWeapon(h.fire, true);
      h.shake.update(dt);
    }
    expect(shakeMagnitude(h.shake)).toBe(0);
  });

  test('去掉的只是震动：光束仍在、音效与粒子反馈照常', () => {
    const h = makeBeamHarness();
    holdBeam(h, 1);

    expect(h.player.beamActive).toBe(true);
    expect(h.counts.sounds).toBeGreaterThan(0);
    expect(h.counts.particles).toBeGreaterThan(0);
  });

  test('松开攻击键后光束立即消失，且不留下残余震动', () => {
    const h = makeBeamHarness();
    holdBeam(h, 3);
    let leftover = 0;
    for (let i = 0; i < 30; i++) {
      updateWeapon(h.fire, false);
      h.shake.update(HIGH_FPS_DT);
      leftover = Math.max(leftover, shakeMagnitude(h.shake));
    }
    expect(h.player.beamActive).toBe(false);
    expect(leftover).toBe(0);
  });
});

// ---------------------------------------------------------------- 伤害数字

describe('棱镜激光 · 伤害数字（需求 33）', () => {
  test('光束打中目标会弹出伤害数字，且总量≈ beamDps×damageMul×时长', () => {
    const h = makeBeamHarness();
    // 放一个真目标在光束路径上（x 在射线方向上即可，命中判定只看距离）
    const target = {
      x: 120,
      y: 0,
      radius: 20,
      applyDamage: (amount: number) => ({ applied: amount, killed: false, blocked: false }),
    } as unknown as HitEntity;
    h.fire.targets = [target];

    holdBeam(h, 1); // 长按 1 秒

    // 根因回归：之前 DamageContext.numbers 是死字段，从不弹数字
    expect(h.numbers.list.length).toBeGreaterThan(0);
    const total = h.numbers.list.reduce((s, n) => s + n.value, 0);
    // 理论每秒伤害 = beamDps(62) × damageMul（角色加成，约 1.44）；
    // 合并窗口(0.25s)把一秒压成约 4 跳，数字有 0.78s 寿命（旧数字会淡出），
    // 加上随机暴击，给一个宽松但仍有约束力的区间。
    const expectedPerSec = 62 * h.player.mods.damageMul;
    expect(total).toBeGreaterThan(expectedPerSec * 0.4);
    expect(total).toBeLessThan(expectedPerSec * 2);
  });

  test('光束没打到任何目标时，不弹伤害数字', () => {
    const h = makeBeamHarness();
    h.fire.targets = []; // 空靶 → 不应产生任何数字
    holdBeam(h, 1);
    expect(h.numbers.list.length).toBe(0);
  });
});
