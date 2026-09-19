/**
 * 中继地址推导（resolveNetUrl）的单元测试。
 *
 * 部署形态决定地址来源：
 * - 前后端分离（GitHub Pages + 别处的中继）→ ?server= 显式覆盖
 * - 同源部署（Render 单服务 / node server/relay.mjs 自托管 dist）→ HTTPS 同源 wss
 * - 本地/局域网（vite dev / http 打开）→ ws://hostname:8787
 * - node 测试环境（无 location）→ localhost 兜底
 */
import { describe, expect, test } from 'vitest';
import { resolveNetUrl } from '../src/data/config';

describe('中继地址推导', () => {
  test('?server= 显式覆盖优先（允许 URL 编码）', () => {
    expect(
      resolveNetUrl('?server=wss%3A%2F%2Frelay.example.com', 'u.github.io', 'https:', 'u.github.io'),
    ).toBe('wss://relay.example.com');
    expect(resolveNetUrl('?server=ws://1.2.3.4:9000', 'u.github.io', 'https:', 'u.github.io')).toBe(
      'ws://1.2.3.4:9000',
    );
    expect(
      resolveNetUrl('?mode=coop&server=wss://r.onrender.com', 'u.github.io', 'https:', 'u.github.io'),
    ).toBe('wss://r.onrender.com');
  });

  test('HTTPS 页面 → 同源 wss（单服务部署：前端与中继同端口）', () => {
    expect(resolveNetUrl('', 'game.onrender.com', 'https:', 'game.onrender.com')).toBe(
      'wss://game.onrender.com',
    );
    expect(resolveNetUrl('', 'u.github.io', 'https:', 'u.github.io')).toBe('wss://u.github.io');
  });

  test('HTTP 页面 → ws://hostname:8787（本地/局域网默认端口）', () => {
    expect(resolveNetUrl('', '127.0.0.1', 'http:', '127.0.0.1:5173')).toBe('ws://127.0.0.1:8787');
    expect(resolveNetUrl('', '192.168.1.5', 'http:', '192.168.1.5:8787')).toBe('ws://192.168.1.5:8787');
  });

  test('无 location（node 测试环境）→ localhost 兜底', () => {
    expect(resolveNetUrl('', '', 'file:', '')).toBe('ws://localhost:8787');
  });
});
