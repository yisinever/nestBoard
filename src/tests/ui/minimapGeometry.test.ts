/**
 * 缩略图导航器几何的单元测试（T5.09 / `F1-06`）。
 *
 * 这里钉的是三件"错了很难看出来"的事：
 *
 *  * **等比**：分别按宽高拉伸也能"填满盒子"，但那会把方卡拉成长条 ——
 *    用户不会说"你的缩略图变形了"，只会觉得"这东西看着不对"；
 *  * **点哪儿跳哪儿**：`toMapPoint` 与 `toWorldPoint` 必须是互逆的，
 *    否则现象是"点在卡片上，视图飞到卡片旁边一点"，很难归因；
 *  * **大板子上看得见**：两万像素宽的板子上每张卡不足 1px，浏览器四舍五入到 0 ——
 *    整张地图**一张卡都看不见**，看起来像"这块板是空的"。
 *
 * 另外两条是给调用方省心的：`contentSignature` 必须"几何一样 ⇒ 指纹一样"
 * （不然每次自动保存都白重建一张地图），而"几何变了 ⇒ 指纹一定变"（不然地图会停在旧版本）。
 */

import { describe, expect, it } from 'vitest';
import {
  createBoardFile,
  createCard,
  createColumn,
  createEdge,
  createMind,
} from '../../model/factories';
import type { BoardFile, Mind } from '../../model/schema';
import { createMindFile, createMindNode } from '../../mind/model/factories';
import type { MindFile } from '../../mind/model/schema';
import {
  MINIMAP_MIN_DOT,
  MINIMAP_PADDING,
  contentBounds,
  contentSignature,
  isUsableBox,
  minimapShapes,
  planMinimap,
  toMapPoint,
  toMapRect,
  toWorldPoint,
  viewportWorldRect,
  type MinimapBox,
  type MinimapShape,
} from '../../ui/minimapGeometry';

const BOX: MinimapBox = { width: 176, height: 116 };

function board(cards: BoardFile['cards'] = [], columns: BoardFile['columns'] = []): BoardFile {
  return createBoardFile({ cards, columns });
}

function cardAt(x: number, y: number, width = 200, height = 100): BoardFile['cards'][number] {
  return createCard('note', { x, y, width, height });
}

describe('minimapShapes', () => {
  it('没有板子时给空清单（调用方不必先判空）', () => {
    expect(minimapShapes(null)).toEqual([]);
  });

  it('分栏在前、卡片在后：地图里的压盖关系与世界一致', () => {
    const b = board([cardAt(10, 10)], [createColumn({ x: 0, y: 0 })]);
    expect(minimapShapes(b).map((shape) => shape.kind)).toEqual(['column', 'card']);
  });

  it('只取四个几何字段，不把活对象递出去', () => {
    const card = cardAt(10, 20, 300, 150);
    const shapes = minimapShapes(board([card]));
    expect(shapes[0].rect).toEqual({ x: 10, y: 20, width: 300, height: 150 });
    // 卡片对象是活的：改动它不该影响已经取出来的快照
    card.x = 999;
    expect(shapes[0].rect.x).toBe(10);
  });

  it('连线不参与（没有面积，画在地图上是噪点）', () => {
    const b = board([cardAt(0, 0)], []);
    b.edges = [createEdge({ cardId: 'a', side: null }, { cardId: 'b', side: null })];
    expect(minimapShapes(b)).toHaveLength(1);
  });
});

/**
 * 脑图进地图（`2.2.0` 批 4）。
 *
 * 从前"一张脑图 = 一张卡"，它自然在地图上占一格；升格成容器之后它不在 `cards` 里 ——
 * 不补这一笔，那棵树会**凭空消失**，用户看到的是"这块板的缩略图比实际小一圈"。
 */
