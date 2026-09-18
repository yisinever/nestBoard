/**
 * 脑图 → FreeMind（`.mm`，`06 §11.51`：差距清单第 5 件）。
 *
 * ── 为什么值得单开一个导出器 ─────────────────────────────
 *
 * `.mm` 是一份**朴素的 XML**，FreeMind / Freeplane / 幕布 / 大多数思维导图软件都能读 ——
 * 于是"我们这边画好的树，别人那边能打开、还能接着编辑"这条路是通的。
 * 与 Markdown 那条的分工：Markdown 保住的是**内容**（读），`.mm` 保住的是
 * **树 + 一部分样子**（读回来还能编辑：折叠、主色、关联线箭头都在）。
 *
 * ── 映射表（每一档都写清楚，免得被当成 bug）────────────────
 *
 * | 我们的东西 | `.mm` 里的落点 |
 * | --- | --- |
 * | 父子结构 | 嵌套 `<node>`；**根的直接孩子**带 `POSITION="right/left"`（FreeMind 的规矩） |
 * | `text` | `TEXT`（转义） |
 * | `note` | `<richcontent TYPE="NOTE">` 里一段一段 `<p>` |
 * | `collapsed` | `FOLDED="true"` |
 * | `done` | `TEXT` 前面加 `✔ ` —— FreeMind 没有"完成"这个字段 |
 * | `icon`（emoji） | `TEXT` 前面加那个 emoji —— 它的内置图标是**固定名字**，塞不进任意表情 |
 * | `style.color` / `override` | `BACKGROUND_COLOR` + `COLOR`（**只在用户设过颜色时才写**） |
 * | 关联线 `links` | `<arrowlink DESTINATION=… STARTARROW/ENDARROW>`（箭头三态照搬） |
 * | 悬浮节点 | 挂在**根下最后**（FreeMind 没有"游离节点"这个东西 —— 宁可结构上近似，也不能丢内容） |
 * | 附件 `refs` | **不导出**：`LINK` 在那边是 **URL 语义**，把库内路径塞进去只会得到一个打不开的链接 |
 * | 标题加粗 / 斜体 / 下划线 | **不导出**：FreeMind 把它们放在 richcontent 的 `<font>` 里，
 *   为它把每个节点文字都改成富文本形态不划算（要粗体就回导图里看） |
 *
 * ★ 纯函数：不 import `obsidian`、不碰 DOM，可直接单测（与另外两个导出器同一条）。
 * ★ 颜色在**没有主题注入**时用近似表（与 `toSvg` 同一个取舍）：导出物要能被别人打开，
 *   不能依赖"打开者主题里那个色"。
 */

import { mindPaletteOf } from '../model/palette';
import type { MindFile, MindLink, MindNode } from '../model/schema';

/** FreeMind 认的那个版本号（写死在文件头，各家导出器都这么干） */
const MM_VERSION = '1.0.1';

/** 每层缩进几个空格（纯为可读：这份文件是要被人打开看的） */
const INDENT = '  ';

export interface FreeMindOptions {
  /**
   * 根的直接孩子摆在**哪一侧**（`'left' | 'right'`；不给就按 `order` 左右交替）。
   *
   * ★ 由调用方从**当前布局**取（`layout.boxes.get(id).side`）—— 于是导出的 `.mm`
   *   打开之后左右分布与画布上看到的一致，而不是"另一半猜出来的"。
   */
  positionOf?: (nodeId: string) => 'left' | 'right' | null;
}

/**
 * 导出成 `.mm` 文本（末尾保证有换行）。
 *
 * ★ 折叠**照实导出**（`FOLDED="true"`）：`.mm` 的用途是"把整张图交给别人接着编辑"，
 *   折叠在那边是一个**可编辑的状态** —— 与 Markdown 那条"折叠也照样导出内容"不矛盾：
 *   那边折叠会让内容消失，这边只是收起来（点一下就展开）。
 */
export function mindToFreeMind(file: MindFile, options: FreeMindOptions = {}): string {
  const byId = new Map(file.nodes.map((node) => [node.id, node]));
  const children = new Map<string, MindNode[]>();
  for (const node of file.nodes) {
    if (node.parentId === null) continue;
    const bucket = children.get(node.parentId);
    if (bucket) bucket.push(node);
    else children.set(node.parentId, [node]);
  }
  // 次序兜底：坏数据不该让导出的顺序乱跳（与 `toMarkdown` 同一条）
  for (const bucket of children.values()) {
    bucket.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  }

  const links = linksBySource(file);
  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(`<map version="${MM_VERSION}">`);

  const root = byId.get(file.rootId);
  if (root) {
    writeNode(root, 1, lines, children, links, options, file.rootId);
  }

  // 悬浮节点：FreeMind 没有"游离节点"，挂在根下（不然它们就丢了 —— 那是用户写下的内容）
  const free = file.nodes.filter((node) => node.parentId === null && node.id !== file.rootId);
  for (const node of free) writeNode(node, 1, lines, children, links, options, file.rootId);

  lines.push('</map>');
  return `${lines.join('\n')}\n`;
}

