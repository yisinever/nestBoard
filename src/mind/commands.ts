/**
 * 脑图的命令（`06 §9`）。
 *
 * ★ 与白板的 `commands.ts` **分开一份**：那份是白板的命令表（`COMMAND_IDS` + 视图命令 +
 *   `O25` 的快捷键收窄），脑图这套塞进去只会让两边都难读；共用的是 Obsidian 的命令注册约定。
 * ★ 命令 id 带 `nestboard:` 前缀（与白板同一套）：Obsidian 用它做全局唯一键。
 * ★ **脑图的命令一条都不带默认热键**（`O25` 的家规在脑图上走到了另一头）：
 *   Obsidian 不会替自定义视图兜底撤销 / 复制粘贴，而"通用编辑键"（`⌘Z` `⌘⇧Z` `⌘C`
 *   `⌘X` `⌘V` `⌘A`）又都压在 Obsidian 的核心键上 —— 声明成命令热键时**谁赢不确定**，
 *   实测分别是"复制没反应"与"撤销按了没反应"。
 *   所以这些键统一由 **`MindView.onWindowKeyDown`**（window 捕获阶段）接：
 *   它是最早能拿到事件的位置，拿到就 `stopPropagation`，一次按键只有一个人处理。
 *   命令仍然登记着（命令面板里点得到、移动端也点得到），只是不带默认键。
 * ★ 其余（加子节点 / 加兄弟 / 删除 / 改标题 / 折叠 / 复制剪切粘贴）同理：不带默认键，
 *   由画布自己处理，用户想改成别的组合可以在 设置 → 快捷键 里自绑。
 */

import { Notice } from 'obsidian';
import type { Hotkey } from 'obsidian';
import { describeError } from '../util/errors';
import { t } from '../util/i18n';
import { createMindInVault } from './io/newMind';
import { getActiveMindView, openMindView } from './view/host';
import type { MindView } from './view/MindView';
import type NestboardPlugin from '../main';

/** 脑图的命令 id（白板的在 `commands.ts` 的 `COMMAND_IDS`，各占一份，互不覆盖） */
export const MIND_COMMAND_IDS = {
  createMind: 'nestboard:create-mind',
  fit: 'nestboard:mind-fit',
  undo: 'nestboard:mind-undo',
  redo: 'nestboard:mind-redo',
  copy: 'nestboard:mind-copy',
  cut: 'nestboard:mind-cut',
  paste: 'nestboard:mind-paste',
  selectAll: 'nestboard:mind-select-all',
  addChild: 'nestboard:mind-add-child',
  addSibling: 'nestboard:mind-add-sibling',
  deleteNode: 'nestboard:mind-delete-node',
  editTitle: 'nestboard:mind-edit-title',
  toggleCollapse: 'nestboard:mind-toggle-collapse',
  toggleOutline: 'nestboard:mind-toggle-outline',
  toggleMinimap: 'nestboard:mind-toggle-minimap',
  exportMarkdown: 'nestboard:mind-export-markdown',
  exportOutlineMarkdown: 'nestboard:mind-export-outline-markdown',
  exportSvg: 'nestboard:mind-export-svg',
  exportPng: 'nestboard:mind-export-png',
  exportFreeMind: 'nestboard:mind-export-freemind',
  exportXmind: 'nestboard:mind-export-xmind',
} as const;

