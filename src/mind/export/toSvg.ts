/**
 * 脑图 → SVG（`06 §7.3`：树 → SVG / PNG 渲染器里的 SVG 那一半）。
 *
 * ── 为什么是"自己画"而不是截屏 ─────────────────────────────
 *
 * 与白板的 PNG 导出（`export/toPng.ts`）同一条理由：DOM 截图只能按当前屏幕像素拍，
 * 而导出物应当能在**任意倍率**下重画。这里的几何全部来自 `mind/layout` ——
 * **与屏幕上摆节点用的是同一份布局**，所以导出结果与画布长得一样。
 *
 * ── 与屏幕的两处刻意的差别 ──────────────────────────────────
 *
 * 1. **颜色取自 `palette.ts` 的像素值**，不读 CSS 变量：SVG 要能脱离 Obsidian
 *    打开（发给别人、插进网页），跟着主题走反而会得到"一个文档里两种主题"。
 * 2. **图片附件画成占位块**（写文件名）：把库内图片嵌进 SVG 要么带绝对路径
 *    （换台机器就断）要么内嵌 base64（一份导出突然大出几 MB）—— 两条都不该替用户决定。
 *
 * ★ 纯函数：给字符串，不碰 DOM ⇒ 能在 node 下单测（"每个节点一个矩形"这类规则
 *   最容易被一次重构悄悄改坏）。
 */

import { MIND_CHAR_WIDTH_RATIO } from '../layout/measure';
import type { MindLayout, NodeBox } from '../layout/tree';
import { firstRefOf, refLabelOf } from '../model/refs';
import { mainHexOf, mindPaletteOf, titleBoldOf, titleSizeOf } from '../model/palette';
import type { MindEdgeStyle, MindFile, MindNode } from '../model/schema';
import { edgePathOf, edgeTrunkPathOf } from '../layout/edges';
import { linkArrowEnds, linkArrowPoints, linkMidpointOf, linkPathOf } from '../layout/links';

/** 内容四周留白（世界坐标 px） */
export const MIND_SVG_PADDING = 40;
/** 内容块的行高（与 `styles.css` 的 `line-height: 1.4` 对齐） */
const BODY_LINE_HEIGHT = 1.4;
/** 连线的颜色与粗细（固定的中性灰，见文件头第 1 条） */
const EDGE_STROKE = '#b8b8bd';
const EDGE_WIDTH = 2;
/** 节点内边距（与 `styles.css` 的 `padding: 8px 14px` 对齐） */
const PADDING_X = 14;

/**
 * 节点的**发丝边框**（用户 2026-09-16："导出时都给节点加边框，避免穿帮"）。
 *
 * ★ 屏幕上有阴影、导出时没有 ⇒ 相邻节点（尤其同层的白底节点）会糊成一片。
 *   边框是**最稳的那一道**：不依赖渲染器对 `feDropShadow` 的支持，
 *   在 PNG 缩放、打印、别人转格式之后都还在。
 * ★ 颜色取中性灰而不是某个主题色：导出物要能脱离 Obsidian 打开（见文件头第 1 条）。
 */
const NODE_STROKE = '#d6d6dc';
/** 阴影滤镜的 id（`<defs>` 里那一个） */
const SHADOW_ID = 'nestboard-mind-node-shadow';

/**
 * 底色矩形的 class。
 *
 * ★ 有它才谈得上"透明底色"这件事：内容块的底色**也是**纯白（`palette.ts` 的
 *   `BODY_SURFACE`），只靠颜色根本分不出哪一块是画布底色 —— 而导出透明 PNG 时
 *   那一块必须能被认出来去掉。
 */
export const MIND_SVG_BG_CLASS = 'nestboard-mind-svg-bg';

/**
 * 字体栈写死在这份 SVG 里。
 *
 * ★ 必须给整套栈而不是 `sans-serif`：中文在 Windows / macOS / Linux 上分别要落到
 *   微软雅黑 / 苹方 / 思源，只给 `sans-serif` 会得到一版莫名其妙的字形。
 */
