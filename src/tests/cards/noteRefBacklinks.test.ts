/**
 * 引用卡底部的跨白板反链角标（T5.04 / `F10-03`）。
 *
 * 这里钉的不是"链接索引扫得准不准"（那是 `integration/LinkIndex.test.ts` 的事），
 * 而是**卡片怎么消费那份索引**：
 *
 *  1. 有反链才画角标 —— 每张引用卡底部悬一条「0 条反链」是纯噪声；
 *  2. 索引是分片异步扫的，所以卡片要**跟着变**（订阅 + 条数变了才重画）；
 *  3. 展开态是纯展示态，不能被一次"索引又扫到一条"的重画给合上；
 *  4. 点角标 / 点一条反链都得拦住 `pointerdown`，否则会先被卡片层当成拖动手势。
 *
 * 单测跑在 node 环境（无 DOM），假节点见 `helpers/fakeDom.ts`。
 */

import { describe, expect, it, vi } from 'vitest';
import type { App, Component } from 'obsidian';
import { noteRefCard } from '../../cards/noteRef';
import type {
  BacklinkBridge,
  BacklinkHit,
  CardRenderContext,
  VaultBridge,
} from '../../cards/registry';
import { createCard } from '../../model/factories';
import type { CardOfType } from '../../model/schema';
import { t } from '../../util/i18n';
import { createFakeDocument, createFakeElement, type FakeElement } from '../helpers/fakeDom';

const PATH = '资料/项目笔记.md';
const DISK = '原文';

/** 让链式 `then` 跑完（`read()` 是异步的，角标要等正文画完才挂上去） */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function hit(overrides: Partial<BacklinkHit> = {}): BacklinkHit {
  return {
    boardPath: '工作/周会.nboard',
    boardTitle: '周会',
    cardId: 'card-1',
    cardTitle: '下周计划',
    excerpt: '看 [[项目笔记]] 的结论',
    ...overrides,
  };
}

/**
 * 假的索引端口。
 *
 * ★ 关键是 `watch` 的**真实退订语义**（返回一个真的会摘掉监听器的函数），
 *   并且把"退订被调了几次"记在 `unwatch` 上 —— 卡片回收不退订正是最容易被漏掉的 bug。
 */
function fakeBacklinks(byPath: Record<string, BacklinkHit[]> = {}): {
  bridge: BacklinkBridge;
  open: ReturnType<typeof vi.fn>;
  unwatch: ReturnType<typeof vi.fn>;
  listenerCount: () => number;
  setHits: (path: string, hits: BacklinkHit[]) => void;
  setReady: (value: boolean) => void;
  emitChanged: () => void;
} {
  const store = new Map<string, BacklinkHit[]>(Object.entries(byPath));
  const listeners = new Set<() => void>();
  let ready = true;
  const open = vi.fn();
  const unwatch = vi.fn();
  const bridge: BacklinkBridge = {
    get ready() {
      return ready;
    },
    count: (notePath) => store.get(notePath)?.length ?? 0,
    list: (notePath) => store.get(notePath) ?? [],
    open,
    watch: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        unwatch();
      };
    },
  };
  return {
    bridge,
    open,
    unwatch,
    listenerCount: () => listeners.size,
    setHits: (path, hits) => store.set(path, hits),
    setReady: (value) => {
      ready = value;
    },
    emitChanged: () => {
      for (const listener of [...listeners]) listener();
    },
  };
}

interface Setup {
  el: FakeElement;
  ctx: CardRenderContext;
  card: CardOfType<'noteRef'>;
  contentReady: ReturnType<typeof vi.fn>;
  backlinks: ReturnType<typeof fakeBacklinks>;
}

/** 以"正常显示态"渲染一张指向 `PATH` 的引用卡（反链角标只在显示态出现） */
function setup(options: { hits?: BacklinkHit[] } = {}): Setup {
  const backlinks = fakeBacklinks({ [PATH]: options.hits ?? [] });
  const notes = {
    exists: () => true,
    read: async () => DISK,
    watch: () => () => {},
    writeIfUnchanged: async () => 'written',
  } as unknown as VaultBridge;
  const contentReady = vi.fn();
  const ctx: CardRenderContext = {
    app: {} as unknown as App,
    sourcePath: '',
    component: {} as unknown as Component,
    renderMarkdown: async () => {},
    zoom: 1,
    mode: 'display',
    updateContent: () => {},
    updateCard: () => {},
    setMode: () => {},
    contentReady,
    notes,
    backlinks: backlinks.bridge,
  };
  return {
    el: createFakeElement(createFakeDocument()),
    ctx,
    card: createCard('noteRef', {
      content: { path: PATH, subpath: null, mode: 'summary', excerptLines: 6 },
    }),
    contentReady,
    backlinks,
  };
}

