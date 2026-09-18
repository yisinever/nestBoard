/**
 * 仅标题卡（`A3`；同日按用户反馈简化：**只保留纯圆角**）。
 *
 * 钉四件事：
 *
 *  1. **那行字 = 卡片标题**（`CardBase.title`，不是 `content.text`）—— 用户 2026-09-18：
 *     "应该直接展示标题文字"；
 *  2. **卡片级字段真的生效**：`card.icon` 画在文字前面、`card.titleStyle` 的
 *     粗 / 斜 / 下划线 / 字色写在那一行上 —— 它们从前存得进去、却没人画；
 *  3. **就地编辑三条收口**：`Enter` 提交、`Esc` 放弃、**没改就不写**（写的是标题）；
 *  4. **不再自带右键菜单**（气泡那一档没了）⇒ 走通用的那份（颜色 / 层级 / 锁定…）。
 */

import { describe, expect, it, vi } from 'vitest';
import { TITLE_CARD_DEFAULT_SIZE, titleCard } from '../../cards/titleCard';
import type { CardRenderContext } from '../../cards/registry';
import { createCard } from '../../model/factories';
import {
  createFakeDocument,
  createFakeElement,
  createKeyEvent,
  type FakeElement,
} from '../helpers/fakeDom';

interface Setup {
  el: FakeElement;
  updateCard: ReturnType<typeof vi.fn>;
  setMode: ReturnType<typeof vi.fn>;
}

function setup(
  title: string,
  extra: { mode?: 'display' | 'edit'; icon?: string; style?: object } = {},
): Setup {
  const doc = createFakeDocument();
  const el = createFakeElement(doc);
  const updateCard = vi.fn();
  const setMode = vi.fn();
  const ctx = {
    mode: extra.mode ?? 'display',
    updateCard,
    setMode,
  } as unknown as CardRenderContext;

  titleCard.render(
    el as unknown as HTMLElement,
    createCard('titleCard', {
      title,
      icon: extra.icon,
      titleStyle: extra.style,
    } as never),
    ctx,
  );
  return { el, updateCard, setMode };
}

/** 深度优先按类名找（假 DOM 没有 `querySelector`） */
function find(el: FakeElement, className: string): FakeElement | undefined {
  if (el.classList.contains(className)) return el;
  for (const child of el.children as FakeElement[]) {
    const hit = find(child, className);
    if (hit) return hit;
  }
  return undefined;
}

describe('titleCard 定义', () => {
  it('类型 / 图标 / 一行字那么高的默认尺寸 / 内容留一个空的 `text`（旧字段，已迁到标题）', () => {
    expect(titleCard.type).toBe('titleCard');
    expect(titleCard.icon).toBe('tag');
    expect(titleCard.defaultSize).toEqual(TITLE_CARD_DEFAULT_SIZE);
    expect(titleCard.createDefaultContent()).toEqual({ text: '' });
  });

  it('★ 不再自带右键菜单（气泡那一档去掉之后，那几项没有了）⇒ 用通用那份', () => {
    expect(titleCard.contextMenu).toBeUndefined();
  });

  it('★ 通用菜单里关掉那三项对它没意义的（编辑内容 / 显示隐藏标题 / 收起）', () => {
    expect(titleCard.menuItems).toEqual({
      editContent: false,
      showTitle: false,
      collapse: false,
    });
  });

  it('★ 就地编辑仍可行（没有 `onDoubleClick` ⇒ 注册表的 `inlineEditable` 自动为真）', () => {
    expect(titleCard.onDoubleClick).toBeUndefined();
  });

  it('导出 / 收起后的那一行读的都是**卡片标题**', () => {
    const card = createCard('titleCard', { title: '待确认' });
    expect(titleCard.toMarkdown(card, { sourcePath: '' })).toBe('待确认');
    expect(titleCard.collapsedTitle?.(card)).toBe('待确认');
  });
});

