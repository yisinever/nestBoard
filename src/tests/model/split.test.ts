/**
 * 拆板模型逻辑（T2.16 / `02 §8.3`）单测。
 *
 * 拆板是**一次性动几千张卡**的破坏性操作，所以这里测的不是"算得对不对"，
 * 而是"会不会毁数据"：卡片会不会丢、连线会不会悬空、编组会不会只剩一半、
 * 子板与原板会不会共享同一批对象。这些错了都不会抛异常，只会让用户丢内容。
 */

import { describe, expect, it } from 'vitest';
import {
  createBoardFile,
  createCard,
  createColumn,
  createEdge,
  createGroup,
} from '../../model/factories';
import type { BoardFile, Card, Column } from '../../model/schema';
import { setColumnCollapsed } from '../../model/columns';
import {
  SPLIT_CHUNK_SIZE,
  applySplitToSource,
  buildSplitChildBoard,
  splitBoardPlan,
  splitGroupCount,
  type SplitMove,
} from '../../model/split';

const FALLBACK = { fallbackTitle: (index: number): string => `分组 ${index + 1}` };

/** 拆板时的源板路径：写进子板的 `meta.parent`，面包屑（`F2-8-4`）靠它 */
const SOURCE_PATH = 'Boards/源板.nboard';

/** 工厂的 id 是随机 ULID；测试要按 id 断言，所以建好之后覆盖掉 */
function columnFixture(id: string, title: string, x: number, z: number): Column {
  const column = createColumn({ title, x, y: 0, z });
  column.id = id;
  return column;
}

function cardFixture(id: string, columnId: string | null, x = 0, y = 0): Card {
  const card = createCard('note', { id, x, y, content: { md: id } });
  card.columnId = columnId;
  return card;
}

/** 两个有内容的分栏 + 一个空栏 + 一张散卡：覆盖"该迁的 / 不该迁的 / 留原地的" */
function boardFixture(): BoardFile {
  return createBoardFile({
    columns: [
      columnFixture('col_a', '甲', 1000, 1),
      columnFixture('col_b', '乙', 2000, 2),
      columnFixture('col_empty', '', 3000, 3),
    ],
    cards: [
      cardFixture('c1', 'col_a', 1016, 96),
      cardFixture('c2', 'col_a', 1016, 216),
      cardFixture('c3', 'col_b', 2016, 96),
      cardFixture('c4', null, 5000, 5000),
    ],
  });
}

function movesOf(board: BoardFile): SplitMove[] {
  return splitBoardPlan(board, FALLBACK).children.map((child, index) => ({
    ...child,
    path: `Boards/子板${index + 1}.nboard`,
  }));
}

describe('拆板计划', () => {
  it('优先按分栏拆，空栏不迁（迁出去只会多一个空文件）', () => {
    const plan = splitBoardPlan(boardFixture(), FALLBACK);

    expect(plan.ready).toBe(true);
    expect(plan.children.map((child) => child.title)).toEqual(['甲', '乙']);
    expect(plan.children.map((child) => child.columnId)).toEqual(['col_a', 'col_b']);
    expect(plan.children[0].cardIds).toEqual(['c1', 'c2']);
    // 白板卡要插在"内容原来的位置"，所以锚点取自栏的坐标
    expect(plan.children[0].anchor).toEqual({ x: 1000, y: 0 });
    // 既不在任何分栏里的散卡留在原板
    expect(plan.remainingCardIds).toEqual(['c4']);
  });

  it('分栏没标题时用调用方给的兜底名（模型层不碰 i18n）', () => {
    const board = createBoardFile({
      columns: [columnFixture('col_a', '', 0, 1), columnFixture('col_b', '   ', 400, 2)],
      cards: [cardFixture('c1', 'col_a'), cardFixture('c2', 'col_b')],
    });

    expect(splitBoardPlan(board, FALLBACK).children.map((child) => child.title)).toEqual([
      '分组 1',
      '分组 2',
    ]);
  });

  it('只切得出 1 组时不 ready —— 那叫搬家，不叫拆分', () => {
    const board = createBoardFile({
      columns: [columnFixture('col_a', '甲', 0, 1)],
      cards: [cardFixture('c1', 'col_a')],
    });

    const plan = splitBoardPlan(board, FALLBACK);
    expect(plan.children).toHaveLength(1);
    expect(plan.ready).toBe(false);
  });

  it('分栏全空时退化成按块切分（大板总得有条出路）', () => {
    const board = createBoardFile({
      columns: [columnFixture('col_a', '甲', 0, 1)],
      cards: [cardFixture('c1', null, 0, 0), cardFixture('c2', null, 400, 0)],
    });

    const plan = splitBoardPlan(board, FALLBACK);
    expect(plan.children.map((child) => child.columnId)).toEqual([null]);
    expect(plan.children[0].cardIds).toEqual(['c1', 'c2']);
  });

  it('完全没有分栏时按块大小切，且块大小是固定的', () => {
    const cards = Array.from({ length: SPLIT_CHUNK_SIZE + 1 }, (_, index) =>
      cardFixture(`c${index}`, null, index * 10, 0),
    );
    const plan = splitBoardPlan(createBoardFile({ cards }), FALLBACK);

    expect(plan.ready).toBe(true);
    expect(plan.children).toHaveLength(2);
    expect(plan.children[0].cardIds).toHaveLength(SPLIT_CHUNK_SIZE);
    expect(plan.children[1].cardIds).toHaveLength(1);
  });

  it('splitGroupCount 只数不建计划，结论与计划一致', () => {
    expect(splitGroupCount(boardFixture())).toBe(2); // 空栏不算组
    expect(splitGroupCount(createBoardFile({}))).toBe(0);

    const loose = Array.from({ length: SPLIT_CHUNK_SIZE * 2 }, (_, index) =>
      cardFixture(`c${index}`, null),
    );
    expect(splitGroupCount(createBoardFile({ cards: loose }))).toBe(2);
  });
});

