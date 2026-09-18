/**
 * 导出 PDF（T4.10 / `F9-03`）—— "真实多页 tile"。
 *
 * ── 为什么 PDF 是**自己拼字节**，而不是引一个库 ──────────────────
 *
 * 本插件承诺零运行时依赖（`03 §7.2`），而 `pdf-lib` / `jsPDF` 都是几百 KB 起。
 * 我们真正需要的 PDF 子集却极小：**每页一张图** —— 这本来就是 PDF 的原始用法。
 * 于是这里按 PDF 1.4 的语法手写对象、内容流、xref 与 trailer：结构全在自己手里，
 * 也就不存在"哪天升个库、导出物就变了"这种没人查得出来的问题。
 *
 * ── 为什么图是 JPEG，不是 PNG ───────────────────────────────────
 *
 * PDF 的 `/DCTDecode` 过滤器收的**就是 JPEG 字节流**，可以逐字节原样塞进去；
 * 而 PNG 在 PDF 里必须解成 `/FlateDecode`（zlib 流）—— 那需要压缩器，
 * 浏览器里只能自己实现 deflate。于是取舍很清楚：
 *   · JPEG = 内核编码好 → 我们只做搬运，**零压缩代码**；
 *   · 代价是**没有 alpha** → 所以 PDF 不提供"背景透明"这一项（JPEG 表达不了），
 *     一律铺白板自己的底色（调用方传 `transparent: false`）。
 *
 * ── tile 怎么切：按**纸面**切，不是按固定像素切 ──────────────────
 *
 * PNG 的分页是"固定像素边长切网格"，切出来每块都是方的（4096×4096），
 * 贴进 A4 会上下留出大黑边。PDF 这边反过来算：**由可打印区的宽高比反推每页装多少
 * 世界坐标**，于是每一页都是满幅的，不浪费纸。
 * 每一页的 tile **恒等于整页**（内容比一页小就在纸上居中，而不是把位图拉大）；
 * 最后一列 / 最后一行**贴回右 / 下边缘**（宁可和前一页重叠一点）—— 否则最后一页
 * 会是一条细长的半页；"贴回边缘"本来就是多页海报拼贴的标准做法。
 *
 * ── 纸上比例：1 世界 px = 1 pt ──────────────────────────────────
 *
 * 1pt = 1/72 英寸，所以 11px 的正文在纸上是 11pt ≈ 3.9mm，与打印正文相当。
 * **清晰度只由"每页多少像素"决定**（2048 / 3072 / 4096）：3072px 铺 A4 长边
 * ≈ 281 dpi。改这个值只影响清晰度与文件体积，**不影响页数**（页数只由纸面与内容
 * 决定）—— 这一点与 PNG 的"倍率"语义不同，所以这里刻意不叫它倍率。
 *
 * ★ 诚实声明：产物是**位图 PDF**，里面的文字不可选中、不可搜索。这是 JPEG 直通的
 *   必然结果，不是实现偷懒；面板上明说了（`modal.exportPdf.bitmapNote`）。
 *
 * ★ 本文件与 `toPng.ts` 一样**不碰 `document`**：`renderTile()` 收的是建好的 2D
 *   上下文，`buildPdf()` 收的是已经编码好的 JPEG 字节 —— 于是几何与 PDF 组装
 *   这两块都能在 node 下用假上下文 / 假字节跑单测。
 */

import { clamp, type Rect } from '../util/geometry';
import { t } from '../util/i18n';
import { alignTile, fillClippedText } from './toPng';
import type { PngRange } from './toPng';

// ─────────────────────────────────────────────────────────────
// 纸面与清晰度
// ─────────────────────────────────────────────────────────────

export type PdfOrientation = 'portrait' | 'landscape';

/** A4 纵向（pt）：210 × 297mm */
export const A4_PORTRAIT = { width: 595.28, height: 841.89 } as const;
/** A4 横向（pt） */
export const A4_LANDSCAPE = { width: 841.89, height: 595.28 } as const;

/**
 * 页边距（pt）≈ 10mm。
 *
 * ★ 不是"美观留白"，是**物理约束**：家用打印机的不可打印边距普遍在 3–5mm，
 *   把内容顶到纸边，用户在打印预览里会看到被裁掉一圈 —— 而那时他多半已经把
 *   一整本 PDF 发给了别人。
 */
export const PDF_PAGE_MARGIN = 28.35;

