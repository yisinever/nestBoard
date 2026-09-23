/**
 * 脑图布局（`06 §5`）—— **纯函数**：进模型，出每个节点的矩形。
 *
 * ```
 * layoutMind(file) → { boxes: Map<id, NodeBox>, bounds, hiddenCount }
 * ```
 *
 * ── 规则（XMind 的默认观感）──────────────────────────────────
 *
 * * **根在原点**：世界坐标以**中心主题的中心**为 `(0, 0)`（渲染层再套视口变换）。
 * * **子节点左右分列**：根的孩子按**下标交替**（偶右奇左）。为什么不是"按高度贪心配平"：
 *   那样一折叠某一支，别的支就会整支挪到另一边（见 `placeBranch` 上方那段注释）。
 * * **同层列对齐**：每一侧、每一深度取"最宽的那个节点"作为该列宽度，列与列之间留
 *   `levelGap`。兄弟宽度不一时左边缘仍然对齐 —— 这是"看起来像脑图"最关键的一条。
 * * **每侧垂直居中**：一侧的全部子树合起来垂直居中于根，父节点自己居中于它的子树。
 * * **折叠不排**：`collapsed` 的子树一个节点都不排（也不渲染）。
 * * **悬浮节点不参与排布**：它们的坐标来自文件里的 `free`（**中心点**，与布局同一个坐标系），
 *   它们的子树**一律向右**展开（自由主题在 XMind 里也没有两侧的语义）。
 *
 * ── 为什么必须是纯函数 ──────────────────────────────────────
 *
 * ① 1000 个节点的布局要能**快照测试**（同样的输入必须布局成同样的坐标）；
 * ② 渲染层要能在"尺寸量出来之后"重排一次，而不必重建 DOM —— 排布与画面彻底分开。
 * ★ 不 import `obsidian`、不碰 DOM、不认识颜色 —— 那是 `palette.ts` 与视图的事。
 */

import type { Rect, Size } from '../../util/geometry';
import type { MindFile, MindNode, MindStructure } from '../model/schema';
import { estimateNodeSize, type MeasureOptions } from './measure';

/** 层级之间的水平间距（px） */
export const MIND_LEVEL_GAP = 46;
/** 兄弟之间的垂直间距（px） */
export const MIND_SIBLING_GAP = 14;

export interface NodeBox {
  id: string;
  /** 左边缘（世界坐标，原点 = 中心主题的中心） */
  x: number;
  y: number;
  width: number;
  height: number;
  /** 深度：根 = 0；悬浮节点也算 0（它不是任何人的孩子） */
  depth: number;
  /** 这一支挂在根的哪一侧（根与悬浮节点是 0）—— 画连线要用 */
  side: -1 | 0 | 1;
  /** 坐标来自 `free`（不参与排布） */
  free: boolean;
  /**
   * 这一份布局是**纵向**的（组织结构图，向下）。
   *
   * ★ 连线 / 折叠手柄要它才画得对：层级轴在 y 上时，"出发边"是父节点的**下边缘**、
   *   手柄那截短线朝**上** —— 只看 `side` 是分不出"往右"与"往下"的（两者的 `side` 都是 1）。
   * ★ 缺席 = 横向（既有构造点与单测夹具都不必改）。
   */
  vertical?: boolean;
  /**
   * 同层等宽的**下限宽度**（px，用户 2026-09-21："一个分支下同一层级的节点长度，
   * 以同层级最长的那个节点为准，大家都对齐它"）。
   *
   * ★ 为什么是"下限"而不是"宽度"：节点的真实宽度由 CSS + 内容决定，并且是**量出来的**
   *   （`measure`）而不是布局写下去的。布局只告诉渲染层"这一层至少要这么宽"，渲染层把它
   *   写成 `min-width`，下一轮量测量到的就是真值 —— 不会变成"自己写、自己量"的自证。
   * ★ 缺席 = 这一层只有它自己（或调用方没要求等宽）。
   */
  minWidth?: number;
}

