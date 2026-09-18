/**
 * 跨白板搜索索引（T7.02 / `F8-08`）。
 *
 * ## 它解决什么
 *
 * `model/search.ts` 能搜的只有"手上这一份快照"。要在侧栏里搜**全部** `.nboard`，
 * 就得先有一份"每块板现在长什么样"的账 —— 而这个账不能每次敲键都去重读一遍库：
 * 一次跨板查询要遍历库里**所有**卡片，读盘 + `JSON.parse` 的成本远高于匹配本身，
 * 每敲一个字重来一次会让输入框肉眼可见地卡。
 *
 * 所以这里做的是**以内存换响应**：扫一遍全库，把解析好的板子留在内存里，
 * 之后每次查询都只是在这一堆模型上跑 `searchBoard`（纯字符串操作）。
 *
 * ## 三条不能再让的线
 *
 * 1. **懒加载，绝不在启动时扫**（`R4`：启动读全库白板的 JSON 会把插件卡住）。
 *    `ensure()` 只由"用户真的打开了跨板搜索侧栏"触发；不碰这个功能的人，
 *    一个字节的额外开销都不付。扫描本身照 `LinkIndex` 的范式分片 + 让出主线程，
 *    每片结束广播一次，侧栏会在扫描途中逐段长出结果。
 * 2. **一块板读不出来只跳过它**。JSON 坏了 / 不像白板 / 迁移无路，都不该让整次搜索
 *    失败 —— 少一块板的结果是小事，因为一份坏文件让侧栏整个空白是大事。
 * 3. **增量维护与全量扫描不能互相打架**。扫描期间用户可能正好在另一块板上打字
 *    （`saved` 事件）或被同步工具改了文件（`modify`）。`touchedDuringBuild` 记下这些
 *    路径，扫描**主动跳过**它们并把已有记录留给增量那条路 —— 否则扫描读到一半的旧内容
 *    会把刚刚写进来的新内容盖掉（表现是"刚搜到的新词，下一片扫完就没了"）。
 *
 * 模块约束：**不 import `obsidian`**，端口注入，可直接在 node 下单测。
 */

import { parseBoardFile } from '../io/boardText';
import {
  MAX_BOARD_SEARCH_HITS,
  searchAcrossBoards,
  type BoardSearchCandidate,
  type CrossBoardSearchResult,
} from '../model/boardSearch';
import type { BoardFile } from '../model/schema';

export interface BoardSearchIndexOptions {
  /** 列出全部白板路径（vault 相对） */
  list: () => Promise<string[]>;
  /**
   * 读一块白板。读回 `null`、或**直接抛**，都视为"读不到"并跳过它 ——
   * 适配器对"文件不在了"这两种风格都有人用，调用方不该被迫统一。
   */
  read: (path: string) => Promise<string | null>;
  /** 每片处理多少块板（默认 20） */
  chunkSize?: number;
  /** 让出主线程的方式（测试注入点）。默认 `requestIdleCallback` → `setTimeout` 兜底 */
  scheduleIdle?: (task: () => void) => void;
}

/** 索引规模（侧栏的状态行与排障入口都要真实数字） */
export interface BoardSearchIndexStats {
  boards: number;
  cards: number;
}

interface IndexedBoard {
  /** `meta.title`；空串时侧栏回退显示路径 */
  title: string;
  board: BoardFile;
}

const DEFAULT_CHUNK_SIZE = 20;
const IDLE_TIMEOUT_MS = 500;

/**
 * 跨白板搜索索引。
 *
 * 生命周期：`ensure()` 触发一次全量扫描 → 之后靠 `updateFromBoard`（保存）/ `update`
 * （外部改动）/ `remove` / `renamePath` 增量维护，与 `LinkIndex` 是同一套事件源、
 * 同一套"内存模型优先"的取舍。
 */
export class BoardSearchIndex {
  private readonly records = new Map<string, IndexedBoard>();
  private readonly listeners = new Set<() => void>();
  /** 扫描期间被增量改动过的路径（见文件头第 3 条） */
  private readonly touchedDuringBuild = new Set<string>();

  private generation = 0;
  private building = false;
  private ready = false;
  private scanned = 0;
  private started = false;
  /** `dispose()` 之后这个对象就作废了：任何入口都不再起新的活（见 `dispose`） */
  private disposed = false;

  constructor(private readonly options: BoardSearchIndexOptions) {}

  // ── 构建 ────────────────────────────────────────────────────

