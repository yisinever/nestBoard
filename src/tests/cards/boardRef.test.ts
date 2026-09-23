/**
 * 白板卡单元测试（T1.61 / `F2-8-1`–`F2-8-3`）。
 *
 * 与文件卡同一套取舍：渲染要在真环境里验，这里钉纯逻辑：
 *   1. **标题兜底**：读不到 `meta.title` 时才用文件名，且必须**剥掉 `.nboard`** ——
 *      否则用户会以为扩展名是标题的一部分；
 *   2. **三态判定**：空 / 断链 / 就绪，断链要说清"哪一块板"没了；
 *   3. **`onDoubleClick` 的接管语义**：只有真的能开才返回 `true`。
 *      返回 `true` 却什么都没开，是"双击了一下就进编辑态"这种鬼问题的源头；
 *   4. **空格位双击 = 新建子板**（`F2-8-1`）：发起方是卡片、落地在视图，
 *      两处入口（双击 / 右键「新建子白板」）因此共用一条实现（不写回内容 = 建了个孤儿板）；
 *   5. **只读小窗**（T7.09 / `F7-10`）：三件最容易静默出错的事 ——
 *      "还没布局就照着 0 规划"、"换档位时把上一扇窗的观察器/订阅漏在 Vault 上"、
 *      "能力缺失时挂出一块永远空着的黑框"。三者都不会报错，只会一直不对劲。
 *   6. **mini 形态**（`O18`）：它比别的档位少得多 —— 不预览内容、不读概要、
 *      不查缩略图缓存，卡面只有"正中一个记号 + 卡外一行名字"。于是要钉的是
 *      "那三块**节点都没建**"（而不是建了再藏）与"名字带完整路径、且画在卡外"——
 *      名字出卡这件事在 DOM 上只是一个 `div`，看不出效果，但它正是"正方形永远是正方形"
 *      与"图标居中"两条反馈的前提。
 *   7. **档位 ↔ 尺寸**（`O18`）：mini 的尺寸由**形态**给（固定正方形），所以"选到它时
 *      钉住、离开它时还回去"必须是同一条历史记录里的一件事，而且"还回去"只在尺寸
 *      确实停在那个正方形上时才做 —— 这一条纯逻辑不钉住，表现是"切档位把卡弄坏了"。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BOARD_REF_DEFAULT_SIZE,
  boardRefCard,
  boardRefPreviewSize,
  boardRefState,
  boardTitleOf,
  cardCountLabel,
  summaryCountLabel,
} from '../../cards/boardRef';
import { NOTE_DEFAULT_SIZE } from '../../cards/note';
import type { CardActionContext, CardRenderContext } from '../../cards/registry';
import { BOARD_REF_MINI_SIZE } from '../../constants';
import { createBoardFile, createCard } from '../../model/factories';
import type { CardOfType } from '../../model/schema';
import { t } from '../../util/i18n';

// ── 纯函数 ────────────────────────────────────────────────────

describe('boardTitleOf', () => {
  it('取文件名并剥掉扩展名', () => {
    expect(boardTitleOf('Boards/子板.nboard')).toBe('子板');
    expect(boardTitleOf('子板.nboard')).toBe('子板');
  });

  it('没有扩展名时原样返回（手改过的路径也不能显示成空标题）', () => {
    expect(boardTitleOf('Boards/子板')).toBe('子板');
    expect(boardTitleOf('')).toBe('');
  });

  it('目录名里的点不算扩展名的起点', () => {
    expect(boardTitleOf('我的.目录/子板')).toBe('子板');
  });

  it('点开头的文件名：只剥最后一段扩展名', () => {
    expect(boardTitleOf('.隐藏.nboard')).toBe('.隐藏');
  });
});

describe('boardRefState', () => {
  const exists = (value: string): boolean => value === 'ok.nboard';

  it('空路径 → empty（还没选板，不是断链）', () => {
    expect(boardRefState({ path: '' }, exists)).toBe('empty');
    expect(boardRefState({ path: '' }, null)).toBe('empty');
  });

  it('有 Vault 桥时按 `exists` 分流', () => {
    expect(boardRefState({ path: 'ok.nboard' }, exists)).toBe('ready');
    expect(boardRefState({ path: 'gone.nboard' }, exists)).toBe('missing');
  });

  it('没有桥一律当作能读', () => {
    expect(boardRefState({ path: 'whatever.nboard' }, null)).toBe('ready');
  });
});

describe('cardCountLabel', () => {
  it('把数量插进 i18n 文案（`0` 也要说出来，否则概览区一片空白像没加载）', () => {
    expect(cardCountLabel(0)).toBe(t('card.boardRef.cards', { count: 0 }));
    expect(cardCountLabel(7)).toBe(t('card.boardRef.cards', { count: 7 }));
  });
});

/**
 * 概要那一行数字（`2.2.0` 收尾）。
 *
 * ★ 这一条同时钉住"一块只有树的板子不是空板"：`paintSummary` 判空用的是
 *   `cards === 0 && minds === 0`，而**数字那句**由这里出。
 */
describe('summaryCountLabel', () => {
  it('没有脑图 ⇒ 与从前一字不差（绝大多数板子走这一条）', () => {
    expect(summaryCountLabel({ cards: 3, columns: 1, minds: 0 })).toBe(
      t('card.boardRef.cards', { count: 3 }),
    );
  });

  it('★ 有脑图 ⇒ 多一段"K 棵脑图"（卡片为 0 也照样说出来）', () => {
    expect(summaryCountLabel({ cards: 3, columns: 1, minds: 2 })).toBe(
      t('card.boardRef.cardsAndMinds', { cards: 3, minds: 2 }),
    );
    expect(summaryCountLabel({ cards: 0, columns: 0, minds: 1 })).toBe(
      t('card.boardRef.cardsAndMinds', { cards: 0, minds: 1 }),
    );
  });
});

// ── 卡片定义契约 ──────────────────────────────────────────────

