/**
 * 便签卡单元测试（T1.32 / F2.1）。
 *
 * 便签卡的"渲染"分成两半：DOM 由 Obsidian 的 `MarkdownRenderer` 负责（跑在真环境里验），
 * 这里只钉三件**纯逻辑且错了很难肉眼发现**的事：
 *   1. **空正文判定**：空 / 纯空白都算空，决定了显示引导文案还是渲染正文；
 *   2. **契约**：`defaultSize` / `createDefaultContent` / `toMarkdown` 是别处依赖的接口；
 *   3. **接线**：编辑态必须把编辑会话交给 `MiniMarkdownEditor`，并把它的两个回调
 *      正确翻译成视图调用 —— 编辑行为本身在 `MiniMarkdownEditor.test.ts` 里验；
 *   4. **深色变体**（`O06`）：`variant` 只影响"挂不挂 `is-dark`"这一件事，
 *      正文渲染一个字都不变；菜单项标题写"点下去会发生什么"（不是状态名）。
 *
 * 单测跑在 node 环境（无 DOM），假节点见 `helpers/fakeDom.ts`。
 */

import { describe, expect, it, vi } from 'vitest';
import type { App, Component } from 'obsidian';
import { NOTE_DEFAULT_SIZE, isBlankNote, noteCard } from '../../cards/note';
import type { CardRenderContext, CardViewMode } from '../../cards/registry';
import { createCard } from '../../model/factories';
import { t } from '../../util/i18n';
import {
  createFakeDocument,
  createFakeElement,
  createKeyEvent,
  type FakeElement,
  type FakeTextarea,
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

function renderNote(
  input: { title?: string; md: string },
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

  noteCard.render(
    el as unknown as HTMLElement,
    createCard('note', { title: input.title ?? '', content: { md: input.md } }),
    ctx,
  );

  return { el, updateContent, updateCard, setMode };
}

/**
 * 便签卡编辑态里**唯一**那一格：正文编辑器。
 *
 * ★ `F5`（用户 2026-09-21）起编辑态里**没有标题格** —— 便签的内容编辑与引用卡
 *   （`.md` 文档节点）同款，只有正文；标题走卡面那一行的就地输入（视图侧
 *   `BoardView.editCardTitle`）。这条断言本身就是那次收口的回归线。
 */
function bodyOf(el: FakeElement): FakeTextarea {
  const textarea = el.children[0] as unknown as FakeTextarea;
  textarea.focus();
  return textarea;
}

function press(textarea: FakeTextarea, key: string, metaKey = false): void {
  textarea.emit('keydown', createKeyEvent({ key, metaKey }));
}

// ── 纯函数 ────────────────────────────────────────────────────

describe('isBlankNote', () => {
  it('空串与纯空白都算空', () => {
    expect(isBlankNote('')).toBe(true);
    expect(isBlankNote('   ')).toBe(true);
    expect(isBlankNote('\n\t  \n')).toBe(true);
  });

  it('有任何非空白字符都不算空', () => {
    expect(isBlankNote('a')).toBe(false);
    expect(isBlankNote('  a  ')).toBe(false);
    expect(isBlankNote('# 标题')).toBe(false);
  });
});

describe('noteCard 定义', () => {
  it('默认尺寸来自定义本身（新建便签用它，不再回落到 factories 的临时表）', () => {
    expect(noteCard.defaultSize).toEqual(NOTE_DEFAULT_SIZE);
  });

  it('默认内容是空正文 + 预览偏好（不写 md 偏好字段，避免仅为双击一次就改文件）', () => {
    expect(noteCard.createDefaultContent()).toEqual({ md: '', editorMode: 'preview' });
  });

  it('导出为 Markdown 就是正文本身', () => {
    const card = createCard('note', { content: { md: '正文' } });
    expect(noteCard.toMarkdown(card, { sourcePath: '' })).toBe('正文');
  });

  it('回收时摘干净自己加的 class，避免污染复用池里的节点', () => {
    const el = createFakeElement(createFakeDocument());
    noteCard.render(el as unknown as HTMLElement, createCard('note'), contextFor('display'));
    expect(el.classList.contains('nestboard-note')).toBe(true);

    noteCard.destroy?.(el as unknown as HTMLElement);
    expect(el.classList.contains('nestboard-note')).toBe(false);
    expect(el.classList.contains('nestboard-note-preview')).toBe(false);
    expect(el.dataset.placeholder).toBeUndefined();
  });
});

// ── 显示态 ────────────────────────────────────────────────────

describe('显示态渲染', () => {
  it('空正文 → 写引导文案并打上占位标记，而不是留一片空白', () => {
    const { el } = renderNote({ md: '' }, 'display');

    expect(el.classList.contains('nestboard-note-preview')).toBe(true);
    expect(el.dataset.placeholder).toBe('true');
    expect(el.textContent).toBe(t('card.note.empty'));
  });

  it('有正文 → 交给注入的 renderMarkdown（本文件不认识 obsidian）', () => {
    const renderMarkdown = vi.fn(async () => {});
    const { el } = renderNote({ md: '# 标题' }, 'display', { renderMarkdown });

    expect(renderMarkdown).toHaveBeenCalledWith('# 标题', el);
    expect(el.dataset.placeholder).toBeUndefined();
  });
});

// ── 深色变体（O06） ───────────────────────────────────────────

describe('深色变体', () => {
  it('`variant: dark` → 内容槽带上 `is-dark`（配色由样式表反选外壳，这里只管挂类）', () => {
    const doc = createFakeDocument();
    const el = createFakeElement(doc);
    noteCard.render(
      el as unknown as HTMLElement,
      createCard('note', { content: { md: '正文', variant: 'dark' } }),
      contextFor('display'),
    );
    expect(el.classList.contains('is-dark')).toBe(true);
  });

  it('没写 `variant`（= 浅色）与显式 `light` 一样不挂类', () => {
    for (const content of [{ md: 'x' }, { md: 'x', variant: 'light' as const }]) {
      const el = createFakeElement(createFakeDocument());
      noteCard.render(
        el as unknown as HTMLElement,
        createCard('note', { content }),
        contextFor('display'),
      );
      expect(el.classList.contains('is-dark')).toBe(false);
    }
  });

  it('★ 内容一个字都不改：深色只是底色，不是另一种渲染分支', () => {
    const renderMarkdown = vi.fn(async () => {});
    const el = createFakeElement(createFakeDocument());
    noteCard.render(
      el as unknown as HTMLElement,
      createCard('note', { content: { md: '# 标题', variant: 'dark' } }),
      { ...contextFor('display'), renderMarkdown },
    );
    expect(renderMarkdown).toHaveBeenCalledWith('# 标题', el);
  });

  it('★ 回收时把 `is-dark` 一起摘掉（复用池里的下一位租客不该继承黑底）', () => {
    const el = createFakeElement(createFakeDocument());
    noteCard.render(
      el as unknown as HTMLElement,
      createCard('note', { content: { md: 'x', variant: 'dark' } }),
      contextFor('display'),
    );
    expect(el.classList.contains('is-dark')).toBe(true);

    noteCard.destroy?.(el as unknown as HTMLElement);
    expect(el.classList.contains('is-dark')).toBe(false);
  });
});

// ── 右键菜单：深色便签这一项已**收起来**（用户 2026-09-16） ────

describe('右键菜单 · 深色便签（入口已隐藏）', () => {
  /**
   * ★ 这里钉的是"**入口没了**"，不是"这个能力没了"：
   *   `NoteContent.variant` 与它的样式表都还在（旧文件里的深色便签照旧显示，
   *   见上一组用例），只是不再给用户一个切换的入口 ——
   *   用户 2026-09-16：\"深色便签、强调颜色这两块功能都可以隐藏了\"。
   * ★ 哪天要把入口加回来，这条用例会**红**着提醒你一并想清楚
   *   "要不要恢复菜单项、文案与置灰规则"。
   */
  it('★ 便签的类型菜单项现在是**空的**（深色便签的入口收起来了）', () => {
    const light = createCard('note', { content: { md: 'x' } });
    const dark = createCard('note', { content: { md: 'x', variant: 'dark' } });

    expect(noteCard.contextMenu?.(light, { multiple: false })).toEqual([]);
    expect(noteCard.contextMenu?.(dark, { multiple: false })).toEqual([]);
    expect(noteCard.contextMenu?.(light, { multiple: true })).toEqual([]);
  });
});

// ── 编辑态接线 ────────────────────────────────────────────────

describe('编辑态接线（F5：只有正文一格，与文档节点同款）', () => {
  it('★ 内容槽里只有正文编辑器 —— **没有**标题那一格', () => {
    const { el } = renderNote({ title: '卡名', md: '原文' }, 'edit');

    expect(el.classList.contains('nestboard-note-edit')).toBe(true);
    expect(el.children.length).toBe(1);
    expect(bodyOf(el).className).toBe('nestboard-mde-input');
    expect(bodyOf(el).value).toBe('原文');
  });

  it('★ 两种入口（双击的 `title` / `⌘`+双击的 `raw`）落到同一个编辑器上', () => {
    for (const editEntry of ['title', 'raw'] as const) {
      const { el } = renderNote({ title: '卡名', md: '原文' }, 'edit', { editEntry });

      expect(el.children.length).toBe(1);
      expect((el.children[0] as unknown as FakeTextarea).className).toBe('nestboard-mde-input');
    }
  });

  it('★ 提交只写正文（`updateContent`），一个字都不碰 `card.title`', () => {
    const { el, updateContent, updateCard } = renderNote({ title: '卡名', md: '原文' }, 'edit');
    const textarea = bodyOf(el);
    textarea.value = '改过的正文';
    press(textarea, 'Enter', true);

    expect(updateContent).toHaveBeenCalledWith({ md: '改过的正文' });
    // 标题另有入口（卡面那一行的就地输入）——编辑器里根本没有它
    expect(updateCard).not.toHaveBeenCalled();
  });

  it('正文里 `⌘Enter` 后切回显示态', () => {
    const { el, updateContent, setMode } = renderNote({ title: '卡名', md: '原文' }, 'edit');
    bodyOf(el).value = '改过了';
    press(bodyOf(el), 'Enter', true);

    expect(updateContent).toHaveBeenCalledWith({ md: '改过了' });
    expect(setMode).toHaveBeenCalledWith('display');
  });

  it('`Esc` 且一个字没改 → 不写模型，只切回显示态', () => {
    const { el, updateContent, setMode } = renderNote({ title: '卡名', md: '原文' }, 'edit');
    press(bodyOf(el), 'Escape');

    expect(updateContent).not.toHaveBeenCalled();
    expect(setMode).toHaveBeenCalledWith('display');
  });
});
