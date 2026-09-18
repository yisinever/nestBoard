/**
 * 框选命中（`mind/view/marquee.ts`，`06 §4.2`）。
 *
 * 判据与白板的框选**同一条**（`rectsIntersect`）：部分压线也算选中 ——
 * "看得见却框不中"是最气人的一种不一致。这里把它钉死。
 */

import { describe, expect, it } from 'vitest';
import { boxesWithin } from '../../mind/view/marquee';
import { boxOf } from '../helpers/mindFixtures';
import type { NodeBox } from '../../mind/layout/tree';

const scene = () =>
  new Map<string, NodeBox>([
    ['a', boxOf('a', 0, 0, { width: 100, height: 40 })], // 0..100 × 0..40
    ['b', boxOf('b', 300, 200, { width: 100, height: 40 })],
    ['c', boxOf('c', 60, 60, { width: 100, height: 40 })],
  ]);

describe('boxesWithin', () => {
  it('矩形里的节点都选中', () => {
    expect(boxesWithin(scene(), { x: -10, y: -10, width: 400, height: 300 }).sort()).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('★ 部分压线也算（与裁剪同一判据，不会"看得见却框不中"）', () => {
    // 只压住 `a` 的右下角
    expect(boxesWithin(scene(), { x: 90, y: 30, width: 10, height: 20 })).toEqual(['a']);
  });

  it('框在缝隙里 → 一个都不选', () => {
    expect(boxesWithin(scene(), { x: 200, y: 100, width: 40, height: 40 })).toEqual([]);
  });

  it('★ 零矩形（点一下没拖动）不选中任何东西', () => {
    // 否则"点空白清空选区"会变成"框住手指下那一堆"
    expect(boxesWithin(scene(), { x: 50, y: 20, width: 0, height: 0 })).toEqual([]);
  });

  it('空场景 → 空结果（视图还没布局时不该炸）', () => {
    expect(boxesWithin(new Map(), { x: 0, y: 0, width: 100, height: 100 })).toEqual([]);
  });

  it('只看**给了盒子的**节点：折叠藏起来的节点不在其中，于是框不到', () => {
    // 藏起来的节点布局压根没排它们 —— 这一条是"刻意的"，不是巧合
    const boxes = new Map<string, NodeBox>([['a', boxOf('a', 0, 0)]]);
    expect(boxesWithin(boxes, { x: -1000, y: -1000, width: 5000, height: 5000 })).toEqual(['a']);
  });
});
