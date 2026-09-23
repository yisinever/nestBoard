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
 * ★ **端点 = 卡片 ∪ 分栏 ∪ 脑图节点**（`O21` / `2.2.0` 批 3）。本控制器从头到尾只认
 *   "**一个键 + 一个矩形**"，所以让分栏、让脑图节点先后加入进来都没有改动算法：
 *   锚点、命中、目标高亮全走同一份几何，只是几何来源由 `rectOf` / `columnRectOf` /
 *   `nodes` 各自喂进来（栏还要考虑折叠态；节点要现算，因为它的位置由脑图布局决定）。
 *   ★ 节点的"键"是 `脑图id/节点id`（`schema.nodeEndpointKey`）—— 卡片 / 分栏 / 整棵脑图
 *     就是它们自己的 id，两者不相交，所以一张表装得下三种端点。
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
import {
  endpointAnchorKey,
  isFreeEndpoint,
  nodeEndpointKey,
  splitEndpointKey,
  type BoardFile,
  type Card,
  type Column,
  type EdgeEndpoint,
} from '../../model/schema';
import { rectContainsPoint, type Point, type Rect } from '../../util/geometry';
import type { OverlayLayer } from '../render/OverlayLayer';
import type { Viewport } from '../../canvas/Viewport';
import { hitTest, resolveEndpoint, type EndpointKind } from './HitTest';
import type { PointerStateMachine } from './PointerStateMachine';

/** 锚点元素上的方位属性名（本文件读写两处共用，不散落字符串） */
const ANCHOR_SIDE_ATTR = 'data-connect-side';

/** 端点重拖手柄上的属性（`2.2.0` · O1）：写着它是 `from` 还是 `to` */
const EDGE_END_ATTR = 'data-edge-end';

/**
 * **脑图节点**这一种端点（`2.2.0` 批 3）。
 *
 * ★ 为什么要单独一个来源、而不是把节点矩形也塞进 `rectOf`：节点的几何**不在模型里**
 *   —— 它由脑图布局算出来、由 DOM 实测（`MindLayer.nodeRects`）。
 *   视图那边是"从渲染层现取"，这里只认结果。
 * ★ 两个方法都收/给**端点的几何键**（`脑图id/节点id`），本控制器依旧不知道
 *   "节点"是什么东西（与它不认识"分栏"是同一个姿态）。
 * ★ 缺席 = 这块板上的脑图不作为端点：老调用方一行都不用改。
 */
