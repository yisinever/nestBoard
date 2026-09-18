import { beforeEach, describe, expect, it } from 'vitest';

import {
  INDEX_NOTE_MARKER,
  INDEX_NOTE_TAG,
  indexNoteBoardOf,
  indexNotePathOf,
  isIndexNote,
  normalizeIndexFolder,
  renderIndexNote,
} from '../../model/indexNote';
import type { IndexNoteInput } from '../../model/indexNote';
import { setLocale } from '../../util/i18n';

/** 一份"什么都没配"的输入；每条用例只覆盖自己关心的那几列 */
function render(overrides: Partial<IndexNoteInput> = {}): string {
  return renderIndexNote({
    boardPath: 'Boards/Home.nboard',
    title: 'Home',
    tags: [],
    cardCount: 3,
    updatedAt: '2026-09-13T10:00:00.000Z',
    links: [],
    boardUri: '',
    ...overrides,
  });
}

beforeEach(() => {
  setLocale('zh-cn');
});

describe('normalizeIndexFolder', () => {
  it('去掉首尾空白与斜杠、把反斜杠摆正', () => {
    expect(normalizeIndexFolder('  Boards/_index/  ')).toBe('Boards/_index');
    expect(normalizeIndexFolder('\\Boards\\_index')).toBe('Boards/_index');
    expect(normalizeIndexFolder('///idx///')).toBe('idx');
  });

  it('空串 / 只有空白 → 空串（表示"放库根"，与「新白板目录」同一套语义）', () => {
    expect(normalizeIndexFolder('')).toBe('');
    expect(normalizeIndexFolder('   ')).toBe('');
    expect(normalizeIndexFolder('/')).toBe('');
  });
});

describe('indexNotePathOf（镜像库内层级）', () => {
  it('路径 = 索引目录 + 白板在库内的完整相对路径（去掉扩展名）', () => {
    expect(indexNotePathOf('Boards/Home.nboard', 'Boards/_index')).toBe(
      'Boards/_index/Boards/Home.md',
    );
    expect(indexNotePathOf('Boards/项目/子板.nboard', 'Boards/_index')).toBe(
      'Boards/_index/Boards/项目/子板.md',
    );
  });

  it('索引目录为空 → 直接放库根', () => {
    expect(indexNotePathOf('A.nboard', '')).toBe('A.md');
    expect(indexNotePathOf('Boards/A.nboard', '')).toBe('Boards/A.md');
  });

  it('目录写法不干净也认（前后斜杠、反斜杠、空白）', () => {
    expect(indexNotePathOf('A.nboard', '/idx/')).toBe('idx/A.md');
    expect(indexNotePathOf('/A.nboard', 'idx')).toBe('idx/A.md');
  });

  it('两级不同的白板撞不到一起（这正是镜像整条路径换来的）', () => {
    const a = indexNotePathOf('A/周报.nboard', 'idx');
    const b = indexNotePathOf('B/周报.nboard', 'idx');
    expect(a).not.toBe(b);
    expect(a).toBe('idx/A/周报.md');
    expect(b).toBe('idx/B/周报.md');
  });
});

describe('indexNoteBoardOf（反函数，清理时按它算"这份笔记是谁的"）', () => {
  it('能原样还原出白板路径', () => {
    expect(indexNoteBoardOf('idx/Boards/Home.md', 'idx')).toBe('Boards/Home.nboard');
    expect(indexNoteBoardOf('idx/Deep/A.md', 'idx')).toBe('Deep/A.nboard');
  });

  it('不在索引目录之下 → null（不是我们该管的文件）', () => {
    expect(indexNoteBoardOf('别处/A.md', 'idx')).toBeNull();
  });

  it('不是 .md → null', () => {
    expect(indexNoteBoardOf('idx/A.nboard', 'idx')).toBeNull();
    expect(indexNoteBoardOf('idx/A', 'idx')).toBeNull();
  });

  it('索引目录为空时按整个库算', () => {
    expect(indexNoteBoardOf('Boards/A.md', '')).toBe('Boards/A.nboard');
  });

  it('任意白板路径走一圈都回得来（这条不成立的话，清理会误删别人的笔记）', () => {
    const boards = ['A.nboard', 'Boards/Home.nboard', 'Boards/项目/子板.nboard'];
    for (const folder of ['', 'idx', 'a/b', '/idx/']) {
      for (const board of boards) {
        expect(indexNoteBoardOf(indexNotePathOf(board, folder), folder)).toBe(board);
      }
    }
  });
});

