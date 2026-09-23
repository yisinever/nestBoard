/**
 * 连线几何与模型操作单元测试（T1.68 / T1.70 / T1.71）。
 *
 * 连线这一块最怕的不是"画不出来"，而是**安静地画错**：
 *  * 锚点算错 → 线从卡片外面长出来，用户以为是自己没对准；
 *  * 命中判据里写死世界坐标容差 → 缩小之后"线看得见却点不中"；
 *  * `addEdges` 放过自环或重复 → 板上静默叠出十几条一模一样的线，删一条还剩九条。
 *
 * 这些在界面上都很难复现、也很难归因，只能靠单测钉死。
 * Canvas 绘制与指针手势要在 Obsidian 里肉眼验证（与 `EdgeLayer.test.ts` 同一纪律）。
 */

import { describe, expect, it } from 'vitest';
import {
  ANCHOR_SIDES,
  EDGE_CURVE_LIMIT,
  addEdges,
  autoAnchorSide,
  cardAnchor,
  curveControl,
  curveFromMidpoint,
  directionOf,
  edgeById,
  edgeEndpoints,
  edgeIntersectsRect,
  edgePathMidpoint,
  edgePathPoints,
  edgePolyline,
  edgesIntersecting,
  edgesOfCard,
  hitTestEdge,
  normalizeEdgeCurve,
  obstacleRects,
  pathBounds,
  pathMidpoint,
  pointEdgeDistance,
  pointSegmentDistance,
  polylineEndDirections,
  polylineLength,
  polylineMidpoint,
  polylinePath,
  quadraticAt,
  removeEdges,
  segmentIntersectsRect,
  shrinkPolylineEnd,
  setEdgeEndpoint,
  updateEdges,
  type AnchorSide,
  type RectLookup,
} from '../../model/edges';
import { columnDisplayHeight } from '../../model/columns';
import {
  createBoardFile,
  createCard,
  createColumn,
  createEdge,
  createMind,
} from '../../model/factories';
import type { BoardFile, Column, Edge } from '../../model/schema';
import type { Point, Rect } from '../../util/geometry';

const RECT: Rect = { x: 10, y: 20, width: 100, height: 60 };

/**
 * 从白板里按 id 查矩形 —— 与 `BoardView.cardRectLookup()` 同一套语义。
 *
 * ★ **分栏也在表里**（`O21`）：那一份实现同样收了分栏，"端点是谁"在两边必须是同一个答案 ——
 *   测试里的查表比生产少收一种端点，就会把"指向栏的线整条不画"这种真错掩盖过去。
 */
function lookupOf(board: BoardFile): RectLookup {
  const map = new Map(
    board.cards.map((card) => [
      card.id,
      { x: card.x, y: card.y, width: card.width, height: card.height },
    ]),
  );
  for (const column of board.columns) {
    map.set(column.id, {
      x: column.x,
      y: column.y,
      width: column.width,
      // 折叠态用显示高度：与 `columnRect` / 命中测试同一份几何
      height: columnDisplayHeight(column),
    });
  }
  return (cardId) => map.get(cardId) ?? null;
}

/** 一个分栏（id 固定，方便断言）；`overrides` 里可以放任意几何 */
function columnAt(id: string, overrides: Partial<Column> = {}): Column {
  return { ...createColumn(overrides), id };
}

/** 两块默认尺寸的卡片，左右分开摆放 */
function twoCards(): BoardFile {
  const board = createBoardFile();
  board.cards = [
    createCard('note', { id: 'a', x: 0, y: 0, width: 200, height: 100 }),
    createCard('note', { id: 'b', x: 500, y: 0, width: 200, height: 100 }),
  ];
  return board;
}

describe('cardAnchor', () => {
  it('取四边中点', () => {
    expect(cardAnchor(RECT, 'top')).toEqual({ x: 60, y: 20 });
    expect(cardAnchor(RECT, 'bottom')).toEqual({ x: 60, y: 80 });
    expect(cardAnchor(RECT, 'left')).toEqual({ x: 10, y: 50 });
    expect(cardAnchor(RECT, 'right')).toEqual({ x: 110, y: 50 });
  });

  it('四个方位都落在矩形边界上（不外溢、不内缩）', () => {
    for (const side of ANCHOR_SIDES) {
      const point = cardAnchor(RECT, side);
      const onVerticalEdge = side === 'left' || side === 'right';
      if (onVerticalEdge) {
        expect(point.x === RECT.x || point.x === RECT.x + RECT.width).toBe(true);
        expect(point.y).toBe(RECT.y + RECT.height / 2);
      } else {
        expect(point.y === RECT.y || point.y === RECT.y + RECT.height).toBe(true);
        expect(point.x).toBe(RECT.x + RECT.width / 2);
      }
    }
  });
});

describe('autoAnchorSide', () => {
  const center: Rect = { x: 0, y: 0, width: 100, height: 100 };

  it('按两卡中心连线的主轴选边', () => {
    const right: Rect = { ...center, x: 400 };
    const left: Rect = { ...center, x: -400 };
    const below: Rect = { ...center, y: 400 };
    const above: Rect = { ...center, y: -400 };

    expect(autoAnchorSide(center, right)).toBe('right');
    expect(autoAnchorSide(center, left)).toBe('left');
    expect(autoAnchorSide(center, below)).toBe('bottom');
    expect(autoAnchorSide(center, above)).toBe('top');
  });

  it('主轴占优：横向偏移更大时即使有纵向偏移也走左右', () => {
    expect(autoAnchorSide(center, { ...center, x: 300, y: 120 })).toBe('right');
    expect(autoAnchorSide(center, { ...center, x: 120, y: 300 })).toBe('bottom');
  });

  it('★ 中心完全重合时给确定答案（否则每次重绘可能换一个方向）', () => {
    expect(autoAnchorSide(center, { ...center })).toBe('right');
    expect(autoAnchorSide(center, { ...center })).toBe(autoAnchorSide(center, { ...center }));
  });
});

