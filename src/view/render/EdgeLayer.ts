/**
 * 连线层：Canvas + DPR 适配 + 脏区重绘 + 随视口变换（T1.27）。
 *
 * 位置在 `02 §2` 的层级③：**卡片下方**（`.nestboard-edge-canvas` 的 z-index 比
 * `.nestboard-world` 低），所以连线永远从卡片背后穿过，不会盖住卡片内容。
 *
 * 骨架（相机跟随、脏区账本、重绘协议）都在 `DirtyCanvasLayer` 里，
 * 本文件只剩下"连线这一层特有的两件事"：清残影要留多宽的缓冲、以及把绘制外包给 painter。
 *
 * ★ 为什么用「脏区 + 重绘回调」而不是每次全量重画：
 *   拖动一张卡时只有它周围的一小块像素变了，全量 `clearRect + 重画全部连线`
 *   在 1000 卡场景下每帧都要遍历所有连线（`02 §8.2`「Canvas 脏区重绘」）。
 *
 * ★ 不 import `obsidian`；纯几何部分（`DirtyRegion`）可单测。
 */

import type { Rect } from '../../util/geometry';
import { DirtyCanvasLayer } from './DirtyCanvasLayer';

/**
 * 清理脏区时向外多清一圈屏幕像素：
 * 连线有宽度（1~3px）与圆角箭头，紧贴边界清会留下"残影边"。
 */
const STROKE_PADDING_PX = 8;

/** 交给绘制方的这一帧：坐标系已是世界坐标，`region` 外的连线不必考虑 */
export interface EdgeFrame {
  ctx: CanvasRenderingContext2D;
  /** 本次需要重绘的**世界**矩形（裁剪用） */
  region: Rect;
  zoom: number;
}

/** T1.68 起接入的绘制回调 */
export type EdgePainter = (frame: EdgeFrame) => void;

export class EdgeLayer extends DirtyCanvasLayer {
  private painter: EdgePainter | null = null;

  constructor(host: HTMLElement) {
    super(host, 'nestboard-edge-canvas');
  }

  /** 挂载绘制逻辑（T1.68）。传 `null` 即卸载；两者都会立即重绘 */
  setPainter(painter: EdgePainter | null): void {
    this.painter = painter;
    this.invalidate();
  }

  protected clearPaddingPx(): number {
    return STROKE_PADDING_PX;
  }

  protected paintContent(region: Rect): void {
    // 没挂 painter（T1.27 骨架阶段）时什么都不画 —— 但脏区已经清干净了，
    // 这正是"撤掉 painter 后旧连线立刻消失"的实现方式
    this.painter?.({ ctx: this.ctx, region, zoom: this.cameraZoom });
  }
}
