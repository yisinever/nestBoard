/**
 * 索引笔记同步（T7.01 / `F10-09` + `F7-09`）。
 *
 * 渲染规则全在 `model/indexNote.ts`（纯函数，可单测）；本文件只管**什么时候写、
 * 写到哪个路径、以及什么时候绝对不写**。
 *
 * ## 三件事决定了这里的形状
 *
 * **① 自动保存会不停地叫它。** 一块板每次保存都会触发一次同步（加一张卡、改一个字
 * 都算）。所以正确性之外的第一目标是**最小化写盘**：先读一眼目标文件，
 * 内容一样就返回，**不写**；只有真不一样才落笔。
 *
 * > 这里刻意**不**做"上次写了什么"的内存缓存来省掉那次读。缓存看着更省，
 * > 但它有一个很难解释的后果：用户在索引笔记里手动改了一句，只要白板内容没再变过，
 * > 那句改动就**永远**不会被纠正 —— 而 frontmatter 里的字段是 Dataview 查询的依据，
 * > 一份悄悄偏离事实的 frontmatter 比多一次写盘坏得多。读走的是 Obsidian 的内容缓存
 * > （`cachedRead`），本来也不碰磁盘。省下的是磁盘 IO，丢掉的是一致性。
 *
 * **② 用户的文件比我们的索引笔记重要。** 落笔之前一定先读一遍目标文件：
 *  * 文件不在 → `create`；
 *  * 在、且**带生成物标记** → 覆盖（它是我们的，随时可重建）；
 *  * 在、但**不带标记** → 跳过并记进 `conflicts()`，一个字都不动。
 *  用户很可能恰好有一份叫 `周报.md` 的笔记，而我们算出来的目标路径正是它。
 *  在这种时刻，"少生成一份索引笔记"是唯一可接受的结果。
 *
 * **③ 删除只针对长得像我们的文件。** 白板被删 / 改名 / 索引目录被改时，旧笔记要收掉。
 *  收之前同样先读、先认标记。这保证了一条可以对外承诺的性质：
 *  **这个插件只会删除自己生成的文件。**
 *
 * ## 删除与开关解耦
 *
 * `removeBoard` / `cleanup` / `removeAll` **不看** `enabled()`：开关管的是"要不要生成"，
 * 而一份指向已删白板的笔记是**坏数据**（图谱里留着一条通向不存在笔记的边）。收掉它不需要用户
 * 先想起那个开关 —— 反过来，若先检查开关，用户"关掉开关 → 删白板 → 再打开开关"
 * 之后就会看到一份永远清不掉的残骸。
 *
 * 但**生成**严格看开关：任何一个写入口在开关关闭时都直接返回 `disabled`。
 *
 * ## 防抖
 *
 * 自动保存路径（`scheduleSync`）攒够 `debounceMs` 再落盘。这不是性能优化而是
 * **必要**的：每次保存都会把 `updatedAt` 写进 frontmatter，不防抖就是"打字期间
 * 每秒两次写盘"，图谱与 Dataview 跟着重算两次，用户的库一直在抖。
 * 用户**停止输入**两秒后才会写一次。
 *
 * ## 让出主线程
 *
 * `syncAll` 按 `chunkSize` 分片，片与片之间 `scheduleIdle`。几千块板的库里，
 * 「重建索引笔记」是一条用户按下之后还要继续用 Obsidian 的命令。
 *
 * 模块约束：**不 import `obsidian`**，可直接在 node 下单测（`03 §7.2`）。
 */

import {
  indexNoteBoardOf,
  indexNotePathOf,
  isIndexNote,
  renderIndexNote,
} from '../model/indexNote';
import type { IndexNoteLink } from '../model/indexNote';
import { debounce } from '../util/debounce';
import type { Debounced } from '../util/debounce';
import { describeError } from '../util/errors';

/** 白板元信息（`BoardRegistry` 提供；`F7-09` 的 frontmatter 就是照它写的） */
export interface IndexNoteEntry {
  title: string;
  /** 白板级标签（`meta.tags`），**不是**便签里的行内标签 —— 见下方 `linksOf` 的说明 */
  tags: readonly string[];
  /**
   * 卡片数；`null` = 还没统计过（`BoardRegistry` 的卡片数是**懒加载**的）。
   *
   * ★ 注入方（`main.ts`）**不要**在这里顺手 `await ensureCardCount()` 把它补全：
   *   那等于"为了生成一份索引笔记，把每一块板的 JSON 都读一遍解析一遍"，
   *   正是 `R4` 当初拒绝在启动时做的事。见 `model/indexNote.ts` 的同名字段。
   */
  cardCount: number | null;
  /** ISO 串；空串 = 不写这一栏 */
  updatedAt: string;
}

