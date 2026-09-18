/**
 * 关联线（`N1`）：几何（`layout/links.ts`）与读写（`validate` 的 `links` 段）。
 *
 * 两条要钉住的纪律：
 * 1. **线头永远贴在节点边缘**（取"面对面"那两条边的中点，与分支线同一条规矩）；
 * 2. **两端不都在就丢掉整条**（关联线没有"降级"的形态 —— 留一条半截线只会逼渲染层
 *    去防一个不存在的框）。
 */

import { describe, expect, it } from 'vitest';
import type { Rect } from '../../util/geometry';
import {
  linkAnchors,
  linkArrowEnds,
  linkArrowPoints,
  linkHitTest,
  linkMidpointOf,
  linkPathOf,
  linkPointAt,
  sampleLinkPath,
} from '../../mind/layout/links';
import { normalizeMindFile } from '../../mind/model/validate';
import {
  addLink,
  removeLink,
  setLinkArrow,
  setLinkBend,
  setLinkColor,
  setLinkLabel,
  setLinkSolid,
} from '../../mind/model/ops';
import { MIND_LINK_BEND_MAX, normalizeLinkBend } from '../../mind/model/schema';
import type { MindFile } from '../../mind/model/schema';

const rect = (x: number, y: number, width = 100, height = 40): Rect => ({ x, y, width, height });

describe('关联线的几何（只有曲线）', () => {
  it('★ 横向相邻：端点取**面对面**那两条竖边的中点（线头贴在框边上）', () => {
    const [a, b] = linkAnchors(rect(0, 0), rect(300, 0));

    expect(a).toEqual({ x: 100, y: 20 });
    expect(b).toEqual({ x: 300, y: 20 });
  });

  it('★ 反向（B 在左边）：两条边跟着换，端点依然面对面', () => {
    const [a, b] = linkAnchors(rect(300, 0), rect(0, 0));

    expect(a).toEqual({ x: 300, y: 20 });
    expect(b).toEqual({ x: 100, y: 20 });
  });

  it('★ 纵向差得更多时走上下两条横边', () => {
    const [a, b] = linkAnchors(rect(0, 0), rect(0, 400));

    expect(a).toEqual({ x: 50, y: 40 });
    expect(b).toEqual({ x: 50, y: 400 });
  });

  it('斜对角：按**主方向**选边（横差 > 纵差就走左右）—— 贴着框边不来回跳', () => {
    const [, b] = linkAnchors(rect(0, 0), rect(300, 120));

    // 横向差 300、纵向差 120 ⇒ 走左右；终点落在它自己的左边中点上
    expect(b).toEqual({ x: 300, y: 140 });
  });

  it('路径是一条**三次贝塞尔**（`M … C …`），中点落在两框之间', () => {
    const path = linkPathOf(rect(0, 0), rect(300, 0));
    expect(path.startsWith('M ')).toBe(true);
    expect(path).toContain(' C ');

    const mid = linkMidpointOf(rect(0, 0), rect(300, 0));
    expect(mid.x).toBeGreaterThan(100);
    expect(mid.x).toBeLessThan(300);
    expect(mid.y).toBeCloseTo(20, 1);
  });

  it('`t` 端点取值就是两个锚点自身（参数方程的边界）', () => {
    const from = rect(0, 0);
    const to = rect(300, 0);
    const [a, b] = linkAnchors(from, to);

    expect(linkPointAt(from, to, 0)).toEqual(a);
    expect(linkPointAt(from, to, 1).x).toBeCloseTo(b.x, 6);
    expect(linkPointAt(from, to, 1).y).toBeCloseTo(b.y, 6);
  });

  it('采样成折线（命中判定用）：`steps` 段 ⇒ `steps + 1` 个点', () => {
    expect(sampleLinkPath(rect(0, 0), rect(300, 0), 8)).toHaveLength(9);
    // 至少两段 —— 一个点连线段都算不上
    expect(sampleLinkPath(rect(0, 0), rect(300, 0), 1)).toHaveLength(3);
  });
});

// ─────────────────────────────────────────────────────────────
// 弯折（`N1-d`：线上那个手柄）
// ─────────────────────────────────────────────────────────────

