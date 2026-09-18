/**
 * SnapshotStore —— 白板版本快照（T4.01 / `F11-11`，03 §3.5）。
 *
 * 这是"用户误删了一屏卡片、两小时后才发现"时唯一能救命的东西（风险表 R5），
 * 所以设计上偏保守：**默认开启**、写盘成功就评估一次、淘汰时永远保留最新一份。
 *
 * 模块约束（与 `BoardRepository` 同）：**不得 import `obsidian`**，
 * 文件能力走 `SnapshotIO` 端口 —— 这样淘汰策略、触发节奏、文件名解析都能在
 * node 下直接用内存实现测，而不必启动 Obsidian。
 *
 * ★ 为什么单独开一个 `SnapshotIO` 而不复用 `VaultIO`：
 *   快照默认落在 `.obsidian/plugins/nestboard/snapshots/`，而 Obsidian 的文件索引
 *   **不收** `.obsidian` 与任何以 `.` 开头的目录（03 §1.4）—— `VaultIO` 那套
 *   `getAbstractFileByPath` 在这里必然返回 null。所以快照走 adapter 直读直写。
 *
 * 存储结构：`<root>/<boardId>/<ISO时间戳>.nboard`
 *   `2026-09-12T10-00-00Z.nboard`（文件名不能含 `:`，见 `snapshotFileName`）
 */

import {
  BOARD_EXT,
  SNAPSHOT_MAX_BYTES,
  SNAPSHOT_MAX_COUNT,
  SNAPSHOT_MIN_INTERVAL_MS,
} from '../constants';
import type { BoardSaveObserver } from './BoardRepository';

// ─────────────────────────────────────────────────────────────
// 端口与类型
// ─────────────────────────────────────────────────────────────

/**
 * 快照的文件能力。
 *
 * ★ 全部是**裸路径**（Vault 相对），与 `VaultIO` 的"库内文件"语义不同：
 *   这里允许指向 `.obsidian/` 之类不在索引里的位置。
 */
export interface SnapshotIO {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  /** 覆盖写；文件名唯一（时间戳），不需要 `create` 的"已存在就抛"语义。父目录不存在时自行补齐 */
  write(path: string, data: string): Promise<void>;
  /** 列出一个目录下的**文件名**（不递归、不含子目录）；目录不存在时返回空数组 */
  listFiles(folder: string): Promise<string[]>;
  remove(path: string): Promise<void>;
  /** 文件字节数；不存在时返回 `null` */
  size(path: string): Promise<number | null>;
}

/** 一份快照的元信息（由文件名 + 文件内容推导，不含全文） */
export interface SnapshotRecord {
  /** 快照文件路径 */
  path: string;
  boardId: string;
  /** 拍摄时间（epoch ms，从文件名解析） */
  capturedAt: number;
  /** 卡片数；内容读不出来时为 `null` */
  cardCount: number | null;
  /** 文件字节数；取不到时为 0 */
  bytes: number;
}

export interface SnapshotStoreOptions {
  /** 快照根目录（Vault 相对路径）。做函数是因为设置里可以切换位置 */
  root: () => string;
  /** 是否启用；关闭时不再产生新快照，**已有快照原样保留** */
  enabled: () => boolean;
  minIntervalMs?: number;
  maxCount?: number;
  maxBytes?: number;
  now?: () => number;
}

// ─────────────────────────────────────────────────────────────
// 纯函数（策略都在这里，方便单测）
// ─────────────────────────────────────────────────────────────

/** 文件名里的时间戳：`2026-09-12T10-00-00Z`（`:` 换成 `-`，因为 Windows 文件名不允许冒号） */
export function snapshotFileName(at: number): string {
  const iso = new Date(at).toISOString().replace(/\.\d{3}Z$/, 'Z');
  return `${iso.replace(/:/g, '-')}.${BOARD_EXT}`;
}

/** `2026-09-12T10-00-00Z.nboard`（允许 `-2` 这样的重名后缀）→ epoch ms；认不出返回 null */
export function parseSnapshotTime(fileName: string): number | null {
  const matched = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})Z(?:-\d+)?\.nboard$/.exec(
    fileName,
  );
  if (!matched) return null;
  const at = Date.parse(
    `${matched[1]}-${matched[2]}-${matched[3]}T${matched[4]}:${matched[5]}:${matched[6]}Z`,
  );
  return Number.isFinite(at) ? at : null;
}

