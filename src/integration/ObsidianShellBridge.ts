import { normalizePath, type App } from 'obsidian';

import type { ShellBridge } from '../cards/registry';

/**
 * `app.openWithDefaultApp` 在 **Obsidian 运行时有、但在类型定义里还没有**
 * （当前 devDependency 的 obsidian 1.13.1 里查不到这个名字）。
 *
 * ★ 用"能力探测 + 窄接口断言"而不是 `any`：与 `ObsidianLinkBridge.resourceUrl`
 *   对 `getResourcePath` 的处理同一套写法 —— 缺失时能优雅降级，而不是运行时炸掉。
 */
type DefaultAppOpener = { openWithDefaultApp?: (path: string) => Promise<void> };

/**
 * `ShellBridge` 的生产实现（T1.53）—— 文件卡的"用系统默认应用打开 / 读文件大小"。
 *
 * 与 `ObsidianLinkBridge` 同一条铁律：**任何方法都不许把异常抛出去**。
 * 它们跑在卡片渲染与双击路径上，一次抛错会带走整屏卡片。
 */
export class ObsidianShellBridge implements ShellBridge {
  constructor(private readonly app: App) {}

  async openPath(path: string): Promise<boolean> {
    if (path.length === 0) return false;
    const target = normalizePath(path);
    const opener = (this.app as unknown as DefaultAppOpener).openWithDefaultApp;
    try {
      if (typeof opener === 'function') {
        await opener.call(this.app, target);
        return true;
      }
      // 降级：交给 Obsidian 自己打开。md / 图片 / PDF / 音视频它都能处理 ——
      // 比"双击了却什么都没发生"强得多（zip / psd 这类仍需要系统应用）
      await this.app.workspace.openLinkText(target, '', false);
      return true;
    } catch {
      // 没有默认应用 / 路径已失效 / 平台不允许：都当作"打不开"，
      // 而不是让用户对着一次抛错后的半截界面发呆
      return false;
    }
  }

  async statInfo(path: string): Promise<{ size: number; mtime: number } | null> {
    if (path.length === 0) return null;
    try {
      // ★ 走 `adapter.stat` 而不是 TFile：文件卡要能显示**非 Markdown** 附件
      //   （pdf / zip / psd）的大小与修改时间，而 TFile 只覆盖 Vault 索引里的文件。
      const stat = await this.app.vault.adapter.stat(normalizePath(path));
      return stat ? { size: stat.size, mtime: stat.mtime } : null;
    } catch {
      return null;
    }
  }
}
