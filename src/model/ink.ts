/**
 * 手绘的纯逻辑（T3.06 / T3.07 / `F4-01`、`F4-02`）：把"手在画布上怎么动"翻译成"笔画该长什么样"。
 *
 * 本文件只做算术，不碰 DOM、不碰 Canvas、不知道鼠标是什么 —— 这样下面这些
 * 只能在真机上碰运气才能复现的问题，全部可以在 node 下单测钉死：
 *
 *  * **采样间距**：每隔多远才记一个点（太密：一条 10px 的短线塞进 200 个点，
 *    文件和无障碍都没法看；太疏：画慢速曲线会变成折线）；
 *  * **擦除判定**：点到一根折线的最短距离（判错的表现是"擦不掉"或"擦到旁边那根"）；
 *  * **脏区**：新画出来的这一段占了哪块世界矩形（少算的表现是线尾留下半截）；
 *  * **压感→线宽**（T3.07）：哪一个点该多粗，以及"设备不报压感"时绝不能变细；
 *  * **半透明笔**（T7.08 / `F4-07`）：荧光笔的不透明度、线宽倍率，以及
 *    "半透明的一笔不记压感"（否则逐段描边会在接缝处叠深，一条高亮变成一串深浅斑）；
 *  * **暂存层的增删**（T7.07 / `F4-06`）：临时标注那一叠笔画怎么加、怎么整笔删 ——
 *    它们**不进模型**，所以"怎么增删"这条规则必须自己站得住（见 `appendStroke`）。
 *
 * ★ 与 `03 §2.7` 的关系：这里产出的 `InkPath` 就是文件里 `ink` 卡片的内容格式
 *   （坐标 + 颜色 + 线宽 + 可选压感）。
 *   **T3.08 落盘时要减掉卡片自己的原点**（`toStrokeSpace` 就是这一步）：
 *   卡片里的点是"相对这张卡左上角"的。存世界坐标看着更省事，但卡片自己会动
 *   （拖动 / 分栏重排 / 对齐），而拖动中的预览**只改 DOM、不动模型** ——
 *   笔迹会留在原地不动，直到松手才"啪"地跳过去。
 */

import { boundsOf, clamp, expandRect, type Point, type Rect } from '../util/geometry';
import type { HexColor, InkPath, InkPoint } from './schema';

/**
 * 手上拿的东西（`T7.08` 起是四支）。
 *
 * ★ `'marker'`（荧光笔）与 `'brush'` 的区别只在**画出来什么样**（半透明、更宽）；
 *   `'annotate'`（临时标注，`T7.07`）的区别在**画完之后住在哪** ——
 *   它交给 `InkLayer` 的暂存层而不是模型。所以"哪支笔"这一个枚举同时回答了两个问题，
 *   而且两件事恰好同进同退（换了笔，落点与归宿一起换），不需要第二个开关去配它。
 */
export type InkTool = 'brush' | 'marker' | 'annotate' | 'eraser';

/** 笔的样式（一笔画下去就不再变的那部分） */
export interface InkStyle {
  color: HexColor;
  /** 基准线宽（**世界**像素：笔迹是矢量，放大后跟着变粗）。实际线宽还要乘压感 */
  width: number;
  /**
   * 不透明度（`T7.08`）。缺省 = `1`（不透明）。
   *
   * ★ 缺省而不是写死 `1`：`alpha: 1` 写进每一笔普通笔迹里，存量文件就不再逐字节不变了
   *   （同 `README` 里"纯增量、不动 `BOARD_VERSION`"那一条）。
   */
  alpha?: number;
}

/**
 * 默认笔色：红笔。
 *
 * ★ 刻意不用"跟随主题的正文色"：白板底色跟着主题走（浅色 / 深色），
 *   而正文色在深色主题下是浅灰 —— 画在浅色主题的白底上几乎看不见。
 *   红笔在两种主题下都成立，而且"标注"本来就该显眼。
 */
export const DEFAULT_INK_COLOR: HexColor = '#e03131';

