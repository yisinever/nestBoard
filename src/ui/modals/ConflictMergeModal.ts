/**
 * 同步冲突副本的**并排只读对比**（T4.03 / 03 §3.4）。
 *
 * ★ 刻意只读、刻意叫"对比"而不是"合并"：自动合并两份分叉的白板在模型上做不到
 *   无损 —— 同 id 的卡片可能是两端各自改过的（各自的 `x/y/w/h`、各自的正文），
 *   任何自动取舍都会**静默丢一边的改动**。而"冲突"的代价用户还能承受，
 *   "合并后少了一张卡又没人知道"不能。所以这里只把差异摊开给人看，
 *   处置动作（打开副本 / 删掉副本）都交给用户点。
 *
 * 布局是"一张表两个列"而不是两个独立画布：两列必须**逐行对齐**才能比，
 * 各自滚动就失去意义了。
 */

import type { App } from 'obsidian';
import { Modal } from 'obsidian';
import { diffBoards, digestBoard, type BoardDigest, type CardDiffRow } from '../../io/conflict';
import type { BoardFile } from '../../model/schema';
import { describeError } from '../../util/errors';
import { t } from '../../util/i18n';

export interface ConflictMergeModalOptions {
  /** 左：原白板路径（可能为空串 = 推不出原板） */
  leftPath: string;
  /** 右：候选冲突副本路径（至少一个） */
  copies: readonly string[];
  loadBoard: (path: string) => Promise<BoardFile | null>;
  openBoard: (path: string) => void;
  /** 删除副本（内部已含二次确认 + 快照 + 回收站）；返回是否真的删了 */
  removeCopy: (path: string) => Promise<boolean>;
}

/** 差异行最多渲染多少条：500 行已经能滚很久，再多只是让对话框卡 */
const MAX_ROWS = 500;

export class ConflictMergeModal extends Modal {
  private readonly options: ConflictMergeModalOptions;
  private readonly copies: string[];
  private selected: string;

  private controlsEl!: HTMLElement;
  private summaryEl!: HTMLElement;
  private bodyEl!: HTMLElement;
  private footerEl!: HTMLElement;

  private onlyDiff = true;
  /** 已加载好的两侧模型（切换副本时重算右侧） */
  private left: BoardFile | null = null;
  private right: BoardFile | null = null;
  private loadToken = 0;
  /** `Modal` 没有公开的 `closed` 字段，自己记一个（异步回来时要判"还在不在"） */
  private isClosed = false;

  constructor(app: App, options: ConflictMergeModalOptions) {
    super(app);
    this.options = options;
    this.copies = [...options.copies];
    this.selected = this.copies[0] ?? '';
  }

  override onOpen(): void {
    this.contentEl.addClass('nestboard-modal', 'nestboard-sync-conflict-modal');
    this.setTitle(t('modal.syncConflict.title', { board: baseName(this.options.leftPath) || '—' }));
    this.contentEl.createEl('p', {
      cls: 'nestboard-modal-desc',
      text: t('modal.syncConflict.desc'),
    });

    this.controlsEl = this.contentEl.createDiv({ cls: 'nestboard-sync-conflict-controls' });
    this.summaryEl = this.contentEl.createDiv({ cls: 'nestboard-sync-conflict-summary' });
    this.bodyEl = this.contentEl.createDiv({ cls: 'nestboard-sync-conflict-body' });
    this.footerEl = this.contentEl.createDiv({ cls: 'nestboard-sync-conflict-footer' });

    this.renderControls();
    void this.refresh();
  }

  override onClose(): void {
    // 让还在飞的 `loadBoard` 回来时认不出自己已经过期（否则会往空 contentEl 里写）
    this.loadToken++;
    this.isClosed = true;
    this.contentEl.empty();
  }