describe('boardRefCard 定义', () => {
  it('暴露类型 / 默认尺寸 / 默认内容', () => {
    expect(boardRefCard.type).toBe('boardRef');
    // ★ 默认尺寸就是**迷你那个正方形**（用户 2026-09-16）：档位改成 mini 之后尺寸还按
    //   老默认给 280×180 的话，新建出来就是"迷你排版塞在大方块里"的四不像 ——
    //   那正是"新建时还不是迷你、重载之后才变迷你"的根因（重载时被读入口掰成正方形）
    expect(boardRefCard.defaultSize).toEqual(BOARD_REF_MINI_SIZE);

    // ★ 新建会**随机给一个记号**（用户 2026-09-16："新建白板时请赋予随机 emoji 图标"）：
    //   把随机钉住再断言，否则这条用例每次跑的结果都不一样
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      const content = boardRefCard.createDefaultContent();
      expect(content).toMatchObject({ path: '', preview: 'mini', showCount: true });
      // 具体是哪一个 emoji 不重要（清单由 `util/emoji` 说了算），要钉的是"确实给了一个"
      expect(typeof content.icon).toBe('string');
      expect((content.icon ?? '').length).toBeGreaterThan(0);
    } finally {
      random.mockRestore();
    }
  });

  it('导出为 Markdown 用普通 wikilink（`![[子板.nboard]]` 在导出笔记里没有语义）', () => {
    const card = createCard('boardRef', {
      content: { path: 'Boards/子板.nboard', preview: 'thumb', showCount: true },
    });
    expect(boardRefCard.toMarkdown(card, { sourcePath: '' })).toBe('[[Boards/子板.nboard]]');
  });

  it('空路径且没有建板能力 → 不接管双击（没有可编辑正文的卡，交回视图解释）', () => {
    const card = createCard('boardRef');
    const actionCtx = { sourcePath: '' } as unknown as CardActionContext;
    expect(boardRefCard.onDoubleClick?.(card, actionCtx)).toBe(false);
  });

  it('空路径双击 → 让视图为**这张卡**新建一块子板（T1.61 / `F2-8-1`）', () => {
    const card = createCard('boardRef');
    const asked: string[] = [];
    const actionCtx = {
      sourcePath: 'Boards/父板.nboard',
      boards: {
        createChildBoard: (cardId: string) => {
          asked.push(cardId);
          return Promise.resolve(true);
        },
      },
    } as unknown as CardActionContext;

    expect(boardRefCard.onDoubleClick?.(card, actionCtx)).toBe(true);
    expect(asked).toEqual([card.id]);
  });

  it('断链不接管双击：开一块打不开的板只会更让人困惑', () => {
    const card = createCard('boardRef', {
      content: { path: 'gone.nboard', preview: 'thumb', showCount: true },
    });
    const actionCtx = {
      sourcePath: '',
      notes: { exists: () => false },
    } as unknown as CardActionContext;
    expect(boardRefCard.onDoubleClick?.(card, actionCtx)).toBe(false);
  });

  it('没有 `boards` 端口时不接管（本卡的导航能力是视图给的）', () => {
    const card = createCard('boardRef', {
      content: { path: 'ok.nboard', preview: 'thumb', showCount: true },
    });
    const actionCtx = {
      sourcePath: '',
      notes: { exists: () => true },
    } as unknown as CardActionContext;
    expect(boardRefCard.onDoubleClick?.(card, actionCtx)).toBe(false);
  });

  it('能开时接管，并把路径交给 `boards.open`', () => {
    const card = createCard('boardRef', {
      content: { path: 'Boards/子板.nboard', preview: 'thumb', showCount: true },
    });
    const opened: string[] = [];
    const actionCtx = {
      sourcePath: '',
      notes: { exists: () => true },
      boards: {
        open: (path: string) => {
          opened.push(path);
          return Promise.resolve(true);
        },
      },
    } as unknown as CardActionContext;

    expect(boardRefCard.onDoubleClick?.(card, actionCtx)).toBe(true);
    expect(opened).toEqual(['Boards/子板.nboard']);
  });
});

describe('boardRefCard 右键菜单', () => {
  const itemsOf = (card: CardOfType<'boardRef'>, multiple = false) =>
    boardRefCard.contextMenu?.(card, { multiple }) ?? [];

  it('空格位：给「新建子白板」，「进入白板」置灰（没有目标可进）', () => {
    const items = itemsOf(createCard('boardRef'));
    expect(items.map((item) => item.action)).toEqual(['newChildBoard', 'openBoard']);
    expect(items[0]?.disabled).toBe(false);
    expect(items[1]?.disabled).toBe(true);
  });

  it('已经有目标：不给「新建子白板」——那个动作会把它此刻指向的板从画布上抹掉', () => {
    const card = createCard('boardRef', {
      // `icon: ''`：默认内容会随机配一个记号，而"有图标"会多出「移除图标」那一项（见下一条 describe）
      content: { path: 'Boards/子板.nboard', preview: 'thumb', showCount: true, icon: '' },
    });
    const items = itemsOf(card);
    // ★ 只剩两项了：`board-preview` 那一组**收起来了**（用户 2026-09-16："只保留迷你形式，
    //   其他形式都不需要放出来"—— 菜单里不再给档位选择）。
    // ★ `board-icon`（O10）跟在后头，只在**有目标**时出现（见下一条 describe）。
    expect(items.map((item) => item.id)).toEqual(['board-open', 'board-icon']);
    expect(items[0]?.action).toBe('openBoard');
    expect(items[0]?.disabled).toBe(false);
  });

  it('多选：「新建子白板」置灰（说不清该给哪一张建板）', () => {
    const items = itemsOf(createCard('boardRef'), true);
    expect(items[0]?.disabled).toBe(true);
  });
});

// ── 渲染 ──────────────────────────────────────────────────────

/**
 * 最小的假 2D 上下文：保证绘制路径能跑完就好。
 *
 * `paintBoardThumbnail` 真的被调到时不会抛（版式断言在 `boardThumb.test.ts` 里，
 * 那里关心的是"画了什么"；这里只关心"确实去画了"）。
 */
