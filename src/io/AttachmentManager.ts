/**
 * 附件导入（T1.49）—— 对应需求 `F9-01`（导入附件）与 `F9-03`（相同内容去重）。
 *
 * 职责：把一段二进制内容按"附件目录 + 不冲突文件名"落进 Vault，返回写入路径。
 * 命名规则、同名顺延复用 `util/fileName.ts`，与笔记提升（`NotePromoter`）保持一套规则。
 *
 * ★ 不 import `obsidian`：通过窄接口 `AttachmentSink` 访问外部世界，
 *   生产实现（`vault.createBinary` / `vault.adapter`）由 `integration/` 提供。
 *   这样本模块可以在 Node（vitest）下用内存替身完整单测，而不会触发
 *   "`obsidian` 包没有 JS 入口" 的加载失败。
 */

import { sanitizeFileName, splitName, uniquePath } from '../util/fileName';

/** 附件写入端口；生产实现放在 `src/integration/` 里（`vault.adapter` / `vault.createBinary`） */
export interface AttachmentSink {
  exists(path: string): Promise<boolean>;
  /** 递归建目录；目录已存在时**不得**抛错 */
  ensureFolder(folder: string): Promise<void>;
  writeBinary(path: string, data: ArrayBuffer): Promise<void>;
}

/** 附件设置（对应 Obsidian 的附件目录设置项） */
export interface AttachmentConfig {
  /** 附件目录，vault 相对路径；`''` = Vault 根目录 */
  folder: string;
  /** 去重：相同内容只存一份（`F9-03`）。默认 `false` —— 见下面 `importData` 的注释 */
  dedupe: boolean;
}

export const DEFAULT_ATTACHMENT_CONFIG: AttachmentConfig = { folder: '', dedupe: false };

/**
 * Obsidian「附件默认位置」设置值 → 附件目录（vault 相对路径；`''` = 库根目录）。
 *
 * 这项设置（`app.vault.getConfig('attachmentFolderPath')`）有三种形态：
 *   * `''` / `'/'`       → 库根目录
 *   * `'./'` / `'./sub'` → **相对当前笔记所在目录**
 *     （在本插件里"当前笔记"就是当前白板 —— 拖进哪块板就落在它旁边，符合直觉）
 *   * `'attachments'`    → 库内固定目录
 *
 * ★ 必须跟随它而不是一律丢根目录：附件目录是用户在 Obsidian 里统一配置过的偏好，
 *   绕过它意味着用户会在几周后发现库根被几十张拖进来的图淹掉。
 */
export function resolveAttachmentFolder(raw: unknown, baseFolder = ''): string {
  if (typeof raw !== 'string') return '';
  const value = raw.trim().replace(/\\/g, '/');
  if (value.length === 0 || value === '/') return '';

  const trimSlashes = (input: string): string => input.replace(/^\/+|\/+$/g, '');
  const base = trimSlashes(baseFolder);

  // `./xxx`：相对当前白板所在目录
  if (value.startsWith('./')) {
    const relative = trimSlashes(value.slice(2));
    if (relative.length === 0) return base;
    return base.length === 0 ? relative : `${base}/${relative}`;
  }

  return trimSlashes(value);
}

/** `2026-09-11 15:30:12` → `'20260911-153012'`（本地时间，文件名里不能用 `:`） */
export function timestampPrefix(when: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  // ★ 用本地时间而非 UTC：用户看到的"刚粘贴的图"应该按自己所在时区的日期命名，
  //   否则跨零点 / 跨时区时会得到一个"昨天"或"明天"的文件名，和用户的直觉对不上。
  const date = `${when.getFullYear()}${pad(when.getMonth() + 1)}${pad(when.getDate())}`;
  const time = `${pad(when.getHours())}${pad(when.getMinutes())}${pad(when.getSeconds())}`;
  return `${date}-${time}`;
}

/** mime → 扩展名（含 `.`）。至少覆盖 png/jpeg/gif/webp/svg/bmp/avif */
const MIME_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'image/bmp': '.bmp',
  'image/avif': '.avif',
};

/** mime → 扩展名（含 `.`）；未知 mime 返回 `null`。至少覆盖 png/jpeg/gif/webp/svg/bmp/avif */
export function extensionForMime(mime: string): string | null {
  // ★ 先砍掉参数段（`image/png; charset=binary`）再查表：剪贴板 / 拖拽给出的 mime 常带参数，
  //   不处理就会稳定落进"未知 mime"分支，白白丢掉扩展名。
  const bare = mime.split(';', 1)[0].trim().toLowerCase();
  return MIME_EXT[bare] ?? null;
}

export interface ImportOptions {
  /** 命名用的时间戳，默认 `new Date()`。注入是为了单测可确定 */
  now?: Date;
  /**
   * 是否加时间戳前缀，默认 `true`。
   * ★ 默认加：来自系统/剪贴板的文件经常同名叫 `image.png`，
   *   不加前缀会在附件目录里互相覆盖（用户丢文件比多几个字符严重得多）。
   */
  timestamp?: boolean;
}

/** 取系统路径的最后一段：`C:\Users\x\图.png` / `/tmp/a/图.png` → `图.png` */
function leafName(path: string): string {
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return slash === -1 ? path : path.slice(slash + 1);
}

