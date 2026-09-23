/**
 * 卡内嵌脑图的**几何口径**（纯逻辑）：四周留白 + "按内容算尺寸"。
 *
 * 为什么单独一个文件：这两个数被两处用 ——
 *  * 渲染层（`view/EmbedMind.ts`）拿留白算缩放；
 *  * 新建那张**内嵌脑图卡**（`F4`）时按内容算初始尺寸（用户 2026-09-21："尺寸随内容自适应"）。
 * 而 `embed/` 这一层**不许回头引 `../view/*`**（eslint 的脑图边界规则认不出那是脑图自己的
 * 视图层，见 `11 §8.2`）⇒ 数放这里，两边都往下引，不产生反向依赖。
 *
 * ★ 不 import `obsidian`、不碰 DOM：只用 `layout/` 的估算，没有 DOM 也能算。
 */

import type { Size } from '../../util/geometry';
import { directionForStructure, layoutMind } from '../layout/tree';
import type { MindFile } from '../model/schema';
import { pruneMindForEmbed } from './pruneTree';

/** 卡面四周留白（用户单位）：不留的话根节点与卡边贴在一起，看着像被裁掉了 */
export const EMBED_PADDING = 14;

/** 新建内嵌脑图卡时的尺寸上下限：太小连"根 + 一层"都看不清；太大一上来就压住整屏 */
export const INLINE_MIND_MIN_SIZE: Size = { width: 320, height: 220 };
export const INLINE_MIND_MAX_SIZE: Size = { width: 720, height: 560 };
/** 兜底尺寸：算不出外接框时用它（空脑图 / 坏数据） */
export const INLINE_MIND_FALLBACK_SIZE: Size = { width: 440, height: 300 };

/**
 * 按内容算这张卡该多大（**新建时**用）。
 *
 * ★ 用**估算**尺寸跑一遍布局（拿不到 DOM，也不想为了定尺寸先挂一次元素）—— 反正是
 *   初始尺寸，卡内那层"整体缩放到装下"（`EmbedMind.fit`）会把误差吃掉。
 * ★ 只截前几层（与渲染同一套 `pruneMindForEmbed`）：卡面本来就只画那么多，
 *   按整棵树算尺寸会得到一张"画着 3 层、却留了 10 层的空白"的卡。
 * ★ 下限 / 上限都要有：1 个节点的脑图也能点得着，2000 个节点的脑图不该撑满画布。
 */
export function mindCardSizeFor(mind: MindFile): Size {
  const pruned = pruneMindForEmbed(mind);
  const layout = layoutMind(pruned.file, {
    direction: directionForStructure(mind.view.structure ?? 'logic-right'),
  });
  const bounds = layout.bounds;
  if (!bounds) return INLINE_MIND_FALLBACK_SIZE;

  return {
    width: clamp(
      Math.round(bounds.width + EMBED_PADDING * 2),
      INLINE_MIND_MIN_SIZE.width,
      INLINE_MIND_MAX_SIZE.width,
    ),
    height: clamp(
      Math.round(bounds.height + EMBED_PADDING * 2),
      INLINE_MIND_MIN_SIZE.height,
      INLINE_MIND_MAX_SIZE.height,
    ),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
