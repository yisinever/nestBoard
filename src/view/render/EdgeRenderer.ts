/**
 * 连线绘制（T1.69 / T1.70，`F3-04` / `F3-05` / `F3-09`；T7.11–T7.13 补路由 / 弧度 / 标签）。
 *
 * 本文件是 `EdgeLayer.setPainter()` 的生产实现：`EdgeLayer` 只管"哪块脏了、
 * 把坐标系摆好"，"线长什么样"全部在这里。
 *
 * ── 六个决定 ──────────────────────────────────────────────
 *
 * 1. **线宽在屏幕上是稳定的**。`ctx` 处在世界坐标系里，直接写 `lineWidth = 1.5`
 *    会在缩到 25% 时变成 0.375px —— 线看不见，也没法点中。所以按 `zoom` 反算：
 *    放大时线跟着内容一起变粗（像 Excalidraw），缩小时**不再继续变细**。
 *
 * 2. **端点自动收缩**，不让线顶到卡片边框上：锚点在边中点，箭头正好压在框线上
 *    会和卡片描边糊成一团。收缩方向取**端点处的切线**（`F3-07` / `T7.11` 之后
 *    线可能是弧线或折线，"两端的连线方向"不再是唯一的那个方向）。
 *
 * 3. **虚线只用于 `style: 'dashed'`**，并且画完立刻 `setLineDash([])` 复位 ——
 *    漏掉复位的后果是同层后面画的**所有**线都变成虚线（`OverlayLayer` 踩过同一个坑）。
 *
 * 4. **颜色分两套**：主题 6 色从 CSS 变量取（跟随深浅主题），自定义 HEX 直接用。
 *    canvas 不认 `var(--color-red)`，所以必须取**计算后**的值（`util/color.ts`
 *    返回的是 `var(...)`，那是给 DOM 用的，这里用不了）。
 *
 * 5. **一条线画成什么形状，只由 `edgePolyline` 决定** ——
 *    与命中测试、框选、导出用**同一个函数**。这里自己再判一次 `routing`、
 *    自己拼一遍路由的话，"看着在这条线上、点下去选不中"会以四种不同的形式冒出来
 *    （`edgePolyline` 的注释里写着这条约定）。
 *
 * 6. **标签（T7.13）带底色**。文字直接压在线上的话，与线重合的那一两个笔画会
 *    被线吃掉（浅色主题下尤其明显）；加一个背景色圆角块，等于让文字"坐"在线上面。
 *
 * ★ **端点可以是卡片，也可以是分栏**（`O21`）—— 本文件对此完全无感：它只查
 *   `id → 矩形`，谁在这张表里谁就是端点（见 `createRectLookup`）。
 *
 * ★ 不 import `obsidian`，只用标准 DOM / Canvas API。
 */

import { cardDisplayHeight } from '../../constants';
import { THEME_COLOR_VAR, normalizeHex } from '../../util/color';
import { expandRect, rectsIntersect, type Point, type Rect } from '../../util/geometry';
import {
  edgeEndpoints,
  edgePathMidpoint,
  edgePolyline,
  pathBounds,
  polylineEndDirections,
  polylineLength,
  shrinkPolylineEnd,
  type AngleLookup,
  type EdgePath,
  type RectLookup,
} from '../../model/edges';
import { ROUTE_MARGIN } from '../../model/edgeRouting';
import { isThemeColor } from '../../model/schema';
import type { BoardFile, CardColor, Edge, EdgeCurve, ThemeColor } from '../../model/schema';
import { columnRect } from './ColumnLayer';
import type { EdgeFrame, EdgePainter } from './EdgeLayer';

/** 基础线宽（屏幕像素，zoom ≥ 1 时线宽 = 它 × zoom） */
const BASE_LINE_WIDTH = 1.6;

/** 选中态线宽倍数 */
const SELECTED_WIDTH_FACTOR = 2.2;

