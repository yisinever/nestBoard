import { describe, expect, it } from 'vitest';
import {
  cardLabel,
  conflictBasePath,
  diffBoards,
  digestBoard,
  findConflictCopies,
  isConflictBoardPath,
} from '../../io/conflict';
import { serializeBoard } from '../../io/BoardRepository';
import { createBoardFile, createCard } from '../../model/factories';
import type { BoardFile, Card } from '../../model/schema';
import { MemoryVaultIO } from '../helpers/memoryVault';

// ─────────────────────────────────────────────────────────────
// 文件名识别
// ─────────────────────────────────────────────────────────────

describe('conflictBasePath（T4.03 / 03 §3.4）', () => {
  it.each([
    // [冲突副本路径, 推断出的原板路径]
    ['Boards/父版.nboard.conflict-1712', 'Boards/父版.nboard'],
    ['Boards/父版.nboard.conflict', 'Boards/父版.nboard'],
    ['Boards/父版.conflict-1712.nboard', 'Boards/父版.nboard'],
    ['Boards/父版.conflict.nboard', 'Boards/父版.nboard'],
    ['Boards/父版.sync-conflict-20260912-101500-ABCDEF.nboard', 'Boards/父版.nboard'],
    ['Boards/父版 (conflicted copy 2026-09-12).nboard', 'Boards/父版.nboard'],
    ['Boards/父版 (case conflict).nboard', 'Boards/父版.nboard'],
    ['Boards/父版 (conflict 2026-09-11T02-00-00).nboard', 'Boards/父版.nboard'],
    // 顶层（无目录）同样要认得出
    ['父版.nboard.conflict-1', '父版.nboard'],
    // 原板名里本身带点：不能被"最后一个点"这种朴素做法截错
    ['Boards/我的板.2024.nboard.conflict-1', 'Boards/我的板.2024.nboard'],
  ])('%s → %s', (path, base) => {
    expect(conflictBasePath(path)).toBe(base);
    expect(isConflictBoardPath(path)).toBe(true);
  });

  it.each([
    ['Boards/父版.nboard'],
    ['Notes/普通笔记.md'],
    // 名字里出现 "conflict" 但没有任何标记形态的，是**正常板**，不能误判
    ['Boards/My conflict board.nboard'],
    ['Boards/sync-conflict.nboard'],
    [''],
  ])('正常文件不误判：%s', (path) => {
    expect(conflictBasePath(path)).toBeNull();
    expect(isConflictBoardPath(path)).toBe(false);
  });
});