  /**
   * 懒启动：第一次调用才开始扫，之后调用什么都不做。
   *
   * ★ 与 `rebuild()` 分成两个方法而不是让调用方自己记"建了没有"：侧栏每次
   *   `onOpen` 都会调它，而 Obsidian 的侧栏是**关掉再打开**会重新建视图的 ——
   *   把判断留在外面，"重开一次侧栏就重扫一遍全库"这种事迟早会发生。
   */
  ensure(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    void this.rebuild();
  }

  /** 用户是否已经触发过索引（没触发过时增量事件应当被忽略，见 `updateFromBoard`） */
  get buildStarted(): boolean {
    return this.started;
  }

  /**
   * 全量重建。分片扫描，**每片提交一次**，所以调用方 `void index.rebuild()` 也不会卡 UI。
   *
   * ★ `generation` 计数器用于"扫到一半又来了一个 rebuild"：旧的那次会在下一片开头
   *   发现自己的世代过期并**直接放弃**，绝不与新的那次交替往 `records` 里写 ——
   *   否则结果会是一半旧库一半新库的混合体。
   */
  async rebuild(): Promise<void> {
    const generation = ++this.generation;
    const chunkSize = Math.max(1, this.options.chunkSize ?? DEFAULT_CHUNK_SIZE);

    this.building = true;
    this.ready = false;
    this.scanned = 0;
    this.touchedDuringBuild.clear();

    let paths: string[];
    try {
      paths = await this.options.list();
    } catch {
      // 列不出文件（适配器异常）不该让插件加载失败：留一个空索引，侧栏显示"没有结果"
      this.records.clear();
      this.building = false;
      this.ready = true;
      this.publish();
      return;
    }

    const collected = new Map<string, IndexedBoard>();
    for (let start = 0; start < paths.length; start += chunkSize) {
      if (generation !== this.generation) return;

      for (const path of paths.slice(start, start + chunkSize)) {
        // 跳过扫描期间被增量改动过的路径：那些记录比这次扫描读到的新（见文件头第 3 条）
        if (this.touchedDuringBuild.has(path)) continue;
        const record = await this.readRecord(path);
        if (record) collected.set(path, record);
      }

      this.scanned = Math.min(start + chunkSize, paths.length);
      this.commit(collected);
      this.publish();
      await this.yieldIdle();
    }

    if (generation !== this.generation) return;
    this.building = false;
    this.ready = true;
    this.publish();
  }

  // ── 增量维护 ────────────────────────────────────────────────

  /**
   * 按磁盘内容重索引一块板（外部 `modify` / `create`）。
   *
   * 读不出来（文件被删/被占）时**当作删除**：留着一块已经不存在的板，
   * 搜索结果点进去只会得到一个打不开的标签页。
   */
  async update(path: string): Promise<void> {
    this.noteTouch(path);
    // 索引还没建过：扫描会读到此刻盘上的内容，这里什么都不用做
    if (!this.started || this.disposed) return;
    const record = await this.readRecord(path);
    this.setRecord(path, record);
  }

  /**
   * 用**内存模型**重索引一块板，免读盘（`repository` 的 `saved` 事件）。
   *
   * ★ 保存频率远高于外部改动，走磁盘读会把自动保存变成"每次都多读一次自己的文件"。
   * ★ 与 `LinkIndex.updateFromBoard` 一样只吃内存模型 —— 差别是这里留下的**是整块板**
   *   （搜索要重新跑匹配，光有摘要不够）。
   */
  updateFromBoard(path: string, board: BoardFile): void {
    this.noteTouch(path);
    if (!this.started || this.disposed) return;
    this.setRecord(path, recordOf(board));
  }

  /**
   * 删除一块板。
   *
   * ★ **不看 `started`**：`records` 里已经有的记录必须当场收掉，否则"搜索里点进去
   *   是一块不存在的板"。这条与开关 / 启动状态无关，是纯粹的坏数据。
   */
  remove(path: string): void {
    this.noteTouch(path);
    this.setRecord(path, null);
  }

  /** 白板改名 / 移动：只换 key，不重扫（内容一个字节都没变） */
  renamePath(oldPath: string, newPath: string): void {
    this.noteTouch(oldPath);
    this.noteTouch(newPath);

    const record = this.records.get(oldPath);
    if (!record) {
      // ★ 索引里没有旧路径（扫描还没轮到它 / 它上次压根没解析出来）时**不能就这么算了**：
      //   新路径不在本次扫描的文件清单里，什么都不做的话这块板会一直缺席到下次重建 ——
      //   用户刚改完名就搜，搜不到，且不知道要等多久。这里按"新增一块板"补读一次。
      void this.update(newPath);
      return;
    }
    this.records.delete(oldPath);
    this.records.set(newPath, record);
    this.publish();
  }

  // ── 查询 ────────────────────────────────────────────────────