/**
 * 缩小时线宽的衰减下限（屏幕像素）。
 * 再细就既看不见也点不中了；`02 §8.1` 要求缩到 25% 仍能看清板子结构。
 */
const MIN_SCREEN_WIDTH = 1.2;

/** 箭头长度（屏幕像素，与线宽同样按 zoom 反算） */
const ARROW_LENGTH = 9;

/** 虚线节奏（屏幕像素） */
const EDGE_DASH = [6, 4] as const;

/** 标签字号（屏幕像素） */
const LABEL_FONT_SIZE = 11;

/** 标签最长宽度（屏幕像素，超出截断加省略号） */
const LABEL_MAX_WIDTH = 220;

/** 标签背景块的内边距（屏幕像素） */
const LABEL_PADDING_X = 5;
const LABEL_PADDING_Y = 2;

/** 标签背景块的圆角（屏幕像素） */
const LABEL_RADIUS = 4;

/**
 * 标签可能从**路径包围盒**向外伸出的距离（屏幕像素）。
 *
 * ★ 用于脏区裁剪：标签以路径中点为心，所以它最多伸出"半宽 + 内边距"。
 *   裁剪不把这块算进去的话，拖动卡片时**线重画了、标签还留在原地** ——
 *   这是最难察觉的一类脏区 bug（残影只在线条末端出现，静止时才看得见）。
 */
const LABEL_REACH = LABEL_MAX_WIDTH / 2 + LABEL_PADDING_X;

/** 主题 6 色 + 选中色的实际值（一帧取一次，不逐条线读 `getComputedStyle`） */
export interface EdgePalette {
  theme: Record<ThemeColor, string>;
  fallback: string;
  /** 选中态：跟着主题强调色走，深浅主题都不刺眼 */
  selected: string;
  /** 标签底块：与画布同色，于是标签看起来是"在线上面"而不是"贴了张纸" */
  labelBackground: string;
  /** 标签字体（canvas 不认 CSS 变量，必须取出计算后的字体栈） */
  font: string;
}

/**
 * 从画布元素读主题色。
 *
 * 逐帧读一次 `getComputedStyle` 是可以接受的：连线层只在**标脏时**才重绘
 * （见 `EdgeLayer.render`），静止时一帧都不读。
 */
export function readEdgePalette(element: Element): EdgePalette {
  const style = getComputedStyle(element);
  const fallback = style.getPropertyValue('--text-muted').trim() || 'gray';
  const theme = {} as Record<ThemeColor, string>;
  for (const [key, cssVar] of Object.entries(THEME_COLOR_VAR)) {
    theme[key as ThemeColor] = style.getPropertyValue(cssVar).trim() || fallback;
  }
  return {
    theme,
    fallback,
    selected: style.getPropertyValue('--interactive-accent').trim() || fallback,
    labelBackground: style.getPropertyValue('--background-primary').trim() || 'white',
    font: style.getPropertyValue('--font-interface').trim() || 'sans-serif',
  };
}

export interface EdgeRendererOptions {
  /** 取主题色的宿主元素（画布容器即可） */
  host: Element;
  getBoard: () => BoardFile | null;
  /** 选中的连线 id（活引用即可，绘制时读一次） */
  getSelected: () => ReadonlySet<string>;
  /**
   * 拖动中的临时几何（T1.70）。
   *
   * ★ 拖动中模型还没变（`DragController` 松手才提交），要让线跟着手走就必须
   *   能喂进"卡片现在在哪"。返回 `null` 表示没有拖动，按模型里的矩形画。
   */
  getOverrideRects?: () => ReadonlyMap<string, Rect> | null;
  /**
   * 拖动中的临时旋转角（T7.06）。
   *
   * ★ 与 `getOverrideRects` 同一条理由：拖动中模型还没变，锚点却要跟着转 ——
   *   不喂进来的话，转一张接了线的卡时线头会浮在卡片外面（锚点还停在旧角度上），
   *   松手才"啪"地贴回去。
   * ★ 是**覆盖表**而不是全量：表里没有的卡片仍按模型里的角度算。
   */
  getOverrideAngles?: () => ReadonlyMap<string, number> | null;
  /**
   * 拖动中的临时弧度（T7.12）。
   *
   * ★ 还是同一条理由：拖弧度手柄时模型没变（松手才提交），线却要立刻跟着手弯。
   *   值是 `edgeId → 弧度`（`null` = 拉直）；**表里有这个键才算覆盖**，
   *   否则用模型里的弧度 —— 与另两张覆盖表同一个约定。
   */
  getOverrideCurves?: () => ReadonlyMap<string, EdgeCurve | null> | null;
}

