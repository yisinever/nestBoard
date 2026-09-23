/**
 * i18n（T1.06 骨架 → T3.23 完整化）。
 *
 * `zh-cn` / `en` 两份语言包结构完整、`t(key)` 可用，且**语言可以跟随 Obsidian**
 * （设置里可选 `auto` / `zh-cn` / `en`，见 `resolveLocale` 与 `main.ts`）。
 *
 * ★ 依赖约束：本文件**不得** import `obsidian`。
 *   因为 `model/` → `util/` 是允许的依赖方向，而 `model/` 必须零 Obsidian 依赖（03 §7.2）。
 *   因此宿主语言也由 `main.ts` **注入**（它拿 Obsidian 官方的 `getLanguage()`，
 *   见 `setHostLanguage`），本文件依旧一个 obsidian 符号都不碰。
 */

export type Locale = 'zh-cn' | 'en';

export const SUPPORTED_LOCALES: readonly Locale[] = ['zh-cn', 'en'];

/** `en` 为基准语言包：其键集合即 `MessageKey`，`zh-cn` 缺键会在编译期报错（DoD-2） */
const en = {
  'board.untitled': 'Untitled board',

  'command.createBoard.name': 'Create new board',

  'notice.boardCreated': 'Board created: {path}',
  'notice.boardCreateFailed': 'Failed to create board: {error}',
  'notice.saveFailed': 'Failed to save board {path}: {error}',
  'notice.boardProtected':
    'Board {path} could not be parsed and is now read-only protected (the original file was NOT overwritten).',
  'notice.boardReloaded': 'Board {path} was modified outside Obsidian and has been reloaded.',
  // ★ 不写 "Board"（P3-c-2）：这条提示白板与脑图**共用**，写死一种文档类型，
  //   另一种的用户就会读到"白板 xxx.nestmind"，比不说还糟
  'notice.conflict': '{path} changed on disk. Choose how to resolve the conflict.',
  'notice.copySaved': 'Copy saved to: {path}',
  'notice.futureVersion':
    'Board {path} was written by a newer version of Nestboard; it is opened read-only.',

  'modal.conflict.title': 'File changed outside Obsidian',
  'modal.conflict.desc':
    'The file {path} on disk differs from the version in memory. To avoid data loss nothing has been written yet.',
  'modal.conflict.useDisk': 'Use disk version',
  'modal.conflict.keepMine': 'Keep my changes',
  'modal.conflict.saveAsCopy': 'Save as copy',
  'modal.conflict.cancel': 'Cancel',
  'modal.conflict.diskUnreadable':
    'The file on disk cannot be parsed, so "Use disk version" is unavailable.',

  'command.zoomIn.name': 'Zoom in',
  'command.zoomOut.name': 'Zoom out',
  'command.zoomReset.name': 'Zoom to 100%',
  'command.zoomFit.name': 'Fit board to view',
  'command.openBacklinks.name': 'Open cross-board backlinks',
  // Home 白板 / 收件箱（T5.07 / F7-03 / F11-09）
  'command.openHome.name': 'Open the Home board',
  'command.addToUnsorted.name': 'Add the current file to the inbox',

  // 白板列表侧栏（T5.08 / F7-04）
  'command.openBoardList.name': 'Open the board list',
  'boardList.title': 'Boards',
  'boardList.modes.ariaLabel': 'How to group the boards',
  'boardList.mode.folders': 'Folders',
  'boardList.mode.recent': 'Recent',
  'boardList.mode.tags': 'Tags',
  'boardList.filter.placeholder': 'Filter boards…',
  'boardList.empty.none': 'No boards yet. Create one with "Create new board".',
  'boardList.empty.noMatch': 'No board matches "{query}".',
  'boardList.empty.noRecent': 'No board opened yet.',
  'boardList.tagHit.untitled': '(untitled card)',
  'boardList.tagHit.ariaLabel': 'Jump to that card on {board}',
  'boardList.untagged': 'Untagged',
  'boardList.open.ariaLabel': 'Open board {path}',

  // Cross-board search sidebar (T7.02 / F8-08)
  'command.openBoardSearch.name': 'Search all boards',
  'boardSearch.title': 'Search all boards',
  'boardSearch.placeholder': 'Search every board…',
  'boardSearch.hint': 'Type to search every board',
  'boardSearch.scanning': 'Indexing boards… ({scanned} done)',
  'boardSearch.empty': 'No board matches (searched {indexed} boards)',
  'boardSearch.count': '{hits} matches · {boards} boards',
  'boardSearch.countScanning': '{hits} matches · {boards} boards (still indexing…)',
  'boardSearch.boards.heading': 'Boards named "{query}"',
  'boardSearch.open.ariaLabel': 'Go to {path}',

  // 缩略图导航器（T5.09 / F1-06）
  'command.toggleMinimap.name': 'Toggle the minimap navigator',
  'minimap.title': 'Minimap',
  'minimap.hide': 'Hide the minimap',
  'minimap.surface': 'Minimap: click or drag to move the view',

  // 选区与层级（T1.31 / F2-00-4）
  'command.selectAll.name': 'Select all cards',
  'command.bringToFront.name': 'Bring selection to front',
  'command.sendToBack.name': 'Send selection to back',

  'view.board.name': 'Board',

  // ── 脑图（`.nestmind`，`06`）────────────────────────────────
  // 与白板各占一块，键统一挂 `mind.` 前缀：脑图是第二个**文档类型**，
  // `board.untitled` 与 `mind.untitled` 是两份不同的默认名，谁也不该顶替谁
  'mind.untitled': 'Untitled mind map',
  // 新建脑图时**节点上**的默认文字（用户 2026-09-22：新建出来的节点要是空白的，
  // 一眼看不出"这里该写什么"）。与 `mind.untitled` 分工不同：那个是**文件名**。
  'mind.default.root': 'Central topic',
  'mind.default.branch': 'Subtopic {index}',
  'view.mind.name': 'Mind map',
  'command.newMind.name': 'Create new mind map',
  'notice.mindCreated': 'Mind map created: {path}',
  'notice.mindCreateFailed': 'Failed to create mind map: {error}',
  'mind.loadFailed': 'This mind map could not be parsed — the file was NOT modified.',
  'command.mindFit.name': 'Fit mind map to view',
  'mind.nodeTitle.label': 'Node title',
  'mind.nodeTitle.empty': '(untitled)',
  'mind.imageHint': 'Double-click to open',
  'mind.refMissing': 'Attachment is gone: {path} (renamed, moved or deleted)',
  'mind.controls.zoomIn': 'Zoom in',
  'mind.controls.zoomOut': 'Zoom out',
  'mind.controls.zoomReset': 'Reset to 100%',
  'mind.controls.fit': 'Fit to content',
  'mind.controls.structure': 'Structure',
  'mind.controls.edge': 'Branch lines',
  'mind.handle.collapse': 'Collapse subtopics',
  'mind.handle.expand': 'Expand {count} hidden topics',
  'history.mindAddChild': 'add subtopic',
  'history.mindAddSibling': 'add topic',
  'history.mindPromote': 'promote topic',
  'history.mindDelete': 'delete topic',
  'history.mindEditTitle': 'edit topic title',
  'history.mindNote': 'edit topic content',
  'history.mindAttach': 'attach files to topic',
  'history.mindDetach': 'remove attachment',
  'history.mindImageResize': 'resize image',
  'history.mindDuplicate': 'duplicate topic',
  'history.mindMark': 'set topic mark',
  'history.mindLink': 'add relation line',
  'history.mindLinkLabel': 'edit relation line label',
  'history.mindLinkArrow': 'change relation line arrow',
  'history.mindLinkRemove': 'remove relation line',
  'history.mindLinkBend': 'bend relation line',
  'history.mindLinkColor': 'relation line color',
  'menu.mindLink.editLabel': 'Edit label',
  'menu.mindLink.straighten': 'Straighten',
  'menu.mindLink.colorDefault': 'Default color',
  'mind.linkHandle.label': 'Drag to bend this line',
  'menu.mindLink.arrow': 'Arrow',
  'menu.mindLink.arrow.none': 'None',
  'menu.mindLink.arrow.end': 'One end',
  'menu.mindLink.arrow.both': 'Both ends',
  'menu.mindLink.dashed': 'Dashed',
  'menu.mindLink.solid': 'Solid',
  'menu.mindLink.remove': 'Delete relation line',
  // ── 卡片属性面板（`B1`，用户 2026-09-18）────────────────────
  'inspector.title': 'Card properties',
  'inspector.empty': 'Select a card on a board to see all of its properties here.',
  'inspector.type': 'Type',
  'inspector.content': 'Content',
  'inspector.contentColors': '{count} color(s)',
  'inspector.contentItems': '{count} item(s)',
  'inspector.contentImages': '{count} image(s)',
  'inspector.contentStrokes': '{count} stroke(s)',
  'inspector.contentComments': '{count} note(s)',
  'inspector.cardId': 'Card ID',
  'inspector.placement': 'Placed in',
  'inspector.onCanvas': 'On the canvas',
  'inspector.name': 'Name (title)',
  'inspector.color': 'Color',
  'inspector.showTitle': 'Show title bar',
  'inspector.showBorder': 'Show border and background',
  'inspector.locked': 'Locked',
  'inspector.x': 'X',
  'inspector.y': 'Y',
  'inspector.width': 'Width',
  'inspector.height': 'Height',
  'inspector.rotation': 'Rotation (°)',
  'inspector.z': 'Stack order (z)',
  'command.openCardInspector.name': 'Open card properties',
  'menu.card.inspector': 'Properties…',
  'menu.mindFocusIn': 'Focus into topic',
  'menu.mindFocusOut': 'Go up one level',
  'menu.mindDone': 'Mark as done',
  'menu.mindUndone': 'Mark as not done',
  'history.mindDone': 'toggle done',
  'mind.outline.crumbs': 'Breadcrumb',
  'mind.outline.allTree': 'Whole tree',
  'menu.mindRemoveKeepChildren': 'Delete this row (keep its children)',
  'menu.mindCollapseAll': 'Collapse all topics',
  'menu.mindExpandAll': 'Expand all topics',
  'menu.mindCenterRoot': 'Center on the central topic',
  'history.mindCollapseAll': 'collapse all topics',
  'history.mindExpandAll': 'expand all topics',
  'mind.linkLabel.label': 'Relation line label',
  'mind.outline.toOutline': 'Outline view',
  'mind.outline.toTree': 'Tree view',
  'mind.outline.branchSize': '{count} topics in this branch',
  'mind.outline.noteLabel': 'Topic note',
  'mind.outline.untitled': '(untitled)',
  'mind.outline.rowMenu': 'Actions for this topic',
  'command.mindToggleOutline.name': 'Toggle outline view',
  'history.mindLinkSolid': 'change relation line style',
  'history.mindFormat': 'format title',
  'history.mindColor': 'change title background',
  'history.mindInk': 'change title text color',
  'history.mindHighlight': 'change text highlight',
  'notice.mindAttached': 'Attached “{name}” to this topic',
  'notice.mindReplaced': 'Replaced the attachment with “{name}”',
  'notice.mindAttachOne': 'One attachment per topic — only the first file was attached',
  'notice.mindRefMissing': 'The referenced file is gone: {path}',
  'notice.mindHiddenNode': 'That topic is inside a collapsed branch — expand it to see it',
  'menu.mindCut': 'Cut',
  'menu.mindCopy': 'Copy',
  'menu.mindDuplicate': 'Duplicate here',
  'menu.mindPaste': 'Paste as child',
  'menu.mindEditNote': 'Edit content',
  'menu.mindDelete': 'Delete',
  'menu.mindCollapse': 'Collapse',
  'menu.mindExpand': 'Expand',
  'menu.mindAddChild': 'Add subtopic',
  'menu.mindAddSibling': 'Add sibling topic',
  // 容器级（`2.2.0`）：删掉**整棵**脑图（与节点级的 `menu.mindDelete` 分开措辞）
  'menu.mindDeleteAll': 'Delete this mind map',
  'menu.mindOpenAttachment': 'Open attachment',
  'menu.mindRemoveAttachment': 'Remove attachment',
  'mind.toolbar.mark': 'Mark',
  'mind.toolbar.bold': 'Bold',
  'mind.toolbar.italic': 'Italic',
  'mind.toolbar.underline': 'Underline',
  'mind.toolbar.ink': 'Title text color',
  'mind.toolbar.color': 'Title background',
  'mind.toolbar.editNote': 'Edit content',
  'mind.toolbar.insertImage': 'Insert image',
  'mind.toolbar.link': 'Add relation line',
  'mind.toolbar.clearMark': 'Clear mark',
  'mind.toolbar.highlight': 'Text highlight',
  'mind.toolbar.clearHighlight': 'No highlight',
  'mind.toolbar.clearInk': 'Default text color',
  'mind.toolbar.clearColor': 'Default background',
  'mind.emojiGroup.symbols': 'Symbols',
  'mind.emojiGroup.geometry': 'Shapes',
  'mind.emojiGroup.office': 'Office',
  'mind.emojiGroup.status': 'Status',
  'mind.emojiGroup.docs': 'Documents',
  'mind.emojiGroup.ideas': 'Ideas',
  'mind.emojiGroup.time': 'Time',
  'mind.emojiGroup.people': 'People',
  'mind.emojiGroup.nature': 'Nature',
  'mind.emojiGroup.tools': 'Tools',
  'history.mindToggleCollapse': 'collapse / expand topic',
  'history.mindMove': 'move topic',
  'history.mindSplit': 'split topic',
  'history.mindPaste': 'paste subtopics',
  'history.mindExpandHover': 'expand collapsed topic',
  'notice.mindCopied': 'Copied “{text}” and its subtopics',
  'notice.mindCopiedMany': 'Copied {count} topics',
  'notice.mindSelected': 'Selected {count} topics (⇧+click to adjust)',
  'notice.mindDeleted': 'Deleted {count} topics (⌘Z to undo)',
  'notice.mindPasteEmpty': 'Clipboard is empty — copy a topic first with ⌘C',
  'notice.mindPasteNeedsNode':
    'Topics can only be pasted onto a topic — point at the target topic first',
  'notice.mindNodeCopyUnsupported':
    'Copying topics from a file-based mind is not supported yet — open the .nestmind to copy them',
  'notice.mindNodeCopySkipped': 'Skipped {count} topics from file-based minds (not supported yet)',
  'notice.mindConflictOnClose':
    '“{path}” has unsaved changes that could not be written (the file changed on disk and the conflict is unresolved) — closing now loses them.',
  'command.mindUndo.name': 'Undo (mind map)',
  'command.mindRedo.name': 'Redo (mind map)',
  'command.mindAddChild.name': 'Mind map: add subtopic',
  'command.mindAddSibling.name': 'Mind map: add topic',
  'command.mindDelete.name': 'Mind map: delete topic',
  'command.mindEditTitle.name': 'Mind map: edit topic title',
  'command.mindToggleCollapse.name': 'Mind map: collapse / expand topic',
  'command.mindExportMarkdown.name': 'Mind map: export as Markdown',
  'command.mindExportOutline.name': 'Mind map: export as outline Markdown',
  'command.mindExportXmind.name': 'Mind map: export as XMind (.xmind)',
  'command.mindExportSvg.name': 'Mind map: export as SVG',
  'command.mindExportPng.name': 'Mind map: export as PNG',
  'command.mindExportFreeMind.name': 'Mind map: export as FreeMind (.mm)',
  'notice.mindExported': 'Exported to {path}',
  'notice.mindExportFailed': 'Export failed: {error}',
  'command.mindCopy.name': 'Mind map: copy subtopics',
  'command.mindCut.name': 'Mind map: cut subtopics',
  'command.mindPaste.name': 'Mind map: paste subtopics',
  'command.mindSelectAll.name': 'Mind map: select all topics',
  'view.canvas.ariaLabel': 'Board canvas',

  'view.unavailable.title': 'This board cannot be opened',
  'view.unavailable.desc':
    'The file was left untouched. Open "{path}" as plain text to inspect or repair it.',

  // 卡片类型名（T1.24 起用于卡片占位；T1.32+ 由各类型渲染器接管）
  'card.type.note': 'Note',
  'card.type.noteRef': 'Note reference',
  'card.type.image': 'Image',
  'card.type.file': 'File',
  'card.type.link': 'Link',
  'card.type.todo': 'Todo',
  'card.type.swatch': 'Swatch',
  'card.type.boardRef': 'Board',
  'card.type.ink': 'Ink',
  'card.type.map': 'Map',
  'card.type.syncNote': 'Synced note',
  'card.type.comment': 'Comment',
  // PDF 预览卡（`F8`）
  'card.type.pdf': 'PDF',
  'card.pdf.empty': 'Drop a PDF here',
  'card.pdf.page': 'Page {page}',
  'card.pdf.prev': 'Previous page',
  'card.pdf.next': 'Next page',
  // `.canvas` 预览卡（`F6`）
  'card.type.canvas': 'Canvas',
  'card.canvas.empty': 'Drop a .canvas file here',
  'card.canvas.missing': 'File not found',
  'card.canvas.broken': 'Not a valid .canvas file',
  // 脑图卡（`F3a`）：卡面就是那份 `.nestmind`（点节点即可改）
  'card.type.mindRef': 'Mind map',
  'card.mindRef.empty': 'Drop a .nestmind here',
  'card.mindRef.missing': 'Mind map file not found',
  'card.mindRef.broken': 'Cannot read this mind map',
  'card.mindRef.more': '{count} more topics',
  'menu.card.openMind': 'Open mind map',
  // 内嵌脑图卡（`F4`）：脑图模型就长在这张卡里（不指向文件）
  'card.type.mind': 'Mind map (in board)',
  'card.mind.more': '{count} more topics',
  'toolbar.mind': 'New mind map card',
  'menu.mindExportFile': 'Export as .nestmind',
  // 同步便签（T7.04 / F2.9）：卡面上"这是同步组的一员"的角标
  'card.syncNote.badge': 'Synced',
  // 评论卡（T7.05 / F2.9）：本地备注线程
  'card.comment.empty': 'No comments yet',
  'card.comment.add': 'Write a comment',
  'card.comment.placeholder': 'Write a comment…',
  'card.comment.remove': 'Delete this comment',
  'card.comment.unknownTime': 'Time unknown',
  'card.comment.resolved': 'Resolved',
  // 卡片旋转（T7.06 / F2-00-10）：手柄的悬停提示与无障碍名
  'card.rotateHandle': 'Drag to rotate (hold Shift for 15° steps)',

  // 白板内搜索（T2.09 / T2.10 / `F8-01` / `F8-02`）
  'search.title': 'Search this board',
  'search.placeholder': 'Search notes, titles and file names',
  'search.hint': 'Type to search',
  'search.empty': 'No matches on this board',
  'search.count': '{count} matches',
  // 命中的是卡片的哪个字段（结果行里用；没有标题的卡片靠它说明"为什么搜到它"）
  'search.field.title': 'title',
  'search.field.text': 'text',
  'search.field.path': 'path',
  'search.field.url': 'link',

  // 便签卡（T1.32 / T1.33）
  'card.note.empty': 'Empty note — double-click to write',
  'card.note.placeholder': 'Write something…',

  // 待办卡（T3.01 / T3.02）
  'card.todo.empty': 'Empty list — double-click to add tasks',
  'card.todo.item': 'Task',
  'card.todo.completed': '{count} completed',

  // Swatch card (T3.04 / F2.6 / O19)
  'card.swatch.empty': 'Empty palette — paste HEX or double-click',
  'card.swatch.placeholder': '#4C8DFF',
  'card.swatch.hint': 'One HEX per line (the first one fills the card) · ⌘↵ save · Esc cancel',
  'card.swatch.invalid': 'Line not recognized: {line}',
  'card.swatch.copy': 'Copy {color}',
  'card.swatch.copied': 'Copied',
  'card.swatch.copyFailed': 'Copy failed',
  'card.swatch.more': '+{count} more',

  // Ink (T3.06 / F4-01)
  'notice.inkBrush': 'Brush: drag to draw · Esc to exit',
  'notice.inkEraser': 'Eraser: stroke over a line to remove it · Esc to exit',
  'notice.inkReadOnly': 'This board is read-only — ink is unavailable',
  'notice.inkCleared': 'Ink cleared',
  // 期 7 的两支笔与临时层（T7.08 / F4-07、T7.07 / F4-06）
  'notice.inkMarker': 'Highlighter: drag to highlight · Esc to exit',
  'notice.inkAnnotate': 'Temporary markup: strokes are not saved · Esc clears and exits',
  'notice.inkAnnotationsCleared': 'Temporary markup cleared',

  // Grid snapping (T3.11 / F5-02)
  'notice.gridSnapOn': 'Grid snapping on ({size}px)',
  'notice.gridSnapOff': 'Grid snapping off',

  // ── Sprint 9：对齐 / 等距分布 / 编组 / 分栏对齐（T3.13–T3.15）───────
  'command.alignLeft.name': 'Align left',
  'command.alignRight.name': 'Align right',
  'command.alignTop.name': 'Align top',
  'command.alignBottom.name': 'Align bottom',
  'command.alignCenterX.name': 'Align horizontal centers (same x)',
  'command.alignCenterY.name': 'Align vertical centers (same y)',
  'command.distributeX.name': 'Distribute horizontally',
  'command.distributeY.name': 'Distribute vertically',
  'command.groupCards.name': 'Group',
  'command.ungroupCards.name': 'Ungroup',
  'command.alignColumns.name': 'Align sibling columns (top + equal width)',
  'menu.card.arrange': 'Arrange',
  'menu.card.align': 'Align',
  'menu.card.alignLeft': 'Align left',
  'menu.card.alignRight': 'Align right',
  'menu.card.alignTop': 'Align top',
  'menu.card.alignBottom': 'Align bottom',
  'menu.card.alignCenterX': 'Align horizontal centers',
  'menu.card.alignCenterY': 'Align vertical centers',
  'menu.card.distributeX': 'Distribute horizontally',
  'menu.card.distributeY': 'Distribute vertically',
  'menu.card.group': 'Group',
  'menu.card.ungroup': 'Ungroup',
  'menu.column.align': 'Align this row of columns',
  'history.align': 'Align cards',
  'history.distribute': 'Distribute cards',
  'history.group': 'Group cards',
  'history.ungroup': 'Ungroup cards',
  'history.groupCollapse': 'Collapse group',
  'history.groupExpand': 'Expand group',
  'history.groupLabel': 'Group name',
  'history.alignColumns': 'Align columns',
  // 期 6：整理类（T6.07 / T6.08 / F5-06 / F5-07）
  'history.tidyBoard': 'Tidy up board',
  'history.groupByTag': 'Group cards by tag',
  // ★ 一条历史记录**同时**包含"存下链接"与"取回地图图"：那是一次点击的产物
  //   （⌘Z 应当把它整个退掉，而不是留下一个只退了图片的半成品）
  'history.mapLink': 'Paste map link',
  // ★ 新建地图卡时用户没粘链接就取消（`O17`）→ 刚落的空卡要撤掉，这条历史就是那一次撤除
  'history.mapCardCancel': 'Cancel map card',
  'notice.grouped': 'Grouped {count} cards.',
  'notice.ungrouped': 'Ungrouped.',
  'notice.groupNeedsTwo': 'Select at least two cards to group.',
  'notice.ungroupNeedsGroup': 'The selected cards are not in a group.',

  // ── Sprint 9：卡片过滤（T3.17 / T3.18 / F8-04 / F8-06）────────────
  'command.toggleCardFilter.name': 'Filter cards…',
  'filter.title': 'Filter cards',
  'filter.placeholder': 'Search text, tags or file names…',
  'filter.hint': 'Type to filter — non-matching cards fade out',
  'filter.empty': 'No card matches this filter',
  'filter.count': '{count} of {total} cards',
  'filter.types': 'Types',
  'filter.broken': 'Broken refs only',
  'filter.clear': 'Clear',
  'notice.filterCleared': 'Card filter cleared.',
  'notice.onlyBroken': 'Showing {count} card(s) with broken references.',

  // ── Sprint 9：断链总览（T3.19 / F8-07）──────────────────────────
  'command.linkOverview.name': 'Broken links overview',
  'linkOverview.title': 'Broken references',
  'linkOverview.empty': 'No broken references on this board',
  'linkOverview.close': 'Close',
  'linkOverview.repair': 'Repair references',
  'linkOverview.item': '{type}: {path}',
  'linkOverview.reason.image': 'Image not found',
  'linkOverview.reason.file': 'File not found',
  'linkOverview.reason.noteRef': 'Note not found',
  'linkOverview.reason.boardRef': 'Board not found',
  'linkOverview.reason.link': 'Unreadable link',
  'notice.noBrokenLinks': 'No broken references on this board.',

  // ── Sprint 9：复制为 Markdown（T3.20 / F9-08）───────────────────
  'command.copyMarkdown.name': 'Copy as Markdown',
  'notice.markdownCopied': 'Board copied to the clipboard as Markdown.',
  'notice.markdownCopiedSkipped': 'Copied as Markdown — {count} card(s) could not be exported.',
  'notice.markdownCopyFailed': 'Could not write to the clipboard.',
  'notice.markdownCopyEmpty': 'This board has nothing to copy yet.',

  // ── 优化 O11：视图右上角「更多」菜单 ────────────────────────────
  'command.copyBoardLink.name': 'Copy board link',
  'notice.boardLinkCopied': 'Board link copied to the clipboard.',
  'notice.boardLinkUnavailable': 'This board is still loading — try again in a moment.',

  // ── Sprint 9：白板嵌入笔记只读渲染（T3.16 / F10-04 / F1-10）────────
  'embed.title': 'Embedded board',
  'embed.invalid': 'No board path was given.',
  'embed.notFound': 'Board not found: {path}',
  'embed.loadFailed': 'Could not read the board: {error}',
  'embed.empty': 'This board is empty',
  'embed.open': 'Open board',
  'embed.cards': '{count} cards',

  // Ink bar (T3.07 / F4-02)
  'inkBar.ariaLabel': 'Ink tools',
  'inkBar.color': 'Color {color}',
  'inkBar.customColor': 'Custom color…',
  'inkBar.width': 'Brush size {n}',
  'inkBar.tool.brush': 'Brush',
  'inkBar.tool.marker': 'Highlighter',
  'inkBar.tool.annotate': 'Temporary markup',
  'inkBar.clear': 'Clear temporary markup',

  // Pick a color from an image card (T3.05 / F2.6)
  'menu.card.pickFromImage': 'Pick color from image',
  'notice.swatchPickStart': 'Click an image to pick a color · Esc to cancel',
  'notice.swatchPicked': 'Picked {color}',
  'notice.swatchDuplicate': '{color} already fills this card',
  'notice.swatchNeedImage': 'Click an image card to pick its color',
  'notice.swatchOutside': 'That spot is outside the image',
  'notice.swatchNoColor': 'No color there (transparent pixel or unreadable image)',
  'notice.swatchUnavailable': 'Color picking is unavailable here',
  'notice.fileCardRenameExists': 'A file named {name} already exists',
  'notice.fileCardRenameFailed': 'Could not rename the file',

  // 待办总览浮层（T3.03 / F2.5）
  'todoOverview.title': 'Open to-dos',
  'todoOverview.empty': 'No open to-dos on this board',
  'todoOverview.close': 'Close',

  // 卡片的公共外观（T1.39 / T1.40）
  'card.title.placeholder': 'Title',
  'color.red': 'Red',
  'color.orange': 'Orange',
  'color.yellow': 'Yellow',
  'color.green': 'Green',
  'color.cyan': 'Cyan',
  'color.purple': 'Purple',
  'color.none': 'None',
  'color.custom': 'Custom color…',

  // 卡片 / 画布右键菜单（T1.41 / T1.34）
  'menu.card.edit': 'Edit content',
  // 地图卡（T7.03 / F2.9）：换图与清图钉；`O08` 起多了"粘一条分享链接"
  'menu.card.pickMapImage': 'Choose map image',
  'menu.card.clearPin': 'Clear pin',
  // ★ 这一项写的是"粘贴"而不是"输入"：多数时候它真的只是把剪贴板里的链接拿来用一下
  'menu.card.pasteMapLink': 'Paste map link',
  'menu.card.openMapLink': 'Open the link',
  // 同步便签（T7.04 / F2.9）：再摆一张（进同一个同步组）/ 脱离同步组变回普通便签
  'menu.card.syncDuplicate': 'Add synced copy',
  'menu.card.syncDetach': 'Unsync',
  // 评论卡（T7.05 / F2.9）：整条线程收口 / 重新打开
  'menu.card.commentResolve': 'Mark resolved',
  'menu.card.commentReopen': 'Reopen',
  'menu.card.editSource': 'Always edit source',
  'menu.card.editPreview': 'Always render preview',
  'menu.card.editTitle': 'Edit title',
  'menu.card.showTitle': 'Show title',
  'menu.card.hideTitle': 'Hide title',
  'menu.card.collapse': 'Collapse card',
  'menu.card.expand': 'Expand card',
  'menu.mind.presentAdd': 'Add this mind to the presentation',
  'menu.mind.presentRemove': 'Remove this mind from the presentation',
  'menu.mind.presentEarlier': 'Move earlier',
  'menu.mind.presentLater': 'Move later',
  'menu.card.treeCollapse': 'Collapse children (+{count})',
  'menu.card.treeExpand': 'Expand children (+{count})',
  'menu.card.treeUnlink': 'Detach from parent',
  'menu.card.resetRotation': 'Reset rotation',
  'menu.card.color': 'Card color',
  'menu.card.accent': 'Accent bar',
  'menu.card.bringToFront': 'Bring to front',
  'menu.card.sendToBack': 'Send to back',
  'menu.card.duplicate': 'Duplicate in place',
  'menu.card.copy': 'Copy',
  'menu.card.cut': 'Cut',
  'menu.card.lock': 'Lock',
  'menu.card.unlock': 'Unlock',
  'menu.card.presentAdd': 'Add to presentation',
  'menu.card.presentRemove': 'Remove from presentation',
  'menu.card.presentEarlier': 'Move earlier in presentation',
  'menu.card.presentLater': 'Move later in presentation',
  'menu.card.promote': 'Promote to note…',
  'menu.card.openSource': 'Open source note',
  'menu.card.relink': 'Relink…',
  'menu.card.pickBlock': 'Show a block…',
  'menu.card.delete': 'Delete',
  // 连线右键菜单（T1.69）
  'menu.edge.style': 'Line style',
  'menu.edge.solid': 'Solid',
  'menu.edge.dashed': 'Dashed',
  'menu.edge.arrow': 'Arrows',
  'menu.edge.arrowNone': 'No arrow',
  'menu.edge.arrowForward': 'Target end',
  'menu.edge.arrowBackward': 'Source end',
  'menu.edge.arrowBoth': 'Both ends',
  'menu.edge.routing': 'Routing',
  'menu.edge.routingFree': 'Straight',
  'menu.edge.routingSmart': 'Route around cards',
  'menu.edge.straighten': 'Straighten',
  'menu.edge.label': 'Label',
  'menu.edge.routingCurve': 'Curved',
  'menu.edge.labelEdit': 'Edit label…',
  'menu.edge.labelClear': 'Clear label',
  'menu.edge.color': 'Color',
  'menu.edge.delete': 'Delete connection',
  'modal.edgeLabel.title': 'Connection label',
  'modal.edgeLabel.desc': 'Shown at the middle of the connection. Leave empty to remove the label.',
  'modal.edgeLabel.placeholder': 'e.g. depends on',
  'modal.edgeLabel.save': 'Save',
  'modal.edgeLabel.cancel': 'Cancel',
  'canvas.edgeCurveHandle': 'Drag to bend the connection',
  'history.edgeRouting': 'Change connection routing',
  'history.edgeStraighten': 'Straighten connection',
  'history.edgeLabel': 'Change connection label',
  'history.edgeCurve': 'Bend connection',
  'menu.canvas.newNote': 'New note',
  'menu.canvas.filter': 'Filter cards…',
  'menu.canvas.moreCards': 'More cards',
  'menu.canvas.newSyncNote': 'New synced note',
  'menu.canvas.newComment': 'New comment card',
  'menu.canvas.newTodo': 'New todo list',
  'menu.canvas.present': 'Start presenting',
  'menu.canvas.selectAll': 'Select all',
  'menu.canvas.fitContent': 'Fit to content',
  'menu.canvas.zoomReset': 'Zoom to 100%',
  // 期 6：整理类（T6.07 / T6.08 / F5-06 / F5-07）
  'menu.canvas.tidyBoard': 'Tidy up board',
  'menu.canvas.groupByTag': 'Group cards by tag',

  // 引用卡（T1.42 / T1.45）
  'card.noteRef.empty': 'Empty reference — choose a note',
  'card.noteRef.missing': 'Note not found: {path}',
  'card.noteRef.loadFailed': 'Could not read the note.',
  'card.noteRef.relink': 'Relink',
  'card.noteRef.conflict': 'The source note changed elsewhere — your edits were NOT saved.',
  'card.noteRef.writeMissing': 'The source note is gone — your edits were not saved.',
  'card.noteRef.writeFailed': 'Could not write to the source note — your edits were not saved.',
  'card.noteRef.discard': 'Discard',
  // 跨白板反链角标（T5.04 / F10-03）。★ 用"反链：N"而不是"N 条反链"，
  // 因为英文单复数没法用一个模板糊过去（Backlinks: 1 比 1 backlinks 好看）
  'card.noteRef.backlinks': 'Backlinks: {count}',
  // 定位到某一处（T7.10 / F10-07）
  'card.noteRef.targetMissing': 'Link target not found — showing the whole note.',
  'modal.noteRefTarget.title': 'Show a block',
  'modal.noteRefTarget.desc': 'Pick what this card should show. Heading depth is kept as-is.',
  'modal.noteRefTarget.whole': 'Whole note',
  'modal.noteRefTarget.block': 'Block ^{id}',
  'modal.noteRefTarget.empty': 'This note has no headings and no block ids.',
  'history.noteRefTarget': 'Change reference target',
  'menu.card.editContent': 'Edit content',
  'menu.card.annotate': 'Draw on image',
  'menu.card.cropImage': 'Crop image',
  'menu.card.inkColor': 'Stroke color',

  // 裁剪对话框（T2.02 / F2-3-3）
  'modal.crop.title': 'Crop image',
  'modal.crop.hint':
    'Drag the frame to pick the visible area. The original file is never modified.',
  'modal.crop.reset': 'Reset',
  'modal.crop.apply': 'Apply crop',
  'modal.crop.loading': 'Loading image…',
  'modal.crop.loadFailed': 'Could not load the image.',

  'modal.ok': 'OK',
  'modal.cancel': 'Cancel',
  'modal.pickNote.title': 'Choose a note',
  'modal.pickNote.placeholder': 'Type to search notes…',
  'modal.pickBoard.title': 'Choose a board',
  'modal.pickBoard.placeholder': 'Type to search boards…',
  'modal.pickBoard.create': '+ New sub-board',
  'modal.pickBoard.createHint': 'Creates a .nboard under this board',
  'color.invalid': 'Not a valid color code (use #RGB or #RRGGBB).',

  // 撤销栈里的操作名（T1.48）：显示给用户看，必须是"人话"而不是函数名
  'history.move': 'Move',
  // 白板级脑图（`2.2.0`）：树内部的一次改动（内嵌那份走白板撤销栈时的记录名）
  'history.mindEdit': 'Edit mind map',
  'history.resize': 'Resize',
  'history.rotate': 'Rotate card',
  'history.delete': 'Delete cards',
  'history.treeLink': 'Link as child',
  'history.treeCollapse': 'Collapse children',
  'history.treeUnlink': 'Detach from parent',
  'history.duplicate': 'Duplicate cards',
  'history.paste': 'Paste cards',
  'history.color': 'Card color',
  'history.title': 'Card title',
  'history.collapse': 'Collapse card',
  'history.order': 'Layer order',
  'history.create': 'New card',
  'history.createChildBoard': 'New sub-board',
  'history.toggleCardBorder': 'Card border',
  'history.toggleLinkStyle': 'Link card style',
  'history.titleStyle': 'Label card style',
  'history.lock': 'Lock cards',
  'history.presentAdd': 'Add to presentation',
  'history.presentRemove': 'Remove from presentation',
  'history.presentOrder': 'Presentation order',
  'history.presentClear': 'Clear presentation',
  'history.crop': 'Crop image',
  'history.pickMapImage': 'Change map image',
  // 同步便签（T7.04）
  'history.newSyncNote': 'New synced note',
  // 评论卡（T7.05）
  'history.newComment': 'New comment card',
  'history.commentResolve': 'Resolve comment thread',
  'history.commentReopen': 'Reopen comment thread',
  'history.syncNoteDup': 'Add synced copy',
  'history.syncNoteDetach': 'Unsync note',
  // 白板卡片面预览（T7.09 / `F7-10`）
  'history.boardPreview': 'Change card preview',
  // 白板卡卡面图标（`O10`）
  'history.boardIcon': 'Change card icon',
  // 便签配色变体（`O06`）
  'history.noteVariant': 'Change note style',
  'history.inkDraw': 'Draw stroke',
  'history.inkErase': 'Erase ink',
  'history.inkColor': 'Stroke color',
  'history.inkClear': 'Clear ink',
  'history.connect': 'Connect cards',
  'history.edgeStyle': 'Change connection style',
  'history.edgeColor': 'Change connection color',
  'history.gridSnap': 'Grid snapping',

  'notice.undone': 'Undone: {label}',
  'notice.redone': 'Redone: {label}',
  'notice.undoEmpty': 'Nothing to undo',
  'notice.redoEmpty': 'Nothing to redo',

  'notice.sourceMissing': 'The referenced note no longer exists: {path}',
  'notice.sourceMissingFile': 'The source file no longer exists: {path}',
  'notice.promoteCreated': 'Note created: {path}',
  'notice.promoteFailed': 'Could not promote the card: {error}',

  // 命令名（T1.34–T1.48 新增）
  'command.newNote.name': 'New note',
  'command.newTodo.name': 'New todo list',
  'command.newSwatch.name': 'New color palette',
  'command.newMap.name': 'New map card',
  'command.newSyncNote.name': 'New synced note',
  'command.newComment.name': 'New comment card',
  'command.todoOverview.name': 'To-do overview',
  'command.inkBrush.name': 'Ink: brush',
  'command.inkEraser.name': 'Ink: eraser',
  'command.inkSelect.name': 'Ink: back to selection',
  'command.clearInk.name': 'Clear ink strokes or temporary markup',
  'command.inkMarker.name': 'Ink: highlighter',
  'command.inkAnnotate.name': 'Ink: temporary markup',
  'command.inkColor.name': 'Ink: choose color…',
  'command.inkSwapColor.name': 'Ink: swap the last two colors',
  'command.inkWidth.name': 'Ink: brush size {n}',
  'command.toggleGridSnap.name': 'Toggle grid snapping',
  'command.editSelection.name': 'Edit selected card',
  'command.deleteSelection.name': 'Delete selection',
  'command.duplicateSelection.name': 'Duplicate in place',
  'command.copySelection.name': 'Copy cards',
  'command.cutSelection.name': 'Cut cards',
  'command.toggleTitle.name': 'Toggle card title',
  'command.toggleLock.name': 'Lock / unlock cards',
  'command.promoteSelection.name': 'Promote selection to note',
  'command.undo.name': 'Undo',
  'command.redo.name': 'Redo',

  // ── Sprint 4：附件 / 分栏 / 嵌套白板 / 拖拽（T1.49–T1.67）─────────────
  // 图片卡（T1.50 / T1.52）
  'card.image.empty': 'Image not found: {path}',
  'card.image.loading': 'Loading image…',
  'card.image.caption': 'Add a caption…',
  'menu.card.editCaption': 'Edit caption',
  'menu.card.hideBorder': 'Hide border',
  'menu.card.showBorder': 'Show border',

  // 地图卡（T7.03 / F2.9）：一张本地静态地图图 + 一个图钉
  'card.map.empty': 'Map image not found: {path}',
  'card.map.labelPlaceholder': 'Place name…',
  'card.map.pinAt': 'Pin at {pin}',
  'card.map.noPin': 'No pin yet',
  'card.map.hint': 'Enter saves · Esc cancels · right-click to change the image',
  'card.map.hintDrop': 'Double-click the map to drop a pin',
  // 没图时的卡面（O08）：贴过链接的卡不是空框，而是"坐标 + 链接"
  'card.map.missingImage': 'Map image not found: {path}',
  // ★ 两句提示的分工：配好了静态图服务的说"再取一次"，没配的说"去哪儿配"
  'card.map.hintFetchTile': 'Right-click "Paste map link" to fetch the map image again',
  'card.map.hintTileSetup':
    'Pick a static map service in settings, and pasting a link will fetch the image',

  // 文件卡（T1.53）
  'card.file.missing': 'File not found: {path}',
  'card.file.open': 'Open with the system default app',

  // 音视频卡（T3.10 / `F2-3-8`）
  'card.media.play': 'Play',
  // ── 视频卡（`A1`，用户 2026-09-18）──────────────────────────
  'card.type.video': 'Video',
  'toolbar.video': 'New video',
  'card.video.empty': 'No video yet — drop one in, or pick a file from “More cards”.',
  'drop.hint.video': 'Place as a video card',
  // ── 音频卡（`A2`，用户 2026-09-18）──────────────────────────
  'card.type.audio': 'Audio',
  'toolbar.audio': 'New audio',
  'card.audio.empty': 'No audio yet — drop one in, or pick a file from “More cards”.',
  'card.audio.pause': 'Pause',
  'card.audio.seek': 'Seek',
  'card.audio.volume': 'Volume',
  'card.audio.mute': 'Mute',
  'card.audio.unmute': 'Unmute',
  'drop.hint.audio': 'Place as an audio card',
  // ── 仅标题卡（`A3`，用户 2026-09-18）────────────────────────
  'card.type.titleCard': 'Label card (title only)',
  'toolbar.titleCard': 'New label card',
  'card.titleCard.placeholder': 'Double-click to write one line…',
  'menu.card.titleShapePill': 'Plain rounded',
  'menu.card.titleShapeBubble': 'Speech bubble',
  'menu.card.titleTail': 'Pointer direction',
  'menu.card.tailBottom': 'Down',
  'menu.card.tailTop': 'Up',
  'menu.card.tailLeft': 'Left',
  'menu.card.tailRight': 'Right',
  // ── 图集卡（`A4`，用户 2026-09-18）──────────────────────────
  'card.type.gallery': 'Gallery',
  'toolbar.gallery': 'New gallery',
  'card.gallery.empty': 'No images yet — drop a few in together to make a gallery.',
  'card.gallery.prev': 'Previous image',
  'card.gallery.next': 'Next image',
  'card.gallery.counter': '{index} / {total}',
  'card.media.collapse': 'Hide the player',
  'card.media.unplayable': 'This file cannot be played (unsupported format).',

  // 白板卡与嵌套白板（T1.61 / T1.63）
  // 链接卡与隐私开关（T2.04–T2.06 / `F2-4-*` / `F11-07`）
  'card.link.empty': 'No link yet',
  'card.link.fetch': 'Fetch preview',
  'card.link.refetch': 'Refresh preview',
  'card.link.fetching': 'Fetching…',
  'card.link.retry': 'Retry',
  'card.link.disabled': 'Preview is off',
  // 按钮上的一档（T6.06）：**必须与 `card.link.disabled` 分开**——
  // 说"预览已关闭"会让用户去翻一个明明开着的总开关
  'card.link.blocked': 'Site is blocked',
  'card.link.open': 'Open in browser',
  'menu.card.fetchPreview': 'Fetch preview',
  'menu.card.linkCompact': 'Compact bookmark style',
  'menu.card.linkFull': 'Full card style',
  'notice.linkFetched': 'Preview updated',
  'notice.linkFetchFailed': 'Could not fetch a preview for that page',
  // ★ 要说清两件事：**没发请求**（这是黑名单存在的意义），以及**怎么解掉**
  //   （否则用户只知道自己被拦了，不知道去哪删）
  'notice.linkBlocked':
    'That site is on your "never fetch" list — nothing was requested. Remove it in settings if you want previews for it.',
  'notice.linkPreviewDisabled': 'Preview fetching is off — turn it on in settings',
  'notice.linkPreviewEnabled':
    'Link previews are on: pressing "Fetch preview" requests that page and saves its preview image into your vault. Nothing is fetched automatically.',
  // 地图链接（O08）。★ 三句分别对应三种降级，都要说清"现在卡上有什么"与"下一步做什么"：
  //   认不出（换一条链接）/ 存下来了但没出图（去哪儿配）/ 出图失败（链接还在，可以重试）
  'notice.mapLinkUnknown':
    'That text has no coordinates we can read (short links have to be opened in a browser first)',
  'notice.mapLinkSaved':
    'Link and coordinates saved — pick a static map service in settings to fetch the image',
  'notice.mapLinkFetched': 'Map image fetched and saved into your vault',
  'notice.mapLinkFetchFailed':
    'Could not fetch the map image — the link and coordinates are saved, so you can retry later',
  'notice.mapNoClipboard': 'Could not read the clipboard — paste the link here instead',
  'settings.linkPreview.name': 'Fetch link previews',
  // ★ 免责说明要写全"会发生什么"（`O20` 起默认开，措辞里的"默认"也跟着改了）：
  //   联网的**触发点**是那一次点击，不是开板 —— 这一点必须让人一眼看到
  'settings.linkPreview.desc':
    'On by default. Nothing is ever fetched on its own: the request only happens when you press "Fetch preview". Title, summary, site name and icon are read from that page, and its preview image is saved into your vault as an attachment.',
  // 域名黑名单（T6.06 / F2-4-6）。★ 说明里必须点出三件事：一行一个、写域名就够、
  //   "整站含子域"—— 用户最怕的是"我明明写了它却还在抓"，而那种失败全来自写法没讲清
  'settings.linkPreview.blocklist.name': 'Never fetch these sites',
  'settings.linkPreview.blocklist.desc':
    'One site per line. Nothing is ever requested from them — no page, no preview image. A domain is enough ("example.com"), and it covers every subdomain ("m.example.com"). Full URLs are accepted too; they are reduced to their domain on save.',
  'settings.linkPreview.blocklist.placeholder': 'example.com',
  // 地图卡的静态图服务（O08）。★ 说明要把"发生什么"讲全：这一步是**用户点名**的一次
  //   下载（不是自动联网），默认那一档什么都不做
  'settings.mapTile.name': 'Static map service for map cards',
  'settings.mapTile.desc':
    'Off by default. Once picked, pasting a map link on a map card asks that service for one static image and saves it into your vault. Nothing is ever fetched automatically.',
  // ★ 四档的措辞都是**服务名**而不是"开 / 关"：用户要选的是"去哪要图"
  'settings.mapTile.provider.none': 'Do not fetch (link and coordinates only)',
  'settings.mapTile.provider.osm': 'OpenStreetMap (community service, no key)',
  'settings.mapTile.provider.google': 'Google Static Maps (needs a key)',
  'settings.mapTile.provider.amap': 'Amap / Gaode (needs a key)',
  'settings.mapTile.key.name': 'API key',
  // ★ `{provider}` 是上面选的那一档：一个不说自己在跟谁说话的 key 输入框，
  //   用户不知道该去谁家申请
  'settings.mapTile.key.desc': 'The key {provider} issued to you. Without it no request is sent.',
  'settings.mapTile.key.placeholder': 'Paste the key here…',
  // ★ 空卡说的是**该做什么**（双击建一块子板），不是"这里是空的" ——
  //   后者只是把卡片的状态重复了一遍，用户看完还是不知道该干嘛（T1.61 / `F2-8-1`）
  'card.boardRef.empty': 'Double-click to create a sub-board',
  'card.boardRef.missing': 'Board not found: {path}',
  'card.boardRef.cards': '{count} cards',
  'card.boardRef.cardsAndMinds': '{cards} cards · {minds} mind maps',
  'menu.card.openBoard': 'Open board',
  'menu.card.newChildBoard': 'New sub-board',
  // 卡面预览档位（T7.09 / `F7-10`）。父项说"卡面显示什么"，各子项是一个档位 ——
  // 措辞刻意用名词（Thumbnail / Mini / Live view / None）而不是动词，
  // 让它们读起来像**互斥选项**
  'menu.card.preview': 'Card preview',
  'menu.card.previewThumb': 'Thumbnail',
  'menu.card.previewMini': 'Mini',
  'menu.card.previewLive': 'Live view',
  'menu.card.previewNone': 'None',
  // 卡面图标（`O10`）：白板卡的 emoji 记号。「添加 / 更换」两项分开，是因为它们只在
  // "有没有图标"这两种状态下各出现一个 —— 同一个 `id` 换措辞比摆两项灰着更好
  'menu.card.pickIcon': 'Add icon',
  'menu.card.changeIcon': 'Change icon',
  'menu.card.clearIcon': 'Remove icon',
  // 深色便签（`O06`）：一项开关，标题写**点下去会发生什么**（与"显示/隐藏标题"同一条）——
  // 写"Dark note"的话，用户看不出这张卡现在是哪种、点一下是变过去还是变回来
  'menu.card.noteDark': 'Dark note',
  'menu.card.noteLight': 'Light note',
  'modal.iconPicker.title': 'Pick a card icon',
  'modal.iconPicker.desc': 'Type to filter, or paste any emoji from your system picker.',
  'notice.boardRefCreated': 'Sub-board created: {path}',
  'notice.boardRefFailed': 'Could not create the sub-board: {error}',

  // 面包屑与前进后退（T1.62）
  'breadcrumb.home': 'Home',
  'breadcrumb.root': 'Boards',
  'breadcrumb.ariaLabel': 'Board path',
  'command.openParent.name': 'Go to the parent board',
  'command.navigateBack.name': 'Back',
  'command.navigateForward.name': 'Forward',
  'command.search.name': 'Search in board',
  'command.searchNext.name': 'Jump to next match',
  'command.exportMarkdown.name': 'Export as Markdown',
  'command.exportPng.name': 'Export as PNG',
  'command.exportPdf.name': 'Export as PDF',
  'command.exportSvg.name': 'Export as SVG',
  'command.exportZip.name': 'Export board and attachments as ZIP',
  'command.printBoard.name': 'Print board',
  'notice.noParent': 'This board has no parent board.',

  // 导出（T1.72 / F9-01）
  'export.looseCards': 'Loose cards',
  'notice.exported': 'Exported to {path}',
  'notice.exportedSkipped': 'Exported to {path} ({count} cards skipped)',
  'notice.exportEmpty': 'This board has nothing to export yet.',
  'notice.exportFailed': 'Export failed: {error}',

  // 演示模式（J-06 / J-07）
  'present.bar.label': 'Presentation controls',
  'present.bar.previous': 'Previous step',
  'present.bar.next': 'Next step',
  'present.bar.overview': 'Overview of the whole board',
  'present.bar.exit': 'Exit presentation',
  'present.bar.count': 'Step {current} of {total}',
  'notice.presentEmpty': 'This board has no cards to present yet.',
  'notice.presentAdded': 'Added to the presentation (step {step}).',
  'notice.presentRemoved': 'Removed from the presentation.',
  'notice.presentCleared': 'Presentation cleared.',
  'notice.treeCycle': 'Cannot link: that would create a loop.',
  'notice.treeHasParent': 'Cannot link: that card already has a parent.',

  // 导出 PNG（T2.11 / F9-02）
  'modal.exportPng.title': 'Export PNG',
  'modal.exportPng.range.name': 'Range',
  'modal.exportPng.range.desc': 'What the image should cover.',
  'modal.exportPng.range.all': 'Whole board',
  'modal.exportPng.range.viewport': 'Current view',
  'modal.exportPng.range.selection': 'Selection only',
  'modal.exportPng.scale.name': 'Scale',
  'modal.exportPng.scale.desc': 'Higher scale means a sharper and larger image.',
  'modal.exportPng.paginate.name': 'Split into tiles',
  'modal.exportPng.paginate.desc':
    'Tiles keep a large board crisp. Turn this off for one big image instead.',
  'modal.exportPng.paginate.on': 'Tiled pages',
  'modal.exportPng.paginate.off': 'Single image',
  'modal.exportPng.transparent.name': 'Transparent background',
  'modal.exportPng.transparent.desc': 'Do not draw the canvas background or pattern.',
  'modal.exportPng.export': 'Export',
  'modal.exportPng.planTiled': '{columns}×{rows} = {count} file(s), {width}×{height} px each.',
  'modal.exportPng.planSingle': 'One image, {width}×{height} px.',
  'modal.exportPng.planEmpty': 'Nothing to export.',
  'notice.pngExported': 'Exported to {path}',
  'notice.pngExportedMany': 'Exported {count} images to {folder}',

  // 导出 SVG（T6.01 / F9-06）
  'modal.exportSvg.title': 'Export SVG',
  'modal.exportSvg.range.name': 'Range',
  'modal.exportSvg.range.desc': 'What the vector file should cover.',
  'modal.exportSvg.range.all': 'Whole board',
  'modal.exportSvg.range.viewport': 'Current view',
  'modal.exportSvg.range.selection': 'Selection only',
  'modal.exportSvg.transparent.name': 'Transparent background',
  'modal.exportSvg.transparent.desc': 'Do not draw the canvas background or pattern.',
  'modal.exportSvg.export': 'Export',
  'modal.exportSvg.plan': 'One vector file, {width}×{height} units — scales without loss.',
  'modal.exportSvg.planWithImages':
    'One vector file, {width}×{height} units. {count} bitmap card(s) (image / map) keep their text only.',
  'modal.exportSvg.planEmpty': 'Nothing to export.',
  'notice.svgExported': 'Exported to {path}',

  // 导出 ZIP（T6.02 / F9-07）
  'modal.exportZip.title': 'Export ZIP',
  'modal.exportZip.desc':
    'Package this board together with the attachments it uses, so it opens without broken links elsewhere.',
  'modal.exportZip.count': 'Will pack {count} attachment(s) plus the board file.',
  'modal.exportZip.none':
    'No image or file cards to pack — the archive will hold the board file only.',
  'modal.exportZip.missingTitle':
    '{count} referenced file(s) are missing in the Vault and will be skipped:',
  'modal.exportZip.target':
    'The archive keeps Vault-relative paths — unzip it at your Vault root and the board opens with its files in place.',
  'modal.exportZip.cancel': 'Cancel',
  'modal.exportZip.confirm': 'Export',
  'notice.zipExported': 'Exported to {path}',
  'notice.zipExportedSkipped':
    'Exported to {path} ({count} file(s) could not be read and were skipped)',

  // 导出 PDF（T4.10 / F9-03）
  'pdf.footer.page': '{label} · page {page} of {total}',
  'modal.exportPdf.title': 'Export PDF',
  'modal.exportPdf.range.name': 'Range',
  'modal.exportPdf.range.desc': 'What the pages should cover.',
  'modal.exportPdf.range.all': 'Whole board',
  'modal.exportPdf.range.viewport': 'Current view',
  'modal.exportPdf.range.selection': 'Selection only',
  'modal.exportPdf.orientation.name': 'Paper',
  'modal.exportPdf.orientation.desc': 'A4 pages; each page carries one tile of the board.',
  'modal.exportPdf.orientation.portrait': 'A4 portrait',
  'modal.exportPdf.orientation.landscape': 'A4 landscape',
  'modal.exportPdf.clarity.name': 'Clarity',
  'modal.exportPdf.clarity.desc':
    'Pixels on the long edge of each page. Higher is sharper and heavier — the page count stays the same.',
  'modal.exportPdf.clarity.standard': 'Standard · 2048 px',
  'modal.exportPdf.clarity.high': 'High · 3072 px',
  'modal.exportPdf.clarity.ultra': 'Ultra · 4096 px',
  'modal.exportPdf.export': 'Export',
  'modal.exportPdf.planTiled': '{count} page(s), {columns}×{rows} tiles, {width}×{height} px each.',
  'modal.exportPdf.planEmpty': 'Nothing to export.',
  'modal.exportPdf.bitmapNote':
    'The pages are images: the text in the PDF cannot be selected or searched.',
  'notice.pdfExported': 'Exported to {path}',
  'notice.pdfExportedPages': 'Exported {count} pages to {path}',
  'notice.pdfFailed': 'PDF export failed: {reason}',

  // 打印（T6.03 / F9-10）
  'print.footer.page': '{label} · page {page} of {total}',
  'modal.exportPrint.title': 'Print board',
  'modal.exportPrint.range.name': 'Range',
  'modal.exportPrint.range.desc': 'What the pages should cover.',
  'modal.exportPrint.range.all': 'Whole board',
  'modal.exportPrint.range.viewport': 'Current view',
  'modal.exportPrint.range.selection': 'Selection only',
  'modal.exportPrint.orientation.name': 'Paper',
  'modal.exportPrint.orientation.desc': 'A4 pages; each page carries one tile of the board.',
  'modal.exportPrint.orientation.portrait': 'A4 portrait',
  'modal.exportPrint.orientation.landscape': 'A4 landscape',
  'modal.exportPrint.planTiled': '{count} page(s), {columns}×{rows} tiles.',
  'modal.exportPrint.planEmpty': 'Nothing to print.',
  'modal.exportPrint.posterHint':
    'It spans {columns}×{rows} pages. Adjacent pages overlap slightly on purpose — print them all and tape them into one poster.',
  'modal.exportPrint.confirm': 'Print',
  'notice.printFailed': 'Could not open the print dialog: {reason} — try "Export as PDF" instead.',

  // 模板库（T4.14 / F7-06）
  'command.newBoardFromTemplate.name': 'Create board from template',
  'command.saveBoardAsTemplate.name': 'Save board as template',
  'modal.template.title': 'New board from template',
  'modal.template.placeholder': 'Search templates…',
  'modal.template.empty': 'No template matches.',
  'modal.template.builtin': 'Built-in',
  'modal.template.user': 'My templates',
  'modal.template.summary': '{cards} cards · {columns} columns',
  'modal.template.summaryMinds': '{cards} cards · {columns} columns · {minds} minds',
  'modal.template.skipped': '{count} template(s) could not be read and were skipped.',
  'modal.template.hint':
    'A new board is created in {folder}; the template itself is left untouched.',
  // 模板市场（T6.09）：分类筛选与空模板占位
  'modal.template.category.all': 'All',
  'modal.template.previewEmpty': 'Empty template',
  'modal.template.overflow':
    'Showing the first {shown}. Search or pick a category to narrow it down.',
  'template.category.research': 'Research',
  'template.category.schedule': 'Planning',
  'template.category.moodboard': 'Visual',
  'template.category.writing': 'Writing',
  'notice.templateCreated': 'Board created from "{name}": {path}',
  'notice.templateCreateFailed': 'Could not create the board: {error}',
  'notice.templateUnreadable': 'Could not read the template {path}: {error}',
  'notice.templateListFailed': 'Could not list templates: {error}',
  'notice.templateInvalid': 'not a valid board file',
  'settings.folder.vaultRoot': 'vault root',
  'notice.templateSaved': 'Saved as template: {path}',
  'notice.templateSaveFailed': 'Could not save the template: {error}',
  'modal.saveTemplate.title': 'Save as template',
  'modal.saveTemplate.name.name': 'Template name',
  'modal.saveTemplate.name.desc': 'The board is copied out; the current board is left untouched.',
  'modal.saveTemplate.name.placeholder': 'e.g. Weekly research talk',
  'modal.saveTemplate.note':
    'Saved into {folder}. An existing file of the same name is never overwritten — the new one gets a number.',
  'modal.saveTemplate.empty': 'The template name cannot be empty.',
  'modal.saveTemplate.submit': 'Save',
  'setting.templateFolder.name': 'Template folder',
  'setting.templateFolder.desc':
    'Where "Save as template" writes. Boards created from a template still go to the new-board folder above.',
  // Home 白板路径（T5.07 / F11-09）
  'setting.homeBoard.name': 'Home board path',
  'setting.homeBoard.desc':
    'Where the Home board lives. "Add to the inbox" drops files into its `Unsorted` column. Clear this field to turn the Home board off.',

  // 内置模板的内容（T4.14）—— 模板正文也是文案，跟着界面语言走
  'template.research.name': 'Desk research',
  'template.research.desc':
    'Question → sources → insight → conclusion, plus a question tree to grow',
  'template.research.mind.root': 'Research question',
  'template.research.colA': 'Question',
  'template.research.colB': 'Sources',
  'template.research.colC': 'Insight → Conclusion',
  'template.research.howto.title': 'How to use this board',
  'template.research.howto.md':
    '- The three columns are a **sequence**, not a taxonomy — when stuck, look one column to the left\n- Keep dumping into Sources until it hurts, then start thinking\n- The conclusion must answer the question in column 1',
  'template.research.q.title': 'The question',
  'template.research.q.md': '- The question is:\n- Why answer it now:\n- What "done" looks like:',
  'template.research.hypo.title': 'Write the hypothesis first',
  'template.research.hypo.md':
    'Everything you collect afterwards tests this one line — writing it down is how you notice when the evidence moved you.\n\n- My hypothesis:',
  'template.research.ref.title': 'Notes to read',
  'template.research.src.title': 'Outside sources',
  'template.research.src.md':
    '- Source / author:\n- Key claim:\n- Confidence (primary / secondary / hearsay):',
  'template.research.insight.title': 'Insight',
  'template.research.insight.md':
    '- Three or more sources agree on:\n- Where they contradict each other:\n- What I had wrong:',
  'template.research.concl.title': 'Conclusion',
  'template.research.concl.md':
    'Answer the question at the top in one sentence:\n\n\n\nStill uncertain:',

  'template.schedule.name': 'Weekly plan',
  'template.schedule.desc': 'To do / doing / done, with a hard cap on work in progress',
  'template.schedule.colA': 'To do',
  'template.schedule.colB': 'Doing',
  'template.schedule.colC': 'Done',
  'template.schedule.todo': 'This week',
  'template.schedule.doing': 'In progress',
  'template.schedule.done': 'Finished this week',
  'template.schedule.howto.title': 'How to use this board',
  'template.schedule.howto.md':
    '- One card per task; the checklist inside is for steps\n- Drag right for progress — dragging back is not failure, it is honesty\n- Clear Done every Friday and start Monday from an empty column',
  'template.schedule.ask.title': 'Before it enters the column',
  'template.schedule.ask.md':
    '- What breaks if this never happens?\n- Whose job is it?\n- Is there really room this week?',
  'template.schedule.wip.title': 'Cap it at three',
  'template.schedule.wip.md':
    'More than three open at once means none of them is actually moving.\n\nSend the fourth one back to To do.',
  'template.schedule.review.title': 'When it lands, add one line',
  'template.schedule.review.md':
    '- How long it really took (estimate vs. reality)\n- How to make the next one faster',

  'template.moodboard.name': 'Mood board',
  'template.moodboard.desc':
    'References, a palette and three adjectives — a first visual direction',
  'template.moodboard.primary.title': 'Primary palette',
  'template.moodboard.accent.title': 'Accents',
  'template.moodboard.vibe.title': 'Three adjectives',
  'template.moodboard.vibe.md':
    'Say what this should feel like in three words. Skip anything that means nothing on its own ("clean", "premium").\n\n- \n- \n- ',
  'template.moodboard.refs.title': 'References start here',
  'template.moodboard.refs.md':
    'Drop images in, then add one line on why each one is right. Images alone will mean nothing next week.',
  'template.moodboard.style.title': 'Style reference note',
  'template.moodboard.howto.title': 'How to use this board',
  'template.moodboard.howto.md':
    '- Drag reference images anywhere — snapping is off on this board\n- Double-click a palette card to edit it; paste HEX, one per line\n- Under every reference, write **why** it works',

  'template.writing.name': 'Long-form skeleton',
  'template.writing.desc': 'Material / structure / draft — collect first, arrange later',
  'template.writing.colA': 'Material',
  'template.writing.colB': 'Structure',
  'template.writing.colC': 'Draft',
  'template.writing.howto.title': 'How to use this board',
  'template.writing.howto.md':
    '- The Material column is write-only until you cannot write any more\n- Do not touch Draft until Structure is settled\n- The card body *is* the prose — when it is done, "Export as Markdown"',
  'template.writing.material.title': 'Material',
  'template.writing.material.md':
    'Sentences, numbers, quotes — dump them in, unsorted.\n\n- \n- \n- ',
  'template.writing.refs.title': 'Notes to quote',
  'template.writing.spine.title': 'One-sentence spine',
  'template.writing.spine.md':
    'Who, what happens, and then what — if it does not fit in one sentence, do not start writing yet.',
  'template.writing.outline.title': 'Paragraph order',
  'template.writing.outline.md': '- Opening:\n- Turn:\n- Landing:',
  'template.writing.open.title': 'Opening',
  'template.writing.open.md':
    'Somebody should be doing something in the first sentence.\nNo "in today\'s world", no "with the development of".',
  'template.writing.close.title': 'Closing',
  'template.writing.close.md':
    'Call back to the opening line, then stop.\nDo not summarise — land it.',

  // 诊断信息（T2.17 / 02 §8.3）
  'command.showDiagnostics.name': 'Show diagnostics',
  'modal.diagnostics.title': 'Diagnostics',
  'modal.diagnostics.refresh': 'Refresh',
  'diagnostics.loading': 'Reading…',
  'diagnostics.failed': 'Could not read diagnostics: {error}',
  'diagnostics.path': 'Board',
  'diagnostics.scale': 'Size',
  'diagnostics.scaleValue': '{cards} cards · {columns} columns · {edges} links',
  'diagnostics.dom': 'Canvas DOM nodes',
  'diagnostics.domWarn': 'Over {limit} — style recalculations get expensive while dragging.',
  'diagnostics.rendered': 'Rendered',
  'diagnostics.renderedValue': '{cards} cards · {columns} columns · {pooled} pooled',
  'diagnostics.zoom': 'Zoom',
  'diagnostics.file': 'File size',
  'diagnostics.fileWarn': 'Over {limit} — saves will start to stall.',
  'diagnostics.unavailable': 'Unavailable',
  'diagnostics.thumbs': 'Thumbnail cache',
  'diagnostics.thumbsValue':
    '{entries} in memory · {hits} hit / {misses} miss · {failures} failed · {rate} hit rate',
  'diagnostics.thumbsWarn': 'Mostly misses — the cache is not helping much.',
  'diagnostics.save': 'Last save',
  'diagnostics.saveNone': 'No save yet',
  'diagnostics.saveValue': '{total} ms (serialize {serialize} / write {write})',
  'diagnostics.saveWarn': 'Slow write — look at disk or sync software.',
  'diagnostics.saveSerializeWarn':
    'Serialization dominates — the whole board is rewritten each save.',
  'diagnostics.frames': 'Pending frame tasks',
  'diagnostics.framesValue': '{count}',

  // 重命名 / 移动（T1.73 / F7-05）
  'command.renameBoard.name': 'Rename board',
  'modal.renameBoard.title': 'Rename board',
  'modal.renameBoard.empty': 'Name cannot be empty.',
  'modal.renameBoard.exists': 'A file with that name already exists.',
  'notice.renameFailed': 'Rename failed: {error}',

  // 设置面板（T1.74 / F11-01）
  'settings.newBoardFolder.name': 'New board folder',
  'settings.newBoardFolder.desc': 'Where new boards are created. Leave empty for the vault root.',
  'settings.attachment.location.name': 'Attachment location',
  'settings.attachment.location.desc': 'Where attachments from drag & drop or paste are stored.',
  'settings.attachment.location.vault': 'Follow Obsidian settings',
  'settings.attachment.location.custom': 'Custom folder',
  'settings.attachment.folder.name': 'Custom attachment folder',
  'settings.attachment.folder.desc':
    'Used when the location above is "Custom folder". Leave empty for the vault root.',
  'settings.attachment.naming.name': 'Attachment naming',
  'settings.attachment.naming.desc':
    'A timestamp avoids two files called image.png overwriting each other.',
  'settings.attachment.naming.timestamp': 'Add a timestamp prefix',
  'settings.attachment.naming.original': 'Keep the original name',
  'settings.attachment.dedupe.name': 'De-duplicate attachments by content',
  'settings.attachment.dedupe.desc':
    'When importing, keep only one copy of identical images/files (compared by SHA-256 content, not by name). Off by default: dropping the same file twice is often deliberate. Applies within the current session.',
  'settings.autosave.name': 'Auto-save delay',
  'settings.autosave.desc':
    'How long to wait after the last change before writing to disk. Shorter is safer; longer writes less often.',
  'settings.autosave.value': '{ms} ms',
  'settings.reset.name': 'Reset settings',
  'settings.reset.desc': 'Restore every option on this page to its default value.',
  'settings.reset.button': 'Reset to defaults',
  'notice.settingsReset': 'Settings restored to defaults.',

  // 分栏（T1.54–T1.60）
  'column.title.placeholder': 'Untitled column',
  'column.count': '{count} cards',
  'column.collapse': 'Collapse',
  'column.expand': 'Expand',
  'column.drag': 'Drag to move the column',
  'menu.column.rename': 'Rename column',
  'menu.column.collapse': 'Collapse column',
  'menu.column.expand': 'Expand column',

  // 编组（O03）
  'group.defaultLabel': 'Group',
  'group.count': '{count} cards',
  'group.countMixed': '{cards} cards + {columns} columns',
  'group.collapse': 'Collapse group',
  'group.expand': 'Expand group',
  'menu.column.split': 'Split into columns',
  'menu.column.toGroup': 'Turn column into a group',
  'menu.column.delete': 'Delete column',
  'menu.column.deleteWithCards': 'Delete column and its cards',
  'menu.card.collect': 'Collect into a column',
  'command.splitIntoColumns.name': 'Split into side-by-side columns',
  'command.collectIntoColumn.name': 'Collect into a column',
  'command.toggleColumnCollapse.name': 'Collapse / expand column',
  'command.splitBoard.name': 'Split board…',
  'history.column': 'Column',
  'history.moveColumn': 'Move column',
  'history.resizeColumn': 'Resize column',

  // 拖拽入画布（T1.64–T1.67）
  'menu.file.addToBoard': 'Add to board',
  'menu.file.addToUnsorted': 'Add to the inbox',
  'menu.file.newBoardHere': 'New nestboard here',
  'menu.file.newMindHere': 'New nestmind here',
  'notice.addedToBoard': 'Added {count} card(s) to {board}',
  'notice.addToBoardFailed': 'Could not add the file to {path}.',
  'notice.dropNoBoard': 'There is no open board to drop this on.',
  'notice.noBoardYet': 'No board yet — create one first, then add this file to it.',
  'notice.attachmentFailed': 'Could not import the file: {error}',
  'notice.importing': 'Importing {count} file(s)…',
  'notice.pastedImage': 'Image saved: {path}',
  'notice.copiedCards': 'Copied {count} object(s) — paste into any board',
  'notice.copyFailed': 'Could not write to the system clipboard.',
  'notice.pastedCards': 'Pasted {count} object(s)',
  // 白板 URI（T5.06 / F10-06）。★ 三条拒绝理由各说各的：
  // 只回一句"链接无效"的话，用户没法知道该改哪一个字
  'notice.protocolMissingFile': 'This link has no board path in it (missing `?file=…`).',
  'notice.protocolNotBoard':
    'This link does not point to a board — the path must end in `.nboard`.',
  'notice.protocolOutsideVault': 'This link points outside the vault, so it was refused.',
  'notice.protocolBoardMissing': 'Board not found: {path}',
  // Home 白板 / 收件箱（T5.07 / F7-03）。★ 未配置时说"去设置里填路径"而不是弹一个新建对话框：
  // 那不叫"默认落点"，那叫"又一次让你做选择"—— 而 Home 存在的意义正是免掉这个选择
  'notice.homeNotConfigured':
    'The Home board is turned off. Give it a path in the Nestboard settings first.',
  'notice.addedToUnsorted': 'Added to the inbox',
  // 拖出导出（T6.10 / F6-04）：导出的笔记是要拿去继续写的，所以只报"写了几篇、写到哪"
  'notice.dragOutExported': '{count} note(s) exported to {folder}',
  'notice.dragOutEmpty': 'Nothing to export — those cards are empty.',
  'notice.dragOutFailed': 'Export failed: {error}',
  'drop.hint.noteRef': 'Add as a note reference',
  'drop.hint.image': 'Add as an image',
  'drop.hint.file': 'Add as a file',
  'drop.hint.boardRef': 'Add as a nested board',
  // 拖进来一段文字（T6.11 / F6-07）
  'drop.hint.note': 'Add as a note',
  'drop.hint.multiple': 'Add {count} items',

  // 大文件分级退化（T2.16 / 02 §8.3）
  'scale.hint.degraded':
    'This board is large ({cards} cards) — columns are collapsed to keep it smooth.',
  'scale.hint.split':
    'This board is very large ({cards} cards) — consider splitting it into smaller boards.',
  'scale.hint.oversized':
    'This board file is {size} — lots of inline cards. Promoting long text to notes would speed it up.',
  'scale.action.expandAll': 'Expand all columns',
  'scale.action.split': 'Split board…',
  'scale.action.dismiss': 'Dismiss',
  'notice.columnsExpanded': 'Expanded {count} column(s).',
  'notice.splitNotNeeded': 'This board is not large enough to need splitting.',
  'modal.splitBoard.title': 'Split board',
  'modal.splitBoard.desc':
    'Each selected group becomes its own board; this board keeps a board card pointing at it.',
  'modal.splitBoard.summary':
    '{children} new board(s) · {moved} card(s) moved · {remaining} card(s) stay here',
  'modal.splitBoard.warning': 'Files created by a split cannot be undone from board history.',
  'modal.splitBoard.empty': 'Nothing to split: this board has no non-empty columns.',
  'modal.splitBoard.confirm': 'Split',
  'notice.boardSplit': 'Split into {count} board(s): {paths}',
  'notice.boardSplitFailed': 'Could not split the board: {error}',

  // ── Sprint 10：设置面板分节标题（T3.27 打磨）────────────────────
  'settings.section.board': 'New boards',
  'settings.section.attachment': 'Attachments',
  'settings.section.build': 'Build',
  'settings.build.name': 'Current build',
  'settings.build.desc':
    'Running build {build}. If a change you expect is missing, check this first — an older bundle that has not been reloaded is the usual reason.',
  'settings.section.privacy': 'Privacy & network',
  'settings.section.save': 'Saving',

  // ── Sprint 10：界面语言（T3.23 / F11-13）────────────────────────
  'settings.language.name': 'Interface language',
  'settings.language.desc':
    'Follows Obsidian by default. Choose a language here to override it for this plugin only.',
  'settings.language.auto': 'Follow Obsidian',
  'settings.language.zhCn': '简体中文',
  'settings.language.en': 'English',

  // ── Sprint 10：卡片默认样式（T3.24 / F11-03）────────────────────
  'settings.cardDefaults.name': 'New card appearance',
  'settings.cardColor.name': 'Default card color',
  'settings.cardColor.desc':
    'Applied to cards created from now on. Existing cards keep their own color.',
  'settings.cardColor.custom': 'Custom color…',
  'settings.cardColor.customHex.name': 'Custom color',
  'settings.cardColor.customHex.desc':
    'A hex value such as #4c8bf5. Anything invalid falls back to the theme color.',
  'settings.cardStyle.name': 'Card style',
  'settings.cardStyle.desc':
    'Neumorphic adds the soft double shadow (keeping each card’s colour) to cards, columns, bars and menus. Classic is the 2.1.3 look.',
  'settings.cardStyle.classic': 'Classic (2.1.3)',
  'settings.cardStyle.neumorph': 'Neumorphic',
  'settings.cardRadius.name': 'Corner radius',
  'settings.cardRadius.desc': 'Corner radius of every card in pixels.',
  'settings.cardRadius.value': '{px} px',
  'settings.cardFontSize.name': 'Card font size',
  'settings.cardFontSize.desc': 'Base font size for card text in pixels.',
  'settings.alwaysFullImage.name': 'Always use original image quality',
  'settings.alwaysFullImage.desc':
    'Image cards load the full-resolution file instead of a small thumbnail, so pictures stay sharp at any zoom level. Turn this off to save memory on very large boards — thumbnails are then used whenever a picture is drawn smaller than one.',
  'settings.cardFont.name': 'Card font',
  'settings.cardFont.desc': 'A CSS font-family for card text. Leave empty to follow the theme.',
  'settings.cardFont.placeholder': 'Follow the theme',

  // ── Sprint 10：画布默认背景（T3.25 / F11-04）────────────────────
  'settings.canvas.name': 'New board canvas',
  'settings.canvas.background.name': 'Default background',
  'settings.canvas.background.desc': 'Background used by boards created from now on.',
  'settings.canvas.background.plain': 'Plain',
  'settings.canvas.background.dots': 'Dots',
  'settings.canvas.background.grid': 'Grid',
  'settings.canvas.background.none': 'None',

  // ── 期 5：缩略图导航器（T5.09 / F1-06）─────────────────────────
  'settings.section.minimap': 'Minimap navigator',
  'settings.minimap.name': 'Show the minimap navigator',
  'settings.minimap.desc':
    'A small overview in the bottom-right corner of the canvas. Click or drag it to jump to that part of the board; press Enter on it to return to the centre of the content.',

  // ── Sprint 10：底部工具条（T3.21 / T3.27）──────────────────────
  'toolbar.ariaLabel': 'Board tools',
  'toolbar.moreCards': 'More cards',
  'toolbar.select': 'Select tool',
  'toolbar.ink': 'Draw',
  'toolbar.note': 'New note',
  'toolbar.todo': 'New todo list',
  'toolbar.swatch': 'New palette',
  'toolbar.link': 'New link card',
  'toolbar.image': 'New image card',
  'toolbar.file': 'New file card',
  'toolbar.column': 'New column',
  'toolbar.board': 'New board card',
  'toolbar.map': 'New map card',
  'toolbar.syncNote': 'New synced note',
  'toolbar.comment': 'New comment card',
  'toolbar.zoomOut': 'Zoom out',
  'toolbar.zoomReset': 'Zoom to 100%',
  'toolbar.zoomIn': 'Zoom in',
  'toolbar.zoomFit': 'Fit to content',
  'toolbar.gridSnap': 'Grid snapping',
  'toolbar.gridSnapOn': 'Grid snapping: on',
  'toolbar.gridSnapOff': 'Grid snapping: off',
  'toolbar.createHint': 'Drag onto the canvas to create a card',
  'notice.emptyBoardHint': 'This board is empty — use the toolbar to add a card or a mind map.',
  'notice.mobileToolbarHint':
    'Tip: drag a tool from the bottom bar onto the canvas to create a card; long-press a card for its menu.',

  // 画布右键菜单补齐（T3.27：与工具条 / 命令面板同一批动作）
  'menu.canvas.newSwatch': 'New palette',
  'menu.canvas.newLink': 'New link card',
  'menu.canvas.newColumn': 'New column',
  'menu.canvas.draw': 'Draw',

  // ── Sprint 10：无障碍（T3.26）───────────────────────────────────
  'a11y.canvas.hint': 'Press Tab to focus cards, arrow keys to move the selection.',
  'a11y.board.label': 'Board with {count} card(s)',
  'a11y.card.label': '{type}: {title}',
  'a11y.card.untitled': 'Untitled {type}',
  'a11y.card.locked': 'Locked',
  'a11y.card.selected': 'Selected',
  'a11y.card.withState': '{label} ({state})',
  'a11y.card.stateSeparator': ', ',
  'a11y.card.hint': 'Press Enter to edit, Tab to move to the next card.',

  // ── Sprint 10：文件名兜底（T3.23）───────────────────────────────
  'fileName.untitled': 'Untitled',
  'error.canvasContext': 'Could not get the 2D canvas context.',

  // ── Sprint 10：工具条用到的选择器 / 输入框（T3.21）──────────────
  'modal.pickFile.placeholder': 'Pick a file from the vault…',
  'settings.section.snapshot': 'Version snapshots',
  'settings.snapshot.enabled.name': 'Enable version snapshots',
  'settings.snapshot.enabled.desc':
    'Keep a copy of the board file every five minutes of editing (up to 50 copies / 20 MB per board). Restore one from “Snapshot history”.',
  'settings.snapshot.location.name': 'Snapshot location',
  'settings.snapshot.location.desc':
    'Where the copies live. The plugin folder stays out of your vault and out of search; .nestboard-history is carried along by Obsidian Sync / Git.',
  'settings.snapshot.location.plugin': 'Plugin folder (.obsidian)',
  'settings.snapshot.location.vault': 'In vault (.nestboard-history)',

  'modal.link.title': 'New link card',
  'modal.link.name': 'Link address',
  'modal.link.desc': 'The URL this card points at. You can change it later in the card menu.',
  'modal.link.confirm': 'Add card',
  // 地图链接（O08）：读不到剪贴板、或者粘进来的不是地图链接时，退回到这个输入框
  'modal.mapLink.title': 'Paste map link',
  'modal.mapLink.name': 'Map link or coordinates',
  'modal.mapLink.desc':
    'Paste the address-bar URL from Google Maps, Apple Maps, Amap or OpenStreetMap — or just type the coordinates (39.9042, 116.4074). Short links have to be opened in a browser first.',
  'modal.mapLink.confirm': 'Use this link',

  // 期 4：版本快照（T4.01 / T4.02 / F11-11）
  'command.createSnapshot.name': 'Create snapshot',
  'command.snapshotHistory.name': 'Snapshot history',
  'notice.snapshotCreated': 'Snapshot created ({cards} cards)',
  'notice.snapshotCreateFailed': 'Failed to create snapshot: {error}',
  'notice.snapshotEmpty': 'No snapshots for this board yet',
  'notice.snapshotDisabled': 'Snapshots are turned off in settings',
  'notice.snapshotRestored': 'Restored to version of {time}',
  'notice.snapshotRestoreFailed': 'Failed to restore snapshot: {error}',
  'modal.snapshot.title': 'Snapshot history · {board}',
  'modal.snapshot.empty':
    'No snapshots yet. One is saved automatically five minutes after a change, or right away via “Create snapshot”.',
  'modal.snapshot.column.time': 'Time',
  'modal.snapshot.column.cards': 'Cards',
  'modal.snapshot.column.diff': 'Change',
  'modal.snapshot.diffSame': 'same as current',
  'modal.snapshot.diffMore': '{count} more than current',
  'modal.snapshot.diffLess': '{count} fewer than current',
  'modal.snapshot.preview': 'Preview',
  'modal.snapshot.previewEmpty': 'This snapshot has no cards',
  'modal.snapshot.previewMore': '…and {count} more',
  'modal.snapshot.previewFailed': 'Could not read this snapshot: {error}',
  'modal.snapshot.restore': 'Restore',
  'modal.snapshot.confirmTitle': 'Restore this snapshot?',
  'modal.snapshot.confirmBody':
    'The current version is snapshotted first, then replaced by the one from {time} ({cards} cards).',
  'modal.snapshot.confirmOk': 'Restore',
  'modal.snapshot.cancel': 'Cancel',

  // 期 4：危险操作与同步冲突（T4.03 / T4.04，03 §3.4 §3.6）
  'command.deleteBoard.name': 'Delete board',
  'command.viewConflicts.name': 'Review sync conflicts',
  'menu.file.deleteBoard': 'Delete board…',
  'menu.file.viewConflict': 'Compare sync conflict…',
  'notice.trashMissing': 'Nothing to delete — file not found: {path}',
  'notice.boardTrashed': 'Board moved to the trash: {path} (a snapshot was saved first)',
  'notice.conflictCopyTrashed': 'Conflict copy moved to the trash: {path}',
  'notice.conflictCopies': 'Found {count} sync conflict copy(ies). Use “Review sync conflicts”.',
  'notice.conflictCopiesNone': 'No sync conflict copies found',
  'notice.conflictCopyAppeared': 'Sync conflict copy appeared: {path}',
  'modal.confirm.cancel': 'Cancel',
  'modal.confirmDeleteBoard.title': 'Delete this board?',
  'modal.confirmDeleteBoard.body':
    '“{path}” goes to the trash — not permanently deleted. A snapshot is saved first, so you can bring it back from “Snapshot history”.',
  'modal.confirmDeleteBoard.ok': 'Move to trash',
  'modal.confirmDeleteCopy.title': 'Delete this conflict copy?',
  'modal.confirmDeleteCopy.body':
    '“{path}” goes to the trash. A snapshot is saved first. The original board is not touched.',
  'modal.confirmDeleteCopy.ok': 'Move to trash',
  'modal.syncConflict.title': 'Sync conflict · {board}',
  'modal.syncConflict.desc':
    'Read-only side-by-side comparison. Nothing is merged and no file is written — you decide what to do with it.',
  'modal.syncConflict.copySelect': 'Conflict copy',
  'modal.syncConflict.left': 'Current version',
  'modal.syncConflict.right': 'Conflict copy',
  'modal.syncConflict.leftMissing':
    'Could not read the original board — it may have been renamed or deleted.',
  'modal.syncConflict.rightMissing': 'This copy could not be read as a board.',
  'modal.syncConflict.summary': '{cards} cards · {columns} columns · {edges} links',
  'modal.syncConflict.revision': 'revision {revision}',
  'modal.syncConflict.counts': '{added} only in copy · {removed} only here · {changed} differ',
  'modal.syncConflict.noDiff': 'Both versions have exactly the same cards.',
  'modal.syncConflict.onlyDiff': 'Differences only',
  'modal.syncConflict.statusSame': 'same',
  'modal.syncConflict.statusLeftOnly': 'only here',
  'modal.syncConflict.statusRightOnly': 'only in copy',
  'modal.syncConflict.statusChanged': 'differs',
  'modal.syncConflict.more': '…and {count} more rows',
  'modal.syncConflict.empty': 'Neither version has any cards.',
  'modal.syncConflict.open': 'Open copy',
  'modal.syncConflict.remove': 'Delete copy…',

  // 期 4：归档只读（T4.06，03 §2.5 的 settings.readOnly）
  'command.lockBoard.name': 'Lock board (read-only)',
  'command.unlockBoard.name': 'Unlock board (make editable)',
  'menu.canvas.lock': 'Lock board (read-only)',
  'menu.canvas.unlock': 'Unlock board',
  'board.lockHint': 'This board is locked to read-only — changes are not written.',
  'board.lockHint.unlock': 'Unlock',
  'board.lockHint.unlockAria': 'Unlock this board so it can be edited again',
  'notice.boardLocked': 'Board locked to read-only. Its file is left alone until you unlock it.',
  'notice.boardUnlocked': 'Board unlocked — editing works again.',

  // 期 4：整理未使用附件（T4.05 / 03 §4）
  'command.auditAttachments.name': 'Tidy unused attachments',
  'modal.attachmentAudit.title': 'Attachments nothing refers to',
  'modal.attachmentAudit.desc':
    'This is a checklist, not a cleanup button. The plugin never deletes attachments for you — a file can still be referenced in ways it cannot see (markdown images in notes, other plugins, plain text). Open a file to decide for yourself.',
  'modal.attachmentAudit.scope': 'Scanned folder: {folder}',
  'modal.attachmentAudit.scopeRoot': 'the whole vault',
  'modal.attachmentAudit.summary':
    '{total} files scanned — {board} used by this board, {elsewhere} used elsewhere, {unused} referenced by nothing.',
  'modal.attachmentAudit.none': 'Nothing to tidy: every file in this folder is still referenced.',
  'modal.attachmentAudit.usedElsewhere':
    '{count} file(s) this board no longer uses are still referenced elsewhere — left out of the list.',
  'modal.attachmentAudit.open': 'Open',
  'modal.attachmentAudit.close': 'Close',
  'notice.attachmentAuditEmptyFolder': 'No files in the attachment folder ({folder}).',
  'notice.attachmentAuditBoardUnavailable':
    'Could not read this board, so the check was cancelled — reporting attachments as unused would be unsafe.',
  'notice.attachmentAuditFailed': 'Could not tidy attachments: {message}',

  // 期 4：修复引用（T4.07 / 03 §9 R10）
  'command.repairRefs.name': 'Repair references',
  'history.repairRefs': 'Repair references',
  'modal.repairRefs.title': 'References to repair',
  'modal.repairRefs.desc':
    'These cards point at paths that no longer exist, and a file with a matching name was found elsewhere. Only entries checked below will be changed — same-name matches are checked for you, the rest are guesses. One undo step reverts the whole repair.',
  'modal.repairRefs.summary':
    '{found} reference(s) can be repaired; {unmatched} could not be matched.',
  'modal.repairRefs.untitledCard': 'Untitled card',
  'modal.repairRefs.quality.sameName': 'Same name',
  'modal.repairRefs.quality.sameNameIgnoreCase': 'Same name (case only)',
  'modal.repairRefs.quality.normalizedName': 'Same name (spacing)',
  'modal.repairRefs.quality.similarName': 'Similar name',
  'modal.repairRefs.alternatives': '{count} other file(s) share this name',
  'modal.repairRefs.unmatched':
    '{count} broken reference(s) matched nothing — pick a target by hand from the card menu ("Relink").',
  'modal.repairRefs.hint':
    'Check the paths before confirming — the plugin cannot tell whether a match is the file you meant.',
  'modal.repairRefs.confirm': 'Repair {count}',
  'modal.repairRefs.cancel': 'Cancel',
  'notice.repairRefsNone': 'This board has no broken references to repair.',
  'notice.repairRefsUnmatched':
    '{count} broken reference(s) found, but nothing in the vault matches by file name.',
  'notice.repairRefsDone': 'Repaired {count} reference(s).',
  'notice.repairRefsStale':
    'Nothing was changed — those references had already moved on (edited, relinked, or the board was locked).',
  'notice.repairRefsFailed': 'Could not repair references: {message}',

  // 期 4：`.canvas` 互转（T4.11 / T4.12 / T4.13 / 03 §7.4）
  'canvas.node.placeholder': '{type} card — nothing to put in a canvas',
  'command.exportCanvas.name': 'Export board as Canvas file',
  'command.importCanvas.name': 'Import Canvas file as board',

  // 演示模式（J-06 / J-07）
  'command.startPresentation.name': 'Start presenting',
  'command.endPresentation.name': 'Exit presentation',
  'command.presentNext.name': 'Presentation: next step',
  'command.presentPrevious.name': 'Presentation: previous step',
  'command.addToPresentation.name': 'Add selection to presentation',
  'command.removeFromPresentation.name': 'Remove selection from presentation',
  'command.clearPresentation.name': 'Clear the presentation path',
  // 期 6：自动整理 / 按标签自动分栏（T6.07 / T6.08 / F5-06 / F5-07）
  'command.tidyBoard.name': 'Tidy up board',
  'command.groupByTag.name': 'Group cards by tag',
  'notice.tidyBoardDone': 'Board tidied up.',
  'notice.tidyBoardNoChange': 'Already tidy — nothing to rearrange.',
  'notice.groupByTagDone': 'Grouped by tag: {created} new column(s), {reused} reused.',
  'notice.groupByTagNone': 'No tag appears on two or more loose cards.',
  'menu.file.importCanvas': 'Import as board',
  'modal.exportCanvas.title': 'Export as Canvas',
  'modal.exportCanvas.desc':
    'Saves a copy of this board as a JSON Canvas (.canvas) file. The board itself is untouched; cards keep their position, colour and links.',
  'modal.exportCanvas.stats': '{cards} card(s), {columns} column(s), {edges} edge(s)',
  'modal.exportCanvas.lossless':
    'Everything on this board has a Canvas counterpart — nothing will be lost.',
  'modal.exportCanvas.lossyTitle': 'These cannot come along:',
  'modal.exportCanvas.degraded': '{count} × {type} → becomes a text node',
  'modal.exportCanvas.placeholders':
    '{count} card(s) hold no exportable text and become a placeholder box',
  'modal.exportCanvas.droppedEdges':
    '{count} edge(s) have a loose end, which Canvas cannot express',
  'modal.exportCanvas.collapsedColumns':
    '{count} collapsed column(s) will show up expanded on the other side',
  'modal.exportCanvas.cosmetic':
    '{count} purely visual touch(es) — accent stripes, dashed or auto-routed edges — have no Canvas equivalent',
  'modal.exportCanvas.target':
    'Saved next to the board. An existing file is never overwritten — a number is appended instead.',
  'modal.exportCanvas.confirm': 'Export',
  'modal.exportCanvas.cancel': 'Cancel',
  'notice.exportCanvasDone': 'Canvas exported: {path}',
  'notice.exportCanvasFailed': 'Could not export the canvas: {message}',
  'notice.importCanvasNoFiles': 'This vault has no .canvas file to import.',
  'notice.importCanvasDone':
    'Board created from Canvas: {cards} card(s), {columns} column(s), {edges} edge(s).',
  'notice.importCanvasPartial':
    'Board created from Canvas: {cards} card(s), {columns} column(s), {edges} edge(s). Skipped {nodes} unrecognised node(s) and {edges2} edge(s) missing an end.',
  'notice.importCanvasEmpty': 'Nothing in that Canvas could be imported.',
  'notice.importCanvasBadJson': '{name} is not valid JSON.',
  'notice.importCanvasBadShape': '{name} is not a Canvas file (no "nodes" array).',
  'notice.importCanvasFailed': 'Could not import that Canvas: {message}',

  // 期 7：索引笔记（T7.01 / `F10-09` + `F7-09`）
  //   ★ 开关说明要把"代价"写在前面：这一项与其它开关不同 —— 打开它会在库里多出文件，
  //     而用户是在**看不见这个后果**的时候做决定的，不说清就等于骗他
  'settings.section.indexNote': 'Index notes',
  'settings.indexNote.name': 'Maintain an index note per board',
  'settings.indexNote.desc':
    'Off by default. When on, each board gets a small Markdown file — plus one "tag hub" note per tag (in a _tags folder inside the index folder). They hold the board’s metadata and the links and #tags written inside its note cards, so all of it shows up in the graph, the tag pane, global search (tag:#tag) and Dataview. ★ With this off, tags written on a board stay invisible to Obsidian — it never reads .nboard files. Those files are generated: editing one by hand has no effect.',
  'settings.indexNote.folder.name': 'Index note folder',
  'settings.indexNote.folder.desc':
    'Where the generated notes go. Your vault structure is mirrored inside it, so two boards with the same name never collide.',
  'indexNote.warning':
    'Generated by Nestboard for the board "{path}". Anything written here is overwritten the next time that board is saved.',
  'indexNote.summary': 'This board holds {cards} card(s), last saved {updated}.',
  'indexNote.summaryNoDate': 'This board holds {cards} card(s).',
  'indexNote.summaryNoCards': 'This board was last saved {updated}.',
  'indexNote.openBoard': 'Open this board',
  'tagHub.warning': 'Generated by Nestboard — anything you write here will be overwritten.',
  'tagHub.section.boards': 'Boards using this tag',
  'tagHub.empty': 'No board uses this tag yet.',
  'indexNote.section.links': 'Links written inside notes',
  'indexNote.section.unresolved': 'Links that matched no file',
  'indexNote.unresolvedHint':
    'Listed as plain text on purpose — writing them as links would drop notes that do not exist into your graph.',
  'indexNote.noLinks': 'No links written inside the notes on this board yet.',
  'command.rebuildIndexNotes.name': 'Rebuild index notes',
  'command.cleanupIndexNotes.name': 'Delete index notes',
  'notice.indexNoteConflict':
    'Skipped {path}: a file with that name already exists and was not made by Nestboard, so it was left alone.',
  'notice.indexNoteConflictCount':
    'Skipped {count} index note(s) — a file with that name already existed.',
  'notice.indexNoteRebuilt': 'Index notes rebuilt for {count} board(s).',
  'notice.indexNoteCleaned': 'Deleted {count} index note(s).',
  'notice.indexNoteCleanupNone': 'Nothing to clean up — no index notes found.',
  'notice.indexNoteDisabled': 'Index notes are off — turn them on in Settings first.',
  'modal.indexNoteCleanup.title': 'Delete index notes?',
  'modal.indexNoteCleanup.body':
    'Deletes the {count} generated index note(s) under "{folder}". Your boards are untouched, and the files go to the trash. Turning the setting on again rebuilds them.',
  'modal.indexNoteCleanup.confirm': 'Delete',
  'backlinks.indexNoteHint':
    'Links written inside note cards are not counted in the graph or in backlink counts.',
  'backlinks.indexNoteEnable': 'Maintain an index note',
} as const;

