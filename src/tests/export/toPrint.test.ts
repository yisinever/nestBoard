/**
 * 打印（T6.03 / `F9-10`）单测。
 *
 * 打印这条路的"静默出错"有两种，各盯一类：
 *  1. **分页与 PDF 不一致**：几何是复用 `planPdfExport` 的，所以要*真的*和它对齐断言，
 *     而不是"看起来页数差不多"——一旦有人给打印单独改一个默认值，这里立刻会红；
 *  2. **拼出来的 HTML 是给浏览器看的**：属性少一个引号、页脚没转义、`@page` 方向写死，
 *     在单测里都不会报错，只会让纸上少一页 / 名字里带引号的白板把文档写坏。
 *     所以这里把 HTML 当**字符串规范**来断言，而不是"包含某个类名就算过"。
 *
 * ★ 真正"调起打印对话框"那一步（iframe + `window.print()`）不在单测覆盖范围内 ——
 *   它必须在真实宿主里人工验；这里只保证**喂给它的那份文档**是对的。
 */

import { describe, expect, it } from 'vitest';
import {
  A4_LANDSCAPE,
  A4_PORTRAIT,
  DEFAULT_PDF_PX_PER_PAGE,
  PDF_PAGE_MARGIN,
  planPdfExport,
} from '../../export/toPdf';
import {
  DEFAULT_PRINT_PX_PER_PAGE,
  PRINT_MM_PER_PT,
  buildPrintDocument,
  escapeHtml,
  planPrintExport,
  posterHint,
} from '../../export/toPrint';
import type { PrintExportOptions } from '../../export/toPrint';
import type { PrintPageImage } from '../../export/toPrint';

function page(index: number, dataUrl = `data:image/jpeg;base64,AAAA${index}`): PrintPageImage {
  return { dataUrl, width: 538, height: 785, index };
}

// ─────────────────────────────────────────────────────────────
// 1 · 分页：必须和 PDF 同源
// ─────────────────────────────────────────────────────────────

describe('planPrintExport · 与 PDF 同源', () => {
  it('空边界 → 零页，但纸张信息仍可用（面板要拿它写摘要）', () => {
    const plan = planPrintExport(null);
    expect(plan.pages).toEqual([]);
    expect(plan.columns).toBe(0);
    expect(plan.rows).toBe(0);
    expect(plan.pageWidth).toBe(A4_PORTRAIT.width);
    expect(plan.pageHeight).toBe(A4_PORTRAIT.height);
  });

  it('和 planPdfExport 在同一清晰度下**逐字段相等**（不存在"打印另算一套"）', () => {
    const bounds = { x: -120, y: 80, width: 2400, height: 1900 };
    for (const orientation of ['portrait', 'landscape'] as const) {
      expect(planPrintExport(bounds, { orientation })).toEqual(
        planPdfExport(bounds, { orientation, pxPerPage: DEFAULT_PRINT_PX_PER_PAGE }),
      );
    }
  });

  it('无视调用方塞进来的 pxPerPage：清晰度是钉死的（面板上根本没有这个开关）', () => {
    const bounds = { x: 0, y: 0, width: 1200, height: 900 };
    // ★ 强转是**故意**的：类型上 `pxPerPage` 已经被摘掉（见 `PrintExportOptions`），
    //   这里模拟的是绕过类型的那条路（JS 调用方 / 有人硬塞）—— 运行时也必须钉死
    const plan = planPrintExport(bounds, { pxPerPage: 4096 } as PrintExportOptions);
    expect(plan.pxPerPage).toBe(DEFAULT_PRINT_PX_PER_PAGE);
    // 每页像素确实按钉死的那档算（而不是"值被改了、像素按旧的算"）。
    // 多出来的一点是 `alignTile` 向外取整到网格的余量，所以给一格上限
    for (const item of plan.pages) {
      const edge = Math.max(item.pixelWidth, item.pixelHeight);
      expect(edge).toBeGreaterThanOrEqual(DEFAULT_PRINT_PX_PER_PAGE);
      expect(edge).toBeLessThan(DEFAULT_PRINT_PX_PER_PAGE + 256);
    }
  });

  it('打印的清晰度低于 PDF 默认值（即刻消耗的产物不该按档案标准吃内存）', () => {
    expect(DEFAULT_PRINT_PX_PER_PAGE).toBeLessThan(DEFAULT_PDF_PX_PER_PAGE);
  });

  it('大板照样按纸面切网格：1600×1700 → 3×3 = 9 页', () => {
    const plan = planPrintExport({ x: 0, y: 0, width: 1600, height: 1700 });
    expect([plan.columns, plan.rows, plan.pages.length]).toEqual([3, 3, 9]);
  });

  it('范围透传：`selection` 只是把边界交出去，几何仍由 toPdf 决定', () => {
    const bounds = { x: 0, y: 0, width: 900, height: 400 };
    const a = planPrintExport(bounds, { range: 'selection' });
    const b = planPrintExport(bounds, { range: 'all' });
    // 边界相同 → 结果必须相同（`range` 不该在打印这一层再产生任何差异）
    expect(a).toEqual(b);
  });
});

