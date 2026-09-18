/**
 * 命令注册（T1.17 + T1.20）。
 *
 * 两条规矩：
 *
 * 1. **只在能用的地方出现**。视图相关命令一律用 `checkCallback`：当前没有白板视图时
 *    返回 `false`，命令会从命令面板里**消失** —— 而不是"点了没反应"。
 * 2. **快捷键交给 Obsidian 热键系统**（F11-08）；插件绝不自己监听全局按键。
 *    ★ `O25` 起**默认只留通用编辑键**（撤销 / 重做 / 复制 / 剪切 / 全选 / 搜索 / 缩放），
 *    其余命令一律**不带默认热键** —— 插件自定的组合（`⌘⇧E` / `D`/`E`/`V` / `⌘U` / `⌘[`…）
 *    容易和 Obsidian 或用户习惯打架，用哪个键该由用户在 设置 → 快捷键 里自己定。
 *    ★ 命令本身与命令面板条目一个都不删（见 `DEFAULT_HOTKEY_COMMANDS`）。
 *
 * ★ 合规（04 §13）：命令 ID 不含 `nestboard-` 前缀，Obsidian 会自动加。
 */

import { Notice } from 'obsidian';
import type { Hotkey } from 'obsidian';
import { COMMAND_IDS } from './constants';
import { createBoardInVault } from './io/newBoard';
import { openBacklinkPanel } from './integration/BacklinkPanel';
import { describeError } from './util/errors';
import { t } from './util/i18n';
import type { MessageKey } from './util/i18n';
import type { BoardView } from './view/BoardView';
import { createSnapshotNow, openSnapshotHistory } from './ui/snapshotActions';
import { auditUnusedAttachments } from './ui/attachmentActions';
import { deleteBoardWithConfirm } from './ui/boardActions';
import { importCanvasFile } from './ui/canvasActions';
import { openConflictCompare } from './ui/conflictActions';
import { addFileToUnsorted, openHomeBoard } from './ui/homeActions';
import { cleanupIndexNotes, rebuildIndexNotes } from './ui/indexNoteActions';
import { openBoardListPanel } from './ui/BoardListPanel';
import { openBoardSearchPanel } from './ui/BoardSearchPanel';
import { openTemplateLibrary } from './ui/templateActions';
import { getActiveBoardView, openBoardView } from './view/BoardViewHost';
import type NestboardPlugin from './main';

