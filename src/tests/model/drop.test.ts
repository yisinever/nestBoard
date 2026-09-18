import { describe, expect, it } from 'vitest';

import { BOARD_EXT } from '../../constants';
import { DEFAULT_CARD_SIZES } from '../../model/factories';
import {
  DROP_CASCADE_STEP,
  baseNameOf,
  cardsForDropPaths,
  cascadeOrigins,
  dropHintKey,
  dropKindForPath,
  dropTextPreviewName,
  extensionOf,
  isNotePath,
  noteCardForDropText,
  noteContentFromDropText,
  parseDropPaths,
  resolveDropText,
} from '../../model/drop';

describe('extensionOf', () => {
  it('取小写扩展名', () => {
    expect(extensionOf('a/b/图.PNG')).toBe('png');
    expect(extensionOf('note.md')).toBe('md');
  });

  it('无扩展名 / 目录名里带点 / 开头的点，都不算扩展名', () => {
    expect(extensionOf('README')).toBe('');
    expect(extensionOf('folder.name/file')).toBe('');
    expect(extensionOf('.gitignore')).toBe('');
  });
});

describe('baseNameOf', () => {
  it('取最后一段（带与不带目录）', () => {
    expect(baseNameOf('a/b/图.png')).toBe('图.png');
    expect(baseNameOf('图.png')).toBe('图.png');
  });
});

describe('dropKindForPath', () => {
  it('按扩展名映射到四种可拖入的卡片', () => {
    expect(dropKindForPath('Notes/A.md')).toBe('noteRef');
    expect(dropKindForPath('attachments/pic.webp')).toBe('image');
    expect(dropKindForPath(`Boards/B.${BOARD_EXT}`)).toBe('boardRef');
  });

  it('认不出来的类型退到最通用的文件卡，而不是拒绝', () => {
    expect(dropKindForPath('data/表.xlsx')).toBe('file');
    expect(dropKindForPath('无扩展名')).toBe('file');
  });
});

describe('isNotePath（O14：拖入导入时"要不要改名"的判据）', () => {
  it('两种 md 写法都算笔记', () => {
    expect(isNotePath('Notes/会议纪要.md')).toBe(true);
    expect(isNotePath('Notes/会议纪要.markdown')).toBe(true);
    // 大小写按 `extensionOf` 的规矩一律小写比
    expect(isNotePath('Notes/会议纪要.MD')).toBe(true);
  });

  it('★ 与 dropKindForPath 同判据：不是笔记的就不是（图 / PDF / 无扩展名）', () => {
    for (const path of ['attachments/图.png', 'docs/spec.pdf', 'README', '.gitignore']) {
      expect(isNotePath(path)).toBe(false);
      expect(dropKindForPath(path) === 'noteRef').toBe(false);
    }
  });
});

describe('parseDropPaths', () => {
  it('同时收 wikilink / 嵌入 / markdown 链接 / 裸路径，并去重保序', () => {
    const text = [
      '![[attachments/图.png]]',
      '[[Note#标题|别名]]',
      '[标题](folder/Other.md)',
      'folder/Third.md',
      '[[Note#标题|别名]]',
    ].join('\n');

    expect(parseDropPaths(text)).toEqual([
      'attachments/图.png',
      'Note',
      'folder/Other.md',
      'folder/Third.md',
    ]);
  });

  it('外链与空文本不产生候选', () => {
    expect(parseDropPaths('https://example.com/a.png')).toEqual([]);
    expect(parseDropPaths('   ')).toEqual([]);
  });

  it('markdown 链接目标做百分号解码，裸路径不解码（`50%.md` 是真的文件名）', () => {
    expect(parseDropPaths('[x](a%20b.md)')).toEqual(['a b.md']);
    expect(parseDropPaths('50%.md')).toEqual(['50%.md']);
  });

  it('`file://` 转成本地绝对路径（带不带 host 都认）', () => {
    expect(parseDropPaths('file:///Users/me/pic.png')).toEqual(['/Users/me/pic.png']);
  });

  it('Obsidian 文件浏览器拖拽的 `obsidian://open?file=…` 解成库内相对路径', () => {
    expect(parseDropPaths('obsidian://open?file=Notes%2FA.md')).toEqual(['Notes/A.md']);
    expect(parseDropPaths('obsidian://open?file=Boards%2F%E7%88%B6%E7%89%88.nboard')).toEqual([
      'Boards/父版.nboard',
    ]);
  });

  it('不是 `obsidian://open?file=…` 的 obsidian 链接当外链丢掉', () => {
    expect(parseDropPaths('obsidian://search?query=x')).toEqual([]);
    expect(parseDropPaths('obsidian://open?vault=other')).toEqual([]);
  });
});