export interface NodeEndpointSource {
  /** 世界坐标下命中哪个节点（返回端点键）；`null` = 没命中 */
  hit(world: Point): string | null;
  /** 某个节点键此刻的视觉矩形（世界坐标）；`null` = 这个节点不在了 / 这棵树读不到 */
  rectOf(key: string): Rect | null;
}

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
   * 两端给的都是**端点的几何键**（`schema.endpointAnchorKey` 那一套）：卡片 / 分栏 /
   * 整棵脑图就是它们自己的 id，脑图节点是 `脑图id/节点id` —— 由视图翻成
   * `EdgeEndpoint`（`endpointOfKey`）。
   *
   * 终点有两种形态（T2.07 / `F3-02`）：
   *   - `{ key }` —— 落在另一个端点上（卡片 / 分栏 / 脑图节点，`O21` + `2.2.0`）；
   *   - `{ key: null, point }` —— **自由端**：松手在空白处，端点就留在那儿。
   *     落在起点自己身上不算（那是一次原地点击，语义是"算了"）。
   *
   * ★ 用可辨识联合而不是两个可选字段（`toKey?` + `toPoint?`）：
   *   后者允许"两个都有"或"两个都没有"这两种没有意义的状态，
   *   而调用方每次都得自己判断该信哪一个。
   * ★ 字段名叫 `key` 而不是 `cardId`（`O21` 时叫 `cardId`）：那曾经是 `EdgeEndpoint`
   *   的字段名，而现在端点的身份**不再只有一层** —— 继续叫 `cardId` 会让人以为
   *   "节点端点的键也是一个卡片 id"，而这正是最该避免的误会。
   */
  onConnect: (
    fromKey: string,
    fromSide: AnchorSide,
    to: { key: string } | { key: null; point: Point },
  ) => void;
  /** 此刻是否允许起手（平移中 / 只读态返回 `false`） */
  canStart?: () => boolean;
  /**
   * 这个端点（卡片 / 分栏）**能不能作为整体**连线（默认都能）。
   *
   * ★ 唯一的用户是**无框脑图卡**（`F4`，用户 2026-09-21："脑图……也不会作为整体对外连线"）：
   *   它连的是**卡内的节点**，不是整张卡 —— 所以 hover 到它身上不浮锚点、
   *   拖过去的线也不落在它身上（落上去会被当成"连了整张脑图"，那是用户明确不要的）。
   * ★ 判据由调用方给（视图知道卡片类型）：本控制器只认"一个 id"，不认识类型名册。
   */
  canAttach?: (endpointId: string) => boolean;
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
  /**
   * **脑图节点**这一种端点（`2.2.0` 批 3）。不传 = 脑图上的节点不能连线。
   *
   * ★ 与 `rectOf` / `columnRectOf` 分开的第三个来源：节点的几何不在模型里，
   *   由脑图布局算、由视图从 DOM 实测喂进来（见 `NodeEndpointSource`）。
   */
  nodes?: NodeEndpointSource;
  /**
   * **单选的那条线**（`2.2.0` · O1 端点重拖）；缺省 = 本视图不提供这一档。
   *
   * ★ 与 `EdgeCurveController` 的 `activeEdge` 同一形状、同一条纪律（判断集中在视图）：
   *   控制器只负责"把两端画成可拖的手柄、拖完把落点交回去"。
   */
  activeEdge?: () => { id: string; from: EdgeEndpoint; to: EdgeEndpoint } | null;
  /**
   * 端点改拖落地（`2.2.0` · O1）：与 `onConnect` 的终点**同一形状**
   * （`{ key }` 或 `{ key: null, point }`），由视图翻成 `EdgeEndpoint` 并落历史。
   */
  onReconnect?: (
    edgeId: string,
    end: 'from' | 'to',
    to: { key: string } | { key: null; point: Point },
  ) => void;
  /** 选区变了要重摆手柄（与 `EdgeCurveController.subscribeSelection` 同一条） */
  subscribeSelection?: (listener: () => void) => () => void;
}

/** 当前悬停的那个端点：键 + 它是哪一类（节点那一类不走 `canAttach`，见 `attachable`） */
interface HoveredTarget {
  readonly key: string;
  readonly kind: EndpointKind;
}

interface ConnectSession {
  /**
   * `'create'` = 从锚点拉一条新线；`'reconnect'` = 拖一条**已有**线的某一端
   * （`2.2.0` · O1）。
   */
  readonly kind: 'create' | 'reconnect';
  /**
   * 预览的"起点"端点键（卡片 / 分栏 / 脑图节点的键）。
   *
   * ★ `create`：用户按下锚点那一端；`reconnect`：**不动的那一端**。
   */
  readonly fromKey: string;
  readonly fromSide: AnchorSide;
  /** `reconnect` 才有：正在改哪条线的哪一端 */
  readonly edgeId?: string;
  readonly end?: 'from' | 'to';
  /**
   * `reconnect` 且"不动的那端是**自由端**"时，预览从这个世界点出发
   * （自由端没有键，`fromKey` 是空串）。
   */
  readonly fromPoint?: Point;
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
  /** 这个端点能不能作为整体连着（`F4`：无框脑图卡不行，见 `ConnectControllerOptions.canAttach`） */
  private readonly canAttach: ((endpointId: string) => boolean) | undefined;
  private readonly visualRect: (card: Card) => Rect;
  /** 分栏的视觉矩形（`O21`）；`null` = 本视图不把分栏当端点（老调用方一行都不用改） */
  private readonly visualColumnRect: ((column: Column) => Rect) | null;
  /** 脑图节点这一种端点（`2.2.0`）；`null` = 本视图不让节点连线 */
  private readonly nodeSource: NodeEndpointSource | null;

