/**
 * 拖动 / 缩放几何、网格吸附与智能参考线的接线（T1.35–T1.37 / T3.11 / T3.12）。
 *
 * 几何纯函数（`resizedRect` / `movedRects`）本身可以在别处逐个方位钉死；这里只盯
 * **吸附接进 `DragController` 之后**最容易错的地方：
 *  1. 只有 `move` 吸、`resize` 不吸（网格与参考线都是）；
 *  2. 多选整体吸附时**组内相对位置分毫不动**（这是"整组搬运"的底线）；
 *  3. Ctrl 网格是**反转**、参考线是**临时关闭**；
 *  4. 坏步长（0）要回落到 16，而不是把卡片算飞；
 *  5. 参考线必须和几何由**同一次** `preview` 回调送出（否则会有一帧错位）。
 */

import { describe, expect, it, vi } from 'vitest';
import type { CardRect } from '../../model/ops';
import { EMPTY_GUIDES } from '../../model/snapping';
import type { Point } from '../../util/geometry';
import { t } from '../../util/i18n';
import {
  DragController,
  DRAG_THRESHOLD_PX,
  localDelta,
  snapAngle,
} from '../../view/interact/DragController';

function rect(id: string, x: number, y: number, width = 10, height = 10): CardRect {
  return { id, x, y, width, height };
}

function makeController() {
  const preview = vi.fn();
  const commit = vi.fn(() => true);
  const resync = vi.fn();
  const controller = new DragController({ preview, commit, resync });
  return { controller, preview, commit, resync };
}

/** 拖动一步（吸收返回值，避免"没用上"的 lint 噪音） */
function move(controller: DragController, x: number, y: number, ctrl = false): void {
  controller.update({ x, y }, { ctrl });
}

