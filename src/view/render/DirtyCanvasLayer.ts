/**
 * 「相机 + 脏区」画布层基类（T1.27 连线层 / T3.06 手绘层共用）。
 *
 * 连线层画的是连线，手绘层画的是笔画，但骨架一模一样：
 *
 *   1. **跟住相机**：每帧把 `Viewport` 的 `x/y/zoom` 抄下来，尺寸变化时重建位图
 *      （`Viewport.setSize()` 刻意不发通知，所以借 `syncCanvas()` 这一趟一起对齐）；
 *   2. **只清脏的那一块**：把世界矩形换算成屏幕矩形、外扩一圈、只清它；
 *   3. **重绘是可重入的**：绘制方可能在回调里再次标脏（自反馈），
 *      必须折叠成"先清账、再绘制"的一轮循环，而不是递归。
 *
 * ★ 抽成基类的理由：这三条各有"错了很难查"的表现 —— 残影、整层闪、无限递归。
 *   抄两遍就是两个各自出错的机会。
 *   基类负责**清干净 + 摆好坐标系**，子类只回答"画什么"（`paintContent`）。
 *
 * ★ 与 `CardLayer` 的分工：Canvas 层**不参与命中测试**（`pointer-events: none`
 *   写在 styles.css 里），`02 §2` 规定"唯一可交互的内容层"是卡片层。
 *   所以手绘的指针事件是控制器挂在容器上**代收**的（见 `InkController`）。
 *
 * ★ 不 import `obsidian`，只用标准 DOM / Canvas API。
 */

import { expandRect, type Rect } from '../../util/geometry';
import type { Viewport } from '../../canvas/Viewport';
import { CanvasLayer } from './CanvasLayer';
import { DirtyRegion, type DirtySnapshot } from './DirtyRegion';

interface Camera {
  x: number;
  y: number;
  zoom: number;
}

export abstract class DirtyCanvasLayer extends CanvasLayer {
  private readonly dirty = new DirtyRegion();
  private camera: Camera = { x: 0, y: 0, zoom: 1 };
  /** 重绘可重入（`paintContent` 内可能再标脏），用它把嵌套调用折叠成一轮循环 */
  private rendering = false;

  /**
   * 清理脏区时向外多清一圈**屏幕**像素。
   *
   * 子类必须自己给这个数：连线是 1~3px 线宽 + 圆角箭头，手绘是随缩放变化的笔宽 ——
   * 统一给一个常量，总有一层会留下"擦不干净的残影边"。
   */
  protected abstract clearPaddingPx(): number;

  /**
   * 画这一帧的内容。调用时已经：清完脏区、坐标系摆到**世界坐标**。
   * `region` 是本次需要覆盖的世界矩形 —— 外面画了也会被下一帧清掉，白费。
   */
  protected abstract paintContent(region: Rect): void;

  /** 当前缩放（子类换算"屏幕阈值 → 世界阈值"时用得到） */
  protected get cameraZoom(): number {
    return this.camera.zoom;
  }

  /**
   * 每帧入口：跟随视口尺寸与相机。
   *
   * 尺寸也在这里对齐 —— `Viewport.setSize()` 刻意不发通知，但 `syncCanvas()`
   * 在容器尺寸变化时一定会被调用（`ResizeObserver`），借这一趟把画布尺寸同步掉，
   * 省得再给 `BoardView` 增加一条"记得 resize 每个 Canvas 层"的隐式约定。
   */
  sync(viewport: Viewport): void {
    const cameraChanged =
      viewport.x !== this.camera.x ||
      viewport.y !== this.camera.y ||
      viewport.zoom !== this.camera.zoom;
    if (cameraChanged) {
      this.camera = { x: viewport.x, y: viewport.y, zoom: viewport.zoom };
    }

    // 直接调基类：避免将来子类覆盖 resize 后再重复一次 render
    const resized = super.resize(viewport.width, viewport.height);
    if (resized || cameraChanged) this.dirty.addAll();

    this.render();
  }

  /**
   * 局部标脏（T1.70：一张卡移动后只重画它周围）。
   * 传世界矩形；省略即整层重绘。
   */
  invalidate(rect?: Rect | null): void {
    this.dirty.add(rect);
    this.render();
  }

  // ── 重绘 ────────────────────────────────────────────────

  private render(): void {
    if (this.rendering || this.dirty.isEmpty) return;
    this.rendering = true;
    try {
      // 绘制方可能在回调里再次标脏（例如重排后锚点变化）。
      // 「先清账、再绘制」配合循环，能保证这种自反馈不会丢帧，也不会无限递归。
      while (!this.dirty.isEmpty) {
        const snapshot = this.dirty.peek();
        this.dirty.clear();
        this.paint(snapshot);
      }
    } finally {
      this.rendering = false;
    }
  }

  private paint(snapshot: DirtySnapshot): void {
    if (snapshot.all) {
      this.clear();
    } else if (snapshot.bounds) {
      // 世界矩形 → 屏幕矩形（+ 线宽缓冲）后只清这一块
      this.clearScreenRect(expandRect(this.toScreenRect(snapshot.bounds), this.clearPaddingPx()));
    }

    const region = snapshot.all || !snapshot.bounds ? this.visibleWorldRect() : snapshot.bounds;
    this.applyCamera(this.camera.zoom, this.camera.x, this.camera.y);
    this.paintContent(region);
  }

  private toScreenRect(rect: Rect): Rect {
    const { x, y, zoom } = this.camera;
    return {
      x: rect.x * zoom + x,
      y: rect.y * zoom + y,
      width: rect.width * zoom,
      height: rect.height * zoom,
    };
  }

  /** 当前视口对应的世界矩形（整层重绘时交给绘制方做裁剪） */
  private visibleWorldRect(): Rect {
    const { x, y, zoom } = this.camera;
    return {
      x: -x / zoom,
      y: -y / zoom,
      width: this.width / zoom,
      height: this.height / zoom,
    };
  }
}
