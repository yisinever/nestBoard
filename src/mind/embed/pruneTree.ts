/**
 * 卡内嵌脑图（`F3a`）：**只画前几层**的那一步 —— 纯逻辑。
 *
 * 白板里的那张脑图卡（`cards/mindRef.ts`）不是"整棵树缩到看不清"：卡面上只画
 * **前 `EMBED_MAX_DEPTH` 层**，更深的那些收成一个 `+N` 角标（用户 2026-09-21 定的
 * 口径：拖进来直接当脑图组件用，树很大时只渲染前 3 层）。这件事与"怎么画"无关，
 * 所以它住在这里、能逐条单测 —— 渲染层拿到的是一份**已经截好的 `MindFile`**，
 * 可以直接喂给 `layoutMind`（截掉的子树在布局看来就是"没有孩子"）。
 *
 * ── 两条口径 ─────────────────────────────────────────────────
 *
 * 1. **深度**：根是第 0 层，`depth <= maxDepth` 的节点都画。悬浮节点（`parentId === null`）
 *    以自己的中心为第 0 层 —— 它们本来就不在树上，规则一样。
 * 2. **`+N` 里数什么**：某个被画出来的节点**没被画出来的全部子孙**。
 *    两种情况下会没被画出来，这里**不区分**（对用户都是"它下面还有东西"）：
 *    * 它自己 `collapsed === true`（用户收起来了）；
 *    * 它已经到第 `maxDepth` 层（被卡面深度截掉的）。
 *
 * ★ 不 import `obsidian`、不碰 DOM：与 `layout/` 同一条纪律（视图与单测都能用）。
 */

import type { MindFile, MindNode } from '../model/schema';

/**
 * 卡面最多画到第几层（**根算第 0 层**）。
 *
 * ★ 值取 3 = 根 + 三层子节点：一眼能看出"这张脑图在讲什么"，又不至于把卡面挤死。
 *   调它是安全的（纯截断，不改模型）：`+N` 与布局都跟着走。
 */
export const EMBED_MAX_DEPTH = 3;

export interface PrunedMind {
  /** 只含要画的节点的**副本**：可以直接喂给 `layoutMind` */
  file: MindFile;
  /** 被截掉的子孙数，按**被画出来的那个节点**归口（键不在 = 它下面没有藏东西） */
  hiddenOf: ReadonlyMap<string, number>;
}

export function pruneMindForEmbed(mind: MindFile, maxDepth = EMBED_MAX_DEPTH): PrunedMind {
  const byId = new Map<string, MindNode>();
  const children = new Map<string, MindNode[]>();
  for (const node of mind.nodes) byId.set(node.id, node);
  for (const node of mind.nodes) {
    if (node.parentId === null) continue;
    const list = children.get(node.parentId);
    if (list) list.push(node);
    else children.set(node.parentId, [node]);
  }
  // 与 `layoutMind` / `validate` 同一个口径（order 优先、id 破平）：不只是好看 ——
  // `+N` 的计数与"哪一支被截"必须与画布上看到的顺序一致
  for (const list of children.values()) {
    list.sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1));
  }

  const kept = new Set<string>();
  const hiddenOf = new Map<string, number>();

  /** 这一支（不含自己）总共有多少个节点 */
  const descendantCount = (id: string): number => {
    let sum = 0;
    for (const kid of children.get(id) ?? []) sum += 1 + descendantCount(kid.id);
    return sum;
  };

  const walk = (node: MindNode, depth: number): void => {
    kept.add(node.id);
    // 收起 = 这一支不画（与画布同一条：折叠的子树一个节点都不排）
    if (node.collapsed === true) {
      const count = descendantCount(node.id);
      if (count > 0) hiddenOf.set(node.id, count);
      return;
    }
    const kids = children.get(node.id) ?? [];
    if (kids.length === 0) return;
    // 到深度上限：孩子整支不画，把总数记成 `+N`
    if (depth >= maxDepth) {
      hiddenOf.set(node.id, descendantCount(node.id));
      return;
    }
    for (const kid of kids) walk(kid, depth + 1);
  };

  const root = byId.get(mind.rootId);
  if (root) walk(root, 0);
  // 悬浮节点：它们是"另一棵树"，各自从第 0 层起算
  for (const node of mind.nodes) {
    if (node.parentId !== null || node.id === mind.rootId) continue;
    walk(node, 0);
  }

  return {
    file: { ...mind, nodes: mind.nodes.filter((node) => kept.has(node.id)) },
    hiddenOf,
  };
}
