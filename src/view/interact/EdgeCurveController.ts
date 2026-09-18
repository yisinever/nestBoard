/**
 * 连线弧度手柄（T7.12 / `F3-07`）—— 选中一条 Free 连线后，在中点浮出一个小圆点，
 * 拖它把这条线弯成一条二次 Bezier 曲线，拖回弦上就是拉直。
 *
 * ── 四个关键设计 ──────────────────────────────────────────
 *
 * 1. **只有一个手柄，常驻 DOM**。与 `ConnectController` 的锚点同一条理由：
 *    选中态同一时刻只可能是"某一条线"，没必要按线数建 DOM。
 *
 * 2. **手柄与线必须落在同一个点上**。位置取自 `pathMidpoint(edgePathPoints(...))` ——
 *    与绘制、标签用的是同一个函数。自己另算一遍"中点"的话，弧线越长，
 *    手柄离线的距离越远（用户会先在视觉上发现"手柄飘了"，再发现拖不准）。
 *
 * 3. **几何必须用**视觉**坐标**。栏内滚动（T2.03）与拖动预览（T1.70）都会让
 *    卡片出现在"模型坐标之外"的地方，而线是按视觉坐标画的 —— 手柄按模型坐标算
 *    就会在滚过内容的栏里飘到别处。所以外部传进来的 `endpointsOf` 必须已经是
 *    带覆盖的视觉几何（`BoardView.cardRectLookup()`）。
 *
 * 4. **拖动中进入 `CONNECTING` 态**。它与"拖锚点"是同一类动作（在画布上拖一个把手），
 *    复用而不是新加状态 —— 状态图是**星形**的（`02 §3`），加一个状态要改那张图，
 *    还会多出"IN/OUT 各种组合"的合法性问题。副作用正好是我们要的：
 *    `MarqueeController` 只认 `IDLE`，于是拖手柄期间不会同时开始框选。
 *
 * ★ 不 import `obsidian`。位移换算（`curveFromMidpoint`）是纯函数、可单测；
 *   本文件只负责"把 DOM 事件接到那个换算上"。
 */

import {
  curveFromMidpoint,
  edgePathMidpoint,
  edgePathPoints,
  type EdgeEndpoints,
} from '../../model/edges';
import type { Edge, EdgeCurve } from '../../model/schema';
import { t } from '../../util/i18n';
import type { Viewport } from '../../canvas/Viewport';
import type { PointerStateMachine } from './PointerStateMachine';

export interface EdgeCurveControllerOptions {
  /** 画布容器：手柄的宿主，也是指针事件的宿主 */
  host: HTMLElement;
  viewport: Viewport;
  stateMachine: PointerStateMachine;
  /**
   * 当前**可以**调弧度的那条线；没有则返回 `null`。
   *
   * 由外部决定"哪条线可以调"（只选中一条、`routing: 'free'`、非只读、非演示态），
   * 本控制器不重复这些判断 —— 判断多了两处就会分叉。
   */
  activeEdge: () => Edge | null;
  /** 这条线的两端锚点（**视觉**几何，见头注 ③） */
  endpointsOf: (edge: Edge) => EdgeEndpoints | null;
  /** 是否允许起手（平移中 / 只读态返回 `false`） */
  canStart?: () => boolean;
  /**
   * 拖动中：把弧度当作临时几何喂给连线层（**不写模型**）。
   *
   * ★ 与卡片拖动同一条纪律：拖动期间模型不变，松手才 `commit` 一步历史 ——
   *   每动一下就提交的话，一次拖动会在"撤销"里留下几百步。
   */
  onPreview: (edgeId: string, curve: EdgeCurve | null) => void;
  /**
   * 拖动结束（取消 / 松手都算）：把临时几何**整个撤掉**。
   *
   * ★ 不能靠"再 preview 一遍模型里的旧值"来撤销：那会在覆盖表里留一项
   *   "恰好等于模型值"的条目，以后模型真的变了，这一项还会盖住新值 ——
   *   典型的"改一次模型没反应，改第二次才对"的来源。
   */
  onPreviewEnd: (edgeId: string) => void;
  /** 松手：正式写入模型（一步撤销）。`curve` 为 `null` = 拉直 */
  onCommit: (edgeId: string, curve: EdgeCurve | null) => void;
  /** 选中态变化（重摆手柄用） */
  subscribeSelection?: (listener: () => void) => () => void;
}

