/**
 * **树连线**（`F7`，设计定稿 `11 §3` / 决策 D1、D6）。
 *
 * 一棵"卡片的树"长在普通连线体系**旁边**：树上的一条边就是一条
 * `kind: 'tree'` 的普通 `Edge`（`from` = 父级、`to` = 子级，定稿 D6
 * 「发起方成为父级」），于是**删卡连带清线、撤销、序列化**全部白捡 ——
 * 本文件只补普通连线没有的那三件事：
 *
 * 1. **树规则**（D1）：只允许单父；成环拒绝；已有父级不覆盖；
 * 2. **树折叠**：收起父卡 ⇒ 子级（整棵子树）藏起来，卡上留一个「+N」；
 * 3. **读写两侧共用**：菜单要数子级、视图要算隐藏集、连线层要判"这条线是不是树的"，
 *    全部走这里 —— 三处各写一套"谁是父谁是子"迟早打架。
 *
 * ★ 不 import `obsidian`、不碰 DOM —— 可在 node 下单测。
 */

import { createId } from '../util/id';
import { ID_PREFIX } from '../constants';
import type { BoardFile, Edge, EdgeEndpoint } from './schema';
import { isFreeEndpoint } from './schema';

/** 这条边是不是树连线（普通线缺 `kind`，读到的是 `false`） */
export function isTreeEdge(edge: Edge): boolean {
  return edge.kind === 'tree';
}

/**
 * 树连线两端**都必须是卡片**（树是卡片的树）。
 *
 * ★ 手改文件里可能出现"树线一端连着分栏 / 脑图"的怪数据 —— 不在这里抛错：
 *   读的时候把它当普通树边参与判定只会把树算歪，所以**凡有一端不是卡片的
 *   树边一律不参与树关系**（下面三个查询函数都会跳过它），与 `validate`
 *   "读盘不校验、用的时候再防"的分工一致。
 */
function treeEdgePair(edge: Edge): { parent: string; child: string } | null {
  if (!isTreeEdge(edge)) return null;
  const { from, to } = edge;
  if (isFreeEndpoint(from) || isFreeEndpoint(to)) return null;
  if (from.nodeId || to.nodeId) return null;
  return { parent: from.cardId, child: to.cardId };
}

/**
 * 这块板上的**卡片 id 集合**（防御用：树是**卡片**的树，端点连着分栏 / 脑图的
 * 树线不参与树关系 —— 手改文件防得住，正常路径 `linkTreeParent` 也造不出来）。
 */
function cardSetOf(board: BoardFile): Set<string> {
  return new Set(board.cards.map((card) => card.id));
}

/** 一张卡的**树父级**；没有（或它的树线是怪数据）给 `null` */
export function treeParentOf(board: BoardFile, cardId: string): string | null {
  const cards = cardSetOf(board);
  if (!cards.has(cardId)) return null;
  for (const edge of board.edges) {
    const pair = treeEdgePair(edge);
    if (pair && pair.child === cardId && cards.has(pair.parent)) return pair.parent;
  }
  return null;
}

/** 一张卡的**直接子级**（树边的 `to` 端是它们；顺序 = 边在文件里的顺序，稳定） */
export function treeChildrenIds(board: BoardFile, cardId: string): string[] {
  const cards = cardSetOf(board);
  if (!cards.has(cardId)) return [];
  const children: string[] = [];
  for (const edge of board.edges) {
    const pair = treeEdgePair(edge);
    if (pair && pair.parent === cardId && cards.has(pair.child)) children.push(pair.child);
  }
  return children;
}

/**
 * 一张卡的**全部后代**（子级、孙级……）。
 *
 * ★ 走 visited 集合而不是"信 D1 的无环"：手改文件 / 半途撤销都可能造出环，
 *   查询函数在这里死循环的话整个视图跟着挂 —— 查询**防御**，建立时**拒绝**（D1），
 *   两层各管各的。
 */
export function treeDescendantIds(board: BoardFile, cardId: string): string[] {
  const out: string[] = [];
  const visited = new Set<string>([cardId]);
  const queue = [...treeChildrenIds(board, cardId)];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (visited.has(id)) continue;
    visited.add(id);
    out.push(id);
    for (const child of treeChildrenIds(board, id)) queue.push(child);
  }
  return out;
}

/** 一张卡的**全部祖先**（父级、祖父级……）；环态下到重复就停 */
export function treeAncestorIds(board: BoardFile, cardId: string): Set<string> {
  const out = new Set<string>();
  let current = treeParentOf(board, cardId);
  while (current !== null && !out.has(current)) {
    out.add(current);
    current = treeParentOf(board, current);
  }
  return out;
}

/** 建立父子关系的判定结果（视图按它决定"提交"还是"弹提示"） */
export type TreeLinkState =
  | 'ok'
  | /** 起点终点是同一张卡 */ 'self'
  | /** 目标已经在发起方的祖先链上（成环，D1） */ 'cycle'
  | /** 目标已有父级（单父，D1：不覆盖） */ 'has-parent'
  | /** 目标不是一块板上的卡片 */ 'not-card';

/** 卡片 id 集合（判定"目标是不是这块板上的卡"用） */
function cardIdsOf(board: BoardFile): Set<string> {
  return new Set(board.cards.map((card) => card.id));
}

