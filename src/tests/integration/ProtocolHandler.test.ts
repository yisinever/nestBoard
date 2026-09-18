/**
 * 白板 URI 的解析与生成（T5.06 / `F10-06`）。
 *
 * 这里钉的是**边界**，不是"happy path 能跑"：
 * 手写链接最常见的几种写法（省扩展名、反斜杠、多打一个 `/`）必须放过去，
 * 而越界路径与非白板文件必须挡住 —— 后两条是安全底线，不是体验问题。
 */

import { describe, expect, it } from 'vitest';
import {
  buildNestboardUri,
  NESTBOARD_PROTOCOL,
  parseNestboardUri,
} from '../../integration/ProtocolHandler';

/** 模拟 Obsidian 交给协议处理器的那一步：params 里的值**已经解码过一次** */
function fromUri(uri: string): Record<string, unknown> {
  const query = uri.slice(uri.indexOf('?') + 1);
  const params: Record<string, unknown> = {};
  for (const pair of query.split('&')) {
    const [key = '', value = ''] = pair.split('=');
    params[decodeURIComponent(key)] = decodeURIComponent(value);
  }
  return params;
}

describe('白板 URI：file 参数的宽容面（人手写链接时会做的事）', () => {
  it('标准写法：原样通过', () => {
    expect(parseNestboardUri({ file: 'Boards/A.nboard' })).toEqual({
      ok: true,
      uri: { path: 'Boards/A.nboard', cardId: null },
    });
  });

  it('省掉扩展名：补上（`Boards/A` → `Boards/A.nboard`）', () => {
    const result = parseNestboardUri({ file: 'Boards/A' });
    expect(result.ok && result.uri.path).toBe('Boards/A.nboard');
  });

  it('目录名里带点不会把"省扩展名"误判成"写错扩展名"', () => {
    const result = parseNestboardUri({ file: '我的笔记 v1.2/A' });
    expect(result.ok && result.uri.path).toBe('我的笔记 v1.2/A.nboard');
  });

  it('多打的前导斜杠：去掉（`/Boards/A.nboard` 是最常见的写法）', () => {
    const result = parseNestboardUri({ file: '/Boards/A.nboard' });
    expect(result.ok && result.uri.path).toBe('Boards/A.nboard');
  });

  it('反斜杠（Windows 习惯）：归一化成正斜杠', () => {
    const result = parseNestboardUri({ file: 'Boards\\子目录\\A.nboard' });
    expect(result.ok && result.uri.path).toBe('Boards/子目录/A.nboard');
  });

  it('前后空白：去掉（从聊天软件粘过来常常带一个尾空格）', () => {
    const result = parseNestboardUri({ file: '  Boards/A.nboard  ' });
    expect(result.ok && result.uri.path).toBe('Boards/A.nboard');
  });

  it('扩展名大小写不敏感，但归一化后统一小写', () => {
    const result = parseNestboardUri({ file: 'Boards/A.NBOARD' });
    expect(result.ok && result.uri.path).toBe('Boards/A.nboard');
  });

  it('路径里本来就含 `%`：原样保留，绝不做第二次解码', () => {
    // 库里的文件名真的可能是 `100%完成.nboard`。再解一次轻则路径错，重则抛 URIError
    const result = parseNestboardUri({ file: 'Boards/100%完成.nboard' });
    expect(result.ok && result.uri.path).toBe('Boards/100%完成.nboard');
  });

  it('别名 `path` / `board` 也认；不认识的参数一律忽略（协议要能向后加字段）', () => {
    expect(parseNestboardUri({ path: 'A.nboard' }).ok).toBe(true);
    expect(parseNestboardUri({ board: 'A.nboard' }).ok).toBe(true);
    expect(parseNestboardUri({ file: 'A.nboard', vault: '别的库', 未来字段: 'x' }).ok).toBe(true);
  });
});