/** 生成可挂到 `EdgeLayer.setPainter()` 的绘制回调 */
export function createEdgePainter(options: EdgeRendererOptions): EdgePainter {
  return (frame: EdgeFrame) => {
    const board = options.getBoard();
    if (!board || board.edges.length === 0) return;

    const override = options.getOverrideRects?.() ?? null;
    const rectOf = createRectLookup(board, override);
    const angleOf = createAngleLookup(board, options.getOverrideAngles?.() ?? null);
    const palette = readEdgePalette(options.host);
    const selected = options.getSelected();
    const curves = options.getOverrideCurves?.() ?? null;
    const zoom = frame.zoom > 0 ? frame.zoom : 1;

    // ★ 懒建障碍表：一张全是 free 连线的板子不该为"可能存在的智能路由"付建表的钱
    // ★ 障碍必须走 `rectOf`（= 视觉几何）而不是模型的 `card.x/y`：栏内滚动过的成员
    //   在屏幕上是另一个位置，按模型坐标绕开的话，线会绕着一个**看不见的框**走
    let obstacles: Rect[] | null = null;
    const obstacleRects = (): Rect[] => {
      if (!obstacles) {
        obstacles = board.cards
          .map((card) => rectOf(card.id))
          .filter((rect): rect is Rect => rect !== null);
      }
      return obstacles;
    };

    // 预筛的宽容度：路由可能绕出两端包围盒（ROUTE_MARGIN），标签又从路径向外伸
    const preCull = (ROUTE_MARGIN + LABEL_REACH) / zoom;

    for (const edge of board.edges) {
      const endpoints = edgeEndpoints(edge, rectOf, angleOf);
      if (!endpoints) continue;
      // 线段的包围盒（外扩一圈）和本帧脏区不相交 → 这次重绘跟它无关。
      // ★ 必须先筛再算路径：Smart 路由要搜网格，为一条根本画不到的线付这份钱
      //   在 1000 卡场景下是灾难（`02 §8.2`）
      if (!segmentTouches(expandRect(frame.region, preCull), endpoints.from, endpoints.to))
        continue;

      const curve = curves?.has(edge.id) ? (curves.get(edge.id) ?? null) : edge.curve;
      const path = resolvePath(edge, curve, rectOf, angleOf, obstacleRects, frame.region, zoom);
      if (!path) continue;

      drawEdge(frame, edge, path, palette, selected.has(edge.id));
    }
  };
}

/**
 * 一条线这一帧要画的路径。
 *
 * 返回 `null` = 这一帧不用管它（脏区之外 / 两端卡片不在场上）。
 *
 * ★ 形状**只问 `edgePolyline`**（`03` 的"单一来源"约定）：命中 / 框选 / 导出
 *   问的是同一个函数。这里自己再判一次 `routing === 'smart'` 拼一遍路由的话，
 *   将来只在 `edgePolyline` 里改一句（比如给走线加圆角），画布上就会
 *   与"点下去选中的那条线"错开。
 * ★ 障碍表以**函数**形式递进去（见 `ObstacleSource`）：只有真的走到 smart 分支
 *   才会建表，全是 free 连线的板子一帧都不付这份钱。
 */
