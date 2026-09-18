/**
 * 设备档位与降级策略（T3.22 / `02 §8.1`）。
 *
 * 这里测的不是"手机上快不快"（那要靠真机基准），而是**哪台机器该降到哪一档**。
 * 判错的两种后果都不会报错、也不会崩：
 *  * 一台顶配机器被误判成弱机 → 白关一堆效果，用户觉得"这插件怎么这么难看"；
 *  * 一台老手机被当成桌面档 → 该省的没省，用户觉得"这插件怎么这么卡"。
 * 两者都只能靠单测钉住，因为它们在任何开发机上都不复现。
 */

import { describe, expect, it } from 'vitest';

import {
  DESKTOP_PROFILE,
  MOBILE_PROFILE,
  WEAK_CORE_COUNT,
  WEAK_MEMORY_GB,
  perfProfileFor,
  deviceTierOf,
  prefersReducedMotion,
  readDeviceHints,
  type DeviceHints,
} from '../../view/perfProfile';

/** 一台"什么都问不到"的设备：核数与内存都是未知（0），按**不弱**处理 */
const UNKNOWN_DEVICE: DeviceHints = {
  isMobile: false,
  hardwareConcurrency: 0,
  deviceMemory: 0,
  prefersReducedMotion: false,
};

const hints = (patch: Partial<DeviceHints>): DeviceHints => ({ ...UNKNOWN_DEVICE, ...patch });

describe('deviceTierOf', () => {
  it('移动端一律进移动档，核再多也一样', () => {
    expect(deviceTierOf(hints({ isMobile: true }))).toBe('mobile');
    // ★ 这条容易被"优化"掉：既然有 16 核，为什么要降？——因为触摸交互本身
    //   就要减少装饰（阴影 / 过渡在手指拖动时最容易被看见掉帧），
    //   而"是不是移动端"正是唯一能表达"输入方式变了"的信号。
    expect(deviceTierOf(hints({ isMobile: true, hardwareConcurrency: 16 }))).toBe('mobile');
  });

  it('桌面但核数不够 → 也降级', () => {
    expect(deviceTierOf(hints({ hardwareConcurrency: WEAK_CORE_COUNT }))).toBe('mobile');
    // 阈值是"≤ 即降级"，所以刚好高出一核就该留在桌面档
    expect(deviceTierOf(hints({ hardwareConcurrency: WEAK_CORE_COUNT + 1 }))).toBe('desktop');
  });

  it('桌面但内存不够 → 也降级', () => {
    expect(deviceTierOf(hints({ deviceMemory: WEAK_MEMORY_GB }))).toBe('mobile');
    expect(deviceTierOf(hints({ deviceMemory: WEAK_MEMORY_GB + 2 }))).toBe('desktop');
  });

  it('问不到的值（0）当成"不弱"，不能把 Safari 用户全打成弱机', () => {
    // ★ `navigator.deviceMemory` 在 Safari 上根本不存在。若把 `0` 理解成
    //   "0GB 内存"，**所有** Safari 用户都会被打进弱机档 —— 而"没问到"
    //   和"问到了、很小"是两件事，必须分开。
    expect(deviceTierOf(hints({ hardwareConcurrency: 0, deviceMemory: 0 }))).toBe('desktop');
  });
});

describe('perfProfileFor', () => {
  it('移动档在"省资源"的三项上都比桌面档小', () => {
    expect(MOBILE_PROFILE.maxPoolPerType).toBeLessThan(DESKTOP_PROFILE.maxPoolPerType);
    expect(MOBILE_PROFILE.maxDevicePixelRatio).toBeLessThan(DESKTOP_PROFILE.maxDevicePixelRatio);
    expect(MOBILE_PROFILE.cullPadding).toBeLessThan(DESKTOP_PROFILE.cullPadding);
  });

  it('桌面档与降级前完全一致（升级不改变现有观感）', () => {
    expect(DESKTOP_PROFILE.decorations).toBe(true);
    expect(DESKTOP_PROFILE.tier).toBe('desktop');
  });

  it('减少动效只关动画，不动池子与 DPR', () => {
    const profile = perfProfileFor('desktop', { prefersReducedMotion: true });
    expect(profile.decorations).toBe(false);
    expect(profile.flash).toBe(false);
    // ★ 这三者的关系是这份测试真正要守的：为了"少点动画"去砍复用池 / DPR，
    //   换来的是一台顶配机器上莫名其妙的卡顿 —— 而用户只是不想看动画。
    expect(profile.maxPoolPerType).toBe(DESKTOP_PROFILE.maxPoolPerType);
    expect(profile.maxDevicePixelRatio).toBe(DESKTOP_PROFILE.maxDevicePixelRatio);
    expect(profile.cullPadding).toBe(DESKTOP_PROFILE.cullPadding);
  });

  it('返回的是副本，不会把原始档位对象改脏', () => {
    perfProfileFor('mobile', { prefersReducedMotion: true });
    perfProfileFor('desktop', { prefersReducedMotion: true });
    // 原始对象是模块级常量、被所有视图共享，一旦被改脏就再也回不来了
    expect(DESKTOP_PROFILE.decorations).toBe(true);
    expect(DESKTOP_PROFILE.flash).toBe(true);
  });

  it('不传选项时等于不减少动效', () => {
    expect(perfProfileFor('desktop')).toEqual(DESKTOP_PROFILE);
    expect(perfProfileFor('mobile')).toEqual(MOBILE_PROFILE);
  });
});

describe('readDeviceHints', () => {
  it('拿不到任何环境信息时也不抛错，未知一律折算成 0', () => {
    // node 环境下没有 `navigator`（或没有那些非标准字段）。这里只断言
    // "不抛错、且是有限非负数" —— 具体数值随运行时而变，钉死了只会变成 flaky。
    const result = readDeviceHints(true);
    expect(result.isMobile).toBe(true);
    expect(Number.isFinite(result.hardwareConcurrency)).toBe(true);
    expect(result.hardwareConcurrency).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(result.deviceMemory)).toBe(true);
  });
});

describe('prefersReducedMotion', () => {
  it('没有 window 时按"不减少"处理', () => {
    expect(prefersReducedMotion(null)).toBe(false);
  });

  it('宿主不支持 matchMedia 也不该把视图带崩', () => {
    const view = {} as Window;
    expect(prefersReducedMotion(view)).toBe(false);
  });

  it('matchMedia 抛错时按"不减少"处理', () => {
    const view = {
      matchMedia: () => {
        throw new Error('boom');
      },
    } as unknown as Window;
    expect(prefersReducedMotion(view)).toBe(false);
  });

  it('命中 reduce 时为真', () => {
    const view = { matchMedia: () => ({ matches: true }) } as unknown as Window;
    expect(prefersReducedMotion(view)).toBe(true);
  });
});
