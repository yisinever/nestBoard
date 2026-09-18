/**
 * 导出 ZIP 对话框（T6.02 / `F9-07`）。
 *
 * 与 `ExportCanvasModal` 同一种：**一个选项都没有**。ZIP 包的形状是确定的 —— "这块板 +
 * 它引用的附件"，换任何一种"范围 / 倍率"都答不上"附件该不该跟着走"这个问题。
 * 所以面板存在的唯一理由，是把两件事在动手之前摆给用户看：
 *   1. 这次会打进去**几个**附件（用户得先知道规模）；
 *   2. 有哪几条引用**在库里已经找不到了**（打包时会被跳过）。
 *
 * ★ 第 2 条是**安静**的降级：不在这里说，用户会以为附件都齐了，等把包发给别人、
 *   对方解压打开才发现断链 —— 而那时谁也说不清是哪一步丢的。所以它用警示样式，
 *   不是一行灰色小字（对齐 `ExportCanvasModal` 对"损失"的处理）。
 *
 * ★ 面板不算计划：`attachments` / `missing` 都由视图用 `planZipExport` 算好后传进来，
 *   这里一行判定都不写。
 */

import { Modal, Setting } from 'obsidian';
import type { App } from 'obsidian';
import type { ZipPlan } from '../../export/toZip';
import { t } from '../../util/i18n';

export interface ExportZipModalOptions {
  /** 视图算好的打包计划（"打几个、缺几个"都在里面） */
  plan: ZipPlan;
  /** 点「导出」。★ 面板已经关了；真正打包与提示都由视图负责 */
  onConfirm(): void;
}

export class ExportZipModal extends Modal {
  constructor(
    app: App,
    private readonly options: ExportZipModalOptions,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.titleEl.setText(t('modal.exportZip.title'));
    const { contentEl } = this;
    const { plan } = this.options;

    contentEl.createEl('p', { text: t('modal.exportZip.desc') });

    // 先把规模说清楚：附件为 0 时说一句解释，而不是让用户对着一句"0 个"发愣
    contentEl.createDiv({
      cls: 'nestboard-export-zip__count',
      text:
        plan.attachments.length > 0
          ? t('modal.exportZip.count', { count: plan.attachments.length })
          : t('modal.exportZip.none'),
    });

    if (plan.missing.length > 0) {
      contentEl.createDiv({
        cls: 'nestboard-export-zip__missing-title',
        text: t('modal.exportZip.missingTitle', { count: plan.missing.length }),
      });
      const list = contentEl.createEl('ul', { cls: 'nestboard-export-zip__missing' });
      for (const path of plan.missing) list.createEl('li', { text: path });
    }

    contentEl.createDiv({
      cls: 'nestboard-export-zip__target',
      text: t('modal.exportZip.target'),
    });

    // 按钮顺序与另外几个导出对话框一致（取消在左、主操作在右并带 `cta`）
    new Setting(contentEl)
      .addButton((button) =>
        button.setButtonText(t('modal.exportZip.cancel')).onClick(() => this.close()),
      )
      .addButton((button) =>
        button
          .setButtonText(t('modal.exportZip.confirm'))
          .setCta()
          .onClick(() => this.submit()),
      );
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  private submit(): void {
    // 先关面板再回调：打包是异步的（逐个读附件），留着面板会让人以为"卡住了"（ExportPngModal 同法）
    this.close();
    this.options.onConfirm();
  }
}