function resolvePath(
  edge: Edge,
  curve: EdgeCurve | null | undefined,
  rectOf: RectLookup,
  angleOf: AngleLookup,
  obstacleRects: () => readonly Rect[],
  region: Rect,
  zoom: number,
): EdgePath | null {
  const path = edgePolyline(edge, {
    rectOf,
    angleOf,
    curve,
    obstacles: obstacleRects,
  });
  if (!path) return null;
  // ★ 精筛：把标签可能伸出的那一圈也算进包围盒，否则标签会在脏区外"留残影"
  const bounds = expandRect(pathBounds(path), LABEL_REACH / zoom);
  return rectsIntersect(bounds, region) ? path : null;
}

/**
 * id → 世界矩形。先建表再查：`cards.find` 在每条线上都跑一遍是 O(n×m)
 *
 * ★ **分栏也进这张表**（`O21`）：连线的两端在几何上完全同构，只是一个是卡、一个是栏。
 *   不并进来的话，指向分栏的线会在 `edgeEndpoints` 里取不到矩形，
 *   于是**整条线一个字都不画** —— 数据里有、画布上没有，是最难自查的一种"坏了"。
 * ★ 分栏的几何走 `columnRect`（**折叠态用显示高度**，40px 的标题条）：与命中测试、
 *   锚点用同一份高度。这里若图省事写 `column.height`，收起的栏会连着线一起
 *   沉到一个看不见的空盒子底部。
 * ★ 覆盖表（拖动中的临时矩形）**最后**写入，因此拖栏时栏自己的预览矩形也在其中，
 *   线会跟着手走，而不是等松手才"啪"地跳过去。
 */
function createRectLookup(
  board: BoardFile,
  override: ReadonlyMap<string, Rect> | null,
): RectLookup {
  const rects = new Map<string, Rect>();
  for (const card of board.cards) {
    // ★ 高度走 `cardDisplayHeight`（`O31` 修复）：**收起的卡片只有标题行那么高** ——
    //   写 `card.height` 的话，收起后线头会留在"卡片原来那么高"的位置上，
    //   而且模型没变 ⇒ 那根线**永远不跟着刷新**（正是用户报的那两个现象）。
    rects.set(card.id, {
      x: card.x,
      y: card.y,
      width: card.width,
      height: cardDisplayHeight(card),
    });
  }
  for (const column of board.columns) rects.set(column.id, columnRect(column));
  // 拖动中的卡片 / 分栏以临时矩形为准（覆盖而不是替换：没被拖的照旧从模型取）
  if (override) {
    for (const [id, rect] of override) rects.set(id, rect);
  }
  return (cardId) => rects.get(cardId) ?? null;
}

/**
 * id → 旋转角（度）。缺席 = `0`（T7.06）。
 *
 * ★ 与 `createRectLookup` 同构，只是查的是角度：都先建表再查，
 *   理由是同一个（每条线都 `cards.find` 一遍是 O(n×m)）。
 * ★ 只把**转过的**卡片放进表：没转的卡片查不到就是 `0`，正是我们要的默认值 ——
 *   1000 张卡的表里少掉 980 个 `0`，锚点计算也少 980 次 `rotatePoint` 早退。
 */
function createAngleLookup(
  board: BoardFile,
  override: ReadonlyMap<string, number> | null,
): AngleLookup {
  const angles = new Map<string, number>();
  for (const card of board.cards) {
    if (card.rotation) angles.set(card.id, card.rotation);
  }
  if (override) {
    for (const [id, degrees] of override) angles.set(id, degrees);
  }
  return (cardId) => angles.get(cardId) ?? 0;
}

