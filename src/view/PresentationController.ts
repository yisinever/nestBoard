/**
 * 演示模式的**视图控制器**（J-06）：进出、步骤导航、相机飞行、当前卡高亮。
 *
 * ★ 顺序规则与相机数学都不在这里：前者在 `model/presentation.ts`（谁在第几步），
 *   后者在 `view/presentCamera.ts`（飞到哪里、怎么插值）。本文件只做**编排与 DOM**
 *   —— 它把"下一步是哪张卡"翻译成"把视口飞过去 + 给它打个 class"。
 *   这样最容易出错的两块数学都能在 node 下单测，而不必搭一套假 DOM。
 *
 * ★ 依赖方向：`view/` → `model/` 是允许的（03 §7.2 只禁 `model/` 反过来依赖视图）。
 *   宿主能力通过 {@link PresentationHost} 窄接口注入，控制器不认识 `BoardView` 内部。
 *
 * ★ 「不可编辑」不是在这里实现的：控制器只声明 `active`，由 `BoardView` 在
 *   指针 / 键盘 / 右键这些**入口**上早退。把拦截散在控制器里会漏（新加一个入口
 *   就想不起来），而集中在一个 `if (this.presentation?.active)` 上一眼能查完。
 */

import { Notice, setIcon } from 'obsidian';
import { CARD_ID_ATTR, MIND_CONTAINER_ID_ATTR } from '../constants';
import type { BoardFile, Card, Mind } from '../model/schema';
import {
  clampStepIndex,
  nextStepIndex,
  presentationOrder,
  previousStepIndex,
  stepIndexFromDigit,
} from '../model/presentation';
import type { PresentTarget } from '../model/presentation';
import type { Rect } from '../util/geometry';
import { t } from '../util/i18n';
import {
  PRESENT_DURATION_MS,
  easeInOutCubic,
  interpolateViewport,
  presentTargetViewport,
  viewportSettled,
} from './presentCamera';
import type { Viewport, ViewportState } from '../canvas/Viewport';

/** 演示态挂在画布容器上的 class（`styles.css` 靠它隐藏工具栏、淡化非焦点卡） */
export const PRESENTING_CLASS = 'is-presenting';

/** 当前正在讲的那张卡（`styles.css` 靠它描边高亮，并淡化其余卡片） */
export const PRESENT_STEP_CLASS = 'is-present-step';

/** 步骤条 / 按钮的 class（也在 `styles.css` 里） */
const BAR_CLASS = 'nestboard-present-bar';
const BAR_BUTTON_CLASS = 'nestboard-present-btn';
const BAR_COUNT_CLASS = 'nestboard-present-count';

/** 宿主（`BoardView`）需要提供的最小能力集 */
export interface PresentationHost {
  /** 画布容器：演示态 class 与步骤条都挂在它下面 */
  readonly containerEl: HTMLElement;
  /** 卡片层所在的画布元素（找当前卡那张 DOM 用）；视图未挂载时为 `null` */
  readonly canvasEl: HTMLElement | null;
  readonly viewport: Viewport;
  board(): BoardFile | null;
  /** 卡片在屏幕上的**视觉**矩形（含栏内滚动偏移，T2.03） */
  visualRectOf(card: Card): Rect;
  /**
   * 一棵脑图取景用的矩形（`2.2.0` 收尾 · 演示对接）—— **世界坐标**：
   * 与 `visualRectOf` 同一套单位（相机自己算 `screen = world × zoom + offset`，
   * 见 `presentTargetViewport`）。缺省 = 本视图不认脑图几何（老调用方 / 测试）
   * ⇒ 讲到脑图那一步**不飞相机**，其余照常。
   */
  mindVisualRect?(mind: Mind): Rect | null;
  clearSelection(): void;
  /** 适应全部内容（`O` 总览复用画布已有的那套） */
  fitContent(): void;
  focusCanvas(): void;
  /**
   * 收掉"正在编辑 / 正在画"这两个临时态（可选能力）。
   *
   * ★ 演示的硬性约束是"不可编辑"（`02 §9`），而演示态关掉的全是**入口**：
   *   编辑器或手绘层要是**已经开着**，入口虽灰，那个已经在跑的东西照样收字 / 收笔画。
   * ★ 必须在本类**读内容算顺序之前**调用 —— 退出编辑会提交内容（板子对象换新），
   *   顺序若在那之前算好，列表里握着的是提交前的旧卡片对象。
   */
  exitTransientModes?(): void;

