/**
 * 中继服务器冒烟测试：`npm run smoke:relay`
 *
 * 在独立端口拉起 server/relay.mjs，模拟两个 WebSocket 客户端走完
 * create → join → start → input → snapshot → gameover → leave 全流程，
 * 并校验权限（非房主 snapshot 被忽略）与房间生命周期（房主离开 → closed）。
 *
 * 退出码 0 = 全部通过。
 */
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';

const PORT = Number(process.env.SMOKE_PORT ?? 8799);
const URL = `ws://127.0.0.1:${PORT}`;
const results = [];
function ok(name, cond) {
  results.push([name, !!cond]);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
}

const server = spawn(process.execPath, ['server/relay.mjs'], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (d) => process.stdout.write(`[relay] ${d}`));
server.stderr.on('data', (d) => process.stderr.write(`[relay-err] ${d}`));

function client() {
  const ws = new WebSocket(URL);
  const queue = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    const w = waiters.shift();
    if (w) w.fn(msg);
    else queue.push(msg);
  });
  return {
    ws,
    open: () => new Promise((res) => ws.on('open', res)),
    send: (m) => ws.send(JSON.stringify(m)),
    next: (timeout = 2000) =>
      new Promise((res, rej) => {
        if (queue.length) return res(queue.shift());
        const w = { fn: null };
        const t = setTimeout(() => {
          const i = waiters.indexOf(w);
          if (i >= 0) waiters.splice(i, 1); // 关键：超时的等待者必须移除，否则会吞掉下一条消息
          rej(new Error('等待消息超时'));
        }, timeout);
        w.fn = (m) => {
          clearTimeout(t);
          res(m);
        };
        waiters.push(w);
      }),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await sleep(700); // 等服务器起来
  const a = client();
  const b = client();
  await Promise.all([a.open(), b.open()]);

  // 1) 创建房间
  a.send({ t: 'create', mode: 'coop', name: 'A', characterId: 'wolfshade', color: '#5cc8ff' });
  const created = await a.next();
  ok('create → created（4 位房间号）', created.t === 'created' && /^[A-Z0-9]{4}$/.test(created.code));
  const code = created.code;

  // 2) 加入房间
  b.send({ t: 'join', code, name: 'B', characterId: 'sting', color: '#ff7ae0' });
  const joined = await b.next();
  ok('join → joined（含 2 人名单）', joined.t === 'joined' && joined.peers.length === 2);
  const peerJoined = await a.next();
  ok('房主收到 peerJoined（含名字/角色）', peerJoined.t === 'peerJoined' && peerJoined.peer.name === 'B' && peerJoined.peer.characterId === 'sting');

  // 3) 房主开始
  a.send({ t: 'start' });
  const startA = await a.next();
  const startB = await b.next();
  ok('start 广播（含 seed/peers）', startA.t === 'start' && typeof startA.seed === 'number' && startB.peers.length === 2);

  // 4) 客户端上报输入 → 房主收到
  b.send({ t: 'input', i: { seq: 1, moveX: 1, moveY: 0, aim: 0.5, fire: true, skill: false, reload: false, swap: -1, interact: false } });
  const gotInput = await a.next();
  ok('input 转发到房主（带 from）', gotInput.t === 'input' && gotInput.from === joined.peerId && gotInput.i.moveX === 1);

  // 5) 房主广播快照 → 客户端收到
  const snap = { tick: 1, floor: 1, roomKey: '0,0', transitioning: false, doorLocks: [], players: [], enemies: [], boss: null, projectiles: [], pickups: [], gold: 0, phase: 'play' };
  a.send({ t: 'snapshot', s: snap });
  const gotSnap = await b.next();
  ok('snapshot 广播到客户端', gotSnap.t === 'snapshot' && gotSnap.s.roomKey === '0,0');

  // 6) 非房主发 snapshot 应被忽略
  let leaked = false;
  b.send({ t: 'snapshot', s: { ...snap, tick: 99 } });
  try {
    const m = await a.next(400);
    if (m.t === 'snapshot' && m.s.tick === 99) leaked = true;
  } catch {
    /* 超时即正确（未泄漏） */
  }
  ok('非房主 snapshot 被忽略', !leaked);

  // 7) 结算广播
  a.send({ t: 'gameover', won: true, winnerId: null, reason: 'coop' });
  const overA = await a.next();
  const overB = await b.next();
  ok('gameover 广播（含房主）', overA.t === 'gameover' && overB.t === 'gameover' && overB.won === true);

  // 8) 加入已开始房间应报错
  const c = client();
  await c.open();
  c.send({ t: 'join', code, name: 'C', characterId: 'bulwark', color: '#7ef2c0' });
  const err = await c.next();
  ok('已开始的房间拒绝加入', err.t === 'error');
  c.ws.close();

  // 9) 普通玩家离开 → 房主收到 peerLeft
  b.send({ t: 'leave' });
  const left = await a.next();
  ok('普通玩家离开 → peerLeft', left.t === 'peerLeft');

  a.ws.close();

  // 10) 房主离开 → 其余成员收到 closed；且 PK 阵营 = 各自 peerId
  const e1 = client();
  const e2 = client();
  await Promise.all([e1.open(), e2.open()]);
  e1.send({ t: 'create', mode: 'pk', name: 'H', characterId: 'wolfshade', color: '#5cc8ff' });
  const cr = await e1.next();
  e2.send({ t: 'join', code: cr.code, name: 'J', characterId: 'sting', color: '#ff7ae0' });
  const j2 = await e2.next();
  await e1.next(); // peerJoined
  const meInfo = j2.peers.find((p) => p.id === j2.peerId);
  ok('PK 阵营 = 各自 peerId', cr.mode === 'pk' && meInfo && meInfo.team === j2.peerId);
  e1.send({ t: 'leave' });
  const closed = await e2.next();
  ok('房主离开 → 其余成员收到 closed', closed.t === 'closed');
  e2.ws.close();
} catch (err) {
  console.error('异常：', err);
  results.push(['exception', false]);
}

// 11) 静态托管（仅当 dist/index.html 存在时校验 —— npm run check 里 build 先于本冒烟）
try {
  const { existsSync } = await import('node:fs');
  const { resolve, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  if (existsSync(resolve(root, 'dist', 'index.html'))) {
    const res = await fetch(`http://127.0.0.1:${PORT}/`);
    const html = await res.text();
    ok(
      '静态托管：GET / 返回构建后的 index.html',
      res.status === 200 && (res.headers.get('content-type') ?? '').includes('text/html') && html.includes('<script'),
    );
    const assetRes = await fetch(`http://127.0.0.1:${PORT}/no-such-file.js`);
    ok('静态托管：未知路径返回 404', assetRes.status === 404);
  } else {
    console.log('SKIP  静态托管（dist/ 不存在，跳过）');
  }
} catch (err) {
  console.error('静态托管检查异常：', err);
  results.push(['static', false]);
}

await sleep(150);
server.kill();
const failed = results.filter(([, v]) => !v);
console.log(`\n共 ${results.length} 项，失败 ${failed.length} 项`);
process.exit(failed.length === 0 ? 0 : 1);
