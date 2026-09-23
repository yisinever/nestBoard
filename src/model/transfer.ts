/**
 * 跨白板搬运卡片（`T4.15` / `F7-07`）。
 *
 * ── 为什么载体是**系统剪贴板里的一段文本**，而不是插件内部的一块内存 ──
 *
 * 1. 跨白板只是它能做的事情里最小的一件：它天然还跨窗口、跨库、跨"这次会话"
 *    （内存剪贴板一关 Obsidian 就没了，而用户的习惯是"先复制着，回头再贴"）。
 * 2. 插件不必维护一份会过期、又和板子加载状态纠缠的隐藏状态 —— 少一个能不一致的东西。
 * 3. 出问题时用户自己能看见：贴进任何一个文本框就能读，也存得成文件。
 *
 * ── 为什么文本形态是"**一份最小 `.nboard`**" ──
 *
 * 多写一个 `nestboard: "cards"` 标记（用来和"用户随手复制的板文件 JSON"区分开），
 * 其余字段就是一份合法的板文件。于是粘贴侧可以整段复用 `normalizeBoardFile()`
 * 那套已经被几千条用例磨过的校验与修复：坏卡片会被丢掉、重复 id 会被处理、
 * 缺字段会被补默认值 —— **不必为"剪贴板格式"再写一遍解析器**，也就不会出现
 * "文件能读、剪贴板读不了"这种两套解析规则各自漂移的老毛病。
 *
 * ── 搬运规则（都有明文单测） ──
 *
 * * **连线**：只搬"**两端都在选中集里**"的那些。一端在外面的连线不能搬 ——
 *   搬过去就是一端指向一张不存在的卡（悬空引用，与 `removeCards` 的规矩同源）。
 * * **分栏成员资格一律脱落**（`columnId: null`）：目标板没有同一个分栏，
 *   而"落在哪个栏"本来就是**那一块板**的事。想归栏，粘完再拖进目标板的栏里。
 * * **演示步骤号一律清空**（`presentStep: null`）：演示路径是目标板自己的脚本，
 *   复制进来的卡片不该莫名其妙挤进别人的演示顺序。
 * * **内容深拷贝**（与 `duplicateCards` 同源）：共用 `content` 引用会让改一张便签
 *   把它的副本一起改掉 —— 那是最难查的一类 bug。
 * * **相对位置保持**，整组按包围盒的**左上角**对齐到落点。
 * * **id 全部重新生成**（卡片与连线都是）：否则粘回同一块板就是两张同 id 的卡。
 */

import { ID_PREFIX } from '../constants';
import { createId } from '../util/id';
import { boundsOf, roundTo, type Point, type Rect } from '../util/geometry';
import { nextZ } from './factories';
import { cloneJson, cloneMindForCopy } from './ops';
import { splitEndpointKey } from './schema';
import type { BoardFile, Card, Edge, EdgeEndpoint, Mind } from './schema';
import { copyForest, type MindClipboard } from '../mind/model/clipboard';
import type { MindNode } from '../mind/model/schema';
import { isRecord, normalizeBoardFile, safeJsonParse } from './validate';

/**
 * 剪贴板标记。
 *
 * ★ 写的是 `{ "nestboard": "cards", ... }`，粘贴时**先看这个键**再去规范化：
 *   没这个标记的一律走原来的"粘贴文本 / 图片"路径，绝不把普通 JSON 文本
 *   当成卡片搬进板子里。
 */
const TRANSFER_MARKER = 'cards';

/** 一份可粘贴的搬运载荷（已经是合法卡片，见 `parseCardTransfer`） */
export interface CardTransfer {
  cards: Card[];
  /**
   * **整棵脑图**（`2.2.0` 批 4 五）。
   *
   * ★ 老载荷（这一批之前复制进剪贴板的文本）里没有这个键 ⇒ 解析时补 `[]`，
   *   于是"跨版本粘贴"两个方向都成立：老的粘不丢东西，新的在老板子上粘
   *   也只是少了一棵树（`normalizeBoardFile` 会把不认识的键丢掉，不会写坏）。
   * ★ 内嵌脑图的**节点 id 在粘贴时会重新生成**（见 `pasteCardTransfer`）：
   *   否则"粘回同一块板"会得到两棵树共用同一批节点 id —— 而连线端点正是按
   *   `脑图id/节点id` 认节点的。
   */
  minds: Mind[];
  edges: Edge[];
}

/**
 * 把选中的对象做成一段可放进系统剪贴板的文本。
 *
 * @param ids 选中的卡片 id（不在板上的会被忽略）
 * @param mindIds 选中的**整棵脑图** id（同上；`2.2.0` 批 4 五起）
 * @returns 两者都没得搬时返回 `null`（调用方据此提示"没选中东西"）
 */