describe('titleCard.render', () => {
  it('画出**标题**那一行字；空的那张带 `is-empty` + 提示语', () => {
    const filled = setup('标签');
    expect(find(filled.el, 'nestboard-title-card-text')?.textContent).toBe('标签');
    expect(filled.el.classList.contains('is-empty')).toBe(false);

    const empty = setup('');
    expect(empty.el.classList.contains('is-empty')).toBe(true);
    expect(find(empty.el, 'nestboard-title-card-text')?.textContent).not.toBe('');
  });

  it('★ 只认标题：把同一句话放在 `content.text` 里**不会**被画出来', () => {
    const doc = createFakeDocument();
    const el = createFakeElement(doc);
    const ctx = { mode: 'display', updateCard: vi.fn(), setMode: vi.fn() } as unknown as CardRenderContext;
    titleCard.render(
      el as unknown as HTMLElement,
      createCard('titleCard', { title: '', content: { text: '内容里的字' } } as never),
      ctx,
    );
    expect(find(el, 'nestboard-title-card-text')?.textContent).not.toBe('内容里的字');
  });

  it('★ 标记（`card.icon`）画在文字前面（与便签 / 白板卡同一个字段）', () => {
    const { el } = setup('标签', { icon: '🔥' });
    expect(find(el, 'nestboard-title-card-icon')?.textContent).toBe('🔥');

    const none = setup('标签');
    expect(find(none.el, 'nestboard-title-card-icon')).toBeUndefined();
  });

  it('★ `card.titleStyle` 的粗 / 斜 / 下划线 / 字色真的写在那一行上', () => {
    const { el } = setup('标签', {
      style: { bold: true, italic: true, underline: true, ink: '#ff0000' },
    });
    const line = find(el, 'nestboard-title-card-text')!;

    expect(line.style.getPropertyValue('font-weight')).not.toBe('normal');
    expect(line.style.getPropertyValue('font-style')).toBe('italic');
    expect(line.style.getPropertyValue('text-decoration')).toBe('underline');
    expect(line.style.getPropertyValue('color')).toBe('#ff0000');
  });

  it('★ 没挑过格式时**不写**字色（落回样式表里的白），也不加粗不斜', () => {
    const { el } = setup('标签');
    const line = find(el, 'nestboard-title-card-text')!;

    expect(line.style.getPropertyValue('color')).toBe('');
    expect(line.style.getPropertyValue('font-weight')).toBe('normal');
    expect(line.style.getPropertyValue('text-decoration')).toBe('none');
  });
});

describe('titleCard 就地编辑', () => {
  it('编辑态 = 一行输入框，初值是当前标题', () => {
    const { el } = setup('原标题', { mode: 'edit' });
    expect(el.classList.contains('is-editing')).toBe(true);
    expect((el.children[0] as FakeElement).value).toBe('原标题');
  });

  it('★ `Enter` 提交（去掉首尾空白）写回**标题**，并回到显示态', () => {
    const { el, updateCard, setMode } = setup('原标题', { mode: 'edit' });
    const input = el.children[0] as FakeElement;
    input.value = '  改过的  ';
    input.emit('keydown', createKeyEvent({ key: 'Enter' }));

    expect(updateCard).toHaveBeenCalledWith({ title: '改过的' });
    expect(setMode).toHaveBeenCalledWith('display');
  });

  it('★ `Esc` 放弃：一个字都不写', () => {
    const { el, updateCard, setMode } = setup('原标题', { mode: 'edit' });
    const input = el.children[0] as FakeElement;
    input.value = '不要这个';
    input.emit('keydown', createKeyEvent({ key: 'Escape' }));

    expect(updateCard).not.toHaveBeenCalled();
    expect(setMode).toHaveBeenCalledWith('display');
  });

  it('★ 没改就不写（每次点进点出都递增 revision 会把文件标脏）', () => {
    const { el, updateCard } = setup('原标题', { mode: 'edit' });
    (el.children[0] as FakeElement).emit('keydown', createKeyEvent({ key: 'Enter' }));
    expect(updateCard).not.toHaveBeenCalled();
  });

  it('组字中的 `Enter` 不算提交（中文输入的选字不能被当成"写完了"）', () => {
    const { el, updateCard } = setup('原标题', { mode: 'edit' });
    const input = el.children[0] as FakeElement;
    input.value = '拼音中';
    input.emit('keydown', createKeyEvent({ key: 'Enter', isComposing: true }));
    expect(updateCard).not.toHaveBeenCalled();
  });
});
