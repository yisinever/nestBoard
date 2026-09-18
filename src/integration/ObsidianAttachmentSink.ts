/**
 * `AttachmentSink` 的生产实现（T1.49 的集成半件，被 T1.65 的系统文件拖入消费）。
 *
 * `io/AttachmentManager` 负责"叫什么名、放哪个目录、要不要去重"，
 * 本文件只负责"真的写进 Vault"，并且是这条链上**唯一** import `obsidian` 的地方。
 *
 * ★ 走 `vault.createBinary` 而不是 `vault.adapter.writeBinary`：
 *   adapter 是绕过索引的裸写 —— 文件落在磁盘上了，但 `getAbstractFileByPath`
 *   要等 Obsidian 自己扫到才知道。而卡片建好之后立刻要显示它（还要能被再次拖拽命中），
 *   索引里查不到就会出现"图显示了，但下一次把同一个文件拖进来时说不认识"。
 */

import type { App } from 'obsidian';
import type { AttachmentSink } from '../io/AttachmentManager';

export class ObsidianAttachmentSink implements AttachmentSink {
  constructor(private readonly app: App) {}

  async exists(path: string): Promise<boolean> {
    return this.app.vault.getAbstractFileByPath(path) !== null;
  }

  /** Obsidian 不会自动建目录，逐级补齐；已存在（含并发创建）时忽略 */
  async ensureFolder(folder: string): Promise<void> {
    if (folder.length === 0) return;

    const segments = folder.split('/');
    let current = '';
    for (const segment of segments) {
      current = current.length === 0 ? segment : `${current}/${segment}`;
      if (this.app.vault.getAbstractFileByPath(current)) continue;
      try {
        await this.app.vault.createFolder(current);
      } catch {
        // 并发创建或已存在：无害，继续往下走
      }
    }
  }

  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    await this.app.vault.createBinary(path, data);
  }
}
