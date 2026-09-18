/**
 * 缩略图导航器面板的单元测试（T5.09 / `F1-06`）。
 *
 * 几何在 `minimapGeometry.test.ts` 里钉过了，这里钉**它与视图的契约**：
 *
 *  * 点在地图上的哪儿 → 世界坐标是多少（这是整个功能里最"悄悄错"的一环）；
 *  * 拖动是"按住才连续动"，松手之后鼠标划过地图**不许**再拽画布；
 *  * 内容指纹没变就一个 DOM 都不写（这条路径每次自动保存都会走到）；
 *  * 相机没动就不重写视口框（每帧都会走到）；
 *  * 键盘 Enter 回到内容中心 —— 它是画布上唯一一个只有鼠标能用的东西的反面。
 *
 * 假 DOM 没有布局（`clientWidth` 是 `undefined`），所以盒子走 `FALLBACK_BOX`；
 * 断言里凡是涉及坐标的，都用同一套几何函数算期望值，不硬编码数字 ——
 * 否则改动几何常数时这些测试会变成"必须跟着改的一堆魔法数"。
 */

import { describe, expect, it, vi } from 'vitest';
import { createBoardFile, createCard, createColumn } from '../../model/factories';
import type { BoardFile } from '../../model/schema';
import { Minimap } from '../../ui/MinimapPanel';
import {
  contentBounds,
  minimapShapes,
  planMinimap,
  toMapRect,
  toWorldPoint,
  viewportWorldRect,
  type MinimapCamera,
} from '../../ui/minimapGeometry';
import { t } from '../../util/i18n';
import { type FakeElement, createFakeDocument, createFakeElement } from '../helpers/fakeDom';

/** 假 DOM 没有布局，面板量不到尺寸 —— 见 `Minimap.ts` 的 `FALLBACK_BOX` */
const BOX = { width: 176, height: 116 };

function board(cards: BoardFile['cards'] = [], columns: BoardFile['columns'] = []): BoardFile {
  return createBoardFile({ cards, columns });
}

function card(x: number, y: number, width = 200, height = 100): BoardFile['cards'][number] {
  return createCard('note', { x, y, width, height });
}

/** 指针事件在单测里是手工造的：面板只读这几个字段 */
interface FakePointer {
  pointerId: number;
  button: number;
  clientX: number;
  clientY: number;
  defaultPrevented: boolean;
  preventDefault: () => void;
}

function pointer(
  init: Partial<Omit<FakePointer, 'preventDefault' | 'defaultPrevented'>> = {},
): FakePointer {
  const event: FakePointer = {
    pointerId: 1,
    button: 0,
    clientX: 0,
    clientY: 0,
    defaultPrevented: false,
    preventDefault: () => {
      event.defaultPrevented = true;
    },
    ...init,
  };
  return event;
}

function setup(cards: BoardFile['cards'] = [], columns: BoardFile['columns'] = []) {
  const doc = createFakeDocument();
  const parent = createFakeElement(doc);
  const state: { board: BoardFile | null; camera: MinimapCamera } = {
    board: board(cards, columns),
    camera: { x: 0, y: 0, zoom: 1, width: 1000, height: 800 },
  };
  const onNavigate = vi.fn();
  const onRequestHide = vi.fn();

  const panel = new Minimap(parent as unknown as HTMLElement, {
    shapes: () => minimapShapes(state.board),
    camera: () => state.camera,
    onNavigate,
    onRequestHide,
  });

  // 结构：root = [head, surface]；head = [title, hide]；surface = [map]；map = [viewport, ...格子]
  const root = parent.children[0] as FakeElement;
  const head = root.children[0] as FakeElement;
  const surface = root.children[1] as FakeElement;
  const map = surface.children[0] as FakeElement;
  const viewport = map.children[0] as FakeElement;
  const shapes = () => map.children.slice(1) as FakeElement[];

  return {
    doc,
    parent,
    panel,
    state,
    onNavigate,
    onRequestHide,
    root,
    head,
    title: head.children[0] as FakeElement,
    hide: head.children[1] as FakeElement,
    surface,
    map,
    viewport,
    shapes,
  };
}