/** 线段包围盒是否与本帧脏区相交（脏区重绘的裁剪判据） */
function segmentTouches(region: Rect, a: Point, b: Point): boolean {
  const minX = Math.min(a.x, b.x);
  const maxX = Math.max(a.x, b.x);
  const minY = Math.min(a.y, b.y);
  const maxY = Math.max(a.y, b.y);
  return (
    maxX >= region.x &&
    minX <= region.x + region.width &&
    maxY >= region.y &&
    minY <= region.y + region.height
  );
}

/**
 * 画一条线。
 *
 * `widthScale` 是"世界单位 → 屏幕像素"的反算因子：屏幕宽度为 `s` 时，
 * 世界坐标里要写 `s / zoom`。所有随线宽走的尺寸（箭头、虚线节奏）都用它换算，
 * 否则缩小时箭头会相对变大、虚线会挤成实线。
 */
function drawEdge(
  frame: EdgeFrame,
  edge: Edge,
  path: EdgePath,
  palette: EdgePalette,
  selected: boolean,
): void {
  const ctx = frame.ctx;
  const zoom = frame.zoom > 0 ? frame.zoom : 1;
  const points = path.points;

  const color = selected ? palette.selected : resolveEdgeColor(edge.color, palette);
  const screenWidth = Math.max(
    MIN_SCREEN_WIDTH,
    BASE_LINE_WIDTH * (selected ? SELECTED_WIDTH_FACTOR : 1) * Math.max(1, zoom),
  );
  const worldWidth = screenWidth / zoom;
  const arrowLength = (ARROW_LENGTH * (selected ? 1.2 : 1)) / zoom;

  // 端点处的**切线**方向：折线与弧线都取首段 / 末段的方向。
  // ★ 不能再用"两端相连的那个方向"：弧线的端点切线不指向另一端，
  //   用它收缩会让箭头与线错开一个小小的夹角（近看就是箭头歪了）
  const { from: startDir, to: endDir } = polylineEndDirections(points);

  // 端点收缩：箭头压在卡片描边上会和卡片框糊在一起
  const shrink = Math.min(arrowLength, polylineLength(points) / 3);
  let line = points;
  if (edge.fromEnd === 'arrow') line = shrinkPolylineEnd(line, 'from', shrink, startDir);
  if (edge.toEnd === 'arrow') line = shrinkPolylineEnd(line, 'to', shrink, endDir);

  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = worldWidth;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (edge.style === 'dashed') ctx.setLineDash(EDGE_DASH.map((value) => value / zoom));

  tracePath(ctx, path.kind, line);
  ctx.stroke();

  // ★ 必须复位：虚线状态会留在 ctx 上，后面画的每条线都会跟着变成虚线
  ctx.setLineDash([]);

  if (edge.toEnd === 'arrow') {
    // ★ `drawArrowHead` 的 `dir` 是"从线指向尖端"（= 朝卡片外），而 `endDir` 指路径内部，
    //   所以要取反。不取反的话箭头会以尖端为轴朝回线里 —— 一眼就是"箭头装反了"
    drawArrowHead(ctx, points[points.length - 1], -endDir.x, -endDir.y, arrowLength);
  }
  if (edge.fromEnd === 'arrow') {
    drawArrowHead(ctx, points[0], -startDir.x, -startDir.y, arrowLength);
  }
  ctx.restore();

  if (edge.label) {
    drawEdgeLabel(frame, edge.label, path, palette, color);
  }
}

/**
 * 把路径铺到 ctx 上。
 *
 * ★ 形状由 `kind` 决定，**不按点数猜**：正交走线（T7.11）也可能正好 3 个点，
 *   按点数判会把一个直角弯画成一段圆弧。
 */
function tracePath(
  ctx: CanvasRenderingContext2D,
  kind: EdgePath['kind'],
  points: readonly Point[],
): void {
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  if (kind === 'curve') {
    ctx.quadraticCurveTo(points[1].x, points[1].y, points[2].x, points[2].y);
    return;
  }
  for (let index = 1; index < points.length; index++) {
    ctx.lineTo(points[index].x, points[index].y);
  }
}

