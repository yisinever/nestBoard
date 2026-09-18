/**
 * 手绘卡单元测试（T3.08 / T3.09 / `F4-04`、`F4-05`）—— **一笔 = 一张可编辑矢量卡**。
 *
 * 真机上要验的是手感（跟手、不闪、橡皮准），这里钉的是**能自证的不变量**：
 *   1. **卡片框 = 笔迹包围盒，且落盘时与渲染时算的是同一个框** ——
 *      这是"刚画完的那一笔"与"落盘后的卡片"逐像素重合的唯一依据
 *      （手绘卡是一次性交接：同一帧里笔迹换成卡片，差一个像素就是一次抖动）；
 *   2. **点存卡片内坐标**：偏移只减一次、精度只留 2 位、压感原样带过；
 *   3. **命中换算**：橡皮按世界坐标判定，卡片被拉大后（笔迹跟着放大）仍要擦得中；
 *   4. **改色无变化返回 `null`**：否则撤销栈里会堆一串"什么都没变"；
 *   5. **渲染把框拉满**：`viewBox` = 内容框、`preserveAspectRatio="none"`、
 *      命中区比可见笔迹粗（可见粗细是用户画出来的，不能为了好点就改）；
 *   6. **标注归属是算出来的**（T3.09）：落笔点在谁的框里就归谁，层级最高者胜出；
 *      把标注拖走就自然解除 —— 没有第二个需要同步的字段。
 */

import { describe, expect, it } from 'vitest';
import type { App, Component } from 'obsidian';
import {
  INK_HIT_CLASS,
  INK_SLOT_CLASS,
  INK_SVG_CLASS,
  annotationsOn,
  inkAnchorOf,
  inkCard,
  inkCardFromStroke,
  inkCardStrokeHits,
  inkContentBox,
  inkHostCard,
  localizePath,
  recolorPaths,
  strokeHitShape,
  strokeShapes,
  svgPathData,
} from '../../cards/ink';
import type { CardRenderContext } from '../../cards/registry';
import { createCard } from '../../model/factories';
import type { Card, CardOf, HexColor, InkPath } from '../../model/schema';
import { createFakeDocument, createFakeElement, type FakeElement } from '../helpers/fakeDom';

const RED: HexColor = '#e03131';
const BLUE: HexColor = '#1971c2';

/** 造一笔。坐标是 `[x, y]` 或 `[x, y, pressure]` */
function stroke(
  points: Array<[number, number] | [number, number, number]>,
  width = 4,
  color: HexColor = RED,
): InkPath {
  return { color, width, points: points.map((point) => [...point]) };
}

/** 造一张手绘卡（走真实入口，保证框与内容同源） */
function cardFrom(path: InkPath): CardOf<'ink'> {
  const card = inkCardFromStroke(path);
  if (!card) throw new Error('测试夹具：这一笔不该落盘失败');
  return card;
}

// ── 拆图元 ──────────────────────────────────────────────────