function fakeCanvasContext(ops: string[]): CanvasRenderingContext2D {
  const record = (name: string) => () => {
    ops.push(name);
  };
  const ctx = {
    save: record('save'),
    restore: record('restore'),
    beginPath: record('beginPath'),
    closePath: record('closePath'),
    rect: record('rect'),
    clip: record('clip'),
    setTransform: record('setTransform'),
    fill: record('fill'),
    stroke: record('stroke'),
    fillRect: record('fillRect'),
    arc: record('arc'),
    moveTo: record('moveTo'),
    lineTo: record('lineTo'),
    arcTo: record('arcTo'),
    setLineDash: record('setLineDash'),
    drawImage: record('drawImage'),
    fillText: (text: string) => ops.push(`fillText:${text}`),
    measureText: (text: string) => ({ width: text.length * 6 }),
  };
  return ctx as unknown as CanvasRenderingContext2D;
}

/**
 * 只造出本定义真正会碰的那几个 DOM 能力（与 `helpers/fakeDom.ts` 的取舍一致）。
 *
 * ★ `size` 是**所有造出来的节点共用**的一份"量到的尺寸"：只读小窗是"先量再画"的，
 *   而 node 下没有布局系统 —— 想让那扇窗画出东西，测试得先给一个尺寸。
 *   （`ResizeObserver` 在 node 里不存在，所以会走 `mountWindow` 的同步兜底那条路。）
 */
function fakeSlot() {
  const created: { tag: string; className: string; textContent: string; title: string }[] = [];
  /** 共用尺寸：小窗量的是 `body`，而 `body` 是 `createElement` 现造的 */
  const size = { width: 0, height: 0 };
  /** 画布上下文记下的调用（整个槽位共用一份：一张卡只有一扇窗） */
  const canvasOps: string[] = [];
  const fakeDocument = {
    createElement: (tag: string) => {
      const attributes: Record<string, string> = {};
      const node: Record<string, unknown> = {
        tag,
        className: '',
        textContent: '',
        title: '',
        // ★ 属性读写要真的记账：`aria-label` 就是靠它落到标题行上的（A1），
        //   只给个 `title` 属性的话，`setAttribute` 一调就抛 TypeError ——
        //   那种失败测的不是卡片，是假 DOM 缺了个方法
        attributes,
        setAttribute: (name: string, value: string) => {
          attributes[name] = value;
        },
        getAttribute: (name: string) => attributes[name] ?? null,
        dataset: {} as Record<string, string>,
        classes: new Set<string>(),
        classList: {
          add: (...names: string[]) =>
            names.forEach((name) => (node.classes as Set<string>).add(name)),
          remove: (...names: string[]) =>
            names.forEach((name) => (node.classes as Set<string>).delete(name)),
          contains: (name: string) => (node.classes as Set<string>).has(name),
        },
        children: [] as unknown[],
        appendChild: (child: unknown) => {
          (node.children as unknown[]).push(child);
        },
        // 小窗要的那几个（T7.09）：canvas 的后备尺寸 / CSS 尺寸 / 上下文
        width: 0,
        height: 0,
        style: {} as Record<string, string>,
        getContext: () => fakeCanvasContext(canvasOps),
      };
      Object.defineProperty(node, 'clientWidth', { get: () => size.width });
      Object.defineProperty(node, 'clientHeight', { get: () => size.height });
      // ★ 节点也要能再 `createElement`：缩略图是在 body 上现造 `<img>`（T4.16）
      node.ownerDocument = fakeDocument;
      created.push(node as { tag: string; className: string; textContent: string; title: string });
      return node;
    },
    createTextNode: (text: string) => ({ text }),
  };
  const el = {
    isConnected: true,
    dataset: {} as Record<string, string>,
    classes: new Set<string>(),
    children: [] as unknown[],
    classList: {
      add: (...names: string[]) => names.forEach((name) => el.classes.add(name)),
      remove: (...names: string[]) => names.forEach((name) => el.classes.delete(name)),
      contains: (name: string) => el.classes.has(name),
    },
    replaceChildren: (...nodes: unknown[]) => {
      el.children = nodes;
    },
    ownerDocument: fakeDocument,
  };
  return { el, created, size, canvasOps };
}

function renderBoardRef(
  path: string,
  overrides: Partial<CardRenderContext> = {},
  ready: () => void = () => {},
) {
  const { el } = fakeSlot();
  // ★ `icon: ''` 要显式给：新建白板卡现在默认带一个**随机**记号（用户 2026-09-16），
  //   不写死的话"没设图标"这一类用例会随机地红
  const card = createCard('boardRef', {
    content: { path, preview: 'thumb', showCount: true, icon: '' },
  });
  boardRefCard.render(el as unknown as HTMLElement, card, {
    sourcePath: '',
    contentReady: ready,
    ...overrides,
  } as unknown as CardRenderContext);
  return el;
}

