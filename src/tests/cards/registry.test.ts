/**
 * 卡片类型注册表单元测试（T1.32 / 03 §7.3）。
 *
 * 注册表的设计承诺只有两条，但两条都直接决定"加一种卡片要不要动核心代码"：
 *   1. **允许缺类型**：`render` 返回 `false`、`labelOf` 回落到 i18n 类型名 ——
 *      少注册一个类型只会退化成占位，**绝不白屏**；
 *   2. **禁止重复注册**：静默覆盖会让"我明明改了却没生效"这种问题查上半天。
 */

import { describe, expect, it } from 'vitest';
import { boardRefCard } from '../../cards/boardRef';
import { commentCard } from '../../cards/comment';
import { fileCard } from '../../cards/file';
import { imageCard } from '../../cards/image';
import { inkCard } from '../../cards/ink';
import { linkCard } from '../../cards/link';
import { mapCard } from '../../cards/map';
import { noteCard } from '../../cards/note';
import { noteRefCard } from '../../cards/noteRef';
import { swatchCard } from '../../cards/swatch';
import { syncNoteCard } from '../../cards/syncNote';
import { todoCard } from '../../cards/todo';
import { CardTypeRegistry, createCardRegistry, type CardRenderContext } from '../../cards/registry';
import { createCard } from '../../model/factories';
import { t } from '../../util/i18n';

const anyContext = {} as unknown as CardRenderContext;
const anyElement = {} as unknown as HTMLElement;

describe('createCardRegistry', () => {
  it('注册当前已实现的类型（便签 / 引用 / 图片 / 文件 / 视频 / 白板 / 链接 / 待办 / 色板 / 手绘 / 地图 / 同步便签）', () => {
    const registry = createCardRegistry();
    for (const type of [
      'note',
      'noteRef',
      'image',
      'file',
      'video',
      'audio',
      'titleCard',
      'gallery',
      'boardRef',
      'link',
      'todo',
      'swatch',
      'ink',
      'map',
      'syncNote',
      'comment',
      'pdf',
      'canvas',
      'mindRef',
      'mind',
    ] as const) {
      expect(registry.has(type)).toBe(true);
    }
    // 二十种类型全在 —— 缺类型仍是**允许**的状态（那不是缺陷），但当下不该缺
    expect(registry.size).toBe(20);
  });

  it('get 按类型取回**对应**的定义（收窄 `T` 不能让 A 类型取到 B 的定义）', () => {
    const registry = createCardRegistry();
    expect(registry.get('note')).toBe(noteCard);
    expect(registry.get('noteRef')).toBe(noteRefCard);
    expect(registry.get('image')).toBe(imageCard);
    expect(registry.get('file')).toBe(fileCard);
    expect(registry.get('boardRef')).toBe(boardRefCard);
    expect(registry.get('link')).toBe(linkCard);
    expect(registry.get('todo')).toBe(todoCard);
    expect(registry.get('swatch')).toBe(swatchCard);
    expect(registry.get('ink')).toBe(inkCard);
    expect(registry.get('map')).toBe(mapCard);
    expect(registry.get('syncNote')).toBe(syncNoteCard);
    expect(registry.get('comment')).toBe(commentCard);
  });
});

describe('CardTypeRegistry', () => {
  it('labelOf：已注册取定义名；未注册回落到 i18n 类型名，绝不空白', () => {
    const registry = createCardRegistry();
    expect(registry.labelOf('note')).toBe(t('card.type.note'));

    const bare = new CardTypeRegistry();
    expect(bare.labelOf('image')).toBe(t('card.type.image'));
  });

  it('未注册类型：render 返回 false（调用方据此画占位），toMarkdown 返回空串', () => {
    const registry = new CardTypeRegistry();
    const card = createCard('image');
    expect(registry.render(anyElement, card, anyContext)).toBe(false);
    expect(registry.toMarkdown(card, { sourcePath: '' })).toBe('');
  });

  it('get 对未注册类型返回 undefined（不是抛错）', () => {
    expect(new CardTypeRegistry().get('todo')).toBeUndefined();
  });

  it('重复注册同一类型直接抛错（不静默覆盖）', () => {
    const registry = createCardRegistry();
    expect(() => registry.register(noteCard)).toThrow(/already registered/);
  });
});