describe('strokeShapes / strokeHitShape', () => {
  it('单点退化成圆点，半径与 Canvas 侧同源（`max(线宽, 0.5) / 2`）', () => {
    expect(strokeShapes(stroke([[10, 20]], 4))).toEqual([{ kind: 'dot', x: 10, y: 20, radius: 2 }]);
    // 线宽 0 也要看得见：半径取 0.25（0.5 / 2），而不是一个画不出来的 0
    expect(strokeShapes(stroke([[1, 2]], 0))).toEqual([{ kind: 'dot', x: 1, y: 2, radius: 0.25 }]);
  });

  it('鼠标笔迹（无压感）只出一条折线：一次描边，不做无谓的拆段', () => {
    const shapes = strokeShapes(
      stroke(
        [
          [0, 0],
          [10, 0],
          [10, 10],
        ],
        4,
      ),
    );
    expect(shapes).toEqual([{ kind: 'curve', d: 'M0 0 L10 0 L10 10', width: 4 }]);
  });

  it('压感笔迹逐段出折线（SVG 的 stroke-width 是整条路径一个值，只能拆）', () => {
    const shapes = strokeShapes(
      stroke(
        [
          [0, 0, 0.2],
          [10, 0, 0.9],
          [10, 10, 0.5],
        ],
        4,
      ),
    );
    expect(shapes).toHaveLength(2);
    expect(shapes.every((shape) => shape.kind === 'curve')).toBe(true);
    expect((shapes[0] as { d: string }).d).toBe('M0 0 L10 0');
    expect((shapes[1] as { d: string }).d).toBe('M10 0 L10 10');
  });

  it('空笔迹不出图元（`beginStroke` 的兜底路径不该画出任何东西）', () => {
    expect(strokeShapes(stroke([]))).toEqual([]);
  });

  it('命中区永远是一条折线，且一定比可见笔迹粗', () => {
    // 细线：加 8 不够，抬到 16 的保底
    expect(
      strokeHitShape(
        stroke(
          [
            [0, 0],
            [10, 0],
          ],
          4,
        ),
      ),
    ).toEqual({
      kind: 'curve',
      d: 'M0 0 L10 0',
      width: 16,
    });
    // 粗线：保底不再生效，但仍在可见宽度之上
    expect(
      strokeHitShape(
        stroke(
          [
            [0, 0],
            [10, 0],
          ],
          20,
        ),
      ).width,
    ).toBe(28);
    // 单点也走折线（`M x y` + 圆头 = 一个圆点），可见笔画与命中区因此能共用同一套取整
    expect(strokeHitShape(stroke([[3, 4]], 4))).toEqual({ kind: 'curve', d: 'M3 4', width: 16 });
  });

  it('坐标保留 2 位小数：文件里的点本来就只有这个精度', () => {
    expect(svgPathData([[0.123456, 1.987654]])).toBe('M0.12 1.99');
  });
});

// ── 内容框 ──────────────────────────────────────────────────

describe('inkContentBox', () => {
  it('没有笔迹返回 null（"这张卡里没有内容"的唯一判据）', () => {
    expect(inkContentBox([])).toBeNull();
    expect(inkContentBox([stroke([])])).toBeNull();
  });

  it('包围盒居中撑到最小边长：一个 4px 的点也能点中、拖得动', () => {
    // 点 (0,0) 半径 2 → 包围盒 [-2,-2,4,4] → 撑到 16 并把差值一分为二
    expect(inkContentBox([stroke([[0, 0]], 4)])).toEqual({ x: -8, y: -8, width: 16, height: 16 });
  });

  it('只有某一边不够长时只撑那一边：扁笔迹不会被撑成正方形', () => {
    // 点集 x∈[0,100]、y=0，线宽 4 → [-2,-2,104,4] → 只把高撑到 16（上下各加 6）
    expect(
      inkContentBox([
        stroke(
          [
            [0, 0],
            [100, 0],
          ],
          4,
        ),
      ]),
    ).toEqual({
      x: -2,
      y: -8,
      width: 104,
      height: 16,
    });
  });
});

// ── 落盘 ────────────────────────────────────────────────────