export type MessageKey = keyof typeof en;

const zhCn: Record<MessageKey, string> = {
  'board.untitled': '未命名白板',

  'command.createBoard.name': '新建白板',

  'notice.boardCreated': '已创建白板：{path}',
  'notice.boardCreateFailed': '创建白板失败：{error}',
  'notice.saveFailed': '保存白板 {path} 失败：{error}',
  'notice.boardProtected': '白板 {path} 无法解析，已进入只读保护态（未覆盖原文件）。',
  'notice.boardReloaded': '白板 {path} 已被外部修改，已重新载入。',
  'notice.conflict': '{path} 在磁盘上已被修改，请选择处理方式。',
  'notice.copySaved': '副本已保存到：{path}',
  'notice.futureVersion': '白板 {path} 由更高版本的 Nestboard 写入，已按只读方式打开。',

  'modal.conflict.title': '文件已被外部修改',
  'modal.conflict.desc':
    '磁盘上的 {path} 与内存中的版本不一致。为避免数据丢失，目前尚未写入任何内容。',
  'modal.conflict.useDisk': '用磁盘版本',
  'modal.conflict.keepMine': '保留我的修改',
  'modal.conflict.saveAsCopy': '另存为副本',
  'modal.conflict.cancel': '取消',
  'modal.conflict.diskUnreadable': '磁盘上的文件无法解析，「用磁盘版本」不可用。',

  'command.zoomIn.name': '放大',
  'command.zoomOut.name': '缩小',
  'command.zoomReset.name': '缩放回 100%',
  'command.zoomFit.name': '适应全部内容',
  'command.openBacklinks.name': '打开跨白板反链',
  'command.openHome.name': '打开 Home 白板',
  'command.addToUnsorted.name': '把当前文件放进收件箱',

  'command.openBoardList.name': '打开白板列表',
  'boardList.title': '白板列表',
  'boardList.modes.ariaLabel': '白板的分组方式',
  'boardList.mode.folders': '目录',
  'boardList.mode.recent': '最近',
  'boardList.mode.tags': '标签',
  'boardList.filter.placeholder': '筛选白板…',
  'boardList.empty.none': '库里还没有白板。用「新建白板」建一块。',
  'boardList.empty.noMatch': '没有匹配「{query}」的白板。',
  'boardList.empty.noRecent': '还没有打开过白板。',
  'boardList.tagHit.untitled': '（无标题卡片）',
  'boardList.tagHit.ariaLabel': '跳到 {board} 上的那张卡',
  'boardList.untagged': '未加标签',
  'boardList.open.ariaLabel': '打开白板 {path}',

  // 跨白板搜索侧栏（T7.02 / F8-08）
  'command.openBoardSearch.name': '搜索全部白板',
  'boardSearch.title': '跨白板搜索',
  'boardSearch.placeholder': '在所有白板中搜索…',
  'boardSearch.hint': '输入关键词，搜索全部白板',
  'boardSearch.scanning': '正在索引白板…（已索引 {scanned} 块）',
  'boardSearch.empty': '没有任何白板匹配（已索引 {indexed} 块）',
  'boardSearch.count': '{hits} 条结果 · {boards} 块白板',
  'boardSearch.countScanning': '{hits} 条结果 · {boards} 块白板（仍在索引…）',
  'boardSearch.boards.heading': '名为「{query}」的白板',
  'boardSearch.open.ariaLabel': '前往 {path}',

  // 缩略图导航器（T5.09 / F1-06）
  'command.toggleMinimap.name': '切换缩略图导航器',
  'minimap.title': '缩略图',
  'minimap.hide': '隐藏缩略图',
  'minimap.surface': '缩略图导航：点击或拖动以移动视图',

  'command.selectAll.name': '全选卡片',
  'command.bringToFront.name': '选中项置顶',
  'command.sendToBack.name': '选中项置底',

  'view.board.name': '白板',

  // ── 脑图（`.nestmind`，`06`）────────────────────────────────
  'mind.untitled': '未命名脑图',
  // 新建脑图时**节点上**的默认文字（用户 2026-09-22）：中心主题 + 分支主题 1..N。
  // ★ 与 `mind.untitled` 分工不同：那个是**文件名**（`meta.title`），这个写在节点上。
  'mind.default.root': '中心主题',
  'mind.default.branch': '分支主题 {index}',
  'view.mind.name': '脑图',
  'command.newMind.name': '新建脑图',
  'notice.mindCreated': '已创建脑图：{path}',
  'notice.mindCreateFailed': '创建脑图失败：{error}',
  'mind.loadFailed': '这份脑图无法解析（未改动原文件）。',
  'command.mindFit.name': '适应脑图内容',
  'mind.nodeTitle.label': '节点标题',
  'mind.nodeTitle.empty': '（无标题）',
  'mind.imageHint': '双击打开',
  'mind.refMissing': '附件不在了：{path}（可能被改名、移动或删除）',
  'mind.controls.zoomIn': '放大',
  'mind.controls.zoomOut': '缩小',
  'mind.controls.zoomReset': '回到 100%',
  'mind.controls.fit': '适应内容',
  'mind.controls.structure': '结构',
  'mind.controls.edge': '分支线',
  'mind.handle.collapse': '收起子节点',
  'mind.handle.expand': '展开这一支（{count} 个节点）',
  'history.mindAddChild': '添加子节点',
  'history.mindAddSibling': '添加兄弟节点',
  'history.mindPromote': '提升一级',
  'history.mindDelete': '删除节点',
  'history.mindEditTitle': '编辑节点标题',
  'history.mindNote': '编辑节点内容',
  'history.mindAttach': '挂上附件',
  'history.mindDetach': '摘掉附件',
  'history.mindImageResize': '调整图片大小',
  'history.mindDuplicate': '原地复制',
  'history.mindMark': '设置节点标记',
  'history.mindLink': '添加关联线',
  'history.mindLinkLabel': '改关联线标签',
  'history.mindLinkArrow': '改关联线箭头',
  'history.mindLinkRemove': '删除关联线',
  'history.mindLinkBend': '弯折关联线',
  'history.mindLinkColor': '改线条颜色',
  'menu.mindLink.editLabel': '编辑标签',
  'menu.mindLink.straighten': '把线拉直',
  'menu.mindLink.colorDefault': '默认颜色',
  'mind.linkHandle.label': '拖动可调节这条线的弯折',
  'menu.mindLink.arrow': '箭头',
  'menu.mindLink.arrow.none': '无',
  'menu.mindLink.arrow.end': '单向',
  'menu.mindLink.arrow.both': '双向',
  'menu.mindLink.dashed': '虚线',
  'menu.mindLink.solid': '实线',
  'menu.mindLink.remove': '删除关联线',
  // ── 卡片属性面板（`B1`，用户 2026-09-18）────────────────────
  'inspector.title': '卡片属性',
  'inspector.empty': '在白板上选中一张卡片，这里会列出它的全部属性。',
  'inspector.type': '类型',
  'inspector.content': '内容',
  'inspector.contentColors': '{count} 格色',
  'inspector.contentItems': '{count} 项',
  'inspector.contentImages': '{count} 张图',
  'inspector.contentStrokes': '{count} 笔',
  'inspector.contentComments': '{count} 条备注',
  'inspector.cardId': '卡片 ID',
  'inspector.placement': '所属位置',
  'inspector.onCanvas': '画布上',
  'inspector.name': '卡片名（标题）',
  'inspector.color': '颜色',
  'inspector.showTitle': '显示标题栏',
  'inspector.showBorder': '显示边框与底色',
  'inspector.locked': '锁定',
  'inspector.x': 'X 坐标',
  'inspector.y': 'Y 坐标',
  'inspector.width': '宽',
  'inspector.height': '高',
  'inspector.rotation': '旋转（度）',
  'inspector.z': '层级（z）',
  'command.openCardInspector.name': '打开卡片属性',
  'menu.card.inspector': '属性…',
  'menu.mindFocusIn': '进入当前主题',
  'menu.mindFocusOut': '返回上一级',
  'menu.mindDone': '标记为完成',
  'menu.mindUndone': '取消完成',
  'history.mindDone': '切换完成',
  'mind.outline.crumbs': '层级导航',
  'mind.outline.allTree': '整棵树',
  'menu.mindRemoveKeepChildren': '删这一行（留下子节点）',
  'menu.mindCollapseAll': '折叠所有节点',
  'menu.mindExpandAll': '展开所有节点',
  'menu.mindCenterRoot': '定位到中心节点',
  'history.mindCollapseAll': '折叠所有节点',
  'history.mindExpandAll': '展开所有节点',
  'mind.linkLabel.label': '关联线标签',
  'mind.outline.toOutline': '大纲视图',
  'mind.outline.toTree': '树视图',
  'mind.outline.branchSize': '这一支共 {count} 个节点',
  'mind.outline.noteLabel': '节点正文',
  'mind.outline.untitled': '（无标题）',
  'mind.outline.rowMenu': '这一行的操作',
  'command.mindToggleOutline.name': '切换大纲视图',
  'history.mindLinkSolid': '改关联线线型',
  'history.mindFormat': '调整标题格式',
  'history.mindColor': '换标题底色',
  'history.mindInk': '换标题字色',
  'history.mindHighlight': '换文字高亮',
  'notice.mindAttached': '已挂上「{name}」',
  'notice.mindReplaced': '已把附件换成「{name}」',
  'notice.mindAttachOne': '一个节点只能挂一个附件，只取第一个',
  'notice.mindRefMissing': '引用的文件不在了：{path}',
  'notice.mindHiddenNode': '那个节点在一个折叠起来的子树里 —— 展开它才看得见',
  'menu.mindCut': '剪切',
  'menu.mindCopy': '拷贝',
  'menu.mindDuplicate': '原地复制',
  'menu.mindPaste': '粘贴为子节点',
  'menu.mindEditNote': '编辑内容',
  'menu.mindDelete': '删除',
  'menu.mindCollapse': '折叠',
  'menu.mindExpand': '展开',
  'menu.mindAddChild': '加子节点',
  'menu.mindAddSibling': '加兄弟节点',
  'menu.mindDeleteAll': '删除整棵脑图',
  'menu.mindOpenAttachment': '打开附件',
  'menu.mindRemoveAttachment': '删除附件',
  'mind.toolbar.mark': '标记',
  'mind.toolbar.bold': '加粗',
  'mind.toolbar.italic': '斜体',
  'mind.toolbar.underline': '下划线',
  'mind.toolbar.ink': '标题字色',
  'mind.toolbar.color': '标题底色',
  'mind.toolbar.editNote': '编辑内容',
  'mind.toolbar.insertImage': '插入图片',
  'mind.toolbar.link': '连线',
  'mind.toolbar.clearMark': '清除标记',
  'mind.toolbar.highlight': '文字高亮',
  'mind.toolbar.clearHighlight': '无高亮',
  'mind.toolbar.clearInk': '默认字色',
  'mind.toolbar.clearColor': '默认底色',
  'mind.emojiGroup.symbols': '其他符号',
  'mind.emojiGroup.geometry': '几何',
  'mind.emojiGroup.office': '办公',
  'mind.emojiGroup.status': '状态 / 待办',
  'mind.emojiGroup.docs': '资料 / 文档',
  'mind.emojiGroup.ideas': '灵感 / 研究',
  'mind.emojiGroup.time': '时间 / 计划',
  'mind.emojiGroup.people': '人 / 协作',
  'mind.emojiGroup.nature': '心情 / 自然',
  'mind.emojiGroup.tools': '工具 / 其它',
  'history.mindToggleCollapse': '折叠 / 展开',
  'history.mindMove': '移动节点',
  'history.mindSplit': '拆行',
  'history.mindPaste': '粘贴子树',
  'history.mindExpandHover': '展开折叠的节点',
  'notice.mindCopied': '已复制「{text}」及其子节点',
  'notice.mindCopiedMany': '已复制 {count} 支',
  'notice.mindSelected': '已选中 {count} 个节点（⇧+点击可增减）',
  'notice.mindDeleted': '已删除 {count} 个节点（⌘Z 可撤销）',
  'notice.mindPasteEmpty': '剪贴板是空的 —— 先选中一支按 ⌘C 复制',
  'notice.mindPasteNeedsNode': '节点只能粘到脑图节点上 —— 把指针移到目标节点上再粘',
  'notice.mindNodeCopyUnsupported': '文件脑图里的节点暂不支持复制 —— 打开那份 .nestmind 再复制',
  'notice.mindNodeCopySkipped': '有 {count} 个文件脑图里的节点没能复制（暂不支持）',
  'notice.mindConflictOnClose':
    '「{path}」有改动没能落盘（磁盘上的版本更新过，冲突还没处理）—— 现在关掉就没了。',
  'command.mindUndo.name': '撤销（脑图）',
  'command.mindRedo.name': '重做（脑图）',
  'command.mindAddChild.name': '脑图：添加子节点',
  'command.mindAddSibling.name': '脑图：添加兄弟节点',
  'command.mindDelete.name': '脑图：删除节点',
  'command.mindEditTitle.name': '脑图：编辑节点标题',
  'command.mindToggleCollapse.name': '脑图：折叠 / 展开节点',
  'command.mindExportMarkdown.name': '脑图：导出为 Markdown',
  'command.mindExportOutline.name': '脑图：导出为大纲式 Markdown',
  'command.mindExportXmind.name': '脑图：导出为 XMind（.xmind）',
  'command.mindExportSvg.name': '脑图：导出为 SVG',
  'command.mindExportPng.name': '脑图：导出为 PNG',
  'command.mindExportFreeMind.name': '脑图：导出为 FreeMind（.mm）',
  'notice.mindExported': '已导出到 {path}',
  'notice.mindExportFailed': '导出失败：{error}',
  'command.mindCopy.name': '脑图：复制该支',
  'command.mindCut.name': '脑图：剪切该支',
  'command.mindPaste.name': '脑图：粘贴子树',
  'command.mindSelectAll.name': '脑图：全选节点',
  'view.canvas.ariaLabel': '白板画布',

  'view.unavailable.title': '无法打开这块白板',
  'view.unavailable.desc': '文件未被修改。可以打开「{path}」以纯文本方式查看或修复。',

  'card.type.note': '便签',
  'card.type.noteRef': '引用卡',
  'card.type.image': '图片',
  'card.type.file': '文件',
  'card.type.link': '链接',
  'card.type.todo': '待办',
  'card.type.swatch': '色板',
  'card.type.boardRef': '白板',
  'card.type.ink': '手绘',
  'card.type.map': '地图',
  'card.type.syncNote': '同步便签',
  'card.type.comment': '评论',
  // PDF 预览卡（`F8`）
  'card.type.pdf': 'PDF',
  'card.pdf.empty': '把 PDF 拖进来',
  'card.pdf.page': '第 {page} 页',
  'card.pdf.prev': '上一页',
  'card.pdf.next': '下一页',
  // `.canvas` 预览卡（`F6`）
  'card.type.canvas': 'Canvas',
  'card.canvas.empty': '把 .canvas 拖进来',
  'card.canvas.missing': '找不到这个文件',
  'card.canvas.broken': '这不是一份有效的 .canvas',
  // 脑图卡（`F3a`）
  'card.type.mindRef': '脑图',
  'card.mindRef.empty': '把 .nestmind 拖进来',
  'card.mindRef.missing': '找不到这份脑图文件',
  'card.mindRef.broken': '这份脑图读不出来',
  'card.mindRef.more': '还有 {count} 个节点',
  'menu.card.openMind': '打开脑图',
  // 内嵌脑图卡（`F4`）
  'card.type.mind': '脑图卡',
  'card.mind.more': '还有 {count} 个节点',
  'toolbar.mind': '新建脑图卡',
  'menu.mindExportFile': '导出为 .nestmind',
  'card.syncNote.badge': '同步',
  // 评论卡（T7.05 / F2.9）：本地备注线程
  'card.comment.empty': '还没有备注',
  'card.comment.add': '写一条备注',
  'card.comment.placeholder': '写一条备注…',
  'card.comment.remove': '删除这条备注',
  'card.comment.unknownTime': '时间未知',
  'card.comment.resolved': '已解决',
  // 卡片旋转（T7.06 / F2-00-10）：手柄的悬停提示与无障碍名
  'card.rotateHandle': '拖动旋转（按住 ⇧ 吸附 15°）',

  'search.title': '在这块白板里搜索',
  'search.placeholder': '搜索便签正文、标题与文件名',
  'search.hint': '输入关键词开始搜索',
  'search.empty': '这块白板上没有匹配的卡片',
  'search.count': '{count} 条结果',
  'search.field.title': '标题',
  'search.field.text': '正文',
  'search.field.path': '路径',
  'search.field.url': '链接',

  'card.note.empty': '空白便签 —— 双击开始写',
  'card.note.placeholder': '写点什么…',

  'card.todo.empty': '空清单 —— 双击添加待办',
  'card.todo.item': '待办项',
  'card.todo.completed': '已完成 {count} 项',

  // 色板卡（T3.04 / F2.6 / O19）：一张卡就是一块颜色
  'card.swatch.empty': '空色板 — 粘贴 HEX 或双击编辑',
  'card.swatch.placeholder': '#4C8DFF',
  'card.swatch.hint': '一行一个 HEX（第一行铺满卡面）· ⌘↵ 保存 · Esc 取消',
  'card.swatch.invalid': '认不出的行：{line}',
  'card.swatch.copy': '复制 {color}',
  'card.swatch.copied': '已复制',
  'card.swatch.copyFailed': '复制失败',
  'card.swatch.more': '另有 {count} 格',

  // 手绘（T3.06 / F4-01）
  'notice.inkBrush': '画笔：按住拖动即可画线，Esc 退出',
  'notice.inkEraser': '橡皮：划过笔画即整笔删除，Esc 退出',
  'notice.inkReadOnly': '这块白板是只读的，不能手绘',
  'notice.inkCleared': '已清空手绘',
  // 期 7 的两支笔与临时层（T7.08 / F4-07、T7.07 / F4-06）
  'notice.inkMarker': '荧光笔：按住拖动即可高亮，Esc 退出',
  'notice.inkAnnotate': '临时标注：笔迹不落盘，Esc 清空并退出',
  'notice.inkAnnotationsCleared': '已清空临时标注',

  // 网格吸附（T3.11 / F5-02）
  'notice.gridSnapOn': '已开启网格吸附（{size}px）',
  'notice.gridSnapOff': '已关闭网格吸附',

  // ── Sprint 9：对齐 / 等距分布 / 编组 / 分栏对齐（T3.13–T3.15）───────
  'command.alignLeft.name': '左对齐',
  'command.alignRight.name': '右对齐',
  'command.alignTop.name': '顶部对齐',
  'command.alignBottom.name': '底部对齐',
  'command.alignCenterX.name': '水平居中（同一 x 中心）',
  'command.alignCenterY.name': '垂直居中（同一 y 中心）',
  'command.distributeX.name': '水平等距分布',
  'command.distributeY.name': '垂直等距分布',
  'command.groupCards.name': '编组',
  'command.ungroupCards.name': '取消编组',
  'command.alignColumns.name': '同级分栏对齐（顶部 + 等宽）',
  'menu.card.arrange': '排列与编组',
  'menu.card.align': '对齐',
  'menu.card.alignLeft': '左对齐',
  'menu.card.alignRight': '右对齐',
  'menu.card.alignTop': '顶部对齐',
  'menu.card.alignBottom': '底部对齐',
  'menu.card.alignCenterX': '水平居中（同一 x 中心）',
  'menu.card.alignCenterY': '垂直居中（同一 y 中心）',
  'menu.card.distributeX': '水平等距分布',
  'menu.card.distributeY': '垂直等距分布',
  'menu.card.group': '编组',
  'menu.card.ungroup': '取消编组',
  'menu.column.align': '把这一排分栏对齐',
  'history.align': '对齐卡片',
  'history.distribute': '等距分布',
  'history.group': '编组',
  'history.ungroup': '取消编组',
  'history.groupCollapse': '收起编组',
  'history.groupExpand': '展开编组',
  'history.groupLabel': '编组名',
  'history.alignColumns': '对齐分栏',
  // 期 6：整理类（T6.07 / T6.08 / F5-06 / F5-07）
  'history.tidyBoard': '自动整理',
  'history.groupByTag': '按标签分栏',
  'history.mapLink': '粘贴地图链接',
  // ★ 新建地图卡时用户没粘链接就取消（`O17`）→ 刚落的空卡要撤掉，这条历史就是那一次撤除
  'history.mapCardCancel': '取消地图卡',
  'notice.grouped': '已编组 {count} 张卡片。',
  'notice.ungrouped': '已取消编组。',
  'notice.groupNeedsTwo': '至少选中两张卡片才能编组。',
  'notice.ungroupNeedsGroup': '选中的卡片不在任何编组里。',

  // ── Sprint 9：卡片过滤（T3.17 / T3.18 / F8-04 / F8-06）────────────
  'command.toggleCardFilter.name': '过滤卡片…',
  'filter.title': '过滤卡片',
  'filter.placeholder': '搜索正文、标签或文件名…',
  'filter.hint': '输入以过滤 —— 不匹配的卡片会变淡',
  'filter.empty': '没有匹配这张过滤条件的卡片',
  'filter.count': '{count} / {total} 张卡片',
  'filter.types': '类型',
  'filter.broken': '只看断链',
  'filter.clear': '清除',
  'notice.filterCleared': '已清除卡片过滤。',
  'notice.onlyBroken': '正在显示 {count} 张断链卡片。',

  // ── Sprint 9：断链总览（T3.19 / F8-07）──────────────────────────
  'command.linkOverview.name': '断链总览',
  'linkOverview.title': '失效引用',
  'linkOverview.empty': '这块白板上没有失效的引用',
  'linkOverview.close': '关闭',
  'linkOverview.repair': '修复引用',
  'linkOverview.item': '{type}：{path}',
  'linkOverview.reason.image': '图片不存在',
  'linkOverview.reason.file': '文件不存在',
  'linkOverview.reason.noteRef': '笔记不存在',
  'linkOverview.reason.boardRef': '白板不存在',
  'linkOverview.reason.link': '链接无法解析',
  'notice.noBrokenLinks': '这块白板上没有失效的引用。',

  // ── Sprint 9：复制为 Markdown（T3.20 / F9-08）───────────────────
  'command.copyMarkdown.name': '复制为 Markdown',
  'notice.markdownCopied': '已把白板以 Markdown 复制到剪贴板。',
  'notice.markdownCopiedSkipped': '已复制为 Markdown —— 有 {count} 张卡片无法导出。',
  'notice.markdownCopyFailed': '写入剪贴板失败。',
  'notice.markdownCopyEmpty': '这块白板还没有可复制的内容。',

  // ── 优化 O11：视图右上角「更多」菜单 ────────────────────────────
  'command.copyBoardLink.name': '复制白板链接',
  'notice.boardLinkCopied': '已复制白板链接到剪贴板。',
  'notice.boardLinkUnavailable': '这块白板还没加载完，稍等一下再试。',

  // ── Sprint 9：白板嵌入笔记只读渲染（T3.16 / F10-04 / F1-10）────────
  'embed.title': '嵌入的白板',
  'embed.invalid': '没有给出白板路径。',
  'embed.notFound': '白板不存在：{path}',
  'embed.loadFailed': '无法读取白板：{error}',
  'embed.empty': '这块白板还是空的',
  'embed.open': '打开白板',
  'embed.cards': '{count} 张卡片',

  // 手绘工具条（T3.07 / F4-02）
  'inkBar.ariaLabel': '手绘工具',
  'inkBar.color': '颜色 {color}',
  'inkBar.customColor': '自定义颜色…',
  'inkBar.width': '笔宽 {n}',
  'inkBar.tool.brush': '画笔',
  'inkBar.tool.marker': '荧光笔',
  'inkBar.tool.annotate': '临时标注',
  'inkBar.clear': '清空临时标注',

  // 从图片吸色（T3.05 / F2.6）
  'menu.card.pickFromImage': '从图片吸色',
  'notice.swatchPickStart': '点击图片取色，Esc 取消',
  'notice.swatchPicked': '已吸取 {color}',
  'notice.swatchDuplicate': '{color} 已经铺在这张卡上了',
  'notice.swatchNeedImage': '请点图片卡上的图片',
  'notice.swatchOutside': '这一点落在图片之外',
  'notice.swatchNoColor': '取不到颜色（像素透明或图片读不出来）',
  'notice.swatchUnavailable': '当前环境不支持取色',
  'notice.fileCardRenameExists': '已存在同名文件 {name}',
  'notice.fileCardRenameFailed': '文件改名失败',

  // 待办总览浮层（T3.03 / F2.5）
  'todoOverview.title': '未完成待办',
  'todoOverview.empty': '本白板没有未完成待办',
  'todoOverview.close': '关闭',

  'card.title.placeholder': '标题',
  'color.red': '红',
  'color.orange': '橙',
  'color.yellow': '黄',
  'color.green': '绿',
  'color.cyan': '青',
  'color.purple': '紫',
  'color.none': '无',
  'color.custom': '自定义颜色…',

  'menu.card.edit': '编辑内容',
  // 地图卡（T7.03 / F2.9）：换图与清图钉
  'menu.card.pickMapImage': '选择地图图片',
  'menu.card.clearPin': '清除图钉',
  'menu.card.pasteMapLink': '粘贴地图链接',
  'menu.card.openMapLink': '打开链接',
  'menu.card.syncDuplicate': '新建同步副本',
  'menu.card.syncDetach': '取消同步',
  // 评论卡（T7.05 / F2.9）：整条线程收口 / 重新打开
  'menu.card.commentResolve': '标记为已解决',
  'menu.card.commentReopen': '重新打开',
  'menu.card.editSource': '常驻源码编辑',
  'menu.card.editPreview': '常驻渲染预览',
  'menu.card.editTitle': '编辑标题',
  'menu.card.showTitle': '显示标题',
  'menu.card.hideTitle': '隐藏标题',
  'menu.card.collapse': '收起卡片',
  'menu.card.expand': '展开卡片',
  'menu.mind.presentAdd': '把这棵脑图加入演示',
  'menu.mind.presentRemove': '把这棵脑图移出演示',
  'menu.mind.presentEarlier': '前移一位',
  'menu.mind.presentLater': '后移一位',
  'menu.card.treeCollapse': '折叠子级（+{count}）',
  'menu.card.treeExpand': '展开子级（+{count}）',
  'menu.card.treeUnlink': '解除父子关系',
  'menu.card.resetRotation': '重置旋转',
  'menu.card.color': '卡片颜色',
  'menu.card.accent': '强调色条',
  'menu.card.bringToFront': '置于顶层',
  'menu.card.sendToBack': '置于底层',
  'menu.card.duplicate': '原地复制',
  'menu.card.copy': '复制',
  'menu.card.cut': '剪切',
  'menu.card.lock': '锁定',
  'menu.card.unlock': '解锁',
  'menu.card.presentAdd': '加入演示路径',
  'menu.card.presentRemove': '移出演示路径',
  'menu.card.presentEarlier': '在演示中前移一步',
  'menu.card.presentLater': '在演示中后移一步',
  'menu.card.promote': '提升为笔记…',
  'menu.card.openSource': '打开源笔记',
  'menu.card.relink': '重新链接…',
  'menu.card.pickBlock': '引用块…',
  'menu.card.delete': '删除',
  'menu.edge.style': '线型',
  'menu.edge.solid': '实线',
  'menu.edge.dashed': '虚线',
  'menu.edge.arrow': '箭头',
  'menu.edge.arrowNone': '无箭头',
  'menu.edge.arrowForward': '终点单向',
  'menu.edge.arrowBackward': '起点单向',
  'menu.edge.arrowBoth': '两端双向',
  'menu.edge.routing': '走线',
  'menu.edge.routingFree': '直连',
  'menu.edge.routingSmart': '绕开卡片',
  'menu.edge.straighten': '拉直',
  'menu.edge.label': '标签',
  'menu.edge.routingCurve': '曲线',
  'menu.edge.labelEdit': '编辑标签…',
  'menu.edge.labelClear': '清除标签',
  'menu.edge.color': '颜色',
  'menu.edge.delete': '删除连线',
  'modal.edgeLabel.title': '连线标签',
  'modal.edgeLabel.desc': '显示在连线的正中间。留空即清除标签。',
  'modal.edgeLabel.placeholder': '例如：依赖',
  'modal.edgeLabel.save': '保存',
  'modal.edgeLabel.cancel': '取消',
  'canvas.edgeCurveHandle': '拖动调整连线弧度',
  'history.edgeRouting': '改变连线走线',
  'history.edgeStraighten': '拉直连线',
  'history.edgeLabel': '编辑连线标签',
  'history.edgeCurve': '调整连线弧度',
  'menu.canvas.newNote': '新建便签',
  'menu.canvas.filter': '过滤卡片…',
  'menu.canvas.moreCards': '更多卡片',
  'menu.canvas.newSyncNote': '新建同步便签',
  'menu.canvas.newComment': '新建评论卡',
  'menu.canvas.newTodo': '新建待办',
  'menu.canvas.present': '开始演示',
  'menu.canvas.selectAll': '全选',
  'menu.canvas.fitContent': '适应全部内容',
  'menu.canvas.zoomReset': '缩放至 100%',
  // 期 6：整理类（T6.07 / T6.08 / F5-06 / F5-07）
  'menu.canvas.tidyBoard': '自动整理',
  'menu.canvas.groupByTag': '按标签分栏',

  'card.noteRef.empty': '引用卡未指定笔记',
  'card.noteRef.missing': '源笔记不存在：{path}',
  'card.noteRef.loadFailed': '无法读取笔记。',
  'card.noteRef.relink': '重新链接',
  'card.noteRef.conflict': '源笔记已被别处改过，本次修改未写入。',
  'card.noteRef.writeMissing': '源笔记已不存在，本次修改未写入。',
  'card.noteRef.writeFailed': '写入源笔记失败，本次修改未保存。',
  'card.noteRef.discard': '丢弃',
  'card.noteRef.backlinks': '反链：{count}',
  'card.noteRef.targetMissing': '定位目标不在了，显示整篇笔记。',
  'modal.noteRefTarget.title': '引用某一处',
  'modal.noteRefTarget.desc': '选一处，卡片就只显示这一段。标题层级按原文保留。',
  'modal.noteRefTarget.whole': '整篇笔记',
  'modal.noteRefTarget.block': '块 ^{id}',
  'modal.noteRefTarget.empty': '这篇笔记里没有标题，也没有块 id。',
  'history.noteRefTarget': '切换引用位置',
  'menu.card.editContent': '编辑内容',
  'menu.card.annotate': '在图上标注',
  'menu.card.cropImage': '裁剪图片',
  'menu.card.inkColor': '笔迹颜色',

  'modal.crop.title': '裁剪图片',
  'modal.crop.hint': '拖动裁剪框选择要显示的区域。原图文件不会被修改。',
  'modal.crop.reset': '重置',
  'modal.crop.apply': '应用裁剪',
  'modal.crop.loading': '正在加载图片…',
  'modal.crop.loadFailed': '无法加载图片。',

  'modal.ok': '确定',
  'modal.cancel': '取消',
  'modal.pickNote.title': '选择笔记',
  'modal.pickNote.placeholder': '输入以搜索笔记…',
  'modal.pickBoard.title': '选择白板',
  'modal.pickBoard.placeholder': '输入以搜索白板…',
  'modal.pickBoard.create': '＋ 新建子白板',
  'modal.pickBoard.createHint': '在本板下新建一块 .nboard',
  'color.invalid': '颜色代码无效（请用 #RGB 或 #RRGGBB）。',

  'history.move': '移动卡片',
  'history.mindEdit': '编辑脑图',
  'history.resize': '调整卡片尺寸',
  'history.rotate': '旋转卡片',
  'history.delete': '删除卡片',
  'history.treeLink': '建立父子关系',
  'history.treeCollapse': '折叠子级',
  'history.treeUnlink': '解除父子关系',
  'history.duplicate': '复制卡片',
  'history.paste': '粘贴卡片',
  'history.color': '卡片配色',
  'history.title': '卡片标题',
  'history.collapse': '收起卡片',
  'history.order': '调整层级',
  'history.create': '新建卡片',
  'history.createChildBoard': '新建子白板',
  'history.toggleCardBorder': '卡片边框',
  'history.toggleLinkStyle': '链接卡样式',
  'history.titleStyle': '标签卡样式',
  'history.lock': '锁定卡片',
  'history.presentAdd': '加入演示路径',
  'history.presentRemove': '移出演示路径',
  'history.presentOrder': '调整演示顺序',
  'history.presentClear': '清空演示路径',
  'history.crop': '裁剪图片',
  'history.pickMapImage': '更换地图图片',
  'history.newSyncNote': '新建同步便签',
  // 评论卡（T7.05）
  'history.newComment': '新建评论卡',
  'history.commentResolve': '标记评论为已解决',
  'history.commentReopen': '重新打开评论',
  'history.syncNoteDup': '新建同步副本',
  'history.syncNoteDetach': '取消同步',
  // 白板卡片面预览（T7.09 / `F7-10`）
  'history.boardPreview': '切换卡面预览',
  // 白板卡卡面图标（`O10`）
  'history.boardIcon': '切换卡面图标',
  // 便签配色变体（`O06`）
  'history.noteVariant': '切换便签样式',
  'history.inkDraw': '手绘一笔',
  'history.inkErase': '擦除笔迹',
  'history.inkColor': '笔迹颜色',
  'history.inkClear': '清空手绘',
  'history.connect': '连接卡片',
  'history.edgeStyle': '修改连线样式',
  'history.edgeColor': '修改连线颜色',
  'history.gridSnap': '网格吸附',

  'notice.undone': '已撤销：{label}',
  'notice.redone': '已重做：{label}',
  'notice.undoEmpty': '没有可撤销的操作',
  'notice.redoEmpty': '没有可重做的操作',

  'notice.sourceMissing': '引用的笔记已不存在：{path}',
  'notice.sourceMissingFile': '源文件已不存在：{path}',
  'notice.promoteCreated': '已创建笔记：{path}',
  'notice.promoteFailed': '提升为笔记失败：{error}',

  'command.newNote.name': '新建便签',
  'command.newTodo.name': '新建待办',
  'command.newSwatch.name': '新建色板',
  'command.newMap.name': '新建地图卡',
  'command.newSyncNote.name': '新建同步便签',
  'command.newComment.name': '新建评论卡',
  'command.todoOverview.name': '待办总览',
  'command.inkBrush.name': '手绘：画笔',
  'command.inkEraser.name': '手绘：橡皮',
  'command.inkSelect.name': '手绘：交回选择工具',
  'command.clearInk.name': '清空手绘 / 临时标注',
  'command.inkMarker.name': '手绘：荧光笔',
  'command.inkAnnotate.name': '手绘：临时标注',
  'command.inkColor.name': '手绘：选择颜色…',
  'command.inkSwapColor.name': '手绘：换回上一支颜色',
  'command.inkWidth.name': '手绘：笔宽 {n}',
  'command.toggleGridSnap.name': '切换网格吸附',
  'command.editSelection.name': '编辑选中卡片',
  'command.deleteSelection.name': '删除所选',
  'command.duplicateSelection.name': '原地复制',
  'command.copySelection.name': '复制卡片',
  'command.cutSelection.name': '剪切卡片',
  'command.toggleTitle.name': '显示 / 隐藏卡片标题',
  'command.toggleLock.name': '锁定 / 解锁卡片',
  'command.promoteSelection.name': '提升选中卡片为笔记',
  'command.undo.name': '撤销',
  'command.redo.name': '重做',

  // ── Sprint 4：附件 / 分栏 / 嵌套白板 / 拖拽（T1.49–T1.67）─────────────
  'card.image.empty': '图片不存在：{path}',
  'card.image.loading': '正在加载图片…',
  'card.image.caption': '添加说明文字…',
  'menu.card.editCaption': '编辑说明文字',
  'menu.card.hideBorder': '取消边框',
  'menu.card.showBorder': '显示边框',

  // 地图卡（T7.03 / F2.9）：一张本地静态地图图 + 一个图钉
  'card.map.empty': '地图图不存在：{path}',
  'card.map.labelPlaceholder': '地点名…',
  'card.map.pinAt': '图钉在 {pin}',
  'card.map.noPin': '还没标图钉',
  'card.map.hint': '回车保存 · Esc 取消 · 右键可换图',
  'card.map.hintDrop': '双击图上任意处，标一个图钉',
  'card.map.missingImage': '地图图不存在：{path}',
  'card.map.hintFetchTile': '右键「粘贴地图链接」可以重新取一张地图图',
  'card.map.hintTileSetup': '在设置里挑一个静态图服务，粘链接时就能自动出图',

  'card.file.missing': '文件不存在：{path}',
  'card.file.open': '用系统默认应用打开',

  'card.media.play': '播放',
  // ── 视频卡（`A1`，用户 2026-09-18）──────────────────────────
  'card.type.video': '视频',
  'toolbar.video': '新建视频卡',
  'card.video.empty': '还没有视频 —— 拖一个进来，或从「更多卡片」里挑一份',
  'drop.hint.video': '作为视频卡放入',
  // ── 音频卡（`A2`，用户 2026-09-18）──────────────────────────
  'card.type.audio': '音频',
  'toolbar.audio': '新建音频卡',
  'card.audio.empty': '还没有音频 —— 拖一个进来，或从「更多卡片」里挑一份',
  'card.audio.pause': '暂停',
  'card.audio.seek': '进度',
  'card.audio.volume': '音量',
  'card.audio.mute': '静音',
  'card.audio.unmute': '取消静音',
  'drop.hint.audio': '作为音频卡放入',
  // ── 仅标题卡（`A3`，用户 2026-09-18）────────────────────────
  'card.type.titleCard': '仅标题卡',
  'toolbar.titleCard': '新建标题卡',
  'card.titleCard.placeholder': '双击写一行字…',
  'menu.card.titleShapePill': '纯圆角',
  'menu.card.titleShapeBubble': '带气泡',
  'menu.card.titleTail': '指针方向',
  'menu.card.tailBottom': '朝下',
  'menu.card.tailTop': '朝上',
  'menu.card.tailLeft': '朝左',
  'menu.card.tailRight': '朝右',
  // ── 图集卡（`A4`，用户 2026-09-18）──────────────────────────
  'card.type.gallery': '图集',
  'toolbar.gallery': '新建图集卡',
  'card.gallery.empty': '还没有图 —— 一次拖几张图进来，它们会合成一张图集卡',
  'card.gallery.prev': '上一张',
  'card.gallery.next': '下一张',
  'card.gallery.counter': '{index} / {total}',
  'card.media.collapse': '收起播放器',
  'card.media.unplayable': '无法播放这个文件（格式不受支持）',

  'card.link.empty': '还没有链接',
  'card.link.fetch': '获取预览',
  'card.link.refetch': '重新获取',
  'card.link.fetching': '获取中…',
  'card.link.retry': '重试',
  'card.link.disabled': '预览已关闭',
  // 按钮上的一档（T6.06）：**必须与 `card.link.disabled` 分开**——
  // 说"预览已关闭"会让用户去翻一个明明开着的总开关
  'card.link.blocked': '已屏蔽该站',
  'card.link.open': '在浏览器中打开',
  'menu.card.fetchPreview': '获取预览',
  'menu.card.linkCompact': '紧凑书签样式',
  'menu.card.linkFull': '完整卡片样式',
  'notice.linkFetched': '预览已更新',
  'notice.linkFetchFailed': '没能抓到这个页面的预览',
  // ★ 要说清两件事：**没发请求**（这是黑名单存在的意义），以及**怎么解掉**
  //   （否则用户只知道自己被拦了，不知道去哪删）
  'notice.linkBlocked':
    '这个站在你的「不抓取这些站」列表里 —— 没有发出任何请求。想抓的话可以在设置里把它删掉。',
  'notice.linkPreviewDisabled': '预览抓取已关闭 —— 可在设置里开启',
  'notice.linkPreviewEnabled':
    '已开启链接预览：点「获取预览」时会访问该网址，并把预览图存进你的库中。插件不会自动抓取。',
  'notice.mapLinkUnknown': '这段文字里没有能认出来的坐标（短链要先在浏览器里打开一次）',
  'notice.mapLinkSaved': '已存下链接与坐标 —— 在设置里挑一个静态图服务就能出图',
  'notice.mapLinkFetched': '地图图已取回并存进你的库中',
  'notice.mapLinkFetchFailed': '没能取到地图图 —— 链接与坐标已存下，之后可以再试',
  'notice.mapNoClipboard': '读不到剪贴板 —— 请在这里粘贴链接',
  'settings.linkPreview.name': '抓取链接预览',
  'settings.linkPreview.desc':
    '默认开启。插件不会自动抓取任何页面 —— 只有你点「获取预览」时才会发出一次请求：从该网页读出标题、摘要、站点名与图标，并把预览图作为附件存入你的库中。',
  // 域名黑名单（T6.06 / F2-4-6）。★ 说明里必须点出三件事：一行一个、写域名就够、
  //   "整站含子域"—— 用户最怕的是"我明明写了它却还在抓"，而那种失败全来自写法没讲清
  'settings.linkPreview.blocklist.name': '不抓取这些站',
  'settings.linkPreview.blocklist.desc':
    '一行一个站。这些站一个请求都不会发出去 —— 网页和预览图都不会。写域名就够（example.com），而且整站生效、含子域（m.example.com 同样不抓）。粘整条网址也行，保存时会收成域名。',
  'settings.linkPreview.blocklist.placeholder': 'example.com',
  'settings.mapTile.name': '地图卡的静态图服务',
  'settings.mapTile.desc':
    '默认不出图。挑好之后，在地图卡上粘一条地图链接时，插件会向这个服务要一张静态图并存进你的库中。其它时候一个请求都不会发出去。',
  'settings.mapTile.provider.none': '不出图（只存链接与经纬度）',
  'settings.mapTile.provider.osm': 'OpenStreetMap（社区服务，不用 key）',
  'settings.mapTile.provider.google': 'Google 静态地图（要 key）',
  'settings.mapTile.provider.amap': '高德地图（要 key）',
  'settings.mapTile.key.name': 'API key',
  'settings.mapTile.key.desc': '上面这一档发给你的 key。没填就不会发任何请求（当前：{provider}）。',
  'settings.mapTile.key.placeholder': '把 key 粘在这里…',
  'card.boardRef.empty': '双击新建子白板',
  'card.boardRef.missing': '白板不存在：{path}',
  'card.boardRef.cards': '{count} 张卡片',
  'card.boardRef.cardsAndMinds': '{cards} 张卡片 · {minds} 棵脑图',
  'menu.card.openBoard': '进入白板',
  'menu.card.newChildBoard': '新建子白板',
  // 卡面预览档位（T7.09 / `F7-10`）：与 `en` 同样是**互斥档位**的名词
  'menu.card.preview': '卡面预览',
  'menu.card.previewThumb': '缩略图',
  'menu.card.previewMini': '迷你',
  'menu.card.previewLive': '只读小窗',
  'menu.card.previewNone': '不预览',
  // 卡面图标（`O10`）：与 `en` 同样是"有没有图标"两种状态各一项
  'menu.card.pickIcon': '添加图标',
  'menu.card.changeIcon': '更换图标',
  'menu.card.clearIcon': '清除图标',
  // 深色便签（`O06`）：与 `en` 同样是"点下去会发生什么"的措辞
  'menu.card.noteDark': '深色便签',
  'menu.card.noteLight': '浅色便签',
  'modal.iconPicker.title': '选择卡面图标',
  'modal.iconPicker.desc': '输入以筛选，或从系统面板粘贴任意 emoji。',
  'notice.boardRefCreated': '已创建子白板：{path}',
  'notice.boardRefFailed': '创建子白板失败：{error}',

  'breadcrumb.home': '主页',
  'breadcrumb.root': '白板',
  'breadcrumb.ariaLabel': '白板路径',
  'command.openParent.name': '回到父级白板',
  'command.navigateBack.name': '后退',
  'command.navigateForward.name': '前进',
  'command.search.name': '白板内搜索',
  'command.searchNext.name': '跳到下一个结果',
  'command.exportMarkdown.name': '导出为 Markdown',
  'command.exportPng.name': '导出为 PNG',
  'command.exportPdf.name': '导出为 PDF',
  'command.exportSvg.name': '导出为 SVG',
  'command.exportZip.name': '导出白板与附件为 ZIP',
  'command.printBoard.name': '打印白板',
  'notice.noParent': '这块白板没有父级白板。',

  'export.looseCards': '未归类卡片',
  'notice.exported': '已导出到 {path}',
  'notice.exportedSkipped': '已导出到 {path}（{count} 张卡片未能导出）',
  'notice.exportEmpty': '这块白板还没有可导出的内容。',
  'notice.exportFailed': '导出失败：{error}',

  // 演示模式（J-06 / J-07）
  'present.bar.label': '演示操作',
  'present.bar.previous': '上一步',
  'present.bar.next': '下一步',
  'present.bar.overview': '总览整块白板',
  'present.bar.exit': '退出演示',
  'present.bar.count': '第 {current} 步，共 {total} 步',
  'notice.presentEmpty': '这块白板还没有可以演示的卡片。',
  'notice.presentAdded': '已加入演示路径（第 {step} 步）。',
  'notice.presentRemoved': '已移出演示路径。',
  'notice.presentCleared': '演示路径已清空。',
  'notice.treeCycle': '不能连接：这样会形成环。',
  'notice.treeHasParent': '不能连接：那张卡已经有父级了。',

  // 导出 PNG（T2.11 / F9-02）
  'modal.exportPng.title': '导出 PNG',
  'modal.exportPng.range.name': '范围',
  'modal.exportPng.range.desc': '决定图里包含哪些内容。',
  'modal.exportPng.range.all': '整块白板',
  'modal.exportPng.range.viewport': '当前视图',
  'modal.exportPng.range.selection': '仅选中',
  'modal.exportPng.scale.name': '倍率',
  'modal.exportPng.scale.desc': '倍率越高，图越清晰、尺寸越大。',
  'modal.exportPng.paginate.name': '分页导出',
  'modal.exportPng.paginate.desc': '分页能让大板保持清晰；关掉则导出成一整张大图。',
  'modal.exportPng.paginate.on': '分页（多张）',
  'modal.exportPng.paginate.off': '单页全景',
  'modal.exportPng.transparent.name': '背景透明',
  'modal.exportPng.transparent.desc': '不绘制画布底色与点阵/网格。',
  'modal.exportPng.export': '导出',
  'modal.exportPng.planTiled': '{columns}×{rows} = {count} 个文件，每张 {width}×{height} px。',
  'modal.exportPng.planSingle': '单张大图，{width}×{height} px。',
  'modal.exportPng.planEmpty': '没有可导出的内容。',
  'notice.pngExported': '已导出到 {path}',
  'notice.pngExportedMany': '已导出 {count} 张图片到 {folder}',

  // 导出 SVG（T6.01 / F9-06）
  'modal.exportSvg.title': '导出 SVG',
  'modal.exportSvg.range.name': '范围',
  'modal.exportSvg.range.desc': '决定矢量文件里包含哪些内容。',
  'modal.exportSvg.range.all': '整块白板',
  'modal.exportSvg.range.viewport': '当前视图',
  'modal.exportSvg.range.selection': '仅选中',
  'modal.exportSvg.transparent.name': '背景透明',
  'modal.exportSvg.transparent.desc': '不绘制画布底色与点阵/网格。',
  'modal.exportSvg.export': '导出',
  'modal.exportSvg.plan': '单个矢量文件，{width}×{height} 单位 —— 放大不糊。',
  'modal.exportSvg.planWithImages':
    '单个矢量文件，{width}×{height} 单位。{count} 张位图卡片（图片 / 地图）只会保留文字。',
  'modal.exportSvg.planEmpty': '没有可导出的内容。',
  'notice.svgExported': '已导出到 {path}',

  // 导出 ZIP（T6.02 / F9-07）
  'modal.exportZip.title': '导出 ZIP',
  'modal.exportZip.desc': '把这块白板连同它用到的附件打成一个包，别处打开时就不会满屏断链。',
  'modal.exportZip.count': '将打包 {count} 个附件，外加白板文件本身。',
  'modal.exportZip.none': '没有可打包的图片 / 文件卡 —— 归档里只有白板文件本身。',
  'modal.exportZip.missingTitle': '有 {count} 个被引用的文件在库里已找不到，打包时会跳过：',
  'modal.exportZip.target': '归档保留库内相对路径 —— 解压到你的库根目录，白板打开时附件就在原位。',
  'modal.exportZip.cancel': '取消',
  'modal.exportZip.confirm': '导出',
  'notice.zipExported': '已导出到 {path}',
  'notice.zipExportedSkipped': '已导出到 {path}（{count} 个文件读不出来，已跳过）',

  // 导出 PDF（T4.10 / F9-03）
  'pdf.footer.page': '{label} · 第 {page} / {total} 页',
  'modal.exportPdf.title': '导出 PDF',
  'modal.exportPdf.range.name': '范围',
  'modal.exportPdf.range.desc': '决定 PDF 里包含哪些内容。',
  'modal.exportPdf.range.all': '整块白板',
  'modal.exportPdf.range.viewport': '当前视图',
  'modal.exportPdf.range.selection': '仅选中',
  'modal.exportPdf.orientation.name': '纸张',
  'modal.exportPdf.orientation.desc': 'A4 纸，每页承载白板的一块（真实多页）。',
  'modal.exportPdf.orientation.portrait': 'A4 纵向',
  'modal.exportPdf.orientation.landscape': 'A4 横向',
  'modal.exportPdf.clarity.name': '清晰度',
  'modal.exportPdf.clarity.desc': '每页长边的像素数。越高越清晰、文件越大，页数不变。',
  'modal.exportPdf.clarity.standard': '标准 · 2048 px',
  'modal.exportPdf.clarity.high': '高清 · 3072 px',
  'modal.exportPdf.clarity.ultra': '超清 · 4096 px',
  'modal.exportPdf.export': '导出',
  'modal.exportPdf.planTiled': '{count} 页，{columns}×{rows} 块，每页 {width}×{height} px。',
  'modal.exportPdf.planEmpty': '没有可导出的内容。',
  'modal.exportPdf.bitmapNote': '每一页都是位图：PDF 里的文字不能选中、不能搜索。',
  'notice.pdfExported': '已导出到 {path}',
  'notice.pdfExportedPages': '已导出 {count} 页到 {path}',
  'notice.pdfFailed': 'PDF 导出失败：{reason}',

  // 打印（T6.03 / F9-10）
  'print.footer.page': '{label} · 第 {page} / {total} 页',
  'modal.exportPrint.title': '打印白板',
  'modal.exportPrint.range.name': '范围',
  'modal.exportPrint.range.desc': '决定要印哪些内容。',
  'modal.exportPrint.range.all': '整块白板',
  'modal.exportPrint.range.viewport': '当前视图',
  'modal.exportPrint.range.selection': '仅选中',
  'modal.exportPrint.orientation.name': '纸张',
  'modal.exportPrint.orientation.desc': 'A4 纸，每页承载白板的一块（真实多页）。',
  'modal.exportPrint.orientation.portrait': 'A4 纵向',
  'modal.exportPrint.orientation.landscape': 'A4 横向',
  'modal.exportPrint.planTiled': '共 {count} 页，{columns}×{rows} 块。',
  'modal.exportPrint.planEmpty': '没有可打印的内容。',
  'modal.exportPrint.posterHint':
    '这会印成 {columns}×{rows} 页。相邻页边缘刻意留了一点点重叠 —— 全部印出来后按边裁掉、拼起来就是一张大图。',
  'modal.exportPrint.confirm': '打印',
  'notice.printFailed': '打不开打印对话框：{reason} —— 可以改用「导出为 PDF」。',

  // 模板库（T4.14 / F7-06）
  'command.newBoardFromTemplate.name': '从模板新建白板',
  'command.saveBoardAsTemplate.name': '另存为模板',
  'modal.template.title': '从模板新建白板',
  'modal.template.placeholder': '搜索模板…',
  'modal.template.empty': '没有匹配的模板。',
  'modal.template.builtin': '内置',
  'modal.template.user': '我的模板',
  'modal.template.summary': '{cards} 张卡片 · {columns} 个分栏',
  'modal.template.summaryMinds': '{cards} 张卡片 · {columns} 个分栏 · {minds} 棵脑图',
  'modal.template.skipped': '有 {count} 份模板读不出来，已跳过。',
  'modal.template.hint': '会在 {folder} 里新建一块白板；模板本身不会被改动。',
  // 模板市场（T6.09）：分类筛选与空模板占位
  'modal.template.category.all': '全部',
  'modal.template.previewEmpty': '空模板',
  'modal.template.overflow': '先显示前 {shown} 份；用搜索或分类缩小范围。',
  'template.category.research': '调研',
  'template.category.schedule': '排期',
  'template.category.moodboard': '视觉',
  'template.category.writing': '写作',
  'notice.templateCreated': '已从「{name}」新建白板：{path}',
  'notice.templateCreateFailed': '新建白板失败：{error}',
  'notice.templateUnreadable': '模板读不出来 {path}：{error}',
  'notice.templateListFailed': '读取模板列表失败：{error}',
  'notice.templateInvalid': '不是有效的白板文件',
  'settings.folder.vaultRoot': '库根目录',
  'notice.templateSaved': '已另存为模板：{path}',
  'notice.templateSaveFailed': '另存为模板失败：{error}',
  'modal.saveTemplate.title': '另存为模板',
  'modal.saveTemplate.name.name': '模板名称',
  'modal.saveTemplate.name.desc': '会复制一份出去，当前白板不动。',
  'modal.saveTemplate.name.placeholder': '例如：每周研究分享',
  'modal.saveTemplate.note': '存到 {folder}；同名文件不会被覆盖，新的那份会自动加序号。',
  'modal.saveTemplate.empty': '模板名不能为空。',
  'modal.saveTemplate.submit': '保存',
  'setting.templateFolder.name': '模板目录',
  'setting.templateFolder.desc':
    '「另存为模板」写到这里；从模板新建出来的白板仍然进上面的「新白板目录」。',
  'setting.homeBoard.name': 'Home 白板路径',
  'setting.homeBoard.desc':
    'Home 白板放在哪。「添加到收件箱」会把文件放进它的 `Unsorted` 栏；这一栏留空即关闭 Home 白板。',

  // 内置模板的内容（T4.14）—— 模板正文也是文案，跟着界面语言走
  'template.research.name': '桌面研究',
  'template.research.desc': '问题 → 资料 → 洞察 → 结论，另带一棵"研究问题树"',
  'template.research.mind.root': '研究问题',
  'template.research.colA': '问题',
  'template.research.colB': '资料',
  'template.research.colC': '洞察 → 结论',
  'template.research.howto.title': '怎么用这块板',
  'template.research.howto.md':
    '- 三栏是**顺序**，不是分类：卡住的时候往左看一眼\n- 「资料」栏只进不出，等它满到看不下去再动手\n- 最后的结论必须能回答第一栏那个问题',
  'template.research.q.title': '研究问题',
  'template.research.q.md': '- 要回答的是：\n- 为什么现在回答它：\n- 什么算"答完了"：',
  'template.research.hypo.title': '先写下假设',
  'template.research.hypo.md':
    '后面收的每一条资料都在检验这一句 —— 写下来，才看得出自己有没有被资料牵着走。\n\n- 我的假设：',
  'template.research.ref.title': '要读的笔记',
  'template.research.src.title': '外部资料',
  'template.research.src.md': '- 来源 / 作者：\n- 关键结论：\n- 可信度（一手 / 二手 / 传闻）：',
  'template.research.insight.title': '洞察',
  'template.research.insight.md': '- 三条以上资料都指向：\n- 互相打架的地方：\n- 我原来想错的：',
  'template.research.concl.title': '结论',
  'template.research.concl.md': '一句话回答最上面那个问题：\n\n\n\n还有哪些不确定：',

  'template.schedule.name': '每周排期',
  'template.schedule.desc': '待办 / 进行中 / 已完成 三栏看板，逼自己"同时只做三件"',
  'template.schedule.colA': '待办',
  'template.schedule.colB': '进行中',
  'template.schedule.colC': '已完成',
  'template.schedule.todo': '本周',
  'template.schedule.doing': '在做',
  'template.schedule.done': '这周完成',
  'template.schedule.howto.title': '怎么用这块板',
  'template.schedule.howto.md':
    '- 一张卡 = 一件事，卡里的清单用来拆步骤\n- 往右拖就是有进展；拖回左边不算失败，算诚实\n- 每周五清空「已完成」，下周一从空栏开始',
  'template.schedule.ask.title': '进栏之前先问',
  'template.schedule.ask.md': '- 不做会怎样？\n- 这是谁的活？\n- 这周真的有位置吗？',
  'template.schedule.wip.title': '上限三张',
  'template.schedule.wip.md': '同时开工超过三张，等于一张都没在推进。\n\n第 4 张先放回「待办」。',
  'template.schedule.review.title': '完成时补一句',
  'template.schedule.review.md': '- 实际花了多久（估的和实差多少）\n- 下次怎么更快',

  'template.moodboard.name': '情绪板',
  'template.moodboard.desc': '参考、色板、"气质"三个词摆在一起，做视觉方向的第一版',
  'template.moodboard.primary.title': '主色',
  'template.moodboard.accent.title': '点缀色',
  'template.moodboard.vibe.title': '三个词',
  'template.moodboard.vibe.md':
    '用三个词说清这块板该是什么气质 —— 别写"好看""高级"这种单拎出来没有信息量的词。\n\n- \n- \n- ',
  'template.moodboard.refs.title': '参考图从这里开始',
  'template.moodboard.refs.md':
    '把图拖进来，再各写一句**为什么**它是对的 —— 只贴图不写理由，一周后自己都看不懂。',
  'template.moodboard.style.title': '风格参考笔记',
  'template.moodboard.howto.title': '怎么用这块板',
  'template.moodboard.howto.md':
    '- 参考图直接拖到画布上，拖到哪算哪（这块板默认关掉了网格吸附）\n- 色板卡双击就能改，一行一个 HEX\n- 每张参考图下面写一句**为什么**它成立',

  'template.writing.name': '长文骨架',
  'template.writing.desc': '素材 / 结构 / 草稿 三栏：先把能用的都堆进来，再决定怎么排',
  'template.writing.colA': '素材',
  'template.writing.colB': '结构',
  'template.writing.colC': '草稿',
  'template.writing.howto.title': '怎么用这块板',
  'template.writing.howto.md':
    '- 「素材」栏只进不出，直到写不动为止\n- 结构定下来之后再动「草稿」栏\n- 卡片正文就是正文，写完直接「导出为 Markdown」',
  'template.writing.material.title': '素材',
  'template.writing.material.md': '能用的句子、数据、引用先扔进来，不排序。\n\n- \n- \n- ',
  'template.writing.refs.title': '要引用的笔记',
  'template.writing.spine.title': '一句话主线',
  'template.writing.spine.md': '谁、遇到什么、然后呢 —— 一句话说不清，就先别往下写。',
  'template.writing.outline.title': '段落顺序',
  'template.writing.outline.md': '- 开头：\n- 转折：\n- 收尾：',
  'template.writing.open.title': '开头',
  'template.writing.open.md': '第一句就要有人在做事。\n不要"随着……的发展""在当今时代"。',
  'template.writing.close.title': '收尾',
  'template.writing.close.md': '回扣开头那句话，然后停。\n不要总结，要收。',

  // 诊断信息（T2.17 / 02 §8.3）
  'command.showDiagnostics.name': '显示诊断信息',
  'modal.diagnostics.title': '诊断信息',
  'modal.diagnostics.refresh': '刷新',
  'diagnostics.loading': '正在读取…',
  'diagnostics.failed': '读取诊断信息失败：{error}',
  'diagnostics.path': '白板',
  'diagnostics.scale': '规模',
  'diagnostics.scaleValue': '{cards} 卡片 · {columns} 分栏 · {edges} 连线',
  'diagnostics.dom': '画布 DOM 节点',
  'diagnostics.domWarn': '超过 {limit}：拖动时样式重算会明显变慢。',
  'diagnostics.rendered': '已渲染',
  'diagnostics.renderedValue': '{cards} 卡片 · {columns} 分栏 · 池中空闲 {pooled}',
  'diagnostics.zoom': '缩放',
  'diagnostics.file': '文件大小',
  'diagnostics.fileWarn': '超过 {limit}：写盘会开始出现停顿。',
  'diagnostics.unavailable': '不可用',
  'diagnostics.thumbs': '缩略图缓存',
  'diagnostics.thumbsValue':
    '内存 {entries} 条 · 命中 {hits} / 未命中 {misses} · 失败 {failures} · 命中率 {rate}',
  'diagnostics.thumbsWarn': '大量未命中：缓存基本没起作用。',
  'diagnostics.save': '最近写盘',
  'diagnostics.saveNone': '尚无记录',
  'diagnostics.saveValue': '{total} ms（序列化 {serialize} / 写盘 {write}）',
  'diagnostics.saveWarn': '写盘偏慢：留意磁盘或同步软件。',
  'diagnostics.saveSerializeWarn': '大头在序列化：每次保存都全量重写 JSON。',
  'diagnostics.frames': '待提交帧任务',
  'diagnostics.framesValue': '{count} 个',

  'command.renameBoard.name': '重命名白板',
  'modal.renameBoard.title': '重命名白板',
  'modal.renameBoard.empty': '名字不能为空。',
  'modal.renameBoard.exists': '同名文件已存在。',
  'notice.renameFailed': '重命名失败：{error}',

  'settings.newBoardFolder.name': '新白板目录',
  'settings.newBoardFolder.desc': '新建白板放在哪里。留空表示库根目录。',
  'settings.attachment.location.name': '附件存放位置',
  'settings.attachment.location.desc': '拖入 / 粘贴进来的附件放在哪里。',
  'settings.attachment.location.vault': '跟随 Obsidian 的附件设置',
  'settings.attachment.location.custom': '自定义目录',
  'settings.attachment.folder.name': '自定义附件目录',
  'settings.attachment.folder.desc': '仅在上面选了「自定义目录」时生效。留空表示库根目录。',
  'settings.attachment.naming.name': '附件命名',
  'settings.attachment.naming.desc': '带时间戳可以避免两张都叫 image.png 的图互相覆盖。',
  'settings.attachment.naming.timestamp': '加时间戳前缀',
  'settings.attachment.naming.original': '保留原始文件名',
  'settings.attachment.dedupe.name': '按内容去重附件',
  'settings.attachment.dedupe.desc':
    '导入时，内容完全相同的图片 / 文件只存一份（按 SHA-256 内容比对，不看文件名）。默认关闭：把同一个文件拖两次常常是故意的。只在本次会话内生效。',
  'settings.autosave.name': '自动保存间隔',
  'settings.autosave.desc': '最后一次改动之后等多久写盘。短一点更安全，长一点写盘更少。',
  'settings.autosave.value': '{ms} 毫秒',
  'settings.reset.name': '恢复默认设置',
  'settings.reset.desc': '把本页所有选项恢复成默认值。',
  'settings.reset.button': '恢复默认',
  'notice.settingsReset': '设置已恢复默认。',

  'column.title.placeholder': '未命名分栏',
  'column.count': '{count} 张卡片',
  'column.collapse': '折叠',
  'column.expand': '展开',
  'column.drag': '拖动以移动分栏',
  'menu.column.rename': '重命名分栏',
  'menu.column.collapse': '折叠分栏',
  'menu.column.expand': '展开分栏',

  // 编组（O03）
  'group.defaultLabel': '分组',
  'group.count': '{count} 张',
  'group.countMixed': '{cards} 张 + {columns} 栏',
  'group.collapse': '收起分组',
  'group.expand': '展开分组',
  'menu.column.split': '拆成多个分栏',
  'menu.column.toGroup': '转成编组',
  'menu.column.delete': '删除分栏',
  'menu.column.deleteWithCards': '删除分栏及其中卡片',
  'menu.card.collect': '收进分栏',
  'command.splitIntoColumns.name': '批量生成同级并排分栏',
  'command.collectIntoColumn.name': '收进分栏',
  'command.toggleColumnCollapse.name': '折叠 / 展开分栏',
  'command.splitBoard.name': '拆分白板',
  'history.column': '分栏',
  'history.moveColumn': '移动分栏',
  'history.resizeColumn': '调整分栏尺寸',

  'menu.file.addToBoard': '添加到白板',
  'menu.file.addToUnsorted': '添加到收件箱',
  'menu.file.newBoardHere': '在此新建 nestboard',
  'menu.file.newMindHere': '在此新建 nestmind',
  'notice.addedToBoard': '已添加 {count} 张卡片到 {board}',
  'notice.addToBoardFailed': '无法把文件添加到 {path}。',
  'notice.dropNoBoard': '没有打开的白板可以放入。',
  'notice.noBoardYet': '还没有白板。先新建一块白板，再把这个文件加进去。',
  'notice.attachmentFailed': '导入文件失败：{error}',
  'notice.importing': '正在导入 {count} 个文件…',
  'notice.pastedImage': '图片已保存：{path}',
  'notice.copiedCards': '已复制 {count} 个对象（可以贴到任何一块白板里）',
  'notice.copyFailed': '没能写入系统剪贴板。',
  'notice.pastedCards': '已粘贴 {count} 个对象',
  'notice.protocolMissingFile': '这个链接里没有白板路径（缺 `?file=…`）。',
  'notice.protocolNotBoard': '这个链接指向的不是白板 —— 路径要以 `.nboard` 结尾。',
  'notice.protocolOutsideVault': '这个链接指向了库外，已拒绝打开。',
  'notice.protocolBoardMissing': '找不到白板：{path}',
  'notice.homeNotConfigured': 'Home 白板未启用。先在 Nestboard 设置里给它填一个路径。',
  'notice.addedToUnsorted': '已放进收件箱',
  // 拖出导出（T6.10 / F6-04）：导出的笔记是要拿去继续写的，所以只报"写了几篇、写到哪"
  'notice.dragOutExported': '已导出 {count} 篇笔记到 {folder}',
  'notice.dragOutEmpty': '这几张卡是空的，没有可导出的内容。',
  'notice.dragOutFailed': '导出失败：{error}',
  'drop.hint.noteRef': '作为引用卡放入',
  'drop.hint.image': '作为图片卡放入',
  'drop.hint.file': '作为文件卡放入',
  'drop.hint.boardRef': '作为嵌套白板放入',
  // 拖进来一段文字（T6.11 / F6-07）
  'drop.hint.note': '作为便签卡放入',
  'drop.hint.multiple': '放入 {count} 项',

  // 大文件分级退化（T2.16 / 02 §8.3）
  'scale.hint.degraded': '这块白板较大（{cards} 张卡），已折叠所有分栏以保持流畅。',
  'scale.hint.split': '这块白板非常大（{cards} 张卡），建议拆分成多块小板。',
  'scale.hint.oversized': '文件已达 {size}，内联卡片过多；把长文本提升为笔记会明显更快。',
  'scale.action.expandAll': '展开全部分栏',
  'scale.action.split': '拆分白板…',
  'scale.action.dismiss': '关闭提示',
  'notice.columnsExpanded': '已展开 {count} 个分栏。',
  'notice.splitNotNeeded': '这块白板还不够大，不需要拆分。',
  'modal.splitBoard.title': '拆分白板',
  'modal.splitBoard.desc': '所选的每一组各自成为一块新白板，原白板保留一张指向它的白板卡。',
  'modal.splitBoard.summary':
    '新建 {children} 块白板 · 迁走 {moved} 张卡 · 原板留下 {remaining} 张卡',
  'modal.splitBoard.warning': '拆分新建的文件无法通过白板的撤销记录撤回。',
  'modal.splitBoard.empty': '没有可拆分的内容：这块白板没有非空的分栏。',
  'modal.splitBoard.confirm': '拆分',
  'notice.boardSplit': '已拆成 {count} 块白板：{paths}',
  'notice.boardSplitFailed': '拆分白板失败：{error}',

  // ── Sprint 10：设置面板分节标题（T3.27 打磨）────────────────────
  'settings.section.board': '新建白板',
  'settings.section.attachment': '附件',
  'settings.section.build': '构建信息',
  'settings.build.name': '当前构建',
  'settings.build.desc':
    '当前运行的是 {build}。如果某个改动没生效，先看这里 —— 多数情况是换包之后没重启，还在跑旧包。',
  'settings.section.privacy': '隐私与网络',
  'settings.section.save': '保存',

  // ── Sprint 10：界面语言（T3.23 / F11-13）────────────────────────
  'settings.language.name': '界面语言',
  'settings.language.desc': '默认跟随 Obsidian。也可以在这里单独指定本插件的语言。',
  'settings.language.auto': '跟随 Obsidian',
  'settings.language.zhCn': '简体中文',
  'settings.language.en': 'English',

  // ── Sprint 10：卡片默认样式（T3.24 / F11-03）────────────────────
  'settings.cardDefaults.name': '新建卡片外观',
  'settings.cardColor.name': '默认卡片颜色',
  'settings.cardColor.desc': '只影响之后新建的卡片，已有卡片保留自己的颜色。',
  'settings.cardColor.custom': '自定义颜色…',
  'settings.cardColor.customHex.name': '自定义颜色',
  'settings.cardColor.customHex.desc': '形如 #4c8bf5 的十六进制色值。非法值会回落成主题色。',
  'settings.cardStyle.name': '卡片外观档',
  'settings.cardStyle.desc':
    '「拟物」给卡片加上柔和的双阴影与内阴影（保留卡片主色），分栏 / 工具条 / 菜单一起换；「原版」是 2.1.3 那套样子。',
  'settings.cardStyle.classic': '原版（2.1.3）',
  'settings.cardStyle.neumorph': '拟物',
  'settings.cardRadius.name': '卡片圆角',
  'settings.cardRadius.desc': '所有卡片的圆角半径（像素）。',
  'settings.cardRadius.value': '{px} 像素',
  'settings.cardFontSize.name': '卡片字号',
  'settings.cardFontSize.desc': '卡片正文的基础字号（像素）。',
  'settings.alwaysFullImage.name': '图片卡始终使用原图',
  'settings.alwaysFullImage.desc':
    '图片卡直接加载原图，不因为缩小而换成缩略图 —— 放大看细节时不会糊。关掉它可以在超大白板上省显存：图在屏幕上画得比缩略图还小时，改用缩略图。',
  'settings.cardFont.name': '卡片字体',
  'settings.cardFont.desc': '卡片正文的 CSS font-family。留空表示跟随主题。',
  'settings.cardFont.placeholder': '跟随主题',

  // ── Sprint 10：画布默认背景（T3.25 / F11-04）────────────────────
  'settings.canvas.name': '新建白板画布',
  'settings.canvas.background.name': '默认背景',
  'settings.canvas.background.desc': '之后新建的白板使用哪种背景。',
  'settings.canvas.background.plain': '纯色',
  'settings.canvas.background.dots': '点阵',
  'settings.canvas.background.grid': '网格',
  'settings.canvas.background.none': '无',

  // ── 期 5：缩略图导航器（T5.09 / F1-06）─────────────────────────
  'settings.section.minimap': '缩略图导航器',
  'settings.minimap.name': '显示缩略图导航器',
  'settings.minimap.desc':
    '画布右下角的小地图。点击或拖动即可跳到白板的对应位置；在它上面按 Enter 可回到内容中心。',

  // ── Sprint 10：底部工具条（T3.21 / T3.27）──────────────────────
  'toolbar.ariaLabel': '白板工具',
  'toolbar.moreCards': '更多卡片',
  'toolbar.select': '选择工具',
  'toolbar.ink': '手绘',
  'toolbar.note': '新建便签',
  'toolbar.todo': '新建待办清单',
  'toolbar.swatch': '新建色板',
  'toolbar.link': '新建链接卡',
  'toolbar.image': '新建图片卡',
  'toolbar.file': '新建文件卡',
  'toolbar.column': '新建分栏',
  'toolbar.board': '新建白板卡',
  'toolbar.map': '新建地图卡',
  'toolbar.syncNote': '新建同步便签',
  'toolbar.comment': '新建评论卡',
  'toolbar.zoomOut': '缩小',
  'toolbar.zoomReset': '缩放回 100%',
  'toolbar.zoomIn': '放大',
  'toolbar.zoomFit': '适应内容',
  'toolbar.gridSnap': '网格吸附',
  'toolbar.gridSnapOn': '网格吸附：开',
  'toolbar.gridSnapOff': '网格吸附：关',
  'toolbar.createHint': '拖到画布上松手即可新建卡片',
  // 引导语跟得上"脑图也是一等公民"（`2.2.0` 收尾 · O5）：只说"加一张卡片"会把
  // 刚插了一棵树的人绕回原点 —— 他眼前明明已经有内容了
  'notice.emptyBoardHint': '这块白板还是空的 —— 用工具条加一张卡片或一棵脑图吧。',
  'notice.mobileToolbarHint':
    '提示：把底部工具条上的按钮拖到画布上即可建卡或建脑图；长按卡片可打开菜单。',

  // 画布右键菜单补齐（T3.27：与工具条 / 命令面板同一批动作）
  'menu.canvas.newSwatch': '新建色板',
  'menu.canvas.newLink': '新建链接卡',
  'menu.canvas.newColumn': '新建分栏',
  'menu.canvas.draw': '手绘',

  // ── Sprint 10：无障碍（T3.26）───────────────────────────────────
  'a11y.canvas.hint': '按 Tab 聚焦卡片，方向键移动选区。',
  'a11y.board.label': '白板，共 {count} 张卡片',
  'a11y.card.label': '{type}：{title}',
  'a11y.card.untitled': '未命名{type}',
  'a11y.card.locked': '已锁定',
  'a11y.card.selected': '已选中',
  'a11y.card.withState': '{label}（{state}）',
  'a11y.card.stateSeparator': '、',
  'a11y.card.hint': '按 Enter 编辑，按 Tab 跳到下一张卡。',

  // ── Sprint 10：文件名兜底（T3.23）───────────────────────────────
  'fileName.untitled': '未命名',
  'error.canvasContext': '无法获取 2D 画布上下文。',

  // ── Sprint 10：工具条用到的选择器 / 输入框（T3.21）──────────────
  'modal.pickFile.placeholder': '从库中选一份文件…',
  'settings.section.snapshot': '版本快照',
  'settings.snapshot.enabled.name': '启用版本快照',
  'settings.snapshot.enabled.desc':
    '每编辑满五分钟就存一份白板文件（每块板最多 50 份 / 20MB）。可在「查看历史版本」里恢复。',
  'settings.snapshot.location.name': '快照存放位置',
  'settings.snapshot.location.desc':
    '「插件目录」不进你的库、不会被搜索命中；「库内 .nestboard-history」会被 Obsidian Sync / Git 一起同步走。',
  'settings.snapshot.location.plugin': '插件目录（.obsidian）',
  'settings.snapshot.location.vault': '库内（.nestboard-history）',

  'modal.link.title': '新建链接卡',
  'modal.link.name': '链接地址',
  'modal.link.desc': '这张卡指向的网址。以后可以在卡片菜单里改。',
  'modal.link.confirm': '添加卡片',
  'modal.mapLink.title': '粘贴地图链接',
  'modal.mapLink.name': '地图链接或坐标',
  'modal.mapLink.desc':
    '把 Google 地图 / 苹果地图 / 高德 / OpenStreetMap 地址栏里的那条网址粘进来，也可以直接敲坐标（39.9042, 116.4074）。短链要先在浏览器里打开一次。',
  'modal.mapLink.confirm': '用这条链接',

  // 期 4：版本快照（T4.01 / T4.02 / F11-11）
  'command.createSnapshot.name': '创建快照',
  'command.snapshotHistory.name': '查看历史版本',
  'notice.snapshotCreated': '已创建快照（{cards} 张卡片）',
  'notice.snapshotCreateFailed': '创建快照失败：{error}',
  'notice.snapshotEmpty': '这块白板还没有快照',
  'notice.snapshotDisabled': '设置里已关闭版本快照',
  'notice.snapshotRestored': '已恢复到 {time} 的版本',
  'notice.snapshotRestoreFailed': '恢复快照失败：{error}',
  'modal.snapshot.title': '历史版本 · {board}',
  'modal.snapshot.empty':
    '还没有快照。改动后满五分钟会自动存一份，也可以随时用「创建快照」立刻存。',
  'modal.snapshot.column.time': '时间',
  'modal.snapshot.column.cards': '卡片',
  'modal.snapshot.column.diff': '与当前相比',
  'modal.snapshot.diffSame': '与当前一致',
  'modal.snapshot.diffMore': '比现在多 {count} 张',
  'modal.snapshot.diffLess': '比现在少 {count} 张',
  'modal.snapshot.preview': '预览',
  'modal.snapshot.previewEmpty': '这份快照里没有卡片',
  'modal.snapshot.previewMore': '…还有 {count} 张',
  'modal.snapshot.previewFailed': '读不出这份快照：{error}',
  'modal.snapshot.restore': '恢复',
  'modal.snapshot.confirmTitle': '要恢复到这个版本吗？',
  'modal.snapshot.confirmBody':
    '当前版本会先自动存一份快照，然后用 {time} 的版本覆盖（{cards} 张卡片）。',
  'modal.snapshot.confirmOk': '恢复',
  'modal.snapshot.cancel': '取消',

  // 期 4：危险操作与同步冲突（T4.03 / T4.04，03 §3.4 §3.6）
  'command.deleteBoard.name': '删除白板',
  'command.viewConflicts.name': '查看同步冲突',
  'menu.file.deleteBoard': '删除白板…',
  'menu.file.viewConflict': '对比同步冲突副本…',
  'notice.trashMissing': '没有可删除的文件：{path}',
  'notice.boardTrashed': '白板已移入回收站：{path}（已先存一份快照）',
  'notice.conflictCopyTrashed': '冲突副本已移入回收站：{path}',
  'notice.conflictCopies': '发现 {count} 个同步冲突副本，可用「查看同步冲突」逐个对比处理。',
  'notice.conflictCopiesNone': '没有发现同步冲突副本',
  'notice.conflictCopyAppeared': '出现同步冲突副本：{path}',
  'modal.confirm.cancel': '取消',
  'modal.confirmDeleteBoard.title': '要删除这块白板吗？',
  'modal.confirmDeleteBoard.body':
    '「{path}」会被移入回收站（不是永久删除）。删除前会自动存一份快照，之后可在「查看历史版本」里恢复。',
  'modal.confirmDeleteBoard.ok': '移入回收站',
  'modal.confirmDeleteCopy.title': '要删除这个冲突副本吗？',
  'modal.confirmDeleteCopy.body':
    '「{path}」会被移入回收站。删除前会自动存一份快照。原白板不受影响。',
  'modal.confirmDeleteCopy.ok': '移入回收站',
  'modal.syncConflict.title': '同步冲突 · {board}',
  'modal.syncConflict.desc':
    '并排只读对比，不会自动合并、也不会写任何文件 —— 看清差异后由你决定怎么处理。',
  'modal.syncConflict.copySelect': '冲突副本',
  'modal.syncConflict.left': '当前版本',
  'modal.syncConflict.right': '冲突副本',
  'modal.syncConflict.leftMissing': '读不出原白板 —— 可能已被重命名或删除。',
  'modal.syncConflict.rightMissing': '这个副本读不出白板内容。',
  'modal.syncConflict.summary': '{cards} 张卡片 · {columns} 个分栏 · {edges} 条连线',
  'modal.syncConflict.revision': '修订号 {revision}',
  'modal.syncConflict.counts': '副本多 {added} 张 · 当前多 {removed} 张 · {changed} 张有差异',
  'modal.syncConflict.noDiff': '两个版本的卡片完全一致。',
  'modal.syncConflict.onlyDiff': '只看差异',
  'modal.syncConflict.statusSame': '一致',
  'modal.syncConflict.statusLeftOnly': '仅当前有',
  'modal.syncConflict.statusRightOnly': '仅副本有',
  'modal.syncConflict.statusChanged': '有差异',
  'modal.syncConflict.more': '…还有 {count} 行',
  'modal.syncConflict.empty': '两侧都没有卡片。',
  'modal.syncConflict.open': '打开副本',
  'modal.syncConflict.remove': '删除副本…',

  // 期 4：归档只读（T4.06，03 §2.5 的 settings.readOnly）
  'command.lockBoard.name': '锁定白板（只读）',
  'command.unlockBoard.name': '解锁白板（恢复可编辑）',
  'menu.canvas.lock': '锁定白板（只读）',
  'menu.canvas.unlock': '解锁白板',
  'board.lockHint': '这块白板已锁定为只读，改动不会被写入。',
  'board.lockHint.unlock': '解锁',
  'board.lockHint.unlockAria': '解锁这块白板，恢复可编辑',
  'notice.boardLocked': '已锁定为只读。解锁之前，这个文件不会被改动。',
  'notice.boardUnlocked': '已解锁，恢复可编辑。',

  // 期 4：整理未使用附件（T4.05 / 03 §4）
  'command.auditAttachments.name': '整理未使用附件',
  'modal.attachmentAudit.title': '无人引用的附件',
  'modal.attachmentAudit.desc':
    '这是一份清单，不是一个清理按钮。插件永远不会替你删除附件 —— 有些引用方式它看不见（笔记正文里的图片、别的插件、纯文本）。逐个打开，自己决定。',
  'modal.attachmentAudit.scope': '扫描范围：{folder}',
  'modal.attachmentAudit.scopeRoot': '整个库',
  'modal.attachmentAudit.summary':
    '共扫到 {total} 个文件 —— 本板在用 {board} 个，别处在用 {elsewhere} 个，无人引用 {unused} 个。',
  'modal.attachmentAudit.none': '没有可整理的：这个目录里每个文件都还被引用着。',
  'modal.attachmentAudit.usedElsewhere':
    '另有 {count} 个文件本板已不再引用、但别处还在用 —— 它们没有列进清单。',
  'modal.attachmentAudit.open': '打开',
  'modal.attachmentAudit.close': '关闭',
  'notice.attachmentAuditEmptyFolder': '附件目录里没有文件（{folder}）。',
  'notice.attachmentAuditBoardUnavailable':
    '这块白板读不出来，已放弃本次整理 —— 此时把本板在用的附件报成"没人引用"是危险的。',
  'notice.attachmentAuditFailed': '整理附件失败：{message}',

  // 期 4：修复引用（T4.07 / 03 §9 R10）
  'command.repairRefs.name': '修复引用',
  'history.repairRefs': '修复引用',
  'modal.repairRefs.title': '可以修复的引用',
  'modal.repairRefs.desc':
    '这些卡片指向的路径已经不存在，但库里有一个文件名对得上的文件。只有下面勾选的条目会被改动 —— 同名档位已经替你勾上，其余都只是猜测。整次修复是一次撤销就能退回的操作。',
  'modal.repairRefs.summary': '可修复 {found} 处；另有 {unmatched} 处对不上。',
  'modal.repairRefs.untitledCard': '未命名卡片',
  'modal.repairRefs.quality.sameName': '同名',
  'modal.repairRefs.quality.sameNameIgnoreCase': '同名（仅大小写不同）',
  'modal.repairRefs.quality.normalizedName': '同名（空格 / 下划线不同）',
  'modal.repairRefs.quality.similarName': '名字相近',
  'modal.repairRefs.alternatives': '另有 {count} 个同名文件',
  'modal.repairRefs.unmatched':
    '另有 {count} 处断链找不到候选 —— 可以在卡片右键菜单里用「重新链接」手工指定。',
  'modal.repairRefs.hint':
    '确认前请对着路径看一眼 —— 插件没有办法判断这个匹配是不是你要的那个文件。',
  'modal.repairRefs.confirm': '修复选中的 {count} 处',
  'modal.repairRefs.cancel': '取消',
  'notice.repairRefsNone': '这块白板没有可修复的断链。',
  'notice.repairRefsUnmatched': '发现 {count} 处断链，但库里没有文件名对得上的文件。',
  'notice.repairRefsDone': '已修复 {count} 处引用。',
  'notice.repairRefsStale':
    '没有改动任何东西 —— 这些引用在这期间已经变过了（被编辑、被重新链接，或者白板被锁上了）。',
  'notice.repairRefsFailed': '修复引用失败：{message}',

  // 期 4：`.canvas` 互转（T4.11 / T4.12 / T4.13 / 03 §7.4）
  'canvas.node.placeholder': '{type}卡片（没有可放进画布的内容）',
  'command.exportCanvas.name': '导出为 Canvas 文件',
  'command.importCanvas.name': '从 Canvas 文件导入白板',

  // 演示模式（J-06 / J-07 —— 不在原排期里，按用户要求插入）
  'command.startPresentation.name': '开始演示',
  'command.endPresentation.name': '退出演示',
  'command.presentNext.name': '演示：下一步',
  'command.presentPrevious.name': '演示：上一步',
  'command.addToPresentation.name': '把选中卡片加入演示路径',
  'command.removeFromPresentation.name': '把选中卡片移出演示路径',
  'command.clearPresentation.name': '清空演示路径',
  // 期 6：自动整理 / 按标签自动分栏（T6.07 / T6.08 / F5-06 / F5-07）
  'command.tidyBoard.name': '自动整理',
  'command.groupByTag.name': '按标签分栏',
  'notice.tidyBoardDone': '已重新排列。',
  'notice.tidyBoardNoChange': '已经很整齐了，无需整理。',
  'notice.groupByTagDone': '已按标签分栏：新建 {created} 个分栏，复用 {reused} 个。',
  'notice.groupByTagNone': '没有哪个标签出现在两张以上未归栏的卡片上。',
  'menu.file.importCanvas': '导入为白板',
  'modal.exportCanvas.title': '导出为 Canvas',
  'modal.exportCanvas.desc':
    '把这块白板另存为一份 JSON Canvas（.canvas）文件。白板本身一个字节都不动；卡片的位置、颜色、连线都会带过去。',
  'modal.exportCanvas.stats': '{cards} 张卡片、{columns} 个分栏、{edges} 条连线',
  'modal.exportCanvas.lossless': '这张画布上的东西都有对应物，不会有损失。',
  'modal.exportCanvas.lossyTitle': '下面这些带不过去：',
  'modal.exportCanvas.degraded': '{count} × {type} → 变成文本节点',
  'modal.exportCanvas.placeholders': '{count} 张卡片没有可导出的文字，只能留一个占位方框',
  'modal.exportCanvas.droppedEdges': '{count} 条连线有一头悬空，Canvas 表达不了',
  'modal.exportCanvas.collapsedColumns': '{count} 个折叠的分栏，对面看到的是展开的',
  'modal.exportCanvas.cosmetic':
    '{count} 处纯外观修饰（强调色条 / 卡片旋转 / 虚线连线 / 智能走线）没有对应物',
  'modal.exportCanvas.target': '导出到白板所在文件夹；同名文件绝不覆盖，会自动顺延命名。',
  'modal.exportCanvas.confirm': '导出',
  'modal.exportCanvas.cancel': '取消',
  'notice.exportCanvasDone': '已导出画布：{path}',
  'notice.exportCanvasFailed': '导出画布失败：{message}',
  'notice.importCanvasNoFiles': '库里没有可导入的 .canvas 文件。',
  'notice.importCanvasDone':
    '已从 Canvas 导入白板：{cards} 张卡片、{columns} 个分栏、{edges} 条连线。',
  'notice.importCanvasPartial':
    '已从 Canvas 导入白板：{cards} 张卡片、{columns} 个分栏、{edges} 条连线；跳过 {nodes} 个认不出的节点、{edges2} 条缺一头的连线。',
  'notice.importCanvasEmpty': '这个 .canvas 里没有能导入的内容。',
  'notice.importCanvasBadJson': '{name} 不是合法的 JSON。',
  'notice.importCanvasBadShape': '{name} 不是 Canvas 文件（缺少 nodes 数组）。',
  'notice.importCanvasFailed': '导入 Canvas 失败：{message}',

  // 期 7：索引笔记（T7.01 / `F10-09` + `F7-09`）
  'settings.section.indexNote': '索引笔记',
  'settings.indexNote.name': '为每块白板维护一份索引笔记',
  'settings.indexNote.desc':
    '默认关闭。打开后，每块白板会多出一个 .md 文件，**每个标签再多一份「枢纽笔记」**（在索引目录的 _tags/ 里）：它们写着这块白板的元信息、便签卡里写过的链接与 #标签 —— 于是这些内容在图谱、**标签面板**、**全局搜索（tag:#标签）**和 Dataview 里都看得见。★ 不开这个开关，白板里的标签对 Obsidian 是不存在的（它从不读 .nboard）。这些文件是生成物：手动改动没有效果，下次保存白板时会被覆盖。',
  'settings.indexNote.folder.name': '索引笔记目录',
  'settings.indexNote.folder.desc':
    '生成的笔记放在这里。目录内部会镜像你库里的层级，所以同名的两块白板不会互相覆盖。',
  'indexNote.warning':
    '由 Nestboard 依据白板「{path}」生成。在这里写下的内容，会在那块白板下次保存时被覆盖。',
  'indexNote.summary': '这块白板有 {cards} 张卡片，最近保存于 {updated}。',
  'indexNote.summaryNoDate': '这块白板有 {cards} 张卡片。',
  'indexNote.summaryNoCards': '这块白板最近保存于 {updated}。',
  'indexNote.openBoard': '打开这块白板',
  'tagHub.warning': '这一页由 Nestboard 自动生成 —— 在这里写的内容会被覆盖。',
  'tagHub.section.boards': '用到这个标签的白板',
  'tagHub.empty': '还没有白板用到这个标签。',
  'indexNote.section.links': '便签里写过的链接',
  'indexNote.section.unresolved': '没对上文件的链接',
  'indexNote.unresolvedHint':
    '这里是特意用纯文本列出的：写成链接会把并不存在的笔记塞进你的图谱。要改请在白板上改。',
  'indexNote.noLinks': '这块白板的便签里还没有写过链接。',
  'command.rebuildIndexNotes.name': '重建索引笔记',
  'command.cleanupIndexNotes.name': '删除索引笔记',
  'notice.indexNoteConflict':
    '已跳过 {path}：同名文件已存在，且不是 Nestboard 生成的，因此一个字都没动它。',
  'notice.indexNoteConflictCount': '有 {count} 份索引笔记因同名文件已存在而被跳过。',
  'notice.indexNoteRebuilt': '已为 {count} 块白板重建索引笔记。',
  'notice.indexNoteCleaned': '已删除 {count} 份索引笔记。',
  'notice.indexNoteCleanupNone': '没有可清理的 —— 一份索引笔记都没找到。',
  'notice.indexNoteDisabled': '索引笔记没打开 —— 请先在设置里打开这一项。',
  'modal.indexNoteCleanup.title': '删除索引笔记？',
  'modal.indexNoteCleanup.body':
    '将删除「{folder}」下 {count} 份生成的索引笔记。白板本身不受影响，文件会进回收站；重新打开这个开关就会再生成一遍。',
  'modal.indexNoteCleanup.confirm': '删除',
  'backlinks.indexNoteHint': '写在便签卡里的链接，不计入图谱，也不计入反链数。',
  'backlinks.indexNoteEnable': '维护一份索引笔记',
};