describe('关联线的弯折（`N1-d`）', () => {
  const from = rect(0, 0);
  const to = rect(300, 0);

  it('★★ `bend` 缺席 ⇒ 画法与从前**逐字节相同**（存量文件一个像素都不变）', () => {
    expect(linkPathOf(from, to)).toBe(linkPathOf(from, to, undefined));
    expect(linkPathOf(from, to, { x: 0, y: 60 })).not.toBe(linkPathOf(from, to));
  });

  it('★ 手柄摆在曲线中点上：中点位移**正好等于** `bend`（`4/3` 那步换算的验收）', () => {
    const base = linkMidpointOf(from, to);
    const bend = { x: 40, y: -70 };
    const mid = linkMidpointOf(from, to, bend);

    expect(mid.x - base.x).toBeCloseTo(bend.x, 6);
    expect(mid.y - base.y).toBeCloseTo(bend.y, 6);
  });

  it('★ 采样折线穿过弯折后的中点（`t = 0.5` 那一点就在采样点上）', () => {
    const bend = { x: -30, y: 50 };
    const points = sampleLinkPath(from, to, 16, bend);
    const mid = linkMidpointOf(from, to, bend);

    expect(points.some((point) => Math.hypot(point.x - mid.x, point.y - mid.y) < 0.01)).toBe(true);
  });

  it('★ 命中判定跟着弯折走（否则"看得见的线点不中、空处反而点得中"）', () => {
    const bend = { x: 0, y: 120 };
    const links = [{ id: 'l1', from: 'a', to: 'b', bend }];
    const boxes = new Map([
      ['a', from],
      ['b', to],
    ]);

    // 弯折后的中点：点得中
    expect(linkHitTest(links, boxes, linkMidpointOf(from, to, bend), 6)).toBe('l1');
    // 不弯时那个中点（已经被弧甩开了）：点不中
    expect(linkHitTest(links, boxes, linkMidpointOf(from, to), 6)).toBeNull();
  });

  it('箭头跟着弯折转（切线变了，箭头不能还按老方向插着）', () => {
    expect(linkArrowPoints(from, to, 'to', 10, { x: 0, y: 90 })).not.toEqual(
      linkArrowPoints(from, to, 'to'),
    );
  });

  it('归一化：太小 ⇒ `null`（拉回原处就是"不弯"）、非数 ⇒ `null`、太大 ⇒ 夹到上限', () => {
    expect(normalizeLinkBend({ x: 0.5, y: 0.5 })).toBeNull();
    expect(normalizeLinkBend({ x: Number.NaN, y: 10 })).toBeNull();
    expect(normalizeLinkBend(undefined)).toBeNull();

    const far = normalizeLinkBend({ x: 0, y: 99999 });
    expect(far).not.toBeNull();
    expect(Math.hypot(far?.x ?? 0, far?.y ?? 0)).toBeCloseTo(MIND_LINK_BEND_MAX, 6);
  });

  it('★ `setLinkBend`：写 / 值没变返回 `false` / 拉直 = **删键**（纪律 2）/ 太大夹住', () => {
    const parsed = normalizeMindFile(mindWith([{ id: 'l_1', from: 'n_a', to: 'n_b' }]));
    if (!parsed.ok) throw new Error('夹具坏了');
    const mind = parsed.file;
    const linkOf = (): { bend?: { x: number; y: number } } | undefined =>
      mind.links?.find((link) => link.id === 'l_1');

    expect(setLinkBend(mind, 'l_1', { x: 10, y: 20 })).toBe(true);
    expect(linkOf()?.bend).toEqual({ x: 10, y: 20 });
    // 值没变 ⇒ 不写盘、不占撤销栈
    expect(setLinkBend(mind, 'l_1', { x: 10, y: 20 })).toBe(false);

    // 拉直 ⇒ **删键**（"从来没弯过"与"拉回原处"在文件里必须同一个样子）
    expect(setLinkBend(mind, 'l_1', null)).toBe(true);
    expect(linkOf()).not.toHaveProperty('bend');

    // 太大 ⇒ 夹进上限
    expect(setLinkBend(mind, 'l_1', { x: 0, y: 99999 })).toBe(true);
    expect(Math.hypot(linkOf()?.bend?.x ?? 0, linkOf()?.bend?.y ?? 0)).toBeCloseTo(
      MIND_LINK_BEND_MAX,
      6,
    );

    // 极小 ⇒ 不许写进文件（同上：归一成"不弯"）
    expect(setLinkBend(mind, 'l_1', { x: 0, y: 0.1 })).toBe(true);
    expect(linkOf()).not.toHaveProperty('bend');

    // 线不在 ⇒ `false`（不抛）
    expect(setLinkBend(mind, 'l_幽灵', { x: 5, y: 5 })).toBe(false);
  });

  it('★ `setLinkColor`：写主题色 / 值没变返回 `false` / 回到默认 = **删键**（纪律 2）', () => {
    const parsed = normalizeMindFile(mindWith([{ id: 'l_1', from: 'n_a', to: 'n_b' }]));
    if (!parsed.ok) throw new Error('夹具坏了');
    const mind = parsed.file;
    const linkOf = (): { color?: string } | undefined =>
      mind.links?.find((link) => link.id === 'l_1');

    expect(setLinkColor(mind, 'l_1', '3')).toBe(true);
    expect(linkOf()?.color).toBe('3');
    expect(setLinkColor(mind, 'l_1', '3')).toBe(false);
    // 「默认颜色」= 删键（"改回默认"与"从来没改过"在文件里必须同一个样子）
    expect(setLinkColor(mind, 'l_1', null)).toBe(true);
    expect(linkOf()).not.toHaveProperty('color');
    // 线不在 ⇒ `false`（不抛）
    expect(setLinkColor(mind, 'l_幽灵', '2')).toBe(false);
  });

  it('★ 读盘：合法 `color` 留下；不是主题色编号的丢掉（6 个编号之外的都不认）', () => {
    const read = (links: unknown): unknown => {
      const result = normalizeMindFile(mindWith(links));
      return result.ok ? result.file.links : null;
    };

    expect(read([{ id: 'l_1', from: 'n_a', to: 'n_b', color: '5' }])).toEqual([
      { id: 'l_1', from: 'n_a', to: 'n_b', color: '5' },
    ]);
    expect(read([{ id: 'l_1', from: 'n_a', to: 'n_b', color: '#ff0000' }])).toEqual([
      { id: 'l_1', from: 'n_a', to: 'n_b' },
    ]);
    expect(read([{ id: 'l_1', from: 'n_a', to: 'n_b', color: '9' }])).toEqual([
      { id: 'l_1', from: 'n_a', to: 'n_b' },
    ]);
  });

  it('★ 读盘：合法 `bend` 留下；非数 / 极小的丢掉（缺席 = 不弯）', () => {
    const read = (links: unknown): unknown => {
      const result = normalizeMindFile(mindWith(links));
      return result.ok ? result.file.links : null;
    };

    expect(read([{ id: 'l_1', from: 'n_a', to: 'n_b', bend: { x: 30, y: 40 } }])).toEqual([
      { id: 'l_1', from: 'n_a', to: 'n_b', bend: { x: 30, y: 40 } },
    ]);
    expect(read([{ id: 'l_1', from: 'n_a', to: 'n_b', bend: { x: 0.2, y: 0 } }])).toEqual([
      { id: 'l_1', from: 'n_a', to: 'n_b' },
    ]);
    expect(read([{ id: 'l_1', from: 'n_a', to: 'n_b', bend: { x: 'x', y: 1 } }])).toEqual([
      { id: 'l_1', from: 'n_a', to: 'n_b' },
    ]);
  });
});