describe('localizePath / inkCardFromStroke', () => {
  it('点减原点、保留 2 位小数、压感原样带过', () => {
    const local = localizePath(stroke([[10.123456, 20, 0.5]], 4), { x: 10, y: 20 });
    expect(local.points).toEqual([[0.12, 0, 0.5]]);
    // 颜色与线宽是这张卡的属性，不随坐标一起变
    expect(local.color).toBe(RED);
    expect(local.width).toBe(4);
  });

  it('空笔迹不落盘（不生成一张看不见的空卡）', () => {
    expect(inkCardFromStroke(stroke([]))).toBeNull();
  });

  it('★ 卡片框 == 落盘时的内容框，且与渲染时的内容框**同尺寸**', () => {
    const card = cardFrom(
      stroke(
        [
          [0, 0],
          [100, 0],
        ],
        4,
      ),
    );

    // 落盘：框就是内容框（局部坐标下的框再减原点即回到 0,0 附近）
    expect({ x: card.x, y: card.y, width: card.width, height: card.height }).toEqual({
      x: -2,
      y: -8,
      width: 104,
      height: 16,
    });

    // 渲染：内容框（卡片内坐标）必须与卡片框**一样大**，否则 viewBox 会缩放笔迹，
    // "刚画完的那一笔"与"落盘后的卡片"就不再逐像素重合（会看到一次微小的跳动）
    const renderBox = inkContentBox(card.content.paths);
    expect(renderBox).not.toBeNull();
    expect(renderBox?.width).toBe(card.width);
    expect(renderBox?.height).toBe(card.height);
  });

  it('内容点全部落在渲染时的内容框内（框真的框得住笔迹）', () => {
    const card = cardFrom(
      stroke(
        [
          [0, 0],
          [100, 0],
        ],
        4,
      ),
    );
    const box = inkContentBox(card.content.paths);
    if (!box) throw new Error('测试夹具：内容框不该为空');
    for (const path of card.content.paths) {
      for (const [x, y] of path.points) {
        expect(x).toBeGreaterThanOrEqual(box.x);
        expect(x).toBeLessThanOrEqual(box.x + box.width);
        expect(y).toBeGreaterThanOrEqual(box.y);
        expect(y).toBeLessThanOrEqual(box.y + box.height);
      }
    }
  });
});

describe('recolorPaths', () => {
  it('没有变化返回 null：反复点同一个颜色不该在撤销栈里堆"什么都没变"', () => {
    expect(
      recolorPaths(
        [
          stroke(
            [
              [0, 0],
              [1, 1],
            ],
            4,
            RED,
          ),
        ],
        RED,
      ),
    ).toBeNull();
  });

  it('没有笔迹返回 null（没什么可改的）', () => {
    expect(recolorPaths([], RED)).toBeNull();
  });

  it('改色只动颜色：点、线宽一个都不碰', () => {
    const paths = [
      stroke(
        [
          [0, 0],
          [1, 1],
        ],
        4,
        RED,
      ),
      stroke([[2, 2]], 6, RED),
    ];
    const recolored = recolorPaths(paths, BLUE);
    expect(recolored?.map((path) => path.color)).toEqual([BLUE, BLUE]);
    expect(recolored?.[0].points).toEqual(paths[0].points);
    expect(recolored?.[1].width).toBe(6);
  });
});

// ── 橡皮命中 ────────────────────────────────────────────────

