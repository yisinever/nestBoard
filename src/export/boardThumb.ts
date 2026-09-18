/**
 * 板级预览（T4.16 / `F2-8-2`、T7.09 / `F7-10`）—— 把**一整块板**画成一张小图。
 *
 * 白板卡（`cards/boardRef.ts`）要回答的问题是"这块板里长什么样"。计数行
 * （`F2-8-7`：12 张卡 / 3 个分栏）回答不了这个 —— 同样 20 张卡的板，
 * 可以是一团乱麻，也可以是四栏排得整整齐齐，而这两块板对人的意义完全不同。
 *
 * 所以这里复用 PNG 导出（`toPng.ts`）那条**模型 → Canvas** 的路，只换一套倍率。
 *
 * ★ 为什么不另画一套简化示意图（几个色块凑个"大概"）：
 *   小图的全部价值就是"一眼认出是哪块板"，而简化图恰好破坏了这一点 ——
 *   小图和真板子长得不一样，等于让用户先学会两套版本。同一套几何 + 同一套配色，
 *   看小图和看大图看到的是同一件东西。这也是 `toPng.ts` 一开始就把绘制写成
 *   纯函数（只收一个 2D 上下文）的原因：它能被第二个用途原样复用。
 *
 * ★ 本文件与 `toPng.ts` 遵从同一条约定：**不 import `obsidian`、不碰 `document`**。
 *   收一个建好的上下文，于是能在 node 下用假上下文单测。
 *
 * ★ 两种尺度，两种用途（`T7.09` 起并存）：
 *
 *  * `planBoardThumbnail` —— **最长边 = 256px**。给"落盘缓存 + 多张卡视觉一致"用：
 *    尺寸必须固定，否则缓存键与卡面观感都跟着卡的大小漂移（`io/ThumbnailCache.ts`）；
 *  * `planBoardWindow` —— **铺满给定的像素框**。给"只读小窗"用：一个 400×300 的窗口
 *    里放一张 256px 的图，会得到"四周一圈空、中间一块糊"。窗口知道自己多大，
 *    就该按自己多大去画。
 *
 *  两者共用同一套几何、配色与文字上限，所以同一块板在"缩略图 / 小窗 / 笔记嵌入"
 *  三处看到的仍是同一张图，只是分辨率不同。为什么不把缩略图也改成按卡面尺寸画：
 *  见上面第一条 —— 缩略图是**落盘缓存**的产物，`<路径>@<mtime>@<size>` 这个键
 *  一旦掺进卡面尺寸，同一个文件会为每种卡面尺寸各缓存一份。
 */

import { THUMB_SIZE } from '../io/ThumbnailCache';
import type { BoardFile } from '../model/schema';
import {
  planPngExport,
  renderTile,
  resolveExportBounds,
  type PngPalette,
  type PngTile,
} from './toPng';

/**
 * 缩略图四周留白（世界坐标 px）。
 *
 * ★ 比导出用的 `DEFAULT_PNG_PADDING`（32）小得多：那个值是给"要拿去当图片用"的
 *   导出留的边。缩略图只有 256px —— 在 3000px 宽的板上，32px 世界留白换算过来
 *   还不到 3px（等于没有），但在只有两三张卡的小板上，它会吃掉整张图的四分之一，
 *   表现就是"预览里的东西比真板子小一圈"。
 */
export const BOARD_THUMB_PADDING = 8;

/**
 * 卡片正文行数上限。取 4 与笔记里的板嵌入（`BoardEmbed` 的 `EMBED_MAX_LINES`）一致：
 * 两者都是"缩小看"的用途，同一个上限能让同一块板在两处看起来是同一张图。
 */
export const BOARD_THUMB_MAX_LINES = 4;

export interface BoardThumbPlan {
  /** 唯一的瓦片 = 整板外接框（已向外对齐到整数世界像素） */
  tile: PngTile;
  /** 世界坐标 → 缩略图像素的倍率（**只缩不放**） */
  scale: number;
  /** 画布尺寸（`tile` × `scale` 取整，至少 1px） */
  width: number;
  height: number;
}