/** 箭头：尖端落在锚点上，两翼往回张开（`dir` 是"从线指向尖端"的单位向量） */
function drawArrowHead(
  ctx: CanvasRenderingContext2D,
  tip: Point,
  dirX: number,
  dirY: number,
  length: number,
): void {
  const half = length * 0.45;
  // 垂直向量 = 方向向量旋转 90°
  const px = -dirY;
  const py = dirX;
  const baseX = tip.x - dirX * length;
  const baseY = tip.y - dirY * length;

  ctx.beginPath();
  ctx.moveTo(tip.x, tip.y);
  ctx.lineTo(baseX + px * half, baseY + py * half);
  ctx.lineTo(baseX - px * half, baseY - py * half);
  ctx.closePath();
  ctx.fill();
}

/**
 * 标签（T7.13 / `F3-06`）：画在路径中点上，垫一块与画布同色的圆角底。
 *
 * ★ 落点用 `edgePathMidpoint` —— 曲线与弧度手柄是**同一个点**，而 Smart 走线按
 *   折线长度取中点（见该函数的注释：折线没有"参数 t"）。
 * ★ 超长截断而不是换行：连线的标签是"给这条线起个号"，一行读得完才有意义；
 *   换行会让标签块变成一块方砖，压住线的一大截。
 */
function drawEdgeLabel(
  frame: EdgeFrame,
  label: string,
  path: EdgePath,
  palette: EdgePalette,
  color: string,
): void {
  const ctx = frame.ctx;
  const zoom = frame.zoom > 0 ? frame.zoom : 1;
  const anchor = edgePathMidpoint(path);

  ctx.save();
  ctx.font = `${LABEL_FONT_SIZE}px ${palette.font}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const text = fitLabel(ctx, label, LABEL_MAX_WIDTH);
  const textWidth = ctx.measureText(text).width;
  const width = (textWidth + LABEL_PADDING_X * 2) / zoom;
  const height = (LABEL_FONT_SIZE + LABEL_PADDING_Y * 2) / zoom;
  const radius = LABEL_RADIUS / zoom;

  ctx.fillStyle = palette.labelBackground;
  roundedRect(
    ctx,
    anchor.x - width / 2,
    anchor.y - height / 2,
    width,
    height,
    Math.min(radius, width / 2, height / 2),
  );
  ctx.fill();

  ctx.fillStyle = color;
  ctx.fillText(text, anchor.x, anchor.y);
  ctx.restore();
}

/** 量不下就截断加省略号（二分找断点：逐字量在超长标签上是 O(n) 次 `measureText`） */
function fitLabel(ctx: CanvasRenderingContext2D, label: string, maxWidth: number): string {
  if (ctx.measureText(label).width <= maxWidth) return label;
  const chars = [...label];
  let low = 0;
  let high = chars.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (ctx.measureText(`${chars.slice(0, mid).join('')}…`).width <= maxWidth) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return low <= 0 ? '…' : `${chars.slice(0, low).join('')}…`;
}

/** 圆角矩形（不依赖 `ctx.roundRect`：它在个别运行环境里还没有） */
function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.arcTo(x + width, y, x + width, y + radius, radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.arcTo(x + width, y + height, x + width - radius, y + height, radius);
  ctx.lineTo(x + radius, y + height);
  ctx.arcTo(x, y + height, x, y + height - radius, radius);
  ctx.lineTo(x, y + radius);
  ctx.arcTo(x, y, x + radius, y, radius);
  ctx.closePath();
}

/** 主题色 → 计算后的色值；自定义 HEX 直接用（非法值回落到次要色，绝不产出坏 CSS） */
function resolveEdgeColor(color: CardColor, palette: EdgePalette): string {
  if (isThemeColor(color)) return palette.theme[color] || palette.fallback;
  return normalizeHex(color) ?? palette.fallback;
}
