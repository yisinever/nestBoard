/**
 * PDF 预览卡（`F8`，用户 2026-09-21："支持 pdf 文件类型的预览" + "要求可翻页"）。
 *
 * ── 它长什么样 ───────────────────────────────────────────────
 *
 * 卡面就是一页纸：`<embed>` 直接交给 **Chromium 自带的 PDF 查看器**（与 Obsidian 原生
 * `![[x.pdf]]` 同一个机制，Electron 下可用），底下一条窄条给页码与翻页按钮。
 * 没有标题栏、也没有"大小"那一行 —— 这张卡的全部内容就是那页纸。
 *
 * ── 翻页怎么做的（用户定的是"可翻页"）────────────────────────
 *
 * Chromium 的 PDF 查看器认 URL 上的 `#page=N` 片段，所以**翻页 = 换片段重挂 `<embed>`**。
 * 页码状态放在**元素的 `dataset` 上**（`data-pdf-page`）：
 * ★ **不进模型**：翻页是"看一眼" —— 写进 `.nboard` 会污染文件，还会把每一次翻页塞进撤销栈。
 * ★ 代价：卡片因内容变化而重画之后回到第 1 页。可接受 —— 翻页不是"这份文档的状态"。
 * ★ 若某个平台上 `#page=` 不被认（只能在真机上试出来），表现是"按钮点了但页面没动"，
 *   此时**滚动与缩放照旧可用**（`<embed>` 自己的查看器有完整工具条）—— 卡不会因此坏掉。
 *
 * ── 为什么内容形状与文件卡共用 ───────────────────────────────
 *
 * 它也就是"指向库内一份文件"（见 `schema.ts` 的 `CardContentMap.pdf`）：一个路径 +
 * 一个不画的 `showSize`。多立一个接口只会多一处要同步的映射（与 `video` / `audio` 同一条）。
 */

import type { CardOf } from '../model/schema';
import type { Size } from '../util/geometry';
import { t } from '../util/i18n';
import type { CardRenderContext, CardTypeDefinition } from './registry';

/** 默认尺寸：**A4 竖版比例**（320×400 ≈ 1:1.25）—— 一页纸长什么样，卡片就长什么样 */
export const PDF_CARD_DEFAULT_SIZE: Size = { width: 320, height: 400 };

/** 卡面几个元素的 class（样式表认它们） */
const PDF_ROOT_CLASS = 'nestboard-pdf';
const PDF_FRAME_CLASS = 'nestboard-pdf-frame';
const PDF_BAR_CLASS = 'nestboard-pdf-bar';
const PDF_LABEL_CLASS = 'nestboard-pdf-label';
const PDF_BUTTON_CLASS = 'nestboard-pdf-button';
const PDF_EMPTY_CLASS = 'nestboard-pdf-empty';

/** 页码存在元素上（**视图状态、不进模型**，见文件头） */
const PDF_PAGE_ATTR = 'pdfPage';

export const pdfCard: CardTypeDefinition<'pdf'> = {
  type: 'pdf',

  get displayName(): string {
    return t('card.type.pdf');
  },

  icon: 'file-text',
  defaultSize: PDF_CARD_DEFAULT_SIZE,

  /**
   * 右键菜单：这张卡**没有「编辑内容」**（内容就是一段路径，卡上没有可写的地方 ——
   * 要换文件就重新拖一张进来）、**不显示标题栏**（卡面全给那页纸）。
   * ★ 与仅标题卡同一条口径：是"整项不出现"，不是置灰。
   */
  menuItems: { editContent: false, showTitle: false },

  createDefaultContent() {
    return { path: '', showSize: false };
  },

  render(el, card, ctx): void {
    el.classList.add(PDF_ROOT_CLASS);
    paintPdf(el, card, ctx, pageOf(el));
  },

  destroy(el): void {
    el.classList.remove(PDF_ROOT_CLASS);
    delete el.dataset[PDF_PAGE_ATTR];
    el.replaceChildren();
  },

  /** 导出成 Markdown 用 `![[…]]`：Obsidian 自己会把它嵌成 PDF 视图 */
  toMarkdown(card): string {
    return card.content.path.length > 0 ? `![[${card.content.path}]]` : '';
  },
};

