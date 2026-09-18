/**
 * 手绘纯逻辑单元测试（T3.06 / T3.07 / `F4-01`–`F4-03`）。
 *
 * 这里钉住几件"错了只能靠手画几百笔才撞见"的事：
 *
 *  * **采样间距**：太密 → 一条 10px 的短线塞进几百个点；太疏 → 慢画曲线变折线；
 *  * **擦除判定**：点到折线的最短距离（判错 = "擦不掉"或"擦到旁边那根"）；
 *  * **脏区**：刚画的这一段占了哪块世界矩形（少算 = 线尾留下半截残影）；
 *  * **压感 → 线宽**：设备不报压感时绝不能变细（鼠标笔迹会集体变成半宽）；
 *  * **颜色 / 档位迁移**：`X` 按两下必须回到原色，档位越界必须夹回而不是变 NaN。
 *
 * ★ Canvas 绘制本身只能在 Obsidian 里肉眼验证（需要真 2D 上下文），本文件不碰 DOM。
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INK_COLOR,
  DEFAULT_INK_WIDTH,
  DEFAULT_INK_WIDTH_INDEX,
  INK_BRUSH_WIDTHS,
  INK_COLORS,
  INK_ERASER_RADIUS_PX,
  INK_MARKER_ALPHA,
  INK_MARKER_WIDTH_SCALE,
  INK_PRESSURE_MIN,
  INK_SAMPLE_DISTANCE_PX,
  appendStroke,
  brushWidth,
  clampWidthIndex,
  createStroke,
  defaultInkToolState,
  distanceToSegment,
  distanceToStroke,
  inkStrokeStyle,
  isTapered,
  isTranslucent,
  pressureOf,
  removeStrokes,
  segmentDirtyRect,
  segmentWidthAt,
  shouldAppendPoint,
  strokeAlpha,
  strokeBounds,
  strokeWidthAt,
  strokesBounds,
  strokesHitByEraser,
  styleAlpha,
  swapInkColors,
  toInkPoint,
  toStrokeSpace,
  withInkColor,
  withInkWidth,
} from '../../model/ink';
import type { InkPath, InkPoint } from '../../model/schema';

/** 造一笔，省掉每个用例里重复的字段 */
function path(points: InkPoint[], width = 3, color = '#000000'): InkPath {
  return { color, width, points };
}

describe('常量', () => {
  it('默认笔是红色 —— 深浅主题下都看得见，且"标注"本就该显眼', () => {
    expect(DEFAULT_INK_COLOR).toBe('#e03131');
  });

  it('采样阈值与橡皮半径都定在屏幕像素（手感跟眼睛走）', () => {
    expect(INK_SAMPLE_DISTANCE_PX).toBe(2);
    expect(INK_ERASER_RADIUS_PX).toBe(12);
  });

  it('★ 4 档笔宽严格递增，且默认档是表里真实存在的一档', () => {
    expect(INK_BRUSH_WIDTHS.length).toBe(4);
    for (let index = 1; index < INK_BRUSH_WIDTHS.length; index += 1) {
      expect(INK_BRUSH_WIDTHS[index]).toBeGreaterThan(INK_BRUSH_WIDTHS[index - 1]);
    }
    // 默认线宽必须由档位表推出：写死的数字早晚会和表对不上（"默认笔"变成表外的一档）
    expect(DEFAULT_INK_WIDTH).toBe(INK_BRUSH_WIDTHS[DEFAULT_INK_WIDTH_INDEX]);
  });

  it('调色板无重复色：重复的话点第一颗和点第二颗会得到同一个结果，用户以为坏了', () => {
    expect(new Set(INK_COLORS).size).toBe(INK_COLORS.length);
  });

  it('★ 默认前后色都在调色板里：不在的话工具条上"当前色"一颗都不高亮', () => {
    const state = defaultInkToolState();
    expect(INK_COLORS).toContain(state.color);
    expect(INK_COLORS).toContain(state.alternateColor);
    expect(state.color).not.toBe(state.alternateColor);
  });
});

describe('createStroke', () => {
  it('落笔只有一个点：渲染层据此画圆点，所以点的数量必须精确是 1', () => {
    const stroke = createStroke({ x: 12, y: 34 }, { color: '#ff0000', width: 5 });
    expect(stroke).toEqual({ color: '#ff0000', width: 5, points: [[12, 34]] });
  });
});

