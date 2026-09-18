/**
 * `.canvas`（JSON Canvas 1.0）→ `.nboard` 导入（T4.12 / `F9-05`）。
 *
 * 为什么需要它：`.canvas` 是 Obsidian 自带、别家插件与别家工具都认识的中转格式。
 * 有了这条入口，"别人给我的画布"能直接变成一块**真白板**继续编辑 —— 而不是一张截图、
 * 或者一段需要手工重摆的笔记。互转规则本身在 `export/jsonCanvas.ts`（纯函数、有单测），
 * 本模块只管"从哪读、写到哪、怎么跟用户说话"这三件事。
 *
 * ★ 落盘位置：**紧挨着那张 `.canvas`**，同名。不落到设置里的"新建白板目录"——
 *   用户在自己整理好的目录里导入，结果文件跑到另一个地方去，是最容易被骂的那种设计。
 *   真需要搬家的话，白板自己就有「重命名 / 移动」（T1.73）。
 * ★ 重名**顺延**而不是覆盖：`uniquePath` 与新建白板、附件导入共用同一套规则。
 * ★ 导入**不改原文件**：`.canvas` 原样留着。用户可能还要在自带画布里接着用它，
 *   而"导入把一个文件吃掉"是不可逆的。
 */

import { Notice } from 'obsidian';
import { BOARD_EXT, CANVAS_EXT } from '../constants';
import { importCanvas, parseCanvasFile } from '../export/jsonCanvas';
import { describeError } from '../util/errors';
import { splitName, uniquePath } from '../util/fileName';
import { t } from '../util/i18n';
import { openBoardView } from '../view/BoardViewHost';
import { VaultFilePickerModal } from './modals/VaultFilePickerModal';
import type NestboardPlugin from '../main';

/**
 * 命令入口：先挑一张 `.canvas`，再导入。
 *
 * ★ 先 `list` 一遍再开选择器：库里一张画布都没有时，开出来的是一个空列表 ——
 *   用户只会以为"选择器坏了"。一句"库里没有 .canvas 文件"才是他要知道的事。
 *   （`list` 走的是 Obsidian 已经建好的文件索引，不是磁盘遍历。）
 */
export async function importCanvasFile(plugin: NestboardPlugin): Promise<void> {
  try {
    const files = await plugin.vaultIO.list(CANVAS_EXT);
    if (files.length === 0) {
      new Notice(t('notice.importCanvasNoFiles'));
      return;
    }

    // ★ 取消也要回调 `null`（`VaultFilePickerModal` 的约定），这里什么都不做即可 ——
    //   用户按 Esc 就是"算了"，不该再弹一句什么
    new VaultFilePickerModal(plugin.app, [CANVAS_EXT], (path) => {
      if (path) void importCanvasAtPath(plugin, path);
    }).open();
  } catch (error) {
    new Notice(t('notice.importCanvasFailed', { message: describeError(error) }));
  }
}

/**
 * 导入指定路径的 `.canvas`。
 *
 * 文件右键菜单直接调它（用户已经在文件树上指着那张画布了，再让他挑一次是多余的）。
 */
export async function importCanvasAtPath(
  plugin: NestboardPlugin,
  canvasPath: string,
): Promise<void> {
  try {
    const raw = await plugin.vaultIO.read(canvasPath);
    const parsed = parseCanvasFile(raw);
    if (!parsed.ok) {
      // ★ "文件坏了"与"这压根不是画布"要分开说：前者建议重新导出，后者建议检查文件，
      //   给同一句话会让用户按错的方向去查
      new Notice(
        parsed.reason === 'json'
          ? t('notice.importCanvasBadJson', { name: canvasPath })
          : t('notice.importCanvasBadShape', { name: canvasPath }),
      );
      return;
    }

    const { dir, base } = splitName(canvasPath);
    const result = importCanvas(parsed.canvas, { title: base });
    if (!result.ok) {
      new Notice(t('notice.importCanvasEmpty'));
      return;
    }

    // 新板沿用设置里的默认背景（与「新建白板」同一条规则）：导入出来的板子也是一块
    // 新板子，用户没理由在两处看到不一样的底色
    result.board.view.background = plugin.settings.defaultBackground;

    const target = await uniquePath(dir, base, `.${BOARD_EXT}`, (candidate) =>
      plugin.vaultIO.exists(candidate),
    );
    await plugin.repository.createBoard(target, result.board);
    // 登记进白板索引（T1.63）：不登记的话，这块新板不会出现在面包屑、白板卡选择器里
    await plugin.registry.upsert(target);

    // 导入完直接打开：用户点「导入」的意图是"我要看 / 我要接着画这块板"
    await openBoardView(plugin.app, target);

    const { cards, columns, edges, skippedNodes, skippedEdges } = result.report;
    new Notice(
      skippedNodes + skippedEdges > 0
        ? t('notice.importCanvasPartial', {
            cards,
            columns,
            edges,
            nodes: skippedNodes,
            edges2: skippedEdges,
          })
        : t('notice.importCanvasDone', { cards, columns, edges }),
    );
  } catch (error) {
    new Notice(t('notice.importCanvasFailed', { message: describeError(error) }));
  }
}
