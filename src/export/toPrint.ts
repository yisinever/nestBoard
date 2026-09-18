/**
 * 打印白板（T6.03 / `F9-10`）。
 *
 * ── 为什么打印不自己算一套分页 ──────────────────────────────────
 *
 * 打印和"导出 PDF"要回答的是同一个问题：**这块板分几张 A4、每张装哪一块**。
 * 于是这里**直接复用** `planPdfExport`（`toPdf.ts`），一行几何都不重写 ——
 * 重写就会出现"打印出来的分页和 PDF 不一样"这种没人查得出来的漂移。
 *
 * ── 那这个模块到底做什么 ─────────────────────────────────────────
 *
 * 差别只在**产物形态**：
 *
 *  · PDF 是**文件** —— 要进库、要能存档，所以文字只能转成位图
 *    （PDF 里写中文要嵌字体子集，成本另一个量级）。
 *  · 打印是**交给浏览器的一页纸** —— 内容即刻进打印机、不落任何文件，
 *    于是可以**用真文字**：页脚页码就是一个 `<footer>`，不必画进位图。
 *
 * 所以这里的全部工作，是把一组已经编码好的页面图 + 纸张参数拼成一份可
 * `window.print()` 的 HTML。**零 `obsidian`、零 `document`** —— 产出的是一个
 * 字符串，于是能被单测完整覆盖（真正"打印"那一哆嗦留在视图层）。
 *
 * ── 页边距是物理约束，不是审美 ──────────────────────────────────
 *
 * 沿用在 `toPdf.ts` 里写过的 `PDF_PAGE_MARGIN`（≈10mm）：家用打印机的不可打印
 * 边距普遍 3–5mm，把内容顶到纸边会**被裁掉一圈** —— 而用户多半是按下"打印"
 * 之后才发现的。这里连 CSS 的 `@page` 都给 `margin: 0`、自己用 padding 留白，
 * 免得浏览器再叠一层默认页边距把 10mm 吃掉。
 *
 * ── 多页 = 海报，所以要说 ───────────────────────────────────────
 *
 * 超出一页时，相邻两块在边缘**刻意有重叠**（`axisStart` 把最后一块贴回边缘，
 * 见 `toPdf.ts`）。这对"拼贴成一张大图"是必须的（否则接缝会缺一条），
 * 但对"只想要一页纸"的人是意外。所以面板上给一句分幅提示 —— 由
 * {@link posterHint} 决定要不要说。
 */

import type { Rect } from '../util/geometry';
import {
  A4_LANDSCAPE,
  A4_PORTRAIT,
  DEFAULT_PDF_QUALITY,
  PDF_PAGE_MARGIN,
  planPdfExport,
} from './toPdf';
import type { PdfExportOptions, PdfOrientation, PdfPlan } from './toPdf';

// ─────────────────────────────────────────────────────────────
// 纸面与清晰度
// ─────────────────────────────────────────────────────────────

/** pt → mm（CSS 用 mm 表达纸面尺寸，1pt = 1/72 英寸） */
export const PRINT_MM_PER_PT = 25.4 / 72;

/**
 * 打印的每页像素（固定值，不给档位）。
 *
 * ★ 比 PDF 的默认值（3072）低一档，理由只有一条：**打印是即刻消耗的**。
 *   每一页的图都要以 data URL 形式同时挂在文档里等打印机，3072 会让几页纸
 *   就吃掉上百 MB；而真正的清晰度上限是打印机自己的光栅化（300dpi），
 *   2048px 铺 A4 长边 ≈ 187dpi，对"纸上看得清"已经够。
 */
export const DEFAULT_PRINT_PX_PER_PAGE = 2048;

/** JPEG 质量沿用 PDF 那一档：产物形态完全相同（一张位图铺满一页纸） */
export const DEFAULT_PRINT_QUALITY = DEFAULT_PDF_QUALITY;

/** 页脚距纸底的距离（pt） */
export const PRINT_FOOTER_BOTTOM_PT = 10;

/** 等待 iframe 加载 + 图片解码的上限（ms）：到点就照常打印，宁可少等不可卡住 */
export const PRINT_LOAD_TIMEOUT_MS = 1500;

/** 打印后的清理延时（ms）：`afterprint` 不是每个宿主都发，兜一条底线 */
export const PRINT_CLEANUP_MS = 60000;

// ─────────────────────────────────────────────────────────────
// 分页（薄薄一层，几何全在 toPdf）
// ─────────────────────────────────────────────────────────────

/**
 * 打印选项 = PDF 选项**减去清晰度**。
 *
 * ★ 不用 `interface ... extends PdfExportOptions {}` 那种空接口：它只是"看起来另立了
 *   一个名字"，`pxPerPage` 照样能从别处传进来，而那是个**面板上根本不存在的开关** ——
 *   "界面上没有的东西却能被别处改"是最难查的那种不一致。这里直接在类型上摘掉它，
 *   于是"打印清晰度是钉死的"由编译器守着，而不是靠一句注释。
 * ★ 其余选项（范围 / 纸张方向）与 PDF 逐字相同：两者本就共用一套分页几何。
 */
