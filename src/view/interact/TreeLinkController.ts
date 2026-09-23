/**
 * **树连线手势**（`F7`，定稿 D6「重新思考」那支）。
 *
 * ```text
 *   hover 卡片 ──▶ 右上角浮出树把手 ──按下拖动──▶ LINKING ──落到另一张卡──▶ onDrop(父, 子)
 *                                            ├── 落回自己 / 空白 / Esc ──▶ 取消
 * ```
 *
 * 与 {@link ConnectController}（普通连线）**同构但独立**：
 *
 * 1. **把手也是"唯一一组常驻 DOM"**：hover 到哪张卡就挪到哪张卡（DOM 预算同 `02 §8.1`）；
 * 2. **目标只有卡片**：树是卡片的树（分栏 / 脑图节点都不是树的成员），
 *    命中走 `hitTest` + 卡片的视觉矩形，与框选同一份判据；
 * 3. **预览线从父卡中心出发**：与真正的树线几何（`edges.edgeEndpoints` 的
 *    `kind === 'tree'` 支）同一条口径 —— 预览画的是"将要得到的那条线"。
 *
 * ★ 校验**不在这里**：self / 成环 / 已有父级全部由模型层 `tree.treeLinkState` 判
 *   （判定与提交同居模型层），本控制器只负责"把两个卡片 id 交上去"。
 * ★ 不 import `obsidian`。几何与状态部分可在 node 下单测（DOM 部分除外）。
 */

import { hitTest } from './HitTest';
import { rectCenter, type Point, type Rect } from '../../util/geometry';
import type { BoardFile, Card } from '../../model/schema';
import type { OverlayLayer } from '../render/OverlayLayer';
import type { Viewport } from '../../canvas/Viewport';
import type { PointerStateMachine } from './PointerStateMachine';

/** 把手元素上的标记属性（pointermove 里"指针正压在把手上"靠它认亲） */
const TREE_HANDLE_ATTR = 'data-tree-handle';

export interface TreeLinkControllerOptions {
  /** 画布容器：把手的宿主，也是指针事件的宿主（与 ConnectController 同一个） */
  host: HTMLElement;
  viewport: Viewport;
  overlay: OverlayLayer;
  stateMachine: PointerStateMachine;
  getBoard: () => BoardFile | null;
  /**
   * 松手落地：`(父卡 id, 子卡 id)`。方向由手势定死 —— **发起方是父级**（D6）。
   * 能不能连（self / 成环 / 已有父级）由调用方按 `tree.treeLinkState` 判定并提示。
   */
  onDrop: (parentId: string, childId: string) => void;
  /** 此刻是否允许起手（平移中 / 只读态返回 `false`） */
  canStart?: () => boolean;
  /** 这张卡能不能作为树的一员（无框脑图卡不参与，与普通连线的 `canAttach` 同一道闸） */
  canLink?: (cardId: string) => boolean;
  /** 卡片的**视觉**矩形（栏内滚动的成员按模型坐标判会指错，见 ConnectController 同名注释） */
  cardRectOf?: (card: Card) => Rect;
  /**
   * **单选的那张卡**（`2.2.0` · O2）。缺省 = 只 hover 才浮把手。
   *
   * ★ 为什么加这一档（用户 2026-09-22："把手应该更明显一点"）：只 hover 才出现，
   *   等于"你得先把鼠标移上去才知道有这么个东西" —— 选中一张卡时它也该在，
   *   用户才看得见"这张卡的线可以收起来"。
   */
  getSelectedCardId?: () => string | null;
  /** 选区变了要重摆手柄（与 `ConnectController.subscribeSelection` 同一条） */
  subscribeSelection?: (listener: () => void) => () => void;
}

interface TreeSession {
  readonly parentId: string;
  readonly pointerId: number;
}

export class TreeLinkController {
  private readonly host: HTMLElement;
  private readonly viewport: Viewport;
  private readonly overlay: OverlayLayer;
  private readonly stateMachine: PointerStateMachine;
  private readonly getBoard: () => BoardFile | null;
  private readonly onDrop: TreeLinkControllerOptions['onDrop'];
  private readonly canStart: (() => boolean) | undefined;
  private readonly canLink: ((cardId: string) => boolean) | undefined;
  private readonly cardRectOf: (card: Card) => Rect;
  private readonly getSelectedCardId: (() => string | null) | undefined;