/** 纸上比例：1 世界 px = 1 pt（见文件头） */
export const PDF_WORLD_PER_PT = 1;

/** 每页图像长边像素的可选档（清晰度） */
export const PDF_PX_PER_PAGE_OPTIONS = [2048, 3072, 4096] as const;
export const DEFAULT_PDF_PX_PER_PAGE = 3072;
export const PDF_PX_PER_PAGE_MIN = 1024;
export const PDF_PX_PER_PAGE_MAX = 8192;

/** JPEG 质量：0.85 在"看得清"与"文件别太大"之间（多页 PDF 的体积主要在这里） */
export const DEFAULT_PDF_QUALITY = 0.85;
export const PDF_QUALITY_MIN = 0.4;
export const PDF_QUALITY_MAX = 1;

// ─────────────────────────────────────────────────────────────
// 分页几何（纯逻辑）
// ─────────────────────────────────────────────────────────────

export interface PdfExportOptions {
  /** 范围，默认 `'all'`（与 PNG 导出同一套语义） */
  range?: PngRange;
  /** 纸张方向，默认 `'portrait'` */
  orientation?: PdfOrientation;
  /** 每页图像长边像素（清晰度），默认 {@link DEFAULT_PDF_PX_PER_PAGE} */
  pxPerPage?: number;
  /** 四周留白（世界坐标 px）；默认值与 PNG 导出同一常量（`DEFAULT_PNG_PADDING` = 32） */
  padding?: number;
}

/** 一个绘制框（pt；**左上角为原点**，与 PDF 自己的左下角原点相反，写内容流时再翻） */
export interface PdfDraw {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 一页 = 一块 tile。
 *
 * ★ 刻意与 `PngTile` 同形（都是 `Rect` + `index` / `column` / `row`）：这样
 *   `renderTile(ctx, board, page, …)` 可以直接吃这一页，导出 PNG 与导出 PDF
 *   共用同一个绘制器，不存在"两种导出画出来的东西不一样"。
 */
export interface PdfPage extends Rect {
  index: number;
  column: number;
  row: number;
  /** 该页图像的像素尺寸（= tile × `scale`，与 `renderTile` 内部算法一致） */
  pixelWidth: number;
  pixelHeight: number;
  /** 图像在纸面上的位置与尺寸（pt，左上角原点） */
  draw: PdfDraw;
}

export interface PdfPlan {
  /** 含留白的导出边界（世界坐标） */
  bounds: Rect;
  orientation: PdfOrientation;
  /** 纸张尺寸（pt） */
  pageWidth: number;
  pageHeight: number;
  margin: number;
  /** 可打印区（pt） */
  contentWidth: number;
  contentHeight: number;
  /** 实际倍率：把世界坐标画成图像像素的比例（由清晰度与纸面反算） */
  scale: number;
  pxPerPage: number;
  pages: PdfPage[];
  columns: number;
  rows: number;
}

/**
 * 一条轴上"第 i 块该从哪开始"。
 *
 * 三种情形，各有各的理由：
 *  1. **只有一块**（内容比一页窄 / 矮）→ **居中**：一块 300×200 的小板贴在 A4 的
 *     左上角会显得像"没导全"，居中才像一张正经的图纸；
 *  2. **最后一块** → **贴回末端**（`start + span - pageSpan`）：让最后一页也满幅。
 *     否则余数只有几十像素时，最后一页会是一条细长条，而"贴回边缘"在多页海报
 *     拼贴里就是标准做法（代价是相邻两页有一点重叠，重叠只是多画一遍同样的内容）；
 *  3. 其余 → 顺次推进。
 */
function axisStart(
  start: number,
  span: number,
  pageSpan: number,
  index: number,
  count: number,
): number {
  if (count <= 1) return start - Math.max(0, pageSpan - span) / 2;
  if (index === count - 1) return start + span - pageSpan;
  return start + index * pageSpan;
}

/**
 * 一块 tile 在纸面上的绘制框（pt，左上角原点）：**就是可打印区**。
 *
 * ★ 为什么恒等于可打印区、而不是"按内容大小居中摆放"：tile 的世界尺寸本来就是由
 *   可打印区反推出来的（两者宽高比同源），所以这里永远是 1:1 —— **不放大、不拉伸**。
 *   一张 300×200 的小板如果拉满 A4，等于把位图放大 7 倍，纸上的字反而更糊；
 *   而"内容居中"这件事在 {@link axisStart} 里就做完了（靠 tile 的位置，不靠缩放）。
 */
function pageDraw(contentWidth: number, contentHeight: number, margin: number): PdfDraw {
  return {
    x: margin,
    y: margin,
    width: contentWidth * PDF_WORLD_PER_PT,
    height: contentHeight * PDF_WORLD_PER_PT,
  };
}

/**
 * 规划多页 PDF：算实际倍率与每一页。
 *
 * 空板 / 空边界返回零页（调用方据此提示"没有可导出的内容"），不抛错。
 */
export function planPdfExport(bounds: Rect | null, options: PdfExportOptions = {}): PdfPlan {
  const orientation: PdfOrientation =
    options.orientation === 'landscape' ? 'landscape' : 'portrait';
  const paper = orientation === 'landscape' ? A4_LANDSCAPE : A4_PORTRAIT;
  const margin = PDF_PAGE_MARGIN;
  const contentWidth = Math.max(1, paper.width - margin * 2);
  const contentHeight = Math.max(1, paper.height - margin * 2);
  const pxPerPage = clamp(
    Number.isFinite(options.pxPerPage) ? (options.pxPerPage as number) : DEFAULT_PDF_PX_PER_PAGE,
    PDF_PX_PER_PAGE_MIN,
    PDF_PX_PER_PAGE_MAX,
  );
  // 长边铺满每页像素：短边由宽高比自然得出，两轴同一比例，绝不拉伸
  const scale = pxPerPage / Math.max(contentWidth, contentHeight);

  const empty: PdfPlan = {
    bounds: { x: 0, y: 0, width: 0, height: 0 },
    orientation,
    pageWidth: paper.width,
    pageHeight: paper.height,
    margin,
    contentWidth,
    contentHeight,
    scale,
    pxPerPage,
    pages: [],
    columns: 0,
    rows: 0,
  };
  if (!bounds || bounds.width <= 0 || bounds.height <= 0) return empty;

  const pageWorldWidth = contentWidth * PDF_WORLD_PER_PT;
  const pageWorldHeight = contentHeight * PDF_WORLD_PER_PT;
  const columns = Math.max(1, Math.ceil(bounds.width / pageWorldWidth));
  const rows = Math.max(1, Math.ceil(bounds.height / pageWorldHeight));

  const pages: PdfPage[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const tile = alignTile({
        x: axisStart(bounds.x, bounds.width, pageWorldWidth, column, columns),
        y: axisStart(bounds.y, bounds.height, pageWorldHeight, row, rows),
        width: pageWorldWidth,
        height: pageWorldHeight,
      });

      pages.push({
        ...tile,
        index: pages.length,
        column,
        row,
        pixelWidth: Math.max(1, Math.round(tile.width * scale)),
        pixelHeight: Math.max(1, Math.round(tile.height * scale)),
        draw: pageDraw(contentWidth, contentHeight, margin),
      });
    }
  }

