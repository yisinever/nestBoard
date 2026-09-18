/**
 * 缩略图缓存（T1.51）。
 *
 * 目标：卡片在缩放 < 0.8 的概览视图里**不需要原图**，一张 256px 的 WebP 就够。
 * 否则一张 4K 原图每帧都要 decode，滚动白板时会直接把内存打爆。
 *
 * 三条设计主线：
 * 1. 产物落在 `cache/thumbs/<sha1>.webp`，**可删可再生**：删掉只是下次多看一次原图。
 *    原图一变（mtime/size 变），内存键就变，旧文件自然成为可删的垃圾 —— 无需失效逻辑。
 * 2. 内存键**同步**可得（`memoryKey`）：视图渲染时需要同步判断"有没有缩略图"，
 *    而落盘文件名才用异步 sha1（`thumbnailFilePath`）。
 * 3. 渲染失败 / 落盘失败都**不抛错**：缩略图只是优化，失败就退回原图，
 *    绝不能让卡片渲染跟着失败。
 *
 * ★ 不 import `obsidian`：通过 `ThumbnailStore` / `ThumbnailRenderer` 两个窄接口访问外部世界，
 *   可在 Node（vitest）下用内存替身单测。生产实现放在 `src/integration/`。
 */

import { describeError } from '../util/errors';

/** 二进制读写端口；生产实现放在 `src/integration/`（`vault.adapter.readBinary/writeBinary`） */
export interface ThumbnailStore {
  exists(path: string): Promise<boolean>;
  readBinary(path: string): Promise<ArrayBuffer>;
  writeBinary(path: string, data: ArrayBuffer): Promise<void>;
  remove(path: string): Promise<void>;
}

/**
 * 一次渲染任务的**来源**。
 *
 * ★ 为什么不是一个裸 URL：板级缩略图（T4.16 / `F2-8-2`）没有"原图"可指 ——
 *   它的 `url` 指向的是一个 `.nboard` 文件，渲染器必须**忽略**它、按 `path`
 *   自己把模型读出来再画。只递 URL 的话，那个渲染器就只能去解析
 *   `app://local/<绝对路径>` 反推路径，而那种形状是平台细节，不该被依赖。
 *
 * ★ 为什么 `url` 可以为 `null`："能不能渲染"是**渲染器**的判断，不是缓存层的：
 *   图片渲染器拿不到原图 URL（移动端没有文件系统适配器）就没法画；板级渲染器
 *   根本不看这个字段。以前这个判断写在 `ThumbnailProvider` 里，等于顺手把
 *   板级管线一起挡在门外。
 */
export interface ThumbnailSourceRef {
  /** Vault 相对路径（图片是原图，板是 `.nboard`） */
  path: string;
  /** 原图 URL；拿不到为 `null`（此时图片渲染器应当放弃渲染） */
  url: string | null;
}

/** 把来源渲染成缩略图；生产实现用 canvas，测试里给假实现。返回 `null` = 渲染不了（当成没缓存） */
export type ThumbnailRenderer = (source: ThumbnailSourceRef) => Promise<Blob | null>;

export const THUMB_DIR = 'cache/thumbs';
export const THUMB_SIZE = 256;
/** ★ webp 质量 0.8：缩略图只用于"缩放 < 0.8 时的概览"，看不出压缩痕迹，但体积只有原图几十分之一 */
export const THUMB_QUALITY = 0.8;
export const THUMB_EXT = '.webp';
/** 内存里最多留多少张缩略图的 objectURL，超出按 LRU 释放 */
export const THUMB_MEMORY_LIMIT = 300;

/**
 * 内存索引键（**同步**可得）：`<path>@<mtime>@<size>`。
 * ★ 不用 sha1 当内存键，是因为渲染时需要**同步**判断"这张图有没有缩略图"
 *   （`peek`），而 sha1 只能异步算（`crypto.subtle`）。
 */
export function memoryKey(path: string, mtime: number, size: number): string {
  return `${path}@${mtime}@${size}`;
}

/**
 * 落盘文件名：`cache/thumbs/<sha1>.webp`。
 * ★ 对 `memoryKey` 取 sha1：路径里的中文、斜杠、空格都不该进文件名；
 *   图片一变（mtime/size 变）键就变，旧文件自然成为可删的垃圾 —— 无需失效逻辑。
 * sha1 用 `globalThis.crypto.subtle.digest('SHA-1', ...)`。
 */