describe('白板 URI：拒绝面（安全底线）', () => {
  it('没有 file（或只有空白）：missing-file', () => {
    expect(parseNestboardUri({})).toEqual({ ok: false, reason: 'missing-file' });
    expect(parseNestboardUri({ file: '   ' })).toEqual({ ok: false, reason: 'missing-file' });
    expect(parseNestboardUri({ file: '/' })).toEqual({ ok: false, reason: 'missing-file' });
  });

  it('file 不是字符串（`?file=123`）：当作没写', () => {
    expect(parseNestboardUri({ file: 123 })).toEqual({ ok: false, reason: 'missing-file' });
    expect(parseNestboardUri({ file: ['A.nboard'] })).toEqual({
      ok: false,
      reason: 'missing-file',
    });
  });

  it('指的不是白板：not-a-board（这不是笔误，是指错东西了）', () => {
    expect(parseNestboardUri({ file: '笔记/A.md' })).toEqual({ ok: false, reason: 'not-a-board' });
    expect(parseNestboardUri({ file: '图.canvas' })).toEqual({ ok: false, reason: 'not-a-board' });
    expect(parseNestboardUri({ file: '附件/report.pdf' })).toEqual({
      ok: false,
      reason: 'not-a-board',
    });
  });

  it('`..` 一律拒绝：开头（`../A.nboard`）', () => {
    expect(parseNestboardUri({ file: '../私密/A.nboard' })).toEqual({
      ok: false,
      reason: 'outside-vault',
    });
  });

  it('`..` 一律拒绝：夹在中间（`Boards/../私密/A.nboard`）', () => {
    // ★ 归一化之后才判，就是为了这一条：只看开头是不是 `..` 会把它漏过去
    expect(parseNestboardUri({ file: 'Boards/../私密/A.nboard' })).toEqual({
      ok: false,
      reason: 'outside-vault',
    });
  });

  it('`..` 一律拒绝：反斜杠写法（`..\\私密\\A.nboard`）也不能绕过去', () => {
    expect(parseNestboardUri({ file: '..\\私密\\A.nboard' })).toEqual({
      ok: false,
      reason: 'outside-vault',
    });
  });

  it('`..` 单独一段（`Boards/../A.nboard` 去掉前导点也一样）', () => {
    expect(parseNestboardUri({ file: './../A.nboard' })).toEqual({
      ok: false,
      reason: 'outside-vault',
    });
  });
});

describe('白板 URI：card 参数', () => {
  it('带上 card：定位到那张卡', () => {
    const result = parseNestboardUri({ file: 'A.nboard', card: 'c_01H8' });
    expect(result.ok && result.uri.cardId).toBe('c_01H8');
  });

  it('没有 card / card 是空白：cardId 为 null（= 只打开板，不动视口）', () => {
    const noCard = parseNestboardUri({ file: 'A.nboard' });
    expect(noCard.ok && noCard.uri.cardId).toBeNull();
    const blankCard = parseNestboardUri({ file: 'A.nboard', card: '  ' });
    expect(blankCard.ok && blankCard.uri.cardId).toBeNull();
  });

  it('别名 `cardId` 也认', () => {
    const result = parseNestboardUri({ file: 'A.nboard', cardId: 'c_9' });
    expect(result.ok && result.uri.cardId).toBe('c_9');
  });

  it('指向一张不存在的卡不会让解析失败：定位那一步自己会静默放弃', () => {
    // 卡片可能刚被删掉，而链接还留在某个笔记里。这不该报错，只该"落在板上、不动视口"
    const result = parseNestboardUri({ file: 'A.nboard', card: '已经不在了' });
    expect(result.ok).toBe(true);
  });
});

describe('白板 URI：生成（与 README / 说明书共用同一份格式）', () => {
  it('空格与斜杠都要编码 —— 这正是文档里手抄最容易漏的那个 `%20`', () => {
    expect(buildNestboardUri('Boards/My Board.nboard')).toBe(
      `obsidian://${NESTBOARD_PROTOCOL}?file=Boards%2FMy%20Board.nboard`,
    );
  });

  it('没有 card 时不带 `&card=` 尾巴', () => {
    expect(buildNestboardUri('A.nboard', null)).toBe('obsidian://nestboard?file=A.nboard');
    expect(buildNestboardUri('A.nboard', '')).toBe('obsidian://nestboard?file=A.nboard');
  });

  it('往返：生成再解析（模拟 Obsidian 解码那一步）拿回同样的东西', () => {
    const path = 'Boards/我的 板 A.nboard';
    const parsed = parseNestboardUri(fromUri(buildNestboardUri(path, 'c_01H8')));
    expect(parsed).toEqual({ ok: true, uri: { path, cardId: 'c_01H8' } });
  });

  it('往返：中文、空格、`%` 混在一起也不走样', () => {
    const path = '资料/100%完成 的白板.nboard';
    const parsed = parseNestboardUri(fromUri(buildNestboardUri(path)));
    expect(parsed.ok && parsed.uri.path).toBe(path);
  });
});
