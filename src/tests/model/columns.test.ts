/**
 * 分栏模型层（T1.54–T1.60）的回归。
 *
 * 重点盯三类容易错的地方：
 *  1. **幂等**：`layoutColumn` 第二次调用必须返回 `false` —— 否则每次 commit 都会
 *     把整份文件标脏、递增 revision（`ops.ts` 顶部那两条纪律）。
 *  2. **成员画在栏之上**：`z` 的规则写错不会报错，只会让卡片"藏"在栏底下一闪。
 *  3. **落点**：插入 index 差一位，用户就会看到插入线画在自己手指的另一侧。
 */

import { describe, expect, it } from 'vitest';
import {
  COLUMN_LAYOUT,
  alignSiblingColumns,
  applyColumnRects,
  cardsInColumn,
  collapsedColumnCardIds,
  columnById,
  columnContentBox,
  columnContentHeight,
  columnDisplayHeight,
  columnMoveRects,
  columnResizeRects,
  createColumnAt,
  detachCards,
  findDropTarget,
  growColumnToFit,
  groupIntoNewColumn,
  groupOccupyingColumn,
  groupTargetsOf,
  insertCardsIntoColumn,
  layoutColumn,
  layoutRects,
  measureColumns,
  relayoutColumns,
  releaseColumn,
  removeColumn,
  setColumnCollapsed,
  shrinkColumnToFit,
  siblingColumnsOf,
  soleColumnOf,
  splitIntoColumns,
  visibleCardsInColumn,
  wholeColumnOf,
} from '../../model/columns';
import {
  collapsedCardIds,
  groupBounds,
  groupCards,
  groupOfCard,
  setGroupCollapsed,
} from '../../model/ops';
import { createBoardFile, createCard, createColumn, createEdge } from '../../model/factories';
import type { Column } from '../../model/schema';

/** 一张 280×180 的便签卡（尺寸与 `DEFAULT_CARD_SIZES.note` 一致） */
function note(id: string, x: number, y: number) {
  return { ...createCard('note', { x, y, title: id }), id };
}

/**
 * 固定 id 的分栏。
 *
 * ★ 不把 `id` 加进 `createColumn` 的入参：`createCard` / `createEdge` 都刻意不让调用方
 *   伪造 id（id 归工厂签发），只给分栏开后门会让三个工厂长出三套规矩。
 *   这里需要固定 id 纯粹是测试诉求 —— `columnById(board, 'col1')` 比断言一个随机 id 可读得多，
 *   所以在测试里就地补一个（`note()` 对卡片是同一种做法）。
 */
function makeColumn(overrides: Partial<Column> & { id: string }): Column {
  const { id, ...rest } = overrides;
  return { ...createColumn(rest), id };
}

function boardWith(columns: ReturnType<typeof createColumn>[], cards: ReturnType<typeof note>[]) {
  return createBoardFile({ columns, cards });
}

/** `count` 张等高卡全归 `col1`：用来把分栏内容撑到 `maxAutoHeight` 以上（T2.03） */
function tallCards(count: number, height = 150) {
  return Array.from({ length: count }, (_, index) => ({
    ...note(`c${index}`, 0, 0),
    columnId: 'col1',
    order: index,
    height,
  }));
}

describe('createColumnAt', () => {
  it('新栏的 z 高于画布上所有元素（否则会被压在底下，看起来像没建成功）', () => {
    const board = boardWith([], [note('c1', 0, 0)]);
    const column = createColumnAt(board, 10, 20);
    expect(column.z).toBeGreaterThan(board.cards[0].z);
    expect(board.columns).toHaveLength(1);
    expect(column.x).toBe(10);
    expect(column.y).toBe(20);
  });

  it('覆盖项优先级高于默认值（宽度 / 标题）', () => {
    const board = boardWith([], []);
    const column = createColumnAt(board, 0, 0, { width: 500, title: '灵感' });
    expect(column.width).toBe(500);
    expect(column.title).toBe('灵感');
  });

  it('连续建两个栏，z 递增', () => {
    const board = boardWith([], []);
    const a = createColumnAt(board, 0, 0);
    const b = createColumnAt(board, 400, 0);
    expect(b.z).toBeGreaterThan(a.z);
  });
});

describe('layoutColumn', () => {
  it('成员宽度 = 栏宽 - 2×内边距，x 贴着内容盒左边界', () => {
    const column = makeColumn({ id: 'col1', x: 100, y: 200, width: 320 });
    const board = boardWith([column], [{ ...note('c1', 0, 0), columnId: 'col1', order: 0 }]);

    expect(layoutColumn(board, 'col1')).toBe(true);
    const card = board.cards[0];
    expect(card.x).toBe(100 + COLUMN_LAYOUT.padding);
    expect(card.width).toBe(320 - COLUMN_LAYOUT.padding * 2);
  });

  it('按 order 从上往下堆叠，间距 = COLUMN_LAYOUT.gap', () => {
    const column = makeColumn({ id: 'col1', x: 0, y: 0, width: 320 });
    const board = boardWith(
      [column],
      [
        { ...note('c2', 0, 0), columnId: 'col1', order: 1, height: 100 },
        { ...note('c1', 0, 0), columnId: 'col1', order: 0, height: 180 },
      ],
    );

    layoutColumn(board, 'col1');
    const [c1, c2] = [
      board.cards.find((c) => c.id === 'c1')!,
      board.cards.find((c) => c.id === 'c2')!,
    ];
    const top = COLUMN_LAYOUT.headerHeight + COLUMN_LAYOUT.headerGap;
    expect(c1.y).toBe(top);
    expect(c2.y).toBe(top + 180 + COLUMN_LAYOUT.gap);
  });

  it('★ 第二次调用返回 false（幂等，不能每次 commit 都写一遍文件）', () => {
    const column = makeColumn({ id: 'col1', x: 0, y: 0 });
    const board = boardWith([column], [{ ...note('c1', 0, 0), columnId: 'col1', order: 0 }]);

    expect(layoutColumn(board, 'col1')).toBe(true);
    expect(layoutColumn(board, 'col1')).toBe(false);
    expect(relayoutColumns(board)).toBe(false);
  });

  it('把 order 压成密排（删掉中间一张后不留空洞）', () => {
    const column = makeColumn({ id: 'col1' });
    const board = boardWith(
      [column],
      [
        { ...note('c1', 0, 0), columnId: 'col1', order: 0 },
        { ...note('c2', 0, 0), columnId: 'col1', order: 7 },
      ],
    );

    layoutColumn(board, 'col1');
    expect(cardsInColumn(board, 'col1').map((card) => card.order)).toEqual([0, 1]);
  });

  it('分栏不存在时返回 false，不做任何事', () => {
    const board = boardWith([], []);
    expect(layoutColumn(board, 'nope')).toBe(false);
  });
});

