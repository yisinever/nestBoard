/**
 * 画布过滤的判据（T3.17 / T3.18 / `F8-04` / `F8-06`）。
 *
 * 过滤的全部价值在**判据**上：变淡是渲染层的事，而"谁该变淡"由这里决定。
 * 所以用例围着三件事转：
 *
 *  * 空过滤 = 谁都不变淡（不是"全部变淡"）；
 *  * 三个维度（文本 / 类型 / 断链）是 **AND**，且文本维度复用搜索那套字段；
 *  * `matchedCount` 与 `filteredOutIds` 永远是同一件事的两面 ——
 *    两者不一致时，面板上的"N / M"会和画布上亮着的卡片数对不上。
 */

import { describe, expect, it } from 'vitest';
import { createBoardFile, createCard } from '../../model/factories';
import {
  FILTERABLE_TYPES,
  NO_FILTER,
  cardPassesFilter,
  filteredOutIds,
  isFilterActive,
  matchedCount,
} from '../../model/filter';
import type { CardFilter } from '../../model/filter';
import type { BoardFile } from '../../model/schema';
import { CARD_TYPES } from '../../model/schema';

/** 一张便签（可搜正文）、一张图片（可搜路径）、一个待办、一条外链 */
function sampleBoard(): BoardFile {
  return createBoardFile({
    cards: [
      createCard('note', { title: '周报', content: { md: '本周完成 #发布 与联调' } }),
      createCard('image', { title: '截图', content: { path: 'assets/a.png' } }),
      createCard('todo', { title: '待办', content: { title: '', items: [] } }),
      createCard('link', { title: '文档', content: { url: 'https://example.com/docs' } }),
    ],
  });
}

/** 全空过滤：`types` 必须是**新建**的空集，避免用例之间共享同一份可变状态 */
function filterOf(overrides: Partial<CardFilter> = {}): CardFilter {
  return { ...NO_FILTER, types: new Set(), ...overrides };
}

const nothingBroken = (): boolean => false;

describe('isFilterActive', () => {
  it('全空 = 不活跃', () => {
    expect(isFilterActive(filterOf())).toBe(false);
  });

  it('纯空白 query 不算活跃（用户敲了个空格不该让全板变淡）', () => {
    expect(isFilterActive(filterOf({ query: '   ' }))).toBe(false);
  });

  it('任一维度非空 = 活跃', () => {
    expect(isFilterActive(filterOf({ query: '周报' }))).toBe(true);
    expect(isFilterActive(filterOf({ types: new Set(['note' as const]) }))).toBe(true);
    expect(isFilterActive(filterOf({ onlyBroken: true }))).toBe(true);
  });
});

describe('FILTERABLE_TYPES', () => {
  it('就是全部卡片类型（漏一种会让该类型永远过滤不出来）', () => {
    expect([...FILTERABLE_TYPES]).toEqual([...CARD_TYPES]);
  });
});

describe('空过滤', () => {
  it('谁都不被过滤掉（空集 ≠ 全集：调用方不必先判活跃性）', () => {
    const board = sampleBoard();
    expect([...filteredOutIds(board, filterOf(), nothingBroken)]).toEqual([]);
  });

  it('匹配数 = 全部卡片', () => {
    expect(matchedCount(sampleBoard(), filterOf(), nothingBroken)).toBe(4);
  });
});

describe('文本维度', () => {
  it('命中的留着、其余进"被过滤掉"', () => {
    const board = sampleBoard();
    const out = filteredOutIds(board, filterOf({ query: '周报' }), nothingBroken);

    expect([...out]).toEqual([board.cards[1].id, board.cards[2].id, board.cards[3].id]);
  });

  it('`#标签` 走的就是文本匹配（T3.18 不单独做"标签"维度）', () => {
    const board = sampleBoard();
    const out = filteredOutIds(board, filterOf({ query: '#发布' }), nothingBroken);

    expect(out.has(board.cards[0].id)).toBe(false);
    expect(out.size).toBe(3);
  });

  it('多个词是 AND', () => {
    const board = sampleBoard();
    const both = filteredOutIds(board, filterOf({ query: '本周 联调' }), nothingBroken);
    const miss = filteredOutIds(board, filterOf({ query: '本周 不存在的词' }), nothingBroken);

    expect(both.size).toBe(3);
    expect(miss.size).toBe(4);
  });
});

describe('类型维度', () => {
  it('只留选中的类型；空集 = 不按类型过滤', () => {
    const board = sampleBoard();
    const out = filteredOutIds(
      board,
      filterOf({ types: new Set(['image' as const]) }),
      nothingBroken,
    );

    expect(out.has(board.cards[1].id)).toBe(false);
    expect(out.size).toBe(3);
  });
});

describe('断链维度', () => {
  it('只看断链：判定由调用方注入', () => {
    const board = sampleBoard();
    const broken = new Set([board.cards[0].id]);
    const out = filteredOutIds(board, filterOf({ onlyBroken: true }), (id) => broken.has(id));

    expect(out.has(board.cards[0].id)).toBe(false);
    expect(out.size).toBe(3);
  });
});

describe('三维叠加', () => {
  it('类型 + 文本 + 断链是 AND（任一不过就不留）', () => {
    const board = sampleBoard();
    const filter = filterOf({ query: '周报', types: new Set(['note' as const]), onlyBroken: true });
    const isBroken = (id: string): boolean => id === board.cards[0].id;

    expect(cardPassesFilter(board.cards[0], filter, isBroken)).toBe(true);
    // 类型对、但不在断链集合里
    expect(cardPassesFilter(board.cards[0], filter, nothingBroken)).toBe(false);
  });
});

describe('matchedCount 与 filteredOutIds 互补', () => {
  it('匹配 + 被过滤 = 总数（面板数字与画布外观必须同源）', () => {
    const board = sampleBoard();
    const cases = [
      filterOf(),
      filterOf({ query: '周报' }),
      filterOf({ types: new Set(['todo' as const]) }),
      filterOf({ onlyBroken: true }),
      filterOf({ query: '截图', types: new Set(['image' as const]) }),
    ];

    for (const filter of cases) {
      const out = filteredOutIds(board, filter, nothingBroken);
      expect(matchedCount(board, filter, nothingBroken) + out.size).toBe(board.cards.length);
    }
  });
});