describe('收起态标题与「编辑内容」的判据（O34 / O35）', () => {
  const registry = createCardRegistry();

  describe('collapsedTitle（O34）', () => {
    it('★ 用户自己写过的标题**永远优先**（类型只是"卡片没名字时替它说一句"）', () => {
      const card = createCard('link', {
        title: '我起的名字',
        content: { url: 'https://a.com/', title: '抓来的标题' },
      });
      expect(registry.collapsedTitle(card)).toBe('我起的名字');
    });

    it('卡片没名字时问类型：链接卡给预览标题，没有预览给链接本身', () => {
      const withPreview = createCard('link', { content: { url: 'https://a.com/', title: '示例' } });
      const blank = createCard('link', { content: { url: 'https://a.com/' } });

      expect(registry.collapsedTitle(withPreview)).toBe('示例');
      expect(registry.collapsedTitle(blank)).toBe('https://a.com/');
    });

    it('没声明这个钩子的类型 = 空串（收起后那一行是空的，但 `▸` 展开按钮仍在）', () => {
      expect(registry.collapsedTitle(createCard('note', { content: { md: 'hi' } }))).toBe('');
    });

    it('未注册的类型 = 空串，不抛错（老文件里可能有将来才认识的类型）', () => {
      const bare = new CardTypeRegistry();
      expect(bare.collapsedTitle(createCard('note', { content: { md: '' } }))).toBe('');
    });
  });

  describe('inlineEditable（O35）', () => {
    it('★ 双击会进编辑态的类型 → `true`（这些类型的「编辑内容」是真的编辑）', () => {
      for (const type of ['note', 'todo', 'syncNote', 'comment', 'ink'] as const) {
        expect([type, registry.inlineEditable(type)]).toEqual([type, true]);
      }
    });

    it('★ 双击被类型自己接走的类型 → `false`（那一项点下去是打开文件 / 跳浏览器 / 进子板）', () => {
      for (const type of [
        'file',
        'link',
        'image',
        'map',
        'swatch',
        'boardRef',
        'noteRef',
      ] as const) {
        expect([type, registry.inlineEditable(type)]).toEqual([type, false]);
      }
    });

    it('判据是"有没有声明钩子"，与它这一刻返回什么无关（菜单要在点开之前就摆好）', () => {
      // 空路径的文件卡双击**不接管**（`onDoubleClick` 返回 false），但菜单项仍然不给 ——
      // 那一项是"这次能不能用"之外的事：这个类型根本没有可编辑的正文
      const emptyFile = createCard('file', { content: { path: '' } });
      expect(emptyFile.type).toBe('file');
      expect(registry.inlineEditable('file')).toBe(false);
    });
  });
});

