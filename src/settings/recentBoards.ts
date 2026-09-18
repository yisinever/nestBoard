/**
 * 「最近打开」的白板路径列表（T5.08 / `F7-04`）。
 *
 * 侧栏「白板列表」有三种看法：目录树 / 按标签 / **按最近打开**。前两种能从
 * `BoardRegistry` 现有数据里算出来，最后一种不行 —— "最近打开"是**使用历史**，
 * 库里任何一份文件都不记录它，只能由插件自己攒。于是就落在设置里（`data.json`）。
 *
 * ★ 这里全是纯函数、不 import `obsidian`：列表顺序这种东西一旦写错，
 *   用户看到的是"最近打开"排得莫名其妙，而它在真机上极难复现，必须能在 node 下测。
 */

import { RECENT_BOARDS_LIMIT } from '../constants';

/**
 * 把 `path` 记成"最近打开"，返回新列表。
 *
 * ★ 两条不变量，都**返回原引用**（`list` 本身）来表示"什么都没变"：
 *   1. `path` 已经在队首 —— 用户在同一块板上点来点去是常态，不该每次都写一次 `data.json`；
 *   2. `path` 是空白 —— 空路径不是一次"打开"，把它塞进列表只会让"最近打开"里多一行空白。
 *
 *   用引用相等而不是"内容相等"来传达这个信息，是因为调用方（`main.ts`）的下一步
 *   就是**写盘**，它需要一个零成本、不会误判的信号。
 */
export function pushRecentBoards(
  list: readonly string[],
  path: string,
  limit: number = RECENT_BOARDS_LIMIT,
): readonly string[] {
  const trimmed = path.trim();
  if (trimmed.length === 0) return list;
  if (limit <= 0) return list.length === 0 ? list : [];
  if (list[0] === trimmed) return list;

  // 去重：同一块板只会出现在一个位置，重新打开 = 挪到队首，而不是多出一行。
  const next = [trimmed, ...list.filter((item) => item !== trimmed)];
  return next.length > limit ? next.slice(0, limit) : next;
}

/**
 * 白板改名 / 移动后，把历史里那条路径也搬过去。
 *
 * ★ 不搬的话，那一项会**凭空消失**而不是"变成旧名字"：侧栏渲染时拿路径回
 *   `BoardRegistry` 逐条核对，对不上就静默跳过（见 `ui/boardList.ts` 的 `recentBoards()`）。
 *   用户刚改完名，回头发现最顺手的那条捷径没了，却没有任何提示告诉他为什么。
 * ★ 返回原引用 = "列表里根本没有 `oldPath`"（库里绝大多数改名都与这个列表无关），
 *   调用方据此免掉一次写盘。
 */
export function renameRecentBoards(
  list: readonly string[],
  oldPath: string,
  newPath: string,
): readonly string[] {
  if (list.length === 0 || !list.includes(oldPath)) return list;

  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of list) {
    const path = item === oldPath ? newPath : item;
    // 新路径本来就在列表里（比如改回原名）时只留靠前的那一条，否则会出现两行同一块板
    if (seen.has(path)) continue;
    seen.add(path);
    out.push(path);
  }
  return out;
}

/**
 * 从 `data.json` 里读回来的东西**一律不可信**（用户手改过、旧版本写过、同步冲突过），
 * 所以进内存前统一过一遍：只留非空字符串、去重、截断到上限。
 *
 * ★ 不认识的东西**丢掉**而不是报错：这个字段坏了只影响一个侧栏列表，
 *   为此让整份设置加载失败（连带所有白板打不开）是完全划不来的。
 */
export function normalizeRecentBoards(
  value: unknown,
  limit: number = RECENT_BOARDS_LIMIT,
): string[] {
  if (!Array.isArray(value) || limit <= 0) return [];

  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const path = item.trim();
    if (path.length === 0 || seen.has(path)) continue;
    seen.add(path);
    out.push(path);
    if (out.length >= limit) break;
  }
  return out;
}
