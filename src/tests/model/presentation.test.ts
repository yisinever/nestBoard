/**
 * 演示路径单元测试（J-06 / J-07）。
 *
 * 重点不在"能排个序"，而在几条**会被用户立刻察觉**的边界：
 * 一张都没编过时讲什么、编过一半时会不会捎带上另一半、删掉当前那张之后停在哪、
 * 步骤号被手改成重复 / 空洞时前移后移还准不准。
 *
 * 零配置回退（`readingOrder`）另有一组：它要认分栏 —— 并排的两个分栏
 * 必须是"一栏讲完再讲下一栏"，不能逐行左右横跳。
 */

import { describe, expect, it } from 'vitest';
import { createBoardFile, createCard, createColumn } from '../../model/factories';
import {
  addToPresentation,
  clampStepIndex,
  clearPresentSteps,
  explicitPresentSteps,
  explicitPresentSteps as explicitStepsForTest,
  findPresentTarget,
  movePresentStep,
  nextPresentStep,
  nextStepIndex,
  presentStepOf,
  presentationOrder,
  previousStepIndex,
  readingOrder,
  readingTargets,
  removeFromPresentation,
  setPresentStep,
  stepIndexFromDigit,
} from '../../model/presentation';
import type { BoardFile, Card, Column, Mind } from '../../model/schema';
import { createMind } from '../../model/factories';

/**
 * `2.2.0` 收尾 · 演示对接：**脑图也能进演示路径**。
 *
 * 口径与卡片完全一致（同一个 `presentStep`、同一份阅读顺序），所以这里钉的是三件事：
 * ① 一棵树是**一块**（不拆成节点）；② 卡与脑图混排时步骤号说了算、同号按位置；
 * ③ `readingOrder`（`arrange` 在用）**只返回卡片**，不被脑图搅乱。
 */
describe('presentation × 脑图（2.2.0 收尾）', () => {
  function mindAt(x: number, y: number): Mind {
    return createMind({ path: '', x, y });
  }

  function boardWithMind(): BoardFile {
    const board = boardWithCards();
    board.minds = [mindAt(0, 600)];
    return board;
  }

  it('★ 阅读顺序：一棵树算**一块**，按锚点参与排序；卡片彼此顺序不变', () => {
    const board = boardWithMind();
    const targets = readingTargets(board);
    expect(titles(targets)).toEqual(['A', 'B', 'C', 'D', '(脑图)']);
    // `arrange` 用的那一份**只取卡片**（脑图不在它的搬运范围里）
    expect(readingOrder(board).map((card) => card.title)).toEqual(['A', 'B', 'C', 'D']);
  });

  it('★ 显式步骤：卡与脑图混排，按号升序', () => {
    const board = boardWithMind();
    const mind = board.minds![0];
    const byTitle = (title: string): Card => board.cards.find((c) => c.title === title)!;
    setPresentStep(board, byTitle('C').id, 1);
    setPresentStep(board, mind.id, 2);
    setPresentStep(board, byTitle('A').id, 3);

    expect(titles(presentationOrder(board))).toEqual(['C', '(脑图)', 'A']);
  });

  it('★ 加入 / 移出 / 前移 / 清空：对脑图与卡片是同一套', () => {
    const board = boardWithMind();
    const mind = board.minds![0];
    const card = board.cards[0];

    expect(addToPresentation(board, [card.id, mind.id])).toBe(true);
    expect(presentStepOf(card)).toBe(1);
    expect(presentStepOf(mind)).toBe(2);
    // 已在路径里的再加一次 = 没变化
    expect(addToPresentation(board, [mind.id])).toBe(false);
    // 下一号跟着最大值走
    expect(nextPresentStep(board)).toBe(3);

    // 前移：树挪到卡片前面（号互换）
    expect(movePresentStep(board, mind.id, -1)).toBe(true);
    expect(explicitPresentSteps(board).map((item) => item.id)).toEqual([mind.id, card.id]);
    // 到头再前移 = 不动
    expect(movePresentStep(board, mind.id, -1)).toBe(false);

    expect(removeFromPresentation(board, [mind.id])).toBe(true);
    expect(presentStepOf(mind)).toBeNull();
    expect(setPresentStep(board, card.id, 5)).toBe(true);
    expect(clearPresentSteps(board)).toBe(true);
    expect(presentStepOf(card)).toBeNull();
    expect(explicitStepsForTest(board)).toEqual([]);
  });

  it('`findPresentTarget` 两种都找得到（找不到给 `null`）', () => {
    const board = boardWithMind();
    expect(findPresentTarget(board, board.minds![0].id)?.kind).toBe('mind');
    expect(findPresentTarget(board, board.cards[0].id)?.kind).toBe('card');
    expect(findPresentTarget(board, 'c_不存在')).toBeNull();
  });
});