// ─────────────────────────────────────────────────────────────
// 读写：`MindFile.links`
// ─────────────────────────────────────────────────────────────

/** 一份最小的合法脑图（三个节点：中心 / 甲 / 乙） */
const mindWith = (links: unknown): Record<string, unknown> => ({
  version: 1,
  revision: 0,
  meta: { id: 'nm_1', title: 'T' },
  view: { x: 0, y: 0, zoom: 1, background: 'dots' },
  rootId: 'n_root',
  nodes: [
    { id: 'n_root', text: '中心', note: '', parentId: null, order: 0 },
    { id: 'n_a', text: '甲', note: '', parentId: 'n_root', order: 0 },
    { id: 'n_b', text: '乙', note: '', parentId: 'n_root', order: 1 },
  ],
  links,
});

describe('关联线的读写', () => {
  const readLinks = (links: unknown): unknown => {
    const result = normalizeMindFile(mindWith(links));
    return result.ok ? result.file.links : null;
  };

  it('★ 正常一条：id / from / to 原样留下', () => {
    expect(readLinks([{ id: 'l_1', from: 'n_a', to: 'n_b' }])).toEqual([
      { id: 'l_1', from: 'n_a', to: 'n_b' },
    ]);
  });

  it('★ 允许同一对节点之间有多条（不做端点去重），但 id 重复只留第一条', () => {
    const links = readLinks([
      { id: 'l_1', from: 'n_a', to: 'n_b', label: '因' },
      { id: 'l_2', from: 'n_a', to: 'n_b', label: '果' },
      { id: 'l_1', from: 'n_b', to: 'n_a' },
    ]) as { id: string }[];

    expect(links.map((link) => link.id)).toEqual(['l_1', 'l_2']);
  });

  it('★ 端点不在了 ⇒ 整条丢掉（这正是"删了节点还剩一条半截线"的形状）', () => {
    // ★ 全被丢光 ⇒ 这个键**根本不写**（纪律 2：没有就是没有），所以是 `undefined` 而不是 `[]`
    expect(readLinks([{ id: 'l_1', from: 'n_a', to: 'n_幽灵' }])).toBeUndefined();
    expect(readLinks([{ id: 'l_1', from: 'n_幽灵', to: 'n_b' }])).toBeUndefined();
  });

  it('自连丢掉（交互层不让连，文件里手写了也当坏的）', () => {
    expect(readLinks([{ id: 'l_1', from: 'n_a', to: 'n_a' }])).toBeUndefined();
  });

  it('纪律 2：标签为空 / 箭头不认识 ⇒ **不写那个键**（不是写空串）', () => {
    const [link] = readLinks([
      { id: 'l_1', from: 'n_a', to: 'n_b', label: '   ', arrow: 'none' },
    ]) as Record<string, unknown>[];

    expect(link).toEqual({ id: 'l_1', from: 'n_a', to: 'n_b' });
    expect('label' in link).toBe(false);
    expect('arrow' in link).toBe(false);
  });

  it('箭头认这两个值；标签留着', () => {
    expect(
      readLinks([{ id: 'l_1', from: 'n_a', to: 'n_b', label: '依赖', arrow: 'both' }]),
    ).toEqual([{ id: 'l_1', from: 'n_a', to: 'n_b', label: '依赖', arrow: 'both' }]);
  });

  it('★ 线型只认 `true`：`false` 与缺席等价、一起丢掉（默认就是虚线）', () => {
    expect(readLinks([{ id: 'l_1', from: 'n_a', to: 'n_b', solid: true }])).toEqual([
      { id: 'l_1', from: 'n_a', to: 'n_b', solid: true },
    ]);
    const [plain] = readLinks([{ id: 'l_1', from: 'n_a', to: 'n_b', solid: false }]) as Record<
      string,
      unknown
    >[];
    expect('solid' in plain).toBe(false);
  });

  it('没有 `links` 键 ⇒ 读出来也**不补**这个键（存量文件逐字节不变）', () => {
    const result = normalizeMindFile(mindWith(undefined));
    expect(result.ok).toBe(true);
    if (result.ok) expect('links' in result.file).toBe(false);
  });

  it('幂等：读两遍结果一样、且第二遍零 issue（这条纪律唯一的自动检查）', () => {
    const first = normalizeMindFile(mindWith([{ id: 'l_1', from: 'n_a', to: 'n_b' }]));
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = normalizeMindFile(JSON.parse(JSON.stringify(first.file)) as unknown);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.issues).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
// 写：`addLink`（`N1-b` 落笔走它）
// ─────────────────────────────────────────────────────────────

describe('addLink（关联线的唯一写入口）', () => {
  const fileWith = (): MindFile => {
    const result = normalizeMindFile(mindWith(undefined));
    if (!result.ok) throw new Error('夹具坏了');
    return result.file;
  };

  it('★ 加一条：给回新 id，线进了 `links`，且**不带** label / arrow（纪律 2）', () => {
    const mind = fileWith();
    const id = addLink(mind, 'n_a', 'n_b');

    expect(id).not.toBeNull();
    expect(mind.links).toEqual([{ id, from: 'n_a', to: 'n_b' }]);
  });

  it('自连 / 端点不在 ⇒ `null`，且**一个字节都不写**（连空数组都不补）', () => {
    const mind = fileWith();
    expect(addLink(mind, 'n_a', 'n_a')).toBeNull();
    expect(addLink(mind, 'n_a', 'n_幽灵')).toBeNull();
    expect('links' in mind).toBe(false);
  });

  it('同一对节点之间可以有多条（不同标签）—— 不做去重', () => {
    const mind = fileWith();
    addLink(mind, 'n_a', 'n_b');
    addLink(mind, 'n_a', 'n_b');

    expect(mind.links).toHaveLength(2);
  });

  it('★ 新加的线**读一遍写回去不变**（与读入口同一个口径）', () => {
    const mind = fileWith();
    addLink(mind, 'n_a', 'n_b');

    const again = normalizeMindFile(JSON.parse(JSON.stringify(mind)) as unknown);
    expect(again.ok).toBe(true);
    if (again.ok) {
      expect(again.issues).toEqual([]);
      expect(again.file.links).toEqual(mind.links);
    }
  });
});

// ─────────────────────────────────────────────────────────────
// `N1-c`：箭头 / 命中 / 改标签 / 删
// ─────────────────────────────────────────────────────────────

describe('箭头（`N1-c`）', () => {
  it('缺席 = 一个都不画；`end` = 终点一个；`both` = 两端各一个', () => {
    expect(linkArrowEnds(undefined)).toEqual([]);
    expect(linkArrowEnds('end')).toEqual(['to']);
    expect(linkArrowEnds('both')).toEqual(['from', 'to']);
  });

  it('★ 尖端落在**锚点**上（箭头贴着节点边，不飘在线上）', () => {
    const from = rect(0, 0);
    const to = rect(300, 0);
    const [tip] = linkArrowPoints(from, to, 'to');

    expect(tip).toEqual({ x: 300, y: 20 });
  });

  it('★ 方向沿**锚点处的切线**（曲线的那一头是斜的，箭头就得斜着）', () => {
    // 纵向关系的两个框：起点的切线朝下，箭头（`from` 那一端）应当朝**上**指回去
    const from = rect(0, 0);
    const to = rect(0, 400);
    const [tip, wingA, wingB] = linkArrowPoints(from, to, 'from');

    expect(tip).toEqual({ x: 50, y: 40 });
    // 两个翼都在尖的**下方**（箭头朝上），且关于中轴对称
    expect(wingA.y).toBeGreaterThan(tip.y);
    expect(wingB.y).toBeGreaterThan(tip.y);
    expect(wingA.x).toBeCloseTo(tip.x - (wingB.x - tip.x), 6);
  });

  it('两端各画一个时，两个箭头**朝向相反**（各自指向自己那一端的节点）', () => {
    const from = rect(0, 0);
    const to = rect(300, 0);
    const [tipTo] = linkArrowPoints(from, to, 'to');
    const [tipFrom] = linkArrowPoints(from, to, 'from');

    // 终点的箭头朝右（尖在最右），起点的箭头朝左（尖在最左）
    expect(tipTo.x).toBe(300);
    expect(tipFrom.x).toBe(100);
  });
});

describe('命中（`N1-c`：点线身 = 选中它）', () => {
  const boxes = new Map<string, Rect>([
    ['a', rect(0, 0)],
    ['b', rect(300, 0)],
  ]);
  const links = [{ id: 'l_1', from: 'a', to: 'b' }];

  it('★ 点在线上 ⇒ 命中的是它', () => {
    const mid = { x: 200, y: 20 };
    expect(linkHitTest(links, boxes, mid, 8)).toBe('l_1');
  });

  it('★ 远离线的点 ⇒ `null`（容差之外不命中）', () => {
    expect(linkHitTest(links, boxes, { x: 200, y: 200 }, 8)).toBeNull();
  });

  it('★ 判据跟着**曲线**走：曲线上的点命中、离曲线够远的点不命中', () => {
    const tall = new Map<string, Rect>([
      ['a', rect(0, 0, 100, 40)],
      ['b', rect(300, 500, 100, 40)],
    ]);
    const tallLinks = [{ id: 'l_1', from: 'a', to: 'b' }];

    // ★ 用**同一份几何**取曲线上的点（`linkPointAt`）：命中判据必须与画线共用一套数学。
    //   注意 `t = 0.5` 不能用来测"弦外" —— 三次贝塞尔在 `t=0.5` 处**恰好**落在
    //   弦中点上（控制点对称），取 `t=0.25` 这种偏一点的地方才看得出曲线
    const onCurve = linkPointAt(tall.get('a') as Rect, tall.get('b') as Rect, 0.25);
    expect(linkHitTest(tallLinks, tall, onCurve, 2)).toBe('l_1');

    // 从曲线上的点垂直挪开 12px ⇒ 4px 容差之内不命中
    expect(linkHitTest(tallLinks, tall, { x: onCurve.x + 12, y: onCurve.y }, 4)).toBeNull();
  });

  it('端点框缺一个 ⇒ 这条线不参与命中（不画的东西点不中）', () => {
    expect(linkHitTest(links, new Map([['a', rect(0, 0)]]), { x: 200, y: 20 }, 8)).toBeNull();
  });

  it('两条都命中的点 ⇒ 给**最近的**那条', () => {
    const stacked = new Map<string, Rect>([
      ['a', rect(0, 0)],
      ['b', rect(300, 0)],
      ['c', rect(0, 40)],
      ['d', rect(300, 40)],
    ]);
    const both = [
      { id: '远', from: 'a', to: 'b' },
      { id: '近', from: 'c', to: 'd' },
    ];
    // 这一带两条线的弧都经过：挑离得更近的那条
    expect(linkHitTest(both, stacked, { x: 200, y: 62 }, 30)).toBe('近');
  });
});

describe('改标签 / 箭头 / 删（`N1-c`）', () => {
  const withLink = (): { mind: MindFile; id: string } => {
    const result = normalizeMindFile(mindWith(undefined));
    if (!result.ok) throw new Error('夹具坏了');
    const mind = result.file;
    const id = addLink(mind, 'n_a', 'n_b') ?? '';
    return { mind, id };
  };

  it('★ 改标签：写进去的是**去掉首尾空白**后的值', () => {
    const { mind, id } = withLink();
    expect(setLinkLabel(mind, id, '  依赖  ')).toBe(true);
    expect(mind.links?.[0].label).toBe('依赖');
  });

  it('★ 标签清空 = **删掉这个键**（纪律 2：不留空串）', () => {
    const { mind, id } = withLink();
    setLinkLabel(mind, id, '依赖');
    expect(setLinkLabel(mind, id, '   ')).toBe(true);
    expect('label' in (mind.links?.[0] ?? {})).toBe(false);
  });

  it('值没变 ⇒ `false`（不写盘、不占撤销栈）', () => {
    const { mind, id } = withLink();
    expect(setLinkLabel(mind, id, '')).toBe(false);
    expect(setLinkArrow(mind, id, null)).toBe(false);
  });

  it('箭头：写进 `end` / `both`；`null` = 删键', () => {
    const { mind, id } = withLink();
    expect(setLinkArrow(mind, id, 'end')).toBe(true);
    expect(mind.links?.[0].arrow).toBe('end');
    expect(setLinkArrow(mind, id, 'both')).toBe(true);
    expect(mind.links?.[0].arrow).toBe('both');
    expect(setLinkArrow(mind, id, null)).toBe(true);
    expect('arrow' in (mind.links?.[0] ?? {})).toBe(false);
  });

  it('★ 线型：写实线 ⇒ `solid: true`；改回虚线 ⇒ **删键**（默认值不落盘）', () => {
    const { mind, id } = withLink();
    expect(setLinkSolid(mind, id, true)).toBe(true);
    expect(mind.links?.[0].solid).toBe(true);
    expect(setLinkSolid(mind, id, true)).toBe(false); // 值没变
    expect(setLinkSolid(mind, id, false)).toBe(true);
    expect('solid' in (mind.links?.[0] ?? {})).toBe(false);
  });

  it('删除：删掉这一条；**最后一条删完这个键也收掉**（纪律 2）', () => {
    const { mind, id } = withLink();
    expect(removeLink(mind, id)).toBe(true);
    expect('links' in mind).toBe(false);
  });

  it('删一条不存在的线 ⇒ `false`（不产生一次空历史）', () => {
    const { mind } = withLink();
    expect(removeLink(mind, 'l_幽灵')).toBe(false);
  });
});
