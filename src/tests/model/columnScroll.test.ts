/**
 * 分栏内滚动（T2.03 / `F2-7-10`）的纯几何回归。
 *
 * 这套算术错一格的表现都"像 bug 但不报错"：
 *  * `viewport` 下沿忘了减 `padding` → 最后一张卡永远差一点看不全；
 *  * `scrollLimit` 多减一个 `gap`    → 栏底留一段永远滚不出来的空白；
 *  * `scrolledRect` 的符号写反       → 滚轮一动，卡片朝反方向跑。
 * 所以这里逐条盯住 `columnScroll.ts` 文件头那三条不变量，并把
 * **`extent − viewport.height === limit`** 这个"渲染层与模型层必须对齐"的等式
 * 显式断言出来 —— 它一旦不成立，滚到底的那一帧就会有卡片露不全或露白。
 */

import { describe, expect, it } from 'vitest';
import {
  clampColumnScroll,
  columnContentBottom,
  columnScrollExtent,
  columnScrollLimit,
  columnScrollView,
  columnViewport,
  clipPathValue,
  scrollClip,
  scrolledRect,
} from '../../model/columnScroll';
import { COLUMN_LAYOUT, columnContentBox, layoutColumn } from '../../model/columns';
import { createBoardFile, createCard, createColumn } from '../../model/factories';
import type { Column } from '../../model/schema';

/** 固定 id 的分栏（与 `columns.test.ts` 同一套做法：id 归工厂签发，测试就地改名） */
function makeColumn(overrides: Partial<Column> & { id: string }): Column {
  const { id, ...rest } = overrides;
  return { ...createColumn(rest), id };
}

/**
 * 一栏 + `count` 张等高卡的夹具。
 *
 * ★ 先 `layoutColumn` 再测量：成员坐标是派生状态，不排一遍的话所有卡的 `y` 都是 0，
 *   而 `columnContentBottom` / `columnScrollLimit` 恰恰是绕着这些坐标算的。
 */
function fixture(options: {
  count: number;
  height?: number;
  cardHeight?: number;
  collapsed?: boolean;
}) {
  const cardHeight = options.cardHeight ?? 100;
  const column = makeColumn({
    id: 'col1',
    x: 0,
    y: 0,
    width: 320,
    height: options.height ?? 400,
    collapsed: options.collapsed ?? false,
  });
  const cards = Array.from({ length: options.count }, (_, index) => ({
    ...createCard('note', { x: 0, y: 0 }),
    id: `c${index}`,
    columnId: 'col1',
    order: index,
    height: cardHeight,
  }));
  const board = createBoardFile({ columns: [column], cards });
  layoutColumn(board, 'col1');
  return { board, column, cards };
}

describe('columnViewport', () => {
  it('上沿在标题栏下方，下沿留出底部内边距（最后的卡不贴着圆角）', () => {
    const { column } = fixture({ count: 3, height: 400 });
    const viewport = columnViewport(column);
    expect(viewport.top).toBe(COLUMN_LAYOUT.headerHeight + COLUMN_LAYOUT.headerGap);
    expect(viewport.bottom).toBe(400 - COLUMN_LAYOUT.padding);
    expect(viewport.height).toBe(viewport.bottom - viewport.top);
  });

  it('★ 折叠的栏窗口高度为 0（内容槽在 CSS 里整个收掉了）', () => {
    const { column } = fixture({ count: 3, collapsed: true });
    expect(columnViewport(column).height).toBe(0);
  });

  it('窗口只由分栏几何决定，与内容多少无关（三条不变量之一）', () => {
    const few = fixture({ count: 1, height: 500 });
    const many = fixture({ count: 9, height: 500 });
    expect(columnViewport(many.column)).toEqual(columnViewport(few.column));
  });
});

describe('columnContentBottom', () => {
  it('空栏 = 窗口上沿，也就是"没有任何可滚的东西"', () => {
    const { board, column } = fixture({ count: 0 });
    expect(columnContentBottom(board, column)).toBe(columnContentBox(column).top);
  });

  it('有成员时 = 最后一张卡的下沿', () => {
    const { board, column, cards } = fixture({ count: 3, cardHeight: 100 });
    const last = cards[2];
    expect(columnContentBottom(board, column)).toBe(last.y + last.height);
  });
});

describe('columnScrollLimit', () => {
  it('装得下 → 0（这一栏根本不滚）', () => {
    const { board, column } = fixture({ count: 3, height: 400, cardHeight: 100 });
    expect(columnScrollLimit(board, column)).toBe(0);
  });

  it('装不下 → 内容底边越过窗口下沿多少', () => {
    // 8 张 100：内容底边 = 46 + 7×(100+10) + 100 = 916，窗口下沿 = 400 − 12 = 388
    const { board, column } = fixture({ count: 8, height: 400, cardHeight: 100 });
    expect(columnScrollLimit(board, column)).toBe(916 - 388);
  });

  it('折叠 → 0', () => {
    const { board, column } = fixture({ count: 8, collapsed: true });
    expect(columnScrollLimit(board, column)).toBe(0);
  });
});

