/**
 * 视口：世界坐标 ↔ 屏幕坐标（T1.18，F1-01 / F1-03 / F1-04）。
 *
 * 坐标定义与 `03 §2.4` 的 `view` 字段一一对应（`view.x/y` 就是下面的 offset）：
 *
 * ```
 *   screen = world × zoom + offset        // offsetX/Y 即 view.x / view.y
 *   world  = (screen − offset) ÷ zoom
 * ```
 *
 * 渲染时只对**一个**世界容器做 `translate3d(offset) scale(zoom)`，卡片写世界坐标，
 * 于是平移缩放期间零重排、零样式重算（02 §8.2「GPU 合成」）。
 *
 * ★ 本文件是**纯逻辑**：不 import `obsidian`、不碰 DOM。
 *   「以指针为锚点缩放」这类最容易写错的数学，必须能被单测钉死（04 §12.1）。
 */

import type { BoardViewState } from '../model/schema';
import { clamp, rectCenter, roundTo, type Point, type Rect, type Size } from '../util/geometry';

/** 缩放上下限（F1-01 无限画布，但倍率必须有界，否则浮点会崩） */
export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 8;

/** 一档缩放倍率（⌘= / ⌘- 与工具栏 +/-） */
export const ZOOM_STEP = 1.2;

/** 「适应全部内容」四周留白（屏幕像素） */
export const FIT_PADDING = 64;

/** 视口裁剪外扩（世界像素，02 §8.2 规定 200px） */
export const CULL_PADDING = 200;

/** 写回文件的视口三元组（`background` 属白板设置，不由视口决定） */
export type ViewportState = Pick<BoardViewState, 'x' | 'y' | 'zoom'>;

export class Viewport {
  private offsetX = 0;
  private offsetY = 0;
  private scale = 1;
  /**
   * 裁剪外扩（世界像素，T3.22）。
   *
   * ★ 做成实例属性而不是只留常量：弱机档要把它调小（屏幕外每多留一张卡
   *   就是白建的 DOM）。放在视口上是因为**裁剪矩形本来就由视口算**
   *   （`visibleBounds`），调用方（卡片层 / 分栏层）不必为此多接一个参数。
   */
  cullPadding: number = CULL_PADDING;
  private size: Size = { width: 0, height: 0 };
  private readonly listeners = new Set<() => void>();

  get x(): number {
    return this.offsetX;
  }

  get y(): number {
    return this.offsetY;
  }

  get zoom(): number {
    return this.scale;
  }

  get width(): number {
    return this.size.width;
  }

  get height(): number {
    return this.size.height;
  }

  /** 订阅视口变化（渲染层用）。返回取消订阅函数 */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose(): void {
    this.listeners.clear();
  }

  /** 容器尺寸变化。**不触发通知** —— 尺寸本身不改变世界↔屏幕映射 */
  setSize(width: number, height: number): void {
    if (!Number.isFinite(width) || !Number.isFinite(height)) return;
    this.size = { width: Math.max(0, width), height: Math.max(0, height) };
  }

  toScreen(point: Point): Point {
    return { x: point.x * this.scale + this.offsetX, y: point.y * this.scale + this.offsetY };
  }

  toWorld(point: Point): Point {
    return { x: (point.x - this.offsetX) / this.scale, y: (point.y - this.offsetY) / this.scale };
  }

  /** 世界容器的 CSS 变换值（动态值只能 inline；静态样式全在 styles.css，02 §5.1） */
  transform(): string {
    return `translate3d(${roundTo(this.offsetX)}px, ${roundTo(this.offsetY)}px, 0) scale(${roundTo(
      this.scale,
      4,
    )})`;
  }

  /** 平移（屏幕像素增量）。无限画布 → offset 不做边界钳制 */
  panBy(dx: number, dy: number): void {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    if (dx === 0 && dy === 0) return;
    this.offsetX += dx;
    this.offsetY += dy;
    this.notify();
  }

  /**
   * 缩放到指定倍率，**锚点下方的世界坐标保持不动**（F1-03 的核心不变量）。
   *
   * 推导：令锚点屏幕坐标 a、缩放前世界坐标 w = (a − offset)/z。
   * 要求 a = w·z′ + offset′ → offset′ = a − w·z′。
   *
   * 锚点缺省为视口中心（⌘= / ⌘- 这类命令没有指针位置可用）。
   */
  zoomTo(zoom: number, anchor?: Point): void {
    if (!Number.isFinite(zoom)) return;
    const next = clamp(zoom, MIN_ZOOM, MAX_ZOOM);
    if (next === this.scale) return;

    const target = anchor ?? this.center();
    const world = this.toWorld(target);

    this.scale = next;
    this.offsetX = target.x - world.x * next;
    this.offsetY = target.y - world.y * next;
    this.notify();
  }

