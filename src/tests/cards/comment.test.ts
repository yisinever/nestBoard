/**
 * 评论卡单元测试（T7.05 / `F2.9`）。
 *
 * 这张卡的主张只有两条，测试也就围着它们转：
 *
 *  1. **写入只有两种：追加一条、删掉一条。** 没有"整篇改写"这条路 ——
 *     所以每条的时间戳永远是写下它的那一刻，条目顺序永远是时间顺序。
 *     追加要按 `at` 记时间、空文本不落条目；删除要按 `id` 定位（按下标会错位）。
 *  2. **`resolved` 只改一个布尔，不删内容。** 已解决 = 卡面置灰 + 角标，
 *     线程一条不少（"当时为什么这么写"是备注的一半价值）。
 *
 * 其余是两态的接线：显示态只给一行入口（点了才进编辑态），编辑态才有输入框
 * 与「×」，`Enter` 提交 / `Shift+Enter` 换行 / `Esc` 退出。
 */

import { describe, expect, it, vi } from 'vitest';
import type { App, Component } from 'obsidian';
import type { CommentEntry } from '../../model/schema';
import type { CardRenderContext, CardViewMode } from '../../cards/registry';
import {
  COMMENT_DEFAULT_SIZE,
  appendCommentEntry,
  commentCard,
  commentTimeLabel,
  createCommentEntry,
  formatCommentTime,
  removeCommentEntry,
} from '../../cards/comment';
import { createCard } from '../../model/factories';
import { t } from '../../util/i18n';
import {
  type FakeElement,
  type FakeTextarea,
  createFakeDocument,
  createFakeElement,
  createKeyEvent,
} from '../helpers/fakeDom';

const AT = new Date('2026-09-13T10:05:00').getTime();

function contextFor(
  mode: CardViewMode,
  overrides: Partial<CardRenderContext> = {},
): CardRenderContext {
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
    ...overrides,
  };
}

function renderComment(
  content: { entries: CommentEntry[]; resolved: boolean },
  mode: CardViewMode,
  overrides: Partial<CardRenderContext> = {},
) {
  const doc = createFakeDocument();
  const el = createFakeElement(doc);
  const updateContent = vi.fn();
  const setMode = vi.fn();
  const ctx = contextFor(mode, { updateContent, setMode, ...overrides });

  commentCard.render(el as unknown as HTMLElement, createCard('comment', { content }), ctx);

  return { el, updateContent, setMode };
}

/** 一条现成的备注（时间固定，免得断言跟着跑的时刻漂） */
function entry(text: string, at: number = AT, id = `cmt_${text}`): CommentEntry {
  return { id, text, at };
}

/** 编辑态挂在最后的那只输入框 */
function inputOf(el: FakeElement): FakeTextarea {
  const input = el.children[el.children.length - 1] as FakeTextarea;
  input.focus();
  return input;
}

/** 线程里第 `index` 条那一行 */
function rowOf(el: FakeElement, index: number): FakeElement {
  const thread = el.children[0] as FakeElement;
  return thread.children[index] as FakeElement;
}

// ── 定义契约 ──────────────────────────────────────────────────

describe('commentCard 定义', () => {
  it('默认尺寸与 `DEFAULT_CARD_SIZES.comment` 一致（比便签略宽：前面有一列时间戳）', () => {
    expect(commentCard.defaultSize).toEqual(COMMENT_DEFAULT_SIZE);
  });

  it('默认内容 = 空线程 + 未解决（新建的卡先是"等着写第一条"的空卡）', () => {
    expect(commentCard.createDefaultContent()).toEqual({ entries: [], resolved: false });
  });

  it('导出为 Markdown：一条一行，带完整时间；时间不明的条目只写正文', () => {
    const card = createCard('comment', {
      content: {
        entries: [entry('第一句'), entry('第二句', AT + 60_000), entry('没时间的', 0)],
        resolved: false,
      },
    });

    const md = commentCard.toMarkdown(card, { sourcePath: '' });

    expect(md.split('\n')).toEqual([
      `- 2026-09-13 10:05 第一句`,
      `- 2026-09-13 10:06 第二句`,
      // `at <= 0` 的条目**不编一个时间出来**：写不出时间就干脆不写
      `- 没时间的`,
    ]);
  });

  it('回收时摘干净自己加的 class / dataset，避免污染复用池里的节点', () => {
    const el = createFakeElement(createFakeDocument());
    commentCard.render(
      el as unknown as HTMLElement,
      createCard('comment', { content: { entries: [], resolved: true } }),
      contextFor('display'),
    );
    expect(el.classList.contains('nestboard-comment')).toBe(true);

    commentCard.destroy?.(el as unknown as HTMLElement);

    expect(el.classList.contains('nestboard-comment')).toBe(false);
    expect(el.classList.contains('nestboard-comment-display')).toBe(false);
    expect(el.classList.contains('is-empty')).toBe(false);
    expect(el.classList.contains('is-resolved')).toBe(false);
    expect(el.dataset.commentBadge).toBeUndefined();
    expect(el.dataset.placeholder).toBeUndefined();
  });
});

