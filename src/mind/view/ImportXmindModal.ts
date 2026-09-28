/**
 * 「导入 .xmind」的**文件选择**（用户 2026-09-28）。
 *
 * ★ 用 `SuggestModal` 列出库里的 `.xmind`：Obsidian 没有官方"打开文件"对话框，
 *   而把路径当字符串让用户手打是反用户的；库内选择与我们其它面板同一条路。
 * ★ 取消（`Esc` / 点外面）⇒ `null`：调用方据此什么都不做。
 */

import { SuggestModal, TFile, type App } from 'obsidian';

export class ImportXmindModal extends SuggestModal<TFile> {
  /** 一次性回调（`onClose` 里兑现 `null`，避免和 `onChooseSuggestion` 重复触发） */
  private deliver: (file: TFile | null) => void;

  constructor(app: App, onPick: (file: TFile | null) => void) {
    super(app);
    this.deliver = onPick;
    this.setPlaceholder('.xmind');
  }

  override getSuggestions(query: string): TFile[] {
    const needle = query.trim().toLowerCase();
    return this.app.vault
      .getFiles()
      .filter((file) => file.extension.toLowerCase() === 'xmind')
      .filter((file) => needle.length === 0 || file.path.toLowerCase().includes(needle))
      .slice(0, 50);
  }

  override renderSuggestion(file: TFile, el: HTMLElement): void {
    el.setText(file.path);
  }

  override onChooseSuggestion(file: TFile): void {
    this.deliver(file);
    this.deliver = () => undefined;
  }

  override onClose(): void {
    super.onClose();
    // `onChooseSuggestion` 之后也会走到这里 ⇒ 用一次性回调保证只兑现一次
    const once = this.deliver;
    this.deliver = () => undefined;
    window.setTimeout(() => once(null), 0);
  }
}
