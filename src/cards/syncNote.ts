/**
 * 同步便签卡（T7.04 / `F2.9`）—— **同一便签在多处显示**。
 *
 * ## 它和便签卡的关系
 *
 * 正文形状、显示态 / 编辑态的渲染与便签卡**完全一致**（直接复用 `note.ts` 导出的
 * `renderNotePreview` / `renderNoteEditor`）—— 它在用户眼里"就是一张便签"。
 * 唯一的区别在**写回**：`key` 相同的若干张属于同一个**同步组**，编辑任意一张会把
 * 正文写回整组（`CardRenderContext.writeSyncGroup`），于是"摆了两处"的两张永远一样。
 *
 * ## 三个刻意的取舍
 *
 * 1. **`key` 为空 = 独立便签**：新建的那一张先当普通便签用；用户落笔之后想"再摆一处"
 *    再建副本（右键「新建同步副本」，或直接复制这张卡）—— 那时两张才共享同一个 `key`。
 * 2. **每张各存一份正文**，而不是"一张存正文、其余存 id 引用它"：这样渲染、导出、搜索
 *    都只看单张卡就够（那些入口只拿得到一张卡），一致性由**唯一的写入路径**保证 ——
 *    任何一次编辑都写全组，所以落盘时同组各份天然相等。
 * 3. **能力缺失时退回单卡写回**（`ctx.writeSyncGroup` 不传，例如单测 / 将来的嵌入视图）：
 *    那张卡就像一张普通便签那样工作，而不是"编辑了没反应"。
 */

import type { SyncNoteContent } from '../model/schema';
import type { Size } from '../util/geometry';
import { t } from '../util/i18n';
import { renderNoteEditor, renderNotePreview } from './note';
import type { CardRenderContext, CardTypeDefinition, CardTypeMenuItem } from './registry';

/** 同步便签与便签同尺寸（与 `model/factories.ts` 的 `DEFAULT_CARD_SIZES` 保持一致） */
export const SYNC_NOTE_DEFAULT_SIZE: Size = { width: 280, height: 180 };

/** 本定义加在槽位元素上的 class，`destroy()` 必须**原样摘掉**（否则会污染复用池里的节点） */
const SYNC_NOTE_CLASSES = [
  'nestboard-note',
  'nestboard-note-preview',
  'nestboard-note-edit',
  'nestboard-sync-note',
] as const;

export const syncNoteCard: CardTypeDefinition<'syncNote'> = {
  type: 'syncNote',

  // getter：语言切换后取到的仍是当前语言的名称
  get displayName(): string {
    return t('card.type.syncNote');
  },

  icon: 'files',
  defaultSize: SYNC_NOTE_DEFAULT_SIZE,

  createDefaultContent(): SyncNoteContent {
    return { key: '', md: '' };
  },

  render(el: HTMLElement, card, ctx: CardRenderContext): void {
    // 正文区域与便签共用同一套 class / 样式，见文件头
    el.classList.add('nestboard-note');

    // 只有真的在同步组里（`key` 非空）才画角标：孤立的那一张就是普通便签，
    // 给它挂一个"同步"角标会让人以为内容在别处还有一份。
    if (card.content.key.length > 0) {
      el.classList.add('nestboard-sync-note');
      el.dataset.syncLabel = t('card.syncNote.badge');
    } else {
      el.classList.remove('nestboard-sync-note');
      delete el.dataset.syncLabel;
    }

    if (ctx.mode === 'edit') {
      // ★ `F5` 起编辑态只有正文那一格（与便签 / 文档节点同一套，见 `note.ts` 文件头），
      //   标题不再从编辑器里提交 —— 改标题走卡面那一行的就地输入（`BoardView.editCardTitle`）。
      //   正文是**整组共用**的，所以收口换成 `submitContent`（一张改、全组一起改）。
      renderNoteEditor(el, card.content.md, ctx, (value) => {
        submitContent(card.content, value, ctx);
      });
    } else {
      renderNotePreview(el, card.content.md, ctx);
    }
  },

  /**
   * 节点被回收进复用池前的清理。
   * 这里删掉的每个 class / dataset，`render()` 里都写过一次 —— 漏一个，
   * 下一位租客就会继承"这是同步便签"的样式。
   */
  destroy(el: HTMLElement): void {
    el.classList.remove(...SYNC_NOTE_CLASSES);
    delete el.dataset.placeholder;
    delete el.dataset.syncLabel;
  },

  contextMenu(card, ctx): CardTypeMenuItem[] {
    const items: CardTypeMenuItem[] = [
      {
        id: 'sync-note-duplicate',
        title: t('menu.card.syncDuplicate'),
        icon: 'copy-plus',
        action: 'duplicateSyncNote',
        // 多选时"给哪一张建副本"没有唯一合理解释 → 置灰（与「编辑内容」同规矩）
        disabled: ctx.multiple,
      },
    ];
    // 「取消同步」只对**正在同步组里**的那张有意义：孤立的一张点了什么都没发生，
    // 与其留一个死项，不如让它在菜单里根本不出现。
    if (card.content.key.length > 0) {
      items.push({
        id: 'sync-note-detach',
        title: t('menu.card.syncDetach'),
        icon: 'unlink',
        action: 'unsyncNote',
        disabled: ctx.multiple,
      });
    }
    return items;
  },

  toMarkdown(card): string {
    return card.content.md;
  },
};

/**
 * 提交一张同步便签的正文。
 *
 * ★ 优先走**同步组**写回（一张改、全组一起改、一起撤销）。
 * ★ `key` 为空时必走单卡：它还没加入任何组，"写全组"实际上只写它自己，
 *   而 `updateContent` 的语义更直白。
 * ★ `writeSyncGroup` 缺席（单测 / 嵌入视图）时也退回单卡 —— 见文件头第 3 条。
 */
function submitContent(content: SyncNoteContent, value: string, ctx: CardRenderContext): void {
  if (content.key.length > 0 && ctx.writeSyncGroup) {
    ctx.writeSyncGroup(content.key, value);
    return;
  }
  ctx.updateContent({ md: value });
}