describe('resolveDropText', () => {
  const resolvePath = (path: string): string | null =>
    path === 'Notes/A.md' || path === 'img/p.png' ? path : null;

  it('只保留库内路径，外链与已删除文件被静默丢掉', () => {
    const items = resolveDropText(
      '[[Notes/A.md]]\n[[Notes/Gone.md]]\nhttps://x.com/y',
      resolvePath,
    );
    expect(items).toEqual([{ path: 'Notes/A.md', name: 'A.md', kind: 'noteRef' }]);
  });

  it('带名字与类型（预览标签直接用 name）', () => {
    expect(resolveDropText('[[img/p.png]]', resolvePath)).toEqual([
      { path: 'img/p.png', name: 'p.png', kind: 'image' },
    ]);
  });

  it('解析器会把短名展开成库内真实路径（拖文件浏览器时常见）', () => {
    const resolveByAlias = (path: string): string | null => (path === 'A.md' ? 'Notes/A.md' : null);
    expect(resolveDropText('[[A.md]]', resolveByAlias)).toEqual([
      { path: 'Notes/A.md', name: 'A.md', kind: 'noteRef' },
    ]);
  });

  it('`obsidian://open?file=…` 按库内真实路径落卡（解析器负责解码 `file=`）', () => {
    const resolveByPath = (path: string): string | null =>
      path === 'Boards/父版.nboard' ? path : null;
    expect(
      resolveDropText('obsidian://open?file=Boards%2F%E7%88%B6%E7%89%88.nboard', resolveByPath),
    ).toEqual([{ path: 'Boards/父版.nboard', name: '父版.nboard', kind: 'boardRef' }]);
  });
});

describe('cascadeOrigins', () => {
  it('第一张以指针为中心，其后按步长右下错开', () => {
    expect(cascadeOrigins(3, { x: 100, y: 200 })).toEqual([
      { x: 100, y: 200 },
      { x: 100 + DROP_CASCADE_STEP.width, y: 200 + DROP_CASCADE_STEP.height },
      { x: 100 + 2 * DROP_CASCADE_STEP.width, y: 200 + 2 * DROP_CASCADE_STEP.height },
    ]);
  });

  it('负数 / 小数被规整，不会产出畸形序列', () => {
    expect(cascadeOrigins(0, { x: 0, y: 0 })).toEqual([]);
    expect(cascadeOrigins(-3, { x: 0, y: 0 })).toEqual([]);
    expect(cascadeOrigins(2.7, { x: 0, y: 0 })).toHaveLength(2);
  });
});

describe('cardsForDropPaths', () => {
  it('每张卡按各自类型用默认尺寸，中心点落在对应 origin 上', () => {
    const origins = cascadeOrigins(2, { x: 500, y: 300 });
    const cards = cardsForDropPaths(['Notes/A.md', 'img/p.png'], origins);

    expect(cards.map((card) => card.type)).toEqual(['noteRef', 'image']);
    // 联合类型里只有部分卡有 `content.path`，断言时显式取字段
    expect(cards.map((card) => (card.content as { path: string }).path)).toEqual([
      'Notes/A.md',
      'img/p.png',
    ]);

    const first = DEFAULT_CARD_SIZES.noteRef;
    expect(cards[0].x).toBe(500 - first.width / 2);
    expect(cards[0].y).toBe(300 - first.height / 2);
    expect(cards[0].width).toBe(first.width);
    expect(cards[0].height).toBe(first.height);

    // 第二张的中心 = 第一张中心 + 步长（★ 不同类型尺寸不同，只断言中心）
    const second = DEFAULT_CARD_SIZES.image;
    expect(cards[1].x + second.width / 2).toBe(500 + DROP_CASCADE_STEP.width);
    expect(cards[1].y + second.height / 2).toBe(300 + DROP_CASCADE_STEP.height);
  });

  it('新卡默认不带分栏归属（落点由落卡逻辑再决定）', () => {
    const [card] = cardsForDropPaths(['data/x.bin'], cascadeOrigins(1, { x: 0, y: 0 }));
    expect(card.type).toBe('file');
    expect(card.columnId).toBeNull();
    expect((card.content as { path: string }).path).toBe('data/x.bin');
  });

  it('origins 缺项时退到最后一个点，绝不把卡片丢到 (0,0)', () => {
    const [card] = cardsForDropPaths(['Notes/A.md'], cascadeOrigins(3, { x: 40, y: 60 }));
    const size = DEFAULT_CARD_SIZES.noteRef;
    expect(card.x).toBe(40 - size.width / 2);
    expect(card.y).toBe(60 - size.height / 2);
  });

  it('空输入 → 空数组', () => {
    expect(cardsForDropPaths([], [])).toEqual([]);
  });
});

