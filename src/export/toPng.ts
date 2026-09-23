/**
 * 导出 PNG（T2.11 / `F9-02`）—— 把画布**画进 Canvas**，再落成图片文件。
 *
 * ── 为什么是"自己画"而不是截图 ────────────────────────────────
 *
 * `F9-02` 的验收点是「分页 tile（避免单页被缩成一小块）或单页全景」，这就意味着
 * 导出物必须能在**任意倍率**下重画同一块白板。DOM 截图（`html2canvas` 一类）做不到
 * 这一点：它只能按当前屏幕像素拍一张，放大就糊，而且会引入第三方运行时依赖 ——
 * 而本插件承诺零运行时依赖（`03 §7.2`）。
 *
 * 于是这里走"**模型 → Canvas**"这条路：几何全部来自 `.nboard`，绘制是一组纯函数式
 * 的 Canvas 调用。它带来三个好处：
 *   1. 倍率、分页、背景透明都只是在**同一份几何**上换参数，不存在"放大后糊掉"；
 *   2. 绘制不依赖 DOM 尺寸，`export/` 的单测可以在 node 下用假的 ctx 跑（本项目无 canvas 依赖）；
 *   3. 将来的 PDF（T4.10）与 SVG（T6.01）可以复用同一套分页与几何。
 *
 * ── 两条边界 ──────────────────────────────────────────────
 *
 *  * **只读出几何，不 import 视图层**。分栏高度、连线锚点都由 `model/` 提供
 *    （`columnDisplayHeight` / `edgePolyline`），否则导出结果会和画布上看到的
 *    对不上 —— 那是最难查的一类 bug。
 *  * **本文件不碰 `document`**。`renderTile()` 收的是一个已经建好的 2D 上下文，
 *    所以它在 node 单测里可跑；真正 `createElement('canvas')` 的地方在视图层。
 */

import { cardIconOf } from '../cards/cardIcon';
import { columnDisplayHeight } from '../model/columns';
import { IDENTITY_CROP, clampCrop } from '../model/crop';
// 白板级脑图（`2.2.0` 批 4）：导出这一侧**自己再画一遍**（canvas 读不到 DOM 样式），
// 但几何与配色**全部复用**脑图那套纯函数 —— 布局（`layoutMind`）、连线路径
// （`edgePathOf` 等给的 SVG 路径字符串）、配色（`mindPaletteOf` 给的是**十六进制**，
// 正是 canvas 需要的形状）。所以"导出里的树"与"屏幕上的树"是同一份几何，
// 只有字号 / 内边距这类观感是这边独立写死的（与 `drawCards` 同一条纪律）。
import { mindBounds, mindNodeRects, mindPlacement } from '../mind/embed/boardGeometry';
import { childSideOf, edgePathOf, edgeTrunkPathOf } from '../mind/layout/edges';
import type { MindLayout } from '../mind/layout/tree';
import { MIND_DEEP_DEPTH, mindPaletteOf, titleBoldOf, titleSizeOf } from '../mind/model/palette';
// 标题的行高与折行**与布局估算共用**：写死一份的话，"盒子按 3 行留了高度、
// 画出来只有 1 行"就会以"标题悬在盒子上半截"的样子冒出来
import {
  MIND_BODY_LINE_HEIGHT,
  MIND_CHAR_WIDTH_RATIO,
  MIND_NODE_INNER_GAP,
  titleLineHeightFor,
  wrapNodeNote,
  wrapNodeTitle,
} from '../mind/layout/measure';
// 完成态那一支（`N3-g`）：与画布 / SVG 导出共用同一份判断
import { dimmedByDoneAncestor } from '../mind/model/ops';
import { firstRefOf, refLabelOf } from '../mind/model/refs';
import type { MindFile } from '../mind/model/schema';
import {
  edgePathMidpoint,
  edgePolyline,
  obstacleRects,
  pathBounds,
  polylineEndDirections,
  polylineLength,
  shrinkPolylineEnd,
  type AngleLookup,
  type EdgePath,
} from '../model/edges';
import type {
  BoardBackground,
  BoardFile,
  Card,
  CardColor,
  Column,
  ImageCrop,
  ImageFit,
  Mind,
  ThemeColor,
} from '../model/schema';
import { isThemeColor, nodeEndpointKey } from '../model/schema';
import { THEME_COLOR_VAR, normalizeHex, swatchEntryToText, swatchInkColor } from '../util/color';
import {
  boundsOf,
  clamp,
  expandRect,
  rectCenter,
  rotatedBoundsOf,
  type Rect,
} from '../util/geometry';
import { t } from '../util/i18n';

// ─────────────────────────────────────────────────────────────
// 导出选项
// ─────────────────────────────────────────────────────────────

/** 导出范围（T2.11 的"范围"）：整块板 / 当前视口 / 当前选中 */
export type PngRange = 'all' | 'viewport' | 'selection';

/**
 * 倍率下限固定为 1：PNG 是位图，缩到 1 以下等于把内容画小、再让用户放大看，
 * 没有意义（要小尺寸的图，用户真正想的是"少画点内容"，那是范围的事）。
 */
export const PNG_SCALE_MIN = 1;
export const PNG_SCALE_MAX = 4;
export const DEFAULT_PNG_SCALE = 2;

/** 单块 tile 的目标像素边长：4096 在"够大"与"内存可控"之间（4K 屏一屏有余） */
export const DEFAULT_PNG_TILE_SIZE = 4096;

/** 内容四周留白（世界坐标 px）：图不留白会显得内容顶到边上，像被裁过 */
export const DEFAULT_PNG_PADDING = 32;

/**
 * 单张 canvas 的**硬上限**（像素边长）。
 *
 * 超过它，多数内核要么给一张全白画布、要么直接抛错。单页全景模式必须用它反过来
 * 压倍率 —— 否则用户选"全景 + 4x"时拿到的是一张空白图，而没人会觉得那是
 * "你的板子太大了"。
 */
export const HARD_MAX_CANVAS_SIDE = 8192;

export interface PngExportOptions {
  /** 范围，默认 `'all'` */
  range?: PngRange;
  /** 倍率（1–4），默认 2 */
  scale?: number;
  /** 背景透明（不铺底色与点阵/网格），默认 `false` */
  transparent?: boolean;
  /** 分页 tile，默认 `true`；`false` = 单页全景 */
  paginate?: boolean;
  /** 单块 tile 的目标像素边长，默认 {@link DEFAULT_PNG_TILE_SIZE} */
  maxTileSize?: number;
  /** 四周留白（世界坐标 px），默认 {@link DEFAULT_PNG_PADDING} */
  padding?: number;
  /**
   * **文件脑图**的模型（`2.2.0` 批 4），键是脑图 id —— **取景**这一层要它。
   *
   * ★ 脑图在模型里**没有尺寸**（无边界），能占多大地方只能靠布局现算 ⇒
   *   取景（这里）与绘制（{@link PngRenderOptions.mindModels}）必须用**同一份**模型，
   *   否则会出现"导出图把树裁掉一半"或"框留够了、树画在框外"。
   * ★ 缺席 = 那些树不参与取景（也不会被画出来）。
   */
  mindModels?: ReadonlyMap<string, MindFile>;
}

/**
 * 「求导出边界」真正需要的两个字段。
 *
 * ★ 从 `PngExportOptions` 里**挑出来**而不是直接用它，是为了让 SVG 导出
 *   （`toSvg.ts`）能原样复用 `resolveExportBounds` —— 它的选项里没有
 *   `scale` / `paginate` 这些位图概念，硬转成一个带这些字段的类型会说谎。
 * ★ 结构子类型：`PngExportOptions` / `PdfExportOptions` / `SvgExportOptions`
 *   都能直接传进来，调用方一个字都不用改。
 */
export type ExportBoundsOptions = Pick<PngExportOptions, 'range' | 'padding' | 'mindModels'>;

/** 一块导出区域（世界坐标，已对齐到整数像素） */
export interface PngTile extends Rect {
  /** 在页序中的下标（从 0 起） */
  index: number;
  /** 该 tile 所在的列 / 行（从 0 起），用于提示"第几块" */
  column: number;
  row: number;
}

export interface PngPlan {
  /** 含留白的导出边界（世界坐标） */
  bounds: Rect;
  /** **实际**使用的倍率（单页全景可能被硬上限压低，所以与请求值未必相同） */
  scale: number;
  tiles: PngTile[];
  columns: number;
  rows: number;
}

// ─────────────────────────────────────────────────────────────
// 几何（纯逻辑）
// ─────────────────────────────────────────────────────────────

export function rectOfCard(card: Pick<Card, 'x' | 'y' | 'width' | 'height'>): Rect {
  return { x: card.x, y: card.y, width: card.width, height: card.height };
}

/**
 * 卡片在导出结果里**占的那块地方**：{@link rectOfCard} 再套一层旋转外接框（T7.06）。
 *
 * ★ 裁剪判定、取景边界都要用它；画的时候用 `rectOfCard`（绘制内部自己转）。
 *   `deg === 0` 时两者逐字段相同，于是对存量白板零影响。
 */
export function boundsOfCard(card: Card): Rect {
  return rotatedBoundsOf(rectOfCard(card), card.rotation ?? 0);
}

/**
 * 把上下文转到卡片的坐标系里（T7.06）：绕**卡片中心**旋转 `deg` 度。
 *
 * ★ 调用方保证已经 `save()` 过（`drawCards` 每个卡片一次），`deg === 0` 时不动手 ——
 *   给没转过的卡片插一次 `translate/rotate/translate` 是白算三次矩阵乘法。
 * ★ y 向下，所以**正角度在画布上就是顺时针**，与 `normalizeAngle` / CSS 的约定一致
 *   （`Math.rotate` 的正方向本来就是"x 轴转向 y 轴"，而这里的 y 轴朝下）。
 */
function applyCardRotation(ctx: CanvasRenderingContext2D, rect: Rect, deg: number): void {
  if (deg === 0) return;
  const center = rectCenter(rect);
  ctx.translate(center.x, center.y);
  ctx.rotate((deg * Math.PI) / 180);
  ctx.translate(-center.x, -center.y);
}

/** 分栏矩形：折叠态用**显示高度** —— 命中与绘制都必须和用户看到的一致 */
export function rectOfColumn(column: Column): Rect {
  return {
    x: column.x,
    y: column.y,
    width: column.width,
    height: columnDisplayHeight(column),
  };
}

