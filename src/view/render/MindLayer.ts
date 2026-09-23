/**
 * 白板级脑图的渲染层（`2.2.0`）—— 与 `CardLayer` / `ColumnLayer` / `GroupLayer` 平级。
 *
 * 一句话：**一棵长在白板上的树**，不再是"某张卡里的东西"。
 *
 * ── 它与 `CardLayer` 的三处根本差别（都是"无边界"的直接后果）────────
 *
 * 1. **没有盒子**：容器元素是**零尺寸的锚点**（`left/top` = 根节点中心，宽高都是 0），
 *    节点往外长多少都不受限制 —— 也没有 `width/height` 这种字段可以算错。
 * 2. **不裁剪、不缩放**：节点的字体与盒子都是世界单位，跟着白板缩放一起变
 *    （与卡片同一个等级）。卡内那套 `fit()`（缩到卡面里）在这里被 `placement: 'anchor'`
 *    取代 —— 见 `EmbedMind` 的说明。
 * 3. **不参与"尺寸自适应"**：没有"内容比容器大"这回事，于是 `growTo` / `requestCardSize` /
 *    `onRequiredSize` 这条路在这里整条不存在。
 *
 * ── 复用的部分（一行渲染都没重写）────────────────────────────────
 *
 * 每个容器内部挂一份 `EmbedMind`（`placement: 'anchor'`）：节点 / 分支线 / 折叠手柄 /
 * 就地改名 / 加节点后进编辑器 / 选中 —— 与标签页里的脑图、与从前卡内那张脑图**同一套实现**
 * （`mind/view/render.ts` 的构件 + `mind/layout/` 的纯函数）。
 *
 * ★ 与 `CardLayer` 同一条纪律：`sync()` **幂等**，只写真的变了的数字；容器与卡片混排，
 *   所以层序由 `mind.z` 决定（不是整棵一个层级）。
 * ★ 容器对象在每次提交后可能换成**新对象**（模型是不可变更新）—— 所以每帧把
 *   `holder.mind` 换成最新的那个，闭包永远读它（与 `cards/mindCard` 那条踩过的坑同源）。
 */

import { MIND_CONTAINER_ID_ATTR } from '../../constants';
import { nodeEndpointKey, splitEndpointKey, type Mind } from '../../model/schema';
import type { MindFile } from '../../mind/model/schema';
import {
  expandRect,
  rectContainsPoint,
  rectsIntersect,
  type Point,
  type Rect,
} from '../../util/geometry';
import { t } from '../../util/i18n';
import type { MarqueeMindHits } from '../interact/MarqueeController';
import { EmbedMind, type EmbedMindLabels } from '../../mind/view/EmbedMind';
import {
  mindBounds,
  mindNodeRects,
  mindPlacement,
  mindRootFallbackRect,
  type MindPlacement,
} from '../../mind/embed/boardGeometry';

/** 容器元素上的 class（样式表认它） */
export const MIND_CONTAINER_CLASS = 'nestboard-mind-container';
/** 读不到模型时那句话的 class */
export const MIND_CONTAINER_NOTE_CLASS = 'nestboard-mind-container-note';
/** 整棵被选中时那圈虚线的 class（`2.2.0` 批 5） */
export const MIND_SELECTION_CLASS = 'nestboard-mind-selection';
/**
 * 选中框往外留多少（世界单位）—— 节点自己有阴影 / 选中描边，贴着外接框画会显得"卡住了"。
 *
 * ★ 与卡片那圈选中描边同一条用心：**不改几何**，只是在外面画一圈虚线。
 */
const SELECTION_PADDING = 6;

export interface MindLayerOptions {
  /** 当前的容器清单（`board.minds ?? []`） */
  getMinds(): readonly Mind[];
  /** 这份脑图的模型：内嵌读 `mind.mind`；文件脑图去仓储取（还没读到 / 文件没了给 `null`） */
  modelOf(mind: Mind): MindFile | null;
  /** 这份脑图此刻能不能改（白板只读 / 归档锁定 / 文件处于保护态） */
  isReadOnly(mind: Mind): boolean;
  /** 改一次模型（内嵌 = 白板撤销栈里的一步；文件 = 写回那份 `.nestmind`） */
  mutate(mind: Mind, mutator: (file: MindFile) => void | boolean): boolean;
  /** 节点右键（与卡片那条共用 `MindBridge.nodeMenu`） */
  onNodeMenu(mind: Mind, nodeId: string, event: MouseEvent): void;
  /** 卡内选中节点变了（底部那条快捷操作栏） */
  onNodeFocus(mind: Mind, nodeId: string | null): void;
  /**
   * 从**根节点**上按下 = 拖整棵（无边界之后，"移动这棵脑图"就只有这一个手势）。
   * 本层已经 `stopPropagation`：不拦的话画布会把它当成"按在空白处"（起框选 / 清选区）。
   */
  onDragStart(mind: Mind, event: PointerEvent): void;
  /** 视图刚加了节点 ⇒ 取走"把光标送进新节点"的请求（`mind/embed/editRequest`） */
  takeEditRequest?(mind: Mind): string | null;
  /** 节点附件图片的地址（缺席 = 只画回形针） */
  resolveResource?(target: string): string | null;
  /** 附件还在不在（缺席 = 一律按"在"） */
  refMissing?(target: string): boolean;
  /** 节点内容块的 Markdown 渲染（缺席 = 纯文本） */
  renderMarkdown?(markdown: string, host: HTMLElement): void;
  labels?: EmbedMindLabels;
}

