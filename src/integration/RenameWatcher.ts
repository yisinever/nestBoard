/**
 * 重命名跟随（T1.46）—— `F1.09` 的"外部重命名不打断白板"。
 *
 * 场景：白板的引用卡指向 `A.md`，用户在文件列表里把 `A.md` 改名为 `B.md`。
 * 不做任何事的话，卡片当场变成断链（T1.45 的断链态），用户得一张张手动重连 ——
 * 而 Obsidian 明明已经告诉我们"谁被改名成了谁"，只是没人听这个事件。
 *
 * 本文件做两件事，**刻意拆成纯函数 + 薄壳**：
 * - `retargetBoard` / `rewriteNoteLinks` 是纯函数：给定一个 `BoardFile`，
 *   就地改写所有指向旧路径的引用。可以在 node 下把各种脏数据喂进去测。
 * - `RenameWatcher` 只是"监听事件 → 遍历打开的白板 → 调纯函数"的接线，
 *   依赖两个窄接口（`RenameEventSource` / `RenameHost`），因此测试里不需要 Obsidian。
 *
 * ★ 为什么改写的是**打开的白板**而不是磁盘上的全部 `.nboard`：
 *   全部扫描意味着"改个名要读几百个文件"，而没打开的白板下次打开时会走
 *   `io/migrate.ts` 的同一条修复路径。只处理打开中的既够用又便宜。
 */

import type { BoardFile } from '../model/schema';
import type { MindFile } from '../mind/model/schema';

// ─────────────────────────────────────────────────────────────
// 纯函数
// ─────────────────────────────────────────────────────────────

/** `a/b/笔记.md` → `a/b/笔记` */
function stripExtension(path: string): string {
  return path.replace(/\.(md|markdown)$/i, '');
}

/** `a/b/笔记.md` → `笔记` */
function basename(path: string): string {
  const stripped = stripExtension(path);
  const slash = stripped.lastIndexOf('/');
  return slash === -1 ? stripped : stripped.slice(slash + 1);
}