/**
 * 规划缩略图：整板一页、最长边 = `max`。
 *
 * 返回 `null` = 没什么可画（空板：没有卡片也没有分栏）。空板**不生成缩略图**：
 * 一张纯背景的图与"读取失败"在卡面上长得一模一样，而概要面板本来就会替它说
 * "0 张卡"——后者至少是句话。
 */
export function planBoardThumbnail(
  board: BoardFile,
  max: number = THUMB_SIZE,
): BoardThumbPlan | null {
  const bounds = resolveExportBounds(board, { range: 'all', padding: BOARD_THUMB_PADDING });
  if (!bounds) return null;

  // ★ 借 `planPngExport` 只为了拿"向外对齐后的外接框"：`alignTile` 是那边的私有函数，
  //   而这件对齐必须与 PNG 导出完全一致（差 1px 就是从边上裁掉一条内容）。
  //   它算出来的 `scale` 在这里**用不上** —— 那个倍率会被 canvas 硬上限（`HARD_MAX_CANVAS_SIDE`）
  //   按 8192 兜底，而缩略图要的是 256，两者目标不同，所以下面自己算。
  const plan = planPngExport(bounds, { range: 'all', scale: 1, paginate: false });
  const tile = plan.tiles[0];
  if (!tile) return null;

  const side = Math.max(tile.width, tile.height);
  // 只缩不放：一块只有两行卡片的板放大到 256px 只会得到一张糊图，
  // 而且"放大"意味着画布上的字形被拉大，看起来像坏了
  const scale = side > 0 ? Math.min(1, max / side) : 1;

  return {
    tile,
    scale,
    width: Math.max(1, Math.round(tile.width * scale)),
    height: Math.max(1, Math.round(tile.height * scale)),
  };
}

/**
 * 只读小窗四周留白（世界坐标 px）。
 *
 * ★ 比缩略图的 `BOARD_THUMB_PADDING`（8）多一点：小窗是**用来看的**，
 *   内容贴到边框上会显得被卡住。缩略图是"认出是哪块板"，留白越少越能看清轮廓。
 */
export const BOARD_WINDOW_PADDING = 12;

/**
 * 小窗画布的**设备像素**上限（单边）。
 *
 * 卡面尺寸是用户拖出来的（再大也大不过屏幕），但笔记里的 `height:` 是**直接写进
 * 文件的数字** —— `height: 100000` 会让一次 `planBoardWindow` 申请一块几百 MB 的画布。
 * 4000 比任何真实窗口都大：4K 屏上一张卡占满全屏也只有约 2000 设备像素高。
 */
export const MAX_BOARD_WINDOW_SIDE = 4000;

export interface BoardWindowPlan extends BoardThumbPlan {
  /**
   * 建议的 CSS 尺寸（设备像素 ÷ `dpr`）。
   *
   * 调用方**应当按它设画布的 CSS 宽高**，而不是让画布吃满容器：
   * 画布的后备像素与显示像素 1:1 时不用重采样，字最清楚。
   */
  cssWidth: number;
  cssHeight: number;
}

/**
 * 规划只读小窗：内容**装进** `cssWidth × cssHeight` 的框，背景**铺满**那个框。
 *
 * 与 `planBoardThumbnail` 的三点差别：
 *
 *  1. **两个方向都要满足**（`min(w/x, h/y)`），缩略图只看最长边；
 *  2. **铺满**：算完倍率后把瓦片向外扩到整框 —— 否则一块宽板 400×300 的窗口里
 *     会上下各留一条空，看起来像"贴在图上的小照片"，而不是"一扇窗"。扩出去的部分
 *     由板自己的背景（含点阵 / 网格）填上；
 *  3. **按设备像素算**：调用方量到的是 CSS 像素，而画布的像素是 CSS × `dpr`
 *     （Retina 上直接按 CSS 像素画，字会糊一半）。
 *
 * 返回 `null` = 没什么可画：空板（与缩略图同一条理由，让概要面板去说"0 张卡"）
 * 或框小到画不出东西（刚 append、还没布局时量的就是 0）。
 *
 * `scale` 仍然**只缩不放**：小窗是"看内容"，不是放大镜 —— 放大只会把 12px 的字
 * 拉成 24px 的糊字。板比窗口小时，多出来的地方由背景铺满，内容居中。
 */