/** 数一个元素上 `style.setProperty` 被调了几次（用来证明"没变就不写"） */
function countStyleWrites(el: FakeElement): () => number {
  const original = el.style.setProperty;
  let writes = 0;
  el.style.setProperty = (name: string, value: string) => {
    writes += 1;
    original(name, value);
  };
  return () => writes;
}

describe('显示与隐藏', () => {
  it('初始是隐藏的（默认关：不占画布）', () => {
    const { panel, root } = setup([card(0, 0)]);
    expect(panel.isVisible).toBe(false);
    expect(root.classList.contains('is-hidden')).toBe(true);
  });

  it('★ 显示时立刻画一版：隐藏期间量不到尺寸，光靠每帧的相机同步补不回来', () => {
    const { panel, shapes } = setup([card(0, 0)]);
    panel.syncContent(); // 隐藏状态下调它不该建 DOM
    expect(shapes()).toHaveLength(0);
    panel.setVisible(true);
    expect(shapes()).toHaveLength(1);
  });

  it('隐藏状态下同步内容不建任何格子', () => {
    const { panel, shapes } = setup([card(0, 0), card(500, 0)]);
    panel.setVisible(false);
    panel.syncContent();
    expect(shapes()).toHaveLength(0);
  });

  it('重复设同一个可见性不重复同步', () => {
    const { panel, shapes } = setup([card(0, 0)]);
    panel.setVisible(true);
    const first = shapes()[0];
    panel.setVisible(true);
    expect(shapes()[0]).toBe(first);
  });
});

describe('格子渲染', () => {
  it('分栏在前、卡片在后（与世界里的压盖关系一致）', () => {
    const { panel, shapes } = setup([card(0, 0)], [createColumn({ x: 0, y: 0 })]);
    panel.setVisible(true);
    expect(shapes().map((el) => el.className)).toEqual([
      'nestboard-minimap__shape is-column',
      'nestboard-minimap__shape is-card',
    ]);
  });

  it('写进样式的几何与几何函数算出来的一致', () => {
    const b = board([card(0, 0, 400, 200), card(600, 300, 100, 100)]);
    const list = minimapShapes(b);
    const plan = planMinimap(contentBounds(list), BOX)!;

    const { panel, state, shapes } = setup();
    state.board = b;
    panel.setVisible(true);

    const els = shapes();
    list.forEach((shape, i) => {
      const rect = toMapRect(plan, shape.rect);
      expect(els[i].style.getPropertyValue('transform')).toBe(
        `translate(${rect.x}px, ${rect.y}px)`,
      );
      expect(els[i].style.getPropertyValue('width')).toBe(`${rect.width}px`);
      expect(els[i].style.getPropertyValue('height')).toBe(`${rect.height}px`);
    });
  });

  it('没有内容时不画格子，也不画视口框', () => {
    const { panel, shapes, viewport } = setup([]);
    panel.setVisible(true);
    expect(shapes()).toHaveLength(0);
    expect(viewport.classList.contains('is-hidden')).toBe(true);
  });

  it('卡片减少时摘掉多出来的末尾元素', () => {
    const { panel, state, shapes } = setup([card(0, 0), card(500, 0), card(1000, 0)]);
    panel.setVisible(true);
    expect(shapes()).toHaveLength(3);
    state.board = board([card(0, 0)]);
    panel.syncContent();
    expect(shapes()).toHaveLength(1);
  });

  it('★ 只是挪了一下：复用同一个元素（不重建 DOM），但位置要跟着重写', () => {
    const { panel, state, shapes } = setup([card(0, 0), card(600, 0)]);
    panel.setVisible(true);
    const before = shapes()[0];
    const transformBefore = before.style.getPropertyValue('transform');
    // 两张卡时挪一张会改变包围盒 —— 所以地图位置**一定**要变
    // （一块板只有一张卡时挪它，地图上是不动的：包围盒跟着它走，这是对的）
    state.board = board([card(300, 200), card(600, 0)]);
    panel.syncContent();
    const after = shapes()[0];
    expect(after).toBe(before);
    expect(after.style.getPropertyValue('transform')).not.toBe(transformBefore);
  });

  it('★ 指纹没变就一个格子都不重画（自动保存每次都会走到这条路径）', () => {
    const { panel, shapes } = setup([card(0, 0)]);
    panel.setVisible(true);
    const writes = countStyleWrites(shapes()[0]);
    panel.syncContent();
    panel.syncContent();
    expect(writes()).toBe(0);
  });
});