// ─────────────────────────────────────────────────────────────
// 2 · 分幅（海报）提示：只有真跨页才说
// ─────────────────────────────────────────────────────────────

describe('posterHint · 什么时候才说"要拼"', () => {
  it('单页不说（在单页板子上提"相邻页重叠"是噪音）', () => {
    expect(posterHint({ columns: 1, rows: 1 })).toBe(false);
  });

  it('横向或纵向跨页都要说', () => {
    expect(posterHint({ columns: 2, rows: 1 })).toBe(true);
    expect(posterHint({ columns: 1, rows: 3 })).toBe(true);
    expect(posterHint({ columns: 2, rows: 2 })).toBe(true);
  });

  it('真的接在 plan 上：小板单页 false、大板 9 页 true', () => {
    expect(posterHint(planPrintExport({ x: 0, y: 0, width: 300, height: 200 }))).toBe(false);
    expect(posterHint(planPrintExport({ x: 0, y: 0, width: 1600, height: 1700 }))).toBe(true);
  });

  it('零页不算"跨页"（空板不该弹出拼贴提示）', () => {
    expect(posterHint(planPrintExport(null))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────
// 3 · HTML 转义
// ─────────────────────────────────────────────────────────────

describe('escapeHtml', () => {
  it('转义 & < > "', () => {
    expect(escapeHtml(`<a href="x">A & B</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;A &amp; B&lt;/a&gt;',
    );
  });

  it('不动 data URL：base64 里的 + / = 必须原样保留（转义它们会毁掉图片）', () => {
    const url = 'data:image/jpeg;base64,aGVsbG8+/=w==';
    expect(escapeHtml(url)).toBe(url);
  });

  it('单引号不转义也安全：我们所有属性都用双引号包着', () => {
    expect(escapeHtml("it's")).toBe("it's");
  });
});

// ─────────────────────────────────────────────────────────────
// 4 · 组装打印文档
// ─────────────────────────────────────────────────────────────

describe('buildPrintDocument · 交给浏览器的整份文档', () => {
  it('纵向：@page 与页面盒都是 A4 纵向（210 × 297mm）', () => {
    const html = buildPrintDocument({ pages: [page(0)], orientation: 'portrait' });
    expect(html).toContain('@page { size: A4 portrait; margin: 0; }');
    expect(html).toContain('width: 210mm;');
    expect(html).toContain('height: 297mm;');
    // 页面自带的浏览器默认页边距会吃掉我们的 10mm，必须自己清零、用 padding 留白
    expect(html).toContain(`padding: ${PDF_PAGE_MARGIN}pt;`);
  });

  it('横向：@page 与页面盒宽高互换', () => {
    const html = buildPrintDocument({ pages: [page(0)], orientation: 'landscape' });
    expect(html).toContain('@page { size: A4 landscape; margin: 0; }');
    expect(html).toContain('width: 297mm;');
    expect(html).toContain('height: 210mm;');
  });

  it('pt → mm 换算用的是同一个常量（谁也不许悄悄改纸宽）', () => {
    expect(PRINT_MM_PER_PT).toBeCloseTo(25.4 / 72, 10);
    const html = buildPrintDocument({ pages: [page(0)], orientation: 'portrait' });
    expect(html).toContain(`${Math.round(A4_PORTRAIT.width * PRINT_MM_PER_PT * 100) / 100}mm`);
    expect(html).toContain(`${Math.round(A4_LANDSCAPE.height * PRINT_MM_PER_PT * 100) / 100}mm`);
  });

  it('一页一个 <section>，张数与给进来的页数一致', () => {
    const html = buildPrintDocument({
      pages: [page(0), page(1), page(2), page(3)],
      orientation: 'portrait',
    });
    const sections = html.match(/class="nestboard-print__page"/g) ?? [];
    expect(sections).toHaveLength(4);
  });

  it('每一页都逐页断开、但最后一页不再断（否则末尾多一张白纸）', () => {
    const html = buildPrintDocument({ pages: [page(0), page(1)], orientation: 'portrait' });
    expect(html).toContain('page-break-after: always;');
    // 新语法一并写上，覆盖不识 `page-break-*` 的新引擎
    expect(html).toContain('break-after: page;');
    expect(html).toContain(
      '.nestboard-print__page:last-child { page-break-after: auto; break-after: auto; }',
    );
  });

  it('图片是原样搬运 data URL，并带上真实像素宽高（给渲染器确定的宽高比）', () => {
    const html = buildPrintDocument({
      pages: [page(0, 'data:image/jpeg;base64,ZZZ')],
      orientation: 'portrait',
    });
    expect(html).toContain('src="data:image/jpeg;base64,ZZZ"');
    expect(html).toContain('width="538" height="785"');
    // 纯装饰性复制品：读屏器再念一遍是噪音
    expect(html).toContain('alt=""');
  });

  it('页脚用真文字（不是位图），页码从 1 起', () => {
    const seen: string[] = [];
    const html = buildPrintDocument({
      pages: [page(0), page(1)],
      orientation: 'portrait',
      footer: (current, total) => {
        seen.push(`${current}/${total}`);
        return `Board · page ${current} of ${total}`;
      },
    });
    expect(seen).toEqual(['1/2', '2/2']);
    expect(html).toContain('<footer class="nestboard-print__footer">Board · page 1 of 2</footer>');
    expect(html).toContain('<footer class="nestboard-print__footer">Board · page 2 of 2</footer>');
  });

  it('footer 返回 null → 这一页不印页脚（单页打印的默认行为）', () => {
    const html = buildPrintDocument({
      pages: [page(0)],
      orientation: 'portrait',
      footer: () => null,
    });
    expect(html).not.toContain('<footer');
  });

  it('页脚文字会转义：白板名里带 < > & 也写不坏文档', () => {
    const html = buildPrintDocument({
      pages: [page(0)],
      orientation: 'portrait',
      footer: () => 'A <B> & "C"',
    });
    expect(html).toContain('A &lt;B&gt; &amp; &quot;C&quot;');
    expect(html).not.toContain('<B>');
  });

  it('标题进 <title> 并转义', () => {
    const html = buildPrintDocument({ pages: [page(0)], orientation: 'portrait', title: 'A & B' });
    expect(html).toContain('<title>A &amp; B</title>');
  });

  it('没有标题也不写 `undefined` 进去', () => {
    const html = buildPrintDocument({ pages: [page(0)], orientation: 'portrait' });
    expect(html).toContain('<title></title>');
    expect(html).not.toContain('undefined');
  });

  it('零页也是一份合法文档（视图层会先拦下空板，但函数本身不该吐半截 HTML）', () => {
    const html = buildPrintDocument({ pages: [], orientation: 'portrait' });
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html.trimEnd().endsWith('</html>')).toBe(true);
    expect(html).not.toContain('class="nestboard-print__page"');
  });

  it('整份文档首尾完整：doctype 开头、</html> 收尾（少一个闭合标签浏览器会静默补全）', () => {
    const html = buildPrintDocument({ pages: [page(0), page(1)], orientation: 'landscape' });
    expect(html.startsWith('<!doctype html>\n<html>')).toBe(true);
    expect(html.trimEnd().endsWith('</html>')).toBe(true);
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain('</body>');
  });
});
