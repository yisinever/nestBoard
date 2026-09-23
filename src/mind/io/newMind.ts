/**
 * 造一份新的 `.nestmind`（`06 §9` P0-b 的入口）。
 *
 * ★ 与 `io/newBoard.ts` 同一套分工：这里只管"库里多了一份脑图"，
 *   **不发通知、不开视图** —— 那两件事只有 UI 层做得了，也只有 UI 层知道该怎么说。
 *   于是本模块不依赖 Obsidian 运行时，可以在 node 下用假 plugin 直接单测。
 * ★ 重名顺延复用 `util/fileName` 的 `uniquePath`：附件导入 / 提升为笔记 / 新建白板
 *   走的都是它，顺延规则只该有一份。
 * ★ P0 直接走 `vaultIO.create`：**原子写 / 冲突检测 / 只读保护是 P1 的 `MindRepository`**。
 *   到时候这一行换成 `repository.create(path, file)` —— 与白板当年从裸写到 Repository
 *   的路径完全一样，调用方一个字都不用改。
 * ★ 失败**抛出**而不是返回 `null`：调用方（命令）要的是给用户一句带原因的话。
 */

import { DEFAULT_MIND_FOLDER, MIND_EXT } from '../../constants';
import { noteNameFrom, uniquePath } from '../../util/fileName';
import { t } from '../../util/i18n';
import { createMindFile } from '../model/factories';
import type { MindFile } from '../model/schema';
import { serializeMindFile } from './serialize';
import type NestboardPlugin from '../../main';

export interface NewMindOptions {
  /**
   * 用指定目录当基底（`06 §9` P1 会把设置项接上）。
   * 不传 = `DEFAULT_MIND_FOLDER`（`Minds/`）。
   */
  folder?: string;
  /** 标题；不传 = `t('mind.untitled')`。它同时是文件名的主名 */
  title?: string;
  /**
   * 用**指定的完整路径**落文件，跳过"目录 + 重名顺延"那一步。
   *
   * ★ 与 `NewBoardOptions.exactPath` 同一用途（那边是 Home 白板）：位置由调用方钉死时，
   *   再套一层顺延等于"用户说放在 A，插件悄悄放到 `A 2`"。
   */
  exactPath?: string;
}

/**
 * 造一份新脑图，返回落盘路径。
 *
 * ★ 目录每次现读（现在是常量，接上设置之后就是 `settings.*`）：用户换目录之后
 *   **下一次**新建就走新目录，不必重启 —— 与白板 `createBoardInVault` 同一条。
 */
export async function createMindInVault(
  plugin: NestboardPlugin,
  options: NewMindOptions = {},
): Promise<string> {
  const trimmed = options.title?.trim();
  const title = trimmed && trimmed.length > 0 ? trimmed : t('mind.untitled');
  return writeMindToVault(plugin, createMindFile({ title }), { ...options, title });
}

/**
 * 把**现成的一份模型**写成一份新的 `.nestmind`（`F4`：内嵌脑图卡的「导出为 `.nestmind`」）。
 *
 * ★ 与 `createMindInVault` 的差别只有一处：那边先造一份空脑图、这边写的是调用方给的模型。
 *   路径计算（目录 + 重名顺延）与落盘那一行**共用**，免得"新建"与"导出"两条路慢慢分叉。
 * ★ `updatedAt` 现取：导出的是一份**新文件**，它的时间戳该是"此刻"，而不是内嵌卡里
 *   那份模型当初被创建的时间。
 * ★ 重名顺延（`uniquePath`）在这条路上更要紧：这里**绝不覆盖**任何已有文件。
 */
export async function writeMindToVault(
  plugin: NestboardPlugin,
  file: MindFile,
  options: NewMindOptions = {},
): Promise<string> {
  const title = options.title?.trim() || file.meta.title.trim() || t('mind.untitled');
  const folder = options.folder ?? DEFAULT_MIND_FOLDER;

  const path =
    options.exactPath ??
    (await uniquePath(folder, noteNameFrom(title), `.${MIND_EXT}`, (candidate) =>
      plugin.vaultIO.exists(candidate),
    ));

  const stamped: MindFile = {
    ...file,
    meta: { ...file.meta, updatedAt: new Date().toISOString() },
  };
  await plugin.vaultIO.create(path, serializeMindFile(stamped));
  return path;
}
