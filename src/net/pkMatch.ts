/**
 * 自由混战（PK）的比赛裁判 —— **纯逻辑**：不碰渲染、不碰网络、不碰场景。
 *
 * 为什么单独抽一个文件：胜负判定以前散在 `GameplayScene.checkNetEnd()` 里，
 * 和"哪一帧调用"、"玩家数组此刻长什么样"耦合在一起，于是踩了这个坑 ——
 *
 *   单人建房 → `allPlayers.length === 1` → `alive.length <= 1` 成立
 *            → 第 1 帧就判「最后的幸存者」→ 一进门弹出「PK 胜利」。
 *
 * 抽成状态机之后，规则变成一句一句可断言的话，用不着开画布、开浏览器就能验：
 *
 *   waiting  人数不够（< PK_MIN_PLAYERS）：比赛**不开始**，计时不走，绝不判负
 *   starting 开赛倒计时（双方入场落地的那几秒）
 *   live     比赛进行中，三个结束条件按优先级判定
 *   over     已出结果，此后一律返回 null（结果只发一次）
 *
 * 判定优先级（live）：**人头达标 → 时间到按人头排名 → 最后的幸存者**。
 * 「最后的幸存者」额外要求"开局确实有人在、且现在比开局少"——
 * 只有一个玩家时永远不成立，单人房不可能秒胜。
 */
import { PK_KILL_TARGET, PK_MATCH_SECONDS, PK_MIN_PLAYERS, PK_START_COUNTDOWN } from '../data/config';

export type PkPhase = 'waiting' | 'starting' | 'live' | 'over';

/** 比赛结束的原因（结算文案由它决定，两边客户端各自渲染，不靠字符串对暗号）。 */
export type PkEndReason =
  /** 有人击杀够了，提前结束 */
  | 'killTarget'
  /** 时间到，按人头数排名 */
  | 'timeUp'
  /** 只剩下最后一名幸存者 */
  | 'lastStanding'
  /** 全员阵亡，无人胜出 */
  | 'wipeout';

/** 裁判视角下的一名参赛者（由场景每帧从 Player 拍平而成）。 */
export interface PkFighter {
  /** 稳定身份 = peerId。 */
  id: string;
  /** 结算文案用昵称。 */
  name: string;
  alive: boolean;
  kills: number;
}

/** 一局的结果。`winnerId === null` 即平局 / 无人胜出。 */
export interface PkOutcome {
  winnerId: string | null;
  winnerName: string;
  reason: PkEndReason;
  killTarget: number;
}

export class PkMatch {
  phase: PkPhase = 'waiting';
  /** 本局剩余秒数（只在 live 阶段走动）。 */
  timeLeft = PK_MATCH_SECONDS;
  /** 开赛倒计时（只在 starting 阶段走动）。 */
  countdown = PK_START_COUNTDOWN;
  readonly killTarget = PK_KILL_TARGET;
  readonly minPlayers = PK_MIN_PLAYERS;
  readonly matchSeconds = PK_MATCH_SECONDS;
  /** 已出的结果（over 之后只读，供结算界面反复取用）。 */
  outcome: PkOutcome | null = null;

  /** 开赛那一刻的在场人数 —— 「最后幸存者」的判定基准。 */
  private aliveAtStart = 0;

  /** 客户端：照房主快照镜像一份，只用于显示（不做本地判定）。 */
  mirror(phase: PkPhase, timeLeft: number, countdown: number): void {
    if (this.phase === 'over') return;
    this.phase = phase;
    this.timeLeft = timeLeft;
    this.countdown = countdown;
  }

  /**
   * 推进一帧（只有房主调用）。
   *
   * @returns 本局刚刚分出结果时返回该结果，否则返回 null；同一局只会返回一次。
   */
  update(dt: number, fighters: readonly PkFighter[]): PkOutcome | null {
    if (this.phase === 'over') return null;

    // --- 未开赛：人数不足就原地等待，不判定、不计时 ---------------
    if (this.phase !== 'live') {
      if (fighters.length < this.minPlayers) {
        this.phase = 'waiting';
        this.countdown = PK_START_COUNTDOWN;
        this.timeLeft = PK_MATCH_SECONDS;
        return null;
      }
      if (this.phase === 'waiting') {
        // 人齐了：进入开赛倒计时（下一帧开始走秒）
        this.phase = 'starting';
        this.countdown = PK_START_COUNTDOWN;
        return null;
      }
      this.countdown = Math.max(0, this.countdown - dt);
      if (this.countdown > 0) return null;
      this.phase = 'live';
      this.timeLeft = PK_MATCH_SECONDS;
      this.aliveAtStart = fighters.filter((f) => f.alive).length;
      return null;
    }

    // --- 比赛中 ---------------------------------------------------
    this.timeLeft = Math.max(0, this.timeLeft - dt);
    return this.judge(fighters);
  }

