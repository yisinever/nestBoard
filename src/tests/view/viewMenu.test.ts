/**
 * 视图右上角「⋯ 更多」菜单的排布测试（O11）。
 *
 * 钉三件事，都是"点开一次才发现"的那类错误：
 *
 *  * **有哪些项、怎么分组**：导出四件套与"我在哪儿"混成一坨，菜单就从"入口"
 *    退化成"一列文字"；
 *  * **置灰的时机**：空板没得"适应内容"、板子还没认领路径时没有"这块板的链接"；
 *  * **每一项都真的连着那条通路**：`run` 要转发到**同名的**那个动作。
 *    "复制链接"点出"导出 PDF"是最难发现的一类 bug —— 两个都像正常行为，
 *    只是结果不是你要的。
 *
 * ★ 动作表的完整性（`Record<ViewMenuAction, …>`）不在这里测：`BoardView` 那边
 *   少写一项就编译不过，比断言更牢 —— 与 `fileMenu.test.ts` 同一取舍。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { setLocale, t } from '../../util/i18n';
import { viewMenuItems } from '../../view/interact/viewMenu';
import type { ViewMenuAction, ViewMenuActions, ViewMenuState } from '../../view/interact/viewMenu';

/**
 * 一份全 `noop` 的动作表，可选把调用记进 `record`。
 *
 * ★ 写成显式字面量而不是 `Object.fromEntries` 之类：漏掉一个动作时
 *   `Record<ViewMenuAction, () => void>` 会在**编译期**报错 —— 这个形状正是
 *   规格层要的效果，测试里照用一遍才守得住。
 */
function makeActions(record?: ViewMenuAction[]): ViewMenuActions {
  const tap = (action: ViewMenuAction) => () => {
    record?.push(action);
  };
  return {
    exportPng: tap('exportPng'),
    exportSvg: tap('exportSvg'),
    exportPdf: tap('exportPdf'),
    exportMarkdown: tap('exportMarkdown'),
    copyBoardLink: tap('copyBoardLink'),
    openHome: tap('openHome'),
    fitContent: tap('fitContent'),
  };
}

/** 一块"什么都正常"的板子：有内容、有路径 */
const READY: ViewMenuState = { hasContent: true, canCopyLink: true };

function items(state: Partial<ViewMenuState> = {}, record?: ViewMenuAction[]) {
  return viewMenuItems(makeActions(record), { ...READY, ...state });
}

/** 压成一行看排布：`|` 表示这一项之前有分隔线 */
function layout(state: Partial<ViewMenuState> = {}): string {
  return items(state)
    .map((item) => `${item.separatorBefore ? '| ' : ''}${item.id}`)
    .join(' ');
}

/** 当下被置灰的是哪几项 */
function disabledIds(state: Partial<ViewMenuState> = {}): string[] {
  return items(state)
    .filter((item) => item.disabled === true)
    .map((item) => item.id);
}

describe('viewMenuItems × 分组', () => {
  it('顺序：导出四件套 → 复制链接 → Home / 适应内容，三组各带一条分隔线', () => {
    expect(layout()).toBe(
      'exportPng exportSvg exportPdf exportMarkdown | copyBoardLink | openHome fitContent',
    );
  });

  it('顶头不带分隔线（菜单顶上多一条线是最容易被忽略的排印事故）', () => {
    expect(items()[0]?.separatorBefore).toBe(false);
  });

  it('分隔线只出现在每组第一项之前：一组之内再画线就把一件事拆成了两件', () => {
    const list = items();
    expect(list.map((item) => item.separatorBefore === true)).toEqual([
      false,
      false,
      false,
      false,
      true,
      true,
      false,
    ]);
  });
});

describe('viewMenuItems × 置灰', () => {
  it('一切正常时没有一项是灰的（全灰的菜单比空菜单更让人怀疑插件坏了）', () => {
    expect(disabledIds()).toEqual([]);
  });

  it('板子还没认领路径：只有「复制白板链接」置灰', () => {
    expect(disabledIds({ canCopyLink: false })).toEqual(['copyBoardLink']);
  });

  it('空板：只有「适应内容」置灰', () => {
    // ★ 空板没有可适应的东西（`boundsOf([])` 给 `null`），点下去与"回到 100%"
    //   是同一件事 —— 与其让它静默地什么都不做，不如明说"现在没这回事"
    expect(disabledIds({ hasContent: false })).toEqual(['fitContent']);
  });

  it('两件事可以同时不成立，互不牵连', () => {
    expect(disabledIds({ hasContent: false, canCopyLink: false })).toEqual([
      'copyBoardLink',
      'fitContent',
    ]);
  });

  it('「打开 Home 白板」永不置灰：没设 Home 时正是发现那个设置的地方', () => {
    expect(disabledIds({ hasContent: false, canCopyLink: false })).not.toContain('openHome');
  });

  it('状态按每次调用的入参算（构造时缓存会让"刚加载完"那一下一直灰着）', () => {
    expect(disabledIds({ canCopyLink: false })).toEqual(['copyBoardLink']);
    expect(disabledIds({ canCopyLink: true })).toEqual([]);
  });
});

describe('viewMenuItems × 每一项', () => {
  it('都有标题与图标、id 互不重复（空标题会渲成一条看不见的项）', () => {
    const list = items();
    for (const item of list) {
      expect(item.title.length, item.id).toBeGreaterThan(0);
      expect(item.icon?.length ?? 0, item.id).toBeGreaterThan(0);
    }
    expect(new Set(list.map((item) => item.id)).size).toBe(list.length);
  });

  it('都点得动（`run` 缺席的项在 Obsidian 的 Menu 里会渲成不可点的一条）', () => {
    for (const item of items()) {
      expect(typeof item.run, item.id).toBe('function');
    }
  });
});

describe('viewMenuItems × 动作绑定', () => {
  it('每一项的 run 只触发它自己那一项', () => {
    const calls: ViewMenuAction[] = [];
    const list = items({}, calls);
    for (const item of list) {
      calls.length = 0;
      item.run?.();
      // 7 项各点一遍：并发（一次点出两个动作）与串台都在这里现形
      expect(calls, item.id).toEqual([item.id]);
    }
  });
});

describe('viewMenuItems × 措辞', () => {
  // ★ 语言是模块级全局状态，而它直接影响断言：用例自己指定语言、跑完再还原，
  //   免得"某个文件先跑"决定了这里的成败（与 a11y.test.ts 同一理由）
  beforeEach(() => {
    setLocale('zh-cn');
  });
  afterEach(() => {
    setLocale('en');
  });

  it('标题直接复用命令面板的键：从菜单点与从命令面板敲，读到的词一模一样', () => {
    const titles = new Map(items().map((item) => [item.id, item.title]));
    expect(titles.get('exportPng')).toBe(t('command.exportPng.name'));
    expect(titles.get('exportMarkdown')).toBe(t('command.exportMarkdown.name'));
    expect(titles.get('copyBoardLink')).toBe(t('command.copyBoardLink.name'));
    expect(titles.get('openHome')).toBe(t('command.openHome.name'));
    // 「适应内容」在本菜单里与命令面板的 `zoomFit` 是同一条通路，所以同一个键
    expect(titles.get('fitContent')).toBe(t('command.zoomFit.name'));
  });

  it('中文下确实拿到了中文（回归 i18n 静默回落成"键名"这种故障）', () => {
    const titles = new Map(items().map((item) => [item.id, item.title]));
    expect(titles.get('copyBoardLink')).toBe('复制白板链接');
    expect(titles.get('fitContent')).toBe('适应全部内容');
  });
});
