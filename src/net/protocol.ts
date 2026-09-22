/**
 * 联机协议：客户端 ↔ 中继服务器 ↔ 房主 之间传递的所有消息与快照结构。
 *
 * 架构：房主（创建房间者）跑权威模拟，每帧把世界状态打包成 Snapshot 广播给其他人；
 * 其他玩家只上报自己的输入，并照快照渲染。中继服务器是"哑管道"，不跑任何游戏逻辑。
 *
 * 所有结构都是纯数据，方便单元测试做序列化往返校验。
 */

import type { PkEndReason, PkPhase } from './pkMatch';

export type NetMode = 'coop' | 'pk';

/** 一名玩家的联网身份（大厅与对局通用）。 */
export interface PeerInfo {
  id: string;
  name: string;
  characterId: string;
  color: string;
  isHost: boolean;
  /** 阵营：合作模式统一为 'heroes'；PK 模式为各自 peerId（自由混战）。 */
  team: string;
}

/** 单帧输入（客户端 → 房主）。 */
export interface PlayerInput {
  seq: number;
  moveX: number;
  moveY: number;
  /** 世界瞄准角（弧度），由客户端用自身相机换算。 */
  aim: number;
  fire: boolean;
  skill: boolean;
  reload: boolean;
  /** -1 表示不切换，0/1 表示切到对应武器槽。 */
  swap: number;
  interact: boolean;
}

/** 一名玩家的网络状态（快照内，供远端渲染）。 */
export interface PlayerNetState {
  id: string;
  name: string;
  /** 角色 id（远端据此重建 Player 以复用美术）。 */
  characterId: string;
  color: string;
  team: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  hp: number;
  maxHp: number;
  shield: number;
  maxShield: number;
  aim: number;
  weaponIndex: number;
  weaponIds: string[];
  ammo: number;
  mag: number;
  weaponReload: number;
  state: string;
  dead: boolean;
  beam: boolean;
  beamX: number;
  beamY: number;
  beamColor: string;
  skillActive: number;
  iframe: number;
  upgradeIds: string[];
  kills: number;
  score: number;
}

/** 一只敌人的网络状态（按房主分配的 netId 稳定匹配）。 */
export interface EnemyNetState {
  id: number;
  defId: string;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  state: string;
  elite: boolean;
  /** 攻击前摇进度 0..1（远端用来画预警圈）。 */
  telegraph: number;
}

export interface BossNetState {
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  phase: number;
  dead: boolean;
  name: string;
}

export interface ProjectileNetState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  color: string;
  /** 外发光色（渲染用） */
  glow?: string;
  /** 拖尾色（渲染用） */
  trail?: string;
  kind: string;
  angle: number;
}

export interface PickupNetState {
  kind: string;
  x: number;
  y: number;
  weaponId?: string;
  amount?: number;
  sold?: boolean;
}

export type GamePhase = 'play' | 'victory' | 'dead';

/** 房主广播的世界快照。 */
export interface Snapshot {
  tick: number;
  floor: number;
  roomKey: string;
  /** 房主是否正处于穿门黑场过渡（远端同步播放）。 */
  transitioning: boolean;
  /** 当前锁住的门方向（远端据此绘制封闭门）。 */
  doorLocks: string[];
  players: PlayerNetState[];
  enemies: EnemyNetState[];
  boss: BossNetState | null;
  projectiles: ProjectileNetState[];
  pickups: PickupNetState[];
  gold: number;
  phase: GamePhase;
  /**
   * 对局结束时的胜者 peerId（未结束 / 平局为 null）。
   * PK 是自由混战，「谁赢了」只有房主知道，客户端必须靠这个字段
   * 才能在 gameover 消息丢失时也判对自己的胜负（见 onNetGameover）。
   */
  winnerId?: string | null;
  /** 自由混战：本局剩余秒数（客户端照它画倒计时，只由房主推进）。 */
  matchTimeLeft?: number;
  /** 自由混战：提前结束比赛需要的人头数。 */
  killTarget?: number;
  /**
   * 自由混战：比赛阶段（`waiting` 等齐人 / `starting` 开赛倒计时 / `live` 进行中）。
   *
   * 客户端不跑裁判，只把房主的阶段照搬到 HUD 上 —— 否则会出现
   * "房主还在等对手进场，客户端却已经在倒数"这种两边不一致。
   */
  pkPhase?: PkPhase;
  /** 自由混战：开赛倒计时剩余秒数（仅 `starting` 阶段有意义）。 */
  matchCountdown?: number;
}