export function registerMindCommands(plugin: NestboardPlugin): void {
  plugin.addCommand({
    id: MIND_COMMAND_IDS.createMind,
    name: t('command.newMind.name'),
    callback: () => {
      void createNewMind(plugin);
    },
  });

  // ── 通用编辑键 ──────────────────────────────────────────
  registerMindViewCommand(plugin, {
    id: MIND_COMMAND_IDS.undo,
    nameKey: 'command.mindUndo.name',
    available: (view) => view.canUndo,
    run: (view) => view.undo(),
  });
  registerMindViewCommand(plugin, {
    id: MIND_COMMAND_IDS.redo,
    nameKey: 'command.mindRedo.name',
    available: (view) => view.canRedo,
    run: (view) => view.redo(),
  });
  registerMindViewCommand(plugin, {
    id: MIND_COMMAND_IDS.copy,
    nameKey: 'command.mindCopy.name',
    available: (view) => view.canCopySelection,
    run: (view) => view.copySelection(),
  });
  registerMindViewCommand(plugin, {
    id: MIND_COMMAND_IDS.cut,
    nameKey: 'command.mindCut.name',
    available: (view) => view.canCutSelection,
    run: (view) => view.cutSelection(),
  });
  registerMindViewCommand(plugin, {
    id: MIND_COMMAND_IDS.paste,
    nameKey: 'command.mindPaste.name',
    available: (view) => view.canPaste,
    run: (view) => view.pasteClipboard(),
  });
  registerMindViewCommand(plugin, {
    id: MIND_COMMAND_IDS.selectAll,
    nameKey: 'command.mindSelectAll.name',
    // ★ 与那三键同一条：`⌘A` 由画布的**窗口捕获**接（见 `MindView.onWindowKeyDown`），
    //   命令只进面板、不带默认键
    available: (view) => view.canSelectAll,
    run: (view) => view.selectAllNodes(),
  });

  // ── 不带默认键的编辑命令（命令面板 / 移动端工具栏用）─────
  registerMindViewCommand(plugin, {
    id: MIND_COMMAND_IDS.addChild,
    nameKey: 'command.mindAddChild.name',
    available: (view) => view.canAddChild,
    run: (view) => view.addChildToSelection(),
  });
  registerMindViewCommand(plugin, {
    id: MIND_COMMAND_IDS.addSibling,
    nameKey: 'command.mindAddSibling.name',
    available: (view) => view.canAddSibling,
    run: (view) => view.addSiblingToSelection(),
  });
  registerMindViewCommand(plugin, {
    id: MIND_COMMAND_IDS.deleteNode,
    nameKey: 'command.mindDelete.name',
    available: (view) => view.canDeleteSelection,
    run: (view) => view.deleteSelection(),
  });
  registerMindViewCommand(plugin, {
    id: MIND_COMMAND_IDS.editTitle,
    nameKey: 'command.mindEditTitle.name',
    available: (view) => view.canEditSelection,
    run: (view) => view.editSelectionTitle(),
  });
  // ── 导出（`06 §7.3`）────────────────────────────────────
  // ★ 不带默认热键：它们各自会写出一个文件，绑上键之后误触的代价不小
  registerMindViewCommand(plugin, {
    id: MIND_COMMAND_IDS.exportMarkdown,
    nameKey: 'command.mindExportMarkdown.name',
    available: (view) => view.mindLoaded,
    run: (view) => void view.exportAs('markdown'),
  });
  registerMindViewCommand(plugin, {
    id: MIND_COMMAND_IDS.exportSvg,
    nameKey: 'command.mindExportSvg.name',
    available: (view) => view.mindLoaded,
    run: (view) => void view.exportAs('svg'),
  });
  registerMindViewCommand(plugin, {
    id: MIND_COMMAND_IDS.exportPng,
    nameKey: 'command.mindExportPng.name',
    available: (view) => view.mindLoaded,
    run: (view) => void view.exportAs('png'),
  });
  // `.mm`（FreeMind）：给别人接着编辑用 —— 它保住的是**树 + 一部分样子**
  //（Markdown 保住的是内容，SVG / PNG 是"看"）。见 `06 §11.51` 的映射表
  registerMindViewCommand(plugin, {
    id: MIND_COMMAND_IDS.exportFreeMind,
    nameKey: 'command.mindExportFreeMind.name',
    available: (view) => view.mindLoaded,
    run: (view) => void view.exportAs('freemind'),
  });
  // 大纲式 Markdown（用户 2026-09-17）：根是标题、一级起是 H1/H2/H3、四级往下是正文，
  // 节点上的内容一律代码块 —— 与上面那份 `.md` **并存**（两种口味）
  registerMindViewCommand(plugin, {
    id: MIND_COMMAND_IDS.exportOutlineMarkdown,
    nameKey: 'command.mindExportOutline.name',
    available: (view) => view.mindLoaded,
    run: (view) => void view.exportAs('outlineMarkdown'),
  });
  // `.xmind`（用户 2026-09-17）：给"接着用 XMind 编"的人 —— 保住树、标题、内容与附件路径，
  // 标记 / 撞色 / 完成态按 XMind 的规范裁掉（见 `export/toXmind.ts` 的说明）
  registerMindViewCommand(plugin, {
    id: MIND_COMMAND_IDS.exportXmind,
    nameKey: 'command.mindExportXmind.name',
    available: (view) => view.mindLoaded,
    run: (view) => void view.exportAs('xmind'),
  });

  registerMindViewCommand(plugin, {
    id: MIND_COMMAND_IDS.toggleCollapse,
    nameKey: 'command.mindToggleCollapse.name',
    available: (view) => view.canToggleCollapse,
    run: (view) => view.toggleSelectionCollapse(),
  });

  // 大纲 / 树（`N3-a`，用户 2026-09-16 定：右上角按钮 + 命令面板各一个入口）。
  // ★ **不给默认键**：用户要的是"点得到"，不是"按得到"；想按就自己绑
  registerMindViewCommand(plugin, {
    id: MIND_COMMAND_IDS.toggleOutline,
    nameKey: 'command.mindToggleOutline.name',
    available: (view) => view.mindLoaded,
    run: (view) => view.toggleOutline(),
  });

  // 缩略图导航器（`P2-c` / `F1-06`）。
  // ★ 与白板那条**同名不同 id**（文案共用 `command.toggleMinimap.name`）：两条的
  //   `checkCallback` 各自只认自己的视图类型（白板那条只看 `BoardView`、这条只看 `MindView`）
  //   ⇒ 面板里任何时刻**只显示一条**「切换缩略图导航器」，不会冒出两条一样的。
  // ★ 不给默认键、也不看 `mindLoaded`：它改的是**设置**（与白板那条同一条理由 ——
  //   即便此刻没有脑图视图，"先把开关打开"也有明确意义）
  registerMindViewCommand(plugin, {
    id: MIND_COMMAND_IDS.toggleMinimap,
    nameKey: 'command.toggleMinimap.name',
    available: () => true,
    run: (view) => view.toggleMinimap(),
  });

  // 适应内容（与白板的 `⌘0` 同一个语义，同样不给默认键）
  registerMindViewCommand(plugin, {
    id: MIND_COMMAND_IDS.fit,
    nameKey: 'command.mindFit.name',
    available: (view) => view.mindLoaded,
    run: (view) => view.fitContent(),
  });
}

