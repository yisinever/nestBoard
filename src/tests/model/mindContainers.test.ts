/**
 * 白板级脑图（`2.2.0`）的**模型操作**测试。
 *
 * 这一组钉的是"白板上那棵树"的动作（进出白板 / 挪位置 / 换模型 / 删掉），
 * 与树内部的结构编辑（`mind/model/ops`）分得清清楚楚 —— 后者在脑图那一侧已有一整套用例。
 */

import { describe, expect, it } from 'vitest';
import {
  createBoardFile,
  createMind,
  createEdge,
  createCard,
  newMindModel,
} from '../../model/factories';
import {
  addMind,
  duplicateMinds,
  mindById,
  mindsOf,
  moveMind,
  removeMinds,
  setMindModel,
} from '../../model/ops';
import { createMindFile, createMindNode } from '../../mind/model/factories';
import { normalizeBoardFile } from '../../model/validate';
import { serializeBoard } from '../../io/BoardRepository';

describe('白板级脑图 · 进出白板', () => {
  it('`minds` 缺席 = 没有脑图，读出来给空数组（调用方不必到处判 `?.`）', () => {
    const board = createBoardFile();
    expect(board.minds).toBeUndefined();
    expect(mindsOf(board)).toEqual([]);
  });

  it('★ `addMind` 默认压到最上层 —— 新建的树被旧卡压住会让人以为"没建成功"', () => {
    const board = createBoardFile({ cards: [createCard('note', { z: 7 })] });
    const mind = createMind({ x: 10, y: 20 });

    expect(addMind(board, mind)).toBe(true);
    expect(mind.z).toBe(8);
    expect(mindsOf(board)).toHaveLength(1);
  });

  it('★ 删掉一棵脑图会**连带清掉指着它的连线**（与删卡片同一条纪律）', () => {
    const board = createBoardFile();
    const mind = createMind();
    addMind(board, mind);
    board.edges.push(
      createEdge(
        { cardId: mind.id, side: null },
        { cardId: '', side: null, point: { x: 0, y: 0 } },
      ),
      createEdge(
        { cardId: '', side: null, point: { x: 1, y: 1 } },
        { cardId: 'c_other', side: null },
      ),
    );

    expect(removeMinds(board, [mind.id])).toBe(true);
    expect(mindsOf(board)).toHaveLength(0);
    expect(board.edges).toHaveLength(1);
    // ★ 全删光时把键去掉：与"可选键缺席即默认"同一条纪律（老插件读它要逐字节一样）
    expect(board.minds).toBeUndefined();
  });
});

describe('白板级脑图 · 挪位置 / 换模型', () => {
  it('★ 挪的是**根节点那一个点**（其它节点位置由布局算，不落盘）', () => {
    const board = createBoardFile();
    const mind = createMind({ x: 0, y: 0 });
    addMind(board, mind);

    expect(moveMind(board, mind.id, { x: 12.4, y: -3.6 })).toBe(true);
    // 落盘精度 2 位小数（`roundTo` 的默认，与卡片几何同一条）
    expect(mindById(board, mind.id)).toMatchObject({ x: 12.4, y: -3.6 });
    // 原地再挪一次 = 什么都没改（调用方据此不重绘 / 不记历史）
    expect(moveMind(board, mind.id, { x: 12.4, y: -3.6 })).toBe(false);
    // 不存在的 id：给 `false` 而不是抛
    expect(moveMind(board, 'm_missing', { x: 1, y: 1 })).toBe(false);
  });

  it('★ 换模型是**整份换掉**（老对象可能正被撤销栈的快照共享）', () => {
    const board = createBoardFile();
    const first = createMindFile({ rootText: '第一版' });
    const mind = createMind({ path: '', mind: first });
    addMind(board, mind);

    const second = createMindFile({ rootText: '第二版' });
    expect(setMindModel(board, mind.id, second)).toBe(true);
    expect(mindById(board, mind.id)?.mind).toBe(second);
    // 同一份对象再写一次 = 没改（`===` 判据，与 `patchSyncGroup` 同一条）
    expect(setMindModel(board, mind.id, second)).toBe(false);
  });

  it('★ 换模型时**清掉指向已删节点**的线（`2.2.0` 批 3，与删卡片同一条纪律）', () => {
    const board = createBoardFile();
    const first = createMindFile({ rootText: '根' });
    first.nodes.push(createMindNode({ parentId: first.rootId, text: '分支', order: 0 }));
    const branchId = first.nodes[1].id;
    const mind = createMind({ path: '', mind: first });
    addMind(board, mind);
    board.cards.push(createCard('note', { id: 'c_1' }));
    board.edges.push(
      // 指向那个分支 —— 新模型里它没了，该被清掉
      createEdge({ cardId: mind.id, nodeId: branchId, side: null }, { cardId: 'c_1', side: null }),
      // 指向根节点（还在）—— 留着
      createEdge(
        { cardId: mind.id, nodeId: first.rootId, side: null },
        { cardId: 'c_1', side: null },
      ),
    );

    // 新模型里**只剩根**（根节点 id 沿用，所以指着它的那条线要留着）
    const second = { ...first, nodes: first.nodes.filter((node) => node.id !== branchId) };
    expect(setMindModel(board, mind.id, second)).toBe(true);
    expect(board.edges).toHaveLength(1);
    expect(board.edges[0].from.nodeId).toBe(first.rootId);
  });

  it('★ 新建的内嵌脑图是"中心主题 + 3 个分支"，写出去读回来**节点数一个字不差**', () => {
    // 用户口径（`附`）："创建时只创建根节点和 3 个子节点"
    const model = newMindModel();
    expect(model.nodes).toHaveLength(4);
    expect(model.nodes.filter((node) => node.parentId === model.rootId)).toHaveLength(3);

    const board = createBoardFile();
    addMind(board, createMind({ path: '', mind: model }));

    // 过一遍真实的写盘 → 读盘（读入口有任何"顺手清理"都会在这里露出来）
    const parsed = normalizeBoardFile(JSON.parse(serializeBoard(board)));
    const read = parsed?.board.minds?.[0].mind;
    expect(read?.nodes).toHaveLength(4);
    expect(read?.nodes.map((node) => node.id).sort()).toEqual(
      model.nodes.map((node) => node.id).sort(),
    );
  });
});

