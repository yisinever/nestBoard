/**
 * 帧调度器（T2.14）单测。
 *
 * 这里全部用**手工帧驱动**（`FrameDriver`）而不是真的 `requestAnimationFrame`：
 * "一帧只提交一次"这类断言只有在能精确控制"帧什么时候到"时才有意义。
 */

import { describe, expect, it } from 'vitest';
import { FrameQueue, type FrameRequester } from '../../util/frame';

/** 假的"浏览器帧"：记录请求了什么、被取消了什么，由测试决定何时到帧 */
class FrameDriver {
  requested = 0;
  cancelled = 0;
  private entries: Array<{ callback: () => void; live: boolean }> = [];

  readonly request: FrameRequester = (callback) => {
    this.requested += 1;
    const entry = { callback, live: true };
    this.entries.push(entry);
    return () => {
      if (!entry.live) return;
      entry.live = false;
      this.cancelled += 1;
      this.entries = this.entries.filter((item) => item !== entry);
    };
  };

  /** 模拟"新的一帧到了" */
  runFrame(): void {
    const entries = this.entries;
    this.entries = [];
    for (const entry of entries) {
      entry.live = false;
      entry.callback();
    }
  }
}

describe('FrameQueue', () => {
  it('同一任务在一帧内只执行一次，且只请求一帧', () => {
    const driver = new FrameDriver();
    const queue = new FrameQueue(driver.request);
    let runs = 0;
    const task = (): void => {
      runs += 1;
    };

    queue.schedule(task);
    queue.schedule(task);
    queue.schedule(task);

    expect(driver.requested).toBe(1);
    expect(queue.isScheduled).toBe(true);
    expect(queue.size).toBe(1);

    driver.runFrame();
    expect(runs).toBe(1);
    expect(queue.isScheduled).toBe(false);
    expect(queue.size).toBe(0);
  });

  it('不同任务在同一帧内按注册顺序执行', () => {
    const driver = new FrameDriver();
    const queue = new FrameQueue(driver.request);
    const order: string[] = [];

    queue.schedule(() => order.push('camera'));
    queue.schedule(() => order.push('cards'));
    driver.runFrame();

    expect(order).toEqual(['camera', 'cards']);
    expect(driver.requested).toBe(1);
  });

  it('跨帧会重新执行（不是"只跑一次"）', () => {
    const driver = new FrameDriver();
    const queue = new FrameQueue(driver.request);
    let runs = 0;

    queue.schedule(() => {
      runs += 1;
    });
    driver.runFrame();
    queue.schedule(() => {
      runs += 1;
    });
    driver.runFrame();

    expect(runs).toBe(2);
    expect(driver.requested).toBe(2);
  });

  it('flush() 立刻执行并撤掉已排的帧（不会随后再跑一遍）', () => {
    const driver = new FrameDriver();
    const queue = new FrameQueue(driver.request);
    let runs = 0;

    queue.schedule(() => {
      runs += 1;
    });
    queue.flush();

    expect(runs).toBe(1);
    expect(queue.isScheduled).toBe(false);
    expect(driver.cancelled).toBe(1);

    driver.runFrame();
    expect(runs).toBe(1);
  });

  it('flush() 在没有待办时是空操作', () => {
    const driver = new FrameDriver();
    const queue = new FrameQueue(driver.request);

    expect(() => queue.flush()).not.toThrow();
    expect(driver.cancelled).toBe(0);
  });

  it('任务里再排的任务落到下一帧（不在本帧递归展开）', () => {
    const driver = new FrameDriver();
    const queue = new FrameQueue(driver.request);
    const order: string[] = [];

    const follow = (): void => {
      order.push('follow');
    };
    queue.schedule(() => {
      order.push('outer');
      queue.schedule(follow);
    });

    driver.runFrame();
    expect(order).toEqual(['outer']);
    expect(queue.size).toBe(1);
    expect(driver.requested).toBe(2);

    driver.runFrame();
    expect(order).toEqual(['outer', 'follow']);
  });

  it('cancel() 撤掉还没执行的任务', () => {
    const driver = new FrameDriver();
    const queue = new FrameQueue(driver.request);
    let runs = 0;
    const task = (): void => {
      runs += 1;
    };

    queue.schedule(task);
    queue.cancel(task);
    expect(queue.has(task)).toBe(false);
    expect(queue.size).toBe(0);

    driver.runFrame();
    expect(runs).toBe(0);
  });

  it('一个任务抛错不影响同帧的其它任务，错误照旧抛出去', () => {
    const driver = new FrameDriver();
    const queue = new FrameQueue(driver.request);
    let others = 0;

    queue.schedule(() => {
      throw new Error('boom');
    });
    queue.schedule(() => {
      others += 1;
    });

    expect(() => driver.runFrame()).toThrow('boom');
    expect(others).toBe(1);
    expect(queue.size).toBe(0);
  });

  it('抛错后队列仍可继续工作（下一帧照常提交）', () => {
    const driver = new FrameDriver();
    const queue = new FrameQueue(driver.request);
    let runs = 0;

    queue.schedule(() => {
      throw new Error('boom');
    });
    expect(() => driver.runFrame()).toThrow('boom');

    queue.schedule(() => {
      runs += 1;
    });
    driver.runFrame();
    expect(runs).toBe(1);
  });

  it('dispose() 丢弃全部待办任务且不让它们再落地', () => {
    const driver = new FrameDriver();
    const queue = new FrameQueue(driver.request);
    let runs = 0;

    queue.schedule(() => {
      runs += 1;
    });
    queue.dispose();

    expect(queue.isScheduled).toBe(false);
    expect(queue.size).toBe(0);
    driver.runFrame();
    expect(runs).toBe(0);
  });

  it('默认调度器在 node 下也有退路（不依赖 requestAnimationFrame）', () => {
    const queue = new FrameQueue();
    let runs = 0;

    queue.schedule(() => {
      runs += 1;
    });
    // 不等真实定时器：直接 flush 就够证明"排得进、跑得掉"
    queue.flush();
    expect(runs).toBe(1);
  });
});
