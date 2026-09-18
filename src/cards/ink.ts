/**
 * 手绘卡（T3.08 / `F4-04`）—— **一笔 = 一张卡**，内容是**可编辑的矢量路径**。
 *
 * ── 三条关键决定 ──────────────────────────────────────────
 *
 * 1. **一笔一张卡**（而不是"整屏笔迹一张卡"）。
 *    `03 §2.7` 要求笔迹"可缩放、可改色、可**单删**"，而这正好是卡片模型已经会做
 *    的事：选中、拖动、删除、复制、层级、撤销、分栏重排…… 核心代码一个字都不用动
 *    （`03 §7.2`）。代价是笔迹多了会有很多张卡 —— 卡片层本来就做了视口虚拟化
 *    （T1.36），而且"多了多少"是个能用数字看出来、能优化的事；
 *    "少了一种操作"不是。
 *
 * 2. **点存"卡片内坐标"**（相对这张卡的左上角），不是世界坐标。
 *    卡片会动，而拖动**只改 DOM 做预览、松手才提交一次**（见 `DragController`）——
 *    存世界坐标的话，拖动过程中笔迹会留在原地，松手那一瞬间才"啪"地跳过去。
 *    换算只有一处：落盘时减原点（`localizePath`）、命中判定时减原点
 *    （`model/ink.ts` 的 `toStrokeSpace`）。
 *
 * 3. **卡片的框就是笔迹的包围盒**，渲染时把内容框拉满这个框。
 *    于是这个框永远不撒谎：橡皮的预筛、拖动、对齐、分栏都用它当笔迹的位置。
 *    刚生成时"内容框 == 卡片框"，画出来与刚才手画的那一笔逐像素重合
 *    （交接在同一帧内完成，见 `BoardView.persistInkStroke`）。
 *    用户把卡片拉大 = 笔迹跟着放大（`preserveAspectRatio="none"` 的自由变换）——
 *    矢量笔迹因此不会像截图那样放大就糊。
 *
 * ── 命中区 ────────────────────────────────────────────────
 * 手绘卡的外壳是 `pointer-events: none` 的（见 `styles.css`）：能点中的只有笔画本身
 * （外加一条看不见的加粗命中区）。若按包围盒命中，一笔绕着圈画的标注会把它框住的
 * 整块内容全挡住 —— 而 T3.09 要做的正是"在图片卡上标注"。
 *
 * ── 标注归属（T3.09 / `F4-05`）─────────────────────────────
 * "在图片卡上标注"光能画上去还不够：标注得**属于**那张图 —— 图片挪走时批注必须
 * 跟着走，否则用户看到的就是"画好的标注丢了"。判据见 `inkHostCard`：只有一条
 * （**落笔点在谁的框里**），而且是**算出来**的、不写进 `.nboard`。
 */

import { DEFAULT_CARD_SIZES, createCard } from '../model/factories';
import {
  distanceToStroke,
  isTapered,
  segmentWidthAt,
  strokeAlpha,
  strokeWidthAt,
  strokesBounds,
  toStrokeSpace,
} from '../model/ink';
import type { Card, CardOf, HexColor, InkPath, InkPoint } from '../model/schema';
import { rectContainsPoint, roundTo, type Point, type Rect } from '../util/geometry';
import { t } from '../util/i18n';
import type { CardTypeDefinition, CardTypeMenuItem } from './registry';

/** 内容槽上的类名（`render` 时挂在槽位元素上） */
export const INK_SLOT_CLASS = 'nestboard-ink';
/** 根 SVG 的类名 */
export const INK_SVG_CLASS = 'nestboard-ink-svg';
/** 可见笔画 */
export const INK_STROKE_CLASS = 'nestboard-ink-stroke';
/** 看不见的加粗命中区（`pointer-events: stroke`，见文件头） */
export const INK_HIT_CLASS = 'nestboard-ink-hit';

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * 手绘卡的最小边长（世界像素）。
 *
 * ★ 不能像别的卡片那样卡在 `MIN_CARD_SIZE`（80×60）：那会让"点一下"画出的一个点
 *   选中出一个比它大 20 倍的框，看上去像选错了东西。撑到 16 只是为了让一个 4px
 *   的点也点得中、拖得动。
 * ★ 撑开的部分**不缩放笔迹**：渲染用的 viewBox 是"撑开之后的内容框"
 *   （`inkContentBox`），而"点一个点"的半径是绝对的世界尺寸 —— 所以 4px 的点
 *   画出来还是 4px，不会因为框被撑大而变成一团。
 */
