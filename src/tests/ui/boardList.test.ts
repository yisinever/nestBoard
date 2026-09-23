/**
 * 白板列表的分组与筛选（T5.08 / `F7-04`）—— `ui/boardList.ts`。
 *
 * 三种看法（目录树 / 最近打开 / 按标签）都只是"同一批白板换个方式排"，所以它们
 * 全在这一份纯逻辑里，也全在这里测。
 *
 * ★ 断言里刻意用 ASCII 名字做排序用例：`localeCompare` 的结果依赖宿主 ICU 的 locale，
 *   拿中文名去断言"谁在前"会写出一条在别人机器上飘的测试 —— 而这类测试最后的结果
 *   通常是被改成 `expect(...).toHaveLength(n)`，等于白测。
 */

import { describe, expect, it } from 'vitest';
import {
  buildFolderTree,
  filterBoards,
  groupByTag,
  recentBoards,
  type BoardListItem,
} from '../../ui/boardList';

function board(path: string, title: string, tags: string[] = []): BoardListItem {
  return { path, title, tags };
}

describe('buildFolderTree：按目录分组', () => {
  it('库根下的板落在根节点上', () => {
    const item = board('A.nboard', 'A');
    const tree = buildFolderTree([item]);
    expect(tree).toEqual({ name: '', path: '', folders: [], boards: [item] });
  });

  it('一层目录：板进目录，不进根', () => {
    const tree = buildFolderTree([board('Boards/A.nboard', 'A')]);
    expect(tree.boards).toEqual([]);
    expect(tree.folders).toHaveLength(1);
    expect(tree.folders[0].name).toBe('Boards');
    expect(tree.folders[0].path).toBe('Boards');
    expect(tree.folders[0].boards.map((b) => b.path)).toEqual(['Boards/A.nboard']);
  });

  it('多层目录逐层建节点，`path` 是完整目录路径', () => {
    const tree = buildFolderTree([board('Boards/研究/子课题/A.nboard', 'A')]);
    const outer = tree.folders[0];
    const inner = outer.folders[0];
    expect([outer.name, outer.path]).toEqual(['Boards', 'Boards']);
    expect([inner.name, inner.path]).toEqual(['研究', 'Boards/研究']);
    expect(inner.folders[0].path).toBe('Boards/研究/子课题');
  });

  it('空目录不会出现（只沿着有白板的路径建节点）', () => {
    const tree = buildFolderTree([board('Boards/A.nboard', 'A')]);
    expect(tree.folders).toHaveLength(1);
    expect(tree.folders[0].folders).toEqual([]);
  });

  it('★ 每一层目录按名排序，且是**人眼顺序**（`Board 2` 在 `Board 10` 之前）', () => {
    const tree = buildFolderTree([board('Board 10/A.nboard', 'A'), board('Board 2/A.nboard', 'A')]);
    expect(tree.folders.map((f) => f.name)).toEqual(['Board 2', 'Board 10']);
  });

  it('★ 同一层的板按标题排序，标题相同则按路径兜底（先后必须**确定**）', () => {
    // 标题可以来自 `meta.title`，同一目录下两块板标题相同是完全可能的
    const tree = buildFolderTree([
      board('Boards/B.nboard', '同名'),
      board('Boards/A.nboard', '同名'),
    ]);
    expect(tree.folders[0].boards.map((b) => b.path)).toEqual([
      'Boards/A.nboard',
      'Boards/B.nboard',
    ]);
  });

  it('输入顺序不影响结果（`BoardRegistry.all()` 给的是扫描顺序）', () => {
    const items = [
      board('Boards/Beta/A.nboard', 'A'),
      board('Boards/Alpha/C.nboard', 'C'),
      board('Boards/Alpha/B.nboard', 'B'),
    ];
    expect(buildFolderTree(items)).toEqual(buildFolderTree([...items].reverse()));
  });

  it('不改动调用方传进来的数组（索引层返回的数组是复用的）', () => {
    const b = board('Boards/B.nboard', 'B');
    const a = board('Boards/A.nboard', 'A');
    const items = [b, a];
    buildFolderTree(items);
    expect(items).toEqual([b, a]);
  });
});

