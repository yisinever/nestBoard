/**
 * 白板内的**查找与替换**（用户 2026-09-28："要支持检索和替换……白板和脑图都要支持"，
 * 当天晚上又点名："参考 obsidian 原生的 md 的查找替换功能"）。
 *
 * ── 两条口径 ────────────────────────────────────────────────
 *
 * 1. **逐处命中**（`FindMatch`）：界面要"高亮每一处 + 当前那一处 + 逐个替换"，
 *    光有"命中多少处"不够 —— 每一处必须能定位到"哪个对象的哪个字段的第几个字符"。
 * 2. **纯逻辑、不 import `obsidian`、不碰 DOM**：错一条就是"替换把别的东西改坏了"，
 *    必须能在 node 下逐条钉死；界面（浮条 / 高亮）只管画。
 *
 * ★ 收录的**写字段**与索引笔记摘录同一份口径（`model/indexNote.ts` 的 `cardRawTextOf`）：
 *   便签 md、待办标题与条目、评论、内嵌脑图节点文字、卡片标题、白板脑图节点文字。
 * ★ 替换一律走**切片**（`start`/`end`）或 `replace` 的**函数形式**：用户替换串里写 `$&`
 *   是他想要的字面量，不是正则替换模式。
 */

import type { BoardFile, Card } from './schema';

/** 查找选项（缺席 = 不分大小写：检索用户的文字，宽松是默认的礼貌） */
export interface FindOptions {
  /** 区分大小写；缺席 = 不区分 */
  matchCase?: boolean;
}

/** **一处**命中：哪个对象的哪个字段、从第几个字符到第几个字符（`end` 不含） */
export interface FindMatch {
  /** 卡片 id / 白板上的脑图 id / `.nestmind` 里的节点 id */
  targetId: string;
  /**
   * 字段名（同一个对象里可能有多处可写文字）：
   * `title` / `md` / `todoTitle` / `todoItem:<i>` / `comment:<i>` / `node:<节点id>`。
   */
  field: string;
  start: number;
  end: number;
}

/** 可写文字的**一个槽位**：命中扫描与写回共用同一条遍历（不会一个找到了另一个改漏） */
interface TextTarget {
  targetId: string;
  field: string;
  get(): string;
  set(next: string): void;
}

/** 把用户查询变成安全的全局正则（字面量匹配，转义全部正则元字符） */
function queryRegex(query: string, options: FindOptions): RegExp | null {
  if (query.length === 0) return null;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(escaped, options.matchCase ? 'g' : 'gi');
}

/** 收集一张卡上所有**写字段**的槽位 */
function cardTargets(card: Card): TextTarget[] {
  const targets: TextTarget[] = [];
  targets.push({
    targetId: card.id,
    field: 'title',
    get: () => card.title ?? '',
    set: (next) => (card.title = next),
  });
  switch (card.type) {
    case 'note':
      targets.push({
        targetId: card.id,
        field: 'md',
        get: () => card.content.md,
        set: (next) => (card.content.md = next),
      });
      break;
    case 'todo':
      targets.push({
        targetId: card.id,
        field: 'todoTitle',
        get: () => card.content.title,
        set: (next) => (card.content.title = next),
      });
      card.content.items.forEach((item, index) => {
        targets.push({
          targetId: card.id,
          field: `todoItem:${index}`,
          get: () => item.text,
          set: (next) => (item.text = next),
        });
      });
      break;
    case 'comment':
      card.content.entries.forEach((entry, index) => {
        targets.push({
          targetId: card.id,
          field: `comment:${index}`,
          get: () => entry.text,
          set: (next) => (entry.text = next),
        });
      });
      break;
    case 'mind':
      for (const node of card.content.mind?.nodes ?? []) {
        targets.push({
          targetId: card.id,
          field: `node:${node.id}`,
          get: () => node.text,
          set: (next) => (node.text = next),
        });
      }
      break;
    default:
      break;
  }
  return targets;
}

/** 一块板上的全部写字段槽位（卡片 + 白板上的脑图节点） */
function boardTargets(board: BoardFile): TextTarget[] {
  const targets: TextTarget[] = [];
  for (const card of board.cards) targets.push(...cardTargets(card));
  for (const mind of board.minds ?? []) {
    for (const node of mind.mind?.nodes ?? []) {
      targets.push({
        targetId: mind.id,
        field: `node:${node.id}`,
        get: () => node.text,
        set: (next) => (node.text = next),
      });
    }
  }
  return targets;
}

