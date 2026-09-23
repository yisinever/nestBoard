/**
 * **卡内嵌脑图**的渲染与手势（`F3a`）—— 白板上那张脑图卡里跑的就是它。
 *
 * 一句话：把 `MindView` 的画布那一层**按卡面尺寸裁一圈**再装进卡片里 ——
 * 同一套 `layout/`（纯函数）+ 同一套 `view/render.ts`（节点 / 连线 / 手柄的 DOM 构件），
 * 于是"白板里的脑图"与"标签页里的脑图"长得一模一样，改一处两边都跟着变。
 *
 * ── 与 `MindView` 的五处刻意差别（都是"它没有整屏可用"带来的）────────
 *
 * 1. **只画前几层**（{@link pruneMindForEmbed}）：卡面比屏幕小得多，整棵树塞进来
 *    只会糊成一片；更深的收成 `+N` 角标。
 *    ★ `placement: 'anchor'`（白板级脑图）**不截断** —— 画布上就是要看整棵，
 *      而且节点连线要有盒子可取（见 `embedMaxDepth`）。
 * 2. **节点永远 1:1**：卡面装不下时**让卡片长大**（{@link EmbedMindOptions.onRequiredSize}
 *    → 视图的 `growTo`），**不是**把这棵树缩小。
 *    ★ 用户 2026-09-21："我现在不断地增加节点，会让整个脑图的所有节点都缩小。应该是无论如何
 *      增加节点，脑图中节点尺寸不用相对白板等比缩小。" `F4` 之前正是 `fit()` 里那个
 *      `scale` 在缩 —— 于是"加一个节点，整张图缩一圈"，卡内节点越用越小。
 *    ★ `fit()` 里的 `scale` 仍然保留，但只作为**兜底**（世界容器仍要居中摆放；视图那边
 *      没能长大时 —— 比如只读板、或宿主根本不是白板卡 —— 宁可缩一点也不要把节点裁掉）。
 * 3. **没有框选 / 拖动节点**：卡片的拖动归**白板**（`F3b`：拖根节点 = 拖整张卡），
 *    节点上只留下"选中 / 就地改名 / 折叠 / 右键"。
 * 4. **根节点同样是一个节点**（`F4` 起的口径：**每个节点都能选中、都能就地改名**）：
 *    点它有选中态、双击它就改名、右键它给节点菜单；唯一让给卡片层的是
 *    `pointerdown` **不拦** —— 从根上按住拖就是"拖整张卡"（`F3b` 那条手势没丢）。
 * 5. **写回不经过白板的撤销栈**：改一次就是一次 `mutate`（走 `.nestmind` 的仓储：
 *    原子写 + revision + 冲突检测），与引用卡"卡内编辑写回原 `.md`"同一条分工。
 *
 * ── 三个必须守住的时序 ────────────────────────────────────────
 *
 * * **尺寸要量两遍**：布局的估算是"猜"的（`measure.ts` 的 `estimateNodeSize`），
 *   元素上树之后量到真值再排一次 —— 只排一遍的话，长标题 / 带图片的节点会把整列顶歪。
 *   ★ 量的是**内容真宽**（`measureNodeSizes` 先把"同层等宽"那条下限摘掉），第二遍走
 *   `layoutMindEqualLevels` + `intrinsicSizeOf`：同层最宽必须由**内容**算出来 ——
 *   拿"已经被自己撑开的宽度"算，下限会在第二遍里被抹掉（2026-09-22 报的那条）。
 * * **重画会把焦点扔掉**：改名提交后 `paint()` 会重建节点元素，而那个输入框正拿着焦点。
 *   ⇒ 提交前先把 `editing` 清掉（`blur` 之后还会来一次，靠这个标记挡住第二次写回）。
 * * **"进编辑器"要推迟一帧**（{@link scheduleTitleEdit}）：卡片层是**先 `render()` 再
 *   `appendChild`**（`CardLayer.reconcile`），所以新建那张卡的第一帧里，宿主还没上树 ——
 *   此刻 `focus()` 落在"不在文档里"的元素上等于没聚焦。推迟一帧之后宿主已在，焦点才真的进去
 *   （顺带也躲开了调用方紧随其后的 `focusCanvas()`）。
 */

import type { Point, Rect, Size } from '../../util/geometry';
import { roundTo } from '../../util/geometry';
import { EMBED_PADDING } from '../embed/embedGeometry';
import { estimateNodeSize } from '../layout/measure';
import {
  directionForStructure,
  layoutMind,
  layoutMindEqualLevels,
  type MindLayout,
  type NodeBox,
} from '../layout/tree';
import type { MindFile, MindNode } from '../model/schema';
import { setCollapsed, setText } from '../model/ops';
import {
  MIND_HANDLE_ATTR,
  MIND_NODE_CLASS,
  MIND_NODE_ID_ATTR,
  applyHandleBox,
  applyHandleState,
  applyNodeBox,
  buildEdgeLayer,
  buildHandleElement,
  buildNodeElement,
  buildTitleEditor,
  measureNodeSizes,
  paintEdges,
} from './render';
import { EMBED_MAX_DEPTH, pruneMindForEmbed, type PrunedMind } from '../embed/pruneTree';

/** 卡内嵌脑图最外层容器的 class（样式表认它；`host` 上也会加一个做钩子） */
export const EMBED_ROOT_CLASS = 'nestboard-mind-embed';
/**
 * 画布过滤没命中的那个节点（T3.17 / `2.2.0` 批 4）。
 *
 * ★ 与卡片的 `.nestboard-card.is-dimmed` **同名**：这是**同一种状态**（"被过滤掉了"），
 *   两处各起一个名字只会让样式表里多一份要同步维护的规则。
 */