describe('edgeEndpoints', () => {
  it('显式方位直接用，不参与自动判定', () => {
    const board = twoCards();
    // b 在 a 右边，自动会选 right/left —— 这里显式钉成 top/bottom
    board.edges = [createEdge({ cardId: 'a', side: 'top' }, { cardId: 'b', side: 'bottom' })];
    const endpoints = edgeEndpoints(board.edges[0], lookupOf(board));
    expect(endpoints).toEqual({
      from: { x: 100, y: 0 },
      to: { x: 600, y: 100 },
      fromSide: 'top',
      toSide: 'bottom',
    });
  });

  it('side 为 null → 按当前几何自动选边', () => {
    const board = twoCards();
    board.edges = [createEdge({ cardId: 'a', side: null }, { cardId: 'b', side: null })];
    const endpoints = edgeEndpoints(board.edges[0], lookupOf(board));
    expect(endpoints?.fromSide).toBe('right');
    expect(endpoints?.toSide).toBe('left');
    expect(endpoints?.from).toEqual({ x: 200, y: 50 });
    expect(endpoints?.to).toEqual({ x: 500, y: 50 });
  });

  it('★ 卡片挪到另一侧 → 自动边跟着翻面（这就是 side 存 null 的意义）', () => {
    const board = twoCards();
    board.edges = [createEdge({ cardId: 'a', side: null }, { cardId: 'b', side: null })];
    // 把 b 挪到 a 左边
    const b = board.cards.find((card) => card.id === 'b');
    if (b) b.x = -500;

    const endpoints = edgeEndpoints(board.edges[0], lookupOf(board));
    expect(endpoints?.fromSide).toBe('left');
    expect(endpoints?.toSide).toBe('right');
  });

  it('任一端卡片找不到 → null（宁可这条线不画，也不画一条通往原点的线）', () => {
    const board = twoCards();
    board.edges = [createEdge({ cardId: 'a', side: null }, { cardId: 'ghost', side: null })];
    expect(edgeEndpoints(board.edges[0], lookupOf(board))).toBeNull();
    expect(edgeEndpoints(board.edges[0], () => null)).toBeNull();
  });

  // ── 自由端（T2.07 / `F3-02`） ───────────────────────────────

  it('★ 自由端：端点停在记录的坐标上，另一端照常吸在卡片上', () => {
    const board = twoCards();
    board.edges = [
      createEdge(
        { cardId: 'a', side: 'right' },
        { cardId: '', side: null, point: { x: 900, y: 300 } },
      ),
    ];
    const endpoints = edgeEndpoints(board.edges[0], lookupOf(board));
    expect(endpoints?.from).toEqual({ x: 200, y: 50 });
    expect(endpoints?.to).toEqual({ x: 900, y: 300 });
  });

  it('★ 自由端是"钉住"的：卡片怎么动，它都不动', () => {
    const board = twoCards();
    const point = { x: 900, y: 300 };
    board.edges = [createEdge({ cardId: 'a', side: 'right' }, { cardId: '', side: null, point })];
    const a = board.cards.find((card) => card.id === 'a');
    if (a) a.x = -400;

    expect(edgeEndpoints(board.edges[0], lookupOf(board))?.to).toEqual(point);
  });

  it('自由端这一端也能自动选边（按"点"算方向，不写死一个方位）', () => {
    const board = twoCards();
    // a 占 (0,0)-(200,100)，自由端落在它的右下方 → a 这一端应当走 right
    board.edges = [
      createEdge(
        { cardId: 'a', side: null },
        { cardId: '', side: null, point: { x: 800, y: 400 } },
      ),
    ];
    expect(edgeEndpoints(board.edges[0], lookupOf(board))?.fromSide).toBe('right');
  });

  it('自由端没带坐标 → null（数据坏了，宁可不画）', () => {
    const board = twoCards();
    board.edges = [createEdge({ cardId: 'a', side: null }, { cardId: '', side: null })];
    expect(edgeEndpoints(board.edges[0], lookupOf(board))).toBeNull();
  });

  it('两端都是自由端也解析得出来（画布上一条独立的线）', () => {
    const board = createBoardFile();
    board.cards = [];
    board.edges = [
      createEdge(
        { cardId: '', side: null, point: { x: 0, y: 0 } },
        { cardId: '', side: null, point: { x: 100, y: 100 } },
      ),
    ];
    expect(edgeEndpoints(board.edges[0], lookupOf(board))).toEqual({
      from: { x: 0, y: 0 },
      to: { x: 100, y: 100 },
      fromSide: 'right',
      toSide: 'left',
    });
  });
});

