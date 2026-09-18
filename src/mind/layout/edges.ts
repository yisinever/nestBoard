/**
 * 连线的**几何**（`06 §11.16` 那一套分支点 / 延长线 / 分支线）与折叠手柄的尺寸。
 *
 * ── 为什么它住在 `layout/` 而不是 `view/` ───────────────────
 *
 * 这三件事全是纯几何：一个盒子、一个方向进来，一串坐标或一条 `d` 出去 ——
 * 与 DOM、与主题、与"现在画不画"都无关。搬到这里之后：
 *
 *  * **导出**（`mind/export/toSvg.ts`）能用同一份几何 ⇒ 导出的图与屏幕**线条一致**；
 *  * 边界的规矩也好守：`mind/export/**` 不许 import `mind/view/**`（那条规则区分不了
 *    "脑图自己的 view" 与"白板的 view"，所以最干净的做法是**根本不需要引它**）。
 *
 * ★ 纯函数：不 import `obsidian`、不碰 DOM，可直接单测。
 */

import type { MindEdgeStyle } from '../model/schema';
import type { Point } from '../../util/geometry';
import type { NodeBox } from './tree';

/**
 * 手柄圆圈的直径（px，世界坐标）—— **样式表里那个 `width` 必须与它一致**。
 *
 * ★ 放在这里而不是 `view/render.ts`：手柄的圆心就是**分支点**，而分支点由
 *   {@link MIND_HANDLE_GAP} 决定 —— 尺寸与几何是一件事的两半，分开写必漂。
 */
export const MIND_HANDLE_SIZE = 16;
/**
 * 节点与手柄之间露出来的那截线（"半个手柄长"）。
 *
 * ★ 手柄**不贴着节点**：中间留一截线，手柄再接子节点那些线 ——
 *   这样"手柄坐在分支点上"这件事与线形无关（以后换成折线 / 曲线，
 *   只要分支点还在那条线上，手柄就还是长在那儿）。
 */
export const MIND_HANDLE_STUB = MIND_HANDLE_SIZE / 2;
/** 手柄**中心**离节点边缘的距离：那截线 + 半径（于是两端都刚好接上） */
export const MIND_HANDLE_GAP = MIND_HANDLE_STUB + MIND_HANDLE_SIZE / 2;

/** 这个孩子长在父节点的哪一侧（决定线从哪一侧出发）；**纵向布局一律"往下"** */
export function childSideOf(parent: NodeBox, child: NodeBox): -1 | 1 {
  if (parent.vertical === true) return 1;
  return child.x + child.width / 2 >= parent.x + parent.width / 2 ? 1 : -1;
}

/**
 * **分支点**（交汇点）：节点朝某一侧让出 {@link MIND_HANDLE_GAP} 之后的那一点。
 *
 * ★ 连线从这里**出发**（不再从节点边缘出发），节点边缘到这里的这一段就是
 *   "节点延伸出来的那条线"（见 {@link edgeTrunkPathOf}）——
 *   于是画面上是"节点 —— 延长线 —— 交汇点 —— 分支线"，一条连到底；
 *   而折叠手柄的圆心就落在这个交汇点上。
 * ★ 方向是参数：同一侧才共用一条延长线。
 * ★ **纵向布局只有一个方向（往下）** ⇒ `direction` 不参与，交汇点落在节点**下边缘**之外。
 */
export function branchPointOf(box: NodeBox, direction: -1 | 1): Point {
  if (box.vertical === true) {
    return { x: box.x + box.width / 2, y: box.y + box.height + MIND_HANDLE_GAP };
  }
  return {
    x: direction === 1 ? box.x + box.width + MIND_HANDLE_GAP : box.x - MIND_HANDLE_GAP,
    y: box.y + box.height / 2,
  };
}

/**
 * **延长线**（节点边缘的中点 → 分支点）的 `d`。
 *
 * ★ 单独画一段而不是靠"分支线往回够"：收起状态下没有任何分支线，
 *   光靠它们的话手柄会孤零零地飘在节点外面。
 */
export function edgeTrunkPathOf(box: NodeBox, direction: -1 | 1): string {
  if (box.vertical === true) {
    const x = box.x + box.width / 2;
    const from = box.y + box.height;
    return `M ${x} ${from} L ${x} ${from + MIND_HANDLE_GAP}`;
  }
  const y = box.y + box.height / 2;
  const from = direction === 1 ? box.x + box.width : box.x;
  const to = from + MIND_HANDLE_GAP * direction;
  return `M ${from} ${y} L ${to} ${y}`;
}

/**
 * 一条父子连线的 `d`（四种形态，`08 §1.3`）。
 *
 * 起点是父节点的**分支点**（交汇点），终点是孩子朝向父节点的那条边 ——
 * 于是线的两端永远贴着该贴的地方，节点宽窄不一也不会插进盒子里。
 * **四种形态共用这一对端点**：变的只是"从交汇点之后怎么走到孩子"，所以换线型
 * 不会让线头离开节点（那是换线型最容易踩的坑）。
 *
 * ★ 纯函数、给字符串：连线最容易写错的就是"左边那一侧方向反了"，
 *   而它一笔一画都能量出来比较。
 * ★ **延长线（`edgeTrunkPathOf`）与分支点（`branchPointOf`）与线型无关** ——
 *   折叠手柄坐在交汇点上，线型换来换去它都不动。
 * ★ 内部在**逻辑坐标**（层级轴 / 兄弟轴）里算，最后按 `vertical` 组装成 x / y ——
 *   于是"向下"这一档就是同一张图转了 90°，不必为它再写四种线型。
 */
