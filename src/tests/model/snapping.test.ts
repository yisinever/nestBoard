/**
 * 网格吸附纯逻辑（T3.11 / F5-02）。
 *
 * 这里钉住三件"错一点用户就会觉得别扭"的事：
 *  1. `snapCoordinate` 必须**就近**取整（半格向上），而不是向下/向上取整 ——
 *     后者会让卡片永远偏向某一边，越过网格线时手感是"贴不住"；
 *  2. 坏步长（0 / 负数 / NaN）必须原样放过坐标，不能算出 `Infinity` / `NaN`；
 *  3. Ctrl 是**反转**而不是"关闭"：关着吸附时按 Ctrl 反而要吸上。
 */

import { describe, expect, it } from 'vitest';
import {
  gridSnapActive,
  MIN_GRID_SIZE,
  normalizeGridSize,
  snapCoordinate,
  snapMove,
  snappedDelta,
} from '../../model/snapping';

describe('normalizeGridSize', () => {
  it('合法步长原样返回', () => {
    expect(normalizeGridSize(16)).toBe(16);
    expect(normalizeGridSize(8)).toBe(8);
    expect(normalizeGridSize(1)).toBe(1);
  });

  it('0 / 负数 / 非有限值一律回落到 fallback', () => {
    expect(normalizeGridSize(0)).toBe(16);
    expect(normalizeGridSize(-8)).toBe(16);
    expect(normalizeGridSize(Number.NaN)).toBe(16);
    expect(normalizeGridSize(Number.POSITIVE_INFINITY)).toBe(16);
    expect(normalizeGridSize(0, 4)).toBe(4);
  });

  it('下限是 1：亚像素网格会被四舍五入放大成抖动，直接当坏值', () => {
    expect(MIN_GRID_SIZE).toBe(1);
    expect(normalizeGridSize(0.5, 16)).toBe(16);
  });
});

describe('snapCoordinate', () => {
  it('就近吸附到网格线，恰好半格向上', () => {
    expect(snapCoordinate(0, 16)).toBe(0);
    expect(snapCoordinate(7, 16)).toBe(0);
    expect(snapCoordinate(8, 16)).toBe(16);
    expect(snapCoordinate(24, 16)).toBe(32);
    // -5 的最近网格线是 0（距 0 为 5，距 -16 为 11）；`Math.round` 给出 -0，
    // 语义上就是 0，用 `toBeCloseTo` 避开 `Object.is(-0, 0) === false` 的干扰
    expect(snapCoordinate(-5, 16)).toBeCloseTo(0);
  });

  it('已经是网格点则原地不动', () => {
    expect(snapCoordinate(32, 16)).toBe(32);
    expect(snapCoordinate(-16, 16)).toBe(-16);
  });

  it('坏步长 / 坏坐标原样返回，绝不产出 Infinity / NaN', () => {
    expect(snapCoordinate(10, 0)).toBe(10);
    expect(snapCoordinate(10, -4)).toBe(10);
    expect(snapCoordinate(10, Number.NaN)).toBe(10);
    expect(Number.isNaN(snapCoordinate(Number.NaN, 16))).toBe(true);
  });
});

describe('gridSnapActive', () => {
  it('没按 Ctrl 时听设置', () => {
    expect(gridSnapActive({ enabled: true, size: 16 })).toBe(true);
    expect(gridSnapActive({ enabled: false, size: 16 })).toBe(false);
  });

  it('★ Ctrl 是反转：开变关、关变开', () => {
    expect(gridSnapActive({ enabled: true, size: 16 }, true)).toBe(false);
    expect(gridSnapActive({ enabled: false, size: 16 }, true)).toBe(true);
  });
});

describe('snappedDelta', () => {
  const box = { x: 5, y: 5, width: 100, height: 50 };

  it('把"起始包围盒 + 位移"吸到网格，再倒推出修正后的位移量', () => {
    // 5 + 5 = 10 → 吸到 16 → 位移量 16 - 5 = 11
    expect(snappedDelta(box, { x: 5, y: 5 }, 16)).toEqual({ x: 11, y: 11 });
    // 5 + 20 = 25 → 吸到 32 → 位移量 27
    expect(snappedDelta(box, { x: 20, y: 20 }, 16)).toEqual({ x: 27, y: 27 });
  });

  it('吸到原位时位移量回到 0（起点附近来回拖不会漂移）', () => {
    expect(snappedDelta(box, { x: 2, y: 2 }, 16)).toEqual({ x: -5, y: -5 });
  });

  it('起点已经对齐时，位移量就是网格步长的整数倍', () => {
    expect(snappedDelta({ x: 0, y: 0, width: 10, height: 10 }, { x: 20, y: 20 }, 16)).toEqual({
      x: 16,
      y: 16,
    });
  });

  it('没有包围盒 / 坏步长时原样返回位移量', () => {
    expect(snappedDelta(null, { x: 7, y: 9 }, 16)).toEqual({ x: 7, y: 9 });
    expect(snappedDelta(box, { x: 7, y: 9 }, 0)).toEqual({ x: 7, y: 9 });
  });
});

