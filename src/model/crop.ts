/**
 * 非破坏性裁剪的几何（T2.02 / `F2-3-3`）。
 *
 * ★ 纯函数 + 零依赖（`model/` 不 import `obsidian`，见 `03 §7.2`）：
 *   "拖动 / 拉伸裁剪框"这件事的**全部算术**都放在这里，对话框那边只做两件事 ——
 *   把像素位移换算成比例、把结果贴回 DOM。于是这些边界情况（拖出画布、
 *   拉到反向、缩到 0 宽）都能在 node 下直接钉住，不必真的去拉鼠标。
 *
 * ★ 裁剪**只改卡片里的四个数**，绝不碰原图文件。这是 `F2-3-3` 的硬要求，
 *   也是"裁剪"能不能被撤销的前提：撤销一次就是把这四个数换回去。
 */

import type { ImageCrop } from './schema';

/** 恒等裁剪：整张图都显示（新建图片卡的初值，也是"重置"的目标） */
export const IDENTITY_CROP: ImageCrop = { x: 0, y: 0, w: 1, h: 1 };

/**
 * 裁剪框的最小边长（占原图比例）。
 *
 * ★ 必须有下限：比例趋近 0 时，裁剪框在屏幕上只剩一两个像素 —— 鼠标抓不住，
 *   用户也看不出裁掉了什么，只能靠"重置"逃出来。5% 在任何常见尺寸下都还抓得住。
 */
export const MIN_CROP_SIZE = 0.05;

/** 八个拉伸柄。用方位缩写，`resizeCrop` 靠 `includes('w')` 这类判断决定动哪条边 */
export type CropHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

export const CROP_HANDLES: readonly CropHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/** 浮点误差容忍：拖动夹到边界后 `x` 会算出 `1 - w` 这样的表达式，未必正好是 0 */
const EPSILON = 1e-6;

/** 是否等于"整张图"（此时不需要设置纵横比约束，显示逻辑与裁剪功能之前完全一致） */
export function isIdentityCrop(crop: ImageCrop): boolean {
  return (
    Math.abs(crop.x) < EPSILON &&
    Math.abs(crop.y) < EPSILON &&
    Math.abs(crop.w - 1) < EPSILON &&
    Math.abs(crop.h - 1) < EPSILON
  );
}

/**
 * 把一份（可能来自用户手改 `.nboard`、或来自旧版本的）裁剪参数收敛到合法范围。
 *
 * ★ `w` / `h` 先夹、`x` / `y` 后夹，而且后者的上限依赖前者（`1 - w`）：
 *   反过来的话，"把宽度拉到 0.2 但 x 还停在 0.9"就会出现一个**完全在画布外**的
 *   裁剪框，显示出来是一片空白，用户只会以为"图片坏了"。
 */
export function clampCrop(crop: ImageCrop): ImageCrop {
  const w = clampSize(crop.w);
  const h = clampSize(crop.h);
  return {
    w,
    h,
    x: clamp(crop.x, 0, 1 - w),
    y: clamp(crop.y, 0, 1 - h),
  };
}

/** 平移裁剪框（尺寸不变）。`dx` / `dy` 是**原图比例**上的位移，不是像素 */
export function moveCrop(crop: ImageCrop, dx: number, dy: number): ImageCrop {
  const base = clampCrop(crop);
  return {
    ...base,
    x: clamp(base.x + dx, 0, 1 - base.w),
    y: clamp(base.y + dy, 0, 1 - base.h),
  };
}

/**
 * 拉伸裁剪框。`dx` / `dy` 是原图比例上的位移。
 *
 * ★ 用"四条边"而不是"左上角 + 宽高"来表达这一步：拉伸会同时移动对侧的边，
 *   用宽高写就要为八个柄各写一套加减法，而其中总有一两个会把符号写反 ——
 *   表现是"往右拉反而变窄"。边表示法下，八个柄的差别只剩"动哪几条边"。
 *
 * ★ 拖动的那条边夹住时**不动对侧的边**：用户拖左边撞到图片左边界，右边界不该跟着跑。
 */
export function resizeCrop(crop: ImageCrop, handle: CropHandle, dx: number, dy: number): ImageCrop {
  const base = clampCrop(crop);
  let left = base.x;
  let top = base.y;
  let right = base.x + base.w;
  let bottom = base.y + base.h;

  if (handle.includes('w')) left = clamp(left + dx, 0, right - MIN_CROP_SIZE);
  if (handle.includes('e')) right = clamp(right + dx, left + MIN_CROP_SIZE, 1);
  if (handle.includes('n')) top = clamp(top + dy, 0, bottom - MIN_CROP_SIZE);
  if (handle.includes('s')) bottom = clamp(bottom + dy, top + MIN_CROP_SIZE, 1);

  return { x: left, y: top, w: right - left, h: bottom - top };
}

/**
 * 裁剪区的**像素**宽高比（宽 / 高）。
 *
 * 卡片要按它算高度与摆放裁剪区：裁剪之后"图片"的形状就是裁剪区的形状，
 * 拿原图的纵横比去排版会多出一圈留白。
 *
 * 读不到原图尺寸（还在加载 / 图坏了）返回 `null` = "我没有意见"，交给调用方兜底。
 */
export function cropAspectRatio(
  crop: ImageCrop,
  naturalWidth: number,
  naturalHeight: number,
): number | null {
  if (!(naturalWidth > 0) || !(naturalHeight > 0)) return null;
  const width = naturalWidth * clampCrop(crop).w;
  const height = naturalHeight * clampCrop(crop).h;
  if (!(width > 0) || !(height > 0)) return null;
  return width / height;
}

/** 四边裁剪参数的等价比较（`commit` 用它挡掉"拖回原样"这种无变化的写入） */
export function cropEquals(a: ImageCrop, b: ImageCrop): boolean {
  return (
    Math.abs(a.x - b.x) < EPSILON &&
    Math.abs(a.y - b.y) < EPSILON &&
    Math.abs(a.w - b.w) < EPSILON &&
    Math.abs(a.h - b.h) < EPSILON
  );
}

/** 把裁剪区"放大到铺满"所需的 CSS 尺寸/位移（百分比，相对裁剪窗口） */
export interface CropClipStyle {
  width: string;
  height: string;
  left: string;
  top: string;
}

/**
 * 算出"只显示裁剪区"该给 `<img>` 写的 CSS。
 *
 * ★ 做法是**放大整图 + 让窗口裁掉溢出**，而不是去改原图：
 *   `width: 1/w` 让整图按"裁剪区要铺满窗口"的比例放大，再把左上角推到
 *   `-x/w, -y/w` —— 于是窗口里剩下的恰好就是 `x,y,w,h` 那一块。
 *   写百分比而不是像素：窗口在卡片里是弹性尺寸，像素值一算就过时。
 *
 * ★ 必须是纯函数：这套算术（尤其"窗口形状 = 裁剪区比例"这个前提）错了，
 *   表现是"裁完图片被拉扁"，而肉眼很难判断到底是渲染错了还是原图本来就那样。
 */
export function cropClipStyle(crop: ImageCrop): CropClipStyle {
  const c = clampCrop(crop);
  return {
    width: percent(1 / c.w),
    height: percent(1 / c.h),
    left: percent(-c.x / c.w),
    top: percent(-c.y / c.h),
  };
}

/** 比例 → CSS 百分比字符串；保留 4 位小数已远超屏幕像素精度 */
function percent(ratio: number): string {
  return `${Math.round(ratio * 100 * 1e4) / 1e4}%`;
}

function clampSize(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return clamp(value, MIN_CROP_SIZE, 1);
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}
