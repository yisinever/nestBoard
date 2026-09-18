/**
 * 打印对话框（T6.03 / `F9-10`）。
 *
 * 与 PDF 面板（`ExportPdfModal`）是同一路东西，同样的"面板不懂几何"分工：
 * 它只攒选项，把"会印几页、每页多大"交回 `summarize()` 去算。这里只说三处
 * **刻意的不同**，每一处都有代价在背后：
 *
 *  1. **没有"清晰度"**：打印是即刻消耗的，不值当给一个"越高越慢、越占内存"
 *     的旋钮 —— 每页像素钉死在 `DEFAULT_PRINT_PX_PER_PAGE`（见 `toPrint.ts`）。
 *  2. **没有"背景透明"**：打印纸本来就是白的，而产物是 JPEG（无 alpha）。
 *     给一个怎么点都不会生效的开关，比如实说"打印不支持"更糟。
 *  3. **多一句"分幅提示"**：超出一页时相邻两块**刻意重叠**（拼贴成海报时必须），
 *     这句话只在真会跨页时出现 —— 单页板子上说它纯属噪音。
 *
 * ★ 页脚是**真文字**（不是位图）：打印文档里没有"嵌字体"的负担，所以页码不必
 *   画进图里 —— 这是打印相对 PDF 唯一"更富"的地方。
 */

import { Modal, Setting } from 'obsidian';
import type { App } from 'obsidian';
import type { PdfOrientation } from '../../export/toPdf';
import type { PngRange } from '../../export/toPng';
import { t } from '../../util/i18n';

/** 面板攒出来的打印请求 */
export interface PrintExportRequest {
  range: PngRange;
  orientation: PdfOrientation;
}

/** 实时摘要：`text` 显示给用户，`ready` 决定"打印"按钮是否可点 */
export interface PrintPlanSummary {
  text: string;
  ready: boolean;
  /** 分幅（海报）提示；不传表示这一份是单页，不必说 */
  hint?: string;
}

export interface ExportPrintModalOptions {
  /** 当前是否有选中内容（决定是否给出"仅选中"这一项） */
  hasSelection: boolean;
  /** 用当前选项预估产物（由视图计算，面板只负责显示） */
  summarize(request: PrintExportRequest): PrintPlanSummary;
  onPrint(request: PrintExportRequest): void;
}

export class ExportPrintModal extends Modal {
  private request: PrintExportRequest = {
    range: 'all',
    orientation: 'portrait',
  };

  private hintEl: HTMLElement | null = null;
  private planEl: HTMLElement | null = null;
  private confirmButton: HTMLButtonElement | null = null;

  constructor(
    app: App,
    private readonly options: ExportPrintModalOptions,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.titleEl.setText(t('modal.exportPrint.title'));
    const { contentEl } = this;

    new Setting(contentEl)
      .setName(t('modal.exportPrint.range.name'))
      .setDesc(t('modal.exportPrint.range.desc'))
      .addDropdown((dropdown) => {
        dropdown.addOption('all', t('modal.exportPrint.range.all'));
        dropdown.addOption('viewport', t('modal.exportPrint.range.viewport'));
        // 「仅选中」在没有选区时**直接不出现**，而不是灰着（与 PNG / PDF 面板同一取舍）
        if (this.options.hasSelection) {
          dropdown.addOption('selection', t('modal.exportPrint.range.selection'));
        }
        dropdown.setValue(this.request.range).onChange((value) => {
          this.request.range = value as PngRange;
          this.refresh();
        });
      });

    new Setting(contentEl)
      .setName(t('modal.exportPrint.orientation.name'))
      .setDesc(t('modal.exportPrint.orientation.desc'))
      .addDropdown((dropdown) => {
        dropdown.addOption('portrait', t('modal.exportPrint.orientation.portrait'));
        dropdown.addOption('landscape', t('modal.exportPrint.orientation.landscape'));
        dropdown.setValue(this.request.orientation).onChange((value) => {
          this.request.orientation = value === 'landscape' ? 'landscape' : 'portrait';
          this.refresh();
        });
      });

    // 分幅提示：只有视图说"会跨页"时才填内容（`is-empty` 顺手把它藏起来）
    this.hintEl = contentEl.createDiv({ cls: 'nestboard-export-print__hint is-empty' });

    this.planEl = contentEl.createDiv({ cls: 'nestboard-export-print__plan' });

    const buttons = new Setting(contentEl)
      .addButton((button) => button.setButtonText(t('modal.cancel')).onClick(() => this.close()))
      .addButton((button) =>
        button
          .setButtonText(t('modal.exportPrint.confirm'))
          .setCta()
          .onClick(() => this.submit()),
      );

    // 最后一个按钮 = 打印（`addButton` 依次追加，取末位最稳；`RenameBoardModal` 同法）
    const all = buttons.controlEl.querySelectorAll('button');
    this.confirmButton = all[all.length - 1] ?? null;

    this.refresh();
  }

  override onClose(): void {
    this.hintEl = null;
    this.planEl = null;
    this.confirmButton = null;
    this.contentEl.empty();
  }

  private refresh(): void {
    const summary = this.options.summarize(this.request);
    if (this.hintEl) {
      this.hintEl.setText(summary.hint ?? '');
      this.hintEl.toggleClass('is-empty', !summary.hint);
    }
    this.planEl?.setText(summary.text);
    this.planEl?.toggleClass('is-empty', !summary.ready);
    if (this.confirmButton) this.confirmButton.disabled = !summary.ready;
  }

  private submit(): void {
    if (!this.options.summarize(this.request).ready) return;
    // 先关面板再回调：逐页画、逐页编码是异步的，留着面板会让人以为卡住了
    const request = { ...this.request };
    this.close();
    this.options.onPrint(request);
  }
}