/**
 * 调色板（`F4-02`）。`X` 在最上面两支之间来回换，其余靠工具条 / 命令面板选。
 *
 * ★ 顺序是"从最常用到最少用"，不是色相环：红排第一（默认笔色），墨黑排最后 ——
 *   工具条从左到右就是用户伸手的顺序。
 * ★ 白色必须留在里面：直播 / 录课时白板常常是深色底或压在暗色画面上，
 *   没有白笔就只能靠退出手绘去改主题。它在浅色底上确实看不见，
 *   但那是用户自己选的颜色，工具不该替他决定。
 */
export const INK_COLORS: readonly HexColor[] = [
  '#e03131', // 红
  '#f08c00', // 橙
  '#2f9e44', // 绿
  '#1971c2', // 蓝
  '#7048e8', // 紫
  '#212529', // 墨黑
  '#ffffff', // 白
];

/**
 * 4 档笔刷尺寸（**世界**像素），对应 `04 §8` 的「笔刷尺寸 1~4」。
 *
 * ★ 不是等差（2/4/7/12 而非 2/4/6/8）：等比递增在屏幕上才有"每档都明显粗一圈"的
 *   手感差；等差到最后两档肉眼分不出来，用户按了 `3` 又按 `4` 会以为快捷键坏了。
 */
export const INK_BRUSH_WIDTHS: readonly number[] = [2, 4, 7, 12];

/** 默认档位（下标）。第 2 档 = 4px：100% 下一支不粗不细的笔 */
export const DEFAULT_INK_WIDTH_INDEX = 1;

/** 默认线宽（世界像素）。由档位表推出，保证"默认笔"永远是表里真实存在的一档 */
export const DEFAULT_INK_WIDTH = INK_BRUSH_WIDTHS[DEFAULT_INK_WIDTH_INDEX];

/** 默认的第二支笔色（`X` 切过去的那支）：墨黑 */
export const DEFAULT_INK_ALTERNATE_COLOR = INK_COLORS[5];

/**
 * 荧光笔的不透明度（`T7.08` / `F4-07`）。
 *
 * ★ `0.35` 是"一眼认得出是高亮、又看得清底下的字"的折中：再低就像没画上去，
 *   再高就盖住了正文 —— 而高亮笔的全部意义恰恰是**不**盖住内容。
 * ★ 这个值同时是"这一笔是不是半透明笔"的判据（见 `isTranslucent`），
 *   所以它只该出现在这里一处。
 */
export const INK_MARKER_ALPHA = 0.35;

/**
 * 荧光笔的线宽倍率（相对当前档位）。
 *
 * ★ 高亮笔在纸上本来就是宽的。与画笔同宽的话，用户得先把档位拨到 `4` 才像一支荧光笔 ——
 *   而"拨档位"这件事与"我拿的是荧光笔"毫无关系，不该混在一起要求用户做两步。
 * ★ 默认档（4px）× 4 = 16px：正好盖住一行正文的高度。
 */
export const INK_MARKER_WIDTH_SCALE = 4;

/**
 * 压感下限（占基准线宽的比例）。
 *
 * ★ 不设下限的话，数位笔"轻轻划一下"会画出 0.05px 的线 —— 屏幕上什么都没有，
 *   用户的第一反应是"笔坏了"。留一个 35% 的地板：轻按画出的是**细线**，不是没有线。
 */
export const INK_PRESSURE_MIN = 0.35;

/**
 * 工具状态（调色板 + 线宽档位）。
 *
 * ★ 做成不可变的纯数据 + 一组纯函数（而不是类）：状态迁移就那么几条规则
 *   （换色 / 换回来 / 换档），而"按两下 `X` 应该回到原色"这类不变量最值得钉死在单测里。
 */
export interface InkToolState {
  /** 当前笔色 */
  color: HexColor;
  /** `X` 切过去的那支（"上一支笔的颜色"） */
  alternateColor: HexColor;
  /** `INK_BRUSH_WIDTHS` 的下标 */
  widthIndex: number;
}

export function defaultInkToolState(): InkToolState {
  return {
    color: DEFAULT_INK_COLOR,
    alternateColor: DEFAULT_INK_ALTERNATE_COLOR,
    widthIndex: DEFAULT_INK_WIDTH_INDEX,
  };
}

/**
 * 交换前后两支笔色（`X`）。
 *
 * ★ 交换而不是"轮换"：只有两个槽位时，`X` 按下第二次必须回到原色 ——
 *   用户对它的心智就是"来回来去"，不是"在调色板里转圈"。
 */
