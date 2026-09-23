import { beforeEach, describe, expect, it } from 'vitest';

import {
  TAG_HUB_KEY,
  TAG_HUB_MARKER,
  isTagHubNote,
  renderTagHubNote,
  tagHubFileNameOf,
  tagHubFolderOf,
  tagHubPathOf,
} from '../../model/tagHub';
import { renderIndexNote } from '../../model/indexNote';
import { setLocale } from '../../util/i18n';

beforeEach(() => {
  setLocale('zh-cn');
});

describe('标签枢纽笔记 · 路径规则（F1 ②）', () => {
  it('索引目录下固定一层 `_tags/`，一个标签一份', () => {
    expect(tagHubFolderOf('idx')).toBe('idx/_tags');
    expect(tagHubFolderOf('')).toBe('_tags');
    // 用户把目录写成 `/idx/` 也收敛成同一个
    expect(tagHubFolderOf('/idx/')).toBe('idx/_tags');
    expect(tagHubPathOf('纪要', 'idx')).toBe('idx/_tags/纪要.md');
  });

  it('★ 嵌套标签不生出子目录：`项目/周报` 落在平铺的一层里', () => {
    // 不换掉 `/` 的话会在 `_tags/` 下长出一层 `项目/`，而清理是按平铺扫的
    expect(tagHubPathOf('项目/周报', 'idx')).toBe('idx/_tags/项目-周报.md');
    expect(tagHubFileNameOf('#纪要')).toBe('纪要');
    expect(tagHubFileNameOf('a:b*c?')).toBe('a-b-c');
    expect(tagHubFileNameOf('a--b')).toBe('a-b');
    expect(tagHubFileNameOf('  ')).toBe('untagged');
  });
});

describe('标签枢纽笔记 · 认领标记（F1 ②）', () => {
  it('只认自己的标记 —— 索引笔记的文本不算枢纽笔记', () => {
    expect(isTagHubNote(`${TAG_HUB_MARKER}\n# #纪要`)).toBe(true);
    const indexNote = renderIndexNote({
      boardPath: 'Boards/A.nboard',
      title: 'A',
      tags: [],
      cardCount: null,
      updatedAt: '',
      links: [],
      boardUri: '',
    });
    expect(isTagHubNote(indexNote)).toBe(false);
  });
});

describe('标签枢纽笔记 · 渲染（F1 ②）', () => {
  function render(boards: Array<{ boardPath: string; title: string }>, tag = '纪要'): string {
    return renderTagHubNote({
      tag,
      boards: boards.map((board) => ({
        ...board,
        notePath: `idx/${board.boardPath.replace('.nboard', '.md')}`,
      })),
    });
  }

  it('frontmatter 带标签那一栏 + 正文带标记、带 `#标签`、带白板清单', () => {
    const text = render([
      { boardPath: 'Boards/B.nboard', title: 'B 板' },
      { boardPath: 'Boards/A.nboard', title: 'A 板' },
    ]);

    expect(text).toContain(`${TAG_HUB_KEY}: "纪要"`);
    expect(text).toContain('  - "纪要"');
    expect(text).toContain(TAG_HUB_MARKER);
    // 标题里带标签本身：标签面板与 `#纪要` 搜索都认这一行
    expect(text).toContain('# #纪要');
    // 清单按 boardPath 排序（与调用方给的顺序无关），目标是**索引笔记**的完整路径
    const firstA = text.indexOf('[[idx/Boards/A|A 板]]');
    const firstB = text.indexOf('[[idx/Boards/B|B 板]]');
    expect(firstA).toBeGreaterThan(0);
    expect(firstB).toBeGreaterThan(firstA);
  });

  it('★ 同一块板只列一次；没有白板时给一句"还没有"而不是空清单', () => {
    const text = render([
      { boardPath: 'Boards/A.nboard', title: 'A 板' },
      { boardPath: 'Boards/A.nboard', title: 'A 板' },
    ]);
    expect(text.match(/\[\[idx\/Boards\/A\|A 板\]\]/g)?.length).toBe(1);

    const empty = render([]);
    expect(empty).toContain('还没有白板用到这个标签');
    expect(empty).not.toContain('[[idx/');
  });

  it('★ 纯函数：同一份输入两次渲染**逐字节相同**（桥靠它判"没变就不写盘"）', () => {
    const input = {
      tag: '纪要',
      boards: [{ boardPath: 'Boards/A.nboard', title: 'A', notePath: 'idx/Boards/A.md' }],
    };
    expect(renderTagHubNote(input)).toBe(renderTagHubNote(input));
    // 尾随换行：文件末尾没有换行符时不少工具会抱怨
    expect(renderTagHubNote(input).endsWith('\n')).toBe(true);
  });
});
