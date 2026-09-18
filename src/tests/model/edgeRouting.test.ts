/**
 * Smart 连线路由（T7.11 / `F3-03`）：正交走线 + 绕开卡片。
 *
 * 这里钉的是**可被看见的承诺**，而不是某一次搜索的具体折点（网格上有大量代价
 * 相同的走法，"对称时选哪一条"不是用户能感知的差别）：
 *
 *  1. 线**垂直离开**起点边、**垂直进入**终点边（否则锚点前会多一个 90° 小钩）；
 *  2. 全程横平竖直；
 *  3. **不穿过障碍的内部**（外扩后贴着边界走是允许的）；
 *  4. 搜不到就返回 `null` —— 调用方据此退回直线，而不是"这条线不见了"。
 *
 * 纯函数，跑在 node 下（不 import obsidian、不碰 DOM）。
 */

import { describe, expect, it } from 'vitest';
import { routeOrthogonal, simplify } from '../../model/edgeRouting';
import type { Point, Rect } from '../../util/geometry';

/** 线段是否穿过矩形的**内部**（与实现里的判定同构：严格不等号，贴着边界不算穿过） */
function crossesInterior(a: Point, b: Point, rect: Rect): boolean {
  const minX = Math.min(a.x, b.x);
  const maxX = Math.max(a.x, b.x);
  const minY = Math.min(a.y, b.y);
  const maxY = Math.max(a.y, b.y);
  return (
    maxX > rect.x && minX < rect.x + rect.width && maxY > rect.y && minY < rect.y + rect.height
  );
}

function anyLegCrosses(points: readonly Point[], rect: Rect): boolean {
  for (let index = 1; index < points.length; index++) {
    if (crossesInterior(points[index - 1], points[index], rect)) return true;
  }
  return false;
}

function isAxisAligned(points: readonly Point[]): boolean {
  for (let index = 1; index < points.length; index++) {
    const a = points[index - 1];
    const b = points[index];
    if (a.x !== b.x && a.y !== b.y) return false;
  }
  return true;
}

function pathLength(points: readonly Point[]): number {
  let total = 0;
  for (let index = 1; index < points.length; index++) {
    total += Math.hypot(
      points[index].x - points[index - 1].x,
      points[index].y - points[index - 1].y,
    );
  }
  return total;
}

describe('routeOrthogonal —— 无遮挡', () => {
  it('两端重合 → null（没有"垂直方向"可言）', () => {
    expect(routeOrthogonal({ x: 5, y: 5 }, 'right', { x: 5, y: 5 }, 'left', [])).toBeNull();
  });

  it('垂直离开起点、垂直进入终点，中间横平竖直', () => {
    const from = { x: 100, y: 100 };
    const to = { x: 300, y: 300 };
    const points = routeOrthogonal(from, 'right', to, 'top', []);
    expect(points).not.toBeNull();
    const path = points!;

    expect(path[0]).toEqual(from);
    expect(path[path.length - 1]).toEqual(to);
    expect(isAxisAligned(path)).toBe(true);
    // 起点往右走（第一条腿与起点同 y）；终点从上方下来（最后一条腿与终点同 x）
    expect(path[1].y).toBe(from.y);
    expect(path[path.length - 2].x).toBe(to.x);
  });

  it('走最短的正交两段（先横后纵），不绕远', () => {
    const path = routeOrthogonal({ x: 100, y: 100 }, 'right', { x: 300, y: 300 }, 'top', []);
    expect(path).toEqual([
      { x: 100, y: 100 },
      { x: 300, y: 100 },
      { x: 300, y: 300 },
    ]);
  });

  it('同一输入两次结果完全一致（顺序稳定，导出可比）', () => {
    const from = { x: 0, y: 0 };
    const to = { x: 250, y: 170 };
    const first = routeOrthogonal(from, 'right', to, 'left', []);
    const second = routeOrthogonal(from, 'right', to, 'left', []);
    expect(first).toEqual(second);
  });
});

