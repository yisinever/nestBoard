/**
 * 最小 ZIP 读取器（`.xmind` 导入用，用户 2026-09-28）。
 *
 * ── 为什么自己写 ────────────────────────────────────────────
 *
 * 插件里没有现成的解压（`export/toZip.ts` 只写不读，而且是 store 不压缩），
 * 而 `.xmind` 就是一个 ZIP：为了一个导入功能背一个 zip 库进来不划算。
 * ZIP 的**中央目录**结构简单，配合浏览器/Electron 自带的 `DecompressionStream`
 * 就能解开 deflate —— 三十行读目录 + 三行解压。
 *
 * ★ 只支持两种压缩法：`0`（store）与 `8`（deflate）—— 那是 ZIP 世界里 99% 的现实，
 *   其余（bzip2 / lzma / 加密）**明确失败**，不猜。
 * ★ 不 import `obsidian`、不碰 DOM：收 `ArrayBuffer`、给一串 `{ path, content }`（UTF-8 文本）。
 * ★ 包内路径只用于**找文件**（`content.json`），绝不落盘 / 绝不按它写文件。
 */

/** 包内一个文本文件 */
export interface ZipEntry {
  path: string;
  content: string;
}

/** 只认这两个压缩法（见文件头） */
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

class ZipError extends Error {}

/** 从尾部找中央目录结束记录（EOCD），返回中央目录的偏移与条目数 */
function readEndOfCentralDirectory(view: DataView): { offset: number; count: number } {
  // EOCD 的注释长度最多 65535 ⇒ 从尾部往前最多扫这么多
  const maxBack = Math.min(view.byteLength, 0xffff + 22);
  for (let back = 22; back <= maxBack; back += 1) {
    const at = view.byteLength - back;
    if (view.getUint32(at, true) === 0x06054b50) {
      return {
        offset: view.getUint32(at + 16, true),
        count: view.getUint16(at + 10, true),
      };
    }
  }
  throw new ZipError('找不到 ZIP 中央目录（文件不是 zip 或被截断）');
}

/** deflate 解压（`DecompressionStream` 是浏览器 / Electron 自带的能力） */
async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * 解开一个 ZIP，给出**全部文本条目**（路径 + UTF-8 文本）。
 *
 * ★ 目录（以 `/` 结尾）跳过；二进制条目（图片等）也跳过 —— 导入只关心
 *   `content.json` / `metadata.json` 这类文本。
 */
export async function unzipTextEntries(buffer: ArrayBuffer): Promise<ZipEntry[]> {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const decoder = new TextDecoder('utf-8');
  const { offset, count } = readEndOfCentralDirectory(view);

  const entries: ZipEntry[] = [];
  let cursor = offset;
  for (let index = 0; index < count; index += 1) {
    if (view.getUint32(cursor, true) !== 0x02014b50) throw new ZipError('中央目录记录损坏');
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    cursor += 46 + nameLength + extraLength + commentLength;

    if (name.endsWith('/')) continue;
    // 本地头自身的名字 / 附加字段长度可能和中央目录不同 ⇒ 必须重新读一遍
    if (view.getUint32(localOffset, true) !== 0x04034b50) throw new ZipError('本地文件头损坏');
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataAt = localOffset + 30 + localNameLength + localExtraLength;
    const raw = bytes.subarray(dataAt, dataAt + compressedSize);

    if (method === METHOD_STORE) {
      entries.push({ path: name, content: decoder.decode(raw) });
      continue;
    }
    if (method !== METHOD_DEFLATE) continue;
    try {
      entries.push({ path: name, content: decoder.decode(await inflateRaw(raw)) });
    } catch {
      // 单条解不开不该让整个导入失败：剩下的条目里可能就有 content.json
      continue;
    }
  }
  return entries;
}
