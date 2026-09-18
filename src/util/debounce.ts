/**
 * 防抖工具（T1.11 / T1.12 依赖）。
 *
 * 必须支持 `flush()` —— 因为「关了 Obsidian 最后 400ms 的编辑不能丢」（03 §3.2 W5）。
 */

export interface Debounced {
  (): void;
  /** 立即执行待触发的调用（若没有待触发则什么都不做） */
  flush(): void;
  /** 丢弃待触发的调用 */
  cancel(): void;
  isPending(): boolean;
}

export function debounce(fn: () => void, waitMs: number): Debounced {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const invoke = (): void => {
    timer = null;
    fn();
  };

  const debounced = ((): void => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(invoke, waitMs);
  }) as Debounced;

  debounced.cancel = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  debounced.flush = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      invoke();
    }
  };

  debounced.isPending = (): boolean => timer !== null;

  return debounced;
}
