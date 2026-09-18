/**
 * 自动整理与按标签分栏（T6.07 / T6.08 · `F5-06` / `F5-07`）的回归。
 *
 * 这两个操作是**一把改很多个坐标的刀**，所以这里盯的不是"能跑"，而是三件事：
 *
 * 1. **幂等**：已经整齐的板子跑完必须返回 `false` —— 除非它已经被排序过一轮，
 *    否则用户连按两次"自动整理"就会多出两条历史记录（而他什么都没看到变化）；
 * 2. **不碰派生几何**：栏内成员的坐标是算出来的，整理只能动分栏本身。
 *    这条一旦破了，`relayoutColumns` 会把成员弹回栏里 —— 表面上"没生效"，
 *    实际上 undo 栈里已经多了一堆谁也不知道从哪来的历史；
 * 3. **不拆关系**：上下叠着的卡不许横向摊开、编组不许散开、锁定卡片不许挪、
 *    栏里已经放好的卡不许被"按标签分栏"挖走。
 *
 * 排版数字用 `COLUMN_LAYOUT.siblingGap`（24）当间距，断言里直接用常量而不是硬编码 24。
 */

import { describe, expect, it } from 'vitest';
import {
  ARRANGE_LAYOUT,
  MIN_TAG_GROUP,
  boardBlocks,
  columnsByTag,
  planTagColumns,
  tidyBoard,
} from '../../model/arrange';
import { COLUMN_LAYOUT, columnDisplayHeight } from '../../model/columns';
import { createBoardFile, createCard } from '../../model/factories';
import type { Card, CardOf, Column, Group } from '../../model/schema';

const GAP = ARRANGE_LAYOUT.gap;

/** 造一张摆好位置的卡（默认尺寸 280×180，与 `DEFAULT_CARD_SIZES.note` 一致） */
function cardAt(x: number, y: number, overrides: Partial<CardOf<'note'>> = {}): Card {
  const card = createCard('note', {
    title: overrides.title ?? '',
    content: { md: '' },
  });
  return { ...card, x, y, width: 280, height: 180, ...overrides };
}

function columnAt(x: number, y: number, height: number, overrides: Partial<Column> = {}): Column {
  const card = createCard('note'); // 只借它的 id 生成器
  return {
    id: `col-${card.id}`,
    title: '',
    x,
    y,
    width: 300,
    height,
    collapsed: false,
    color: '2',
    z: 0,
    ...overrides,
  };
}

function groupOf(id: string, cardIds: string[]): Group {
  return { id, cardIds, label: '' };
}

function rectOf(card: Card) {
  return { x: card.x, y: card.y };
}

describe('boardBlocks', () => {
  it('分栏是一整块，高度用**显示高度**（折叠的栏只占 40）', () => {
    const folded = columnAt(0, 0, 500, { collapsed: true, title: '折叠的' });
    const board = createBoardFile({ columns: [folded] });

    expect(boardBlocks(board)).toEqual([
      {
        key: folded.id,
        columnId: folded.id,
        cardIds: [],
        x: 0,
        y: 0,
        width: 300,
        height: COLUMN_LAYOUT.collapsedHeight,
      },
    ]);
  });

  it('★ 栏内成员不进块：它们的坐标是派生状态，整理不许直接动', () => {
    const column = columnAt(0, 0, 400);
    const inner = cardAt(20, 60, { columnId: column.id });
    const board = createBoardFile({ columns: [column], cards: [inner] });

    const blocks = boardBlocks(board);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].cardIds).toEqual([]);
  });

  it('★ 锁定卡片不进块（锁住就是在说"别碰它"）', () => {
    const board = createBoardFile({ cards: [cardAt(0, 0, { locked: true })] });
    expect(boardBlocks(board)).toEqual([]);
  });

  it('全员在栏外的编组整块搬，用成员的外接矩形', () => {
    const a = cardAt(0, 0);
    const b = cardAt(400, 100);
    const board = createBoardFile({ cards: [a, b], groups: [groupOf('g1', [a.id, b.id])] });

    const blocks = boardBlocks(board);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].cardIds.sort()).toEqual([a.id, b.id].sort());
    expect(blocks[0]).toMatchObject({ x: 0, y: 0, width: 680, height: 280 });
  });

  it('有一个成员在栏里的编组按成员拆开（整块搬会把它从栏里拖出来）', () => {
    const column = columnAt(0, 0, 400);
    const inner = cardAt(20, 60, { columnId: column.id });
    const loose = cardAt(500, 60);
    const board = createBoardFile({
      columns: [column],
      cards: [inner, loose],
      groups: [groupOf('g1', [inner.id, loose.id])],
    });

    const blocks = boardBlocks(board);
    // 分栏一块 + 散卡一块，编组不再是块
    expect(blocks).toHaveLength(2);
    expect(blocks[1].cardIds).toEqual([loose.id]);
  });
});