interface MountedMind {
  /** `.nestboard-mind-container`：零尺寸锚点，`left/top` 就是根节点中心 */
  element: HTMLElement;
  /** 读不到模型时显示的那句话（与 `embed` 二选一） */
  noteEl: HTMLElement;
  /**
   * 整棵被选中时那圈虚线（`2.2.0` 批 5）。
   *
   * ★ 它是容器的**第一个孩子**（在节点之前）：容器里全是绝对定位元素、谁也不带
   *   `z-index`，DOM 顺序就是层序 —— 放前面才在节点**底下**（选中框压着节点会挡住字）。
   * ★ 位置每帧按**外接框**重算（树会长会缩、拖动时还会跟着走），见 `applySelectionBox`。
   */
  boxEl: HTMLElement;
  /** 上一次写进 DOM 的那个框（`null` = 此刻没画）；一样就不重写 */
  appliedBox: Rect | null;
  embed: EmbedMind | null;
  /** 每帧换成最新的那个容器对象（闭包读它，见文件头最后一条） */
  holder: { mind: Mind };
  applied: { x: number; y: number; z: number } | null;
  appliedModel: MindFile | null;
  /**
   * 上一次画的是**哪一版**（{@link mindVersion}）—— 与 `appliedModel` 一起构成
   * "内容变了没有"的判据。
   *
   * ★ 为什么不能只比引用：**文件脑图**那条路的模型是**就地改**的
   *   （`MindRepository.mutate` 直接在缓存对象上 `nodes.push(...)`），
   *   引用一个字都不变 —— 只比引用的话，右键「加子节点」之后
   *   **画面上永远少那个节点**（用户 2026-09-21 报的"添加的子节点没有立即出现"）。
   */
  appliedVersion: string | null;
  appliedReadOnly: boolean | null;
  /** 拖动中的预览位置（`null` = 没在拖，位置归模型管，见 `setPreview`） */
  preview: Point | null;
}

export class MindLayer {
  private readonly mounted = new Map<string, MountedMind>();
  /**
   * 画布过滤没命中的节点，键是**端点的几何键**（`脑图id/节点id`，`2.2.0` 批 4）。
   *
   * ★ 与 `nodeRects()` 用**同一把键**（`nodeEndpointKey`）：过滤说"哪些节点该变淡"、
   *   连线说"哪些节点能连"，两件事在画面上指的是同一批盒子 —— 键不同的话，
   *   迟早出现"变淡的那个不是被连的那个"这种对不上的现象。
   * ★ 存整份集合而不是"每个容器一份"：容器随时可能新建 / 回收（`sync()`），
   *   按 id 前缀现查就不必在挂载 / 卸载时同步另一份索引。
   */
  private dimmedNodes: ReadonlySet<string> = new Set();
  /**
   * 选区里那几棵脑图（`2.2.0` 批 5）。视图的 `SelectionModel.mindIds` 是唯一真源，
   * 本层只留一份"画谁"的快照（与 `dimmedNodes` 同一条：进这里的都只影响外观）。
   */
  private selectedMinds: ReadonlySet<string> = new Set();
  /**
   * **框选选中**的节点（`2.2.0` 收尾 · 节点级框选）；键 = `nodeEndpointKey(脑图id, 节点id)`。
   * 与 `selectedMinds` 是两种粒度、互斥（见 `marqueeIn` 那条规则）。
   */
  private selectedNodes: ReadonlySet<string> = new Set();
  /**
   * **没挂载**的那些树的纯布局几何（`2.2.0` 收尾 · 视口裁剪）。
   *
   * ★ 为什么需要它：这一层的几何原本只有一个来源 —— 挂载后由 `EmbedMind` 实测。
   *   一旦按视口裁剪，"屏幕外那棵树"就没有 DOM、也就没有盒子，于是两件事会破：
   *   ① 缩略图 / 导出取景（它们要**全部**树的范围）；
   *   ② 指向屏幕外节点的**连线端点**（取不到矩形 ⇒ 整条线不画，用户看到的是
   *      "线莫名其妙消失"）。
   * ★ 所以补一条**纯布局**的路：与导出 / 缩略图用的是**同一份**
   *   `mind/embed/boardGeometry`（`mindPlacement` + `mindBounds` + `mindNodeRects`）——
   *   两处各算一遍的话，导出的取景与画布上的裁剪线迟早对不上。
   * ★ 缓存按**模型对象身份**失效（模型是不可变更新；文件脑图那份走 `revision`，
   *   这里只比对对象引用 —— 引用没换就当没变，与 `CardLayer` 的脏检查同一条）。
   */
  private readonly planCache = new Map<
    string,
    {
      model: MindFile | null;
      place: MindPlacement | null;
      bounds: Rect | null;
      nodes: Map<string, Rect> | null;
    }
  >();

  constructor(
    private readonly host: HTMLElement,
    private readonly options: MindLayerOptions,
  ) {}

  /** 这一帧挂了几个容器（诊断面板用） */
  get renderedCount(): number {
    return this.mounted.size;
  }