export const INK_MIN_BOX = 16;

/** 命中区最小宽度（世界像素） */
export const INK_HIT_STROKE_PX = 16;
/** 命中区在笔宽基础上再加宽的量（世界像素）：细线也要点得中 */
export const INK_HIT_PADDING = 8;

/**
 * 一笔要画成的图元。
 *
 * 只有两种：一个圆点，或一条折线。
 */
export type InkShape =
  | { kind: 'dot'; x: number; y: number; radius: number }
  | { kind: 'curve'; d: string; width: number };

/**
 * 把一笔拆成要画的图元。
 *
 * ★ 压感笔迹必须**逐段**画：SVG 的 `stroke-width` 是整条路径一个值，而压感是逐点的
 *   （每一段的粗细都不同）。用一条路径配一个平均线宽会得到一条"假的压感线"——
 *   看上去像压力压根没生效。这与 Canvas 侧（`InkLayer` 的 `drawTaperedPath`）
 *   是同一套拆法、同一组取整，于是"刚画完"与"落盘后"长得一模一样。
 * ★ 单点笔迹退化成圆点，半径与 Canvas 侧同源（`max(实际线宽, 0.5) / 2`），
 *   否则"点一下"在矢量层会比在手绘层小一半。
 * ★ 半透明笔（荧光笔，T7.08）**永远**走前面那一支（一条路径一个线宽）：它从落笔起就
 *   不记压感，于是 `isTapered` 为假 —— 逐段半透明会在接缝处叠深，一条高亮变成一串斑。
 */
export function strokeShapes(path: InkPath): InkShape[] {
  const first = path.points[0];
  if (!first) return [];

  if (path.points.length === 1) {
    const radius = Math.max(strokeWidthAt(path, 0), 0.5) / 2;
    return [{ kind: 'dot', x: first[0], y: first[1], radius }];
  }

  if (!isTapered(path)) {
    return [{ kind: 'curve', d: svgPathData(path.points), width: Math.max(path.width, 0) }];
  }

  const shapes: InkShape[] = [];
  for (let index = 1; index < path.points.length; index += 1) {
    const from = path.points[index - 1];
    const to = path.points[index];
    shapes.push({
      kind: 'curve',
      d: `M${coord(from[0])} ${coord(from[1])} L${coord(to[0])} ${coord(to[1])}`,
      width: Math.max(segmentWidthAt(path, index), 0.2),
    });
  }
  return shapes;
}

/**
 * 一笔的命中区（一条加粗的折线；永远按折线画，单点也走 `M x y` + 圆头 = 一个圆点）。
 *
 * ★ 单独画一条而不是把可见笔画加粗：可见的粗细是用户画出来的，不能为了好点就改。
 * ★ 返回类型收窄到折线（而不是 `InkShape`）：它**永远**是折线，调用方不必再判 `kind`。
 */
export function strokeHitShape(path: InkPath): Extract<InkShape, { kind: 'curve' }> {
  return {
    kind: 'curve',
    d: svgPathData(path.points),
    width: Math.max(path.width + INK_HIT_PADDING, INK_HIT_STROKE_PX),
  };
}

/** SVG 折线数据。坐标保留 2 位小数：文件里的点本来就只存 2 位，这里不必更长 */
export function svgPathData(points: readonly InkPoint[]): string {
  return points
    .map(([x, y], index) => `${index === 0 ? 'M' : 'L'}${coord(x)} ${coord(y)}`)
    .join(' ');
}

function coord(value: number): string {
  return String(roundTo(value));
}

/**
 * 内容框：一组笔迹在**自己坐标系**里的包围盒，再居中撑到 `INK_MIN_BOX`。
 * 空内容返回 `null`（= 这张卡里没有笔迹）。
 *
 * ★ 落盘时用它的世界版本当卡片尺寸（`inkCardFromStroke`），渲染时用它的局部版本当
 *   viewBox —— **同一个函数**，所以"刚生成的卡片"与"刚画完的笔迹"必然严丝合缝。
 * ★ 撑开是**幂等**的（撑过的框再撑还是它），这正是上面那句"严丝合缝"的依据：
 *   卡片框 = 撑开后的内容框，而渲染再算一次内容框必须得到同一个数。
 *   这条性质在单测里钉着。
 */
