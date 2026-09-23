/**
 * 图集卡（`A4`）。
 *
 * 钉四件事：
 *
 *  1. **一次拖两张以上图片 ⇒ 一张图集卡**（而不是 N 张散图）—— 这是这张卡唯一的入口，
 *     判据在 `model/drop.ts` 的 `cardsForDropPaths` 里，错了整个功能就没有入口；
 *  2. **`index` 越界要夹住**：文件里的坏值不该让卡面一片空白；
 *  3. **翻页到头回环**，且只有一张图时不接管双击；
 *  4. **画出来的结构**：后面两张露边的牌堆 + `3 / 7` 角标（少一层就"看不出不止一张"）。
 */

import { describe, expect, it, vi } from 'vitest';
import { GALLERY_DEFAULT_SIZE, galleryCard } from '../../cards/gallery';
import type { CardActionContext, CardRenderContext } from '../../cards/registry';
import { createCard } from '../../model/factories';
import { cardsForDropPaths } from '../../model/drop';
import { createFakeDocument, createFakeElement, type FakeElement } from '../helpers/fakeDom';

function renderGallery(
  content: { paths: string[]; index?: number },
  options: { url?: string | null } = {},
): { el: FakeElement; updateContent: ReturnType<typeof vi.fn> } {
  const doc = createFakeDocument();
  const el = createFakeElement(doc);
  // ★ 渲染里翻页走的是 `updateContent`（`CardRenderContext` 只有这个口子），
  //   而双击那条走 `applyContent`（动作上下文）—— 两个都不许混
  const updateContent = vi.fn();
  const ctx = {
    mode: 'display',
    applyContent: vi.fn(),
    updateContent,
    setMode: vi.fn(),
    notes: {
      exists: () => true,
      resourceUrl: () => (options.url === undefined ? 'app://local/img' : options.url),
    },
  } as unknown as CardRenderContext;

  galleryCard.render(
    el as unknown as HTMLElement,
    createCard('gallery', { content: content as never }),
    ctx,
  );
  return { el, updateContent };
}

const find = (el: FakeElement, className: string): FakeElement | undefined => {
  if (el.classList.contains(className)) return el;
  for (const child of el.children as FakeElement[]) {
    const hit = find(child, className);
    if (hit) return hit;
  }
  return undefined;
};

describe('galleryCard 定义', () => {
  it('类型 / 图标 / 与图片卡同宽的默认尺寸 / 默认内容', () => {
    expect(galleryCard.type).toBe('gallery');
    expect(galleryCard.icon).toBe('images');
    expect(galleryCard.defaultSize).toEqual(GALLERY_DEFAULT_SIZE);
    expect(galleryCard.createDefaultContent()).toEqual({ paths: [] });
  });

  it('★ 一次拖两张以上图片 ⇒ **一张图集卡**（这就是它唯一的入口）', () => {
    const cards = cardsForDropPaths(
      ['a.png', 'b.png', 'c.png'],
      [
        { x: 0, y: 0 },
        { x: 30, y: 30 },
        { x: 60, y: 60 },
      ],
    );
    expect(cards).toHaveLength(1);
    expect(cards[0]?.type).toBe('gallery');
    expect((cards[0]?.content as { paths: string[] }).paths).toEqual(['a.png', 'b.png', 'c.png']);
  });

  it('★ 单张图仍是图片卡；混着别的文件时照旧一张一个卡（不许把 pdf 也塞进图集）', () => {
    const one = cardsForDropPaths(['a.png'], [{ x: 0, y: 0 }]);
    expect(one.map((card) => card.type)).toEqual(['image']);

    const mixed = cardsForDropPaths(['a.png', 'doc.docx'], [{ x: 0, y: 0 }]);
    expect(mixed.map((card) => card.type)).toEqual(['image', 'file']);

    // `.pdf` 有自己的**预览卡**（`F8`），不是文件卡 —— 但它同样不该被塞进图集
    const withPdf = cardsForDropPaths(['a.png', 'doc.pdf'], [{ x: 0, y: 0 }]);
    expect(withPdf.map((card) => card.type)).toEqual(['image', 'pdf']);
  });

  it('导出成 Markdown：一组内嵌，顺序就是卡面上的顺序', () => {
    const card = createCard('gallery', { content: { paths: ['a.png', 'b.png'] } });
    expect(galleryCard.toMarkdown(card, { sourcePath: '' })).toBe('![[a.png]]\n![[b.png]]');
  });

  it('收起后那一行是 `3 / 7`（它的 `title` 永远是空的，不接管就是一条空白）', () => {
    const card = createCard('gallery', { content: { paths: ['a', 'b', 'c'], index: 2 } });
    expect(galleryCard.collapsedTitle?.(card)).toContain('3');
    expect(galleryCard.collapsedTitle?.(card)).toContain('3 / 3');
  });
});