  /**
   * 与模型对齐（幂等）：新建 / 更新 / 回收。
   *
   * ★ 与 `CardLayer.sync` 一样每帧都可能被调（视口变化时也会）：静止时只做几次数值比较，
   *   一个属性都不写。
   */
  sync(visible: Rect | null = null): void {
    const seen = new Set<string>();
    for (const mind of this.options.getMinds()) {
      // **视口裁剪**（`2.2.0` 收尾）：屏幕外的树不挂 DOM。
      // ★ 不传 `visible` = 不裁（老调用方 / 测试），行为与从前一字不差。
      if (visible !== null && !this.intersects(mind, visible)) continue;
      seen.add(mind.id);
      this.apply(this.ensure(mind), mind);
    }
    for (const [id, entry] of this.mounted) {
      if (seen.has(id)) continue;
      this.unmount(entry);
      this.mounted.delete(id);
    }
  }

  /**
   * 这棵树与给定世界矩形**有没有交**（裁剪判据）。
   *
   * ★ 取不到外接框（那份 `.nestmind` 还没读到 / 文件没了）时按**锚点**判：
   *   那一刻容器里只有一句话，它的位置就是锚点 —— 拿"没有面积"去判会把它整棵
   *   永久裁掉（包括它该出现的那一屏）。
   */
  private intersects(mind: Mind, visible: Rect): boolean {
    const rect = this.boundsOf(mind);
    if (rect) return rectsIntersect(rect, visible);
    return rectContainsPoint(visible, { x: mind.x, y: mind.y });
  }

  /**
   * 一棵脑图此刻的**世界外接框**（不管它有没有挂载）。
   *
   * ★ 已挂载 ⇒ 用 `EmbedMind` 实测那一份（含 `'fit'` 摆法的偏移）；
   *   没挂载 ⇒ 走纯布局缓存。两者是**同一套布局**算出来的（容器无尺寸、几何由布局定），
   *   所以"裁掉前后"报出来的框是同一个数。
   */
  private boundsOf(mind: Mind): Rect | null {
    const mounted = this.mounted.get(mind.id);
    if (mounted?.embed) {
      const rect = this.worldBoundsOf(mounted);
      if (rect) return rect;
    }
    return this.planOf(mind)?.bounds ?? null;
  }

  /** 纯布局几何（带缓存）；模型读不到或布局算不出 → `bounds` 为 `null` */
  private planOf(mind: Mind): {
    model: MindFile | null;
    place: MindPlacement | null;
    bounds: Rect | null;
    nodes: Map<string, Rect> | null;
  } {
    const model = this.options.modelOf(mind);
    const cached = this.planCache.get(mind.id);
    if (cached && cached.model === model) return cached;
    // ★ `mindPlacement` 的锚点口径与画布一致（容器的 `x/y` = 根节点中心）
    const place = mindPlacement({ x: mind.x, y: mind.y }, model);
    const entry = {
      model,
      // ★ `place` 也留在缓存里：取景那一份几何（`viewRectOf`）跟它同源，
      //   再算一遍 `mindPlacement` 等于把同一棵树排两次
      place,
      bounds: place ? mindBounds(place) : null,
      nodes: place ? mindNodeRects(place) : null,
    };
    this.planCache.set(mind.id, entry);
    return entry;
  }

  /**
   * **从外面**选中某棵树里的一个节点（`2.2.0` 收尾 · 白板上的方向键换选中）。
   *
   * ★ 走 `EmbedMind.selectNode`：与"用户自己点一下"是同一条路（卡内选中框、底部那条
   *   快捷操作栏都会到位，节点还会经 `onSelect` 报回白板）。
   * ★ 那棵树此刻**没挂载**（屏幕外被裁掉）⇒ 给 `false`：选择器动不了，调用方自己记账
   *   （至少让 Tab / 回车接着落在正确的节点上）。
   */
  selectNode(mindId: string, nodeId: string): boolean {
    return this.mounted.get(mindId)?.embed?.selectNode(nodeId) === true;
  }

  /**
   * 一个节点挂在**哪一侧**（`-1` 左 / `1` 右 / `0` 根与悬浮）—— 方向键判"左右往哪走"要用。
   *
   * ★ 走**纯布局缓存**（`planOf`）：屏幕外的树、还没量过尺寸的树都答得出来 ——
   *   方向键不该因为"这棵树现在不可见"就变得不可预测。
   */
  sideOf(mindId: string, nodeId: string): -1 | 0 | 1 | null {
    const mind = this.options.getMinds().find((item) => item.id === mindId);
    if (!mind) return null;
    const box = this.planOf(mind).place?.layout.boxes.get(nodeId);
    return box ? box.side : null;
  }

