import { describe, expect, test } from 'vitest';
import {
  SAVE_KEY,
  SAVE_VERSION,
  SaveManager,
  createMemoryStorage,
  defaultSave,
  defaultSettings,
  parseSave,
} from '../src/systems/save';
import { SAVED_RUN_VERSION, type SavedRun } from '../src/systems/run';

/** 造一份结构合法的远征存档（需求 20 的每角色槽位测试用）。 */
function makeRun(characterId: string, floor = 1, savedAt = 1000): SavedRun {
  return {
    version: SAVED_RUN_VERSION,
    characterId,
    seed: 12345,
    floor,
    gold: 0,
    upgrades: [],
    weapons: [{ id: 'pistol', ammo: 3 }],
    weaponIndex: 0,
    hp: 100,
    shield: 0,
    barrier: 0,
    timeSec: 0,
    bossDefeated: false,
    currentRoomKey: 'r0',
    visited: ['r0'],
    cleared: [],
    rooms: {},
    stats: { kills: 0, rooms: 0, damageDealt: 0, damageTaken: 0, goldEarned: 0, shotsFired: 0 },
    savedAt,
  };
}

describe('存档：健壮性解析', () => {
  test('空 / 非法数据返回默认存档', () => {
    expect(parseSave(null)).toEqual(defaultSave());
    expect(parseSave(undefined)).toEqual(defaultSave());
    expect(parseSave(42)).toEqual(defaultSave());
    expect(parseSave('not an object')).toEqual(defaultSave());
    expect(parseSave([])).toEqual(defaultSave());
  });

  test('部分字段缺失时用默认值补齐', () => {
    const parsed = parseSave({ settings: { masterVolume: 0.5 } });
    expect(parsed.settings.masterVolume).toBe(0.5);
    expect(parsed.settings.sfxVolume).toBe(defaultSettings().sfxVolume);
    expect(parsed.progress.bestFloor).toBe(1);
  });

  test('越界数值被夹取到合法区间', () => {
    const parsed = parseSave({
      settings: { masterVolume: 99, sfxVolume: -5, musicVolume: 'x', screenShake: NaN },
    });
    expect(parsed.settings.masterVolume).toBe(1);
    expect(parsed.settings.sfxVolume).toBe(0);
    expect(parsed.settings.musicVolume).toBe(defaultSettings().musicVolume);
    expect(parsed.settings.screenShake).toBe(defaultSettings().screenShake);
  });

  test('非字符串数组字段被安全清洗', () => {
    const parsed = parseSave({ unlockedCharacters: ['a', 1, null, 'b'], discoveredWeapons: 'oops' });
    expect(parsed.unlockedCharacters).toEqual(['a', 'b']);
    expect(parsed.discoveredWeapons).toEqual([]);
  });

  test('负数进度被归零，bestFloor 至少为 1', () => {
    const parsed = parseSave({ progress: { wins: -3, bestFloor: -9, totalKills: -1, bestScore: -100 } });
    expect(parsed.progress.wins).toBe(0);
    expect(parsed.progress.bestFloor).toBe(1);
    expect(parsed.progress.totalKills).toBe(0);
    expect(parsed.progress.bestScore).toBe(0);
  });
});

