/**
 * 脑图的撤销快照（`06 §9` P3）。
 *
 * ★ `HistoryStack` 那个类本身是**文档中立的**（`../../model/history`，收的是
 *   `{ label, before, after, mergeKey }` 三段字符串 + 字节预算 + 合并窗口），
 *   脑图**零改动**直接复用；这里只提供两件脑图自己的事：
 *   "什么算一份脑图的内容" 与 "怎么把快照就地写回去"。
 *
 * ── 快照里只有内容 ─────────────────────────────────────────
 *
 * `rootId` + `nodes`。`meta`（标题）/ `view`（视口）/ `revision` **刻意不在内**：
 *
 * * `view` 是界面状态（`06 §3` 纪律 1）—— 撤销一下把视口跳回去，用户会觉得见了鬼；
 * * `meta.title` 属于"文件本身"而不属于"某次编辑"；
 * * `revision` 是并发控制用的计数器，被撤销回滚会让冲突检测彻底失准
 *   （磁盘上的 revision 只能往前，模型里退回去就会被判成"外部改动"）。
 *
 * ★ 纯逻辑：不 import `obsidian`、不碰 DOM。
 */

import type { MindFile, MindNode } from './schema';

interface MindContent {
  rootId: string;
  nodes: MindNode[];
}

/** 取一份快照（**必须在 `mutate` 之前**取 —— 之后模型已经被就地改过了） */
export function serializeMindContent(mind: MindFile): string {
  const content: MindContent = { rootId: mind.rootId, nodes: mind.nodes };
  return JSON.stringify(content);
}

/**
 * 把快照写回模型（**就地替换两个字段**，其余一个不碰）。
 *
 * 返回是否写回成功 —— 坏快照宁可放弃撤销，也不能把脑图搞成半截状态
 * （与白板 `restoreContent` 同一条：拿不准的时候什么都不做，比做一半强）。
 */
export function restoreMindContent(mind: MindFile, raw: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== 'object') return false;

  const content = parsed as Partial<MindContent>;
  if (typeof content.rootId !== 'string' || content.rootId.length === 0) return false;
  if (!Array.isArray(content.nodes)) return false;

  mind.rootId = content.rootId;
  mind.nodes = content.nodes;
  return true;
}
