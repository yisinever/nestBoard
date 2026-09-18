import { TFile, normalizePath, type App } from 'obsidian';

import {
  THUMB_DIR,
  THUMB_QUALITY,
  THUMB_SIZE,
  ThumbnailCache,
  type ThumbnailRenderer,
  type ThumbnailStore,
} from '../io/ThumbnailCache';
import { ThumbnailProvider, thumbnailScale, type ThumbnailSource } from '../io/ThumbnailProvider';
import { describeError } from '../util/errors';

/**
 * `ThumbnailBridge` 的生产实现（T1.51 / T1.52）。
 *
 * 本文件是缩略图管线里**唯一**碰 Obsidian 的地方：二进制读写、`stat`、
 * `getResourcePath`、canvas 渲染。合并并发、路径映射、失效逻辑都在
 * `io/ThumbnailProvider.ts` 里，那边不 import `obsidian`、可在 node 下跑测试。
 *
 * 铁律同其余几座桥：**任何方法都不许把异常抛出去**。缩略图只是优化，
 * 它失败必须退化成"用原图"，绝不能把卡片渲染一起拖下水。
 */
export class ObsidianThumbnailBridge extends ThumbnailProvider {
  constructor(app: App, memoryLimit?: number) {
    super(
      new ThumbnailCache({
        store: new AdapterThumbnailStore(app),
        render: createCanvasRenderer(),
        memoryLimit,
      }),
      new VaultThumbnailSource(app),
    );
  }
}

/**
 * 二进制读写端口：落在 Vault 适配器上（`cache/thumbs/` 与笔记同一套路径语义）。
 *
 * ★ 导出给板级缩略图桥（T4.16）共用：它只回答"这块 Vault 怎么读写二进制"，
 *   与"画的是图还是板"无关 —— 两块桥落在同一个 `cache/thumbs/` 里，
 *   键里带着各自的路径，sha1 不会撞（也就不会互删）。
 */
export class AdapterThumbnailStore implements ThumbnailStore {
  constructor(private readonly app: App) {}

  private get adapter() {
    return this.app.vault.adapter;
  }

  exists(path: string): Promise<boolean> {
    return this.adapter.exists(path);
  }

  readBinary(path: string): Promise<ArrayBuffer> {
    return this.adapter.readBinary(path);
  }

  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    await this.ensureDir();
    await this.adapter.writeBinary(path, data);
  }

  remove(path: string): Promise<void> {
    return this.adapter.remove(path);
  }

  /**
   * `cache/thumbs` 不在版本库里，用户随手清掉 cache 目录也很正常 ——
   * 每次写之前确认一次目录存在，缓存才能"自愈"而不是从此再也写不进去。
   * （失败只记日志：写不进去最多是下次再看一次原图。）
   */
  private async ensureDir(): Promise<void> {
    try {
      if (await this.adapter.exists(THUMB_DIR)) return;
      await this.adapter.mkdir(THUMB_DIR);
    } catch (error) {
      console.warn('[nestboard] 创建缩略图目录失败', describeError(error));
    }
  }
}

/** `mtime` / `size` 与"原图 URL"两个端口 */
export class VaultThumbnailSource implements ThumbnailSource {
  constructor(private readonly app: App) {}

  async stat(path: string): Promise<{ mtime: number; size: number } | null> {
    const file = this.file(path);
    if (!file) return null;
    try {
      const stat = await this.app.vault.adapter.stat(file.path);
      // 目录也会返回 stat：缩略图只对文件有意义
      if (!stat || stat.type !== 'file') return null;
      return { mtime: stat.mtime, size: stat.size };
    } catch {
      // 文件在这一瞬间被删 / 权限变了 —— 当作"没有"，卡片会继续用原图
      return null;
    }
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

  private file(path: string): TFile | null {
    return vaultFileOf(this.app, path);
  }
}

/**
 * Vault 内路径 → `TFile`；不存在、或是目录都返回 `null`。
 *
 * 单独抽出来是因为**两块**缩略图桥都要做这件事（都靠它 `stat` / `cachedRead`），
 * 而"路径语义"必须只有一份：`normalizePath` 少调一次，`\` 与 `/` 的差异就会
 * 在两块桥之间表现成"图片有缩略图、板没有"。
 */
export function vaultFileOf(app: App, path: string): TFile | null {
  if (path.length === 0) return null;
  const found = app.vault.getAbstractFileByPath(normalizePath(path));
  return found instanceof TFile ? found : null;
}

/**
 * canvas 渲染端口：图片原图 → 256px WebP。
 *
 * ★ 用**离屏** `<img>` + `<canvas>`，全程不进 DOM：图片卡首帧已经在显示原图了，
 *   这里只是悄悄生成一份"缩小版"备用，不该引起任何布局/闪烁。
 * ★ `drawImage` 直接缩放到目标尺寸：让浏览器在解码阶段采样，
 *   比"先画满再缩小"清晰得多，也省一次全尺寸位图。
 */
function createCanvasRenderer(): ThumbnailRenderer {
  return (source) =>
    new Promise<Blob | null>((resolve) => {
      // 没有原图 URL 就没得画（移动端拿不到文件系统适配器）——
      // ★ 这个判断属于**图片**渲染器：板级渲染器（`ObsidianBoardThumbnailBridge`）
      //   不碰 URL，它按 `path` 去读 `.nboard` 再画
      const sourceUrl = source.url;
      if (sourceUrl === null) {
        resolve(null);
        return;
      }
      const image = document.createElement('img');
      image.onload = () => {
        const { width, height } = thumbnailScale(
          image.naturalWidth,
          image.naturalHeight,
          THUMB_SIZE,
        );
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(null);
          return;
        }
        ctx.drawImage(image, 0, 0, width, height);
        // `toBlob` 的失败分支是回调收到 `null`，不是抛错
        canvas.toBlob((blob) => resolve(blob), 'image/webp', THUMB_QUALITY);
      };
      image.onerror = () => resolve(null);
      image.src = sourceUrl;
    });
}
