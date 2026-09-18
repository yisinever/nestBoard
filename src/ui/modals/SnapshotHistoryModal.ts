/**
 * 历史版本对话框（T4.02 / `F11-11`）。
 *
 * 三段式：**列表（时间 + 卡片数差异）→ 预览 → 恢复**。
 *
 * ★ 预览是**卡片清单**而不是画布缩略图，这一点是刻意的：快照文件默认躺在
 *   `.obsidian/plugins/nestboard/` 下，**不在 Obsidian 的文件索引里**（03 §1.4），
 *   所以走不了 `BoardEmbed` 那条"给一个文件路径就渲染只读画布"的通路。
 *   要在对话框里画真画布，得给只读渲染器再开一个"从内存模型渲染"的入口 ——
 *   那是 `BoardEmbed` 的接口扩张，不属于 T4.02。清单已经足够回答
 *   "这是不是我想要的那一版"（时间 + 卡片数 + 前 30 张卡的标题/正文）。
 *
 * ★ 恢复是**行内二次确认**而不是再套一层模态框：嵌套对话框在 Obsidian 里
 *   层级会打架，而"我要覆盖当前内容"这件事只需要一句说明 + 两个按钮。
 */

import { Modal } from 'obsidian';
import type { App } from 'obsidian';
import type { SnapshotRecord } from '../../io/SnapshotStore';
import { t } from '../../util/i18n';

export interface SnapshotHistoryModalOptions {
  boardTitle: string;
  /** 列出快照（新 → 旧） */
  list: () => Promise<SnapshotRecord[]>;
  /** 读一份快照的原文，用于预览 */
  readText: (record: SnapshotRecord) => Promise<string>;
  /** 当前白板的卡片数，用来算"与当前相比" */
  currentCardCount: () => number;
  /**
   * 恢复。**调用方负责"先给当前版本打一份快照"** —— 那是"撤销恢复"的唯一退路，
   * 放在对话框里做会漏掉别的入口（比如以后可能加的右键菜单）。
   */
  restore: (record: SnapshotRecord) => Promise<void>;
}

/** 预览最多列这么多张卡 —— 再长就没人看了，而且读全文本身有成本 */
const PREVIEW_LIMIT = 30;

export class SnapshotHistoryModal extends Modal {
  private closed = false;
  private busy = false;

  constructor(
    app: App,
    private readonly options: SnapshotHistoryModalOptions,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.modalEl.addClass('nestboard-snapshot-modal');
    this.contentEl.addClass('nestboard-modal');
    this.setTitle(t('modal.snapshot.title', { board: this.options.boardTitle }));
    this.render();
  }

  override onClose(): void {
    // ★ 置位在 `contentEl.empty()` 之前：`list()` / `readText()` 可能还在路上，
    //   回来后不能再往已经拆掉的 DOM 里写
    this.closed = true;
    this.contentEl.empty();
    this.modalEl.removeClass('nestboard-snapshot-modal');
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();

    const list = contentEl.createDiv({ cls: 'nestboard-snapshot-list' });
    list.createDiv({ cls: 'nestboard-snapshot-loading', text: t('diagnostics.loading') });
    void this.fill(list);
  }

  private async fill(list: HTMLElement): Promise<void> {
    let records: SnapshotRecord[];
    try {
      records = await this.options.list();
    } catch (error) {
      if (this.closed) return;
      list.empty();
      list.createDiv({
        cls: 'nestboard-snapshot-empty',
        text: t('modal.snapshot.previewFailed', { error: String(error) }),
      });
      return;
    }

    // 面板可能已被关掉、或用户点了别处触发重绘：丢弃这次结果，别写进旧列表
    if (this.closed || !list.isConnected) return;

    list.empty();
    if (records.length === 0) {
      list.createDiv({ cls: 'nestboard-snapshot-empty', text: t('modal.snapshot.empty') });
      return;
    }

    const currentCards = this.options.currentCardCount();
    for (const record of records) this.renderRow(list, record, currentCards);
  }

  private renderRow(parent: HTMLElement, record: SnapshotRecord, currentCards: number): void {
    const row = parent.createDiv({ cls: 'nestboard-snapshot-row' });

    const head = row.createDiv({ cls: 'nestboard-snapshot-head' });
    head.createDiv({ cls: 'nestboard-snapshot-time', text: formatTime(record.capturedAt) });
    head.createDiv({
      cls: 'nestboard-snapshot-cards',
      text: `${record.cardCount ?? '?'}`,
    });
    head.createDiv({
      cls: 'nestboard-snapshot-diff',
      text: describeDiff(record.cardCount, currentCards),
    });

    const actions = row.createDiv({ cls: 'nestboard-snapshot-actions' });
    actions
      .createEl('button', { cls: 'nestboard-btn', text: t('modal.snapshot.preview') })
      .addEventListener('click', () => {
        void this.togglePreview(row, record);
      });
    actions
      .createEl('button', { cls: 'nestboard-btn', text: t('modal.snapshot.restore') })
      .addEventListener('click', () => this.confirmRestore(actions, record));
  }

