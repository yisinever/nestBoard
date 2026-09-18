/**
 * 跨白板搜索侧栏的纯逻辑（T7.02 / `F8-08`）—— `ui/boardSearch.ts`。
 *
 * 这三件事都属于"错了不报错，只表现为怪"，所以逐条钉住：
 *
 *  * `statusText` —— 把"正在索引"说成"没有结果"，用户会以为功能坏了；
 *  * `snippetParts` —— 切错位置就是**静默丢字 / 重复字**，屏幕上只像"这句话读起来怪"；
 *  * `boardSearchSignature` —— 指纹漏字段会"内容变了却不重画"，多字段会狂闪。
 *
 * ★ 文案断言一律写成 `t(同一个 key, 同一组参数)`，不写死中英文字符串：
 *   写死的话每改一次措辞就要改一次测试，最后没人改，测试变成摆设。
 */

import { describe, expect, it } from 'vitest';
import type { BoardMatch, BoardSearchHit, BoardSearchStatus } from '../../model/boardSearch';
import { boardSearchSignature, snippetParts, statusText } from '../../ui/boardSearch';
import { t } from '../../util/i18n';

function hit(overrides: Partial<BoardSearchHit> = {}): BoardSearchHit {
  return {
    cardId: 'card-1',
    type: 'note',
    field: 'text',
    title: '',
    snippet: '季度预算复核',
    matchStart: 2,
    matchLength: 2,
    boardPath: 'a.nboard',
    boardTitle: '甲',
    ...overrides,
  };
}

describe('statusText', () => {
  it('空查询 → "输入关键词"那句，而不是"没有结果"', () => {
    expect(statusText({ kind: 'hint' })).toBe(t('boardSearch.hint'));
  });

  it('★ 扫描没走完时说的是"正在索引"，带的是**已扫进度**', () => {
    const status: BoardSearchStatus = { kind: 'empty', scanned: 3, indexed: 3, scanning: true };

    expect(statusText(status)).toBe(t('boardSearch.scanning', { scanned: 3 }));
    // 与"确实没有"必须是两句不同的话 —— 混成一句就等于把"还没找"说成"找不到"
    expect(statusText(status)).not.toBe(
      statusText({ kind: 'empty', scanned: 3, indexed: 3, scanning: false }),
    );
  });

  it('扫描走完后报的是**扫过多少块板**（用户据此判断"该有的东西是不是真没有"）', () => {
    expect(statusText({ kind: 'empty', scanned: 12, indexed: 12, scanning: false })).toBe(
      t('boardSearch.empty', { indexed: 12 }),
    );
  });

  it('有结果时报条数与板数', () => {
    expect(statusText({ kind: 'count', hits: 5, boards: 2, scanning: false })).toBe(
      t('boardSearch.count', { hits: 5, boards: 2 }),
    );
  });

  it('★ 有结果但仍在索引 → 是另一句（把"还有没扫到的"讲清楚）', () => {
    const scanning = statusText({ kind: 'count', hits: 5, boards: 2, scanning: true });

    expect(scanning).toBe(t('boardSearch.countScanning', { hits: 5, boards: 2 }));
    expect(scanning).not.toBe(statusText({ kind: 'count', hits: 5, boards: 2, scanning: false }));
  });
});

describe('snippetParts', () => {
  it('按命中位置切成三段', () => {
    expect(snippetParts('季度预算复核', 2, 2)).toEqual({
      before: '季度',
      match: '预算',
      after: '复核',
    });
  });

  it('命中在开头 / 结尾时，切出来的空段是空串（不是 `undefined`）', () => {
    expect(snippetParts('预算复核', 0, 2)).toEqual({
      before: '',
      match: '预算',
      after: '复核',
    });
    expect(snippetParts('季度预算', 2, 2)).toEqual({
      before: '季度',
      match: '预算',
      after: '',
    });
  });

  it('空片段 → 三段都空', () => {
    expect(snippetParts('', 0, 0)).toEqual({ before: '', match: '', after: '' });
  });

  it('★ 越界夹住，且 `before + match + after` 恒等于原片段（一个字都不许丢或重）', () => {
    // 越界在正常路径上不会发生，但一旦发生（片段被截断、规则改了），
    // 不夹住的结果是**静默丢字 / 重复字** —— 屏幕上只表现为"读起来有点怪"
    const cases: [string, number, number][] = [
      ['预算', 10, 2],
      ['预算', -3, 2],
      ['预算', 1, 99],
      ['预算', 0, -5],
      ['预算', Number.NaN, 1],
      ['预算', 1, Number.NaN],
    ];

    for (const [snippet, start, length] of cases) {
      const parts = snippetParts(snippet, start, length);
      expect(parts.before + parts.match + parts.after).toBe(snippet);
      // 夹住之后 `match` 一定落在片段之内
      expect(snippet).toContain(parts.match);
    }
  });
});

