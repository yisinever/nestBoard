/**
 * 手绘控制器单元测试（T3.06 / `F4-01`、`F4-03`、`F4-06`、`F4-07`）。
 *
 * 这一层管的全是"只在特定时序下才出问题"的规则，而它们**在真机上极难复现**：
 *
 *  * 手绘态下按下卡片 —— 到底是落笔还是把卡片拖走了（"一次点击被两方消费"）；
 *  * 两根手指同时按上 —— 会不会一边画一边把画布平移出去（"一次画两笔"）；
 *  * 画到一半按 `Esc` / 切窗口 —— 那半笔是留下还是悄悄消失；
 *  * 状态机被别处带离 `INK` —— 光标与进行中的笔画有没有收干净；
 *  * 换笔时"这一笔去哪"有没有跟着换（临时标注的落点，T7.07 最容易漏的一处）。
 *
 * ★ 用**假手绘面**（只记调用）而不是真 `InkLayer`：真图层需要 2D 上下文，
 *   只能在 Obsidian 里肉眼验证；本文件只验证"控制器把指针翻译成了哪些调用"。
 * ★ 用**真** `PointerStateMachine` 与 `Viewport`：它们本身就是纯逻辑，
 *   用假货去替只会把"状态机拒绝了转移"这类真实交互掩盖掉。
 */

import { describe, expect, it, vi } from 'vitest';
import { OVERLAY_UI_ATTR } from '../../constants';
import {
  DEFAULT_INK_COLOR,
  DEFAULT_INK_WIDTH,
  INK_BRUSH_WIDTHS,
  INK_ERASER_RADIUS_PX,
  INK_MARKER_ALPHA,
  INK_MARKER_WIDTH_SCALE,
} from '../../model/ink';
import {
  INK_ERASER_CLASS,
  INK_MARKER_CLASS,
  INK_MODE_CLASS,
  InkController,
  type InkSurface,
} from '../../view/interact/InkController';
import { PointerStateMachine, type PointerMode } from '../../view/interact/PointerStateMachine';
import { Viewport } from '../../canvas/Viewport';

// ── 假图元 ──────────────────────────────────────────────

/**
 * 假画布容器。
 *
 * 只造出 `InkController` 真正用到的那几个能力：类名、聚焦、指针捕获、包围盒、
 * 以及"注册 / 派发 / 摘除"监听。★ 必须能**真正摘掉**监听（按 type + listener 精确匹配），
 * 否则 `dispose` 的用例会假绿 —— 摘不掉还继续响应才是最危险的 bug。
 */
interface FakeHost {
  classList: {
    add: (...names: string[]) => void;
    remove: (...names: string[]) => void;
    toggle: (name: string, force?: boolean) => boolean;
    contains: (name: string) => boolean;
  };
  focus: ReturnType<typeof vi.fn>;
  setPointerCapture: ReturnType<typeof vi.fn>;
  hasPointerCapture: (pointerId: number) => boolean;
  releasePointerCapture: ReturnType<typeof vi.fn>;
  getBoundingClientRect: () => DOMRect;
  addEventListener: (type: string, listener: (event: never) => void, options?: unknown) => void;
  removeEventListener: (type: string, listener: (event: never) => void, options?: unknown) => void;
  /** 测试专用：手动派发一个事件给已注册的监听器 */
  emit: (type: string, event: unknown) => void;
  /** 测试专用：还剩几个监听（`dispose` 要归零） */
  listenerCount: () => number;
}