describe('recentBoards：按最近打开', () => {
  const items = [board('A.nboard', 'A'), board('B.nboard', 'B'), board('C.nboard', 'C')];

  it('顺序完全由历史决定', () => {
    expect(recentBoards(items, ['C.nboard', 'A.nboard']).map((b) => b.path)).toEqual([
      'C.nboard',
      'A.nboard',
    ]);
  });

  it('★ 历史里查不到的路径静默跳过（改名 / 删除后那一行不该留在列表里）', () => {
    expect(recentBoards(items, ['早就删了.nboard', 'B.nboard']).map((b) => b.path)).toEqual([
      'B.nboard',
    ]);
  });

  it('历史里重复的路径只出现一次', () => {
    expect(recentBoards(items, ['A.nboard', 'A.nboard', 'B.nboard']).map((b) => b.path)).toEqual([
      'A.nboard',
      'B.nboard',
    ]);
  });

  it('从没打开过的板不会出现在这里', () => {
    expect(recentBoards(items, ['A.nboard']).map((b) => b.path)).toEqual(['A.nboard']);
  });

  it('空历史 → 空列表', () => {
    expect(recentBoards(items, [])).toEqual([]);
  });

  it('★ 不按标题重排（"最近打开"要的就是"我刚看过的那几块按看过的顺序摆着"）', () => {
    const renamed = [board('A.nboard', 'Zeta'), board('B.nboard', 'Alpha')];
    expect(recentBoards(renamed, ['A.nboard', 'B.nboard']).map((b) => b.path)).toEqual([
      'A.nboard',
      'B.nboard',
    ]);
  });
});

describe('groupByTag：按标签分组', () => {
  it('一块板打了多个标签，就在每一组里各出现一次', () => {
    const groups = groupByTag([board('A.nboard', 'A', ['alpha', 'beta'])]);
    expect(groups.map((g) => g.tag)).toEqual(['alpha', 'beta']);
    expect(groups.every((g) => g.boards.map((b) => b.path).join() === 'A.nboard')).toBe(true);
  });

  it('★ 没打标签的那一组永远排在最后', () => {
    const groups = groupByTag([
      board('Z.nboard', 'Z'),
      board('A.nboard', 'A', ['alpha']),
      board('B.nboard', 'B', ['beta']),
    ]);
    expect(groups.map((g) => g.tag)).toEqual(['alpha', 'beta', null]);
  });

  it('组内按标题排序', () => {
    const groups = groupByTag([board('B.nboard', 'B', ['项目']), board('A.nboard', 'A', ['项目'])]);
    expect(groups[0].boards.map((b) => b.title)).toEqual(['A', 'B']);
  });

  it('同一块板里写了两遍同一个标签只算一次（复制粘贴的产物）', () => {
    const groups = groupByTag([board('A.nboard', 'A', ['项目', '项目'])]);
    expect(groups).toHaveLength(1);
    expect(groups[0].boards).toHaveLength(1);
  });

  it('空标签 / 只有空白的标签不算标签，会被并入"未加标签"', () => {
    const groups = groupByTag([board('A.nboard', 'A', ['', '   '])]);
    expect(groups).toHaveLength(1);
    expect(groups[0].tag).toBeNull();
  });

  it('标签前后空白会去掉（`YAML` 里 `- 项目 ` 是常见写法）', () => {
    const groups = groupByTag([
      board('A.nboard', 'A', [' 项目 ']),
      board('B.nboard', 'B', ['项目']),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].tag).toBe('项目');
    expect(groups[0].boards).toHaveLength(2);
  });

  it('全都有标签时不会凭空多出一个"未加标签"组', () => {
    expect(groupByTag([board('A.nboard', 'A', ['项目'])]).map((g) => g.tag)).toEqual(['项目']);
  });

  it('全都没标签时只有一组，且 tag 是 null', () => {
    expect(groupByTag([board('A.nboard', 'A')]).map((g) => g.tag)).toEqual([null]);
  });

  it('一块板都没有 → 一组都没有', () => {
    expect(groupByTag([])).toEqual([]);
  });
});