describe('minimapShapes · 白板级脑图', () => {
  /** 一棵"根 + 2 个分支"的内嵌脑图，落脚点在 `(x, y)`（根节点中心） */
  function mindBoard(x: number, y: number) {
    const file = createMindFile({ rootText: '中心' });
    file.nodes.push(createMindNode({ parentId: file.rootId, text: '甲', order: 0 }));
    file.nodes.push(createMindNode({ parentId: file.rootId, text: '乙', order: 1 }));
    const b = createBoardFile();
    b.minds = [createMind({ x, y, path: '', mind: file })];
    return { board: b, file };
  }

  const inlineModels = (mind: Mind): MindFile | null => mind.mind ?? null;

  it('★ 不给模型就一个节点都不画（老调用方行为不变）', () => {
    const { board: b } = mindBoard(0, 0);
    expect(minimapShapes(b)).toEqual([]);
    expect(minimapShapes(b, { mindModelOf: () => null })).toEqual([]);
  });

  it('★★ 给了模型 ⇒ 节点进地图，而且**根节点落在容器的 `x/y` 上**', () => {
    const { board: b, file } = mindBoard(1000, 500);

    const shapes = minimapShapes(b, { mindModelOf: inlineModels });
    expect(shapes).toHaveLength(3);
    // 树上的节点（不是悬浮节点）：都算 `node` 那一档
    expect(shapes.every((shape) => shape.kind === 'node')).toBe(true);

    // 容器的 `x/y` 是**根节点中心** —— 地图上的根节点方块必须把它围住
    const rootShape = shapes.find(
      (shape) =>
        shape.rect.x <= 1000 &&
        1000 <= shape.rect.x + shape.rect.width &&
        shape.rect.y <= 500 &&
        500 <= shape.rect.y + shape.rect.height,
    );
    expect(rootShape).toBeDefined();
    // 外接框要真的把那棵树包进来（比一个节点大）
    const bounds = contentBounds(shapes)!;
    expect(bounds.width).toBeGreaterThan(rootShape!.rect.width);
    expect(file.nodes).toHaveLength(3);
  });

  it('★ 分栏在前、脑图居中、卡片最后（压盖关系与世界一致）', () => {
    const { board: b } = mindBoard(0, 0);
    b.columns = [createColumn({ x: -500, y: -500 })];
    b.cards = [createCard('note', { x: 500, y: 500 })];

    expect(minimapShapes(b, { mindModelOf: inlineModels }).map((shape) => shape.kind)).toEqual([
      'column',
      'node',
      'node',
      'node',
      'card',
    ]);
  });
});

describe('contentBounds', () => {
  it('没有格子时返回 null（地图不画空盒子）', () => {
    expect(contentBounds([])).toBeNull();
  });

  it('是所有格子的并集', () => {
    const shapes = minimapShapes(board([cardAt(10, 20, 100, 50), cardAt(-40, 200, 100, 50)]));
    expect(contentBounds(shapes)).toEqual({ x: -40, y: 20, width: 150, height: 230 });
  });
});

describe('contentSignature', () => {
  it('几何一样 ⇒ 指纹一样（哪怕对象换了、字段多寡不同）', () => {
    const a = minimapShapes(board([cardAt(10, 20)]));
    const b = minimapShapes(board([createCard('todo', { x: 10, y: 20, width: 200, height: 100 })]));
    expect(contentSignature(a)).toBe(contentSignature(b));
  });

  it('挪动一张卡 ⇒ 指纹变', () => {
    const before = contentSignature(minimapShapes(board([cardAt(10, 20)])));
    const after = contentSignature(minimapShapes(board([cardAt(10, 21)])));
    expect(after).not.toBe(before);
  });

  it('增删一张卡 ⇒ 指纹变', () => {
    const one = contentSignature(minimapShapes(board([cardAt(0, 0)])));
    const two = contentSignature(minimapShapes(board([cardAt(0, 0), cardAt(500, 0)])));
    expect(two).not.toBe(one);
  });

  it('同位置换成另一种格子 ⇒ 指纹变（样式不一样，得重画）', () => {
    const asCard = contentSignature(minimapShapes(board([cardAt(0, 0)])));
    const asColumn = contentSignature(
      minimapShapes(board([], [createColumn({ x: 0, y: 0, width: 200, height: 100 })])),
    );
    expect(asColumn).not.toBe(asCard);
  });

  it('★ 小于渲染精度的浮点噪声不算变化（不然每次自动保存都要重建整张地图）', () => {
    const plain = contentSignature(minimapShapes(board([cardAt(10, 20)])));
    const noisy = contentSignature(minimapShapes(board([cardAt(10.000000001, 20.000000001)])));
    expect(noisy).toBe(plain);
  });

  it('★ 但渲染精度之上的变化必须算（指纹与写进样式的精度是同一个）', () => {
    const plain = contentSignature(minimapShapes(board([cardAt(10, 20)])));
    const moved = contentSignature(minimapShapes(board([cardAt(10.01, 20)])));
    expect(moved).not.toBe(plain);
  });
});

