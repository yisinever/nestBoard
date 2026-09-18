/**
 * 重命名 / 移动白板（T1.73 / `F7-05`）。
 *
 * 为什么插件自己要弹一个输入框，而不是让用户去文件浏览器改：
 * 白板常年在全屏标签页里开着，改名前先切到侧边栏找到那个 `.nboard` 是件很打断的事。
 * 但改名的**执行**仍然交给 `app.fileManager.renameFile`（见 `BoardView.applyRename`）——
 * 只有它会在用户偏好允许时同步全库的反向链接，否则别人笔记里的 `[[这块白板]]`
 * 会一夜之间变成断链。
 *
 * ★ 校验**当场拦住**三件事，因为放行的代价都比"按钮灰着"大得多：
 *   - 空名字 → 会得到一个叫 `.nboard` 的文件（连列表里都认不出来）；
 *   - 跟原名相同 → `renameFile` 会对着自己改名，某些存储后端下会抛错；
 *   - 撞上已存在的文件 → 轻则抛错，重则静默覆盖别人的笔记。
 *
 * ★ 输入框里只给**主名**、扩展名放在后面拼回去：改名的人想改的是名字，
 *   不该有机会手滑把 `.nboard` 删掉，让文件变成"不被插件认识的普通文件"。
 */

import { Modal, Setting } from 'obsidian';
import type { App, TFile } from 'obsidian';
import { joinPath, sanitizeFileName, splitName } from '../../util/fileName';
import { t } from '../../util/i18n';

export class RenameBoardModal extends Modal {
  private draft: string;
  private errorEl: HTMLElement | null = null;
  private confirmButton: HTMLButtonElement | null = null;

  constructor(
    app: App,
    private readonly file: TFile,
    private readonly onSubmit: (newPath: string) => void,
  ) {
    super(app);
    this.draft = splitName(file.path).base;
  }

  override onOpen(): void {
    this.titleEl.setText(t('modal.renameBoard.title'));
    const { contentEl } = this;

    this.errorEl = contentEl.createDiv({ cls: 'nestboard-modal__error' });

    new Setting(contentEl).addText((component) => {
      component.setValue(this.draft).onChange((value) => {
        this.draft = value;
        this.refresh();
      });
      // 回车提交：在文本框里按回车是最自然的动作，不该逼用户去够按钮
      component.inputEl.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        this.submit();
      });
      // 打开即全选：改名的人多半要整个换掉，而不是在中间插字
      window.setTimeout(() => component.inputEl.select());
    });

    const confirmSetting = new Setting(contentEl)
      .addButton((button) => button.setButtonText(t('modal.cancel')).onClick(() => this.close()))
      .addButton((button) =>
        button
          .setButtonText(t('modal.ok'))
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

  /** 目标路径：同目录 + 净化后的主名 + 原扩展名 */
  private targetPath(): string {
    const { dir, ext } = splitName(this.file.path);
    return joinPath(dir, `${sanitizeFileName(this.draft, '')}${ext}`);
  }

  /**
   * 能不能提交。
   *
   * @returns `message` 为空表示"没毛病，只是还不必提示"（名字还没改）
   */
  private verdict(): { ok: boolean; message: string } {
    if (sanitizeFileName(this.draft, '').length === 0) {
      return { ok: false, message: t('modal.renameBoard.empty') };
    }
    if (this.targetPath() === this.file.path) return { ok: false, message: '' };
    if (this.app.vault.getAbstractFileByPath(this.targetPath())) {
      return { ok: false, message: t('modal.renameBoard.exists') };
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
    // 先 `close()` 再回调：改名的落盘是异步的，留着对话框会让用户以为"卡住了"，
    // 而且他很可能立刻再改一次名（那时两个对话框会互相打架）
    const target = this.targetPath();
    this.close();
    this.onSubmit(target);
  }
}
