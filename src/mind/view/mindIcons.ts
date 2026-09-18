/**
 * 画布调节那两处按钮的**图标**（`08 §1`）：结构一档一张、分支线一种一张。
 *
 * ★ 形状数据在 `mindIconShapes.ts`（**由脚本从用户给的 SVG 生成**，别手改）；
 *   这里只干两件事：把"档位 → 图标"写清楚、把数据变成 DOM。
 * ★ 建 DOM 走 `createElementNS` 逐个形状建（不是塞一段标记串）：`innerHTML` 那一套
 *   假 DOM 下没有、在真 DOM 里也不是好习惯（这里的形状是数据，凭什么要经过字符串）。
 * ★ 颜色一律 `currentColor`：按钮的字色就是主题的正文色 ⇒ 深色主题里它自己就变白。
 */

import { MIND_ICON_SHAPES, type MindIconShape } from './mindIconShapes';
import type { MindEdgeStyle, MindStructure } from '../model/schema';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** 图标上的属性：**值是图标名**（认人用，见 `buildMindIcon`） */
export const MIND_ICON_ATTR = 'data-mind-icon';

/** 生成物里的九个名字（结构五 + 分支线四） */
export type MindIconName = keyof typeof MIND_ICON_SHAPES;

/** 结构 → 图标（五档都有） */
export const MIND_STRUCTURE_ICONS: Readonly<Record<MindStructure, MindIconName>> = {
  'logic-right': 'logicRight',
  'logic-left': 'logicLeft',
  octopus: 'octopus',
  'org-down': 'orgDown',
};

/** 分支线 → 图标（四档都有） */
export const MIND_EDGE_ICONS: Readonly<Record<MindEdgeStyle, MindIconName>> = {
  curve: 'curve',
  line: 'line',
  elbow: 'elbow',
  rounded: 'rounded',
};

/**
 * 建一个图标。
 *
 * ★ 盒子取**正方形**（`size × size`），靠 `preserveAspectRatio` 的默认值 `xMidYMid meet`
 *   把内容居中装进去 —— 八张图的长宽比各不相同（0.82–0.96），各按比例给宽高的话，
 *   同一排按钮里的图标会看起来**忽大忽小**。
 */
export function buildMindIcon(doc: Document, name: MindIconName, size: number): SVGElement {
  const data = MIND_ICON_SHAPES[name];

  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', data.viewBox);
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  // ★ 带上名字：单看那几个 `viewBox` 认不出是哪一张（"向右"与"向下"的数字一模一样），
  //   而调试与单测都要能问一句"现在这张是哪个图标"
  svg.setAttribute(MIND_ICON_ATTR, name);
  // 图标是装饰，语义由外面那个按钮的 `aria-label` 负责
  svg.setAttribute('aria-hidden', 'true');
  for (const shape of data.shapes) appendShape(doc, svg, shape);
  return svg;
}

function appendShape(doc: Document, parent: SVGElement, shape: MindIconShape): void {
  const el = doc.createElementNS(SVG_NS, shape.tag);
  for (const [key, value] of Object.entries(shape.attrs)) el.setAttribute(key, value);
  for (const child of shape.children ?? []) appendShape(doc, el, child);
  parent.appendChild(el);
}
