/**
 * 导出 PDF 对话框（T4.10 / `F9-03`）。
 *
 * 与 PNG 面板（`ExportPngModal`）是同一路东西：**面板不算几何、不认识白板**，
 * 只攒选项，再把 `summarize()` 交回视图去算"会写多少页、每页多大"。这里不再重复
 * 那段理由，只说三处**刻意的不同**，每一处都有代价在背后：
 *
 *  1. **没有"倍率"，换成"清晰度（每页多少像素）"**：PDF 的页数由**纸面与内容**决定，
 *     像素只决定印刷清晰度与文件体积。把它叫"倍率"会让人以为"2× 就是两倍大 / 两张"，
 *     而实际发生的是"同一页、不同的 dpi"（见 `export/toPdf.ts` 文件头）。
 *  2. **没有"单页全景"**：把一整块板压进一张 A4，字会小到印出来看不清 —— "多页 tile"
 *     才是 PDF 的正当用法（要单张全景大图，PNG 导出那条路更合适）。
 *  3. **没有"背景透明"**：PDF 里的图是 JPEG，而 JPEG 没有 alpha 通道。给一个怎么点都
 *     不会生效的开关，比如实说出来"PDF 不支持"更糟。
 *
 * ★ 额外多一句**位图声明**：产物里的文字不可选中、不可搜索。这是 JPEG 直通的必然结果
 *   （要可搜索的文字就得嵌字体、打包字体子集，那是另一个量级的工程）。用户常常是拿着
 *   PDF 去开会时才发现搜不到 —— 那比现在就看到这句话糟得多。
 */

import { Modal, Setting } from 'obsidian';
import type { App } from 'obsidian';
import { DEFAULT_PDF_PX_PER_PAGE, PDF_PX_PER_PAGE_OPTIONS } from '../../export/toPdf';
import type { PdfOrientation } from '../../export/toPdf';
import type { PngRange } from '../../export/toPng';
import { t } from '../../util/i18n';

/** 面板攒出来的导出请求（与 `PdfExportOptions` 同名同义） */
export interface PdfExportRequest {
  range: PngRange;
  orientation: PdfOrientation;
  pxPerPage: number;
}

/** 实时摘要：`text` 显示给用户，`ready` 决定"导出"按钮是否可点 */
export interface PdfPlanSummary {
  text: string;
  ready: boolean;
}

export interface ExportPdfModalOptions {
  /** 当前是否有选中内容（决定是否给出"仅选中"这一项） */
  hasSelection: boolean;
  /** 用当前选项预估产物（由视图计算，面板只负责显示） */
  summarize(request: PdfExportRequest): PdfPlanSummary;
  onExport(request: PdfExportRequest): void;
}

/** 清晰度档位的文案；表里没有的档位（以后加的）退回显示像素数，不至于没有标签 */
const CLARITY_LABELS: Record<number, () => string> = {
  2048: () => t('modal.exportPdf.clarity.standard'),
  3072: () => t('modal.exportPdf.clarity.high'),
  4096: () => t('modal.exportPdf.clarity.ultra'),
};

export class ExportPdfModal extends Modal {
  private request: PdfExportRequest = {
    range: 'all',
    orientation: 'portrait',
    pxPerPage: DEFAULT_PDF_PX_PER_PAGE,
  };

  private planEl: HTMLElement | null = null;
  private confirmButton: HTMLButtonElement | null = null;

  constructor(
    app: App,
    private readonly options: ExportPdfModalOptions,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.titleEl.setText(t('modal.exportPdf.title'));
    const { contentEl } = this;

    new Setting(contentEl)
      .setName(t('modal.exportPdf.range.name'))
      .setDesc(t('modal.exportPdf.range.desc'))
      .addDropdown((dropdown) => {
        dropdown.addOption('all', t('modal.exportPdf.range.all'));
        dropdown.addOption('viewport', t('modal.exportPdf.range.viewport'));
        // 「仅选中」在没有选区时**直接不出现**，而不是灰着（与 PNG 面板同一取舍）
        if (this.options.hasSelection) {
          dropdown.addOption('selection', t('modal.exportPdf.range.selection'));
        }
        dropdown.setValue(this.request.range).onChange((value) => {
          this.request.range = value as PngRange;
          this.refresh();
        });
      });

    new Setting(contentEl)
      .setName(t('modal.exportPdf.orientation.name'))
      .setDesc(t('modal.exportPdf.orientation.desc'))
      .addDropdown((dropdown) => {
        dropdown.addOption('portrait', t('modal.exportPdf.orientation.portrait'));
        dropdown.addOption('landscape', t('modal.exportPdf.orientation.landscape'));
        dropdown.setValue(this.request.orientation).onChange((value) => {
          this.request.orientation = value === 'landscape' ? 'landscape' : 'portrait';
          this.refresh();
        });
      });

    new Setting(contentEl)
      .setName(t('modal.exportPdf.clarity.name'))
      .setDesc(t('modal.exportPdf.clarity.desc'))
      .addDropdown((dropdown) => {
        // 档位来自 `PDF_PX_PER_PAGE_OPTIONS` 本身：以后加档位这里自动出现，
        // 不会出现"常量里有、面板里没有"的漂移
        for (const value of PDF_PX_PER_PAGE_OPTIONS) {
          dropdown.addOption(String(value), CLARITY_LABELS[value]?.() ?? `${value} px`);
        }
        dropdown.setValue(String(this.request.pxPerPage)).onChange((value) => {
          this.request.pxPerPage = Number(value) || DEFAULT_PDF_PX_PER_PAGE;
          this.refresh();
        });
      });

    contentEl.createDiv({
      cls: 'nestboard-export-pdf__note',
      text: t('modal.exportPdf.bitmapNote'),
    });

    this.planEl = contentEl.createDiv({ cls: 'nestboard-export-pdf__plan' });

    const buttons = new Setting(contentEl)
      .addButton((button) => button.setButtonText(t('modal.cancel')).onClick(() => this.close()))
      .addButton((button) =>
        button
          .setButtonText(t('modal.exportPdf.export'))
          .setCta()
          .onClick(() => this.submit()),
      );

    // 最后一个按钮 = 导出（`addButton` 依次追加，取末位最稳；`RenameBoardModal` 同法）
    const all = buttons.controlEl.querySelectorAll('button');
    this.confirmButton = all[all.length - 1] ?? null;

    this.refresh();
  }

  override onClose(): void {
    this.planEl = null;
    this.confirmButton = null;
    this.contentEl.empty();
  }

  private refresh(): void {
    const summary = this.options.summarize(this.request);
    this.planEl?.setText(summary.text);
    this.planEl?.toggleClass('is-empty', !summary.ready);
    if (this.confirmButton) this.confirmButton.disabled = !summary.ready;
  }

  private submit(): void {
    if (!this.options.summarize(this.request).ready) return;
    // 先关面板再回调：导出是逐页画、逐页编码的异步过程，留着面板会让人以为卡住了
    const request = { ...this.request };
    this.close();
    this.options.onExport(request);
  }
}
