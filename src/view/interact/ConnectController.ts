/**
 * 连线手势（T1.68，`F3-01` / `F3-02`）—— 从端点锚点拖出，落到另一个端点上。
 *
 * 交互分两段：
 *
 * ```
 *   hover 端点 ──▶ 四边中点浮出锚点 ──按下锚点──▶ CONNECTING ──落到另一个端点──▶ 回调（接上）
 *                                        ├── 落在空白 ──▶ 回调（自由端，T2.07）
 *                                        └── 落回自己 / Esc ──▶ 取消
 * ```
 *
 * ★ **端点 = 卡片 ∪ 分栏**（`O21`）。本控制器从头到尾只认"一个 id + 一个矩形"，
 *   所以让分栏加入进来**没有一处分支**：锚点、命中、目标高亮全走同一份几何，
 *   只是几何来源由 `rectOf` / `columnRectOf` 各自喂进来（栏还要考虑折叠态）。
 *
 * ── 三个关键设计 ──────────────────────────────────────────
 *
 * 1. **锚点是 4 个常驻 DOM，而不是每张卡 4 个**。1000 张卡各挂 4 个圆点就是
 *    4000 个额外节点，直接顶破 `02 §8.1` 的 DOM 预算 —— 而同一时刻用户只可能
 *    对着一张卡操作。所以本控制器持有**唯一一组**锚点，hover 到哪张卡就挪到哪张卡。
 *
 * 2. **进入 `CONNECTING` 后，框选与卡片拖动都不会启动**。两条防线：
 *    锚点的 `pointerdown` 里 `stopPropagation()`（挡住 `MarqueeController` 与
 *    `CardEventDelegate`），加上状态机本身拦截（`MarqueeController` 只认 `IDLE`）。
 *
 * 3. **拖动中指针捕获在画布容器上**。指针一旦移出卡片、掠过别的卡、甚至拖到
 *    视口边缘外，事件仍然回到这里 —— 否则"松手时到底连没连上"会变得不可预期。
 *
 * ★ 不 import `obsidian`。几何与状态部分可在 node 下单测（DOM 部分除外）。
 */

import { ANCHOR_SIDES, cardAnchor, type AnchorSide } from '../../model/edges';
import type { BoardFile, Card, Column } from '../../model/schema';
import { rectContainsPoint, type Point, type Rect } from '../../util/geometry';
import type { OverlayLayer } from '../render/OverlayLayer';
import type { Viewport } from '../../canvas/Viewport';
import { hitTest, resolveEndpoint } from './HitTest';
import type { PointerStateMachine } from './PointerStateMachine';

/** 锚点元素上的方位属性名（本文件读写两处共用，不散落字符串） */
const ANCHOR_SIDE_ATTR = 'data-connect-side';

export interface ConnectControllerOptions {
  /** 画布容器：锚点的宿主，也是指针事件的宿主 */
  host: HTMLElement;
  viewport: Viewport;
  /** 橡皮筋预览线与目标高亮画在这里（屏幕坐标覆盖层） */
  overlay: OverlayLayer;
  stateMachine: PointerStateMachine;
  getBoard: () => BoardFile | null;
  /**
   * 真的连上了：起点端点 / 起点方位 / 终点。
   *
   * 终点有两种形态（T2.07 / `F3-02`）：
   *   - `{ cardId }` —— 落在另一个端点上（卡片**或分栏**，`O21`）；
   *   - `{ cardId: null, point }` —— **自由端**：松手在空白处，端点就留在那儿。
   *     落在起点自己身上不算（那是一次原地点击，语义是"算了"）。
   *
   * ★ 用可辨识联合而不是两个可选字段（`toCardId?` + `toPoint?`）：
   *   后者允许"两个都有"或"两个都没有"这两种没有意义的状态，
   *   而调用方每次都得自己判断该信哪一个。
   * ★ 参数名仍叫 `cardId`：那是 `EdgeEndpoint` 的字段名，两种端点共存于一个字段
   *   （见 `model/edges.ts` 的说明），这里跟着同一个叫法以免两处概念对不上。
   */
  onConnect: (
    fromEndpointId: string,
    fromSide: AnchorSide,
    to: { cardId: string } | { cardId: null; point: Point },
  ) => void;
  /** 此刻是否允许起手（平移中 / 只读态返回 `false`） */
  canStart?: () => boolean;
  /**
   * 卡片的**视觉**矩形（T2.03 栏内滚动之后，模型坐标 ≠ 屏幕位置）。
   *
   * ★ 连线是"手伸到哪里就画到哪里"，锚点、命中、高亮三处都必须用同一份几何。
   *   不传按模型坐标算 —— 但那样在一个滚过内容的栏里，
   *   锚点会浮在卡片上方（用户会以为"锚点飘了"、连不上）。
   */
  rectOf?: (card: Card) => Rect;
  /**
   * 分栏的**视觉**矩形（`O21`）。不传则分栏不能作为端点。
   *
   * ★ 与 `rectOf` 分开给而不是合成一个 `(id) => Rect`：卡片与分栏在视图里是两份
   *   不同的几何来源（栏还要考虑**折叠态**：收起时它只占标题栏那么高，40px 的条
   *   也得能连 —— 拿模型里的 `height` 去连，锚点会浮在一个看不见的空盒子上）。
   */
  columnRectOf?: (column: Column) => Rect;
}