describe('relayoutColumns', () => {
  it('★ 成员高度变了之后，它下面的卡片跟着下移（派生状态的兜底）', () => {
    const column = makeColumn({ id: 'col1', x: 0, y: 0 });
    const board = boardWith(
      [column],
      [
        { ...note('c1', 0, 0), columnId: 'col1', order: 0, height: 100 },
        { ...note('c2', 0, 0), columnId: 'col1', order: 1, height: 100 },
      ],
    );

    layoutColumn(board, 'col1');
    const before = board.cards.find((card) => card.id === 'c2')!.y;

    // 模拟自动高度（T1.38）把第一张撑高了
    board.cards.find((card) => card.id === 'c1')!.height = 300;
    expect(relayoutColumns(board)).toBe(true);
    expect(board.cards.find((card) => card.id === 'c2')!.y).toBe(before + 200);
  });
});

describe('insertCardsIntoColumn', () => {
  it('设置归属与 order；全部相等时返回 false', () => {
    const column = makeColumn({ id: 'col1' });
    const board = boardWith([column], [note('c1', 0, 0)]);

    expect(insertCardsIntoColumn(board, ['c1'], 'col1', 0)).toBe(true);
    expect(board.cards[0].columnId).toBe('col1');
    expect(insertCardsIntoColumn(board, ['c1'], 'col1', 0)).toBe(false);
  });

  it('★ 进栏的卡片角度归 0，而且是**删键**（用户 2026-09-17）', () => {
    const column = makeColumn({ id: 'col1' });
    const rotated = { ...note('c1', 0, 0), rotation: 45 };
    const board = boardWith([column], [rotated]);

    expect(insertCardsIntoColumn(board, ['c1'], 'col1', 0)).toBe(true);
    expect('rotation' in board.cards[0]).toBe(false);
  });

  it('★ 只归零**这一次进来的**那张：栏内已有的历史角度不动（要掰正用「重置角度」）', () => {
    const column = makeColumn({ id: 'col1' });
    const inside = { ...note('c1', 0, 0), columnId: 'col1', rotation: 30 };
    const incoming = { ...note('c2', 0, 0), rotation: 45 };
    const board = boardWith([column], [inside, incoming]);

    expect(insertCardsIntoColumn(board, ['c2'], 'col1', 1)).toBe(true);
    expect(board.cards.find((card) => card.id === 'c1')?.rotation).toBe(30);
    const arrived = board.cards.find((card) => card.id === 'c2');
    expect(arrived !== undefined && 'rotation' in arrived).toBe(false);
  });

  it('★ 成员的 z 必须高于分栏（否则卡片会藏在栏的背景底下）', () => {
    const column = makeColumn({ id: 'col1', z: 100 });
    const board = boardWith([column], [{ ...note('c1', 0, 0), z: 50 }]);

    insertCardsIntoColumn(board, ['c1'], 'col1', 0);
    expect(board.cards[0].z).toBeGreaterThan(column.z);
  });

  it('★ 已经画在栏之上的卡片不再被提升 z（避免每次重排都写出新的 z 把 diff 弄花）', () => {
    const column = makeColumn({ id: 'col1', z: 10 });
    const board = boardWith([column], [{ ...note('c1', 0, 0), z: 900 }]);

    insertCardsIntoColumn(board, ['c1'], 'col1', 0);
    expect(board.cards[0].z).toBe(900);
  });

  it('多选整批插入时保持它们之间的相对次序', () => {
    const column = makeColumn({ id: 'col1' });
    const board = boardWith(
      [column],
      [
        { ...note('a', 0, 0), columnId: 'col1', order: 0 },
        { ...note('b', 0, 0), columnId: 'col1', order: 1 },
        note('x', 0, 0),
        note('y', 0, 0),
      ],
    );

    // 插到 b 之前 → a, x, y, b
    insertCardsIntoColumn(board, ['x', 'y'], 'col1', 1);
    expect(cardsInColumn(board, 'col1').map((card) => card.id)).toEqual(['a', 'x', 'y', 'b']);
  });

  it('index 越界会被钳到合法范围（不产生跳位的空档）', () => {
    const column = makeColumn({ id: 'col1' });
    const board = boardWith(
      [column],
      [{ ...note('a', 0, 0), columnId: 'col1', order: 0 }, note('x', 0, 0)],
    );

    insertCardsIntoColumn(board, ['x'], 'col1', 99);
    expect(cardsInColumn(board, 'col1').map((card) => card.id)).toEqual(['a', 'x']);
  });

  it('跨栏搬运：来源栏也跟着收拢', () => {
    const a = makeColumn({ id: 'colA', x: 0, y: 0 });
    const b = makeColumn({ id: 'colB', x: 400, y: 0 });
    const board = boardWith(
      [a, b],
      [
        { ...note('c1', 0, 0), columnId: 'colA', order: 0, height: 100 },
        { ...note('c2', 0, 0), columnId: 'colA', order: 1, height: 100 },
      ],
    );

    insertCardsIntoColumn(board, ['c1'], 'colB', 0);
    expect(cardsInColumn(board, 'colA').map((card) => card.id)).toEqual(['c2']);
    expect(cardsInColumn(board, 'colA')[0].order).toBe(0);
    // c2 顶到第一格
    expect(cardsInColumn(board, 'colA')[0].y).toBe(
      COLUMN_LAYOUT.headerHeight + COLUMN_LAYOUT.headerGap,
    );
  });

  it('不存在的分栏 / 空的 id 列表都是安全的空操作', () => {
    const board = boardWith([makeColumn({ id: 'col1' })], [note('c1', 0, 0)]);
    expect(insertCardsIntoColumn(board, ['c1'], 'nope', 0)).toBe(false);
    expect(insertCardsIntoColumn(board, [], 'col1', 0)).toBe(false);
    expect(insertCardsIntoColumn(board, ['ghost'], 'col1', 0)).toBe(false);
  });
});

describe('detachCards', () => {
  it('解除归属后几何原地保留（视觉上就是"拖出来放开"）', () => {
    const column = makeColumn({ id: 'col1', x: 0, y: 0 });
    const board = boardWith([column], [{ ...note('c1', 0, 0), columnId: 'col1', order: 0 }]);
    layoutColumn(board, 'col1');
    const { x, y } = board.cards[0];

    expect(detachCards(board, ['c1'])).toBe(true);
    expect(board.cards[0].columnId).toBeNull();
    expect(board.cards[0].x).toBe(x);
    expect(board.cards[0].y).toBe(y);
    expect(detachCards(board, ['c1'])).toBe(false);
  });
});

