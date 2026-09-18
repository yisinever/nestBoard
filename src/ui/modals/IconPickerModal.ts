/**
 * 卡面图标选择器（`O10`；`C3` 从"一列清单"改成"按组网格"）。
 *
 * 给白板卡挑一个 emoji，画在标题行左边 —— 一眼认出"这是哪块板"。
 *
 * ── `C3` 改了什么（用户 2026-09-18："标记调整，支持目前的 emoji，界面美化"）──
 *
 * 从前是 `SuggestModal`：一列文字，找一个 `🔵` 要在一列里扫；而**同一份** `EMOJI_GROUPS`
 * 在脑图的快捷操作栏里却是按类分组的（`08 §3.1`）—— 同一个东西两种待遇。
 * 现在换成 `Modal` + 输入框 + 网格（`ui/emojiGrid.ts` 那份纯构件），两处呈现终于同源。
 *
 * ★ 输入框保留**两种含义**（与 `emojiSuggestions` 同一条口径）：
 *   打 / 粘一个 emoji ⇒ 最前面钉一格"就是它"（系统表情面板挑出来的必须选得中）；
 *   打文字 ⇒ 按分组标题筛（"时间""办公"）。
 * ★ 不 import 视图、不认识白板：它只把选中的 emoji 通过 `onDone` 交回去。
 * ★ 取消（`Esc` / 点外面）不回调 —— 与从前那条约定一致："清除图标"在右键菜单里有自己的一项。
 */

import { Modal, type App } from 'obsidian';

import { buildEmojiGrid, type EmojiGridHandle } from '../emojiGrid';
import { t, type MessageKey } from '../../util/i18n';
import type { EmojiGroupKey } from '../../util/emoji';

/**
 * 分组标题的 i18n 键。
 *
 * ★ 由 `EmojiGroupKey` **推出来**（`mind.emojiGroup.<key>`），不另立一张映射表：
 *   那 10 条键本来就是按分组键命名的，另写一张表只会多一处会与 `EMOJI_GROUPS` 漂的对。
 * ★ 那几条键是脑图那边先立的（`ui/QuickBar.ts`），这里只是复用 —— 同一个分组
 *   在两处必须叫同一个名字。
 */
function groupTitleKey(key: EmojiGroupKey): MessageKey {
  return `mind.emojiGroup.${key}` as MessageKey;
}

export class IconPickerModal extends Modal {
  private grid: EmojiGridHandle | null = null;

  constructor(
    app: App,
    /** 当前图标（`undefined` = 还没设）：网格里用一圈选中环标出来 */
    private readonly current: string | undefined,
    private readonly onDone: (icon: string) => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.titleEl.setText(t('modal.iconPicker.title'));
    const { contentEl } = this;
    contentEl.empty();

    const search = contentEl.createEl('input', { cls: 'nestboard-emoji-search' });
    search.type = 'text';
    search.placeholder = t('modal.iconPicker.desc');

    this.grid = buildEmojiGrid(contentEl.ownerDocument, {
      current: this.current,
      titleOf: (key) => t(groupTitleKey(key)),
      onPick: (icon) => {
        this.onDone(icon);
        this.close();
      },
    });
    contentEl.appendChild(this.grid.element);

    search.addEventListener('input', () => this.grid?.filter(search.value));
    // 焦点给输入框：想从系统表情面板粘一个的时候，这里就是落点
    search.focus();
  }

  override onClose(): void {
    this.grid = null;
    this.contentEl.empty();
  }
}