  /**
   * 一棵脑图在演示里取景用的**世界矩形** —— **整棵树的外接框**。
   *
   * ── 口径（用户 2026-09-23："应该是以脑图根节点，且看到全脑图为视口"）────────
   *
   * 两件事一起满足，靠的是**取哪一份几何**：
   * * **看到全脑图** ⇒ 框的是整棵树（`mindBounds`），不是根节点那一小块；
   * * **不飘** ⇒ 这一份必须来自**纯布局**（`planOf`，按模型身份缓存），而它的原点就是
   *   容器的 `x/y`（= 根节点中心，见 `mindPlacement`）—— 于是框只跟"模型 + 锚点"有关，
   *   与**量测 / 折叠 / 有没有挂载**全无关系。从前那一份取自 `EmbedMind` **实测**的尺寸
   *   （`boundsOf` 的已挂载分支），量测一变景就跟着变（"位置乱飘"就是这么来的）。
   * ★ 模型还没读到（文件树那份 `.nestmind` 没加载）⇒ 只能按**锚点**兜一个小盒子：
   *   位置是准的（根节点中心），"全树可见"这一档给不了 —— 那也比不飞强。
   */
  viewRectOf(mindId: string): Rect | null {
    const mind = this.options.getMinds().find((item) => item.id === mindId);
    if (!mind) return null;
    const anchor = { x: mind.x, y: mind.y };
    return this.planOf(mind).bounds ?? mindRootFallbackRect(anchor);
  }

  /** 换板 / 关视图：全部摘掉 */
  clear(): void {
    for (const entry of this.mounted.values()) this.unmount(entry);
    this.mounted.clear();
    // 过滤记账也是"上一块板的"：新板上那点节点 id 与旧板毫不相干（与 `triedMindPaths` 同理）
    this.dimmedNodes = new Set();
    this.selectedMinds = new Set();
    this.selectedNodes = new Set();
    this.planCache.clear();
  }

  /**
   * 更新"整棵被选中"的外观（`2.2.0` 批 5）。
   *
   * ★ 与 `setDimmed` 同一套：只定快照、只碰已挂载的容器（新挂载的在 `apply()` 里补）。
   * ★ 画的是**外接框那一圈虚线**而不是"给节点换个颜色"：容器是一棵无边的树，
   *   不给一圈框，用户根本看不出"我框中的是一整棵"。
   */
  setSelection(ids: ReadonlySet<string>): void {
    this.selectedMinds = ids;
    for (const [id, entry] of this.mounted) this.applySelectionBox(entry, id);
  }

  /**
   * 更新"节点级选中"的外观（`2.2.0` 收尾 · 节点级框选）。
   *
   * ★ 与 `setSelection` / `setDimmed` 同一套：只定快照、只碰已挂载的容器
   *   （新挂载的在 `paint()` 里读同一个回调补上）。
   */
  setNodeSelection(keys: ReadonlySet<string>): void {
    this.selectedNodes = keys;
    for (const entry of this.mounted.values()) entry.embed?.refreshMarqueeSelection();
  }

  /**
   * 某一点落在哪棵树上（**整棵树的外接框**，重叠时取 z 最大的那棵）。
   *
   * ★ 为什么需要它（用户 2026-09-22 实测 F1"右键树身菜单里没有那一项"）：
   *   容器是 `width: 0; height: 0` 的**锚点**、世界容器也没有面积 —— DOM 上能命中的
   *   只有**节点**自己。于是"在树身上右键"只要没正好压在节点上，命中的就是画布，
   *   靠 `closest('[data-mind-id]')` 永远找不到这棵树。这一层补的就是那条缝隙。
   * ★ 与 `marqueeIn` / `boundsOf` 用同一个框（`planOf` 现算，被裁掉的树一样算得出来）。
   */
  mindAtPoint(point: Point): string | null {
    let hit: { id: string; z: number } | null = null;
    for (const mind of this.options.getMinds()) {
      const bounds = this.boundsOf(mind);
      if (!bounds || !rectContainsPoint(bounds, point)) continue;
      if (!hit || mind.z >= hit.z) hit = { id: mind.id, z: mind.z };
    }
    return hit?.id ?? null;
  }

  /**
   * 框选命中：这个世界矩形框到了哪些**树**、哪些**节点**（`2.2.0` 批 5 / 收尾）。
   *
   * ── 两种粒度的判据（一条规则说清） ──
   *
   * 1. **框到的节点数 = 这棵树的节点数** ⇒ 整棵进选区（用户显然想要这棵树）；
   * 2. **框到了一部分节点** ⇒ 只选那几个节点，这棵树**不整棵进选区**
   *    （这就是"节点级框选"：只要那几个，`Delete` 不该顺手删一整棵）；
   * 3. **一个节点都没框到**（只擦过树的空白 / 外沿）⇒ 整棵进选区（`b73` 的老口径）。
   *
   * ★ 第 3 条为什么保留：树是**无边**的（没有容器框），框住它周围一片空地时用户
   *   想要的只能是"这棵树"；而"框住一个小节点"与"框住一棵树"两者用第 1、2 条分得很清。
   * ★ 判据走 `planOf`（**纯布局**，带缓存）：被视口裁掉的树一样框得中 —— 与 `boundsOf`
   *   那条"裁掉前后报同一个数"同源；模型读不到（文件没了）时退化成**锚点那一句话**，
   *   与裁剪判据（`intersects`）完全一致。
   * ★ 坐标一律是**世界坐标**（`planOf` 报的就是世界坐标）。
   */
  marqueeIn(worldRect: Rect): MarqueeMindHits {
    const minds: string[] = [];
    const nodes: string[] = [];
    for (const mind of this.options.getMinds()) {
      const plan = this.planOf(mind);
      const bounds = plan?.bounds ?? null;
      const nodeRects = plan?.nodes ?? null;
      if (!bounds || !nodeRects) {
        // 模型读不到：容器里只有一句话，位置就是锚点（与 `intersects` 同一条口径）
        if (rectContainsPoint(worldRect, { x: mind.x, y: mind.y })) minds.push(mind.id);
        continue;
      }
      const inside = [...nodeRects].filter(([, rect]) => rectsIntersect(rect, worldRect));
      if (inside.length > 0 && inside.length < nodeRects.size) {
        for (const [nodeId] of inside) nodes.push(nodeEndpointKey(mind.id, nodeId));
        continue;
      }
      if (inside.length === nodeRects.size) {
        minds.push(mind.id);
        continue;
      }
      if (rectsIntersect(bounds, worldRect)) minds.push(mind.id);
    }
    return { minds, nodes };
  }