const DIMMED_CLASS = 'is-dimmed';
/**
 * **框选选中**的节点（`2.2.0` 收尾 · 节点级框选）。
 *
 * ★ 与 `is-selected` 分开：那一档是"当前焦点节点"（底部快捷栏跟着它走，全树只有一个），
 *   而框选选中可以有好几个、也不改焦点 —— 混用会让"我框了三个，怎么栏里只认一个"
 *   变成语义问题。
 */
export const MARQUEE_SELECTED_CLASS = 'is-marquee-selected';
/** `+N` 角标的 class */
export const EMBED_MORE_CLASS = 'nestboard-mind-embed-more';
/** `+N` 角标压在节点右下角上时，往盒子里收多少 px（约半个角标宽 —— 让它骑在角上） */
const MORE_OFFSET = 9;

/** 世界容器 / 连线层 / 手柄层直接复用脑图的类名 —— 那三条几何规则（原点、1×1 锚点、
 *  `overflow: visible`）与画布上完全一样，抄一份迟早会漂 */
const WORLD_CLASS = 'nestboard-mind-world';
const EDGE_LAYER_CLASS = 'nestboard-mind-edges';
const HANDLE_LAYER_CLASS = 'nestboard-mind-handles';

export interface EmbedMindLabels {
  /** 折叠手柄的悬停提示（`collapsed` = 此刻是收起态） */
  handle(state: { nodeId: string; collapsed: boolean; count: number }): string;
  /** `+N` 角标的悬停提示 */
  more(count: number): string;
}

export interface EmbedMindOptions {
  doc: Document;
  /** 装进哪个元素（卡片的内容槽） */
  host: HTMLElement;
  /** 首次渲染用的模型 */
  mind: MindFile;
  /** 只读（`.nestmind` 处于保护态 / 白板只读）：一个编辑手势都不接 */
  readOnly?: boolean;
  /** 改模型（写回由视图的仓储负责）。缺席 = 只读 */
  mutate?: (mutator: (mind: MindFile) => void | boolean) => boolean;
  /** 双击**根节点 / 空白**时打开这份脑图（节点上双击是改名） */
  onOpen?: () => void;
  /** 节点右键（菜单由视图用 Obsidian 的 `Menu` 画） */
  onNodeMenu?: (nodeId: string, event: MouseEvent) => void;
  /**
   * 卡内**选中了哪个节点**变了（`F4`，用户 2026-09-21："点击脑图节点，在画布上，
   * 底部也可以出现对应节点的快捷操作栏"）。
   *
   * ★ 只在**真的变了**的时候喊（同一个节点再点一次不喊）：调用方拿它去刷那条栏，
   *   而那些动作会改模型 ⇒ 又会引起重画 —— 变成"喊 → 改 → 喊"的循环就麻烦了。
   * ★ 节点被删 / 被折叠掉（重画后不在这一帧里）也会喊一次 `null`：栏据此收起来，
   *   而不是停在"一个已经不存在的节点"上。
   */
  onSelect?: (nodeId: string | null) => void;
  /**
   * **根节点**上右键是否也给节点菜单（默认不给）。
   *
   * ★ 两张脑图卡（`F3a` / `F4`）**都给**（`F4` 起，用户 2026-09-21："这些功能都放到脑图的
   *   根节点上去"）：无框之后卡面上没有可见的抓手，根节点就是这张卡的"手" ——
   *   它那一份菜单里既有节点级的（加子节点 / 加同级 / 折叠 / 导出），也并上卡片级的
   *   （颜色 / 锁定 / 复制 / 删除…，见 `BoardView.showMindNodeMenu`）。
   * ★ 别的宿主（将来的嵌入场景）不给时，根那一片仍然让给卡片菜单 —— 这一项就是那个开关。
   */
  allowRootMenu?: boolean;
  /** 附件图片地址（缺席 = 只画回形针） */
  resolveResource?: (path: string) => string | null;
  /** 附件还在不在（缺席 = 一律按"在"） */
  refMissing?: (path: string) => boolean;
  /** 内容块的 Markdown 渲染（缺席 = 纯文本） */
  renderMarkdown?: (markdown: string, el: HTMLElement) => void;
  labels?: EmbedMindLabels;
  /**
   * 这个节点此刻该不该**变淡**（画布过滤 T3.17 / `2.2.0` 批 4）。缺席 = 都不变淡。
   *
   * ★ 过滤条件只住在**白板视图**那一层（`CardFilter` + `dimmedMindNodeKeys`）：
   *   脑图自己（标签页那边）根本没有"过滤"这回事，把过滤器塞进 `MindFile`
   *   会让"同一份模型在两种宿主下长得不一样"变成数据问题。所以它从外面**问**进来。
   * ★ 给的是**回调**而不是一份快照：过滤条件变了视图只喊一声 {@link refreshDim}
   *   （那里只改 class、不重建节点），而这一帧之后新建的节点读的还是同一个回调 ——
   *   两条路不会出现"新的按快照、旧的按回调"这种两套状态。
   * ★ 只影响外观（变淡 + 不吃指针事件，见样式表）：节点被过滤掉**仍然在模型里、
   *   仍然可以被连线指到**（与卡片同一条口径 —— 过滤是"缩小视野"，不是"抠走"）。
   */
  isNodeDimmed?: (nodeId: string) => boolean;
  /**
   * 这个节点此刻在不在**框选选中**里（`2.2.0` 收尾 · 节点级框选）。
   *
   * ★ 与 {@link isNodeDimmed} 完全同一套写法与理由（回调而不是快照、只改 class）：
   *   框选的每一帧选区都在变，重建节点会把正在改名的输入框也一起弄没。
   * ★ 不传 = 没有这一档外观（老调用方一行都不用改）。
   */
  isNodeMarqueeSelected?: (nodeId: string) => boolean;
  /**
   * "装不下，请把卡片撑到这么大"（`F4`，用户 2026-09-21）。
   *
   * ★ 这条取代了从前的做法：从前卡面装不下就**把整张图等比缩小**（`fit` 的 `scale < 1`），
   *   于是"每加一个节点，所有节点都跟着变小"——用户看到的是"脑图在缩水"。
   *   现在反过来：节点永远 1:1，**卡片长大**去装它（视图把它接到 `CardRenderContext.growTo`）。
   * ★ 只在"宿主真的比内容小"时喊一次（同一个需求不重复喊），也不在宿主还没上树
   *   （`clientWidth === 0`）时喊 —— 那一刻量出来的 0 会让每张新卡都白报一次。
   * ★ 只在 `placement: 'fit'` 下有意义（`'anchor'` 没有"装不下"这回事）。
   */
  onRequiredSize?: (size: Size) => void;
  /**
   * 摆放方式（`2.2.0` 加的这一档）：
   *
   * * `'fit'`（默认）= **卡内嵌图**：卡是个有边界的盒子，只能把整棵树缩着装进去、居中摆；
   * * `'anchor'` = **白板级脑图**（`12-2.2.0...`）：**不缩放**（节点永远 1:1），
   *   把**根节点的中心**对准宿主原点（容器自己的 `x/y` 就是根节点中心），
   *   其余节点按布局向四周铺开 —— 它没有边界，所以没有任何"装不下"可言。
   */
  placement?: 'fit' | 'anchor';
  /**
   * "这一帧画完之后，有没有哪个节点要**立刻进编辑器**"（`F3a` 的加节点手感）。
   *
   * ★ 为什么用回调而不是一个字段：请求是**一次性**的（取走即失效），而"加节点"这件事
   *   发生在视图那一侧（节点菜单要 Obsidian 的 `Menu`）—— 渲染层只负责"画完问一句"。
   * ★ 返回 `null` = 没有请求（常见情况）。
   */
  consumeEditRequest?: () => string | null;
}

