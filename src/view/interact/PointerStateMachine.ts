/**
 * 指针交互状态机（T1.29）—— `02 §3`。
 *
 * 画布**永远处于且仅处于**四个状态之一：
 *
 * ```
 *            ┌──────────────┐  点卡片/双击   ┌──────────┐
 *            │              │ ─────────────▶ │ EDITING  │
 *      Esc   │     IDLE     │ ◀───────────── │ 编辑内容 │
 *     ◀──────│  浏览 / 选择  │    Esc/点空白   └──────────┘
 *            └──────┬───────┘
 *      按 D / 点画笔 │  ／ 拖锚点·拖工具栏
 *                   ▼
 *          ┌──────────┐   ┌────────────┐
 *          │   INK    │   │ CONNECTING │
 *          └────┬─────┘   └─────┬──────┘
 *            Esc/V │           │ Esc/落点
 *                  └─────┬─────┘
 *                        ▼ 回 IDLE
 * ```
 *
 * 三条关键约定（`02 §3`「关键约定」，也是本文件存在的全部理由）：
 *  1. **EDITING 不锁定画布**：编辑态下 `Space`+拖动、滚轮缩放照常生效 ——
 *     所以"编辑中"不能靠禁用画布手势实现，只能靠状态机放行；
 *  2. **只有 EDITING 拦截键盘**：其余状态按键全部放行给 Obsidian 热键系统，
 *     免得一个插件把用户的 `⌘/Ctrl` 快捷键全吃掉；
 *  3. **Esc 是万能退出键**：任何非 IDLE 状态按 `Esc` 都回 IDLE。
 *
 * ★ 状态图是**星形**（IDLE 居中），不存在 `EDITING → INK` 之类的直连。
 *   理由：编辑态下按键都进了输入框（约定 2），根本没法触发别的状态；
 *   强行允许直连会出现"卡片还在编辑，人已经进了手绘态"的鬼状态。
 *
 * ★ 纯逻辑、不 import `obsidian`、不碰 DOM —— 可在 node 下单测。
 */

export type PointerMode = 'IDLE' | 'EDITING' | 'INK' | 'CONNECTING';

export interface PointerModeChange {
  from: PointerMode;
  to: PointerMode;
}

/** 转移合法性：同态幂等；否则必须**有一端是 IDLE**（星形图） */
export function isPointerTransitionAllowed(from: PointerMode, to: PointerMode): boolean {
  if (from === to) return true;
  return from === 'IDLE' || to === 'IDLE';
}

export class PointerStateMachine {
  private mode: PointerMode = 'IDLE';
  private readonly listeners = new Set<(change: PointerModeChange) => void>();

  get current(): PointerMode {
    return this.mode;
  }

  is(mode: PointerMode): boolean {
    return this.mode === mode;
  }

  get isEditing(): boolean {
    return this.mode === 'EDITING';
  }

  /**
   * 是否由本视图拦截键盘。**只有** EDITING 为真（约定 2）。
   * 控制器拿它决定 keydown 里要不要 `preventDefault()` / `stopPropagation()`。
   */
  get capturesKeyboard(): boolean {
    return this.mode === 'EDITING';
  }

  canEnter(mode: PointerMode): boolean {
    return isPointerTransitionAllowed(this.mode, mode);
  }

  /**
   * 请求进入某状态。非法转移**被拒绝并返回 `false`**（不做隐式中转）。
   *
   * 不做隐式中转是刻意的：`EDITING → INK` 被拒绝时，调用方（命令层）应该先
   * 提交编辑再进手绘，而不是让状态机偷偷替它决定"要不要保存"。
   */
  request(mode: PointerMode): boolean {
    if (!this.canEnter(mode)) return false;
    return this.transition(mode);
  }

  /** Esc 万能退出：任何非 IDLE 状态回 IDLE。已在 IDLE 时返回 `false`（不白吃这个键） */
  escape(): boolean {
    return this.transition('IDLE');
  }

  /**
   * 分发一个按键。返回 `true` 表示本视图**消费**了它（调用方应 `preventDefault()`）。
   *
   * 三条规则，对应 `02 §4.2`「仅 EDITING 态接管文本键」：
   *
   * * **EDITING 一律不消费**。听起来反直觉，但 `preventDefault()` 会让输入框
   *   真的打不出字 —— 编辑态的"拦截"指的是 *keydown 归编辑器*，不是"画布吃掉它"。
   *   画布相关的命令（⌘A / ⌘⇧↑↓）由命令层查 `capturesKeyboard` 主动让路。
   * * **`Esc` 消费，且仅当状态真的变了**。IDLE 下按 Esc 照常放行给 Obsidian，
   *   不能因为插件把系统级的 Esc 变成哑键。
   * * **其余按键一律放行**。`D` / `V` / `⌘A` / `⌘⇧↑` 全都注册成 Obsidian 命令，
   *   用户能在 设置 → 热键 里改绑；插件硬编码按键就等于剥夺了这项能力。
   */
  handleKey(key: string): boolean {
    if (this.capturesKeyboard) return false;
    if (key === 'Escape') return this.escape();
    return false;
  }

  /** 订阅状态变化，返回退订函数 */
  onChange(listener: (change: PointerModeChange) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose(): void {
    this.listeners.clear();
    this.mode = 'IDLE';
  }

  private transition(to: PointerMode): boolean {
    const from = this.mode;
    if (from === to) return false;
    this.mode = to;
    // 复制一份再派发：监听里退订/新增不能影响本轮遍历
    for (const listener of [...this.listeners]) listener({ from, to });
    return true;
  }
}