  /** 演示态变化（进入 / 退出）后通知视图刷新命令可用性 */
  onStateChange?(): void;
}

/** 演示态下是否尊重系统的"减少动态效果"（开启时不飞，直接切） */
function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

export class PresentationController {
  private activeState = false;
  private order: PresentTarget[] = [];
  private currentId: string | null = null;
  private barEl: HTMLElement | null = null;
  private countEl: HTMLElement | null = null;
  private frame: number | null = null;
  private readonly reduceMotion = prefersReducedMotion();

  constructor(private readonly host: PresentationHost) {}

  get active(): boolean {
    return this.activeState;
  }

  get total(): number {
    return this.order.length;
  }

  /** 当前步骤下标（`0` 起）；不在演示态时为 `-1` */
  get index(): number {
    if (!this.activeState || this.currentId === null) return -1;
    const index = this.order.findIndex((item) => item.id === this.currentId);
    return index >= 0 ? index : 0;
  }

  /** 当前正在讲的那一步（卡或脑图） */
  get currentTarget(): PresentTarget | null {
    const index = this.index;
    return index >= 0 ? (this.order[index] ?? null) : null;
  }

  /**
   * 进入演示。
   *
   * ★ 一张卡都没有时不进：进了就是一个"空的演示"—— 按 → 没反应、步骤条写 `0 / 0`，
   *   用户只会以为功能坏了。直接用 Notice 说清"这块板还没有卡片"。
   */
  start(): void {
    if (this.activeState) return;
    // ★ 先收临时态、**再**读内容算顺序：退出编辑会提交内容（板子对象换新），
    //   顺序若在提交前算好，`order` 里握着的是旧卡片对象（见 `exitTransientModes` 注释）
    this.host.exitTransientModes?.();
    const board = this.host.board();
    const order = board ? presentationOrder(board) : [];
    if (order.length === 0) {
      new Notice(t('notice.presentEmpty'));
      return;
    }

    this.activeState = true;
    this.order = order;
    this.currentId = order[0].id;
    this.host.clearSelection();
    this.host.containerEl.classList.add(PRESENTING_CLASS);
    this.buildBar();
    this.render();
    this.host.focusCanvas();
    this.host.onStateChange?.();
  }

  /** 退出演示。**不动视口**：讲完就地停在原处，比"啪地弹回原视口"自然 */
  stop(): void {
    if (!this.activeState) return;
    this.activeState = false;
    this.cancelFlight();
    this.host.containerEl.classList.remove(PRESENTING_CLASS);
    this.barEl?.remove();
    this.barEl = null;
    this.countEl = null;
    this.clearHighlight();
    this.host.onStateChange?.();
  }

  /**
   * 板子内容变了（删卡 / 撤销 / 外部改文件）：重算顺序并**停在当前那张**。
   *
   * ★ 内容变了**默认不重新飞相机**：外部改动、撤销、甚至"讲的时候顺手勾掉一条待办"
   *   都会走这条路。每次都重飞会把用户刚手动推到的位置顶回去 ——
   *   而只有"当前那张被删了"才真的必须飞（相机正对着一块空地）。
   */
  refresh(): void {
    if (!this.activeState) return;
    const board = this.host.board();
    const order = board ? presentationOrder(board) : [];
    if (order.length === 0) {
      this.stop();
      return;
    }

    const previousIndex = Math.max(0, this.index);
    const keptIndex = order.findIndex((item) => item.id === this.currentId);
    this.order = order;
    // 当前那张还在就留在它身上；被删了就落到**同一位置**的那张（不回第一张）
    this.currentId =
      order[keptIndex >= 0 ? keptIndex : clampStepIndex(previousIndex, order.length)].id;

    this.updateBar();
    if (keptIndex >= 0) {
      this.syncHighlight();
      return;
    }
    this.render();
  }

  next(): void {
    if (!this.activeState) return;
    this.goto(nextStepIndex(this.index, this.order.length));
  }

  previous(): void {
    if (!this.activeState) return;
    this.goto(previousStepIndex(this.index, this.order.length));
  }

