/**
 * 节点尺寸的**估算**（`06 §5`）。
 *
 * 布局器要的是"每个节点占多大"，而这个尺寸最终由 CSS 说了算（标题一行、内容块几行、
 * 附件 chip 一行）。于是分两档：
 *
 * * **渲染层量到的真尺寸**（`offsetWidth` / `offsetHeight`）：能挂上 DOM 时优先用它 ——
 *   与白板的"自动高度"同一条思路（量出来再写回布局，而不是在 TS 里抄一份 CSS 常量）；
 * * **这里这套估算**：拿不到 DOM 的场合（单测、首次布局、导出时先排一遍）用它。
 *   估算的目标不是"精确"，而是**别让列宽跳来跳去** —— 它只要跟真尺寸同量级，
 *   布局出来的骨架就是对的，量完之后重排一次即可。
 *
 * ★ 纯函数：不 import `obsidian`、不碰 DOM。字号 / 行高都从参数进来（渲染层传真实值）。
 */

import type { Size } from '../../util/geometry';
import {
  MIND_IMAGE_DEFAULT_WIDTH,
  MIND_IMAGE_MAX_WIDTH,
  MIND_IMAGE_MIN_WIDTH,
  firstRefOf,
} from '../model/refs';
import { titleSizeOf } from '../model/palette';
import type { MindNode } from '../model/schema';

/** 节点内边距（px）：与 `styles.css` 里 `.nestboard-mind-node` 的 padding 对齐 */
export const MIND_NODE_PADDING_X = 14;
export const MIND_NODE_PADDING_Y = 8;
/** 标题字号基线（px）：真实值走 CSS 变量，这里只是估算基线 */
export const MIND_TITLE_FONT_SIZE = 14;
/** 标题行高 */
export const MIND_TITLE_LINE_HEIGHT = 20;
/** 内容块的行高 */
export const MIND_BODY_LINE_HEIGHT = 18;
/** 标题带末尾那个回形针要占的宽度（估算里给它留出来，免得量完后标题挤掉一个字） */
export const MIND_CLIP_ALLOWANCE = 20;
/**
 * 图片加载完成**之前**按什么比例估高度（高 = 宽 × 这个值）。
 *
 * ★ 只是为了让第一帧不至于"一条细缝"：图一加载完视图就会重排（`onImageLoad`），
 *   到时候用真实的长宽比。
 */
export const MIND_IMAGE_ASPECT_FALLBACK = 0.75;
/** 内容块与标题之间的间距 */
export const MIND_NODE_INNER_GAP = 6;

/**
 * 一个字符平均占字号的多少。
 *
 * ★ 取 0.62 而不是 0.5：中日韩字符是**满格**（1.0），而脑图里中文标题是常态；
 *   低估会让估算宽度明显偏窄，量完之后每一列都要重排。宁可略宽一点
 *   （列宽多出来的是空白，不是错误）。
 */
export const MIND_CHAR_WIDTH_RATIO = 0.62;

/**
 * 一行标题最多放几个**显示单位**（1 个英文半角字符 = 1，1 个中日韩全角字符 = 2）。
 *
 * ★ 用户 2026-09-21 定的规则："节点标题长度为一行 **29 个英文字符**，如果超出则在节点内自动换行"。
 *   于是 29 就是"一行"的宽度基准，超出部分走**节点内换行**（不再是省略号截断）。
 */
export const MIND_TITLE_MAX_UNITS = 29;
/** 标题的宽度上下限（px）：太短没手感；上限正好是"一行 29 个英文单位"那么宽（随字号缩放由调用方负责） */
export const MIND_TITLE_MIN_WIDTH = 48;
export const MIND_TITLE_MAX_WIDTH = Math.round(
  MIND_TITLE_MAX_UNITS * MIND_TITLE_FONT_SIZE * MIND_CHAR_WIDTH_RATIO,
);
/** 内容块的宽度上限 */
export const MIND_BODY_MAX_WIDTH = 280;