  return {
    bounds,
    orientation,
    pageWidth: paper.width,
    pageHeight: paper.height,
    margin,
    contentWidth,
    contentHeight,
    scale,
    pxPerPage,
    pages,
    columns,
    rows,
  };
}

// ─────────────────────────────────────────────────────────────
// 页脚（画进位图：PDF 里没有字体，中文只能这么进纸）
// ─────────────────────────────────────────────────────────────

export interface PdfFooterPalette {
  background: string;
  text: string;
  fontFamily: string;
}

export interface PdfFooterOptions {
  /** 图像像素尺寸（= 该页 canvas 的 `width` / `height`） */
  width: number;
  height: number;
  /** 当前页码（从 1 起） */
  page: number;
  total: number;
  label: string;
  palette: PdfFooterPalette;
}

/**
 * 在页脚画一行"白板名 · 第 i / n 页"。
 *
 * ★ 为什么画进**位图**而不是写成 PDF 文字：PDF 文字要嵌字体，非 ASCII 还得
 *   打包一份字体子集（几百 KB 起）。而页脚只是给人看的，画进位图零成本、
 *   中文一定不会变成方框。
 * ★ 只有**多页**时才画：单页 PDF 上写"第 1/1 页"是纯噪音。
 * ★ 先铺一条半透明底再写字：页脚压在内容上是常事（最后一行卡片就贴着纸边），
 *   没有底色时那行字会被卡片文字糊成一团。
 */