describe('DragController · 网格吸附', () => {
  it('开启吸附时，移动结果落在网格点上', () => {
    const { controller, preview } = makeController();
    controller.begin({
      kind: 'move',
      origin: { x: 0, y: 0 },
      rects: [rect('a', 5, 5)],
      grid: { enabled: true, size: 16 },
    });

    move(controller, 5, 5);

    // 5 + 5 = 10 → 吸到 16
    expect(preview).toHaveBeenCalledWith([rect('a', 16, 16)], EMPTY_GUIDES);
  });

  it('★ 多选整体吸附：组内相对位置分毫不动', () => {
    const { controller, preview } = makeController();
    controller.begin({
      kind: 'move',
      origin: { x: 0, y: 0 },
      rects: [rect('a', 5, 5), rect('b', 30, 20)],
      grid: { enabled: true, size: 16 },
    });

    move(controller, 5, 5);

    const [a, b] = preview.mock.calls[0][0] as CardRect[];
    // 整组统一位移 11 / 11：a(5→16)、b(30→41)，相对偏移仍是 (25, 15)
    expect(a).toEqual(rect('a', 16, 16));
    expect(b).toEqual(rect('b', 41, 31));
    expect(b.x - a.x).toBe(25);
    expect(b.y - a.y).toBe(15);
  });

  it('关闭吸附且不按 Ctrl 时，自由移动', () => {
    const { controller, preview } = makeController();
    controller.begin({
      kind: 'move',
      origin: { x: 0, y: 0 },
      rects: [rect('a', 5, 5)],
      grid: { enabled: false, size: 16 },
    });

    move(controller, 5, 5);

    expect(preview).toHaveBeenCalledWith([rect('a', 10, 10)], EMPTY_GUIDES);
  });

  it('★ Ctrl 反转：开着吸附时按住 Ctrl = 不吸', () => {
    const { controller, preview } = makeController();
    controller.begin({
      kind: 'move',
      origin: { x: 0, y: 0 },
      rects: [rect('a', 5, 5)],
      grid: { enabled: true, size: 16 },
    });

    move(controller, 5, 5, true);

    expect(preview).toHaveBeenCalledWith([rect('a', 10, 10)], EMPTY_GUIDES);
  });

  it('★ Ctrl 反转：关着吸附时按住 Ctrl = 反而要吸', () => {
    const { controller, preview } = makeController();
    controller.begin({
      kind: 'move',
      origin: { x: 0, y: 0 },
      rects: [rect('a', 5, 5)],
      grid: { enabled: false, size: 16 },
    });

    move(controller, 5, 5, true);

    expect(preview).toHaveBeenCalledWith([rect('a', 16, 16)], EMPTY_GUIDES);
  });

  it('给的是坏步长（0）时回落到 16，而不是把卡片算飞', () => {
    const { controller, preview } = makeController();
    controller.begin({
      kind: 'move',
      origin: { x: 0, y: 0 },
      rects: [rect('a', 5, 5)],
      grid: { enabled: true, size: 0 },
    });

    move(controller, 5, 5);

    expect(preview).toHaveBeenCalledWith([rect('a', 16, 16)], EMPTY_GUIDES);
  });

  it('未提供 grid 时完全不吸（老调用点行为不变）', () => {
    const { controller, preview } = makeController();
    controller.begin({
      kind: 'move',
      origin: { x: 0, y: 0 },
      rects: [rect('a', 5, 5)],
    });

    move(controller, 5, 5);

    expect(preview).toHaveBeenCalledWith([rect('a', 10, 10)], EMPTY_GUIDES);
  });

  it('缩放既不吸网格，也不产生参考线', () => {
    const { controller, preview } = makeController();
    controller.begin({
      kind: 'resize',
      origin: { x: 0, y: 0 },
      // 起点给足尺寸，免得撞上 `MIN_CARD_SIZE`（80×60）的硬下限
      rects: [rect('a', 0, 0, 100, 100)],
      handle: 'se',
      grid: { enabled: true, size: 16 },
      // 目标卡就摆在手边：若参考线没被 kind 挡住，这里一定会对齐
      align: { others: [rect('o', 100, 0, 400, 50)], threshold: 6 },
    });

    move(controller, 7, 7);

    // 若误吸网格，宽高会被吸到 112；正确行为是自由的 107
    expect(preview).toHaveBeenCalledWith([rect('a', 0, 0, 107, 107)], EMPTY_GUIDES);
  });

  it('没越过阈值只算点击：不预览、不提交', () => {
    const { controller, preview, commit } = makeController();
    controller.begin({
      kind: 'move',
      origin: { x: 0, y: 0 },
      rects: [rect('a', 5, 5)],
      grid: { enabled: true, size: 16 },
    });

    expect(controller.update({ x: 1, y: 1 })).toBe(false);
    expect(preview).not.toHaveBeenCalled();
    expect(controller.finish()).toBe(false);
    expect(commit).not.toHaveBeenCalled();
  });

  it('finish 提交的是吸附后的几何（移动标签）', () => {
    const { controller, commit } = makeController();
    controller.begin({
      kind: 'move',
      origin: { x: 0, y: 0 },
      rects: [rect('a', 5, 5)],
      grid: { enabled: true, size: 16 },
    });

    move(controller, DRAG_THRESHOLD_PX + 2, DRAG_THRESHOLD_PX + 2);
    expect(controller.finish()).toBe(true);

    expect(commit).toHaveBeenCalledWith([rect('a', 16, 16)], t('history.move'));
  });
});

