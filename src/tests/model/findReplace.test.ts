/**
 * 查找与替换的模型层单测（用户 2026-09-28 §8.5）。
 *
 * 替换是"批量改用户文字"的操作，错一条就是静默改坏数据 —— 这里钉的是四类坑：
 * 大小写口径、正则元字符当字面量、替换串里的 `$&` 不展开、以及"只改该改的字段"
 * （指针卡 / 坐标 / 颜色一个字节都不能动）。
 */

import { describe, expect, it } from 'vitest';

import { createBoardFile, createCard, createMind } from '../../model/factories';
import type { BoardFile } from '../../model/schema';
import {
  countBoardMatches,
  countMindMatches,
  findBoardMatches,
  findMindMatches,
  replaceBoardMatch,
  replaceMindMatch,
  replaceInBoard,
  replaceInMind,
} from '../../model/findReplace';

function boardWithContents(): BoardFile {
  const board = createBoardFile();
  board.cards = [
    createCard('note', {
      id: 'c1',
      title: '项目计划',
      content: { md: '本周完成 Alpha\n下周 Alpha 复盘', editorMode: 'markdown' },
    }),
    createCard('todo', {
      id: 'c2',
      content: { title: 'Alpha 发布', items: [{ text: 'Alpha 打包', done: false }] },
    }),
  ];
  board.minds = [createMind({ path: '', x: 0, y: 600 })];
  // `createMind` 只造容器：内嵌模型要自己挂（新建卡片那条路走 `newMindModel`）
  const mind = board.minds[0]!;
  mind.mind = {
    id: mind.id,
    revision: 1,
    view: {},
    nodes: [{ id: 'n_root', parentId: null, text: 'Alpha 目标' }],
  } as never;
  return board;
}

describe('countBoardMatches', () => {
  it('跨字段计数：便签 / 待办 / 脑图节点都算', () => {
    const board = boardWithContents();
    // 便签 2 + 待办标题 1 + 待办条目 1 + 节点 1 = 5（"项目计划"这个标题不含 Alpha）
    expect(countBoardMatches(board, 'alpha')).toBe(5);
  });

  it('★ 区分大小写时只算同大小写的', () => {
    const board = boardWithContents();
    expect(countBoardMatches(board, 'Alpha', { matchCase: true })).toBe(5);
    expect(countBoardMatches(board, 'alpha', { matchCase: true })).toBe(0);
  });

  it('空查询恒为 0（"全部替换"对空查询就是什么都不做）', () => {
    const board = boardWithContents();
    expect(countBoardMatches(board, '')).toBe(0);
  });
});

describe('replaceInBoard', () => {
  it('★ 跨字段全部替换并重编号不变；有改动才返回 true', () => {
    const board = boardWithContents();
    expect(replaceInBoard(board, 'Alpha', 'Beta')).toBe(true);
    const note = board.cards[0]!;
    if (note.type === 'note') expect(note.content.md).toBe('本周完成 Beta\n下周 Beta 复盘');
    expect(note.title).toBe('项目计划');
    const todo = board.cards[1]!;
    if (todo.type === 'todo' && 'items' in todo.content) {
      expect(todo.content.title).toBe('Beta 发布');
      expect(todo.content.items[0]?.text).toBe('Beta 打包');
    }
    expect(board.minds?.[0]?.mind?.nodes[0]?.text).toBe('Beta 目标');
    // 没有命中的替换 = false（调用方不提交、不提示）
    expect(replaceInBoard(board, 'Gamma', 'Delta')).toBe(false);
  });

  it('★ 查询里的正则元字符按字面量匹配（"." 不许吃掉别的字）', () => {
    const board = createBoardFile();
    board.cards = [
      createCard('note', { id: 'c1', content: { md: 'a.b 和 aXb', editorMode: 'markdown' } }),
    ];
    expect(replaceInBoard(board, 'a.b', 'OK')).toBe(true);
    const note = board.cards[0]!;
    if (note.type === 'note') expect(note.content.md).toBe('OK 和 aXb');
  });

  it('★ 替换串里的 $& 不展开（函数形式替换的意义）', () => {
    const board = createBoardFile();
    board.cards = [
      createCard('note', { id: 'c1', content: { md: '目标', editorMode: 'markdown' } }),
    ];
    expect(replaceInBoard(board, '目标', '$&-已达成')).toBe(true);
    const note = board.cards[0]!;
    if (note.type === 'note') expect(note.content.md).toBe('$&-已达成');
  });

  it('指针卡与模型里的非文字字段一个字节不动', () => {
    const board = boardWithContents();
    const todo = board.cards.find((card) => card.id === 'c2')!;
    if (todo.type !== 'todo') throw new Error('夹具应是待办卡');
    const before = JSON.stringify(todo.content.items[0]);
    replaceInBoard(board, '不存在的词', 'x');
    const after = board.cards.find((card) => card.id === 'c2')!;
    if (after.type !== 'todo') throw new Error('夹具应是待办卡');
    expect(JSON.stringify(after.content.items[0])).toBe(before);
  });
});

describe('replaceInMind（.nestmind 视图同一份口径）', () => {
  it('节点文字替换；空查询不动', () => {
    const nodes = [
      { id: 'n1', text: '旧词' },
      { id: 'n2', text: '别的' },
    ];
    expect(replaceInMind(nodes, '旧', '新')).toBe(true);
    expect(nodes[0]?.text).toBe('新词');
    expect(replaceInMind(nodes, '', 'x')).toBe(false);
    expect(countMindMatches(nodes, '新')).toBe(1);
  });
});

describe('逐处命中（浮条高亮 / 逐个替换用）', () => {
  it('★ findBoardMatches 给出"哪个对象 / 哪个字段 / 第几到第几"', () => {
    const board = boardWithContents();
    const matches = findBoardMatches(board, 'Alpha');
    expect(matches.length).toBe(5);
    // 第 1 处：便签正文里的第一个 Alpha（md 字段、下标 5 起）
    expect(matches[0]).toEqual({ targetId: 'c1', field: 'md', start: 5, end: 10 });
    // 同一字段里第二处也各占一条（不是合并成"这个字段有命中"）
    expect(matches[1]?.field).toBe('md');
    expect(matches[1]?.start).toBeGreaterThan(matches[0]?.start ?? 0);
  });

  it('★ replaceBoardMatch 只改那一处，别的命中原地不动', () => {
    const board = boardWithContents();
    const first = findBoardMatches(board, 'Alpha')[0]!;
    expect(replaceBoardMatch(board, first, 'Beta')).toBe(true);
    expect(findBoardMatches(board, 'Alpha').length).toBe(4);
    const note = board.cards[0]!;
    if (note.type === 'note') expect(note.content.md).toBe('本周完成 Beta\n下周 Alpha 复盘');
  });

  it('脑图同一套：findMindMatches / replaceMindMatch', () => {
    const nodes = [
      { id: 'n1', text: '甲 乙 甲' },
      { id: 'n2', text: '甲' },
    ];
    const matches = findMindMatches(nodes, '甲');
    expect(matches.map((match) => match.targetId)).toEqual(['n1', 'n1', 'n2']);
    expect(replaceMindMatch(nodes, matches[1]!, '丙')).toBe(true);
    expect(nodes[0]?.text).toBe('甲 乙 丙');
  });
});
