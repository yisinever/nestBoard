/**
 * 画布导航：平移与缩放（T1.19 / T1.20，F1-02 / F1-03 / F1-04）。
 *
 * 手势对照表（02 §4.3）：
 *
 * | 输入                                              | 行为                      |
 * | ------------------------------------------------- | ------------------------- |
 * | 滚轮 / 触控板双指                                  | 平移（⇧ 变水平）          |
 * | ⌘+滚轮 / 触控板捏合（浏览器合成为 `ctrl+wheel`）    | 缩放，**锚定指针**        |
 * | `Space`+拖动 / 中键拖动                            | 平移                      |
 * | 空白处左键拖动（仅演示态，见 `panOnEmptyDrag`）     | 平移                      |
 * | 单指拖动 / 双指捏合                                | 移动端平移 / 缩放         |
 *
 * 三条纪律：
 *
 * 1. **不抢卡片里的输入框**：事件目标是 `input` / `textarea` / `contenteditable` 时直接放行。
 *    否则以后卡片里滚长文、用输入法打字都会被画布吞掉。
 * 2. **不抢其他面板的键盘**：`Space` 只在本视图持有焦点时才接管
 *    （分屏左边是笔记、右边是白板时，按空格必须还是给笔记翻页）。
 * 3. **事件挂在画布容器上，不挂 window**（键盘除外）—— 两块白板分屏互不干扰。
 *
 * ★ 本文件不 import `obsidian`：只用标准 DOM 事件，保持可替换、可测试。
 */

import type { Point } from '../util/geometry';
import type { Viewport } from './Viewport';

export interface NavigationControllerOptions {
  /** 手势表面（画布容器）。需要 CSS `touch-action: none` 配合 */
  host: HTMLElement;
  viewport: Viewport;
  /**
   * 指针底下算不算"空白"（默认：**任何地方都算空白**）。
   *
   * ★ 只有配合 `panOnEmptyDrag` 才有意义：判断"按在一个可拖拽对象上"要用到那个文档类型
   *   自己的 DOM 约定（白板是 `data-card-id`、脑图是节点 id 属性），所以判据由调用方注入。
   *   默认给"全是空白"是刻意的 —— 本模块不猜任何一种文档类型的属性名；
   *   真正需要区分的调用方**必须**显式传进来（传错的后果是"拖着卡片把画布拽走了"）。
   */
  isBackground?: (target: EventTarget | null) => boolean;
  /**
   * **空白处左键拖动**是否也能平移（默认 `false`）。
   *
   * ★ 演示态（J-06）传 `true`：那时框选与拖动卡片都被封住了，空白处左键拖动
   *   本来就是"什么都不做"。把它接成平移，鼠标用户就不必非按住 `Space` ——
   *   而 `Space` 在演示态是"下一步"（`04 §9`），两件事撞在同一根手指上。
   * ★ 只认**空白处**：按在卡片上又拖动，那是"想把卡挪个位置"的意图，
   *   不该把相机拽走。
   */
  panOnEmptyDrag?: () => boolean;
}

/** 中键在部分平台会引起自动滚动，必须拦掉 */
const MIDDLE_BUTTON = 1;

/**
 * 这一次按下要不要开始**拖拽平移**。
 *
 * 抽成纯函数只为能单测：这四种情形（中键 / 触屏 / `Space`+拖动 / 演示态空白拖动）
 * 的优先级很容易在后续改动里被无声地调换，而它们各自都有一批用户的手指头。
 */
export function shouldStartPan(
  input: { button: number; pointerType: string; onBackground: boolean },
  state: { spacePressed: boolean; panOnEmptyDrag: boolean },
): boolean {
  // 中键：在卡片上按也算平移（这是各家画布的通行约定，卡片上没有任何中键功能）
  if (input.button === MIDDLE_BUTTON) return true;
  // 触屏单指：任何位置都是平移（捏合走另一条路）
  if (input.pointerType === 'touch') return true;
  if (input.button !== 0) return false;
  // `Space`+拖动：浏览态里的老习惯，位置不限
  if (state.spacePressed) return true;
  return state.panOnEmptyDrag && input.onBackground;
}

/** 鼠标滚轮一格按 16px 折算（`deltaMode === DOM_DELTA_LINE`） */
const LINE_HEIGHT_PX = 16;

/** 滚轮/捏合 → 缩放倍率的灵敏度：`exp(-delta × k)`，0.0025 下一格滚轮约 ±22% */
const WHEEL_ZOOM_SENSITIVITY = 0.0025;

export class NavigationController {
  private readonly host: HTMLElement;
  private readonly viewport: Viewport;
  private readonly panOnEmptyDrag: (() => boolean) | undefined;
  private readonly isBackground: ((target: EventTarget | null) => boolean) | undefined;
  private readonly disposers: Array<() => void> = [];

  /** 覆盖在 `window` 上的监听器数量（用于 dispose 时的健全性检查） */
  private spacePressed = false;

