/**
 * 脑图键位判据（`06 §4.1` / `mind/view/keys.ts`）。
 *
 * 键位是"编辑手感"的全部：这里逐条钉住"哪个键做什么"，以及两条容易被踩的：
 * 带 `⌘` 的组合一律不接（那是命令表的活）、**输入法组字中的 `Enter` 不是提交**。
 */

import { describe, expect, it } from 'vitest';
import { mindKeyActionOf, titleCommitActionOf, titleEditKeyOf } from '../../mind/view/keys';

const key = (value: string, extra: Record<string, boolean> = {}) => ({
  key: value,
  ...extra,
});

describe('mindKeyActionOf · 画布键位', () => {
  it('`Tab` 加子节点；`Shift+Tab` 提升一级', () => {
    expect(mindKeyActionOf(key('Tab'))).toEqual({ kind: 'add-child' });
    expect(mindKeyActionOf(key('Tab', { shiftKey: true }))).toEqual({ kind: 'promote' });
  });

  it('`Enter` 加兄弟、`F2` 改标题', () => {
    expect(mindKeyActionOf(key('Enter'))).toEqual({ kind: 'add-sibling' });
    expect(mindKeyActionOf(key('F2'))).toEqual({ kind: 'edit-title' });
  });

  it('`Delete` 与 `Backspace` 都删（Mac 键盘上后者更顺手）', () => {
    expect(mindKeyActionOf(key('Delete'))).toEqual({ kind: 'delete' });
    expect(mindKeyActionOf(key('Backspace'))).toEqual({ kind: 'delete' });
  });

  it('`Space` 折叠 / 展开', () => {
    expect(mindKeyActionOf(key(' '))).toEqual({ kind: 'toggle-collapse' });
  });

  it('方向键四个方向各有落点', () => {
    expect(mindKeyActionOf(key('ArrowUp'))).toEqual({ kind: 'move', direction: 'up' });
    expect(mindKeyActionOf(key('ArrowDown'))).toEqual({ kind: 'move', direction: 'down' });
    expect(mindKeyActionOf(key('ArrowLeft'))).toEqual({ kind: 'move', direction: 'left' });
    expect(mindKeyActionOf(key('ArrowRight'))).toEqual({ kind: 'move', direction: 'right' });
  });

  it('★ 带 `⌘` / `Ctrl` / `Alt` 的组合一律不接（那是命令表的活，接了两边都会跑）', () => {
    const modifiers: Array<Record<string, boolean>> = [
      { metaKey: true },
      { ctrlKey: true },
      { altKey: true },
    ];
    for (const extra of modifiers) {
      expect(mindKeyActionOf(key('Tab', extra))).toEqual({ kind: 'none' });
      expect(mindKeyActionOf(key('Enter', extra))).toEqual({ kind: 'none' });
      expect(mindKeyActionOf(key('Backspace', extra))).toEqual({ kind: 'none' });
    }
  });

  it('打字键与别的键一律 `none`（`Space` 已经先被折叠接走了）', () => {
    expect(mindKeyActionOf(key('a'))).toEqual({ kind: 'none' });
    expect(mindKeyActionOf(key('Escape'))).toEqual({ kind: 'none' });
    expect(mindKeyActionOf(key('PageUp'))).toEqual({ kind: 'none' });
  });
});

describe('mindKeyActionOf · 聚焦两键（`D1`，用户 2026-09-18）', () => {
  it('★ `⌘]` = 进入当前主题、`⌘[` = 返回上一层（从前只有大纲接了这两键）', () => {
    expect(mindKeyActionOf(key(']', { metaKey: true }))).toEqual({ kind: 'focus-in' });
    expect(mindKeyActionOf(key('[', { metaKey: true }))).toEqual({ kind: 'focus-out' });
    // Windows / Linux 用 `Ctrl`（与大纲那两条同一条约定）
    expect(mindKeyActionOf(key(']', { ctrlKey: true }))).toEqual({ kind: 'focus-in' });
  });

  it('★ 别的修饰键组合照旧不接（不许把 `⌘⇧[` / `⌘⌥]` 这类组合吞掉）', () => {
    expect(mindKeyActionOf(key(']', { metaKey: true, shiftKey: true }))).toEqual({ kind: 'none' });
    expect(mindKeyActionOf(key('[', { metaKey: true, altKey: true }))).toEqual({ kind: 'none' });
    // 不带修饰键的 `]` / `[` 也不是聚焦键（它们落到"直接打字"那一档的判定里）
    expect(mindKeyActionOf(key(']'))).toEqual({ kind: 'none' });
  });
});

describe('titleEditKeyOf · 标题输入框', () => {
  it('`Enter` 提交、`Esc` 放弃', () => {
    expect(titleEditKeyOf(key('Enter'))).toBe('commit');
    expect(titleEditKeyOf(key('Escape'))).toBe('cancel');
  });

  it('★ 输入法组字中的 `Enter` 是"选字"，不是提交（否则中文标题会被切成一堆半截词）', () => {
    expect(titleEditKeyOf({ key: 'Enter', isComposing: true })).toBe('ignore');
    expect(titleEditKeyOf({ key: 'Enter', keyCode: 229 })).toBe('ignore');
    // 组字中的 Esc 也只是"取消候选"，不该关掉输入框
    expect(titleEditKeyOf({ key: 'Escape', isComposing: true })).toBe('ignore');
  });

  it('别的键交给输入框自己（左右移动光标、退格…）', () => {
    expect(titleEditKeyOf(key('ArrowLeft'))).toBe('ignore');
    expect(titleEditKeyOf(key('Backspace'))).toBe('ignore');
    expect(titleEditKeyOf(key('a'))).toBe('ignore');
  });
});

describe('titleCommitActionOf · 树视图的标题输入框（`N3-j`）', () => {
  it('★ `Enter` = 提交**并接着新建一个同级**（幕布 / Workflowy 导图的手感）', () => {
    expect(titleCommitActionOf(key('Enter'))).toBe('commit-and-next');
  });

  it('`⌘⏎` / `⌃⏎` = **只提交**（"改完就走"，与大纲里的 `⌘⏎` 对齐）', () => {
    expect(titleCommitActionOf(key('Enter', { metaKey: true }))).toBe('commit');
    expect(titleCommitActionOf(key('Enter', { ctrlKey: true }))).toBe('commit');
  });

  it('`Esc` = 放弃这一改', () => {
    expect(titleCommitActionOf(key('Escape'))).toBe('cancel');
  });

  it('★ 组字中的 `Enter` 仍是"选字"（与 `titleEditKeyOf` 同一条，别把中文标题切成半截词）', () => {
    expect(titleCommitActionOf({ key: 'Enter', isComposing: true })).toBe('ignore');
    expect(titleCommitActionOf({ key: 'Enter', keyCode: 229 })).toBe('ignore');
  });

  it('别的键交给输入框自己', () => {
    expect(titleCommitActionOf(key('ArrowLeft'))).toBe('ignore');
    expect(titleCommitActionOf(key('a'))).toBe('ignore');
  });
});
