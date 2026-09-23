/**
 * 同步便签卡单元测试（T7.04 / `F2.9`）。
 *
 * 这张卡的全部价值都在**写回**上：正文的显示 / 编辑渲染与便签卡共用同一套代码
 * （那部分已在 `note.test.ts` 里钉过），所以这里只钉"同一份内容出现在多处"本身：
 *
 *  1. **写回路由**：属于同步组（`key` 非空）时提交必须走 `writeSyncGroup`
 *     （一次改全组），**绝不**走 `updateContent` —— 只改这一张正是这张卡要避免的事；
 *  2. **退化路径**：`key` 为空、或视图没给 `writeSyncGroup` 时退回单卡写回 ——
 *     像普通便签一样可用，而不是"编辑了没反应"；
 *  3. **角标**：只在真的属于某个组时画（孤立的那一张不该自称"同步"），
 *     且节点被复用时会重画；
 *  4. **回收**：`destroy()` 把 class / dataset 摘干净，否则复用池里的下一个节点会继承样式。
 */

import { describe, expect, it, vi } from 'vitest';
import type { App, Component } from 'obsidian';
import type { CardRenderContext, CardViewMode } from '../../cards/registry';
import { SYNC_NOTE_DEFAULT_SIZE, syncNoteCard } from '../../cards/syncNote';
import { createCard } from '../../model/factories';
import { t } from '../../util/i18n';
import {
  type FakeElement,
  type FakeTextarea,
  createFakeDocument,
  createFakeElement,
  createKeyEvent,
} from '../helpers/fakeDom';

function contextFor(mode: CardViewMode): CardRenderContext {
  return {
    app: {} as unknown as App,
    sourcePath: '',
    component: {} as unknown as Component,
    renderMarkdown: async () => {},
    zoom: 1,
    mode,
    updateContent: () => {},
    updateCard: () => {},
    setMode: () => {},
  };
}

function renderSyncNote(
  content: { key: string; md: string },
  mode: CardViewMode,
  overrides: Partial<CardRenderContext> = {},
) {
  const doc = createFakeDocument();
  const el = createFakeElement(doc);
  const updateContent = vi.fn();
  const updateCard = vi.fn();
  const setMode = vi.fn();
  const ctx: CardRenderContext = {
    ...contextFor(mode),
    updateContent,
    updateCard,
    setMode,
    ...overrides,
  };

  syncNoteCard.render(el as unknown as HTMLElement, createCard('syncNote', { content }), ctx);

  return { el, updateContent, updateCard, setMode };
}

/** 编辑态里**唯一**那一格：正文编辑器（`F5` 起与便签一样，没有标题格） */
function bodyOf(el: FakeElement): FakeTextarea {
  const textarea = el.children[0] as unknown as FakeTextarea;
  textarea.focus();
  return textarea;
}

/** 改内容后 `⌘Enter` 提交（与 `note.test.ts` 同一手法） */
function submit(textarea: FakeTextarea, value: string): void {
  textarea.value = value;
  textarea.emit('keydown', createKeyEvent({ key: 'Enter', metaKey: true }));
}

// ── 定义契约 ──────────────────────────────────────────────────

describe('syncNoteCard 定义', () => {
  it('默认尺寸与便签一致（它在用户眼里就是那张便签）', () => {
    expect(syncNoteCard.defaultSize).toEqual(SYNC_NOTE_DEFAULT_SIZE);
  });

  it('默认内容是空正文 + 空组键：新建的那一张先当独立便签用', () => {
    expect(syncNoteCard.createDefaultContent()).toEqual({ key: '', md: '' });
  });

  it('导出为 Markdown 就是正文本身', () => {
    const card = createCard('syncNote', { content: { key: 'sy_1', md: '正文' } });
    expect(syncNoteCard.toMarkdown(card, { sourcePath: '' })).toBe('正文');
  });

  it('回收时摘干净自己加的 class / dataset，避免污染复用池里的节点', () => {
    const el = createFakeElement(createFakeDocument());
    syncNoteCard.render(
      el as unknown as HTMLElement,
      createCard('syncNote', { content: { key: 'sy_1', md: '正文' } }),
      contextFor('display'),
    );
    expect(el.classList.contains('nestboard-sync-note')).toBe(true);

    syncNoteCard.destroy?.(el as unknown as HTMLElement);

    expect(el.classList.contains('nestboard-note')).toBe(false);
    expect(el.classList.contains('nestboard-note-preview')).toBe(false);
    expect(el.classList.contains('nestboard-sync-note')).toBe(false);
    expect(el.dataset.syncLabel).toBeUndefined();
    expect(el.dataset.placeholder).toBeUndefined();
  });
});

// ── 同步角标 ──────────────────────────────────────────────────

