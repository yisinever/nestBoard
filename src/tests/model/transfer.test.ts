/**
 * 跨白板搬运卡片（`T4.15` / `F7-07`）。
 *
 * 这一组用例盯着的是**几条会被用户立刻察觉、又只能靠单测守住**的规则：
 * 连线只搬两端都在选中集里的、栏内成员资格与演示步骤号都不跟过来、
 * 内容与 id 都必须是新的、相对位置保持而整组对齐落点、
 * 以及**剪贴板里的东西是外部输入**这一点 —— 坏文本必须是"安静地不认"，
 * 不能把粘贴变成一次能把板子写坏的解析。
 */

import { describe, expect, it } from 'vitest';
import {
  createBoardFile,
  createCard,
  createColumn,
  createEdge,
  type CardOverrides,
} from '../../model/factories';
import type { BoardFile, Card } from '../../model/schema';
import { buildCardTransfer, parseCardTransfer, pasteCardTransfer } from '../../model/transfer';

/** 固定 id 的分栏：搬运规则里"栏"要靠 id 认 */
function column(id: string, x: number, y: number) {
  return { ...createColumn({ x, y }), id };
}

const endpoint = (cardId: string) => ({ cardId, side: 'right' as const });

function card(id: string, overrides: CardOverrides<'note'> = {}): Card {
  return { ...createCard('note', overrides), id };
}

/** 一块有两张卡 + 一条连线的板子 */
function source(): BoardFile {
  return createBoardFile({
    cards: [
      card('c_a', { x: 100, y: 200, title: '甲' }),
      card('c_b', { x: 300, y: 260, title: '乙' }),
    ],
    edges: [createEdge(endpoint('c_a'), endpoint('c_b'))],
  });
}

function roundTrip(board: BoardFile, ids: string[]): ReturnType<typeof parseCardTransfer> {
  const text = buildCardTransfer(board, ids);
  expect(text).not.toBeNull();
  return parseCardTransfer(text as string);
}

describe('buildCardTransfer / parseCardTransfer', () => {
  it('搬运载荷能被自己解析回来，卡片与连线都在', () => {
    const transfer = roundTrip(source(), ['c_a', 'c_b']);
    expect(transfer?.cards.map((c) => c.title)).toEqual(['甲', '乙']);
    expect(transfer?.edges).toHaveLength(1);
  });

  it('只搬"两端都在选中集里"的连线', () => {
    const board = source();
    board.cards.push(card('c_c', { x: 0, y: 0, title: '丙' }));
    board.edges.push(createEdge(endpoint('c_b'), endpoint('c_c')));
    // 只选甲、乙：甲—乙 跟着走，乙—丙 留下（丙没被选）
    const transfer = roundTrip(board, ['c_a', 'c_b']);
    expect(transfer?.cards).toHaveLength(2);
    expect(transfer?.edges).toHaveLength(1);
    expect(transfer?.edges[0]?.to.cardId).toBe('c_b');
  });

  it('自由端（没绑卡）的连线不搬', () => {
    const board = source();
    board.edges.push(
      createEdge(endpoint('c_a'), { cardId: '', side: null, point: { x: 0, y: 0 } }),
    );
    const transfer = roundTrip(board, ['c_a', 'c_b']);
    expect(transfer?.edges).toHaveLength(1);
  });

  it('一张卡都没选中 → `null`（调用方据此提示，而不是往剪贴板里塞个空壳）', () => {
    expect(buildCardTransfer(source(), [])).toBeNull();
    expect(buildCardTransfer(source(), ['c_nope'])).toBeNull();
  });

  it('内容坏掉 / 根本不是搬运载荷的文本一律返回 `null`，不抛异常', () => {
    expect(parseCardTransfer('')).toBeNull();
    expect(parseCardTransfer('随便一段文本')).toBeNull();
    expect(parseCardTransfer('{ 坏掉的 json')).toBeNull();
    // 合法 JSON、但不是搬运载荷（比如用户随手复制的别的 JSON）
    expect(parseCardTransfer('{"hello":"world"}')).toBeNull();
    expect(parseCardTransfer('{"nestboard":"nope","cards":[]}')).toBeNull();
  });

  it('载荷里坏掉的卡片会被丢掉而不是原样搬进来（宁缺勿坏），也不抛异常', () => {
    const text = JSON.stringify({
      nestboard: 'cards',
      cards: [
        // 修不回来的（缺 content / 坐标不是数字）：`normalizeCard` 会把整张丢掉
        { id: 'c_bad', type: 'note', title: 5 },
        { id: 'c_ok', type: 'note', x: 1, y: 2, width: 100, height: 80, content: { text: '好卡' } },
      ],
      edges: 'not-an-array',
    });
    const transfer = parseCardTransfer(text);
    expect(transfer?.cards.map((c) => c.id)).toEqual(['c_ok']);
    expect(transfer?.edges).toEqual([]);
  });

  it('★ 缺字段但能救的卡片会被补上默认值（同一张卡在文件里能读，在剪贴板里也能读）', () => {
    const text = JSON.stringify({
      nestboard: 'cards',
      cards: [
        { id: 'c_ok', type: 'note', x: 1, y: 2, width: 100, height: 80, content: { text: '甲' } },
      ],
    });
    const transfer = parseCardTransfer(text);
    expect(transfer?.cards).toHaveLength(1);
    expect(typeof transfer?.cards[0]?.title).toBe('string');
    expect(transfer?.cards[0]?.columnId).toBeNull();
  });
});