describe('视口框', () => {
  it('画的是相机反推出来的那一块，且位置与几何一致', () => {
    const b = board([card(0, 0, 800, 600)]);
    const list = minimapShapes(b);
    const plan = planMinimap(contentBounds(list), BOX)!;

    const { panel, state, viewport } = setup();
    state.board = b;
    panel.setVisible(true);
    const camera = { x: -100, y: -50, zoom: 2, width: 1000, height: 800 };
    state.camera = camera;
    panel.syncCamera();

    const rect = toMapRect(plan, viewportWorldRect(camera)!);
    expect(viewport.classList.contains('is-hidden')).toBe(false);
    expect(viewport.style.getPropertyValue('transform')).toBe(
      `translate(${rect.x}px, ${rect.y}px)`,
    );
    expect(viewport.style.getPropertyValue('width')).toBe(`${rect.width}px`);
  });

  it('★ 相机没动就不重写（这条路径每帧都会走到）', () => {
    const { panel, state, viewport } = setup([card(0, 0, 800, 600)]);
    panel.setVisible(true);
    state.camera = { x: -100, y: -50, zoom: 2, width: 1000, height: 800 };
    panel.syncCamera();
    const writes = countStyleWrites(viewport);
    panel.syncCamera();
    panel.syncCamera();
    expect(writes()).toBe(0);
  });

  it('地图上还没有内容时同步相机什么都不做（没有映射可用）', () => {
    const { panel, viewport } = setup([]);
    panel.setVisible(true);
    const writes = countStyleWrites(viewport);
    panel.syncCamera();
    expect(writes()).toBe(0);
    expect(viewport.classList.contains('is-hidden')).toBe(true);
  });

  it('隐藏状态下同步相机不写 DOM（每帧都会走到这条路径）', () => {
    const { panel, viewport } = setup([card(0, 0)]);
    const writes = countStyleWrites(viewport);
    panel.syncCamera();
    expect(writes()).toBe(0);
  });
});