  /**
   * 一棵脑图此刻在白板上的外接框（**世界坐标**）；没有可画的（模型没读到）给 `null`。
   *
   * ★ 与 `bounds()` 的区别只在形状：那边是"一次要全部"（缩略图 / 适应内容），
   *   这边是"查一棵"（框选 / 选中框）—— 共用同一个算法，就不会出现
   *   "框选框到的范围与缩略图里画的不一样"。
   */
  private worldBoundsOf(entry: MountedMind): Rect | null {
    const bounds = entry.embed?.contentBounds();
    if (!bounds) return null;
    const origin = this.originOf(entry);
    return {
      x: origin.x + bounds.x,
      y: origin.y + bounds.y,
      width: bounds.width,
      height: bounds.height,
    };
  }

  /**
   * 摆一次选中框（每帧都调，只在真的变了才写 DOM）。
   *
   * ★ 位置算的是**外接框 + 留白**，用的是 `EmbedMind` 报的那份**相对坐标**
   *   （容器的 `left/top` 已经是它的原点）—— 所以拖动（`setPreview` 只写 DOM、
   *   模型没动）时框照样跟着手走，改名变宽时框跟着长，不必在这里再算一次世界坐标。
   * ★ 模型读不到（`contentBounds` 给 `null`）时**不画框**：那时容器里只有一句话，
   *   给一句话套个"整棵被选中"的框，是在暗示一棵不存在的树。
   */
  private applySelectionBox(entry: MountedMind, mindId: string): void {
    const wanted = this.selectedMinds.has(mindId);
    const local = wanted ? (entry.embed?.contentBounds() ?? null) : null;
    const box = local ? expandRect(local, SELECTION_PADDING) : null;
    const applied = entry.appliedBox;
    if (
      (box === null && applied === null) ||
      (box !== null &&
        applied !== null &&
        applied.x === box.x &&
        applied.y === box.y &&
        applied.width === box.width &&
        applied.height === box.height)
    ) {
      return;
    }
    entry.appliedBox = box;
    if (!box) {
      entry.boxEl.hidden = true;
      return;
    }
    entry.boxEl.hidden = false;
    entry.boxEl.style.left = `${box.x}px`;
    entry.boxEl.style.top = `${box.y}px`;
    entry.boxEl.style.width = `${box.width}px`;
    entry.boxEl.style.height = `${box.height}px`;
  }

  /**
   * 更新"被画布过滤掉"的节点外观（T3.17 / `2.2.0` 批 4）。
   *
   * ★ 与 `CardLayer.setDimmed` 同一套写法：只改 class、只碰已挂载的节点，
   *   新挂载的在 `EmbedMind.paint()` 里读同一个回调补上（见
   *   `EmbedMindOptions.isNodeDimmed`）—— 于是这里**不必**自己遍历任何模型。
   * ★ 收的是**节点端点键**（`脑图id/节点id`）：过滤那一层（`dimmedMindNodeKeys`）
   *   与连线那一层（`nodeRects`）因此用的是同一把尺子。
   */
  setDimmed(keys: ReadonlySet<string>): void {
    this.dimmedNodes = keys;
    for (const entry of this.mounted.values()) entry.embed?.refreshDim();
  }

  dispose(): void {
    this.clear();
  }

  /** 某个容器此刻在不在屏幕上（命中测试 / 框选要问） */
  elementOf(mindId: string): HTMLElement | null {
    return this.mounted.get(mindId)?.element ?? null;
  }

  /**
   * **从外面**选中一棵脑图里的某个节点（`2.2.0` 批 4：搜索结果落地）。
   *
   * ★ 选中态是卡内那一层的事（`EmbedMind.selectNode`），本层只负责"找到那一份嵌图" ——
   *   "选中"该长什么样不该在这里出现第二份实现。
   * @returns 真的选中了吗 —— `false` = 容器没挂 / 那个节点不在这一帧里
   *   （调用方据此退回"飞到树根那一点"）
   */
  focusNode(mindId: string, nodeId: string): boolean {
    const embed = this.mounted.get(mindId)?.embed;
    if (!embed) return false;
    return embed.selectNode(nodeId);
  }