const FONT_STACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif";

export interface SvgExportOptions {
  /** 内容四周留白，默认 {@link MIND_SVG_PADDING} */
  padding?: number;
  /** 底色；`null` = 透明 */
  background?: string | null;
  /** 线型；不给就取文件里的 `view.edge`（再不给 = 曲线） */
  edge?: MindEdgeStyle;
}

/** 脑图 → SVG 文本 */
export function mindToSvg(
  file: MindFile,
  layout: MindLayout,
  options: SvgExportOptions = {},
): string {
  const padding = options.padding ?? MIND_SVG_PADDING;
  const bounds = layout.bounds ?? { x: 0, y: 0, width: 1, height: 1 };
  const x = bounds.x - padding;
  const y = bounds.y - padding;
  const width = Math.max(1, bounds.width + padding * 2);
  const height = Math.max(1, bounds.height + padding * 2);

  const byId = new Map(file.nodes.map((node) => [node.id, node]));
  const parts: string[] = [];

  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${round(width)}" height="${round(height)}" ` +
      `viewBox="${round(x)} ${round(y)} ${round(width)} ${round(height)}" ` +
      `font-family="${escapeAttr(FONT_STACK)}">`,
    `<title>${escapeText(file.meta.title)}</title>`,
  );

  // 阴影滤镜：屏幕上的节点有"发丝边 + 两层影"，导出只留边框会显得平。
  // ★ 滤镜区域放宽到 ±30%：默认的 ±10% 会把小节点那圈影子裁掉一小条
  parts.push(
    `<defs><filter id="${SHADOW_ID}" x="-30%" y="-30%" width="160%" height="160%">` +
      `<feDropShadow dx="0" dy="2" stdDeviation="4" flood-color="#000000" flood-opacity="0.16"/>` +
      `</filter></defs>`,
  );

  if (options.background !== null) {
    parts.push(
      `<rect class="${MIND_SVG_BG_CLASS}" x="${round(x)}" y="${round(y)}" ` +
        `width="${round(width)}" height="${round(height)}" fill="${options.background ?? '#ffffff'}"/>`,
    );
  }

  // ── 连线：主干 + 每个方向一条延长线（与屏幕同一个去重规则，见 `paintEdges`）──
  // ★ 线型取**文件里那一档**（`view.edge`）：导出的线与屏幕上看到的必须是同一种，
  //   否则"我选的圆角折线，导出变曲线了"就是必然会被问到的问题
  const style = options.edge ?? file.view.edge ?? 'curve';
  const trunks = new Set<string>();
  const edges: string[] = [];
  for (const box of layout.boxes.values()) {
    const node = byId.get(box.id);
    const parent = node?.parentId ? layout.boxes.get(node.parentId) : undefined;
    if (!node?.parentId || !parent) continue;

    const direction = box.side === -1 ? -1 : 1;
    const key = `${parent.id}:${direction}`;
    if (!trunks.has(key)) {
      trunks.add(key);
      edges.push(
        `<path d="${edgeTrunkPathOf(parent, direction)}" fill="none" stroke="${EDGE_STROKE}" ` +
          `stroke-width="${EDGE_WIDTH}" stroke-linecap="round"/>`,
      );
    }
    edges.push(
      `<path d="${edgePathOf(parent, box, style)}" fill="none" stroke="${EDGE_STROKE}" ` +
        `stroke-width="${EDGE_WIDTH}" stroke-linecap="round"/>`,
    );
  }
  if (edges.length > 0) parts.push(`<g>${edges.join('')}</g>`);

  // ── 关联线（`N1-c`）──
  // ★ 与屏幕**同一份几何**（`layout/links.ts`）⇒ 导出图里的线与画布上一模一样；
  //   颜色 / 线宽也跟分支线同一支笔（用户明确"只有曲线样式"，不给单独配色）
  const links: string[] = [];
  for (const link of file.links ?? []) {
    const from = layout.boxes.get(link.from);
    const to = layout.boxes.get(link.to);
    if (!from || !to) continue;

    // ★ 颜色（`N1-e`）：挑过颜色就按主题色画（导出是**独立文件**，用不了主题的 CSS 变量，
    //   所以走 `mainHexOf` 的近值表）；没挑过仍是默认那条灰线。
    const stroke = link.color ? mainHexOf(link.color) : EDGE_STROKE;
    links.push(
      // ★ 弯折（`N1-d`）跟着走：与屏幕**同一份几何**，导出图里的线与画布上一模一样
      `<path d="${linkPathOf(from, to, link.bend)}" fill="none" stroke="${stroke}" ` +
        `stroke-width="${EDGE_WIDTH}" stroke-linecap="round" ` +
        // 用户 2026-09-16：默认虚线，`solid: true` 的才是实线（与屏幕同一套口径）
        `stroke-dasharray="${link.solid === true ? 'none' : '6 4'}"/>`,
    );
    for (const end of linkArrowEnds(link.arrow)) {
      // ★ 这里也要把 `bend` 传进去（箭头的方向取锚点处的切线）——
      //   漏了它的症状是"屏幕上线弯了、导出图里箭头还按老方向插着"
      const points = linkArrowPoints(from, to, end, undefined, link.bend)
        .map((point) => `${round(point.x)},${round(point.y)}`)
        .join(' ');
      links.push(`<polygon points="${points}" fill="${stroke}"/>`);
    }
    if (link.label !== undefined && link.label.length > 0) {
      // ★ 标签跟着**曲线中点**（`bend` 要传）：不传的话导出图里标签会飘在线外
      const mid = linkMidpointOf(from, to, link.bend);
      // ★ 描一圈底色再填字（`paint-order`）：标签压在线上，不描的话字与线糊在一起。
      //   底色取导出底色（透明时用白 —— 透明 PNG 通常贴在深色底上，白色描边最稳）
      const halo = options.background ?? '#ffffff';
      links.push(
        `<text x="${round(mid.x)}" y="${round(mid.y)}" text-anchor="middle" ` +
          `dominant-baseline="middle" font-size="12" fill="#6a6a72" stroke="${halo}" ` +
          `stroke-width="3" paint-order="stroke">${escapeText(link.label)}</text>`,
      );
    }
  }
  if (links.length > 0) parts.push(`<g>${links.join('')}</g>`);

  // ── 节点 ──
  // 完成（`N3-g`）：祖先里有完成的那些也要**画淡**（与画布一致）。
  // ★ 先算成一个集合：每次现沿父链走的话，n 个节点就是 n×深度 次查表
  const dimmed = dimmedByDoneAncestor(file, byId);
  for (const box of layout.boxes.values()) {
    const node = byId.get(box.id);
    if (node) parts.push(nodeSvg(node, box, box.free ? 1 : box.depth, dimmed.has(node.id)));
  }

  parts.push('</svg>');
  return parts.join('\n');
}

