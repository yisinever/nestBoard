/**
 * MindRepository —— `.nestmind` 的唯一读写入口（`06 §9` P1）。
 *
 * 与 `io/BoardRepository.ts` **同六条规则**（`03 §3` 的 W1–W6），逐条对齐 ——
 * 这是全项目最容易造成数据丢失的一层，所以规则一条都不能少：
 *
 * | 规则 | 本文件中的落点 |
 * |---|---|
 * | W1 用 `vault.process` 原子写 | `performSave` → `io.process` |
 * | W2 绝不原地截断 | 同上（`process` 内部保证读写之间文件不被他人改动） |
 * | W3 视口变化不递增 revision | `updateView()` |
 * | W4 外部改动 → 重载内存 | `handleExternalModify()` + `writingPaths` 自我写入识别 |
 * | W5 失焦 / 卸载强制 flush | `flush()` / `flushAll()`（由 `main.ts` 挂事件） |
 * | W6 解析失败绝不覆盖 | `enterProtected()` → `state: 'readonly'`，之后 `mutate` 直接抛错 |
 *
 * ★ **为什么抄一份而不是把 `BoardRepository` 泛型化**：那一份是风险最高的代码，
 *   为了"少写几百行"去动它，风险与收益不成比例。两份是同一套规则的**独立实现**，
 *   等两边都跑稳了再谈合并（`06 §7`：先明确，后合并）。
 * ★ 与白板的**三处差别**，都是"脑图还没有那一项"而不是"这里可以松一点"：
 *   ① 类型是 `MindFile`；② 没有归档锁定（`settings.readOnly`，脑图没有这个开关）；
 *   ③ 没有迁移路径（`migrateMindFile` 等第一次改格式时再写，于是保护态的理由里
 *      没有 `future-version` / `no-migration-path`）。
 * ★ 模块约束：**不得 import `view/`**，也不得直接 import `obsidian`（走 `VaultIO` 端口）。
 */

import { DEFAULT_AUTOSAVE_DEBOUNCE_MS, DEFAULT_RELOAD_DEBOUNCE_MS } from '../../constants';
import type { ValidationIssue } from '../../model/validate';
import type { VaultIO } from '../../io/vaultIO';
import { debounce, type Debounced } from '../../util/debounce';
import { describeError } from '../../util/errors';
import type { MindFile, MindViewState } from '../model/schema';
import { normalizeMindFile, safeJsonParse } from '../model/validate';
import { serializeMindFile } from './serialize';

// ─────────────────────────────────────────────────────────────
// 公开类型
// ─────────────────────────────────────────────────────────────

export type MindState = 'clean' | 'dirty' | 'saving' | 'conflict' | 'readonly';

/** 需要用户决策的冲突原因 */
export type MindConflictReason =
  /** 磁盘 revision 比我们的基线更新（多设备 / 外部编辑器改过） */
  | 'disk-newer'
  /** 磁盘文件已损坏到无法解析，但我们内存里有内容 —— 拒绝盲写 */
  | 'disk-unparsable';

/** 进入只读保护态的原因（对应 `03 §3.2` W6） */
export type MindProtectedReason = 'invalid-json' | 'not-a-mind' | 'read-failed';

export interface MindRepositoryEvents {
  /** 内存模型就绪或发生变更（`open()` 成功、`mutate()`、外部重载都会触发） */
  changed: { path: string; mind: MindFile };
  /** 成功写入磁盘 */
  saved: { path: string; revision: number };
  /** 磁盘被外部修改且与本地状态冲突 → 必须由用户决策，插件不自行覆盖 */
  conflict: {
    path: string;
    disk: MindFile | null;
    mine: MindFile;
    reason: MindConflictReason;
  };
  /** 磁盘内容被重新载入内存（外部编辑的正常同步路径） */
  reloaded: { path: string; mind: MindFile; issues: ValidationIssue[] };
  /** 进入只读保护态 */
  protected: { path: string; reason: MindProtectedReason };
  error: { path: string; error: Error };
}