const DICTIONARIES: Record<Locale, Record<MessageKey, string>> = {
  en,
  'zh-cn': zhCn,
};

/**
 * 用户对界面语言的选择（`F11-13` / T3.23）。
 *
 * ★ `'auto'` 是默认值，也是唯一一个"不是语言"的选项：它表示"跟着 Obsidian 走"。
 *   做成独立字面量而不是"null = 自动"，是为了让 `.data.json` 里存下来的值
 *   与设置面板下拉框的 value 完全一致（`'auto'` 这个词本身可读，手改设置文件也认得出）。
 */
export type LanguagePreference = 'auto' | Locale;

/** 设置面板语言下拉的三档，顺序即展示顺序 */
export const LANGUAGE_CHOICES: readonly LanguagePreference[] = ['auto', 'zh-cn', 'en'];

/**
 * 把「偏好 + 宿主语言」解析成真正生效的语言。**纯函数**，因此可单测（T3.23）。
 *
 * 宿主语言的来源是 Obsidian 写进 `localStorage.language` 的值（如 `zh`、`zh-TW`、
 * `en`、`ja`…）。本插件只有两份包，所以做「中文 → zh-cn，其余 → en」的映射：
 *  * `zh` / `zh-cn` / `zh-hans` / `zh-TW` 都归到 `zh-cn` —— 繁体用户看简体，
 *    比看英文更接近他要的信息；
 *  * 日文、韩文等目前没有翻译，一律回落 `en`。
 *
 * ★ 大小写与地区码都在这里抹平（`toLowerCase` + 前缀判断），
 *   调用方不必先做一遍规范化；也让"偏好不是 auto 就一定赢"这条规则只有一处。
 */
