import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  THUMB_DIR,
  THUMB_EXT,
  THUMB_MEMORY_LIMIT,
  THUMB_QUALITY,
  THUMB_SIZE,
  ThumbnailCache,
  memoryKey,
  thumbnailFilePath,
} from '../../io/ThumbnailCache';
import type { ThumbnailStore } from '../../io/ThumbnailCache';

/**
 * `get` 的第二个参数：来源对象。
 * ★ T4.16 起渲染器收的是「路径 + URL」而不是裸 URL —— 因为板级缩略图
 *   不看 URL（它按 `path` 读 `.nboard` 再画），图片渲染器才看。
 */
const SOURCE = { path: 'a.png', url: 'app://source' } as const;

function bufferOf(...values: number[]): ArrayBuffer {
  const out = new ArrayBuffer(values.length);
  new Uint8Array(out).set(values);
  return out;
}

function blobOf(...values: number[]): Blob {
  const out = new Uint8Array(values.length);
  out.set(values);
  return new Blob([out]);
}

/** 用 Web API 自算 sha1，避免在测试里 import Node 的 crypto（eslint 禁止） */
async function sha1Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

class FakeStore implements ThumbnailStore {
  readonly files = new Map<string, ArrayBuffer>();
  readonly removed: string[] = [];
  failWrite = false;

  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    const data = this.files.get(path);
    if (data === undefined) throw new Error(`缩略图不存在：${path}`);
    return data;
  }

  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    if (this.failWrite) throw new Error('磁盘写失败');
    this.files.set(path, data);
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
    this.removed.push(path);
  }
}

// ── objectURL 替身 ──────────────────────────────────────────
// 真实 blob URL 不可预测，测试里替换成确定性的 `blob:test-N`，顺带记录撤销调用。

const realCreateObjectURL = URL.createObjectURL;
const realRevokeObjectURL = URL.revokeObjectURL;

let created: string[] = [];
let revoked: string[] = [];

beforeEach(() => {
  created = [];
  revoked = [];
  let next = 0;
  Object.assign(URL, {
    createObjectURL: (_blob: Blob): string => {
      const url = `blob:test-${next}`;
      next += 1;
      created.push(url);
      return url;
    },
    revokeObjectURL: (url: string): void => {
      revoked.push(url);
    },
  });
});

afterEach(() => {
  Object.assign(URL, {
    createObjectURL: realCreateObjectURL,
    revokeObjectURL: realRevokeObjectURL,
  });
});

describe('缩略图常量', () => {
  it('目录 / 尺寸 / 质量 / 扩展名 / 内存上限', () => {
    expect(THUMB_DIR).toBe('cache/thumbs');
    expect(THUMB_SIZE).toBe(256);
    expect(THUMB_QUALITY).toBe(0.8);
    expect(THUMB_EXT).toBe('.webp');
    expect(THUMB_MEMORY_LIMIT).toBe(300);
  });
});

describe('memoryKey', () => {
  it('同步拼出 <path>@<mtime>@<size>', () => {
    expect(memoryKey('a/b.png', 1000, 2048)).toBe('a/b.png@1000@2048');
  });
});

