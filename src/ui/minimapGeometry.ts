/**
 * 缩略图导航器的**几何**（T5.09 / `F1-06`）。
 *
 * 这个文件一行 DOM 都没有 —— 与 `ui/boardList.ts` 同一条分工：
 * 「世界坐标 → 地图坐标」的映射错了非常难受（点哪儿不跳哪儿、视口框画在错的地方），
 * 而这种错在真实界面上只能靠眼睛猜。放在这里就能被单测钉死（`04 §12`）。
 *
 * ★ 文件名**故意不叫 `minimap.ts`**：macOS 的默认文件系统大小写不敏感，
 *   `minimap.ts` 与同目录的 `Minimap.ts` 会是**同一个文件**（写一个等于覆盖另一个，
 *   而且 `git` 里看不出来）。几何与视图各占一个名字，别让它们只差一个大小写。
 *
 * ## 三条不变量（下面每条都在代码里标了 ★）
 *
 * 1. **等比**：`scale` 在 x / y 上是**同一个数**。分别按宽高拉伸（"填满这个盒子"）
 *    会让方卡在缩略图里变成长条 —— 而形状是缩略图里唯一能对齐的东西。
 * 2. **内容居中**：等比之后剩下的空白平摊到两侧，不都堆在右下角。
 * 3. **至少一个点**：每个矩形映射到地图上时**最小 1px**（贴住左上角、只抬尺寸）。
 *    两万像素宽的板子上，一张 200px 的卡只占 1.7px，而不足 1px 的盒子会被浏览器
 *    四舍五入到 **0** —— 于是整张缩略图上**一张卡都看不见**，看起来像"这块板是空的"。
 *
 * ## 刻意不做的事
 *
 * * **不画连线**：连线没有面积（`BoardView.contentBounds()` 也只算卡片与分栏）。
 *   在 176px 宽的地图上画几百条线，得到的是噪点而不是信息。
 * * **不画选区**：缩略图回答的是"这块板有多大、我在哪儿"，不是"我选中了什么"。
 *   选中态由画布上那圈描边回答，在缩略图里再画一遍（几百个点）只是让它更糊。
 */

import type { BoardFile } from '../model/schema';
import { boundsOf, rotatedBoundsOf, roundTo, type Point, type Rect } from '../util/geometry';

/** 地图盒子的可用尺寸（CSS 像素）。实际值由样式给出，这里只是入参的形状 */
export interface MinimapBox {
  width: number;
  height: number;
}

/**
 * 缩略图里的一格。连线没有面积、编组只是虚线框，两者都不参与。
 *
 * ★ `kind` 只有一处在用：面板把它写成 `is-<kind>` 类名，颜色由样式表定。
 *   白板这里是"容器 / 内容"两档（`card` / `column`）；脑图借这套东西时也带了自己的两档 ——
 *   树上的节点（`node`）与**悬浮节点**（`free`，不在树上、飘在外面的那些），
 *   见 `mind/view/minimapShapes.ts`。
 */
export interface MinimapShape {
  kind: 'card' | 'column' | 'node' | 'free';
  rect: Rect;
}

/**
 * 世界坐标 → 地图坐标的映射。
 *
 * `mapX = worldX × scale + offsetX`，与 `view/Viewport.ts` 的 `screen = world × zoom + offset`
 * 同一个形状 —— 两边都是"等比 + 平移"，读代码时不必切换脑子。
 */
export interface MinimapPlan {
  scale: number;
  /** 世界原点在地图坐标系里的位置（px，相对 `.nestboard-minimap__map` 的左上角） */
  offsetX: number;
  offsetY: number;
  /** 内容在地图上占的尺寸（px）= 内容包围盒 × scale */
  width: number;
  height: number;
}

/** 内容四周留白（px）。贴边画会让人分不清"卡片到边了"还是"被裁掉了" */
export const MINIMAP_PADDING = 6;

/** 一格在地图上的最小尺寸（px，见文件头第 3 条） */
export const MINIMAP_MIN_DOT = 1;