  /** 唯一一组锚点，按 {@link ANCHOR_SIDES} 顺序 */
  private readonly anchors = new Map<AnchorSide, HTMLElement>();
  /** 端点重拖的两个手柄（`2.2.0` · O1）；本视图不给 `activeEdge` 时永远隐藏 */
  private readonly endHandles = new Map<'from' | 'to', HTMLElement>();
  private readonly endHandleBindings: Array<{ handle: HTMLElement; listener: EventListener }> = [];
  private readonly activeEdge: ConnectControllerOptions['activeEdge'];
  private readonly onReconnect: ConnectControllerOptions['onReconnect'];
  /** 锚点当前贴着哪个端点（卡片 / 分栏 / 脑图节点）；`null` = 隐藏 */
  private hovered: HoveredTarget | null = null;
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
    this.canAttach = options.canAttach;
    this.visualRect =
      options.rectOf ??
      ((card) => ({ x: card.x, y: card.y, width: card.width, height: card.height }));
    this.visualColumnRect = options.columnRectOf ?? null;
    this.nodeSource = options.nodes ?? null;
    this.activeEdge = options.activeEdge;
    this.onReconnect = options.onReconnect;

    for (const side of ANCHOR_SIDES) {
      const anchor = document.createElement('div');
      anchor.className = 'nestboard-connect-anchor';
      anchor.setAttribute(ANCHOR_SIDE_ATTR, side);
      anchor.setAttribute('aria-hidden', 'true');
      anchor.setCssStyles({ display: 'none' });
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
    // 端点重拖的两个手柄（`2.2.0` · O1）：只在"单选一条线"时浮出来
    for (const end of ['from', 'to'] as const) {
      const handle = document.createElement('div');
      handle.className = 'nestboard-edge-endpoint';
      handle.setAttribute(EDGE_END_ATTR, end);
      handle.setAttribute('aria-hidden', 'true');
      handle.setCssStyles({ display: 'none' });
      const listener: EventListener = (event) => this.beginReconnect(end, event as PointerEvent);
      handle.addEventListener('pointerdown', listener);
      this.endHandleBindings.push({ handle, listener });
      this.host.appendChild(handle);
      this.endHandles.set(end, handle);
    }

    // 视口一动，锚点还钉在原来的屏幕上 —— 必须跟着卡片的新位置重摆
    this.unsubscribes.push(this.viewport.onChange(() => this.repositionAnchors()));
    // 端点手柄同理（视口 + 选区）
    this.unsubscribes.push(this.viewport.onChange(() => this.refreshEndHandles()));
    if (options.subscribeSelection) {
      this.unsubscribes.push(options.subscribeSelection(() => this.refreshEndHandles()));
    }
    this.refreshEndHandles();
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
    // 取消之后手柄要回来（`2.2.0` · O1）：那条线还选着，用户该能重拖
    this.refreshEndHandles();
  }

  dispose(): void {
    this.cancel();
    for (const { type, listener } of this.bound) this.host.removeEventListener(type, listener);
    this.bound.length = 0;
    for (const { anchor, listener } of this.anchorBindings) {
      anchor.removeEventListener('pointerdown', listener);
    }
    this.anchorBindings.length = 0;
    for (const { handle, listener } of this.endHandleBindings) {
      handle.removeEventListener('pointerdown', listener);
    }
    this.endHandleBindings.length = 0;
    for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe();
    for (const anchor of this.anchors.values()) anchor.remove();
    this.anchors.clear();
    for (const handle of this.endHandles.values()) handle.remove();
    this.endHandles.clear();
  }

  // ── 指针 ─────────────────────────────────────────────────

  /**
   * 摆（或收起）端点重拖手柄（`2.2.0` · O1）。
   *
   * ★ 只在"**单选一条线**"时出现（`activeEdge` 由视图判断：单选 / 只读 / 演示都算过一遍）——
   *   与弧度手柄同一套纪律，两处不会各判一份。
   * ★ 自由端也要手柄：恰恰是"拖到空地上的那条线"，最需要能再拖回来（用户 2026-09-22 报的）。
   */
  refreshEndHandles(): void {
    const edge = this.activeEdge?.() ?? null;
    // 拉线 / 改端点途中不显示（此刻用户的操作对象是那根线）
    if (!edge || this.session) {
      this.hideEndHandles();
      return;
    }
    const bounds = this.hostBounds();
    for (const end of ['from', 'to'] as const) {
      const handle = this.endHandles.get(end);
      if (!handle) continue;
      const screen = this.endpointScreenPointOf(edge[end]);
      if (!screen) {
        handle.setCssStyles({ display: 'none' });
        continue;
      }
      handle.style.left = `${screen.x - bounds.left}px`;
      handle.style.top = `${screen.y - bounds.top}px`;
      handle.setCssStyles({ display: '' });
    }
  }

