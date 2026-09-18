/**
 * Smart 连线路由（T7.11 / `F3-03`）：**正交走线 + 自动绕开卡片**。
 *
 * ── 这个文件要解决什么 ────────────────────────────────────
 *
 * `routing: 'free'` 的线是"两点之间一条直线"，穿过卡片也无所谓 —— 那是用户的表达。
 * `routing: 'smart'` 的线是**结构化**的：它走横平竖直，并且**不许穿过任何卡片**。
 * 这件事没有解析解，只能搜。做法是教科书上的两条：
 *
 *  1. **Hanan 网格**：把"所有障碍矩形的边 + 起点终点的坐标"投影成一组 x 与 y 刻度，
 *     只在它们的交点上走。对于矩形障碍，**最短正交路径一定存在于这个网格上** ——
 *     于是连续空间里的搜索塌缩成一张几十个节点的图。
 *  2. **A\***：代价 = 长度 + 拐弯罚。拐弯罚是关键：没有它，"能到"的路径里
 *     长度相同的有很多，搜索会随便挑一条看着像蚯蚓的。
 *
 * ── 四个必须守住的细节 ────────────────────────────────────
 *
 * ① **两端先"抬头"再绕**。线从锚点垂直离开卡片一小段（{@link ROUTE_STUB}），
 *   再开始找路。不做这一步的话，"右边出、右边进"的线会贴着卡片边缘走，
 *    看起来像卡片描边而不是连线。
 * ② **障碍要外扩**（{@link ROUTE_CLEARANCE}）。贴着卡片边界走的线在视觉上仍然
 *    "长在卡片上"，扩一圈才像"绕开"。
 * ③ **贴着边界走是允许的**。阻挡判定用半开区间：线段正好落在扩出来的边界上不算穿过。
 *   不这样写的话，网格上那些"沿着障碍边界"的走法全被判死，很多本该有解的走线会
 *   莫名其妙地退回直线。
 * ④ **搜不到就返回 `null`，由调用方退回直线**。宁可画一条穿过卡片的线，
 *   也不要"这条线不见了" —— 后者用户根本不知道发生了什么。
 *
 * ★ 纯函数、不 import `obsidian`、不碰 DOM：可在 node 下单测（本文件 100% 可测）。
 */

import { expandRect, rectsIntersect, type Point, type Rect } from '../util/geometry';
import type { AnchorSide } from './edges';

/** 锚点向外"抬头"的那一小段（世界像素）。线先垂直离开卡片，再开始绕 */
export const ROUTE_STUB = 20;

/** 卡片向外扩多少才叫"过不去"。贴着卡片边走的线看起来像卡片描边，留一圈空气 */
export const ROUTE_CLEARANCE = 10;

/** 搜索窗口：只考虑"两端包围盒"外扩这么多以内的卡片（远处的卡片不可能影响这段走线） */
export const ROUTE_MARGIN = 64;

/**
 * 一个拐弯折算成多少世界像素。
 *
 * 40 这个数不是量出来的，是**权衡**出来的：太大则宁可绕远也不拐弯（路线变长、变得
 * 莫名其妙），太小则等同于"只看长度"（三拐两拐的蚯蚓）。40 大约等于"多拐一次弯，
 * 长度上就得多省下 40px 才划算"。
 */
export const ROUTE_TURN_COST = 40;

/**
 * 最多考虑这么多个障碍。
 *
 * ★ 网格是 O(n²) 的：n 从 6 涨到 20，节点数从 ~200 涨到 ~2000，而**远处的卡片
 *   对这段走线毫无影响** —— 花在它们身上的每一格都是白算的。按"离连线中点近"
 *   排序取前几个，效果与全量几乎一致。
 */
const MAX_OBSTACLES = 6;

/** 四个正交方向：0 = +x, 1 = +y, 2 = -x, 3 = -y（顺序无所谓，成对相反即可） */
const DIRECTIONS: readonly Point[] = [
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
  { x: 0, y: -1 },
];

/** 某条边的**向外**单位方向（线从这里离开卡片） */
function outwardDirection(side: AnchorSide): number {
  switch (side) {
    case 'right':
      return 0;
    case 'bottom':
      return 1;
    case 'left':
      return 2;
    case 'top':
      return 3;
  }
}

/** 相反方向（`(d + 2) % 4`） */
function opposite(direction: number): number {
  return (direction + 2) % 4;
}