/**
 * 一行 29 个英文单位换算成像素（按字号）。
 *
 * ★ 布局的估算用这个数，样式表读的也是这个数（`render.ts` 把它写成
 *   `--nestboard-mind-title-max-width`）—— 两处各算一份的话，"什么时候换行"会在
 *   "布局以为的"与"浏览器实际换的"之间漂，量完之后节点高度就会跳一下。
 */
export function titleMaxWidthFor(fontSize: number): number {
  return Math.round(MIND_TITLE_MAX_UNITS * Math.max(1, fontSize * MIND_CHAR_WIDTH_RATIO));
}

/**
 * 标题的**行高**（px，按字号）。
 *
 * ★ 与样式表 `.nestboard-mind-node-title { line-height: 1.35 }` 是同一个数：
 *   估出来的盒子高度 = `行数 × 行高 + 上下内边距`，而这个高度直接决定
 *   "标题带画多高 / 内容块从哪儿开始"。两处各写一份的话，导出图里的标题带
 *   会比画布上矮一截（`2.2.0` 批 4 的 PNG 就是这样，见 `11 §15.6`）。
 */
export function titleLineHeightFor(fontSize: number): number {
  return Math.round(fontSize * MIND_TITLE_LINE_HEIGHT_RATIO);
}

/** 标题行高相对字号的倍数（与样式表那条 `line-height: 1.35` 对齐） */
export const MIND_TITLE_LINE_HEIGHT_RATIO = 1.35;

/**
 * 标题按"一行 {@link MIND_TITLE_MAX_UNITS} 个显示单位"折行后的**每一行文字**。
 *
 * ★ 估算（{@link estimateNodeSize} 的行数）与**导出时真正画出来的行**必须是同一份结果：
 *   否则"盒子按 3 行留了高度、画出来只有 1 行" —— 看上去就是标题悬在盒子上半截里。
 * ★ 贪心按**显示宽度**装箱（中日韩字算 2 个单位）：与浏览器按像素折行的结果最接近，
 *   而且互相自洽（估出来的高度装得下画出来的行数）。
 */
export function wrapNodeTitle(text: string, unitsPerLine = MIND_TITLE_MAX_UNITS): string[] {
  // ★ 标题里的换行**当空格**（标题那一段 CSS 是 `white-space: normal`，浏览器就是这么做的）：
  //   按 `\n` 断成多行的话，"粘贴进来的一段多行文字"会在导出里画成好几行，
  //   而画布上只有一行 —— 而且盒子高度是按**一行**估的，多出来的行会溢出节点外。
  return greedyWrap(collapseWhitespace(text), unitsPerLine);
}

/**
 * 内容块（备注）按"一行 `unitsPerLine` 个显示单位"折行后的每一行。
 *
 * ★ 与 {@link wrapNodeTitle} 同一套装箱规则，只有一处不同：备注里的 `\n` 是**硬换行**
 *   （它是一段 Markdown 正文），而行数在估算里是**各段相加**（`wrapNodeNote` 的结果长度）。
 * ★ 同样只此一处实现：估算的行数与导出画出来的行必须一致，否则"盒子按 3 行留了高度、
 *   画出来只有 1 行"（或者反过来溢出）就会以各种样子冒出来。
 */
export function wrapNodeNote(note: string, unitsPerLine: number): string[] {
  const out: string[] = [];
  for (const paragraph of note.split('\n')) {
    const text = collapseWhitespace(paragraph);
    if (text.length === 0) {
      out.push('');
      continue;
    }
    out.push(...greedyWrap(text, unitsPerLine));
  }
  return out.length > 0 ? out : [''];
}

/** 折掉换行与连续空白（与样式表 `white-space: normal` 下的表现对齐） */
function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * 贪心装箱：一行装满 `unitsPerLine` 个显示单位就换行。
 *
 * ★ 中日韩字按 2 个单位（与 {@link displayWidthOf} 同一把尺子）——"一行 29 个英文单位"
 *   是用户定的基准，而一个汉字本来就占两个英文位。
 */
