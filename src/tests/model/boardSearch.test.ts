/**
 * 跨白板搜索的合并与排序单测（T7.02 / `F8-08`）。
 *
 * 这里钉的是**面板上看得见、但错了不会报错**的几件事：
 *
 *   1. **板名命中排最前**：用户敲"周报"时那块**就叫**《周报》的板必须冒头。
 *      这条错了不会有任何异常，只会让人觉得"跨板搜索找不到我的板"；
 *   2. **分层顺序**：板名 → 标题 → 路径 / 链接 → 正文。第一屏全是正文噪音
 *      就是这个函数唯一的失败表现；
 *   3. **两个上限**：单板上限（一块大板不许吃掉整个结果栏）与结果总数上限；
 *   4. **板名命中不冒充成卡片结果**：`boards` 与 `hits` 必须是两组 ——
 *      板名命中没有卡片可指，混进去就得让"点击跳转"一路带例外。
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_BOARD_MATCHES,
  MAX_BOARD_SEARCH_HITS,
  boardSearchStatus,
  boardTitleMatches,
  searchAcrossBoards,
} from '../../model/boardSearch';
import type { BoardSearchCandidate, CrossBoardSearchResult } from '../../model/boardSearch';
import { createBoardFile, createCard } from '../../model/factories';
import { MAX_SEARCH_HITS } from '../../model/search';
import type { Card } from '../../model/schema';

/** 一块板 + 它的路径与标题 */
function candidateOf(path: string, title: string, cards: Card[] = []): BoardSearchCandidate {
  return { path, title, board: createBoardFile({ meta: { title }, cards }) };
}

/** 一张有正文的便签 */
function note(md: string, title = ''): Card {
  return createCard('note', { title, content: { md } });
}

/** 结果里每一条的 `板名/字段` —— 断言排序时比看整条对象好读 */
function orderOf(result: CrossBoardSearchResult): string[] {
  const boardNames = new Map(result.boards.map((board) => [board.path, board.title]));
  return result.hits.map(
    (hit) =>
      `${boardNames.get(hit.boardPath) ?? hit.boardTitle}:${hit.field}:${hit.title || hit.snippet}`,
  );
}

describe('boardTitleMatches', () => {
  it('板名包含全部词条才算命中（与卡片搜索同一套 AND 语义）', () => {
    const candidate = { path: 'a/周报.nboard', title: '季度周报' };

    expect(boardTitleMatches(candidate, ['周报'])).toBe(true);
    expect(boardTitleMatches(candidate, ['季度', '周报'])).toBe(true);
    expect(boardTitleMatches(candidate, ['季度', '年报'])).toBe(false);
  });

  it('大小写不敏感、并忽略板名两端的空白', () => {
    expect(boardTitleMatches({ path: 'a/x.nboard', title: ' RoadMap ' }, ['roadmap'])).toBe(true);
  });

  it('空词条（空查询）不算命中 —— 否则空查询会"命中全库"', () => {
    expect(boardTitleMatches({ path: 'a/周报.nboard', title: '周报' }, [])).toBe(false);
  });

  it('板名为空时退回看文件名', () => {
    // `meta.title` 可以被清空，而侧栏那时显示的正是文件名 ——
    // 屏幕上写着《周报》却搜不到它，是纯粹的坏体验
    const candidate = { path: '项目/周报.nboard', title: '' };

    expect(boardTitleMatches(candidate, ['周报'])).toBe(true);
    expect(boardTitleMatches(candidate, ['项目'])).toBe(false);
  });

  it('板名非空时**不**再看文件名（两者不一致时以板名为准）', () => {
    // 否则"文件叫周报.nboard、板名却改成了杂事"的板会被当成《周报》——
    // 而侧栏（以及用户）看到的标题是"杂事"
    const candidate = { path: '周报.nboard', title: '杂事' };

    expect(boardTitleMatches(candidate, ['周报'])).toBe(false);
    expect(boardTitleMatches(candidate, ['杂事'])).toBe(true);
  });

  it('板名与文件名都为空 → 不命中（连搜什么都不该匹配一块没名字的板）', () => {
    expect(boardTitleMatches({ path: '.nboard', title: '' }, ['x'])).toBe(false);
    // 只有空白的板名同样不算：`''.includes('')` 恒真，不挡住的话空查询会"命中全库"
    expect(boardTitleMatches({ path: '', title: '   ' }, ['x'])).toBe(false);
  });
});

