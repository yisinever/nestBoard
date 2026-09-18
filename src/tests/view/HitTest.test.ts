/**
 * 几何命中测试（T1.30）。
 *
 * DOM 委托那半边只能在 Obsidian 里验证（需要真实 `closest` / `getBoundingClientRect`），
 * 这里钉住"点在哪张卡上"的判定规则 —— 它是选择、拖动、连线落点的共同前提。
 */

import { describe, expect, it } from 'vitest';
import { createCard } from '../../model/factories';
import type { Card } from '../../model/schema';
import { hitTest, hitTestAtScreen } from '../../view/interact/HitTest';
import { Viewport } from '../../canvas/Viewport';

function cardAt(id: string, x: number, y: number, width: number, height: number, z: number): Card {
  return { ...createCard('note'), id, x, y, width, height, z };
}

describe('hitTest', () => {
  it('空板 → null', () => {
    expect(hitTest([], { x: 0, y: 0 })).toBeNull();
  });

  it('点空白 → null', () => {
    expect(hitTest([cardAt('c1', 0, 0, 100, 100, 1)], { x: 500, y: 500 })).toBeNull();
  });

  it('点在卡片内 → 命中该卡', () => {
    const card = cardAt('c1', 10, 20, 100, 50, 1);
    expect(hitTest([card], { x: 60, y: 45 })?.id).toBe('c1');
  });

  it('边界算命中（左上/右下角都在矩形内）', () => {
    const card = cardAt('c1', 0, 0, 100, 50, 1);
    expect(hitTest([card], { x: 0, y: 0 })?.id).toBe('c1');
    expect(hitTest([card], { x: 100, y: 50 })?.id).toBe('c1');
    expect(hitTest([card], { x: 100.001, y: 50 })).toBeNull();
  });

  it('重叠时取 z 最大的那张（最上层）', () => {
    const cards = [
      cardAt('c_top', 0, 0, 200, 200, 9),
      cardAt('c_bottom', 0, 0, 200, 200, 3),
      cardAt('c_middle', 50, 50, 100, 100, 5),
    ];
    expect(hitTest(cards, { x: 60, y: 60 })?.id).toBe('c_top');
    // 只在低层卡片里命中的点
    expect(hitTest(cards, { x: 150, y: 150 })?.id).toBe('c_top');
  });

  it('不假设入参已按 z 排序', () => {
    const cards = [cardAt('c_low', 0, 0, 100, 100, 1), cardAt('c_high', 0, 0, 100, 100, 8)];
    expect(hitTest(cards, { x: 50, y: 50 })?.id).toBe('c_high');
    expect(hitTest([...cards].reverse(), { x: 50, y: 50 })?.id).toBe('c_high');
  });

  it('坐标非法（NaN）→ 不命中，绝不误选一张卡', () => {
    expect(hitTest([cardAt('c1', 0, 0, 100, 100, 1)], { x: Number.NaN, y: 10 })).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────
// 旋转过的卡片（T7.06 / `F2-00-10`）
//
// 判据必须是"点在**屏幕上那个形状**里"，而不是"点在它的布局框里"：
// 后者会让卡片转出来的四个角判不中、而四角外的空白判中 —— 用户看到的是
// "点在这张卡上却没反应"与"点空白却选中了它"，两种都是当场就能感觉到的错。
// ─────────────────────────────────────────────────────────────

describe('hitTest · 旋转过的卡片', () => {
  /** 转 45° 的 100×100 卡：屏幕上是个菱形，中心仍是 (50, 50) */
  const diamond: Card = { ...cardAt('c1', 0, 0, 100, 100, 1), rotation: 45 };

  it('中心当然命中', () => {
    expect(hitTest([diamond], { x: 50, y: 50 })?.id).toBe('c1');
  });

  it('★ 布局框之内、菱形之外的点**不**命中（四角是空的）', () => {
    // 左上角 (5, 5) 在布局框里，但转 45° 之后那里是空白
    expect(hitTest([diamond], { x: 5, y: 5 })).toBeNull();
  });

  it('★ 布局框之外、菱形之内的点**要**命中（转出来的那个尖）', () => {
    // (50, -10) 在布局框上方，但菱形向上探到了 -20.7
    expect(hitTest([diamond], { x: 50, y: -10 })?.id).toBe('c1');
  });

  it('转 90 度的卡片按转过之后的形状判定', () => {
    const turned: Card = { ...cardAt('c1', 0, 0, 200, 40, 1), rotation: 90 };
    // 中心 (100, 20)；转 90° 后竖着站：高 200、宽 40
    expect(hitTest([turned], { x: 100, y: 100 })?.id).toBe('c1');
    // 原来的"右端"转到了下方，横着 180 处已经是空的
    expect(hitTest([turned], { x: 180, y: 20 })).toBeNull();
  });

  it('没写 rotation 的卡片行为一字不变（存量文件）', () => {
    const plain = cardAt('c1', 0, 0, 100, 100, 1);
    expect(hitTest([plain], { x: 5, y: 5 })?.id).toBe('c1');
  });
});

describe('hitTestAtScreen', () => {
  it('按视口换算后再命中', () => {
    const viewport = new Viewport();
    viewport.setSize(800, 600);
    // 世界原点落在屏幕 (100, 50)，缩放 2 → 世界 (0,0)-(100,100) 占屏幕 (100,50)-(300,250)
    viewport.applyState({ x: 100, y: 50, zoom: 2 });

    const card = cardAt('c1', 0, 0, 100, 100, 1);
    expect(hitTestAtScreen([card], viewport, { x: 150, y: 100 })?.id).toBe('c1');
    expect(hitTestAtScreen([card], viewport, { x: 50, y: 100 })).toBeNull();
  });
});
