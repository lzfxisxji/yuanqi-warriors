import type { LobbyInfo, LobbyMember } from '../ui/screens';

/**
 * 房间状态本地持久化。
 *
 * 大厅状态默认纯内存（`menuState.lobby`），刷新 / 重开标签页即丢失，
 * 而且房主断开时中继已解散房间 —— 于是「菜单页当前房间」刷新后不再显示。
 * 这里把房间号 / 模式 / 身份落本地存储，加载时恢复显示，让房间号常驻可见；
 * 连接已断时界面会提示用户点「联机模式」重连 / 重建。
 */

const ROOM_STORE_KEY = 'yuanqi-warriors:room';

interface StoredRoom {
  code: string;
  mode: 'coop' | 'pk';
  isHost: boolean;
  members: LobbyMember[];
  name?: string;
}

/** 把当前房间状态写入本地存储（未真正在房间内则清除）。 */
export function persistRoom(lb: LobbyInfo): void {
  try {
    if (lb.phase !== 'room' || !lb.code) {
      clearRoomStore();
      return;
    }
    localStorage.setItem(
      ROOM_STORE_KEY,
      JSON.stringify({
        code: lb.code,
        mode: lb.mode,
        isHost: lb.isHost,
        members: lb.members,
        name: lb.name,
      } satisfies StoredRoom),
    );
  } catch {
    /* localStorage 不可用（隐私模式 / 测试环境）时静默跳过 */
  }
}

/** 清除本地存储的房间状态（离开房间 / 断线时调用）。 */
export function clearRoomStore(): void {
  try {
    localStorage.removeItem(ROOM_STORE_KEY);
  } catch {
    /* 同上 */
  }
}

/**
 * 应用启动时从本地存储恢复「当前房间」显示。
 * 此时尚未连接中继，仅用于让房间号常驻显示；连接已断会提示用户点「联机模式」重连/重建。
 * 无有效数据返回 null（调用方保留默认空的 lobby）。
 */
export function restoreRoom(fallbackName: string): LobbyInfo | null {
  try {
    const raw = localStorage.getItem(ROOM_STORE_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw) as Partial<StoredRoom> | null;
    if (!d || typeof d.code !== 'string' || d.code.length === 0) {
      clearRoomStore();
      return null;
    }
    const members = Array.isArray(d.members)
      ? d.members.filter(
          (m): m is LobbyMember =>
            !!m && typeof m.name === 'string' && typeof m.color === 'string',
        )
      : [];
    return {
      phase: 'room',
      code: d.code,
      mode: d.mode === 'pk' ? 'pk' : 'coop',
      isHost: Boolean(d.isHost),
      members,
      // 其余字段沿用默认（status 标为已断开；name/joining/codeInput 用默认值）
      status: '连接已断开，点「联机模式」可重连或重建房间',
      joining: false,
      codeInput: '',
      name: d.name ?? fallbackName,
    };
  } catch {
    clearRoomStore();
    return null;
  }
}