  private panPointerId: number | null = null;
  private lastPoint: Point | null = null;

  /** 触控指针表：≥2 根手指即进入捏合 */
  private readonly touches = new Map<number, Point>();
  private pinch: { distance: number; mid: Point } | null = null;

  constructor(options: NavigationControllerOptions) {
    this.host = options.host;
    this.viewport = options.viewport;
    this.panOnEmptyDrag = options.panOnEmptyDrag;
    this.isBackground = options.isBackground;

    this.listen(this.host, 'wheel', this.onWheel, { passive: false });
    this.listen(this.host, 'pointerdown', this.onPointerDown);
    this.listen(this.host, 'pointermove', this.onPointerMove);
    this.listen(this.host, 'pointerup', this.onPointerUp);
    this.listen(this.host, 'pointercancel', this.onPointerUp);
    this.listen(this.host, 'lostpointercapture', this.onPointerUp);

    this.listen(window, 'keydown', this.onKeyDown);
    this.listen(window, 'keyup', this.onKeyUp);
    this.listen(window, 'blur', this.onWindowBlur);
  }

  /** 是否正处于拖拽平移中（供上层屏蔽"点击"语义，如 T2 的框选） */
  get isPanning(): boolean {
    return this.panPointerId !== null;
  }

  dispose(): void {
    for (const disposer of this.disposers.splice(0)) disposer();
    this.touches.clear();
    this.pinch = null;
    this.panPointerId = null;
    this.lastPoint = null;
    this.host.classList.remove('is-panning', 'is-pan-ready');
  }

  // ── 事件绑定 ────────────────────────────────────────────

  /**
   * 统一注册并把清理函数存起来。
   * 事件名与回调的具体事件类型由调用方保证对应（`wheel` → `WheelEvent` …），
   * 这里刻意收窄成 `Event`，避免 `addEventListener` 重载推断出成吨的泛型噪音。
   */
  private listen(
    target: EventTarget,
    type: string,
    handler: (event: Event) => void,
    options?: AddEventListenerOptions,
  ): void {
    target.addEventListener(type, handler, options);
    this.disposers.push(() => target.removeEventListener(type, handler, options));
  }

  // ── 滚轮 / 捏合（触控板） ────────────────────────────────

  private readonly onWheel = (event: Event): void => {
    const wheel = event as WheelEvent;
    if (this.isEditableTarget(wheel.target)) return;

    const delta = this.normalizeWheel(wheel);
    // 触控板捏合会被浏览器合成为 `ctrlKey + wheel`，与 ⌘+滚轮 走同一条缩放路径
    if (wheel.ctrlKey || wheel.metaKey) {
      wheel.preventDefault();
      this.viewport.zoomBy(
        Math.exp(-delta.y * WHEEL_ZOOM_SENSITIVITY),
        this.toCanvasPoint(wheel.clientX, wheel.clientY),
      );
      return;
    }

    wheel.preventDefault();
    if (wheel.shiftKey) {
      // ⇧+滚轮 = 水平平移（很多鼠标只有垂直滚轮）
      this.viewport.panBy(-delta.y, 0);
      return;
    }
    this.viewport.panBy(-delta.x, -delta.y);
  };

  /** 把不同 `deltaMode` 折算成像素增量 */
  private normalizeWheel(wheel: WheelEvent): Point {
    const scale =
      wheel.deltaMode === 1
        ? LINE_HEIGHT_PX
        : wheel.deltaMode === 2
          ? Math.max(1, this.host.clientHeight)
          : 1;
    return { x: wheel.deltaX * scale, y: wheel.deltaY * scale };
  }

  // ── 指针拖拽 ────────────────────────────────────────────

  private readonly onPointerDown = (event: Event): void => {
    const pointer = event as PointerEvent;
    if (this.isEditableTarget(pointer.target)) return;

    // 点在画布空白处 → 让画布拿到焦点，这样后续的 Space+拖动才成立。
    // （点在卡片上时不抢焦点，否则以后会打断卡片内的文本编辑）
    if (this.isBackgroundTarget(pointer.target)) {
      this.host.focus({ preventScroll: true });
    }

    if (pointer.pointerType === 'touch') {
      this.touches.set(pointer.pointerId, { x: pointer.clientX, y: pointer.clientY });
      if (this.touches.size >= 2) {
        this.beginPinch(pointer.pointerId);
        return;
      }
    }

    const wantsPan = shouldStartPan(
      {
        button: pointer.button,
        pointerType: pointer.pointerType,
        onBackground: this.isBackgroundTarget(pointer.target),
      },
      {
        spacePressed: this.spacePressed,
        panOnEmptyDrag: this.panOnEmptyDrag?.() ?? false,
      },
    );
    if (!wantsPan) return;

    this.panPointerId = pointer.pointerId;
    this.lastPoint = { x: pointer.clientX, y: pointer.clientY };
    this.host.classList.add('is-panning');
    this.capturePointer(pointer.pointerId);
    // 中键与 Space 拖动必须拦掉默认行为（自动滚动 / 文本选择 / 拖拽）
    pointer.preventDefault();
  };

