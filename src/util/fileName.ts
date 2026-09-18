/**
 * 文件名处理工具（T1.49 附件导入的共享底座）。
 *
 * 为什么单独抽一个模块：`integration/NotePromoter.ts` 里已经有一份
 * "净化文件名 + 同名顺延" 的逻辑，附件导入要用**同一套规则**。
 * 复制一份必然漂移 —— 改了笔记名的截断长度却忘了改附件名，
 * 用户就会看到"导入的图片名和生成的笔记名不一样"这种无从解释的差异。
 *
 * 对应需求 `F9-01`（附件导入）与 `F9-03`（相同内容去重）：命名阶段都依赖这里的规则。
 *
 * ★ 纯函数、零 Obsidian 依赖：可直接在 Node 下单测。
 */

/**
 * 文件名里不能出现的字符（对齐 Obsidian / Windows / macOS 的并集）。
 *
 * `#` 与 `^` 在 Obsidian 里是链接语法的一部分，即使文件系统允许，
 * 留进文件名也会让 `[[...]]` 引用解析出意料之外的结果，因此一并视作非法。
 */
export const ILLEGAL_IN_NAME = /[\\/:*?"<>|#^[\]]/g;

/** `a/b/c.png` → `{ dir: 'a/b', base: 'c', ext: '.png' }`；无目录时 `dir` 为 `''`，无扩展名时 `ext` 为 `''` */
export function splitName(path: string): { dir: string; base: string; ext: string } {
  const slash = path.lastIndexOf('/');
  const dir = slash === -1 ? '' : path.slice(0, slash);
  const leaf = slash === -1 ? path : path.slice(slash + 1);

  const dot = leaf.lastIndexOf('.');
  // ★ 点必须在首位之后才算扩展名：`.gitignore` / `.png` 这类"点开头的文件"没有扩展名，
  //   否则会被切出一个空 base（`{ base: '', ext: '.gitignore' }`），拼名字时直接丢内容。
  if (dot <= 0) return { dir, base: leaf, ext: '' };
  return { dir, base: leaf.slice(0, dot), ext: leaf.slice(dot) };
}

/** 去除末尾多余的 `/`；`''` / `'/'` → `''` */
export function normalizeFolder(folder: string): string {
  return folder.replace(/\/+$/, '');
}

/** 拼路径：`('a/b', 'c.png')` → `'a/b/c.png'`；folder 为空 → `'c.png'` */
export function joinPath(folder: string, name: string): string {
  const dir = normalizeFolder(folder);
  return dir.length === 0 ? name : `${dir}/${name}`;
}

/**
 * 净化单个文件名（**不含目录**）：非法字符换成空格而不是删除。
 * ★ 换成空格的理由：`a/b` 删成 `ab` 会让两个不同标题撞成同一个文件名。
 * 连续空白压成一个空格并 trim；结果为空时返回 `fallback`（调用方给 `'未命名'`）；截断到 80 字符。
 */
export function sanitizeFileName(name: string, fallback = '未命名'): string {
  const cleaned = name.replace(ILLEGAL_IN_NAME, ' ').replace(/\s+/g, ' ').trim();
  if (cleaned.length === 0) return fallback;
  // ★ 截断到 80：部分系统对单段文件名有 255 字节上限，中文 UTF-8 下一个字占 3 字节，
  //   80 字已逼近该上限；超出部分即使保留也大概率写盘失败。
  return cleaned.slice(0, 80);
}

/**
 * 标题 → 笔记文件名（不含扩展名）。语义与 `NotePromoter.noteNameFrom` 完全一致
 * （后者应改为转调本函数，避免两套规则再次漂移）。
 */
export function noteNameFrom(title: string): string {
  return sanitizeFileName(title, '未命名');
}

/**
 * 取路径的最后一段（文件名含扩展名）：`'a/b/c.png'` → `'c.png'`；无目录时原样返回。
 *
 * ★ 用途是**兜底**：卡片需要一个能读出来的名字而用户又没写标题时（图片卡的 alt、
 *   地图卡的 alt），用完整 vault 路径当无障碍名等于没写。
 * ★ `cards/image.ts` 与 `cards/file.ts` 各有一份私有同名实现，三份**行为逐字相同**
 *   （都只认 `/`、都保留扩展名）—— 三者应改为转调本函数。
 */
export function fileNameOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? path : path.slice(slash + 1);
}

/**
 * 在 `dir` 下为 `base + ext` 找第一个不冲突的路径：`名字.ext` → `名字 2.ext` → `名字 3.ext`…
 *
 * ★ 上限 1000 次纯属防御死循环（`exists` 永远返回 true 的假实现）；
 *   真到 1000 个同名文件时，用户的问题已经不是文件名了。
 *
 * @param exists 同步或异步的"已占用"判断
 */
export async function uniquePath(
  dir: string,
  base: string,
  ext: string,
  exists: (path: string) => boolean | Promise<boolean>,
): Promise<string> {
  let index = 2;
  let target = joinPath(dir, `${base}${ext}`);
  while (index < 1000 && (await exists(target))) {
    target = joinPath(dir, `${base} ${index}${ext}`);
    index += 1;
  }
  return target;
}
