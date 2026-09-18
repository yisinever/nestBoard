/**
 * 画布导航的"这次按下要不要平移"判定（T1.19 / J-06）。
 *
 * ★ 只测那一个纯函数，**不测控制器本身**：真正确凿的部分（`setPointerCapture` /
 *   `getBoundingClientRect` / 指针捕获）只能在真实浏览器里验证，而本仓库的
 *   单测跑在 node 环境（`vitest.config.ts`），硬造 DOM 只会测出假通过。
 *   把判定抽出来，是为了让"四种平移入口的优先级"这东西能被守住 ——
 *   它很容易在后续改动里被无声地调换，而每一种都有一批用户的手指头在用。
 */

import { describe, expect, it } from 'vitest';
import { shouldStartPan } from '../../canvas/NavigationController';

const mouse = (button: number, onBackground: boolean) => ({
  button,
  pointerType: 'mouse',
  onBackground,
});

const state = (spacePressed: boolean, panOnEmptyDrag: boolean) => ({
  spacePressed,
  panOnEmptyDrag,
});

describe('shouldStartPan', () => {
  it('中键：在卡片上按也算平移（卡片上没有任何中键功能）', () => {
    expect(shouldStartPan(mouse(1, false), state(false, false))).toBe(true);
    expect(shouldStartPan(mouse(1, true), state(false, false))).toBe(true);
  });

  it('触屏单指：任何位置都平移（捏合走另一条路）', () => {
    expect(
      shouldStartPan({ button: 0, pointerType: 'touch', onBackground: false }, state(false, false)),
    ).toBe(true);
  });

  it('`Space`+拖动：浏览态的老习惯，位置不限', () => {
    expect(shouldStartPan(mouse(0, false), state(true, false))).toBe(true);
    expect(shouldStartPan(mouse(0, false), state(true, true))).toBe(true);
  });

  it('★ 默认（浏览态）：空白处左键拖动**不**平移 —— 那是框选', () => {
    expect(shouldStartPan(mouse(0, true), state(false, false))).toBe(false);
    expect(shouldStartPan(mouse(0, false), state(false, false))).toBe(false);
  });

  it('★ 演示态（panOnEmptyDrag）：空白处左键拖动平移，按在卡片上仍然不平移', () => {
    expect(shouldStartPan(mouse(0, true), state(false, true))).toBe(true);
    // 按在卡片上又拖动 = "想把卡挪个位置"的意图，不该把相机拽走
    expect(shouldStartPan(mouse(0, false), state(false, true))).toBe(false);
  });

  it('右键 / 第四键不平移（右键要留给上下文菜单）', () => {
    expect(shouldStartPan(mouse(2, true), state(false, true))).toBe(false);
    expect(shouldStartPan(mouse(3, true), state(true, true))).toBe(false);
  });
});
