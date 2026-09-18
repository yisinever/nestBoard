/**
 * 卡面标记存在哪一处（`O38`）。
 *
 * 这一组用例是**回归判据**：白板卡的标记在 `content.icon`、便签的在卡级 `icon`，
 * 两处混用的表现是"换了图标没反应"（写进去了，渲染读的不是那一处）—— 真踩过。
 */

import { describe, expect, it } from 'vitest';
import { cardIconOf } from '../../cards/cardIcon';
import { createCard } from '../../model/factories';

describe('卡面标记取哪一处（`cardIconOf`）', () => {
  it('便签：读**卡级** `icon`', () => {
    expect(cardIconOf(createCard('note', { icon: '📌' }))).toBe('📌');
    expect(cardIconOf(createCard('note'))).toBe('');
  });

  it('★ 白板卡：读**内容**里的 `icon`（卡级那个键对它没有意义）', () => {
    const card = createCard('boardRef', { content: { icon: '🔥' } });
    expect(cardIconOf(card)).toBe('🔥');
  });

  it('★ 白板卡：卡级塞了值也**不认**（这正是"换图标不生效"那条 bug 的形状）', () => {
    // 手改过的旧文件 / 前几版误写的键：卡级有 `icon`，而真正生效的是内容里那一个。
    // ★ 内容先清干净 —— 新建的白板卡自带一个**随机记号**（`O18` 那条 ③），不清就看不出差别
    const card = createCard('boardRef', { content: { icon: '' } });
    card.icon = '📌';
    expect(cardIconOf(card)).toBe('');
  });

  it('控制字符 / 空白都当"没有"（与读写入口共用同一份归一化）', () => {
    // `normalizeIcon` 剔的是控制字符（`\n` / `\t` / `\u0000`…）与首尾空白 ——
    // ★ 零宽字符（`\u200b`）**不在**它的口径里（那条边界在写入口就拦了），别拿它当例子
    expect(cardIconOf(createCard('note', { icon: '\n\t' }))).toBe('');
    expect(cardIconOf(createCard('boardRef', { content: { icon: ' ' } }))).toBe('');
  });
});