describe('galleryCard.render', () => {
  it('★ 结构：后面两张露边的牌堆 + 当前图 + `2 / 3` 角标', () => {
    const { el } = renderGallery({ paths: ['a.png', 'b.png', 'c.png'], index: 1 });

    expect(find(el, 'nestboard-gallery-stack')).toBeDefined();
    expect(find(el, 'is-behind-1')).toBeDefined();
    expect(find(el, 'is-behind-2')).toBeDefined();
    expect(find(el, 'nestboard-gallery-image')).toBeDefined();
    expect(find(el, 'nestboard-gallery-counter')?.textContent).toBe('2 / 3');
  });

  it('★ `index` 越界夹住（9 / -3 / NaN 都落回合法范围）', () => {
    expect(
      find(renderGallery({ paths: ['a.png', 'b.png'], index: 9 }).el, 'nestboard-gallery-counter')
        ?.textContent,
    ).toBe('2 / 2');
    expect(
      find(renderGallery({ paths: ['a.png', 'b.png'], index: -3 }).el, 'nestboard-gallery-counter')
        ?.textContent,
    ).toBe('1 / 2');
    expect(
      find(
        renderGallery({ paths: ['a.png', 'b.png'], index: Number.NaN }).el,
        'nestboard-gallery-counter',
      )?.textContent,
    ).toBe('1 / 2');
  });

  it('一张图都没有 ⇒ 占位语（并带上 `is-empty`）', () => {
    const { el } = renderGallery({ paths: [] });
    expect(el.classList.contains('is-empty')).toBe(true);
  });

  it('这一张拿不到资源 URL ⇒ 说清楚是**哪一张**（不留一片空白）', () => {
    const { el } = renderGallery({ paths: ['assets/gone.png'] }, { url: null });
    expect(el.classList.contains('is-missing')).toBe(true);
    const [text] = el.children as unknown as { textContent?: string }[];
    expect(text?.textContent ?? '').toContain('assets/gone.png');
  });
});

describe('galleryCard 翻页', () => {
  it('★ 点右箭头 ⇒ 写回 `index + 1`，并挡住冒泡（不挡就变成拖卡 / 框选）', () => {
    const { el, updateContent } = renderGallery({ paths: ['a.png', 'b.png', 'c.png'] });
    const arrows = (find(el, 'nestboard-gallery-stack')!.children as FakeElement[]).filter(
      (child) => child.classList.contains('nestboard-gallery-arrow'),
    );
    const nextBtn = arrows.find((child) => child.dataset.direction === 'next')!;

    const down = { stopPropagation: vi.fn() } as unknown as Event;
    nextBtn.emit('pointerdown', down);
    expect(
      (down as unknown as { stopPropagation: ReturnType<typeof vi.fn> }).stopPropagation,
    ).toHaveBeenCalledTimes(1);

    nextBtn.emit('click', { stopPropagation: vi.fn() } as unknown as Event);
    expect(updateContent).toHaveBeenCalledWith({ index: 1 });
  });

  it('★ 第一张按"上一张"回环到最后一张（一组图是循环看的）', () => {
    const { el, updateContent } = renderGallery({ paths: ['a.png', 'b.png', 'c.png'] });
    const arrows = (find(el, 'nestboard-gallery-stack')!.children as FakeElement[]).filter(
      (child) => child.classList.contains('nestboard-gallery-arrow'),
    );
    arrows
      .find((child) => child.dataset.direction === 'prev')!
      .emit('click', { stopPropagation: vi.fn() } as unknown as Event);

    expect(updateContent).toHaveBeenCalledWith({ index: 2 });
  });

  it('★ 双击 = 下一张；只有一张图时不接管（那一下交给视图）', () => {
    const many = vi.fn();
    const manyCtx = { applyContent: many } as unknown as CardActionContext;
    expect(
      galleryCard.onDoubleClick?.(
        createCard('gallery', { content: { paths: ['a', 'b'] } }),
        manyCtx,
      ),
    ).toBe(true);
    expect(many).toHaveBeenCalledWith({ index: 1 });

    const single = vi.fn();
    const singleCtx = { applyContent: single } as unknown as CardActionContext;
    expect(
      galleryCard.onDoubleClick?.(createCard('gallery', { content: { paths: ['a'] } }), singleCtx),
    ).toBe(false);
    expect(single).not.toHaveBeenCalled();
  });
});