function render(setup_: Setup): void {
  noteRefCard.render(setup_.el as unknown as HTMLElement, setup_.card, setup_.ctx);
}

/** 反链角标；没有反链时 `renderInto` 画的那个摘要盒才是最后一个孩子 */
function footerOf(el: FakeElement): FakeElement | null {
  const box = el.children[0] as FakeElement;
  const last = box.children[box.children.length - 1] as FakeElement;
  return last?.className === 'nestboard-note-ref-links' ? last : null;
}

function toggleOf(el: FakeElement): FakeElement {
  return footerOf(el)?.children[0] as FakeElement;
}

function listOf(el: FakeElement): FakeElement | null {
  return (footerOf(el)?.children[1] as FakeElement | undefined) ?? null;
}

/** 点一下元素（补上真实事件对象里卡片用到的 `stopPropagation`） */
function click(el: FakeElement): void {
  el.emit('click', { stopPropagation: () => {} });
}

describe('引用卡反链角标：什么时候画（T5.04）', () => {
  it('没有反链：一个节点都不画', async () => {
    const s = setup({ hits: [] });
    render(s);
    await flush();

    expect(footerOf(s.el)).toBeNull();
  });

  it('有 3 条反链：画一条「反链：3」，且默认收起', async () => {
    const s = setup({ hits: [hit({ cardId: 'a' }), hit({ cardId: 'b' }), hit({ cardId: 'c' })] });
    render(s);
    await flush();

    const toggle = toggleOf(s.el);
    expect(toggle.textContent).toBe(`▸ ${t('card.noteRef.backlinks', { count: 3 })}`);
    // 无障碍（02 §7）：光靠一个三角方向，读屏读不出它是收着的
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(listOf(s.el)).toBeNull();
  });

  it('扫描还没走完时"0 条"不代表没有：仍然不画（0 条本身就是不画的条件）', async () => {
    const s = setup({ hits: [] });
    s.backlinks.setReady(false);
    render(s);
    await flush();

    expect(footerOf(s.el)).toBeNull();
  });

  it('没有反链桥（单测 / 嵌入视图）：正文照画，只是不画角标', async () => {
    const s = setup({ hits: [hit()] });
    delete (s.ctx as { backlinks?: BacklinkBridge }).backlinks;
    render(s);
    await flush();

    expect(footerOf(s.el)).toBeNull();
    // 正文一个字节都没受影响
    const box = s.el.children[0] as FakeElement;
    expect((box.children[0] as FakeElement).textContent).toBe('项目笔记');
  });
});

describe('引用卡反链角标：展开与跳转（T5.04）', () => {
  it('点一下展开：列出每条的板名 / 卡名 / 原话', async () => {
    const s = setup({
      hits: [
        hit({ cardId: 'a', boardTitle: '周会', cardTitle: '下周计划', excerpt: '先看结论' }),
        hit({ cardId: 'b', boardTitle: '复盘', cardTitle: '', excerpt: '同一个结论' }),
      ],
    });
    render(s);
    await flush();
    click(toggleOf(s.el));

    const list = listOf(s.el);
    expect(list).not.toBeNull();
    const items = list?.children as FakeElement[];
    expect(items).toHaveLength(2);
    expect((items[0].children[0] as FakeElement).textContent).toBe('周会');
    expect((items[0].children[1] as FakeElement).textContent).toBe('下周计划');
    expect((items[0].children[2] as FakeElement).textContent).toBe('先看结论');
    // ★ 没有标题的内联卡不该留一个空行占位 —— 直接只有"板名 + 原话"
    expect(items[1].children).toHaveLength(2);
    expect((items[1].children[1] as FakeElement).textContent).toBe('同一个结论');
    expect(toggleOf(s.el).getAttribute('aria-expanded')).toBe('true');
  });

  it('再点一下收起', async () => {
    const s = setup({ hits: [hit()] });
    render(s);
    await flush();
    click(toggleOf(s.el));
    click(toggleOf(s.el));

    expect(listOf(s.el)).toBeNull();
    expect(toggleOf(s.el).getAttribute('aria-expanded')).toBe('false');
  });

  it('展开 / 收起要重量一次高度（否则列表会溢出卡片边框）', async () => {
    const s = setup({ hits: [hit()] });
    render(s);
    await flush();
    const before = s.contentReady.mock.calls.length;
    click(toggleOf(s.el));

    expect(s.contentReady.mock.calls.length).toBe(before + 1);
  });

  it('板还没起名（标题为空）：回落到路径，至少认得出是哪块板', async () => {
    const s = setup({ hits: [hit({ boardTitle: '', boardPath: '未命名/板 A.nboard' })] });
    render(s);
    await flush();
    click(toggleOf(s.el));

    const item = listOf(s.el)?.children[0] as FakeElement;
    expect((item.children[0] as FakeElement).textContent).toBe('未命名/板 A.nboard');
    // 悬停能看到完整路径 —— 画面上那行是被省略号裁掉的
    expect(item.title).toBe('未命名/板 A.nboard');
  });

  it('点一条反链：把"哪块板的哪张卡"原样交给桥去跳', async () => {
    const s = setup({ hits: [hit({ boardPath: '工作/周会.nboard', cardId: 'card-42' })] });
    render(s);
    await flush();
    click(toggleOf(s.el));
    click((listOf(s.el)?.children[0] as FakeElement) ?? toggleOf(s.el));

    expect(s.backlinks.open).toHaveBeenCalledWith('工作/周会.nboard', 'card-42');
  });

  it('角标与列表项都拦住 pointerdown：否则点一下会先被卡片层当成拖动', async () => {
    const s = setup({ hits: [hit()] });
    render(s);
    await flush();
    click(toggleOf(s.el));

    for (const target of [toggleOf(s.el), listOf(s.el)?.children[0] as FakeElement]) {
      const event = {
        propagationStopped: false,
        stopPropagation() {
          this.propagationStopped = true;
        },
      };
      target.emit('pointerdown', event);
      expect(event.propagationStopped).toBe(true);
    }
  });
});

