/**
 * 通用「破坏性操作二次确认」对话框（T4.04 / 03 §3.6）。
 *
 * ★ 为什么不用 `window.confirm`：
 *   1. 它**阻塞主线程**——确认框一出来整个 Obsidian 假死，连"取消"都要等；
 *   2. 它两个按钮长得一模一样，"删除"和"取消"挨着排，正好是误点的源头；
 *   3. 移动端会被系统当成可疑弹窗拦掉。
 *
 * ★ `onConfirm` 允许 async 且**期间锁住按钮**：删除是"点一下 → 读文本 → 打快照 →
 *   进回收站"好几步，慢的时候用户会以为没点上而连点，那就删了两份。
 *   失败时**对话框不关**并把错误留在原地，用户可以看清原因再决定重试还是放弃。
 */

import type { App } from 'obsidian';
import { Modal } from 'obsidian';
import { describeError } from '../../util/errors';
import { t } from '../../util/i18n';

export interface ConfirmModalOptions {
  title: string;
  /** 正文。说清"会发生什么、能不能撤回"，别只写"确定吗？" */
  body: string;
  confirmLabel: string;
  cancelLabel?: string;
  /** 危险动作：确认键用警示色，且初始焦点落在"取消"上（回车不会误删） */
  danger?: boolean;
  onConfirm: () => void | Promise<void>;
  /** 用户取消（点取消 / 按 Esc / 点遮罩）时调用；确认成功后**不再**调用 */
  onCancel?: () => void;
}

export class ConfirmModal extends Modal {
  private readonly options: ConfirmModalOptions;
  private confirmButton: HTMLButtonElement | null = null;
  private errorEl: HTMLElement | null = null;
  /** 已经走完确认流程（成功 or 用户取消）——用来保证 `onCancel` 至多触发一次 */
  private settled = false;
  private busy = false;

  constructor(app: App, options: ConfirmModalOptions) {
    super(app);
    this.options = options;
  }

  override onOpen(): void {
    this.contentEl.addClass('nestboard-modal', 'nestboard-confirm-modal');
    this.setTitle(this.options.title);
    this.contentEl.createEl('p', { cls: 'nestboard-modal-desc', text: this.options.body });
    this.errorEl = this.contentEl.createDiv({ cls: 'nestboard-modal-warning is-hidden' });

    const actions = this.contentEl.createDiv({ cls: 'nestboard-confirm-actions' });
    const cancel = actions.createEl('button', {
      cls: 'nestboard-btn',
      text: this.options.cancelLabel ?? t('modal.confirm.cancel'),
    });
    cancel.addEventListener('click', () => this.close());

    const confirm = actions.createEl('button', {
      cls: this.options.danger === true ? 'nestboard-btn mod-warning' : 'nestboard-btn mod-cta',
      text: this.options.confirmLabel,
    });
    this.confirmButton = confirm;
    confirm.addEventListener('click', () => void this.submit());

    // 危险动作把初始焦点放在"取消"：回车 = 不删。非危险动作放在确认上，回车 = 继续
    const initial = this.options.danger === true ? cancel : confirm;
    window.setTimeout(() => initial.focus(), 0);
  }

  override onClose(): void {
    this.contentEl.empty();
    this.confirmButton = null;
    this.errorEl = null;
    if (!this.settled) {
      this.settled = true;
      this.options.onCancel?.();
    }
  }

  private async submit(): Promise<void> {
    if (this.busy || this.settled) return;
    this.busy = true;
    this.setBusy(true);
    this.hideError();

    try {
      await this.options.onConfirm();
      this.settled = true;
      this.close();
    } catch (error) {
      // 留在原地显示原因：关闭对话框等于把"为什么没删成功"一起吞掉
      this.showError(describeError(error));
      this.busy = false;
      this.setBusy(false);
    }
  }

  private setBusy(busy: boolean): void {
    const button = this.confirmButton;
    if (!button) return;
    if (busy) {
      button.setAttribute('disabled', 'disabled');
      button.addClass('is-busy');
    } else {
      button.removeAttribute('disabled');
      button.removeClass('is-busy');
    }
  }

  private showError(message: string): void {
    if (!this.errorEl) return;
    this.errorEl.setText(message);
    this.errorEl.removeClass('is-hidden');
  }

  private hideError(): void {
    if (!this.errorEl) return;
    this.errorEl.setText('');
    this.errorEl.addClass('is-hidden');
  }
}
