/**
 * 设置 → CSS 变量（T3.24 / `F11-03`）。
 *
 * 这里守的是"用户改一次设置，所有卡片都跟着变"这条链路的第一段：
 * 设置值 → 三个 CSS 变量。第二段（变量 → 卡片外观）在 `styles.css` 里，
 * 靠变量名一字不差地对上 —— 所以变量名必须在这里被钉住，
 * 拼错一个字母的表现是"设置里改了圆角，白板上毫无变化"，且不会报任何错。
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_SETTINGS, type NestboardSettings } from '../../settings/settings';
import {
  CARD_STYLE_VARS,
  CARD_STYLE_VAR,
  applyCardStyleVariables,
  cardStyleVariables,
  clearCardStyleVariables,
} from '../../view/themeVars';

/** 只带 `style` 的假元素：本模块只碰 `setProperty` / `removeProperty` */
function fakeElement() {
  const vars = new Map<string, string>();
  const removed: string[] = [];
  const el = {
    style: {
      setProperty: (name: string, value: string) => void vars.set(name, value),
      removeProperty: (name: string) => {
        removed.push(name);
        vars.delete(name);
      },
    },
  } as unknown as HTMLElement;
  return { el, vars, removed };
}

const settings = (patch: Partial<NestboardSettings> = {}): NestboardSettings => ({
  ...DEFAULT_SETTINGS,
  ...patch,
});

describe('cardStyleVariables', () => {
  it('圆角与字号带 px 单位（CSS 变量是裸值，单位得自己拼）', () => {
    const vars = cardStyleVariables(
      settings({ cardCornerRadius: 12, cardFontSize: 15, cardFontFamily: 'Inter' }),
    );
    expect(vars[CARD_STYLE_VAR.radius]).toBe('12px');
    expect(vars[CARD_STYLE_VAR.fontSize]).toBe('15px');
    expect(vars[CARD_STYLE_VAR.fontFamily]).toBe('Inter');
  });

  it('圆角为 0 时仍然是 `0px` 而不是被吞掉', () => {
    // ★ `0` 是合法设置（就是"直角卡片"）。若这里用 `if (!value)` 之类的判空，
    //   用户会发现"拉到最左边反而没有变化" —— 而 10px 与 0px 差别极其明显
    const vars = cardStyleVariables(settings({ cardCornerRadius: 0 }));
    expect(vars[CARD_STYLE_VAR.radius]).toBe('0px');
  });

  it('字体留空时给空串（交给 `applyCardStyleVariables` 摘掉变量）', () => {
    // ★ 不能写成 `inherit`：`.nestboard-mde-input` 的兜底是 `--font-text`，
    //   写死 `inherit` 会让编辑区永远用不上阅读字体（见模块注释）
    expect(cardStyleVariables(settings({ cardFontFamily: '' }))[CARD_STYLE_VAR.fontFamily]).toBe(
      '',
    );
  });

  it('变量名清单与映射表一一对应', () => {
    // 清理用的清单漏一个名字，表现是"切走视图后上一个用户的字体还留着"
    expect([...CARD_STYLE_VARS].sort()).toEqual(
      [CARD_STYLE_VAR.radius, CARD_STYLE_VAR.fontSize, CARD_STYLE_VAR.fontFamily].sort(),
    );
  });
});

describe('applyCardStyleVariables', () => {
  it('三个变量都写到元素上', () => {
    const { el, vars } = fakeElement();
    applyCardStyleVariables(
      el,
      settings({ cardCornerRadius: 8, cardFontSize: 14, cardFontFamily: 'Noto Sans' }),
    );

    expect(vars.get(CARD_STYLE_VAR.radius)).toBe('8px');
    expect(vars.get(CARD_STYLE_VAR.fontSize)).toBe('14px');
    expect(vars.get(CARD_STYLE_VAR.fontFamily)).toBe('Noto Sans');
  });

  it('字体留空时把变量摘掉，让 CSS 里的 `var(…, 兜底)` 生效', () => {
    const { el, vars, removed } = fakeElement();
    applyCardStyleVariables(el, settings({ cardCornerRadius: 8, cardFontFamily: '' }));

    // 圆角 / 字号照写；字体一个都不写，且必须真的 remove（不是设成空串）
    expect(vars.has(CARD_STYLE_VAR.fontFamily)).toBe(false);
    expect(removed).toEqual([CARD_STYLE_VAR.fontFamily]);
  });

  it('从"有自定义字体"切回"跟随主题"时，旧变量被摘掉而不是留着', () => {
    const { el, vars } = fakeElement();
    applyCardStyleVariables(el, settings({ cardFontFamily: 'Inter' }));
    expect(vars.get(CARD_STYLE_VAR.fontFamily)).toBe('Inter');

    applyCardStyleVariables(el, settings({ cardFontFamily: '' }));
    // 摘不干净的表现是"用户选了跟随主题，卡片却还是 Inter"
    expect(vars.has(CARD_STYLE_VAR.fontFamily)).toBe(false);
  });

  it('幂等：同一个元素重复调用只是重复赋值', () => {
    const { el, vars } = fakeElement();
    const target = settings({ cardCornerRadius: 8, cardFontSize: 14, cardFontFamily: 'A' });
    applyCardStyleVariables(el, target);
    applyCardStyleVariables(el, { ...target, cardCornerRadius: 20 });

    // 拖滑块时会连续调用很多次；不幂等的话这里会攒出一堆垃圾
    expect(vars.size).toBe(3);
    expect(vars.get(CARD_STYLE_VAR.radius)).toBe('20px');
  });
});

describe('clearCardStyleVariables', () => {
  it('把三个变量都摘掉', () => {
    const { el, vars, removed } = fakeElement();
    // ★ 给一个自定义字体：字体留空时 `applyCardStyleVariables` 会先摘一次，
    //   那样 `removed` 里会有两次同名记录，断言就看不出"清理到底覆盖了哪几个变量"
    applyCardStyleVariables(el, settings({ cardFontFamily: 'Inter' }));
    clearCardStyleVariables(el);

    expect(vars.size).toBe(0);
    expect(removed.sort()).toEqual([...CARD_STYLE_VARS].sort());
  });
});
