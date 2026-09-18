/**
 * 节点上的**引用**（`B`：从文件浏览器 / 系统拖进来的东西，`06 §4.1`）—— 纯逻辑。
 *
 * ── 为什么只存一条路径 ──────────────────────────────────────
 *
 * `MindRef` 就是 `{ kind, path }`，**不存标题**：卡上那行字是文件名，而文件名能从
 * `path` 推出来。存一份就多一处要在改名时同步的地方（与 `LinkIndex` 那条
 * "能推导出来的数据不值得维护两次"同一条）。
 *
 * ── `kind` 是给谁看的 ───────────────────────────────────────
 *
 * 渲染层拿它给 chip 换个图标 / 颜色（图片、笔记、其他文件三种）。它由**扩展名**推出来，
 * 因此永远和 `path` 自洽 —— 这也是不把它写进文件的理由之一（写进去就可能与路径打架）。
 *
 * ★ 纯逻辑：不 import `obsidian`、不碰 DOM，可直接单测。
 */

import { splitName } from '../../util/fileName';
import type { MindNode, MindRef, MindRefKind } from './schema';

/** 图片默认显示宽度（px）：没拖过角的图就按这个宽显示 */
export const MIND_IMAGE_DEFAULT_WIDTH = 200;
/** 图片拖角时的宽度上下限（px）：下限太小看不清、上限太大一张图能占满屏幕 */
export const MIND_IMAGE_MIN_WIDTH = 60;
export const MIND_IMAGE_MAX_WIDTH = 640;

/** 能当图片看的那几种扩展名 */
const IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.svg',
  '.bmp',
  '.avif',
]);

/**
 * 引用在界面上的**名字**：文件名（含扩展名），不含目录。
 *
 * ★ 回形针的悬停提示、"已挂上「…」"这类提示都用它 —— 写在一处，
 *   免得界面上同一件东西在三处有三种写法。
 */
export function refLabelOf(path: string): string {
  const { base, ext } = splitName(path);
  return `${base}${ext}`;
}

/**
 * 一条路径 → 引用类型：图片 / 笔记 / 其他文件。
 *
 * ★ 扩展名**统一小写再比**：`splitName` 原样返回用户写的那个（`照片.JPG` 就是 `.JPG`），
 *   直接比集合会把大写扩展名的图判成"普通文件"（这一条是被单测逮住的）。
 */
export function refKindOfPath(path: string): MindRefKind {
  const { ext } = splitName(path);
  const lower = ext.toLowerCase();
  if (IMAGE_EXTENSIONS.has(lower)) return 'image';
  if (lower === '.md') return 'note';
  return 'file';
}

/**
 * 节点上**当前那一条**附件（`06 §4.1`：一个节点一个附件，界面只认第一条）。
 *
 * ★ 收成一个函数：渲染（回形针 / 图片块）、尺寸估算、拖拽落位都要问同一件事 ——
 *   各写一遍 `node.refs?.[0]` 迟早会在某处写成 `[1]`。
 */
export function firstRefOf(node: MindNode): MindRef | null {
  return node.refs?.[0] ?? null;
}

/**
 * 一批拖进来的路径 → **一条**引用。
 *
 * ★ 一个节点只挂一个附件，所以多个文件同时拖进来时**取第一个**，
 *   并把被舍掉的条数回给调用方（由它提示一句"只挂上了第一个"）——
 *   悄悄丢掉两个文件、用户还以为三张图都挂上了，那才是真糟糕。
 * ★ 一条可用路径都没有（拖的是外链 / 空文本）⇒ `ref` 为 `null`，调用方什么都不做。
 */
export function pickRef(paths: readonly string[]): { ref: MindRef | null; extras: number } {
  const usable = paths.map((path) => path.trim()).filter((path) => path.length > 0);
  const first = usable[0];
  return {
    ref: first ? { kind: refKindOfPath(first), path: first } : null,
    extras: Math.max(0, usable.length - 1),
  };
}

/**
 * 两条引用是不是同一条（写回前判"真的改了吗"用）。
 *
 * ★ **宽度也要比**：不比的话"把图片拉大一点"会被判成没改，`⌘Z` 于是退不回去。
 */
export function sameRef(a: MindRef | null | undefined, b: MindRef | null | undefined): boolean {
  if (!a || !b) return (a ?? null) === (b ?? null);
  return a.path === b.path && a.kind === b.kind && (a.width ?? null) === (b.width ?? null);
}

/** 列表版（`ops.setRefs` 用）：逐条比 */
export function sameRefs(
  a: readonly MindRef[] | undefined,
  b: readonly MindRef[] | undefined,
): boolean {
  const left = a ?? [];
  const right = b ?? [];
  if (left.length !== right.length) return false;
  return left.every((ref, index) => sameRef(ref, right[index]));
}
