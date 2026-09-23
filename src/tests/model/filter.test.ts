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
import { createBoardFile, createCard, createMind } from '../../model/factories';
import {
  FILTERABLE_TYPES,
  NO_FILTER,
  cardPassesFilter,
  dimmedMindNodeKeys,
  filteredOutIds,
  isFilterActive,
  matchedCount,
} from '../../model/filter';
import type { CardFilter } from '../../model/filter';
import type { BoardFile } from '../../model/schema';
import { CARD_TYPES, nodeEndpointKey } from '../../model/schema';
import { addMind } from '../../model/ops';
import { addChild, setText } from '../../mind/model/ops';
import { createMindFile } from '../../mind/model/factories';
import type { MindFile } from '../../mind/model/schema';

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
    // ★ 过滤条列的是"会出现在板子上的类型"：老的两类脑图卡（`mind` / `mindRef`）
    //   不在其中 —— 它们只活在读入口（进板子前就被转成容器了），列出来只会是
    //   两个永远筛不出东西的开关。`CARD_TYPES` 本身**不能**动（`isCardType` 把着读入口）。
    expect([...FILTERABLE_TYPES]).toEqual(
      CARD_TYPES.filter((type) => type !== 'mind' && type !== 'mindRef'),
    );
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

describe('脑图节点参与过滤（`2.2.0` 批 4）', () => {
  /** 一棵**文字已知**的脑图模型：根《路线图》+ 两个分支（一个提"发布"、一个提"联调"） */
  function mindModel(): MindFile {
    const file = createMindFile({ rootText: '路线图', branches: 0 });
    const branchA = addChild(file, file.rootId);
    const branchB = addChild(file, file.rootId);
    if (branchA) setText(file, branchA, '发布计划');
    if (branchB) setText(file, branchB, '联调安排');
    return file;
  }

  /** 一块板：一棵内嵌脑图 + 一棵"指向 `.nestmind`"的脑图（后者要调用方喂模型） */
  function boardWithMinds(inlineModel: MindFile | null): BoardFile {
    const board = createBoardFile({});
    addMind(board, {
      ...createMind({ path: '' }),
      id: 'nm_inline',
      mind: inlineModel ?? undefined,
    });
    addMind(board, { ...createMind({ path: 'notes/甲.nestmind' }), id: 'nm_file' });
    return board;
  }

  const model = mindModel();
  const [root, nodeA, nodeB] = model.nodes;

  it('★ 按**节点**变淡：没命中的那几个进集合，键是 `脑图id/节点id`', () => {
    const board = boardWithMinds(model);
    const out = dimmedMindNodeKeys(board, filterOf({ query: '发布' }), () => null);

    expect([...out].sort()).toEqual(
      [nodeEndpointKey('nm_inline', root.id), nodeEndpointKey('nm_inline', nodeB.id)].sort(),
    );
  });

  it('★ 只勾类型 / 只看断链 ⇒ 一个节点都不变淡（节点没有类型、也没有链接）', () => {
    const board = boardWithMinds(model);

    expect(
      dimmedMindNodeKeys(board, filterOf({ types: new Set(['note' as const]) }), () => null).size,
    ).toBe(0);
    expect(dimmedMindNodeKeys(board, filterOf({ onlyBroken: true }), () => null).size).toBe(0);
    // 类型 + 文本同时勾：**文本那一维照旧管节点**（类型那一维才是被忽略的）
    const mixed = dimmedMindNodeKeys(
      board,
      filterOf({ query: '联调', types: new Set(['note' as const]) }),
      () => null,
    );
    expect(mixed.size).toBe(2);
  });

  it('空过滤（含纯空白）⇒ 空集（不是全集）', () => {
    const board = boardWithMinds(model);
    expect(dimmedMindNodeKeys(board, filterOf(), () => null).size).toBe(0);
    expect(dimmedMindNodeKeys(board, filterOf({ query: '  ' }), () => null).size).toBe(0);
  });

  it('★ 指向 `.nestmind` 的树：模型喂不进来（文件没了 / 还没读到）⇒ 那一棵不参与', () => {
    const board = boardWithMinds(null);
    const out = dimmedMindNodeKeys(board, filterOf({ query: '发布' }), () => model);

    // 只有"文件树"那一棵贡献了结果，而且用的是它自己的 id
    expect(out.size).toBe(model.nodes.length - 1);
    expect(out.has(nodeEndpointKey('nm_file', nodeA.id))).toBe(false);
    expect(out.has(nodeEndpointKey('nm_file', nodeB.id))).toBe(true);
    expect([...out].every((key) => key.startsWith('nm_file/'))).toBe(true);
  });

  it('没有脑图的板子：这条路永远是空集（老板一行都不用改）', () => {
    expect(dimmedMindNodeKeys(sampleBoard(), filterOf({ query: '周报' }), () => null).size).toBe(0);
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
