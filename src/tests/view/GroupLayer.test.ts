/**
 * 编组框几何单元测试（O03）。
 *
 * 只钉 `groupFrameOf` 这条纯计算 —— 它是"框该画在哪"的**唯一**来源，
 * 而框与卡片错开半个像素是那种"看着别扭、又说不出哪不对"的缺陷，
 * 靠肉眼比是比不出来的。DOM 部分（标签条的挂载 / 收起开关）跑在 Obsidian 里。
 *
 * 测试文件跑在 node 环境，因此这里只 import 纯函数 ——
 * 只要 `GroupLayer.ts` 顶层不碰 `document`，导入就是安全的（`mount` 里的
 * `document.createElement` 只在实际调用时才碰）。
 */

import { describe, expect, it } from 'vitest';
import type { Group } from '../../model/schema';
import { GROUP_CHIP_BAND, GROUP_FRAME_PADDING, groupFrameOf } from '../../view/render/GroupLayer';
import type { Rect } from '../../util/geometry';

/** 一张卡的矩形（只需要位置和尺寸，编组框不看别的） */
function rect(x: number, y: number, width = 100, height = 100): Rect {
  return { x, y, width, height };
}

function group(cardIds: string[], collapsed?: boolean): Group {
  return collapsed === undefined
    ? { id: 'g1', cardIds, label: '' }
    : { id: 'g1', cardIds, label: '', collapsed };
}

/** id → 矩形 的查表函数（缺的返回 null，与视图里的实现一致） */
function lookup(table: Record<string, Rect>) {
  return (cardId: string): Rect | null => table[cardId] ?? null;
}

describe('groupFrameOf（O03）', () => {
  it('外框 = 成员包围盒 + 四周留白 + 顶部标签带宽', () => {
    const frame = groupFrameOf(group(['a', 'b']), lookup({ a: rect(100, 200), b: rect(300, 260) }));
    expect(frame).toEqual({
      x: 100 - GROUP_FRAME_PADDING,
      y: 200 - GROUP_FRAME_PADDING - GROUP_CHIP_BAND,
      width: 300 + GROUP_FRAME_PADDING * 2,
      height: 160 + GROUP_FRAME_PADDING * 2 + GROUP_CHIP_BAND,
    });
  });

  it('成员顺序不影响结果', () => {
    const table = { a: rect(0, 0), b: rect(500, 500), c: rect(200, 200) };
    expect(groupFrameOf(group(['a', 'b', 'c']), lookup(table))).toEqual(
      groupFrameOf(group(['c', 'b', 'a']), lookup(table)),
    );
  });

  it('★ 收起态返回**同一个框**：标签条要停在原地，收起不能让它跳一下', () => {
    const table = { a: rect(10, 20), b: rect(200, 300) };
    expect(groupFrameOf(group(['a', 'b'], true), lookup(table))).toEqual(
      groupFrameOf(group(['a', 'b']), lookup(table)),
    );
  });

  it('找不到的成员跳过；一个都找不到 → null（不画零尺寸的框在原点）', () => {
    const frame = groupFrameOf(group(['a', 'ghost']), lookup({ a: rect(50, 60) }));
    expect(frame?.x).toBe(50 - GROUP_FRAME_PADDING);
    expect(groupFrameOf(group(['ghost']), lookup({}))).toBeNull();
    expect(groupFrameOf(group([]), lookup({}))).toBeNull();
  });

  it('单成员组也能算出框（组本身由 `MIN_GROUP_SIZE` 兜着，这里不管合法性）', () => {
    expect(groupFrameOf(group(['a']), lookup({ a: rect(0, 0) }))?.width).toBe(
      100 + GROUP_FRAME_PADDING * 2,
    );
  });
});
