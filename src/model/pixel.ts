/**
 * 取色器的几何与像素换算（T3.05 / `F2.6`）。
 *
 * 从"用户点了一下"到"图源里哪一个像素"，中间有**两步**换算，两步都容易差一格：
 *
 * 1. **点 → 实际绘制矩形**：`<img>` 的 `getBoundingClientRect()` 是**元素盒**，
 *    不是**画出来的那块**。`object-fit: contain` 会在盒内留出空白，`cover` 则把内容
 *    溢出到盒外 —— 直接拿盒子换算，`contain` 下点正中间会取到偏上/偏下的一格。
 *    用户看到的现象是"取色器不准"，而谁也想不到是盒模型的事。
 * 2. **绘制矩形 → 像素索引**：比例乘原图尺寸再取整，边缘必须夹进合法范围
 *    （右下角那一个像素也得取得到）。
 *
 * 裁剪（T2.02）**不需要特殊处理**：裁剪时 `<img>` 被放大到"只露出 crop 那一块"，
 * 而它的宽高比恰好等于 crop 区的像素比，于是 `contain` / `cover` 两种算法都退化成
 * "矩形就是整张图" —— 同一套公式同时覆盖裁剪与未裁剪两种形态。
 *
 * ★ 零 DOM、零 canvas，全是算术：这条链路上最容易错的部分可以在 node 下单测。
 */

import { clamp, rectContainsPoint, type Point, type Rect, type Size } from '../util/geometry';
import { toHexColor } from '../util/color';
import type { HexColor, ImageFit } from './schema';

/** 图源上的一个像素（整数索引，原点在左上角） */
export interface PixelPoint {
  x: number;
  y: number;
}

/**
 * 低于这个 alpha（0~255）就当"这一点没有内容"。
 *
 * ★ 只拒绝**几乎全透明**的像素（PNG 留白、抠图边缘），半透明像素按它自己的 RGB 记。
 *   不按 alpha 合成的原因见 {@link hexFromRgba}。
 */
export const MIN_PIXEL_ALPHA = 8;

/**
 * 图片**实际被画出来**的那块矩形（屏幕坐标）。
 *
 * 盒子的宽高与原点无效（图还没加载完、卡片被压成 0 高）时返回 `null` =
 * "我没有意见"，交给调用方兜底。
 */
export function contentRectOf(box: Rect, natural: Size, fit: ImageFit): Rect | null {
  const { width: naturalWidth, height: naturalHeight } = natural;
  if (!(box.width > 0) || !(box.height > 0)) return null;
  if (!(naturalWidth > 0) || !(naturalHeight > 0)) return null;

  // cover 取"放大到铺满"的倍数（内容溢出盒子），contain 取"缩小到装下"的倍数（盒内留白）
  const scale =
    fit === 'cover'
      ? Math.max(box.width / naturalWidth, box.height / naturalHeight)
      : Math.min(box.width / naturalWidth, box.height / naturalHeight);
  const width = naturalWidth * scale;
  const height = naturalHeight * scale;

  // 居中：`object-position` 默认就是 center，卡片也没有改过它
  return {
    x: box.x + (box.width - width) / 2,
    y: box.y + (box.height - height) / 2,
    width,
    height,
  };
}

/**
 * 屏幕上的一个点 → 图源里的哪一个像素。
 *
 * 点落在**画出来的那块之外**（`contain` 的留白）返回 `null`：那里没有颜色可取，
 * 与其夹到边缘取一格邻居色（用户会以为"取色器偏了"），不如让调用方明说
 * "这一点不在图片上"。
 */
export function sourcePixelAt(point: Point, content: Rect, natural: Size): PixelPoint | null {
  if (!(natural.width > 0) || !(natural.height > 0)) return null;
  if (!rectContainsPoint(content, point)) return null;

  const nx = (point.x - content.x) / content.width;
  const ny = (point.y - content.y) / content.height;
  return {
    x: clamp(Math.floor(nx * natural.width), 0, natural.width - 1),
    y: clamp(Math.floor(ny * natural.height), 0, natural.height - 1),
  };
}

/**
 * 像素的四个通道 → 色号；**几乎没有内容**的像素返回 `null`。
 *
 * ★ 为什么不按 alpha 合成到某个底色上：合成需要知道底色，而卡片底色是**主题色**
 *   （深色主题下是深灰、浅色主题下是白），合出来的颜色会随主题漂移 ——
 *   那不是用户想要的"这个像素的颜色"。所以半透明像素就按它自己的 RGB 记
 *   （这个值可复现、与主题无关），只拒绝 alpha 低到"等于没有"的那些。
 */
export function hexFromRgba(r: number, g: number, b: number, a: number): HexColor | null {
  if (!(a >= MIN_PIXEL_ALPHA)) return null;
  return toHexColor(r, g, b);
}
