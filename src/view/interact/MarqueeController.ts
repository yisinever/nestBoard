/**
 * 选区模型 + 框选（T1.31，F3-08）—— `02 §5.3` 鼠标操作表。
 *
 * 两个部分：
 *  * `SelectionModel`：选中了哪些对象。**纯逻辑、可单测**。
 *  * `MarqueeController`：空白处按下拖出的框选框，按 `§5.3` 的判据选中卡片。
 *
 * ── 三条纪律 ───────────────────────────────────────────────
 *
 * 1. **选区是界面状态，不进模型**。它不能写进 `.nboard`（`03 §4` 的 schema 里没这东西），
 *    关闭视图就该消失。所以它既不属于 `BoardFile`，也不属于 `CardLayer`，
 *    而是由本文件的 `SelectionModel` 单独持有，`CardLayer` 只负责把它画出来。
 *
 * 2. **框选与裁剪共用一套相交判据**（`CardLayer.cardsIntersecting`）。
 *    各写一套的结果是"看得见却框不中"，而用户完全无法理解为什么。
 *
 * 3. **选框画在覆盖层，且每次指针移动整层重画**。`OverlayLayer` 是屏幕坐标层：
 *    框选框跟着指针走，若画在世界坐标里，缩放时线宽会跟着变粗变细。
 *
 * ── 两条已知边界（刻意留白，不是漏了）───────────────────────
 *
 * * **触屏单指拖动归平移**（`02 §4.3`）。`NavigationController` 的 `pointerdown`
 *   先于本控制器执行并立刻进入平移，`canStart()` 因此返回 `false` —— 触屏上不会
 *   误触出框选。触屏想框选需要"长按进入选择模式"之类的专门入口（移动端专项）。
 * * `overlay.beginFrame()` 目前**由框选自己调用**。覆盖层的其他使用者（T3.12 参考线、
 *   T1.55 分栏插入线）进来之前必须先把"每帧一次 `beginFrame`"变成由帧调度器统一发出，
 *   否则两个使用者会互相把对方刚画的线清掉。
 *
 * ★ 本文件不 import `obsidian`，纯几何与指针逻辑可在 node 下单测（DOM 部分除外）。
 */

import type { Card } from '../../model/schema';
import { rectFromPoints, type Point, type Rect } from '../../util/geometry';
import { cardsIntersecting } from '../render/CardLayer';
import type { OverlayLayer } from '../render/OverlayLayer';
import { resolveCardElement } from './HitTest';
import type { PointerStateMachine } from './PointerStateMachine';
import type { Viewport } from '../../canvas/Viewport';

/**
 * 小于这个位移量（屏幕像素）算"点击空白"而不是"框选"。
 *
 * 不设阈值的话，手一抖 1px 的点击会先画出一个 1×1 的框选、把选区清空，
 * 用户会看到"点一下空白，选区闪了一下"。
 */
export const MARQUEE_MIN_DRAG_PX = 3;

/**
 * 框选**能选中**的卡片：**栏内的卡片不参与**（用户 2026-09-16）。
 *
 * ★ 为什么：栏内卡片的坐标是**栏算出来的**，而且一栏还有滚动（T2.03）与"收起"
 *   两种状态 —— 收起那栏里的卡**根本看不见**。把它们框进选区，用户拿到手的是一批
 *   "屏幕上看不见、位置也不由自己定"的东西，一拖就散到别处去。
 * ★ 要动栏里的卡：**点它**（点选不受这条限制）；要动整栏：把那一栏框住
 *   （见 `MarqueeControllerOptions.columnsIn`），再拖栏 / 折叠 / 转成编组。
 * ★ 抽成纯函数是为了能单测：`update()` 里的指针部分要在真实浏览器里才跑得动。
 */
export function marqueeSelectableCards<T extends { columnId: string | null }>(
  cards: readonly T[],
): T[] {
  return cards.filter((card) => card.columnId === null);
}

// ─────────────────────────────────────────────────────────────
// 选区模型
// ─────────────────────────────────────────────────────────────

