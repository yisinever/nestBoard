/**
 * 白板内的**查找与替换**（用户 2026-09-28："要支持检索和替换，支持文档内的查询和替换。
 * 脑图和白板都要支持"）。
 *
 * ── 设计 ────────────────────────────────────────────────────
 *
 * ★ **纯逻辑、不 import `obsidian`、不碰 DOM**：命中哪些字段、替换怎么写回、
 *   大小写口径 —— 这些错一条就是"替换把别的东西改坏了"，必须能在 node 下逐条钉死；
 *   界面（弹窗 / 命中高亮）只管画。
 * ★ 收录的**写字段**与索引笔记摘录同一份口径（`model/indexNote.ts` 的 `cardRawTextOf`）：
 *   便签 md、待办标题与条目、评论、内嵌脑图节点文字、卡片标题、白板脑图节点文字。
 *   指针类（图片 / 文件 / 链接…）没有"用户写的文字"，不参与。
 * ★ 替换一律走**函数形式**喂给 `String.replace`：用户替换串里写 `$&` 是他想要的字面量，
 *   不是正则替换模式 —— 不用函数形式的话 `$&` 会被展开（静默改错数据的典型）。
 */

import type { BoardFile, Card } from './schema';

/** 查找选项（缺席 = 不分大小写：检索用户的文字，宽松是默认的礼貌） */
export interface FindOptions {
  /** 区分大小写；缺席 = 不区分 */
  matchCase?: boolean;
}

/** 把用户查询变成安全的全局正则（字面量匹配，转义全部正则元字符） */
function queryRegex(query: string, options: FindOptions): RegExp | null {
  if (query.length === 0) return null;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(escaped, options.matchCase ? 'g' : 'gi');
}

/** 一段可写字段的替身：命中计数与替换共用同一条遍历（不会一个找到了另一个改漏） */
interface TextTarget {
  get(): string;
  set(next: string): void;
}

/** 收集一张卡上所有**写字段**的替身 */
function cardTargets(card: Card): TextTarget[] {
  const targets: TextTarget[] = [];
  const title = card.title ?? '';
  targets.push({ get: () => title, set: (next) => (card.title = next) });
  switch (card.type) {
    case 'note':
      targets.push({ get: () => card.content.md, set: (next) => (card.content.md = next) });
      break;
    case 'todo':
      targets.push({
        get: () => card.content.title,
        set: (next) => (card.content.title = next),
      });
      for (const item of card.content.items) {
        targets.push({ get: () => item.text, set: (next) => (item.text = next) });
      }
      break;
    case 'comment':
      for (const entry of card.content.entries) {
        targets.push({ get: () => entry.text, set: (next) => (entry.text = next) });
      }
      break;
    case 'mind':
      for (const node of card.content.mind?.nodes ?? []) {
        targets.push({ get: () => node.text, set: (next) => (node.text = next) });
      }
      break;
    default:
      break;
  }
  return targets;
}

/** 一块板上的全部写字段替身（卡片 + 白板上的脑图节点） */
function boardTargets(board: BoardFile): TextTarget[] {
  const targets: TextTarget[] = [];
  for (const card of board.cards) targets.push(...cardTargets(card));
  for (const mind of board.minds ?? []) {
    for (const node of mind.mind?.nodes ?? []) {
      targets.push({ get: () => node.text, set: (next) => (node.text = next) });
    }
  }
  return targets;
}

/** 这块板里 `query` 一共命中多少处（0 = 没有；空查询恒为 0） */
export function countBoardMatches(
  board: BoardFile,
  query: string,
  options: FindOptions = {},
): number {
  const regex = queryRegex(query, options);
  if (!regex) return 0;
  let total = 0;
  for (const target of boardTargets(board)) {
    const found = target.get().match(regex);
    if (found) total += found.length;
  }
  return total;
}

/**
 * 全部替换；**有改动**返回 `true`（调用方据此决定要不要提交 / 提示）。
 *
 * ★ 就地改传入的 `board`（与 `model/ops.ts` 各 mutator 同一纪律：调用方在
 *   `repository.mutate` 的草稿上跑它）。
 * ★ 空查询直接返回 `false`；替换串里的 `$` 不会被展开（见文件头的"函数形式"说明）。
 */
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

/** 一份脑图（`.nestmind` 视图与大纲共用）的节点文字查找：命中多少处 */
export function countMindMatches(
  nodes: readonly { text: string }[],
  query: string,
  options: FindOptions = {},
): number {
  const regex = queryRegex(query, options);
  if (!regex) return 0;
  let total = 0;
  for (const node of nodes) {
    const found = node.text.match(regex);
    if (found) total += found.length;
  }
  return total;
}

/** 一份脑图的节点文字全部替换；有改动返回 `true`（口径与白板完全一致） */
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