  private hideEndHandles(): void {
    for (const handle of this.endHandles.values()) handle.setCssStyles({ display: 'none' });
  }

  /**
   * 一个端点在**屏幕**上的位置；自由端用它的世界坐标换算，绑定的端点用它的视觉矩形中心。
   *
   * ★ 绑到卡片 / 分栏 / 节点上时取**视觉**几何（栏内滚过的成员差一个偏移，T2.03）——
   *   与锚点、命中、高亮四处共用同一份（`rectOfKey`）。
   */
  private endpointScreenPointOf(endpoint: EdgeEndpoint): Point | null {
    if (isFreeEndpoint(endpoint)) {
      const point = endpoint.point;
      if (!point) return null;
      return this.viewport.toScreen({ x: point.x, y: point.y });
    }
    const key = endpointAnchorKey(endpoint);
    const rect = key ? this.rectOfKey(this.hoveredOf(key)) : null;
    if (!rect) return null;
    const centre = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    return this.viewport.toScreen(centre);
  }

  /**
   * 拖一条**已有**线的某一端（`2.2.0` · O1）。
   *
   * ★ 复用同一条会话：预览、落点判定、目标高亮、取消（`Esc`）全都是现成的 ——
   *   唯一的区别是松手时把落点交给 `onReconnect`（改绑那条线），而不是 `onConnect`。
   */
  private beginReconnect(end: 'from' | 'to', event: PointerEvent): void {
    if (this.canStart && !this.canStart()) return;
    const edge = this.activeEdge?.() ?? null;
    if (!edge || !this.onReconnect) return;
    if (!this.stateMachine.request('CONNECTING')) return;

    // 挡住同宿主上的框选与卡片拖动（与锚点那条同一套防线）
    event.preventDefault();
    event.stopPropagation();

    const fixed = end === 'from' ? edge.to : edge.from;
    const fixedKey = isFreeEndpoint(fixed) ? '' : endpointAnchorKey(fixed);
    // 不动的那一端是自由端（没有键）⇒ 预览改从它的世界点出发
    const fromPoint = isFreeEndpoint(fixed) ? (fixed.point ?? undefined) : undefined;
    const side = (isFreeEndpoint(fixed) ? 'right' : (fixed.side ?? 'right')) as AnchorSide;
    this.session = {
      kind: 'reconnect',
      fromKey: fixedKey ?? '',
      fromSide: side,
      edgeId: edge.id,
      end,
      fromPoint,
      pointerId: event.pointerId,
    };
    this.hideAnchors();
    this.hideEndHandles();
    try {
      this.host.setPointerCapture(event.pointerId);
    } catch {
      // 指针已失效 → 只影响拖出画布的事件，预览照走
    }
    this.updatePreview(event);
  }

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
    const hovered: HoveredTarget = {
      key:
        endpoint.kind === 'node'
          ? nodeEndpointKey(endpoint.id, endpoint.nodeId ?? '')
          : endpoint.id,
      kind: endpoint.kind,
    };
    // 这个端点要真的**在场上**才浮锚点：节点可能刚被折叠收起来、那份 `.nestmind`
    // 可能还没读到（`rectOfKey` 会给 `null`），此刻浮出来的锚点会连带着
    // 一条"从虚空拉出来的线"（落点也会落在它身上）
    if (!this.attachable(hovered) || !this.rectOfKey(hovered)) {
      this.hideAnchors();
      return;
    }
    this.repositionAnchors(hovered);
  }

  /**
   * 这个端点能不能连线。
   *
   * ★ 卡片 / 分栏走 `canAttach`（唯一的用户是**无框脑图卡**：用户 2026-09-21 ——
   *   "脑图……不会作为整体对外连线"，那种卡不作为整体连）；
   * ★ 脑图节点**不问** `canAttach`：那道闸门的判据是"这是不是一种不作为整体连的
   *   **卡片类型**"，而节点根本不是卡片（拿节点键去卡片表里查只会查不到、
   *   于是恒为 true —— 依赖这种"碰巧对"是下一处 bug 的温床）。
   *   节点能不能连，由 `NodeEndpointSource.rectOf` 给不给矩形说话。
   */
  private attachable(target: HoveredTarget): boolean {
    if (target.kind === 'node') return true;
    return this.canAttach?.(target.key) ?? true;
  }

  private onPointerUp(event: PointerEvent): void {
    const session = this.session;
    if (!session) return;
    this.releaseCapture(session.pointerId);

    const world = this.toWorld(event);
    const target = this.endpointAtPoint(world, session.fromKey);
    // 松手点下面那个端点（**不排除**起点）：用来把"落在空白"与"落回自己"分开
    const under = this.endpointAtPoint(world, null);
    this.session = null;
    this.overlay.clear();
    this.stateMachine.escape();

    if (session.kind === 'reconnect' && session.edgeId && session.end) {
      // 改端点（`2.2.0` · O1）：落到对象上就绑过去，落到空白就变成自由端 ——
      // 与"拉新线"完全同一套判据（`target` / `under` 的含义都一样）
      if (target) {
        this.onReconnect?.(session.edgeId, session.end, { key: target });
      } else if (!under) {
        this.onReconnect?.(session.edgeId, session.end, { key: null, point: world });
      }
      // 松手后重摆手柄（线可能已经换了位置）
      this.refreshEndHandles();
      if (under) this.repositionAnchors(this.hoveredOf(under));
      else this.hideAnchors();
      return;
    }

    if (target) {
      this.onConnect(session.fromKey, session.fromSide, { key: target });
    } else if (!under) {
      // ★ 落在空白处 = **自由端**（T2.07 / `F3-02`）：端点就留在松手的地方。
      //   原来这里什么都不做，于是"从卡片拉一条线指到空地"（做标注、指出方向）
      //   这个再自然不过的动作会**毫无反应**，用户只会以为连线功能坏了。
      this.onConnect(session.fromKey, session.fromSide, { key: null, point: world });
    }
    // 落回起点对象自己身上（`under` 命中但 `target` 为 null）= 原地点击或拖回原处，
    // 语义是"算了"，什么也不建 —— 否则会在卡片边缘留下一条朝向自己的短线
    //
    // 松手后指针多半还停在目标上：让它立刻重新浮出锚点，省得用户再抖一下鼠标
    if (under) this.repositionAnchors(this.hoveredOf(under));
    else this.hideAnchors();
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || !this.session) return;
    this.cancel();
    event.preventDefault();
  }

  // ── 锚点 ─────────────────────────────────────────────────

  private beginConnect(side: AnchorSide, event: PointerEvent): void {
    if (this.canStart && !this.canStart()) return;
    const hovered = this.hovered;
    if (!hovered) return;
    // 锚点会留着上一次的悬停（鼠标不动时不会重算）：这里再拦一道，
    // 免得"刚 hover 过一张普通卡、随后锚点被挪到无框卡上"时还能按下
    if (!this.attachable(hovered) || !this.rectOfKey(hovered)) return;
    if (!this.stateMachine.request('CONNECTING')) return;

    // ★ 挡住同元素上的框选控制器与卡片拖动：它们都挂在 host 上，
    //   不拦的话"按住锚点拖"会同时触发一次框选 / 一次卡片拖动
    event.preventDefault();
    event.stopPropagation();

    this.session = {
      kind: 'create',
      fromKey: hovered.key,
      fromSide: side,
      pointerId: event.pointerId,
    };
    this.hideAnchors();
    try {
      this.host.setPointerCapture(event.pointerId);
    } catch {
      // 指针已失效（触控笔抬起等）→ 不影响后续 move 的预览，只是拖出画布会丢事件
    }
    this.updatePreview(event);
  }

  /** 把锚点挪到某个端点（卡片 / 分栏 / 脑图节点）的四边中点；传 `null` 或不在了则全部隐藏 */
  private repositionAnchors(target: HoveredTarget | null = this.hovered): void {
    // 拉线过程中不显示锚点：此刻用户的操作对象是"那根线"，不是端点本身
    if (this.session) return;
    // 不作为整体的端点（无框脑图卡）也不浮锚点 —— 松手那一下的"落点重浮"走的是这里
    if (target !== null && !this.attachable(target)) {
      this.hideAnchors();
      return;
    }
    const rect = target ? this.rectOfKey(target) : null;
    if (!rect) {
      this.hideAnchors();
      return;
    }

    for (const side of ANCHOR_SIDES) {
      const anchor = this.anchors.get(side);
      if (!anchor) continue;
      // ★ 分栏不旋转（`Column` 上根本没有 `rotation`），脑图节点也不转 ——
      //   所以第三参恒为 `0`：`cardAnchor` 的默认值就是它，不必为三种端点分流。
      const screen = this.viewport.toScreen(cardAnchor(rect, side));
      // 居中靠 CSS 的 translate(-50%, -50%)，这里只写左上角落点
      anchor.style.left = `${screen.x}px`;
      anchor.style.top = `${screen.y}px`;
      anchor.setCssStyles({ display: '' });
    }
    this.hovered = target;
  }

  private hideAnchors(): void {
    if (this.hovered === null) return;
    this.hovered = null;
    for (const anchor of this.anchors.values()) anchor.setCssStyles({ display: 'none' });
  }

  // ── 预览 ─────────────────────────────────────────────────

  private updatePreview(event: PointerEvent): void {
    const session = this.session;
    if (!session) return;
    // ★ `reconnect` 且"不动的那端是自由端"（`2.2.0` · O1）：它没有键、也没有矩形，
    //   预览从它的世界点出发 —— 正是这种线最需要能再拖（用户 2026-09-22 报的那条）。
    const fromPoint = session.fromPoint;
    let start: Point;
    if (fromPoint) {
      start = this.viewport.toScreen(fromPoint);
    } else {
      const fromRect = this.rectOfKey(this.hoveredOf(session.fromKey));
      if (!fromRect) {
        this.cancel();
        return;
      }
      start = this.viewport.toScreen(cardAnchor(fromRect, session.fromSide));
    }

    const bounds = this.hostBounds();
    const world = this.toWorld(event);
    const end = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };

    const target = this.endpointAtPoint(world, session.fromKey);
    const targetRect = target ? this.endpointScreenRect(target) : null;

    this.overlay.beginFrame();
    this.overlay.drawConnectPreview({ x1: start.x, y1: start.y, x2: end.x, y2: end.y });
    if (targetRect) this.overlay.drawConnectTarget(targetRect);
  }

  // ── 工具 ─────────────────────────────────────────────────

  /** 由端点键还原"悬停目标"：键里自带它是哪一类（节点键是 `脑图id/节点id`） */
  private hoveredOf(key: string): HoveredTarget {
    return { key, kind: splitEndpointKey(key).nodeId === null ? 'card' : 'node' };
  }

  /**
   * 一个端点此刻的**视觉**矩形（世界坐标）；找不到返回 `null`。
   *
   * ★ 三种端点各自去自己的那一侧取几何：卡片 / 分栏查模型（`visualRect` /
   *   `visualColumnRect`），脑图节点问 `nodes`（那个盒子由脑图布局 + DOM 实测决定，
   *   模型里根本没有）。
   */
  private rectOfKey(target: HoveredTarget): Rect | null {
    if (target.kind === 'node') return this.nodeSource?.rectOf(target.key) ?? null;
    return this.objectRect(target.key);
  }

  /**
   * 卡片 / 分栏的**视觉**矩形（`O21`）；找不到返回 `null`。
   *
   * ★ 先查卡片再查分栏：两者的 id 唯一，顺序只影响微不可察的一次数组扫描，
   *   但"卡片优先"与画布上的层级观感一致（成员卡画在自己那一栏之上）。
   */
  private objectRect(id: string): Rect | null {
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
    // ★ **脑图节点优先**（`2.2.0` 批 3）：节点比卡片 / 分栏都小、且它是"更里面"那一层，
    //   指针压在它上面时用户指的就是那个节点 —— 与"卡片优先于分栏"是同一条道理。
    //   ★ 落在节点上就到此为止（不再往卡片 / 分栏退）：一棵脑图正好压在一张卡上时，
    //     "松手落在节点上"必须连节点，不能悄悄变成"连了那棵脑图下面的卡片"。
    const node = this.nodeSource?.hit(world) ?? null;
    if (node !== null && node !== exclude) return node;
    // ★ 排除起点、也排除"不作为整体的端点"（无框脑图卡）：线落在它身上会被当成
    //   "连了整张脑图"，而用户明确不要那件事 —— 于是这一落变成**自由端**（留在空白处）。
    const cards = board.cards.filter(
      (card) => card.id !== exclude && this.attachable({ key: card.id, kind: 'card' }),
    );
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
  private endpointScreenRect(key: string): Rect | null {
    const rect = this.rectOfKey(this.hoveredOf(key));
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