interface CurveSession {
  edgeId: string;
  pointerId: number;
  /**
   * 拖动开始时那条线的弧度。
   *
   * ★ 每次移动都基于**会话开始时**的两端锚点算（而不是每帧重取）：拖动中卡片不会动，
   *   但读数每帧重取会让"手指停住、坐标抖动"变成弧度的抖动，而且没必要。
   */
  readonly from: { x: number; y: number };
  readonly to: { x: number; y: number };
  curve: EdgeCurve | null;
}

export class EdgeCurveController {
  private readonly host: HTMLElement;
  private readonly viewport: Viewport;
  private readonly stateMachine: PointerStateMachine;
  private readonly activeEdge: () => Edge | null;
  private readonly endpointsOf: (edge: Edge) => EdgeEndpoints | null;
  private readonly canStart: () => boolean;
  private readonly onPreview: (edgeId: string, curve: EdgeCurve | null) => void;
  private readonly onPreviewEnd: (edgeId: string) => void;
  private readonly onCommit: (edgeId: string, curve: EdgeCurve | null) => void;

  private readonly handle: HTMLElement;
  private session: CurveSession | null = null;
  private visible = false;
  private readonly unsubscribes: Array<() => void> = [];
  private readonly listener: EventListener;

  constructor(options: EdgeCurveControllerOptions) {
    this.host = options.host;
    this.viewport = options.viewport;
    this.stateMachine = options.stateMachine;
    this.activeEdge = options.activeEdge;
    this.endpointsOf = options.endpointsOf;
    this.canStart = options.canStart ?? (() => true);
    this.onPreview = options.onPreview;
    this.onPreviewEnd = options.onPreviewEnd;
    this.onCommit = options.onCommit;

    this.handle = document.createElement('div');
    this.handle.className = 'nestboard-edge-curve-handle';
    this.handle.setAttribute('role', 'button');
    this.handle.setAttribute('aria-label', t('canvas.edgeCurveHandle'));
    this.handle.title = t('canvas.edgeCurveHandle');
    this.handle.style.display = 'none';
    this.listener = (event) => this.beginDrag(event as PointerEvent);
    this.handle.addEventListener('pointerdown', this.listener);
    this.host.appendChild(this.handle);

    this.unsubscribes.push(this.viewport.onChange(() => this.sync()));
    if (options.subscribeSelection)
      this.unsubscribes.push(options.subscribeSelection(() => this.sync()));

    // 指针捕获在宿主上：拖出画布、掠过别的卡，事件仍然回到这里
    this.bind('pointermove', (event) => this.onPointerMove(event as PointerEvent));
    this.bind('pointerup', () => this.onPointerUp());
    this.bind('pointercancel', () => this.cancel());
    this.bind('keydown', (event) => this.onKeyDown(event as KeyboardEvent));
  }

  get isDragging(): boolean {
    return this.session !== null;
  }

  /**
   * 重摆手柄（视口 / 选区 / 模型变了都要调）。
   *
   * 可见的三个条件：有可调的线、指针没在做别的事（`IDLE`）、拖的正是它自己。
   */
  sync(): void {
    if (this.session) {
      this.place(this.session);
      return;
    }
    const edge = this.stateMachine.is('IDLE') ? this.activeEdge() : null;
    if (!edge) {
      this.hide();
      return;
    }
    const endpoints = this.endpointsOf(edge);
    if (!endpoints) {
      this.hide();
      return;
    }
    const session: CurveSession = {
      edgeId: edge.id,
      pointerId: -1,
      from: endpoints.from,
      to: endpoints.to,
      curve: edge.curve ?? null,
    };
    this.place(session);
    this.visible = true;
    this.handle.style.display = '';
  }

