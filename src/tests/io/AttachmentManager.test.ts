import { describe, expect, it, vi } from 'vitest';
import {
  AttachmentManager,
  DEFAULT_ATTACHMENT_CONFIG,
  contentHash,
  extensionForMime,
  resolveAttachmentFolder,
  timestampPrefix,
} from '../../io/AttachmentManager';
import type { AttachmentConfig, AttachmentSink } from '../../io/AttachmentManager';

/** 用真实 ArrayBuffer（不用 `.buffer`，避免 ArrayBufferLike 与 SharedArrayBuffer 的类型歧义） */
function bufferOf(...values: number[]): ArrayBuffer {
  const out = new ArrayBuffer(values.length);
  new Uint8Array(out).set(values);
  return out;
}

/** 内存版 AttachmentSink：够简单，能断言"写了几次 / 写了哪些路径" */
class FakeSink implements AttachmentSink {
  readonly files = new Map<string, ArrayBuffer>();
  readonly writes: string[] = [];
  readonly ensureCalls: string[] = [];

  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }

  async ensureFolder(folder: string): Promise<void> {
    this.ensureCalls.push(folder);
  }

  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    this.files.set(path, data);
    this.writes.push(path);
  }

  /** 预置"已存在"的文件，用来触发同名顺延 */
  seed(path: string): void {
    this.files.set(path, bufferOf(0));
  }
}

/** 固定时间：2026-09-11 15:30:12（本地时间），让命名断言可确定 */
const NOW = new Date(2026, 8, 11, 15, 30, 12);
const STAMP = '20260911-153012';

function configOf(overrides: Partial<AttachmentConfig> = {}): () => AttachmentConfig {
  return () => ({ ...DEFAULT_ATTACHMENT_CONFIG, ...overrides });
}

describe('DEFAULT_ATTACHMENT_CONFIG', () => {
  it('默认不启用去重，附件落在 Vault 根目录', () => {
    expect(DEFAULT_ATTACHMENT_CONFIG).toEqual({ folder: '', dedupe: false });
  });
});

describe('resolveAttachmentFolder', () => {
  it('空值 / 根标记 → 库根目录', () => {
    expect(resolveAttachmentFolder('')).toBe('');
    expect(resolveAttachmentFolder('/')).toBe('');
    expect(resolveAttachmentFolder('   ')).toBe('');
  });

  it('固定目录：去掉首尾斜杠', () => {
    expect(resolveAttachmentFolder('attachments')).toBe('attachments');
    expect(resolveAttachmentFolder('/attachments/')).toBe('attachments');
    expect(resolveAttachmentFolder('a\\b')).toBe('a/b');
  });

  it('`./` 相对当前白板所在目录（"当前文件"就是当前白板）', () => {
    expect(resolveAttachmentFolder('./', 'Boards/Sub')).toBe('Boards/Sub');
    expect(resolveAttachmentFolder('./img', 'Boards/Sub')).toBe('Boards/Sub/img');
  });

  it('相对目录没有基准（白板在根目录）时退化为库根下的相对路径', () => {
    expect(resolveAttachmentFolder('./img', '')).toBe('img');
    expect(resolveAttachmentFolder('./', '')).toBe('');
  });

  it('拿不到设置（非字符串）时退到库根目录，绝不抛错', () => {
    expect(resolveAttachmentFolder(undefined)).toBe('');
    expect(resolveAttachmentFolder(null)).toBe('');
    expect(resolveAttachmentFolder(42)).toBe('');
  });
});

describe('timestampPrefix', () => {
  it('本地时间格式化为 YYYYMMDD-HHmmss（文件名里不能用冒号）', () => {
    expect(timestampPrefix(NOW)).toBe(STAMP);
  });

  it('月/日/时/分/秒都补齐两位', () => {
    expect(timestampPrefix(new Date(2026, 0, 2, 3, 4, 5))).toBe('20260102-030405');
  });
});

describe('extensionForMime', () => {
  it('覆盖常见图片 mime', () => {
    expect(extensionForMime('image/png')).toBe('.png');
    expect(extensionForMime('image/jpeg')).toBe('.jpg');
    expect(extensionForMime('image/gif')).toBe('.gif');
    expect(extensionForMime('image/webp')).toBe('.webp');
    expect(extensionForMime('image/svg+xml')).toBe('.svg');
    expect(extensionForMime('image/bmp')).toBe('.bmp');
    expect(extensionForMime('image/avif')).toBe('.avif');
  });

  it('大小写不敏感，且忽略参数段', () => {
    expect(extensionForMime('IMAGE/PNG')).toBe('.png');
    expect(extensionForMime('image/png; charset=binary')).toBe('.png');
  });

  it('未知 / 空 mime 返回 null（由调用方决定回退）', () => {
    expect(extensionForMime('text/plain')).toBeNull();
    expect(extensionForMime('image/*')).toBeNull();
    expect(extensionForMime('')).toBeNull();
  });
});

