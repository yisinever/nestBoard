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
import { nodeEndpointKey } from '../../model/schema';
import type { BoardFile, Card } from '../../model/schema';
import {
  buildCardTransfer,
  buildNodeClipboard,
  parseCardTransfer,
  pasteCardTransfer,
} from '../../model/transfer';
import { clipboardLabelOf, pasteForest } from '../../mind/model/clipboard';
import { createMind } from '../../model/factories';
import { createMindFile, createMindNode } from '../../mind/model/factories';
import type { MindFile } from '../../mind/model/schema';

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

/**
 * 节点级复制（`2.2.0` 收尾 · 用户 2026-09-23 改的口径）。
 *
 * ── 口径 ────────────────────────────────────────────────────
 *
 * 节点是**某棵树内部**的东西：它只能粘到**另一棵树的某个节点下面**。所以它：
 * * **不**进卡片搬运载荷（`buildCardTransfer` 一个节点都不认）—— 从前进的话，
 *   粘到白板空白处会凭空长出一棵棵树（用户报的"变成各种根节点了"）；
 * * 走**节点剪贴板**（`buildNodeClipboard` → `mind/model/clipboard` 那一份格式，
 *   与 `.nestmind` 视图共用），粘的时候必须有目标节点（见 `pasteForest`）。
 *
 * 这一组钉的就是这两半：载荷里**没有**树，以及载荷本身"入口收敛 + 子树完整"。
 */