export function buildCardTransfer(
  board: BoardFile,
  ids: readonly string[],
  mindIds: readonly string[] = [],
): string | null {
  const wanted = new Set(ids);
  const cards = board.cards.filter((card) => wanted.has(card.id));
  const wantedMinds = new Set(mindIds);
  const minds = (board.minds ?? []).filter((mind) => wantedMinds.has(mind.id));

  if (cards.length === 0 && minds.length === 0) return null;

  // 判定用"这个端点对象是否在选中集里"，而不是"这条连线是否被选中"：
  // 连线的端点可能被删、可能是自由端，逐条判端点才是唯一可靠的口径。
  //   ★ 卡片、分栏、脑图共用 `cardId` 一个字段 ⇒ 这一条判据对整棵树同样成立；
  //     而**节点端点**（`nodeId`）不用单独判：节点属于它那棵树，树搬走了节点就跟着走
  //     （内嵌那种会重编 id，粘贴时连线的端点也一起改，见 `pasteCardTransfer`）。
  const copied = new Set<string>([...cards.map((card) => card.id), ...minds.map((m) => m.id)]);
  const edges = board.edges
    .filter((edge) => copied.has(edge.from.cardId) && copied.has(edge.to.cardId))
    .map((edge) => cloneJson(edge));

  return `${JSON.stringify({ nestboard: TRANSFER_MARKER, cards, minds, edges }, null, 2)}\n`;
}

/**
 * 把白板上的**节点选中**做成一份节点剪贴板载荷（`⌘C` 落在脑图节点上时）。
 *
 * ── 为什么是这一份而不是卡片载荷（用户 2026-09-23）────────────────
 *
 * 节点是"某棵树内部"的东西：它的落点只能是**另一棵树里的某个节点**（成为那个节点的子级）。
 * 于是它走的是脑图自己的剪贴板（`mind/model/clipboard`，与 `.nestmind` 视图**同一份格式**）——
 * 顺带还多了一件事：在卡片里复制的节点可以直接粘进一个 `.nestmind` 视图，反之亦然。
 *
 * ★ 从前它被抽成"合成容器"塞进卡片载荷 ⇒ 粘到白板空白处就长出一棵棵新树
 *   （用户报的"变成各种根节点了"）。那条路已经拆掉。
 * ★ 只认**板内嵌**的树（`mind` 就在板子里）。文件树的节点内容在 `.nestmind` 里，这一层
 *   （纯模型）读不到 ⇒ 跳过，并用 `skipped` 让调用方说清楚（与删除那条同一条口径）。
 * ★ 多棵树里各选了几个 ⇒ 合成**同一份**载荷（各支都是入口，粘到目标节点下依次排开）。
 *   节点 id 是 `nm_…` 随机串，跨树撞号的概率可以当零；何况 `pasteForest` 粘的时候
 *   整表都会换成新 id。
 *
 * @returns 一份载荷 + 被跳过的节点数；一个能复制的都没有时给 `null`
 */
export function buildNodeClipboard(
  board: BoardFile,
  nodeKeys: readonly string[],
): { payload: MindClipboard; skipped: number } | null {
  const grouped = new Map<string, string[]>();
  let skipped = 0;
  for (const key of nodeKeys) {
    const { cardId, nodeId } = splitEndpointKey(key);
    if (nodeId === null) {
      skipped += 1;
      continue;
    }
    const bucket = grouped.get(cardId) ?? [];
    bucket.push(nodeId);
    grouped.set(cardId, bucket);
  }

  const roots: string[] = [];
  const nodes: MindNode[] = [];
  for (const [mindId, nodeIds] of grouped) {
    const source = (board.minds ?? []).find((mind) => mind.id === mindId);
    // 文件树（`path` 有值）模型读不到 ⇒ 跳过；`copyForest` 自己会剔掉"祖先也被选中"的重复
    if (!source || source.path.length > 0 || !source.mind) {
      skipped += nodeIds.length;
      continue;
    }
    const payload = copyForest(source.mind, nodeIds);
    if (!payload) {
      skipped += nodeIds.length;
      continue;
    }
    roots.push(...payload.roots);
    nodes.push(...payload.nodes);
  }

  if (roots.length === 0 || nodes.length === 0) return null;
  return { payload: { roots, nodes }, skipped };
}

/**
 * 解析剪贴板文本。
 *
 * @returns 不是本插件的搬运载荷、或内容坏到修不回来时返回 `null`（**不抛异常** ——
 *   剪贴板里的东西是外部输入，永远不能信任）
 */