/** 出边：`from` → 它的那些关联线（写节点时顺带写 `<arrowlink>`） */
function linksBySource(file: MindFile): Map<string, MindLink[]> {
  const index = new Map<string, MindLink[]>();
  for (const link of file.links ?? []) {
    const bucket = index.get(link.from);
    if (bucket) bucket.push(link);
    else index.set(link.from, [link]);
  }
  return index;
}

/** 写一个节点（递归） */
function writeNode(
  node: MindNode,
  level: number,
  lines: string[],
  children: ReadonlyMap<string, MindNode[]>,
  links: ReadonlyMap<string, MindLink[]>,
  options: FreeMindOptions,
  rootId: string,
): void {
  const pad = INDENT.repeat(level);
  const kids: string[] = [];
  for (const child of children.get(node.id) ?? []) {
    writeNode(child, level + 1, kids, children, links, options, rootId);
  }

  const attributes: string[] = [`TEXT="${escapeXml(textOf(node))}"`, `ID="${escapeXml(node.id)}"`];
  // ★ `POSITION` 只给**根的直接孩子**：FreeMind 用它在左右两侧摆第一层，更深层的跟着父走。
  //   每一层都写一遍没有意义（还会让文件翻倍），而第一层不写的话打开就全挤在右边
  if (node.parentId === rootId) {
    const side = options.positionOf?.(node.id) ?? (node.order % 2 === 0 ? 'right' : 'left');
    attributes.push(`POSITION="${side}"`);
  }
  if (node.collapsed === true) attributes.push('FOLDED="true"');

  // 颜色：**只在用户设过时才写**。没设过的节点交给 FreeMind 的默认观感 ——
  // 把我们按层级推出来的"白底 / 淡粉底"也写进去，只会让文件里全是噪声
  if (node.style?.color !== undefined || node.style?.override !== undefined) {
    const palette = mindPaletteOf(node.style, { depth: Math.max(0, level - 1) });
    attributes.push(`BACKGROUND_COLOR="${escapeXml(palette.title)}"`);
    attributes.push(`COLOR="${escapeXml(palette.titleInk)}"`);
  }

  const body = [
    noteXml(node.note, level + 1),
    ...(links.get(node.id) ?? []).map((link) => arrowXml(link, level + 1)),
    ...kids,
  ].filter((part) => part.length > 0);

  if (body.length === 0) {
    lines.push(`${pad}<node ${attributes.join(' ')}/>`);
    return;
  }
  lines.push(`${pad}<node ${attributes.join(' ')}>`);
  lines.push(...body);
  lines.push(`${pad}</node>`);
}

/** 节点在 `.mm` 里的文字：完成打勾、标记 emoji 都并进 `TEXT`（那边没有对应字段） */
function textOf(node: MindNode): string {
  const mark = node.icon !== undefined && node.icon.length > 0 ? `${node.icon} ` : '';
  const done = node.done === true ? '✔ ' : '';
  return `${done}${mark}${node.text}`;
}

/** 正文 → `<richcontent TYPE="NOTE">`（一行一个 `<p>`；空正文给空串） */
function noteXml(note: string, level: number): string {
  const text = note.trim();
  if (text.length === 0) return '';

  const pad = INDENT.repeat(level);
  const paragraphs = text.split(/\r?\n/).map((line) => `${pad}${INDENT}<p>${escapeXml(line)}</p>`);
  return [
    `${pad}<richcontent TYPE="NOTE">`,
    `${pad}${INDENT}<html>`,
    `${pad}${INDENT}${INDENT}<body>`,
    ...paragraphs,
    `${pad}${INDENT}${INDENT}</body>`,
    `${pad}${INDENT}</html>`,
    `${pad}</richcontent>`,
  ].join('\n');
}

/**
 * 关联线 → `<arrowlink>`。
 *
 * ★ 箭头三态照搬：`end` / `both` / 没有。FreeMind 的默认是**带箭头**，
 *   所以"我们这边没画箭头"必须显式写 `None` —— 不然对方打开会平白多出一个箭头。
 * ★ 标签在 `.mm` 里**没有落点**（`arrowlink` 没有标签字段，`MIDDLE_LABEL` 各家不认）：
 *   这一档刻意不导出，映射表里已注明。
 */
function arrowXml(link: MindLink, level: number): string {
  const pad = INDENT.repeat(level);
  const ends =
    link.arrow === 'both'
      ? 'STARTARROW="Default" ENDARROW="Default"'
      : link.arrow === 'end'
        ? 'STARTARROW="None" ENDARROW="Default"'
        : 'STARTARROW="None" ENDARROW="None"';
  return `${pad}<arrowlink DESTINATION="${escapeXml(link.to)}" ${ends}/>`;
}

/** XML 转义（和号先转，免得把后面刚生成的实体又转一遍） */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
