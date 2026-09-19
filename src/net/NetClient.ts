/**
 * 联网客户端：浏览器原生 WebSocket 的薄封装。
 *
 * - 大厅阶段：create / join / start / leave，监听 created / joined / peerJoined / peerLeft / start / error。
 * - 对局阶段：sendInput / sendSnapshot，监听 input（房主收）/ snapshot（客户端收）/ upgradeChoice / gameover。
 *
 * 中继服务器是"哑管道"，本类不做任何游戏逻辑，只负责收发 JSON 消息并分发。
 */
import type { ClientMsg, ServerMsg } from './protocol';

type MsgHandler = (msg: ServerMsg) => void;
type OpenHandler = () => void;
type CloseHandler = (info: { clean: boolean }) => void;

export class NetClient {
  private ws: WebSocket | null = null;
  private readonly handlers = new Map<ServerMsg['t'], Set<MsgHandler>>();
  private readonly openHandlers = new Set<OpenHandler>();
  private readonly closeHandlers = new Set<CloseHandler>();
  readonly url: string;
  connected = false;
  peerId = '';
  /** 最近一次连接失败的原因（用于 UI 提示）。 */
  lastError = '';

  constructor(url: string) {
    this.url = url;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let ws: WebSocket;
      try {
        ws = new WebSocket(this.url);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      this.ws = ws;

      ws.onopen = () => {
        this.connected = true;
        this.lastError = '';
        for (const h of this.openHandlers) h();
        if (!settled) {
          settled = true;
          resolve();
        }
      };

      ws.onmessage = (ev: MessageEvent) => {
        let msg: ServerMsg;
        try {
          msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '') as ServerMsg;
        } catch {
          return;
        }
        if (msg.t === 'created' || msg.t === 'joined') this.peerId = msg.peerId;
        const set = this.handlers.get(msg.t);
        if (set) for (const h of set) h(msg);
      };

      ws.onerror = () => {
        this.lastError = '无法连接到中继服务器，请确认服务器已启动（npm run server）。';
        if (!settled) {
          settled = true;
          reject(new Error(this.lastError));
        }
      };

      ws.onclose = () => {
        this.connected = false;
        const clean = this.lastError === '';
        for (const h of this.closeHandlers) h({ clean });
      };
    });
  }

  on(type: ServerMsg['t'], cb: MsgHandler): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(cb);
    return () => set!.delete(cb);
  }

  onOpen(cb: OpenHandler): () => void {
    this.openHandlers.add(cb);
    return () => this.openHandlers.delete(cb);
  }

  onClose(cb: CloseHandler): () => void {
    this.closeHandlers.add(cb);
    return () => this.closeHandlers.delete(cb);
  }

  send(msg: ClientMsg): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  /** 主动离开房间（通知服务器移除本端）。 */
  leave(): void {
    this.send({ t: 'leave' });
  }

  close(): void {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    this.connected = false;
  }
}