export function registerCommands(plugin: NestboardPlugin): void {
  plugin.addCommand({
    id: COMMAND_IDS.createBoard,
    name: t('command.createBoard.name'),
    // ★ `O25`：不再默认占用 `⌘⇧N`（见头部第 2 条），要绑请到 设置 → 快捷键
    callback: () => {
      void createNewBoard(plugin);
    },
  });

  // 画布导航（F1-03 / F1-04；默认键位见 02 §4.3）
  registerViewCommand(plugin, {
    id: COMMAND_IDS.zoomIn,
    nameKey: 'command.zoomIn.name',
    hotkeys: [{ modifiers: ['Mod'], key: '=' }],
    run: (view) => view.zoomByStep(1),
  });
  registerViewCommand(plugin, {
    id: COMMAND_IDS.zoomOut,
    nameKey: 'command.zoomOut.name',
    hotkeys: [{ modifiers: ['Mod'], key: '-' }],
    run: (view) => view.zoomByStep(-1),
  });
  registerViewCommand(plugin, {
    id: COMMAND_IDS.zoomReset,
    nameKey: 'command.zoomReset.name',
    hotkeys: [{ modifiers: ['Mod'], key: '1' }],
    run: (view) => view.zoomToActualSize(),
  });
  registerViewCommand(plugin, {
    id: COMMAND_IDS.zoomFit,
    nameKey: 'command.zoomFit.name',
    hotkeys: [{ modifiers: ['Mod'], key: '0' }],
    run: (view) => view.fitContent(),
  });

  // 选区与层级（T1.31 / F2-00-4；默认键位见 02 §4.3）
  registerViewCommand(plugin, {
    id: COMMAND_IDS.selectAll,
    nameKey: 'command.selectAll.name',
    hotkeys: [{ modifiers: ['Mod'], key: 'A' }],
    // ★ 卡片处于编辑态时必须让路：那时 ⌘A 的语义是"全选这段文字"。
    //   返回 false → 命令不执行，按键照常走编辑器 —— 这就是 02 §4.2
    //   「仅 EDITING 态接管文本键」在命令层的样子。
    available: (view) => !view.isEditingCard,
    run: (view) => view.selectAll(),
  });
  registerViewCommand(plugin, {
    id: COMMAND_IDS.bringToFront,
    nameKey: 'command.bringToFront.name',
    hotkeys: [{ modifiers: ['Mod', 'Shift'], key: 'ArrowUp' }],
    available: (view) => view.canManipulateCards,
    run: (view) => view.bringSelectionToFront(),
  });
  registerViewCommand(plugin, {
    id: COMMAND_IDS.sendToBack,
    nameKey: 'command.sendToBack.name',
    hotkeys: [{ modifiers: ['Mod', 'Shift'], key: 'ArrowDown' }],
    available: (view) => view.canManipulateCards,
    run: (view) => view.sendSelectionToBack(),
  });

  // 卡片增删改（T1.34–T1.48；默认键位见 02 §4.3）
  registerViewCommand(plugin, {
    id: COMMAND_IDS.newNote,
    nameKey: 'command.newNote.name',
    hotkeys: [{ modifiers: ['Mod', 'Shift'], key: 'E' }],
    available: (view) => view.canCreateCard,
    run: (view) => view.newNoteAtCursor(),
  });
  // 新建待办（T3.01）。刻意不占默认组合键：⌘⇧E 已经是便签的，而"新建"这类动作
  // 在命令面板里搜索得到就够了；想绑键的用户可以在设置里自己绑。
  registerViewCommand(plugin, {
    id: COMMAND_IDS.newTodo,
    nameKey: 'command.newTodo.name',
    available: (view) => view.canCreateCard,
    run: (view) => view.newTodoAtCursor(),
  });
  // 新建色板（T3.04）。同样不占默认组合键（理由同上：命令面板搜得到就够了）。
  registerViewCommand(plugin, {
    id: COMMAND_IDS.newSwatch,
    nameKey: 'command.newSwatch.name',
    available: (view) => view.canCreateCard,
    run: (view) => view.newSwatchAtCursor(),
  });
  // 新建地图卡（T7.03）。同样不占默认组合键。
  // ★ `O17` 起它不再弹库内文件选择器：落卡之后直接问**链接**（读剪贴板 → 解析 →
  //   配了静态图服务就取一张图），与工具条走同一个入口。
  // ★ 想拿一张库内图片当地图，走卡片右键的「选择地图图片」。
  registerViewCommand(plugin, {
    id: COMMAND_IDS.newMap,
    nameKey: 'command.newMap.name',
    available: (view) => view.canCreateCard,
    run: (view) => view.newMapAtCursor(),
  });
  // 新建同步便签（T7.04）。不占默认组合键 —— 它比"新建便签"多一层心智
  // （"这张会有好几处副本"），常按的人自己绑更快。
  registerViewCommand(plugin, {
    id: COMMAND_IDS.newSyncNote,
    nameKey: 'command.newSyncNote.name',
    available: (view) => view.canCreateCard,
    run: (view) => view.newSyncNoteAtCursor(),
  });
  // 新建评论卡（T7.05）。不占默认组合键 —— 与"新建便签"一样是"在光标处落一张"，
  // 但它多半是"跟着某张卡走"的动作（画布右键菜单就在手边），命令面板这条只是兜底。
  registerViewCommand(plugin, {
    id: COMMAND_IDS.newComment,
    nameKey: 'command.newComment.name',
    available: (view) => view.canCreateCard,
    run: (view) => view.newCommentAtCursor(),
  });
  registerViewCommand(plugin, {
    id: COMMAND_IDS.deleteSelection,
    nameKey: 'command.deleteSelection.name',
    available: (view) => view.canManipulateSelection,
    run: (view) => view.deleteSelection(),
  });
  registerViewCommand(plugin, {
    id: COMMAND_IDS.duplicateSelection,
    nameKey: 'command.duplicateSelection.name',
    hotkeys: [{ modifiers: ['Mod'], key: 'D' }],
    available: (view) => view.canManipulateCards,
    run: (view) => view.duplicateSelection(),
  });
  // 复制 / 剪切 / 粘贴卡片（T4.15 / `F7-07`，插件 `02 §4.1` 键位表定的组合）。
  // ★ `⌘V` **不在这里**：粘贴走画布自己的 `paste` 事件（`onCanvasPaste`）——
  //   那条路上能**同步**拿到剪贴板内容，而注册成命令就得异步读系统剪贴板
  //   （要权限、要等 promise），还会和"编辑卡片时的 `⌘V`"抢焦点。
  //   三条键位合起来才是完整的一套，所以另外两条也照键位表占上默认键。
  registerViewCommand(plugin, {
    id: COMMAND_IDS.copySelection,
    nameKey: 'command.copySelection.name',
    hotkeys: [{ modifiers: ['Mod'], key: 'C' }],
    available: (view) => view.canManipulateSelection,
    run: (view) => void view.copySelection(),
  });
  registerViewCommand(plugin, {
    id: COMMAND_IDS.cutSelection,
    nameKey: 'command.cutSelection.name',
    hotkeys: [{ modifiers: ['Mod'], key: 'X' }],
    available: (view) => view.canManipulateSelection,
    run: (view) => void view.cutSelection(),
  });
  registerViewCommand(plugin, {
    id: COMMAND_IDS.toggleTitle,
    nameKey: 'command.toggleTitle.name',
    available: (view) => view.canManipulateCards,
    run: (view) => view.toggleSelectionTitle(),
  });
  registerViewCommand(plugin, {
    id: COMMAND_IDS.toggleLock,
    nameKey: 'command.toggleLock.name',
    hotkeys: [{ modifiers: ['Mod', 'Shift'], key: 'L' }],
    available: (view) => view.canManipulateCards,
    run: (view) => view.toggleSelectionLock(),
  });
  registerViewCommand(plugin, {
    id: COMMAND_IDS.promoteSelection,
    nameKey: 'command.promoteSelection.name',
    // ★ **不再默认占用 `⌘⇧P`**（J-06）：`04 §9` 把这个组合键定给了「进入 / 退出演示」，
    //   而演示开关由画布在 `onCanvasKeyDown` 里接管 —— 画布的监听比 Obsidian 的热键
    //   系统更深、先跑，两处都占着就会"同一次按键既进演示又提升为笔记"。
    //   命令本身留在面板里，想要快捷键可以在 `设置 → 快捷键` 里自己绑一个。
    available: (view) => view.canPromoteSelection,
    run: (view) => view.promoteSelection(),
  });

  // ★ `Enter` / `Delete` / 方向键**不给默认热键**：它们会随焦点说话，由画布自己处理
  //   （见 `BoardView.onCanvasKeyDown`）。这里只把动作登记进命令面板，
  //   用户在设置里仍然可以自己绑键 —— 那时 `available` 会替他挡住不该生效的场合。
  registerViewCommand(plugin, {
    id: COMMAND_IDS.editSelection,
    nameKey: 'command.editSelection.name',
    available: (view) => view.canEditSelection,
    run: (view) => view.editSelection(),
  });

  // 撤销 / 重做（T1.48）。编辑态必须让路：那时 ⌘Z 的语义是"撤销这段输入"
  registerViewCommand(plugin, {
    id: COMMAND_IDS.undo,
    nameKey: 'command.undo.name',
    hotkeys: [{ modifiers: ['Mod'], key: 'Z' }],
    available: (view) => view.canUndo,
    run: (view) => view.undo(),
  });
  registerViewCommand(plugin, {
    id: COMMAND_IDS.redo,
    nameKey: 'command.redo.name',
    hotkeys: [{ modifiers: ['Mod', 'Shift'], key: 'Z' }],
    available: (view) => view.canRedo,
    run: (view) => view.redo(),
  });

  // 分栏（T1.57–T1.59）。
  //
  // ★ `⌘Enter` / `⌘⇧G` **故意不在这里声明热键**：画布已经在 `onCanvasKeyDown` 里
  //   接管了这两个组合（它们必须能和画布自己的选区状态、编辑态一起判断）。再声明一次
  //   默认热键，同一次按键会走两遍 —— `⌘Enter` 多拆一次还好，`⌘U` 那种会直接弹出
  //   "源文件已不存在"的假报错。这里只把动作登记进命令面板，用户想改用别的键
  //   仍然可以在设置里绑（那时就只有命令这一条路会跑）。
  registerViewCommand(plugin, {
    id: COMMAND_IDS.splitIntoColumns,
    nameKey: 'command.splitIntoColumns.name',
    available: (view) => view.canSplitIntoColumns,
    run: (view) => view.splitSelectionIntoColumns(),
  });
  registerViewCommand(plugin, {
    id: COMMAND_IDS.collectIntoColumn,
    nameKey: 'command.collectIntoColumn.name',
    available: (view) => view.canCollectIntoColumn,
    run: (view) => view.collectIntoColumn(),
  });
  registerViewCommand(plugin, {
    id: COMMAND_IDS.toggleColumnCollapse,
    nameKey: 'command.toggleColumnCollapse.name',
    available: (view) => view.canToggleSelectedColumn,
    run: (view) => view.toggleSelectedColumnCollapsed(),
  });

  // 嵌套白板导航（T1.62 / 02 §4.3）
  registerViewCommand(plugin, {
    id: COMMAND_IDS.openParent,
    nameKey: 'command.openParent.name',
    hotkeys: [{ modifiers: ['Mod'], key: 'U' }],
    available: (view) => view.canOpenParent,
    run: (view) => view.openParentBoard(),
  });
  registerViewCommand(plugin, {
    id: COMMAND_IDS.navigateBack,
    nameKey: 'command.navigateBack.name',
    hotkeys: [{ modifiers: ['Mod'], key: '[' }],
    available: (view) => view.canNavigateBack,
    run: (view) => view.navigateBack(),
  });
  registerViewCommand(plugin, {
    id: COMMAND_IDS.navigateForward,
    nameKey: 'command.navigateForward.name',
    hotkeys: [{ modifiers: ['Mod'], key: ']' }],
    available: (view) => view.canNavigateForward,
    run: (view) => view.navigateForward(),
  });

  // 白板内搜索（T2.09 / T2.10 / `F8-01` / `F8-02`）。
  //
  // ★ `⌘F` 与 Obsidian 自己的"在当前文件中查找"同键，但白板视图里没有"当前文件正文"
  //   这回事，这个组合在本视图内**不存在歧义** —— 这正是"只在白板视图里可用"
  //   （`checkCallback`）的意义：离开白板，它立刻把键还回去。
  registerViewCommand(plugin, {
    id: COMMAND_IDS.search,
    nameKey: 'command.search.name',
    hotkeys: [{ modifiers: ['Mod'], key: 'F' }],
    // 搜索是只读动作，刻意不看 `isReadOnly`：只读板同样需要"上次那个便签放哪了"
    run: (view) => view.openSearch(),
  });
  // ★ **不再默认占用 `⌘G`**（T3.14）：`04 §4` 的键位表把 `⌘G` / `⌘⇧G` 定为
  //   「编组 / 取消编组」，而"跳到下一个结果"在**搜索面板里按 Enter** 就能做，
  //   面板关掉之后也并不常用。把键让给更高频的编组，是这张表的本意。
  //   （命令本身仍然登记着，想改回 `⌘G` 的用户可以在设置里自己绑。）
  registerViewCommand(plugin, {
    id: COMMAND_IDS.searchNext,
    nameKey: 'command.searchNext.name',
    run: (view) => view.searchNext(),
  });

  // 导出（T1.72 / `F9-01`）。刻意不声明默认热键：它是"偶尔用一次"的动作，
  // 占一个全局组合键不划算；想绑的用户可以在设置里自己绑。
  // 也刻意不给 `available`：**空板也要能点**，否则用户得到的是"命令消失了"
  // 而不是"还没内容可导"这句解释。
  registerViewCommand(plugin, {
    id: COMMAND_IDS.exportMarkdown,
    nameKey: 'command.exportMarkdown.name',
    run: (view) => view.exportMarkdown(),
  });

  // 导出 PNG（T2.11 / `F9-02`）。与 Markdown 导出同样的理由不给默认热键、不给 `available`：
  // 空板也要能打开对话框，让用户看到"没有可导出的内容"这句解释。
  registerViewCommand(plugin, {
    id: COMMAND_IDS.exportPng,
    nameKey: 'command.exportPng.name',
    run: (view) => view.exportPng(),
  });

  // 导出 PDF（T4.10 / `F9-03`）。同样不给默认热键、不给 `available`：
  // 空板也要能打开对话框，看到"没有可导出的内容"这句解释。
  registerViewCommand(plugin, {
    id: COMMAND_IDS.exportPdf,
    nameKey: 'command.exportPdf.name',
    run: (view) => view.exportPdf(),
  });

  // 导出 SVG（T6.01 / `F9-06`）。理由同上面三个导出：
  // ★ 不给默认热键：这四种导出共用同一个"我要拿走这块板"的意图，谁都不该独占组合键。
  // ★ 不给 `available`：空板也要能打开对话框，看到"没有可导出的内容"这句解释。
  registerViewCommand(plugin, {
    id: COMMAND_IDS.exportSvg,
    nameKey: 'command.exportSvg.name',
    run: (view) => view.exportSvg(),
  });

  // 导出 ZIP（T6.02 / `F9-07`）。理由同上：
  // ★ 不给默认热键：它与其他几条导出争的也是"我要拿走这块板"这同一个组合键。
  // ★ 不给 `available`：空板也允许——归档里至少还有那份 `.nboard` 本身，
  //   这正是"把这块板发出去"的最小可用形态。
  registerViewCommand(plugin, {
    id: COMMAND_IDS.exportZip,
    nameKey: 'command.exportZip.name',
    run: (view) => view.exportZip(),
  });

  // 打印（T6.03 / `F9-10`）。理由同上面几条导出：
  // ★ 不给默认热键：`⌘P` 是宿主自己的"打印窗口"（在浏览器 / Electron 里另有含义），
  //   抢过来只会造成"想打印笔记却印出了白板"这种误会。
  // ★ 不给 `available`：空板也允许打开对话框，看到"没有可打印的内容"这句解释。
  registerViewCommand(plugin, {
    id: COMMAND_IDS.printBoard,
    nameKey: 'command.printBoard.name',
    run: (view) => view.printBoard(),
  });

  // 导出 / 导入 JSON Canvas（T4.11 / T4.12 / `F9-04`、`F9-05`）。
  //
  // ★ 导出是**视图命令**：它导的是"当前这块板子"，没有活动白板时无从谈起，
  //   所以让它随视图一起消失（`checkCallback`）比"点了没反应"清楚。
  // ★ 导入是**全局命令**：它要解决的恰恰是"我现在没在看白板，但库里有一张
  //   别人给的 .canvas"。挂在视图命令上等于要求用户先打开一块板才能导入另一张画布。
  registerViewCommand(plugin, {
    id: COMMAND_IDS.exportCanvas,
    nameKey: 'command.exportCanvas.name',
    run: (view) => view.exportCanvas(),
  });
  plugin.addCommand({
    id: COMMAND_IDS.importCanvas,
    name: t('command.importCanvas.name'),
    callback: () => {
      void importCanvasFile(plugin);
    },
  });

  // 演示模式（J-06 / J-07 / `02 §4.3`）。
  //
  // ★ 进出拆成**两条互斥命令**（与"锁定 / 解锁"同一条规矩）：Obsidian 的命令名是
  //   静态的，一个切换项必然有一半时间在说谎。`available` 保证命令面板里永远只出现
  //   当下真能做的那一条 —— 而没有打开白板时，一条都不出现（`checkCallback`）。
  // ★ `⌘⇧P` / `→` / `←` / `O` / `1`–`9` **都不在这里声明默认热键**：这些键全部由画布
  //   在 `onCanvasKeyDown` → `PresentationController.handleKey` 里接管（判断"焦点是不是
  //   在卡片编辑器里""此刻是不是演示态"都要看视图内部状态，命令层的 `available` 看不到）。
  //   在这里再声明一次，同一次按键会走两遍：画布翻一步、命令又翻一步。
  registerViewCommand(plugin, {
    id: COMMAND_IDS.startPresentation,
    nameKey: 'command.startPresentation.name',
    // 空板不进演示：进了也只是一个"按什么都没反应、写着 0 / 0"的界面
    available: (view) => !view.isPresenting && view.canPresent,
    run: (view) => view.startPresentation(),
  });
  registerViewCommand(plugin, {
    id: COMMAND_IDS.endPresentation,
    nameKey: 'command.endPresentation.name',
    available: (view) => view.isPresenting,
    run: (view) => view.endPresentation(),
  });
  registerViewCommand(plugin, {
    id: COMMAND_IDS.presentNext,
    nameKey: 'command.presentNext.name',
    available: (view) => view.isPresenting,
    run: (view) => view.presentNext(),
  });
  registerViewCommand(plugin, {
    id: COMMAND_IDS.presentPrevious,
    nameKey: 'command.presentPrevious.name',
    available: (view) => view.isPresenting,
    run: (view) => view.presentPrevious(),
  });
  // ★ 加入 / 移出 / 清空走 `canManipulateCards` 那一套：它们**会改白板内容**
  //   （演示顺序要落盘），只读板与编辑态下必须让路（与"锁定 / 颜色"同一档）。
  registerViewCommand(plugin, {
    id: COMMAND_IDS.addToPresentation,
    nameKey: 'command.addToPresentation.name',
    available: (view) => view.canAddToPresentation,
    run: (view) => view.addSelectionToPresentation(),
  });
  registerViewCommand(plugin, {
    id: COMMAND_IDS.removeFromPresentation,
    nameKey: 'command.removeFromPresentation.name',
    available: (view) => view.canRemoveFromPresentation,
    run: (view) => view.removeSelectionFromPresentation(),
  });
  registerViewCommand(plugin, {
    id: COMMAND_IDS.clearPresentation,
    nameKey: 'command.clearPresentation.name',
    available: (view) => view.hasPresentSteps,
    run: (view) => view.clearPresentation(),
  });

  // 诊断信息（T2.17 / `02 §8.3`）。同样不给默认热键：它是"出了问题才打开"的面板。
  // ★ 刻意不给 `available`：**只读板一样需要它**（性能问题与是否只读无关），
  //   而"板子被外部改过"这类只读态恰恰是用户最想拿数字去报障的时候。
  registerViewCommand(plugin, {
    id: COMMAND_IDS.showDiagnostics,
    nameKey: 'command.showDiagnostics.name',
    run: (view) => view.showDiagnostics(),
  });

  // 大文件分级退化（T2.16 / `02 §8.3`）：拆板向导。
  // ★ 用 `available` 卡住：拆不动（只有一栏、或栏里没卡片）的板子不显示这条命令 ——
  //   挂着一个"点了才知道不行"的入口，比不给入口更烦人。
  registerViewCommand(plugin, {
    id: COMMAND_IDS.splitBoard,
    nameKey: 'command.splitBoard.name',
    available: (view) => view.canSplitBoard,
    run: (view) => view.openSplitBoard(),
  });

  // 待办总览浮层（T3.03 / `F2.5`）：把全板的未完成待办拍平成一张清单。
  // ★ 不给默认热键：它是"想盘点一下"才打开的旁路视图，犯不上占一个常用组合键。
  // ★ 用 `available` 卡住：没有打开任何白板时它没有意义（浮层不知道要聚合谁）。
  registerViewCommand(plugin, {
    id: COMMAND_IDS.todoOverview,
    nameKey: 'command.todoOverview.name',
    available: (view) => view.canShowTodoOverview,
    run: (view) => view.toggleTodoOverview(),
  });

  // 缩略图导航器（T5.09 / `F1-06`）。
  // ★ 不给默认热键：它是一块**常驻浮层**，开关频率极低 —— 想常显的人会在设置里打开，
  //   为"偶尔切一下"占一个组合键不值（与「待办总览」同一个判断）。
  // ★ 也不给 `available`：`toggleMinimap` 改的是设置，即使当前没有白板视图
  //   （比如从命令面板里预先把开关打开）它也有明确意义，没有理由挡掉。
  registerViewCommand(plugin, {
    id: COMMAND_IDS.toggleMinimap,
    nameKey: 'command.toggleMinimap.name',
    run: (view) => view.toggleMinimap(),
  });

  // 重命名 / 移动白板（T1.73 / `F7-05`）。
  // 刻意不给默认热键：Obsidian 自己已经有「重命名文件」的默认键，插件再占一个
  // 只会打架；想绑的用户可以在设置里自己绑。
  // 也刻意不给 `available`：视图没打开时它本来就不可达，而"板子被外部改过"
  // 是只读**内容**、不该连改名一起挡掉。
  registerViewCommand(plugin, {
    id: COMMAND_IDS.renameBoard,
    nameKey: 'command.renameBoard.name',
    run: (view) => view.renameBoard(),
  });

  // 手绘（T3.06 / `F4-01`、`F4-03`；键位见 `02 §4.1`）
  //
  // ★ 三支工具其实是"**一个模式的两支笔 + 一个出口**"：`D` 与 `E` 都进入 INK 态
  //   （区别只是手里拿着哪支笔，可以随时互相切换），`V` 才是"交回选择工具"。
  //   所以可用性也分两套：进不去手绘时 `D`/`E` 让路，不在手绘态时 `V` 让路。
  // ★ 单键（不带修饰键）：这些都是"手不离鼠标"时按的，加了修饰键就没法一边画一边按。
  //   代价是它们和卡片编辑器的输入冲突 —— 那一层由 `02 §4.2`「仅 EDITING 态接管文本键」
  //   兜住（`capturesKeyboard`）。
  registerViewCommand(plugin, {
    id: COMMAND_IDS.inkBrush,
    nameKey: 'command.inkBrush.name',
    hotkeys: [{ modifiers: [], key: 'D' }],
    available: (view) => view.canDrawInk,
    run: (view) => view.startInk('brush'),
  });
  registerViewCommand(plugin, {
    id: COMMAND_IDS.inkEraser,
    nameKey: 'command.inkEraser.name',
    hotkeys: [{ modifiers: [], key: 'E' }],
    available: (view) => view.canDrawInk,
    run: (view) => view.startInk('eraser'),
  });
  registerViewCommand(plugin, {
    id: COMMAND_IDS.inkSelect,
    nameKey: 'command.inkSelect.name',
    hotkeys: [{ modifiers: [], key: 'V' }],
    // 只有手里拿着笔时才需要"交回选择工具"。不在手绘态时让它消失，
    // 也就不会白白占住 `V` 键（`02 §4.2`：用不上的键要还给 Obsidian）
    available: (view) => view.isInking,
    run: (view) => view.stopInk(),
  });
  registerViewCommand(plugin, {
    id: COMMAND_IDS.clearInk,
    nameKey: 'command.clearInk.name',
    hotkeys: [{ modifiers: ['Mod', 'Shift'], key: 'Backspace' }],
    // 有东西才可清：空手按下去会得到"什么都没发生"，用户只会怀疑快捷键没生效。
    // ★ 两种"有"都算：落盘的笔画（`ink` 卡片）与临时标注层里的那些（T7.07）——
    //   后者只可能非零于手绘态内（它的生命周期长在手绘态上），所以这条判定在
    //   浏览态退化成原来的 `hasInkStrokes`。
    available: (view) => view.hasInkStrokes || view.annotationCount > 0,
    // ★ 视图里先清临时标注、再轮到落盘的笔画（见 `BoardView.clearInk`）：
    //   `02 §4.1` 把这个键定给「清空临时标注」，而它同时是 T3.08 的"清空手绘"
    run: (view) => view.clearInk(),
  });
  // 荧光笔（T7.08 / `F4-07`）：半透明高亮。
  // ★ 不给默认热键：工具条上它就挨着画笔，而 `⌘⇧` 一类的组合键该留给
  //   "会改变状态、要找得到出口"的东西；想一键切的人可以在设置里自己绑。
  registerViewCommand(plugin, {
    id: COMMAND_IDS.inkMarker,
    nameKey: 'command.inkMarker.name',
    available: (view) => view.canDrawInk,
    run: (view) => view.startInk('marker'),
  });
  // 临时标注层（T7.07 / `F4-06`）：不落盘、`Esc`（或再按一次）清空收工。
  // ★ 占用 `⌘⇧A`：`⌘A`（全选）是它在命令层最亲的邻居，而全选在**编辑态**本来就让路
  //   （`selectAll` 的 `available`），两者不会同时想要这个键。
  registerViewCommand(plugin, {
    id: COMMAND_IDS.inkAnnotate,
    nameKey: 'command.inkAnnotate.name',
    hotkeys: [{ modifiers: ['Mod', 'Shift'], key: 'A' }],
    // ★ 已经在标注态时它必须还在：再按一次是"收起笔"（`toggleInkAnnotate`），
    //   而不是一条凭空消失的命令
    available: (view) => view.canDrawInk || view.isAnnotating,
    run: (view) => view.toggleInkAnnotate(),
  });

  // 手绘颜色与笔宽（T3.07 / `F4-02`；键位见 `04 §8`）
  //
  // ★ 全部用 `available: isInking` 卡住：`X` 与 `1`–`4` 都是**光秃秃的单键**，
  //   正常浏览白板时必须还给 Obsidian —— 用户可能在 SearchPanel 里搜 "x1"、
  //   在卡片里输入数字，那些都轮不到"换笔宽"。只有手里拿着笔时它们才存在，
  //   这与 `V`（`inkSelect`）是同一条规则：用不上的键要还回去（`02 §4.2`）。
  registerViewCommand(plugin, {
    id: COMMAND_IDS.inkSwapColor,
    nameKey: 'command.inkSwapColor.name',
    hotkeys: [{ modifiers: [], key: 'X' }],
    available: (view) => view.isInking,
    // ★ 只换"这支笔"的颜色，不动已经画好的笔迹 —— 后者是 T3.08 的事
    run: (view) => view.swapInkColors(),
  });
  registerViewCommand(plugin, {
    id: COMMAND_IDS.inkColor,
    nameKey: 'command.inkColor.name',
    // 不给默认热键：工具条上一个彩虹点就够常用，而调色板是"偶尔换一次"。
    // 真要高频换色的用户可以自己绑（也可能他更想要一整排固定的色键）
    available: (view) => view.isInking,
    run: (view) => view.pickInkColor(),
  });

  // 4 档笔宽：`1`–`4`，下标与 `INK_BRUSH_WIDTHS` 一一对应。
  // ★ 四条命令共用一份 `nameKey` 与占位符，而不是写四遍几乎一样的文案：
  //   改名时不会漏掉其中一档，档位数量变化也只是改这个数组
  INK_WIDTH_COMMANDS.forEach((command, index) => {
    registerViewCommand(plugin, {
      id: command.id,
      nameKey: 'command.inkWidth.name',
      nameParams: { n: index + 1 },
      hotkeys: [{ modifiers: [], key: command.key }],
      available: (view) => view.isInking,
      run: (view) => view.setInkWidth(index),
    });
  });

  // 网格吸附开关（T3.11 / `F5-02`）。
  // ★ 不给默认热键：它是"偶尔切一次"的偏好设置，占一个组合键不划算。
  //   拖动时按住 Ctrl 就能**临时反转**（见 `DragModifiers.ctrl`），
  //   日常根本不必为了摆一张自由位置的卡专门来改它。
  registerViewCommand(plugin, {
    id: COMMAND_IDS.toggleGridSnap,
    nameKey: 'command.toggleGridSnap.name',
    available: (view) => view.canToggleGridSnap,
    run: (view) => view.toggleGridSnap(),
  });

  // 对齐 / 等距分布（T3.13 / `F5-04`）。
  //
  // ★ 与分栏那几条同一条规矩：`⌥⌘ ←/→/↑/↓` **不在命令层声明默认热键**
  //   （`available` 需要看选区数量与编辑态，声明了会与画布里的处理走两遍）。
  //   这里只把 7 个动作登记进命令面板，用户在设置里可以自己绑。
  //   面向上下的居中与两项分布没有默认键：`04 §4` 只给了四向箭头，其余留给用户。
  registerViewCommand(plugin, {
    id: COMMAND_IDS.alignLeft,
    nameKey: 'command.alignLeft.name',
    available: (view) => view.canAlignSelection,
    run: (view) => view.alignSelection('left'),
  });
  registerViewCommand(plugin, {
    id: COMMAND_IDS.alignRight,
    nameKey: 'command.alignRight.name',
    available: (view) => view.canAlignSelection,
    run: (view) => view.alignSelection('right'),
  });
  registerViewCommand(plugin, {
    id: COMMAND_IDS.alignTop,
    nameKey: 'command.alignTop.name',
    available: (view) => view.canAlignSelection,
    run: (view) => view.alignSelection('top'),
  });
  registerViewCommand(plugin, {
    id: COMMAND_IDS.alignBottom,
    nameKey: 'command.alignBottom.name',
    available: (view) => view.canAlignSelection,
    run: (view) => view.alignSelection('bottom'),
  });
  registerViewCommand(plugin, {
    id: COMMAND_IDS.alignCenterX,
    nameKey: 'command.alignCenterX.name',
    available: (view) => view.canAlignSelection,
    run: (view) => view.alignSelection('centerX'),
  });
  registerViewCommand(plugin, {
    id: COMMAND_IDS.alignCenterY,
    nameKey: 'command.alignCenterY.name',
    available: (view) => view.canAlignSelection,
    run: (view) => view.alignSelection('centerY'),
  });
  registerViewCommand(plugin, {
    id: COMMAND_IDS.distributeX,
    nameKey: 'command.distributeX.name',
    available: (view) => view.canDistributeSelection,
    run: (view) => view.distributeSelection('x'),
  });
  registerViewCommand(plugin, {
    id: COMMAND_IDS.distributeY,
    nameKey: 'command.distributeY.name',
    available: (view) => view.canDistributeSelection,
    run: (view) => view.distributeSelection('y'),
  });

  // 编组 / 取消编组（T3.14 / `F5-05`）。同样不在命令层声明 `⌘G` / `⌘⇧G`：
  // 这两个组合需要和"选区里有几张卡""选的是不是一整组"一起判断，画布那层处理。
  registerViewCommand(plugin, {
    id: COMMAND_IDS.groupCards,
    nameKey: 'command.groupCards.name',
    available: (view) => view.canGroupSelection,
    run: (view) => view.groupSelection(),
  });
  registerViewCommand(plugin, {
    id: COMMAND_IDS.ungroupCards,
    nameKey: 'command.ungroupCards.name',
    available: (view) => view.canUngroupSelection,
    run: (view) => view.ungroupSelection(),
  });

  // 同组分栏对齐（T3.15 / `F5-01`）。不给默认键：它是"看到一排不齐才用一次"的动作。
  registerViewCommand(plugin, {
    id: COMMAND_IDS.alignColumns,
    nameKey: 'command.alignColumns.name',
    available: (view) => view.canAlignSiblingColumns,
    run: (view) => view.alignSelectedColumns(),
  });

  // 卡片过滤（T3.17 / T3.18 / `F8-04` / `F8-06`）。只读板一样要看"哪些是断链"，
  // 所以**不给 `available`**（与搜索同理：过滤是只读动作）。
  registerViewCommand(plugin, {
    id: COMMAND_IDS.toggleCardFilter,
    nameKey: 'command.toggleCardFilter.name',
    run: (view) => view.toggleCardFilter(),
  });

  // 断链总览（T3.19 / `F8-07`）。只读动作，不给 `available`。
  registerViewCommand(plugin, {
    id: COMMAND_IDS.linkOverview,
    nameKey: 'command.linkOverview.name',
    run: (view) => view.toggleLinkOverview(),
  });

  // 复制为 Markdown（T3.20 / `F9-08`）。刻意不给 `available`：
  // 空板也要能点，让用户看到"还没有内容可复制"这句解释，而不是"命令消失了"。
  registerViewCommand(plugin, {
    id: COMMAND_IDS.copyMarkdown,
    nameKey: 'command.copyMarkdown.name',
    run: (view) => view.copyMarkdownToClipboard(),
  });

  // 复制白板链接（O11 / `05`）。与「复制为 Markdown」同一取舍：**不给 `available`** ——
  // 白板刚打开时 `boardPath` 还可能是 null，但"点了没反应"要有解释（视图会说
  // "这块白板还没加载完"），比"命令凭空消失"好懂。
  // ★ 只读动作：不改模型、不写盘，归档锁定态下也放行。
  registerViewCommand(plugin, {
    id: COMMAND_IDS.copyBoardLink,
    nameKey: 'command.copyBoardLink.name',
    run: (view) => view.copyBoardLink(),
  });

  // 期 4：版本快照（T4.01 / T4.02 / `F11-11`）
  // ★ 两条都刻意不给 `available`：白板刚加载出来时 `boardPath` 还是 null，
  //   但"看不到历史版本"比"命令凭空消失"更让人怀疑插件坏了。
  registerViewCommand(plugin, {
    id: COMMAND_IDS.createSnapshot,
    nameKey: 'command.createSnapshot.name',
    run: (view) => {
      void createSnapshotNow(plugin, view);
    },
  });
  registerViewCommand(plugin, {
    id: COMMAND_IDS.snapshotHistory,
    nameKey: 'command.snapshotHistory.name',
    run: (view) => openSnapshotHistory(plugin, view),
  });

  // 期 4：删除白板（T4.04 / 03 §3.6）
  // ★ 用 `available` 卡住没有路径的一瞬（视图正在加载）：那时命令要么消失、
  //   要么就是"点了没反应"；前者的解释成本更低。
  registerViewCommand(plugin, {
    id: COMMAND_IDS.deleteBoard,
    nameKey: 'command.deleteBoard.name',
    available: (view) => view.boardPath !== null,
    run: (view) => {
      const path = view.boardPath;
      if (path !== null) void deleteBoardWithConfirm(plugin, path);
    },
  });

  // 期 4：归档只读（T4.06 / `03 §2.5`）
  // ★ 拆成**两条命令**而不是一条「切换只读」：Obsidian 的命令名是静态的，
  //   一个切换项必然有一半时间是"名字在说谎"。两条互斥 + `available`，
  //   命令面板里永远只出现当下真能做的那一条（与 `04 §13` 的"只在能用的地方出现"同一条规矩）。
  // ★ 同样用 `available` 卡住加载中的一瞬：那时 `isReadOnly()` 为真（模型还没装好），
  //   让「锁定」暂时消失，而不是让用户点了之后什么都没发生。
  registerViewCommand(plugin, {
    id: COMMAND_IDS.lockBoard,
    nameKey: 'command.lockBoard.name',
    available: (view) => view.canLockBoard,
    run: (view) => view.lockBoard(),
  });
  registerViewCommand(plugin, {
    id: COMMAND_IDS.unlockBoard,
    nameKey: 'command.unlockBoard.name',
    available: (view) => view.canUnlockBoard,
    run: (view) => view.unlockBoard(),
  });

  // 期 4：整理未使用附件（T4.05 / `03 §4`）。
  // ★ 在**只读板**上照样给：整理只是读 + 列清单，一个字节都不写
  //   —— `available` 里绝不能顺手加 `!isReadOnly()`，那会让归档板永远清不了垃圾。
  registerViewCommand(plugin, {
    id: COMMAND_IDS.auditAttachments,
    nameKey: 'command.auditAttachments.name',
    run: () => {
      void auditUnusedAttachments(plugin);
    },
  });

  // 期 4：修复引用（T4.07 / `03 §9 R10`）。
  // ★ `available` 里带上"有没有可重连的断链"：一块没有断链的板子上，
  //   这条命令无论点几次都只会弹一句"没有可修复的断链" —— 不如不出现。
  registerViewCommand(plugin, {
    id: COMMAND_IDS.repairRefs,
    nameKey: 'command.repairRefs.name',
    available: (view) => view.canRepairRefs,
    run: (view) => {
      void view.openRefRepair();
    },
  });

  // 期 4：模板库（T4.14 / `F7-06`）。
  //
  // ★ 「从模板新建白板」刻意是**全局命令**：「新建一块板」这件事本来就不需要有板开着
  //   （`⌘⇧N` 也是全局的）。挂在视图命令上等于要求用户"先打开一块板，才能新建另一块"。
  // ★ 「另存为模板」刻意是**视图命令**：它存的是"眼前这块板"，没有活动白板时无从谈起。
  //   刻意不给 `available`：它只**读**当前板、往模板目录**写一份新文件**，
  //   在只读板上照样成立（"这块锁住了，但我想拿它当模板"是很正常的一句话）。
  registerViewCommand(plugin, {
    id: COMMAND_IDS.saveBoardAsTemplate,
    nameKey: 'command.saveBoardAsTemplate.name',
    run: (view) => view.saveAsTemplate(),
  });
  plugin.addCommand({
    id: COMMAND_IDS.newBoardFromTemplate,
    name: t('command.newBoardFromTemplate.name'),
    callback: () => {
      void openTemplateLibrary(plugin);
    },
  });

  // 跨白板反链（T5.03 / F10-08）
  //
  // ★ 这是少见的**不要求白板视图在前台**的命令：用户站在一篇笔记上，
  //   想知道"哪块板的内联卡提过我"。用 `callback` 而不是 `checkCallback`，
  //   否则站在笔记上时它就从命令面板里消失了 —— 而"站在笔记上"恰恰是它的主场景。
  plugin.addCommand({
    id: COMMAND_IDS.openBacklinks,
    name: t('command.openBacklinks.name'),
    callback: () => {
      void openBacklinkPanel(plugin);
    },
  });

  // Home 白板与收件箱（T5.07 / `F7-03` / `F11-09`）
  //
  // ★ 两条都刻意是**全局命令**（不要求白板视图在前台）：
  //   「打开 Home」要解决的恰恰是"我现在哪儿都不是，只想回到手边那块板"；
  //   「添加到收件箱」的主场景是"我站在一篇笔记上，还不确定它属于哪块板"。
  //   挂成视图命令的话，这两个主场景下命令都会从面板里消失。
  plugin.addCommand({
    id: COMMAND_IDS.openHome,
    name: t('command.openHome.name'),
    callback: () => {
      openHomeBoard(plugin);
    },
  });
  // ★ 用 `checkCallback` 只卡住"没有打开任何文件"这一件事（那时没有东西可加）。
  //   刻意**不看白板视图**：这条命令的价值就在于"人不在白板上"时也能用
  plugin.addCommand({
    id: COMMAND_IDS.addToUnsorted,
    name: t('command.addToUnsorted.name'),
    checkCallback: (checking: boolean) => {
      const file = plugin.app.workspace.getActiveFile();
      if (!file) return false;
      if (!checking) addFileToUnsorted(plugin, file.path);
      return true;
    },
  });

  // 白板列表侧栏（T5.08 / `F7-04`）
  //
  // ★ 同样是**全局命令**：它的用途是"我找不到那块板了"，而那正是**没在看任何白板**的时刻 ——
  //   挂成视图命令的话，最需要它的时候它恰好不在。
  // ★ 默认键 `⌘⇧B` 来自 `02 §4.1` 的键位表（表里唯一一个给了默认键的"列表/入口"类命令），
  //   与"没有默认热键"的多数命令不同：它的触发场景是"我找不到东西了"，
  //   那一刻用户不该还要先去想"这个功能绑没绑键"。
  plugin.addCommand({
    id: COMMAND_IDS.openBoardList,
    name: t('command.openBoardList.name'),
    hotkeys: [{ modifiers: ['Mod', 'Shift'], key: 'B' }],
    callback: () => {
      void openBoardListPanel(plugin);
    },
  });

  // 跨白板搜索（T7.02 / `F8-08`）
  //
  // ★ 与「白板列表」同一条理由做成**全局命令**：它要回答的是"我明明在哪块板上写过
  //   这件事，是哪一块来着"，而这个问题恰恰出现在**没在看那块板**的时候。
  // ★ 刻意**不给默认热键**：`⌘⇧F` 是 Obsidian 自己的"在所有文件中搜索"，
  //   抢过来会毁掉一个用户肌肉记忆里的键；而这条命令的用户打开过一次之后，
  //   想要热键的人会自己绑。
  plugin.addCommand({
    id: COMMAND_IDS.openBoardSearch,
    name: t('command.openBoardSearch.name'),
    callback: () => {
      void openBoardSearchPanel(plugin);
    },
  });

  // 期 4：同步冲突副本（T4.03 / 03 §3.4）
  // ★ 这条**刻意是全局命令**而不是视图命令：冲突是"库这一层"的问题，
  //   没有打开任何白板时同样该能查 —— 冲突恰恰是"某块板打不开/看着不对"的时候
  //   才会想起要找的东西。
  plugin.addCommand({
    id: COMMAND_IDS.viewConflicts,
    name: t('command.viewConflicts.name'),
    callback: () => {
      void openConflictCompare(plugin);
    },
  });

  // 期 6：自动整理（T6.07 / `F5-06`）。视图命令 —— 没有打开的板就没有可整理的东西。
  // ★ 不给默认键：它是"看着乱才用一次"的动作，绑了键反而会误触（与「同级分栏对齐」同理）。
  registerViewCommand(plugin, {
    id: COMMAND_IDS.tidyBoard,
    nameKey: 'command.tidyBoard.name',
    // 只读板上整项不出现（`commit` 也会拒绝，但"点了没反应"不如"看不见"）
    available: (view) => view.canTidyBoard,
    run: (view) => view.tidyBoard(),
  });

  // 期 6：按标签自动分栏（T6.08 / `F5-07`）。同上
  registerViewCommand(plugin, {
    id: COMMAND_IDS.groupByTag,
    nameKey: 'command.groupByTag.name',
    available: (view) => view.canGroupByTag,
    run: (view) => view.groupByTag(),
  });

  // 期 7：索引笔记（T7.01 / `F10-09` + `F7-09`）。
  //
  // ★ 两条都刻意是**全局命令**（不要求白板视图在前台）：它们管的是整个库里的一批
  //   生成物，而"我库里怎么多了一堆 md"正是**没在看白板**的时候才会注意到的事 ——
  //   挂成视图命令的话，最需要它们的时候恰好不在（与「跨白板反链」「白板列表」同一判断）。
  // ★ 都不给默认热键：「重建」是偶尔用一次的维护动作；「删除」是**危险动作**，
  //   给危险动作绑组合键等于给误按留一条直达路径（与「删除白板」同理，那条也没有热键）。
  // ★ 都不给 `available`：开关关着也要让「删除」能用（那正是它最该出现的时刻），
  //   而「重建」在关着时由动作本身给一句明确的解释，比"命令凭空消失"更好懂。
  plugin.addCommand({
    id: COMMAND_IDS.rebuildIndexNotes,
    name: t('command.rebuildIndexNotes.name'),
    callback: () => {
      void rebuildIndexNotes(plugin);
    },
  });
  plugin.addCommand({
    id: COMMAND_IDS.cleanupIndexNotes,
    name: t('command.cleanupIndexNotes.name'),
    callback: () => {
      void cleanupIndexNotes(plugin);
    },
  });
}