const titles = (
  targets: readonly (
    { kind: 'card'; card: { title: string } } | { kind: 'mind' } | { title: string }
  )[],
): string[] =>
  targets.map((item) =>
    'kind' in item ? (item.kind === 'card' ? item.card.title : '(脑图)') : item.title,
  );

/** 固定 id 的分栏：`createColumn` 的 id 是随机生成的，而本组用例要靠 id 认"栏" */
function column(id: string, x: number, y: number): Column {
  return { ...createColumn({ x, y }), id };
}

function boardWithCards(): BoardFile {
  const board = createBoardFile();
  board.cards = [
    createCard('note', { x: 0, y: 0, title: 'A' }),
    createCard('note', { x: 400, y: 0, title: 'B' }),
    createCard('note', { x: 0, y: 300, title: 'C' }),
    createCard('note', { x: 400, y: 300, title: 'D' }),
  ];
  return board;
}

const idOf = (board: BoardFile, title: string): string => {
  const card = board.cards.find((item) => item.title === title);
  if (!card) throw new Error(`没有标题为 ${title} 的卡片`);
  return card.id;
};

describe('presentationOrder', () => {
  it('一张都没编过 → 按阅读顺序讲全部（先上后下、先左后右）', () => {
    const board = boardWithCards();
    // 打乱数组顺序，确认结果与数组顺序无关
    board.cards.reverse();
    expect(titles(presentationOrder(board))).toEqual(['A', 'B', 'C', 'D']);
  });

  it('编过序 → 严格按步骤号，且**不**捎带没编过的卡', () => {
    const board = boardWithCards();
    setPresentStep(board, idOf(board, 'C'), 1);
    setPresentStep(board, idOf(board, 'A'), 2);
    expect(titles(presentationOrder(board))).toEqual(['C', 'A']);
  });

  it('坐标完全重合时按 id 兜底，顺序稳定不随数组顺序漂移', () => {
    const board = createBoardFile();
    board.cards = [
      createCard('note', { id: 'c_b', x: 10, y: 10 }),
      createCard('note', { id: 'c_a', x: 10, y: 10 }),
    ];
    const first = presentationOrder(board).map((card) => card.id);
    expect(first).toEqual(['c_a', 'c_b']);
    board.cards.reverse();
    expect(presentationOrder(board).map((card) => card.id)).toEqual(first);
  });

  it('步骤号重复时按阅读顺序兜底（手改文件的常见形态）', () => {
    const board = boardWithCards();
    for (const card of board.cards) card.presentStep = 2;
    expect(titles(presentationOrder(board))).toEqual(['A', 'B', 'C', 'D']);
  });
});

