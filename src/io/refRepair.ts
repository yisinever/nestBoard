/**
 * 「修复引用」（T4.07 / `03 §9 R10`）：白板被复制 / 移动到另一个 Vault 之后，
 * 按**文件名**把断掉的引用重新接上。
 *
 * 引用卡里存的是 Vault 相对路径（`03 §2.2`），换一个 Vault 就等于所有附件的目录名
 * 都可能变（`assets/` → `attachments/`），路径全废、文件却还在。这一层负责回答
 * "那条失效的路径**最可能**变成了哪一条"，以及"用户点了确认之后怎么改模型"。
 *
 * 三条写死的取舍：
 *
 * 1. **只给建议，不自动改**。同名匹配是一个猜测，而猜错的代价比断链本身更高：
 *    断链是**看得见**的（卡片上有断链标记、总览里列得出来），
 *    指错文件的引用则长得完全正常 —— 用户会盯着别人的图以为自己在看这张。
 *    所以这里产出的是一份清单，改不改、改哪几处由用户在对话框里逐条确认。
 * 2. **档位分明，只有"同名"默认勾上**：`sameName` 基本等于"这个文件只是挪了个位置"，
 *    再往后的"忽略大小写 / 去掉空格下划线 / 名字很像"都只是猜测，默认不勾。
 * 3. **扩展名是一道硬闸门**：引用卡只接 `.md`、白板卡只接 `.nboard`、图片卡只接图片。
 *    少了这道闸门，`图.png` 断了之后会被 `图.md` 接走 —— 这比断链糟糕得多。
 *
 * ★ 不 import `obsidian`：库里有哪几千个文件由调用方（`vaultIO.listAll()`）喂进来，
 *   于是分档与判重的规则可以在 node 下逐条钉死。
 */

import { BOARD_EXT } from '../constants';
import { baseNameOf, extensionOf, IMAGE_EXTENSIONS, NOTE_EXTENSIONS } from '../model/drop';
import type { CardRef, RefKind } from '../model/links';
import type { BoardFile, Card } from '../model/schema';

/** 能靠文件名重连的引用种类。`link` 卡是 URL —— 它没有文件名，也就没有"同名文件"这回事 */
export type RepairableKind = Exclude<RefKind, 'link'>;

/**
 * 匹配档位，从可信到勉强：
 * * `sameName` —— 连大小写都一样。基本就是"文件挪了个位置"；
 * * `sameNameIgnoreCase` —— 只差大小写（换系统 / 换同步工具时常发生）；
 * * `normalizedName` —— 去掉空格、下划线、连字符后同名（`屏幕 截图.png` ↔ `屏幕截图.png`）；
 * * `similarName` —— 拼写相近（改名时漏字 / 多字）。**这一档几乎全是猜的**。
 */
export type MatchQuality = 'sameName' | 'sameNameIgnoreCase' | 'normalizedName' | 'similarName';

/** 档位排序：数字越小越可信 */
const QUALITY_RANK: Record<MatchQuality, number> = {
  sameName: 0,
  sameNameIgnoreCase: 1,
  normalizedName: 2,
  similarName: 3,
};

/**
 * 默认勾选的档位。**只有同名** —— 见文件头第 2 条。
 *
 * ★ 导出而不是让对话框自己再写一遍：这两个档位就是"这个功能敢替你下结论的部分"，
 *   定义只能有一处，否则将来放宽 / 收紧档位时必然漏改一边。
 */
export const DEFAULT_CHECKED_QUALITIES: readonly MatchQuality[] = [
  'sameName',
  'sameNameIgnoreCase',
];

/** 名字相似到多少才算"可能是同一个文件"。低于它宁可不提 —— 这档本来就是猜 */
const MIN_SIMILARITY = 0.8;

