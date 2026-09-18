/**
 * 长按检测（T3.21 / `02 §3`、`02 §4.3` 的"长按（移动端）→ 弹出卡片上下文菜单"）。
 *
 * 移动端没有右键，卡片菜单只能靠长按唤出。这件事看着简单，但真正的难点是
 * **它和拖动共用同一次 `pointerdown`**：
 *
 *  * 手指按住不动 500ms → 该出菜单；
 *  * 手指按住后挪了 20px → 该拖卡片 / 该滚画布，**绝不能**在拖到一半时弹菜单；
 *  * 手指一按就走（点一下）→ 该选中卡片。
 *
 * 三条出口都挂在同一次按下的生命周期上，散进 `pointerdown / pointermove / pointerup`
 * 三个回调里各写一段 `setTimeout` + 标志位，出问题的表现是"手机上偶尔弹菜单"
 * 这种最难复现、也最难归因的 bug。所以整块收进这个类里。
 *
 * ★ **不碰 DOM、不碰 `Date.now`**：定时函数与清除函数都由调用方注入，
 *   于是"按住 500ms 会触发、中途挪 12px 不触发"可以用假定时器精确断言，
 *   而不必在测试里真等半秒（那会让测试变成 flaky 的时间竞态）。
 */

import type { Point } from '../../util/geometry';

/**
 * 触发长按所需的按住时长。
 *
 * ★ 500ms 是移动端的通行值（iOS 的 `UILongPressGestureRecognizer` 默认 0.5s）。
 *   调短（300ms）会让"想拖卡片的人"频繁误触菜单；调长（800ms）则像没反应。
 */
export const LONG_PRESS_MS = 500;

/**
 * 按住期间允许的抖动范围（像素）。
 *
 * ★ 手指按在屏幕上**必然**有几像素的位移，给 0 会让长按永远触发不了；
 *   而给太大（比如 30px）就分不清"手抖"与"想拖"。10px 大致是
 *   "同一根手指没有移动意图"的边界。
 */
export const LONG_PRESS_MOVE_TOLERANCE_PX = 10;

/** 定时器句柄：`setTimeout` 在 DOM 与 node 下返回的类型不同，这里不关心具体是什么 */
export type TimerHandle = ReturnType<typeof setTimeout>;

export interface LongPressOptions {
  /** 按住多久算长按，默认 {@link LONG_PRESS_MS} */
  delayMs?: number;
  /** 抖动容差（像素），默认 {@link LONG_PRESS_MOVE_TOLERANCE_PX} */
  tolerancePx?: number;
  /** 定时器，默认 `setTimeout`（测试注入假定时器） */
  setTimer?: (handler: () => void, ms: number) => TimerHandle;
  /** 取消定时器，默认 `clearTimeout` */
  clearTimer?: (handle: TimerHandle) => void;
}

/**
 * 一次「按下 → 长按」的检测器。**同一个实例可以反复使用**（每次按下都是 `start`）。
 *
 * 调用方的正确用法：
 * ```ts
 * onPointerDown:  detector.start({ x: e.clientX, y: e.clientY });
 * onPointerMove:  detector.move({ x: e.clientX, y: e.clientY });
 * onPointerUp:    if (detector.cancel()) { /* 没触发过长按 → 当作普通点击 *\/ }
 * ```
 */
export class LongPressDetector {
  private handle: TimerHandle | null = null;
  private origin: Point | null = null;
  /** 本轮按下**是否已经**触发过长按。决定松手时还算不算"一次点击" */
  private fired = false;

  constructor(
    /** 到点后的动作。参数是**按下时**的位置 —— 手指可能已经抖了几像素 */
    private readonly onFire: (point: Point) => void,
    private readonly options: LongPressOptions = {},
  ) {}

  /** 是否有一次按下正在计时（松手 / 移动时用不到，主要给测试与断言看） */
  get isPending(): boolean {
    return this.origin !== null;
  }

  /** 本轮按下是否已经长按触发过（触发之后的那次松手不该再被当成点击） */
  get hasFired(): boolean {
    return this.fired;
  }

  /**
   * 按下，开始计时。
   *
   * 返回 `false` 表示**已经有一次按下在计时**（正常情况下不会发生；真发生了说明
   * 上一次的 `pointerup` 丢了 —— 这时忽略新的按下，比把两个计时器叠起来安全）。
   */
  start(point: Point): boolean {
    if (this.origin) return false;

    this.origin = point;
    this.fired = false;

    const setTimer = this.options.setTimer ?? setTimeout;
    const delay = this.options.delayMs ?? LONG_PRESS_MS;
    this.handle = setTimer(() => {
      const origin = this.origin;
      // ★ 先摘计时器句柄再回调：`onFire` 里可能会弹菜单、可能同步触发别的
      //   `pointerup`，那时 `cancel()` 必须看到一个"已经不在计时"的状态
      this.handle = null;
      if (!origin) return; // 计时期间被取消了
      this.origin = null;
      this.fired = true;
      this.onFire(origin);
    }, delay);

    return true;
  }

  /**
   * 指针移动。超出容差即取消（说明用户想拖 / 想滚，不是在长按）。
   *
   * ★ 用**起点的绝对距离**而不是"逐帧位移累加"：逐帧累加会把手指的来回微抖
   *   一点点攒起来，慢慢挪却不触发取消 —— 而用绝对距离，手指原地画小圈
   *   永远退不出容差圈，正是我们要的。
   */
  move(point: Point): void {
    const origin = this.origin;
    if (!origin) return;
    const distance = Math.hypot(point.x - origin.x, point.y - origin.y);
    const tolerance = this.options.tolerancePx ?? LONG_PRESS_MOVE_TOLERANCE_PX;
    if (distance > tolerance) this.cancel();
  }

  /**
   * 松手 / `pointercancel` / 主动放弃。
   *
   * 返回 `true` 表示**这次按下从未触发过长按** —— 调用方据此决定要不要继续
   * 走"普通点击"的逻辑（选中卡片）。长按已经弹过菜单了，再选中一次只会让
   * 用户觉得"我明明长按了，怎么还顺手把卡片挪了"。
   */
  cancel(): boolean {
    if (this.handle !== null) {
      const clearTimer = this.options.clearTimer ?? clearTimeout;
      clearTimer(this.handle);
      this.handle = null;
    }
    this.origin = null;

    const wasFired = this.fired;
    this.fired = false;
    return !wasFired;
  }

  /** 视图销毁时调一次，别把一个还挂着的定时器留到下一块白板上 */
  dispose(): void {
    this.cancel();
  }
}