export function parseCardTransfer(text: string): CardTransfer | null {
  const parsed = safeJsonParse(text);
  if (!parsed.ok) return null;
  const value = parsed.value;
  if (!isRecord(value) || value['nestboard'] !== TRANSFER_MARKER) return null;

  const normalized = normalizeBoardFile(value);
  if (!normalized) return null;
  return {
    cards: normalized.board.cards,
    // 老载荷没有 `minds` ⇒ 补空数组（见 `CardTransfer.minds`）
    minds: normalized.board.minds ?? [],
    edges: normalized.board.edges,
  };
}

/** 搬运时"一个端点对象占的地方"（脑图没有尺寸 ⇒ 用根节点中心那一点当它的位置） */
function positionRectOf(mind: Mind): Rect {
  return { x: mind.x, y: mind.y, width: 0, height: 0 };
}

/**
 * 把搬运载荷贴进目标板。
 *
 * 直接改 `board`（与 `duplicateCards` / `addCards` 同一约定：模型层只改数据，
 * 记历史、刷视图、发通知都是视图层的事）。
 *
 * @param at 落点（世界坐标）：整组对象的**包围盒左上角**会落在这里。脑图没有尺寸，
 *   于是它按**根节点中心**那一点参与包围盒（`positionRectOf`）—— 缺这一笔，
 *   "只粘一棵树"会算出空包围盒、落点退化成 `(0,0)` 的位移，粘出来正好压在原树上。
 * @returns 新插入的卡片与脑图（用于"贴完选中它们"，与复制粘贴的通用手感一致）
 */
export function pasteCardTransfer(
  board: BoardFile,
  transfer: CardTransfer,
  at: Point,
): { cards: Card[]; minds: Mind[] } {
  const sources = transfer.cards;
  const mindSources = transfer.minds;
  if (sources.length === 0 && mindSources.length === 0) return { cards: [], minds: [] };

  const box = boundsOf([...sources, ...mindSources.map(positionRectOf)]);
  const dx = box ? at.x - box.x : 0;
  const dy = box ? at.y - box.y : 0;

  const idMap = new Map<string, string>();
  /** 每个**内嵌**脑图里"老节点 id → 新节点 id"（文件脑图不在这里，它一个 id 都不改） */
  const nodeIdMap = new Map<string, string>();
  let z = nextZ(board);

  const cards = sources.map((source) => {
    const id = createId(ID_PREFIX.card);
    idMap.set(source.id, id);
    return {
      ...source,
      id,
      x: roundTo(source.x + dx),
      y: roundTo(source.y + dy),
      z: z++,
      columnId: null,
      order: 0,
      presentStep: null,
      content: cloneJson(source.content),
    } as Card;
  });

  const minds = mindSources.map((source) => {
    const { mind, nodeIds } = cloneMindForCopy(source);
    idMap.set(source.id, mind.id);
    for (const [oldId, newId] of nodeIds) nodeIdMap.set(nodeKey(source.id, oldId), newId);
    mind.x = roundTo(source.x + dx);
    mind.y = roundTo(source.y + dy);
    mind.z = z++;
    return mind;
  });

  // 端点没跟着搬过来的连线不复制：宁可不画这条线，也不留一条指向空白处的线
  const edges: Edge[] = [];
  for (const edge of transfer.edges) {
    const from = idMap.get(edge.from.cardId);
    const to = idMap.get(edge.to.cardId);
    if (!from || !to) continue;
    edges.push({
      ...cloneJson(edge),
      id: createId(ID_PREFIX.edge),
      from: remapEndpoint(edge.from, from, nodeIdMap),
      to: remapEndpoint(edge.to, to, nodeIdMap),
    });
  }

  board.cards.push(...cards);
  board.edges.push(...edges);
  if (minds.length > 0) board.minds = [...(board.minds ?? []), ...minds];
  return { cards, minds };
}

/** 端点身份的键（与 `schema.nodeEndpointKey` 同形；本文件的节点 id 映射表按它查） */
function nodeKey(mindId: string, nodeId: string): string {
  return `${mindId}/${nodeId}`;
}

/**
 * 把一个端点的 `cardId` 换成新 id，**顺便**把节点那一层也换掉。
 *
 * ★ 内嵌脑图里的节点 id 全换了新（见 `cloneMindForCopy`）⇒ 指着"老节点"的线必须跟着改；
 *   文件脑图的节点 id 属于那份文件、一个字都没变 ⇒ 原样保留（`nodeIdMap` 里查不到）。
 */
function remapEndpoint(
  endpoint: EdgeEndpoint,
  cardId: string,
  nodeIdMap: ReadonlyMap<string, string>,
): EdgeEndpoint {
  if (!endpoint.nodeId) return { ...endpoint, cardId };
  const mapped = nodeIdMap.get(nodeKey(endpoint.cardId, endpoint.nodeId));
  return mapped ? { ...endpoint, cardId, nodeId: mapped } : { ...endpoint, cardId };
}
