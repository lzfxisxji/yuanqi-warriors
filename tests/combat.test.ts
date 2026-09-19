import { describe, expect, test } from 'vitest';
import { CRIT_MULTIPLIER, applyCrit, defaultHitOptions, distributeDamage, explode } from '../src/systems/combat';
import type { DamageContext, HitEntity, HitOptions } from '../src/systems/combat';
import { GameEvents, EventBus } from '../src/core/eventbus';
import { AudioSystem } from '../src/systems/audio';
import { DamageNumbers, FlashOverlay, ScreenShake, TimeControl } from '../src/systems/effects';
import { ParticleSystem } from '../src/systems/particles';
import type { DamageResult, Team } from '../src/core/types';
import { canStandAt, moveCircle, separateCircles, steerAroundObstacles } from '../src/systems/collision';
import { Room, doorEntryPoint, generateRoomLayout } from '../src/dungeon/room';
import { ROOM_H, ROOM_W, TILE } from '../src/data/config';
import type { Dir4, RoomType } from '../src/core/types';

function makeContext(): { ctx: DamageContext; bus: EventBus } {
  const bus = new EventBus();
  return {
    bus,
    ctx: {
      particles: new ParticleSystem(),
      bus,
      shake: new ScreenShake(),
      numbers: new DamageNumbers(),
      flash: new FlashOverlay(),
      time: new TimeControl(),
      audio: new AudioSystem(),
    },
  };
}

class Dummy implements HitEntity {
  x: number;
  y: number;
  radius: number;
  hp: number;
  dead = false;
  team: Team;
  taken = 0;
  lastOptions: HitOptions | null = null;

  constructor(x: number, y: number, hp: number, team: Team, radius = 14) {
    this.x = x;
    this.y = y;
    this.hp = hp;
    this.team = team;
    this.radius = radius;
  }

  applyDamage(amount: number, opts: HitOptions): DamageResult {
    this.taken += amount;
    this.lastOptions = opts;
    this.hp = Math.max(0, this.hp - amount);
    if (this.hp <= 0) this.dead = true;
    return { applied: amount, crit: opts.crit, killed: this.dead, blocked: false, dodged: false };
  }
}

describe('伤害结算工具', () => {
  test('distributeDamage 先吃护盾再吃生命', () => {
    expect(distributeDamage(30, 100)).toEqual({ toShield: 30, toHp: 0, shieldLeft: 70 });
    expect(distributeDamage(140, 100)).toEqual({ toShield: 100, toHp: 40, shieldLeft: 0 });
    expect(distributeDamage(20, 0)).toEqual({ toShield: 0, toHp: 20, shieldLeft: 0 });
    expect(distributeDamage(0, 50)).toEqual({ toShield: 0, toHp: 0, shieldLeft: 50 });
  });

  test('applyCrit 按倍率放大伤害', () => {
    expect(applyCrit(10, false)).toBe(10);
    expect(applyCrit(10, true)).toBe(10 * CRIT_MULTIPLIER);
  });

  test('defaultHitOptions 提供完好默认值并可被覆盖', () => {
    const o = defaultHitOptions({ crit: true, knockback: 10 });
    expect(o.crit).toBe(true);
    expect(o.knockback).toBe(10);
    expect(o.source).toBe('bullet');
    expect(o.dirX).toBe(0);
    expect(o.dirY).toBe(0);
  });
});

describe('范围爆炸', () => {
  test('只伤害半径内的敌对阵营目标', () => {
    const { ctx } = makeContext();
    const near = new Dummy(100, 100, 100, 'enemy');
    const far = new Dummy(600, 600, 100, 'enemy');
    const ally = new Dummy(110, 100, 100, 'player');
    const hits = explode({
      x: 100,
      y: 100,
      radius: 120,
      damage: 50,
      team: 'player',
      targets: [near, far, ally],
      ctx,
    });
    expect(hits).toBe(1);
    expect(near.taken).toBeGreaterThan(0);
    expect(far.taken).toBe(0);
    expect(ally.taken).toBe(0);
  });

  test('伤害随距离衰减（中心 > 边缘）', () => {
    const { ctx } = makeContext();
    const center = new Dummy(100, 100, 999, 'enemy');
    const edge = new Dummy(200, 100, 999, 'enemy');
    explode({ x: 100, y: 100, radius: 120, damage: 100, team: 'player', targets: [center, edge], ctx });
    expect(center.taken).toBeGreaterThan(edge.taken);
    expect(edge.taken).toBeGreaterThan(0);
  });

  test('falloff=false 时范围内伤害一致', () => {
    const { ctx } = makeContext();
    const a = new Dummy(100, 100, 999, 'enemy');
    const b = new Dummy(200, 100, 999, 'enemy');
    explode({ x: 100, y: 100, radius: 120, damage: 60, team: 'player', targets: [a, b], ctx, falloff: false });
    expect(a.taken).toBeCloseTo(60, 6);
    expect(b.taken).toBeCloseTo(60, 6);
  });

  test('已死亡目标被忽略，并广播爆炸事件', () => {
    const { ctx, bus } = makeContext();
    const dead = new Dummy(100, 100, 100, 'enemy');
    dead.dead = true;
    let fired = 0;
    bus.on(GameEvents.Explosion, () => {
      fired += 1;
    });
    const hits = explode({ x: 100, y: 100, radius: 150, damage: 40, team: 'player', targets: [dead], ctx });
    expect(hits).toBe(0);
    expect(dead.taken).toBe(0);
    expect(fired).toBe(1);
  });

  test('会把环境伤害回调透传出去', () => {
    const { ctx } = makeContext();
    let envCalls = 0;
    explode({
      x: 10,
      y: 10,
      radius: 80,
      damage: 20,
      team: 'player',
      targets: [],
      ctx,
      environment: {
        damageInRadius: () => {
          envCalls += 1;
        },
      },
    });
    expect(envCalls).toBe(1);
  });
});

