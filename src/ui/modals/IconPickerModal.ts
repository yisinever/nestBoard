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

import { buildEmojiGrid, type EmojiGridHandle } from '../emojiGrid';
import { buildPixelIconGrid, type PixelIconGridHandle } from '../pixelIconGrid';
import { t, type MessageKey } from '../../util/i18n';
import type { EmojiGroupKey } from '../../util/emoji';

type Tab = 'emoji' | 'pixel';

export class IconPickerModal extends Modal {
  private grid: EmojiGridHandle | PixelIconGridHandle | null = null;
  private tab: Tab = 'emoji';
  private query = '';

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

    // ── 标签页 ──
    const tabs = contentEl.createDiv({ cls: 'nestboard-icon-tabs' });
    const buttons: Array<{ tab: Tab; label: string }> = [
      { tab: 'emoji', label: t('modal.iconPicker.tab.emoji') },
      { tab: 'pixel', label: t('modal.iconPicker.tab.pixel') },
    ];
    const tabButtons = new Map<Tab, HTMLElement>();
    for (const entry of buttons) {
      const button = tabs.createEl('button', { text: entry.label });
      button.classList.toggle('is-active', entry.tab === this.tab);
      button.addEventListener('click', () => {
        this.tab = entry.tab;
        for (const [tab, element] of tabButtons)
          element.classList.toggle('is-active', tab === this.tab);
        this.renderGrid();
      });
      tabButtons.set(entry.tab, button);
    }

    const search = contentEl.createEl('input', { cls: 'nestboard-emoji-search' });
    search.type = 'text';
    search.placeholder = t('modal.iconPicker.desc');
    search.addEventListener('input', () => {
      this.query = search.value;
      this.grid?.filter(this.query);
    });

    // ★ 这个类名是**切换标签页时的锚点**（`renderGrid` 靠它找宿主重建网格）——
    //   少了它，点另一个标签页时 `querySelector` 返回 null，于是"切换不顶用"
    //   （用户 2026-09-28 报的正是这一条）。
    const container = contentEl.createDiv({ cls: 'nestboard-icon-grid-host' });
    this.renderGridInto(container);

    search.focus();
  }

  /** 按当前标签页重造网格（切换标签页时整块换掉；搜索词保留并立即生效） */
  private renderGrid(): void {
    const container = this.contentEl.querySelector<HTMLElement>('.nestboard-icon-grid-host');
    if (!container) return;
    this.renderGridInto(container);
  }

  private renderGridInto(container: HTMLElement): void {
    container.empty();
    this.grid = null;
    if (this.tab === 'pixel') {
      const grid = buildPixelIconGrid(container.ownerDocument, {
        current: this.current,
        onPick: (value) => {
          this.onDone(value);
          this.close();
        },
      });
      grid.filter(this.query);
      container.appendChild(grid.element);
      this.grid = grid;
      return;
    }
    const grid = buildEmojiGrid(container.ownerDocument, {
      current: this.current,
      titleOf: (key) => t(groupTitleKey(key)),
      onPick: (icon) => {
        this.onDone(icon);
        this.close();
      },
    });
    grid.filter(this.query);
    container.appendChild(grid.element);
    this.grid = grid;
  }

  override onClose(): void {
    this.grid = null;
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
