/**
 * 白板列表的**分组与筛选逻辑**（T5.08 / `F7-04`）。
 *
 * 侧栏「白板列表」有三种看法：**目录树** / **按标签** / **按最近打开**。
 * 三种都是"同一份白板、换个方式分组"，所以全做成纯函数放在这里，
 * `ui/BoardListPanel.ts` 只负责把它们画出来、把点击接上。
 *
 * ★ 零 `obsidian` 依赖：排序与分组错了，用户看到的是"列表顺序莫名其妙"，
 *   在真机上既难看出来也难复现 —— 必须能在 node 下喂数据直接断言。
 *
 * ★ 入参用的是**结构化类型** `BoardListItem` 而不是 `io/BoardRegistry` 的 `BoardEntry`：
 *   这里只需要三个字段，绑上 `BoardEntry` 会让"多了一个字段就要改这里"成为常态，
 *   也让测试得凭空造出一个完整条目（含 `cardCount` 之类与列表无关的东西）。
 */

/** 列表用得到的白板信息。`BoardEntry` 天然满足这个形状，直接传进来即可 */
export interface BoardListItem {
  /** Vault 相对路径（含扩展名）。**唯一标识**，也是"最近打开"对齐用的键 */
  path: string;
  /** 显示名（文件名去扩展名，见 `io/BoardRegistry`） */
  title: string;
  /** 白板级标签（T5.06 起从 frontmatter 里读，`F7-09`）。**不含 `#`** */
  tags: readonly string[];
}

/** 侧栏的三种看法 */
export type BoardListView = 'folders' | 'recent' | 'tags';

/** 目录树的一个节点。根节点是 `name === ''` / `path === ''` 的那一个 */
export interface BoardFolderNode {
  /** 目录名。根是 `''` */
  name: string;
  /** 目录的 Vault 相对路径。根是 `''` */
  path: string;
  folders: BoardFolderNode[];
  boards: BoardListItem[];
}

/** 「按标签」里的一组 */
export interface BoardTagGroup {
  /** `null` = **没打标签**的那一组。它永远排在最后 */
  tag: string | null;
  boards: BoardListItem[];
}

/**
 * 目录树。空目录**不会**出现 —— 只沿着"有白板的路径"建节点，
 * 一棵只在叶子上有东西的树比"把整个 Vault 的目录结构都画出来"有用得多。
 *
 * ★ 排序在**每一层**都做（目录按名、白板按标题）：`BoardRegistry.all()` 是按
 *   `updatedAt` 倒序给的（"最近改的在前"），直接拿来建树会让目录里的顺序
 *   随着每次保存而重排 —— 用户刚点过的那一行会跳走。
 */
export function buildFolderTree(items: readonly BoardListItem[]): BoardFolderNode {
  const root: BoardFolderNode = { name: '', path: '', folders: [], boards: [] };
  /** 目录路径 → 节点。建树时靠它做 O(1) 的"这一层已经建过了吗" */
  const byPath = new Map<string, BoardFolderNode>([['', root]]);

  for (const item of items) {
    const segments = item.path.split('/').filter((segment) => segment.length > 0);
    segments.pop(); // 最后一段是文件名，不是目录

    let parent = root;
    let dir = '';
    for (const segment of segments) {
      dir = dir === '' ? segment : `${dir}/${segment}`;
      let node = byPath.get(dir);
      if (!node) {
        node = { name: segment, path: dir, folders: [], boards: [] };
        byPath.set(dir, node);
        parent.folders.push(node);
      }
      parent = node;
    }
    parent.boards.push(item);
  }

  sortTree(root);
  return root;
}

/**
 * 「按最近打开」。
 *
 * ★ 必须拿 `recentPaths` 去 `items` 里**逐条核对**，而不是直接把 `recentPaths` 画出来：
 *   那份历史是插件自己攒的，里面的路径早被改名 / 删除 / 移出库都是常态
 *   （Obsidian 的改名不会通知插件的历史列表）。照单全收的话，"最近打开"里
 *   会出现一排点开就报"文件不存在"的行。查不到的**静默跳过**。
 *
 * ★ 顺序完全由 `recentPaths` 决定，**不按 `updatedAt` 重排** —— 用户点的是"最近打开"，
 *   他期待的就是"我刚看过的那几块按看过的顺序摆着"。
 */
export function recentBoards(
  items: readonly BoardListItem[],
  recentPaths: readonly string[],
): BoardListItem[] {
  const byPath = new Map(items.map((item) => [item.path, item] as const));
  const seen = new Set<string>();
  const out: BoardListItem[] = [];

  for (const path of recentPaths) {
    if (seen.has(path)) continue;
    seen.add(path);
    const item = byPath.get(path);
    if (item) out.push(item);
  }
  return out;
}