/**
 * 内容哈希（T6.05 / `F2-3-10` / `F9-03`）：SHA-256，走宿主的 SubtleCrypto。
 *
 * ★ **为什么换成真哈希**：旧实现是"字节数 + 前 64 字节"的廉价指纹，当初的理由是
 *   "误判的代价只是少存一份" —— 那是**错的**。两张不同的图只要长度相同、开头
 *   64 字节相同（同一个工具导出的图极常见：同样的 PNG 魔数、同样的尺寸元数据），
 *   后一张就会被**静默丢弃**，而那张卡从此指向别人的图。去重的前提是
 *   "相同即相同、不同即不同"，所以这里用加密哈希。
 * ★ **为什么是 SHA-256**：SubtleCrypto 不提供 MD5 / CRC，而 `SHA-256` 恰恰是
 *   它最短的那条信任路径 —— 不引入任何第三方实现（`03 §7.2` 零运行时依赖）。
 * ★ **拿不到 SubtleCrypto 时返回 `null`（= 这次不去重），不抛错**：导入附件是
 *   用户的主操作，绝不能因为"算不出哈希"而失败；退成"各存一份"是唯一可接受的
 *   降级 —— 宁可多存一份，不可错并一张。
 */
export async function contentHash(data: ArrayBuffer): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  try {
    const digest = await subtle.digest('SHA-256', data);
    return hexOf(new Uint8Array(digest));
  } catch {
    // 极少数宿主会拒绝对某些 buffer 求摘要（已分离 / 跨源）—— 同样退成"不去重"
    return null;
  }
}

/** 字节 → 小写十六进制（长度固定、可比较、可直接当 Map 键） */
function hexOf(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

export class AttachmentManager {
  /**
   * ★ 去重索引只活在实例内存里：跨会话（重开 Obsidian）重复导入仍会各存一份。
   *   真正的跨会话去重要把内容哈希写进落盘索引，那属于后续范围，这里不做 ——
   *   但即使这样，"同一次会话里同一张图拖三次"也已经只存一份。
   * ★ 键是 {@link contentHash} 的结果（SHA-256 十六进制），值是**已写入的路径**：
   *   命中时直接把它还给调用方，省掉一次建目录 + 一次写盘。
   */
  private readonly dedupeIndex = new Map<string, string>();

  constructor(
    private readonly sink: AttachmentSink,
    private readonly config: () => AttachmentConfig,
  ) {}

  /**
   * 导入一段二进制内容，返回写入后的 vault 相对路径。
   * @param originalName 原始文件名（可为空串 —— 此时用 `fallbackBase`）
   * @param fallbackBase 原始文件名为空时的基名，例如 `'粘贴图片'`
   */
  async importData(
    data: ArrayBuffer,
    originalName: string,
    options: ImportOptions & { fallbackBase?: string } = {},
  ): Promise<string> {
    // ★ 先取最后一段再净化：原始名常带系统目录（`C:\Users\x\图.png`），
    //   直接净化会把目录分隔符也换成空格，写出 `C Users x 图.png` 这种怪文件名。
    const leaf = leafName(originalName);
    const { base, ext } = splitName(leaf);
    const safeBase = sanitizeFileName(base, options.fallbackBase ?? '未命名');
    const now = options.now ?? new Date();
    const name = options.timestamp === false ? safeBase : `${timestampPrefix(now)}-${safeBase}`;
    return this.store(data, name, ext);
  }

  /**
   * 从系统文件管理器拖入的文件 → 落库（T1.65）。
   *
   * ★ 走标准的 `file.arrayBuffer()`，**不用** Electron 的 `file.path` 直读磁盘：
   *   `path` 是 Electron 的非标准扩展（新版已改为 `webUtils.getPathForFile`），
   *   而 `arrayBuffer()` 是标准 API，桌面端 / 移动端都能用。为了省一次内存拷贝
   *   去押注一个正在消失的私有字段，不值 —— 拖拽本来就是低频动作。
   */
  async importSystemFile(file: File, options: ImportOptions = {}): Promise<string> {
    const data = await file.arrayBuffer();
    // `options` 把用户的"附件命名"设置（F11-06）透传下去；展开放在后面，
    // 使调用方给的 `timestamp` 覆盖这里的兜底，而 `importData` 自己的默认值仍然生效
    return this.importData(data, file.name, { fallbackBase: '拖入文件', ...options });
  }

  /** 粘贴图片的便捷版：按 `粘贴图片-<时间戳>.<ext>` 命名 */
  async savePastedImage(
    data: ArrayBuffer,
    mime: string,
    options: ImportOptions = {},
  ): Promise<string> {
    // ★ mime 识别失败回退 `.png`：剪贴板最常见的失败是空 mime / `image/*`，
    //   而 png 是各平台 100% 能解码的图片格式，回退它不会写出"打不开"的文件。
    const ext = extensionForMime(mime) ?? '.png';
    const now = options.now ?? new Date();
    const name = options.timestamp === false ? '粘贴图片' : `粘贴图片-${timestampPrefix(now)}`;
    return this.store(data, name, ext);
  }

  /** 写入前的公共流程：去重 → 建目录 → 顺延不冲突路径 → 写盘 */
  private async store(data: ArrayBuffer, base: string, ext: string): Promise<string> {
    const config = this.config();

    // `null` = 这次不去重（开关关着，或宿主没有 SubtleCrypto）—— 两条路都不抛错
    const hash = config.dedupe ? await contentHash(data) : null;
    if (hash !== null) {
      const existing = this.dedupeIndex.get(hash);
      // 命中直接返回已有路径、不再写盘 —— 这是去重唯一有意义的行为
      if (existing !== undefined) return existing;
    }

    await this.sink.ensureFolder(config.folder);
    const target = await uniquePath(config.folder, base, ext, (path) => this.sink.exists(path));
    await this.sink.writeBinary(target, data);

    if (hash !== null) this.dedupeIndex.set(hash, target);
    return target;
  }
}