describe('dropHintKey', () => {
  it('四种库内文件各有各的说法', () => {
    expect(dropHintKey('noteRef')).toBe('drop.hint.noteRef');
    expect(dropHintKey('image')).toBe('drop.hint.image');
    expect(dropHintKey('boardRef')).toBe('drop.hint.boardRef');
    expect(dropHintKey('file')).toBe('drop.hint.file');
  });

  it('一段文本单独有一种说法（F6-07：不能跟"作为引用卡"混为一谈）', () => {
    expect(dropHintKey('note')).toBe('drop.hint.note');
  });
});

describe('noteContentFromDropText（F6-07）', () => {
  it('普通文本原样返回', () => {
    expect(noteContentFromDropText('这是一段被拖进来的话')).toBe('这是一段被拖进来的话');
  });

  it('去掉首尾空白', () => {
    expect(noteContentFromDropText('  \n hello \t \n')).toBe('hello');
  });

  it('空文本 / 只有空白 → null（不该凭空多出一张空卡）', () => {
    expect(noteContentFromDropText('')).toBeNull();
    expect(noteContentFromDropText('   \n\t\r\n ')).toBeNull();
  });

  it('整段就是一个网址 → null（保持"拖外链什么都不发生"的既有行为）', () => {
    expect(noteContentFromDropText('https://example.com/a.png')).toBeNull();
    expect(noteContentFromDropText('mailto:me@example.com')).toBeNull();
    expect(noteContentFromDropText('file:///Users/me/pic.png')).toBeNull();
    // 归一化之后才判定，所以"带 \r 的单个网址"也挡得住
    expect(noteContentFromDropText('https://example.com/a.png\r\n')).toBeNull();
  });

  it('网址只是正文的一部分时仍然成立（多行选区不该被丢掉）', () => {
    expect(noteContentFromDropText('看这个：https://example.com')).toBe(
      '看这个：https://example.com',
    );
    expect(noteContentFromDropText('https://example.com\n还有第二行')).toBe(
      'https://example.com\n还有第二行',
    );
  });

  it('换行统一成 `\\n`（Windows 拖过来的 `\\r\\n` 不会在正文里留下 `\\r`）', () => {
    expect(noteContentFromDropText('a\r\nb\rc')).toBe('a\nb\nc');
  });

  it('不截断：几千字的选区原样存进卡片', () => {
    const long = 'x'.repeat(5000);
    expect(noteContentFromDropText(long)).toBe(long);
  });
});

describe('dropTextPreviewName', () => {
  it('取第一行非空内容', () => {
    expect(dropTextPreviewName('\n\n第一行\n第二行')).toBe('第一行');
  });

  it('去掉开头的 Markdown 标题井号（那只是标记，不是标题的一部分）', () => {
    expect(dropTextPreviewName('### 会议记录\n正文')).toBe('会议记录');
  });

  it('过长时截断并加省略号（否则标签会横穿整个画布）', () => {
    const name = dropTextPreviewName('a'.repeat(60));
    expect(name).toBe(`${'a'.repeat(40)}…`);
    expect(name).toHaveLength(41);
  });

  it('没有可用行时退回整段文本的去空白形态', () => {
    expect(dropTextPreviewName('')).toBe('');
    expect(dropTextPreviewName('\n \n')).toBe('');
  });
});

describe('noteCardForDropText', () => {
  it('建一张便签卡：正文原样存进 content.md，不带分栏归属', () => {
    const card = noteCardForDropText('# 标题\n正文', { x: 100, y: 200 });
    expect(card.type).toBe('note');
    expect((card.content as { md: string }).md).toBe('# 标题\n正文');
    expect(card.columnId).toBeNull();
  });

  it('以原点为中心、用便签卡自己的默认尺寸（与幽灵卡读的是同一张表）', () => {
    const size = DEFAULT_CARD_SIZES.note;
    const card = noteCardForDropText('内容', { x: 300, y: 400 });
    expect(card.x).toBe(300 - size.width / 2);
    expect(card.y).toBe(400 - size.height / 2);
    expect(card.width).toBe(size.width);
    expect(card.height).toBe(size.height);
  });
});
