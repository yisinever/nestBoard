/**
 * 层级（z 序）操作单元测试（T1.31 / F2-00-4）。
 *
 * 这里测的不只是"谁在上面"，还有**返回值必须诚实**：
 * `BoardRepository.mutate` 靠它决定要不要递增 `revision`、标脏、排盘。
 * 谎报"改了"会让文件在每次按 ⌘⇧↑ 时都被写一遍；谎报"没改"会吞掉真实改动。
 */

import { describe, expect, it } from 'vitest';
import { createBoardFile, createCard, createEdge, createMind } from '../../model/factories';
import { createMindFile, createMindNode } from '../../mind/model/factories';
import {
  MIN_GROUP_SIZE,
  addCards,
  alignCards,
  applyCardRotations,
  bringToFront,
  cardById,
  cloneJson,
  collapsedCardIds,
  distributeCards,
  duplicateCards,
  expandGroupSelection,
  groupById,
  groupCards,
  groupOfCard,
  patchSyncGroup,
  pruneGroups,
  removeCards,
  removeMindNodes,
  sendToBack,
  setGroupCollapsed,
  setGroupLabel,
  translateCards,
  ungroupCards,
  updateCardLook,
  updateCards,
} from '../../model/ops';
import { nodeEndpointKey } from '../../model/schema';
import type { BoardFile, Card, Mind } from '../../model/schema';
import { sortCardsByZ } from '../../view/render/CardLayer';

function boardWith(zValues: Record<string, number>): BoardFile {
  const board = createBoardFile();
  board.cards = Object.entries(zValues).map(([id, z]) => ({ ...createCard('note'), id, z }));
  return board;
}

const ids = (cards: readonly Card[]): string[] => sortCardsByZ(cards).map((card) => card.id);

describe('patchSyncGroup（T7.04 / F2.9）', () => {
  function syncBoard(): BoardFile {
    const board = createBoardFile();
    board.cards = [
      createCard('syncNote', { id: 's1', content: { key: 'sy_a', md: '旧' } }),
      createCard('syncNote', { id: 's2', content: { key: 'sy_a', md: '旧' } }),
      createCard('syncNote', { id: 's3', content: { key: 'sy_b', md: '旧' } }),
      // 一张普通便签，正文与同步便签的 `md` 同名 —— 它验证"只认同类型"这条
      createCard('note', { id: 'n1', content: { md: '旧' } }),
    ];
    return board;
  }

  it('改掉同组的每一张；别的组、别的类型一动不动', () => {
    const board = syncBoard();
    expect(patchSyncGroup(board, 'sy_a', '新')).toBe(true);

    expect(cardById(board, 's1')?.content).toEqual({ key: 'sy_a', md: '新' });
    expect(cardById(board, 's2')?.content).toEqual({ key: 'sy_a', md: '新' });
    expect(cardById(board, 's3')?.content).toEqual({ key: 'sy_b', md: '旧' });
    // 普通便签的正文与同步便签的 `md` 同名 —— 只比对 `md`，验证"只认同类型"
    // （先按 `type` 收窄，`content` 的联合里 `md` 不是每个成员都有）
    const plain = cardById(board, 'n1');
    expect(plain?.type === 'note' ? plain.content.md : null).toBe('旧');
  });

  it('值全都一样 → 返回 false（视图据此不重绘、不标脏）', () => {
    const board = syncBoard();
    expect(patchSyncGroup(board, 'sy_a', '旧')).toBe(false);
  });

  it('空 key 不是"一个组" → 返回 false，一张都不改', () => {
    const board = createBoardFile();
    board.cards = [createCard('syncNote', { id: 's1', content: { key: '', md: '旧' } })];

    expect(patchSyncGroup(board, '', '新')).toBe(false);
    expect(cardById(board, 's1')?.content).toEqual({ key: '', md: '旧' });
  });

  it('换新对象而不是就地改：别处持有的老 `content` 引用不受影响', () => {
    const board = syncBoard();
    const before = cardById(board, 's1')!.content;
    patchSyncGroup(board, 'sy_a', '新');

    expect(cardById(board, 's1')!.content).not.toBe(before);
    expect(before).toEqual({ key: 'sy_a', md: '旧' });
  });

  it('组里只有一张也照改（"同一便签在多处显示"允许此刻只有一处）', () => {
    const board = createBoardFile();
    board.cards = [createCard('syncNote', { id: 's1', content: { key: 'sy_a', md: '旧' } })];

    expect(patchSyncGroup(board, 'sy_a', '新')).toBe(true);
    expect(cardById(board, 's1')?.content).toEqual({ key: 'sy_a', md: '新' });
  });
});

/**
 * 整棵层级调整 + 节点级删除（`2.2.0` 收尾）。
 *
 * ★ z 是**共用的一格**（分栏在最下、卡片与脑图从 10 起混排）—— 所以"置顶/置底"必须在
 *   "卡片 ∪ 脑图"这一个序列里排，否则"把这张卡置顶"会得到一个它仍压在树下面的结果。
 */
describe('层级调整 × 脑图（2.2.0 收尾）', () => {
  function boardWithMinds(): BoardFile {
    const board = createBoardFile();
    board.cards = [createCard('note', { id: 'a', z: 10 }), createCard('note', { id: 'b', z: 20 })];
    board.minds = [
      { ...createMind({ z: 30 }), id: 'nm1' },
      { ...createMind({ z: 40 }), id: 'nm2' },
    ];
    return board;
  }

  it('★ 一棵树置顶：挪到卡片之上（两者在同一个 z 序列里）', () => {
    const board = boardWithMinds();
    expect(bringToFront(board, ['nm1'])).toBe(true);

    expect(board.minds!.find((mind) => mind.id === 'nm1')!.z).toBeGreaterThan(
      Math.max(...board.cards.map((card) => card.z)),
    );
    // 没被选中的那棵树一个字节不动
    expect(board.minds!.find((mind) => mind.id === 'nm2')!.z).toBe(40);
  });

  it('★ 一张卡与一棵树一起置底：相对次序保持（卡在树下面）', () => {
    const board = boardWithMinds();
    expect(sendToBack(board, ['nm1', 'b'])).toBe(true);

    const zOf = (id: string): number =>
      [...board.cards, ...board.minds!].find((item) => item.id === id)!.z;
    expect(zOf('b')).toBeLessThan(zOf('nm1'));
    expect(zOf('nm1')).toBeLessThan(zOf('a'));
  });

  it('选中的树本来就压在顶层 → 返回 false 且一个字节都不动', () => {
    const board = boardWithMinds();
    const before = board.minds!.map((mind) => mind.z);
    expect(bringToFront(board, ['nm2'])).toBe(false);
    expect(board.minds!.map((mind) => mind.z)).toEqual(before);
  });
});

/**
 * 删除若干节点（`2.2.0` 收尾 · 节点级框选）。
 *
 * ★ 只碰**内嵌**的树：文件树的节点在 `.nestmind` 里，由调用方另走仓储
 *   （这条纯函数读不到那份文件）—— 用例把这件事钉住，免得日后有人以为它是全能的。
 */