describe('DragController · 智能参考线', () => {
  /** 参照卡 (100, 200) 50×50：x 锚点 100/125/150，y 锚点 200/225/250 */
  const target = rect('o', 100, 200, 50, 50);

  /**
   * 被拖的卡片：宽 200、高 20。
   *
   * ★ 宽度故意拉大：x 的锚点相距 100，任何一次判定里只有**一对**锚点够得着
   *   （阈值 6px），测试才有唯一答案。10px 宽的小卡三个锚点会互相抢，
   *   那是"就近取最近"的正常行为，但钉不住具体数值。
   * ★ 高 20 且 y 从 0 起：y 锚点（0/10/20）离参照卡的 200 足够远，
   *   纵轴永远不参与对齐，断言才能看清是谁在生效。
   */
  const wide = (): CardRect => rect('a', 0, 0, 200, 20);

  it('左边缘进入阈值 → 吸到参照卡左边缘，并送出竖参考线', () => {
    const { controller, preview } = makeController();
    controller.begin({
      kind: 'move',
      origin: { x: 0, y: 0 },
      rects: [wide()],
      align: { others: [target], threshold: 6 },
    });

    // 指针走了 97：左边缘停在 97，离参照卡左边缘 100 差 3（在阈值内）
    move(controller, 97, 0);

    const [rects, guides] = preview.mock.calls[0];
    // 位移量是"97 + 3"（叠加修正），不是"3" —— 后者会让卡片直接瞬移到 3 的位置
    expect(rects).toEqual([rect('a', 100, 0, 200, 20)]);
    expect(guides.verticals).toEqual([100]);
    expect(guides.horizontals).toEqual([]);
  });

  it('中心对齐也算数（卡片中心 123 够得着参照卡中心 125）', () => {
    const { controller, preview } = makeController();
    controller.begin({
      kind: 'move',
      origin: { x: 0, y: 0 },
      rects: [wide()],
      align: { others: [target], threshold: 6 },
    });

    move(controller, 23, 0);

    const [rects, guides] = preview.mock.calls[0];
    // 中心锚点 123 → 125（修正 +2）⇒ 位移量 25，卡片的中心正好落在 125 上
    expect(rects).toEqual([rect('a', 25, 0, 200, 20)]);
    expect(guides.verticals).toEqual([125]);
  });

  it('阈值之外不对齐：几何自由、参考线为空', () => {
    const { controller, preview } = makeController();
    controller.begin({
      kind: 'move',
      origin: { x: 0, y: 0 },
      rects: [wide()],
      align: { others: [target], threshold: 6 },
    });

    // x 最近的组合也差 20（左边缘 80 / 中心 180 都够不着），y 全是 200 开外
    move(controller, 80, 0);

    expect(preview).toHaveBeenCalledWith([rect('a', 80, 0, 200, 20)], EMPTY_GUIDES);
  });

  it('对齐优先于网格，但另一个轴仍走网格（分轴决策）', () => {
    const { controller, preview } = makeController();
    controller.begin({
      kind: 'move',
      origin: { x: 0, y: 0 },
      rects: [wide()],
      grid: { enabled: true, size: 16 },
      align: { others: [target], threshold: 6 },
    });

    // x：左边缘 103 离 100 差 3 → 对齐（网格本来会给 96）
    // y：5 离参照卡的 200 太远 → 交回网格（0 + 5 → 吸到 0）
    move(controller, 103, 5);

    const [rects, guides] = preview.mock.calls[0];
    expect(rects).toEqual([rect('a', 100, 0, 200, 20)]);
    expect(guides.verticals).toEqual([100]);
    expect(guides.horizontals).toEqual([]);
  });

  it('★ Ctrl 临时关闭参考线（对齐 Sketch：按住就是不对齐也不吸）', () => {
    const { controller, preview } = makeController();
    controller.begin({
      kind: 'move',
      origin: { x: 0, y: 0 },
      rects: [wide()],
      align: { others: [target], threshold: 6 },
    });

    move(controller, 97, 0, true);

    expect(preview).toHaveBeenCalledWith([rect('a', 97, 0, 200, 20)], EMPTY_GUIDES);
  });

  it('★ 多选整体对齐：组内相对位置分毫不动', () => {
    const { controller, preview } = makeController();
    controller.begin({
      kind: 'move',
      origin: { x: 0, y: 0 },
      // 包围盒 x 0→220、y 0→60：只有 x 的左边缘够得着参照卡
      rects: [rect('a', 0, 0, 20, 20), rect('b', 200, 40, 20, 20)],
      align: { others: [target], threshold: 6 },
    });

    move(controller, 97, 0);

    const [rects, guides] = preview.mock.calls[0];
    // 包围盒左边缘 97 → 吸到 100：整组一起挪 100，间隔仍是 200
    expect(rects).toEqual([rect('a', 100, 0, 20, 20), rect('b', 300, 40, 20, 20)]);
    expect(guides.verticals).toEqual([100]);
  });

  it('阈值 <= 0 时视为关闭（避免除零 / 负阈值把一切都吸走）', () => {
    const { controller, preview } = makeController();
    controller.begin({
      kind: 'move',
      origin: { x: 0, y: 0 },
      rects: [wide()],
      align: { others: [target], threshold: 0 },
    });

    move(controller, 97, 0);

    expect(preview).toHaveBeenCalledWith([rect('a', 97, 0, 200, 20)], EMPTY_GUIDES);
  });
});

