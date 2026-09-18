/**
 * 导出 SVG（T6.01 / `F9-06`）—— 把同一块白板画成**矢量**。
 *
 * 与 `export/toPng.ts` 的关系是"同一个画面的两种烧录方式"：几何、调色板、留白、
 * 范围（整板 / 视口 / 选中）全部**复用** `toPng` 里那几件事（`resolveExportBounds`、
 * `alignTile`、`rectOfCard`、`rectOfColumn`、`cardPreview`、`wrapText`、`PngPalette`），
 * 差别只在于"往哪儿写"：那边往 Canvas 的 `ctx` 上画像素，这边往字符串里写元素。
 * 于是**同一块板导出的 PNG 与 SVG 长得一样**（除非下面点名的那几处降级）。
 *
 * ★ 为什么值得单独做一个格式：PNG 一放大就糊，而白板天然是"越放大越该清楚"的东西
 *   （用户会把它贴进 PPT、投到会议室大屏）。SVG 没有分辨率这回事，放大多少倍都是
 *   那几个形状与文字。
 *
 * ★ **不做分页、不做倍率**：矢量本来就没有像素上限，4096 的分页与 1–4 的倍率都是
 *   为位图引入的概念，搬过来只会让用户面对一堆没有意义的选项。
 *
 * ★ **位图内容会降级**（这是本格式唯一的实质性取舍）：图片卡、地图卡与手绘卡在 SVG 里只画
 *   标题与说明文字，不内嵌位图。理由有两条 —— 一是内嵌 base64 会让文件从几十 KB
 *   涨到几十 MB（这几 MB 的图在矢量里也不会变清楚，等于白涨）；二是本插件承诺不碰
 *   二进制编解码的 Node 模块（`02 §6`），自己拼 base64 只是把一件没有收益的事做复杂。
 *   要带图请用 PNG / PDF（那两个格式本来就以位图为主体）。这条降级是**安静**的，
 *   所以对话框里会明确写出来。
 *
 * ★ 全部是纯函数（除 {@link SvgExporter} 只做落盘），可以在 node 下直接单测：
 *   输入一块板，断言输出字符串里有哪几个元素、坐标对不对。
 */

import {
  edgePathMidpoint,
  edgePolyline,
  obstacleRects,
  polylineEndDirections,
  polylineLength,
  shrinkPolylineEnd,
  type AngleLookup,
  type EdgePath,
} from '../model/edges';
import { isThemeColor } from '../model/schema';
import type { BoardBackground, BoardFile, Card, CardColor } from '../model/schema';
import { normalizeHex } from '../util/color';
import { textToArrayBuffer } from '../util/encoding';
import { rectCenter, type Rect } from '../util/geometry';
import { t } from '../util/i18n';
import {
  NOTE_DARK_FILL,
  NOTE_DARK_MUTED,
  NOTE_DARK_TEXT,
  alignTile,
  cardPreview,
  isDarkNoteCard,
  rectOfCard,
  rectOfColumn,
  resolveExportBounds,
  uniqueExportPath,
  wrapText,
} from './toPng';
import type {
  PngBoundsContext,
  PngExportSink,
  PngExportTarget,
  PngPalette,
  PngRange,
} from './toPng';

// ─────────────────────────────────────────────────────────────
// 选项与计划（纯逻辑）
// ─────────────────────────────────────────────────────────────

/**
 * SVG 的导出选项只在"画哪一块"上有选择。
 *
 * 刻意**没有** `scale` / `paginate`（矢量的两个位图概念，见文件头）；
 * `transparent` 属于绘制阶段，放在 {@link SvgRenderOptions} 里。
 */
export interface SvgExportOptions {
  /** 范围，默认 `'all'`。语义与 PNG 完全一致（含"选区为空就退化成整板"） */
  range?: PngRange;
  /** 四周留白（世界坐标 px），默认 `DEFAULT_PNG_PADDING` */
  padding?: number;
}

export interface SvgPlan {
  /** 含留白的导出边界（世界坐标，已向外对齐到整数） */
  bounds: Rect;
  /** 画布的世界尺寸，同时也是 `<svg width/height>` 的值（1:1，放大交给查看器） */
  width: number;
  height: number;
}

