/**
 * 大纲里拖拽调整结构（`N3-d`）的**纯逻辑**：落点三档 + 落点计划。
 *
 * 这一层刻意与 DOM 分开（`outline.ts` 上半是一份不碰 DOM 的纯逻辑）：
 * "拖到哪儿会变成什么"是**规则**，值得单测钉住 —— 其中两条是踩过的坑：
 * 1. 目标是**自己的后代**时必须落不下去（否则成环）；
 * 2. 算"插到第几个孩子"要**先把被拖的那一支从兄弟里剔掉**再数
 *    （`ops.moveNode` 内部就是这么算的；不剔的话"往后挪一位"会算成两位）。
 */

import { describe, expect, it } from 'vitest';
import { createMindFile, createMindNode } from '../../mind/model/factories';
import type { MindFile } from '../../mind/model/schema';
import {
  outlineDragIsText,
  outlineDropPlanOf,
  outlineDropZoneOf,
  outlineIdsInBox,
} from '../../mind/view/outline';

// ─────────────────────────────────────────────────────────────
// 框选 vs 选字：方向定生死（`N3-h`）
// ─────────────────────────────────────────────────────────────

describe('框选与选字怎么分（`N3-h`）', () => {
  it('★ 起手在文字列上：横着拖 = 选字，竖着拖 = 框选', () => {
    expect(outlineDragIsText(40, 3, true)).toBe(true); // 横 ⇒ 选字
    expect(outlineDragIsText(3, 40, true)).toBe(false); // 竖 ⇒ 框选
    expect(outlineDragIsText(30, 40, true)).toBe(false); // 斜着往下 ⇒ 框选（"框下面几行"的手势）
    expect(outlineDragIsText(40, 30, true)).toBe(true); // 斜着往上 ⇒ 选字
  });

  it('★ 起手不在文字列上（竖线格 / 行尾空白 / 面板空白）⇒ 一律框选，不看方向', () => {
    expect(outlineDragIsText(40, 3, false)).toBe(false);
    expect(outlineDragIsText(3, 40, false)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────
// 框选（`N3-h`）：一个矩形框住了哪些行
// ─────────────────────────────────────────────────────────────

describe('大纲框选：矩形框住了哪些行（`N3-h`）', () => {
  /** 三行，每行 24 高、从 y=0 起排（x 都从 0 开始，宽 300） */
  const rows = [
    { id: 'a', rect: { x: 0, y: 0, width: 300, height: 24 } },
    { id: 'b', rect: { x: 0, y: 24, width: 300, height: 24 } },
    { id: 'c', rect: { x: 0, y: 48, width: 300, height: 24 } },
  ];

  it('★ 相交就算选中（从行中间划过去也要选上它，与画布框选同一条）', () => {
    expect(outlineIdsInBox(rows, { x: 0, y: 20, width: 10, height: 8 })).toEqual(['a', 'b']);
  });

  it('★ 顺序照传进来的顺序（= 面板里的可见顺序）⇒ 复制出来的次序与眼睛看到的一致', () => {
    expect(outlineIdsInBox(rows, { x: 0, y: 0, width: 10, height: 200 })).toEqual(['a', 'b', 'c']);
  });

  it('框在空白处 ⇒ 一个都不选（不是"最近的"）', () => {
    expect(outlineIdsInBox(rows, { x: 500, y: 0, width: 10, height: 10 })).toEqual([]);
    expect(outlineIdsInBox(rows, { x: 0, y: 200, width: 10, height: 10 })).toEqual([]);
  });

  it('只框住一行也行（起点与终点都在同一行里）', () => {
    expect(outlineIdsInBox(rows, { x: 0, y: 26, width: 4, height: 4 })).toEqual(['b']);
  });
});

/**
 * 夹具（一棵两层的树，与"大纲里看得到的行"同序）：
 *
 * ```
 * 中心
 * ├── A ── A1 / A2
 * ├── B
 * └── C
 * ```
 * 行（前序，根不是行）：`A, A1, A2, B, C`
 */
function fixture(): MindFile {
  const shape: readonly (readonly [string, string | null])[] = [
    ['中心', null],
    ['A', '中心'],
    ['A1', 'A'],
    ['A2', 'A'],
    ['B', '中心'],
    ['C', '中心'],
  ];
  const file = createMindFile({ title: 'T', now: () => 'T' });
  file.nodes = shape.map(([text, parentText], index) =>
    createMindNode({
      id: `n_${text}`,
      text,
      note: '',
      parentId: parentText === null ? null : `n_${parentText}`,
      order: index,
    }),
  );
  file.rootId = 'n_中心';
  return file;
}

const n = (name: string): string => `n_${name}`;

describe('落点三档（`N3-d`）', () => {
  it('上 28% = 前、中间 = 子节点、下 28% = 后', () => {
    expect(outlineDropZoneOf(100, 40, 102)).toBe('before'); // 0.05
    expect(outlineDropZoneOf(100, 40, 111)).toBe('before'); // 0.275
    expect(outlineDropZoneOf(100, 40, 120)).toBe('child'); // 0.5
    expect(outlineDropZoneOf(100, 40, 128)).toBe('child'); // 0.7
    expect(outlineDropZoneOf(100, 40, 130)).toBe('after'); // 0.75
    expect(outlineDropZoneOf(100, 40, 139)).toBe('after'); // 0.975
  });

  it('行高量到 0（还没布局出来）时给中间那一档，不抛', () => {
    expect(outlineDropZoneOf(0, 0, 50)).toBe('child');
  });
});

describe('落点计划（`N3-d`：这一拖会改成什么）', () => {
  it('`child` ⇒ 挂到那一行下面（追加到末尾）', () => {
    expect(outlineDropPlanOf(fixture(), n('B'), n('A'), 'child')).toEqual({ parentId: n('A') });
  });

  it('`before` / `after` ⇒ 与那一行**同级**，插在它前 / 后', () => {
    const mind = fixture();
    expect(outlineDropPlanOf(mind, n('B'), n('A1'), 'before')).toEqual({
      parentId: n('A'),
      index: 0,
    });
    expect(outlineDropPlanOf(mind, n('B'), n('A1'), 'after')).toEqual({
      parentId: n('A'),
      index: 1,
    });
  });

  it('`before` 最外层的那一行 ⇒ 插到根的第一位', () => {
    expect(outlineDropPlanOf(fixture(), n('B'), n('A'), 'before')).toEqual({
      parentId: n('中心'),
      index: 0,
    });
  });

  it('★ 目标是自己的**后代** ⇒ 落不下去（否则会成环）', () => {
    const mind = fixture();
    expect(outlineDropPlanOf(mind, n('A'), n('A1'), 'child')).toBeNull();
    expect(outlineDropPlanOf(mind, n('A'), n('A1'), 'after')).toBeNull();
    expect(outlineDropPlanOf(mind, n('A'), n('A2'), 'before')).toBeNull();
  });

  it('★ 目标是**自己** ⇒ 落不下去', () => {
    expect(outlineDropPlanOf(fixture(), n('A'), n('A'), 'child')).toBeNull();
  });

  it('★ 拖的是**根** ⇒ 落不下去（根不是一行，这里再兜一道）', () => {
    expect(outlineDropPlanOf(fixture(), n('中心'), n('A'), 'child')).toBeNull();
  });

  it('id 不在（刚被删）⇒ 落不下去', () => {
    const mind = fixture();
    expect(outlineDropPlanOf(mind, n('幽灵'), n('A'), 'child')).toBeNull();
    expect(outlineDropPlanOf(mind, n('A'), n('幽灵'), 'child')).toBeNull();
  });

  it('★★ 序号要**扣掉被拖的那一支**：A 拖到 C 之后 ⇒ 根的第 2 位（不是第 3 位）', () => {
    // 根的孩子：A / B / C ⇒ 剔掉 A 之后是 [B, C] ⇒ C 在第 1 位 ⇒ `after` = 第 2 位。
    // 不剔的话会算成第 3 位（= 追加到末尾）—— 表现是"往后拖一格，它跑到了最后"
    expect(outlineDropPlanOf(fixture(), n('A'), n('C'), 'after')).toEqual({
      parentId: n('中心'),
      index: 2,
    });
  });

  it('同一支里换序：A2 拖到 A1 之前 ⇒ 第 0 位', () => {
    expect(outlineDropPlanOf(fixture(), n('A2'), n('A1'), 'before')).toEqual({
      parentId: n('A'),
      index: 0,
    });
  });

  it('同一支里往下挪：A1 拖到 A2 之后 ⇒ 第 1 位（剔掉自己之后只剩 A2 一个）', () => {
    expect(outlineDropPlanOf(fixture(), n('A1'), n('A2'), 'after')).toEqual({
      parentId: n('A'),
      index: 1,
    });
  });
});
