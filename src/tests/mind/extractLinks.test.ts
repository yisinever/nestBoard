/**
 * 脑图那份 `LinkExtractor`（`06 §7.2` 的接缝）。
 *
 * 它让**反链面板不必认识脑图**：面板拿到的永远是中立的 `LinkHit`
 * （`docPath` / `anchorId` / `label`），点一条就 `openMindView(path, { nodeId })`。
 * 所以这里钉的是"接口契约"，不是渲染：
 * **扫正文、跳过标题与附件、命中的锚点是节点 id、认不出的文本返回 `null`**。
 */

import { describe, expect, it } from 'vitest';
import { extractMindDoc } from '../../mind/io/extractLinks';
import { createMindFile, createMindNode } from '../../mind/model/factories';
import { serializeMindFile } from '../../mind/io/serialize';
import type { MindFile } from '../../mind/model/schema';

/** 造一份脑图文本：`[节点标题, 正文]` */
function mindText(nodes: readonly (readonly [string, string])[], title = '产品脑暴'): string {
  const file: MindFile = createMindFile({ title, now: () => 'T' });
  file.nodes = nodes.map(([text, note], index) =>
    createMindNode({
      id: `n_${text}`,
      text,
      note,
      parentId: index === 0 ? null : `n_${nodes[0]?.[0] ?? ''}`,
      order: index,
    }),
  );
  file.rootId = `n_${nodes[0]?.[0] ?? ''}`;
  return serializeMindFile(file);
}

describe('extractMindDoc', () => {
  it('★ 从节点**正文**里认出链接与标签，锚点是节点 id、标题是节点文字', () => {
    const doc = extractMindDoc(
      'X.nestmind',
      mindText([
        ['中心', '见 [[笔记甲]] #预算'],
        ['甲', '还没写'],
      ]),
    );

    expect(doc?.title).toBe('产品脑暴');
    expect(doc?.links).toHaveLength(1);
    expect(doc?.links[0]).toMatchObject({
      target: '笔记甲',
      anchorId: 'n_中心',
      label: '中心',
    });
    expect(doc?.tags).toEqual(['预算']);
  });

  it('★ 标题里的 `[[x]]` **不算**链接（标题是纯文本一行，不渲染 Markdown）', () => {
    const doc = extractMindDoc(
      'X.nestmind',
      mindText([
        ['中心', '正文里有 [[乙]]'],
        ['这是 [[不是链接]] 的标题', ''],
      ]),
    );

    expect(doc?.links.map((link) => link.target)).toEqual(['乙']);
  });

  it('★ 附件（`refs`）不算"内联链接"（它已经是结构化引用，不该被数第二遍）', () => {
    const file = createMindFile({ title: 'T', now: () => 'T' });
    const node = createMindNode({
      id: 'n_中心',
      text: '中心',
      note: '',
      refs: [{ kind: 'note', path: '附件/图.md' }],
    });
    file.nodes = [node];
    file.rootId = 'n_中心';

    const doc = extractMindDoc('X.nestmind', serializeMindFile(file));
    expect(doc?.links).toEqual([]);
    expect(doc?.tags).toEqual([]);
  });

  it('围栏代码块里的链接不算（"展示语法"与"使用语法"要分开）', () => {
    const doc = extractMindDoc(
      'X.nestmind',
      mindText([['中心', '```\n[[只是示例]]\n```\n真链接 [[丙]]']]),
    );

    expect(doc?.links.map((link) => link.target)).toEqual(['丙']);
  });

  it('★ 认不出的文本返回 `null`（不是"没有链接" —— 调用方据此跳过它）', () => {
    expect(extractMindDoc('X.nestmind', '这不是 JSON')).toBeNull();
    expect(extractMindDoc('X.nestmind', '{"spec":"别的什么","version":1}')).toBeNull();
  });

  it('没有正文的脑图：标题照给、链接与标签为空', () => {
    const doc = extractMindDoc('X.nestmind', mindText([['中心', '']]));

    expect(doc?.title).toBe('产品脑暴');
    expect(doc?.links).toEqual([]);
    expect(doc?.tags).toEqual([]);
  });
});