export function swapInkColors(state: InkToolState): InkToolState {
  return { ...state, color: state.alternateColor, alternateColor: state.color };
}

/**
 * 换一支笔色。
 *
 * ★ 被换下去的那支**变成"上一支"**：这样 `X` 的语义始终是"回到我刚才那个颜色"，
 *   与用户是"从调色板选的"还是"按 X 换的"无关。若反过来把用户选的色当作替换色，
 *   连着按两下 `X` 会得到一个他从没选过的颜色。
 */
export function withInkColor(state: InkToolState, color: HexColor): InkToolState {
  if (color === state.color) return state;
  return { color, alternateColor: state.color, widthIndex: state.widthIndex };
}

/** 档位下标夹到 `INK_BRUSH_WIDTHS` 的合法范围（非有限值回落到默认档） */
export function clampWidthIndex(index: number): number {
  if (!Number.isFinite(index)) return DEFAULT_INK_WIDTH_INDEX;
  return clamp(Math.round(index), 0, INK_BRUSH_WIDTHS.length - 1);
}

/** 换一档笔宽（`1`–`4`） */
export function withInkWidth(state: InkToolState, index: number): InkToolState {
  return { ...state, widthIndex: clampWidthIndex(index) };
}

/** 第 `index` 档的基准线宽（越界自动夹住） */
export function brushWidth(index: number): number {
  return INK_BRUSH_WIDTHS[clampWidthIndex(index)];
}

/**
 * 当前工具状态 → 一笔的样式（交给 `InkLayer` 落笔时用）。
 *
 * ★ `tool` 缺省 `'brush'`：老调用方（以及橡皮这种根本不落笔的工具）拿到的仍是
 *   与 T7.07 之前**逐字段相同**的那支笔 —— 新增一支笔不该改动既有那支的行为。
 * ★ 荧光笔与画笔共用**同一个调色板与同一排档位**：另起一套高亮色会让工具条长出一排
 *   "只在某支笔下才有意义"的色点，而"高亮色"本来就是"我这支笔现在的颜色"。
 */
export function inkStrokeStyle(state: InkToolState, tool: InkTool = 'brush'): InkStyle {
  const width = brushWidth(state.widthIndex);
  if (tool === 'marker') {
    return { color: state.color, width: width * INK_MARKER_WIDTH_SCALE, alpha: INK_MARKER_ALPHA };
  }
  return { color: state.color, width };
}

/**
 * 采样间距（**屏幕**像素）：指针每移动这么多才记一个点。
 *
 * ★ 阈值定在屏幕而不是世界：手感的粗细跟着**眼睛**走。若按世界像素定，
 *   放大到 4× 之后同样的手速会被记成 1/4 的点，曲线变成肉眼可见的折线。
 */
export const INK_SAMPLE_DISTANCE_PX = 2;

/**
 * 橡皮半径（屏幕像素）。
 *
 * 比指针本身大一圈：让用户必须"对得很准"才能擦掉一条 3px 的线，
 * 是这类工具最招人烦的地方。同样按屏幕定，缩放后手感一致。
 */
export const INK_ERASER_RADIUS_PX = 12;

/**
 * 世界坐标 + 压感 → 存进文件的那个点。
 *
 * ★ 压感**只在设备真的报的时候**才写第三个元素：鼠标永远不报（硬写成 0.5 会让所有
 *   鼠标笔迹变成半宽），而 `05 §3.5` 的 `DrawProps` 本来就把第三项定义成可选的
 *   （`[number, number, number?]`）—— 于是"有压感的笔"和"没压感的笔"是同一个格式，
 *   T3.08 读回来时不需要两套解析。
 */
export function toInkPoint(point: Point, pressure?: number): InkPoint {
  const tuple: InkPoint = [point.x, point.y];
  if (typeof pressure === 'number' && Number.isFinite(pressure)) tuple.push(clamp(pressure, 0, 1));
  return tuple;
}