describe('tidyBoard', () => {
  it('并排的三张卡 → 一行、顶部对齐、间距统一', () => {
    const a = cardAt(0, 0);
    const b = cardAt(400, 30);
    const c = cardAt(900, -20);
    const board = createBoardFile({ cards: [a, b, c] });

    expect(tidyBoard(board)).toBe(true);

    // 行的顺序跟着"原来在哪"：c(y=-20) 在最上，所以它排最左
    expect(rectOf(c)).toEqual({ x: 0, y: -20 });
    expect(rectOf(a)).toEqual({ x: 280 + GAP, y: -20 });
    expect(rectOf(b)).toEqual({ x: (280 + GAP) * 2, y: -20 });
  });

  it('★ 上下叠着的两张卡不会横向摊开：各占一行，左边对齐，间距统一', () => {
    const a = cardAt(0, 0);
    const b = cardAt(0, 300);
    const board = createBoardFile({ cards: [a, b] });

    expect(tidyBoard(board)).toBe(true);

    expect(rectOf(a)).toEqual({ x: 0, y: 0 });
    // 两行的左边界对齐到同一条竖线 —— 这就是"按分栏垂直重排"
    expect(rectOf(b)).toEqual({ x: 0, y: 180 + GAP });
  });

  it('★ 稀疏网格不会被压成一竖条：行与行之间留的是统一间距，不是"全部串起来"', () => {
    // 3×3 网格，行距 300 远大于卡高 180 —— 这正是"用纵向相交判行"会塌掉的形态
    const cards = [0, 1, 2].flatMap((row) => [0, 1, 2].map((col) => cardAt(col * 400, row * 300)));
    const board = createBoardFile({ cards });

    tidyBoard(board);

    const ys = [...new Set(cards.map((card) => card.y))].sort((a, b) => a - b);
    expect(ys).toEqual([0, 180 + GAP, (180 + GAP) * 2]);
    // 列也一样：三张一行的 x 间距统一
    const xs = [...new Set(cards.map((card) => card.x))].sort((a, b) => a - b);
    expect(xs).toEqual([0, 280 + GAP, (280 + GAP) * 2]);
  });

  it('★ 行内密叠的两行不会被并成一行（横向压在一起就是上下关系）', () => {
    // 两行只隔 100px，卡高 180 —— 纵向区间相交，但同列的两张是"叠着"的
    const top = [cardAt(0, 0), cardAt(400, 0)];
    const bottom = [cardAt(0, 100), cardAt(400, 100)];
    const board = createBoardFile({ cards: [...top, ...bottom] });

    tidyBoard(board);

    expect(top.map((card) => card.y)).toEqual([0, 0]);
    const rowTwo = 180 + GAP;
    expect(bottom.map((card) => card.y)).toEqual([rowTwo, rowTwo]);
  });

  it('★ 不许跨过正上方那张卡：高卡旁边的下卡属下一行', () => {
    const tall = cardAt(0, 0, { height: 600 });
    const short = cardAt(400, 0);
    const below = cardAt(400, 200);
    const board = createBoardFile({ cards: [tall, short, below] });

    tidyBoard(board);

    // 第一行 = 高卡 + 短卡（顶部对齐），行高取两者最高的 600
    expect(rectOf(tall)).toEqual({ x: 0, y: 0 });
    expect(rectOf(short)).toEqual({ x: 280 + GAP, y: 0 });
    // 下卡不能被吸进第一行（那样它会横着跨过短卡），而是另起一行
    expect(rectOf(below)).toEqual({ x: 0, y: 600 + GAP });
  });

  it('★ 幂等：连按两次，第二次不该有任何变化（否则每次都多一条历史）', () => {
    const board = createBoardFile({
      cards: [cardAt(0, 0), cardAt(500, 30), cardAt(0, 400)],
    });

    expect(tidyBoard(board)).toBe(true);
    const snapshot = board.cards.map((card) => ({ ...card }));
    expect(tidyBoard(board)).toBe(false);
    expect(board.cards.map((card) => rectOf(card))).toEqual(snapshot.map((card) => rectOf(card)));
  });

  it('整理不缩放任何东西：卡片尺寸与分栏尺寸原样保留', () => {
    const wide = cardAt(0, 0, { width: 700, height: 90 });
    const board = createBoardFile({ cards: [wide, cardAt(0, 400)] });

    tidyBoard(board);

    expect(wide.width).toBe(700);
    expect(wide.height).toBe(90);
  });

  it('★ 移动分栏时成员跟着走（走 `relayoutColumns`，不是直接改成员坐标）', () => {
    const column = columnAt(900, 0, 400);
    const member = cardAt(0, 0, { columnId: column.id });
    // 散卡在左边，整理后分栏会被拉到 x=0
    const board = createBoardFile({ columns: [column], cards: [member, cardAt(0, 800)] });

    expect(tidyBoard(board)).toBe(true);

    expect(column.x).toBe(0);
    // 成员被摆进栏内（左内边距 12），而不是留在原地
    expect(member.x).toBe(COLUMN_LAYOUT.padding);
    expect(member.y).toBe(COLUMN_LAYOUT.headerHeight + COLUMN_LAYOUT.headerGap);
  });

  it('★ 锁定卡片留在原地（宁可重叠，也不悄悄挪走它）', () => {
    const pinned = cardAt(1000, 1000, { locked: true });
    const board = createBoardFile({ cards: [pinned, cardAt(0, 0)] });

    tidyBoard(board);

    expect(rectOf(pinned)).toEqual({ x: 1000, y: 1000 });
  });

  it('★ 编组整块搬：成员之间的相对位置一个像素都不变', () => {
    const a = cardAt(0, 0);
    const b = cardAt(300, 100);
    const board = createBoardFile({
      cards: [a, b, cardAt(1200, 0)],
      groups: [groupOf('g1', [a.id, b.id])],
    });

    tidyBoard(board);

    // b 相对 a 的偏移保持 (300, 100)
    expect(b.x - a.x).toBe(300);
    expect(b.y - a.y).toBe(100);
  });

  it('只有一块 / 空板 → 无事可做（返回 false，不写历史）', () => {
    expect(tidyBoard(createBoardFile())).toBe(false);
    expect(tidyBoard(createBoardFile({ cards: [cardAt(500, 500)] }))).toBe(false);
  });

  it('已经排好的一行（间距正好是 24）→ 一块都不挪', () => {
    const card = cardAt(0, 0);
    const column = columnAt(280 + GAP, 0, 400);
    const board = createBoardFile({ columns: [column], cards: [card] });

    expect(tidyBoard(board)).toBe(false);
    expect(rectOf(card)).toEqual({ x: 0, y: 0 });
    expect(column.x).toBe(280 + GAP);
  });
});