  /**
   * 在**当前已索引的内容**上搜一遍。
   *
   * ★ 同步返回：调用方是"每敲一个字就查一次"的侧栏，异步接口会逼它自己处理
   *   "哪一次查询的结果该显示"（乱序返回、取消上一次）—— 那套复杂度换不来任何东西，
   *   因为这里的所有数据都躺在内存里，查询本身是纯计算。
   * ★ 扫描没走完时返回的是**部分结果**（侧栏据此显示"正在索引…"），
   *   这不是错误路径，是它工作时的正常状态。
   */
  search(query: string, limit: number = MAX_BOARD_SEARCH_HITS): CrossBoardSearchResult {
    const candidates: BoardSearchCandidate[] = [];
    for (const [path, record] of this.records) {
      candidates.push({ path, title: record.title, board: record.board });
    }
    return searchAcrossBoards(candidates, query, limit);
  }

  /** 索引规模（排障 / 状态行） */
  stats(): BoardSearchIndexStats {
    let cards = 0;
    for (const record of this.records.values()) cards += record.board.cards.length;
    return { boards: this.records.size, cards };
  }

  /** 全量扫描是否走完（没走完时侧栏要显示"正在索引 n/m"而不是"没有结果"） */
  get isReady(): boolean {
    return this.ready;
  }

  /** 已扫描的板数（扫描途中显示进度用） */
  get scannedBoards(): number {
    return this.scanned;
  }

  /** 索引里现有的板数 */
  get indexedBoards(): number {
    return this.records.size;
  }

  onChanged(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * 卸载时的收尾。
   *
   * ★ 与 `LinkIndex.dispose` 相比多了一个 `disposed` 标记：那个索引**在加载时就扫完了**，
   *   卸载时只剩"让进行中的扫描停手"这一件事；而这个索引是**懒启动**的，卸载时完全
   *   可能一次都还没扫过 —— 光靠世代号的话，卸载之后任何一次 `ensure()` 都会重新
   *   开始读全库，而那时宿主已经要走了。
   */
  dispose(): void {
    this.disposed = true;
    // 世代号 +1：进行中的扫描会在下一片开头自行放弃
    this.generation += 1;
    this.building = false;
    this.records.clear();
    this.touchedDuringBuild.clear();
    this.listeners.clear();
  }

  // ── 内部 ────────────────────────────────────────────────────

  /** 扫描期间才需要记账：没有扫描在跑时，"被改动"这件事由 `records` 自己表达 */
  private noteTouch(path: string): void {
    if (this.building) this.touchedDuringBuild.add(path);
  }

  /**
   * 把这一片扫到的内容换进 `records`，同时**保住**扫描期间增量写进来的那些板。
   *
   * ★ 不是"整体覆盖"：`touchedDuringBuild` 里的路径在这片里被跳过了，如果这里把
   *   `records` 清空重建，它们就会从这里消失，直到扫描结束（甚至永远）都不再出现。
   */
  private commit(collected: Map<string, IndexedBoard>): void {
    const kept = new Map<string, IndexedBoard>();
    for (const path of this.touchedDuringBuild) {
      const record = this.records.get(path);
      // 被删掉的板不在 `records` 里 —— 正好，它本来就不该被"保住"
      if (record) kept.set(path, record);
    }

    this.records.clear();
    for (const [path, record] of collected) this.records.set(path, record);
    for (const [path, record] of kept) this.records.set(path, record);
  }

  private async readRecord(path: string): Promise<IndexedBoard | null> {
    let raw: string | null;
    try {
      raw = await this.options.read(path);
    } catch {
      // ★ 读**抛错**与读回 null 在此同义（`MemoryVaultIO` 就是抛）。更要紧的是：
      //   这里是 `vault.on(...)` 事件链的一环，一个读异常冒出去会打断整条链
      return null;
    }
    if (raw === null) return null;
    const board = parseBoardFile(raw);
    if (!board) return null;
    return recordOf(board);
  }

  private setRecord(path: string, record: IndexedBoard | null): void {
    if (record) this.records.set(path, record);
    else if (!this.records.delete(path)) return;
    this.publish();
  }

  private publish(): void {
    // 先复制再遍历：监听者在回调里退订是正常用法（视图关闭时就会这么做）
    for (const listener of [...this.listeners]) listener();
  }

  private yieldIdle(): Promise<void> {
    const schedule = this.options.scheduleIdle ?? defaultScheduleIdle;
    return new Promise<void>((resolve) => {
      schedule(() => resolve());
    });
  }
}

/** 白板模型 → 索引记录 */
function recordOf(board: BoardFile): IndexedBoard {
  return { title: board.meta.title, board };
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