describe('标题是否管着文件名（O37）', () => {
  const registry = createCardRegistry();

  it('★ 白板卡（`.nboard`）的标题就是文件名 —— 改标题必须落到文件上', () => {
    const card = createCard('boardRef', { content: { path: 'Boards/子板.nboard' } });
    expect(registry.titleFilePath(card)).toBe('Boards/子板.nboard');
  });

  it('空格位（还没建子板）没有文件可改', () => {
    expect(registry.titleFilePath(createCard('boardRef', { content: { path: '' } }))).toBeNull();
  });

  it('★ 大小写不敏感：`.NBOARD` 也是这块板', () => {
    const card = createCard('boardRef', { content: { path: 'Boards/子板.NBOARD' } });
    expect(registry.titleFilePath(card)).toBe('Boards/子板.NBOARD');
  });

  it('`.md` 文件卡的标题也管着文件名（`O30` 的老规矩）', () => {
    const card = createCard('file', { content: { path: 'Notes/日记.md' } });
    expect(registry.titleFilePath(card)).toBe('Notes/日记.md');
  });

  it('★ 别的文件卡不接：改卡片标题绝不动用户的文件（PDF / 表格 / 图片）', () => {
    for (const path of ['docs/报告.pdf', 'docs/台账.xlsx', 'assets/图.png']) {
      expect([path, registry.titleFilePath(createCard('file', { content: { path } }))]).toEqual([
        path,
        null,
      ]);
    }
  });

  it('便签 / 链接卡的标题只是卡片上的字（一律 `null`）', () => {
    expect(registry.titleFilePath(createCard('note', { content: { md: '' } }))).toBeNull();
    expect(
      registry.titleFilePath(createCard('link', { content: { url: 'https://a.com/' } })),
    ).toBeNull();
  });

  it('★ 引用卡的标题就是那篇笔记的文件名（`O38`：拖一篇 `.md` 进来得到的就是它）', () => {
    const card = createCard('noteRef', { content: { path: 'Notes/甲.md' } });
    expect(registry.titleFilePath(card)).toBe('Notes/甲.md');
  });

  it('引用某一处的引用卡同样算（`subpath` 与文件名是两回事）', () => {
    const card = createCard('noteRef', {
      content: { path: 'Notes/甲.md', subpath: '#乙' },
    });
    expect(registry.titleFilePath(card)).toBe('Notes/甲.md');
  });

  it('引用卡断链 / 空路径时没有文件可改', () => {
    expect(
      registry.titleFilePath(createCard('noteRef', { content: { path: 'Notes/甲.md' } })),
    ).toBe('Notes/甲.md');
    expect(registry.titleFilePath(createCard('noteRef', { content: { path: '' } }))).toBeNull();
  });

  it('★ 引用卡重连成非笔记时也不接（标题不该去改那个文件）', () => {
    const card = createCard('noteRef', { content: { path: 'assets/图.png' } });
    expect(registry.titleFilePath(card)).toBeNull();
  });

  it('未注册的类型 → `null`（老文件里可能有将来才认识的类型）', () => {
    const bare = new CardTypeRegistry();
    expect(
      bare.titleFilePath(createCard('boardRef', { content: { path: 'b.nboard' } })),
    ).toBeNull();
  });
});

describe('autoEditOnCreate（O13：落卡要不要立刻进编辑态）', () => {
  /** 视图的判据：**只有明确写 `false` 的才不进**（缺席 = 沿用便签 / 待办的老规矩） */
  const entersEdit = (definition: { autoEditOnCreate?: boolean }): boolean =>
    definition.autoEditOnCreate !== false;

  it('★ 评论卡是唯一"落卡不进编辑态"的类型 —— 新评论是空线程，用户先想把它拖到位', () => {
    expect(entersEdit(commentCard)).toBe(false);
    for (const definition of [
      noteCard,
      noteRefCard,
      imageCard,
      fileCard,
      boardRefCard,
      linkCard,
      todoCard,
      swatchCard,
      inkCard,
      mapCard,
      syncNoteCard,
    ]) {
      expect(entersEdit(definition)).toBe(true);
    }
  });

  it('★ 判据是"不等于 false"而不是"=== true"：漏写的类型保持老行为', () => {
    expect(entersEdit({})).toBe(true);
    expect(entersEdit({ autoEditOnCreate: true })).toBe(true);
    expect(entersEdit({ autoEditOnCreate: false })).toBe(false);
  });
});

describe('两格编辑态（O22：标题那一格放进各自的编辑态，不再有"先编标题行"这一步）', () => {
  it('★ 便签 / 同步便签 / 待办都不声明 `editTitleFirst` —— 标题那一格由编辑态自己表达', () => {
    // 便签是"标题框 + 正文框"两格（`cards/note.ts`），待办是"标题框 + 清单"（`cards/todo.ts`）；
    // 视图不再在进编辑态之前抢一步，所以这个开关已经没有任何类型在用
    for (const definition of [noteCard, syncNoteCard, todoCard]) {
      expect('editTitleFirst' in definition).toBe(false);
    }
  });
});
