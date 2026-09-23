/**
 * 连线的几何与模型操作（T1.68 / T1.70 / T1.71，`F3-01` / `F3-08` / `F3-09`）。
 *
 * 本文件只放**纯函数**：锚点怎么算、指针离哪条线最近、增删改连线。
 * 落盘 / 事件 / `revision` 由 `BoardRepository.mutate()` 负责（与 `ops.ts` 同一纪律），
 * 绘制归 `view/render/EdgeRenderer.ts`，手势归 `view/interact/ConnectController.ts`。
 *
 * ── 三条贯穿本文件的约定 ────────────────────────────────────
 *
 * 1. **锚点是派生的，绝不落盘**。`Edge` 里存的是 `cardId + side`（`03 §2` 的规范），
 *    端点像素坐标由卡片当前几何实时算出。存坐标就会在"卡片被拖动/被分栏重排"
 *    之后变成指向空气的线 —— 而重排路径有三条（拖动 / 收进分栏 / 撤销），
 *    没有任何一条能保证记得去改连线。
 *
 * 2. **`side === null` 表示"自动选边"**，而不是"没有边"。自动选边的判据是
 *    "两卡中心的连线上，主轴方向的那一侧"：左右分开就左右连，上下分开就上下连。
 *    `03 §2` 把 `null` 定义为自动，正是为了让"卡片挪到对方左边"时连线自动翻面。
 *
 * 3. **几何一律通过 `RectLookup` 取，而不是直接读 `card`**。拖动中的卡片在模型里
 *    还在原位（`DragController` 松手才提交），要画出"跟着手走的线"就必须能喂进
 *    临时矩形。让调用方给一个查矩形的函数，这件事就自然成立了（T1.70）。
 *
 * ★ 不 import `obsidian`、不碰 DOM —— 可在 node 下单测。
 */

import {
  clamp,
  rectCenter,
  rectContainsPoint,
  rotatePoint,
  roundTo,
  type Point,
  type Rect,
} from '../util/geometry';
import { endpointAnchorKey, isFreeEndpoint } from './schema';
import { routeOrthogonal } from './edgeRouting';
import type { BoardFile, Edge, EdgeCurve, EdgeEndpoint, EdgeSide } from './schema';

// ─────────────────────────────────────────────────────────────
// 锚点
// ─────────────────────────────────────────────────────────────

/** 非空边的方位。`EdgeSide` 去掉 `null`（`null` 是"自动"，不是方位） */
export type AnchorSide = Exclude<EdgeSide, null>;

/** 锚点方位全集。顺序 = 顺时针，UI 上摆四个点与绘制调试都按它来 */
export const ANCHOR_SIDES: readonly AnchorSide[] = ['top', 'right', 'bottom', 'left'];

export function isAnchorSide(value: unknown): value is AnchorSide {
  return value === 'top' || value === 'right' || value === 'bottom' || value === 'left';
}

/**
 * 卡片某一边的**中点**（世界坐标，未旋转）。四边中点是最稳定的锚点：卡片缩放时不会跑位。
 *
 * ★ 这是"卡片自己的坐标系"里的锚点，别直接拿去画线 —— 转过的卡片要用
 *   {@link cardAnchor} 再绕中心转一下。
 */
function baseAnchor(rect: Rect, side: AnchorSide): Point {
  switch (side) {
    case 'top':
      return { x: rect.x + rect.width / 2, y: rect.y };
    case 'bottom':
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height };
    case 'left':
      return { x: rect.x, y: rect.y + rect.height / 2 };
    case 'right':
      return { x: rect.x + rect.width, y: rect.y + rect.height / 2 };
  }
}

/**
 * 卡片某一边中点的世界坐标，**跟着卡片的旋转一起转**（T7.06）。
 *
 * ★ `deg` 是卡片自身的旋转角：转过的卡片上，"上边"说的是**转过去之后**的那条边。
 *   不转它的话连线会插进卡片里、或者浮在卡片外面 —— 一眼就能看出来的错位。
 * ★ 转的是"卡片局部坐标里的那个边中点"，于是 `deg = 90°` 的卡片，`top` 锚点落在
 *   视觉上的右边上：这正是我们要的语义（用户连的是"卡片的上边"，卡片转头，
 *   那条边跟着走）。
 * ★ `deg === 0`（绝大多数卡片）时零开销：`rotatePoint` 自己会早退。
 */
export function cardAnchor(rect: Rect, side: AnchorSide, deg = 0): Point {
  const point = baseAnchor(rect, side);
  return deg === 0 ? point : rotatePoint(point, rectCenter(rect), deg);
}

/**
 * 自动选边：`from` 该用哪条边去连 `to`。
 *
 * 取"中心连线的主轴"而不是"矩形间距最小的那一对边"：后者在斜向摆放的两张卡上
 * 会因为高宽比不同而左右横跳（稍微挪一下就从连右边变成连下边），
 * 主轴判定只在接近正对角线时翻面，观感稳定得多。
 */
export function autoAnchorSide(from: Rect, to: Rect): AnchorSide {
  const a = rectCenter(from);
  const b = rectCenter(to);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  // 中心完全重合（两张卡叠着）时给一个确定答案，免得每次重绘换一个方向
  if (dx === 0 && dy === 0) return 'right';
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left';
  return dy >= 0 ? 'bottom' : 'top';
}

/**
 * 按**端点几何键**（`endpointAnchorKey`）查当前几何；拿不到（已删 / 不可见）返回 `null`。
 *
 * ★ 一个查表函数同时服务四种端点，而不是"卡片查一个、分栏查一个、节点再查一个"：
 *   端点在几何上只是"一个矩形"，连线算法（锚点 / 路由 / 箭头）完全不需要知道
 *   对面是卡、是栏、是整棵脑图，还是脑图里的一个节点。
 *   这也是 `O21`（分栏成为端点）与 `2.2.0` 批 3（脑图节点成为端点）两次都只改
 *   端点来源、不动几何的原因。
 * ★ 键是**一层**的字符串：卡片 / 分栏 / 整棵脑图就是它们的 id，节点是
 *   `脑图id/节点id`（`schema.nodeEndpointKey`）—— 表因此不必嵌套。
 */