export function edgePathOf(
  parent: NodeBox,
  child: NodeBox,
  style: MindEdgeStyle = 'curve',
): string {
  const vertical = parent.vertical === true;
  const toFar = childSideOf(parent, child) === 1;
  /** 逻辑坐标 `(层级坐标, 兄弟坐标)` → 世界坐标 */
  const at = (level: number, sibling: number): Point =>
    vertical ? { x: sibling, y: level } : { x: level, y: sibling };

  // 起点：父节点**朝孩子那一侧**的边缘再让出一个 GAP（就是交汇点）
  const startLevel = toFar
    ? (vertical ? parent.y + parent.height : parent.x + parent.width) + MIND_HANDLE_GAP
    : parent.x - MIND_HANDLE_GAP;
  const startSibling = vertical ? parent.x + parent.width / 2 : parent.y + parent.height / 2;
  // 终点：孩子**朝父节点那一侧**的边缘中点
  const endLevel = toFar ? (vertical ? child.y : child.x) : child.x + child.width;
  const endSibling = vertical ? child.x + child.width / 2 : child.y + child.height / 2;

  const start = at(startLevel, startSibling);
  const end = at(endLevel, endSibling);
  const runSign = endLevel - startLevel >= 0 ? 1 : -1;

  if (style === 'line') {
    return `M ${start.x} ${start.y} L ${end.x} ${end.y}`;
  }

  // 折线的转折点：沿**层级轴**取中点（四种形态里"肘"都落在同一条线上，观感才连得上）
  const mid = startLevel + (endLevel - startLevel) / 2;

  if (style === 'elbow') {
    return elbowPath(start, at(mid, startSibling), at(mid, endSibling), end);
  }

  if (style === 'rounded') {
    const spread = endSibling - startSibling;
    const vSign = spread >= 0 ? 1 : -1;
    /**
     * 圆角半径：只受**孩子那一端**的余量约束，也不能太大（半径一大就不像折线了）。
     *
     * ★ 从前这里两头都要留 `r`（父端也要一段"进入圆弧的直线"），所以写的是 `/2`；
     *   现在父端走直角、不占余量 ⇒ 兄弟轴那一段要跑满 `|spread|`、层级轴最后那一小段
     *   要跑满 `|endLevel - mid|`，两项都不再除以 2。
     */
    const r = Math.min(12, Math.abs(spread), Math.abs(endLevel - mid));
    // 太平 / 太短时圆弧画不出来（r 会退化），退回直角折线 —— 宁可方一点，也不要画出一个怪东西
    if (r < 1) return elbowPath(start, at(mid, startSibling), at(mid, endSibling), end);

    // ★★ **圆角只给孩子那一端**（用户 2026-09-17："现在是父节点这一端和子节点这一端的都用了圆角，
    //   靠近父节点这一端直接用直角折线的样式即可，子节点那一端保持"）。
    //   父端那个转折点因此与**直角折线走同一段**（起点直接杀到转折点）——
    //   主干那一带于是全是方角、贴着节点的最后一下才拐圆，长出来更像"从主干分出来"而不是
    //   "两朵花各开一头"。★ 转折点仍在 `mid` 那条线上：与 `elbow` / `line` 共用同一条"肘线"。
    const corner1 = at(mid, startSibling);
    const b1 = at(mid, endSibling - vSign * r);
    const corner2 = at(mid, endSibling);
    const b2 = at(mid + r * runSign, endSibling);

    return (
      `M ${start.x} ${start.y}` +
      // 父端：直角（与 `elbowPath` 的前两点逐字相同）
      ` L ${corner1.x} ${corner1.y}` +
      ` L ${b1.x} ${b1.y}` +
      // 子端：保持圆角
      ` Q ${corner2.x} ${corner2.y} ${b2.x} ${b2.y}` +
      ` L ${end.x} ${end.y}`
    );
  }

  // 曲线（默认）：控制点沿**层级轴**拉出半个跨度，跨度小的时候给小值兜底，否则线会缩成一个点
  const run = Math.max(16, Math.abs(endLevel - startLevel) * 0.5) * runSign;
  const c1 = at(startLevel + run, startSibling);
  const c2 = at(endLevel - run, endSibling);
  return `M ${start.x} ${start.y} C ${c1.x} ${c1.y} ${c2.x} ${c2.y} ${end.x} ${end.y}`;
}

/** 直角折线：沿层级轴 → 沿兄弟轴 → 沿层级轴（兄弟差为 0 时它自然退化成一条直线） */
function elbowPath(start: Point, bend1: Point, bend2: Point, end: Point): string {
  return `M ${start.x} ${start.y} L ${bend1.x} ${bend1.y} L ${bend2.x} ${bend2.y} L ${end.x} ${end.y}`;
}
