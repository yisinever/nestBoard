import { Modal, Setting, type App } from 'obsidian';
import type { DiagnosticsRow } from '../../view/diagnostics';
import { t } from '../../util/i18n';

/**
 * 诊断信息面板（T2.17 / `02 §8.3`）。
 *
 * ★ 数字由调用方在**打开时**和点「刷新」时现采（`collect`），面板只负责排版：
 *   采集要数 DOM 节点、读磁盘 `stat`，常驻轮询会给被测对象本身加负担 ——
 *   那测出来的数字不可信，而且会真的拖慢用户的白板。
 *
 * ★ `collect` 是异步的（`vaultIO.stat` 要读盘），所以渲染分两步：先出骨架，
 *   数字回来再填。等待期间用户看到的是"正在读取"，不是一片空白。
 */
export class DiagnosticsModal extends Modal {
  private closed = false;

  constructor(
    app: App,
    private readonly collect: () => Promise<DiagnosticsRow[]>,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.modalEl.addClass('nestboard-diagnostics');
    this.render();
  }

  override onClose(): void {
    // ★ 置位在 `contentEl.empty()` 之前：`collect` 可能还在路上，
    //   回来后不能再往已经拆掉的 DOM 里写（那会抛"节点不存在"）
    this.closed = true;
    this.contentEl.empty();
    this.modalEl.removeClass('nestboard-diagnostics');
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: t('modal.diagnostics.title') });

    const list = contentEl.createDiv({ cls: 'nestboard-diagnostics__list' });
    list.createDiv({ cls: 'nestboard-diagnostics__loading', text: t('diagnostics.loading') });

    new Setting(contentEl).addButton((button) =>
      button.setButtonText(t('modal.diagnostics.refresh')).onClick(() => this.render()),
    );

    void this.fill(list);
  }

  private async fill(list: HTMLElement): Promise<void> {
    let rows: DiagnosticsRow[];
    try {
      rows = await this.collect();
    } catch (error) {
      if (this.closed) return;
      list.empty();
      list.createDiv({
        cls: 'nestboard-diagnostics__loading',
        text: t('diagnostics.failed', { error: String(error) }),
      });
      return;
    }

    // 面板可能在等待期间被关掉（或又点了一次刷新）：丢弃这次结果，别写进旧列表
    if (this.closed || !list.isConnected) return;

    list.empty();
    for (const row of rows) {
      const line = list.createDiv({ cls: 'nestboard-diagnostics__row' });
      if (row.warn) line.addClass('is-warn');
      line.createDiv({ cls: 'nestboard-diagnostics__label', text: row.label });
      line.createDiv({ cls: 'nestboard-diagnostics__value', text: row.value });
      // 提醒单独占一行：它回答的是"该往哪看"，跟数值本身不是一回事
      if (row.warn) line.createDiv({ cls: 'nestboard-diagnostics__warn', text: row.warn });
    }
  }
}