function createHost(): FakeHost {
  const classes = new Set<string>();
  const captured = new Set<number>();
  const listeners: Array<{ type: string; listener: (event: never) => void }> = [];

  return {
    classList: {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      toggle: (name, force) => {
        const next = force ?? !classes.has(name);
        if (next) classes.add(name);
        else classes.delete(name);
        return next;
      },
      contains: (name) => classes.has(name),
    },
    focus: vi.fn(),
    setPointerCapture: vi.fn((pointerId: number) => {
      captured.add(pointerId);
    }),
    hasPointerCapture: (pointerId) => captured.has(pointerId),
    releasePointerCapture: vi.fn((pointerId: number) => {
      captured.delete(pointerId);
    }),
    // 容器贴视口左上角：屏幕坐标 == 视口坐标，用例里的数字可以直读
    getBoundingClientRect: () =>
      ({
        left: 0,
        top: 0,
        width: 800,
        height: 600,
        right: 800,
        bottom: 600,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect,
    addEventListener: (type, listener) => {
      listeners.push({ type, listener });
    },
    removeEventListener: (type, listener) => {
      const index = listeners.findIndex(
        (entry) => entry.type === type && entry.listener === listener,
      );
      if (index >= 0) listeners.splice(index, 1);
    },
    emit: (type, event) => {
      // 复制一份再派发：监听里摘自己（`dispose`）不能让本轮遍历跳项
      for (const entry of [...listeners]) if (entry.type === type) entry.listener(event as never);
    },
    listenerCount: () => listeners.length,
  };
}

interface FakePointerEvent {
  pointerId: number;
  button: number;
  clientX: number;
  clientY: number;
  /** 压感只在数位笔上取（见 `InkController.pressureOf`） */
  pointerType: string;
  pressure: number;
  /** 事件目标：画布内控件让路的判定看它（默认 `null` = 点在画布上） */
  target: unknown;
  preventDefault: ReturnType<typeof vi.fn>;
  stopImmediatePropagation: ReturnType<typeof vi.fn>;
}

function pointer(
  init: {
    id?: number;
    x?: number;
    y?: number;
    button?: number;
    type?: string;
    pressure?: number;
    target?: unknown;
  } = {},
): FakePointerEvent {
  return {
    pointerId: init.id ?? 1,
    button: init.button ?? 0,
    clientX: init.x ?? 0,
    clientY: init.y ?? 0,
    // ★ 默认 `mouse`：真实浏览器里鼠标也会报 `pressure: 0.5`，而"鼠标的压感不算"
    //   正是最容易被写错的一处 —— 让所有既有用例都走在"非数位笔"这条路上
    pointerType: init.type ?? 'mouse',
    pressure: init.pressure ?? 0.5,
    target: init.target ?? null,
    preventDefault: vi.fn(),
    stopImmediatePropagation: vi.fn(),
  };
}

/** 造一个"带 `OVERLAY_UI_ATTR` 的画布内控件"的假事件目标（只用到 `closest`） */
function overlayUiTarget(): { closest: (selector: string) => unknown } {
  return { closest: (selector: string) => (selector.includes(OVERLAY_UI_ATTR) ? {} : null) };
}

type FakeSurface = {
  [K in keyof InkSurface]: ReturnType<typeof vi.fn>;
};

function createSurface(): FakeSurface {
  return {
    beginStroke: vi.fn(),
    extendStroke: vi.fn(),
    endStroke: vi.fn(),
    eraseAt: vi.fn(() => 1),
    setStyle: vi.fn(),
    setTransient: vi.fn(),
    clearTransient: vi.fn(() => 0),
    transientCount: vi.fn(() => 0),
  };
}

function setup(
  options: {
    readOnly?: boolean;
    panning?: boolean;
    /** `false` = 图层尚未就绪 */
    surface?: boolean;
    zoom?: number;
    mode?: PointerMode;
  } = {},
) {
  const host = createHost();
  const viewport = new Viewport();
  viewport.setSize(800, 600);
  if (options.zoom !== undefined) viewport.zoomTo(options.zoom);

  const stateMachine = new PointerStateMachine();
  if (options.mode) stateMachine.request(options.mode);

  const surface = createSurface();
  const onEnter = vi.fn();
  const onExit = vi.fn();

  const controller = new InkController({
    host: host as unknown as HTMLElement,
    viewport,
    stateMachine,
    surface: () => (options.surface === false ? null : (surface as unknown as InkSurface)),
    isPanning: () => options.panning === true,
    isReadOnly: () => options.readOnly === true,
    onEnter,
    onExit,
  });

  return { controller, host, viewport, stateMachine, surface, onEnter, onExit };
}

// ── 进入 / 退出 ─────────────────────────────────────────

describe('进入与退出', () => {
  it('enter(brush)：进 INK、挂十字光标、通知"手里拿的是画笔"', () => {
    const { controller, host, stateMachine, onEnter } = setup();

    expect(controller.enter('brush')).toBe(true);
    expect(stateMachine.is('INK')).toBe(true);
    expect(controller.isActive).toBe(true);
    expect(controller.tool).toBe('brush');
    expect(host.classList.contains(INK_MODE_CLASS)).toBe(true);
    expect(host.classList.contains(INK_ERASER_CLASS)).toBe(false);
    expect(onEnter).toHaveBeenCalledWith('brush');
  });

  it('只读白板进不去（返回 false，由调用方提示），状态与光标都不动', () => {
    const { controller, host, stateMachine, onEnter } = setup({ readOnly: true });

    expect(controller.enter('brush')).toBe(false);
    expect(stateMachine.is('INK')).toBe(false);
    expect(host.classList.contains(INK_MODE_CLASS)).toBe(false);
    expect(onEnter).not.toHaveBeenCalled();
  });

  it('图层还没就绪进不去 —— 进了也只是个"点了没反应"的模式', () => {
    const { controller, stateMachine } = setup({ surface: false });

    expect(controller.enter('brush')).toBe(false);
    expect(stateMachine.is('INK')).toBe(false);
  });

  it('★ 非法状态（卡片编辑中）进不去：状态机不做隐式中转，由命令层先提交编辑', () => {
    const { controller, stateMachine } = setup({ mode: 'EDITING' });

    expect(controller.enter('brush')).toBe(false);
    expect(stateMachine.current).toBe('EDITING');
  });

  it('★ 手绘态内换笔不算失败：状态机按"同态"拒绝 INK，但那不是错误', () => {
    const { controller, host, onEnter } = setup();
    controller.enter('brush');

    expect(controller.enter('eraser')).toBe(true);
    expect(controller.tool).toBe('eraser');
    expect(host.classList.contains(INK_ERASER_CLASS)).toBe(true);
    expect(onEnter).toHaveBeenLastCalledWith('eraser');
  });

  it('exit()：回 IDLE 并摘掉光标类', () => {
    const { controller, host, stateMachine } = setup();
    controller.enter('brush');

    controller.exit();

    expect(stateMachine.is('INK')).toBe(false);
    expect(host.classList.contains(INK_MODE_CLASS)).toBe(false);
    expect(host.classList.contains(INK_ERASER_CLASS)).toBe(false);
  });

  it('★ 状态机被别处带离 INK（Esc 归状态机）时，控制器自己收摊', () => {
    const { controller, host, stateMachine } = setup();
    controller.enter('brush');

    stateMachine.escape();

    expect(host.classList.contains(INK_MODE_CLASS)).toBe(false);
  });
});

// ── 画笔 ────────────────────────────────────────────────

describe('画笔', () => {
  it('不在手绘态：按下去什么都不做（浏览态照旧拖卡片）', () => {
    const { host, surface } = setup();

    host.emit('pointerdown', pointer({ x: 100, y: 100 }));

    expect(surface.beginStroke).not.toHaveBeenCalled();
  });

  it('落笔：翻译成世界坐标的 beginStroke，并吞掉这次指针（否则卡片同时被拖走）', () => {
    const { controller, host, surface } = setup();
    controller.enter('brush');
    const event = pointer({ id: 7, x: 100, y: 50 });

    host.emit('pointerdown', event);

    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopImmediatePropagation).toHaveBeenCalled();
    // 第二个参数是压感：鼠标传 `undefined`（"这个设备不报压感"）
    expect(surface.beginStroke).toHaveBeenCalledWith({ x: 100, y: 50 }, undefined);
    // 聚焦由控制器自己做：Esc 的 keydown 挂在画布上，没焦点就收不到
    expect(host.focus).toHaveBeenCalled();
    expect(host.setPointerCapture).toHaveBeenCalledWith(7);
    expect(controller.isDrawing).toBe(true);
  });

  it('追点：同一根指针的 move → extendStroke，并吞掉 move（悬停态不该跟着笔尖闪）', () => {
    const { controller, host, surface } = setup();
    controller.enter('brush');
    host.emit('pointerdown', pointer({ id: 1, x: 0, y: 0 }));

    const move = pointer({ id: 1, x: 10, y: 10 });
    host.emit('pointermove', move);

    expect(surface.extendStroke).toHaveBeenCalledWith({ x: 10, y: 10 }, undefined);
    expect(move.preventDefault).toHaveBeenCalled();
  });

  it('★ 别的指针的 move 一律忽略（另一只鼠标 / 另一根手指与这一笔无关）', () => {
    const { controller, host, surface } = setup();
    controller.enter('brush');
    host.emit('pointerdown', pointer({ id: 1, x: 0, y: 0 }));

    const other = pointer({ id: 2, x: 50, y: 50 });
    host.emit('pointermove', other);

    expect(surface.extendStroke).not.toHaveBeenCalled();
    expect(other.preventDefault).not.toHaveBeenCalled();
  });

  it('抬笔：收尾一次，之后 move 不再往这一笔里塞点', () => {
    const { controller, host, surface } = setup();
    controller.enter('brush');
    host.emit('pointerdown', pointer({ id: 1, x: 0, y: 0 }));

    host.emit('pointerup', pointer({ id: 1, x: 5, y: 5 }));

    expect(surface.endStroke).toHaveBeenCalledTimes(1);
    expect(controller.isDrawing).toBe(false);

    host.emit('pointermove', pointer({ id: 1, x: 20, y: 20 }));
    expect(surface.extendStroke).not.toHaveBeenCalled();
  });

  it('中键 / 右键放行：平移与菜单在手绘态下都还有用，不该被吞', () => {
    const { controller, host, surface } = setup();
    controller.enter('brush');

    const middle = pointer({ button: 1, x: 10, y: 10 });
    host.emit('pointerdown', middle);

    expect(surface.beginStroke).not.toHaveBeenCalled();
    expect(middle.preventDefault).not.toHaveBeenCalled();
    expect(controller.isDrawing).toBe(false);
  });

  it('已经在平移时按下去不落笔，并把事件放行给平移（兜底：万一监听顺序被人改动）', () => {
    const { controller, host, surface } = setup({ panning: true });
    controller.enter('brush');

    const event = pointer({ x: 10, y: 10 });
    host.emit('pointerdown', event);

    expect(surface.beginStroke).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('★ 第二根指针被吞掉但不开始第二笔（否则触屏上"一根画、一根挪"两边都在动）', () => {
    const { controller, host, surface } = setup();
    controller.enter('brush');
    host.emit('pointerdown', pointer({ id: 1, x: 0, y: 0 }));

    const second = pointer({ id: 2, x: 5, y: 5 });
    host.emit('pointerdown', second);

    expect(surface.beginStroke).toHaveBeenCalledTimes(1);
    expect(second.preventDefault).toHaveBeenCalled();
    expect(second.stopImmediatePropagation).toHaveBeenCalled();
  });

  it('★ 画到一半退出：收尾但**不回滚** —— 屏幕上已经看得见的那半笔就该留下', () => {
    const { controller, host, surface, stateMachine } = setup();
    controller.enter('brush');
    host.emit('pointerdown', pointer({ id: 1, x: 0, y: 0 }));

    stateMachine.escape();

    expect(surface.endStroke).toHaveBeenCalledTimes(1);
    expect(surface.eraseAt).not.toHaveBeenCalled();
    expect(controller.isDrawing).toBe(false);
    expect(host.classList.contains(INK_MODE_CLASS)).toBe(false);
  });
});

// ── 橡皮 ────────────────────────────────────────────────

describe('橡皮', () => {
  it('落笔即擦：不开始笔画，按屏幕半径擦掉经过的笔画', () => {
    const { controller, host, surface } = setup();
    controller.enter('eraser');

    host.emit('pointerdown', pointer({ id: 1, x: 30, y: 40 }));

    expect(surface.beginStroke).not.toHaveBeenCalled();
    expect(surface.eraseAt).toHaveBeenCalledWith({ x: 30, y: 40 }, INK_ERASER_RADIUS_PX);
    expect(controller.isDrawing).toBe(true);
  });

  it('★ 半径按屏幕定、换算成世界：放大后不用瞄得更准（手感跟眼睛走）', () => {
    const { controller, host, surface, viewport } = setup({ zoom: 4 });
    controller.enter('eraser');

    host.emit('pointerdown', pointer({ id: 1, x: 0, y: 0 }));

    expect(surface.eraseAt).toHaveBeenCalledWith(
      viewport.toWorld({ x: 0, y: 0 }),
      INK_ERASER_RADIUS_PX / 4,
    );
  });

  it('拖动一路擦过去；抬笔没有"收尾"这一说', () => {
    const { controller, host, surface } = setup();
    controller.enter('eraser');
    host.emit('pointerdown', pointer({ id: 1, x: 0, y: 0 }));

    host.emit('pointermove', pointer({ id: 1, x: 10, y: 0 }));
    host.emit('pointerup', pointer({ id: 1, x: 10, y: 0 }));

    expect(surface.eraseAt).toHaveBeenCalledTimes(2);
    expect(surface.endStroke).not.toHaveBeenCalled();
    expect(controller.isDrawing).toBe(false);
  });
});

// ── dispose ─────────────────────────────────────────────

describe('dispose', () => {
  it('★ 监听真的摘干净：之后按下去不再有任何反应（假绿最危险的地方）', () => {
    const { controller, host, surface } = setup();
    controller.enter('brush');
    expect(host.listenerCount()).toBeGreaterThan(0);

    controller.dispose();
    host.emit('pointerdown', pointer({ id: 1, x: 0, y: 0 }));

    expect(host.listenerCount()).toBe(0);
    expect(surface.beginStroke).not.toHaveBeenCalled();
  });

  it('画到一半被拆除：收尾 + 释放指针捕获 + 摘光标', () => {
    const { controller, host, surface } = setup();
    controller.enter('brush');
    host.emit('pointerdown', pointer({ id: 3, x: 0, y: 0 }));

    controller.dispose();

    expect(surface.endStroke).toHaveBeenCalledTimes(1);
    expect(host.releasePointerCapture).toHaveBeenCalledWith(3);
    expect(host.classList.contains(INK_MODE_CLASS)).toBe(false);
  });

  it('退订状态机：拆完之后状态再变化也不该惊动它', () => {
    const { controller, host, stateMachine } = setup();
    controller.enter('brush');
    controller.dispose();

    expect(() => stateMachine.escape()).not.toThrow();
    expect(host.classList.contains(INK_MODE_CLASS)).toBe(false);
  });
});

// ── 笔的样式（T3.07 / `F4-02`）──────────────────────────

describe('笔的样式', () => {
  it('进手绘时把样式推给手绘层：第一笔就带着当前颜色与笔宽', () => {
    const { controller, surface } = setup();
    controller.enter('brush');

    expect(surface.setStyle).toHaveBeenCalledWith({
      color: DEFAULT_INK_COLOR,
      width: DEFAULT_INK_WIDTH,
    });
  });

  it('★ 换色**立刻**推给图层：中间不隔任何通知，所以下一笔一定用新色', () => {
    const { controller, surface } = setup();
    controller.enter('brush');
    surface.setStyle.mockClear();

    controller.setColor('#1971c2');

    expect(surface.setStyle).toHaveBeenCalledWith({ color: '#1971c2', width: DEFAULT_INK_WIDTH });
    // 换色不该顺手动正在画的笔：颜色写在每一笔上，改的是"下一笔"
    expect(surface.beginStroke).not.toHaveBeenCalled();
  });

  it('★ 没进手绘时换色也不炸（命令可用性由视图把关，控制器不该依赖调用顺序）', () => {
    const { controller, surface } = setup();

    expect(() => controller.setColor('#2f9e44')).not.toThrow();
    expect(controller.toolState.color).toBe('#2f9e44');
    // 顺手把样式推给图层是无害的（此时图层根本不可见），但绝不能抛 ——
    // 换色命令与工具条都会走到这里，抛一次就是"按下快捷键什么都没发生"
    expect(surface.setStyle).toHaveBeenCalled();
  });

  it('换到同一支颜色不发通知（反复按同一个键不该重画工具条）', () => {
    const { controller, surface } = setup();
    controller.enter('brush');
    surface.setStyle.mockClear();

    controller.setColor(DEFAULT_INK_COLOR);

    expect(surface.setStyle).not.toHaveBeenCalled();
  });

  it('`X`：换到第二支色再按一次回到原色，且中间的每次切换都推给了图层', () => {
    const { controller, surface } = setup();
    controller.enter('brush');
    surface.setStyle.mockClear();

    controller.swapColors();
    expect(controller.toolState.color).not.toBe(DEFAULT_INK_COLOR);
    controller.swapColors();

    expect(controller.toolState.color).toBe(DEFAULT_INK_COLOR);
    expect(surface.setStyle).toHaveBeenCalledTimes(2);
  });

  it('笔宽按档位取真值，越界与非法值都夹回合法档（绝不出现 0 或 NaN 线宽）', () => {
    const { controller } = setup();
    controller.enter('brush');

    controller.setWidthIndex(3);
    expect(controller.style.width).toBe(INK_BRUSH_WIDTHS[3]);
    controller.setWidthIndex(-5);
    expect(controller.style.width).toBe(INK_BRUSH_WIDTHS[0]);
    controller.setWidthIndex(Number.NaN);
    expect(controller.style.width).toBe(DEFAULT_INK_WIDTH);
  });

  it('★ 样式跨"退出再进入"保留：去改一下卡片回来，笔还是刚才那支', () => {
    const { controller } = setup();
    controller.enter('brush');
    controller.setColor('#7048e8');
    controller.setWidthIndex(3);

    controller.exit();
    controller.enter('brush');

    expect(controller.style).toEqual({ color: '#7048e8', width: INK_BRUSH_WIDTHS[3] });
  });

  it('★ `Esc` 退出手绘也要通知外面（工具条靠这个信号收摊，它收不到 `exit()`）', () => {
    const { controller, onExit } = setup();
    controller.enter('brush');

    controller.exit();

    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('拆控制器同样要发退出通知（换板 / 关视图时工具条不能留在屏幕上）', () => {
    const { controller, onExit } = setup();
    controller.enter('brush');

    controller.dispose();

    expect(onExit).toHaveBeenCalledTimes(1);
  });
});

// ── 画布内的界面控件（T3.07）────────────────────────────

describe('画布内的界面控件', () => {
  it('★ 点手绘工具条不落笔，但仍然吞掉事件（否则触屏会顺势把画布平移走）', () => {
    const { controller, host, surface } = setup();
    controller.enter('brush');
    const event = pointer({ id: 1, x: 10, y: 10, target: overlayUiTarget() });

    host.emit('pointerdown', event as unknown);

    expect(surface.beginStroke).not.toHaveBeenCalled();
    expect(controller.isDrawing).toBe(false);
    // 吞掉事件但**不** preventDefault：按钮自己的 click 得照常触发
    expect(event.stopImmediatePropagation).toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('★ 反过来：点在画布上照常落笔（让路只针对带标记的控件）', () => {
    const { controller, host, surface } = setup();
    controller.enter('brush');

    host.emit('pointerdown', pointer({ id: 1, x: 10, y: 10, target: { closest: () => null } }));

    expect(surface.beginStroke).toHaveBeenCalled();
  });

  it('目标上没有 `closest`（node 下的假事件 / 非元素目标）也不该抛异常', () => {
    const { controller, host, surface } = setup();
    controller.enter('brush');

    expect(() =>
      host.emit('pointerdown', pointer({ id: 1, x: 5, y: 5, target: 'plain-string' })),
    ).not.toThrow();
    expect(surface.beginStroke).toHaveBeenCalled();
  });
});

// ── 荧光笔（T7.08 / `F4-07`）────────────────────────────

describe('荧光笔', () => {
  it('enter(marker)：进 INK 并挂上荧光笔光标（与橡皮的方块十字分得开）', () => {
    const { controller, host, stateMachine, onEnter } = setup();

    expect(controller.enter('marker')).toBe(true);
    expect(stateMachine.is('INK')).toBe(true);
    expect(host.classList.contains(INK_MARKER_CLASS)).toBe(true);
    expect(host.classList.contains(INK_ERASER_CLASS)).toBe(false);
    expect(onEnter).toHaveBeenCalledWith('marker');
  });

  it('★ 换回画笔要摘掉荧光笔光标：光标是"现在拿的是哪支笔"的唯一实时信号', () => {
    const { controller, host } = setup();
    controller.enter('marker');

    controller.enter('brush');

    expect(host.classList.contains(INK_MARKER_CLASS)).toBe(false);
    expect(host.classList.contains(INK_MODE_CLASS)).toBe(true);
  });

  it('★ 推给图层的样式是"加粗 + 半透明"，而不是把 alpha 混进颜色里', () => {
    const { controller, surface } = setup();

    controller.enter('marker');

    expect(surface.setStyle).toHaveBeenCalledWith({
      color: DEFAULT_INK_COLOR,
      width: DEFAULT_INK_WIDTH * INK_MARKER_WIDTH_SCALE,
      alpha: INK_MARKER_ALPHA,
    });
  });

  it('★ 退出后光标类摘干净（下一个进来的笔不该继承荧光笔的样子）', () => {
    const { controller, host, stateMachine } = setup();
    controller.enter('marker');

    stateMachine.escape();

    expect(host.classList.contains(INK_MARKER_CLASS)).toBe(false);
  });
});

// ── 临时标注层（T7.07 / `F4-06`）────────────────────────

describe('临时标注层', () => {
  it('enter(annotate)：把"之后落下的笔去哪"切到暂存层', () => {
    const { controller, surface } = setup();

    controller.enter('annotate');

    expect(surface.setTransient).toHaveBeenLastCalledWith(true);
  });

  it('★ 画笔与荧光笔一律落盘 —— 只有临时标注那一支例外', () => {
    const { controller, surface } = setup();

    controller.enter('brush');
    controller.enter('marker');

    expect(surface.setTransient).toHaveBeenLastCalledWith(false);
  });

  it('★ 手绘态内换笔时"去向"跟着换：不存在"笔换了但落点没换"的中间态', () => {
    const { controller, surface } = setup();
    controller.enter('brush');
    surface.setTransient.mockClear();

    controller.enter('annotate');
    controller.enter('brush');

    expect(surface.setTransient.mock.calls.map(([flag]) => flag)).toEqual([true, false]);
  });

  it('★ 离开手绘态（`Esc`）＝ 清空：临时层长在手绘态上，不需要单独一条清空路径', () => {
    const { controller, surface, stateMachine } = setup();
    controller.enter('annotate');

    stateMachine.escape();

    expect(surface.setTransient).toHaveBeenLastCalledWith(false);
    expect(surface.clearTransient).toHaveBeenCalledTimes(1);
  });

  it('退出手绘时**先关开关再清空**：中间不留"开关还开着"的窗口', () => {
    const { controller, surface, stateMachine } = setup();
    controller.enter('annotate');

    stateMachine.escape();

    // 用调用序号比先后，而不是比调用次数 —— 次数的顺序信息是假的
    const offAt = Math.max(...surface.setTransient.mock.invocationCallOrder);
    const clearAt = Math.max(...surface.clearTransient.mock.invocationCallOrder);
    expect(offAt).toBeLessThan(clearAt);
  });

  it('★ `exit()` 也走同一条收尾：临时层不会因为"走的是命令而不是 Esc"而留下来', () => {
    const { controller, surface } = setup();
    controller.enter('annotate');

    controller.exit();

    expect(surface.clearTransient).toHaveBeenCalledTimes(1);
  });

  it('annotationCount 现取图层里的真实笔数（工具条靠它决定「清空」可不可点）', () => {
    const { controller, surface } = setup();
    surface.transientCount.mockReturnValue(3);

    expect(controller.annotationCount).toBe(3);
  });

  it('图层还没就绪时 annotationCount 是 0，而不是抛异常', () => {
    const { controller } = setup({ surface: false });

    expect(controller.annotationCount).toBe(0);
  });

  it('clearTransient 现取图层的返回值（转述"清掉了几笔"，视图据此决定要不要出声）', () => {
    const { controller, surface } = setup();
    surface.clearTransient.mockReturnValue(2);

    expect(controller.clearTransient()).toBe(2);
  });

  it('★ 清空临时层**不退出**手绘态：清了还想接着画，`Esc` 才是收工', () => {
    const { controller, stateMachine } = setup();
    controller.enter('annotate');

    controller.clearTransient();

    expect(stateMachine.is('INK')).toBe(true);
  });
});

describe('压感', () => {
  it('数位笔的压感一路传到落笔与追点', () => {
    const { controller, host, surface } = setup();
    controller.enter('brush');

    host.emit('pointerdown', pointer({ id: 1, x: 0, y: 0, type: 'pen', pressure: 0.7 }));
    host.emit('pointermove', pointer({ id: 1, x: 30, y: 0, type: 'pen', pressure: 0.3 }));

    expect(surface.beginStroke).toHaveBeenCalledWith({ x: 0, y: 0 }, 0.7);
    expect(surface.extendStroke).toHaveBeenCalledWith({ x: 30, y: 0 }, 0.3);
  });

  it('★ 鼠标的 `pressure`（恒 0.5）**不采**：用了它所有鼠标笔迹都只有半宽', () => {
    const { controller, host, surface } = setup();
    controller.enter('brush');

    host.emit('pointerdown', pointer({ id: 1, x: 0, y: 0, type: 'mouse', pressure: 0.5 }));

    expect(surface.beginStroke).toHaveBeenCalledWith({ x: 0, y: 0 }, undefined);
  });

  it('触摸的 `pressure`（多数设备恒 1）也不采 —— 设备特性不是输入', () => {
    const { controller, host, surface } = setup();
    controller.enter('brush');

    host.emit('pointerdown', pointer({ id: 1, x: 0, y: 0, type: 'touch', pressure: 1 }));

    expect(surface.beginStroke).toHaveBeenCalledWith({ x: 0, y: 0 }, undefined);
  });

  it('★ 数位笔报 0（检测到笔但没接触）当作没有：宁可用满力，也不要一条看不见的线', () => {
    const { controller, host, surface } = setup();
    controller.enter('brush');

    host.emit('pointerdown', pointer({ id: 1, x: 0, y: 0, type: 'pen', pressure: 0 }));

    expect(surface.beginStroke).toHaveBeenCalledWith({ x: 0, y: 0 }, undefined);
  });

  it('压感是 NaN 也不采（个别驱动在抬起瞬间会给出脏值）', () => {
    const { controller, host, surface } = setup();
    controller.enter('brush');

    host.emit('pointerdown', pointer({ id: 1, x: 0, y: 0, type: 'pen', pressure: Number.NaN }));

    expect(surface.beginStroke).toHaveBeenCalledWith({ x: 0, y: 0 }, undefined);
  });

  it('橡皮不看压感：擦除半径与压力无关', () => {
    const { controller, host, surface } = setup();
    controller.enter('eraser');

    host.emit('pointerdown', pointer({ id: 1, x: 0, y: 0, type: 'pen', pressure: 0.2 }));

    expect(surface.eraseAt).toHaveBeenCalledWith({ x: 0, y: 0 }, INK_ERASER_RADIUS_PX);
  });
});