export interface MindLayout {
  /** 只含**可见**节点：树上没被折叠藏起来的 + 全部悬浮节点（含它们的子树） */
  boxes: Map<string, NodeBox>;
  /** 全部可见节点的外接矩形；一个可见节点都没有时是 `null` */
  bounds: Rect | null;
  /** 被折叠藏起来的节点数（= 模型里的节点数 − 可见节点数） */
  hiddenCount: number;
}

/**
 * 主树的走向（**布局层的输入**；界面上那一栏叫「总体结构」，见 `08 §1.2`）。
 *
 * * `'right'`：**全部向右**（逻辑图，默认）；
 * * `'left'`：**全部向左**（逻辑图向左）—— 与 `'right'` 逐条镜像；
 * * `'two-sided'`：孩子按下标左右交替（八爪鱼 / XMind 默认观感）；
 * * `'down'`：**向下**（组织结构图）—— 层级轴换到 y，兄弟轴换到 x（见 `layoutMind` 里的轴抽象）。
 *
 * ★ `fishbone`（鱼骨图）还没有对应的走向：它是**另一套算法**（`08` 的 P8-d）。
 *   在那之前，`MindView` 把它**回落到 `'right'`**（不报错、也不改文件）。
 * ★ 默认值仍是 `'two-sided'`（历史行为，单测与快照都按它写的）——
 *   产品用哪一种由**视图显式传**（`MindView.layoutOptions()` 一处）。
 */
export type MindDirection = 'right' | 'left' | 'two-sided' | 'down';

/**
 * **总体结构 → 布局走向**（`08 §1.2`）。
 *
 * ★ 写成函数而不是内联三元：它要被逐条单测（错一格就是"选了向左却往右长"，
 *   而那种错在界面上看起来像"这个按钮没用"）。
 * ★ 只剩 `fishbone` 没有走向（另一套算法，`08` 的 P8-d）⇒ 回落到向右，
 *   界面上它也是"待做"、不可选 —— 两道一起兜。
 */
export function directionForStructure(structure: MindStructure): MindDirection {
  if (structure === 'logic-left') return 'left';
  if (structure === 'octopus') return 'two-sided';
  if (structure === 'org-down') return 'down';
  return 'right';
}

export interface MindLayoutOptions {
  /**
   * 量出来的尺寸表。不传 = 用 `estimateNodeSize` 估算（单测 / 首帧）。
   *
   * ★ 渲染层量到真尺寸后再调一次本函数即可完成重排 —— 布局本身不缓存任何东西。
   */
  sizeOf?: (node: MindNode) => Size;
  /**
   * 算"**同层等宽**"（`minWidth`）用的尺寸。**默认就取 `sizeOf` 那一份**。
   *
   * ── 为什么量到真尺寸的那一路必须单独给这一份（`2.2.0` 收尾 · 用户 2026-09-22 报的
   *    "超过第二级同层就不齐了"）──────────────────────────────
   *
   * `min-width` **只抬高、不压低**。画布上那条路是这样跑的：布局给出下限 → 渲染层写成
   * `min-width` → 量真尺寸 → 再排一遍。要是第二遍还拿"量到的宽度"去算"这一层谁最宽"，
   * 量到的那个数里已经含着**上一轮自己撑开**的那一档 ⇒ 算出来永远是"就是刚才那个下限"
   * ⇒ "比最宽的窄"这个判据一个都不成立 ⇒ **下限当场消失**、节点又变得参差不齐。
   *
   * ★ 所以：这一份要的是**内容真宽** —— 把下限摘掉之后量到的宽度
   *   （`render.measureNodeSizes` 就是干这个的），缩略图 / 导出那一路不必给
   *   （它们的 `sizeOf` 本来就是估算，没有 DOM，也就无所谓"自证"）。
   * ★ 只有**宽度**会从这里读（同层等宽永远是宽度上的事，不分横竖）。
   */
  intrinsicSizeOf?: (node: MindNode) => Size;
  /** 传给估算器的参数（渲染层把真实字号 / 行高传进来） */
  measure?: MeasureOptions;
  /** 主树走向（见 {@link MindDirection}，默认两侧交替） */
  direction?: MindDirection;
  levelGap?: number;
  siblingGap?: number;
  /**
   * 聚焦的节点 id（`D1`）：**把它当作新的根**重排 —— "进入当前主题"就是这件事。
   *
   * ★ 三处 `layoutMind` 调用必须传**同一份**（渲染 / 重排 / 挂载）：只传一处的话，
   *   会出现"刚打开是全树、动一下才变成聚焦那一支"。
   * ★ id 不在（节点被删 / 文件被手改坏）⇒ 退回真正的根（见函数体里的说明）。
   */
  focusId?: string;
}