describe('shouldAppendPoint', () => {
  it('空笔画上任何有限点都要记（第一笔不能丢）', () => {
    expect(shouldAppendPoint([], { x: 0, y: 0 }, 2)).toBe(true);
  });

  it('★ 间距没到就丢掉：静止时的手抖不该在文件里堆出一串重合坐标', () => {
    const points: Array<[number, number]> = [[0, 0]];
    expect(shouldAppendPoint(points, { x: 1, y: 0 }, 2)).toBe(false);
    // 边界：恰好等于阈值要记（`>=`，否则慢慢画会一路丢掉所有点）
    expect(shouldAppendPoint(points, { x: 2, y: 0 }, 2)).toBe(true);
    expect(shouldAppendPoint(points, { x: 0, y: 3 }, 2)).toBe(true);
  });

  it('按欧氏距离算，不是按坐标轴分别算（否则斜线会被记成两倍密集）', () => {
    const points: Array<[number, number]> = [[0, 0]];
    // 位移 (1.5,1.5) 的欧氏距离 ≈ 2.12 ≥ 2：单看任一轴都不够，但整体够了
    expect(shouldAppendPoint(points, { x: 1.5, y: 1.5 }, 2)).toBe(true);
  });

  it('非有限值一律拒收（NaN 坐标会让包围盒、脏区全部失效）', () => {
    const points: Array<[number, number]> = [[0, 0]];
    expect(shouldAppendPoint(points, { x: Number.NaN, y: 0 }, 0)).toBe(false);
    expect(shouldAppendPoint(points, { x: 0, y: Number.POSITIVE_INFINITY }, 0)).toBe(false);
  });

  it('阈值 <= 0 时退化为"非重合就记"，负值按 0 处理而不是反过来拒收一切', () => {
    const points: Array<[number, number]> = [[0, 0]];
    expect(shouldAppendPoint(points, { x: 1, y: 1 }, 0)).toBe(true);
    expect(shouldAppendPoint(points, { x: 1, y: 1 }, -5)).toBe(true);
  });
});

describe('distanceToSegment', () => {
  it('垂足落在线段内 → 点到直线的距离', () => {
    expect(distanceToSegment({ x: 5, y: 5 }, [0, 0], [10, 0])).toBe(5);
    expect(distanceToSegment({ x: 5, y: 0 }, [0, 0], [10, 0])).toBe(0);
  });

  it('★ 垂足落在线段外 → 夹到端点（夹 projection 到 [0,1]），不是无限延长线', () => {
    expect(distanceToSegment({ x: 15, y: 0 }, [0, 0], [10, 0])).toBe(5);
    expect(distanceToSegment({ x: -5, y: 0 }, [0, 0], [10, 0])).toBe(5);
  });

  it('零长线段退化为点距（除零会被夹住，不能返回 NaN）', () => {
    expect(distanceToSegment({ x: 5, y: 0 }, [10, 10], [10, 10])).toBeCloseTo(Math.hypot(5, 10));
  });
});

describe('distanceToStroke', () => {
  it('空笔画 = 哪儿都不在（Infinity，便于取最小值时被忽略）', () => {
    expect(distanceToStroke([], { x: 0, y: 0 })).toBe(Number.POSITIVE_INFINITY);
  });

  it('单点笔画退化为点距（"点一下"也必须能被橡皮擦掉）', () => {
    expect(distanceToStroke([[0, 0]], { x: 3, y: 4 })).toBe(5);
  });

  it('多段取每一段的最小值，而不是只看首尾', () => {
    const polyline: Array<[number, number]> = [
      [0, 0],
      [10, 0],
      [10, 10],
    ];
    // 离第二段最近：垂足 (10,5)，点在 (7,5)
    expect(distanceToStroke(polyline, { x: 7, y: 5 })).toBe(3);
  });
});