describe('removeMindNodes（2.2.0 收尾）', () => {
  function tree(id: string, nodeIds: string[], path = ''): Mind {
    const mind: Mind = { ...createMind({ path }), id };
    const model = createMindFile({ rootText: '根' });
    // 根 + `nodeIds` 里那些（第一个是根）
    for (let index = 1; index < nodeIds.length; index += 1) {
      model.nodes.push(createMindNode({ id: nodeIds[index], parentId: model.rootId, text: '子' }));
    }
    model.nodes[0].id = nodeIds[0]!;
    model.rootId = nodeIds[0]!;
    if (path.length === 0) mind.mind = model;
    return mind;
  }

  it('★ 内嵌树：删掉选中的节点，并清掉指向它的连线', () => {
    const board = createBoardFile();
    board.cards = [createCard('note', { id: 'c1' })];
    board.minds = [tree('nm1', ['root1', 'n_a', 'n_b'])];
    board.edges = [
      // 指着 n_a 的线（该跟着节点一起走）
      createEdge({ cardId: 'c1', side: null }, { cardId: 'nm1', side: null, nodeId: 'n_a' }),
      // 指着 n_b 的线（那条节点还在 ⇒ 留住）
      createEdge({ cardId: 'c1', side: null }, { cardId: 'nm1', side: null, nodeId: 'n_b' }),
    ];

    expect(removeMindNodes(board, [nodeEndpointKey('nm1', 'n_a')])).toBe(true);

    expect(board.minds![0].mind!.nodes.map((node) => node.id)).toEqual(['root1', 'n_b']);
    expect(board.edges).toHaveLength(1);
    expect(board.edges[0].to.nodeId).toBe('n_b');
  });

  it('★ 根节点删不掉（删整棵是另一个动作），返回 false', () => {
    const board = createBoardFile();
    board.minds = [tree('nm1', ['root1', 'n_a'])];
    expect(removeMindNodes(board, [nodeEndpointKey('nm1', 'root1')])).toBe(false);
  });

  it('★ 文件树不归它管：一个字节都不动（那条路走仓储）', () => {
    const board = createBoardFile();
    board.minds = [tree('nm1', ['root1', 'n_a'], '脑图/甲.nestmind')];
    expect(removeMindNodes(board, [nodeEndpointKey('nm1', 'n_a')])).toBe(false);
    // 也没有 `mind` 这一份可以改（它的内容不在板子里）
    expect(board.minds![0].mind).toBeUndefined();
  });
});

describe('bringToFront', () => {
  it('把选中项移到最上层，且保持它们彼此之间的相对次序', () => {
    const board = boardWith({ a: 1, b: 2, c: 3, d: 4 });
    expect(bringToFront(board, ['b', 'a'])).toBe(true);
    // a 原本在 b 下面 → 置顶后仍是 a 在 b 下面
    expect(ids(board.cards)).toEqual(['c', 'd', 'a', 'b']);
  });

  it('选中项本来就压在顶层 → 返回 false 且一个字节都不动', () => {
    const board = boardWith({ a: 1, b: 2, c: 3 });
    const before = board.cards.map((card) => card.z);
    expect(bringToFront(board, ['c'])).toBe(false);
    expect(board.cards.map((card) => card.z)).toEqual(before);
  });

  it('选中顶层的多张卡（相对次序也对）→ 返回 false', () => {
    const board = boardWith({ a: 1, b: 2, c: 3 });
    expect(bringToFront(board, ['b', 'c'])).toBe(false);
    expect(bringToFront(board, ['c', 'b'])).toBe(false);
  });

  it('不动未选中卡片的 z（避免整份文件被写花、diff 不可读）', () => {
    const board = boardWith({ a: 1, b: 2, c: 3 });
    bringToFront(board, ['a']);
    expect(board.cards.find((card) => card.id === 'b')?.z).toBe(2);
    expect(board.cards.find((card) => card.id === 'c')?.z).toBe(3);
    expect(board.cards.find((card) => card.id === 'a')?.z).toBeGreaterThan(3);
  });

  it('空选区 / 全选 / 不存在的 id → 无变化', () => {
    const board = boardWith({ a: 1, b: 2 });
    expect(bringToFront(board, [])).toBe(false);
    expect(bringToFront(board, ['a', 'b'])).toBe(false);
    expect(bringToFront(board, ['nope'])).toBe(false);
    expect(ids(board.cards)).toEqual(['a', 'b']);
  });

  it('按 id 去重：同一个 id 传两次不会给自己堆出一层空档', () => {
    const board = boardWith({ a: 1, b: 2, c: 3 });
    expect(bringToFront(board, ['a', 'a'])).toBe(true);
    expect(ids(board.cards)).toEqual(['b', 'c', 'a']);
    expect(board.cards.find((card) => card.id === 'a')?.z).toBe(4);
  });

  it('单卡板：选中唯一那张 → 无变化', () => {
    const board = boardWith({ only: 7 });
    expect(bringToFront(board, ['only'])).toBe(false);
  });
});

describe('sendToBack', () => {
  it('把选中项移到最下层，且保持它们彼此之间的相对次序', () => {
    const board = boardWith({ a: 1, b: 2, c: 3, d: 4 });
    expect(sendToBack(board, ['d', 'b'])).toBe(true);
    expect(ids(board.cards)).toEqual(['b', 'd', 'a', 'c']);
  });

  it('选中项本来就在最底层 → 返回 false 且不动', () => {
    const board = boardWith({ a: 1, b: 2, c: 3 });
    const before = board.cards.map((card) => card.z);
    expect(sendToBack(board, ['a'])).toBe(false);
    expect(board.cards.map((card) => card.z)).toEqual(before);
  });

  it('允许出现负数 z（置底次数多了就是负的，schema 不禁止）', () => {
    const board = boardWith({ a: 0, b: 1 });
    expect(sendToBack(board, ['b'])).toBe(true);
    expect(ids(board.cards)).toEqual(['b', 'a']);
    expect(board.cards.find((card) => card.id === 'b')?.z).toBeLessThan(0);
  });
});

describe('往返', () => {
  it('置顶 → 置底能回到"相对次序不变、只是整体换了一端"', () => {
    const board = boardWith({ a: 1, b: 2, c: 3, d: 4 });
    bringToFront(board, ['a']);
    expect(ids(board.cards)).toEqual(['b', 'c', 'd', 'a']);
    sendToBack(board, ['a']);
    expect(ids(board.cards)).toEqual(['a', 'b', 'c', 'd']);
  });
});

// ─────────────────────────────────────────────────────────────
// 对齐与等距分布（T3.13 / F5-04、D-05）
// ─────────────────────────────────────────────────────────────

/** 位置尺寸都可控的便签卡；`flags` 用来验证"参与不了"的分支 */
interface CardFlags {
  locked?: boolean;
  columnId?: string | null;
}

