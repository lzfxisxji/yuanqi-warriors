/**
 * 核心玩法场景：把地牢、房间、玩家、敌人、武器、掉落、Boss、UI 全部串起来。
 *
 * 主循环顺序：
 *   输入 → 玩家移动/技能 → 武器击发 → 敌人 AI → 弹丸 → 碰撞与结算 → 房间状态机 → 相机 → 渲染
 */
import { RNG, TAU, angleDelta, clamp, dist, hashString, normalize } from '../core/math';
import { EventBus, GameEvents } from '../core/eventbus';
import type { Input } from '../core/input';
import type { Dir4, RoomType } from '../core/types';
import { isCombatRoom, TEAM_HEROES } from '../core/types';
import {
  BOSS_DEATH_DURATION,
  BOSS_DEATH_EXPLOSION_INTERVAL,
  BOSS_DEATH_SLOWMO,
  DASH_HIT_PAD,
  DOOR_LOCK_DELAY,
  FLOOR_COUNT,
  MAX_PLAYERS,
  MELEE_CHARGE_TIME,
  NET_INPUT_HZ,
  NET_SNAPSHOT_HZ,
  PLAYER_COLORS,
  ROOM_CLEAR_REWARD_DELAY,
  ROOM_COLS,
  ROOM_H,
  ROOM_W,
  TILE,
  Tile,
  TRAINING_DUMMY_ID,
  TRAINING_DUMMY_OFFSET_Y,
  VIEW_H,
  VIEW_W,
} from '../data/config';
import { getCharacter, type CharacterPalette } from '../data/characters';
import { getWeaponDef, rollWeaponId, WEAPONS } from '../data/weapons';
import { UPGRADES, getUpgrade } from '../data/upgrades';
import { buildCombatWaves, buildEliteWaves, SHOP_PRICES, type Wave } from '../data/encounters';
import { EVENTS, type EventEffect, type EventOption } from '../data/events';
import { getEnemyDef } from '../data/enemies';
import { doorEntryPoint, doorRect, generateRoomLayout, DOOR_TRIGGER_DEPTH, Room } from '../dungeon/room';
import { Boss } from '../entities/boss';
import { getBossDefForFloor } from '../data/bosses';
import { Enemy, type EnemyWorld } from '../entities/enemy';
import { Player, createWeaponInstance } from '../entities/player';
import { Pickup, scatterGold, type PickupKind } from '../entities/pickup';
import { ProjectileSystem, type Projectile, type ProjectileKind, type ProjectileSpec } from '../entities/projectile';
import type { DamageContext, HitEntity } from '../systems/combat';
import { separateCircles } from '../systems/collision';
import { DamageNumbers, FlashOverlay, ScreenShake, TimeControl, drawBeam } from '../systems/effects';
import { ParticleSystem } from '../systems/particles';
import type { AudioSystem } from '../systems/audio';
import type { SaveManager } from '../systems/save';
import { RunState, type RunResult, type SavedRoomFlags, type SavedRun } from '../systems/run';
import { updateWeapon } from '../systems/weaponSystem';
import { darken, lighten, drawBoss, drawEnemy, drawPickup, drawPlayer } from '../render/art';
import { drawHud } from '../render/hud';
import { NetClient } from '../net/NetClient';
import { PkMatch, pkIsDraw, pkOutcomeText, type PkEndReason, type PkFighter, type PkOutcome } from '../net/pkMatch';
import type {
  BossNetState,
  EnemyNetState,
  NetMode,
  PeerInfo,
  PickupNetState,
  PlayerInput,
  PlayerNetState,
  ProjectileNetState,
  Snapshot,
} from '../net/protocol';
import { WorldRenderer, type DynamicLight } from '../render/renderer';
import { buildDiscovered } from '../render/minimap';
import {
  buildOverlayButtons,
  createOverlayState,
  drawOverlay,
  type DeathSummary,
  type OverlayState,
  type ShopItem,
} from '../ui/overlays';
import { formatTime, hitTest, type UiButton } from '../ui/widgets';

export interface GameHost {
  renderer: WorldRenderer;
  input: Input;
  audio: AudioSystem;
  save: SaveManager;
  bus: EventBus;
  endRun(result: RunResult): void;
  abandonRun(): void;
  /**
   * 暂停菜单的「保存并返回大厅」：只退场，**不动存档**。
   *
   * 与 `abandonRun` 的区别是全部意义所在 —— 后者会把该角色的存档删掉。
   * 可选：无头测试用的宿主可以不实现，此时该按钮退化为只保存不退出。
   */
  exitToLobby?(): void;
  /** 联机对局结束/掉线后，由场景回调让宿主收尾（关闭连接、回大厅）。 */
  leaveNet?(reason: string): void;
  /**
   * 联机**一局打完**（需求 26）：自动解散并清空房间，但把玩家留在结算界面。
   *
   * 和 `leaveNet` 的区别是全部意义所在 —— 后者会立刻把人拽回大厅，
   * 这里只清房间，结算数据还得让玩家看完。
   * 可选：无头测试用的宿主可以不实现。
   */
  dissolveRoom?(reason: string): void;
}

/** 联机开局参数：由大厅在收到 start 消息后传入。 */
export interface NetOptions {
  client: NetClient;
  /** host 跑权威模拟；client 只上报输入、照快照渲染。 */
  role: 'host' | 'client';
  mode: NetMode;
  /** 房主下发的权威种子（所有人据此生成同一份地牢）。 */
  localPeerId: string;
  /** 4 位房间号（HUD 展示用）。 */
  roomCode: string;
  peers: PeerInfo[];
}

/**
 * 训练营开局参数（需求 29）。
 *
 * 训练营是一个**孤立的练习场**：一间封闭房间 + 一个无限血木桩，
 * 角色与武器都由玩家在训练营界面里任选（不受解锁限制）。
 * 它不进地牢、不存档、不计战绩 —— 这些差异全部由 `GameplayScene` 里的
 * `this.training` 分支处理，而不是另写一个场景。
 */
export interface TrainingOptions {
  /** 训练营里使用的武器 id（12 把任选，不看是否已发现）。 */
  weaponId: string;
}

interface TransitionState {
  stage: 0 | 1;
  t: number;
  dir: Dir4;
  targetKey: string;
}

type Mode = 'play' | 'overlay' | 'transition';

const TRANSITION_HALF = 0.26;

/** 单机自动存档间隔（秒）。进新房间时也会立刻存一次。 */
const AUTOSAVE_INTERVAL = 4;

export class GameplayScene {
  private host: GameHost;
  private run: RunState;
  private rng: RNG;

  readonly particles = new ParticleSystem();
  readonly projectiles = new ProjectileSystem();
  readonly shake = new ScreenShake();
  readonly numbers = new DamageNumbers();
  readonly flash = new FlashOverlay();
  readonly time = new TimeControl();
  private bus: EventBus;
  private damageCtx: DamageContext;

  private rooms = new Map<string, Room>();
  private roomPickups = new Map<string, Pickup[]>();
  private roomShopItems = new Map<string, ShopItem[]>();
  private currentPickups: Pickup[] = [];
  private room!: Room;
  private enemies: Enemy[] = [];
  private boss: Boss | null = null;
  private waves: Wave[] = [];
  private waveIndex = 0;
  private waveTimer = 0;
  private clearTimer = 0;
  private contactTimers = new Map<Enemy, number>();
  private bossContactTimer = 0;
  private pendingUpgradeChoices = 0;
  private mode: Mode = 'play';
  private transition: TransitionState | null = null;
  private overlay: OverlayState = createOverlayState();
  private overlayButtons: UiButton[] = [];
  private hoverId: string | null = null;
  private world!: EnemyWorld;
  private dynamicLights: DynamicLight[] = [];
  private interactTarget: Pickup | null = null;
  private interactHint: string | null = null;
  private discovered = new Set<string>();
  private fps = 0;
  private cause = '未知力量';
  private ended = false;
  /**
   * 进门后的短暂冷却。
   * 入场落点已经在触发区之外（见 DOOR_TRIGGER_DEPTH），这个冷却只是额外保险：
   * 万一落点因为几何调整又落回触发区，也不会在同一瞬间与上一间房来回弹跳。
   */
  private doorCooldown = 0;
  /**
   * 首领死亡演出剩余时间（秒，真实时间）。
   * >0 表示遗体还在爆炸，此时还没有传送门；归零时才刷传送门并撤掉遗体。
   */
  private bossDeathTimer = 0;
  private bossDeathExplosionTimer = 0;
  /** 玩家已确认「战前补给站」，等覆盖层全部关掉后立刻开打 */
  private pendingBossStart = false;
  /** 上一帧的 dt，供渲染层做与帧率无关的动画（如火光抖动） */
  private lastDt = 1 / 60;
  /** 续玩时恢复的房间级交互标志（宝箱已开 / 事件已触发 / 补给站已弹过） */
  private readonly savedRoomFlags: Record<string, SavedRoomFlags> = {};
  /** 自动存档节流：每 AUTOSAVE_INTERVAL 秒落一次盘 */
  private autosaveAccum = 0;

  // ------------------------------------------------------------- 训练营状态
  /** 本局是不是训练营（封闭单间 + 木桩，不存档、不计战绩、不出怪）。 */
  private readonly training: boolean;
  /**
   * 冲刺技能（蛮牛冲撞 / 重拳突进）**本帧已经撞到过**的目标。
   *
   * 一次冲刺只有 0.2~0.36 秒，但每帧都会做碰撞检测 —— 没有这个集合，
   * 一个敌人在一次冲刺里会被反复结算十几下（42 伤害 × 十几下 = 秒杀全场）。
   * 键是玩家：每次冲刺开始时（`dashTimer` 从 0 变正）清空对应的集合。
   */
  private readonly dashHits = new Map<Player, Set<HitEntity>>();

  /** 训练营实时读数（需求 33）：木桩没有血条，玩家需要一个"看得见伤害"的数字。
   *  - `trainingDamage`：木桩累计承受的总伤害（monotonic，直接读 dummy.damageTaken）
   *  - `trainingTime`：训练有效时长（秒，真实时间；暂停/覆盖层不计）—— 用来算全程 DPS
   *  两者都随场景创建归零，训练营每次进入都是一把新的。 */
  private trainingDamage = 0;
  private trainingTime = 0;

  // ------------------------------------------------------------- 联机状态
  /** 联网客户端（单人模式为 null，所有联机分支都不会触发）。 */
  private net: NetClient | null = null;
  private netRole: 'local' | 'host' | 'client' = 'local';
  private netMode: NetMode = 'coop';
  private localPeerId = '';
  private peers: PeerInfo[] = [];
  private roomCode = '';
  /** 一局结束后房间是否已经解散过（防止 finishRun 被重复触发时重复解散）。 */
  private netRoomDissolved = false;
  /** 本地玩家恒为 allPlayers[0]（即 run.player），其余为远端玩家。该数组引用保持稳定。 */
  private readonly allPlayers: Player[] = [];
  private readonly playerByPeer = new Map<string, Player>();
  private readonly peerByPlayer = new Map<Player, string>();
  /** 房主侧：各远端玩家最近一次上报的输入。 */
  private readonly inputBuffer = new Map<string, PlayerInput>();
  private readonly lastRemoteSkill = new Map<string, boolean>();
  private readonly lastRemoteInteract = new Map<string, boolean>();
  /** 房主广播快照 / 客户端上报输入的节流累计。 */
  private netSnapshotAccum = 0;
  private netInputAccum = 0;
  private inputSeq = 0;
  /** 客户端：最近一次收到的快照。 */
  private lastSnapshot: Snapshot | null = null;
  private netTick = 0;
  /** 客户端：按 id 缓存的远端玩家对象（复用美术）。 */
  private readonly netPlayersById = new Map<string, Player>();
  private netOverSent = false;
  private winnerId: string | null = null;
  /**
   * 自由混战裁判（纯逻辑，见 `src/net/pkMatch.ts`）。
   *
   * 房主：每帧 `update()` 推进；客户端：只 `mirror()` 房主快照里的阶段与倒计时。
   * 规则（等齐人 → 开赛倒计时 → 3 分钟 / 10 人头 / 最后幸存者）全在这个类里，
   * 场景只负责把 Player 拍平成 PkFighter 和把结果画到结算面板上。
   */
  private readonly pk = new PkMatch();
  /** 本局的 PK 结果（结算抬头要靠它区分"平局"与"失败"）。 */
  private pkOutcome: PkOutcome | null = null;
  /** 已经有人点过「再来一次」，正在等房主开下一局。 */
  private rematchWaiting = false;
  private netBanner = '';
  private netBannerTimer = 0;
  /** 客户端：跨帧累积的边沿输入（避免 30Hz 上报丢按键）。 */
  private readonly pendingInput = { skill: false, reload: false, interact: false, swap: -1 };
  private readonly snapProjectileBuf: Projectile[] = [];
  private netEnemyIdCounter = 0;

  /**
   * @param resume 续玩存档（单机）。传入时会按同一种子重建地牢、恢复金币/强化/武器/生命，
   *               并把玩家放回存档所在房间；房间内的敌人与掉落不恢复（重新开打）。
   */
  constructor(
    host: GameHost,
    characterId: string,
    seed: number,
    net?: NetOptions,
    resume?: SavedRun | null,
    training?: TrainingOptions | null,
  ) {
    this.host = host;
    this.bus = host.bus;
    this.rng = new RNG((seed ^ 0x5bf03635) >>> 0);
    this.training = !!training;
    this.run = new RunState(getCharacter(characterId), seed);
    if (resume) {
      for (const [key, flags] of Object.entries(resume.rooms)) this.savedRoomFlags[key] = flags;
      this.run.restoreRun(resume);
    }
    if (training) this.setupTraining(training);
    this.allPlayers.push(this.run.player);
    this.damageCtx = {
      particles: this.particles,
      bus: this.bus,
      shake: this.shake,
      numbers: this.numbers,
      flash: this.flash,
      time: this.time,
      audio: host.audio,
    };
    this.numbers.enabled = host.save.data.settings.showDamageNumbers;
    const entryKey = this.run.currentRoomKey;
    const startRoom = this.getRoom(entryKey);
    this.world = {
      players: this.allPlayers,
      focusAt: (x: number, y: number) => this.focusAt(x, y),
      room: startRoom,
      ctx: this.damageCtx,
      rng: this.rng,
      floor: this.run.floor,
      spawnProjectile: (spec: ProjectileSpec) => this.projectiles.spawn(spec),
      spawnMinion: (defId: string, x: number, y: number) => this.spawnMinion(defId, x, y),
      enemies: this.enemies,
    };
    this.room = startRoom;
    if (net) this.setupNet(net);
    this.enterRoom(entryKey, null);
    host.audio.setMusicIntensity(0);
  }

  get state(): RunState {
    return this.run;
  }

  get currentRoom(): Room {
    return this.room;
  }

  get currentBoss(): Boss | null {
    return this.boss;
  }

  /** 当前房间存活的敌人数量（HUD 调试 / 自动化冒烟测试用）。 */
  get enemyCount(): number {
    return this.enemies.length;
  }

  /** 本局是否是训练营（自动化测试用）。 */
  get isTraining(): boolean {
    return this.training;
  }

  /** 训练木桩（不存在时返回 null；自动化测试用）。 */
  get trainingDummy(): Enemy | null {
    return this.enemies.find((e) => e.def.infiniteHp === true) ?? null;
  }

  /** 当前房间是否已经完成清场。 */
  get roomCleared(): boolean {
    return this.node.cleared;
  }

  /** 当前房间的掉落物（只读快照），供 HUD 与自动化测试观察。 */
  get dropList(): readonly Pickup[] {
    return this.currentPickups;
  }

  /** 当前覆盖层模式（自动化测试用）。 */
  get overlayMode(): OverlayState['mode'] {
    return this.overlay.mode;
  }

  /**
   * 当前覆盖层的按钮 id（自动化测试用）。
   *
   * 光有 `overlayMode` 不够：暂停面板的「保存进度 / 保存并返回大厅 / 放弃远征」
   * 都是同一个 mode 下的不同按钮，测试要能分辨面板上到底挂了哪几个出口。
   */
  get overlayButtonIds(): string[] {
    return this.overlayButtons.map((b) => b.id);
  }

  /** 当前房间是否已经有可用的传送门。 */
  get portalReady(): boolean {
    return this.currentPickups.some((p) => p.kind === 'portal' && !p.collected);
  }

  /**
   * 是否隐藏系统鼠标光标（隐藏时改用自绘准星）。
   * 大厅与各种覆盖层（暂停 / 商店 / 强化）用系统光标点按钮更直观，
   * 只有真正在操作角色时才切成准星。
   */
  get hidesSystemCursor(): boolean {
    if (this.host.save.data.settings.showSystemCursor) return false;
    return this.overlay.mode === 'none';
  }