describe('inkCardStrokeHits', () => {
  it('擦到线上就命中，离得远就不命中', () => {
    const card = cardFrom(
      stroke(
        [
          [0, 0],
          [100, 0],
        ],
        4,
      ),
    );
    // 世界坐标下这一笔就在 y=0、x∈[0,100]（卡片框的偏移是"笔宽一半 + 最小高度"撑出来的，
    // 撑出来的部分不改笔迹位置，见 `cards/ink.ts` 的 `INK_MIN_BOX` 说明）
    expect(inkCardStrokeHits(card, { x: 50, y: 0 }, 0)).toEqual([0]);
    // 垂直方向差 3px，笔宽只有 4（半宽 2）→ 擦不到
    expect(inkCardStrokeHits(card, { x: 50, y: 3 }, 0)).toEqual([]);
  });

  it('框外一点点仍会按半径命中（包围盒预筛是外扩过的，不是硬边界）', () => {
    const card = cardFrom(
      stroke(
        [
          [0, 0],
          [100, 0],
        ],
        4,
      ),
    );
    // 端点外侧 3px：笔的半宽 2 + 橡皮半径 2 = 4 ≥ 3
    expect(inkCardStrokeHits(card, { x: 103, y: 0 }, 2)).toEqual([0]);
  });

  it('远离卡片的点直接返回空（预筛挡住"把远处坐标换算成假坐标再误擦"）', () => {
    const card = cardFrom(
      stroke(
        [
          [0, 0],
          [100, 0],
        ],
        4,
      ),
    );
    expect(inkCardStrokeHits(card, { x: 1000, y: 1000 }, 4)).toEqual([]);
  });

  it('★ 卡片被拉大后笔迹跟着放大，命中点也要跟着走', () => {
    const card = cardFrom(
      stroke(
        [
          [0, 0],
          [100, 0],
        ],
        4,
      ),
    );
    // 原始大小下，右边 250px 处远在框外
    expect(inkCardStrokeHits(card, { x: 250, y: 0 }, 0)).toEqual([]);

    // 把卡片横向拉大 3 倍：笔迹跟着放大，世界跨度从 x∈[0,100] 变成 x∈[4,304]
    const widened: CardOf<'ink'> = { ...card, width: card.width * 3 };
    expect(inkCardStrokeHits(widened, { x: 250, y: 0 }, 0)).toEqual([0]);
  });

  it('空内容命中不到任何东西', () => {
    const empty = createCard('ink', { content: { paths: [] } });
    expect(inkCardStrokeHits(empty, { x: 0, y: 0 }, 100)).toEqual([]);
  });
});

// ── 标注归属（T3.09 / `F4-05`）──────────────────────────────

/** 造一张普通卡片当宿主（尺寸即框，`z` 用来验"层级最高者胜出"） */
function host(id: string, x: number, y: number, width: number, height: number, z = 1): Card {
  return { ...createCard('note'), id, x, y, width, height, z };
}

describe('inkAnchorOf', () => {
  it('★ 落笔点还原回**世界坐标**（卡片框被最小边长撑过，撑出来的偏移不算进笔迹位置）', () => {
    const card = cardFrom(
      stroke(
        [
          [110, 60],
          [140, 60],
        ],
        4,
      ),
    );
    // 撑过的框：内容框比笔迹包围盒高一截，但落笔点仍必须是用户按下的那个点
    expect(inkAnchorOf(card)?.x).toBeCloseTo(110, 2);
    expect(inkAnchorOf(card)?.y).toBeCloseTo(60, 2);
  });

  it('没有笔迹就没有落点（空 `paths` / 空点集都不该被当成"画在 (0,0)"）', () => {
    expect(inkAnchorOf(createCard('ink', { content: { paths: [] } }))).toBeNull();
    expect(inkAnchorOf(createCard('ink', { content: { paths: [stroke([])] } }))).toBeNull();
  });
});

describe('inkHostCard', () => {
  const onImage = (): CardOf<'ink'> =>
    cardFrom(
      stroke(
        [
          [110, 60],
          [140, 60],
        ],
        4,
      ),
    );

  it('落笔点在谁的框里就归谁', () => {
    const image = host('img', 100, 40, 200, 100);
    const ink = onImage();
    expect(inkHostCard([image, ink], ink)?.id).toBe('img');
  });

  it('画在空画布上：没有宿主（不是"挂在最近的卡片上"）', () => {
    const ink = cardFrom(
      stroke(
        [
          [500, 500],
          [530, 500],
        ],
        4,
      ),
    );
    expect(inkHostCard([host('img', 100, 40, 200, 100), ink], ink)).toBeNull();
  });

  it('★ 叠着的卡片取**层级最高**的那张：归属跟着视觉走，与数组顺序无关', () => {
    const ink = onImage();
    const low = host('low', 100, 40, 200, 100, 1);
    const high = host('high', 100, 40, 200, 100, 5);
    expect(inkHostCard([low, high, ink], ink)?.id).toBe('high');
    // 数组顺序反过来结论不变（判据是 z，不是"谁先出现"）
    expect(inkHostCard([high, low, ink], ink)?.id).toBe('high');
  });

  it('★ 手绘卡不做宿主：画在另一笔上时继续往下找真正的卡片，不做"标注套标注"', () => {
    const under = host('under', 100, 40, 200, 100);
    const other = cardFrom(
      stroke(
        [
          [105, 50],
          [130, 50],
        ],
        4,
      ),
    );
    const ink = onImage();
    expect(inkHostCard([under, other, ink], ink)?.id).toBe('under');
  });

  it('★ 把标注拖走：归属自然解除（正因为它是算出来的，才没有能对不上的第二份状态）', () => {
    const image = host('img', 100, 40, 200, 100);
    const ink = onImage();
    expect(inkHostCard([image, ink], ink)?.id).toBe('img');

    const moved: CardOf<'ink'> = { ...ink, x: ink.x + 1000, y: ink.y + 1000 };
    expect(inkHostCard([image, moved], moved)).toBeNull();
  });
});

