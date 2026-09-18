import { describe, expect, it } from 'vitest';
import {
  boundsOf,
  clamp,
  expandRect,
  normalizeAngle,
  pointerAngleDeg,
  rectCenter,
  rectContainsPoint,
  rectsIntersect,
  rotatePoint,
  rotatedBoundsOf,
  roundTo,
} from '../../util/geometry';

describe('boundsOf', () => {
  it('空数组 / 全是非法值时返回 null（由调用方决定退化行为）', () => {
    expect(boundsOf([])).toBeNull();
    expect(boundsOf([{ x: Number.NaN, y: 0, width: 10, height: 10 }])).toBeNull();
  });

  it('求所有矩形的包围盒', () => {
    expect(
      boundsOf([
        { x: 0, y: 0, width: 100, height: 50 },
        { x: 200, y: 120, width: 40, height: 40 },
        { x: -30, y: 60, width: 10, height: 10 },
      ]),
    ).toEqual({ x: -30, y: 0, width: 270, height: 160 });
  });

  it('跳过个别非法矩形，其余照常计算（一块坏卡片不该毁掉"适应内容"）', () => {
    expect(
      boundsOf([
        { x: 0, y: 0, width: 10, height: 10 },
        { x: Number.NaN, y: 0, width: 10, height: 10 },
      ]),
    ).toEqual({ x: 0, y: 0, width: 10, height: 10 });
  });

  it('单个矩形就是它自己（零宽也合法：单张卡片）', () => {
    expect(boundsOf([{ x: 5, y: 5, width: 0, height: 0 }])).toEqual({
      x: 5,
      y: 5,
      width: 0,
      height: 0,
    });
  });
});

describe('矩形运算', () => {
  it('rectsIntersect：边界相接不算相交', () => {
    const a = { x: 0, y: 0, width: 10, height: 10 };
    expect(rectsIntersect(a, { x: 5, y: 5, width: 10, height: 10 })).toBe(true);
    expect(rectsIntersect(a, { x: 10, y: 0, width: 10, height: 10 })).toBe(false);
    expect(rectsIntersect(a, { x: 20, y: 20, width: 1, height: 1 })).toBe(false);
    expect(rectsIntersect(a, a)).toBe(true);
  });

  it('rectContainsPoint 含边界', () => {
    const rect = { x: 0, y: 0, width: 10, height: 10 };
    expect(rectContainsPoint(rect, { x: 0, y: 0 })).toBe(true);
    expect(rectContainsPoint(rect, { x: 10, y: 10 })).toBe(true);
    expect(rectContainsPoint(rect, { x: 10.5, y: 10 })).toBe(false);
  });

  it('expandRect 四边等距外扩', () => {
    expect(expandRect({ x: 10, y: 10, width: 20, height: 20 }, 5)).toEqual({
      x: 5,
      y: 5,
      width: 30,
      height: 30,
    });
  });

  it('rectCenter', () => {
    expect(rectCenter({ x: 10, y: 20, width: 100, height: 50 })).toEqual({ x: 60, y: 45 });
  });
});

describe('数值工具', () => {
  it('clamp：越界夹紧，NaN 取 min（不把 NaN 漏进坐标系）', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(clamp(50, 0, 10)).toBe(10);
    expect(clamp(Number.NaN, 0, 10)).toBe(0);
  });

  it('roundTo：默认 2 位，可指定精度', () => {
    expect(roundTo(0.30000000000000004)).toBe(0.3);
    expect(roundTo(1.23456789)).toBe(1.23);
    expect(roundTo(1.23456789, 4)).toBe(1.2346);
    expect(roundTo(-1.987654)).toBe(-1.99);
  });
});

// ─────────────────────────────────────────────────────────────
// 卡片旋转的几何基元（T7.06 / `F2-00-10`）
//
// 这一组是旋转功能的**地基**：命中测试、连线锚点、导出取景、缩略图全都只用它们，
// 所以它们错了会以"七八个地方同时不对"的形式表现出来 —— 而每个地方看起来
// 都只是"差一点点"，靠肉眼几乎不可能归因回这里。
// ─────────────────────────────────────────────────────────────

