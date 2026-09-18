/**
 * 大纲视图的键位（`N3-b`）：主口径对齐**幕布帮助中心**（`mubu.com/help/14`）。
 *
 * 这里钉两类东西：
 * 1. 幕布那一套逐条对上（`Enter` / `Tab` / `⇧Tab` / `⇧Enter` / `⌘⇧↑↓` / `Space` / `⇧↑↓` / 直接打字）；
 * 2. ★ **一条 `⌘` 组合都不多抢** —— `⌘Z` / `⌘C` / `⌘V` / `⌘A` 必须留给窗口那道，
 *    否则"两视图共用一条撤销链"会被这里截胡。
 */

import { describe, expect, it } from 'vitest';
import { outlineKeyActionOf } from '../../mind/view/outlineKeys';

const key = (
  value: string,
  mods: Partial<Record<'shift' | 'meta' | 'ctrl' | 'alt', true>> = {},
) => ({
  key: value,
  shiftKey: mods.shift === true,
  metaKey: mods.meta === true,
  ctrlKey: mods.ctrl === true,
  altKey: mods.alt === true,
});

describe('大纲键位 · 结构与编辑（对齐幕布）', () => {
  it('`Enter` = 新建同级；`⌥⏎` = 新建子级；`⇧Tab` = 提升一级', () => {
    expect(outlineKeyActionOf(key('Enter'))).toEqual({ kind: 'structure', to: 'sibling' });
    // ★ `Tab` 改成"缩进"之后（`N3-i`），新建子级挪到了 `⌥⏎`
    expect(outlineKeyActionOf(key('Enter', { alt: true }))).toEqual({
      kind: 'structure',
      to: 'child',
    });
    expect(outlineKeyActionOf(key('Tab', { shift: true }))).toEqual({
      kind: 'structure',
      to: 'promote',
    });
  });

  it('★ `⇧Enter` = 编辑备注（幕布的"描述区"）；`⌘⏎` 也认（本仓库的既有键）', () => {
    expect(outlineKeyActionOf(key('Enter', { shift: true }))).toEqual({ kind: 'edit-note' });
    expect(outlineKeyActionOf(key('Enter', { meta: true }))).toEqual({ kind: 'edit-note' });
    expect(outlineKeyActionOf(key('Enter', { ctrl: true }))).toEqual({ kind: 'edit-note' });
  });

  it('★ 删主题：`⌘⇧⌫`（幕布，仅大纲视图）与光秃秃的 `⌫` 都删', () => {
    expect(outlineKeyActionOf(key('Backspace', { meta: true, shift: true }))).toEqual({
      kind: 'remove',
    });
    expect(outlineKeyActionOf(key('Backspace'))).toEqual({ kind: 'remove' });
    expect(outlineKeyActionOf(key('Delete'))).toEqual({ kind: 'remove' });
    // 只带 `⌘`（不带 `⇧`）的组合不接：那是"删除到行首"之类的系统语义
    expect(outlineKeyActionOf(key('Backspace', { meta: true }))).toEqual({ kind: 'none' });
  });

  it('★ 换序：幕布 `⌘⇧↑↓`；`⌥↑↓` 也认', () => {
    expect(outlineKeyActionOf(key('ArrowUp', { meta: true, shift: true }))).toEqual({
      kind: 'reorder',
      delta: -1,
    });
    expect(outlineKeyActionOf(key('ArrowDown', { meta: true, shift: true }))).toEqual({
      kind: 'reorder',
      delta: 1,
    });
    expect(outlineKeyActionOf(key('ArrowUp', { alt: true }))).toEqual({
      kind: 'reorder',
      delta: -1,
    });
    expect(outlineKeyActionOf(key('ArrowDown', { alt: true }))).toEqual({
      kind: 'reorder',
      delta: 1,
    });
  });

  it('光标移动：`↑↓` 走行；`⇧↑↓` 加选（幕布那一行"向上/向下多选"）', () => {
    expect(outlineKeyActionOf(key('ArrowUp'))).toEqual({
      kind: 'navigate',
      delta: -1,
      extend: false,
    });
    expect(outlineKeyActionOf(key('ArrowDown'))).toEqual({
      kind: 'navigate',
      delta: 1,
      extend: false,
    });
    expect(outlineKeyActionOf(key('ArrowDown', { shift: true }))).toEqual({
      kind: 'navigate',
      delta: 1,
      extend: true,
    });
  });

  it('折叠：`Space`（与画布一致）与幕布的 `⌃.` / `⌥.`', () => {
    expect(outlineKeyActionOf(key(' '))).toEqual({ kind: 'toggle-collapse' });
    expect(outlineKeyActionOf(key('.', { ctrl: true }))).toEqual({ kind: 'toggle-collapse' });
    expect(outlineKeyActionOf(key('.', { alt: true }))).toEqual({ kind: 'toggle-collapse' });
  });

  it('★ 直接打字 = 就地改文本，那一个字**成为初始内容**（幕布 / Workflowy 的手感）', () => {
    expect(outlineKeyActionOf(key('a'))).toEqual({ kind: 'edit-title', seed: 'a' });
    expect(outlineKeyActionOf(key('中'))).toEqual({ kind: 'edit-title', seed: '中' });
    expect(outlineKeyActionOf(key('F2'))).toEqual({ kind: 'edit-title' });
    // 带修饰的字母不是"打字"（`⌘B` 之类要留给别处）
    expect(outlineKeyActionOf(key('b', { meta: true }))).toEqual({ kind: 'none' });
  });
});

