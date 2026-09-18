/**
 * 重命名跟随（T1.46 + `06 §6` 的"断链"那一行）。
 *
 * 两条都钉在这里：
 * - **纯函数** `retargetMind`：脑图的附件路径与正文里的 `[[链接]]` 有没有跟着改；
 * - **接线** `RenameWatcher`：一次改名事件，白板与脑图**各扫一遍**（以及没接脑图通道时
 *   老行为一字不变）。
 */

import { describe, expect, it } from 'vitest';
import { RenameWatcher, retargetMind } from '../../integration/RenameWatcher';
import { mindWith } from '../helpers/mindFixtures';

describe('retargetMind · 脑图里的引用跟随', () => {
  it('附件路径跟着改（回形针 / 图片块指向的那份文件）', () => {
    const mind = mindWith([
      ['中心', null],
      ['甲', '中心'],
    ]);
    const node = mind.nodes[1];
    if (node) node.refs = [{ kind: 'file', path: '附件/报告.pdf' }];

    expect(retargetMind(mind, '附件/报告.pdf', '归档/报告.pdf')).toBe(true);
    expect(node?.refs?.[0]?.path).toBe('归档/报告.pdf');
  });

  it('正文里的 `[[链接]]` 也跟着改（与白板的便签卡同一条）', () => {
    const mind = mindWith([['中心', null]]);
    const root = mind.nodes[0];
    if (root) root.note = '见 [[甲]] 与 [[乙|别名]]';

    expect(retargetMind(mind, '甲.md', '子目录/甲.md')).toBe(true);
    expect(root?.note).toBe('见 [[子目录/甲]] 与 [[乙|别名]]');
  });

  it('与这份脑图无关 ⇒ `false`（调用方不必写盘）', () => {
    const mind = mindWith([['中心', null]]);
    expect(retargetMind(mind, '别的.pdf', '新.pdf')).toBe(false);
  });

  it('空路径 / 没变化 ⇒ `false`（与 `retargetBoard` 同一条判据）', () => {
    const mind = mindWith([['中心', null]]);
    expect(retargetMind(mind, '', '新.pdf')).toBe(false);
    expect(retargetMind(mind, '同一.md', '同一.md')).toBe(false);
  });
});

describe('RenameWatcher · 两类文档各扫一遍', () => {
  it('★ 一次改名：白板与脑图都走到，返回两边受影响的路径', () => {
    const boardPaths: string[] = [];
    const mindPaths: string[] = [];
    const mind = mindWith([
      ['中心', null],
      ['甲', '中心'],
    ]);
    const node = mind.nodes[1];
    if (node) node.refs = [{ kind: 'file', path: '旧.pdf' }];

    const watcher = new RenameWatcher({
      openPaths: () => ['A.nboard'],
      // 白板那条路的纯函数（`retargetBoard`）另有用例，这里只钉"接线有没有走到"
      mutate: (path) => {
        boardPaths.push(path);
        return true;
      },
      openMindPaths: () => ['B.nestmind'],
      mutateMind: (path, mutator) => {
        mindPaths.push(path);
        return mutator(mind);
      },
    });

    expect(watcher.handle('旧.pdf', '新.pdf')).toEqual(['A.nboard', 'B.nestmind']);
    expect(boardPaths).toEqual(['A.nboard']);
    expect(mindPaths).toEqual(['B.nestmind']);
    // 脑图那一半是**真的**改了模型，不只是"被调用了"
    expect(node?.refs?.[0]?.path).toBe('新.pdf');
  });

  it('没接脑图通道 ⇒ 只处理白板（老行为不变）', () => {
    const watcher = new RenameWatcher({
      openPaths: () => ['A.nboard'],
      mutate: () => true,
    });
    expect(watcher.handle('旧.md', '新.md')).toEqual(['A.nboard']);
  });

  it('★ 一份脑图写不进去（只读 / 已关闭）不该拖累其余的', () => {
    const watcher = new RenameWatcher({
      openPaths: () => [],
      mutate: () => false,
      openMindPaths: () => ['坏的.nestmind', '好的.nestmind'],
      mutateMind: (path) => {
        if (path === '坏的.nestmind') throw new Error('只读');
        return true;
      },
    });
    expect(watcher.handle('旧.pdf', '新.pdf')).toEqual(['好的.nestmind']);
  });

  it('空路径 / 同一路径 ⇒ 什么都不做', () => {
    const watcher = new RenameWatcher({
      openPaths: () => ['A.nboard'],
      mutate: () => true,
      openMindPaths: () => ['B.nestmind'],
      mutateMind: () => true,
    });
    expect(watcher.handle('', '新.md')).toEqual([]);
    expect(watcher.handle('同一.md', '同一.md')).toEqual([]);
  });
});
