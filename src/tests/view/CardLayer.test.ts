/**
 * CardLayer 纯逻辑单元测试（T1.24 / T1.25）。
 *
 * DOM 部分（复用池、挂载/回收）跑在 Obsidian 里，这里只钉两件"错了很难肉眼发现"的事：
 *   1. **叠放顺序**：`z` 是主依据，同 `z` 必须有稳定次序（否则重开就"换层"）；
 *   2. **裁剪判据**：视口外不渲染（F1-01 无限画布的性能前提），且边界相接不算相交。
 *
 * 测试文件跑在 node 环境（vitest.config.ts），因此这里只 import 纯函数 ——
 * 只要 `CardLayer.ts` 顶层不碰 `document`，导入就是安全的。
 */

import { describe, expect, it } from 'vitest';
import { CARD_COLLAPSED_HEIGHT } from '../../constants';
import { createCard } from '../../model/factories';
import type { Card } from '../../model/schema';
import {
  cardRect,
  cardsIntersecting,
  isCardVisible,
  sortCardsByZ,
  visibleCardsOf,
} from '../../view/render/CardLayer';

/** 造一张固定位置/尺寸/层级的卡片，便于精确断言 */
function cardAt(id: string, x: number, y: number, width: number, height: number, z: number): Card {
  return { ...createCard('note'), id, x, y, width, height, z };
}

describe('sortCardsByZ', () => {
  it('按 z 升序（越大越靠上）', () => {
    const cards = [cardAt('c1', 0, 0, 10, 10, 30), cardAt('c2', 0, 0, 10, 10, 10)];
    expect(sortCardsByZ(cards).map((c) => c.id)).toEqual(['c2', 'c1']);
  });

  it('同 z 时按 id 兜底，结果稳定', () => {
    const cards = [cardAt('c_b', 0, 0, 10, 10, 5), cardAt('c_a', 0, 0, 10, 10, 5)];
    expect(sortCardsByZ(cards).map((c) => c.id)).toEqual(['c_a', 'c_b']);
  });

  it('不修改入参（渲染层可能持有同一份数组）', () => {
    const cards = [cardAt('c1', 0, 0, 10, 10, 30), cardAt('c2', 0, 0, 10, 10, 10)];
    sortCardsByZ(cards);
    expect(cards.map((c) => c.id)).toEqual(['c1', 'c2']);
  });
});

describe('cardRect', () => {
  it('取卡片的世界坐标矩形', () => {
    expect(cardRect(cardAt('c1', 12, -8, 280, 180, 1))).toEqual({
      x: 12,
      y: -8,
      width: 280,
      height: 180,
    });
  });

  it('★ 收起的卡片只有标题行那么高（`O31`：框选 / 裁剪与骨架写的高度同源）', () => {
    const collapsed = { ...cardAt('c1', 12, -8, 280, 180, 1), collapsed: true };
    expect(cardRect(collapsed)).toEqual({
      x: 12,
      y: -8,
      width: 280,
      height: CARD_COLLAPSED_HEIGHT,
    });
  });
});

describe('视口裁剪（T1.25）', () => {
  const view = { x: 0, y: 0, width: 1000, height: 600 };

  it('完全落在视口内 → 可见', () => {
    expect(isCardVisible(cardAt('c1', 100, 100, 200, 150, 1), view)).toBe(true);
  });

  it('完全在视口外 → 不可见', () => {
    expect(isCardVisible(cardAt('c1', 2000, 100, 200, 150, 1), view)).toBe(false);
    expect(isCardVisible(cardAt('c1', -400, 100, 200, 150, 1), view)).toBe(false);
    expect(isCardVisible(cardAt('c1', 100, -400, 200, 150, 1), view)).toBe(false);
  });

  it('部分重叠 → 可见（边缘卡片不能提前消失）', () => {
    expect(isCardVisible(cardAt('c1', 900, 500, 200, 200, 1), view)).toBe(true);
    expect(isCardVisible(cardAt('c1', -150, -100, 200, 200, 1), view)).toBe(true);
  });

  it('边界相接不算相交（rectsIntersect 的语义）', () => {
    // 卡片右边缘正好落在视口左边缘
    expect(isCardVisible(cardAt('c1', -200, 0, 200, 200, 1), view)).toBe(false);
  });

  it('坐标非法（NaN，脏数据）→ 不可见，绝不因一个坏数字把卡片画到视口外', () => {
    const broken: Card = { ...cardAt('c1', 0, 0, 100, 100, 1), x: Number.NaN };
    expect(isCardVisible(broken, view)).toBe(false);
  });
});

describe('cardsIntersecting', () => {
  it('挑出可见卡片且保持原顺序（即绘制顺序）', () => {
    const cards = [
      cardAt('c_far', 5000, 5000, 100, 100, 1),
      cardAt('c_near', 100, 100, 100, 100, 2),
      cardAt('c_mid', 900, 500, 200, 200, 3),
    ];
    const view = { x: 0, y: 0, width: 1000, height: 600 };
    expect(cardsIntersecting(cards, view).map((c) => c.id)).toEqual(['c_near', 'c_mid']);
  });

  it('空矩形 → 空结果（视图尚未布局时不会渲染任何卡片）', () => {
    const cards = [cardAt('c1', 0, 0, 100, 100, 1)];
    expect(cardsIntersecting(cards, { x: 0, y: 0, width: 0, height: 0 })).toEqual([]);
  });

  it('框选与裁剪同判据：部分压线的卡片也算命中（不会"看得见却框不中"）', () => {
    const cards = [cardAt('c1', -50, -50, 100, 100, 1), cardAt('c2', 200, 200, 100, 100, 2)];
    const marquee = { x: 0, y: 0, width: 100, height: 100 };
    expect(cardsIntersecting(cards, marquee).map((c) => c.id)).toEqual(['c1']);
  });
});

describe('visibleCardsOf（O03 收起的分组）', () => {
  const cards = [
    cardAt('a', 0, 0, 100, 100, 1),
    cardAt('b', 0, 0, 100, 100, 2),
    cardAt('c', 0, 0, 100, 100, 3),
  ];

  it('藏掉被点名的卡片，其余保持原顺序（顺序 = 绘制顺序）', () => {
    expect(visibleCardsOf(cards, new Set(['b'])).map((card) => card.id)).toEqual(['a', 'c']);
  });

  it('★ 没有收起的分组时原样返回入参（每帧都调，不该为此新建数组）', () => {
    const same = visibleCardsOf(cards, new Set());
    expect(same).toBe(cards);
  });

  it('★ 藏起来的卡片不参与裁剪，也就不可能被框选（框选走的是同一份候选集）', () => {
    const view = { x: 0, y: 0, width: 1000, height: 600 };
    const visible = visibleCardsOf(cards, new Set(['a', 'b']));
    expect(cardsIntersecting(visible, view).map((card) => card.id)).toEqual(['c']);
  });

  it('名字对不上任何卡片 → 等于没藏（坏数据不该连坐）', () => {
    expect(visibleCardsOf(cards, new Set(['ghost'])).map((card) => card.id)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });
});
