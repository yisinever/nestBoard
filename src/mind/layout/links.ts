/**
 * 关联线（`N1`）的几何：**只有一种画法 —— 曲线**。
 *
 * ★ 与 `edges.ts` 的分工：那边画的是**父子分支**（谁连谁由树决定、线型有四档）；
 *   这边画的是**用户手画的关联线**（谁连谁由数据决定、只有一种线型）。
 *   两者都是"两个框之间的一条路径"，所以放在同一层目录、共用同一套 `Rect` 约定。
 * ★ 纯函数、不碰 DOM：`MindView` 只管把结果塞进 `<path d>`，测试直接断言字符串。
 *
 * ── 两条纪律 ──────────────────────────────────────────────
 * 1. **线头永远贴在节点边缘**：端点取"两个框**面对面**的那两条边"的中点，
 *    与分支线同一条规矩（线飘在框外或插进框里都像 bug）；
 * 2. **预览与落笔是同一根线**：拖动中的虚线也用这里的函数算 —— 两处各写一份，
 *    "松手时线跳一下"就是必然。
 */

import { roundTo, type Point, type Rect } from '../../util/geometry';
// ★ 弯折这个词汇住在模型层（`MindLink.bend` 的字段类型与归一化都在 `schema.ts`）——
//   layout 依赖 model、反过来不行，所以这里只**引进来用**，不重复定义一份
import type { MindLink } from '../model/schema';