describe('planMinimap', () => {
  it('宽内容按宽度贴满，且 x / y 用同一个 scale', () => {
    const plan = planMinimap({ x: 0, y: 0, width: 1000, height: 100 }, BOX);
    expect(plan).not.toBeNull();
    // 宽 1000 撑满可用宽（去掉两侧留白），高只占 1/10
    expect(plan!.scale).toBeCloseTo((BOX.width - MINIMAP_PADDING * 2) / 1000, 6);
    expect(plan!.width).toBeCloseTo(BOX.width - MINIMAP_PADDING * 2, 6);
  });

  it('高内容按高贴满（另一个方向也一样）', () => {
    const plan = planMinimap({ x: 0, y: 0, width: 100, height: 1000 }, BOX);
    expect(plan!.height).toBeCloseTo(BOX.height - MINIMAP_PADDING * 2, 6);
  });

  it('★ 等比：一个正方形在两种盒子形状下都不会被拉成长条', () => {
    const square: MinimapShape[] = minimapShapes(board([cardAt(0, 0, 400, 400)]));
    for (const box of [
      { width: 200, height: 100 },
      { width: 100, height: 200 },
    ]) {
      const plan = planMinimap(contentBounds(square), box)!;
      const rect = toMapRect(plan, square[0].rect);
      expect(rect.width).toBeCloseTo(rect.height, 6);
    }
  });

  it('内容居中：上下 / 左右两侧的空白一样多', () => {
    const plan = planMinimap({ x: 0, y: 0, width: 1000, height: 100 }, BOX)!;
    const topLeft = toMapPoint(plan, { x: 0, y: 0 });
    const bottomRight = toMapPoint(plan, { x: 1000, y: 100 });
    expect(topLeft.x).toBeCloseTo(BOX.width - bottomRight.x, 6);
    expect(topLeft.y).toBeCloseTo(BOX.height - bottomRight.y, 6);
  });

  it('内容不在原点（负坐标）也照样落在盒子里', () => {
    const shapes = minimapShapes(board([cardAt(-3000, -2000, 100, 100)]));
    const plan = planMinimap(contentBounds(shapes), BOX)!;
    const rect = toMapRect(plan, shapes[0].rect);
    expect(rect.x).toBeGreaterThanOrEqual(0);
    expect(rect.y).toBeGreaterThanOrEqual(0);
    expect(rect.x + rect.width).toBeLessThanOrEqual(BOX.width);
    expect(rect.y + rect.height).toBeLessThanOrEqual(BOX.height);
  });

  it('没有内容 / 盒子量不到尺寸 ⇒ null（调用方据此不画）', () => {
    expect(planMinimap(null, BOX)).toBeNull();
    expect(planMinimap({ x: 0, y: 0, width: 10, height: 10 }, { width: 0, height: 0 })).toBeNull();
    expect(
      planMinimap({ x: 0, y: 0, width: 10, height: 10 }, { width: NaN, height: 116 }),
    ).toBeNull();
  });

  it('退化成一个点的内容不会算出 Infinity', () => {
    const plan = planMinimap({ x: 20, y: 20, width: 0, height: 0 }, BOX);
    expect(plan).not.toBeNull();
    expect(Number.isFinite(plan!.scale)).toBe(true);
  });
});

