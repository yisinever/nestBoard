/**
 * 可访问名与提示文案（T3.26 / `02 §7`）。
 *
 * 读屏用户理解这块白板的**唯一入口**就是这些字符串：他看不见卡片、看不见蓝框，
 * 只能靠"便签：会议纪要（已选中）"这一句话知道光标在哪、选没选中。
 * 也就是说，这些字符串的质量直接等于"这个功能对读屏用户到底能不能用"。
 * 而它们是纯函数产物，正好可以一条条钉住。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Card } from '../../model/schema';
import { boardAriaLabel, canvasA11yHint, cardA11yHint, cardAriaLabel } from '../../view/a11y';
import { setLocale } from '../../util/i18n';

/** 一张最小可用的便签卡。只填会被读屏念出来的那几个字段 */
function noteCard(patch: Partial<Card> = {}): Card {
  return {
    id: 'card-1',
    type: 'note',
    x: 0,
    y: 0,
    width: 240,
    height: 160,
    z: 1,
    columnId: null,
    order: 0,
    color: '#ffffff',
    accent: null,
    locked: false,
    showTitle: true,
    title: '会议纪要',
    content: { md: '', editorMode: 'markdown' },
    ...patch,
  } as Card;
}

describe('cardAriaLabel', () => {
  // ★ 语言是模块级全局状态，而它直接影响断言。用例自己指定语言、
  //   跑完再还原，免得"某个文件先跑"决定了这里的成败。
  beforeEach(() => {
    setLocale('zh-cn');
  });
  afterEach(() => {
    setLocale('en');
  });

  it('类型 + 标题', () => {
    expect(cardAriaLabel(noteCard())).toBe('便签：会议纪要');
  });

  it('空标题回落到"未命名{类型}"，绝不返回空串', () => {
    // ★ 空名字的后果不是"念得少一点"，而是读屏只念一句"分组" ——
    //   用户完全不知道光标停在哪张卡上，等于 Tab 走了一遍却什么也没获得
    expect(cardAriaLabel(noteCard({ title: '' }))).toBe('未命名便签');
    expect(cardAriaLabel(noteCard({ title: '   ' }))).toBe('未命名便签');
  });

  it('状态以固定顺序追加：先锁定、后选中', () => {
    expect(cardAriaLabel(noteCard({ locked: true }))).toBe('便签：会议纪要（已锁定）');
    expect(cardAriaLabel(noteCard(), { selected: true })).toBe('便签：会议纪要（已选中）');
    expect(cardAriaLabel(noteCard({ locked: true }), { selected: true })).toBe(
      '便签：会议纪要（已锁定、已选中）',
    );
  });

  it('未选中的卡不会多念一句"未选中"', () => {
    // ★ 只在**真**的时候加后缀：给每张卡都念"未选中"会让最常听到的那句话
    //   多出一半长度，而它提供的信息量为零
    expect(cardAriaLabel(noteCard(), { selected: false })).toBe('便签：会议纪要');
  });

  it('标题首尾的空白不参与名字', () => {
    expect(cardAriaLabel(noteCard({ title: '  周会  ' }))).toBe('便签：周会');
  });

  it('跟着界面语言走（T3.23）', () => {
    setLocale('en');
    expect(cardAriaLabel(noteCard({ locked: true }), { selected: true })).toBe(
      'Note: 会议纪要 (Locked, Selected)',
    );
  });
});

describe('boardAriaLabel', () => {
  beforeEach(() => {
    setLocale('zh-cn');
  });
  afterEach(() => {
    setLocale('en');
  });

  it('念出卡片总数', () => {
    expect(boardAriaLabel(12)).toBe('白板，共 12 张卡片');
  });

  it('空板也念得出话（0 张是一个合法状态，不是"没东西可念"）', () => {
    expect(boardAriaLabel(0)).toBe('白板，共 0 张卡片');
  });
});

describe('操作提示', () => {
  beforeEach(() => {
    setLocale('zh-cn');
  });
  afterEach(() => {
    setLocale('en');
  });

  it('画布与卡片各有一条提示，且互不相同', () => {
    // ★ 两条提示的分工：画布那条讲"整块板怎么走"，卡片那条讲"这张卡能干嘛"。
    //   写成同一句会让读屏用户每次聚焦都听两遍同样的话。
    expect(canvasA11yHint()).toBe('按 Tab 聚焦卡片，方向键移动选区。');
    expect(cardA11yHint()).toBe('按 Enter 编辑，按 Tab 跳到下一张卡。');
    expect(canvasA11yHint()).not.toBe(cardA11yHint());
  });
});
