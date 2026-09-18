/**
 * 白板内搜索单元测试（T2.09 / `F8-01`）。
 *
 * 纯函数，所以这里钉的是**用户会直接感知到却没处验证**的几件事：
 *   1. **搜得到什么**：便签正文、卡片标题、文件名（`F8-01` 的三样）——
 *      少了任何一样，用户都会得出"这搜索没用"的结论；
 *   2. **排序**：标题命中必须压在正文命中之前。这条错了不会有报错，
 *      只会让"搜周报、第一屏全是噪音"成为常态；
 *   3. **片段的坐标**：`matchStart` 差一格，高亮就标错字 ——
 *      这是**唯一**能在单测里验出来的渲染前提（面板只是照着切字符串）；
 *   4. **性能底线**：10k 卡片 < 200ms（`F8-01` 的验收线）。搜索每敲一个字重算一次，
 *      它是这条链路上最容易悄悄退化成"打字卡顿"的一环。
 */

import { describe, expect, it } from 'vitest';
import { createBoardFile, createCard } from '../../model/factories';
import { MAX_SEARCH_HITS, parseTerms, searchBoard } from '../../model/search';
import type { BoardFile, Card } from '../../model/schema';

function boardOf(cards: Card[]): BoardFile {
  return createBoardFile({ cards });
}

/** 一张便签（便签是白板上最常见的"有正文"的卡） */
function note(md: string, title = ''): Card {
  return createCard('note', { title, content: { md } });
}

describe('parseTerms', () => {
  it('小写化、按空白切词、丢掉空词', () => {
    expect(parseTerms('  Foo   BAR ')).toEqual(['foo', 'bar']);
    expect(parseTerms('   ')).toEqual([]);
  });
});

describe('searchBoard —— 搜得到什么', () => {
  it('便签正文', () => {
    const hits = searchBoard(boardOf([note('今天要写季度复盘')]), '复盘');

    expect(hits).toHaveLength(1);
    expect(hits[0].field).toBe('text');
    expect(hits[0].snippet).toContain('季度复盘');
  });

  it('卡片标题', () => {
    const card = createCard('image', { title: '封面图', content: { path: 'assets/a.png' } });
    const hits = searchBoard(boardOf([card]), '封面');

    expect(hits).toHaveLength(1);
    expect(hits[0].field).toBe('title');
    expect(hits[0].title).toBe('封面图');
  });

  it('文件名（引用卡 / 文件卡 / 图片卡都按路径搜）', () => {
    const cards = [
      createCard('noteRef', { content: { path: '笔记/会议纪要.md' } }),
      createCard('file', { content: { path: '附件/预算表.xlsx' } }),
      createCard('image', { content: { path: '附件/截图.png' } }),
    ];

    const hits = searchBoard(boardOf(cards), '附件/');
    expect(hits.map((hit) => hit.type).sort()).toEqual(['file', 'image']);
  });

  it('链接卡的地址与描述、待办卡的分条', () => {
    const cards = [
      createCard('link', { content: { url: 'https://example.com/docs' } }),
      createCard('todo', {
        content: { title: '发布检查', items: [{ text: '写更新日志', done: false }] },
      }),
    ];

    expect(searchBoard(boardOf(cards), 'example.com')).toHaveLength(1);
    expect(searchBoard(boardOf(cards), '更新日志')).toHaveLength(1);
  });

  it('大小写不敏感（标题叫 Roadmap，敲小写也该搜到）', () => {
    const hits = searchBoard(boardOf([note('roadmap 正文', 'Roadmap')]), 'roadmap');
    expect(hits[0].field).toBe('title');
  });

  it('多个词之间是 AND：都出现才算命中', () => {
    const cards = [note('图 和 表格'), note('只有图'), note('只有表格')];
    const hits = searchBoard(boardOf(cards), '图 表格');
    expect(hits).toHaveLength(1);
  });

  it('空查询 / 纯空白 → 空结果（不发散成"列出全部卡片"）', () => {
    const board = boardOf([note('随便什么'), note('另外一张')]);
    expect(searchBoard(board, '')).toEqual([]);
    expect(searchBoard(board, '   ')).toEqual([]);
  });

  it('搜不到就是空数组，不抛错', () => {
    expect(searchBoard(boardOf([note('便签')]), '不存在的词')).toEqual([]);
  });
});

