/**
 * Viewport 单元测试（T1.18）。
 *
 * 这里钉的是三件最容易出错、出错了又很难肉眼发现的事：
 *   1. 世界↔屏幕互逆（写反一个符号，整块画布就会"往反方向漂"）；
 *   2. **以指针为锚点缩放**的不变量（F1-03 的验收点）；
 *   3. 视口状态写回文件的取整与脏数据宽容（T1.22）。
 */

import { describe, expect, it, vi } from 'vitest';
import { CULL_PADDING, MAX_ZOOM, MIN_ZOOM, ZOOM_STEP, Viewport } from '../../canvas/Viewport';

function makeViewport(width = 1000, height = 600): Viewport {
  const viewport = new Viewport();
  viewport.setSize(width, height);
  return viewport;
}

describe('坐标变换', () => {
  it('默认视口是 100% 且偏移为 0：屏幕坐标 == 世界坐标', () => {
    const viewport = makeViewport();
    expect(viewport.zoom).toBe(1);
    expect(viewport.toScreen({ x: 10, y: 20 })).toEqual({ x: 10, y: 20 });
    expect(viewport.toWorld({ x: 10, y: 20 })).toEqual({ x: 10, y: 20 });
  });

  it('world ↔ screen 互为逆变换', () => {
    const viewport = makeViewport();
    viewport.panBy(120, -40);
    viewport.zoomTo(2.5, { x: 0, y: 0 });

    const world = { x: 37.5, y: -12.25 };
    const back = viewport.toWorld(viewport.toScreen(world));
    expect(back.x).toBeCloseTo(world.x, 10);
    expect(back.y).toBeCloseTo(world.y, 10);
  });

  it('transform() 带上当前的平移与缩放', () => {
    const viewport = makeViewport();
    // 用 applyState 直接落值：zoomTo 会按锚点重算偏移，不适合断言精确字符串
    viewport.applyState({ x: 30, y: -10, zoom: 2 });
    expect(viewport.transform()).toBe('translate3d(30px, -10px, 0) scale(2)');
  });
});

describe('缩放锚定指针（F1-03 核心不变量）', () => {
  it('锚点下方的世界坐标在缩放前后保持不动', () => {
    const viewport = makeViewport();
    viewport.panBy(80, -30);
    viewport.zoomTo(1.7, { x: 0, y: 0 });

    const anchor = { x: 420, y: 260 };
    const before = viewport.toWorld(anchor);

    viewport.zoomBy(1.6, anchor);

    const after = viewport.toWorld(anchor);
    expect(viewport.zoom).toBeCloseTo(1.7 * 1.6, 10);
    expect(after.x).toBeCloseTo(before.x, 8);
    expect(after.y).toBeCloseTo(before.y, 8);
  });

  it('连续多档缩放不累积漂移', () => {
    const viewport = makeViewport();
    const anchor = { x: 137, y: 542 };
    const before = viewport.toWorld(anchor);

    // 10 档 = 6.19×，仍在 [MIN, MAX] 内；再多就会被钳制，测不出漂移
    for (let index = 0; index < 10; index++) viewport.zoomBy(1.2, anchor);
    for (let index = 0; index < 10; index++) viewport.zoomBy(1 / 1.2, anchor);

    expect(viewport.zoom).toBeCloseTo(1, 8);
    const after = viewport.toWorld(anchor);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  });

  it('锚点缺省为视口中心（命令式缩放没有指针位置）', () => {
    const viewport = makeViewport(1000, 600);
    viewport.panBy(50, 50);
    const center = { x: 500, y: 300 };
    const before = viewport.toWorld(center);

    viewport.zoomStep(1);

    expect(viewport.zoom).toBeCloseTo(ZOOM_STEP, 10);
    expect(viewport.toWorld(center).x).toBeCloseTo(before.x, 8);
    expect(viewport.toWorld(center).y).toBeCloseTo(before.y, 8);
  });
});

describe('边界与钳制', () => {
  it('zoom 被夹在 [MIN_ZOOM, MAX_ZOOM]', () => {
    const viewport = makeViewport();
    viewport.zoomTo(1000);
    expect(viewport.zoom).toBe(MAX_ZOOM);
    viewport.zoomTo(0.0001);
    expect(viewport.zoom).toBe(MIN_ZOOM);
  });

  it('缩放到上/下限后继续缩放不会溢出', () => {
    const viewport = makeViewport();
    viewport.zoomTo(MAX_ZOOM);
    viewport.zoomStep(1);
    expect(viewport.zoom).toBe(MAX_ZOOM);

    viewport.zoomTo(MIN_ZOOM);
    viewport.zoomStep(-1);
    expect(viewport.zoom).toBe(MIN_ZOOM);
  });

  it('非法输入被忽略（NaN / 0 / 负数倍率）', () => {
    const viewport = makeViewport();
    viewport.zoomBy(Number.NaN);
    viewport.zoomBy(0);
    viewport.zoomBy(-2);
    viewport.panBy(Number.POSITIVE_INFINITY, 0);
    expect(viewport.zoom).toBe(1);
    expect(viewport.x).toBe(0);
  });

  it('zoomToActualSize 回到 100% 且中心世界坐标不动', () => {
    const viewport = makeViewport(1000, 600);
    viewport.panBy(-300, 90);
    viewport.zoomTo(3.5);
    const before = viewport.toWorld({ x: 500, y: 300 });

    viewport.zoomToActualSize();

    expect(viewport.zoom).toBe(1);
    const after = viewport.toWorld({ x: 500, y: 300 });
    expect(after.x).toBeCloseTo(before.x, 8);
    expect(after.y).toBeCloseTo(before.y, 8);
  });
});

