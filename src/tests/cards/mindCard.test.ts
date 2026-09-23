/**
 * 内嵌脑图卡（`F4`）的**契约**测试。
 *
 * 卡内那套渲染（`EmbedMind`）与文件卡（`F3a`）共用、在真环境里验；这里钉的是
 * 这张卡自己的三件事：**初始形态**（中心主题 + 3 个分支）、**按内容算尺寸**、
 * 以及**读入口绝不因为一份坏数据就让卡片消失**（那是本项最要紧的一条取舍）。
 */

import { describe, expect, it } from 'vitest';
import { BOARD_SPEC, BOARD_VERSION } from '../../constants';
import { mindCard } from '../../cards/mindCard';
import { INLINE_MIND_BRANCHES, createCard, newMindContent } from '../../model/factories';
import { mindCardSizeFor } from '../../mind/embed/embedGeometry';
import { createMindFile, createMindNode } from '../../mind/model/factories';
import { t } from '../../util/i18n';
import { normalizeBoardFile } from '../../model/validate';
import {
  createFakeDocument,
  createFakeElement,
  type FakeDocument,
  type FakeElement,
} from '../helpers/fakeDom';

/** 一份"最小的合法白板"外壳，只带指定的那几张卡 */
function rawBoard(cards: unknown[]): unknown {
  return {
    spec: BOARD_SPEC,
    version: BOARD_VERSION,
    revision: 1,
    meta: {
      id: 'b_1',
      title: '',
      icon: null,
      createdAt: '',
      updatedAt: '',
      parent: null,
      tags: [],
      aliases: [],
    },
    view: { x: 0, y: 0, zoom: 1, background: 'dots' },
    settings: { snapToGrid: true, gridSize: 16, defaultCardColor: '1', readOnly: false },
    columns: [],
    cards,
    edges: [],
    groups: [],
  };
}

function rawMindCard(content: unknown): unknown {
  return {
    id: 'c_1',
    type: 'mind',
    x: 0,
    y: 0,
    width: 440,
    height: 300,
    z: 1,
    columnId: null,
    order: 0,
    color: '1',
    accent: null,
    locked: false,
    showTitle: false,
    title: '',
    content,
  };
}

describe('内嵌脑图卡 · 初始形态', () => {
  it('★ 中心主题 + 3 个分支（创建时只建根与 3 个子节点；分支带占位文字，用户 2026-09-22）', () => {
    const { mind } = newMindContent();
    const root = mind.nodes.find((node) => node.id === mind.rootId);

    expect(mind.nodes).toHaveLength(1 + INLINE_MIND_BRANCHES);
    expect(root).toBeDefined();
    const kids = mind.nodes.filter((node) => node.parentId === mind.rootId);
    expect(kids).toHaveLength(INLINE_MIND_BRANCHES);
    // ★ 占位文字（用户 2026-09-22：三个空白框看不出该写什么）：
    //   根 = 「中心主题」、分支 = 「分支主题 N」—— 用户一敲字就整格替换
    expect(root?.text).toBe(t('mind.default.root'));
    expect(kids.map((node) => node.text)).toEqual([
      t('mind.default.branch', { index: 1 }),
      t('mind.default.branch', { index: 2 }),
      t('mind.default.branch', { index: 3 }),
    ]);
  });

  it('★ 新建走的是 `model/factories` 那一份（两处各写一份是 O18 踩过的坑）', () => {
    const viaFactory = createCard('mind').content.mind;
    const viaDefinition = mindCard.createDefaultContent().mind;

    for (const mind of [viaFactory, viaDefinition]) {
      expect(mind.nodes).toHaveLength(1 + INLINE_MIND_BRANCHES);
      expect(mind.nodes.filter((node) => node.parentId === mind.rootId)).toHaveLength(
        INLINE_MIND_BRANCHES,
      );
    }
  });

  it('不走"整卡编辑态"（编辑发生在卡内那一层），也不显示标题栏 / 不给「编辑内容」「收起」', () => {
    expect(mindCard.autoEditOnCreate).toBe(false);
    expect(mindCard.menuItems).toEqual({
      editContent: false,
      showTitle: false,
      collapse: false,
    });
  });

  it('★ **无框**（`chrome: bare`）—— 用户 2026-09-21："其实不用底下那个框"', () => {
    // 卡片级入口（拖整张 / 选中 / 右键菜单）改为挂在**根节点**上，不是丢掉
    expect(mindCard.chrome).toBe('bare');
  });
});

