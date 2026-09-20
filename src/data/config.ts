/** 全局配置常量：所有"魔法数字"集中在此，便于统一调参。 */

/** 逻辑渲染分辨率（Canvas 内部坐标系）。 */
export const VIEW_W = 1280;
export const VIEW_H = 720;

/** 房间瓦片系统。 */
export const TILE = 48;
export const ROOM_COLS = 28;
export const ROOM_ROWS = 18;
export const ROOM_W = TILE * ROOM_COLS; // 1344
export const ROOM_H = TILE * ROOM_ROWS; // 864

/** 门洞宽（瓦片数），必须能整除居中对齐：cols 12..15 / rows 7..10。 */
export const DOOR_GAP = 4;
export const DOOR_GAP_START_X = (ROOM_COLS - DOOR_GAP) / 2; // 12
export const DOOR_GAP_START_Y = (ROOM_ROWS - DOOR_GAP) / 2; // 7

/** 瓦片类型。0 为地面，其余均为阻挡物。 */
export const Tile = {
  Floor: 0,
  Wall: 1,
  Pillar: 2,
  Crate: 3,
  Statue: 4,
  Brazier: 5,
} as const;

export type TileType = (typeof Tile)[keyof typeof Tile];

export const BLOCKING_TILES: readonly number[] = [
  Tile.Wall,
  Tile.Pillar,
  Tile.Crate,
  Tile.Statue,
  Tile.Brazier,
];

export function isBlockingTile(t: number): boolean {
  return t === Tile.Wall || t === Tile.Pillar || t === Tile.Crate || t === Tile.Statue || t === Tile.Brazier;
}

/** 可破坏瓦片血量（目前仅木箱）。 */
export const CRATE_HP = 10;

/** 玩家基础参数。 */
export const PLAYER_RADIUS = 15;
/**
 * 角色立绘（`role/` 里抠好背景的 PNG）的显示高度。
 *
 * **这个值必须和矢量角色目视等高**，否则换了立绘的角色会比狼影/蜂针/磐垒大一圈。
 * 矢量角色在 `r = PLAYER_RADIUS` 时，从顶饰最高点（约 `-1.47r`）到脚底影子（约 `0.78r`）
 * 一共约 `2.25r ≈ 34px`，所以这里取 34。
 *
 * 宽度**不在这里配置** —— `drawPlayer` 会按每张 PNG 自身的宽高比算，
 * 写死宽度会把胖角色拉扁、瘦角色拉长。
 *
 * 判定半径仍然是 `PLAYER_RADIUS`，**美术大小不影响碰撞**。
 * `drawPlayer` 会按 `r / PLAYER_RADIUS` 等比缩放，任何半径下都保持一致。
 */
export const PLAYER_SPRITE_H = 34;
export const PLAYER_ACCEL = 2600;
export const PLAYER_FRICTION = 2400;
export const PLAYER_IFRAME = 0.65;

/**
 * 脱战判定：最后一次受到伤害之后，平静这么多秒即视为「脱离战斗」。
 * 生命回复（Mods.healthRegen）与护盾回复（Mods.shieldRegen）共用这一条判定，
 * 保证全局只有一个「脱战」定义。
 */
export const OUT_OF_COMBAT_DELAY = 2;

/** 战斗房节奏。 */
export const DOOR_LOCK_DELAY = 0.35;
export const ROOM_CLEAR_REWARD_DELAY = 0.45;

/**
 * 首领死亡演出：遗体连续爆炸这么久之后才散去（秒，**真实时间**）。
 * 演出结束的那一刻才在场地中心开出传送门，所以玩家不会在爆炸特效里踩到传送门。
 */
export const BOSS_DEATH_DURATION = 1;
/** 死亡演出期间的慢动作倍率 */
export const BOSS_DEATH_SLOWMO = 0.4;
/** 死亡演出期间两次爆炸之间的间隔（秒，真实时间） */
export const BOSS_DEATH_EXPLOSION_INTERVAL = 0.07;

/**
 * 位图 Boss 的绘制高度系数：Boss 立绘（public/bosses/<slug>.png）按
 * `高度 = 碰撞半径 × 此系数` 居中绘制，宽度按图片宽高比算。
 * 数值参考第一关程序化 Boss「熔核·渊心」的整体视觉大小（2.6 × 半径 ≈ 外辉光直径）。
 * 想调 Boss 看起来多大只改这一个常量。
 */
export const BOSS_SPRITE_SCALE = 2.6;

/** 楼层数量：打完最后一层 Boss 即通关结算。每层 Boss 各不相同（见 src/data/bosses.ts）。 */
export const FLOOR_COUNT = 3;

/** 拾取物吸附。 */
export const PICKUP_MAGNET_RANGE = 108;
export const PICKUP_RANGE = 34;

/** 屏幕震动基数（像素）。 */
export const SHAKE_SCALE = 26;

/** 粒子池上限，避免极端情况掉帧。 */
export const MAX_PARTICLES = 700;
export const MAX_DAMAGE_NUMBERS = 60;

/** 相机跟随速度。 */
export const CAMERA_LERP = 7.2;
export const CAMERA_LOOKAHEAD = 74;

/** 房间静态图层缓存上限。 */
export const STATIC_CACHE_LIMIT = 5;

// ---------------------------------------------------------------- 联机模式
/** 每个房间最多玩家数（房间号固定 4 位字母数字，与人数无关）。 */
export const MAX_PLAYERS = 4;
/** 房间号长度（随机字母 + 数字）。 */
export const ROOM_CODE_LEN = 4;
/**
 * 从页面地址推导默认中继服务器地址。
 *
 * 优先级：
 * 1. `?server=ws(s)://host[:port]` —— 显式覆盖（前后端分离部署用，如 GitHub Pages +
 *    别处托管的中继）。值允许 URL 编码。
 * 2. HTTPS 页面 —— 中继与静态文件同源同端口部署（如 Render 单服务、单进程自托管），
 *    直接 `wss://同源`。HTTPS 页面里连 `ws://` 会被浏览器按混合内容拦截，必须 wss。
 * 3. HTTP 页面 —— 本地/局域网约定：`ws://hostname:8787`（`npm run server` 的默认端口）。
 * 4. 无 location（node 测试环境）—— `ws://localhost:8787`。
 */
export function resolveNetUrl(search: string, hostname: string, protocol: string, host: string): string {
  const explicit = /(?:^|[?&])server=([^&]+)/.exec(search)?.[1];
  if (explicit) return decodeURIComponent(explicit);
  if (protocol === 'https:' && host) return `wss://${host}`;
  if (hostname) return `ws://${hostname}:8787`;
  return 'ws://localhost:8787';
}

/** 默认中继服务器地址；可用 ?server=ws://host:port 覆盖。 */
export const DEFAULT_NET_URL =
  typeof location !== 'undefined' && location.hostname
    ? resolveNetUrl(location.search, location.hostname, location.protocol, location.host)
    : 'ws://localhost:8787';
/** 房主广播世界快照的频率（Hz）。 */
export const NET_SNAPSHOT_HZ = 20;
/** 客户端上报输入的频率（Hz）。 */
export const NET_INPUT_HZ = 30;
/** 联机玩家配色（按加入顺序分配，索引 0 固定为本地房主色）。 */
export const PLAYER_COLORS = [
  '#5cc8ff',
  '#ff7ae0',
  '#7ef2c0',
  '#ffd479',
  '#ff8a5a',
  '#b78aff',
];