// ── 按标签自动分栏（T6.08 / F5-07） ──────────────────────────────

/** 造一张带正文的散卡（标签写在正文里） */
function taggedCard(x: number, y: number, md: string, title = ''): Card {
  const card = createCard('note', { title, content: { md } });
  return { ...card, x, y, width: 280, height: 180 };
}

describe('planTagColumns', () => {
  it('只把"够一组"的标签列进计划（一张卡的标签不配单独开栏）', () => {
    const board = createBoardFile({
      cards: [
        taggedCard(0, 0, '#项目 甲'),
        taggedCard(0, 200, '#项目 乙'),
        taggedCard(0, 400, '#灵感 孤零零一张'),
      ],
    });

    const plan = planTagColumns(board);
    expect(plan).toHaveLength(1);
    expect(plan[0].label).toBe('项目');
    expect(plan[0].cardIds).toHaveLength(2);
    expect(MIN_TAG_GROUP).toBe(2);
  });

  it('★ 一张卡有多个标签时只认第一个（标题优先）—— `card.columnId` 是单值', () => {
    const board = createBoardFile({
      cards: [taggedCard(0, 0, '正文 #工作', '#重要'), taggedCard(0, 200, '#重要 乙')],
    });

    const plan = planTagColumns(board);
    expect(plan.map((item) => item.label)).toEqual(['重要']);
  });

  it('★ 栏内成员与锁定卡片都不参与：不挖用户自己分好的组', () => {
    const column = columnAt(0, 0, 400);
    const inner = taggedCard(20, 60, '#项目 已在栏里');
    const loose = taggedCard(0, 800, '#项目 甲');
    const pinned = taggedCard(0, 1000, '#项目 锁定');
    const other = taggedCard(0, 1200, '#项目 乙');
    const board = createBoardFile({ columns: [column], cards: [inner, loose, pinned, other] });

    inner.columnId = column.id;
    pinned.locked = true;

    const plan = planTagColumns(board);
    expect(plan[0].cardIds).toEqual([loose.id, other.id]);
  });

  it('已有同名分栏（`项目` 也算 `#项目`）→ 复用它的 id，不新建', () => {
    const existing = columnAt(0, 0, 400, { title: '项目' });
    const board = createBoardFile({
      columns: [existing],
      cards: [taggedCard(900, 0, '#项目 甲'), taggedCard(900, 200, '#项目 乙')],
    });

    expect(planTagColumns(board)[0].columnId).toBe(existing.id);
  });

  it('按"卡片多的在前、同数按标签名"排序，组内按阅读顺序', () => {
    const board = createBoardFile({
      cards: [
        taggedCard(600, 0, '#甲 右下'), // 阅读顺序里最后
        taggedCard(0, 500, '#乙 二'),
        taggedCard(0, 0, '#甲 左上'),
        taggedCard(300, 0, '#乙 一'),
        taggedCard(600, 500, '#乙 三'),
      ],
    });

    const plan = planTagColumns(board);
    expect(plan.map((item) => item.label)).toEqual(['乙', '甲']);
    // 组内先上后下、先左后右（"二"在最下，所以排最后）
    expect(plan[0].cardIds).toEqual([board.cards[3].id, board.cards[1].id, board.cards[4].id]);
    expect(plan[1].cardIds).toEqual([board.cards[2].id, board.cards[0].id]);
  });

  it('没有任何成组的标签 → 空计划', () => {
    const board = createBoardFile({
      cards: [taggedCard(0, 0, '没有标签'), taggedCard(0, 200, '#独苗')],
    });
    expect(planTagColumns(board)).toEqual([]);
  });
});