/** 空板 / 没有可导出内容时的计划：宽高为 0，调用方据此拦下这次导出 */
export function emptySvgPlan(): SvgPlan {
  return { bounds: { x: 0, y: 0, width: 0, height: 0 }, width: 0, height: 0 };
}

/**
 * 求导出计划。
 *
 * ★ 接受 `null` 板子（视图在还没加载完时按下导出）—— 直接给空计划，
 *   让调用方走同一条"没有内容"的提示，而不是在这里抛。
 * ★ 边界同样走 {@link alignTile}：与 PNG 用同一套对齐规则，两种格式的范围
 *   就不会差出半个像素（用户在对话框里看到的是同一个尺寸）。
 */
export function planSvgExport(
  board: BoardFile | null,
  options: SvgExportOptions = {},
  context: PngBoundsContext = {},
): SvgPlan {
  if (!board) return emptySvgPlan();
  const bounds = resolveExportBounds(board, options, context);
  if (!bounds || bounds.width <= 0 || bounds.height <= 0) return emptySvgPlan();
  const aligned = alignTile(bounds);
  return { bounds: aligned, width: aligned.width, height: aligned.height };
}

// ─────────────────────────────────────────────────────────────
// 文字宽度估算（纯逻辑）
// ─────────────────────────────────────────────────────────────

/** 全角字符的判定范围：CJK、全角标点、谚文、常见 emoji */
export function isWideChar(codePoint: number): boolean {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0x303e) ||
    (codePoint >= 0x3041 && codePoint <= 0x33ff) ||
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0xa000 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe4f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1faff)
  );
}

/** 非全角字符的平均宽度占比（拉丁字母 + 数字 + 标点的经验值） */
const NARROW_RATIO = 0.55;

/**
 * 估算一段文字在给定字号下的宽度（世界 px）。
 *
 * ★ 这里是 SVG 与 PNG 之间**唯一一处"看起来该测却测不了"**的地方：Canvas 有
 *   `ctx.measureText`，而 SVG 是纯字符串拼接，手上没有任何排版内核。
 *   硬要精确，就得在导出时偷偷建一个 canvas 来量 —— 那就把这条纯逻辑链弄脏了，
 *   而它换来的只是换行位置的区别（画布上本来就用的真实测量，SVG 只是排版近似）。
 * ★ 所以取一个**不依赖字体**的估算：全角算一个字宽，其余按 0.55 倍。对中文白板够用，
 *   对纯英文会略宽一点 —— 宁可早换行，也不要文字冲出卡片边框。
 */
export function estimateTextWidth(text: string, fontSize: number): number {
  let width = 0;
  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0;
    width += isWideChar(codePoint) ? fontSize : fontSize * NARROW_RATIO;
  }
  return width;
}

/**
 * 裁到一行能放下，放不下就在末尾加省略号。
 *
 * 与 `toPng` 的 `fillClippedText` **逐字对应**（含"只剩一个字也仍是 `字…`"这条边界），
 * 只是把 `ctx.measureText` 换成了注入的 `measure`。
 */
export function clipText(
  text: string,
  maxWidth: number,
  measure: (value: string) => number,
): string {
  if (maxWidth <= 0 || text.length === 0) return '';
  if (measure(text) <= maxWidth) return text;
  let end = text.length;
  while (end > 1 && measure(`${text.slice(0, end)}…`) > maxWidth) end -= 1;
  return `${text.slice(0, end)}…`;
}

// ─────────────────────────────────────────────────────────────
// 绘制（纯逻辑：板子 → SVG 字符串）
// ─────────────────────────────────────────────────────────────

export interface SvgRenderOptions {
  /** 背景模式；不传则取 `board.view.background` */
  background?: BoardBackground;
  /** 网格单元格，默认 32（与 `toPng` 同一套默认） */
  gridSize?: number;
  /** 背景透明（不铺底色与点阵/网格），默认 `false` */
  transparent?: boolean;
  palette: PngPalette;
  /** 卡片正文最多画几行，默认 6（与 PNG 一致） */
  maxLines?: number;
}