// ── 纯逻辑：追加 / 删除 / 时间 ────────────────────────────────

describe('线程的纯逻辑', () => {
  it('追加落在**末尾**，并把 `at` 记成传进来的那个时刻（不偷偷 Date.now）', () => {
    const next = appendCommentEntry([entry('先写的')], '后写的', AT);

    expect(next.map((item) => item.text)).toEqual(['先写的', '后写的']);
    expect(next[1].at).toBe(AT);
  });

  it('空白 / 纯空白不落条目（那只会得到一条读不出内容的空行）', () => {
    const before = [entry('已有')];

    expect(appendCommentEntry(before, '')).toHaveLength(1);
    expect(appendCommentEntry(before, '   \n  ')).toHaveLength(1);
    // 真的写进来的正文**首尾空白裁掉**：卡面上不该出现一段莫名其妙的缩进
    expect(appendCommentEntry(before, '  有内容  ', AT)[1].text).toBe('有内容');
  });

  it('返回新数组而不是就地改：重绘与否看的是"内容指纹变没变"', () => {
    const before = [entry('a')];

    const next = appendCommentEntry(before, 'b', AT);

    expect(next).not.toBe(before);
    expect(before).toHaveLength(1);
    expect(next).toHaveLength(2);
  });

  it('删除按 `id` 定位：按 id 删不会像按下标那样"删完一条就整体错位"', () => {
    const list = [entry('a', AT, 'cmt_a'), entry('b', AT, 'cmt_b'), entry('c', AT, 'cmt_c')];

    expect(removeCommentEntry(list, 'cmt_b').map((item) => item.text)).toEqual(['a', 'c']);
    // 删一个不存在的 id = 什么都不删（不是"删掉第一条"）
    expect(removeCommentEntry(list, 'cmt_不存在')).toHaveLength(3);
  });

  it('条目 id 用 `cmt_` 前缀：与卡片 id 分得开，grep 一个 id 不会串台', () => {
    expect(createCommentEntry('正文', AT).id.startsWith('cmt_')).toBe(true);
  });

  it('时间格式化：本地 `MM-DD HH:mm`；`at <= 0` → 「时间未知」而不是 1970 年', () => {
    const zero = new Date(0);
    expect(formatCommentTime(AT)).toMatch(/^09-13 10:05$/);
    // `at = 0` 交给 `commentTimeLabel` 兜底，别把"没记到时间"显示成 1970-01-01
    expect(commentTimeLabel(0)).toBe(t('card.comment.unknownTime'));
    expect(commentTimeLabel(AT)).toBe('09-13 10:05');
    expect(zero.getFullYear()).toBe(1970);
  });
});

// ── 显示态 ────────────────────────────────────────────────────

