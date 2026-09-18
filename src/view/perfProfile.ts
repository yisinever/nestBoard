/**
 * 设备性能档位与降级策略（T3.22 / `02 §8.1`）。
 *
 * `02 §8.1` 的指标是"**手机 300 卡 ≥ 40fps**"。这条数字没有"魔法开关"能一键达成 ——
 * 它是前面所有手段（单容器变换、视口裁剪、DOM 复用池、脏区重绘）叠加的结果。
 * 本文件负责最后一段：**同一套代码，在弱设备上主动少做一点**。
 *
 * ★ 为什么做成一张"档位表"而不是散落的 `if (Platform.isMobile)`：
 *   散落的判断会让"手机上的行为"分布在十几个文件里，改一处忘一处，
 *   整机表现就是一堆互相矛盾的个例。集中成一份 `PerfProfile` 之后，
 *   "弱设备上到底降了什么"是一个可以一眼看完、也可以单测的清单。
 *
 * ★ 判断与取值分开：
 *   * `deviceTierOf(hints)` 与 `perfProfileFor(tier)` 都是**纯函数**，可在 node 下单测；
 *   * `readDeviceHints()` 是唯一碰 `navigator` / `matchMedia` 的地方。
 *   这样"弱机降级"这条规则的正确性不依赖跑在什么机器上。
 *
 * ★ 不 import `obsidian`：`Platform.isMobile` 由视图层读出来塞进 `DeviceHints`，
 *   本文件保持可在非 Obsidian 环境复用（`03 §7.2` 的依赖方向）。
 */

/** 设备档位。**只有两档**：降级要么全做、要么不做，中间档没有可验证的收益 */
export type DeviceTier = 'mobile' | 'desktop';

/** 一次降级决策所需的全部外部事实 */
export interface DeviceHints {
  /** 是不是移动端（视图层传 `Platform.isMobile`） */
  isMobile: boolean;
  /** 逻辑核数（`navigator.hardwareConcurrency`）。取不到传 0 = 未知，按不弱处理 */
  hardwareConcurrency: number;
  /** 设备内存 GB（`navigator.deviceMemory`，非标准）。取不到传 0 = 未知 */
  deviceMemory: number;
  /** 用户是否要求减少动效（`prefers-reduced-motion: reduce`，T3.26） */
  prefersReducedMotion: boolean;
}

/** 一份可执行的降级清单 */
export interface PerfProfile {
  tier: DeviceTier;
  /** 每类卡片的 DOM 复用池上限（见 `CardLayer` 的 `MAX_POOL_PER_TYPE`） */
  maxPoolPerType: number;
  /** 位图与画布层的 DPR 上限（见 `CanvasLayer` 的 `MAX_DEVICE_PIXEL_RATIO`） */
  maxDevicePixelRatio: number;
  /** 视口裁剪外扩（世界像素，见 `Viewport.visibleBounds`）。越小、DOM 里留的卡越少 */
  cullPadding: number;
  /** 阴影 / 过渡这类"好看但费钱"的效果（关闭后由 styles.css 的 `.is-lite` 兜住） */
  decorations: boolean;
  /** 搜索定位的闪烁高亮。`prefers-reduced-motion` 下也要关（T3.26） */
  flash: boolean;
}

/**
 * 弱机判据的阈值。
 *
 * ★ 桌面玩家也可能只有 2 核（老笔记本 / 虚拟机 / 资源受限的容器）——
 *   所以"是不是移动端"只是**其中一条**进水口，不是唯一一条。
 *   把 `Platform.isMobile` 当成唯一条件，等于默认"桌面一定跑得动"，
 *   而这在 4K 外接屏 + 5000 卡白板的场景下并不成立。
 */
export const WEAK_CORE_COUNT = 2;
export const WEAK_MEMORY_GB = 2;

/** 未知值统一用 0 表示"没问到"，**不能**当成"很弱" —— 拿不到就别降级 */
const UNKNOWN = 0;

/** 桌面档：与 T3.22 之前的行为**完全一致**，升级不改变现有观感 */
export const DESKTOP_PROFILE: PerfProfile = {
  tier: 'desktop',
  maxPoolPerType: 64,
  maxDevicePixelRatio: 3,
  cullPadding: 200,
  decorations: true,
  flash: true,
};

