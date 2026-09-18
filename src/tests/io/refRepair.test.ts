import { describe, expect, it } from 'vitest';
import { createBoardFile, createCard } from '../../model/factories';
import type { CardRef, RefKind } from '../../model/links';
import {
  applyRefRepairs,
  DEFAULT_CHECKED_QUALITIES,
  planRefRepairs,
  type RefRepair,
} from '../../io/refRepair';
import type { CardType } from '../../model/schema';

/**
 * T4.07「修复引用」。
 *
 * 这一层的输出是**一串要写回文件的路径**，所以测的重点不是"能不能匹配上"，
 * 而是"会不会匹配错"：断链是看得见的，指错文件的引用长得完全正常。
 * 下面每条带 ★ 的测试都对应文件头里一条写死的取舍。
 */

/** 引用种类 ↔ 能承载它的卡片类型（五种引用卡与种类同名，除了 `file` 卡） */
const CARD_TYPE_OF: Record<RefKind, CardType> = {
  image: 'image',
  file: 'file',
  noteRef: 'noteRef',
  boardRef: 'boardRef',
  link: 'link',
};

function refOf(cardId: string, kind: RefKind, path: string, cardTitle = ''): CardRef {
  return { cardId, cardTitle, cardType: CARD_TYPE_OF[kind], kind, path };
}

describe('planRefRepairs 分档', () => {
  it('同名但换了目录 → sameName（"文件只是挪了个位置"）', () => {
    const plan = planRefRepairs(
      [refOf('c1', 'image', 'assets/封面.png')],
      ['attachments/封面.png', 'attachments/其他.png'],
    );

    expect(plan.suggestions).toEqual([
      {
        cardId: 'c1',
        cardTitle: '',
        kind: 'image',
        brokenPath: 'assets/封面.png',
        nextPath: 'attachments/封面.png',
        quality: 'sameName',
        alternatives: 0,
      },
    ]);
    expect(plan.unmatched).toEqual([]);
  });

  it('只差大小写 → sameNameIgnoreCase', () => {
    const plan = planRefRepairs(
      [refOf('c1', 'image', 'assets/COVER.png')],
      ['attachments/cover.PNG'],
    );

    expect(plan.suggestions[0].quality).toBe('sameNameIgnoreCase');
    expect(plan.suggestions[0].nextPath).toBe('attachments/cover.PNG');
  });

  it('去掉空格 / 下划线 / 连字符后同名 → normalizedName', () => {
    const plan = planRefRepairs(
      [refOf('c1', 'image', 'assets/屏幕 截图_01.png')],
      ['attachments/屏幕截图-01.png'],
    );

    expect(plan.suggestions[0].quality).toBe('normalizedName');
  });

  it('★ 数字不能被规范化掉：" 1" 是另一份文件，不是同一份的变体', () => {
    const plan = planRefRepairs([refOf('c1', 'image', 'assets/图.png')], ['attachments/图 1.png']);

    // `图 1` 去掉空格后是 `图1`，与 `图` 不同名也不相似（长度差 1 但没有共同前缀之外的成分，
    // 相似度 0.5 < 0.8）→ 宁可报"修不了"，也不能把它接到 `图.png` 上
    expect(plan.suggestions).toEqual([]);
    expect(plan.unmatched).toHaveLength(1);
  });

  it('名字相近（漏字）→ similarName，且只在前面几档全空时才用', () => {
    const files = ['attachments/2026年第一季度报.png'];
    const plan = planRefRepairs([refOf('c1', 'image', 'assets/2026年第一季度报告.png')], files);

    expect(plan.suggestions[0].quality).toBe('similarName');
    expect(plan.suggestions[0].nextPath).toBe('attachments/2026年第一季度报.png');
  });

  it('低档位不许抢答：同名目标在场的，就不该给出"名字很像"的那个', () => {
    const plan = planRefRepairs(
      [refOf('c1', 'image', 'assets/2026年第一季度报告.png')],
      ['attachments/2026年第一季度报.png', 'attachments/2026年第一季度报告.png'],
    );

    expect(plan.suggestions[0].quality).toBe('sameName');
    expect(plan.suggestions[0].nextPath).toBe('attachments/2026年第一季度报告.png');
  });

  it('★ 扩展名是硬闸门：图片断链不会被同名笔记接走', () => {
    const plan = planRefRepairs([refOf('c1', 'image', 'assets/图.png')], ['notes/图.md']);

    expect(plan.suggestions).toEqual([]);
    expect(plan.unmatched).toHaveLength(1);
  });

  it('★ 各种引用只接自己那类文件（笔记 / 白板 / 图片）', () => {
    const files = ['notes/甲.md', 'Boards/甲.nboard', 'attachments/甲.png'];

    expect(
      planRefRepairs([refOf('c1', 'noteRef', 'notes/旧/甲.md')], files).suggestions[0].nextPath,
    ).toBe('notes/甲.md');
    expect(
      planRefRepairs([refOf('c2', 'boardRef', 'Boards/旧/甲.nboard')], files).suggestions[0]
        .nextPath,
    ).toBe('Boards/甲.nboard');
    expect(
      planRefRepairs([refOf('c3', 'image', 'assets/甲.png')], files).suggestions[0].nextPath,
    ).toBe('attachments/甲.png');
  });

  it('`file` 卡不设扩展名限制（它本来就是"任意文件"），照样认 .xlsx 这类附件', () => {
    const plan = planRefRepairs([refOf('c1', 'file', '旧/数据.xlsx')], ['files/数据.xlsx']);

    expect(plan.suggestions[0].nextPath).toBe('files/数据.xlsx');
    expect(plan.suggestions[0].quality).toBe('sameName');
  });

  it('★ URL 类引用（link 卡）不进名单：它没有文件名，也就谈不上"同名文件"', () => {
    const plan = planRefRepairs([refOf('c1', 'link', 'https://example.com/x')], ['notes/甲.md']);

    expect(plan.suggestions).toEqual([]);
    expect(plan.unmatched).toEqual([]);
  });

  it('库里找不到任何候选 → 进 unmatched（让用户知道这些修不了）', () => {
    const plan = planRefRepairs([refOf('c1', 'image', 'assets/没了.png')], ['notes/甲.md']);

    expect(plan.suggestions).toEqual([]);
    expect(plan.unmatched.map((item) => item.cardId)).toEqual(['c1']);
  });

  it('把"失效路径本身"排除在候选之外（同一条路径不算修复）', () => {
    const plan = planRefRepairs([refOf('c1', 'image', 'assets/图.png')], ['assets/图.png']);

    expect(plan.suggestions).toEqual([]);
  });
});