/** 一处断链 + 它的建议目标 */
export interface RefSuggestion {
  cardId: string;
  /** 卡片标题（空串 = 这张卡没标题，显示时用"未命名卡片"兜底） */
  cardTitle: string;
  kind: RepairableKind;
  /** 现在指向的、已经失效的路径 */
  brokenPath: string;
  /** 建议改成的路径 */
  nextPath: string;
  quality: MatchQuality;
  /**
   * 同档位的**其他**候选数量。
   *
   * ★ 只报个数、不做下拉选择：同名文件多于一个时，"哪个才对"只有用户知道，
   *   而挑错文件的代价是静默指错（见文件头）。让他知道"不是唯一解"就够了 ——
   *   真要精确指定，卡片右键的「重新链接」本来就是干这个的。
   */
  alternatives: number;
}

export interface RefRepairPlan {
  /** 按可信度排好的建议 */
  suggestions: RefSuggestion[];
  /** 确实断了、但库里找不到任何候选的引用（原样列出，让用户知道这些修不了） */
  unmatched: CardRef[];
}

/** 用户勾选后要落地的改动。`brokenPath` 是**期望中的旧值**，见 {@link applyRefRepairs} */
export interface RefRepair {
  cardId: string;
  brokenPath: string;
  nextPath: string;
}

/** 库里所有文件的索引（按同名 / 规范化名分桶，避免每个断链都扫一遍全库） */
interface FileIndex {
  /** 小写 basename → 路径 */
  byLowerName: Map<string, string[]>;
  /** 规范化 stem + 扩展名 → 路径 */
  byNormName: Map<string, string[]>;
  /** 全部条目（只有前两档都落空时才会被线性扫一遍，用于相似名） */
  all: IndexedFile[];
}

interface IndexedFile {
  path: string;
  /** 规范化后的 stem（不含扩展名、无空格下划线连字符、小写） */
  normStem: string;
  /** 小写扩展名，不含点；`''` = 没有扩展名 */
  ext: string;
}

/**
 * 规划：每条断链找出**一个**最可能的目标。
 *
 * `files` 是库里的全部文件路径（`vaultIO.listAll()`）。传全量而不是"某个目录"：
 * 跨 Vault 迁移之后用户往往重新整理了目录结构，把范围限定在旧目录里恰好会漏掉目标。
 */
export function planRefRepairs(
  broken: readonly CardRef[],
  files: readonly string[],
): RefRepairPlan {
  const index = buildIndex(files);
  const suggestions: RefSuggestion[] = [];
  const unmatched: CardRef[] = [];

  for (const ref of broken) {
    if (ref.kind === 'link') continue; // 调用方已过滤；这里再挡一道，别让 URL 混进名单
    const found = bestMatch(ref, index);
    if (found === null) {
      unmatched.push(ref);
      continue;
    }
    suggestions.push(found);
  }

  suggestions.sort(
    (a, b) =>
      QUALITY_RANK[a.quality] - QUALITY_RANK[b.quality] ||
      a.brokenPath.localeCompare(b.brokenPath) ||
      a.cardId.localeCompare(b.cardId),
  );
  return { suggestions, unmatched };
}

/**
 * 把改动落进模型，返回**真正改掉的条数**。
 *
 * ★ 逐条比对"卡片此刻还指着那条失效路径吗"：对话框是异步的，用户完全可能
 *   在打开它的同时撤销了一步、或者自己重新链接过。少了这个比对，
 *   一次过期的确认会把已经修好的路径**打回旧值** —— 而旧值仍然不存在。
 *   这和 `handleExternalModify` 的乐观并发检查是同一条纪律。
 *
 * 只改 `path`；`noteRef` 的 `subpath`（`#标题`）原样保留 —— 新文件里可能没有那个标题，
 * 但那属于"去卡片上看一眼"的事，不该在这里瞎猜着清掉。
 */