export function drawPageFooter(ctx: CanvasRenderingContext2D, options: PdfFooterOptions): void {
  if (options.total <= 1) return;
  const width = Math.max(1, options.width);
  const height = Math.max(1, options.height);
  const fontSize = clamp(Math.round(width * 0.014), 10, 28);
  const barHeight = Math.round(fontSize * 2.2);
  const text = t('pdf.footer.page', {
    label: options.label,
    page: options.page,
    total: options.total,
  });

  ctx.save();
  ctx.globalAlpha = 0.86;
  ctx.fillStyle = options.palette.background;
  ctx.fillRect(0, height - barHeight, width, barHeight);
  ctx.globalAlpha = 1;
  ctx.fillStyle = options.palette.text;
  ctx.font = `${fontSize}px ${options.palette.fontFamily}`;
  ctx.textBaseline = 'middle';
  fillClippedText(
    ctx,
    text,
    Math.round(fontSize),
    Math.round(height - barHeight / 2),
    width - fontSize * 2,
  );
  ctx.restore();
}

// ─────────────────────────────────────────────────────────────
// canvas → JPEG
// ─────────────────────────────────────────────────────────────

/**
 * canvas → JPEG 二进制。
 *
 * ★ 走 `toBlob` 而不是 `toDataURL`：后者先生成 base64（体积 ×1.37，且整串再复制
 *   一次），多页 PDF 一页一页攒起来时那是实打实的内存峰值（与 `canvasToArrayBuffer`
 *   同一个理由）。
 */
export function canvasToJpeg(
  canvas: HTMLCanvasElement,
  quality: number = DEFAULT_PDF_QUALITY,
): Promise<ArrayBuffer> {
  const q = clamp(
    Number.isFinite(quality) ? quality : DEFAULT_PDF_QUALITY,
    PDF_QUALITY_MIN,
    PDF_QUALITY_MAX,
  );
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error('nestboard: canvas could not be encoded as JPEG'));
          return;
        }
        blob.arrayBuffer().then(resolve, reject);
      },
      'image/jpeg',
      q,
    );
  });
}

// ─────────────────────────────────────────────────────────────
// PDF 组装（纯字节，无任何依赖）
// ─────────────────────────────────────────────────────────────

export interface PdfPageImage {
  /** 已经编码好的 JPEG 字节（`/DCTDecode` 原样收） */
  jpeg: Uint8Array;
  /** 图像像素宽高（PDF `/Width` `/Height`） */
  pixelWidth: number;
  pixelHeight: number;
  /** 在纸面上的绘制框（pt，左上角原点；直接来自 {@link PdfPage.draw}） */
  draw: PdfDraw;
}

export interface PdfDocumentInput {
  pageWidth: number;
  pageHeight: number;
  pages: readonly PdfPageImage[];
  /** 写进文档信息（`/Title`），可含中文 */
  title?: string;
  producer?: string;
  /** 创作时间（`/CreationDate`）；传进来而不是就地取，是为了让它可测 */
  createdAt?: Date;
}

const PDF_VERSION = '1.4';
const DEFAULT_PRODUCER = 'Nestboard';

/** 数字写成 PDF 认的形式：定点两位小数，非有限值按 0（绝不能写出 `NaN` 进文件） */
function num(value: number): string {
  const safe = Number.isFinite(value) ? value : 0;
  return String(Math.round(safe * 100) / 100);
}

/** 尺寸类数字：非有限值或非正数一律当 1 —— PDF 里 0 宽高等于"这页什么都没画" */
function size(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.max(1, Math.round(value)) : 1;
}

/** 坐标类数字：非有限值按 0 */
function coord(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

/** 结构字节一律按 Latin-1 取低字节（文件结构必须 ASCII，见 `buildPdf` 的二进制标记） */
function latin1(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) {
    out[index] = text.charCodeAt(index) & 0xff;
  }
  return out;
}

/** 逐段攒字节，并随时能报出"当前偏移"（xref 要的就是每个对象的字节偏移） */
class ByteSink {
  private readonly chunks: Uint8Array[] = [];
  private length = 0;

  get offset(): number {
    return this.length;
  }

  push(part: string | Uint8Array): void {
    const bytes = typeof part === 'string' ? latin1(part) : part;
    if (bytes.length === 0) return;
    this.chunks.push(bytes);
    this.length += bytes.length;
  }