export function inkContentBox(paths: readonly InkPath[]): Rect | null {
  const box = strokesBounds(paths);
  if (!box) return null;
  const width = Math.max(box.width, INK_MIN_BOX);
  const height = Math.max(box.height, INK_MIN_BOX);
  return {
    x: box.x - (width - box.width) / 2,
    y: box.y - (height - box.height) / 2,
    width,
    height,
  };
}

/**
 * 把一笔搬进卡片坐标系（点全部减去卡片原点）。
 *
 * ★ 换算走 `toStrokeSpace` 而不是自己写减法：偏移量的定义只允许有一份，
 *   否则"落盘时的原点"与"命中判定时的原点"迟早会对不上（症状是橡皮整体偏一点）。
 * ★ 保留 2 位小数：文件里本来就只有这个精度，留着一串 `0.30000000000000004`
 *   只会让 `.nboard` 变得没法用眼睛读。
 */
export function localizePath(path: InkPath, origin: Point): InkPath {
  const points: InkPoint[] = path.points.map(([x, y, pressure]) => {
    const local = toStrokeSpace({ x, y }, origin);
    const point: InkPoint = [roundTo(local.x), roundTo(local.y)];
    if (typeof pressure === 'number') point.push(pressure);
    return point;
  });
  const local: InkPath = { color: path.color, width: path.width, points };
  // ★ `alpha` 必须跟着走（T7.08）：漏了它，荧光笔画完一落盘就变成不透明的一笔 ——
  //   而"落盘前后长得一模一样"正是这张卡存在的理由（见文件头第 3 条）。
  //   同 `createStroke`：只有真的半透明才写键，普通笔迹一个字节都不多。
  const alpha = strokeAlpha(path);
  if (alpha < 1) local.alpha = alpha;
  return local;
}

/**
 * 刚画完的一笔（**世界坐标**）→ 一张手绘卡。
 *
 * 没有点返回 `null`：一个点都没有的笔画不该变成一张看不见的空卡。
 */
export function inkCardFromStroke(path: InkPath): CardOf<'ink'> | null {
  const box = inkContentBox([path]);
  if (!box) return null;
  const frame: Rect = {
    x: roundTo(box.x),
    y: roundTo(box.y),
    width: roundTo(box.width),
    height: roundTo(box.height),
  };
  return createCard('ink', {
    x: frame.x,
    y: frame.y,
    width: frame.width,
    height: frame.height,
    // 卡片框与内容原点用的是同一个 `frame`（而不是各算一次），于是"框 = 包围盒"
    content: { paths: [localizePath(path, frame)] },
  });
}

/**
 * 换笔迹的颜色。
 *
 * ★ 没有变化返回 `null`：调用方据此**不写撤销步** —— 反复点同一个颜色，
 *   不该在撤销栈里留下一串"什么都没变"的步骤（那会让 ⌘Z 像是坏了）。
 */
export function recolorPaths(paths: readonly InkPath[], color: HexColor): InkPath[] | null {
  if (paths.length === 0) return null;
  if (paths.every((path) => path.color === color)) return null;
  return paths.map((path) => ({ ...path, color }));
}

/**
 * 橡皮命中：**世界坐标**的 `point` 碰到了这张手绘卡里的哪几笔（返回笔迹下标）。
 *
 * ★ 和 `model/ink.ts` 的 `strokesHitByEraser` 不是重复：那边默认"比较的两边在同一套
 *   坐标系里"，而手绘卡的点存的是**卡片内坐标**（见文件头第 2 条），且用户可以把卡片
 *   拉大 —— 这时笔迹会跟着放大（`preserveAspectRatio="none"`），世界坐标与卡片内坐标
 *   之间只差一个平移，现在还要再乘一个缩放。本函数负责把两边对齐，判据本身仍归那边。
 * ★ 换算方向是"把笔迹搬到世界"而不是"把橡皮搬进卡片"：后者得连半径一起缩放，
 *   而缩放后的半径该取哪一个（x 向？y 向？平均？）没有正确答案 —— 不缩放就没这问题。
 *   代价是逐点做一次仿射变换，但候选卡片已经先按包围盒粗筛过一轮（见下面的提前返回）。
 */