export function applyRefRepairs(board: BoardFile, repairs: readonly RefRepair[]): number {
  if (repairs.length === 0) return 0;
  const byCard = new Map<string, RefRepair>();
  for (const repair of repairs) byCard.set(repair.cardId, repair);

  let applied = 0;
  for (const card of board.cards) {
    const repair = byCard.get(card.id);
    if (!repair) continue;
    const content = refContentOf(card);
    if (content === null || content.path !== repair.brokenPath) continue;
    content.path = repair.nextPath;
    applied += 1;
  }
  return applied;
}

/**
 * 取卡片里那个"存路径的可写字段"。
 *
 * 四种引用卡（引用 / 图片 / 文件 / 白板）的 `content` 都有一个 `path: string`，
 * 于是"赋值"可以只写一处 —— 而不是四个分支各写一遍（漏一个分支的表现是
 * "某种卡的断链怎么修都修不好"）。其余类型返回 `null`，它们的引用本来就不该出现在名单里。
 */
function refContentOf(card: Card): { path: string } | null {
  switch (card.type) {
    // 地图卡（T7.03）指向的也是一张图片：它在 `refsOfCard` 里的 kind 就是 `image`，
    // 漏掉这一行的话它会出现在断链名单里、却永远修不好（正是上面那段注释警告的情况）
    case 'image':
    case 'file':
    case 'noteRef':
    case 'boardRef':
    case 'map':
      return card.content;
    case 'note':
    case 'todo':
    case 'swatch':
    case 'link':
    case 'ink':
    case 'syncNote':
    case 'comment':
      return null;
    default:
      return null;
  }
}

function buildIndex(files: readonly string[]): FileIndex {
  const byLowerName = new Map<string, string[]>();
  const byNormName = new Map<string, string[]>();
  const all: IndexedFile[] = [];

  for (const path of files) {
    const name = baseNameOf(path);
    const ext = extensionOf(path);
    const entry: IndexedFile = { path, normStem: normalizeStem(stemOf(name, ext)), ext };
    all.push(entry);

    push(byLowerName, name.toLowerCase(), path);
    // 键里带上扩展名：规范化档位不允许跨扩展名（见文件头第 3 条）
    push(byNormName, `${entry.normStem}.${ext}`, path);
  }
  return { byLowerName, byNormName, all };
}