/**
 * ★ 默认尺寸刻意压在 `MIN_CARD_SIZE`（80×60）**之上**：`applyCardRects` 会把越界的
 *   尺寸钳到下限，而"均分空隙"是按**钳制前**的尺寸算位置的 —— 用 40/20 这种非法高度
 *   当夹具，算出来的空隙就不相等了（那不是算法的错，是夹具给了现实里不存在的卡片）。
 */
function cardAt(
  id: string,
  x: number,
  y: number,
  width = 120,
  height = 100,
  flags: CardFlags = {},
): Card {
  return { ...createCard('note', { x, y, width, height }), id, ...flags };
}

function boardOf(...cards: Card[]): BoardFile {
  return createBoardFile({ cards });
}

/** 只取位置：对齐断言里尺寸是常量，写全了全是噪音 */
function spotOf(board: BoardFile, id: string): { x: number; y: number } {
  const card = board.cards.find((candidate) => candidate.id === id);
  if (!card) throw new Error(`no card ${id}`);
  return { x: card.x, y: card.y };
}

describe('alignCards（T3.13 / F5-04）', () => {
  it('左对齐：全部贴到选区包围盒的左边界（而不是"第一张卡"的位置）', () => {
    const board = boardOf(cardAt('a', 0, 0), cardAt('b', 50, 100), cardAt('c', 200, 200));
    expect(alignCards(board, ['a', 'b', 'c'], 'left')).toBe(true);
    expect([spotOf(board, 'a').x, spotOf(board, 'b').x, spotOf(board, 'c').x]).toEqual([0, 0, 0]);
    // 纵轴一动不动（对齐是单轴操作）
    expect(spotOf(board, 'b').y).toBe(100);
  });

  it('右对齐：按各自的**宽度**反推 x，右边缘齐平', () => {
    const board = boardOf(cardAt('a', 0, 0, 120), cardAt('b', 50, 0, 80));
    expect(alignCards(board, ['a', 'b'], 'right')).toBe(true);
    // 包围盒右边界 = 130 → 宽 120 的 a 落到 x=10，宽 80 的 b 落在 x=50（本来就在）
    expect(spotOf(board, 'a').x).toBe(10);
    expect(spotOf(board, 'b').x).toBe(50);
  });

  it('水平居中 = 同一 **x** 中心（Figma 的 Align horizontal centers）', () => {
    const board = boardOf(cardAt('a', 0, 0, 120), cardAt('b', 100, 0, 80));
    expect(alignCards(board, ['a', 'b'], 'centerX')).toBe(true);
    // 包围盒 0..180 → 中心 90 → a 落在 30、b 落在 50
    expect(spotOf(board, 'a').x).toBe(30);
    expect(spotOf(board, 'b').x).toBe(50);
  });

  it('垂直居中 = 同一 y 中心；底对齐按高度反推', () => {
    const board = boardOf(cardAt('a', 0, 0, 120, 100), cardAt('b', 0, 100, 120, 60));
    expect(alignCards(board, ['a', 'b'], 'centerY')).toBe(true);
    // 包围盒 0..160 → 中心 80 → 高 100 的 a 落在 30、高 60 的 b 落在 50
    expect(spotOf(board, 'a').y).toBe(30);
    expect(spotOf(board, 'b').y).toBe(50);

    // 底对齐以**当前**包围盒重算：a 占 30..130、b 占 50..110 → 底边 130
    expect(alignCards(board, ['a', 'b'], 'bottom')).toBe(true);
    expect(spotOf(board, 'a').y).toBe(30);
    expect(spotOf(board, 'b').y).toBe(70);
  });

  it('★ 幂等：已经对齐了再按一次返回 false（不写历史、不递增 revision）', () => {
    const board = boardOf(cardAt('a', 0, 0), cardAt('b', 50, 100));
    expect(alignCards(board, ['a', 'b'], 'left')).toBe(true);
    expect(alignCards(board, ['a', 'b'], 'left')).toBe(false);
  });

  it('只有一张可移动的卡 → false（一张卡谈"对齐"没有意义）', () => {
    const board = boardOf(cardAt('a', 0, 0), cardAt('b', 50, 0));
    expect(alignCards(board, ['a'], 'left')).toBe(false);
    expect(spotOf(board, 'b').x).toBe(50);
  });

  it('★ 锁定卡既不被移动，也**不进包围盒**（否则基准线永远贴不上）', () => {
    const board = boardOf(
      cardAt('a', 0, 0),
      cardAt('b', 50, 0),
      cardAt('locked', 900, 0, 120, 100, { locked: true }),
    );
    expect(alignCards(board, ['a', 'b', 'locked'], 'left')).toBe(true);
    expect(spotOf(board, 'a').x).toBe(0);
    expect(spotOf(board, 'b').x).toBe(0);
    expect(spotOf(board, 'locked').x).toBe(900);
  });

  it('★ 栏内成员不参与（它的几何是派生状态，写完会被 relayout 覆盖）', () => {
    const board = boardOf(cardAt('a', 0, 0), cardAt('b', 50, 0, 120, 100, { columnId: 'col1' }));
    expect(alignCards(board, ['a', 'b'], 'left')).toBe(false);
    expect(spotOf(board, 'b').x).toBe(50);
  });

  it('幽灵 id 不算数（选区里残留的已删卡片）', () => {
    const board = boardOf(cardAt('a', 0, 0));
    expect(alignCards(board, ['a', 'ghost'], 'left')).toBe(false);
  });

  it('顶对齐：全部贴到包围盒上边界（`top` 与另外五个方向是同一段代码的两头，别只测一半）', () => {
    const board = boardOf(cardAt('a', 0, 0), cardAt('b', 50, 100));
    expect(alignCards(board, ['a', 'b'], 'top')).toBe(true);
    expect(spotOf(board, 'a').y).toBe(0);
    expect(spotOf(board, 'b').y).toBe(0);
  });
});