describe('routeOrthogonal —— 绕开卡片', () => {
  const from = { x: 0, y: 100 };
  const to = { x: 400, y: 100 };
  const blocker: Rect = { x: 180, y: 60, width: 40, height: 80 };

  it('正中间挡一张卡 → 绕过去，不穿过它', () => {
    const points = routeOrthogonal(from, 'right', to, 'left', [blocker]);
    expect(points).not.toBeNull();
    const path = points!;

    expect(path[0]).toEqual(from);
    expect(path[path.length - 1]).toEqual(to);
    expect(isAxisAligned(path)).toBe(true);
    expect(anyLegCrosses(path, blocker)).toBe(false);
    // 绕行必然比直线（400）长
    expect(pathLength(path)).toBeGreaterThan(400);
  });

  it('绕的是"上行或下行"—— 走线确实出到了障碍上下两侧', () => {
    const points = routeOrthogonal(from, 'right', to, 'left', [blocker])!;
    const ys = points.map((point) => point.y);
    expect(Math.min(...ys) <= blocker.y || Math.max(...ys) >= blocker.y + blocker.height).toBe(
      true,
    );
  });

  it('远在搜索窗口之外的障碍不影响走线（与没有障碍逐点相同）', () => {
    const far: Rect = { x: 4000, y: 4000, width: 200, height: 200 };
    const bare = routeOrthogonal(from, 'right', to, 'left', []);
    const withFar = routeOrthogonal(from, 'right', to, 'left', [far]);
    expect(withFar).toEqual(bare);
    // 无障碍时就是一条直线，被简化成两个点
    expect(bare).toEqual([from, to]);
  });

  it('★ 两端自己的卡片混在障碍表里也不影响：包住锚点的卡被剔除', () => {
    // 这是**真实调用的输入形状**：`BoardView.edgeHitOptions()` 把场上所有卡片都塞进来，
    // 包括这条线两端自己的卡。锚点长在自家卡片的边上，外扩 10px 后锚点就落在卡里 ——
    // 不剔除的话第一步就走不出去，Smart 会永远退回直线（看起来像"功能没做"）。
    const startCard: Rect = { x: -100, y: 50, width: 100, height: 100 };
    const endCard: Rect = { x: 400, y: 50, width: 100, height: 100 };
    const path = routeOrthogonal(from, 'right', to, 'left', [startCard, blocker, endCard]);

    expect(path).not.toBeNull();
    expect(path!.length).toBeGreaterThan(2);
    expect(anyLegCrosses(path!, blocker)).toBe(false);
    expect(isAxisAligned(path!)).toBe(true);
  });

  it('目标被别的卡片围住时仍然能绕出去（不轻易放弃）', () => {
    const ring: Rect[] = [
      { x: 360, y: 20, width: 20, height: 60 },
      { x: 360, y: 120, width: 20, height: 60 },
      { x: 420, y: 20, width: 20, height: 60 },
    ];
    const path = routeOrthogonal(from, 'right', to, 'left', ring)!;
    expect(path).not.toBeNull();
    for (const rect of ring) expect(anyLegCrosses(path, rect)).toBe(false);
  });

  it('多个障碍也仍然不穿过任何一个', () => {
    const two: Rect[] = [
      { x: 100, y: 80, width: 60, height: 40 },
      { x: 240, y: 80, width: 60, height: 40 },
    ];
    const path = routeOrthogonal(from, 'right', to, 'left', two)!;
    expect(path).not.toBeNull();
    expect(anyLegCrosses(path, two[0])).toBe(false);
    expect(anyLegCrosses(path, two[1])).toBe(false);
  });
});

describe('simplify —— 去掉重复点与多余的共线拐点', () => {
  it('空数组 / 单点原样返回', () => {
    expect(simplify([])).toEqual([]);
    expect(simplify([{ x: 1, y: 2 }])).toEqual([{ x: 1, y: 2 }]);
  });

  it('相邻重复点只留一个', () => {
    expect(
      simplify([
        { x: 0, y: 0 },
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ]),
    ).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ]);
  });

  it('中间那个"直着穿过去"的点被合并掉', () => {
    expect(
      simplify([
        { x: 0, y: 0 },
        { x: 5, y: 0 },
        { x: 10, y: 0 },
      ]),
    ).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ]);
    expect(
      simplify([
        { x: 0, y: 0 },
        { x: 0, y: 5 },
        { x: 0, y: 10 },
      ]),
    ).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 10 },
    ]);
  });

  it('真正的拐点一个都不删', () => {
    const corners = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 20, y: 10 },
    ];
    expect(simplify(corners)).toEqual(corners);
  });
});