/**
 * 「把 `parentId` 设为 `childId` 的树父级」此刻**能不能做**（D1）。
 *
 * ★ 判定顺序有意按"用户最可能犯的"排：自己 → 成环 → 已有父级 → 目标不存在。
 *   全部通过才给 `'ok'`，视图不用再复查第二遍（判定与提交都在模型层，两边共享）。
 */
export function treeLinkState(board: BoardFile, parentId: string, childId: string): TreeLinkState {
  if (parentId === childId) return 'self';
  if (!cardIdsOf(board).has(childId) || !cardIdsOf(board).has(parentId)) return 'not-card';
  // 单父（D1）先判：目标已有父级时，无论是否也会成环，**用户意图**是"换父"，
  // 提示就该说"它已经有父级了"（两条都拒，顺序只影响提示哪一句）。
  if (treeParentOf(board, childId) !== null) return 'has-parent';
  // 成环：加"P 是 C 的父"会成环 ⇔ **C 已经在 P 的祖先链上**（C→…→P 已存在，
  // 再加 P→C 就首尾相接）。方向别写反 —— 写反了恰好把"重复建同一条线"漏过去。
  if (treeAncestorIds(board, parentId).has(childId)) return 'cycle';
  return 'ok';
}

// ─────────────────────────────────────────────────────────────
// 树折叠（+N）
// ─────────────────────────────────────────────────────────────

/** 所有被「折叠子级」收起来的父卡 id */
export function treeCollapsedParentIds(board: BoardFile): Set<string> {
  const out = new Set<string>();
  for (const card of board.cards) {
    if (card.treeCollapsed === true) out.add(card.id);
  }
  return out;
}

/**
 * 因为**树折叠**而该从画布上消失的卡片 id 集（整棵子树）。
 *
 * ★ 与 `ops.collapsedCardIds`（收起编组）/ `columns.collapsedColumnCardIds`
 *   （收起分栏）同一条接口纪律：返回"该藏的 id 集合"，由
 *   `BoardView.hiddenCardIds` 做并集 —— 连线、框选、命中问的是同一个问题。
 * ★ 折叠**父卡自己不藏**（它要留下来显示 +N）；嵌套折叠（父的子级里也有
 *   折叠的卡）天然成立：两棵子树都算进各自的集合，并集不为空就行。
 */
export function collapsedTreeCardIds(board: BoardFile): Set<string> {
  const hidden = new Set<string>();
  for (const id of treeCollapsedParentIds(board)) {
    for (const descendant of treeDescendantIds(board, id)) hidden.add(descendant);
  }
  return hidden;
}

/** 折叠的父卡角上那个「+N」的 N（收起来的后代数；0 = 不显示角标） */
export function treeHiddenCountOf(board: BoardFile, cardId: string): number {
  if (treeCollapsedParentIds(board).has(cardId) === false) return 0;
  return treeDescendantIds(board, cardId).length;
}

// ─────────────────────────────────────────────────────────────
// 写操作（与 `ops.ts` 同一条纪律：改了就返回 `true`，没改返回 `false`）
// ─────────────────────────────────────────────────────────────

/**
 * 建立父子关系：从 `parentId` 到 `childId` 生成一条**树连线**。
 *
 * ★ 判定在这里**再做一遍**（视图那遍是给提示用的）：判定与提交同居模型层，
 *   才不会有"视图判过 ok、提交时数据已经变了"的缝。
 * ★ 线的两端都锚**卡片中心**（`side: null` 由几何侧对树线特判成中心，
 *   见 `edges.edgeEndpoints`），`routing: 'free'`（树线不走智能绕行 ——
 *   绕行的意义是"躲开卡片"，而树线的中段本来就是被卡片盖住的）。
 */
export function linkTreeParent(board: BoardFile, parentId: string, childId: string): boolean {
  if (treeLinkState(board, parentId, childId) !== 'ok') return false;
  const endpoint = (cardId: string): EdgeEndpoint => ({ cardId, side: null });
  const edge: Edge = {
    id: createId(ID_PREFIX.edge),
    from: endpoint(parentId),
    to: endpoint(childId),
    fromEnd: 'none',
    toEnd: 'arrow',
    style: 'solid',
    color: '1',
    label: '',
    routing: 'free',
    kind: 'tree',
  };
  board.edges.push(edge);
  return true;
}

/** 折叠 / 展开一张卡的子级（视图的菜单与 +N 角标都走这里） */
export function setTreeCollapsed(board: BoardFile, cardId: string, collapsed: boolean): boolean {
  const card = board.cards.find((item) => item.id === cardId);
  if (!card) return false;
  if (collapsed) {
    if (card.treeCollapsed === true) return false;
    card.treeCollapsed = true;
    return true;
  }
  if (card.treeCollapsed !== true) return false;
  // ★ 缺席纪律：展开 = **删掉这个键**（而不是写 `false`）——
  //   "读一遍写回去逐字节不变"同样管展开过的卡
  delete card.treeCollapsed;
  return true;
}

/** 解除一层父子关系（菜单的「解除父子关系」）：删掉那条树线；线没了树关系自然没了 */
export function unlinkTreeParent(board: BoardFile, childId: string): boolean {
  const index = board.edges.findIndex((edge) => {
    const pair = treeEdgePair(edge);
    return pair !== null && pair.child === childId;
  });
  if (index < 0) return false;
  board.edges.splice(index, 1);
  return true;
}