describe('子板构建', () => {
  it('只带走本栏卡片，几何回到原点附近，且不继承折叠态', () => {
    const board = boardFixture();
    const [childA] = splitBoardPlan(board, FALLBACK).children;
    const childBoard = buildSplitChildBoard(board, childA, '甲', SOURCE_PATH);

    expect(childBoard.cards.map((card) => card.id)).toEqual(['c1', 'c2']);
    expect(childBoard.columns.map((column) => column.id)).toEqual(['col_a']);
    // ★ 原板可能因为"太大"被默认折叠，子板是小板，打开就该看到内容
    expect(childBoard.columns[0].collapsed).toBe(false);
    expect(childBoard.meta.title).toBe('甲');
    // ★ 子板挂回源板（T1.61）：进子板的面包屑该是「源板 → 子板」，`⌘U` 该回得去
    expect(childBoard.meta.parent).toBe(SOURCE_PATH);

    // 原栏在 x=1000：内容整体平移回来，否则新板一打开是一片空白
    for (const card of childBoard.cards) {
      expect(card.x).toBeGreaterThanOrEqual(0);
      expect(card.y).toBeGreaterThanOrEqual(0);
    }
    expect(childBoard.cards[0].x).toBeLessThan(200);
    // 但**相对布局不变**：两卡的间距与原来一致
    expect(childBoard.cards[1].y - childBoard.cards[0].y).toBe(216 - 96);
  });

  it('原栏折叠着也不影响子板', () => {
    const board = boardFixture();
    setColumnCollapsed(board, 'col_a', true);

    const [childA] = splitBoardPlan(board, FALLBACK).children;
    expect(buildSplitChildBoard(board, childA, '甲', SOURCE_PATH).columns[0].collapsed).toBe(false);
  });

  it('只保留两端都还在的连线；自由端连线不当作悬空', () => {
    const board = createBoardFile({
      columns: [columnFixture('col_a', '甲', 0, 1), columnFixture('col_b', '乙', 800, 2)],
      cards: [cardFixture('c1', 'col_a'), cardFixture('c2', 'col_a'), cardFixture('c3', 'col_b')],
      edges: [
        createEdge({ cardId: 'c1', side: 'right' }, { cardId: 'c2', side: 'left' }),
        createEdge({ cardId: 'c2', side: 'right' }, { cardId: 'c3', side: 'left' }),
        createEdge(
          { cardId: '', side: null, point: { x: -100, y: 0 } },
          { cardId: 'c1', side: 'top' },
        ),
      ],
    });

    const [childA] = splitBoardPlan(board, FALLBACK).children;
    const childBoard = buildSplitChildBoard(board, childA, '甲', SOURCE_PATH);

    expect(childBoard.edges.map((edge) => edge.id)).toEqual([board.edges[0].id, board.edges[2].id]);
  });

  it('只保留整组都在子板里的编组（半个编组比没有编组更让人困惑）', () => {
    const board = createBoardFile({
      columns: [columnFixture('col_a', '甲', 0, 1), columnFixture('col_b', '乙', 800, 2)],
      cards: [cardFixture('c1', 'col_a'), cardFixture('c2', 'col_a'), cardFixture('c3', 'col_b')],
      groups: [createGroup(['c1', 'c2'], '甲组'), createGroup(['c2', 'c3'], '跨板组')],
    });

    const [childA] = splitBoardPlan(board, FALLBACK).children;
    const childBoard = buildSplitChildBoard(board, childA, '甲', SOURCE_PATH);

    expect(childBoard.groups.map((group) => group.id)).toEqual([board.groups[0].id]);
  });

  it('与原板不共享卡片对象：改子板不能串改原板', () => {
    const board = boardFixture();
    const [childA] = splitBoardPlan(board, FALLBACK).children;
    const childBoard = buildSplitChildBoard(board, childA, '甲', SOURCE_PATH);

    childBoard.cards[0].x = 99999;
    expect(board.cards.find((card) => card.id === childBoard.cards[0].id)?.x).toBe(1016);
  });
});

