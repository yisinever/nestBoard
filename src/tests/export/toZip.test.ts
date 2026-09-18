/**
 * 导出 ZIP（T6.02 / `F9-07`）单测。
 *
 * ZIP 这东西的特点是"写错了也能生成一个文件，只是**别人解不开**"——
 * 在我们的单测里它同样"看起来正常"，因为没有任何一步会报错。所以这里**不**只断言
 * "有几段字节"，而是**在测试里现写一个 ZIP 解析器**：走 EOCD → 中央目录 → 本地头，
 * 把条目原样读回来，再拿 `crc32` 校验一遍。
 *
 * ★ 这样做的价值：解析器是按 **ZIP 规范**写的，不是按我们的写入代码反向写的。
 *   写入侧漏一个字段长度、少加一个偏移，读回来时必然对不上位 —— 而"能按规范读回来"
 *   正是"别的解压工具也能打开"的等价说法。
 * ★ 额外还有一道人工验证：把产物喂给系统的 `unzip` / `python3 -m zipfile`（见落地记录）。
 */

import { describe, expect, it } from 'vitest';
import {
  ZipExporter,
  buildZip,
  crc32,
  dosTimestamp,
  planZipExport,
  zipFileName,
} from '../../export/toZip';
import type { ZipEntry } from '../../export/toZip';
import { createBoardFile, createCard } from '../../model/factories';
import { MemoryVaultIO } from '../helpers/memoryVault';

// ─────────────────────────────────────────────────────────────
// 测试用的 ZIP 解析器（按规范写，不按被测代码反向写）
// ─────────────────────────────────────────────────────────────

interface ReadEntry {
  path: string;
  data: Uint8Array;
  crc: number;
  method: number;
  flags: number;
}

function utf8Bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function readZip(buffer: ArrayBuffer): ReadEntry[] {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  // EOCD 落在最后 22 字节（本实现不写归档注释）
  const eocd = buffer.byteLength - 22;
  expect(view.getUint32(eocd, true)).toBe(0x06054b50);

  const count = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  // 中央目录必须**正好**贴着 EOCD 结束 —— 差一个字节都说明尺寸算错了
  expect(centralOffset + centralSize).toBe(eocd);

  const entries: ReadEntry[] = [];
  let offset = centralOffset;

  for (let index = 0; index < count; index += 1) {
    expect(view.getUint32(offset, true)).toBe(0x02014b50);
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const crc = view.getUint32(offset + 16, true);
    const size = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const path = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));

    expect(view.getUint32(localOffset, true)).toBe(0x04034b50);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;

    entries.push({
      path,
      data: bytes.subarray(dataStart, dataStart + size),
      crc,
      method,
      flags,
    });

    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

function bytesOf(...values: number[]): ArrayBuffer {
  return new Uint8Array(values).buffer;
}

const NOW = new Date(2026, 8, 12, 14, 30, 0);

// ─────────────────────────────────────────────────────────────
// CRC-32
// ─────────────────────────────────────────────────────────────

describe('crc32', () => {
  // 三个公开的校验向量：自己实现 CRC 最容易在多项式/初始值/取反这三处写歪，
  // 只跟"自己算的值"比是发现不了的 —— 必须跟外部已知值比。
  it('空输入为 0', () => {
    expect(crc32(new Uint8Array())).toBe(0);
  });

  it('"123456789" = 0xCBF43926', () => {
    expect(crc32(utf8Bytes('123456789'))).toBe(0xcbf43926);
  });

  it('"The quick brown fox jumps over the lazy dog" = 0x414FA339', () => {
    expect(crc32(utf8Bytes('The quick brown fox jumps over the lazy dog'))).toBe(0x414fa339);
  });

  it('中文按 UTF-8 字节算（与写进归档的字节一致）', () => {
    expect(crc32(utf8Bytes('白板'))).toBe(crc32(utf8Bytes('白板')));
    expect(crc32(utf8Bytes('白板'))).not.toBe(crc32(utf8Bytes('白板 ')));
  });
});