describe('readingOrder（零配置回退：分栏是一块）', () => {
  /**
   * 两块**并排**的分栏，栏内成员是"同高一行行堆叠"的（这就是真实布局：
   * 左栏第 1 张与右栏第 1 张的 `y` 一样）。
   */
  function twoColumns(): BoardFile {
    return createBoardFile({
      columns: [column('col_left', 0, 0), column('col_right', 500, 0)],
      cards: [
        createCard('note', {
          id: 'c_l1',
          title: '左1',
          columnId: 'col_left',
          order: 1,
          x: 16,
          y: 16,
        }),
        createCard('note', {
          id: 'c_l2',
          title: '左2',
          columnId: 'col_left',
          order: 2,
          x: 16,
          y: 200,
        }),
        createCard('note', {
          id: 'c_l3',
          title: '左3',
          columnId: 'col_left',
          order: 3,
          x: 16,
          y: 400,
        }),
        createCard('note', {
          id: 'c_r1',
          title: '右1',
          columnId: 'col_right',
          order: 1,
          x: 516,
          y: 16,
        }),
        createCard('note', {
          id: 'c_r2',
          title: '右2',
          columnId: 'col_right',
          order: 2,
          x: 516,
          y: 200,
        }),
      ],
    });
  }

  it('并排分栏 → 一栏讲完再讲下一栏（不逐行左右横跳）', () => {
    expect(titles(readingOrder(twoColumns()))).toEqual(['左1', '左2', '左3', '右1', '右2']);
    // 这块板子走零配置演示时，用的就是这套顺序
    expect(titles(presentationOrder(twoColumns()))).toEqual(['左1', '左2', '左3', '右1', '右2']);
  });

  it('栏内按栏内顺序（`order`），不是按坐标', () => {
    const board = createBoardFile({
      columns: [column('col_a', 0, 0)],
      cards: [
        // `order` 与 `y` 故意相反：以 `order` 为准（栏内顺序是用户拖出来的）
        createCard('note', { id: 'c_2', title: '第二', columnId: 'col_a', order: 2, y: 16 }),
        createCard('note', { id: 'c_1', title: '第一', columnId: 'col_a', order: 1, y: 400 }),
      ],
    });
    expect(titles(readingOrder(board))).toEqual(['第一', '第二']);
  });

  it('栏上方的标题卡先讲（散卡按自己的位置参与块级排序）', () => {
    const board = createBoardFile({
      columns: [column('col_a', 0, 300)],
      cards: [
        createCard('note', { id: 'c_title', title: '标题', y: 0 }),
        createCard('note', { id: 'c_a1', title: '栏内1', columnId: 'col_a', order: 1, y: 316 }),
      ],
    });
    expect(titles(readingOrder(board))).toEqual(['标题', '栏内1']);
  });

  it('散卡按位置插在两个分栏之间', () => {
    const board = createBoardFile({
      columns: [column('col_a', 0, 0), column('col_b', 0, 600)],
      cards: [
        createCard('note', { id: 'c_b1', title: '下栏', columnId: 'col_b', order: 1, y: 616 }),
        createCard('note', { id: 'c_mid', title: '中间', y: 400 }),
        createCard('note', { id: 'c_a1', title: '上栏', columnId: 'col_a', order: 1, y: 16 }),
      ],
    });
    expect(titles(readingOrder(board))).toEqual(['上栏', '中间', '下栏']);
  });

  it('`columnId` 指向一个已不存在的分栏 → 当作散卡，且一张都不丢', () => {
    const board = twoColumns();
    board.cards.push(
      createCard('note', { id: 'c_orphan', title: '孤儿', columnId: 'col_gone', y: 900 }),
    );
    const order = readingOrder(board);
    expect(titles(order)).toEqual(['左1', '左2', '左3', '右1', '右2', '孤儿']);
    // "恰好出现一次"：丢卡＝演示里凭空少讲一张，重复卡＝同一张讲两遍
    expect(new Set(order.map((card) => card.id)).size).toBe(board.cards.length);
  });

  it('两块分栏上下排时按栏的上边排序，与栏内卡片位置无关', () => {
    const board = createBoardFile({
      columns: [column('col_low', 0, 800), column('col_high', 0, 100)],
      cards: [
        createCard('note', { id: 'c_1', title: '晚来的栏', columnId: 'col_low', order: 1 }),
        createCard('note', { id: 'c_2', title: '早的栏', columnId: 'col_high', order: 1 }),
      ],
    });
    expect(titles(readingOrder(board))).toEqual(['早的栏', '晚来的栏']);
  });

  it('空分栏不产生空档，也不影响其余顺序', () => {
    const board = twoColumns();
    board.columns.push(column('col_empty', 1000, 0));
    expect(titles(readingOrder(board))).toEqual(['左1', '左2', '左3', '右1', '右2']);
  });
});