export class EmbedMind {
  private readonly host: HTMLElement;
  private readonly doc: Document;
  private readonly options: EmbedMindOptions;
  private readonly root: HTMLElement;
  private readonly world: HTMLElement;
  private readonly edgeLayer: SVGSVGElement;
  private readonly nodeLayer: HTMLElement;
  private readonly handleLayer: HTMLElement;

  private mind: MindFile;
  /** 节点元素（每次 `paint()` 重建；`id → 元素`） */
  private readonly nodeEls = new Map<string, HTMLElement>();
  /** 这一帧的布局外接矩形（`fit()` 用它把整张图缩到卡面里） */
  private bounds: MindLayout['bounds'] = null;
  /** 这一帧的布局盒（`'anchor'` 摆法要拿根节点中心当原点，见 `rootBox`） */
  private layoutBoxes: MindLayout['boxes'] | null = null;
  /** 此刻选中的节点（卡内选中，不进白板的选区） */
  private selected: string | null = null;
  /** 正在就地改名的节点（`null` = 没在改）—— 兼作"这次提交只认第一次"的闸门 */
  private editing: string | null = null;
  private observer: ResizeObserver | null = null;
  /** 待兑现的"进编辑器"（推迟一帧，见 `scheduleTitleEdit`） */
  private editTimer: number | null = null;
  /** 待兑现的"再问一遍有没有编辑请求"（见 `drainEditRequest`）—— 与上面那支各排各的 */
  private drainTimer: number | null = null;
  /** 上一次报出去的"装不下"（同一个需求不重复报，见 `reportRequiredSize`） */
  private lastRequired: Size | null = null;

  /** 这一份嵌图的根元素（宿主被清空之后，卡片层要把它放回去 —— 见 `cards/mindCard.ts`） */
  get element(): HTMLElement {
    return this.root;
  }

  /**
   * **根节点**那个元素（没有 = 这一帧还没画出来）。
   *
   * ★ 白板级脑图要用它判"按下的是不是根节点"（是 = 拖整棵，见 `MindLayer.onPointerDown`）。
   */
  rootNodeElement(): HTMLElement | null {
    return this.nodeEls.get(this.mind.rootId) ?? null;
  }

  constructor(options: EmbedMindOptions) {
    this.options = options;
    this.doc = options.doc;
    this.host = options.host;
    this.mind = options.mind;

    this.root = this.doc.createElement('div');
    this.root.className = EMBED_ROOT_CLASS;
    this.world = this.doc.createElement('div');
    this.world.className = WORLD_CLASS;
    this.edgeLayer = buildEdgeLayer(this.doc);
    this.edgeLayer.classList.add(EDGE_LAYER_CLASS);
    this.nodeLayer = this.doc.createElement('div');
    this.nodeLayer.className = 'nestboard-mind-nodes';
    this.handleLayer = this.doc.createElement('div');
    this.handleLayer.className = HANDLE_LAYER_CLASS;

    this.world.append(this.edgeLayer, this.nodeLayer, this.handleLayer);
    this.root.append(this.world);
    this.host.append(this.root);

    this.root.addEventListener('pointerdown', this.onPointerDown);
    this.root.addEventListener('dblclick', this.onDoubleClick);
    this.root.addEventListener('contextmenu', this.onContextMenu);
    this.observeResize();

    this.paint();
  }

  /**
   * 换模型重画（`BoardView` 收到仓储的 `changed` 时调 / 内嵌卡改了内容时调）。
   *
   * ★ 末尾那次"过一帧再问一遍有没有编辑请求"（{@link drainEditRequest}）不是保险，
   *   而是**必需**：见那个方法的说明 —— "加完节点立刻能打字"这条手感，
   *   请求总是在这一帧之后才到。
   */
  update(mind: MindFile): void {
    this.mind = mind;
    this.paint();
    this.drainEditRequest();
  }

