/**
 * **大纲视图**的键位（`N3-b`）。
 *
 * ── 先调研、后动手 ─────────────────────────────────────────
 *
 * 用户 2026-09-17 要求"大纲视图请充分调研幕布之后再开始"。幕布的编辑页是纯 SPA、
 * 要登录才能渲染，抓不到 DOM；但**键位表来自幕布自己的帮助中心**
 * （`mubu.com/help/14`「快捷键列表及自定义快捷键」），那是权威口径。对照如下：
 *
 * | 操作 | 幕布 | 这里 | 说明 |
 * | --- | --- | --- | --- |
 * | 新建同级 | `Enter` | 同 | |
 * | 新建子级 | `Tab` | 同 | 幕布叫"向右缩进主题" |
 * | 提升一级 | `⇧Tab` | 同 | 幕布叫"向左提升一级主题" |
 * | **备注（描述区）** | `⇧Enter` | 同 | **另留 `⌘⏎`**：本仓库"进出内容编辑"的既有键 |
 * | **同级内换序** | `⌘⇧↑` / `⌘⇧↓` | 同 | **另留 `⌥↑↓`**：Finder 系手感 |
 * | **快速删主题** | `⌘⇧⌫`（**仅大纲视图**） | 同 | **另留 `⌫` / `Delete`**：与画布一致 |
 * | 折叠 / 展开 | `⌃.` 或 `⌥.` | 同 | **另留 `Space`**：与画布一致 |
 * | 多选上下 | `⇧↑` / `⇧↓` | 同 | |
 * | 就地改文本 | **直接打字** | 同 | 打进来那个字**成为初始内容**（幕布 / Workflowy 的手感） |
 *
 * ★ **多出来的那几条都是"本仓库已有的键"**（`⌘⏎` / `⌥↑↓` / `⌫` / `Space`）——
 *   两条都认，谁都不会觉得别扭；而**幕布那一套是主口径**（用户要求对齐的那个）。
 * ★ 除上表之外**一条 `⌘` 组合都不抢**：`⌘Z` / `⌘⇧Z` / `⌘C` / `⌘X` / `⌘V` / `⌘A`
 *   归**窗口与命令表**那道 —— 两种视图**共用一条撤销链**是 `09 §3.3` 的硬要求，
 *   在这里再拦一道只会制造"撤销了看不见的东西"。
 */

/** 大纲视图要处理的键（与 `MindKeyEvent` 同一套字段） */
export interface OutlineKeyEvent {
  key: string;
  shiftKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  /** 输入法正在组字 */
  isComposing?: boolean;
  /** 老浏览器 + 部分输入法：组字期间的 keyCode 是 229 */
  keyCode?: number;
}

export type OutlineKeyAction =
  /** 上下走一行；`extend` = `⇧` 加选 */
  | { kind: 'navigate'; delta: -1 | 1; extend: boolean }
  /** 结构性改动：新建同级 / 子级 / 提升一级 */
  | { kind: 'structure'; to: 'sibling' | 'child' | 'promote' }
  /** **缩进一层**（`N3-i`）：变成上一个兄弟的子节点（`Tab`；与 `⇧Tab` 的提升对称） */
  | { kind: 'indent' }
  | { kind: 'remove' }
  /** 同级内换序 */
  | { kind: 'reorder'; delta: -1 | 1 }
  | { kind: 'toggle-collapse' }
  /** 聚焦：**进入当前这一行** / **返回上一级**（`N3-e`；幕布 `⌘]` / `⌘[`） */
  | { kind: 'focus-in' }
  | { kind: 'focus-out' }
  /** 完成 / 取消完成（`N3-g`：`⌘⇧⏎`） */
  | { kind: 'toggle-done' }
  /** 就地改文本；`seed` = 用户直接敲进来的那个字（成为初始内容） */
  | { kind: 'edit-title'; seed?: string }
  | { kind: 'edit-note' }
  | { kind: 'none' };

