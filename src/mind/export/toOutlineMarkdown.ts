/**
 * 脑图 → **大纲式 Markdown**（用户 2026-09-17）—— 与 `toMarkdown.ts` 是**两份不同的口味**，
 * 两个都在（用户要的是"额外的导出"，不是替换）。
 *
 * ── 用户给的口径（照抄）─────────────────────────────────────
 *
 * > "导出成 `.md`，参考脑图切成大纲模式后。**根节点是标题**。一级 / 二级 是 `##` / `###`，
 * >  **三级及更深就是正文 + 缩进就好了**。如果节点上除了标题还有内容，**内容都变成代码块**。"
 *
 * ⇒ 一份文档长这样：
 *
 * ```md
 * # 根节点（标题）
 *
 * ## 一级节点
 * ```
 * 一级节点的内容
 * ```
 * ### 二级节点
 *   三级节点（正文，按层级缩进）
 *     四级节点（再深一层就再多缩两格）
 * ```
 *
 * ★ **根节点占 `#`（标题那一行）**，节点那一侧只写两级标题（{@link NODE_HEADING_LEVELS}）——
 *   三级及更深一律当正文，层级靠缩进表达。
 * ★ **内容一律代码块**（用户的规矩）：节点正文本来就是 Markdown，套进围栏里既不会被
 *   当成文档结构，也不会与标题层级打架。
 * ★ **折叠的子树照样导出**（与 `toMarkdown.ts` 同一条纪律）：`collapsed` 是"这一刻怎么看"，
 *   不是"这份内容是什么"—— 导出漏掉用户写过的东西是最难被原谅的一种丢数据。
 * ★ **悬浮节点**不属于这棵树（大纲视图里也不出现），但绝不能丢 ⇒ 收在末尾一节里。
 * ★ 纯函数：不 import `obsidian`、不碰 DOM，可直接单测。
 */

import type { MindFile, MindNode, MindRef } from '../model/schema';

/**
 * 根节点用第几级标题（`1` = `#`）。
 *
 * ★ 于是"离根一层"的那一级是 `##`、再下一级 `###` —— 也就是用户说的
 *   "一级 / 二级 / 三级"在这份导出里各自低一格（根把第一格占了）。
 * ★ 想换成"正文里不写标题、一级节点就用 `#`"：把这个数改成 `0` ——
 *   根那一行会被跳过，一级节点正好落在 `#`（见下面 `rootHeadingLevel >= 1` 那两句）。
 */
const ROOT_HEADING_LEVEL = 1;

/** Markdown 的标题上限（`######`） */
const MAX_HEADING_DEPTH = 6;

/**
 * 节点这一侧最多写几级标题：**两级**（用户 2026-09-17 定稿）。
 *
 * ★ 用户原话："**一级 / 二级 是 `##` / `###`，三级及更深就是正文 + 缩进就好了。**"
 *   ⇒ 标题只写到**二级节点**为止，三级及更深一律当正文（靠缩进表达层级）。
 *   ★ 不写成"一直到 Markdown 的六级上限"：那会导出 `#####` 一堆，与要的形状不同。
 */
const NODE_HEADING_LEVELS = 2;

/**
 * 标题能写到第几级：根占掉的那一格 + 节点的两级（封顶到 Markdown 的上限）。
 *
 * ★ 默认 `ROOT_HEADING_LEVEL = 1` ⇒ 这里等于 3：根 `#`、一级 `##`、二级 `###`，
 *   **三级及更深就是正文**（缩进 = 比标题多出的层数 × 2 空格）。
 */
const HEADING_LIMIT = Math.min(MAX_HEADING_DEPTH, ROOT_HEADING_LEVEL + NODE_HEADING_LEVELS);

/** 正文（四级及更深）每一层缩进几个空格 */
const BODY_INDENT = 2;

/** 代码块的围栏：内容里出现 ``` 时加长围栏，免得把内容截断 */
function fenceFor(content: string): string {
  const longest = /`{3,}/g.exec(content)?.[0].length ?? 0;
  return '`'.repeat(Math.max(3, longest + 1));
}

