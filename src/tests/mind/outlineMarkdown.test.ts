/**
 * 大纲式 Markdown 导出（`mind/export/toOutlineMarkdown.ts`，用户 2026-09-17）。
 *
 * 用户口径（2026-09-17 定稿）："根节点是标题。**一级 / 二级 是 `##` / `###`，
 * 三级及更深就是正文 + 缩进就好了**。如果节点上除了标题还有内容，内容都变成代码块。"
 *
 * ★ 这里钉的就是那张对照表：**根 = `#`（标题），一级 = `##`，二级 = `###`，
 *   三级及更深 = 正文 + 缩进**。
 */

import { describe, expect, it } from 'vitest';
import { mindToOutlineMarkdown } from '../../mind/export/toOutlineMarkdown';
import { mindWith } from '../helpers/mindFixtures';

/** 去掉空行，方便逐行断言 */
const linesOf = (md: string): string[] => md.split('\n').filter((line) => line.trim().length > 0);

describe('mindToOutlineMarkdown · 标题层级', () => {
  it('★ 根 = 标题；一级 = `##`、二级 = `###`；**三级及更深 = 正文 + 缩进**', () => {
    const mind = mindWith([
      ['中心', null],
      ['甲', '中心'],
      ['甲一', '甲'],
      ['甲一一', '甲一'],
      ['甲一一一', '甲一一'],
    ]);

    const lines = linesOf(mindToOutlineMarkdown(mind));

    expect(lines[0]).toBe('# 中心');
    expect(lines[1]).toBe('## 甲');
    expect(lines[2]).toBe('### 甲一');
    // 三级起就是正文：缩进 = 比标题多出的层数 × 2
    expect(lines[3]).toBe('  甲一一');
    expect(lines[4]).toBe('    甲一一一');
  });

  it('★ 内容一律变成代码块（用户原话："内容都变成代码块"）', () => {
    const mind = mindWith([
      ['中心', null],
      ['甲', '中心'],
    ]);
    const node = mind.nodes[1];
    if (node) node.note = '第一行\n第二行';

    expect(mindToOutlineMarkdown(mind)).toContain('```\n第一行\n第二行\n```');
  });

  it('★ 内容里本来就有 ``` ⇒ 围栏加长，不把内容截断', () => {
    const mind = mindWith([['中心', null]]);
    const root = mind.nodes[0];
    if (root) root.note = '```\ncode\n```';

    expect(mindToOutlineMarkdown(mind)).toContain('````\n```\ncode\n```\n````');
  });

  it('★ 折叠的子树照样导出（`collapsed` 是"怎么看"，不是"写了什么"）', () => {
    const mind = mindWith([
      ['中心', null],
      ['甲', '中心'],
    ]);
    const root = mind.nodes[0];
    if (root) root.collapsed = true;

    expect(mindToOutlineMarkdown(mind)).toContain('## 甲');
  });

  it('空标题给占位（否则那一行只剩一个 `#`）；附件写成链接', () => {
    const mind = mindWith([
      ['中心', null],
      ['', '中心'],
    ]);
    const child = mind.nodes[1];
    if (child) child.refs = [{ kind: 'image', path: 'img/a.png' }];

    const md = mindToOutlineMarkdown(mind);
    expect(md).toContain('（无标题）');
    expect(md).toContain('![[img/a.png]]');
  });

  it('★ 悬浮节点不属于这棵树，但绝不能丢 ⇒ 收在末尾一节里', () => {
    const mind = mindWith([
      ['中心', null],
      ['甲', '中心'],
    ]);
    // 把"甲"改成悬浮节点（`parentId === null` 且不是根）
    const floating = mind.nodes[1];
    if (floating) floating.parentId = null;

    const md = mindToOutlineMarkdown(mind);
    expect(md).toContain('悬浮节点');
    expect(md).toContain('## 甲');
  });
});
