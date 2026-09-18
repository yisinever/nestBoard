import { SuggestModal, type App, type TFile } from 'obsidian';

import { t } from '../../util/i18n';

/** 候选数量上限：挑一份文件而已，没必要把整库几千条全塞进列表 */
const MAX_SUGGESTIONS = 100;

/**
 * 库内文件选择器（T3.21：工具条的「图片」/「文件」按钮）。
 *
 * 与 `NotePickerModal` 同一套约定 —— 用 `SuggestModal`（键盘上下 / 回车 /
 * 模糊过滤都是白送的）、**取消也必须回调** `null`（否则调用方 `await`
 * 的 Promise 永远 pending，静默挂住）。
 *
 * ★ 与 `NotePickerModal` 分开而不是给它加一个"过滤参数"：
 *   那个选择器只列 Markdown（它服务的是"引用卡重连"，挑一张图片毫无意义），
 *   混在一起会让两边都要读一个跟自己无关的参数。这里则相反 ——
 *   它按扩展名过滤，`null` 表示"任意文件"。
 */
export class VaultFilePickerModal extends SuggestModal<TFile> {
  private chosen = false;

  /**
   * @param extensions 允许的扩展名（小写、不含点）；`null` = 不限制
   */
  constructor(
    app: App,
    private readonly extensions: readonly string[] | null,
    private readonly onDone: (path: string | null) => void,
  ) {
    super(app);
    this.setPlaceholder(t('modal.pickFile.placeholder'));
  }

  override getSuggestions(query: string): TFile[] {
    const needle = query.trim().toLowerCase();
    return this.app.vault
      .getFiles()
      .filter((file) => this.allowed(file))
      .filter((file) => needle.length === 0 || file.path.toLowerCase().includes(needle))
      .sort((a, b) => a.path.localeCompare(b.path))
      .slice(0, MAX_SUGGESTIONS);
  }

  override renderSuggestion(file: TFile, el: HTMLElement): void {
    el.setText(file.path);
  }

  override onChooseSuggestion(file: TFile): void {
    this.chosen = true;
    this.onDone(file.path);
  }

  override onClose(): void {
    super.onClose();
    if (!this.chosen) this.onDone(null);
  }

  /**
   * 扩展名过滤。
   *
   * ★ 用 `file.extension` 而不是从 `path` 里切：Obsidian 已经解析好了，
   *   而手切字符串在"文件名带点"（`v1.2 截图.png`）时容易切错。
   */
  private allowed(file: TFile): boolean {
    if (this.extensions === null) return true;
    return this.extensions.includes(file.extension.toLowerCase());
  }
}
