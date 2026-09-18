/**
 * 演示相机数学单元测试（J-06）。
 *
 * 这条链最怕两件事：**算出一个 NaN 写进视口**（画布再也拉不回来）、
 * **倍率不封顶**（讲一张便签时字大到只剩两三个）。两类都在这里钉死。
 */

import { describe, expect, it } from 'vitest';
import {
  PRESENT_MAX_ZOOM,
  easeInOutCubic,
  interpolateViewport,
  presentTargetViewport,
  viewportSettled,
} from '../../view/presentCamera';
import { MAX_ZOOM, MIN_ZOOM } from '../../canvas/Viewport';
import type { Rect, Size } from '../../util/geometry';

const VIEW: Size = { width: 1200, height: 800 };

describe('presentTargetViewport', () => {
  it('把目标卡居中：卡片中心落在视口正中', () => {
    const rect: Rect = { x: 1000, y: 500, width: 400, height: 300 };
    const state = presentTargetViewport(rect, VIEW);
    expect(state).not.toBeNull();
    const screenX = (rect.x + rect.width / 2) * state!.zoom + state!.x;
    const screenY = (rect.y + rect.height / 2) * state!.zoom + state!.y;
    expect(screenX).toBeCloseTo(VIEW.width / 2, 0);
    expect(screenY).toBeCloseTo(VIEW.height / 2, 0);
  });

  it('四周留白 ≥ padding（卡片不会顶到视口边）', () => {
    const rect: Rect = { x: 0, y: 0, width: 600, height: 400 };
    const state = presentTargetViewport(rect, VIEW, { padding: 100 })!;
    const left = rect.x * state.zoom + state.x;
    const top = rect.y * state.zoom + state.y;
    expect(left).toBeGreaterThanOrEqual(100 - 0.5);
    expect(top).toBeGreaterThanOrEqual(100 - 0.5);
  });

  it('小卡片放大但有上限：便签不会占满整屏', () => {
    const state = presentTargetViewport({ x: 0, y: 0, width: 240, height: 160 }, VIEW)!;
    expect(state.zoom).toBe(PRESENT_MAX_ZOOM);
    expect(state.zoom).toBeLessThan(MAX_ZOOM);
  });

  it('大卡片按视口缩放，不为负也不越出画布上下限', () => {
    const state = presentTargetViewport({ x: 0, y: 0, width: 40000, height: 30000 }, VIEW)!;
    expect(state.zoom).toBeGreaterThanOrEqual(MIN_ZOOM);
    expect(Number.isFinite(state.x)).toBe(true);
  });

  it('视口还没量到尺寸 → null（交给调用方跳过，绝不硬算）', () => {
    expect(
      presentTargetViewport({ x: 0, y: 0, width: 100, height: 100 }, { width: 0, height: 0 }),
    ).toBeNull();
  });

  it('矩形尺寸非法 → null，而不是把 NaN 写进视口', () => {
    const bad = { x: 0, y: 0, width: Number.NaN, height: 100 };
    expect(presentTargetViewport(bad, VIEW)).toBeNull();
  });

  it('宽高为 0 的退化卡片按 1 处理，不产生 Infinity', () => {
    const state = presentTargetViewport({ x: 0, y: 0, width: 0, height: 0 }, VIEW)!;
    expect(Number.isFinite(state.zoom)).toBe(true);
    expect(state.zoom).toBe(PRESENT_MAX_ZOOM);
  });
});

describe('easeInOutCubic', () => {
  it('两端固定 0 / 1，中点为 0.5', () => {
    expect(easeInOutCubic(0)).toBe(0);
    expect(easeInOutCubic(1)).toBe(1);
    expect(easeInOutCubic(0.5)).toBeCloseTo(0.5, 6);
  });

  it('越界输入被夹住（动画末帧可能略大于 1）', () => {
    expect(easeInOutCubic(-1)).toBe(0);
    expect(easeInOutCubic(2)).toBe(1);
  });

  it('全程单调递增', () => {
    let previous = -1;
    for (let i = 0; i <= 10; i += 1) {
      const value = easeInOutCubic(i / 10);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
  });
});

describe('interpolateViewport', () => {
  const from = { x: 0, y: 0, zoom: 1 };
  const to = { x: 100, y: -200, zoom: 4 };

  it('端点取值就是起止视口', () => {
    expect(interpolateViewport(from, to, 0)).toEqual({ x: 0, y: 0, zoom: 1 });
    expect(interpolateViewport(from, to, 1)).toEqual({ x: 100, y: -200, zoom: 4 });
  });

  it('平移线性、缩放等比：1→4 的中点是 2 倍', () => {
    const mid = interpolateViewport(from, to, 0.5);
    expect(mid.x).toBeCloseTo(50, 6);
    expect(mid.y).toBeCloseTo(-100, 6);
    expect(mid.zoom).toBeCloseTo(2, 6);
  });

  it('倍率非法时退回线性，绝不产生 NaN / 负数', () => {
    const result = interpolateViewport({ x: 0, y: 0, zoom: 0 }, to, 0.5);
    expect(Number.isFinite(result.zoom)).toBe(true);
    expect(result.zoom).toBeGreaterThan(0);
  });
});

describe('viewportSettled', () => {
  it('接近到阈值内即视为收敛，差得远则没有', () => {
    expect(viewportSettled({ x: 0, y: 0, zoom: 1 }, { x: 0.1, y: 0.1, zoom: 1.0001 })).toBe(true);
    expect(viewportSettled({ x: 0, y: 0, zoom: 1 }, { x: 10, y: 0, zoom: 1 })).toBe(false);
  });
});
