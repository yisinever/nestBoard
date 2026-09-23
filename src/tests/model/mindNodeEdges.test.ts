/**
 * **脑图节点作为连线端点**（`2.2.0` 批 3）的模型层测试。
 *
 * 这一组钉的是那条"只改端点来源、不动几何"的承诺到底做到了没有：
 *
 * * 端点的**身份键**（卡片 / 分栏 / 整棵脑图是它们自己的 id，节点是 `脑图id/节点id`）；
 * * `edgeEndpoints` **只认一个键换一个矩形** —— 给它节点矩形，它就算得出节点上的锚点，
 *   一行新公式都不用加；
 * * 取不到节点矩形（那份 `.nestmind` 还没读到 / 节点被折叠收起来了）⇒ **这条线不画**，
 *   但数据**一个字都不删**；
 * * `addEdges` 的三道过滤在"有节点"这一维上的表现：同一棵脑图里两个不同节点之间的线
 *   合法，同一个节点连自己才是自环；节点不同 ⇒ 不算重复；
 * * 删掉节点之后**清掉指向它的线**（`pruneMindNodeEdges`），而且只清**这一棵**的。
 *
 * ★ 不涉及 DOM：几何只喂一张"键 → 矩形"的表，正是渲染层的真实用法。
 */

import { describe, expect, it } from 'vitest';
import {
  endpointAnchorKey,
  endpointOfKey,
  nodeEndpointKey,
  splitEndpointKey,
} from '../../model/schema';
import { addEdges, edgeEndpoints, pruneMindNodeEdges } from '../../model/edges';
import { addMind } from '../../model/ops';
import { createBoardFile, createCard, createEdge, createMind } from '../../model/factories';
import { normalizeBoardFile } from '../../model/validate';
import { serializeBoard } from '../../io/BoardRepository';
import { createMindFile } from '../../mind/model/factories';
import type { BoardFile, Mind } from '../../model/schema';
import type { Rect } from '../../util/geometry';

const MIND_ID = 'nm_1';
const NODE_A = 'n_a';
const NODE_B = 'n_b';

/**
 * 一棵**指定 id** 的脑图（`createMind` 的 overrides 故意不收 `id`：id 由工厂发，
 * 调用方不该造它 —— 测试要点名指一棵，所以在这里补一次）。
 */
function mindWithId(id: string, extra: Partial<Mind> = {}): Mind {
  return { ...createMind({ path: '' }), id, ...extra };
}

/** 一张"键 → 矩形"的表（与 `MindLayer.nodeRects()` 给渲染层的形状一致） */
function lookup(table: Record<string, Rect>) {
  return (key: string): Rect | null => table[key] ?? null;
}

describe('节点端点 · 身份键（一层字符串装下四种端点）', () => {
  it('卡片 / 分栏 / 整棵脑图：键就是它们的 id（与从前一字不差）', () => {
    expect(endpointAnchorKey({ cardId: 'c_1', side: null })).toBe('c_1');
    expect(endpointAnchorKey({ cardId: 'col_1', side: 'top' })).toBe('col_1');
    expect(endpointAnchorKey({ cardId: MIND_ID, side: null })).toBe(MIND_ID);
  });

  it('★ 节点端点：`脑图id/节点id` 拼得出来、拆得回去', () => {
    expect(nodeEndpointKey(MIND_ID, NODE_A)).toBe(`${MIND_ID}/${NODE_A}`);
    expect(endpointAnchorKey({ cardId: MIND_ID, nodeId: NODE_A, side: null })).toBe(
      `${MIND_ID}/${NODE_A}`,
    );
    expect(splitEndpointKey(`${MIND_ID}/${NODE_A}`)).toEqual({
      cardId: MIND_ID,
      nodeId: NODE_A,
    });
    // 没有分隔符 ⇒ 不是节点键（老键照旧）
    expect(splitEndpointKey('c_1')).toEqual({ cardId: 'c_1', nodeId: null });
  });

  it('★ 键翻回端点：节点多带一层 `nodeId`，卡片 / 分栏一个字都不多', () => {
    expect(endpointOfKey(`${MIND_ID}/${NODE_A}`, 'right')).toEqual({
      cardId: MIND_ID,
      nodeId: NODE_A,
      side: 'right',
    });
    expect(endpointOfKey('c_1', null)).toEqual({ cardId: 'c_1', side: null });
  });
});