interface ConnectSession {
  /** 起点端点的 id（卡片或分栏，`O21`）—— 两者 id 唯一，用同一个字段 */
  readonly fromEndpointId: string;
  readonly fromSide: AnchorSide;
  readonly pointerId: number;
}

export class ConnectController {
  private readonly host: HTMLElement;
  private readonly viewport: Viewport;
  private readonly overlay: OverlayLayer;
  private readonly stateMachine: PointerStateMachine;
  private readonly getBoard: () => BoardFile | null;
  private readonly onConnect: ConnectControllerOptions['onConnect'];
  private readonly canStart: (() => boolean) | undefined;
  private readonly visualRect: (card: Card) => Rect;
  /** 分栏的视觉矩形（`O21`）；`null` = 本视图不把分栏当端点（老调用方一行都不用改） */
  private readonly visualColumnRect: ((column: Column) => Rect) | null;

  /** 唯一一组锚点，按 {@link ANCHOR_SIDES} 顺序 */
  private readonly anchors = new Map<AnchorSide, HTMLElement>();
  /** 锚点当前贴着哪个端点（卡片或分栏）；`null` = 隐藏 */
  private hoveredEndpointId: string | null = null;
  private session: ConnectSession | null = null;
  private readonly bound: Array<{ type: string; listener: EventListener }> = [];
  /** 锚点自身的监听器：退订要退在锚点元素上，不能混进 `bound`（那批退在 host 上） */
  private readonly anchorBindings: Array<{ anchor: HTMLElement; listener: EventListener }> = [];
  private readonly unsubscribes: Array<() => void> = [];

  constructor(options: ConnectControllerOptions) {
    this.host = options.host;
    this.viewport = options.viewport;
    this.overlay = options.overlay;
    this.stateMachine = options.stateMachine;
    this.getBoard = options.getBoard;
    this.onConnect = options.onConnect;
    this.canStart = options.canStart;
    this.visualRect =
      options.rectOf ??
      ((card) => ({ x: card.x, y: card.y, width: card.width, height: card.height }));
    this.visualColumnRect = options.columnRectOf ?? null;

    for (const side of ANCHOR_SIDES) {
      const anchor = document.createElement('div');
      anchor.className = 'nestboard-connect-anchor';
      anchor.setAttribute(ANCHOR_SIDE_ATTR, side);
      anchor.setAttribute('aria-hidden', 'true');
      anchor.style.display = 'none';
      const listener: EventListener = (event) => this.beginConnect(side, event as PointerEvent);
      anchor.addEventListener('pointerdown', listener);
      this.anchorBindings.push({ anchor, listener });
      this.host.appendChild(anchor);
      this.anchors.set(side, anchor);
    }

    this.listen('pointermove', (event) => this.onPointerMove(event as PointerEvent));
    this.listen('pointerup', (event) => this.onPointerUp(event as PointerEvent));
    this.listen('pointercancel', () => this.cancel());
    this.listen('keydown', (event) => this.onKeyDown(event as KeyboardEvent));
    // 视口一动，锚点还钉在原来的屏幕上 —— 必须跟着卡片的新位置重摆
    this.unsubscribes.push(this.viewport.onChange(() => this.repositionAnchors()));
  }

  /** 是否正在拉线（供调用方判断，如"拖动中不要弹右键菜单"） */
  get isConnecting(): boolean {
    return this.session !== null;
  }

  /** 取消进行中的连线（换板 / 只读切换 / 外部打断） */
  cancel(): void {
    if (this.session) {
      this.session = null;
      this.overlay.clear();
      this.stateMachine.escape();
    }
    this.hideAnchors();
  }

