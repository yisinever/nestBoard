/**
 * `DirtyRegion` 单元测试（T1.27，连线层与手绘层共用的脏区账本）。
 *
 * 脏区账本错了会以最难查的方式表现："拖完卡片留下一道残影"或"该重画的地方没重画"。
 * 这里把三条规则钉死：合并成包围盒、非法值一律降级为整层、`peek` 不消费。
 *
 * 只测纯逻辑 —— Canvas / DPR 部分只能在 Obsidian 里肉眼验证。
 */

import { describe, expect, it } from 'vitest';
import { DirtyRegion } from '../../view/render/DirtyRegion';

describe('DirtyRegion', () => {
  it('初始为空', () => {
    const region = new DirtyRegion();
    expect(region.isEmpty).toBe(true);
    expect(region.peek()).toEqual({ all: false, bounds: null });
  });

  it('add 一个矩形后不再是空的', () => {
    const region = new DirtyRegion();
    region.add({ x: 10, y: 20, width: 30, height: 40 });
    expect(region.isEmpty).toBe(false);
    expect(region.peek()).toEqual({
      all: false,
      bounds: { x: 10, y: 20, width: 30, height: 40 },
    });
  });

  it('多个矩形合并成一个包围盒', () => {
    const region = new DirtyRegion();
    region.add({ x: 0, y: 0, width: 10, height: 10 });
    region.add({ x: 100, y: 50, width: 10, height: 10 });
    // 包围盒覆盖两者；多清一小块只是多画几条重叠连线，代价可接受
    expect(region.peek().bounds).toEqual({ x: 0, y: 0, width: 110, height: 60 });
  });

  it('被包含的矩形不会扩大包围盒', () => {
    const region = new DirtyRegion();
    region.add({ x: 0, y: 0, width: 100, height: 100 });
    region.add({ x: 10, y: 10, width: 5, height: 5 });
    expect(region.peek().bounds).toEqual({ x: 0, y: 0, width: 100, height: 100 });
  });

  it('省略 / null 矩形 → 整层重绘', () => {
    const region = new DirtyRegion();
    region.add();
    expect(region.peek()).toEqual({ all: true, bounds: null });
  });

  it('非法数字 → 降级为整层重绘（保守但绝不留残影）', () => {
    const region = new DirtyRegion();
    region.add({ x: Number.NaN, y: 0, width: 10, height: 10 });
    expect(region.peek().all).toBe(true);
    expect(region.isEmpty).toBe(false);
  });

  it('addAll → 整层重绘', () => {
    const region = new DirtyRegion();
    region.add({ x: 1, y: 1, width: 1, height: 1 });
    region.addAll();
    expect(region.peek()).toEqual({ all: true, bounds: null });
  });

  it('peek 不消费，只有 clear 才复位', () => {
    const region = new DirtyRegion();
    region.add({ x: 1, y: 2, width: 3, height: 4 });
    expect(region.peek()).toEqual(region.peek());
    expect(region.isEmpty).toBe(false);

    region.clear();
    expect(region.isEmpty).toBe(true);
    expect(region.peek()).toEqual({ all: false, bounds: null });
  });

  it('clear 之后再 add 从零开始累积', () => {
    const region = new DirtyRegion();
    region.addAll();
    region.clear();
    region.add({ x: 5, y: 5, width: 5, height: 5 });
    expect(region.peek()).toEqual({ all: false, bounds: { x: 5, y: 5, width: 5, height: 5 } });
  });
});
