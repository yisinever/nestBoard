/**
 * 脑图画布的键位判据（`06 §4.1`）—— **纯函数**：给一个键盘事件，回答"该做什么"。
 *
 * ★ 抽成纯函数的两个理由：
 *   ① `Tab` / `Enter` / `Shift+Tab` / `F2` / `Space` / `Delete` / 方向键的语义全靠这一段，
 *      夹在一个 `switch` 里既测不到、也容易在两处写成两套；
 *   ② 视图那边只剩下"动作 → 调哪个函数"，读起来就是一张键位表。
 * ★ 这里**只认键**，不看焦点：调用方保证"正在改标题 / 焦点在输入框里"时不会走到这里
 *   （那时键位归输入框自己，见 `titleEditKeyOf`）。
 */

/** 画布键位读得到的字段（写成最小接口：测试里给一个字面量对象就够） */
export interface MindKeyEvent {
  key: string;
  shiftKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
}

export type MindKeyAction =
  | { kind: 'add-child' }
  | { kind: 'add-sibling' }
  | { kind: 'promote' }
  | { kind: 'edit-title' }
  | { kind: 'delete' }
  | { kind: 'toggle-collapse' }
  | { kind: 'toggle-guides' }
  /** 进入当前主题（`⌘]`，`D1`）—— 视图把它当作新的根重排这一支 */
  | { kind: 'focus-in' }
  /** 返回上一层（`⌘[`，`D1`） */
  | { kind: 'focus-out' }
  | { kind: 'move'; direction: 'up' | 'down' | 'left' | 'right' }
  | { kind: 'none' };

/**
 * 画布上的键位。
 *
 * ★ 带 `⌘` / `Ctrl` / `Alt` 的组合**一律不接**：撤销重做归命令表（`⌘Z` / `⌘⇧Z`），
 *   复制剪切粘贴归**窗口捕获阶段**那一道（`MindView.onWindowKeyDown` —— 它不要求焦点在
 *   画布上，画布这道拦不住的那种情况由它兜）。在这里再拦一道的话，同一次按键会被处理两遍
 *   （白板那边为 `⌘Enter` / `⌘U` 踩过同一个坑）。
 * ★ `Shift+Tab` 要**先于** `Tab` 判（`key` 都是 `Tab`，差别只在修饰键）。
 * ★ `Shift+Enter` 目前也是"加兄弟"：脑图里没有换行语义（标题是一行）。
 */
export function mindKeyActionOf(event: MindKeyEvent): MindKeyAction {
  // ★★ 聚焦两键（`D1`，用户 2026-09-18："树视图也支持进入当前主题"）：
  //   幕布的 `⌘]` 进入当前主题 / `⌘[` 返回上一级 —— 与**大纲**那两条键一致
  //   （`outlineKeys.ts` 里同一对）。从前只有大纲接了，于是"同样的两键在树视图里没反应"。
  // ★ 必须排在下面那道"带 `⌘` / `Alt` 的一律不接"的闸门**之前**：它们本身就是带修饰键的。
  //   只放行"没有 `Alt`、没有 `Shift`"的那一档，免得把 `⌘⇧[` 之类别人的组合也吞了。
  if (
    (event.metaKey === true || event.ctrlKey === true) &&
    event.altKey !== true &&
    event.shiftKey !== true
  ) {
    if (event.key === ']') return { kind: 'focus-in' };
    if (event.key === '[') return { kind: 'focus-out' };
  }

  if (event.metaKey === true || event.ctrlKey === true || event.altKey === true) {
    return { kind: 'none' };
  }

  switch (event.key) {
    case 'Tab':
      return event.shiftKey === true ? { kind: 'promote' } : { kind: 'add-child' };
    case 'Enter':
      return { kind: 'add-sibling' };
    case 'F2':
      return { kind: 'edit-title' };
    case 'Delete':
    case 'Backspace':
      return { kind: 'delete' };
    case ' ':
      return { kind: 'toggle-collapse' };
    case 'd':
    case 'D':
      // `06 §4.1` 的 `D`：拖拽辅助线开关（纯渲染，不落盘）
      return { kind: 'toggle-guides' };
    case 'ArrowUp':
      return { kind: 'move', direction: 'up' };
    case 'ArrowDown':
      return { kind: 'move', direction: 'down' };
    case 'ArrowLeft':
      return { kind: 'move', direction: 'left' };
    case 'ArrowRight':
      return { kind: 'move', direction: 'right' };
    default:
      return { kind: 'none' };
  }
}

/** 标题输入框里的键位 */
export type TitleEditKey = 'commit' | 'cancel' | 'ignore';

export interface TitleEditEvent extends MindKeyEvent {
  /** 输入法正在组字 */
  isComposing?: boolean;
  /** 老浏览器 + 部分输入法：组字期间的 keyCode 是 229 */
  keyCode?: number;
}

/**
 * 标题输入框里的 `Enter` / `Esc`。
 *
 * ★ **组字中的 `Enter` 是"选字"而不是"提交"**：不挡这一下，中文 / 日文用户每选一次词
 *   就会被提交一次，标题被切成一堆半截词（`src/editor/MiniMarkdownEditor` 与卡片骨架的
 *   标题输入都踩过同一个坑，这里是同一套判据）。
 */
export function titleEditKeyOf(event: TitleEditEvent): TitleEditKey {
  if (event.isComposing === true || event.keyCode === 229) return 'ignore';
  if (event.key === 'Escape') return 'cancel';
  if (event.key === 'Enter') return 'commit';
  return 'ignore';
}

/** **树视图**里标题输入框的 `Enter` 该做什么（`N3-j`） */
export type TitleCommitAction = 'commit-and-next' | 'commit' | 'cancel' | 'ignore';

/**
 * **树视图**里标题输入框的键位（`N3-j`，用户 2026-09-17）。
 *
 * ★ 与 `titleEditKeyOf` 只差一处，但很要紧：那边 `Enter` 一律"提交即结束"，
 *   而树视图里按 `Enter` 的人心里想的是**"接着往下写一个同级"**（幕布 / Workflowy 的导图视图
 *   就是这个手感）。真实报障（"新建一个子节点，回车。再回车无法创建起兄弟节点"）有一半是它：
 *   提交完光标停在原地，而**提交之后焦点已经掉回 `<body>`**（输入框被移除）⇒ 那"再按一次"
 *   根本不会响应 —— 于是用户只能先点一下画布。
 *   ⇒ `Enter` ⇒ `commit-and-next`（提交 + 新建同级 + 光标接到新节点）；
 *     `⌘⏎` / `⌃⏎` ⇒ `commit`（只提交："改完就走"，与大纲里的 `⌘⏎` 对齐）。
 * ★ 组字中的 `Enter` 仍不算（与 `titleEditKeyOf` 同一条：中文标题不能被切成一堆半截词）。
 */
export function titleCommitActionOf(event: TitleEditEvent): TitleCommitAction {
  if (event.isComposing === true || event.keyCode === 229) return 'ignore';
  if (event.key === 'Escape') return 'cancel';
  if (event.key !== 'Enter') return 'ignore';
  if (event.metaKey === true || event.ctrlKey === true) return 'commit';
  return 'commit-and-next';
}