describe('normalizeAngle', () => {
  it('折叠到 (-180, 180]：同一个朝向只有一种写法', () => {
    expect(normalizeAngle(0)).toBe(0);
    expect(normalizeAngle(90)).toBe(90);
    expect(normalizeAngle(360)).toBe(0);
    expect(normalizeAngle(450)).toBe(90);
    expect(normalizeAngle(-270)).toBe(90);
  });

  it('±180 是同一个朝向，统一写成 180（否则"和上次一样吗"永远判不出来）', () => {
    expect(normalizeAngle(180)).toBe(180);
    expect(normalizeAngle(-180)).toBe(180);
    expect(normalizeAngle(540)).toBe(180);
  });

  it('非有限值一律当 0：宁可这张卡不转，也不能让 NaN 进样式把整张卡变没', () => {
    expect(normalizeAngle(Number.NaN)).toBe(0);
    expect(normalizeAngle(Number.POSITIVE_INFINITY)).toBe(0);
    expect(normalizeAngle(Number.NEGATIVE_INFINITY)).toBe(0);
  });

  it('小数原样保留（归一化不是取整）', () => {
    expect(normalizeAngle(89.5)).toBe(89.5);
    expect(normalizeAngle(-0.5)).toBe(-0.5);
    expect(normalizeAngle(359.5)).toBe(-0.5);
  });
});

describe('rotatePoint / pointerAngleDeg', () => {
  const origin = { x: 0, y: 0 };

  it('★ y 向下的坐标系里正角度看起来是**顺时针**（与 CSS / Canvas 同向）', () => {
    const turned = rotatePoint({ x: 10, y: 0 }, origin, 90);
    expect(turned.x).toBeCloseTo(0);
    expect(turned.y).toBeCloseTo(10);
  });

  it('0 度原样返回（绝大多数卡片走这条早退）', () => {
    expect(rotatePoint({ x: 3, y: 4 }, { x: 1, y: 1 }, 0)).toEqual({ x: 3, y: 4 });
  });

  it('转一整圈回到原地；反向转是逆变换', () => {
    const point = { x: 7, y: -2 };
    expect(rotatePoint(point, origin, 360).x).toBeCloseTo(7);
    expect(rotatePoint(point, origin, 360).y).toBeCloseTo(-2);

    const turned = rotatePoint({ x: 10, y: 0 }, origin, -90);
    expect(turned.x).toBeCloseTo(0);
    expect(turned.y).toBeCloseTo(-10);
  });

  it('绕非原点转：支点自己不动', () => {
    const center = { x: 50, y: 50 };
    const turned = rotatePoint(center, center, 37);
    expect(turned.x).toBeCloseTo(50);
    expect(turned.y).toBeCloseTo(50);
  });

  it('pointerAngleDeg 与 rotatePoint 互逆（一个由角得点、一个由点得角）', () => {
    const center = { x: 12, y: -8 };
    const point = rotatePoint({ x: 112, y: -8 }, center, 30);
    expect(pointerAngleDeg(center, point)).toBeCloseTo(30);
  });

  it('方位角：0 = 正右、90 = 正下、±180 = 正左', () => {
    expect(pointerAngleDeg(origin, { x: 5, y: 0 })).toBeCloseTo(0);
    expect(pointerAngleDeg(origin, { x: 0, y: 5 })).toBeCloseTo(90);
    expect(pointerAngleDeg(origin, { x: -5, y: 0 })).toBeCloseTo(180);
  });
});

describe('rotatedBoundsOf', () => {
  const rect = { x: 0, y: 0, width: 100, height: 50 };

  it('0 度逐字段原样返回（导出 / 缩略图每帧都调它，早退省掉四次三角函数）', () => {
    expect(rotatedBoundsOf(rect, 0)).toEqual(rect);
  });

  it('90 / 270 度把宽高对调', () => {
    const right = rotatedBoundsOf(rect, 90);
    expect(right.width).toBeCloseTo(50);
    expect(right.height).toBeCloseTo(100);

    const left = rotatedBoundsOf(rect, -90);
    expect(left.width).toBeCloseTo(50);
    expect(left.height).toBeCloseTo(100);
  });

  it('180 度尺寸不变（朝向反了，占的地方一样）', () => {
    const box = rotatedBoundsOf(rect, 180);
    expect(box.width).toBeCloseTo(100);
    expect(box.height).toBeCloseTo(50);
  });

  it('正方形转 45 度按 √2 放大', () => {
    const box = rotatedBoundsOf({ x: 0, y: 0, width: 10, height: 10 }, 45);
    expect(box.width).toBeCloseTo(Math.SQRT2 * 10);
    expect(box.height).toBeCloseTo(Math.SQRT2 * 10);
  });

  it('★ 外接框的中心与原矩形中心重合（四处"旋转支点"必须一致）', () => {
    const source = { x: 20, y: -5, width: 120, height: 60 };
    const box = rotatedBoundsOf(source, 33);
    const center = rectCenter(source);
    const boxCenter = rectCenter(box);
    expect(boxCenter.x).toBeCloseTo(center.x);
    expect(boxCenter.y).toBeCloseTo(center.y);
  });
});