describe('clampColumnScroll', () => {
  it('负数 / NaN / Infinity 一律当 0（DOM 里读到过 NaN）', () => {
    const { board, column } = fixture({ count: 8, height: 400 });
    expect(clampColumnScroll(board, column, -10)).toBe(0);
    expect(clampColumnScroll(board, column, Number.NaN)).toBe(0);
    expect(clampColumnScroll(board, column, Number.POSITIVE_INFINITY)).toBe(0);
    expect(clampColumnScroll(board, column, Number.NEGATIVE_INFINITY)).toBe(0);
  });

  it('超上限 → 停在最远处（内容变少时不会留下滚在空白上的偏移）', () => {
    const { board, column } = fixture({ count: 8, height: 400 });
    expect(clampColumnScroll(board, column, 9999)).toBe(528);
  });

  it('区间内的值原样通过', () => {
    const { board, column } = fixture({ count: 8, height: 400 });
    expect(clampColumnScroll(board, column, 100)).toBe(100);
  });
});

describe('columnScrollExtent', () => {
  it('★ extent − viewport.height 必须恰好等于 limit（渲染层与模型层对齐的那一格）', () => {
    const { board, column } = fixture({ count: 8, height: 400 });
    const viewport = columnViewport(column);
    // 占位块比窗口高出多少，滚动条就能走多远 —— 两者不等就会"最后一张卡看不全"
    expect(columnScrollExtent(board, column) - viewport.height).toBe(
      columnScrollLimit(board, column),
    );
    expect(columnScrollExtent(board, column)).toBe(916 - 46);
  });

  it('装得下时退化成"窗口上沿到内容底边"（占位块不需要撑高）', () => {
    const { board, column } = fixture({ count: 1, height: 400, cardHeight: 100 });
    const viewport = columnViewport(column);
    expect(columnScrollExtent(board, column)).toBeLessThanOrEqual(viewport.height);
  });
});

describe('columnScrollView', () => {
  it('★ 装得下 → null：调用方走"一字不差写模型坐标"的那条老路径', () => {
    const { board, column } = fixture({ count: 2, height: 400 });
    expect(columnScrollView(board, column, 100)).toBeNull();
  });

  it('折叠 → null', () => {
    const { board, column } = fixture({ count: 8, collapsed: true });
    expect(columnScrollView(board, column, 100)).toBeNull();
  });

  it('装不下 → 带窗口与钳好的偏移', () => {
    const { board, column } = fixture({ count: 8, height: 400 });
    const view = columnScrollView(board, column, 9999);
    expect(view).not.toBeNull();
    expect(view?.offset).toBe(528);
    expect(view?.viewport).toEqual(columnViewport(column));
  });
});

describe('scrolledRect', () => {
  it('只动 y：视觉 = 模型 − offset（唯一换算入口）', () => {
    const rect = { x: 12, y: 300, width: 296, height: 100 };
    expect(scrolledRect(rect, 100)).toEqual({ x: 12, y: 200, width: 296, height: 100 });
    expect(scrolledRect(rect, 0)).toEqual(rect);
  });
});

describe('scrollClip / clipPathValue', () => {
  const viewport = { top: 100, bottom: 200, height: 100 };

  it('完全在窗口里 → none，且不写 clip-path（省一次样式写入，也不裁掉卡片阴影）', () => {
    const clip = scrollClip({ x: 0, y: 120, width: 100, height: 50 }, viewport);
    expect(clip).toEqual({ kind: 'none' });
    expect(clipPathValue(clip)).toBe('');
  });

  it('下沿被窗口切掉 → inset(0 0 Npx 0)', () => {
    const clip = scrollClip({ x: 0, y: 120, width: 100, height: 150 }, viewport);
    expect(clip).toEqual({ kind: 'inset', top: 0, bottom: 70 });
    expect(clipPathValue(clip)).toBe('inset(0px 0 70px 0)');
  });

  it('上沿被窗口切掉 → inset(Npx 0 0 0)', () => {
    const clip = scrollClip({ x: 0, y: 60, width: 100, height: 70 }, viewport);
    expect(clip).toEqual({ kind: 'inset', top: 40, bottom: 0 });
    expect(clipPathValue(clip)).toBe('inset(40px 0 0px 0)');
  });

  it('★ 整张都在窗口外 → hidden 用 inset 表达，绝不用 display:none', () => {
    // `display: none` 会让卡片层量出 clientWidth === 0，自动高度把卡片压成 0
    const clip = scrollClip({ x: 0, y: 300, width: 100, height: 100 }, viewport);
    expect(clip).toEqual({ kind: 'hidden' });
    expect(clipPathValue(clip)).toBe('inset(50% 0 50% 0)');
  });

  it('正好被切掉一张卡的高度时算看不见（不留 0.5px 的边）', () => {
    const clip = scrollClip({ x: 0, y: 0, width: 100, height: 100 }, viewport);
    expect(clip).toEqual({ kind: 'hidden' });
  });
});