describe('dosTimestamp', () => {
  it('按 DOS 的位布局打包（时/分/秒除二、年从 1980 起）', () => {
    // 14:30:00 → (14 << 11) | (30 << 5) | 0
    expect(dosTimestamp(new Date(2026, 8, 12, 14, 30, 0)).time).toBe((14 << 11) | (30 << 5));
    // 2026-09-12 → (46 << 9) | (9 << 5) | 12
    expect(dosTimestamp(new Date(2026, 8, 12, 14, 30, 0)).date).toBe((46 << 9) | (9 << 5) | 12);
  });

  it('早于 1980 的年份被夹回 1980（否则年字段会变成负数，写进 uint16 就是一团乱码）', () => {
    // 1970-01-01 → 夹回 1980-01-01：年偏移 0，月 1，日 1
    expect(dosTimestamp(new Date(1970, 0, 1, 0, 0, 0)).date).toBe((1 << 5) | 1);
  });
});

// ─────────────────────────────────────────────────────────────
// 打包
// ─────────────────────────────────────────────────────────────

describe('buildZip', () => {
  it('空归档也是合法的（22 字节，只有 EOCD）', () => {
    expect(buildZip([], NOW).byteLength).toBe(22);
    expect(readZip(buildZip([], NOW))).toEqual([]);
  });

  it('一个条目能原样读回来', () => {
    const entries = readZip(buildZip([{ path: 'a.txt', data: bytesOf(1, 2, 3) }], NOW));
    expect(entries).toHaveLength(1);
    expect(entries[0]?.path).toBe('a.txt');
    expect([...(entries[0]?.data ?? [])]).toEqual([1, 2, 3]);
  });

  it('多个条目顺序与入参一致（中央目录逐个指向正确的本地头）', () => {
    const zip = buildZip(
      [
        { path: 'b.txt', data: bytesOf(2) },
        { path: 'a.txt', data: bytesOf(1) },
        { path: 'dir/c.txt', data: bytesOf(3) },
      ],
      NOW,
    );
    expect(readZip(zip).map((entry) => entry.path)).toEqual(['b.txt', 'a.txt', 'dir/c.txt']);
  });

  it('每个条目的 CRC 与按规范算出来的一致（解压工具就是靠它对账的）', () => {
    const payload = utf8Bytes('一段中文内容');
    const [entry] = readZip(
      buildZip([{ path: 'x.txt', data: payload.buffer as ArrayBuffer }], NOW),
    );
    expect(entry?.crc).toBe(crc32(payload));
  });

  it('一律 store：方法号为 0，压缩后大小等于原大小', () => {
    const entries = readZip(buildZip([{ path: 'x', data: bytesOf(9, 9, 9) }], NOW));
    expect(entries[0]?.method).toBe(0);
  });

  it('写上了 UTF-8 文件名标志位（否则 Windows 解压出乱码文件名）', () => {
    const entries = readZip(buildZip([{ path: '附件/图.png', data: bytesOf(1) }], NOW));
    expect((entries[0]?.flags ?? 0) & 0x0800).toBe(0x0800);
  });

  it('中文路径能原样读回来', () => {
    const entries = readZip(buildZip([{ path: '素材/一张图.png', data: bytesOf(7) }], NOW));
    expect(entries[0]?.path).toBe('素材/一张图.png');
  });

  it('零字节条目也能读回来（空附件不该让中央目录错位）', () => {
    const entries = readZip(
      buildZip(
        [
          { path: 'empty.bin', data: new ArrayBuffer(0) },
          { path: 'after.txt', data: bytesOf(5) },
        ],
        NOW,
      ),
    );
    expect(entries.map((entry) => entry.data.length)).toEqual([0, 1]);
    expect(entries[1]?.path).toBe('after.txt');
  });

  it('大一点的二进制内容不走样', () => {
    const big = new Uint8Array(70_000).map((_, index) => index % 251);
    const [entry] = readZip(buildZip([{ path: 'pic.bin', data: big.buffer as ArrayBuffer }], NOW));
    expect(entry?.data.length).toBe(big.length);
    expect(entry?.data[500]).toBe(big[500]);
    expect(entry?.crc).toBe(crc32(big));
  });

  it('同一份输入两次打包得到同样的字节（时间戳由调用方注入，不是"现在"）', () => {
    const entries: ZipEntry[] = [{ path: 'a', data: bytesOf(1, 2) }];
    const first = new Uint8Array(buildZip(entries, NOW));
    const second = new Uint8Array(buildZip(entries, NOW));
    expect(first).toEqual(second);
  });
});