/** 从 `point` 沿某条边向外的方向走 `distance` */
function advance(point: Point, side: AnchorSide, distance: number): Point {
  const unit = DIRECTIONS[outwardDirection(side)];
  return { x: point.x + unit.x * distance, y: point.y + unit.y * distance };
}

/** `point` 是否落在矩形内（含边界） */
function containsPoint(rect: Rect, point: Point): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  );
}

interface AStarInput {
  xs: number[];
  ys: number[];
  blockers: readonly Rect[];
}

/**
 * 算一条 Smart 走线。
 *
 * @param from 起点锚点（世界坐标，已在卡片边上）
 * @param fromSide 起点方位 —— 线必须**垂直**离开这条边
 * @param to 终点锚点
 * @param toSide 终点方位 —— 线必须**垂直**进入这条边
 * @param obstacles 场上的卡片矩形（世界坐标）。**可含两端自己的卡片**：包住两端锚点的
 *   那些会被剔除（见下面的 `endpointBlocks`）—— 不剔的话两端锚点落在外扩后的自家卡片里，
 *   第一步就走不出去，整条路必然搜不到，Smart 就成了"永远画直线"。
 * @returns 正交折点（含 `from` 与 `to`）；**搜不到返回 `null`**（调用方退回直线）
 */
export function routeOrthogonal(
  from: Point,
  fromSide: AnchorSide,
  to: Point,
  toSide: AnchorSide,
  obstacles: readonly Rect[],
): Point[] | null {
  // 两端重合：没有"垂直方向"可言，立刻退出（也不该有人给这种边画路由）
  if (from.x === to.x && from.y === to.y) return null;

  const stubFrom = advance(from, fromSide, ROUTE_STUB);
  const stubTo = advance(to, toSide, ROUTE_STUB);
  const window = expandRect(pointBounds([from, to, stubFrom, stubTo]), ROUTE_MARGIN);
  const endpointBlocks = (rect: Rect): boolean =>
    containsPoint(rect, from) || containsPoint(rect, to);
  const blockers = inflate(
    pickObstacles(obstacles, window, midpoint(stubFrom, stubTo)),
    ROUTE_CLEARANCE,
  ).filter((rect) => !endpointBlocks(rect));

  const input: AStarInput = {
    xs: axisTicks(
      [stubFrom.x, stubTo.x],
      blockers.map((rect) => [rect.x, rect.x + rect.width]),
    ),
    ys: axisTicks(
      [stubFrom.y, stubTo.y],
      blockers.map((rect) => [rect.y, rect.y + rect.height]),
    ),
    blockers,
  };

  const legs = search(
    input,
    stubFrom,
    stubTo,
    outwardDirection(fromSide),
    outwardDirection(toSide),
  );
  if (!legs) return null;
  return simplify([from, ...legs, to]);
}

// ─────────────────────────────────────────────────────────────
// 网格
// ─────────────────────────────────────────────────────────────

/** 一个矩形集合统一外扩 `padding` */
function inflate(rects: readonly Rect[], padding: number): Rect[] {
  return rects.map((rect) => expandRect(rect, padding));
}