  /** 唯一一个树把手 */
  private readonly handle: HTMLElement;
  /** 把手当前贴着哪张卡（`null` = 隐藏） */
  private hoveredCardId: string | null = null;
  private session: TreeSession | null = null;
  private readonly bound: Array<{ type: string; listener: EventListener }> = [];
  private readonly unsubscribes: Array<() => void> = [];

  constructor(options: TreeLinkControllerOptions) {
    this.host = options.host;
    this.viewport = options.viewport;
    this.overlay = options.overlay;
    this.stateMachine = options.stateMachine;
    this.getBoard = options.getBoard;
    this.onDrop = options.onDrop;
    this.canStart = options.canStart;
    this.canLink = options.canLink;
    this.cardRectOf =
      options.cardRectOf ??
      ((card) => ({ x: card.x, y: card.y, width: card.width, height: card.height }));
    this.getSelectedCardId = options.getSelectedCardId;

    this.handle = document.createElement('div');
    this.handle.className = 'nestboard-tree-handle';
    this.handle.setAttribute(TREE_HANDLE_ATTR, '');
    this.handle.setAttribute('aria-hidden', 'true');
    this.handle.setCssStyles({ display: 'none' });
    this.handle.addEventListener('pointerdown', (event) => this.beginLink(event as PointerEvent));
    this.host.appendChild(this.handle);

    this.listen('pointermove', (event) => this.onPointerMove(event as PointerEvent));
    this.listen('pointerup', (event) => this.onPointerUp(event as PointerEvent));
    this.listen('pointercancel', () => this.cancel());
    this.listen('keydown', (event) => {
      if ((event as KeyboardEvent).key === 'Escape') this.cancel();
    });
    // 视口一动，把手还钉在原来的屏幕上 —— 跟着卡片的新位置重摆
    this.unsubscribes.push(this.viewport.onChange(() => this.reposition()));
    // 选区一变，把手跟着挪到新选中的那张卡上（`2.2.0` · O2）
    if (options.subscribeSelection) {
      this.unsubscribes.push(options.subscribeSelection(() => this.syncHandleToSelection()));
    }
  }

  /** 是否正在拉树线（调用方用它拦右键菜单等） */
  get isLinking(): boolean {
    return this.session !== null;
  }

  /** 取消进行中的手势（换板 / 只读切换 / 外部打断） */
  cancel(): void {
    if (this.session) {
      this.session = null;
      this.overlay.clear();
      this.stateMachine.escape();
    }
    this.hideHandle();
  }

  dispose(): void {
    this.cancel();
    for (const { type, listener } of this.bound) this.host.removeEventListener(type, listener);
    this.bound.length = 0;
    for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe();
    this.handle.remove();
  }

  // ── 悬停 ─────────────────────────────────────────────────

  private onPointerMove(event: PointerEvent): void {
    if (this.session) {
      this.updatePreview(event);
      return;
    }
    // 非空闲态（拖卡片 / 框选中）不浮把手；有按键按着也不是"悬停"
    if (!this.stateMachine.is('IDLE') || event.buttons !== 0) {
      this.hideHandle();
      return;
    }
    // 指针正压在把手上：别把自己刚浮出来的把手收掉（否则永远按不下去）
    const target = event.target;
    if (target instanceof HTMLElement && target.closest(`[${TREE_HANDLE_ATTR}]`)) return;

    // ★ 指针没压在卡上时回落到"**选中的那张卡**"（`2.2.0` · O2）：
    //   只 hover 才浮出来，等于"用户得先摸到才知道有它"。选中时也让它在，
    //   并顺带把"选中 → 拖把手收起这张卡的线"这条动作变得看得见。
    const cardId = this.cardUnderPointer(event, null)?.id ?? this.selectedCardForHandle();
    if (!cardId || !(this.canLink?.(cardId) ?? true)) {
      this.hideHandle();
      return;
    }
    this.hoveredCardId = cardId;
    this.reposition();
  }

  /** 单选的卡片 id（本次交互的"回落把手位"）；没选卡 / 选了多张给 `null` */
  private selectedCardForHandle(): string | null {
    return this.getSelectedCardId?.() ?? null;
  }

  /**
   * 选区变了（`2.2.0` · O2）：把手跟着挪到新选中的那张卡上；没选卡就收起来。
   *
   * ★ 收起来是安全的：下一次 `pointermove` 会按"指针下是谁"重新算一遍 ——
   *   它只是"这一帧没有该显示的卡"，不是"把手坏了"。
   */
  private syncHandleToSelection(): void {
    if (this.session) return;
    const id = this.selectedCardForHandle();
    if (id !== null && (this.canLink?.(id) ?? true) && this.rectOfId(id)) {
      this.hoveredCardId = id;
      this.reposition();
      return;
    }
    this.hideHandle();
  }