describe('存档：读写与进度', () => {
  test('设置写入后可持久化并读回', () => {
    const storage = createMemoryStorage();
    const save = new SaveManager(storage);
    save.updateSettings({ masterVolume: 0.33, showMinimap: false });
    expect(storage.getItem(SAVE_KEY)).not.toBeNull();

    const reloaded = new SaveManager(storage);
    expect(reloaded.data.settings.masterVolume).toBeCloseTo(0.33, 6);
    expect(reloaded.data.settings.showMinimap).toBe(false);
  });

  test('已发现武器与已解锁角色去重', () => {
    const save = new SaveManager(createMemoryStorage());
    save.discoverWeapon('smg');
    save.discoverWeapon('smg');
    save.unlockCharacter('sting');
    save.unlockCharacter('sting');
    expect(save.data.discoveredWeapons).toEqual(['smg']);
    expect(save.data.unlockedCharacters).toEqual(['sting']);
  });

  test('recordRun 正确累计统计与最佳记录', () => {
    const save = new SaveManager(createMemoryStorage());
    save.recordRun({ floor: 2, won: false, timeSec: 90, kills: 20, rooms: 5, score: 1500 });
    expect(save.data.progress.runs).toBe(1);
    expect(save.data.progress.bestFloor).toBe(2);
    expect(save.data.progress.wins).toBe(0);
    expect(save.data.progress.bestTimeSec).toBe(0);
    expect(save.data.progress.totalKills).toBe(20);
    expect(save.data.progress.bestScore).toBe(1500);

    save.recordRun({ floor: 1, won: false, timeSec: 30, kills: 5, rooms: 2, score: 400 });
    // 更差的成绩不会覆盖最佳值
    expect(save.data.progress.runs).toBe(2);
    expect(save.data.progress.bestFloor).toBe(2);
    expect(save.data.progress.bestScore).toBe(1500);
    expect(save.data.progress.totalKills).toBe(25);

    save.recordRun({ floor: 2, won: true, timeSec: 210, kills: 40, rooms: 12, score: 4200 });
    expect(save.data.progress.wins).toBe(1);
    expect(save.data.progress.bestTimeSec).toBe(210);
    expect(save.data.progress.bestScore).toBe(4200);

    save.recordRun({ floor: 2, won: true, timeSec: 180, kills: 41, rooms: 12, score: 4300 });
    expect(save.data.progress.wins).toBe(2);
    expect(save.data.progress.bestTimeSec).toBe(180);
  });

  test('reset 会清空存档并落盘', () => {
    const storage = createMemoryStorage();
    const save = new SaveManager(storage);
    save.recordRun({ floor: 2, won: true, timeSec: 120, kills: 33, rooms: 9, score: 3000 });
    save.discoverWeapon('laser');
    save.reset();
    expect(save.data).toEqual(defaultSave());
    const reloaded = new SaveManager(storage);
    expect(reloaded.data.progress.wins).toBe(0);
    expect(reloaded.data.discoveredWeapons).toEqual([]);
  });

  test('存储抛错时不影响游戏运行（隐私模式兜底）', () => {
    const broken = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    };
    const save = new SaveManager(broken);
    expect(save.data.progress.bestFloor).toBe(1);
    expect(() => save.updateSettings({ masterVolume: 0.5 })).not.toThrow();
    expect(() => save.recordRun({ floor: 1, won: false, timeSec: 1, kills: 1, rooms: 1, score: 1 })).not.toThrow();
    expect(() => save.reset()).not.toThrow();
  });

  test('无存储环境也能工作（内存态）', () => {
    const save = new SaveManager(null);
    save.updateSettings({ musicVolume: 0.5 });
    expect(save.data.settings.musicVolume).toBe(0.5);
  });

  test('损坏的 JSON 文本回退默认存档', () => {
    const storage = createMemoryStorage();
    storage.setItem(SAVE_KEY, '{ 这不是 JSON');
    const save = new SaveManager(storage);
    expect(save.data).toEqual(defaultSave());
  });
});