describe('大纲键位 · 不多抢 `⌘` 组合', () => {
  it('★ 撤销 / 复制 / 粘贴 / 全选一律放行（两视图共用一条撤销链是硬要求）', () => {
    for (const value of ['z', 'Z', 'c', 'x', 'v', 'a']) {
      expect(outlineKeyActionOf(key(value, { meta: true }))).toEqual({ kind: 'none' });
    }
  });

  it('`⌘↑` / `⌃↓` 这类系统级组合也放行（不当成导航）', () => {
    expect(outlineKeyActionOf(key('ArrowUp', { meta: true }))).toEqual({ kind: 'none' });
    expect(outlineKeyActionOf(key('ArrowDown', { ctrl: true }))).toEqual({ kind: 'none' });
  });

  it('★ 组字中一律不接（中文 / 日文选词那一下不该被当成命令）', () => {
    expect(outlineKeyActionOf({ key: 'Enter', isComposing: true })).toEqual({ kind: 'none' });
    expect(outlineKeyActionOf({ key: 'Enter', keyCode: 229 })).toEqual({ kind: 'none' });
    expect(outlineKeyActionOf({ key: '中', isComposing: true })).toEqual({ kind: 'none' });
  });
});

describe('大纲键位 · 文本编辑习惯（`N3-i`）', () => {
  it('`Tab` = **缩进**；`⇧Tab` = 提升（一对，与文本编辑器一致）', () => {
    expect(outlineKeyActionOf(key('Tab'))).toEqual({ kind: 'indent' });
    expect(outlineKeyActionOf(key('Tab', { shift: true }))).toEqual({
      kind: 'structure',
      to: 'promote',
    });
  });

  it('★ "新建**子**节点"从 `Tab` 挪到 `⌥⏎`（`Tab` 不能因为"光标在不在字里"而换意思）', () => {
    expect(outlineKeyActionOf(key('Enter', { alt: true }))).toEqual({
      kind: 'structure',
      to: 'child',
    });
  });

  it('`⏎` 仍是新建同级（选中一行时；光标在字里时视图会接成"按光标拆行"）', () => {
    expect(outlineKeyActionOf(key('Enter'))).toEqual({ kind: 'structure', to: 'sibling' });
  });

  it('`⌥Tab` 不接（macOS 上是系统级切窗口）', () => {
    expect(outlineKeyActionOf(key('Tab', { alt: true }))).toEqual({ kind: 'none' });
  });
});

describe('大纲键位 · 完成（`N3-g`）', () => {
  it('`⌘⇧⏎` = 完成 / 取消完成', () => {
    expect(outlineKeyActionOf(key('Enter', { meta: true, shift: true }))).toEqual({
      kind: 'toggle-done',
    });
    expect(outlineKeyActionOf(key('Enter', { ctrl: true, shift: true }))).toEqual({
      kind: 'toggle-done',
    });
  });

  it('★ 不抢注释区的两个键：`⇧⏎` 与 `⌘⏎` 仍然是"编辑备注"', () => {
    expect(outlineKeyActionOf(key('Enter', { shift: true }))).toEqual({ kind: 'edit-note' });
    expect(outlineKeyActionOf(key('Enter', { meta: true }))).toEqual({ kind: 'edit-note' });
  });
});

describe('大纲键位 · 聚焦（`N3-e`）', () => {
  it('`⌘]` = 进入当前主题；`⌘[` = 返回上一级（幕布；`⌃` 也认）', () => {
    expect(outlineKeyActionOf(key(']', { meta: true }))).toEqual({ kind: 'focus-in' });
    expect(outlineKeyActionOf(key('[', { meta: true }))).toEqual({ kind: 'focus-out' });
    expect(outlineKeyActionOf(key(']', { ctrl: true }))).toEqual({ kind: 'focus-in' });
    expect(outlineKeyActionOf(key('[', { ctrl: true }))).toEqual({ kind: 'focus-out' });
  });

  it('★ 不带修饰键的 `[` / `]` 仍然是**直接打字**（不该被聚焦截胡）', () => {
    expect(outlineKeyActionOf(key(']'))).toEqual({ kind: 'edit-title', seed: ']' });
    expect(outlineKeyActionOf(key('['))).toEqual({ kind: 'edit-title', seed: '[' });
  });

  it('`⇧⌘]` / `⌥⌘]` 不接（那两档留给系统与将来的组合）', () => {
    expect(outlineKeyActionOf(key(']', { meta: true, shift: true }))).toEqual({ kind: 'none' });
    expect(outlineKeyActionOf(key(']', { meta: true, alt: true }))).toEqual({ kind: 'none' });
  });
});