  /** 收起时收干净：观察者要断开（元素本身跟着内容槽一起被清掉） */
  dispose(): void {
    this.observer?.disconnect();
    this.observer = null;
    this.cancelScheduledEdit();
    this.cancelDrain();
    this.root.removeEventListener('pointerdown', this.onPointerDown);
    this.root.removeEventListener('dblclick', this.onDoubleClick);
    this.root.removeEventListener('contextmenu', this.onContextMenu);
  }

  // ── 画 ──────────────────────────────────────────────────────

  private paint(): void {
    this.editing = null;
    const pruned = pruneMindForEmbed(this.mind, this.embedMaxDepth());
    this.nodeEls.clear();

    const direction = directionForStructure(this.mind.view.structure ?? 'logic-right');
    // 两遍：先按估算摆、量到真尺寸再排一次（见文件头那条）
    // ★ 第一遍的布局要在**建元素之前**跑：节点的字号 / 配色按 `depth` 定（`render.ts`），
    //   而 `depth` 只有布局知道 —— 晚一步就只能给所有节点套"第 1 层"的样子（根不再是 30px）
    let layout = layoutMind(pruned.file, { direction });
    this.buildNodes(pruned, layout);
    this.applyGeometry(pruned, layout);
    // ★ 第二遍之前先量**内容真宽**（`measureNodeSizes` 会把上一行刚写下的同层下限摘掉再量）：
    //   带着下限量的话，下面算出来的"这一层最宽"永远是刚才那个下限 ⇒ 下限在第二遍里
    //   当场消失、节点又参差不齐（用户 2026-09-22：卡内脑图"超过第二级就不齐了"）。
    const sizes = measureNodeSizes(this.nodeEls);
    const sizeOf = (node: MindNode): Size => this.measuredSizeOf(node, sizes);
    // ★ 用 `layoutMindEqualLevels`：同层等宽要**落进几何** —— 元素靠 `min-width` 撑开，
    //   而连线 / 外接框 / 卡面尺寸读的都是 `box.width`；只撑元素不撑几何，线会从节点里出来
    layout = layoutMindEqualLevels(pruned.file, {
      direction,
      sizeOf,
      // 这份是"内容真宽"，同层最宽按它算 ⇒ 几何撑开之后那几个窄的仍然拿得到下限
      intrinsicSizeOf: sizeOf,
    });
    this.applyGeometry(pruned, layout);

    this.bounds = layout.bounds;
    // 这一帧的盒子留给 `fit()`：`'anchor'` 摆法要用**根节点的中心**当原点
    //（它每帧可能都在变：改名变宽、加节点、折叠，都要跟着挪世界容器）
    this.layoutBoxes = layout.boxes;
    // 选中的那个节点可能已经不在这一帧里了（被删 / 被折叠进收起的那一支）
    if (this.selected !== null && !this.nodeEls.has(this.selected)) this.setSelected(null);
    this.applySelection();
    // 过滤态（T3.17 / `2.2.0` 批 4）：这一帧新挂载的节点在这里补上变淡的 class
    this.refreshDim();
    // 框选选中态（`2.2.0` 收尾）：同一套"新挂载的在这一帧补"（见 `MindLayer.setNodeSelection`）
    this.refreshMarqueeSelection();
    this.fit();
    // 装不下就让**卡片长大**，而不是把这棵图缩小（见 `onRequiredSize`）
    this.reportRequiredSize();

    // "加完节点就让我打字"：请求由调用方给（见 `consumeEditRequest`）——
    // ★ 排在 `fit()` 之后：输入框要按最终尺寸摆，先进编辑器再缩放会让它跳一下
    const wanted = this.options.consumeEditRequest?.() ?? null;
    if (wanted !== null && this.nodeEls.has(wanted)) this.scheduleTitleEdit(wanted);
  }

  /**
   * 把"进编辑器"推迟到**下一帧**（而不是这一帧立刻 `focus()`）。
   *
   * ★ 两个必须推迟的理由（都是那次"新建之后光标没进中心主题"根因）：
   *   1. **宿主可能还没上树**：卡片层是"先 `render()`、后 `appendChild`
   *      "（`CardLayer.reconcile`），第一帧里 `input.focus()` 落在一个不在文档里的元素上
   *      —— 浏览器直接忽略，用户看到的就是"光标没进来"。
   *   2. **调用方可能紧接着抢焦点**：新建一条龙里后面还有 `focusCanvas()`；
   *      同帧排队的话焦点会被它抢走，推迟一帧正好排在它后面。
   * ★ 只留一个待办（新的一次覆盖旧的），并且**兑现前再确认节点还在**（这一帧可能已被重画）。
   * ★ 没有 `defaultView`（node 下的单测 / 将来的假宿主）时**同步**执行：那边不在乎焦点，
   *   而这正是老行为的语义（写测试时不必等定时器）。
   */
  private scheduleTitleEdit(nodeId: string): void {
    this.cancelScheduledEdit();
    const run = (): void => {
      this.editTimer = null;
      if (this.nodeEls.has(nodeId)) this.beginTitleEdit(nodeId);
    };
    const view = this.doc.defaultView;
    if (!view?.setTimeout) {
      run();
      return;
    }
    this.editTimer = view.setTimeout(run, 0);
  }