/**
 * 同步桥依赖的外部能力。
 *
 * ★ 全部由 `main.ts` 注入，本文件不认识 `App` / `Vault` / `TFile`。
 *   这样"什么时候写、什么时候不写"这条最容易出错的逻辑可以在 node 下逐条钉死。
 */
export interface IndexNotePorts {
  /** 开关（每次现取：用户拨了开关不必重建 bridge） */
  enabled: () => boolean;
  /** 索引目录（每次现取，理由同上） */
  folder: () => string;
  /** 库里的全部白板路径 */
  listBoards: () => Promise<string[]>;
  /** 读文件；不存在 → `null`（也接受"直接抛"，见 `readIfPresent`） */
  read: (path: string) => Promise<string | null>;
  create: (path: string, content: string) => Promise<void>;
  /** 覆盖写（生产实现走 `process` 做原子替换） */
  write: (path: string, content: string) => Promise<void>;
  /** 删除（生产实现：进回收站，不是真删） */
  remove: (path: string) => Promise<void>;
  /**
   * 列出 `folder` 之下**由本插件生成的**索引笔记路径。
   *
   * ★ 生产实现走 `metadataCache` 的 frontmatter（认 `nestboard-board` 那一栏），
   *   **一个文件都不读** —— 这个接口会在"迁移目录 / 清理"时被调到，
   *   而那时我们只知道一个目录名，不知道里面哪个文件是我们的。
   * ★ 拿到的清单仍然要逐个读一遍、认标记才删（`removeNote`）：
   *   frontmatter 是**线索**，标记才是**证据**。
   */
  listIndexNotes: (folder: string) => Promise<string[]>;
  /** 白板元信息；不在注册表里 → `null`（此时**不生成**，见 `syncBoard`） */
  entryOf: (boardPath: string) => IndexNoteEntry | null;
  /**
   * 这块板的内联出链（`LinkIndex.linksOf`）。
   *
   * ★ 注意只取**便签卡正文里**的链接（那是 `F10-09` 要救的东西）。白板的
   *   `meta.tags` 走 `entryOf`，两者不要混：白板的标签说的是"这块板是什么"，
   *   便签里的标签说的是"某张卡提到了什么"，合成一份 frontmatter 会让 `tag:`
   *   查询把"含有一张提到 X 的卡"的板也算成 X。
   */
  linksOf: (boardPath: string) => readonly IndexNoteLink[];
  /** `obsidian://nestboard?file=…`；缺省时不写「打开这块白板」那一行 */
  boardUri?: (boardPath: string) => string;
  /** 让出主线程的方式（测试注入点）。默认 `requestIdleCallback` → `setTimeout` 兜底 */
  scheduleIdle?: (task: () => void) => void;
  /** 每片处理多少块板（默认 20） */
  chunkSize?: number;
  /** 自动保存路径的写盘防抖（ms，默认 2000） */
  debounceMs?: number;
}

/** 一轮同步的账（命令的回执文案直接读它） */
export interface IndexNoteStats {
  written: number;
  unchanged: number;
  removed: number;
  skipped: number;
  failed: number;
}

export type IndexNoteSyncOutcome =
  | 'written'
  | 'unchanged'
  /** 不该写：开关关着、注册表里没有这块板、或目标路径被用户文件占着 */
  | 'skipped'
  | 'disabled'
  | 'failed';

const DEFAULT_CHUNK_SIZE = 20;
const DEFAULT_DEBOUNCE_MS = 2000;
const IDLE_TIMEOUT_MS = 500;

export class IndexNoteBridge {
  /** 攒着还没同步的白板（自动保存路径） */
  private readonly pending = new Set<string>();
  /**
   * 目标路径被非生成物占着的笔记。
   *
   * ★ 字段名叫 `conflictPaths` 而不是 `conflicts`：下面有一个 `conflicts()` 方法，
   *   同名的话构造函数里的字段初始化会把原型上的方法**盖掉**（`bridge.conflicts()`
   *   运行时变成"Set is not a function"），而 TS 只在严格检查时报重复标识符。
   */
  private readonly conflictPaths = new Set<string>();
  private readonly debouncedDrain: Debounced;
  private disposed = false;

