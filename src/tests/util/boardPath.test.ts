/**
 * 白板路径归一化（T5.06 / T5.07）—— `util/boardPath.ts`。
 *
 * 这一份规则**同时**服务于 `obsidian://nestboard?file=` 与设置里的「Home 白板路径」，
 * 所以这里的每一条都等于在两个入口上各钉了一次：
 * 用户在设置里填得进去的路径，一定是他以后手写链接时能用的那一个。
 *
 * 分成"宽容面 / 拒绝面"两组：前者错了只是难用，后者错了是**安全问题**
 * （越界）或**数据问题**（把别的文件当白板打开）。
 */

import { describe, expect, it } from 'vitest';
import { normalizeBoardPath } from '../../util/boardPath';

describe('白板路径归一化：宽容面（人手打的路径）', () => {
  it('标准写法原样通过', () => {
    expect(normalizeBoardPath('Boards/A.nboard')).toEqual({ ok: true, path: 'Boards/A.nboard' });
  });

  it('省掉扩展名 → 补上', () => {
    expect(normalizeBoardPath('Boards/A')).toEqual({ ok: true, path: 'Boards/A.nboard' });
  });

  it('目录名里的点不算扩展名', () => {
    expect(normalizeBoardPath('我的笔记 v1.2/A')).toEqual({
      ok: true,
      path: '我的笔记 v1.2/A.nboard',
    });
  });

  it('前导斜杠去掉（`/Boards/A.nboard` 是最常见的写法）', () => {
    expect(normalizeBoardPath('/Boards/A.nboard')).toEqual({ ok: true, path: 'Boards/A.nboard' });
  });

  it('反斜杠归一化成正斜杠', () => {
    expect(normalizeBoardPath('Boards\\子目录\\A.nboard')).toEqual({
      ok: true,
      path: 'Boards/子目录/A.nboard',
    });
  });

  it('前后空白去掉（从聊天软件粘过来常带尾空格）', () => {
    expect(normalizeBoardPath('  Boards/A.nboard  ')).toEqual({
      ok: true,
      path: 'Boards/A.nboard',
    });
  });

  it('扩展名大小写不敏感，但归一化后统一小写', () => {
    expect(normalizeBoardPath('Boards/A.NBOARD')).toEqual({ ok: true, path: 'Boards/A.nboard' });
  });

  it('路径里本来就含 `%` 的照样通过（这里不做任何解码）', () => {
    expect(normalizeBoardPath('Boards/100%完成.nboard')).toEqual({
      ok: true,
      path: 'Boards/100%完成.nboard',
    });
  });

  it('中文与空格都原样保留（不改名，只补规则）', () => {
    expect(normalizeBoardPath('资料/我的 板 A.nboard')).toEqual({
      ok: true,
      path: '资料/我的 板 A.nboard',
    });
  });
});

describe('白板路径归一化：拒绝面（安全与数据底线）', () => {
  it('不是字符串 → empty', () => {
    expect(normalizeBoardPath(123)).toEqual({ ok: false, reason: 'empty' });
    expect(normalizeBoardPath(null)).toEqual({ ok: false, reason: 'empty' });
    expect(normalizeBoardPath(undefined)).toEqual({ ok: false, reason: 'empty' });
  });

  it('空白 / 只有斜杠 → empty', () => {
    expect(normalizeBoardPath('')).toEqual({ ok: false, reason: 'empty' });
    expect(normalizeBoardPath('   ')).toEqual({ ok: false, reason: 'empty' });
    expect(normalizeBoardPath('/')).toEqual({ ok: false, reason: 'empty' });
    expect(normalizeBoardPath('///')).toEqual({ ok: false, reason: 'empty' });
  });

  it('别的扩展名 → not-a-board（这不是笔误，是指错东西了）', () => {
    expect(normalizeBoardPath('笔记/A.md')).toEqual({ ok: false, reason: 'not-a-board' });
    expect(normalizeBoardPath('图.canvas')).toEqual({ ok: false, reason: 'not-a-board' });
    expect(normalizeBoardPath('附件/report.pdf')).toEqual({ ok: false, reason: 'not-a-board' });
  });

  it('`..` 在开头 → outside-vault', () => {
    expect(normalizeBoardPath('../私密/A.nboard')).toEqual({ ok: false, reason: 'outside-vault' });
  });

  it('`..` 夹在中间 → outside-vault（只看开头会漏掉这一种）', () => {
    expect(normalizeBoardPath('Boards/../私密/A.nboard')).toEqual({
      ok: false,
      reason: 'outside-vault',
    });
  });

  it('`..` 用反斜杠写也拦得住', () => {
    expect(normalizeBoardPath('..\\私密\\A.nboard')).toEqual({
      ok: false,
      reason: 'outside-vault',
    });
  });

  it('`./..` 这种一样拦（`..` 是**按段**判的，不是按前缀）', () => {
    expect(normalizeBoardPath('./../A.nboard')).toEqual({ ok: false, reason: 'outside-vault' });
  });

  it('`..` 藏在后面（`Boards/子/../A.nboard`）也拦 —— 归一化之后没有"干净的 `..`"', () => {
    expect(normalizeBoardPath('Boards/子/../A.nboard')).toEqual({
      ok: false,
      reason: 'outside-vault',
    });
  });
});