/** 卡片标题字号（世界 px）—— 与 `toPng` 同值，两种导出才对得上 */
const TITLE_FONT_SIZE = 12;
/** 卡片正文字号（世界 px） */
const BODY_FONT_SIZE = 11;
const CARD_PADDING = 8;
const CARD_RADIUS = 8;
const HEADER_HEIGHT = 24;
const ACCENT_WIDTH = 4;
/** 点阵/网格缩小到"画了也是噪点"时停手（与 `toPng` 同一道闸门） */
const MIN_PATTERN_CELL = 4;
/** 卡片淡色底的透明度，对应 `styles.css` 的 14% */
const CARD_TINT_ALPHA = 0.14;

/** 图案 `<pattern>` 的 id：整份文件里唯一，`<defs>` 与引用它的 `<rect>` 共用 */
const PATTERN_ID = 'nestboard-pattern';

/** 与 canvas 的 `textBaseline` 对齐（`top` ↔ `text-before-edge`，`middle` ↔ `central`） */
const BASELINE_TOP = 'text-before-edge';
const BASELINE_MIDDLE = 'central';

const XML_ESCAPE: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

/** 转义进 XML 的文本 / 属性值。漏掉一个 `&` 就会让整份文件打不开（不是画错一笔） */
export function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => XML_ESCAPE[char] ?? char);
}

/** 坐标与尺寸统一保留两位小数：SVG 里不需要更多精度，多写的每一位都是文件体积 */
function num(value: number): string {
  if (!Number.isFinite(value)) return '0';
  return String(Math.round(value * 100) / 100);
}

function resolveColor(color: CardColor, palette: PngPalette): string {
  if (isThemeColor(color)) return palette.theme[color] || palette.cardBorder;
  return normalizeHex(color) ?? palette.cardBorder;
}

/** 一个圆角矩形元素。`extra` 用来追加 `stroke` / `fill-opacity` 这类单项属性 */
function rectTag(rect: Rect, radius: number, fill: string, extra = ''): string {
  return `<rect x="${num(rect.x)}" y="${num(rect.y)}" width="${num(rect.width)}" height="${num(
    rect.height,
  )}" rx="${num(radius)}" ry="${num(radius)}" fill="${escapeXml(fill)}"${extra}/>`;
}

function textTag(
  text: string,
  x: number,
  y: number,
  fontSize: number,
  weight: number,
  fill: string,
  baseline: string,
  extra = '',
): string {
  return `<text x="${num(x)}" y="${num(y)}" fill="${escapeXml(fill)}" font-size="${num(
    fontSize,
  )}" font-weight="${weight}" dominant-baseline="${baseline}"${extra}>${escapeXml(text)}</text>`;
}

/**
 * 点阵 / 网格的 `<pattern>` 定义；不需要图案时返回 `null`。
 *
 * ★ 这里比分页 PNG **省得多**：Canvas 上逐格画点是 O(格数)，所以那边必须有一道
 *   `MAX_PATTERN_CELLS` 闸门；SVG 的 `<pattern>` 只有**一个元素**，平铺交给查看器，
 *   再大的板也不会让文件膨胀 —— 所以这里不需要那道闸门，只需保留"格子太小就别画"。
 * ★ `patternUnits="userSpaceOnUse"` 且原点在用户空间 (0,0)：图案落在 cell 的整数倍上，
 *   与 Canvas 那版 `startX = floor(tile.x / cell) * cell` 完全一致。
 */
function patternDef(mode: BoardBackground, cell: number, palette: PngPalette): string | null {
  if (mode !== 'dots' && mode !== 'grid') return null;
  if (!Number.isFinite(cell) || cell < MIN_PATTERN_CELL) return null;

  const color = escapeXml(palette.pattern);
  const body =
    mode === 'dots'
      ? `<circle cx="0" cy="0" r="1.5" fill="${color}"/>`
      : `<path d="M 0 0 H ${num(cell)} M 0 0 V ${num(cell)}" stroke="${color}" stroke-width="1" fill="none"/>`;

  return `<defs><pattern id="${PATTERN_ID}" patternUnits="userSpaceOnUse" width="${num(
    cell,
  )}" height="${num(cell)}">${body}</pattern></defs>`;
}

