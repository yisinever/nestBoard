/**
 * 「整理未使用附件」的结果清单（T4.05 / `03 §4`）。
 *
 * ★ **刻意没有"删除"按钮**，这层 UI 里连一个删除动作都不接。
 *   `03 §4` 写死了两句话：「删除附件 **绝不自动删除**。仅提供『未使用附件』清单
 *   让用户自行决定」。而这里的"未使用"只代表"**插件能看见的引用里**没有它" ——
 *   笔记正文里的 markdown 图片、Dataview 拼出来的路径、别的插件写的清单，我们都看不见。
 *   给一个"删掉这些"的按钮，等于替用户的判断力背书，而证据是不完整的。
 * ★ 每一项只能「打开」：看完自己决定去文件管理器里删，还是留着。
 *
 * 清单本身由 `io/attachmentAudit.ts` 算好（纯函数、有单测），这里只负责显示。
 */

import { Modal, type App } from 'obsidian';
import type { AttachmentAuditResult } from '../../io/attachmentAudit';
import { t } from '../../util/i18n';

export interface AttachmentAuditModalOptions {
  /** 本次扫描覆盖的附件目录（`''` = 整个库） */
  folder: string;
  result: AttachmentAuditResult;
  /** 打开某个文件（交给 Obsidian 自己决定用什么视图） */
  openFile: (path: string) => void;
}

export class AttachmentAuditModal extends Modal {
  constructor(
    app: App,
    private readonly options: AttachmentAuditModalOptions,
  ) {
    super(app);
  }

  override onOpen(): void {
    const { folder, result } = this.options;
    this.contentEl.addClass('nestboard-modal', 'nestboard-attachment-audit-modal');
    this.setTitle(t('modal.attachmentAudit.title'));

    this.contentEl.createEl('p', {
      cls: 'nestboard-modal-desc',
      text: t('modal.attachmentAudit.desc'),
    });
    this.contentEl.createEl('p', {
      cls: 'nestboard-modal-desc',
      text: t('modal.attachmentAudit.scope', {
        folder: folder.length === 0 ? t('modal.attachmentAudit.scopeRoot') : folder,
      }),
    });

    this.contentEl.createDiv({
      cls: 'nestboard-attachment-audit-summary',
      text: t('modal.attachmentAudit.summary', {
        total: result.usedByBoard.length + result.usedElsewhere.length + result.unused.length,
        board: result.usedByBoard.length,
        elsewhere: result.usedElsewhere.length,
        unused: result.unused.length,
      }),
    });

    if (result.unused.length === 0) {
      this.contentEl.createDiv({
        cls: 'nestboard-attachment-audit-empty',
        text: t('modal.attachmentAudit.none'),
      });
    } else {
      const list = this.contentEl.createDiv({ cls: 'nestboard-attachment-audit-list' });
      for (const path of result.unused) {
        const row = list.createDiv({ cls: 'nestboard-attachment-audit-row' });
        row.createSpan({ cls: 'nestboard-attachment-audit-path', text: path });
        const open = row.createEl('button', {
          cls: 'nestboard-attachment-audit-open',
          text: t('modal.attachmentAudit.open'),
        });
        open.addEventListener('click', () => this.options.openFile(path));
      }
    }

    // 「本板不再用、别处还在用」只报个数：它**不需要**用户做任何事，
    // 逐个列出来只会把"要找的那几行"往下推。这个数在这里的作用是让人安心 ——
    // "刚从板上删掉的那几张图没被误报成垃圾，插件知道它们还在别处活着"
    if (result.usedElsewhere.length > 0) {
      this.contentEl.createDiv({
        cls: 'nestboard-attachment-audit-note',
        text: t('modal.attachmentAudit.usedElsewhere', { count: result.usedElsewhere.length }),
      });
    }

    const footer = this.contentEl.createDiv({ cls: 'nestboard-attachment-audit-footer' });
    const close = footer.createEl('button', {
      cls: 'mod-cta',
      text: t('modal.attachmentAudit.close'),
    });
    close.addEventListener('click', () => this.close());
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