export type RectLookup = (endpointId: string) => Rect | null;

/**
 * 按卡片 id 查当前旋转角（度）；拿不到 = `0`（T7.06）。
 *
 * ★ 与 `RectLookup` 分开放，而不是让它返回 `{ rect, angle }`：查矩形的地方多得多
 *   （拖动预览、吸附、框选、导出全在用），为了一个只有连线用得到的角度去改
 *   那个类型，等于让所有调用点都多解一层结构。旋转是可选能力，就按可选参数给。
 */
export type AngleLookup = (cardId: string) => number;

export interface EdgeEndpoints {
  from: Point;
  to: Point;
  /** 实际生效的方位（`side` 为 `null` 时已解析成具体边）—— 画箭头、判断朝向都要用 */
  fromSide: AnchorSide;
  toSide: AnchorSide;
}

/**
 * 端点的"参照矩形"。
 *
 * 卡片端点用卡片当前几何；**自由端退化成零尺寸矩形**（就是以那个点为左上角）。
 *
 * ★ 为什么给自由端造一个假矩形，而不是在 `edgeEndpoints` 里到处 `if (自由端)`：
 *   自动选边（`autoAnchorSide`）和锚点计算（`cardAnchor`）都要求一个 `Rect`。
 *   零尺寸矩形喂进去之后，`rectCenter` 得到的就是那个点本身、`cardAnchor` 的
 *   四个边中点也**全部落在同一点**上 —— 于是自由端在几何上就是"一张退化成点的
 *   卡片"，既有公式原样成立，一行特判都不用加（`F3-02`）。
 */
function endpointRect(endpoint: EdgeEndpoint, rectOf: RectLookup): Rect | null {
  if (isFreeEndpoint(endpoint)) {
    const point = endpoint.point;
    // 自由端却没有坐标 = 数据坏了。宁可这条线不画，也不要在原点附近画一条乱线
    if (!point) return null;
    return { x: point.x, y: point.y, width: 0, height: 0 };
  }
  // ★ 查的是**端点的几何键**（`2.2.0` 批 3）：整卡 / 分栏 / 整棵脑图就是 `cardId`；
  //   脑图里的某个节点是 `脑图id/节点id` —— 三种身份共用这一张表，本文件不必知道
  //   它连的到底是什么，只认"一个键换一个矩形"（`O21` 那条纪律的延续）。
  // ★ 取不到（节点被删了 / 那份 `.nestmind` 还没读到）⇒ 这条线**一个字都不画**，
  //   而不是回落到 (0,0)：后者会在画布角落里画一条通往原点的乱线。
  return rectOf(endpointAnchorKey(endpoint));
}

/**
 * 解析一条连线的两端锚点。
 *
 * 任一端**取不到几何**（卡片被删 / 在别处，或自由端没带坐标）就返回 `null` ——
 * 调用方直接跳过这条线。这比"回落到 (0,0)"好：后者会在画布角落里画出一堆通往
 * 原点的乱线，看起来像插件坏了（`ops.removeCards` 会清理悬空边，但手改文件
 * 绕得过去）。
 */
export function edgeEndpoints(
  edge: Edge,
  rectOf: RectLookup,
  angleOf?: AngleLookup,
): EdgeEndpoints | null {
  const fromRect = endpointRect(edge.from, rectOf);
  const toRect = endpointRect(edge.to, rectOf);
  if (!fromRect || !toRect) return null;

  const fromSide = edge.from.side ?? autoAnchorSide(fromRect, toRect);
  const toSide = edge.to.side ?? autoAnchorSide(toRect, fromRect);
  // **树连线**（`F7`）的两端锚**卡片中心**（定稿：只连中心点，中段被卡片盖住 ⇒
  // "不与卡片重叠的部分才显示"由"连线层在卡片背后"白捡）。`side` 仍按自动选边
  // 给出：下游（箭头方向、标签落点）认的是"方位"，中心锚只是把**点**挪进去。
  if (edge.kind === 'tree') {
    return {
      from: rectCenter(fromRect),
      to: rectCenter(toRect),
      fromSide,
      toSide,
    };
  }
  return {
    from: cardAnchor(fromRect, fromSide, endpointAngle(edge.from, angleOf)),
    to: cardAnchor(toRect, toSide, endpointAngle(edge.to, angleOf)),
    fromSide,
    toSide,
  };
}

/**
 * 某个端点的卡片旋转角（T7.06）。
 *
 * ★ 自由端恒为 `0`：它就是一"个点"，没有横竖之分，也就没有"转一下"这回事。
 *   传进来的查角函数也就不用为自由端造一个假 id。
 * ★ 调用方没给 `angleOf`（老代码、只关心位置不关心角度的测试）→ 一律 `0`：
 *   退化成 T7.06 之前的行为，而不是抛错。
 */
function endpointAngle(endpoint: EdgeEndpoint, angleOf?: AngleLookup): number {
  if (!angleOf || isFreeEndpoint(endpoint)) return 0;
  return angleOf(endpoint.cardId);
}

// ─────────────────────────────────────────────────────────────
// 弧度（T7.12 / F3-07）
// ─────────────────────────────────────────────────────────────

/**
 * 弧度分量的绝对值上限（按线段长度归一化）。
 *
 * 4 = 控制点偏出线段长度的 4 倍。手拖是拖不到这个数的；给上限是为了"手改文件
 * 写了 `1e9`"时不至于让控制点跑到 1e12 的坐标上 —— Canvas 在那个数量级上
 * 既画不出东西也可能抛，而这条线本来只是想弯一点。
 */
export const EDGE_CURVE_LIMIT = 4;

/**
 * 弧度分量的落盘精度。
 *
 * 4 位小数在 1000px 的线段上是 0.1px —— 肉眼绝对看不出，而拖动会产生
 * 一长串 `0.3750000000000001` 这种浮点噪声，直接写进文件既难看也让
 * "两次拖动回到同一个位置"永远比不出相等（历史去重会失效）。
 */
