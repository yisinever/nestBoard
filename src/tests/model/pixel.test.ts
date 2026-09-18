/**
 * 取色换算的单元测试（T3.05 / `F2.6`）。
 *
 * 这条链路上没有一处会"看起来不对"，全都是差一格、差一行 —— 而且错了以后
 * 用户只会说"取色器不准"，排查时还得先怀疑屏幕、怀疑缩放、怀疑图片格式。
 * 所以这里盯死三件事：
 *
 *  1. **`contain` 的留白**必须按"画出来的那块"算：点图片正中间就得是正中间，
 *     点在留白上要明说"没有像素"，而不是夹到边缘取一格邻居色；
 *  2. **`cover` 的溢出**同样按内容算：点卡片角落对应的是图里被裁掉的那一块；
 *  3. **边缘像素取得到**（右下角那一个也是合法像素），**透明像素取不到**。
 */

import { describe, expect, it } from 'vitest';
import { MIN_PIXEL_ALPHA, contentRectOf, hexFromRgba, sourcePixelAt } from '../../model/pixel';
import { toHexColor } from '../../util/color';
import type { Rect, Size } from '../../util/geometry';

const rect = (x: number, y: number, width: number, height: number): Rect => ({
  x,
  y,
  width,
  height,
});

describe('contentRectOf', () => {
  it('contain：整图装进盒子，多出来的方向居中留白', () => {
    // 400×100 的图装进 200×200 的盒子 → 缩放 0.5 → 200×50，上下各留 75
    expect(contentRectOf(rect(0, 0, 200, 200), { width: 400, height: 100 }, 'contain')).toEqual(
      rect(0, 75, 200, 50),
    );
  });

  it('contain：宽图在窄盒里横向留白', () => {
    expect(contentRectOf(rect(10, 10, 300, 300), { width: 100, height: 400 }, 'contain')).toEqual(
      rect(122.5, 10, 75, 300),
    );
  });

  it('cover：放大到铺满，内容溢出盒子（原点跑到盒子外）', () => {
    // 400×100 铺满 200×200 → 缩放 2 → 800×200，横向溢出 600，左移 300
    expect(contentRectOf(rect(0, 0, 200, 200), { width: 400, height: 100 }, 'cover')).toEqual(
      rect(-300, 0, 800, 200),
    );
  });

  it('宽高比一致时两种 fit 都退化成"矩形就是图"（裁剪形态就是靠这一条）', () => {
    const box = rect(50, 60, 300, 150);
    const natural: Size = { width: 600, height: 300 };
    expect(contentRectOf(box, natural, 'contain')).toEqual(box);
    expect(contentRectOf(box, natural, 'cover')).toEqual(box);
  });

  it('盒子被压成 0（未布局 / 折叠）时不给意见', () => {
    const natural: Size = { width: 100, height: 100 };
    expect(contentRectOf(rect(0, 0, 0, 100), natural, 'contain')).toBeNull();
    expect(contentRectOf(rect(0, 0, 100, 0), natural, 'cover')).toBeNull();
  });

  it('图还没加载完（自然尺寸为 0）时不给意见', () => {
    expect(contentRectOf(rect(0, 0, 100, 100), { width: 0, height: 0 }, 'contain')).toBeNull();
  });
});

describe('sourcePixelAt', () => {
  const natural: Size = { width: 400, height: 200 };

  it('点正中间 → 正中间的像素', () => {
    const content = rect(100, 100, 200, 100);
    expect(sourcePixelAt({ x: 200, y: 150 }, content, natural)).toEqual({ x: 200, y: 100 });
  });

  it('图被放大 2 倍时按比例换算（不是按屏幕像素）', () => {
    const content = rect(0, 0, 800, 400);
    expect(sourcePixelAt({ x: 100, y: 100 }, content, natural)).toEqual({ x: 50, y: 50 });
  });

  it('左上角取 (0,0)，右下角取得到最后一个像素', () => {
    const content = rect(0, 0, 200, 100);
    expect(sourcePixelAt({ x: 0, y: 0 }, content, natural)).toEqual({ x: 0, y: 0 });
    expect(sourcePixelAt({ x: 200, y: 100 }, content, natural)).toEqual({ x: 399, y: 199 });
  });

  it('右下角边界上的一格不会越界（夹取而不是取到 400）', () => {
    const content = rect(0, 0, 200, 100);
    expect(sourcePixelAt({ x: 199.9, y: 99.9 }, content, natural)).toEqual({ x: 399, y: 199 });
  });

  it('点在 contain 的留白里 → null（那里没有像素）', () => {
    // 400×100 的图装在 200×200 的盒子里：内容只有中间那条 200×50
    const content = contentRectOf(rect(0, 0, 200, 200), { width: 400, height: 100 }, 'contain');
    expect(content).not.toBeNull();
    expect(
      sourcePixelAt({ x: 100, y: 20 }, content as Rect, { width: 400, height: 100 }),
    ).toBeNull();
    expect(sourcePixelAt({ x: 100, y: 100 }, content as Rect, { width: 400, height: 100 })).toEqual(
      {
        x: 200,
        y: 50,
      },
    );
  });

  it('点在 cover 溢出到盒子外的内容上照样算得出来', () => {
    const content = contentRectOf(rect(0, 0, 200, 200), { width: 400, height: 100 }, 'cover');
    // 内容矩形是 (-300, 0, 800, 200)：点盒子左上角 = 图里 37.5% 处
    expect(sourcePixelAt({ x: 0, y: 0 }, content as Rect, { width: 400, height: 100 })).toEqual({
      x: 150,
      y: 0,
    });
  });

  it('自然尺寸为 0 时不给意见（图还没解码完）', () => {
    expect(sourcePixelAt({ x: 1, y: 1 }, rect(0, 0, 10, 10), { width: 0, height: 0 })).toBeNull();
  });
});

describe('hexFromRgba', () => {
  it('常规像素 → 小写色号', () => {
    expect(hexFromRgba(76, 141, 255, 255)).toBe('#4c8dff');
  });

  it('半透明像素按它自己的 RGB 记（不合成主题底色，值才可复现）', () => {
    expect(hexFromRgba(76, 141, 255, 128)).toBe('#4c8dff');
  });

  it('完全透明 / 几乎透明 → null（那里没有内容）', () => {
    expect(hexFromRgba(0, 0, 0, 0)).toBeNull();
    expect(hexFromRgba(0, 0, 0, MIN_PIXEL_ALPHA - 1)).toBeNull();
  });

  it('刚好到阈值就算数（阈值本身是合法的）', () => {
    expect(hexFromRgba(255, 255, 255, MIN_PIXEL_ALPHA)).toBe('#ffffff');
  });

  it('越界与小数通道被夹取 / 取整（脏数据不产出非法色号）', () => {
    expect(hexFromRgba(300, -20, 1.6, 255)).toBe('#ff0002');
  });
});

describe('toHexColor', () => {
  it('补足两位（不产出 `#f0a` 这种三位写法）', () => {
    expect(toHexColor(0, 15, 160)).toBe('#000fa0');
  });

  it('非有限值当 0（`NaN` 不该扩散成 `#NaNNaNNaN`）', () => {
    expect(toHexColor(Number.NaN, 255, 255)).toBe('#00ffff');
  });
});