describe('removeColumn', () => {
  it('release（默认）：卡片留在画布上，栏消失', () => {
    const column = makeColumn({ id: 'col1' });
    const board = boardWith([column], [{ ...note('c1', 0, 0), columnId: 'col1', order: 0 }]);

    expect(removeColumn(board, 'col1')).toBe(true);
    expect(board.columns).toHaveLength(0);
    expect(board.cards).toHaveLength(1);
    expect(board.cards[0].columnId).toBeNull();
  });

  it('delete：连卡片一起删', () => {
    const column = makeColumn({ id: 'col1' });
    const board = boardWith([column], [{ ...note('c1', 0, 0), columnId: 'col1', order: 0 }]);

    expect(removeColumn(board, 'col1', 'delete')).toBe(true);
    expect(board.cards).toHaveLength(0);
  });

  it('不存在的栏返回 false', () => {
    expect(removeColumn(boardWith([], []), 'nope')).toBe(false);
  });

  it('★ 指着这一栏的连线一并删掉（O21）：栏一消失，那些线取不到端点，留着就是幽灵边', () => {
    const column = makeColumn({ id: 'col1' });
    const board = boardWith([column], [note('c1', 0, 0), note('c2', 400, 0)]);
    // 指向栏的（两个方向各一条）+ 与这一栏无关的一条
    const outbound = createEdge({ cardId: 'c1', side: null }, { cardId: 'col1', side: null });
    const inbound = createEdge({ cardId: 'col1', side: null }, { cardId: 'c2', side: null });
    const unrelated = createEdge({ cardId: 'c1', side: null }, { cardId: 'c2', side: null });
    board.edges = [outbound, inbound, unrelated];

    expect(removeColumn(board, 'col1')).toBe(true);
    expect(board.edges.map((edge) => edge.id)).toEqual([unrelated.id]);
  });

  it('★ delete 模式同样清连线（卡片也没了，就更留不住线）', () => {
    const board = boardWith([makeColumn({ id: 'col1' })], [note('c1', 0, 0)]);
    board.edges = [createEdge({ cardId: 'c1', side: null }, { cardId: 'col1', side: null })];

    expect(removeColumn(board, 'col1', 'delete')).toBe(true);
    expect(board.edges).toEqual([]);
  });
});

describe('setColumnCollapsed', () => {
  it('★ 只改 collapsed，不动 height（展开时要回到用户拖出来的高度）', () => {
    const column = makeColumn({ id: 'col1', height: 777 });
    const board = boardWith([column], []);

    expect(setColumnCollapsed(board, 'col1', true)).toBe(true);
    expect(column.collapsed).toBe(true);
    expect(column.height).toBe(777);
    expect(columnDisplayHeight(column)).toBe(COLUMN_LAYOUT.collapsedHeight);
    expect(setColumnCollapsed(board, 'col1', true)).toBe(false);
  });
});

describe('columnContentHeight / growColumnToFit', () => {
  it('空栏也给一块能放东西的高度（否则第一张卡拖不进去）', () => {
    const column = makeColumn({ id: 'col1', height: 500 });
    const board = boardWith([column], []);
    expect(columnContentHeight(board, column)).toBe(160);
  });

  it('多张卡：标题栏 + 间距 + 各卡高 + 底部内边距', () => {
    const column = makeColumn({ id: 'col1' });
    const board = boardWith(
      [column],
      [
        { ...note('c1', 0, 0), columnId: 'col1', order: 0, height: 180 },
        { ...note('c2', 0, 0), columnId: 'col1', order: 1, height: 100 },
      ],
    );
    const { headerHeight, headerGap, padding, gap } = COLUMN_LAYOUT;
    // 标题栏 + 间距 + 卡 + 卡间 gap + 卡 + 底部内边距
    expect(columnContentHeight(board, column)).toBe(
      headerHeight + headerGap + 180 + gap + 100 + padding,
    );
  });

  it('growColumnToFit 只增不减（不跟用户拖出来的尺寸打架）', () => {
    const column = makeColumn({ id: 'col1', height: 500 });
    const board = boardWith([column], [{ ...note('c1', 0, 0), columnId: 'col1', order: 0 }]);

    expect(growColumnToFit(board, 'col1')).toBe(false); // 500 已经够
    expect(growColumnToFit(board, 'col1', 800)).toBe(true);
    expect(column.height).toBe(800);
  });

  it('★ 按内容撑高封顶在 maxAutoHeight，超出的部分靠栏内滚动（T2.03）', () => {
    const column = makeColumn({ id: 'col1', height: 200 });
    const board = boardWith([column], tallCards(12));
    // 内容确实远超上限：不封顶的话，一张 200 卡的栏会长到 9000px 高
    expect(columnContentHeight(board, column)).toBeGreaterThan(COLUMN_LAYOUT.maxAutoHeight);

    expect(growColumnToFit(board, 'col1')).toBe(true);
    expect(column.height).toBe(COLUMN_LAYOUT.maxAutoHeight);
  });

  it('★ 用户手动拖出来的高度不受封顶约束（先给内容封顶，再与 minHeight 取大）', () => {
    const column = makeColumn({ id: 'col1', height: 200 });
    const board = boardWith([column], tallCards(12));

    expect(growColumnToFit(board, 'col1', 2000)).toBe(true);
    expect(column.height).toBe(2000);
  });
});

describe('shrinkColumnToFit（O05：内容变少时把栏收下来）', () => {
  it('★ 自动撑高的栏正好收到新的内容高度（栏里不留空白）', () => {
    const column = makeColumn({ id: 'col1', height: 200 });
    const board = boardWith([column], tallCards(2, 150));
    const before = columnContentHeight(board, column);
    growColumnToFit(board, 'col1');
    expect(column.height).toBe(before);

    board.cards.pop(); // 下面那张被删了
    expect(shrinkColumnToFit(board, 'col1', before)).toBe(true);
    // 一张卡 150 + 一个间隙 10 —— 正好是腾出来的那一截
    expect(column.height).toBe(before - (150 + COLUMN_LAYOUT.gap));
    expect(column.height).toBe(columnContentHeight(board, column));
  });

  it('★ 用户拖出来的余量原样留着：只收掉"内容少掉的那一截"', () => {
    const column = makeColumn({ id: 'col1', height: 600 });
    const board = boardWith([column], tallCards(2, 150));
    const before = columnContentHeight(board, column); // 内容远矮于 600：多出来的是用户拖的

    board.cards.pop();
    expect(shrinkColumnToFit(board, 'col1', before)).toBe(true);
    expect(column.height).toBe(600 - (150 + COLUMN_LAYOUT.gap));
  });

  it('内容没变少 → 不碰（点进点出不该把栏弄矮）', () => {
    const column = makeColumn({ id: 'col1', height: 500 });
    const board = boardWith([column], tallCards(2, 150));
    const before = columnContentHeight(board, column);

    expect(shrinkColumnToFit(board, 'col1', before)).toBe(false);
    expect(column.height).toBe(500);
  });

  it('★ 只往下收：比内容还矮的栏不会被它拉高（长高是 grow 的活）', () => {
    const column = makeColumn({ id: 'col1', height: 120 });
    const board = boardWith([column], tallCards(3, 150));
    const before = columnContentHeight(board, column);

    expect(shrinkColumnToFit(board, 'col1', before)).toBe(false);
    expect(column.height).toBe(120);
  });

  it('内容再少也不低于 minHeight（栏矮到只剩标题就没法用了）', () => {
    const column = makeColumn({ id: 'col1', height: 300 });
    const board = boardWith(
      [column],
      [{ ...note('c1', 0, 0), columnId: 'col1', order: 0, height: 60 }],
    );
    // 一张 60 高的卡撑出来的内容高只有 118（比下限还矮），所以收到下限为止
    expect(shrinkColumnToFit(board, 'col1', 300)).toBe(true);
    expect(column.height).toBe(COLUMN_LAYOUT.minHeight);
  });

  it('折叠的栏不参与（它的显示高度是标题栏那么高，与内容无关）', () => {
    const column = makeColumn({ id: 'col1', height: 400, collapsed: true });
    const board = boardWith([column], []);

    expect(shrinkColumnToFit(board, 'col1', 400)).toBe(false);
    expect(column.height).toBe(400);
  });

  it('未知 id → false', () => {
    const board = boardWith([makeColumn({ id: 'col1' })], []);
    expect(shrinkColumnToFit(board, 'ghost', 400)).toBe(false);
  });
});