/** 只留下"可能挡路"的卡片：与窗口相交的、且离这条线最近的若干个 */
function pickObstacles(obstacles: readonly Rect[], window: Rect, center: Point): Rect[] {
  const near = obstacles.filter((rect) => rectsIntersect(rect, window));
  if (near.length <= MAX_OBSTACLES) return near;
  return near
    .map((rect) => ({ rect, distance: distanceToRect(center, rect) }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, MAX_OBSTACLES)
    .map((entry) => entry.rect);
}

/** 点到矩形的最短距离（在矩形内 = 0） */
function distanceToRect(point: Point, rect: Rect): number {
  const dx = Math.max(rect.x - point.x, 0, point.x - (rect.x + rect.width));
  const dy = Math.max(rect.y - point.y, 0, point.y - (rect.y + rect.height));
  return Math.hypot(dx, dy);
}

/**
 * 一条轴的刻度：必须包含两端点的坐标，再加上所有障碍的这条轴的两条边。
 *
 * ★ 只保留两端坐标的话，绕行时"从卡片上方过还是下方过"就没有中间刻度可走，
 *   整张图退化成 2×2 —— 有障碍时几乎必然搜不到路。
 */
function axisTicks(
  anchors: readonly number[],
  edges: ReadonlyArray<readonly [number, number]>,
): number[] {
  const values = [...anchors];
  for (const [low, high] of edges) {
    values.push(low, high);
  }
  values.sort((a, b) => a - b);
  const ticks: number[] = [];
  for (const value of values) {
    if (ticks.length === 0 || ticks[ticks.length - 1] !== value) ticks.push(value);
  }
  return ticks;
}

/** 网格里的一个节点坐标 */
function nodeAt(input: AStarInput, ix: number, iy: number): Point {
  return { x: input.xs[ix], y: input.ys[iy] };
}

/**
 * 一条**轴对齐**线段是否穿过某个障碍的**内部**。
 *
 * ★ 半开区间（`>` 与 `<` 而不是 `>=` / `<=`）：正好压在障碍边界上的线段不算穿过。
 *   这是第 ③ 条细节的实现 —— 网格上大量候选走法都恰好沿着障碍边界。
 */
function segmentBlocked(a: Point, b: Point, rect: Rect): boolean {
  const minX = Math.min(a.x, b.x);
  const maxX = Math.max(a.x, b.x);
  const minY = Math.min(a.y, b.y);
  const maxY = Math.max(a.y, b.y);
  const overlapsX = maxX > rect.x && minX < rect.x + rect.width;
  const overlapsY = maxY > rect.y && minY < rect.y + rect.height;
  return overlapsX && overlapsY;
}

/** 一段路是否畅通（任何障碍都不挡） */
function clear(a: Point, b: Point, blockers: readonly Rect[]): boolean {
  for (const rect of blockers) {
    if (segmentBlocked(a, b, rect)) return false;
  }
  return true;
}

// ─────────────────────────────────────────────────────────────
// A*
// ─────────────────────────────────────────────────────────────

/**
 * 在网格上搜一条从 `start` 到 `goal` 的路。
 *
 * 状态是 **(节点, 到达方向)** 而不是只有节点：拐弯罚要求知道"我是从哪儿拐过来的"，
 * 只记节点的话，同一个节点上"直着穿过"和"拐个弯进来"会被当成同一件事，
 * 拐弯罚就算不出来。
 *
 * ★ **不用启发式**（Dijkstra，而不是带 h 的 A*）。节点数上限是几十个 × 4 个方向，
 *   启发式省下的那点开销远小于它带来的风险：`h` 一旦不可采纳（比如把拐弯罚也估进去
 *   却估多了），"第一个弹出的目标状态就是最优"这条就不成立，走线会时好时坏，
 *   而且坏得很隐蔽 —— 只在特定摆位下多拐一个弯。
 * ★ 终点代价要算上**拐进终点那条边**的兜底转弯（见 `settle`）。
 */
function search(
  input: AStarInput,
  start: Point,
  goal: Point,
  startDirection: number,
  goalSide: number,
): Point[] | null {
  const startIndex = { ix: input.xs.indexOf(start.x), iy: input.ys.indexOf(start.y) };
  const goalIndex = { ix: input.xs.indexOf(goal.x), iy: input.ys.indexOf(goal.y) };
  if (startIndex.ix < 0 || startIndex.iy < 0 || goalIndex.ix < 0 || goalIndex.iy < 0) return null;

  const width = input.xs.length;
  const height = input.ys.length;
  /** 状态 = (ix * height + iy) * 4 + 到达方向 */
  const stateCount = width * height * 4;
  const best = new Float64Array(stateCount).fill(Infinity);
  const from = new Int32Array(stateCount).fill(-1);
  const open = new MinHeap();

  const stateOf = (ix: number, iy: number, direction: number): number =>
    (ix * height + iy) * 4 + direction;
  const isGoal = (ix: number, iy: number): boolean => ix === goalIndex.ix && iy === goalIndex.iy;

  const startState = stateOf(startIndex.ix, startIndex.iy, startDirection);
  best[startState] = 0;
  open.push(startState, 0);

  /** 已找到的最优"到达 + 拐进终点边"总代价，以及对应状态 */
  let complete = Infinity;
  let goalState = -1;

  while (open.size > 0) {
    // 堆里每个键都是**某条真实路径的代价**，而之后的每一步只会更贵 ——
    // 最小的那个键已经不小于已知最优完成代价时，不可能再找到更好的了
    if (open.peekKey() >= complete) break;
    const state = open.pop();
    const direction = state % 4;
    const node = (state - direction) / 4;
    const iy = node % height;
    const ix = (node - iy) / height;
    const point = nodeAt(input, ix, iy);

    if (isGoal(ix, iy)) {
      // 到达终点后还要拐进"终点边朝外"的反方向里，这一次拐弯也要算：
      // 不算的话，"从侧面撞进来"的走法会比"正面顺着进来"更便宜（少一次拐弯罚），
      // 画出来就是终点那个锚点前多出一个 90° 的小钩
      const settle = direction === opposite(goalSide) ? 0 : ROUTE_TURN_COST;
      if (best[state] + settle < complete) {
        complete = best[state] + settle;
        goalState = state;
      }
      // 不再从终点往外扩展：穿过去再绕回来永远不划算，只会白算
      continue;
    }

    for (let next = 0; next < 4; next++) {
      const step = DIRECTIONS[next];
      const nx = ix + (step.x === 0 ? 0 : step.x > 0 ? 1 : -1);
      const ny = iy + (step.y === 0 ? 0 : step.y > 0 ? 1 : -1);
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const target = nodeAt(input, nx, ny);
      if (!clear(point, target, input.blockers)) continue;

      const cost =
        Math.abs(target.x - point.x) +
        Math.abs(target.y - point.y) +
        (next === direction ? 0 : ROUTE_TURN_COST);
      const nextState = stateOf(nx, ny, next);
      const candidate = best[state] + cost;
      if (candidate >= best[nextState]) continue;
      best[nextState] = candidate;
      from[nextState] = state;
      open.push(nextState, candidate);
    }
  }

  if (goalState < 0) return null;

  const legs: Point[] = [];
  for (let state = goalState; state >= 0; state = from[state]) {
    const direction = state % 4;
    const node = (state - direction) / 4;
    const iy = node % height;
    const ix = (node - iy) / height;
    legs.push(nodeAt(input, ix, iy));
  }
  legs.reverse();
  return legs;
}

/**
 * 二叉树最小堆。
 *
 * ★ 不引第三方库：本文件要求"纯、可单测"，而 A* 需要一个优先队列 ——
 *   三十行写掉它，比多一个依赖干净。
 */
class MinHeap {
  private readonly keys: number[] = [];
  private readonly values: number[] = [];

  get size(): number {
    return this.values.length;
  }

  /** 看一眼堆顶的键（不弹出）。`search` 用它判断"再也不可能更好了" */
  peekKey(): number {
    return this.keys.length > 0 ? this.keys[0] : Infinity;
  }

  push(value: number, key: number): void {
    this.values.push(value);
    this.keys.push(key);
    let index = this.values.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.keys[parent] <= this.keys[index]) break;
      this.swap(parent, index);
      index = parent;
    }
  }

  pop(): number {
    const top = this.values[0];
    const lastValue = this.values.pop() as number;
    const lastKey = this.keys.pop() as number;
    if (this.values.length > 0) {
      this.values[0] = lastValue;
      this.keys[0] = lastKey;
      let index = 0;
      for (;;) {
        const left = index * 2 + 1;
        const right = left + 1;
        let smallest = index;
        if (left < this.keys.length && this.keys[left] < this.keys[smallest]) smallest = left;
        if (right < this.keys.length && this.keys[right] < this.keys[smallest]) smallest = right;
        if (smallest === index) break;
        this.swap(index, smallest);
        index = smallest;
      }
    }
    return top;
  }

  private swap(a: number, b: number): void {
    const value = this.values[a];
    this.values[a] = this.values[b];
    this.values[b] = value;
    const key = this.keys[a];
    this.keys[a] = this.keys[b];
    this.keys[b] = key;
  }
}

// ─────────────────────────────────────────────────────────────
// 收尾
// ─────────────────────────────────────────────────────────────

/** 两点中点 */
function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/** 一组点的包围盒 */
function pointBounds(points: readonly Point[]): Rect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * 去掉重复点与"中间那个多余的拐点"。
 *
 * ★ 网格上的路径经常出现 `A → B → C` 三点共线（因为 A→C 中间恰好落着一个刻度），
 *   不合并的话线还是会画出来（画布不在乎），但**箭头方向与标签落点会按错的段去算**，
 *   而且 `points.length` 会涨到十几 —— 单测里的断言会变得没法读。
 */
export function simplify(points: readonly Point[]): Point[] {
  const result: Point[] = [];
  for (const point of points) {
    const last = result[result.length - 1];
    if (last && last.x === point.x && last.y === point.y) continue;
    result.push(point);
  }
  for (let index = 1; index < result.length - 1;) {
    const prev = result[index - 1];
    const current = result[index];
    const next = result[index + 1];
    const collinearX = prev.x === current.x && current.x === next.x;
    const collinearY = prev.y === current.y && current.y === next.y;
    if (collinearX || collinearY) {
      result.splice(index, 1);
      continue;
    }
    index++;
  }
  return result;
}