// 组：1=`[[`或`![[`  2=目标  3=#定位（可空）  4=|别名（可空）  5=`]]`
const WIKILINK = /(!?\[\[)([^\]|#\n]+)((?:#[^\]|\n]*)?)((?:\|[^\]\n]*)?)(\]\])/g;
// 组：1=`](`  2=目标  3=`)`
const MARKDOWN_LINK = /(\]\()([^)\s\n]+)(\))/g;

/**
 * 把正文里指向 `oldPath` 的链接改写成 `newPath`。
 *
 * 认两种写法（Obsidian 两种都常见）：
 * - wikilink：`[[笔记]]`、`[[笔记#标题]]`、`[[笔记|别名]]`、`![[笔记]]`（内嵌）
 * - 标准链接：`[文字](folder/笔记.md)`、`![](img.png)`
 *
 * ★ 无路径的目标（`[[笔记]]`）只能靠**文件名**匹配 —— Obsidian 自己也这么干，
 *   所以"两个同名笔记"时会一起改。这是可接受的近似：宁可多改一处（用户能看见并撤销），
 *   也不要漏改导致断链。
 */
export function rewriteNoteLinks(markdown: string, oldPath: string, newPath: string): string {
  const oldTarget = stripExtension(oldPath);
  const oldName = basename(oldPath);
  const newTarget = stripExtension(newPath);

  const withWiki = markdown.replace(
    WIKILINK,
    (match, open: string, target: string, subpath: string, alias: string) => {
      const normalized = target.trim();
      // 带路径的目标必须整段相等；不带路径的按文件名匹配
      const hit =
        normalized === oldTarget || (normalized.indexOf('/') === -1 && normalized === oldName);
      if (!hit) return match;
      return `${open}${newTarget}${subpath}${alias}${']]'}`;
    },
  );

  return withWiki.replace(MARKDOWN_LINK, (match, open: string, target: string, close: string) => {
    const normalized = decodeURI(target.trim());
    // 标准链接既可能写全路径，也可能只写文件名（Obsidian 会按当前文件解析）
    const hit =
      normalized === oldPath ||
      stripExtension(normalized) === oldTarget ||
      (normalized.indexOf('/') === -1 && stripExtension(normalized) === oldName);
    if (!hit) return match;
    return `${open}${newPath}${close}`;
  });
}

/**
 * 就地改写一块白板里所有指向 `oldPath` 的引用。
 *
 * @returns 是否真的改了（`false` = 这块板与本文件无关，调用方不必写盘）
 */
export function retargetBoard(board: BoardFile, oldPath: string, newPath: string): boolean {
  if (oldPath.length === 0 || newPath.length === 0 || oldPath === newPath) return false;
  let changed = false;

  for (const card of board.cards) {
    switch (card.type) {
      // 这几种卡都是"指向一个 Vault 路径"（地图卡指向的是一张图片文件，T7.03）
      // ★ 这里**没有** `'mindRef'`：老脑图卡在读入口就被转成了白板级容器
      //   （`model/validate.mindFromLegacyCard`），内存里不可能有这种卡 ——
      //   它那条"跟着 `.nestmind` 改名走"的职责搬到了下面的 `board.minds`。
      case 'noteRef':
      case 'image':
      case 'file':
      case 'boardRef':
      case 'map':
        if (card.content.path === oldPath) {
          card.content.path = newPath;
          changed = true;
        }
        break;
      // 便签卡与同步便签（T7.04）的正文里都可能内联了 `[[链接]]`
      case 'note':
      case 'syncNote': {
        const next = rewriteNoteLinks(card.content.md, oldPath, newPath);
        if (next !== card.content.md) {
          card.content.md = next;
          changed = true;
        }
        break;
      }
      // 评论卡（T7.05）的每一条正文同样是 Markdown，一样可能内联 `[[链接]]` ——
      // 逐条改，而不是只改第一条或整篇当一段
      case 'comment': {
        for (const entry of card.content.entries) {
          const next = rewriteNoteLinks(entry.text, oldPath, newPath);
          if (next !== entry.text) {
            entry.text = next;
            changed = true;
          }
        }
        break;
      }
      default:
        break;
    }
  }

  // 白板级脑图（`2.2.0` 收尾 · 老卡类型退出）：两件事各改各的 ——
  // * **指向文件的树**（`path`）：改路径（这就是老 `mindRef` 卡原来那件事）；
  // * **内嵌的树**（`mind`）：改它里面的附件引用与内联链接（`retargetMind`，
  //   与 `.nestmind` 那条用的是同一份纯函数 —— 白板里的树与文件里的树是同一种内容）。
  // ★ 不补这一段的话：把一份 `.nestmind` 改个名，白板上那棵树就会指向一个不存在的文件
  //   （卡面写"找不到这份脑图文件"），而它**本来是好的**。
  for (const mind of board.minds ?? []) {
    if (mind.path === oldPath) {
      mind.path = newPath;
      changed = true;
    }
    if (mind.mind && retargetMind(mind.mind, oldPath, newPath)) changed = true;
  }

  // 嵌套白板的父指针
  if (board.meta.parent === oldPath) {
    board.meta.parent = newPath;
    changed = true;
  }

  return changed;
}

/**
 * 就地改写一份脑图里所有指向 `oldPath` 的引用。
 *
 * 改两处（`06 §6` 的"断链"那一行）：
 * - **节点的附件**（`refs[].path`）：回形针 / 图片块指向的那份文件；
 * - **正文**（`node.note`）：里面可能内联了 `[[链接]]`（与白板的便签卡同一条）。
 *
 * ★ 节点上那条**引用本身**不存标题（`refs` 只存路径，见 `model/refs.ts`）⇒
 *   路径一改，界面上的文件名跟着变，没有第二个地方要同步。
 * ★ 与 `retargetBoard` 逐条对齐：路径为空、没变化 ⇒ `false`（调用方不必写盘）。
 */
export function retargetMind(mind: MindFile, oldPath: string, newPath: string): boolean {
  if (oldPath.length === 0 || newPath.length === 0 || oldPath === newPath) return false;
  let changed = false;

  for (const node of mind.nodes) {
    for (const ref of node.refs ?? []) {
      if (ref.path === oldPath) {
        ref.path = newPath;
        changed = true;
      }
    }
    const next = rewriteNoteLinks(node.note, oldPath, newPath);
    if (next !== node.note) {
      node.note = next;
      changed = true;
    }
  }

  return changed;
}

// ─────────────────────────────────────────────────────────────
// 接线
// ─────────────────────────────────────────────────────────────

/** Vault 重命名事件源（生产实现：`vault.on('rename', …)`） */
export interface RenameEventSource {
  /** 订阅重命名；返回退订函数 */
  onRename(handler: (oldPath: string, newPath: string) => void): () => void;
}

/** 仓库的窄接口 —— 只用到这几件事，测试里给个几行的假对象即可 */
export interface RenameHost {
  /** 当前打开着的白板路径 */
  openPaths(): readonly string[];
  /** 就地改写；返回是否真的改了 */
  mutate(path: string, mutator: (board: BoardFile) => boolean): boolean;
  /**
   * 脑图那一半（`.nestmind`）—— **可选**：没接就只处理白板。
   *
   * ★ 做成可选而不是必填：`RenameWatcher` 先落地时只有白板（T1.46），
   *   而它的单测里那些假 host 也不必为了"多一类文档"重写一遍。
   */
  openMindPaths?(): readonly string[];
  /** 就地改写一份脑图；返回是否真的改了 */
  mutateMind?(path: string, mutator: (mind: MindFile) => boolean): boolean;
}

export class RenameWatcher {
  private disposers: Array<() => void> = [];

  constructor(private readonly host: RenameHost) {}

  start(source: RenameEventSource): void {
    this.stop();
    this.disposers.push(source.onRename((oldPath, newPath) => void this.handle(oldPath, newPath)));
  }

  stop(): void {
    for (const dispose of this.disposers.splice(0)) dispose();
    this.disposers.length = 0;
  }

  /**
   * 处理一次重命名：白板与脑图**各扫一遍**（两类文档的模型不同，纯函数也各有一份）。
   *
   * @returns 受影响的路径（白板 + 脑图，测试断言用，顺带方便将来打日志）
   */
  handle(oldPath: string, newPath: string): string[] {
    if (oldPath.length === 0 || newPath.length === 0 || oldPath === newPath) return [];
    const touched: string[] = [];

    for (const path of this.host.openPaths()) {
      try {
        if (this.host.mutate(path, (board) => retargetBoard(board, oldPath, newPath))) {
          touched.push(path);
        }
      } catch {
        // 只读 / 已关闭的白板：跳过，不能因为一块板写不进去就漏掉其余的
      }
    }

    // 脑图那一半（`.nestmind`）：同样的两件事，只是模型与纯函数各有一份。
    // ★ 没接这个通道就整段跳过（见 `RenameHost` 上那条"可选"的说明）
    if (this.host.mutateMind) {
      for (const path of this.host.openMindPaths?.() ?? []) {
        try {
          if (this.host.mutateMind(path, (mind) => retargetMind(mind, oldPath, newPath))) {
            touched.push(path);
          }
        } catch {
          // 同上：一份写不进去不该拖累其余的
        }
      }
    }

    return touched;
  }
}