/** 四周外扩留白（负数按 0 处理：负留白会把边界反过来收缩成负尺寸） */
function padRect(rect: Rect, padding: number): Rect {
  const pad = Number.isFinite(padding) && padding > 0 ? padding : 0;
  return expandRect(rect, pad);
}

/**
 * 整块白板的内容边界：**卡片 + 分栏**的并集（空板返回 `null`）。
 *
 * ★ 分栏必须算进去：一个空分栏也是用户摆好的结构，导出时把它裁掉，
 *   用户会以为"分栏没导出来"。
 * ★ 卡片按**外接框**算（T7.06）：转 45° 的卡片比它的 `width/height` 高出小半张，
 *   按布局框取边界会把它的四个角裁掉（`boundsOfCard` 在 0° 时为原矩形）。
 */
export function boardContentBounds(
  board: BoardFile,
  mindModels?: ReadonlyMap<string, MindFile>,
): Rect | null {
  const partOfMinds = mindsOfBoard(board, mindModels);
  const parts: Rect[] = [...board.cards.map(boundsOfCard), ...board.columns.map(rectOfColumn)];
  // ★ 脑图也要算进来（`2.2.0` 批 4）：它从前是一张卡、现在是一个**没有尺寸**的容器
  //   —— 不补这一笔，一棵长在边上的树会被裁掉一半；再极端一点（一块只有脑图的板子），
  //   导出会直接说"没有内容可导"。
  for (const mind of partOfMinds) parts.push(mind.rect);

  // ★ 连线也会伸到卡片之外（T7.11 的智能绕行绕出 `ROUTE_MARGIN`、T7.12 的弧线控制点
  //   最远能偏到 4 倍弦长），不把它们算进来的话，导出图上那条弯会被裁掉一截 ——
  //   而"我明明画了个弧，导出变直了/缺了一块"是最难被归因的一类反馈。
  // ★ 只有**真的有**边、且那条边的路径确实在卡片框之外的板子上才会多出这一轮计算。
  if (board.edges.length > 0) {
    const rects = new Map<string, Rect>();
    const angles = new Map<string, number>();
    for (const card of board.cards) {
      rects.set(card.id, rectOfCard(card));
      if (card.rotation) angles.set(card.id, card.rotation);
    }
    // ★ 分栏也是端点（`O21`）：不并进这张表，指向栏的线在导出物里会**整条消失**
    for (const column of board.columns) rects.set(column.id, rectOfColumn(column));
    // ★ 脑图的**节点**也是端点（`2.2.0` 批 3）：同上 —— 少这一笔，指着节点的线会消失
    for (const mind of partOfMinds) {
      for (const [key, rect] of mind.nodes) rects.set(key, rect);
    }
    const rectOf = (cardId: string): Rect | null => rects.get(cardId) ?? null;
    const angleOf: AngleLookup = (cardId) => angles.get(cardId) ?? 0;
    const obstacles = board.edges.some((edge) => edge.routing === 'smart')
      ? obstacleRects(
          board.cards.map((card) => card.id),
          rectOf,
        )
      : [];
    for (const edge of board.edges) {
      const path = edgePolyline(edge, { rectOf, angleOf, obstacles });
      if (!path) continue;
      // 带标签的线还要给标签块留地方：它就压在路径中点上、从路径向两侧伸出去。
      // 不扩的话，最边上那条线的标签会被裁掉半边（另一半还在，看着更像画错了）
      const reach = edge.label.length > 0 ? EDGE_LABEL_HALF_WIDTH : 0;
      parts.push(expandRect(pathBounds(path), reach));
    }
  }

  return boundsOf(parts);
}

/**
 * 每棵**要画的**脑图在板子上占的地方 + 它每个节点的矩形（`2.2.0` 批 4）。
 *
 * ★ 取景（`boardContentBounds`）与绘制（`drawMinds` / `drawEdges`）**共用这一份**：
 *   各算一次布局的话，导出图上会出现"树的框留够了、节点却画在框外"。
 */
function mindsOfBoard(
  board: BoardFile,
  mindModels?: ReadonlyMap<string, MindFile>,
): Array<{ mind: Mind; rect: Rect; nodes: Map<string, Rect> }> {
  return planMinds(board, mindModels).map((plan) => {
    const place = { file: plan.file, layout: plan.layout, dx: plan.dx, dy: plan.dy };
    const nodes = new Map<string, Rect>();
    // ★ 键与画布上连线的端点表**同形**（`nodeEndpointKey`）：那一侧查表查的是同一个串
    for (const [nodeId, rect] of mindNodeRects(place)) {
      nodes.set(nodeEndpointKey(plan.mind.id, nodeId), rect);
    }
    return {
      mind: plan.mind,
      // 布局算不出外接框（空模型）时退化成"没有面积"：它本来也没什么可框的
      rect: mindBounds(place) ?? { x: plan.mind.x, y: plan.mind.y, width: 0, height: 0 },
      nodes,
    };
  });
}

export interface PngBoundsContext {
  /** 当前视口对应的世界矩形（`range: 'viewport'` 用）；不传则该范围退化为整块板 */
  viewportRect?: Rect | null;
  /** 当前选中的卡片 / 分栏 / **脑图** id（`range: 'selection'` 用） */
  selection?: ReadonlySet<string>;
}

/**
 * 按范围求导出边界。
 *
 * ★ 「选区为空」与「视口未提供」都**退化为整块板**而不是报错：用户选了"仅选中"
 *   但手滑取消了选区时，导出一张整板图远比弹一句"没有选中任何东西"有用。
 */
export function resolveExportBounds(
  board: BoardFile,
  options: ExportBoundsOptions,
  context: PngBoundsContext = {},
): Rect | null {
  const range = options.range ?? 'all';
  const padding = options.padding ?? DEFAULT_PNG_PADDING;

  if (range === 'viewport' && context.viewportRect) {
    return context.viewportRect;
  }

  if (range === 'selection' && context.selection && context.selection.size > 0) {
    const selection = context.selection;
    // 外接框：选中的卡片转过时，导出要把转出来的那部分一起框进去（T7.06）
    const picked = boundsOf([
      ...board.cards.filter((card) => selection.has(card.id)).map(boundsOfCard),
      ...board.columns.filter((column) => selection.has(column.id)).map(rectOfColumn),
      // ★ 脑图（`2.2.0` 批 5）：它没有尺寸字段，外接框要向布局**现问** ——
      //   与"取景"（`boardContentBounds`）走的是同一份 `mindsOfBoard`，
      //   于是"框住哪几棵树就导出哪几棵"与整板导出的取景口径完全一致。
      ...mindsOfBoard(board, options.mindModels)
        .filter((item) => selection.has(item.mind.id))
        .map((item) => item.rect),
    ]);
    if (picked) return padRect(picked, padding);
  }

  const bounds = boardContentBounds(board, options.mindModels);
  return bounds ? padRect(bounds, padding) : null;
}

/** 向外对齐到整数世界像素：多画一格不会露缝，少画一格会 |
 * （tile 之间必须**重叠或严丝合缝**，"差 1px"的缝在导出图上是一道白线）
 *
 * 导出 PDF 的分页（`export/toPdf.ts`）同样走这条规则 —— 拼接的产物不能有缝，
 * 这是"两种导出"共用的几何前提，所以放在这里复用而不是各写一份。 */
export function alignTile(rect: Rect): Rect {
  const x = Math.floor(rect.x);
  const y = Math.floor(rect.y);
  const right = Math.ceil(rect.x + rect.width);
  const bottom = Math.ceil(rect.y + rect.height);
  return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) };
}

/**
 * 规划导出：算实际倍率与全部 tile。
 *
 * 分页的切法是**网格切**（先左右后上下），不是按内容分组：`F9-02` 要解决的是
 * "整板缩成一小块"，网格切对任意排布都成立，而按内容切要对每块板猜一次怎么分组。
 *
 * 边界用 `floor` / `ceil` 向外取整：相邻 tile 会重叠 1px，而重叠在拼图时只是多一层
 * 完全相同的像素（看不出来）；反过来留缝就是一道白线，非常显眼。
 */
export function planPngExport(bounds: Rect | null, options: PngExportOptions = {}): PngPlan {
  const requested = clamp(options.scale ?? DEFAULT_PNG_SCALE, PNG_SCALE_MIN, PNG_SCALE_MAX);
  const empty: PngPlan = {
    bounds: { x: 0, y: 0, width: 0, height: 0 },
    scale: requested,
    tiles: [],
    columns: 0,
    rows: 0,
  };
  if (!bounds || bounds.width <= 0 || bounds.height <= 0) return empty;

  const maxTile =
    Number.isFinite(options.maxTileSize) && (options.maxTileSize ?? 0) > 0
      ? (options.maxTileSize as number)
      : DEFAULT_PNG_TILE_SIZE;

  // 单页全景：不切片，但必须保证不比 canvas 硬上限还大
  if (options.paginate === false) {
    const side = Math.max(bounds.width, bounds.height);
    const fit = side > 0 ? HARD_MAX_CANVAS_SIDE / side : requested;
    const scale = clamp(Math.min(requested, fit), 0.05, PNG_SCALE_MAX);
    const tile = alignTile(bounds);
    return {
      bounds,
      scale,
      tiles: [{ ...tile, index: 0, column: 0, row: 0 }],
      columns: 1,
      rows: 1,
    };
  }

  // 分页：每块的世界边长由"目标像素边长 ÷ 倍率"反算
  const world = maxTile / requested;
  const columns = Math.max(1, Math.ceil(bounds.width / world));
  const rows = Math.max(1, Math.ceil(bounds.height / world));

  const tiles: PngTile[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const slice: Rect = {
        x: bounds.x + column * world,
        y: bounds.y + row * world,
        width: Math.min(world, bounds.x + bounds.width - (bounds.x + column * world)),
        height: Math.min(world, bounds.y + bounds.height - (bounds.y + row * world)),
      };
      const aligned = alignTile(slice);
      tiles.push({ ...aligned, index: tiles.length, column, row });
    }
  }

  return { bounds, scale: requested, tiles, columns, rows };
}

// ─────────────────────────────────────────────────────────────
// 落盘（窄接口 + 命名）
// ─────────────────────────────────────────────────────────────

/** 二进制写入口（生产实现：`io/vaultIO.ts`） */
export interface PngExportSink {
  exists(path: string): Promise<boolean>;
  createBinary(path: string, data: ArrayBuffer): Promise<void>;
}

export interface PngExportTarget {
  /** Vault 相对目录（`''` = 根目录） */
  folder: string;
  /** 不含扩展名的文件名（调用方已做过非法字符清理） */
  name: string;
}