/**
 * 「按标签」。
 *
 * ★ 一块板打了多个标签，就会在**每一组里各出现一次** —— 这不是重复，
 *   是"按标签看"这件事的定义本身（跟文件管理器里同一份文件出现在多个软链接目录下同理）。
 *   想找那块板时，从任一标签走进去都能找到它。
 *
 * ★ 没打标签的那一组**排在最后**：它是一个"待办"性质的桶（这些板还没被归类），
 *   不该插在 `#项目` 和 `#资料` 中间打乱字母序。
 */
export function groupByTag(
  items: readonly BoardListItem[],
  /**
   * 这块板上**卡内**写过的标签（`F1` 追记：侧栏标签面板）。
   *
   * ★ 为什么要有第二个来源：`item.tags` 是白板级 `meta.tags`（"这块板是什么"），
   *   而用户真正天天写的是**卡片正文里的 `#标签`** —— 只看前者的话，
   *   在便签里写了十个 `#纪要` 的板在"按标签"里是**未加标签**，面板等于白给。
   * ★ 缺席 = 只按白板级标签分组（老调用方 / 测试一个字都不用改）。
   */
  cardTagsOf?: (path: string) => readonly string[],
): BoardTagGroup[] {
  const groups = new Map<string, BoardListItem[]>();
  const untagged: BoardListItem[] = [];

  for (const item of items) {
    // 同一块板里写了两遍同一个标签（复制粘贴的产物）只算一次
    const tags = new Set([
      ...item.tags.map((tag) => tag.trim()),
      ...(cardTagsOf?.(item.path) ?? []).map((tag) => tag.trim()),
    ]);
    tags.delete('');
    if (tags.size === 0) {
      untagged.push(item);
      continue;
    }
    for (const tag of tags) {
      const bucket = groups.get(tag);
      if (bucket) bucket.push(item);
      else groups.set(tag, [item]);
    }
  }

  const out: BoardTagGroup[] = [...groups.entries()]
    .sort(([a], [b]) => compareText(a, b))
    .map(([tag, boards]) => ({ tag, boards: [...boards].sort(compareBoards) }));

  if (untagged.length > 0) {
    out.push({ tag: null, boards: untagged.sort(compareBoards) });
  }
  return out;
}

/**
 * 筛选：空查询原样放行（**连顺序都不动**）。
 *
 * 查询按空白切成几个词，**每个词都要命中**（AND）。这样"研究 会议"能同时
 * 收敛到那个二级目录下的板，而不必写成一整串。
 *
 * ★ 匹配的是 **标题 + 路径**，所以按目录名筛也是通的 —— 用户想"只看 `Boards/项目A/` 底下的板"
 *   时，直觉就是敲 `项目A`，而不是先去目录树里展开那一层。
 */
export function filterBoards<T extends BoardListItem>(items: readonly T[], query: string): T[] {
  const terms = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 0);
  if (terms.length === 0) return [...items];

  return items.filter((item) => {
    const haystack = `${item.title}\n${item.path}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

/** 递归排序：目录按名、白板按标题，每一层都排 */
function sortTree(node: BoardFolderNode): void {
  node.folders.sort((a, b) => compareText(a.name, b.name));
  node.boards.sort(compareBoards);
  for (const child of node.folders) sortTree(child);
}

/**
 * 白板排序：标题优先，**路径兜底**。
 *
 * ★ 兜底是必须的：同一目录下 `未命名.nboard` 和 `未命名 2.nboard` 的标题排序是确定的，
 *   但"`Boards/A/x.nboard` 与 `Boards/B/x.nboard` 同时出现在同一个标签组里"时
 *   标题完全相同 —— 没有兜底，两者的先后就取决于 `Array.prototype.sort` 的稳定性
 *   和输入顺序，表现为"列表偶尔自己换位置"。
 */
function compareBoards(a: BoardListItem, b: BoardListItem): number {
  const byTitle = compareText(a.title, b.title);
  return byTitle !== 0 ? byTitle : comparePaths(a.path, b.path);
}

/**
 * 人眼顺序：`2` 排在 `10` 前面（`numeric`），大小写不敏感（`sensitivity: 'base'`）。
 *
 * ★ `localeCompare` 而不是 `<`：后者按码位比，`Z` 会排在 `a` 前面，中文则完全乱序 ——
 *   这正是资源管理器里那种"顺序看着没道理"的来源。
 */
function compareText(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

/**
 * 路径排序：**故意**用码位比较，不套 `localeCompare`。
 *
 * ★ 它的职责只是"给标题相同的两个条目一个稳定且确定的先后"，
 *   不需要符合人眼习惯；而 `localeCompare` 在本机 locale 不同时可能给出不同结果，
 *   那反而会让测试在不同机器上飘。
 */
function comparePaths(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