  setFps(v: number): void {
    this.fps = v;
  }

  private get pickups(): Pickup[] {
    return this.currentPickups;
  }

  // ------------------------------------------------------------- 训练营

  /**
   * 训练营的开局准备（需求 29）。必须在 `getRoom()` 之前调用 —— 它改的是
   * 出生房间的**门与邻居**，而房间布局是按门现生成的。
   *
   * 三件事：
   *  1. 把出生房间的四个门和邻居全部拿掉 → 一间**封闭**的练习场。
   *     （不是"锁门"：锁门会挂着「消灭所有敌人」的目标，而且木桩永远打不死、
   *       房间永远清不了，玩家会被永久关在门里。）
   *  2. 房间类型改成 `start`（非战斗房）→ 不进波次、不锁门、不清场判定。
   *  3. 换武器：玩家选的武器直接替换掉角色的初始武器，并**重算弹匣**。
   */
  private setupTraining(opts: TrainingOptions): void {
    const node = this.run.plan.nodes.get(this.run.currentRoomKey);
    if (node) {
      node.doors = [];
      node.neighbors = {};
      node.type = 'start';
      node.cleared = true;
    }
    const player = this.run.player;
    player.weapons = [createWeaponInstance(opts.weaponId, player.mods)];
    player.weaponIndex = 0;
  }

  /** 在房间正中偏上放一个无限生命、无法移动的木桩。 */
  private spawnTrainingDummy(): void {
    const x = ROOM_W / 2;
    const y = clamp(ROOM_H / 2 + TRAINING_DUMMY_OFFSET_Y, 70, ROOM_H - 70);
    const def = getEnemyDef(TRAINING_DUMMY_ID);
    const e = new Enemy(def, x, y, this.run.floor);
    e.spawnTimer = 0;
    this.enemies.push(e);
    this.particles.spawn({
      kind: 'ring',
      x,
      y,
      life: 0.4,
      size: 8,
      sizeEnd: def.radius * 3.6,
      color: def.palette.glow,
      alpha0: 0.85,
      alpha1: 0,
      drag: 0,
    });
  }

  // ------------------------------------------------------------- 房间管理

  private getRoom(key: string): Room {
    let room = this.rooms.get(key);
    if (!room) {
      const node = this.run.plan.nodes.get(key);
      if (!node) throw new Error(`不存在的房间: ${key}`);
      const layout = generateRoomLayout({
        doors: node.doors,
        roomType: node.type,
        seed: (hashString(key) ^ this.run.seedForFloor(this.run.floor)) >>> 0,
      });
      room = new Room(node.gx, node.gy, node.type, node.doors, layout);
      // 续玩存档：把「宝箱已开 / 事件已触发 / 补给站已弹过」还原回来，避免重开刷奖励
      const flags = this.savedRoomFlags[key];
      if (flags) {
        room.rewardDropped = flags.rewardDropped === true;
        room.interacted = flags.interacted === true;
        room.prepShown = flags.prepShown === true;
      }
      this.rooms.set(key, room);
    }
    return room;
  }

  private get node() {
    return this.run.plan.nodes.get(this.run.currentRoomKey)!;
  }

  private pickupList(key: string): Pickup[] {
    let list = this.roomPickups.get(key);
    if (!list) {
      list = [];
      this.roomPickups.set(key, list);
    }
    return list;
  }

  /**
   * 把当前远征进度写进 localStorage（**只有单机存**：
   * 联机局的进度属于房间，存档会误导玩家以为能续玩）。
   * 触发点：进入新房间、定时心跳、打开暂停菜单、暂停菜单里的「保存进度」。
   *
   * 返回是否真的写了盘 —— 调用方（暂停面板那行状态字）要如实告诉玩家，
   * 不能出现"显示已保存、其实联机局没存"这种骗人的反馈。
   */
  private persistRun(): boolean {
    // 训练营不写盘：它是练习场不是远征，占一个存档位只会让「继续远征」变味。
    if (this.training) return false;
    if (this.isMultiplayer() || this.ended || this.run.player.dead) return false;
    this.host.save.setRun(this.run.snapshotRun(this.collectRoomFlags()));
    return true;
  }

  /**
   * 存档 + 刷新暂停面板上的「已保存 · 第 N 层 · …」那行字。
   *
   * 存档是全自动的（进房间 / 每 4 秒 / 按 Esc 都会落盘），但玩家看不见就等于没有。
   * 所以每次打开暂停菜单、每次点「保存进度」，都用**真实的落盘结果**回填这一行。
   */
  private saveWithNotice(): boolean {
    const ok = this.persistRun();
    if (ok) {
      this.overlay.saveNotice = `已保存 · 第 ${this.run.floor} 层 · ${formatTime(this.run.timeSec)} · 击杀 ${this.run.stats.kills} · 金币 ${this.run.gold}`;
    } else {
      this.overlay.saveNotice = this.isMultiplayer() ? '联机局的进度由房间持有，不写入本地存档' : '当前状态无法保存';
    }
    return ok;
  }

  /** 收集各房间的交互标志（宝箱已开 / 事件已触发 / 补给站已弹过），供存档使用。 */
  private collectRoomFlags(): Record<string, SavedRoomFlags> {
    const out: Record<string, SavedRoomFlags> = {};
    for (const [key, room] of this.rooms) {
      if (!room.rewardDropped && !room.interacted && !room.prepShown) continue;
      out[key] = {
        rewardDropped: room.rewardDropped,
        interacted: room.interacted,
        prepShown: room.prepShown,
      };
    }
    return out;
  }

  private enterRoom(key: string, fromDir: Dir4 | null): void {
    const node = this.run.plan.nodes.get(key);
    if (!node) return;
    const room = this.getRoom(key);
    this.room = room;
    this.world.room = room;
    this.world.floor = this.run.floor;
    this.run.currentRoomKey = key;
    node.visited = true;
    this.run.visited.add(key);
    this.discovered = buildDiscovered(this.run.plan, this.run.visited);
    this.currentPickups = this.pickupList(key);

    const player = this.run.player;
    if (fromDir) {
      const p = doorEntryPoint(fromDir);
      player.x = p.x;
      player.y = p.y;
    } else {
      player.x = ROOM_W / 2;
      player.y = ROOM_H / 2;
    }
    player.vx = 0;
    player.vy = 0;
    player.knockVx = 0;
    player.knockVy = 0;
    player.beamActive = false;
    // 联机：其余玩家跟随进门 / 换层，围绕落点散开。
    // 自由混战例外：对手不能贴脸出生（44px 就一个格子，落地即互射），
    // 拉开到半个场地之外 —— 这也算"场景重置"的一部分（需求 28）。
    if (this.netRole !== 'local' && this.allPlayers.length > 1) {
      const n = Math.max(1, this.allPlayers.length - 1);
      const spread = this.netMode === 'pk' ? 260 : 44;
      let i = 0;
      for (const rp of this.allPlayers) {
        if (rp === player) continue;
        const a = (i / n) * TAU - Math.PI / 2;
        rp.x = clamp(player.x + Math.cos(a) * spread, 60, ROOM_W - 60);
        rp.y = clamp(player.y + Math.sin(a) * spread, 60, ROOM_H - 60);
        rp.vx = 0;
        rp.vy = 0;
        rp.knockVx = 0;
        rp.knockVy = 0;
        rp.beamActive = false;
        i++;
      }
    }
    this.host.renderer.snapCamera(player.x, player.y);

    // 落点就在门口：给一小段冷却，避免刚进门就被判定为"又穿了一次门"
    this.doorCooldown = 0.25;

    this.enemies.length = 0;
    this.projectiles.clear();
    this.particles.clear();
    this.numbers.clear();
    this.contactTimers.clear();
    this.boss = null;
    this.bossContactTimer = 0;
    this.bossDeathTimer = 0;
    this.bossDeathExplosionTimer = 0;
    this.waves = [];
    this.waveIndex = 0;
    this.clearTimer = 0;
    this.interactTarget = null;
    this.interactHint = null;
    this.shake.reset();
    this.time.reset();

    if (!node.cleared && isCombatRoom(node.type)) {
      room.lockAllDoors();
      this.host.audio.play('doorLock', 0.9);
      this.particles.shockwave(player.x, player.y, 260, '#ff9a6a', 0.5);
      this.shake.add(0.22);
      if (node.type === 'boss') {
        // 首领房：先把门关上，但**不立刻开打** ——
        // 弹出「战前补给站」，玩家确认整备完毕后才真的唤醒首领。
        // 联机模式跳过补给站（多人各自购物会互不同步），直接开打。
        if (this.isMultiplayer()) {
          room.prepShown = true;
          this.startBossRoom();
        } else if (room.prepShown) {
          this.startBossRoom();
        } else {
          room.prepShown = true;
          this.openPrepShop();
        }
      } else {
        this.waves = node.type === 'elite' ? buildEliteWaves(this.run.rng, this.run.floor) : buildCombatWaves(this.run.rng, this.run.floor);
        this.waveTimer = DOOR_LOCK_DELAY;
      }
    } else {
      room.unlockAllDoors();
    }

    // 训练营（需求 29）：整间房只有木桩，没有波次、没有首领、没有事件，
    // 也**不落盘**（`persistRun` 对训练局直接返回 false）—— 训练营不该占存档位。
    if (this.training) {
      this.spawnTrainingDummy();
      return;
    }

    if (node.type === 'shop' && !this.isMultiplayer()) {
      let items = this.roomShopItems.get(key);
      if (!items) {
        items = this.makeShopItems();
        this.roomShopItems.set(key, items);
      }
      this.overlay.shopItems = items;
      this.openOverlay('shop');
    }
    if (node.type === 'event' && !room.interacted && !this.isMultiplayer()) {
      room.interacted = true;
      this.openEvent();
    }
    if (node.type === 'treasure' && !room.rewardDropped) {
      room.rewardDropped = true;
      this.spawnChest();
    }
    // 首领房重进：已击破但场上没有传送门（例如演出被中途打断），补一个回来
    if (node.type === 'boss' && node.cleared && !this.pickups.some((p) => p.kind === 'portal')) {
      room.rewardDropped = true;
      this.spawnPortal();
    }
    // 每次进房都是一个干净的存档点（房间内的敌人不会进档，续玩时这间重打）
    this.persistRun();
  }

  private spawnWave(): void {
    const wave = this.waves[this.waveIndex];
    if (!wave) return;
    this.waveIndex += 1;
    const used = new Set<number>();
    const player = this.run.player;
    let count = 0;
    for (const group of wave.groups) {
      for (let i = 0; i < group.count; i++) {
        const spot = this.room.pickSpawnPoint(player.x, player.y, 210, this.run.rng, used);
        if (!spot) continue;
        this.spawnMinion(group.id, spot.x, spot.y);
        count++;
      }
    }
    if (count > 0) {
      this.particles.shockwave(player.x, player.y, 320, '#ff7a5a', 0.4);
      this.host.audio.play('summon', 0.7);
    }
  }

  private spawnMinion(defId: string, x: number, y: number): void {
    const def = getEnemyDef(defId);
    const e = new Enemy(def, x, y, this.run.floor);
    e.netId = ++this.netEnemyIdCounter;
    this.enemies.push(e);
    this.particles.spawn({
      kind: 'ring',
      x,
      y,
      life: 0.34,
      size: 6,
      sizeEnd: def.radius * 3,
      color: def.palette.glow,
      alpha0: 0.8,
      alpha1: 0,
      drag: 0,
    });
  }

  private startBossRoom(): void {
    const def = getBossDefForFloor(this.run.floor);
    this.boss = new Boss(ROOM_W / 2, ROOM_H / 2 - 60, def);
    this.host.audio.play('bossRoar', 1);
    this.host.audio.setMusicIntensity(1);
    this.shake.add(0.55);
    this.particles.shockwave(ROOM_W / 2, ROOM_H / 2, 420, '#ff6a3c', 0.9);
    this.flash.trigger('255,90,60', 0.3, 3);
  }

  /**
   * 首领房入口的「战前补给站」。
   * 门已经关上，但首领还没醒：玩家可以先花钱整备（回血 / 扩容弹匣），
   * 确认之后再点「进入首领房」正式开打。
   */
  private openPrepShop(): void {
    this.overlay.prepItems = this.makePrepItems();
    this.openOverlay('preboss');
    this.host.audio.play('door', 0.7);
  }

  private makePrepItems(): ShopItem[] {
    const player = this.run.player;
    const healAmount = Math.max(20, Math.round(player.maxHp * 0.5));
    const magStacks = this.run.upgrades.find((u) => u.id === 'mag')?.stacks ?? 0;
    const magMax = getUpgrade('mag')?.maxStacks ?? 3;
    const magFull = magStacks >= magMax;
    return [
      {
        kind: 'healHalf',
        price: SHOP_PRICES.prepHeal,
        label: '战地急救',
        desc: `立即回复一半生命（约 ${healAmount} 点）`,
        sold: false,
      },
      {
        kind: 'magPlus',
        price: SHOP_PRICES.prepMag,
        label: '弹匣扩容',
        desc: '本轮永久提升弹匣容量，并立刻把弹匣装满',
        sold: magFull,
        note: `已达上限 Lv.${magStacks}/${magMax}`,
      },
      {
        kind: 'ammo',
        price: SHOP_PRICES.prepAmmo,
        label: '弹药补给',
        desc: '两把武器立刻装满弹药',
        sold: false,
      },
      {
        kind: 'shield',
        price: SHOP_PRICES.prepShield,
        label: '护盾电池',
        desc: '护盾回满，并永久提升 15 点护盾上限',
        sold: false,
      },
    ];
  }

  // ------------------------------------------------------------- 更新

  update(dtRaw: number): void {
    const dt = dtRaw * this.time.timeScale;
    this.lastDt = dtRaw;
    this.time.update(dtRaw);
    this.shake.update(dtRaw);
    this.flash.update(dtRaw);
    const settings = this.host.save.data.settings;
    this.shake.scale = settings.screenShake;

    if (this.mode === 'overlay') {
      this.particles.update(dtRaw * 0.35);
      this.numbers.update(dtRaw);
      // 覆盖层里的 Esc 交给统一入口（否则真机上按 Esc 关不掉暂停面板）
      if (this.host.input.wasPressed('Escape')) this.handleEscape();
      this.updateOverlayInput();
      return;
    }

    // 联机客户端：不做本地模拟，只上报输入 + 播放服务端快照
    if (this.netRole === 'client') {
      this.updateClient(dtRaw);
      return;
    }

    if (this.mode === 'transition' && this.transition) {
      this.updateTransition(dtRaw);
      this.particles.update(dt);
      this.updateAim();
      return;
    }

    if (this.ended) return;

    this.run.timeSec += dtRaw;
    const player = this.run.player;

    this.updateAim();
    this.handleGameplayKeys();

    player.updateTimers(dt);
    player.updateMovement(dt, player.dead ? { x: 0, y: 0 } : this.host.input.moveVector(), this.room);

    const firing = this.host.input.pointer.down && !player.dead;
    updateWeapon(
      {
        player,
        room: this.room,
        ctx: this.damageCtx,
        projectiles: this.projectiles,
        targets: this.allTargets(),
        damageObstacles: (ox, oy, oa, oh, org, od) => this.damageObstacles(ox, oy, oa, oh, org, od),
        damageEnvironment: (ex, ey, er, ed) => this.damageEnvironment(ex, ey, er, ed),
        dt,
        time: this.run.timeSec,
      },
      firing,
    );

    // 房主：用各远端玩家上报的输入驱动他们（与本地玩家同一帧、同一 dt）
    if (this.netRole === 'host') {
      for (let i = 1; i < this.allPlayers.length; i++) this.stepRemotePlayer(this.allPlayers[i]!, dt);
    }

    for (const e of this.enemies) e.update(dt, this.world);
    if (this.boss) this.boss.update(dt, this.world);
    separateCircles(this.enemies, 0.45);

    this.projectiles.update(dt, {
      room: this.room,
      ctx: this.damageCtx,
      targets: this.allTargets(),
      damageEnvironment: (x, y, r, dmg) => this.damageEnvironment(x, y, r, dmg),
      spawnBurn: (target, dps, duration) => {
        if (target instanceof Enemy) target.applyBurn(dps, duration);
      },
    });

    this.updateDashDamage();
    this.resolveContactDamage(dt);
    this.updateEnemyDeaths();
    this.updatePickups(dt);
    this.checkRoomClear(dt);
    this.checkDoors(dtRaw);
    this.updateInteractTarget();
    // 首领死亡演出用真实时间推进：演出期间开了慢动作，
    // 若沿用缩放后的 dt，"1 秒"会被拉长到 2.5 秒。
    this.updateBossSequence(dtRaw);
    this.checkPlayerDeath();
    this.checkNetEnd();
    if (this.netMode === 'pk') this.updatePkMatch(dtRaw);

    this.particles.update(dt);
    this.numbers.update(dt);
    this.updateDynamicLights();

    // 需求 33：训练营木桩没有血条，把累计伤害/DPS 实时喂给顶部横幅，
    // 让"打没打到伤害"一眼可见（否则玩家只看到恒满的木桩血条，以为没伤害）。
    if (this.training) {
      const dummy = this.trainingDummy;
      if (dummy) this.trainingDamage = dummy.damageTaken;
      this.trainingTime += dtRaw;
    }

    this.host.renderer.followPlayer(player.x, player.y, player.aimAngle, this.room, dtRaw);
    this.host.audio.updateMusic(dtRaw);
    if (this.netRole === 'host') this.updateHostNet(dtRaw);

    // 自动存档心跳：定时把进度落盘，避免强关页面丢掉几分钟
    this.autosaveAccum += dtRaw;
    if (this.autosaveAccum >= AUTOSAVE_INTERVAL) {
      this.autosaveAccum = 0;
      this.persistRun();
    }
  }

