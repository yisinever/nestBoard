/**
 * 撤销重做框架（T1.48，`F3` / `02 §4.1` 的 `⌘Z` / `⌘⇧Z`）。
 *
 * ── 为什么是**内容快照**而不是"反向命令" ────────────────────
 *
 * 命令模式要求每个操作自己写一遍逆操作，而本项目的操作种类会持续增长
 * （移动 / 缩放 / 层级 / 增删 / 复制 / 改色 / 改标题 / 分栏 / 连线 / 手绘…）。
 * 每加一种操作就得同步写一个逆操作，漏一个就是"撤销后文件坏掉"这种最伤数据的 bug。
 *
 * 快照法只依赖一件事：**卡片/分栏/脑图/连线/编组必须是可 JSON 化的纯数据**
 * （这是 `03 §2` 的硬性前提，`.nboard` 本来就是 JSON）。于是撤销 = 把五个数组换回旧值，
 * 永远不可能"逆操作写错"。代价是内存 —— 用**条数上限 + 总体积预算**两道闸门兜住：
 * 5000 卡的白板单份快照约 1~2MB，预算 8MB 时栈里只留最近几次，这是有意的取舍
 * （宁可少撤销几步，也不要把 Obsidian 的内存吃光）。
 *
 * ── 合并（`mergeKey`）──────────────────────────────────────
 *
 * 连按 10 次方向键应该只算**一步**撤销（用户心里就是"把这张卡挪过去"）。
 * 同一 `mergeKey` 且间隔在 `HISTORY_MERGE_WINDOW_MS` 内的提交合并成一条。
 *
 * ★ 纯逻辑、零依赖、不 import obsidian，可直接单测。
 */

import { HISTORY_BYTES_BUDGET, HISTORY_LIMIT, HISTORY_MERGE_WINDOW_MS } from '../constants';
import type { BoardFile } from './schema';

/** 白板里**参与撤销**的五类实体。`meta` / `view` / `settings` 刻意不在内（见下） */
export interface BoardContent {
  cards: BoardFile['cards'];
  columns: BoardFile['columns'];
  /**
   * 白板级脑图（`2.2.0` 收尾 · 用户 2026-09-23："删除脑图卡目前没法撤销"）。
   *
   * ★ 从前这里只有四类（卡片 / 分栏 / 连线 / 编组）—— 脑图是 `2.2.0` 才升格成白板对象的，
   *   快照漏了它 ⇒ **删掉一整棵树之后 `⌘Z` 撤不回来**（恢复出来的白板里那棵树不在），
   *   反过来"加一棵树之后撤销"也不会把它去掉。
   * ★ 快照里**一律写这一格**（哪怕空数组）：读回来才分得清"当时确实没有树"与"这是一份
   *   老快照"，而写回白板时要不要留这个键另说（见 `restoreContent`）。
   */
  minds: NonNullable<BoardFile['minds']>;
  edges: BoardFile['edges'];
  groups: BoardFile['groups'];
}

/**
 * 快照内容。`view` 是界面状态（`03 §2.4`：只改视口不递增 revision），
 * `meta` / `settings` 属于"板子本身"而不是"某次编辑"，都不该被 `⌘Z` 回滚 ——
 * 撤销一下把白板标题改回去，用户会觉得见了鬼。
 */
export function serializeContent(board: BoardFile): string {
  const content: BoardContent = {
    cards: board.cards,
    columns: board.columns,
    // ★ `?? []`：白板没有树时这个键是**缺席**的（"缺席 = 没有脑图"的纪律），而快照里
    //   一律给一格空数组 —— 读回来才分得清"当时没有树"与"这是一份老快照"
    minds: board.minds ?? [],
    edges: board.edges,
    groups: board.groups,
  };
  return JSON.stringify(content);
}

/**
 * 把快照写回白板（**就地替换四个数组**，其余字段一个不碰）。
 * 返回是否解析成功 —— 坏快照宁可放弃撤销，也不能把白板搞成半截状态。
 */
export function restoreContent(board: BoardFile, raw: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== 'object') return false;

  const content = parsed as Partial<BoardContent>;
  if (!Array.isArray(content.cards) || !Array.isArray(content.columns)) return false;
  if (!Array.isArray(content.edges) || !Array.isArray(content.groups)) return false;
  // ★ `minds` 也必须在：这一批之前记下的快照没有它，而"猜"的两个方向都糟 ——
  //   猜成空数组会把"删掉一棵树"**坐实**（用户按了撤销却什么都没回来），
  //   猜成"保持现状"会把别的改动一起吞掉。宁可放弃这一次撤销（坏快照的老口径）
  if (!Array.isArray(content.minds)) return false;

  board.cards = content.cards;
  board.columns = content.columns;
  board.edges = content.edges;
  board.groups = content.groups;
  // ★ 快照里一棵树都没有 ⇒ **把这个键删掉**（别写一个 `minds: []`）：
  //   "缺席 = 没有脑图"是仓库的一条纪律（`createBoardFile` / `validate` /
  //   `serializeBoard` 的版本判定都看它），留个空数组会让落盘多出一行空壳
  const minds = content.minds as NonNullable<BoardFile['minds']>;
  if (minds.length > 0) board.minds = minds;
  else delete board.minds;
  return true;
}