export interface SelectionInput {
  /** 选中的卡片 id。**省略 = 空**（不是"保持不变"） */
  cards?: Iterable<string>;
  /** 选中的连线 id（F3-08 要求框选也能选线；渲染接入见 T1.71） */
  edges?: Iterable<string>;
  /** 选中的分栏 id（T1.54）。**省略 = 空** —— 与卡片一样，框选会整体替换选区 */
  columns?: Iterable<string>;
}

function sameIdSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

/**
 * 选中集合。刻意**就地复用两个 `Set` 对象**（而不是每次换新对象）：
 * `CardLayer` 会长期持有 `cardIds` 这个引用，换对象就等于悄悄让它指向过期数据。
 */
export class SelectionModel {
  private readonly cards = new Set<string>();
  private readonly edges = new Set<string>();
  /**
   * 选中的分栏（T1.54；**可以多个** —— 框选能一次框住好几栏，用户 2026-09-16）。
   *
   * ★ **点选**（{@link selectColumn}）仍然收敛成"唯一一个"：点分栏标题栏是个
   *   "我要动这一栏"的手势，同时留着上次选的那几栏只会让"Delete 删什么"要靠猜。
   *   `set()` 才是框选的入口，那边允许多个。
   * ★ 与卡片**可以共存**：框住"两栏 + 几张贴在栏外的卡"是一次合法选区 ——
   *   `⌘G` 把两栏各收成一个组、松散卡片收成另一个组（一次提交、一步撤销）。
   */
  private readonly columns = new Set<string>();
  private readonly listeners = new Set<() => void>();

  get isEmpty(): boolean {
    return this.cards.size === 0 && this.edges.size === 0 && this.columns.size === 0;
  }

  get size(): number {
    return this.cards.size + this.edges.size + this.columns.size;
  }

  /** 选中卡片 id（**活引用**，渲染层可直接缓存） */
  get cardIds(): ReadonlySet<string> {
    return this.cards;
  }

  get edgeIds(): ReadonlySet<string> {
    return this.edges;
  }

  /** 选中分栏 id（**活引用**） */
  get columnIds(): ReadonlySet<string> {
    return this.columns;
  }

  /** 唯一选中的分栏；没有 / 不止一个时 `null` */
  get columnId(): string | null {
    return this.columns.size === 1 ? [...this.columns][0] : null;
  }

  hasCard(id: string): boolean {
    return this.cards.has(id);
  }

  hasEdge(id: string): boolean {
    return this.edges.has(id);
  }

  hasColumn(id: string): boolean {
    return this.columns.has(id);
  }

  /**
   * **单选**一个分栏（点分栏的标题栏 / 栏内空白）。
   *
   * ★ 这是"点"的语义 ⇒ 收敛成唯一一个（框选走 `set()`，它允许多栏并存）。
   * ★ 这里**必须**顺手清掉卡片与连线选区：不清就会留下"分栏被选中，同时 12 张卡
   *   也处于选中态"的画面，而用户心里的操作对象只有一个（他刚点的就是这一栏）。
   *   多花一次 `emit` 换掉这类歧义，非常划算。
   */
  selectColumn(id: string): boolean {
    if (
      this.columns.size === 1 &&
      this.columns.has(id) &&
      this.cards.size === 0 &&
      this.edges.size === 0
    ) {
      return false;
    }
    this.cards.clear();
    this.edges.clear();
    this.columns.clear();
    this.columns.add(id);
    this.emit();
    return true;
  }

  /**
   * 整体替换选区。返回**是否真的变了** ——
   * 框选每帧都会算出一批 id，绝大多数帧的结果与上一帧相同；
   * 不做这个判断，每帧都会去改一次卡片 class，拖框就卡了。
   */
  set(input: SelectionInput): boolean {
    const nextCards = input.cards ? new Set(input.cards) : new Set<string>();
    const nextEdges = input.edges ? new Set(input.edges) : new Set<string>();
    const nextColumns = input.columns ? new Set(input.columns) : new Set<string>();
    if (
      sameIdSet(this.cards, nextCards) &&
      sameIdSet(this.edges, nextEdges) &&
      sameIdSet(this.columns, nextColumns)
    ) {
      return false;
    }

    replace(this.cards, nextCards);
    replace(this.edges, nextEdges);
    // ★ `set()` 是"整体替换"：框选每帧都会调它，不在这里清掉分栏的话，
    //   一次框选过后分栏会一直保持选中（而用户眼里选区早就换成框里的卡片了）
    replace(this.columns, nextColumns);
    this.emit();
    return true;
  }