  dispose(): void {
    this.cancel();
    this.handle.removeEventListener('pointerdown', this.listener);
    for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe();
    for (const { type, listener } of this.bound) this.host.removeEventListener(type, listener);
    this.bound.length = 0;
    this.handle.remove();
  }

  // ── 指针 ─────────────────────────────────────────────────

  private beginDrag(event: PointerEvent): void {
    if (!this.canStart()) return;
    const edge = this.activeEdge();
    if (!edge) return;
    const endpoints = this.endpointsOf(edge);
    if (!endpoints) return;
    if (!this.stateMachine.request('CONNECTING')) return;

    // ★ 挡住同元素上的框选控制器与卡片事件委托（它们都挂在 host 上）：
    //   不拦的话"按住手柄拖"会同时触发一次框选
    event.preventDefault();
    event.stopPropagation();

    this.session = {
      edgeId: edge.id,
      pointerId: event.pointerId,
      from: endpoints.from,
      to: endpoints.to,
      curve: edge.curve ?? null,
    };
    try {
      this.host.setPointerCapture(event.pointerId);
    } catch {
      // 指针已失效（触控笔抬起等）→ 不影响后续 move，只是拖出画布会丢事件
    }
  }

  private onPointerMove(event: PointerEvent): void {
    const session = this.session;
    if (!session) return;
    const world = this.toWorld(event);
    const curve = curveFromMidpoint(session.from, session.to, world);
    session.curve = curve;
    this.place(session);
    this.onPreview(session.edgeId, curve);
  }

  private onPointerUp(): void {
    const session = this.session;
    if (!session) return;
    this.releaseCapture(session.pointerId);
    this.session = null;
    this.stateMachine.escape();
    // ★ 先撤临时几何、再提交、最后重摆：顺序反了的话，提交会触发一次重绘，
    //   而那一刻覆盖表里还是旧的预览值 —— 屏幕上是"松手后线弹回去一下再回来"
    this.onPreviewEnd(session.edgeId);
    this.onCommit(session.edgeId, session.curve);
    // 提交后再按模型重摆一次：模型里的值可能与预览**不完全相同**
    // （`curveFromMidpoint` 做了夹取 + 4 位小数收敛），手柄要落在最终那条线上
    this.sync();
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || !this.session) return;
    // ★ Esc = 撤销这一次拖动（不是提交）：手柄回到按下时的位置，
    //   与"Esc 是万能退出键"（`02 §3` 约定 3）一致
    event.preventDefault();
    this.cancel();
  }

  /** 放弃进行中的拖动：清掉临时几何，让线回到模型里的样子 */
  cancel(): void {
    const session = this.session;
    if (!session) return;
    this.session = null;
    this.releaseCapture(session.pointerId);
    this.onPreviewEnd(session.edgeId);
    this.stateMachine.escape();
    this.sync();
  }

  // ── 摆位 ─────────────────────────────────────────────────

  private place(session: CurveSession): void {
    const path = edgePathPoints(session.from, session.to, session.curve);
    const screen = this.viewport.toScreen(edgePathMidpoint(path));
    this.handle.style.left = `${screen.x}px`;
    this.handle.style.top = `${screen.y}px`;
  }

  private hide(): void {
    if (!this.visible) return;
    this.visible = false;
    this.handle.style.display = 'none';
  }

  private toWorld(event: { clientX: number; clientY: number }): { x: number; y: number } {
    const bounds = this.host.getBoundingClientRect();
    return this.viewport.toWorld({ x: event.clientX - bounds.left, y: event.clientY - bounds.top });
  }

  private releaseCapture(pointerId: number): void {
    if (pointerId < 0) return;
    try {
      if (this.host.hasPointerCapture(pointerId)) this.host.releasePointerCapture(pointerId);
    } catch {
      // 指针已经不存在 —— 无需处理
    }
  }

  private readonly bound: Array<{ type: string; listener: EventListener }> = [];

  private bind(type: string, listener: EventListener): void {
    this.host.addEventListener(type, listener);
    this.bound.push({ type, listener });
  }
}