function backgroundElements(
  plan: SvgPlan,
  options: SvgRenderOptions,
  patterned: boolean,
): string[] {
  if (options.transparent) return [];
  const rect = rectTag(plan.bounds, 0, options.palette.background);
  if (patterned) return [rect, rectTag(plan.bounds, 0, `url(#${PATTERN_ID})`)];
  return [rect];
}

function columnElements(board: BoardFile, palette: PngPalette): string[] {
  const columns = [...board.columns].sort((a, b) => a.z - b.z);
  const out: string[] = [];

  for (const column of columns) {
    const rect = rectOfColumn(column);
    const fill = escapeXml(palette.cardFill);
    const stroke = escapeXml(palette.cardBorder);

    out.push(rectTag(rect, CARD_RADIUS, fill, ` stroke="${stroke}" stroke-width="1"`));
    // 标题栏分隔线：与卡片头部同高
    out.push(
      `<path d="M ${num(rect.x)} ${num(rect.y + HEADER_HEIGHT)} H ${num(
        rect.x + rect.width,
      )}" stroke="${stroke}" stroke-width="1" fill="none"/>`,
    );

    const title = column.title.trim() || t('column.title.placeholder');
    const width = rect.width - CARD_PADDING * 2;
    const text = clipText(title, width, (value) => estimateTextWidth(value, TITLE_FONT_SIZE));
    if (text.length > 0) {
      out.push(
        textTag(
          text,
          rect.x + CARD_PADDING,
          rect.y + HEADER_HEIGHT / 2,
          TITLE_FONT_SIZE,
          600,
          palette.cardText,
          BASELINE_MIDDLE,
        ),
      );
    }
  }

  return out;
}

function arrowHead(
  tip: { x: number; y: number },
  dirX: number,
  dirY: number,
  length: number,
  color: string,
): string {
  const half = length * 0.45;
  const px = -dirY;
  const py = dirX;
  const baseX = tip.x - dirX * length;
  const baseY = tip.y - dirY * length;
  const points = [
    `${num(tip.x)},${num(tip.y)}`,
    `${num(baseX + px * half)},${num(baseY + py * half)}`,
    `${num(baseX - px * half)},${num(baseY - py * half)}`,
  ].join(' ');
  return `<polygon points="${points}" fill="${color}"/>`;
}

function edgeElements(board: BoardFile, palette: PngPalette): string[] {
  if (board.edges.length === 0) return [];

  const rects = new Map<string, Rect>();
  const angles = new Map<string, number>();
  for (const card of board.cards) {
    rects.set(card.id, rectOfCard(card));
    if (card.rotation) angles.set(card.id, card.rotation);
  }
  // ★ 分栏也是端点（`O21`）：与画布、PNG 导出同一份判据
  for (const column of board.columns) rects.set(column.id, rectOfColumn(column));
  const lookup = (cardId: string): Rect | null => rects.get(cardId) ?? null;
  // 锚点跟着卡片旋转走（T7.06）：与 PNG 同一个理由 —— 不喂角度，连线会插进转过的卡片里
  const angleOf: AngleLookup = (cardId) => angles.get(cardId) ?? 0;
  // Smart 路由要绕开的卡片（T7.11）：与画布、PNG 同一份判据 —— 没有 smart 线就不建表
  const obstacles = board.edges.some((edge) => edge.routing === 'smart')
    ? obstacleRects(
        board.cards.map((card) => card.id),
        lookup,
      )
    : [];

  const out: string[] = [];
  for (const edge of board.edges) {
    // ★ 走 `edgePolyline`：弧线（T7.12）与智能绕行（T7.11）的形状只由它决定 ——
    //   画布、命中、框选、两种导出共用一个答案
    const path = edgePolyline(edge, { rectOf: lookup, angleOf, obstacles });
    if (!path) continue;
    const points = path.points;

    const color = escapeXml(resolveColor(edge.color, palette));
    const { from: startDir, to: endDir } = polylineEndDirections(points);
    const arrow = 8;
    const shrink = Math.min(arrow, polylineLength(points) / 3);
    let line: readonly { x: number; y: number }[] = points;
    if (edge.fromEnd === 'arrow') line = shrinkPolylineEnd(line, 'from', shrink, startDir);
    if (edge.toEnd === 'arrow') line = shrinkPolylineEnd(line, 'to', shrink, endDir);

    const dash = edge.style === 'dashed' ? ' stroke-dasharray="6 4"' : '';
    out.push(
      `<path d="${pathData(path.kind, line)}" stroke="${color}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none"${dash}/>`,
    );

    const last = points.length - 1;
    // ★ `endDir` 指路径内部，箭头要的是"朝卡片外"的方向 —— 两端都取反，与画布一致
    if (edge.toEnd === 'arrow')
      out.push(arrowHead(points[last], -endDir.x, -endDir.y, arrow, color));
    if (edge.fromEnd === 'arrow') {
      out.push(arrowHead(points[0], -startDir.x, -startDir.y, arrow, color));
    }

    // 标签（T7.13）画在自己的线之后、下一条线之前 —— 与画布上的叠放次序一致
    if (edge.label.length > 0) {
      out.push(...edgeLabelElements(edge.label, path, color, palette));
    }
  }

  return out;
}