// ─────────────────────────────────────────────────────────────
// 打包计划
// ─────────────────────────────────────────────────────────────

describe('planZipExport', () => {
  it('板子还没加载出来（null）时给空计划', () => {
    expect(planZipExport(null, () => true)).toEqual({ attachments: [], missing: [] });
  });

  it('只收图片卡与文件卡', () => {
    const board = createBoardFile({
      cards: [
        createCard('image', { id: 'i', content: { path: 'assets/a.png' } }),
        createCard('file', { id: 'f', content: { path: 'docs/spec.pdf' } }),
        createCard('note', {
          id: 'n',
          content: { md: 'x' },
        }),
        createCard('noteRef', {
          id: 'r',
          content: { path: 'Notes/别的笔记.md' },
        }),
        createCard('boardRef', {
          id: 'b',
          content: { path: 'Boards/子板.nboard' },
        }),
        createCard('link', {
          id: 'l',
          content: { url: 'https://example.com' },
        }),
      ],
    });
    const plan = planZipExport(board, () => true);
    expect(plan.attachments).toEqual(['assets/a.png', 'docs/spec.pdf']);
  });

  it('同一张图被两张卡引用只打一份（否则包里是两份同样的字节）', () => {
    const board = createBoardFile({
      cards: [
        createCard('image', { id: 'a', content: { path: 'assets/same.png' } }),
        createCard('image', { id: 'b', content: { path: 'assets/same.png' } }),
      ],
    });
    expect(planZipExport(board, () => true).attachments).toEqual(['assets/same.png']);
  });

  it('库里没有的附件进 missing，而不是被静默丢掉', () => {
    const board = createBoardFile({
      cards: [
        createCard('image', { id: 'a', content: { path: 'assets/gone.png' } }),
        createCard('image', { id: 'b', content: { path: 'assets/here.png' } }),
      ],
    });
    const plan = planZipExport(board, (path) => path === 'assets/here.png');
    expect(plan.attachments).toEqual(['assets/here.png']);
    expect(plan.missing).toEqual(['assets/gone.png']);
  });

  it('还没选文件的空路径不算附件（刚建好的图片卡不该进 missing）', () => {
    const board = createBoardFile({
      cards: [createCard('image', { content: { path: '' } })],
    });
    expect(planZipExport(board, () => true)).toEqual({ attachments: [], missing: [] });
  });

  it('保持卡片顺序（包里条目的顺序可预期）', () => {
    const board = createBoardFile({
      cards: [
        createCard('image', { id: 'a', z: 3, content: { path: 'c.png' } }),
        createCard('image', { id: 'b', z: 1, content: { path: 'a.png' } }),
        createCard('file', { id: 'c', z: 2, content: { path: 'b.pdf' } }),
      ],
    });
    // 按 `board.cards`（数组顺序）而不是 z 排序 —— 这只是"可预期"，不是"按层"
    expect(planZipExport(board, () => true).attachments).toEqual(['c.png', 'a.png', 'b.pdf']);
  });
});

// ─────────────────────────────────────────────────────────────
// 落盘
// ─────────────────────────────────────────────────────────────