  /**
   * "过一帧再问一遍有没有人来请求编辑" —— 两条路都靠它才真的能把光标送进新节点。
   *
   * ★ 为什么 `paint()` 里那次询问不够：**发起方是在这一帧之后才拿得到新节点的 id 的**。
   *   加节点这件事的次序是"先改模型、后请求编辑"（`addChild` 返回的 id 只有改完才有），
   *   而模型一改就**在同一帧里**触发了 `paint()` —— 那一帧问什么都还太早
   *   （报上来的"右键加子节点之后光标不进来"就是这么来的）。
   *   内嵌卡（`F4`）与文件卡（`F3a`）的模型变化最终都会走到 {@link update}，
   *   所以这一个钩子把两张卡一起修了。
   * ★ 与"进编辑器"那一个待办**各排各的**（{@link editTimer} / {@link drainTimer}）：
   *   共用一支的话，这次重画会把上一帧刚排好的"进编辑器"给取消掉 —— 那一趟请求
   *   已经被取走（`takeMindEdit` 是取一次就清），于是光标永远进不去。
   * ★ 一次只排一个：连着改三次模型，只该在最后问一次。
   */
  private drainEditRequest(): void {
    const view = this.doc.defaultView;
    if (!view?.setTimeout) return;
    this.cancelDrain();
    this.drainTimer = view.setTimeout(() => {
      this.drainTimer = null;
      const wanted = this.options.consumeEditRequest?.() ?? null;
      if (wanted !== null) this.scheduleTitleEdit(wanted);
    }, 0);
  }

  private cancelScheduledEdit(): void {
    if (this.editTimer === null) return;
    this.doc.defaultView?.clearTimeout(this.editTimer);
    this.editTimer = null;
  }

  private cancelDrain(): void {
    if (this.drainTimer === null) return;
    this.doc.defaultView?.clearTimeout(this.drainTimer);
    this.drainTimer = null;
  }

  /** 建这一帧的节点元素（只建一次；位置由 `applyGeometry` 写） */
  private buildNodes(pruned: PrunedMind, layout: MindLayout): void {
    const parts: HTMLElement[] = [];
    for (const node of pruned.file.nodes) {
      const el = buildNodeElement(this.doc, node, {
        // 字号 / 配色按**层级**定（根 30px 加粗、一层 18、其余 14）—— 与画布上同一套
        depth: layout.boxes.get(node.id)?.depth ?? 1,
        resolveResource: this.options.resolveResource,
        refMissing: this.options.refMissing,
        renderMarkdown: this.options.renderMarkdown,
      });
      this.nodeEls.set(node.id, el);
      parts.push(el);
    }
    this.nodeLayer.replaceChildren(...parts);
  }

  /** 摆位置 + 画线 + 摆手柄（尺寸变了要再调一次，所以与"建元素"分开） */
  private applyGeometry(pruned: PrunedMind, layout: MindLayout): void {
    for (const [id, box] of layout.boxes) {
      const el = this.nodeEls.get(id);
      if (el) applyNodeBox(el, box);
    }

    const byId = new Map(pruned.file.nodes.map((node) => [node.id, node]));
    const pairs: Array<readonly [NodeBox, NodeBox]> = [];
    for (const node of pruned.file.nodes) {
      if (node.parentId === null) continue;
      const parent = layout.boxes.get(node.parentId);
      const child = layout.boxes.get(node.id);
      if (parent && child) pairs.push([parent, child]);
    }
    paintEdges(this.edgeLayer, pairs, this.mind.view.edge);

    const handles: HTMLElement[] = [];
    for (const [id, box] of layout.boxes) {
      const node = byId.get(id);
      const real = this.realNodeOf(id);
      if (!node || !real) continue;

      // `+N` 角标（截断 / 收起都算 —— 见 `pruneTree`）。
      // ★ 挂在**手柄层**而不是节点里：节点自己是 `overflow: hidden`（要裁掉圆角外的溢出），
      //   角标放在节点右下角外面会被它裁掉。这一层与世界同坐标，位置按盒子的右下角算。
      const hidden = pruned.hiddenOf.get(id);
      if (hidden !== undefined && hidden > 0) {
        const more = this.doc.createElement('div');
        more.className = EMBED_MORE_CLASS;
        more.textContent = `+${hidden}`;
        more.title = this.options.labels?.more(hidden) ?? String(hidden);
        more.style.left = `${Math.round(box.x + box.width - MORE_OFFSET)}px`;
        more.style.top = `${Math.round(box.y + box.height - MORE_OFFSET)}px`;
        handles.push(more);
      }

      const kids = this.childrenCountOf(id);
      // 深度被截断的节点**不给手柄**：那里的孩子不是"被收起来的"，点它去折叠会得到
      // 一个"折了、看着没变"的状态（`+N` 角标已经把这件事说清楚了）
      if (kids === 0 || box.depth >= EMBED_MAX_DEPTH) continue;
      const el = buildHandleElement(this.doc);
      const state = { nodeId: id, collapsed: real.collapsed === true, count: kids };
      applyHandleState(el, { ...state, label: this.options.labels?.handle(state) ?? '' });
      applyHandleBox(el, box);
      handles.push(el);
    }
    this.handleLayer.replaceChildren(...handles);
  }

  /**
   * 量出来的节点尺寸；量不到（元素不在 / 假 DOM）退回布局自己的估算。
   *
   * ★ `measured` 是 `measureNodeSizes` 那一次**内容真宽**的快照：排布与"同层最宽"
   *   都读它。不传（元素刚建、还没量）时退回现场读 `offsetWidth`，再退到估算 ——
   *   与从前同一条口径。
   */
  private measuredSizeOf(node: MindNode, measured?: ReadonlyMap<string, Size>): Size {
    const snapshot = measured?.get(node.id);
    if (snapshot && snapshot.width > 0 && snapshot.height > 0) return snapshot;

    const el = this.nodeEls.get(node.id);
    const width = el?.offsetWidth ?? 0;
    const height = el?.offsetHeight ?? 0;
    if (width > 0 && height > 0) return { width, height };
    return estimateNodeSize(node);
  }