describe('原板改造', () => {
  it('迁走的卡片与分栏消失，原位插上指向子板的白板卡', () => {
    const board = boardFixture();
    const moves = movesOf(board);
    applySplitToSource(board, moves);

    // 迁走的三张卡不在了；原板剩下 c4 + 两张新插的白板卡
    expect(board.cards.filter((card) => card.type === 'note').map((card) => card.id)).toEqual([
      'c4',
    ]);
    expect(board.columns.map((column) => column.id)).toEqual(['col_empty']);

    const refs = board.cards.filter((card) => card.type === 'boardRef');
    expect(refs).toHaveLength(2);
    expect(refs.map((card) => (card.content as { path: string }).path)).toEqual([
      'Boards/子板1.nboard',
      'Boards/子板2.nboard',
    ]);
    // 原位插入：白板卡落在被迁走的那一栏原来的位置
    expect(refs.map((card) => ({ x: card.x, y: card.y }))).toEqual([
      { x: 1000, y: 0 },
      { x: 2000, y: 0 },
    ]);
    // 白板卡要显示标题，否则用户在原板上只看到两张没有说明的卡
    expect(refs.every((card) => card.showTitle)).toBe(true);
  });

  it('不留下悬空连线，也不留下指向已删卡片的编组成员', () => {
    const board = createBoardFile({
      columns: [columnFixture('col_a', '甲', 0, 1), columnFixture('col_b', '乙', 800, 2)],
      cards: [
        cardFixture('c1', 'col_a'),
        cardFixture('c2', 'col_a'),
        cardFixture('c3', 'col_b'),
        cardFixture('c4', null),
      ],
      edges: [
        createEdge({ cardId: 'c1', side: 'right' }, { cardId: 'c2', side: 'left' }),
        createEdge({ cardId: 'c2', side: 'right' }, { cardId: 'c3', side: 'left' }),
        createEdge({ cardId: 'c3', side: 'right' }, { cardId: 'c4', side: 'left' }),
      ],
      groups: [createGroup(['c1', 'c3'], '跨组'), createGroup(['c3', 'c4'], '乙组')],
    });

    applySplitToSource(board, movesOf(board));

    const alive = new Set(board.cards.map((card) => card.id));
    for (const edge of board.edges) {
      if (edge.from.cardId !== '') expect(alive.has(edge.from.cardId)).toBe(true);
      if (edge.to.cardId !== '') expect(alive.has(edge.to.cardId)).toBe(true);
    }
    for (const group of board.groups) {
      for (const id of group.cardIds) expect(alive.has(id)).toBe(true);
    }
    // 四条卡里三条被迁走，原板只剩 c4（外加上两张白板卡）
    expect(board.cards.filter((card) => card.type === 'note').map((card) => card.id)).toEqual([
      'c4',
    ]);
  });

  it('多张白板卡挤在同一原位时依次错开（不叠成一张）', () => {
    // 两栏坐标相同：按块切分时也共用同一个左上角
    const board = createBoardFile({
      columns: [columnFixture('col_a', '甲', 500, 1), columnFixture('col_b', '乙', 500, 2)],
      cards: [cardFixture('c1', 'col_a'), cardFixture('c2', 'col_b')],
    });

    applySplitToSource(board, movesOf(board));

    const refs = board.cards.filter((card) => card.type === 'boardRef');
    expect(refs).toHaveLength(2);
    expect(refs[0].y).not.toBe(refs[1].y);
  });
});
