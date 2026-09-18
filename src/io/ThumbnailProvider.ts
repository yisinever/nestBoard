/**
 * 缩略图提供者（T1.52）—— 把卡片层的**按路径**请求，翻译成缓存层的**按 `memoryKey`**调用。
 *
 * 两半件事各归各位：
 * - `ThumbnailCache`（`io/ThumbnailCache.ts`）只管"给你一个 key，还你一个 objectURL"；
 * - 本文件负责"路径 → key"这一步需要的 `mtime` / `size`，以及**同步**的 `peek`。
 *
 * ★ 为什么需要这一层：`memoryKey` 要 `mtime` + `size`，而这两个值只能**异步**从
 *   `vault.adapter.stat()` 拿；图片卡却要在首帧**同步**决定"这帧用缩略图还是原图"。
 *   解法是这里自己维护一张 `path → objectURL` 的表：某张图第一次被取过之后，
 *   之后所有帧的 `peek` 都能同步命中。
 *
 * ★ 不 import `obsidian`：`stat` 与 `resourceUrl` 走 `ThumbnailSource` 端口注入，
 *   所以本文件（连同它全部的合并/失效逻辑）能在 node 下单测。
 *   生产实现在 `integration/ObsidianThumbnailBridge.ts`。
 */

import type { ThumbnailBridge } from '../cards/registry';
import { memoryKey, type ThumbnailCache, type ThumbnailStats } from './ThumbnailCache';

/** 缩略图管线需要的两件外部信息；两件都可能"给不出来"（文件不在 Vault / 移动端） */
export interface ThumbnailSource {
  /** 文件信息；不是文件 / 不在 Vault / 读不到 → `null` */
  stat(path: string): Promise<{ mtime: number; size: number } | null>;
  /** 原图 URL；拿不到（移动端没有文件系统适配器）→ `null` */
  resourceUrl(path: string): string | null;
}

/**
 * 缩略图的目标尺寸（纯函数）。
 *
 * 等比缩到"最长边 = `max`"，**只缩不放**（原图本来就小的话，放大只会让它更糊）；
 * 尺寸拿不到（0 / NaN）时退到 1×1 —— canvas 的宽高设成 0 会静默不作画，
 * 与其产出一个空白的缩略图缓存文件，不如让它明确失败。
 */
export function thumbnailScale(
  width: number,
  height: number,
  max: number,
): { width: number; height: number } {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { width: 1, height: 1 };
  }
  const scale = Math.min(1, max / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export class ThumbnailProvider implements ThumbnailBridge {
  /** path → 已就绪的 objectURL。存在的意义就是让 `peek` **同步**可答 */
  private readonly ready = new Map<string, string>();
  /**
   * path → 进行中的请求。
   * ★ 合并并发：同一帧里同一张图可能被问好几次（卡片复用、重绘），
   *   不合并就是每次滚动都重新 stat 一遍磁盘。
   */
  private readonly inflight = new Map<string, Promise<string | null>>();
  /** 视图已关闭。晚到的异步结果不许再写进表里（那张表已经清空，写进去就是永久泄漏） */
  private disposed = false;

  constructor(
    private readonly cache: ThumbnailCache,
    private readonly source: ThumbnailSource,
  ) {}

  peek(path: string): string | null {
    return this.ready.get(path) ?? null;
  }

  async get(path: string): Promise<string | null> {
    if (path.length === 0 || this.disposed) return null;

    const done = this.ready.get(path);
    if (done !== undefined) return done;

    const running = this.inflight.get(path);
    if (running !== undefined) return running;

    const task = this.load(path);
    this.inflight.set(path, task);
    try {
      return await task;
    } finally {
      this.inflight.delete(path);
    }
  }

  /**
   * 原图变了（`meta.modify`）或图片卡被删：忘掉路径映射，下次 `get` 重新 `stat`。
   *
   * ★ 不需要（也无法）主动找旧 key 去删磁盘文件：键里带着 `mtime`/`size`，
   *   原图一变键就变，旧文件自然成了没人再引用的垃圾 —— 这正是
   *   `memoryKey` 把版本信息编进键里的目的。
   */
  invalidate(path: string): void {
    this.ready.delete(path);
  }

  /**
   * 缓存画像（T2.17 诊断面板）。
   *
   * ★ 这里唯一"有解释力"的数字是命中率：`misses` 持续增长说明键一直在变
   *   （原图被改过 / 拿不到 `stat`），等于缓存没起作用 —— 那正是"图片卡越用越卡"
   *   的根因，光看"缓存里有几条"是看不出来的。
   */
  stats(): ThumbnailStats {
    return this.cache.stats();
  }

  dispose(): void {
    this.disposed = true;
    this.cache.dispose();
    this.ready.clear();
    this.inflight.clear();
  }

  private async load(path: string): Promise<string | null> {
    const info = await this.statOf(path);
    if (!info) return null;

    // ★ "能不能渲染"是**渲染器**的判断，不在这里替它挡：图片渲染器拿不到原图 URL
    //   （移动端）确实没法画，但板级缩略图（T4.16）根本不需要 URL —— 它按 `path`
    //   自己去读 `.nboard`。以前这道 `if (!url) return null` 顺手把板级管线也挡了。
    const thumb = await this.cache.get(memoryKey(path, info.mtime, info.size), {
      path,
      url: this.source.resourceUrl(path),
    });
    if (thumb === null) return null;
    if (this.disposed) return null;
    this.ready.set(path, thumb);
    return thumb;
  }

  /** `stat` 在端口后面可能抛错（路径过期、权限），这里统一收成 `null` */
  private async statOf(path: string): Promise<{ mtime: number; size: number } | null> {
    try {
      return await this.source.stat(path);
    } catch {
      return null;
    }
  }
}