  private renderControls(): void {
    this.controlsEl.empty();

    if (this.copies.length > 1) {
      const label = this.controlsEl.createEl('label', { cls: 'nestboard-sync-conflict-select' });
      label.createSpan({ text: `${t('modal.syncConflict.copySelect')} ` });
      const select = label.createEl('select', { cls: 'dropdown' });
      for (const path of this.copies) {
        const option = select.createEl('option', { text: baseName(path), value: path });
        option.selected = path === this.selected;
      }
      select.addEventListener('change', () => {
        this.selected = select.value;
        void this.refresh();
      });
    }

    const toggle = this.controlsEl.createEl('label', { cls: 'nestboard-sync-conflict-toggle' });
    const checkbox = toggle.createEl('input', { type: 'checkbox' });
    checkbox.checked = this.onlyDiff;
    toggle.createSpan({ text: t('modal.syncConflict.onlyDiff') });
    checkbox.addEventListener('change', () => {
      this.onlyDiff = checkbox.checked;
      this.renderBody();
    });
  }

  /** 重新读两份文件并渲染 */
  private async refresh(): Promise<void> {
    const token = ++this.loadToken;
    this.bodyEl.empty();
    this.summaryEl.setText('');
    this.footerEl.empty();
    this.bodyEl.createDiv({ cls: 'nestboard-modal-loading', text: t('diagnostics.loading') });

    const leftPath = this.options.leftPath;
    const rightPath = this.selected;

    const [left, right] = await Promise.all([
      leftPath.length > 0 ? this.safeLoad(leftPath) : Promise.resolve(null),
      rightPath.length > 0 ? this.safeLoad(rightPath) : Promise.resolve(null),
    ]);
    if (token !== this.loadToken) return;

    this.left = left;
    this.right = right;

    this.renderSummary(left, right);
    this.renderBody();
    this.renderFooter();
  }

  private async safeLoad(path: string): Promise<BoardFile | null> {
    try {
      return await this.options.loadBoard(path);
    } catch (error) {
      console.warn('[nestboard] 读取冲突副本失败', describeError(error));
      return null;
    }
  }

  private renderSummary(left: BoardFile | null, right: BoardFile | null): void {
    this.summaryEl.empty();

    if (!left && !right) {
      this.summaryEl.createDiv({
        cls: 'nestboard-sync-conflict-warning',
        text: t('modal.syncConflict.leftMissing'),
      });
      return;
    }

    const diff = left && right ? diffBoards(left, right) : null;
    const panel = (side: 'left' | 'right', digest: BoardDigest | null, missing: string): void => {
      const box = this.summaryEl.createDiv({ cls: `nestboard-sync-conflict-panel is-${side}` });
      box.createDiv({
        cls: 'nestboard-sync-conflict-panel-title',
        text: t(side === 'left' ? 'modal.syncConflict.left' : 'modal.syncConflict.right'),
      });
      const path = side === 'left' ? this.options.leftPath : this.selected;
      box.createDiv({ cls: 'nestboard-sync-conflict-panel-path', text: baseName(path) || '—' });

      if (!digest) {
        box.createDiv({ cls: 'nestboard-sync-conflict-warning', text: missing });
        return;
      }
      box.createDiv({
        cls: 'nestboard-sync-conflict-panel-meta',
        text: t('modal.syncConflict.summary', {
          cards: digest.cards,
          columns: digest.columns,
          edges: digest.edges,
        }),
      });
      box.createDiv({
        cls: 'nestboard-sync-conflict-panel-meta',
        text: t('modal.syncConflict.revision', { revision: digest.revision }),
      });
    };

    panel(
      'left',
      left ? (diff?.left ?? digestBoard(left)) : null,
      t('modal.syncConflict.leftMissing'),
    );
    panel(
      'right',
      right ? (diff?.right ?? digestBoard(right)) : null,
      t('modal.syncConflict.rightMissing'),
    );

    if (diff) {
      this.summaryEl.createDiv({
        cls: 'nestboard-sync-conflict-counts',
        text: t('modal.syncConflict.counts', {
          added: diff.counts['right-only'],
          removed: diff.counts['left-only'],
          changed: diff.counts.changed,
        }),
      });
    }
  }