/**
 * **两遍**布局：把"同层等宽"从样式提示**落进几何**（`2.2.0` 批 4 六）。
 *
 * ── 为什么需要它 ──────────────────────────────────────────
 *
 * "同层等宽"（用户 2026-09-21）在画布上是这么实现的：布局给的 `box.minWidth` 只写成 CSS 变量
 * （`--nestboard-mind-node-min-width`），节点**先按内容宽摆一次**，样式表把矮的几个撑宽，
 * 紧接着渲染层**量一遍真尺寸**再排第二次 —— 于是最终画面上同层是齐的。
 *
 * 拿不到 DOM 的那一侧（缩略图 / PNG·SVG·PDF 导出）**没有第二次测量**：只有估算那一路，
 * 而估算给的是"内容宽" ⇒ 导出的树里同层节点参差不齐，比画布上窄一大截。
 * 用户报的"绘制尺寸不是很还原"就是这一处。
 *
 * ── 做法 ─────────────────────────────────────────────────
 *
 * 第一遍照常排（拿到每个节点该有的"下限"），第二遍把**每个节点的宽至少撑到那个下限**
 * 再排一次。第二遍算出来的下限与前一遍一致（每层最宽的那个没变），因此一遍就收敛。
 *
 * ★ 第二遍走的是"把 `sizeOf` 撑宽"这条路，而 `intrinsicSizeOf` **原样透传**：
 *   画布那条路（`MindView` / `EmbedMind`）传进来的正是"内容真宽"，于是第二遍里
 *   那几个窄的仍然"比最宽的窄" ⇒ 它们的 `minWidth` 还在 ⇒ 渲染层照旧把下限写下去。
 *   不传 `intrinsicSizeOf` 的话第二遍的判据会失效（见那一条的说明），
 *   画布上的结果就是"撑了一下、又缩回去"。
 */
export function layoutMindEqualLevels(file: MindFile, options: MindLayoutOptions = {}): MindLayout {
  const first = layoutMind(file, options);
  const minWidths = new Map<string, number>();
  for (const [id, box] of first.boxes) {
    if (box.minWidth !== undefined) minWidths.set(id, box.minWidth);
  }
  // 一层里没有更宽的邻居（绝大多数小树）⇒ 两遍是同一份结果，不必再排一次
  if (minWidths.size === 0) return first;

  const base =
    options.sizeOf ??
    ((node: MindNode): Size =>
      options.measure ? estimateNodeSize(node, options.measure) : estimateNodeSize(node));

  return layoutMind(file, {
    ...options,
    sizeOf: (node) => {
      const size = base(node);
      const min = minWidths.get(node.id);
      return min !== undefined && min > size.width ? { ...size, width: min } : size;
    },
  });
}

