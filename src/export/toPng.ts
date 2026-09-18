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
  ThemeColor,
} from '../model/schema';
import { isThemeColor } from '../model/schema';
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
export type ExportBoundsOptions = Pick<PngExportOptions, 'range' | 'padding'>;

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
export function boardContentBounds(board: BoardFile): Rect | null {
  const parts: Rect[] = [...board.cards.map(boundsOfCard), ...board.columns.map(rectOfColumn)];

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

export interface PngBoundsContext {
  /** 当前视口对应的世界矩形（`range: 'viewport'` 用）；不传则该范围退化为整块板 */
  viewportRect?: Rect | null;
  /** 当前选中的卡片 / 分栏 id（`range: 'selection'` 用） */
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
    ]);
    if (picked) return padRect(picked, padding);
  }

  const bounds = boardContentBounds(board);
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