describe('explicitPresentSteps / presentStepOf', () => {
  it('只收步骤号非空的卡，并按号升序', () => {
    const board = boardWithCards();
    setPresentStep(board, idOf(board, 'B'), 5);
    setPresentStep(board, idOf(board, 'D'), 1);
    expect(titles(explicitPresentSteps(board))).toEqual(['D', 'B']);
  });

  it('脏值（NaN / undefined）按"不在路径里"处理，不污染排序', () => {
    const board = boardWithCards();
    const card = board.cards[0];
    (card as { presentStep: unknown }).presentStep = Number.NaN;
    expect(presentStepOf(card)).toBeNull();
    expect(explicitPresentSteps(board)).toHaveLength(0);
  });
});

describe('setPresentStep', () => {
  it('写号 / 移出都生效', () => {
    const board = boardWithCards();
    const id = idOf(board, 'A');
    expect(setPresentStep(board, id, 3)).toBe(true);
    expect(board.cards.find((card) => card.id === id)?.presentStep).toBe(3);
    expect(setPresentStep(board, id, null)).toBe(true);
    expect(board.cards.find((card) => card.id === id)?.presentStep).toBeNull();
  });

  it('值没变返回 false（上层靠它决定要不要记历史 / 标脏）', () => {
    const board = boardWithCards();
    const id = idOf(board, 'A');
    setPresentStep(board, id, 2);
    expect(setPresentStep(board, id, 2)).toBe(false);
    expect(setPresentStep(board, 'c_missing', 1)).toBe(false);
  });

  it('0 / 负数 / 小数被收成"≥1 的整数"', () => {
    const board = boardWithCards();
    const id = idOf(board, 'A');
    setPresentStep(board, id, 0);
    expect(board.cards[0].presentStep).toBe(1);
    setPresentStep(board, id, 2.6);
    expect(board.cards[0].presentStep).toBe(3);
  });
});

describe('addToPresentation / removeFromPresentation / clearPresentSteps', () => {
  it('按传入顺序追加到末尾，已在路径里的跳过', () => {
    const board = boardWithCards();
    addToPresentation(board, [idOf(board, 'C')]);
    addToPresentation(board, [idOf(board, 'C'), idOf(board, 'A')]);
    expect(titles(presentationOrder(board))).toEqual(['C', 'A']);
    expect(board.cards.find((card) => card.title === 'A')?.presentStep).toBe(2);
  });

  it('一张都没加过时从 1 开始编号', () => {
    const board = boardWithCards();
    expect(nextPresentStep(board)).toBe(1);
    addToPresentation(board, [idOf(board, 'D')]);
    expect(nextPresentStep(board)).toBe(2);
  });

  it('重复加入 / 不存在的 id 返回 false 且不动现有编号', () => {
    const board = boardWithCards();
    const id = idOf(board, 'A');
    addToPresentation(board, [id]);
    expect(addToPresentation(board, [id, 'c_missing'])).toBe(false);
    expect(board.cards.find((card) => card.id === id)?.presentStep).toBe(1);
  });

  it('移出只动被点的卡，其余编号保持原样（不做重编号）', () => {
    const board = boardWithCards();
    addToPresentation(board, [idOf(board, 'A'), idOf(board, 'B'), idOf(board, 'C')]);
    removeFromPresentation(board, [idOf(board, 'B')]);
    expect(titles(presentationOrder(board))).toEqual(['A', 'C']);
    expect(board.cards.find((card) => card.title === 'C')?.presentStep).toBe(3);
  });

  it('清空把整条路径抹掉并报告是否有变化', () => {
    const board = boardWithCards();
    expect(clearPresentSteps(board)).toBe(false);
    addToPresentation(board, [idOf(board, 'A')]);
    expect(clearPresentSteps(board)).toBe(true);
    expect(explicitPresentSteps(board)).toHaveLength(0);
    // 清空之后回退到"讲全部"
    expect(titles(presentationOrder(board))).toEqual(['A', 'B', 'C', 'D']);
  });
});