describe('planRefRepairs 歧义与确定性', () => {
  it('★ 多个同名目标：给出一个建议 + 报出"还有几个"，并优先同目录的那个', () => {
    const plan = planRefRepairs(
      [refOf('c1', 'image', 'assets/2025/封面.png')],
      ['assets/封面.png', 'other/封面.png'],
    );

    expect(plan.suggestions).toHaveLength(1);
    expect(plan.suggestions[0].nextPath).toBe('assets/封面.png'); // 与旧路径同目录
    expect(plan.suggestions[0].alternatives).toBe(1);
  });

  it('同目录里也有多个时按路径字典序定胜负（建议必须可复现）', () => {
    const plan = planRefRepairs(
      [refOf('c1', 'image', 'assets/封面.png')],
      ['assets/b/封面.png', 'assets/a/封面.png'],
    );

    expect(plan.suggestions[0].nextPath).toBe('assets/a/封面.png');
    expect(plan.suggestions[0].alternatives).toBe(1);
  });

  it('传进来的文件顺序不影响结果', () => {
    const broken = [refOf('c1', 'image', 'assets/封面.png')];
    const forward = planRefRepairs(broken, ['a/封面.png', 'b/封面.png']);
    const reversed = planRefRepairs(broken, ['b/封面.png', 'a/封面.png']);

    expect(reversed.suggestions).toEqual(forward.suggestions);
  });

  it('建议按可信度排序：同名的排在"名字很像"的前面', () => {
    const plan = planRefRepairs(
      [
        refOf('c1', 'image', 'assets/2026年第一季度报告.png'),
        refOf('c2', 'image', 'assets/封面.png'),
      ],
      ['attachments/2026年第一季度报.png', 'other/封面.png'],
    );

    expect(plan.suggestions.map((item) => item.quality)).toEqual(['sameName', 'similarName']);
  });

  it('★ 默认勾选的只有前两档（同名 / 忽略大小写），其余都只是猜测', () => {
    expect(DEFAULT_CHECKED_QUALITIES).toEqual(['sameName', 'sameNameIgnoreCase']);
  });
});

describe('applyRefRepairs', () => {
  function boardWithReference(): ReturnType<typeof createBoardFile> {
    return createBoardFile({
      cards: [
        createCard('image', { id: 'c1', title: '封面', content: { path: 'assets/封面.png' } }),
        createCard('noteRef', {
          id: 'c2',
          title: '笔记',
          content: { path: 'notes/旧.md', subpath: '#第三节' },
        }),
        createCard('note', { id: 'c9', title: '便签', content: { md: '不动' } }),
      ],
    });
  }

  it('改掉路径并报出改了几处', () => {
    const board = boardWithReference();
    const repairs: RefRepair[] = [
      { cardId: 'c1', brokenPath: 'assets/封面.png', nextPath: 'attachments/封面.png' },
    ];

    expect(applyRefRepairs(board, repairs)).toBe(1);
    expect(board.cards.find((card) => card.id === 'c1')).toMatchObject({
      content: { path: 'attachments/封面.png' },
    });
  });

  it('★ 过期确认会被跳过：卡片此刻已经指着别的路径时，不许把它打回旧值', () => {
    const board = boardWithReference();
    const repairs: RefRepair[] = [
      // 用户在这期间自己重新链接过了
      { cardId: 'c1', brokenPath: 'assets/封面.png', nextPath: 'attachments/封面.png' },
    ];
    const image = board.cards.find((card) => card.id === 'c1');
    if (image?.type !== 'image') throw new Error('夹具坏了');
    image.content.path = 'assets/新封面.png';

    expect(applyRefRepairs(board, repairs)).toBe(0);
    expect(image.content.path).toBe('assets/新封面.png');
  });

  it('★ 只改 path：`noteRef` 的 `#小节` 原样保留', () => {
    const board = boardWithReference();
    applyRefRepairs(board, [{ cardId: 'c2', brokenPath: 'notes/旧.md', nextPath: 'notes/新.md' }]);

    expect(board.cards.find((card) => card.id === 'c2')).toMatchObject({
      content: { path: 'notes/新.md', subpath: '#第三节' },
    });
  });

  it('碰不到非引用卡，也不认不存在的卡片', () => {
    const board = boardWithReference();
    const repairs: RefRepair[] = [
      { cardId: 'c9', brokenPath: 'whatever', nextPath: 'whatever2' },
      { cardId: '不存在', brokenPath: 'a', nextPath: 'b' },
    ];

    expect(applyRefRepairs(board, repairs)).toBe(0);
    expect(board.cards.find((card) => card.id === 'c9')).toMatchObject({ content: { md: '不动' } });
  });

  it('空名单是空操作（对话框里一处都没勾时不该产生一次可撤销的改动）', () => {
    expect(applyRefRepairs(boardWithReference(), [])).toBe(0);
  });
});