describe('AttachmentManager · importData', () => {
  it('先建目录再写盘：写入配置的附件目录并返回路径', async () => {
    const sink = new FakeSink();
    const manager = new AttachmentManager(sink, configOf({ folder: 'attachments' }));
    const data = bufferOf(1, 2, 3);

    const path = await manager.importData(data, 'photo.png', { now: NOW, timestamp: false });

    expect(path).toBe('attachments/photo.png');
    expect(sink.ensureCalls).toEqual(['attachments']);
    expect(sink.files.has('attachments/photo.png')).toBe(true);
    expect(sink.writes).toEqual(['attachments/photo.png']);
  });

  it('默认加时间戳前缀（避免同名 image.png 互相覆盖）', async () => {
    const sink = new FakeSink();
    const manager = new AttachmentManager(sink, configOf({ folder: 'attachments' }));

    const path = await manager.importData(bufferOf(1), 'photo.png', { now: NOW });

    expect(path).toBe(`attachments/${STAMP}-photo.png`);
  });

  it('★ 原始名带系统路径时只取最后一段（不写出带分隔符的怪名字）', async () => {
    const sink = new FakeSink();
    const manager = new AttachmentManager(sink, configOf());

    const win = await manager.importData(bufferOf(1), String.raw`C:\Users\x\图.png`, {
      now: NOW,
      timestamp: false,
    });
    const unix = await manager.importData(bufferOf(2), '/tmp/a/图.png', {
      now: NOW,
      timestamp: false,
    });

    expect(win).toBe('图.png');
    expect(unix).toBe('图 2.png');
  });

  it('非法字符换成空格后仍可区分（a:b*c → a b c）', async () => {
    const sink = new FakeSink();
    const manager = new AttachmentManager(sink, configOf());

    const path = await manager.importData(bufferOf(1), 'a:b*c.png', { now: NOW, timestamp: false });

    expect(path).toBe('a b c.png');
  });

  it('原文件名为空时用 fallbackBase；未提供时退化为 未命名', async () => {
    const sink = new FakeSink();
    const manager = new AttachmentManager(sink, configOf());

    const withFallback = await manager.importData(bufferOf(1), '', {
      now: NOW,
      timestamp: false,
      fallbackBase: '粘贴图片',
    });
    const withoutFallback = await manager.importData(bufferOf(2), '', {
      now: NOW,
      timestamp: false,
    });

    expect(withFallback).toBe('粘贴图片');
    expect(withoutFallback).toBe('未命名');
  });

  it('同名文件已存在时顺延为 名字 2 / 名字 3…', async () => {
    const sink = new FakeSink();
    sink.seed('att/a.png');
    const manager = new AttachmentManager(sink, configOf({ folder: 'att' }));

    const path = await manager.importData(bufferOf(1), 'a.png', { now: NOW, timestamp: false });

    expect(path).toBe('att/a 2.png');
  });

  it('dedupe 关闭时，相同内容也各存一份', async () => {
    const sink = new FakeSink();
    const manager = new AttachmentManager(sink, configOf({ folder: 'att', dedupe: false }));

    const first = await manager.importData(bufferOf(1, 2, 3), 'a.png', {
      now: NOW,
      timestamp: false,
    });
    const second = await manager.importData(bufferOf(1, 2, 3), 'b.png', {
      now: NOW,
      timestamp: false,
    });

    expect(first).toBe('att/a.png');
    expect(second).toBe('att/b.png');
    expect(sink.writes).toHaveLength(2);
  });

  it('dedupe 开启时命中已写入路径，且不再写盘', async () => {
    const sink = new FakeSink();
    const manager = new AttachmentManager(sink, configOf({ folder: 'att', dedupe: true }));

    const first = await manager.importData(bufferOf(9, 8, 7), 'a.png', {
      now: NOW,
      timestamp: false,
    });
    const second = await manager.importData(bufferOf(9, 8, 7), '完全不同的名字.png', {
      now: NOW,
      timestamp: false,
    });

    expect(first).toBe('att/a.png');
    expect(second).toBe('att/a.png');
    expect(sink.writes).toEqual(['att/a.png']);
  });

  it('dedupe 按内容区分：不同字节仍各存一份', async () => {
    const sink = new FakeSink();
    const manager = new AttachmentManager(sink, configOf({ folder: 'att', dedupe: true }));

    const first = await manager.importData(bufferOf(1, 2, 3), 'a.png', {
      now: NOW,
      timestamp: false,
    });
    const second = await manager.importData(bufferOf(1, 2, 4), 'a.png', {
      now: NOW,
      timestamp: false,
    });

    expect(first).toBe('att/a.png');
    expect(second).toBe('att/a 2.png');
    expect(sink.writes).toHaveLength(2);
  });
});

