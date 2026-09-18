/**
 * 冲突解决对话框（T1.14，需求 `F11-11`）。
 *
 * 只在「磁盘被外部改动」且插件拒绝覆盖时弹出（见 `BoardRepository` / `MindRepository`）。
 * 三条路径对应 03 §3.4：
 *   - 用磁盘版本   → 放弃本地未保存改动
 *   - 保留我的修改 → 用户明确授权覆盖磁盘
 *   - 另存为副本   → 本地改动先落盘成副本，再把内存切回磁盘版本（**最安全**）
 *
 * 关闭（Esc / 点 X）视为「暂不处理」：内存内容原样保留，不写盘、不丢数据。
 *
 * ★ **白板与脑图共用这一个对话框**（P3-c-2）：两条线的冲突语义逐字相同
 *   （`03 §3.4` 是同一套规矩），用户不该看到两种样子的提示。所以这里
 *   刻意**不认识任何一种文档类型** —— 差别只在"谁来执行那三件事"（各自的仓储）。
 */

import { Modal } from 'obsidian';
import type { App } from 'obsidian';
import { t } from '../../util/i18n';

export type ConflictChoice = 'disk' | 'mine' | 'copy';

export interface ConflictModalOptions {
  path: string;
  /**
   * 磁盘那一份**读不出来**（坏了）。
   *
   * ★ 这是"三选一"里唯一有分支的地方：读不出来时"用磁盘版本"按不了（按了也没内容可切）。
   * ★ 两份**内容**本身不在这里显示 —— 那是"并排对比"那条路的事
   *   （`ui/conflictActions.ts` 的 `ConflictMergeModal`）。把差异搬进这个对话框，
   *   它就从一个"选择"变成一个"报告"，而用户此刻要的只是**尽快做个决定**。
   */
  diskUnreadable?: boolean;
  onChoose: (choice: ConflictChoice) => void;
  /** 用户未选择就关闭了对话框 */
  onDismissed?: () => void;
}

export class ConflictModal extends Modal {
  private chosen = false;

  constructor(
    app: App,
    private readonly options: ConflictModalOptions,
  ) {
    super(app);
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('nestboard-modal', 'nestboard-conflict-modal');
    this.setTitle(t('modal.conflict.title'));

    contentEl.createEl('p', {
      cls: 'nestboard-modal-desc',
      text: t('modal.conflict.desc', { path: this.options.path }),
    });

    if (this.options.diskUnreadable === true) {
      contentEl.createEl('p', {
        cls: 'nestboard-modal-warning',
        text: t('modal.conflict.diskUnreadable'),
      });
    }

    const actions = contentEl.createDiv({ cls: 'nestboard-conflict-actions' });
    this.addButton(
      actions,
      t('modal.conflict.useDisk'),
      'disk',
      false,
      this.options.diskUnreadable === true,
    );
    this.addButton(actions, t('modal.conflict.keepMine'), 'mine', true);
    this.addButton(actions, t('modal.conflict.saveAsCopy'), 'copy', false);
  }

  override onClose(): void {
    this.contentEl.empty();
    if (!this.chosen) this.options.onDismissed?.();
  }

  private addButton(
    parent: HTMLElement,
    label: string,
    choice: ConflictChoice,
    primary: boolean,
    disabled = false,
  ): void {
    const button = parent.createEl('button', {
      cls: primary ? 'nestboard-btn mod-cta' : 'nestboard-btn',
      text: label,
    });
    button.disabled = disabled;
    button.addEventListener('click', () => {
      this.chosen = true;
      this.close();
      this.options.onChoose(choice);
    });
  }
}