export function inkCardStrokeHits(card: CardOf<'ink'>, point: Point, radius: number): number[] {
  const paths = card.content.paths;
  if (paths.length === 0) return [];

  // 卡片框外扩一个橡皮半径都没碰到，就没必要逐点换算 ——
  // ★ 这一步不只是省时间：漏掉它会先把远处的点"换算"成一堆挨着橡皮的假坐标，然后误擦
  if (
    point.x < card.x - radius ||
    point.y < card.y - radius ||
    point.x > card.x + card.width + radius ||
    point.y > card.y + card.height + radius
  ) {
    return [];
  }

  const box = inkContentBox(paths);
  if (!box) return [];
  const scale = contentScale(card, box);
  const average = (scale.x + scale.y) / 2;

  const hits: number[] = [];
  paths.forEach((path, index) => {
    const points: InkPoint[] = path.points.map(([x, y]) => [
      card.x + (x - box.x) * scale.x,
      card.y + (y - box.y) * scale.y,
    ]);
    // 笔宽也要跟着缩放：卡片拉大后线在屏幕上是粗的，判定却按原来的细线就擦不中了
    if (distanceToStroke(points, point) <= radius + (path.width * average) / 2) hits.push(index);
  });
  return hits;
}

/**
 * 卡片内坐标 → 世界坐标的换算系数（卡片框 = 内容框拉满，见文件头第 3 条）。
 *
 * ★ 由橡皮命中与标注归属**共用**：一边"擦得中"、另一边"认不出归属"是自相矛盾的
 *   判定，而这种矛盾只要有两份各写各的减法，迟早会出现。
 * ★ 框退化时按 1 兜底：`INK_MIN_BOX` 已经保证内容框非零，这里只是不让它除以 0。
 */
function contentScale(card: CardOf<'ink'>, box: Rect): { x: number; y: number } {
  return {
    x: card.width > 0 ? card.width / box.width : 1,
    y: card.height > 0 ? card.height / box.height : 1,
  };
}

/**
 * 这一笔的**落笔点**（世界坐标）。内容为空返回 `null`。
 *
 * ★ 取"用户从哪儿起笔"，而不是包围盒中心 / 左上角 —— 归属要能一句话解释给用户听。
 *   一笔绕着图片画了个圈时，中心点会落在图片**外面**（圈越大偏得越多），
 *   左上角更是看不出跟这张图有什么关系；只有"你从这张图上起笔"是说得通的规则。
 * ★ 取第一条**有点的**笔迹：`InkContent.paths` 允许多条，一条空笔迹不该把落点吃掉。
 */
export function inkAnchorOf(card: CardOf<'ink'>): Point | null {
  const box = inkContentBox(card.content.paths);
  if (!box) return null;
  const first = card.content.paths.find((path) => path.points.length > 0)?.points[0];
  if (!first) return null;
  const scale = contentScale(card, box);
  return { x: card.x + (first[0] - box.x) * scale.x, y: card.y + (first[1] - box.y) * scale.y };
}

/**
 * 这张标注画在**哪张卡**身上（`null` = 画在空画布上）。
 *
 * ★ 归属**算出来、不落盘**：规则只有一条，于是"把标注拖离图片"会自然地解除归属，
 *   不存在第二个需要同步的字段（`03 §2.7` 的编组不存包围盒，同一个道理：
 *   派生得出的事实，存下来就多一个能对不上的地方）。
 * ★ 取**层级最高**的那张：叠在一起的卡片里，用户看到的是最上面那张 ——
 *   归属跟着视觉走，才不会被底下那张看不见的卡抢走。
 * ★ 手绘卡**不做宿主**：一笔画在另一笔上时，归属继续往下找真正的卡片，
 *   否则会变成"标注套标注"的传递关系（A 挂在 B 上、B 又挂在 C 上，拖谁都不对）。
 */