/** 4 档笔宽的命令 id 与热键，顺序与 `INK_BRUSH_WIDTHS` 严格对应 */
const INK_WIDTH_COMMANDS = [
  { id: COMMAND_IDS.inkWidth1, key: '1' },
  { id: COMMAND_IDS.inkWidth2, key: '2' },
  { id: COMMAND_IDS.inkWidth3, key: '3' },
  { id: COMMAND_IDS.inkWidth4, key: '4' },
] as const;

interface ViewCommandSpec {
  id: string;
  nameKey: MessageKey;
  /** 命令名里的占位符（`{n}` 之类）。"同一个名字换个数字"的命令（笔宽 1–4）用得上 */
  nameParams?: Record<string, string | number>;
  hotkeys?: Hotkey[];
  /**
   * 额外的可用条件。返回 `false` 时命令从命令面板消失、快捷键也**不再被截获**
   * —— 这是把键位还给 Obsidian（或还给卡片里的输入框）的唯一正确方式。
   */
  available?: (view: BoardView) => boolean;
  run: (view: BoardView) => void;
}

/**
 * **只有这些命令保留默认热键**（`O25`）。
 *
 * 留下的全是**通用编辑键** —— 撤销 / 重做 / 复制 / 剪切 / 全选 / 搜索 / 缩放。
 * 去掉它们不是"少一个快捷键"，而是"按了没反应"（Obsidian 不会替自定义视图兜底）。
 * 其余命令（含插件自定的一切组合：`⌘⇧E`、单键 `D`/`E`/`V`、笔宽 `1`–`4`、`⌘U`、`⌘[`/`⌘]`…）
 * 一律**不带默认键**，由用户在 设置 → 快捷键 里自绑。
 */