export function planBoardWindow(
  board: BoardFile,
  cssWidth: number,
  cssHeight: number,
  dpr = 1,
): BoardWindowPlan | null {
  if (!Number.isFinite(cssWidth) || !Number.isFinite(cssHeight)) return null;
  if (cssWidth < 1 || cssHeight < 1) return null;
  const ratio = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;

  // 先夹上限再算倍率：夹晚了 `scale` 就是按没夹的框算出来的，白算一遍
  const maxWidth = Math.min(MAX_BOARD_WINDOW_SIDE, Math.max(1, Math.round(cssWidth * ratio)));
  const maxHeight = Math.min(MAX_BOARD_WINDOW_SIDE, Math.max(1, Math.round(cssHeight * ratio)));

  const bounds = resolveExportBounds(board, { range: 'all', padding: BOARD_WINDOW_PADDING });
  if (!bounds) return null;

  // 借 `planPngExport` 只为拿"向外对齐后的外接框"，与缩略图同一条理由（见上）
  const plan = planPngExport(bounds, { range: 'all', scale: 1, paginate: false });
  const tile = plan.tiles[0];
  if (!tile || tile.width <= 0 || tile.height <= 0) return null;

  const scale = Math.min(1, maxWidth / tile.width, maxHeight / tile.height);
  if (!(scale > 0)) return null;

  // 铺满：瓦片在**世界坐标**里向外扩，扩多少算出来就是多少 —— 不需要先算像素再反推。
  // ★ 这里会失去 `alignTile` 的整数对齐：扩出去的是一圈空白背景，不载内容，
  //   所以不存在"差 1px 裁掉一条内容"的问题（那个理由只对**裁**成立）。
  // `index/column/row` 恒为 0：小窗**永远只有一页**（`paginate: false` 那条路）。
  // 它们只在分页导出里用来提示"第几块"，这里给别的值反而是错的。
  const grown: PngTile = {
    index: 0,
    column: 0,
    row: 0,
    x: tile.x - (maxWidth / scale - tile.width) / 2,
    y: tile.y - (maxHeight / scale - tile.height) / 2,
    width: maxWidth / scale,
    height: maxHeight / scale,
  };

  return {
    tile: grown,
    scale,
    width: maxWidth,
    height: maxHeight,
    cssWidth: maxWidth / ratio,
    cssHeight: maxHeight / ratio,
  };
}

/**
 * 按规划把板画进 `ctx`。
 *
 * ★ 名字里的 "Thumbnail" 指的是**这条路径的出身**（第一版只服务 256px 缩略图），
 *   不是入参限制：它只认 `BoardThumbPlan`（`tile` + `scale`），所以
 *   `planBoardWindow` 的规划同样能交给它画 —— 小窗与缩略图共用一条绘制路径，
 *   正是"同一块板在三处长得一样"的实现方式。
 *
 * `images` 故意留成可选、且生产调用**不传**：为了一张小图去 decode
 * 目标板里几十张 4K 原图，正是 `io/ThumbnailCache.ts` 开头写明要避免的事
 * （那会把内存打爆）。缺席时 `renderTile` 把图片卡画成占位块 ——
 * 版式、分栏、卡片颜色、连线、文字都还在，与笔记里嵌入同一块板看到的是同一张图。
 */
export function paintBoardThumbnail(
  ctx: CanvasRenderingContext2D,
  board: BoardFile,
  plan: BoardThumbPlan,
  palette: PngPalette,
  images?: ReadonlyMap<string, CanvasImageSource>,
): void {
  renderTile(ctx, board, plan.tile, {
    scale: plan.scale,
    transparent: false,
    background: board.view.background,
    gridSize: board.settings.gridSize,
    palette,
    maxLines: BOARD_THUMB_MAX_LINES,
    images,
  });
}