describe('strokesHitByEraser', () => {
  it('返回的是**下标**而不是过滤后的数组（图层要靠它算脏区）', () => {
    const paths = [
      path([
        [0, 0],
        [10, 0],
      ]),
      path([
        [100, 100],
        [100, 200],
      ]),
    ];
    expect(strokesHitByEraser(paths, { x: 5, y: 0 }, 0)).toEqual([0]);
    expect(strokesHitByEraser(paths, { x: 100, y: 150 }, 0)).toEqual([1]);
    expect(strokesHitByEraser(paths, { x: 500, y: 500 }, 0)).toEqual([]);
  });

  it('多笔命中时下标保持升序（图层倒序 splice 依赖它）', () => {
    const paths = [
      path([
        [0, 0],
        [10, 0],
      ]),
      path([
        [0, 5],
        [10, 5],
      ]),
    ];
    expect(strokesHitByEraser(paths, { x: 5, y: 2.5 }, 1)).toEqual([0, 1]);
  });

  it('★ 判定阈值含半个笔宽：粗线本来就更好擦，不该要求用户瞄准中轴', () => {
    const wide = path(
      [
        [0, 0],
        [100, 0],
      ],
      20,
    );
    // 中轴外 10px 处：10 <= 0 + 20/2 → 命中
    expect(strokesHitByEraser([wide], { x: 50, y: 10 }, 0)).toEqual([0]);
    // 再多 0.5px 就擦不到（边界是精确的）
    expect(strokesHitByEraser([wide], { x: 50, y: 10.5 }, 0)).toEqual([]);
    // 半径补上这 0.5px 又够得着
    expect(strokesHitByEraser([wide], { x: 50, y: 10.5 }, 1)).toEqual([0]);
  });

  it('空笔画列表返回空（橡皮按在空画布上什么都不该发生）', () => {
    expect(strokesHitByEraser([], { x: 0, y: 0 }, 100)).toEqual([]);
  });
});

describe('strokeBounds', () => {
  it('包围盒含笔宽：线是画在坐标两侧的，不算进去会留下半截残影', () => {
    expect(
      strokeBounds(
        path(
          [
            [0, 0],
            [10, 20],
          ],
          4,
        ),
      ),
    ).toEqual({
      x: -2,
      y: -2,
      width: 14,
      height: 24,
    });
  });

  it('零宽笔画包围盒就是几何外框本身', () => {
    expect(
      strokeBounds(
        path(
          [
            [1, 2],
            [3, 4],
          ],
          0,
        ),
      ),
    ).toEqual({ x: 1, y: 2, width: 2, height: 2 });
  });

  it('空笔画返回 null（调用方据此跳过，而不是拿到一个 NaN 矩形）', () => {
    expect(strokeBounds(path([]))).toBeNull();
  });
});

describe('segmentDirtyRect', () => {
  it('★ 包含整段（上一个点 → 新点），不只是新点 —— 否则线尾会留在脏区外', () => {
    expect(segmentDirtyRect([0, 0], { x: 10, y: 0 }, 4)).toEqual({
      x: -2,
      y: -2,
      width: 14,
      height: 4,
    });
  });

  it('落笔的第一个点（from 为 null）给出笔宽见方的小矩形 —— 圆点也得被画上', () => {
    expect(segmentDirtyRect(null, { x: 5, y: 5 }, 4)).toEqual({
      x: 3,
      y: 3,
      width: 4,
      height: 4,
    });
  });

  it('负线宽按 0 处理（不缩成负矩形，那会让脏区整块失效）', () => {
    expect(segmentDirtyRect([0, 0], { x: 10, y: 0 }, -5)).toEqual({
      x: 0,
      y: 0,
      width: 10,
      height: 0,
    });
  });

  it('斜向移动的矩形能覆盖两个端点', () => {
    const rect = segmentDirtyRect([10, 10], { x: 0, y: 30 }, 2);
    expect(rect).toEqual({ x: -1, y: 9, width: 12, height: 22 });
  });
});