describe('searchAcrossBoards —— 空查询', () => {
  it('空查询 / 纯空白 → 两组都空（不发散成"列出全库"）', () => {
    const candidates = [candidateOf('a.nboard', '甲', [note('随便什么')])];

    expect(searchAcrossBoards(candidates, '')).toEqual({ hits: [], boards: [] });
    expect(searchAcrossBoards(candidates, '   ')).toEqual({ hits: [], boards: [] });
  });

  it('上限为 0 时也不返回任何东西（调用方显式要求"什么都别给"）', () => {
    const candidates = [candidateOf('a.nboard', '甲', [note('关键字')])];
    expect(searchAcrossBoards(candidates, '关键字', 0).hits).toEqual([]);
  });
});

describe('searchAcrossBoards —— 板名命中单列一组', () => {
  it('板名命中进 `boards`，且它的卡片命中排在**所有**非命中板之前', () => {
    const hitBoard = candidateOf('a.nboard', '周报', [note('周报：本周进度')]);
    const other = candidateOf('b.nboard', '杂事', [note('模板在这里', '周报')]);

    const result = searchAcrossBoards([other, hitBoard], '周报');

    expect(result.boards).toEqual([{ path: 'a.nboard', title: '周报' }]);
    // ★ 命中板的**正文**命中，压在另一块板的**标题**命中之前 ——
    //   "板名就是你要找的词"比"命中在哪一栏"更重，这正是第一层排序存在的理由
    expect(orderOf(result)).toEqual(['周报:text:周报：本周进度', '杂事:title:周报']);
  });

  it('板名命中没有卡片可指，所以不冒充成一条卡片结果', () => {
    // 情况：板叫《周报》，但板上没有任何卡片正文提到"周报"
    const candidates = [candidateOf('a.nboard', '周报', [note('本周进度')])];

    const result = searchAcrossBoards(candidates, '周报');

    expect(result.boards).toHaveLength(1);
    expect(result.hits).toEqual([]);
  });

  it('板名命中最多列 `MAX_BOARD_MATCHES` 块', () => {
    const candidates = Array.from({ length: MAX_BOARD_MATCHES + 2 }, (_unused, index) =>
      candidateOf(`b${index}.nboard`, `周报 ${index}`),
    );

    const result = searchAcrossBoards(candidates, '周报');

    expect(result.boards).toHaveLength(MAX_BOARD_MATCHES);
    // 按输入顺序取前 N 块，不是随机的一批
    expect(result.boards.map((board) => board.path)).toEqual(
      candidates.slice(0, MAX_BOARD_MATCHES).map((candidate) => candidate.path),
    );
  });
});

describe('searchAcrossBoards —— 分层排序', () => {
  it('同一块板内：标题 → 路径 → 正文', () => {
    const candidates = [
      candidateOf('a.nboard', '甲', [
        note('正文里提到预算', ''), // text
        createCard('image', { content: { path: '附件/预算表.png' } }), // path
        note('随便', '预算'), // title
      ]),
    ];

    expect(orderOf(searchAcrossBoards(candidates, '预算'))).toEqual([
      '甲:title:预算',
      '甲:path:附件/预算表.png',
      '甲:text:正文里提到预算',
    ]);
  });

  it('板名不命中时，跨板之间也按同一套层级排（标题命中压过正文命中）', () => {
    const candidates = [
      candidateOf('a.nboard', '甲', [note('正文里提到预算', '')]),
      candidateOf('b.nboard', '乙', [note('随便', '预算')]),
    ];

    expect(orderOf(searchAcrossBoards(candidates, '预算'))).toEqual([
      '乙:title:预算',
      '甲:text:正文里提到预算',
    ]);
  });

  it('同一层内保持"板序 → 板内原有顺序"，不重排', () => {
    const candidates = [
      candidateOf('a.nboard', '甲', [note('预算甲'), note('预算乙')]),
      candidateOf('b.nboard', '乙', [note('预算丙')]),
    ];

    expect(orderOf(searchAcrossBoards(candidates, '预算'))).toEqual([
      '甲:text:预算甲',
      '甲:text:预算乙',
      '乙:text:预算丙',
    ]);
  });

  it('每条结果都带着它属于哪块板（侧栏靠它标注来源）', () => {
    const candidates = [candidateOf('项目/周报.nboard', '周报', [note('进度')])];

    const hit = searchAcrossBoards(candidates, '进度').hits[0];

    expect(hit.boardPath).toBe('项目/周报.nboard');
    expect(hit.boardTitle).toBe('周报');
  });
});