function push(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function bestMatch(ref: CardRef, index: FileIndex): RefSuggestion | null {
  const kind = ref.kind as RepairableKind;
  const name = baseNameOf(ref.path);
  const candidates = collectCandidates(ref, kind, index, name);

  if (candidates.length === 0) return null;

  // 同档位里有多个时：优先"和旧路径在同一个目录"的那个（文件多半只是被挪了个位置），
  // 其余按路径字典序 —— 顺序必须**确定**，否则同一份输入两次打开会给出不同建议
  const dir = folderOf(ref.path);
  candidates.sort(
    (a, b) =>
      QUALITY_RANK[a.quality] - QUALITY_RANK[b.quality] ||
      Number(folderOf(b.path) === dir) - Number(folderOf(a.path) === dir) ||
      a.path.localeCompare(b.path),
  );

  const chosen = candidates[0];
  const sameQuality = candidates.filter((item) => item.quality === chosen.quality).length;
  return {
    cardId: ref.cardId,
    cardTitle: ref.cardTitle,
    kind,
    brokenPath: ref.path,
    nextPath: chosen.path,
    quality: chosen.quality,
    alternatives: sameQuality - 1,
  };
}

/** 按档位从可信到勉强依次尝试，**命中一档就不再往下一档看**（避免低档位抢答） */
function collectCandidates(
  ref: CardRef,
  kind: RepairableKind,
  index: FileIndex,
  name: string,
): Array<{ path: string; quality: MatchQuality }> {
  const found: Array<{ path: string; quality: MatchQuality }> = [];
  const isUsable = (path: string): boolean => path !== ref.path && kindAccepts(kind, path);

  for (const path of index.byLowerName.get(name.toLowerCase()) ?? []) {
    if (!isUsable(path)) continue;
    found.push({ path, quality: baseNameOf(path) === name ? 'sameName' : 'sameNameIgnoreCase' });
  }
  if (found.length > 0) return found;

  const ext = extensionOf(ref.path);
  const normStem = normalizeStem(stemOf(name, ext));
  for (const path of index.byNormName.get(`${normStem}.${ext}`) ?? []) {
    if (!isUsable(path)) continue;
    found.push({ path, quality: 'normalizedName' });
  }
  if (found.length > 0) return found;

  const similar = bestSimilar(ref.path, kind, index, normStem, ext);
  if (similar !== null) found.push({ path: similar, quality: 'similarName' });
  return found;
}

/**
 * 名字相近的那一档。**只在前面几档全空时才跑**，并且限定"同扩展名 + 长度相差不超过 2"：
 * 这是一个 O(库里文件数) 的线性扫描，而且它给出的结论本来就最弱 ——
 * 没必要为它让每次打开名单都多花几十毫秒。
 */
function bestSimilar(
  brokenPath: string,
  kind: RepairableKind,
  index: FileIndex,
  normStem: string,
  ext: string,
): string | null {
  if (normStem.length === 0) return null;
  let bestPath: string | null = null;
  let bestScore = 0;

  for (const file of index.all) {
    if (file.ext !== ext) continue;
    if (file.path === brokenPath || !kindAccepts(kind, file.path)) continue;
    if (Math.abs(file.normStem.length - normStem.length) > 2) continue;

    const score = stemSimilarity(file.normStem, normStem);
    if (score < MIN_SIMILARITY) continue;
    // 分数相同时按路径字典序定一个胜者：建议必须可复现
    if (score > bestScore || (score === bestScore && bestPath !== null && file.path < bestPath)) {
      bestScore = score;
      bestPath = file.path;
    }
  }
  return bestPath;
}

/**
 * 卡片的种类能不能接住这个文件（文件头第 3 条那道闸门）。
 *
 * `file` 卡不设限：它本来就是"任意文件"（双击交给系统应用打开），
 * 按 basename 匹配时扩展名已经天然一致了 —— 留一道限制只会让它少修几种情况。
 */
function kindAccepts(kind: RepairableKind, path: string): boolean {
  const ext = extensionOf(path);
  switch (kind) {
    case 'noteRef':
      return NOTE_EXTENSIONS.includes(ext);
    case 'boardRef':
      return ext === BOARD_EXT;
    case 'image':
      return IMAGE_EXTENSIONS.includes(ext);
    case 'file':
      return true;
    default:
      return false;
  }
}

/** `a/b/图.png` → `a/b`（无目录 → `''`） */
function folderOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}

/** 去掉扩展名。`ext` 由 `extensionOf` 给出（小写、无点、可能与原名大小写不同） */
function stemOf(name: string, ext: string): string {
  return ext.length === 0 ? name : name.slice(0, name.length - ext.length - 1);
}

/**
 * 规范化文件名主干：小写 + 去掉空白与 `_` / `-` / `·`。
 *
 * ★ 数字**不**去掉：Obsidian 与各种同步工具都会用" 1"、" 2" 给重名文件让路
 *   （`图.png` / `图 1.png`），那是**两份不同的文件**。归一到同一个名字，
 *   等于把用户明确分开放的两份东西混成一份。
 */
function normalizeStem(stem: string): string {
  return stem.toLowerCase().replace(/[\s\u3000_\-·]/g, '');
}

/** 1 - 编辑距离 / 较长长度。用于"漏字 / 多字"这类改名 */
function stemSimilarity(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 1;
  return 1 - editDistance(a, b) / longest;
}

/** 经典 Levenshtein，滚动数组。名字都很短，不必上更复杂的算法 */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        previous[j] + 1, // 删
        current[j - 1] + 1, // 增
        previous[j - 1] + cost, // 改
      );
    }
    previous = current;
  }
  return previous[b.length];
}
