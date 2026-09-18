/**
 * 导出 ZIP（T6.02 / `F9-07`）—— 把一块白板连同它的**附件**打成一个包。
 *
 * 解决的问题很具体：`.nboard` 是纯文本，自己就能拷走，但它引用的一堆图片 / 文件还在
 * 库里的各个角落。只发一个 `.nboard`，对方打开就是满屏断链。ZIP 把"这块板 + 它用到的东西"
 * 变成一个能直接发出去的对象。
 *
 * ★ **归档里保留 Vault 相对路径**（`assets/pic.png` 就叫 `assets/pic.png`，不压平到根）。
 *   于是对方**解压到自己的库根目录**就能直接打开那块板、图也全在 —— 这正是"迁移"想要的。
 *   压平到根虽然归档内部看着更整齐，却会在两个目录同名文件相遇时撞车（`a/pic.png`
 *   与 `b/pic.png` 只能活一个），而那是**静默的数据丢失**。
 *
 * ★ **不压缩（store）**。ZIP 允许每个条目选择压缩方法，这里一律用第 0 号"原样存储"：
 *   附件本来就以 PNG / JPEG 为主，那些字节已经被压过一轮，deflate 再压几乎不缩水；
 *   而自己实现一遍 deflate 是几百行容易写错、又需要大样本才能验干净的代码。
 *   `.nboard` 是文本、确实能压，但它在一整包里通常是最小的那一个 —— 由它来决定
 *   "要不要引入一个 deflate 实现"，不划算。**代价是包比理论值大**，这条写在摘要里。
 *
 * ★ **只打包附件卡（图片 / 文件）**，不打包引用的笔记（`noteRef`）与子白板（`boardRef`）：
 *   前者会把那个笔记的一整圈链接（连同它的图）一起拖进来，边界说不清；后者是个递归
 *   （子板还有子板），而且需要环检测 —— 两者都不是"打一个包"能回答的问题。
 *   引用本身留在 `.nboard` 里，对方解压后仍然是链接。
 */

import { collectRefs } from '../model/links';
import type { BoardFile } from '../model/schema';
import { textToArrayBuffer } from '../util/encoding';
import { uniqueExportPath } from './toPng';
import type { PngExportSink, PngExportTarget } from './toPng';

// ─────────────────────────────────────────────────────────────
// ZIP 编码（纯逻辑）
// ─────────────────────────────────────────────────────────────

/** 一个待写入的条目：`path` 是包内路径（也就是 Vault 相对路径） */
export interface ZipEntry {
  path: string;
  data: ArrayBuffer;
}

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

const LOCAL_HEADER_SIZE = 30;
const CENTRAL_HEADER_SIZE = 46;
const EOCD_SIZE = 22;

/** 压缩方法：0 = 原样存储（见文件头） */
const METHOD_STORE = 0;

/**
 * UTF-8 文件名标志位（bit 11）。
 *
 * ★ 不设它，解压工具会按本地代码页（GBK / CP437）去解中文名 —— 在 Windows 上
 *   就是一堆乱码文件名。中文白板是主要场景，这一位不能省。
 */
const FLAG_UTF8 = 0x0800;

/** ZIP 的时间戳从 1980 年起算，比这更早的日期会被夹回 1980-01-01 */
const DOS_EPOCH_YEAR = 1980;

const CRC_TABLE = buildCrcTable();

function buildCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}

