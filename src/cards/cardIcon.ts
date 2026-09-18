/**
 * 一张卡的**卡面标记**（emoji）存在哪一处（`O38`）。
 *
 * ★ 这里唯一要记住的一件事：**位置按卡片类型分**
 *
 *   * **白板卡**在**内容**里 —— `BoardRefContent.icon`（`O10` 起就是这样）。它是那一档
 *     "卡面画什么"的一部分：迷你形态正中那一格、展开形态标题行左边那一格，都读它；
 *   * **便签**（以及其余卡片）在**卡级** —— `Card.icon`（`O38` 给便签加的）。
 *
 * ★ 两处混用的表现是**"点了没反应"**（不是报错）：写进去了，可渲染读的不是那一处。
 *   这一条真踩过 —— 快捷操作栏给白板卡写了卡级 `icon`，而迷你卡读 `content.icon`，
 *   于是"右键换图标 / 栏里换图标"两条路都像坏了一样。
 *
 * ★ 归一化走 `normalizeIcon`（与读写入口同一份）：手改过的文件里可能是空串 /
 *   控制字符 / 一长段文字，读这一侧也当"没设"，免得卡面被撑坏。
 */
import { normalizeIcon } from '../util/emoji';
import type { Card } from '../model/schema';

/** 这张卡现在的标记；空串 = 没有 */
export function cardIconOf(card: Card): string {
  return card.type === 'boardRef' ? normalizeIcon(card.content.icon) : normalizeIcon(card.icon);
}