  private updateAim(): void {
    const player = this.run.player;
    const pointer = this.host.input.pointer;
    const cam = this.host.renderer.camera;
    const worldX = pointer.sx - VIEW_W / 2 + cam.x;
    const worldY = pointer.sy - VIEW_H / 2 + cam.y;
    player.aimAngle = Math.atan2(worldY - player.y, worldX - player.x);
  }

  private handleGameplayKeys(): void {
    const input = this.host.input;
    const player = this.run.player;
    if (input.wasPressed('Escape')) {
      // 暂停前先落一次盘（不少人是在暂停界面里直接关掉页面的），
      // 并把这一次落盘的结果写进面板 —— 玩家按 Esc 就能看见"存了"。
      this.saveWithNotice();
      this.openOverlay('pause');
      return;
    }
    if (player.dead) return;
    if (input.wasPressed('Space')) {
      if (player.useSkill()) {
        this.host.audio.play('skill', 0.9);
        const kind = player.def.skill.kind;
        if (kind === 'dash') {
          this.host.audio.play('dash', 0.8);
          this.particles.dust(player.x, player.y, 9);
          this.shake.add(0.12);
        } else if (kind === 'barrier') {
          this.particles.shockwave(player.x, player.y, 150, '#7ef2c0', 0.45);
        } else {
          this.particles.shockwave(player.x, player.y, 160, '#ffd070', 0.45);
        }
        this.bus.emit(GameEvents.Skill, { kind });
      }
    }
    if (input.wasPressed('KeyR')) {
      player.startReload();
      this.host.audio.play('reload', 0.7);
    }
    if (input.wasPressed('Digit1')) this.trySwap(0);
    if (input.wasPressed('Digit2')) this.trySwap(1);
    if (input.wasPressed('KeyE')) this.interact();
  }

  private trySwap(index: number): void {
    if (this.run.player.swapWeapon(index)) {
      this.host.audio.play('reload', 0.5);
      this.particles.dust(this.run.player.x, this.run.player.y, 4);
    }
  }

  /** 所有可能被伤害的目标（子弹 / 爆炸 / 光束统一从这里取，按阵营过滤）。 */
  private allTargets(): HitEntity[] {
    const out: HitEntity[] = [];
    for (const e of this.enemies) out.push(e as unknown as HitEntity);
    if (this.boss && !this.boss.dead) out.push(this.boss as unknown as HitEntity);
    for (const p of this.allPlayers) out.push(p as unknown as HitEntity);
    return out;
  }

  /**
   * 冲刺技能的撞击结算（需求 29）。
   *
   * 修的是一个"技能描述与实现不符"的老毛病：「蛮牛冲撞」的描述写着
   * 「撞到的敌人受到 42 点伤害并被击退」，但 `Player.useSkill` 的 dash 分支
   * 只把玩家推了出去，**从来没有对敌人做过任何判定** —— 撞上去一点反馈都没有。
   *
   * 判定方式与近战一致（圆形接触 + 当帧一次性结算），差别只在：
   *   - 每帧检测的是玩家**当前位置**的重叠，所以冲刺过程本身就会扫过一条线；
   *   - 用 `dashHits` 保证同一次冲刺对同一个目标只结算一次（否则 0.36 秒里
   *     会重复结算十几下，42 伤害会变成几百点）。
   *   - 伤害与击退都取技能定义里的 `damage` / `knockback`：不填就是纯位移
   *     （狼影的「影袭翻滚」本来就只负责跑路）。
   */
  private updateDashDamage(): void {
    for (const player of this.allPlayers) {
      const skill = player.def.skill;
      const dashing = skill.kind === 'dash' && !player.dead && player.dashTimer > 0;
      // 不在冲刺 = 一次冲刺结束，把命中记录清掉；下一次冲刺从零开始
      if (!dashing) {
        this.dashHits.get(player)?.clear();
        continue;
      }
      const damage = skill.damage ?? 0;
      const knockback = skill.knockback ?? 0;
      if (damage <= 0 && knockback <= 0) continue;

      let hits = this.dashHits.get(player);
      if (!hits) {
        hits = new Set<HitEntity>();
        this.dashHits.set(player, hits);
      }

      const reach = player.radius + DASH_HIT_PAD;
      for (const t of this.allTargets()) {
        if (t.dead || t.team === player.team) continue;
        if (hits.has(t)) continue;
        if (dist(player.x, player.y, t.x, t.y) > reach + t.radius) continue;
        hits.add(t);

        const n = normalize(t.x - player.x, t.y - player.y);
        // 完全重叠时（撞在正中）取冲刺方向，保证"撞"的方向感永远对
        const dirX = n.x === 0 && n.y === 0 ? player.dashDirX : n.x;
        const dirY = n.x === 0 && n.y === 0 ? player.dashDirY : n.y;
        const result = t.applyDamage(damage, {
          crit: false,
          source: 'dash',
          dirX,
          dirY,
          knockback,
          color: player.def.palette.glow,
          ownerTeam: player.team,
        });
        const angle = Math.atan2(dirY, dirX);
        // 命中火花按伤害类型分开画：纯击退的冲刺（肥嘟袋鼠）不该冒出伤害数字
        this.particles.hitSparks(t.x, t.y, angle, player.def.palette.glow, 10, 1.2);
        this.particles.dust(t.x, t.y, 5);
        if (damage > 0 && result.applied > 0) {
          this.numbers.add(t.x, t.y - 26, result.applied, false, player.def.palette.glow);
        }
        if (player === this.run.player) this.shake.add(0.2);
      }
    }
  }

  private resolveContactDamage(dt: number): void {
    for (const e of this.enemies) {
      if (e.dead) continue;
      // 训练木桩的接触伤害是 0：站在它旁边练枪不该被"蹭掉血"，
      // 也不该每 0.55 秒刷一次受击反馈（震屏 / 红闪）。
      if (e.def.contactDamage <= 0) continue;
      const cd = this.contactTimers.get(e) ?? 0;
      if (cd > 0) {
        this.contactTimers.set(e, cd - dt);
        continue;
      }
      for (const player of this.allPlayers) {
        if (player.dead) continue;
        const d = dist(e.x, e.y, player.x, player.y);
        if (d > e.radius + player.radius + 2) continue;
        this.contactTimers.set(e, 0.55);
        const n = normalize(player.x - e.x, player.y - e.y);
        const dmg = e.def.contactDamage * 0.55 * (1 + (this.run.floor - 1) * 0.28);
        const result = player.applyDamage(dmg, {
          crit: false,
          source: 'contact',
          dirX: n.x,
          dirY: n.y,
          knockback: 0,
          color: e.def.palette.glow,
        });
        if (!result.blocked) {
          this.particles.bloodSpray(player.x, player.y, Math.atan2(-n.y, -n.x), '#ff6a6a', 6);
          this.numbers.add(player.x, player.y - 22, dmg, false, '#ff9a8a');
          // 只有本地玩家受击才震屏 / 红闪 / 播放受击音，避免远端受伤也把本地屏幕晃花
          if (player === this.run.player) {
            this.shake.add(0.24);
            this.flash.trigger('255,50,50', 0.24, 3.6);
            this.host.audio.play('playerHurt', 0.9);
            this.cause = e.def.name;
          }
          if (player.mods.thorns > 0) {
            e.applyDamage(player.mods.thorns, {
              crit: false,
              source: 'thorns',
              dirX: -n.x,
              dirY: -n.y,
              knockback: 120,
            });
          }
        } else if (result.dodged) {
          this.particles.sparkle(player.x, player.y, '#7ef2c0', 5);
          this.numbers.add(player.x, player.y - 26, 0, false, '#7ef2c0');
        }
        // 该敌人本轮已命中一名玩家，进入公共冷却
        break;
      }
    }

    const b = this.boss;
    if (b && !b.dead) {
      this.bossContactTimer -= dt;
      if (this.bossContactTimer <= 0) {
        for (const player of this.allPlayers) {
          if (player.dead) continue;
          const d = dist(b.x, b.y, player.x, player.y);
          if (d > b.radius + player.radius + 2) continue;
          this.bossContactTimer = 0.6;
          const n = normalize(player.x - b.x, player.y - b.y);
          const dmg = b.contactDamage * 0.6;
          const result = player.applyDamage(dmg, {
            crit: false,
            source: 'contact',
            dirX: n.x,
            dirY: n.y,
            knockback: 0,
            color: '#ff8a5a',
          });
          if (!result.blocked) {
            this.particles.bloodSpray(player.x, player.y, Math.atan2(-n.y, -n.x), '#ff7a6a', 8);
            this.numbers.add(player.x, player.y - 22, dmg, false, '#ff9a8a');
            if (player === this.run.player) {
              this.shake.add(0.34);
              this.flash.trigger('255,50,50', 0.3, 3.4);
              this.host.audio.play('playerHurt', 1);
              this.cause = b.name;
            }
          }
          break;
        }
      }
    }
  }