/** 导出成大纲式 Markdown（末尾保证一个换行） */
export function mindToOutlineMarkdown(file: MindFile): string {
  const lines: string[] = [];
  const children = childrenByParent(file);

  const root = file.nodes.find((node) => node.id === file.rootId) ?? null;
  // ★ 根节点 = 标题那一行（`# <根>`）；根自己的内容 / 附件紧跟其后（它也是"节点上的内容"）
  if (root) {
    if (ROOT_HEADING_LEVEL >= 1) {
      lines.push(
        `${'#'.repeat(Math.min(ROOT_HEADING_LEVEL, MAX_HEADING_DEPTH))} ${titleOf(root)}`,
        '',
      );
    }
    writeExtra(root, ROOT_HEADING_LEVEL, lines);
    for (const child of children.get(root.id) ?? []) writeNode(child, 1, lines, children);
  }

  const floating = file.nodes.filter((node) => node.parentId === null && node.id !== file.rootId);
  if (floating.length > 0) {
    lines.push(`${'#'.repeat(Math.min(ROOT_HEADING_LEVEL, MAX_HEADING_DEPTH))} 悬浮节点`, '');
    for (const node of floating) writeNode(node, 1, lines, children);
  }

  return `${lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()}\n`;
}

/** 一个节点（含子树）→ 行 */
function writeNode(
  node: MindNode,
  depth: number,
  lines: string[],
  children: ReadonlyMap<string, MindNode[]>,
): void {
  // `depth` 是"离根几层"（一级 = 1）⇒ 标题级别 = depth + 根占掉的那一格
  const level = depth + ROOT_HEADING_LEVEL;
  const indent = bodyIndentOf(level);

  if (hasHeading(level)) {
    lines.push(`${indent}${'#'.repeat(level)} ${titleOf(node)}`, '');
  } else {
    // 标题用完了（或 `ROOT_HEADING_LEVEL = 0` 这一档）：往下都是正文（缩进表达层级）
    lines.push(`${indent}${titleOf(node)}`, '');
  }

  writeExtra(node, level, lines);

  for (const child of children.get(node.id) ?? []) writeNode(child, depth + 1, lines, children);
}

/** 节点上的"额外内容"：正文 ⇒ 代码块；附件 ⇒ 链接（与 `toMarkdown.ts` 同一个口径） */
function writeExtra(node: MindNode, level: number, lines: string[]): void {
  const indent = bodyIndentOf(level);
  const note = node.note.trim();
  if (note.length > 0) {
    const fence = fenceFor(note);
    lines.push(`${indent}${fence}`);
    for (const line of note.split('\n')) lines.push(`${indent}${line}`);
    lines.push(`${indent}${fence}`, '');
  }

  const refs = node.refs ?? [];
  if (refs.length > 0) {
    for (const ref of refs) lines.push(`${indent}${refLine(ref)}`);
    lines.push('');
  }
}

/**
 * 正文/代码块的缩进：`level` 是这一行的标题级别。
 *
 * ★ 标题那一档不缩进（标题自带层级）；**超过标题上限之后**（`level > 6`）按超出的层数缩进 ——
 *   与 `toMarkdown.ts` 的"六级之外退化成缩进"是同一条思路。
 */
function bodyIndentOf(level: number): string {
  if (level <= HEADING_LIMIT) return '';
  return ' '.repeat((level - HEADING_LIMIT) * BODY_INDENT);
}

/** 这一行写不写标题（`level >= 1` 才有标题可写；`ROOT_HEADING_LEVEL = 0` 时根那一行没有级别） */
function hasHeading(level: number): boolean {
  return level >= 1 && level <= HEADING_LIMIT;
}

/** 节点标题；空标题给一句占位（否则那一行只剩一个 `#`） */
function titleOf(node: MindNode): string {
  return node.text.trim().length > 0 ? node.text : '（无标题）';
}

/**
 * 附件 → 链接。
 *
 * ★ 图片用 `![[…]]`（嵌入）、其余用 `[[…]]`：与用户在 Obsidian 里的直觉一致 ——
 *   一张图导出来该是能看见的图，而不是一个文件名。
 */
function refLine(ref: MindRef): string {
  return ref.kind === 'image' ? `![[${ref.path}]]` : `[[${ref.path}]]`;
}

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
