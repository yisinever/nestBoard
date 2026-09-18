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
import { boundsOf, roundTo, type Point } from '../util/geometry';
import { nextZ } from './factories';
import { cloneJson } from './ops';
import type { BoardFile, Card, Edge } from './schema';
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
  edges: Edge[];
}

/**
 * 把选中的卡片做成一段可放进系统剪贴板的文本。
 *
 * @param ids 选中的卡片 id（不在板上的会被忽略）
 * @returns 没有可搬的卡片时返回 `null`（调用方据此提示"没选中卡片"）
 */
export function buildCardTransfer(board: BoardFile, ids: readonly string[]): string | null {
  const wanted = new Set(ids);
  const cards = board.cards.filter((card) => wanted.has(card.id));
  if (cards.length === 0) return null;

  // ★ 判定用"卡片是否在选中集里"，而不是"这条连线是否被选中"：
  //   连线的端点可能被删、可能是自由端，逐条判端点才是唯一可靠的口径
  const copied = new Set(cards.map((card) => card.id));
  const edges = board.edges.filter(
    (edge) => copied.has(edge.from.cardId) && copied.has(edge.to.cardId),
  );

  return `${JSON.stringify({ nestboard: TRANSFER_MARKER, cards, edges }, null, 2)}\n`;
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
  return { cards: normalized.board.cards, edges: normalized.board.edges };
}

/**
 * 把搬运载荷贴进目标板。
 *
 * 直接改 `board`（与 `duplicateCards` / `addCards` 同一约定：模型层只改数据，
 * 记历史、刷视图、发通知都是视图层的事）。
 *
 * @param at 落点（世界坐标）：整组卡片的**包围盒左上角**会落在这里
 * @returns 新插入的卡片（用于"贴完选中它们"，与复制粘贴的通用手感一致）
 */
export function pasteCardTransfer(board: BoardFile, transfer: CardTransfer, at: Point): Card[] {
  const sources = transfer.cards;
  if (sources.length === 0) return [];

  const box = boundsOf(sources);
  const dx = box ? at.x - box.x : 0;
  const dy = box ? at.y - box.y : 0;

  const idMap = new Map<string, string>();
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

  // 端点没跟着搬过来的连线不复制：宁可不画这条线，也不留一条指向空白处的线
  const edges: Edge[] = [];
  for (const edge of transfer.edges) {
    const from = idMap.get(edge.from.cardId);
    const to = idMap.get(edge.to.cardId);
    if (!from || !to) continue;
    edges.push({
      ...cloneJson(edge),
      id: createId(ID_PREFIX.edge),
      from: { ...edge.from, cardId: from },
      to: { ...edge.to, cardId: to },
    });
  }

  board.cards.push(...cards);
  board.edges.push(...edges);
  return cards;
}