describe('节点端点 · 几何（一个键换一个矩形）', () => {
  const nodeRect: Rect = { x: 100, y: 100, width: 60, height: 30 };
  const cardRect: Rect = { x: 400, y: 100, width: 100, height: 50 };

  it('★★ 把节点矩形喂进同一张表 ⇒ 锚点落在**节点**的四边中点上', () => {
    const edge = createEdge(
      { cardId: MIND_ID, nodeId: NODE_A, side: 'right' },
      { cardId: 'c_1', side: 'left' },
    );
    const ends = edgeEndpoints(
      edge,
      lookup({ [nodeEndpointKey(MIND_ID, NODE_A)]: nodeRect, c_1: cardRect }),
    );

    // 右边中点 / 左边中点 —— 与卡片端点走的是同一个 `cardAnchor`
    expect(ends?.from).toEqual({ x: 160, y: 115 });
    expect(ends?.to).toEqual({ x: 400, y: 125 });
    expect(ends?.fromSide).toBe('right');
    expect(ends?.toSide).toBe('left');
  });

  it('★ 拿不到节点矩形 ⇒ 这条线**一个字都不画**（而不是回落到原点画一条乱线）', () => {
    const edge = createEdge(
      { cardId: MIND_ID, nodeId: NODE_A, side: null },
      { cardId: 'c_1', side: null },
    );

    // 那份 `.nestmind` 还没读到 / 节点被折叠收起来了：表里只有卡片
    expect(edgeEndpoints(edge, lookup({ c_1: cardRect }))).toBeNull();
  });

  it('★ 节点之间也能连（两端都是节点，各自的盒子各自取）', () => {
    const edge = createEdge(
      { cardId: MIND_ID, nodeId: NODE_A, side: null },
      { cardId: MIND_ID, nodeId: NODE_B, side: null },
    );
    const ends = edgeEndpoints(
      edge,
      lookup({
        [nodeEndpointKey(MIND_ID, NODE_A)]: nodeRect,
        [nodeEndpointKey(MIND_ID, NODE_B)]: { x: 100, y: 400, width: 60, height: 30 },
      }),
    );

    // 自动选边：A 在上、B 在下 ⇒ A 从下边出、B 从上边进
    expect(ends?.from).toEqual({ x: 130, y: 130 });
    expect(ends?.to).toEqual({ x: 130, y: 400 });
  });
});

describe('节点端点 · 加连线时的三道过滤', () => {
  /** 一块有脑图、有一张卡、有另一个脑图的板子 */
  function board() {
    const board = createBoardFile();
    const mind = mindWithId(MIND_ID);
    const other = mindWithId('nm_2');
    addMind(board, mind);
    addMind(board, other);
    board.cards.push(createCard('note', { id: 'c_1' }));
    return board;
  }

  it('★ 脑图 id 在"存在"名单里：节点 ↔ 卡片加得进来', () => {
    const target = board();
    const edge = createEdge(
      { cardId: MIND_ID, nodeId: NODE_A, side: 'right' },
      { cardId: 'c_1', side: null },
    );

    expect(addEdges(target, [edge])).toBe(true);
    expect(target.edges).toHaveLength(1);
    expect(target.edges[0].from.nodeId).toBe(NODE_A);
  });

  it('★ 同一棵脑图里两个**不同**节点之间的线合法（不能当成自环丢掉）', () => {
    const target = board();
    const edge = createEdge(
      { cardId: MIND_ID, nodeId: NODE_A, side: null },
      { cardId: MIND_ID, nodeId: NODE_B, side: null },
    );

    expect(addEdges(target, [edge])).toBe(true);
    expect(target.edges).toHaveLength(1);
  });

  it('★ 同一个节点连自己 = 自环（锚点重合，画出来是一个点）', () => {
    const target = board();
    const edge = createEdge(
      { cardId: MIND_ID, nodeId: NODE_A, side: 'right' },
      { cardId: MIND_ID, nodeId: NODE_A, side: 'left' },
    );

    expect(addEdges(target, [edge])).toBe(false);
    expect(target.edges).toHaveLength(0);
  });

  it('★ 查重分得清"同一棵脑图的两个节点"（节点不同 = 不是重复）', () => {
    const target = board();
    expect(
      addEdges(target, [
        createEdge(
          { cardId: MIND_ID, nodeId: NODE_A, side: 'right' },
          { cardId: 'c_1', side: null },
        ),
      ]),
    ).toBe(true);
    // 同一棵树的**另一个**节点连同一张卡：是另一条线，不该被静默吞掉
    expect(
      addEdges(target, [
        createEdge(
          { cardId: MIND_ID, nodeId: NODE_B, side: 'right' },
          { cardId: 'c_1', side: null },
        ),
      ]),
    ).toBe(true);
    expect(target.edges).toHaveLength(2);

    // 完全一样的那一条（同节点 + 同方位）：才是重复
    expect(
      addEdges(target, [
        createEdge(
          { cardId: MIND_ID, nodeId: NODE_A, side: 'right' },
          { cardId: 'c_1', side: null },
        ),
      ]),
    ).toBe(false);
    expect(target.edges).toHaveLength(2);
  });
});

