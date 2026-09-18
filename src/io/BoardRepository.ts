/**
 * BoardRepository —— `.nboard` 的唯一读写入口（T1.10 / T1.11 / T1.12 / T1.13）。
 *
 * 这是全项目**最容易造成数据丢失**的地方，实现严格对照 03 §3 的六条硬性规则：
 *
 * | 规则 | 本文件中的落点 |
 * |---|---|
 * | W1 用 `vault.process` 原子写 | `performSave` → `io.process` |
 * | W2 绝不原地截断 | 同上（`process` 内部保证读写之间文件不被他人改动） |
 * | W3 视口变化不递增 revision | `updateView()` |
 * | W4 外部改动 → 重载内存 | `handleExternalModify()` + `writingPaths` 自我写入识别 |
 * | W5 失焦 / 卸载强制 flush | `flush()` / `flushAll()`（由 `main.ts` 挂事件） |
 * | W6 解析失败绝不覆盖 | `enterProtected()` → `state: 'readonly'`，后续 `mutate` 直接抛错 |
 *
 * 模块约束：**不得 import `view/`**，也不得直接 import `obsidian`（走 `VaultIO` 端口），
 * 这样 `src/tests/` 才能用内存实现跑「原子写 / 冲突检测 / 防抖」的集成测试（04 §12.1）。
 */

import {
  BOARD_JSON_INDENT,
  DEFAULT_AUTOSAVE_DEBOUNCE_MS,
  DEFAULT_RELOAD_DEBOUNCE_MS,
} from '../constants';
import type { BoardFile, BoardViewState } from '../model/schema';
import { normalizeBoardFile, safeJsonParse, type ValidationIssue } from '../model/validate';
import { debounce, type Debounced } from '../util/debounce';
import { describeError } from '../util/errors';
import { migrateBoardFile } from './migrate';
import type { VaultIO } from './vaultIO';

// ─────────────────────────────────────────────────────────────
// 公开类型
// ─────────────────────────────────────────────────────────────

export type BoardState = 'clean' | 'dirty' | 'saving' | 'conflict' | 'readonly';

/** 需要用户决策的冲突原因 */
export type ConflictReason =
  /** 磁盘 revision 比我们的基线更新（多设备 / 外部编辑器改过） */
  | 'disk-newer'
  /** 磁盘文件已损坏到无法解析，但我们内存里有内容 —— 拒绝盲写 */
  | 'disk-unparsable';

/** 进入只读保护态的原因（对应 03 §3.2 W6） */
export type ProtectedReason =
  | 'invalid-json'
  | 'not-a-board'
  | 'not-an-object'
  | 'future-version'
  | 'no-migration-path'
  | 'read-failed';

export interface BoardRepositoryEvents {
  /** 内存模型就绪或发生变更（`open()` 成功、`mutate()`、外部重载都会触发） */
  changed: { path: string; board: BoardFile };
  /** 成功写入磁盘 */
  saved: { path: string; revision: number };
  /** 磁盘被外部修改且与本地状态冲突 → 必须由用户决策，插件不自行覆盖 */
  conflict: { path: string; disk: BoardFile | null; mine: BoardFile; reason: ConflictReason };
  /** 磁盘内容被重新载入内存（外部编辑的正常同步路径） */
  reloaded: { path: string; board: BoardFile; issues: ValidationIssue[] };
  /** 进入只读保护态 */
  protected: { path: string; reason: ProtectedReason };
  error: { path: string; error: Error };
}

type EventListener = (payload: never) => void;

export interface BoardRepositoryOptions {
  saveDebounceMs?: number;
  reloadDebounceMs?: number;
  /** 注入时钟，仅为可测试性 */
  now?: () => number;
  /**
   * 写盘成功后的**旁路**观察者（T4.01 快照用）。
   *
   * ★ 刻意是"单向通知 + 不 await + 不返回错误"：快照慢或失败都绝不该拖慢、更不该阻断
   *   保存本身 —— `performSave` 的职责边界就是"把内存模型可靠地写到盘上"，
   *   多一个必须成功的步骤就多一种让保存失败的方式（W1/W2 的前提随之失效）。
   */
  observer?: BoardSaveObserver;
}

/**
 * 写盘成功的旁路通知（见 `BoardRepositoryOptions.observer`）。
 *
 * ★ 传 `boardId` / `revision` / `text` 而**不是整个 `BoardFile`**：`board` 是活对象，
 *   异步写盘期间可能已经被下一次 `mutate` 改过，拿它等于给观察者一份"和刚写下去那份
 *   不一致"的数据。这三个值在序列化那一刻就已固定。
 */