  dispose(): void {
    this.cancel();
    for (const { type, listener } of this.bound) this.host.removeEventListener(type, listener);
    this.bound.length = 0;
    for (const { anchor, listener } of this.anchorBindings) {
      anchor.removeEventListener('pointerdown', listener);
    }
    this.anchorBindings.length = 0;
    for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe();
    for (const anchor of this.anchors.values()) anchor.remove();
    this.anchors.clear();
  }

  // ── 指针 ─────────────────────────────────────────────────

  private onPointerMove(event: PointerEvent): void {
    if (this.session) {
      this.updatePreview(event);
      return;
    }
    if (!this.stateMachine.is('IDLE')) {
      this.hideAnchors();
      return;
    }
    // ★ 有按键按着就不是"悬停"（`O21`）：拖动卡片 / 分栏时指针会一直压在同一个
    //   端点身上，不排掉的话锚点会跟着被拖的那个对象一路飘 —— 而此刻用户手里
    //   握着的是"拖动"，不是"连线"。`buttons` 是位掩码，0 = 一个键都没按。
    if (event.buttons !== 0) {
      this.hideAnchors();
      return;
    }
    // 指针正压在锚点上：别把自己刚浮出来的锚点收掉（否则永远按不下去）
    const target = event.target;
    if (target instanceof HTMLElement && target.closest(`[${ANCHOR_SIDE_ATTR}]`)) return;

    const endpoint = resolveEndpoint(event.target, this.host);
    if (!endpoint) {
      this.hideAnchors();
      return;
    }
    this.repositionAnchors(endpoint.id);
  }

