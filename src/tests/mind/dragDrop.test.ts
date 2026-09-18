/**
 * 拖拽落点判定（`mind/view/dragDrop.ts`，P3-b）。
 *
 * 这是拖拽里**唯一会出错的部分**（挂错爹、挂成环、原地放下却把节点甩到别处），
 * 而它一笔一画都能量出来比较 —— 所以真正接指针之前，先把这几条钉死。
 */

import { describe, expect, it } from 'vitest';
import { resolveDrop, type MindDropInput } from '../../mind/view/dragDrop';
import type { NodeBox } from '../../mind/layout/tree';
import { boxOf } from '../helpers/mindFixtures';

/**
 * 场上摆着：父 `p`（100,100 起，**高 200** 好让指针落在它的纵向范围里），
 * 两个孩子 `c1`（中线 140）、`c2`（中线 220）挂在右边，被拖的 `d` 在（500,500）。
 *
 * ★ 孩子挂在父的**侧面**（x = 300）而不是叠在它身上：脑图的布局本来就是左右展开的，
 *   只有"指针落在父的盒子里"这种情况才谈得上"插到第几个"。
 */
function scene(overrides: Partial<MindDropInput> = {}): MindDropInput {
  const boxes = new Map<string, NodeBox>([
    ['p', boxOf('p', 100, 100, { depth: 0, height: 200 })],
    ['c1', boxOf('c1', 300, 120, { depth: 1 })],
    ['c2', boxOf('c2', 300, 200, { depth: 1 })],
    ['d', boxOf('d', 500, 500, { depth: 1 })],
  ]);
  const children: Record<string, string[]> = { p: ['c1', 'c2'], c1: [], c2: [], d: [] };
  return {
    boxes,
    childBoxesOf: (parentId) =>
      (children[parentId] ?? [])
        .map((id) => boxes.get(id))
        .filter((box): box is NodeBox => box !== undefined),
    draggedId: 'd',
    // 出发时那个盒子的位置（拖动期间不动）—— 指针落在这里 = "拖起来又放下"
    ownBox: { x: 500, y: 500, width: 100, height: 40 },
    forbidden: new Set(['d']),
    pointer: { x: 0, y: 0 },
    ...overrides,
  };
}

describe('resolveDrop', () => {
  it('★ 落在某个节点上 → 成为它的子节点', () => {
    const target = resolveDrop(scene({ pointer: { x: 150, y: 120 } }));

    expect(target.kind).toBe('child');
    if (target.kind !== 'child') return;
    expect(target.parentId).toBe('p');
  });

  it('★ 插入位置按指针高度算（不是永远追加到最后）', () => {
    // `c1` 中线 140、`c2` 中线 220
    const top = resolveDrop(scene({ pointer: { x: 150, y: 130 } })); // 在 c1 之上 ⇒ 插到最前
    const middle = resolveDrop(scene({ pointer: { x: 150, y: 180 } })); // 两者之间 ⇒ 插到 c2 前
    const bottom = resolveDrop(scene({ pointer: { x: 150, y: 250 } })); // 都在下面 ⇒ 追加

    expect(top.kind === 'child' ? top.index : -1).toBe(0);
    expect(middle.kind === 'child' ? middle.index : -1).toBe(1);
    expect(bottom.kind === 'child' ? bottom.index : -1).toBe(2);
  });

  it('★ 命中"压在上面"的那一个（同一位置有多层盒子时取 `depth` 更深的）', () => {
    const boxes = new Map<string, NodeBox>([
      ['p', boxOf('p', 100, 100, { depth: 0, width: 200, height: 200 })],
      ['kid', boxOf('kid', 120, 120, { depth: 3 })],
    ]);
    const target = resolveDrop(scene({ boxes, pointer: { x: 150, y: 130 } }));

    expect(target.kind === 'child' ? target.parentId : '').toBe('kid');
  });

  it('★ 落在**自己的后代**上 → 拒绝（成环），且**认得出来是谁**（好画红环）', () => {
    const target = resolveDrop(
      scene({ pointer: { x: 320, y: 130 }, forbidden: new Set(['d', 'c1']) }),
    );

    expect(target).toEqual({ kind: 'blocked', nodeId: 'c1' });
  });

  it('★ 指针还在**出发时那个盒子**里 → 原地放下，什么都不做', () => {
    // ★ 这里判的是**出发盒**而不是"预览盒"：预览盒跟着指针走、指针永远在它里面，
    //   拿它来判会把每一次拖拽都判成"原地放下"（这个 bug 真出过一次）
    const target = resolveDrop(scene({ pointer: { x: 520, y: 510 } }));

    expect(target).toEqual({ kind: 'none' });
  });

  it('★ 落在空白 → 变成悬浮节点，落点就是指针位置', () => {
    const target = resolveDrop(scene({ pointer: { x: -200, y: 640 } }));

    expect(target).toEqual({ kind: 'free', point: { x: -200, y: 640 } });
  });

  it('自己被排除在命中之外（指针划过自己的原位置不算"挂到自己"）', () => {
    // 指针已经离开出发盒（`ownBox`），但位置上还留着 `d` 自己的盒子
    const target = resolveDrop(scene({ pointer: { x: 620, y: 560 } }));

    // 命中的是 `d` 自己的盒子 ⇒ 被 `draggedId` 跳过 ⇒ 落成空白
    expect(target.kind).toBe('free');
  });

  it('盒子表里只有被拖的那个节点时，任何位置都是"空白"', () => {
    const boxes = new Map<string, NodeBox>([['d', boxOf('d', 0, 0)]]);
    const target = resolveDrop(scene({ boxes, pointer: { x: 50, y: 50 } }));

    expect(target).toEqual({ kind: 'free', point: { x: 50, y: 50 } });
  });
});