describe('笔的状态（T3.07 / `F4-02`）', () => {
  it('换色：新色上任，**被换下去的那支成为"上一支"**', () => {
    const state = defaultInkToolState();
    const next = withInkColor(state, '#1971c2');
    expect(next.color).toBe('#1971c2');
    expect(next.alternateColor).toBe(state.color);
    expect(next.widthIndex).toBe(state.widthIndex);
  });

  it('换成同一个颜色原样返回（引用相等，调用方据此跳过重画工具条）', () => {
    const state = defaultInkToolState();
    expect(withInkColor(state, state.color)).toBe(state);
  });

  it('★ `X` 按两下必须回到原色 —— 它是"来回来去"，不是"在调色板里转圈"', () => {
    const state = defaultInkToolState();
    const there = swapInkColors(state);
    const back = swapInkColors(there);
    expect(there.color).toBe(state.alternateColor);
    expect(back.color).toBe(state.color);
    expect(back.alternateColor).toBe(state.alternateColor);
  });

  it('★ 从调色板选色之后再按 `X`：回到"我刚才那个颜色"，而不是某个从没选过的色', () => {
    const state = defaultInkToolState();
    const picked = withInkColor(state, '#2f9e44');
    expect(swapInkColors(picked).color).toBe(state.color);
  });

  it('档位越界 / 非数字一律夹回合法范围，绝不产生 NaN 线宽', () => {
    expect(clampWidthIndex(-1)).toBe(0);
    expect(clampWidthIndex(99)).toBe(INK_BRUSH_WIDTHS.length - 1);
    expect(clampWidthIndex(1.6)).toBe(2);
    expect(clampWidthIndex(Number.NaN)).toBe(DEFAULT_INK_WIDTH_INDEX);
    expect(brushWidth(99)).toBe(INK_BRUSH_WIDTHS[INK_BRUSH_WIDTHS.length - 1]);
    expect(brushWidth(0)).toBe(INK_BRUSH_WIDTHS[0]);
  });

  it('inkStrokeStyle：把颜色与档位换成落笔要用的 { color, width }', () => {
    const state = withInkWidth(withInkColor(defaultInkToolState(), '#7048e8'), 3);
    expect(inkStrokeStyle(state)).toEqual({ color: '#7048e8', width: INK_BRUSH_WIDTHS[3] });
  });

  it('全都是纯函数：迁移不改原状态（调用方可能在别处还握着它）', () => {
    const state = defaultInkToolState();
    const snapshot = { ...state };
    withInkColor(state, '#2f9e44');
    swapInkColors(state);
    withInkWidth(state, 0);
    expect(state).toEqual(snapshot);
  });
});

describe('压感（T3.07 / `F4-02`）', () => {
  it('★ 没有压感就**不写**第三个元素（鼠标笔迹不该多出一个 0.5）', () => {
    expect(toInkPoint({ x: 1, y: 2 })).toEqual([1, 2]);
    expect(toInkPoint({ x: 1, y: 2 }, undefined)).toEqual([1, 2]);
    expect(toInkPoint({ x: 1, y: 2 }, Number.NaN)).toEqual([1, 2]);
  });

  it('有压感就记下来，并夹进 0..1（文件里不该出现 1.8 这种压力）', () => {
    expect(toInkPoint({ x: 1, y: 2 }, 0.62)).toEqual([1, 2, 0.62]);
    expect(toInkPoint({ x: 1, y: 2 }, 1.8)).toEqual([1, 2, 1]);
    expect(toInkPoint({ x: 1, y: 2 }, -3)).toEqual([1, 2, 0]);
  });

  it('createStroke 支持压感：**第一点**就带上它，否则起笔那一下总是满宽', () => {
    const stroke = createStroke({ x: 0, y: 0 }, { color: '#000000', width: 10 }, 0.4);
    expect(stroke.points).toEqual([[0, 0, 0.4]]);
  });

  it('pressureOf：缺省 1 ——"这个设备不报压感"就等于"一直用满力"', () => {
    expect(pressureOf([0, 0])).toBe(1);
    expect(pressureOf([0, 0, Number.NaN])).toBe(1);
  });

  it('★ pressureOf 有下限：轻按画出的是**细线**，不是一片什么都没有', () => {
    expect(pressureOf([0, 0, 0])).toBe(INK_PRESSURE_MIN);
    expect(pressureOf([0, 0, -1])).toBe(INK_PRESSURE_MIN);
    expect(pressureOf([0, 0, 0.01])).toBe(INK_PRESSURE_MIN);
    expect(pressureOf([0, 0, 0.8])).toBe(0.8);
    expect(pressureOf([0, 0, 2])).toBe(1);
  });

  it('isTapered：只要有一个点记过压感就算带压感（渲染层据此决定要不要逐段描边）', () => {
    expect(
      isTapered(
        path([
          [0, 0],
          [1, 1],
        ]),
      ),
    ).toBe(false);
    expect(
      isTapered(
        path([
          [0, 0],
          [1, 1, 0.5],
        ]),
      ),
    ).toBe(true);
  });

  it('strokeWidthAt：实际线宽 = 基准线宽 × 压感', () => {
    const stroke = path(
      [
        [0, 0, 1],
        [5, 0, 0.5],
      ],
      10,
    );
    expect(strokeWidthAt(stroke, 0)).toBe(10);
    expect(strokeWidthAt(stroke, 1)).toBeCloseTo(5);
  });

  it('strokeWidthAt：没记压感的点按满力算；下标越界回落到基准线宽而不是 NaN', () => {
    const stroke = path([[0, 0]], 6);
    expect(strokeWidthAt(stroke, 0)).toBe(6);
    expect(strokeWidthAt(stroke, 7)).toBe(6);
  });

  it('★ segmentWidthAt 取两端**平均**：取其一端会让相邻两段在同一根点上突变（像打了个结）', () => {
    const stroke = path(
      [
        [0, 0, 1],
        [5, 0, 0.5],
      ],
      10,
    );
    expect(segmentWidthAt(stroke, 1)).toBeCloseTo(7.5);
    // 第 0 段不存在（没有前一个点），退化成第 0 个点的线宽
    expect(segmentWidthAt(stroke, 0)).toBe(10);
  });

  it('压感只影响"多粗"，不影响"多长"：点坐标原样保留', () => {
    const stroke = path(
      [
        [3, 4, 0.2],
        [30, 40, 0.9],
      ],
      10,
    );
    expect(stroke.points[0][0]).toBe(3);
    expect(stroke.points[1][1]).toBe(40);
  });
});

