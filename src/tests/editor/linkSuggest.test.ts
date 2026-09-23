/**
 * `[[` 链接补全的纯逻辑（`F5`）。
 *
 * 钉三类"错了用户会立刻察觉"的事：
 *   ① 该弹的时候弹、**不该弹的时候坚决不弹**（已闭合 / 换行 / 别名段里）；
 *   ② 顺序可预期（前缀优先、短路径优先、同输入两次同序）；
 *   ③ 接受之后只动光标之前的那一段，后面的字一个不碰。
 */

import { describe, expect, it } from 'vitest';
import {
  applyLinkSuggestion,
  detectLinkQuery,
  labelOf,
  rankLinkCandidates,
  type LinkCandidate,
} from '../../editor/linkSuggest';

describe('detectLinkQuery（要不要弹）', () => {
  it('刚敲两个 `[`：查询串是空串', () => {
    expect(detectLinkQuery('看这个 [[', 7)).toEqual({ start: 4, query: '' });
  });

  it('敲到一半：查询串是 `[[` 之后到光标的那一段', () => {
    expect(detectLinkQuery('见 [[项目 计划', 9)).toEqual({ start: 2, query: '项目 计划' });
  });

  it('★ 已经闭合 `]]` 就不再弹（补全该收场）', () => {
    expect(detectLinkQuery('见 [[笔记]] 后面', 11)).toBeNull();
  });

  it('★ 跨行不弹：`[[` 与光标之间隔着换行时那是普通文本', () => {
    expect(detectLinkQuery('第一行 [[\n第二行', 12)).toBeNull();
  });

  it('★ `|` 之后不弹：别名段里不该再补全路径', () => {
    expect(detectLinkQuery('见 [[笔记|别', 9)).toBeNull();
  });

  it('取**最后一个** `[[`：手滑敲出 `[[a[[b` 时改最近的那个', () => {
    expect(detectLinkQuery('[[a[[b', 6)).toEqual({ start: 3, query: 'b' });
  });

  it('没有 `[[`、光标越界都不炸', () => {
    expect(detectLinkQuery('普通文本', 4)).toBeNull();
    expect(detectLinkQuery('[[x', 99)).toEqual({ start: 0, query: 'x' });
    expect(detectLinkQuery('[[x', -5)).toBeNull();
  });
});

describe('rankLinkCandidates（弹什么、什么顺序）', () => {
  const vault: LinkCandidate[] = [
    { path: '笔记/读书笔记.md' },
    { path: '笔记/项目计划.md' },
    { path: '资料/项目管理.md' },
    { path: 'README.md' },
  ];

  it('★ 前缀命中排在"中间命中"前面', () => {
    const ranked = rankLinkCandidates(vault, '项目');
    expect(ranked.map((item) => item.path)).toEqual(['笔记/项目计划.md', '资料/项目管理.md']);
  });

  it('空查询 = 全都算候选（刚敲完 `[[` 时先把库摊给用户看）', () => {
    expect(rankLinkCandidates(vault, '').length).toBe(4);
  });

  it('大小写不敏感（`readme` 命中 `README.md`）', () => {
    expect(rankLinkCandidates(vault, 'readme').map((item) => item.path)).toEqual(['README.md']);
  });

  it('★ 同一输入两次给出**同一个顺序**（否则上下键会跳）', () => {
    const once = rankLinkCandidates(vault, '记');
    const twice = rankLinkCandidates(vault, '记');
    expect(once.map((item) => item.path)).toEqual(twice.map((item) => item.path));
  });

  it('有上限：多了只给 `limit` 条，且 `limit` 为 0 时一条不给', () => {
    expect(rankLinkCandidates(vault, '', 2)).toHaveLength(2);
    expect(rankLinkCandidates(vault, '', 0)).toHaveLength(0);
  });
});

describe('applyLinkSuggestion（接受之后变什么）', () => {
  it('把 `[[查询` 换成 `[[路径]]`，光标停在 `]]` 之后', () => {
    const value = '见 [[项目';
    const query = detectLinkQuery(value, value.length);

    expect(query).not.toBeNull();
    const next = applyLinkSuggestion(value, value.length, query!, {
      path: '笔记/项目计划.md',
    });

    expect(next.value).toBe('见 [[笔记/项目计划.md]]');
    expect(next.caret).toBe(next.value.length);
  });

  it('★ 只动光标之前：后面已有的字一个不碰', () => {
    const value = '见 [[项目，后面还有半句。';
    const caret = 6; // 光标停在「项目」之后（`[[` 占 2、`见 ` 占 2、"项目" 占 2）
    const query = detectLinkQuery(value, caret);

    const next = applyLinkSuggestion(value, caret, query!, { path: '笔记/项目.md' });

    expect(next.value).toBe('见 [[笔记/项目.md]]，后面还有半句。');
    expect(next.caret).toBe('见 [[笔记/项目.md]]'.length);
  });

  it('显示名：给了 label 用它；没给就取文件名去掉扩展名', () => {
    expect(labelOf({ path: '笔记/子目录/标题.md' })).toBe('标题');
    expect(labelOf({ path: 'README' })).toBe('README');
    expect(labelOf({ path: 'a/b.md', label: '自定义' })).toBe('自定义');
  });
});