// ─────────────────────────────────────────────────────────────
// 旋转（T7.06 / `F2-00-10`）与"在转过的卡片上缩放"
//
// 两种失败方式都很难在界面上归因：一是**手柄与指针分家**（转 90° 之后
// 拖"右边"会让卡片往下长），二是**角度差在一圈处跳变**（越过 ±180° 时
// 卡片自己猛转一整圈）。两者都只能靠在纯函数上钉死。
// ─────────────────────────────────────────────────────────────

describe('snapAngle', () => {
  it('就近吸到 15° 的整数倍', () => {
    expect(snapAngle(0)).toBe(0);
    expect(snapAngle(7)).toBe(0);
    expect(snapAngle(8)).toBe(15);
    expect(snapAngle(88)).toBe(90);
    expect(snapAngle(-7)).toBe(0);
    expect(snapAngle(-8)).toBe(-15);
  });

  it('★ 结果过一遍归一化：`-180` 要写成 `180`', () => {
    expect(snapAngle(-180)).toBe(180);
    expect(snapAngle(180)).toBe(180);
    expect(snapAngle(179)).toBe(180);
  });

  it('坏步长（0 / 负数）视为不吸：宁可完全不吸，也不能算出 NaN 写进文件', () => {
    expect(snapAngle(7.5, 0)).toBe(7.5);
    expect(snapAngle(7.5, -15)).toBe(7.5);
  });
});

describe('localDelta', () => {
  it('0 度原样返回（绝大多数卡片走这条早退）', () => {
    expect(localDelta(10, -4, 0)).toEqual({ x: 10, y: -4 });
  });

  it('★ 卡片转 90° 时，"往下拖"是"把它往右拉"', () => {
    // 世界位移 (0, 10) 投影到卡片自己的坐标轴上 = (10, 0)：那张卡的"右"朝下
    const local = localDelta(0, 10, 90);
    expect(local.x).toBeCloseTo(10);
    expect(local.y).toBeCloseTo(0);
  });

  it('转 45° 时位移被投到对角线方向（长度不放大、不缩小）', () => {
    const local = localDelta(10, 0, 45);
    expect(Math.hypot(local.x, local.y)).toBeCloseTo(10);
    expect(local.x).toBeCloseTo(10 * Math.cos(Math.PI / 4));
    expect(local.y).toBeCloseTo(-10 * Math.sin(Math.PI / 4));
  });

  it('正好是 `rotatePoint` 的逆变换', () => {
    const deg = 37;
    const rad = (deg * Math.PI) / 180;
    // 世界位移 = 把"卡片局部里的 (12, -5)"转 37° 之后的样子
    const world = {
      x: 12 * Math.cos(rad) - -5 * Math.sin(rad),
      y: 12 * Math.sin(rad) + -5 * Math.cos(rad),
    };
    const local = localDelta(world.x, world.y, deg);
    expect(local.x).toBeCloseTo(12);
    expect(local.y).toBeCloseTo(-5);
  });
});