describe('boardSearchSignature', () => {
  const status: BoardSearchStatus = { kind: 'count', hits: 1, boards: 0, scanning: false };
  const boards: BoardMatch[] = [];

  it('同一份内容 → 同一个指纹（否则列表会在启动时不停闪）', () => {
    const a = boardSearchSignature('预算', status, [hit()], boards);
    const b = boardSearchSignature('预算', status, [hit()], boards);

    expect(a).toBe(b);
  });

  it('查询词变了 → 指纹变', () => {
    expect(boardSearchSignature('预算', status, [hit()], boards)).not.toBe(
      boardSearchSignature('复核', status, [hit()], boards),
    );
  });

  it('★ 片段、命中位置、命中长度任一变化，指纹都得变', () => {
    const base = boardSearchSignature('预算', status, [hit()], boards);

    // 命中位置变了但"片段 + 命中词"看起来没变：只比片段就会漏掉这次变化
    expect(boardSearchSignature('预算', status, [hit({ matchStart: 3 })], boards)).not.toBe(base);
    expect(boardSearchSignature('预算', status, [hit({ matchLength: 1 })], boards)).not.toBe(base);
    expect(boardSearchSignature('预算', status, [hit({ snippet: '别的句子' })], boards)).not.toBe(
      base,
    );
  });

  it('卡片 / 板路径 / 字段变了 → 指纹变', () => {
    const base = boardSearchSignature('预算', status, [hit()], boards);

    expect(boardSearchSignature('预算', status, [hit({ cardId: 'c2' })], boards)).not.toBe(base);
    expect(boardSearchSignature('预算', status, [hit({ boardPath: 'b.nboard' })], boards)).not.toBe(
      base,
    );
    expect(boardSearchSignature('预算', status, [hit({ field: 'title' })], boards)).not.toBe(base);
  });

  it('条数变了 → 指纹变', () => {
    expect(boardSearchSignature('预算', status, [hit(), hit()], boards)).not.toBe(
      boardSearchSignature('预算', status, [hit()], boards),
    );
  });

  it('★ 进度数字进了指纹（扫描往前走了，状态行那句"已索引 n 块"就该重写）', () => {
    const early: BoardSearchStatus = { kind: 'empty', scanned: 3, indexed: 3, scanning: true };
    const later: BoardSearchStatus = { kind: 'empty', scanned: 9, indexed: 9, scanning: true };

    expect(boardSearchSignature('预算', early, [], boards)).not.toBe(
      boardSearchSignature('预算', later, [], boards),
    );
    // `scanning` 翻转同样要重写（"仍在索引…"那句要消失）
    expect(boardSearchSignature('预算', early, [], boards)).not.toBe(
      boardSearchSignature('预算', { ...early, scanning: false }, [], boards),
    );
  });

  it('板名命中的白板变了 → 指纹变', () => {
    const one: BoardMatch[] = [{ path: 'a.nboard', title: '甲' }];
    const two: BoardMatch[] = [
      { path: 'a.nboard', title: '甲' },
      { path: 'b.nboard', title: '乙' },
    ];

    expect(boardSearchSignature('预算', status, [], one)).not.toBe(
      boardSearchSignature('预算', status, [], two),
    );
  });

  it('★ 字段之间的分隔符让"错位拼接"不会撞成同一个指纹', () => {
    // 没有分隔符时 `query="预算AB" + cardId="C"` 与 `query="预算A" + cardId="BC"`
    // 会拼出同一个字符串 —— 指纹相等就意味着"内容变了却不重画"
    const shifted = boardSearchSignature('预算AB', status, [hit({ cardId: 'C' })], boards);
    const split = boardSearchSignature('预算A', status, [hit({ cardId: 'BC' })], boards);

    expect(shifted).not.toBe(split);
  });
});