describe('strokesBounds / toStrokeSpace（T3.08 / `F4-04`）', () => {
  it('一笔都没有返回 null（调用方据此判断"没有内容"，而不是拿到一个 NaN 矩形）', () => {
    expect(strokesBounds([])).toBeNull();
    expect(strokesBounds([path([])])).toBeNull();
  });

  it('多笔合成一个总包围盒，只外扩一次、按最粗的那半笔宽撑', () => {
    const paths = [
      path(
        [
          [0, 0],
          [10, 0],
        ],
        4,
      ),
      path(
        [
          [100, 50],
          [100, 90],
        ],
        10,
      ),
    ];
    // 点集 x∈[0,100]、y∈[0,90]；外扩 = max(4,10)/2 = 5
    expect(strokesBounds(paths)).toEqual({ x: -5, y: -5, width: 110, height: 100 });
  });

  it('★ 单笔时与 `strokeBounds` 完全一致（手绘卡总是一笔一张，这两个必须同源）', () => {
    const stroke = path(
      [
        [3, 7],
        [30, 40],
      ],
      6,
    );
    expect(strokesBounds([stroke])).toEqual(strokeBounds(stroke));
  });

  it('toStrokeSpace：世界坐标减原点 = 卡片内坐标（"落盘"与"命中"共用的那一份换算）', () => {
    expect(toStrokeSpace({ x: 30, y: 45 }, { x: 10, y: 5 })).toEqual({ x: 20, y: 40 });
    // 原点就是自己时结果为零向量（不做任何特判，减法天然成立）
    expect(toStrokeSpace({ x: 8, y: 9 }, { x: 8, y: 9 })).toEqual({ x: 0, y: 0 });
  });
});

// ── 荧光笔（T7.08 / `F4-07`）────────────────────────────

describe('荧光笔', () => {
  it('marker 的样式 = 同色 + 加粗 `INK_MARKER_WIDTH_SCALE` 倍 + 半透明', () => {
    const state = withInkWidth(defaultInkToolState(), 1);

    expect(inkStrokeStyle(state, 'marker')).toEqual({
      color: state.color,
      width: brushWidth(1) * INK_MARKER_WIDTH_SCALE,
      alpha: INK_MARKER_ALPHA,
    });
  });

  it('★ 不传 `tool` 拿到的仍是那支"与 T7.07 之前逐字段相同"的画笔', () => {
    const state = defaultInkToolState();

    expect(inkStrokeStyle(state)).toEqual(inkStrokeStyle(state, 'brush'));
    expect(inkStrokeStyle(state).alpha).toBeUndefined();
  });
});