  /** 跳到某一步并聚焦它 */
  goto(index: number): void {
    if (!this.activeState) return;
    const target = this.order[clampStepIndex(index, this.order.length)];
    if (!target) return;
    this.currentId = target.id;
    this.render();
  }

  /** `O`：总览整块板（再按 → 会重新聚焦下一步） */
  overview(): void {
    if (!this.activeState) return;
    this.cancelFlight();
    this.host.fitContent();
  }

  /**
   * 画布键盘入口。返回 `true` = 这次按键归演示管（调用方不要再处理）。
   *
   * ★ `⌘⇧P` 切换放在最前：**退出**也走这条路。否则演示态里再按一次 `⌘⇧P`
   *   会落进"编辑键一律失效"的分支，用户只能去摸 Esc。
   * ★ 演示态下带 `⌘` / `⌥` 的组合键一律放行（返回 `false`）：缩放、切换标签页、
   *   命令面板都得能用 —— 演示不是"锁死应用"。
   */
  handleKey(event: KeyboardEvent): boolean {
    const modified = event.metaKey || event.ctrlKey;
    if (modified && event.shiftKey && event.key.toLowerCase() === 'p') {
      this.consume(event);
      if (this.activeState) this.stop();
      else this.start();
      return true;
    }

    if (!this.activeState) return false;
    if (modified || event.altKey) return false;

    switch (event.key) {
      case 'ArrowRight':
      case 'PageDown':
      case ' ':
        this.consume(event);
        this.next();
        return true;
      case 'ArrowLeft':
      case 'PageUp':
      case 'Backspace':
        this.consume(event);
        this.previous();
        return true;
      case 'Home':
        this.consume(event);
        this.goto(0);
        return true;
      case 'End':
        this.consume(event);
        this.goto(this.order.length - 1);
        return true;
      case 'o':
      case 'O':
        this.consume(event);
        this.overview();
        return true;
      case 'Escape':
        this.consume(event);
        this.stop();
        return true;
      default:
        break;
    }

    const digit = stepIndexFromDigit(event.key, this.order.length);
    if (digit !== null) {
      this.consume(event);
      this.goto(digit);
      return true;
    }
    return false;
  }

  /**
   * 重新给当前卡打高亮。
   *
   * ★ 必须由 `BoardView` 在**每帧渲染之后**调用：卡片层是池化的（视口外的卡会被
   *   拆掉、复用到新卡上），只在自己切步时打一次 class，下一次平移就会把它弄丢。
   */
  syncHighlight(): void {
    const canvas = this.host.canvasEl;
    if (!canvas) return;
    for (const el of canvas.querySelectorAll(`.${PRESENT_STEP_CLASS}`)) {
      el.classList.remove(PRESENT_STEP_CLASS);
    }
    if (!this.activeState || this.currentId === null) return;
    // 卡片与脑图容器各查一次（两类元素的 id 属性名不同；它们是互斥的，谁在就是谁）
    const el =
      canvas.querySelector<HTMLElement>(`[${CARD_ID_ATTR}="${this.currentId}"]`) ??
      canvas.querySelector<HTMLElement>(`[${MIND_CONTAINER_ID_ATTR}="${this.currentId}"]`);
    el?.classList.add(PRESENT_STEP_CLASS);
  }

  dispose(): void {
    this.cancelFlight();
    if (this.activeState) {
      this.activeState = false;
      this.host.containerEl.classList.remove(PRESENTING_CLASS);
      this.barEl?.remove();
      this.barEl = null;
    }
  }

  // ── 内部 ──────────────────────────────────────────────

  private render(): void {
    this.updateBar();
    this.syncHighlight();
    this.flyToCurrent();
  }