/** 新笔画：一个点就是"点一下出一个圆点"（`points.length === 1` 时按圆点画） */
export function createStroke(point: Point, style: InkStyle, pressure?: number): InkPath {
  const alpha = normalizedAlpha(style.alpha);
  // ★ 半透明笔（荧光笔）**不记压感**（T7.08）。除了"高亮在纸上等宽"这个手感理由，
  //   更硬的一条在渲染侧：带压感 ⇒ 逐段描边（每段一个 lineWidth），而半透明的相邻段
  //   会在接缝处**叠深**，一条高亮变成一串深浅斑。不记压感 ⇒ `isTapered` 为假 ⇒
  //   整条路径一次描边 ⇒ 没有接缝可叠。规则只写在这里一处，下游零特判。
  const path: InkPath = {
    color: style.color,
    width: style.width,
    points: [alpha < 1 ? toInkPoint(point) : toInkPoint(point, pressure)],
  };
  if (alpha < 1) path.alpha = alpha;
  return path;
}

/**
 * 这一笔的不透明度（缺省 `1`，落在 `(0, 1]`）。判据见 `normalizedAlpha`。
 *
 * ★ 与 `pressureOf` 同一条约定：**缺省即"最常用的那个值"**，于是普通笔迹在文件里
 *   一个字节都不多。读老文件时也走这里 —— 没有 `alpha` 的老笔迹就是"不透明"。
 */
export function strokeAlpha(path: InkPath): number {
  return normalizedAlpha(path.alpha);
}

/**
 * 把 `alpha` 收敛成 `(0, 1]` 里的有限数；缺省 / 非法 / 非正 → `1`。
 *
 * ★ `0` 也当缺省，而不是"全透明"：`globalAlpha = 0` 画出来是**什么都没有**，
 *   而且不报任何错 —— 手改文件写出 `alpha: 0` 的人想要的多半是"别管这个字段"，
 *   不是"给我一支隐形的笔"。读盘侧（`validate.readAlpha`）也是这么判的，两处必须同判据。
 * ★ 非有限值同样当缺省：`globalAlpha` **不收** `Infinity` / `NaN`（按规范这次赋值被**静默忽略**、
 *   不报错），于是这一笔会拿着**上一次的透明度**画出去 —— 静默画错，比抛出来更难查。
 */
function normalizedAlpha(alpha: number | undefined): number {
  if (typeof alpha !== 'number' || !Number.isFinite(alpha)) return 1;
  if (alpha <= 0) return 1;
  return Math.min(alpha, 1);
}

/**
 * 这一笔是不是"半透明笔"（荧光笔，`T7.08`）。
 *
 * ★ 两个用处，**缺一不可**：落笔时不记压感、渲染时整条路径一次描边（理由见
 *   `createStroke`）。两处问的是同一件事，所以判据只该有一个。
 */
export function isTranslucent(path: InkPath): boolean {
  return strokeAlpha(path) < 1;
}

/**
 * `InkStyle.alpha` 的规范化（缺省 / 非法 / 非正 / 越界 → `1`，判据见 `normalizedAlpha`）。
 *
 * ★ 图层在 `setStyle` 时要用它兜底：线宽已经在那边兜住了"0 / NaN 会让笔画不可见"，
 *   不透明度是同一个坑（`alpha: 0` = 一支画不出东西的笔，而且**没有任何报错**）。
 */
export function styleAlpha(style: InkStyle): number {
  return normalizedAlpha(style.alpha);
}

/**
 * 该不该再记一个点：太近就丢掉。
 *
 * 丢的是"手抖"而不是"信息"：触控笔与高刷鼠标在静止时都会持续吐出几乎重合的点，
 * 全记下来只会在文件里堆出一串毫无意义的坐标。非有限值一律拒收。
 */
export function shouldAppendPoint(
  points: readonly InkPoint[],
  point: Point,
  minDistance: number,
): boolean {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return false;
  const last = points[points.length - 1];
  if (!last) return true;
  const distance = Math.hypot(point.x - last[0], point.y - last[1]);
  return distance >= Math.max(0, minDistance);
}

/** 点到线段的最短距离（线段之外的最近点是端点，靠把投影参数夹到 [0,1] 实现） */
export function distanceToSegment(point: Point, from: InkPoint, to: InkPoint): number {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(point.x - from[0], point.y - from[1]);

  const projection = ((point.x - from[0]) * dx + (point.y - from[1]) * dy) / lengthSq;
  const t = Math.max(0, Math.min(1, projection));
  return Math.hypot(point.x - (from[0] + t * dx), point.y - (from[1] + t * dy));
}