  /**
   * "这棵树需要多大"（世界尺寸 + 四周留白）；这一帧还没排出布局就给 `null`。
   *
   * ★ 与 `fit()` 里那个 `scale` 是一对：卡面比它大 ⇒ `scale` 恰好是 1（节点 1:1）；
   *   比它小 ⇒ 报给视图去**长大卡片**（`onRequiredSize`），下一帧宿主变大、`fit()` 收敛到 1。
   */
  private requiredSize(): Size | null {
    const bounds = this.bounds;
    if (!bounds) return null;
    return {
      width: Math.ceil(bounds.width + EMBED_PADDING * 2),
      height: Math.ceil(bounds.height + EMBED_PADDING * 2),
    };
  }

  /** 装不下就把需求报出去（同一个需求只报一次；宿主还没上树时不报） */
  private reportRequiredSize(): void {
    // `'anchor'` 摆法没有"装不下"：宿主原点就是根节点中心，树可以往任意方向长
    if (this.options.placement === 'anchor') return;
    const report = this.options.onRequiredSize;
    if (!report) return;
    const need = this.requiredSize();
    if (!need) return;
    const width = this.host.clientWidth;
    const height = this.host.clientHeight;
    // 还没上树（卡片层是"先 render 再 appendChild"）⇒ 此刻的 0 不代表"装不下"，
    // 等 `ResizeObserver` 那一趟再报（见 `observeResize`）
    if (!(width > 0) || !(height > 0)) return;
    if (need.width <= width + 1 && need.height <= height + 1) return;
    const last = this.lastRequired;
    if (last && last.width === need.width && last.height === need.height) return;
    this.lastRequired = need;
    report(need);
  }

  /**
   * 把世界容器摆好（见 `placement`）：
   *
   * * `'fit'`：缩到卡面里、居中放（卡内不做平移缩放）；
   * * `'anchor'`：**不缩放**，把**根节点中心**对到宿主原点 —— 白板级脑图的 `x/y`
   *   就是根节点中心，宿主是一个零尺寸的锚点元素，没有"卡面"可以适配（`2.2.0`）。
   */
  private fit(): void {
    const bounds = this.bounds;
    if (!bounds) return;

    const offset = this.placementOffset();
    if (offset) {
      this.world.style.transform = `translate(${Math.round(offset.x)}px, ${Math.round(offset.y)}px)`;
      return;
    }

    const width = this.host.clientWidth;
    const height = this.host.clientHeight;
    if (!Number.isFinite(width) || !Number.isFinite(height)) return;
    if (width <= 0 || height <= 0) return;

    const scale = Math.min(
      1,
      (width - EMBED_PADDING * 2) / Math.max(1, bounds.width),
      (height - EMBED_PADDING * 2) / Math.max(1, bounds.height),
    );
    const tx = (width - bounds.width * scale) / 2 - bounds.x * scale;
    const ty = (height - bounds.height * scale) / 2 - bounds.y * scale;
    this.world.style.transform = `translate(${Math.round(tx)}px, ${Math.round(ty)}px) scale(${roundTo(scale, 4)})`;
  }

  /** 这一帧根节点那个盒子（`'anchor'` 摆法要拿它的中心当原点）；没有给 `null` */
  private rootBox(): NodeBox | null {
    return this.layoutBoxes?.get(this.mind.rootId) ?? null;
  }

  /**
   * 这一份嵌图**最多画到第几层**。
   *
   * ★ 卡内嵌图（`'fit'`）画前 `EMBED_MAX_DEPTH` 层（更深的收成 `+N`）：
   *   卡面比屏幕小得多，整棵树塞进去只会糊成一片。
   * ★ **白板级脑图（`'anchor'`）不截断**：它没有"卡面"这个空间上限，
   *   用户把树铺在画布上就是要看整棵（也正因为如此，节点连线才可能连到
   *   第 5 层、第 10 层的节点上 —— 截断的话那些节点的线会没有盒子可取）。
   * ★ 折叠那一档**两种摆法都照旧**：那是用户明确收起来的一支，不画才对
   *   （`pruneMindForEmbed` 内部处理，与 `maxDepth` 无关）。
   */
  private embedMaxDepth(): number {
    return this.options.placement === 'anchor' ? Number.POSITIVE_INFINITY : EMBED_MAX_DEPTH;
  }

  /**
   * 这一帧每个**画出来的**节点占的盒子（**相对宿主原点**的世界单位）。
   *
   * ★ 白板那边拿它当连线端点（`2.2.0` 批 3）：一个节点的几何就是这个盒子 ——
   *   锚点取它的四边中点，与卡片端点走同一个 `cardAnchor`，一行新公式都不用加。
   * ★ 只报**画出来的**（被折叠收掉的、以及卡内被深度截掉的节点没有盒子）：
   *   指向它们的线因此一个字都不画 —— 与"那个节点自己也没画出来"一致。
   * ★ 原点口径与 {@link contentBounds} 相同（`'anchor'` 摆法下就是**根节点中心**，
   *   因为 `placementOffset` 已经把偏移算进去了）。`'fit'` 摆法下报的是布局坐标
   *   （那张图整个缩着装进卡面里，节点连线不走这条路），调用方按同一份口径加上宿主位置即可。
   */
  nodeRects(): Array<{ nodeId: string; rect: Rect }> {
    const boxes = this.layoutBoxes;
    if (!boxes) return [];
    const offset = this.placementOffset() ?? { x: 0, y: 0 };
    const result: Array<{ nodeId: string; rect: Rect }> = [];
    for (const [nodeId, box] of boxes) {
      result.push({
        nodeId,
        rect: {
          x: box.x + offset.x,
          y: box.y + offset.y,
          width: box.width,
          height: box.height,
        },
      });
    }
    return result;
  }