describe('thumbnailFilePath', () => {
  it('对内存键取 sha1，落在 cache/thumbs/<sha1>.webp', async () => {
    const path = await thumbnailFilePath('我的图.png@1@2');
    expect(path).toBe(`${THUMB_DIR}/${await sha1Hex('我的图.png@1@2')}${THUMB_EXT}`);
  });

  it('同键同路径、异键异路径', async () => {
    const a = await thumbnailFilePath('k@1@1');
    const b = await thumbnailFilePath('k@1@1');
    const c = await thumbnailFilePath('k@2@1');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('ThumbnailCache · 基本取用', () => {
  it('peek 不触发生成', () => {
    let renderCalls = 0;
    const cache = new ThumbnailCache({
      store: new FakeStore(),
      render: async () => {
        renderCalls += 1;
        return blobOf(1);
      },
    });

    expect(cache.peek('k')).toBeNull();
    expect(renderCalls).toBe(0);
    expect(cache.stats().entries).toBe(0);
  });

  it('未命中时渲染 → 写盘 → 返回 URL，并计数', async () => {
    const store = new FakeStore();
    const cache = new ThumbnailCache({ store, render: async () => blobOf(1, 2, 3) });

    const url = await cache.get('k', SOURCE);

    expect(url).toBe(created[0]);
    expect(store.files.has(await thumbnailFilePath('k'))).toBe(true);
    expect(cache.stats()).toEqual({ hits: 0, misses: 1, entries: 1, failures: 0 });
  });

  it('内存命中：返回同一 URL，不重复渲染', async () => {
    let renderCalls = 0;
    const cache = new ThumbnailCache({
      store: new FakeStore(),
      render: async () => {
        renderCalls += 1;
        return blobOf(1);
      },
    });

    const first = await cache.get('k', SOURCE);
    const second = await cache.get('k', SOURCE);

    expect(second).toBe(first);
    expect(renderCalls).toBe(1);
    expect(cache.stats()).toEqual({ hits: 1, misses: 1, entries: 1, failures: 0 });
  });

  it('落盘命中：读盘造 URL，不渲染', async () => {
    const store = new FakeStore();
    const filePath = await thumbnailFilePath('k');
    store.files.set(filePath, bufferOf(7, 7, 7));
    let renderCalls = 0;
    const cache = new ThumbnailCache({
      store,
      render: async () => {
        renderCalls += 1;
        return blobOf(1);
      },
    });

    const url = await cache.get('k', SOURCE);

    expect(url).toBe(created[0]);
    expect(renderCalls).toBe(0);
    expect(cache.stats()).toEqual({ hits: 0, misses: 1, entries: 1, failures: 0 });
  });

  it('同一 key 的并发请求合并成一次渲染', async () => {
    const store = new FakeStore();
    let renderCalls = 0;
    let release!: (value: Blob | null) => void;
    const gate = new Promise<Blob | null>((resolve) => {
      release = resolve;
    });
    const cache = new ThumbnailCache({
      store,
      render: () => {
        renderCalls += 1;
        return gate;
      },
    });

    const first = cache.get('k', SOURCE);
    const second = cache.get('k', SOURCE);
    release(blobOf(1));
    const [a, b] = await Promise.all([first, second]);

    expect(a).toBe(b);
    expect(renderCalls).toBe(1);
    expect(created).toHaveLength(1);
    expect(cache.stats().misses).toBe(2);
    expect(cache.stats().hits).toBe(0);
  });
});

describe('ThumbnailCache · 失败路径', () => {
  it('renderer 返回 null → failures++，返回 null，不写盘', async () => {
    const store = new FakeStore();
    const cache = new ThumbnailCache({ store, render: async () => null });

    await expect(cache.get('k', SOURCE)).resolves.toBeNull();
    expect(store.files.size).toBe(0);
    expect(cache.stats()).toEqual({ hits: 0, misses: 1, entries: 0, failures: 1 });
  });

  it('renderer 抛错 → failures++，绝不向上抛', async () => {
    const cache = new ThumbnailCache({
      store: new FakeStore(),
      render: async () => {
        throw new Error('canvas 挂了');
      },
    });

    await expect(cache.get('k', SOURCE)).resolves.toBeNull();
    expect(cache.stats().failures).toBe(1);
  });

  it('落盘失败 → 仍返回内存 URL（图能看见比缓存完整重要）', async () => {
    const store = new FakeStore();
    store.failWrite = true;
    const cache = new ThumbnailCache({ store, render: async () => blobOf(1) });

    const url = await cache.get('k', SOURCE);

    expect(url).toBe(created[0]);
    expect(store.files.size).toBe(0);
    expect(cache.stats()).toEqual({ hits: 0, misses: 1, entries: 1, failures: 0 });
  });

  it('store.exists 抛错时退回渲染，而不是把异常漏出去', async () => {
    const store = new FakeStore();
    store.exists = async () => {
      throw new Error('读取失败');
    };
    const cache = new ThumbnailCache({ store, render: async () => blobOf(1) });

    const url = await cache.get('k', SOURCE);

    expect(url).toBe(created[0]);
  });
});

describe('ThumbnailCache · onReady', () => {
  it('渲染出新缩略图时回调（键与 URL）', async () => {
    const ready: Array<{ key: string; url: string }> = [];
    const cache = new ThumbnailCache({
      store: new FakeStore(),
      render: async () => blobOf(1),
      onReady: (key, url) => ready.push({ key, url }),
    });

    const url = await cache.get('k', SOURCE);

    expect(ready).toEqual([{ key: 'k', url }]);
  });

  it('内存命中不重复回调', async () => {
    const ready: string[] = [];
    const cache = new ThumbnailCache({
      store: new FakeStore(),
      render: async () => blobOf(1),
      onReady: (key) => ready.push(key),
    });

    await cache.get('k', SOURCE);
    await cache.get('k', SOURCE);

    expect(ready).toEqual(['k']);
  });

  it('落盘命中不回调（调用方已从返回值拿到 URL），也不渲染', async () => {
    const store = new FakeStore();
    store.files.set(await thumbnailFilePath('k'), bufferOf(1));
    let renderCalls = 0;
    const ready: unknown[] = [];
    const cache = new ThumbnailCache({
      store,
      render: async () => {
        renderCalls += 1;
        return blobOf(1);
      },
      onReady: (key, url) => ready.push({ key, url }),
    });

    await cache.get('k', SOURCE);

    expect(renderCalls).toBe(0);
    expect(ready).toEqual([]);
  });
});

describe('ThumbnailCache · LRU 与释放', () => {
  it('超出 memoryLimit 时释放最久未用的 objectURL', async () => {
    const cache = new ThumbnailCache({
      store: new FakeStore(),
      render: async () => blobOf(1),
      memoryLimit: 2,
    });

    const u0 = await cache.get('k0', SOURCE);
    const u1 = await cache.get('k1', SOURCE);
    const u2 = await cache.get('k2', SOURCE);

    expect(cache.stats().entries).toBe(2);
    expect(revoked).toEqual([u0]);
    expect(u0).not.toBeNull();
    expect(u1).not.toBeNull();
    expect(cache.peek('k0')).toBeNull();
    expect(cache.peek('k2')).toBe(u2);
  });

  it('peek 命中会刷新 LRU 顺序（最近用过的不会被先淘汰）', async () => {
    const cache = new ThumbnailCache({
      store: new FakeStore(),
      render: async () => blobOf(1),
      memoryLimit: 2,
    });

    const u0 = await cache.get('k0', SOURCE);
    const u1 = await cache.get('k1', SOURCE);
    expect(cache.peek('k0')).toBe(u0);

    await cache.get('k2', SOURCE);

    expect(revoked).toEqual([u1]);
    expect(cache.peek('k0')).toBe(u0);
  });

  it('invalidate 撤掉 objectURL 并删除磁盘文件', async () => {
    const store = new FakeStore();
    const cache = new ThumbnailCache({ store, render: async () => blobOf(1) });
    const url = await cache.get('k', SOURCE);
    const filePath = await thumbnailFilePath('k');
    expect(store.files.has(filePath)).toBe(true);

    await cache.invalidate('k');

    expect(cache.peek('k')).toBeNull();
    expect(revoked).toContain(url);
    expect(store.removed).toEqual([filePath]);
    expect(store.files.has(filePath)).toBe(false);
  });

  it('dispose 释放全部 objectURL，且幂等', async () => {
    const cache = new ThumbnailCache({ store: new FakeStore(), render: async () => blobOf(1) });
    const u0 = await cache.get('k0', SOURCE);
    const u1 = await cache.get('k1', SOURCE);

    cache.dispose();

    expect(revoked).toEqual([u0, u1]);
    expect(cache.stats().entries).toBe(0);
    expect(() => cache.dispose()).not.toThrow();
  });
});

describe('ThumbnailCache · 无 objectURL 能力的环境', () => {
  it('★ 缺少 URL.createObjectURL 时退化为空串，不让模块崩掉', async () => {
    Reflect.deleteProperty(URL, 'createObjectURL');
    const cache = new ThumbnailCache({ store: new FakeStore(), render: async () => blobOf(1) });

    await expect(cache.get('k', SOURCE)).resolves.toBe('');
    // 空串也算"有缓存"：再次取用命中内存，不重复渲染
    await expect(cache.get('k', SOURCE)).resolves.toBe('');
    expect(cache.stats().hits).toBe(1);
  });
});
