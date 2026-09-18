/**
 * 大文件分级退化策略（T2.16 / `02 §8.3`）单测。
 *
 * 档位判定的边界值最值得逐条钉：把 1999 判成 2000 会让一大批正常白板
 * 一打开就被折起全部分栏；把 5000 判成 degraded 则会让超大板错过拆板引导。
 * 两种错都不会报错，只会让用户觉得"这插件有点怪" —— 所以要靠测试守。
 */

import { describe, expect, it } from 'vitest';
import {
  INLINE_BYTES_WARN,
  SCALE_LIMITS,
  scaleAdviceOf,
  scaleHintKey,
  scaleTierOf,
} from '../../view/scale';

describe('分级档位（T2.16 / 02 §8.3）', () => {
  it.each([
    [0, 'full'],
    [1, 'full'],
    [499, 'full'],
    [500, 'culled'],
    [1999, 'culled'],
    [2000, 'degraded'],
    [4999, 'degraded'],
    [5000, 'split'],
    [20000, 'split'],
  ] as const)('%i 卡 → %s', (cards, tier) => {
    expect(scaleTierOf(cards)).toBe(tier);
  });

  it('坏数字（NaN / 负数 / 无穷）一律按 0 兜底，不倒向最激进的一档', () => {
    // ★ NaN 会让所有 `<` 比较为 false：不显式归零就会一路落到 'split'，
    //   于是"一个坏数字"换来"全部分栏被折起"
    for (const bad of [-10, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(scaleTierOf(bad)).toBe('full');
    }
  });

  it('阈值就是 §8.3 写死的那三个数（改这里等于改产品策略）', () => {
    expect(SCALE_LIMITS).toEqual({ cull: 500, degrade: 2000, split: 5000 });
    expect(INLINE_BYTES_WARN).toBe(5 * 1024 * 1024);
  });
});

describe('退化建议', () => {
  it('500 卡起启用裁剪，但还没到提示的门槛', () => {
    const advice = scaleAdviceOf({ cards: 500 });
    expect(advice.tier).toBe('culled');
    expect(advice.showHint).toBe(false);
    expect(advice.collapseColumns).toBe(false);
  });

  it('2000 卡起：提示 + 默认折叠 + 建议拆板', () => {
    const advice = scaleAdviceOf({ cards: 2000 });
    expect(advice.tier).toBe('degraded');
    expect(advice.showHint).toBe(true);
    expect(advice.collapseColumns).toBe(true);
    expect(advice.suggestSplit).toBe(true);
    expect(advice.oversizedInline).toBe(false);
  });

  it('5000 卡进拆板档，退化动作一样不放松', () => {
    const advice = scaleAdviceOf({ cards: 5000, fileBytes: 1024 });
    expect(advice.tier).toBe('split');
    expect(advice.collapseColumns).toBe(true);
    expect(advice.suggestSplit).toBe(true);
  });

  it('文件超 5MB：与卡片数无关地提示（300 张卡塞满长文本一样拖慢读写）', () => {
    const advice = scaleAdviceOf({ cards: 300, fileBytes: INLINE_BYTES_WARN + 1 });
    expect(advice.tier).toBe('full');
    expect(advice.oversizedInline).toBe(true);
    expect(advice.showHint).toBe(true);
  });

  it('恰好 5MB 不算超限（"超过"不含等于）', () => {
    expect(scaleAdviceOf({ cards: 300, fileBytes: INLINE_BYTES_WARN }).oversizedInline).toBe(false);
  });

  it('拿不到文件大小时不编造：不据此报警', () => {
    const advice = scaleAdviceOf({ cards: 300, fileBytes: null });
    expect(advice.oversizedInline).toBe(false);
    expect(advice.showHint).toBe(false);
  });

  it('小数卡片数向下取整：1999.9 不该提前退化', () => {
    expect(scaleAdviceOf({ cards: 1999.9 }).tier).toBe('culled');
    expect(scaleAdviceOf({ cards: 1999.9 }).collapseColumns).toBe(false);
  });
});

describe('提示文案优先级', () => {
  it('拆板 > 退化 > 文件过大：一次只说一件最该做的事', () => {
    const huge = INLINE_BYTES_WARN + 1;
    expect(scaleHintKey(scaleAdviceOf({ cards: 6000, fileBytes: huge }))).toBe('scale.hint.split');
    expect(scaleHintKey(scaleAdviceOf({ cards: 3000, fileBytes: huge }))).toBe(
      'scale.hint.degraded',
    );
    expect(scaleHintKey(scaleAdviceOf({ cards: 300, fileBytes: huge }))).toBe(
      'scale.hint.oversized',
    );
  });

  it('无需提示时返回 null（小板的上方应当是干净的）', () => {
    expect(scaleHintKey(scaleAdviceOf({ cards: 300 }))).toBeNull();
    expect(scaleHintKey(scaleAdviceOf({ cards: 499, fileBytes: 1024 }))).toBeNull();
  });
});