describe('zipFileName', () => {
  it('单文件命名', () => {
    expect(zipFileName('白板')).toBe('白板.zip');
  });
});

describe('ZipExporter', () => {
  function sinkWith(paths: Record<string, number[]>): MemoryVaultIO {
    const vault = new MemoryVaultIO();
    for (const [path, values] of Object.entries(paths)) {
      vault.binaries.set(path, new Uint8Array(values).buffer);
    }
    return vault;
  }

  it('把 .nboard 与附件一起写进归档', async () => {
    const vault = sinkWith({ 'assets/a.png': [1, 2, 3] });
    const result = await new ZipExporter(vault).export(
      {
        boardPath: 'Boards/白板.nboard',
        boardText: '{"meta":{}}',
        plan: { attachments: ['assets/a.png'], missing: [] },
        target: { folder: 'Boards', name: '白板' },
      },
      NOW,
    );

    expect(result.path).toBe('Boards/白板.zip');
    expect(result.packed).toBe(1);
    expect(result.skipped).toEqual([]);

    const entries = readZip(vault.binaries.get(result.path) as ArrayBuffer);
    expect(entries.map((entry) => entry.path)).toEqual(['Boards/白板.nboard', 'assets/a.png']);
    expect(new TextDecoder().decode(entries[0]?.data)).toBe('{"meta":{}}');
    expect([...(entries[1]?.data ?? [])]).toEqual([1, 2, 3]);
  });

  it('板子路径保留在归档里（解压回库根即可复原）', async () => {
    const vault = new MemoryVaultIO();
    const result = await new ZipExporter(vault).export(
      {
        boardPath: 'Deep/嵌套/板.nboard',
        boardText: '{}',
        plan: { attachments: [], missing: [] },
        target: { folder: '', name: '板' },
      },
      NOW,
    );
    const entries = readZip(vault.binaries.get(result.path) as ArrayBuffer);
    expect(entries[0]?.path).toBe('Deep/嵌套/板.nboard');
  });

  it('读不出来的附件被跳过并记录下来，整包仍然产出', async () => {
    // `exists` 说在、真读又没了：模拟"边导边删"
    const vault = sinkWith({ 'assets/ok.png': [1] });
    const result = await new ZipExporter(vault).export(
      {
        boardPath: 'Boards/板.nboard',
        boardText: '{}',
        plan: { attachments: ['assets/ok.png', 'assets/vanished.png'], missing: [] },
        target: { folder: 'Boards', name: '板' },
      },
      NOW,
    );

    expect(result.packed).toBe(1);
    expect(result.skipped).toEqual(['assets/vanished.png']);
    const entries = readZip(vault.binaries.get(result.path) as ArrayBuffer);
    expect(entries).toHaveLength(2); // .nboard + 一个成功的附件
  });

  it('没有附件时也照常产出（只有 .nboard 的归档）', async () => {
    const vault = new MemoryVaultIO();
    const result = await new ZipExporter(vault).export(
      {
        boardPath: 'Boards/板.nboard',
        boardText: '{}',
        plan: { attachments: [], missing: [] },
        target: { folder: '', name: '板' },
      },
      NOW,
    );
    expect(result.packed).toBe(0);
    expect(readZip(vault.binaries.get(result.path) as ArrayBuffer)).toHaveLength(1);
  });

  it('重名时顺延编号，绝不覆盖已有的 zip', async () => {
    const vault = new MemoryVaultIO();
    vault.binaries.set('Boards/板.zip', new ArrayBuffer(3));
    const result = await new ZipExporter(vault).export(
      {
        boardPath: 'Boards/板.nboard',
        boardText: '{}',
        plan: { attachments: [], missing: [] },
        target: { folder: 'Boards', name: '板' },
      },
      NOW,
    );
    expect(result.path).toBe('Boards/板 2.zip');
    expect((vault.binaries.get('Boards/板.zip') as ArrayBuffer).byteLength).toBe(3);
  });
});