/**
 * 一串点 → SVG 路径数据。
 *
 * ★ 直线 / 弧线 / 折线由 `kind` 决定，**不按点数猜**：正交走线（T7.11）也可能只有
 *   3 个点，按点数判会把一个直角弯导出成一段圆弧。
 */
function pathData(kind: EdgePath['kind'], points: readonly { x: number; y: number }[]): string {
  const first = points[0];
  if (kind === 'curve') {
    return `M ${num(first.x)} ${num(first.y)} Q ${num(points[1].x)} ${num(points[1].y)} ${num(
      points[2].x,
    )} ${num(points[2].y)}`;
  }
  let data = `M ${num(first.x)} ${num(first.y)}`;
  for (let index = 1; index < points.length; index++) {
    data += ` L ${num(points[index].x)} ${num(points[index].y)}`;
  }
  return data;
}

/** 连线标签字号 / 内边距 / 最大宽度：与画布上的 `EdgeRenderer` 保持同一组数值 */
const EDGE_LABEL_FONT_SIZE = 11;
const EDGE_LABEL_MAX_WIDTH = 220;
const EDGE_LABEL_PADDING_X = 5;
const EDGE_LABEL_PADDING_Y = 2;
const EDGE_LABEL_RADIUS = 4;

/**
 * 连线标签（T7.13）：路径中点 + 一块与背景同色的圆角底。
 *
 * ★ 底不能省：文字直接压在线上的话，与线重合的那一两个笔画会被线吃掉
 *   （浅色主题下尤其明显）—— 垫一块底色等于让文字"坐"在线上面。
 * ★ 落点用 `edgePathMidpoint`：与弧度手柄、与 PNG、与画布是同一个点。
 * ★ 宽度用 `estimateTextWidth` 估（见该函数的注释：SVG 这条链上没有任何排版内核），
 *   所以这里的截断点可能与画布差一两个字 —— 这是已知且可接受的近似。
 */
function edgeLabelElements(
  label: string,
  path: EdgePath,
  color: string,
  palette: PngPalette,
): string[] {
  const anchor = edgePathMidpoint(path);
  const measure = (value: string): number => estimateTextWidth(value, EDGE_LABEL_FONT_SIZE);
  const text = clipText(label, EDGE_LABEL_MAX_WIDTH, measure);
  const width = measure(text) + EDGE_LABEL_PADDING_X * 2;
  const height = EDGE_LABEL_FONT_SIZE + EDGE_LABEL_PADDING_Y * 2;

  return [
    rectTag(
      { x: anchor.x - width / 2, y: anchor.y - height / 2, width, height },
      EDGE_LABEL_RADIUS,
      palette.background,
    ),
    textTag(
      text,
      anchor.x,
      anchor.y,
      EDGE_LABEL_FONT_SIZE,
      400,
      color,
      BASELINE_MIDDLE,
      ' text-anchor="middle"',
    ),
  ];
}

