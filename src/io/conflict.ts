/**
 * 同步冲突副本的识别与对比（T4.03 / 03 §3.4）。
 *
 * 多设备（Obsidian Sync / iCloud / Syncthing / Dropbox）在两端同时改一个文件时，
 * 不会去合并内容，而是**再存一份**，名字里带各家自己的标记。用户看到的是
 * "库里莫名其妙多了一块白板"；真正危险的是两份都像"正常工作过"的版本，
 * 谁也看不出哪一份少了几张卡。
 *
 * 本文件只做两件事，都**不 import `obsidian`**：
 *   1. 从文件名认出一份"冲突副本"，并推出它大概对应哪块原板
 *      （`isConflictBoardPath` / `conflictBasePath`）；
 *   2. 把两块板按**卡片 id** 对齐，算出并排只读对比要用的行（`diffBoards`）。
 *
 * ★ 为什么按 `id` 对齐而不是按标题 / 序号：`id` 是跨重命名稳定的（见 `schema.ts`
 *   的 `BoardMeta.id`），同一张卡在两份文件里 id 必然一致。按序号对齐会让
 *   "中间删掉一张卡"变成后面所有卡都"有差异"，那种对比噪声大到没法看。
 */

import type { Card, CardType, BoardFile } from '../model/schema';
import { BOARD_EXT } from '../constants';
import type { VaultIO } from './vaultIO';

// ─────────────────────────────────────────────────────────────
// 文件名识别
// ─────────────────────────────────────────────────────────────

/**
 * 把一份"冲突副本"的文件名还原成原板路径；不是冲突副本时返回 `null`。
 *
 * 覆盖的命名形态（都见过真实案例）：
 *   - `父版.nboard.conflict-1712`      —— 03 §3.4 字面写的那种
 *   - `父版.nboard.conflict`           —— 有的工具不加尾注
 *   - `父版.conflict-1712.nboard`      —— 标记在扩展名之前
 *   - `父版.conflict.nboard`
 *   - `父版.sync-conflict-20260912-101500-ABCDEF.nboard`（Syncthing）
 *   - `父版 (conflicted copy 2026-09-12).nboard`（Dropbox）
 *   - `父版 (case conflict).nboard`
 *   - `父版 (conflict 2026-09-11T02-00-00).nboard`（本插件 `findFreeCopyPath` 的产物）
 *
 * ★ 判定与还原**共用一套规则**（`isConflictBoardPath` 就是"还原得出来"），
 *   否则两处一旦漂移就会出现"认出来了却算不出原板"这种半吊子状态。
 */
export function conflictBasePath(path: string): string | null {
  const slash = path.lastIndexOf('/');
  const dir = slash >= 0 ? path.slice(0, slash) : '';
  const name = slash >= 0 ? path.slice(slash + 1) : path;

  const base = stripConflictMarker(name);
  if (base === null || base === name) return null;
  return dir.length > 0 ? `${dir}/${base}` : base;
}

export function isConflictBoardPath(path: string): boolean {
  return conflictBasePath(path) !== null;
}

/** 冲突副本在库里的样子：原板路径 + 副本路径。`basePath` = 推不出原板时为 `null` */
export interface ConflictCopy {
  path: string;
  basePath: string | null;
}

/**
 * 扫出库里的全部冲突副本。
 *
 * ★ 走 `io.listAll()` 而不是 `io.list('nboard')`：`父版.nboard.conflict-1712`
 *   的扩展名是 `conflict-1712`（最后一个点之后那截），按扩展名过滤会**整类漏掉**，
 *   而它恰恰是任务书里写的那种形态。
 */