describe('movePresentStep', () => {
  it('前移 / 后移交换相邻两步', () => {
    const board = boardWithCards();
    addToPresentation(board, [idOf(board, 'A'), idOf(board, 'B'), idOf(board, 'C')]);
    expect(movePresentStep(board, idOf(board, 'C'), -1)).toBe(true);
    expect(titles(presentationOrder(board))).toEqual(['A', 'C', 'B']);
    expect(movePresentStep(board, idOf(board, 'C'), 1)).toBe(true);
    expect(titles(presentationOrder(board))).toEqual(['A', 'B', 'C']);
  });

  it('到头 / 到末尾返回 false，**不**绕到另一端', () => {
    const board = boardWithCards();
    addToPresentation(board, [idOf(board, 'A'), idOf(board, 'B')]);
    expect(movePresentStep(board, idOf(board, 'A'), -1)).toBe(false);
    expect(movePresentStep(board, idOf(board, 'B'), 1)).toBe(false);
    expect(movePresentStep(board, 'c_missing', 1)).toBe(false);
    expect(titles(presentationOrder(board))).toEqual(['A', 'B']);
  });

  it('步骤号有重复 / 空洞时先整体重编号，前移后移仍然准确', () => {
    const board = boardWithCards();
    const [a, b, c] = board.cards;
    b.presentStep = 2;
    c.presentStep = 2; // 重复
    a.presentStep = 9; // 空洞
    expect(titles(presentationOrder(board))).toEqual(['B', 'C', 'A']);
    expect(movePresentStep(board, a.id, -1)).toBe(true);
    expect(titles(presentationOrder(board))).toEqual(['B', 'A', 'C']);
    // 重编号后路径里只剩 1..3（板上的 D 本来就没进路径，仍是 null）
    const steps = board.cards
      .filter((card) => card.presentStep !== null)
      .map((card) => card.presentStep);
    expect(steps.sort()).toEqual([1, 2, 3]);
  });
});

describe('步骤导航', () => {
  it('下一步 / 上一步在两端停住，不循环', () => {
    expect(nextStepIndex(0, 3)).toBe(1);
    expect(nextStepIndex(2, 3)).toBe(2);
    expect(previousStepIndex(2, 3)).toBe(1);
    expect(previousStepIndex(0, 3)).toBe(0);
  });

  it('空路径不产生负下标', () => {
    expect(nextStepIndex(0, 0)).toBe(0);
    expect(previousStepIndex(0, 0)).toBe(0);
  });

  it('数字键 1~9 落在范围内才跳转', () => {
    expect(stepIndexFromDigit('1', 3)).toBe(0);
    expect(stepIndexFromDigit('3', 3)).toBe(2);
    expect(stepIndexFromDigit('4', 3)).toBeNull();
    expect(stepIndexFromDigit('0', 3)).toBeNull();
    expect(stepIndexFromDigit('12', 12)).toBeNull();
  });

  it('clampStepIndex 把越界下标收进范围（当前卡被删后停在原位）', () => {
    expect(clampStepIndex(5, 3)).toBe(2);
    expect(clampStepIndex(-1, 3)).toBe(0);
    expect(clampStepIndex(1, 0)).toBe(0);
  });
});
