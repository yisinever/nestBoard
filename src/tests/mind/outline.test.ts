/**
 * 大纲视图（`N3-a`）：**行模型**（`outlineRowsOf`）与 `view.outline` 的读写。
 *
 * 两条要钉住的边界（`09 §3`）：
 * 1. **只走主树** —— 悬浮节点不出现；
 * 2. **折叠的行还在、它的子孙不在**（行尾报"这一支一共几个节点"）。
 */

import { describe, expect, it } from 'vitest';
import { createMindFile, createMindNode } from '../../mind/model/factories';
import type { MindFile } from '../../mind/model/schema';
import { normalizeMindFile } from '../../mind/model/validate';
import { outlinePathOf, outlineRowsOf, outlineTitleOf } from '../../mind/view/outline';

/** 造一份脑图：`[标题, 正文, 父标题 | null]` */
function mindOf(shape: readonly (readonly [string, string, string | null])[]): MindFile {
  const file = createMindFile({ title: 'T', now: () => 'T' });
  file.nodes = shape.map(([text, note, parentText], index) =>
    createMindNode({
      id: `n_${text}`,
      text,
      note,
      parentId: parentText === null ? null : `n_${parentText}`,
      order: index,
    }),
  );
  file.rootId = `n_${shape[0]?.[0] ?? ''}`;
  return file;
}