describe('适应全部内容（F1-04 / ⌘0）', () => {
  it('内容居中且完整落在视口内', () => {
    const viewport = makeViewport(1000, 600);
    const bounds = { x: 100, y: 100, width: 500, height: 300 };

    viewport.fit(bounds);

    const center = viewport.toScreen({ x: 350, y: 250 });
    expect(center.x).toBeCloseTo(500, 6);
    expect(center.y).toBeCloseTo(300, 6);

    const topLeft = viewport.toScreen({ x: bounds.x, y: bounds.y });
    const bottomRight = viewport.toScreen({
      x: bounds.x + bounds.width,
      y: bounds.y + bounds.height,
    });
    expect(topLeft.x).toBeGreaterThanOrEqual(0);
    expect(topLeft.y).toBeGreaterThanOrEqual(0);
    expect(bottomRight.x).toBeLessThanOrEqual(1000);
    expect(bottomRight.y).toBeLessThanOrEqual(600);
  });

  it('内容极小时不会放大超过 MAX_ZOOM', () => {
    const viewport = makeViewport(4000, 4000);
    viewport.fit({ x: 0, y: 0, width: 1, height: 1 });
    expect(viewport.zoom).toBe(MAX_ZOOM);
  });

  it('空板（bounds 为 null）退化为 100%，不做无意义放大', () => {
    const viewport = makeViewport();
    viewport.zoomTo(4);
    viewport.fit(null);
    expect(viewport.zoom).toBe(1);
  });

  it('尚未量到尺寸时不动作（面板折叠 / 刚挂载）', () => {
    const viewport = new Viewport();
    viewport.fit({ x: 0, y: 0, width: 100, height: 100 });
    expect(viewport.zoom).toBe(1);
  });
});

describe('视口裁剪矩形（T1.25 消费）', () => {
  it('按屏幕视口外扩 CULL_PADDING 反算世界矩形', () => {
    const viewport = makeViewport(1000, 600);
    viewport.applyState({ x: 100, y: 50, zoom: 2 });

    const bounds = viewport.visibleBounds();
    // toWorld((-200,-200)) = (-150,-125)，toWorld((1200,800)) = (550,375)
    expect(bounds.x).toBeCloseTo(-150, 8);
    expect(bounds.y).toBeCloseTo(-125, 8);
    expect(bounds.width).toBeCloseTo(700, 8);
    expect(bounds.height).toBeCloseTo(500, 8);
    expect(CULL_PADDING).toBe(200);
  });

  it('缩放越小，可见的世界范围越大', () => {
    const viewport = makeViewport(1000, 600);
    const wide = viewport.visibleBounds().width;
    viewport.zoomTo(2);
    expect(viewport.visibleBounds().width).toBeLessThan(wide);
  });
});

describe('通知与生命周期', () => {
  it('每次真实变化只通知一次', () => {
    const viewport = makeViewport();
    const listener = vi.fn();
    viewport.onChange(listener);

    viewport.panBy(10, 0);
    viewport.zoomTo(2);
    expect(listener).toHaveBeenCalledTimes(2);

    // 无变化的调用不通知：拖到边界、重复设置同一倍率
    viewport.panBy(0, 0);
    viewport.zoomTo(2);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('setSize 不触发通知（尺寸不改变世界↔屏幕映射）', () => {
    const viewport = makeViewport();
    const listener = vi.fn();
    viewport.onChange(listener);
    viewport.setSize(123, 456);
    expect(listener).not.toHaveBeenCalled();
  });

  it('applyState 一次性通知，且取消订阅后不再回调', () => {
    const viewport = makeViewport();
    const listener = vi.fn();
    const unsubscribe = viewport.onChange(listener);

    viewport.applyState({ x: 10, y: 20, zoom: 2 });
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    viewport.panBy(5, 5);
    expect(listener).toHaveBeenCalledTimes(1);

    viewport.dispose();
  });
});

describe('视口记忆（T1.22）', () => {
  it('toState 取整到 2 位小数（避免 0.30000000000000004 写进文件）', () => {
    const viewport = makeViewport();
    // 平移/缩放带小数的值：applyState 直接落值，避免锚点重算引入额外误差
    viewport.applyState({ x: 0.123456, y: -1.987654, zoom: 1.23456789 });

    const state = viewport.toState();
    expect(state.x).toBe(0.12);
    expect(state.y).toBe(-1.99);
    expect(state.zoom).toBe(1.2346);
  });

  it('applyState → toState 往返稳定', () => {
    const viewport = makeViewport();
    viewport.applyState({ x: -812.44, y: 337.5, zoom: 0.6406 });
    expect(viewport.toState()).toEqual({ x: -812.44, y: 337.5, zoom: 0.6406 });
  });

  it('脏数据被忽略，保留当前视口', () => {
    const viewport = makeViewport();
    viewport.panBy(100, 200);
    viewport.applyState({ x: Number.NaN, y: 500, zoom: 0 });
    expect(viewport.x).toBe(100);
    expect(viewport.y).toBe(500);
    expect(viewport.zoom).toBe(1);
  });

  it('越界的 zoom 被夹紧到合法区间', () => {
    const viewport = makeViewport();
    viewport.applyState({ zoom: 999 });
    expect(viewport.zoom).toBe(MAX_ZOOM);
    viewport.applyState({ zoom: 0.00001 });
    expect(viewport.zoom).toBe(MIN_ZOOM);
  });

  it('null / undefined 状态安全（文件里没有 view 字段）', () => {
    const viewport = makeViewport();
    viewport.applyState(null);
    viewport.applyState(undefined);
    expect(viewport.x).toBe(0);
    expect(viewport.zoom).toBe(1);
  });
});