/** 一个框的中心 */
function centerOf(rect: Rect): Point {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

/** 一条边的中点 */
function edgeMid(rect: Rect, side: 'left' | 'right' | 'top' | 'bottom'): Point {
  const center = centerOf(rect);
  if (side === 'left') return { x: rect.x, y: center.y };
  if (side === 'right') return { x: rect.x + rect.width, y: center.y };
  if (side === 'top') return { x: center.x, y: rect.y };
  return { x: center.x, y: rect.y + rect.height };
}

/**
 * 两个框"面对面"的那两条边（先比中心位移的**主方向**：横向差得多就走左右，否则走上下）。
 *
 * ★ 用主方向而不是"最近的两条边"：后者在**斜对角**时会在相邻两条边之间来回跳 ——
 *   用户拖动节点时线头会一闪一闪地换边，像卡住了。
 */
function facingSides(
  from: Rect,
  to: Rect,
): readonly ['left' | 'right' | 'top' | 'bottom', 'left' | 'right' | 'top' | 'bottom'] {
  const a = centerOf(from);
  const b = centerOf(to);
  const dx = b.x - a.x;
  const dy = b.y - a.y;

  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? ['right', 'left'] : ['left', 'right'];
  return dy >= 0 ? ['bottom', 'top'] : ['top', 'bottom'];
}

/** 关联线两端的锚点（都在框边上）：`[起点, 终点]` */
export function linkAnchors(from: Rect, to: Rect): readonly [Point, Point] {
  const [fromSide, toSide] = facingSides(from, to);
  return [edgeMid(from, fromSide), edgeMid(to, toSide)];
}

// ─────────────────────────────────────────────────────────────
// 弯折（`N1-d`：线上那个手柄，用户 2026-09-17）
// ─────────────────────────────────────────────────────────────

/**
 * **弯折**就是 `MindLink.bend`（字段类型与归一化在 `schema.ts`，见那里的说明）：
 * 曲线中点相对"不弯时那个中点"的位移，也就是**那个手柄被拉到了哪里**。
 */
export type LinkBend = NonNullable<MindLink['bend']>;

/**
 * 控制点要平移**多少** ⇒ 曲线中点正好落到 `中点 + bend`。
 *
 * ★ 三次贝塞尔在 `t = 0.5` 处是 `(a + 3·c1 + 3·c2 + b) / 8` —— 两个控制点**同时**
 *   平移 `δ` ⇒ 中点平移 `3δ/4`。于是要让中点走 `bend`，控制点就得走 `bend × 4/3`
 *   （**精确**的换算，不是凑一个看着像的系数）。
 * ★ 刻意做成**加性偏移**而不是换一种曲线：`bend` 缺席时算出来的两个控制点与从前逐字节相同
 *   ⇒ 存量文件的画法一个像素都不变（"读一遍写回去逐字节不变"那条纪律照旧）。
 */
const BEND_CONTROL_RATIO = 4 / 3;

/**
 * 三次贝塞尔的两个控制点：沿**两中心连线**方向各自外推 `0.4 × 距离`，再整体加上弯折。
 *
 * ★ 系数 0.4 是"看起来像弧、又不至于绕远"的经验值：再大线会鼓成一个圈，
 *   再小就退化成直线（那就不像"关联"、像又画了一根分支线）。
 */
function controlPoints(
  from: Rect,
  to: Rect,
  a: Point,
  b: Point,
  bend?: LinkBend,
): readonly [Point, Point] {
  const ca = centerOf(from);
  const cb = centerOf(to);
  const dx = cb.x - ca.x;
  const dy = cb.y - ca.y;
  const len = Math.hypot(dx, dy);
  // ★ 两个中心重合时不外推，但**弯折照旧生效**（从前这里是 `return [a, b]`，
  //   加了弯折之后就不能提前返回了）
  const k = len === 0 ? 0 : 0.4 * len;
  const ux = len === 0 ? 0 : (dx / len) * k;
  const uy = len === 0 ? 0 : (dy / len) * k;

  const sx = bend ? bend.x * BEND_CONTROL_RATIO : 0;
  const sy = bend ? bend.y * BEND_CONTROL_RATIO : 0;
  return [
    { x: a.x + ux + sx, y: a.y + uy + sy },
    { x: b.x - ux + sx, y: b.y - uy + sy },
  ];
}

/** 关联线的 `<path d>`（只有这一种曲线；`bend` 缺席 = 从前的样子） */
export function linkPathOf(from: Rect, to: Rect, bend?: LinkBend): string {
  const [a, b] = linkAnchors(from, to);
  const [c1, c2] = controlPoints(from, to, a, b, bend);
  return (
    `M ${roundTo(a.x)} ${roundTo(a.y)} ` +
    `C ${roundTo(c1.x)} ${roundTo(c1.y)}, ${roundTo(c2.x)} ${roundTo(c2.y)}, ` +
    `${roundTo(b.x)} ${roundTo(b.y)}`
  );
}

/** 曲线上的一点（`t` 0–1，三次贝塞尔的参数方程）—— 标签摆位、手柄摆位与命中判定都用它 */
export function linkPointAt(from: Rect, to: Rect, t: number, bend?: LinkBend): Point {
  const [a, b] = linkAnchors(from, to);
  const [c1, c2] = controlPoints(from, to, a, b, bend);
  const u = 1 - t;
  const w0 = u * u * u;
  const w1 = 3 * u * u * t;
  const w2 = 3 * u * t * t;
  const w3 = t * t * t;
  return {
    x: w0 * a.x + w1 * c1.x + w2 * c2.x + w3 * b.x,
    y: w0 * a.y + w1 * c1.y + w2 * c2.y + w3 * b.y,
  };
}

/**
 * 曲线中点：**标签与弯折手柄都摆在这儿**（`N1-c` / `N1-d`）。
 *
 * ★ 有弯折时它**就等于**"不弯时的中点 + `bend`"（`BEND_CONTROL_RATIO` 那个换算保证的）
 *   ⇒ 手柄拖到哪儿，曲线中点就在哪儿，用户看到的与手上做的永远是同一个点。
 */
export function linkMidpointOf(from: Rect, to: Rect, bend?: LinkBend): Point {
  return linkPointAt(from, to, 0.5, bend);
}

/**
 * 把曲线**采样成折线**（`steps` 段 ⇒ `steps + 1` 个点）。
 *
 * ★ 命中判定（"点没点到这条线"）不能用"点到锚点连线的距离" —— 曲线会鼓出去，
 *   那样会在弧的外侧漏判、在弦的附近误判。采样成折线再逐段量距离，
 *   与白板那边的 `hitEdgeAt` 是同一个做法。
 */
export function sampleLinkPath(from: Rect, to: Rect, steps = 16, bend?: LinkBend): Point[] {
  const count = Math.max(2, Math.floor(steps));
  const points: Point[] = [];
  for (let index = 0; index <= count; index += 1) {
    points.push(linkPointAt(from, to, index / count, bend));
  }
  return points;
}

// ─────────────────────────────────────────────────────────────
// 箭头（`N1-c`）
// ─────────────────────────────────────────────────────────────

/** 箭头那三角形的腰长（世界坐标 px） */
export const MIND_LINK_ARROW_SIZE = 10;
/** 箭头"张开"的程度：半宽 = 腰长 × 这个值（0.45 ⇒ 约 48° 的尖角） */
const ARROW_HALF_RATIO = 0.45;

/** 一条线的箭头**画哪几端**（`arrow` 字段 → 要画的端点；缺席 = 一个都不画） */
export function linkArrowEnds(arrow: 'end' | 'both' | undefined): readonly ('from' | 'to')[] {
  if (arrow === 'end') return ['to'];
  if (arrow === 'both') return ['from', 'to'];
  return [];
}

/**
 * 一个箭头的三个顶点（`[尖, 翼1, 翼2]`）。
 *
 * ★ 方向取**锚点处的切线**（终点用 `b - c2`、起点用 `a - c1`）而不是"两个中心连线的方向"：
 *   曲线两端与中心连线常常不平行，用后者画出来的箭头会**斜着插在节点边上**。
 * ★ 两端都用同一套算法（起点那一端就自动转 180°），不必写两份。
 */
export function linkArrowPoints(
  from: Rect,
  to: Rect,
  end: 'from' | 'to',
  size = MIND_LINK_ARROW_SIZE,
  bend?: LinkBend,
): readonly [Point, Point, Point] {
  const [a, b] = linkAnchors(from, to);
  const [c1, c2] = controlPoints(from, to, a, b, bend);
  const anchor = end === 'to' ? b : a;
  const inbound =
    end === 'to' ? { x: b.x - c2.x, y: b.y - c2.y } : { x: a.x - c1.x, y: a.y - c1.y };

  const length = Math.hypot(inbound.x, inbound.y) || 1;
  const ux = inbound.x / length;
  const uy = inbound.y / length;

  // 底边中点：从尖往回退一个腰长
  const baseX = anchor.x - ux * size;
  const baseY = anchor.y - uy * size;
  const half = size * ARROW_HALF_RATIO;
  return [
    anchor,
    { x: baseX - uy * half, y: baseY + ux * half },
    { x: baseX + uy * half, y: baseY - ux * half },
  ];
}

// ─────────────────────────────────────────────────────────────
// 命中（`N1-c`：点线身 = 选中它）
// ─────────────────────────────────────────────────────────────

/** 命中判定时把曲线切成几段（16 段对一条弧来说足够贴） */
const HIT_SAMPLE_STEPS = 16;

/** 点到线段（`p` → `a`—`b`）的距离 */
function distanceToSegment(point: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  // 退化成一点：直接量两点距离（除零会让结果变成 NaN，而 NaN 参与比较永远为假 ——
  // 那种 bug 的表现是"这条线怎么都点不中"，最难查）
  if (lengthSq === 0) return Math.hypot(point.x - a.x, point.y - a.y);

  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSq));
  return Math.hypot(point.x - (a.x + dx * t), point.y - (a.y + dy * t));
}