  private readonly onPointerMove = (event: Event): void => {
    const pointer = event as PointerEvent;

    if (pointer.pointerType === 'touch' && this.touches.has(pointer.pointerId)) {
      this.touches.set(pointer.pointerId, { x: pointer.clientX, y: pointer.clientY });
      if (this.touches.size >= 2) {
        this.updatePinch();
        return;
      }
    }

    if (this.panPointerId !== pointer.pointerId || !this.lastPoint) return;

    const dx = pointer.clientX - this.lastPoint.x;
    const dy = pointer.clientY - this.lastPoint.y;
    this.lastPoint = { x: pointer.clientX, y: pointer.clientY };
    this.viewport.panBy(dx, dy);
  };

  private readonly onPointerUp = (event: Event): void => {
    const pointer = event as PointerEvent;
    this.touches.delete(pointer.pointerId);
    if (this.touches.size < 2) this.pinch = null;

    if (this.panPointerId === pointer.pointerId) {
      this.panPointerId = null;
      this.lastPoint = null;
      this.host.classList.remove('is-panning');
      this.releasePointer(pointer.pointerId);
    }

    // 双指松开一根 → 用剩下那根手指接着平移，手感连续
    const remaining = [...this.touches.entries()][0];
    if (remaining && this.panPointerId === null) {
      this.panPointerId = remaining[0];
      this.lastPoint = remaining[1];
      this.host.classList.add('is-panning');
    }
  };

  // ── 捏合 ────────────────────────────────────────────────

  private beginPinch(pointerId: number): void {
    this.panPointerId = null;
    this.lastPoint = null;
    this.pinch = null;
    this.capturePointer(pointerId);
    this.host.classList.add('is-panning');
  }

  private updatePinch(): void {
    const points = [...this.touches.values()];
    const first = points[0];
    const second = points[1];
    if (!first || !second) return;

    const distance = Math.hypot(second.x - first.x, second.y - first.y);
    const mid = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };

    if (this.pinch) {
      const anchor = this.toCanvasPoint(mid.x, mid.y);
      if (this.pinch.distance > 0 && distance > 0) {
        this.viewport.zoomBy(distance / this.pinch.distance, anchor);
      }
      // 双指整体移动 = 平移
      this.viewport.panBy(mid.x - this.pinch.mid.x, mid.y - this.pinch.mid.y);
    }
    this.pinch = { distance, mid };
  }

  // ── 键盘 ────────────────────────────────────────────────

  private readonly onKeyDown = (event: Event): void => {
    const key = event as KeyboardEvent;
    if (key.key !== ' ' || key.repeat) return;
    if (this.isEditableTarget(key.target)) return;
    // 只在本视图有焦点时接管空格，避免抢掉其他面板/其他白板的空格键
    if (!this.isHostFocused()) return;

    // Obsidian 的空格常被用来滚动预览；画布里不滚动，拦掉以防父容器被滚
    key.preventDefault();
    this.spacePressed = true;
    this.host.classList.add('is-pan-ready');
  };

  private readonly onKeyUp = (event: Event): void => {
    const key = event as KeyboardEvent;
    if (key.key !== ' ') return;
    this.spacePressed = false;
    this.host.classList.remove('is-pan-ready');
  };

  private readonly onWindowBlur = (): void => {
    this.spacePressed = false;
    this.pinch = null;
    this.touches.clear();
    this.host.classList.remove('is-pan-ready');
  };

  // ── 小工具 ──────────────────────────────────────────────

  /** 屏幕坐标（window）→ 画布坐标（容器左上角为原点） */
  private toCanvasPoint(clientX: number, clientY: number): Point {
    const rect = this.host.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  }

  private isEditableTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    if (target.isContentEditable) return true;
    const tag = target.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  }

  /**
   * 点的是画布空白（而不是可拖拽的对象）。
   *
   * ★ 判据由调用方注入（见 `NavigationControllerOptions.isBackground`）：白板传它自己的
   *   `HitTest`（卡片 id 属性名只有一个来源），脑图现在传"任何地方都算空白"
   *   （P3 起节点可拖时再换成它自己的属性）。
   */
  private isBackgroundTarget(target: EventTarget | null): boolean {
    return (this.isBackground ?? ((): boolean => true))(target);
  }

  private isHostFocused(): boolean {
    const active = document.activeElement;
    if (!active) return false;
    return active === this.host || this.host.contains(active);
  }

  private capturePointer(pointerId: number): void {
    try {
      this.host.setPointerCapture(pointerId);
    } catch {
      // 指针已经消失（例如触摸被系统打断）：不影响后续交互
    }
  }

  private releasePointer(pointerId: number): void {
    try {
      this.host.releasePointerCapture(pointerId);
    } catch {
      // 同上：未持有捕获时 release 会抛，忽略
    }
  }
}
