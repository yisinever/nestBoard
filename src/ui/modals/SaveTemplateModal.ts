/**
 * 「另存为模板」（`T4.14` / `F7-06`）。
 *
 * 只问一个名字 —— 模板的其余部分（卡片、分栏、连线、底色）都是当前白板的复制，
 * 没有任何需要用户现填的字段。于是这个对话框跟「重命名白板」几乎是同一个形状，
 * 三处刻意的差别：
 *
 * * **不检查重名**：重名是**顺延**（`xxx 2.nboard`），这是所有"导出 / 另存"的既定规则。
 *   在这里拦一句"已存在"等于逼用户先去删一个文件，而他要的显然是"再存一份"。
 * * **不碰当前白板**：复制出去之后原板一个字节都不改（按钮文案说的是"保存"，
 *   做的事其实是"另存"）—— 所以这里没有"确认后无法撤销"那种话。
 * * **落盘目录写在明处**：用户改了模板目录之后，最想知道的就是"它到底存哪去了"。
 */

import { Modal, Setting } from 'obsidian';
import type { App } from 'obsidian';

import { sanitizeFileName } from '../../util/fileName';
import { t } from '../../util/i18n';

export interface SaveTemplateModalOptions {
  /** 预填的名字（当前白板标题） */
  defaultName: string;
  /** 会存到哪个目录 —— 提示文案里要用 */
  folder: string;
  onSubmit: (name: string) => void;
}

export class SaveTemplateModal extends Modal {
  private draft: string;
  private errorEl: HTMLElement | null = null;
  private confirmButton: HTMLButtonElement | null = null;

  constructor(
    app: App,
    private readonly options: SaveTemplateModalOptions,
  ) {
    super(app);
    this.draft = options.defaultName;
  }

  override onOpen(): void {
    this.titleEl.setText(t('modal.saveTemplate.title'));
    const { contentEl } = this;

    this.errorEl = contentEl.createDiv({ cls: 'nestboard-modal__error' });

    new Setting(contentEl)
      .setName(t('modal.saveTemplate.name.name'))
      .setDesc(t('modal.saveTemplate.name.desc'))
      .addText((component) => {
        component
          .setPlaceholder(t('modal.saveTemplate.name.placeholder'))
          .setValue(this.draft)
          .onChange((value) => {
            this.draft = value;
            this.refresh();
          });
        // 回车提交：在文本框里按回车是最自然的动作，不该逼用户去够按钮
        component.inputEl.addEventListener('keydown', (event) => {
          if (event.key !== 'Enter') return;
          event.preventDefault();
          this.submit();
        });
        // 打开即全选：多半是要整个换掉（"未命名白板"这种默认名没有保留价值）
        window.setTimeout(() => component.inputEl.select());
      });

    contentEl.createDiv({
      cls: 'nestboard-template__note',
      text: t('modal.saveTemplate.note', { folder: this.options.folder }),
    });

    const confirmSetting = new Setting(contentEl)
      .addButton((button) => button.setButtonText(t('modal.cancel')).onClick(() => this.close()))
      .addButton((button) =>
        button
          .setButtonText(t('modal.saveTemplate.submit'))
          .setCta()
          .onClick(() => this.submit()),
      );

    // 最后一个按钮 = 确定（`addButton` 依次追加，取末位最稳）
    const buttons = confirmSetting.controlEl.querySelectorAll('button');
    this.confirmButton = buttons[buttons.length - 1] ?? null;

    this.refresh();
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  /**
   * 能不能提交。
   *
   * ★ 用 `sanitizeFileName(name, '')` 判空而不是 `name.trim()`：一个全是非法字符的名字
   *   （`///`）会被净化成空串，落盘时就变成 `.nboard` 这种连列表都认不出来的文件。
   */
  private verdict(): { ok: boolean; message: string } {
    if (sanitizeFileName(this.draft, '').length === 0) {
      return { ok: false, message: t('modal.saveTemplate.empty') };
    }
    return { ok: true, message: '' };
  }

  private refresh(): void {
    const { ok, message } = this.verdict();
    if (this.errorEl) {
      this.errorEl.setText(message);
      this.errorEl.toggleClass('is-visible', message.length > 0);
    }
    if (this.confirmButton) this.confirmButton.disabled = !ok;
  }

  private submit(): void {
    if (!this.verdict().ok) return;
    const name = this.draft.trim();
    // 先 `close()` 再回调：落盘是异步的，留着对话框会让用户以为"卡住了"
    this.close();
    this.options.onSubmit(name);
  }
}
