/**
 * 快照的两个用户动作（T4.01 / T4.02 / `F11-11`）。
 *
 * 放在 `ui/` 而不是 `io/`：这两个动作要弹 Notice、开对话框，
 * 而 `io/` 那条纪律是"不得 import obsidian"。`SnapshotStore` 自己则完全不知道 UI 的存在。
 */

import { Notice } from 'obsidian';
import { serializeBoard } from '../io/BoardRepository';
import type NestboardPlugin from '../main';
import { describeError } from '../util/errors';
import { t } from '../util/i18n';
import type { BoardView } from '../view/BoardView';
import { SnapshotHistoryModal } from './modals/SnapshotHistoryModal';

/** 「创建快照」命令：立刻给当前白板打一份，不看节奏 */
export async function createSnapshotNow(plugin: NestboardPlugin, view: BoardView): Promise<void> {
  if (!plugin.settings.snapshotEnabled) {
    new Notice(t('notice.snapshotDisabled'));
    return;
  }

  const path = view.boardPath;
  const board = path === null ? null : plugin.repository.get(path);
  if (board === null) return;

  try {
    const record = await plugin.snapshotStore.capture(
      board.meta.id,
      board.revision,
      serializeBoard(board),
    );
    new Notice(t('notice.snapshotCreated', { cards: record.cardCount ?? 0 }));
  } catch (error) {
    new Notice(t('notice.snapshotCreateFailed', { error: describeError(error) }));
  }
}

/** 「查看历史版本」命令：列出快照 → 预览 → 恢复 */
export function openSnapshotHistory(plugin: NestboardPlugin, view: BoardView): void {
  const path = view.boardPath;
  const board = path === null ? null : plugin.repository.get(path);
  if (board === null) return;

  const boardId = board.meta.id;
  const boardTitle = board.meta.title.trim().length > 0 ? board.meta.title : path!;

  new SnapshotHistoryModal(plugin.app, {
    boardTitle,
    list: () => plugin.snapshotStore.list(boardId),
    readText: (record) => plugin.snapshotStore.readText(record),
    currentCardCount: () => plugin.repository.get(path!)?.cards.length ?? 0,
    restore: async (record) => {
      if (!plugin.settings.snapshotEnabled) {
        // 关掉快照后仍然允许"恢复已有快照"，但恢复前那份退路就没了 —— 说清楚再走
        new Notice(t('notice.snapshotDisabled'));
      } else {
        // ★ 恢复前先给**当前**版本打一份（不看节奏）：这是"恢复错了还能回来"的唯一退路
        const current = plugin.repository.get(path!);
        if (current) {
          await plugin.snapshotStore.capture(boardId, current.revision, serializeBoard(current));
        }
      }

      const raw = await plugin.snapshotStore.readText(record);
      await plugin.repository.restoreFromText(path!, raw);
      new Notice(
        t('notice.snapshotRestored', { time: new Date(record.capturedAt).toLocaleString() }),
      );
    },
  }).open();
}
