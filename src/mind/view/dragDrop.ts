/**
 * 拖拽落点判定（`06 §4.1`，P3-b）—— 纯函数：给一堆盒子 + 指针位置，回答"松手会落在哪"。
 *
 * 抽出来的理由与 `keys.ts` 一样：落点判定是拖拽里**唯一会出错的部分**（挂错爹、挂成环、
 * 原地放下却把节点甩到别处），而它一笔一画都能在 node 下量出来 —— 真接上指针反而难测。
 *
 * ── 四种结果 ────────────────────────────────────────────────
 *
 * | 指针在哪 | 结果 |
 * | --- | --- |
 * | 还在**出发时的盒子**里（拖起来又放下） | `none` —— 原地放下，什么都不做 |
 * | 在某个合法节点上 | `child` —— 成为它的子节点，插在指针高度对应的位置 |
 * | 在自己的**后代**上 | `none` —— 那是成环，明确拒绝（比"悄悄挂到别处"好） |
 * | 空白处 | `free` —— 变成**悬浮节点**，落点就是指针位置 |
 *
 * ★ 不 import `obsidian`、不碰 DOM：只认世界坐标与盒子。
 */

import { rectContainsPoint, type Point, type Rect } from '../../util/geometry';
import type { NodeBox } from '../layout/tree';

export type MindDropTarget =
  | { kind: 'none' }
  | { kind: 'child'; parentId: string; index: number }
  | { kind: 'free'; point: Point }
  /**
   * 落在**自己的子孙**上：这里是成环，明确拒绝。
   *
   * ★ 与 `none` 分开是为了**能给出反馈**：两个都不改模型，但用户看到的东西必须不同 ——
   *   `blocked` 画一个红环（"这儿放不了"），`none` 什么都不画（"还在原地"）。
   *   合成一个的话，用户只会觉得"拖拽又坏了"。
   */
  | { kind: 'blocked'; nodeId: string };

export interface MindDropInput {
  /** 可见节点的盒子（布局给的；含被拖的那个） */
  boxes: ReadonlyMap<string, NodeBox>;
  /** 某个节点的子盒子（按次序）—— 用来算"插到第几个" */
  childBoxesOf: (parentId: string) => readonly NodeBox[];
  /** 被拖的节点（它自己的盒子不参与命中） */
  draggedId: string;
  /**
   * **出发时**那个盒子的位置（世界坐标，拖动期间不动）。
   *
   * ★ 用途只有一个：指针还落在这里 = "拖起来又放下"，什么都不该发生。
   * ★ **不能拿"预览盒"来判**：预览盒是跟着指针走的，指针**永远**在它里面 ——
   *   那一条会把每一次拖拽都判成"原地放下"。这个 bug 真的发生过一次
   *   （症状是"拖了跟没拖一样，很少能成功"），改回来时务必认清这一点。
   */
  ownBox: Rect;
  /** 不能当父的节点：自己 + 自己的全部后代（挂上去就成环） */
  forbidden: ReadonlySet<string>;
  /** 指针的世界坐标 */
  pointer: Point;
}

export function resolveDrop(input: MindDropInput): MindDropTarget {
  const { boxes, draggedId, ownBox, forbidden, pointer } = input;

  // 指针还在**出发的位置**上：这一下是"拖起来又放下"，什么都不该发生
  if (rectContainsPoint(ownBox, pointer)) return { kind: 'none' };

  const hit = topmostBoxAt(boxes, draggedId, pointer);
  if (!hit) return { kind: 'free', point: { x: pointer.x, y: pointer.y } };
  if (forbidden.has(hit.id)) return { kind: 'blocked', nodeId: hit.id };

  return { kind: 'child', parentId: hit.id, index: insertionIndexFor(input, hit.id) };
}

/**
 * 命中最深的那一个盒子。
 *
 * ★ 取"最深"而不是"第一个命中"：同一位置上父子盒可能重叠（大节点套小节点），
 *   用户指的是压在上面的那个（孩子）。
 */
function topmostBoxAt(
  boxes: ReadonlyMap<string, NodeBox>,
  skipId: string,
  point: Point,
): NodeBox | null {
  let best: NodeBox | null = null;
  for (const box of boxes.values()) {
    if (box.id === skipId) continue;
    if (!rectContainsPoint(box, point)) continue;
    if (!best || box.depth > best.depth) best = box;
  }
  return best;
}

/**
 * 插到第几个孩子：指针在某孩子的**垂直中线以上**就插在它前面。
 *
 * ★ 不这么做的话新位置永远是"最后那个"，用户想把一支插到中间只能再按 `Shift+Tab` 挪，
 *   而"插在哪"正是拖拽比键盘强的地方。
 */
function insertionIndexFor(input: MindDropInput, parentId: string): number {
  const children = input.childBoxesOf(parentId);
  const index = children.findIndex((box) => input.pointer.y < box.y + box.height / 2);
  return index < 0 ? children.length : index;
}
