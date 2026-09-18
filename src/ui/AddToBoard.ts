/**
 * 笔记 / 文件右键「添加到白板」（T1.67，`F6-07` / `F10-02`）。
 *
 * 与"拖进画布"共用同一套落卡逻辑（`BoardView.addFilesFromVault` →
 * `model/drop.ts`），差别只在**目标白板从哪来**：
 *
 * * 拖拽：目标是"用户拖到的那块板"，天然已知，不必问；
 * * 右键：用户可能同时开着好几块板（甚至一块都没开），所以先让他在
 *   `BoardPickerModal` 里选一块。
 *
 * ★ 一块白板都没有时**明确提示"先建一块"**，而不是弹一个空列表 ——
 *   后者会让用户以为插件坏了。选择器里也刻意不提供"顺便新建"：
 *   点的是"添加"，中途冒出一个新建分支会让人怀疑自己点错了。
 *
 * ★ 落卡位置由视图自己算（视口中心；中心落在分栏里就收进那一栏），
 *   本文件不碰坐标 —— 因此它在 node 下无法直测，判定逻辑全部下推到了
 *   `model/drop.ts`（见 04 §12.1 的分层约定）。
 */

import { Notice } from 'obsidian';

import type NestboardPlugin from '../main';
import { baseNameOf } from '../model/drop';
import { t } from '../util/i18n';
import { openBoardView } from '../view/BoardViewHost';
import { BoardPickerModal } from './modals/BoardPickerModal';

/**
 * 把 `sourcePath`（Vault 相对路径）作为卡片放进某块白板。
 *
 * `async` 的只是内部流程；对外暴露同步签名，方便 `file-menu` 的回调直接调用
 *（回调返回值会被 Obsidian 忽略，返回 Promise 只会变成一个未处理的引用）。
 */
export function addFileToBoard(plugin: NestboardPlugin, sourcePath: string): void {
  const boards = plugin.registry.all();
  if (boards.length === 0) {
    new Notice(t('notice.noBoardYet'));
    return;
  }

  new BoardPickerModal(plugin.app, boards, (boardPath) => {
    // 用户按 Esc / 点空白关掉选择器：什么都不做，也**不要**弹提示（他没要求任何事）
    if (boardPath === null) return;
    void placeOnBoard(plugin, boardPath, sourcePath);
  }).open();
}

/** 打开目标白板 → 落到视口中心 → 提示结果 */
async function placeOnBoard(
  plugin: NestboardPlugin,
  boardPath: string,
  sourcePath: string,
): Promise<void> {
  const view = await openBoardView(plugin.app, boardPath);
  if (!view || !(await view.addFilesFromVault([sourcePath]))) {
    new Notice(t('notice.addToBoardFailed', { path: boardPath }));
    return;
  }

  const title = plugin.registry.getByPath(boardPath)?.title || baseNameOf(boardPath);
  new Notice(t('notice.addedToBoard', { count: 1, board: title }));
}