describe('渲染', () => {
  it('空路径 → 引导文案 + 占位标记', () => {
    const el = renderBoardRef('');
    expect(el.classes.has('is-empty')).toBe(true);
    expect(el.dataset.placeholder).toBe('true');
    expect(el.children[0]).toMatchObject({ text: t('card.boardRef.empty') });
  });

  it('断链 → 说清哪一块板没了', () => {
    const el = renderBoardRef('gone.nboard', {
      notes: { exists: () => false },
    } as unknown as Partial<CardRenderContext>);
    expect(el.classes.has('is-missing')).toBe(true);
    expect(el.children[0]).toMatchObject({
      text: t('card.boardRef.missing', { path: 'gone.nboard' }),
    });
  });

  it('就绪 → 先画标题，概要异步落地后填计数并喊 `contentReady`', async () => {
    const ready = vi.fn();
    let summary: { cards: number; columns: number } | null = null;
    const el = renderBoardRef(
      'Boards/子板.nboard',
      {
        boards: {
          open: () => Promise.resolve(true),
          summary: () => Promise.resolve(summary),
        },
      } as unknown as Partial<CardRenderContext>,
      ready,
    );

    // 标题立刻可见，计数还没填（概要要等一次异步读）
    expect(el.children.length).toBe(2);
    expect(ready).not.toHaveBeenCalled();

    summary = { cards: 3, columns: 1 };
    await Promise.resolve();
    await Promise.resolve();

    expect(ready).toHaveBeenCalled();
  });

  it('标题行带完整路径：`title` 与 `aria-label` 都要有', () => {
    // 回归（A1）：只设原生 `title` 时，在 Obsidian 里悬停标题行**什么都不弹**
    // （原生 tooltip 要鼠标静止一秒，Electron 下还常被吞）；`aria-label` 才是
    // Obsidian 自己那套 tooltip 读的那一份。两者缺一，用户就拿不到完整路径。
    const el = renderBoardRef('Boards/子板.nboard');
    const header = el.children[0] as { children: unknown[] };
    const titleEl = header.children[1] as {
      textContent: string;
      title: string;
      attributes: Record<string, string>;
    };

    // 卡面上只放文件名：整条路径会挤掉标题本身
    expect(titleEl.textContent).toBe('子板');
    // 完整路径留给悬停
    expect(titleEl.title).toBe('Boards/子板.nboard');
    expect(titleEl.attributes['aria-label']).toBe('Boards/子板.nboard');
  });
});

// ── 板缩略图（T4.16 / F2-8-2） ─────────────────────────────────

/** 造一个只带缩略图端口的 `boards`；`summary` 固定"读不到"以免干扰断言 */
function boardsWithThumb(thumb: unknown): CardRenderContext['boards'] {
  return {
    open: () => Promise.resolve(true),
    summary: () => Promise.resolve(null),
    thumbnail: thumb,
  } as unknown as CardRenderContext['boards'];
}

interface FakeNode {
  tag?: string;
  className?: string;
  src?: string;
  alt?: string;
  draggable?: boolean;
  textContent?: string;
  classes: Set<string>;
  children: unknown[];
}

// ── 卡面图标（O10） ────────────────────────────────────────────

describe('卡面图标', () => {
  /** 造一张就绪的白板卡；`icon` 缺省 = 没设 */
  function renderIcon(icon?: string) {
    const { el } = fakeSlot();
    const card = createCard('boardRef', {
      content: {
        path: 'Boards/子板.nboard',
        preview: 'thumb',
        showCount: true,
        // ★ `icon: ''` 是"没设图标"的显式写法：默认内容现在会随机配一个记号（见上）
        icon: icon ?? '',
      },
    });
    boardRefCard.render(el as unknown as HTMLElement, card, {
      sourcePath: '',
    } as unknown as CardRenderContext);
    return el;
  }

  const iconOf = (el: { children: unknown[] }): FakeNode =>
    (el.children[0] as unknown as FakeNode).children[0] as unknown as FakeNode;

  it('设了图标 → 那一格画 emoji 并带上 `is-emoji`（不再画强调色方块）', () => {
    const icon = iconOf(renderIcon('📌'));
    expect(icon.textContent).toBe('📌');
    expect(icon.classes.has('is-emoji')).toBe(true);
  });

  it('没设图标 → 那一格留空、不带 `is-emoji`（退回强调色小方块的老外观）', () => {
    const icon = iconOf(renderIcon());
    expect(icon.textContent).toBe('');
    expect(icon.classes.has('is-emoji')).toBe(false);
  });

  it('★ 手改文件写进来的脏值先归一：控制字符不进 DOM', () => {
    const icon = iconOf(renderIcon('\n🚀\u0000'));
    expect(icon.textContent).toBe('🚀');
  });
});

describe('板缩略图', () => {
  it('`peek` 命中 → 同步挂图 + `is-thumb` + `contentReady`（一帧都不等）', () => {
    const ready = vi.fn();
    const el = renderBoardRef(
      'Boards/子板.nboard',
      {
        boards: boardsWithThumb({
          peek: () => 'blob:cached',
          get: () => Promise.resolve(null),
        }),
      } as unknown as Partial<CardRenderContext>,
      ready,
    );

    const body = el.children[1] as unknown as FakeNode;
    expect(body.classes.has('is-thumb')).toBe(true);
    // [0] 计数行、[1] 缩略图（图追加在最后，压在计数之上，见 `paintThumbnail` 注释）
    expect(body.children[1]).toMatchObject({
      tag: 'img',
      className: 'nestboard-board-ref-thumb',
      src: 'blob:cached',
      alt: '',
      draggable: false,
    });
    expect(ready).toHaveBeenCalled();
  });

  it('`peek` 未命中 → 等 `get` 回来再挂图', async () => {
    const el = renderBoardRef('Boards/子板.nboard', {
      boards: boardsWithThumb({
        peek: () => null,
        get: () => Promise.resolve('blob:later'),
      }),
    } as unknown as Partial<CardRenderContext>);

    const body = el.children[1] as unknown as FakeNode;
    expect(body.classes.has('is-thumb')).toBe(false);

    await Promise.resolve();
    await Promise.resolve();

    expect(body.classes.has('is-thumb')).toBe(true);
    expect(body.children[1]).toMatchObject({ src: 'blob:later' });
  });

  it('`get` 拿不到 → 什么都不补，卡面留在概要面板态', async () => {
    const el = renderBoardRef('Boards/子板.nboard', {
      boards: boardsWithThumb({
        peek: () => null,
        get: () => Promise.resolve(null),
      }),
    } as unknown as Partial<CardRenderContext>);

    await Promise.resolve();
    await Promise.resolve();

    const body = el.children[1] as unknown as FakeNode;
    expect(body.classes.has('is-thumb')).toBe(false);
    // 只剩计数行 —— 不补"预览失败"那种用户无能为力的字
    expect(body.children).toHaveLength(1);
  });

  it('没有缩略图端口 → 只能用概要面板（单测 / 只装了图片管线的环境）', () => {
    const el = renderBoardRef('Boards/子板.nboard', {
      boards: {
        open: () => Promise.resolve(true),
        summary: () => Promise.resolve(null),
      } as unknown as CardRenderContext['boards'],
    } as unknown as Partial<CardRenderContext>);

    const body = el.children[1] as unknown as FakeNode;
    expect(body.classes.has('is-thumb')).toBe(false);
    expect(body.children).toHaveLength(1);
  });

  it('`preview: none` → 不请求缩略图（用户关掉了预览）', () => {
    const { el } = fakeSlot();
    const card = createCard('boardRef', {
      content: { path: 'Boards/子板.nboard', preview: 'none', showCount: true },
    });
    const get = vi.fn(() => Promise.resolve('blob:x'));
    boardRefCard.render(el as unknown as HTMLElement, card, {
      sourcePath: '',
      boards: boardsWithThumb({ peek: () => 'blob:x', get }),
    } as unknown as CardRenderContext);

    const body = el.children[1] as unknown as FakeNode;
    expect(body.classes.has('is-thumb')).toBe(false);
    expect(get).not.toHaveBeenCalled();
  });
});