  /**
   * 每个容器此刻占的地方（**白板世界坐标**）。
   *
   * ★ 容器的模型里**没有尺寸**（无边界），所以这份框是**现算**的：`EmbedMind` 报出
   *   相对锚点的外接框，这里加上容器的 `x/y`。调用方（适应内容 / 缩略图 / 演示取景）
   *   要的就是"这一棵树压在哪块地方"，而不是一个可以写回文件的矩形。
   */
  bounds(): Array<{ id: string; rect: Rect }> {
    const result: Array<{ id: string; rect: Rect }> = [];
    // ★ 遍历**全部**树而不是"已挂载的那些"（`2.2.0` 收尾）：裁剪之后屏幕外的树没有
    //   DOM，按挂载去数会让缩略图 / 导出取景**只剩屏幕里那几棵**（表现为
    //   "缩略图越缩越小"）。几何问 `boundsOf`，它与裁剪是同一个来源。
    for (const mind of this.options.getMinds()) {
      const rect = this.boundsOf(mind);
      if (rect) result.push({ id: mind.id, rect });
    }
    return result;
  }

  /**
   * 每个**画出来的**节点此刻占的地方（**白板世界坐标**），键是端点的**几何键**
   * （`schema.nodeEndpointKey`，即 `脑图id/节点id`）。
   *
   * ── 为什么这一张表是"节点连线"的全部几何（`2.2.0` 批 3）────────────
   *
   * 连线那一侧（`EdgeRenderer` / `ConnectController` / 命中 / 框选）从头到尾只认
   * **"一个键 + 一个矩形"**（`RectLookup`）。于是"让节点也能连线"要做的只是：
   * 把节点的盒子用同一个键格式**塞进那张表** —— 锚点取四边中点、智能路由、箭头、
   * 标签、命中、导出**一行都不用改**。
   *
   * ★ 现算不缓存：节点盒子只在"模型变了 / 这棵树被拖着"时才变，而这些时刻都会
   *   走 `sync()` 重画；每次现算的代价是每个节点几次加法（几十~几百这一档），
   *   比"缓存失效漏了一处"要便宜得多。
   * ★ 拖动中取**预览位置**（`entry.preview`）：那几帧模型还停在原位，
   *   用模型坐标的话线会留在原地、跟不上手。
   */
  nodeRects(): Map<string, Rect> {
    const result = new Map<string, Rect>();
    for (const [id, entry] of this.mounted) {
      const embed = entry.embed;
      if (!embed) continue;
      const origin = this.originOf(entry);
      for (const { nodeId, rect } of embed.nodeRects()) {
        result.set(nodeEndpointKey(id, nodeId), {
          x: origin.x + rect.x,
          y: origin.y + rect.y,
          width: rect.width,
          height: rect.height,
        });
      }
    }
    // ★ 被视口裁掉的那些树（`2.2.0` 收尾）：用**纯布局**把它们的节点补进表里。
    //   不补的话"从屏幕里一张卡指向屏幕外某个节点"的连线会整条消失 ——
    //   端点取不到矩形（`edgePolyline` 返回 `null`），而它半截本来就在屏幕上。
    for (const mind of this.options.getMinds()) {
      if (this.mounted.has(mind.id)) continue;
      const nodes = this.planOf(mind)?.nodes;
      if (!nodes) continue;
      for (const [nodeId, rect] of nodes) result.set(nodeEndpointKey(mind.id, nodeId), rect);
    }
    return result;
  }

  /**
   * 某个**节点端点键**此刻的矩形；`null` = 这棵树 / 这个节点此刻不在场上
   * （模型没读到、节点被折叠收起来了、或者这个键根本不是节点键）。
   *
   * ★ 连线手势（锚点 / 橡皮筋预览 / 目标高亮）要走它：那些时刻每帧只问**一个**键，
   *   建整张表是浪费（而 `nodeRects` 是给"每帧要全部"的绘制 / 命中用的）。
   */
  nodeRectOf(key: string): Rect | null {
    const { cardId, nodeId } = splitEndpointKey(key);
    if (nodeId === null) return null;
    const entry = this.mounted.get(cardId);
    const rect = entry?.embed?.nodeRects().find((item) => item.nodeId === nodeId)?.rect;
    if (entry && rect) {
      const origin = this.originOf(entry);
      return {
        x: origin.x + rect.x,
        y: origin.y + rect.y,
        width: rect.width,
        height: rect.height,
      };
    }
    // 没挂载（被视口裁掉）的树：纯布局那一条路（与 `nodeRects()` 同一个来源）
    const mind = this.options.getMinds().find((item) => item.id === cardId);
    if (!mind) return null;
    return this.planOf(mind)?.nodes?.get(nodeId) ?? null;
  }

  /**
   * 世界坐标下命中的那个**节点**（返回它的端点键；`null` = 没命中）。
   *
   * ★ 层序与卡片 / 分栏同一条：`z` 最大的先问（一棵压在另一棵上面的脑图先赢）。
   * ★ 一棵树内部若有两个盒子重叠（不该发生，但文件是人手可改的），
   *   谁在前面谁赢 —— 这里不额外做"取面积最小"这类聪明判断，简单可预期。
   */
  nodeAt(world: Point): string | null {
    const entries = [...this.mounted.entries()].sort(
      (a, b) => (b[1].holder.mind.z ?? 0) - (a[1].holder.mind.z ?? 0),
    );
    for (const [id, entry] of entries) {
      const embed = entry.embed;
      if (!embed) continue;
      const origin = this.originOf(entry);
      for (const { nodeId, rect } of embed.nodeRects()) {
        const hit = rectContainsPoint(
          { x: origin.x + rect.x, y: origin.y + rect.y, width: rect.width, height: rect.height },
          world,
        );
        if (hit) return nodeEndpointKey(id, nodeId);
      }
    }
    return null;
  }

