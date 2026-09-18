/**
 * 无障碍（T3.26 / `02 §7`）的可访问名与提示文案。
 *
 * ★ 为什么把"给一张卡起个名字"单独抽出来当一个模块：
 *   读屏软件念出来的那一句话，是键盘 / 读屏用户理解这块白板的**唯一入口**。
 *   它由三块拼成（类型 + 标题 + 状态），`02 §7` 给的样子是 `"便签卡：标题"`。
 *   拼装规则散在渲染层的话，"锁定的卡有没有念出'已锁定'"这种问题
 *   只能靠人肉点一遍 —— 集中在这里就能一条条断言。
 *
 * ★ 纯函数（只依赖 i18n 与卡片注册表），可在 node 下单测。
 */

import { CARD_TYPE_LABEL_KEY } from '../cards/registry';
import type { Card, CardType } from '../model/schema';
import { t } from '../util/i18n';

/** 卡片类型的本地化名（"便签卡" / "待办清单"…）。走注册表那张表，避免各调用点各查一遍 */
export function cardTypeLabel(type: CardType): string {
  return t(CARD_TYPE_LABEL_KEY[type]);
}

export interface CardA11yState {
  /** 这张卡此刻在不在选区里。读屏用户看不到"蓝框"，只能靠这句话知道 */
  selected?: boolean;
}

/**
 * 一张卡的可访问名，形如 `便签：会议纪要`、`图片：截图（已锁定、已选中）`。
 *
 * ★ 类型名直接复用卡片自己的本地化名（`card.type.*`），不再另造一套
 *   "便签卡 / 便签卡片"——同一张卡在标题栏、右键菜单、读屏里叫同一个名字，
 *   用户听到的和看到的才是同一件事。
 * ★ 标题优先用 `card.title`，**空标题回落到"未命名{类型}"而不是留空**：
 *   空名字会让读屏只念一句"分组"，用户完全不知道光标停在哪张卡上。
 * ★ 状态用后缀而不是替换主体：`role="group"` 的元素上，读屏念的是
 *   "<名字>，分组" —— 把"已锁定"塞进名字里，用户听到的顺序才是完整的。
 */
export function cardAriaLabel(card: Card, state: CardA11yState = {}): string {
  const type = cardTypeLabel(card.type);
  const title = card.title.trim();
  const label = title ? t('a11y.card.label', { type, title }) : t('a11y.card.untitled', { type });

  const marks: string[] = [];
  // ★ 顺序固定：锁定在前、选中在后。两条都是"状态"，用户按同一个顺序听两遍才记得住
  if (card.locked) marks.push(t('a11y.card.locked'));
  if (state.selected) marks.push(t('a11y.card.selected'));
  if (marks.length === 0) return label;

  return t('a11y.card.withState', {
    label,
    state: marks.join(t('a11y.card.stateSeparator')),
  });
}

/**
 * 世界容器（所有卡片的共同父节点）的可访问名：让读屏用户知道"这块板上有多少张卡"。
 *
 * ★ 数的是**卡片总数**而不是"当前挂在 DOM 里的张数"：视口裁剪会让 DOM 里的数量
 *   随相机到处变，念一个随移动而变化的数字只会让人困惑。
 */
export function boardAriaLabel(cardCount: number): string {
  return t('a11y.board.label', { count: cardCount });
}

/** 画布容器的操作提示（放在 `aria-describedby` 上，随 `aria-label` 一起被念出） */
export function canvasA11yHint(): string {
  return t('a11y.canvas.hint');
}

/** 单张卡的操作提示（挂在卡片的 `aria-describedby` 上） */
export function cardA11yHint(): string {
  return t('a11y.card.hint');
}