/**
 * 单张 / 多张导出时的文件名（不含目录）。
 *
 * 多张时按 `名字 1.png` / `名字 2.png` 编号：一块板导出十几张图时，
 * 没有编号的散图在文件列表里就是一团没法对应回画布位置的碎片。
 */
export function pngFileName(name: string, index: number, total: number): string {
  return total > 1 ? `${name} ${index + 1}.png` : `${name}.png`;
}

/**
 * 顺延取名：`名字.ext` 已被占用时依次试 `名字 2.ext`、`名字 3.ext`……
 *
 * ★ 三种导出（PNG / SVG / ZIP）共用同一条规矩：覆盖是**不可逆**的
 *   （二进制产物认不出"这是不是我们上次导出的"），而顺延只是多出一个文件
 *   —— 一眼可见、随手可删。
 * ★ `fileName` 连扩展名一起给：编号要插在扩展名**前面**，否则 `白板.png 2` 这样的
 *   名字在很多查看器里会被当成"没有扩展名"。
 * ★ 上限 1000 只为防死循环（正常情况下永远走不到）。
 */
export async function uniqueExportPath(
  sink: Pick<PngExportSink, 'exists'>,
  prefix: string,
  fileName: string,
): Promise<string> {
  const dot = fileName.lastIndexOf('.');
  const base = dot > 0 ? fileName.slice(0, dot) : fileName;
  const extension = dot > 0 ? fileName.slice(dot) : '';

  let candidate = `${prefix}${fileName}`;
  let index = 2;
  while (index < 1000 && (await sink.exists(candidate))) {
    candidate = `${prefix}${base} ${index}${extension}`;
    index += 1;
  }
  return candidate;
}

/**
 * 把若干张 PNG 二进制写进 Vault，返回实际落盘路径。
 *
 * ★ **不做"覆盖上次导出"**（与 `MarkdownExporter` 的指纹策略不同）：PNG 是无结构的
 *   二进制，认不出"这张图是不是我们上次导出的"，误判就会覆盖用户的图片。所以这里
 *   一律顺延命名（`名字.png` → `名字 2.png` → …），代价是多出几个文件，而不是
 *   可能的**覆盖掉别人的图** —— 后者是不可逆的。
 */
export class PngExporter {
  constructor(private readonly sink: PngExportSink) {}

  async export(images: readonly ArrayBuffer[], target: PngExportTarget): Promise<string[]> {
    if (images.length === 0) return [];
    const prefix = target.folder.length > 0 ? `${target.folder.replace(/\/+$/, '')}/` : '';
    const paths: string[] = [];

    for (let index = 0; index < images.length; index += 1) {
      const name = pngFileName(target.name, index, images.length);
      const path = await uniqueExportPath(this.sink, prefix, name);
      await this.sink.createBinary(path, images[index]);
      paths.push(path);
    }
    return paths;
  }
}

/**
 * canvas → PNG 二进制。
 *
 * 走 `toBlob` 而不是 `toDataURL`：后者会先生成一个 base64 字符串（体积 ×1.37，
 * 且会被完整复制一次），4K 级导出时是实打实的内存峰值。
 */
export function canvasToArrayBuffer(canvas: HTMLCanvasElement): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('nestboard: canvas could not be encoded as PNG'));
        return;
      }
      blob.arrayBuffer().then(resolve, reject);
    }, 'image/png');
  });
}

// ─────────────────────────────────────────────────────────────
// 卡片预览文本（纯逻辑，绘制与单测共用）
// ─────────────────────────────────────────────────────────────

export interface CardPreview {
  /** 卡片标题行之外的一行说明（描述 / 路径 / 计数） */
  label: string;
  /** 正文行（已按行切开，绘制时逐行裁切） */
  lines: string[];
}

/**
 * 从卡片内容提取"图上要画什么字"。
 *
 * 这里**不追求还原 DOM 上的富文本**：PNG 里最要紧的是"这张卡上写着什么"，
 * 而 Markdown 语法标记（`#`、`**`）在图片里只是噪音，所以按行原样输出、
 * 由绘制器做视觉裁切。
 *
 * `switch` 穷举 + `assertNever`：将来新增卡片类型时，这里编译不过 ——
 * 而不是在新类型上静默画出一张空白卡。
 */
export function cardPreview(card: Card): CardPreview {
  switch (card.type) {
    case 'note':
      return { label: '', lines: splitLines(card.content.md) };
    // 同步便签（T7.04）在导出里与便签完全一样：正文都是 `md`，每张各存一份
    case 'syncNote':
      return { label: '', lines: splitLines(card.content.md) };
    // 评论卡（T7.05）：一条一行，顺序就是时间顺序。
    // "已解决"放在标题行上 —— PNG 里没有置灰的余地，只写得出这几个字
    case 'comment':
      return {
        label: card.content.resolved ? t('card.comment.resolved') : '',
        lines: card.content.entries.map((entry) => entry.text),
      };
    case 'noteRef':
      return {
        label: `${card.content.path}${card.content.subpath ?? ''}`,
        lines: [],
      };
    case 'image':
      return { label: card.content.caption || card.content.path, lines: [] };
    case 'file':
      return { label: card.content.path, lines: [] };
    case 'link':
      return {
        label: card.content.url,
        lines: [card.content.title, card.content.description].filter((line) => line.length > 0),
      };
    case 'todo':
      return {
        label: card.content.title,
        lines: card.content.items.map((item) => `${item.done ? '[x]' : '[ ]'} ${item.text}`),
      };
    case 'swatch':
      // ★ 一格一行，用**文本形态**（`O07`）：纯色就是色号，渐变就是那行 CSS。
      //   于是"色板里写了什么"在 PNG 里仍然可读、可 grep —— 这正是这块卡导出的意义
      return { label: '', lines: card.content.colors.map((entry) => swatchEntryToText(entry)) };
    case 'boardRef':
      return { label: card.content.path, lines: [] };
    // 视频卡（`A1`）：PNG 上贴不了画面，写路径（与白板卡同一条：路径就是它的身份）
    case 'video':
      return { label: card.content.path, lines: [] };
    // 音频卡（`A2`）：同上（静态图里放不出声音）
    case 'audio':
      return { label: card.content.path, lines: [] };
    // 仅标题卡（`A3`）：它就是一行字（那行字 = 卡片标题）—— 图上照旧写出来
    case 'titleCard':
      return { label: card.title, lines: [] };
    // 图集卡（`A4`）：PNG 里贴的是**当前那一张**（与图片卡同一档），
    // 底下那行数字说清"这是第几张 / 共几张"
    case 'gallery':
      return {
        label: card.content.paths[card.content.index ?? 0] ?? '',
        lines: [`${(card.content.index ?? 0) + 1} / ${card.content.paths.length}`],
      };
    case 'ink':
      return { label: t('card.type.ink'), lines: [] };
    // 图上不写字（PNG 里贴的是那张图本身），地点名当标签（同图片卡用说明文字）
    case 'map':
      return { label: card.content.label || card.content.path, lines: [] };
    // PDF 预览卡（`F8`）：PNG 里贴不了 PDF 的内容 ⇒ 贴上**路径**当标签
    // （与文件卡同一条：导出件上至少要看得出"这里原先是什么"）
    case 'pdf':
      return { label: card.content.path, lines: [] };
    // `.canvas` 预览卡（`F6`）：同上
    case 'canvas':
      return { label: card.content.path, lines: [] };
    // 脑图卡（`F3a`）：同上（静态导出里画不了可交互的脑图，写路径当标签）
    case 'mindRef':
      return { label: card.content.path, lines: [] };
    // 内嵌脑图卡（`F4`）：没有路径可写 ⇒ 写**中心主题**那一行（那才是这张卡的名字）
    case 'mind':
      return {
        label:
          card.content.mind.nodes.find((node) => node.id === card.content.mind.rootId)?.text ?? '',
        lines: [],
      };
    default:
      return assertNever(card);
  }
}

function splitLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .filter((line, index, all) => line.length > 0 || index < all.length - 1);
}

// ─────────────────────────────────────────────────────────────
// 深色便签（`O06`）
// ─────────────────────────────────────────────────────────────

/**
 * 深色便签在导出里的三个颜色：底色 / 标题色 / 正文色。
 *
 * ★ 与 `styles.css` 里
 *   `.nestboard-card[data-card-type='note']:has(> .nestboard-card-content.is-dark)`
 *   那一组取**同一份值**：导出图与屏幕上看的不一样是最难被发现的不一致
 *   （用户只会觉得"导出来的图颜色怪怪的"，而说不出哪里怪）。
 * ★ 只有三个颜色。边框与强调条仍然吃卡片自己的颜色 —— 深色只改"这张卡的底是什么颜色"，
 *   不改"这张卡是哪一种颜色"，否则用户给卡片设的色就白设了。
 */
export const NOTE_DARK_FILL = '#1f1f1f';
export const NOTE_DARK_TEXT = '#f5f5f5';
export const NOTE_DARK_MUTED = '#c9c9c9';

/**
 * 浅色便签（`O38` 撞色）在导出里要用的三个颜色，以及标题带的底色。
 *
 * ★ 与 `styles.css` 里 `.nestboard-card[data-card-type='note']` 那一段取**同一份值**：
 *   正文是**白纸**、字是深色（白纸就是白纸，深色主题里也一样）。
 * ★ 标题带的底色**不用常量**：它就是卡片自己的主色（`card.color` 解析出来的 `themeColor`），
 *   与屏幕上那条带同源 —— 写个常量反而会与用户挑的颜色对不上。
 */
export const NOTE_LIGHT_FILL = '#ffffff';
export const NOTE_LIGHT_TEXT = '#1f1f1f';
export const NOTE_LIGHT_MUTED = '#5c5c5c';

/**
 * 这张卡是不是深色便签（`O06`）。
 *
 * ★ 判据**只有这一处**（视图侧则是那条 `is-dark` 类）：写两次必然有一天只改一处。
 * ★ 同步便签（`syncNote`）**不参与**：它的正文是整组共用的，变体属于单张卡的观感，
 *   所以在导出里它和普通便签一样画 —— 与卡片定义那边（不加 `is-dark`）一致。
 */
export function isDarkNoteCard(card: Card): boolean {
  return card.type === 'note' && card.content.variant === 'dark';
}

