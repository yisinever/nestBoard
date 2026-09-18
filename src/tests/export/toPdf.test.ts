/**
 * 导出 PDF（T4.10 / `F9-03`）单测。
 *
 * 分成四层，各自盯一类"静默出错"的地方：
 *  1. **分页几何**（`planPdfExport` / `fitImageInBox`）：错了就是"少导一块内容、
 *     最后一页只剩半张纸"，而屏幕上完全看不出来；
 *  2. **PDF 字节结构**（`buildPdf`）：这里错的后果最狠 —— 阅读器只会说"文件已损坏"，
 *     不会告诉你哪个偏移差了 1 字节。于是测试**把 xref 拆回来逐条核对**：
 *     每个对象的偏移必须正好落在 `N 0 obj` 上、每条 xref 记录必须正好 20 字节、
 *     `/Length` 必须等于它那段流的真实字节数、`startxref` 必须指着 `xref`；
 *  3. **落盘**（`PdfExporter`）：错了会覆盖用户文件 —— 不可逆，必须有覆盖用例；
 *  4. **页脚与 JPEG 编码**：用假的 ctx / 假 canvas，保证"不抛 + 该画的都画了"。
 */

import { describe, expect, it } from 'vitest';
import {
  A4_LANDSCAPE,
  A4_PORTRAIT,
  DEFAULT_PDF_PX_PER_PAGE,
  PDF_PAGE_MARGIN,
  PdfExporter,
  buildPdf,
  canvasToJpeg,
  drawPageFooter,
  pdfDate,
  pdfFileName,
  pdfTextString,
  planPdfExport,
  toArrayBuffer,
} from '../../export/toPdf';
import type { PdfDocumentInput, PdfPageImage } from '../../export/toPdf';
import { MemoryVaultIO } from '../helpers/memoryVault';

// ─────────────────────────────────────────────────────────────
// 助手：把 PDF 当拉丁-1 文本读回来（1 字节 = 1 字符，偏移量与字节号一一对应）
// ─────────────────────────────────────────────────────────────

function latin1(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += String.fromCharCode(byte);
  return out;
}

/** 找 `N 0 obj` 的字节偏移；找不到返回 -1 */
function objectOffset(text: string, id: number): number {
  return text.indexOf(`${id} 0 obj`);
}

/** 拆 xref 表：每条必须是规范的 20 字节，返回真实的偏移值 */
function xrefEntries(text: string): { offset: number; type: string; raw: string }[] {
  // ★ 不能写 `lastIndexOf('xref\n')`：那会命中 `startxref\n` 里的子串，
  //   于是整张表被跳过去、解析出 0 条（这个坑在写测试时就踩过一次）
  const start = text.lastIndexOf('\nxref\n') + 1;
  expect(start).toBeGreaterThan(-1);
  const body = text.slice(start + 5);
  const headerEnd = body.indexOf('\n');
  const rest = body.slice(headerEnd + 1);
  const entries: { offset: number; type: string; raw: string }[] = [];
  for (let at = 0; at + 20 <= rest.length; at += 20) {
    const raw = rest.slice(at, at + 20);
    if (!/^\d{10} \d{5} [nf] \n$/.test(raw)) break;
    entries.push({ offset: Number(raw.slice(0, 10)), type: raw.slice(17, 18), raw });
  }
  return entries;
}

/** 某个对象的字典头（`<< … >>` / `stream` 之前的全部内容） */
function objectBody(text: string, id: number): string {
  const start = objectOffset(text, id);
  expect(start).toBeGreaterThan(-1);
  const end = text.indexOf('endobj', start);
  return text.slice(start, end);
}

/** 取出一个流对象的原始字节（`stream\n` 与 `\nendstream` 之间，不含两侧换行） */
function streamBytes(bytes: Uint8Array, text: string, id: number): Uint8Array {
  const start = objectOffset(text, id);
  const streamAt = text.indexOf('stream\n', start) + 'stream\n'.length;
  const length = Number(/\/Length (\d+)/.exec(text.slice(start, streamAt))?.[1] ?? '0');
  return bytes.subarray(streamAt, streamAt + length);
}

