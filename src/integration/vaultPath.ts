/**
 * 「原始路径 → 库内真实文件路径」的唯一一处实现。
 *
 * 为什么值得单独抽出来：这条解析规则现在有三处消费者 —— 拖拽落点（`DragDropBridge` 的
 * `resolvePath`）、断链判定（`refExistsInVault` 喂给它的那个 `exists`）、以及
 * 「整理未使用附件」的引用比对。三者**必须给出同一个答案**：如果"整理附件"用一套
 * 宽松规则、"断链总览"用一套严格规则，就会出现"断链总览说这张图没了、附件整理说它还在用"
 * 这种互相打脸的场面，而用户无从判断该信谁。
 *
 * 解析顺序（与 `BoardEmbed.resolveFile` 同一套思路）：
 *
 * 1. **精确路径**：卡片里存的就是 vault 路径时（拖进来、新建时都是），一次哈希查找命中；
 * 2. **链接解析**：`text/plain` 里常常只有短名（`图.png`）、或写成 `[[笔记]]` 那种链接文本，
 *    这时交给 `getFirstLinkpathDest` 按库规则展开（相对路径、同名消歧都由它管）。
 */

import { TFile, normalizePath, type App } from 'obsidian';

/**
 * @param raw 卡片 / 拖拽 / 笔记里写的原始路径，可能是短名
 * @param sourcePath 解析基准（"谁在引用它"）；用 `''` 表示库根
 * @returns 库内真实文件路径；`null` = 不是库内文件（库外路径、已删除、或根本解析不出来）
 */
export function resolveFileInVault(app: App, raw: string, sourcePath: string): string | null {
  const target = raw.trim();
  if (target.length === 0) return null;

  const exact = app.vault.getAbstractFileByPath(normalizePath(target));
  if (exact instanceof TFile) return exact.path;

  const resolved = app.metadataCache.getFirstLinkpathDest(target, sourcePath);
  return resolved instanceof TFile ? resolved.path : null;
}