describe('pasteCardTransfer', () => {
  function target(): BoardFile {
    return createBoardFile({ cards: [card('t_1', { x: 0, y: 0, title: '目标板原有的卡' })] });
  }

  it('整组按包围盒左上角对齐落点，组内相对位置不变', () => {
    const transfer = roundTrip(source(), ['c_a', 'c_b']);
    const board = target();
    const pasted = pasteCardTransfer(board, transfer!, { x: 1000, y: 500 });
    expect(pasted.map((c) => ({ x: c.x, y: c.y }))).toEqual([
      { x: 1000, y: 500 },
      { x: 1200, y: 560 },
    ]);
  });

  it('id 全新（贴回同一块板也不会撞 id）', () => {
    const board = source();
    const transfer = roundTrip(board, ['c_a', 'c_b']);
    const pasted = pasteCardTransfer(board, transfer!, { x: 0, y: 0 });
    const ids = new Set(board.cards.map((c) => c.id));
    expect(ids.size).toBe(board.cards.length);
    expect(pasted.every((c) => c.id !== 'c_a' && c.id !== 'c_b')).toBe(true);
    // 连线也是新 id，且端点指向新卡片
    expect(board.edges[1]?.from.cardId).toBe(pasted[0]?.id);
    expect(board.edges[1]?.to.cardId).toBe(pasted[1]?.id);
  });

  it('内容深拷贝：改副本不影响原卡', () => {
    const board = source();
    const transfer = roundTrip(board, ['c_a']);
    const pasted = pasteCardTransfer(board, transfer!, { x: 0, y: 0 });
    expect(pasted[0]?.content).not.toBe(board.cards[0]?.content);
    expect(pasted[0]?.content).toEqual(board.cards[0]?.content);
  });

  it('★ 栏内成员资格不跟过来（目标板没有那个栏）', () => {
    const board = createBoardFile({
      columns: [column('col_a', 0, 0)],
      cards: [card('c_a', { x: 10, y: 10, columnId: 'col_a', order: 3, title: '栏内的卡' })],
    });
    const transfer = roundTrip(board, ['c_a']);
    const targetBoard = createBoardFile({});
    const pasted = pasteCardTransfer(targetBoard, transfer!, { x: 0, y: 0 });
    expect(pasted[0]?.columnId).toBeNull();
    expect(pasted[0]?.order).toBe(0);
  });

  it('★ 演示步骤号不跟过来（演示路径是目标板自己的事）', () => {
    const board = source();
    board.cards[0]!.presentStep = 2;
    const transfer = roundTrip(board, ['c_a']);
    const pasted = pasteCardTransfer(target(), transfer!, { x: 0, y: 0 });
    expect(pasted[0]?.presentStep).toBeNull();
  });

  it('新卡片压在最上层（z 递增，不会被原有卡片盖住）', () => {
    const board = target();
    const before = board.cards[0]!.z;
    const transfer = roundTrip(source(), ['c_a']);
    const pasted = pasteCardTransfer(board, transfer!, { x: 0, y: 0 });
    expect(pasted[0]!.z).toBeGreaterThan(before);
  });

  it('空载荷 = 什么都不做', () => {
    const board = target();
    expect(pasteCardTransfer(board, { cards: [], edges: [] }, { x: 0, y: 0 })).toEqual([]);
    expect(board.cards).toHaveLength(1);
  });
});