export interface BoardSaveObserver {
  afterSave(payload: { path: string; boardId: string; revision: number; text: string }): void;
}

/** 序列化后的白板文本（2 空格缩进 + 末尾换行，`git diff` 友好） */
export function serializeBoard(board: BoardFile): string {
  return `${JSON.stringify(board, null, BOARD_JSON_INDENT)}\n`;
}

/**
 * 最近一次写盘的耗时画像（T2.17 诊断面板）。
 *
 * ★ 拆成两段是**为优化指路**：`serializeMs` 大 = 卡在"全量 `JSON.stringify`"（T2.15 的靶子），
 *   `writeMs` 大 = 卡在磁盘 / 编码（那是另一条完全不同的优化路线）。
 *   合成一个总数就只能知道"慢"，不知道该修哪儿。
 */
export interface SaveStats {
  /** 序列化耗时（ms） */
  serializeMs: number;
  /** 原子写往返耗时（ms，含磁盘；冲突/失败时也照记，那是"尝试"的耗时） */
  writeMs: number;
  /** 两段之和 */
  totalMs: number;
  /** 写盘结束时刻（`now()`） */
  at: number;
  /** 写下去（或尝试写）的 revision */
  revision: number;
}

/** 冲突：`process` 的 transform 抛出它 → Obsidian 放弃写入（W1 的原子性保障） */
export class ConflictError extends Error {
  constructor(
    readonly reason: ConflictReason,
    readonly disk: BoardFile | null,
    readonly diskText: string | null,
  ) {
    super(`board-conflict:${reason}`);
    this.name = 'ConflictError';
  }
}

interface InternalSession {
  /**
   * Vault 相对路径。
   *
   * ★ **可变**（T1.73）：白板文件被重命名 / 移动时 session 要跟着换 key，
   *   见 `BoardRepository.movePath`。安全性来自 `session.path` 的每一处用法
   *   都是**实时读**（读写文件、填事件 payload），没有任何地方把它捕获成闭包变量。
   */
  path: string;
  board: BoardFile | null;
  /** 解析失败时保留原始文本，供"查看原始文件 / 从快照恢复" */
  rawText: string | null;
  /** 最近一次与磁盘一致的 revision */
  baseline: number;
  state: BoardState;
  issues: ValidationIssue[];
  dirty: boolean;
  writing: boolean;
  /** 用户已明确选择「保留我的修改」→ 本次写入跳过冲突检测 */
  forceOverwrite: boolean;
  inFlight: Promise<void> | null;
  saveSchedule: Debounced | null;
  reloadSchedule: Debounced | null;
  /** 最近一次写盘画像；从未写过时为 `null`（诊断面板显示"尚无记录"） */
  lastSave: SaveStats | null;
}

type ParseOutcome =
  | { ok: true; board: BoardFile; issues: ValidationIssue[] }
  | { ok: false; reason: ProtectedReason };

// ─────────────────────────────────────────────────────────────
// Repository
// ─────────────────────────────────────────────────────────────

export class BoardRepository {
  private readonly sessions = new Map<string, InternalSession>();
  private readonly listeners = new Map<keyof BoardRepositoryEvents, Set<EventListener>>();

  /**
   * 自己发起写入的路径集合（03 §3.3）。
   * `vault.process()` 同样会触发 `vault.on('modify')`，靠它区分"我写的"和"别人改的"。
   */
  readonly writingPaths = new Set<string>();

  /** 自动保存间隔。**可变**：用户在设置里改了要立刻生效（T1.74 / `F11-10`） */
  private saveDebounceMs: number;
  private readonly reloadDebounceMs: number;
  private readonly now: () => number;
  private readonly observer: BoardSaveObserver | undefined;

  constructor(
    private readonly io: VaultIO,
    options: BoardRepositoryOptions = {},
  ) {
    this.saveDebounceMs = options.saveDebounceMs ?? DEFAULT_AUTOSAVE_DEBOUNCE_MS;
    this.reloadDebounceMs = options.reloadDebounceMs ?? DEFAULT_RELOAD_DEBOUNCE_MS;
    this.now = options.now ?? ((): number => Date.now());
    this.observer = options.observer;
  }

  // ── 事件 ──────────────────────────────────────────────────

