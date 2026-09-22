import { describe, test, expect, beforeEach } from 'vitest';
import { persistRoom, clearRoomStore, restoreRoom } from '../src/net/roomStore';
import type { LobbyInfo } from '../src/ui/screens';

/** 最小内存 Storage，模拟浏览器 localStorage（node 环境下不存在）。 */
class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string): string | null {
    return this.m.has(k) ? (this.m.get(k) as string) : null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, String(v));
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
  clear(): void {
    this.m.clear();
  }
  key(i: number): string | null {
    return [...this.m.keys()][i] ?? null;
  }
  get length(): number {
    return this.m.size;
  }
}

beforeEach(() => {
  (globalThis as unknown as { localStorage: Storage }).localStorage = new MemStorage() as unknown as Storage;
});

function makeLobby(over: Partial<LobbyInfo> = {}): LobbyInfo {
  return {
    phase: 'room',
    code: 'AB12',
    mode: 'coop',
    isHost: true,
    members: [{ name: 'winner', color: '#5cc8ff', isHost: true, charId: 'wolfshade' }],
    status: '房间已创建',
    joining: false,
    codeInput: '',
    name: 'winner',
    ...over,
  };
}

describe('房间状态持久化（刷新后仍显示当前房间）', () => {
  test('建房后写入，刷新可恢复房间号 / 模式 / 身份', () => {
    persistRoom(makeLobby());
    const r = restoreRoom('玩家38');
    expect(r).not.toBeNull();
    expect(r!.code).toBe('AB12');
    expect(r!.isHost).toBe(true);
    expect(r!.mode).toBe('coop');
    expect(r!.members[0]?.name).toBe('winner');
    // 恢复时尚未连接，状态提示重连
    expect(r!.status).toContain('连接已断开');
  });

  test('PK 模式与非房主身份保留', () => {
    persistRoom(makeLobby({ mode: 'pk', isHost: false }));
    const r = restoreRoom('x');
    expect(r!.mode).toBe('pk');
    expect(r!.isHost).toBe(false);
  });

  test('离开房间清除存储', () => {
    persistRoom(makeLobby());
    clearRoomStore();
    expect(restoreRoom('x')).toBeNull();
  });

  test('未真正在房间内（idle）不写入', () => {
    persistRoom(makeLobby({ phase: 'idle', code: '' }));
    expect(restoreRoom('x')).toBeNull();
  });

  test('存储损坏时安全返回 null 并清除', () => {
    persistRoom(makeLobby());
    const k = localStorage.key(0);
    expect(k).not.toBeNull();
    localStorage.setItem(k as string, '{ 损坏的 json');
    expect(restoreRoom('x')).toBeNull();
    expect(localStorage.getItem(k as string)).toBeNull();
  });
});