export async function thumbnailFilePath(key: string): Promise<string> {
  const bytes = new TextEncoder().encode(key);
  const digest = await globalThis.crypto.subtle.digest('SHA-1', bytes);
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return `${THUMB_DIR}/${hex}${THUMB_EXT}`;
}

export interface ThumbnailCacheOptions {
  store: ThumbnailStore;
  render: ThumbnailRenderer;
  /** 内存 LRU 上限，默认 THUMB_MEMORY_LIMIT */
  memoryLimit?: number;
  /**
   * 缩略图就绪时回调（键 = `memoryKey(...)`）。
   * ★ 用途：卡片可能已经用原图挂上去了，拿到缩略图后由调用方直接改一次 `img.src`，
   *   而不是让整个视图重新渲染一遍（那是性能灾难）。
   */
  onReady?: (key: string, url: string) => void;
}

export interface ThumbnailStats {
  hits: number;
  misses: number;
  /** 当前内存缓存中的条目数 */
  entries: number;
  /** 渲染失败（renderer 返回 null 或抛错）的次数 */
  failures: number;
}

/** `BlobPart` 在使用处的类型别名，避免直接把 `unknown` 撒得到处都是 */
type ObjectUrlInput = BlobPart;

export class ThumbnailCache {
  private readonly store: ThumbnailStore;
  private readonly render: ThumbnailRenderer;
  private readonly memoryLimit: number;
  private readonly onReady: ((key: string, url: string) => void) | undefined;

  /** key → objectURL；Map 的迭代顺序即 LRU 顺序（最近使用的在末尾） */
  private readonly memory = new Map<string, string>();
  /**
   * 进行中的生成请求。
   * ★ 合并并发：一次滚动可能对同一张图发起十几次请求，
   *   不合并就是一帧里跑十几次 canvas 渲染。
   */
  private readonly pending = new Map<string, Promise<string | null>>();
  /** 已确认存在于磁盘的缩略图路径，省掉重复的 `exists` 探针 */
  private readonly onDisk = new Set<string>();

  private hits = 0;
  private misses = 0;
  private failures = 0;
  /** 已 `dispose`。用于拦住"视图关掉之后才落到"的那批生成结果（见 `remember`） */
  private disposed = false;

  constructor(options: ThumbnailCacheOptions) {
    this.store = options.store;
    this.render = options.render;
    this.memoryLimit = options.memoryLimit ?? THUMB_MEMORY_LIMIT;
    this.onReady = options.onReady;
  }

  /** 同步查内存：有就返回 objectURL，没有返回 null。**不触发**生成 */
  peek(key: string): string | null {
    return this.touch(key);
  }

  /**
   * 取缩略图 objectURL：内存有则立刻返回；否则落盘有则读出来造 URL；
   * 都没有则调 `render(source)` 生成 → 写盘 → 造 URL → 触发 `onReady`。
   */
  async get(key: string, source: ThumbnailSourceRef): Promise<string | null> {
    const cached = this.touch(key);
    if (cached !== null) {
      this.hits += 1;
      return cached;
    }
    this.misses += 1;

    // ★ 同一 key 的并发调用合并成一次生成
    const inflight = this.pending.get(key);
    if (inflight !== undefined) return inflight;

    const task = this.produce(key, source);
    this.pending.set(key, task);
    try {
      return await task;
    } finally {
      // 无论成败都要清掉，否则下次同 key 会永远拿到一个已结束的 Promise
      this.pending.delete(key);
    }
  }

  /** 丢弃某个键（图片被删/改时调用）：撤掉 objectURL，删掉磁盘文件 */
  async invalidate(key: string): Promise<void> {
    const url = this.memory.get(key);
    if (url !== undefined) {
      this.memory.delete(key);
      this.revoke(url);
    }

    const filePath = await thumbnailFilePath(key);
    this.onDisk.delete(filePath);
    try {
      if (await this.store.exists(filePath)) await this.store.remove(filePath);
    } catch (error) {
      // 删缓存失败不该打断调用方（图片该删还是得删）
      console.warn('[nestboard] 删除缩略图缓存失败', describeError(error));
    }
  }

