/**
 * `.xmind` → 脑图节点（用户 2026-09-28："在脑图右上角菜单中，注入一个导入 .xmind 格式的
 * 功能。导入的话，会直接**替换**当前脑图内容"）。
 *
 * ── 它读的是什么 ────────────────────────────────────────────
 *
 * `.xmind` 是一个 ZIP，包里的 `content.json` 就是**主题树**（与 `export/toXmind.ts`
 * 写出去的正是同一份结构 —— 导入我们自己导出的文件当然也认）。
 *
 * ★ 传进来的是**包内文件清单**（`{ path, content }`），不是 zip 本身：解压归
 *   `io/unzip.ts`，本文件是纯函数（不 import `obsidian`、不碰 DOM、不碰 ZIP）⇒ 可单测。
 * ★ 只取三样：**标题**（`title`）、**层级**（`children.attached`）、**备注**
 *   （`notes.plain.content`）—— 与导出的裁剪口径对称（标记 / 撞色 / 完成态在
 *   XMind 里本来就没有对应物）。XMind 8 那种老格式（`content.xml`）**不支持**：
 *   明确返回原因，别猜着解析出一棵歪树。
 */

import { ID_PREFIX } from '../../constants';
import { createId } from '../../util/id';
import type { MindNode } from '../model/schema';

/** 包内一个文件（与 `toXmind` 的 `XmindEntry` 同一个形状） */
export interface XmindEntryLike {
  path: string;
  content: string;
}

/** 导入结果：节点表 + 根节点 id；失败时 `reason` 说清为什么 */
export type XmindImportResult =
  | { ok: true; nodes: MindNode[]; rootId: string }
  | { ok: false; reason: 'no-content' | 'bad-json' | 'empty' };

/** XMind 主题里我们认得的字段（其余一律忽略 —— 别人的格式，别越权解释） */
interface XmindTopic {
  title?: unknown;
  notes?: { plain?: { content?: unknown } };
  children?: { attached?: unknown };
}

/** 一个主题 → 节点（递归展开 `children.attached`） */
function nodeOf(topic: XmindTopic, parentId: string | null, order: number): MindNode[] {
  const id = createId(ID_PREFIX.mindNode);
  const text = typeof topic.title === 'string' ? topic.title : '';
  const noteText = typeof topic.notes?.plain?.content === 'string' ? topic.notes.plain.content : '';
  const node: MindNode = {
    id,
    text,
    note: noteText,
    parentId,
    order,
  };
  const children = Array.isArray(topic.children?.attached)
    ? (topic.children.attached as XmindTopic[])
    : [];
  const rest = children.flatMap((child, index) => nodeOf(child, id, index));
  return [node, ...rest];
}

/**
 * 把包内文件清单转成一份节点表（**替换**语义：调用方拿它整体换掉当前的 `nodes`）。
 *
 * ★ 多个画布（XMind 的 sheet）：**只取第一个**。合并成一棵树会让"两个中心主题"这种
 *   东西凭空出现，而我们的模型里中心主题只有一个、且不可删 —— 宁可少导入，不要造出
 *   一棵自己都不认识的树（口径写在这里，免得日后被当缺陷）。
 */
export function importXmindEntries(entries: readonly XmindEntryLike[]): XmindImportResult {
  const content = entries.find((entry) => entry.path.endsWith('content.json'));
  if (!content) return { ok: false, reason: 'no-content' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(content.content);
  } catch {
    return { ok: false, reason: 'bad-json' };
  }

  const sheets = Array.isArray(parsed) ? parsed : [parsed];
  const first = sheets[0] as { rootTopic?: XmindTopic } | undefined;
  const rootTopic = first?.rootTopic;
  if (!rootTopic || typeof rootTopic !== 'object') return { ok: false, reason: 'empty' };

  const nodes = nodeOf(rootTopic, null, 0);
  const root = nodes[0];
  if (!root) return { ok: false, reason: 'empty' };
  return { ok: true, nodes, rootId: root.id };
}
