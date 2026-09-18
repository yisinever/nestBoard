/**
 * 模板库的动作层（`T4.14` / `F7-06`）：两个入口。
 *
 * 1. **从模板新建白板**（`openTemplateLibrary`）—— 列模板 → 选中 → 落一块新板 → 打开它。
 * 2. **把当前板另存为模板**（`openSaveTemplateDialog`）—— 问一个名字 → 写进模板目录。
 *
 * ── 三条规则写在这一层，别的层不再重复 ──
 *
 * * **落板走 `io/newBoard.ts`**：它是全插件唯一的"落一个白板文件"实现，
 *   目录来自设置、重名顺延、注册表登记三条规则只有那一份代码。
 * * **模板文件走 `io/templateLibrary.ts`**：扫描 / 解析 / 顺延都在那儿，
 *   这一层只负责"给用户说话"（通知与错误文案）。
 * * **取消要说得出话**：对话框的回到值是 `null` = 用户按了 Esc，
 *   这时候**什么都不做**，不是"用第一个模板"或者"报个错"。
 *
 * ★ 失败一律**弹通知 + 收工**，不抛给命令层：命令层没有地方显示它。
 */

import { Notice } from 'obsidian';

import { createBoardInVault } from '../io/newBoard';
import { listUserTemplates, readTemplate, saveBoardAsTemplate } from '../io/templateLibrary';
import type NestboardPlugin from '../main';
import { builtinTemplateById } from '../model/templates';
import type { BoardFile } from '../model/schema';
import { describeError } from '../util/errors';
import { t } from '../util/i18n';
import { openBoardView } from '../view/BoardViewHost';
import { SaveTemplateModal } from './modals/SaveTemplateModal';
import { TemplateModal, type TemplateChoice } from './modals/TemplateModal';

/** 目录为空 = 库根；提示文案里说"库根目录"，而不是给用户看一对空引号 */
function displayFolder(folder: string): string {
  return folder.length > 0 ? folder : t('settings.folder.vaultRoot');
}

/**
 * 打开模板库，让用户挑一个模板建板。
 *
 * ★ 列表要**先扫后弹**：扫描是异步的（要读目录下每一份模板），先弹一个空对话框
 *   再往里塞内容，用户会在那半秒里以为"一份模板都没有"。
 * ★ 扫不出来（目录权限 / IO 出错）也**照常弹**：内置模板不依赖磁盘，
 *   一句"我的模板读不出来"总好过整条命令点了没反应。
 */
export async function openTemplateLibrary(plugin: NestboardPlugin): Promise<void> {
  let userTemplates: Awaited<ReturnType<typeof listUserTemplates>>['templates'] = [];
  let skipped = 0;

  try {
    const list = await listUserTemplates(plugin);
    userTemplates = list.templates;
    skipped = list.skipped;
  } catch (error) {
    new Notice(t('notice.templateListFailed', { error: describeError(error) }));
  }

  new TemplateModal(plugin.app, {
    userTemplates,
    skipped,
    boardFolder: displayFolder(plugin.settings.newBoardFolder),
    onDone: (choice) => {
      void instantiateChoice(plugin, choice);
    },
  }).open();
}

/** 选中的模板 → 一块新板。`choice` 为 `null` = 取消 */
async function instantiateChoice(
  plugin: NestboardPlugin,
  choice: TemplateChoice | null,
): Promise<void> {
  if (!choice) return;

  const template = await resolveTemplate(plugin, choice);
  if (!template) return;

  try {
    // 标题取模板名：新板一打开就有名字，用户想改再改（比一屏"未命名白板"有用）
    const path = await createBoardInVault(plugin, { template, title: choice.name });
    new Notice(t('notice.templateCreated', { name: choice.name, path }));
    // 建完直接打开：挑模板的人想的是"开始做这件事"，不是"在库里多一个文件"
    await openBoardView(plugin.app, path);
  } catch (error) {
    new Notice(t('notice.templateCreateFailed', { error: describeError(error) }));
  }
}

/** 把选项解析成一份模板板；解析不了就自己弹通知并返回 `null` */
async function resolveTemplate(
  plugin: NestboardPlugin,
  choice: TemplateChoice,
): Promise<BoardFile | null> {
  if (choice.kind === 'builtin') {
    const builtin = builtinTemplateById(choice.id);
    // 选项是刚从这个表里列出来的，取不到只可能是有人在两次点击之间改了代码
    return builtin ? builtin.build() : null;
  }

  try {
    const template = await readTemplate(plugin, choice.path);
    if (template) return template;
    // 文件读到了、但内容不是一份板 —— 与"读不出来"共用一句话，只是原因不同
    new Notice(
      t('notice.templateUnreadable', {
        path: choice.path,
        error: t('notice.templateInvalid'),
      }),
    );
    return null;
  } catch (error) {
    new Notice(t('notice.templateUnreadable', { path: choice.path, error: describeError(error) }));
    return null;
  }
}

/**
 * 「另存为模板」：问一个名字，然后把**眼前这块板**复制进模板目录。
 *
 * ★ 传进来的是 `BoardView` 手里那份**内存里的板**（不是重新读文件）：
 *   会话是防抖保存的，用户刚摆好的那几张卡很可能还没落盘，
 *   而"另存为模板"要的显然是他眼前的样子。
 */
export function openSaveTemplateDialog(plugin: NestboardPlugin, board: BoardFile): void {
  new SaveTemplateModal(plugin.app, {
    defaultName: board.meta.title.trim().length > 0 ? board.meta.title : t('board.untitled'),
    folder: displayFolder(plugin.settings.templateFolder),
    onSubmit: (name) => {
      void runSaveTemplate(plugin, board, name);
    },
  }).open();
}

async function runSaveTemplate(
  plugin: NestboardPlugin,
  board: BoardFile,
  name: string,
): Promise<void> {
  try {
    const path = await saveBoardAsTemplate(plugin, board, name);
    new Notice(t('notice.templateSaved', { path }));
  } catch (error) {
    new Notice(t('notice.templateSaveFailed', { error: describeError(error) }));
  }
}
