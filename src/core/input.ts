/**
 * 输入系统：键盘 + 鼠标。
 * 鼠标坐标会被换算到逻辑分辨率（1280x720）坐标系内，供瞄准使用。
 */
import { clamp } from './math';
import { VIEW_H, VIEW_W } from '../data/config';

export interface PointerState {
  /** 屏幕空间鼠标位置（逻辑分辨率） */
  sx: number;
  sy: number;
  down: boolean;
  justDown: boolean;
  justUp: boolean;
  wheel: number;
}

export class Input {
  private canvas: HTMLCanvasElement;
  private keys = new Set<string>();
  private pressedThisFrame = new Set<string>();
  private releasedThisFrame = new Set<string>();
  /** 缓存的按下顺序，用于 "WASD + 方向键" 之类的手感优化 */
  readonly pointer: PointerState = {
    sx: VIEW_W / 2,
    sy: VIEW_H / 2,
    down: false,
    justDown: false,
    justUp: false,
    wheel: 0,
  };

  private disposers: Array<() => void> = [];
  enabled = true;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;

    const onKeyDown = (e: KeyboardEvent) => {
      if (!this.enabled) return;
      if (
        e.code === 'Space' ||
        e.code === 'ArrowUp' ||
        e.code === 'ArrowDown' ||
        e.code === 'ArrowLeft' ||
        e.code === 'ArrowRight' ||
        e.code === 'Tab'
      ) {
        e.preventDefault();
      }
      if (!e.repeat) {
        this.pressedThisFrame.add(e.code);
      }
      this.keys.add(e.code);
    };

    const onKeyUp = (e: KeyboardEvent) => {
      this.keys.delete(e.code);
      this.releasedThisFrame.add(e.code);
    };

    const onBlur = () => {
      this.keys.clear();
      this.pointer.down = false;
    };

    const onMouseMove = (e: MouseEvent) => {
      this.updatePointerFromEvent(e.clientX, e.clientY);
    };

    const onMouseDown = (e: MouseEvent) => {
      if (!this.enabled) return;
      e.preventDefault();
      this.pointer.down = true;
      this.pointer.justDown = true;
    };

    const onMouseUp = (e: MouseEvent) => {
      this.pointer.down = false;
      this.pointer.justUp = true;
    };

    const onWheel = (e: WheelEvent) => {
      if (!this.enabled) return;
      e.preventDefault();
      this.pointer.wheel += Math.sign(e.deltaY);
    };

    const onContextMenu = (e: Event) => e.preventDefault();

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mouseup', onMouseUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('contextmenu', onContextMenu);

    this.disposers.push(
      () => window.removeEventListener('keydown', onKeyDown),
      () => window.removeEventListener('keyup', onKeyUp),
      () => window.removeEventListener('blur', onBlur),
      () => window.removeEventListener('mousemove', onMouseMove),
      () => window.removeEventListener('mousedown', onMouseDown),
      () => window.removeEventListener('mouseup', onMouseUp),
      () => canvas.removeEventListener('wheel', onWheel),
      () => canvas.removeEventListener('contextmenu', onContextMenu),
    );
  }

  private updatePointerFromEvent(clientX: number, clientY: number): void {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const nx = (clientX - rect.left) / rect.width;
    const ny = (clientY - rect.top) / rect.height;
    this.pointer.sx = clamp(nx * VIEW_W, -2000, VIEW_W + 2000);
    this.pointer.sy = clamp(ny * VIEW_H, -2000, VIEW_H + 2000);
  }

  /** 每帧末尾调用，清理单帧状态。 */
  endFrame(): void {
    this.pressedThisFrame.clear();
    this.releasedThisFrame.clear();
    this.pointer.justDown = false;
    this.pointer.justUp = false;
    this.pointer.wheel = 0;
  }

  isDown(code: string): boolean {
    return this.keys.has(code);
  }

  wasPressed(code: string): boolean {
    return this.pressedThisFrame.has(code);
  }

  wasReleased(code: string): boolean {
    return this.releasedThisFrame.has(code);
  }

  anyDown(...codes: string[]): boolean {
    for (const c of codes) if (this.keys.has(c)) return true;
    return false;
  }

  /** 归一化移动输入（WASD + 方向键）。 */
  moveVector(): { x: number; y: number } {
    let x = 0;
    let y = 0;
    if (this.anyDown('KeyA', 'ArrowLeft')) x -= 1;
    if (this.anyDown('KeyD', 'ArrowRight')) x += 1;
    if (this.anyDown('KeyW', 'ArrowUp')) y -= 1;
    if (this.anyDown('KeyS', 'ArrowDown')) y += 1;
    if (x !== 0 && y !== 0) {
      const inv = Math.SQRT1_2;
      x *= inv;
      y *= inv;
    }
    return { x, y };
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.disposers = [];
  }
}
