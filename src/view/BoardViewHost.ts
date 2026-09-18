/**
 * 白板视图的「打开 / 复用」入口（T1.23，F7-01）。
 *
 * ★ 02 §5.3 的两条硬性纪律，这里全部落地：
 *
 * 1. **绝不缓存视图实例**。官方明确警告：缓存 view 会在用户关闭标签页后留下悬空引用，
 *    后续对它的任何操作都是未定义行为。所以一律现场 `getLeavesOfType` 查。
 * 2. **打开走标准三段式**：先查已有 leaf（复用）→ `setViewState` → `revealLeaf`。
 *    漏掉 `revealLeaf` 会出现"视图创建了但没显示"的经典 bug。
 */

import type { App } from 'obsidian';
import { VIEW_TYPE_BOARD } from '../constants';
import { BoardView } from './BoardView';

/** 找出已打开某块白板的视图（没有则 `null`）。用于「已打开就切过去，不要开第二个标签」 */
export function findBoardView(app: App, path: string): BoardView | null {
  for (const leaf of app.workspace.getLeavesOfType(VIEW_TYPE_BOARD)) {
    const view = leaf.view;
    if (view instanceof BoardView && view.file?.path === path) return view;
  }
  return null;
}

/**
 * 当前活动的白板视图。命令用 `checkCallback` 调它：
 * 没有白板在眼前时命令应当**从命令面板里消失**，而不是"点了没反应"。
 */
export function getActiveBoardView(app: App): BoardView | null {
  return app.workspace.getActiveViewOfType(BoardView);
}

/**
 * 当前打开的**全部**白板视图。
 *
 * 重命名 / 移动文件后要让每一个视图都认领新路径（T1.73）。这里不能只找"路径匹配的那个"：
 * 触发事件的那一刻，`currentPath` 与 `view.file.path` 谁先更新没有保证，
 * 所以交给 `BoardView.retargetPath` 用**旧路径**去逐个比对（对不上的自己会跳过）。
 */
export function allBoardViews(app: App): BoardView[] {
  const views: BoardView[] = [];
  for (const leaf of app.workspace.getLeavesOfType(VIEW_TYPE_BOARD)) {
    if (leaf.view instanceof BoardView) views.push(leaf.view);
  }
  return views;
}

/** 打开一块白板；`newLeaf` 为真时强制开新标签（如"在新标签打开"命令） */
export async function openBoardView(
  app: App,
  path: string,
  options: { newLeaf?: boolean } = {},
): Promise<BoardView | null> {
  const existing = findBoardView(app, path);
  if (existing && !options.newLeaf) {
    await app.workspace.revealLeaf(existing.leaf);
    return existing;
  }

  const leaf = app.workspace.getLeaf('tab');
  await leaf.setViewState({ type: VIEW_TYPE_BOARD, state: { file: path }, active: true });
  await app.workspace.revealLeaf(leaf);

  return leaf.view instanceof BoardView ? leaf.view : null;
}
