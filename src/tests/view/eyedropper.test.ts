/**
 * 取色会话的单元测试（T3.05 / `F2.6`）。
 *
 * 会话是"连点两下"这类问题的唯一防线，而这些行为**在真环境里极难复现**：
 * 一次点击被采两次、按 `Esc` 退不出去、拖拽与取色同时发生 —— 每一条都要靠
 * 反复手点才能撞出来。这里用假 DOM 把它们一次性钉住：
 *
 *  * **一次会话只采一次**，采完立刻收摊（连摘监听一起）；
 *  * **`Esc` / 右键必须退得出去**，而且退出后不再响应任何点击；
 *  * **吞掉那一次点击**（不吞就是在取色的同时把卡片拖走了）；
 *  * 没取到时**分门别类**地说原因（点空处 / 点在留白 / 像素透明 / 没能力）。
 */

import { describe, expect, it, vi } from 'vitest';
import type { PixelSamplerBridge } from '../../cards/registry';
import type { HexColor, ImageFit } from '../../model/schema';
import { EYEDROPPER_CLASS, EyedropperSession } from '../../view/interact/eyedropper';
import type { EyedropperSource } from '../../view/interact/eyedropper';
import { createFakeDocument, createFakeElement, createKeyEvent } from '../helpers/fakeDom';

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 假 `<img>`：会话只读自然尺寸与包围盒 */
function fakeImage(box: Box, natural: { width: number; height: number }): HTMLImageElement {
  return {
    naturalWidth: natural.width,
    naturalHeight: natural.height,
    getBoundingClientRect: () => ({
      left: box.x,
      top: box.y,
      width: box.width,
      height: box.height,
      right: box.x + box.width,
      bottom: box.y + box.height,
      x: box.x,
      y: box.y,
      toJSON: () => ({}),
    }),
  } as unknown as HTMLImageElement;
}

function imageSource(
  box: Box,
  natural: { width: number; height: number },
  fit: ImageFit = 'contain',
): EyedropperSource {
  return { cardId: 'image-1', path: 'assets/参考.png', image: fakeImage(box, natural), fit };
}

/** 100,100 起、200×100 的图（自然尺寸 400×200）：点图正中 → 源像素 (200,100) */
function defaultSource(): EyedropperSource {
  return imageSource({ x: 100, y: 100, width: 200, height: 100 }, { width: 400, height: 200 });
}

function pointerEvent(init: { x?: number; y?: number; button?: number } = {}) {
  return {
    button: init.button ?? 0,
    clientX: init.x ?? 0,
    clientY: init.y ?? 0,
    target: null,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    stopImmediatePropagation: vi.fn(),
  };
}

/** 让采样那个 promise 落地（真实定时器：本文件不用假时钟） */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function setup(
  options: { source?: EyedropperSource | null; color?: HexColor | null; sampler?: boolean } = {},
) {
  const doc = createFakeDocument();
  const host = createFakeElement(doc);
  const keyTarget = createFakeElement(doc);
  const source: EyedropperSource | null =
    options.source === undefined ? defaultSource() : options.source;

  const samplePixel = vi.fn(async () => (options.color === undefined ? '#4c8dff' : options.color));
  const onPick = vi.fn();
  const onMiss = vi.fn();
  const onEnd = vi.fn();

  const session = new EyedropperSession({
    host: host as unknown as HTMLElement,
    keyTarget: keyTarget as unknown as EventTarget,
    sampler:
      options.sampler === false ? undefined : ({ samplePixel } as unknown as PixelSamplerBridge),
    resolve: () => source,
    onPick,
    onMiss,
    onEnd,
  });

  return { session, host, keyTarget, samplePixel, onPick, onMiss, onEnd, source };
}