/**
 * 点在不在某条关联线上（`N1-c`）：返回**最近**的那条的 id，没命中给 `null`。
 *
 * ★ 逐段量"点到折线的距离"而不是"点到弦的距离"：曲线会鼓出去，
 *   按弦算会在弧的外侧漏判、在弧的里侧误判。
 * ★ 容差由调用方按**屏幕像素**给（除以缩放）：屏幕上 6px 的容差，
 *   缩放到 50% 时世界里就是 12px —— 写死世界坐标的话，放大之后就点不中了。
 * ★ 最近的那条赢（不是第一个命中的）：两条线挨着时，用户点的是他看见的那条。
 */
export function linkHitTest(
  links: readonly { id: string; from: string; to: string; bend?: LinkBend }[],
  boxes: ReadonlyMap<string, Rect>,
  point: Point,
  tolerance: number,
): string | null {
  let best: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const link of links) {
    const from = boxes.get(link.from);
    const to = boxes.get(link.to);
    if (!from || !to) continue;

    // ★ 命中判定必须**跟着弯折走**：线被拉弯之后，按老曲线算就会"看得见的线点不中、
    //   空处反而点得中"（最典型的是把线拉成一个大弧之后，点在弧上没反应）
    const points = sampleLinkPath(from, to, HIT_SAMPLE_STEPS, link.bend);
    for (let index = 1; index < points.length; index += 1) {
      const distance = distanceToSegment(point, points[index - 1], points[index]);
      if (distance > tolerance) continue;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = link.id;
      }
    }
  }
  return best;
}