/**
 * 这张卡要走**撞色便签**那套画法吗（`O38` 的浅色便签）。
 *
 * ★ 与上面那个深色判据成对、同样只写这一处：`note` 且**不是**深色变体。
 *   同步便签（`syncNote`）不参与 —— 屏幕上那条样式规则只认 `data-card-type='note'`，
 *   导出跟着屏幕走（两处不一致正是"导出与画布不一样"的来源）。
 */
export function isLightNoteCard(card: Card): boolean {
  return card.type === 'note' && card.content.variant !== 'dark';
}

function assertNever(value: never): never {
  throw new Error(`nestboard: unhandled card type ${JSON.stringify(value)}`);
}

/**
 * 贪心折行：按**字符**累加，超过宽度就断。
 *
 * 刻意不按单词断行：中文没有词间空格，按词断会把一整句当成一个"词"，
 * 于是一行长到画不下也不换行 —— 中文白板上那是常态。按字符断行对中英文都可接受。
 */
export function wrapText(
  measure: (text: string) => number,
  text: string,
  maxWidth: number,
): string[] {
  if (maxWidth <= 0 || text.length === 0) return [];
  const lines: string[] = [];
  let current = '';
  for (const char of text) {
    const next = current + char;
    if (current.length > 0 && measure(next) > maxWidth) {
      lines.push(current);
      current = char;
    } else {
      current = next;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines;
}

// ─────────────────────────────────────────────────────────────
// 画布绘制
// ─────────────────────────────────────────────────────────────

/** 绘制一帧需要的全部颜色（一帧取一次，不逐卡读 `getComputedStyle`） */
export interface PngPalette {
  background: string;
  /** 交互强调色（`--interactive-accent`）：地图卡图钉用它 —— 与画布上那颗点同源 */
  accent: string;
  pattern: string;
  cardFill: string;
  cardBorder: string;
  cardText: string;
  mutedText: string;
  fontFamily: string;
  theme: Record<ThemeColor, string>;
}

const FALLBACK_COLOR = '#888888';

/**
 * 从画布元素读主题色。
 *
 * Canvas 不认 `var(--color-red)`，所以必须取**计算后**的值 —— 与 `EdgeRenderer`
 * 是同一个坑（那边有同样的注释）。逐帧读一次 `getComputedStyle` 可以接受：
 * 导出是"偶尔按一次"的操作。
 */
export function readPngPalette(element: Element): PngPalette {
  const style = getComputedStyle(element);
  const read = (name: string, fallback: string): string =>
    style.getPropertyValue(name).trim() || fallback;
  const fallback = read('--text-muted', FALLBACK_COLOR);
  const theme = {} as Record<ThemeColor, string>;
  for (const [key, cssVar] of Object.entries(THEME_COLOR_VAR)) {
    theme[key as ThemeColor] = read(cssVar, fallback);
  }
  return {
    background: read('--background-primary', '#ffffff'),
    // 强调色取不到时回落到主题紫（6），至少不会在图上画出一颗看不见的透明点
    accent: read('--interactive-accent', theme['6'] || fallback),
    pattern: read('--background-modifier-border', '#d0d0d0'),
    cardFill: read('--background-secondary', '#f5f5f5'),
    cardBorder: read('--background-modifier-border', '#cccccc'),
    cardText: read('--text-normal', '#222222'),
    mutedText: fallback,
    fontFamily: read('font-family', 'sans-serif'),
    theme,
  };
}

export interface PngRenderOptions {
  /** 实际倍率（来自 {@link planPngExport}） */
  scale: number;
  transparent: boolean;
  /** 白板背景模式（`board.view.background`） */
  background: BoardBackground;
  /** 网格单元格（`board.settings.gridSize`） */
  gridSize: number;
  /** 图片卡的预加载结果：vault 路径 → 已解码图像。缺席时画占位文字 */
  images?: ReadonlyMap<string, CanvasImageSource>;
  palette: PngPalette;
  /** 卡片正文最多画几行，默认 6 */
  maxLines?: number;
  /**
   * **文件脑图**的模型（`2.2.0` 批 4），键是脑图 id。
   *
   * ★ 内嵌脑图的模型就在 `board.minds[].mind` 里（`drawMinds` 自己会读），
   *   只有"指向一份 `.nestmind`"的那些才需要从外面喂进来 —— 那份数据住仓储的内存里，
   *   白板文件本身没有。
   * ★ 缺席 / 某棵树没给 ⇒ 那一棵树这一次导出**不画**（与缩略图同一条口径：
   *   宁可少画一棵，也不要为了它在这里同步等一次读盘）。
   */
  mindModels?: ReadonlyMap<string, MindFile>;
}

/** 卡片标题字号（世界 px） */
const TITLE_FONT_SIZE = 12;
/** 卡片正文字号（世界 px） */
const BODY_FONT_SIZE = 11;
const CARD_PADDING = 8;
const CARD_RADIUS = 8;
const HEADER_HEIGHT = 24;
const ACCENT_WIDTH = 4;
/** 点阵/网格缩小到"画了也是噪点"时停手 */
const MIN_PATTERN_CELL = 4;
/** 图案格数上限：超大画布上逐格画点是 O(格数)，必须有个闸门 */
const MAX_PATTERN_CELLS = 40000;

/**
 * 把一个 tile 画进 `ctx`。
 *
 * `ctx` 必须是一个**尺寸等于 `tile.width × scale` / `tile.height × scale`** 的上下文；
 * 内部会自己 `setTransform` 把世界坐标映射过来，所以调用方不必（也不该）先 translate。
 */
export function renderTile(
  ctx: CanvasRenderingContext2D,
  board: BoardFile,
  tile: PngTile,
  options: PngRenderOptions,
): void {
  const { scale } = options;
  const width = Math.max(1, Math.round(tile.width * scale));
  const height = Math.max(1, Math.round(tile.height * scale));

  ctx.save();
  // 裁剪用**设备像素**：它在此时的世界变换（单位阵）下建立，之后 `setTransform` 不会动它
  ctx.beginPath();
  ctx.rect(0, 0, width, height);
  ctx.clip();
  ctx.setTransform(scale, 0, 0, scale, -tile.x * scale, -tile.y * scale);

  drawBackground(ctx, board, tile, options);
  drawColumns(ctx, board, options);
  // 脑图在**连线之下**（`2.2.0` 批 4）：屏幕上那层边是画在卡片 / 节点**背后**的
  //（`EdgeLayer` 的 z 比 world 低），导出这边保持同一个次序才看着一样。
  // ★ 底稿只算一次，`drawMinds`（画树）与 `drawEdges`（要节点当端点）共用它 ——
  //   两处各算一遍布局，节点与线头会各自落在不同的地方
  const mindPlans = planMinds(board, options.mindModels);
  drawMinds(ctx, mindPlans, tile, options);
  drawEdges(ctx, board, options);
  drawCards(ctx, board, tile, options);

  ctx.restore();
}

function drawBackground(
  ctx: CanvasRenderingContext2D,
  board: BoardFile,
  tile: PngTile,
  options: PngRenderOptions,
): void {
  if (options.transparent) return;
  const { palette } = options;
  ctx.fillStyle = palette.background;
  ctx.fillRect(tile.x, tile.y, tile.width, tile.height);

  const mode = options.background ?? board.view.background;
  if (mode !== 'dots' && mode !== 'grid') return;

  const cell = Number.isFinite(options.gridSize) && options.gridSize > 0 ? options.gridSize : 32;
  if (cell < MIN_PATTERN_CELL) return;
  const cols = Math.ceil(tile.width / cell) + 1;
  const rows = Math.ceil(tile.height / cell) + 1;
  if (cols * rows > MAX_PATTERN_CELLS) return;

  ctx.save();
  ctx.strokeStyle = palette.pattern;
  ctx.fillStyle = palette.pattern;
  ctx.lineWidth = 1;
  const startX = Math.floor(tile.x / cell) * cell;
  const startY = Math.floor(tile.y / cell) * cell;

  if (mode === 'dots') {
    const radius = 1.5;
    for (let y = startY; y <= tile.y + tile.height; y += cell) {
      for (let x = startX; x <= tile.x + tile.width; x += cell) {
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  } else {
    for (let x = startX; x <= tile.x + tile.width; x += cell) {
      ctx.beginPath();
      ctx.moveTo(x, tile.y);
      ctx.lineTo(x, tile.y + tile.height);
      ctx.stroke();
    }
    for (let y = startY; y <= tile.y + tile.height; y += cell) {
      ctx.beginPath();
      ctx.moveTo(tile.x, y);
      ctx.lineTo(tile.x + tile.width, y);
      ctx.stroke();
    }
  }
  ctx.restore();
}

function drawColumns(
  ctx: CanvasRenderingContext2D,
  board: BoardFile,
  options: PngRenderOptions,
): void {
  const { palette } = options;
  const columns = [...board.columns].sort((a, b) => a.z - b.z);

  for (const column of columns) {
    const rect = rectOfColumn(column);
    ctx.save();
    ctx.fillStyle = palette.cardFill;
    ctx.strokeStyle = palette.cardBorder;
    ctx.lineWidth = 1;
    roundedRect(ctx, rect.x, rect.y, rect.width, rect.height, CARD_RADIUS);
    ctx.fill();
    ctx.stroke();

    // 标题栏：与卡片头部同高，画一条分隔线 + 标题文字
    ctx.beginPath();
    ctx.moveTo(rect.x, rect.y + HEADER_HEIGHT);
    ctx.lineTo(rect.x + rect.width, rect.y + HEADER_HEIGHT);
    ctx.stroke();

    ctx.fillStyle = palette.cardText;
    ctx.font = `600 ${TITLE_FONT_SIZE}px ${palette.fontFamily}`;
    ctx.textBaseline = 'middle';
    const title = column.title.trim() || t('column.title.placeholder');
    fillClippedText(
      ctx,
      title,
      rect.x + CARD_PADDING,
      rect.y + HEADER_HEIGHT / 2,
      rect.width - CARD_PADDING * 2,
    );
    ctx.restore();
  }
}

/**
 * 一棵**要画的脑图**这一次的底稿（`2.2.0` 批 4）。
 *
 * ★ 抽出来是因为它被两处用：画树本身（{@link drawMinds}）与画连线时的**端点表**
 *   （`drawEdges` 里的节点矩形）。两处各算一遍布局的话，"节点"与"线头"会各自
 *   落在不同的地方 —— 那是导出里最明显的一类错。
 */
interface MindDrawPlan {
  mind: Mind;
  /** 实际画出来那一份（收起的分支已经摘掉） */
  file: MindFile;
  layout: MindLayout;
  /** 布局坐标 → 世界坐标的平移（容器的 `x/y` 是根节点中心） */
  dx: number;
  dy: number;
}

/** 这一块 tile 要画的脑图（模型还没读到的那些**不在里面**） */
function planMinds(board: BoardFile, mindModels?: ReadonlyMap<string, MindFile>): MindDrawPlan[] {
  const plans: MindDrawPlan[] = [];
  for (const mind of [...(board.minds ?? [])].sort((a, b) => a.z - b.z)) {
    const model = mind.path.length === 0 ? (mind.mind ?? null) : (mindModels?.get(mind.id) ?? null);
    // 摆法（锚点 = 根节点中心）与缩略图 / SVG 导出共用同一份（`mind/embed/boardGeometry`）
    const place = mindPlacement({ x: mind.x, y: mind.y }, model ?? null);
    if (!place) continue;
    plans.push({ mind, file: place.file, layout: place.layout, dx: place.dx, dy: place.dy });
  }
  return plans;
}

/**
 * 脑图节点圆角 / 分支线粗细（世界 px）。
 *
 * ★ 圆角与 SVG 导出那一条**同一个数**（`toSvg.ts` 的 `Math.min(8, h/2)`）：
 *   两种导出画同一棵树却一个圆一个方，只会让人以为其中一份坏了。
 */
const MIND_NODE_MAX_RADIUS = 8;
const MIND_EDGE_WIDTH = 1.5;
/**
 * 标题带的**内边距**（世界 px）—— 与样式表 `.nestboard-mind-node-title { padding: 8px 14px }`
 * 和 SVG 导出的 `PADDING_X` 是同一组数。
 *
 * ★ 上下留白从前在这边写的是 6（样式表是 8）⇒ 标题带比画布上矮一截，
 *   节点看上去"扁"了一圈（用户报的"导出 PNG 和原脑图差很多"里的一处）。
 */
const MIND_BAND_PADDING_X = 14;
/** 内容块（备注）的字号：与 `.nestboard-mind-node-body` 的 `--nestboard-card-font-size` 同档 */
const MIND_BODY_FONT_SIZE = 14;
/** 附件那一行的字号（比正文再小一档 —— 它只是"这里挂着个东西"） */
const MIND_REF_FONT_SIZE = 12;
/** 图片附件块的圆角（比节点自己的圆角小一点：它是嵌在里面的一块） */
const MIND_IMAGE_RADIUS = 4;
const MIND_BAND_PADDING_Y = 8;
/** 分支线的不透明度：屏幕上它是"托底"的淡线，压过节点就喧宾夺主了 */
const MIND_EDGE_ALPHA = 0.6;

/**
 * 画板上的脑图（`2.2.0` 批 4）。
 *
 * ── 与屏幕上那套的关系 ───────────────────────────────────────
 *
 * **几何全部复用**（布局 `layoutMind`、连线路径 `edgePathOf` 给的 SVG 路径字符串、
 * 配色 `mindPaletteOf` 给的十六进制），**观感这一层自己再写一遍** ——
 * canvas 读不到 DOM 样式，与 `drawCards` 是同一条纪律。
 *
 * ★ 刻意**不画**的：折叠手柄圆圈、`+N` 角标、图片附件的**缩放把手**、
 *   备注里 Markdown 的**排版**（导出按纯文本折行）。它们是"界面上的操作入口"
 *   —— 这一条写在文档里，免得被当成漏画。
 * ★ 反过来，**节点内容一律照画**（`b75` / `b76` 起）：标题带、备注块（折行与布局估算
 *   同一份口径）、**图片附件**（预加载到真图就 `contain` 画出来，否则一块底纹）、
 *   完成态的删除线、非图片附件那一行 `📎 文件名`。它们是"内容"，缺了就与原脑图对不上
 *   （用户 2026-09-22 报的"只有节点标题，没有节点内容"说的正是这里）。
 * ★ 四层及以上**不画盒子**（`MIND_DEEP_DEPTH`）：与画布同一条观感口径（`D3`）；
 *   但它们的**文字与备注照旧画**（画布上只是配色变透明）。
 */
function drawMinds(
  ctx: CanvasRenderingContext2D,
  plans: readonly MindDrawPlan[],
  tile: PngTile,
  options: PngRenderOptions,
): void {
  const { palette } = options;
  for (const plan of plans) {
    // 整棵树都在这一块 tile 之外 ⇒ 跳过（分页导出时每块只画自己那一块）
    if (!rectTouchesTile(tile, offsetRect(plan.layout.bounds, plan.dx, plan.dy))) continue;

    ctx.save();
    ctx.translate(plan.dx, plan.dy);
    drawMindEdges(ctx, plan, palette);
    // ★ 传 `options`（不是只传 `palette`）：节点上的**图片附件**要用那份预加载好的位图表
    //   （`options.images`）—— 与图片卡走的是同一份
    drawMindNodes(ctx, plan, tile, options);
    ctx.restore();
  }
}

/** 父子连线：**逐字复用**脑图那边算出来的路径字符串（`mind/layout/edges`） */
function drawMindEdges(
  ctx: CanvasRenderingContext2D,
  plan: MindDrawPlan,
  palette: PngPalette,
): void {
  const style = plan.file.view.edge ?? 'curve';
  ctx.strokeStyle = palette.mutedText;
  ctx.lineWidth = MIND_EDGE_WIDTH;
  ctx.globalAlpha = MIND_EDGE_ALPHA;
  const trunks = new Set<string>();
  for (const node of plan.file.nodes) {
    if (node.parentId === null) continue;
    const parent = plan.layout.boxes.get(node.parentId);
    const child = plan.layout.boxes.get(node.id);
    if (!parent || !child) continue;
    // 延长线（节点边缘 → 分支点）同一侧共用一条，与 `paintEdges` 同一个判据
    const direction = childSideOf(parent, child);
    const key = `${parent.id}:${direction}`;
    if (!trunks.has(key)) {
      trunks.add(key);
      tracePath(ctx, edgeTrunkPathOf(parent, direction));
      ctx.stroke();
    }
    tracePath(ctx, edgePathOf(parent, child, style));
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

/** 节点盒子 + 标题 + 内容块（深层只画文字 + 一条托底的线） */
function drawMindNodes(
  ctx: CanvasRenderingContext2D,
  plan: MindDrawPlan,
  tile: PngTile,
  options: PngRenderOptions,
): void {
  const { palette } = options;
  const nodes = new Map(plan.file.nodes.map((node) => [node.id, node]));
  const doneBranch = dimmedByDoneAncestor(plan.file);
  for (const [id, box] of plan.layout.boxes) {
    const node = nodes.get(id);
    if (!node) continue;
    if (!rectTouchesTile(tile, offsetRect(box, plan.dx, plan.dy))) continue;

    const depth = box.depth;
    const size = titleSizeOf(depth);
    const deep = depth >= MIND_DEEP_DEPTH;
    const colors = mindPaletteOf(node.style, {
      depth,
      // 主题色在 canvas 里没有 `var()` 可用 ⇒ 用画布那一层已经解析好的十六进制
      resolveTheme: (color) => resolveColor(color, palette),
    });
    // 标题带高度 = **行高 + 上下内边距**（与样式表 / SVG 导出同一个公式），
    // 且不超过盒子本身（矮节点上带子要收着画，不能铺出去）
    const lineHeight = titleLineHeightFor(size);
    const bandHeight = Math.min(box.height, lineHeight + MIND_BAND_PADDING_Y * 2);
    const radius = Math.min(MIND_NODE_MAX_RADIUS, box.height / 2);

    // ── 图片附件块（`2.2.0` 批 4 六）────────────────────────────
    //
    // ★ 位置与**画布的 DOM 顺序**一致：图片 → 标题带 → 内容块（`buildNodeElement`
    //   就是 `appendChild(imageBlock)` 走在前面的）。于是"图片占盒子上面那一段、
    //   标题带落在它下面"。
    // ★ 高度取"盒子扣掉标题带"的那一截：估算就是按 `图片宽 × 比例 + 标题带`
    //   给节点定高的（见 `estimateNodeSize` 的图片分支）。
    const ref = firstRefOf(node);
    const imageRef = ref?.kind === 'image' ? ref : null;
    const imageHeight = imageRef
      ? Math.max(0, box.height - (lineHeight + MIND_BAND_PADDING_Y * 2))
      : 0;
    const bandTop = imageRef ? box.y + imageHeight : box.y;

    // 完成态（`N3-g`）：自己完成 = 整块略淡 + 标题一条删除线；祖先完成 = 整块更淡。
    // ★ 与画布 / SVG 导出同一组数（0.75 / 0.5），从前 PNG 这边**完全没画**。
    const done = node.done === true;
    const opacity = done ? 0.75 : doneBranch.has(node.id) ? 0.5 : 1;
    if (opacity < 1) ctx.globalAlpha = opacity;

    if (!deep) {
      ctx.fillStyle = colors.body;
      roundedRect(ctx, box.x, box.y, box.width, box.height, radius);
      ctx.fill();

      // 图片块：有真图就画（`contain`，不拉伸），拿不到就留一块底纹 ——
      // 都不画的话这一块会空着，而画布上那里是有内容的
      if (imageRef && imageHeight > 1) {
        const source = options.images?.get(imageRef.path) ?? null;
        const drawn = source
          ? drawMindNodeImage(
              ctx,
              source,
              { x: box.x, y: box.y, width: box.width, height: imageHeight },
              MIND_IMAGE_RADIUS,
            )
          : null;
        if (!drawn) {
          ctx.fillStyle = palette.pattern;
          roundedRect(ctx, box.x, box.y, box.width, imageHeight, MIND_IMAGE_RADIUS);
          ctx.fill();
        }
      }

      ctx.fillStyle = colors.title;
      // ★ 带子**铺满整张卡**（没有内容块的节点）时直接用圆角矩形：只圆上面两个角的话，
      //   底下会露出**两个直角** —— 看上去像"卡片底下贴了一小块方纸"（SVG 那边修过同一处，
      //   PNG 这边当时漏了）。差 2px 以内算铺满：节点高度本来就是估出来的。
      if (bandHeight >= box.height - imageHeight - 2) {
        roundedRect(ctx, box.x, bandTop, box.width, box.height - imageHeight, radius);
      } else {
        topRoundedRect(ctx, box.x, bandTop, box.width, bandHeight, radius);
      }
      ctx.fill();
    }

    // ★ 粗细取 **700**：样式表给的是 `var(--font-bold, 700)`，从前这里写 600 ——
    //   中心主题在导出图里比画布上细一档（同一批观感 bug 里的一处）。
    ctx.font = `${titleBoldOf(depth) ? '700 ' : '400 '}${size}px ${palette.fontFamily}`;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = deep ? palette.cardText : colors.titleInk;
    // ★ 与画布**同一条排版**：左对齐、从标题带左边内边距处起笔、垂直居中于标题带，
    //   超出"一行 29 个显示单位"就在节点内换行（`wrapNodeTitle` 与布局估算是同一份
    //   口径 ⇒ 盒子留的行数就是这里画的行数）。
    // ★ 仍然**不截断**（不画省略号）：节点宽度是估出来的，短标题会落在最小宽度上 ——
    //   截断成"中…"是导出独有的错误，比"文字略微探出盒子"糟得多。
    const lines = wrapNodeTitle(node.text);
    const textLeft = box.x + MIND_BAND_PADDING_X;
    lines.forEach((line, index) => {
      if (line.length === 0) return;
      ctx.textAlign = 'left';
      ctx.fillText(line, textLeft, bandTop + MIND_BAND_PADDING_Y + (index + 0.5) * lineHeight);
    });

    // 标题下的**删除线**（完成态）：与 SVG 导出同一条，宽度按估出来的字宽
    if (done) {
      const width = node.text.length * size * MIND_CHAR_WIDTH_RATIO;
      ctx.strokeStyle = deep ? palette.cardText : colors.titleInk;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(textLeft, bandTop + MIND_BAND_PADDING_Y + lineHeight / 2);
      ctx.lineTo(textLeft + width, bandTop + MIND_BAND_PADDING_Y + lineHeight / 2);
      ctx.stroke();
    }

    // ── 内容块（备注）─────────────────────────────────────────
    //
    // ★ 从前**一条都不画**：盒子的高度里算了它（估算会为备注留出若干行），画面上却是
    //   一个空盒子 ⇒ 用户报的"绘制尺寸不是很还原，一些换行没处理"。
    // ★ 行怎么折、折几行，问的是**与估算同一个** `wrapNodeNote`（同一把尺子算出来的
    //   行数才装得进盒子里）。
    // ★ 四层及以上的节点**也画**（画布上只是配色变透明，正文照旧读得到）。
    // ★ 有图片附件的节点不画备注：估算那一支是按"图片 + 标题带"给的高（见 `measure.ts`），
    //   再往上摞备注会溢出节点。
    const note = node.note.trim();
    if (note.length > 0 && imageRef === null) {
      const available = Math.max(24, box.width - MIND_BAND_PADDING_X * 2);
      const units = Math.max(4, Math.floor(available / Math.max(1, size * MIND_CHAR_WIDTH_RATIO)));
      ctx.font = `400 ${MIND_BODY_FONT_SIZE}px ${palette.fontFamily}`;
      ctx.fillStyle = deep ? palette.cardText : colors.bodyInk;
      ctx.textAlign = 'left';
      wrapNodeNote(note, units).forEach((line, index) => {
        if (line.length === 0) return;
        ctx.fillText(
          line,
          textLeft,
          bandTop + bandHeight + MIND_NODE_INNER_GAP + (index + 0.5) * MIND_BODY_LINE_HEIGHT,
        );
      });
    }

    // 附件那一行：图片附件**不给**（它自己就是图上那一块，画布上也不给它回形针），
    // 其余附件写一行"📎 文件名"贴在节点底部
    if (ref && imageRef === null) {
      ctx.font = `400 ${MIND_REF_FONT_SIZE}px ${palette.fontFamily}`;
      ctx.globalAlpha = Math.min(ctx.globalAlpha, 0.75);
      ctx.fillStyle = deep ? palette.cardText : colors.bodyInk;
      ctx.textAlign = 'left';
      ctx.fillText(
        `📎 ${refLabelOf(ref.path)}`,
        textLeft,
        box.y + box.height - MIND_BAND_PADDING_Y,
      );
    }

    if (deep) {
      // 四层及以上：不画盒子，只留一条托底的线（`D3`）
      ctx.strokeStyle = palette.pattern;
      ctx.lineWidth = 1;
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.moveTo(box.x, box.y + box.height);
      ctx.lineTo(box.x + box.width, box.y + box.height);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
}

/**
 * 把**脑图那边给的 SVG 路径字符串**画进 canvas。
 *
 * ★ 为什么不在这边自己算曲线：连线的几何（分支点、四种线型的控制点）很容易
 *   在"左边那一侧方向反了"这类地方写错，而它已经有一份**被单测钉住**的实现
 *   （`mind/layout/edges`，给的是 `d` 字符串）。解析这几条命令的比重写一份几何便宜得多，
 *   而且**永不漂**：屏幕与导出画的是同一串数。
 * ★ 只认这四个命令（`M/L/C/Q`，绝对坐标）—— 那一份实现只发这四种。
 */
function tracePath(ctx: CanvasRenderingContext2D, d: string): void {
  ctx.beginPath();
  const tokens = d.match(/[MLCQZmlcqz]|-?\d*\.?\d+(?:[eE][-+]?\d+)?/g) ?? [];
  let index = 0;
  const num = (): number => Number(tokens[index++]);
  while (index < tokens.length) {
    const command = (tokens[index++] ?? '').toUpperCase();
    if (command === 'M') ctx.moveTo(num(), num());
    else if (command === 'L') ctx.lineTo(num(), num());
    else if (command === 'C') ctx.bezierCurveTo(num(), num(), num(), num(), num(), num());
    else if (command === 'Q') ctx.quadraticCurveTo(num(), num(), num(), num());
    else if (command === 'Z') ctx.closePath();
    else return; // 认不出的命令：宁可少画一条，也不要画出一条乱线
  }
}

/** 世界矩形与这一块 tile 相交吗（`null` = 没有内容 ⇒ 算相交，让它自己判） */
function rectTouchesTile(tile: PngTile, rect: Rect | null): boolean {
  if (!rect) return true;
  return !(
    rect.x > tile.x + tile.width ||
    rect.x + rect.width < tile.x ||
    rect.y > tile.y + tile.height ||
    rect.y + rect.height < tile.y
  );
}

function offsetRect(rect: Rect | null, dx: number, dy: number): Rect | null {
  if (!rect) return null;
  return { x: rect.x + dx, y: rect.y + dy, width: rect.width, height: rect.height };
}

function drawEdges(
  ctx: CanvasRenderingContext2D,
  board: BoardFile,
  options: PngRenderOptions,
): void {
  if (board.edges.length === 0) return;
  const { palette } = options;
  const rects = new Map<string, Rect>();
  const angles = new Map<string, number>();
  for (const card of board.cards) {
    rects.set(card.id, rectOfCard(card));
    if (card.rotation) angles.set(card.id, card.rotation);
  }
  // ★ 分栏也是端点（`O21`）：与画布、SVG 导出同一份"谁在表里谁就是端点"的判据
  for (const column of board.columns) rects.set(column.id, rectOfColumn(column));
  // ★ **脑图的节点也是端点**（`2.2.0` 批 3 / 批 4）：键与画布上完全一样
  //   （`nodeEndpointKey` = `脑图id/节点id`）—— 少这一笔，指着节点的线在导出图里
  //   会**整条消失**（数据里有、画布上有、导出里没有，最难自查的一种）。
  //   与取景同一份底稿（`mindsOfBoard`），所以"框留够了、线头却在框外"不会发生
  for (const mind of mindsOfBoard(board, options.mindModels)) {
    for (const [key, rect] of mind.nodes) rects.set(key, rect);
  }
  const lookup = (cardId: string): Rect | null => rects.get(cardId) ?? null;
  // 锚点跟着卡片的旋转走（T7.06）：不喂角度的话，连到转过的卡片上的线
  // 会插进卡片内部或者浮在它外面 —— 导出图上一眼就能看出来
  const angleOf: AngleLookup = (cardId) => angles.get(cardId) ?? 0;
  // Smart 路由要绕开的卡片（T7.11）：与画布同一份判据 —— 没有 smart 线就不建表
  const obstacles = board.edges.some((edge) => edge.routing === 'smart')
    ? obstacleRects(
        board.cards.map((card) => card.id),
        lookup,
      )
    : [];

  for (const edge of board.edges) {
    // ★ 走 `edgePolyline` 而不是"两端锚点连直线"：弧线（T7.12）与智能绕行（T7.11）
    //   的形状只由它决定，画布、命中、框选、导出四处共用一个答案
    const path = edgePolyline(edge, { rectOf: lookup, angleOf, obstacles });
    if (!path) continue;
    const points = path.points;

    const color = resolveColor(edge.color, palette);
    const { from: startDir, to: endDir } = polylineEndDirections(points);
    const arrow = 8;
    const shrink = Math.min(arrow, polylineLength(points) / 3);
    let line = points;
    if (edge.fromEnd === 'arrow') line = shrinkPolylineEnd(line, 'from', shrink, startDir);
    if (edge.toEnd === 'arrow') line = shrinkPolylineEnd(line, 'to', shrink, endDir);

    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 1.6;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (edge.style === 'dashed') ctx.setLineDash([6, 4]);

    // ★ 形状看 `path.kind`，不按点数猜：3 个点的正交走线是个直角弯，不是圆弧
    ctx.beginPath();
    ctx.moveTo(line[0].x, line[0].y);
    if (path.kind === 'curve') {
      ctx.quadraticCurveTo(line[1].x, line[1].y, line[2].x, line[2].y);
    } else {
      for (let index = 1; index < line.length; index++) ctx.lineTo(line[index].x, line[index].y);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    const last = points.length - 1;
    // ★ `endDir` / `startDir` 都指路径内部，而 `drawArrowHead` 要的是"从线指向尖端"，
    //   于是 `to` 端取反、`from` 端本就取的 `-startDir` —— 两端都朝各自那张卡
    if (edge.toEnd === 'arrow') drawArrowHead(ctx, points[last], -endDir.x, -endDir.y, arrow);
    if (edge.fromEnd === 'arrow') drawArrowHead(ctx, points[0], -startDir.x, -startDir.y, arrow);
    ctx.restore();

    // 标签（T7.13）画在自己的线之后、下一条线之前 —— 与画布上的叠放次序一致
    if (edge.label.length > 0) drawEdgeLabel(ctx, edge.label, path, color, palette);
  }
}

/** 连线标签字号 / 内边距 / 最大宽度：与画布上的 `EdgeRenderer` 保持同一组数值 */
const EDGE_LABEL_FONT_SIZE = 11;
const EDGE_LABEL_MAX_WIDTH = 220;
const EDGE_LABEL_PADDING_X = 5;
const EDGE_LABEL_PADDING_Y = 2;
const EDGE_LABEL_RADIUS = 4;
/** 标签块从路径中点向外伸出的最远距离（半宽 + 内边距）：取景时要把它框进去 */
const EDGE_LABEL_HALF_WIDTH = EDGE_LABEL_MAX_WIDTH / 2 + EDGE_LABEL_PADDING_X;

/**
 * 连线标签（T7.13）：路径中点 + 一块与背景同色的圆角底。
 *
 * ★ 底不能省：文字直接压在线上的话，与线重合的那一两个笔画会被线吃掉
 *   （浅色主题下尤其明显）—— 垫一块底色等于让文字"坐"在线上面。
 * ★ 落点用 `edgePathMidpoint`：与弧度手柄、与画布是同一个点。
 */
function drawEdgeLabel(
  ctx: CanvasRenderingContext2D,
  label: string,
  path: EdgePath,
  color: string,
  palette: PngPalette,
): void {
  const anchor = edgePathMidpoint(path);
  ctx.save();
  ctx.font = `${EDGE_LABEL_FONT_SIZE}px ${palette.fontFamily}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const text = fitEdgeLabel(ctx, label);
  const width = ctx.measureText(text).width + EDGE_LABEL_PADDING_X * 2;
  const height = EDGE_LABEL_FONT_SIZE + EDGE_LABEL_PADDING_Y * 2;

  ctx.fillStyle = palette.background;
  roundedRect(
    ctx,
    anchor.x - width / 2,
    anchor.y - height / 2,
    width,
    height,
    Math.min(EDGE_LABEL_RADIUS, width / 2, height / 2),
  );
  ctx.fill();

  ctx.fillStyle = color;
  ctx.fillText(text, anchor.x, anchor.y);
  ctx.restore();
}

/** 量不下就截断加省略号（二分找断点：逐字量在超长标签上是 O(n) 次 `measureText`） */
function fitEdgeLabel(ctx: CanvasRenderingContext2D, label: string): string {
  if (ctx.measureText(label).width <= EDGE_LABEL_MAX_WIDTH) return label;
  const chars = [...label];
  let low = 0;
  let high = chars.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (ctx.measureText(`${chars.slice(0, mid).join('')}…`).width <= EDGE_LABEL_MAX_WIDTH) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return low <= 0 ? '…' : `${chars.slice(0, low).join('')}…`;
}

function drawArrowHead(
  ctx: CanvasRenderingContext2D,
  tip: { x: number; y: number },
  dirX: number,
  dirY: number,
  length: number,
): void {
  const half = length * 0.45;
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

function drawCards(
  ctx: CanvasRenderingContext2D,
  board: BoardFile,
  tile: PngTile,
  options: PngRenderOptions,
): void {
  const { palette } = options;
  const maxLines = options.maxLines ?? 6;
  const cards = [...board.cards].sort((a, b) => a.z - b.z);

  for (const card of cards) {
    const rect = rectOfCard(card);
    const angle = card.rotation ?? 0;
    // 视口外的卡片直接跳过：分页导出时每块 tile 只画自己那一块
    // ★ 判定用**外接框**（T7.06）：转 45° 的卡片能探出布局框小半张 ——
    //   按布局框裁剪会把"只有一角伸进这一块 tile"的卡片整张丢掉（分页导出露一块白）
    const area = boundsOfCard(card);
    if (
      area.x > tile.x + tile.width ||
      area.x + area.width < tile.x ||
      area.y > tile.y + tile.height ||
      area.y + area.height < tile.y
    ) {
      continue;
    }

    const themeColor = resolveColor(card.color, palette);
    ctx.save();
    // 旋转（T7.06）：绕卡片中心转，之后每一个绘制调用都还在**卡片自己的坐标系**里 ——
    // 于是圆角、强调条、文字换行、图钉位置一个都不用改，它们天然跟着转。
    // ★ 放在 `save()` 之后：转的是一个"只属于这张卡"的临时状态，
    //   末尾的 `restore()` 一并收掉（这也是它必须与 `restore()` 严格配对的原因）。
    applyCardRotation(ctx, rect, angle);
    // 深色便签（`O06`）：底色换成固定深色，并**跳过下面那层主题色调和** ——
    // 14% 的色覆盖在近黑底上会明显把黑染成"深蓝 / 深红"，
    // 而屏幕上那张卡就是纯粹的黑（样式表把它整块背景换掉了）
    const darkNote = isDarkNoteCard(card);
    // 浅色便签（`O38` 的撞色）：**标题带是主色、正文是白纸**，与屏幕上那条样式规则一一对应。
    // ★ 导出这边是**自己重画**一遍（canvas 读不到 DOM 的样式），所以每改一次卡面观感，
    //   这里都要跟着改 —— 用户报的"导出撞色丢了"就是这个原因。
    const lightNote = isLightNoteCard(card);
    // 标题行（`showTitle: false` 或空标题时整行不画，与画布一致）
    const titleVisible = card.showTitle && card.title.trim().length > 0;
    // ★ 带子只在"便签 + 真的画标题"时才有：屏幕上 `showTitle: false` 会把整条标题栏
    //   `display: none` 掉，那时便签就是一张纯白纸（没有色带），导出得跟着一样
    const banded = lightNote && titleVisible;
    const bandHeight = Math.min(HEADER_HEIGHT, rect.height);

    // ① 底板：便签是**白纸**（`#ffffff`），其余卡是主题底板
    ctx.fillStyle =
      banded || lightNote ? NOTE_LIGHT_FILL : darkNote ? NOTE_DARK_FILL : palette.cardFill;
    roundedRect(ctx, rect.x, rect.y, rect.width, rect.height, CARD_RADIUS);
    ctx.fill();

    // ② 淡色底：canvas 没有 `color-mix`，用一次半透明覆盖近似（对应 styles.css 的 14%）。
    //    ★ 便签**不铺**这一层：屏幕上那 14% 的淡底只留给其它类型的卡，
    //      便签整块走白纸、颜色只上标题带（`O38`）
    if (!darkNote && !lightNote) {
      ctx.save();
      ctx.globalAlpha = 0.14;
      ctx.fillStyle = themeColor;
      roundedRect(ctx, rect.x, rect.y, rect.width, rect.height, CARD_RADIUS);
      ctx.fill();
      ctx.restore();
    }

    // ③ 便签的撞色标题带：主色铺满上面那一条，只圆上面两个角
    if (banded) {
      ctx.fillStyle = themeColor;
      topRoundedRect(ctx, rect.x, rect.y, rect.width, bandHeight, CARD_RADIUS);
      ctx.fill();
    }

    // ④ 边框：便签**不描**（屏幕上写的是 `border-color: transparent`）——
    //    色带 + 白纸已经把这张卡从背景上分出来了，再描一圈就露馅
    if (!lightNote) {
      ctx.strokeStyle = themeColor;
      ctx.lineWidth = 1;
      if (card.locked) ctx.setLineDash([4, 3]);
      roundedRect(ctx, rect.x, rect.y, rect.width, rect.height, CARD_RADIUS);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    if (card.accent) {
      ctx.fillStyle = normalizeHex(card.accent) ?? themeColor;
      ctx.fillRect(rect.x, rect.y, ACCENT_WIDTH, rect.height);
    }

    const preview = cardPreview(card);
    let cursorY = rect.y + CARD_PADDING;

    if (titleVisible) {
      // 字色：便签用**用户挑的**那个，没挑过就按带子的底色算一个读得清的
      //（与屏幕上同一套判据：`swatchInkColor` 在深/浅两个墨色里挑对比度高的那个）
      ctx.fillStyle = banded
        ? (card.titleStyle?.ink ?? swatchInkColor(themeColor))
        : darkNote
          ? NOTE_DARK_TEXT
          : palette.cardText;
      // 加粗 / 斜体跟着 `titleStyle` 走（下划线在 canvas 上要自己画线，暂不还原 —— 见 `03`）
      const weight = card.titleStyle?.bold === true ? 700 : 600;
      const italic = card.titleStyle?.italic === true ? 'italic ' : '';
      ctx.font = `${italic}${weight} ${TITLE_FONT_SIZE}px ${palette.fontFamily}`;
      ctx.textBaseline = 'top';
      const titleWidth = rect.width - CARD_PADDING * 2 - (card.accent ? ACCENT_WIDTH : 0);
      // 标记（`O38`）：跟着标题一起画在最前面（屏幕上它在标题行最前、跟着标题字号）
      // ★ 走 `cardIconOf`：白板卡的标记在**内容**里（`BoardRefContent.icon`），
      //   读卡级那个键会漏掉它（屏幕上画着、导出图里没有）
      const mark = cardIconOf(card);
      const titleText = mark.length > 0 ? `${mark} ${card.title}` : card.title;
      const clipped = wrapText((text) => ctx.measureText(text).width, titleText, titleWidth).slice(
        0,
        1,
      );
      // 便签的标题**竖着居中在带子里**（屏幕上那条带的上下内边距是均分的）；
      // 其余卡照旧顶格画在内容区第一行
      const titleY = banded ? rect.y + Math.max(0, (bandHeight - TITLE_FONT_SIZE) / 2) : cursorY;
      fillClippedText(
        ctx,
        clipped[0] ?? '',
        rect.x + CARD_PADDING + (card.accent ? ACCENT_WIDTH : 0),
        titleY,
        titleWidth,
      );
      // 正文从**带子下面**开始（便签），其余卡接着标题那一行往下排
      cursorY = banded
        ? rect.y + bandHeight + CARD_PADDING
        : cursorY + TITLE_FONT_SIZE + CARD_PADDING;
    }

    // 图片卡与**地图卡**都画真位图（两者都在 `refsOfCard` 里报 `kind: 'image'`，
    // 于是 `loadExportImages` 会把它们的图一起预加载）。地图卡没有裁剪 / 铺满这两个字段：
    // 整图按 `contain` 画，与画布上的 `object-fit: contain` 一致。
    if ((card.type === 'image' || card.type === 'map') && card.content.path.length > 0) {
      const image = options.images?.get(card.content.path);
      const crop = card.type === 'image' ? card.content.crop : IDENTITY_CROP;
      const fit = card.type === 'image' ? card.content.fit : 'contain';
      const drawn = drawImageCard(
        ctx,
        image,
        rect,
        crop,
        fit,
        cursorY,
        card.accent ? ACCENT_WIDTH : 0,
      );
      if (drawn) {
        // 图钉是这张卡唯一要说的话，导出里不能丢；位置换算到**画出来的那张图**的矩形上
        if (card.type === 'map' && card.content.pin) {
          drawMapPin(ctx, card.content.pin, drawn, palette);
        }
        // ★ 图片卡这条 `continue` 曾经漏掉 `restore()`（T7.06 顺手修）：每导出一张
        //   图片卡，上下文就多压一层没还的 `save()`。以前只是白攒栈帧（看不出来），
        //   但上面加了旋转之后它会变成**可见的错**：旋转是栈上的变换，不还回去，
        //   后面每一张卡都会跟着歪 —— 而且歪的角度还是上一张的。
        ctx.restore();
        continue;
      }
    }

    // 正文色：深色便签是浅色字；**浅色便签是白纸上的深色字**（屏幕上就是 `#1f1f1f` /
    // `#5c5c5c` —— 白纸就是白纸，深色主题里也一样）；其余卡走主题的正文色
    ctx.fillStyle = darkNote ? NOTE_DARK_MUTED : lightNote ? NOTE_LIGHT_MUTED : palette.mutedText;
    ctx.font = `${BODY_FONT_SIZE}px ${palette.fontFamily}`;
    ctx.textBaseline = 'top';
    const bodyWidth = rect.width - CARD_PADDING * 2 - (card.accent ? ACCENT_WIDTH : 0);
    const bodyLeft = rect.x + CARD_PADDING + (card.accent ? ACCENT_WIDTH : 0);
    const bodyBottom = rect.y + rect.height - CARD_PADDING;
    const lineHeight = BODY_FONT_SIZE + 3;

    const rows: string[] = [];
    if (preview.label.length > 0)
      rows.push(...wrapText((text) => ctx.measureText(text).width, preview.label, bodyWidth));
    for (const line of preview.lines) {
      rows.push(...wrapText((text) => ctx.measureText(text).width, line, bodyWidth));
    }

    let drawnLines = 0;
    for (const row of rows) {
      if (drawnLines >= maxLines || cursorY + lineHeight > bodyBottom) break;
      fillClippedText(ctx, row, bodyLeft, cursorY, bodyWidth);
      cursorY += lineHeight;
      drawnLines += 1;
    }
    ctx.restore();
  }
}

/**
 * 画一张位图卡（图片卡 / 地图卡）。返回**真正画出来的那张图的矩形**，
 * `null` = 没有可用图像，调用方回落到文字占位。
 *
 * ★ 返回矩形而不是 `true`：地图卡要在同一张图上叠图钉，而图钉坐标是"相对那张图"的
 *   归一化值 —— 不知道图被 `contain` 摆在哪、画多大，就算不出钉在哪儿。
 *
 * ★ 必须走**非破坏性裁剪**（T2.02 / `F2-3-3`）：`crop` 是"用户选中的那一块"，
 *   忽略它就会出现"导出的图和画布上看到的不是同一张图" —— 而用户裁图恰恰是为了
 *   只展示那一块，这是他一眼就能看出来的错误。
 *
 * ★ `source*` 用 `drawImage` 的九参形式交给内核去采样，不在 JS 里逐像素处理：
 *   原图可能几千像素宽，自己缩放是拿主线程换清晰度。
 */
function drawImageCard(
  ctx: CanvasRenderingContext2D,
  image: CanvasImageSource | undefined,
  cardRect: Rect,
  crop: ImageCrop | undefined,
  fit: ImageFit | undefined,
  top: number,
  leftInset: number,
): Rect | null {
  if (!image) return null;
  const size = imageSize(image);
  if (!size) return null;

  const left = cardRect.x + CARD_PADDING + leftInset;
  const boxWidth = cardRect.width - CARD_PADDING * 2 - leftInset;
  const boxHeight = cardRect.y + cardRect.height - CARD_PADDING - top;
  if (boxWidth <= 1 || boxHeight <= 1) return null;

  // 手改过的 `.nboard` 可能缺 `crop`：渲染层不假设它一定在，导出层同理
  const region = clampCrop(crop ?? IDENTITY_CROP);
  const sourceX = region.x * size.width;
  const sourceY = region.y * size.height;
  const sourceWidth = Math.max(1, region.w * size.width);
  const sourceHeight = Math.max(1, region.h * size.height);

  const cover = fit === 'cover';
  const scale = cover
    ? Math.max(boxWidth / sourceWidth, boxHeight / sourceHeight)
    : Math.min(boxWidth / sourceWidth, boxHeight / sourceHeight);
  const drawWidth = sourceWidth * scale;
  const drawHeight = sourceHeight * scale;

  const drawX = left + (boxWidth - drawWidth) / 2;
  const drawY = top + (boxHeight - drawHeight) / 2;

  ctx.save();
  // cover 必然溢出内容框：不裁就会盖住卡片边框、甚至盖到相邻卡片上
  if (cover) {
    roundedRect(ctx, left, top, boxWidth, boxHeight, 4);
    ctx.clip();
  }
  ctx.drawImage(
    image,
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    drawX,
    drawY,
    drawWidth,
    drawHeight,
  );
  ctx.restore();
  return { x: drawX, y: drawY, width: drawWidth, height: drawHeight };
}

/** 地图卡图钉的半径 / 描边宽（像素，导出倍率已由上层 `ctx.scale` 承担） */
const MAP_DOT_RADIUS = 6;
const MAP_DOT_BORDER = 2;

/**
 * 画地图卡上的图钉。
 *
 * `pin` 是**归一化到那张图**的坐标（0~1），所以先换算到 `drawn`（画出来的那张图的矩形）里 ——
 * 与画布上"图钉是 frame 的孩子、按百分比定位"是同一套语义（`cards/map.ts`）。
 *
 * 一圈背景色底 + 实心点：对应画布上那颗点的 2px 背景色描边。压一圈底色是有必要的，
 * 地图本身就是花花绿绿的图，纯色点在深色地形（海、森林）上会看不见。
 */
function drawMapPin(
  ctx: CanvasRenderingContext2D,
  pin: { x: number; y: number },
  drawn: Rect,
  palette: PngPalette,
): void {
  const x = drawn.x + clamp(pin.x, 0, 1) * drawn.width;
  const y = drawn.y + clamp(pin.y, 0, 1) * drawn.height;

  ctx.beginPath();
  ctx.arc(x, y, MAP_DOT_RADIUS, 0, Math.PI * 2);
  ctx.fillStyle = palette.background;
  ctx.fill();

  ctx.beginPath();
  ctx.arc(x, y, MAP_DOT_RADIUS - MAP_DOT_BORDER, 0, Math.PI * 2);
  ctx.fillStyle = palette.accent;
  ctx.fill();
}

function imageSize(image: CanvasImageSource): { width: number; height: number } | null {
  const width = (image as { width?: number }).width ?? 0;
  const height = (image as { height?: number }).height ?? 0;
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

/**
 * 画一块**节点上的图片附件**（`2.2.0` 批 4 六）。
 *
 * ★ `contain`（等比缩放、居中、不拉伸）：与画布上 `.nestboard-mind-image` 的
 *   `object-fit: contain` 同一条 —— 拉变形是"导出与原图不是一回事"里最刺眼的一种。
 * ★ 越界的部分裁掉（`clip`）：估算给这块留的高度是按"图片宽 × 0.75"这个**兜底比例**
 *   定的（真实比例要等图加载完才知道），比例不合时图的另一边会探出去。
 */
function drawMindNodeImage(
  ctx: CanvasRenderingContext2D,
  image: CanvasImageSource,
  rect: Rect,
  radius: number,
): Rect | null {
  const size = imageSize(image);
  if (!size || rect.width <= 1 || rect.height <= 1) return null;

  const scale = Math.min(rect.width / size.width, rect.height / size.height);
  const width = size.width * scale;
  const height = size.height * scale;
  const x = rect.x + (rect.width - width) / 2;
  const y = rect.y + (rect.height - height) / 2;

  ctx.save();
  roundedRect(ctx, rect.x, rect.y, rect.width, rect.height, radius);
  ctx.clip();
  ctx.drawImage(image, x, y, width, height);
  ctx.restore();
  return { x, y, width, height };
}

/** 主题色 / 自定义 HEX → 实际色值（非法值回落到边框色，绝不产出坏 CSS） */
function resolveColor(color: CardColor, palette: PngPalette): string {
  if (isThemeColor(color)) return palette.theme[color] || palette.cardBorder;
  return normalizeHex(color) ?? palette.cardBorder;
}

/**
 * 只圆**上面两个角**的矩形（`O38` 的撞色标题带用它）。
 *
 * ★ 与 `roundedRect` 分开写而不是加参数：那个函数的调用点有十几处，
 *   为一个用法给它加开关，读的人每次都要先想"这回是哪两个角"。
 * ★ 标题带是"贴着卡片上沿的一条"：上面两个角要跟着卡片的圆角走，
 *   下面两个角必须是直角 —— 否则色块会在带子下沿多出两个小弧，看着像没对齐。
 */
function topRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const r = Math.max(0, Math.min(radius, width / 2, height));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.arcTo(x + width, y, x + width, y + r, r);
  ctx.lineTo(x + width, y + height);
  ctx.lineTo(x, y + height);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

/** 沿路径画圆角矩形（自己撸而不用 `ctx.roundRect`：后者在旧内核/假 ctx 上不存在） */
function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.arcTo(x + width, y, x + width, y + r, r);
  ctx.lineTo(x + width, y + height - r);
  ctx.arcTo(x + width, y + height, x + width - r, y + height, r);
  ctx.lineTo(x + r, y + height);
  ctx.arcTo(x, y + height, x, y + height - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

/** 画一行**不换行**的文字，超出可用宽度就裁掉（画布上卡片也是 ellipsis）
 *
 * 导出 PDF 的页脚也要这一手（PDF 页脚同样是位图），所以这里是共用的实现。 */
export function fillClippedText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
): void {
  if (maxWidth <= 0 || text.length === 0) return;
  let value = text;
  if (ctx.measureText(value).width > maxWidth) {
    let end = value.length;
    while (end > 1 && ctx.measureText(`${value.slice(0, end)}…`).width > maxWidth) end -= 1;
    value = `${value.slice(0, end)}…`;
  }
  ctx.fillText(value, x, y);
}