describe('进入与退出', () => {
  it('start 挂上十字光标类，active 变真', () => {
    const { session, host } = setup();
    session.start();
    expect(host.classList.contains(EYEDROPPER_CLASS)).toBe(true);
    expect(session.active).toBe(true);
  });

  it('Esc 退出：静默收摊（用户主动取消，不必再说什么）', () => {
    const { session, host, keyTarget, onMiss, onEnd } = setup();
    session.start();
    const event = createKeyEvent({ key: 'Escape' });

    keyTarget.emit('keydown', event);

    expect(event.defaultPrevented).toBe(true);
    // 不放行：画布自己也认 Esc（取消选区、退出编辑态），不该顺手把别的也取消掉
    expect(event.propagationStopped).toBe(true);
    expect(host.classList.contains(EYEDROPPER_CLASS)).toBe(false);
    expect(session.active).toBe(false);
    expect(onMiss).not.toHaveBeenCalled();
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('右键退出：连菜单都不弹（弹了还得再点一次取消）', () => {
    const { session, host, onEnd } = setup();
    session.start();
    const event = { preventDefault: vi.fn(), stopImmediatePropagation: vi.fn() };

    host.emit('contextmenu', event);

    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopImmediatePropagation).toHaveBeenCalled();
    expect(host.classList.contains(EYEDROPPER_CLASS)).toBe(false);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('Esc 以外的按键不受影响（画布快捷键照旧）', () => {
    const { session, keyTarget, onEnd } = setup();
    session.start();
    const event = createKeyEvent({ key: 'ArrowDown' });

    keyTarget.emit('keydown', event);

    expect(event.defaultPrevented).toBe(false);
    expect(event.propagationStopped).toBe(false);
    expect(onEnd).not.toHaveBeenCalled();
    expect(session.active).toBe(true);
  });

  it('退出之后不再响应点击与按键（监听确实摘干净了）', async () => {
    const { session, host, keyTarget, samplePixel, onEnd } = setup();
    session.start();

    keyTarget.emit('keydown', createKeyEvent({ key: 'Escape' }));
    host.emit('pointerdown', pointerEvent({ x: 200, y: 150 }));
    keyTarget.emit('keydown', createKeyEvent({ key: 'Escape' }));
    await flush();

    expect(samplePixel).not.toHaveBeenCalled();
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('cancel 幂等：视图拆除时无条件调一次，不会重复回调', () => {
    const { session, onEnd } = setup();
    session.start();
    session.cancel();
    session.cancel();
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('重复 start 不会挂两套监听（否则一次点击被采两次）', async () => {
    const { session, host, samplePixel } = setup();
    session.start();
    session.start();

    host.emit('pointerdown', pointerEvent({ x: 200, y: 150 }));
    await flush();

    expect(samplePixel).toHaveBeenCalledTimes(1);
  });

  it('没有采样能力时直接说"不支持"，而不是进入一个点了没反应的模式', () => {
    const { session, host, onMiss, onEnd } = setup({ sampler: false });
    session.start();

    expect(onMiss).toHaveBeenCalledWith('unavailable');
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(session.active).toBe(false);
    expect(host.classList.contains(EYEDROPPER_CLASS)).toBe(false);
  });
});

describe('点图片取色', () => {
  it('点图正中 → 采到那一格像素，颜色交给调用方，会话结束', async () => {
    // 显式传同一个源：采样参数要精确到"哪一张 `<img>`"
    const source = defaultSource();
    const { session, host, samplePixel, onPick, onEnd } = setup({ source });
    session.start();

    host.emit('pointerdown', pointerEvent({ x: 200, y: 150 }));
    await flush();

    expect(samplePixel).toHaveBeenCalledWith(source.image, { x: 200, y: 100 });
    expect(onPick).toHaveBeenCalledWith('#4c8dff', {
      cardId: 'image-1',
      path: 'assets/参考.png',
    });
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(session.active).toBe(false);
    expect(host.classList.contains(EYEDROPPER_CLASS)).toBe(false);
  });

  it('吞掉那一次点击：不放行的话，取色的同时会把卡片拖走', () => {
    const { session, host } = setup();
    session.start();
    const event = pointerEvent({ x: 200, y: 150 });

    host.emit('pointerdown', event);

    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopImmediatePropagation).toHaveBeenCalled();
  });

  it('一次会话只采一次：采完立刻收摊，第二下点击什么都不做', async () => {
    const { session, host, samplePixel } = setup();
    session.start();

    host.emit('pointerdown', pointerEvent({ x: 200, y: 150 }));
    host.emit('pointerdown', pointerEvent({ x: 120, y: 120 }));
    await flush();

    expect(samplePixel).toHaveBeenCalledTimes(1);
  });

  it('中键（平移）放行：它本来就不触发取色，模式也留着', () => {
    const { session, host, samplePixel } = setup();
    session.start();
    const event = pointerEvent({ x: 200, y: 150, button: 1 });

    host.emit('pointerdown', event);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(samplePixel).not.toHaveBeenCalled();
    expect(session.active).toBe(true);
  });

  it('采样取不到（透明像素 / 脏画布）→ 明说取不到，而不是悄悄结束', async () => {
    const { session, host, onPick, onMiss, onEnd } = setup({ color: null });
    session.start();

    host.emit('pointerdown', pointerEvent({ x: 200, y: 150 }));
    await flush();

    expect(onPick).not.toHaveBeenCalled();
    expect(onMiss).toHaveBeenCalledWith('noColor');
    expect(onEnd).toHaveBeenCalledTimes(1);
  });
});

describe('点不在图上', () => {
  it('点空白 / 别的卡片 → "请点图片卡上的图片"，不采样', () => {
    const { session, host, samplePixel, onMiss } = setup({ source: null });
    session.start();

    host.emit('pointerdown', pointerEvent({ x: 5, y: 5 }));

    expect(samplePixel).not.toHaveBeenCalled();
    expect(onMiss).toHaveBeenCalledWith('notImage');
    expect(session.active).toBe(false);
  });

  it('点在 contain 的留白里 → "这一点落在图片之外"（不夹到边缘取邻居色）', () => {
    // 400×100 的图装进 200×200 的框：内容只有中间那条 200×50（y 从 75 到 125）
    const source = imageSource(
      { x: 0, y: 0, width: 200, height: 200 },
      { width: 400, height: 100 },
    );
    const { session, host, samplePixel, onMiss } = setup({ source });
    session.start();

    host.emit('pointerdown', pointerEvent({ x: 100, y: 20 }));

    expect(samplePixel).not.toHaveBeenCalled();
    expect(onMiss).toHaveBeenCalledWith('outside');
  });
});
