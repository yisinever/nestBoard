/**
 * 大文件分级退化策略（T2.16 / `02 §8.3`）。
 *
 * `02 §8.3` 把白板按规模分成四档，每档给不同待遇：
 *
 * | 规模 | 策略 |
 * |---|---|
 * | < 500 卡 | 全量渲染，无提示 |
 * | 500 ~ 2000 卡 | 启用视口裁剪 + 缩略图优先；正常使用 |
 * | 2000 ~ 5000 卡 | 顶栏显示性能提示；默认折叠所有分栏；自动建议拆板 |
 * | > 5000 卡 | 提供「拆分白板」向导 |
 * | 文件 > 5MB | 提示内联卡过多，建议把长文本提升为笔记 |
 *
 * ★ 本文件是**纯逻辑**：不 import `obsidian`、不碰 DOM、不读磁盘。
 *   阈值判定一旦掺进渲染/IO，就只能靠"打开一块大板肉眼看看"，没法回归测试。
 *   这里只管"该给什么待遇"，**怎么执行**（折叠、提示、拆板）全部交给调用方。
 */

import type { MessageKey } from '../util/i18n';

/**
 * 三档阈值（卡片数）。
 *
 * ★ 与 `02 §8.3` 一一对应，改动即等于改产品策略 —— 所以集中在这里，不散落到各处
 *   写 `cards.length > 2000`。
 */
export const SCALE_LIMITS = {
  /** ≥ 此值启用视口裁剪 + 缩略图优先 */
  cull: 500,
  /** ≥ 此值顶栏提示 + 默认折叠所有分栏 + 建议拆板 */
  degrade: 2000,
  /**
   * ≥ 此值提供拆板向导。
   *
   * ★ 这是**策略**阈值（什么时候该主动提拆板），与 `model/split.ts` 的
   *   `ready`（这块板**能不能**拆成 ≥2 组）是两件事：2000~5000 卡也能拆，
   *   只是 §8.3 只在 5000 以上才把向导当作标配。
   */
  split: 5000,
} as const;

/** 单文件超过此字节数：内联卡过多（`02 §8.3` 的 5MB 线） */
export const INLINE_BYTES_WARN = 5 * 1024 * 1024;

export type ScaleTier = 'full' | 'culled' | 'degraded' | 'split';

export function scaleTierOf(cardCount: number): ScaleTier {
  // ★ NaN / 负数先归零：NaN 会让下面三个比较**全部为 false**，一路落到最激进的
  //   'split' 档 —— 一个坏数字不该让整块板被当成超大板（会白白折起全部分栏）。
  const cards = Number.isFinite(cardCount) ? Math.max(0, cardCount) : 0;
  if (cards < SCALE_LIMITS.cull) return 'full';
  if (cards < SCALE_LIMITS.degrade) return 'culled';
  if (cards < SCALE_LIMITS.split) return 'degraded';
  return 'split';
}

export interface ScaleAdvice {
  tier: ScaleTier;
  /** 打开这块板时把所有分栏折叠起来（首帧 DOM 量能少一大截） */
  collapseColumns: boolean;
  /** 是否需要在顶栏显示性能提示 */
  showHint: boolean;
  /** 是否建议拆板（提示里给「拆分白板」入口） */
  suggestSplit: boolean;
  /** 文件超 5MB：内联卡过多 */
  oversizedInline: boolean;
}

/**
 * 算出"这块板该给什么待遇"。
 *
 * @param input.cards 卡片数（负数 / 小数按 0 / 向下取整兜底：宁可少退化，不可误判）
 * @param input.fileBytes 磁盘上的文件字节数；拿不到时传 `null`（不编造 0，也不据此报警）
 */
export function scaleAdviceOf(input: { cards: number; fileBytes?: number | null }): ScaleAdvice {
  const cards = Number.isFinite(input.cards) ? Math.max(0, Math.floor(input.cards)) : 0;
  const bytes = input.fileBytes ?? null;
  const oversizedInline = bytes !== null && bytes > INLINE_BYTES_WARN;

  return {
    tier: scaleTierOf(cards),
    collapseColumns: cards >= SCALE_LIMITS.degrade,
    // 文件过大与卡片数无关：300 张卡塞满长文本一样会拖慢读写
    showHint: cards >= SCALE_LIMITS.degrade || oversizedInline,
    suggestSplit: cards >= SCALE_LIMITS.degrade,
    oversizedInline,
  };
}

/**
 * 顶栏提示要显示的文案键；无需提示时返回 `null`。
 *
 * 优先级：**拆板 > 退化 > 文件过大** —— 一次只说一件最该做的事，
 * 三条挤在一行提示里等于三条都没说。
 */
export function scaleHintKey(advice: ScaleAdvice): MessageKey | null {
  if (advice.tier === 'split') return 'scale.hint.split';
  if (advice.tier === 'degraded') return 'scale.hint.degraded';
  if (advice.oversizedInline) return 'scale.hint.oversized';
  return null;
}
