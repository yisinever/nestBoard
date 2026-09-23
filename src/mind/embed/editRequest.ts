/**
 * "画完这一帧之后，请把某个节点交给卡内编辑器"（`F3a` / `F4`）。
 *
 * ★ 为什么要有这个东西：**加节点这件事发生在白板的视图层**（节点右键菜单要 Obsidian 的
 *   `Menu`），而"开始打字"这件事在卡片那一层（`view/EmbedMind.ts` 的 `beginTitleEdit`）。
 *   两者隔着一整层，于是留一个**单槽请求**：视图加完节点把它记在这里，
 *   卡片下一次画完就取走并开始编辑。
 * ★ 每份脑图只留一个槽（新的覆盖旧的）：用户连着加三个节点时，"最后一次加的那个"
 *   才是他想打字的那一个。卡没挂载（滚出视口）时请求留在槽里，回来再消费。
 * ★ `key` 由调用方给：文件卡用**库内路径**，内嵌脑图卡（`F4`）用**卡片 id** ——
 *   两张卡的数据源不同，但"请求一次编辑"这件事一模一样，所以住在这里共用一份。
 */

const pending = new Map<string, string>();

/** 请求在下一帧把某个节点交给卡内编辑器 */
export function requestMindEdit(key: string, nodeId: string): void {
  pending.set(key, nodeId);
}

/** 取走（并清掉）那个请求；没有给 `null` */
export function takeMindEdit(key: string): string | null {
  const wanted = pending.get(key);
  if (wanted === undefined) return null;
  pending.delete(key);
  return wanted;
}