describe('toMapRect / toMapPoint / toWorldPoint', () => {
  it('★ 互逆：地图上的一点换算回世界再换回来还是它', () => {
    const plan = planMinimap({ x: -500, y: 300, width: 4000, height: 1200 }, BOX)!;
    for (const point of [
      { x: 0, y: 0 },
      { x: 123.45, y: -67.89 },
      { x: 3000, y: 1500 },
    ]) {
      const round = toWorldPoint(plan, toMapPoint(plan, point));
      // 容差 0.2 世界像素：`toMapPoint` 会把地图坐标收成 2 位小数（见 `SIGNATURE_DIGITS`），
      // 在这个 `scale ≈ 0.04` 的映射下 0.005 地图像素 ≈ 0.12 世界像素。
      // 点一下偏不到半个像素，没人能感觉到 —— 但这不是"随便给个大容差"，
      // 它正好等于"渲染精度 / scale"，`scale` 再小一个数量级就会失控（那时该重新审视精度）。
      expect(Math.abs(round.x - point.x)).toBeLessThan(0.2);
      expect(Math.abs(round.y - point.y)).toBeLessThan(0.2);
    }
  });

  it('顺序不乱：世界里更靠右 / 更靠下的，地图上也更靠右 / 更靠下', () => {
    const shapes = minimapShapes(board([cardAt(0, 0), cardAt(800, 0), cardAt(0, 600)]));
    const plan = planMinimap(contentBounds(shapes), BOX)!;
    const [first, right, below] = shapes.map((shape) => toMapRect(plan, shape.rect));
    expect(right.x).toBeGreaterThan(first.x);
    expect(below.y).toBeGreaterThan(first.y);
  });

  it('★ 大板子上每张卡至少占 1px（不足 1px 会被浏览器四舍五入成 0，整图空白）', () => {
    const shapes = minimapShapes(board([cardAt(0, 0, 200, 100), cardAt(19_000, 0, 200, 100)]));
    const plan = planMinimap(contentBounds(shapes), BOX)!;
    for (const shape of shapes) {
      const rect = toMapRect(plan, shape.rect);
      expect(rect.width).toBeGreaterThanOrEqual(MINIMAP_MIN_DOT);
      expect(rect.height).toBeGreaterThanOrEqual(MINIMAP_MIN_DOT);
    }
    // 精确等比时这两张卡只有 1.7px 宽 —— 证明上面的下限确实在起作用
    expect(200 * plan.scale).toBeLessThan(MINIMAP_MIN_DOT * 2);
  });

  it('抬尺寸不挪位置：小格子的左上角仍是它本来的映射', () => {
    const shapes = minimapShapes(board([cardAt(19_000, 0, 200, 100)]));
    const plan = planMinimap(contentBounds(shapes), BOX)!;
    const rect = toMapRect(plan, shapes[0].rect);
    const point = toMapPoint(plan, shapes[0].rect);
    expect(rect.x).toBe(point.x);
    expect(rect.y).toBe(point.y);
  });

  it('视口框比内容还大时（缩小到看见全板），框会超出盒子 —— 由样式裁掉', () => {
    const shapes = minimapShapes(board([cardAt(0, 0, 200, 100), cardAt(1000, 0, 200, 100)]));
    const plan = planMinimap(contentBounds(shapes), BOX)!;
    const rect = toMapRect(plan, { x: -2000, y: -2000, width: 6000, height: 6000 });
    expect(rect.width).toBeGreaterThan(BOX.width);
    expect(rect.x).toBeLessThan(0);
  });
});