describe('引用卡反链角标：跟着索引变（T5.04）', () => {
  it('索引扫到新反链：条数变了就重画', async () => {
    const s = setup({ hits: [hit({ cardId: 'a' })] });
    render(s);
    await flush();
    expect(toggleOf(s.el).textContent).toBe(`▸ ${t('card.noteRef.backlinks', { count: 1 })}`);

    s.backlinks.setHits(PATH, [hit({ cardId: 'a' }), hit({ cardId: 'b' })]);
    s.backlinks.emitChanged();

    expect(toggleOf(s.el).textContent).toBe(`▸ ${t('card.noteRef.backlinks', { count: 2 })}`);
  });

  it('条数没变就不重画：扫描会广播几十次，不能每次都重建一遍 DOM', async () => {
    const s = setup({ hits: [hit({ cardId: 'a' })] });
    render(s);
    await flush();
    const before = footerOf(s.el);

    s.backlinks.emitChanged();

    // 同一个节点对象 = 完全没动过（重画会换一个新节点）
    expect(footerOf(s.el)).toBe(before);
  });

  it('反链被删光（条数归零）：角标整个消失', async () => {
    const s = setup({ hits: [hit()] });
    render(s);
    await flush();

    s.backlinks.setHits(PATH, []);
    s.backlinks.emitChanged();

    expect(footerOf(s.el)).toBeNull();
  });

  it('扫描从"未就绪的 0 条"变成"就绪后的 1 条"：签名带上 ready，必须允许重画', async () => {
    const s = setup({ hits: [] });
    s.backlinks.setReady(false);
    render(s);
    await flush();
    expect(footerOf(s.el)).toBeNull();

    s.backlinks.setHits(PATH, [hit()]);
    s.backlinks.setReady(true);
    s.backlinks.emitChanged();

    expect(toggleOf(s.el).textContent).toBe(`▸ ${t('card.noteRef.backlinks', { count: 1 })}`);
  });

  it('重画之后展开态还在：用户点了展开，不该被"又扫到一条"合上', async () => {
    const s = setup({ hits: [hit({ cardId: 'a' })] });
    render(s);
    await flush();
    click(toggleOf(s.el));

    s.backlinks.setHits(PATH, [hit({ cardId: 'a' }), hit({ cardId: 'b' })]);
    s.backlinks.emitChanged();

    expect(toggleOf(s.el).getAttribute('aria-expanded')).toBe('true');
    expect(listOf(s.el)?.children).toHaveLength(2);
  });
});

describe('引用卡反链角标：订阅生命周期（T5.04）', () => {
  it('渲染会订阅一次索引变化', async () => {
    const s = setup({ hits: [hit()] });
    render(s);
    await flush();

    expect(s.backlinks.listenerCount()).toBe(1);
  });

  it('同一个槽位重画：先退订旧的再订新的，不会一层层攒监听器', async () => {
    const s = setup({ hits: [hit()] });
    render(s);
    await flush();
    render(s);
    await flush();

    expect(s.backlinks.listenerCount()).toBe(1);
    expect(s.backlinks.unwatch).toHaveBeenCalledTimes(1);
  });

  it('回收（destroy）：退订，之后索引再怎么广播也不会碰这个槽位', async () => {
    const s = setup({ hits: [hit()] });
    render(s);
    await flush();

    noteRefCard.destroy?.(s.el as unknown as HTMLElement);

    expect(s.backlinks.listenerCount()).toBe(0);
    expect(s.backlinks.unwatch).toHaveBeenCalledTimes(1);
  });
});