  private buildBar(): void {
    const bar = this.host.containerEl.createDiv({ cls: BAR_CLASS });
    bar.setAttribute('role', 'group');
    bar.setAttribute('aria-label', t('present.bar.label'));
    // 步骤条是**界面**：拦下指针，否则点按钮会先被画布拿去当平移手势
    bar.addEventListener('pointerdown', (event) => event.stopPropagation());
    bar.addEventListener('contextmenu', (event) => event.stopPropagation());
    // ★ 键盘也要在这里再接一份：卡片与画布的 `keydown` 挂在 canvas 上，而步骤条是
    //   canvas 的**兄弟**节点（都在视图根下），事件不会冒泡过去。不接这一份的话，
    //   用户点过一次"下一步"按钮之后焦点就留在按钮上 —— 此后 `→` / `Esc` 全部失效
    //   （而空格还会被按钮吃掉，变成又一次"下一步"）。
    bar.addEventListener('keydown', (event) => {
      this.handleKey(event as KeyboardEvent);
    });

    const addButton = (
      icon: string,
      labelKey: Parameters<typeof t>[0],
      action: () => void,
      cls = '',
    ) => {
      const button = bar.createEl('button', {
        cls: `${BAR_BUTTON_CLASS} ${cls}`.trim(),
        attr: { type: 'button', 'aria-label': t(labelKey) },
      });
      setIcon(button, icon);
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        action();
      });
      return button;
    };

    addButton('chevron-left', 'present.bar.previous', () => this.previous());
    this.countEl = bar.createDiv({ cls: BAR_COUNT_CLASS });
    // 读屏用户切步时会被念出"第 3 步，共 8 步"，不必靠 DOM 焦点变化去猜
    this.countEl.setAttribute('aria-live', 'polite');
    addButton('chevron-right', 'present.bar.next', () => this.next());
    addButton('maximize', 'present.bar.overview', () => this.overview());
    addButton('x', 'present.bar.exit', () => this.stop(), 'is-exit');

    this.barEl = bar;
  }

  private updateBar(): void {
    if (!this.countEl) return;
    const index = this.index;
    this.countEl.setText(t('present.bar.count', { current: index + 1, total: this.order.length }));
    const bar = this.barEl;
    if (!bar) return;
    const [previous, next] = bar.querySelectorAll<HTMLButtonElement>(`.${BAR_BUTTON_CLASS}`);
    if (previous) previous.disabled = index <= 0;
    if (next) next.disabled = index >= this.order.length - 1;
  }

  private flyToCurrent(): void {
    const current = this.currentTarget;
    if (!current) return;
    // ★ 脑图（`2.2.0` 收尾）：几何问宿主（它拿得到 `MindLayer` 那份"整棵树的外接框"）；
    //   取不到（那份 `.nestmind` 还没读到）就不飞 —— 停在上一步，比飞去一块空地看着强
    const rect =
      current.kind === 'card'
        ? this.host.visualRectOf(current.card)
        : (this.host.mindVisualRect?.(current.mind) ?? null);
    if (!rect) return;
    const target = presentTargetViewport(rect, {
      width: this.host.viewport.width,
      height: this.host.viewport.height,
    });
    if (!target) return;
    this.flyTo(target);
  }

  private flyTo(target: ViewportState): void {
    const viewport = this.host.viewport;
    if (this.reduceMotion) {
      this.cancelFlight();
      viewport.applyState(target);
      return;
    }

    this.cancelFlight();
    const from: ViewportState = { x: viewport.x, y: viewport.y, zoom: viewport.zoom };
    const start = performance.now();

    const step = (now: number) => {
      const progress = Math.min(1, (now - start) / PRESENT_DURATION_MS);
      viewport.applyState(interpolateViewport(from, target, easeInOutCubic(progress)));
      if (progress < 1 && !viewportSettled(viewport.toState(), target)) {
        this.frame = window.requestAnimationFrame(step);
        return;
      }
      // 收尾一帧：插值总会有最后一点误差，停在"差 0.3px"上不如对齐
      this.frame = null;
      viewport.applyState(target);
    };

    this.frame = window.requestAnimationFrame(step);
  }

  /** 用户一动指针就停飞（否则动画会和手动平移抢两下，画面像在打架） */
  cancelFlight(): void {
    if (this.frame === null) return;
    window.cancelAnimationFrame(this.frame);
    this.frame = null;
  }

  private clearHighlight(): void {
    const canvas = this.host.canvasEl;
    if (!canvas) return;
    for (const el of canvas.querySelectorAll(`.${PRESENT_STEP_CLASS}`)) {
      el.classList.remove(PRESENT_STEP_CLASS);
    }
  }

  private consume(event: KeyboardEvent): void {
    event.preventDefault();
    event.stopPropagation();
  }
}
