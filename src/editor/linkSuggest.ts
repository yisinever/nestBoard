/**
 * `[[` 链接补全的**纯逻辑**（`F5`）。
 *
 * ★ 为什么单独一个文件：编辑器本体（`MiniMarkdownEditor`）是"一块 textarea + 块级按键行为"，
 *   而补全要额外的东西 —— 库内候选、一个浮层、↑↓/⏎/Esc 的接管。把这些**判断**与
 *   "怎么画那个浮层"分开，前者就能在 node 下逐条钉住（后者只能在真库里肉眼验）。
 * ★ 不 import `obsidian`：候选列表由宿主注入（`ctx.suggestLinks`），这里只做
 *   "光标前是不是在敲链接 / 怎么排序 / 接受后文本变成什么"。
 *
 * 三个函数对应一段补全的三个瞬间：`detectLinkQuery`（要不要弹）→
 * `rankLinkCandidates`（弹什么）→ `applyLinkSuggestion`（选中之后变什么）。
 */

/** 一条候选（宿主给的库内文件） */
export interface LinkCandidate {
  /** vault 相对路径 —— 插进 `[[ ]]` 里的就是它 */
  path: string;
  /** 浮层上显示的名字；不传就取文件名（去扩展名） */
  label?: string;
}

/** 光标前正在敲的那段 `[[查询` */
export interface LinkQuery {
  /** `[[` 里第一个 `[` 的下标（接受候选时要从这里开始替换） */
  start: number;
  /** `[[` 之后到光标的查询串（可能是空串：刚敲完两个 `[`） */
  query: string;
}

/**
 * 光标前是不是"正在敲一个 `[[` 链接"。
 *
 * 判据（不满足任一条就返回 `null`，也就是**不弹**）：
 *
 * 1. `[[` 到光标之间**没有换行**（跨行的 `[[` 是普通文本，不是链接开头）；
 * 2. 中间**没有 `]`**（已经闭合了 `]]`，补全该收场）；
 * 3. 中间**没有 `|`**（`[[路径|别名]]` 的别名段里不该再补全路径）；
 * 4. 取的是**最后一个** `[[`：`[[a[[b` 这种手滑以最近的那个为准，否则会去改更早的字。
 */
export function detectLinkQuery(value: string, caret: number): LinkQuery | null {
  const before = value.slice(0, Math.max(0, Math.min(caret, value.length)));
  const start = before.lastIndexOf('[[');
  if (start < 0) return null;

  const query = before.slice(start + 2);
  if (query.includes('\n') || query.includes(']') || query.includes('|')) return null;
  return { start, query };
}

/** 候选项上显示的短名：`笔记/子目录/标题.md` → `标题` */
export function labelOf(candidate: LinkCandidate): string {
  if (candidate.label !== undefined && candidate.label.length > 0) return candidate.label;
  const leaf = candidate.path.split('/').pop() ?? candidate.path;
  const dot = leaf.lastIndexOf('.');
  return dot > 0 ? leaf.slice(0, dot) : leaf;
}

/**
 * 挑出该显示的候选。
 *
 * ★ 排序规则（都按**小写**比较，所以 `readme` 能命中 `README.md`）：
 *   ① **前缀命中**排在"中间命中"前面 —— 敲 `[[笔` 时用户想要的几乎总是"以笔开头的那几篇"；
 *   ② 同档里**路径短**的靠前（短路径通常就是更常用的那篇，且浮层一行放得下）；
 *   ③ 再同档按路径字典序，保证**同一输入两次给出同一个顺序**（否则上下键会跳动）。
 * ★ `limit` 有上限：浮层最多显示几行，多了反而找不到。
 */
export function rankLinkCandidates(
  candidates: readonly LinkCandidate[],
  query: string,
  limit = 8,
): LinkCandidate[] {
  const needle = query.trim().toLowerCase();
  const matched: LinkCandidate[] = [];
  for (const candidate of candidates) {
    const haystack = candidate.path.toLowerCase();
    if (needle.length === 0 || haystack.includes(needle)) matched.push(candidate);
  }

  return matched
    .sort((a, b) => {
      const aPrefix = a.path.toLowerCase().startsWith(needle) ? 0 : 1;
      const bPrefix = b.path.toLowerCase().startsWith(needle) ? 0 : 1;
      if (aPrefix !== bPrefix) return aPrefix - bPrefix;
      if (a.path.length !== b.path.length) return a.path.length - b.path.length;
      return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
    })
    .slice(0, Math.max(0, limit));
}

/**
 * 接受一条候选：把 `[[查询` 换成 `[[路径]]`，光标停在 `]]` 之后。
 *
 * ★ 只动**光标之前**：`[[查询` 后面可能还有别的内容（用户先写了后文再回头补链接），
 *   把它一起替换掉就是在删用户的字。
 * ★ 返回新值与新光标，而不是直接写 textarea：写回那一步要走 `execCommand` 保住
 *   撤销栈（`MiniMarkdownEditor.insertText` 的纪律），这里只负责"变成什么"。
 */
export function applyLinkSuggestion(
  value: string,
  caret: number,
  query: LinkQuery,
  candidate: LinkCandidate,
): { value: string; caret: number } {
  const insert = `[[${candidate.path}]]`;
  return {
    value: value.slice(0, query.start) + insert + value.slice(caret),
    caret: query.start + insert.length,
  };
}