describe('viewportWorldRect', () => {
  it('由相机反推：zoom 2、原点左移 100 ⇒ 世界左上角在 (50, 0)', () => {
    const rect = viewportWorldRect({ x: -100, y: 0, zoom: 2, width: 800, height: 600 });
    expect(rect).toEqual({ x: 50, y: 0, width: 400, height: 300 });
  });

  it('★ 是"真正看到的那一块"，不含裁剪外扩', () => {
    // 视口 1000×800、zoom 1 ⇒ 世界里的可见矩形就该是 1000×800
    // （`Viewport.visibleBounds()` 默认会外扩 200px，画在缩略图上框会大一圈）
    const rect = viewportWorldRect({ x: 0, y: 0, zoom: 1, width: 1000, height: 800 });
    expect(rect).toEqual({ x: 0, y: 0, width: 1000, height: 800 });
  });

  it('相机数据不合法 ⇒ null（宁可不画，也不画一个 Infinity 框）', () => {
    expect(viewportWorldRect({ x: 0, y: 0, zoom: 0, width: 800, height: 600 })).toBeNull();
    expect(viewportWorldRect({ x: 0, y: 0, zoom: 1, width: 0, height: 600 })).toBeNull();
    expect(viewportWorldRect({ x: NaN, y: 0, zoom: 1, width: 800, height: 600 })).toBeNull();
  });
});

describe('isUsableBox', () => {
  it('0 与 NaN 都不算可用尺寸', () => {
    expect(isUsableBox(BOX)).toBe(true);
    expect(isUsableBox({ width: 0, height: 116 })).toBe(false);
    expect(isUsableBox({ width: 176, height: NaN })).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────
// 转过的卡片（T7.06 / `F2-00-10`）
//
// 地图上画的是**轴对齐**的小方块，所以只能取外接框 —— 但"取哪个框"决定的不是
// 好看与否：取布局框会让转出来的角漏在地图外（感觉是"地图比实际小一圈"），
// 而且**指纹不会变** —— 转动最外边那张卡时地图会一直停在旧的样子上。
// ─────────────────────────────────────────────────────────────

describe('minimapShapes · 转过的卡片', () => {
  it('转 45°：地图上占的地方按外接框变大（√2 倍）', () => {
    const plain = minimapShapes(board([cardAt(0, 0, 100, 100)]))[0]!;
    expect(plain.rect).toEqual({ x: 0, y: 0, width: 100, height: 100 });

    const turned = cardAt(0, 0, 100, 100);
    turned.rotation = 45;
    const shape = minimapShapes(board([turned]))[0]!;

    expect(shape.rect.width).toBeCloseTo(Math.SQRT2 * 100);
    expect(shape.rect.height).toBeCloseTo(Math.SQRT2 * 100);
  });

  it('转 90°：宽高对调（长条卡转成竖的）', () => {
    const card = cardAt(0, 0, 200, 100);
    card.rotation = 90;
    const shape = minimapShapes(board([card]))[0]!;

    expect(shape.rect.width).toBeCloseTo(100);
    expect(shape.rect.height).toBeCloseTo(200);
  });

  it('没转过的卡片与 T7.06 之前逐字段一致', () => {
    const shape = minimapShapes(board([cardAt(10, 20, 100, 50)]))[0]!;
    expect(shape.rect).toEqual({ x: 10, y: 20, width: 100, height: 50 });
  });

  it('★ 转动一张卡会改指纹：否则地图会停在旧的样子上', () => {
    const before = contentSignature(minimapShapes(board([cardAt(0, 0, 100, 100)])));

    const turned = cardAt(0, 0, 100, 100);
    turned.rotation = 45;
    const after = contentSignature(minimapShapes(board([turned])));

    expect(after).not.toBe(before);
  });

  it('转回正之后指纹回到原值（"转过又转回来"不该让地图一直重建）', () => {
    const plain = contentSignature(minimapShapes(board([cardAt(0, 0, 100, 100)])));

    const card = cardAt(0, 0, 100, 100);
    card.rotation = 180;
    expect(contentSignature(minimapShapes(board([card])))).toBe(plain);
  });
});
