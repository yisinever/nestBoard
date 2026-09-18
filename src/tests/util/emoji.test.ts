/**
 * 卡面图标（emoji）工具单测（`O10`）。
 *
 * 这一份纯逻辑是**读写两个入口共用**的（`validate.ts` 读文件、右键菜单写文件），
 * 所以三条边界必须钉死：
 *   1. 脏值（非字符串 / 控制字符 / 超长）不能落进 DOM 或文件；
 *   2. 「没图标」是一个**缺席的键**，空串与纯空白都归一成它；
 *   3. 选择器里"输入的那个 emoji 排第一"—— 否则从系统面板粘进来的 emoji
 *      会因为不在精选清单里而永远选不中（回车选的是高亮项，不是输入框里的字）。
 */

import { describe, expect, it } from 'vitest';
import { EMOJI_CHOICES, ICON_MAX_LENGTH, emojiSuggestions, normalizeIcon } from '../../util/emoji';

describe('normalizeIcon', () => {
  it('普通的单个 emoji 原样返回', () => {
    expect(normalizeIcon('📌')).toBe('📌');
  });

  it('去掉首尾空白与控制字符（换行 / 制表 / NUL）', () => {
    expect(normalizeIcon('  📌\n')).toBe('📌');
    expect(normalizeIcon('\t🚀\u0000')).toBe('🚀');
  });

  it('非字符串一律当"没图标"（手改文件写个数字进来也不能炸）', () => {
    for (const junk of [null, undefined, 42, {}, []]) expect(normalizeIcon(junk)).toBe('');
  });

  it('超长截断到上限（免得一整段话把卡面标题挤没）', () => {
    const long = '📌'.repeat(ICON_MAX_LENGTH);
    expect(normalizeIcon(long).length).toBe(ICON_MAX_LENGTH);
    expect(normalizeIcon(`x${long}`).length).toBe(ICON_MAX_LENGTH);
  });

  it('组合 emoji（多码元，如一家四口）在上限内不被截断', () => {
    const family = '👨‍👩‍👧‍👦';
    expect(family.length).toBeLessThanOrEqual(ICON_MAX_LENGTH);
    expect(normalizeIcon(family)).toBe(family);
  });
});

describe('emojiSuggestions', () => {
  it('空输入 → 精选清单（而且是副本，别让调用方改到常量）', () => {
    const list = emojiSuggestions('');
    expect(list).toEqual([...EMOJI_CHOICES]);
    expect(list).not.toBe(EMOJI_CHOICES);
  });

  it('只有空白也当空输入（敲了几个空格不该把清单清空）', () => {
    expect(emojiSuggestions('   ')).toEqual([...EMOJI_CHOICES]);
  });

  it('★ 有输入 → 输入值排第一，且与清单里重复的那一项只留一个', () => {
    const list = emojiSuggestions('📌');
    expect(list[0]).toBe('📌');
    expect(list.filter((emoji) => emoji === '📌')).toHaveLength(1);
  });

  it('输入的是清单里没有的 emoji → 仍然排第一（系统面板粘进来的也选得中）', () => {
    const list = emojiSuggestions('🎉');
    expect(list[0]).toBe('🎉');
    // 清单原样跟在后面，一项不少
    expect(list.slice(1)).toEqual([...EMOJI_CHOICES]);
  });
});
