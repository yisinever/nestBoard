/**
 * 引用清单与断链判定（T3.19 / `F8-07`）。
 *
 * 这一层要保证两件事：
 *
 *  * **引用清单完整**：每张"指向外部"的卡片都产出一条，且顺序跟着 `board.cards`
 *    （总览里的条目顺序不该每次重算都不一样）；
 *  * **判定与清单分离**：存在性由调用方注入，所以"总览列出的"与"过滤认为断链的"
 *    永远来自同一份清单、同一套判定 —— 这是 `links.ts` 拆成两段的核心动机。
 */

import { describe, expect, it } from 'vitest';
import { createBoardFile, createCard } from '../../model/factories';
import {
  brokenRefsOf,
  collectRefs,
  isUsableUrl,
  refExistsInVault,
  refsOfCard,
} from '../../model/links';
import type { CardRef } from '../../model/links';

/** 一个"路径类"引用（`link` 之外的四种形状一致，判定只看 `kind` 与 `path`） */
function pathRef(path: string, kind: CardRef['kind'] = 'image'): CardRef {
  return { cardId: 'c', cardTitle: '卡', cardType: 'image', kind, path };
}

describe('refsOfCard', () => {
  it('四种路径类卡片各产出一条引用', () => {
    const image = refsOfCard(
      createCard('image', { title: '卡', content: { path: 'assets/a.png' } }),
    );
    expect(image).toHaveLength(1);
    expect(image[0]).toMatchObject({
      kind: 'image',
      path: 'assets/a.png',
      cardTitle: '卡',
      cardType: 'image',
    });

    const file = refsOfCard(createCard('file', { content: { path: 'files/b.pdf' } }));
    expect(file[0]).toMatchObject({ kind: 'file', path: 'files/b.pdf' });

    const note = refsOfCard(
      createCard('noteRef', { content: { path: 'notes/c.md', subpath: '#小节' } }),
    );
    // `subpath` 只影响"读哪一段"，不影响"是哪篇笔记"
    expect(note[0]).toMatchObject({ kind: 'noteRef', path: 'notes/c.md' });

    const board = refsOfCard(createCard('boardRef', { content: { path: 'Boards/d.nboard' } }));
    expect(board[0]).toMatchObject({ kind: 'boardRef', path: 'Boards/d.nboard' });
  });

  it('链接卡取 URL（不碰 Vault）', () => {
    const refs = refsOfCard(createCard('link', { content: { url: ' https://example.com ' } }));
    // 路径两侧的空白必须去掉：留着它，URL 校验会当成"含空格的句子"直接判死
    expect(refs[0]).toMatchObject({ kind: 'link', path: 'https://example.com' });
  });

  it('纯白板内的卡片永不产生引用（它们不指向外部世界）', () => {
    expect(refsOfCard(createCard('note', { content: { md: '正文' } }))).toEqual([]);
    expect(refsOfCard(createCard('todo', { content: { items: [] } }))).toEqual([]);
    expect(refsOfCard(createCard('swatch', { content: { colors: ['#ffffff'] } }))).toEqual([]);
    expect(refsOfCard(createCard('ink', { content: { paths: [] } }))).toEqual([]);
  });

  it('空路径不算引用（刚建好还没选文件的卡不该报"断链"）', () => {
    expect(refsOfCard(createCard('image', { content: { path: '   ' } }))).toEqual([]);
  });
});

describe('collectRefs', () => {
  it('按 board.cards 顺序摊平', () => {
    const board = createBoardFile({
      cards: [
        createCard('note', { content: { md: '' } }),
        createCard('image', { content: { path: 'a.png' } }),
        createCard('link', { content: { url: 'https://example.com' } }),
        createCard('boardRef', { content: { path: 'B.nboard' } }),
      ],
    });

    expect(collectRefs(board).map((ref) => ref.kind)).toEqual(['image', 'link', 'boardRef']);
  });
});

describe('refExistsInVault', () => {
  it('路径类用注入的 exists', () => {
    const present = (path: string): boolean => path === 'a.png';
    expect(refExistsInVault(pathRef('a.png'), present)).toBe(true);
    expect(refExistsInVault(pathRef('gone.png'), present)).toBe(false);
  });

  it('链接类看 URL 是否成立，与 Vault 无关', () => {
    const never = (): boolean => false;
    expect(refExistsInVault(pathRef('example.com', 'link'), never)).toBe(true);
    expect(refExistsInVault(pathRef('not a url', 'link'), never)).toBe(false);
  });
});

describe('isUsableUrl', () => {
  it('就是这套 URL 判定的单点', () => {
    expect(isUsableUrl(pathRef('https://example.com', 'link'))).toBe(true);
    expect(isUsableUrl(pathRef('不是链接', 'link'))).toBe(false);
  });
});

describe('brokenRefsOf', () => {
  it('只留下判定为不存在的引用', () => {
    const board = createBoardFile({
      cards: [
        createCard('image', { content: { path: 'ok.png' } }),
        createCard('image', { content: { path: 'gone.png' } }),
        createCard('boardRef', { content: { path: 'Missing.nboard' } }),
      ],
    });

    const broken = brokenRefsOf(board, (ref) => ref.path === 'ok.png');

    expect(broken.map((ref) => ref.path)).toEqual(['gone.png', 'Missing.nboard']);
    // 每一条都记得"是哪张卡断的"，总览才能点得回去
    expect(broken.every((ref) => ref.cardId.length > 0)).toBe(true);
  });
});