/**
 * 指纹的小数位。
 *
 * ★ 与**渲染精度保持一致**：写进样式的数字也是 2 位（`roundTo`），
 *   所以"指纹没变"严格等价于"画出来一模一样" —— 这样调用方可以放心地
 *   "指纹没变就什么都不做"，而不会漏掉一次该有的重画，也不会因为
 *   浮点噪声（拖动一次留下的 `x = 12.000000001`）白白重建整张地图。
 */
const SIGNATURE_DIGITS = 2;

/** 相机快照（屏幕坐标）。**故意不是 `Viewport` 实例**：地图只需要这五个数 */
export interface MinimapCamera {
  /** 世界原点在屏幕上的位置（即 `Viewport.x/y`） */
  x: number;
  y: number;
  zoom: number;
  /** 视口尺寸（屏幕像素） */
  width: number;
  height: number;
}

function rectOf(item: { x: number; y: number; width: number; height: number }): Rect {
  // ★ 显式取四个字段而不是把整个对象递出去：卡片对象是**活的**（下一帧可能被改写），
  //   地图拿着的必须是一份死掉的快照
  return { x: item.x, y: item.y, width: item.width, height: item.height };
}

/**
 * 白板 → 缩略图里的格子清单。
 *
 * ★ 分栏在前、卡片在后：地图里的压盖关系与世界容器一致（卡片压在它所在的分栏上）。
 *   `BoardFile | null` 直接收下（`null` = 还没加载 / 板不可用），省得每个调用点
 *   自己写一遍 `board ? [...board.cards] : []`。
 */
export function minimapShapes(board: BoardFile | null): MinimapShape[] {
  if (!board) return [];
  return [
    ...board.columns.map((column): MinimapShape => ({ kind: 'column', rect: rectOf(column) })),
    // ★ 卡片取**外接框**（T7.06）：地图上画的是轴对齐的小方块，转过的卡片只有用
    //   外接框才覆盖它真正占的那块地方（用布局框会把转出来的角漏在地图外，
    //   表现是"地图上这块板比实际小一圈、最边上那张卡被切掉一块"）。
    // ★ 顺带解决了"地图不跟着旋转更新"：外接框进了 `shape.rect`，`contentSignature`
    //   自然跟着变 —— 否则转动最外边那张卡时指纹一模一样，地图会停在旧的样子上。
    //   这里不需要"要不要单独把角度塞进指纹"的第二个决定（`0°` 时外接框 = 布局框）。
    ...board.cards.map((card): MinimapShape => ({
      kind: 'card',
      rect: rotatedBoundsOf(rectOf(card), card.rotation ?? 0),
    })),
  ];
}

/** 全部格子的包围盒；没有内容返回 `null`（地图不画空盒子） */
export function contentBounds(shapes: readonly MinimapShape[]): Rect | null {
  return boundsOf(shapes.map((shape) => shape.rect));
}

/**
 * 内容指纹：数量 + 每一格的类型与几何（按渲染精度取整）。
 *
 * ★ **不含卡片 id / 标题 / 颜色**：地图上画不出它们，含进来只会让
 *   "改了一个字"也触发一次整图重建。也不含 `updatedAt` 同理。
 */
export function contentSignature(shapes: readonly MinimapShape[]): string {
  return shapes
    .map((shape) => {
      const { x, y, width, height } = shape.rect;
      // ★ 类型写全名而不是首字母：`card` 与 `column` 的首字母**都是 `c`** ——
      //   同一块地方从卡片换成同尺寸分栏时指纹会一模一样，地图就停在旧样式上
      //   （这一条正是被单测逮住的）
      return `${shape.kind}:${roundTo(x, SIGNATURE_DIGITS)},${roundTo(y, SIGNATURE_DIGITS)},${roundTo(
        width,
        SIGNATURE_DIGITS,
      )},${roundTo(height, SIGNATURE_DIGITS)}`;
    })
    .join(';');
}

