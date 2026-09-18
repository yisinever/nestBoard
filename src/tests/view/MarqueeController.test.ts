/**
 * 选区模型与框选几何（T1.31 / F3-08）。
 *
 * 指针部分要在真实浏览器里验证（`setPointerCapture` / `getBoundingClientRect`），
 * 这里钉住两件最容易出错、也最该由单测守着的事：
 *  1. `SelectionModel.set()` 的返回值必须**精确** —— 框选每帧都调它，
 *     多报一次"变了"就是每帧重刷一遍选中外观，少报一次就是选区死活不更新；
 *  2. `cardIds` 是**活引用**（渲染层会长期持有），不能被换成新对象。
 */

import { describe, expect, it, vi } from 'vitest';
import { rectFromPoints } from '../../util/geometry';
import { SelectionModel, marqueeSelectableCards } from '../../view/interact/MarqueeController';

// ─────────────────────────────────────────────────────────────
// 框选与分栏（用户 2026-09-16）：栏内卡片不参与框选；栏本身参与
// ─────────────────────────────────────────────────────────────

describe('框选能选中的卡片（栏内的不参与）', () => {
  const card = (id: string, columnId: string | null) => ({ id, columnId });

  it('★ 栏内的卡片被跳过，栏外的照旧（点选不受这条限制，只有框选跳过）', () => {
    const cards = [card('散1', null), card('栏内', 'col1'), card('散2', null)];

    expect(marqueeSelectableCards(cards).map((item) => item.id)).toEqual(['散1', '散2']);
  });

  it('全在栏里 ⇒ 一张都框不到（那时框到的是**栏**自己）', () => {
    expect(marqueeSelectableCards([card('a', 'col1'), card('b', 'col1')])).toEqual([]);
  });

  it('一张栏都没有时原样返回（绝大多数板子走这一档）', () => {
    const cards = [card('a', null), card('b', null)];
    expect(marqueeSelectableCards(cards)).toEqual(cards);
  });
});

describe('选区里的分栏（能多栏、可与卡片共存）', () => {
  it('★ `set` 能一次放进好几栏（框选每帧都走它）', () => {
    const selection = new SelectionModel();
    expect(selection.set({ columns: ['c1', 'c2', 'c3'] })).toBe(true);
    expect([...selection.columnIds].sort()).toEqual(['c1', 'c2', 'c3']);
    // ★ 多个栏时 `columnId`（单数）给 `null` —— 只有"恰好一个"才谈得上"选中的那一栏"
    expect(selection.columnId).toBeNull();

    expect(selection.set({ columns: ['c3'] })).toBe(true);
    expect(selection.columnId).toBe('c3');
  });

  it('★ 卡片与分栏**可以同时在选区里**（"框住两栏 + 几张贴在栏外的卡"是合法选区）', () => {
    const selection = new SelectionModel();
    selection.set({ cards: ['a'], columns: ['c1'] });

    expect(selection.hasCard('a')).toBe(true);
    expect(selection.hasColumn('c1')).toBe(true);
    expect(selection.size).toBe(2);
  });

  it('★ 点选（`selectColumn`）仍然收敛成唯一一个、且清掉卡片与连线', () => {
    const selection = new SelectionModel();
    selection.set({ cards: ['a'], edges: ['e'], columns: ['c1', 'c2'] });

    expect(selection.selectColumn('c9')).toBe(true);
    expect(selection.columnId).toBe('c9');
    expect(selection.cardIds.size).toBe(0);
    expect(selection.edgeIds.size).toBe(0);
  });
});

