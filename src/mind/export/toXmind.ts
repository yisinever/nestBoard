/**
 * 脑图 → `.xmind`（用户 2026-09-17）。
 *
 * ── 交出去的是"包内文件清单"，不是一个 zip ───────────────────
 *
 * `.xmind` 本质是一个 ZIP：`content.json`（主题树）+ `metadata.json` + `manifest.json`。
 * 这一层只产出**文本内容**（纯函数、可单测），打包交给调用方 —— 视图那边用
 * `export/toZip.buildZip`（与白板导出 ZIP 同一个编码器，store 不压缩，
 * XMind 那边的标准 ZIP 读取器认）。
 *
 * ── 规范内的裁剪（用户点头："不符合 xmind 要求的一些内容可以裁剪掉"）────
 *
 * XMind 只认"一棵主题树 + 每个主题一份备注"，所以下面这些**丢掉**：
 * * **标记 / 图标**（`node.icon`，快捷操作栏挑的 emoji）—— XMind 有自己的 marker 体系
 *   （`org.xmind.ui.marker.*`），拿 emoji 冒充只会得到一堆在 XMind 里显示不出来的东西；
 * * **撞色与字号**（`node.style` / 层级配色）—— 那是我们画布的观感，XMind 打开时套它自己的主题；
 * * **完成态**（`node.done`）—— 同样没有对应物（宁可少一个勾，也不要编造一个）。
 *
 * 保留的两样：
 * * **标题**（`text`）与**层级**（树本身）；
 * * **内容**（`note`）与**附件路径** ⇒ 一起写进 XMind 的**备注**（`notes.plain.content`，
 *   附件那几行排在正文之后）—— "用户写过的东西"里唯一能在 XMind 里原样活下去的部分。
 *
 * ★ **悬浮节点**（`parentId === null` 且不是根）：XMind 的主题树里没有它们的位置
 *   ⇒ 挂到**根节点**后面。宁可结构上不精确，也不要整块内容消失。
 * ★ 纯函数：不 import `obsidian`、不碰 DOM，可直接单测。
 */

import type { MindFile, MindNode, MindRef, MindStructure } from '../model/schema';

/** 包内一个文件（`path` 是 ZIP 里的路径） */
export interface XmindEntry {
  path: string;
  content: string;
}

export interface XmindOptions {
  /** 写进 `metadata.json` 的创建者（视图传插件名与版本号） */
  creator?: { name: string; version: string };
}

/** 我们那四种总体结构 → XMind 的 `structureClass`（XMind 认这几个内建结构） */
const STRUCTURE_CLASS: Record<MindStructure, string> = {
  'logic-right': 'org.xmind.ui.logic.right',
  'logic-left': 'org.xmind.ui.logic.left',
  octopus: 'org.xmind.ui.map.unbalanced',
  'org-down': 'org.xmind.ui.org-chart.down',
};

/** 结构缺失 / 认不出时的兜底：逻辑图向右（与画布默认观感一致） */
const FALLBACK_STRUCTURE_CLASS = 'org.xmind.ui.logic.right';

const DEFAULT_CREATOR = { name: 'Nestboard', version: '' };

/**
 * 一份脑图 → `.xmind` 的三个包内文件。
 *
 * 顺序有意义：`content.json` 打头（人翻看 zip 时第一眼看到的就是主题树）。
 */
export function mindToXmindEntries(file: MindFile, options: XmindOptions = {}): XmindEntry[] {
  const children = childrenByParent(file);
  const root = file.nodes.find((node) => node.id === file.rootId) ?? null;

  const rootTopic = root ? topicOf(root, children) : emptyTopic();
  // ★ 悬浮节点挂到根后面（见文件头）：它们不属于任何一支，但绝不能消失
  const floating = file.nodes.filter((node) => node.parentId === null && node.id !== file.rootId);
  if (floating.length > 0) {
    const attached = attachedOf(rootTopic);
    for (const node of floating) attached.push(topicOf(node, children));
  }

  const sheet: Record<string, unknown> = {
    id: `sheet-${file.meta.id}`,
    class: 'sheet',
    title: file.meta.title.trim().length > 0 ? file.meta.title : titleOf(root),
    rootTopic,
  };

  const creator = options.creator ?? DEFAULT_CREATOR;
  const structure = file.view.structure;
  sheet.structureClass =
    (structure ? STRUCTURE_CLASS[structure] : undefined) ?? FALLBACK_STRUCTURE_CLASS;

  return [
    { path: 'content.json', content: `${JSON.stringify([sheet], null, 2)}\n` },
    { path: 'metadata.json', content: `${JSON.stringify({ creator }, null, 2)}\n` },
    {
      path: 'manifest.json',
      content: `${JSON.stringify(
        { 'file-entries': { 'content.json': {}, 'metadata.json': {} } },
        null,
        2,
      )}\n`,
    },
  ];
}

/** 空脑图（根节点都没了）：也得给出一个能打开的 `.xmind`，而不是一份坏文件 */
function emptyTopic(): Record<string, unknown> {
  return { id: 'root', class: 'topic', title: '' };
}

/** 一个主题（含整棵子树） */
function topicOf(
  node: MindNode,
  children: ReadonlyMap<string, MindNode[]>,
): Record<string, unknown> {
  const topic: Record<string, unknown> = {
    id: node.id,
    class: 'topic',
    title: titleOf(node),
  };

  const kids = children.get(node.id) ?? [];
  if (kids.length > 0) {
    topic.children = { attached: kids.map((child) => topicOf(child, children)) };
  }

  const notes = notesOf(node);
  if (notes.length > 0) topic.notes = { plain: { content: notes } };

  return topic;
}

/** 取（必要时建出）`children.attached` —— 悬浮节点要往里追加 */
function attachedOf(topic: Record<string, unknown>): Record<string, unknown>[] {
  const children = topic.children as { attached?: Record<string, unknown>[] } | undefined;
  if (!children) {
    const attached: Record<string, unknown>[] = [];
    topic.children = { attached };
    return attached;
  }
  children.attached ??= [];
  return children.attached;
}

/**
 * 主题的**备注**：正文在前、附件路径在后。
 *
 * ★ 附件写成一行路径（而不是丢掉）：XMind 的备注是纯文本，贴路径是这个形状下
 *   唯一诚实的表达 —— 用户回到 Obsidian 还能照着找回来。
 */
function notesOf(node: MindNode): string {
  const parts: string[] = [];
  const note = node.note.trim();
  if (note.length > 0) parts.push(note);

  const refs = (node.refs ?? []).map(refLine).filter((line) => line.length > 0);
  if (refs.length > 0) parts.push(refs.join('\n'));

  return parts.join('\n\n');
}

function refLine(ref: MindRef): string {
  return ref.path.trim();
}

/** 标题：空标题给一句占位（XMind 里"没有标题的主题"会显示成一个空盒子） */
function titleOf(node: MindNode | null): string {
  if (!node) return '';
  return node.text.trim().length > 0 ? node.text : EMPTY_TITLE;
}

/** 空标题的占位。与 Markdown 导出同一个口径，用户一眼认得出这是"没写" */
const EMPTY_TITLE = '（无标题）';

/** `parentId` → 子节点（按 `order` 排好；坏数据不该让导出顺序乱跳） */
function childrenByParent(file: MindFile): Map<string, MindNode[]> {
  const map = new Map<string, MindNode[]>();
  for (const node of file.nodes) {
    if (node.parentId === null) continue;
    const list = map.get(node.parentId) ?? [];
    list.push(node);
    map.set(node.parentId, list);
  }
  for (const list of map.values()) {
    list.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  }
  return map;
}