export function outlineKeyActionOf(event: OutlineKeyEvent): OutlineKeyAction {
  // 组字中的按键一律不接（中文 / 日文选词那一下不该被当成命令）
  if (event.isComposing === true || event.keyCode === 229) return { kind: 'none' };

  const mod = event.metaKey === true || event.ctrlKey === true;
  const shift = event.shiftKey === true;
  const alt = event.altKey === true;

  // ★ 完成 / 取消完成（`N3-g`）排在 `Enter` 那几条**之前**：`⌘⇧⏎` 两个修饰键都在，
  //   不先接住的话会被下面那个 `if (mod) return 'edit-note'` 吃掉
  if (event.key === 'Enter' && mod && shift) return { kind: 'toggle-done' };

  // ★ `⌥⏎` = 新建**子**节点（原来挂在 `Tab` 上；`Tab` 让给"缩进"了）。
  //   ★ 必须也排在 `Enter` 那一段**之前**：那一段只挡 `mod` / `shift`，
  //     `⌥⏎` 会一路滑到 "sibling" 上去（写完用例才发现 —— 单测正是为此存在的）
  if (event.key === 'Enter' && alt && !mod && !shift) return { kind: 'structure', to: 'child' };

  if (event.key === 'Enter') {
    if (mod) return { kind: 'edit-note' }; // 本仓库的既有键
    return shift ? { kind: 'edit-note' } : { kind: 'structure', to: 'sibling' };
  }

  // ★★ `Tab` / `⇧Tab` = **缩进 / 提升**（`N3-i`，用户 2026-09-17："按下 tab 键，这个节点会
  //   变成其上一个同级节点的子节点，缩进一层" —— 要的就是文本编辑器里那对手感）。
  //   于是"新建**子**节点"挪到 `⌥⏎`：`Tab` 在两处（编辑器里 / 选中一行时）必须是**同一个意思**，
  //   否则"光标在不在字里"会悄悄改变这个键的含义。
  if (event.key === 'Tab') {
    if (alt) return { kind: 'none' }; // `⌥Tab` 在 macOS 上是系统级（切窗口），不接
    return shift ? { kind: 'structure', to: 'promote' } : { kind: 'indent' };
  }

  if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
    const delta = event.key === 'ArrowUp' ? -1 : 1;
    // 换序：幕布 `⌘⇧↑↓`；`⌥↑↓` 也认
    if (mod && shift) return { kind: 'reorder', delta };
    if (alt && !mod) return { kind: 'reorder', delta };
    // 带别的修饰键（`⌘↑` / `⌃↑`…）留给系统与别处：那些组合在 macOS 上是系统级语义
    if (mod || alt) return { kind: 'none' };
    return { kind: 'navigate', delta, extend: shift };
  }

  if (event.key === 'Backspace' || event.key === 'Delete') {
    // 幕布"快速删除主题"= `⌘⇧⌫`（且注明**仅大纲视图**）；不带修饰也认（与画布一致）
    if ((mod || alt) && !shift) return { kind: 'none' };
    return { kind: 'remove' };
  }

  // 折叠：`Space`（与画布一致）、`⌃.` / `⌥.`（幕布）
  if (event.key === ' ' && !mod && !alt) return { kind: 'toggle-collapse' };
  if (event.key === '.' && (mod || alt)) return { kind: 'toggle-collapse' };

  // 聚焦（`N3-e`）：幕布 `⌘]` 进入当前主题、`⌘[` 返回上一级。
  // ★ 排在这里（`F2` 与"直接打字"之前）：那两个分支都要求**不带修饰键**，本来也吃不到它们
  if (mod && !alt && !shift && (event.key === ']' || event.key === '[')) {
    return { kind: event.key === ']' ? 'focus-in' : 'focus-out' };
  }

  if (event.key === 'F2') return { kind: 'edit-title' };

  // ★ 直接打字 = 就地改文本（幕布的手感）：那一个字成为初始内容。
  //   `length === 1` 同时把 `F1`–`F12` / `Home` / `Escape` 这些名字排除在外
  if (!mod && !alt && !shift && event.key.length === 1) {
    return { kind: 'edit-title', seed: event.key };
  }

  return { kind: 'none' };
}