  concat(): Uint8Array {
    const out = new Uint8Array(this.length);
    let at = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, at);
      at += chunk.length;
    }
    return out;
  }
}

/**
 * PDF 文本串。
 *
 * ★ 判断而不是硬转：ASCII 走 `(…)` 字面串（可读、好查）；含中文（标题）走
 *   **UTF-16BE + BOM** 的十六进制串 `<feff…>`。PDF 没有"UTF-8 文本串"这种东西，
 *   直接写 UTF-8 字节，阅读器会显示成一堆乱码。
 */
export function pdfTextString(text: string): string {
  if (/^[\u0020-\u007e]*$/.test(text)) {
    return `(${text.replace(/[\\()]/g, (char) => `\\${char}`)})`;
  }
  const units: string[] = ['feff'];
  for (let index = 0; index < text.length; index += 1) {
    units.push(text.charCodeAt(index).toString(16).padStart(4, '0'));
  }
  return `<${units.join('')}>`;
}

/** `D:YYYYMMDDHHmmSS±HH'mm'`（PDF 的日期串） */
export function pdfDate(date: Date): string {
  const pad = (value: number): string => String(Math.floor(Math.abs(value))).padStart(2, '0');
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes < 0 ? '-' : '+';
  const offset = `${sign}${pad(offsetMinutes / 60)}'${pad(offsetMinutes % 60)}'`;
  return `D:${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(
    date.getHours(),
  )}${pad(date.getMinutes())}${pad(date.getSeconds())}${offset}`;
}

/** 一页的内容流：把图像贴到绘制框上 */
function contentStream(page: PdfPageImage, pageHeight: number): string {
  const width = size(page.draw.width);
  const height = size(page.draw.height);
  // PDF 原点在**左下角**，而绘制框是"从左上角往下量"的 → 这里把 y 翻过来
  const y = pageHeight - coord(page.draw.y) - height;
  return `q\n${num(width)} 0 0 ${num(height)} ${num(coord(page.draw.x))} ${num(y)} cm\n/Im0 Do\nQ\n`;
}

/**
 * 组装 PDF 字节。
 *
 * 对象编号是**算出来的**（不靠遍历时递增），因为 `trailer` 与每页的 `/Resources`
 * 都要提前互相引用：
 * ```
 * 1  ·  Catalog
 * 2  ·  Pages
 * 3+3i · 第 i 页（3 = 第一页）
 * 4+3i · 第 i 页的内容流
 * 5+3i · 第 i 页的图像
 * 末尾 ·  Info
 * ```
 *
 * @returns 没有页时返回 `null`（调用方据此提示"没有可导出的内容"）；
 *   某一页的 JPEG 是空的则**抛错** —— 那是"画都没画出来"，产出半本 PDF 只会更糟
 */