const CURVE_DECIMALS = 4;

/**
 * 弧度分量的归一化（写入与读盘**共用这一份**）。
 *
 * ★ 0 值一律变成 `0`：`roundTo` 对负数会产出 `-0`，而 `-0` 写进 JSON 是 `0`、
 *   与 `0` 却不 `Object.is` 相等 —— 于是"同一份数据两次读进来不相等"，
 *   历史去重与快照对比都会莫名其妙地判成"变了"。
 */
function readCurveComponent(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const rounded = roundTo(clamp(value, -EDGE_CURVE_LIMIT, EDGE_CURVE_LIMIT), CURVE_DECIMALS);
  return rounded === 0 ? 0 : rounded;
}

/**
 * 弧度归一化：读不懂 / 分量非法 → `null`（= 直线）；两个分量都是 0 → 也是 `null`。
 *
 * ★ 返回 `null` 而不是 `{ along: 0, perp: 0 }`：直线就是**没有弧度**，
 *   写一个"两个 0 的弧度"进文件等于给每条直线上都留一个没用的键。
 * ★ 这个函数被 `validate.ts` 读盘与 `curveFromMidpoint` 写入两处调用 ——
 *   两边判据必须一模一样，否则会出现"拖出来的值写进去，读回来变成另一条线"。
 */
export function normalizeEdgeCurve(value: unknown): EdgeCurve | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as { along?: unknown; perp?: unknown };
  const along = readCurveComponent(raw.along);
  const perp = readCurveComponent(raw.perp);
  if (along === null || perp === null) return null;
  if (along === 0 && perp === 0) return null;
  return { along, perp };
}

/** 二次 Bezier 在参数 `t` 处的点 */
export function quadraticAt(p0: Point, control: Point, p2: Point, t: number): Point {
  const u = 1 - t;
  const a = u * u;
  const b = 2 * u * t;
  const c = t * t;
  return {
    x: a * p0.x + b * control.x + c * p2.x,
    y: a * p0.y + b * control.y + c * p2.y,
  };
}

/**
 * 弧度的**控制点**（世界坐标）。`curve` 缺席 / 两端重合 → `null`（就是直线）。
 *
 * 控制点 = 中点 + `along` × 线段长度 × 方向 + `perp` × 线段长度 × 垂直方向。
 * 垂直方向取"方向向量转 90°"（`(-dy, dx)`），与 `EdgeRenderer.drawArrowHead`
 * 里算箭头两翼用的是同一个转向 —— 两处不一致的话，往右拖出来的弯会画到左边去。
 */
export function curveControl(
  from: Point,
  to: Point,
  curve: EdgeCurve | null | undefined,
): Point | null {
  if (!curve) return null;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return null;
  const ux = dx / length;
  const uy = dy / length;
  const px = -uy;
  const py = ux;
  const offset = curve.along * length;
  const side = curve.perp * length;
  return {
    x: (from.x + to.x) / 2 + ux * offset + px * side,
    y: (from.y + to.y) / 2 + uy * offset + py * side,
  };
}

/**
 * "拉直"的死区：控制点离**弦所在直线**多近就当作没有弧度（世界像素）。
 *
 * ★ 这个死区不是可有可无的宽容。用户把弯拽回来的终点是"看着直了"，
 *   而"看着直"在数值上几乎不可能正好是 0 —— 没有死区的话，一条笔直的线上
 *   会永远挂着一个 0.0001 的弧度："拉直"菜单项一直亮着，而用户再拖也拖不掉它。
 * ★ 4px（控制点）= 曲线中点离弦 2px。100% 缩放下手柄是个 13px 的圆点，
 *   这个量级在视觉上等于"把圆点放回线上"，而不是"要你像素级对准"。
 */
const CURVE_FLATTEN_PX = 4;

/**
 * 由"想把曲线中点拖到 `mid`"反算弧度分量（拖手柄时用）。
 *
 * 二次 Bezier 在 `t = 0.5` 处是 `(P0 + 2C + P2) / 4`，所以把一个点放到 `mid`
 * 需要把它**推出弦长的两倍**：`C = 弦中点 + 2 × (mid − 弦中点)`。
 * 这条"两倍"是手柄与线之间唯一的耦合 —— 写错的话手柄会与线错开一半距离。
 *
 * ★ 判"拉直"只看**垂直分量**：控制点沿弦滑动（`perp = 0`）时曲线整体仍然
 *   落在弦上，只是描边来回压了一遍 —— 看着就是直线。这种（以及中点离弦
 *   不到 2px 的）一律返回 `null`，而不是留一个"看着直却写着 curve"的键。
 * ★ 读盘（`normalizeEdgeCurve`）**不做**这一层判断：那边只管"读不读得懂"。
 *   反过来做（读盘也按像素拉直）会让手改文件里一个 3px 的弯被静默抹平。
 */
export function curveFromMidpoint(from: Point, to: Point, mid: Point): EdgeCurve | null {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return null;
  const ux = dx / length;
  const uy = dy / length;
  const px = -uy;
  const py = ux;
  // 控制点相对**弦中点**的偏移 = 2 ×（中点相对弦中点的偏移）
  const cx = (mid.x - (from.x + to.x) / 2) * 2;
  const cy = (mid.y - (from.y + to.y) / 2) * 2;
  const along = (cx * ux + cy * uy) / length;
  const perp = (cx * px + cy * py) / length;
  if (Math.abs(perp) * length <= CURVE_FLATTEN_PX) return null;
  return normalizeEdgeCurve({ along, perp });
}

/**
 * 一条线**画出来的那条路径**（T7.11 / T7.12）。
 *
 * ★ 为什么不是一个 `Point[]`：弧线是"起点 / 控制点 / 终点"三个点（二次 Bezier），
 *   而正交走线也可能**恰好**只有三个点（拐一个弯）。同一串点在这里是两种截然不同
 *   的几何 —— 用"点数 == 3 就是弧线"去猜的话，L 形的 Smart 线会被画成一条圆弧，
 *   命中、框选、标签落点也跟着按圆弧算。所以类型上就把两者分开，长度不再是判据。
 * ★ 形状只有这一个来源：绘制、命中、框选、脏区、导出（PNG / SVG）全从 `EdgePath`
 *   出发 —— 各算一遍的话，"看着在这条线上、点下去选不中"会以多种形式冒出来。
 */
