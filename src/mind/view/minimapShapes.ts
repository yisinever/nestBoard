/**
 * 脑图 → 缩略图里的格子清单（`P2-c` / `F1-06`）—— 纯逻辑，不碰 DOM。
 *
 * ★ **复用白板那套缩略图**（`ui/MinimapPanel.ts` + `ui/minimapGeometry.ts`）：几何、
 *   "点哪儿跳哪儿"、视口框、键盘路径、`settings.minimap` 那一个开关全都一样，
 *   两边只差"格子从哪儿来"这一个函数。自己再写一份小地图等于把同一套映射实现两遍 ——
 *   而那种错（点歪了、框画在错的地方）恰恰是最难一眼看出来的。
 * ★ 只画**可见节点**（`layout.boxes` 本来就是"树上没收起的 + 全部悬浮节点"）：
 *   收起的子树在地图上也该是"没有"—— 地图回答的是"我现在看的这张图长什么样"。
 * ★ 悬浮节点单列一档（`kind: 'free'`）：它们**不在这棵树上**，地图上一眼分出
 *   "树"与"飘在外面的那些"，比全都画成一个色有用（与白板"分栏比卡片淡"同一条）。
 */

import type { MinimapShape } from '../../ui/minimapGeometry';
import type { MindLayout } from '../layout/tree';
import type { MindFile } from '../model/schema';

/**
 * 可见节点 → 格子。
 *
 * @param mind 当前模型（只用来认**谁是中心主题** —— 深度 0 里除了它都是悬浮节点）
 * @param layout 当前布局；`null`（还没排 / 视图不可用）⇒ 空清单，地图不画空盒子
 */
export function mindMinimapShapes(
  mind: MindFile | null,
  layout: MindLayout | null,
): MinimapShape[] {
  if (!mind || !layout) return [];

  const shapes: MinimapShape[] = [];
  for (const box of layout.boxes.values()) {
    shapes.push({
      // ★ 用布局给的 `depth` 而不是回模型里查父指针：`NodeBox.depth` 的合同就是
      //   "根 = 0；悬浮节点也算 0"（`layout/tree.ts` 那个字段的注释）——
      //   在这一层重建一张 id→节点表只为了问一句话，纯属多花一遍 O(n)。
      kind: box.depth === 0 && box.id !== mind.rootId ? 'free' : 'node',
      // ★ 显式取四个字段：盒子对象是**活的**（下一帧量完尺寸会覆写），
      //   地图拿着的必须是一份死掉的快照（与白板 `rectOf` 同一条）。
      rect: { x: box.x, y: box.y, width: box.width, height: box.height },
    });
  }
  return shapes;
}
