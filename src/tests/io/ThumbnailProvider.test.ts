/**
 * 缩略图提供者单元测试（T1.52 的集成半件）。
 *
 * 这里用的是**真的** `ThumbnailCache`（配内存假 store 与假渲染器）——
 * 因为本文件要验的恰恰是"缓存 + 路径映射"两者拼起来的语义，
 * 把缓存也换成替身就等于把要测的东西测没了。
 *
 * 重点四条：
 *   1. **`peek` 同步命中**：第一次 `get` 之后，同一路径的后续帧不必再等异步；
 *   2. **并发合并**：同一帧里同一张图被问 N 次，只 `stat` 一次、只渲染一次；
 *   3. **没缩略图就老实说没有**：`stat` 失败 / 渲染器画不出来 → `null`，
 *      调用方据此退化成原图或概要面板（绝不能返回一个空串 URL，那会让 `<img>` 白屏）；
 *      ★ "画不画得出来"归**渲染器**判断：图片渲染器没有原图 URL 就返回 `null`，
 *      而板级渲染器（T4.16）不看 URL、按 `path` 读 `.nboard` —— 提供者不替它们挡；
 *   4. **`dispose` 之后晚到的结果不许复活**：视图关掉后还在飞的 Promise
 *      若把 URL 写回表里，那批 blob 就永远没人撤了。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThumbnailCache } from '../../io/ThumbnailCache';
import type {
  ThumbnailRenderer,
  ThumbnailSourceRef,
  ThumbnailStore,
} from '../../io/ThumbnailCache';
import { ThumbnailProvider, thumbnailScale } from '../../io/ThumbnailProvider';
import type { ThumbnailSource } from '../../io/ThumbnailProvider';

function blobOf(size = 4): Blob {
  return new Blob([new Uint8Array(size)]);
}

class FakeStore implements ThumbnailStore {
  readonly files = new Map<string, ArrayBuffer>();

  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    const data = this.files.get(path);
    if (data === undefined) throw new Error(`缩略图不存在：${path}`);
    return data;
  }

  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    this.files.set(path, data);
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }
}

const realCreateObjectURL = URL.createObjectURL;
const realRevokeObjectURL = URL.revokeObjectURL;
let revoked: string[] = [];

beforeEach(() => {
  revoked = [];
  let next = 0;
  Object.assign(URL, {
    createObjectURL: (_blob: Blob): string => {
      const url = `blob:test-${next}`;
      next += 1;
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

/** 可编程的假端口：默认"文件存在、mtime=1000、size=2048、URL 可用" */
function makeSource(overrides: Partial<ThumbnailSource> = {}) {
  const stat = vi.fn(async () => ({ mtime: 1000, size: 2048 }));
  const resourceUrl = vi.fn(() => 'app://local/photo.png');
  return {
    source: { stat, resourceUrl, ...overrides } as ThumbnailSource,
    stat,
    resourceUrl,
  };
}

function makeProvider(
  source: ThumbnailSource,
  render: ThumbnailRenderer = vi.fn(async () => blobOf()),
) {
  const store = new FakeStore();
  const cache = new ThumbnailCache({ store, render });
  return { provider: new ThumbnailProvider(cache, source), store, render, cache };
}

// ── 纯函数 ────────────────────────────────────────────────────

describe('thumbnailScale', () => {
  it('横图按长边等比缩放（长边 = 上限）', () => {
    expect(thumbnailScale(1000, 500, 256)).toEqual({ width: 256, height: 128 });
  });

  it('竖图同理（不能把竖图压成一坨）', () => {
    expect(thumbnailScale(500, 1000, 256)).toEqual({ width: 128, height: 256 });
  });

  it('本来就小的图**不放大**：放大只会更糊', () => {
    expect(thumbnailScale(64, 32, 256)).toEqual({ width: 64, height: 32 });
  });

  it('极端长宽比至少留 1px（四舍五入到 0 会让 canvas 静默不作画）', () => {
    expect(thumbnailScale(4000, 20, 256)).toEqual({ width: 256, height: 1 });
  });

  it('尺寸拿不到时退到 1×1，而不是 NaN', () => {
    expect(thumbnailScale(0, 100, 256)).toEqual({ width: 1, height: 1 });
    expect(thumbnailScale(Number.NaN, 100, 256)).toEqual({ width: 1, height: 1 });
    expect(thumbnailScale(-10, 100, 256)).toEqual({ width: 1, height: 1 });
  });
});

// ── Provider ──────────────────────────────────────────────────

