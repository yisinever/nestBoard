/**
 * 导出 SVG 对话框（T6.01 / `F9-06`）。
 *
 * ★ 选项只有两项（**范围** + **背景透明**），比 PNG / PDF 少得多 —— 这是刻意的：
 *   矢量没有倍率（放大多少倍都是那几个形状），也没有分页（没有像素上限）。
 *   搬过来只会让用户面对一堆"选了也没区别"的下拉框（见 `export/toSvg.ts` 文件头）。
 *
 * ★ 仍然照 `ExportPngModal` 的分工：面板**不算几何、不认识白板**，只攒选项，
 *   把"会产出多大的东西"交给视图的 `summarize()` 实时回答。判空与禁用按钮
 *   也走同一个 `ready`，两边不会各算一套。
 *
 * ★ 图片卡 / 手绘卡在 SVG 里只有文字（不内嵌位图）—— 这是**安静**的降级，
 *   所以摘要里会明说一句，而不是等用户打开文件才发现图没了。
 */

import { Modal, Setting } from 'obsidian';
import type { App } from 'obsidian';
import type { PngRange } from '../../export/toPng';
import { t } from '../../util/i18n';

/** 面板攒出来的导出请求 */
export interface SvgExportRequest {
  range: PngRange;
  transparent: boolean;
}

/** 实时摘要：`text` 显示给用户，`ready` 决定"导出"按钮是否可点 */
export interface SvgPlanSummary {
  text: string;
  ready: boolean;
}

export interface ExportSvgModalOptions {
  /** 当前是否有选中内容（决定是否给出"仅选中"这一项） */
  hasSelection: boolean;
  /** 用当前选项预估产物（由视图计算，面板只负责显示） */
  summarize(request: SvgExportRequest): SvgPlanSummary;
  onExport(request: SvgExportRequest): void;
}

export class ExportSvgModal extends Modal {
  private request: SvgExportRequest = { range: 'all', transparent: false };

  private planEl: HTMLElement | null = null;
  private confirmButton: HTMLButtonElement | null = null;

  constructor(
    app: App,
    private readonly options: ExportSvgModalOptions,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.titleEl.setText(t('modal.exportSvg.title'));
    const { contentEl } = this;

    new Setting(contentEl)
      .setName(t('modal.exportSvg.range.name'))
      .setDesc(t('modal.exportSvg.range.desc'))
      .addDropdown((dropdown) => {
        dropdown.addOption('all', t('modal.exportSvg.range.all'));
        dropdown.addOption('viewport', t('modal.exportSvg.range.viewport'));
        if (this.options.hasSelection) {
          dropdown.addOption('selection', t('modal.exportSvg.range.selection'));
        }
        dropdown.setValue(this.request.range).onChange((value) => {
          this.request.range = value as PngRange;
          this.refresh();
        });
      });

    new Setting(contentEl)
      .setName(t('modal.exportSvg.transparent.name'))
      .setDesc(t('modal.exportSvg.transparent.desc'))
      .addToggle((toggle) =>
        toggle.setValue(this.request.transparent).onChange((value) => {
          this.request.transparent = value;
          this.refresh();
        }),
      );

    this.planEl = contentEl.createDiv({ cls: 'nestboard-export-svg__plan' });

    const buttons = new Setting(contentEl)
      .addButton((button) => button.setButtonText(t('modal.cancel')).onClick(() => this.close()))
      .addButton((button) =>
        button
          .setButtonText(t('modal.exportSvg.export'))
          .setCta()
          .onClick(() => this.submit()),
      );

    // 最后一个按钮 = 导出（`addButton` 依次追加，取末位最稳；`ExportPngModal` 同法）
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
    const request = { ...this.request };
    this.close();
    this.options.onExport(request);
  }
}
