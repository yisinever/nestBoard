/**
 * 打开一份脑图（`06 §7.2`）。
 *
 * ★ 与 `view/BoardViewHost.ts` 的三段式**逐条一致**：先找已有 leaf（复用，不重复开标签）
 *   → `setViewState` → `revealLeaf`。漏掉 `revealLeaf` 就是"视图建好了但不显示"这个经典 bug。
 * ★ `options.nodeId` 是给"搜索结果 / 反链点进来定位到某个节点"留的口子（`06 §7.2` 第 3 条）：
 *   P0 先把它放进 view state，真正的定位动作在 P6 接。
 */

import { View } from 'obsidian';
import type { App } from 'obsidian';
import { VIEW_TYPE_MIND } from '../../constants';
import { MindView } from './MindView';

/** 找出已打开这份脑图的视图（没有则 `null`） */
export function findMindView(app: App, path: string): MindView | null {
  for (const leaf of app.workspace.getLeavesOfType(VIEW_TYPE_MIND)) {
    const view = leaf.view;
    if (view instanceof MindView && view.file?.path === path) return view;
  }
  return null;
}

/**
 * 当前活动 leaf 上的脑图视图（命令层用它做 `checkCallback` 判据）。
 *
 * ★ 取基类类型 + `instanceof` 收窄，而不是把 `MindView` 直接当类型参数传进去：
 *   后者要求"构造函数签名与基类兼容"，而 `MindView` 多一个 `plugin` 参数 ——
 *   这样写在运行时反而更明确（"真的是这个类"才算数）。
 */
export function getActiveMindView(app: App): MindView | null {
  const view = app.workspace.getActiveViewOfType(View);
  return view instanceof MindView ? view : null;
}

/**
 * 当前打开的**全部**脑图视图（与 `allBoardViews` 同一个用途）。
 *
 * ★ 设置的变更要**推给每一份已经打开的视图**（缩略图导航器那个开关就是第一条：
 *   在设置里拨一下，所有开着的脑图当场跟着亮/灭，而不是"新开的才生效"）。
 * ★ 与白板同一条纪律：绝不缓存视图实例 —— 一律现场 `getLeavesOfType` 查。
 */
export function allMindViews(app: App): MindView[] {
  const views: MindView[] = [];
  for (const leaf of app.workspace.getLeavesOfType(VIEW_TYPE_MIND)) {
    if (leaf.view instanceof MindView) views.push(leaf.view);
  }
  return views;
}

export interface OpenMindOptions {
  /** 强制开新标签（"在新标签打开"那类入口） */
  newLeaf?: boolean;
  /** 进去之后定位到哪个节点（P6 消费） */
  nodeId?: string;
}

/**
 * 打开一份脑图；返回拿到/新建的视图（拿不到实例时 `null`，调用方不必判空也能往下走）。
 *
 * ★ `active: true` 与白板同一条：用户点了"新建脑图"就该**当场看见它**，
 *   而不是去标签栏里找那个没被激活的新标签。
 */
export async function openMindView(
  app: App,
  path: string,
  options: OpenMindOptions = {},
): Promise<MindView | null> {
  const existing = findMindView(app, path);
  if (existing && !options.newLeaf) {
    await app.workspace.revealLeaf(existing.leaf);
    return existing;
  }

  const leaf = app.workspace.getLeaf('tab');
  await leaf.setViewState({
    type: VIEW_TYPE_MIND,
    state: options.nodeId ? { file: path, nodeId: options.nodeId } : { file: path },
    active: true,
  });
  await app.workspace.revealLeaf(leaf);

  return leaf.view instanceof MindView ? leaf.view : null;
}