// ── mini 形态（O18） ──────────────────────────────────────────

describe('mini 形态（不预览内容）', () => {
  /** 造一张就绪的白板卡；`preview` 缺省 = thumb */
  function renderMini(
    preview: 'thumb' | 'mini',
    overrides: Partial<CardRenderContext> = {},
    icon?: string,
  ) {
    const { el } = fakeSlot();
    const card = createCard('boardRef', {
      content: {
        path: 'Boards/子板.nboard',
        preview,
        showCount: true,
        // ★ `icon: ''` 是"没设图标"的显式写法（默认内容现在会随机配一个记号）
        icon: icon ?? '',
      },
    });
    boardRefCard.render(el as unknown as HTMLElement, card, {
      sourcePath: '',
      ...overrides,
    } as unknown as CardRenderContext);
    return el;
  }

  it('★ 卡面只有两件：正中一个记号、卡外一行名字（标题行/计数行/预览区一个都不建）', () => {
    const ready = vi.fn();
    const peek = vi.fn(() => 'blob:cached');
    const el = renderMini('mini', {
      contentReady: ready,
      boards: boardsWithThumb({ peek, get: () => Promise.resolve(null) }),
    } as Partial<CardRenderContext>);

    expect(el.classes.has('is-mini')).toBe(true);
    expect(el.children).toHaveLength(2);
    expect(el.children[0]).toMatchObject({ className: 'nestboard-board-ref-mini-icon' });
    expect(el.children[1]).toMatchObject({
      className: 'nestboard-board-ref-mini-title',
      textContent: '子板',
    });

    // ★ 「不预览内容」这一条的可测形态：缩略图端口一次都没被碰过，`contentReady` 也不喊
    //   —— 卡面在 `render()` 返回时就画完了，没有"稍后会到的东西"要等
    expect(peek).not.toHaveBeenCalled();
    expect(ready).not.toHaveBeenCalled();
  });

  it('★ 设了图标 → 正中那一格画 emoji（"添加图标无效、该在正方形里居中"那条反馈的落点）', () => {
    const mark = renderMini('mini', {}, '📌').children[0] as unknown as FakeNode;
    expect(mark.textContent).toBe('📌');
    expect(mark.classes.has('is-emoji')).toBe(true);
  });

  it('没设图标 → 记号留空、不带 `is-emoji`（样式退回强调色方块，不是一片空白）', () => {
    const mark = renderMini('mini').children[0] as unknown as FakeNode;
    expect(mark.textContent).toBe('');
    expect(mark.classes.has('is-emoji')).toBe(false);
  });

  it('名字画在卡外：卡面只放文件名，完整路径留给 `title` / `aria-label`', () => {
    const name = renderMini('mini').children[1] as unknown as {
      textContent: string;
      title: string;
      attributes: Record<string, string>;
    };
    expect(name.textContent).toBe('子板');
    expect(name.title).toBe('Boards/子板.nboard');
    expect(name.attributes['aria-label']).toBe('Boards/子板.nboard');
  });

  it('概要到得再晚也不会冒出计数行（连节点都没有，没地方写）', async () => {
    const el = renderMini('mini', {
      boards: {
        open: () => Promise.resolve(true),
        // 故意给一张**空板**：非 mini 时它会让预览区标上 `is-empty`，
        // 而 mini 连预览区都没有，所以卡面照旧还是那两件
        summary: () => Promise.resolve({ cards: 0, columns: 0, edges: 0 }),
      } as unknown as CardRenderContext['boards'],
    } as Partial<CardRenderContext>);

    await Promise.resolve();
    await Promise.resolve();

    expect(el.children).toHaveLength(2);
  });

  it('同一个槽位来回换档位：上一轮的骨架被整块换掉，`is-mini` 也跟着走了', () => {
    const { el } = fakeSlot();
    const boards = boardsWithThumb({ peek: () => 'blob:x', get: () => Promise.resolve(null) });
    const render = (preview: 'thumb' | 'mini'): void => {
      boardRefCard.render(
        el as unknown as HTMLElement,
        createCard('boardRef', {
          content: { path: 'Boards/子板.nboard', preview, showCount: true },
        }),
        { sourcePath: '', boards } as unknown as CardRenderContext,
      );
    };

    render('thumb');
    expect(el.children).toHaveLength(2);
    expect(el.children[0]).toMatchObject({ className: 'nestboard-board-ref-header' });
    expect(el.classes.has('is-mini')).toBe(false);

    // 内容槽是复用池里同一个节点：上一轮的标题行与预览区必须一起消失
    render('mini');
    expect(el.children).toHaveLength(2);
    expect(el.children[0]).toMatchObject({ className: 'nestboard-board-ref-mini-icon' });
    expect(el.classes.has('is-mini')).toBe(true);

    // ★ 换回去时 `is-mini` 必须摘掉：样式表里那条"藏掉尺寸手柄"的规则认的就是它，
    //   漏摘的后果是换回缩略图之后这张卡再也拉不动
    render('thumb');
    expect(el.classes.has('is-mini')).toBe(false);
    expect(el.children[0]).toMatchObject({ className: 'nestboard-board-ref-header' });
  });

  it('断链时不标 `is-mini`：卡面上只有一句话，没有可居中的记号', () => {
    const { el } = fakeSlot();
    boardRefCard.render(
      el as unknown as HTMLElement,
      createCard('boardRef', {
        content: { path: 'Boards/没了.nboard', preview: 'mini', showCount: true },
      }),
      { sourcePath: '', notes: { exists: () => false } } as unknown as CardRenderContext,
    );

    expect(el.classes.has('is-missing')).toBe(true);
    expect(el.classes.has('is-mini')).toBe(false);
  });
});

