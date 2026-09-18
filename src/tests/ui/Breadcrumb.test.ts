/**
 * 面包屑单元测试（T1.62 / `F2-8-4`、`F2-8-5`）。
 *
 * 只测纯函数（`buildTrail` / `layoutTrail`）：DOM 部分跑在 node 环境下没有真实文档，
 * 而这两个函数恰好是"错了会很难受"的地方 ——
 *   1. **当前层不可点**：点了会重新打开同一块白板（白闪一屏，用户以为卡了）；
 *   2. **折叠后仍能往回走**：`…` 必须指向被折掉的**最靠前**那一层。
 *
 * `Breadcrumb` 类本身在 `src/ui/Breadcrumb.ts` 顶部不碰 `document`（用 `parent.ownerDocument`），
 * 所以这里 import 它是安全的 —— 与 `View` 层测试同一套约定。
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_TRAIL_NODES,
  buildTrail,
  layoutTrail,
  type BreadcrumbItem,
  type TrailNode,
} from '../../ui/Breadcrumb';

function node(path: string, title = path): TrailNode {
  return { path, title };
}

describe('buildTrail', () => {
  it('空链路只留下 Home（位置指示，不可点）', () => {
    expect(buildTrail('主页', [])).toEqual([{ label: '主页', path: null }]);
  });

  it('单层：只有当前白板 → 一项，且**不可点**', () => {
    expect(buildTrail('主页', [node('Boards/Home.nboard', 'Home')])).toEqual([
      { label: '主页', path: null },
      { label: 'Home', path: null },
    ]);
  });

  it('多层：中间层可点，最后一层是当前位置', () => {
    const trail = buildTrail('主页', [
      node('Boards/Home.nboard', 'Home'),
      node('Boards/需求.nboard', '需求'),
      node('Boards/需求-设计.nboard', '设计'),
    ]);
    expect(trail).toEqual([
      { label: '主页', path: null },
      { label: 'Home', path: 'Boards/Home.nboard' },
      { label: '需求', path: 'Boards/需求.nboard' },
      { label: '设计', path: null },
    ]);
  });

  it('跳过空 path 的脏项（`meta.parent` 是可以被手改的）', () => {
    const trail = buildTrail('主页', [node(''), node('Boards/A.nboard', 'A')]);
    expect(trail).toEqual([
      { label: '主页', path: null },
      { label: 'A', path: null },
    ]);
  });

  it('不改动入参', () => {
    const chain = [node('a.nboard'), node('b.nboard')];
    buildTrail('主页', chain);
    expect(chain.map((entry) => entry.path)).toEqual(['a.nboard', 'b.nboard']);
  });
});

describe('layoutTrail', () => {
  function items(count: number): BreadcrumbItem[] {
    return [
      { label: '主页', path: null },
      ...Array.from({ length: count }, (_, index) => ({
        label: `L${index + 1}`,
        // 最后一项 = 当前白板
        path: index === count - 1 ? null : `L${index + 1}.nboard`,
      })),
    ];
  }

  it('不超过上限时不折叠', () => {
    const layout = layoutTrail(items(MAX_TRAIL_NODES));
    expect(layout.collapsed).toEqual([]);
    expect(layout.visible).toHaveLength(MAX_TRAIL_NODES);
  });

  it('超过上限时折掉**最靠前**的几层，保留最后三项', () => {
    const layout = layoutTrail(items(6));
    expect(layout.collapsed.map((entry) => entry.label)).toEqual(['L1', 'L2', 'L3']);
    expect(layout.visible.map((entry) => entry.label)).toEqual(['L4', 'L5', 'L6']);
  });

  it('折叠后 `…` 的目标（被折项里第一个可点的）是往回走最近的一跳', () => {
    const layout = layoutTrail(items(6));
    expect(layout.collapsed[0].path).toBe('L1.nboard');
  });

  it('当前层永远留在可见部分里（路径为 null 的那一项）', () => {
    const layout = layoutTrail(items(5));
    expect(layout.visible.at(-1)?.path).toBeNull();
  });

  it('Home 始终保留', () => {
    expect(layoutTrail(items(9)).home.label).toBe('主页');
    expect(layoutTrail([]).home).toEqual({ label: '', path: null });
  });
});