export function inkHostCard(cards: readonly Card[], ink: CardOf<'ink'>): Card | null {
  const anchor = inkAnchorOf(ink);
  if (!anchor) return null;

  let host: Card | null = null;
  for (const card of cards) {
    if (card.id === ink.id || card.type === 'ink') continue;
    if (!rectContainsPoint(card, anchor)) continue;
    if (!host || card.z >= host.z) host = card;
  }
  return host;
}

/**
 * 画在这些卡片上的标注 id（T3.09：挪动图片时把它的批注一起带走）。
 *
 * ★ 只认**画布上的**标注（`columnId === null`）：被拖进分栏的标注由分栏管位置，
 *   再让它跟着图片走，会出现"拖一下图片，栏里的卡片被抽走"这种没法解释的事。
 * ★ 拖动开始时算一次就够：它是纯函数、只取决于此刻的几何。过程里**不重算** ——
 *   图片一动归属就可能在中途跳掉，标注会走一半停住（比不走更让人困惑）。
 * ★ 先按**包围盒相交**粗筛一批：落点必然在这张标注自己的框里，两个框挨都挨不上
 *   就不必再逐张卡判"落点落在谁的框里"。刚画完一笔就拖它所属的卡片（标注只有一张、
 *   甚至一张都没有）是最常见的场景，这一步把那一次的开销从 `笔迹数 × 卡片数`
 *   压回纯粹的"过一遍卡片列表"。
 */
export function annotationsOn(cards: readonly Card[], hostIds: readonly string[]): string[] {
  if (hostIds.length === 0) return [];
  const hosts = new Set(hostIds);
  const hostRects = cards.filter((card) => hosts.has(card.id) && card.type !== 'ink');
  if (hostRects.length === 0) return [];

  const annotations: string[] = [];
  for (const card of cards) {
    if (card.type !== 'ink' || card.columnId !== null) continue;
    // 已经在拖动集合里的手绘卡不必再算一遍（它本来就是被选中的那一张）
    if (hosts.has(card.id)) continue;
    if (!hostRects.some((host) => rectsTouch(host, card))) continue;
    const host = inkHostCard(cards, card);
    if (host && hosts.has(host.id)) annotations.push(card.id);
  }
  return annotations;
}

/**
 * 闭区间相交：边界**相接也算**。
 *
 * ★ 粗筛**绝不能比正式判定更严**：正式判定 `rectContainsPoint` 是闭区间的，
 *   而 `rectsIntersect` 是严格相交 —— 拿严格的那个当粗筛，就等于悄悄多加了一条
 *   "两框不许只挨着"的前置条件，而这条条件不是"落点在框里"的必要条件。
 * ★ 今天大概碰不到：`inkContentBox` 会按笔宽往两边各外扩半根线（外加 `INK_MIN_BOX`），
 *   所以标注框总是**骑**在落点上、必然扎进宿主框里。但这个不变量是包装出来的，
 *   不是这两行代码挣来的 —— 粗筛不该把它当成前提（改 `inkContentBox` 的人不会想到
 *   自己顺手改掉了一个远在 `annotationsOn` 里的判定）。
 */
function rectsTouch(a: Rect, b: Rect): boolean {
  return (
    a.x <= b.x + b.width && b.x <= a.x + a.width && a.y <= b.y + b.height && b.y <= a.y + a.height
  );
}

// ─────────────────────────────────────────────────────────────
// 渲染
// ─────────────────────────────────────────────────────────────

function renderInk(el: HTMLElement, card: CardOf<'ink'>): void {
  const doc = el.ownerDocument;
  el.classList.add(INK_SLOT_CLASS);
  el.replaceChildren();

  const paths = card.content.paths;
  const box = inkContentBox(paths);
  // 空卡片（理论上不会出现：手绘卡总是由一笔生成）画成一块透明的空位，
  // 而不是"少了内容"的占位符 —— 它是画布上的一笔，不是一块有内容可读的卡
  if (!box) return;

  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', INK_SVG_CLASS);
  // ★ viewBox 就是内容框、再拉满整张卡（`preserveAspectRatio: none`）：
  //   刚生成时两者相等 → 与手画的那一笔逐像素重合；用户拉大卡片 → 笔迹跟着放大
  svg.setAttribute(
    'viewBox',
    `${coord(box.x)} ${coord(box.y)} ${coord(box.width)} ${coord(box.height)}`,
  );
  svg.setAttribute('preserveAspectRatio', 'none');

  for (const path of paths) {
    if (path.points.length === 0) continue;
    for (const shape of strokeShapes(path)) {
      svg.appendChild(shapeElement(doc, shape, path, INK_STROKE_CLASS));
    }
    // 命中区画在最后：它在同一张卡内部，命中谁都是这张卡，顺序只为读起来顺
    svg.appendChild(shapeElement(doc, strokeHitShape(path), path, INK_HIT_CLASS));
  }

  el.appendChild(svg);
}