export interface EdgePath {
  kind: 'curve' | 'polyline';
  /** 描边要走的点：`curve` 恒为 3 个（起点 / 控制点 / 终点），`polyline` 是折点序列 */
  points: Point[];
}

/** 二次 Bezier 路径（`control` 是控制点） */
export function curvePath(from: Point, control: Point, to: Point): EdgePath {
  return { kind: 'curve', points: [from, control, to] };
}

/** 折线路径（含 2 点的直线） */
export function polylinePath(points: Point[]): EdgePath {
  return { kind: 'polyline', points };
}

/**
 * 两个锚点之间的路径：有弧度就是弧线，否则是直线。
 *
 * ★ 只看 `curve` 决定 `kind` —— 不要按"几个点"反推（见 `EdgePath` 的注释）。
 */
export function edgePathPoints(
  from: Point,
  to: Point,
  curve: EdgeCurve | null | undefined,
): EdgePath {
  const control = curveControl(from, to, curve);
  return control ? curvePath(from, control, to) : polylinePath([from, to]);
}

/** 二次 Bezier 折线近似的段数。16 段在 1000px 线段上门均 60px，远小于命中容差 */
const CURVE_SAMPLES = 16;

/** 把路径拆成折线段序列（弧线采样成 `CURVE_SAMPLES` 段） */
function pathSegments(path: EdgePath): Array<[Point, Point]> {
  const points = path.points;
  const segments: Array<[Point, Point]> = [];
  if (path.kind === 'polyline') {
    for (let index = 1; index < points.length; index++) {
      segments.push([points[index - 1], points[index]]);
    }
    return segments;
  }
  const [p0, control, p2] = points;
  let prev = p0;
  for (let i = 1; i <= CURVE_SAMPLES; i++) {
    const next = quadraticAt(p0, control, p2, i / CURVE_SAMPLES);
    segments.push([prev, next]);
    prev = next;
  }
  return segments;
}

/** 点到一条线（直线 / 弧线 / 折线）的最短距离 */
export function pointEdgeDistance(point: Point, path: EdgePath): number {
  let best = Infinity;
  for (const [a, b] of pathSegments(path)) {
    best = Math.min(best, pointSegmentDistance(point, a, b));
  }
  return best;
}

/** 一条线是否与矩形相交（框选选连线用） */
export function edgeIntersectsRect(path: EdgePath, rect: Rect): boolean {
  for (const [a, b] of pathSegments(path)) {
    if (segmentIntersectsRect(a, b, rect)) return true;
  }
  return false;
}

/**
 * 弧线的中点（二次 Bezier 的 `t = 0.5`）。
 *
 * ★ 弧线走 `t = 0.5`：对二次 Bezier 来说那正好是**弧长的中点**，
 *   而拉直 / 拉弯时这个点就是用户拖的那个点 —— 两者必须是同一个点，
 *   否则"拖了手柄，标签跑到别处去了"。
 * ★ 折线（T7.11 的走线）**不能**用这个函数：它没有"参数 t"可言，
 *   拿前三个点当一条曲线算会让标签落到线外。那种路径用 {@link polylineMidpoint}。
 */
export function pathMidpoint(points: readonly Point[]): Point {
  if (points.length <= 2) {
    return { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 };
  }
  return quadraticAt(points[0], points[1], points[2], 0.5);
}

/**
 * 折线上**按长度走到一半**的那个点（Smart 走线的标签落点）。
 *
 * ★ 与 `pathMidpoint` 的分工必须清楚：两者的参数长得一样（一串点），
 *   但一个是"二次 Bezier 的参数中点"，一个是"折线的长度中点"。
 *   混用不会有异常，只会让标签静静地落在离线路几十像素的地方 ——
 *   一眼能看见，但很难联想到"中点算错了"。
 */