  /** 把手挪到悬停卡的右上角；`hoveredCardId` 为空（或卡不在了）则隐藏 */
  private reposition(): void {
    if (this.session) return;
    const rect = this.rectOfId(this.hoveredCardId);
    if (!rect) {
      this.hideHandle();
      return;
    }
    const screen = this.viewport.toScreen({ x: rect.x + rect.width, y: rect.y });
    // 居中靠 CSS 的 translate(-50%, -50%)，这里只写左上角落点
    this.handle.style.left = `${screen.x}px`;
    this.handle.style.top = `${screen.y}px`;
    this.handle.setCssStyles({ display: '' });
  }

  private hideHandle(): void {
    if (this.hoveredCardId === null) return;
    this.hoveredCardId = null;
    this.handle.setCssStyles({ display: 'none' });
  }

  // ── 手势 ─────────────────────────────────────────────────

  private beginLink(event: PointerEvent): void {
    if (this.canStart && !this.canStart()) return;
    const parentId = this.hoveredCardId;
    if (!parentId) return;
    if (!this.stateMachine.request('CONNECTING')) return;
    // 挡住同宿主上的框选与卡片拖动（与 ConnectController 的锚点同一套防线）
    event.preventDefault();
    event.stopPropagation();

    this.session = { parentId, pointerId: event.pointerId };
    this.hideHandle();
    try {
      this.host.setPointerCapture(event.pointerId);
    } catch {
      // 指针已失效 → 只影响拖出画布的事件，预览照走
    }
    this.updatePreview(event);
  }

  private onPointerUp(event: PointerEvent): void {
    const session = this.session;
    if (!session) return;
    this.releaseCapture(session.pointerId);
    const target = this.cardUnderPointer(event, session.parentId);
    this.session = null;
    this.overlay.clear();
    this.stateMachine.escape();

    // 落在另一张卡上才交出去；落回自己 / 空白都是"算了"（树线没有自由端这回事）
    if (target && target.id !== session.parentId) {
      this.onDrop(session.parentId, target.id);
    }
  }

  // ── 预览 ─────────────────────────────────────────────────

  private updatePreview(event: PointerEvent): void {
    const session = this.session;
    if (!session) return;
    const fromRect = this.rectOfId(session.parentId);
    if (!fromRect) {
      this.cancel();
      return;
    }
    const bounds = this.host.getBoundingClientRect();
    // 预览从**父卡中心**出发：与真正的树线几何同一条口径（定稿：只连中心点）
    const startWorld = rectCenter(fromRect);
    const start = this.viewport.toScreen(startWorld);
    const end = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };

    const target = this.cardUnderPointer(event, session.parentId);
    const targetRect = target ? this.screenRectOf(target) : null;

    this.overlay.beginFrame();
    this.overlay.drawConnectPreview({ x1: start.x, y1: start.y, x2: end.x, y2: end.y });
    if (targetRect) this.overlay.drawConnectTarget(targetRect);
  }

  // ── 工具 ─────────────────────────────────────────────────

  /** 指针（世界坐标）下面那张卡；`exclude` 排除起点。只认卡片 —— 树是卡片的树 */
  private cardUnderPointer(event: PointerEvent, exclude: string | null): Card | null {
    const board = this.getBoard();
    if (!board) return null;
    const world = this.toWorld(event);
    const candidates = board.cards.filter(
      (card) => card.id !== exclude && (this.canLink?.(card.id) ?? true),
    );
    return hitTest(candidates, world, (item) => this.cardRectOf(item));
  }

  private rectOfId(cardId: string | null): Rect | null {
    const board = this.getBoard();
    if (!board || cardId === null) return null;
    const card = board.cards.find((item) => item.id === cardId);
    return card ? this.cardRectOf(card) : null;
  }

  /** 一张卡的屏幕矩形（目标高亮用） */
  private screenRectOf(card: Card): Rect {
    const rect = this.cardRectOf(card);
    const topLeft = this.viewport.toScreen({ x: rect.x, y: rect.y });
    return {
      x: topLeft.x,
      y: topLeft.y,
      width: rect.width * this.viewport.zoom,
      height: rect.height * this.viewport.zoom,
    };
  }

  private toWorld(event: { clientX: number; clientY: number }): Point {
    const bounds = this.host.getBoundingClientRect();
    return this.viewport.toWorld({ x: event.clientX - bounds.left, y: event.clientY - bounds.top });
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
