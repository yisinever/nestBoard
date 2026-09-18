/**
 * 网格吸附（T3.11 / `F5-02`）与智能参考线（T3.12 / `F5-03`，PRD `D-06`）。
 *
 * ── 两个吸附为什么放在一个文件里 ──────────────────────────────
 *
 * 它们是**同一次拖动里抢同一根轴的两条约束**：网格说"吸到 16 的整数倍"，
 * 参考线说"跟隔壁那张卡的左边缘齐平"。如果各自为政（两个模块、两次位移修正），
 * 后跑的那个会把前一个的结果当作新的起点，卡片就会在两条约束之间来回跳。
 * 所以合并成一个 `snapMove()`：**一个入口、一次决策、一份结果**。
 *
 * ── 两条约束怎么共存（每个轴各判一次）─────────────────────────
 *
 * 对齐优先、网格兜底：
 *   * 某个轴上"移动包围盒的某个锚点"离"邻近卡片的某个锚点"在阈值内 → 用对齐；
 *   * 该轴上没有这样的近邻 → 用网格；
 *   * 都没有 → 原样的自由位移。
 *
 * 分轴判断而不是整块二选一，是因为两者常常只有一边能满足：用户可能正把卡片
 * 贴着上面那张卡的左边缘（x 对齐），而纵向只想落在网格线上。整块二选一会强行
 * 让他二选一，手感是"要么全吸、要么全不吸"。
 *
 * ── 为什么锚点是**起始包围盒**而不是逐张卡片 ──────────────────
 *
 * 多选拖动时，"每张卡各自就近吸附"会把选中的一组卡片**揉散**：A 吸到 16、B 吸到 32，
 * 两张卡之间的相对位置就变了 —— 用户明明是在整体搬运，却得到一组被重新排过队的卡片。
 * 所以整组只取**一个**吸附位移量（以起始包围盒左上角为锚），组内相对位置分毫不动。
 *
 * ── 为什么是"位移量取整"而不是"每帧把当前位置吸一下" ──────────
 *
 * 后者看着也能对齐，但每帧都把"当前位置"舍入会让卡片在网格线之间**粘住**：
 * 指针还没走够半格卡片先跳一下，越过半格又连着跳两格 —— 手感是"卡顿地跳"。
 * 用"起始位置 + 位移量取整"，卡片全程只会在网格点上停一次，中途每一帧都是连续的。
 *
 * ── Ctrl 临时反转 ────────────────────────────────────────────
 *
 * "开着的时候按 Ctrl 就不吸、关着的时候按 Ctrl 就吸"是同一件事的两面（`gridSnapActive`）。
 * 这样用户**不必为了拖一张卡去改设置**：默认开着吸附时，按住 Ctrl 就能随手摆一张自由位置的卡。
 *
 * ★ 纯逻辑、零依赖、不 import obsidian，可直接单测。
 */

import type { Point, Rect } from '../util/geometry';

/** 网格吸附配置（来自白板 `settings.snapToGrid` / `settings.gridSize`） */
export interface GridSnapConfig {
  enabled: boolean;
  size: number;
}

/**
 * 网格步长下限。
 *
 * ★ `0` / 负数 / `NaN` 都会让 `Math.round(value / size)` 变成 `Infinity` / `NaN`，
 *   表现是"一拖动卡片就飞到天边"。所以下面每个函数都拿它当闸门，而不是相信调用方。
 */
export const MIN_GRID_SIZE = 1;

/** 把任意来源的 `gridSize` 收敛成合法步长；坏值回落到 `fallback`（默认 16，与数据层一致） */
export function normalizeGridSize(size: number, fallback = 16): number {
  if (!Number.isFinite(size) || size < MIN_GRID_SIZE) return fallback;
  return size;
}

/**
 * 这一次拖动到底吸不吸。
 *
 * `invert` = 用户此刻按着 Ctrl：开着变关、关着变开。**只反转、不改设置** ——
 * 松手之后白板还是原来那个开关状态。
 */
export function gridSnapActive(config: GridSnapConfig, invert = false): boolean {
  return config.enabled !== invert;
}

/**
 * 单轴就近吸附：四舍五入到最近的网格线。
 *
 * 无法计算（非有限值 / 步长非法）时**原样返回**而不是抛错或返回 0：
 * 拖动里一次异常坐标不该让整张卡瞬移，宁可这一帧不吸。
 */
export function snapCoordinate(value: number, size: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(size) || size < MIN_GRID_SIZE) return value;
  return Math.round(value / size) * size;
}

/**
 * 把"拖动位移量"按网格吸附。
 *
 * @param origin 拖动起始时的**包围盒**（`boundsOf(rects)`）；`null`（无矩形）时不吸
 * @param delta  指针位移量（世界坐标 px）
 * @param size   网格步长
 *
 * 返回的是**修正后的位移量**，调用方把它原样加到每个矩形上即可 ——
 * 吸附只改变"整组挪多远"，不改变组内每一张卡之间的关系。
 */
export function snappedDelta(origin: Rect | null, delta: Point, size: number): Point {
  if (!origin || !Number.isFinite(size) || size < MIN_GRID_SIZE) return delta;
  return {
    x: snapCoordinate(origin.x + delta.x, size) - origin.x,
    y: snapCoordinate(origin.y + delta.y, size) - origin.y,
  };
}

// ─────────────────────────────────────────────────────────────
// 智能参考线（T3.12 / `F5-03`）
// ─────────────────────────────────────────────────────────────