  stats(): ThumbnailStats {
    return {
      hits: this.hits,
      misses: this.misses,
      entries: this.memory.size,
      failures: this.failures,
    };
  }

  /** 释放全部 objectURL。视图 `onClose` 必须调用，否则 blob 会一直占着内存 */
  dispose(): void {
    this.disposed = true;
    for (const url of this.memory.values()) this.revoke(url);
    this.memory.clear();
    this.pending.clear();
  }

  // ── 内部 ─────────────────────────────────────────────────

  /** 真正的生成流程；调用方保证同一 key 同时只有一次 */
  private async produce(key: string, source: ThumbnailSourceRef): Promise<string | null> {
    const filePath = await thumbnailFilePath(key);

    // 1) 落盘命中：读出来直接造 URL，省掉一次渲染
    try {
      if (this.onDisk.has(filePath) || (await this.store.exists(filePath))) {
        const data = await this.store.readBinary(filePath);
        const url = this.toObjectUrl(data);
        this.onDisk.add(filePath);
        this.remember(key, url);
        return url;
      }
    } catch (error) {
      // 读盘失败（文件刚被清理 / 权限）→ 当作没缓存，继续走渲染
      console.warn('[nestboard] 读取缩略图缓存失败', describeError(error));
    }

    // 2) 渲染
    let blob: Blob | null = null;
    try {
      blob = await this.render(source);
    } catch (error) {
      console.warn('[nestboard] 渲染缩略图失败', describeError(error));
      blob = null;
    }
    if (blob === null) {
      // ★ 渲染失败只计数不抛错：缩略图是优化，失败就退回原图，不该让卡片渲染也挂掉
      this.failures += 1;
      return null;
    }

    const url = this.toObjectUrl(blob);

    // 3) 落盘：写失败也要把 URL 还给调用方（图能看见比缓存完整重要）
    try {
      const buffer = await blob.arrayBuffer();
      await this.store.writeBinary(filePath, buffer);
      this.onDisk.add(filePath);
    } catch (error) {
      console.warn('[nestboard] 写入缩略图缓存失败', describeError(error));
    }

    this.remember(key, url);
    this.notifyReady(key, url);
    return url;
  }

  /** 命中即刷新 LRU 顺序（Map 末尾 = 最近使用） */
  private touch(key: string): string | null {
    const url = this.memory.get(key);
    if (url === undefined) return null;
    this.memory.delete(key);
    this.memory.set(key, url);
    return url;
  }

  private remember(key: string, url: string): void {
    // ★ `dispose` 之后才落地的结果：视图已经关了，这个 objectURL 再没人会引用 ——
    //   存进表里就是永久泄漏（表已清空，`dispose` 也不会再跑第二次）。
    //   切板时正好有一张图在生成，就是这么漏掉的。
    if (this.disposed) {
      this.revoke(url);
      return;
    }
    if (this.memory.has(key)) this.memory.delete(key);
    this.memory.set(key, url);
    // 超出上限时释放最久未用的（Map 首项）
    while (this.memory.size > this.memoryLimit) {
      const oldest = this.memory.keys().next().value;
      if (oldest === undefined) break;
      const evicted = this.memory.get(oldest);
      this.memory.delete(oldest);
      if (evicted !== undefined) this.revoke(evicted);
    }
  }

  /**
   * ★ 在使用处做能力探测：部分运行环境（测试用的 Node、旧 WebView）没有 `URL.createObjectURL`。
   *   若在模块顶层就解引用它，整个模块会在 import 期崩溃、所有用例无法加载；
   *   探测不到就退化返回 `''` —— 空串也算"有值"（`peek`/`get` 一律用 `!== null` 判断），
   *   只是没有可显示的 URL 而已。
   */
  private toObjectUrl(data: ObjectUrlInput): string {
    if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return '';
    return URL.createObjectURL(new Blob([data]));
  }

  private revoke(url: string): void {
    if (url.length === 0) return;
    if (typeof URL === 'undefined' || typeof URL.revokeObjectURL !== 'function') return;
    URL.revokeObjectURL(url);
  }

  private notifyReady(key: string, url: string): void {
    if (!this.onReady) return;
    try {
      this.onReady(key, url);
    } catch (error) {
      // 回调是调用方的代码，抛错不能反过来拖垮缩略图生成
      console.warn('[nestboard] onReady 回调抛错', describeError(error));
    }
  }
}