/**
 * 现在该不该打一份快照？
 *
 * 三条规则（03 §3.5）：
 * 1. 关了就永远不打；
 * 2. **一份都没有时立刻打** —— 否则新用户要等够 5 分钟才有第一份基线，
 *    而"刚建完板就误删"恰恰是最高频的丢数据场景；
 * 3. 其余情况要同时满足「距上次 ≥ 间隔」且「revision 变过」——
 *    只看时间会在空转时堆出一串一模一样的快照，只看 revision 会在拖动过程中疯狂写盘。
 */
export function shouldCaptureSnapshot(input: {
  enabled: boolean;
  now: number;
  minIntervalMs: number;
  last: { capturedAt: number; revision: number } | null;
  revision: number;
}): boolean {
  if (!input.enabled) return false;
  if (!input.last) return true;
  if (input.last.revision === input.revision) return false;
  return input.now - input.last.capturedAt >= input.minIntervalMs;
}

/**
 * 算出该删哪些快照。返回的路径调用方负责删。
 *
 * 两条淘汰线：**份数**（超过 `maxCount` 的最旧的）+ **总体积**（从最旧删到 ≤ `maxBytes`）。
 * ★ 两条线都**永远保留最新一份**：一块 10000 卡的板单份快照就可能超过 20MB，
 *   纯按体积删会一路删到空 —— 那等于把救命的东西删了。
 */
export function planSnapshotEviction(
  records: readonly SnapshotRecord[],
  limits: { maxCount: number; maxBytes: number },
): string[] {
  if (records.length === 0) return [];

  const newestFirst = [...records].sort((a, b) => b.capturedAt - a.capturedAt);
  const doomed = new Set<string>();

  for (const record of newestFirst.slice(Math.max(1, limits.maxCount))) {
    doomed.add(record.path);
  }

  const survivors = newestFirst.filter((record) => !doomed.has(record.path));
  let total = survivors.reduce((sum, record) => sum + record.bytes, 0);
  for (let i = survivors.length - 1; i >= 1 && total > limits.maxBytes; i--) {
    doomed.add(survivors[i].path);
    total -= survivors[i].bytes;
  }

  return [...doomed];
}

// ─────────────────────────────────────────────────────────────
// Store
// ─────────────────────────────────────────────────────────────

export class SnapshotStore {
  /** 每块板"最近一次快照"的缓存，省掉每次保存都去列目录 */
  private readonly recent = new Map<string, { capturedAt: number; revision: number }>();
  private readonly now: () => number;
  private readonly minIntervalMs: number;
  private readonly maxCount: number;
  private readonly maxBytes: number;

  constructor(
    private readonly io: SnapshotIO,
    private readonly options: SnapshotStoreOptions,
  ) {
    this.now = options.now ?? ((): number => Date.now());
    this.minIntervalMs = options.minIntervalMs ?? SNAPSHOT_MIN_INTERVAL_MS;
    this.maxCount = options.maxCount ?? SNAPSHOT_MAX_COUNT;
    this.maxBytes = options.maxBytes ?? SNAPSHOT_MAX_BYTES;
  }

  /** 直接挂给 `BoardRepository` 的观察者口子（写盘成功后评估一次） */
  readonly observer: BoardSaveObserver = {
    afterSave: ({ boardId, revision, text }) => {
      // ★ 快照是**旁路**：任何失败都不能冒泡回保存流程（否则等于"快照坏了就不让存盘"）
      void this.captureIfDue(boardId, revision, text).catch(() => undefined);
    },
  };

  /** 设置里的开关 / 位置变了时调用：清掉"最近一次"缓存，让新位置重新扫描 */
  invalidate(): void {
    this.recent.clear();
  }

  /** 保存后按节奏决定要不要打；返回实际打下的那一条（没打则 null） */
  async captureIfDue(
    boardId: string,
    revision: number,
    text: string,
  ): Promise<SnapshotRecord | null> {
    const last = await this.lastOf(boardId);
    const due = shouldCaptureSnapshot({
      enabled: this.options.enabled(),
      now: this.now(),
      minIntervalMs: this.minIntervalMs,
      last,
      revision,
    });
    if (!due) return null;
    return this.capture(boardId, revision, text);
  }