describe('节点级复制 · buildNodeClipboard（2.2.0 收尾）', () => {
  /** 一棵内嵌树：根 → 甲（孩子「甲的孩子」）/ 乙 / 丙 */
  function treeBoard() {
    const file = createMindFile({ branches: 0 });
    const add = (text: string, parentId: string, order: number): string => {
      const node = createMindNode({ text, parentId, order });
      file.nodes.push(node);
      return node.id;
    };
    const a = add('甲', file.rootId, 0);
    const b = add('乙', file.rootId, 1);
    add('丙', file.rootId, 2);
    const child = add('甲的孩子', a, 0);
    const mind = { ...createMind({ path: '' }), id: 'nm1', mind: file };
    const board = createBoardFile({ minds: [mind] });
    return { board, mindId: 'nm1', a, b, child };
  }

  it('★★ 节点**不进**卡片载荷：卡片那条通道里根本没有节点这一格', () => {
    const { board } = treeBoard();
    // 从前 `buildCardTransfer` 收一个 `nodeKeys` 参数、把每个节点抽成"合成容器"的树 ——
    // 那正是"粘到白板空白处长出一棵棵树"的来源。现在这一格**从签名里删掉了**
    // （类型系统直接挡住旧写法），卡片载荷只剩卡片与整棵树两样。
    expect(buildCardTransfer(board, [], [])).toBeNull();
  });

  it('★ 载荷是"一簇节点"（入口 + 全部后代），不是一棵树', () => {
    const { board, mindId, a, child } = treeBoard();
    const built = buildNodeClipboard(board, [nodeEndpointKey(mindId, a)])!;

    expect(built.skipped).toBe(0);
    expect(built.payload.roots).toEqual([a]);
    // 子树 = 甲 + 甲的孩子（乙 / 丙 不在）
    expect(built.payload.nodes.map((node) => node.text)).toEqual(['甲', '甲的孩子']);
    expect(built.payload.nodes.some((node) => node.id === child)).toBe(true);
    expect(clipboardLabelOf(built.payload)).toBe('甲');
  });

  it('★ 祖先也被选中 ⇒ 只留入口（子树不重复）', () => {
    const { board, mindId, a, child } = treeBoard();
    const built = buildNodeClipboard(board, [
      nodeEndpointKey(mindId, a),
      nodeEndpointKey(mindId, child),
    ])!;
    expect(built.payload.roots).toEqual([a]);
    expect(built.payload.nodes).toHaveLength(2);
  });

  it('★ 多棵树里各选几个 ⇒ 合成**同一份**载荷（各支都是入口）', () => {
    const first = treeBoard();
    const second = createMindFile({ branches: 0 });
    const other = createMindNode({ text: '另一棵', parentId: second.rootId, order: 0 });
    second.nodes.push(other);
    const board = createBoardFile({
      minds: [
        ...(first.board.minds ?? []),
        { ...createMind({ path: '' }), id: 'nm2', mind: second },
      ],
    });

    const built = buildNodeClipboard(board, [
      nodeEndpointKey(first.mindId, first.a),
      nodeEndpointKey('nm2', other.id),
    ])!;
    expect(built.payload.roots).toEqual([first.a, other.id]);
    expect(built.payload.nodes.length).toBe(3);
  });

  it('文件树里的节点跳过并计数（内容在 `.nestmind` 里，纯模型这一层读不到）', () => {
    const { board, mindId, a } = treeBoard();
    const withFile = createBoardFile({
      minds: [
        ...(board.minds ?? []),
        { ...createMind({ path: '脑图/甲.nestmind' }), id: 'nm_file' },
      ],
    });

    // 混选：内嵌的照复制，文件树那两个跳过并报数
    const built = buildNodeClipboard(withFile, [
      nodeEndpointKey(mindId, a),
      nodeEndpointKey('nm_file', 'n_x'),
      nodeEndpointKey('nm_file', 'n_y'),
    ])!;
    expect(built.payload.roots).toEqual([a]);
    expect(built.skipped).toBe(2);
    // 全是文件树的节点 ⇒ 一份都做不出来
    expect(buildNodeClipboard(withFile, [nodeEndpointKey('nm_file', 'n_x')])).toBeNull();
  });

  it('★ 粘到**目标节点**下：子树完整、节点 id 全新、是那个节点的孩子', () => {
    const { board, mindId, a } = treeBoard();
    const built = buildNodeClipboard(board, [nodeEndpointKey(mindId, a)])!;

    // 另一棵树：根 → 目标
    const target = createMindFile({ branches: 0 });
    const targetNode = createMindNode({ text: '目标', parentId: target.rootId, order: 0 });
    target.nodes.push(targetNode);

    const created = pasteForest(target, built.payload, targetNode.id)!;
    expect(created).toHaveLength(1);
    const pasted = target.nodes.find((node) => node.id === created[0])!;
    expect(pasted.text).toBe('甲');
    expect(pasted.id).not.toBe(a); // id 重编过
    expect(pasted.parentId).toBe(targetNode.id);
    // 孩子跟着过来、父子关系一起重映射
    const kid = target.nodes.find((node) => node.text === '甲的孩子')!;
    expect(kid.parentId).toBe(pasted.id);
  });

  it('目标节点不在那棵树里 ⇒ 粘不成（给 `null`，不当成"粘到根上"）', () => {
    const { board, mindId, a } = treeBoard();
    const built = buildNodeClipboard(board, [nodeEndpointKey(mindId, a)])!;
    const target = createMindFile({ branches: 0 });
    expect(pasteForest(target, built.payload, 'n_不存在')).toBeNull();
  });
});

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
    expect(pasted.cards.map((c) => ({ x: c.x, y: c.y }))).toEqual([
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
    expect(pasted.cards.every((c) => c.id !== 'c_a' && c.id !== 'c_b')).toBe(true);
    // 连线也是新 id，且端点指向新卡片
    expect(board.edges[1]?.from.cardId).toBe(pasted.cards[0]?.id);
    expect(board.edges[1]?.to.cardId).toBe(pasted.cards[1]?.id);
  });

  it('内容深拷贝：改副本不影响原卡', () => {
    const board = source();
    const transfer = roundTrip(board, ['c_a']);
    const pasted = pasteCardTransfer(board, transfer!, { x: 0, y: 0 });
    expect(pasted.cards[0]?.content).not.toBe(board.cards[0]?.content);
    expect(pasted.cards[0]?.content).toEqual(board.cards[0]?.content);
  });

  it('★ 栏内成员资格不跟过来（目标板没有那个栏）', () => {
    const board = createBoardFile({
      columns: [column('col_a', 0, 0)],
      cards: [card('c_a', { x: 10, y: 10, columnId: 'col_a', order: 3, title: '栏内的卡' })],
    });
    const transfer = roundTrip(board, ['c_a']);
    const targetBoard = createBoardFile({});
    const pasted = pasteCardTransfer(targetBoard, transfer!, { x: 0, y: 0 });
    expect(pasted.cards[0]?.columnId).toBeNull();
    expect(pasted.cards[0]?.order).toBe(0);
  });

  it('★ 演示步骤号不跟过来（演示路径是目标板自己的事）', () => {
    const board = source();
    board.cards[0]!.presentStep = 2;
    const transfer = roundTrip(board, ['c_a']);
    const pasted = pasteCardTransfer(target(), transfer!, { x: 0, y: 0 });
    expect(pasted.cards[0]?.presentStep).toBeNull();
  });

  it('新卡片压在最上层（z 递增，不会被原有卡片盖住）', () => {
    const board = target();
    const before = board.cards[0]!.z;
    const transfer = roundTrip(source(), ['c_a']);
    const pasted = pasteCardTransfer(board, transfer!, { x: 0, y: 0 });
    expect(pasted.cards[0]!.z).toBeGreaterThan(before);
  });

  it('空载荷 = 什么都不做', () => {
    const board = target();
    expect(pasteCardTransfer(board, { cards: [], minds: [], edges: [] }, { x: 0, y: 0 })).toEqual({
      cards: [],
      minds: [],
    });
    expect(board.cards).toHaveLength(1);
  });
});

/**
 * 整棵脑图的搬运（`2.2.0` 批 4 五）。
 *
 * 这一档比卡片多一处**非做不可**的事：内嵌脑图的节点 id 在粘贴时必须**全部换新** ——
 * 连线端点正是按 `脑图id/节点id` 认节点的，两棵树共用一批节点 id 会让线串到另一棵树上。
 * 文件脑图相反：那些节点 id 属于那份 `.nestmind`，一个都不能改（只复制容器）。
 */
