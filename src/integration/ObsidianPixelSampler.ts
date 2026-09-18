/**
 * 像素采样桥的 Obsidian / 浏览器实现（T3.05 / `F2.6`）。
 *
 * 做法：把**要的那一个像素**画到 1×1 的画布上，再读回来。
 *
 * ★ 为什么不是"整图 drawImage 到原尺寸画布再取一格"：一张 6000×4000 的截图
 *   按原尺寸建画布就是 96 MB，取一个颜色不值得。`drawImage` 的九参形式本来就允许
 *   只搬一块，1×1 的目的地与源尺寸相同（既不放大也不缩小），落下来的就是那一个像素。
 *
 * ★ 越界由 `getImageData` 自己兜：源矩形在图外时 `drawImage` 不画任何东西，
 *   读回来是全透明（alpha = 0），`hexFromRgba` 会返回 `null`。不必另写夹取。
 *
 * ★ 脏画布（跨域图）会在这里抛 `SecurityError`。**照约定吞掉并返回 `null`**：
 *   桥一律不抛异常，调用方按"取不到颜色"提示 —— "点一下取色"这种动作崩掉整个视图，
 *   比取不到颜色糟得多。
 *
 * ★ 不 import `obsidian`：只碰 Web API（canvas / drawImage / getImageData）。
 */

import type { PixelSamplerBridge } from '../cards/registry';
import { hexFromRgba, type PixelPoint } from '../model/pixel';
import type { HexColor } from '../model/schema';

/** 采样用的画布边长：只要一个像素 */
const SAMPLE_SIZE = 1;

/** 取某个像素的 RGBA。**本模块只负责"把像素读出来"**，取哪一格由 `model/pixel.ts` 算 */
function readPixel(image: HTMLImageElement, pixel: PixelPoint): HexColor | null {
  const canvas = document.createElement('canvas');
  canvas.width = SAMPLE_SIZE;
  canvas.height = SAMPLE_SIZE;
  const context = canvas.getContext('2d', { willReadFrequently: false });
  if (!context) return null;

  context.drawImage(
    image,
    pixel.x,
    pixel.y,
    SAMPLE_SIZE,
    SAMPLE_SIZE,
    0,
    0,
    SAMPLE_SIZE,
    SAMPLE_SIZE,
  );
  const data = context.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data;
  return hexFromRgba(data[0], data[1], data[2], data[3]);
}

export class ObsidianPixelSampler implements PixelSamplerBridge {
  /** 契约见 `PixelSamplerBridge`：**不抛异常**，取不到返回 `null` */
  async samplePixel(image: HTMLImageElement, pixel: PixelPoint): Promise<HexColor | null> {
    if (!(image.naturalWidth > 0) || !(image.naturalHeight > 0)) return null;
    try {
      return readPixel(image, pixel);
    } catch {
      // 脏画布 / 图已损坏 / 显存压力下拿不到 2D 上下文：一律当作"取不到"
      return null;
    }
  }
}