export function resolveLocale(preference: LanguagePreference, hostLanguage: string | null): Locale {
  if (preference !== 'auto') return preference;
  if (!hostLanguage) return 'en';
  return hostLanguage.toLowerCase().startsWith('zh') ? 'zh-cn' : 'en';
}

/**
 * 宿主语言（由 `main.ts` 注入）。
 *
 * ★ 从前这里是 `window.localStorage.getItem('language')` —— 那是 Obsidian 自己写进
 *   localStorage 的键。社区审核要求改用官方 `getLanguage()`（Obsidian 1.8.7 起才有），
 *   而本文件**不得 import obsidian**（见文件头），所以改成「由 `main.ts` 读、往这里塞」：
 *   纯逻辑留在这边可单测，碰 Obsidian 的那一下留在入口。
 */
let hostLanguage: string | null = null;

/** `main.ts` 在启动 / 设置变更时调用：把 `getLanguage()` 的结果交给 i18n */
export function setHostLanguage(language: string | null): void {
  hostLanguage = language;
}

/** 读宿主语言（`resolveLocale` / `setLocale('auto')` 用）：见 `setHostLanguage` */
export function detectHostLanguage(): string | null {
  return hostLanguage;
}

/** 等价于"按宿主语言自动检测"（T1.06 起的旧名字，保留以防外部引用） */
export function detectLocale(): Locale {
  return resolveLocale('auto', detectHostLanguage());
}

let currentLocale: Locale = detectLocale();

/**
 * 设置生效语言（T3.23）。
 *
 * ★ 传 `'auto'` 就**现场重新检测**一次宿主语言 —— 用户在 Obsidian 里把界面切成中文，
 *   下次打开插件立刻跟着变，不需要重启。
 * ★ 返回真正生效的 `Locale`：`main.ts` 用它判断"要不要重画已打开的视图"。
 */
export function setLocale(preference: LanguagePreference): Locale {
  currentLocale = resolveLocale(preference, detectHostLanguage());
  return currentLocale;
}

export function getLocale(): Locale {
  return currentLocale;
}

/**
 * 取文案。`{name}` 占位符用 params 替换。
 * 未知键返回键名本身 —— 宁可界面上出现 `notice.foo`，也不要 throw 崩掉视图。
 */
export function t(key: MessageKey, params?: Record<string, string | number>): string {
  const dict = DICTIONARIES[currentLocale] ?? DICTIONARIES.en;
  const template = dict[key] ?? en[key] ?? key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
  );
}
