/**
 * BoardRegistry —— 全局白板索引（T1.15）。
 *
 * 职责：`id ↔ path` 映射、父子关系、跨白板查询。
 * 对应需求 `F7-01`（白板列表 / 入口）与 `F7-02`（嵌套关系）。
 *
 * 性能约定：启动扫描**只读 `meta`**；卡片计数与封面**懒加载**（T1.15 明确要求），
 * 否则一个 5000 卡的白板会让插件启动直接卡住（风险表 R4）。
 *
 * ★ 不 import `obsidian`：依赖 `VaultIO` 端口，可在 Node 下单测。
 */

import { BOARD_EXT } from '../constants';
import type { BoardFile } from '../model/schema';
import { isRecord, safeJsonParse } from '../model/validate';
import { describeError } from '../util/errors';
import type { VaultIO } from './vaultIO';

export interface BoardEntry {
  id: string;
  path: string;
  title: string;
  icon: string | null;
  parent: string | null;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  /** 懒加载：`null` = 尚未统计（见 `ensureCardCount`） */
  cardCount: number | null;
  /** 封面缩略图路径，懒加载；T1.51（ThumbnailCache）落地后填充 */
  cover: string | null;
}

export interface RegistryWarning {
  path: string;
  message: string;
}

export class BoardRegistry {
  private readonly byId = new Map<string, BoardEntry>();
  private readonly byPath = new Map<string, BoardEntry>();
  private readonly warnings = new Map<string, string>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly io: VaultIO) {}

  // ── 构建 / 刷新 ───────────────────────────────────────────

  /** 全量扫描 Vault 内所有 `.nboard`。插件 `onload` 时调用一次 */
  async build(): Promise<void> {
    this.byId.clear();
    this.byPath.clear();
    this.warnings.clear();

    let paths: string[] = [];
    try {
      paths = await this.io.list(BOARD_EXT);
    } catch (error) {
      console.warn('[nestboard] 扫描白板失败', describeError(error));
      return;
    }

    for (const path of paths) {
      await this.upsert(path);
    }
    this.resolveParents();
  }

  /** 重命名 / 删除 / 新建后维护索引 */
  async upsert(path: string): Promise<BoardEntry | null> {
    let raw: string;
    try {
      raw = await this.io.read(path);
    } catch (error) {
      this.warnings.set(path, `读取失败：${describeError(error)}`);
      return null;
    }

    const entry = extractEntry(path, raw);
    if (!entry) {
      this.warnings.set(path, '文件不是合法白板（缺少 meta.id），已跳过索引');
      return null;
    }

    const clash = this.byId.get(entry.id);
    if (clash && clash.path !== path) {
      // 同一 id 出现在两个路径：复制白板文件会这样。保留先到的，后者标记冲突（不覆盖）
      this.warnings.set(path, `id ${entry.id} 与 ${clash.path} 重复，已跳过索引`);
      return null;
    }

    const previous = this.byPath.get(path);
    if (previous && previous.id !== entry.id) this.byId.delete(previous.id);
    this.byPath.set(path, entry);
    this.byId.set(entry.id, entry);
    this.warnings.delete(path);
    this.emitChanged();
    return entry;
  }

  /** 用**内存中的模型**刷新条目（免一次磁盘读），由 `repository.on('saved')` 驱动 */
  updateFromBoard(path: string, board: BoardFile): void {
    const entry = this.byPath.get(path);
    if (!entry) {
      void this.upsert(path);
      return;
    }
    entry.title = board.meta.title;
    entry.icon = board.meta.icon;
    entry.parent = board.meta.parent;
    entry.tags = [...board.meta.tags];
    entry.updatedAt = board.meta.updatedAt;
    entry.cardCount = board.cards.length;
    if (entry.id !== board.meta.id) {
      this.byId.delete(entry.id);
      entry.id = board.meta.id;
      this.byId.set(entry.id, entry);
    }
    this.emitChanged();
  }

  remove(path: string): void {
    const entry = this.byPath.get(path);
    if (entry) this.byId.delete(entry.id);
    if (this.byPath.delete(path) || entry) this.emitChanged();
    this.warnings.delete(path);
  }

  /** 文件被重命名：保持 id 不变，只换 path（`meta.parent` 由 RenameWatcher 在 T1.46 统一修） */
  movePath(oldPath: string, newPath: string): void {
    const entry = this.byPath.get(oldPath);
    if (!entry) {
      void this.upsert(newPath);
      return;
    }
    this.byPath.delete(oldPath);
    entry.path = newPath;
    this.byPath.set(newPath, entry);
    for (const candidate of this.byPath.values()) {
      if (candidate.parent === oldPath) candidate.parent = newPath;
    }
    this.emitChanged();
  }

  // ── 查询 ─────────────────────────────────────────────────

  getById(id: string): BoardEntry | null {
    return this.byId.get(id) ?? null;
  }

  getByPath(path: string): BoardEntry | null {
    return this.byPath.get(path) ?? null;
  }

  has(path: string): boolean {
    return this.byPath.has(path);
  }

  all(): BoardEntry[] {
    return [...this.byPath.values()];
  }

  /** 顶层白板（`meta.parent === null`），按更新时间倒序 —— 列表默认顺序 */
  topLevel(): BoardEntry[] {
    return this.all()
      .filter((entry) => entry.parent === null)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  childrenOf(parentPath: string): BoardEntry[] {
    return this.all()
      .filter((entry) => entry.parent === parentPath)
      .sort((a, b) => a.title.localeCompare(b.title));
  }

  warningsList(): RegistryWarning[] {
    return [...this.warnings.entries()].map(([path, message]) => ({ path, message }));
  }

  // ── 懒加载 ───────────────────────────────────────────────

  /** 统计卡片数并缓存。只有真正需要显示计数的视图（白板卡 / 列表）才调用 */
  async ensureCardCount(path: string): Promise<number> {
    const entry = this.byPath.get(path);
    if (entry && entry.cardCount !== null) return entry.cardCount;

    let count = 0;
    try {
      const raw = await this.io.read(path);
      const json = safeJsonParse(raw);
      if (json.ok && isRecord(json.value) && Array.isArray(json.value.cards)) {
        count = json.value.cards.length;
      }
    } catch (error) {
      this.warnings.set(path, `统计卡片数失败：${describeError(error)}`);
      return 0;
    }

    if (entry) {
      entry.cardCount = count;
      this.emitChanged();
    }
    return count;
  }

  // ── 事件 ─────────────────────────────────────────────────

  onChanged(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emitChanged(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (error) {
        console.warn('[nestboard] registry 监听器抛错', describeError(error));
      }
    }
  }

  /** 父白板不存在（被删 / 跨 Vault 迁移）→ 降级为顶层白板，避免列表里"消失" */
  private resolveParents(): void {
    for (const entry of this.byPath.values()) {
      if (entry.parent !== null && !this.byPath.has(entry.parent)) {
        this.warnings.set(entry.path, `父白板不存在：${entry.parent}，已按顶层白板处理`);
        entry.parent = null;
      }
    }
  }
}

/**
 * 从文件文本中提取索引条目。
 * @returns `null` = 不是白板 / 没有可用的 `meta.id`
 */
function extractEntry(path: string, raw: string): BoardEntry | null {
  const json = safeJsonParse(raw);
  if (!json.ok || !isRecord(json.value)) return null;

  const meta = isRecord(json.value.meta) ? json.value.meta : null;
  const id = meta && typeof meta.id === 'string' && meta.id.length > 0 ? meta.id : null;
  if (!id) return null;

  const icon = meta && typeof meta.icon === 'string' && meta.icon.length > 0 ? meta.icon : null;
  const parent =
    meta && typeof meta.parent === 'string' && meta.parent.length > 0 ? meta.parent : null;

  return {
    id,
    path,
    title: meta && typeof meta.title === 'string' ? meta.title : '',
    icon,
    parent,
    tags: meta && Array.isArray(meta.tags) ? meta.tags.filter(isString) : [],
    createdAt: meta && typeof meta.createdAt === 'string' ? meta.createdAt : '',
    updatedAt: meta && typeof meta.updatedAt === 'string' ? meta.updatedAt : '',
    cardCount: null,
    cover: null,
  };
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}
