/**
 * 白板级待办聚合单元测试（T3.03 / `F2.5`）。
 *
 * 这层是"浮层能看到什么"的唯一真相来源，所以钉三件事：
 *   1. **过滤**：只出未完成的；
 *   2. **定位**：`index` 必须是 `items` 里的**真实下标** —— 浮层勾选时靠它回写，
 *      差一位就会勾错一条（而且用户看不出来，只会在别处发现少了一项）；
 *   3. **排序**：按版面而不是插入顺序，且**不得就地打乱 `board.cards`**
 *      —— 那个顺序被撤销栈与连线对位依赖着。
 */

import { describe, expect, it } from 'vitest';
import { createBoardFile, createCard } from '../../model/factories';
import type { TodoItem } from '../../model/schema';
import { collectOpenTodos, todoTotals } from '../../model/todos';

function todoCard(title: string, x: number, y: number, items: TodoItem[]) {
  return createCard('todo', { x, y, title, content: { title: '', items } });
}

describe('collectOpenTodos', () => {
  it('没有待办卡时返回空数组', () => {
    const board = createBoardFile({ cards: [createCard('note'), createCard('image')] });
    expect(collectOpenTodos(board)).toEqual([]);
  });

  it('待办卡里没有未完成项时也是空数组', () => {
    const board = createBoardFile({
      cards: [todoCard('本周', 0, 0, [{ text: 'a', done: true }])],
    });
    expect(collectOpenTodos(board)).toEqual([]);
  });

  it('只收未完成项，已完成的跳过', () => {
    const board = createBoardFile({
      cards: [
        todoCard('本周', 0, 0, [
          { text: 'a', done: false },
          { text: 'b', done: true },
          { text: 'c', done: false },
        ]),
      ],
    });
    expect(collectOpenTodos(board).map((entry) => entry.text)).toEqual(['a', 'c']);
  });

  it('index 是 items 里的真实下标（勾选靠它定位）', () => {
    const board = createBoardFile({
      cards: [
        todoCard('本周', 0, 0, [
          { text: '已完成的第一条', done: true },
          { text: '未完成的第二条', done: false },
        ]),
      ],
    });
    expect(collectOpenTodos(board)[0].index).toBe(1);
  });

  it('跨卡片聚合，带上来源卡片的 id 与标题', () => {
    const first = todoCard('甲', 0, 0, [{ text: 'a', done: false }]);
    const second = todoCard('乙', 0, 100, [{ text: 'b', done: false }]);
    const board = createBoardFile({ cards: [first, second] });
    expect(collectOpenTodos(board)).toEqual([
      { cardId: first.id, cardTitle: '甲', index: 0, text: 'a' },
      { cardId: second.id, cardTitle: '乙', index: 0, text: 'b' },
    ]);
  });

  it('按版面（上 → 下）排序，不按插入顺序', () => {
    const lower = todoCard('下', 0, 500, [{ text: 'lower', done: false }]);
    const upper = todoCard('上', 0, 0, [{ text: 'upper', done: false }]);
    // 插入顺序是"先下的后上的"——列表必须扳回来
    const board = createBoardFile({ cards: [lower, upper] });
    expect(collectOpenTodos(board).map((entry) => entry.text)).toEqual(['upper', 'lower']);
  });

  it('同一行时按 x 排（左 → 右）', () => {
    const right = todoCard('右', 500, 0, [{ text: '右', done: false }]);
    const left = todoCard('左', 0, 0, [{ text: '左', done: false }]);
    const board = createBoardFile({ cards: [right, left] });
    expect(collectOpenTodos(board).map((entry) => entry.text)).toEqual(['左', '右']);
  });

  it('排序不得就地打乱 board.cards', () => {
    const lower = todoCard('下', 0, 500, [{ text: 'lower', done: false }]);
    const upper = todoCard('上', 0, 0, [{ text: 'upper', done: false }]);
    const board = createBoardFile({ cards: [lower, upper] });

    collectOpenTodos(board);

    expect(board.cards.map((card) => card.id)).toEqual([lower.id, upper.id]);
  });

  it('text 原样带出（缩进是存储格式，由显示层决定怎么画）', () => {
    const board = createBoardFile({
      cards: [todoCard('', 0, 0, [{ text: '  子项', done: false }])],
    });
    expect(collectOpenTodos(board)[0].text).toBe('  子项');
  });

  it('无标题卡片照常聚合（cardTitle 是空串，不是 undefined）', () => {
    const board = createBoardFile({
      cards: [todoCard('', 0, 0, [{ text: 'a', done: false }])],
    });
    expect(collectOpenTodos(board)[0].cardTitle).toBe('');
  });
});

describe('todoTotals', () => {
  it('分别数未完成与已完成', () => {
    const board = createBoardFile({
      cards: [
        todoCard('甲', 0, 0, [
          { text: 'a', done: false },
          { text: 'b', done: true },
        ]),
        todoCard('乙', 0, 100, [{ text: 'c', done: true }]),
      ],
    });
    expect(todoTotals(board)).toEqual({ open: 1, done: 2 });
  });

  it('空板与非待办卡都算 {open: 0, done: 0}', () => {
    expect(todoTotals(createBoardFile())).toEqual({ open: 0, done: 0 });
    expect(
      todoTotals(createBoardFile({ cards: [createCard('note'), createCard('image')] })),
    ).toEqual({ open: 0, done: 0 });
  });
});