describe('大纲的行（`N3-a`）', () => {
  it('★ 主树前序：根在最前，孩子紧跟其后，越深越往后', () => {
    const rows = outlineRowsOf(
      mindOf([
        ['中心', '', null],
        ['甲', '', '中心'],
        ['甲1', '', '甲'],
        ['乙', '', '中心'],
      ]),
    );

    // ★ 根**不在行里**：它是顶上那一行标题（`outlineTitleOf`）
    expect(rows.map((row) => row.text)).toEqual(['甲', '甲1', '乙']);
    expect(rows.map((row) => row.depth)).toEqual([0, 1, 0]);
  });

  it('★ 根不进列表，而是**标题**，且它拿的是根节点的文字（用户 2026-09-17 第①条）', () => {
    const file = mindOf([
      ['中心', '', null],
      ['甲', '', '中心'],
    ]);

    expect(outlineTitleOf(file)).toBe('中心');
    // 根没有行 ⇒ "只有子节点才有展开 / 收起"自动成立，也"无法直接改根节点"
    expect(outlineRowsOf(file).map((row) => row.text)).toEqual(['甲']);
  });

  it('★ 悬浮节点**不出现**（用户明确"大纲里只编辑主树"）', () => {
    const file = mindOf([
      ['中心', '', null],
      ['甲', '', '中心'],
    ]);
    file.nodes.push(
      createMindNode({ id: 'n_自由', text: '自由主题', note: '', parentId: null, order: 9 }),
    );

    expect(outlineRowsOf(file).map((row) => row.text)).toEqual(['甲']);
  });

  it('★ 折叠的那一行**留着**、子孙不出现，行尾报"这一支几个节点"', () => {
    const file = mindOf([
      ['中心', '', null],
      ['甲', '', '中心'],
      ['甲1', '', '甲'],
    ]);
    const jia = file.nodes.find((node) => node.text === '甲');
    if (jia) jia.collapsed = true;

    const rows = outlineRowsOf(file);
    expect(rows.map((row) => row.text)).toEqual(['甲']);
    expect(rows[0].collapsed).toBe(true);
    expect(rows[0].childCount).toBe(1);
    // ★ 与导图手柄**同一个数**：这一支一共几个（自己 + 子孙）
    expect(rows[0].subtreeSize).toBe(2);

    // 展开就回来（折叠只是"这一眼怎么看"，模型一个字节都没改）
    if (jia) delete jia.collapsed;
    expect(outlineRowsOf(file).map((row) => row.text)).toEqual(['甲', '甲1']);
  });

  it('没孩子的行 `childCount` / `subtreeSize` 都是 0（那种行不画折叠手柄）', () => {
    const rows = outlineRowsOf(
      mindOf([
        ['中心', '', null],
        ['甲', '', '中心'],
      ]),
    );

    expect(rows[0].childCount).toBe(0);
    expect(rows[0].subtreeSize).toBe(0);
  });

  it('兄弟按 `order` 排（与导图里的次序一致）', () => {
    const file = mindOf([
      ['中心', '', null],
      ['甲', '', '中心'],
      ['乙', '', '中心'],
    ]);
    const jia = file.nodes.find((node) => node.text === '甲');
    if (jia) jia.order = 5;

    expect(outlineRowsOf(file).map((row) => row.text)).toEqual(['乙', '甲']);
  });

  it('★ 格式只认**显式设过**的（这个视图的正文是常规字重，不按层级加粗）', () => {
    const file = mindOf([
      ['中心', '', null],
      ['甲', '', '中心'],
      ['乙', '', '中心'],
    ]);
    const yi = file.nodes.find((node) => node.text === '乙');
    if (yi) yi.style = { italic: true, ink: '#ff0000' };

    const rows = outlineRowsOf(file);
    expect(rows[0].bold).toBe(false);
    // ★ 没设过就是 `null`：大纲里没有标题底色那块，缺省该用主题正文色
    //   （搬画布那套"按底色算对比度"会在浅色主题下得到一片看不清的字）
    expect(rows[0].ink).toBeNull();
    expect(rows[1].italic).toBe(true);
    expect(rows[1].ink).toBe('#ff0000');
  });

  it('正文预览去掉首尾空白（换行交给 CSS 的省略号收）', () => {
    const rows = outlineRowsOf(
      mindOf([
        ['中心', '', null],
        ['甲', '  第一行\n第二行  ', '中心'],
      ]),
    );

    expect(rows[0].note).toBe('第一行\n第二行');
  });

  it('根不在了 ⇒ 空数组（不猜、也不拿第一个节点冒充根）', () => {
    const file = mindOf([['中心', '', null]]);
    file.rootId = 'n_幽灵';

    expect(outlineRowsOf(file)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
// `view.outline` 的读写
// ─────────────────────────────────────────────────────────────

describe('view.outline 的读写（`N3-a`）', () => {
  const fileWith = (view: Record<string, unknown>) =>
    normalizeMindFile({
      version: 1,
      revision: 0,
      meta: { id: 'nm_1', title: 'T' },
      view: { x: 0, y: 0, zoom: 1, background: 'dots', ...view },
      rootId: 'n_root',
      nodes: [{ id: 'n_root', text: '中心', note: '', parentId: null, order: 0 }],
    });

  it('★ `true` / `false` 都**照原样留着**（`false` 是"用户明确切回了树"）', () => {
    const on = fileWith({ outline: true });
    expect(on.ok && on.file.view.outline).toBe(true);

    const off = fileWith({ outline: false });
    expect(off.ok && off.file.view.outline).toBe(false);
    // ★ 留着才谈得上"读一遍写回去逐字节不变"
    expect(off.ok && 'outline' in off.file.view).toBe(true);
  });

  it('没有这个键 ⇒ **不补**（缺席 = 树视图；纪律 2）', () => {
    const result = fileWith({});

    expect(result.ok).toBe(true);
    if (result.ok) expect('outline' in result.file.view).toBe(false);
  });

  it('坏值丢掉并留痕（不整份判失败）', () => {
    const result = fileWith({ outline: 'yes' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect('outline' in result.file.view).toBe(false);
      expect(result.issues.some((issue) => issue.path === 'view.outline')).toBe(true);
    }
  });

  it('幂等：读两遍零 issue', () => {
    const first = fileWith({ outline: true });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = normalizeMindFile(JSON.parse(JSON.stringify(first.file)) as unknown);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.issues).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
// 聚焦（`N3-e`）：行 / 标题 / 面包屑
// ─────────────────────────────────────────────────────────────

describe('完成 / 激活（`N3-g`）', () => {
  it('★ 自己完成 ⇒ `done`；它下面整支 ⇒ `dimmed`（子孙那一位并没有被标）', () => {
    const file = mindOf([
      ['中心', '', null],
      ['甲', '', '中心'],
      ['甲1', '', '甲'],
      ['乙', '', '中心'],
    ]);
    const jia = file.nodes.find((node) => node.id === 'n_甲');
    if (jia) jia.done = true;

    expect(outlineRowsOf(file).map((row) => [row.text, row.done, row.dimmed] as const)).toEqual([
      // 自己完成：`done`，但**不额外变淡** —— 它已经有删除线 + 灰，再压一层就分不出来了
      ['甲', true, false],
      // 子孙：自己没被标过，只是"看起来属于那一支"
      ['甲1', false, true],
      // 别的支不受影响
      ['乙', false, false],
    ]);
  });

  it('取消完成之后，子孙里本来完成过的那些**一位都不丢**（因为压根没改过它们）', () => {
    const file = mindOf([
      ['中心', '', null],
      ['甲', '', '中心'],
      ['甲1', '', '甲'],
    ]);
    const jia = file.nodes.find((node) => node.id === 'n_甲');
    const jia1 = file.nodes.find((node) => node.id === 'n_甲1');
    if (jia) jia.done = true;
    if (jia1) jia1.done = true;

    // 甲1 自己也完成 ⇒ 它是 `done` 而不是 `dimmed`（两档不叠加）
    expect(outlineRowsOf(file).map((row) => [row.text, row.done, row.dimmed] as const)).toEqual([
      ['甲', true, false],
      ['甲1', true, false],
    ]);
  });
});

describe('聚焦（`N3-e`）', () => {
  /** 一棵三层的小树 + 一个悬浮节点（验"从哪一支走"与"面包屑到根为止"） */
  const tree = (): MindFile => {
    const file = mindOf([
      ['中心', '', null],
      ['甲', '', '中心'],
      ['甲1', '', '甲'],
      ['甲1a', '', '甲1'],
      ['乙', '', '中心'],
    ]);
    file.nodes.push(
      createMindNode({ id: 'n_自由', text: '自由', note: '', parentId: null, order: 9 }),
    );
    return file;
  };

  it('★ 聚焦一支 ⇒ 只走那一支，且**它自己不是行**（与"根不进列表"同一条规矩）', () => {
    const rows = outlineRowsOf(tree(), 'n_甲');

    expect(rows.map((row) => row.text)).toEqual(['甲1', '甲1a']);
    expect(rows.map((row) => row.depth)).toEqual([0, 1]);
  });

  it('★ 聚焦的那一支**忽略自己的 `collapsed`**：都进来了不该只看一行标题', () => {
    const file = tree();
    const jia = file.nodes.find((node) => node.id === 'n_甲');
    if (jia) jia.collapsed = true;

    expect(outlineRowsOf(file, 'n_甲').map((row) => row.text)).toEqual(['甲1', '甲1a']);
  });

  it('它**下面的**折叠照旧生效（只是"进来的那一支"例外）', () => {
    const file = tree();
    const jia1 = file.nodes.find((node) => node.id === 'n_甲1');
    if (jia1) jia1.collapsed = true;

    expect(outlineRowsOf(file, 'n_甲').map((row) => row.text)).toEqual(['甲1']);
    // 而整棵树的视角里，甲1 也是收起的（同一个标记，两处一致）
    expect(outlineRowsOf(file).map((row) => row.text)).toEqual(['甲', '甲1', '乙']);
  });

  it('聚焦的 id 不在 ⇒ **退回整棵树**（与"没聚焦"同一个样子，调用方不必自己判）', () => {
    expect(outlineRowsOf(tree(), 'n_幽灵').map((row) => row.text)).toEqual([
      '甲',
      '甲1',
      '甲1a',
      '乙',
    ]);
  });

  it('标题：聚焦时是**那一支**的文字；不在时退回根', () => {
    const file = tree();
    expect(outlineTitleOf(file, 'n_甲')).toBe('甲');
    expect(outlineTitleOf(file, 'n_幽灵')).toBe('中心');
    expect(outlineTitleOf(file)).toBe('中心');
  });

  it('面包屑：根 → … → 聚焦的那一支；没聚焦给**空数组**（面板不画那条）', () => {
    const file = tree();
    expect(outlinePathOf(file, 'n_甲1a').map((crumb) => crumb.text)).toEqual([
      '中心',
      '甲',
      '甲1',
      '甲1a',
    ]);
    expect(outlinePathOf(file, 'n_甲').map((crumb) => crumb.id)).toEqual(['n_中心', 'n_甲']);
    expect(outlinePathOf(file)).toEqual([]);
    expect(outlinePathOf(file, 'n_幽灵')).toEqual([]);
  });

  it('★ 悬浮节点不进面包屑（它不是"某一支"，大纲里根本没有它那一行）', () => {
    expect(outlinePathOf(tree(), 'n_自由')).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
// `view.focus` 的读写（`N3-e`）
// ─────────────────────────────────────────────────────────────

describe('view.focus 的读写（`N3-e`）', () => {
  const fileWithFocus = (focus: unknown) =>
    normalizeMindFile({
      version: 1,
      revision: 0,
      meta: { id: 'nm_1', title: 'T' },
      view: { x: 0, y: 0, zoom: 1, background: 'dots', focus },
      rootId: 'n_root',
      nodes: [
        { id: 'n_root', text: '中心', note: '', parentId: null, order: 0 },
        { id: 'n_甲', text: '甲', note: '', parentId: 'n_root', order: 0 },
      ],
    });

  it('★ 节点在 ⇒ 留着（关掉重开还停在这一支）', () => {
    const result = fileWithFocus('n_甲');

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.file.view.focus).toBe('n_甲');
  });

  it('★ 节点不在 ⇒ **丢掉这个键**并留痕（"没聚焦"是能站住的状态）', () => {
    const result = fileWithFocus('n_幽灵');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect('focus' in result.file.view).toBe(false);
      expect(result.issues.some((issue) => issue.path === 'view.focus')).toBe(true);
    }
  });

  it('没有这个键 ⇒ **不补**（缺席 = 没聚焦；纪律 2）', () => {
    const result = normalizeMindFile({
      version: 1,
      revision: 0,
      meta: { id: 'nm_1', title: 'T' },
      view: { x: 0, y: 0, zoom: 1, background: 'dots' },
      rootId: 'n_root',
      nodes: [{ id: 'n_root', text: '中心', note: '', parentId: null, order: 0 }],
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect('focus' in result.file.view).toBe(false);
  });

  it('坏值（不是字符串 / 空串）⇒ 忽略并留痕（不整份判失败）', () => {
    for (const bad of [123, '', null]) {
      const result = fileWithFocus(bad);
      expect(result.ok).toBe(true);
      if (result.ok) expect('focus' in result.file.view).toBe(false);
    }
  });

  it('幂等：读两遍零 issue', () => {
    const first = fileWithFocus('n_甲');
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = normalizeMindFile(JSON.parse(JSON.stringify(first.file)) as unknown);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.issues).toEqual([]);
  });
});
