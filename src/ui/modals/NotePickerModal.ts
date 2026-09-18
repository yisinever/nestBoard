import { SuggestModal, type App, type TFile } from 'obsidian';

import { t } from '../../util/i18n';

/** 候选数量上限：白板里选个笔记而已，没必要把整库几千条全塞进列表 */
const MAX_SUGGESTIONS = 100;

/**
 * 笔记选择器（T1.45 断链重连用）。
 *
 * 用 `SuggestModal` 而不是自建列表：键盘上下 + 回车 + 模糊过滤都是白送的，
 * 而且外观与 Obsidian 的"快速切换"完全一致，用户不用学第二套操作。
 *
 * **取消也必须回调**（传 `null`）—— 否则 `VaultBridge.pickNote()` 返回的 Promise
 * 永远 pending，调用方的 `await` 就静默挂住了。
 */
export class NotePickerModal extends SuggestModal<TFile> {
  private chosen = false;

  constructor(
    app: App,
    private readonly current: string | null,
    private readonly onDone: (path: string | null) => void,
  ) {
    super(app);
    this.setPlaceholder(t('modal.pickNote.placeholder'));
  }

  override getSuggestions(query: string): TFile[] {
    const needle = query.trim().toLowerCase();
    return this.app.vault
      .getMarkdownFiles()
      .filter((file) => needle.length === 0 || file.path.toLowerCase().includes(needle))
      .sort((a, b) => a.path.localeCompare(b.path))
      .slice(0, MAX_SUGGESTIONS);
  }

  override renderSuggestion(file: TFile, el: HTMLElement): void {
    el.setText(file.path);
    if (file.path === this.current) el.addClass('nestboard-note-picker-current');
  }

  override onChooseSuggestion(file: TFile): void {
    this.chosen = true;
    this.onDone(file.path);
  }

  override onClose(): void {
    super.onClose();
    if (!this.chosen) this.onDone(null);
  }
}