describe('碰撞与移动', () => {
  const makeRoom = (doors: Dir4[], type: RoomType = 'combat'): Room => {
    const layout = generateRoomLayout({ doors, roomType: type, seed: 9182 });
    return new Room(0, 0, type, doors, layout);
  };

  test('玩家无法穿出房间边界', () => {
    const room = makeRoom(['n', 's', 'e', 'w']);
    const body = { x: ROOM_W / 2, y: ROOM_H / 2, radius: 15 };
    // 向右猛推，最终会被夹在房间内
    for (let i = 0; i < 200; i++) moveCircle(body, room, 40, 0);
    expect(body.x).toBeLessThanOrEqual(ROOM_W - body.radius + 0.001);
    expect(body.x).toBeGreaterThan(0);
    for (let i = 0; i < 300; i++) moveCircle(body, room, 0, 40);
    expect(body.y).toBeLessThanOrEqual(ROOM_H - body.radius + 0.001);
  });

  test('中央一定可站立（出生点安全）', () => {
    for (const type of ['start', 'combat', 'boss'] as RoomType[]) {
      const room = makeRoom(['n', 's', 'e', 'w'], type);
      expect(canStandAt(room, ROOM_W / 2, ROOM_H / 2, 15)).toBe(true);
      for (const d of ['n', 's', 'e', 'w'] as Dir4[]) {
        const p = doorEntryPoint(d);
        expect(canStandAt(room, p.x, p.y, 15)).toBe(true);
      }
    }
  });

  test('锁门后门口不可站立，解锁后恢复', () => {
    const room = makeRoom(['n']);
    room.lockAllDoors();
    const p = doorEntryPoint('n');
    expect(canStandAt(room, p.x, p.y, 15)).toBe(false);
    room.unlockAllDoors();
    expect(canStandAt(room, p.x, p.y, 15)).toBe(true);
  });

  test('separateCircles 把重叠实体推开', () => {
    const bodies = [
      { x: 100, y: 100, radius: 16, vx: 0, vy: 0 },
      { x: 104, y: 100, radius: 16, vx: 0, vy: 0 },
    ];
    separateCircles(bodies, 0.5);
    const d = Math.hypot(bodies[1]!.x - bodies[0]!.x, bodies[1]!.y - bodies[0]!.y);
    expect(d).toBeGreaterThan(4);
    // 不重叠的实体不应被推动
    const apart = [
      { x: 0, y: 0, radius: 10, vx: 0, vy: 0 },
      { x: 500, y: 500, radius: 10, vx: 0, vy: 0 },
    ];
    separateCircles(apart, 0.5);
    expect(apart[0]!.x).toBe(0);
    expect(apart[1]!.y).toBe(500);
  });

  test('steerAroundObstacles 返回单位方向向量', () => {
    const room = makeRoom(['n', 's']);
    const dir = steerAroundObstacles(room, ROOM_W / 2, ROOM_H / 2, ROOM_W / 2 + 200, ROOM_H / 2, 15);
    const len = Math.hypot(dir.x, dir.y);
    expect(len).toBeGreaterThan(0.1);
    expect(len).toBeLessThanOrEqual(1.4);
  });

  test('沿门方向前进能抵达门洞触发区（门确实是通的）', () => {
    const room = makeRoom(['n', 's', 'e', 'w']);
    const p = doorEntryPoint('s');
    const body = { x: p.x, y: p.y, radius: 15 };
    for (let i = 0; i < 60; i++) moveCircle(body, room, 0, 12);
    // 走到房间下沿，越过 doorRect 内圈即会触发房间切换
    expect(body.y).toBeGreaterThan(ROOM_H - TILE * 3);
    expect(body.y).toBeGreaterThan(p.y);
  });
});