/**
 * 照第 `page` 页重画一次卡面。
 *
 * ★ `render` 与翻页按钮**共用这一条路**：两处各写一份的话，"翻完页之后翻页条没了"
 *   这类毛病迟早出现。
 */
function paintPdf(
  el: HTMLElement,
  card: CardOf<'pdf'>,
  ctx: CardRenderContext,
  page: number,
): void {
  const doc = el.ownerDocument;
  const path = card.content.path;

  // 空卡（新建出来等着拖文件）：给一句引导，别留一片白
  if (path.length === 0) {
    const empty = doc.createElement('div');
    empty.className = PDF_EMPTY_CLASS;
    empty.textContent = t('card.pdf.empty');
    el.replaceChildren(empty);
    return;
  }

  const frame = doc.createElement('embed');
  frame.className = PDF_FRAME_CLASS;
  frame.setAttribute('type', 'application/pdf');
  frame.setAttribute('src', pdfSrcOf(ctx, path, page));

  const bar = doc.createElement('div');
  bar.className = PDF_BAR_CLASS;

  const label = doc.createElement('span');
  label.className = PDF_LABEL_CLASS;
  label.textContent = t('card.pdf.page', { page: String(page) });

  bar.append(
    pageButton(doc, '‹', t('card.pdf.prev'), () => applyPdfPage(el, card, ctx, page - 1)),
    label,
    pageButton(doc, '›', t('card.pdf.next'), () => applyPdfPage(el, card, ctx, page + 1)),
  );
  el.replaceChildren(frame, bar);
}

/** 翻一页：页码记在元素上，然后照它重画（第 1 页是下限，不做出界） */
function applyPdfPage(
  el: HTMLElement,
  card: CardOf<'pdf'>,
  ctx: CardRenderContext,
  page: number,
): void {
  const next = Math.max(1, page);
  el.dataset[PDF_PAGE_ATTR] = String(next);
  paintPdf(el, card, ctx, next);
}

/** 现在停在第几页（没记过 / 记坏了都算第 1 页） */
function pageOf(el: HTMLElement): number {
  const raw = Number.parseInt(el.dataset[PDF_PAGE_ATTR] ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
}

/**
 * 库内路径 → 能塞进 `<embed src>` 的地址（带 `#page=N`）。
 *
 * ★ `vault.adapter.getResourcePath`：Obsidian 把库内文件映射成 `app://…` 的唯一公开入口
 *   （图片卡 / 视频卡那两处也是同一个来源）。
 * ★ 取不到就**返回空串**：卡面顶多空着，不能因为一个路径解析失败把整块板子拖垮。
 */
function pdfSrcOf(ctx: CardRenderContext, path: string, page: number): string {
  try {
    return `${ctx.app.vault.adapter.getResourcePath(path)}#page=${page}`;
  } catch {
    return '';
  }
}

/**
 * 翻页按钮：`<span role="button">` 而不是 `<button>`。
 *
 * ★ 与大纲那两件（三角 / 圆点）同一条真实报障换来的结论：主题的
 *   `button:not(.clickable-icon)` 规则特异性 (0,1,1) 压过我们自己的类 (0,1,0)，
 *   常态就顶着一层底色 + 阴影；换成 `<span>` 才真的干净。
 */
function pageButton(doc: Document, glyph: string, label: string, onClick: () => void): HTMLElement {
  const button = doc.createElement('span');
  button.className = PDF_BUTTON_CLASS;
  button.setAttribute('role', 'button');
  button.setAttribute('tabindex', '-1');
  button.setAttribute('aria-label', label);
  button.setAttribute('title', label);
  button.textContent = glyph;
  button.addEventListener('click', (event) => {
    // 不让它冒泡到卡片上：那会顺手变成"选中 / 拖动这张卡"
    event.stopPropagation();
    onClick();
  });
  return button;
}
