/**
 * 导出 PNG 对话框（T2.11 / `F9-02`）。
 *
 * 四项选项正好对应 `F9-02` 的验收点：**范围 / 倍率 / 背景透明 /（分页 tile 还是单页全景）**。
 *
 * ★ 面板**不算几何、不认识白板**：它只攒四个选项，再用 `summarize()` 把当前选择
 *   实时交给视图去算"会写几个文件、每张多大"。分页数、像素尺寸都取决于白板边界，
 *   面板要自己算就得拖进 `model/`、视口、选区三份依赖 —— 那正是 `SearchPanel`
 *   刻意避开的耦合（见其文件头）。
 *
 * ★ 「仅选中」在**没有选区时直接不出现**，而不是灰着：灰着的选项会让人一直猜
 *   "怎么才能点亮它"，而用户真正需要知道的只是"先选中点东西"。
 */

import { Modal, Setting } from 'obsidian';
import type { App } from 'obsidian';
import { PNG_SCALE_MAX, PNG_SCALE_MIN, DEFAULT_PNG_SCALE } from '../../export/toPng';
import type { PngRange } from '../../export/toPng';
import { t } from '../../util/i18n';

/** 面板攒出来的导出请求（与 `PngExportOptions` 同名同义） */
export interface PngExportRequest {
  range: PngRange;
  scale: number;
  transparent: boolean;
  paginate: boolean;
}

/** 实时摘要：`text` 显示给用户，`ready` 决定"导出"按钮是否可点 */
export interface PngPlanSummary {
  text: string;
  ready: boolean;
}

export interface ExportPngModalOptions {
  /** 当前是否有选中内容（决定是否给出"仅选中"这一项） */
  hasSelection: boolean;
  /** 用当前选项预估产物（由视图计算，面板只负责显示） */
  summarize(request: PngExportRequest): PngPlanSummary;
  onExport(request: PngExportRequest): void;
}

export class ExportPngModal extends Modal {
  private request: PngExportRequest = {
    range: 'all',
    scale: DEFAULT_PNG_SCALE,
    transparent: false,
    paginate: true,
  };

  private planEl: HTMLElement | null = null;
  private confirmButton: HTMLButtonElement | null = null;

  constructor(
    app: App,
    private readonly options: ExportPngModalOptions,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.titleEl.setText(t('modal.exportPng.title'));
    const { contentEl } = this;

    new Setting(contentEl)
      .setName(t('modal.exportPng.range.name'))
      .setDesc(t('modal.exportPng.range.desc'))
      .addDropdown((dropdown) => {
        dropdown.addOption('all', t('modal.exportPng.range.all'));
        dropdown.addOption('viewport', t('modal.exportPng.range.viewport'));
        if (this.options.hasSelection) {
          dropdown.addOption('selection', t('modal.exportPng.range.selection'));
        }
        dropdown.setValue(this.request.range).onChange((value) => {
          this.request.range = value as PngRange;
          this.refresh();
        });
      });

    new Setting(contentEl)
      .setName(t('modal.exportPng.scale.name'))
      .setDesc(t('modal.exportPng.scale.desc'))
      .addDropdown((dropdown) => {
        // 倍率只给整数档：用户要的是"更清楚一点"，而不是一个可以填 2.37 的输入框
        for (let scale = PNG_SCALE_MIN; scale <= PNG_SCALE_MAX; scale += 1) {
          dropdown.addOption(String(scale), `${scale}×`);
        }
        dropdown.setValue(String(this.request.scale)).onChange((value) => {
          this.request.scale = Number(value) || DEFAULT_PNG_SCALE;
          this.refresh();
        });
      });

    new Setting(contentEl)
      .setName(t('modal.exportPng.paginate.name'))
      .setDesc(t('modal.exportPng.paginate.desc'))
      .addDropdown((dropdown) => {
        dropdown.addOption('tiled', t('modal.exportPng.paginate.on'));
        dropdown.addOption('single', t('modal.exportPng.paginate.off'));
        dropdown.setValue('tiled').onChange((value) => {
          this.request.paginate = value !== 'single';
          this.refresh();
        });
      });

    new Setting(contentEl)
      .setName(t('modal.exportPng.transparent.name'))
      .setDesc(t('modal.exportPng.transparent.desc'))
      .addToggle((toggle) =>
        toggle.setValue(this.request.transparent).onChange((value) => {
          this.request.transparent = value;
          this.refresh();
        }),
      );

    this.planEl = contentEl.createDiv({ cls: 'nestboard-export-png__plan' });

    const buttons = new Setting(contentEl)
      .addButton((button) => button.setButtonText(t('modal.cancel')).onClick(() => this.close()))
      .addButton((button) =>
        button
          .setButtonText(t('modal.exportPng.export'))
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
    // 先关面板再回调：导出是异步的（逐块画、逐块写），留着面板会让人以为"卡住了"
    const request = { ...this.request };
    this.close();
    this.options.onExport(request);
  }
}
