/**
 * 脑图卡（`F3a`）的**契约**测试。
 *
 * 卡内那套渲染（`EmbedMind`）本身在真环境里验（它要量 DOM），这里只钉住
 * "别人依赖的那几个接口"与"哪些通用菜单项对这张卡不成立"：
 * 落卡映射 / 默认内容 / 不显示标题栏 / 不给「编辑内容」与「收起」/ 双击打开。
 */

import { describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import { MIND_REF_DEFAULT_SIZE, mindRefCard } from '../../cards/mindRef';
import type { CardActionContext } from '../../cards/registry';
import { createCard, DEFAULT_CARD_SIZES } from '../../model/factories';
import { cardsForDropPaths, dropKindForPath, mindsForDropPaths } from '../../model/drop';
import { t } from '../../util/i18n';
import { createFakeDocument, createFakeElement, type FakeElement } from '../helpers/fakeDom';

describe('脑图卡 · 落卡与默认值', () => {
  it('★ `.nestmind` 拖进白板 = **白板级脑图**（`2.2.0`：它不再是一种卡）', () => {
    expect(dropKindForPath('板上/我的脑图.nestmind')).toBe('mind');
    // 大小写不敏感（库内路径就是这样存的）
    expect(dropKindForPath('A.NESTMIND')).toBe('mind');
  });

  it('★ 落成的是 `Mind`（只有一个锚点），且**不混进卡片**那一条路', () => {
    const origins = [
      { x: 100, y: 200 },
      { x: 300, y: 400 },
    ];
    const minds = mindsForDropPaths(['a.nestmind', 'b.md'], origins);

    expect(minds).toHaveLength(1);
    // `x/y` = **根节点中心**（脑图没有宽高，也就没有"左上角"这回事）
    expect(minds[0]).toMatchObject({ x: 100, y: 200, path: 'a.nestmind' });
    // 卡片那一条路跳过 `.nestmind`（否则会为它造一张"没有模型的空卡"）
    expect(cardsForDropPaths(['a.nestmind', 'b.md'], origins).map((card) => card.type)).toEqual([
      'noteRef',
    ]);
  });

  it('默认尺寸与 `DEFAULT_CARD_SIZES` 一致（新建 / 导入两条路不能各有各的尺寸）', () => {
    expect(mindRefCard.defaultSize).toEqual(MIND_REF_DEFAULT_SIZE);
    expect(DEFAULT_CARD_SIZES.mindRef).toEqual(MIND_REF_DEFAULT_SIZE);
  });

  it('默认内容是空路径（卡面画"把 .nestmind 拖进来"那句引导）', () => {
    expect(mindRefCard.createDefaultContent()).toEqual({ path: '', showSize: false });
  });

  it('导出成 Markdown 给一个链接（这不是可嵌入的 `![[…]]`）', () => {
    const card = createCard('mindRef', { content: { path: '板上/甲.nestmind' } });
    expect(mindRefCard.toMarkdown(card, { sourcePath: '' })).toBe('[[板上/甲.nestmind]]');
    expect(mindRefCard.toMarkdown(createCard('mindRef'), { sourcePath: '' })).toBe('');
  });
});

describe('脑图卡 · 通用菜单项', () => {
  it('★ 关掉「编辑内容」「显示标题」「收起」三项 —— 这张卡上没有这件事', () => {
    expect(mindRefCard.menuItems).toEqual({
      editContent: false,
      showTitle: false,
      collapse: false,
    });
  });

  it('★ **无框**（`chrome: bare`）—— 与内嵌脑图卡同一条（"脑图是一个组件，不要框"）', () => {
    expect(mindRefCard.chrome).toBe('bare');
  });

  it('自己的那一项是「打开脑图」（动作名写错会**静默失效**）', () => {
    const card = createCard('mindRef', { content: { path: '甲.nestmind' } });
    expect(mindRefCard.contextMenu?.(card, { multiple: false })).toEqual([
      {
        id: 'open-mind',
        title: t('menu.card.openMind'),
        icon: 'external-link',
        disabled: false,
        action: 'openSource',
      },
    ]);
  });

  it('没指文件 / 多选时置灰（而不是整项消失）', () => {
    const empty = createCard('mindRef');
    const card = createCard('mindRef', { content: { path: '甲.nestmind' } });
    expect(mindRefCard.contextMenu?.(empty, { multiple: false })[0].disabled).toBe(true);
    expect(mindRefCard.contextMenu?.(card, { multiple: true })[0].disabled).toBe(true);
  });
});

describe('脑图卡 · 双击打开', () => {
  it('文件在 → 打开脑图标签页并收下这一下', () => {
    const openTab = vi.fn();
    const card = createCard('mindRef', { content: { path: '甲.nestmind' } });
    const ctx = {
      app: {} as unknown as App,
      sourcePath: '',
      applyContent: () => undefined,
      minds: { exists: () => true, openTab },
    } as unknown as CardActionContext;

    expect(mindRefCard.onDoubleClick?.(card, ctx)).toBe(true);
    expect(openTab).toHaveBeenCalledWith('甲.nestmind');
  });

  it('★ 文件不在 → 返回 `false`（把"源文件没了"的提示留给视图说），且什么都不开', () => {
    const openTab = vi.fn();
    const card = createCard('mindRef', { content: { path: '甲.nestmind' } });
    const ctx = {
      app: {} as unknown as App,
      sourcePath: '',
      applyContent: () => undefined,
      minds: { exists: () => false, openTab },
    } as unknown as CardActionContext;

    expect(mindRefCard.onDoubleClick?.(card, ctx)).toBe(false);
    expect(openTab).not.toHaveBeenCalled();
  });

  it('没桥（单测 / 嵌入视图）时也不接管', () => {
    const card = createCard('mindRef', { content: { path: '甲.nestmind' } });
    const ctx = {
      app: {} as unknown as App,
      sourcePath: '',
      applyContent: () => undefined,
    } as unknown as CardActionContext;
    expect(mindRefCard.onDoubleClick?.(card, ctx)).toBe(false);
  });
});

describe('脑图卡 · 空路径的卡面', () => {
  it('画一句引导语，而不是一片空白', () => {
    const el = createFakeElement(createFakeDocument());
    mindRefCard.render(el as unknown as HTMLElement, createCard('mindRef'), {
      app: {} as unknown as App,
      sourcePath: '',
      component: {},
      renderMarkdown: async () => undefined,
      zoom: 1,
      mode: 'display',
      updateContent: () => undefined,
      updateCard: () => undefined,
      setMode: () => undefined,
    } as never);

    expect(el.classList.contains('nestboard-mind-ref')).toBe(true);
    expect(el.classList.contains('nestboard-mind-ref-empty')).toBe(true);
    // ★ 读**孩子**那个节点：假 DOM 的 `textContent` 不聚合孩子（见 `helpers/fakeDom.ts`）
    expect((el.children[0] as FakeElement).textContent).toBe(t('card.mindRef.empty'));
  });

  it('文件不在（有路径但库里没有）时给另一句话，且不再往下走', () => {
    const el = createFakeElement(createFakeDocument());
    const open = vi.fn();
    mindRefCard.render(
      el as unknown as HTMLElement,
      createCard('mindRef', { content: { path: '没了.nestmind' } }),
      {
        app: {} as unknown as App,
        sourcePath: '',
        component: {},
        renderMarkdown: async () => undefined,
        zoom: 1,
        mode: 'display',
        updateContent: () => undefined,
        updateCard: () => undefined,
        setMode: () => undefined,
        minds: { exists: () => false, open },
      } as never,
    );

    expect((el.children[0] as FakeElement).textContent).toBe(t('card.mindRef.missing'));
    expect(open).not.toHaveBeenCalled();
  });
});