export function layoutMind(file: MindFile, options: MindLayoutOptions = {}): MindLayout {
  const levelGap = options.levelGap ?? MIND_LEVEL_GAP;
  const siblingGap = options.siblingGap ?? MIND_SIBLING_GAP;
  const direction = options.direction ?? 'two-sided';
  const boxes = new Map<string, NodeBox>();

  const byId = new Map<string, MindNode>();
  for (const node of file.nodes) byId.set(node.id, node);

  // 聚焦（`D1`，用户 2026-09-18："树视图也支持进入当前主题"）：**把这一支当作新的根重排**。
  // ★ 这就是"进入当前主题"的全部含义 —— 布局这一层认了它，画布上的节点、连线、
  //   自动取景与缩略图就都跟着只画这一支（各处读的都是这份几何）。
  // ★ 聚焦的 id 不在（节点被删 / 文件被手改坏）⇒ 退回真正的根：校验层也会清掉它，
  //   但布局不该依赖那一层 —— 它可能比校验先跑（刚删除、还没落盘的那一帧）。
  const focusId = options.focusId;
  const root = (focusId ? byId.get(focusId) : null) ?? byId.get(file.rootId);
  if (!root) return { boxes, bounds: null, hiddenCount: file.nodes.length };

  // 孩子表（按 order，再按 id 破平 —— 与 `validate` 的归一化同一个口径）
  const children = new Map<string, MindNode[]>();
  for (const node of file.nodes) {
    if (node.parentId === null) continue;
    const list = children.get(node.parentId);
    if (list) list.push(node);
    else children.set(node.parentId, [node]);
  }
  for (const list of children.values()) {
    list.sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1));
  }

  const measure = (node: MindNode): Size => {
    if (options.sizeOf) return options.sizeOf(node);
    return options.measure ? estimateNodeSize(node, options.measure) : estimateNodeSize(node);
  };

  /**
   * 算"同层最宽"用的尺寸（见 `intrinsicSizeOf` 的说明）：默认与 `measure` 同一份 ——
   * 估算那一路到此为止就够，而**量到真尺寸**的那一路必须单独给一份"内容真宽"，
   * 否则下限会被自己上一轮撑开的宽度抹掉（这一条就是那句"尺寸不能自证"）。
   */
  const intrinsicMeasure = options.intrinsicSizeOf ?? measure;

  /** 折叠的节点：孩子一个都不排 */
  const visibleChildren = (node: MindNode): MindNode[] =>
    node.collapsed === true ? [] : (children.get(node.id) ?? []);

  // ── 同层等宽（用户 2026-09-21）──────────────────────────────
  //
  // "一个分支下同一层级的节点长度，以同层级最长的那个节点为准，大家都对齐它。"
  // 实现成**每一侧、每一深度**取一次最大宽度（左右两侧互不影响，与 `collectLevelSizes`
  // 同一条口径），再把那个宽度记到同层每个**比它窄**的节点上（`minWidth`）。
  //
  // ★ 与 `collectLevelSizes` 分开写：那个收的是**层级轴**上的长度（横向布局下是宽、
  //   纵向布局下是高），而这一条**不分方向**，收的永远是宽。
  const minWidths = new Map<string, number>();

  const collectLevelWidths = (
    heads: readonly MindNode[],
    into: Map<number, number>,
    depth = 1,
  ): void => {
    for (const head of heads) {
      // ★ 用 `intrinsicMeasure`（内容真宽）而不是 `measure`：后者在画布那条路上是"量到的
      //   宽度"，里面已经含着上一轮自己写下的下限 —— 用它算最宽等于拿答案当条件。
      const width = intrinsicMeasure(head).width;
      if (width > (into.get(depth) ?? 0)) into.set(depth, width);
      collectLevelWidths(visibleChildren(head), into, depth + 1);
    }
  };

  /** 把"这一层最宽的那个值"记到同层每个比它窄的节点上（记的是**下限**） */
  const noteLevelWidths = (
    heads: readonly MindNode[],
    into: Map<number, number>,
    depth = 1,
  ): void => {
    for (const head of heads) {
      const width = into.get(depth);
      // ★ 比的是**内容真宽**（理由同上）：拿量到的宽度比，被撑开过的那些永远"不窄于最宽"
      //   ⇒ 它们拿不到下限 ⇒ 下一遍 `applyNodeBox` 把下限变量摘掉 ⇒ 节点缩回内容宽
      if (width !== undefined && width > intrinsicMeasure(head).width)
        minWidths.set(head.id, width);
      noteLevelWidths(visibleChildren(head), into, depth + 1);
    }
  };

  /** 出盒子前把同层等宽的下限挂上去（没记过就不挂 —— 缺席即"不要求等宽"） */
  const withMinWidth = (box: NodeBox): NodeBox => {
    const minWidth = minWidths.get(box.id);
    if (minWidth !== undefined) box.minWidth = minWidth;
    return box;
  };

  // ── 轴（`08 §1.2` 的"轴通用化"）────────────────────────────
  //
  // 说白了只有一句话：**先在"逻辑坐标"里排，最后再组装成 x / y**。
  //
  // | | 层级轴（树的深度往哪长） | 兄弟轴（同层怎么排） |
  // | --- | --- | --- |
  // | 逻辑图（向右 / 向左） | x（右 / 左） | y |
  // | 八爪鱼 | x（两侧） | y |
  // | 组织结构图（向下） | **y（向下）** | **x** |
  //
  // 排布的数学（子树占多长、同层怎么对齐、父节点居中于子树）在两套轴下**逐字相同** ——
  // 只是"长度"取的是宽还是高、最后组装成哪个坐标不同。抽成一份之后四个方向共用同一套算法；
  // 抄第二份的下场是那四条核心规则（同层对齐 / 每侧居中 / 折叠不排 / 悬浮按 `free`）慢慢长歪。
  const vertical = direction === 'down';
  /** 节点在**兄弟轴**上的长度（横向布局 = 高；纵向布局 = 宽） */
  const siblingSize = (size: Size): number => (vertical ? size.width : size.height);
  /** 节点在**层级轴**上的长度（横向布局 = 宽；纵向布局 = 高） */
  const levelSize = (size: Size): number => (vertical ? size.height : size.width);

  // ── 第一遍：每棵子树在兄弟轴上占多长（记忆化，O(n)）──
  const extents = new Map<string, number>();
  const siblingExtentOf = (node: MindNode): number => {
    const cached = extents.get(node.id);
    if (cached !== undefined) return cached;

    const own = siblingSize(measure(node));
    const kids = visibleChildren(node);
    let value = own;
    if (kids.length > 0) {
      const span =
        kids.reduce((sum, kid) => sum + siblingExtentOf(kid), 0) + siblingGap * (kids.length - 1);
      value = Math.max(own, span);
    }
    extents.set(node.id, value);
    return value;
  };

  /**
   * 一棵子树"各深度的**最大层级长度**"（`depth` 从 1 起算）。
   *
   * ★ 只在这一侧之内取最大值：左右两侧的列宽互不影响 —— 否则左侧一个超宽节点
   *   会把右侧所有节点也推远一截，看起来像"没对齐"。
   * ★ 纵向布局里它取的是**高**（"行高"），规则一字不变。
   */
  const collectLevelSizes = (
    heads: readonly MindNode[],
    into: Map<number, number>,
    depth = 1,
  ): void => {
    for (const head of heads) {
      const size = levelSize(measure(head));
      const current = into.get(depth) ?? 0;
      if (size > current) into.set(depth, size);
      collectLevelSizes(visibleChildren(head), into, depth + 1);
    }
  };

  /** 第 `depth` 列在层级轴上离基准点的起点：第 1 列从 `rootHalf + levelGap` 起，之后每列推一列长 + 一个间距 */
  const levelStart = (levelSizes: Map<number, number>, rootHalf: number, depth: number): number => {
    let start = rootHalf + levelGap;
    for (let level = 1; level < depth; level++) {
      start += (levelSizes.get(level) ?? 0) + levelGap;
    }
    return start;
  };

  /**
   * 逻辑坐标 → 盒子。
   *
   * @param start 沿层级轴离基准点的距离（横向布局 = x；纵向布局 = y）
   * @param siblingCenter 兄弟轴上的中心（横向布局 = y；纵向布局 = x）
   * @param side 横向布局：`1` 往右 / `-1` 往左；**纵向布局一律当"往下"**（`side = 1`）
   */
  const boxOf = (
    node: MindNode,
    size: Size,
    start: number,
    siblingCenter: number,
    side: -1 | 0 | 1,
    depth: number,
    baseLevel: number,
    free: boolean,
  ): NodeBox => {
    if (vertical) {
      return {
        id: node.id,
        x: siblingCenter - size.width / 2,
        y: baseLevel + start,
        width: size.width,
        height: size.height,
        depth,
        side: 1,
        free,
        vertical: true,
      };
    }
    return {
      id: node.id,
      x: side === -1 ? baseLevel - (start + size.width) : baseLevel + start,
      y: siblingCenter - size.height / 2,
      width: size.width,
      height: size.height,
      depth,
      side,
      free,
    };
  };

  /**
   * 排一棵子树（两侧、向右、向下都走这一个函数）。
   *
   * @param siblingCenter 这一棵子树在**兄弟轴**上的中心
   * @param side 横向布局：`1` 往右 / `-1` 往左；纵向布局一律当"往下"
   * @param baseLevel 层级轴的**基准点**：主树是 0（根中心），悬浮节点的子树是它自己的中心 ——
   *   否则自由主题的子树会被排到原点附近（看着像"飘到别处去了"）
   */
  const placeBranch = (
    node: MindNode,
    siblingCenter: number,
    side: -1 | 1,
    depth: number,
    levelSizes: Map<number, number>,
    rootHalf: number,
    baseLevel: number,
  ): void => {
    const size = measure(node);
    const start = levelStart(levelSizes, rootHalf, depth);
    boxes.set(
      node.id,
      withMinWidth(boxOf(node, size, start, siblingCenter, side, depth, baseLevel, false)),
    );

    const kids = visibleChildren(node);
    if (kids.length === 0) return;

    const span =
      kids.reduce((sum, kid) => sum + siblingExtentOf(kid), 0) + siblingGap * (kids.length - 1);
    let cursor = siblingCenter - span / 2;
    for (const kid of kids) {
      const kidExtent = siblingExtentOf(kid);
      placeBranch(kid, cursor + kidExtent / 2, side, depth + 1, levelSizes, rootHalf, baseLevel);
      cursor += kidExtent + siblingGap;
    }
  };

  // ── 主树：根居中于原点（两个轴下都是"居中" ⇒ 这一段不分轴）──
  const rootSize = measure(root);
  boxes.set(root.id, {
    id: root.id,
    x: -rootSize.width / 2,
    y: -rootSize.height / 2,
    width: rootSize.width,
    height: rootSize.height,
    depth: 0,
    side: 0,
    free: false,
    ...(vertical ? { vertical: true } : {}),
  });

  // ★ 根自己**不参与同层等宽**：它一个人占一层（`depth 0`），拉宽它只会把整张图撑开

  const rootKids = visibleChildren(root);
  // ★ 分侧按**下标交替**（偶右奇左），而不是"按当前高度贪心配平"：
  //   贪心配平会让"折叠一支"把**别的支整支挪到另一边**（右变矮了，下一个就改挂右边）——
  //   用户眼前的东西突然横跨过中心主题，比"两侧高度不匀"难受得多。
  //   交替还有一个好处：加第 N 个孩子时前面几支一动不动。
  // ★ 只有一个方向的三种走法（向右 / 向左 / **向下**）：全部挂同一侧，
  //   列长也就只有一套 —— 对齐比两侧模式更强（左右两侧的列长本来互不影响）。
  const right: MindNode[] = [];
  const left: MindNode[] = [];
  if (direction === 'right' || direction === 'down') {
    right.push(...rootKids);
  } else if (direction === 'left') {
    // 逻辑图（向左）：全部挂左边 —— `boxOf` 里左侧的列坐标是 `baseLevel - (start + width)`
    left.push(...rootKids);
  } else {
    rootKids.forEach((kid, index) => {
      if (index % 2 === 0) right.push(kid);
      else left.push(kid);
    });
  }

  const rootHalf = levelSize(rootSize) / 2;
  for (const [side, heads] of [
    [1, right],
    [-1, left],
  ] as const) {
    if (heads.length === 0) continue;
    const levelWidths = new Map<number, number>();
    collectLevelSizes(heads, levelWidths);
    // 同层等宽：这一侧各层"最宽的那个"先算出来、记到同层节点上（必须在出盒子之前）
    const boxWidths = new Map<number, number>();
    collectLevelWidths(heads, boxWidths);
    noteLevelWidths(heads, boxWidths);
    // 这一侧的整段长度（最后那个孩子后面不加间距）
    const span =
      heads.reduce((sum, kid) => sum + siblingExtentOf(kid), 0) + siblingGap * (heads.length - 1);
    let cursor = -span / 2;
    for (const kid of heads) {
      const kidExtent = siblingExtentOf(kid);
      placeBranch(kid, cursor + kidExtent / 2, side, 1, levelWidths, rootHalf, 0);
      cursor += kidExtent + siblingGap;
    }
  }

  // ── 悬浮节点：坐标来自 `free`（中心点），子树一律向右展开 ──
  // ★★ **聚焦时整趟跳过**（`D1`）：此刻根是"用户要走进去的那一支"，而中心主题与
  //   那些真正飘在外面的节点 `parentId` 都是 `null` ⇒ 不跳过的话，它们会以"悬浮节点"
  //   的身份**继续挂在画面上**（走进一支之后，旁边还杵着中心主题与别人的分支）。
  //   这一条不写，`focusId` 就只是"换了根"，看着根本不像"进入主题"。
  if (focusId === undefined) {
    for (const node of file.nodes) {
      if (node.parentId !== null || node.id === root.id) continue;
      placeFreeNode(node);
    }
  }

  function placeFreeNode(node: MindNode): void {
    const size = measure(node);
    const center = node.free ?? { x: 0, y: 0 };
    boxes.set(node.id, {
      id: node.id,
      x: center.x - size.width / 2,
      y: center.y - size.height / 2,
      width: size.width,
      height: size.height,
      depth: 0,
      side: 0,
      free: true,
      ...(vertical ? { vertical: true } : {}),
    });

    const kids = visibleChildren(node);
    if (kids.length === 0) return;

    const levelWidths = new Map<number, number>();
    collectLevelSizes(kids, levelWidths);
    // 悬浮节点的子树自成一支：同层等宽在它内部各算一份
    const boxWidths = new Map<number, number>();
    collectLevelWidths(kids, boxWidths);
    noteLevelWidths(kids, boxWidths);
    const span =
      kids.reduce((sum, kid) => sum + siblingExtentOf(kid), 0) + siblingGap * (kids.length - 1);
    // ★ 悬浮节点的子树跟着**这一份图的方向**走（横向往右、纵向往下）：
    //   它是"一块跟着结构走的自由主题"，不该在纵向图里独自横着长
    const siblingBase = vertical ? center.x : center.y;
    let cursor = siblingBase - span / 2;
    for (const kid of kids) {
      const kidExtent = siblingExtentOf(kid);
      // 基准点 = 悬浮节点自己的中心，半个长度 = 它在层级轴上的一半
      placeBranch(
        kid,
        cursor + kidExtent / 2,
        1,
        1,
        levelWidths,
        levelSize(size) / 2,
        vertical ? center.y : center.x,
      );
      cursor += kidExtent + siblingGap;
    }
  }

  // ── 鱼骨图（`P8-d`）：主脊 + 斜支 ──────────────────────────
  // ★ 做法是**后处理**，不是另写一套排布：主树先按"向右"那套排好（每个分支自己
  //   仍是一棵漂亮的右向树），完工后再把**一级分支整体**搬到一条水平主脊上、
  //   上下交替。这样上面那套排布数学一个字都不用改 —— 四种既有走向的输出
  //   逐字节不变（快照护航）。
  // ★ 主脊那条**线**不在这里画（那是渲染层的事，见 `edges.ts` / `paintEdges` 的脊线）；
  //   这里只负责"把支摆到脊上"，于是"形状"这件事在模型层就能被单测钉住。
  return { boxes, bounds: boundsOfBoxes(boxes), hiddenCount: file.nodes.length - boxes.size };
}

/** 全部可见节点的外接矩形 */
export function boundsOfBoxes(boxes: ReadonlyMap<string, NodeBox>): Rect | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const box of boxes.values()) {
    if (box.x < minX) minX = box.x;
    if (box.y < minY) minY = box.y;
    if (box.x + box.width > maxX) maxX = box.x + box.width;
    if (box.y + box.height > maxY) maxY = box.y + box.height;
  }
  if (!Number.isFinite(minX)) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