describe('searchBoard —— 排序', () => {
  it('★ 标题命中排在正文命中之前（搜"周报"时，叫《周报》的卡必须第一）', () => {
    const cards = [note('正文里提了一句周报', '随手记'), note('别的内容', '周报')];
    const hits = searchBoard(boardOf(cards), '周报');

    expect(hits).toHaveLength(2);
    expect(hits[0].field).toBe('title');
    expect(hits[0].title).toBe('周报');
  });

  it('同一字段内，命中位置靠前的优先', () => {
    const cards = [
      note('前言很长很长很长很长很长很长很长很长很长很长很长关键词'),
      note('关键词出现'),
    ];
    const hits = searchBoard(boardOf(cards), '关键词');

    expect(hits[0].snippet.startsWith('关键词')).toBe(true);
  });

  it('同分时保持卡片原有顺序（两次搜同一个词，结果不会乱跳）', () => {
    const cards = [note('甲：共同词'), note('乙：共同词')];
    const first = searchBoard(boardOf(cards), '共同词').map((hit) => hit.cardId);
    const second = searchBoard(boardOf(cards), '共同词').map((hit) => hit.cardId);

    expect(first).toEqual(second);
  });
});

describe('searchBoard —— 片段与高亮坐标', () => {
  it('★ 长文本只给命中处周围一小段，两端补 `…`，且高亮坐标指向命中词', () => {
    const text = `${'a'.repeat(200)}目标词${'b'.repeat(200)}`;
    const hits = searchBoard(boardOf([note(text)]), '目标词');
    const hit = hits[0];

    expect(hit.snippet.startsWith('…')).toBe(true);
    expect(hit.snippet.endsWith('…')).toBe(true);
    // 面板就是照着这两个数字切字符串的：切出来必须是那个词本身
    expect(hit.snippet.slice(hit.matchStart, hit.matchStart + hit.matchLength)).toBe('目标词');
  });

  it('短文本不补省略号，高亮坐标同样准确', () => {
    const hits = searchBoard(boardOf([note('前言 关键词 后语')]), '关键词');
    const hit = hits[0];

    expect(hit.snippet.startsWith('…')).toBe(false);
    expect(hit.snippet.endsWith('…')).toBe(false);
    expect(hit.snippet.slice(hit.matchStart, hit.matchStart + hit.matchLength)).toBe('关键词');
  });

  it('★ 便签的换行被折成空格（片段是单行列表，带换行会撑坏排版）', () => {
    const hits = searchBoard(boardOf([note('第一行\n\n第二行 关键内容')]), '关键内容');
    const hit = hits[0];

    expect(hit.snippet).not.toContain('\n');
    expect(hit.snippet).toContain('第二行 关键内容');
  });

  it('高亮坐标在"折叠空白之后"算（否则会标到别的字上）', () => {
    const hits = searchBoard(boardOf([note('甲   乙   目标')]), '目标');
    const hit = hits[0];

    expect(hit.snippet.slice(hit.matchStart, hit.matchStart + hit.matchLength)).toBe('目标');
  });
});

describe('searchBoard —— 上限与性能', () => {
  it(`最多返回 ${MAX_SEARCH_HITS} 条（再多用户也不会翻，面板也没必要构造）`, () => {
    const cards = Array.from({ length: MAX_SEARCH_HITS + 20 }, (_, index) =>
      note(`共同词 ${index}`),
    );
    expect(searchBoard(boardOf(cards), '共同词')).toHaveLength(MAX_SEARCH_HITS);
    expect(searchBoard(boardOf(cards), '共同词', 3)).toHaveLength(3);
  });

  it('★ 10k 卡片 < 200ms（`F8-01` 的验收线：搜索是每敲一个字就重算一次的）', () => {
    const cards = Array.from({ length: 10_000 }, (_, index) =>
      note(`第 ${index} 张便签的正文，包含一些中文字符用来模拟真实内容。`),
    );
    const board = boardOf(cards);

    const started = performance.now();
    const hits = searchBoard(board, '便签');
    const elapsed = performance.now() - started;

    expect(hits).toHaveLength(MAX_SEARCH_HITS);
    expect(elapsed).toBeLessThan(200);
  });
});