/**
 * CRC-32（ZIP 每个条目头里都要写的校验值）。
 *
 * ★ 为什么自己算：`crypto.subtle` 只有 SHA 系列，`TextEncoder` 只管编码，
 *   Web 平台**没有** CRC-32 —— 而它是 ZIP 头里绕不过去的一个字段。
 * ★ 用查表法而不是逐位算：逐位法每字节 8 次分支，几百 KB 的附件就会明显卡顿。
 */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    crc = CRC_TABLE[(crc ^ (bytes[index] ?? 0)) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** `Date` → DOS 的 (time, date) 两个 16 位字段 */
export function dosTimestamp(date: Date): { time: number; date: number } {
  const year = Math.max(DOS_EPOCH_YEAR, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - DOS_EPOCH_YEAR) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/**
 * 打包成 ZIP 字节（store 模式，见文件头）。
 *
 * 结构是教科书式的三段：**每个条目的本地头 + 数据** → **中央目录**（每个条目一条）
 * → **EOCD**（指向中央目录）。先按公式算出总长再一次性分配 —— 于是写出来的
 * `ArrayBuffer` 恰好等于归档长度，不需要"先写再裁"。
 *
 * `now` 由调用方注入（头里有时间戳），这样单测能断言确定性的字节。
 */
export function buildZip(entries: readonly ZipEntry[], now: Date): ArrayBuffer {
  const prepared = entries.map((entry) => {
    const name = new TextEncoder().encode(entry.path);
    const data = new Uint8Array(entry.data);
    return { name, data, crc: crc32(data), offset: 0 };
  });

  const localSize = prepared.reduce(
    (sum, entry) => sum + LOCAL_HEADER_SIZE + entry.name.length + entry.data.length,
    0,
  );
  const centralSize = prepared.reduce(
    (sum, entry) => sum + CENTRAL_HEADER_SIZE + entry.name.length,
    0,
  );

  const buffer = new ArrayBuffer(localSize + centralSize + EOCD_SIZE);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const { time, date } = dosTimestamp(now);
  let offset = 0;

  for (const entry of prepared) {
    entry.offset = offset;
    view.setUint32(offset, SIG_LOCAL, true);
    offset += 4;
    view.setUint16(offset, 20, true); // 需要的版本 2.0
    offset += 2;
    view.setUint16(offset, FLAG_UTF8, true);
    offset += 2;
    view.setUint16(offset, METHOD_STORE, true);
    offset += 2;
    view.setUint16(offset, time, true);
    offset += 2;
    view.setUint16(offset, date, true);
    offset += 2;
    view.setUint32(offset, entry.crc, true);
    offset += 4;
    view.setUint32(offset, entry.data.length, true); // 压缩后大小 = 原大小（store）
    offset += 4;
    view.setUint32(offset, entry.data.length, true);
    offset += 4;
    view.setUint16(offset, entry.name.length, true);
    offset += 2;
    view.setUint16(offset, 0, true); // 扩展字段长度
    offset += 2;
    bytes.set(entry.name, offset);
    offset += entry.name.length;
    bytes.set(entry.data, offset);
    offset += entry.data.length;
  }

  const centralStart = offset;
  for (const entry of prepared) {
    view.setUint32(offset, SIG_CENTRAL, true);
    offset += 4;
    view.setUint16(offset, 20, true); // 产生者版本
    offset += 2;
    view.setUint16(offset, 20, true); // 需要的版本
    offset += 2;
    view.setUint16(offset, FLAG_UTF8, true);
    offset += 2;
    view.setUint16(offset, METHOD_STORE, true);
    offset += 2;
    view.setUint16(offset, time, true);
    offset += 2;
    view.setUint16(offset, date, true);
    offset += 2;
    view.setUint32(offset, entry.crc, true);
    offset += 4;
    view.setUint32(offset, entry.data.length, true);
    offset += 4;
    view.setUint32(offset, entry.data.length, true);
    offset += 4;
    view.setUint16(offset, entry.name.length, true);
    offset += 2;
    view.setUint16(offset, 0, true); // 扩展字段
    offset += 2;
    view.setUint16(offset, 0, true); // 注释
    offset += 2;
    view.setUint16(offset, 0, true); // 起始磁盘号
    offset += 2;
    view.setUint16(offset, 0, true); // 内部属性
    offset += 2;
    view.setUint32(offset, 0, true); // 外部属性
    offset += 4;
    view.setUint32(offset, entry.offset, true); // 本地头的偏移
    offset += 4;
    bytes.set(entry.name, offset);
    offset += entry.name.length;
  }

  view.setUint32(offset, SIG_EOCD, true);
  offset += 4;
  view.setUint16(offset, 0, true); // 本磁盘号
  offset += 2;
  view.setUint16(offset, 0, true); // 中央目录所在磁盘号
  offset += 2;
  view.setUint16(offset, prepared.length, true); // 本磁盘条目数
  offset += 2;
  view.setUint16(offset, prepared.length, true); // 总条目数
  offset += 2;
  view.setUint32(offset, centralSize, true);
  offset += 4;
  view.setUint32(offset, centralStart, true);
  offset += 4;
  view.setUint16(offset, 0, true); // 注释长度

  return buffer;
}

// ─────────────────────────────────────────────────────────────
// 打包计划（纯逻辑）
// ─────────────────────────────────────────────────────────────

export interface ZipPlan {
  /** 要读进来的附件（Vault 相对路径；已去重、保持卡片顺序） */
  attachments: string[];
  /** 板子里引用了、但库里已经没有的路径 —— 打包时跳过，但要在摘要里说出来 */
  missing: string[];
}

/**
 * 算出"这块板要打包哪些附件"。
 *
 * ★ `exists` 由调用方注入：`model/` 不许 import `obsidian`（`03 §7.2`），
 *   而"文件在不在"只有 Vault 知道。这与 `brokenRefsOf` 是同一条分工。
 * ★ 去重：同一张图出现在两张卡上是常态，不去重就会在包里写两份同样的字节。
 * ★ 缺失的**单独列出来**而不是静默丢弃：用户按下导出时以为附件都在，
 *   实际丢了几张 —— 那必须当场说，而不是等他解压后才数出来。
 */
export function planZipExport(board: BoardFile | null, exists: (path: string) => boolean): ZipPlan {
  if (!board) return { attachments: [], missing: [] };

  const attachments: string[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();

  for (const ref of collectRefs(board)) {
    // 只认附件（见文件头：笔记 / 子白板 / URL 都不进包）
    if (ref.kind !== 'image' && ref.kind !== 'file') continue;
    if (seen.has(ref.path)) continue;
    seen.add(ref.path);

    if (exists(ref.path)) attachments.push(ref.path);
    else missing.push(ref.path);
  }

  return { attachments, missing };
}

// ─────────────────────────────────────────────────────────────
// 落盘
// ─────────────────────────────────────────────────────────────

/**
 * ZIP 的落盘端口 = 导出的公共端口 + 读二进制。
 *
 * 用交叉类型而不是 `extends`：`PngExportSink` 是给另外两种导出共用的类型别名，
 * 这里只是**再加一个能力**，不想让它反向去影响 PNG / SVG 的形状。
 */
export type ZipExportSink = PngExportSink & {
  readBinary(path: string): Promise<ArrayBuffer>;
};

export interface ZipExportInput {
  /** 源 `.nboard` 的 Vault 路径（归档里也保留这条路径） */
  boardPath: string;
  /** 写进归档的板子正文（调用方给**内存里那一份**，理由见 `BoardView.exportZip`） */
  boardText: string;
  plan: ZipPlan;
  /** 归档自身的落点（目录 + 不含扩展名的名字） */
  target: PngExportTarget;
}

export interface ZipResult {
  /** 实际落盘路径（重名时已顺延编号） */
  path: string;
  /** 真正打进去的附件数（不含 `.nboard` 本身） */
  packed: number;
  /** 计划里有、读的时候却读不出来而被跳过的路径 */
  skipped: string[];
}

/** 单文件命名：`名字.zip` */
export function zipFileName(name: string): string {
  return `${name}.zip`;
}

export class ZipExporter {
  constructor(private readonly sink: ZipExportSink) {}

  async export(input: ZipExportInput, now: Date): Promise<ZipResult> {
    const entries: ZipEntry[] = [
      { path: input.boardPath, data: textToArrayBuffer(input.boardText) },
    ];
    const skipped: string[] = [];

    for (const path of input.plan.attachments) {
      try {
        entries.push({ path, data: await this.sink.readBinary(path) });
      } catch {
        // `exists` 说有、真读的时候又没了（用户边导边删，或路径大小写不一致）：
        // 跳过这一个，不因此让整包失败 —— 剩下的附件仍然值得交出去
        skipped.push(path);
      }
    }

    const prefix =
      input.target.folder.length > 0 ? `${input.target.folder.replace(/\/+$/, '')}/` : '';
    const path = await uniqueExportPath(this.sink, prefix, zipFileName(input.target.name));
    await this.sink.createBinary(path, buildZip(entries, now));

    return { path, packed: entries.length - 1, skipped };
  }
}
