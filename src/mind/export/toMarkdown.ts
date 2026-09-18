/**
 * 脑图 → Markdown（`06 §7.3`：树 → 标题层级 + 每个节点的正文）。
 *
 * ── 为什么这个导出几乎是"白送"的 ───────────────────────────
 *
 * 脑图的模型本来就是一棵树，而 Markdown 恰好有一层层标题 —— 两者是同一个形状。
 * 于是不需要任何渲染器：**深度 → 标题级别**，正文原样贴上去即可。
 *
 * ── 三条口径 ─────────────────────────────────────────────
 *
 * 1. **标题级别跟着深度走**（`#` 是文档标题、`##` 起才是节点）。超过六级标题时
 *    （`######` 已是 Markdown 的上限）退化成缩进列表 —— 硬写七个 `#` 会被渲染器
 *    当成普通文本，"层级"这件事反而丢了。
 * 2. **折叠起来的子树照样导出**：`collapsed` 是"这一刻怎么看"，不是"这份内容是什么"。
 *    导出漏掉用户写过的东西是最难被原谅的一种丢数据。
 * 3. **附件写成链接**（图片用 `![[…]]` 嵌入）：`refs` 是结构化引用，倒出来就是
 *    Obsidian 自己能认的语法 —— 于是"脑图 → Markdown → 再粘回 Obsidian"是通的。
 *
 * ★ 纯函数：不 import `obsidian`、不碰 DOM，可直接单测。
 */

import type { MindFile, MindNode, MindRef } from '../model/schema';

/** Markdown 的标题上限（`######`） */
const MAX_HEADING_DEPTH = 6;
/** 超过标题上限之后每一层缩进几个空格 */
const LIST_INDENT = 2;

export interface MarkdownOptions {
  /** 开头是否写文档标题（默认写） */
  includeTitle?: boolean;
}

/** 导出成 Markdown 文本（末尾保证有一个换行） */
export function mindToMarkdown(file: MindFile, options: MarkdownOptions = {}): string {
  const lines: string[] = [];

  if (options.includeTitle !== false) {
    lines.push(`# ${file.meta.title}`, '');
  }

  const byId = new Map(file.nodes.map((node) => [node.id, node]));
  const children = new Map<string, MindNode[]>();
  for (const node of file.nodes) {
    if (node.parentId === null) continue;
    const list = children.get(node.parentId) ?? [];
    list.push(node);
    children.set(node.parentId, list);
  }
  // 次序按 `order`（`validate` 已保证它连续，这里再兜一次底：坏数据不该让导出的顺序乱跳）
  for (const list of children.values()) {
    list.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  }

  // ★ 根从**二级**标题起：一级留给文档标题，否则"文档"与"中心主题"在导出的
  //   大纲里变成同一级，用户一眼看不出哪一层是整份文档
  const root = byId.get(file.rootId);
  if (root) writeNode(root, 2, lines, children);

  // 悬浮节点不属于主树，但它们是用户写下的内容 —— 单独一节收好，绝不丢
  const free = file.nodes.filter((node) => node.parentId === null && node.id !== file.rootId);
  if (free.length > 0) {
    lines.push(`## ${'自由主题'}`, '');
    for (const node of free) writeNode(node, 3, lines, children);
  }

  return `${lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()}\n`;
}

/** 一个节点（含它的子树）→ 行 */
function writeNode(
  node: MindNode,
  depth: number,
  lines: string[],
  children: ReadonlyMap<string, MindNode[]>,
): void {
  if (depth <= MAX_HEADING_DEPTH) {
    lines.push(`${'#'.repeat(depth)} ${titleOf(node)}`, '');
  } else {
    // 六级标题之外：缩进列表（`- 文字`），层级靠缩进表达
    const indent = ' '.repeat((depth - MAX_HEADING_DEPTH - 1) * LIST_INDENT);
    lines.push(`${indent}- ${titleOf(node)}`, '');
  }

  const note = node.note.trim();
  if (note.length > 0) lines.push(indentBlock(note, depth), '');

  for (const ref of node.refs ?? []) lines.push(refLine(ref), '');
  if ((node.refs ?? []).length > 0) lines.push('');

  for (const child of children.get(node.id) ?? []) writeNode(child, depth + 1, lines, children);
}

/** 节点标题；空标题给一句占位（否则导出的那一行只有一个 `#`） */
function titleOf(node: MindNode): string {
  return node.text.trim().length > 0 ? node.text : '（无标题）';
}

/** 正文原样贴出（它本来就是 Markdown）；深层节点跟着缩进，读起来才在树里 */
function indentBlock(note: string, depth: number): string {
  if (depth <= MAX_HEADING_DEPTH) return note;
  const indent = ' '.repeat((depth - MAX_HEADING_DEPTH - 1) * LIST_INDENT);
  return note
    .split('\n')
    .map((line) => (line.length > 0 ? `${indent}${line}` : line))
    .join('\n');
}

/**
 * 附件 → 链接。
 *
 * ★ 图片用 `![[…]]`（嵌入）、其余用 `[[…]]`（链接）：这与用户在 Obsidian 里的
 *   直觉一致 —— 一张图导出来应该是能看见的图，而不是一个文件名。
 */
function refLine(ref: MindRef): string {
  return ref.kind === 'image' ? `![[${ref.path}]]` : `[[${ref.path}]]`;
}