  constructor(private readonly ports: IndexNotePorts) {
    this.debouncedDrain = debounce(
      () => void this.drainPending(),
      this.ports.debounceMs ?? DEFAULT_DEBOUNCE_MS,
    );
  }

  /** 攒着还没落盘的白板数（测试与诊断用） */
  get pendingCount(): number {
    return this.pending.size;
  }

  /** 因为"目标路径已被非生成物占用"而跳过的笔记路径（已排序） */
  conflicts(): string[] {
    return [...this.conflictPaths].sort((a, b) => a.localeCompare(b));
  }

  // ── 写 ─────────────────────────────────────────────────────

  /**
   * 同步一块板。
   *
   * 幂等：读一眼目标文件，内容一致就什么都不做。所以它同时承担两个角色 ——
   * 自动保存之后的"跟上"，以及「重建索引笔记」命令里的"补齐"（用户手动删掉的
   * 笔记会在这里被重新生成，因为读不到就是读不到）。
   */
  async syncBoard(boardPath: string): Promise<IndexNoteSyncOutcome> {
    if (this.disposed || !this.ports.enabled()) return 'disabled';

    const entry = this.ports.entryOf(boardPath);
    // ★ 注册表里没有这块板：不拿文件名凑一个标题写出去。
    //   凑出来的那份是"卡片数 0、标题是文件名"的错数据，而它下一次同步又会被真数据
    //   覆盖 —— 平白多一次写盘、一次文件事件、以及一瞬间的错信息
    if (!entry) return 'skipped';

    const notePath = indexNotePathOf(boardPath, this.ports.folder());
    const content = renderIndexNote({
      boardPath,
      title: entry.title,
      tags: entry.tags,
      cardCount: entry.cardCount,
      updatedAt: entry.updatedAt,
      links: this.ports.linksOf(boardPath),
      boardUri: this.ports.boardUri?.(boardPath) ?? '',
    });

    try {
      const existing = await this.readIfPresent(notePath);

      if (existing === null) {
        await this.ports.create(notePath, content);
        this.conflictPaths.delete(notePath);
        return 'written';
      }

      // ★ 全文里唯一一处"认领一个文件"的地方，也是"绝不覆盖用户文件"唯一的执行点
      if (!isIndexNote(existing)) {
        this.conflictPaths.add(notePath);
        return 'skipped';
      }

      if (existing === content) return 'unchanged';

      await this.ports.write(notePath, content);
      this.conflictPaths.delete(notePath);
      return 'written';
    } catch (error) {
      console.warn(`[nestboard] 写入索引笔记失败：${notePath}`, describeError(error));
      return 'failed';
    }
  }

  /**
   * 攒一下再同步（自动保存走这里）。
   *
   * 同一个板连着攒多次只算一次；攒着的时候白板又改了，也只按"最后一次的样子"写一遍。
   */
  scheduleSync(boardPath: string): void {
    if (this.disposed || !this.ports.enabled()) return;
    this.pending.add(boardPath);
    this.debouncedDrain();
  }

  /** 把攒着的改动立刻落盘（`onunload`、切目录、测试用） */
  async drain(): Promise<void> {
    this.debouncedDrain.cancel();
    await this.drainPending();
  }

  /**
   * 全量同步：让磁盘上"正好"是每块板该有的那份索引笔记。
   *
   * 走的是同一个幂等的 `syncBoard`，所以被手动删掉的笔记会被重建，
   * 而内容没变的不会产生任何写盘。
   */
  async syncAll(): Promise<IndexNoteStats> {
    const stats = emptyStats();
    if (this.disposed || !this.ports.enabled()) return stats;

    let boards: string[];
    try {
      boards = await this.ports.listBoards();
    } catch (error) {
      console.warn('[nestboard] 列不出白板，本轮索引笔记同步跳过', describeError(error));
      return stats;
    }

    const chunkSize = Math.max(1, this.ports.chunkSize ?? DEFAULT_CHUNK_SIZE);
    for (let index = 0; index < boards.length; index += chunkSize) {
      for (const boardPath of boards.slice(index, index + chunkSize)) {
        tally(stats, await this.syncBoard(boardPath));
      }
      // 片与片之间让出主线程：几千块板的库里，这条命令不该把界面按住几秒
      if (index + chunkSize < boards.length) await this.yieldIdle();
    }
    return stats;
  }