  /** 手动"创建快照"：不看节奏，直接打一份 */
  async capture(boardId: string, revision: number, text: string): Promise<SnapshotRecord> {
    const at = this.now();
    const folder = this.folderOf(boardId);
    const path = await this.uniquePath(folder, snapshotFileName(at));

    await this.io.write(path, text);
    this.recent.set(boardId, { capturedAt: at, revision });

    const record: SnapshotRecord = {
      path,
      boardId,
      capturedAt: at,
      cardCount: countCards(text),
      bytes: byteLength(text),
    };
    await this.prune(boardId);
    return record;
  }

  /** 列出某块板的快照，**新 → 旧** */
  async list(boardId: string): Promise<SnapshotRecord[]> {
    const folder = this.folderOf(boardId);
    const names = await this.io.listFiles(folder);

    const records: SnapshotRecord[] = [];
    for (const name of names) {
      const capturedAt = parseSnapshotTime(name);
      if (capturedAt === null) continue; // 不认识的杂物（`.DS_Store`、用户手动放的文件）一律不动
      const path = `${folder}/${name}`;
      const [bytes, cardCount] = await Promise.all([this.io.size(path), this.readCardCount(path)]);
      records.push({ path, boardId, capturedAt, cardCount, bytes: bytes ?? 0 });
    }

    return records.sort((a, b) => b.capturedAt - a.capturedAt);
  }

  /** 读一份快照的原文（给预览 / 恢复用） */
  async readText(record: SnapshotRecord): Promise<string> {
    return this.io.read(record.path);
  }

  /** 磁盘上最新一份快照的元信息；一份都没有时 null */
  async latest(boardId: string): Promise<SnapshotRecord | null> {
    const records = await this.list(boardId);
    return records[0] ?? null;
  }

  // ── 内部 ──────────────────────────────────────────────────

  private folderOf(boardId: string): string {
    const root = this.options.root().replace(/\/+$/g, '');
    return root.length > 0 ? `${root}/${boardId}` : boardId;
  }

  /** 同一秒内连点两次"创建快照"会撞名，顺延一个 `-2`/`-3` 后缀 */
  private async uniquePath(folder: string, fileName: string): Promise<string> {
    const stem = fileName.slice(0, -`.${BOARD_EXT}`.length);
    let candidate = `${folder}/${fileName}`;
    for (let i = 2; await this.io.exists(candidate); i++) {
      candidate = `${folder}/${stem}-${i}.${BOARD_EXT}`;
    }
    return candidate;
  }

  private async lastOf(boardId: string): Promise<{ capturedAt: number; revision: number } | null> {
    const cached = this.recent.get(boardId);
    if (cached) return cached;

    const latest = await this.latest(boardId);
    if (!latest) return null;

    const entry = { capturedAt: latest.capturedAt, revision: await this.readRevision(latest) };
    this.recent.set(boardId, entry);
    return entry;
  }

  private async readRevision(record: SnapshotRecord): Promise<number> {
    try {
      const parsed: unknown = JSON.parse(await this.io.read(record.path));
      const revision = (parsed as { revision?: unknown } | null)?.revision;
      return typeof revision === 'number' ? revision : -1;
    } catch {
      // 读不出来就当"-1"：它是任何真实 revision 都不等于的值 → 下一次保存必定再打一份快照
      return -1;
    }
  }

  private async readCardCount(path: string): Promise<number | null> {
    try {
      return countCards(await this.io.read(path));
    } catch {
      return null;
    }
  }

  private async prune(boardId: string): Promise<void> {
    const records = await this.list(boardId);
    for (const path of planSnapshotEviction(records, {
      maxCount: this.maxCount,
      maxBytes: this.maxBytes,
    })) {
      try {
        await this.io.remove(path);
      } catch {
        // 删不掉（权限 / 被占用）不该让这次保存失败，留着下次再试
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────
// 小工具
// ─────────────────────────────────────────────────────────────

/** 只数 `cards` 数组长度，不做完整校验 —— 快照是我们自己写的，不需要再过一遍 schema */
function countCards(text: string): number | null {
  try {
    const parsed: unknown = JSON.parse(text);
    const cards = (parsed as { cards?: unknown } | null)?.cards;
    return Array.isArray(cards) ? cards.length : null;
  } catch {
    return null;
  }
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}