describe('distributeCards（T3.13 / F5-04）', () => {
  it('水平等距：首尾不动，中间的空隙被均分', () => {
    const board = boardOf(
      cardAt('a', 0, 0, 120),
      cardAt('b', 150, 0, 120),
      cardAt('c', 400, 0, 120),
    );
    expect(distributeCards(board, ['a', 'b', 'c'], 'x')).toBe(true);
    // 跨度 520、占宽 360 → 两个空隙各 80
    expect(spotOf(board, 'a').x).toBe(0);
    expect(spotOf(board, 'b').x).toBe(200);
    expect(spotOf(board, 'c').x).toBe(400);
  });

  it('★ 均分的是「看得见的空隙」，不是中心点（尺寸不一时才看得出差别）', () => {
    const board = boardOf(
      cardAt('a', 0, 0, 120, 100),
      cardAt('b', 0, 60, 120, 60),
      cardAt('c', 0, 200, 120, 120),
      cardAt('d', 0, 400, 120, 80),
    );
    expect(distributeCards(board, ['a', 'b', 'c', 'd'], 'y')).toBe(true);

    // 首尾不动
    expect(spotOf(board, 'a').y).toBe(0);
    expect(spotOf(board, 'd').y).toBe(400);

    // 跨度 480、占高 360 → 三个空隙各 40
    const a = board.cards.find((card) => card.id === 'a');
    const b = board.cards.find((card) => card.id === 'b');
    const c = board.cards.find((card) => card.id === 'c');
    const d = board.cards.find((card) => card.id === 'd');
    if (!a || !b || !c || !d) throw new Error('missing card');
    expect(b.y).toBe(140);
    expect(c.y).toBe(240);
    const first = b.y - (a.y + a.height);
    const second = c.y - (b.y + b.height);
    const third = d.y - (c.y + c.height);
    expect(first).toBe(40);
    expect(second).toBe(40);
    expect(third).toBe(40);
  });

  it('两张 → false（首尾都不动，等于什么都没做）', () => {
    const board = boardOf(cardAt('a', 0, 0), cardAt('b', 300, 0));
    expect(distributeCards(board, ['a', 'b'], 'x')).toBe(false);
    expect(spotOf(board, 'b').x).toBe(300);
  });

  it('幂等：已经均匀了再按一次返回 false', () => {
    const board = boardOf(
      cardAt('a', 0, 0, 120),
      cardAt('b', 200, 0, 120),
      cardAt('c', 400, 0, 120),
    );
    expect(distributeCards(board, ['a', 'b', 'c'], 'x')).toBe(false);
  });

  it('★ 跨度装不下时产生负间隙：均匀重叠，而不是把卡片压扁或拒绝执行', () => {
    const board = boardOf(cardAt('a', 0, 0, 120), cardAt('b', 10, 0, 120), cardAt('c', 40, 0, 120));
    expect(distributeCards(board, ['a', 'b', 'c'], 'x')).toBe(true);
    expect([spotOf(board, 'a').x, spotOf(board, 'b').x, spotOf(board, 'c').x]).toEqual([0, 20, 40]);
  });

  it('锁定卡 / 栏内卡 / 幽灵 id 不参与', () => {
    const board = boardOf(
      cardAt('a', 0, 0),
      cardAt('b', 300, 0),
      cardAt('c', 900, 0, 120, 100, { locked: true }),
    );
    // 可移动的只有 a、b 两张 → 分布无事可做
    expect(distributeCards(board, ['a', 'b', 'c'], 'x')).toBe(false);

    const board2 = boardOf(
      cardAt('a', 0, 0, 120),
      cardAt('b', 150, 0, 120),
      cardAt('c', 400, 0, 120),
      cardAt('col', 700, 0, 120, 100, { columnId: 'col1' }),
    );
    expect(distributeCards(board2, ['a', 'b', 'c', 'col'], 'x')).toBe(true);
    expect(spotOf(board2, 'col').x).toBe(700);
  });
});

// ─────────────────────────────────────────────────────────────
// 编组 / 取消编组（T3.14 / F5-05、D-07）
// ─────────────────────────────────────────────────────────────

