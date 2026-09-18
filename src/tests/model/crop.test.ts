/**
 * 非破坏性裁剪的几何单元测试（T2.02 / `F2-3-3`）。
 *
 * 这里钉的全是"肉眼很难当场判断对错"的事：
 *  1. **拖出画布 / 拉到反向**：裁剪框必须被夹回图内，且**不能**小于 `MIN_CROP_SIZE`
 *     （比下限还小的话鼠标就抓不住了，用户只能靠"重置"逃出来）；
 *  2. **拉伸不动对侧边**：拖左边撞到图片左边界时，右边界不能跟着跑
 *     —— 那会让裁剪框整体平移，用户会以为"我明明只想裁掉左边"；
 *  3. **`cropClipStyle` 的百分比**：它是"整图放大多少、往哪推"的唯一来源，
 *     算错的表现是"裁完图片被拉扁"，而用户会以为是原图被插件改坏了；
 *  4. **比例先夹再夹位置**：`x` 的上限依赖 `w`，顺序反了会造出一个完全在图外的框。
 */

import { describe, expect, it } from 'vitest';
import {
  CROP_HANDLES,
  IDENTITY_CROP,
  MIN_CROP_SIZE,
  clampCrop,
  cropAspectRatio,
  cropClipStyle,
  cropEquals,
  isIdentityCrop,
  moveCrop,
  resizeCrop,
} from '../../model/crop';
import type { ImageCrop } from '../../model/schema';

const crop = (x: number, y: number, w: number, h: number): ImageCrop => ({ x, y, w, h });

/**
 * 按**近似值**比较四个比例。
 *
 * ★ 不能用 `toEqual`：裁剪值全是浮点（`0.8 - 0.2 = 0.6000000000000001`），
 *   精确比较会把正确实现判成错的 —— 而"差 1e-16"在屏幕上连亚像素都算不上。
 */
function expectCrop(actual: ImageCrop, expected: ImageCrop): void {
  expect(actual.x).toBeCloseTo(expected.x, 10);
  expect(actual.y).toBeCloseTo(expected.y, 10);
  expect(actual.w).toBeCloseTo(expected.w, 10);
  expect(actual.h).toBeCloseTo(expected.h, 10);
}

describe('isIdentityCrop', () => {
  it('整张图 = 恒等；只要有一边不是"满"就不是', () => {
    expect(isIdentityCrop(IDENTITY_CROP)).toBe(true);
    expect(isIdentityCrop(crop(0, 0, 1, 0.5))).toBe(false);
    expect(isIdentityCrop(crop(0.1, 0, 0.9, 1))).toBe(false);
  });

  it('容忍浮点误差（拖动夹到边界后算出的 `1 - w` 未必正好是 0）', () => {
    expect(isIdentityCrop(crop(1e-9, -1e-9, 1 + 1e-9, 1))).toBe(true);
  });
});

describe('clampCrop', () => {
  it('尺寸先夹、位置后夹，位置的上限依赖尺寸', () => {
    // w 只留 0.2 → x 的上限是 0.8，0.9 会被拉回来
    expect(clampCrop(crop(0.9, 0.9, 0.2, 0.2))).toEqual({ x: 0.8, y: 0.8, w: 0.2, h: 0.2 });
  });

  it('尺寸不小于下限（否则鼠标抓不住那根边）', () => {
    expect(clampCrop(crop(0, 0, 0, 0)).w).toBe(MIN_CROP_SIZE);
    expect(clampCrop(crop(0, 0, 0, 0)).h).toBe(MIN_CROP_SIZE);
  });

  it('非有限值不产生 `NaN` 几何：尺寸回落到 1、位置回落到 0', () => {
    expect(clampCrop(crop(Number.NaN, Number.NaN, Number.NaN, Number.NaN))).toEqual({
      x: 0,
      y: 0,
      w: 1,
      h: 1,
    });
  });
});

describe('moveCrop', () => {
  it('平移时尺寸不变', () => {
    expectCrop(moveCrop(crop(0.2, 0.2, 0.5, 0.5), 0.1, 0.1), crop(0.3, 0.3, 0.5, 0.5));
  });

  it('撞到右 / 下边界就停住，不会把框推出图外', () => {
    expectCrop(moveCrop(crop(0.5, 0.5, 0.5, 0.5), 0.9, 0.9), crop(0.5, 0.5, 0.5, 0.5));
  });

  it('往左 / 上拖过头也停在 0', () => {
    expectCrop(moveCrop(crop(0.3, 0.3, 0.5, 0.5), -10, -10), crop(0, 0, 0.5, 0.5));
  });
});

