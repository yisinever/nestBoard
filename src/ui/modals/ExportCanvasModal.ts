/**
 * 导出为 Canvas 对话框（T4.13 / `03 §7.4`）。
 *
 * 这里**一个选项都没有** —— 与 ExportPngModal 恰好相反，所以它存在的唯一理由是：
 * 在动手之前把「这次导出会损失什么」摆给用户看。
 *
 * 为什么非要说：`.canvas` 是**中转格式**，四种卡片（待办 / 色板 / 白板卡 / 手绘）
 * 没有对应节点、悬空连线根本表达不了。这些损失都是**静默**的 —— 导出那一刻一切正常，
 * 用户要到某个下午打开画布、发现少了一半内容时才会察觉，而那时源头已经查不清了。
 * 所以对话框把"损失"当成**主要内容**（不是一句灰色小字），并允许用户就此取消。
 *
 * ★ 面板不算损失：它只负责把视图算好的 `plan` 摆出来（`describeCanvasLosses` 在
 *   `export/jsonCanvas.ts`，那是可以在 node 下单测的部分）。这里一行判定都不写。
 */

import { Modal, Setting } from 'obsidian';
import type { App } from 'obsidian';
import type { CanvasExportPlan } from '../../export/jsonCanvas';
import { describeCanvasLosses } from '../../export/jsonCanvas';
import { t } from '../../util/i18n';

export interface ExportCanvasModalOptions {
  /** 视图算好的导出计划（损失清单就在里面） */
  plan: CanvasExportPlan;
  /** 点「导出」。★ 面板已经关了；真正写盘与提示都由视图负责任 */
  onConfirm(): void;
}

export class ExportCanvasModal extends Modal {
  constructor(
    app: App,
    private readonly options: ExportCanvasModalOptions,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.titleEl.setText(t('modal.exportCanvas.title'));
    const { contentEl } = this;
    const { plan } = this.options;

    contentEl.createEl('p', { text: t('modal.exportCanvas.desc') });

    // 先把"会导出什么"说清楚，再说损失：用户得先知道这次的规模，才判断得了
    // "少几张"是不是要紧
    contentEl.createDiv({
      cls: 'nestboard-export-canvas__stats',
      text: t('modal.exportCanvas.stats', {
        cards: plan.nodes,
        columns: plan.groups,
        edges: plan.edges,
      }),
    });

    const losses = describeCanvasLosses(plan);
    if (losses.length === 0) {
      // 无损是**好消息**，值得单独说一句：绝大多数板子其实只有便签 / 引用 / 图片 /
      // 链接这四种卡片，用户完全不必因为"导出会损失"而犹豫
      contentEl.createDiv({
        cls: 'nestboard-export-canvas__lossless',
        text: t('modal.exportCanvas.lossless'),
      });
    } else {
      contentEl.createDiv({
        cls: 'nestboard-export-canvas__lossy-title',
        text: t('modal.exportCanvas.lossyTitle'),
      });
      const list = contentEl.createEl('ul', { cls: 'nestboard-export-canvas__losses' });
      for (const line of losses) list.createEl('li', { text: line });
    }

    contentEl.createDiv({
      cls: 'nestboard-export-canvas__target',
      text: t('modal.exportCanvas.target'),
    });

    // ★ 按钮顺序与文案与其它导出对话框一致（取消在左、主操作在右并带 `cta`）：
    //   同一套肌肉记忆在三个导出对话框之间不该有差别
    new Setting(contentEl)
      .addButton((button) =>
        button.setButtonText(t('modal.exportCanvas.cancel')).onClick(() => this.close()),
      )
      .addButton((button) =>
        button
          .setButtonText(t('modal.exportCanvas.confirm'))
          .setCta()
          .onClick(() => this.submit()),
      );
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  private submit(): void {
    // 先关面板再回调：写盘是异步的，留着面板会让人以为"卡住了"（ExportPngModal 同法）
    this.close();
    this.options.onConfirm();
  }
}