describe('annotationsOn', () => {
  const onImage = (): CardOf<'ink'> =>
    cardFrom(
      stroke(
        [
          [110, 60],
          [140, 60],
        ],
        4,
      ),
    );

  it('只挑出画在这些卡上的标注（别处的笔迹一笔不动）', () => {
    const image = host('img', 100, 40, 200, 100);
    const annotation = onImage();
    const elsewhere = cardFrom(
      stroke(
        [
          [500, 500],
          [530, 500],
        ],
        4,
      ),
    );
    expect(annotationsOn([image, annotation, elsewhere], ['img'])).toEqual([annotation.id]);
  });

  it('★ 分栏里的标注不跟走：它的位置归分栏管，跟着图片走会变成"拖一下图，栏里卡片被抽走"', () => {
    const image = host('img', 100, 40, 200, 100);
    const inColumn: CardOf<'ink'> = { ...onImage(), columnId: 'col-1' };
    expect(annotationsOn([image, inColumn], ['img'])).toEqual([]);
  });

  it('已经在拖动集合里的标注不重复加（选中的那一笔由选区自己带走）', () => {
    const image = host('img', 100, 40, 200, 100);
    const annotation = onImage();
    expect(annotationsOn([image, annotation], ['img', annotation.id])).toEqual([]);
  });

  it('空选区直接返回空（别在每次点空白处都全表扫一遍）', () => {
    expect(annotationsOn([host('img', 0, 0, 10, 10)], [])).toEqual([]);
  });
});

// ── 渲染 ────────────────────────────────────────────────────

interface RenderSetup {
  el: FakeElement;
  ctx: CardRenderContext;
}

function setup(): RenderSetup {
  const doc = createFakeDocument();
  return {
    el: createFakeElement(doc),
    ctx: {
      app: {} as unknown as App,
      sourcePath: '',
      component: {} as unknown as Component,
      renderMarkdown: async () => {},
      zoom: 1,
      mode: 'display',
      updateContent: () => {},
      updateCard: () => {},
      setMode: () => {},
    },
  };
}