// ── 不透明度（T7.08 / `F4-07`）──────────────────────────

describe('不透明度', () => {
  it('缺省 = 1：老笔迹一个字节都不用多，读回来就是"不透明"', () => {
    expect(strokeAlpha(path([[0, 0]]))).toBe(1);
    expect(isTranslucent(path([[0, 0]]))).toBe(false);
    expect(styleAlpha({ color: '#000000', width: 3 })).toBe(1);
  });

  it('写进去的半透明值原样读回来', () => {
    const stroke: InkPath = { color: '#000000', width: 3, points: [[0, 0]], alpha: 0.35 };

    expect(strokeAlpha(stroke)).toBe(0.35);
    expect(isTranslucent(stroke)).toBe(true);
  });

  it('★ `0` / 非正 / 非有限一律当缺省：`globalAlpha: 0` 是一支画不出东西又不报错的笔', () => {
    for (const alpha of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(strokeAlpha({ color: '#000000', width: 3, points: [], alpha })).toBe(1);
      expect(styleAlpha({ color: '#000000', width: 3, alpha })).toBe(1);
    }
  });

  it('大于 1 夹到 1（手改文件写出 `alpha: 2` 时 Canvas 会直接抛）', () => {
    expect(strokeAlpha({ color: '#000000', width: 3, points: [], alpha: 2 })).toBe(1);
  });

  it('`createStroke`：只有确实半透明才写键（`alpha: 1` 与"没有 alpha"是同一件事）', () => {
    const solid = createStroke({ x: 0, y: 0 }, { color: '#000000', width: 3, alpha: 1 });
    const translucent = createStroke({ x: 0, y: 0 }, { color: '#000000', width: 3, alpha: 0.5 });

    expect('alpha' in solid).toBe(false);
    expect(translucent.alpha).toBe(0.5);
  });

  it('★ 半透明笔**不记压感**：整条路径一次描边，接缝处就不会叠成深浅斑', () => {
    const marker = createStroke(
      { x: 1, y: 2 },
      inkStrokeStyle(defaultInkToolState(), 'marker'),
      0.2,
    );

    expect(marker.points).toEqual([[1, 2]]);
    expect(isTapered(marker)).toBe(false);
  });

  it('★ 不透明笔照旧记压感 —— 压感是画笔的手感，不该被这次改动顺手带走', () => {
    const brush = createStroke({ x: 1, y: 2 }, inkStrokeStyle(defaultInkToolState(), 'brush'), 0.2);

    expect(brush.points).toEqual([[1, 2, 0.2]]);
    expect(isTapered(brush)).toBe(true);
  });
});

// ── 临时标注层（T7.07 / `F4-06`）────────────────────────

describe('临时层的数组语义', () => {
  it('appendStroke 返回**新数组**，原数组不动（脏区是按旧内容算的，"内容"不能偷偷跟着变）', () => {
    const before: InkPath[] = [path([[0, 0]])];
    const after = appendStroke(before, path([[9, 9]]));

    expect(after).not.toBe(before);
    expect(before).toHaveLength(1);
    expect(after).toHaveLength(2);
  });

  it('removeStrokes 按**下标**整笔删，且顺序与传入无关', () => {
    const paths = [path([[0, 0]]), path([[1, 1]]), path([[2, 2]])];

    expect(removeStrokes(paths, [0, 2])).toEqual([paths[1]]);
    expect(removeStrokes(paths, [2, 0])).toEqual([paths[1]]);
  });

  it('★ 没命中时返回**原引用**：绝大多数 `pointermove` 都什么都没碰到，不该白重建数组', () => {
    const paths = [path([[0, 0]])];

    expect(removeStrokes(paths, [])).toBe(paths);
  });

  it('删光时得到空数组（而不是 `null` / `undefined`）', () => {
    const paths = [path([[0, 0]])];

    expect(removeStrokes(paths, [0])).toEqual([]);
  });
});