describe('AttachmentManager · savePastedImage', () => {
  it('按 粘贴图片-<时间戳>.<ext> 命名', async () => {
    const sink = new FakeSink();
    const manager = new AttachmentManager(sink, configOf({ folder: 'att' }));

    const path = await manager.savePastedImage(bufferOf(1), 'image/jpeg', { now: NOW });

    expect(path).toBe(`att/粘贴图片-${STAMP}.jpg`);
  });

  it('mime 无法识别（含空串）时回退 .png', async () => {
    const sink = new FakeSink();
    const manager = new AttachmentManager(sink, configOf({ folder: 'att' }));

    const empty = await manager.savePastedImage(bufferOf(1), '', { now: NOW });
    const wildcard = await manager.savePastedImage(bufferOf(2), 'image/*', { now: NOW });

    expect(empty).toBe(`att/粘贴图片-${STAMP}.png`);
    expect(wildcard).toBe(`att/粘贴图片-${STAMP} 2.png`);
  });

  it('关闭时间戳时命名为 粘贴图片.<ext>', async () => {
    const sink = new FakeSink();
    const manager = new AttachmentManager(sink, configOf({ folder: 'att' }));

    const path = await manager.savePastedImage(bufferOf(1), 'image/webp', {
      now: NOW,
      timestamp: false,
    });

    expect(path).toBe('att/粘贴图片.webp');
  });
});

describe('contentHash · SHA-256 内容哈希（T6.05 / F2-3-10）', () => {
  it('返回 64 位小写十六进制（SHA-256 的固定长度）', async () => {
    expect(await contentHash(bufferOf(1, 2, 3))).toMatch(/^[0-9a-f]{64}$/);
  });

  it('确定性：同一份内容永远是同一个哈希', async () => {
    expect(await contentHash(bufferOf(4, 5, 6))).toBe(await contentHash(bufferOf(4, 5, 6)));
  });

  it('空输入对上公版向量（只跟自己算的值比是自证，对向量才验得出实现）', async () => {
    expect(await contentHash(bufferOf())).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('`abc` 也对上公版向量', async () => {
    expect(await contentHash(bufferOf(0x61, 0x62, 0x63))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('题面那句 448 位向量的头 64 位也对得上（覆盖跨块读取）', async () => {
    const text = 'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq';
    const bytes = Array.from(text).map((char) => char.charCodeAt(0));
    expect(await contentHash(bufferOf(...bytes))).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });

  it('宿主没有 SubtleCrypto 时返回 null（退成"不去重"），而不是抛错', async () => {
    vi.stubGlobal('crypto', {});
    try {
      expect(await contentHash(bufferOf(1, 2, 3))).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('去重不误并（T6.05 回归）', () => {
  /** 80 个相同字节（> 旧指纹的 64 字节窗口） */
  function head(): number[] {
    return Array.from({ length: 80 }, () => 7);
  }

  it('长度相同、前 64 字节相同、只有尾部不同的两张图**不**合并', async () => {
    const sink = new FakeSink();
    const manager = new AttachmentManager(sink, configOf({ folder: 'att', dedupe: true }));

    // ★ 这正是被换掉的旧实现（字节数 + 前 64 字节）会误判成"同一张"的一对：
    //   两张不同的图都撞在 64 字节的窗口之外，后者会被静默丢弃、卡片从此指向别人的图。
    const first = bufferOf(...head(), 0);
    const second = bufferOf(...head(), 255);

    const a = await manager.importData(first, 'a.png', { now: NOW });
    const b = await manager.importData(second, 'b.png', { now: NOW });

    expect(a).not.toBe(b);
    expect(sink.writes).toHaveLength(2);
  });

  it('真·相同内容（哪怕文件名不同）仍然合并到同一份', async () => {
    const sink = new FakeSink();
    const manager = new AttachmentManager(sink, configOf({ folder: 'att', dedupe: true }));

    const a = await manager.importData(bufferOf(1, 2, 3, 4), 'a.png', {
      now: NOW,
      timestamp: false,
    });
    const b = await manager.importData(bufferOf(1, 2, 3, 4), 'b.png', {
      now: NOW,
      timestamp: false,
    });

    expect(a).toBe('att/a.png');
    expect(b).toBe('att/a.png');
    expect(sink.writes).toEqual(['att/a.png']);
  });
});