describe('节点端点 · 节点被删掉之后清掉指着它的线', () => {
  it('★ 只清**这一棵**里"已经不在的节点"，别的端点一个都不动', () => {
    const board = createBoardFile();
    addMind(board, mindWithId(MIND_ID));
    board.edges.push(
      // 指向已删的节点 —— 该清
      createEdge({ cardId: MIND_ID, nodeId: NODE_A, side: null }, { cardId: 'c_1', side: null }),
      // 指向还在的节点 —— 留着
      createEdge({ cardId: MIND_ID, nodeId: NODE_B, side: null }, { cardId: 'c_1', side: null }),
      // 整棵脑图（没有 `nodeId`）—— 留着
      createEdge({ cardId: MIND_ID, side: null }, { cardId: 'c_1', side: null }),
      // 另一棵脑图的**同名**节点 —— 留着（只清点名的那一棵）
      createEdge({ cardId: 'nm_2', nodeId: NODE_A, side: null }, { cardId: 'c_1', side: null }),
      // 完全无关的一条（卡片之间）—— 留着
      createEdge({ cardId: 'c_1', side: null }, { cardId: 'c_2', side: null }),
    );

    expect(pruneMindNodeEdges(board, MIND_ID, new Set([NODE_B]))).toBe(true);
    expect(board.edges).toHaveLength(4);
    expect(
      board.edges.some((edge) => edge.from.nodeId === NODE_A && edge.from.cardId === MIND_ID),
    ).toBe(false);
    // 另一棵树上的同名节点**没有**被误伤
    expect(
      board.edges.some((edge) => edge.from.cardId === 'nm_2' && edge.from.nodeId === NODE_A),
    ).toBe(true);

    // 没有可清的 ⇒ `false`（不产生"无变化的写入"）
    expect(pruneMindNodeEdges(board, MIND_ID, new Set([NODE_B]))).toBe(false);
  });
});

describe('节点端点 · 读盘（照读、不校验、不丢数据）', () => {
  /** 一块"有脑图 + 有一张卡"的板子，交给读盘用的裸 JSON */
  function raw(edge: Record<string, unknown>): Record<string, unknown> {
    const board = createBoardFile();
    addMind(board, mindWithId(MIND_ID, { mind: createMindFile({ rootText: '根' }) }));
    board.cards.push(createCard('note', { id: 'c_1' }));
    const json = JSON.parse(JSON.stringify(board)) as Record<string, unknown>;
    json.edges = [edge];
    return json;
  }

  it('★ 指着一个**不存在**的节点也照样留下这条线（那一刻可能还没读到 `.nestmind`）', () => {
    const result = normalizeBoardFile(
      raw({
        id: 'e_1',
        from: { cardId: MIND_ID, nodeId: 'n_不存在', side: null },
        to: { cardId: 'c_1', side: null },
      }),
    );

    const { board, issues } = result!;
    expect(issues.some((issue) => issue.action === 'dropped' && issue.path === 'edges[0]')).toBe(
      false,
    );
    expect(board.edges).toHaveLength(1);
    expect(board.edges[0].from.nodeId).toBe('n_不存在');
  });

  it('★ 脑图**整棵**没了才丢（与卡片 / 分栏同一条），不是"节点不认识"就丢', () => {
    const result = normalizeBoardFile(
      raw({
        id: 'e_1',
        from: { cardId: 'nm_没有这棵树', nodeId: NODE_A, side: null },
        to: { cardId: 'c_1', side: null },
      }),
    );

    expect(result!.board.edges).toHaveLength(0);
  });

  it('★ 认不出的 `nodeId`（空串 / 数字）当"没有这一层" ⇒ 退回整棵脑图，不丢这条线', () => {
    for (const bad of ['', 42, null]) {
      const result = normalizeBoardFile(
        raw({
          id: 'e_1',
          from: { cardId: MIND_ID, nodeId: bad, side: null },
          to: { cardId: 'c_1', side: null },
        }),
      );
      expect(result!.board.edges).toHaveLength(1);
      expect(result!.board.edges[0].from.nodeId).toBeUndefined();
    }
  });

  it('★ 写出去仍然是 `cardId` + `nodeId` **两个字段**（不是拼好的键）', () => {
    const board: BoardFile = createBoardFile();
    addMind(board, mindWithId(MIND_ID, { mind: createMindFile({ rootText: '根' }) }));
    board.cards.push(createCard('note', { id: 'c_1' }));
    board.edges.push(
      createEdge({ cardId: MIND_ID, nodeId: NODE_A, side: null }, { cardId: 'c_1', side: null }),
    );

    const text = serializeBoard(board);
    expect(text).toContain(`"nodeId": "${NODE_A}"`);
    // 落盘的 `cardId` 仍是脑图自己的 id —— 老插件读不懂 `nodeId`，只损失那一条线
    expect(text).toContain(`"cardId": "${MIND_ID}"`);
    expect(text).not.toContain(`${MIND_ID}/${NODE_A}`);
  });
});