  private updateEnemyDeaths(): void {
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i]!;
      if (e.dead && !e.deathHandled) {
        e.deathHandled = true;
        this.onEnemyDeath(e);
      }
      if (e.dead && e.deathTimer > 0.6) {
        this.contactTimers.delete(e);
        this.enemies.splice(i, 1);
      }
    }
  }

  private onEnemyDeath(e: Enemy): void {
    const pal = e.def.palette;
    this.particles.bloodSpray(e.x, e.y, Math.random() * TAU, pal.body, e.def.elite ? 18 : 10);
    this.particles.explosion(e.x, e.y, e.def.elite ? 62 : 34, pal.glow, '#ffffff');
    this.particles.shockwave(e.x, e.y, e.radius * 3.4, pal.glow, 0.4);
    this.host.audio.play('enemyDie', e.def.elite ? 1 : 0.7);
    this.shake.add(e.def.elite ? 0.34 : 0.14);
    this.time.hitStop(e.def.elite ? 0.07 : 0.02, 0.25);
    this.flash.trigger('255,190,120', e.def.elite ? 0.16 : 0.06, 4);

    this.run.stats.kills += 1;
    // 人头归属（需求 27）：自由混战里每个玩家的 team 就是自己的 peerId，
    // 谁打的最后一下就算谁的击杀 —— 否则在 2 人局里全都会记到房主头上。
    const killer = e.killedByTeam ? this.playerByTeam(e.killedByTeam) : null;
    if (killer) killer.kills += 1;
    else this.run.player.kills += 1;
    if (this.run.player.mods.lifesteal > 0) {
      this.run.player.heal(this.run.player.mods.lifesteal);
      this.numbers.add(this.run.player.x, this.run.player.y - 30, this.run.player.mods.lifesteal, false, '#7ef2c0');
    }

    const gold = this.run.addGold(this.run.rng.int(e.def.gold[0], e.def.gold[1]));
    if (gold > 0) scatterGold(this.pickups, this.run.rng, e.x, e.y, gold);
    if (this.run.rng.chance(e.def.elite ? 0.65 : 0.09)) {
      this.pickups.push(new Pickup('heart', e.x + this.run.rng.range(-14, 14), e.y + this.run.rng.range(-14, 14)));
    }
    if (this.run.rng.chance(0.09)) {
      this.pickups.push(new Pickup('ammo', e.x + this.run.rng.range(-14, 14), e.y + this.run.rng.range(-14, 14)));
    }
    if (this.run.rng.chance(0.05)) {
      this.pickups.push(new Pickup('shield', e.x + this.run.rng.range(-14, 14), e.y + this.run.rng.range(-14, 14)));
    }
    this.bus.emit(GameEvents.EnemyDied, { x: e.x, y: e.y, elite: e.def.elite });
  }

  private updatePickups(dt: number): void {
    const list = this.pickups;
    for (let i = list.length - 1; i >= 0; i--) {
      const p = list[i]!;
      // 磁力 / 运动只按「最近的存活玩家」计算一次，避免重复施加 dt
      let near: Player | null = null;
      let nearD = Infinity;
      for (const pl of this.allPlayers) {
        if (pl.dead) continue;
        const d = (pl.x - p.x) ** 2 + (pl.y - p.y) ** 2;
        if (d < nearD) {
          nearD = d;
          near = pl;
        }
      }
      p.update(dt, near ?? this.run.player, this.room, near?.pickupBonus ?? 0);
      if (p.collected || p.expired) {
        list.splice(i, 1);
        continue;
      }
      let eater: Player | null = null;
      for (const pl of this.allPlayers) {
        if (pl.dead) continue;
        if (p.canCollect(pl)) {
          eater = pl;
          break;
        }
      }
      if (eater) {
        this.collectPickup(p, eater);
        list.splice(i, 1);
      }
    }
  }

  private collectPickup(p: Pickup, player: Player): void {
    switch (p.kind) {
      case 'gold': {
        const amount = this.run.addGold(p.data.amount ?? 1);
        this.host.audio.play('gold', 0.5);
        this.particles.sparkle(p.x, p.y, '#ffd479', 4);
        this.numbers.add(p.x, p.y - 10, amount, false, '#ffd479');
        break;
      }
      case 'heart': {
        const heal = Math.max(12, Math.round(player.maxHp * 0.14));
        player.heal(heal);
        this.host.audio.play('pickup', 0.9);
        this.particles.sparkle(p.x, p.y, '#ff8a9a', 8);
        this.numbers.add(p.x, p.y - 10, heal, false, '#7ef2c0');
        break;
      }
      case 'ammo': {
        for (const w of player.weapons) {
          w.ammo = w.magSize;
          w.reloadTimer = 0;
        }
        this.host.audio.play('reload', 0.9);
        this.particles.sparkle(p.x, p.y, '#c9d0ff', 6);
        break;
      }
      case 'shield': {
        player.addShield(30);
        this.host.audio.play('pickup', 0.9);
        this.particles.sparkle(p.x, p.y, '#9fe8ff', 8);
        break;
      }
      default:
        break;
    }
    this.bus.emit(GameEvents.Pickup, { kind: p.kind });
  }

  private updateInteractTarget(): void {
    const player = this.run.player;
    this.interactTarget = null;
    this.interactHint = null;
    let best: Pickup | null = null;
    let bestD = Infinity;
    for (const p of this.pickups) {
      if (!p.canInteract(player)) continue;
      const d = dist(p.x, p.y, player.x, player.y);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    if (best) {
      this.interactTarget = best;
      this.interactHint = describePickup(best, this.run.floor >= FLOOR_COUNT);
    }
  }

  private interact(): void {
    if (this.interactTarget) {
      this.executeInteract(this.interactTarget, this.run.player);
      return;
    }
    this.tryReopenPrepShop();
  }

  /**
   * 走回首领房的门按 E → 重新打开「战前补给站」。
   *
   * 这条路径是「再准备一下」的配套：玩家点了它之后面板关掉、门还锁着，
   * 而 `room.prepShown` 已经是 true，进门分支不会再自动弹一次 ——
   * 没有这个出口的话，玩家就**永久卡在锁死的首领房里**（既打不了首领，也出不去）。
   *
   * 判据刻意写得很窄，只在"首领房 + 没清场 + 首领没醒 + 玩家确实站在门口"时触发；
   * 联机模式一律不触发（补给站本身在联机下是被跳过的）。
   */
  private tryReopenPrepShop(): void {
    if (this.isMultiplayer()) return;
    if (this.overlay.mode !== 'none' || this.mode !== 'play') return;
    const node = this.node;
    if (node.type !== 'boss' || node.cleared) return;
    if (this.boss || this.bossDeathTimer > 0 || this.pendingBossStart) return;
    const player = this.run.player;
    if (player.dead) return;
    if (!this.nearAnyDoor(player.x, player.y)) return;
    this.openPrepShop();
  }

  /**
   * 玩家是否站在某扇门附近（用来判断"走到门上按 E"）。
   *
   * ⚠️ 这里刻意**不用** `doorZoneAt()`。那个判定区是给"穿门"用的，
   * 深度只有 `DOOR_TRIGGER_DEPTH`（0.6 格 = 28.8px），而入场落点
   * `doorEntryPoint()` 在 1.15 格（55.2px）处 —— 两者按设计就**不重叠**
   * （见 room.ts 的几何不变量注释：一旦重叠玩家进门就会被判成"又穿了一次门"，
   * 和上一间房无限弹跳）。所以用它来判"站在门口"永远为假。
   *
   * 这里改判「到门洞矩形中心的距离」，半径取 1.6 格：足以覆盖入场落点，
   * 也不会大到让玩家在房间中央乱按 E 就能叫出补给站。
   */
  private nearAnyDoor(x: number, y: number): boolean {
    const R = TILE * 1.6;
    for (const dir of this.room.doors) {
      const r = doorRect(dir);
      const cx = clamp(x, r.x, r.x + r.w);
      const cy = clamp(y, r.y, r.y + r.h);
      if (Math.hypot(x - cx, y - cy) <= R) return true;
    }
    return false;
  }

  /** 让指定玩家执行一次交互（本地玩家与联机远端玩家共用同一套逻辑）。 */
  private interactFor(player: Player): void {
    let best: Pickup | null = null;
    let bestD = Infinity;
    for (const p of this.pickups) {
      if (!p.canInteract(player)) continue;
      const d = dist(p.x, p.y, player.x, player.y);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    if (best) this.executeInteract(best, player);
  }

  private executeInteract(p: Pickup, player: Player): void {
    switch (p.kind) {
      case 'weapon': {
        const def = getWeaponDef(p.data.weaponId!);
        const dropped = player.addOrReplaceWeapon(def.id, p.data.amount);
        this.host.save.discoverWeapon(def.id);
        this.host.audio.play('upgrade', 0.9);
        this.particles.sparkle(p.x, p.y, def.colors.glow, 14);
        p.collected = true;
        // 换下来的枪掉在脚边，而不是凭空消失
        if (dropped) this.dropWeapon(player, dropped);
        break;
      }
      case 'upgradeOrb': {
        p.collected = true;
        this.host.audio.play('upgrade', 0.9);
        this.particles.sparkle(p.x, p.y, '#9fe8ff', 14);
        this.queueUpgradeChoice(1);
        break;
      }
      case 'chest': {
        if (p.data.sold) return;
        p.data.sold = true;
        this.host.audio.play('chest', 1);
        this.shake.add(0.2);
        this.particles.explosion(p.x, p.y - 8, 56, '#ffd479', '#fff4d8');
        const weaponId = rollWeaponId((w) => this.run.rng.weightedIndex(w), player.weapons.map((w) => w.def.id));
        this.pickups.push(new Pickup('weapon', clamp(p.x - 64, 60, ROOM_W - 60), p.y + 26, { weaponId }));
        this.pickups.push(new Pickup('upgradeOrb', clamp(p.x + 64, 60, ROOM_W - 60), p.y + 26));
        const gold = this.run.addGold(this.run.rng.int(24, 46));
        scatterGold(this.pickups, this.run.rng, p.x, p.y + 52, gold);
        break;
      }
      case 'portal': {
        // 最后一层的传送门就是出口：按 E 直接结算通关；其余层进入楼层结算界面。
        if (this.run.floor >= FLOOR_COUNT) this.finishRun(true);
        else this.openFloorClear();
        break;
      }
      default:
        break;
    }
  }

  /**
   * 首领流程：死亡演出 → 遗体散去 → 场地中心开启传送门。
   *
   * 演出固定约 1 秒（BOSS_DEATH_DURATION，真实时间）：这段时间内遗体持续爆炸，
   * 结束后才刷传送门 —— 否则传送门会被埋在一片爆炸特效里，玩家根本看不到。
   * 之后（非最终层）再给两次强化选择。
   */
  private updateBossSequence(dt: number): void {
    const b = this.boss;
    if (!b) return;
    if (b.dead && !b.deathHandled) {
      b.deathHandled = true;
      this.onBossDefeated();
    }
    if (!b.dead) return;

    if (this.bossDeathTimer > 0) {
      this.bossDeathExplosionTimer -= dt;
      if (this.bossDeathExplosionTimer <= 0) {
        this.bossDeathExplosionTimer = BOSS_DEATH_EXPLOSION_INTERVAL;
        const a = this.run.rng.next() * TAU;
        const r = this.run.rng.range(0, b.radius);
        const ex = b.x + Math.cos(a) * r;
        const ey = b.y + Math.sin(a) * r;
        this.particles.explosion(ex, ey, 52 + this.run.rng.range(0, 38), '#ff8a3c', '#fff3c4');
        if (this.run.rng.chance(0.45)) {
          this.particles.shockwave(ex, ey, 110 + this.run.rng.range(0, 90), '#ffb066', 0.42);
        }
        this.shake.add(0.2);
      }
      this.bossDeathTimer -= dt;
      if (this.bossDeathTimer > 0) return;
    } else {
      return;
    }

    // 演出结束：最后一次大爆炸 → 撤掉遗体 → 开门 → 场地中心开出传送门
    this.bossDeathTimer = 0;
    this.time.slowFactor = 1;
    this.particles.explosion(b.x, b.y, 178, '#ffb066', '#ffffff');
    this.particles.shockwave(b.x, b.y, 430, '#ffd9a0', 0.72);
    this.shake.add(0.85);
    this.flash.trigger('255,240,200', 0.42, 2.6);
    this.host.audio.play('explosion', 0.9);
    this.boss = null;
    this.room.unlockAllDoors();
    this.spawnPortal();
    if (this.run.floor < FLOOR_COUNT) this.queueUpgradeChoice(2);
  }

  private onBossDefeated(): void {
    const b = this.boss!;
    this.run.bossDefeated = true;
    this.node.cleared = true;
    this.run.stats.rooms += 1;
    // 门先保持关闭：死亡演出跑完（传送门出现）之后才解锁。
    // 否则玩家可以在 1 秒演出里跑出首领房，回来时传送门就丢了。
    this.room.rewardDropped = true;
    this.host.audio.play('bossDie', 1);
    this.host.audio.setMusicIntensity(0);
    this.shake.add(1);
    this.flash.trigger('255,240,200', 0.55, 1.6);
    // 死亡演出开始：慢动作 + 连续爆炸，持续 BOSS_DEATH_DURATION 秒（真实时间）。
    // 传送门不在这里刷 —— 等演出结束再刷（见 updateBossSequence）。
    this.bossDeathTimer = BOSS_DEATH_DURATION;
    this.bossDeathExplosionTimer = 0;
    this.time.slowFactor = BOSS_DEATH_SLOWMO;

    // 首领倒下后，残余小怪就地崩解、场上弹幕消散。
    // 否则会出现「Boss 已经死了，却被它的残兵 / 流弹补刀」这种毫无道理的战败。
    for (const e of this.enemies) {
      if (!e.dead) {
        e.applyDamage(999999, { crit: false, source: 'bullet', dirX: 0, dirY: 0, knockback: 0 });
      }
    }
    this.projectiles.clear();

    const gold = this.run.addGold(this.run.rng.int(90, 150));
    scatterGold(this.pickups, this.run.rng, b.x, b.y, gold);
    const weaponId = rollWeaponId((w) => this.run.rng.weightedIndex(w), this.run.player.weapons.map((w) => w.def.id));
    this.pickups.push(new Pickup('weapon', clamp(b.x - 84, 60, ROOM_W - 60), b.y + 20, { weaponId }));
    this.pickups.push(new Pickup('heart', clamp(b.x + 84, 60, ROOM_W - 60), b.y + 20));
    this.pickups.push(new Pickup('shield', clamp(b.x + 130, 60, ROOM_W - 60), b.y + 20));
  }

  private spawnPortal(): void {
    const existing = this.pickups.find((p) => p.kind === 'portal');
    if (existing) return;
    const p = new Pickup('portal', ROOM_W / 2, ROOM_H / 2, {});
    this.pickups.push(p);
    this.particles.shockwave(p.x, p.y, 260, '#c8a2ff', 0.8);
    this.host.audio.play('upgrade', 1);
  }

  private openFloorClear(): void {
    this.overlay.summary = null;
    this.openOverlay('floorclear');
    this.host.audio.play('door', 0.8);
  }

  private advanceFloor(): void {
    this.host.audio.play('door', 1);
    this.particles.shockwave(this.run.player.x, this.run.player.y, 300, '#c8a2ff', 0.7);
    this.flash.trigger('220,190,255', 0.4, 2.2);
    this.run.advanceFloor();
    this.rooms.clear();
    this.roomPickups.clear();
    this.roomShopItems.clear();
    this.host.renderer.clearCache();
    this.enterRoom(this.run.plan.startKey, null);
    this.host.audio.setMusicIntensity(0);
    // 换层后立刻给一次强化选择（先把房间切好，避免覆盖层被后续流程顶掉）
    this.queueUpgradeChoice(1);
  }

  private checkPlayerDeath(): void {
    const player = this.run.player;
    if (!player.dead || this.ended) return;
    // 联机：本地玩家阵亡不等于全队失败，统一由 checkNetEnd 判定整局结果
    if (this.isMultiplayer()) return;
    if (player.deathTimer > 1.6) {
      // 最后一层的首领已经被击破，这次远征的结局就已经写定了。
      // 此时玩家多半是在去传送门的路上被余波/小怪补刀，判成"远征失败"说不过去。
      this.finishRun(this.run.floor >= FLOOR_COUNT && this.run.bossDefeated);
    }
  }

  private finishRun(won: boolean): void {
    if (this.ended && this.overlay.mode !== 'none' && !won) return;
    this.ended = true;
    const summary: DeathSummary = {
      floor: this.run.floor,
      floorCount: FLOOR_COUNT,
      kills: this.run.stats.kills,
      rooms: this.run.stats.rooms,
      gold: this.run.gold,
      timeSec: this.run.timeSec,
      score: this.run.score,
      won,
      characterName: this.run.character.name,
      cause: this.cause,
    };
    this.overlay.death = summary;
    this.overlay.mode = won ? 'victory' : 'dead';
    this.mode = 'overlay';
    this.host.audio.stopMusic();
    this.host.audio.play(won ? 'win' : 'lose', 1);
    this.overlayButtons = buildOverlayButtons(this.overlay, this.overlayContext());
    // 房主：把结算结果广播给所有客户端
    if (this.netRole === 'host' && this.net && !this.netOverSent) {
      this.netOverSent = true;
      this.net.send({
        t: 'gameover',
        won,
        winnerId: this.winnerId,
        reason: this.netMode,
        // 闯关模式：把失败原因带上（客户端推不出"被谁击倒"）
        cause: this.netMode === 'pk' ? undefined : this.cause,
        // 自由混战：发**结构化**的结束原因，客户端按自己的视角渲染结算文案。
        // 发预渲染好的字符串是不行的 —— 房主视角的「对手成为最后的幸存者」
        // 会被赢家一字不差地读到（他明明赢了）。
        pkReason: this.pkOutcome?.reason,
        winnerName: this.pkOutcome?.winnerName,
      });
    }
    // 联机：一局打完 —— 合作模式立刻解散并清空房间（需求 26）；
    // **自由混战例外**：PK 是"一把接一把"的比赛，房间必须留着，
    // 结算页的「再来一次」才能直接开下一局（需求 27）。房间由「关闭房间」主动关。
    // 必须放在 gameover 广播之后，否则客户端收不到结算结果。
    if (this.isMultiplayer() && this.netMode !== 'pk') this.endNetRoom();
  }

  /**
   * 一局结束时的房间收尾（需求 26）：联机**合作模式**打完一局后，
   * 房间不再属于任何人 —— 房间号与记分板立刻从画面消失，房主负责真正解散房间。
   *
   * 玩家仍停留在结算界面（想再看一眼战绩），返回大厅后要重新建房。
   * （自由混战不走这里：比赛结束后房间要留着给「再来一次」复用，见 finishRun。）
   */
  private endNetRoom(): void {
    this.roomCode = '';
    if (this.netRoomDissolved) return;
    this.netRoomDissolved = true;
    // 只有房主能解散房间；客户端等房主广播的 `closed`，那时同样只是清掉房间显示。
    if (this.netRole === 'host') this.host.dissolveRoom?.('对局已结束，房间已解散');
  }

  /**
   * 「关闭房间」：联机对局彻底收尾（结算页的主出口）。
   *
   * 房主会真正解散房间（其他人收到 `closed`），本地玩家回大厅。
   * 合作模式下房间此前已经自动解散，这里只是把人送走。
   */
  private closeRoom(): void {
    this.endNetRoom();
    this.host.endRun(this.run.result(this.overlay.mode === 'victory'));
  }

  // ------------------------------------------------------------- 房间状态

  private checkRoomClear(dt: number): void {
    const node = this.node;
    if (node.cleared) return;
    if (!isCombatRoom(node.type)) return;
    if (node.type === 'boss') return;

    if (this.waveIndex < this.waves.length && this.enemies.length === 0) {
      this.waveTimer -= dt;
      if (this.waveTimer <= 0) {
        this.waveTimer = 0.9;
        this.spawnWave();
      }
      return;
    }
    if (this.waveIndex >= this.waves.length && this.enemies.length === 0) {
      this.clearTimer += dt;
      if (this.clearTimer >= ROOM_CLEAR_REWARD_DELAY) this.onRoomCleared(node.type);
    }
  }

  private onRoomCleared(type: RoomType): void {
    const node = this.node;
    if (node.cleared) return;
    node.cleared = true;
    this.room.unlockAllDoors();
    this.run.stats.rooms += 1;
    this.host.audio.play('door', 0.9);
    this.particles.shockwave(ROOM_W / 2, ROOM_H / 2, 520, '#ffd479', 0.6);
    this.bus.emit(GameEvents.RoomCleared, { type });

    const player = this.run.player;
    const gold = this.run.addGold(
      this.run.rng.int(type === 'elite' ? 26 : 12, type === 'elite' ? 44 : 26),
    );
    scatterGold(this.pickups, this.run.rng, player.x, player.y + 40, gold);

    if (type === 'combat') {
      this.pendingUpgradeChoices += 1;
      if (this.run.rng.chance(0.22)) {
        this.pickups.push(
          new Pickup('ammo', player.x + this.run.rng.range(-60, 60), player.y + this.run.rng.range(-60, 60)),
        );
      }
    } else if (type === 'elite') {
      this.pendingUpgradeChoices += 1;
      const weaponId = rollWeaponId((w) => this.run.rng.weightedIndex(w), player.weapons.map((w) => w.def.id));
      this.pickups.push(
        new Pickup('weapon', player.x + this.run.rng.range(-70, 70), player.y + this.run.rng.range(-40, 70), {
          weaponId,
        }),
      );
      this.pickups.push(
        new Pickup('shield', player.x + this.run.rng.range(-70, 70), player.y + this.run.rng.range(-40, 70)),
      );
    }
    if (this.pendingUpgradeChoices > 0 && this.mode === 'play') this.openUpgradeChoice();
  }

  private spawnChest(): void {
    const p = new Pickup('chest', ROOM_W / 2, ROOM_H / 2 + 20, {});
    this.pickups.push(p);
    this.particles.shockwave(p.x, p.y, 200, '#ffd479', 0.6);
  }

  /**
   * 把换下来的武器丢在玩家脚边，变成地面上可再捡回的武器底座（带原剩余弹药）。
   * 依次尝试左右几个偏移点，取第一个不是墙的位置；都撞墙就退回玩家脚下
   * ——玩家站着的地方一定是可走地面，保证掉出来的枪不会被卡进墙里拿不到。
   */
  private dropWeapon(player: Player, dropped: { id: string; ammo: number }): void {
    const candidates: Array<[number, number]> = [
      [-48, 0],
      [48, 0],
      [-84, 0],
      [84, 0],
      [0, 48],
      [0, -48],
    ];
    let x = player.x;
    let y = player.y;
    for (const [dx, dy] of candidates) {
      const cx = clamp(player.x + dx, 48, ROOM_W - 48);
      const cy = clamp(player.y + dy, 48, ROOM_H - 48);
      if (!this.room.isBlockedPoint(cx, cy)) {
        x = cx;
        y = cy;
        break;
      }
    }
    this.pickups.push(new Pickup('weapon', x, y, { weaponId: dropped.id, amount: dropped.ammo }));
    this.particles.sparkle(x, y, '#ffe9b0', 8);
  }

  /** 某扇门在房内一侧的「穿过」判定区（紧贴边界，覆盖整个门洞宽度）。 */
  private doorZone(dir: Dir4): { x: number; y: number; w: number; h: number } {
    const rect = doorRect(dir);
    const d = DOOR_TRIGGER_DEPTH;
    if (dir === 'n') return { x: rect.x, y: 0, w: rect.w, h: d };
    if (dir === 's') return { x: rect.x, y: ROOM_H - d, w: rect.w, h: d };
    if (dir === 'w') return { x: 0, y: rect.y, w: d, h: rect.h };
    return { x: ROOM_W - d, y: rect.y, w: d, h: rect.h };
  }

  /** 玩家当前处在哪扇门的判定区里（不在任何门口则为 null）。 */
  private doorZoneAt(x: number, y: number): Dir4 | null {
    for (const dir of this.room.doors) {
      if (!this.node.neighbors[dir]) continue;
      const z = this.doorZone(dir);
      if (x >= z.x && x <= z.x + z.w && y >= z.y && y <= z.y + z.h) return dir;
    }
    return null;
  }

  /**
   * 穿门判定。
   *
   * 关键约束：入场落点（doorEntryPoint，离墙 1.15 格）必须在触发区
   * （DOOR_TRIGGER_DEPTH，离墙 0.6 格）之外。否则玩家一被放进新房间就
   * 立刻满足"已穿门"条件，和上一间房无限来回切换 —— 表现就是画面一直闪。
   */
  private checkDoors(dt: number): void {
    if (this.doorCooldown > 0) this.doorCooldown = Math.max(0, this.doorCooldown - dt);
    if (this.doorCooldown > 0) return;
    if (this.room.lockedDoors.size > 0) return;
    for (const player of this.allPlayers) {
      if (player.dead) continue;
      const dir = this.doorZoneAt(player.x, player.y);
      if (!dir) continue;
      const key = this.node.neighbors[dir];
      if (!key) continue;
      this.startTransition(dir, key);
      return;
    }
  }

  private startTransition(dir: Dir4, targetKey: string): void {
    this.transition = { stage: 0, t: 0, dir, targetKey };
    this.mode = 'transition';
    this.host.audio.play('door', 0.8);
  }

  private updateTransition(dt: number): void {
    const tr = this.transition;
    if (!tr) return;
    tr.t += dt;
    if (tr.stage === 0 && tr.t >= TRANSITION_HALF) {
      const opposite: Dir4 = tr.dir === 'n' ? 's' : tr.dir === 's' ? 'n' : tr.dir === 'e' ? 'w' : 'e';
      this.enterRoom(tr.targetKey, opposite);
      tr.stage = 1;
      tr.t = 0;
      // 有些房间一进门就要弹覆盖层（商店、首领房入口的战前补给站）。
      // 此时必须立刻结束转场：下一帧 mode 已经是 overlay，这段代码不会再被调用，
      // 黑场会永远停在最黑的一帧上（画面全黑）。
      if (this.mode === 'overlay') {
        this.transition = null;
        return;
      }
    }
    if (tr.stage === 1 && tr.t >= TRANSITION_HALF + 0.08) {
      this.transition = null;
      this.mode = 'play';
      if (this.pendingUpgradeChoices > 0) this.openUpgradeChoice();
      else this.flushPendingRoomStart();
    }
  }

  // ------------------------------------------------------------- 环境伤害

  damageEnvironment(x: number, y: number, radius: number, damage: number): void {
    const room = this.room;
    const minC = Math.max(1, Math.floor((x - radius) / TILE));
    const maxC = Math.min(ROOM_COLS - 2, Math.floor((x + radius) / TILE));
    const minR = Math.max(1, Math.floor((y - radius) / TILE));
    const maxR = Math.min(17, Math.floor((y + radius) / TILE));
    let broke = false;
    for (let r = minR; r <= maxR; r++) {
      for (let c = minC; c <= maxC; c++) {
        const idx = r * ROOM_COLS + c;
        if (room.layout.tiles[idx] !== Tile.Crate) continue;
        const cx = c * TILE + TILE / 2;
        const cy = r * TILE + TILE / 2;
        if (Math.hypot(cx - x, cy - y) > radius + TILE * 0.5) continue;
        if (this.breakCrate(idx, cx, cy, damage)) broke = true;
      }
    }
    this.finishCrateBreak(room, broke);
  }

  /**
   * 近战扇形砍击对**可破坏障碍（木箱）**造成伤害（需求 23）。
   *
   * 与爆炸的圆形 `damageEnvironment` 共用 `breakCrate` 的破坏表现，
   * 判定形状改成"以瞄准方向为中线、半角 `halfArc`、半径 `range` 的扇形"——
   * 与近战命中敌人用的是同一个扇形，保证"看得见的刃长 ≈ 砍得到的距离"。
   */
  damageObstacles(x: number, y: number, angle: number, halfArc: number, range: number, damage: number): void {
    const room = this.room;
    let broke = false;
    // 先复制快照：breakCrate 会从 layout.crates 里移除已碎的木箱，边遍历边改会漏格。
    for (const idx of room.layout.crates.slice()) {
      const c = idx % ROOM_COLS;
      const r = (idx / ROOM_COLS) | 0;
      const cx = c * TILE + TILE / 2;
      const cy = r * TILE + TILE / 2;
      const dx = cx - x;
      const dy = cy - y;
      const d = Math.hypot(dx, dy);
      if (d > range + TILE * 0.7) continue;
      // 木箱有体积：按尺寸给一点角度宽容，否则擦着边砍不中。
      if (Math.abs(angleDelta(angle, Math.atan2(dy, dx))) > halfArc + (TILE * 0.5) / Math.max(1, d)) continue;
      if (this.breakCrate(idx, cx, cy, damage)) broke = true;
    }
    this.finishCrateBreak(room, broke);
  }

  /** 木箱破坏的共用表现：爆裂粒子 + 木屑 + 概率掉金币。返回是否真的破坏成功。 */
  private breakCrate(idx: number, cx: number, cy: number, damage: number): boolean {
    if (!this.room.damageCrate(idx, damage)) return false;
    this.particles.explosion(cx, cy, 34, '#c8a06a', '#e8c898');
    for (let i = 0; i < 5; i++) {
      this.particles.spawn({
        kind: 'debris',
        x: cx,
        y: cy,
        vx: (Math.random() - 0.5) * 200,
        vy: (Math.random() - 0.5) * 200,
        life: 0.6,
        size: 6,
        sizeEnd: 2,
        color: '#7a5836',
        gravity: 420,
        spin: 12,
        drag: 1.4,
      });
    }
    if (this.run.rng.chance(0.45)) {
      const gold = this.run.addGold(this.run.rng.int(3, 8));
      if (gold > 0) scatterGold(this.pickups, this.run.rng, cx, cy, gold);
    }
    return true;
  }

  /** 木箱破坏后的收尾：音效 + 房间贴图失效重绘 + 轻微震动。 */
  private finishCrateBreak(room: Room, broke: boolean): void {
    if (!broke) return;
    this.host.audio.play('enemyDie', 0.4);
    this.host.renderer.invalidateRoom(room);
    this.shake.add(0.08);
  }

  private updateDynamicLights(): void {
    this.dynamicLights.length = 0;
    const player = this.run.player;
    if (!player.dead) {
      const w = player.currentWeapon;
      this.dynamicLights.push({
        x: player.x,
        y: player.y,
        radius: 130 + w.recoil * 70,
        color: w.def.colors.glow,
        alpha: 0.12 + w.recoil * 0.34,
      });
      if (player.beamActive) {
        this.dynamicLights.push({
          x: (player.x + player.beamEndX) / 2,
          y: (player.y + player.beamEndY) / 2,
          radius: 190,
          color: player.beamGlow,
          alpha: 0.16,
        });
      }
    }
    if (this.boss && !this.boss.dead) {
      this.dynamicLights.push({
        x: this.boss.x,
        y: this.boss.y,
        radius: 300,
        color: this.boss.phase >= 3 ? '#ff4a1a' : '#ff9a3c',
        alpha: 0.24,
      });
    }
  }

  // ------------------------------------------------------------- 覆盖层

  private overlayContext() {
    const player = this.run.player;
    return {
      gold: this.run.gold,
      hp: player.hp,
      maxHp: player.maxHp,
      floor: this.run.floor,
      floorCount: FLOOR_COUNT,
      kills: this.run.stats.kills,
      timeSec: this.run.timeSec,
      rooms: this.run.stats.rooms,
      score: this.run.score,
      settings: this.host.save.data.settings,
      characterName: this.run.character.name,
      pk: this.netMode === 'pk',
      // 平局判定用结构化结果，而不是去字符串里找「平局」两个字
      pkTie: this.netMode === 'pk' && pkIsDraw(this.pkOutcome),
      net: this.isMultiplayer(),
      // 训练营：暂停面板要换成「继续训练 / 返回大厅」两个出口，
      // 不能出现"保存进度 / 放弃远征"——训练局既没有存档也没有远征可放弃。
      training: this.training,
    };
  }

  private openOverlay(mode: OverlayState['mode']): void {
    if (this.overlay.mode !== 'settings') this.overlay.previousMode = this.overlay.mode;
    this.overlay.mode = mode;
    // 打开暂停面板一定是干净状态：上次留下的「确认放弃」不能带进来
    if (mode === 'pause') this.overlay.confirmAbandon = false;
    this.mode = 'overlay';
    this.overlayButtons = buildOverlayButtons(this.overlay, this.overlayContext());
  }

  private closeOverlay(): void {
    this.overlay.mode = 'none';
    if (this.ended) return;
    this.mode = 'play';
    if (this.pendingUpgradeChoices > 0) {
      this.openUpgradeChoice();
      return;
    }
    this.flushPendingRoomStart();
  }

  /** 覆盖层全部关掉之后，兑现「玩家已经确认开打」这类待办。 */
  private flushPendingRoomStart(): void {
    if (!this.pendingBossStart) return;
    this.pendingBossStart = false;
    this.startBossRoom();
  }

  private openUpgradeChoice(): void {
    if (this.pendingUpgradeChoices <= 0) return;
    // 联机：不弹强化选择面板（多人同步选择过于复杂），改为自动领取
    if (this.isMultiplayer()) {
      const n = this.pendingUpgradeChoices;
      this.pendingUpgradeChoices = 0;
      this.autoGrantUpgrade(n);
      return;
    }
    const options = this.run.rollUpgrades(3);
    if (!options.length) {
      this.pendingUpgradeChoices = 0;
      return;
    }
    this.overlay.upgradeOptions = options;
    this.overlay.upgradeStacks = this.run.upgrades;
    this.openOverlay('upgrade');
    this.host.audio.play('upgrade', 0.7);
  }

  private queueUpgradeChoice(count: number): void {
    this.pendingUpgradeChoices += count;
    if (this.mode === 'play') this.openUpgradeChoice();
  }

  private makeShopItems(): ShopItem[] {
    const rng = this.run.rng;
    const items: ShopItem[] = [];
    const weaponId = rollWeaponId((w) => rng.weightedIndex(w), this.run.player.weapons.map((w) => w.def.id));
    const wdef = getWeaponDef(weaponId);
    items.push({
      kind: 'weapon',
      price: SHOP_PRICES.weapon + rng.int(-8, 14),
      label: wdef.name,
      desc: wdef.desc,
      weaponId,
      sold: false,
    });
    const upgradeOptions = this.run.rollUpgrades(1);
    const up = UPGRADES.find((u) => u.id === upgradeOptions[0]);
    if (up) {
      items.push({
        kind: 'upgrade',
        price: SHOP_PRICES.upgrade + rng.int(-6, 10),
        label: `强化 · ${up.name}`,
        desc: up.perStack,
        upgradeId: up.id,
        sold: false,
      });
    }
    items.push({ kind: 'heal', price: SHOP_PRICES.heal, label: '紧急修复', desc: '立即回复 45 点生命', sold: false });
    items.push({
      kind: 'shield',
      price: SHOP_PRICES.shield,
      label: '护盾电池',
      desc: '护盾回满，并永久提升 15 点护盾上限',
      sold: false,
    });
    return items;
  }

  private openEvent(): void {
    const def = this.run.rng.pick(EVENTS);
    this.overlay.event = { def, resolvedIndex: -1, resultText: null };
    this.openOverlay('event');
  }

  private applyEventEffect(effect: EventEffect, option: EventOption): string {
    const player = this.run.player;
    if (option.cost?.gold) this.run.spendGold(option.cost.gold);
    if (option.cost?.hp) {
      player.applyDamage(option.cost.hp, {
        crit: false,
        source: 'thorns',
        dirX: 0,
        dirY: 0,
        knockback: 0,
      });
      this.particles.bloodSpray(player.x, player.y, -Math.PI / 2, '#ff6a6a', 10);
      this.flash.trigger('255,60,60', 0.25, 3.4);
      this.cause = '献祭反噬';
    }
    switch (effect.kind) {
      case 'upgrade':
        this.queueUpgradeChoice(effect.count);
        return `获得 ${effect.count} 次强化选择`;
      case 'weapon': {
        const weaponId = rollWeaponId((w) => this.run.rng.weightedIndex(w), player.weapons.map((w) => w.def.id));
        const dropped = player.addOrReplaceWeapon(weaponId);
        this.host.save.discoverWeapon(weaponId);
        if (dropped) this.dropWeapon(player, dropped);
        return `获得武器：${getWeaponDef(weaponId).name}`;
      }
      case 'heal': {
        player.heal(effect.amount);
        player.addShield(20);
        return `回复 ${effect.amount} 点生命，护盾 +20`;
      }
      case 'healFull': {
        player.heal(player.maxHp);
        player.addShield(40);
        return '生命已回满，护盾 +40';
      }
      case 'gold': {
        const g = this.run.addGold(effect.amount);
        return `获得 ${g} 金币`;
      }
      case 'goldRoll': {
        if (effect.chance >= 1) {
          const g = this.run.addGold(effect.mul * 70);
          player.applyDamage(effect.cost, {
            crit: false,
            source: 'thorns',
            dirX: 0,
            dirY: 0,
            knockback: 0,
          });
          return `打捞到 ${g} 金币，但被咬伤 ${effect.cost} 点生命`;
        }
        if (this.run.rng.chance(effect.chance)) {
          const win = Math.round(effect.cost * (effect.mul - 1));
          this.run.addGold(win);
          return `骰子停下，你赢了 ${win} 金币`;
        }
        return '骰子停下，钱没了';
      }
      case 'shield': {
        player.addShield(effect.amount);
        return `护盾 +${effect.amount}`;
      }
      case 'maxHp': {
        player.addMaxHp(effect.amount);
        return `生命上限 +${effect.amount}`;
      }
      case 'damage': {
        player.applyDamage(effect.amount, {
          crit: false,
          source: 'contact',
          dirX: 0,
          dirY: 0,
          knockback: 0,
        });
        return `受到 ${effect.amount} 点伤害`;
      }
      default:
        return '什么都没发生';
    }
  }

  private updateOverlayInput(): void {
    this.overlayButtons = buildOverlayButtons(this.overlay, this.overlayContext());
    const pointer = this.host.input.pointer;
    const hovered = hitTest(this.overlayButtons, pointer.sx, pointer.sy);
    this.hoverId = hovered ? hovered.id : null;
    if (!pointer.justDown || !hovered) return;
    this.host.audio.play('click', 0.6);
    this.handleOverlayAction(hovered.id);
  }

  private handleOverlayAction(id: string): void {
    if (id.startsWith('set:')) {
      const parts = id.split(':');
      const key = parts[1]!;
      const dir = parts[2]!;
      const settings = { ...this.host.save.data.settings } as Record<string, unknown>;
      const current = settings[key];
      if (typeof current === 'number') {
        const next = clamp(current + (dir === 'inc' ? 0.1 : -0.1), 0, 1);
        settings[key] = Math.round(next * 100) / 100;
        this.host.save.updateSettings(settings as never);
        this.applyAudioSettings();
      }
      return;
    }
    if (id.startsWith('toggle:')) {
      const key = id.split(':')[1] as 'showDamageNumbers' | 'showMinimap' | 'showSystemCursor';
      const settings = { ...this.host.save.data.settings };
      settings[key] = !settings[key];
      this.host.save.updateSettings(settings);
      this.numbers.enabled = settings.showDamageNumbers;
      return;
    }
    if (id.startsWith('upgrade:')) {
      const idx = Number(id.split(':')[1]);
      const upgradeId = this.overlay.upgradeOptions[idx];
      if (upgradeId) {
        this.run.addUpgrade(upgradeId);
        const def = UPGRADES.find((u) => u.id === upgradeId);
        this.pendingUpgradeChoices = Math.max(0, this.pendingUpgradeChoices - 1);
        this.overlay.summary = def ? `获得强化：${def.name}` : null;
        this.host.audio.play('upgrade', 1);
        this.particles.sparkle(this.run.player.x, this.run.player.y, '#9fe8ff', 16);
        this.numbers.add(this.run.player.x, this.run.player.y - 40, 0, false, '#9fe8ff');
      }
      this.closeOverlay();
      return;
    }
    if (id.startsWith('prep:')) {
      const rest = id.split(':')[1]!;
      if (rest === 'start') {
        // 立即开打会让覆盖层与首领同时存在，所以先记下待办：
        // 等（可能还有的）强化选择全部关掉之后，closeOverlay 会兑现它。
        this.pendingBossStart = true;
        this.closeOverlay();
        this.host.audio.play('bossRoar', 0.8);
        return;
      }
      if (rest === 'leave') {
        // 「再准备一下」：关掉面板但**不开打**。
        // 门已经是锁上的状态，玩家只能在首领房外的走廊里转；
        // `room.prepShown` 已经是 true，所以不会再自动弹一次 ——
        // 想进首领房就得走到门上按 E（`enterBossRoomPrompt`）重开补给站。
        this.closeOverlay();
        this.host.audio.play('click', 0.6);
        return;
      }
      const idx = Number(rest);
      const item = Number.isInteger(idx) ? this.overlay.prepItems[idx] : undefined;
      if (!item || item.sold) return;
      if (!this.run.spendGold(item.price)) {
        this.host.audio.play('error', 0.8);
        return;
      }
      item.sold = true;
      const player = this.run.player;
      switch (item.kind) {
        case 'healHalf': {
          const heal = Math.max(20, Math.round(player.maxHp * 0.5));
          const before = player.hp;
          player.heal(heal);
          this.numbers.add(player.x, player.y - 30, player.hp - before, false, '#7ef2c0');
          break;
        }
        case 'magPlus':
          // 复用「弹匣扩容」强化：数值、上限与展示都走同一套，不会出现两套弹匣规则
          this.run.addUpgrade('mag');
          for (const w of player.weapons) w.ammo = w.magSize;
          break;
        case 'ammo':
          for (const w of player.weapons) {
            w.ammo = w.magSize;
            w.reloadTimer = 0;
          }
          break;
        case 'shield':
          player.mods = { ...player.mods, shieldAdd: player.mods.shieldAdd + 15 };
          player.refreshFromMods(player.mods);
          player.shield = player.maxShield;
          break;
        default:
          break;
      }
      this.host.audio.play('buy', 1);
      this.particles.sparkle(player.x, player.y, '#ffd479', 12);
      return;
    }
    if (id.startsWith('shop:')) {
      const rest = id.split(':')[1]!;
      if (rest === 'leave') {
        this.closeOverlay();
        return;
      }
      const item = this.overlay.shopItems[Number(rest)];
      if (!item || item.sold) return;
      if (!this.run.spendGold(item.price)) {
        this.host.audio.play('error', 0.8);
        return;
      }
      item.sold = true;
      const player = this.run.player;
      switch (item.kind) {
        case 'weapon': {
          const dropped = player.addOrReplaceWeapon(item.weaponId!);
          this.host.save.discoverWeapon(item.weaponId!);
          if (dropped) this.dropWeapon(player, dropped);
          break;
        }
        case 'upgrade':
          this.run.addUpgrade(item.upgradeId!);
          break;
        case 'heal':
          player.heal(45);
          break;
        case 'shield':
          player.shield = player.maxShield;
          player.mods = { ...player.mods, shieldAdd: player.mods.shieldAdd + 15 };
          player.refreshFromMods(player.mods);
          player.shield = player.maxShield;
          break;
      }
      this.host.audio.play('buy', 1);
      this.particles.sparkle(this.run.player.x, this.run.player.y, '#ffd479', 12);
      return;
    }
    if (id.startsWith('event:')) {
      const rest = id.split(':')[1]!;
      const ev = this.overlay.event;
      if (!ev) return;
      if (rest === 'leave') {
        this.closeOverlay();
        return;
      }
      const option = ev.def.options[Number(rest)];
      if (!option || ev.resolvedIndex >= 0) return;
      ev.resolvedIndex = Number(rest);
      ev.resultText = this.applyEventEffect(option.effect, option);
      this.host.audio.play('upgrade', 0.9);
      return;
    }
    switch (id) {
      case 'resume':
        this.closeOverlay();
        break;
      case 'save': {
        // 手动存档：落盘 + 把结果写回面板那行状态字 + 给一声确认音
        const ok = this.saveWithNotice();
        this.host.audio.play(ok ? 'save' : 'error', 0.7);
        this.overlayButtons = buildOverlayButtons(this.overlay, this.overlayContext());
        break;
      }
      case 'save-exit':
        // 存好再退场：这条路径**不删档**，下次进主菜单可以从「继续远征」回来
        this.saveWithNotice();
        this.closeOverlay();
        if (this.host.exitToLobby) this.host.exitToLobby();
        else this.host.audio.play('save', 0.7);
        break;
      case 'settings':
        this.overlay.previousMode = this.overlay.mode;
        this.overlay.mode = 'settings';
        this.overlayButtons = buildOverlayButtons(this.overlay, this.overlayContext());
        break;
      case 'settings-back':
        this.overlay.mode = this.overlay.previousMode === 'settings' ? 'pause' : this.overlay.previousMode;
        this.overlayButtons = buildOverlayButtons(this.overlay, this.overlayContext());
        break;
      case 'abandon':
        // 结算界面（dead / victory）上的这个按钮是「关闭房间 / 返回大厅」，
        // **不是**「放弃远征」：这一局已经打完了，没有任何存档需要"放弃"。
        // （以前它只是把 confirmAbandon 置 true，而结算面板根本不画确认框 →
        //   点下去毫无反应，玩家就卡死在结算页 —— 真机 bug，需求 27 一并修掉。）
        if (this.overlay.mode === 'dead' || this.overlay.mode === 'victory') {
          this.closeRoom();
          break;
        }
        // 暂停面板：不直接删档，先把面板切成「确认放弃 / 取消」，
        // 免得「放弃远征」被当成"退出到大厅"，一点就把几十分钟的进度清掉。
        this.overlay.confirmAbandon = true;
        this.host.audio.play('error', 0.5);
        this.overlayButtons = buildOverlayButtons(this.overlay, this.overlayContext());
        break;
      case 'abandon-cancel':
        this.overlay.confirmAbandon = false;
        this.overlayButtons = buildOverlayButtons(this.overlay, this.overlayContext());
        break;
      case 'abandon-confirm':
        this.overlay.confirmAbandon = false;
        this.host.abandonRun();
        break;
      case 'retry':
        // 自由混战（需求 27）：「再来一次」= 同一个房间直接开下一把。
        // 新 `start` 会让所有人重建 GameplayScene —— 地图/人头/计时整体重置。
        if (this.isMultiplayer() && this.netMode === 'pk') {
          this.requestRematch();
          break;
        }
        this.host.endRun(this.run.result(this.overlay.mode === 'victory'));
        break;
      case 'next-floor':
        this.closeOverlay();
        this.advanceFloor();
        break;
      default:
        break;
    }
  }

  private applyAudioSettings(): void {
    const s = this.host.save.data.settings;
    this.host.audio.setSettings({ master: s.masterVolume, sfx: s.sfxVolume, music: s.musicVolume });
  }

  // ------------------------------------------------------------- 渲染

  render(): void {
    const renderer = this.host.renderer;
    const ctx = renderer.ctx;
    const player = this.run.player;
    const time = this.run.timeSec;
    renderer.beginFrame();

    renderer.pushWorld(this.shake.offsetX, this.shake.offsetY, this.shake.rotation);
    renderer.drawRoomLayer(this.room);
    renderer.drawTelegraphs(this.enemies, this.boss && !this.boss.dead ? this.boss : null);

    for (const p of this.pickups) drawPickup(ctx, p, time);

    type Drawable = { y: number; draw: () => void };
    const list: Drawable[] = [];
    for (const e of this.enemies) list.push({ y: e.y, draw: () => drawEnemy(ctx, e, time) });
    if (this.boss) {
      const b = this.boss;
      list.push({ y: b.y, draw: () => drawBoss(ctx, b, time) });
    }
    if (!player.dead || player.deathTimer < 1.2) {
      list.push({ y: player.y, draw: () => drawPlayer(ctx, player, time) });
    }
    // 联机：其余玩家用其配色重绘（复用同一套美术）
    for (const rp of this.allPlayers) {
      if (rp === player) continue;
      if (rp.dead && rp.deathTimer >= 1.2) continue;
      list.push({
        y: rp.y,
        draw: () => drawPlayer(ctx, rp, time, netPalette(rp.netColor ?? PLAYER_COLORS[0]!)),
      });
    }
    list.sort((a, b) => a.y - b.y);
    for (const d of list) d.draw();
    // 近战蓄力指示环（需求 30）：任何在蓄力的近战玩家都画一圈进度弧
    for (const pl of this.allPlayers) {
      if (pl.currentWeapon.def.kind !== 'melee') continue;
      if (pl.meleeCharge <= 0) continue;
      drawMeleeChargeRing(ctx, pl);
    }
    // 名字标签统一在实体之上绘制
    if (this.isMultiplayer()) {
      for (const rp of this.allPlayers) {
        if (rp.dead && rp.deathTimer >= 1.2) continue;
        drawPlayerTag(ctx, rp, rp === player);
      }
    }

    if (player.beamActive) {
      drawBeam(
        ctx,
        player.x,
        player.y,
        player.beamEndX,
        player.beamEndY,
        player.beamWidth,
        player.beamCore,
        player.beamGlow,
        time,
      );
    }

    this.projectiles.draw(ctx);
    this.particles.draw(ctx);
    renderer.drawLighting(this.room, this.dynamicLights, this.lastDt);
    renderer.drawRoomEdgeDarkening();
    this.numbers.draw(ctx);
    renderer.popWorld();

    renderer.drawVignette();
    renderer.drawScanlines();
    this.flash.draw(ctx, VIEW_W, VIEW_H);

    // 穿门时的黑场过渡：必须画在 HUD 之前，否则会把准星和生命条一起盖住
    // （叠加了"房间来回弹跳"的 bug 时，屏幕上就会表现为光标/画面不停闪）
    if (this.transition) {
      const t =
        this.transition.stage === 0
          ? clamp(this.transition.t / TRANSITION_HALF, 0, 1)
          : clamp(1 - this.transition.t / (TRANSITION_HALF + 0.14), 0, 1);
      ctx.save();
      ctx.fillStyle = `rgba(6,5,13,${clamp(t, 0, 1)})`;
      ctx.fillRect(0, 0, VIEW_W, VIEW_H);
      ctx.restore();
    }

    const pointer = this.host.input.pointer;
    drawHud(ctx, {
      player,
      plan: this.run.plan,
      currentKey: this.run.currentRoomKey,
      discovered: this.discovered,
      upgrades: this.run.upgrades,
      floor: this.run.floor,
      floorCount: FLOOR_COUNT,
      gold: this.run.gold,
      kills: this.run.stats.kills,
      timeSec: this.run.timeSec,
      // 死亡演出期间不再显示首领血条（否则会挂着一条 0 血的黑条）
      boss: this.boss && !this.boss.dead ? this.boss : null,
      mouseX: pointer.sx,
      mouseY: pointer.sy,
      time,
      interactHint: this.interactHint,
      showMinimap: this.host.save.data.settings.showMinimap,
      showCrosshair: this.hidesSystemCursor,
      fps: this.fps,
      // 训练营：HUD 左侧的「第 N 层」改成「训练营」，小地图也不再画
      //（地牢只生成了出生房这一间，画一张空地图纯属干扰）。
      training: this.training,
    });

    if (this.isMultiplayer()) this.drawNetHud(ctx, time);

    if (this.overlay.mode !== 'none') {
      drawOverlay(ctx, this.overlay, this.overlayButtons, this.hoverId, time, this.overlayContext());
    }

    if (this.mode === 'play') {
      const banner = this.objectiveBanner();
      if (banner) {
        ctx.save();
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = banner.color;
        ctx.font = '700 15px "PingFang SC","Segoe UI",sans-serif';
        ctx.fillText(banner.text, VIEW_W / 2, 42);
        ctx.restore();
      }
    }
  }

  /** 联机 HUD：房间号 + 记分板 + 房间/成员提示。一局打完后房间已解散，整块不再绘制。 */
  private drawNetHud(ctx: CanvasRenderingContext2D, time: number): void {
    if (this.ended) return;
    const rows = this.allPlayers;
    const w = 220;
    const rowH = 32;
    const h = 34 + rows.length * rowH;
    const x = VIEW_W - w - 18;
    const y = 64;
    const pk = this.netMode === 'pk';
    ctx.save();
    // 面板
    ctx.fillStyle = 'rgba(12,10,20,0.66)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = pk ? 'rgba(255,138,90,0.55)' : 'rgba(126,242,192,0.55)';
    ctx.lineWidth = 1.4;
    ctx.strokeRect(x, y, w, h);
    // 标题
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillStyle = pk ? '#ff9a6a' : '#7ef2c0';
    ctx.font = '700 13px "PingFang SC","Segoe UI",sans-serif';
    ctx.fillText(pk ? '自由混战' : '合作闯关', x + 14, y + 17);
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(206,198,232,0.72)';
    ctx.font = '600 12px Consolas, monospace';
    ctx.fillText(`${rows.length} 人`, x + w - 14, y + 17);

    // 自由混战：比赛状态（需求 28 —— 三种状态分得清清楚楚）
    //   等齐人 → 「等待其他玩家」，比赛**还没开始**（免得以为进了空场）
    //   倒计时 → 「准备开始 3」，双方都看得见，不会出现"一进场就结束了"
    //   进行中 → 「剩余 m:ss」+ 人头目标
    if (pk) {
      const cx = x + w / 2;
      ctx.save();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      if (this.pk.phase === 'waiting') {
        // 人不够：把「还差几个人」写清楚，房主才知道要等谁
        ctx.fillStyle = 'rgba(255,212,121,0.92)';
        ctx.font = '700 13px "PingFang SC","Segoe UI",sans-serif';
        ctx.fillText('等待玩家加入…', cx, y + h + 16);
        ctx.fillStyle = 'rgba(206,198,232,0.62)';
        ctx.font = '600 11px "PingFang SC","Segoe UI",sans-serif';
        ctx.fillText(`比赛未开始 · ${rows.length}/${this.pk.minPlayers} 人`, cx, y + h + 34);
      } else if (this.pk.phase === 'starting') {
        ctx.fillStyle = '#7ef2c0';
        ctx.font = '800 16px "PingFang SC","Segoe UI",sans-serif';
        ctx.fillText(`准备开始 ${Math.max(1, Math.ceil(this.pk.countdown))}`, cx, y + h + 16);
        ctx.fillStyle = 'rgba(206,198,232,0.68)';
        ctx.font = '600 11px "PingFang SC","Segoe UI",sans-serif';
        ctx.fillText(`击杀 ${this.pk.killTarget} 人提前结束`, cx, y + h + 34);
      } else {
        const left = Math.max(0, Math.ceil(this.pk.timeLeft));
        const mm = Math.floor(left / 60);
        const ss = left % 60;
        ctx.fillStyle = left <= 30 ? '#ff8a6a' : 'rgba(255,212,121,0.92)';
        ctx.font = '700 14px Consolas, monospace';
        ctx.fillText(`剩余 ${mm}:${String(ss).padStart(2, '0')}`, cx, y + h + 16);
        ctx.fillStyle = 'rgba(206,198,232,0.68)';
        ctx.font = '600 11px "PingFang SC","Segoe UI",sans-serif';
        ctx.fillText(`击杀 ${this.pk.killTarget} 人提前结束`, cx, y + h + 34);
      }
      ctx.restore();
    }

    for (let i = 0; i < rows.length; i++) {
      const p = rows[i]!;
      const ry = y + 34 + i * rowH + 13;
      const isLocal = p === this.run.player;
      ctx.fillStyle = p.netColor ?? '#5cc8ff';
      ctx.beginPath();
      ctx.arc(x + 18, ry, 5, 0, TAU);
      ctx.fill();
      ctx.textAlign = 'left';
      ctx.fillStyle = p.dead ? 'rgba(200,192,220,0.45)' : isLocal ? '#fff4d8' : '#e6e1f4';
      ctx.font = `${isLocal ? '700' : '600'} 12px "PingFang SC","Segoe UI",sans-serif`;
      ctx.fillText(`${p.netName ?? '玩家'}${isLocal ? '（你）' : ''}`, x + 30, ry - 4);
      ctx.textAlign = 'right';
      ctx.fillStyle = 'rgba(255,212,121,0.85)';
      ctx.font = '600 11px Consolas, monospace';
      ctx.fillText(`${p.kills}`, x + w - 14, ry - 4);
      const bw = w - 44;
      const ratio = p.maxHp > 0 ? clamp(p.hp / p.maxHp, 0, 1) : 0;
      ctx.fillStyle = 'rgba(10,8,18,0.85)';
      ctx.fillRect(x + 30, ry + 7, bw, 4);
      ctx.fillStyle = ratio > 0.3 ? '#7ef2c0' : '#ff8a6a';
      ctx.fillRect(x + 30, ry + 7, Math.max(2, bw * ratio), 4);
    }
    ctx.restore();

    // 房间号
    if (this.roomCode) {
      ctx.save();
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(206,198,232,0.6)';
      ctx.font = '600 12px Consolas, monospace';
      ctx.fillText(`房间 ${this.roomCode}`, 20, 20);
      ctx.restore();
    }

    // 成员进出提示
    if (this.netBannerTimer > 0 && this.netBanner) {
      ctx.save();
      ctx.globalAlpha = clamp(this.netBannerTimer / 0.6, 0, 1);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(255,212,121,0.92)';
      ctx.font = '700 16px "PingFang SC","Segoe UI",sans-serif';
      ctx.fillText(this.netBanner, VIEW_W / 2, 74);
      ctx.restore();
    }
    void time;
  }

  /** 屏幕顶部的当前目标提示（战斗房锁门 / 补给站待确认 / 传送门已开启）。 */
  private objectiveBanner(): { text: string; color: string } | null {
    // 训练营（需求 29）：这里没有"下一步该干嘛"，顶部只说明这是个练习场。
    // 必须压过下面的"消灭所有敌人"—— 木桩是打不死的，那句话会把玩家逼疯。
    if (this.training) {
      const dps = this.trainingTime > 0 ? this.trainingDamage / this.trainingTime : 0;
      const dmg = Math.round(this.trainingDamage);
      return {
        text: `训练营 · 累计伤害 ${dmg} · DPS ${dps.toFixed(0)} · 按 Esc 返回大厅`,
        color: 'rgba(255,212,121,0.9)',
      };
    }
    // 自由混战：比赛状态压过"消灭所有敌人"——PK 里没人关心清怪进度，
    // 玩家要一眼看到的是"几点开打 / 打到什么程度算赢"。
    if (this.netMode === 'pk') {
      if (this.pk.phase === 'waiting') {
        return {
          text: `自由混战 · 等待玩家加入（${this.allPlayers.length}/${this.pk.minPlayers} 人）`,
          color: 'rgba(255,212,121,0.92)',
        };
      }
      if (this.pk.phase === 'starting') {
        return { text: `准备开始 —— ${Math.max(1, Math.ceil(this.pk.countdown))}`, color: '#7ef2c0' };
      }
      const left = Math.max(0, Math.ceil(this.pk.timeLeft));
      const mm = Math.floor(left / 60);
      const ss = left % 60;
      return {
        text: `自由混战 · 剩余 ${mm}:${String(ss).padStart(2, '0')} · 先击杀 ${this.pk.killTarget} 人者胜`,
        color: left <= 30 ? '#ff8a6a' : 'rgba(255,212,121,0.92)',
      };
    }
    // 首领房有第三种状态：门锁了，但首领还没醒（玩家点了「再准备一下」蹲在门里）。
    // 这时不能沿用"消灭所有敌人" —— 场上一个敌人都没有，玩家会以为卡关。
    if (this.node.type === 'boss' && !this.node.cleared && !this.boss && !this.pendingBossStart) {
      return { text: '走到首领房门按 E 重新打开战前补给站', color: 'rgba(255,212,121,0.82)' };
    }
    if (!this.node.cleared && isCombatRoom(this.node.type)) {
      if (this.node.type === 'boss' && !this.boss) {
        // 首领已被唤醒但还没落到场上（pendingBossStart 兑现的那一帧）——
        // 不要在这一瞬间闪一下"消灭所有敌人"。
        return { text: '首领正在苏醒…', color: 'rgba(255,140,90,0.9)' };
      }
      return { text: '房门已封闭 — 消灭所有敌人', color: 'rgba(255,212,121,0.82)' };
    }
    if (this.portalReady) {
      return this.run.floor >= FLOOR_COUNT
        ? { text: '通道已开启 — 走到传送门按 E 摧毁深渊之心，结算通关', color: 'rgba(200,162,255,0.92)' }
        : { text: '传送门已开启 — 走到传送门按 E 前往下一层', color: 'rgba(200,162,255,0.92)' };
    }
    return null;
  }

  handlePointerDown(): void {
    /* 射击在主循环轮询，这里无需处理 */
  }

  handlePointerUp(): void {
    /* 预留 */
  }

  handleKey(code: string): void {
    if (code !== 'Escape') return;
    this.handleEscape();
  }

  /**
   * Esc 的统一含义：在游戏里 = 存一次盘并打开暂停面板；
   * 在覆盖层里 = 「返回上一层」（设置→暂停，暂停/补给站→关闭）。
   *
   * 生产环境由 `update()` 的覆盖层分支轮询触发；`handleKey` 只是同一条逻辑的
   * 直接投喂入口（无头测试用）。两者必须共用这一个函数，否则「测试里 Esc 能关面板、
   * 真机上按 Esc 没反应」这种偏差会一直藏在测试的绿色里。
   */
  private handleEscape(): void {
    if (this.mode !== 'overlay') {
      if (this.mode === 'play') {
        this.saveWithNotice();
        this.openOverlay('pause');
      }
      return;
    }
    switch (this.overlay.mode) {
      case 'settings':
        this.overlay.mode = this.overlay.previousMode === 'settings' ? 'pause' : this.overlay.previousMode;
        break;
      case 'pause':
        // 二次确认态下 Esc = 取消，而不是把面板一起关掉
        if (this.overlay.confirmAbandon) this.overlay.confirmAbandon = false;
        else {
          this.closeOverlay();
          return;
        }
        break;
      case 'preboss':
        // Esc 等同于点「再准备一下」：只关面板、**不开打**。
        // 玩家已经站在首领房门口（门是锁的），所以这里不能顺手把首领叫醒 ——
        // 那会让"我只是想关掉面板"变成"被迫开战"。
        this.closeOverlay();
        return;
      default:
        return;
    }
    this.overlayButtons = buildOverlayButtons(this.overlay, this.overlayContext());
  }

  // ------------------------------------------------------------- 联机

  private isMultiplayer(): boolean {
    return this.netRole !== 'local';
  }

  /** 选取距离 (x, y) 最近的存活玩家；若全部阵亡则返回本地玩家。 */
  private focusAt(x: number, y: number): Player {
    let best: Player = this.run.player;
    let bestD = Infinity;
    for (const p of this.allPlayers) {
      if (p.dead) continue;
      const d = (p.x - x) ** 2 + (p.y - y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best;
  }

  private setupNet(net: NetOptions): void {
    this.net = net.client;
    this.netRole = net.role;
    this.netMode = net.mode;
    this.localPeerId = net.localPeerId;
    this.peers = net.peers;
    this.roomCode = net.roomCode;

    const me = net.peers.find((p) => p.id === net.localPeerId);
    this.run.player.netName = me?.name ?? '你';
    this.run.player.netColor = me?.color ?? PLAYER_COLORS[0]!;

    for (const peer of net.peers) {
      if (peer.id === net.localPeerId) continue;
      if (this.playerByPeer.has(peer.id)) continue;
      this.addRemotePlayer(peer);
    }
    this.applyTeams();

    if (net.role === 'host') {
      this.net.on('input', (m) => {
        if (m.t === 'input') this.inputBuffer.set(m.from, m.i);
      });
      this.net.on('peerLeft', (m) => {
        if (m.t === 'peerLeft') this.removePeer(m.peerId);
      });
      // 客户端点了「再来一次」→ 由房主代它开下一局（房主权威）。
      // 只在本局已经结束时受理：对局中途的请求一律忽略，避免被强行重开。
      this.net.on('rematchRequest', (m) => {
        if (m.t !== 'rematchRequest' || !this.ended) return;
        this.requestRematch();
      });
    } else {
      this.net.on('snapshot', (m) => {
        if (m.t === 'snapshot') this.lastSnapshot = m.s;
      });
      this.net.on('gameover', (m) => {
        if (m.t === 'gameover') this.onNetGameover(m.won, m.winnerId, m.cause, m.pkReason, m.winnerName);
      });
    }
    this.net.on('closed', () => {
      // 一局已经打完（房主解散了房间）：只把房间从画面上清掉，
      // **不能**再走 leaveNet —— 那会把人从结算界面直接拽回大厅，战绩都看不完。
      if (this.ended) {
        this.endNetRoom();
        this.overlay.resultNotice = '房主已关闭房间，回大厅去吧';
        this.overlayButtons = buildOverlayButtons(this.overlay, this.overlayContext());
        return;
      }
      this.host.leaveNet?.('与服务器的连接已断开');
    });
  }

  private addRemotePlayer(peer: PeerInfo): Player {
    const p = new Player(getCharacter(peer.characterId));
    p.netName = peer.name;
    p.netColor = peer.color;
    p.team = peer.team;
    p.x = ROOM_W / 2;
    p.y = ROOM_H / 2;
    this.allPlayers.push(p);
    this.playerByPeer.set(peer.id, p);
    this.peerByPlayer.set(p, peer.id);
    this.netBanner = `${peer.name} 已加入`;
    this.netBannerTimer = 2.4;
    return p;
  }

  private removePeer(peerId: string): void {
    const p = this.playerByPeer.get(peerId);
    if (!p) return;
    const i = this.allPlayers.indexOf(p);
    if (i >= 0) this.allPlayers.splice(i, 1);
    this.playerByPeer.delete(peerId);
    this.peerByPlayer.delete(p);
    this.inputBuffer.delete(peerId);
    this.lastRemoteSkill.delete(peerId);
    this.lastRemoteInteract.delete(peerId);
    this.netBanner = `${p.netName ?? '队友'} 已离开`;
    this.netBannerTimer = 2.4;
  }

  private applyTeams(): void {
    if (this.netMode === 'coop') {
      for (const p of this.allPlayers) p.team = TEAM_HEROES;
    } else {
      this.run.player.team = this.localPeerId;
      for (const [pid, p] of this.playerByPeer) p.team = pid;
    }
  }

  /** 房主：用远端玩家上报的输入驱动其模拟（与本地玩家同帧同 dt）。 */
  private stepRemotePlayer(p: Player, dt: number): void {
    const peerId = this.peerByPlayer.get(p);
    const input = peerId ? this.inputBuffer.get(peerId) : undefined;
    p.updateTimers(dt);
    if (p.dead) {
      p.updateMovement(dt, { x: 0, y: 0 }, this.room);
      updateWeapon(
        { player: p, room: this.room, ctx: this.damageCtx, projectiles: this.projectiles,         targets: this.allTargets(), damageObstacles: (ox, oy, oa, oh, org, od) => this.damageObstacles(ox, oy, oa, oh, org, od), damageEnvironment: (ex, ey, er, ed) => this.damageEnvironment(ex, ey, er, ed), dt, time: this.run.timeSec },
        false,
      );
      return;
    }
    const mv = input ? { x: input.moveX, y: input.moveY } : { x: 0, y: 0 };
    if (input) p.aimAngle = input.aim;
    p.updateMovement(dt, mv, this.room);
    if (input && peerId) {
      // 技能 / 交互是边沿触发，避免按住时反复施放
      if (input.skill && !this.lastRemoteSkill.get(peerId)) p.useSkill();
      this.lastRemoteSkill.set(peerId, input.skill);
      if (input.interact && !this.lastRemoteInteract.get(peerId)) this.interactFor(p);
      this.lastRemoteInteract.set(peerId, input.interact);
      if (input.reload) p.startReload();
      if (input.swap === 0 || input.swap === 1) p.swapWeapon(input.swap);
    }
    updateWeapon(
      { player: p, room: this.room, ctx: this.damageCtx, projectiles: this.projectiles, targets: this.allTargets(), damageObstacles: (ox, oy, oa, oh, org, od) => this.damageObstacles(ox, oy, oa, oh, org, od), damageEnvironment: (ex, ey, er, ed) => this.damageEnvironment(ex, ey, er, ed), dt, time: this.run.timeSec },
      !!input?.fire,
    );
  }

  private updateHostNet(dtRaw: number): void {
    this.netSnapshotAccum += dtRaw;
    if (this.netSnapshotAccum >= 1 / NET_SNAPSHOT_HZ) {
      this.netSnapshotAccum = 0;
      this.broadcastSnapshot();
    }
    if (this.netBannerTimer > 0) this.netBannerTimer = Math.max(0, this.netBannerTimer - dtRaw);
  }

  private broadcastSnapshot(): void {
    if (!this.net) return;
    this.net.send({ t: 'snapshot', s: this.buildSnapshot() });
  }

  private buildSnapshot(): Snapshot {
    const players: PlayerNetState[] = [];
    for (const p of this.allPlayers) {
      const pid = p === this.run.player ? this.localPeerId : this.peerByPlayer.get(p) ?? 'peer';
      const w = p.currentWeapon;
      players.push({
        id: pid,
        name: p.netName ?? '玩家',
        characterId: p.def.id,
        color: p.netColor ?? PLAYER_COLORS[0]!,
        team: String(p.team),
        x: p.x,
        y: p.y,
        vx: p.vx,
        vy: p.vy,
        hp: p.hp,
        maxHp: p.maxHp,
        shield: p.shield,
        maxShield: p.maxShield,
        aim: p.aimAngle,
        weaponIndex: p.weaponIndex,
        weaponIds: p.weapons.map((ww) => ww.def.id),
        ammo: w.ammo,
        mag: w.magSize,
        weaponReload: w.reloadTimer,
        state: p.state,
        dead: p.dead,
        beam: p.beamActive,
        beamX: p.beamEndX,
        beamY: p.beamEndY,
        beamColor: p.beamGlow,
        skillActive: p.skillActiveTimer,
        iframe: p.iframe,
        upgradeIds: this.run.upgrades.map((u) => u.id),
        kills: p.kills,
        score: p.score,
      });
    }

    const enemies: EnemyNetState[] = this.enemies.map((e) => ({
      id: e.netId,
      defId: e.def.id,
      x: e.x,
      y: e.y,
      hp: e.hp,
      maxHp: e.maxHp,
      state: e.state,
      elite: e.isElite,
      telegraph: e.telegraph,
    }));

    const boss: BossNetState | null = this.boss
      ? {
          x: this.boss.x,
          y: this.boss.y,
          hp: this.boss.hp,
          maxHp: this.boss.maxHp,
          phase: this.boss.phase,
          dead: this.boss.dead,
          name: this.boss.name,
        }
      : null;

    this.snapProjectileBuf.length = 0;
    this.projectiles.collect(this.snapProjectileBuf);
    const projectiles: ProjectileNetState[] = this.snapProjectileBuf.map((pj) => ({
      x: pj.x,
      y: pj.y,
      vx: Math.cos(pj.angle) * pj.speed,
      vy: Math.sin(pj.angle) * pj.speed,
      radius: pj.radius,
      color: pj.color,
      glow: pj.glow,
      trail: pj.trail,
      kind: pj.kind,
      angle: pj.angle,
    }));

    const pickups: PickupNetState[] = this.pickups.map((p) => ({
      kind: p.kind,
      x: p.x,
      y: p.y,
      weaponId: p.data.weaponId,
      amount: p.data.amount,
      sold: p.data.sold,
    }));

    return {
      tick: ++this.netTick,
      floor: this.run.floor,
      roomKey: this.run.currentRoomKey,
      transitioning: this.mode === 'transition',
      doorLocks: [...this.room.lockedDoors] as string[],
      players,
      enemies,
      boss,
      projectiles,
      pickups,
      gold: this.run.gold,
      phase: this.ended ? (this.overlay.mode === 'victory' ? 'victory' : 'dead') : 'play',
      winnerId: this.winnerId,
      // 自由混战：比赛倒计时与人头目标由房主推进，客户端只负责显示
      matchTimeLeft: this.netMode === 'pk' ? this.pk.timeLeft : undefined,
      killTarget: this.netMode === 'pk' ? this.pk.killTarget : undefined,
      // 阶段与准备倒计时也一起下发：客户端不跑裁判，HUD 却要显示得一模一样
      pkPhase: this.netMode === 'pk' ? this.pk.phase : undefined,
      matchCountdown: this.netMode === 'pk' ? this.pk.countdown : undefined,
    };
  }

  // ------------------------------------------------- 客户端（快照渲染）

  private updateClient(dtRaw: number): void {
    this.lastDt = dtRaw;
    if (this.netBannerTimer > 0) this.netBannerTimer = Math.max(0, this.netBannerTimer - dtRaw);
    if (this.ended) {
      this.particles.update(dtRaw);
      return;
    }
    if (this.host.input.wasPressed('Escape')) {
      this.openOverlay('pause');
      return;
    }
    this.run.timeSec += dtRaw;
    this.sendClientInput(dtRaw);
    if (this.lastSnapshot) this.applySnapshot(this.lastSnapshot, dtRaw);
    const p = this.run.player;
    this.host.renderer.followPlayer(p.x, p.y, p.aimAngle, this.room, dtRaw);
    this.particles.update(dtRaw);
    this.numbers.update(dtRaw);
    this.updateDynamicLights();
    this.host.audio.updateMusic(dtRaw);
  }

  private sendClientInput(dtRaw: number): void {
    const input = this.host.input;
    // 跨帧累积边沿输入（上报频率低于帧率，直接取 wasPressed 会漏键）
    if (input.wasPressed('Space')) this.pendingInput.skill = true;
    if (input.wasPressed('KeyR')) this.pendingInput.reload = true;
    if (input.wasPressed('KeyE')) this.pendingInput.interact = true;
    if (input.wasPressed('Digit1')) this.pendingInput.swap = 0;
    if (input.wasPressed('Digit2')) this.pendingInput.swap = 1;

    this.netInputAccum += dtRaw;
    if (this.netInputAccum < 1 / NET_INPUT_HZ) return;
    this.netInputAccum = 0;
    if (!this.net) return;

    const player = this.run.player;
    const mv = player.dead ? { x: 0, y: 0 } : input.moveVector();
    const pointer = input.pointer;
    const cam = this.host.renderer.camera;
    const worldX = pointer.sx - VIEW_W / 2 + cam.x;
    const worldY = pointer.sy - VIEW_H / 2 + cam.y;
    const aim = Math.atan2(worldY - player.y, worldX - player.x);
    this.net.send({
      t: 'input',
      i: {
        seq: ++this.inputSeq,
        moveX: mv.x,
        moveY: mv.y,
        aim,
        fire: pointer.down && !player.dead,
        skill: this.pendingInput.skill,
        reload: this.pendingInput.reload,
        swap: this.pendingInput.swap,
        interact: this.pendingInput.interact,
      },
    });
    this.pendingInput.skill = false;
    this.pendingInput.reload = false;
    this.pendingInput.interact = false;
    this.pendingInput.swap = -1;
  }

  private applySnapshot(s: Snapshot, dtRaw: number): void {
    // 楼层推进（房主先进下一层时，客户端跟着重新生成地牢）
    if (s.floor > this.run.floor) {
      while (this.run.floor < s.floor) this.run.advanceFloor();
      this.rooms.clear();
      this.roomPickups.clear();
      this.roomShopItems.clear();
      this.host.renderer.clearCache();
      this.clientEnterRoom(s.roomKey);
    } else if (s.roomKey !== this.run.currentRoomKey) {
      this.clientEnterRoom(s.roomKey);
    }
    this.run.gold = s.gold;
    // 自由混战：阶段与倒计时都以房主为准（本地不做任何推算，免得两边不一致）
    if (typeof s.matchTimeLeft === 'number') {
      this.pk.mirror(s.pkPhase ?? 'live', s.matchTimeLeft, s.matchCountdown ?? 0);
    }

    // 玩家：本地玩家写回 run.player，其余写进缓存的远端 Player
    for (const ps of s.players) {
      if (ps.id === this.localPeerId) {
        this.run.player.netName = ps.name;
        this.run.player.netColor = ps.color;
        this.applyPlayerNet(this.run.player, ps, dtRaw);
        this.run.stats.kills = ps.kills;
      } else {
        let rp = this.netPlayersById.get(ps.id);
        if (!rp || rp.def.id !== ps.characterId) {
          rp = new Player(getCharacter(ps.characterId));
          this.netPlayersById.set(ps.id, rp);
          if (!this.allPlayers.includes(rp)) this.allPlayers.push(rp);
        }
        rp.netName = ps.name;
        rp.netColor = ps.color;
        rp.team = ps.team;
        this.applyPlayerNet(rp, ps, dtRaw);
      }
    }
    for (const [id, rp] of [...this.netPlayersById]) {
      if (!s.players.some((ps) => ps.id === id)) {
        this.netPlayersById.delete(id);
        const i = this.allPlayers.indexOf(rp);
        if (i >= 0) this.allPlayers.splice(i, 1);
      }
    }

    // 门锁同步
    this.room.lockedDoors.clear();
    for (const d of s.doorLocks) this.room.lockedDoors.add(d as Dir4);

    // 敌人
    this.enemies.length = 0;
    for (const es of s.enemies) {
      const e = new Enemy(getEnemyDef(es.defId), es.x, es.y, s.floor);
      e.netId = es.id;
      e.hp = es.hp;
      e.maxHp = es.maxHp;
      e.state = es.state as typeof e.state;
      e.isElite = es.elite;
      e.telegraph = es.telegraph;
      e.spawnTimer = 0;
      e.animTime = this.run.timeSec + es.id;
      this.enemies.push(e);
    }

    // 首领
    if (s.boss && !s.boss.dead) {
      const b = new Boss(s.boss.x, s.boss.y, getBossDefForFloor(s.floor));
      b.hp = s.boss.hp;
      b.maxHp = s.boss.maxHp;
      b.phase = s.boss.phase;
      b.animTime = this.run.timeSec;
      this.boss = b;
    } else {
      this.boss = null;
    }

    // 弹丸（仅用于渲染：speed=0、life 极大，客户端不会调用 update）
    this.projectiles.clear();
    for (const ps of s.projectiles) {
      this.projectiles.spawn({
        kind: ps.kind as ProjectileKind,
        team: 'enemy',
        x: ps.x,
        y: ps.y,
        angle: ps.angle,
        speed: 0,
        damage: 0,
        radius: ps.radius,
        life: 999,
        color: ps.color,
        glow: ps.glow ?? ps.color,
        trail: ps.trail ?? ps.color,
      });
    }

    // 拾取物
    this.currentPickups = s.pickups.map((ps) => {
      const pk = new Pickup(ps.kind as PickupKind, ps.x, ps.y, {
        weaponId: ps.weaponId,
        amount: ps.amount,
        sold: ps.sold,
      });
      pk.spawnTimer = 0;
      return pk;
    });

    // 兜底：gameover 消息若丢失，按快照结算（带上快照里的胜者，PK 才能判对）
    if (s.phase !== 'play' && !this.ended) {
      this.onNetGameover(s.phase === 'victory', s.winnerId ?? null);
    }
  }

  private applyPlayerNet(p: Player, ps: PlayerNetState, dtRaw: number): void {
    p.x = ps.x;
    p.y = ps.y;
    p.vx = ps.vx;
    p.vy = ps.vy;
    p.hp = ps.hp;
    p.maxHp = ps.maxHp;
    p.shield = ps.shield;
    p.maxShield = ps.maxShield;
    p.aimAngle = ps.aim;
    if (ps.weaponIndex >= 0 && ps.weaponIndex < p.weapons.length) p.weaponIndex = ps.weaponIndex;
    p.iframe = ps.iframe;
    p.beamActive = ps.beam;
    p.beamEndX = ps.beamX;
    p.beamEndY = ps.beamY;
    p.beamGlow = ps.beamColor;
    p.skillActiveTimer = ps.skillActive;
    p.kills = ps.kills;
    p.score = ps.score;
    p.dead = ps.dead;
    if (ps.dead) {
      p.state = 'dead';
    } else {
      p.deathTimer = 0;
      p.moving = Math.hypot(ps.vx, ps.vy) > 12;
      p.walkPhase += dtRaw * (p.moving ? 8 : 0);
      p.state = p.moving ? 'run' : 'idle';
    }
    p.hitFlash = 0;
  }

  private clientEnterRoom(key: string): void {
    const node = this.run.plan.nodes.get(key);
    if (!node) return;
    const room = this.getRoom(key);
    this.room = room;
    this.world.room = room;
    this.world.floor = this.run.floor;
    this.run.currentRoomKey = key;
    node.visited = true;
    this.run.visited.add(key);
    this.discovered = buildDiscovered(this.run.plan, this.run.visited);
    this.enemies.length = 0;
    this.projectiles.clear();
    this.particles.clear();
    this.numbers.clear();
    this.boss = null;
    if (node.cleared) room.unlockAllDoors();
    else room.lockAllDoors();
    this.host.renderer.snapCamera(this.run.player.x, this.run.player.y);
  }

  private onNetGameover(won: boolean, winnerId: string | null, cause?: string, pkReason?: PkEndReason, winnerName?: string): void {
    if (this.ended) return;
    this.winnerId = winnerId;
    // PK 是自由混战，「won」只是**房主视角**的结果，客户端绝不能照单全收：
    //   房主赢 → 广播 won=true，客户端若采信就会陪着一起显示"胜利"；
    //   客户端赢 → 房主发的是 won=false，客户端就会错误地显示"失败"（老 bug）。
    // 唯一可靠的判据是「胜者是不是我」。
    let localWon = won;
    if (this.netMode === 'pk') {
      localWon = !!winnerId && winnerId === this.localPeerId;
      // 客户端用与房主**完全相同的**函数渲染结算副标题（见 pkMatch.pkOutcomeText），
      // 视角参数是 localPeerId —— 赢家读到的一定是"你…"，不可能读到"对手…"。
      this.pkOutcome = {
        winnerId,
        winnerName: winnerName || this.nameOfPeer(winnerId),
        reason: pkReason ?? 'lastStanding',
        killTarget: this.pk.killTarget,
      };
      this.cause = pkOutcomeText(this.pkOutcome, this.localPeerId);
    } else if (cause) {
      this.cause = cause;
    }
    this.finishRun(localWon);
  }

  /** peerId → 昵称（快照缓存优先，退回开局名单，最后兜底「对手」）。 */
  private nameOfPeer(peerId: string | null): string {
    if (!peerId) return '对手';
    return (
      this.netPlayersById.get(peerId)?.netName ?? this.peers.find((p) => p.id === peerId)?.name ?? '对手'
    );
  }

  /** 按阵营（= peerId）反查玩家；单机/合作里 team 不是 peerId，一律返回 null。 */
  private playerByTeam(team: string): Player | null {
    for (const p of this.allPlayers) {
      if (p.team === team) return p;
    }
    return null;
  }

  /** 合作模式的一局结束判定：全队阵亡即失败。（自由混战走 updatePkMatch。） */
  private checkNetEnd(): void {
    if (this.netRole !== 'host' || this.ended) return;
    if (this.netMode === 'pk') return;
    if (this.allPlayers.every((p) => p.dead)) {
      this.cause = '全队阵亡';
      this.finishRun(false);
    }
  }

  /** 把玩家拍平成裁判要的纯数据（身份 = peerId，本地玩家即 localPeerId）。 */
  private pkFighters(): PkFighter[] {
    return this.allPlayers.map((p) => ({
      id: p === this.run.player ? this.localPeerId : this.peerByPlayer.get(p) ?? 'peer',
      name: p.netName ?? '玩家',
      alive: !p.dead,
      kills: p.kills,
    }));
  }

  /**
   * 自由混战：推进一步比赛裁判（只有房主跑）。
   *
   * 全部规则都在 `PkMatch` 里 —— 「人数不够不开赛」也归它管，
   * 所以单人建房不会再一进门就弹出「PK 胜利」（真机 bug，需求 28 重写）。
   */
  private updatePkMatch(dtRaw: number): void {
    if (this.netRole !== 'host' || this.ended) return;
    const outcome = this.pk.update(dtRaw, this.pkFighters());
    if (!outcome) return;
    this.pkOutcome = outcome;
    this.winnerId = outcome.winnerId;
    // 结算副标题按**本地视角**渲染：赢家永远读到"你…"。
    this.cause = pkOutcomeText(outcome, this.localPeerId);
    this.finishRun(outcome.winnerId !== null && outcome.winnerId === this.localPeerId);
  }

  /**
   * 自由混战「再来一次」：**房间不散**，直接请求房主开下一局。
   *
   * 房主收到的新 `start` 会让所有人重建 GameplayScene ——
   * 地图、人头、计时、掉落全部归零，这就是"场景重置"。
   * 客户端不能自己开，只能请房主代劳（房主权威）。
   */
  private requestRematch(): void {
    if (!this.net) return;
    this.rematchWaiting = true;
    this.overlay.resultNotice = '正在开始下一局…';
    this.netBanner = '正在开始下一局…';
    this.netBannerTimer = 3;
    if (this.netRole === 'host') this.net.send({ t: 'rematch' });
    else this.net.send({ t: 'rematchRequest' });
  }

  private autoGrantUpgrade(count: number): void {
    if (this.netMode === 'pk') return; // PK 不共享强化池，避免不公平
    for (let i = 0; i < count; i++) {
      const options = this.run.rollUpgrades(3);
      if (!options.length) return;
      const pick = options[Math.floor(this.run.rng.next() * options.length)]!;
      this.run.addUpgrade(pick);
    }
    for (let i = 1; i < this.allPlayers.length; i++) this.allPlayers[i]!.refreshFromMods(this.run.mods, true);
    this.netBanner = '全队获得了一次强化';
    this.netBannerTimer = 1.8;
  }

  dispose(): void {
    this.particles.clear();
    this.projectiles.clear();
    this.numbers.clear();
    this.dashHits.clear();
    this.host.renderer.clearCache();
  }
}

/** 由联机配色推导出一个角色调色板（复用 drawPlayer 的配色覆盖参数）。 */
function netPalette(color: string): CharacterPalette {
  return {
    primary: color,
    secondary: darken(color, 0.28),
    accent: lighten(color, 0.32),
    skin: '#e8b98a',
    cape: darken(color, 0.5),
    glow: lighten(color, 0.18),
  };
}

/** 玩家头顶名字标签（联机模式）。 */
function drawPlayerTag(ctx: CanvasRenderingContext2D, player: Player, isLocal: boolean): void {
  const name = player.netName ?? (isLocal ? '你' : '玩家');
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.font = '600 12px "PingFang SC","Segoe UI",sans-serif';
  const y = player.y - player.radius - 16;
  const w = ctx.measureText(name).width + 14;
  ctx.fillStyle = 'rgba(10,8,18,0.6)';
  ctx.fillRect(player.x - w / 2, y - 15, w, 17);
  ctx.fillStyle = isLocal ? '#fff4d8' : (player.netColor ?? '#cfe8ff');
  ctx.fillText(name, player.x, y);
  ctx.restore();
}

/** 近战蓄力指示环（需求 30）：蓄力进度 = 一段从正上方顺时针生长的弧，满蓄力变金色并轻微脉冲。 */
function drawMeleeChargeRing(ctx: CanvasRenderingContext2D, player: Player): void {
  const ratio = clamp(player.meleeCharge / MELEE_CHARGE_TIME, 0, 1);
  const full = ratio >= 1;
  const r = player.radius + 13;
  ctx.save();
  ctx.lineCap = 'round';
  // 底环
  ctx.strokeStyle = 'rgba(255,255,255,0.16)';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(player.x, player.y, r, 0, TAU);
  ctx.stroke();
  // 进度弧
  ctx.strokeStyle = full ? '#ffd479' : '#9fe8ff';
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.arc(player.x, player.y, r, -Math.PI / 2, -Math.PI / 2 + TAU * ratio);
  ctx.stroke();
  if (full) {
    const pulse = 0.45 + 0.45 * Math.sin(performance.now() / 70);
    ctx.globalAlpha = pulse;
    ctx.strokeStyle = '#ffd479';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(player.x, player.y, r + 6, 0, TAU);
    ctx.stroke();
  }
  ctx.restore();
}

function describePickup(p: Pickup, finalFloor: boolean): string {
  switch (p.kind) {
    case 'weapon': {
      // 地面上带 amount 的是玩家自己换下来的枪，顺带把剩余弹量显示出来
      const def = getWeaponDef(p.data.weaponId ?? WEAPONS[0]!.id);
      const left = typeof p.data.amount === 'number' ? `（余弹 ${p.data.amount}）` : '';
      return `拾取武器 ${def.name}${left}`;
    }
    case 'chest':
      return p.data.sold ? '宝箱已开启' : '打开宝箱';
    case 'upgradeOrb':
      return '吸收强化宝珠';
    case 'portal':
      return finalFloor ? '摧毁深渊之心 · 通关结算' : '进入传送门 · 前往下一层';
    default:
      return '互动';
  }
}
