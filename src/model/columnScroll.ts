/**
 * 分栏内滚动（T2.03 / `F2-7-10`）—— 纯几何，可在 node 下直接单测。
 *
 * ── 为什么需要它 ────────────────────────────────────────────
 * 成员卡片的坐标是**派生状态**（`columnContentBox` + `order` 堆出来的），
 * 所以在此之前"栏不够高"只会让卡片溢到栏外。张数一多就有两个问题：
 *  * 栏一直长到几千像素高，想找其中一张卡得在画布上滚半天（`AC-C-11` 说的是 50 张）；
 *  * 溢出的卡片压在别的栏上，用户会以为"这张卡属于下面那一栏"。
 * 于是栏高到 `COLUMN_LAYOUT.maxAutoHeight` 就不再长，多出来的部分靠**栏内滚动**看。
 *
 * ── 滚动是"视图状态"，不是模型 ──────────────────────────────
 * 偏移量**绝不写进 `.nboard`**：它是"现在看到哪一段"，换台机器、重新打开都该复位，
 * 与"卡片在哪"毫无关系。所以模型里的成员坐标永远是**未滚动**的那一份，
 * 本文件只负责算"该显示成什么样"。撤销一次插入也不会莫名其妙把别人的滚动位置带回来。
 *
 * ★ 三条不变量（渲染层、命中测试、连线、落点判定全靠它们对齐）：
 *  1. `viewport`（内容窗口）只由**分栏几何**决定，与内容多少无关；
 *  2. `offset` 一旦超过 `columnScrollLimit` 就被钳回去 —— 内容变少时不会留下
 *     "滚在一片空白上"的偏移；
 *  3. **视觉坐标 = 模型坐标 − `offset`**（`scrolledRect`），全项目唯一的换算入口。
 *
 * ★ 不 import `obsidian`、不碰 DOM：滚动这套算术（尤其"窗口下沿 = 栏底 − padding"
 *   这个前提）错一格，表现是"最后一张卡永远差一点看不全"，而肉眼很难判断是
 *   滚动算错了还是分栏高度本来就不对。
 */

import { COLUMN_LAYOUT, cardsInColumn, columnContentBox, columnDisplayHeight } from './columns';
import type { BoardFile, Column } from './schema';
import { roundTo, type Rect } from '../util/geometry';

// ─────────────────────────────────────────────────────────────
// 内容窗口
// ─────────────────────────────────────────────────────────────

/**
 * 栏内卡片的可见区域（世界坐标）。
 *
 * ★ 下沿是"栏底 − `padding`"而不是栏底：一个像素的内边距都不留的话，
 *   最后一张卡会贴着栏的圆角，看起来像"没放进去、掉出去了"。
 */
export interface ColumnViewport {
  top: number;
  bottom: number;
  height: number;
}

/** 内容窗口。折叠的栏高度为 0（它的内容槽在 CSS 里整个收掉了） */
export function columnViewport(column: Column): ColumnViewport {
  const top = columnContentBox(column).top;
  const bottom = roundTo(column.y + columnDisplayHeight(column) - COLUMN_LAYOUT.padding);
  return { top, bottom, height: Math.max(0, roundTo(bottom - top)) };
}

/** 内容底边（最后一张卡的**下沿**）。空栏 = 窗口上沿，也就是"没有任何可滚的东西" */
export function columnContentBottom(board: BoardFile, column: Column): number {
  const members = cardsInColumn(board, column.id);
  if (members.length === 0) return columnContentBox(column).top;
  const last = members[members.length - 1];
  return roundTo(last.y + last.height);
}

/**
 * 最多能滚多远（像素）。`0` = 内容装得下，这一栏根本不滚。
 *
 * ★ 用 `contentBottom - viewport.bottom` 而不是再减一个 `gap`：
 *   滚到底时最后一张卡的下沿**正好**贴住窗口下沿，多减一点就会留下一段
 *   永远滚不出来的空白（用户会反复往回滚，以为没滚到底）。
 */
export function columnScrollLimit(board: BoardFile, column: Column): number {
  const viewport = columnViewport(column);
  if (viewport.height <= 0) return 0;
  return Math.max(0, roundTo(columnContentBottom(board, column) - viewport.bottom));
}

