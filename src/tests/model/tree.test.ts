import { describe, expect, it } from 'vitest';
import { createBoardFile, createCard, createEdge } from '../../model/factories';
import type { BoardFile, Edge } from '../../model/schema';
import {
  collapsedTreeCardIds,
  linkTreeParent,
  setTreeCollapsed,
  treeAncestorIds,
  treeChildrenIds,
  treeDescendantIds,
  treeHiddenCountOf,
  treeLinkState,
  treeParentOf,
  treeCollapsedParentIds,
  unlinkTreeParent,
} from '../../model/tree';

/** 一块只有指定卡片的板（id 自定，方便读用例） */
function boardOf(...ids: string[]): BoardFile {
  const board = createBoardFile({});
  for (const id of ids) {
    const card = createCard('note');
    card.id = id;
    board.cards.push(card);
  }
  return board;
}

/** 直接把一条树线塞进板里（`from`=父、`to`=子） */
function link(board: BoardFile, parent: string, child: string): Edge {
  const edge = createEdge(
    { cardId: parent, side: null },
    { cardId: child, side: null },
    { kind: 'tree' },
  );
  board.edges.push(edge);
  return edge;
}

describe('树关系查询（F7）', () => {
  it('★ 父 / 子 / 后代 / 祖先：一条 A→B→C 的链', () => {
    const board = boardOf('a', 'b', 'c');
    link(board, 'a', 'b');
    link(board, 'b', 'c');

    expect(treeParentOf(board, 'b')).toBe('a');
    expect(treeParentOf(board, 'c')).toBe('b');
    expect(treeParentOf(board, 'a')).toBeNull();
    expect(treeChildrenIds(board, 'a')).toEqual(['b']);
    expect(treeDescendantIds(board, 'a')).toEqual(['b', 'c']);
    expect(treeAncestorIds(board, 'c')).toEqual(new Set(['b', 'a']));
    expect(treeAncestorIds(board, 'a')).toEqual(new Set());
  });

  it('★ 只认 `kind: tree` 的边：普通连线不参与树关系（两套并存，定稿）', () => {
    const board = boardOf('a', 'b');
    board.edges.push(createEdge({ cardId: 'a', side: 'right' }, { cardId: 'b', side: 'left' }));
    expect(treeParentOf(board, 'b')).toBeNull();
    expect(treeChildrenIds(board, 'a')).toEqual([]);
  });

  it('★ 树线一端连着非卡片（手改文件）→ 这条线不参与树关系（防御，不抛错）', () => {
    const board = boardOf('a', 'b');
    board.edges.push(
      createEdge({ cardId: 'a', side: null }, { cardId: 'col_x', side: null }, { kind: 'tree' }),
    );
    board.edges.push(
      createEdge({ cardId: 'a', side: null }, { cardId: 'b', side: null }, { kind: 'tree' }),
    );
    expect(treeChildrenIds(board, 'a')).toEqual(['b']);
  });
});

