/**
 * 脑图缩略图的格子清单（`P2-c` / `F1-06`，`mind/view/minimapShapes.ts`）。
 *
 * 这一层是"地图上到底画了哪几格"的判据：几何映射那半边由白板的老用例钉着
 * （`ui/minimapGeometry.ts` 自带单测），这里只钉**脑图这一侧的三条口径** ——
 * 可见节点才画、悬浮节点单独一档、格子必须是死快照。
 */

import { describe, expect, it } from 'vitest';
import type { NodeBox } from '../../mind/layout/tree';
import type { MindLayout } from '../../mind/layout/tree';
import { mindMinimapShapes } from '../../mind/view/minimapShapes';
import { boxOf, mindWith } from '../helpers/mindFixtures';

/** 一份最小布局（用例只关心 `boxes`；`bounds` / `hiddenCount` 由布局器给，这里用不到） */
const layoutOf = (...boxes: NodeBox[]): MindLayout => ({
  boxes: new Map(boxes.map((box) => [box.id, box])),
  bounds: null,
  hiddenCount: 0,
});

describe('mindMinimapShapes · 脑图缩略图的格子', () => {
  it('没有模型 / 还没有布局 ⇒ 空清单（地图不画空盒子）', () => {
    expect(mindMinimapShapes(null, null)).toEqual([]);
    expect(mindMinimapShapes(mindWith([['中心', null]]), null)).toEqual([]);
  });

  it('每个可见节点一格，几何照抄布局盒', () => {
    const mind = mindWith([
      ['中心', null],
      ['甲', '中心'],
    ]);
    const shapes = mindMinimapShapes(
      mind,
      layoutOf(
        boxOf('n_中心', 10, 20, { width: 120, height: 40, depth: 0 }),
        boxOf('n_甲', 200, 20, { width: 80, height: 30 }),
      ),
    );

    expect(shapes).toEqual([
      { kind: 'node', rect: { x: 10, y: 20, width: 120, height: 40 } },
      { kind: 'node', rect: { x: 200, y: 20, width: 80, height: 30 } },
    ]);
  });

  it('★ 中心主题不算"悬浮"：深度 0 里除了它，其余都是 `free`', () => {
    const mind = mindWith([['中心', null]]);
    const shapes = mindMinimapShapes(
      mind,
      layoutOf(
        boxOf('n_中心', 0, 0, { depth: 0 }),
        boxOf('n_飘', 500, 500, { depth: 0 }),
        boxOf('n_甲', 120, 0, { depth: 1 }),
      ),
    );

    // 地图上要能一眼分出"树"与"飘在外面的那些"（颜色由样式表按这个类名给）
    expect(shapes.map((shape) => shape.kind)).toEqual(['node', 'free', 'node']);
  });

  it('★ 格子是**死快照**：布局盒随后被布局器覆写，已算出来的清单不受影响', () => {
    const mind = mindWith([['中心', null]]);
    const box = boxOf('n_中心', 0, 0);
    const shapes = mindMinimapShapes(mind, layoutOf(box));

    box.width = 999;
    expect(shapes[0]?.rect.width).toBe(100);
  });
});