export type PrintExportOptions = Omit<PdfExportOptions, 'pxPerPage'>;

/**
 * 规划打印分页：与 PDF 同一套几何，只把清晰度钉死在 {@link DEFAULT_PRINT_PX_PER_PAGE}。
 *
 * ★ 清晰度不是"忽略调用方的值"，而是**没法传**（见 {@link PrintExportOptions}）；
 *   运行时的覆盖仍留着，防的是绕过类型的那条路（JS 调用方 / 强转）。
 */
export function planPrintExport(bounds: Rect | null, options: PrintExportOptions = {}): PdfPlan {
  return planPdfExport(bounds, { ...options, pxPerPage: DEFAULT_PRINT_PX_PER_PAGE });
}

/**
 * 要不要给"分幅（海报）提示"。
 *
 * ★ 只有真会跨页时才说 —— 单页板子跑出来一句"相邻页有重叠"纯属噪音，
 *   而真跨页时不说，用户会把接缝处的重复内容当成导出出错。
 */
export function posterHint(plan: Pick<PdfPlan, 'columns' | 'rows'>): boolean {
  return plan.columns > 1 || plan.rows > 1;
}

// ─────────────────────────────────────────────────────────────
// 组装可打印的 HTML（纯函数）
// ─────────────────────────────────────────────────────────────

/** 一页已经编码好的图（data URL） */
export interface PrintPageImage {
  /** 形如 `data:image/jpeg;base64,...` —— 已编码，这里只做搬运 */
  dataUrl: string;
  /** 原始像素宽高（写进 `width` / `height` 属性，给渲染器一个确定的宽高比） */
  width: number;
  height: number;
  /** 第几块（0 起，与 `PdfPage.index` 同义） */
  index: number;
}

export interface PrintDocumentInput {
  pages: readonly PrintPageImage[];
  orientation: PdfOrientation;
  /** 文档标题（浏览器打印对话框里会显示；也进 `<title>`） */
  title?: string;
  /**
   * 每页的页脚文字（`index` 从 1 起）。返回 `null` 表示这一页不印页脚。
   *
   * ★ 用回调而不是模板字符串：`{label} · 第 {page} / {total} 页` 这类文案本身在
   *   i18n 里，拼装规则不该在这里再实现一遍（PDF 那边已经证明"文案各写一套"
   *   容易漏改一处）。
   */
  footer?: (page: number, total: number) => string | null;
}

/** HTML 转义（页脚是用户可控的白板名，必须转义） */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** pt → CSS mm 字面量（保留两位小数） */
function mm(pt: number): string {
  return `${Math.round(pt * PRINT_MM_PER_PT * 100) / 100}mm`;
}

/**
 * 拼出整份打印文档。
 *
 * 每页一个 `<section>`，`page-break-after: always` 逐页断开（"always" 老语法和
 * "page" 新语法都写，覆盖新旧引擎）；最后一页**不**断开 —— 否则会在末尾多出一张白纸。
 */
export function buildPrintDocument(input: PrintDocumentInput): string {
  const landscape = input.orientation === 'landscape';
  const paper = landscape ? A4_LANDSCAPE : A4_PORTRAIT;
  const total = input.pages.length;

  const pages = input.pages
    .map((page) => {
      const label = input.footer?.(page.index + 1, total) ?? null;
      const footer = label
        ? `<footer class="nestboard-print__footer">${escapeHtml(label)}</footer>`
        : '';
      // `alt=""`：这是纯装饰性复制品（页脚已经报过页码），读屏器再念一遍纯属噪音
      const img = `<img src="${escapeHtml(page.dataUrl)}" alt="" width="${page.width}" height="${page.height}">`;
      return `<section class="nestboard-print__page"><div class="nestboard-print__art">${img}</div>${footer}</section>`;
    })
    .join('\n');

  const title = escapeHtml(input.title ?? '');

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>
  html, body { margin: 0; padding: 0; background: #fff; }
  @page { size: A4 ${landscape ? 'landscape' : 'portrait'}; margin: 0; }
  .nestboard-print__page {
    position: relative;
    box-sizing: border-box;
    width: ${mm(paper.width)};
    height: ${mm(paper.height)};
    padding: ${PDF_PAGE_MARGIN}pt;
    overflow: hidden;
    page-break-after: always;
    break-after: page;
  }
  .nestboard-print__page:last-child { page-break-after: auto; break-after: auto; }
  .nestboard-print__art {
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .nestboard-print__art img { max-width: 100%; max-height: 100%; display: block; }
  .nestboard-print__footer {
    position: absolute;
    left: ${PDF_PAGE_MARGIN}pt;
    right: ${PDF_PAGE_MARGIN}pt;
    bottom: ${PRINT_FOOTER_BOTTOM_PT}pt;
    font: 9pt/1.4 -apple-system, "Segoe UI", "PingFang SC", sans-serif;
    color: #666;
    text-align: right;
  }
</style>
</head>
<body>
${pages}
</body>
</html>
`;
}