/**
 * 笔画到某点的最短距离（取每一段的最小值）。
 * 空笔画返回 `Infinity`（"哪儿都不在"），单点笔画退化成点距。
 */
export function distanceToStroke(points: readonly InkPoint[], point: Point): number {
  if (points.length === 0) return Number.POSITIVE_INFINITY;
  if (points.length === 1) {
    return Math.hypot(point.x - points[0][0], point.y - points[0][1]);
  }
  let nearest = Number.POSITIVE_INFINITY;
  for (let index = 1; index < points.length; index += 1) {
    nearest = Math.min(nearest, distanceToSegment(point, points[index - 1], points[index]));
  }
  return nearest;
}

/**
 * 被橡皮碰到的笔画下标（T3.06 的橡皮是**整笔删除**，不是擦掉像素）。
 *
 * ★ 为什么不做像素级擦除：`03 §2.7` 把笔画定义成**矢量路径**（"可缩放、可改色、
 *   可单删"）。像素擦除要么把矢量退化成位图（前两条当场作废），要么得做
 *   "路径求差 + 重新拟合"，那是另一个量级的算法。整笔删除是唯一与数据模型自洽的语义，
 *   而且用户一擦就知道发生了什么，不会有"越擦越糊"的意外。
 * ★ 判定阈值含半个笔宽：粗线本来就更好擦 —— 要求用户瞄准一条 20px 粗线的**中轴**，
 *   是在为工具的方便惩罚用户。
 *
 * 返回下标而不是过滤后的数组：调用方（图层）需要知道"哪几笔没了"才能算出脏区。
 */
export function strokesHitByEraser(
  paths: readonly InkPath[],
  point: Point,
  radius: number,
): number[] {
  const hits: number[] = [];
  for (let index = 0; index < paths.length; index += 1) {
    const path = paths[index];
    if (distanceToStroke(path.points, point) <= radius + path.width / 2) hits.push(index);
  }
  return hits;
}

/** 笔画的包围盒（含笔宽 —— 线是画在坐标两侧的，不算进去就会留下半截残影） */
export function strokeBounds(path: InkPath): Rect | null {
  const box = boundsOf(path.points.map(([x, y]) => ({ x, y, width: 0, height: 0 })));
  if (!box) return null;
  return expandRect(box, Math.max(0, path.width) / 2);
}

/**
 * 一组笔画的总包围盒（含笔宽）。一笔都没有时返回 `null` —— 调用方据此判断"没有内容"。
 *
 * ★ 先并点、再整体外扩（而不是逐笔外扩后取并集）：少一次 `expandRect` 分配 ——
 *   这个函数在落笔那一刻会被调用（算手绘卡的尺寸），也在每次渲染时被调用（算
 *   SVG 的 viewBox）。
 * ★ 两者只在所有笔宽相同时才逐像素相等；笔宽不同时这个版本**略大**
 *   （按最粗的那半笔宽去撑整个框）。略大是安全的那一侧：框大了只是笔迹在卡里
 *   略微内缩，框小了却会把笔迹裁掉。手绘卡总是一笔一张，所以实际用不到这个差别。
 */
export function strokesBounds(paths: readonly InkPath[]): Rect | null {
  const points: Rect[] = [];
  let half = 0;
  for (const path of paths) {
    half = Math.max(half, Math.max(0, path.width) / 2);
    for (const [x, y] of path.points) points.push({ x, y, width: 0, height: 0 });
  }
  const box = boundsOf(points);
  if (!box) return null;
  return expandRect(box, half);
}

/**
 * 世界坐标 → 笔画自己的坐标系（`origin` 是它所属手绘卡的左上角）。
 *
 * ★ 只有"拿一个外部点来比距离"这类运算才需要换算（橡皮命中判定）；渲染与包围盒
 *   都是平移不变的 —— 笔画搬进卡片内部之后几何一点没变，这正是敢把点存成
 *   卡片内坐标的底气。
 */
export function toStrokeSpace(point: Point, origin: Point): Point {
  return { x: point.x - origin.x, y: point.y - origin.y };
}