/**
 * 对齐阈值（**屏幕**像素）。`02 §5.3` / PRD `D-06` 规定 6px。
 *
 * ★ 是屏幕像素而不是世界像素：它描述的是"用户看着够近"，而"够近"是眼睛的判断。
 *   调用方必须按当前缩放换算（`÷ zoom`）后再传进 `AlignConfig.threshold` ——
 *   缩到 30% 时若照搬 6 个世界像素，参考线几乎不可能触发。
 */
export const GUIDE_THRESHOLD_PX = 6;

/** 世界坐标下的参考线：竖线给 `x`、横线给 `y`（覆盖层负责换算成屏幕坐标） */
export interface SmartGuides {
  readonly verticals: readonly number[];
  readonly horizontals: readonly number[];
}

/**
 * "没有参考线"的共享常量。
 *
 * ★ 每帧都新建一个空对象看着无害，但它会跟着 `preview` 回调进入视图层的
 *   `dragGuides` 状态，让"有没有参考线"变成每帧都不同的引用 —— 白白触发重绘判断。
 */
export const EMPTY_GUIDES: SmartGuides = { verticals: [], horizontals: [] };

/** 参与对齐的其它卡片（世界坐标）与阈值（世界像素） */
export interface AlignConfig {
  readonly others: readonly Rect[];
  readonly threshold: number;
}

export interface SnapMoveOptions {
  /** 拖动起始时的包围盒（世界坐标）；`null` = 无几何可用 */
  origin: Rect | null;
  /** 指针位移量（世界坐标） */
  delta: Point;
  /** 网格吸附；`null` = 关闭 */
  grid: GridSnapConfig | null;
  /** 智能参考线；`null` = 关闭 */
  align: AlignConfig | null;
}

export interface SnapMoveResult {
  /** 修正后的位移量（原样加到每个矩形上，组内相对位置不变） */
  delta: Point;
  /** 本次命中的参考线（世界坐标）；没命中就是 `EMPTY_GUIDES` */
  guides: SmartGuides;
}

/** 一根轴上的对齐结果：`shift` 是要施加的修正量，`line` 是参考线所在坐标 */
interface AxisMatch {
  shift: number;
  line: number;
}

/**
 * 一次算出"这一帧该挪多远"与"该画哪几条参考线"。
 *
 * 判定顺序（每轴独立）：
 *  1. 对齐：移动包围盒的左/中/右（上/中/下）与邻近卡片的同名锚点在阈值内 → 吸过去；
 *  2. 网格：该轴没有近邻时，按网格取整；
 *  3. 自由：都没有就照指针走。
 */
export function snapMove(options: SnapMoveOptions): SnapMoveResult {
  const { origin, delta, grid, align } = options;

  // `snappedDelta` 自带 `origin === null` 的兜底，直接用它省掉一次分支
  const gridDelta = grid ? snappedDelta(origin, delta, grid.size) : delta;
  if (!origin || !align || align.others.length === 0 || !(align.threshold > 0)) {
    return { delta: gridDelta, guides: EMPTY_GUIDES };
  }

  // ★ 对齐从**指针原始位置**起算，而不是"网格吸附之后的位置"：
  //   否则网格先把卡片拽走 8px，对齐再把它拽回来，用户会看到卡片在两张卡之间打摆。
  const box: Rect = {
    x: origin.x + delta.x,
    y: origin.y + delta.y,
    width: origin.width,
    height: origin.height,
  };

  const vertical = alignAxis(box, align.others, 'x', align.threshold);
  const horizontal = alignAxis(box, align.others, 'y', align.threshold);
  if (!vertical && !horizontal) return { delta: gridDelta, guides: EMPTY_GUIDES };

  // ★ 对齐量必须**叠加**在原始位移上（`delta + shift`），而不是取代它：
  //   `shift` 只是"从当前跟手位置再挪多少能贴上那条线"，把它当成总位移，
  //   卡片会直接瞬移到那条线上（也就是"一点就跳"，与逐张吸附同一类错误）。
  return {
    delta: {
      x: vertical ? delta.x + vertical.shift : gridDelta.x,
      y: horizontal ? delta.y + horizontal.shift : gridDelta.y,
    },
    guides: {
      verticals: vertical ? [vertical.line] : [],
      horizontals: horizontal ? [horizontal.line] : [],
    },
  };
}

/**
 * 单个轴上的最近对齐候选。
 *
 * 成本：`O(其它卡片数)`，每张卡做 3×3 = 9 次比较。只在拖动期间逐帧跑，
 * 300 张卡也不过 2700 次比较 —— 换成"预先建索引"只会把复杂度搬进维护成本里。
 */
function alignAxis(
  box: Rect,
  others: readonly Rect[],
  axis: 'x' | 'y',
  threshold: number,
): AxisMatch | null {
  const values = anchors(box, axis);
  let best: AxisMatch | null = null;

  for (const other of others) {
    const targets = anchors(other, axis);
    for (const value of values) {
      for (const target of targets) {
        const shift = target - value;
        if (Math.abs(shift) > threshold) continue;
        // 严格小于：平手时保留先遇到的（遍历顺序 = `board.cards` 顺序，稳定可预期）
        if (!best || Math.abs(shift) < Math.abs(best.shift)) best = { shift, line: target };
      }
    }
  }
  return best;
}

/** 一根轴上的三个锚点：起边 / 中心 / 终边 */
function anchors(rect: Rect, axis: 'x' | 'y'): [number, number, number] {
  const start = axis === 'x' ? rect.x : rect.y;
  const size = axis === 'x' ? rect.width : rect.height;
  return [start, start + size / 2, start + size];
}