describe('收起的编组不占栏内位置（O05）', () => {
  /** 一栏三张等高卡，前两张编成一个组并**收起** */
  function columnWithCollapsedGroup() {
    const column = makeColumn({ id: 'col1', height: 200 });
    const board = boardWith(
      [column],
      [0, 1, 2].map((index) => ({
        ...note(`c${index + 1}`, 0, 0),
        columnId: 'col1',
        order: index,
        height: 150,
      })),
    );
    const groupId = groupCards(board, ['c1', 'c2']);
    setGroupCollapsed(board, groupId!, true);
    return { board, column };
  }

  it('★ 内容总高只算看得见的那张（否则收起编组后栏里空出一大截）', () => {
    const { board, column } = columnWithCollapsedGroup();
    const { headerHeight, headerGap, padding } = COLUMN_LAYOUT;

    expect(visibleCardsInColumn(board, 'col1').map((card) => card.id)).toEqual(['c3']);
    expect(columnContentHeight(board, column)).toBe(headerHeight + headerGap + 150 + padding);
  });

  it('★ 收起的成员不推进堆叠光标：下面那张卡直接挪到栏顶', () => {
    const { board, column } = columnWithCollapsedGroup();
    const top = columnContentBox(column).top;
    const byId = new Map(layoutRects(board, column).map((rect) => [rect.id, rect]));

    // 三张都停在内容盒顶：收起的那两张不占地方，第三张也不被它们推下去
    expect(byId.get('c1')!.y).toBe(top);
    expect(byId.get('c2')!.y).toBe(top);
    expect(byId.get('c3')!.y).toBe(top);
  });

  it('成员关系与 order 都留着：展开后原地归位', () => {
    const { board } = columnWithCollapsedGroup();
    expect(cardsInColumn(board, 'col1').map((card) => card.id)).toEqual(['c1', 'c2', 'c3']);

    setGroupCollapsed(board, board.groups[0].id, false);
    const ys = layoutRects(board, columnById(board, 'col1')!).map((rect) => rect.y);
    expect(ys[0]).toBe(columnContentBox(columnById(board, 'col1')!).top);
    expect(ys[2]).toBeGreaterThan(ys[0]);
  });

  it('张数与内容底边也不含收起的成员（栏标题上的数字要与看得见的一致）', () => {
    const { board } = columnWithCollapsedGroup();
    // 收起的那两张**比看得见的那张高得多**：算进去的话，滚动条会比内容长一截
    for (const card of board.cards) if (card.id !== 'c3') card.height = 400;
    relayoutColumns(board);

    const { counts, bottoms } = measureColumns(board);
    expect(counts.get('col1')).toBe(1);
    expect(bottoms.get('col1')).toBe(columnContentBox(columnById(board, 'col1')!).top + 150);
  });

  it('没编组时不计这一趟（快路径：`collapsedCardIds` 为空就不复制数组）', () => {
    const column = makeColumn({ id: 'col1' });
    const board = boardWith([column], tallCards(2, 150));

    expect(visibleCardsInColumn(board, 'col1')).toHaveLength(2);
    expect(measureColumns(board).counts.get('col1')).toBe(2);
  });
});

describe('groupIntoNewColumn（T1.59）', () => {
  it('按当前视觉顺序（上→下）入栏，高度按内容撑开', () => {
    const board = boardWith(
      [],
      [
        { ...note('low', 0, 300), height: 100 },
        { ...note('high', 0, 0), height: 100 },
      ],
    );

    const id = groupIntoNewColumn(board, ['low', 'high']);
    expect(id).not.toBeNull();
    expect(cardsInColumn(board, id!).map((card) => card.id)).toEqual(['high', 'low']);
    expect(columnById(board, id!)!.height).toBeGreaterThanOrEqual(200);
  });

  it('新栏覆盖选中卡片的外接矩形（用户的选区就是他们心里的那一栏）', () => {
    const board = boardWith([], [{ ...note('c1', 100, 200), width: 300, height: 150 }]);
    const id = groupIntoNewColumn(board, ['c1'])!;
    const column = columnById(board, id)!;

    expect(column.x).toBe(100 - COLUMN_LAYOUT.padding);
    expect(column.width).toBe(300 + COLUMN_LAYOUT.padding * 2);
  });

  it('空选区返回 null', () => {
    expect(groupIntoNewColumn(boardWith([], []), [])).toBeNull();
    expect(groupIntoNewColumn(boardWith([], []), ['ghost'])).toBeNull();
  });
});

describe('splitIntoColumns（T1.58 / ⌘Enter）', () => {
  it('一卡一栏，从左到右并排，顶部对齐', () => {
    const board = boardWith(
      [],
      [
        { ...note('a', 0, 50), height: 100 },
        { ...note('b', 0, 300), height: 100 },
      ],
    );

    const ids = splitIntoColumns(board, ['a', 'b']);
    expect(ids).toHaveLength(2);
    const [left, right] = ids.map((id) => columnById(board, id)!);
    expect(left.y).toBe(50);
    expect(right.y).toBe(50);
    expect(right.x).toBeGreaterThan(left.x);
    expect(cardsInColumn(board, left.id).map((card) => card.id)).toEqual(['a']);
    expect(cardsInColumn(board, right.id).map((card) => card.id)).toEqual(['b']);
  });

  it('★ 拆开的是原来那个栏时，原栏被清掉（不留空壳）', () => {
    const column = makeColumn({ id: 'col1', x: 0, y: 0 });
    const board = boardWith(
      [column],
      [
        { ...note('a', 0, 0), columnId: 'col1', order: 0, height: 100 },
        { ...note('b', 0, 0), columnId: 'col1', order: 1, height: 100 },
      ],
    );

    const ids = splitIntoColumns(board, ['a', 'b']);
    expect(ids).toHaveLength(2);
    expect(columnById(board, 'col1')).toBeNull();
  });

  it('散落卡片被拆开后，来源栏（不存在）不会误删别的栏', () => {
    const other = makeColumn({ id: 'keep', x: 900, y: 0 });
    const board = boardWith([other], [note('a', 0, 0)]);
    splitIntoColumns(board, ['a']);
    expect(columnById(board, 'keep')).not.toBeNull();
  });

  it('空选区返回空数组', () => {
    expect(splitIntoColumns(boardWith([], []), [])).toEqual([]);
  });
});