/** 假 JPEG：只要求"有内容"，PDF 组装并不解析它（`/DCTDecode` 是逐字节直通） */
function fakeJpeg(seed = 1, size = 12): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes[0] = 0xff;
  bytes[1] = 0xd8;
  bytes[size - 2] = 0xff;
  bytes[size - 1] = 0xd9;
  for (let index = 2; index < size - 2; index += 1) bytes[index] = (seed * 31 + index) & 0xff;
  return bytes;
}

function pageImage(overrides: Partial<PdfPageImage> = {}): PdfPageImage {
  return {
    jpeg: fakeJpeg(),
    pixelWidth: 2109,
    pixelHeight: 3072,
    draw: { x: 28.35, y: 28.35, width: 538.58, height: 785.19 },
    ...overrides,
  };
}

function documentOf(pages: PdfPageImage[], overrides: Partial<PdfDocumentInput> = {}) {
  return {
    pageWidth: A4_PORTRAIT.width,
    pageHeight: A4_PORTRAIT.height,
    pages,
    title: 'Board',
    createdAt: new Date(2026, 8, 12, 17, 0, 0),
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────
// 1 · 分页几何
// ─────────────────────────────────────────────────────────────

describe('planPdfExport · 分页几何', () => {
  it('空边界 → 零页（调用方据此提示"没有可导出的内容"）', () => {
    const plan = planPdfExport(null);
    expect(plan.pages).toEqual([]);
    expect(plan.columns).toBe(0);
    // 纸张信息仍然可用：面板要拿它写摘要
    expect(plan.pageWidth).toBe(A4_PORTRAIT.width);
    expect(plan.pageHeight).toBe(A4_PORTRAIT.height);
  });

  it('宽高为 0 / 负数 → 零页，且不抛', () => {
    expect(planPdfExport({ x: 0, y: 0, width: 0, height: 10 }).pages).toEqual([]);
    expect(planPdfExport({ x: 0, y: 0, width: -5, height: 10 }).pages).toEqual([]);
  });

  it('内容比一页小 → 一页，板子在纸面居中（靠 tile 的位置，不靠放大）', () => {
    const plan = planPdfExport({ x: 0, y: 0, width: 300, height: 200 });
    expect(plan.pages).toHaveLength(1);

    const [page] = plan.pages;
    // tile **恒等于整页**：内容比一页窄，靠负偏移把它摆到纸中间
    expect(page.width).toBeGreaterThanOrEqual(Math.floor(plan.contentWidth));
    expect(page.height).toBeGreaterThanOrEqual(Math.floor(plan.contentHeight));
    // 居中偏移会再向外取整（`alignTile`：多画一格不露缝），所以比对 floor 后的值
    expect(page.x).toBe(Math.floor(-(plan.contentWidth - 300) / 2));
    expect(page.y).toBe(Math.floor(-(plan.contentHeight - 200) / 2));
    // 于是板子的中心正好落在 tile 的中心（= 纸面的中心）
    expect(page.x + page.width / 2).toBeCloseTo(0 + 300 / 2, 0);
    expect(page.y + page.height / 2).toBeCloseTo(0 + 200 / 2, 0);
  });

  it('图像永远 1:1 铺在可打印区上：不放大、不拉伸（纸上的字该多大就多大）', () => {
    for (const bounds of [
      { x: 0, y: 0, width: 300, height: 200 },
      { x: 0, y: 0, width: 400, height: 1600 },
      { x: -120, y: 80, width: 2400, height: 1900 },
    ]) {
      const plan = planPdfExport(bounds);
      for (const page of plan.pages) {
        expect(page.draw).toEqual({
          x: PDF_PAGE_MARGIN,
          y: PDF_PAGE_MARGIN,
          width: plan.contentWidth,
          height: plan.contentHeight,
        });
        // 图像像素数 = 世界尺寸 × scale，与纸面尺寸同源 → 印刷分辨率恒定
        expect(page.draw.width / page.pixelWidth).toBeCloseTo(
          page.draw.height / page.pixelHeight,
          2,
        );
      }
    }
  });

  it('横向：纸张宽高互换，一页能装的内容随之变多', () => {
    const bounds = { x: 0, y: 0, width: 900, height: 400 };
    const portrait = planPdfExport(bounds, { orientation: 'portrait' });
    const landscape = planPdfExport(bounds, { orientation: 'landscape' });

    expect([portrait.pageWidth, portrait.pageHeight]).toEqual([
      A4_PORTRAIT.width,
      A4_PORTRAIT.height,
    ]);
    expect([landscape.pageWidth, landscape.pageHeight]).toEqual([
      A4_LANDSCAPE.width,
      A4_LANDSCAPE.height,
    ]);
    // 900 宽：纵向要两页，横向（可打印区 785.19 宽）也要两页；但纵向的行更多余量
    expect(portrait.columns).toBe(2);
    expect(landscape.columns).toBe(2);
    expect(landscape.contentWidth).toBeGreaterThan(portrait.contentWidth);
  });

  it('大板按纸面切网格，页数 = 列 × 行', () => {
    const bounds = { x: 0, y: 0, width: 1600, height: 1700 };
    const plan = planPdfExport(bounds);
    // 1600 / 538.58 = 2.97 → 3 列；1700 / 785.19 = 2.17 → 3 行
    expect(plan.columns).toBe(3);
    expect(plan.rows).toBe(3);
    expect(plan.pages).toHaveLength(9);
    expect(plan.pages.map((page) => page.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('最后一列 / 行**贴回右 / 下边缘**：不产出半页细条，宁可和邻居重叠', () => {
    const bounds = { x: 0, y: 0, width: 1600, height: 1700 };
    const plan = planPdfExport(bounds);

    for (const page of plan.pages) {
      // 同一行里，第一页贴左边、最后一页贴右边（重叠而不是留缝）
      if (page.column === 0) expect(page.x).toBe(bounds.x);
      if (page.column === plan.columns - 1) {
        expect(page.x + page.width).toBeGreaterThanOrEqual(bounds.x + bounds.width);
      }
      if (page.row === 0) expect(page.y).toBe(bounds.y);
      if (page.row === plan.rows - 1) {
        expect(page.y + page.height).toBeGreaterThanOrEqual(bounds.y + bounds.height);
      }
      // 每一页都是满幅的（等于一页的世界宽高，最后一页也不缩水）
      expect(page.width).toBeGreaterThanOrEqual(Math.floor(plan.contentWidth) - 1);
      expect(page.height).toBeGreaterThanOrEqual(Math.floor(plan.contentHeight) - 1);
    }
  });

  it('带偏移的边界：tile 落在 bounds 之内或紧贴其边缘，绝不跑到外面去', () => {
    const bounds = { x: -300, y: 120, width: 1200, height: 900 };
    const plan = planPdfExport(bounds);
    for (const page of plan.pages) {
      expect(page.x).toBeGreaterThanOrEqual(bounds.x);
      expect(page.y).toBeGreaterThanOrEqual(bounds.y);
    }
    expect(plan.pages[0].x).toBe(bounds.x);
    expect(plan.pages[0].y).toBe(bounds.y);
  });

  it('清晰度只改像素、不改页数：3072 与 2048 的页数一致而像素更小', () => {
    const bounds = { x: 0, y: 0, width: 1600, height: 1700 };
    const high = planPdfExport(bounds, { pxPerPage: 4096 });
    const low = planPdfExport(bounds, { pxPerPage: 2048 });

    expect(low.pages).toHaveLength(high.pages.length);
    expect(low.pages[0].pixelHeight).toBeLessThan(high.pages[0].pixelHeight);
    expect(low.scale).toBeLessThan(high.scale);
  });

  it('图像的像素尺寸 = tile × scale（与 renderTile 内部算法一致）', () => {
    const plan = planPdfExport({ x: 0, y: 0, width: 400, height: 1500 });
    for (const page of plan.pages) {
      expect(page.pixelWidth).toBe(Math.max(1, Math.round(page.width * plan.scale)));
      expect(page.pixelHeight).toBe(Math.max(1, Math.round(page.height * plan.scale)));
    }
    // 整页高的那一页长边正好是请求的清晰度（向外圆整最多差几个像素）
    const full = plan.pages[0];
    expect(full.pixelHeight).toBeGreaterThanOrEqual(DEFAULT_PDF_PX_PER_PAGE);
    expect(full.pixelHeight).toBeLessThanOrEqual(DEFAULT_PDF_PX_PER_PAGE + 8);
  });

  it('非法清晰度一律回落到默认值，不产出 NaN 尺寸', () => {
    for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const plan = planPdfExport({ x: 0, y: 0, width: 800, height: 600 }, { pxPerPage: value });
      expect(plan.pages.length).toBeGreaterThan(0);
      for (const page of plan.pages) {
        expect(Number.isFinite(page.pixelWidth)).toBe(true);
        expect(page.pixelWidth).toBeGreaterThan(0);
      }
    }
  });

  it('退化输入（1×1 的板）不产出 NaN 尺寸，且照样是一页', () => {
    const plan = planPdfExport({ x: 0, y: 0, width: 1, height: 1 });
    expect(plan.pages).toHaveLength(1);
    const [page] = plan.pages;
    expect(Number.isFinite(page.pixelWidth)).toBe(true);
    expect(Number.isFinite(page.pixelHeight)).toBe(true);
    expect(page.pixelWidth).toBeGreaterThan(0);
  });

  it('余数很小时最后一页**重叠邻居**（刻意的取舍：宁可重复，不留半页）', () => {
    // 宽 1100 = 两页(1077.16) + 22.84 余数 → 第 3 页贴回右边，与前一页大幅重叠
    const bounds = { x: 0, y: 0, width: 1100, height: 700 };
    const plan = planPdfExport(bounds);
    expect(plan.columns).toBe(3);

    const last = plan.pages[plan.pages.length - 1];
    expect(last.x + last.width).toBeGreaterThanOrEqual(bounds.x + bounds.width);
    expect(last.width).toBeGreaterThanOrEqual(Math.floor(plan.contentWidth));
    // 重叠是"多画一遍同样的内容"，不会丢内容
    expect(last.x).toBeLessThan(plan.pages[plan.pages.length - 2].x + plan.contentWidth);
  });
});

// ─────────────────────────────────────────────────────────────
// 2 · PDF 字节结构
// ─────────────────────────────────────────────────────────────

describe('buildPdf · 字节结构', () => {
  it('没有页 → null（不产出空 PDF 文件）', () => {
    expect(buildPdf(documentOf([]))).toBeNull();
  });

  it('文件头带二进制标记，结尾是 %%EOF', () => {
    const bytes = buildPdf(documentOf([pageImage()]))!;
    const text = latin1(bytes);
    // 第二行的高位字节是"这是二进制文件"的标记（少了它，某些工具会改写换行）
    expect(text.startsWith('%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n')).toBe(true);
    expect(text.endsWith('%%EOF\n')).toBe(true);
  });

  it('目录 / 页树 / 页对象互相引用得上', () => {
    const bytes = buildPdf(documentOf([pageImage(), pageImage({ jpeg: fakeJpeg(2) })]))!;
    const text = latin1(bytes);

    expect(objectBody(text, 1)).toContain('/Type /Catalog /Pages 2 0 R');
    expect(objectBody(text, 2)).toContain('/Count 2');
    expect(objectBody(text, 2)).toContain('/Kids [3 0 R 6 0 R]');
    expect(objectBody(text, 3)).toContain('/Type /Page /Parent 2 0 R');
    expect(objectBody(text, 3)).toContain('/Contents 4 0 R');
    expect(objectBody(text, 3)).toContain('/XObject << /Im0 5 0 R >>');
    expect(objectBody(text, 6)).toContain('/Contents 7 0 R');
    expect(objectBody(text, 6)).toContain('/XObject << /Im0 8 0 R >>');
  });

  it('MediaBox 是纸张尺寸，图像贴在可打印区（y 从左上翻到左下）', () => {
    const page = pageImage({ draw: { x: 28.35, y: 28.35, width: 539, height: 785 } });
    const bytes = buildPdf(
      documentOf([page], { pageWidth: A4_PORTRAIT.width, pageHeight: A4_PORTRAIT.height }),
    )!;
    const text = latin1(bytes);

    expect(objectBody(text, 3)).toContain('/MediaBox [0 0 595.28 841.89]');
    const stream = latin1(streamBytes(bytes, text, 4));
    // 841.89 - 28.35 - 785 = 28.54 —— 翻过来之后图像底边落在纸下边距上
    expect(stream).toBe('q\n539 0 0 785 28.35 28.54 cm\n/Im0 Do\nQ\n');
  });

  it('图像字典：宽高、色彩空间、DCTDecode、/Length = JPEG 字节数', () => {
    const jpeg = fakeJpeg(7, 33);
    const bytes = buildPdf(documentOf([pageImage({ jpeg, pixelWidth: 640, pixelHeight: 480 })]))!;
    const text = latin1(bytes);
    const dictionary = objectBody(text, 5);

    expect(dictionary).toContain('/Type /XObject /Subtype /Image');
    expect(dictionary).toContain('/Width 640 /Height 480');
    expect(dictionary).toContain('/ColorSpace /DeviceRGB /BitsPerComponent 8');
    expect(dictionary).toContain('/Filter /DCTDecode');
    expect(dictionary).toContain(`/Length ${jpeg.length}`);
    expect(streamBytes(bytes, text, 5)).toEqual(jpeg);
  });

  it('JPEG 字节是**原样直通**的（一个字节都没动）', () => {
    const jpeg = fakeJpeg(3, 64);
    const bytes = buildPdf(documentOf([pageImage({ jpeg })]))!;
    // 在整份文件里按字节序列找它 —— 直通是 /DCTDecode 的全部意义
    let found = -1;
    for (let at = 0; at + jpeg.length <= bytes.length; at += 1) {
      let match = true;
      for (let index = 0; index < jpeg.length; index += 1) {
        if (bytes[at + index] !== jpeg[index]) {
          match = false;
          break;
        }
      }
      if (match) {
        found = at;
        break;
      }
    }
    expect(found).toBeGreaterThan(-1);
  });

  it('内容流 /Length 与真实字节数一致', () => {
    const bytes = buildPdf(documentOf([pageImage()]))!;
    const text = latin1(bytes);
    const declared = Number(/\/Length (\d+)/.exec(objectBody(text, 4))![1]);
    expect(streamBytes(bytes, text, 4)).toHaveLength(declared);
    expect(declared).toBeGreaterThan(0);
  });

  it('xref：每条 20 字节、偏移正好落在 `N 0 obj` 上、0 号是自由对象', () => {
    const bytes = buildPdf(documentOf([pageImage(), pageImage({ jpeg: fakeJpeg(9) })]))!;
    const text = latin1(bytes);
    const entries = xrefEntries(text);

    // 1 目录 + 1 页树 + 3×2 页（页/内容流/图像）+ 1 信息 = 9 个对象，
    // 再加上 xref 表开头的自由对象 0 → 10 条记录
    expect(entries).toHaveLength(10);
    expect(entries[0].type).toBe('f');
    expect(entries[0].offset).toBe(0);

    for (let id = 1; id < entries.length; id += 1) {
      expect(entries[id].type).toBe('n');
      expect(text.slice(entries[id].offset, entries[id].offset + `${id} 0 obj`.length)).toBe(
        `${id} 0 obj`,
      );
    }
    // 每条记录的原始长度必须是规范的 20 字节
    for (const entry of entries) expect(entry.raw).toHaveLength(20);
  });

  it('startxref 指着 xref 表，trailer 的 /Size 与实际对象数一致', () => {
    const bytes = buildPdf(documentOf([pageImage()]))!;
    const text = latin1(bytes);

    const startxref = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(text)![1]);
    expect(text.slice(startxref, startxref + 5)).toBe('xref\n');

    const entries = xrefEntries(text);
    expect(objectBody(text, 1).length).toBeGreaterThan(0);
    // trailer 里的 /Size 包含那个自由对象
    expect(text).toContain(`/Size ${entries.length}`);
  });

  it('文档信息：/Producer、/Title、/CreationDate', () => {
    const bytes = buildPdf(
      documentOf([pageImage()], { producer: 'Nestboard', title: 'My (board)' }),
    )!;
    const text = latin1(bytes);
    const info = objectBody(text, 6);

    expect(info).toContain('/Producer (Nestboard)');
    expect(info).toContain('/Title (My \\(board\\))');
    expect(info).toContain('/CreationDate (D:20260912170000');
  });

  it('多页：页数、页序与页码一致（页脚要按页码写"第 i / n 页"）', () => {
    const pages = [1, 2, 3].map((seed) => pageImage({ jpeg: fakeJpeg(seed) }));
    const bytes = buildPdf(documentOf(pages))!;
    const text = latin1(bytes);

    expect(objectBody(text, 2)).toContain('/Count 3');
    expect(objectBody(text, 2)).toContain('/Kids [3 0 R 6 0 R 9 0 R]');
    for (const id of [3, 6, 9]) expect(objectBody(text, id)).toContain('/Type /Page');
    // 每一页的图像对象都真的在
    for (const id of [5, 8, 11]) expect(objectBody(text, id)).toContain('/DCTDecode');
  });

  it('某一页没有图像数据 → 抛错（不产出半本 PDF）', () => {
    const pages = [pageImage(), pageImage({ jpeg: new Uint8Array(0) })];
    expect(() => buildPdf(documentOf(pages))).toThrow(/no image data/);
  });

  it('尺寸是坏数（NaN / Infinity）时不写出 NaN 到文件里', () => {
    const bytes = buildPdf(
      documentOf(
        [
          pageImage({
            pixelWidth: Number.NaN,
            pixelHeight: Number.POSITIVE_INFINITY,
            draw: { x: Number.NaN, y: Number.POSITIVE_INFINITY, width: 0, height: -3 },
          }),
        ],
        { pageWidth: Number.NaN, pageHeight: Number.POSITIVE_INFINITY },
      ),
    )!;
    const text = latin1(bytes);
    expect(text).not.toContain('NaN');
    expect(text).not.toContain('Infinity');
    expect(objectBody(text, 3)).toContain('/MediaBox [0 0 1 1]');
    // 0 / 负数尺寸一律当 1（0 宽高在 PDF 里等于"这页什么都没画"）
    expect(objectBody(text, 5)).toContain('/Width 1 /Height 1');
  });
});

describe('PDF 文本串与日期', () => {
  it('ASCII 走字面串并转义括号与反斜杠', () => {
    expect(pdfTextString('Board')).toBe('(Board)');
    expect(pdfTextString('a(b)c\\d')).toBe('(a\\(b\\)c\\\\d)');
  });

  it('非 ASCII（中文标题）走 UTF-16BE + BOM 的十六进制串', () => {
    // "白" = U+767D
    expect(pdfTextString('白板')).toBe('<feff767d677f>');
    // 混合内容只要有非 ASCII 就整串转十六进制
    expect(pdfTextString('板 A')).toBe('<feff677f00200041>');
  });

  it("日期串符合 PDF 的 D:YYYYMMDDHHmmSS±HH'mm'", () => {
    const date = new Date(2026, 8, 12, 9, 5, 3);
    expect(pdfDate(date)).toMatch(/^D:20260912090503[+-]\d{2}'\d{2}'$/);
  });
});

// ─────────────────────────────────────────────────────────────
// 3 · 落盘
// ─────────────────────────────────────────────────────────────

describe('PdfExporter · 落盘', () => {
  it('文件名固定为 .pdf', () => {
    expect(pdfFileName('白板')).toBe('白板.pdf');
  });

  it('写进目标目录并返回路径', async () => {
    const sink = new MemoryVaultIO();
    const path = await new PdfExporter(sink).export(new Uint8Array([1, 2, 3]), {
      folder: 'Boards',
      name: '白板',
    });

    expect(path).toBe('Boards/白板.pdf');
    expect(sink.binaries.has('Boards/白板.pdf')).toBe(true);
  });

  it('根目录不加前导斜杠', async () => {
    const sink = new MemoryVaultIO();
    const path = await new PdfExporter(sink).export(new Uint8Array([1]), {
      folder: '',
      name: 'A',
    });
    expect(path).toBe('A.pdf');
  });

  it('目录末尾的斜杠不会变成双斜杠', async () => {
    const sink = new MemoryVaultIO();
    const path = await new PdfExporter(sink).export(new Uint8Array([1]), {
      folder: 'Boards/',
      name: 'A',
    });
    expect(path).toBe('Boards/A.pdf');
  });

  it('**绝不覆盖**：已存在就顺延（导出的 PDF 认不出是不是自己的）', async () => {
    const sink = new MemoryVaultIO();
    const exporter = new PdfExporter(sink);
    sink.binaries.set('Boards/A.pdf', new Uint8Array([9]).buffer);

    const path = await exporter.export(new Uint8Array([1, 2]), { folder: 'Boards', name: 'A' });
    expect(path).toBe('Boards/A 2.pdf');
    expect(Array.from(new Uint8Array(sink.binaries.get('Boards/A.pdf')!))).toEqual([9]);

    await exporter.export(new Uint8Array([1, 2]), { folder: 'Boards', name: 'A' });
    expect(sink.binaries.has('Boards/A 3.pdf')).toBe(true);
  });

  it('写进去的字节与源字节一致（toArrayBuffer 精确切片）', async () => {
    const sink = new MemoryVaultIO();
    const source = new Uint8Array([0, 1, 2, 3, 4, 5]);
    const view = source.subarray(1, 4); // 故意给一个带偏移的视图

    await new PdfExporter(sink).export(view, { folder: '', name: 'Slice' });
    expect(Array.from(new Uint8Array(sink.binaries.get('Slice.pdf')!))).toEqual([1, 2, 3]);

    // 视图的 buffer 比视图本身大：naive 地传 buffer 会把整块内存都写进去
    expect(toArrayBuffer(view).byteLength).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────
// 4 · 页脚与 JPEG 编码
// ─────────────────────────────────────────────────────────────

class FakeContext {
  readonly ops: string[] = [];
  readonly texts: string[] = [];
  fillStyle = '';
  font = '';
  textBaseline = '';
  globalAlpha = 1;

  save(): void {
    this.ops.push('save');
  }
  restore(): void {
    this.ops.push('restore');
  }
  fillRect(): void {
    this.ops.push('fillRect');
  }
  fillText(text: string): void {
    this.ops.push('fillText');
    this.texts.push(text);
  }
  measureText(text: string): { width: number } {
    return { width: text.length * 6 };
  }
}

function fakeContext(): { ctx: CanvasRenderingContext2D; fake: FakeContext } {
  const fake = new FakeContext();
  return { ctx: fake as unknown as CanvasRenderingContext2D, fake };
}

const footerPalette = { background: '#ffffff', text: '#222222', fontFamily: 'sans-serif' };

describe('drawPageFooter', () => {
  it('只有一页时不画（"第 1/1 页"是噪音）', () => {
    const { ctx, fake } = fakeContext();
    drawPageFooter(ctx, {
      width: 2000,
      height: 3000,
      page: 1,
      total: 1,
      label: '板',
      palette: footerPalette,
    });
    expect(fake.ops).toEqual([]);
  });

  it('多页时铺一条底色再写字，文字含页码', () => {
    const { ctx, fake } = fakeContext();
    drawPageFooter(ctx, {
      width: 2000,
      height: 3000,
      page: 3,
      total: 12,
      label: '项目板',
      palette: footerPalette,
    });

    expect(fake.ops).toContain('fillRect');
    expect(fake.ops).toContain('fillText');
    expect(fake.ops.filter((op) => op === 'save')).toHaveLength(1);
    expect(fake.texts[0]).toContain('3');
    expect(fake.texts[0]).toContain('12');
    expect(fake.texts[0]).toContain('项目板');
  });

  it('页脚字号随图宽变化但落在可读区间（10–28px）', () => {
    const small = fakeContext();
    drawPageFooter(small.ctx, {
      width: 600,
      height: 900,
      page: 2,
      total: 4,
      label: 'x',
      palette: footerPalette,
    });
    const large = fakeContext();
    drawPageFooter(large.ctx, {
      width: 4000,
      height: 6000,
      page: 2,
      total: 4,
      label: 'x',
      palette: footerPalette,
    });

    expect(small.fake.font).toBe('10px sans-serif');
    expect(large.fake.font).toBe('28px sans-serif');
  });
});

describe('canvasToJpeg', () => {
  function fakeCanvas(blob: Blob | null, capture?: (quality?: number) => void) {
    return {
      toBlob(callback: (value: Blob | null) => void, _type?: string, quality?: number) {
        capture?.(quality);
        callback(blob);
      },
    } as unknown as HTMLCanvasElement;
  }

  it('编码成功时交出 ArrayBuffer', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const buffer = await canvasToJpeg(fakeCanvas(new Blob([bytes])), 0.9);
    expect(new Uint8Array(buffer)).toEqual(bytes);
  });

  it('内核给不出图 → 拒绝（调用方据此报"导出失败"，而不是写个空页）', async () => {
    await expect(canvasToJpeg(fakeCanvas(null))).rejects.toThrow(/JPEG/);
  });

  it('质量被夹进 0.4–1（内核收到坏质量参数时行为不可预期）', async () => {
    let low = 0;
    await canvasToJpeg(
      fakeCanvas(new Blob([new Uint8Array([1])]), (q) => (low = q ?? 0)),
      0.1,
    );
    expect(low).toBe(0.4);

    let high = 0;
    await canvasToJpeg(
      fakeCanvas(new Blob([new Uint8Array([1])]), (q) => (high = q ?? 0)),
      5,
    );
    expect(high).toBe(1);
  });
});