// ── 档位 ↔ 尺寸（O18） ─────────────────────────────────────────

describe('mini 的固定正方形尺寸', () => {
  it('★ 常量就是"便签默认宽的三分之一"（写死的那个数必须跟着便签走）', () => {
    // 两个常量分在两个文件里（`constants.ts` 不能 import 任何模块），
    // 所以这条断言是它们之间唯一的联系 —— 改便签默认宽时它会立刻红
    expect(BOARD_REF_MINI_SIZE.width).toBe(Math.round(NOTE_DEFAULT_SIZE.width / 3));
    expect(BOARD_REF_MINI_SIZE.height).toBe(BOARD_REF_MINI_SIZE.width);
    // 比尺寸下限大一档：小于它就会被 `applyCardRects` 静默撑大，正方形不再是正方形
    expect(BOARD_REF_MINI_SIZE.width).toBeGreaterThanOrEqual(80);
  });

  const cardOf = (
    preview: CardOfType<'boardRef'>['content']['preview'],
    width: number,
    height: number,
  ): CardOfType<'boardRef'> =>
    createCard('boardRef', {
      width,
      height,
      content: { path: 'Boards/子板.nboard', preview, showCount: true },
    });

  it('★ 选到 mini → 尺寸由形态给，与卡现在多大无关', () => {
    expect(boardRefPreviewSize('mini', cardOf('thumb', 280, 180))).toEqual(BOARD_REF_MINI_SIZE);
    // 已经停在正方形上也照样给：那是"再点一次"的手动修复路径（存量卡片用得上）
    expect(boardRefPreviewSize('mini', cardOf('mini', 400, 200))).toEqual(BOARD_REF_MINI_SIZE);
  });

  it('★ 离开 mini 且还停在正方形上 → 还给该类型的默认尺寸', () => {
    for (const next of ['thumb', 'live', 'none'] as const) {
      expect(
        boardRefPreviewSize(
          next,
          cardOf('mini', BOARD_REF_MINI_SIZE.width, BOARD_REF_MINI_SIZE.height),
        ),
      ).toEqual(BOARD_REF_DEFAULT_SIZE);
    }
  });

  it('离开 mini 但尺寸已经不是那个正方形 → 一个字都不动（那是用户/手改文件的输入）', () => {
    expect(boardRefPreviewSize('thumb', cardOf('mini', 280, 180))).toBeNull();
  });

  it('不在 mini 那一档之间换档位 → 尺寸从不参与', () => {
    expect(boardRefPreviewSize('live', cardOf('thumb', 280, 180))).toBeNull();
    expect(boardRefPreviewSize('none', cardOf('live', 123, 45))).toBeNull();
  });
});

// ── 卡面预览档位：**入口已收起**（用户 2026-09-16） ──────────────
//
// "所有白板，只保留迷你形式。其他形式都不需要放出来" ⇒ 四档子菜单整组从菜单里去掉。
//
// ★ 这一组钉的是"**入口没了**"，不是"这个能力没了"：
//   * 三种旧档的**渲染**都还在（`render()` 里那两个分支），手改过的文件照样画得出来；
//   * 读入口会把任何档位**归一成 `mini`**（`validate.normalizeBoardRefContent`）⇒
//     存量卡一打开就是迷你（尺寸由紧随其后的"mini 钉正方形"接手）——
//     那条判据钉在 `tests/model` 的 `normalizeBoardFile` 那一组里。
// ★ 哪天要把档位选择加回来，这一组会**红**着提醒你一并想清楚
//   "要不要恢复菜单项、文案与 `checked` 规则"。

describe('boardRefCard 右键菜单 · 卡面预览（入口已收起）', () => {
  const hasPreviewGroup = (card: CardOfType<'boardRef'>, multiple = false): boolean =>
    (boardRefCard.contextMenu?.(card, { multiple }) ?? []).some(
      (item) => item.id === 'board-preview',
    );

  it('★ 菜单里**没有**预览档位那一组了（单选 / 多选都一样）', () => {
    const card = createCard('boardRef', {
      content: { path: 'Boards/子板.nboard', preview: 'thumb', showCount: true },
    });

    expect(hasPreviewGroup(card)).toBe(false);
    expect(hasPreviewGroup(card, true)).toBe(false);
    // 空格位（没有目标）更是没有可预览的东西
    expect(hasPreviewGroup(createCard('boardRef'))).toBe(false);
  });
});

// ── 卡面图标（O10） ────────────────────────────────────────────