  /**
   * `'anchor'` 摆法下世界容器的平移量（= 根节点中心取负）；`'fit'` 摆法给 `null`
   * （那边的平移还含"居中 + 缩放"，与这里不是一回事）。
   */
  private placementOffset(): Point | null {
    if (this.options.placement !== 'anchor') return null;
    const root = this.rootBox();
    if (!root) return null;
    return { x: -(root.x + root.width / 2), y: -(root.y + root.height / 2) };
  }

  /**
   * 内容的外接框（**相对宿主原点**的世界坐标）；这一帧还没排出布局给 `null`。
   *
   * ★ 白板那边要用它：适应内容（`⌘0` 一类）、缩略图、演示取景都至少要一个"这棵树占多大"。
   *   容器自己在模型里**没有尺寸**（那正是"无边界"的意思），所以这个框只能**现算**——
   *   算出来的东西不落盘，与"位置由布局算"同一条纪律。
   * ★ `'fit'` 摆法下它的原点在宿主左上角（那种宿主是一个有尺寸的盒子），
   *   而 `'anchor'` 摆法下原点就是**根节点中心**（`placementOffset` 已经把偏移算进去了）。
   */
  contentBounds(): Rect | null {
    const bounds = this.bounds;
    if (!bounds) return null;
    const offset = this.placementOffset() ?? { x: 0, y: 0 };
    return {
      x: bounds.x + offset.x,
      y: bounds.y + offset.y,
      width: bounds.width,
      height: bounds.height,
    };
  }

  private observeResize(): void {
    const view = this.doc.defaultView;
    const ResizeObserverCtor = view?.ResizeObserver;
    if (!ResizeObserverCtor) return;
    // 只重算缩放，不重排：卡面尺寸变了不影响布局（布局只认世界坐标）
    // ★ 顺带再报一次"装不下"：卡片刚上树时 `clientWidth` 还是 0（卡片层先 render 再挂），
    //   那一趟报不出来 —— 这里补上，正是"新建的卡内容比初始尺寸大"那条路。
    this.observer = new ResizeObserverCtor(() => {
      this.fit();
      this.reportRequiredSize();
    });
    this.observer.observe(this.host);
  }

  // ── 模型读写 ────────────────────────────────────────────────

  private realNodeOf(id: string): MindNode | null {
    return this.mind.nodes.find((node) => node.id === id) ?? null;
  }

  /** 这一支在**真实模型**里有多少个子孙（收起时手柄圆圈里写的就是它） */
  private childrenCountOf(id: string): number {
    const children = new Map<string, MindNode[]>();
    for (const node of this.mind.nodes) {
      if (node.parentId === null) continue;
      const list = children.get(node.parentId);
      if (list) list.push(node);
      else children.set(node.parentId, [node]);
    }
    const countOf = (nodeId: string): number => {
      let sum = 0;
      for (const kid of children.get(nodeId) ?? []) sum += 1 + countOf(kid.id);
      return sum;
    };
    return countOf(id);
  }

  /** 应用一次编辑并重画。仓储的 `changed` 事件也会带来一次重画（重画是幂等的） */
  private applyEdit(mutator: (mind: MindFile) => void | boolean): void {
    const mutate = this.options.mutate;
    if (!mutate || this.options.readOnly === true) return;
    let changed = false;
    // 保护态（解析失败的 `.nestmind`）会抛：一次写入失败不该把这张卡画崩
    try {
      changed = mutate(mutator);
    } catch {
      changed = false;
    }
    if (changed) this.paint();
  }

  // ── 手势 ────────────────────────────────────────────────────

  private readonly onPointerDown = (event: PointerEvent): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const handle = target.closest(`[${MIND_HANDLE_ATTR}]`);
    if (handle) {
      const id = handle.getAttribute(MIND_HANDLE_ATTR);
      event.stopPropagation();
      event.preventDefault();
      if (id === null) return;
      const node = this.realNodeOf(id);
      if (!node) return;
      this.applyEdit((mind) => setCollapsed(mind, id, !(node.collapsed === true)));
      return;
    }