describe('isIndexNote', () => {
  it('认标记：有标记才算我们的文件', () => {
    expect(isIndexNote(render())).toBe(true);
    expect(isIndexNote(INDEX_NOTE_MARKER)).toBe(true);
  });

  it('普通笔记 / 空文件都不是', () => {
    expect(isIndexNote('# 我的笔记\n随便写点什么')).toBe(false);
    expect(isIndexNote('')).toBe(false);
  });
});

describe('renderIndexNote · frontmatter（F7-09）', () => {
  it('元信息齐全：板路径 / 标题 / 卡片数 / 更新时间', () => {
    const text = render();
    expect(text.startsWith('---\n')).toBe(true);
    expect(text).toContain('nestboard-board: "Boards/Home.nboard"');
    expect(text).toContain('nestboard-title: "Home"');
    expect(text).toContain('nestboard-cards: 3');
    expect(text).toContain('nestboard-updated: "2026-09-13T10:00:00.000Z"');
  });

  it('卡片数是数字而不是字符串（Dataview 要能拿它做比较）', () => {
    expect(render({ cardCount: 42 })).toContain('nestboard-cards: 42');
  });

  it('负数的卡片数收敛成 0', () => {
    expect(render({ cardCount: -2 })).toContain('nestboard-cards: 0');
  });

  it('标签一定带上 nestboard 标记标签，且去重、去 #、保持顺序', () => {
    const text = render({ tags: ['调研', 'nestboard', ' #立项 ', '  '] });
    expect(text).toContain(
      ['tags:', `  - "${INDEX_NOTE_TAG}"`, '  - "调研"', '  - "立项"'].join('\n'),
    );
    // 重复的 nestboard 不再出现第二次
    expect(text.match(/- "nestboard"/g)).toHaveLength(1);
  });

  it('标题里的冒号 / 引号 / 换行都被转义（否则 YAML 直接语法错，用户只会看到"查询没结果"）', () => {
    expect(render({ title: '周报: 第二期' })).toContain('nestboard-title: "周报: 第二期"');
    expect(render({ title: '他叫"小明"' })).toContain('nestboard-title: "他叫\\"小明\\""');
    expect(render({ title: 'A\nB' })).toContain('nestboard-title: "A\\nB"');
  });

  it('没有更新时间就不写这一行（不写 `updated: ""` 那种半截数据）', () => {
    const text = render({ updatedAt: '' });
    expect(text).not.toContain('nestboard-updated');
    expect(text).toContain('这块白板有 3 张卡片。');
  });

  it('卡片数未知 → 整栏不写，也**不**用 0 充数（"0 张卡片"会让用户以为白板空了）', () => {
    const text = render({ cardCount: null });
    expect(text).not.toContain('nestboard-cards');
    expect(text).toContain('这块白板最近保存于');
    expect(text).not.toContain('这块白板有');
  });

  it('卡片数与更新时间都不知道 → 正文里不留那句元信息，frontmatter 也如实缺席', () => {
    const text = render({ cardCount: null, updatedAt: '' });
    expect(text).not.toContain('nestboard-cards');
    expect(text).not.toContain('nestboard-updated');
    expect(text).not.toContain('张卡片');
    expect(text).not.toContain('最近保存于');
    expect(text).toContain('# Home'); // 标题与链接照旧
  });

  it('标题为空时退回文件名，标题行不会变成光秃秃一个 `# `', () => {
    const text = render({ title: '   ' });
    expect(text).toContain('nestboard-title: "Home"');
    expect(text).toContain('\n# Home\n');
  });
});

describe('renderIndexNote · 正文', () => {
  it('带上生成物标记与"别手改"的说明', () => {
    const text = render();
    expect(text).toContain(INDEX_NOTE_MARKER);
    expect(text).toContain('Boards/Home.nboard');
    expect(text).toContain('被覆盖');
  });

  it('有白板 URI 时给一行「打开这块白板」的入口（不是 wikilink，不污染图谱）', () => {
    const text = render({ boardUri: 'obsidian://nestboard?file=Boards%2FHome.nboard' });
    expect(text).toContain('[打开这块白板](obsidian://nestboard?file=Boards%2FHome.nboard)');
  });

  it('没有 URI 就不写那一行', () => {
    expect(render()).not.toContain('打开这块白板');
  });

  it('一条链接都没有时如实说明，而不是留一个空小节', () => {
    expect(render()).toContain('便签里还没有写过链接');
  });
});