// ---------------------------------------------------------------- 消息

/** 客户端 → 服务器 */
export type ClientMsg =
  | { t: 'create'; mode: NetMode; name: string; characterId: string; color: string }
  | { t: 'join'; code: string; name: string; characterId: string; color: string }
  | { t: 'leave' }
  | { t: 'start' }
  | { t: 'input'; i: PlayerInput }
  | { t: 'upgradePick'; id: string }
  /** 房主 → 服务器：把一次强化选择推送给指定玩家。 */
  | { t: 'upgradeChoice'; to: string; options: string[] }
  /** 房主 → 服务器：对局结束（胜利 / 失败 / PK 胜者）。 */
  | {
      t: 'gameover';
      won: boolean;
      winnerId: string | null;
      reason: string;
      /** 闯关模式的失败原因（`被 XX 击倒在第 N 层`）。 */
      cause?: string;
      /** 自由混战：结束原因。结算文案由两边各自按本地视角渲染（见 pkOutcomeText）。 */
      pkReason?: PkEndReason;
      /** 自由混战：胜者昵称（败者要看到"XX 成为最后的幸存者"）。 */
      winnerName?: string;
    }
  /**
   * 房主 → 服务器：**再开一局**（自由混战结算页的「再来一次」）。
   *
   * 不能复用 `start`：中继里 `start` 有 `room.started` 门闩，只会生效一次。
   * `rematch` 会让房间所有人收到一条新的 `start`（新种子），
   * 于是每个人都会**重建一个全新的 GameplayScene** —— 场景、人头、计时全部归零。
   */
  | { t: 'rematch' }
  /** 客户端 → 服务器：请求房主再开一局（房主权威，客户端不能自己开）。 */
  | { t: 'rematchRequest' }
  | { t: 'snapshot'; s: Snapshot };

/** 服务器 → 客户端 */
export type ServerMsg =
  | { t: 'created'; code: string; peerId: string; mode: NetMode }
  | { t: 'joined'; code: string; peerId: string; mode: NetMode; peers: PeerInfo[] }
  | { t: 'peerJoined'; peer: PeerInfo }
  | { t: 'peerLeft'; peerId: string }
  | { t: 'peerList'; peers: PeerInfo[] }
  | { t: 'start'; seed: number; floor: number; mode: NetMode; peers: PeerInfo[] }
  | { t: 'input'; from: string; i: PlayerInput }
  | { t: 'snapshot'; s: Snapshot }
  /** 房主收：某客户端回传的强化选择（带发送者 id）。 */
  | { t: 'upgradePick'; from: string; id: string }
  | { t: 'upgradeChoice'; options: string[] }
  | {
      t: 'gameover';
      won: boolean;
      winnerId: string | null;
      reason: string;
      cause?: string;
      pkReason?: PkEndReason;
      winnerName?: string;
    }
  /** 房主收：有客户端请求「再来一次」（自由混战）。 */
  | { t: 'rematchRequest'; from: string }
  | { t: 'error'; message: string }
  | { t: 'closed' };

/** 生成随机房间号：4 位大写字母 + 数字，去掉易混字符（0/O/1/I/L）。 */
export function generateRoomCode(len = 4): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let out = '';
  let seed = (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
  for (let i = 0; i < len; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    out += alphabet[seed % alphabet.length];
  }
  return out;
}

/** 房主用于按加入顺序给玩家分配配色。 */
export function playerColor(index: number): string {
  const palette = ['#5cc8ff', '#ff7ae0', '#7ef2c0', '#ffd479', '#ff8a5a', '#b78aff'];
  return palette[index % palette.length]!;
}