    const nodeEl = target.closest(`.${MIND_NODE_CLASS}`);
    if (!nodeEl) return;
    const id = nodeEl.getAttribute(MIND_NODE_ID_ATTR);
    if (id === null) return;
    // ★ 根节点：**选中，但这一下不拦**（`F4` 起的口径：每个节点都能选中）——
    //   让它继续冒泡到卡片层，"从根上按住拖 = 拖整张卡"（`F3b`）那条手势因此没丢
    if (id === this.mind.rootId) {
      this.setSelected(id);
      return;
    }
    // 其他节点上按下 = 卡内选中，绝不冒泡（冒泡就成了"按住卡片拖动"）
    event.stopPropagation();
    this.setSelected(id);
  };

  private readonly onDoubleClick = (event: MouseEvent): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const nodeEl = target.closest(`.${MIND_NODE_CLASS}`);
    const id = nodeEl?.getAttribute(MIND_NODE_ID_ATTR) ?? null;
    // 双击**空白**：交给卡片层（它会打开这份脑图）
    if (id === null) {
      this.options.onOpen?.();
      return;
    }
    // ★ 双击**根节点**也一样就地改名（`F4` 起：每个节点都能改）。
    //   改不了（只读 / 没有写回口子）时才退回"打开" —— 否则双击根节点会变成什么都没发生。
    //   ★ 「打开」这条手势没丢：双击**空白**（卡内留白那圈）仍然打开。
    if (id === this.mind.rootId && (this.options.readOnly === true || !this.options.mutate)) {
      this.options.onOpen?.();
      return;
    }
    event.stopPropagation();
    event.preventDefault();
    this.beginTitleEdit(id);
  };

  private readonly onContextMenu = (event: MouseEvent): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const nodeEl = target.closest(`.${MIND_NODE_CLASS}`);
    const id = nodeEl?.getAttribute(MIND_NODE_ID_ATTR) ?? null;
    const menu = this.options.onNodeMenu;
    if (id === null || !menu) return;
    // 根节点上右键：默认让给卡片菜单；内嵌脑图卡例外（见 `allowRootMenu`）
    if (id === this.mind.rootId && this.options.allowRootMenu !== true) return;
    event.stopPropagation();
    event.preventDefault();
    this.setSelected(id);
    menu(id, event);
  };

  /**
   * 换一个选中的节点（**变了才喊** `onSelect`，见那边的说明）。
   *
   * ★ 3 个入口（左键 / 右键 / 重画后失效）都收在这里：分开写的话，"哪一处忘了通知视图"
   *   就成了"点了节点、栏不出现"这种只在某一条路上复现的 bug。
   */
  private setSelected(nodeId: string | null): void {
    if (this.selected === nodeId) return;
    this.selected = nodeId;
    this.applySelection();
    this.options.onSelect?.(nodeId);
  }

  /**
   * **从外面**选中某个节点（`2.2.0` 批 4：搜索结果点一条就飞到那个节点上）。
   *
   * ★ 走 {@link setSelected}：与"用户在卡内点一下"是同一条路 —— 选中框、底部那条
   *   快捷操作栏（`onSelect`）都会跟着到位。另写一条路的话，"搜索跳过去之后栏里
   *   显示的还是上一个节点"这种只在某一条路上复现的 bug 就来了。
   * ★ 节点不在这一帧里（被折叠收起来了 / 模型换了）⇒ 什么都不做：
   *   调用方手里的是**上一帧**的结果，与 `revealCard` 那条同一个取舍。
   */
  selectNode(nodeId: string): boolean {
    if (!this.nodeEls.has(nodeId)) return false;
    this.setSelected(nodeId);
    return true;
  }

  private applySelection(): void {
    for (const [id, el] of this.nodeEls) el.classList.toggle('is-selected', id === this.selected);
  }

  /**
   * 重新算每个节点的"变淡"状态（画布过滤变了时由 `MindLayer.setDimmed` 喊）。
   *
   * ★ 与 `applySelection` 同一套写法：**只改 class、只碰已挂载的节点**，
   *   一个节点元素都不重建（过滤是"打字就触发"的动作，重建整棵树会让输入框
   *   与手都白费 —— 顺带也会把正在改名的那个输入框弄没）。
   * ★ 新挂载的节点不走这里：它们在 `paint()` 里补（`refreshDim` 每次 `paint` 末尾也调一次）。
   */
  refreshDim(): void {
    const isDimmed = this.options.isNodeDimmed;
    for (const [id, el] of this.nodeEls) {
      el.classList.toggle(DIMMED_CLASS, isDimmed?.(id) === true);
    }
  }

  /**
   * 重新算每个节点的**框选选中**状态（选区变了时由 `MindLayer.setNodeSelection` 喊）。
   *
   * ★ 与 `refreshDim` 逐条对齐：只改 class、只碰已挂载的节点，一个元素都不重建。
   * ★ 新挂载的节点不走这里：它们在 `paint()` 末尾补（同一套）。
   */
  refreshMarqueeSelection(): void {
    const isSelected = this.options.isNodeMarqueeSelected;
    for (const [id, el] of this.nodeEls) {
      el.classList.toggle(MARQUEE_SELECTED_CLASS, isSelected?.(id) === true);
    }
  }

  /**
   * 就地改标题。
   *
   * ★ 用脑图那套 `buildTitleEditor`（"影子 + 输入框"叠在同一格里）：节点宽度仍然由
   *   标题文字自己撑出来，打字时节点跟着长 —— 换成一个铺满的 `input` 会与节点宽度
   *   形成循环依赖（那一处踩过，见 `render.ts` 的注释）。
   * ★ 提交 / 取消**都要重画**：输入框是塞进标题带里的，不重画它就一直杵在那儿。
   */
  private beginTitleEdit(id: string): void {
    if (this.options.readOnly === true || !this.options.mutate) return;
    // 已经在改它了：再来一次会叠出第二个输入框（推迟那一帧与双击可能撞在一起）
    if (this.editing === id) return;
    const el = this.nodeEls.get(id);
    const node = this.realNodeOf(id);
    // ★ 可选调用（`querySelector?.`）：单测里的假 DOM 没有这个方法，而"没有它"与
    //   "找不到那个标题元素"是同一件事 —— 都是"这一处没得改"，不必抛出去
    const title = el?.querySelector?.<HTMLElement>('.nestboard-mind-node-title');
    if (!el || !node || !title) return;

    this.editing = id;
    const editor = buildTitleEditor(this.doc, node.text, node.text);
    title.replaceChildren(editor.element);
    editor.input.addEventListener('input', editor.sync);

    const commit = (): void => {
      if (this.editing !== id) return;
      this.editing = null;
      const next = editor.input.value.trim();
      if (next === node.text) this.paint();
      else this.applyEdit((mind) => setText(mind, id, next));
    };
    const cancel = (): void => {
      if (this.editing !== id) return;
      this.editing = null;
      this.paint();
    };

    editor.input.addEventListener('keydown', (event: KeyboardEvent) => {
      // 标题输入框里的按键绝不能再走白板的热键（空格会平移画布、`Delete` 会删卡片）
      event.stopPropagation();
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Enter' || event.key === 'Tab' || event.key === 'Escape') {
        event.preventDefault();
        if (event.key === 'Escape') cancel();
        else commit();
      }
    });
    editor.input.addEventListener('blur', commit);
    editor.input.focus();
    editor.input.select();
  }
}