/** 一份脑图（`.nestmind` 视图）的槽位：就是它每个节点的文字 */
function mindTargets(nodes: readonly { id: string; text: string }[]): TextTarget[] {
  return nodes.map((node) => ({
    targetId: node.id,
    field: 'node',
    get: () => node.text,
    set: (next: string) => (node.text = next),
  }));
}

/** 在一条槽位里扫出全部命中（按出现顺序） */
function matchesIn(target: TextTarget, regex: RegExp): FindMatch[] {
  const text = target.get();
  if (text.length === 0) return [];
  const out: FindMatch[] = [];
  for (const hit of text.matchAll(regex)) {
    const start = hit.index ?? 0;
    out.push({
      targetId: target.targetId,
      field: target.field,
      start,
      end: start + hit[0].length,
    });
  }
  return out;
}

/** 一块板上的**全部命中**（按对象数组序 → 字段序 → 出现序，稳定） */
export function findBoardMatches(
  board: BoardFile,
  query: string,
  options: FindOptions = {},
): FindMatch[] {
  const regex = queryRegex(query, options);
  if (!regex) return [];
  return boardTargets(board).flatMap((target) => matchesIn(target, regex));
}

/** 一份脑图上的全部命中（`.nestmind` 视图用；口径与白板一致） */
export function findMindMatches(
  nodes: readonly { id: string; text: string }[],
  query: string,
  options: FindOptions = {},
): FindMatch[] {
  const regex = queryRegex(query, options);
  if (!regex) return [];
  return mindTargets(nodes).flatMap((target) => matchesIn(target, regex));
}

/** 命中总数（浮条上的 "n/m" 用它） */
export function countBoardMatches(
  board: BoardFile,
  query: string,
  options: FindOptions = {},
): number {
  return findBoardMatches(board, query, options).length;
}

/** 命中总数（脑图） */
export function countMindMatches(
  nodes: readonly { id: string; text: string }[],
  query: string,
  options: FindOptions = {},
): number {
  return findMindMatches(nodes, query, options).length;
}

/** 把一条槽位按区间切片写回；区间越界（命中已被别处改动过）就返回 false */
function applyMatch(target: TextTarget, match: FindMatch, replacement: string): boolean {
  const text = target.get();
  if (match.start < 0 || match.end > text.length || match.start >= match.end) return false;
  target.set(text.slice(0, match.start) + replacement + text.slice(match.end));
  return true;
}

/**
 * **只替换一处**（浮条上的「替换」按钮）。
 *
 * ★ 区间由**刚扫出来的** `match` 给（界面每次都先重扫一次再动）⇒ 直接切片，
 *   不用正则、也不会把 `$&` 当替换模式展开。
 */
export function replaceBoardMatch(
  board: BoardFile,
  match: FindMatch,
  replacement: string,
): boolean {
  const target = boardTargets(board).find(
    (item) => item.targetId === match.targetId && item.field === match.field,
  );
  return target ? applyMatch(target, match, replacement) : false;
}

/** 只替换一处（脑图） */
export function replaceMindMatch(
  nodes: readonly { id: string; text: string }[],
  match: FindMatch,
  replacement: string,
): boolean {
  const target = mindTargets(nodes).find((item) => item.targetId === match.targetId);
  return target ? applyMatch(target, match, replacement) : false;
}

/** 全部替换（一步撤销）；有改动返回 `true`。空查询直接 `false` */
export function replaceInBoard(
  board: BoardFile,
  query: string,
  replacement: string,
  options: FindOptions = {},
): boolean {
  const regex = queryRegex(query, options);
  if (!regex) return false;
  let changed = false;
  for (const target of boardTargets(board)) {
    const before = target.get();
    if (!regex.test(before)) continue;
    regex.lastIndex = 0;
    target.set(before.replace(regex, () => replacement));
    changed = true;
  }
  return changed;
}

/** 一份脑图的全部替换；有改动返回 `true` */
export function replaceInMind(
  nodes: readonly { text: string }[],
  query: string,
  replacement: string,
  options: FindOptions = {},
): boolean {
  const regex = queryRegex(query, options);
  if (!regex) return false;
  let changed = false;
  for (const node of nodes) {
    const before = node.text;
    if (!regex.test(before)) continue;
    regex.lastIndex = 0;
    node.text = before.replace(regex, () => replacement);
    changed = true;
  }
  return changed;
}
