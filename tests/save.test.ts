import { describe, expect, test } from 'vitest';
import {
  SAVE_KEY,
  SaveManager,
  createMemoryStorage,
  defaultSave,
  defaultSettings,
  parseSave,
} from '../src/systems/save';

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