  private renderBody(): void {
    this.bodyEl.empty();

    if (!this.left || !this.right) {
      // 有一侧读不出来 —— 没有 id 可对齐，只能把摘要留在上面，别假装能比
      return;
    }

    const diff = diffBoards(this.left, this.right);
    const rows = this.onlyDiff ? diff.rows.filter((row) => row.status !== 'same') : diff.rows;

    if (diff.rows.length === 0) {
      this.bodyEl.createDiv({ cls: 'nestboard-modal-desc', text: t('modal.syncConflict.empty') });
      return;
    }
    if (rows.length === 0) {
      this.bodyEl.createDiv({ cls: 'nestboard-modal-desc', text: t('modal.syncConflict.noDiff') });
      return;
    }

    const list = this.bodyEl.createDiv({ cls: 'nestboard-sync-conflict-list' });
    for (const row of rows.slice(0, MAX_ROWS)) list.appendChild(this.renderRow(row));

    if (rows.length > MAX_ROWS) {
      list.createDiv({
        cls: 'nestboard-sync-conflict-more',
        text: t('modal.syncConflict.more', { count: rows.length - MAX_ROWS }),
      });
    }
  }

  private renderRow(row: CardDiffRow): HTMLElement {
    const el = createDiv();
    el.className = `nestboard-sync-conflict-row is-${row.status}`;
    el.createDiv({
      cls: 'nestboard-sync-conflict-cell is-left',
      text: cellText(row.left, row.type),
    });
    el.createDiv({ cls: 'nestboard-sync-conflict-badge', text: statusText(row.status) });
    el.createDiv({
      cls: 'nestboard-sync-conflict-cell is-right',
      text: cellText(row.right, row.type),
    });
    return el;
  }

  private renderFooter(): void {
    this.footerEl.empty();

    const remove = this.footerEl.createEl('button', {
      cls: 'nestboard-btn mod-warning',
      text: t('modal.syncConflict.remove'),
    });
    remove.addEventListener('click', () => void this.removeSelected());

    const open = this.footerEl.createEl('button', {
      cls: 'nestboard-btn',
      text: t('modal.syncConflict.open'),
    });
    open.addEventListener('click', () => {
      if (this.selected.length > 0) this.options.openBoard(this.selected);
    });
  }

  private async removeSelected(): Promise<void> {
    if (this.selected.length === 0) return;
    const removed = await this.removeCopy(this.selected);
    if (!removed || this.isClosed) return;

    // 这一份已经进回收站了：从候选里摘掉，然后切到下一份继续比 ——
    // 一次冲突往往不止一份副本，逼用户关掉再重开是最烦的那种交互
    const index = this.copies.indexOf(this.selected);
    if (index >= 0) this.copies.splice(index, 1);

    if (this.copies.length === 0) {
      this.close();
      return;
    }
    this.selected = this.copies[Math.min(index, this.copies.length - 1)] ?? this.copies[0]!;
    this.renderControls();
    void this.refresh();
  }

  private async removeCopy(path: string): Promise<boolean> {
    try {
      return await this.options.removeCopy(path);
    } catch (error) {
      console.warn('[nestboard] 删除冲突副本失败', describeError(error));
      return false;
    }
  }
}

/** 单元格文本。两侧共用同一次 `type`：一侧有、另一侧没有时也要能一眼看出类型 */
function cellText(text: string | null, type: CardDiffRow['type']): string {
  if (text === null) return '—';
  // `cardLabel` 挤不出内容时会返回类型名，这时不要再拼一次 `[note] note`
  return text === type ? `[${type}]` : `[${type}] ${text}`;
}

function statusText(status: CardDiffRow['status']): string {
  switch (status) {
    case 'same':
      return t('modal.syncConflict.statusSame');
    case 'left-only':
      return t('modal.syncConflict.statusLeftOnly');
    case 'right-only':
      return t('modal.syncConflict.statusRightOnly');
    default:
      return t('modal.syncConflict.statusChanged');
  }
}

/** 路径 → 文件名（不带目录），用于标题与下拉项 */
function baseName(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash >= 0 ? path.slice(slash + 1) : path;
}