describe('同步角标', () => {
  it('在同步组里（`key` 非空）→ 画角标，文案取本地化的标签', () => {
    const { el } = renderSyncNote({ key: 'sy_1', md: '正文' }, 'display');

    expect(el.classList.contains('nestboard-sync-note')).toBe(true);
    expect(el.dataset.syncLabel).toBe(t('card.syncNote.badge'));
  });

  it('不在任何组里（`key` 为空）→ 不画角标（孤立的一张不该自称"同步"）', () => {
    const { el } = renderSyncNote({ key: '', md: '正文' }, 'display');

    expect(el.classList.contains('nestboard-sync-note')).toBe(false);
    expect(el.dataset.syncLabel).toBeUndefined();
  });

  it('节点被复用时会重画：上一张的角标不会被下一张继承', () => {
    const el = createFakeElement(createFakeDocument());
    const render = (key: string, md: string) =>
      syncNoteCard.render(
        el as unknown as HTMLElement,
        createCard('syncNote', { content: { key, md } }),
        contextFor('display'),
      );

    render('sy_1', 'a');
    expect(el.classList.contains('nestboard-sync-note')).toBe(true);

    render('', 'b');
    expect(el.classList.contains('nestboard-sync-note')).toBe(false);
    expect(el.dataset.syncLabel).toBeUndefined();
  });
});

// ── 写回路由 ──────────────────────────────────────────────────

describe('写回路由', () => {
  it('在同步组里 → 提交走 `writeSyncGroup`（一次改全组），不走 `updateContent`', () => {
    const writeSyncGroup = vi.fn();
    const { el, updateContent } = renderSyncNote({ key: 'sy_7', md: '' }, 'edit', {
      writeSyncGroup,
    });

    submit(bodyOf(el), '一起改');

    expect(writeSyncGroup).toHaveBeenCalledWith('sy_7', '一起改');
    expect(updateContent).not.toHaveBeenCalled();
  });

  it('`key` 为空 → 即便视图给了 `writeSyncGroup`，也只写本卡', () => {
    const writeSyncGroup = vi.fn();
    const { el, updateContent } = renderSyncNote({ key: '', md: '' }, 'edit', { writeSyncGroup });

    submit(bodyOf(el), '独立');

    expect(writeSyncGroup).not.toHaveBeenCalled();
    expect(updateContent).toHaveBeenCalledWith({ md: '独立' });
  });

  it('视图没给 `writeSyncGroup` → 退回单卡写回，而不是"编辑了没反应"', () => {
    const { el, updateContent } = renderSyncNote({ key: 'sy_7', md: '' }, 'edit');

    submit(bodyOf(el), '退回单卡');

    expect(updateContent).toHaveBeenCalledWith({ md: '退回单卡' });
  });

  it('提交后切回显示态（与便签共用同一套编辑器行为）', () => {
    const { el, setMode } = renderSyncNote({ key: 'sy_7', md: '' }, 'edit', {
      writeSyncGroup: vi.fn(),
    });

    submit(bodyOf(el), '内容');

    expect(setMode).toHaveBeenCalledWith('display');
  });

  it('`Esc` 且内容没改 → 两条写入路径都不碰', () => {
    const writeSyncGroup = vi.fn();
    const { el, updateContent, setMode } = renderSyncNote({ key: 'sy_7', md: '原文' }, 'edit', {
      writeSyncGroup,
    });
    const textarea = bodyOf(el);

    textarea.emit('keydown', createKeyEvent({ key: 'Escape' }));

    expect(writeSyncGroup).not.toHaveBeenCalled();
    expect(updateContent).not.toHaveBeenCalled();
    expect(setMode).toHaveBeenCalledWith('display');
  });

  it('★ 编辑态里没有标题那一格，提交也**不会**去写 `card.title`（`F5`）', () => {
    const writeSyncGroup = vi.fn();
    const { el, updateCard } = renderSyncNote({ key: 'sy_7', md: '原文' }, 'edit', {
      writeSyncGroup,
    });

    // 只有正文一格：标题另有入口（卡面那一行的就地输入，见 `BoardView.editCardTitle`）
    expect(el.children.length).toBe(1);
    const textarea = bodyOf(el);
    textarea.value = '原文';
    textarea.emit('blur', { relatedTarget: null }); // 没改 → 连提交都不该发生

    expect(updateCard).not.toHaveBeenCalled();
    expect(writeSyncGroup).not.toHaveBeenCalled();
  });
});

// ── 右键菜单 ──────────────────────────────────────────────────

describe('右键菜单', () => {
  const single = { multiple: false };

  it('总是提供「新建同步副本」', () => {
    const card = createCard('syncNote', { content: { key: 'sy_1', md: '' } });

    const actions = (syncNoteCard.contextMenu?.(card, single) ?? []).map((item) => item.action);

    expect(actions).toContain('duplicateSyncNote');
  });

  it('只有真的在组里才提供「取消同步」（孤立的那张点了什么都不会发生）', () => {
    const grouped = createCard('syncNote', { content: { key: 'sy_1', md: '' } });
    const lone = createCard('syncNote', { content: { key: '', md: '' } });

    const groupedActions = (syncNoteCard.contextMenu?.(grouped, single) ?? []).map((i) => i.action);
    const loneActions = (syncNoteCard.contextMenu?.(lone, single) ?? []).map((i) => i.action);

    expect(groupedActions).toContain('unsyncNote');
    expect(loneActions).not.toContain('unsyncNote');
  });

  it('多选下两项都置灰（"给哪一张建副本"没有唯一合理解释）', () => {
    const card = createCard('syncNote', { content: { key: 'sy_1', md: '' } });

    const items = syncNoteCard.contextMenu?.(card, { multiple: true }) ?? [];

    expect(items).toHaveLength(2);
    expect(items.every((item) => item.disabled)).toBe(true);
  });
});