describe('整栏转分组 / 空壳栏清理（O04）', () => {
  /**
   * 并排两栏（间隙 24 = `siblingGap`，所以是同级），左栏两张卡、右栏一张。
   * 建完先 `relayoutColumns` 一遍 —— 让成员真的落在栏里（`groupOccupyingColumn` 是几何判据）。
   */
  function twoColumns() {
    const board = boardWith(
      [
        makeColumn({ id: 'col1', x: 0, y: 0, width: 200, height: 300 }),
        makeColumn({ id: 'col2', x: 224, y: 0, width: 200, height: 300 }),
      ],
      [
        { ...note('a', 0, 0), columnId: 'col1', order: 0, height: 100 },
        { ...note('b', 0, 0), columnId: 'col1', order: 1, height: 100 },
        { ...note('c', 0, 0), columnId: 'col2', order: 0, height: 100 },
      ],
    );
    relayoutColumns(board);
    return board;
  }

  describe('wholeColumnOf', () => {
    it('选区恰好是整栏 → 返回那一栏', () => {
      const board = twoColumns();
      expect(wholeColumnOf(board, new Set(['a', 'b']))?.id).toBe('col1');
    });

    it('★ 多框了一张别处的卡片 → null（否则 ⌘A + ⌘G 会把板上所有分栏一次拆掉）', () => {
      const board = twoColumns();
      expect(wholeColumnOf(board, new Set(['a', 'b', 'c']))).toBeNull();
    });

    it('少选一张 → null（只覆盖一部分不算整栏）', () => {
      const board = twoColumns();
      expect(wholeColumnOf(board, new Set(['a']))).toBeNull();
    });

    it('★ 收起的组员也算数：判据是"栏目录里的成员"，不是"看得见的那几张"', () => {
      const board = twoColumns();
      // 把 a、b 收成一个组并折叠：屏幕上这一栏已经"空了"，栏目录里却还挂着两张
      const groupId = groupCards(board, ['a', 'b'])!;
      setGroupCollapsed(board, groupId, true);
      expect(visibleCardsInColumn(board, 'col1')).toEqual([]);
      expect(
        cardsInColumn(board, 'col1')
          .map((card) => card.id)
          .sort(),
      ).toEqual(['a', 'b']);
      // 只选"栏里看得见的那几张"（一张都没有）→ 判不出整栏，栏不会被动
      expect(wholeColumnOf(board, new Set())).toBeNull();
      expect(wholeColumnOf(board, new Set(['a']))).toBeNull();
      // 两张都选上 → 是整栏
      expect(wholeColumnOf(board, new Set(['a', 'b']))?.id).toBe('col1');
    });

    it('空栏 / 幽灵 id → null', () => {
      const board = boardWith([makeColumn({ id: 'empty' })], []);
      expect(wholeColumnOf(board, new Set())).toBeNull();
      const withGhost = twoColumns();
      expect(wholeColumnOf(withGhost, new Set(['a', 'b', 'ghost']))).toBeNull();
    });
  });

  describe('releaseColumn', () => {
    it('栏删掉，成员留在原地（几何本来就是按栏内位置算好的）', () => {
      const board = twoColumns();
      const before = board.cards.find((card) => card.id === 'a')!;
      const rect = { x: before.x, y: before.y };
      expect(releaseColumn(board, 'col1', { moveSiblings: false })).toBe(true);
      expect(columnById(board, 'col1')).toBeNull();
      const after = board.cards.find((card) => card.id === 'a')!;
      expect({ x: after.x, y: after.y }).toEqual(rect);
    });

    it('★ moveSiblings: false → 邻居一动不动（整栏转分组时这块地方由新组接着占）', () => {
      const board = twoColumns();
      releaseColumn(board, 'col1', { moveSiblings: false });
      expect(columnById(board, 'col2')!.x).toBe(224);
    });

    it('★ moveSiblings: true → 右侧同级合拢（宽度 + 实际间隙），成员跟着挪', () => {
      const board = twoColumns();
      releaseColumn(board, 'col1', { moveSiblings: true });
      // 0..200 这栏被删掉，224 起步的右邻补上：位移 200 + 实际间隙 24 = 224
      expect(columnById(board, 'col2')!.x).toBe(0);
      // 成员卡片是派生的：栏挪了，c 必须跟着挪（否则还画在老地方）
      expect(board.cards.find((card) => card.id === 'c')!.x).toBe(
        columnContentBox(columnById(board, 'col2')!).left,
      );
    });

    it('栏不存在 / 右边没有同级 → 不报错', () => {
      expect(releaseColumn(twoColumns(), 'nope', { moveSiblings: true })).toBe(false);
      const lone = boardWith([makeColumn({ id: 'only', x: 0, y: 0 })], []);
      expect(releaseColumn(lone, 'only', { moveSiblings: true })).toBe(true);
    });
  });

  describe('groupOccupyingColumn', () => {
    it('组落在栏里 → 返回那一栏', () => {
      const board = twoColumns();
      const groupId = groupCards(board, ['a', 'b'])!;
      expect(groupOccupyingColumn(board, 'col1')?.id).toBe(groupId);
    });

    it('★ 组被拖到别处 → null（这块地方是真的空了）', () => {
      const board = twoColumns();
      const groupId = groupCards(board, ['a', 'b'])!;
      for (const card of board.cards) {
        if (groupOfCard(board, card.id)?.id === groupId) {
          card.x = 900;
          card.y = 0;
        }
      }
      expect(groupOccupyingColumn(board, 'col1')).toBeNull();
    });

    it('栏不存在 → null', () => {
      const board = twoColumns();
      groupCards(board, ['a', 'b']);
      expect(groupOccupyingColumn(board, 'nope')).toBeNull();
    });
  });

  describe('编组收谁（`groupTargetsOf`，用户 2026-09-16）', () => {
    it('★ 框住一栏 ⇒ 那一栏的**全部成员**都进组（栏内卡片不在选区里，得由栏带出来）', () => {
      const board = twoColumns();
      expect(groupTargetsOf(board, [], ['col1']).sort()).toEqual(['a', 'b']);
    });

    it('★ 多栏 ⇒ 并成**一批**（多栏与多卡一样合成一个组）', () => {
      const board = twoColumns();
      // col1 = {a, b}、col2 = {c}：两栏的成员凑到一起，只去重（`c` 既在选区又在栏里）
      expect(groupTargetsOf(board, ['a', 'c'], ['col1', 'col2']).sort()).toEqual(['a', 'b', 'c']);
    });

    it('选中的卡片 + 选中的栏一起收（重复的只算一次）', () => {
      const board = twoColumns();
      // `a` 既在栏里又在选区里 —— 只该出现一次
      expect(groupTargetsOf(board, ['a'], ['col1']).sort()).toEqual(['a', 'b']);
    });

    it('幽灵卡片 / 不存在的栏都不带出任何东西（手改过的文件也不会凭空成组）', () => {
      const board = twoColumns();
      expect(groupTargetsOf(board, ['nope'], ['gone'])).toEqual([]);
    });
  });

  describe('移出最后一卡之后栏还在（用户 2026-09-16）', () => {
    it('★ 把一栏的卡片全拖出去 ⇒ 栏**保留**（"空壳栏自动清理"已按用户要求撤掉）', () => {
      const board = twoColumns();
      // 把这一栏的两张卡都拖走（脱离栏，几何落在别处）—— 从前这一步之后栏就没了
      detachCards(board, ['a', 'b']);
      for (const card of board.cards) {
        if (card.id === 'a' || card.id === 'b') card.x = 900;
      }
      relayoutColumns(board);

      expect(columnById(board, 'col1')).not.toBeNull();
      // 邻居**一动不动**：栏还在，那块地方压根不是空档（没有"合拢"这回事）
      expect(columnById(board, 'col2')!.x).toBe(224);
    });

    it('★ 空栏照旧能用：往里放一张卡就回到正常堆叠', () => {
      const board = twoColumns();
      detachCards(board, ['a', 'b']);
      relayoutColumns(board);

      expect(insertCardsIntoColumn(board, ['a'], 'col1', 0)).toBe(true);
      expect(cardsInColumn(board, 'col1').map((card) => card.id)).toEqual(['a']);
    });

    it('★ 只剩"显式删除"才会让栏消失：`removeColumn` 照旧', () => {
      const board = twoColumns();
      detachCards(board, ['a', 'b']);

      expect(removeColumn(board, 'col1', 'release')).toBe(true);
      expect(columnById(board, 'col1')).toBeNull();
    });
  });

  describe('groupBounds（O04：派生几何，不落盘）', () => {
    it('成员包围盒；组不存在 → null', () => {
      const board = twoColumns();
      const groupId = groupCards(board, ['a', 'b'])!;
      const bounds = groupBounds(board, groupId)!;
      // 两张卡都在左栏：包围盒必须落在左栏这一侧（不含框的留白与标签带）
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(200);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(300);
      expect(groupBounds(board, 'nope')).toBeNull();
    });
  });
});

