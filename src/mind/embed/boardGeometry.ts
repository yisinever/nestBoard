/**
 * 一棵脑图**摆在白板上**的几何（`2.2.0` 批 4）—— 纯逻辑，不碰 DOM。
 *
 * 白板上的脑图是一个**没有尺寸**的容器：`Mind.x/y` 只有一个点（**根节点中心**），
 * 其余全靠布局现算。于是"这棵树占多大 / 每个节点在哪儿"必须由**同一个函数**回答 ——
 * 缩略图、PNG / PDF 导出、SVG 导出、连线端点表四处都要它。各写一份的话，
 * 最典型的后果是"导出框留够了、树却画在框外"。
 *
 * ★ 住在这里（`mind/embed/`）而不是 `mind/view/`：`06 §2` 钉着"脑图不许依赖白板
 *   视图层"，而 `mind/layout` 与 `mind/model` 两边都能引。
 */

import { roundTo, type Point, type Rect, type Size } from '../../util/geometry';
import { estimateNodeSizeByDepth } from '../layout/measure';
import { directionForStructure, layoutMindEqualLevels, type MindLayout } from '../layout/tree';
import { depthOf } from '../model/ops';
import type { MindFile } from '../model/schema';
import { pruneMindForEmbed } from './pruneTree';

/** 一棵脑图这一刻在白板上的摆法 */
export interface MindPlacement {
  /** 实际画出来那一份模型（**收起的分支已经摘掉**） */
  file: MindFile;
  layout: MindLayout;
  /** 布局坐标 → 世界坐标的平移量（`Mind.x/y` 是根节点中心） */
  dx: number;
  dy: number;
}

/**
 * 算出一棵脑图的摆法；`model` 为 `null`（文件脑图还没读到）⇒ `null`。
 *
 * ★ **不截断深度**（`Infinity`）：画布上要看整棵树，而且第 5 层、第 10 层的节点
 *   也要有盒子 —— 否则连到它们身上的线永远画不出来。折叠那一档两种摆法都照旧
 *   （用户自己收起来的一支，确实不该有盒子）。
 * ★ 尺寸用**估算值**（这一层拿不到 DOM）：这一层服务于缩略图 / 取景 / 导出，
 *   量到真值只为了让一两个像素更准，却要多跑一遍 DOM 测量。
 * ★ 但估算**必须按层级**（`estimateNodeSizeByDepth`）：默认估算是"清一色 14px"，
 *   拿它算出来的树在导出图里中心主题会小一大圈，而字仍按层级画 —— 用户看到的就是
 *   "导出 PNG 和原脑图差很多"。画布那边不受影响（它量 DOM）。
 */
export function mindPlacement(anchor: Point, model: MindFile | null): MindPlacement | null {
  if (!model) return null;
  const file = pruneMindForEmbed(model, Number.POSITIVE_INFINITY).file;
  // ★ **两遍**布局（`layoutMindEqualLevels`）：同层等宽那一条在画布上由 CSS + 第二次测量
  //   落地，这一侧没有 DOM ⇒ 必须把它算进几何，否则导出图里同层节点参差不齐、
  //   整体比画布上窄（用户 2026-09-22："绘制尺寸不是很还原"）
  const layout = layoutMindEqualLevels(file, {
    direction: directionForStructure(model.view.structure ?? 'logic-right'),
    sizeOf: (node) => estimateNodeSizeByDepth(node, depthOf(file, node.id)),
  });
  const root = layout.boxes.get(model.rootId);
  if (!root) return null;
  return {
    file,
    layout,
    dx: anchor.x - (root.x + root.width / 2),
    dy: anchor.y - (root.y + root.height / 2),
  };
}

/**
 * 根节点尺寸的**兜底**（px）：模型还没读到、量不出真的那个框时用。
 *
 * ★ 按"中心主题"那一档估的（30px 字号 + 14px 内边距 ⇒ 四五个字大约就这么宽）。
 *   位置**不**兜底 —— 容器的 `x/y` 就是根节点中心，那是准的。
 */
export const MIND_ROOT_FALLBACK_SIZE: Size = { width: 180, height: 56 };

/** 模型没读到时的根节点框（以锚点为中心的小盒子，见 {@link MIND_ROOT_FALLBACK_SIZE}） */
export function mindRootFallbackRect(anchor: Point): Rect {
  return {
    x: roundTo(anchor.x - MIND_ROOT_FALLBACK_SIZE.width / 2),
    y: roundTo(anchor.y - MIND_ROOT_FALLBACK_SIZE.height / 2),
    width: MIND_ROOT_FALLBACK_SIZE.width,
    height: MIND_ROOT_FALLBACK_SIZE.height,
  };
}

/** 每个节点在世界坐标里的盒子（键 = 节点 id）—— 连线的端点表用它 */
export function mindNodeRects(place: MindPlacement): Map<string, Rect> {
  const rects = new Map<string, Rect>();
  for (const [nodeId, box] of place.layout.boxes) {
    rects.set(nodeId, {
      x: box.x + place.dx,
      y: box.y + place.dy,
      width: box.width,
      height: box.height,
    });
  }
  return rects;
}

/**
 * 这棵树在世界坐标里的外接框 —— **缩略图 / 导出取景 / 演示取景**都用它。
 *
 * ★ 演示那一侧特别看重它**不含 DOM 实测**：它只由"纯布局 + 锚点（容器的 `x/y` = 根节点中心）"
 *   决定 ⇒ 讲着讲着不会飘（用户 2026-09-23："应该是以脑图根节点，且看到全脑图为视口"）。
 *   画布上那份"已挂载的实测框"（`MindLayer.boundsOf`）**不要**用在这里。
 */
export function mindBounds(place: MindPlacement): Rect | null {
  const bounds = place.layout.bounds;
  if (!bounds) return null;
  return {
    x: bounds.x + place.dx,
    y: bounds.y + place.dy,
    width: bounds.width,
    height: bounds.height,
  };
}
