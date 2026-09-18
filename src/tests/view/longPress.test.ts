/**
 * 长按检测（T3.21 / `02 §3`、`02 §4.3`）。
 *
 * 这块逻辑真正的难点是**它和拖动共用同一次按下**：
 *  * 按住不动 500ms → 出菜单；
 *  * 按住后挪了十几像素 → 是拖卡片，绝不能在中途弹菜单；
 *  * 一按就走 → 是点击选中。
 *
 * ★ 用注入的假定时器而不是 `vi.useFakeTimers()`：本类**不认识时间**，
 *   它只认识"到点了"这个回调。假定时器让我们把"按住 500ms"写成一次显式调用，
 *   测试因此不依赖真实时钟，也不会因为 CI 机器忙而偶发失败。
 */

import { describe, expect, it } from 'vitest';

import {
  LONG_PRESS_MOVE_TOLERANCE_PX,
  LongPressDetector,
  type TimerHandle,
} from '../../view/interact/longPress';

/** 手动可控的定时器：`fire()` 就是把"时间到了"这件事显式说出来 */
function manualTimer() {
  let pending: (() => void) | null = null;
  let cleared = 0;
  return {
    setTimer: (handler: () => void): TimerHandle => {
      pending = handler;
      return 0 as unknown as TimerHandle;
    },
    clearTimer: (): void => {
      cleared += 1;
      pending = null;
    },
    fire: (): void => {
      const handler = pending;
      pending = null;
      handler?.();
    },
    get hasPending(): boolean {
      return pending !== null;
    },
    get clearedCount(): number {
      return cleared;
    },
  };
}

/** 组装一个"记下每次触发"的检测器 */
function setup(options: { delayMs?: number; tolerancePx?: number } = {}) {
  const timer = manualTimer();
  const fired: { x: number; y: number }[] = [];
  const detector = new LongPressDetector((point) => fired.push(point), {
    ...options,
    setTimer: timer.setTimer,
    clearTimer: timer.clearTimer,
  });
  return { detector, timer, fired };
}

describe('LongPressDetector', () => {
  it('按住到点即触发，参数是**按下时**的位置', () => {
    const { detector, timer, fired } = setup();
    detector.start({ x: 10, y: 20 });
    expect(fired).toEqual([]); // 还没到点，什么都不该发生

    timer.fire();
    // ★ 传的是按下时的坐标而不是"抬手时手指在哪"：手指总会抖几像素，
    //   用后者会让菜单长在一个用户没指着的位置（甚至另一张卡上）
    expect(fired).toEqual([{ x: 10, y: 20 }]);
    expect(detector.hasFired).toBe(true);
    expect(detector.isPending).toBe(false);
  });

  it('挪出容差即作废（那是拖动，不是长按）', () => {
    const { detector, timer, fired } = setup();
    detector.start({ x: 0, y: 0 });
    detector.move({ x: LONG_PRESS_MOVE_TOLERANCE_PX + 1, y: 0 });

    expect(detector.isPending).toBe(false);
    timer.fire(); // 即使定时器仍然"到点"了，也不该触发
    expect(fired).toEqual([]);
    expect(timer.clearedCount).toBeGreaterThan(0);
  });

  it('容差内的抖动不算移动（手指搭在屏幕上必然有几像素位移）', () => {
    const { detector, timer, fired } = setup();
    detector.start({ x: 0, y: 0 });
    detector.move({ x: LONG_PRESS_MOVE_TOLERANCE_PX, y: 0 });
    detector.move({ x: 0, y: LONG_PRESS_MOVE_TOLERANCE_PX });

    timer.fire();
    expect(fired).toHaveLength(1);
  });

  it('来回微抖不会被攒成"移动了"', () => {
    // ★ 这条钉的是"用起点绝对距离、而不是逐帧位移累加"那个选择：
    //   逐帧累加的话，手指原地画小圈会一点点攒出超限的距离，
    //   于是长按永远触发不了 —— 而用户明明一寸都没挪。
    const { detector, timer, fired } = setup();
    detector.start({ x: 0, y: 0 });
    for (let i = 0; i < 50; i += 1) detector.move({ x: i % 2 === 0 ? 8 : -8, y: 0 });

    timer.fire();
    expect(fired).toHaveLength(1);
  });

  it('松手取消后返回 true（那是一次普通点击）', () => {
    const { detector, timer } = setup();
    detector.start({ x: 0, y: 0 });
    expect(detector.cancel()).toBe(true);
    expect(detector.isPending).toBe(false);

    timer.fire();
    expect(detector.hasFired).toBe(false);
  });

  it('长按已经触发过，再松手返回 false（不该顺手再选中一次）', () => {
    const { detector, timer } = setup();
    detector.start({ x: 0, y: 0 });
    timer.fire();

    // 用户看到菜单弹出来之后手指还按着，紧接着就是这次 pointerup
    expect(detector.cancel()).toBe(false);
  });

  it('还没按下时 cancel / move 都是安全的空操作', () => {
    const { detector } = setup();
    expect(detector.cancel()).toBe(true);
    expect(() => detector.move({ x: 5, y: 5 })).not.toThrow();
  });

  it('上一次的 pointerup 丢了时，新的按下不会被叠起来', () => {
    const { detector, timer, fired } = setup();
    expect(detector.start({ x: 0, y: 0 })).toBe(true);
    // 第二次按下被拒 → 只有一个计时器，到点也只触发一次
    expect(detector.start({ x: 99, y: 99 })).toBe(false);

    timer.fire();
    expect(fired).toEqual([{ x: 0, y: 0 }]);
  });

  it('触发之后可以立刻再来一次（同一个实例反复用）', () => {
    const { detector, timer, fired } = setup();
    detector.start({ x: 1, y: 1 });
    timer.fire();
    detector.cancel();

    detector.start({ x: 2, y: 2 });
    timer.fire();
    expect(fired).toEqual([
      { x: 1, y: 1 },
      { x: 2, y: 2 },
    ]);
  });

  it('dispose 会清掉还挂着的定时器', () => {
    const { detector, timer, fired } = setup();
    detector.start({ x: 0, y: 0 });
    detector.dispose();

    // ★ 视图销毁时不清定时器，表现是"切到别的白板之后，上一个视图的
    //   长按回调还会在 500ms 后跑一次" —— 弹出的是别人的菜单。
    expect(timer.clearedCount).toBeGreaterThan(0);
    timer.fire();
    expect(fired).toEqual([]);
  });
});