describe('soleColumnOf', () => {
  it('全在同一个栏里 → 返回该栏', () => {
    const board = boardWith(
      [makeColumn({ id: 'col1' })],
      [
        { ...note('a', 0, 0), columnId: 'col1' },
        { ...note('b', 0, 0), columnId: 'col1' },
      ],
    );
    expect(soleColumnOf(board, new Set(['a', 'b']))).toBe('col1');
  });

  it('跨栏 / 有散卡 → null', () => {
    const board = boardWith(
      [makeColumn({ id: 'col1' }), makeColumn({ id: 'col2' })],
      [
        { ...note('a', 0, 0), columnId: 'col1' },
        { ...note('b', 0, 0), columnId: 'col2' },
      ],
    );
    expect(soleColumnOf(board, new Set(['a', 'b']))).toBeNull();
    expect(soleColumnOf(board, new Set(['a']))).toBe('col1');
  });

  it('★ 选区里有幽灵 id 时返回 null（宁可判不出来，也不要猜）', () => {
    const board = boardWith(
      [makeColumn({ id: 'col1' })],
      [{ ...note('a', 0, 0), columnId: 'col1' }],
    );
    expect(soleColumnOf(board, new Set(['a', 'ghost']))).toBeNull();
  });
});

describe('collapsedColumnCardIds（O16：收起的分栏）', () => {
  /** 两个栏各装一张卡，外加一张游离在画布上的卡 */
  function twoColumns() {
    return boardWith(
      [makeColumn({ id: 'col1', x: 0, y: 0 }), makeColumn({ id: 'col2', x: 400, y: 0 })],
      [
        { ...note('a', 0, 0), columnId: 'col1', order: 0 },
        { ...note('b', 0, 0), columnId: 'col2', order: 0 },
        note('free', 800, 0),
      ],
    );
  }

  it('没有收起的栏 → 空集（绝大多数情况，调用方走快路径）', () => {
    expect(collapsedColumnCardIds(twoColumns()).size).toBe(0);
  });

  it('收起一栏 → 只含这一栏的成员（别的栏与游离卡片都不算）', () => {
    const board = twoColumns();
    setColumnCollapsed(board, 'col1', true);
    expect([...collapsedColumnCardIds(board)].sort()).toEqual(['a']);
  });

  it('两栏都收起 → 两份成员都在；展开一栏 → 只剩另一栏', () => {
    const board = twoColumns();
    setColumnCollapsed(board, 'col1', true);
    setColumnCollapsed(board, 'col2', true);
    expect([...collapsedColumnCardIds(board)].sort()).toEqual(['a', 'b']);
    setColumnCollapsed(board, 'col1', false);
    expect([...collapsedColumnCardIds(board)].sort()).toEqual(['b']);
  });

  it('★ 只是"渲染 / 命中"判据：排版判据（栏内可见成员）与原判据（收起编组）都不受影响', () => {
    const board = twoColumns();
    setColumnCollapsed(board, 'col1', true);
    // 栏内堆叠照旧 —— 折叠栏成员的几何保持不动，展开时才不会错位
    expect(visibleCardsInColumn(board, 'col1').map((card) => card.id)).toEqual(['a']);
    // 两份判据互不干扰（把分栏成员塞进 `collapsedCardIds` 会让栏内卡片叠在同一个 y）
    expect(collapsedCardIds(board).size).toBe(0);
  });
});