describe('resizeCrop', () => {
  const base = crop(0.2, 0.2, 0.6, 0.6); // 左 .2 上 .2 右 .8 下 .8

  it('拉东边：只动右边界', () => {
    expectCrop(resizeCrop(base, 'e', 0.1, 0), crop(0.2, 0.2, 0.7, 0.6));
  });

  it('拉西边：只动左边界', () => {
    expectCrop(resizeCrop(base, 'w', 0.1, 0), crop(0.3, 0.2, 0.5, 0.6));
  });

  it('拉北边：只动上边界', () => {
    expectCrop(resizeCrop(base, 'n', 0, -0.1), crop(0.2, 0.1, 0.6, 0.7));
  });

  it('拉南边：只动下边界', () => {
    expectCrop(resizeCrop(base, 's', 0, 0.1), crop(0.2, 0.2, 0.6, 0.7));
  });

  it('角柄同时动两条边', () => {
    expectCrop(resizeCrop(base, 'nw', 0.05, 0.05), crop(0.25, 0.25, 0.55, 0.55));
    expectCrop(resizeCrop(base, 'se', -0.05, -0.05), crop(0.2, 0.2, 0.55, 0.55));
  });

  it('★ 拖左边撞到图片左边界：右边界**不动**（否则整框跟着平移）', () => {
    const result = resizeCrop(base, 'w', -10, 0);
    expect(result.x).toBeCloseTo(0, 10);
    expect(result.x + result.w).toBeCloseTo(0.8, 10);
  });

  it('★ 拉到反向：被 `MIN_CROP_SIZE` 挡住，不会缩成负宽度', () => {
    const result = resizeCrop(base, 'e', -10, 0);
    expect(result.w).toBeCloseTo(MIN_CROP_SIZE, 10);
    expect(result.x).toBeCloseTo(0.2, 10);
  });

  it('往右拉过头：被图片右边界（1）挡住', () => {
    expect(resizeCrop(base, 'e', 10, 0).w).toBeCloseTo(0.8, 10);
  });

  it('八个柄都有定义（少一个就是"某个角拉不动"）', () => {
    expect(CROP_HANDLES).toHaveLength(8);
    for (const handle of CROP_HANDLES) {
      expectCrop(resizeCrop(base, handle, 0, 0), base);
    }
  });
});

describe('cropAspectRatio', () => {
  it('按裁剪区的比例算（不是原图比例）', () => {
    expect(cropAspectRatio(IDENTITY_CROP, 400, 200)).toBe(2);
    // 只留左半边 → 200×200 → 1
    expect(cropAspectRatio(crop(0, 0, 0.5, 1), 400, 200)).toBeCloseTo(1, 10);
  });

  it('读不到原图尺寸返回 `null` = "我没有意见"', () => {
    expect(cropAspectRatio(IDENTITY_CROP, 0, 200)).toBeNull();
    expect(cropAspectRatio(IDENTITY_CROP, 400, Number.NaN)).toBeNull();
  });
});

describe('cropClipStyle', () => {
  it('恒等裁剪 = 整图铺满窗口、不位移', () => {
    expect(cropClipStyle(IDENTITY_CROP)).toEqual({
      width: '100%',
      height: '100%',
      left: '0%',
      top: '0%',
    });
  });

  it('按 `1/w`、`1/h` 放大，再把左上角推出去', () => {
    // 窗口只有半宽、四分之一高 → 整图要放大 2× / 4×；左上角在外面 20% / 80%
    expect(cropClipStyle(crop(0.1, 0.2, 0.5, 0.25))).toEqual({
      width: '200%',
      height: '400%',
      left: '-20%',
      top: '-80%',
    });
  });

  it('入口先夹一次：越界的 `x` 不会算出卖到窗口外的位移', () => {
    const style = cropClipStyle(crop(0.9, 0, 0.2, 1));
    expect(style.width).toBe('500%');
    expect(style.left).toBe('-400%');
  });
});

describe('cropEquals', () => {
  it('四个数全等才是相等（用来挡掉"拖回原样"的无变化写入）', () => {
    expect(cropEquals(IDENTITY_CROP, crop(0, 0, 1, 1))).toBe(true);
    expect(cropEquals(IDENTITY_CROP, crop(0.1, 0, 1, 1))).toBe(false);
    expect(cropEquals(crop(0.1, 0.2, 0.5, 0.5), crop(0.1, 0.2, 0.5, 0.4))).toBe(false);
  });
});