/**
 * 祖先里有完成的节点 id（`N3-g`）。
 *
 * ★ 与画布那边同一条语义：**只有"自己完成"写在那一位上**，祖先完成只是让子孙"看起来"
 *   属于那一支 —— 导出时也一样（不然导出的图与屏幕上不是一回事）。
 */
function dimmedByDoneAncestor(
  file: MindFile,
  byId: ReadonlyMap<string, MindNode>,
): ReadonlySet<string> {
  const dimmed = new Set<string>();
  for (const node of file.nodes) {
    let cursor = node.parentId === null ? null : (byId.get(node.parentId) ?? null);
    let guard = 0;
    while (cursor && guard < 512) {
      if (cursor.done === true && node.done !== true) {
        dimmed.add(node.id);
        break;
      }
      cursor = cursor.parentId === null ? null : (byId.get(cursor.parentId) ?? null);
      guard += 1;
    }
  }
  return dimmed;
}

/** 一个节点：标题带（圆角矩形 + 一行字）+ 内容块（可换行）+ 附件一行 */
function nodeSvg(node: MindNode, box: NodeBox, depth: number, doneBranch = false): string {
  const palette = mindPaletteOf(node.style, { depth });
  const radius = Math.min(8, box.height / 2);
  const titleSize = titleSizeOf(depth);
  const titleHeight = Math.round(titleSize * 1.35) + 16;
  // ★ 标题带的高度**只算这一处**：从前文字用这个公式、带子另写了一个 `min(height, 44)`，
  //   两者在矮节点上会分叉 —— 带子铺满整张卡、底下就露出**两个直角**
  //   （导出 PNG 里就是"卡片底下贴了一小块方纸"，用户报过；根节点够高所以看不出来）
  const bandHeight = Math.min(box.height, titleHeight);

  // 文字**高亮**（`N3-f`）：导出里也要有（与画布上一致），画成标题文字背后的一块矩形。
  // ★ 宽度只能**估**：SVG 里量不到字宽，于是用与布局 / 折行**同一份** `MIND_CHAR_WIDTH_RATIO`
  //   —— "节点该多宽"本来就是估的，估法一致才不会导出成另一个样子
  const highlight = node.style?.highlight ?? null;
  /** 标题文字估出来的宽度（高亮那块矩形与完成那条删除线**共用**，右端才对得齐） */
  const textWidth = node.text.length * titleSize * MIND_CHAR_WIDTH_RATIO;

  // 完成（`N3-g`）：自己完成 = 整块略淡 + 标题一条删除线；祖先完成 = 整块更淡
  const done = node.done === true;
  const opacity = done ? 0.75 : doneBranch ? 0.5 : 1;

  const parts: string[] = [
    `<g class="nestboard-mind-svg-node"${opacity < 1 ? ` opacity="${opacity}"` : ''}>`,
    // 底色（内容块）—— 与标题带同一块圆角矩形：分开画会在接缝处留一条发丝缝。
    // 影子挂在这一块上：它是整个节点的外框，影子于是围着整张卡（含标题带那一侧）
    `<rect x="${round(box.x)}" y="${round(box.y)}" width="${round(box.width)}" height="${round(box.height)}" ` +
      `rx="${radius}" fill="${palette.body}" filter="url(#${SHADOW_ID})"/>`,
    // ★ 带子**铺满整张卡**（没有内容的节点）时直接用圆角矩形：四个角都得圆 ——
    //   只圆上面两个的话，底下会露出直角。差 2px 以内算铺满：节点高度是估出来的，
    //   那点零头留着只会变成一条发丝缝
    bandHeight >= box.height - 2
      ? `<rect x="${round(box.x)}" y="${round(box.y)}" width="${round(box.width)}" ` +
        `height="${round(box.height)}" rx="${radius}" fill="${palette.title}"/>`
      : `<path d="${topRoundedRectPath(box, radius, bandHeight)}" fill="${palette.title}"/>`,
    ...(highlight === null
      ? []
      : [
          // 高亮矩形：上下按标题字号留出一点（0.72 / 1.44 与行高 1.35 那一套同源），
          // 左右各留 2px —— 与画布上"背景只铺在文字后头"看起来是一回事
          `<rect x="${round(box.x + PADDING_X - 2)}" ` +
            `y="${round(box.y + titleHeight / 2 - titleSize * 0.72)}" ` +
            `width="${round(textWidth + 4)}" ` +
            `height="${round(titleSize * 1.44)}" rx="2" fill="${highlight}"/>`,
        ]),
    `<text x="${round(box.x + PADDING_X)}" y="${round(box.y + titleHeight / 2)}" fill="${palette.titleInk}" ` +
      `font-size="${titleSize}" font-weight="${titleBoldOf(depth) ? '700' : '400'}" ` +
      `dominant-baseline="central">${escapeText(node.text)}</text>`,
    // 完成（`N3-g`）：标题上一条删除线。★ 宽度与上面那块高亮矩形**共用** `textWidth`，
    //   两条边的右端永远对得上 —— 用户看不到"线比字短半截"这种半成品样子
    ...(done
      ? [
          `<line x1="${round(box.x + PADDING_X)}" x2="${round(box.x + PADDING_X + textWidth)}" ` +
            `y1="${round(box.y + titleHeight / 2)}" y2="${round(box.y + titleHeight / 2)}" ` +
            `stroke="${palette.titleInk}" stroke-width="1.5"/>`,
        ]
      : []),
  ];

  const note = node.note.trim();
  if (note.length > 0) {
    const available = Math.max(24, box.width - PADDING_X * 2);
    const charsPerLine = Math.max(4, Math.floor(available / (titleSize * MIND_CHAR_WIDTH_RATIO)));
    const lines = wrapText(note, charsPerLine);
    const size = 14;
    const startY = box.y + titleHeight + 6 + size;
    lines.forEach((line, index) => {
      parts.push(
        `<text x="${round(box.x + PADDING_X)}" y="${round(startY + index * size * BODY_LINE_HEIGHT)}" ` +
          `fill="${palette.bodyInk}" font-size="${size}">${escapeText(line)}</text>`,
      );
    });
  }

  // 附件：图片画占位块（见文件头第 2 条），其余写一行文件名
  const ref = firstRefOf(node);
  if (ref) {
    parts.push(
      `<text x="${round(box.x + PADDING_X)}" y="${round(box.y + box.height - 10)}" fill="${palette.bodyInk}" ` +
        `font-size="12" opacity="0.75">${escapeText(`📎 ${refLabelOf(ref.path)}`)}</text>`,
    );
  }

  // ★ 边框**画在最后**（压在标题带之上）：先画的话标题带会把上边缘盖掉半条，
  //   于是同层相邻的节点在上边缘处仍然糊在一起 —— 那正是加它的原因
  parts.push(
    `<rect x="${round(box.x)}" y="${round(box.y)}" width="${round(box.width)}" height="${round(box.height)}" ` +
      `rx="${radius}" fill="none" stroke="${NODE_STROKE}" stroke-width="1"/>`,
  );

  parts.push('</g>');
  return parts.join('');
}

