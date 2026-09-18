/**
 * 帧调度器（T2.14 / `02 §8.2`「批量写入 rAF 合并」）。
 *
 * 解决的问题：`pointermove` / `wheel` / `dragover` 这些**高频事件流**在真实设备上
 * 一帧能来 2~4 个（120Hz 触控板、游戏鼠标、触摸屏的合成事件），而每次事件都同步跑
 * 一遍"写 world transform + 卡片层同步 + 连线层重绘"是纯浪费 —— 一帧内同一件事
 * 做 N 次，中间 N-1 次的结果用户永远看不到，却照样付出全部代价。
 *
 * ★ 去重按**任务身份**（`===`）而不是按名字/参数：于是"相机变化"这种
 *   "读当前状态再提交"的任务天然幂等 —— 一帧来 5 个 wheel 事件，只提交 1 次，
 *   而且提交时读到的就是**最后一个**事件的最终状态，不会漏掉任何一次变化。
 *
 * ★ 任务里**再调度任务**会落到下一帧：`flush` 先取快照再执行，执行期间新进队的
 *   任务不会在本帧被顺带跑掉（否则一个"改状态→再提交"的任务链会在一帧里递归展开，
 *   帧耗时就不可控了）。
 *
 * ★ 提供 `flush()` 而不只有 `cancel()`：相机状态要落盘（`repository.updateView`），
 *   "关了 Obsidian，最后 16ms 的平移不能丢"和防抖的 `flush()` 是同一条理由（03 §3.2 W5）。
 */

/** 请求一帧；返回取消句柄。测试里替换成手工触发器 */
export type FrameRequester = (callback: () => void) => () => void;

/**
 * 默认调度：优先 `requestAnimationFrame`，退化到 `setTimeout(0)`。
 *
 * ★ 必须有退路：单测跑在 node 下（没有 rAF），而"没有 rAF 就整个不工作"会让
 *   所有依赖本模块的视图代码在测试里静默失效。
 */
const defaultRequester: FrameRequester = (callback) => {
  if (typeof requestAnimationFrame === 'function') {
    const handle = requestAnimationFrame(callback);
    return () => cancelAnimationFrame(handle);
  }
  const handle = setTimeout(callback, 0);
  return () => clearTimeout(handle);
};

export class FrameQueue {
  private readonly tasks = new Set<() => void>();
  private release: (() => void) | null = null;

  constructor(private readonly request: FrameRequester = defaultRequester) {}

  /** 本帧是否已排上（诊断面板用它显示"有没有在抖帧"） */
  get isScheduled(): boolean {
    return this.release !== null;
  }

  /** 待执行任务数（诊断 / 测试用） */
  get size(): number {
    return this.tasks.size;
  }

  has(task: () => void): boolean {
    return this.tasks.has(task);
  }

  /** 把一个任务排进下一帧；同一个函数重复排只会执行一次 */
  schedule(task: () => void): void {
    this.tasks.add(task);
    if (this.release) return;
    this.release = this.request(() => this.flush());
  }

  /** 撤掉一个还没执行的任务（例：拖动被取消，那份预览不必再落地） */
  cancel(task: () => void): void {
    this.tasks.delete(task);
  }

  /**
   * 立刻执行全部待办任务。
   *
   * ★ 快照式：执行期间新排进来的任务留给下一帧。视图销毁前调一次，
   *   保证"最后一帧的状态"已经落地（相机要写文件，见模块注释）。
   *
   * ★ 单个任务抛错**不牵连**同一帧的其它任务（错误照旧往上抛，不做静默吞掉）：
   *   这些任务是"相机提交 / 卡片层同步 / 连线重绘"，一个坏掉不该让另一个不跑 ——
   *   否则表现是"某一层从此再也不更新"，比直接报错难查得多。
   */
  flush(): void {
    this.release?.();
    this.release = null;
    if (this.tasks.size === 0) return;
    const pending = [...this.tasks];
    this.tasks.clear();

    let failure: unknown = null;
    let failed = false;
    for (const task of pending) {
      try {
        task();
      } catch (error) {
        if (!failed) {
          failed = true;
          failure = error;
        }
      }
    }
    if (failed) throw failure instanceof Error ? failure : new Error(String(failure));
  }

  /** 丢弃全部待办任务（视图销毁：此后任何任务都不该再碰已经拆掉的 DOM） */
  dispose(): void {
    this.release?.();
    this.release = null;
    this.tasks.clear();
  }
}