describe('存档：每角色一份（需求 20）', () => {
  test('默认存档没有任何续玩进度，且版本已升到 3', () => {
    const save = new SaveManager(createMemoryStorage());
    expect(save.hasAnyRun).toBe(false);
    expect(save.listRuns()).toEqual([]);
    expect(save.latestRun).toBeNull();
    expect(SAVE_VERSION).toBe(3);
  });

  test('不同角色的存档互不覆盖，按落盘时间由新到旧排列', () => {
    const save = new SaveManager(createMemoryStorage());
    save.setRun(makeRun('milkdragon', 2, 200));
    save.setRun(makeRun('lulu', 1, 100));
    expect(save.hasAnyRun).toBe(true);
    expect(save.listRuns().map((r) => r.characterId)).toEqual(['milkdragon', 'lulu']);
    expect(save.getRun('milkdragon')!.floor).toBe(2);
    expect(save.getRun('lulu')!.floor).toBe(1);
    // 「最近一次」是主菜单「继续远征」取的那份
    expect(save.latestRun!.characterId).toBe('milkdragon');
    expect(save.getRun('niulai')).toBeNull();
  });

  test('同一角色重复落盘是覆盖，不会变成两条', () => {
    const save = new SaveManager(createMemoryStorage());
    save.setRun(makeRun('lulu', 1, 100));
    save.setRun(makeRun('lulu', 3, 300));
    expect(save.listRuns()).toHaveLength(1);
    expect(save.getRun('lulu')!.floor).toBe(3);
  });

  test('deleteRun 只删指定角色，其余存档原样保留且已落盘', () => {
    const storage = createMemoryStorage();
    const save = new SaveManager(storage);
    save.setRun(makeRun('milkdragon', 2, 200));
    save.setRun(makeRun('lulu', 1, 100));
    save.deleteRun('lulu');

    expect(save.getRun('lulu')).toBeNull();
    expect(save.getRun('milkdragon')!.floor).toBe(2);
    // 重新读盘确认真的写进去了（不是只改了内存）
    expect(new SaveManager(storage).getRun('lulu')).toBeNull();
    expect(new SaveManager(storage).getRun('milkdragon')!.floor).toBe(2);
  });

  test('删除不存在的角色是安全的空操作', () => {
    const save = new SaveManager(createMemoryStorage());
    save.setRun(makeRun('lulu', 1, 100));
    expect(() => save.deleteRun('nobody')).not.toThrow();
    expect(save.listRuns()).toHaveLength(1);
  });

  test('clearAllRuns 清空全部存档，但设置 / 解锁 / 历史统计不动', () => {
    const save = new SaveManager(createMemoryStorage());
    save.setRun(makeRun('milkdragon', 2, 200));
    save.setRun(makeRun('lulu', 1, 100));
    save.unlockCharacter('sting');
    save.discoverWeapon('smg');
    save.recordRun({ floor: 2, won: true, timeSec: 90, kills: 10, rooms: 4, score: 999 });
    save.updateSettings({ masterVolume: 0.42 });

    save.clearAllRuns();

    expect(save.hasAnyRun).toBe(false);
    expect(save.listRuns()).toEqual([]);
    expect(save.data.unlockedCharacters).toEqual(['sting']);
    expect(save.data.discoveredWeapons).toEqual(['smg']);
    expect(save.data.progress.wins).toBe(1);
    expect(save.data.progress.bestScore).toBe(999);
    expect(save.data.settings.masterVolume).toBeCloseTo(0.42, 6);
  });

  test('旧版单槽存档（run）自动迁移到新的每角色结构，进度不丢', () => {
    const parsed = parseSave({ run: makeRun('sting', 2, 500) });
    expect(parsed.runs.sting).toBeDefined();
    expect(parsed.runs.sting!.floor).toBe(2);
    expect(parsed.runs.sting!.characterId).toBe('sting');
  });

  test('新结构已有该角色时，旧 run 槽位不会覆盖它', () => {
    const parsed = parseSave({
      runs: { sting: makeRun('sting', 3, 900) },
      run: makeRun('sting', 1, 100),
    });
    expect(parsed.runs.sting!.floor).toBe(3);
  });

  test('键与存档自报的 characterId 不一致时整条丢弃（避免张冠李戴）', () => {
    const parsed = parseSave({ runs: { lulu: makeRun('milkdragon', 2, 200) } });
    expect(Object.keys(parsed.runs)).toEqual([]);
  });

  test('runs 里的坏条目被单独丢弃，好条目照样留下', () => {
    const parsed = parseSave({
      runs: {
        lulu: makeRun('lulu', 1, 100),
        badNumber: 42,
        badObject: { characterId: 'x' },
        // 名称对得上但缺武器 → parseSavedRun 判为坏档
        noWeapons: { ...makeRun('niulai', 1, 100), weapons: [] },
      },
    });
    expect(Object.keys(parsed.runs)).toEqual(['lulu']);
  });

  test('runs 是数组 / 字符串等非法类型时安全回落为空', () => {
    expect(parseSave({ runs: [] }).runs).toEqual({});
    expect(parseSave({ runs: 'oops' }).runs).toEqual({});
    expect(parseSave({ runs: null }).runs).toEqual({});
  });
});