describe('ThumbnailProvider', () => {
  it('第一次 `get` 之后 `peek` 同步命中（首帧用原图、后续帧才换缩略图）', async () => {
    const { source } = makeSource();
    const { provider } = makeProvider(source);

    expect(provider.peek('photo.png')).toBeNull();
    const url = await provider.get('photo.png');
    expect(url).toBe('blob:test-0');
    expect(provider.peek('photo.png')).toBe('blob:test-0');
  });

  it('空路径直接返回 null，不碰 `stat`', async () => {
    const { source, stat } = makeSource();
    const { provider } = makeProvider(source);

    expect(await provider.get('')).toBeNull();
    expect(stat).not.toHaveBeenCalled();
  });

  it('并发请求合并：同一路径只 `stat` 一次、只渲染一次', async () => {
    const { source, stat } = makeSource();
    const { provider, render } = makeProvider(source);

    const [a, b, c] = await Promise.all([
      provider.get('photo.png'),
      provider.get('photo.png'),
      provider.get('photo.png'),
    ]);

    expect([a, b, c]).toEqual(['blob:test-0', 'blob:test-0', 'blob:test-0']);
    expect(stat).toHaveBeenCalledTimes(1);
    expect(render).toHaveBeenCalledTimes(1);
  });

  it('已就绪的路径不再 `stat`（滚动时每次绘制都 stat 一遍磁盘是不可接受的）', async () => {
    const { source, stat } = makeSource();
    const { provider } = makeProvider(source);

    await provider.get('photo.png');
    await provider.get('photo.png');

    expect(stat).toHaveBeenCalledTimes(1);
  });

  it('`stat` 失败 → null（卡片继续用原图）', async () => {
    const { source } = makeSource({ stat: vi.fn(async () => null) });
    const { provider } = makeProvider(source);

    expect(await provider.get('photo.png')).toBeNull();
    expect(provider.peek('photo.png')).toBeNull();
  });

  it('`stat` 抛错也收成 null（端口后面什么都可能发生）', async () => {
    const { source } = makeSource({
      stat: vi.fn(async () => {
        throw new Error('权限变了');
      }),
    });
    const { provider } = makeProvider(source);

    expect(await provider.get('photo.png')).toBeNull();
  });

  it('原图 URL 拿不到时也照样交给渲染器，"能不能画"是渲染器的判断', async () => {
    const { source } = makeSource({ resourceUrl: vi.fn(() => null) });
    // 模拟**图片**渲染器：没有 URL 就是画不出来
    const render = vi.fn(async (ref: ThumbnailSourceRef) => (ref.url === null ? null : blobOf()));
    const { provider } = makeProvider(source, render);

    expect(await provider.get('photo.png')).toBeNull();
    // ★ 递下去的是"路径 + URL"而不是裸 URL —— 板级渲染器（T4.16）按 `path` 读 `.nboard`，
    //   提供者不能因为"图片这条路走不通"就替它把这次调用挡掉
    expect(render).toHaveBeenCalledTimes(1);
    expect(render.mock.calls[0]?.[0]).toEqual({ path: 'photo.png', url: null });
  });

  it('★ 板级渲染器：原图 URL 为 null 照样出图（移动端 / 非文件系统适配器）', async () => {
    const { source } = makeSource({ resourceUrl: vi.fn(() => null) });
    const { provider } = makeProvider(
      source,
      vi.fn(async () => blobOf()),
    );

    expect(await provider.get('Boards/子板.nboard')).toBe('blob:test-0');
  });

  it('渲染失败 → null，且**不写** `peek`（不能让下一帧以为有缩略图）', async () => {
    const { source } = makeSource();
    const { provider } = makeProvider(
      source,
      vi.fn(async () => null),
    );

    expect(await provider.get('photo.png')).toBeNull();
    expect(provider.peek('photo.png')).toBeNull();
  });

  it('原图变了：`invalidate` 之后重新 `stat`，键变了就重新渲染', async () => {
    let mtime = 1000;
    // 断言要打在自己的 mock 上：`makeSource` 回传的是它**默认**造的那个（没被用上）
    const stat = vi.fn(async () => ({ mtime, size: 2048 }));
    const { source } = makeSource({ stat });
    const { provider, render, store } = makeProvider(source);

    expect(await provider.get('photo.png')).toBe('blob:test-0');
    expect(store.files.size).toBe(1);

    mtime = 2000;
    provider.invalidate('photo.png');
    expect(provider.peek('photo.png')).toBeNull();

    expect(await provider.get('photo.png')).toBe('blob:test-1');
    expect(stat).toHaveBeenCalledTimes(2);
    expect(render).toHaveBeenCalledTimes(2);
    // 旧键的缓存文件留在盘上没人引用 —— 由"键随内容变"自然回收，不需要失效逻辑
    expect(store.files.size).toBe(2);
  });

  it('换一个缓存实例（等价于重开视图）仍命中**磁盘**，不重新渲染', async () => {
    const { source } = makeSource();
    const store = new FakeStore();
    const render = vi.fn(async () => blobOf());

    const provider = new ThumbnailProvider(new ThumbnailCache({ store, render }), source);
    await provider.get('photo.png');
    expect(render).toHaveBeenCalledTimes(1);
    expect(store.files.size).toBe(1);

    const provider2 = new ThumbnailProvider(new ThumbnailCache({ store, render }), source);
    expect(await provider2.get('photo.png')).toBe('blob:test-1');
    expect(render).toHaveBeenCalledTimes(1);
  });

  it('`dispose` 之后晚到的结果不许复活（切板时正在生成的图就是这条路）', async () => {
    // 把 `stat` 卡住 → `get` 一定停在异步里，`dispose` 必定早于结果落地。
    // 比"数微任务轮次"确定得多（`crypto.subtle` 的时序不承诺）。
    const gate: { release: ((value: { mtime: number; size: number }) => void) | null } = {
      release: null,
    };
    const stat = vi.fn(
      () =>
        new Promise<{ mtime: number; size: number }>((resolve) => {
          gate.release = resolve;
        }),
    );
    const { source } = makeSource({ stat });
    const { provider, cache } = makeProvider(source);

    const task = provider.get('photo.png');
    provider.dispose();
    expect(revoked).toEqual([]);

    expect(gate.release).not.toBeNull();
    gate.release?.({ mtime: 1000, size: 2048 });

    // 视图已经关了：不返回 URL，也不写进已清空的表
    expect(await task).toBeNull();
    expect(provider.peek('photo.png')).toBeNull();
    // 关掉之后再取也没反应（不再碰磁盘）
    expect(await provider.get('photo.png')).toBeNull();
    // ★ 生成的 objectURL 必须被**当场**撤掉：`ThumbnailCache` 已经清空，
    //   晚到的那一条若还留在表里，就再也没人负责释放了
    expect(revoked.length).toBeGreaterThan(0);
    expect(cache.stats().entries).toBe(0);
  });
});
