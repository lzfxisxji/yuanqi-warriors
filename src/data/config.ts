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
 * **这个值必须和矢量角色目视等高**，否则换了立绘的角色会比狼影/蜂针大一圈。
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

/**
 * 楼层强度递增倍率：**每一层的血量与攻击力都是上一层的 1.5 倍**。
 *
 * 第 N 层的系数 = `1.5^(N-1)`，也就是 1 / 1.5 / 2.25。
 * 普通敌人（`enemies.ts` 的 `enemyScale`）与 Boss（`bosses.ts` 的 `bossMaxHp` /
 * `bossContactDamage`）**共用这一个系数** —— 放在这里就是为了让「小怪变强多少」
 * 和「Boss 变强多少」永远同步，不会各调各的调出不同的曲线。
 */
export const FLOOR_POWER_STEP = 1.5;

/** 第 `floor` 层的强度系数。第 1 层恒为 1（基准层）；非法楼层按 1 处理。 */
export function floorPower(floor: number): number {
  const f = Math.floor(floor);
  return FLOOR_POWER_STEP ** (Number.isFinite(f) && f > 1 ? f - 1 : 0);
}

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

// ------------------------------------------------------- 自由混战比赛规则
/**
 * 自由混战一局的时长（秒）。
 *
 * 自由混战不是"一趟远征"，而是**一场定胜负的比赛**：3 分钟到点就按人头数排名，
 * 谁杀得多谁赢。以前 PK 只有"活到最后"一个结束条件，两个人都躲着不打就永远不结束。
 */
export const PK_MATCH_SECONDS = 180;

/** 自由混战：击杀这么多人头即可**提前结束比赛**直接胜出。 */
export const PK_KILL_TARGET = 10;

/**
 * 自由混战开赛所需的最少人数。
 *
 * 自由混战是"人对人"的比赛，一个人待在自己房里根本没有对手 ——
 * 曾经的实现直接判「最后的幸存者」，于是单人建房一进门就弹出「PK 胜利」。
 * 人数不够时裁判停在 `waiting`：比赛不开始、计时不走、也**绝不判负**。
 */
export const PK_MIN_PLAYERS = 2;

/**
 * 开赛前的准备倒计时（秒）。
 *
 * 「房主和玩家都进入游戏」需要一小段落地时间（地图生成、远端玩家入位），
 * 这段时间里比赛不判定，双方都看得见倒计时 —— 而不是一进场就发现比赛已经结束了。
 */
export const PK_START_COUNTDOWN = 3;

// ------------------------------------------------------------- 训练营（需求 29）
/**
 * 训练营的木桩 id（定义在 `data/enemies.ts` 的 `TRAINING_ENEMIES`）。
 *
 * 木桩**刻意不放进 `ENEMIES`** —— 它不该被 `pickNormalId` 抽进普通战斗波次，
 * 也不该出现在敌人图鉴里。训练营场景按这个 id 点名生成。
 */
export const TRAINING_DUMMY_ID = 'training_dummy';

/**
 * 木桩相对房间中心的纵向偏移（像素，负值 = 屏幕上方）。
 *
 * 玩家固定出生在房间正中，木桩摆在正前方 —— 一进场就在视野里，
 * 不用先找靶子；想测远距离就自己往后退。
 */
export const TRAINING_DUMMY_OFFSET_Y = -190;

/**
 * 训练营的固定种子。
 *
 * 刻意**不随机**：练习场每次进去都是同一个房间布局、同一个木桩位置，
 * 玩家才能记住距离感（"这个位置霰弹能全中"）。随机地图会让训练营失去"可重复"的意义。
 */
export const TRAINING_SEED = 0x72410101;

// ------------------------------------------------------------- 冲刺技能（需求 29）
/**
 * 冲刺（蛮牛冲撞 / 重拳突进）撞击判定的额外半径。
 *
 * 判定半径 = `玩家半径 + 这个值 + 目标半径`。给一点余量是手感问题：
 * 冲刺速度高达 1020 px/s（60 帧下每帧 17px），余量太小时贴着目标飞过去会"擦肩不中"。
 */
export const DASH_HIT_PAD = 14;

/**
 * 近战蓄力（需求 30）：按住近战攻击键积累蓄力，松开时释放一次挥砍。
 * - 蓄力时间达到 `MELEE_CHARGE_TIME` 秒即"满蓄力"，伤害为原伤害的 `MELEE_CHARGE_MAX_MUL` 倍；
 * - 蓄力比例在 0 → 1 之间线性插值（伤害 = 原伤害 × (1 + (MAX-1) × ratio)），所以未满也更强；
 * - 但为了保留"点按即原伤害"的手感，按住时间小于 `MELEE_CHARGE_MIN_HOLD` 视为没蓄力，伤害就是 1×。
 */
export const MELEE_CHARGE_TIME = 2.5; // 落在需求要求的 2~3 秒区间
export const MELEE_CHARGE_MAX_MUL = 2.5;
export const MELEE_CHARGE_MIN_HOLD = 0.14;

/** 联机玩家配色（按加入顺序分配，索引 0 固定为本地房主色）。 */
export const PLAYER_COLORS = [
  '#5cc8ff',
  '#ff7ae0',
  '#7ef2c0',
  '#ffd479',
  '#ff8a5a',
  '#b78aff',
];

// ------------------------------------------------------------- 每日签到（需求 35）

/** 单日签到的奖励内容。 */
export interface DailyReward {
  /** 第几天（1..7，与数组下标 +1 对应） */
  day: number;
  coins: number;
  diamonds: number;
}

/**
 * 7 天一轮的签到奖励表，数值由小 w 自行设定（需求 35：用户授权自定规则与数值）。
 *
 * 设计：前 6 天以金币为主、穿插少量钻石作为「小甜头」，第 7 天给大额钻石 + 金币作为「周常里程碑」。
 * 这是奖励数值的唯一出处 —— 任何 UI / 逻辑要显示或发放奖励都从这张表取，不要在别处硬编码。
 */
export const DAILY_CHECKIN: readonly DailyReward[] = [
  { day: 1, coins: 200, diamonds: 0 },
  { day: 2, coins: 300, diamonds: 0 },
  { day: 3, coins: 0, diamonds: 10 },
  { day: 4, coins: 400, diamonds: 0 },
  { day: 5, coins: 500, diamonds: 0 },
  { day: 6, coins: 0, diamonds: 15 },
  { day: 7, coins: 800, diamonds: 30 },
];

/** 签到周期长度（天）。 */
export const CHECKIN_CYCLE = DAILY_CHECKIN.length;