describe('内嵌脑图卡 · 尺寸按内容算', () => {
  it('`sizeForContent` 就是那套纯算法（新建时视图会用它顶掉 `defaultSize`）', () => {
    const content = newMindContent();
    expect(mindCard.sizeForContent?.(content)).toEqual(mindCardSizeFor(content.mind));
  });
});

/** 一张够用的渲染上下文（内嵌卡只用到这几个口子；其余按 `never` 放行） */
function fakeContext(doc: FakeDocument): never {
  return {
    app: {},
    sourcePath: '',
    component: {},
    renderMarkdown: async () => undefined,
    zoom: 1,
    mode: 'display',
    readOnly: false,
    updateContent: () => undefined,
    updateCard: () => undefined,
    setMode: () => undefined,
    ownerDocument: doc,
  } as never;
}

const EMBED_ROOT = 'nestboard-mind-embed';

/**
 * `F4` 手工验收（2026-09-21）报的三个 bug 里最重的那一个的**回归线**：
 *
 * 症状 —— "右键加子节点 / 点圆圈折叠之后，整张卡空了"。
 * 根因 —— 卡片层每次重画内容槽都先 `content.textContent = ''`（`CardLayer.renderContent`），
 * 而本定义的重画策略是"**复用** `EmbedMind`、只换模型"（重建会把卡内选中态与正在
 * 编辑的输入框一起扔掉）⇒ 构件被从宿主里摘走了，`update()` 画出来的东西全落在
 * **不在文档里的**元素上，看着就是"卡空了"。
 * 修法 —— `render()` 先 `attachEmbed()` 把根元素放回去，再 `update()`。
 */
describe('内嵌脑图卡 · 重画之后卡面还在（不许"一改节点就空"）', () => {
  it('★★ 内容槽被清空过 ⇒ 重画时那棵 DOM **放回槽里**，而且是同一棵（不重建）', () => {
    const doc = createFakeDocument();
    const el = createFakeElement(doc);
    const content = newMindContent();
    const card = createCard('mind', { content });

    mindCard.render(el as unknown as HTMLElement, card, fakeContext(doc));
    expect(el.children).toHaveLength(1);
    const first = el.children[0] as FakeElement;
    expect(first.classList.contains(EMBED_ROOT)).toBe(true);

    // 卡片层重画的第一步：清空内容槽（被摘掉的是宿主里的引用，构件还在内存里）
    el.textContent = '';
    expect(el.children).toHaveLength(0);

    // 改了一个节点 → 内容变了 → 卡片层再 `render()` 一次
    const changed = { mind: { ...content.mind, revision: content.mind.revision + 1 } };
    mindCard.render(el as unknown as HTMLElement, { ...card, content: changed }, fakeContext(doc));

    expect(el.children).toHaveLength(1);
    // ★ 同一棵：重建会丢掉卡内选中态与"正在打字"的那个输入框
    expect(el.children[0]).toBe(first);
  });

  it('★ 同一个槽位换了另一张卡（复用池）⇒ 旧那棵**摘掉**、新那棵挂上（不许两张叠着）', () => {
    const doc = createFakeDocument();
    const el = createFakeElement(doc);
    const a = createCard('mind', { content: newMindContent() });
    const b = createCard('mind', { content: newMindContent() });

    mindCard.render(el as unknown as HTMLElement, a, fakeContext(doc));
    mindCard.render(el as unknown as HTMLElement, b, fakeContext(doc));

    expect(el.children).toHaveLength(1);
  });

  it('回收（`destroy`）之后槽里不留残骸，下一次渲染从零建一份', () => {
    const doc = createFakeDocument();
    const el = createFakeElement(doc);
    const card = createCard('mind', { content: newMindContent() });

    mindCard.render(el as unknown as HTMLElement, card, fakeContext(doc));
    const first = el.children[0];
    // `destroy` 在类型上是可选的（不是每种卡都有要解绑的东西），这张卡有
    mindCard.destroy?.(el as unknown as HTMLElement);
    expect(el.classList.contains('nestboard-mind-card')).toBe(false);

    mindCard.render(el as unknown as HTMLElement, card, fakeContext(doc));
    expect(el.children).toHaveLength(1);
    expect(el.children[0]).not.toBe(first);
  });
});