  zoomBy(factor: number, anchor?: Point): void {
    if (!Number.isFinite(factor) || factor <= 0) return;
    this.zoomTo(this.scale * factor, anchor);
  }

  /** 缩放一档（`direction`：1 = 放大，-1 = 缩小） */
  zoomStep(direction: 1 | -1, anchor?: Point): void {
    this.zoomBy(direction > 0 ? ZOOM_STEP : 1 / ZOOM_STEP, anchor);
  }

  /** ⌘1：回到 100%，视口中心的世界坐标不动 */
  zoomToActualSize(): void {
    this.zoomTo(1);
  }

  /** 把某个世界坐标点摆到视口正中 */
  centerOn(world: Point): void {
    if (!Number.isFinite(world.x) || !Number.isFinite(world.y)) return;
    this.offsetX = this.size.width / 2 - world.x * this.scale;
    this.offsetY = this.size.height / 2 - world.y * this.scale;
    this.notify();
  }

  /**
   * ⌘0：适应全部内容（F1-04）。
   * `bounds` 为 `null`（空板 / 内容不可用）时退化为「回到 100%」，不做无意义的放大。
   */
  fit(bounds: Rect | null): void {
    if (!bounds) {
      this.zoomToActualSize();
      return;
    }
    // 还没量到尺寸（视图刚挂载 / 面板被折叠）时算不出合理倍率，宁可不做
    if (this.size.width <= 0 || this.size.height <= 0) return;

    const availableWidth = Math.max(1, this.size.width - FIT_PADDING * 2);
    const availableHeight = Math.max(1, this.size.height - FIT_PADDING * 2);
    const zoom = clamp(
      Math.min(
        availableWidth / Math.max(bounds.width, 1),
        availableHeight / Math.max(bounds.height, 1),
      ),
      MIN_ZOOM,
      MAX_ZOOM,
    );

    const center = rectCenter(bounds);
    this.scale = zoom;
    this.offsetX = this.size.width / 2 - center.x * zoom;
    this.offsetY = this.size.height / 2 - center.y * zoom;
    this.notify();
  }

  /**
   * 视口裁剪用的世界矩形（T1.25 消费）。
   * 外扩 `padding` 是为了让"刚滑出屏幕一点点"的卡片仍在 DOM 里，避免边缘抖动。
   *
   * 默认取 {@link cullPadding}（T3.22 后由性能档位写入），显式传参仍然优先 ——
   * 导出那一处刻意传 `0`（多带一圈缓冲会导出一片空白），不能被档位改掉。
   */
  visibleBounds(padding: number = this.cullPadding): Rect {
    const topLeft = this.toWorld({ x: -padding, y: -padding });
    const bottomRight = this.toWorld({
      x: this.size.width + padding,
      y: this.size.height + padding,
    });
    return {
      x: topLeft.x,
      y: topLeft.y,
      width: bottomRight.x - topLeft.x,
      height: bottomRight.y - topLeft.y,
    };
  }

  /** 写回 `.nboard` 的 `view` 字段（T1.22）；数字取整到 2 位小数 */
  toState(): ViewportState {
    return {
      x: roundTo(this.offsetX),
      y: roundTo(this.offsetY),
      zoom: roundTo(this.scale, 4),
    };
  }

  /**
   * 从文件恢复视口（T1.22）。宽容处理脏数据：字段缺失或非法就保留当前值，
   * 绝不因为一个坏数字把画布甩到 1e9 之外。
   */
  applyState(state: Partial<ViewportState> | null | undefined): void {
    if (state) {
      if (typeof state.zoom === 'number' && Number.isFinite(state.zoom) && state.zoom > 0) {
        this.scale = clamp(state.zoom, MIN_ZOOM, MAX_ZOOM);
      }
      if (typeof state.x === 'number' && Number.isFinite(state.x)) this.offsetX = state.x;
      if (typeof state.y === 'number' && Number.isFinite(state.y)) this.offsetY = state.y;
    }
    // 一次性通知：恢复视口只应触发一次重绘，而不是三次
    this.notify();
  }

  private center(): Point {
    return { x: this.size.width / 2, y: this.size.height / 2 };
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
