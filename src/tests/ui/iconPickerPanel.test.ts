/**
 * 图标选择面板（`2.1.5`）—— 纯 DOM 构件。
 *
 * 钉的是**这一版重写的四条几何规矩**（用户 2026-09-28："这里的整个组件最好规划一下重写"），
 * 每一条都对应一次真实报障：
 *
 *  * 两页共用**一块固定高的视口** ⇒ 切页时整个 UI 尺寸不变（从前会跳一下）；
 *  * 两页**各记各的滚动**，且任何时刻只有一页可见 ⇒ 只有一根滚动条（从前两根，
 *    滚到底还能滚出框外）；
 *  * 每一页都**自报"滚轮归我"**（`data-nestboard-wheel-scroll`）⇒ 画布那层
 *    （`BoardView.scrollBodyUnder`）会把滚轮让给它，在面板上滚轮不会缩放 / 平移画布；
 *  * 像素页的**格子类名**是那套"每行 8 个正方形底框"的排法（列数由样式表定，
 *    这里守的是"它没被换回 emoji 那种排法"）。
 */

import { describe, expect, it, vi } from 'vitest';

import { buildIconPickerPanel, WHEEL_SCROLL_ATTR } from '../../ui/iconPickerPanel';
import { createFakeDocument, type FakeElement } from '../helpers/fakeDom';

function build(current?: string) {
  const onPick = vi.fn();
  const doc = createFakeDocument() as unknown as Document;
  const panel = buildIconPickerPanel(doc, {
    current,
    tabLabels: { emoji: 'Emoji', pixel: '复古游戏机' },
    searchPlaceholder: '挑一个',
    emojiTitleOf: () => '分组',
    onPick,
  });
  const root = panel.element as unknown as FakeElement;
  const child = (index: number): FakeElement => root.children[index] as FakeElement;
  const tabs = child(0);
  const search = child(1);
  const viewport = child(2);
  const pageOf = (tab: 'emoji' | 'pixel'): FakeElement =>
    (viewport.children as FakeElement[]).find((page) => page.dataset.tab === tab) as FakeElement;
  return { panel, onPick, root, tabs, search, viewport, pageOf };
}

/** 当前可见的是哪一页（另一页应当是 `is-hidden`） */
function visiblePages(viewport: FakeElement): string[] {
  return (viewport.children as FakeElement[])
    .filter((page) => !page.classList.contains('is-hidden'))
    .map((page) => page.dataset.tab ?? '?');
}

describe('iconPickerPanel × 骨架', () => {
  it('标签行（两个横排的按钮）+ 搜索框 + 视口', () => {
    const { tabs, search, viewport } = build();
    const buttons = tabs.children as FakeElement[];
    expect(buttons).toHaveLength(2);
    expect(buttons.map((button) => button.textContent)).toEqual(['Emoji', '复古游戏机']);
    expect(search.placeholder).toBe('挑一个');
    // ★ 视口是**独立的一格**：两页都铺在它里面 ⇒ 高度由它一处定（见样式表的 `__viewport`）
    expect(viewport.className).toBe('nestboard-iconpicker__viewport');
    expect(viewport.children).toHaveLength(2);
  });

  it('★ 打开时只显示第一页（第二页 `is-hidden`）', () => {
    const { tabs, viewport } = build();
    expect(visiblePages(viewport)).toEqual(['emoji']);
    expect((tabs.children as FakeElement[])[0]?.classList.contains('is-active')).toBe(true);
  });
});

describe('iconPickerPanel × 切页', () => {
  it('★ 点第二个标签：可见的只剩像素页，标签的选中态跟着走', () => {
    const { panel, tabs, viewport, pageOf } = build();
    (tabs.children as FakeElement[])[1]?.emit('click', { stopPropagation: () => {} });

    expect(visiblePages(viewport)).toEqual(['pixel']);
    expect(panel.activeTab()).toBe('pixel');
    const buttons = tabs.children as FakeElement[];
    expect(buttons.map((button) => button.classList.contains('is-active'))).toEqual([false, true]);
    // ★ 两页都还在 DOM 里（切换只是显隐）：回来时**滚动位置与 DOM 都保留**
    expect(pageOf('emoji').children.length).toBe(1);
  });
});

describe('iconPickerPanel × 滚轮归面板', () => {
  it('★ 两页都自报 `data-nestboard-wheel-scroll`（画布据此把滚轮让给它）', () => {
    const { pageOf } = build();
    for (const tab of ['emoji', 'pixel'] as const) {
      expect(pageOf(tab).attributes.has(WHEEL_SCROLL_ATTR)).toBe(true);
      // 值是空串：它只是"自报家门"的记号，不携带数据
      expect(pageOf(tab).attributes.get(WHEEL_SCROLL_ATTR)).toBe('');
    }
  });
});

describe('iconPickerPanel × 两页的内容', () => {
  it('emoji 页是分组网格；像素页是"每行 8 个正方形底框"那套类名', () => {
    const { pageOf } = build();
    const emojiPanel = pageOf('emoji').children[0] as FakeElement;
    expect(emojiPanel.className).toBe('nestboard-emoji-panel');

    const pixelPanel = pageOf('pixel').children[0] as FakeElement;
    expect(pixelPanel.className).toBe('nestboard-pixel-panel');
    // 网格与格子的类名（列数由样式表的 `repeat(8, 1fr)` 定；这里守"没被换回 emoji 排法"）
    const grids = (pixelPanel.children as FakeElement[]).flatMap((section) =>
      (section.children as FakeElement[]).filter(
        (child) => child.className === 'nestboard-iconpicker__pixels',
      ),
    );
    expect(grids.length).toBeGreaterThan(0);
    const cells = grids[0]?.children as FakeElement[];
    expect(cells.length).toBeGreaterThan(0);
    for (const cell of cells) {
      expect(cell.className).toBe('nestboard-iconpicker__pixel');
    }
  });

  it('搜索：两页一起筛（切过去时已经是筛好的）', () => {
    const { search, pageOf } = build();
    search.value = '绝对匹配不到的词';
    search.emit('input', {});

    // 像素页：命中不到 ⇒ 照旧显示全部（`pixelIconGrid` 第 3 条人情味）
    const pixelPanel = pageOf('pixel').children[0] as FakeElement;
    const hidden = (pixelPanel.children as FakeElement[]).filter((section) =>
      section.classList.contains('is-hidden'),
    );
    expect(hidden).toHaveLength(0);
  });
});

describe('iconPickerPanel × 登记（脑图工具栏那条弹层用）', () => {
  it('像素格与 emoji 格都会登记一次（值为空的那一格除外）', () => {
    const seen: string[] = [];
    const doc = createFakeDocument() as unknown as Document;
    buildIconPickerPanel(doc, {
      tabLabels: { emoji: 'Emoji', pixel: '复古游戏机' },
      emojiTitleOf: () => '分组',
      onPick: () => undefined,
      register: (_cell, value) => seen.push(value),
    });
    expect(seen.length).toBeGreaterThan(0);
    // 钉在最前面那一格（空值）不登记：它随输入框变，登记了只会多一条永不匹配的记录
    expect(seen).not.toContain('');
  });
});