function cardElement(card: Card, maxLines: number, palette: PngPalette): string[] {
  const rect = rectOfCard(card);
  const inset = card.accent ? ACCENT_WIDTH : 0;
  const themeColor = resolveColor(card.color, palette);
  const escapedTheme = escapeXml(themeColor);
  const out: string[] = [];
  // 深色便签（`O06`）：与 `drawCards` 一样换底色并**跳过**主题色淡底那一层 ——
  // 两种导出格式必须画出同一张图（本文件头注的承诺），所以这里的判据与取值都从
  // `export/toPng.ts` 取，不在本文件另立一份
  const darkNote = isDarkNoteCard(card);

  // 底板 → 主题色淡底 → 边框，三层与 `drawCards` 的顺序一致（顺序错了颜色就不对）
  out.push(rectTag(rect, CARD_RADIUS, darkNote ? NOTE_DARK_FILL : palette.cardFill));
  if (!darkNote) {
    out.push(rectTag(rect, CARD_RADIUS, themeColor, ` fill-opacity="${CARD_TINT_ALPHA}"`));
  }
  const dash = card.locked ? ' stroke-dasharray="4 3"' : '';
  out.push(rectTag(rect, CARD_RADIUS, 'none', ` stroke="${escapedTheme}" stroke-width="1"${dash}`));

  // 左侧强调条：canvas 用 `fillRect`，所以是**直角**的（不跟着卡片一起圆角）
  if (card.accent) {
    const accent = escapeXml(normalizeHex(card.accent) ?? themeColor);
    out.push(
      `<rect x="${num(rect.x)}" y="${num(rect.y)}" width="${ACCENT_WIDTH}" height="${num(
        rect.height,
      )}" fill="${accent}"/>`,
    );
  }

  const textLeft = rect.x + CARD_PADDING + inset;
  const textWidth = rect.width - CARD_PADDING * 2 - inset;
  let cursorY = rect.y + CARD_PADDING;

  if (card.showTitle && card.title.trim().length > 0) {
    const measure = (value: string): number => estimateTextWidth(value, TITLE_FONT_SIZE);
    const first = wrapText(measure, card.title, textWidth)[0] ?? '';
    const clipped = clipText(first, textWidth, measure);
    if (clipped.length > 0) {
      out.push(
        textTag(
          clipped,
          textLeft,
          cursorY,
          TITLE_FONT_SIZE,
          600,
          darkNote ? NOTE_DARK_TEXT : palette.cardText,
          BASELINE_TOP,
        ),
      );
    }
    cursorY += TITLE_FONT_SIZE + CARD_PADDING;
  }

  // ★ 图片卡 / 手绘卡在这里就是"一张只有文字的卡"（见文件头）：
  //   于是它们自然落到与画布上"图片还没加载出来"同一条回落路径上，
  //   而不是画一个只有边框的空盒子。
  const preview = cardPreview(card);
  const measure = (value: string): number => estimateTextWidth(value, BODY_FONT_SIZE);
  const rows: string[] = [];
  if (preview.label.length > 0) rows.push(...wrapText(measure, preview.label, textWidth));
  for (const line of preview.lines) rows.push(...wrapText(measure, line, textWidth));

  const lineHeight = BODY_FONT_SIZE + 3;
  const bodyBottom = rect.y + rect.height - CARD_PADDING;
  let drawn = 0;

  for (const row of rows) {
    if (drawn >= maxLines || cursorY + lineHeight > bodyBottom) break;
    const clipped = clipText(row, textWidth, measure);
    if (clipped.length > 0) {
      out.push(
        textTag(
          clipped,
          textLeft,
          cursorY,
          BODY_FONT_SIZE,
          400,
          darkNote ? NOTE_DARK_MUTED : palette.mutedText,
          BASELINE_TOP,
        ),
      );
    }
    cursorY += lineHeight;
    drawn += 1;
  }

  // 旋转（T7.06 / `F2-00-10`）：整张卡的元素套进一个 `<g>`，用一个 `rotate(a cx cy)` 转完。
  //
  // ★ 为什么不逐个元素算旋转后的坐标：卡片里有底板 / 淡色层 / 边框 / 强调条 / 标题 /
  //   正文这一串元素，逐个手算等于把 `rotatePoint` 抄进七八处调用点（文字还得再处理
  //   基线与基线向量）。套一个分组，SVG 的变换矩阵替我们做完这一切，还**逐像素**
  //   与画布上的 `ctx.rotate` 一致（本文件头注承诺的"两种格式长得一样"）。
  // ★ `rotate(deg, cx, cy)` 的三参形式，正方向就是**顺时针**（y 轴向下），
  //   与模型 / CSS / Canvas 的约定一致，不需要额外取负。
  // ★ 没转过（绝大多数卡片）时**不套 `<g>`**：多一层分组只是让文件变长，
  //   而且会让"这块板有没有旋转"这件事在 diff 里毫无必要地暴露出来。
  const angle = card.rotation ?? 0;
  if (angle === 0) return out;
  const center = rectCenter(rect);
  return [
    `<g transform="rotate(${num(angle)} ${num(center.x)} ${num(center.y)})">`,
    ...out,
    '</g>',
  ];
}

