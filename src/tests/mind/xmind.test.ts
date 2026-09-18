/**
 * `.xmind` 导出（`mind/export/toXmind.ts`，用户 2026-09-17）。
 *
 * 用户口径："1 是导出成 .xmind，要求符合 xmind 的规范，不符合 xmind 要求的一些内容可以裁剪掉，
 * 例如插入的标记。"
 *
 * ★ 这里钉三件事：**包内文件齐**（content / metadata / manifest）、**树与备注的形状**
 *   （XMind 读的就是这几个字段）、**裁剪是有意的**（标记 / 完成态不该漏进去）。
 */

import { describe, expect, it } from 'vitest';
import { mindToXmindEntries, type XmindEntry } from '../../mind/export/toXmind';
import { mindWith } from '../helpers/mindFixtures';

const entriesOf = (file: Parameters<typeof mindToXmindEntries>[0]): XmindEntry[] =>
  mindToXmindEntries(file);

const contentOf = (file: Parameters<typeof mindToXmindEntries>[0]): string =>
  entriesOf(file).find((entry) => entry.path === 'content.json')?.content ?? '';

/** `content.json` 里那张 sheet */
const sheetOf = (file: Parameters<typeof mindToXmindEntries>[0]): Record<string, unknown> =>
  (JSON.parse(contentOf(file)) as Record<string, unknown>[])[0] ?? {};

const rootTopicOf = (file: Parameters<typeof mindToXmindEntries>[0]): Record<string, unknown> =>
  (sheetOf(file).rootTopic ?? {}) as Record<string, unknown>;

/** 一个主题的 `children.attached` */
const attachedOf = (topic: Record<string, unknown>): Record<string, unknown>[] => {
  const children = topic.children as { attached?: Record<string, unknown>[] } | undefined;
  return children?.attached ?? [];
};

describe('mindToXmindEntries · 包内文件', () => {
  it('给出 content.json / metadata.json / manifest.json（顺序：主题树打头）', () => {
    const entries = entriesOf(mindWith([['中心', null]]));

    expect(entries.map((entry) => entry.path)).toEqual([
      'content.json',
      'metadata.json',
      'manifest.json',
    ]);
    // manifest 要把两个文件都登记上（XMind 靠它认包里的东西）
    const manifest = JSON.parse(
      entries.find((entry) => entry.path === 'manifest.json')?.content ?? '{}',
    ) as { 'file-entries'?: Record<string, unknown> };
    expect(Object.keys(manifest['file-entries'] ?? {}).sort()).toEqual([
      'content.json',
      'metadata.json',
    ]);
  });

  it('创建者信息可以注入（视图传插件名与版本）', () => {
    const entries = mindToXmindEntries(mindWith([['中心', null]]), {
      creator: { name: 'Nestboard', version: '9.9.9' },
    });
    const metadata = JSON.parse(
      entries.find((entry) => entry.path === 'metadata.json')?.content ?? '{}',
    ) as { creator?: { name?: string; version?: string } };

    expect(metadata.creator).toEqual({ name: 'Nestboard', version: '9.9.9' });
  });
});

describe('mindToXmindEntries · 主题树', () => {
  it('★ sheet → rootTopic → children.attached（XMind 读的就是这几层）', () => {
    const mind = mindWith([
      ['中心', null],
      ['甲', '中心'],
      ['乙', '中心'],
    ]);

    const sheet = sheetOf(mind);
    expect(sheet.class).toBe('sheet');
    const root = rootTopicOf(mind);
    expect(root.class).toBe('topic');
    expect(root.title).toBe('中心');
    expect(attachedOf(root).map((topic) => topic.title)).toEqual(['甲', '乙']);
  });

  it('★ 内容写进 XMind 的**备注**；附件路径跟在后面（"用户写过的东西"尽量活下来）', () => {
    const mind = mindWith([['中心', null]]);
    const root = mind.nodes[0];
    if (root) {
      root.note = '一段说明';
      root.refs = [{ kind: 'file', path: 'Docs/报告.pdf' }];
    }

    const notes = rootTopicOf(mind).notes as { plain?: { content?: string } } | undefined;
    expect(notes?.plain?.content).toContain('一段说明');
    expect(notes?.plain?.content).toContain('Docs/报告.pdf');
  });

  it('★ 规范外的**裁掉**：标记（emoji）与完成态不进导出', () => {
    const mind = mindWith([
      ['中心', null],
      ['甲', '中心'],
    ]);
    const child = mind.nodes[1];
    if (child) {
      child.icon = '🔥';
      child.done = true;
    }

    const content = contentOf(mind);
    expect(content).not.toContain('🔥');
    expect(content).not.toContain('"done"');
  });

  it('★ 悬浮节点挂到**根**后面（XMind 的树里没有它们的位置，但内容不能丢）', () => {
    const mind = mindWith([
      ['中心', null],
      ['甲', '中心'],
    ]);
    const floating = mind.nodes[1];
    if (floating) floating.parentId = null;

    const attached = attachedOf(rootTopicOf(mind));
    expect(attached.map((topic) => topic.title)).toEqual(['甲']);
  });

  it('空标题给占位（XMind 里"没有标题的主题"会显示成一个空盒子）', () => {
    const mind = mindWith([
      ['中心', null],
      ['', '中心'],
    ]);
    expect(JSON.stringify(sheetOf(mind))).toContain('（无标题）');
  });

  it('★ 总体结构映射到 XMind 的内建 `structureClass`', () => {
    const mind = mindWith([['中心', null]]);
    mind.view.structure = 'org-down';
    expect(sheetOf(mind).structureClass).toBe('org.xmind.ui.org-chart.down');

    mind.view.structure = 'logic-left';
    expect(sheetOf(mind).structureClass).toBe('org.xmind.ui.logic.left');
  });
});