/** 由内容包围盒与地图盒子算出这一版映射（返回 `null` = 无内容 / 无量到尺寸，别画） */
export function planMinimap(bounds: Rect | null, box: MinimapBox): MinimapPlan | null {
  if (!bounds) return null;
  if (!isUsableBox(box)) return null;

  const usableWidth = Math.max(1, box.width - MINIMAP_PADDING * 2);
  const usableHeight = Math.max(1, box.height - MINIMAP_PADDING * 2);
  // 内容宽高取 `max(…, 1)`：一个 1px 的分栏（理论上能造出来）不该让 scale 变成 Infinity
  const contentWidth = Math.max(Math.abs(bounds.width), 1);
  const contentHeight = Math.max(Math.abs(bounds.height), 1);

  // ★ 不变量 1：x / y 用同一个 scale
  const scale = Math.min(usableWidth / contentWidth, usableHeight / contentHeight);
  if (!Number.isFinite(scale) || scale <= 0) return null;

  const width = contentWidth * scale;
  const height = contentHeight * scale;
  return {
    scale,
    // ★ 不变量 2：居中的那半格空白摊到两边
    offsetX: MINIMAP_PADDING + (usableWidth - width) / 2 - bounds.x * scale,
    offsetY: MINIMAP_PADDING + (usableHeight - height) / 2 - bounds.y * scale,
    width,
    height,
  };
}

/** 世界坐标点 → 地图坐标点 */
export function toMapPoint(plan: MinimapPlan, point: Point): Point {
  return {
    x: roundTo(point.x * plan.scale + plan.offsetX, SIGNATURE_DIGITS),
    y: roundTo(point.y * plan.scale + plan.offsetY, SIGNATURE_DIGITS),
  };
}

/** 世界矩形 → 地图矩形（★ 不变量 3：贴住左上角，只把尺寸抬到 1px） */
export function toMapRect(plan: MinimapPlan, rect: Rect): Rect {
  const topLeft = toMapPoint(plan, rect);
  return {
    x: topLeft.x,
    y: topLeft.y,
    width: Math.max(MINIMAP_MIN_DOT, roundTo(Math.abs(rect.width) * plan.scale, SIGNATURE_DIGITS)),
    height: Math.max(
      MINIMAP_MIN_DOT,
      roundTo(Math.abs(rect.height) * plan.scale, SIGNATURE_DIGITS),
    ),
  };
}

/** 地图坐标点 → 世界坐标点（点哪儿跳哪儿的另一半） */
export function toWorldPoint(plan: MinimapPlan, point: Point): Point {
  return {
    x: (point.x - plan.offsetX) / plan.scale,
    y: (point.y - plan.offsetY) / plan.scale,
  };
}

/**
 * 视口在地图上对应的世界矩形（"我现在看的是哪一块"）。
 *
 * ★ 用 `zoom` 反推而不是 `Viewport.visibleBounds()`：那个方法默认带一圈裁剪外扩
 *   （`CULL_PADDING = 200px`），框比用户真正看到的范围大一圈 —— 画在缩略图上
 *   就是"我明明只看着这张卡，框却罩住了旁边三张"。
 * ★ 相机数据不合法（还没测量尺寸 / `zoom` 为 0）时返回 `null`：宁可不画，
 *   也不要画一个除零得到的 `Infinity` 框。
 */
export function viewportWorldRect(camera: MinimapCamera): Rect | null {
  if (!Number.isFinite(camera.zoom) || camera.zoom <= 0) return null;
  if (!Number.isFinite(camera.x) || !Number.isFinite(camera.y)) return null;
  if (!(camera.width > 0) || !(camera.height > 0)) return null;
  return {
    // ★ `0 - x` 而不是 `-x`：后者在 `x` 为 0 时会得到 `-0`，
    //   它会一路溜进样式串与日志里（`translate(-0px, -0px)`），而 `-0 !== 0` 也会让断言莫名其妙地红
    x: 0 - camera.x / camera.zoom,
    y: 0 - camera.y / camera.zoom,
    width: camera.width / camera.zoom,
    height: camera.height / camera.zoom,
  };
}

/** 盒子是否可用（视图被折叠 / 尚未布局时拿到的是 0 或 NaN） */
export function isUsableBox(box: MinimapBox): boolean {
  return (
    Number.isFinite(box.width) && Number.isFinite(box.height) && box.width > 0 && box.height > 0
  );
}