  on<K extends keyof BoardRepositoryEvents>(
    event: K,
    listener: (payload: BoardRepositoryEvents[K]) => void,
  ): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set<EventListener>();
      this.listeners.set(event, set);
    }
    const wrapped = listener as unknown as EventListener;
    set.add(wrapped);
    return () => {
      set.delete(wrapped);
    };
  }

  private emit<K extends keyof BoardRepositoryEvents>(
    event: K,
    payload: BoardRepositoryEvents[K],
  ): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const listener of [...set]) {
      try {
        (listener as unknown as (p: BoardRepositoryEvents[K]) => void)(payload);
      } catch (error) {
        console.warn(`[nestboard] 事件监听器抛错（${event}）`, describeError(error));
      }
    }
  }

  // ── 读路径（T1.10） ───────────────────────────────────────

  /** 打开白板：磁盘 → 迁移 → 规范化 → 内存模型。已打开则直接返回内存模型 */
  async open(path: string): Promise<BoardFile | null> {
    const existing = this.sessions.get(path);
    if (existing) return existing.board;

    const session = this.createSession(path);
    this.sessions.set(path, session);
    await this.loadFromDisk(session, true);
    return session.board;
  }

  get(path: string): BoardFile | null {
    return this.sessions.get(path)?.board ?? null;
  }

  getState(path: string): BoardState | null {
    return this.sessions.get(path)?.state ?? null;
  }

  getIssues(path: string): ValidationIssue[] {
    return this.sessions.get(path)?.issues ?? [];
  }

  getRawText(path: string): string | null {
    return this.sessions.get(path)?.rawText ?? null;
  }

  isOpen(path: string): boolean {
    return this.sessions.has(path);
  }

  /**
   * 这块白板此刻是否**拒绝一切内容写入**（视图层的唯一判据）。
   *
   * 两种来源都算：
   *  * `readonly` 保护态（W6）：解析失败 / 磁盘读不出来，把内存里的东西写回去等于
   *    拿一块空板顶掉用户的文件；
   *  * `settings.readOnly`（T4.06 / `03 §2.5`）：用户自己把板子锁成只读（归档板）。
   *
   * ★ 两者**故意合成同一个答案**：工具条 / 右键菜单 / 快捷键 / 双击 / 手绘 / 连线 /
   *   粘贴 / 拖入有六十多处都在问同一句话 ——"现在能不能改"。拆成两个方法意味着
   *   每一处都要记得问两遍，漏掉任何一处就是"某条入口在归档板上照样亮着，
   *   点下去抛异常"。要区分**为什么**只读（写文案用），请用 {@link lockReason}。
   */
  isReadOnly(path: string): boolean {
    return this.lockReason(path) !== null;
  }

  /**
   * 只读的**原因**：`null` = 可以写。
   *
   * ★ 只在"要给人看"的地方用（提示条文案、通知）。判"能不能改"一律用
   *   {@link isReadOnly} —— 这条规矩把"新增一种只读理由"的成本压到一处。
   */
  lockReason(path: string): 'protected' | 'locked' | null {
    const session = this.sessions.get(path);
    if (!session) return null;
    // 会话已建、模型还没装好（`open` 的 await 期间）：此刻写下去就是写空板
    if (session.state === 'readonly' || session.board === null) return 'protected';
    return session.board.settings.readOnly ? 'locked' : null;
  }

  /** 是否是**用户自己锁的**归档板（与保护态区分，提示条文案不同） */
  isLocked(path: string): boolean {
    return this.lockReason(path) === 'locked';
  }

  /**
   * 切换「归档锁定」（T4.06 / `03 §2.5` 的 `settings.readOnly`）。
   *
   * ★ 这是**锁定板上唯一还能成功的写操作** —— 和"密码框上的解锁按钮"是同一类自举：
   *   必须绕开 `requireWritableBoard`，否则锁上之后再也解不开。
   * ★ 锁定本身**算内容变更**（递增 `revision` + 立刻落盘）：它写在 `.nboard` 里，
   *   不落盘的话"锁了板子然后崩了"就等于没锁，而用户以为锁上了。
   * ★ 保护态一律拒绝：那种板子的内存模型可能是空的，写回去正是保护态要防的事。
   *
   * ★ 必须是 `async`：`await` 到落盘之后才返回 `true`。调用方（视图）拿到 `true`
   *   就意味着"锁已经在磁盘上了"，于是它接下来那句"已锁定"的通知永远不会说谎 ——
   *   而这是整个 T4.06 里唯一一处"说了没做到就等于没锁"的地方。
   *
   * @returns 是否真的改了（已经是目标状态 / 保护态 / 板子没打开 → `false`）
   */
  async setLocked(path: string, locked: boolean): Promise<boolean> {
    const session = this.sessions.get(path);
    if (!session?.board) return false;
    if (session.state === 'readonly') return false;
    if (session.board.settings.readOnly === locked) return false;

    // ★ 先改内存再落盘：中间这段时间里 `isReadOnly()` 必须已经翻过去了，
    //   否则"锁上那一瞬"的窗口内，视图还是会放行一次改动
    session.board.settings.readOnly = locked;
    session.board.revision = Math.max(session.board.revision + 1, session.baseline + 1);
    session.dirty = true;
    // 与 `mutate` 同一条规矩：冲突未决时不开新状态，等用户三选一（03 §3.4）
    if (session.state !== 'conflict') session.state = 'dirty';
    this.emit('changed', { path, board: session.board });

    // 立刻落盘而不走节流：锁定是一件"用户现在就要看到它生效"的事，
    // 而且它本来就是防事故的开关 —— 挂起 500ms 再写没有任何好处
    await this.flush(path);
    return true;
  }

  openPaths(): string[] {
    return [...this.sessions.keys()];
  }

  /**
   * 白板文件被重命名 / 移动（T1.73 / `F7-05`）。
   *
   * ★ 必须把 session 一起搬到新 key。不搬的话有两处立刻坏掉：
   *   1. 视图按**新路径** `get()` 拿到 `null` —— 画布当场变空；
   *   2. 旧 key 上的防抖 / 定时保存仍会往一个**已经不存在的路径**写盘。
   *
   * 用"改 `path` 字段"而不是"关掉旧 session 再开新的"：后者会丢掉还没落盘的
   * 脏数据，而"改完名发现刚才的改动没了"是这里最不能接受的失败方式。
   *
   * 不 `emit('changed')`：内容一个字节都没变，视图那边要跟的是**路径**而不是模型，
   * 由 `BoardView.retargetPath` 处理。
   */
  movePath(oldPath: string, newPath: string): void {
    if (oldPath === newPath) return;
    const session = this.sessions.get(oldPath);
    // 目标已被占用说明新旧路径的推导有问题：宁可不搬 ——
    // 搬了会把另一块白板的内存模型顶掉（那是静默的数据错乱，比不跟随严重得多）
    if (!session || this.sessions.has(newPath)) return;
    this.sessions.delete(oldPath);
    session.path = newPath;
    this.sessions.set(newPath, session);
  }

  /**
   * 更新自动保存间隔（T1.74 / `F11-10`）。
   *
   * ★ 必须**重建**已经排好队的 `Debounced`：那些实例把旧间隔捕在闭包里，
   *   只改字段的话用户会看到"设置改了但没生效"。重建时先 `cancel` 再按新间隔重排，
   *   语义是"用新节奏重新计时" —— 挂起的改动一个都不会丢。
   *
   * 越界的值直接忽略而不抛：调用方是设置面板，那里已经有 `normalizeSettings` 把关，
   * 这里再挡一道只是为了不让 `setTimeout` 收到负数。
   */
  setSaveDebounce(ms: number): void {
    if (!Number.isFinite(ms) || ms <= 0 || ms === this.saveDebounceMs) return;
    this.saveDebounceMs = ms;

    for (const session of this.sessions.values()) {
      const pending = session.saveSchedule;
      if (!pending) continue;
      pending.cancel();
      session.saveSchedule = null;
      if (session.dirty) this.scheduleSave(session);
    }
  }

  private createSession(path: string): InternalSession {
    return {
      path,
      board: null,
      rawText: null,
      baseline: 0,
      state: 'clean',
      issues: [],
      dirty: false,
      writing: false,
      forceOverwrite: false,
      inFlight: null,
      saveSchedule: null,
      reloadSchedule: null,
      lastSave: null,
    };
  }

  private async loadFromDisk(session: InternalSession, initial: boolean): Promise<void> {
    let raw: string;
    try {
      raw = await this.io.read(session.path);
    } catch (error) {
      this.emit('error', { path: session.path, error: toError(error) });
      this.enterProtected(session, 'read-failed');
      return;
    }

    const parsed = this.parseBoardText(raw);
    if (!parsed.ok) {
      this.enterProtected(session, parsed.reason, raw);
      return;
    }

    session.board = parsed.board;
    session.rawText = null;
    session.baseline = parsed.board.revision;
    session.issues = parsed.issues;
    session.state = 'clean';
    session.dirty = false;
    this.emit('changed', { path: session.path, board: parsed.board });
    if (!initial) {
      this.emit('reloaded', { path: session.path, board: parsed.board, issues: parsed.issues });
    }
  }

  /** 磁盘文本 → 内存模型。**只读不写**，任何失败都只返回原因，由调用方决定是否保护 */
  private parseBoardText(raw: string): ParseOutcome {
    const json = safeJsonParse(raw);
    if (!json.ok) return { ok: false, reason: 'invalid-json' };

    const migrated = migrateBoardFile(json.value);
    if (!migrated.ok) return { ok: false, reason: migrated.reason };

    const normalized = normalizeBoardFile(migrated.value);
    if (!normalized) return { ok: false, reason: 'not-a-board' };

    return { ok: true, board: normalized.board, issues: normalized.issues };
  }

  // ── 写路径（T1.11） ───────────────────────────────────────

  /**
   * 变更内存模型。
   * - 默认**递增 revision**；视口变更请用 `updateView()`（W3）
   * - `immediate: true` 跳过节流直接落盘（破坏性操作 / 关闭前）
   *
   * ★ `mutator` 可以返回 `false` 表示"这次什么都没改"（如"把已经压在顶层的卡片再置顶一次"）。
   *   此时**不递增 revision、不标脏、不发事件、不排盘** —— 返回 `false` 就必须是真的
   *   一个字节都没动，否则会拿一个"看起来更新了"的假象去掩盖丢失的改动。
   *   返回别的值（含 `void`）一律按"改过了"处理，兼容既有调用方。
   *
   * @returns 是否真的产生了变更
   */
  mutate(
    path: string,
    mutator: (board: BoardFile) => void | boolean,
    options: { bumpRevision?: boolean; immediate?: boolean } = {},
  ): boolean {
    const { session, board } = this.requireWritableBoard(path);
    if (mutator(board) === false) return false;

    if (options.bumpRevision !== false) {
      board.revision = Math.max(board.revision + 1, session.baseline + 1);
    }

    session.dirty = true;
    if (session.state !== 'conflict') session.state = 'dirty';
    this.emit('changed', { path, board });

    if (options.immediate) {
      void this.flush(path);
    } else {
      this.scheduleSave(session);
    }
    return true;
  }

  /**
   * 只改视口：写入文件但**不递增 revision**（03 §3.2 W3，避免污染冲突检测）。
   *
   * ★ 刻意**不发 `changed` 事件**：视口是界面状态而非内容（03 §2.4），平移时每秒变几十次，
   *   广播出去会让卡片层整层重渲染 —— 02 §8.2「单容器 GPU 合成、平移缩放零重排」的前提就没了。
   *   渲染层想跟随视口，请直接订阅 `Viewport.onChange()`（T1.18 提供）。
   */
  updateView(path: string, view: Partial<BoardViewState>): void {
    const session = this.sessions.get(path);
    if (!session?.board) return;
    // 保护态：一个字节都不动（W6）
    if (session.state === 'readonly') return;

    session.board.view = { ...session.board.view, ...view };

    // 归档锁定（T4.06）：视口在本会话里照常跟随（用户还要看图、还要翻），但**不落盘**。
    // ★ 锁定说的是"别再改这个文件"，而视口恰恰是会写进文件的（03 §2.4）——
    //   放它落盘的话，"锁上之后只是翻了翻"也会产生新的文件字节，
    //   在多设备上就是一次纯噪声的同步（还可能催出冲突副本）。
    if (session.board.settings.readOnly) return;

    // 冲突未决：改动留在内存，但不排盘、不改状态，等用户三选一（否则会静默覆盖）
    if (session.state === 'conflict') return;

    session.dirty = true;
    session.state = 'dirty';
    this.scheduleSave(session);
  }

  /** 立即把指定白板落盘（并等待完成）。用户按下保存 / 失焦 / 卸载时调用 */
  async flush(path: string): Promise<void> {
    const session = this.sessions.get(path);
    if (!session) return;
    session.saveSchedule?.cancel();
    await this.queueSave(session);
  }

  /** 强制 flush 全部已打开的白板（T1.12 的兜底路径） */
  async flushAll(): Promise<void> {
    await Promise.all(this.openPaths().map((path) => this.flush(path)));
  }

  /**
   * 串行化同一块白板的写入。
   * 连续 mutate → flush 时，后来的调用排在已有写入之后，保证"最后一次改动一定被写到盘上"。
   */
  private queueSave(session: InternalSession): Promise<void> {
    const previous = session.inFlight ?? Promise.resolve();
    const next = previous.then(() => this.performSave(session));
    session.inFlight = next;
    return next;
  }

  private scheduleSave(session: InternalSession): void {
    if (!session.saveSchedule) {
      session.saveSchedule = debounce(() => {
        void this.queueSave(session);
      }, this.saveDebounceMs);
    }
    session.saveSchedule();
  }

  /** 真正的写盘：冲突检测 + 原子写。内部消化所有异常，绝不 reject */
  private async performSave(session: InternalSession): Promise<void> {
    const { path } = session;
    const board = session.board;
    // 只读保护态与冲突未决态都**不再尝试写入**：前者会毁数据，后者等用户三选一
    // （自动重试只会造成连环弹窗，见 03 §3.4）
    //
    // ★ 这里**只看 `state`，绝不能顺手加上 `settings.readOnly`**：归档锁定（T4.06）
    //   本身就是一次要写进文件的改动（`setLocked` 靠这一条路径把锁落到盘上），
    //   加进来会让"锁定/解锁"永远存不下去 —— 表现是"锁了，一重开又是可编辑的"。
    //   "锁定板不要被内容改动写到"这件事，由 `requireWritableBoard` 与
    //   `updateView` 各自在入口处拦掉，不在这里兜。
    if (!board || session.state === 'readonly' || session.state === 'conflict' || !session.dirty) {
      return;
    }

    board.meta.updatedAt = new Date(this.now()).toISOString();
    // 序列化单独计时（T2.17）：它是"全量 JSON.stringify"，大板上很容易成为写盘的大头
    const serializeStart = this.now();
    const payload = serializeBoard(board);
    const serializeMs = this.now() - serializeStart;
    // 记下**这份 payload 对应的** revision：写入期间还可能再来新改动，
    // 记成那一刻的 `board.revision` 会让诊断面板报出一个"没写进这份文件"的版本号
    const writtenRevision = board.revision;
    // 同理先固定 boardId：快照按它分目录，取"活对象"上的值同样可能已经漂移
    const writtenBoardId = board.meta.id;
    const expectedRevision = session.baseline;
    const force = session.forceOverwrite;
    const writeStart = this.now();

    session.dirty = false;
    session.state = 'saving';
    session.writing = true;
    this.writingPaths.add(path);

    try {
      await this.io.process(path, (raw) => {
        const trimmed = raw.trim();
        // 空文件 = 没有基线可比，直接写（新建文件 / 被外部清空的极端情况）
        if (trimmed.length > 0 && !force) {
          const disk = this.parseBoardText(raw);
          if (!disk.ok) throw new ConflictError('disk-unparsable', null, raw);
          if (disk.board.revision > expectedRevision) {
            throw new ConflictError('disk-newer', disk.board, raw);
          }
        }
        return payload;
      });

      session.baseline = board.revision;
      session.forceOverwrite = false;
      session.state = session.dirty ? 'dirty' : 'clean';
      this.emit('saved', { path, revision: board.revision });

      // 旁路通知（T4.01 快照）。再兜一层 try：观察者自己抛错也绝不能影响保存结果
      try {
        this.observer?.afterSave({
          path,
          boardId: writtenBoardId,
          revision: writtenRevision,
          text: payload,
        });
      } catch {
        // 快照是附加保护，不是保存的前提
      }
    } catch (error) {
      // ★ 写入失败：改动仍留在内存里，绝不丢（W6）
      session.dirty = true;

      if (error instanceof ConflictError) {
        session.state = 'conflict';
        this.emit('conflict', {
          path,
          disk: error.disk,
          mine: board,
          reason: error.reason,
        });
      } else {
        session.state = 'dirty';
        this.emit('error', { path, error: toError(error) });
      }
    } finally {
      const writeMs = this.now() - writeStart;
      session.lastSave = {
        serializeMs,
        writeMs,
        totalMs: serializeMs + writeMs,
        at: this.now(),
        revision: writtenRevision,
      };
      session.writing = false;
      this.writingPaths.delete(path);
      // 写入期间又有新改动 → 再排一次
      if (shouldRescheduleSave(session)) this.scheduleSave(session);
    }
  }

  /**
   * 最近一次写盘画像（T2.17 诊断面板）。没写过 / 路径没打开时返回 `null`。
   *
   * ★ 只读暴露：面板要回答"卡的是序列化还是磁盘"，这两段必须能分别看到。
   */
  statsOf(path: string): SaveStats | null {
    return this.sessions.get(path)?.lastSave ?? null;
  }

  // ── 冲突处理（T1.13） ─────────────────────────────────────

  /**
   * 磁盘上的白板被外部改动（03 §3.3 W4 / §3.4）。
   * 由 `main.ts` 挂在 `vault.on('modify')` 上，**自己写的写入会被忽略**。
   */
  handleExternalModify(path: string): void {
    if (this.writingPaths.has(path)) return;

    const session = this.sessions.get(path);
    if (!session) return;

    if (!session.reloadSchedule) {
      session.reloadSchedule = debounce(() => {
        void this.reloadNow(session);
      }, this.reloadDebounceMs);
    }
    session.reloadSchedule();
  }

  private async reloadNow(session: InternalSession): Promise<void> {
    if (session.writing) return;
    const { path } = session;

    let raw: string;
    try {
      raw = await this.io.read(path);
    } catch (error) {
      this.emit('error', { path, error: toError(error) });
      return;
    }

    const parsed = this.parseBoardText(raw);
    if (!parsed.ok) {
      if (session.board !== null) this.enterProtected(session, parsed.reason, raw);
      return;
    }

    // 磁盘不比我们的基线新 → 无实质变化（例如刚刚才由我们写入）
    if (parsed.board.revision <= session.baseline) return;

    if (session.dirty) {
      // 已经报过冲突（自动保存与外部改动可能同时到达）→ 不重复弹窗，等用户决策
      if (session.state === 'conflict') return;

      // 内存里有未保存改动：**不覆盖内存**，交给用户三选一
      session.state = 'conflict';
      this.emit('conflict', {
        path,
        disk: parsed.board,
        mine: session.board ?? parsed.board,
        reason: 'disk-newer',
      });
      return;
    }

    session.board = parsed.board;
    session.baseline = parsed.board.revision;
    session.issues = parsed.issues;
    session.state = 'clean';
    this.emit('changed', { path, board: parsed.board });
    this.emit('reloaded', { path, board: parsed.board, issues: parsed.issues });
  }

  /** 冲突选项①：用磁盘版本（放弃本地未保存改动） */
  async useDisk(path: string): Promise<void> {
    const session = this.sessions.get(path);
    if (!session) return;

    const raw = await this.io.read(path);
    const parsed = this.parseBoardText(raw);
    if (!parsed.ok) {
      this.enterProtected(session, parsed.reason, raw);
      return;
    }

    session.board = parsed.board;
    session.baseline = parsed.board.revision;
    session.issues = parsed.issues;
    session.dirty = false;
    session.forceOverwrite = false;
    session.state = 'clean';
    this.emit('changed', { path, board: parsed.board });
    this.emit('reloaded', { path, board: parsed.board, issues: parsed.issues });
  }

  /** 冲突选项②：保留我的修改（用户已明确，覆盖磁盘） */
  async keepMine(path: string): Promise<void> {
    const session = this.sessions.get(path);
    if (!session || !session.board) return;
    const board = session.board;

    // ★ 覆盖前把 revision 推到磁盘版本之上：否则我们写下去的 revision 比磁盘旧，
    //   下一次保存会再次判为冲突（"永远修不好的冲突"）。
    try {
      const disk = this.parseBoardText(await this.io.read(path));
      if (disk.ok) board.revision = Math.max(board.revision, disk.board.revision + 1);
    } catch {
      // 读不到磁盘内容：保持原 revision，交给 process 内的强制写入
    }

    session.forceOverwrite = true;
    session.dirty = true;
    session.state = 'dirty';
    await this.flush(path);
  }

  /**
   * 从快照恢复（T4.02 / `F11-11`）。
   *
   * ★ 恢复**不是**"把旧文件复制回去"，而是把快照内容当作**一次新的编辑**写下去：
   *   revision 要推到磁盘版本之上 —— 否则写下去的 revision 比磁盘旧，
   *   下一次自动保存立刻又被判成冲突，症状是"恢复完就再也存不上"。
   *
   * ★ 这里**只要求 session 存在**，不要求 `session.board` 非空：保护态（W6，
   *   磁盘文件解析失败）正是最需要"从快照恢复"的场景，而那时内存模型是空的。
   *
   * ★ "恢复前先自动打一份快照"由 UI 层负责（需要 `SnapshotStore`），
   *   repository 不该认识快照存储。
   */
  async restoreFromText(path: string, raw: string): Promise<void> {
    const outcome = this.parseBoardText(raw);
    if (!outcome.ok) throw new Error(`快照内容无法解析（${outcome.reason}）`);
    await this.restore(path, outcome.board);
  }

  async restore(path: string, snapshot: BoardFile): Promise<void> {
    const session = this.sessions.get(path);
    if (!session) throw new Error(`白板尚未打开：${path}`);

    const next: BoardFile = {
      ...snapshot,
      meta: { ...snapshot.meta, updatedAt: new Date(this.now()).toISOString() },
    };
    // 与 `keepMine` 同一条理由：写下去的 revision 必须比磁盘新
    try {
      const disk = this.parseBoardText(await this.io.read(path));
      if (disk.ok) next.revision = Math.max(next.revision, disk.board.revision + 1);
    } catch {
      // 读不到磁盘内容（或文件不存在）：保持快照自己的 revision，交给强制写入
    }

    session.board = next;
    session.rawText = null;
    session.issues = [];
    session.forceOverwrite = true;
    session.dirty = true;
    session.state = 'dirty';
    this.emit('changed', { path, board: next });
    await this.flush(path);
  }

  /**
   * 冲突选项③：另存为副本 —— **本地改动先落进副本文件**（保证不丢），
   * 再把内存切回磁盘版本。`copyPath` 由调用方保证不冲突。
   */
  async saveAsCopy(path: string, copyPath: string): Promise<void> {
    const session = this.sessions.get(path);
    if (!session || !session.board) throw new Error(`白板尚未打开：${path}`);
    const copy = {
      ...session.board,
      meta: { ...session.board.meta, updatedAt: new Date(this.now()).toISOString() },
    };
    await this.io.create(copyPath, serializeBoard(copy));
    await this.useDisk(path);
  }

  // ── 新建 / 关闭 ───────────────────────────────────────────

  /** 新建白板文件并直接接管为当前会话（不经过磁盘读回） */
  async createBoard(path: string, board: BoardFile): Promise<void> {
    await this.io.create(path, serializeBoard(board));

    const session = this.createSession(path);
    session.board = board;
    session.baseline = board.revision;
    session.state = 'clean';
    this.sessions.set(path, session);
    this.emit('changed', { path, board });
  }

  /** 关闭会话（不落盘；调用方应先 `flush`） */
  close(path: string): void {
    const session = this.sessions.get(path);
    if (!session) return;
    session.saveSchedule?.cancel();
    session.reloadSchedule?.cancel();
    this.sessions.delete(path);
  }

  /** 卸载：取消全部计时器、清空监听。磁盘上该有的一定已经落盘（`main.ts` 先 flushAll） */
  dispose(): void {
    for (const session of this.sessions.values()) {
      session.saveSchedule?.cancel();
      session.reloadSchedule?.cancel();
    }
    this.sessions.clear();
    this.listeners.clear();
    this.writingPaths.clear();
  }

  // ── 内部工具 ──────────────────────────────────────────────

  private requireWritableBoard(path: string): { session: InternalSession; board: BoardFile } {
    const session = this.sessions.get(path);
    if (!session) throw new Error(`白板尚未打开：${path}`);
    if (session.state === 'readonly' || session.board === null) {
      throw new Error(`白板处于只读保护态，拒绝修改：${path}`);
    }
    if (session.board.settings.readOnly) {
      throw new Error(`白板已被锁定为只读：${path}`);
    }
    return { session, board: session.board };
  }

  private enterProtected(session: InternalSession, reason: ProtectedReason, raw?: string): void {
    session.state = 'readonly';
    session.dirty = false;
    if (raw !== undefined) session.rawText = raw;
    session.saveSchedule?.cancel();
    session.reloadSchedule?.cancel();
    this.emit('protected', { path: session.path, reason });
  }
}

/** 保存结束后是否需要再排一次。冲突态 / 保护态**不自动重试**，等用户决策（W6） */
function shouldRescheduleSave(session: InternalSession): boolean {
  return session.dirty && session.state !== 'conflict' && session.state !== 'readonly';
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(describeError(error));
}