export interface HistoryEntry {
  /** 操作名（i18n 后的文案），用于提示"已撤销：移动卡片" */
  readonly label: string;
  /** 同标签的连续提交合并成一步；`undefined` = 永不合并 */
  readonly mergeKey: string | undefined;
  readonly before: string;
  /**
   * 结果快照。**可变**：合并提交时只替换它（起点保留第一次的那份），
   * 所以这里刻意不加 `readonly` —— 加了之后"连按 10 次方向键算一步"就写不出来。
   */
  after: string;
  at: number;
  bytes: number;
}

export interface HistorySubmit {
  label: string;
  before: string;
  after: string;
  /** 见 `HistoryEntry.mergeKey` */
  mergeKey?: string;
}

export interface HistoryOptions {
  limit?: number;
  bytesBudget?: number;
  mergeWindowMs?: number;
  /** 注入时钟，仅为可测试性 */
  now?: () => number;
}

export class HistoryStack {
  private readonly limit: number;
  private readonly bytesBudget: number;
  private readonly mergeWindowMs: number;
  private readonly now: () => number;

  private readonly undoStack: HistoryEntry[] = [];
  private readonly redoStack: HistoryEntry[] = [];
  private bytes = 0;

  constructor(options: HistoryOptions = {}) {
    this.limit = options.limit ?? HISTORY_LIMIT;
    this.bytesBudget = options.bytesBudget ?? HISTORY_BYTES_BUDGET;
    this.mergeWindowMs = options.mergeWindowMs ?? HISTORY_MERGE_WINDOW_MS;
    this.now = options.now ?? Date.now;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  get undoLabel(): string | null {
    return this.undoStack[this.undoStack.length - 1]?.label ?? null;
  }

  get redoLabel(): string | null {
    return this.redoStack[this.redoStack.length - 1]?.label ?? null;
  }

  get undoDepth(): number {
    return this.undoStack.length;
  }

  get redoDepth(): number {
    return this.redoStack.length;
  }

  /**
   * 记录一次改动。`before` / `after` 由调用方在 `mutate` 前后各取一次
   * （`BoardView.commit()` 是唯一的调用点）。
   *
   * 内容没变（`before === after`）直接丢弃 —— 否则"点一下但什么都没改"也会占一格，
   * 用户按 `⌘Z` 时会觉得"撤销没反应"。
   */
  submit(entry: HistorySubmit): boolean {
    if (entry.before === entry.after) return false;

    const at = this.now();
    const top = this.undoStack[this.undoStack.length - 1];
    if (
      top &&
      entry.mergeKey !== undefined &&
      top.mergeKey === entry.mergeKey &&
      at - top.at <= this.mergeWindowMs
    ) {
      // 合并：只换掉"结果"，起点保持第一次提交时的那份 —— 连按 10 次也一步回到最初
      this.bytes += entry.after.length - top.after.length;
      top.after = entry.after;
      top.at = at;
      this.evictWhileOverBudget();
      return true;
    }

    const entryRecord: HistoryEntry = {
      label: entry.label,
      mergeKey: entry.mergeKey,
      before: entry.before,
      after: entry.after,
      at,
      bytes: entry.before.length + entry.after.length,
    };
    this.undoStack.push(entryRecord);
    this.bytes += entryRecord.bytes;

    // 新的改动让"重做"失去意义（与所有编辑器的约定一致）
    this.dropRedo();
    this.evictWhileOverBudget();
    return true;
  }

  /** 取出一条可撤销的记录（**不移除**，由调用方写回内容后再 `commitUndo`） */
  peekUndo(): HistoryEntry | null {
    return this.undoStack[this.undoStack.length - 1] ?? null;
  }

  peekRedo(): HistoryEntry | null {
    return this.redoStack[this.redoStack.length - 1] ?? null;
  }

  /**
   * 撤销完成：把记录从撤销栈挪到重做栈。
   *
   * 分成 peek / commit 两步是刻意的：写回内容可能失败（快照损坏），
   * 那时栈必须原样不动 —— "撤销失败但栈已经弹掉了"会让用户再也退不回去。
   */
  commitUndo(): HistoryEntry | null {
    const entry = this.undoStack.pop();
    if (!entry) return null;
    this.redoStack.push(entry);
    return entry;
  }

  commitRedo(): HistoryEntry | null {
    const entry = this.redoStack.pop();
    if (!entry) return null;
    this.undoStack.push(entry);
    return entry;
  }

  /** 换板 / 外部重载：历史不再适用（快照指向的是上一块板的内容） */
  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.bytes = 0;
  }

  /** 退出重做（新改动进来时） */
  private dropRedo(): void {
    for (const entry of this.redoStack) this.bytes -= entry.bytes;
    this.redoStack.length = 0;
  }

  private evictWhileOverBudget(): void {
    while (
      this.undoStack.length > 0 &&
      (this.undoStack.length > this.limit || this.bytes > this.bytesBudget)
    ) {
      // 从最旧的一条开始丢：能撤销的步数变少，但最近的操作总是能撤销
      const dropped = this.undoStack.shift();
      if (!dropped) return;
      this.bytes -= dropped.bytes;
    }
  }
}