export function buildPdf(input: PdfDocumentInput): Uint8Array | null {
  if (input.pages.length === 0) return null;

  const pageWidth = Number.isFinite(input.pageWidth) && input.pageWidth > 0 ? input.pageWidth : 1;
  const pageHeight =
    Number.isFinite(input.pageHeight) && input.pageHeight > 0 ? input.pageHeight : 1;

  const sink = new ByteSink();
  const offsets: number[] = [];
  const open = (id: number): void => {
    offsets[id] = sink.offset;
    sink.push(`${id} 0 obj\n`);
  };
  const close = (): void => {
    sink.push('endobj\n');
  };

  // 第二行那段高位字节是 PDF 规范的"二进制标记"：让工具按二进制处理这个文件。
  // 少了它，某些工具（尤其是 Windows 上的）会把 PDF 当文本文件、动辄改掉换行。
  sink.push(`%PDF-${PDF_VERSION}\n%\u00e2\u00e3\u00cf\u00d3\n`);

  open(1);
  sink.push('<< /Type /Catalog /Pages 2 0 R >>\n');
  close();

  const kids = input.pages.map((_, index) => `${3 + index * 3} 0 R`).join(' ');
  open(2);
  sink.push(`<< /Type /Pages /Count ${input.pages.length} /Kids [${kids}] >>\n`);
  close();

  input.pages.forEach((page, index) => {
    const pageId = 3 + index * 3;
    const contentId = pageId + 1;
    const imageId = pageId + 2;
    const stream = latin1(contentStream(page, pageHeight));

    open(pageId);
    sink.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(pageWidth)} ${num(pageHeight)}] ` +
        `/Resources << /ProcSet [/PDF /ImageC] /XObject << /Im0 ${imageId} 0 R >> >> ` +
        `/Contents ${contentId} 0 R >>\n`,
    );
    close();

    open(contentId);
    sink.push(`<< /Length ${stream.length} >>\nstream\n`);
    sink.push(stream);
    sink.push('endstream\n');
    close();

    // 空 JPEG = 这一页根本没画出来：宁可整次导出失败，也不产出半本 PDF
    if (page.jpeg.length === 0) {
      throw new Error(`nestboard: page ${index + 1} has no image data`);
    }
    const width = size(page.pixelWidth);
    const height = size(page.pixelHeight);

    open(imageId);
    sink.push(
      `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} ` +
        '/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode ' +
        `/Length ${page.jpeg.length} >>\nstream\n`,
    );
    sink.push(page.jpeg);
    sink.push('\nendstream\n');
    close();
  });

  const infoId = 3 + input.pages.length * 3;
  open(infoId);
  sink.push(`<< /Producer ${pdfTextString(input.producer ?? DEFAULT_PRODUCER)}`);
  if (input.title && input.title.trim().length > 0) {
    sink.push(` /Title ${pdfTextString(input.title)}`);
  }
  sink.push(` /CreationDate ${pdfTextString(pdfDate(input.createdAt ?? new Date()))} >>\n`);
  close();

  // xref：**每个对象在文件里的字节偏移**。这是全文件唯一"必须精确"的地方 ——
  // 差一个字节，阅读器就会说"文件已损坏"，而且它不会告诉你差在哪。
  const xrefOffset = sink.offset;
  const objectCount = infoId + 1;
  sink.push(`xref\n0 ${objectCount}\n`);
  sink.push('0000000000 65535 f \n');
  for (let id = 1; id < objectCount; id += 1) {
    sink.push(`${String(offsets[id] ?? 0).padStart(10, '0')} 00000 n \n`);
  }
  sink.push(`trailer\n<< /Size ${objectCount} /Root 1 0 R /Info ${infoId} 0 R >>\n`);
  sink.push(`startxref\n${xrefOffset}\n%%EOF\n`);

  return sink.concat();
}

// ─────────────────────────────────────────────────────────────
// 落盘（窄接口 + 命名）
// ─────────────────────────────────────────────────────────────

/** 二进制写入口（生产实现：`io/vaultIO.ts`） */
export interface PdfExportSink {
  exists(path: string): Promise<boolean>;
  createBinary(path: string, data: ArrayBuffer): Promise<void>;
}

export interface PdfExportTarget {
  /** Vault 相对目录（`''` = 根目录） */
  folder: string;
  /** 不含扩展名的文件名（调用方已做过非法字符清理） */
  name: string;
}

/** 导出文件名（不含目录） */
export function pdfFileName(name: string): string {
  return `${name}.pdf`;
}

/** `Uint8Array` → 精确覆盖它的 `ArrayBuffer`（`vault.createBinary` 收的是后者） */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/**
 * 把一份 PDF 写进 Vault，返回实际落盘路径。
 *
 * ★ **不做"覆盖上次导出"**（与 `MarkdownExporter` 的指纹策略不同，与 `PngExporter`
 *   一致）：PDF 是无结构的二进制，认不出"这本是不是我们上次导出的"，误判就会覆盖
 *   用户的文件。所以一律顺延命名（`名字.pdf` → `名字 2.pdf` → …），代价是多出几个
 *   文件，而不是可能的**覆盖** —— 后者是不可逆的。
 */
export class PdfExporter {
  constructor(private readonly sink: PdfExportSink) {}

  async export(bytes: Uint8Array, target: PdfExportTarget): Promise<string> {
    const prefix = target.folder.length > 0 ? `${target.folder.replace(/\/+$/, '')}/` : '';
    const path = await this.freePath(prefix, pdfFileName(target.name));
    await this.sink.createBinary(path, toArrayBuffer(bytes));
    return path;
  }

  /** 顺延找名字（`名字.pdf` → `名字 2.pdf` → …）；上限只为防死循环 */
  private async freePath(prefix: string, file: string): Promise<string> {
    const base = file.slice(0, file.length - 4);
    let target = `${prefix}${file}`;
    let index = 2;
    while (index < 1000 && (await this.sink.exists(target))) {
      target = `${prefix}${base} ${index}.pdf`;
      index += 1;
    }
    return target;
  }
}
