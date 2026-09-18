/**
 * 快照文件能力的生产实现（T4.01）—— 本文件是 `SnapshotStore` 唯一认识 Obsidian 的地方。
 *
 * ★ 走 `vault.adapter` 而**不是** `vault` 索引，理由见 `SnapshotStore` 文件头：
 *   快照目录默认在 `.obsidian/plugins/nestboard/` 下，Obsidian 的文件索引不收
 *   `.obsidian` 以及任何以 `.` 开头的目录。adapter 是直接的文件读写，
 *   于是"插件目录"与"Vault 内 `.nestboard-history/`"两个位置能共用同一条代码路径。
 *
 * ★ `adapter.list()` 返回的是**完整路径**（Vault 相对），而 `SnapshotStore` 要的是
 *   文件名 —— 转换放在这一层，store 那边就不必知道 adapter 的怪癖。
 */

import type { App } from 'obsidian';
import type { SnapshotIO } from './SnapshotStore';

export class ObsidianSnapshotIO implements SnapshotIO {
  constructor(private readonly app: App) {}

  async exists(path: string): Promise<boolean> {
    return this.app.vault.adapter.exists(path);
  }

  async read(path: string): Promise<string> {
    return this.app.vault.adapter.read(path);
  }

  async write(path: string, data: string): Promise<void> {
    const folder = parentOf(path);
    if (folder.length > 0) await this.ensureFolder(folder);
    await this.app.vault.adapter.write(path, data);
  }

  async listFiles(folder: string): Promise<string[]> {
    // ★ 先判存在：某些 adapter（移动端）对不存在的目录直接抛错，而不是返回空列表
    if (!(await this.app.vault.adapter.exists(folder))) return [];
    const listed = await this.app.vault.adapter.list(folder);
    return listed.files.map(baseNameOf);
  }

  async remove(path: string): Promise<void> {
    await this.app.vault.adapter.remove(path);
  }

  async size(path: string): Promise<number | null> {
    const stat = await this.app.vault.adapter.stat(path);
    return stat ? stat.size : null;
  }

  /** Obsidian 不会自动建目录，逐级补齐（与 `ObsidianVaultIO.ensureFolder` 同策略） */
  private async ensureFolder(folder: string): Promise<void> {
    const segments = folder.split('/');
    let current = '';
    for (const segment of segments) {
      current = current.length > 0 ? `${current}/${segment}` : segment;
      if (await this.app.vault.adapter.exists(current)) continue;
      try {
        await this.app.vault.adapter.mkdir(current);
      } catch {
        // 并发创建或已存在：无害
      }
    }
  }
}

function parentOf(path: string): string {
  const index = path.lastIndexOf('/');
  return index < 0 ? '' : path.slice(0, index);
}

function baseNameOf(path: string): string {
  const index = path.lastIndexOf('/');
  return index < 0 ? path : path.slice(index + 1);
}