describe('inkCard.render', () => {
  it('viewBox = 内容框、`preserveAspectRatio="none"`：把框拉满，拉大即等比缩放', () => {
    const { el, ctx } = setup();
    const card = cardFrom(
      stroke(
        [
          [0, 0],
          [100, 0],
        ],
        4,
      ),
    );
    inkCard.render(el as unknown as HTMLElement, card, ctx);

    expect(el.classList.contains(INK_SLOT_CLASS)).toBe(true);
    const svg = el.children[0] as FakeElement;
    expect(svg.getAttribute('class')).toBe(INK_SVG_CLASS);
    // 内容框是 {0,0,104,16}（见上面"卡片框 == 内容框"那一例）
    expect(svg.getAttribute('viewBox')).toBe('0 0 104 16');
    expect(svg.getAttribute('preserveAspectRatio')).toBe('none');
  });

  it('每笔一个可见图元 + 一个加粗命中区，命中区是最粗的那条', () => {
    const { el, ctx } = setup();
    const card = cardFrom(
      stroke(
        [
          [0, 0],
          [100, 0],
        ],
        4,
      ),
    );
    inkCard.render(el as unknown as HTMLElement, card, ctx);

    const svg = el.children[0] as FakeElement;
    expect(svg.children).toHaveLength(2);

    const visible = svg.children[0] as FakeElement;
    expect(visible.getAttribute('class')).toBe('nestboard-ink-stroke');
    expect(visible.getAttribute('d')).toBe('M2 8 L102 8');
    expect(visible.getAttribute('stroke')).toBe(RED);
    expect(visible.getAttribute('stroke-width')).toBe('4');
    // 圆头圆角：手绘线不该有方头与尖角
    expect(visible.getAttribute('stroke-linecap')).toBe('round');

    const hit = svg.children[1] as FakeElement;
    expect(hit.getAttribute('class')).toBe(INK_HIT_CLASS);
    expect(Number(hit.getAttribute('stroke-width'))).toBeGreaterThan(4);
  });

  it('单点笔迹画成 `<circle>`（`stroke()` 一条只有一个点的路径什么都不会画）', () => {
    const { el, ctx } = setup();
    const card = cardFrom(stroke([[0, 0]], 4));
    inkCard.render(el as unknown as HTMLElement, card, ctx);

    const svg = el.children[0] as FakeElement;
    const dot = svg.children[0] as FakeElement;
    expect(dot.getAttribute('r')).toBe('2');
    expect(dot.getAttribute('fill')).toBe(RED);
  });

  it('压感笔迹的可见图元拆成多段（逐段描边）', () => {
    const { el, ctx } = setup();
    const card = cardFrom(
      stroke(
        [
          [0, 0, 0.2],
          [30, 0, 0.9],
          [30, 30, 0.5],
        ],
        4,
      ),
    );
    inkCard.render(el as unknown as HTMLElement, card, ctx);

    const svg = el.children[0] as FakeElement;
    // 2 段可见 + 1 条命中区
    expect(svg.children).toHaveLength(3);
  });

  it('destroy 把类名与内容清干净（节点会被回收池复用给别的类型）', () => {
    const { el, ctx } = setup();
    const card = cardFrom(
      stroke(
        [
          [0, 0],
          [100, 0],
        ],
        4,
      ),
    );
    inkCard.render(el as unknown as HTMLElement, card, ctx);

    inkCard.destroy!(el as unknown as HTMLElement);
    expect(el.classList.contains(INK_SLOT_CLASS)).toBe(false);
    expect(el.children).toHaveLength(0);
  });
});

// ── 菜单 ────────────────────────────────────────────────────

describe('inkCard.contextMenu', () => {
  /** 类型上 `contextMenu` 是可选的（不是每种卡都贡献菜单项），手绘卡必然实现了它 */
  function menuOf(card: CardOf<'ink'>, multiple: boolean) {
    return inkCard.contextMenu!(card, { multiple });
  }

  it('单选未锁定时给出"笔迹颜色"', () => {
    const card = cardFrom(
      stroke(
        [
          [0, 0],
          [10, 0],
        ],
        4,
      ),
    );
    const items = menuOf(card, false);
    expect(items).toHaveLength(1);
    expect(items[0].action).toBe('inkColor');
    expect(items[0].disabled).toBeFalsy();
  });

  it('多选或锁定时置灰：多选下"改哪一笔"没有答案，宁可置灰也不猜', () => {
    const card = cardFrom(
      stroke(
        [
          [0, 0],
          [10, 0],
        ],
        4,
      ),
    );
    expect(menuOf(card, true)[0].disabled).toBe(true);
    expect(menuOf({ ...card, locked: true }, false)[0].disabled).toBe(true);
  });
});
