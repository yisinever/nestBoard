/**
 * 内嵌脑图卡的尺寸算法（`F4` / `mind/embed/embedGeometry.ts`）。
 *
 * 这一层只在**新建**那一刻用一次，但它决定了用户看到的第一眼：
 * 太小（连根节点都挤）或太大（一上来压住整屏）都是当场可感的缺陷。
 * 特别是"只按前 3 层算"这一条 —— 它必须与卡面画的东西一致（`pruneMindForEmbed`）。
 */

import { describe, expect, it } from 'vitest';
import {
  EMBED_PADDING,
  INLINE_MIND_MAX_SIZE,
  INLINE_MIND_MIN_SIZE,
  mindCardSizeFor,
} from '../../mind/embed/embedGeometry';
import {
  mindBounds,
  mindNodeRects,
  mindPlacement,
  mindRootFallbackRect,
  MIND_ROOT_FALLBACK_SIZE,
} from '../../mind/embed/boardGeometry';
import { createMindFile } from '../../mind/model/factories';
import { addChild } from '../../mind/model/ops';
import type { MindFile } from '../../mind/model/schema';

/** 造一棵深度 `depth` 的串（每层一个孩子）：节点数 = depth + 1 */
function chainOf(depth: number): MindFile {
  const file = createMindFile({ title: '测试' });
  let parent = file.rootId;
  for (let level = 0; level < depth; level++) parent = addChild(file, parent) ?? parent;
  return file;
}

describe('mindCardSizeFor', () => {
  it('新卡（根 + 3 个空分支）落在上下限之间，且四周留出 `EMBED_PADDING`', () => {
    const file = createMindFile({ title: '测试', branches: 3 });
    const size = mindCardSizeFor(file);

    expect(size.width).toBeGreaterThanOrEqual(INLINE_MIND_MIN_SIZE.width);
    expect(size.width).toBeLessThanOrEqual(INLINE_MIND_MAX_SIZE.width);
    expect(size.height).toBeGreaterThanOrEqual(INLINE_MIND_MIN_SIZE.height);
    // 3 个分支的树：宽度至少是"根 + 一层 + 留白"
    expect(size.width).toBeGreaterThan(EMBED_PADDING * 2);
  });

  it('★ 只有一个中心主题时**不塌**（下限兜住）', () => {
    expect(mindCardSizeFor(createMindFile({ title: '只有一个' }))).toEqual(
      expect.objectContaining({ width: INLINE_MIND_MIN_SIZE.width }),
    );
  });

  it('★ 上百个节点也不会撑满画布（上限兜住）', () => {
    const file = createMindFile({ title: '大树' });
    for (let index = 0; index < 200; index++) addChild(file, file.rootId);

    const size = mindCardSizeFor(file);
    expect(size.width).toBeLessThanOrEqual(INLINE_MIND_MAX_SIZE.width);
    expect(size.height).toBeLessThanOrEqual(INLINE_MIND_MAX_SIZE.height);
  });

  it('★ 只按**前 3 层**算：更深的那一串不会把卡撑大（与卡面画的东西一致）', () => {
    const shallow = chainOf(3);
    const deep = chainOf(12);

    expect(mindCardSizeFor(deep)).toEqual(mindCardSizeFor(shallow));
  });

  it('宽高都是整数（卡片几何不该出现小数）', () => {
    const size = mindCardSizeFor(chainOf(2));
    expect(Number.isInteger(size.width)).toBe(true);
    expect(Number.isInteger(size.height)).toBe(true);
  });
});

/**
 * 演示取景用的那份几何（`2.2.0` 收尾 · 用户 2026-09-23）。
 *
 * 口径是两件事一起要："**以脑图根节点**"（容器的 `x/y` 就是它的中心 ⇒ 框只跟"模型 + 锚点"
 * 有关，量测 / 折叠都动不了它，所以**不飘**）与"**看到全脑图**"（框的是整棵树，不是根节点
 * 那一小块 —— 只框根节点是上一版，整棵树大半在视口外）。判据就落在这两条上。
 */
describe('演示取景的那份几何（mindBounds）', () => {
  it('★ 框的是**整棵树**：根与最外那一列都在里面，而框比"只有根"宽', () => {
    const file = chainOf(3);
    const place = mindPlacement({ x: 500, y: 300 }, file)!;
    const bounds = mindBounds(place)!;
    const nodes = mindNodeRects(place);
    const root = nodes.get(file.rootId)!;

    // 根节点在框里（它就是这个框的原点）
    expect(root.x).toBeGreaterThanOrEqual(bounds.x);
    expect(root.y).toBeGreaterThanOrEqual(bounds.y);
    // 最深那一列也在框里 —— "看到全脑图"，而不是只框住根节点那一小块
    const rightmost = [...nodes.values()].reduce((acc, rect) =>
      rect.x + rect.width > acc.x + acc.width ? rect : acc,
    );
    expect(rightmost.x + rightmost.width).toBeLessThanOrEqual(bounds.x + bounds.width + 0.001);
    expect(bounds.x + bounds.width).toBeGreaterThan(root.x + root.width + 1);
  });

  it('★ 只跟"模型 + 锚点"有关：算两次是同一个数；锚点一动，框整体跟着平移', () => {
    const file = chainOf(2);
    const first = mindBounds(mindPlacement({ x: 500, y: 300 }, file)!)!;
    const again = mindBounds(mindPlacement({ x: 500, y: 300 }, file)!)!;
    expect(again).toEqual(first);

    // 位置由**根节点**定：挪一下容器，整棵树跟着挪（这就是"以根节点"那一半）
    const moved = mindBounds(mindPlacement({ x: 620, y: 300 }, file)!)!;
    expect(moved.x - first.x).toBeCloseTo(120, 5);
    expect(moved.y).toBeCloseTo(first.y, 5);
  });

  it('模型没读到 ⇒ 按锚点兜一个小盒子（位置准，尺寸只是框）', () => {
    const rect = mindRootFallbackRect({ x: 120, y: 80 });
    expect(rect.width).toBe(MIND_ROOT_FALLBACK_SIZE.width);
    expect(rect.x + rect.width / 2).toBe(120);
    expect(rect.y + rect.height / 2).toBe(80);
  });
});
