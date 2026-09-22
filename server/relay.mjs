/**
 * 元气勇士 · 联机中继服务器（纯 WebSocket 哑管道）。
 *
 * 职责极简：维护房间（4 位字母数字房间号，最多 4 人），把消息在房间内转发。
 * 不做任何游戏逻辑 —— 房主跑权威模拟并广播 Snapshot，其他人只上报 Input。
 *
 * 附加职责（无游戏逻辑）：把 `dist/` 里的构建产物当静态文件一起托管 ——
 * 这样**一个进程就是一个完整的游戏服务器**（前端 + 中继同源同端口）：
 *   - 本地：`npm run build` 后 `node server/relay.mjs`，局域网朋友直接开 http://你的IP:8787
 *   - 云端：整个仓库扔到 Render/Railway 之类，一个 Web Service 全搞定（自动 HTTPS/wss）
 * dist/ 不存在时静态部分返回提示页，WebSocket 照常工作（开发时前端走 vite）。
 *
 * 启动：node server/relay.mjs   （或 npm run server）
 * 端口：8787，可用环境变量 PORT 覆盖。
 *
 * 依赖：ws（仅服务端使用，不进入客户端打包）。
 */
import { createServer } from 'node:http';
import { existsSync, statSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT) || 8787;
const MAX_PLAYERS = 4;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');

/** 静态文件 MIME 表（够用就好，dist 里只有这几种）。 */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
};

function serveStatic(req, res) {
  const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = normalize(join(DIST, rel));
  // 防目录穿越：拼出来的路径必须还在 dist/ 里
  if (!file.startsWith(DIST + sep) && file !== DIST) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  if (!existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
    return;
  }
  const body = readFileSync(file);
  const type = MIME[extnameOf(file)] ?? 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': type,
    // 带哈希的 assets 可以长缓存；index.html 不缓存保证发版即生效
    'Cache-Control': rel.startsWith('assets/') ? 'public, max-age=604800' : 'no-cache',
  });
  res.end(body);
}

function extnameOf(file) {
  const i = file.lastIndexOf('.');
  return i < 0 ? '' : file.slice(i).toLowerCase();
}

function serveFallback(req, res) {
  res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('元气勇士中继服务器运行中。前端页面未找到：请先 npm run build 生成 dist/，或改用 npm run dev 打开前端。');
}

const httpServer = createServer((req, res) => {
  if (existsSync(join(DIST, 'index.html'))) serveStatic(req, res);
  else serveFallback(req, res);
});

/** 房间号字母表：去掉易混字符 0/O/1/I/L。 */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function makeRoomCode(len = 4) {
  let out = '';
  let seed = (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
  for (let i = 0; i < len; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    out += ALPHABET[seed % ALPHABET.length];
  }
  return out;
}

function newPeerId() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID().slice(0, 8);
  return Math.random().toString(36).slice(2, 10);
}

/** @type {Map<string, Room>} */
const rooms = new Map();