/**
 * 刚落下的这一段（`from` → `to`）覆盖的世界矩形，用来标脏。
 *
 * ★ 必须包含**前一个点到新点的整段**，而不只是新点：渲染出来的是一条线段，
 *   只把新点标脏会把刚画出来的线尾留在脏区之外 —— 表现就是"线画到一半断了"。
 * ★ `from` 为 `null`（这一笔的第一个点）时给出一个笔宽见方的小矩形：圆点也得被画上。
 */
export function segmentDirtyRect(from: InkPoint | null, to: Point, width: number): Rect {
  const penWidth = Math.max(0, width);
  const half = penWidth / 2;
  const minX = from ? Math.min(from[0], to.x) : to.x;
  const maxX = from ? Math.max(from[0], to.x) : to.x;
  const minY = from ? Math.min(from[1], to.y) : to.y;
  const maxY = from ? Math.max(from[1], to.y) : to.y;
  return {
    x: minX - half,
    y: minY - half,
    width: maxX - minX + penWidth,
    height: maxY - minY + penWidth,
  };
}

// ── 压感（T3.07 / `F4-02`）──────────────────────────────

/**
 * 点上的压感，夹进 `[INK_PRESSURE_MIN, 1]`。
 * 缺省 1 —— "这个设备不报压感"就等于"一直用满力"，这正是鼠标笔迹该有的样子。
 */
export function pressureOf(point: InkPoint): number {
  const value = point[2];
  if (typeof value !== 'number' || !Number.isFinite(value)) return 1;
  return clamp(value, INK_PRESSURE_MIN, 1);
}

/** 这一笔带不带压感（有任何一个点记过压力就算）。渲染层据此决定走不走逐段描边 */
export function isTapered(path: InkPath): boolean {
  return path.points.some((point) => typeof point[2] === 'number');
}

/** 第 `index` 个点处的**实际**线宽 = 基准线宽 × 压感 */
export function strokeWidthAt(path: InkPath, index: number): number {
  const base = Math.max(0, path.width);
  const point = path.points[index];
  return point ? base * pressureOf(point) : base;
}

/**
 * 第 `index` 段（`index-1` → `index` 点）用的线宽：取两端的**平均**。
 *
 * ★ 一段线只能有一个 `lineWidth`，而两端压力不同。取其一端会让相邻两段的粗细
 *   在同一个点上突变（看上去像打了个结）；取平均则把差异摊进段内，
 *   配合圆头相接，肉眼看不到台阶。
 */
export function segmentWidthAt(path: InkPath, index: number): number {
  if (index <= 0) return strokeWidthAt(path, 0);
  return (strokeWidthAt(path, index - 1) + strokeWidthAt(path, index)) / 2;
}

// ── 临时标注层（T7.07 / `F4-06`）────────────────────────

/**
 * 把一笔追加到一叠笔画后面（**返回新数组**，不改原数组）。
 *
 * ★ 不可变不是洁癖：暂存层里这一叠就是"内容的唯一一份"，而图层靠"哪块要重画"
 *   来省重绘。就地 `push` 之后旧引用也跟着变，**"脏区"与"内容"就对不上号了** ——
 *   表现是清掉一笔之后原地留一串残影（脏区是按旧内容算的）。
 * ★ 这条规则放在这里而不是 `InkLayer` 里：图层需要 2D 上下文，只能在真机上肉眼看；
 *   数组语义是纯逻辑，能在 node 下把"删错了下标""没命中却重建了数组"钉死。
 */
export function appendStroke(paths: readonly InkPath[], path: InkPath): InkPath[] {
  return [...paths, path];
}

/**
 * 删掉一叠笔画里指定的几笔（**整笔**删除，与橡皮同一语义）。
 *
 * ★ 没命中时返回**原引用**：调用方据此跳过重绘与脏区计算 —— 橡皮拖过去时，
 *   绝大多数 `pointermove` 都是"什么都没碰到"，每次都重建一遍数组纯属白费。
 */
export function removeStrokes(paths: InkPath[], indices: readonly number[]): InkPath[] {
  if (indices.length === 0) return paths;
  const drop = new Set(indices);
  return paths.filter((_, index) => !drop.has(index));
}