  private async togglePreview(row: HTMLElement, record: SnapshotRecord): Promise<void> {
    const existing = row.querySelector('.nestboard-snapshot-preview');
    if (existing) {
      existing.remove();
      return;
    }

    const box = row.createDiv({ cls: 'nestboard-snapshot-preview' });
    box.createDiv({ cls: 'nestboard-snapshot-loading', text: t('diagnostics.loading') });

    try {
      const raw = await this.options.readText(record);
      if (this.closed || !box.isConnected) return;

      const lines = describeCards(raw);
      box.empty();
      if (lines.length === 0) {
        box.createDiv({ text: t('modal.snapshot.previewEmpty') });
        return;
      }
      for (const line of lines) {
        box.createDiv({ cls: 'nestboard-snapshot-preview-line', text: line });
      }
    } catch (error) {
      if (this.closed || !box.isConnected) return;
      box.empty();
      box.createDiv({ text: t('modal.snapshot.previewFailed', { error: String(error) }) });
    }
  }

  private confirmRestore(actions: HTMLElement, record: SnapshotRecord): void {
    actions.empty();
    const confirm = actions.createDiv({ cls: 'nestboard-snapshot-confirm' });
    confirm.createDiv({
      cls: 'nestboard-snapshot-confirm-text',
      text: t('modal.snapshot.confirmBody', {
        time: formatTime(record.capturedAt),
        cards: record.cardCount ?? '?',
      }),
    });

    const buttons = confirm.createDiv({ cls: 'nestboard-snapshot-confirm-actions' });
    buttons
      .createEl('button', { cls: 'nestboard-btn', text: t('modal.snapshot.cancel') })
      .addEventListener('click', () => {
        if (!this.closed) this.render();
      });
    buttons
      .createEl('button', { cls: 'nestboard-btn mod-cta', text: t('modal.snapshot.confirmOk') })
      .addEventListener('click', () => {
        void this.doRestore(record, buttons);
      });
  }

  private async doRestore(record: SnapshotRecord, host: HTMLElement): Promise<void> {
    if (this.busy) return;
    this.busy = true;

    host.empty();
    host.createDiv({ cls: 'nestboard-snapshot-loading', text: t('diagnostics.loading') });

    try {
      await this.options.restore(record);
      this.close();
    } catch (error) {
      if (this.closed) return;
      this.busy = false;
      host.empty();
      host.createDiv({ text: t('notice.snapshotRestoreFailed', { error: String(error) }) });
    }
  }
}

// ─────────────────────────────────────────────────────────────
// 小工具
// ─────────────────────────────────────────────────────────────

function formatTime(at: number): string {
  return new Date(at).toLocaleString();
}

function describeDiff(snapshotCards: number | null, currentCards: number): string {
  if (snapshotCards === null) return '';
  const delta = snapshotCards - currentCards;
  if (delta === 0) return t('modal.snapshot.diffSame');
  return delta > 0
    ? t('modal.snapshot.diffMore', { count: delta })
    : t('modal.snapshot.diffLess', { count: -delta });
}

/** 卡片上可能承载"人话"的字段，按优先级找第一个非空的 */
const CARD_TEXT_KEYS = ['title', 'text', 'content', 'name', 'src', 'url', 'path', 'query'] as const;

function describeCards(raw: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  const cards = (parsed as { cards?: unknown } | null)?.cards;
  if (!Array.isArray(cards)) return [];

  const lines = cards.slice(0, PREVIEW_LIMIT).map(describeCard);
  if (cards.length > PREVIEW_LIMIT) {
    lines.push(t('modal.snapshot.previewMore', { count: cards.length - PREVIEW_LIMIT }));
  }
  return lines;
}

function describeCard(card: unknown, index: number): string {
  const record = (card ?? {}) as Record<string, unknown>;
  const type = typeof record.type === 'string' ? record.type : 'card';

  let body = '';
  for (const key of CARD_TEXT_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      body = value.trim();
      break;
    }
  }

  // 便签正文/待办项里可能有多行，压成一行才好放进列表
  const flat = body.replace(/\s+/g, ' ');
  const clipped = flat.length > 80 ? `${flat.slice(0, 80)}…` : flat;
  return `${index + 1}. [${type}] ${clipped}`;
}