  private onPointerUp(event: PointerEvent): void {
    const session = this.session;
    if (!session) return;
    this.releaseCapture(session.pointerId);

    const world = this.toWorld(event);
    const target = this.endpointAtPoint(world, session.fromEndpointId);
    // 松手点下面那个端点（**不排除**起点）：用来把"落在空白"与"落回自己"分开
    const under = this.endpointAtPoint(world, null);
    this.session = null;
    this.overlay.clear();
    this.stateMachine.escape();

    if (target) {
      this.onConnect(session.fromEndpointId, session.fromSide, { cardId: target });
    } else if (!under) {
      // ★ 落在空白处 = **自由端**（T2.07 / `F3-02`）：端点就留在松手的地方。
      //   原来这里什么都不做，于是"从卡片拉一条线指到空地"（做标注、指出方向）
      //   这个再自然不过的动作会**毫无反应**，用户只会以为连线功能坏了。
      this.onConnect(session.fromEndpointId, session.fromSide, { cardId: null, point: world });
    }
    // 落回起点对象自己身上（`under` 命中但 `target` 为 null）= 原地点击或拖回原处，
    // 语义是"算了"，什么也不建 —— 否则会在卡片边缘留下一条朝向自己的短线
    //
    // 松手后指针多半还停在目标上：让它立刻重新浮出锚点，省得用户再抖一下鼠标
    this.repositionAnchors(under);
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || !this.session) return;
    this.cancel();
    event.preventDefault();
  }

  // ── 锚点 ─────────────────────────────────────────────────

  private beginConnect(side: AnchorSide, event: PointerEvent): void {
    if (this.canStart && !this.canStart()) return;
    const endpointId = this.hoveredEndpointId;
    if (!endpointId) return;
    if (!this.stateMachine.request('CONNECTING')) return;

    // ★ 挡住同元素上的框选控制器与卡片拖动：它们都挂在 host 上，
    //   不拦的话"按住锚点拖"会同时触发一次框选 / 一次卡片拖动
    event.preventDefault();
    event.stopPropagation();

    this.session = { fromEndpointId: endpointId, fromSide: side, pointerId: event.pointerId };
    this.hideAnchors();
    try {
      this.host.setPointerCapture(event.pointerId);
    } catch {
      // 指针已失效（触控笔抬起等）→ 不影响后续 move 的预览，只是拖出画布会丢事件
    }
    this.updatePreview(event);
  }

  /** 把锚点挪到某个端点（卡片或分栏，`O21`）的四边中点；传 `null` 或端点不存在则全部隐藏 */
  private repositionAnchors(endpointId: string | null = this.hoveredEndpointId): void {
    // 拉线过程中不显示锚点：此刻用户的操作对象是"那根线"，不是端点本身
    if (this.session) return;
    const rect = endpointId ? this.endpointRect(endpointId) : null;
    if (!rect) {
      this.hideAnchors();
      return;
    }

    for (const side of ANCHOR_SIDES) {
      const anchor = this.anchors.get(side);
      if (!anchor) continue;
      // ★ 分栏不旋转（`Column` 上根本没有 `rotation`），所以第三参恒为 `0`：
      //   `cardAnchor` 的默认值就是它，不必为两种端点分流。
      const screen = this.viewport.toScreen(cardAnchor(rect, side));
      // 居中靠 CSS 的 translate(-50%, -50%)，这里只写左上角落点
      anchor.style.left = `${screen.x}px`;
      anchor.style.top = `${screen.y}px`;
      anchor.style.display = '';
    }
    this.hoveredEndpointId = endpointId;
  }

  private hideAnchors(): void {
    if (this.hoveredEndpointId === null) return;
    this.hoveredEndpointId = null;
    for (const anchor of this.anchors.values()) anchor.style.display = 'none';
  }

  // ── 预览 ─────────────────────────────────────────────────

  private updatePreview(event: PointerEvent): void {
    const session = this.session;
    if (!session) return;
    const fromRect = this.endpointRect(session.fromEndpointId);
    if (!fromRect) {
      this.cancel();
      return;
    }

    const bounds = this.hostBounds();
    const world = this.toWorld(event);
    const start = this.viewport.toScreen(cardAnchor(fromRect, session.fromSide));
    const end = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };

    const target = this.endpointAtPoint(world, session.fromEndpointId);
    const targetRect = target ? this.endpointScreenRect(target) : null;

    this.overlay.beginFrame();
    this.overlay.drawConnectPreview({ x1: start.x, y1: start.y, x2: end.x, y2: end.y });
    if (targetRect) this.overlay.drawConnectTarget(targetRect);
  }

  // ── 工具 ─────────────────────────────────────────────────

  /**
   * 端点的**视觉**矩形（卡片或分栏，`O21`）；找不到返回 `null`。
   *
   * ★ 先查卡片再查分栏：两者的 id 唯一，顺序只影响微不可察的一次数组扫描，
   *   但"卡片优先"与画布上的层级观感一致（成员卡画在自己那一栏之上）。
   */
  private endpointRect(id: string): Rect | null {
    const board = this.getBoard();
    if (!board) return null;
    const card = board.cards.find((candidate) => candidate.id === id);
    if (card) return this.visualRect(card);
    if (!this.visualColumnRect) return null;
    const column = board.columns.find((candidate) => candidate.id === id);
    return column ? this.visualColumnRect(column) : null;
  }

  /**
   * 世界坐标命中一个端点（`O21`）；`exclude` 用于排除起点（自己连自己无语义）。
   *
   * ★ **卡片优先**：指针压在一张卡上时，用户指的是那张卡 —— 分栏是它的容器，
   *   几何上必然也包含这个点。真要点分栏，抓它露在外面的标题栏 / 空白处。
   * ★ 两者都用 z 最大者胜（与 `hitTest` / `findDropTarget` 同一份判据），
   *   且不假设数组有序 —— 它可能刚被 mutate 改过。
   */
  private endpointAtPoint(world: Point, exclude: string | null): string | null {
    const board = this.getBoard();
    if (!board) return null;
    const cards = exclude ? board.cards.filter((card) => card.id !== exclude) : board.cards;
    // 视觉几何：栏内滚过的成员按模型坐标判会"点着看得见的卡，落点却在别处"
    const card = hitTest(cards, world, (item) => this.visualRect(item));
    if (card) return card.id;
    if (!this.visualColumnRect) return null;

    let best: Column | null = null;
    for (const column of board.columns) {
      if (column.id === exclude) continue;
      if (!rectContainsPoint(this.visualColumnRect(column), world)) continue;
      if (!best || column.z >= best.z) best = column;
    }
    return best?.id ?? null;
  }

  /** 一个端点的屏幕矩形（世界 → 屏幕，含缩放），用来画目标高亮 */
  private endpointScreenRect(id: string): Rect | null {
    const rect = this.endpointRect(id);
    if (!rect) return null;
    const topLeft = this.viewport.toScreen({ x: rect.x, y: rect.y });
    return {
      x: topLeft.x,
      y: topLeft.y,
      width: rect.width * this.viewport.zoom,
      height: rect.height * this.viewport.zoom,
    };
  }

  private toWorld(event: { clientX: number; clientY: number }): Point {
    const bounds = this.hostBounds();
    return this.viewport.toWorld({ x: event.clientX - bounds.left, y: event.clientY - bounds.top });
  }

  /**
   * 宿主元素的屏幕矩形。
   *
   * ★ 每次现取而**不缓存**：分屏、侧栏折叠、窗口缩放都会让它的位置变，
   *   缓存下来就是"多点几次以后连线开始整体偏移"这种最难查的 bug。
   */
  private hostBounds(): DOMRect {
    return this.host.getBoundingClientRect();
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
