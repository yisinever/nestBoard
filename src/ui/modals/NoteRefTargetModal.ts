/**
 * 引用位置选择器（T7.10 / `F10-07`）。
 *
 * 挑"这张引用卡显示源笔记的哪一段"：整篇、某个标题、某个块。
 *
 * ★ 用 `SuggestModal` —— 与 `BoardPickerModal` / `NotePickerModal` 同一套约定：
 *   键盘上下、回车、按字过滤都是白送的，外观也和"快速切换"一致。
 *   ★ 一篇长笔记的标题可能有几十个，`SuggestModal` 的过滤是这里**必须**的能力
 *   —— 用 `Modal` + 一列按钮的话，用户得自己一行行找。
 *
 * ★ 「整篇笔记」永远在列表里、且**不参与过滤**：它是这个列表的出口（"我不想要
 *   局部了"），也是"目标被删了之后回到能用的状态"的唯一路径。敲了字之后它消失，
 *   就会变成"想取消却找不到取消"。
 *
 * ★ 取消也回调 `null`（与 `BoardPickerModal` / `EdgeLabelModal` 同一条约定）：
 *   不回调的话调用方那侧的分支会静默挂住。
 */

import { SuggestModal, type App } from 'obsidian';

import type { NoteRefAnchor } from '../../cards/noteRef';
import { t } from '../../util/i18n';

export class NoteRefTargetModal extends SuggestModal<NoteRefAnchor> {
  private chosen = false;

  constructor(
    app: App,
    private readonly anchors: readonly NoteRefAnchor[],
    /** 当前写着的 `subpath`（`null` = 整篇）：在列表里标出"就是它" */
    private readonly current: string | null,
    private readonly onDone: (subpath: string | null) => void,
  ) {
    super(app);
    this.titleEl.setText(t('modal.noteRefTarget.title'));
    this.setPlaceholder(t('modal.noteRefTarget.desc'));
  }

  override getSuggestions(query: string): NoteRefAnchor[] {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return [...this.anchors];
    return this.anchors.filter(
      (anchor) =>
        // 「整篇笔记」不参与过滤 —— 见文件头那条说明
        anchor.kind === 'whole' || anchor.label.toLowerCase().includes(needle),
    );
  }

  override renderSuggestion(anchor: NoteRefAnchor, el: HTMLElement): void {
    // 缩进用不换行空格：普通空格在 HTML 里会被折叠掉，层级也就看不出来了
    const indent = anchor.kind === 'heading' ? '\u00a0\u00a0'.repeat(anchor.level - 1) : '';
    const title =
      anchor.kind === 'whole'
        ? t('modal.noteRefTarget.whole')
        : anchor.kind === 'block'
          ? t('modal.noteRefTarget.block', { id: anchor.label })
          : anchor.label;

    const marked = anchor.subpath === this.current;
    if (marked) el.addClass('nestboard-suggest-current');
    el.createDiv({ text: `${marked ? '✓ ' : ''}${indent}${title}` });

    // 第二行写出**真正存进文件的值**：用户能看见这条定位到底指到哪儿，
    // 手改过 `subpath` 的人也不必靠猜
    el.createDiv({
      cls: 'nestboard-suggest-path',
      text: anchor.subpath ?? t('modal.noteRefTarget.whole'),
    });
  }

  override onChooseSuggestion(anchor: NoteRefAnchor): void {
    this.chosen = true;
    this.onDone(anchor.subpath);
  }

  override onClose(): void {
    super.onClose();
    if (!this.chosen) this.onDone(null);
  }
}