describe('SelectionModel', () => {
  it('初始为空', () => {
    const selection = new SelectionModel();
    expect(selection.isEmpty).toBe(true);
    expect(selection.size).toBe(0);
    expect([...selection.cardIds]).toEqual([]);
  });

  it('set 卡片后反映在 cardIds / hasCard 上', () => {
    const selection = new SelectionModel();
    expect(selection.set({ cards: ['a', 'b'] })).toBe(true);
    expect(selection.isEmpty).toBe(false);
    expect(selection.size).toBe(2);
    expect(selection.hasCard('a')).toBe(true);
    expect(selection.hasCard('z')).toBe(false);
    expect([...selection.cardIds].sort()).toEqual(['a', 'b']);
  });

  it('★ 内容相同的 set 返回 false（框选每帧都调，不能每帧都刷 DOM）', () => {
    const selection = new SelectionModel();
    selection.set({ cards: ['a', 'b'] });
    expect(selection.set({ cards: ['b', 'a'] })).toBe(false);
    expect(selection.set({ cards: ['a', 'b', 'a'] })).toBe(false);

    const listener = vi.fn();
    selection.onChange(listener);
    selection.set({ cards: ['a', 'b'] });
    expect(listener).not.toHaveBeenCalled();
  });

  it('内容变了才返回 true 并通知订阅者', () => {
    const selection = new SelectionModel();
    selection.set({ cards: ['a'] });
    const listener = vi.fn();
    selection.onChange(listener);

    expect(selection.set({ cards: ['a', 'b'] })).toBe(true);
    expect(selection.set({ cards: ['c'] })).toBe(true);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('省略 cards = 清空（而不是"保持不变"）', () => {
    const selection = new SelectionModel();
    selection.set({ cards: ['a'] });
    expect(selection.set({})).toBe(true);
    expect(selection.isEmpty).toBe(true);
  });

  it('★ cardIds 是活引用：就地更新，不换对象', () => {
    const selection = new SelectionModel();
    const ref = selection.cardIds;
    selection.set({ cards: ['a'] });
    expect(selection.cardIds).toBe(ref);
    expect([...ref]).toEqual(['a']);
  });

  it('clear 返回"是否真的清掉了东西"（Esc 靠它决定要不要 preventDefault）', () => {
    const selection = new SelectionModel();
    expect(selection.clear()).toBe(false);
    selection.set({ cards: ['a'] });
    expect(selection.clear()).toBe(true);
    expect(selection.clear()).toBe(false);
  });

  it('卡片与连线是两套独立集合（F3-08：框选也能选线）', () => {
    const selection = new SelectionModel();
    selection.set({ cards: ['c1'], edges: ['e1'] });
    expect(selection.hasCard('c1')).toBe(true);
    expect(selection.hasEdge('e1')).toBe(true);
    expect(selection.size).toBe(2);

    selection.set({ cards: ['c1'] });
    expect(selection.hasEdge('e1')).toBe(false);
    expect(selection.hasCard('c1')).toBe(true);
  });

  it('退订后不再收到通知', () => {
    const selection = new SelectionModel();
    const listener = vi.fn();
    const unsubscribe = selection.onChange(listener);
    selection.set({ cards: ['a'] });
    unsubscribe();
    selection.set({ cards: ['b'] });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('dispose 之后彻底空掉', () => {
    const selection = new SelectionModel();
    selection.set({ cards: ['a'], edges: ['e'] });
    selection.dispose();
    expect(selection.isEmpty).toBe(true);
    // dispose 后 set 不应再报"无变化"，否则调用方会以为旧数据还在
    expect(selection.set({ cards: ['a'] })).toBe(true);
  });
});

describe('rectFromPoints', () => {
  it('拖向四个方向都得到正宽高的矩形', () => {
    const expected = { x: 10, y: 20, width: 90, height: 80 };
    expect(rectFromPoints({ x: 10, y: 20 }, { x: 100, y: 100 })).toEqual(expected);
    expect(rectFromPoints({ x: 100, y: 100 }, { x: 10, y: 20 })).toEqual(expected);
    expect(rectFromPoints({ x: 10, y: 100 }, { x: 100, y: 20 })).toEqual(expected);
    expect(rectFromPoints({ x: 100, y: 20 }, { x: 10, y: 100 })).toEqual(expected);
  });

  it('零位移 → 零矩形（点击空白时框选不该"凭空选中"东西）', () => {
    expect(rectFromPoints({ x: 5, y: 5 }, { x: 5, y: 5 })).toEqual({
      x: 5,
      y: 5,
      width: 0,
      height: 0,
    });
  });
});