describe('显示态', () => {
  it('空线程：给一句引导 + 一行「写一条备注」入口，不画空壳', () => {
    const { el } = renderComment({ entries: [], resolved: false }, 'display');

    expect(el.classList.contains('is-empty')).toBe(true);
    expect(el.dataset.placeholder).toBe('true');
    const empty = el.children[0] as FakeElement;
    expect(empty.textContent).toBe(t('card.comment.empty'));
  });

  it('非空：逐条画出时间与正文，每条各渲染一次 Markdown', async () => {
    const renderMarkdown = vi.fn(async () => {});
    const { el } = renderComment(
      { entries: [entry('第一句'), entry('第二句', AT + 60_000)], resolved: false },
      'display',
      { renderMarkdown },
    );

    expect(el.classList.contains('is-empty')).toBe(false);
    expect(el.dataset.placeholder).toBeUndefined();

    const first = rowOf(el, 0);
    expect((first.children[0] as FakeElement).textContent).toBe('09-13 10:05');
    // 悬停能看到完整年份（卡面放不下）
    expect((first.children[0] as FakeElement).title).toBe('2026-09-13 10:05');
    expect((first.children[1] as FakeElement).textContent).toBe('');
    await Promise.resolve();
    expect(renderMarkdown).toHaveBeenCalledTimes(2);
    expect(renderMarkdown).toHaveBeenCalledWith('第一句', expect.anything());
  });

  it('时间戳读不出来（`at = 0`）→ 写「时间未知」，但**这一条照样在**', () => {
    const { el } = renderComment(
      { entries: [entry('手改坏的文件', 0)], resolved: false },
      'display',
    );

    expect((rowOf(el, 0).children[0] as FakeElement).textContent).toBe(
      t('card.comment.unknownTime'),
    );
  });

  it('显示态**没有**输入框，只有一行入口：点它才进编辑态', () => {
    const { el, setMode } = renderComment({ entries: [], resolved: false }, 'display');
    const add = el.children[1] as FakeElement;
    expect(add.className).toBe('nestboard-comment-add');

    add.emit('click', { stopPropagation: () => {} });

    expect(setMode).toHaveBeenCalledWith('edit');
  });

  it('「写一条」入口的按下不冒泡：否则点它只会变成拖整张卡', () => {
    const { el } = renderComment({ entries: [], resolved: false }, 'display');
    const event = createKeyEvent({ key: 'Enter' });
    const add = el.children[1] as FakeElement;

    add.emit('pointerdown', { stopPropagation: () => (event.propagationStopped = true) });

    expect(event.propagationStopped).toBe(true);
  });

  it('已解决：卡面置灰 + 打角标，但线程一条不少', () => {
    const { el } = renderComment({ entries: [entry('已经收口')], resolved: true }, 'display');

    expect(el.classList.contains('is-resolved')).toBe(true);
    expect(el.dataset.commentBadge).toBe(t('card.comment.resolved'));
    // 内容照旧 —— "解决"是卸掉分量，不是清空
    expect((rowOf(el, 0).children[1] as FakeElement).parentNode).toBeTruthy();
  });

  it('节点被复用时会重画：上一张的"已解决"不会被下一张继承', () => {
    const el = createFakeElement(createFakeDocument());
    const render = (resolved: boolean) =>
      commentCard.render(
        el as unknown as HTMLElement,
        createCard('comment', { content: { entries: [], resolved } }),
        contextFor('display'),
      );

    render(true);
    expect(el.dataset.commentBadge).toBe(t('card.comment.resolved'));

    render(false);
    expect(el.classList.contains('is-resolved')).toBe(false);
    expect(el.dataset.commentBadge).toBeUndefined();
  });
});

// ── 编辑态 ────────────────────────────────────────────────────