function greedyWrap(text: string, unitsPerLine: number): string[] {
  const limit = Math.max(1, unitsPerLine);
  const out: string[] = [];
  let line = '';
  let units = 0;
  for (const char of text) {
    const width = isWideChar(char) ? 2 : 1;
    if (units > 0 && units + width > limit) {
      out.push(line);
      line = '';
      units = 0;
    }
    line += char;
    units += width;
  }
  out.push(line);
  // 空文字也给一行 —— 调用方（导出）不必再判"有没有行"
  return out;
}

export interface MeasureOptions {
  paddingX?: number;
  paddingY?: number;
  fontSize?: number;
  titleLineHeight?: number;
  bodyLineHeight?: number;
  charWidthRatio?: number;
  titleMaxWidth?: number;
  bodyMaxWidth?: number;
}

/**
 * 估算一个节点的尺寸。
 *
 * 三块加起来：**标题一行** + **内容块**（`note` 非空时）+ **chip 行**（`refs` 非空时）。
 * 属性（`props`）不占面积 —— 它在卡角当一个角标（`§6.3`），算进尺寸会让"加了属性就换行"。
 */
export function estimateNodeSize(node: MindNode, options: MeasureOptions = {}): Size {
  const paddingX = options.paddingX ?? MIND_NODE_PADDING_X;
  const paddingY = options.paddingY ?? MIND_NODE_PADDING_Y;
  const fontSize = options.fontSize ?? MIND_TITLE_FONT_SIZE;
  const titleLineHeight = options.titleLineHeight ?? MIND_TITLE_LINE_HEIGHT;
  const bodyLineHeight = options.bodyLineHeight ?? MIND_BODY_LINE_HEIGHT;
  const ratio = options.charWidthRatio ?? MIND_CHAR_WIDTH_RATIO;
  const titleMax = options.titleMaxWidth ?? MIND_TITLE_MAX_WIDTH;
  const bodyMax = options.bodyMaxWidth ?? MIND_BODY_MAX_WIDTH;
  const charWidth = Math.max(1, fontSize * ratio);

  // 标题：一行最多 `MIND_TITLE_MAX_UNITS` 个显示单位，**超出就在节点内换行**
  // （用户 2026-09-21；从前是一行 + 省略号截断）
  // ★ 行数**直接问折行器**（`wrapNodeTitle`）：估算与导出画出来的是同一份结果 ——
  //   从前这里按 `ceil(总宽/一行宽)` 算，而画的时候按贪心装箱，两者在
  //   "一段多行标题"上能差出好几行（画出来的行溢出到节点外面）。
  const titleLines = wrapNodeTitle(node.text, MIND_TITLE_MAX_UNITS);
  // ★ 宽度按**整段文字**算，不是"最长的那一行"：样式表那边 `width: max-content` 被
  //   `max-width` 截住 ⇒ 哪怕第一行只装得下 14 个汉字，盒子仍然是"29 个英文单位"那么宽。
  //   按行长算的话，盒子会比画布上窄一档（而且同层等宽会跟着一起缩）。
  const titleUnits = displayWidthOf(collapseWhitespace(node.text));
  const titleWidth = clamp(
    Math.min(titleUnits, MIND_TITLE_MAX_UNITS) * charWidth,
    MIND_TITLE_MIN_WIDTH,
    titleMax,
  );
  let width = titleWidth;
  let height = paddingY * 2 + titleLines.length * titleLineHeight;

  // 内容块：按可用行宽折行估行数（**行数同样问折行器**）
  const note = node.note.trim();
  if (note.length > 0) {
    const bodyWidth = clamp(textWidth(note, charWidth), MIND_TITLE_MIN_WIDTH, bodyMax);
    width = Math.max(width, bodyWidth);
    const noteLines = wrapNodeNote(note, Math.max(1, Math.floor(bodyWidth / charWidth)));
    // ★ 末尾那个 `MIND_NODE_PADDING_Y` 是**内容块自己的下内边距**
    //   （`.nestboard-mind-node-body { padding: 6px 14px 8px }` 的 8px）——
    //   漏掉它，导出里的带备注节点会比画布上矮 8px（内容贴到节点底边上）
    height += MIND_NODE_INNER_GAP + noteLines.length * bodyLineHeight + MIND_NODE_PADDING_Y;
  }

  // 附件（`06 §4.1`）：图片附件在最上面占一块；其余附件**不占面积** ——
  // 它们只是标题带末尾的一个回形针（只把标题挤宽一点）
  const ref = firstRefOf(node);
  if (ref?.kind === 'image') {
    const imageWidth = clamp(
      ref.width ?? MIND_IMAGE_DEFAULT_WIDTH,
      MIND_IMAGE_MIN_WIDTH,
      MIND_IMAGE_MAX_WIDTH,
    );
    width = Math.max(width + MIND_CLIP_ALLOWANCE, imageWidth);
    height = imageWidth * MIND_IMAGE_ASPECT_FALLBACK + titleLineHeight + paddingY * 2;
  } else if (ref) {
    width += MIND_CLIP_ALLOWANCE;
  }

  return { width: Math.round(width + paddingX * 2), height: Math.round(height) };
}