/**
 * 原地复制整棵（`⌘D`，`2.2.0` 批 4 五）。
 *
 * 与 `duplicateCards` 同一套手感：偏移一份、压到最上层、**不带连线**。
 * 多出来的一条口径是"内嵌模型的节点 id 必须换新" —— 见下方那条用例的说明。
 */
describe('白板级脑图 · 原地复制', () => {
  it('★ 新 id + 偏移 + 压到最上层；原树一个字节不动', () => {
    const board = createBoardFile();
    const mind = { ...createMind({ x: 100, y: 200 }), id: 'nm_1' };
    addMind(board, mind);

    const clones = duplicateMinds(board, ['nm_1'], { x: 40, y: 60 });
    expect(clones).toHaveLength(1);
    expect(clones[0]!.id).not.toBe('nm_1');
    expect(clones[0]!.x).toBeCloseTo(140, 5);
    expect(clones[0]!.y).toBeCloseTo(260, 5);
    expect(clones[0]!.z).toBeGreaterThan(mind.z);
    expect(mind.x).toBe(100);
    expect(mindsOf(board)).toHaveLength(2);
  });

  it('★★ 内嵌脑图：节点 id 全换新，父子关系照旧（否则线会串到另一棵树上）', () => {
    const board = createBoardFile();
    const model = createMindFile({ rootText: '中心' });
    model.nodes.push(createMindNode({ parentId: model.rootId, text: '甲', order: 0 }));
    const oldIds = model.nodes.map((node) => node.id);
    addMind(board, { ...createMind({ path: '', mind: model }), id: 'nm_1' });

    const clone = duplicateMinds(board, ['nm_1'], { x: 0, y: 0 })[0]!;
    const copy = clone.mind!;
    expect(copy.nodes.map((node) => node.id)).not.toEqual(oldIds);
    expect(copy.nodes.some((node) => oldIds.includes(node.id))).toBe(false);
    // 新模型自洽：根在、每个孩子都指着新根
    expect(copy.nodes.find((node) => node.id === copy.rootId)).toBeDefined();
    expect(copy.nodes[1]!.parentId).toBe(copy.rootId);
    // 原模型没被动过（撤销栈里那份快照还共享着它）
    expect(model.nodes[0]!.id).toBe(oldIds[0]);
  });

  it('★ 文件脑图：只复制容器（`path` 照搬、模型不在白板文件里）', () => {
    const board = createBoardFile();
    addMind(board, { ...createMind({ path: 'Minds/甲.nestmind' }), id: 'nm_f' });

    const clone = duplicateMinds(board, ['nm_f'], { x: 10, y: 10 })[0]!;
    expect(clone.path).toBe('Minds/甲.nestmind');
    expect(clone.mind).toBeUndefined();
  });

  it('★ 不复制连线（与 `duplicateCards` 同一条口径）', () => {
    const board = createBoardFile();
    addMind(board, { ...createMind(), id: 'nm_1' });
    board.edges.push(
      createEdge({ cardId: 'nm_1', side: null }, { cardId: '', side: null, point: { x: 1, y: 1 } }),
    );

    duplicateMinds(board, ['nm_1'], { x: 0, y: 0 });
    expect(board.edges).toHaveLength(1);
  });

  it('没选中 / 点的是不存在的 id ⇒ 什么都不做', () => {
    const board = createBoardFile();
    addMind(board, { ...createMind(), id: 'nm_1' });
    expect(duplicateMinds(board, [], { x: 0, y: 0 })).toEqual([]);
    expect(duplicateMinds(board, ['nm_没有'], { x: 0, y: 0 })).toEqual([]);
    expect(mindsOf(board)).toHaveLength(1);
  });
});
