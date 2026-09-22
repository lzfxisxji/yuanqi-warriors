/**
 * 自由混战裁判（`src/net/pkMatch.ts`）的纯逻辑回归。
 *
 * 这份文件存在的理由就是那个真机 bug：
 *   **单人建房 → 一进门就弹出「PK 胜利」，副标题写着"XX 成为最后的幸存者"。**
 * 老代码把判定写在场景里，条件是 `alive.length <= 1`，单人房第 1 帧就成立。
 * 现在规则抽成状态机，「只有一个人时永远不开赛」变成一条可以直接断言的句子。
 */
import { describe, expect, test } from 'vitest';
import { PK_KILL_TARGET, PK_MATCH_SECONDS, PK_MIN_PLAYERS, PK_START_COUNTDOWN } from '../src/data/config';
import { PkMatch, pkIsDraw, pkOutcomeText, type PkFighter, type PkOutcome } from '../src/net/pkMatch';

function fighter(id: string, kills = 0, alive = true): PkFighter {
  return { id, name: id, alive, kills };
}

/**
 * 推进比赛若干秒，返回**第一次**出现的结果。
 * @returns 结果为 null 表示这段时间里比赛没有结束。
 */
function run(match: PkMatch, seconds: number, fighters: readonly PkFighter[], dt = 1 / 60): PkOutcome | null {
  const frames = Math.ceil(seconds / dt);
  for (let i = 0; i < frames; i++) {
    const out = match.update(dt, fighters);
    if (out) return out;
  }
  return null;
}

/** 把人齐 → 倒计时 → 开打的流程走完，进入 live。 */
function startLive(match: PkMatch, fighters: readonly PkFighter[]): void {
  run(match, PK_START_COUNTDOWN + 0.5, fighters);
  expect(match.phase).toBe('live');
}

describe('自由混战裁判：开赛门（人数不足绝不开赛）', () => {
  test('回归：房间里只有自己一个人 → 一直停在 waiting，永远不出结果', () => {
    const pk = new PkMatch();
    const solo = [fighter('me')];

    // 整整 5 分钟：老代码在第 1 帧就会判「最后的幸存者」
    expect(run(pk, 300, solo)).toBe(null);
    expect(pk.phase).toBe('waiting');
    expect(pk.outcome).toBe(null);
    // 训练/闲逛期间计时不走，也不该"看起来已经开打很久了"
    expect(pk.timeLeft).toBe(PK_MATCH_SECONDS);
  });

  test('人齐后才进入倒计时；倒计时期间也不判定', () => {
    const pk = new PkMatch();
    const two = [fighter('me'), fighter('rival')];

    pk.update(1 / 60, two);
    expect(pk.phase).toBe('starting');
    expect(pk.countdown).toBe(PK_START_COUNTDOWN);

    // 倒计时走到一半时即使只剩一个人（对手还没落地），也不许收场
    expect(run(pk, PK_START_COUNTDOWN / 2, [fighter('me')])).toBe(null);
    expect(pk.phase).toBe('waiting'); // 人不够 → 退回等待，倒计时归零

    startLive(pk, two);
    expect(pk.timeLeft).toBeGreaterThan(PK_MATCH_SECONDS - 1);
  });

  test('开始倒计时到点才开打，比赛时间只在 live 阶段递减', () => {
    const pk = new PkMatch();
    const two = [fighter('me'), fighter('rival')];
    pk.update(1 / 60, two);
    expect(pk.timeLeft).toBe(PK_MATCH_SECONDS); // starting 阶段不动
    startLive(pk, two);
    run(pk, 2, two);
    expect(pk.timeLeft).toBeLessThan(PK_MATCH_SECONDS - 1.5);
  });

  test('最少人数就是 2 —— 常量被改动的话这条会先炸', () => {
    expect(PK_MIN_PLAYERS).toBe(2);
  });
});

