/**
 * 同步冲突副本的**发现**与**处置入口**（T4.03 / 03 §3.4）。
 *
 * 这一层是 `obsidian` 与纯逻辑（`io/conflict.ts`）的胶水：扫库、挑出该对比的那一份、
 * 把视图和删除动作接进 `ConflictMergeModal`。判断逻辑（谁算冲突副本、差异怎么算）
 * 全在 `io/conflict.ts`，那边才是被测的部分。
 */

import { Notice } from 'obsidian';
import { parseBoardFile } from '../io/boardText';
import { conflictBasePath, findConflictCopies, type ConflictCopy } from '../io/conflict';
import type NestboardPlugin from '../main';
import { describeError } from '../util/errors';
import { t } from '../util/i18n';
import { getActiveBoardView, openBoardView } from '../view/BoardViewHost';
import { trashConflictCopy } from './boardActions';
import { ConflictMergeModal } from './modals/ConflictMergeModal';

/** 扫一遍库里的冲突副本。扫描本身出错（磁盘抖动之类）不该把插件带崩，返回空数组 */
export async function scanConflictCopies(plugin: NestboardPlugin): Promise<ConflictCopy[]> {
  try {
    return await findConflictCopies(plugin.vaultIO);
  } catch (error) {
    console.warn('[nestboard] 扫描同步冲突副本失败', describeError(error));
    return [];
  }
}

/**
 * 启动时提示一次。
 *
 * ★ 没有冲突就**完全不出声**：每次开 Obsidian 都弹一句"一切正常"是纯噪声，
 *   用户很快就会学会无视这个插件的所有提示。
 */
export async function notifyConflictCopies(plugin: NestboardPlugin): Promise<void> {
  const copies = await scanConflictCopies(plugin);
  if (copies.length === 0) return;
  new Notice(t('notice.conflictCopies', { count: copies.length }), 8000);
}

/**
 * 打开并排对比视图。
 *
 * `copyPath` 省略时的挑选顺序：**当前白板**的冲突副本 → 库里第一份。
 * 先看当前板是刻意的：用户往往是在"这块板怎么不对"的时候才想起找冲突，
 * 这时他关心的就是眼前这块。
 */
export async function openConflictCompare(
  plugin: NestboardPlugin,
  copyPath?: string,
): Promise<void> {
  const copies = await scanConflictCopies(plugin);
  if (copies.length === 0) {
    new Notice(t('notice.conflictCopiesNone'));
    return;
  }

  const chosen = pickCopy(copies, copyPath, getActiveBoardView(plugin.app)?.boardPath ?? null);
  // 同一块原板的副本一起列出来：一次同步冲突经常产生不止一份（三台设备各一份）
  const siblings =
    chosen.basePath === null
      ? [chosen.path]
      : copies.filter((copy) => copy.basePath === chosen.basePath).map((copy) => copy.path);

  new ConflictMergeModal(plugin.app, {
    leftPath: chosen.basePath ?? conflictBasePath(chosen.path) ?? '',
    copies: siblings.length > 0 ? siblings : [chosen.path],
    loadBoard: async (path) => parseBoardFile(await plugin.vaultIO.read(path)),
    openBoard: (path) => {
      void openBoardView(plugin.app, path);
    },
    removeCopy: (path) => trashConflictCopy(plugin, path),
  }).open();
}

function pickCopy(
  copies: readonly ConflictCopy[],
  requested: string | undefined,
  activePath: string | null,
): ConflictCopy {
  if (requested !== undefined && requested.length > 0) {
    const exact = copies.find((copy) => copy.path === requested);
    if (exact) return exact;
  }
  if (activePath !== null) {
    const forActive = copies.find((copy) => copy.basePath === activePath);
    if (forActive) return forActive;
  }
  return copies[0]!;
}