  /**
   * 一棵脑图此刻的原点（= 根节点中心，**白板世界坐标**）。
   *
   * ★ 拖动中取预览点：模型在这几帧没动（见 `setPreview`）。
   */
  private originOf(entry: MountedMind): Point {
    const preview = entry.preview;
    if (preview) return preview;
    return { x: entry.holder.mind.x, y: entry.holder.mind.y };
  }

  /**
   * 拖动中的**预览位置**：只写 DOM，不动模型（松手由视图提交一次）。
   *
   * ★ 为什么要有这一步：容器拖动期间**模型一动不动**，而 `sync()` 每帧都跑
   *   （`syncCanvas` 里）—— 不把预览"接管"过来的话，下一帧就被按模型位置写回去，
   *   表现是"拖不动 / 一顿一顿"。与 `CardLayer.previewRects` 是同一条理由
   *   （那边还有一层 `appliedDragPreview` 兜住"sync 跑到预览之后"的时序，
   *   这里用"拖动期间不写位置"这一条更简单的规则达到同样效果）。
   * ★ 传 `null` = 结束预览，交还给模型（下一帧 `sync()` 按模型写）。
   */
  setPreview(mindId: string, point: Point | null): void {
    const entry = this.mounted.get(mindId);
    if (!entry) return;
    entry.preview = point;
    if (point === null) return;
    entry.element.style.left = `${point.x}px`;
    entry.element.style.top = `${point.y}px`;
  }

  // ── 内部 ────────────────────────────────────────────────────

  private ensure(mind: Mind): MountedMind {
    const existing = this.mounted.get(mind.id);
    if (existing) {
      existing.holder.mind = mind;
      return existing;
    }

    const doc = this.host.ownerDocument;
    const element = doc.createElement('div');
    element.className = MIND_CONTAINER_CLASS;
    element.setAttribute(MIND_CONTAINER_ID_ATTR, mind.id);

    // 根节点上按下 = 拖整棵（本层先拦下来，不然画布会当成"按在空白处"）
    element.addEventListener('pointerdown', (event) => this.onPointerDown(mind.id, event));

    const noteEl = doc.createElement('div');
    noteEl.className = MIND_CONTAINER_NOTE_CLASS;
    noteEl.hidden = true;
    // 选中框（`2.2.0` 批 5）：容器的**第一个孩子**（见 `MountedMind.boxEl`）——
    // 层序由 DOM 顺序决定，所以它必须**先挂**（`prepend` 在 Obsidian 的老环境里
    // 不是处处可用，而"先 append 它"效果一样、还少一个 API 面）
    const boxEl = doc.createElement('div');
    boxEl.className = MIND_SELECTION_CLASS;
    boxEl.hidden = true;
    element.appendChild(boxEl);
    element.appendChild(noteEl);

    this.host.appendChild(element);
    const entry: MountedMind = {
      element,
      noteEl,
      boxEl,
      appliedBox: null,
      embed: null,
      holder: { mind },
      applied: null,
      appliedModel: null,
      appliedVersion: null,
      appliedReadOnly: null,
      preview: null,
    };
    this.mounted.set(mind.id, entry);
    return entry;
  }

  /**
   * 一帧的落地：内容（位置 / 模型 / 嵌图）+ 选中框。
   *
   * ★ 拆成两个方法只为**保证选中框那一句在任何一条返回路径上都跑到** ——
   *   内容那三件事各自都有早退（模型还没读到、刚换了只读态、刚建了嵌图），
   *   而"选中框"这一档要跟着**这一帧的结果**走（读不到模型时它必须消失）。
   */
  private apply(entry: MountedMind, mind: Mind): void {
    this.applyContent(entry, mind);
    this.applySelectionBox(entry, mind.id);
  }

  private applyContent(entry: MountedMind, mind: Mind): void {
    const { element } = entry;

    // 1) 位置与层序：只写真的变了的数字
    // ★ 拖动期间（`preview !== null`）**不写位置**：那几帧的位置归拖动手势
    //   （见 `setPreview`），写回去就成了"拖不动"
    if (
      entry.preview === null &&
      (entry.applied === null ||
        entry.applied.x !== mind.x ||
        entry.applied.y !== mind.y ||
        entry.applied.z !== mind.z)
    ) {
      element.style.left = `${mind.x}px`;
      element.style.top = `${mind.y}px`;
      element.style.zIndex = String(mind.z);
      entry.applied = { x: mind.x, y: mind.y, z: mind.z };
    }

    // 2) 模型：读不到就先说一句话（文件脑图在读到之前、或文件没了）
    const model = this.options.modelOf(mind);
    const readOnly = this.options.isReadOnly(mind);
    if (model === null) {
      this.teardownEmbed(entry);
      if (entry.noteEl.hidden) {
        entry.noteEl.textContent =
          mind.path.length > 0 ? t('card.mindRef.missing') : t('card.mindRef.broken');
        entry.noteEl.hidden = false;
      }
      entry.appliedModel = null;
      entry.appliedVersion = null;
      return;
    }
    if (!entry.noteEl.hidden) entry.noteEl.hidden = true;

    // 3) 建 / 换 / 更新那份 `EmbedMind`
    const version = mindVersion(model);
    if (entry.embed === null || entry.appliedReadOnly !== readOnly) {
      this.teardownEmbed(entry);
      entry.embed = this.buildEmbed(entry, model, readOnly);
      entry.appliedModel = model;
      entry.appliedVersion = version;
      return;
    }
    if (entry.appliedModel !== model || entry.appliedVersion !== version) {
      entry.embed.update(model);
      entry.appliedModel = model;
      entry.appliedVersion = version;
    }
  }