function send(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(room, msg, exceptId) {
  for (const p of room.peers.values()) {
    if (p.id === exceptId) continue;
    send(p.ws, msg);
  }
}

function peerList(room) {
  return [...room.peers.values()].map((p) => p.info);
}

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
  let peerId = newPeerId();
  let room = null;
  ws.isAlive = true;

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg.t !== 'string') return;

    switch (msg.t) {
      case 'create': {
        if (room) return;
        let code = makeRoomCode(4);
        while (rooms.has(code)) code = makeRoomCode(4);
        room = {
          code,
          mode: msg.mode === 'pk' ? 'pk' : 'coop',
          hostId: peerId,
          started: false,
          peers: new Map(),
        };
        const info = {
          id: peerId,
          name: String(msg.name || '房主').slice(0, 12),
          characterId: String(msg.characterId || 'warrior'),
          color: String(msg.color || '#5cc8ff'),
          isHost: true,
          team: 'heroes',
        };
        room.peers.set(peerId, { id: peerId, ws, info });
        rooms.set(code, room);
        send(ws, { t: 'created', code, peerId, mode: room.mode });
        break;
      }

      case 'join': {
        if (room) return;
        const target = rooms.get(String(msg.code || '').toUpperCase());
        if (!target) {
          send(ws, { t: 'error', message: '房间不存在或已关闭' });
          return;
        }
        if (target.started) {
          send(ws, { t: 'error', message: '该房间已开始对局，无法加入' });
          return;
        }
        if (target.peers.size >= MAX_PLAYERS) {
          send(ws, { t: 'error', message: '房间已满（最多 4 人）' });
          return;
        }
        room = target;
        const colorIndex = room.peers.size;
        const palette = ['#5cc8ff', '#ff7ae0', '#7ef2c0', '#ffd479', '#ff8a5a', '#b78aff'];
        const info = {
          id: peerId,
          name: String(msg.name || '玩家').slice(0, 12),
          characterId: String(msg.characterId || 'warrior'),
          color: palette[colorIndex % palette.length],
          isHost: false,
          team: room.mode === 'pk' ? peerId : 'heroes',
        };
        room.peers.set(peerId, { id: peerId, ws, info });
        // 通知新加入者完整名单
        send(ws, { t: 'joined', code: room.code, peerId, mode: room.mode, peers: peerList(room) });
        // 通知房内其他人（含房主）
        broadcast(room, { t: 'peerJoined', peer: info }, peerId);
        break;
      }

      case 'start': {
        if (!room || room.hostId !== peerId) return;
        if (room.started) return;
        // 自由混战是"人对人"，一个人开不了局。以前房主单人点开始也能进，
        // 进去以后裁判看到"场上只有 1 人"直接判他最后的幸存者 —— 一进门就「PK 胜利」。
        // 门禁放在中继（权威侧），前端按钮状态被绕过也拦得住。
        if (room.mode === 'pk' && room.peers.size < 2) {
          send(ws, { t: 'error', message: '自由混战至少需要 2 名玩家，把房间号发给朋友吧' });
          return;
        }
        room.started = true;
        const peers = peerList(room);
        const seed = (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
        const payload = { t: 'start', seed, floor: 1, mode: room.mode, peers };
        broadcast(room, payload); // 含房主本身
        break;
      }

      // 自由混战「再来一次」：房间不散，只把所有人重新送进一条新的 start。
      // 新种子 → 每个客户端重建 GameplayScene → 地图/人头/计时整体重置。
      // 只能由房主触发（客户端走 rematchRequest 转交给房主）。
      case 'rematch': {
        if (!room || room.hostId !== peerId) return;
        const peers = peerList(room);
        const seed = (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
        broadcast(room, { t: 'start', seed, floor: 1, mode: room.mode, peers });
        break;
      }

      // 客户端请求再开一局 → 只告诉房主，由房主决定。
      case 'rematchRequest': {
        if (!room) return;
        const host = room.peers.get(room.hostId);
        if (host && host.id !== peerId) send(host.ws, { t: 'rematchRequest', from: peerId });
        break;
      }

      case 'input': {
        if (!room || !msg.i) return;
        const host = room.peers.get(room.hostId);
        if (host && host.id !== peerId) send(host.ws, { t: 'input', from: peerId, i: msg.i });
        break;
      }

      case 'snapshot': {
        if (!room || !msg.s) return;
        // 仅房主广播有效，转发给其余所有人
        if (room.hostId !== peerId) return;
        broadcast(room, { t: 'snapshot', s: msg.s }, peerId);
        break;
      }

      case 'upgradeChoice': {
        if (!room || !msg.to || !msg.options) return;
        if (room.hostId !== peerId) return;
        const target = room.peers.get(msg.to);
        if (target) send(target.ws, { t: 'upgradeChoice', options: msg.options });
        break;
      }

      case 'upgradePick': {
        if (!room || !msg.id) return;
        const host = room.peers.get(room.hostId);
        if (host && host.id !== peerId) send(host.ws, { t: 'upgradePick', from: peerId, id: msg.id });
        break;
      }

      case 'gameover': {
        if (!room) return;
        if (room.hostId !== peerId) return;
        broadcast(room, {
          t: 'gameover',
          won: !!msg.won,
          winnerId: msg.winnerId ?? null,
          reason: String(msg.reason || ''),
          // 闯关模式的失败原因（例：`被 熔核·渊心 击倒在第 2 层`）。
          cause: String(msg.cause || ''),
          // 自由混战：只转发**结构化**的结束原因 + 胜者昵称，文案由各端
          // 按自己的视角渲染（赢家永远读到"你…"，见 pkOutcomeText）。
          pkReason: msg.pkReason,
          winnerName: String(msg.winnerName || ''),
        });
        break;
      }

      case 'leave': {
        leaveCurrent();
        break;
      }

      default:
        break;
    }
  });

  ws.on('close', () => {
    leaveCurrent();
  });

  ws.on('error', () => {
    leaveCurrent();
  });

  function leaveCurrent() {
    if (!room) return;
    const r = room;
    const wasHost = r.hostId === peerId;
    r.peers.delete(peerId);
    if (r.peers.size === 0) {
      rooms.delete(r.code);
      room = null;
      return;
    }
    if (wasHost) {
      // 房主离开：房间解散，通知所有人
      rooms.delete(r.code);
      for (const p of r.peers.values()) send(p.ws, { t: 'closed' });
      r.peers.clear();
    } else {
      broadcast(r, { t: 'peerLeft', peerId });
    }
    room = null;
  }
});

// 心跳：清理掉线但未触发 close 的连接
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {
      /* ignore */
    }
  }
}, 30000);

wss.on('close', () => clearInterval(heartbeat));

httpServer.listen(PORT, () => {
  const hasFront = existsSync(join(DIST, 'index.html'));
  console.log(
    `[元气勇士] 联机中继服务器已启动：ws://localhost:${PORT}（最多 ${MAX_PLAYERS} 人/房）` +
      (hasFront ? '，静态前端已同端口托管' : '（未找到 dist/，仅中继）'),
  );
});
