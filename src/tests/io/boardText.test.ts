import { describe, expect, it } from 'vitest';
import { parseBoardFile, readBoardManifest } from '../../io/boardText';
import { serializeBoard } from '../../io/BoardRepository';
import { createBoardFile, createCard } from '../../model/factories';

function sample(): string {
  return serializeBoard(
    createBoardFile({
      revision: 12,
      meta: { id: 'nb_sample', title: '样例', parent: null },
      cards: [createCard('note', { id: 'c1', content: { md: '正文' } })],
    }),
  );
}

describe('parseBoardFile（T4.03 / T4.04 共用的"文本 → 模型"）', () => {
  it('读得回一块正常的白板', () => {
    const board = parseBoardFile(sample());
    expect(board?.meta.id).toBe('nb_sample');
    expect(board?.revision).toBe(12);
    expect(board?.cards).toHaveLength(1);
  });

  it('坏 JSON / 不是白板 / 空串 → null（调用方按"读不出"处理，不需要原因）', () => {
    expect(parseBoardFile('{ 不是 JSON')).toBeNull();
    // ★ 这一条是刻意的：迁移会给任何对象盖上 spec/version，若在盖章之后再判信封，
    //   `{"hello":"world"}` 会变成"一块 0 张卡的白板"，在对比视图里显示成"两边一样"
    expect(parseBoardFile('{"hello":"world"}')).toBeNull();
    expect(parseBoardFile('')).toBeNull();
    expect(parseBoardFile('null')).toBeNull();
  });

  it('手写的精简白板仍然能读（信封判定不能收紧到"必须有 spec"）', () => {
    expect(parseBoardFile('{"meta":{"id":"nb_hand"},"cards":[]}')?.meta.id).toBe('nb_hand');
    expect(parseBoardFile('{"spec":"nestboard/1","cards":[]}')?.cards).toEqual([]);
  });

  it('读出来的模型是**新对象**，改它不会影响原文本', () => {
    const raw = sample();
    const board = parseBoardFile(raw);
    board!.meta.title = '改过';
    expect(parseBoardFile(raw)?.meta.title).toBe('样例');
  });
});

describe('readBoardManifest（删除前打快照只需要 id + revision）', () => {
  it('抽得出 id 与 revision', () => {
    expect(readBoardManifest(sample())).toEqual({ id: 'nb_sample', revision: 12 });
  });

  it('★ 容忍内容残缺：卡片坏掉、字段缺失都不影响 id/revision 的抽取', () => {
    expect(
      readBoardManifest('{"revision":3,"meta":{"id":"nb_x"},"cards":[{"bogus":true},null]}'),
    ).toEqual({ id: 'nb_x', revision: 3 });
  });

  it('JSON 语法本身就是坏的（被同步工具截断）→ null：连"是什么"都读不出来', () => {
    expect(readBoardManifest('{"revision":3,"meta":{"id":"nb_x"},"cards":[{"id"')).toBeNull();
  });

  it('缺 revision 时按 0 处理（快照目录只认 id）', () => {
    expect(readBoardManifest('{"meta":{"id":"nb_x"}}')).toEqual({ id: 'nb_x', revision: 0 });
  });

  it('拿不到 id 就放弃（否则会把快照塞进一个凭空的目录）', () => {
    expect(readBoardManifest('{"revision":1,"meta":{}}')).toBeNull();
    expect(readBoardManifest('{"revision":1,"meta":{"id":""}}')).toBeNull();
    expect(readBoardManifest('{"revision":1}')).toBeNull();
    expect(readBoardManifest('[]')).toBeNull();
    expect(readBoardManifest('不是 JSON')).toBeNull();
  });
});
