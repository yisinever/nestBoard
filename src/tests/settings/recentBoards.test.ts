/**
 * 「最近打开」的白板路径（T5.08 / `F7-04`）—— `settings/recentBoards.ts`。
 *
 * 这一组里有两件事必须钉住，它们都是"看起来只是琐碎逻辑，实际会让人骂人"的那类：
 *
 * 1. **"没变化"要用"返回原引用"表达**。调用方（`main.ts`）下一步就是写盘，
 *    如果"在同一块板上又点了一次"也算变化，那 `data.json` 会变成每点一下写一次 ——
 *    而这类问题在真机上完全看不出来（没有报错、没有卡顿，只有磁盘无声地被写）。
 * 2. **改名要把历史里的路径搬走**。不搬的话那一行不是"变成旧名字"，而是**凭空消失**
 *    （侧栏会拿路径回索引里核对，对不上就跳过），用户找不到原因。
 */

import { describe, expect, it } from 'vitest';
import { RECENT_BOARDS_LIMIT } from '../../constants';
import {
  normalizeRecentBoards,
  pushRecentBoards,
  renameRecentBoards,
} from '../../settings/recentBoards';

describe('pushRecentBoards：记一次「最近打开」', () => {
  it('新路径进队首，其余保持原顺序', () => {
    expect(pushRecentBoards(['B', 'C'], 'A')).toEqual(['A', 'B', 'C']);
  });

  it('重新打开一块旧板 = 挪到队首，而不是多出一行', () => {
    expect(pushRecentBoards(['A', 'B', 'C'], 'C')).toEqual(['C', 'A', 'B']);
  });

  it('★ 已经在队首 → 返回**原引用**（调用方据此免掉一次写盘）', () => {
    const list = ['A', 'B'];
    expect(pushRecentBoards(list, 'A')).toBe(list);
  });

  it('空白路径不算一次"打开"（否则列表里会多出一行空白）', () => {
    const list = ['A'];
    expect(pushRecentBoards(list, '')).toBe(list);
    expect(pushRecentBoards(list, '   ')).toBe(list);
  });

  it('路径两端空白去掉后再进列表', () => {
    expect(pushRecentBoards([], '  Boards/A.nboard  ')).toEqual(['Boards/A.nboard']);
  });

  it('超过上限时丢掉最旧的那条', () => {
    const full = Array.from({ length: RECENT_BOARDS_LIMIT }, (_unused, index) => `B${index}`);
    const next = pushRecentBoards(full, '新来的');
    expect(next).toHaveLength(RECENT_BOARDS_LIMIT);
    expect(next[0]).toBe('新来的');
    // 被挤掉的是最后那一条（最旧的）
    expect(next).not.toContain(`B${RECENT_BOARDS_LIMIT - 1}`);
  });

  it('上限为 0 时什么都不留（但空列表仍返回原引用）', () => {
    const empty: string[] = [];
    expect(pushRecentBoards(empty, 'A', 0)).toBe(empty);
    expect(pushRecentBoards(['A'], 'B', 0)).toEqual([]);
  });
});

describe('renameRecentBoards：白板改名时搬走历史里的那条路径', () => {
  it('命中就换掉，位置不变', () => {
    expect(renameRecentBoards(['A', 'B', 'C'], 'B', 'B2')).toEqual(['A', 'B2', 'C']);
  });

  it('★ 没命中 → 返回原引用（库里绝大多数改名与这个列表无关）', () => {
    const list = ['A', 'B'];
    expect(renameRecentBoards(list, 'Z', 'Z2')).toBe(list);
  });

  it('空列表返回原引用', () => {
    const list: string[] = [];
    expect(renameRecentBoards(list, 'A', 'B')).toBe(list);
  });

  it('新路径本来就在列表里（改回原名）→ 只留靠前的那一条，不出现两行同一块板', () => {
    expect(renameRecentBoards(['A', 'B'], 'B', 'A')).toEqual(['A']);
    expect(renameRecentBoards(['A', 'B'], 'A', 'B')).toEqual(['B']);
  });
});

describe('normalizeRecentBoards：data.json 里的东西一律不可信', () => {
  it('不是数组 → 空列表', () => {
    expect(normalizeRecentBoards(undefined)).toEqual([]);
    expect(normalizeRecentBoards(null)).toEqual([]);
    expect(normalizeRecentBoards('Boards/A.nboard')).toEqual([]);
    expect(normalizeRecentBoards({ 0: 'A' })).toEqual([]);
  });

  it('丢掉非字符串项，而不是整份设置加载失败', () => {
    expect(normalizeRecentBoards(['A', 42, null, { path: 'B' }, 'C'])).toEqual(['A', 'C']);
  });

  it('去空白、去重、**保持原顺序**（顺序就是"最近"这件事本身）', () => {
    expect(normalizeRecentBoards([' B ', 'A', 'B', '  ', 'A'])).toEqual(['B', 'A']);
  });

  it('截断到上限，多出来的丢掉', () => {
    const tooMany = Array.from({ length: RECENT_BOARDS_LIMIT + 5 }, (_unused, i) => `B${i}`);
    const next = normalizeRecentBoards(tooMany);
    expect(next).toHaveLength(RECENT_BOARDS_LIMIT);
    expect(next[0]).toBe('B0');
  });
});