type EventListener = (payload: never) => void;

export interface MindRepositoryOptions {
  saveDebounceMs?: number;
  reloadDebounceMs?: number;
  /** 注入时钟，仅为可测试性 */
  now?: () => number;
  /**
   * 写盘成功后的**旁路**观察者（快照 / 备份）。
   *
   * ★ 与白板那份同一条：单向通知、不 await、不返回错误 —— 快照慢或失败绝不该
   *   拖慢更不该阻断保存本身。
   * ★ 字段叫 `mindId`（白板那份叫 `boardId`）：两边各自独立，`main.ts` 里那三行
   *   适配代码是刻意的 —— 让两种文档在**类型上**也不共用一条通道，免得将来
   *   某一方多加一个字段时另一方被动跟着改。
   */
  observer?: MindSaveObserver;
}

export interface MindSaveObserver {
  afterSave(payload: { path: string; mindId: string; revision: number; text: string }): void;
}

/** 冲突：`process` 的 transform 抛出它 → Obsidian 放弃写入（W1 的原子性保障） */
export class MindConflictError extends Error {
  constructor(
    readonly reason: MindConflictReason,
    readonly disk: MindFile | null,
    readonly diskText: string | null,
  ) {
    super(`mind-conflict:${reason}`);
    this.name = 'MindConflictError';
  }
}

interface InternalSession {
  /** ★ 可变：文件被重命名 / 移动时 session 要跟着换 key（见 `movePath`） */
  path: string;
  mind: MindFile | null;
  /** 解析失败时保留原始文本，供"查看原始文件" */
  rawText: string | null;
  /** 最近一次与磁盘一致的 revision */
  baseline: number;
  state: MindState;
  issues: ValidationIssue[];
  dirty: boolean;
  writing: boolean;
  /** 用户已明确选择「保留我的修改」→ 本次写入跳过冲突检测 */
  forceOverwrite: boolean;
  inFlight: Promise<void> | null;
  saveSchedule: Debounced | null;
  reloadSchedule: Debounced | null;
}

type ParseOutcome =
  | { ok: true; mind: MindFile; issues: ValidationIssue[] }
  | { ok: false; reason: MindProtectedReason };

/** 与 `io/BoardRepository` 里那个同名小函数一致：把 `unknown` 收成 `Error`（事件 payload 要它） */
function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * 一次写入收尾之后，要不要再排一次保存。
 *
 * ★ 抽成独立函数有两个理由：白板那份也是这么写的（两边同构，好对照）；
 *   而且**在函数里 `session.state` 是声明的联合类型**，不会被调用点的控制流收窄 ——
 *   写在 `performSave` 的 `finally` 里，TS 会认为"这里不可能是 readonly"并报无重叠比较，
 *   可 `await` 期间确实可能有别的路径（外部改动读到坏文件）把它翻成保护态。
 */
function shouldRescheduleSave(session: InternalSession): boolean {
  if (!session.dirty) return false;
  // 保护态与冲突未决态都不再自动重试：前者会毁数据，后者等用户三选一（03 §3.4）
  return session.state !== 'readonly' && session.state !== 'conflict';
}

// ─────────────────────────────────────────────────────────────
// Repository
// ─────────────────────────────────────────────────────────────

export class MindRepository {
  private readonly sessions = new Map<string, InternalSession>();
  private readonly listeners = new Map<keyof MindRepositoryEvents, Set<EventListener>>();

  /**
   * 自己发起写入的路径集合（`03 §3.3`）。
   * `vault.process()` 同样会触发 `vault.on('modify')`，靠它区分"我写的"和"别人改的"。
   */
  readonly writingPaths = new Set<string>();

  private saveDebounceMs: number;
  private readonly reloadDebounceMs: number;
  private readonly now: () => number;
  private readonly observer: MindSaveObserver | undefined;