describe('searchAcrossBoards —— 两个上限', () => {
  it('单块板最多贡献 `MAX_SEARCH_HITS` 条（一块大板不许吃掉整个结果栏）', () => {
    const cards = Array.from({ length: MAX_SEARCH_HITS + 10 }, (_unused, index) =>
      note(`预算 ${index}`),
    );
    const candidates = [candidateOf('a.nboard', '甲', cards)];

    const result = searchAcrossBoards(candidates, '预算', MAX_BOARD_SEARCH_HITS);

    expect(result.hits).toHaveLength(MAX_SEARCH_HITS);
  });

  it('结果总数按 `limit` 截断', () => {
    const candidates = [
      candidateOf('a.nboard', '甲', [note('预算一'), note('预算二')]),
      candidateOf('b.nboard', '乙', [note('预算三'), note('预算四')]),
    ];

    expect(searchAcrossBoards(candidates, '预算', 3).hits).toHaveLength(3);
  });

  it('大板的正文命中再多，也压不住另一块板的少量标题命中', () => {
    // 这是单板上限真正的用处：不做的话"跨板搜索"就是"跨进最大的那块板"
    const big = candidateOf(
      'big.nboard',
      '大板',
      Array.from({ length: MAX_SEARCH_HITS }, (_unused, index) => note(`预算 ${index}`)),
    );
    const small = candidateOf('small.nboard', '小板', [note('随便', '预算')]);

    const hits = searchAcrossBoards([big, small], '预算', MAX_BOARD_SEARCH_HITS).hits;

    expect(hits[0].boardPath).toBe('small.nboard');
    expect(hits[0].field).toBe('title');
  });

  it('默认上限就是 `MAX_BOARD_SEARCH_HITS`', () => {
    const cards = Array.from({ length: MAX_SEARCH_HITS }, (_unused, index) =>
      note(`预算 ${index}`),
    );
    const candidates = Array.from({ length: 3 }, (_unused, index) =>
      candidateOf(`b${index}.nboard`, `板 ${index}`, cards),
    );

    const result = searchAcrossBoards(candidates, '预算');

    expect(result.hits).toHaveLength(MAX_BOARD_SEARCH_HITS);
  });
});

describe('boardSearchStatus', () => {
  const idle = { ready: true, scanned: 12, indexed: 12 };

  it('空查询 → hint（不是"没有结果"）', () => {
    expect(boardSearchStatus('', { hits: [], boards: [] }, idle)).toEqual({ kind: 'hint' });
  });

  it('★ 扫描没走完时说"正在索引"，不说"没有"', () => {
    // 把"还没找"说成"找不到"，用户会以为功能坏了
    const status = boardSearchStatus(
      '周报',
      { hits: [], boards: [] },
      { ready: false, scanned: 3, indexed: 3 },
    );

    expect(status).toEqual({ kind: 'empty', scanned: 3, indexed: 3, scanning: true });
  });

  it('扫描走完且确实没有 → 报出扫过多少块板', () => {
    const status = boardSearchStatus(
      '周报',
      { hits: [], boards: [] },
      { ready: true, scanned: 12, indexed: 12 },
    );

    expect(status).toEqual({ kind: 'empty', scanned: 12, indexed: 12, scanning: false });
  });

  it('有结果 → count，并如实带上"仍在索引"', () => {
    const result = {
      hits: [{ ...hitStub(), boardPath: 'a.nboard', boardTitle: '甲' }],
      boards: [],
    };

    expect(boardSearchStatus('周报', result, idle)).toEqual({
      kind: 'count',
      hits: 1,
      boards: 0,
      scanning: false,
    });
    expect(
      boardSearchStatus('周报', result, { ready: false, scanned: 1, indexed: 1 }),
    ).toMatchObject({ kind: 'count', scanning: true });
  });

  it('只有板名命中、没有卡片命中 → 也算有结果（否则会说"没有白板匹配"）', () => {
    const result: CrossBoardSearchResult = {
      hits: [],
      boards: [{ path: 'a.nboard', title: '周报' }],
    };

    expect(boardSearchStatus('周报', result, idle)).toMatchObject({ kind: 'count', boards: 1 });
  });
});

/** 一条最小可用的 `SearchHit`（只给状态判定用得上的字段填值） */
function hitStub() {
  return {
    cardId: 'card-1',
    type: 'note' as const,
    field: 'text' as const,
    title: '',
    snippet: '周报',
    matchStart: 0,
    matchLength: 2,
  };
}