describe('pointSegmentDistance', () => {
  it('垂足落在线段内 → 点到直线的垂距', () => {
    expect(pointSegmentDistance({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBeCloseTo(3);
  });

  it('★ 垂足落在线段外 → 取到最近端点的距离（而不是到无限长直线的距离）', () => {
    expect(pointSegmentDistance({ x: 20, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBeCloseTo(10);
    expect(pointSegmentDistance({ x: -4, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBeCloseTo(5);
  });

  it('两端点重合（退化线段）→ 退化成点距', () => {
    expect(pointSegmentDistance({ x: 5, y: 8 }, { x: 5, y: 5 }, { x: 5, y: 5 })).toBeCloseTo(3);
  });
});

describe('segmentIntersectsRect', () => {
  it('穿过矩形 → true', () => {
    expect(segmentIntersectsRect({ x: -50, y: 50 }, { x: 150, y: 50 }, RECT)).toBe(true);
  });

  it('端点在矩形内 → true', () => {
    expect(segmentIntersectsRect({ x: 50, y: 50 }, { x: 500, y: 500 }, RECT)).toBe(true);
  });

  it('恰好从角上掠过 → true（共线/端点相接也算相交）', () => {
    // 矩形左上角是 (10,20)；这条线在 x=10 处正好取到 y=20
    expect(segmentIntersectsRect({ x: 0, y: 30 }, { x: 20, y: 10 }, RECT)).toBe(true);
  });

  it('完全在包围盒之外 → false', () => {
    expect(segmentIntersectsRect({ x: -100, y: -100 }, { x: -10, y: -100 }, RECT)).toBe(false);
    expect(segmentIntersectsRect({ x: 200, y: 200 }, { x: 300, y: 300 }, RECT)).toBe(false);
  });

  it('★ 包围盒相交但线段从角外侧绕过 → false（粗筛之后还要真求交）', () => {
    // 线段从矩形左上角外侧斜穿过去，包围盒与矩形有重叠，但两者并不相交
    expect(segmentIntersectsRect({ x: -20, y: 10 }, { x: 20, y: -20 }, RECT)).toBe(false);
  });
});

describe('hitTestEdge', () => {
  /** a(0,0,200×100) 与 b(500,0,200×100)，连线沿 y=50 从 x=200 到 x=500 */
  function boardWithEdge(): { board: BoardFile; edge: Edge } {
    const board = twoCards();
    const edge = createEdge({ cardId: 'a', side: null }, { cardId: 'b', side: null });
    board.edges = [edge];
    return { board, edge };
  }

  it('点在线上 → 命中', () => {
    const { board, edge } = boardWithEdge();
    expect(hitTestEdge(board.edges, lookupOf(board), { x: 350, y: 50 }, 8)?.id).toBe(edge.id);
  });

  it('容差内命中，容差外落空', () => {
    const { board } = boardWithEdge();
    const lookup = lookupOf(board);
    expect(hitTestEdge(board.edges, lookup, { x: 350, y: 57 }, 8)).not.toBeNull();
    expect(hitTestEdge(board.edges, lookup, { x: 350, y: 70 }, 8)).toBeNull();
  });

  it('★ 边界值：正好等于容差不算命中（严格小于，结果才稳定）', () => {
    const { board } = boardWithEdge();
    expect(hitTestEdge(board.edges, lookupOf(board), { x: 350, y: 58 }, 8)).toBeNull();
  });

  it('命中范围只在线段上，不会顺延到延长线', () => {
    const { board } = boardWithEdge();
    // x=420 在线段外（线段到 500 结束），y 再偏 6 → 到端点的距离 > 容差
    expect(hitTestEdge(board.edges, lookupOf(board), { x: 520, y: 50 }, 8)).toBeNull();
  });

  it('多条线重叠时取最近的那条', () => {
    const board = twoCards();
    const near = createEdge({ cardId: 'a', side: null }, { cardId: 'b', side: null });
    const far = createEdge({ cardId: 'a', side: null }, { cardId: 'b', side: null });
    board.edges = [near, far];
    // 两条线几何完全一致（锚点都是边中点）—— 取先出现的，至少结果稳定
    expect(hitTestEdge(board.edges, lookupOf(board), { x: 350, y: 50 }, 8)?.id).toBe(near.id);
  });

  it('端点卡片缺失的线不参与命中', () => {
    const board = twoCards();
    board.edges = [createEdge({ cardId: 'a', side: null }, { cardId: 'ghost', side: null })];
    expect(hitTestEdge(board.edges, lookupOf(board), { x: 350, y: 50 }, 8)).toBeNull();
  });

  it('空列表 → null', () => {
    expect(hitTestEdge([], () => null, { x: 0, y: 0 }, 8)).toBeNull();
  });
});

describe('edgesIntersecting', () => {
  function boardWithEdge(): BoardFile {
    const board = twoCards();
    board.edges = [createEdge({ cardId: 'a', side: null }, { cardId: 'b', side: null })];
    return board;
  }

  it('框住线段中段 → 选中', () => {
    const board = boardWithEdge();
    const rect: Rect = { x: 320, y: 0, width: 60, height: 100 };
    expect(edgesIntersecting(board.edges, lookupOf(board), rect)).toHaveLength(1);
  });

  it('框在线段上方（不接触）→ 不选中', () => {
    const board = boardWithEdge();
    const rect: Rect = { x: 320, y: -200, width: 60, height: 100 };
    expect(edgesIntersecting(board.edges, lookupOf(board), rect)).toEqual([]);
  });

  it('★ 只看线段本身，不看它的包围盒（框住两端连线之间的空地不该选中）', () => {
    const board = twoCards();
    // 一条从 a 左下绕到 b 右下的斜线：包围盒横跨整个画布
    board.edges = [createEdge({ cardId: 'a', side: 'bottom' }, { cardId: 'b', side: 'bottom' })];
    const endpoints = edgeEndpoints(board.edges[0], lookupOf(board));
    expect(endpoints).not.toBeNull();

    // 取这条斜线的包围盒中心，但缩到很小、只覆盖不到线的区域
    const midX = (endpoints!.from.x + endpoints!.to.x) / 2;
    const rect: Rect = { x: midX - 5, y: -50, width: 10, height: 20 };
    expect(edgesIntersecting(board.edges, lookupOf(board), rect)).toEqual([]);
  });
});

describe('addEdges', () => {
  it('合法连线加入并返回 true', () => {
    const board = twoCards();
    const edge = createEdge({ cardId: 'a', side: 'right' }, { cardId: 'b', side: 'left' });
    expect(addEdges(board, [edge])).toBe(true);
    expect(board.edges).toHaveLength(1);
  });

  it('★ 自环被拒绝（锚点重合，画出来是一个点）', () => {
    const board = twoCards();
    const loop = createEdge({ cardId: 'a', side: 'right' }, { cardId: 'a', side: 'left' });
    expect(addEdges(board, [loop])).toBe(false);
    expect(board.edges).toEqual([]);
  });

  it('★ 指向不存在的卡片被拒绝（否则下次打开就是一条通往 (0,0) 的线）', () => {
    const board = twoCards();
    expect(
      addEdges(board, [createEdge({ cardId: 'a', side: null }, { cardId: 'ghost', side: null })]),
    ).toBe(false);
    expect(
      addEdges(board, [createEdge({ cardId: 'ghost', side: null }, { cardId: 'a', side: null })]),
    ).toBe(false);
    expect(board.edges).toEqual([]);
  });

  it('★ 端点完全重复的连线被拒绝（否则反复拖会叠出十几条一样的线）', () => {
    const board = twoCards();
    const first = createEdge({ cardId: 'a', side: 'right' }, { cardId: 'b', side: 'left' });
    const second = createEdge({ cardId: 'a', side: 'right' }, { cardId: 'b', side: 'left' });
    expect(addEdges(board, [first])).toBe(true);
    expect(addEdges(board, [second])).toBe(false);
    expect(board.edges).toHaveLength(1);
  });

  it('★ 带自由端的连线能加进来（空 `cardId` 不能被当成"卡片不存在"）', () => {
    const board = twoCards();
    const edge = createEdge(
      { cardId: 'a', side: 'right' },
      { cardId: '', side: null, point: { x: 900, y: 300 } },
    );
    expect(addEdges(board, [edge])).toBe(true);
    expect(board.edges).toHaveLength(1);
  });

  it('★ 两条拉向不同方向的自由端线不会互相顶掉（终点坐标要参与查重）', () => {
    const board = twoCards();
    const toRight = createEdge(
      { cardId: 'a', side: 'right' },
      { cardId: '', side: null, point: { x: 900, y: 0 } },
    );
    const toBottom = createEdge(
      { cardId: 'a', side: 'bottom' },
      { cardId: '', side: null, point: { x: 0, y: 900 } },
    );
    expect(addEdges(board, [toRight])).toBe(true);
    // 只比"空 cardId + 同一个 side"的话，这一条会被判成重复而静默消失
    expect(addEdges(board, [toBottom])).toBe(true);
    expect(board.edges).toHaveLength(2);
  });

  it('同一个自由端坐标重复拉 → 判重（与卡片端点同一条纪律）', () => {
    const board = twoCards();
    const point = { x: 900, y: 300 };
    const first = createEdge({ cardId: 'a', side: 'right' }, { cardId: '', side: null, point });
    const second = createEdge({ cardId: 'a', side: 'right' }, { cardId: '', side: null, point });
    expect(addEdges(board, [first])).toBe(true);
    expect(addEdges(board, [second])).toBe(false);
    expect(board.edges).toHaveLength(1);
  });

  it('两端都是自由端不算自环，但指向自己的卡片端点仍然是自环', () => {
    const board = twoCards();
    expect(
      addEdges(board, [
        createEdge(
          { cardId: '', side: null, point: { x: 0, y: 0 } },
          { cardId: '', side: null, point: { x: 10, y: 10 } },
        ),
      ]),
    ).toBe(true);
    expect(
      addEdges(board, [createEdge({ cardId: 'a', side: 'right' }, { cardId: 'a', side: 'left' })]),
    ).toBe(false);
    expect(board.edges).toHaveLength(1);
  });

  it('方位不同则视为两条不同的连线（允许同时"从右边"和"从下边"连过去）', () => {
    const board = twoCards();
    expect(
      addEdges(board, [createEdge({ cardId: 'a', side: 'right' }, { cardId: 'b', side: null })]),
    ).toBe(true);
    expect(
      addEdges(board, [createEdge({ cardId: 'a', side: 'bottom' }, { cardId: 'b', side: null })]),
    ).toBe(true);
    expect(board.edges).toHaveLength(2);
  });

  it('空数组 → false（不产生"无变化的写入"）', () => {
    const board = twoCards();
    expect(addEdges(board, [])).toBe(false);
  });

  it('整批都不合法 → false；部分合法 → true 且只加合法的那些', () => {
    const board = twoCards();
    const bad = createEdge({ cardId: 'a', side: null }, { cardId: 'a', side: null });
    const good = createEdge({ cardId: 'a', side: null }, { cardId: 'b', side: null });
    expect(addEdges(board, [bad])).toBe(false);

    expect(addEdges(board, [bad, good, bad])).toBe(true);
    expect(board.edges).toHaveLength(1);
    expect(board.edges[0]?.id).toBe(good.id);
  });
});

// ─────────────────────────────────────────────────────────────
// 分栏作为连线端点（`O21`）
//
// 这一块的要害是**收**：模型层是所有入口的咽喉（画布拖线、`.canvas` 导入、读盘校验），
// 任何一处漏收分栏，表现都是"从栏上拉线毫无反应" ——
// 与自由端当年踩过的坑一模一样，而它在界面上看起来像"这个功能没做"。
//
// 端点 id 存在 `cardId` 一个字段里（两种 id 空间不撞，见 `schema.EdgeEndpoint`），
// 所以这里的每一条断言都同时在守两件事：**分栏收进来了**、且**卡片那套照旧**。
// ─────────────────────────────────────────────────────────────

describe('addEdges · 分栏端点（O21）', () => {
  /** a(0,0,200×100) 在左上，col 在下方 —— 一条线从卡上拉进栏里 */
  function boardWithColumn(): BoardFile {
    const board = twoCards();
    board.columns = [columnAt('col', { x: 0, y: 300, width: 400, height: 200 })];
    return board;
  }

  it('★ 卡片 → 分栏的连线能加进来（漏收分栏就等于"从栏上拉线没反应"）', () => {
    const board = boardWithColumn();
    expect(
      addEdges(board, [createEdge({ cardId: 'a', side: 'bottom' }, { cardId: 'col', side: null })]),
    ).toBe(true);
    expect(board.edges).toHaveLength(1);
  });

  it('★ 分栏 → 卡片的连线也能加进来（两个方向都得收）', () => {
    const board = boardWithColumn();
    expect(
      addEdges(board, [createEdge({ cardId: 'col', side: 'top' }, { cardId: 'a', side: null })]),
    ).toBe(true);
    expect(board.edges).toHaveLength(1);
  });

  it('分栏 → 分栏也合法（两个栏之间互相指）', () => {
    const board = boardWithColumn();
    board.columns.push(columnAt('col2', { x: 500, y: 300, width: 300, height: 200 }));
    expect(
      addEdges(board, [
        createEdge({ cardId: 'col', side: 'right' }, { cardId: 'col2', side: null }),
      ]),
    ).toBe(true);
    expect(board.edges).toHaveLength(1);
  });

  it('★ 指向**不存在**的分栏仍然被拒绝（放宽不能放成"什么都收"）', () => {
    const board = boardWithColumn();
    expect(
      addEdges(board, [createEdge({ cardId: 'a', side: null }, { cardId: 'ghost', side: null })]),
    ).toBe(false);
    expect(board.edges).toEqual([]);
  });

  it('★ 指向自己的分栏仍是自环（锚点重合，画出来是一个点）', () => {
    const board = boardWithColumn();
    expect(
      addEdges(board, [
        createEdge({ cardId: 'col', side: 'top' }, { cardId: 'col', side: 'bottom' }),
      ]),
    ).toBe(false);
    expect(board.edges).toEqual([]);
  });

  it('指向分栏的线同样参与查重（反复拖同一条不会叠出十几条）', () => {
    const board = boardWithColumn();
    const first = createEdge({ cardId: 'a', side: 'bottom' }, { cardId: 'col', side: null });
    const second = createEdge({ cardId: 'a', side: 'bottom' }, { cardId: 'col', side: null });
    expect(addEdges(board, [first])).toBe(true);
    expect(addEdges(board, [second])).toBe(false);
    expect(board.edges).toHaveLength(1);
  });
});

describe('edgeEndpoints · 端点是分栏（O21）', () => {
  it('分栏端点的几何与卡片走同一条路径（取到矩形 → 取边中点）', () => {
    const board = twoCards();
    // col 占 (0,300)-(400,500)：从 a 的下边连到它，自动选边应当落在 col 的上边
    board.columns = [columnAt('col', { x: 0, y: 300, width: 400, height: 200 })];
    board.edges = [createEdge({ cardId: 'a', side: 'bottom' }, { cardId: 'col', side: null })];

    const endpoints = edgeEndpoints(board.edges[0], lookupOf(board));
    expect(endpoints?.from).toEqual({ x: 100, y: 100 });
    expect(endpoints?.toSide).toBe('top');
    expect(endpoints?.to).toEqual({ x: 200, y: 300 });
  });

  it('★ 查表里没有分栏 → null（"端点取不到矩形就整条不画"这条纪律对两种端点一视同仁）', () => {
    const board = twoCards();
    board.columns = [columnAt('col', { x: 0, y: 300, width: 400, height: 200 })];
    board.edges = [createEdge({ cardId: 'a', side: 'bottom' }, { cardId: 'col', side: null })];

    // 只认卡片的查表：这正是绘制 / 命中 / 导出三处漏收分栏时的现场
    const cardsOnly: RectLookup = (id) =>
      id === 'a' ? { x: 0, y: 0, width: 200, height: 100 } : null;
    expect(edgeEndpoints(board.edges[0], cardsOnly)).toBeNull();
  });

  it('★ 折叠的分栏按**显示高度**取锚点（锚点要落在看得见的那条标题栏上）', () => {
    const board = twoCards();
    const collapsed = columnAt('col', { x: 0, y: 300, width: 400, height: 200, collapsed: true });
    board.columns = [collapsed];
    // 显示高度确实比模型里的 200 矮一大截，这个测试才有意义
    expect(columnDisplayHeight(collapsed)).toBeLessThan(200);
    // 钉住**下**边：上边中点两种算法是同一个点，只有下边能分辨出用的是哪个高度
    board.edges = [createEdge({ cardId: 'a', side: 'bottom' }, { cardId: 'col', side: 'bottom' })];

    const endpoints = edgeEndpoints(board.edges[0], lookupOf(board));
    // 拿模型里的 200 去算的话，锚点会掉到 y=500 —— 浮在一个看不见的空盒子下沿
    expect(endpoints?.to).toEqual({ x: 200, y: 300 + columnDisplayHeight(collapsed) });
  });
});

describe('removeEdges', () => {
  it('删掉存在的连线 → true', () => {
    const board = twoCards();
    const edge = createEdge({ cardId: 'a', side: null }, { cardId: 'b', side: null });
    addEdges(board, [edge]);
    expect(removeEdges(board, [edge.id])).toBe(true);
    expect(board.edges).toEqual([]);
  });

  it('id 不存在 / 空数组 → false（不产生"无变化的写入"）', () => {
    const board = twoCards();
    addEdges(board, [createEdge({ cardId: 'a', side: null }, { cardId: 'b', side: null })]);
    expect(removeEdges(board, ['nope'])).toBe(false);
    expect(removeEdges(board, [])).toBe(false);
    expect(board.edges).toHaveLength(1);
  });

  it('批量删除只命中给定 id', () => {
    const board = twoCards();
    const keep = createEdge({ cardId: 'a', side: 'right' }, { cardId: 'b', side: null });
    const drop = createEdge({ cardId: 'a', side: 'bottom' }, { cardId: 'b', side: null });
    addEdges(board, [keep, drop]);
    expect(removeEdges(board, [drop.id])).toBe(true);
    expect(board.edges.map((edge) => edge.id)).toEqual([keep.id]);
  });
});

describe('updateEdges', () => {
  it('改样式 → true 且字段真的变了', () => {
    const board = twoCards();
    const edge = createEdge({ cardId: 'a', side: null }, { cardId: 'b', side: null });
    addEdges(board, [edge]);
    expect(updateEdges(board, [edge.id], { style: 'dashed', color: '3' })).toBe(true);
    expect(board.edges[0]?.style).toBe('dashed');
    expect(board.edges[0]?.color).toBe('3');
  });

  it('★ 值没变 → false（否则每次点一下都会写一遍文件）', () => {
    const board = twoCards();
    const edge = createEdge({ cardId: 'a', side: null }, { cardId: 'b', side: null });
    addEdges(board, [edge]);
    expect(updateEdges(board, [edge.id], { style: edge.style })).toBe(false);
  });

  it('不存在的 id / 空 patch / 空 id 列表 → false', () => {
    const board = twoCards();
    const edge = createEdge({ cardId: 'a', side: null }, { cardId: 'b', side: null });
    addEdges(board, [edge]);
    expect(updateEdges(board, ['nope'], { style: 'dashed' })).toBe(false);
    expect(updateEdges(board, [edge.id], {})).toBe(false);
    expect(updateEdges(board, [], { style: 'dashed' })).toBe(false);
  });

  it('只改给定 id，其余连线一个字节都不动', () => {
    const board = twoCards();
    const first = createEdge({ cardId: 'a', side: 'right' }, { cardId: 'b', side: null });
    const second = createEdge({ cardId: 'a', side: 'bottom' }, { cardId: 'b', side: null });
    addEdges(board, [first, second]);
    updateEdges(board, [first.id], { label: '依赖' });
    // 未选中的那条仍是出厂值（`createEdge` 给的是空串，不是 undefined）
    expect(board.edges[1]?.label).toBe('');
  });
});

describe('edgeById / edgesOfCard', () => {
  it('按 id 取连线，取不到返回 null', () => {
    const board = twoCards();
    const edge = createEdge({ cardId: 'a', side: null }, { cardId: 'b', side: null });
    addEdges(board, [edge]);
    expect(edgeById(board, edge.id)?.id).toBe(edge.id);
    expect(edgeById(board, 'nope')).toBeNull();
  });

  it('命中卡片作为起点或终点的连线（供"删卡时清悬空边"这类逻辑用）', () => {
    const board = createBoardFile();
    board.cards = [
      createCard('note', { id: 'a' }),
      createCard('note', { id: 'b' }),
      createCard('note', { id: 'c' }),
    ];
    const ab = createEdge({ cardId: 'a', side: null }, { cardId: 'b', side: null });
    const ca = createEdge({ cardId: 'c', side: null }, { cardId: 'a', side: null });
    const bc = createEdge({ cardId: 'b', side: null }, { cardId: 'c', side: null });
    addEdges(board, [ab, ca, bc]);

    expect(
      edgesOfCard(board, 'a')
        .map((edge) => edge.id)
        .sort(),
    ).toEqual([ab.id, ca.id].sort());
    expect(edgesOfCard(board, 'b')).toHaveLength(2);
    expect(edgesOfCard(board, 'nobody')).toEqual([]);
  });
});

describe('锚点方位常量', () => {
  it('顺序固定，供 UI 复用（改动会静默影响锚点 DOM 的创建顺序）', () => {
    expect(ANCHOR_SIDES).toEqual<AnchorSide[]>(['top', 'right', 'bottom', 'left']);
  });
});

// ─────────────────────────────────────────────────────────────
// 端点是**转过的卡片**时的锚点（T7.06 / `F2-00-10`）
//
// 用户连的是"这张卡的上边"，卡片转头，那条边就跟着走 —— 于是锚点必须一起转。
// 不转的后果不是"线歪一点"，而是线**插进卡片里**或者浮在卡片外面：
// 一眼可见，但很难想到是"锚点没跟着转"。
// ─────────────────────────────────────────────────────────────

describe('cardAnchor · 跟着卡片旋转', () => {
  const rect: Rect = { x: 0, y: 0, width: 200, height: 100 };
  const center = { x: 100, y: 50 };

  it('不传角度 = 卡片自己的坐标系里的四边中点（与 T7.06 之前逐字段一致）', () => {
    expect(cardAnchor(rect, 'top')).toEqual({ x: 100, y: 0 });
    expect(cardAnchor(rect, 'right')).toEqual({ x: 200, y: 50 });
    expect(cardAnchor(rect, 'bottom')).toEqual({ x: 100, y: 100 });
    expect(cardAnchor(rect, 'left')).toEqual({ x: 0, y: 50 });
  });

  it('`deg = 0` 与不传角度是同一件事', () => {
    for (const side of ANCHOR_SIDES) {
      expect(cardAnchor(rect, side, 0)).toEqual(cardAnchor(rect, side));
    }
  });

  it('★ 转 90°："上边中点"落在视觉上的**右**边（那正是它的上边）', () => {
    const anchor = cardAnchor(rect, 'top', 90);
    expect(anchor.x).toBeCloseTo(150);
    expect(anchor.y).toBeCloseTo(50);
  });

  it('★ 转 180°：上边中点跑到原来下边中点的位置', () => {
    const anchor = cardAnchor(rect, 'top', 180);
    expect(anchor.x).toBeCloseTo(100);
    expect(anchor.y).toBeCloseTo(100);
  });

  it('旋转是刚体运动：四个锚点到中心的距离一个都不变', () => {
    for (const side of ANCHOR_SIDES) {
      const base = cardAnchor(rect, side);
      const turned = cardAnchor(rect, side, 37);
      expect(Math.hypot(turned.x - center.x, turned.y - center.y)).toBeCloseTo(
        Math.hypot(base.x - center.x, base.y - center.y),
      );
    }
  });
});

describe('edgeEndpoints · 端点是转过的卡片', () => {
  const width = 200;
  const height = 100;
  const lookup: RectLookup = (id) => (id === 'a' ? { x: 0, y: 0, width, height } : null);

  it('没给 `angleOf` 时一律按 0 算（老调用方、老测试不必改）', () => {
    const edge = createEdge(
      { cardId: 'a', side: 'right' },
      { cardId: '', side: null, point: { x: 900, y: 300 } },
    );

    const without = edgeEndpoints(edge, lookup);
    const zeroed = edgeEndpoints(edge, lookup, () => 0);

    expect(without).toEqual(zeroed);
    expect(without?.from).toEqual({ x: 200, y: 50 });
  });

  it('★ 卡片转了 90°：锚点跟着转（线才不会插进卡片里）', () => {
    const edge = createEdge(
      { cardId: 'a', side: 'right' },
      { cardId: '', side: null, point: { x: 900, y: 300 } },
    );

    const endpoints = edgeEndpoints(edge, lookup, () => 90);

    // (200, 50) 绕中心 (100, 50) 转 90° 顺时针 → (100, 150)
    expect(endpoints?.from.x).toBeCloseTo(100);
    expect(endpoints?.from.y).toBeCloseTo(150);
  });

  it('自由端不受角度影响：它就是一个点，没有"转一下"这回事', () => {
    const edge = createEdge(
      { cardId: 'a', side: 'top' },
      { cardId: '', side: null, point: { x: 900, y: 300 } },
    );

    expect(edgeEndpoints(edge, lookup, () => 90)?.to).toEqual({ x: 900, y: 300 });
  });

  it('`angleOf` 只按卡片 id 查：查不到（已删 / 不可见）当 0', () => {
    const edge = createEdge({ cardId: 'a', side: 'right' }, { cardId: 'ghost', side: 'left' });

    // `ghost` 查不到矩形 → 整条线算不出来（与 T7.06 之前一致），不该因为角度而崩
    expect(edgeEndpoints(edge, lookup, (id) => (id === 'ghost' ? 90 : 0))).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 曲线弧度（T7.12 / `F3-07`）
//
// 一条"弯的线"在数据里只是两个按弦长归一化的数。这里钉三件事：
//  * `normalizeEdgeCurve` 是读盘与写入**共用的同一份判据**（0 = 没有弧度）；
//  * "拖手柄"与"算控制点"互为反函数 —— 不一致的话手柄会与线错开一半距离；
//  * **看着直 = 真的没有弧度**（死区），否则笔直的线上会永远挂着一个拖不掉的弯。
// ─────────────────────────────────────────────────────────────────────────────

describe('normalizeEdgeCurve', () => {
  it('读不懂的一律当"没有弧度"', () => {
    const invalid: unknown[] = [
      undefined,
      null,
      0,
      1,
      'x',
      true,
      [],
      {},
      { along: 0 },
      { perp: 0.5 },
      { along: 0, perp: 'a' },
      { along: NaN, perp: 1 },
      { along: Infinity, perp: 1 },
      { along: 0, perp: -Infinity },
    ];
    for (const value of invalid) {
      expect(normalizeEdgeCurve(value)).toBeNull();
    }
  });

  it('两个分量都是 0 → null（直线就是"没有弧度"，不写一个全是 0 的键）', () => {
    expect(normalizeEdgeCurve({ along: 0, perp: 0 })).toBeNull();
    expect(normalizeEdgeCurve({ along: -0, perp: 0 })).toBeNull();
  });

  it('只有一个分量为 0 时保留（只沿方向弯照样是弯的）', () => {
    expect(normalizeEdgeCurve({ along: 0, perp: 0.5 })).toEqual({ along: 0, perp: 0.5 });
    expect(normalizeEdgeCurve({ along: 0.5, perp: 0 })).toEqual({ along: 0.5, perp: 0 });
  });

  it('落盘精度 4 位小数（拖动产生的浮点噪声不写进文件）', () => {
    expect(normalizeEdgeCurve({ along: 0.123456, perp: -0.987654 })).toEqual({
      along: 0.1235,
      perp: -0.9877,
    });
  });

  it('超出上限被夹住（手改文件写 1e9 不至于让控制点飞到天外）', () => {
    expect(normalizeEdgeCurve({ along: 1e9, perp: -1e9 })).toEqual({
      along: EDGE_CURVE_LIMIT,
      perp: -EDGE_CURVE_LIMIT,
    });
  });

  it('取整到 0 的负数不留 `-0`（`-0 !== 0`，会让"有没有变"的判等失效）', () => {
    const curve = normalizeEdgeCurve({ along: -0.00001, perp: 0.5 });
    expect(curve).not.toBeNull();
    expect(Object.is(curve!.along, 0)).toBe(true);
  });

  it('多余字段被丢掉（只留两个分量）', () => {
    expect(normalizeEdgeCurve({ along: 0.5, perp: 0.25, x: 999 })).toEqual({
      along: 0.5,
      perp: 0.25,
    });
  });
});

describe('curveControl / edgePathPoints', () => {
  const from = { x: 0, y: 0 };
  const to = { x: 100, y: 0 };

  it('没有弧度 / 两端重合 → 没有控制点', () => {
    expect(curveControl(from, to, null)).toBeNull();
    expect(curveControl(from, to, undefined)).toBeNull();
    expect(curveControl(from, from, { along: 0, perp: 1 })).toBeNull();
  });

  it('`perp` 正数往"方向向量左转 90°"那一侧弯：向右的线往下弯', () => {
    expect(curveControl(from, to, { along: 0, perp: 1 })).toEqual({ x: 50, y: 100 });
  });

  it('`perp` 取负往另一侧', () => {
    expect(curveControl(from, to, { along: 0, perp: -1 })).toEqual({ x: 50, y: -100 });
  });

  it('`along` 是"沿方向推进"，与 `perp` 正交叠加', () => {
    expect(curveControl(from, to, { along: 0.5, perp: 0 })).toEqual({ x: 100, y: 0 });
    expect(curveControl(from, to, { along: 0.5, perp: 0.5 })).toEqual({ x: 100, y: 50 });
  });

  it('`edgePathPoints`：直线是折线（2 点）、有弧度是弧线（起点 / 控制点 / 终点）', () => {
    expect(edgePathPoints(from, to, null)).toEqual({ kind: 'polyline', points: [from, to] });
    expect(edgePathPoints(from, to, { along: 0, perp: 1 })).toEqual({
      kind: 'curve',
      points: [from, { x: 50, y: 100 }, to],
    });
  });

  it('★ 形状由 `kind` 说清楚，不按点数猜：3 个点的折线不能被当成弧线', () => {
    // 这正是 T7.11 的正交走线 —— 拐一个弯恰好也是 3 个点。按"点数 == 3 就是弧线"
    // 去猜的话，L 形的 Smart 线会被画成一段圆弧，命中 / 标签落点跟着全错
    const elbow = polylinePath([from, { x: 50, y: 100 }, to]);
    expect(elbow.kind).toBe('polyline');
    // 两段等长 → 折线中点正好落在拐角上；当成弧线算会得到 (50, 50)，
    // 那是两条边之间的空处 —— 标签会静静飘到线外
    expect(edgePathMidpoint(elbow)).toEqual({ x: 50, y: 100 });
  });
});

describe('quadraticAt', () => {
  const p0 = { x: 0, y: 0 };
  const control = { x: 50, y: 100 };
  const p2 = { x: 100, y: 0 };

  it('两端就是起点与终点', () => {
    expect(quadraticAt(p0, control, p2, 0)).toEqual(p0);
    expect(quadraticAt(p0, control, p2, 1)).toEqual(p2);
  });

  it('`t = 0.5` 是 `(P0 + 2C + P2) / 4` —— 控制点推出去的距离要"减半"才落在线上', () => {
    expect(quadraticAt(p0, control, p2, 0.5)).toEqual({ x: 50, y: 50 });
  });
});

describe('curveFromMidpoint / pathMidpoint · 手柄与曲线必须指同一个点', () => {
  const from = { x: 0, y: 0 };
  const to = { x: 100, y: 0 };

  it('直线：中点就是弦中点', () => {
    expect(pathMidpoint([from, to])).toEqual({ x: 50, y: 0 });
  });

  it('★ 往返：把中点拖到哪，反算出的弧度就把中点送到哪', () => {
    const target = { x: 50, y: 100 };
    const curve = curveFromMidpoint(from, to, target);
    expect(curve).toEqual({ along: 0, perp: 2 });
    expect(edgePathMidpoint(edgePathPoints(from, to, curve))).toEqual(target);
  });

  it('斜线也一样（不是只在水平线上凑巧对）', () => {
    const a = { x: 10, y: 20 };
    const b = { x: 110, y: 120 };
    const curve = { along: 0.3, perp: -0.4 };
    const mid = edgePathMidpoint(edgePathPoints(a, b, curve));
    const back = curveFromMidpoint(a, b, mid);
    expect(back).not.toBeNull();
    expect(back!.along).toBeCloseTo(curve.along, 3);
    expect(back!.perp).toBeCloseTo(curve.perp, 3);
  });

  it('★ 拖回弦上 → null（拉直），而不是留下一个拖不动的小弯', () => {
    // 弦中点附近（2px 死区之内）
    expect(curveFromMidpoint(from, to, { x: 50, y: 0 })).toBeNull();
    expect(curveFromMidpoint(from, to, { x: 50, y: 1.5 })).toBeNull();
    // 沿弦滑到别处：控制点落在弦上，画出来仍是一条直线 → 一样算拉直
    expect(curveFromMidpoint(from, to, { x: 20, y: 0 })).toBeNull();
    expect(curveFromMidpoint(from, to, { x: 150, y: 0 })).toBeNull();
  });

  it('死区之外就该留下弧度（差 0.1px 也是弯的，不能一刀切）', () => {
    const curve = curveFromMidpoint(from, to, { x: 50, y: 2.1 });
    expect(curve).not.toBeNull();
    expect(curve!.perp).toBeCloseTo(0.042, 3);
  });

  it('两端重合 → null（没有"垂线"可言）', () => {
    expect(curveFromMidpoint(from, from, { x: 5, y: 5 })).toBeNull();
  });

  it('拖动超过上限时被夹住（不会写出一个 1e9 的弧度）', () => {
    const curve = curveFromMidpoint(from, to, { x: 50, y: 100000 });
    expect(curve).not.toBeNull();
    expect(curve!.perp).toBe(EDGE_CURVE_LIMIT);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Smart 走线与路径装饰（T7.11 / `F3-03`）
//
// "一条线画在哪"必须只有一份答案：画布、命中、框选、PNG / SVG / 缩略图导出
// 全部走 `edgePolyline`。这里钉的是这份答案的**取点**与**端点切线**。
// ─────────────────────────────────────────────────────────────────────────────

/** 线段是否穿过矩形**内部**（与实现同构：贴着边界不算穿过） */
function crossesInterior(a: Point, b: Point, rect: Rect): boolean {
  const minX = Math.min(a.x, b.x);
  const maxX = Math.max(a.x, b.x);
  const minY = Math.min(a.y, b.y);
  const maxY = Math.max(a.y, b.y);
  return (
    maxX > rect.x && minX < rect.x + rect.width && maxY > rect.y && minY < rect.y + rect.height
  );
}

/** 两块卡片 + 中间横着一张挡路的卡（Smart 走线的典型场景） */
function boardWithBlocker(): BoardFile {
  const board = createBoardFile();
  board.cards = [
    createCard('note', { id: 'a', x: 0, y: 0, width: 200, height: 100 }),
    createCard('note', { id: 'b', x: 500, y: 0, width: 200, height: 100 }),
    createCard('note', { id: 'c', x: 300, y: 0, width: 100, height: 100 }),
  ];
  board.edges = [
    createEdge({ cardId: 'a', side: 'right' }, { cardId: 'b', side: 'left' }, { routing: 'smart' }),
  ];
  return board;
}

describe('polylineMidpoint', () => {
  it('折线上按**长度**走到一半（而不是拿前三个点当曲线算）', () => {
    expect(
      polylineMidpoint([
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 100 },
      ]),
    ).toEqual({ x: 100, y: 0 });
  });

  it('两段不等长时落在长的那一段里', () => {
    expect(
      polylineMidpoint([
        { x: 0, y: 0 },
        { x: 20, y: 0 },
        { x: 100, y: 0 },
      ]),
    ).toEqual({ x: 50, y: 0 });
  });

  it('两点折线 = 弦中点（与 `pathMidpoint` 一致）', () => {
    expect(
      polylineMidpoint([
        { x: 0, y: 0 },
        { x: 100, y: 50 },
      ]),
    ).toEqual({ x: 50, y: 25 });
  });

  it('退化输入不炸：空数组 / 单点', () => {
    expect(polylineMidpoint([{ x: 3, y: 4 }])).toEqual({ x: 3, y: 4 });
    expect(polylineMidpoint([])).toEqual({ x: 0, y: 0 });
  });
});

describe('pointEdgeDistance / pathBounds · 走的是弧线而不是弦', () => {
  const from = { x: 0, y: 0 };
  const to = { x: 100, y: 0 };
  // 控制点 (50,100) → 曲线在 t = 0.5 处过 (50,50)
  const path = edgePathPoints(from, to, { along: 0, perp: 1 });

  it('曲线中点（`t = 0.5`）到线的距离为 0', () => {
    expect(pointEdgeDistance({ x: 50, y: 50 }, path)).toBeCloseTo(0, 6);
  });

  it('★ 弦的中点不在线上：按直线算命中会"点在空处却选中了线"', () => {
    expect(pointEdgeDistance({ x: 50, y: 0 }, path)).toBeGreaterThan(40);
  });

  it('包围盒把控制点也框进去（脏区裁剪漏了会留下一条没擦掉的线）', () => {
    expect(pathBounds(path)).toEqual({ x: 0, y: 0, width: 100, height: 100 });
  });

  it('框选：矩形压在弧上算相交，压在弦上不算', () => {
    expect(edgeIntersectsRect(path, { x: 45, y: 45, width: 10, height: 10 })).toBe(true);
    expect(edgeIntersectsRect(path, { x: 45, y: -5, width: 10, height: 10 })).toBe(false);
  });
});

describe('directionOf / polylineLength', () => {
  it('单位方向', () => {
    expect(directionOf({ x: 0, y: 0 }, { x: 3, y: 4 })).toEqual({ x: 0.6, y: 0.8 });
  });

  it('两端重合时退化成 (1,0)：不能返回 NaN（NaN 会一路污染箭头与收缩）', () => {
    expect(directionOf({ x: 7, y: 7 }, { x: 7, y: 7 })).toEqual({ x: 1, y: 0 });
  });

  it('折线长度是各段之和（零长段不增不减）', () => {
    expect(
      polylineLength([
        { x: 0, y: 0 },
        { x: 3, y: 4 },
        { x: 3, y: 4 },
        { x: 3, y: 14 },
      ]),
    ).toBe(15);
  });
});

describe('polylineEndDirections / shrinkPolylineEnd', () => {
  const straight: Point[] = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
  ];

  it('两端切线都指向路径内部（收缩与箭头都靠它）', () => {
    expect(polylineEndDirections(straight)).toEqual({
      from: { x: 1, y: 0 },
      to: { x: -1, y: 0 },
    });
  });

  it('★ 弧线的端点切线不是"连到另一端的方向"（否则箭头会歪着插进线里）', () => {
    const path = edgePathPoints({ x: 0, y: 0 }, { x: 100, y: 0 }, { along: 0, perp: 1 });
    const dirs = polylineEndDirections(path.points);
    const norm = Math.hypot(50, 100);
    expect(dirs.from.x).toBeCloseTo(50 / norm, 6);
    expect(dirs.from.y).toBeCloseTo(100 / norm, 6);
    expect(dirs.to.x).toBeCloseTo(-50 / norm, 6);
    expect(dirs.to.y).toBeCloseTo(100 / norm, 6);
    // 若按弦算，`from` 会是 (1,0) —— 一眼就能看出差别
    expect(dirs.from.x).not.toBeCloseTo(1, 3);
  });

  it('收缩只动指定的一端，且返回新数组（调用方那份还要用来摆箭头）', () => {
    // ★ 两端都是**朝里收**（`direction` 指路径内部）：`to` 端从 100 收到 91，
    //   符号写反的话会变成 109 —— 线的末端从箭头底下伸出去一小截
    const to = shrinkPolylineEnd(straight, 'to', 9, { x: -1, y: 0 });
    expect(to).toEqual([
      { x: 0, y: 0 },
      { x: 91, y: 0 },
    ]);
    expect(straight[1]).toEqual({ x: 100, y: 0 });

    const from = shrinkPolylineEnd(straight, 'from', 9, { x: 1, y: 0 });
    expect(from).toEqual([
      { x: 9, y: 0 },
      { x: 100, y: 0 },
    ]);
  });

  it('★ 喂进真实切线方向时两端都变**短**（收缩不是"往外伸"）', () => {
    const dirs = polylineEndDirections(straight);
    const shrunk = shrinkPolylineEnd(
      shrinkPolylineEnd(straight, 'from', 9, dirs.from),
      'to',
      9,
      dirs.to,
    );
    expect(polylineLength(shrunk)).toBeLessThan(polylineLength(straight));
    expect(shrunk).toEqual([
      { x: 9, y: 0 },
      { x: 91, y: 0 },
    ]);
  });
});

/**
 * 端点重拖（`2.2.0` · O1）。
 *
 * ★ 合法性规则必须与 `addEdges` **同一套**：改端点这条路比"拉新线"宽一点的话，
 *   用户就能用重拖做出拉不出来的线（两条一模一样的线、自环、指向虚空）——
 *   这些缺陷在界面上都表现为"线不对劲"，而很难反推到是哪一步允许的。
 */
describe('setEdgeEndpoint · 改连线端点（2.2.0 · O1）', () => {
  function boardWithEdge(): BoardFile {
    const board = createBoardFile();
    board.cards = [createCard('note', { id: 'a' }), createCard('note', { id: 'b' })];
    board.edges = [createEdge({ cardId: 'a', side: null }, { cardId: 'b', side: null })];
    return board;
  }

  it('★ 把一端改到另一个对象上（并自动选边：`side: null`）', () => {
    const board = boardWithEdge();
    board.cards.push(createCard('note', { id: 'c' }));

    expect(setEdgeEndpoint(board, board.edges[0].id, 'to', { key: 'c', side: null })).toBe(true);
    expect(board.edges[0].to).toEqual({ cardId: 'c', side: null });
  });

  it('★ 改到**脑图节点**上：`cardId` 是脑图、`nodeId` 是那个节点', () => {
    const board = boardWithEdge();
    const mind = { ...createMind(), id: 'nm1' };
    board.minds = [mind];

    expect(
      setEdgeEndpoint(board, board.edges[0].id, 'to', { key: 'nm1', side: null, nodeId: 'n_a' }),
    ).toBe(true);
    expect(board.edges[0].to).toEqual({ cardId: 'nm1', side: null, nodeId: 'n_a' });
  });

  it('★ 改成**自由端**：端点留在松手的地方', () => {
    const board = boardWithEdge();
    expect(
      setEdgeEndpoint(board, board.edges[0].id, 'to', { key: null, point: { x: 120, y: 40 } }),
    ).toBe(true);
    expect(board.edges[0].to).toEqual({ cardId: '', side: null, point: { x: 120, y: 40 } });
  });

  it('★ 自环、指向不存在的对象、完全重复：都返回 `false` 且一个字节不动', () => {
    const board = boardWithEdge();
    const edge = board.edges[0];

    // 自环：把 `to` 改到 `from` 那同一个对象上
    expect(setEdgeEndpoint(board, edge.id, 'to', { key: 'a', side: null })).toBe(false);
    // 指向不存在的对象
    expect(setEdgeEndpoint(board, edge.id, 'to', { key: 'c_没有', side: null })).toBe(false);
    // 与已有连线完全重复
    board.cards.push(createCard('note', { id: 'c' }));
    board.edges.push(createEdge({ cardId: 'a', side: null }, { cardId: 'c', side: null }));
    expect(setEdgeEndpoint(board, edge.id, 'to', { key: 'c', side: null })).toBe(false);

    expect(edge.to).toEqual({ cardId: 'b', side: null });
    expect(board.edges).toHaveLength(2);
  });

  it('没变化（拖回原处）⇒ `false`，不产生历史', () => {
    const board = boardWithEdge();
    expect(setEdgeEndpoint(board, board.edges[0].id, 'to', { key: 'b', side: null })).toBe(false);
  });
});

describe('obstacleRects', () => {
  const lookup: RectLookup = (cardId) => (cardId === 'a' ? RECT : null);

  it('查不到的卡片跳过（悬空引用当"不存在"，而不是当一块占满世界的障碍）', () => {
    expect(obstacleRects(['a', 'ghost', 'a'], lookup)).toEqual([RECT, RECT]);
  });

  it('空表 → 空数组', () => {
    expect(obstacleRects([], lookup)).toEqual([]);
  });
});

describe('edgePolyline · 绘制 / 命中 / 导出共用的那条路径', () => {
  it('Free 直线：折线两个点', () => {
    const board = twoCards();
    const edge = createEdge({ cardId: 'a', side: 'right' }, { cardId: 'b', side: 'left' });
    board.edges = [edge];

    expect(edgePolyline(edge, { rectOf: lookupOf(board) })).toEqual({
      kind: 'polyline',
      points: [
        { x: 200, y: 50 },
        { x: 500, y: 50 },
      ],
    });
  });

  it('Free 弧线：`kind` 是 curve，点是 起点 / 控制点 / 终点', () => {
    const board = twoCards();
    const edge = createEdge(
      { cardId: 'a', side: 'right' },
      { cardId: 'b', side: 'left' },
      { curve: { along: 0, perp: 0.2 } },
    );
    board.edges = [edge];

    const path = edgePolyline(edge, { rectOf: lookupOf(board) });
    expect(path).not.toBeNull();
    expect(path!.kind).toBe('curve');
    expect(path!.points).toHaveLength(3);
    expect(path!.points[0]).toEqual({ x: 200, y: 50 });
    expect(path!.points[2]).toEqual({ x: 500, y: 50 });
    // 弦长 300 × perp 0.2 = 60px
    expect(path!.points[1].y).toBeCloseTo(110, 6);
  });

  it('端点卡片查不到 → null（调用方跳过这一条，而不是画半截线）', () => {
    const edge = createEdge({ cardId: 'ghost', side: 'right' }, { cardId: 'b', side: 'left' });
    expect(edgePolyline(edge, { rectOf: () => null })).toBeNull();
  });

  it('★ Smart：绕过挡在中间的卡片，全程横平竖直', () => {
    const board = boardWithBlocker();
    const edge = board.edges[0];
    const rectOf = lookupOf(board);
    const path = edgePolyline(edge, {
      rectOf,
      obstacles: obstacleRects(['a', 'b', 'c'], rectOf),
    });

    expect(path).not.toBeNull();
    // ★ 走线必须是折线：它只拐一个弯时也恰好是 3 个点，按"点数 == 3"判会被画成圆弧
    expect(path!.kind).toBe('polyline');
    const points = path!.points;
    expect(points.length).toBeGreaterThan(2);
    expect(points[0]).toEqual({ x: 200, y: 50 });
    expect(points[points.length - 1]).toEqual({ x: 500, y: 50 });

    const blocker: Rect = { x: 300, y: 0, width: 100, height: 100 };
    for (let index = 1; index < points.length; index++) {
      const a = points[index - 1];
      const b = points[index];
      expect(a.x === b.x || a.y === b.y).toBe(true);
      expect(crossesInterior(a, b, blocker)).toBe(false);
    }
  });

  it('Smart 搜不到时退回直线（宁可画一条穿卡的线，也不要线不见了）', () => {
    const point = { x: 40, y: 40 };
    const edge = createEdge(
      { cardId: '', side: null, point },
      { cardId: '', side: null, point },
      { routing: 'smart' },
    );
    expect(edgePolyline(edge, { rectOf: () => null })).toEqual({
      kind: 'polyline',
      points: [point, point],
    });
  });
});

describe('hitTestEdge · Smart 线按绕行后的路径命中', () => {
  it('点在绕行后的线上选中；点在"原来的直线"上不选中', () => {
    const board = boardWithBlocker();
    const edge = board.edges[0];
    const rectOf = lookupOf(board);
    const obstacles = obstacleRects(['a', 'b', 'c'], rectOf);
    const path = edgePolyline(edge, { rectOf, obstacles });
    expect(path).not.toBeNull();

    const onPath = polylineMidpoint(path!.points);
    expect(hitTestEdge(board.edges, rectOf, onPath, 1, { obstacles })?.id).toBe(edge.id);
    // 弦中点正落在被绕开的那张卡里 —— 那里现在没有线
    expect(hitTestEdge(board.edges, rectOf, { x: 350, y: 50 }, 5, { obstacles })).toBeNull();
    // 不喂障碍表时路由退化成直线（这正是"看着绕开了、点下去选的是直线"的来源：
    // 绘制与命中必须喂同一份 obstacles）
    expect(hitTestEdge(board.edges, rectOf, { x: 350, y: 50 }, 5)?.id).toBe(edge.id);
  });
});

describe('updateEdges · 弧度与标签的落盘语义', () => {
  function oneEdge(overrides: Parameters<typeof createEdge>[2] = {}): BoardFile {
    const board = twoCards();
    board.edges = [
      createEdge({ cardId: 'a', side: 'right' }, { cardId: 'b', side: 'left' }, overrides),
    ];
    return board;
  }

  it('写弧度', () => {
    const board = oneEdge();
    const id = board.edges[0].id;
    expect(updateEdges(board, [id], { curve: { along: 0, perp: 0.5 } })).toBe(true);
    expect(board.edges[0].curve).toEqual({ along: 0, perp: 0.5 });
  });

  it('★ 拉直（`curve: null`）是**删键**，不是写一个 null', () => {
    const board = oneEdge({ curve: { along: 0, perp: 0.5 } });
    const id = board.edges[0].id;
    expect(updateEdges(board, [id], { curve: null })).toBe(true);
    expect('curve' in board.edges[0]).toBe(false);
    expect(JSON.stringify(board.edges[0])).not.toContain('curve');
  });

  it('本来就是直线时"拉直"不算变化（不产生一次空写入 / 空撤销）', () => {
    const board = oneEdge();
    expect(updateEdges(board, [board.edges[0].id], { curve: null })).toBe(false);
  });

  it('标签：空串是"没有标签"，但它是**存在的值**，要能落盘（与弧度的删键语义不同）', () => {
    const board = oneEdge({ label: '依赖' });
    const id = board.edges[0].id;
    expect(updateEdges(board, [id], { label: '' })).toBe(true);
    expect(board.edges[0].label).toBe('');
    expect('label' in board.edges[0]).toBe(true);
  });
});
