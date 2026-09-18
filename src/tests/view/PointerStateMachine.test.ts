/**
 * `PointerStateMachine` 单元测试（T1.29 —— `02 §3`）。
 *
 * 状态机是交互层的总闸：错了的表现是"编辑卡片时按 D 突然进了手绘"、
 * "在 IDLE 下把用户的 ⌘S 吃掉了"这种很难复现的怪事。这里把三条关键约定逐条钉死。
 */

import { describe, expect, it, vi } from 'vitest';
import {
  isPointerTransitionAllowed,
  PointerStateMachine,
  type PointerMode,
} from '../../view/interact/PointerStateMachine';

describe('isPointerTransitionAllowed（星形状态图）', () => {
  it('同态恒合法（幂等）', () => {
    for (const mode of ['IDLE', 'EDITING', 'INK', 'CONNECTING'] as PointerMode[]) {
      expect(isPointerTransitionAllowed(mode, mode)).toBe(true);
    }
  });

  it('往返 IDLE 合法', () => {
    expect(isPointerTransitionAllowed('IDLE', 'EDITING')).toBe(true);
    expect(isPointerTransitionAllowed('IDLE', 'INK')).toBe(true);
    expect(isPointerTransitionAllowed('IDLE', 'CONNECTING')).toBe(true);
    expect(isPointerTransitionAllowed('EDITING', 'IDLE')).toBe(true);
    expect(isPointerTransitionAllowed('INK', 'IDLE')).toBe(true);
    expect(isPointerTransitionAllowed('CONNECTING', 'IDLE')).toBe(true);
  });

  it('非 IDLE 之间直连非法（必须先回 IDLE）', () => {
    expect(isPointerTransitionAllowed('EDITING', 'INK')).toBe(false);
    expect(isPointerTransitionAllowed('EDITING', 'CONNECTING')).toBe(false);
    expect(isPointerTransitionAllowed('INK', 'CONNECTING')).toBe(false);
    expect(isPointerTransitionAllowed('CONNECTING', 'INK')).toBe(false);
  });
});

describe('PointerStateMachine', () => {
  it('初始为 IDLE', () => {
    expect(new PointerStateMachine().current).toBe('IDLE');
  });

  it('IDLE → EDITING / INK / CONNECTING 都能进入', () => {
    for (const mode of ['EDITING', 'INK', 'CONNECTING'] as PointerMode[]) {
      const machine = new PointerStateMachine();
      expect(machine.request(mode)).toBe(true);
      expect(machine.is(mode)).toBe(true);
    }
  });

  it('非法转移被拒绝，且状态不变', () => {
    const machine = new PointerStateMachine();
    machine.request('EDITING');
    expect(machine.request('INK')).toBe(false);
    expect(machine.current).toBe('EDITING');
  });

  it('请求当前状态不产生变化（返回 false，不派发事件）', () => {
    const machine = new PointerStateMachine();
    machine.request('INK');
    const listener = vi.fn();
    machine.onChange(listener);
    expect(machine.request('INK')).toBe(false);
    expect(listener).not.toHaveBeenCalled();
  });

  it('变化时派发 from/to', () => {
    const machine = new PointerStateMachine();
    const listener = vi.fn();
    machine.onChange(listener);

    machine.request('EDITING');
    expect(listener).toHaveBeenCalledWith({ from: 'IDLE', to: 'EDITING' });

    machine.escape();
    expect(listener).toHaveBeenLastCalledWith({ from: 'EDITING', to: 'IDLE' });
  });

  it('escape 是万能退出键；已在 IDLE 时返回 false（不白吃这个键）', () => {
    const machine = new PointerStateMachine();
    expect(machine.escape()).toBe(false);

    for (const mode of ['EDITING', 'INK', 'CONNECTING'] as PointerMode[]) {
      const m = new PointerStateMachine();
      m.request(mode);
      expect(m.escape()).toBe(true);
      expect(m.current).toBe('IDLE');
    }
  });

  it('★ 只有 EDITING 拦截键盘', () => {
    const idle = new PointerStateMachine();
    expect(idle.capturesKeyboard).toBe(false);

    const editing = new PointerStateMachine();
    editing.request('EDITING');
    expect(editing.capturesKeyboard).toBe(true);

    for (const mode of ['INK', 'CONNECTING'] as PointerMode[]) {
      const m = new PointerStateMachine();
      m.request(mode);
      expect(m.capturesKeyboard).toBe(false);
    }
  });

  describe('handleKey', () => {
    it('EDITING：一律不消费（preventDefault 会让人真的打不出字）', () => {
      const machine = new PointerStateMachine();
      machine.request('EDITING');

      expect(machine.handleKey('d')).toBe(false);
      expect(machine.handleKey('Escape')).toBe(false);
      // Esc 在编辑态由编辑器负责调用 escape()，而不是靠画布吃掉按键
      expect(machine.current).toBe('EDITING');
      expect(machine.escape()).toBe(true);
      expect(machine.current).toBe('IDLE');
    });

    it('IDLE：Esc 放行（返回 false），不抢占 Obsidian 热键', () => {
      const machine = new PointerStateMachine();
      expect(machine.handleKey('Escape')).toBe(false);
      expect(machine.handleKey('d')).toBe(false);
    });

    it('INK：V 放行给 Obsidian 命令（键位可被用户改），Esc 仍可退出', () => {
      const machine = new PointerStateMachine();
      machine.request('INK');

      expect(machine.handleKey('v')).toBe(false);
      expect(machine.current).toBe('INK');

      expect(machine.handleKey('Escape')).toBe(true);
      expect(machine.current).toBe('IDLE');
    });

    it('CONNECTING：Esc 取消连线', () => {
      const machine = new PointerStateMachine();
      machine.request('CONNECTING');
      expect(machine.handleKey('Escape')).toBe(true);
      expect(machine.current).toBe('IDLE');
    });
  });

  it('退订后不再收到通知', () => {
    const machine = new PointerStateMachine();
    const listener = vi.fn();
    const unsubscribe = machine.onChange(listener);

    machine.request('INK');
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    machine.escape();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('dispose 回到 IDLE 并清空监听', () => {
    const machine = new PointerStateMachine();
    const listener = vi.fn();
    machine.onChange(listener);
    machine.request('EDITING');

    machine.dispose();
    expect(machine.current).toBe('IDLE');
    expect(machine.escape()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