describe('整棵脑图的搬运（`2.2.0` 批 4 五）', () => {
  /** 一棵内嵌脑图（根 + 一个分支）挂在板上的容器 */
  function inlineMind() {
    const model = createMindFile({ rootText: '中心' });
    model.nodes.push(createMindNode({ parentId: model.rootId, text: '甲', order: 0 }));
    const mind = { ...createMind({ x: 500, y: 400, path: '', mind: model }), id: 'nm_1' };
    return { mind, model, branchId: model.nodes[1].id };
  }

  function mindBoard(): { board: BoardFile; model: MindFile; branchId: string } {
    const { mind, model, branchId } = inlineMind();
    const board = createBoardFile({});
    board.minds = [mind];
    return { board, model, branchId };
  }

  it('★ 选中的整棵进载荷（与卡片共用一个标记）', () => {
    const { board } = mindBoard();
    const text = buildCardTransfer(board, [], ['nm_1']);
    expect(text).not.toBeNull();

    const transfer = parseCardTransfer(text as string)!;
    expect(transfer.minds).toHaveLength(1);
    expect(transfer.minds[0]?.id).toBe('nm_1');
  });

  it('★ 没选中任何东西 ⇒ `null`（调用方据此提示）', () => {
    const { board } = mindBoard();
    expect(buildCardTransfer(board, [], [])).toBeNull();
    expect(buildCardTransfer(board, [], ['nm_不存在'])).toBeNull();
  });

  it('★★ 粘贴：容器换新 id，内嵌模型的**节点 id 全部换新**（父子关系照旧）', () => {
    const { board, branchId } = mindBoard();
    const transfer = parseCardTransfer(buildCardTransfer(board, [], ['nm_1']) as string)!;
    const pasted = pasteCardTransfer(board, transfer, { x: 0, y: 0 });

    const clone = pasted.minds[0]!;
    expect(clone.id).not.toBe('nm_1');
    const model = clone.mind!;
    // 老的节点 id 一个都不许出现
    expect(model.nodes.map((node) => node.id)).not.toContain(board.minds![0]!.mind!.rootId);
    expect(model.nodes.map((node) => node.id)).not.toContain(branchId);
    // 根还在、父子关系还在（只是 id 换了一轮）
    expect(model.nodes.find((node) => node.id === model.rootId)).toBeDefined();
    const branch = model.nodes.find((node) => node.parentId === model.rootId);
    expect(branch?.text).toBe('甲');
    // 板上真的多了一棵
    expect(board.minds).toHaveLength(2);
  });

  it('★★ 指着**内嵌树节点**的连线跟着重映射到新节点上', () => {
    const { board, branchId } = mindBoard();
    board.cards = [card('c_1', { x: 0, y: 0, title: '卡' })];
    board.edges = [createEdge(endpoint('c_1'), { cardId: 'nm_1', nodeId: branchId, side: null })];

    const transfer = parseCardTransfer(buildCardTransfer(board, ['c_1'], ['nm_1']) as string)!;
    const pasted = pasteCardTransfer(board, transfer, { x: 0, y: 0 });

    const clone = pasted.minds[0]!;
    const cloneBranch = clone.mind!.nodes.find((node) => node.parentId === clone.mind!.rootId)!;
    const edge = board.edges[board.edges.length - 1]!;
    expect(edge.to.cardId).toBe(clone.id);
    expect(edge.to.nodeId).toBe(cloneBranch.id);
    expect(edge.from.cardId).toBe(pasted.cards[0]!.id);
  });

  it('★ 只粘一棵树（没有卡片）时也按落点偏移，不会正好压在原树上', () => {
    const { board } = mindBoard();
    const transfer = parseCardTransfer(buildCardTransfer(board, [], ['nm_1']) as string)!;
    const pasted = pasteCardTransfer(board, transfer, { x: 100, y: 100 });

    expect(pasted.minds[0]!.x).toBeCloseTo(100, 5);
    expect(pasted.minds[0]!.y).toBeCloseTo(100, 5);
    expect(pasted.minds[0]!.x).not.toBe(board.minds![0]!.x);
  });

  it('★ 文件脑图：只复制**容器**（`path` 照搬），节点 id 一个都不改', () => {
    const board = createBoardFile({});
    board.minds = [{ ...createMind({ x: 300, y: 300, path: 'Minds/甲.nestmind' }), id: 'nm_f' }];
    board.cards = [card('c_1', { x: 0, y: 0 })];
    // 连线指着那份文件里的一个节点（节点 id 属于文件，搬过去仍然有效）
    board.edges = [
      createEdge(endpoint('c_1'), { cardId: 'nm_f', nodeId: 'n_文件里的', side: null }),
    ];

    const transfer = parseCardTransfer(buildCardTransfer(board, ['c_1'], ['nm_f']) as string)!;
    const pasted = pasteCardTransfer(board, transfer, { x: 0, y: 0 });

    const clone = pasted.minds[0]!;
    expect(clone.path).toBe('Minds/甲.nestmind');
    // 内嵌模型没有跟过来（它本来就不在白板文件里）
    expect(clone.mind).toBeUndefined();
    const edge = board.edges[board.edges.length - 1]!;
    expect(edge.to.cardId).toBe(clone.id);
    expect(edge.to.nodeId).toBe('n_文件里的');
  });
});