export function polylineMidpoint(points: readonly Point[]): Point {
  if (points.length === 0) return { x: 0, y: 0 };
  if (points.length === 1) return points[0];
  if (points.length === 2) {
    return { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 };
  }
  const half = polylineLength(points) / 2;
  let walked = 0;
  for (let index = 1; index < points.length; index++) {
    const a = points[index - 1];
    const b = points[index];
    const segment = Math.hypot(b.x - a.x, b.y - a.y);
    if (walked + segment >= half) {
      const t = segment === 0 ? 0 : (half - walked) / segment;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    walked += segment;
  }
  return points[points.length - 1];
}

/**
 * 一条线**画出来的那条路径**的中点 —— 标签落点的唯一入口。
 *
 * ★ 分支判据是 `path.kind`，也就是 `edgePathPoints` 造路径时的判据本身：
 *   换成在别处按 `routing === 'smart'` 再判一次，两处一旦分叉，就会出现
 *   "Smart 线的标签落在直线中点、而线在旁边绕"。
 */
export function edgePathMidpoint(path: EdgePath): Point {
  return path.kind === 'polyline' ? polylineMidpoint(path.points) : pathMidpoint(path.points);
}

/** 路径的包围盒（脏区裁剪用；弧线把控制点也框进去，一定盖得住真实曲线） */
export function pathBounds(path: EdgePath): Rect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of path.points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

// ─────────────────────────────────────────────────────────────
// 路径装饰（箭头收缩 / 端点切线）
//
// 画布（`EdgeRenderer`）、PNG 导出、SVG 导出共用这一份。
// ★ 三处各写一遍是最容易分叉的地方：画布上箭头离卡片 9px、导出的图上贴着卡片，
//   这种差异没人会去查，但一眼就能看出来"导出跟画布不一样"。
//   弧线在这三处取的点集完全相同（`edgePathPoints` / `edgePolyline`），
//   所以只要切线也是同一份算法，三个渲染目标就会像素级一致。
// ─────────────────────────────────────────────────────────────

/** 两点间单位方向；重合时退化成 `(1, 0)`（不垂直于任何方向，安全） */
export function directionOf(from: Point, to: Point): Point {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return { x: 1, y: 0 };
  return { x: dx / length, y: dy / length };
}

/** 折线长度（弧线按控制点折线量，略大于真长 —— 用来夹收缩量正合适） */
export function polylineLength(points: readonly Point[]): number {
  let total = 0;
  for (let index = 1; index < points.length; index++) {
    total += Math.hypot(
      points[index].x - points[index - 1].x,
      points[index].y - points[index - 1].y,
    );
  }
  return total;
}

/**
 * 两端点处的**切线**方向（单位向量，指向路径内部）。
 *
 * ★ 不能用"两端相连的那个方向"：弧线端点的切线不指向另一端，用它收缩会让箭头
 *   与线错开一个小小的夹角（近看就是箭头歪了）。
 */
export function polylineEndDirections(points: readonly Point[]): { from: Point; to: Point } {
  const last = points.length - 1;
  return {
    from: directionOf(points[0], points[Math.min(1, last)]),
    to: directionOf(points[last], points[Math.max(0, last - 1)]),
  };
}

/**
 * 按 `shrink` 把指定的一端沿切线收进来一点（不画箭头的那端不动）。
 *
 * ★ 弧线只在端点沿切线平移，几何上会与真实曲线差开几个像素 —— 收缩量本来
 *   就只有箭头那么长（9px），肉眼看不出来，而"端点上长出一个小钩"要难看得多。
 * ★ 返回**新数组**：调用方手里那份点集还要用来摆箭头尖端，不能被改。
 */
export function shrinkPolylineEnd(
  points: readonly Point[],
  end: 'from' | 'to',
  shrink: number,
  direction: Point,
): Point[] {
  const out = points.slice();
  if (end === 'from') {
    out[0] = { x: points[0].x + direction.x * shrink, y: points[0].y + direction.y * shrink };
    return out;
  }
  const last = points.length - 1;
  // ★ 与 `from` 分支同为 `+`：`direction` 是"指向路径内部"的单位向量，
  //   两端都朝里收才叫"收缩"。写成 `-` 的话末端会**向外**长出一截箭头那么长的小尾巴。
  out[last] = {
    x: points[last].x + direction.x * shrink,
    y: points[last].y + direction.y * shrink,
  };
  return out;
}

/**
 * 卡片矩形 → 路由要绕开的障碍表（T7.11）。
 *
 * ★ 顺序无关（路由只做几何求交），但保持入参顺序，好让同一块板每次算出的
 *   路由结果逐字节一致 —— 否则"同一块板导出两次给两个文件"会被误当成 bug。
 * ★ 取不到矩形的卡片（悬空引用）直接跳过：路由把 `null` 当障碍会崩，
 *   而当"不存在"处理与绘制那边的 `if (rect)` 是同一个判据。
 */
export function obstacleRects(ids: readonly string[], rectOf: RectLookup): Rect[] {
  const out: Rect[] = [];
  for (const id of ids) {
    const rect = rectOf(id);
    if (rect) out.push(rect);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// 命中测试（T1.71）
// ─────────────────────────────────────────────────────────────

/** 点到线段的最短距离。命中测试与"框选沾到线"共用这一份 */
export function pointSegmentDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  // 退化成一点（两端锚点重合）：距离就是点到该点的距离
  if (lengthSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  // 投影参数钳制到 [0,1] = 落在线段内，而不是落在无限长的直线上
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** 线段是否穿过矩形（框选选连线用） */
export function segmentIntersectsRect(a: Point, b: Point, rect: Rect): boolean {
  if (rectContainsPoint(rect, a) || rectContainsPoint(rect, b)) return true;

  // 先按包围盒粗筛：绝大多数连线在这一步就被排除了，不必做四次求交
  if (
    Math.max(a.x, b.x) < rect.x ||
    Math.min(a.x, b.x) > rect.x + rect.width ||
    Math.max(a.y, b.y) < rect.y ||
    Math.min(a.y, b.y) > rect.y + rect.height
  ) {
    return false;
  }

  const left = rect.x;
  const right = rect.x + rect.width;
  const top = rect.y;
  const bottom = rect.y + rect.height;
  return (
    segmentsIntersect(a, b, { x: left, y: top }, { x: right, y: top }) ||
    segmentsIntersect(a, b, { x: right, y: top }, { x: right, y: bottom }) ||
    segmentsIntersect(a, b, { x: right, y: bottom }, { x: left, y: bottom }) ||
    segmentsIntersect(a, b, { x: left, y: bottom }, { x: left, y: top })
  );
}

/** 线段求交（含共线/端点相接）。用叉积符号判定两条线段是否真的跨过对方 */
function segmentsIntersect(p1: Point, p2: Point, p3: Point, p4: Point): boolean {
  const d1 = cross(p3, p4, p1);
  const d2 = cross(p3, p4, p2);
  const d3 = cross(p1, p2, p3);
  const d4 = cross(p1, p2, p4);
  return d1 * d2 <= 0 && d3 * d4 <= 0;
}

function cross(a: Point, b: Point, c: Point): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

/**
 * Smart 路由要绕开的卡片矩形来源（世界坐标）。
 *
 * ★ 允许是**函数**：障碍表要遍历场上的每一张卡，而绘制侧是逐条线循环的 ——
 *   一张全是 free 连线的板子不该为"可能存在的智能路由"付这份钱（`02 §8.2`）。
 *   给了函数时，只有真的走到 smart 分支才会调它。
 *   （命中 / 导出侧手里本来就有现成的数组，直接给数组即可。）
 * ★ 必须与**绘制时**喂进去的是同一份，否则"看到绕开了、点下去选的是直线"。
 *   绘制与命中两边都从同一张卡片表（视觉几何）里建，所以天然一致。
 */
export type ObstacleSource = readonly Rect[] | (() => readonly Rect[]);

/**
 * 命中测试 / 框选的可选上下文（T7.11 / T7.12）。
 *
 * ★ 做成**可选参数**而不是把 `rectOf` 换成一个大对象：这两个函数的老调用点
 *   （老测试、只关心位置的地方）一行都不用改 —— 不给角度就是 `0`、
 *   不给障碍就是"不绕"，退化成加弧度 / 路由之前的行为。
 */
export interface EdgeHitOptions {
  /** 卡片旋转角（T7.06）：转过的卡片上，锚点在别处 */
  angleOf?: AngleLookup;
  /** Smart 路由要绕开的卡片矩形（见 {@link ObstacleSource}） */
  obstacles?: ObstacleSource;
}

/**
 * 算一条线的路径所需的可选上下文（在命中上下文之上多一个弧度覆盖）。
 *
 * ★ 弧度做成**覆盖**而不是把 `curve` 拼进 `Edge`：拖动中模型还没变
 *   （松手才提交），而线要立刻跟着手弯 —— 与 `EdgeRendererOptions` 里那三张
 *   覆盖表（矩形 / 角度 / 弧度）是同一条约定。
 */
export interface EdgePathOptions extends EdgeHitOptions {
  /**
   * 覆盖模型上的 `edge.curve`（`null` = 拉直）。
   * **不传**（`undefined`）才用模型里的值 ——
   * 与"表里有这个键才算覆盖"同一个判据，`??` 会把"显式拉直"吃成"用模型值"。
   */
  curve?: EdgeCurve | null;
}

/** 解析障碍表：给了函数就**到这一刻才**建（见 {@link ObstacleSource}） */
function readObstacles(source: ObstacleSource | undefined): readonly Rect[] {
  if (!source) return [];
  return typeof source === 'function' ? source() : source;
}

/**
 * 一条线**实际被画成的那条路径**（T7.11 / T7.12）。
 *
 * 有弧度是弧线，否则是直线；Smart 路由是一串正交折点（可能恰好 3 个点 ——
 * 所以形状由 `EdgePath.kind` 说清楚，不靠点数猜）。绘制、命中、框选、导出
 * 全走这一个入口 —— 四处各算一遍的话，"看着在这条线上、点下去选不中"
 * 会以四种不同的形式冒出来。
 */
export function edgePolyline(
  edge: Edge,
  options: EdgePathOptions & { rectOf: RectLookup },
): EdgePath | null {
  const endpoints = edgeEndpoints(edge, options.rectOf, options.angleOf);
  if (!endpoints) return null;
  const curve = options.curve === undefined ? edge.curve : options.curve;
  if (edge.routing === 'smart') {
    const routed = routeOrthogonal(
      endpoints.from,
      endpoints.fromSide,
      endpoints.to,
      endpoints.toSide,
      readObstacles(options.obstacles),
    );
    if (routed) return polylinePath(routed);
    // 路由不出来（两端重合 / 没有可走的通道）→ 退回直线。
    // ★ 宁可画一条穿过卡片的直线，也不要"这条线看不见了"
  }
  // 「曲线」走线（`F3-08`）：手工拖过中点就听手工的，否则用一条**自动的弧**。
  // ★ 形状仍然只经过 `edgePathPoints` 这一处 ⇒ 绘制 / 命中 / 框选 / 脏区 /
  //   两种导出**一个字节都不用改**（它们本来就认 `kind: 'curve'`）。
  const effective = curve ?? (edge.routing === 'curve' ? DEFAULT_EDGE_CURVE : null);
  return edgePathPoints(endpoints.from, endpoints.to, effective);
}

/**
 * 「曲线」走线的默认弧度：控制点从中点**垂直**偏移，取线段长度的 18%。
 *
 * ★ 与手工拖出来的是**同一个类型**（`EdgeCurve`，两个分量都按线段长度归一化）：
 *   于是"自动的弧"与"拖出来的弧"在下游完全一样，不存在两套几何。
 * ★ 为什么按**比例**而不是固定像素：线长 2000px 时固定 40px 看起来就是一条直线，
 *   而在短线（80px）上同一段又会拱成一个包。18% 是"看得出是弧、又不至于绕一圈"的量级。
 * ★ `along` 恒为 0：弧的最高点落在两端中点上 —— 标签也落在那儿，与直线一致，
 *   于是"给一条直线切到曲线"时标签不会跳一下。
 * ★ 正负号决定往哪一侧拱：取正即可（与手工拖出来的弧同向），
 *   用户不满意就拖中点自己改，改完存的是他那条弧。
 */
const DEFAULT_EDGE_CURVE: EdgeCurve = { along: 0, perp: 0.18 };

/**
 * 命中离指针最近的一条连线。
 *
 * `tolerance` 是**世界坐标**下的容差，由调用方按缩放换算（屏幕上 8px 的
 * 宽容度，在 25% 缩放下等于世界坐标里的 32px）。写死成世界数值的话，
 * 缩得越小越难选中 —— 而缩小时恰恰是最需要靠连线看结构的时候。
 *
 * ★ 取"最近"而不是"最先命中"：线宽再细，重叠区也可能有几条线交错，
 *   用最近的那条才符合"我指着哪根就选哪根"的直觉。
 */
export function hitTestEdge(
  edges: readonly Edge[],
  rectOf: RectLookup,
  point: Point,
  tolerance: number,
  options: EdgeHitOptions = {},
): Edge | null {
  let best: Edge | null = null;
  let bestDistance = tolerance;
  for (const edge of edges) {
    const points = edgePolyline(edge, { rectOf, ...options });
    if (!points) continue;
    const distance = pointEdgeDistance(point, points);
    // 严格小于：重叠处先出现的那条赢，选择结果稳定（同一像素反复点不会来回跳）
    if (distance < bestDistance) {
      bestDistance = distance;
      best = edge;
    }
  }
  return best;
}

/** 与矩形有交集的连线（框选，F3-08） */
export function edgesIntersecting(
  edges: readonly Edge[],
  rectOf: RectLookup,
  rect: Rect,
  options: EdgeHitOptions = {},
): Edge[] {
  const hits: Edge[] = [];
  for (const edge of edges) {
    const points = edgePolyline(edge, { rectOf, ...options });
    if (!points) continue;
    if (edgeIntersectsRect(points, rect)) hits.push(edge);
  }
  return hits;
}

// ─────────────────────────────────────────────────────────────
// 模型操作
// ─────────────────────────────────────────────────────────────

export function edgeById(board: BoardFile, id: string): Edge | null {
  return board.edges.find((edge) => edge.id === id) ?? null;
}

export function edgesOfCard(board: BoardFile, cardId: string): Edge[] {
  return board.edges.filter((edge) => edge.from.cardId === cardId || edge.to.cardId === cardId);
}

/**
 * 清掉"指向某棵脑图里**已经不存在的节点**"的连线（`2.2.0` 批 3）。
 *
 * ★ 与 `removeCards` 那条纪律同源：被删掉的东西不该在文件里留一堆看不见的线
 *   （画不出来、又删不掉，只能手改 `.nboard`）。
 * ★ 只在**真的知道节点清单**的时候调（内嵌脑图改完模型之后，见 `setMindModel`）：
 *   文件脑图在标签页里被改（不经过白板）时清单是另一份，这里不猜 ——
 *   那边删掉的节点对应的线会"画不出来但仍然在文件里"，用户把节点加回来它就回来了
 *   （这反而是对的：撤销一次编辑不该顺手把线也删掉）。
 * ★ 只清**这一棵**的节点端点：别的脑图、卡片、分栏、自由端的线一律不动。
 */
export function pruneMindNodeEdges(
  board: BoardFile,
  mindId: string,
  aliveNodeIds: ReadonlySet<string>,
): boolean {
  const before = board.edges.length;
  const dangling = (endpoint: EdgeEndpoint): boolean =>
    endpoint.cardId === mindId &&
    endpoint.nodeId !== undefined &&
    !aliveNodeIds.has(endpoint.nodeId);
  board.edges = board.edges.filter((edge) => !dangling(edge.from) && !dangling(edge.to));
  return board.edges.length !== before;
}

/** 两个端点是否指向**同一个目标**（同一张卡 / 同一栏 / 同一棵脑图里的同一个节点） */
function sameAnchorTarget(a: EdgeEndpoint, b: EdgeEndpoint): boolean {
  // ★ 节点端点多比一层（`2.2.0` 批 3）：少了它，"同一棵脑图的两个不同节点之间连一条线"
  //   会被当成自环丢掉，而"同一个节点连自己"又会被当成一条合法的线放进来 —— 两头都错。
  if (a.cardId !== b.cardId) return false;
  return (a.nodeId ?? '') === (b.nodeId ?? '');
}

/** 两个端点是否指向同一对卡片、同一对方位（查重用） */
function sameEndpoint(a: EdgeEndpoint, b: EdgeEndpoint): boolean {
  if (!sameAnchorTarget(a, b) || a.side !== b.side) return false;
  // 自由端（T2.07 / `F3-02`）的身份就是**那个坐标**：`cardId` 都是空串，
  // 只比空串的话，从同一张卡拉向三个不同方向的注释线会被判成"重复"，
  // 后拉的两条静默消失
  if (!isFreeEndpoint(a)) return true;
  if (!a.point || !b.point) return false;
  return a.point.x === b.point.x && a.point.y === b.point.y;
}

/**
 * 端点是否指向一个**存在的端点对象**（卡片 / 分栏 / 脑图，`O21` + `2.2.0`）。
 * 自由端不参与这项检查（它本来就不绑任何东西）。
 *
 * ★ 只查 `cardId` 那一层：节点这一层**故意不查** —— 节点清单在另一份模型里，
 *   而 `.nestmind` 可能还没读到（见 `EdgeEndpoint.nodeId` 那条）。真取不到节点，
 *   绘制时自然什么都不画，数据却还在。
 */
function endpointAlive(endpoint: EdgeEndpoint, alive: ReadonlySet<string>): boolean {
  return isFreeEndpoint(endpoint) || alive.has(endpoint.cardId);
}

/**
 * 这块板上**能当端点**的对象 id（卡片 ∪ 分栏 ∪ 脑图，`O21` / `2.2.0`）。
 *
 * ★ 抽出来给"加线"与"改端点"（{@link setEdgeEndpoint}）**共用**：两处各拼一遍的话，
 *   迟早出现"拉新线能连到脑图、改端点却改不过去"这种只在一条路上复现的怪事。
 */
export function aliveEndpointIds(board: BoardFile): Set<string> {
  const alive = new Set<string>();
  for (const card of board.cards) alive.add(card.id);
  for (const column of board.columns) alive.add(column.id);
  // ★ 脑图（`2.2.0`）也是合法端点：少收它，从节点上拉出来的线会在**加进来的那一刻**
  //   被这道校验静静丢掉 —— 界面上就是"拖了没反应"（自由端当年踩过同一个坑）。
  for (const mind of board.minds ?? []) alive.add(mind.id);
  return alive;
}

/**
 * 加连线。返回 `false` 表示"一条都没真的加进来"。
 *
 * 三道过滤，全部是**非法或无语义**的情况：
 *  * 自环（`from.cardId === to.cardId`）：锚点重合，画出来是一个点，用户只会以为没连上；
 *  * 指向不存在的端点对象：文件一旦这样写，下次打开就是一条通往 (0,0) 的线；
 *  * 端点完全重复的已有连线：反复拖同一条会静默叠出十几条一模一样的线，
 *    删一条还有九条，用户找不到"为什么删不掉"。
 *
 * ★ **自由端（T2.07 / `F3-02`）不参与前两道**。它的 `cardId` 是空串，而空串
 *   `alive.has()` 永远为假 —— 不特判的话，用户每拉一条指向空地的线都会被这里
 *   静默丢掉，"自由端"这个功能就是完全不生效的（界面上表现为"拖了没反应"）。
 * ★ **合法端点是"卡片 ∪ 分栏"**（`O21`）：字段仍叫 `cardId`，因为两种端点在几何上
 *   没有区别（`RectLookup` 只认矩形），而多开一个字段会让每条线两端各长出一次判分支。
 *   两个集合**必须**在这里拼齐 —— 少收分栏，从栏上拉出的线会被这道校验静默丢掉
 *   （界面上表现为"从分栏拖线没反应"，与自由端当年踩过的那个坑一模一样）。
 */
export function addEdges(board: BoardFile, edges: readonly Edge[]): boolean {
  if (edges.length === 0) return false;
  const alive = aliveEndpointIds(board);

  let added = false;
  for (const edge of edges) {
    // 两端都是自由端时 `'' === ''`，但那不是自环 —— 是画布上一条独立的线
    // ★ 自环判的是**同一个目标**（节点端点多比一层）：同一棵脑图里两个不同节点之间的线
    //   是合法的，而同一个节点连自己是自环（见 `sameAnchorTarget`）
    if (!isFreeEndpoint(edge.from) && sameAnchorTarget(edge.from, edge.to)) continue;
    if (!endpointAlive(edge.from, alive) || !endpointAlive(edge.to, alive)) continue;
    const duplicate = board.edges.some(
      (existing) => sameEndpoint(existing.from, edge.from) && sameEndpoint(existing.to, edge.to),
    );
    if (duplicate) continue;
    board.edges.push(edge);
    added = true;
  }
  return added;
}

/**
 * 端点重拖的目标（`2.2.0` · O1）：绑到某个对象上，或落成**自由端**。
 *
 * ★ `key` 是"白板级对象 id"那一格（卡片 / 分栏 / 脑图，与 `EdgeEndpoint.cardId` 同义），
 *   `nodeId` 只在连到**脑图节点**时给。
 */
export type EdgeEndpointTarget =
  { key: string; side: AnchorSide | null; nodeId?: string } | { key: null; point: Point };

/**
 * 改一条线**某一端的落点**（`2.2.0` · O1 端点重拖）。
 *
 * @param end `'from'` / `'to'`：改哪一端
 * @returns 真的改了才 `true`（没变化 / 非法都返回 `false`，调用方据此不写历史）
 *
 * ★ 合法性规则与 {@link addEdges} **同一套**（不是"看起来差不多"）：端点必须活着、
 *   不能自环、不能与已有连线完全重复。改端点这条路如果比"拉新线"宽一点，
 *   用户就会得到"能用重拖做出拉不出来的线"这种只能靠猜的差异。
 * ★ 两端都是自由端时不算自环（它们是画布上独立的两条线）—— 与 `addEdges` 同一条注释。
 */
export function setEdgeEndpoint(
  board: BoardFile,
  edgeId: string,
  end: 'from' | 'to',
  target: EdgeEndpointTarget,
): boolean {
  const edge = board.edges.find((item) => item.id === edgeId);
  if (!edge) return false;

  const other = end === 'from' ? edge.to : edge.from;
  const next: EdgeEndpoint =
    target.key === null
      ? { cardId: '', side: null, point: { x: target.point.x, y: target.point.y } }
      : {
          cardId: target.key,
          side: target.side,
          ...(target.nodeId === undefined ? {} : { nodeId: target.nodeId }),
        };

  if (target.key !== null && !endpointAlive(next, aliveEndpointIds(board))) return false;
  if (!isFreeEndpoint(other) && sameAnchorTarget(next, other)) return false;
  if (sameEndpoint(edge[end], next)) return false;

  // 重复线：与 `addEdges` 同一条（否则重拖能造出两条一模一样的线）
  const nextFrom = end === 'from' ? next : edge.from;
  const nextTo = end === 'to' ? next : edge.to;
  const duplicate = board.edges.some(
    (item) =>
      item.id !== edgeId && sameEndpoint(item.from, nextFrom) && sameEndpoint(item.to, nextTo),
  );
  if (duplicate) return false;

  edge[end] = next;
  return true;
}

/** 删连线。id 不存在时返回 `false`（不产生"无变化的写入"） */
export function removeEdges(board: BoardFile, ids: readonly string[]): boolean {
  if (ids.length === 0) return false;
  const targets = new Set(ids);
  const before = board.edges.length;
  board.edges = board.edges.filter((edge) => !targets.has(edge.id));
  return board.edges.length !== before;
}

/** 可写的连线字段（端点归属不改 —— "改接到另一张卡"在交互上等于删了重连） */
export interface EdgePatch {
  fromEnd?: Edge['fromEnd'];
  toEnd?: Edge['toEnd'];
  style?: Edge['style'];
  color?: Edge['color'];
  label?: Edge['label'];
  routing?: Edge['routing'];
  /** `null` = **拉直**（删掉 `curve` 键）。见 `updateEdges` 对 `null` 的约定 */
  curve?: EdgeCurve | null;
}

/**
 * 批量改连线字段。逐字段比对，全等时返回 `false`。
 *
 * ★ `null` 的特殊约定：**删掉这个键**，而不是往里写一个 `null`。
 *   拉直的线在文件里应该是"没有 `curve` 字段"，而不是 `"curve": null` ——
 *   后者会让 `03 §1` 的"落盘严格"变成一句空话（每个"可选"字段都开始
 *   用 `null` 表达"没有"，文件里全是噪声），也会让 `io/` 的字节级比对失效。
 */
export function updateEdges(board: BoardFile, ids: readonly string[], patch: EdgePatch): boolean {
  if (ids.length === 0) return false;
  const keys = Object.keys(patch) as (keyof EdgePatch)[];
  if (keys.length === 0) return false;

  const targets = new Set(ids);
  let changed = false;
  for (const edge of board.edges) {
    if (!targets.has(edge.id)) continue;
    const record = edge as unknown as Record<string, unknown>;
    for (const key of keys) {
      const value = patch[key];
      if (value === undefined) continue;
      if (value === null) {
        if (key in record) {
          delete record[key];
          changed = true;
        }
        continue;
      }
      if (record[key] === value) continue;
      record[key] = value;
      changed = true;
    }
  }
  return changed;
}