describe('自由混战裁判：三个结束条件', () => {
  test('人头达标 → 提前结束，胜者是人头够了的那一位', () => {
    const pk = new PkMatch();
    const me = fighter('me');
    const rival = fighter('rival');
    startLive(pk, [me, rival]);

    rival.kills = PK_KILL_TARGET;
    const out = run(pk, 1, [me, rival]);
    expect(out).toMatchObject({ winnerId: 'rival', reason: 'killTarget', killTarget: PK_KILL_TARGET });
    expect(pk.phase).toBe('over');
  });

  test('差一个人头不算 —— 门槛是「达到」', () => {
    const pk = new PkMatch();
    const me = fighter('me');
    const rival = fighter('rival');
    startLive(pk, [me, rival]);

    me.kills = PK_KILL_TARGET - 1;
    expect(run(pk, 1, [me, rival])).toBe(null);
    expect(pk.phase).toBe('live');
  });

  test('结果只出一次：over 之后无论怎么调都返回 null', () => {
    const pk = new PkMatch();
    const me = fighter('me');
    const rival = fighter('rival');
    startLive(pk, [me, rival]);
    me.kills = 99;

    const first = run(pk, 1, [me, rival]);
    expect(first?.winnerId).toBe('me');
    expect(run(pk, 5, [me, rival])).toBe(null);
    expect(run(pk, 5, [rival])).toBe(null);
  });

  test('时间到 → 按人头数排名，不再只看"活到最后"', () => {
    const pk = new PkMatch();
    const me = fighter('me', 4);
    const rival = fighter('rival', 1);
    startLive(pk, [me, rival]);

    pk.timeLeft = 0.01;
    const out = run(pk, 1, [me, rival]);
    expect(out).toMatchObject({ winnerId: 'me', reason: 'timeUp' });
  });

  test('时间到人头打平 / 双方都是 0 → 平局（winnerId 为 null）', () => {
    for (const kills of [0, 3]) {
      const pk = new PkMatch();
      const me = fighter('me', kills);
      const rival = fighter('rival', kills);
      startLive(pk, [me, rival]);
      pk.timeLeft = 0.01;
      const out = run(pk, 1, [me, rival]);
      expect(out).toMatchObject({ winnerId: null, reason: 'timeUp' });
      expect(pkIsDraw(out)).toBe(true);
    }
  });

  test('最后幸存者：只有"开过赛后确实有人退场"才算', () => {
    const pk = new PkMatch();
    const me = fighter('me');
    const rival = fighter('rival');
    startLive(pk, [me, rival]);

    rival.alive = false;
    const out = run(pk, 1, [me, rival]);
    expect(out).toMatchObject({ winnerId: 'me', reason: 'lastStanding' });
  });

  test('对手直接退房（从名单里消失）也算最后幸存者', () => {
    const pk = new PkMatch();
    const me = fighter('me');
    startLive(pk, [me, fighter('rival')]);
    const out = run(pk, 1, [me]);
    expect(out).toMatchObject({ winnerId: 'me', reason: 'lastStanding' });
  });

  test('开赛后全员阵亡 → wipeout，没有胜者', () => {
    const pk = new PkMatch();
    const me = fighter('me');
    const rival = fighter('rival');
    startLive(pk, [me, rival]);

    me.alive = false;
    rival.alive = false;
    const out = run(pk, 1, [me, rival]);
    expect(out).toMatchObject({ winnerId: null, reason: 'wipeout' });
    expect(pkIsDraw(out)).toBe(true);
  });

  test('4 人局剩 1 人 → 最后幸存者（人多也一样）', () => {
    const pk = new PkMatch();
    const all = [fighter('a'), fighter('b'), fighter('c'), fighter('d')];
    startLive(pk, all);
    all[1]!.alive = false;
    all[2]!.alive = false;
    all[3]!.alive = false;
    const out = run(pk, 1, all);
    expect(out).toMatchObject({ winnerId: 'a', reason: 'lastStanding' });
  });
});

describe('自由混战裁判：客户端镜像', () => {
  test('mirror() 只同步显示用的阶段与倒计时，不做任何判定', () => {
    const pk = new PkMatch();
    pk.mirror('live', 42, 0);
    expect(pk.phase).toBe('live');
    expect(pk.timeLeft).toBe(42);

    pk.mirror('waiting', 180, 3);
    expect(pk.phase).toBe('waiting');

    // 已经 over 的场景不被旧快照改写（结算界面不能被打回进行中）
    const over = new PkMatch();
    startLive(over, [fighter('me'), fighter('rival')]);
    over.update(1 / 60, [fighter('me', 99), fighter('rival')]);
    expect(over.phase).toBe('over');
    over.mirror('live', 60, 0);
    expect(over.phase).toBe('over');
  });
});

describe('自由混战结算文案：按本地视角渲染', () => {
  const win: PkOutcome = { winnerId: 'me', winnerName: '房主', reason: 'killTarget', killTarget: 10 };

  test('赢家永远读到"你…"，输家读到胜者的昵称', () => {
    expect(pkOutcomeText(win, 'me')).toContain('你率先击杀 10 人');
    expect(pkOutcomeText(win, 'rival')).toContain('房主 率先击杀 10 人');
  });

  test('最后幸存者 / 时间到 / 全员阵亡的措辞', () => {
    expect(pkOutcomeText({ ...win, reason: 'lastStanding' }, 'me')).toBe('你成为了最后的幸存者');
    expect(pkOutcomeText({ ...win, reason: 'lastStanding' }, 'rival')).toBe('房主 成为最后的幸存者');
    expect(pkOutcomeText({ ...win, reason: 'timeUp' }, 'me')).toContain('你击杀数最高');
    expect(pkOutcomeText({ ...win, reason: 'timeUp' }, 'rival')).toContain('房主 击杀数最高');
  });

  test('平局对两边都写成平局（谁也没赢）', () => {
    const draw: PkOutcome = { winnerId: null, winnerName: '', reason: 'timeUp', killTarget: 10 };
    expect(pkOutcomeText(draw, 'me')).toContain('平局');
    expect(pkOutcomeText(draw, 'rival')).toContain('平局');
    expect(pkIsDraw(draw)).toBe(true);
    expect(pkIsDraw(null)).toBe(false);
  });
});