function shapeElement(
  doc: Document,
  shape: InkShape,
  path: InkPath,
  className: string,
): SVGElement {
  // ★ 半透明（T7.08 荧光笔）走 `fill-opacity` / `stroke-opacity`，**不是**把 alpha 揉进颜色：
  //   `path.color` 要与文件里的值逐字节一致（改色、去重、diff 都靠它）。
  // ★ 用 `coord` 收敛到与文件同一位数：否则同一个不透明度在 DOM 与 `.nboard` 里
  //   会写成两个略有差异的串，"和上次一样吗"又成了一个说不清的问题。
  const alpha = strokeAlpha(path);
  const opacity = alpha < 1 ? coord(alpha) : null;

  if (shape.kind === 'dot') {
    const circle = doc.createElementNS(SVG_NS, 'circle');
    circle.setAttribute('class', className);
    circle.setAttribute('cx', coord(shape.x));
    circle.setAttribute('cy', coord(shape.y));
    circle.setAttribute('r', coord(shape.radius));
    circle.setAttribute('fill', path.color);
    if (opacity !== null) circle.setAttribute('fill-opacity', opacity);
    return circle;
  }

  const line = doc.createElementNS(SVG_NS, 'path');
  line.setAttribute('class', className);
  line.setAttribute('d', shape.d);
  line.setAttribute('fill', 'none');
  line.setAttribute('stroke', path.color);
  line.setAttribute('stroke-width', coord(shape.width));
  line.setAttribute('stroke-linecap', 'round');
  line.setAttribute('stroke-linejoin', 'round');
  // 命中区也会带上这一笔的透明度 —— 它是看不见的（见 `styles.css`），带不带都一样；
  // 写在同一个函数里是为了"只有一处知道有这么个值"
  if (opacity !== null) line.setAttribute('stroke-opacity', opacity);
  return line;
}

// ─────────────────────────────────────────────────────────────
// 卡片定义
// ─────────────────────────────────────────────────────────────

export const inkCard: CardTypeDefinition<'ink'> = {
  type: 'ink',
  get displayName() {
    return t('card.type.ink');
  },
  icon: 'pen-tool',
  // 手绘卡永远由一笔生成、尺寸即那一笔的包围盒（见 `inkCardFromStroke`）；
  // 这个值只与 `DEFAULT_CARD_SIZES.ink` 对齐，供"新建一张空手绘卡"这种极少数路径用
  defaultSize: DEFAULT_CARD_SIZES.ink,

  createDefaultContent() {
    return { paths: [] };
  },

  contextMenu(card, ctx): CardTypeMenuItem[] {
    return [
      {
        id: 'ink-color',
        title: t('menu.card.inkColor'),
        icon: 'palette',
        // 多选时"改哪一笔"没有明确答案（与"编辑内容"同一条约定：宁可置灰，也不猜）；
        // 锁定的卡连颜色都不该改
        disabled: ctx.multiple || card.locked,
        action: 'inkColor',
      },
    ];
  },

  render(el, card) {
    renderInk(el, card);
  },

  toMarkdown() {
    // 矢量笔迹没有 Markdown 形态：强行写一个空行/占位符只会让导出的笔记变脏。
    // 导出的统计里会记上"有这么一张卡没导出"（`export/toMarkdown.ts`），
    // 想把它带走应该走 PNG 导出（T2.11）
    return '';
  },

  destroy(el) {
    // 节点会被回收池复用给别的类型的卡：类名与内容都要清干净，
    // 否则"一手绘卡留下的类名"会跟着一张便签卡继续生效（命中区、无边框…）
    el.classList.remove(INK_SLOT_CLASS);
    el.replaceChildren();
  },
};