/**
 * 移动档：三件事，按"省下来的量"从大到小排 ——
 *
 * | 项 | 桌面 | 移动 | 为什么 |
 * |---|---|---|---|
 * | `maxPoolPerType` | 64 | 24 | 池子占的是**常驻内存**，手机上这是最稀缺的资源 |
 * | `maxDevicePixelRatio` | 3 | 2 | `3² / 2² = 2.25`：位图内存直接省掉一半以上 |
 * | `cullPadding` | 200 | 120 | 屏幕外多留的每一张卡都是白建的 DOM |
 *
 * ★ 池子上限降到 24 是**有代价**的：手机上来回平移，"离场又回来"的卡片会更频繁
 *   重建节点。但重建只是慢一帧，内存爆掉是直接崩 —— 这个取舍在移动端没有悬念。
 */
export const MOBILE_PROFILE: PerfProfile = {
  tier: 'mobile',
  maxPoolPerType: 24,
  maxDevicePixelRatio: 2,
  cullPadding: 120,
  decorations: false,
  flash: true,
};

/**
 * 这一台该用哪档（T3.22）。
 *
 * 命中任意一条即降级：
 *  1. 移动端；
 *  2. 核数已知且 ≤ {@link WEAK_CORE_COUNT}；
 *  3. 内存已知且 ≤ {@link WEAK_MEMORY_GB} GB。
 *
 * ★ 第 2、3 条都要求"已知"（`> 0`）。`navigator.deviceMemory` 在 Safari 上根本不存在，
 *   若把 `0` 当成"0GB 内存"会把**所有** Safari 用户打成弱机档 ——
 *   而"没问到"与"问到了、很小"是两件事。
 */
export function deviceTierOf(hints: DeviceHints): DeviceTier {
  if (hints.isMobile) return 'mobile';
  if (hints.hardwareConcurrency > UNKNOWN && hints.hardwareConcurrency <= WEAK_CORE_COUNT) {
    return 'mobile';
  }
  if (hints.deviceMemory > UNKNOWN && hints.deviceMemory <= WEAK_MEMORY_GB) return 'mobile';
  return 'desktop';
}

/**
 * 档位 + 无障碍偏好 → 一份最终清单。
 *
 * ★ `prefers-reduced-motion` 与设备性能是**两个正交的轴**：一台顶配 Mac 上
 *   也可能有人因为前庭功能敏感而关掉所有动画。合并成一个判断的话，
 *   "高性能 = 一定放动画"就会把这类用户的要求吞掉。
 */
export function perfProfileFor(
  tier: DeviceTier,
  options: { prefersReducedMotion?: boolean } = {},
): PerfProfile {
  const base = tier === 'mobile' ? MOBILE_PROFILE : DESKTOP_PROFILE;
  if (!options.prefersReducedMotion) return base;
  // 减少动效时只关动画，**不动**池子与 DPR —— 那两项与"动不动"无关
  return { ...base, decorations: false, flash: false };
}

/**
 * 读当前环境（唯一一处碰 `navigator` / `matchMedia`）。
 *
 * `isMobile` 由调用方传入：只有视图层认识 Obsidian 的 `Platform`。
 */
export function readDeviceHints(isMobile: boolean): DeviceHints {
  return {
    isMobile,
    hardwareConcurrency: readNumber(() => navigator.hardwareConcurrency),
    deviceMemory: readNumber(
      () => (navigator as Navigator & { deviceMemory?: number }).deviceMemory,
    ),
    prefersReducedMotion: prefersReducedMotion(),
  };
}

/** 是否偏好减少动效（T3.26）。拿不到 `matchMedia`（node / 老环境）时按"不减少"处理 */
export function prefersReducedMotion(
  view: Window | null = typeof window === 'undefined' ? null : window,
): boolean {
  try {
    return view?.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  } catch {
    return false;
  }
}

/** 读一个可能不存在 / 可能抛错的数值属性，任何异常都折算成"未知" */
function readNumber(read: () => unknown): number {
  try {
    const value = read();
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : UNKNOWN;
  } catch {
    return UNKNOWN;
  }
}
