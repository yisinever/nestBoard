/**
 * Canvas 层的公共骨架（T1.27 / T1.28 共用）。
 *
 * 连线层与覆盖层都画在 Canvas 上，且都要处理同样的三件事：
 *   1. **DPR 适配**：`canvas.width` 必须是 CSS 像素 × devicePixelRatio，
 *      否则 Retina 上线条发虚、1px 线变成 2px 灰边；
 *   2. **尺寸跟随视口**：Canvas 铺满画布容器（屏幕坐标系），不放进 `.nestboard-world`
 *      —— 放进去会被 CSS transform 缩放栅格，放大后糊成一片；
 *   3. **坐标系复位**：画世界坐标前 `setTransform(ratio·zoom, …, ratio·tx, ratio·ty)`，
 *      画屏幕坐标前复位成 `setTransform(ratio, 0, 0, ratio, 0, 0)`。
 *
 * ★ 与 `CardLayer` 的分工：Canvas 层**不参与命中测试**（`pointer-events: none`
 *   写在 styles.css 里），02 §2 规定"唯一可交互的内容层"是卡片层。
 *
 * ★ 不 import `obsidian`，只用标准 DOM / Canvas API。
 */

import type { Rect } from '../../util/geometry';

/**
 * DPR 上限。手机上有 3.5x 甚至 4x 的屏，`440 × 900 × 4²` 的位图接近 16MB，
 * 多开几个白板标签就会顶到 `02 §8.1` 的内存门槛 —— 超过 3 倍肉眼已无收益。
 */
export const MAX_DEVICE_PIXEL_RATIO = 3;

/** 当前设备像素比（已钳制）。非浏览器环境（单测）回落到 1 */
export function currentDevicePixelRatio(): number {
  if (typeof window === 'undefined') return 1;
  const ratio = window.devicePixelRatio;
  if (!Number.isFinite(ratio) || ratio <= 1) return 1;
  return Math.min(ratio, MAX_DEVICE_PIXEL_RATIO);
}

export class CanvasLayer {
  readonly canvas: HTMLCanvasElement;
  protected readonly ctx: CanvasRenderingContext2D;
  /**
   * 本层的 DPR 上限（T3.22）。
   *
   * ★ 默认 {@link MAX_DEVICE_PIXEL_RATIO}，由视图按性能档位下调。做成**实例**属性
   *   而不是模块常量：同一台设备上，弱机档只该影响开着的白板，
   *   而不该把模块级常量改掉（那会连带影响之后打开的所有视图，且再也调不回来）。
   */
  private dprCap = MAX_DEVICE_PIXEL_RATIO;

  /** CSS 像素尺寸（与 canvas.width / ratio 对应） */
  protected width = 0;
  protected height = 0;
  protected ratio = 1;

  constructor(host: HTMLElement, className: string) {
    const canvas = document.createElement('canvas');
    canvas.className = className;
    // 纯装饰层：读屏软件没必要念它（无障碍，02 §7）
    canvas.setAttribute('aria-hidden', 'true');

    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('nestboard: 无法获取 2D 画布上下文');

    host.appendChild(canvas);
    this.canvas = canvas;
    this.ctx = ctx;
  }

  /**
   * 下调本层的 DPR 上限（T3.22）。
   *
   * ★ 只往下调、只接受有效值：这是个"省内存"的开关，传进来一个越界值
   *   （`0`、`NaN`、`8`）时**保持原值**比"改成一个奇怪的数"安全 ——
   *   位图尺寸算错的后果是整层画不出来。
   */
  capDevicePixelRatio(cap: number): void {
    if (!Number.isFinite(cap) || cap <= 0) return;
    this.dprCap = Math.min(cap, MAX_DEVICE_PIXEL_RATIO);
  }

  /**
   * 跟随容器尺寸。返回 `true` 表示尺寸（或 DPR）真的变了 ——
   * 调用方据此决定是否重绘：**改 `canvas.width` 会清空位图**，不重绘就是一片空白。
   */
  resize(width: number, height: number, dpr: number = currentDevicePixelRatio()): boolean {
    const nextWidth = Math.max(0, Math.round(width));
    const nextHeight = Math.max(0, Math.round(height));
    const nextRatio = Number.isFinite(dpr) && dpr > 1 ? Math.min(dpr, this.dprCap) : 1;
    if (nextWidth === this.width && nextHeight === this.height && nextRatio === this.ratio) {
      return false;
    }

    this.width = nextWidth;
    this.height = nextHeight;
    this.ratio = nextRatio;
    // 直接赋 width/height 即可清空并重建位图（不必再 clearRect）
    this.canvas.width = Math.round(nextWidth * nextRatio);
    this.canvas.height = Math.round(nextHeight * nextRatio);
    this.canvas.style.width = `${nextWidth}px`;
    this.canvas.style.height = `${nextHeight}px`;
    return true;
  }

  /** 切回**屏幕坐标系**（1 单位 = 1 CSS 像素） */
  protected resetTransform(): void {
    this.ctx.setTransform(this.ratio, 0, 0, this.ratio, 0, 0);
  }

  /**
   * 切到**世界坐标系**：此后 `ctx` 的输入即世界坐标，屏幕映射由变换矩阵完成，
   * 与 `Viewport` 的 `screen = world × zoom + offset` 严格一致（同样的公式，同一份语义）。
   */
  protected applyCamera(zoom: number, offsetX: number, offsetY: number): void {
    this.ctx.setTransform(
      this.ratio * zoom,
      0,
      0,
      this.ratio * zoom,
      this.ratio * offsetX,
      this.ratio * offsetY,
    );
  }

  /** 清空整层（屏幕坐标） */
  clear(): void {
    this.resetTransform();
    this.ctx.clearRect(0, 0, this.width, this.height);
  }

  /** 只清一小块（脏区重绘用，坐标同样是屏幕 CSS 像素） */
  clearScreenRect(rect: Rect): void {
    this.resetTransform();
    this.ctx.clearRect(rect.x, rect.y, rect.width, rect.height);
  }

  dispose(): void {
    this.canvas.remove();
  }
}
