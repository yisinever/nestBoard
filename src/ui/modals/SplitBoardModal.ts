/**
 * 拆分白板向导（T2.16 / `02 §8.3`：> 5000 卡的「拆分白板」）。
 *
 * ★ 这是**唯一会新建文件**的破坏性操作（`导出 PNG` 只写图，不改板），所以：
 *   - 面板里逐组列出"会变成哪块板、带走多少张卡"，让用户点确定之前就知道会发生什么；
 *   - 明确写出"新建的文件无法用撤销撤回"（拆板要建文件，白板历史管不到文件系统）；
 *   - 至少留 2 组才允许确认 —— 只拆 1 组叫"搬家"，不是拆分。
 *
 * ★ 本面板**不碰磁盘**：只负责"选哪几组"，建文件与改板的顺序由
 *   `BoardView.runSplit` 负责（先全部写盘成功，再回头改原板）。
 */

import { Modal, Setting } from 'obsidian';
import type { App } from 'obsidian';
import type { SplitChild } from '../../model/split';
import { t } from '../../util/i18n';

export interface SplitBoardModalOptions {
  /** 可拆的组（`ready` 已由调用方确认，因此至少 2 组） */
  children: readonly SplitChild[];
  /**
   * 实时摘要：返回要显示的文案 + 是否允许确认。
   *
   * ★ 交给调用方而不是在这里拼文案：摘要要算"迁走多少张卡 / 原板留下多少张"，
   *   那是板数据的事，面板只该管交互。
   */
  summarize: (selected: readonly number[]) => { text: string; ready: boolean };
  /** 用户确认，参数是选中的下标（升序，与 `children` 顺序一致） */
  onConfirm: (selected: readonly number[]) => void;
}

export class SplitBoardModal extends Modal {
  /** 选中的组下标 */
  private readonly selected = new Set<number>();
  private summaryEl: HTMLElement | null = null;
  private confirmButton: HTMLButtonElement | null = null;

  constructor(
    app: App,
    private readonly options: SplitBoardModalOptions,
  ) {
    super(app);
    // 默认全选：走进这个面板的人十有八九就是要拆全部，逐个点亮纯属白费力气
    this.options.children.forEach((_, index) => {
      this.selected.add(index);
    });
  }

  override onOpen(): void {
    this.modalEl.addClass('nestboard-modal');
    this.titleEl.setText(t('modal.splitBoard.title'));

    const { contentEl } = this;
    contentEl.createEl('p', { cls: 'nestboard-modal-desc', text: t('modal.splitBoard.desc') });

    const list = contentEl.createDiv({ cls: 'nestboard-split-board__list' });
    this.options.children.forEach((child, index) => {
      new Setting(list)
        .setName(child.title)
        .setDesc(t('column.count', { count: child.cardIds.length }))
        .addToggle((toggle) =>
          toggle.setValue(true).onChange((value) => {
            if (value) this.selected.add(index);
            else this.selected.delete(index);
            this.refresh();
          }),
        );
    });

    contentEl.createEl('p', {
      cls: 'nestboard-split-board__warning',
      text: t('modal.splitBoard.warning'),
    });
    this.summaryEl = contentEl.createDiv({ cls: 'nestboard-split-board__summary' });

    new Setting(contentEl)
      .addButton((button) => button.setButtonText(t('modal.cancel')).onClick(() => this.close()))
      .addButton((button) =>
        button
          .setButtonText(t('modal.splitBoard.confirm'))
          .setCta()
          .onClick(() => this.submit()),
      );

    const buttons = contentEl.querySelectorAll('button');
    this.confirmButton = buttons[buttons.length - 1] ?? null;

    this.refresh();
  }

  override onClose(): void {
    this.summaryEl = null;
    this.confirmButton = null;
    this.selected.clear();
    this.contentEl.empty();
  }

  private refresh(): void {
    const selected = this.selectedList();
    const summary = this.options.summarize(selected);

    this.summaryEl?.setText(summary.text);
    this.summaryEl?.toggleClass('is-blocked', !summary.ready);
    if (this.confirmButton) this.confirmButton.disabled = !summary.ready;
  }

  private submit(): void {
    const selected = this.selectedList();
    if (!this.options.summarize(selected).ready) return;
    // 先关面板再回调用：拆板要建文件、写盘，面板留在屏幕上会让人以为"卡住了"
    this.close();
    this.options.onConfirm(selected);
  }

  /** 选中的下标（升序）。顺序稳定 → 原板上白板卡的插入顺序也稳定 */
  private selectedList(): number[] {
    return this.options.children
      .map((_, index) => index)
      .filter((index) => this.selected.has(index));
  }
}
