/**
 * Home 白板 / 收件箱的两个动作（T5.07 / `F7-03` / `F11-09`）。
 *
 * 与 `ui/AddToBoard.ts` 是一对：那个问"放哪块板"，这个**不问** ——
 * Home 存在的全部意义就是"有一个不用问的答案"。
 *
 * ## 为什么这两个动作值得各占一条命令
 *
 * - **打开 Home**（`F7-03`）：白板多了以后，"先想要去哪块板"本身就是负担。
 *   Home 把入口固定成一个地址（`settings.homeBoardPath`），按键即达；
 * - **添加到收件箱**（`F7-03` 的"默认落点"）：手上这篇笔记还不确定属于哪块板时，
 *   先丢进收件箱、回头再整理 —— 这一步**不能**再弹一个选择器，
 *   否则"默认落点"就退化成了"又一次让你选"。
 *
 * ## 未配置时的处理
 *
 * `settings.homeBoardPath === ''` 是**关掉**（见 `settings/settings.ts` 的注释）。
 * 这时两个动作都只提示"去设置里填路径"，而**不**顺手新建一块板 ——
 * 用户明确关掉了这个功能，插件替他"热心地"打开它是最讨人厌的那种自作主张。
 */

import { Notice } from 'obsidian';

import type NestboardPlugin from '../main';
import { ensureHomeBoard } from '../io/homeBoard';
import { describeError } from '../util/errors';
import { t } from '../util/i18n';
import { openBoardView } from '../view/BoardViewHost';

/**
 * 打开 Home 白板（没有就按设置的路径建一块）。
 *
 * 同步签名，方便命令回调 / 菜单回调直接调用（回调的返回值会被忽略，
 * 返回 Promise 只会变成一个没人处理的引用 —— 同 `ui/AddToBoard.ts`）。
 */
export function openHomeBoard(plugin: NestboardPlugin): void {
  void (async () => {
    const path = await resolveHome(plugin);
    if (!path) return;
    await openBoardView(plugin.app, path);
  })();
}

/**
 * 把 `sourcePath` 放进 Home 的收件箱 —— "新建卡片的默认落点"。
 */
export function addFileToUnsorted(plugin: NestboardPlugin, sourcePath: string): void {
  void (async () => {
    const path = await resolveHome(plugin);
    if (!path) return;

    const view = await openBoardView(plugin.app, path);
    // ★ 落点由视图算（它才知道收件箱那一栏在哪），这里只问一句"放进收件箱"：
    //   见 `BoardView.addFilesToUnsorted` 的注释
    if (!view || !(await view.addFilesToUnsorted([sourcePath]))) {
      new Notice(t('notice.addToBoardFailed', { path }));
      return;
    }
    new Notice(t('notice.addedToUnsorted'));
  })();
}

/**
 * 取 Home 路径。两条失败路径（没配置 / 建板出错）都**已经把话说给用户听过了**，
 * 所以返回 `null` 让调用方直接收工，不必再判断一次。
 */
async function resolveHome(plugin: NestboardPlugin): Promise<string | null> {
  try {
    const path = await ensureHomeBoard(plugin);
    if (!path) new Notice(t('notice.homeNotConfigured'));
    return path;
  } catch (error) {
    // 建板失败是**硬错误**（写盘被拒 / 路径非法）：带上原因，别让用户对着
    // "添加失败" 发呆 —— 他自己多半能从那句话里看出是路径写错了还是磁盘满了
    new Notice(t('notice.boardCreateFailed', { error: describeError(error) }));
    return null;
  }
}