/**
 * 只有上方两个角是圆角的矩形（标题带压在内容块上面）。
 *
 * ★ 高度**由调用方给**（`nodeSvg` 里那个 `bandHeight`）：从前这里自带一个
 *   `min(height, 44)` 的算法，与文字用的公式分叉 —— 矮节点上带子会铺满整张卡，
 *   底下露出直角（见 `nodeSvg` 里的说明）。
 */
function topRoundedRectPath(box: NodeBox, radius: number, titleHeight: number): string {
  const { x, y, width } = box;
  const right = x + width;
  const bottom = y + titleHeight;
  return (
    `M ${round(x)} ${round(bottom)} L ${round(x)} ${round(y + radius)} ` +
    `Q ${round(x)} ${round(y)} ${round(x + radius)} ${round(y)} ` +
    `L ${round(right - radius)} ${round(y)} Q ${round(right)} ${round(y)} ${round(right)} ${round(y + radius)} ` +
    `L ${round(right)} ${round(bottom)} Z`
  );
}

/** 按字符数硬折行（与 `estimateNodeSize` 的估算同一个口径；中日韩混排只是近似） */
function wrapText(text: string, charsPerLine: number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split('\n')) {
    if (paragraph.length === 0) {
      out.push('');
      continue;
    }
    for (let index = 0; index < paragraph.length; index += charsPerLine) {
      out.push(paragraph.slice(index, index + charsPerLine));
    }
  }
  return out;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** XML 文本转义（`&` 必须先转，否则会把自己的转义序列转坏） */
function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(value: string): string {
  return escapeText(value).replace(/"/g, '&quot;');
}
