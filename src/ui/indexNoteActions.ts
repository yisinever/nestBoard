/**
 * 索引笔记的两个用户动作（T7.01 / `F10-09` + `F7-09`）。
 *
 * 放在 `ui/` 而不是 `integration/`：这两个动作要弹 `Notice`、要开确认框，
 * 而 `IndexNoteBridge` 那条纪律是"不认识 Obsidian"，只在 node 下直测。
 *
 * ★ 两条都是**全局命令**（不要求白板视图在前台）：它们管的是整个库里的一批生成物，
 *   而"我库里怎么多了一堆 md"正是**没在看白板**的时候才会注意到的事。
 */

import { Notice } from 'obsidian';
import type NestboardPlugin from '../main';
import { t } from '../util/i18n';
import { ConfirmModal } from './modals/ConfirmModal';

/**
 * 「重建索引笔记」：让磁盘上"正好"是每块白板该有的那份。
 *
 * ★ 走的是桥里那个幂等的 `syncAll`：内容没变的板不会产生任何写盘。所以"我手动删了
 *   几份、想补齐"与"我想确认它还在正常维护"两种场景下它都是安全的。
 * ★ 开关关着时给一句明确的提示，而不是静默返回：用户点的是"重建"，什么都没发生
 *   会让他以为命令坏了 —— 而真正的原因在设置里。
 */
export async function rebuildIndexNotes(plugin: NestboardPlugin): Promise<void> {
  if (!plugin.settings.enableIndexNote) {
    new Notice(t('notice.indexNoteDisabled'));
    return;
  }

  const stats = await plugin.indexNotes.syncAll();
  new Notice(t('notice.indexNoteRebuilt', { count: stats.written + stats.unchanged }));

  // ★ 冲突单独再报一声：上面那个数字只说明"处理了几块板"，而被跳过的那些
  //   （目标路径上蹲着用户的同名笔记）需要用户自己决定怎么办，不能吞掉
  const conflicts = plugin.indexNotes.conflicts().length;
  if (conflicts > 0) {
    new Notice(t('notice.indexNoteConflictCount', { count: conflicts }), 8000);
  }
}

/**
 * 「删除索引笔记」：整体撤销 —— 把生成的 `.md` 全部收进回收站。
 *
 * ★ 删之前必须让用户看见**数量与目录**：这条命令会一口气动几十上百个文件。它和
 *   "删除某一块白板"不同 —— 用户按下它时往往只是想"我试了一下，现在不想要了"，
 *   未必预期到规模。那个数字就是最有效的刹车（也正因如此用 `ConfirmModal` 的
 *   `danger: true`：初始焦点落在"取消"上）。
 * ★ 删除由桥负责，仍然是"只删带生成物标记的文件"（`removeAll` → `removeNote`），
 *   所以目录里混着的用户笔记一个字都不会动。
 */
export async function cleanupIndexNotes(plugin: NestboardPlugin): Promise<void> {
  const notes = await plugin.indexNotes.listNotes();
  if (notes.length === 0) {
    new Notice(t('notice.indexNoteCleanupNone'));
    return;
  }

  new ConfirmModal(plugin.app, {
    title: t('modal.indexNoteCleanup.title'),
    body: t('modal.indexNoteCleanup.body', {
      count: notes.length,
      folder: plugin.settings.indexNoteFolder,
    }),
    confirmLabel: t('modal.indexNoteCleanup.confirm'),
    danger: true,
    onConfirm: async () => {
      const stats = await plugin.indexNotes.removeAll();
      new Notice(t('notice.indexNoteCleaned', { count: stats.removed }));
    },
  }).open();
}