describe('指针定位', () => {
  it('★ 点在地图左上留白处 → 跳到对应的世界坐标', () => {
    const b = board([card(-500, -300, 4000, 2000)]);
    const list = minimapShapes(b);
    const plan = planMinimap(contentBounds(list), BOX)!;

    const { panel, state, surface, onNavigate } = setup();
    state.board = b;
    panel.setVisible(true);

    const local = { x: 40, y: 30 };
    surface.emit('pointerdown', pointer({ clientX: local.x, clientY: local.y }));
    expect(onNavigate).toHaveBeenCalledTimes(1);
    const world = onNavigate.mock.calls[0][0] as { x: number; y: number };
    const expected = toWorldPoint(plan, local);
    expect(world.x).toBeCloseTo(expected.x, 6);
    expect(world.y).toBeCloseTo(expected.y, 6);
  });

  it('按下之后拖动会连续定位；松手后鼠标划过不再定位', () => {
    const { panel, surface, onNavigate } = setup([card(0, 0, 800, 600)]);
    panel.setVisible(true);

    surface.emit('pointerdown', pointer({ clientX: 10, clientY: 10 }));
    expect(onNavigate).toHaveBeenCalledTimes(1);

    surface.emit('pointermove', pointer({ clientX: 60, clientY: 20 }));
    expect(onNavigate).toHaveBeenCalledTimes(2);

    surface.emit('pointerup', pointer({ clientX: 60, clientY: 20 }));
    surface.emit('pointermove', pointer({ clientX: 90, clientY: 20 }));
    expect(onNavigate).toHaveBeenCalledTimes(2);
  });

  it('★ 没按住就划过地图不许拽画布（`pointermove` 的默认分支）', () => {
    const { panel, surface, onNavigate } = setup([card(0, 0, 800, 600)]);
    panel.setVisible(true);
    surface.emit('pointermove', pointer({ clientX: 50, clientY: 50 }));
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('非主键按下不定位（中键是画布的平移手势）', () => {
    const { panel, surface, onNavigate } = setup([card(0, 0)]);
    panel.setVisible(true);
    surface.emit('pointerdown', pointer({ button: 1 }));
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('按下会 `preventDefault`（别让浏览器顺手拖出一片选中文字）', () => {
    const { panel, surface } = setup([card(0, 0)]);
    panel.setVisible(true);
    const event = pointer({ clientX: 20, clientY: 20 });
    surface.emit('pointerdown', event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('没有内容时按下去不定位（没有映射）', () => {
    const { panel, surface, onNavigate } = setup([]);
    panel.setVisible(true);
    surface.emit('pointerdown', pointer({ clientX: 20, clientY: 20 }));
    expect(onNavigate).not.toHaveBeenCalled();
  });
});

describe('键盘', () => {
  it('★ Enter 回到内容中心（地图上"第几格是哪张卡"对键盘用户没有意义）', () => {
    const b = board([card(0, 0, 200, 100), card(1000, 500, 200, 100)]);
    const bounds = contentBounds(minimapShapes(b))!;

    const { panel, state, surface, onNavigate } = setup();
    state.board = b;
    panel.setVisible(true);

    surface.emit('keydown', { key: 'Enter', preventDefault: vi.fn() });
    expect(onNavigate).toHaveBeenCalledTimes(1);
    const world = onNavigate.mock.calls[0][0] as { x: number; y: number };
    expect(world.x).toBeCloseTo(bounds.x + bounds.width / 2, 6);
    expect(world.y).toBeCloseTo(bounds.y + bounds.height / 2, 6);
  });

  it('空格同样有效，并且会掐掉浏览器随后合成的那次 click', () => {
    const { panel, surface, onNavigate } = setup([card(0, 0)]);
    panel.setVisible(true);
    const preventDefault = vi.fn();
    surface.emit('keydown', { key: ' ', preventDefault });
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(preventDefault).toHaveBeenCalled();
  });

  it('别的键不管（方向键在画布上是移动选中的卡片）', () => {
    const { panel, surface, onNavigate } = setup([card(0, 0)]);
    panel.setVisible(true);
    surface.emit('keydown', { key: 'ArrowRight', preventDefault: vi.fn() });
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('没有内容时 Enter 不定位', () => {
    const { panel, surface, onNavigate } = setup([]);
    panel.setVisible(true);
    surface.emit('keydown', { key: 'Enter', preventDefault: vi.fn() });
    expect(onNavigate).not.toHaveBeenCalled();
  });
});

describe('面板本身', () => {
  it('点关闭键走"请视图隐藏我"这条路（面板自己不改持久化）', () => {
    const { panel, hide, onRequestHide } = setup([card(0, 0)]);
    panel.setVisible(true);
    hide.emit('click', {});
    expect(onRequestHide).toHaveBeenCalledTimes(1);
    // 面板不自己藏起来：可见状态只有一个来源（设置），由视图改完再推回来
    expect(panel.isVisible).toBe(true);
  });

  it('文案与无障碍名都来自 i18n', () => {
    const { title, surface, root, hide } = setup([card(0, 0)]);
    expect(title.textContent).toBe(t('minimap.title'));
    expect(root.getAttribute('aria-label')).toBe(t('minimap.title'));
    expect(surface.getAttribute('aria-label')).toBe(t('minimap.surface'));
    expect(hide.getAttribute('aria-label')).toBe(t('minimap.hide'));
    expect(surface.getAttribute('type')).toBe('button');
  });

  it('地图内部对读屏隐藏（几百个装饰性子元素没有语义）', () => {
    const { map } = setup([card(0, 0)]);
    expect(map.getAttribute('aria-hidden')).toBe('true');
  });

  it('拆掉时把自己从父节点摘掉', () => {
    const { panel, parent } = setup([card(0, 0)]);
    expect(parent.children).toHaveLength(1);
    panel.dispose();
    expect(parent.children).toHaveLength(0);
  });
});
