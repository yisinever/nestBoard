import { SuggestModal, type App } from 'obsidian';

import type { BoardEntry } from '../../io/BoardRegistry';
import { t } from '../../util/i18n';

/** 候选上限：挑选目标而已，没必要把上千块白板全塞进列表 */
const MAX_SUGGESTIONS = 100;

/** 列表里的一项：一块已有白板，或者"新建子白板"那一行 */
type PickerItem = { kind: 'open'; board: BoardEntry } | { kind: 'create' };

/** 选择器的可选项 */
export interface BoardPickerOptions {
  /**
   * 「＋ 新建子白板」（T1.61 / `F2-8-1`）：列表第一行，选中后回调它。
   *
   * ★ **传了才有这一行**，默认没有 —— 与下面文件头那条取舍是同一件事：
   *   「添加到白板」（T1.67）点的是"添加"，在那里塞一个"要不要新建白板"
   *   的分支会让人怀疑自己点错了；而工具条的 [白板] 是"在这儿放一块板"，
   *   新建正是它该有的出路。两种情况都说得通，所以由调用方决定。
   */
  onCreateNew?: () => void;
}

/**
 * 白板选择器（T1.67：笔记右键「添加到白板」时挑目标；T1.61：工具条 [白板]）。
 *
 * 与 `NotePickerModal` 同一套约定：
 * * 用 `SuggestModal` —— 键盘上下、回车、模糊过滤都是白送的，外观与"快速切换"一致；
 * * **取消也必须回调** `null`，否则调用方 `await` 的 Promise 永远 pending，静默挂住。
 *
 * ★ 默认**只列已经建好**的白板：（`T1.67` 的说明）用户点的是"添加"，
 *   中途弹出一个"要不要新建白板"的分支会让他怀疑自己点错了。
 *   需要那条出路的地方（工具条 [白板]）显式传 `onCreateNew` 打开它。
 */
export class BoardPickerModal extends SuggestModal<PickerItem> {
  private chosen = false;

  constructor(
    app: App,
    private readonly boards: readonly BoardEntry[],
    private readonly onDone: (path: string | null) => void,
    private readonly options: BoardPickerOptions = {},
  ) {
    super(app);
    this.titleEl.setText(t('modal.pickBoard.title'));
    this.setPlaceholder(t('modal.pickBoard.placeholder'));
  }

  override getSuggestions(query: string): PickerItem[] {
    const needle = query.trim().toLowerCase();

    // ★ 「＋ 新建子白板」**不参与过滤**：它是这个列表的出口而不是一个候选项 ——
    //   敲了字之后它同样该在，否则"一块白板都没匹配上"时列表会空成一片，
    //   看起来像是坏了，而唯一的出路恰恰就在那一片空白里
    const items: PickerItem[] = this.options.onCreateNew ? [{ kind: 'create' }] : [];

    const matched = this.boards
      .filter(
        (board) =>
          needle.length === 0 ||
          board.title.toLowerCase().includes(needle) ||
          board.path.toLowerCase().includes(needle),
      )
      .slice()
      .sort((a, b) => a.path.localeCompare(b.path))
      .slice(0, MAX_SUGGESTIONS)
      .map((board): PickerItem => ({ kind: 'open', board }));

    return [...items, ...matched];
  }

  override renderSuggestion(item: PickerItem, el: HTMLElement): void {
    if (item.kind === 'create') {
      el.createDiv({ text: t('modal.pickBoard.create') });
      // 第二行与下面的白板项同构（都是"次要信息"），于是两行的行高一致、
      // 光标移上去时不会跳
      el.createDiv({ cls: 'nestboard-suggest-path', text: t('modal.pickBoard.createHint') });
      return;
    }
    el.createDiv({ text: item.board.title });
    // 同名白板很常见（不同文件夹各一块）：路径是唯一能区分它们的信息
    el.createDiv({ cls: 'nestboard-suggest-path', text: item.board.path });
  }

  override onChooseSuggestion(item: PickerItem): void {
    this.chosen = true;
    if (item.kind === 'create') {
      this.options.onCreateNew?.();
      return;
    }
    this.onDone(item.board.path);
  }

  override onClose(): void {
    super.onClose();
    if (!this.chosen) this.onDone(null);
  }
}