  /** 三个结束条件，按优先级依次判定。 */
  private judge(fighters: readonly PkFighter[]): PkOutcome | null {
    // 1) 人头达标：谁先够谁赢（并列时取人头多的那一位）
    const reached = fighters.filter((f) => f.kills >= this.killTarget);
    if (reached.length > 0) {
      let best = reached[0]!;
      for (const f of reached) if (f.kills > best.kills) best = f;
      return this.setOver(best.id, best.name, 'killTarget');
    }

    // 2) 时间到：按人头数排名，并列 / 全 0 → 平局
    if (this.timeLeft <= 0) {
      const leader = this.killLeader(fighters);
      return leader ? this.setOver(leader.id, leader.name, 'timeUp') : this.setOver(null, '', 'timeUp');
    }

    // 3) 最后幸存者：**必须"开局有人在、现在比开局少"**。
    //    少了这个前提，单人房（开局就只有 1 人）会在第 1 帧被判胜 —— 真机 bug。
    const alive = fighters.filter((f) => f.alive);
    if (alive.length <= 1 && this.aliveAtStart >= this.minPlayers && alive.length < this.aliveAtStart) {
      const last = alive[0];
      return last ? this.setOver(last.id, last.name, 'lastStanding') : this.setOver(null, '', 'wipeout');
    }
    return null;
  }

  /** 人头最高者；并列或全 0 时返回 null（= 平局）。 */
  private killLeader(fighters: readonly PkFighter[]): PkFighter | null {
    let best: PkFighter | null = null;
    let tied = false;
    for (const f of fighters) {
      if (!best || f.kills > best.kills) {
        best = f;
        tied = false;
      } else if (f.kills === best.kills) {
        tied = true;
      }
    }
    if (!best || best.kills <= 0 || tied) return null;
    return best;
  }

  private setOver(winnerId: string | null, winnerName: string, reason: PkEndReason): PkOutcome {
    this.phase = 'over';
    this.timeLeft = 0;
    this.outcome = { winnerId, winnerName, reason, killTarget: this.killTarget };
    return this.outcome;
  }
}

/**
 * 结算副标题 —— **按本地玩家视角**渲染。
 *
 * 房主和客户端用的是同一个函数，所以「赢了的人永远看到"你…"」这件事由构造保证，
 * 不需要再把房主视角的字符串发过来（那样赢家会读到"对手成为了最后的幸存者"）。
 */
export function pkOutcomeText(o: PkOutcome, localPeerId: string): string {
  // 没胜者就一律走"平局"文案：绝不能渲染出"对手成为了最后的幸存者"这种鬼话
  if (o.winnerId === null) {
    return o.reason === 'wipeout' ? '全员阵亡 · 无人幸存' : '时间到 · 双方击杀数打平，这局算平局';
  }
  const isMe = o.winnerId === localPeerId;
  switch (o.reason) {
    case 'killTarget':
      return isMe
        ? `你率先击杀 ${o.killTarget} 人，拿下这一局`
        : `${o.winnerName || '对手'} 率先击杀 ${o.killTarget} 人`;
    case 'lastStanding':
      return isMe ? '你成为了最后的幸存者' : `${o.winnerName || '对手'} 成为最后的幸存者`;
    case 'timeUp':
      if (!o.winnerId) return '时间到 · 双方击杀数打平，这局算平局';
      return isMe ? '时间到 · 你击杀数最高' : `时间到 · ${o.winnerName || '对手'} 击杀数最高`;
    case 'wipeout':
      return '全员阵亡 · 无人幸存';
    default:
      return '';
  }
}

/** 是否是"没赢家"的结局（结算抬头写「PK 平局」而不是「PK 失败」）。 */
export function pkIsDraw(o: PkOutcome | null): boolean {
  return o !== null && o.winnerId === null;
}