describe('树规则（D1：单父 + 成环拒绝）', () => {
  it('self / 成环 / 已有父级 / 目标不存在，各给各的判定', () => {
    const board = boardOf('a', 'b', 'c');
    link(board, 'a', 'b');

    expect(treeLinkState(board, 'a', 'a')).toBe('self');
    // b 的祖先链上有 a ⇒ a→c→…→b 才叫环；这里 a 已是 b 的父 ⇒ a→b 是重复、b→a 是成环
    expect(treeLinkState(board, 'b', 'a')).toBe('cycle');
    // 跨两级也算环：c 的祖先链含 a
    link(board, 'b', 'c');
    expect(treeLinkState(board, 'c', 'a')).toBe('cycle');
    // 单父：b 已有父级 a ⇒ c→b 被拒（不覆盖）
    expect(treeLinkState(board, 'c', 'b')).toBe('has-parent');
    expect(treeLinkState(board, 'a', 'ghost')).toBe('not-card');
    // a→c：c 已有父级 b ⇒ 先报"已有父级"（两条都拒，顺序只影响提示哪一句）
    expect(treeLinkState(board, 'a', 'c')).toBe('has-parent');
    const board2 = boardOf('x', 'y');
    expect(treeLinkState(board2, 'x', 'y')).toBe('ok');
  });

  it('★ `linkTreeParent`：判定不过不改板；通过才建线（方向 = 发起方为父，D6）', () => {
    const board = boardOf('a', 'b', 'c');
    link(board, 'a', 'b');
    const before = board.edges.length;

    expect(linkTreeParent(board, 'c', 'b')).toBe(false); // 已有父级
    expect(board.edges.length).toBe(before);

    expect(linkTreeParent(board, 'b', 'a')).toBe(false); // 成环（a 已是 b 的父）
    expect(board.edges.length).toBe(before);

    expect(linkTreeParent(board, 'a', 'a')).toBe(false); // 自己
    expect(board.edges.length).toBe(before);

    const board2 = boardOf('x', 'y');
    expect(linkTreeParent(board2, 'x', 'y')).toBe(true);
    const edge = board2.edges.at(-1) as Edge;
    expect(edge.kind).toBe('tree');
    expect(edge.from.cardId).toBe('x');
    expect(edge.to.cardId).toBe('y');
    expect(edge.toEnd).toBe('arrow');
  });

  it('★ `unlinkTreeParent`：删的是那条树线；没有就返回 false', () => {
    const board = boardOf('a', 'b');
    const edge = link(board, 'a', 'b');
    expect(unlinkTreeParent(board, 'b')).toBe(true);
    expect(board.edges.includes(edge)).toBe(false);
    expect(treeParentOf(board, 'b')).toBeNull();
    expect(unlinkTreeParent(board, 'b')).toBe(false);
  });
});

describe('树折叠（+N）', () => {
  it('★ 折叠父卡 ⇒ 整棵子树该藏、父卡自己不藏', () => {
    const board = boardOf('root', 'a', 'b', 'c', 'd');
    link(board, 'root', 'a');
    link(board, 'a', 'b');
    link(board, 'root', 'c');

    expect(setTreeCollapsed(board, 'a', true)).toBe(true);
    // 父卡自己**留在场上**（+N 挂在它身上），藏的是子树
    expect(collapsedTreeCardIds(board)).toEqual(new Set(['b']));
    expect(treeCollapsedParentIds(board)).toEqual(new Set(['a']));
    // N = 收起来的后代数
    expect(treeHiddenCountOf(board, 'a')).toBe(1);
    expect(treeHiddenCountOf(board, 'root')).toBe(0);
    expect(treeHiddenCountOf(board, 'c')).toBe(0);
  });

  it('★ 与卡片自己的收起是两个状态（定稿：不复用 `collapsed`）', () => {
    const board = boardOf('a', 'b');
    link(board, 'a', 'b');
    setTreeCollapsed(board, 'a', true);
    // 树折叠不影响"收起自己"；反之亦然
    expect(board.cards[0].treeCollapsed).toBe(true);
    expect(board.cards[0].collapsed).toBeUndefined();
  });

  it('★ 展开 = 删掉这个键（缺席纪律：读一遍写回去逐字节不变）', () => {
    const board = boardOf('a', 'b');
    link(board, 'a', 'b');
    setTreeCollapsed(board, 'a', true);
    expect('treeCollapsed' in board.cards[0]).toBe(true);
    expect(setTreeCollapsed(board, 'a', false)).toBe(true);
    expect('treeCollapsed' in board.cards[0]).toBe(false);
    expect(setTreeCollapsed(board, 'a', false)).toBe(false); // 幂等
  });

  it('★ 嵌套折叠：两棵子树都算进隐藏集；查环数据不死循环', () => {
    const board = boardOf('a', 'b', 'c');
    link(board, 'a', 'b');
    link(board, 'b', 'c');
    setTreeCollapsed(board, 'a', true);
    setTreeCollapsed(board, 'b', true);
    expect(collapsedTreeCardIds(board)).toEqual(new Set(['b', 'c']));

    // 手改成环（b↔c）：后代查询到重复就停，不能挂死
    board.edges.push(
      createEdge({ cardId: 'c', side: null }, { cardId: 'b', side: null }, { kind: 'tree' }),
    );
    expect(treeDescendantIds(board, 'b').sort()).toEqual(['c']);
  });
});