/** 把偏移钳进 `[0, columnScrollLimit]`。非有限值一律当 0（DOM 里读到过 `NaN`） */
export function clampColumnScroll(board: BoardFile, column: Column, offset: number): number {
  if (!Number.isFinite(offset) || offset <= 0) return 0;
  return Math.min(roundTo(offset), columnScrollLimit(board, column));
}

/**
 * 滚动条内容该有多高（px）—— 渲染层拿它撑一个占位块。
 *
 * ★ 为什么不是"所有成员的总高度"：滚动行程必须**正好**等于 `scrollLimit`。
 *   占位块比实际内容矮，最后一张卡就永远滚不出来；高了则会多出一段空白。
 *   这里用 `contentBottom - viewport.top`，减去窗口高度后恰好是 `scrollLimit`。
 */
export function columnScrollExtent(board: BoardFile, column: Column): number {
  const viewport = columnViewport(column);
  return Math.max(0, roundTo(columnContentBottom(board, column) - viewport.top));
}

// ─────────────────────────────────────────────────────────────
// 渲染状态
// ─────────────────────────────────────────────────────────────

/** 一栏的滚动状态：窗口 + 当前偏移 */
export interface ColumnScrollView {
  viewport: ColumnViewport;
  offset: number;
}

/**
 * 组一份可渲染的滚动状态；**装得下就是 `null`**。
 *
 * ★ 返回 `null` 而不是 `{ offset: 0 }`：调用方（卡片层 / 连线）据此走**原来的**
 *   那条路径（一字不差地写模型坐标）。多一处"偏移为 0 但仍在换算"的分支，
 *   就多一次"某条路径忘了减偏移"的机会。
 */
export function columnScrollView(
  board: BoardFile,
  column: Column,
  offset: number,
): ColumnScrollView | null {
  const viewport = columnViewport(column);
  if (viewport.height <= 0) return null;
  if (columnScrollLimit(board, column) <= 0) return null;
  return { viewport, offset: clampColumnScroll(board, column, offset) };
}

/** 模型矩形 → 视觉矩形（唯一换算入口，见文件头的不变量 3） */
export function scrolledRect(rect: Rect, offset: number): Rect {
  return { x: rect.x, y: roundTo(rect.y - offset), width: rect.width, height: rect.height };
}

/**
 * 卡片被窗口切掉多少（视觉坐标入参）。
 *
 * 三种结果对应三种渲染写法，刻意分开：
 *  * `none`  → 完全在窗口里，**不要写 `clip-path`**（省一次样式写入，也避免把
 *              卡片自己的阴影裁掉）；
 *  * `inset` → 写 `clip-path: inset(top 0 bottom 0)`；
 *  * `hidden`→ 整张看不见。
 */
export type ScrollClip =
  { kind: 'none' } | { kind: 'inset'; top: number; bottom: number } | { kind: 'hidden' };

/**
 * 算出这张卡该被窗口切掉多少。
 *
 * ★ `hidden` 用 `inset(50% 0 50% 0)` 表达而不是 `display: none`：
 *   卡片层在 `display: none` 的元素上量出 `clientWidth === 0`，
 *   自动高度（T1.38）会把卡片压成 0 —— 滚回来看见一张没有内容的卡。
 */
export function scrollClip(visual: Rect, viewport: ColumnViewport): ScrollClip {
  const top = Math.max(0, roundTo(viewport.top - visual.y));
  const bottom = Math.max(0, roundTo(visual.y + visual.height - viewport.bottom));
  if (top <= 0 && bottom <= 0) return { kind: 'none' };
  // 半个像素的容差：正好被切掉一张卡的高度时算"看不见"，否则会留一条 0.5px 的边
  if (top + bottom >= visual.height - 0.5) return { kind: 'hidden' };
  return { kind: 'inset', top, bottom };
}

/** `ScrollClip` → CSS `clip-path` 值（`none` 用空串表示"不写"） */
export function clipPathValue(clip: ScrollClip): string {
  if (clip.kind === 'none') return '';
  if (clip.kind === 'hidden') return 'inset(50% 0 50% 0)';
  return `inset(${clip.top}px 0 ${clip.bottom}px 0)`;
}
