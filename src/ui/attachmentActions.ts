/**
 * 「整理未使用附件」（T4.05 / `03 §4`）的 I/O 胶水层。
 *
 * 这一层只干三件事：**收集候选、收集引用、把结果交给清单**。
 * "什么算未使用"全在 `io/attachmentAudit.ts`（纯函数、有单测），
 * 删除动作**一个都不提供** —— `03 §4`：「删除附件 **绝不自动删除**。
 * 仅提供『未使用附件』清单让用户自行决定」。
 *
 * 收集口径（三份输入，缺一不可）：
 *
 *  * **候选**：附件目录里的文件（`plugin.attachmentFolderFor` 算出来的那个目录，
 *    和"拖进来时写到哪儿"是同一个答案），排除笔记 / 白板 / 点开头的目录；
 *  * **本板引用**：取自**内存里的模型**，不是磁盘 —— 磁盘上可能是节流还没落盘的旧版本，
 *    那样"刚拖进来还没保存的那张图"会被算成"没人引用"，而用户正盯着它看；
 *  * **别处引用**：其他白板的引用 + 笔记的引用（`metadataCache.resolvedLinks` 反查）。
 *
 * ★ 第三项是"宁可少报"的关键：`03 §4` 那句"用户可能别处还在用"如果只靠嘴说，
 *   用户会看到一屏"未使用"而其中一半其实是别的笔记在用的图。查一遍再列，
 *   清单短了，但它可信 —— 而这份清单的**唯一价值就是可信**。
 */

import { Notice } from 'obsidian';
import { classifyAttachments, isAttachmentCandidate, isInFolder } from '../io/attachmentAudit';
import { parseBoardFile } from '../io/boardText';
import { resolveFileInVault } from '../integration/vaultPath';
import { BOARD_EXT } from '../constants';
import type NestboardPlugin from '../main';
import { collectRefs } from '../model/links';
import { describeError } from '../util/errors';
import { t } from '../util/i18n';
import { getActiveBoardView } from '../view/BoardViewHost';
import { AttachmentAuditModal } from './modals/AttachmentAuditModal';

/** 命令入口：扫一遍当前白板的附件目录，把"没人引用"的列出来 */
export async function auditUnusedAttachments(plugin: NestboardPlugin): Promise<void> {
  const boardPath = getActiveBoardView(plugin.app)?.boardPath ?? null;
  // 命令本身只挂在白板视图上，这里是兜底（视图正在卸载的那一帧仍可能触发）
  if (boardPath === null) return;

  try {
    const folder = plugin.attachmentFolderFor(boardPath);
    const resolve = (raw: string): string | null => resolveFileInVault(plugin.app, raw, boardPath);

    const candidates: string[] = [];
    for (const path of await plugin.vaultIO.listAll()) {
      if (isInFolder(path, folder) && isAttachmentCandidate(path)) candidates.push(path);
    }
    if (candidates.length === 0) {
      new Notice(
        t('notice.attachmentAuditEmptyFolder', {
          folder: folder.length === 0 ? t('modal.attachmentAudit.scopeRoot') : folder,
        }),
      );
      return;
    }

    // 笔记那边的引用按候选集裁剪后再收集：`resolvedLinks` 是整库的链接图，
    // 全量塞进去等于为了一屏结果建一个几万条的集合
    const candidateSet = new Set(candidates);

    const boardRefs: string[] = [];
    const otherRefs: string[] = [];

    for (const boardFilePath of await plugin.vaultIO.list(BOARD_EXT)) {
      if (boardFilePath === boardPath) continue;
      const parsed = await readBoard(plugin, boardFilePath);
      if (parsed === null) continue;
      for (const ref of collectRefs(parsed)) otherRefs.push(ref.path);
    }

    // ★ 本板用内存模型（理由见文件头）
    const live = plugin.repository.get(boardPath);
    const current = live ?? (await readBoard(plugin, boardPath));
    // 读不出来（保护态 / 正在打开）时**不报错**：那时的"本板引用"是空的，
    // 结果只会把本板在用的东西也列进"没人引用" —— 太危险，直接放弃本次整理
    if (current === null) {
      new Notice(t('notice.attachmentAuditBoardUnavailable'));
      return;
    }
    for (const ref of collectRefs(current)) boardRefs.push(ref.path);

    const links = plugin.app.metadataCache.resolvedLinks;
    for (const targets of Object.values(links)) {
      for (const target of Object.keys(targets)) {
        if (candidateSet.has(target)) otherRefs.push(target);
      }
    }

    const result = classifyAttachments({ candidates, boardRefs, otherRefs, resolve });

    new AttachmentAuditModal(plugin.app, {
      folder,
      result,
      // 开在新页里：用户的意图是"看看这是什么"，不该把白板顶掉
      openFile: (path) => {
        void plugin.app.workspace.openLinkText(path, boardPath, true);
      },
    }).open();
  } catch (error) {
    // 磁盘抖动 / 某个文件读不了：报出来，但**绝不**退化成"那就当没人引用吧"
    new Notice(t('notice.attachmentAuditFailed', { message: describeError(error) }));
  }
}

/** 读 + 解析一块白板；读不了或不是白板都返回 `null`（本次整理跳过它，不报错） */
async function readBoard(plugin: NestboardPlugin, path: string) {
  try {
    return parseBoardFile(await plugin.vaultIO.read(path));
  } catch (error) {
    console.warn('[nestboard] 整理附件时读不到白板', path, describeError(error));
    return null;
  }
}