describe('filterBoards：筛选', () => {
  const items = [
    board('Boards/项目A/周会.nboard', '周会记录'),
    board('Boards/项目B/周会.nboard', '周会记录'),
    board('Resources/读书.nboard', '读书笔记'),
  ];

  it('空查询原样放行，顺序不变', () => {
    expect(filterBoards(items, '   ').map((b) => b.path)).toEqual(items.map((b) => b.path));
  });

  it('按标题筛，大小写不敏感', () => {
    const mixed = [board('A.nboard', 'Roadmap'), board('B.nboard', 'Other')];
    expect(filterBoards(mixed, 'roadmap').map((b) => b.path)).toEqual(['A.nboard']);
  });

  it('★ 路径也参与匹配：想"只看某个目录"时敲目录名是最直觉的做法', () => {
    expect(filterBoards(items, '项目A').map((b) => b.path)).toEqual(['Boards/项目A/周会.nboard']);
  });

  it('多个词是 AND：都要命中', () => {
    expect(filterBoards(items, '周会 项目B').map((b) => b.path)).toEqual([
      'Boards/项目B/周会.nboard',
    ]);
    expect(filterBoards(items, '周会 不存在的词')).toEqual([]);
  });

  it('两个词分别命中标题与路径也算', () => {
    expect(filterBoards(items, '读书 Resources').map((b) => b.path)).toEqual([
      'Resources/读书.nboard',
    ]);
  });

  it('都不命中 → 空数组', () => {
    expect(filterBoards(items, 'zzz')).toEqual([]);
  });

  it('不改动调用方传进来的数组', () => {
    const copy = [...items];
    filterBoards(items, '周会');
    expect(items).toEqual(copy);
  });
});

/**
 * `F1` 追记：标签来源是**白板级 ∪ 卡内**两份的并集。
 *
 * 只看 `item.tags`（`meta.tags`）的话，"在便签里写了一堆 `#纪要` 的板"会掉进
 * "未加标签" —— 而卡内标签才是用户天天写的那一种。
 */
describe('groupByTag：卡内标签也进分组（F1）', () => {
  const items = [
    { path: 'A.nboard', title: 'A', tags: [] },
    { path: 'B.nboard', title: 'B', tags: ['板级'] },
    { path: 'C.nboard', title: 'C', tags: [] },
  ];

  const cardTags: Record<string, string[]> = {
    'A.nboard': ['纪要'],
    'B.nboard': ['纪要', '板级'],
  };

  it('★ 只有卡内标签的板也会成组（不再掉进"未加标签"）', () => {
    const groups = groupByTag(items, (path) => cardTags[path] ?? []);
    const ji = groups.find((group) => group.tag === '纪要');
    expect(ji?.boards.map((board) => board.path)).toEqual(['A.nboard', 'B.nboard']);
    // C 两边都没有 ⇒ 未加标签
    const untagged = groups.find((group) => group.tag === null);
    expect(untagged?.boards.map((board) => board.path)).toEqual(['C.nboard']);
  });

  it('白板级与卡内同名只算一次（同一块板不会在组里出现两遍）', () => {
    const groups = groupByTag(items, (path) => cardTags[path] ?? []);
    const boardLevel = groups.find((group) => group.tag === '板级');
    expect(boardLevel?.boards.map((board) => board.path)).toEqual(['B.nboard']);
  });

  it('不传第二个参数 = 只按白板级标签（老行为一字不差）', () => {
    const groups = groupByTag(items);
    expect(groups.find((group) => group.tag === '纪要')).toBeUndefined();
    const untagged = groups.find((group) => group.tag === null);
    expect(untagged?.boards.map((board) => board.path)).toEqual(['A.nboard', 'C.nboard']);
  });

  it('卡内标签里的空白 / 空串同样会被清掉', () => {
    const groups = groupByTag([{ path: 'A.nboard', title: 'A', tags: [] }], () => [
      '  ',
      '',
      ' 纪要 ',
    ]);
    expect(groups.map((group) => group.tag)).toEqual(['纪要']);
  });
});
