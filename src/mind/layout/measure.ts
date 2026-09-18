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

/** 标题的宽度上下限（px）：太短没手感、太长会变成一条横贯屏幕的带子 */
export const MIND_TITLE_MIN_WIDTH = 48;
export const MIND_TITLE_MAX_WIDTH = 240;
/** 内容块的宽度上限 */
export const MIND_BODY_MAX_WIDTH = 280;

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

  // 标题：一行（不换行 —— 一行是"标题"这个概念的边界，换行的标题在脑图里会毁掉骨架）
  const titleWidth = clamp(textWidth(node.text, charWidth, 1), MIND_TITLE_MIN_WIDTH, titleMax);
  let width = titleWidth;
  let height = paddingY * 2 + titleLineHeight;

  // 内容块：按可用行宽折行估行数
  const note = node.note.trim();
  if (note.length > 0) {
    const bodyWidth = clamp(textWidth(note, charWidth, 1), MIND_TITLE_MIN_WIDTH, bodyMax);
    width = Math.max(width, bodyWidth);
    const lines = wrappedLines(note, Math.max(1, Math.floor(bodyWidth / charWidth)));
    height += MIND_NODE_INNER_GAP + lines * bodyLineHeight;
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

function textWidth(text: string, charWidth: number, lines: number): number {
  return Math.max(...text.split('\n').map((line) => line.length), 0) * charWidth * lines;
}

/** 折行后的行数：按字符数估算（中日韩与 ASCII 混排时这只是近似，但同量级够了） */
function wrappedLines(text: string, charsPerLine: number): number {
  return text
    .split('\n')
    .reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / charsPerLine)), 0);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