describe('DragController · 在转过的卡片上缩放', () => {
  it('未旋转时行为与 T7.06 之前完全一致', () => {
    const { controller, preview } = makeController();
    controller.begin({
      kind: 'resize',
      origin: { x: 100, y: 100 },
      rects: [rect('a', 0, 0, 100, 100)],
      handle: 'e',
      angle: 0,
    });

    move(controller, 120, 100);

    expect(preview).toHaveBeenCalledWith([rect('a', 0, 0, 120, 100)], EMPTY_GUIDES);
  });

  it('★ 转 90° 的卡片：拖"右边"手柄往下走 = 宽度长出来（手柄跟手）', () => {
    const { controller, preview } = makeController();
    controller.begin({
      kind: 'resize',
      origin: { x: 100, y: 100 },
      rects: [rect('a', 0, 0, 100, 100)],
      handle: 'e',
      angle: 90,
    });

    // 世界位移是"往下 20"；那张卡的"右"此刻朝下 → 宽度 +20
    move(controller, 100, 120);

    expect(preview).toHaveBeenCalledWith([rect('a', 0, 0, 120, 100)], EMPTY_GUIDES);
  });

  it('缺失 `angle` 时按 0 处理（老调用方不必改）', () => {
    const { controller, preview } = makeController();
    controller.begin({
      kind: 'resize',
      origin: { x: 0, y: 0 },
      rects: [rect('a', 0, 0, 100, 100)],
      handle: 'e',
    });

    move(controller, 20, 0);

    expect(preview).toHaveBeenCalledWith([rect('a', 0, 0, 120, 100)], EMPTY_GUIDES);
  });
});