interface MindCommandSpec {
  id: string;
  /** i18n 键：命令名在注册时翻一次（与白板同一做法） */
  nameKey: Parameters<typeof t>[0];
  hotkeys?: Hotkey[];
  /** 此刻能不能用：`false` = 命令面板里置灰、热键也不生效 */
  available: (view: MindView) => boolean;
  run: (view: MindView) => void;
}

/**
 * 注册一条「只在脑图视图里可用」的命令。
 *
 * ★ 用 `checkCallback` 而不是 `callback`：命令可用性要**实时**问视图
 *   （选中的是根节点时"删除节点"该置灰、正在改标题时 ⌘Z 该让给输入框）。
 *   `checking` 那一遍只问不跑 —— 面板刷新时会频繁调到它。
 */
function registerMindViewCommand(plugin: NestboardPlugin, spec: MindCommandSpec): void {
  plugin.addCommand({
    id: spec.id,
    name: t(spec.nameKey),
    hotkeys: spec.hotkeys,
    checkCallback: (checking: boolean) => {
      const view = getActiveMindView(plugin.app);
      if (!view || !spec.available(view)) return false;
      if (!checking) spec.run(view);
      return true;
    },
  });
}

/**
 * 建一份新脑图并当场打开。
 *
 * ★ 顺序是"先落盘、再开视图"：反过来的话，视图会去读一个还不存在的文件
 *   （`onLoadFile` 的读盘必然抛错），用户看到的是"打开了但一片报错"。
 *
 * ★ `folder`（`C4`）：文件树右键「在此新建 nestmind」要落**用户右键的那个文件夹**里。
 *   与白板的 `createNewBoard(plugin, folder)` 逐字对齐 —— 两条路（命令面板 / 文件树）
 *   共用这一个实现，于是"建完打开""失败怎么说"都只有一份。
 * ★ 导出（而不是像从前那样只在本文件里用）：`main.ts` 的文件树菜单也要调它。
 */
export async function createNewMind(plugin: NestboardPlugin, folder?: string): Promise<void> {
  try {
    const path = await createMindInVault(plugin, folder ? { folder } : {});
    await openMindView(plugin.app, path);
    new Notice(t('notice.mindCreated', { path }));
  } catch (error) {
    console.warn('[nestboard] 新建脑图失败', describeError(error));
    new Notice(t('notice.mindCreateFailed', { error: describeError(error) }));
  }
}
