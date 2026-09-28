/**
 * `.xmind` 导入的解析层（用户 2026-09-28）。
 * 只钉三件事：树展开对不对、备注有没有搬过来、坏文件给不给明确原因。
 */

import { describe, expect, it } from 'vitest';

import { importXmindEntries } from '../../mind/io/fromXmind';

const CONTENT = JSON.stringify([
  {
    id: 'sheet-1',
    class: 'sheet',
    title: '画布 1',
    rootTopic: {
      id: 'root',
      title: '中心主题',
      children: {
        attached: [
          { id: 'a', title: '分支一', notes: { plain: { content: '一段备注' } } },
          { id: 'b', title: '分支二', children: { attached: [{ id: 'b1', title: '更深一层' }] } },
        ],
      },
    },
  },
]);

describe('importXmindEntries', () => {
  it('★ 展开主题树：父子关系与次序正确、标题与备注都搬过来', () => {
    const result = importXmindEntries([{ path: 'content.json', content: CONTENT }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.nodes.map((node) => node.text)).toEqual([
      '中心主题',
      '分支一',
      '分支二',
      '更深一层',
    ]);
    const root = result.nodes.find((node) => node.id === result.rootId)!;
    expect(root.parentId).toBeNull();
    expect(result.nodes[1]?.note).toBe('一段备注');
    expect(result.nodes[3]?.parentId).toBe(result.nodes[2]?.id);
    expect(result.nodes[3]?.order).toBe(0);
  });

  it('没有 content.json（XMind 8 老格式）⇒ 明确说清原因，不猜着解析', () => {
    expect(importXmindEntries([{ path: 'content.xml', content: '<xmap/>' }]).ok).toBe(false);
  });

  it('坏 JSON / 空内容 ⇒ 不抛异常，给原因', () => {
    expect(importXmindEntries([{ path: 'content.json', content: '{oops' }])).toEqual({
      ok: false,
      reason: 'bad-json',
    });
    expect(importXmindEntries([{ path: 'content.json', content: '[]' }]).ok).toBe(false);
  });
});