/**
 * 按**层级**估算一个节点的尺寸（根 30 / 一层 18 / 二层及以下 14）。
 *
 * ── 为什么必须有这一个函数（`2.2.0` 批 4 的一处观感 bug）────────────
 *
 * `estimateNodeSize` 的默认字号是 **14**（那是"普通节点"的档），而样式表里的标题字号
 * 由**层级**决定（`render.ts` 写成 `--nestboard-mind-title-size`）。于是"拿不到 DOM"
 * 的那些场合 —— 缩略图、PNG / SVG / PDF 导出、连线端点的几何 —— 全都把这棵树当成了
 * **清一色 14px**：中心主题在导出图里比画布上小一大圈，而画上去的字又是 30px
 * （`titleSizeOf` 那一侧是对的）⇒ 字顶出盒子、节点大小与图上完全不同。
 * 用户报的"导出 PNG 和原脑图差很多"就是这一处。
 *
 * ★ 字号 / 行高 / 折行上限三样都从 `palette.ts` 与 {@link titleMaxWidthFor} 来 ——
 *   与 `applyNodePalette` 写成 CSS 变量的**是同一份数**，两边不会漂。
 * ★ 用量到真尺寸的场合（画布）**不要**走它：那边 `EmbedMind` 的第二遍布局用的是
 *   `offsetWidth/offsetHeight`，比任何估算都准。
 */
export function estimateNodeSizeByDepth(node: MindNode, depth: number): Size {
  const size = titleSizeOf(depth);
  return estimateNodeSize(node, {
    fontSize: size,
    titleLineHeight: titleLineHeightFor(size),
    titleMaxWidth: titleMaxWidthFor(size),
  });
}

/**
 * 一段文字的**显示宽度**（单位：英文半角字符数）。
 *
 * ★ 中日韩与全角字符按 **2** 算：用户定的基准是"29 个**英文**字符"，而一个汉字本来就占两个
 *   英文的位。不折算的话，一行 29 个汉字会被判成 29 个单位，实际宽度翻倍 —— 换行位置全错。
 * ★ 纯函数、不碰 DOM（量不到真实字体宽度时的估算口径）。
 */
export function displayWidthOf(text: string): number {
  let width = 0;
  for (const char of text) width += isWideChar(char) ? 2 : 1;
  return width;
}

/** 是不是"占两个英文位"的字符（中日韩 / 全角标点 / 全角字母数字） */
function isWideChar(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return (
    (code >= 0x1100 && code <= 0x115f) || // 谚文字母
    (code >= 0x2e80 && code <= 0xa4cf) || // 中日韩部首 / 假名 / 汉字
    (code >= 0xac00 && code <= 0xd7a3) || // 谚文音节
    (code >= 0xf900 && code <= 0xfaff) || // 兼容汉字
    (code >= 0xfe30 && code <= 0xfe6f) || // 全角标点
    (code >= 0xff00 && code <= 0xff60) || // 全角字母数字
    (code >= 0xffe0 && code <= 0xffe6)
  );
}

function textWidth(text: string, charWidth: number): number {
  return Math.max(0, ...text.split('\n').map((line) => displayWidthOf(line))) * charWidth;
}

/** 折行后的行数：按**显示宽度**估算（中日韩与 ASCII 混排时这是最接近的一档） */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