  // ── 收 ─────────────────────────────────────────────────────

  /** 白板没了：把它那份索引笔记收掉。**不看开关**（理由见文件头） */
  async removeBoard(boardPath: string): Promise<boolean> {
    if (this.disposed) return false;
    // 先把攒着的同步取消掉：不然防抖一触发，笔记就被刚删掉的那块板重新长出来
    this.pending.delete(boardPath);
    return this.removeNote(indexNotePathOf(boardPath, this.ports.folder()));
  }

  /**
   * 白板改名 / 移动：新位置写一份，旧位置那份收掉。
   *
   * ★ 只有新的那份**真的就位**了才收旧的。否则"刚改完名、注册表还没跟上"的那一瞬间
   *   会把索引笔记整个弄丢（而不是暂时缺一份）。
   */
  async renameBoard(oldPath: string, newPath: string): Promise<boolean> {
    if (this.disposed) return false;
    this.pending.delete(oldPath);
    const outcome = await this.syncBoard(newPath);
    if (outcome !== 'written' && outcome !== 'unchanged') return false;
    return this.removeBoard(oldPath);
  }

  /**
   * 索引目录改了：新目录写一遍、旧目录那份收掉。
   *
   * ★ 不做这件事的话，用户改完目录会看到**两份**一模一样的索引笔记，图谱里同一条边
   *   出现两次 —— 而用户完全不知道其中一份是上一秒的自己留下的。
   */
  async relocate(oldFolder: string): Promise<IndexNoteStats> {
    const stats = await this.syncAll();
    if (this.disposed || !this.ports.enabled()) return stats;
    stats.removed += await this.removeUnder(oldFolder);
    return stats;
  }

  /**
   * 清理：索引目录里那些"白板已经不在"的笔记。
   *
   * ★ 这条**不看开关**（用户关掉开关后正是最需要它的时候），也**不删白板**，
   *   只删带生成物标记的 .md，且删除走回收站。调用方负责先给用户一次确认。
   */
  async cleanup(): Promise<IndexNoteStats> {
    const stats = emptyStats();
    if (this.disposed) return stats;

    const folder = this.ports.folder();
    let live: Set<string>;
    try {
      live = new Set(await this.ports.listBoards());
    } catch (error) {
      console.warn('[nestboard] 列不出白板，清理跳过', describeError(error));
      return stats;
    }

    for (const notePath of await this.listIndexNotesSafe(folder)) {
      const boardPath = indexNoteBoardOf(notePath, folder);
      // 反推不出白板路径 = 不是按我们的规则生成的东西：不动它（宁可漏，不可误删）
      if (boardPath === null || live.has(boardPath)) continue;
      if (await this.removeNote(notePath)) stats.removed += 1;
    }
    return stats;
  }

  /**
   * 整体撤销：收掉索引目录下**全部**由本插件生成的索引笔记。
   *
   * ★ 这是「打开这个开关」的对应出口。设置面板里那句"在自己库里多出一沓文件是
   *   **可一条命令整体撤销**的"指的就是它 —— 用户试过之后不想要了，不该被迫一个个
   *   手删，也不该被留在"关掉开关、但文件还在"的中间状态里。
   * ★ 与 `cleanup()` 的区别是**故意**的：`cleanup` 只收"白板已经不在"的残骸
   *   （开关关着时的清扫），这里收掉全部（用户的整体退订）。
   * ★ 不看开关：用户**关掉开关之后**正是最需要它的时候。
   * ★ 仍然只删带生成物标记的 `.md`（`removeNote`）：目录里混着的用户笔记一个字都不动。
   *   调用方负责先给用户一次确认 —— 这条命令的破坏面比 `cleanup` 大得多。
   */
  async removeAll(): Promise<IndexNoteStats> {
    const stats = emptyStats();
    if (this.disposed) return stats;

    for (const notePath of await this.listNotes()) {
      if (await this.removeNote(notePath)) stats.removed += 1;
    }
    return stats;
  }