  /** 清空。返回是否真的变了（Esc 处理要靠它决定要不要 `preventDefault`） */
  clear(): boolean {
    if (this.isEmpty) return false;
    this.cards.clear();
    this.edges.clear();
    this.columns.clear();
    this.emit();
    return true;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose(): void {
    this.listeners.clear();
    this.cards.clear();
    this.edges.clear();
    this.columns.clear();
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

function replace(target: Set<string>, source: ReadonlySet<string>): void {
  target.clear();
  for (const id of source) target.add(id);
}

// ─────────────────────────────────────────────────────────────
// 控制器
// ─────────────────────────────────────────────────────────────

export interface MarqueeControllerOptions {
  /** 画布容器：指针事件的宿主，也是屏幕坐标原点 */
  host: HTMLElement;
  viewport: Viewport;
  /** 框选框画在这里（屏幕坐标覆盖层） */
  overlay: OverlayLayer;
  stateMachine: PointerStateMachine;
  selection: SelectionModel;
  /** 取当前白板的卡片（已按 z 排序） */
  getCards: () => readonly Card[];
  /**
   * 卡片的**视觉**矩形（T2.03 栏内滚动之后，模型坐标 ≠ 屏幕位置）。
   *
   * ★ 框选判据必须用它：框选画在屏幕上，而模型里的成员坐标是"未滚动"的那一份，
   *   不换算就会出现"框住了看不见的卡、看得见的反而没框中"。
   */
  rectOf?: (card: Card) => Rect;
  /**
   * 此刻是否允许开始框选。平移（Space/中键/双指）必须把框选关掉，
   * 否则一次"按住空格拖画布"会在放手时留下一个巨大的选框。
   */
  canStart?: () => boolean;
  /**
   * 命中连线（T1.71 / `F3-07`）。传入**屏幕坐标**，返回被点中的连线 id 或 `null`。
   *
   * ★ 放在这里而不是另开一个 `pointerdown` 监听：本控制器已经是"空白处指针"的
   *   守门人（卡片之外的按下都归它），再加一层监听就得靠 `stopImmediatePropagation`
   *   抢执行顺序 —— 那种写法在别人调整构造顺序时会静默失效。
   */
  hitEdge?: (screen: Point) => string | null;
  /** 框选时一并选中的连线（T1.71）。不传 = 框选不选线 */
  edgesIn?: (worldRect: Rect) => string[];
  /**
   * 框选时一并选中的**分栏**（用户 2026-09-16）。
   *
   * ★ 与卡片是**两道独立的判据**：栏内的卡片不参与框选（见 `update`），
   *   而栏本身参与 —— 于是"框住一栏"得到的就是**那一栏**，而不是里面那些
   *   位置由栏算出来、还能被收起来的卡片。
   */
  columnsIn?: (worldRect: Rect) => string[];
}

interface DragState {
  readonly start: Point;
  /** Shift 加选时按下瞬间的已有选区；`null` = 没按 Shift */
  readonly base: { cards: Set<string>; edges: Set<string>; columns: Set<string> } | null;
  /** 是否越过了位移阈值（越过才算"框选"，否则是"点击空白"） */
  active: boolean;
}

export class MarqueeController {
  private readonly host: HTMLElement;
  private readonly viewport: Viewport;
  private readonly overlay: OverlayLayer;
  private readonly stateMachine: PointerStateMachine;
  private readonly selection: SelectionModel;
  private readonly getCards: () => readonly Card[];
  private readonly rectOf: ((card: Card) => Rect) | undefined;
  private readonly canStart: (() => boolean) | undefined;
  private readonly hitEdge: ((screen: Point) => string | null) | undefined;
  private readonly edgesIn: ((worldRect: Rect) => string[]) | undefined;
  private readonly columnsIn: ((worldRect: Rect) => string[]) | undefined;

  private drag: DragState | null = null;
  /** 最近一次的指针屏幕坐标，用于视口变化时按同样大小重画 */
  private lastScreen: Point | null = null;
  private readonly bound: Array<{ type: string; listener: EventListener }> = [];
  private readonly unsubscribes: Array<() => void> = [];

  constructor(options: MarqueeControllerOptions) {
    this.host = options.host;
    this.viewport = options.viewport;
    this.overlay = options.overlay;
    this.stateMachine = options.stateMachine;
    this.selection = options.selection;
    this.getCards = options.getCards;
    this.rectOf = options.rectOf;
    this.canStart = options.canStart;
    this.hitEdge = options.hitEdge;
    this.edgesIn = options.edgesIn;
    this.columnsIn = options.columnsIn;

    this.listen('pointerdown', (event) => this.onPointerDown(event as PointerEvent));
    this.listen('pointermove', (event) => this.onPointerMove(event as PointerEvent));
    this.listen('pointerup', (event) => this.onPointerUp(event as PointerEvent));
    this.listen('pointercancel', () => this.cancel());
    this.listen('keydown', (event) => this.onKeyDown(event as KeyboardEvent));

    // 视口一动，屏幕坐标里的选框还在原处 —— 世界矩形已经变了，必须按新视口重算
    this.unsubscribes.push(this.viewport.onChange(() => this.redrawIfDragging()));

    // 选区变化 → 选中外观由 BoardView 订阅 `SelectionModel` 统一处理（唯一咽喉点）；
    // 换板/卸载时的清空同样由 BoardView 负责，本控制器不越权。
  }

  /**
   * 全选（`⌘A`，F3-08）。选**整块白板**的卡片，而不是"当前可见的那些"。
   *
   * ★ 与框选**同一套"能选中谁"**（用户 2026-09-16："`⌘A` 做到一致"）：栏内卡片不参与
   *   —— 它们的坐标由栏算出来、栏一收起就看不见，选中之后按 `Delete` 会删掉一屏
   *   看不见的东西（框选那条路早就这么防着，`⌘A` 之前漏了）。
   */
  selectAll(): boolean {
    return this.selection.set({
      cards: marqueeSelectableCards(this.getCards()).map((card) => card.id),
    });
  }

  /** 选区变化时是否还在拖框（供调用方判断，如"拖动中不弹右键菜单"） */
  get isDragging(): boolean {
    return this.drag?.active === true;
  }

  dispose(): void {
    for (const { type, listener } of this.bound) this.host.removeEventListener(type, listener);
    this.bound.length = 0;
    for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe();
    this.drag = null;
    this.lastScreen = null;
    this.overlay.clear();
  }

  // ── 指针 ─────────────────────────────────────────────────

  private onPointerDown(event: PointerEvent): void {
    // 只认主键：中键留给平移，右键留给菜单
    if (event.button !== 0) return;
    // 手绘 / 连线 / 正在编辑时，指针归别的控制器
    if (!this.stateMachine.is('IDLE')) return;
    if (this.canStart && !this.canStart()) return;
    // 点在卡片上 → 归卡片自己的交互（选择 / 拖动 / 编辑）
    if (resolveCardElement(event.target, this.host)) return;

    const start = this.toLocal(event);

    // 点在连线上 → 只选这条线，不进入框选（T1.71）。
    // ★ 必须早于 `drag` 的创建：一旦建了 drag，`pointerup` 时那句
    //   "位移不足 = 点击空白 → 清空选区"会立刻把刚选中的线清掉
    const edgeId = this.hitEdge?.(start) ?? null;
    if (edgeId) {
      this.selection.set({ edges: [edgeId] });
      return;
    }

    this.drag = {
      start,
      base: event.shiftKey
        ? {
            cards: new Set(this.selection.cardIds),
            edges: new Set(this.selection.edgeIds),
            columns: new Set(this.selection.columnIds),
          }
        : null,
      active: false,
    };
    this.lastScreen = this.drag.start;

    // 抓住指针：拖出画布、掠过卡片时事件仍然回到这里
    try {
      this.host.setPointerCapture(event.pointerId);
    } catch {
      // 指针已失效（如触控笔抬起）→ 不影响后续逻辑，下次 move 照样能收到
    }
  }

  private onPointerMove(event: PointerEvent): void {
    const drag = this.drag;
    if (!drag) return;

    // 拖到一半开始平移（按下空格 / 双指）→ 直接取消，别留一个爬满屏幕的框
    if (this.canStart && !this.canStart()) {
      this.cancel();
      return;
    }

    const screen = this.toLocal(event);
    if (!drag.active) {
      const dx = screen.x - drag.start.x;
      const dy = screen.y - drag.start.y;
      if (Math.hypot(dx, dy) < MARQUEE_MIN_DRAG_PX) return;
      drag.active = true;
    }

    this.lastScreen = screen;
    this.update();
  }

  private onPointerUp(event: PointerEvent): void {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    this.releaseCapture(event.pointerId);
    this.overlay.clear();

    // 位移不到阈值 = 点击空白：清空选区（Shift 点击保留原选区，方便接着加选）
    if (!drag.active && !drag.base) this.selection.clear();
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    // 编辑态下 Esc 归编辑器，这里不越权（`handleKey` 自己会拒绝）
    if (this.stateMachine.handleKey('Escape')) {
      event.preventDefault();
      return;
    }
    // 已经在 IDLE：Esc 的职责是"清空选区"，没清到就不消费这个键
    if (this.selection.clear()) event.preventDefault();
  }

  // ── 框选计算与绘制 ────────────────────────────────────────

  private update(): void {
    const drag = this.drag;
    const screen = this.lastScreen;
    if (!drag || !screen) return;

    const screenRect = rectFromPoints(drag.start, screen);

    // 屏幕矩形 → 世界矩形：选谁要按世界坐标算（缩放时屏幕上 10px 的世界尺寸完全不同）
    const worldRect = rectFromPoints(
      this.viewport.toWorld(drag.start),
      this.viewport.toWorld(screen),
    );
    // ★ **栏内的卡片不参与框选**（见 `marqueeSelectableCards`）：框住一栏得到的是
    //   **那一栏**（下面 `columnsIn`），不是里面那些位置由栏算出来、还能被收起来的卡片
    const cards = drag.base ? new Set(drag.base.cards) : new Set<string>();
    for (const card of cardsIntersecting(
      marqueeSelectableCards(this.getCards()),
      worldRect,
      this.rectOf,
    )) {
      cards.add(card.id);
    }

    // 连线与卡片同一套判据（"看得见却框不中"是用户最无法理解的一类 bug）
    const edges = drag.base ? new Set(drag.base.edges) : new Set<string>();
    if (this.edgesIn) for (const id of this.edgesIn(worldRect)) edges.add(id);

    // 分栏：与卡片同一条判据（相交即选中）—— 框住一栏就是选中那一栏
    const columns = drag.base ? new Set(drag.base.columns) : new Set<string>();
    if (this.columnsIn) for (const id of this.columnsIn(worldRect)) columns.add(id);

    // ★ 三类必须**同一次** `set()` 给出：`set()` 是整体替换，
    //   分两次调用的话后一次会把前一次的选中清空
    this.selection.set({ cards, edges, columns });

    // 整层重画：选框只有一条，维护脏区不划算（T1.28 的 `beginFrame` 就是为此而生）
    this.overlay.beginFrame();
    this.overlay.drawMarquee(screenRect);
  }

  /** 视口在拖动过程中变了（滚轮缩放）：按新视口重算命中并重画 */
  private redrawIfDragging(): void {
    if (this.drag?.active && this.lastScreen) this.update();
  }

  /** 取消拖框：选区退回按下前的状态，框线抹掉 */
  private cancel(): void {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    this.overlay.clear();

    if (drag.base) {
      this.selection.set({
        cards: drag.base.cards,
        edges: drag.base.edges,
        columns: drag.base.columns,
      });
    } else {
      this.selection.clear();
    }
  }

  private toLocal(event: { clientX: number; clientY: number }): Point {
    const bounds = this.host.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  }

  private releaseCapture(pointerId: number): void {
    try {
      if (this.host.hasPointerCapture(pointerId)) this.host.releasePointerCapture(pointerId);
    } catch {
      // 指针已经不存在 —— 无需处理
    }
  }

  private listen(type: string, listener: EventListener): void {
    this.host.addEventListener(type, listener);
    this.bound.push({ type, listener });
  }
}