  private buildEmbed(entry: MountedMind, model: MindFile, readOnly: boolean): EmbedMind {
    entry.appliedReadOnly = readOnly;
    return new EmbedMind({
      doc: entry.element.ownerDocument,
      host: entry.element,
      mind: model,
      // ★ 白板级脑图的摆法：**不缩放**，根节点中心对准容器原点（见 `EmbedMind.placement`）
      placement: 'anchor',
      readOnly,
      mutate: (mutator) => this.options.mutate(entry.holder.mind, mutator),
      // 根节点右键也给节点菜单（容器级那几项在 `BoardView.showMindNodeMenu` 里并进来）
      allowRootMenu: true,
      onNodeMenu: (nodeId, event) => this.options.onNodeMenu(entry.holder.mind, nodeId, event),
      onSelect: (nodeId) => this.options.onNodeFocus(entry.holder.mind, nodeId),
      consumeEditRequest: () => this.options.takeEditRequest?.(entry.holder.mind) ?? null,
      // 画布过滤（T3.17 / `2.2.0` 批 4）：这一棵里哪些节点该变淡 —— 键是本层自己的
      // 那一把（`脑图id/节点id`），回调读的是本层的最新一份记账（`setDimmed`）
      isNodeDimmed: (nodeId) => this.dimmedNodes.has(nodeEndpointKey(entry.holder.mind.id, nodeId)),
      // 框选选中（`2.2.0` 收尾）：同一把键、同一套回调
      isNodeMarqueeSelected: (nodeId) =>
        this.selectedNodes.has(nodeEndpointKey(entry.holder.mind.id, nodeId)),
      resolveResource: this.options.resolveResource,
      refMissing: this.options.refMissing,
      renderMarkdown: this.options.renderMarkdown,
      labels: this.options.labels,
      // ★ 白板脑图不接"双击空白 = 打开"：它是画布上的一棵树，空白处属于**画布**
      //   （打开那件事在节点菜单里，与从前那条口径一致）
    });
  }

  private unmount(entry: MountedMind): void {
    this.teardownEmbed(entry);
    entry.element.remove();
  }

  private teardownEmbed(entry: MountedMind): void {
    if (!entry.embed) return;
    entry.embed.element.remove();
    entry.embed.dispose();
    entry.embed = null;
    entry.appliedReadOnly = null;
    entry.appliedModel = null;
    entry.appliedVersion = null;
  }

  /**
   * 容器上的按下：**只认根节点**。
   *
   * ★ 别的节点由 `EmbedMind` 自己收（选中 / 改名），本层一个字都不插手 ——
   *   判据是"按下落在根节点那个元素里"，而根节点元素由 `EmbedMind` 持有（问它要）。
   */
  private onPointerDown(mindId: string, event: PointerEvent): void {
    const entry = this.mounted.get(mindId);
    if (!entry) return;
    const rootEl = entry.embed?.rootNodeElement() ?? null;
    if (!pressedRootNode(event.target, rootEl)) return;
    const mind = entry.holder.mind;
    if (this.options.isReadOnly(mind)) return;
    event.stopPropagation();
    this.options.onDragStart(mind, event);
  }
}

/**
 * 一份脑图模型的**版本标记**（"内容变了没有"的判据，见 `MountedMind.appliedVersion`）。
 *
 * 三样东西拼起来：
 *
 * * `revision` —— 主信号。仓储那条路每次 `mutate` 都会 +1（唯一的读写口，
 *   没有任何调用方关掉它），于是"就地改、引用不变"也能被认出来；
 * * `nodes.length` —— 兜底。万一将来有人用 `bumpRevision: false` 写内容，
 *   至少"加 / 删节点"这种最显眼的变化不会被漏掉（代价是一次读属性）；
 * * `model` 的**引用**本身由调用方一起比（内嵌那条路换的是新对象）。
 *
 * ★ 反过来的代价是**多画一次**（模型没变却重画）：`paint()` 是幂等的，
 *   而漏画的代价是"用户明明加了节点，画面上没有" —— 两个方向不对称，宁可多画。
 */
function mindVersion(model: MindFile): string {
  // 拼成字符串而不是"乘一个系数加起来"：后者会撞（revision 1 + 1000 个节点
  // 与 revision 2 + 0 个节点算出来是同一个数），而这条判据的代价正是"漏画一次"
  return `${model.revision}:${model.nodes.length}`;
}

/**
 * 一个容器此刻在不在"被按下的是根节点"这件事上。
 *
 * ★ 抽成纯函数是为了能单测：本层其余部分都要真 DOM（`instanceof Node` / `contains`），
 *   而这一条判据正是"拖整棵"能不能起来的唯一闸门。
 */
export function pressedRootNode(target: unknown, rootElement: HTMLElement | null): boolean {
  if (!rootElement) return false;
  if (typeof Node === 'undefined' || !(target instanceof Node)) return false;
  return rootElement.contains(target);
}