  constructor(
    private readonly io: VaultIO,
    options: MindRepositoryOptions = {},
  ) {
    this.saveDebounceMs = options.saveDebounceMs ?? DEFAULT_AUTOSAVE_DEBOUNCE_MS;
    this.reloadDebounceMs = options.reloadDebounceMs ?? DEFAULT_RELOAD_DEBOUNCE_MS;
    this.now = options.now ?? ((): number => Date.now());
    this.observer = options.observer;
  }

  // ── 事件 ──────────────────────────────────────────────────

  on<K extends keyof MindRepositoryEvents>(
    event: K,
    listener: (payload: MindRepositoryEvents[K]) => void,
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

  private emit<K extends keyof MindRepositoryEvents>(
    event: K,
    payload: MindRepositoryEvents[K],
  ): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const listener of [...set]) {
      try {
        (listener as unknown as (p: MindRepositoryEvents[K]) => void)(payload);
      } catch (error) {
        console.warn(`[nestboard] 脑图事件监听器抛错（${event}）`, describeError(error));
      }
    }
  }

  // ── 读路径 ────────────────────────────────────────────────

  /** 打开一份脑图：磁盘 → 规范化 → 内存模型。已打开则直接返回内存模型 */
  async open(path: string): Promise<MindFile | null> {
    const existing = this.sessions.get(path);
    if (existing) return existing.mind;

    const session = this.createSession(path);
    this.sessions.set(path, session);
    await this.loadFromDisk(session, true);
    return session.mind;
  }

  get(path: string): MindFile | null {
    return this.sessions.get(path)?.mind ?? null;
  }

  getState(path: string): MindState | null {
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

  /** 此刻是否**拒绝一切内容写入**（视图层的唯一判据） */
  isReadOnly(path: string): boolean {
    return this.lockReason(path) !== null;
  }

  /**
   * 只读的**原因**：`null` = 可以写。
   *
   * ★ 脑图目前只有一种只读来源：保护态（W6）。白板多一种"用户自己锁的归档板"，
   *   等脑图也有那个开关时，这里加一档即可 —— 判"能不能改"的调用方**一个字都不用改**
   *   （它们问的都是 `isReadOnly`）。
   */
  lockReason(path: string): 'protected' | null {
    const session = this.sessions.get(path);
    if (!session) return null;
    // 会话已建、模型还没装好（`open` 的 await 期间）：此刻写下去就是写空文件
    if (session.state === 'readonly' || session.mind === null) return 'protected';
    return null;
  }

  openPaths(): string[] {
    return [...this.sessions.keys()];
  }

  /**
   * 脑图文件被重命名 / 移动。
   *
   * ★ 必须把 session 一起搬到新 key：不搬的话视图按**新路径** `get()` 会拿到 `null`
   *   （画布当场变空），而旧 key 上的防抖仍会往一个**已经不存在的路径**写盘。
   * ★ 用"改 `path` 字段"而不是"关掉旧的再开新的"：后者会丢掉还没落盘的脏数据。
   */
  movePath(oldPath: string, newPath: string): void {
    if (oldPath === newPath) return;
    const session = this.sessions.get(oldPath);
    // 目标已被占用说明新旧路径的推导有问题：宁可不搬（搬了会顶掉另一份脑图的内存模型）
    if (!session || this.sessions.has(newPath)) return;
    this.sessions.delete(oldPath);
    session.path = newPath;
    this.sessions.set(newPath, session);
  }

  /**
   * 关掉一份脑图的会话（文件被删除时用）。
   *
   * ★ **不落盘**：文件都没了，写回去就是把它复活。挂起的定时器与防抖必须一起收掉，
   *   否则它们会在几秒后对着一个不存在的路径重试。
   */
  close(path: string): void {
    const session = this.sessions.get(path);
    if (!session) return;
    session.saveSchedule?.cancel();
    session.reloadSchedule?.cancel();
    this.sessions.delete(path);
  }

  /** 更新自动保存间隔（设置项改了就生效） */
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

  /** 释放全部资源（插件卸载时）：定时器一个都不留 */
  dispose(): void {
    for (const session of this.sessions.values()) {
      session.saveSchedule?.cancel();
      session.reloadSchedule?.cancel();
    }
    this.sessions.clear();
    this.listeners.clear();
  }

  private createSession(path: string): InternalSession {
    return {
      path,
      mind: null,
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

    const parsed = this.parseMindText(raw);
    if (!parsed.ok) {
      this.enterProtected(session, parsed.reason, raw);
      return;
    }

    session.mind = parsed.mind;
    session.rawText = null;
    session.baseline = parsed.mind.revision;
    session.issues = parsed.issues;
    session.state = 'clean';
    session.dirty = false;
    this.emit('changed', { path: session.path, mind: parsed.mind });
    if (!initial) {
      this.emit('reloaded', { path: session.path, mind: parsed.mind, issues: parsed.issues });
    }
  }

  /** 磁盘文本 → 内存模型。**只读不写**，任何失败都只返回原因，由调用方决定是否保护 */
  private parseMindText(raw: string): ParseOutcome {
    const json = safeJsonParse(raw);
    if (!json.ok) return { ok: false, reason: 'invalid-json' };

    const normalized = normalizeMindFile(json.value);
    if (!normalized.ok) return { ok: false, reason: 'not-a-mind' };

    return { ok: true, mind: normalized.file, issues: normalized.issues };
  }

  /**
   * 进只读保护态（W6）：**一个字节都不再写**。
   *
   * ★ 保留 `rawText`：用户想"看看原始文件坏在哪"或"从快照恢复"时，那是唯一的来源。
   * ★ 已经读过一次的板子（`mind !== null`）也照进保护态：内存里的内容可能是好的，
   *   但磁盘上已经坏了 —— 这时候写回去就是拿我们的版本顶掉用户的文件，
   *   而用户可能正在另一个编辑器里修它。
   */
  private enterProtected(session: InternalSession, reason: MindProtectedReason, raw = ''): void {
    session.state = 'readonly';
    session.rawText = raw.length > 0 ? raw : session.rawText;
    session.saveSchedule?.cancel();
    session.saveSchedule = null;
    session.dirty = false;
    this.emit('protected', { path: session.path, reason });
  }

  // ── 写路径 ────────────────────────────────────────────────

  /**
   * 变更内存模型。
   * - 默认**递增 revision**；视口变更请用 `updateView()`（W3）
   * - `immediate: true` 跳过节流直接落盘（破坏性操作 / 关闭前）
   *
   * ★ `mutator` 返回 `false` 表示"这次什么都没改"：此时**不递增 revision、不标脏、
   *   不发事件、不排盘**。返回别的值（含 `void`）一律按"改过了"处理。
   *
   * @returns 是否真的产生了变更
   */
  mutate(
    path: string,
    mutator: (mind: MindFile) => void | boolean,
    options: { bumpRevision?: boolean; immediate?: boolean } = {},
  ): boolean {
    const { session, mind } = this.requireWritableMind(path);
    if (mutator(mind) === false) return false;

    if (options.bumpRevision !== false) {
      mind.revision = Math.max(mind.revision + 1, session.baseline + 1);
    }

    session.dirty = true;
    if (session.state !== 'conflict') session.state = 'dirty';
    this.emit('changed', { path, mind });

    if (options.immediate) void this.flush(path);
    else this.scheduleSave(session);
    return true;
  }

  /**
   * 只改视口：写入文件但**不递增 revision**（W3，避免污染冲突检测）。
   *
   * ★ 刻意**不发 `changed` 事件**：视口是界面状态而非内容，平移时每秒变几十次，
   *   广播出去会让整棵脑图重渲染。想跟随视口的渲染层直接改 CSS 变量即可
   *   （与白板那边"订阅 `Viewport.onChange()`"同一个取舍）。
   */
  updateView(path: string, view: Partial<MindViewState>): void {
    const session = this.sessions.get(path);
    if (!session?.mind) return;
    if (session.state === 'readonly') return; // 保护态：一个字节都不动（W6）
    session.mind.view = { ...session.mind.view, ...view };

    // 冲突未决：改动留在内存，但不排盘、不改状态，等用户三选一
    if (session.state === 'conflict') return;

    session.dirty = true;
    session.state = 'dirty';
    this.scheduleSave(session);
  }

  /** 立即把指定脑图落盘（并等待完成）。关闭 / 失焦 / 卸载时调用 */
  async flush(path: string): Promise<void> {
    const session = this.sessions.get(path);
    if (!session) return;
    session.saveSchedule?.cancel();
    await this.queueSave(session);
  }

  /** 强制 flush 全部已打开的脑图（W5 的兜底路径） */
  async flushAll(): Promise<void> {
    await Promise.all(this.openPaths().map((path) => this.flush(path)));
  }

  private requireWritableMind(path: string): { session: InternalSession; mind: MindFile } {
    const session = this.sessions.get(path);
    if (!session) throw new Error(`脑图未打开：${path}`);
    // ★ 保护态**先判**：解析失败时内存里也没有模型，两条都成立 ——
    //   但"为什么不能写"对人有用的是前者（"去看那个坏文件 / 从快照恢复"），
    //   而不是"脑图还没装好"这种像内部状态的描述。
    // ★ 抛错而不是静默忽略：静默会让调用方以为写成功了，
    //   而"以为写成功"正是保护态最不能容忍的误判
    if (session.state === 'readonly') {
      throw new Error(`脑图处于只读保护态，拒绝写入：${path}`);
    }
    if (!session.mind) throw new Error(`脑图还没装好：${path}`);
    return { session, mind: session.mind };
  }

  /**
   * 串行化同一份脑图的写入。
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
    const mind = session.mind;
    // 保护态与冲突未决态都**不再尝试写入**：前者会毁数据，后者等用户三选一
    if (!mind || session.state === 'readonly' || session.state === 'conflict' || !session.dirty) {
      return;
    }

    mind.meta.updatedAt = new Date(this.now()).toISOString();
    const payload = serializeMindFile(mind);
    // 记下**这份 payload 对应的** revision 与 id：写入期间还可能再来新改动
    const writtenRevision = mind.revision;
    const writtenMindId = mind.meta.id;
    const expectedRevision = session.baseline;
    const force = session.forceOverwrite;

    session.dirty = false;
    session.state = 'saving';
    session.writing = true;
    this.writingPaths.add(path);

    try {
      await this.io.process(path, (raw) => {
        const trimmed = raw.trim();
        // 空文件 = 没有基线可比，直接写（新建文件 / 被外部清空的极端情况）
        if (trimmed.length > 0 && !force) {
          const disk = this.parseMindText(raw);
          if (!disk.ok) throw new MindConflictError('disk-unparsable', null, raw);
          if (disk.mind.revision > expectedRevision) {
            throw new MindConflictError('disk-newer', disk.mind, raw);
          }
        }
        return payload;
      });

      session.baseline = mind.revision;
      session.forceOverwrite = false;
      session.state = session.dirty ? 'dirty' : 'clean';
      this.emit('saved', { path, revision: mind.revision });

      // 旁路通知（快照 / 备份）。再兜一层 try：观察者自己抛错也绝不能影响保存结果
      try {
        this.observer?.afterSave({
          path,
          mindId: writtenMindId,
          revision: writtenRevision,
          text: payload,
        });
      } catch {
        // 快照是附加保护，不是保存的前提
      }
    } catch (error) {
      // ★ 写入失败：改动仍留在内存里，绝不丢（W6）
      session.dirty = true;

      if (error instanceof MindConflictError) {
        session.state = 'conflict';
        this.emit('conflict', {
          path,
          disk: error.disk,
          mine: mind,
          reason: error.reason,
        });
      } else {
        session.state = 'dirty';
        this.emit('error', { path, error: toError(error) });
      }
    } finally {
      session.writing = false;
      this.writingPaths.delete(path);
      // 写入期间又有新改动 → 再排一次
      if (shouldRescheduleSave(session)) this.scheduleSave(session);
    }
  }

  // ── 冲突处理 ─────────────────────────────────────────────

  /**
   * 磁盘上的脑图被外部改动（W4）。由 `main.ts` 挂在 `vault.on('modify')` 上，
   * **自己写的写入会被忽略**。
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

    const parsed = this.parseMindText(raw);
    if (!parsed.ok) {
      if (session.mind !== null) this.enterProtected(session, parsed.reason, raw);
      return;
    }

    // 磁盘不比我们的基线新 → 无实质变化（例如刚刚才由我们写入）
    if (parsed.mind.revision <= session.baseline) return;

    if (session.dirty) {
      // 已经报过冲突 → 不重复弹窗，等用户决策
      if (session.state === 'conflict') return;

      // 内存里有未保存改动：**不覆盖内存**，交给用户三选一
      session.state = 'conflict';
      this.emit('conflict', {
        path,
        disk: parsed.mind,
        mine: session.mind ?? parsed.mind,
        reason: 'disk-newer',
      });
      return;
    }

    session.mind = parsed.mind;
    session.baseline = parsed.mind.revision;
    session.issues = parsed.issues;
    session.state = 'clean';
    this.emit('changed', { path, mind: parsed.mind });
    this.emit('reloaded', { path, mind: parsed.mind, issues: parsed.issues });
  }

  /** 冲突选项①：用磁盘版本（放弃本地未保存改动） */
  async useDisk(path: string): Promise<void> {
    const session = this.sessions.get(path);
    if (!session) return;

    const raw = await this.io.read(path);
    const parsed = this.parseMindText(raw);
    if (!parsed.ok) {
      this.enterProtected(session, parsed.reason, raw);
      return;
    }

    session.mind = parsed.mind;
    session.baseline = parsed.mind.revision;
    session.issues = parsed.issues;
    session.dirty = false;
    session.forceOverwrite = false;
    session.state = 'clean';
    this.emit('changed', { path, mind: parsed.mind });
    this.emit('reloaded', { path, mind: parsed.mind, issues: parsed.issues });
  }

  /** 冲突选项②：保留我的修改（用户已明确，覆盖磁盘） */
  async keepMine(path: string): Promise<void> {
    const session = this.sessions.get(path);
    if (!session?.mind) return;
    const mind = session.mind;

    // ★ 覆盖前把 revision 推到磁盘版本之上：否则写下去的 revision 比磁盘旧，
    //   下一次保存会再次判为冲突（"永远修不好的冲突"）
    try {
      const disk = this.parseMindText(await this.io.read(path));
      if (disk.ok) mind.revision = Math.max(mind.revision, disk.mind.revision + 1);
    } catch {
      // 读不到磁盘内容：保持原 revision，交给 process 内的强制写入
    }

    session.forceOverwrite = true;
    session.dirty = true;
    session.state = 'dirty';
    await this.flush(path);
  }

  /**
   * 冲突选项③：**另存为副本**（`03 §3.4` 里最安全的一条，P3-c-2）。
   *
   * 顺序不可换：**先**把内存里这一份写到副本，**再**把内存切回磁盘版本（`useDisk`）。
   * 反过来的话，切回磁盘之后内存里已经没有"我的那一份"可写了 —— 用户刚做的改动
   * 会在他眼皮底下凭空消失。
   *
   * `copyPath` 由调用方保证不冲突（沿用白板那边的 `findFreeCopyPath` 做法：
   * 带时间戳 + 序号试到不撞为止）。
   */
  async saveAsCopy(path: string, copyPath: string): Promise<void> {
    const session = this.sessions.get(path);
    if (!session?.mind) throw new Error(`脑图尚未打开：${path}`);
    const copy: MindFile = {
      ...session.mind,
      meta: { ...session.mind.meta, updatedAt: new Date(this.now()).toISOString() },
    };
    await this.io.create(copyPath, serializeMindFile(copy));
    await this.useDisk(path);
  }
}