  /**
   * 索引目录下当前由本插件生成的笔记（只列，不读也不删）。
   *
   * ★ 「删除索引笔记」命令拿它算确认框里的那个数字 —— 总得先让用户看清"要删几份"
   *   才谈得上确认。清单来自 `metadataCache` 的 frontmatter，是**线索**：
   *   真正决定删不删的是文件里的标记（见 `removeNote`），所以这个数字可能与最终
   *   `removed` 略有出入（用户文件恰好也带着那栏 frontmatter 时会多算）。
   */
  async listNotes(): Promise<string[]> {
    if (this.disposed) return [];
    return this.listIndexNotesSafe(this.ports.folder());
  }

  /** 收尾：停掉防抖、清干净引用。卸载时调用（**先 `drain` 再 `dispose`**） */
  dispose(): void {
    this.disposed = true;
    this.debouncedDrain.cancel();
    this.pending.clear();
    this.conflictPaths.clear();
  }

  // ── 内部 ───────────────────────────────────────────────────

  private async drainPending(): Promise<void> {
    if (this.pending.size === 0) return;
    // 先取快照再清空：同步途中新来的 `scheduleSync` 属于下一轮，不该被这一轮吞掉
    const paths = [...this.pending];
    this.pending.clear();
    for (const path of paths) await this.syncBoard(path);
  }

  /** 读文件；"不存在"的两种风格（返回 `null` / 直接抛）都收敛成 `null` */
  private async readIfPresent(path: string): Promise<string | null> {
    try {
      return await this.ports.read(path);
    } catch {
      return null;
    }
  }

  /**
   * 删掉一份笔记。
   *
   * ★ **先读、再认标记、最后才删** —— 这是"只删自己生成的文件"这条承诺的执行点。
   *   清单（`listIndexNotes`）只是线索：它可能过期、可能因为 frontmatter 里恰好
   *   有同名字段而误报。真正决定能不能删的是文件内容里的那一行标记。
   */
  private async removeNote(notePath: string): Promise<boolean> {
    if (this.disposed) return false;

    const existing = await this.readIfPresent(notePath);
    if (existing === null || !isIndexNote(existing)) return false;

    try {
      await this.ports.remove(notePath);
      this.conflictPaths.delete(notePath);
      return true;
    } catch (error) {
      console.warn(`[nestboard] 删除索引笔记失败：${notePath}`, describeError(error));
      return false;
    }
  }

  /** 收掉 `folder` 之下、**当前位置已经不是它**的那些索引笔记（迁移目录用） */
  private async removeUnder(folder: string): Promise<number> {
    const current = this.ports.folder();
    let removed = 0;

    for (const notePath of await this.listIndexNotesSafe(folder)) {
      const boardPath = indexNoteBoardOf(notePath, folder);
      if (boardPath === null) continue;
      // 已经落在当前目录里了（含"新旧目录其实一样"）→ 什么都不用做
      if (indexNotePathOf(boardPath, current) === notePath) continue;
      if (await this.removeNote(notePath)) removed += 1;
    }
    return removed;
  }

  private async listIndexNotesSafe(folder: string): Promise<string[]> {
    try {
      return await this.ports.listIndexNotes(folder);
    } catch (error) {
      console.warn(`[nestboard] 列不出 "${folder}" 下的索引笔记`, describeError(error));
      return [];
    }
  }

  private yieldIdle(): Promise<void> {
    const schedule = this.ports.scheduleIdle ?? defaultScheduleIdle;
    return new Promise<void>((resolve) => {
      schedule(() => resolve());
    });
  }
}

function emptyStats(): IndexNoteStats {
  return { written: 0, unchanged: 0, removed: 0, skipped: 0, failed: 0 };
}

/** 把一次同步的结果记进账里。`disabled` 不计（开关关着时整轮都是它，没有信息量） */
function tally(stats: IndexNoteStats, outcome: IndexNoteSyncOutcome): void {
  if (outcome === 'written') stats.written += 1;
  else if (outcome === 'unchanged') stats.unchanged += 1;
  else if (outcome === 'skipped') stats.skipped += 1;
  else if (outcome === 'failed') stats.failed += 1;
}

/** 默认的让出主线程方式：空闲回调优先，没有就退化成"下一个宏任务" */
function defaultScheduleIdle(task: () => void): void {
  const idle = (
    globalThis as {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
    }
  ).requestIdleCallback;

  if (typeof idle === 'function') idle(task, { timeout: IDLE_TIMEOUT_MS });
  else setTimeout(task, 0);
}