describe('整栏移动 / 缩放（F2-7-4 / F2-7-5）', () => {
  it('移动时栏与成员一起平移，提交后与预览的数字完全一致', () => {
    const column = makeColumn({ id: 'col1', x: 100, y: 100 });
    const board = boardWith([column], [{ ...note('c1', 0, 0), columnId: 'col1', order: 0 }]);
    layoutColumn(board, 'col1');

    const preview = columnMoveRects(board, column, 150, 200);
    expect(preview.column).toMatchObject({ x: 150, y: 200 });
    expect(preview.cards[0].x).toBe(150 + COLUMN_LAYOUT.padding);

    expect(applyColumnRects(board, preview)).toBe(true);
    expect(column.x).toBe(150);
    expect(board.cards[0].x).toBe(preview.cards[0].x);
    expect(board.cards[0].y).toBe(preview.cards[0].y);
    // 提交的正是预览的数字 → 再算一遍不该有变化
    expect(applyColumnRects(board, columnMoveRects(board, column, column.x, column.y))).toBe(false);
  });

  it('折叠的栏移动时，成员仍按"展开后"的位置平移（展开回来不会跳）', () => {
    const column = makeColumn({ id: 'col1', x: 0, y: 0, collapsed: true });
    const board = boardWith([column], [{ ...note('c1', 0, 0), columnId: 'col1', order: 0 }]);
    layoutColumn(board, 'col1');
    const before = board.cards[0].y;

    applyColumnRects(board, columnMoveRects(board, column, 0, 50));
    expect(board.cards[0].y).toBe(before + 50);
  });

  it('缩放改变栏宽 → 成员宽度跟着变', () => {
    const column = makeColumn({ id: 'col1', x: 0, y: 0, width: 320 });
    const board = boardWith([column], [{ ...note('c1', 0, 0), columnId: 'col1', order: 0 }]);
    layoutColumn(board, 'col1');

    applyColumnRects(
      board,
      columnResizeRects(board, column, { x: 0, y: 0, width: 500, height: 600 }),
    );
    expect(column.width).toBe(500);
    expect(board.cards[0].width).toBe(500 - COLUMN_LAYOUT.padding * 2);
    expect(column.height).toBe(600);
  });

  it('缩放到下限以下会被钳制（窄到抓不住的栏等于数据损坏）', () => {
    const column = makeColumn({ id: 'col1' });
    const board = boardWith([column], []);

    applyColumnRects(
      board,
      columnResizeRects(board, column, { x: 0, y: 0, width: 10, height: 10 }),
    );
    expect(column.width).toBe(COLUMN_LAYOUT.minWidth);
    expect(column.height).toBe(COLUMN_LAYOUT.minHeight);
  });

  it('★ 折叠态下不把"显示高度"写进模型（会把展开高度永久压扁）', () => {
    const column = makeColumn({ id: 'col1', height: 800, collapsed: true });
    const board = boardWith([column], []);

    applyColumnRects(
      board,
      columnResizeRects(board, column, { x: 0, y: 0, width: 320, height: 40 }),
    );
    expect(column.height).toBe(800);
  });
});

describe('findDropTarget（T1.55 插入线）', () => {
  function twoColumnBoard() {
    // 左栏在 (100,200) 宽 320 高 500；右栏在 (500,200)
    const left = makeColumn({ id: 'left', x: 100, y: 200, width: 320, height: 500, z: 10 });
    const right = makeColumn({ id: 'right', x: 500, y: 200, width: 320, height: 500, z: 20 });
    const board = boardWith(
      [left, right],
      [
        { ...note('a', 0, 0), columnId: 'left', order: 0, height: 100 },
        { ...note('b', 0, 0), columnId: 'left', order: 1, height: 100 },
      ],
    );
    layoutColumn(board, 'left');
    return { board, left };
  }

  it('落在栏的空白处也命中（空栏必须能放东西）', () => {
    const { board } = twoColumnBoard();
    const target = findDropTarget(board, { x: 200, y: 700 });
    expect(target?.columnId).toBe('left');
  });

  it('插到第二张卡中间 → index = 1', () => {
    const { board } = twoColumnBoard();
    // 第一张卡 246..346，第二张 356..456
    const target = findDropTarget(board, { x: 200, y: 360 });
    expect(target?.index).toBe(1);
  });

  it('落在第一张卡上半部分之前 → index = 0', () => {
    const { board } = twoColumnBoard();
    expect(findDropTarget(board, { x: 200, y: 250 })?.index).toBe(0);
  });

  it('★ 下边界之外还有容差，能把卡拖到列表末尾', () => {
    const { board, left } = twoColumnBoard();
    const below = left.y + left.height + COLUMN_LAYOUT.dropTolerance - 1;
    const target = findDropTarget(board, { x: 200, y: below });
    expect(target?.columnId).toBe('left');
    expect(target?.index).toBe(2);
  });

  it('超出容差就不再命中（否则画布上到处都在"往栏里塞"）', () => {
    const { board, left } = twoColumnBoard();
    expect(findDropTarget(board, { x: 200, y: left.y + left.height + 500 })).toBeNull();
  });

  it('插入线画在两张卡之间的缝隙里', () => {
    const { board } = twoColumnBoard();
    const target = findDropTarget(board, { x: 200, y: 360 })!;
    const members = cardsInColumn(board, 'left');
    expect(target.line.y).toBe(members[1].y - COLUMN_LAYOUT.gap / 2);
    expect(target.line.width).toBe(320 - COLUMN_LAYOUT.padding * 2);
  });

  it('★ 排除正在拖动的卡片：否则它自己的位置会把插入 index 顶偏', () => {
    const { board } = twoColumnBoard();
    const point = { x: 200, y: 360 };
    expect(findDropTarget(board, point)?.index).toBe(1);
    // 拖的正是第一张 → 剩下的只有 b，插到 b 之前 = 0
    expect(findDropTarget(board, point, new Set(['a']))?.index).toBe(0);
    expect(findDropTarget(board, point, new Set(['a', 'b']))?.index).toBe(0);
  });

  it('折叠的栏不接受落点（插进去的东西会"消失"）', () => {
    const { board, left } = twoColumnBoard();
    setColumnCollapsed(board, left.id, true);
    expect(findDropTarget(board, { x: 200, y: 300 })).toBeNull();
  });

  it('重叠时 z 大的栏胜出', () => {
    const low = makeColumn({ id: 'low', x: 0, y: 0, width: 300, height: 300, z: 1 });
    const high = makeColumn({ id: 'high', x: 0, y: 0, width: 300, height: 300, z: 99 });
    const board = boardWith([high, low], []);
    expect(findDropTarget(board, { x: 100, y: 100 })?.columnId).toBe('high');
  });

  it('画布上的空白处没有落点', () => {
    const { board } = twoColumnBoard();
    expect(findDropTarget(board, { x: -500, y: -500 })).toBeNull();
  });

  it('★ scrollOf：滚过的栏按屏幕位置换算序号与插入线（T2.03）', () => {
    // 栏高 200，装不下 4 张 100 高的卡：窗口只到 y=188，下面两张靠栏内滚动看
    const column = makeColumn({ id: 'col1', x: 0, y: 0, width: 320, height: 200 });
    const board = boardWith(
      [column],
      Array.from({ length: 4 }, (_, index) => ({
        ...note(`c${index}`, 0, 0),
        columnId: 'col1',
        order: index,
        height: 100,
      })),
    );
    layoutColumn(board, 'col1');
    // 模型坐标：c0 46..146、c1 156..256、c2 266..366、c3 376..476
    const point = { x: 100, y: 150 };

    expect(findDropTarget(board, point)?.index).toBe(1);
    // 滚了 100px 之后，同一个屏幕点看到的是模型里的 y=250 —— 落点必须跟着走
    const scrolled = findDropTarget(board, point, new Set(), () => 100);
    expect(scrolled?.index).toBe(2);
    // 插入线也换算回视觉坐标：c1 下沿 256 + gap/2 = 261，减偏移 100 = 161
    expect(scrolled?.line.y).toBe(161);
  });

  it('★ 命中区用可见高度：封顶之后，屏幕外的内容不是落点（T2.03）', () => {
    const column = makeColumn({ id: 'col1', x: 0, y: 0, width: 320, height: 200 });
    const board = boardWith([column], tallCards(12));
    layoutColumn(board, 'col1');
    growColumnToFit(board, 'col1');
    expect(column.height).toBe(COLUMN_LAYOUT.maxAutoHeight);

    // 内容高 1968，但可见区只到 1200 + dropTolerance —— 隔着屏幕外的空白不该能丢卡进去
    expect(findDropTarget(board, { x: 100, y: 1300 })).toBeNull();
    expect(findDropTarget(board, { x: 100, y: 1250 })?.columnId).toBe('col1');
  });
});