describe('编辑态', () => {
  it('输入框自动聚焦：双击这张卡的意图几乎一定是"我要说点什么"', () => {
    const { el } = renderComment({ entries: [], resolved: false }, 'edit');

    expect(inputOf(el).focused).toBe(true);
  });

  it('`Enter` 提交：追加到末尾，首尾空白裁掉，`at` 记成"现在"', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-13T10:05:00'));
    try {
      const { el, updateContent } = renderComment(
        { entries: [entry('早就写了')], resolved: false },
        'edit',
      );
      const input = inputOf(el);
      input.value = '  新的一条  ';

      input.emit('keydown', createKeyEvent({ key: 'Enter' }));

      const patch = updateContent.mock.calls[0][0] as { entries: CommentEntry[] };
      expect(patch.entries.map((item) => item.text)).toEqual(['早就写了', '新的一条']);
      expect(patch.entries[1].at).toBe(new Date('2026-09-13T10:05:00').getTime());
    } finally {
      vi.useRealTimers();
    }
  });

  it('空提交：什么都不写，也不让卡片白重画一次', () => {
    const { el, updateContent } = renderComment(
      { entries: [entry('已有')], resolved: false },
      'edit',
    );
    const input = inputOf(el);
    input.value = '   ';

    input.emit('keydown', createKeyEvent({ key: 'Enter' }));

    expect(updateContent).not.toHaveBeenCalled();
  });

  it('`Shift+Enter` 是换行，不是提交（一行的空间里它是唯一的分行键）', () => {
    const { el, updateContent } = renderComment({ entries: [], resolved: false }, 'edit');
    const input = inputOf(el);
    input.value = '第一行';

    const event = createKeyEvent({ key: 'Enter', shiftKey: true });
    input.emit('keydown', event);

    expect(updateContent).not.toHaveBeenCalled();
    // 也不该被 `preventDefault` 掉：换行得真的落进输入框
    expect(event.defaultPrevented).toBe(false);
  });

  it('输入法组词中不接管按键（此刻的 Enter 是在确认候选词，不是提交）', () => {
    const { el, updateContent, setMode } = renderComment({ entries: [], resolved: false }, 'edit');
    const input = inputOf(el);
    input.value = '中';

    // 组词中的 Enter 若被当成提交，用户"打个中文字"就会替自己写进一条备注
    const enter = createKeyEvent({ key: 'Enter', isComposing: true });
    input.emit('keydown', enter);
    // 组词中的 Esc 是在取消候选词，不该顺手把整个编辑态也关掉
    const escape = createKeyEvent({ key: 'Escape', keyCode: 229 });
    input.emit('keydown', escape);

    expect(updateContent).not.toHaveBeenCalled();
    expect(setMode).not.toHaveBeenCalled();
    expect(enter.defaultPrevented).toBe(false);
    expect(escape.defaultPrevented).toBe(false);
  });

  it('`Esc` 退出编辑态，且不碰内容（草稿随重绘一起消失）', () => {
    const { el, updateContent, setMode } = renderComment({ entries: [], resolved: false }, 'edit');
    const input = inputOf(el);
    input.value = '不写了';

    input.emit('keydown', createKeyEvent({ key: 'Escape' }));

    expect(setMode).toHaveBeenCalledWith('display');
    expect(updateContent).not.toHaveBeenCalled();
  });

  it('「×」删掉那一条（也只有那一条），且不冒泡给画布', () => {
    const { el, updateContent } = renderComment(
      { entries: [entry('a', AT, 'cmt_a'), entry('b', AT, 'cmt_b')], resolved: false },
      'edit',
    );
    const remove = rowOf(el, 0).children[2] as FakeElement;
    const event = createKeyEvent({ key: 'Enter' });

    remove.emit('click', { stopPropagation: () => (event.propagationStopped = true) });

    expect(updateContent).toHaveBeenCalledWith({ entries: [entry('b', AT, 'cmt_b')] });
    expect(event.propagationStopped).toBe(true);
  });

  it('显示态没有「×」：删历史该是个要动手的决定，不该常驻在眼前', () => {
    const { el } = renderComment({ entries: [entry('a')], resolved: false }, 'display');

    expect(rowOf(el, 0).children).toHaveLength(2);
  });
});

// ── 右键菜单 ──────────────────────────────────────────────────

describe('右键菜单', () => {
  it('未解决 → 「标记为已解决」；已解决 → 「重新打开」', () => {
    const open = createCard('comment', { content: { entries: [], resolved: false } });
    const done = createCard('comment', { content: { entries: [], resolved: true } });

    const openItem = (commentCard.contextMenu?.(open, { multiple: false }) ?? [])[0];
    const doneItem = (commentCard.contextMenu?.(done, { multiple: false }) ?? [])[0];

    expect(openItem.action).toBe('toggleCommentResolved');
    expect(openItem.title).toBe(t('menu.card.commentResolve'));
    expect(doneItem.title).toBe(t('menu.card.commentReopen'));
  });

  it('多选下置灰（"解决哪一条线程"没有唯一合理解释）', () => {
    const card = createCard('comment', { content: { entries: [], resolved: false } });

    const items = commentCard.contextMenu?.(card, { multiple: true }) ?? [];

    expect(items).toHaveLength(1);
    expect(items[0].disabled).toBe(true);
  });
});
