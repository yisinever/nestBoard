/**
 * 纯几何工具（T1.18 起被 `Viewport` 与渲染层共用）。
 *
 * 零依赖、零 DOM、零 Obsidian —— `model/` 与 `view/` 都在依赖链下游（03 §7.2）。
 *
 * **坐标约定**：本文件里的点/矩形默认是「屏幕坐标」时，原点指**画布容器左上角**
 * （不是 window 坐标，也不是世界坐标）。指针事件务必先减去 `getBoundingClientRect()`
 * 再传进来 —— 否则多标签分屏、侧栏展开时锚点缩放会整体偏移。
 */

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

/** 轴对齐矩形 */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

/** 保留 `digits` 位小数。用于写文件：避免 `0.30000000000000004` 弄脏 git diff */
export function roundTo(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function isFinitePoint(point: Point): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y);
}

export function rectContainsPoint(rect: Rect, point: Point): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  );
}

/** 相交判定（用于视口裁剪 T1.25；边界相接不算相交） */
export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** 外扩（裁剪缓冲、命中外扩区域都用它） */
/**
 * 两点 → 规范化矩形（宽高恒为正，拖向四个方向都一样）。
 *
 * ★ 从白板的 `MarqueeController` 挪进来的：脑图的框选要用**同一把尺子**，
 *   而 `src/mind/**` 不许 import 白板的 `view/**`（eslint 钉着）——
 *   两边都要用的纯几何就只能住在 `util/`（与 `Viewport` 搬到 `canvas/` 同一条理由）。
 */
export function rectFromPoints(a: Point, b: Point): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  };
}

export function expandRect(rect: Rect, padding: number): Rect {
  return {
    x: rect.x - padding,
    y: rect.y - padding,
    width: rect.width + padding * 2,
    height: rect.height + padding * 2,
  };
}

export function rectCenter(rect: Rect): Point {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

/**
 * 角度归一化到 `(-180, 180]`（度）。
 *
 * ★ 卡片旋转（T7.06）存的就说这个区间的值：不归一化的话，同一个方向可以有
 *   `90 / 450 / -630` 三种写法 —— 文件之间没法比对，`validate` 判不了"和上次一样"，
 *   "重置旋转"也只能靠人肉判断"现在到底转没转"。
 * ★ 非有限值（`NaN` / `Infinity`，手改文件能造出来）一律当 `0`：
 *   宁可这张卡不转，也不要让一个 `NaN` 进到 CSS 里把整张卡片变成隐身。
 */
export function normalizeAngle(deg: number): number {
  if (!Number.isFinite(deg)) return 0;
  let value = deg % 360;
  if (value <= -180) value += 360;
  if (value > 180) value -= 360;
  // `-0` 收敛成 `0`：`-7°` 吸到 15° 的格点会算出 `Math.round(-7/15) * 15 = -0`，
  // 而 `-0 !== 0` 是 `Object.is` 意义上的差异 —— 同一个朝向又长出第二种写法，
  // 正是这个函数存在的意义。`value === 0` 对 `-0` 也为真，所以这一行就够了。
  return value === 0 ? 0 : value;
}

/**
 * 绕 `center` 把 `point` 转 `deg` 度。
 *
 * **屏幕坐标系**：y 向下，所以正角度看起来是**顺时针** —— 与
 * CSS `rotate()`、以及用户说"顺时针转 15°"是同一个方向。
 */
export function rotatePoint(point: Point, center: Point, deg: number): Point {
  if (deg === 0) return { x: point.x, y: point.y };
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  return {
    x: center.x + dx * cos - dy * sin,
    y: center.y + dx * sin + dy * cos,
  };
}

/**
 * `point` 相对 `center` 的**方位角**（度）：`0` = 正右，顺时针为正。
 *
 * ★ 与 `rotatePoint` 是互逆的两件事：一个"由角得点"、一个"由点得角"，都在本文件里，
 *   改一个就得想另一个。旋转手势靠它把"指针挪到哪了"翻译成"转了多少度"。
 */
export function pointerAngleDeg(center: Point, point: Point): number {
  return (Math.atan2(point.y - center.y, point.x - center.x) * 180) / Math.PI;
}

/**
 * 一个矩形绕**自身中心**转 `deg` 度之后的外接矩形（AABB）。
 *
 * ★ 卡片旋转后，模型里的 `x/y/width/height` 仍是**没转**的那个框
 *   （见 `schema.CardBase.rotation`），所以"这张卡占多大一块"必须现算 ——
 *   导出取景、缩略图、框选都要用它，否则转过的卡片会被裁掉一个角。
 * ★ `deg === 0` 是**逐字段原样返回**：这是绝大多数卡片的状态，
 *   早退省掉的是每次导出 / 每帧缩略图的四次三角函数。
 */
export function rotatedBoundsOf(rect: Rect, deg: number): Rect {
  if (deg === 0) return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  const center = rectCenter(rect);
  const corners = [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.width, y: rect.y },
    { x: rect.x + rect.width, y: rect.y + rect.height },
    { x: rect.x, y: rect.y + rect.height },
  ].map((corner) => rotatePoint(corner, center, deg));

  const xs = corners.map((corner) => corner.x);
  const ys = corners.map((corner) => corner.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY };
}

/**
 * 求包围盒。空数组（或全是非法值）返回 `null`，由调用方决定"没有内容"时怎么办
 * —— 视口该回 100%、HUD 该显示"空板"，只有调用方知道。
 */
export function boundsOf(items: readonly Rect[]): Rect | null {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const item of items) {
    if (
      !Number.isFinite(item.x) ||
      !Number.isFinite(item.y) ||
      !Number.isFinite(item.width) ||
      !Number.isFinite(item.height)
    ) {
      continue;
    }
    minX = Math.min(minX, item.x);
    minY = Math.min(minY, item.y);
    maxX = Math.max(maxX, item.x + item.width);
    maxY = Math.max(maxY, item.y + item.height);
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