describe('renderIndexNote · 链接（F10-09）', () => {
  const links = [
    { target: '周报', resolved: 'Notes/周报.md' },
    { target: 'Notes/周报', resolved: 'Notes/周报.md' }, // 同一文件的另一种写法
    { target: 'attachments/pic.png', resolved: 'attachments/pic.png' },
    { target: '还没建的笔记', resolved: null },
  ];

  it('解析出的链接写成 wikilink，并且用**完整路径**指向那个文件', () => {
    const text = render({ links });
    expect(text).toContain('- [[Notes/周报|周报]]');
  });

  it('别名与路径一样时不写 `|别名`（`[[周报|周报]]` 只是噪音）', () => {
    const text = render({ links: [{ target: 'Notes/周报', resolved: 'Notes/周报.md' }] });
    expect(text).toContain('- [[Notes/周报]]');
    expect(text).not.toContain('|');
  });

  it('图片等非 .md 附件保留扩展名（Obsidian 的 wikilink 就该这么指附件）', () => {
    expect(render({ links })).toContain('- [[attachments/pic.png]]');
  });

  it('指向同一个文件的两条写法只留一条边', () => {
    const text = render({ links });
    expect(text.match(/\[\[Notes\/周报/g)).toHaveLength(1);
  });

  it('没对上的链接列出来，但**不写成 wikilink**（否则图谱里会多出一个假笔记）', () => {
    const text = render({ links });
    expect(text).toContain('- `还没建的笔记`');
    expect(text).not.toContain('[[还没建的笔记]]');
  });

  it('没有未解析链接时不出现那一节', () => {
    const text = render({ links: [{ target: '周报', resolved: 'Notes/周报.md' }] });
    expect(text).not.toContain('没对上文件的链接');
  });

  it('顺序稳定：解析出的按路径排序，未解析的按目标文本排序', () => {
    const text = render({
      links: [
        { target: 'b', resolved: null },
        { target: 'z/乙', resolved: 'z/乙.md' },
        { target: 'a', resolved: null },
        { target: 'a/甲', resolved: 'a/甲.md' },
      ],
    });
    expect(text.indexOf('[[a/甲]]')).toBeLessThan(text.indexOf('[[z/乙]]'));
    expect(text.indexOf('- `a`')).toBeLessThan(text.indexOf('- `b`'));
  });

  it('解析出的链接排在未解析之前（先给有用的）', () => {
    const text = render({ links });
    expect(text.indexOf('[[Notes/周报|周报]]')).toBeLessThan(text.indexOf('没对上文件的链接'));
  });

  it('目标文本里的反引号会被换掉，不会把行内代码截断', () => {
    expect(render({ links: [{ target: 'a`b', resolved: null }] })).toContain("- `a'b`");
  });
});

describe('renderIndexNote · 两条契约', () => {
  it('纯函数：同一份输入渲染两次逐字节相同（bridge 的"内容没变就别写盘"全靠它）', () => {
    const input: IndexNoteInput = {
      boardPath: 'Boards/Home.nboard',
      title: 'Home',
      tags: ['调研'],
      cardCount: 5,
      updatedAt: '2026-09-13T10:00:00.000Z',
      links: [
        { target: '周报', resolved: 'Notes/周报.md' },
        { target: '没有的', resolved: null },
      ],
      boardUri: 'obsidian://nestboard?file=Boards%2FHome.nboard',
    };
    expect(renderIndexNote(input)).toBe(renderIndexNote(input));
  });

  it('结尾带换行（文件末尾缺换行符，`git diff` 会一直在叫）', () => {
    expect(render().endsWith('\n')).toBe(true);
    expect(render().endsWith('\n\n')).toBe(false);
  });

  it('正文跟着界面语言走：换语言后说明文字变了，但链接这条数据不变', () => {
    const en = ((): string => {
      setLocale('en');
      return render({ links: [{ target: '周报', resolved: 'Notes/周报.md' }] });
    })();
    setLocale('zh-cn');
    const zh = render({ links: [{ target: '周报', resolved: 'Notes/周报.md' }] });

    expect(en).not.toBe(zh);
    expect(en).toContain('- [[Notes/周报|周报]]');
    expect(zh).toContain('- [[Notes/周报|周报]]');
    expect(en).toContain('This board holds');
    expect(zh).toContain('这块白板有');
  });
});