describe('boardRefCard 右键菜单 · 卡面图标', () => {
  const itemsOf = (card: CardOfType<'boardRef'>, multiple = false) =>
    boardRefCard.contextMenu?.(card, { multiple }) ?? [];
  const withIcon = (icon?: string) =>
    createCard('boardRef', {
      content: {
        path: 'Boards/子板.nboard',
        preview: 'thumb',
        showCount: true,
        // ★ `icon: ''` 是"没设图标"的显式写法（默认内容现在会随机配一个记号）
        icon: icon ?? '',
      },
    });

  it('还没设图标：只给「添加图标」（没有可清除的，不摆一项灰的）', () => {
    const items = itemsOf(withIcon());
    const pick = items.find((item) => item.id === 'board-icon');
    expect(pick?.action).toBe('pickBoardIcon');
    expect(pick?.title).toBe(t('menu.card.pickIcon'));
    expect(items.some((item) => item.id === 'board-icon-clear')).toBe(false);
  });

  it('已设图标：同一项改叫「更换图标」，并多出「清除图标」', () => {
    const items = itemsOf(withIcon('📌'));
    const pick = items.find((item) => item.id === 'board-icon');
    expect(pick?.title).toBe(t('menu.card.changeIcon'));
    expect(items.find((item) => item.id === 'board-icon-clear')?.action).toBe('clearBoardIcon');
  });

  it('★ 空格位不出现：卡面根本不画标题行（更没有那一格），选了也看不见', () => {
    const ids = itemsOf(createCard('boardRef')).map((item) => item.id);
    expect(ids).not.toContain('board-icon');
  });

  it('多选：两项都置灰（说不清该给哪一张换图标）', () => {
    const items = itemsOf(withIcon('📌'), true);
    expect(items.find((item) => item.id === 'board-icon')?.disabled).toBe(true);
    expect(items.find((item) => item.id === 'board-icon-clear')?.disabled).toBe(true);
  });
});

// ── 只读小窗（T7.09 / F7-10） ───────────────────────────────────

/** 目标板的读取端口：默认给一块有卡片的板（空板会被规划拒掉，测不出"画了"） */
function sampleBoard() {
  return createBoardFile({
    cards: [createCard('note', { content: { md: 'x' }, width: 200, height: 120 })],
  });
}

/** 造一个只带小窗端口的 `boards`；`summary` 固定"读不到"以免干扰断言 */
function boardsWithWindow(overrides: Record<string, unknown> = {}): CardRenderContext['boards'] {
  return {
    open: () => Promise.resolve(true),
    summary: () => Promise.resolve(null),
    ...overrides,
  } as unknown as CardRenderContext['boards'];
}

/**
 * 渲染一张 `preview: 'live'` 的白板卡。
 *
 * ★ `size` 必须在 `render()` **之前**给：小窗是先量尺寸再决定读不读模型的，
 *   而 node 下没有布局 —— 量到的就是这里写下的数。
 */
function renderLive(
  path: string,
  boards: CardRenderContext['boards'],
  options: { size?: { width: number; height: number }; ready?: () => void } = {},
) {
  const slot = fakeSlot();
  if (options.size) {
    slot.size.width = options.size.width;
    slot.size.height = options.size.height;
  }
  const card = createCard('boardRef', { content: { path, preview: 'live', showCount: true } });
  boardRefCard.render(slot.el as unknown as HTMLElement, card, {
    sourcePath: '',
    contentReady: options.ready ?? (() => {}),
    boards,
  } as unknown as CardRenderContext);
  return slot;
}

interface FakeWindowNode extends FakeNode {
  width: number;
  height: number;
  style: Record<string, string>;
}

function bodyOf(slot: ReturnType<typeof fakeSlot>): FakeNode {
  return slot.el.children[1] as unknown as FakeNode;
}

function canvasOf(slot: ReturnType<typeof fakeSlot>): FakeWindowNode | undefined {
  return bodyOf(slot).children[1] as unknown as FakeWindowNode | undefined;
}