// ─────────────────────────────────────────────────────────────
// 同级分栏对齐（T3.15 / F5-01）
// ─────────────────────────────────────────────────────────────

describe('同级分栏对齐（T3.15 / F5-01）', () => {
  /** 三栏并排、间隙 24（= `siblingGap`）、纵向重叠，但顶部不齐 */
  function row() {
    return boardWith(
      [
        makeColumn({ id: 'col1', x: 0, y: 0, width: 200, height: 300 }),
        makeColumn({ id: 'col2', x: 224, y: 50, width: 200, height: 300 }),
        makeColumn({ id: 'col3', x: 448, y: 10, width: 200, height: 300 }),
      ],
      [],
    );
  }

  const idsOf = (columns: Column[]): string[] => columns.map((column) => column.id).sort();

  it('并排 + 纵向重叠 = 同一组，且取**传递闭包**（隔着中间那栏也算）', () => {
    const board = row();
    expect(idsOf(siblingColumnsOf(board, 'col1'))).toEqual(['col1', 'col2', 'col3']);
    expect(idsOf(siblingColumnsOf(board, 'col2'))).toEqual(['col1', 'col2', 'col3']);
  });

  it('纵向错开（不重叠）→ 不是同一组', () => {
    const board = boardWith(
      [
        makeColumn({ id: 'col1', x: 0, y: 0, width: 200, height: 200 }),
        makeColumn({ id: 'col2', x: 224, y: 400, width: 200, height: 200 }),
      ],
      [],
    );
    expect(idsOf(siblingColumnsOf(board, 'col1'))).toEqual(['col1']);
  });

  it('横向离得太远 → 不是同一组', () => {
    const board = boardWith(
      [
        makeColumn({ id: 'col1', x: 0, y: 0, width: 200, height: 200 }),
        makeColumn({ id: 'col2', x: 400, y: 0, width: 200, height: 200 }),
      ],
      [],
    );
    expect(idsOf(siblingColumnsOf(board, 'col1'))).toEqual(['col1']);
  });

  it('顶部对齐 + 等宽（往最宽的取），并重排 x 以免压到右邻', () => {
    const board = boardWith(
      [
        makeColumn({ id: 'col1', x: 0, y: 0, width: 200, height: 300 }),
        makeColumn({ id: 'col2', x: 224, y: 60, width: 300, height: 300 }),
      ],
      [],
    );
    expect(alignSiblingColumns(board, ['col1'])).toBe(true);
    expect(columnById(board, 'col1')!.y).toBe(0);
    expect(columnById(board, 'col2')!.y).toBe(0);
    expect(columnById(board, 'col1')!.width).toBe(300);
    expect(columnById(board, 'col2')!.width).toBe(300);
    // 左边那栏加宽到 300 后，右邻必须跟着右移：否则 0..300 与 224..524 会重叠 76px
    expect(columnById(board, 'col1')!.x).toBe(0);
    expect(columnById(board, 'col2')!.x).toBe(324);
  });

  it('★ 宽度一致时绝不碰 x：用户手动留出来的间距不会被这条命令吃掉', () => {
    const board = boardWith(
      [
        makeColumn({ id: 'col1', x: 0, y: 50, width: 200, height: 300 }),
        // 间隙 40（仍在 siblingGap×2 的容差内，所以是兄弟）
        makeColumn({ id: 'col2', x: 240, y: 0, width: 200, height: 300 }),
      ],
      [],
    );
    expect(alignSiblingColumns(board, ['col1'])).toBe(true);
    expect(columnById(board, 'col1')!.y).toBe(0);
    expect(columnById(board, 'col1')!.x).toBe(0);
    expect(columnById(board, 'col2')!.x).toBe(240);
  });

  it('幂等：已经对齐过的排再按一次返回 false（不记历史）', () => {
    const board = row();
    expect(alignSiblingColumns(board, ['col1'])).toBe(true);
    expect(alignSiblingColumns(board, ['col1'])).toBe(false);
  });

  it('没有兄弟 / 未知 id / 空选区 → false', () => {
    const board = row();
    expect(alignSiblingColumns(board, [])).toBe(false);
    expect(alignSiblingColumns(board, ['ghost'])).toBe(false);

    const single = boardWith([makeColumn({ id: 'only', x: 0, y: 0, width: 200 })], []);
    expect(alignSiblingColumns(single, ['only'])).toBe(false);
  });

  it('比 minWidth 还窄的栏会被抬到 minWidth（下限是硬约束）', () => {
    const board = boardWith(
      [
        makeColumn({ id: 'col1', x: 0, y: 0, width: 100, height: 300 }),
        makeColumn({ id: 'col2', x: 124, y: 0, width: 120, height: 300 }),
      ],
      [],
    );
    expect(alignSiblingColumns(board, ['col1'])).toBe(true);
    expect(columnById(board, 'col1')!.width).toBe(COLUMN_LAYOUT.minWidth);
    expect(columnById(board, 'col2')!.width).toBe(COLUMN_LAYOUT.minWidth);
  });

  it('★ ⌘Enter 拆出来的同级分栏天然等宽等顶（F5-01 里"自动"的那一半）', () => {
    const wide = { ...createCard('note', { x: 300, y: 50, width: 400, height: 180 }), id: 'b' };
    const board = boardWith([], [{ ...note('a', 0, 50), height: 100 }, wide]);

    const ids = splitIntoColumns(board, ['a', 'b']);
    const [left, right] = ids.map((id) => columnById(board, id)!);

    // 卡宽 280 / 400 → 各自的栏本来是 304 / 424；对齐后都取最宽的 424
    expect(left.width).toBe(424);
    expect(right.width).toBe(424);
    expect(left.y).toBe(right.y);
    // 等宽之后横向重排：两栏之间仍是 siblingGap，绝不重叠
    expect(right.x).toBe(left.x + 424 + COLUMN_LAYOUT.siblingGap);
  });
});