describe('DragController · 旋转手势', () => {
  /**
   * 200×100 的卡（中心 `(100, 50)`），默认从"正右方"（方位角 0°）起手。
   *
   * `origin` 可换：测"绕着 ±180° 那一线"时必须从别的方位角起手才碰得到。
   */
  function beginRotate(overrides: { angle?: number; origin?: Point } = {}) {
    const preview = vi.fn();
    const previewRotation = vi.fn();
    const commit = vi.fn(() => true);
    const commitRotation = vi.fn(() => true);
    const resync = vi.fn();
    const controller = new DragController({
      preview,
      previewRotation,
      commit,
      commitRotation,
      resync,
    });
    controller.begin({
      kind: 'rotate',
      origin: overrides.origin ?? { x: 300, y: 50 },
      rects: [rect('a', 0, 0, 200, 100)],
      angle: overrides.angle ?? 0,
    });
    return { controller, preview, previewRotation, commit, commitRotation, resync };
  }

  /** 卡片中心（200×100 那张） */
  const hub = { x: 100, y: 50 };
  /** 距卡片中心 200px、方位角为 `deg` 的世界点 */
  function atAngle(deg: number): Point {
    const rad = (deg * Math.PI) / 180;
    return { x: hub.x + 200 * Math.cos(rad), y: hub.y + 200 * Math.sin(rad) };
  }

  it('把手柄拖到正下方 = 转 90°，且几何一次都没动过', () => {
    const { controller, preview, previewRotation } = beginRotate();

    controller.update({ x: 100, y: 250 }, {});

    expect(previewRotation).toHaveBeenCalledWith('a', 90);
    // ★ 旋转不碰几何：`preview` 一次都不该被调用（那次回调是"批量写矩形"的通道）
    expect(preview).not.toHaveBeenCalled();
  });

  it('从已经歪着的卡片继续转：手感与从正的开始一样（算的是角位移）', () => {
    const { controller, previewRotation } = beginRotate({ angle: 30 });

    controller.update({ x: 100, y: 250 }, {});

    // 30° 起手 + 90° 角位移 = 120°
    expect(previewRotation).toHaveBeenCalledWith('a', 120);
  });

  it('★ ⇧ 吸附到 15°（88° → 90°）', () => {
    const { controller, previewRotation } = beginRotate();

    controller.update(atAngle(88), { shift: true });

    expect(previewRotation).toHaveBeenCalledWith('a', 90);
  });

  it('不按 ⇧ 时不吸（该多少就是多少）', () => {
    const { controller, previewRotation } = beginRotate();

    controller.update(atAngle(88), {});

    const [, degrees] = previewRotation.mock.calls[0] as [string, number];
    expect(degrees).toBeCloseTo(88, 5);
  });

  it('★ 越过 ±180° 那一线不会跳变（角位移经过归一化）', () => {
    // 起手在"正左偏上 1°"（方位角 -179°），终点在"正左偏下 1°"（+179°）：
    // 指针其实只挪了 2°，但两个方位角直接相减是 **+358°** —— 不归一化的话
    // 卡片会当场自己转一整圈（用户只轻轻抖了一下手指）
    const { controller, previewRotation } = beginRotate({ origin: atAngle(-179) });

    controller.update(atAngle(179), {});

    const [, degrees] = previewRotation.mock.calls[0] as [string, number];
    expect(degrees).toBeCloseTo(-2, 1);
  });

  it('手抖（没越过阈值）什么都不算：既不预览也不提交', () => {
    const { controller, previewRotation, commitRotation } = beginRotate();

    // 起手点右边 0.5px：远不到阈值，这次只是一次"点了一下手柄"
    const drawn = controller.update({ x: 300.5, y: 50 }, {});

    expect(drawn).toBe(false);
    expect(previewRotation).not.toHaveBeenCalled();
    expect(commitRotation).not.toHaveBeenCalled();
  });

  it('松手提交的是**角度**（走 `commitRotation`，不碰 `commit`）', () => {
    const { controller, commit, commitRotation, resync } = beginRotate();

    controller.update({ x: 100, y: 250 }, {});
    expect(controller.finish()).toBe(true);

    expect(commitRotation).toHaveBeenCalledWith('a', 90);
    expect(commit).not.toHaveBeenCalled();
    expect(resync).not.toHaveBeenCalled();
  });

  it('★ 提交被拒（角度原样不变 / 视图没接这个能力）→ 必须 resync 撤回预览', () => {
    const { controller, commitRotation, resync } = beginRotate();
    commitRotation.mockReturnValue(false);

    controller.update({ x: 100, y: 250 }, {});
    controller.finish();

    expect(resync).toHaveBeenCalledTimes(1);
  });

  it('视图没提供 `commitRotation` 时同样走 resync（而不是把预览留在屏幕上）', () => {
    const preview = vi.fn();
    const previewRotation = vi.fn();
    const resync = vi.fn();
    const controller = new DragController({ preview, previewRotation, commit: vi.fn(), resync });
    controller.begin({
      kind: 'rotate',
      origin: { x: 300, y: 50 },
      rects: [rect('a', 0, 0, 200, 100)],
    });

    expect(controller.update({ x: 100, y: 250 }, {})).toBe(true);
    controller.finish();

    expect(resync).toHaveBeenCalledTimes(1);
  });

  it('Esc 取消：预览丢掉、从模型重画，一次都不提交', () => {
    const { controller, commitRotation, resync } = beginRotate();

    controller.update({ x: 100, y: 250 }, {});
    controller.cancel();

    expect(commitRotation).not.toHaveBeenCalled();
    expect(resync).toHaveBeenCalledTimes(1);
  });

  it('★ 旋转不参与网格吸附与参考线（哪怕把配置塞进来）', () => {
    const previewRotation = vi.fn();
    const controller = new DragController({
      preview: vi.fn(),
      previewRotation,
      commit: vi.fn(),
      resync: vi.fn(),
    });
    controller.begin({
      kind: 'rotate',
      origin: { x: 300, y: 50 },
      rects: [rect('a', 0, 0, 200, 100)],
      grid: { enabled: true, size: 16 },
      align: { others: [rect('b', 0, 0, 50, 50)], threshold: 8 },
    });

    controller.update({ x: 100, y: 250 }, {});

    // 90 不是 16 的倍数：被网格吸过的话这里会变成 80 或 96
    expect(previewRotation).toHaveBeenCalledWith('a', 90);
  });
});
