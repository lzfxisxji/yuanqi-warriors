/** 战斗反馈：屏幕震动、伤害数字、命中停顿、全屏闪光。 */
import { TAU, clamp, lerp } from '../core/math';
import { MAX_DAMAGE_NUMBERS, SHAKE_SCALE } from '../data/config';

export class ScreenShake {
  private trauma = 0;
  private seedPhase = Math.random() * 1000;
  scale = 1;
  offsetX = 0;
  offsetY = 0;
  rotation = 0;

  add(amount: number): void {
    this.trauma = clamp(this.trauma + amount * this.scale, 0, 1);
  }

  update(dt: number): void {
    this.seedPhase += dt;
    if (this.trauma <= 0) {
      this.offsetX = 0;
      this.offsetY = 0;
      this.rotation = 0;
      return;
    }
    this.trauma = Math.max(0, this.trauma - dt * 1.7);
    const power = this.trauma * this.trauma;
    const t = this.seedPhase * 46;
    // 多个不同频率的正弦叠加，比纯随机抖动更顺滑
    this.offsetX = (Math.sin(t * 1.7 + 1.3) + Math.sin(t * 3.1) * 0.5) * power * SHAKE_SCALE;
    this.offsetY = (Math.cos(t * 2.3 + 0.7) + Math.sin(t * 4.7) * 0.4) * power * SHAKE_SCALE;
    this.rotation = Math.sin(t * 2.9) * power * 0.012;
  }

  reset(): void {
    this.trauma = 0;
    this.offsetX = 0;
    this.offsetY = 0;
    this.rotation = 0;
  }
}

export interface DamageNumber {
  x: number;
  y: number;
  vy: number;
  vx: number;
  life: number;
  maxLife: number;
  value: number;
  crit: boolean;
  color: string;
  scale: number;
}

export class DamageNumbers {
  list: DamageNumber[] = [];
  enabled = true;

  add(x: number, y: number, value: number, crit: boolean, color = '#ffe9b0'): void {
    if (!this.enabled) return;
    if (this.list.length >= MAX_DAMAGE_NUMBERS) this.list.shift();
    this.list.push({
      x: x + (Math.random() - 0.5) * 12,
      y: y - 6,
      vx: (Math.random() - 0.5) * 34,
      vy: -74 - Math.random() * 30,
      life: crit ? 1.05 : 0.78,
      maxLife: crit ? 1.05 : 0.78,
      value: Math.round(value * 10) / 10,
      crit,
      color,
      scale: crit ? 1.42 : 1,
    });
  }

  update(dt: number): void {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const n = this.list[i]!;
      n.life -= dt;
      if (n.life <= 0) {
        this.list.splice(i, 1);
        continue;
      }
      n.x += n.vx * dt;
      n.y += n.vy * dt;
      n.vy += 190 * dt;
      n.vx *= Math.exp(-2.4 * dt);
    }
  }

  clear(): void {
    this.list.length = 0;
  }

  draw(ctx: CanvasRenderingContext2D): void {
    if (!this.list.length) return;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const n of this.list) {
      const t = clamp(1 - n.life / n.maxLife, 0, 1);
      const alpha = t < 0.72 ? 1 : 1 - (t - 0.72) / 0.28;
      const pop = t < 0.16 ? lerp(0.55, 1.12, t / 0.16) : 1;
      const size = (n.crit ? 26 : 19) * n.scale * pop;
      ctx.globalAlpha = clamp(alpha, 0, 1);
      ctx.font = `700 ${size.toFixed(1)}px "Segoe UI", "PingFang SC", sans-serif`;
      ctx.lineWidth = 3.4;
      ctx.strokeStyle = 'rgba(12,10,18,0.85)';
      const text = n.crit ? `${Math.round(n.value * 10) / 10}!` : `${Math.round(n.value * 10) / 10}`;
      ctx.strokeText(text, n.x, n.y);
      ctx.fillStyle = n.crit ? '#ffd166' : n.color;
      ctx.fillText(text, n.x, n.y);
    }
    ctx.restore();
  }
}

/** 命中停顿 + 慢动作控制。 */
export class TimeControl {
  private hitStopTimer = 0;
  private hitStopDuration = 0;
  /** 额外时间缩放（例如 Boss 死亡演出） */
  slowFactor = 1;

  hitStop(duration: number, factor = 0.08): void {
    if (duration <= this.hitStopTimer) return;
    this.hitStopDuration = duration;
    this.hitStopTimer = duration;
    this.hitStopFactor = factor;
  }

  private hitStopFactor = 0.08;

  update(dt: number): void {
    if (this.hitStopTimer > 0) this.hitStopTimer = Math.max(0, this.hitStopTimer - dt);
  }

  get timeScale(): number {
    const stop = this.hitStopTimer > 0 ? this.hitStopFactor : 1;
    return stop * this.slowFactor;
  }

  reset(): void {
    this.hitStopTimer = 0;
    this.slowFactor = 1;
  }
}

/** 全屏色闪（受击 / 爆炸 / 拾取）。 */
export class FlashOverlay {
  private strength = 0;
  private color = '255,80,80';
  private decay = 3.2;

  trigger(color: string, strength = 0.45, decay = 3.4): void {
    this.color = color;
    this.strength = Math.max(this.strength, strength);
    this.decay = decay;
  }

  update(dt: number): void {
    if (this.strength > 0) this.strength = Math.max(0, this.strength - dt * this.decay);
  }

  draw(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    if (this.strength <= 0.002) return;
    ctx.save();
    ctx.globalAlpha = this.strength;
    ctx.fillStyle = `rgb(${this.color})`;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }

  reset(): void {
    this.strength = 0;
  }
}

/** 画一条能量束（激光 / 曳光），带核心与辉光双层。 */
export function drawBeam(
  ctx: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  width: number,
  core: string,
  glow: string,
  time: number,
): void {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'round';
  ctx.strokeStyle = glow;
  ctx.globalAlpha = 0.5;
  ctx.lineWidth = width * 3.1;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();

  ctx.globalAlpha = 0.85;
  ctx.strokeStyle = glow;
  ctx.lineWidth = width * 1.7;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();

  ctx.globalAlpha = 1;
  ctx.strokeStyle = core;
  ctx.lineWidth = Math.max(1.4, width * (0.85 + Math.sin(time * 46) * 0.09));
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
  ctx.restore();
}

/** 攻击预警：地面扩散的警示环。 */
export function drawWarningCircle(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  progress: number,
  color = '255,90,70',
): void {
  const p = clamp(progress, 0, 1);
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = `rgba(${color},${0.12 + p * 0.2})`;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = `rgba(${color},${0.35 + p * 0.5})`;
  ctx.lineWidth = 2.6 + p * 2.4;
  ctx.beginPath();
  ctx.arc(x, y, radius * (0.35 + p * 0.65), 0, TAU);
  ctx.stroke();
  ctx.restore();
}

/** 攻击预警：直线/矩形冲刺路径。 */
export function drawWarningRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  angle: number,
  length: number,
  width: number,
  progress: number,
  color = '255,90,70',
): void {
  const p = clamp(progress, 0, 1);
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = `rgba(${color},${0.1 + p * 0.22})`;
  ctx.fillRect(0, -width / 2, length * (0.4 + p * 0.6), width);
  ctx.strokeStyle = `rgba(${color},${0.4 + p * 0.45})`;
  ctx.lineWidth = 2.2;
  ctx.strokeRect(0, -width / 2, length * (0.4 + p * 0.6), width);
  ctx.restore();
}