const DEFAULT_HOTKEY_COMMANDS: ReadonlySet<string> = new Set([
  COMMAND_IDS.undo,
  COMMAND_IDS.redo,
  COMMAND_IDS.copySelection,
  COMMAND_IDS.cutSelection,
  COMMAND_IDS.selectAll,
  COMMAND_IDS.search,
  COMMAND_IDS.zoomIn,
  COMMAND_IDS.zoomOut,
  COMMAND_IDS.zoomReset,
  COMMAND_IDS.zoomFit,
]);

/** 注册一条「只在白板视图里可用」的命令 */
function registerViewCommand(plugin: NestboardPlugin, spec: ViewCommandSpec): void {
  plugin.addCommand({
    id: spec.id,
    name: t(spec.nameKey, spec.nameParams),
    // ★ `O25`：默认键只给通用编辑键，其余一律不下发（见 `DEFAULT_HOTKEY_COMMANDS`）
    ...(spec.hotkeys && DEFAULT_HOTKEY_COMMANDS.has(spec.id) ? { hotkeys: spec.hotkeys } : {}),
    checkCallback: (checking: boolean) => {
      const view = getActiveBoardView(plugin.app);
      if (!view) return false;
      if (spec.available && !spec.available(view)) return false;
      if (!checking) spec.run(view);
      return true;
    },
  });
}

/**
 * 新建一块**顶层**白板，返回落盘路径；失败返回 `null` 并已弹出提示。
 *
 * ★ ⌘⇧N 建的永远是顶层板（`meta.parent = null`）：它是一条"开一块新板"的命令，
 *   用户没说过它该挂在哪。子板是**从某一块板里**发起的动作，入口在白板卡上
 *   （`F2-8-1`），两边的文案也因此不同（"已创建白板" / "已创建子白板"）。
 *
 * `folder` = 落在**这一个目录**里（O12：文件树右键「在此新建白板」）。
 * 不传 = 设置里的新建目录。两种走法的其余行为一字不差，所以共用一个函数 ——
 * "建完说一句话、然后打开"这套只有一份。
 */
export async function createNewBoard(
  plugin: NestboardPlugin,
  folder?: string,
): Promise<string | null> {
  try {
    const path = await createBoardInVault(plugin, { folder });
    new Notice(t('notice.boardCreated', { path }));
    // 建完直接打开：用户按这条命令的意图是"开始画"，不是"在某处多一个文件"
    await openBoardView(plugin.app, path);
    return path;
  } catch (error) {
    new Notice(t('notice.boardCreateFailed', { error: describeError(error) }));
    return null;
  }
}