describe('存档：每日签到（需求 35）', () => {
  test('首次签到发放第 1 天奖励，且当日不可重复领取', () => {
    const save = new SaveManager(createMemoryStorage());
    const r = save.claimDailyCheckIn(new Date(2026, 8, 25));
    expect(r).toEqual({ day: 1, coins: 200, diamonds: 0 });
    expect(save.data.wallet).toEqual({ diamonds: 0, coins: 200 });
    expect(save.data.checkIn.streak).toBe(1);
    // 同日再签 → null（不可重复）
    expect(save.claimDailyCheckIn(new Date(2026, 8, 25))).toBeNull();
    expect(save.getCheckIn(new Date(2026, 8, 25)).canClaim).toBe(false);
  });

  test('连续 7 天按表递增，第 8 天回到第 1 天循环', () => {
    const save = new SaveManager(createMemoryStorage());
    let d = new Date(2026, 8, 25);
    const rewards: Array<{ coins: number; diamonds: number }> = [
      { coins: 200, diamonds: 0 },
      { coins: 300, diamonds: 0 },
      { coins: 0, diamonds: 10 },
      { coins: 400, diamonds: 0 },
      { coins: 500, diamonds: 0 },
      { coins: 0, diamonds: 15 },
      { coins: 800, diamonds: 30 },
    ];
    for (let i = 0; i < 7; i++) {
      const r = save.claimDailyCheckIn(d);
      expect(r).toEqual({ day: i + 1, ...rewards[i] });
      d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
    }
    // 7 天累计：金币 200+300+400+500+800=2200，钻石 10+15+30=55
    expect(save.data.wallet).toEqual({ diamonds: 55, coins: 2200 });
    expect(save.data.checkIn.streak).toBe(7);
    // 第 8 天（连续）→ 循环回第 1 天
    const r8 = save.claimDailyCheckIn(d);
    expect(r8).toEqual({ day: 1, coins: 200, diamonds: 0 });
    expect(save.data.checkIn.streak).toBe(1);
  });

  test('断签（间隔 > 1 天）重置为第 1 天', () => {
    const save = new SaveManager(createMemoryStorage());
    save.claimDailyCheckIn(new Date(2026, 8, 25)); // day1
    save.claimDailyCheckIn(new Date(2026, 8, 26)); // day2, streak=2
    expect(save.data.checkIn.streak).toBe(2);
    // 跳到 8/29（与上次 8/26 间隔 3 天）→ 断签，回到 day1
    const r = save.claimDailyCheckIn(new Date(2026, 8, 29));
    expect(r).toEqual({ day: 1, coins: 200, diamonds: 0 });
    expect(save.data.checkIn.streak).toBe(1);
  });

  test('签到结果持久化，重载后保留', () => {
    const storage = createMemoryStorage();
    const save = new SaveManager(storage);
    save.claimDailyCheckIn(new Date(2026, 8, 25));
    const reloaded = new SaveManager(storage);
    expect(reloaded.data.wallet).toEqual({ diamonds: 0, coins: 200 });
    expect(reloaded.data.checkIn.streak).toBe(1);
    expect(reloaded.data.checkIn.lastDate).toBe('2026-09-25');
  });

  test('旧存档缺钱包 / 签到字段时回落默认（不崩溃）', () => {
    const parsed = parseSave({ progress: { wins: 3 } });
    expect(parsed.wallet).toEqual({ diamonds: 0, coins: 0 });
    expect(parsed.checkIn).toEqual({ lastDate: '', streak: 0 });
  });
});
