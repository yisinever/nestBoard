/**
 * 卡面图标选择器（`O10`；`C3` 网格化；用户 2026-09-28：**第二种图标类型**）。
 *
 * ── 两个标签页 ──────────────────────────────────────────────
 *
 * ① **Emoji**（原有那份 `EMOJI_GROUPS`，一个字节没动）；
 * ② **复古游戏机**（像素图标包，96 个 / 10 组，`ui/pixelIconGrid.ts`）——
 *    选中的值以 `nb:0101` 这种前缀串存进原来的 `icon` 字段（`util/iconValue.ts`），
 *    老文件零迁移；卡面 / 快捷操作栏经同一个解析口渲染。
 *
 * ★ 输入框的两种含义不变（打 / 粘一个 emoji ⇒ 钉一格"就是它"；打文字 ⇒ 按组名 /
 *   图标名过滤）。★ 取消（`Esc` / 点外面）不回调 —— 「清除图标」在右键菜单里有自己的一项。
 */

import { Modal, type App } from 'obsidian';

import { t, type MessageKey } from '../../util/i18n';
import type { EmojiGroupKey } from '../../util/emoji';
import { buildIconPickerPanel } from '../iconPickerPanel';

export class IconPickerModal extends Modal {
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

    // ★ 整个骨架（标签页 / 搜索 / 固定高的视口 / 两页）归 `iconPickerPanel`：
    //   与脑图工具栏那条弹层**同一个构件** ⇒ 两处不可能再各有一套滚动条的做法
    //   （用户 2026-09-28："这里的整个组件最好规划一下重写"）。
    const panel = buildIconPickerPanel(contentEl.ownerDocument, {
      current: this.current,
      tabLabels: {
        emoji: t('modal.iconPicker.tab.emoji'),
        pixel: t('modal.iconPicker.tab.pixel'),
      },
      searchPlaceholder: t('modal.iconPicker.desc'),
      emojiTitleOf: (key) => t(groupTitleKey(key)),
      onPick: (value) => {
        this.onDone(value);
        this.close();
      },
    });
    contentEl.appendChild(panel.element);
    panel.focusSearch();
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}

/**
 * 分组标题的 i18n 键。
 *
 * ★ 由 `EmojiGroupKey` **推出来**（`mind.emojiGroup.<key>`），不另立一张映射表：
 *   那 10 条键本来就是按分组键命名的，另写一张表只会多一处会与 `EMOJI_GROUPS` 漂的对。
 */
function groupTitleKey(key: EmojiGroupKey): MessageKey {
  return `mind.emojiGroup.${key}` as MessageKey;
}