/**
 * 整块板 → 一份完整的 SVG 文档。
 *
 * 元素顺序与 `renderTile` 一样是**背景 → 分栏 → 连线 → 卡片**：
 * 卡片压在连线上、连线压在分栏上，与画布上看到的层次一致。
 */
export function renderBoardSvg(board: BoardFile, plan: SvgPlan, options: SvgRenderOptions): string {
  const { palette } = options;
  const parts: string[] = [];

  parts.push('<?xml version="1.0" encoding="UTF-8"?>');
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${num(plan.width)}" height="${num(
      plan.height,
    )}" viewBox="${num(plan.bounds.x)} ${num(plan.bounds.y)} ${num(plan.bounds.width)} ${num(
      plan.bounds.height,
    )}" font-family="${escapeXml(palette.fontFamily)}">`,
  );

  const title = board.meta.title.trim();
  if (title.length > 0) parts.push(`<title>${escapeXml(title)}</title>`);

  // 背景模式与 PNG 同一条回落链：选项没给就看板子自己的设置（`drawBackground` 也是这么做的）
  const mode = options.background ?? board.view.background;
  // 透明时不写图案定义：定义了也没人引用，白占一段
  const defs = options.transparent ? null : patternDef(mode, options.gridSize ?? 32, palette);
  if (defs) parts.push(defs);

  parts.push(...backgroundElements(plan, options, defs !== null));
  parts.push(...columnElements(board, palette));
  parts.push(...edgeElements(board, palette));

  const maxLines = options.maxLines ?? 6;
  for (const card of [...board.cards].sort((a, b) => a.z - b.z)) {
    parts.push(...cardElement(card, maxLines, palette));
  }

  parts.push('</svg>');
  return `${parts.join('\n')}\n`;
}

// ─────────────────────────────────────────────────────────────
// 落盘
// ─────────────────────────────────────────────────────────────

/** 与 PNG 同一套落盘端口：SVG 只是把文本编成 UTF-8 字节走同一条路 */
export type SvgExportSink = PngExportSink;
export type SvgExportTarget = PngExportTarget;

/** 单文件命名：`名字.svg`（重名时的编号由 {@link SvgExporter} 处理） */
export function svgFileName(name: string): string {
  return `${name}.svg`;
}

/**
 * 把 SVG 写进 Vault。
 *
 * ★ 重名**顺延编号、不覆盖**：与 `PngExporter` 共用 `uniqueExportPath` 那一条规矩
 *   —— 覆盖掉的是别人已有的文件（不可逆），而顺延只是多出一个文件。
 * ★ 文本转字节走 `textToArrayBuffer`（`util/encoding`），与 ZIP 里的 `.nboard` 同一条路。
 */
export class SvgExporter {
  constructor(private readonly sink: SvgExportSink) {}

  /** 写入并返回**实际**落盘路径（可能与请求的名字不同，见类注释） */
  async export(svg: string, target: SvgExportTarget): Promise<string> {
    const prefix = target.folder.length > 0 ? `${target.folder.replace(/\/+$/, '')}/` : '';
    const path = await uniqueExportPath(this.sink, prefix, svgFileName(target.name));
    await this.sink.createBinary(path, textToArrayBuffer(svg));
    return path;
  }
}