describe('内嵌脑图卡 · 导出为 Markdown', () => {
  it('导出的是这份脑图的大纲，**不带** `# 文档标题`（它只是板里的一张卡）', () => {
    const file = createMindFile({ title: '不该出现', rootText: '中心' });
    file.nodes.push(createMindNode({ parentId: file.rootId, text: '分支甲', order: 0 }));

    const markdown = mindCard.toMarkdown(createCard('mind', { content: { mind: file } }), {
      sourcePath: '',
    });

    expect(markdown).toContain('分支甲');
    expect(markdown).not.toContain('不该出现');
    expect(markdown.startsWith('# ')).toBe(false);
  });
});

describe('内嵌脑图卡 · 老卡读入时转成白板级脑图（`2.2.0`）', () => {
  it('★ 合法的 `mind` 卡读进来 ⇒ 变成一棵 `minds[0]`，模型原样带过去', () => {
    const file = createMindFile({ title: '保留我', rootText: '中心' });
    file.revision = 7;
    const result = normalizeBoardFile(rawBoard([rawMindCard({ mind: file })]));

    // 卡片不再是卡片（脑图升格为白板对象），容器里那份模型一个字不改
    expect(result?.board.cards).toHaveLength(0);
    const mind = result?.board.minds?.[0];
    expect(mind?.path).toBe('');
    expect(mind?.mind?.revision).toBe(7);
    expect(mind?.mind?.nodes[0].text).toBe('中心');
  });

  it('★ 容器**沿用原卡的 id** —— 断在它身上的连线因此不用改（迁移不丢线）', () => {
    const raw = rawBoard([rawMindCard({ mind: createMindFile({ rootText: '中心' }) })]) as Record<
      string,
      unknown
    >;
    raw.edges = [
      {
        id: 'e_1',
        from: { cardId: 'c_1', side: null },
        to: { cardId: '', side: null, point: { x: 10, y: 10 } },
        fromEnd: 'arrow',
        toEnd: 'none',
        style: 'solid',
        color: '1',
        label: '',
        routing: 'free',
      },
    ];

    const result = normalizeBoardFile(raw);
    expect(result?.board.minds?.[0].id).toBe('c_1');
    expect(result?.board.edges).toHaveLength(1);
  });

  it('★★ `mind` 里塞的不是脑图 → 容器**照旧留着**，里面是一张全新的空脑图', () => {
    const result = normalizeBoardFile(rawBoard([rawMindCard({ mind: { 这不是: '脑图' } })]));

    expect(result?.board.cards).toHaveLength(0);
    expect(result?.board.minds?.[0].mind?.nodes.length).toBe(1 + INLINE_MIND_BRANCHES);
  });

  it('★ 内容是个对象、但 `mind` 字段没了 ⇒ 同上（容器留着 + 空脑图）', () => {
    // ★ 与"content 不是对象"那条的差别是刻意的：那种连"这是一张脑图卡"都判不了（丢掉），
    //   而这一种只是模型那块坏了 —— 用户写下的**这一棵**不该整棵消失，
    //   原数据仍在 `.nboard` 里（懒迁移：文件要等用户编辑才会被改写）
    const result = normalizeBoardFile(rawBoard([rawMindCard({})]));

    expect(result?.board.cards).toHaveLength(0);
    expect(result?.board.minds?.[0].mind?.nodes.length).toBe(1 + INLINE_MIND_BRANCHES);
  });

  it('`content` 不是对象 ⇒ 卡片丢掉、也没有容器（不能靠"猜"补出一棵脑图）', () => {
    const result = normalizeBoardFile(rawBoard([rawMindCard('不是对象')]));
    expect(result?.board.cards).toHaveLength(0);
    expect(result?.board.minds ?? []).toHaveLength(0);
  });
});