describe('snapMove · 智能参考线', () => {
  /**
   * 参照卡 (100, 200) 50×50：x 锚点 100/125/150，y 锚点 200/225/250。
   *
   * ★ 被拖的卡片故意做**宽 200**：锚点之间拉开 100，任何一次判定里
   *   都只有一对锚点够得着，测试才有唯一答案（10px 宽的小卡三个锚点会互相抢，
   *   那属于"就近取最近"的正常行为，但不适合用来钉具体数值）。
   * 高度只给 20，且 y 从 0 起：三个 y 锚点（0/10/20）离参照卡的 200 开外，
   * 这样纵轴永远不参与对齐，断言能看清到底是谁在生效。
   */
  const target = { x: 100, y: 200, width: 50, height: 50 };
  const align = { others: [target], threshold: 6 };
  const wide = { x: 0, y: 0, width: 200, height: 20 };

  it('没有包围盒时原样返回（连网格也不碰）', () => {
    expect(snapMove({ origin: null, delta: { x: 7, y: 9 }, grid: null, align })).toEqual({
      delta: { x: 7, y: 9 },
      guides: { verticals: [], horizontals: [] },
    });
  });

  it('没有邻近卡片时退回网格', () => {
    expect(
      snapMove({
        origin: wide,
        delta: { x: 20, y: 20 },
        grid: { enabled: true, size: 16 },
        align: { others: [], threshold: 6 },
      }).delta,
    ).toEqual({ x: 16, y: 16 });
  });

  it('左边缘进入阈值 → 位移量**叠加**修正量（而不是被修正量取代）', () => {
    const result = snapMove({ origin: wide, delta: { x: 97, y: 0 }, grid: null, align });
    // 97 + 3 = 100：若误把修正量当总位移，卡片会从 0 直接瞬移到 3
    expect(result.delta).toEqual({ x: 100, y: 0 });
    expect(result.guides).toEqual({ verticals: [100], horizontals: [] });
  });

  it('中心对齐也算数（123 够得着参照卡中心 125）', () => {
    const result = snapMove({ origin: wide, delta: { x: 23, y: 0 }, grid: null, align });
    // 中心锚点 123 → 125（修正 +2）⇒ 位移量 25，卡片的中心正好落在 125
    expect(result.delta).toEqual({ x: 25, y: 0 });
    expect(result.guides.verticals).toEqual([125]);
  });

  it('刚好对齐（修正量为 0）时仍然报出参考线 —— 用户需要看到"齐了"', () => {
    const result = snapMove({
      origin: { x: 100, y: 0, width: 200, height: 20 },
      delta: { x: 0, y: 0 },
      grid: null,
      align,
    });
    expect(result.delta).toEqual({ x: 0, y: 0 });
    expect(result.guides.verticals).toEqual([100]);
  });

  it('阈值之外不对齐：几何自由、参考线为空', () => {
    const result = snapMove({ origin: wide, delta: { x: 80, y: 0 }, grid: null, align });
    expect(result.delta).toEqual({ x: 80, y: 0 });
    expect(result.guides).toEqual({ verticals: [], horizontals: [] });
  });

  it('★ 分轴决策：一个轴对齐、另一个轴仍走网格', () => {
    const result = snapMove({
      origin: wide,
      delta: { x: 103, y: 5 },
      grid: { enabled: true, size: 16 },
      align,
    });
    // x 对齐到 100（网格本来会给 96）；y 离参照卡太远，交回网格吸到 0
    expect(result.delta).toEqual({ x: 100, y: 0 });
    expect(result.guides).toEqual({ verticals: [100], horizontals: [] });
  });

  it('多选时以**包围盒**锚点对齐（组内相对位置不变）', () => {
    const result = snapMove({
      origin: { x: 0, y: 0, width: 220, height: 60 },
      delta: { x: 97, y: 0 },
      grid: null,
      align,
    });
    expect(result.delta).toEqual({ x: 100, y: 0 });
    expect(result.guides.verticals).toEqual([100]);
  });

  it('阈值 <= 0 时视为关闭', () => {
    const result = snapMove({
      origin: wide,
      delta: { x: 97, y: 0 },
      grid: null,
      align: { others: [target], threshold: 0 },
    });
    expect(result.delta).toEqual({ x: 97, y: 0 });
    expect(result.guides).toEqual({ verticals: [], horizontals: [] });
  });

  it('align 为 null 时只走网格', () => {
    const result = snapMove({
      origin: wide,
      delta: { x: 20, y: 20 },
      grid: { enabled: true, size: 16 },
      align: null,
    });
    expect(result.delta).toEqual({ x: 16, y: 16 });
    expect(result.guides).toEqual({ verticals: [], horizontals: [] });
  });
});
