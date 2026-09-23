/**
 * PDF 预览卡（`F8`）的卡面：占位、`<embed>` 的地址、翻页。
 *
 * ★ 用假 DOM 测（与 `cards/` 其余几张卡同一套）：这里钉的是"空卡给不给引导"、
 *   "地址里带不带 `#page=`"这两个**错了会一眼看出来但很难查**的地方。
 * ★ 翻页那一条顺手把"页码状态不进模型"也钉住了：`render` 只读元素上的 `data-pdf-page`。
 */

import { describe, expect, it } from 'vitest';
import { pdfCard, PDF_CARD_DEFAULT_SIZE } from '../../cards/pdf';
import type { CardRenderContext } from '../../cards/registry';
import type { CardOf } from '../../model/schema';
import { createFakeDocument } from '../helpers/fakeDom';

/** 只用到"库内路径 → 资源地址"这一件事，其余字段这一组用例都不碰 */
function ctxOf(): CardRenderContext {
  return {
    app: { vault: { adapter: { getResourcePath: (path: string) => `app://local/${path}` } } },
  } as unknown as CardRenderContext;
}

function cardOf(path: string): CardOf<'pdf'> {
  return { content: { path, showSize: false } } as unknown as CardOf<'pdf'>;
}

/** 顺 `children` 找第一个带这个 class 的后代（假 DOM 没有 `querySelector`） */
interface FakeEl {
  tagName: string;
  className: string;
  textContent: string;
  children: unknown[];
  attributes: Map<string, string>;
}
const asEl = (value: unknown): FakeEl => value as FakeEl;
function findByClass(root: unknown, className: string): FakeEl | null {
  for (const child of asEl(root).children) {
    const el = asEl(child);
    if (el.className.split(/\s+/).includes(className)) return el;
    const deeper = findByClass(el, className);
    if (deeper) return deeper;
  }
  return null;
}

describe('PDF 预览卡（`F8`）', () => {
  it('尺寸是 A4 竖版比例（一页纸长什么样，卡片就长什么样）', () => {
    expect(PDF_CARD_DEFAULT_SIZE.width / PDF_CARD_DEFAULT_SIZE.height).toBeCloseTo(0.8, 2);
    expect(pdfCard.defaultSize).toEqual(PDF_CARD_DEFAULT_SIZE);
  });

  it('空卡（还没拖文件）：给一句引导，不留一片白', () => {
    const el = createFakeDocument().createElement('div') as unknown as HTMLElement;
    pdfCard.render(el, cardOf(''), ctxOf());

    const empty = findByClass(el, 'nestboard-pdf-empty');
    expect(empty).not.toBeNull();
    // 没有 `embed`：空路径不该去挂一个空白查看器
    expect(findByClass(el, 'nestboard-pdf-frame')).toBeNull();
  });

  it('★ 有文件：`<embed>` 指向 `app://` 地址，并带 `#page=1`（翻页就靠它）', () => {
    const el = createFakeDocument().createElement('div') as unknown as HTMLElement;
    pdfCard.render(el, cardOf('资料/白皮书.pdf'), ctxOf());

    const frame = findByClass(el, 'nestboard-pdf-frame');
    expect(frame?.tagName).toBe('EMBED');
    expect(frame?.attributes.get('type')).toBe('application/pdf');
    expect(frame?.attributes.get('src')).toBe('app://local/资料/白皮书.pdf#page=1');
    // 翻页条与页码都在
    expect(findByClass(el, 'nestboard-pdf-bar')).not.toBeNull();
    expect(findByClass(el, 'nestboard-pdf-label')?.textContent).toContain('1');
  });

  it('★ 页码读的是**元素上**的状态（`data-pdf-page`）——不进模型、不进撤销栈', () => {
    const el = createFakeDocument().createElement('div') as unknown as HTMLElement;
    // 模拟"上次停在第 3 页"（视图重画时元素会带着这个状态回来）
    (el as unknown as { dataset: Record<string, string> }).dataset['pdfPage'] = '3';
    pdfCard.render(el, cardOf('a.pdf'), ctxOf());

    expect(findByClass(el, 'nestboard-pdf-frame')?.attributes.get('src')).toBe(
      'app://local/a.pdf#page=3',
    );
  });

  it('回收时把页码与内容一起清掉（元素会进复用池，不能把上一张的状态带走）', () => {
    const el = createFakeDocument().createElement('div') as unknown as HTMLElement;
    pdfCard.render(el, cardOf('a.pdf'), ctxOf());
    pdfCard.destroy?.(el);

    expect(asEl(el).children).toHaveLength(0);
  });
});