describe('columnsByTag', () => {
  it('把同标签的散卡收进新栏：标题为 `#标签`，成员归位、栏在既有内容下方', () => {
    const board = createBoardFile({
      cards: [taggedCard(0, 0, '#项目 甲'), taggedCard(0, 200, '#项目 乙')],
    });

    const result = columnsByTag(board);

    expect(result.changed).toBe(true);
    expect(result.created).toBe(1);
    expect(result.groups).toEqual([{ label: '项目', count: 2 }]);

    const column = board.columns[0];
    expect(column.title).toBe('#项目');
    expect(column.id).toBe(board.cards[0].columnId);
    expect(board.cards[1].columnId).toBe(column.id);
    // 新栏在既有内容（底边 380）下方，两者不会重叠
    expect(column.y).toBeGreaterThan(380);
    expect(columnDisplayHeight(column)).toBeGreaterThan(0);
  });

  it('★ 新栏的宽度按成员卡片的宽度算，并做一次同级对齐（顶部齐、宽相等）', () => {
    const board = createBoardFile({
      cards: [
        taggedCard(0, 0, '#甲 一'),
        taggedCard(0, 200, '#甲 二'),
        taggedCard(900, 0, '#乙 一'),
        taggedCard(900, 200, '#乙 二'),
        taggedCard(900, 400, '#乙 三'),
      ],
    });

    columnsByTag(board);

    expect(board.columns).toHaveLength(2);
    const [first, second] = board.columns;
    // 等宽（`alignSiblingColumns` 的收尾）：卡片数不同也不参差不齐
    expect(first.width).toBe(second.width);
    expect(first.y).toBe(second.y);
    expect(second.x - first.x).toBe(first.width + COLUMN_LAYOUT.siblingGap);
  });

  it('★ 复用已有同名分栏：不新建，卡片追加到末尾（原有的顺序不动）', () => {
    const existing = columnAt(0, 0, 400, { title: '项目' });
    const inside = cardAt(20, 60, { columnId: existing.id });
    const board = createBoardFile({
      columns: [existing],
      cards: [
        inside,
        taggedCard(900, 0, '#项目 甲'),
        taggedCard(900, 200, '#项目 乙'),
        taggedCard(900, 400, '#项目 丙'),
      ],
    });

    const result = columnsByTag(board);

    expect(result.created).toBe(0);
    expect(result.reused).toBe(1);
    expect(board.columns).toHaveLength(1);
    // 新收进来的三张排在原有成员之后
    expect(
      board.cards.filter((card) => card.columnId === existing.id).map((card) => card.id),
    ).toEqual([inside.id, board.cards[1].id, board.cards[2].id, board.cards[3].id]);
  });

  it('★ 幂等：收完再按一次，已经没有可收的散卡了', () => {
    const board = createBoardFile({
      cards: [taggedCard(0, 0, '#项目 甲'), taggedCard(0, 200, '#项目 乙')],
    });

    expect(columnsByTag(board).changed).toBe(true);
    expect(columnsByTag(board).changed).toBe(false);
  });

  it('没有成组的标签 → `changed: false`，一根手指都不碰模型', () => {
    const board = createBoardFile({ cards: [taggedCard(0, 0, '没有标签')] });
    const result = columnsByTag(board);

    expect(result).toEqual({ changed: false, created: 0, reused: 0, groups: [] });
    expect(board.columns).toEqual([]);
  });
});