describe('findConflictCopies', () => {
  it('扫出全部冲突副本（含扩展名不是 nboard 的那一类），按路径排序', async () => {
    const vault = new MemoryVaultIO({
      // ★ 这一类的扩展名是 `conflict-1742`，按扩展名过滤的扫描会整类漏掉
      'Boards/B.nboard.conflict-1742': '{}',
      'Boards/A.sync-conflict-20260912-101500-ABCDEF.nboard': '{}',
      'Boards/A.nboard': '{}',
      'Notes/日常.md': '# 笔记',
    });

    const copies = await findConflictCopies(vault);

    expect(copies.map((copy) => copy.path)).toEqual([
      'Boards/A.sync-conflict-20260912-101500-ABCDEF.nboard',
      'Boards/B.nboard.conflict-1742',
    ]);
    expect(copies[0]?.basePath).toBe('Boards/A.nboard');
    expect(copies[1]?.basePath).toBe('Boards/B.nboard');
  });

  it('没有冲突副本时返回空数组', async () => {
    const vault = new MemoryVaultIO({ 'Boards/A.nboard': '{}' });
    expect(await findConflictCopies(vault)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
// 两块板的对比
// ─────────────────────────────────────────────────────────────

function board(title: string, cards: Card[], revision = 1): BoardFile {
  return createBoardFile({
    revision,
    meta: { id: 'nb_x', title, parent: null },
    cards,
  });
}

function note(id: string, md: string): Card {
  return createCard('note', { id, content: { md } });
}

describe('diffBoards（T4.03）', () => {
  it('按卡片 id 对齐，算出 same / 各自独有 / 内容有差异', () => {
    const left = board('左', [
      note('c1', '都一样'),
      note('c2', '左边改过'),
      note('c3', '只在左边'),
    ]);
    const right = board('右', [
      note('c1', '都一样'),
      note('c2', '右边改过'),
      note('c4', '只在右边'),
    ]);

    const diff = diffBoards(left, right);

    expect(diff.counts).toEqual({ same: 1, changed: 1, 'left-only': 1, 'right-only': 1 });
    expect(diff.rows.map((row) => [row.id, row.status])).toEqual([
      ['c1', 'same'],
      ['c2', 'changed'],
      ['c3', 'left-only'],
      ['c4', 'right-only'],
    ]);
  });

  it('行顺序：先走左板的顺序，只有副本才有的卡片追加在最后', () => {
    // 右侧把 c1 排到了 c2 后面 —— 但对比顺序必须跟着**左侧**，否则行会对不齐
    const left = board('左', [note('c1', 'a'), note('c2', 'b')]);
    const right = board('右', [note('c2', 'b'), note('c1', 'a'), note('c9', '新')]);

    const diff = diffBoards(left, right);

    expect(diff.rows.map((row) => row.id)).toEqual(['c1', 'c2', 'c9']);
    expect(diff.counts.same).toBe(2);
  });

  it('只有一侧存在的卡片，另一侧文本是 null（界面上显示为占位）', () => {
    const diff = diffBoards(board('左', [note('c1', 'x')]), board('右', [note('c2', 'y')]));

    expect(diff.rows[0]).toMatchObject({ id: 'c1', status: 'left-only', left: 'x', right: null });
    expect(diff.rows[1]).toMatchObject({ id: 'c2', status: 'right-only', left: null, right: 'y' });
  });

  it('位置 / 尺寸变化也算"有差异"（同一张卡被拖动过）', () => {
    const left = board('左', [createCard('note', { id: 'c1', x: 0, y: 0 })]);
    const right = board('右', [createCard('note', { id: 'c1', x: 400, y: 0 })]);

    expect(diffBoards(left, right).counts.changed).toBe(1);
  });

  it('摘要带上卡片 / 分栏 / 连线数量与修订号', () => {
    const one = board('左', [note('c1', 'a')], 7);
    const digest = digestBoard(one);
    expect(digest).toMatchObject({ title: '左', cards: 1, columns: 0, edges: 0, revision: 7 });

    const diff = diffBoards(one, board('右', [], 9));
    expect(diff.right.revision).toBe(9);
    expect(diff.left.revision).toBe(7);
  });
});

describe('cardLabel', () => {
  it('便签取 content.md（只认 text/title 的话一屏全是 [note]）', () => {
    expect(cardLabel(note('c1', '第一行\n第二行'))).toBe('第一行 第二行');
  });

  it('卡片自带的 title 优先于正文', () => {
    expect(cardLabel(createCard('note', { title: '卡片标题', content: { md: '正文' } }))).toBe(
      '卡片标题',
    );
  });

  it('待办取第一条 items[].text；色板退到颜色值', () => {
    expect(
      cardLabel(
        createCard('todo', {
          content: { title: '清单', items: [{ text: '买牛奶', done: false }] },
        }),
      ),
    ).toBe('清单');
    // 没有标题时退到第一条待办项 —— 只认字符串字段的话这里会是空的
    expect(
      cardLabel(createCard('todo', { content: { items: [{ text: '买牛奶', done: false }] } })),
    ).toBe('买牛奶');
    expect(cardLabel(createCard('swatch', { content: { colors: ['#ff0000'] } }))).toBe('#ff0000');
  });

  it('挤不出任何文本时退回类型名（而不是空串 —— 空串会被误读成"这张卡没内容"）', () => {
    expect(cardLabel(createCard('note'))).toBe('note');
    expect(cardLabel(createCard('ink'))).toBe('ink');
  });

  it('过长的正文截断到一行 80 字', () => {
    const label = cardLabel(note('c1', 'x'.repeat(200)));
    expect(label).toHaveLength(81);
    expect(label.endsWith('…')).toBe(true);
  });

  it('路径类内容（noteRef / boardRef）也要能显示', () => {
    expect(cardLabel(createCard('noteRef', { content: { path: 'Notes/会议.md' } }))).toBe(
      'Notes/会议.md',
    );
  });
});

// ─────────────────────────────────────────────────────────────
// 与序列化过的真实文件对得上
// ─────────────────────────────────────────────────────────────

describe('conflict scan + serializeBoard 串联', () => {
  it('能读回落在库里的冲突副本（用来算差异的那条路）', async () => {
    const original = board('父版', [note('c1', '原样')]);
    const copy = board('父版', [note('c1', '原样'), note('c2', '副本里新加的')]);

    const vault = new MemoryVaultIO({
      'Boards/父版.nboard': serializeBoard(original),
      'Boards/父版.sync-conflict-20260912-101500-ABCDEF.nboard': serializeBoard(copy),
    });

    const [found] = await findConflictCopies(vault);
    expect(found?.basePath).toBe('Boards/父版.nboard');

    const left = JSON.parse(await vault.read('Boards/父版.nboard')) as BoardFile;
    const right = JSON.parse(await vault.read(found!.path)) as BoardFile;
    expect(diffBoards(left, right).counts['right-only']).toBe(1);
  });
});
