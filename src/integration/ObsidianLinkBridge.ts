import { TFile, normalizePath, type App, type EventRef } from 'obsidian';

import type { NoteWriteResult, VaultBridge } from '../cards/registry';
import { NotePickerModal } from '../ui/modals/NotePickerModal';

/**
 * `VaultBridge` 的生产实现（T1.43 / T1.44 / T1.45）。
 *
 * 全文件只有这一处把 Obsidian 的 Vault / Workspace 暴露给引用卡 ——
 * `cards/` 层拿到的永远是 `VaultBridge` 接口，所以那几个卡片定义能在 node 下单测。
 *
 * 铁律：**任何方法都不许把异常抛出去**。它们跑在卡片渲染路径上，
 * 一次抛错会让整屏卡片的渲染循环一起断掉（`CardLayer` 没有逐卡 try/catch）。
 */
export class ObsidianLinkBridge implements VaultBridge {
  constructor(private readonly app: App) {}

  private file(path: string): TFile | null {
    if (path.length === 0) return null;
    const found = this.app.vault.getAbstractFileByPath(normalizePath(path));
    return found instanceof TFile ? found : null;
  }

  exists(path: string): boolean {
    return this.file(path) !== null;
  }

  async read(path: string): Promise<string | null> {
    const file = this.file(path);
    if (!file) return null;
    try {
      return await this.app.vault.cachedRead(file);
    } catch {
      // 文件在这一瞬间被删 / 权限变了 —— 当作"读不到"，让卡片走断链态
      return null;
    }
  }

  /**
   * 以 `expected` 为基准原子写回源笔记（T2.01 / `F2-2-3`）。
   *
   * ★ 走 `vault.process` 而不是 `vault.modify`：`process` 的读改写是一个原子操作，
   *   中途别人的修改不会被我们这次写入无声吞掉（`03 §3.2` W1 的同一套语义）。
   *
   * ★ 比较放在**回调里面**：`process` 保证回调拿到的是写入那一刻的文件内容，
   *   所以"内容和我看到的不一样 → 放弃"这个判断落在原子窗口内部，
   *   不可能出现"读的时候一样、写下去的时候已经被改"的窗口期。
   *
   * 放弃时返回 `raw` 原样：内容一字未变，也不会触发一次多余的 `modify`。
   */
  async writeIfUnchanged(path: string, expected: string, next: string): Promise<NoteWriteResult> {
    const file = this.file(path);
    if (!file) return 'missing';

    let conflict = false;
    try {
      await this.app.vault.process(file, (raw) => {
        if (raw !== expected) {
          conflict = true;
          return raw;
        }
        return next;
      });
    } catch {
      // 权限 / 适配器报错。**不能**当成 `conflict`：那会让卡片层说"被别处改过了"，
      // 而用户按提示重试一辈子也不会成功
      return 'failed';
    }
    return conflict ? 'conflict' : 'written';
  }

  open(path: string, subpath: string | null, newLeaf: boolean): void {
    if (path.length === 0) return;
    // `openLinkText` 同时吃路径与 `[[笔记#标题]]` 文本，这里拼成后者语义
    const linktext = subpath ? `${path}${subpath}` : path;
    void this.app.workspace.openLinkText(linktext, '', newLeaf);
  }

  resourceUrl(path: string): string | null {
    const file = this.file(path);
    if (!file) return null;
    // `getResourcePath` 只存在于文件系统适配器上；移动端 / 内存适配器上缺失是正常的
    const adapter = this.app.vault.adapter as { getResourcePath?: (path: string) => string };
    if (typeof adapter.getResourcePath !== 'function') return null;
    try {
      return adapter.getResourcePath(file.path);
    } catch {
      return null;
    }
  }

  watch(path: string, listener: () => void): () => void {
    if (path.length === 0) return () => undefined;
    const target = normalizePath(path);
    const ref: EventRef = this.app.vault.on('modify', (file) => {
      if (file.path === target) listener();
    });
    let disposed = false;
    return () => {
      // 退订必须幂等：卡片回收与 `destroy` 可能都调一次
      if (disposed) return;
      disposed = true;
      this.app.vault.offref(ref);
    };
  }

  pickNote(current: string | null): Promise<string | null> {
    return new Promise((resolve) => {
      new NotePickerModal(this.app, current, resolve).open();
    });
  }
}