describe('编组（T3.14 / F5-05）', () => {
  it('把一批卡片收进一个新编组，成员原地不动', () => {
    const board = boardOf(cardAt('a', 10, 20), cardAt('b', 200, 30), cardAt('c', 1, 1));
    const id = groupCards(board, ['a', 'b']);
    expect(id).not.toBeNull();
    expect(groupOfCard(board, 'a')?.cardIds).toEqual(['a', 'b']);
    expect(groupOfCard(board, 'c')).toBeNull();
    // 编组不改变几何（包围盒实时由成员算）
    expect(spotOf(board, 'a')).toEqual({ x: 10, y: 20 });
  });

  it('不足 MIN_GROUP_SIZE 张 → null，且不留下任何记录', () => {
    const board = boardOf(cardAt('a', 0, 0), cardAt('b', 0, 0));
    expect(groupCards(board, ['a'])).toBeNull();
    expect(board.groups).toEqual([]);
    expect(groupCards(board, ['a', 'ghost'])).toBeNull();
    expect(board.groups).toEqual([]);
    expect(MIN_GROUP_SIZE).toBe(2);
  });

  it('★ 对同一个编组再按一次 ⌘G 是空操作（不重建、不换 id、不记历史）', () => {
    const board = boardOf(cardAt('a', 0, 0), cardAt('b', 0, 0));
    const first = groupCards(board, ['a', 'b']);
    const second = groupCards(board, ['a', 'b']);
    expect(second).toBe(first);
    expect(board.groups).toHaveLength(1);
    // 顺序反过来也是同一个组
    expect(groupCards(board, ['b', 'a'])).toBe(first);
    expect(board.groups).toHaveLength(1);
  });

  it('★ 一个成员最多属于一个编组：旧组掉到 1 个成员时自动解散', () => {
    const board = boardOf(cardAt('a', 0, 0), cardAt('b', 0, 0), cardAt('c', 0, 0));
    groupCards(board, ['a', 'b']);
    groupCards(board, ['b', 'c']);

    expect(board.groups).toHaveLength(1);
    expect(groupOfCard(board, 'b')?.cardIds.sort()).toEqual(['b', 'c']);
    expect(groupOfCard(board, 'a')).toBeNull();
  });

  it('expandGroupSelection：点到组内任意一张 = 选中整组', () => {
    const board = boardOf(cardAt('a', 0, 0), cardAt('b', 0, 0), cardAt('c', 0, 0));
    groupCards(board, ['a', 'b']);

    expect([...expandGroupSelection(board, ['a'])].sort()).toEqual(['a', 'b']);
    expect([...expandGroupSelection(board, ['c'])].sort()).toEqual(['c']);
    expect([...expandGroupSelection(board, ['a', 'c'])].sort()).toEqual(['a', 'b', 'c']);
    // 返回的是新集合：不污染调用方手里那份快照
    const seed = ['a'];
    expandGroupSelection(board, seed);
    expect(seed).toEqual(['a']);
  });

  it('取消编组：选中一个成员 → 整组解散', () => {
    const board = boardOf(cardAt('a', 0, 0), cardAt('b', 0, 0), cardAt('c', 0, 0));
    groupCards(board, ['a', 'b', 'c']);
    expect(ungroupCards(board, ['b'])).toBe(true);
    expect(board.groups).toEqual([]);
  });

  it('取消编组：不在任何编组里的卡片 → false', () => {
    const board = boardOf(cardAt('a', 0, 0), cardAt('b', 0, 0), cardAt('c', 0, 0));
    groupCards(board, ['a', 'b']);
    expect(ungroupCards(board, ['c'])).toBe(false);
    expect(board.groups).toHaveLength(1);
    expect(ungroupCards(board, [])).toBe(false);
  });

  it('★ 删卡片后编组掉到 1 个成员 → 就地解散（不留点不中的空壳）', () => {
    const board = boardOf(cardAt('a', 0, 0), cardAt('b', 0, 0), cardAt('c', 0, 0));
    groupCards(board, ['a', 'b']);
    removeCards(board, ['b']);
    expect(board.groups).toEqual([]);
  });

  it('pruneGroups 只收成员数不足的组', () => {
    const board = boardOf(cardAt('a', 0, 0), cardAt('b', 0, 0));
    groupCards(board, ['a', 'b']);
    board.groups.push({ id: 'g_shell', cardIds: ['a'], label: '' });
    expect(pruneGroups(board)).toBe(true);
    expect(board.groups.map((group) => group.id)).toHaveLength(1);
    expect(pruneGroups(board)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────
// 编组收起（O03）
// ─────────────────────────────────────────────────────────────

describe('setGroupCollapsed / collapsedCardIds（O03）', () => {
  /** 两张卡一组；返回组 id */
  function grouped(): { board: BoardFile; groupId: string } {
    const board = boardOf(cardAt('a', 10, 20), cardAt('b', 300, 400), cardAt('c', 1, 1));
    const groupId = groupCards(board, ['a', 'b']);
    if (!groupId) throw new Error('编组没建起来');
    return { board, groupId };
  }

  it('收起：只翻一个标志，成员位置一动不动', () => {
    const { board, groupId } = grouped();
    expect(setGroupCollapsed(board, groupId, true)).toBe(true);
    expect(groupById(board, groupId)?.collapsed).toBe(true);
    // ★ 成员几何必须原样：展开后要"回到原来的位置"，靠的就是这一刻没动过它们
    expect(spotOf(board, 'a')).toEqual({ x: 10, y: 20 });
    expect(spotOf(board, 'b')).toEqual({ x: 300, y: 400 });
  });

  it('收起 → 成员进隐藏集；组外的卡片不在里面', () => {
    const { board, groupId } = grouped();
    expect(collapsedCardIds(board).size).toBe(0);
    setGroupCollapsed(board, groupId, true);
    expect([...collapsedCardIds(board)].sort()).toEqual(['a', 'b']);
  });

  it('★ 展开是**删掉这个键**，不是写 false（存量文件要能逐字节写回）', () => {
    const { board, groupId } = grouped();
    setGroupCollapsed(board, groupId, true);
    expect(setGroupCollapsed(board, groupId, false)).toBe(true);
    expect('collapsed' in (groupById(board, groupId) as object)).toBe(false);
  });

  it('★ 幂等：重复收起 / 重复展开都返回 false（调用方据此不记历史）', () => {
    const { board, groupId } = grouped();
    expect(setGroupCollapsed(board, groupId, true)).toBe(true);
    expect(setGroupCollapsed(board, groupId, true)).toBe(false);
    expect(setGroupCollapsed(board, groupId, false)).toBe(true);
    expect(setGroupCollapsed(board, groupId, false)).toBe(false);
    // 从没收起过的组，展开也是空操作
    const other = groupCards(board, ['c']);
    expect(other).toBeNull();
  });

  it('组不存在 → false，不抛', () => {
    const { board } = grouped();
    expect(setGroupCollapsed(board, 'g_ghost', true)).toBe(false);
    expect(setGroupCollapsed(board, 'g_ghost', false)).toBe(false);
  });

  it('★ 只有 `=== true` 才算收起（手写的 false / 1 / "yes" 都不算，方向不能猜）', () => {
    const { board, groupId } = grouped();
    const group = groupById(board, groupId);
    if (!group) throw new Error('组没了');
    group.collapsed = false;
    expect(collapsedCardIds(board).size).toBe(0);
    // 从 false 收到 true 仍然是一次真实改动
    expect(setGroupCollapsed(board, groupId, true)).toBe(true);
  });

  it('多个组：只并收起的那些，且并集成一个集合', () => {
    const board = boardOf(
      cardAt('a', 0, 0),
      cardAt('b', 0, 0),
      cardAt('c', 0, 0),
      cardAt('d', 0, 0),
    );
    const first = groupCards(board, ['a', 'b']);
    const second = groupCards(board, ['c', 'd']);
    if (!first || !second) throw new Error('编组没建起来');
    setGroupCollapsed(board, first, true);
    expect([...collapsedCardIds(board)].sort()).toEqual(['a', 'b']);
    setGroupCollapsed(board, second, true);
    expect([...collapsedCardIds(board)].sort()).toEqual(['a', 'b', 'c', 'd']);
    setGroupCollapsed(board, first, false);
    expect([...collapsedCardIds(board)].sort()).toEqual(['c', 'd']);
  });

  it('groupById 找得到返回同一份，找不到返回 null', () => {
    const { board, groupId } = grouped();
    expect(groupById(board, groupId)).toBe(board.groups[0]);
    expect(groupById(board, 'g_ghost')).toBeNull();
  });

  it('setGroupLabel：改了算改，原样提交不算，组不存在也不算', () => {
    const { board, groupId } = grouped();
    expect(setGroupLabel(board, groupId, '需求池')).toBe(true);
    expect(groupById(board, groupId)?.label).toBe('需求池');
    expect(setGroupLabel(board, groupId, '需求池')).toBe(false);
    expect(setGroupLabel(board, groupId, '')).toBe(true);
    expect(setGroupLabel(board, 'g_ghost', 'x')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────
// 查询
// ─────────────────────────────────────────────────────────────

describe('cardById', () => {
  it('找到就返回那张卡本身（不是副本）', () => {
    const board = boardOf(cardAt('a', 10, 20), cardAt('b', 0, 0));

    const card = cardById(board, 'a');

    expect(card).toBe(board.cards[0]);
    expect(card?.x).toBe(10);
  });

  it('找不到返回 **null**（而不是 undefined）：调用方按 null 判，两者混用会漏判', () => {
    const board = boardOf(cardAt('a', 0, 0));

    expect(cardById(board, 'ghost')).toBeNull();
    expect(cardById(boardOf(), 'a')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────
// 整体平移（T1.35：方向键微移 / 拖动的"位移"形态）
// ─────────────────────────────────────────────────────────────

describe('translateCards（T1.35）', () => {
  it('把选中项各挪 (dx, dy)，未选中的一个字节都不动', () => {
    const board = boardOf(cardAt('a', 10, 20), cardAt('b', 100, 200), cardAt('c', 0, 0));

    expect(translateCards(board, ['a', 'b'], 5, -7)).toBe(true);

    expect(spotOf(board, 'a')).toEqual({ x: 15, y: 13 });
    expect(spotOf(board, 'b')).toEqual({ x: 105, y: 193 });
    expect(spotOf(board, 'c')).toEqual({ x: 0, y: 0 });
  });

  it('尺寸不变（平移不是缩放）', () => {
    const board = boardOf(cardAt('a', 0, 0, 120, 100));

    translateCards(board, ['a'], 30, 40);

    expect(board.cards[0]).toMatchObject({ width: 120, height: 100 });
  });

  it('★ 写进文件的数字必须 `roundTo` 过：`0.1 + 0.2` 不该留在 `.nboard` 里', () => {
    const board = boardOf(cardAt('a', 0, 0));

    translateCards(board, ['a'], 0.1 + 0.2, 0);

    // 不 roundTo 的话这里是 0.30000000000000004，git diff 会变成天书
    expect(spotOf(board, 'a').x).toBe(0.3);
  });

  it('零位移 → false（按了方向键但没挪动，不该占一格撤销）', () => {
    const board = boardOf(cardAt('a', 10, 20));

    expect(translateCards(board, ['a'], 0, 0)).toBe(false);
    expect(spotOf(board, 'a')).toEqual({ x: 10, y: 20 });
  });

  it('空选区 → false', () => {
    const board = boardOf(cardAt('a', 10, 20));

    expect(translateCards(board, [], 5, 5)).toBe(false);
    expect(spotOf(board, 'a')).toEqual({ x: 10, y: 20 });
  });

  it('选区里全是幽灵 id → false（已删卡片的残留选中项）', () => {
    const board = boardOf(cardAt('a', 10, 20));

    expect(translateCards(board, ['ghost'], 5, 5)).toBe(false);
    expect(spotOf(board, 'a')).toEqual({ x: 10, y: 20 });
  });

  it('幽灵 id 与真实 id 混在一起 → 真实的那张照挪，不报错', () => {
    const board = boardOf(cardAt('a', 10, 20));

    expect(translateCards(board, ['a', 'ghost'], 3, 4)).toBe(true);
    expect(spotOf(board, 'a')).toEqual({ x: 13, y: 24 });
  });
});

// ─────────────────────────────────────────────────────────────
// 增（T1.34）
// ─────────────────────────────────────────────────────────────

describe('addCards（T1.34）', () => {
  it('空数组 → false（不做无意义写入）', () => {
    const board = boardOf(cardAt('a', 0, 0));

    expect(addCards(board, [])).toBe(false);
    expect(board.cards).toHaveLength(1);
  });

  it('默认压到最上层：新卡的 z 比现有卡都大，且彼此不同 z', () => {
    const board = boardOf(cardAt('a', 0, 0, 120, 100));
    const top = board.cards[0]!.z;

    expect(addCards(board, [cardAt('b', 10, 0), cardAt('c', 20, 0)])).toBe(true);

    const b = cardById(board, 'b');
    const c = cardById(board, 'c');
    expect(b!.z).toBeGreaterThan(top);
    expect(c!.z).toBeGreaterThan(top);
    expect(b!.z).not.toBe(c!.z);
  });

  it('`toFront = false` → 保留传入的 z（从旧文件 / 导入路径来的卡片带自己的层级）', () => {
    const board = boardOf();
    const card = { ...cardAt('a', 0, 0), z: 3 };

    addCards(board, [card], false);

    expect(cardById(board, 'a')?.z).toBe(3);
  });

  it('顺序按传入顺序追加（z 递增的方向与数组顺序一致）', () => {
    const board = boardOf();

    addCards(board, [cardAt('a', 0, 0), cardAt('b', 0, 0), cardAt('c', 0, 0)]);

    expect(board.cards.map((card) => card.id)).toEqual(['a', 'b', 'c']);
    const zs = board.cards.map((card) => card.z);
    expect(zs[0]).toBeLessThan(zs[1]!);
    expect(zs[1]).toBeLessThan(zs[2]!);
  });

  it('落进来的就是**同一批对象**（调用方随后还要拿它们做选中 / 滚动定位）', () => {
    const board = boardOf();
    const card = cardAt('a', 0, 0);

    addCards(board, [card]);

    expect(board.cards[0]).toBe(card);
  });
});

// ─────────────────────────────────────────────────────────────
// 原地复制（F2-00-6：`Alt` + 拖动）
// ─────────────────────────────────────────────────────────────

describe('duplicateCards（F2-00-6）', () => {
  it('空选区 / 全是幽灵 id → 返回空数组，白板不动', () => {
    const board = boardOf(cardAt('a', 0, 0));

    expect(duplicateCards(board, [])).toEqual([]);
    expect(duplicateCards(board, ['ghost'])).toEqual([]);
    expect(board.cards).toHaveLength(1);
  });

  it('副本 id 全新：既不等于源卡，彼此也不同（否则渲染层键冲突）', () => {
    const board = boardOf(cardAt('a', 0, 0), cardAt('b', 0, 0));

    const clones = duplicateCards(board, ['a', 'b']);

    expect(clones).toHaveLength(2);
    const newIds = clones.map((clone) => clone.id);
    expect(newIds).not.toContain('a');
    expect(newIds).not.toContain('b');
    expect(new Set(newIds).size).toBe(2);
  });

  it('位移按 `offset` 且 `roundTo` 过', () => {
    const board = boardOf(cardAt('a', 10, 20));

    duplicateCards(board, ['a'], { x: 24, y: -6 });

    expect(spotOf(board, 'a')).toEqual({ x: 10, y: 20 });
    const clone = board.cards[1]!;
    expect({ x: clone.x, y: clone.y }).toEqual({ x: 34, y: 14 });
  });

  it('★ `content` 是深拷贝：改副本不会把源卡一起改掉', () => {
    const board = boardOf(cardAt('a', 0, 0));
    board.cards[0]!.title = '原卡';

    const [clone] = duplicateCards(board, ['a']);
    clone!.title = '副本';

    expect(cardById(board, 'a')?.title).toBe('原卡');
    expect(clone!.title).toBe('副本');
    expect(clone!.content).not.toBe(board.cards[0]!.content);
  });

  it('副本压在最上层：z 大于所有原卡，且副本之间递增', () => {
    const board = boardOf(cardAt('a', 0, 0), cardAt('b', 0, 0));
    const maxZ = Math.max(...board.cards.map((card) => card.z));

    const clones = duplicateCards(board, ['a', 'b']);

    expect(clones[0]!.z).toBeGreaterThan(maxZ);
    expect(clones[1]!.z).toBeGreaterThan(clones[0]!.z);
  });

  it('返回的克隆就是推进白板的那批对象（调用方拿它做"选中新副本"）', () => {
    const board = boardOf(cardAt('a', 0, 0));

    const clones = duplicateCards(board, ['a'], { x: 10, y: 10 });

    expect(board.cards).toContain(clones[0]);
    expect(board.cards).toHaveLength(2);
  });

  it('只复制选中的那几张，未选中的不动', () => {
    const board = boardOf(cardAt('a', 0, 0), cardAt('b', 0, 0), cardAt('c', 0, 0));

    duplicateCards(board, ['b']);

    expect(board.cards).toHaveLength(4);
    expect(spotOf(board, 'a')).toEqual({ x: 0, y: 0 });
    expect(spotOf(board, 'c')).toEqual({ x: 0, y: 0 });
  });
});

// ─────────────────────────────────────────────────────────────
// 改（T1.39 / T1.40）
// ─────────────────────────────────────────────────────────────

describe('updateCardLook（O38：卡面标记 + 标题整条格式）', () => {
  const boardOf1 = () => boardOf(cardAt('a', 0, 0));

  it('标记：写进去（归一化走与读入口同一份）；空串 / `null` = **删掉这个键**', () => {
    const board = boardOf1();

    expect(updateCardLook(board, ['a'], { icon: '📌' })).toBe(true);
    expect(board.cards[0]!.icon).toBe('📌');

    expect(updateCardLook(board, ['a'], { icon: '' })).toBe(true);
    expect('icon' in board.cards[0]!).toBe(false);

    expect(updateCardLook(board, ['a'], { icon: '🔥' })).toBe(true);
    expect(updateCardLook(board, ['a'], { icon: null })).toBe(true);
    expect('icon' in board.cards[0]!).toBe(false);
  });

  it('★ 值没变 → `false`（不写盘、不占撤销栈），标记也一样', () => {
    const board = boardOf1();
    updateCardLook(board, ['a'], { icon: '📌' });

    expect(updateCardLook(board, ['a'], { icon: '📌' })).toBe(false);
    expect(updateCardLook(board, ['a'], { icon: '' })).toBe(true);
    expect(updateCardLook(board, ['a'], { icon: '' })).toBe(false);
  });

  it('★ 三个开关：`italic` / `underline` 关掉就**删键**；`bold: false` **留住**', () => {
    const board = boardOf1();

    expect(updateCardLook(board, ['a'], { italic: true, underline: true, bold: true })).toBe(true);
    expect(board.cards[0]!.titleStyle).toEqual({ bold: true, italic: true, underline: true });

    updateCardLook(board, ['a'], { italic: false });
    expect('italic' in (board.cards[0]!.titleStyle ?? {})).toBe(false);

    // ★ `bold` 的缺省由样式表决定（标题本来是半粗的）⇒ `false` 有意义，必须留住
    updateCardLook(board, ['a'], { bold: false });
    expect(board.cards[0]!.titleStyle?.bold).toBe(false);
  });

  it('★ 全清空之后连 `titleStyle` 键一起删（不留 `{}` 这种噪声）', () => {
    const board = boardOf1();
    updateCardLook(board, ['a'], { bold: true, italic: true, underline: true, ink: '#123456' });

    updateCardLook(board, ['a'], { bold: true }); // 先回到"有个键"的状态
    updateCardLook(board, ['a'], { italic: false });
    updateCardLook(board, ['a'], { underline: false });
    updateCardLook(board, ['a'], { ink: null });
    // 剩下 `bold: true`：还在
    expect(board.cards[0]!.titleStyle).toEqual({ bold: true });

    updateCardLook(board, ['a'], { bold: true });
    expect('titleStyle' in board.cards[0]!).toBe(true);
  });

  it('字色：规范化（三位缩写展开）；`null` = 回到"按底色算"的那个', () => {
    const board = boardOf1();

    expect(updateCardLook(board, ['a'], { ink: '#ABC' })).toBe(true);
    expect(board.cards[0]!.titleStyle?.ink).toBe('#aabbcc');

    expect(updateCardLook(board, ['a'], { ink: null })).toBe(true);
    expect(board.cards[0]!.titleStyle?.ink).toBeUndefined();
  });

  it('批量：选中几张就改几张；空选区 / 幽灵 id → `false`', () => {
    const board = boardOf(cardAt('a', 0, 0), cardAt('b', 0, 0), cardAt('c', 0, 0));

    expect(updateCardLook(board, ['a', 'b'], { bold: true })).toBe(true);
    expect(board.cards.map((card) => card.titleStyle?.bold)).toEqual([true, true, undefined]);

    expect(updateCardLook(board, [], { bold: true })).toBe(false);
    expect(updateCardLook(board, ['ghost'], { bold: true })).toBe(false);
  });
});

describe('updateCards（T1.39 / T1.40）', () => {
  it('空选区 / 空 patch → false', () => {
    const board = boardOf(cardAt('a', 0, 0));

    expect(updateCards(board, [], { title: 'x' })).toBe(false);
    expect(updateCards(board, ['a'], {})).toBe(false);
  });

  it('全是不存在的 id → false（选区里只剩幽灵）', () => {
    const board = boardOf(cardAt('a', 0, 0));

    expect(updateCards(board, ['ghost'], { title: 'x' })).toBe(false);
    expect(board.cards[0]!.title).toBe('');
  });

  it('★ 值本来就相等 → false：不许产生"无变化的写入"（否则每次点击都递增 revision）', () => {
    const board = boardOf(cardAt('a', 0, 0));
    const original = board.cards[0]!.showTitle;

    expect(updateCards(board, ['a'], { showTitle: original })).toBe(false);
  });

  it('值不同 → true 且写入', () => {
    const board = boardOf(cardAt('a', 0, 0));

    expect(updateCards(board, ['a'], { title: '新标题' })).toBe(true);
    expect(board.cards[0]!.title).toBe('新标题');
  });

  it('部分字段变了就返回 true，没变的字段不被写脏', () => {
    const board = boardOf(cardAt('a', 0, 0));

    expect(updateCards(board, ['a'], { title: '标题', showTitle: true })).toBe(true);
    // 第二次只有 title 变 → 仍要 true（一个字段变了就是变了）
    expect(updateCards(board, ['a'], { title: '改过', showTitle: true })).toBe(true);
    expect(board.cards[0]!.title).toBe('改过');
  });

  it('★ `null` 是**有效值**不是"没传"：`accent: null` / `columnId: null` / `presentStep: null` 都得写进去', () => {
    const board = boardOf(cardAt('a', 0, 0));
    board.cards[0]!.accent = '#ff0000';
    board.cards[0]!.columnId = 'col1';
    board.cards[0]!.presentStep = 3;

    expect(updateCards(board, ['a'], { accent: null })).toBe(true);
    expect(updateCards(board, ['a'], { columnId: null })).toBe(true);
    expect(updateCards(board, ['a'], { presentStep: null })).toBe(true);

    expect(board.cards[0]!.accent).toBeNull();
    expect(board.cards[0]!.columnId).toBeNull();
    expect(board.cards[0]!.presentStep).toBeNull();
  });

  it('★ `undefined` 才是"没传"：写了 `undefined` 的字段一律跳过', () => {
    const board = boardOf(cardAt('a', 0, 0));
    board.cards[0]!.title = '原标题';

    expect(updateCards(board, ['a'], { title: undefined, showTitle: undefined })).toBe(false);
    expect(board.cards[0]!.title).toBe('原标题');
  });

  it('★ `order: 0` 与 `false` 也是有效值（0 / false 是假值但不是"没传"）', () => {
    const board = boardOf(cardAt('a', 0, 0));
    board.cards[0]!.order = 5;
    board.cards[0]!.showTitle = true;

    expect(updateCards(board, ['a'], { order: 0, showTitle: false })).toBe(true);
    expect(board.cards[0]!.order).toBe(0);
    expect(board.cards[0]!.showTitle).toBe(false);
  });

  it('批量：选中几张就改几张，未选中的不受影响', () => {
    const board = boardOf(cardAt('a', 0, 0), cardAt('b', 0, 0), cardAt('c', 0, 0));

    expect(updateCards(board, ['a', 'b'], { locked: true })).toBe(true);

    expect(board.cards.map((card) => card.locked)).toEqual([true, true, false]);
  });

  it('几何字段**不归它管**（避免与 `applyCardRects` 两条路互相覆盖）', () => {
    const board = boardOf(cardAt('a', 10, 20));
    const originalZ = board.cards[0]!.z;

    // 类型上 `CardPatch` 不含 `x` / `y`，运行时也真的把它们丢掉 ——
    // 否则这条写入会绕过 `roundTo`、`MIN_CARD_SIZE` 钳制与"锁定卡不移动"
    expect(
      updateCards(board, ['a'], { x: 999, y: 999, z: 999 } as unknown as { title?: string }),
    ).toBe(false);
    expect(spotOf(board, 'a')).toEqual({ x: 10, y: 20 });
    expect(board.cards[0]!.z).toBe(originalZ);
  });

  it('几何字段与合法字段混在一起 → 只写合法字段，几何一律丢掉', () => {
    const board = boardOf(cardAt('a', 10, 20));

    expect(
      updateCards(board, ['a'], { title: '留下', x: 999, width: 999 } as unknown as {
        title?: string;
      }),
    ).toBe(true);

    expect(board.cards[0]!.title).toBe('留下');
    expect(spotOf(board, 'a')).toEqual({ x: 10, y: 20 });
    expect(board.cards[0]!.width).toBe(120);
  });

  it('未知字段（`id` / 任意拼错的键）同样写不进去', () => {
    const board = boardOf(cardAt('a', 10, 20));

    expect(
      updateCards(board, ['a'], { id: 'hacked', titel: '拼错的' } as unknown as {
        title?: string;
      }),
    ).toBe(false);
    expect(board.cards[0]!.id).toBe('a');
    expect(board.cards[0]!.title).toBe('');
  });
});

describe('cloneJson', () => {
  it('深拷贝：嵌套对象与数组都断开引用', () => {
    const source = { a: { b: [1, 2, 3] }, c: 'x' };

    const copy = cloneJson(source);
    copy.a.b.push(4);

    expect(source.a.b).toEqual([1, 2, 3]);
  });

  it('内容相等但不是同一个对象', () => {
    const source = { a: 1 };

    const copy = cloneJson(source);

    expect(copy).toEqual(source);
    expect(copy).not.toBe(source);
  });
});

// ─────────────────────────────────────────────────────────────
// 卡片旋转（T7.06 / `F2-00-10`）
//
// 与"移动 / 缩放"共用 `BoardRepository.mutate` 的**返回值契约**：
// 谎报"改了"会让文件在每次松手时都被写一遍；谎报"没改"会吞掉真实的转动。
// 另外两件事只有这里能钉死：归一化在哪一层做、`0` 为什么写成删键。
// ─────────────────────────────────────────────────────────────

describe('applyCardRotations', () => {
  function boardWithCards(): BoardFile {
    const board = createBoardFile();
    board.cards = [
      createCard('note', { id: 'a' }),
      createCard('note', { id: 'b' }),
      createCard('note', { id: 'c' }),
    ];
    return board;
  }

  it('写入角度并如实报告"改了"', () => {
    const board = boardWithCards();

    expect(applyCardRotations(board, [{ id: 'a', degrees: 30 }])).toBe(true);
    expect(board.cards[0].rotation).toBe(30);
    // 没点名的卡片一个字节都不该动
    expect(board.cards[1].rotation).toBeUndefined();
  });

  it('一张卡也没命中 → `false`（`mutate` 靠它决定要不要落盘）', () => {
    const board = boardWithCards();

    expect(applyCardRotations(board, [{ id: 'ghost', degrees: 30 }])).toBe(false);
    expect(applyCardRotations(board, [])).toBe(false);
  });

  it('角度原样不变 → `false`：拖一下手柄又拖回原处不该记一条历史', () => {
    const board = boardWithCards();
    board.cards[0].rotation = 45;

    expect(applyCardRotations(board, [{ id: 'a', degrees: 45 }])).toBe(false);
    expect(board.cards[0].rotation).toBe(45);
  });

  it('★ `0` 是**删键**："没转过"的卡片在 `.nboard` 里不该多出 `rotation: 0`', () => {
    const board = boardWithCards();
    board.cards[0].rotation = 45;

    expect(applyCardRotations(board, [{ id: 'a', degrees: 0 }])).toBe(true);
    expect('rotation' in board.cards[0]).toBe(false);
  });

  it('★ 分栏里的卡片不给转，但**归零仍然放行**（用户 2026-09-17）', () => {
    const board = boardWithCards();
    board.cards[0].columnId = 'col1';
    board.cards[0].rotation = 45;

    // 非零角度：栏内一律拒绝（`false` ⇒ 不进历史栈、不写盘）
    expect(applyCardRotations(board, [{ id: 'a', degrees: 90 }])).toBe(false);
    expect(board.cards[0].rotation).toBe(45);

    // 归零放行：那是把历史数据掰回来的唯一入口（右键菜单「重置角度」）
    expect(applyCardRotations(board, [{ id: 'a', degrees: 0 }])).toBe(true);
    expect('rotation' in board.cards[0]).toBe(false);

    // 栏外的卡片照旧能转
    expect(applyCardRotations(board, [{ id: 'b', degrees: 30 }])).toBe(true);
    expect(board.cards[1].rotation).toBe(30);
  });

  it('★ 落盘前归一化 + 收敛到 1 位小数（手势逐帧算出来的是一长串小数）', () => {
    const board = boardWithCards();

    applyCardRotations(board, [
      { id: 'a', degrees: 89.99999999999999 },
      { id: 'b', degrees: 450 },
      { id: 'c', degrees: -180 },
    ]);

    expect(board.cards[0].rotation).toBe(90);
    expect(board.cards[1].rotation).toBe(90);
    expect(board.cards[2].rotation).toBe(180);
  });

  it('已经是同一个朝向时也不动（归一只发生在比较之前）', () => {
    const board = boardWithCards();
    board.cards[0].rotation = 90;

    expect(applyCardRotations(board, [{ id: 'a', degrees: 450 }])).toBe(false);
    expect(board.cards[0].rotation).toBe(90);
  });

  it('多张同时写：一张变了就算变了', () => {
    const board = boardWithCards();
    board.cards[1].rotation = 10;

    expect(
      applyCardRotations(board, [
        { id: 'a', degrees: 10 },
        { id: 'b', degrees: 10 },
      ]),
    ).toBe(true);
    expect(board.cards[0].rotation).toBe(10);
  });
});