/** 把已排队的微任务跑完（`readBoard` 是异步的，`draw` 在 `.then` 里落地） */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('板只读小窗（T7.09）', () => {
  beforeEach(() => {
    // `readPngPalette` 读的是计算后的主题色 —— node 下没有 `getComputedStyle`。
    // 给它一个"什么变量都没定义"的实现：调色板全部走兜底色，绘制路径照跑
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('`live` → 预览区标 `is-window` 并挂上 canvas，缩略图不再被请求', () => {
    const get = vi.fn(() => Promise.resolve('blob:x'));
    const slot = renderLive(
      'Boards/子板.nboard',
      boardsWithWindow({
        readBoard: () => Promise.resolve(sampleBoard()),
        thumbnail: { peek: () => 'blob:x', get },
      }),
    );

    const body = bodyOf(slot);
    expect(body.classes.has('is-window')).toBe(true);
    expect(body.classes.has('is-thumb')).toBe(false);
    expect(canvasOf(slot)).toMatchObject({
      tag: 'canvas',
      className: 'nestboard-board-ref-window',
    });
    // 两者画在同一块预览区里，同时挂上只会打架 —— 小窗档位必须让缩略图整条路闭嘴
    expect(get).not.toHaveBeenCalled();
  });

  it('★ 尺寸还是 0（刚 `render`、还没插进 DOM）→ 一次模型都不读', () => {
    // 照 0 规划只会得到一张 1×1 的图，而卡面此后不会自己变好看
    const read = vi.fn(() => Promise.resolve(sampleBoard()));
    const slot = renderLive('Boards/子板.nboard', boardsWithWindow({ readBoard: read }));

    expect(read).not.toHaveBeenCalled();
    // 但 canvas 已经挂上了：等观察器报到真实尺寸就会画
    expect(canvasOf(slot)).toBeDefined();
  });

  it('量到尺寸 → 读模型、按规划设画布尺寸并真的画了一笔', async () => {
    const ready = vi.fn();
    const slot = renderLive(
      'Boards/子板.nboard',
      boardsWithWindow({ readBoard: () => Promise.resolve(sampleBoard()) }),
      { size: { width: 400, height: 300 }, ready },
    );

    await flush();

    const canvas = canvasOf(slot);
    // 后备像素 = CSS × dpr（node 下 dpr 没有来源 → 1），所以这里等于框的尺寸
    expect(canvas).toMatchObject({ width: 400, height: 300 });
    expect(canvas?.style.width).toBe('400px');
    expect(canvas?.style.height).toBe('300px');
    expect(slot.canvasOps).toContain('setTransform');
    expect(slot.canvasOps.some((op) => op.startsWith('fillText:'))).toBe(true);
    expect(ready).toHaveBeenCalled();
  });

  it('目标板被保存 → 重读重画（"小窗"不能永远停在最初那一眼）', async () => {
    // ★ 用对象装监听器而不是 `let notify: (() => void) | null = null`：
    //   赋值发生在传给 `watchBoard` 的闭包里，TS 的控制流分析看不到它，
    //   于是把 `notify` 一路窄化成 `null`，`notify?.()` 就成了对 `never` 调用
    const holder: { notify: (() => void) | null } = { notify: null };
    const read = vi.fn(() => Promise.resolve(sampleBoard()));
    const slot = renderLive(
      'Boards/子板.nboard',
      boardsWithWindow({
        readBoard: read,
        watchBoard: (_path: string, listener: () => void) => {
          holder.notify = listener;
          return () => {
            holder.notify = null;
          };
        },
      }),
      { size: { width: 400, height: 300 } },
    );

    await flush();
    expect(read).toHaveBeenCalledTimes(1);
    expect(holder.notify).not.toBeNull();

    holder.notify?.();
    await flush();
    expect(read).toHaveBeenCalledTimes(2);
    expect(slot.canvasOps.length).toBeGreaterThan(0);
  });

  it('读不到目标板（文件没了 / 解析失败）→ 什么都不画，也不抛', async () => {
    const slot = renderLive(
      'Boards/子板.nboard',
      boardsWithWindow({ readBoard: () => Promise.resolve(null) }),
      { size: { width: 400, height: 300 } },
    );

    await flush();

    // 画布留在 0×0（压下去的初始值）：计数行已经是"没有预览"时的正确形态，
    // 再补一句"预览失败"只是让卡面上多一行用户无能为力的字
    expect(canvasOf(slot)?.width).toBe(0);
  });

  it('空板：规划也会返回 `null`，这里提前退出（不申请一块纯背景画布）', async () => {
    const slot = renderLive(
      'Boards/子板.nboard',
      boardsWithWindow({ readBoard: () => Promise.resolve(createBoardFile()) }),
      { size: { width: 400, height: 300 } },
    );

    await flush();

    expect(canvasOf(slot)?.width).toBe(0);
  });

  it('卡面大小变了（观察器再报一次）→ 重读重画', async () => {
    const slot = renderLive(
      'Boards/子板.nboard',
      boardsWithWindow({ readBoard: () => Promise.resolve(sampleBoard()) }),
      { size: { width: 400, height: 300 } },
    );
    await flush();
    expect(canvasOf(slot)?.style.width).toBe('400px');

    // node 下没有 `ResizeObserver`，走的是"只画一次"的兜底路径 ——
    // 所以这里直接换尺寸再渲染一遍，验的是"同一张卡重新渲染不会留下旧的一扇窗"
    slot.size.width = 320;
    slot.size.height = 200;
    const card = createCard('boardRef', {
      content: { path: 'Boards/子板.nboard', preview: 'live', showCount: true },
    });
    boardRefCard.render(slot.el as unknown as HTMLElement, card, {
      sourcePath: '',
      boards: boardsWithWindow({ readBoard: () => Promise.resolve(sampleBoard()) }),
    } as unknown as CardRenderContext);
    await flush();

    expect(canvasOf(slot)?.style.width).toBe('320px');
  });

  it('★ 没提供 `readBoard` 能力 → 退回概要面板，不挂一块永远空着的框', () => {
    const slot = renderLive('Boards/子板.nboard', boardsWithWindow(), {
      size: { width: 400, height: 300 },
    });

    const body = bodyOf(slot);
    expect(body.classes.has('is-window')).toBe(false);
    // 只剩计数行
    expect(body.children).toHaveLength(1);
  });

  it('★ 卡片被回收 → 订阅退掉（文件订阅挂在 Vault 上，不是挂在这张卡上）', () => {
    const unwatch = vi.fn();
    const slot = renderLive(
      'Boards/子板.nboard',
      boardsWithWindow({
        readBoard: () => Promise.resolve(sampleBoard()),
        watchBoard: () => unwatch,
      }),
      { size: { width: 400, height: 300 } },
    );

    boardRefCard.destroy?.(slot.el as unknown as HTMLElement);
    expect(unwatch).toHaveBeenCalled();
  });

  it('★ 同一张卡换档位（内容槽是复用的，走的是再 `render` 一次）→ 上一扇窗先被收掉', () => {
    // 这是最容易漏的一条：`destroy` 根本不会发生，不收就是"每换一次档位
    // 就多留一个 Vault 订阅与一个观察器在盯着一张已经不在 DOM 里的画布"
    const unwatch = vi.fn();
    const slot = renderLive(
      'Boards/子板.nboard',
      boardsWithWindow({
        readBoard: () => Promise.resolve(sampleBoard()),
        watchBoard: () => unwatch,
      }),
      { size: { width: 400, height: 300 } },
    );
    expect(unwatch).not.toHaveBeenCalled();

    const card = createCard('boardRef', {
      content: { path: 'Boards/子板.nboard', preview: 'thumb', showCount: true },
    });
    boardRefCard.render(slot.el as unknown as HTMLElement, card, {
      sourcePath: '',
      boards: boardsWithThumb({ peek: () => 'blob:x', get: () => Promise.resolve(null) }),
    } as unknown as CardRenderContext);

    expect(unwatch).toHaveBeenCalledTimes(1);
    const body = bodyOf(slot);
    expect(body.classes.has('is-window')).toBe(false);
    expect(body.classes.has('is-thumb')).toBe(true);
  });

  it('`thumb` / `none` 档位不挂小窗（回归：档位互相不串）', () => {
    for (const preview of ['thumb', 'none'] as const) {
      const { el } = fakeSlot();
      const card = createCard('boardRef', {
        content: { path: 'Boards/子板.nboard', preview, showCount: true },
      });
      boardRefCard.render(el as unknown as HTMLElement, card, {
        sourcePath: '',
        boards: boardsWithWindow({ readBoard: () => Promise.resolve(sampleBoard()) }),
      } as unknown as CardRenderContext);

      const body = el.children[1] as unknown as FakeNode;
      expect(body.classes.has('is-window')).toBe(false);
      expect(body.children).toHaveLength(1);
    }
  });
});
