/**
 * Vault 读写端口（T1.10–T1.15 的依赖边界）。
 *
 * 为什么要抽一层端口，而不是到处 `app.vault.xxx`：
 * 1. `io/` 的核心逻辑（防抖、冲突检测、原子写顺序）是本项目**风险最高**的代码（风险表 R5），
 *    必须能脱离 Obsidian 运行时做集成测试 —— 测试里注入内存实现即可；
 * 2. Obsidian 的 `TFile` / `App` 在 Node 环境下无法实例化（npm 包只提供类型），
 *    直接依赖它们会让单测彻底写不出来。
 *
 * 生产实现是 `ObsidianVaultIO`（本文件内，唯一 import `obsidian` 的地方）。
 */

import type { App, TFile } from 'obsidian';
import { TFile as TFileClass } from 'obsidian';

export interface VaultStat {
  mtime: number;
  size: number;
}

export interface VaultIO {
  /** 读文本。生产实现走 `cachedRead`（03 §6.8：官方推荐的便宜读） */
  read(path: string): Promise<string>;

  /**
   * 读**二进制**（T6.02：导出 ZIP 要把附件原样打包）。
   *
   * ★ 与 `read` 同样先过 `requireFile`：路径不存在时抛错而不是返回空 buffer ——
   *   打包时"读不到"必须是一个能被上层看见的事实（跳过并写进摘要），
   *   而不是往归档里塞一个 0 字节的假文件。
   */
  readBinary(path: string): Promise<ArrayBuffer>;

  /**
   * ★ 原子写（03 §3.2 W1）：`vault.process(file, transform)`。
   * `transform` 抛出异常时**不会写入任何内容** —— 冲突检测就是靠这个语义实现的。
   */
  process(path: string, transform: (raw: string) => string): Promise<void>;

  exists(path: string): Promise<boolean>;
  /**
   * 这个路径在库里是不是一个**文件**（目录不算）。
   *
   * ★ 刻意是**同步**的：拖拽判定要在 `dragover` 里当场回答"这个拖进来的东西
   *   能不能变成卡片"，而 `dragover` 每一帧都会来一次 —— 异步实现会让
   *   预览永远慢半拍，还会让"是否接受这次拖拽"变成一个竞态。
   */
  isFile(path: string): boolean;
  create(path: string, data: string): Promise<void>;
  /**
   * 写**二进制**（导出 PNG，T2.11）。
   *
   * ★ 与 `create` 同语义：**已存在就抛错**，绝不静默覆盖。二进制没有"内容指纹"可以
   *   认出"这是我们自己的旧产物"，能覆盖就等于能覆盖用户的图片 —— 那是不可逆的。
   *   调用方（`PngExporter`）因此必须先顺延取名。
   */
  createBinary(path: string, data: ArrayBuffer): Promise<void>;
  stat(path: string): Promise<VaultStat | null>;
  /** 列出指定扩展名的全部文件路径 */
  list(extension: string): Promise<string[]>;
  /**
   * 列出全部文件路径（不筛扩展名）。
   *
   * ★ 冲突副本扫描（T4.03）必须要它：`父版.nboard.conflict-1712` 的扩展名是
   *   `conflict-1712`，按扩展名过滤会把整整一类冲突文件漏掉。
   */
  listAll(): Promise<string[]>;
}

export class ObsidianVaultIO implements VaultIO {
  constructor(private readonly app: App) {}

  private requireFile(path: string): TFile {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFileClass)) {
      throw new Error(`白板文件不存在：${path}`);
    }
    return file;
  }

  async read(path: string): Promise<string> {
    return this.app.vault.cachedRead(this.requireFile(path));
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    return this.app.vault.readBinary(this.requireFile(path));
  }

  async process(path: string, transform: (raw: string) => string): Promise<void> {
    await this.app.vault.process(this.requireFile(path), transform);
  }

  async exists(path: string): Promise<boolean> {
    return this.app.vault.getAbstractFileByPath(path) !== null;
  }

  isFile(path: string): boolean {
    // 目录在同一个索引里（`TFolder`），所以必须判类型而不是判"解引用非空"
    return this.app.vault.getAbstractFileByPath(path) instanceof TFileClass;
  }

  async create(path: string, data: string): Promise<void> {
    await this.prepareCreate(path);
    await this.app.vault.create(path, data);
  }

  async createBinary(path: string, data: ArrayBuffer): Promise<void> {
    await this.prepareCreate(path);
    await this.app.vault.createBinary(path, data);
  }

  async stat(path: string): Promise<VaultStat | null> {
    const stat = await this.app.vault.adapter.stat(path);
    return stat ? { mtime: stat.mtime, size: stat.size } : null;
  }

  async list(extension: string): Promise<string[]> {
    return this.app.vault
      .getFiles()
      .filter((file) => file.extension === extension)
      .map((file) => file.path);
  }

  async listAll(): Promise<string[]> {
    return this.app.vault.getFiles().map((file) => file.path);
  }

  /** 建目录 + 查重（`create` / `createBinary` 共用，防止两条路径的防覆盖策略漂移） */
  private async prepareCreate(path: string): Promise<void> {
    const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    await this.ensureFolder(folder);
    if (this.app.vault.getAbstractFileByPath(path)) {
      throw new Error(`文件已存在：${path}`);
    }
  }

  /** Obsidian 不会自动建目录，逐级补齐（已存在时 `createFolder` 会抛，忽略即可） */
  private async ensureFolder(folder: string): Promise<void> {
    if (folder.length === 0) return;
    const segments = folder.split('/');
    let current = '';
    for (const segment of segments) {
      current = current.length > 0 ? `${current}/${segment}` : segment;
      if (this.app.vault.getAbstractFileByPath(current)) continue;
      try {
        await this.app.vault.createFolder(current);
      } catch {
        // 并发创建或已存在：无害
      }
    }
  }
}
