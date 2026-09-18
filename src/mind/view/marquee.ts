/**
 * 框选（左键在空白处拖出一个矩形，`06 §4.2`）—— 纯函数。
 *
 * ── 与白板同一把尺子 ────────────────────────────────────────
 *
 * 矩形的规范化用 `util/geometry` 的 `rectFromPoints`（从白板那边挪到共享层的），
 * 命中判据用同一个 `rectsIntersect`：**部分压线也算选中**（"看得见却框不中"是最气人的
 * 一种不一致）。白板的框选走 `cardsIntersecting`，脑图走这里的 `boxesWithin` ——
 * 名字不同是因为类型不同，判据是同一条。
 *
 * ★ 折叠藏起来的节点**不在** `boxes` 里（布局压根没排它们），于是框不到 —— 这是刻意的：
 *   选中一个看不见的节点，用户既没法确认也没法取消，而删除会把它们一起带走。
 *
 * ★ 纯逻辑：不 import `obsidian`、不碰 DOM。
 */

import { rectsIntersect, type Rect } from '../../util/geometry';
import type { NodeBox } from '../layout/tree';

/**
 * 与这个矩形（**世界坐标**）相交的节点。
 *
 * ★ 入参是世界矩形：屏幕上同样大小的一块，在不同缩放下对应的世界范围完全不同 ——
 *   拿屏幕坐标去比世界坐标的盒子，只在 100% 缩放时才对。
 */
export function boxesWithin(boxes: ReadonlyMap<string, NodeBox>, rect: Rect): string[] {
  // 空矩形（点一下没拖动）不选中任何东西：否则"点空白清空选区"会变成"框住占位处那一堆"
  if (rect.width <= 0 && rect.height <= 0) return [];

  const hit: string[] = [];
  for (const box of boxes.values()) {
    if (rectsIntersect(box, rect)) hit.push(box.id);
  }
  return hit;
}
