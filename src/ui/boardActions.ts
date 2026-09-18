/**
 * 白板文件级的破坏性动作（T4.04 / 03 §3.6）。
 *
 * 两条硬约束写在这一个入口里，别的地方不要绕过它去删 `.nboard`：
 *   1. **走回收站**：`vault.trash(file, true)`，不用 `vault.delete()`。
 *      用户说"删"指的是"我不想在库里看见它了"，不是"我要它永远消失"。
 *   2. **删之前先打快照**：回收站只兜住"刚才那份文件"，兜不住"我刚在画布上改的
 *      那半小时"——那些改动可能还没落盘（会话是防抖保存的）。
 *
 * 顺序不能换：**快照 → 摘会话 → 进回收站**。
 *   - 快照要在摘会话之前，否则拿不到内存里最新的那份（会话一关模型就丢了）；
 *   - 摘会话要在进回收站之前，否则 `BoardView.onClose` 的 `flush(path)`
 *     会在文件被删掉之后**把它重新写回来**，用户会看到"删完又冒出来"。
 */

import { Notice, TFile } from 'obsidian';
import { serializeBoard } from '../io/BoardRepository';
import { readBoardManifest } from '../io/boardText';
import type NestboardPlugin from '../main';
import { describeError } from '../util/errors';
import { t } from '../util/i18n';
import { findBoardView } from '../view/BoardViewHost';
import { ConfirmModal } from './modals/ConfirmModal';

export interface TrashRequest {
  /** 库内路径（`.nboard` 或冲突副本） */
  path: string;
  title: string;
  body: string;
  confirmLabel: string;
  /** 删除成功后的 Notice 文案，支持 `{path}` 占位 */
  doneNotice: string;
  /** 删除成功后的收尾（例如关掉正显示这份文件的标签页） */
  onTrashed?: (path: string) => void;
}

/**
 * 「二次确认 → 自动快照 → 进回收站」。返回的 Promise 在**用户做出决定后**兑现：
 * `true` = 已删，`false` = 取消 / 删除失败。对话框自己负责把失败原因显示出来。
 */
export function confirmAndTrash(plugin: NestboardPlugin, request: TrashRequest): Promise<boolean> {
  const file = plugin.app.vault.getAbstractFileByPath(request.path);
  if (!(file instanceof TFile)) {
    new Notice(t('notice.trashMissing', { path: request.path }));
    return Promise.resolve(false);
  }

  return new Promise<boolean>((resolve) => {
    new ConfirmModal(plugin.app, {
      title: request.title,
      body: request.body,
      confirmLabel: request.confirmLabel,
      danger: true,
      onConfirm: async () => {
        try {
          await snapshotBeforeTrash(plugin, request.path);
          // 先摘会话：见文件头，顺序错了文件会被"复活"
          plugin.repository.close(request.path);
          await plugin.app.vault.trash(file, true);
        } catch (error) {
          resolve(false);
          throw error;
        }

        // ★ 收尾放在 try 之外：文件这时候**已经进回收站了**，如果关标签页那一步抛错，
        //   再让对话框报错 + 判成"没删成功"，用户会去重删一个已经不存在的文件
        new Notice(request.doneNotice.replace('{path}', request.path));
        resolve(true);
        try {
          request.onTrashed?.(request.path);
        } catch (error) {
          console.warn('[nestboard] 删除后的收尾失败', describeError(error));
        }
      },
      onCancel: () => resolve(false),
    }).open();
  });
}

/** 删除当前打开的白板（或指定路径的那块） */
export function deleteBoardWithConfirm(plugin: NestboardPlugin, path: string): Promise<boolean> {
  return confirmAndTrash(plugin, {
    path,
    title: t('modal.confirmDeleteBoard.title'),
    body: t('modal.confirmDeleteBoard.body', { path }),
    confirmLabel: t('modal.confirmDeleteBoard.ok'),
    doneNotice: t('notice.boardTrashed'),
    onTrashed: (deleted) => {
      // 关掉正显示这块板的标签页：文件已经进回收站，留着一个指向不存在文件的画布
      // 只会骗用户继续编辑，而之后的每次保存都会失败
      const leaf = findBoardView(plugin.app, deleted)?.leaf;
      if (leaf) void leaf.detach();
    },
  });
}

/** 删除一份同步冲突副本（T4.03 的处置动作，同样走回收站 + 快照） */
export function trashConflictCopy(plugin: NestboardPlugin, path: string): Promise<boolean> {
  return confirmAndTrash(plugin, {
    path,
    title: t('modal.confirmDeleteCopy.title'),
    body: t('modal.confirmDeleteCopy.body', { path }),
    confirmLabel: t('modal.confirmDeleteCopy.ok'),
    doneNotice: t('notice.conflictCopyTrashed'),
    onTrashed: (deleted) => {
      // 副本一般没被打开；万一开着就一起收拾掉，否则同样会被 onClose 写回来
      const leaf = findBoardView(plugin.app, deleted)?.leaf;
      if (leaf) void leaf.detach();
    },
  });
}

/**
 * 删除前给这份文件留一份快照。
 *
 * 优先取**内存里**的那份：会话是防抖保存的，用户刚画的几笔很可能还没落盘，
 * 而"删之前长什么样"要的是用户眼前的画面，不是磁盘上那份旧的。
 */
async function snapshotBeforeTrash(plugin: NestboardPlugin, path: string): Promise<void> {
  if (plugin.settings.snapshotEnabled === false) return;
  try {
    const inMemory = plugin.repository.get(path);
    if (inMemory) {
      await plugin.snapshotStore.capture(
        inMemory.meta.id,
        inMemory.revision,
        serializeBoard(inMemory),
      );
      return;
    }

    const raw = await plugin.vaultIO.read(path);
    const manifest = readBoardManifest(raw);
    // 解析不出 id 就没法定位快照目录（快照按板 id 分层）；此时放弃快照而不是乱塞
    if (!manifest) return;
    await plugin.snapshotStore.capture(manifest.id, manifest.revision, raw);
  } catch (error) {
    // ★ 快照失败**不阻断**删除：用户已经明确确认过，而 `vault.trash` 本身就是一道
    //   回收站兜底；为了一次快照写入失败把删除卡死，只会让人以为插件坏了。
    //   但必须说一声 —— "以为有快照其实没有"比"知道没有"危险得多。
    console.warn('[nestboard] 删除前快照失败', describeError(error));
    new Notice(t('notice.snapshotCreateFailed', { error: describeError(error) }));
  }
}