export async function findConflictCopies(io: VaultIO): Promise<ConflictCopy[]> {
  const paths = await io.listAll();
  const copies: ConflictCopy[] = [];
  for (const path of paths) {
    if (!isConflictBoardPath(path)) continue;
    copies.push({ path, basePath: conflictBasePath(path) });
  }
  return copies.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * 抹掉冲突标记。
 *
 * ★ 分两条路，因为标记可能在扩展名**之后**（`X.nboard.conflict-…`）——
 *   那种形态下没有 `.nboard` 结尾，先按扩展名切会直接失败。
 */
function stripConflictMarker(name: string): string | null {
  // ① 标记缀在扩展名之后：砍掉 `.conflict…` 整条尾巴，剩下的 `X.nboard` 就是原板
  if (/\.nboard\.conflict/i.test(name)) return name.replace(/\.conflict.*$/i, '');

  // ② 标记在 `.nboard` 之前：先切掉扩展名，再逐条抹标记，最后补回扩展名
  const ext = /^(.*)\.nboard$/i.exec(name);
  if (!ext) return null;

  const stem = ext[1]
    .replace(/\.sync-conflict(?:[ ._-][^/]*)?$/i, '')
    .replace(/\.conflict(?:[ ._-][^/]*)?$/i, '')
    .replace(/\s*\([^()]*conflict[^()]*\)$/i, '');

  return `${stem}.${BOARD_EXT}`;
}

// ─────────────────────────────────────────────────────────────
// 两块板的对比
// ─────────────────────────────────────────────────────────────

export type CardDiffStatus = 'same' | 'left-only' | 'right-only' | 'changed';

/** 对比视图里的一行：左（当前版本）/ 右（冲突副本）各自的卡片文本 */
export interface CardDiffRow {
  id: string;
  status: CardDiffStatus;
  type: CardType;
  /** 左列文本；`right-only` 时为 `null`（那一格显示"—"） */
  left: string | null;
  right: string | null;
}

/** 一块板的"人话摘要"（对比视图两侧头部用） */
export interface BoardDigest {
  title: string;
  cards: number;
  columns: number;
  edges: number;
  revision: number;
  updatedAt: string;
}

export interface BoardDiff {
  left: BoardDigest;
  right: BoardDigest;
  /** 并集：左板顺序在前，只有副本才有的卡片追加在后 */
  rows: CardDiffRow[];
  counts: Record<CardDiffStatus, number>;
}

export function digestBoard(board: BoardFile): BoardDigest {
  return {
    title: board.meta.title,
    cards: board.cards.length,
    columns: board.columns.length,
    edges: board.edges.length,
    revision: board.revision,
    updatedAt: board.meta.updatedAt,
  };
}

export function diffBoards(left: BoardFile, right: BoardFile): BoardDiff {
  const leftCards = new Map(left.cards.map((card) => [card.id, card]));
  const rightCards = new Map(right.cards.map((card) => [card.id, card]));

  const counts: Record<CardDiffStatus, number> = {
    same: 0,
    'left-only': 0,
    'right-only': 0,
    changed: 0,
  };
  const rows: CardDiffRow[] = [];

  for (const card of left.cards) {
    const counterpart = rightCards.get(card.id);
    if (!counterpart) {
      counts['left-only']++;
      rows.push({
        id: card.id,
        status: 'left-only',
        type: card.type,
        left: cardLabel(card),
        right: null,
      });
      continue;
    }
    const same = cardsEqual(card, counterpart);
    counts[same ? 'same' : 'changed']++;
    rows.push({
      id: card.id,
      status: same ? 'same' : 'changed',
      type: card.type,
      left: cardLabel(card),
      right: cardLabel(counterpart),
    });
  }

  // 只有副本才有的卡片：追加在最后。它们没有对应的"左列"，因此排在"左板顺序"之后
  // 才不会把两边都有的卡片打散 —— 对比视图最怕的就是行对不齐
  for (const card of right.cards) {
    if (leftCards.has(card.id)) continue;
    counts['right-only']++;
    rows.push({
      id: card.id,
      status: 'right-only',
      type: card.type,
      left: null,
      right: cardLabel(card),
    });
  }

  return { left: digestBoard(left), right: digestBoard(right), rows, counts };
}

/**
 * 同一张卡在两份文件里是不是"内容一致"。
 *
 * ★ 用整对象的 `JSON.stringify` 比较：两个模型都经过同一套 `normalizeBoardFile`
 *   规范化，键序稳定；比逐字段手写比较更不容易漏字段（漏一个就是一个"改了却报一致"）。
 *   代价是大板上每张卡多一次序列化 —— 对比是**用户主动打开**的动作，可以接受。
 */
function cardsEqual(a: Card, b: Card): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** 卡片上的"人话"分散在两层：卡片自己的 `title`，以及 `content` 里各类型不同的字段 */
const TOP_TEXT_KEYS = ['title'] as const;
/** ★ 必须覆盖 `content` 的**真实字段名**（`03 §2.7`）：便签是 `md`、待办是 `items`、
 *  色板是 `colors`…… 只认 `text/title` 的话，一屏对比里会全是 `[note]`，等于没比 */
const CONTENT_TEXT_KEYS = [
  'title',
  'caption',
  'md',
  'text',
  'path',
  'url',
  'name',
  'query',
  'src',
] as const;
/** 数组型字段：待办项 `{ text }`、色板 `['#fff', …]` */
const CONTENT_LIST_KEYS = ['items', 'colors'] as const;

/** 列表里一行卡片文本的最大长度 */
const LABEL_LIMIT = 80;

/**
 * 从一张卡里挤出"这是哪张卡"。
 *
 * 挤不出任何文本时**退回类型名**（如 `note`），而不是空字符串 ——
 * 空白的格子会让人以为"这张卡没有内容"，其实是"我们没找到能显示的那部分"。
 */
export function cardLabel(card: Card): string {
  const record = card as unknown as Record<string, unknown>;
  const found = findText(record, TOP_TEXT_KEYS);
  const content = (record.content ?? {}) as Record<string, unknown>;
  const label = found ?? findText(content, CONTENT_TEXT_KEYS) ?? findListText(content) ?? '';

  const flat = label.replace(/\s+/g, ' ').trim();
  if (flat.length === 0) return card.type;
  return flat.length > LABEL_LIMIT ? `${flat.slice(0, LABEL_LIMIT)}…` : flat;
}

function findText(source: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return null;
}

function findListText(source: Record<string, unknown>): string | null {
  for (const key of CONTENT_LIST_KEYS) {
    const value = source[key];
    if (!Array.isArray(value)) continue;
    const text = firstTextOf(value);
    if (text !== null) return text;
  }
  return null;
}

/** 数组型内容的"第一条"：可能是字符串（色板颜色），也可能是 `{ text }`（待办项） */
function firstTextOf(items: readonly unknown[]): string | null {
  const first = items[0];
  if (typeof first === 'string' && first.trim().length > 0) return first;
  if (typeof first === 'object' && first !== null) {
    const text = (first as { text?: unknown }).text;
    if (typeof text === 'string' && text.trim().length > 0) return text;
  }
  return null;
}
