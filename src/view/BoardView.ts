/**
 * 白板视图（T1.23，F7-01）—— 从 `.nboard` 文件到一块可平移缩放的画布。
 *
 * 本视图负责把"文件 + 视口 + 各渲染层"装配到一起，具体能力都下放给子模块：
 * * 打开 / 切换 `.nboard` 文件（`FileView` 的 `onLoadFile` 钩子）；
 * * 无限画布 + 平移缩放（T1.19 / T1.20，交给 `NavigationController`）；
 * * 背景渲染（T1.21，交给 `BackgroundLayer`）；
 * * 卡片渲染 + 裁剪 + DOM 复用（T1.24–T1.26，交给 `CardLayer`）；
 * * 卡片内容 / 显示-编辑态（T1.32，交给 `cards/` 注册表 + 本视图注入的渲染上下文）；
 * * 连线 / 覆盖两层画布（T1.27 / T1.28，交给 `EdgeLayer` / `OverlayLayer`）；
 * * 指针状态与选区（T1.29 / T1.31，交给 `PointerStateMachine` / `SelectionModel`）；
 * * 视口记忆（T1.22：写回 `view` 字段但**不递增 revision**，W3）；
 * * 打开失败 / 保护态时给出可见的占位说明，**绝不白屏**。
 *
 * 图层从上到下（02 §2）：OverlayLayer → 卡片层 → EdgeLayer → 背景层。
 *
 * ★ 三条数据 → 渲染的路径，别混：
 *   1. 视口变化 → `Viewport.onChange` → `syncCanvas()`（**不发 `changed`**，W3）；
 *   2. 内容变化 → `repository.on('changed'/'reloaded')` → `applyBoard()` → 重新取数；
 *   3. 容器尺寸变化 → `ResizeObserver` → `measure()` + `syncCanvas()`（裁剪需要新尺寸）。
 *
 * ★ 生命周期陷阱：Obsidian 会**复用**视图实例（同一个 leaf 从 A.nboard 切到 B.nboard
 *   时不会重建视图），所以 `onLoadFile` 前必须先把旧板的订阅摘干净（`detachBoard`）。
 *   反之 `onOpen` / `onLoadFile` 的先后顺序官方未承诺，因此用 `ensureCanvas()` 兜底：
 *   谁先到谁建 DOM，另一个成为空操作 —— 避免"后到的把先渲染好的内容清空"。
 */

import {
  Component,
  FileView,
  MarkdownRenderer,
  Notice,
  Platform,
  TFile,
  TFolder,
  setIcon,
} from 'obsidian';
// `Menu` 只在类型位置出现（`onPaneMenu` 的签名；脑图卡的节点菜单走
// `showMenuAtMouse`，`Menu` 由 `ui/ContextMenus` 建）⇒ 类型导入就够
import type { Menu, WorkspaceLeaf } from 'obsidian';
import { boardRefPreviewSize, boardTitleOf } from '../cards/boardRef';
// 脑图卡（`F3a` / `F4`）："加完节点立刻让我打字"——节点菜单在视图这一层，
// 卡内编辑器在卡片那一层，两边靠这一个请求槽对接（见 `mind/embed/editRequest.ts`）
import { requestMindEdit, takeMindEdit } from '../mind/embed/editRequest';
// 脑图（`F3a`）：白板里的脑图卡直接读写 `.nestmind` —— 模型操作（加节点 / 删除 / 折叠）
// 与"打开那份脑图"都住在脑图那一侧，这一层只做接线
import { mindEditKeyOf } from '../mind/embed/MindBridge';
import type {
  MindBridge,
  MindInlineSource,
  MindNodeFocus,
  MindNodeMenuRequest,
} from '../mind/embed/MindBridge';
// `F4` 起卡内节点也能从底部那条栏改格式：那几个操作与右键菜单共用同一批 `ops`
// ★ 节点那颗标记也叫 `setIcon`，与 `obsidian` 的同名函数撞名 —— 这里**改名导入**，
//   obsidian 那个（往按钮里画图标）在本文件里用得很多，改它反而更贵
import {
  addChild,
  addSibling,
  depthOf,
  neighborByArrow,
  promote,
  removeNodes,
  rootTextOf,
  setCollapsed,
  setIcon as setMindNodeIcon,
  setNodeStyle,
} from '../mind/model/ops';
// ★ 卡内节点的**键位表**（`2.2.0` 收尾 · 用户 2026-09-23："nestmind 里面的操作搬过来就行"）。
//   纯函数（给一个键盘事件，回答"该做什么"）⇒ 白板不抄一份"哪个键干什么"，
//   于是两个宿主上的 Tab / 回车 / 方向键**永远不会长歪**。
import { mindKeyActionOf } from '../mind/view/keys';
import { directionForStructure } from '../mind/layout/tree';
import type { MindStylePatch } from '../mind/model/ops';
// ★ 节点剪贴板（`2.2.0` 收尾 · 用户 2026-09-23）：节点复制粘贴走脑图自己那一份格式，
//   与 `.nestmind` 视图**同一个模块**读写（认亲 / 双行李只有一处实现）
import {
  clipboardLabelOf,
  getMindClipboard,
  pasteForest,
  type MindClipboard,
} from '../mind/model/clipboard';
import { nodeClipboardOf, writeMindClipboard } from '../mind/view/systemClipboard';
import { titleBoldOf } from '../mind/model/palette';
// 节点上的图片附件要和图片卡一起预加载（导出用）
import { firstRefOf } from '../mind/model/refs';
import type { MindFile, MindNode } from '../mind/model/schema';
// 内嵌脑图卡的「导出为 `.nestmind`」（`F4`）：落盘在脑图那一侧（目录 / 重名顺延 / 序列化）
import { writeMindToVault } from '../mind/io/newMind';
import { openMindView } from '../mind/view/host';
import { cardIconOf } from '../cards/cardIcon';
import { normalizeImageCardColor } from '../cards/image';
import { normalizeVideoCardColor } from '../cards/video';
import { normalizeAudioCardColor } from '../cards/audio';
import { BoardPickerModal } from '../ui/modals/BoardPickerModal';
import { EdgeLabelModal } from '../ui/modals/EdgeLabelModal';
import { IconPickerModal } from '../ui/modals/IconPickerModal';
import { LinkPromptModal } from '../ui/modals/LinkPromptModal';
import { NoteRefTargetModal } from '../ui/modals/NoteRefTargetModal';
import { VaultFilePickerModal } from '../ui/modals/VaultFilePickerModal';
import { Toolbar, type ToolbarItem } from '../ui/Toolbar';
// 快捷操作栏（`O38`）：与脑图节点共用同一份实现，这里只负责"改的是哪张卡"
import { buildNodeToolbar, type NodeToolbar, type QuickBarFeature } from '../ui/QuickBar';
import { repinMiniBoardRefs, updateCardLook } from '../model/ops';
import { Minimap } from '../ui/MinimapPanel';
import { minimapShapes } from '../ui/minimapGeometry';
import { LongPressDetector } from './interact/longPress';
import { boardAriaLabel, canvasA11yHint, cardA11yHint, cardAriaLabel } from './a11y';
import {
  DESKTOP_PROFILE,
  deviceTierOf,
  perfProfileFor,
  readDeviceHints,
  type PerfProfile,
} from './perfProfile';
import { applyCardStyleVariables } from './themeVars';
import { annotationsOn, inkCardFromStroke, inkCardStrokeHits, recolorPaths } from '../cards/ink';
import { LINK_DEFAULT_SIZE, LINK_MINI_SIZE, fetchLinkPreview } from '../cards/link';
import { listNoteRefAnchors } from '../cards/noteRef';
import { createCardRegistry } from '../cards/registry';
import { swatchColorsAfterPick } from '../cards/swatch';
import { toggleTodoItem } from '../cards/todo';
import type {
  BacklinkBridge,
  BoardNavBridge,
  BoardSummary,
  CardActionContext,
  CardMenuItemKey,
  CardRenderContext,
  CardViewMode,
  ClipboardBridge,
  EditEntry,
  LinkPreviewBridge,
  MapTileBridge,
  PixelSamplerBridge,
  ShellBridge,
  VaultBridge,
} from '../cards/registry';
import {
  BOARD_EXT,
  CANVAS_EXT,
  DUPLICATE_OFFSET,
  ID_PREFIX,
  RESIZE_HANDLE_ATTR,
  ROTATE_HANDLE_ATTR,
  VIEW_TYPE_BOARD,
  cardDisplayHeight,
  MIND_CONTAINER_ID_ATTR,
} from '../constants';
import { unsortedDropPoint } from '../io/homeBoard';
import { serializeBoard } from '../io/BoardRepository';
import { createBoardInVault } from '../io/newBoard';
import { applyRefRepairs, planRefRepairs, type RefRepair } from '../io/refRepair';
import { DragDropBridge } from '../integration/DragDropBridge';
import { attachMarkdownLinkHandler } from '../integration/markdownLinks';
import type { DragDropPreview, DragPreviewItem } from '../integration/DragDropBridge';
import { ObsidianClipboardBridge } from '../integration/ObsidianClipboardBridge';
import { ObsidianLinkBridge } from '../integration/ObsidianLinkBridge';
import { ObsidianLinkPreviewBridge } from '../integration/ObsidianLinkPreviewBridge';
import { ObsidianMapTileBridge } from '../integration/ObsidianMapTileBridge';
import { ObsidianPixelSampler } from '../integration/ObsidianPixelSampler';
import { ObsidianBoardThumbnailBridge } from '../integration/ObsidianBoardThumbnailBridge';
import { ObsidianShellBridge } from '../integration/ObsidianShellBridge';
import { ObsidianThumbnailBridge } from '../integration/ObsidianThumbnailBridge';
import { buildNestboardUri } from '../integration/ProtocolHandler';
import { resolveFileInVault } from '../integration/vaultPath';
import {
  NotePromoter,
  boardFolderOf,
  noteNameFrom,
  promotedCard,
} from '../integration/NotePromoter';
import { MarkdownExporter, boardNameOf } from '../export/MarkdownExporter';
import { planCanvasExport } from '../export/jsonCanvas';
import { exportBoardToMarkdown } from '../export/toMarkdown';
import {
  PngExporter,
  canvasToArrayBuffer,
  planPngExport,
  readPngPalette,
  renderTile,
  resolveExportBounds,
} from '../export/toPng';
import type { PngPlan } from '../export/toPng';
import { SvgExporter, planSvgExport, renderBoardSvg } from '../export/toSvg';
import type { SvgPlan } from '../export/toSvg';
import { ZipExporter, planZipExport } from '../export/toZip';
import type { ZipPlan } from '../export/toZip';
import {
  PdfExporter,
  buildPdf,
  canvasToJpeg,
  drawPageFooter,
  planPdfExport,
} from '../export/toPdf';
import type { PdfPageImage, PdfPlan } from '../export/toPdf';
import {
  DEFAULT_PRINT_QUALITY,
  PRINT_CLEANUP_MS,
  PRINT_LOAD_TIMEOUT_MS,
  buildPrintDocument,
  planPrintExport,
  posterHint,
} from '../export/toPrint';
import type { PrintPageImage } from '../export/toPrint';
import { CropImageModal } from '../ui/modals/CropImageModal';
import { DiagnosticsModal } from '../ui/modals/DiagnosticsModal';
import { ExportCanvasModal } from '../ui/modals/ExportCanvasModal';
import { ExportPdfModal } from '../ui/modals/ExportPdfModal';
import type { PdfExportRequest, PdfPlanSummary } from '../ui/modals/ExportPdfModal';
import { ExportPngModal } from '../ui/modals/ExportPngModal';
import type { PngExportRequest, PngPlanSummary } from '../ui/modals/ExportPngModal';
import { ExportSvgModal } from '../ui/modals/ExportSvgModal';
import type { SvgExportRequest, SvgPlanSummary } from '../ui/modals/ExportSvgModal';
import { ExportZipModal } from '../ui/modals/ExportZipModal';
import { ExportPrintModal } from '../ui/modals/ExportPrintModal';
import type { PrintExportRequest, PrintPlanSummary } from '../ui/modals/ExportPrintModal';
import { RefRepairModal } from '../ui/modals/RefRepairModal';
import { RenameBoardModal } from '../ui/modals/RenameBoardModal';
import { SplitBoardModal } from '../ui/modals/SplitBoardModal';
import {
  COLUMN_LAYOUT,
  alignSiblingColumns,
  applyColumnRects,
  cardsInColumn,
  collapsedColumnCardIds,
  columnById,
  columnContentHeight,
  columnDisplayHeight,
  columnMoveRects,
  columnResizeRects,
  createColumnAt,
  detachCards,
  findDropTarget,
  growColumnToFit,
  groupIntoNewColumn,
  insertCardsIntoColumn,
  relayoutColumns,
  removeColumn,
  setColumnCollapsed,
  setColumnTitle,
  shrinkColumnToFit,
  siblingColumnsOf,
  splitIntoColumns,
  type ColumnDropTarget,
  type ColumnRect,
} from '../model/columns';
import {
  clampColumnScroll,
  columnScrollView,
  columnViewport,
  scrolledRect,
  type ColumnScrollView,
} from '../model/columnScroll';
import { cropEquals } from '../model/crop';
import {
  AUDIO_EXTENSIONS,
  IMAGE_EXTENSIONS,
  VIDEO_EXTENSIONS,
  cardsForDropPaths,
  cascadeOrigins,
  dropHintKey,
  mindsForDropPaths,
  noteCardForDropText,
  resolveDropText,
} from '../model/drop';
// 拖出导出（T6.10 / F6-04）：落点判定是纯逻辑，DOM 与写盘留在本视图与 `integration/`
import { DROP_OUT_HIGHLIGHT_CLASS, noteMarkdownOf } from '../model/dragOut';
import { CardDragOut } from '../integration/CardDragOut';
import {
  addEdges,
  edgeById,
  edgeEndpoints,
  edgesIntersecting,
  hitTestEdge,
  normalizeEdgeCurve,
  removeEdges,
  setEdgeEndpoint,
  updateEdges,
} from '../model/edges';
import type {
  AnchorSide,
  EdgeEndpoints,
  EdgeHitOptions,
  EdgePatch,
  RectLookup,
} from '../model/edges';
import {
  DEFAULT_CARD_SIZES,
  createCard,
  createEdge,
  createMind,
  newMindModel,
} from '../model/factories';
import { HistoryStack, restoreContent, serializeContent } from '../model/history';
import {
  MIN_GROUP_SIZE,
  addCards,
  alignCards,
  applyCardRotations,
  applyCardRects,
  bringToFront,
  collapsedCardIds,
  collapsedGroupColumnIds,
  distributeCards,
  duplicateCards,
  expandGroupSelection,
  groupById,
  groupMembers,
  groupOfCard,
  groupOfColumn,
  // 白板级脑图（`2.2.0`）：挪位置 / 换模型 / 进白板 —— 树内部的编辑在 `mind/model/ops`
  addMind,
  cloneJson,
  duplicateMinds,
  moveMind,
  patchSyncGroup,
  removeCards,
  removeMinds,
  removeMindNodes,
  sendToBack,
  setGroupCollapsed,
  setGroupLabel,
  setMindModel,
  translateCards,
  ungroupMembers,
  updateCards,
  updateColumns,
  type AlignMode,
  type CardPatch,
  type CardRect,
  type DistributeAxis,
} from '../model/ops';
import {
  buildCardTransfer,
  buildNodeClipboard,
  parseCardTransfer,
  pasteCardTransfer,
  type CardTransfer,
} from '../model/transfer';
import {
  GUIDE_THRESHOLD_PX,
  normalizeGridSize,
  type AlignConfig,
  type GridSnapConfig,
  type SmartGuides,
} from '../model/snapping';
import { defaultInkToolState } from '../model/ink';
import type { InkTool, InkToolState } from '../model/ink';
import type {
  BoardFile,
  BoardRefPreview,
  Card,
  CardContentOf,
  CardType,
  Column,
  Edge,
  CardColor,
  EdgeCurve,
  HexColor,
  InkPath,
  Mind,
  NoteVariant,
  ThemeColor,
} from '../model/schema';
import {
  endpointOfKey,
  isThemeColor,
  nodeEndpointKey,
  splitEndpointKey,
  type EdgeEndpoint,
} from '../model/schema';
import {
  SPLIT_MIN_GROUPS,
  applySplitToSource,
  buildSplitChildBoard,
  splitBoardPlan,
  splitGroupCount,
  type SplitBoardPlan,
  type SplitChild,
  type SplitMove,
} from '../model/split';
import {
  NO_FILTER,
  dimmedMindNodeKeys,
  filteredOutIds,
  matchedCount,
  type CardFilter,
} from '../model/filter';
// 整理类（T6.07 / T6.08 / F5-06 / F5-07）：模型层负责几何，视图只接命令与历史
import { columnsByTag, tidyBoard as tidyBoardModel, type TagColumnsResult } from '../model/arrange';
import { brokenRefsOf, refExistsInVault, type CardRef } from '../model/links';
import type { OpenTodoEntry } from '../model/todos';
import {
  addToPresentation,
  clearPresentSteps,
  explicitPresentSteps,
  movePresentStep,
  presentStepOf,
  removeFromPresentation,
} from '../model/presentation';
import { describeError } from '../util/errors';
import { normalizeIcon } from '../util/emoji';
import { joinPath, sanitizeFileName, splitName, uniquePath } from '../util/fileName';
import { FrameQueue } from '../util/frame';
import {
  boundsOf,
  rectContainsPoint,
  rectsIntersect,
  rotatedBoundsOf,
  roundTo,
  type Point,
  type Rect,
  type Size,
} from '../util/geometry';
import { t, type MessageKey } from '../util/i18n';
import { createId } from '../util/id';
// 撞色标题带的墨色（`O38`）：主题色 → 具体色号 → 按对比度挑深/浅，都在这一份里
import { THEME_COLOR_VAR, normalizeHex, swatchInkColor } from '../util/color';
import { normalizeUrl } from '../util/linkPreview';
import { coordsText, parseMapLink, staticMapRequest } from '../util/mapUrl';
import type { MapLink } from '../util/mapUrl';
import { Breadcrumb } from '../ui/Breadcrumb';
import type { TrailNode } from '../ui/Breadcrumb';
import { appendMenuItems, pickColor, showMenuAtMouse, showMenuAtPoint } from '../ui/ContextMenus';
// 几何命中（`B2`）：搬进白板卡时要判"松手那一刻压在哪张卡上"（带旋转反算、z 最大者胜）
import { hitTest } from './interact/HitTest';
// 卡片 DOM 的 id 属性名：目标高亮要按它找那张卡的 DOM 外壳（与 `HitTest` 的委托同一个属性）
import { CARD_ID_ATTR, VIEW_TYPE_CARD_INSPECTOR } from '../constants';
// 卡片属性面板（`B1`）：住在右侧边栏，本视图负责把它打开并代它写回
import { CardInspectorPanelView } from '../ui/CardInspectorPanel';
import { InkBar } from '../ui/InkBar';
import { CardFilterBar } from '../ui/CardFilterBar';
import { openHomeBoard } from '../ui/homeActions';
import { LinkOverview } from '../ui/LinkOverview';
import { SearchPanel } from '../ui/SearchPanel';
import { TodoOverview } from '../ui/TodoOverview';
import { openSaveTemplateDialog } from '../ui/templateActions';
import { scaleAdviceOf, scaleHintKey, type ScaleAdvice } from './scale';
import {
  buildCanvasMenuSpec,
  buildMindMenuSpec,
  buildCardMenuSpec,
  buildColumnMenuSpec,
  buildEdgeMenuSpec,
  buildPresentationMenuSpec,
} from './interact/cardMenu';
import type { CardMenuActions, MenuItemSpec } from './interact/cardMenu';
import { viewMenuItems as buildViewMenuItems } from './interact/viewMenu';
import type { ViewMenuActions } from './interact/viewMenu';
import {
  DRAG_THRESHOLD_PX,
  DragController,
  nudgeDelta,
  resizedRect,
  type DragKind,
  type DragStart,
} from './interact/DragController';
import { BackgroundLayer } from './render/BackgroundLayer';
import { CardLayer, RESIZE_HANDLES } from './render/CardLayer';
import type { ResizeHandle } from './render/CardLayer';
// 白板级脑图那一层（`2.2.0`）：与卡片层平级 —— 画的是"长在画布上的树"，不是卡里的内容
import { MindLayer } from './render/MindLayer';
import { ColumnLayer, columnRect, type ColumnGesture } from './render/ColumnLayer';
import { GroupLayer } from './render/GroupLayer';
import { EdgeLayer } from './render/EdgeLayer';
import { InkLayer } from './render/InkLayer';
import { createEdgePainter } from './render/EdgeRenderer';
import { OverlayLayer } from './render/OverlayLayer';
import { ConnectController } from './interact/ConnectController';
import { TreeLinkController } from './interact/TreeLinkController';
import {
  collapsedTreeCardIds,
  linkTreeParent,
  setTreeCollapsed,
  treeChildrenIds,
  treeHiddenCountOf,
  treeLinkState,
  treeParentOf,
  unlinkTreeParent,
} from '../model/tree';
import { EdgeCurveController } from './interact/EdgeCurveController';
import {
  CardEventDelegate,
  isInsideColumn,
  resolveCardElement,
  resolveCardId,
} from './interact/HitTest';
import type { CardPointerDetail } from './interact/HitTest';
import { EyedropperSession } from './interact/eyedropper';
import type { EyedropperMiss, EyedropperSource } from './interact/eyedropper';
import { InkController } from './interact/InkController';
import { MarqueeController, SelectionModel } from './interact/MarqueeController';
import { NavigationController } from '../canvas/NavigationController';
import { PointerStateMachine } from './interact/PointerStateMachine';
import { formatBytes, formatDiagnostics, type DiagnosticsRow } from './diagnostics';
import { PresentationController } from './PresentationController';
import { MAX_ZOOM, MIN_ZOOM, Viewport } from '../canvas/Viewport';
import type NestboardPlugin from '../main';

/**
 * 没取到颜色时说什么（T3.05）。
 *
 * ★ 四种原因**分开说**：用户需要知道下一步该改什么（换一张图 / 点图上别的位置 /
 *   换一张不透明的图 / 换个环境）。一句笼统的"取色失败"帮不上忙，
 *   用户只会再点一遍同一格，然后得出"这功能是坏的"。
 */
const EYEDROPPER_MISS_KEY: Record<EyedropperMiss, MessageKey> = {
  notImage: 'notice.swatchNeedImage',
  outside: 'notice.swatchOutside',
  noColor: 'notice.swatchNoColor',
  unavailable: 'notice.swatchUnavailable',
};

/**
 * 便签那条快捷操作栏都有哪几个按钮（`O38`）：标记 / 粗 / 斜 / 下划线 / 字色 / 底色 / 编辑内容。
 *
 * ★ **不画**「插入图片」（用户 2026-09-16："拆入图片按钮先不做"）—— 不画而不是置灰：
 *   置灰是"这件事现在不能做"，不画是"这张卡上没有这件事"（摆一个永远灰着的按钮，
 *   用户只会以为它坏了）。
 * ★ 与脑图那条栏的差别只有这一点：内容上它们逐个对应同一件事（`ui/QuickBar` 一份实现）。
 */
const NOTE_BAR_FEATURES: ReadonlySet<QuickBarFeature> = new Set<QuickBarFeature>([
  'icon',
  'bold',
  'italic',
  'underline',
  'ink',
  'color',
  'editNote',
]);

/**
 * 哪些类型的卡片：**双击标题行 = 就地改标题**（`F5`，用户 2026-09-21）。
 *
 * ★ 这一条是"标题编辑与内容编辑分家"的配套：便签 / 同步便签的内容编辑态里**没有**标题格
 *   （与引用卡——`.md` 文档节点——同款，见 `cards/note.ts` 文件头），于是"卡面那一行字"
 *   必须自己接住双击 —— 否则鼠标用户改名字就只剩右键菜单一条路。
 * ★ 名单为什么只有这两类：
 *   * 引用卡 / 文件卡 / 白板卡：标题取自文件（`titleFilePath`），双击另有语义（打开源），
 *     改标题一直是右键「编辑标题」那一项；
 *   * 仅标题卡：整张卡就是那一行字（`content.text`），双击进它自己的编辑态 ——
 *     改的不是 `card.title`，把它算进来会让双击"看着没反应"（写了另一个字段）。
 */
const TITLE_BAND_DOUBLE_CLICK_TYPES: ReadonlySet<CardType> = new Set<CardType>([
  'note',
  'syncNote',
]);

/**
 * 白板卡那条栏（`O38`）：**标记 / 卡片颜色 / 编辑标题**（用户 2026-09-16 指定的三项）。
 *
 * ★ 没有粗 / 斜 / 下划线 / 字色：白板卡**只有一行名字**（在卡外），
 *   没有"标题整条格式"这套语义。
 * ★ 「编辑标题」与右键菜单那一项同一个入口（`editCardTitle`）：就地改名、连子板文件一起改（`O37`）。
 */
const BOARD_REF_BAR_FEATURES: ReadonlySet<QuickBarFeature> = new Set<QuickBarFeature>([
  'icon',
  'color',
  'editNote',
]);

/**
 * 仅标题卡那条栏（`A3`，用户 2026-09-18："和便签卡一样要有快捷操作栏。当然，不需要编辑内容"）：
 * 标记 / 粗 / 斜 / 下划线 / 字色 / 底色 —— **就是便签那一套去掉「编辑内容」**
 * （这行字双击就能改，不必再给一个"编辑内容"的入口）。
 *
 * ★ 这几项在这张卡上**真的生效**：`card.icon` 画在文字前面，
 *   `card.titleStyle` 的粗 / 斜 / 下划线 / 字色写在那一行上
 *   （见 `cards/titleCard.ts`）—— 存得进去也要看得见。
 */
const TITLE_CARD_BAR_FEATURES: ReadonlySet<QuickBarFeature> = new Set<QuickBarFeature>([
  'icon',
  'bold',
  'italic',
  'underline',
  'ink',
  'color',
]);

/**
 * **卡内脑图节点**那条栏（`F4`，用户 2026-09-21："点击脑图节点，在画布上，底部也可以出现
 * 对应节点的快捷操作栏"）。
 *
 * 与标签页里那条（`MindView` 的 `ALL_FEATURES`）逐项对齐：标记 / 粗 / 斜 / 下划线 /
 * 字色 / 高亮 / **节点底色**。
 *
 * ★ 少了三样，都是**卡面这一层还没有对应编辑器**，不是"忘了"：
 *   * `editNote`（编辑备注）：卡内没有备注编辑器（标签页里那个是 `MindView.beginNoteEdit`）；
 *   * `insertImage`（给节点挂附件）：要弹库内文件选择器 + 写 `node.refs`，还没接；
 *   * `link`（节点之间的关联线）：那条线是**脑图画布自己**画的（`MindView` 的 link 会话），
 *     卡内那套渲染里没有它 —— 接上去要么画不成、要么画在卡片里看不见。
 *   这三样与"卡片级别的连线"（下一步做的节点↔白板连线）是两回事，别混。
 */
const MIND_NODE_BAR_FEATURES: ReadonlySet<QuickBarFeature> = new Set<QuickBarFeature>([
  'icon',
  'bold',
  'italic',
  'underline',
  'ink',
  'highlight',
  'color',
]);

/**
 * 对齐的默认键（T3.13 / `F5-04`）：`⌥⌘` + 四向箭头，与 `04 §4` 的键位表一致。
 *
 * ★ 只在**画布持有焦点**时于 `onCanvasKeyDown` 里处理，不在命令层声明默认热键 ——
 *   与分栏那几条同一条理由：同一个按键不能走两遍（见 `commands.ts` 的说明）。
 *   居中（`centerX`/`centerY`）与两项"分布"不给默认键，留给右键菜单与命令面板。
 */
const ALIGN_HOTKEYS: Record<string, AlignMode | undefined> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'top',
  ArrowDown: 'bottom',
};

/**
 * 属于任一编组的卡片 id（T3.14 的视觉标记用）。
 *
 * ★ 编组不改几何、也没有存进 `Card`：`board.groups` 才是唯一事实来源，
 *   所以每帧现算一次"哪些卡在组里"比维护一份会飘的镜像稳。
 */
function groupedCardIdsOf(board: BoardFile): Set<string> {
  const ids = new Set<string>();
  for (const group of board.groups) for (const id of group.cardIds) ids.add(id);
  return ids;
}

/**
 * 视图实例序号（T3.26）。
 *
 * `aria-describedby` 指向的提示节点需要一个 `id`，而**同一块白板可以被拆成两个标签**
 * （同一个 `Leaf` 内容也能被复制到新窗口）—— 写死一个 `id` 会让第二块白板的提示
 * 指向第一块的节点，甚至两处都念错。序号跟着实例走，天然不会撞。
 */
let viewInstanceSeq = 0;

export class BoardView extends FileView {
  private readonly plugin: NestboardPlugin;
  private readonly viewport = new Viewport();
  /** 指针状态机（T1.29）：决定"这个按键/这次按下归谁" */
  private readonly pointerState = new PointerStateMachine();
  /** 选区（T1.31）：界面状态，不进模型、不落盘 */
  private readonly selection = new SelectionModel();
  /** 卡片类型注册表（T1.32）：新增一种卡片 = 新增一个文件 + 在这里注册一行 */
  private readonly cardRegistry = createCardRegistry();
  /** 内容槽元素 → 挂在它上面的卡片级组件（Markdown 内嵌），换内容 / 回收节点时卸载 */
  private readonly cardComponents = new WeakMap<HTMLElement, Component>();

  private background: BackgroundLayer | null = null;
  private cardLayer: CardLayer | null = null;
  /**
   * 白板级脑图那一层（`2.2.0`）：与卡片层平级，画的是"长在画布上的树"。
   *
   * ★ 它不是"某张卡的渲染器"：容器没有宽高、不裁剪、不缩放（见 `MindLayer` 文件头）。
   */
  private mindLayer: MindLayer | null = null;
  private columnLayer: ColumnLayer | null = null;
  /**
   * 编组层（O03）：组的包围框 + 标签条（收起 / 展开 / 改名）。
   *
   * ★ 它是**渲染**层，不是状态层：`collapsed` 住在模型里、隐藏与否由卡片层执行，
   *   本层只负责"把这件事画出来并给出一个能点的开关"。
   */
  private groupLayer: GroupLayer | null = null;
  private edgeLayer: EdgeLayer | null = null;
  /**
   * 手绘层（T3.06）：Canvas，画在**卡片之上**（`02 §2` 层级④）。
   *
   * ★ T3.08 之后它只画"正在画的那一笔"：抬笔即落盘成一张 `ink` 卡片
   *   （`persistInkStroke`），所以换板不必再"清空笔迹" —— 笔迹已经住在板子里了。
   */
  private inkLayer: InkLayer | null = null;
  /** 手绘控制器（T3.06）：代收指针、守住"一次一笔"、掌着笔的样式。见 `ensureCanvas` 的装配顺序说明 */
  private inkController: InkController | null = null;
  /**
   * 手绘工具条（T3.07 / `F4-02`）：颜色 + 4 档笔宽，只在**画笔态**显示。
   *
   * ★ 它挂在覆盖层 HUD 里（画布内部），所以 DOM 生命周期跟着画布走，
   *   而显隐跟着手绘态走 —— 两件事分属两个所有者，见 `onInkEnter` / `detachBoard`。
   */
  private inkBar: InkBar | null = null;
  private overlayLayer: OverlayLayer | null = null;
  private marqueeController: MarqueeController | null = null;
  /**
   * 这一次**装载之后**，画布上真的按下过吗（`pointerdown`）。
   *
   * ★★ 挡的是用户 2026-09-17 报的那一条："我每次点开一个子白板，就会帮我创建一个便签。"
   *   机制：白板卡的双击**先被卡片委托接走**（它的监听器注册得更早）⇒ `openNestedBoard`
   *   当场把视图切到子板 ⇒ 紧接着视图自己的 `dblclick` 监听器开跑，而此刻
   *   `event.target` 已经是**被摘离画布的旧卡**（`resolveCardElement` 因此认不出它，
   *   那句"点在卡片上就跳过"失效）⇒ 一路走到"空白处双击 = 就地新建便签"。
   *   ⇒ 判据改成"这一下双击，画布必须见过它对应的**按下**"：换板时这个标记会被清掉，
   *     而真正由用户点在（新）画布上的双击，它的 `pointerdown` 一定先到（见
   *     `onCanvasPointerDown`）—— 与"浏览器按时间 + 位置配对、不管元素"这件事解耦。
   */
  private canvasPressSeen = false;
  /** 连线手势（T1.68）：从卡片锚点拖出、落到目标卡。锚点 DOM 由它自己持有并复用 */
  private connectController: ConnectController | null = null;
  /** 树连线手势（`F7`）：与普通连线同构、目标是"父→子"的树关系 */
  private treeLinkController: TreeLinkController | null = null;
  /**
   * 连线弧度手柄（T7.12 / `F3-07`）：单选一条 Free 线时在中点浮出一个小圆点。
   *
   * ★ 与 `connectController` 同一条生命周期纪律：`buildCanvas` 里建、
   *   `teardownCanvas` 里 `dispose()` —— 它持有一个常驻 DOM 节点和一批监听器。
   */
  private edgeCurveController: EdgeCurveController | null = null;
  private cardDelegate: CardEventDelegate | null = null;
  /**
   * 演示模式（J-06 / J-07）：进出、步骤导航、相机飞行、当前卡高亮都归它。
   *
   * ★ 与画布同生命周期：`buildCanvas` 里建、`teardownCanvas` 里 `dispose`。
   *   它持有步骤条 DOM 与 `requestAnimationFrame` 句柄 —— 跨视图留着，
   *   就成了"看不见但还在跑"的定时器。
   */
  private presentation: PresentationController | null = null;
  /** 拖动 / 缩放控制器（T1.35–T1.37）：拖动中只写 DOM，松手提交一次 */
  private dragController: DragController | null = null;
  /** 撤销栈（T1.48）。白板级：换板时清空 —— 快照指向的是上一块板的内容 */
  private readonly history = new HistoryStack();
  /**
   * 正在应用历史快照。期间产生的一切 `mutate` 都**不再记历史**，
   * 否则 `⌘Z` 会把"撤销"这个动作本身也记成一步，用户按第二次就回到撤销前 —— 死循环。
   */
  private applyingHistory = false;
  /** 画布级监听器（空白处双击 / 右键），`teardownCanvas` 要按它摘干净 */
  private readonly canvasListeners: Array<{
    type: string;
    listener: EventListener;
    /** 必须原样记住并回传：`capture` 对不上的话 `removeEventListener` 摘不掉 */
    options?: AddEventListenerOptions;
  }> = [];
  /** Vault 访问桥（T1.42–T1.45）：卡片定义靠它读真实 `.md`，本视图负责造它 */
  private notesBridge: VaultBridge | null = null;
  /**
   * 脑图桥（`F3a`）：脑图卡读写的 `.nestmind`。
   *
   * ★ 懒建一次（它只是几个闭包，不持有 DOM / 资源），`teardownCanvas` 里清掉 ——
   *   与其余几座桥同一条：桥的生命周期 = 这次画布会话。
   */
  private mindBridge: MindBridge | null = null;
  /** 系统文件操作桥（T1.53）：文件卡的"用系统应用打开 / 读文件大小" */
  private shellBridge: ShellBridge | null = null;
  /**
   * 剪贴板桥（T3.04）：色板卡的"点击复制"。
   *
   * ★ 它没有任何状态与资源（不缓存、不监听），所以**不跟着画布拆建** ——
   *   在构造函数里建一次即可。把它放进 `buildCanvas` 只会换来一个
   *   "视图还没画过画布就不能复制"的假约束。
   */
  private readonly clipboardBridge: ClipboardBridge = new ObsidianClipboardBridge();
  /**
   * 像素采样桥（T3.05）：色板卡的"从图片吸色"。
   *
   * ★ 与剪贴板桥同理：没有状态、没有资源（每次采样现建一块 1×1 画布，用完即弃），
   *   所以**不跟着画布拆建**，构造一次即可。
   */
  private readonly pixelSampler: PixelSamplerBridge = new ObsidianPixelSampler();
  /**
   * 正在进行的取色会话（T3.05）。`null` = 没在取色。
   *
   * ★ 由视图持有而不是命令持有：命令是"一次性"的（跑完就返回），
   *   而取色要一直活到用户点下去或按 `Esc` —— 中间视图还会被换板 / 关闭。
   */
  private eyedropper: EyedropperSession | null = null;
  /**
   * 缩略图桥（T1.51/T1.52）：缩放 < 0.8 时图片卡用它替代原图。
   *
   * ★ 它是有状态资源（内存里存着一批 objectURL），生命周期**必须**与视图严格对齐：
   *   在 `ensureCanvas` 里建、在 `teardownCanvas` 里 `dispose()`。
   */
  private thumbnailBridge: ObsidianThumbnailBridge | null = null;
  /**
   * 板级缩略图桥（T4.16 / `F2-8-2`）：白板卡的预览区用它显示**目标板**的一张 256px 缩略图。
   *
   * ★ 与 `thumbnailBridge` 完全同一条生命周期纪律（`ensureCanvas` 里建、
   *   `teardownCanvas` 里 `dispose()`）：它握着同一套 objectURL 缓存。
   *   两块桥分开而不是合成一块，是因为"画什么"根本不同 —— 原图缩小 vs 模型重画，
   *   但共用 `io/ThumbnailCache.ts` + `io/ThumbnailProvider.ts` 那套缓存与并发逻辑。
   */
  private boardThumbBridge: ObsidianBoardThumbnailBridge | null = null;
  /**
   * 外链能力桥（T2.04–T2.06）：抓网页元数据 / 预览图落盘 / 用系统浏览器打开。
   *
   * ★ 与画布同生命周期（`ensureCanvas` 里建、`teardownCanvas` 里清）。它本身不占
   *   资源，但**它的每个方法都会现读设置**（总开关、附件目录），
   *   跟着视图换代能保证"改了设置 → 下次开板生效"这条路径永远成立。
   */
  private linkPreviewBridge: LinkPreviewBridge | null = null;
  /**
   * 静态地图瓦片桥（`O08`）：只服务"粘贴地图链接"这一个动作。
   *
   * ★ 与 `linkPreviewBridge` 同一个生命周期（`ensureCanvas` 建、`teardownCanvas` 清）：
   *   它同样**每次调用都现读设置**（服务商、key），跟着视图换代能保证
   *   "改了设置 → 下次粘贴生效"这条路径永远成立。
   * ★ 也同样是"渲染路径只读 `enabled`、从不发请求"：地图卡上那句话的措辞
   *   跟着它变（见 `cards/map.ts` 的 `renderFallback`）。
   */
  private mapTileBridge: MapTileBridge | null = null;
  /**
   * 白板内搜索面板（T2.09）。`null` = 没开着。
   *
   * ★ 面板由**视图**持有而不是命令持有：命令是"一次性"的（`checkCallback` 跑完就结束），
   *   而面板要一直活到用户按 Esc —— 中间还得能被 ⌘G 找到。
   */
  private searchPanel: SearchPanel | null = null;
  /**
   * 上一次搜索的"词 + 光标"（T2.10）。
   *
   * ★ 面板关掉也**不清**：⌘G 的语义是"接着找下一个"，不是"重新搜一遍" ——
   *   用户按 Esc 往往只是想让出视线，词他还记得。纯内存态，不进 `.nboard`。
   */
  private lastSearch: { query: string; index: number } | null = null;
  /**
   * 外部拖放桥（T1.63–T1.65）：监听器挂在画布元素上，`teardownCanvas` 里摘干净。
   *
   * 生命周期与画布绑定（不是与板绑定）：拖放能力在"打开失败 / 保护态"下也一样存在，
   * 而且换板不需要重新接线 —— 落点靠 `currentPath` 现取。
   */
  private dropBridge: DragDropBridge | null = null;
  /**
   * 拖出导出（T6.10 / `F6-04`）：把画布的移动手势复用成"拖到文件浏览器 → 写成 `.md`"。
   *
   * ★ 与 `dropBridge` 不同，它**不监听任何事件** —— 只是被 `onDragMove` / `onDragUp`
   *   喂指针位置。生命周期与画布绑定（构造一次、`teardownCanvas` 里取消）。
   */
  private dragOut: CardDragOut | null = null;
  /**
   * 当前被高亮的落点文件夹（拖出导出）。
   *
   * 存的是**元素**而不是路径：高亮要"清掉上一次点亮的那几个"，
   * 拿着元素直接 `removeClass` 比按路径再查一遍 DOM 稳（侧栏可能已经收起）。
   */
  private dragOutHighlight: HTMLElement[] = [];
  /** 提升为笔记（T1.47） */
  private promoter: NotePromoter | null = null;
  /** 面包屑导航（T1.62）。挂在 `contentEl` 上、覆盖在画布之上 */
  private breadcrumb: Breadcrumb | null = null;
  /**
   * 待办总览浮层（T3.03 / `F2.5`）。
   *
   * 与面包屑同理挂在根节点、活在屏幕坐标系里。`null` = 画布未就绪或已拆除。
   * ★ 它**不认识**白板文件：每次重画现取 `this.board`（见 `TodoOverviewOptions.board`），
   *   所以勾掉一条、撤销、切板都不需要视图手动喂数据。
   */
  private todoOverview: TodoOverview | null = null;
  /**
   * 画布过滤条（T3.17 / T3.18）。
   *
   * 与待办浮层同一套挂载方式，但**常驻在屏幕上**（不抢焦点、不遮画布）：用户一边敲词
   * 一边看画布上哪些卡在变淡。`null` = 画布未就绪或已拆除。
   */
  private filterBar: CardFilterBar | null = null;
  /**
   * 当前过滤条件（T3.17 / T3.18）。
   *
   * ★ 状态由**视图**拥有而不是过滤条：条子只负责"输入控件 ↔ 状态"的翻译，
   *   谁拥有状态、谁负责重画卡片都是视图的事（见 `CardFilterBarOptions`）。
   */
  private cardFilter: CardFilter = NO_FILTER;
  /**
   * 断链总览浮层（T3.19 / `F8-07`）。与待办浮层同理挂在根节点、活在屏幕坐标系里。
   */
  private linkOverview: LinkOverview | null = null;
  /**
   * 当前白板的断链清单（T3.19）。
   *
   * ★ 每次内容变化后重算一次，而不是每张卡各自去查 —— 断链总览与"只看断链"过滤
   *   共用**同一份**结果，两边绝不会出现"总览说 3 处、过滤里却有 4 张卡"。
   */
  private brokenRefs: readonly CardRef[] = [];
  /** 断链清单里的卡片 id 快照（过滤判定用，避免每次重扫清单） */
  private brokenCardIds: ReadonlySet<string> = new Set();
  /**
   * 主工具条（T3.21 / T3.27）。
   *
   * 挂在**根节点**上（与面包屑、过滤条同一套理由）：它是导航 / 命令控件，
   * 必须活在屏幕坐标系里 —— 塞进画布会跟着 world 缩放，30% 时按钮只剩几个像素。
   * `null` = 画布未就绪或已拆除。
   *
   * ★ 它自己不认识白板模型，只渲染 {@link toolbarItems} 给的那张清单；
   *   "点了 / 拖到画布上该做什么"全在本视图里，于是命令层、右键菜单、
   *   工具条三条入口共用同一批方法（不会出现"点工具条与按快捷键结果不同"）。
   */
  private toolbar: Toolbar | null = null;
  /**
   * 缩略图导航器（T5.09 / `F1-06`）。
   *
   * ★ 它只认识两样东西：`shapes`（要画的格子）与 `camera`（视口在哪），
   *   "把视口挪过去"这件事由本视图接住（回调进来），于是面板不必认识 `Viewport`。
   * ★ 显隐**不是**它自己的状态，而是 `settings.minimap` 的投影 ——
   *   命令、面板上的 `×`、设置面板三个入口改的都是那一份设置（`toggleMinimap`）。
   */
  private minimap: Minimap | null = null;

  /**
   * 此刻亮着"松手会搬进这块板"那圈环的白板卡 id（`B2`）。
   *
   * ★ 记住它是为了**只动变了的那些**：拖动预览每帧都跑一遍，
   *   每帧去清一遍全板卡片的类会白白摸几十个 DOM（而且会让浏览器重算样式）。
   */
  private highlightedDropBoardId: string | null = null;
  /**
   * 长按检测（T3.21 / 移动端）。
   *
   * ★ 它必须与"拖动卡片"共用**同一次按下**：手指按住不动 500ms 出菜单、
   *   挪出容差就取消。这件事散进三个指针回调里各写一段 setTimeout，
   *   出问题是"手机上偶尔弹菜单"这种最难复现的 bug —— 所以整块收在
   *   `LongPressDetector` 里，这里只负责在正确的时机喂它坐标。
   * `null` = 画布未就绪或已拆除。
   */
  private longPress: LongPressDetector | null = null;
  /**
   * 正在被长按的那张卡（T3.21）。
   *
   * ★ 单独记一张 id，而不是在触发时靠 `elementFromPoint` 反查：手指按下之后
   *   可能被别的东西盖住（菜单、浮层），反查会"猜错卡片"。按下那一刻卡片是确定的，
   *   直接记下来就没有猜的余地。
   */
  private longPressCardId: string | null = null;
  /**
   * 空白处的长按检测（T3.21 / `02 §6`：手机上"长按空白 → 新建菜单"）。
   *
   * ★ 与卡片那个检测器**分成两个实例**，而不是共用一个：按在卡片上还是按在空白处，
   *   在事件层就是两条不同的路径（卡片走委托层，空白走画布自己的监听）。
   *   共用一个实例的话，"谁先 `start` 谁赢"取决于监听器注册顺序 ——
   *   那种靠顺序维持的正确性，会在下一次调整注册顺序时无声地坏掉。
   */
  private canvasLongPress: LongPressDetector | null = null;
  /**
   * 本机的性能档位与降级清单（T3.22 / `02 §8.1`）。
   *
   * ★ 默认给**桌面档**，`onOpen` 里才按真实环境覆盖一次：这样"还没量到环境"
   *   的任何一帧（单测、极早的渲染路径）拿到的都是"不降级"，
   *   而不是一个 `undefined` 让某个开关静默失效。
   */
  private perfProfile: PerfProfile = DESKTOP_PROFILE;
  /** 本实例的序号：给 `aria-describedby` 拼不冲突的 `id`（见 `viewInstanceSeq`） */
  private readonly instanceId = (viewInstanceSeq += 1);
  /** 卡片操作提示节点的 `id`（T3.26）。每张卡的 `aria-describedby` 都指向它 */
  private readonly cardHintId = `nestboard-card-hint-${this.instanceId}`;
  /**
   * 上一次写进 world 容器的 `aria-label`（T3.26）。
   *
   * ★ 缓存一份是为了**避免每帧都写 DOM**：`aria-label` 只在卡片数量变化时才变，
   *   而写 `setAttribute` 会触发无障碍树的重算 —— 那是最贵的一类 DOM 写
   *   （`02 §8.2`：渲染路径上禁止每帧 DOM 写）。
   */
  private lastBoardAriaLabel = '';
  /**
   * 空板引导那一行（T3.21）。与工具条同层，活在屏幕坐标系里。
   *
   * ★ `null` = 画布未就绪或已拆除。文本在**建的时候就定了**（按平台二选一），
   *   之后只在切语言时重写一次 —— 它不随板子内容变化，只有"显不显示"会变。
   */
  private emptyHintEl: HTMLElement | null = null;
  /**
   * 上一次写进 DOM 的"空板引导要不要显示"。
   *
   * ★ 与 `lastBoardAriaLabel` 同理：`applyBoard` 每次内容变化都会跑，
   *   而 `toggleClass` 即使结果一样也会触发样式重算。缓存一份，
   *   没变就一个类名都不动（`02 §8.2`：渲染路径上禁止无谓的 DOM 写）。
   */
  private lastEmptyHintVisible: boolean | null = null;
  /** 顶栏性能提示（T2.16）。同样活在屏幕坐标系里，不能被 world 的 transform 缩放 */
  private scaleHintEl: HTMLElement | null = null;
  /** 当前板算出来的退化建议；拆板 / 展开分栏后重算 */
  private scaleAdvice: ScaleAdvice | null = null;
  /**
   * 归档锁定提示条（T4.06）。
   *
   * ★ 与"保护态"（解析失败）**必须长得不一样**：两者都不能改，但原因完全不同 ——
   *   一个要用户去修文件、一个要用户点解锁。用同一条提示会让归档板看起来像坏掉了。
   * ★ 所以这里只由 `repository.lockReason()` 里的 `'locked'` 分支点亮。
   */
  private lockHintEl: HTMLElement | null = null;
  /**
   * 上一次写进 DOM 的"锁定提示要不要显示"。
   *
   * ★ 与 `lastEmptyHintVisible` 同理：`applyBoard` 每次内容变化都会跑，
   *   `toggleClass` 即使结果一样也会触发样式重算。这里更进一步 ——
   *   提示条里有按钮，无脑 `empty()` 重建等于每次内容变化都丢掉并重绑一次监听器。
   */
  private lastLockHintVisible: boolean | null = null;
  /**
   * 打开时取到的**磁盘文件字节数**（T2.16 / `02 §8.3` 的 5MB 线）。
   *
   * 只在打开时取一次：`stat` 是异步的，而提示要跟着每次内容变化即时重算。
   * 数字因此是"打开那一刻"的大小 —— 用户在同一块板上加了 3MB 内联文本，
   * 要重开一次才会看到提示，这个滞后可以接受（换来的是每次编辑不必再 await IO）。
   */
  private scaleFileBytes: number | null = null;
  /**
   * 已经为哪些路径应用过"默认折叠"。
   *
   * ★ 必须记住：否则用户手动展开分栏之后，只要一次内容变化触发 `applyBoard`，
   *   分栏又会被折回去 —— 那是"白板自己在跟用户对着干"。
   * 生命周期跟随视图实例，关掉重开即重置（这也合理：下次打开仍然是大板，默认折叠依旧该生效）。
   */
  private readonly collapseDefaults = new Set<string>();
  /**
   * 拖动会话的窗口级监听器。
   *
   * 为什么不挂在 canvas 上：指针一旦拖出画布（甚至拖到侧栏）就收不到 move/up，
   * 拖动会"卡住"跟着鼠标不放，直到用户再点一下。挂 window 是唯一能收全的方式。
   * 代价是**必须成对摘除**，所以统一走 `startDragSession` / `endDragSession`。
   */
  private dragListeners: Array<() => void> = [];
  /**
   * 自动尺寸待提交（T1.38 的自动高度 / `F4` 的脑图卡"内容说了算"）：
   * 延到下一帧，避免在卡片层遍历 DOM 的中途重入。
   *
   * ★ 形状从"一个高度"长成"一个尺寸"（`F4`）：脑图卡**宽度也要跟着内容走**
   *   （见 `requestCardSize`）。两种调用方共用同一条队列与同一个提交 ——
   *   分两条的话，同一帧里"长高"与"长宽"会各自 `commit` 一次，历史里平白多一条。
   */
  private readonly pendingSizes = new Map<string, Size>();
  private sizeFlushScheduled = false;
  /**
   * 帧调度器（T2.14 / `02 §8.2`「批量写入 rAF 合并」）。
   *
   * ★ 为什么必须合并：120Hz 触控板一帧能发 2~4 个 `wheel` / `pointermove` 事件，
   *   而每个事件原本都会同步跑完「写 world transform + 卡片层裁排 + 连线层重绘」。
   *   中间那几次的结果用户一帧都看不到，代价却一分不少 —— 这正是千卡白板上
   *   最容易把帧率打穿的地方。
   * ★ 合并的是**提交**，不是状态：`Viewport` 在每个事件里即时更新，所以命中测试、
   *   坐标换算、下一次事件的增量都基于最新值，只有 DOM 晚一帧（人眼不可见）。
   */
  private readonly frameQueue = new FrameQueue();
  /** 待落盘的视口所属白板（`null` = 没有待落盘的）。为什么延后：见 `commitViewState` */
  private pendingViewPath: string | null = null;
  /**
   * 拖动会话的形态与修饰键。
   *
   * `dragAltKey` 由每次 `pointermove` 刷新而不是在按下时定死 ——
   * 用户完全可能"先拖起来、再按住 Alt"，那一刻起就该变成复制。
   * `dragKind` 用来在提交时分流：「Alt+拖动 = 原地复制」（`F2-00-6`）
   * 指的是**留下原卡、拖走副本**，而不是"把原卡挪走"。
   */
  private dragKind: DragKind = 'move';
  private dragAltKey = false;
  /**
   * 分栏拖动 / 缩放的会话（F2-7-4 / F2-7-5）。
   *
   * ★ 为什么不复用 `dragController`：那个控制器的契约是"一串矩形 + 松手提交这一串矩形"，
   *   而整栏移动要**同时**动栏和它的全部成员（成员几何由 `columnMoveRects` 算出来，
   *   不是用户拖出来的）。把它塞进 `DragController` 会让那边长出一堆
   *   "这些矩形是卡片还是分栏"的分支 —— 不如让分栏自己走一条更短的路。
   */
  private columnDrag: {
    column: Column;
    gesture: ColumnGesture;
    origin: Point;
    /** 起始几何（世界坐标）。整栏移动 = 起始 + 位移；缩放 = 从起始框拖边 */
    startRect: Rect;
    moved: boolean;
  } | null = null;
  /** 分栏拖动的最新预览几何（松手时按它提交） */
  private pendingColumnRects: ReturnType<typeof columnMoveRects> | null = null;
  /**
   * 栏内滚动偏移：分栏 id → 像素（T2.03 / `F2-7-10`）。
   *
   * ★ 这是**界面状态**，绝不落盘：它记的是"现在看到哪一段"，与"卡片在哪"无关。
   *   换板 / 重开就该复位，撤销一次插入也不该把别人当时滚到哪一并带回来。
   * ★ 真相在 DOM 那一侧（`scrollTop`，浏览器会自己钳住边界），本 Map 是
   *   "视图这一层记着的值"，只在两侧真的不一致时才写回 DOM
   *   （见 `ColumnLayer.applyScrollTop`）。
   */
  private readonly columnScroll = new Map<string, number>();
  /**
   * 卡片拖动时的落点（T1.55）。
   *
   * 存的是**世界坐标的插入线**，因为指针每动一帧都要重画；
   * 屏幕坐标在 `syncCanvas` 里按当前视口换算，缩放/平移期间也不会画歪。
   */
  private dropTarget: ColumnDropTarget | null = null;
  /**
   * 从**视图外部**拖进来的落点（T1.63–T1.66，`F6-01–F6-06`）。
   *
   * ★ 与上面的 `dropTarget` 是两件事，别混：`dropTarget` 是"已经在白板里的卡片被拖到
   *   分栏哪一行"（拖动会话的状态，由 `DragController` 驱动）；这里是"文件从文件浏览器 /
   *   系统文件管理器拖进画布"（HTML5 拖放，由 `DragDropBridge` 驱动）。
   *   两者不会同时存在（一个用手拖、一个用系统拖），但含义完全不同。
   *
   * 存的是**世界坐标**的中心点与类型，屏幕矩形每帧按当前视口现算 ——
   * 缩放/平移期间幽灵卡才不会跑偏（与 `dropTarget` 同理）。
   */
  private dropPreview: { center: Point; items: DragPreviewItem[] } | null = null;
  /**
   * 外部拖入时的分栏插入线（世界坐标）。
   *
   * 与 `dropTarget` 分开存、绘制时合并：拖动中每帧都要重画插入线，
   * 而"这条线是谁给的"只影响绘制，不影响画法。
   */
  private dropColumnLine: Rect | null = null;
  /**
   * 拖动中的**临时卡片几何**（T1.70）。
   *
   * ★ 拖动期间卡片层只改 DOM（`previewRects`），模型里那张卡还在原位 ——
   *   而连线的锚点是按模型几何算的，不喂这份覆盖进去，用户会看到
   *   "卡片被拖走了，线还拴在原地"。
   *   `null` = 没有拖动，按模型画。
   */
  private dragPreviewRects: ReadonlyMap<string, Rect> | null = null;
  /**
   * 拖动中的**临时旋转角**（T7.06）：`id → 度`，`null` = 没在转。
   *
   * ★ 与 `dragPreviewRects` 同一条理由：转动的过程中模型里还是旧角度，
   *   而连线的锚点按模型角度算 —— 不喂这份覆盖进去，转一张接了线的卡时
   *   线头会浮在卡片外面，松手才"啪"地贴回去。
   * ★ 只可能有一项（旋转是单手势、单卡片），但不做成"单个对象"是为了与
   *   连线层那条"覆盖表"接口对齐 —— 那一层不需要知道"旋转最多一张"这件事。
   */
  private dragRotation: ReadonlyMap<string, number> | null = null;
  /**
   * 拖动中的**临时弧度**（T7.12）：`edgeId → 弧度`，`null` = 没在拖。
   *
   * ★ 与 `dragPreviewRects` / `dragRotation` 同一条理由：拖动期间模型不变，
   *   而线要立刻跟着手弯 —— 不喂这份覆盖进去，拖动中看不到任何反馈，
   *   只有松手才"啪"地弯过去。
   * ★ 值可以是 `null`：拖回弦上就是**拉直**，这与"没有这一项"（= 用模型值）
   *   是两件事，所以判断必须是 `has()` 而不是 `get() === null`。
   */
  private dragCurve: ReadonlyMap<string, EdgeCurve | null> | null = null;
  /**
   * 待落地的拖动预览几何（T2.14）。
   *
   * ★ 只延后**DOM 写与连线重绘**，不延后上面那份 `dragPreviewRects`：
   *   落点判定（`updateDropTarget`）读的是它，晚一帧就会把"松手时插进哪个分栏"判错
   *   —— 那是功能性错误，不是观感问题。
   */
  private pendingDragPreview: readonly CardRect[] | null = null;
  /**
   * **已经写进 DOM** 的那份预览几何（T2.14）。
   *
   * ★ 与 `pendingDragPreview` 的分工：那个是"下一帧要落地的"，这个是"现在屏幕上的"。
   *   相机变化时 `cardLayer.sync` 会把卡片按**模型位置**重排，把屏幕上那份预览抹掉，
   *   所以要拿这一份补画回去（见 `reapplyDragPreview`）。
   */
  private appliedDragPreview: readonly CardRect[] | null = null;
  /**
   * 拖动中的智能参考线（T3.12，**世界坐标**）。
   *
   * ★ 存世界坐标而不是屏幕坐标：相机一变就要整层重画（见 `drawSmartGuides`），
   *   缓存屏幕坐标等于给自己埋一个"缩放后参考线错位"的坑。
   *   `null` = 当前没有参考线（没拖动 / 没对齐上 / 被 Ctrl 临时关掉了）。
   */
  private dragGuides: SmartGuides | null = null;
  /**
   * 拖动开始时画布的屏幕位置。
   *
   * ★ 只在开始时读一次：拖动预览每帧都在写卡片样式，若每帧再
   *   `getBoundingClientRect()` 就会形成"写 → 读 → 写"的强制同步重排，
   *   在千卡白板上这是最容易把 60fps 打穿的一处（`02 §8.2`）。
   */
  private dragCanvasOrigin: Point | null = null;
  /** 鼠标在画布上的最后位置（**原始 client 坐标**）。⌘⇧E"在光标处新建"用它 */
  private lastPointerClient: Point | null = null;
  /** 当前处于编辑态的卡片 id（界面状态：关掉视图就消失，绝不落盘） */
  private editingCardId: string | null = null;
  /**
   * 这次编辑是从哪一步进来的（O01 / O02），随 `editingCardId` 一起生效 / 复位。
   *
   * ★ 只有"正在编辑的那张卡"能读到它（见 `createCardContext`）：
   *   别的卡即便同屏渲染，也拿到的是一份不带入口意图的上下文。
   */
  private editEntry: EditEntry = 'title';
  // ★ 不能叫 `navigation`：`View.navigation: boolean` 是基类成员（"本视图是否用于导航"），
  //   同名会被 TS 判为非法覆盖，而且运行时还会被基类当布尔值读。
  private navigationController: NavigationController | null = null;
  private resizeObserver: ResizeObserver | null = null;

  private canvasEl: HTMLElement | null = null;
  private worldEl: HTMLElement | null = null;
  /**
   * 选中单张便签 / 仅标题卡 / 白板卡时的快捷操作栏（`O38`）。
   *
   * ★ 它是 `ui/QuickBar`（与脑图节点共用那一份）：两边按钮逐个对应同一件事，
   *   分开写迟早一边加了按钮、另一边忘了。
   * ★ 哪几类卡片有这条栏、各自能改什么，由 {@link quickBarTarget} 与那三张
   *   `*_BAR_FEATURES` 决定（图片卡、待办卡等各有各的编辑方式，不在这条栏上）。
   */
  private quickBar: NodeToolbar | null = null;
  /**
   * 卡内脑图**此刻选中的那个节点**（`F4`，用户 2026-09-21）。
   *
   * ★ 它是"状态"不是"事件"：栏要一直记着现在操作的是谁，所以整份请求存下来，
   *   每次刷栏时按 `path` / `inline` **现读**模型（节点可能已经被改过好几轮）。
   * ★ 与卡片选区的关系：点节点**不会**选中那张卡（那一层被卡片自己 `stopPropagation`
   *   拦下了），所以这里不能要求"卡也在选区内"；失效判据见 {@link syncQuickBar}。
   */
  private mindFocus: MindNodeFocus | null = null;

  private readonly boardSubscriptions: Array<() => void> = [];
  private unsubscribeViewport: (() => void) | null = null;
  private unsubscribeSelection: (() => void) | null = null;
  private currentPath: string | null = null;
  /**
   * 白板之间的导航历史（T1.62 前进 / 后退）。
   *
   * ★ **不能复用撤销栈**：撤销改的是"内容"（`HistoryStack` 快照），这里记的是
   *   "去过哪些板"，改的是"视图在看什么"。混在一起就会出现
   *   "按 ⌘Z 突然跳到了另一块白板"这种用户无法解释的行为。
   * ★ 只记 `path`，不记视口：回到某块板时用户想去的是**那块板**，
   *   不是当时的缩放比例（视口本来就按文件记忆，见 T1.22）。
   */
  private navHistory: string[] = [];
  private navIndex = -1;
  /**
   * 当前板的父级路径（`null` = 顶层板），由面包屑刷新时顺带缓存。
   *
   * ★ 缓存而不是每次按 `⌘U` 现读：菜单可用态要在**同步**里判出来
   *   （`checkCallback` 不能等异步），而链接层级本来就没那么易变。
   */
  private boardParentPath: string | null = null;
  /**
   * 正在回放的那一条历史（`⌘[` / `⌘]` 的目标路径）；不是回放时为 `null`。
   *
   * ★ 回放**绝不能**再记一条历史：`setViewState` 会触发 `onLoadFile` → `openBoard`，
   *   再记一次就等于"后退"本身成了新历史，`navIndex` 被顶到队尾，`⌘[` 按一下就再也回不去。
   * ★ 用**目标路径**认领而不是用布尔标记卡时间窗：`setViewState` 到 `onLoadFile`
   *   之间隔着 Obsidian 内部调度，官方并没有承诺前者 `await` 后者。
   *   路径认领不依赖时序 —— 谁先谁后都认得出"这一次加载是回放"。
   */
  private replayTarget: string | null = null;

  /** 恢复视口期间抑制回写：否则"刚打开就把文件标脏"，还会和外部改动检测打架 */
  private restoringViewport = false;

  constructor(leaf: WorkspaceLeaf, plugin: NestboardPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  override getViewType(): string {
    return VIEW_TYPE_BOARD;
  }

  override getDisplayText(): string {
    return this.file?.basename ?? t('view.board.name');
  }

  override getIcon(): string {
    // Lucide 图标名（02 §5.1：图标一律 Lucide）
    return 'layout-dashboard';
  }

  /** 当前缩放倍率（工具栏 `ui/ZoomControl.ts` 在后续 Sprint 消费） */
  get zoom(): number {
    return this.viewport.zoom;
  }

  // ── 生命周期 ────────────────────────────────────────────

  override async onOpen(): Promise<void> {
    // ★ 性能档位必须在**建画布之前**定下来（T3.22）：`buildCanvas` 里要拿它去
    //   裁剪外扩、复用池上限与 DPR 三个地方，晚一步就得重建图层
    this.perfProfile = perfProfileFor(deviceTierOf(readDeviceHints(Platform.isMobile)));
    this.ensureCanvas();
  }

  override async onClose(): Promise<void> {
    const path = this.currentPath;
    this.detachBoard();
    this.teardownCanvas();
    // 关闭前把最后的视口落盘 —— 用户可能刚好在关标签前拖了一下
    if (path) await this.plugin.repository.flush(path);
  }

  override async onLoadFile(file: TFile): Promise<void> {
    // 「最近打开」（T5.08 / F7-04）：这里是**所有**打开方式的汇合点 ——
    // 文件浏览器双击、内部链接、`obsidian://` 协议、侧栏点击、`⌘U` 进父板……
    // 挂在某一条命令上都会漏掉其余全部，而那表现为"这个列表偶尔不准"（最难查的一类 bug）
    if (file.extension === BOARD_EXT) this.plugin.rememberRecentBoard(file.path);
    await this.openBoard(file.path);
  }

  override async onUnloadFile(file: TFile): Promise<void> {
    // 同 leaf 切换文件：先摘掉旧板的订阅，再落盘旧板
    this.detachBoard();
    await this.plugin.repository.flush(file.path);
  }

  /**
   * `FileView` 的生命周期钩子：Obsidian 在文件改名**之后**回调它（T1.73）。
   *
   * 这是路径跟随的**主路**（`main.ts` 里遍历所有视图那条是兜底）：只有视图自己
   * 知道它正看着的是不是这块板。钩子拿不到旧路径，所以从 `currentPath` 反推。
   */
  override async onRename(file: TFile): Promise<void> {
    const oldPath = this.currentPath;
    if (oldPath) this.retargetPath(oldPath, file.path);
  }

  // ── 命令入口（T1.20） ───────────────────────────────────

  /** ⌘= / ⌘-：缩放一档（锚点默认视口中心） */
  zoomByStep(direction: 1 | -1): void {
    this.viewport.zoomStep(direction);
  }

  /** ⌘1：回到 100% */
  zoomToActualSize(): void {
    this.viewport.zoomToActualSize();
  }

  /** ⌘0：适应全部内容（空板时退化为 100%） */
  fitContent(): void {
    this.viewport.fit(this.contentBounds());
  }

  // ── 演示命令入口（J-06 / J-07） ─────────────────────────

  /** 是否正在演示（命令可用性、工具条显隐都读它） */
  get isPresenting(): boolean {
    return this.presentation?.active ?? false;
  }

  /** 板上有没有可讲的东西：空板不进演示 —— 进了也只是一个按什么都没反应的界面 */
  get canPresent(): boolean {
    return (this.board?.cards.length ?? 0) > 0;
  }

  /** `⌘⇧P` / 右键菜单：进入演示（收尾编辑 / 手绘由控制器经 `exitTransientModes` 做） */
  startPresentation(): void {
    this.presentation?.start();
  }

  /** `Esc` / 步骤条上的 ✕：退出演示 */
  endPresentation(): void {
    this.presentation?.stop();
  }

  /** `→`：下一步 */
  presentNext(): void {
    this.presentation?.next();
  }

  /** `←`：上一步 */
  presentPrevious(): void {
    this.presentation?.previous();
  }

  /** `O`：总览整块白板（不退出演示，再按 `→` 会重新聚焦下一步） */
  presentOverview(): void {
    this.presentation?.overview();
  }

  /** 清空演示路径（卡片留着，只清顺序） */
  clearPresentation(): void {
    if (this.commit(t('history.presentClear'), (board) => clearPresentSteps(board))) {
      new Notice(t('notice.presentCleared'));
    }
  }

  /** 把选中的卡片接进演示路径（命令面板与卡片右键共用这一条） */
  addSelectionToPresentation(): void {
    this.setSelectionPresentStep(true);
  }

  /** 把选中的卡片移出演示路径 */
  removeSelectionFromPresentation(): void {
    this.setSelectionPresentStep(false);
  }

  /** 板上有没有编进演示路径的对象（卡或脑图，`2.2.0` 收尾） */
  get hasPresentSteps(): boolean {
    const board = this.board;
    if (!board) return false;
    return this.steppablesOf(board).some((entity) => presentStepOf(entity) !== null);
  }

  /** 能进演示路径的全部对象（卡 + 脑图）—— 判据一处，别再散落（`2.2.0` 收尾） */
  private steppablesOf(board: BoardFile): Array<Card | Mind> {
    return [...board.cards, ...(board.minds ?? [])];
  }

  /** 选中的对象 id（卡 + 脑图）：演示相关的几个入口都按它算 */
  private selectedSteppableIds(): string[] {
    return [...this.selection.cardIds, ...this.selection.mindIds];
  }

  /** 选中的卡片里至少有一张**还没进**路径（"加入演示"的可用性） */
  get canAddToPresentation(): boolean {
    // ★ 闸门是"选中的东西里**有能进演示的**"，不是"有卡片"（用户 2026-09-22 实测：F4）
    //   —— 选中一棵树时命令面板里从前**根本没有这两条命令**（`available` 为假 ⇒ Obsidian 直接不列）。
    if (!this.canManipulateSelection) return false;
    return this.selectedSteppableIds().some((id) => this.presentStepOfId(id) === null);
  }

  /** 选中的卡片里至少有一张**已经在**路径里（"移出演示"的可用性） */
  get canRemoveFromPresentation(): boolean {
    if (!this.canManipulateSelection) return false;
    return this.selectedSteppableIds().some((id) => this.presentStepOfId(id) !== null);
  }

  private presentStepOfId(id: string): number | null {
    const board = this.board;
    if (!board) return null;
    const entity = this.steppablesOf(board).find((item) => item.id === id);
    return entity ? presentStepOf(entity) : null;
  }

  /**
   * 把选中的卡片放进 / 移出演示路径（J-07）。
   *
   * ★ 走 `commit` 而不是裸 `mutate`：演示顺序是**会写进文件的内容**，
   *   编错了要能 `⌘Z` 回来（与"锁定 / 颜色"同一档）。
   * ★ 只改模型、**不碰相机**：讲的过程中顺手调顺序，画面不该跟着跳
   *   —— 相机只在切步（`→` / `←` / 数字键）时动。
   */
  private setSelectionPresentStep(on: boolean): void {
    // ★ 脑图也在这个集合里（`2.2.0` 收尾）：选中一棵树时「加入演示 / 移出演示」同样该能用
    const ids = this.selectedSteppableIds();
    if (ids.length === 0) return;

    if (!on) {
      if (this.commit(t('history.presentRemove'), (board) => removeFromPresentation(board, ids))) {
        new Notice(t('notice.presentRemoved'));
      }
      return;
    }

    this.commit(t('history.presentAdd'), (board) => addToPresentation(board, ids));
    // 步骤号在提交**之后**读：把它写进去的正是 `addToPresentation`
    const first = ids[0];
    const board = this.board;
    const entity = board ? this.steppablesOf(board).find((item) => item.id === first) : undefined;
    const step = entity ? presentStepOf(entity) : null;
    if (step !== null) new Notice(t('notice.presentAdded', { step }));
  }

  /**
   * 一棵脑图在演示里取景用的矩形 —— **世界坐标**，与卡片那条 `visualRectOf` 同一套单位。
   *
   * ★★ 单位这一条**必须**对齐（`b107` 修的正是它）：`presentTargetViewport` 收的是**世界矩形**
   *   （它自己算 `screen = world × zoom + offset`，见 `view/presentCamera.ts` 的用例）。
   *   这一支从前把世界矩形**先换算成了屏幕像素**（乘 zoom + 加平移）再递进去 —— 于是相机
   *   拿着"已经含当前视口"的数当世界坐标算，落点当然**跟着当前视口跑**：同一个演示步骤，
   *   从不同地方翻过去，停的位置都不一样（用户 2026-09-23 报的"位置乱飘 / 发生偏差"）。
   *   ★ 教训：这里**不要**做任何 `toScreen` / 乘 zoom —— 那是渲染层的事，相机只吃世界坐标。
   *
   * ★ 几何取**整棵树**、且来自**纯布局**（`MindLayer.viewRectOf`：原点就是根节点中心，
   *   与量测 / 折叠 / 有没有挂载无关）—— 用户要的"以脑图根节点、且看到全脑图"两半都在这。
   */
  private mindVisualRectOf(mindId: string): Rect | null {
    return this.mindLayer?.viewRectOf(mindId) ?? null;
  }

  /** 把一张卡在演示路径里前移 / 后移一位（J-07） */
  private moveCardPresentStep(id: string, delta: -1 | 1): void {
    this.commit(t('history.presentOrder'), (board) => movePresentStep(board, id, delta));
  }

  // ── 选区命令入口（T1.31） ───────────────────────────────

  /**
   * 键盘此刻是否归卡片编辑器（不是归画布）。
   *
   * `02 §4.2`「仅 EDITING 态接管文本键」的落点：命令层拿它给 Obsidian 让路 ——
   * 编辑卡片时 `⌘A` 必须是"全选文字"，不能变成"全选卡片"。
   */
  get isEditingCard(): boolean {
    return this.pointerState.capturesKeyboard;
  }

  /**
   * 当前打开的白板路径（未打开 / 已卸载 → `null`）。
   *
   * 附件默认位置里的 `./`（"相对当前文件"）需要一个基准目录 —— 在本插件里
   * 最贴近"当前文件"的就是**正在看的那块白板**，插件层用它拼出附件目录（T1.49）。
   */
  get boardPath(): string | null {
    return this.currentPath;
  }

  /** 是否有可操作的选区（Delete 的可用条件：卡片或连线都算） */
  get canManipulateSelection(): boolean {
    return (
      !this.isEditingCard &&
      !this.selection.isEmpty &&
      !this.isReadOnly() &&
      // 演示态（J-06）：编辑类命令**一律从命令面板消失**。
      // ★ 只拦指针 / 画布按键是不够的：`⌘⇧E`、`⌘D` 这些是 Obsidian 热键系统在
      //   document 层处理的，绕不开画布那几个早退 —— 命令的 `available` 是唯一的闸门
      !this.presentation?.active
    );
  }

  /**
   * 是否有可操作的**卡片**选区。
   *
   * ★ 与 {@link canManipulateSelection} 必须分开：后者对"只选中了一条连线"也为真
   *   （Delete 该生效），但"复制 / 置顶 / 改标题 / 收进分栏"这些命令只对卡片有意义。
   *   用同一个条件会让它们变成"可点，点了什么也没发生" —— 比直接置灰更难理解。
   */
  get canManipulateCards(): boolean {
    return this.canManipulateSelection && this.selection.cardIds.size > 0;
  }

  /**
   * 是否有能被**置顶 / 置底**的选区（`2.2.0` 收尾）。
   *
   * ★ 卡片与**整棵脑图**都算（两者的 `z` 是同一格 —— 见 `model/ops.reorderContent`）。
   *   用 `canManipulateCards` 当闸门时，`⌘⇧↑` / `⌘⇧↓` 在"只选中一棵树"时是**灰的**，
   *   连热键都不会触发（用户 2026-09-22 实测：D 组"快捷键无效、菜单有效"）。
   */
  get canReorderSelection(): boolean {
    return (
      this.canManipulateSelection &&
      (this.selection.cardIds.size > 0 || this.selection.mindIds.size > 0)
    );
  }

  /** 选中卡片数量（工具栏 / 状态栏用） */
  get selectedCount(): number {
    return this.selection.size;
  }

  /**
   * 命令可用条件：选区里**有能被复制 / 剪切 / 原地复制的东西**（`⌘C` / `⌘X` / `⌘D`）。
   *
   * ★ 卡片与**整棵脑图**都算（`2.2.0` 批 4 五起）：两者都能进剪贴板与原地复制 ——
   *   搬运载荷里多一个 `minds`（内嵌模型跟着走，节点 id 会重编）。
   *   分栏仍然不算：它复制出去没有成员（栏内卡片各有归属），语义上不成立。
   */
  get canCopySelection(): boolean {
    return (
      this.canManipulateSelection &&
      (this.selection.cardIds.size > 0 ||
        this.selection.mindIds.size > 0 ||
        // 节点级（`2.2.0` · O6）：框住几个节点也是"有东西可复制"
        this.selection.mindNodeKeys.size > 0)
    );
  }

  /** ⌘A：全选卡片 */
  selectAll(): void {
    this.marqueeController?.selectAll();
  }

  /** ⌘⇧↑：选中项置顶（F2-00-4）。相对次序保持不变 */
  bringSelectionToFront(): void {
    this.reorderSelection(bringToFront);
  }

  /** ⌘⇧↓：选中项置底 */
  sendSelectionToBack(): void {
    this.reorderSelection(sendToBack);
  }

  // ── 卡片增删改命令入口（T1.34–T1.48） ───────────────────
  //
  // 这一节的每个方法都是**命令层唯一入口**：`commands.ts` 只调用它们，
  // 不自己碰模型。好处是可用条件（`can*`）与动作成对写在一起，
  // 命令表里不会出现"命令可用但点了没反应"。

  /** 命令可用条件：这张白板此刻能改，且键盘不在编辑器里 */
  get canCreateCard(): boolean {
    // 演示态（J-06）不给新建：讲着讲着拍出一张新卡是最难收拾的一类误操作，
    // 而 `⌘⇧E` 又偏偏是新建便签的默认键
    return !this.isEditingCard && !this.isReadOnly() && !this.presentation?.active;
  }

  /** 命令可用条件：⌘Z 有东西可退（编辑态让给编辑器的原生撤销） */
  get canUndo(): boolean {
    return !this.isEditingCard && !this.isReadOnly() && this.history.canUndo;
  }

  /** 命令可用条件：⌘⇧Z 有东西可重做 */
  get canRedo(): boolean {
    return !this.isEditingCard && !this.isReadOnly() && this.history.canRedo;
  }

  /** 命令可用条件：恰好选中一张未锁定的卡（Enter 编辑） */
  get canEditSelection(): boolean {
    const card = this.selectionOnlyCard();
    return this.canManipulateSelection && card !== null && !card.locked;
  }

  /** 命令可用条件：恰好选中一张便签卡（⌘⇧P 提升为笔记，T1.47） */
  get canPromoteSelection(): boolean {
    return this.canManipulateSelection && this.selectionOnlyCard()?.type === 'note';
  }

  /**
   * ⌘⇧E / 空白处双击：就地新建一张便签（`F1-07`）。
   *
   * 拿得到鼠标位置就落在光标处；拿不到（纯键盘唤起命令面板）就落在视口中心 ——
   * 总比"新建在某处看不见的地方、用户以为没生效"强。
   */
  newNoteAtCursor(): void {
    const world = this.cursorWorld();
    if (world) this.createCardAt(world, 'note');
  }

  /** 命令 / 右键菜单：就地新建一张待办卡（T3.01）。落点规则与 {@link newNoteAtCursor} 完全一致 */
  newTodoAtCursor(): void {
    const world = this.cursorWorld();
    if (world) this.createCardAt(world, 'todo');
  }

  /** 命令：就地新建一张色板卡（T3.04）。落点规则同上 */
  newSwatchAtCursor(): void {
    const world = this.cursorWorld();
    if (world) this.createCardAt(world, 'swatch');
  }

  /** 新建卡片的落点（世界坐标）：优先最后一次指针位置，拿不到（纯键盘触发）就落视口中心 */
  private cursorWorld(): Point | null {
    const canvas = this.canvasEl;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const client = this.lastPointerClient;
    const screen = client
      ? { x: client.x - rect.left, y: client.y - rect.top }
      : { x: rect.width / 2, y: rect.height / 2 };
    return this.viewport.toWorld(screen);
  }

  /**
   * Enter：编辑唯一选中的卡片。
   *
   * 传 `force`：Enter 的语义就是"改里面的内容"，引用卡不该在这里被抢去
   * 打开源笔记（那是双击的语义，T1.43）。
   *
   * ★ 编辑流与双击**完全一致**（O01）：选中卡片后按 `Enter` 与直接双击它，
   *   用户预期的是同一件事，两条路不该分成"一个先编标题、一个直接进正文"。
   *   `raw` 为真（`⌘`+Enter）时跳过标题那一步，与 `⌘`+双击同义。
   */
  editSelection(raw = false): void {
    const card = this.selectionOnlyCard();
    if (card) this.editCard(card.id, true, raw ? 'raw' : 'title');
  }

  /**
   * Delete / Backspace：删除选中的卡片、连线与**整棵脑图**（T1.71 / `F3-08` / `2.2.0` 批 5）。
   *
   * ★ 几者合成**一次** `commit`：分成两次会在撤销链上留下两条记录，而用户眼里
   *   "我选了一堆东西、按了 Delete"就是一个动作（与 `commitDrag` 里
   *   "挪位置 + 解除分栏归属"合成一条同理）。
   * ★ 分栏**不在这里删**：删一栏要同时决定栏里那些卡怎么办（`O16` 把这件事
   *   交给了专门的"拆栏 / 解除归属"手势），混进这个键会让 Delete 的后果变得不可预料。
   * ★ 脑图（`2.2.0` 批 5）可以整体删：它没有"成员"这回事，`removeMinds` 连它身上的线
   *   一起清（与删卡同一条纪律），而里面的节点是这棵树自己的一部分 —— 删树就是删树。
   */
  deleteSelection(): void {
    const cardIds = [...this.selection.cardIds];
    const edgeIds = [...this.selection.edgeIds];
    const mindIds = [...this.selection.mindIds];
    // 节点级选中（`2.2.0` 收尾 · 节点级框选）：按树分组后交给 `removeNodes`
    const nodeKeys = [...this.selection.mindNodeKeys];
    if (
      cardIds.length === 0 &&
      edgeIds.length === 0 &&
      mindIds.length === 0 &&
      nodeKeys.length === 0
    ) {
      return;
    }

    const changed = this.commit(t('history.delete'), (board) => {
      // 删卡 / 删树都会连带清掉挂在它们身上的边（`removeCards` / `removeMinds` 负责），
      // 三条路径不会打架（`removeEdges` 只处理"选中的那几条线"）
      let did = cardIds.length > 0 ? removeCards(board, cardIds) : false;
      if (mindIds.length > 0 && removeMinds(board, mindIds)) did = true;
      if (nodeKeys.length > 0 && removeMindNodes(board, nodeKeys)) did = true;
      // ★ 文件树那一半（`2.2.0` 收尾）：节点存在 `.nestmind` 里，板子这一层改不到 ——
      //   提交**之后**另走仓储（与节点菜单那条完全同源）。见 `deleteFileMindNodes`。
      if (edgeIds.length > 0 && removeEdges(board, edgeIds)) did = true;
      return did;
    });
    if (changed) this.selection.clear();
    // 文件树那一半（`2.2.0` 收尾 · 节点级框选）：板子提交完之后另走仓储
    if (nodeKeys.length > 0) this.deleteFileMindNodes(nodeKeys);
  }

  /**
   * 删除若干节点里属于**文件树**的那部分（`2.2.0` 收尾）。
   *
   * ★ 为什么分两步：内嵌树在**板子**里（一次 `commit` = 一步撤销），文件树的节点在
   *   `.nestmind` 里 —— 只能走 `mindRepository.mutate`（原子写 + revision + 冲突检测），
   *   与节点菜单那条路完全同源。两者写在同一个方法里的话，一次删除会同时动白板历史
   *   与另一份文件，撤销只能退一半。
   * ★ 解析失败的 `.nestmind`（保护态）会抛：一次写不进去不该把删除也弄崩。
   */
  private deleteFileMindNodes(keys: readonly string[]): void {
    const board = this.board;
    if (!board) return;
    const perPath = new Map<string, Set<string>>();
    for (const key of keys) {
      const { cardId, nodeId } = splitEndpointKey(key);
      if (nodeId === null) continue;
      const mind = (board.minds ?? []).find((item) => item.id === cardId);
      if (!mind || mind.path.length === 0) continue;
      const bucket = perPath.get(mind.path) ?? new Set<string>();
      bucket.add(nodeId);
      perPath.set(mind.path, bucket);
    }
    for (const [path, nodeIds] of perPath) {
      try {
        this.plugin.mindRepository.mutate(path, (mind) => removeNodes(mind, nodeIds));
      } catch {
        // 保护态 / 文件没了：跳过（其余几棵照删）
      }
    }
  }

  /**
   * ⌘D：原地复制（偏移 {@link DUPLICATE_OFFSET}）并选中副本。
   *
   * ★ 卡片与**整棵脑图**（`2.2.0` 批 4 五）一起复制，一次提交（一步撤销）：
   *   "我选了几样东西、按了 ⌘D"在用户眼里就是一个动作。
   * ★ 两边的复制都不带连线（`duplicateCards` / `duplicateMinds` 同一条口径）。
   */
  duplicateSelection(): void {
    const ids = [...this.selection.cardIds];
    const mindIds = [...this.selection.mindIds];
    if (ids.length === 0 && mindIds.length === 0) return;

    let clones: Card[] = [];
    let mindClones: Mind[] = [];
    const changed = this.commit(t('history.duplicate'), (board) => {
      clones = duplicateCards(board, ids, DUPLICATE_OFFSET);
      mindClones = duplicateMinds(board, mindIds, DUPLICATE_OFFSET);
      return clones.length > 0 || mindClones.length > 0;
    });
    // 选中副本而不是原对象：用户接着要拖 / 要删的显然是刚复制出来的那些
    if (changed) {
      this.selection.set({
        cards: clones.map((clone) => clone.id),
        minds: mindClones.map((clone) => clone.id),
      });
    }
  }

  /**
   * `⌘C`：把选中的卡片写进**系统剪贴板**（T4.15 / `F7-07`）。
   *
   * ★ 走系统剪贴板而不是插件内存：于是"跨白板"只是它能做的事情里最小的一件 ——
   *   跨窗口、跨库、跨"这次 Obsidian 会话"都一并成立（理由与格式见 `model/transfer.ts`）。
   * ★ 剪贴板里放的是一段**带标记的文本**：写不进去（权限 / 失焦 / 移动端 WebView）时
   *   必须明确告诉用户，否则他以为复制成功了，切到另一块板子上按 `⌘V` 才知道没有 ——
   *   那时已经找回不来了。
   *
   * @returns 真的写进剪贴板了才返回 `true`（`cutSelection` 靠它决定要不要删源卡）
   */
  async copySelection(): Promise<boolean> {
    const board = this.board;
    const ids = [...this.selection.cardIds];
    // ★ 整棵脑图也能进剪贴板（`2.2.0` 批 4 五）：载荷里多一个 `minds`
    const mindIds = [...this.selection.mindIds];
    const nodeKeys = [...this.selection.mindNodeKeys];
    if (!board || (ids.length === 0 && mindIds.length === 0 && nodeKeys.length === 0)) return false;

    // ★ **只有节点**被选中时走节点剪贴板（`2.2.0` 收尾 · 用户 2026-09-23）。
    //   节点是"某棵树内部"的东西：它只能粘到**另一棵树的某个节点下面** ⇒ 从前进卡片载荷
    //   （把每个节点抽成一个"合成容器"）是错的 —— 粘到白板空白处会凭空长出一棵棵树
    //   （用户报的"变成各种根节点了"）。
    // ★ 混合选中（卡片 / 整棵树 + 节点）仍走卡片那条：一次 `⌘V` 只有一个落点，
    //   而"卡片落画布、节点落某个节点下面"要用户先说清楚落哪儿 —— 宁可少搬，不乱搬。
    if (ids.length === 0 && mindIds.length === 0) return this.copyMindNodes(board, nodeKeys);

    const text = buildCardTransfer(board, ids, mindIds);
    if (text === null) return false;

    const ok = await this.clipboardBridge.writeText(text);
    // 计数把两者一起算：用户选的是"这些对象"，不关心它们内部是哪一类
    const count = ids.length + mindIds.length;
    new Notice(ok ? t('notice.copiedCards', { count }) : t('notice.copyFailed'));
    return ok;
  }

  /**
   * `⌘C` 落在**脑图节点**上：写进**节点剪贴板**（与 `.nestmind` 视图同一份格式）。
   *
   * ★ 只写节点，不写卡片 —— 于是"粘到白板空白处"自然不会长出任何东西（用户 2026-09-23）。
   * ★ 顺带多了一件事：在卡片里复制的节点可以直接粘进一个 `.nestmind` 视图，反之亦然
   *   （两边读写的是同一份载荷）。
   * ★ 系统剪贴板那一份写失败不影响用（内存那一份才是 `⌘V` 的主路径）—— 所以不看返回值。
   */
  private async copyMindNodes(board: BoardFile, nodeKeys: readonly string[]): Promise<boolean> {
    const built = buildNodeClipboard(board, nodeKeys);
    if (!built) {
      // 一个能复制的都没有（选中的都是**文件树**里的节点：内容在 `.nestmind` 里，读不到）
      new Notice(t('notice.mindNodeCopyUnsupported'));
      return false;
    }
    void writeMindClipboard(built.payload);
    if (built.payload.roots.length === 1) {
      new Notice(t('notice.mindCopied', { text: clipboardLabelOf(built.payload) }));
    } else {
      new Notice(t('notice.mindCopiedMany', { count: String(built.payload.roots.length) }));
    }
    if (built.skipped > 0) {
      new Notice(t('notice.mindNodeCopySkipped', { count: String(built.skipped) }));
    }
    return true;
  }

  /**
   * `⌘X`：复制到剪贴板后**从当前板删掉**。
   *
   * ★ 删除照旧走 `commit`，所以这是一次**可 `⌘Z` 撤销**的操作 —— 剪切之后又不想粘了，
   *   一次撤销就回来了。这也是"为什么敢立刻删"的全部理由：删的是当前板的卡片，
   *   它必须落在当前板的历史里；而"剪切成功但没粘贴"的用户损失只剩一次 `⌘Z`。
   * ★ 写剪贴板失败就**不删**：不能让用户的一次剪切把卡片弄丢（见 `copySelection`）。
   */
  async cutSelection(): Promise<void> {
    const copied = await this.copySelection();
    // `await` 期间用户可能已经切走 / 板子被改成只读：重新验一次再删
    if (!copied || this.isReadOnly()) return;
    this.deleteSelection();
  }

  /**
   * 把一份搬运载荷贴进当前板（`⌘V` 与"粘贴到另一块板"的共同落点）。
   *
   * ★ 落点用 `pasteAnchor()`（最后一次指针位置，纯键盘触发时退回视口中心）——
   *   与粘贴图片 / 拖入同一条准则：宁可落在中心，也别落在看不见的地方。
   * ★ 贴完**选中新卡片**：接着要拖 / 要挪的显然是它们（与 `duplicateSelection` 同一手感）。
   */
  private pasteCards(transfer: CardTransfer): void {
    let pasted: { cards: Card[]; minds: Mind[] } = { cards: [], minds: [] };
    const changed = this.commit(t('history.paste'), (board) => {
      pasted = pasteCardTransfer(board, transfer, this.pasteAnchor());
      return pasted.cards.length > 0 || pasted.minds.length > 0;
    });
    if (!changed) return;
    this.selection.set({
      cards: pasted.cards.map((card) => card.id),
      // ★ 贴出来的整棵也一起选中（`2.2.0` 批 4 五）：接着要拖 / 要挪的显然是它们
      minds: pasted.minds.map((mind) => mind.id),
    });
    new Notice(t('notice.pastedCards', { count: pasted.cards.length + pasted.minds.length }));
  }

  /**
   * 把节点剪贴板里的这一簇粘到**指针下的那个脑图节点**下面
   * （`2.2.0` 收尾 · 用户 2026-09-23："黏贴应该只能黏贴在脑图卡的具体节点上，
   * 在白板的其他位置黏贴是无效的"）。
   *
   * ★ 没有目标节点就**什么都不做**，只给一句话。不猜落点、也不新建一棵树 ——
   *   节点是树**内部**的东西，凭空给它找个落点就是用户报的那个 bug
   *   （"现在反而在白板的其他位置可以黏贴，变成各种根节点了"）。
   * ★ 目标取**指针**下的那个节点（与卡片粘贴的落点同一条准则：用户看哪儿就落哪儿），
   *   而不是"当前选中的节点"—— 复制之后源节点还选着，拿它当落点会把副本粘进自己里面。
   */
  private pasteMindNodes(payload: MindClipboard): void {
    const key = this.mindLayer?.nodeAt(this.pasteAnchor()) ?? null;
    const target = key ? this.mindNodeTarget(key) : null;
    if (!target) {
      new Notice(t('notice.mindPasteNeedsNode'));
      return;
    }
    this.pasteNodesInto(target.mind, target.nodeId, payload);
  }

  /** 一个节点端点键（`脑图id/节点id`）→ 它所在的脑图对象 + 节点 id */
  private mindNodeTarget(key: string): { mind: Mind; nodeId: string } | null {
    const { cardId, nodeId } = splitEndpointKey(key);
    if (nodeId === null) return null;
    const mind = (this.board?.minds ?? []).find((item) => item.id === cardId);
    return mind ? { mind, nodeId } : null;
  }

  /**
   * 把一簇节点插到 `mind` 的 `nodeId` 下面 —— `⌘V`（指针下的节点）与节点右键菜单的
   * 「粘贴」两处**共用**这一份落法。
   *
   * ★ 内嵌树与文件树都走 `mutateMind`：前者进白板撤销栈（`⌘Z` 退得动），后者写那份
   *   `.nestmind`（原子写 + revision + 冲突检测）—— 与节点菜单那些动作完全同路。
   * ★ 粘出来的节点**一起选中**（接着就能拖走 / 再复制）：与"粘卡片"那条手感一致。
   */
  private pasteNodesInto(mind: Mind, nodeId: string, payload: MindClipboard): void {
    let created: string[] = [];
    const changed = this.mutateMind(mind, (file) => {
      created = pasteForest(file, payload, nodeId) ?? [];
      return created.length > 0;
    });
    if (!changed || created.length === 0) return;
    this.selection.set({
      mindNodes: created.map((id) => nodeEndpointKey(mind.id, id)),
    });
  }

  /**
   * 切换选中卡片的标题显隐（`F2-00-9`）。
   *
   * 多选下唯一说得通的语义是"只要有一张在显示就全部收起，否则全部展开" ——
   * 逐张取反会让用户点一次就得到一堆状态各异的卡。
   */
  toggleSelectionTitle(): void {
    const ids = new Set(this.selection.cardIds);
    const cards = (this.board?.cards ?? []).filter((card) => ids.has(card.id));
    if (cards.length === 0) return;
    this.patchSelection(t('history.title'), { showTitle: !cards.some((card) => card.showTitle) });
  }

  /**
   * 切换选中卡片的锁定态（`⌘⇧L`，`F6-05`）。
   *
   * 与 {@link toggleSelectionTitle} 同一套多选语义：只要有一张没锁就把这批全锁上，
   * 否则全解锁 —— 逐张取反会得到一批"锁的锁、开的开"的卡，用户还得自己理清。
   * 锁定后不可拖动 / 缩放 / 改名（手柄也不显示），但仍可选中与改配色。
   */
  toggleSelectionLock(): void {
    const ids = new Set(this.selection.cardIds);
    const cards = (this.board?.cards ?? []).filter((card) => ids.has(card.id));
    if (cards.length === 0) return;
    this.patchSelection(t('history.lock'), { locked: !cards.every((card) => card.locked) });
  }

  /** ⌘⇧P：把选中的便签卡写成一个真实 `.md` 并替换为引用卡（T1.47） */
  promoteSelection(): void {
    const card = this.selectionOnlyCard();
    if (card) void this.promoteCard(card.id);
  }

  /**
   * 导出为 Markdown（T1.72 / `F9-01`）。
   *
   * 与 {@link promoteSelection} 是两条路：那个**改模型**（便签变引用卡），
   * 这个只产出一份副本，画布一个字节都不动 —— 所以它是**只读操作**，
   * 只读保护态下也放行（一块只能看不能改的板子更需要出口）。
   */
  exportMarkdown(): void {
    void this.runMarkdownExport();
  }

  private async runMarkdownExport(): Promise<void> {
    const path = this.currentPath;
    const board = this.board;
    if (!path || !board) return;

    try {
      const result = exportBoardToMarkdown(board, this.cardRegistry, { sourcePath: path });
      // 空板也落一个空文件只会让 Vault 更乱；"没内容可导"才是用户要知道的事
      if (result.exported === 0) {
        new Notice(t('notice.exportEmpty'));
        return;
      }

      const title = boardNameOf(path);
      const target = await new MarkdownExporter(this.plugin.vaultIO).export(result.markdown, {
        folder: boardFolderOf(path),
        name: noteNameFrom(title),
        sourcePath: path,
      });

      new Notice(
        result.skipped > 0
          ? t('notice.exportedSkipped', { path: target, count: result.skipped })
          : t('notice.exported', { path: target }),
      );
    } catch (error) {
      new Notice(t('notice.exportFailed', { error: describeError(error) }));
    }
  }

  /**
   * 导出为 PNG（T2.11 / `F9-02`）。先弹对话框收四个选项，再动手画。
   *
   * ★ 与 Markdown 导出一样是**只读操作**（只画不动模型），只读保护态下也放行。
   * ★ 空板也允许打开对话框：让用户看到"没有可导出的内容"这句解释，
   *   比命令直接消失好懂（`commands.ts` 里对 `exportMarkdown` 也是同样的取舍）。
   */
  exportPng(): void {
    new ExportPngModal(this.app, {
      hasSelection: this.hasSelectedObjects,
      summarize: (request) => this.summarizePng(request),
      onExport: (request) => {
        void this.runPngExport(request);
      },
    }).open();
  }

  /**
   * 对话框里的实时摘要（"会写几个文件、每张多大"）。
   *
   * ★ 面板不懂几何，页数与像素尺寸只能由视图算 —— 它同时回答了"这些选项意味着什么"，
   *   顺便当了"空板时禁用导出按钮"的判据（`ready`）。
   */
  private summarizePng(request: PngExportRequest): PngPlanSummary {
    const { plan } = this.pngPlanFor(request);
    if (plan.tiles.length === 0) {
      return { text: t('modal.exportPng.planEmpty'), ready: false };
    }
    // 分页时各块尺寸只差最后一列/行，摘要取第一块即可（那是最坏情况的上界）
    const width = Math.max(1, Math.round(plan.tiles[0].width * plan.scale));
    const height = Math.max(1, Math.round(plan.tiles[0].height * plan.scale));
    const text = request.paginate
      ? t('modal.exportPng.planTiled', {
          columns: plan.columns,
          rows: plan.rows,
          count: plan.tiles.length,
          width,
          height,
        })
      : t('modal.exportPng.planSingle', { width, height });
    return { text, ready: true };
  }

  /** 按当前选项算导出边界与分页（摘要与真正导出共用，两边绝不会算得不一样） */
  private pngPlanFor(request: PngExportRequest): { plan: PngPlan } {
    const board = this.board;
    if (!board) return { plan: planPngExport(null, request) };

    const bounds = resolveExportBounds(
      board,
      { ...request, mindModels: this.exportMindModels(board) },
      {
        // 视口取 `padding: 0`：用户按 ⌘0 之外的任何缩放，"当前视图"就是他此刻看到的那一屏，
        // 多带一圈预渲染缓冲会导出一块屏幕外其实什么都没有的空白
        viewportRect: request.range === 'viewport' ? this.viewport.visibleBounds(0) : null,
        selection: this.selectionSet(),
      },
    );
    return { plan: planPngExport(bounds, request) };
  }

  /**
   * 选区 id 集合（卡片 + 分栏 + **脑图**）：导出范围要能覆盖"只导我框选的那几个对象"。
   *
   * ★ 脑图（`2.2.0` 批 5）从这一批起也进得来 —— 它是白板级对象，和卡片 / 分栏一样
   *   在自己的 id 空间里；`resolveExportBounds` 那边按 id 去 `mindsOfBoard` 里挑。
   */
  private selectionSet(): ReadonlySet<string> {
    const ids = new Set<string>(this.selection.cardIds);
    for (const id of this.selection.columnIds) ids.add(id);
    for (const id of this.selection.mindIds) ids.add(id);
    return ids;
  }

  /**
   * 导出对话框里要不要给「仅选中」这一档（PNG / SVG / PDF / 打印四处共用）。
   *
   * ★ 四种对象一并算：少算一类就会出现"明明框住了一棵树，导出对话框里却没有
   *   '仅选中'"——而用户只会以为自己框选失败了。
   */
  private get hasSelectedObjects(): boolean {
    return (
      this.selection.cardIds.size > 0 ||
      this.selection.columnIds.size > 0 ||
      this.selection.mindIds.size > 0
    );
  }

  private async runPngExport(request: PngExportRequest): Promise<void> {
    const path = this.currentPath;
    const board = this.board;
    const canvas = this.canvasEl;
    if (!path || !board || !canvas) return;

    try {
      const { plan } = this.pngPlanFor(request);
      // 空板：不写任何文件（写一堆 1×1 的空图只会让 Vault 更乱）
      if (plan.tiles.length === 0) {
        new Notice(t('notice.exportEmpty'));
        return;
      }

      const palette = readPngPalette(canvas);
      const images = await this.loadExportImages(board);

      // 逐块画、逐块编码：一次把所有 canvas 都留在内存里，4K 分页时峰值会翻好几倍
      const pages: ArrayBuffer[] = [];
      for (const tile of plan.tiles) {
        const element = document.createElement('canvas');
        element.width = Math.max(1, Math.round(tile.width * plan.scale));
        element.height = Math.max(1, Math.round(tile.height * plan.scale));
        const ctx = element.getContext('2d');
        // 拿不到 2D 上下文基本只会发生在极端内存压力下：当场报错，别写出半张空图
        if (!ctx) throw new Error('nestboard: 2D canvas context is unavailable');
        renderTile(ctx, board, tile, {
          scale: plan.scale,
          transparent: request.transparent,
          background: board.view.background,
          gridSize: board.settings.gridSize,
          images,
          palette,
          // 文件脑图自己不在白板文件里（`2.2.0` 批 4）：它的模型住仓储内存里，得喂进去
          mindModels: this.exportMindModels(board),
        });
        pages.push(await canvasToArrayBuffer(element));
      }

      const title = boardNameOf(path);
      const folder = boardFolderOf(path);
      const written = await new PngExporter(this.plugin.vaultIO).export(pages, {
        folder,
        name: noteNameFrom(title),
      });

      new Notice(
        written.length > 1
          ? t('notice.pngExportedMany', {
              count: written.length,
              folder: folder.length > 0 ? folder : '/',
            })
          : t('notice.pngExported', { path: written[0] }),
      );
    } catch (error) {
      new Notice(t('notice.exportFailed', { error: describeError(error) }));
    }
  }

  /**
   * 导出为 SVG（T6.01 / `F9-06`）—— 矢量、无损缩放。
   *
   * ★ 与另外三条导出一样是**只读操作**（只画不动模型），只读保护态下也放行。
   * ★ 空板也允许打开对话框：让用户看到"没有可导出的内容"这句解释，
   *   比命令直接消失好懂（与 PNG / PDF 同一取舍）。
   * ★ 这里**没有"先载入图片"这一步**（也就用不上 `loadExportImages`）：本格式不内嵌位图，
   *   图片卡只保留文字 —— 这是它与 PNG / PDF 最实在的一处差别（见 `export/toSvg.ts` 文件头）。
   */
  exportSvg(): void {
    new ExportSvgModal(this.app, {
      hasSelection: this.hasSelectedObjects,
      summarize: (request) => this.summarizeSvg(request),
      onExport: (request) => {
        void this.runSvgExport(request);
      },
    }).open();
  }

  /**
   * 对话框里的实时摘要（"这一个文件有多大"）。
   *
   * ★ 顺便把"图片卡只留文字"这件事说出来：那是一次**安静**的降级，
   *   不说的话用户要等打开文件才会发现图没了。地图卡同理（它也是位图），所以一起数。
   */
  private summarizeSvg(request: SvgExportRequest): SvgPlanSummary {
    const plan = this.svgPlanFor(request);
    if (plan.width <= 0 || plan.height <= 0) {
      return { text: t('modal.exportSvg.planEmpty'), ready: false };
    }
    const width = Math.round(plan.width);
    const height = Math.round(plan.height);
    const images =
      this.board?.cards.filter((card) => card.type === 'image' || card.type === 'map').length ?? 0;
    const text =
      images > 0
        ? t('modal.exportSvg.planWithImages', { width, height, count: images })
        : t('modal.exportSvg.plan', { width, height });
    return { text, ready: true };
  }

  /** 按当前选项算导出边界（摘要与真正导出共用，两边绝不会算得不一样） */
  private svgPlanFor(request: SvgExportRequest): SvgPlan {
    // 脑图的模型喂进去（`2.2.0` 批 4）：取景要覆盖那些树，否则会被裁掉一半
    const models = this.board ? this.exportMindModels(this.board) : undefined;
    return planSvgExport(
      this.board,
      { ...request, mindModels: models },
      {
        // 视口取 `padding: 0`：理由与 PNG 相同（多带一圈预渲染缓冲会导出屏幕外的空白）
        viewportRect: request.range === 'viewport' ? this.viewport.visibleBounds(0) : null,
        selection: this.selectionSet(),
      },
    );
  }

  private async runSvgExport(request: SvgExportRequest): Promise<void> {
    const path = this.currentPath;
    const board = this.board;
    const canvas = this.canvasEl;
    if (!path || !board || !canvas) return;

    try {
      const plan = this.svgPlanFor(request);
      // 空板：不写文件（一个只有背景的空 SVG 只会让 Vault 更乱）
      if (plan.width <= 0 || plan.height <= 0) {
        new Notice(t('notice.exportEmpty'));
        return;
      }

      const svg = renderBoardSvg(board, plan, {
        background: board.view.background,
        gridSize: board.settings.gridSize,
        transparent: request.transparent,
        // 与取景同一份模型（`2.2.0` 批 4）：不然"框按树留好了、树却没画出来"
        mindModels: this.exportMindModels(board),
        // 调色板从画布上读：与 PNG / PDF 共用同一份变量来源，三种导出不会各自跑偏
        palette: readPngPalette(canvas),
      });

      const title = boardNameOf(path);
      const written = await new SvgExporter(this.plugin.vaultIO).export(svg, {
        folder: boardFolderOf(path),
        name: noteNameFrom(title),
      });

      new Notice(t('notice.svgExported', { path: written }));
    } catch (error) {
      new Notice(t('notice.exportFailed', { error: describeError(error) }));
    }
  }

  /**
   * 导出为 ZIP（T6.02 / `F9-07`）—— 把这块板和它引用的附件打成一个包。
   *
   * ★ 与另外几条导出一样是**只读操作**（只读文件、不动模型），只读保护态下也放行。
   * ★ 空板也允许打开对话框：归档里至少还有那份 `.nboard` 本身 —— 那正是
   *   "把这块板原样发出去"的最小可用形态，不是"没有可导出的内容"。
   * ★ 打进去的**板子正文用内存里那一份**（`serializeBoard(this.board)`）而不是重读文件：
   *   保存是防抖的，重读会拿到用户**上一次编辑之前**的样子 —— 而导出应该是眼前这样
   *   （与"另存为模板"同一条理由）。
   */
  exportZip(): void {
    const board = this.board;
    if (!board) return;

    // 计划只算一次：面板显示的是它，真正打包的也是它 —— 两边绝不会各算一套
    const plan = this.zipPlanFor(board);
    new ExportZipModal(this.app, {
      plan,
      onConfirm: () => {
        void this.runZipExport(board, plan);
      },
    }).open();
  }

  /**
   * 算"这块板要打包哪些附件"。
   *
   * ★ `exists` 用 Vault 的 `isFile`：与断链检测（`brokenRefsOf`）是同一套判定，
   *   于是"面板说缺了几张"与"卡片上的断链角标"永远对得上。
   */
  private zipPlanFor(board: BoardFile): ZipPlan {
    const io = this.plugin.vaultIO;
    return planZipExport(board, (path) => io.isFile(path));
  }

  private async runZipExport(board: BoardFile, plan: ZipPlan): Promise<void> {
    const path = this.currentPath;
    if (!path) return;

    try {
      const title = boardNameOf(path);
      const result = await new ZipExporter(this.plugin.vaultIO).export(
        {
          // 归档里保留源路径（含目录）：对方解压到库根，板与附件就都在原位
          boardPath: path,
          boardText: serializeBoard(board),
          plan,
          target: { folder: boardFolderOf(path), name: noteNameFrom(title) },
        },
        new Date(),
      );

      // 计划说有、真读时读不出来（用户边导边删）：当场说清少了几个，别静默过去
      const skipped = result.skipped.length;
      new Notice(
        skipped > 0
          ? t('notice.zipExportedSkipped', { path: result.path, count: skipped })
          : t('notice.zipExported', { path: result.path }),
      );
    } catch (error) {
      new Notice(t('notice.exportFailed', { error: describeError(error) }));
    }
  }

  /**
   * 导出为 PDF（T4.10 / `F9-03`）—— 真实多页 tile，每页一张 A4。
   *
   * ★ 与另外几条导出一样是**只读操作**（只画不动模型），只读保护态下也放行。
   * ★ 空板也允许打开对话框：让用户看到"没有可导出的内容"这句解释，
   *   比命令直接消失好懂（与 PNG 导出同一取舍）。
   */
  exportPdf(): void {
    new ExportPdfModal(this.app, {
      hasSelection: this.hasSelectedObjects,
      summarize: (request) => this.summarizePdf(request),
      onExport: (request) => {
        void this.runPdfExport(request);
      },
    }).open();
  }

  /**
   * 另存为模板（T4.14 / `F7-06`）。
   *
   * ★ 与导出同一类：**只读操作**（把眼前这份模型复制出去），只读保护态下也放行 ——
   *   "这块板锁住了，但我想拿它当模板"是很正常的一句话。
   * ★ 空板也允许：一块只有一张卡的小板完全可以是模板，
   *   这里没有"没有可导出的内容"那种硬门槛。
   * ★ 递给动作层的是 `this.board`（内存里那份）：会话是防抖保存的，
   *   重新读文件会拿到用户**上一次编辑之前**的样子，而模板应该长成眼前这样。
   */
  saveAsTemplate(): void {
    const board = this.board;
    if (!board) return;
    openSaveTemplateDialog(this.plugin, board);
  }

  /** 对话框里的实时摘要（"会写多少页、每页多大"）—— 面板不懂几何，只能由视图算 */
  private summarizePdf(request: PdfExportRequest): PdfPlanSummary {
    const plan = this.pdfPlanFor(request);
    const first = plan.pages[0];
    if (!first) return { text: t('modal.exportPdf.planEmpty'), ready: false };
    return {
      text: t('modal.exportPdf.planTiled', {
        count: plan.pages.length,
        columns: plan.columns,
        rows: plan.rows,
        width: first.pixelWidth,
        height: first.pixelHeight,
      }),
      ready: true,
    };
  }

  /** 按当前选项算导出边界与分页（摘要与真正导出共用，两边绝不会算得不一样） */
  private pdfPlanFor(request: PdfExportRequest): PdfPlan {
    const board = this.board;
    if (!board) return planPdfExport(null, request);

    const bounds = resolveExportBounds(
      board,
      { ...request, mindModels: this.exportMindModels(board) },
      {
        // 视口取 `padding: 0`：理由与 PNG 相同（多带一圈预渲染缓冲会导出屏幕外的空白）
        viewportRect: request.range === 'viewport' ? this.viewport.visibleBounds(0) : null,
        selection: this.selectionSet(),
      },
    );
    return planPdfExport(bounds, request);
  }

  private async runPdfExport(request: PdfExportRequest): Promise<void> {
    const path = this.currentPath;
    const board = this.board;
    const canvas = this.canvasEl;
    if (!path || !board || !canvas) return;

    try {
      const plan = this.pdfPlanFor(request);
      if (plan.pages.length === 0) {
        new Notice(t('notice.exportEmpty'));
        return;
      }

      const palette = readPngPalette(canvas);
      const images = await this.loadExportImages(board);
      const title = boardNameOf(path);

      // 逐页画、逐页编码：一次把所有 canvas 都留在内存里，十几页 4K 图能把标签页
      // 直接拖死（与 PNG 逐块写同一条理由，只是这里的峰值更高）
      const pages: PdfPageImage[] = [];
      for (const page of plan.pages) {
        const element = document.createElement('canvas');
        element.width = page.pixelWidth;
        element.height = page.pixelHeight;
        const ctx = element.getContext('2d');
        // 拿不到 2D 上下文基本只会发生在极端内存压力下：当场报错，别凑出一本缺页的 PDF
        if (!ctx) throw new Error('nestboard: 2D canvas context is unavailable');
        renderTile(ctx, board, page, {
          scale: plan.scale,
          // PDF 里的图是 JPEG，**没有 alpha** —— 底色必须铺上（见 toPdf.ts 文件头）
          transparent: false,
          background: board.view.background,
          gridSize: board.settings.gridSize,
          images,
          palette,
          // 文件脑图自己不在白板文件里（`2.2.0` 批 4）：它的模型住仓储内存里，得喂进去
          mindModels: this.exportMindModels(board),
        });
        // 页码画进**位图**：PDF 里写中文要嵌字体子集，位图零成本且绝不会变方框
        drawPageFooter(ctx, {
          width: element.width,
          height: element.height,
          page: page.index + 1,
          total: plan.pages.length,
          label: title,
          palette: {
            background: palette.background,
            text: palette.cardText,
            fontFamily: palette.fontFamily,
          },
        });
        pages.push({
          jpeg: new Uint8Array(await canvasToJpeg(element)),
          pixelWidth: element.width,
          pixelHeight: element.height,
          draw: page.draw,
        });
      }

      const bytes = buildPdf({
        pageWidth: plan.pageWidth,
        pageHeight: plan.pageHeight,
        pages,
        title,
        createdAt: new Date(),
      });
      // `buildPdf` 只在"一页都没有"时给 null（有页但画失败会抛错，走下面的 catch）
      if (!bytes) {
        new Notice(t('notice.exportEmpty'));
        return;
      }

      const written = await new PdfExporter(this.plugin.vaultIO).export(bytes, {
        folder: boardFolderOf(path),
        name: noteNameFrom(title),
      });
      new Notice(
        plan.pages.length > 1
          ? t('notice.pdfExportedPages', { count: plan.pages.length, path: written })
          : t('notice.pdfExported', { path: written }),
      );
    } catch (error) {
      // 单独一条失败文案：PDF 失败的原因和另外几条不一样（大多是某页画不出来 / 编码不出来），
      // 复用 `notice.exportFailed` 会少掉"PDF"这个线索
      new Notice(t('notice.pdfFailed', { reason: describeError(error) }));
    }
  }

  /**
   * 打印（T6.03 / `F9-10`）。
   *
   * ★ 与另外几条导出一样是**只读操作**（只画不动模型），只读保护态下也放行。
   * ★ 空板也允许打开对话框：让用户看到"没有可打印的内容"这句解释，
   *   比命令直接消失好懂（与 PNG / PDF 导出同一取舍）。
   * ★ 与"导出 PDF"**共用同一套分页**（见 `toPrint.ts` 文件头）——
   *   打印出来的页数与每页内容，和导出 PDF 永远一致。
   */
  printBoard(): void {
    new ExportPrintModal(this.app, {
      hasSelection: this.hasSelectedObjects,
      summarize: (request) => this.summarizePrint(request),
      onPrint: (request) => {
        void this.runPrintBoard(request);
      },
    }).open();
  }

  /** 对话框里的实时摘要（"会印几页"）—— 面板不懂几何，只能由视图算 */
  private summarizePrint(request: PrintExportRequest): PrintPlanSummary {
    const plan = this.printPlanFor(request);
    if (plan.pages.length === 0) {
      return { text: t('modal.exportPrint.planEmpty'), ready: false };
    }
    return {
      text: t('modal.exportPrint.planTiled', {
        count: plan.pages.length,
        columns: plan.columns,
        rows: plan.rows,
      }),
      ready: true,
      // 只有真会跨页时才提示"分幅"（单页板子上说它纯属噪音）
      hint: posterHint(plan)
        ? t('modal.exportPrint.posterHint', { columns: plan.columns, rows: plan.rows })
        : undefined,
    };
  }

  /** 按当前选项算导出边界与分页（摘要与真正打印共用，两边绝不会算得不一样） */
  private printPlanFor(request: PrintExportRequest): PdfPlan {
    const board = this.board;
    if (!board) return planPrintExport(null, request);

    const bounds = resolveExportBounds(
      board,
      { ...request, mindModels: this.exportMindModels(board) },
      {
        // 视口取 `padding: 0`：理由与 PNG / PDF 相同（多带一圈预渲染缓冲会印出屏幕外的空白）
        viewportRect: request.range === 'viewport' ? this.viewport.visibleBounds(0) : null,
        selection: this.selectionSet(),
      },
    );
    return planPrintExport(bounds, request);
  }

  private async runPrintBoard(request: PrintExportRequest): Promise<void> {
    const path = this.currentPath;
    const board = this.board;
    const canvas = this.canvasEl;
    if (!path || !board || !canvas) return;

    try {
      // 重算一遍再印（与 `.canvas` 导出同一条理由：对话框是异步的，用户可能中途改了板子）
      const plan = this.printPlanFor(request);
      if (plan.pages.length === 0) {
        new Notice(t('notice.exportEmpty'));
        return;
      }

      const palette = readPngPalette(canvas);
      const images = await this.loadExportImages(board);
      const title = boardNameOf(path);

      // 逐页画、逐页编码：与 PDF 同一条理由，把所有 canvas 同时留在内存里会把标签页拖死
      const pages: PrintPageImage[] = [];
      for (const page of plan.pages) {
        const element = document.createElement('canvas');
        element.width = page.pixelWidth;
        element.height = page.pixelHeight;
        const ctx = element.getContext('2d');
        if (!ctx) throw new Error('nestboard: 2D canvas context is unavailable');
        renderTile(ctx, board, page, {
          scale: plan.scale,
          // 打印产物是 JPEG（无 alpha），底色必须铺上（与 PDF 同一条理由）
          transparent: false,
          background: board.view.background,
          gridSize: board.settings.gridSize,
          images,
          palette,
          // 文件脑图自己不在白板文件里（`2.2.0` 批 4）：它的模型住仓储内存里，得喂进去
          mindModels: this.exportMindModels(board),
        });
        // ★ 页脚**不画进位图**：打印文档是 HTML，真文字比位图清楚、也省一次绘制
        pages.push({
          dataUrl: element.toDataURL('image/jpeg', DEFAULT_PRINT_QUALITY),
          width: element.width,
          height: element.height,
          index: page.index,
        });
      }

      const html = buildPrintDocument({
        pages,
        orientation: plan.orientation,
        title,
        // 单页不印页脚：页脚是给"拼贴"用的，一张纸上的"第 1 / 1 页"是废话
        footer: (page, total) =>
          total > 1 ? t('print.footer.page', { label: title, page, total }) : null,
      });

      await this.printHtml(html);
    } catch (error) {
      // 单独一条失败文案并**指向 PDF**：打印要借宿主的浏览器对话框，宿主不给这条路时，
      // "导出为 PDF 再打"才是用户真正能走通的替代方案，比一句"打印失败"有用得多
      new Notice(t('notice.printFailed', { reason: describeError(error) }));
    }
  }

  /**
   * 把一份打印文档交给宿主去印。
   *
   * ── 为什么是隐藏 iframe，而不是 `window.open` ─────────────────
   *
   * 新开窗口会被弹窗拦截（用户还会看到一个白窗口闪一下）；iframe 与主文档同源，
   * `contentWindow.print()` 直接可用，用完即弃 —— 打印本就不该在库里留下任何东西。
   *
   * ★ iframe 是 0×0、`position: fixed`：不参与布局、不遮挡界面。`window.print()`
   *   印的是**它自己那份文档**、由 `@page` 决定纸面，与 iframe 元素的尺寸无关 ——
   *   所以 0 尺寸不会印出空白（这一点与"截屏元素"的直觉相反，值得写下来）。
   * ★ 清理挂三条线：`afterprint`（正常路径）、超时兜底（有的宿主不发 `afterprint`）、
   *   `catch`（出错时立刻收摊）—— 少一条就会积下一个看不见的 iframe。
   */
  private async printHtml(html: string): Promise<void> {
    const frame = document.createElement('iframe');
    frame.className = 'nestboard-print-frame';
    frame.setAttribute('aria-hidden', 'true');
    document.body.appendChild(frame);

    const win = frame.contentWindow;
    const doc = frame.contentDocument;
    if (!win || !doc) {
      frame.remove();
      throw new Error('nestboard: the print frame could not be created');
    }

    let timer: number | null = null;
    const cleanup = (): void => {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
      frame.remove();
    };

    try {
      await new Promise<void>((resolve) => {
        // 兜底：图片没加载完也不能把"打印"永远吊住 —— 到点照样印，宁可少等
        const deadline = window.setTimeout(resolve, PRINT_LOAD_TIMEOUT_MS);
        frame.addEventListener(
          'load',
          () => {
            window.clearTimeout(deadline);
            resolve();
          },
          { once: true },
        );
        // `doc.write` 已被标为过时，但这里正是它的正当用法：往一个全新、同源的空文档里
        // 一次性写入整份 HTML（`srcdoc` 会把整份文档塞进属性、转义两次，更难读）
        doc.open();
        doc.write(html);
        doc.close();
      });

      // data URL 的图片解码可能还排在下一帧之后：等一帧再印，免得印出空白页
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));

      timer = window.setTimeout(cleanup, PRINT_CLEANUP_MS);
      win.addEventListener('afterprint', cleanup);
      win.focus();
      win.print();
    } catch (error) {
      cleanup();
      throw error;
    }
  }

  /**
   * 导出为 JSON Canvas（T4.11 / T4.13 / `F9-04`）。
   *
   * 与另外两条导出一样是**只读操作**（只产出一份副本），只读保护态下也放行。
   * 与它们不同的是它**先开对话框报损失**：`.canvas` 是给别人 / 别的工具看的中转格式，
   * 四种卡片没有对应节点、悬空连线表达不了，而这些损失不会报错、只会在对面静默消失。
   *
   * ★ 空板直接给提示、不开对话框：它没有任何选项，开出来只会是一句"什么都没有"，
   *   而"没内容可导"才是用户要知道的事（与 Markdown 导出的取舍一致）。
   */
  exportCanvas(): void {
    const path = this.currentPath;
    const board = this.board;
    if (!path || !board) return;

    const plan = planCanvasExport(board, this.cardRegistry, { sourcePath: path });
    if (plan.nodes === 0 && plan.groups === 0) {
      new Notice(t('notice.exportEmpty'));
      return;
    }

    new ExportCanvasModal(this.app, {
      plan,
      onConfirm: () => {
        void this.runCanvasExport();
      },
    }).open();
  }

  /**
   * 真正写盘。
   *
   * ★ **重新算一遍**计划再写，而不是把对话框里那份拿来用：对话框是异步的，用户可能
   *   在这期间改了板子（删掉几张卡、连了一条线）。重算的代价是一次纯函数遍历，
   *   而用旧计划写出去就是"文件内容和对话框上说的不一致" —— 那种不一致没人查得出来。
   * ★ **绝不覆盖**：`uniquePath` 顺延命名。导出物是"再生成"的，但 `.canvas` 里可能
   *   已经有用户在 Obsidian 画布里接着画的成果，覆盖它等于毁掉别人的工作。
   */
  private async runCanvasExport(): Promise<void> {
    const path = this.currentPath;
    const board = this.board;
    if (!path || !board) return;

    try {
      const plan = planCanvasExport(board, this.cardRegistry, { sourcePath: path });
      const title = boardNameOf(path);
      const target = await uniquePath(
        boardFolderOf(path),
        noteNameFrom(title),
        `.${CANVAS_EXT}`,
        (candidate) => this.plugin.vaultIO.exists(candidate),
      );

      await this.plugin.vaultIO.create(target, plan.text);
      new Notice(t('notice.exportCanvasDone', { path: target }));
    } catch (error) {
      new Notice(t('notice.exportCanvasFailed', { message: describeError(error) }));
    }
  }

  /**
   * 预加载 PNG 里要用到的位图（图片卡 + 地图卡）。
   *
   * ★ 图片卡是白板上最常见的"内容本身"，导出时只画个灰框是明显不合格的；地图卡同理 ——
   *   它的全部内容就是那张地图图，不预加载就等于导出一个只有地点名的空框。
   *   这里按 `notesBridge.resourceUrl` 取真实资源，一张解码失败就**只让那一张**
   *   退回占位文字 —— 不能让一张坏图毁掉整次导出。
   */
  private async loadExportImages(board: BoardFile): Promise<Map<string, CanvasImageSource>> {
    const images = new Map<string, CanvasImageSource>();
    const bridge = this.notesBridge;
    if (!bridge) return images;

    const paths = new Set<string>();
    for (const card of board.cards) {
      if ((card.type === 'image' || card.type === 'map') && card.content.path.length > 0) {
        paths.add(card.content.path);
      }
    }
    // ★ 脑图节点上的**图片附件**（`2.2.0` 批 4 六）：它和图片卡一样是"内容本身"，
    //   不预加载的话导出里只能画一块底纹 —— 而画布上那里是有图的。
    //   ★ 模型来源用 `mindModelForMap`（内嵌的直接读、文件脑图只在**已经读到**时给）：
    //     这里绝不触发读盘，没读到的那一棵按"这一帧不画"处理，与缩略图同一条口径。
    for (const mind of board.minds ?? []) {
      const model = this.mindModelForMap(mind);
      if (!model) continue;
      for (const node of model.nodes) {
        const ref = firstRefOf(node);
        if (ref?.kind === 'image' && ref.path.length > 0) paths.add(ref.path);
      }
    }

    await Promise.all(
      [...paths].map(async (path) => {
        const url = bridge.resourceUrl(path);
        if (!url) return;
        const decoded = await loadCanvasImage(url);
        if (decoded) images.set(path, decoded);
      }),
    );
    return images;
  }

  /**
   * 打开诊断信息面板（T2.17 / `02 §8.3`）。
   *
   * ★ 纯读：不写盘、不改模型、不改视图状态，只读保护态下也放行。
   * ★ 采集**按需**（打开时 + 点刷新），不做常驻轮询：面板要数 DOM 节点、读磁盘
   *   `stat`，常驻等于给被测对象本身加负担 —— 那样量出来的数字不可信。
   */
  showDiagnostics(): void {
    new DiagnosticsModal(this.app, () => this.collectDiagnostics()).open();
  }

  /** 采集一次诊断事实（T2.17）。拿不到的项一律填 `null`，不编造 0 */
  private async collectDiagnostics(): Promise<DiagnosticsRow[]> {
    const path = this.currentPath;
    const board = this.board;
    const canvas = this.canvasEl;
    if (!path || !board || !canvas) return [];

    // 文件大小以**磁盘上的实际值**为准（`stat`）：模型里的数字都是"打算写成什么"，
    // 而诊断要回答的是"现在到底占了多少"
    const stat = await this.plugin.vaultIO.stat(path);

    return formatDiagnostics({
      path,
      fileBytes: stat?.size ?? null,
      cards: board.cards.length,
      columns: board.columns.length,
      edges: board.edges.length,
      domNodes: canvas.querySelectorAll('*').length,
      renderedCards: this.cardLayer?.renderedCount ?? 0,
      pooledCards: this.cardLayer?.pooledCount ?? 0,
      renderedColumns: this.columnLayer?.renderedCount ?? 0,
      zoom: this.viewport.zoom,
      thumbs: this.thumbnailBridge?.stats() ?? null,
      save: this.plugin.repository.statsOf(path),
      pendingFrames: this.frameQueue.size,
    });
  }

  /**
   * 重命名 / 移动当前白板（T1.73 / `F7-05`）。
   *
   * ★ 走 `app.fileManager.renameFile` 而**不是** `vault.rename`：官方在 `Vault.rename`
   *   的注释里就写了"要自动改链接请用 `FileManager.renameFile`"。后者会按用户偏好
   *   同步全库的反向链接 —— 别人笔记里的 `[[这块白板]]` 跟着改名；前者只挪文件，
   *   留下一地断链。
   *
   * 只读态也放行：改名动的是**文件**，不是画布内容，不该被"这块板被外部改过"挡住。
   */
  renameBoard(): void {
    const path = this.currentPath;
    if (!path) return;

    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;

    new RenameBoardModal(this.app, file, (newPath) => {
      void this.applyRename(file, newPath);
    }).open();
  }

  private async applyRename(file: TFile, newPath: string): Promise<void> {
    try {
      await this.app.fileManager.renameFile(file, newPath);
      // ★ 路径跟随**不在这里**做：`vault.on('rename')` 随后就会触发，
      //   `FileView.onRename` 钩子与 `main.ts` 的兜底都会走到 `retargetPath`。
      //   在这里再改一次只会和它们抢时序（谁先谁后还不一定）。
    } catch (error) {
      new Notice(t('notice.renameFailed', { error: describeError(error) }));
    }
  }

  /** ⌘Z */
  undo(): void {
    this.applyHistory('undo');
  }

  /** ⌘⇧Z */
  redo(): void {
    this.applyHistory('redo');
  }

  // ── 画布装配 ────────────────────────────────────────────

  private ensureCanvas(): void {
    if (!this.canvasEl) this.buildCanvas();
  }

  private buildCanvas(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass('nestboard-root');
    // 平台标记打在根上（T3.21）：工具条自己的 `is-mobile` 只管它自己的方向，
    // 而像"空板引导要避开底部那条横栏"这种事需要**按平台改别人的样式** ——
    // 根上有一个标记，这类调整就都写成一条 CSS 选择器，不必再往 JS 里塞几何计算
    root.toggleClass('is-mobile', Platform.isMobile);

    // 卡片定义需要"读真实笔记"的能力（引用卡 T1.42–T1.45），但 `cards/` 层不许
    // import obsidian —— 所以在这里造好实现、以接口注入（见 `CardRenderContext.notes`）
    this.notesBridge = new ObsidianLinkBridge(this.app);
    this.shellBridge = new ObsidianShellBridge(this.app);
    // 缩略图管线（T1.51/T1.52）：缓存里留着 objectURL，所以**必须**跟着视图一起释放
    // （见 `teardownCanvas` 里的 `dispose()`）——否则每开一块白板就漏一批 blob
    this.thumbnailBridge = new ObsidianThumbnailBridge(this.app);
    // 板级缩略图（T4.16 / `F2-8-2`）：同一套缓存，画的是"整块板"。
    // ★ `root` 作为主题色宿主 —— 缩略图里卡片用的颜色必须和这个视图里看到的一致
    this.boardThumbBridge = new ObsidianBoardThumbnailBridge(this.app, root);
    // 外链能力（T2.04–T2.06）：两个闭包分别读"总开关"与"落盘附件"。
    // ★ 都是闭包而不是快照值：用户在设置里打开开关后，**已经开着的白板**下一次
    //   点"获取预览"就该生效，不必关掉视图再开
    this.linkPreviewBridge = new ObsidianLinkPreviewBridge({
      enabled: () => this.plugin.settings.linkPreview,
      // 域名黑名单（T6.06 / F2-4-6）：同样是闭包 —— 用户刚加进黑名单的站，
      // 现有视图下一次抓取就该被拦住（见 `LinkPreviewHost.blockedHosts`）
      blockedHosts: () => this.plugin.settings.linkPreviewBlocklist,
      importImage: (data, name) => this.plugin.importPreviewImage(data, name),
    });
    // 静态地图瓦片（`O08`）：同样是两个闭包 —— 用户在设置里挑好服务商（或换一档）
    // 之后，已经开着的白板下一次"粘贴地图链接"就该用新的那一档
    this.mapTileBridge = new ObsidianMapTileBridge({
      provider: () => this.plugin.settings.mapTileProvider,
      key: () => this.plugin.settings.mapTileKey,
      importImage: (data, name) => this.plugin.importPreviewImage(data, name),
    });
    this.promoter = new NotePromoter(this.plugin.vaultIO);

    // 面包屑（T1.62）挂在**根节点**上、覆盖在画布之上：
    // ★ 不能塞进画布 —— 画布里的一切都跟着 world 的 transform 走，缩放 30% 时
    //   面包屑只有几个像素高，既看不清也点不中。导航控件必须活在屏幕坐标系里。
    this.breadcrumb = new Breadcrumb(root, {
      onNavigate: (path) => void this.openNestedBoard(path),
      onBack: () => this.navigateBack(),
      onForward: () => this.navigateForward(),
      canGoBack: () => this.canNavigateBack,
      canGoForward: () => this.canNavigateForward,
    });

    // 顶栏性能提示（T2.16 / `02 §8.3`）：默认藏着，`refreshScaleHint` 决定要不要露面。
    // ★ 与面包屑同理挂在根节点上：不能塞进画布，否则缩放 30% 时提示文字只有几个像素高
    this.scaleHintEl = root.createDiv({ cls: 'nestboard-scale-hint is-hidden' });

    // 归档锁定提示条（T4.06 / `03 §2.5`）。
    // ★ 内容一次建好、之后只切 `is-hidden`：提示里有个「解锁」按钮，每次内容变化都
    //   `empty()` 重建的话，正在按它的那次点击会被自己拆掉（按钮从 DOM 里消失，
    //   `click` 不再派发）—— 表现是"偶尔点解锁没反应"，极难复现。
    // ★ 位置贴在面包屑下方（见 styles.css）：左上角是面包屑、右上角是性能提示与
    //   「更多」按钮（O11），底下是工具条。
    this.lockHintEl = root.createDiv({ cls: 'nestboard-lock-hint is-hidden' });
    this.lockHintEl.createSpan({
      cls: 'nestboard-lock-hint__text',
      text: t('board.lockHint'),
    });
    const unlockButton = this.lockHintEl.createEl('button', {
      cls: 'nestboard-lock-hint__btn',
      text: t('board.lockHint.unlock'),
    });
    unlockButton.setAttribute('aria-label', t('board.lockHint.unlockAria'));
    unlockButton.addEventListener('click', () => void this.setBoardLocked(false));

    // 待办总览浮层（T3.03 / `F2.5`）：默认藏着，由命令切换。
    // ★ 只读板也允许打开（`canToggle` 为 false 时复选框禁用）：看清单不改文件，
    //   而"这块板上还剩什么"恰恰是接手别人板子时最想问的问题。
    this.todoOverview = new TodoOverview(root, {
      board: () => this.board,
      canToggle: () => !this.isReadOnly(),
      onPick: (entry) => this.revealCard(entry.cardId),
      onToggle: (entry) => this.completeTodoEntry(entry),
    });

    // 画布过滤条（T3.17 / T3.18）：屏幕坐标系、常驻但默认藏着，由命令切换。
    // ★ 状态由本视图持有（`cardFilter`）：条子只翻译输入控件，重画卡片是视图的事。
    this.filterBar = new CardFilterBar(root, {
      filter: () => this.cardFilter,
      counts: () => {
        const board = this.board;
        if (!board) return { matched: 0, total: 0 };
        return {
          matched: matchedCount(board, this.cardFilter, (id) => this.brokenCardIds.has(id)),
          total: board.cards.length,
        };
      },
      onChange: (next) => this.applyCardFilter(next),
    });

    // 断链总览浮层（T3.19 / `F8-07`）：与待办浮层同形，点一条就飞到那张卡。
    this.linkOverview = new LinkOverview(root, {
      entries: () => this.brokenRefs,
      onPick: (ref) => this.revealCard(ref.cardId),
      // 「修复引用」的入口就摆在这份清单上（T4.07）：用户盯着断链看的这一刻，
      // 恰恰是最想修它们的这一刻。命令面板里那条也留着（两处共用 `openRefRepair`）
      canRepair: () => this.canRepairRefs,
      onRepair: () => void this.openRefRepair(),
    });

    // 主工具条（T3.21 / T3.27 / `02 §2`）。
    // ★ 桌面是左侧悬浮竖条、移动端是底部横向滚动条 —— 两种形态共用同一份 DOM，
    //   只由 `.is-mobile` 换方向，所以"手机上少一个按钮"这种分叉不可能发生。
    this.toolbar = new Toolbar(root, {
      items: () => this.toolbarItems(),
      isOverCanvas: (client) => this.canvasContains(client),
    });
    this.toolbar.setMobile(Platform.isMobile);
    this.toolbar.render();

    // 缩略图导航器（T5.09 / `F1-06`）：挂在**根容器**（与工具条、面包屑同级）而不是
    // 画布内部 —— 它是屏幕坐标的浮层，进 `world` 会跟着缩放平移跑掉。
    // ★ 三个回调都在本视图里落地：面板自己不认识 `Viewport`、不认识设置、不认识模型。
    this.minimap = new Minimap(root, {
      // 脑图也是"板上的东西"（`2.2.0` 批 4）：节点要在地图上占位，否则一棵大树
      // 在缩略图里完全不存在 —— 地图与现实对不上，比画不准更让人困惑
      shapes: () =>
        minimapShapes(this.board, { mindModelOf: (mind) => this.mindModelForMap(mind) }),
      camera: () => ({
        x: this.viewport.x,
        y: this.viewport.y,
        zoom: this.viewport.zoom,
        width: this.viewport.width,
        height: this.viewport.height,
      }),
      // "点哪儿去哪儿"：把视口中心挪到那个世界坐标（与跳转到卡片用同一条路）
      onNavigate: (world) => {
        this.viewport.centerOn(world);
      },
      // 面板上的 `×` 与命令走同一个入口：显隐只有一个真源（设置）
      onRequestHide: () => this.setMinimapVisible(false),
    });
    this.minimap.setVisible(this.plugin.settings.minimap);

    // 空板引导（T3.21）：一块什么都没有的白板，光看是一块灰格子 ——
    // 用户不一定意识到"左边那条竖条是用来建卡的"。
    // ★ 桌面说"用工具条"，移动端说"把底部那条上的按钮拖过来"：两边的
    //   发现路径完全不同（移动端没有 hover，`title` 也不会先弹出来）。
    // ★ `aria-hidden`：这句话与画布的操作提示（`aria-describedby`）内容重叠，
    //   读屏用户已经听过一遍了 —— 不藏起来就是每次聚焦都听两遍
    this.emptyHintEl = root.createDiv({
      cls: 'nestboard-empty-hint',
      text: Platform.isMobile ? t('notice.mobileToolbarHint') : t('notice.emptyBoardHint'),
    });
    this.emptyHintEl.setAttribute('aria-hidden', 'true');

    // 长按检测（T3.21）：移动端没有右键，卡片菜单只能靠长按唤出。
    // ★ 它不发 DOM、不读时钟，定时器由它自己管；这里只把"到点了"翻译成一次菜单
    this.longPress = new LongPressDetector((point) => this.showCardMenuAtPoint(point));
    // 空白处的长按 = 画布菜单（同一张菜单，右键的另一个入口）
    this.canvasLongPress = new LongPressDetector((point) => this.onCanvasLongPress(point));

    const canvas = root.createDiv({ cls: 'nestboard-canvas' });
    canvas.setAttribute('tabindex', '0');
    canvas.setAttribute('role', 'application');
    canvas.setAttribute('aria-label', t('view.canvas.ariaLabel'));
    // ★ 操作提示走 `aria-describedby` 而不是塞进 `aria-label`：读屏会把两者连着念，
    //   而"叫什么"与"怎么用"是两件事 —— 混在一起之后，用户每次聚焦画布都要重听一遍用法
    const canvasHintId = `nestboard-canvas-hint-${this.instanceId}`;
    canvas.setAttribute('aria-describedby', canvasHintId);
    const canvasHintEl = root.createDiv({
      cls: 'nestboard-visually-hidden',
      text: canvasA11yHint(),
    });
    canvasHintEl.setAttribute('id', canvasHintId);
    // 卡片提示（T3.26）：每张卡的 `aria-describedby` 都指向这一行。
    // ★ 共用一行而不是每卡一份：内容**逐字相同**，几百张卡各存一份字符串
    //   是纯粹的浪费（而读屏念出来的效果完全一样）
    const cardHintEl = root.createDiv({ cls: 'nestboard-visually-hidden', text: cardA11yHint() });
    cardHintEl.setAttribute('id', this.cardHintId);

    this.canvasEl = canvas;
    this.background = new BackgroundLayer(canvas);

    // 连线层：屏幕坐标画布，铺满容器（不进 world，否则会被 CSS transform 把栅格拉糊）。
    // 早于 world 创建，加上 CSS 的 z-index，保证连线从卡片**背后**穿过（02 §2 层级③）
    this.edgeLayer = new EdgeLayer(canvas);

    // 连线怎么画（T1.69）交给 painter：本层只管"哪块脏了 + 坐标系摆好"。
    // ★ painter 只在**标脏时**才被调用（`EdgeLayer.render`），静止时一帧都不执行；
    //   它内部读主题色用的是计算值 —— canvas 不认 `var(--color-red)`
    this.edgeLayer.setPainter(
      createEdgePainter({
        host: canvas,
        // ★ 画线用的板子要把收起编组的成员摘掉（O03）：与 `cardRectLookup` 同一个
        //   理由 —— 端点取不到矩形的线 `edgePolyline` 直接返回 `null`，一笔都不画
        getBoard: () => this.boardForEdges(),
        getSelected: () => this.selection.edgeIds,
        // 拖动中的临时几何（T1.70）：卡片被拖着走时锚点必须跟着手。
        // ★ 走 `visualOverrides()` 而不是 `dragPreviewRects`：栏内滚动（T2.03）
        //   也会把卡片挪位置，连线同样得跟着 —— 否则滚过栏之后，
        //   线还拴在"卡片原来待着的地方"（一幅看起来像 bug 的画）
        getOverrideRects: () => this.visualOverrides(),
        // 拖动中的临时旋转角（T7.06）：与上面那份临时几何同一条理由 ——
        // 转一张接了线的卡时，锚点必须跟着转，否则线头会浮在卡片外面
        getOverrideAngles: () => this.dragRotation,
        // 拖动中的临时弧度（T7.12）：同上 —— 拖弧度手柄时模型没变，线却要跟着手弯
        getOverrideCurves: () => this.dragCurve,
        // 脑图节点端点（`2.2.0` 批 3）：键是 `脑图id/节点id`，盒子由渲染层实测。
        // ★ 每次重绘取一次（painter 一帧只调一次）—— 与命中侧 `cardRectLookup`
        //   用的是同一个方法，画出来的线与点得中的线因此永远是同一份几何。
        getNodeRects: () => this.mindLayer?.nodeRects() ?? null,
      }),
    );

    // 世界容器：唯一挂 transform 的元素（GPU 合成，平移缩放零重排，02 §8.2）
    const world = canvas.createDiv({ cls: 'nestboard-world' });
    world.setAttribute('data-card-layer', 'true'); // T1.24 CardLayer 的挂载点
    // 无障碍（T3.26）：读屏在画布里遇到的第一个有名字的容器就是它 ——
    // "白板，共 12 张卡片"让用户先建立整体规模的印象，再逐张 Tab 过去。
    // ★ 名字里的卡片数在 `syncCanvas` 里按需更新（见 `lastBoardAriaLabel`）
    world.setAttribute('role', 'group');

    this.worldEl = world;
    this.syncBoardAriaLabel();
    // ★ 分栏层**先于**卡片层装配：两者都是 `world` 的直接子元素，元素顺序只在
    //   `z-index` 打平时才起作用 —— 让卡片赢平局（一张卡和它所在分栏 z 相同时，
    //   卡片必须可见，否则用户会以为卡"没放进去"）。
    this.columnLayer = new ColumnLayer(world, {
      onPointerDown: (columnId, gesture, event) =>
        this.beginColumnGesture(columnId, gesture, event),
      onToggleCollapse: (columnId) => this.toggleColumnCollapsed(columnId),
      onTitleCommit: (columnId, title) => this.setColumnTitle(columnId, title),
      onContextMenu: (columnId, event) => this.showColumnMenu(columnId, event),
      // 栏内滚动（T2.03 / F2-7-10）：DOM 只报"滚到哪了"，怎么解释归视图
      onScroll: (columnId, offset) => this.onColumnScroll(columnId, offset),
    });
    // 编组层（O03）：同样挂在 `world` 里、同样早于卡片层 —— 框与标签条都要让卡片赢平局
    this.groupLayer = new GroupLayer(world, {
      onPointerDown: (groupId, event) => this.beginGroupDrag(groupId, event),
      onToggleCollapse: (groupId) => this.toggleGroupCollapsed(groupId),
      onLabelCommit: (groupId, label) => this.commitGroupLabel(groupId, label),
    });
    // 卡片层挂在世界容器里：跟着 world 一起被 transform，卡片只写世界坐标。
    // 内容渲染下放给注册表 —— 本视图只提供"环境"（app / 路径 / Markdown 渲染 / 编辑态）
    this.cardLayer = new CardLayer(world, {
      registry: this.cardRegistry,
      modeOf: (card) => this.modeOf(card),
      createContext: (card, contentEl) => this.createCardContext(card, contentEl),
      releaseContent: (contentEl) => this.releaseCardContent(contentEl),
      commitTitle: (cardId, title) => this.setCardTitle(cardId, title),
      // 撞色标题带的墨色（`O38`）：主题色是 `var(--color-red)`，CSS 算不出它的亮度 ⇒
      // 在这里解析一次（读计算后的值），再按对比度挑深/浅（`util/color` 已有那套）
      resolveInk: (color) => this.inkOn(color),
      // 收起 / 展开（`O31`）：标题行上那个小按钮点下来的
      toggleCollapsed: (cardId) => this.toggleCardCollapsed(cardId),
      // 树折叠的 +N 角标（`F7`）：数子树、点角标展开 —— 判定都在模型层
      treeBadgeOf: (cardId) => {
        const current = this.board;
        return current ? treeHiddenCountOf(current, cardId) : 0;
      },
      onTreeBadgeToggle: (cardId) => this.dropTreeBadgeToggle(cardId),
      onAutoHeight: (cardId, height) => this.growCard(cardId, height),
      // 性能档位（T3.22）：复用池占的是常驻内存，弱机档收小一点
      maxPoolPerType: this.perfProfile.maxPoolPerType,
      // 无障碍（T3.26）：卡片的可访问名由 `view/a11y.ts` 算好传进来，
      // 渲染层继续只认识"卡片 + 一个字符串"
      a11y: {
        labelOf: (card, state) => cardAriaLabel(card, state),
        hintId: this.cardHintId,
      },
    });

    // 白板级脑图（`2.2.0`）：与卡片层**平级**的一层，也挂在世界容器里 ——
    // 于是它跟着白板缩放一起变（节点与卡片同一个等级），层序则由 `mind.z` 与卡片混排。
    // ★ 容器里那棵树是 `EmbedMind(placement: 'anchor')`：节点 / 分支线 / 折叠手柄 /
    //   就地改名 / 加完节点进编辑器 —— 与标签页里的脑图同一套实现，一处没重写。
    this.mindLayer = new MindLayer(world, {
      getMinds: () => this.board?.minds ?? [],
      modelOf: (mind) => this.mindModelOf(mind),
      isReadOnly: (mind) =>
        this.isReadOnly() ||
        (mind.path.length > 0 && this.plugin.mindRepository.isReadOnly(mind.path)) ||
        mind.locked === true,
      mutate: (mind, mutator) => this.mutateMind(mind, mutator),
      onNodeMenu: (mind, nodeId, event) =>
        this.showMindNodeMenu({
          path: mind.path,
          nodeId,
          event,
          // ★ 容器 id 占据 `cardId` 那个位置：它对视图来说就是"这次右键属于哪个白板对象"
          //   （卡片菜单那一套按 id 查不到就该没有 —— 见 `prepareCardMenu` 的 `null` 分支）
          cardId: mind.id,
          // ★ "加完节点把光标送进新节点"的请求键 = **脑图 id**：与 `MindLayer` 取请求
          //   所用的键严格一致（`takeEditRequest: (mind) => takeMindEdit(mind.id)`）。
          //   ★ 从前这里写的是 `path`（那是老的脑图**卡**的键），而白板级脑图按 id 取 ——
          //     于是**文件脑图**上"加子节点"之后光标永远进不来（内嵌那张没事，
          //     因为它走 `inline.requestEdit`，那边用的正是 id）。
          editKey: mind.id,
          inline: this.inlineMindSource(mind),
        }),
      onNodeFocus: (mind, nodeId) =>
        this.setMindNodeFocus({
          path: mind.path,
          cardId: mind.id,
          nodeId,
          inline: this.inlineMindSource(mind),
        }),
      onDragStart: (mind, event) => this.beginMindDrag(mind, event),
      takeEditRequest: (mind) => takeMindEdit(mind.id),
      resolveResource: (target) => this.notesBridge?.resourceUrl(target) ?? null,
      refMissing: (target) => (this.notesBridge ? !this.notesBridge.exists(target) : false),
      renderMarkdown: (markdown, host) => {
        void MarkdownRenderer.render(this.app, markdown, host, this.currentPath ?? '', this).catch(
          () => undefined,
        );
      },
      labels: {
        handle: (state) =>
          state.collapsed
            ? t('mind.handle.expand', { count: state.count })
            : t('mind.handle.collapse'),
        more: (count) => t('card.mind.more', { count }),
      },
    });

    // 拖动 / 缩放 / 旋转（T1.35–T1.37 / T7.06）。三个回调就是全部契约：
    // 拖动中只画 DOM，松手才落一次盘（见 DragController 顶部的说明）
    this.dragController = new DragController({
      preview: (rects, guides) => this.previewCardRects(rects, guides),
      // 旋转走一对旁路回调（T7.06）：它不改几何，硬并进上面两条通道会让
      // "移动"与"转身"共用同一条历史记录（见 DragController 的第三条决定）
      previewRotation: (cardId, degrees) => this.previewCardRotation(cardId, degrees),
      commit: (rects, label) => this.commitDrag(rects, label),
      commitRotation: (cardId, degrees) => this.commitRotation(cardId, degrees),
      resync: () => this.refreshCards(),
    });

    // 手绘层（T3.06）：也在屏幕坐标里画，但层级在**卡片之上** ——
    // 手绘最常见的用法就是把图片卡上的某一块圈起来，画在卡片下面等于没画。
    // ★ 必须**早于**覆盖层挂载：两者 z-index 相同（都是 3），DOM 顺序决定谁压谁，
    //   而参考线 / 框选 / HUD 必须压住笔迹（见 styles.css 的「分层」说明）
    this.inkLayer = new InkLayer(canvas, {
      // 抬笔 → 落盘成一张手绘卡（T3.08）。★ 必须在**同步**的这一帧里建出来：
      // 图层紧接着会清掉画布上那一笔（见 `InkLayer.endStroke`），晚一帧就会闪
      onStroke: (path) => this.persistInkStroke(path),
      // 橡皮擦到哪个点 → 删掉对应的手绘卡。笔迹现在是模型里的卡片了，
      // 图层不再认识它们（这也正是"内容只有一个出处"的好处）
      onErase: (point, radius) => this.eraseInkAt(point, radius),
      // 临时标注层（T7.07）变了（加了一笔 / 擦掉一笔 / 清空）→ 重画工具条。
      // ★ 那一层不在模型里，没有 `mutate` 事件可订阅：工具条的「清空」按钮
      //   要跟着"有没有笔迹"亮起来，只能由图层主动出声
      onTransientChange: () => this.inkBar?.render(),
    });

    // 覆盖层：参考线 / 框选 / 插入线 / HUD，最上层且不拦指针（T1.28）
    this.overlayLayer = new OverlayLayer(canvas);

    // 手绘控制器（T3.06）★ 必须**早于** `NavigationController` 创建：
    // 触屏拖动在那边就等于平移；而指针事件的目标是**容器本身**时（点在空白处 ——
    // 世界容器是 pointer-events: none，事件穿过所有 Canvas 层落到容器上），
    // 同一元素上的监听严格按注册顺序触发，`capture` 在这时并不顶用。
    // 晚一步就是"在平板上画一笔，画布跟着手平移"。
    // ★ 图层要晚于卡片层挂载、控制器却要最早注册监听，两个时机对不上，
    //   所以 `surface` 用回调延迟解析（见 `InkControllerOptions.surface`）
    this.inkController = new InkController({
      host: canvas,
      viewport: this.viewport,
      stateMachine: this.pointerState,
      surface: () => this.inkLayer,
      isPanning: () => this.navigationController?.isPanning === true,
      isReadOnly: () => this.isReadOnly(),
      // 进入 / 换笔（`D` / `E`）：提示"我拿的是哪支笔"，并同步工具条
      onEnter: (tool) => {
        this.onInkEnter(tool);
        // 工具条上"选择 / 手绘"两格要当场翻面（T3.21）。
        // ★ 钩在这里而不是 `startInk()` 里：`Esc`（退出）与触控笔入笔都能改变
        //   手绘态，而它们都不经过命令层 —— 挂在控制器上才覆盖得全
        this.toolbar?.sync();
      },
      // 离开手绘（`Esc` / `V` / 拆视图）：工具条必须跟着收摊。
      // ★ 挂在控制器上而不是命令上：`Esc` 是状态机自己处理的，命令层收不到那个信号
      onExit: () => {
        this.inkBar?.setVisible(false);
        this.toolbar?.sync();
      },
    });

    // 手绘工具条（T3.07）：颜色 + 4 档笔宽。挂进覆盖层 HUD（画布内部）。
    // ★ 它的回调一律走本视图的公开方法：命令层与工具条共用同一条路径，
    //   不会出现"按 `1` 和点工具条得到两种结果"
    this.inkBar = new InkBar(this.overlayLayer.hud, {
      state: () => this.inkToolState,
      // 工具条上的三支笔（画笔 / 荧光笔 / 临时标注）：高亮与换笔都走这两个回调。
      // ★ 一律回到本视图的公开方法（`startInk` 与 `inkTool`）—— 命令层与工具条
      //   共用同一条路径，不会出现"按 D 和点按钮得到两种结果"
      tool: () => this.inkTool,
      annotations: () => this.annotationCount,
      onColor: (color) => this.setInkColor(color),
      onCustomColor: () => this.pickInkColor(),
      onWidth: (index) => this.setInkWidth(index),
      onTool: (tool) => void this.startInk(tool),
      onClear: () => void this.clearAnnotation(),
    });

    this.navigationController = new NavigationController({
      host: canvas,
      viewport: this.viewport,
      // "空白"的判据来自本视图自己的 `HitTest`（T1.30）：卡片 id 的属性名只有一个来源，
      // 而共享的导航控制器不认识任何一种文档类型的 DOM 约定（`06 §7`）
      isBackground: (target) => resolveCardElement(target, canvas) === null,
      // 演示态（J-06）空白处左键拖动也能平移：那时框选被封住了，空白处一拖本来
      // 什么都不发生；而 `Space` 在演示态是"下一步"（`04 §9`），鼠标用户不该被
      // 逼到"要么滚轮、要么按住一个会翻页的键"。
      panOnEmptyDrag: () => this.presentation?.active ?? false,
    });
    this.unsubscribeViewport = this.viewport.onChange(this.handleViewportChange);

    // 选区 → 选中外观。**唯一咽喉点**：框选、⌘A、以后的点击选择都走 `SelectionModel`，
    // 所以订阅它一处即可，任何新增的选区入口都不会漏掉视觉同步。
    this.unsubscribeSelection = this.selection.onChange(() => {
      // 编组（T3.14）：点到组内任意一张 = 整组一起选中，于是拖动 / 缩放天然带上整组。
      // 扩展会再发一次通知，外观同步交给那一次（避免同一帧渲染两遍，见方法注释）
      if (this.expandSelectionToGroups()) return;

      this.cardLayer?.setSelection(this.selection.cardIds);
      // 快捷操作栏（`O38`）：选区一变就重新决定"显不显示、显示谁"
      this.syncQuickBar();
      // 分栏与卡片共用同一个 `SelectionModel`，但走各自的渲染层 ——
      // 两边都订阅同一次通知，绝不会有"选了但没高亮"的中间态
      this.columnLayer?.setSelection(this.selection.columnIds);
      // 脑图（`2.2.0` 批 5）：同一份选区、第三个渲染层。
      // ★ 它画的是一棵树的**外接框**（现算），所以这里给的是整个集合而不是增量 ——
      //   "取消选中"与"重新选中"在同一处收口，不必维护两份状态
      this.mindLayer?.setSelection(this.selection.mindIds);
      // 节点级（`2.2.0` 收尾 · 节点级框选）：同一处递过去，两档外观互不干扰
      this.mindLayer?.setNodeSelection(this.selection.mindNodeKeys);
      // 连线是 Canvas（T1.69）：没有 class 可改，只能让整层重画。
      // 连线层的脏区账本会把"选区变了"放大成一次全量重绘 —— 这是必要代价，
      // 因为选中态改变了**每条**线的画法（不只是被选中的那条：其余的要恢复常态色）
      this.edgeLayer?.invalidate();
      // 弧度手柄（T7.12）跟着选区走：选中一条 free 线才浮出来。
      // ★ 控制器自己订阅了选区，这一句是给"模型提交后位置变了"兜底（见 `syncCanvas`）
      this.edgeCurveController?.sync();
    });

    // ★ 框选控制器必须在 `unsubscribeViewport` 之后创建：
    //   视口变化时先让 `syncCanvas()` 把覆盖层清掉，它再按新视口重画选框。
    //   顺序反了的话，选框会在每次滚轮缩放时被清没。
    this.marqueeController = new MarqueeController({
      host: canvas,
      viewport: this.viewport,
      overlay: this.overlayLayer,
      stateMachine: this.pointerState,
      selection: this.selection,
      // ★ 被收起编组的成员**不参与**框选与全选（O03）：它们在屏幕上根本不存在
      //   （卡片层没挂载），能选中却看不见 —— 那样"框选之后按 Delete"会删掉
      //   一屏看不见的东西
      getCards: () => this.selectableCards(),
      // 框的是屏幕上看到的那些卡（栏内滚动会让模型坐标与屏幕位置差一段，T2.03）
      // ★ 转过的卡片按**外接框**判定（T7.06）：选框擦了它转出来的那个角就该算选中 ——
      //   按没转的布局框判定会出现"框明明碰到卡片了却选不上"（0° 时两者完全相同）
      rectOf: (card) => this.visualBoundsOf(card),
      // 平移（Space+拖动 / 中键 / 双指）期间不许框选；演示态（J-06）同样不许 ——
      // 那时选区是被刻意清空并封住的，空白处一拖就冒出一个选框会显得像 bug
      canStart: () => !this.navigationController?.isPanning && !this.presentation?.active,
      // 点在连线上 = 选那条线（T1.71）。交给框选控制器而不是另挂一个监听，
      // 是因为它已经是"卡片之外的按下"的守门人（见 MarqueeController 的注释）
      hitEdge: (screen) => this.hitEdgeAt(screen),
      edgesIn: (worldRect) => this.edgesIn(worldRect),
      // 框住一栏 = **选中那一栏**（用户 2026-09-16）：栏内卡片已经不参与框选（见上），
      // 于是"想动这一栏"的手势就是把它框住 —— 与点标题栏等价，但能一次框住好几栏。
      // ★ 几何用 `visualColumnRectOf`（与连线端点同一份）：收起态的高度、拖动中的临时矩形
      //   都在那一处收口，这里再算一遍迟早分叉
      columnsIn: (worldRect) =>
        (this.board?.columns ?? [])
          .filter((column) => rectsIntersect(this.visualColumnRectOf(column), worldRect))
          .map((column) => column.id),
      // 脑图（`2.2.0` 批 5）：命中判据交给渲染层 —— 一棵树的外接框是**现算**的
      //（布局算出来、DOM 实测），模型里既没有尺寸也没有它的轮廓。
      // ★ 只有**已挂载**的容器能被框到：模型读不到的那棵树只显示一句话，
      //   框它没有意义（与"过滤不到那一棵就不参与"同一条口径）。
      mindsIn: (worldRect) => this.mindLayer?.marqueeIn(worldRect) ?? { minds: [], nodes: [] },
      // `⌘A`：整块板的脑图都算（脑图不属于任何栏，没有"收起来看不见"的例外）
      allMinds: () => (this.board?.minds ?? []).map((mind) => mind.id),
    });

    // 连线手势（T1.68）：hover 端点浮出锚点 → 拖到另一个端点上成边。
    // ★ 它只创建 4 个锚点元素并复用（不是每卡 4 个），DOM 预算不受卡片数影响
    this.connectController = new ConnectController({
      host: canvas,
      viewport: this.viewport,
      overlay: this.overlayLayer,
      stateMachine: this.pointerState,
      getBoard: () => this.board,
      onConnect: (fromEndpointId, fromSide, to) => this.connectCards(fromEndpointId, fromSide, to),
      // 端点重拖（`2.2.0` · O1）：单选一条线时两端浮出手柄，拖完交回来改绑
      activeEdge: () => this.activeEdgeForEndpointDrag(),
      onReconnect: (edgeId, end, to) => this.reconnectEdge(edgeId, end, to),
      subscribeSelection: (listener) => this.selection.onChange(listener),
      canStart: () =>
        !this.navigationController?.isPanning && !this.isReadOnly() && !this.presentation?.active,
      // 锚点 / 落点判定 / 目标高亮都按**看到的位置**算（栏内滚动的成员差一个偏移，T2.03）
      rectOf: (card) => this.visualRectOf(card),
      // ★ 分栏也是端点（`O21`）：它的几何与卡片同出一辙，只是来源不同 ——
      //   折叠态的高度、以及"拖动中的临时矩形"都在这一个函数里收口
      columnRectOf: (column) => this.visualColumnRectOf(column),
      // 无框卡（`F4` 的脑图卡）**不作为整体**连线：用户 2026-09-21 —— "脑图……也不会
      // 作为整体对外连线"。它连的是**具体的节点**，整张卡不参与。
      canAttach: (endpointId) => this.cardAttachableAsWhole(endpointId),
      // ★ 脑图节点是第三种端点（`2.2.0` 批 3）：hover 到某个节点上浮出它的四个锚点、
      //   从别处拖过来的线也落在节点上。几何问 `MindLayer`（节点盒子由脑图布局 + DOM
      //   实测决定，模型里没有）—— 这里只做键与矩形之间的转接，控制器不认识"节点"。
      nodes: {
        hit: (world) => this.mindLayer?.nodeAt(world) ?? null,
        rectOf: (key) => this.mindLayer?.nodeRectOf(key) ?? null,
      },
    });

    // 树连线手势（`F7`，定稿 D6）：hover 卡片 → 右上角浮把手 → 拖到另一张卡上
    // ⇒ 发起方成为父级。**校验不在这里**（self / 成环 / 已有父级由模型层
    // `tree.treeLinkState` 判，见 `dropTreeLink`），本控制器只交出两个卡片 id。
    this.treeLinkController = new TreeLinkController({
      host: canvas,
      viewport: this.viewport,
      overlay: this.overlayLayer,
      stateMachine: this.pointerState,
      getBoard: () => this.board,
      onDrop: (parentId, childId) => this.dropTreeLink(parentId, childId),
      canStart: () =>
        !this.navigationController?.isPanning && !this.isReadOnly() && !this.presentation?.active,
      // 与普通连线同一道闸（无框脑图卡不作为整体参与，用户 2026-09-21）
      canLink: (cardId) => this.cardAttachableAsWhole(cardId),
      cardRectOf: (card) => this.visualRectOf(card),
      // 把手别只在 hover 时才出现（`2.2.0` · O2）：单选的卡上也让它浮着
      getSelectedCardId: () =>
        this.selection.cardIds.size === 1 ? [...this.selection.cardIds][0] : null,
      subscribeSelection: (listener) => this.selection.onChange(listener),
    });

    // 弧度手柄（T7.12 / `F3-07`）：单选一条 Free 线时中点浮出小圆点，拖它调弯。
    // ★ 它自己订阅视口与选区重摆手柄；这里只把"哪条线可调""两端在哪"递进去 ——
    //   判断（单选 / free / 只读 / 演示）集中在本视图，控制器不重复一遍（免得两处分叉）
    this.edgeCurveController = new EdgeCurveController({
      host: canvas,
      viewport: this.viewport,
      stateMachine: this.pointerState,
      activeEdge: () => this.activeCurveEdge(),
      // 端点取**视觉**几何：栏内滚动 / 拖动预览 / 旋转都在覆盖表里（见 `cardRectLookup`）
      endpointsOf: (edge) => this.curveEndpointsOf(edge),
      canStart: () =>
        !this.navigationController?.isPanning && !this.isReadOnly() && !this.presentation?.active,
      onPreview: (edgeId, curve) => this.previewEdgeCurve(edgeId, curve),
      onPreviewEnd: (edgeId) => this.endPreviewEdgeCurve(edgeId),
      onCommit: (edgeId, curve) => this.commitEdgeCurve(edgeId, curve),
      subscribeSelection: (listener) => this.selection.onChange(listener),
    });

    // 卡片事件委托（T1.30）：整层只挂 3 个监听器，靠 `closest('[data-card-id]')` 定位卡片。
    // 三个相位现在各有归属：pointerdown → 拖动/选择，dblclick → 编辑，contextmenu → 菜单
    this.cardDelegate = new CardEventDelegate({ host: canvas, viewport: this.viewport });
    this.cardDelegate.on('dblclick', (detail) => this.beginEditFromDoubleClick(detail));
    this.cardDelegate.on('pointerdown', (detail) => this.beginCardDrag(detail));
    this.cardDelegate.on('contextmenu', (detail) => this.showCardMenu(detail));

    // 选中一张便签时的**快捷操作栏**（`O38`，与脑图节点共用 `ui/QuickBar`）：
    // 顺序 = 标记 / 加粗 / 斜体 / 下划线 / 字色 / 底色 / 编辑内容（插图暂时不做）
    this.quickBar = buildNodeToolbar(document, {
      // ★ 每个回调都先问一句"现在操作的是**卡内脑图的节点**吗"（`F4`，用户 2026-09-21）：
      //   是 → 改那个节点（`applyToFocusedMindNode` 返回 `true`，这件事就到此为止）；
      //   否 → 走原来那条"改这张卡"的路。两个目标共用**同一条栏**（同 `ui/QuickBar`），
      //   分工写在每一处，而不是建两条栏各写一份。
      onIcon: (icon) => {
        if (!this.applyToFocusedMindNode({ icon })) this.applyCardLook({ icon });
      },
      onBold: () => {
        if (!this.toggleFocusedMindNodeFlag('bold')) this.toggleCardTitleFlag('bold');
      },
      onItalic: () => {
        if (!this.toggleFocusedMindNodeFlag('italic')) this.toggleCardTitleFlag('italic');
      },
      onUnderline: () => {
        if (!this.toggleFocusedMindNodeFlag('underline')) this.toggleCardTitleFlag('underline');
      },
      onInk: (ink) => {
        if (!this.applyToFocusedMindNode({ ink })) this.applyCardLook({ ink });
      },
      onColor: (color) => {
        if (!this.applyToFocusedMindNode({ color })) this.applyCardColor(color);
      },
      onEditNote: () => {
        const card = this.quickBarTarget();
        if (!card) return;
        // ★ 两种卡的最后那个按钮**同名不同事**（`syncQuickBar` 会换掉它的标题）：
        //   便签是「编辑内容」= 只改正文（`raw`，与右键菜单那一项同一个入口）；
        //   白板卡是「编辑标题」= 就地改名（卡外那行字，连子板文件一起改）
        if (card.type === 'boardRef') this.editCardTitle(card.id);
        else this.editCard(card.id, true, 'raw');
      },
      onInsertImage: () => undefined,
      // 「连线」是脑图那条线才有的格子（白板两类卡片的按钮集里没有它）——
      // 栏永远不会画出来，这里只需满足接口
      onLink: () => undefined,
      // 「文字高亮」（`N3-f`）：白板卡片没有这一档，但**卡内脑图节点有**（用户 2026-09-21
      // 那条栏要的就是与脑图同一套）—— 有节点在操作时改节点，否则什么都不做
      onHighlight: (highlight) => {
        this.applyToFocusedMindNode({ highlight });
      },
      resolveTheme: (color) => this.resolveSwatchColor(color),
    });
    this.quickBar.element.addClass('is-board');
    canvas.appendChild(this.quickBar.element);

    // ★ 栏里的指针事件**一律不许冒泡到画布**（用户 2026-09-16："点任意按钮，按钮就消失了"）。
    //   根因：栏是**画布的孩子**，而画布把"按在空白处"解释成"清空选区" ⇒ 选区一空，
    //   栏自己就收起了（看起来像"点一下就没了"）。三个事件都要拦：
    //   * `pointerdown` —— 清选区 / 起框选走的就是它；
    //   * `dblclick`    —— 画布的"空白处双击 = 就地新建便签"，不拦会在栏底下拍出一张新卡；
    //   * `contextmenu` —— 画布的空白菜单，不拦会与栏的按钮抢右键。
    //   截在**栏自己**身上最省事：画布是它的祖先，这里一停，整条上游都收不到。
    for (const type of ['pointerdown', 'dblclick', 'contextmenu'] as const) {
      this.quickBar.element.addEventListener(type, (event) => event.stopPropagation());
    }

    // 演示模式（J-06）：宿主能力用窄接口传进去，控制器不认识本类内部 ——
    // 它与相机数学（`presentCamera.ts`）、顺序规则（`model/presentation.ts`）都解耦，
    // 自己只负责"把顺序翻译成 DOM 与相机动作"（见 `PresentationController` 头注）。
    this.presentation = new PresentationController({
      containerEl: root,
      canvasEl: canvas,
      viewport: this.viewport,
      board: () => this.board,
      // 取景按**外接框**（T7.06）：转 45° 的卡片比它的 `width/height` 高出小半张，
      // 按布局框取景会让它顶到视口边上（用户看到的是"演示时卡片没摆正"）
      visualRectOf: (card) => this.visualBoundsOf(card),
      // ★ 脑图（`2.2.0` 收尾）：讲到一棵树时取景到**整棵树**（用户 2026-09-23），
      //   而那份框由 `MindLayer.viewRectOf` 从**纯布局**给出 —— 与量测 / 折叠 / 视口裁剪
      //   都无关（屏幕外的树也算得出来），所以"看到全脑图"与"景不飘"可以同时成立。
      mindVisualRect: (mind) => this.mindVisualRectOf(mind.id),
      clearSelection: () => this.selection.clear(),
      fitContent: () => this.fitContent(),
      focusCanvas: () => this.focusCanvas(),
      // 进入演示前把"正在编辑 / 正在画"收掉（J-06 的硬性约束是演示态不可编辑）。
      // ★ 与 `setBoardLocked()` 同一条规矩，也走同一个 `leaveEditMode()`：编辑器按既有
      //   约定提交内容，不会吞掉用户刚敲的字。
      // ★ 这件事必须由**控制器**在算顺序之前调用：`leaveEditMode()` 会 `commit`，
      //   提交后板子对象会换新 —— 顺序要在这之后再算，否则列表里握着的是旧卡片对象
      exitTransientModes: () => {
        if (this.pointerState.is('EDITING')) this.leaveEditMode();
        this.inkController?.exit();
      },
    });

    // 空白处双击 → 就地新建便签（F1-07 / 02 §5.3）
    this.listenCanvas(canvas, 'dblclick', (event) => this.onCanvasDoubleClick(event as MouseEvent));
    // 空白处右键 → 画布菜单（F1-08）。**挂在 canvas 上而不是卡片上**：
    // 卡片的右键由委托层处理，两者靠 `closest('[data-card-id]')` 天然分流
    this.listenCanvas(canvas, 'contextmenu', (event) =>
      this.onCanvasContextMenu(event as MouseEvent),
    );
    // 方向键微移（02 §4.1）。**刻意挂在 canvas 上而不是 window 上**：
    // 全局按键是全插件级污染（`02 §4.2`），而 canvas 有 `tabindex`，
    // 我们在卡片按下时主动 focus 它 —— 作用域天然收在"用户正在看的这块白板"。
    this.listenCanvas(canvas, 'keydown', (event) => this.onCanvasKeyDown(event as KeyboardEvent));
    // 卡片获得焦点 → 选中它（T3.26 / `02 §7`）。
    // ★ 必须让"焦点"与"选区"对齐：读屏用户 Tab 到第三张卡时，按 Delete 删掉的
    //   必须是**第三张**。不对齐的话（焦点在 A、选区还在 B）他会删掉自己看不见的那张，
    //   而界面上没有任何东西提示这件事。
    // ★ 用 `focusin`（会冒泡）而不是 `focus`：`focus` 不冒泡，挂在画布上收不到卡片的事件
    this.listenCanvas(canvas, 'focusin', (event) => this.onCanvasFocusIn(event as FocusEvent));
    // 画布焦点与鼠标位置：这两件事都只"记账"，不产生任何 DOM 写操作，
    // 所以可以放心地挂在 pointerdown / pointermove 上（02 §8.2 禁的是每帧 DOM 写）
    this.listenCanvas(canvas, 'pointerdown', (event) =>
      this.onCanvasPointerDown(event as PointerEvent),
    );
    this.listenCanvas(canvas, 'pointermove', (event) =>
      this.onCanvasPointerMove(event as PointerEvent),
    );
    // 栏内滚动（T2.03 / F2-7-10）：
    // ★ 挂在**画布**上、而且必须是**捕获**阶段 —— 两个理由缺一不可：
    //   1. 成员卡与内容槽是兄弟节点，"滚在卡上"的事件永远不会路过内容槽，
    //      两者的共同祖先只有画布；
    //   2. 画布的平移/缩放监听器挂在同一个元素的**冒泡**阶段，
    //      晚一步拦就会"滚了栏、也平移了画布"（画面直接飞走）。
    this.listenCanvas(canvas, 'wheel', (event) => this.onCanvasWheelCapture(event as WheelEvent), {
      capture: true,
      // 要 `preventDefault()` 就不能是 passive（默认在 window 上是 passive，
      // 这里显式声明，免得换个浏览器就变成"拦不住原生滚动"）
      passive: false,
    });

    // 外部拖入（T1.63–T1.65，F6-01–F6-06）：文件浏览器 / 笔记链接 / 系统文件管理器 → 画布。
    // ★ 监听器挂在 canvas 上，所以"拖到画布之外"根本不会触发（T1.64 的验收点之一）：
    //   这是靠**监听范围**而不是靠坐标判断实现的 —— 用坐标判断迟早会在
    //   分屏、内嵌视图、弹出窗口这些场景下算错。
    this.dropBridge = new DragDropBridge(canvas, {
      // ★ 用 Obsidian 自己的链接解析器兜底短名：拖文件浏览器/链接时，text/plain
      //   经常只有文件名（如「子板.nboard」），直接精确匹配会失败。getFirstLinkpathDest
      //   会按库规则把它展开成真实路径（Boards/子板.nboard）。
      resolvePath: (path) => this.resolveVaultPath(path),
      importFile: (file) => this.plugin.importDroppedFile(file),
      // 只有 `text/uri-list`、没有 `files` 时的兜底（macOS Finder）：按绝对路径读盘落库
      importUri: (absolutePath) => this.plugin.importDroppedUri(absolutePath),
      onPreview: (preview) => this.applyDropPreview(preview),
      onDrop: (paths, clientX, clientY) => void this.dropPathsAt(paths, clientX, clientY),
      // 拖进来的是一段文字（T6.11 / F6-07）→ 便签卡。与 `onDrop` 分成两个口：
      // 那边拿到的是"库内路径"，这边拿到的是"正文"，建卡走的是两条路
      onDropText: (content, clientX, clientY) => this.dropTextAt(content, clientX, clientY),
      onImporting: (count) => new Notice(t('notice.importing', { count })),
      onImportFailed: (names) =>
        new Notice(t('notice.attachmentFailed', { error: names.join('、') })),
    });

    // 拖出导出（T6.10 / F6-04）：复用**移动手势**——
    // 原生 `dragstart` 会给正在拖的指针补发 `pointercancel`，把移动打断（见 `model/dragOut.ts`）。
    // ports 都是稳定的箭头函数，构造一次即可；每块板子的拖拽都走这一个实例
    this.dragOut = new CardDragOut({
      pathAt: (clientX, clientY) => this.dropOutPathAt(clientX, clientY),
      isFolder: (path) => this.app.vault.getAbstractFileByPath(path) instanceof TFolder,
      onHighlight: (folder) => this.highlightDropOutTarget(folder),
      onExport: (cardIds, folder) => void this.exportCardsToNotes(cardIds, folder),
    });

    // 剪贴板（T1.49 / `F2-3-2` / `F-02`）：图片落库成图片卡；文本里是库内路径就建卡。
    // ★ 与拖入共用一套落卡逻辑，差别只在"素材从哪来"。
    // ★ 挂在 canvas 上而非 window：编辑卡片时 `⌘V` 必须归编辑器（见 `onCanvasPaste`）
    this.listenCanvas(canvas, 'paste', (event) => void this.onCanvasPaste(event as ClipboardEvent));
    // 空白处长按的收尾（T3.21）：松手 / 系统打断（来电、手势被系统接管）都要作废。
    // ★ `pointercancel` 不是可选项：移动端一个"下拉通知栏"就能把指针流掐断，
    //   不接这个事件的话那次长按会一直挂着，之后随便什么移动都会把它喂成一次误触发
    this.listenCanvas(canvas, 'pointerup', () => this.onCanvasPointerRelease());
    this.listenCanvas(canvas, 'pointercancel', () => this.onCanvasPointerRelease());

    // 性能档位（T3.22）：视口裁剪外扩 / 复用池上限 / DPR 上限三处一起贴上去。
    // ★ 放在**装配末尾**：前面各层都已建好，一次贴完不必逐个记"哪个建过了"
    this.applyPerfProfile();
    // 外观（T3.24）：卡片圆角 / 字号 / 字体是 CSS 变量，跟着根节点走
    this.applyAppearanceSettings();

    this.measure();
    // ResizeObserver 覆盖"侧栏开合 / 分屏拖动"等 onResize 不一定会报的场景。
    // ★ 必须连带 syncCanvas：`Viewport.setSize()` 刻意不发通知（尺寸不改变世界↔屏幕
    //   映射），但**裁剪矩形依赖视口尺寸** —— 不重跑一次，放大窗口后边缘的卡片不会补进来。
    this.resizeObserver = new ResizeObserver(() => {
      this.measure();
      this.syncCanvas();
    });
    this.resizeObserver.observe(canvas);

    // `onOpen` 可能早于 `onLoadFile`：先画一次"只有根"的面包屑，
    // 免得在文件到达之前顶部一直是空的
    void this.refreshBreadcrumb();
  }

  private teardownCanvas(): void {
    // 搜索面板挂在 document 上（不属于 canvas），拆画布时必须一并关掉 ——
    // 否则切板 / 关视图之后它还在，⌘G 会去操作一个已经没有白板的面板
    this.closeSearch();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.navigationController?.dispose();
    this.navigationController = null;
    this.marqueeController?.dispose();
    this.marqueeController = null;
    // 锚点 DOM 挂在 canvas 上、指针捕获也握在它手里：不拆干净会连带把监听器泄漏给下一块板
    this.connectController?.dispose();
    this.connectController = null;
    this.treeLinkController?.dispose();
    this.treeLinkController = null;
    // 弧度手柄同理：它持有一个常驻 DOM 节点 + 宿主上的一批监听器，必须跟着画布一起拆
    this.edgeCurveController?.dispose();
    this.edgeCurveController = null;
    this.cardDelegate?.dispose();
    this.cardDelegate = null;
    // 演示态（J-06）：步骤条 DOM 与 `requestAnimationFrame` 句柄都在它手里，
    // 不跟着画布拆就会留下一个"看不见但还在跑"的定时器
    this.presentation?.dispose();
    this.presentation = null;
    for (const { type, listener, options } of this.canvasListeners.splice(0)) {
      this.canvasEl?.removeEventListener(type, listener, options);
    }
    // 拖动可能正在进行（用户在拖的过程中切走标签）：先摘窗口级监听再销毁控制器
    this.endDragSession();
    // 帧队列里可能还压着"最后一次相机提交 / 视口落盘"（T2.14）。
    // ★ 必须先 flush 再拆 DOM：否则"刚平移完就关标签"会丢掉最后一次视口落盘，
    //   下次打开回到更早的位置 —— 用户看到的是"位置没记住"。
    // ★ `dispose` 放 `finally`：不管提交是否抛错，队列都必须被丢掉。漏掉这一步，
    //   迟到的任务会在 DOM 已经拆掉之后执行，比它本身抛的错更难查。
    try {
      this.frameQueue.flush();
    } finally {
      this.frameQueue.dispose();
    }
    this.pendingSizes.clear();
    this.sizeFlushScheduled = false;
    this.notesBridge = null;
    // 脑图桥（`F3a`）：只是几个闭包，但生命周期与这次画布会话一致（下次进来重建）
    this.mindBridge = null;
    this.shellBridge = null;
    // 剪贴板桥是 `readonly` 且无资源：刻意不在这里清（它不属于"这次画布会话"）
    // ★ 必须 dispose：缓存里握着一批 blob objectURL，不撤掉就是永久泄漏
    this.thumbnailBridge?.dispose();
    this.thumbnailBridge = null;
    // 板级缩略图桥同理：缓存里同样留着一批 objectURL，不撤就是永久泄漏。
    // ★ 它的 `dispose()` 还会退掉 Vault 上的 `modify` 订阅（板文件变更 → 失效）
    this.boardThumbBridge?.dispose();
    this.boardThumbBridge = null;
    // 外链桥不持有资源（没有缓存、没有监听器），清引用即可 —— 留着的唯一后果是
    // "视图已关但还能被一张没回收的卡片点到"
    this.linkPreviewBridge = null;
    // 地图瓦片桥也不持有资源（没有缓存、没有监听器），清引用即可
    this.mapTileBridge = null;
    this.promoter = null;
    this.breadcrumb?.dispose();
    this.breadcrumb = null;
    // 工具条：先让挂着的拖拽手势摘掉它在 document 上的四个监听器，再拆节点。
    // ★ 顺序不能反 —— 直接 `remove()` 会把那次拖拽的监听器留在 document 上，
    //   表现为"切走视图后，拖到画布上仍然会建卡"
    this.toolbar?.dispose();
    this.toolbar = null;
    // 缩略图导航器：它握着 pointer capture 与一批格子节点，跟着画布一起拆。
    // ★ 不拆的后果不是"看不见"，而是它仍挂在根容器上、仍会被下一块板的 `syncContent` 找到
    this.minimap?.dispose();
    this.minimap = null;
    this.longPress?.dispose();
    this.longPress = null;
    this.longPressCardId = null;
    this.canvasLongPress?.dispose();
    this.canvasLongPress = null;
    // 复位"上一次写的状态"：下次装配时第一个 `syncEmptyHint` / `syncBoardAriaLabel`
    // 必须真的写一次 DOM，而不是因为缓存里还留着旧值而跳过
    this.emptyHintEl = null;
    this.lastEmptyHintVisible = null;
    this.lastBoardAriaLabel = '';
    // 浮层自己没握资源，但它是根节点的子元素：根节点被丢弃前先摘掉，
    // 免得"视图已关、节点还在"（与面包屑同一条纪律）
    this.todoOverview?.dispose();
    this.todoOverview = null;
    this.filterBar?.dispose();
    this.filterBar = null;
    this.linkOverview?.dispose();
    this.linkOverview = null;
    // 过滤条件与断链清单都属于"这块板"的界面状态：换板 / 关视图后不该留给下一块
    this.cardFilter = NO_FILTER;
    this.brokenRefs = [];
    this.brokenCardIds = new Set();
    // 提示条随根节点一起被丢弃（监听器挂在它自己的按钮上，跟着节点走）
    this.scaleHintEl = null;
    this.scaleAdvice = null;
    this.scaleFileBytes = null;
    // 锁定提示同理；缓存判定也要复位，否则下一块板会沿用"上一块板是锁着的"这个结论
    this.lockHintEl = null;
    this.lastLockHintVisible = null;
    this.collapseDefaults.clear();
    // 视图被关闭：离开的是"这次会话"，历史不该留到下一次打开
    this.navHistory = [];
    this.navIndex = -1;
    this.replayTarget = null;
    this.boardParentPath = null;
    this.dragController = null;
    this.editingCardId = null;
    this.unsubscribeSelection?.();
    this.unsubscribeSelection = null;
    this.cardLayer?.dispose();
    this.cardLayer = null;
    // 脑图层（`2.2.0`）与卡片层同生命周期；拖动会话也要收（它挂着 window 监听）
    this.mindDragCleanup?.();
    this.mindDragCleanup = null;
    this.mindLayer?.dispose();
    this.mindLayer = null;
    this.columnLayer?.dispose();
    this.columnLayer = null;
    this.groupLayer?.dispose();
    this.groupLayer = null;
    this.columnDrag = null;
    this.pendingColumnRects = null;
    this.dropTarget = null;
    // 外部拖入的接线与预览都要拆：监听器挂在 canvas 上，残留会在下一块板上继续吞 drag 事件
    this.dropBridge?.dispose();
    this.dropBridge = null;
    // 拖出导出（T6.10）不监听事件，但高亮是**别的 DOM 上的**类名：
    // 视图关掉时如果不摘，侧栏里那个文件夹会一直亮着
    this.dragOut?.cancel();
    this.dragOut = null;
    this.dropPreview = null;
    this.dropColumnLine = null;
    this.dragPreviewRects = null;
    // 弧度覆盖表同理（T7.12）：留着它，下一块板会照着上一块板的弧度画线
    this.dragCurve = null;
    // 栏内滚动是"这次会话"的界面状态：下次打开白板没理由停在上次那段
    this.columnScroll.clear();
    this.edgeLayer?.dispose();
    this.edgeLayer = null;
    // 先拆控制器再拆图层：控制器收尾时会往图层里"落最后一下"（`endStroke`）
    this.inkController?.dispose();
    this.inkController = null;
    this.inkLayer?.dispose();
    this.inkLayer = null;
    // 工具条（T3.07）也归控制器管（进出 / 换笔时同步），跟着一起拆。
    // ★ 排在控制器之后：`dispose` 里会回调 `onExit` 去隐藏它，先拆会白拆一次
    this.inkBar?.dispose();
    this.inkBar = null;
    this.overlayLayer?.dispose();
    this.overlayLayer = null;
    this.unsubscribeViewport?.();
    this.unsubscribeViewport = null;
    this.viewport.dispose();
    this.pointerState.dispose();
    this.selection.dispose();
    this.background = null;
    this.canvasEl = null;
    this.worldEl = null;
    this.contentEl.empty();
  }

  private measure(): void {
    const canvas = this.canvasEl;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    // 尺寸为 0（面板折叠 / 尚未布局）时保留旧值，避免把视口算成 0 宽
    if (rect.width <= 0 || rect.height <= 0) return;
    this.viewport.setSize(rect.width, rect.height);
  }

  // ── 白板加载 ────────────────────────────────────────────

  private async openBoard(path: string): Promise<void> {
    this.ensureCanvas();
    this.detachBoard();
    this.currentPath = path;
    // ★ 换了板 ⇒ "这一下按过没有"作废（见 `canvasPressSeen`）：**同 leaf 换文件时视图实例
    //   是复用的**，不清掉的话，"点开子板的那一下按下"会被算进新板的账上 ⇒ 紧接着漏进来的
    //   那个双击就又能建出一张便签
    this.canvasPressSeen = false;
    // 历史（T1.62）：回放**认领**这一次加载（见 `replayTarget`），其余都算用户主动导航
    if (this.replayTarget === path) {
      this.replayTarget = null;
    } else {
      this.remember(path);
    }

    const board = await this.plugin.repository.open(path);
    if (!board) {
      // 打不开（损坏 / 由更高版本写入 / 文件消失）：Repository 已发过 protected 事件，
      // 全局提示会说明原因；这里再放一个占位，保证用户看到的不是一片空白
      this.renderUnavailable(path);
      void this.refreshBreadcrumb();
      return;
    }

    this.canvasEl?.querySelector('.nestboard-notice')?.remove();
    // T2.16：大板按 `02 §8.3` 先降级（折分栏）再渲染 —— 顺序不能反，见方法注释
    await this.applyScaleDegradation(path, board);
    this.applyBoard(board);

    // T1.22：恢复上次视口。期间禁止回写，否则刚打开就把文件标脏
    this.restoringViewport = true;
    try {
      this.viewport.applyState(board.view);
    } finally {
      this.restoringViewport = false;
    }
    this.syncCanvas();

    this.boardSubscriptions.push(
      this.plugin.repository.on('changed', (payload) => {
        if (payload.path === path) this.applyBoard(payload.board);
      }),
      this.plugin.repository.on('reloaded', (payload) => {
        // 外部编辑只同步背景与卡片，**不动视口** —— 别把用户的视线顶走
        if (payload.path === path) this.applyBoard(payload.board);
      }),
      // 文件脑图（`2.2.0`）：那一份 `.nestmind` 变了（我们改的 / 标签页改的 / 外部编辑）
      // 就要重画 —— 与卡片时代"每张卡各自 `watch`"同一个意思，只是这里一条订阅管全板
      //（板上的脑图数量是几十这一档，不值得为每个路径各订一份）
      // ★ 顺带把"试过但没读到"的记号放开：文件可能刚被建回来（`triedMindPaths`）
      //
      // ★★ 两个事件都要**标脏连线层**（`2.2.0` 批 3）：节点成了连线端点之后，
      //    "那份 `.nestmind` 变了"（在标签页里改名 / 折叠 / 加节点）会挪动节点的盒子，
      //    而连线画在 Canvas 上 —— 不标脏的话，线会停在**节点原来待着的地方**，
      //    看起来像"线飘在空中"（这正是卡片时代 `CardLayer` 之外那条老坑的同一种形态）。
      //    这条路上的模型变化**不经过 `applyBoard`**（那是白板文件自己的变更），
      //    所以这句必须在这儿显式写。
      this.plugin.mindRepository.on('changed', (payload) => {
        this.triedMindPaths.delete(payload.path);
        this.mindLayer?.sync(this.viewport.visibleBounds());
        this.edgeLayer?.invalidate();
        // 树的形状变了 ⇒ 缩略图上那一片格子也要跟着变（批 4）
        this.minimap?.syncContent();
      }),
      this.plugin.mindRepository.on('reloaded', (payload) => {
        this.triedMindPaths.delete(payload.path);
        this.mindLayer?.sync(this.viewport.visibleBounds());
        this.edgeLayer?.invalidate();
        this.minimap?.syncContent();
      }),
    );

    // 板子已加载：面包屑此时才画（层级链要读别的板文件，早画会读到半截）。
    // `O15` 起显示名取**文件名**，不再依赖 `meta.title`
    void this.refreshBreadcrumb();

    // 补做挂起的外部定位（反链面板 / `obsidian://`）：调用方在我们还没读完文件时
    // 就发了请求。放到这里是因为此时卡片层已经画好，`visualRectOf` 才拿得到真坐标。
    const pendingReveal = this.pendingRevealCardId;
    if (pendingReveal !== null) {
      this.pendingRevealCardId = null;
      this.revealCard(pendingReveal);
    }
    // 挂起的"飞到某个脑图节点"（`2.2.0` 批 4）：与上面那条同一个时机 ——
    // 这一刻脑图层已经同步过，`nodeRectOf` 才拿得到节点真实的盒子
    const pendingMind = this.pendingRevealMind;
    if (pendingMind !== null) {
      this.pendingRevealMind = null;
      this.revealMindNode(pendingMind.mindId, pendingMind.nodeId);
    }
  }

  private detachBoard(): void {
    for (const unsubscribe of this.boardSubscriptions.splice(0)) unsubscribe();
    this.cardLayer?.clear();
    this.mindLayer?.clear();
    // 读盘记账也是"上一块板的"：换板之后 B 板上那些路径要重新试（A 板上读不到的，
    // 不代表 B 板上也读不到）
    this.loadingMindPaths.clear();
    this.triedMindPaths.clear();
    this.columnLayer?.clear();
    // 连线和覆盖提示都属于"上一块板"，换板时必须立刻消失，不能等下一帧
    this.edgeLayer?.invalidate();
    this.overlayLayer?.clear();
    // 选区也是"上一块板的"：留着会让 B 板上出现指向 A 板卡片 id 的幽灵选中态
    this.selection.clear();
    // 卡内脑图那个"现在操作哪个节点"同理（`F4`）：它带着上一块板的卡片 id，
    // 留着会让那条栏在 B 板上举着一个不存在的节点
    this.clearMindNodeFocus();
    // 编辑态同理：新板不能带着 EDITING 开局，否则 ⌘A 会一直让路给一个不存在的编辑器
    this.clearEditingState();
    // 取色会话也是"上一块板的"：留着不但会把颜色吸到新板的色板上，
    // 还会让十字光标一直挂着（下一次点击被它吃掉，用户会以为视图坏了）
    this.eyedropper?.cancel();
    this.eyedropper = null;
    // 手绘：退回选择工具，进行中的那一笔就地收尾。
    // ★ 收尾会走 `persistInkStroke` 把它落成 `ink` 卡片（T3.08）—— 目标是**上一块板**：
    //   `exit()` 在这里、`currentPath = null` 在几行之后，笔迹本来就画在那块板上。
    //   图层不必再"清空笔迹"：它只画进行中的那一笔，`exit()` 之后画布上什么都不剩。
    this.inkController?.exit();
    // 演示态（J-06）：换板必须退出演示 —— 步骤条、顺序、当前步全指向**上一块板**的
    // 卡片 id，带着演示切过去会变成"高亮一张在 B 板上根本不存在的卡"
    this.presentation?.stop();
    // 历史快照里存的是"上一块板"的内容，跨板撤销等于把 B 板改成 A 板
    this.history.clear();
    this.currentPath = null;
    // 顶栏提示也是"上一块板的"：留着会让 B 板上挂着 A 板的"这块板很大"的警告
    this.scaleAdvice = null;
    this.hideScaleHint();
  }

  /** 当前打开的白板（未打开 / 已卸载时为 `null`） */
  private get board(): BoardFile | null {
    const path = this.currentPath;
    return path ? this.plugin.repository.get(path) : null;
  }

  /** 只读保护态（W6）：解析失败的板子只许看，任何写命令都必须静默失效 */
  private isReadOnly(): boolean {
    const path = this.currentPath;
    return path ? this.plugin.repository.isReadOnly(path) : true;
  }

  /**
   * 对选中卡片做层级调整。
   *
   * 三处克制：
   *  * 无选区 / 只读 / 无板 → 直接返回，不产生任何副作用；
   *  * 用 `mutate(..., () => boolean)` 的"无变化"语义：选中项本来就压在顶层时
   *    按 `⌘⇧↑` 不该递增 `revision`、不该标脏、更不该触发一次外部同步；
   *  * **不碰选中态**：层序变了，选中集合当然还是同一批卡片。
   */
  private reorderSelection(reorder: (board: BoardFile, ids: readonly string[]) => boolean): void {
    // ★ 卡片 **与脑图**（`2.2.0` 收尾）：两者的 z 是共用的一格，"对整棵置顶 / 置底"
    //   就是老计划里那条"整棵的层级调整" —— 从前这里只有卡片，框住一棵树按 `⌘⇧↑`
    //   什么都不会发生（而它是选中的）。
    const ids = [...this.selection.cardIds, ...this.selection.mindIds];
    if (ids.length === 0) return;
    // 走 `commit` 而不是裸 `mutate`：层级调整也是可撤销的（T1.48），
    // 而裸 mutate 会让"置顶"成为撤销链上的一段静默跳跃
    this.commit(t('history.order'), (board) => reorder(board, ids));
  }

  // ── 卡片内容：渲染上下文与编辑态（T1.32） ────────────────

  /**
   * 双击卡片主体 → 进入编辑（`02 §3` / `§5.3`）。
   *
   * 要在这里拦两件事：
   *
   * 1. **双击链接 / 内嵌内容**：那是 Obsidian 自己的"打开笔记"，
   *    抢过来会变成"用户想跳转，结果进了编辑框"。其余全交给 `editCard`。
   * 2. **双击卡面标题行**（`F5`）：便签 / 同步便签的标题编辑与内容编辑**分家**
   *    （内容 = 正文编辑器，与引用卡同款；标题 = 卡面那一行的就地输入），
   *    于是"双击名字那一行"就该去改名字 —— 见 `TITLE_BAND_DOUBLE_CLICK_TYPES`。
   *
   * ★ `⌘`+双击 = 直接进正文（O01/O02）：双击的语义是"我要改这张卡"，
   *   而 `⌘`+双击是"我就是要改正文"。对标题已经写好、只想补一句话的卡，
   *   后者省掉一次 `Enter` —— 这也是键盘用户唯一的"跳过标题"入口。
   */
  private beginEditFromDoubleClick(detail: CardPointerDetail): void {
    // 演示态（J-06）：双击不该把讲的那张卡变成编辑框（`02 §4.1` 的"不可编辑"）
    if (this.presentation?.active) return;
    const target = detail.original.target;
    if (target instanceof HTMLElement && target.closest('a')) return;
    if (target instanceof HTMLElement && this.editTitleFromTitleBand(detail.cardId, target)) return;
    const raw = detail.original.metaKey || detail.original.ctrlKey;
    this.editCard(detail.cardId, false, raw ? 'raw' : 'title');
  }

  /**
   * 双击落在**卡面标题行**上时，就地改标题（`F5`）。
   *
   * @returns 是否把这一下收掉了。`false` = 不归它管（别的类型、或没点在标题行上），
   *          调用方照旧走内容编辑。
   * ★ 判据只认"这一类卡的标题就是卡面那一行"（`TITLE_BAND_DOUBLE_CLICK_TYPES`），
   *   并把"能不能真的开出来"交给 `editCardTitle`（未挂载 / 锁定 / 已在编辑标题 ⇒ 它给 `false`，
   *   于是这一下退回内容编辑，不会变成"双击了什么都没发生"）。
   */
  private editTitleFromTitleBand(cardId: string, target: HTMLElement): boolean {
    const card = this.board?.cards.find((item) => item.id === cardId);
    if (!card || !TITLE_BAND_DOUBLE_CLICK_TYPES.has(card.type)) return false;
    if (!target.closest('.nestboard-card-header')) return false;
    return this.editCardTitle(cardId);
  }

  /** 某张卡此刻的呈现模式：只有"正在编辑的那张"是 edit */
  private modeOf(card: Card): CardViewMode {
    return card.id === this.editingCardId ? 'edit' : 'display';
  }

  /**
   * 为一张卡构造渲染环境。每次重绘都会新建 —— 因为 `MarkdownRenderer` 会把内嵌
   * 组件挂在传入的 `component` 上，复用同一个等于让旧组件越积越多。
   * 旧组件由 `releaseCardContent` 在换内容 / 回收节点时卸载。
   */
  /**
   * 把剪贴板里的一张图片落进库并返回路径（`F5` 卡内粘贴图片）。
   *
   * ★ 与"直接粘在画布上变成图片卡"（本文件的 paste 分支）**共用同一份落盘规则**：
   *   附件目录跟随用户设置、命名跟 `attachmentOptions` —— 复制一份的话，改了设置之后
   *   两条路会有两种结果，而用户根本分不清自己走的是哪条。
   * ★ 失败返回 `null`（编辑器一个字都不插），提示在这里发 —— 编辑器没有 Notice 通道。
   */
  /**
   * `[[` 补全的候选（`F5`）：库内全部 `.md` 的路径。
   *
   * ★ **不缓存、不订阅**：这份清单本来就常驻内存（`vault.getMarkdownFiles` 读的是
   *   Obsidian 自己那份索引），补全每敲一个字问一次也只是数组映射；加了缓存反而要
   *   处理"新建 / 删除 / 改名"三种失效，得不偿失。
   * ★ 过滤与排序在编辑器那侧（`linkSuggest.rankLinkCandidates`）—— 这里只负责
   *   "库里有什么"，不替它判"该显示哪几条"。
   */
  private linkSuggestions(_query: string): readonly { path: string; label?: string }[] {
    return this.app.vault.getMarkdownFiles().map((file) => ({ path: file.path }));
  }

  private async pasteImageToVault(file: File): Promise<string | null> {
    try {
      return await this.plugin.attachments.savePastedImage(
        await file.arrayBuffer(),
        file.type,
        this.plugin.attachmentOptions,
      );
    } catch (error) {
      new Notice(t('notice.attachmentFailed', { error: describeError(error) }));
      return null;
    }
  }

  private createCardContext(card: Card, contentEl: HTMLElement): CardRenderContext {
    const component = new Component();
    component.load();
    this.cardComponents.set(contentEl, component);

    const sourcePath = this.currentPath ?? '';
    const mode = this.modeOf(card);
    return {
      app: this.app,
      sourcePath,
      component,
      renderMarkdown: (markdown, el) => {
        // ★ 卡片正文里的 `[[链接]]` 也要能点：`MarkdownRenderer` 只负责渲染出
        //   `<a class="internal-link" data-href>`，**跳转是视图的事**（`O25` 那条教训的
        //   另一个面）。与脑图节点共用同一个助手，两边行为一致。
        attachMarkdownLinkHandler(el, this.app, sourcePath);
        return MarkdownRenderer.render(this.app, markdown, el, sourcePath, component);
      },
      zoom: this.viewport.zoom,
      // 图片清晰度（`A5`）：设置里默认"始终用原图" ⇒ 图片卡不再降级到缩略图
      alwaysFullImage: this.plugin.settings.alwaysFullImage,
      mode,
      // 入口意图只发给**正在编辑的那张卡**（O01/O02）：同屏的其它卡即便被重画，
      // 也不该带着"我是被双击进来的"这种身份
      editEntry: mode === 'edit' ? this.editEntry : undefined,
      notes: this.notesBridge ?? undefined,
      // 脑图卡（`F3a`）：卡面就是那份 `.nestmind`；只读板上一个编辑手势都不接
      minds: this.mindsBridge(),
      readOnly: this.isReadOnly(),
      shell: this.shellBridge ?? undefined,
      // 剪贴板（T3.04）：色板卡的"点击复制"
      clipboard: this.clipboardBridge,
      // 卡内粘贴图片（`F5`）：与"粘在画布上变图片卡"共用同一份落盘规则
      pasteImage: (file) => this.pasteImageToVault(file),
      // `[[` 链接补全（`F5`）：库内 md 清单
      suggestLinks: (query) => this.linkSuggestions(query),
      boards: this.boardNavBridge(),
      // 跨白板反链（T5.04）：引用卡底部的「N 条反链」角标
      backlinks: this.backlinksBridge(),
      // 外链能力（T2.04–T2.06）：链接卡的"获取预览"按钮与双击打开都走它
      links: this.linkPreviewBridge ?? undefined,
      // 静态地图瓦片（`O08`）：地图卡只用它的 `enabled` 决定卡面那句话怎么说
      // —— 渲染路径一次都不联网（见 `MapTileBridge`）
      mapTiles: this.mapTileBridge ?? undefined,
      // 缩略图（T1.51/T1.52）：图片卡在缩放 < 0.8 时用它顶替原图
      thumbnails: this.thumbnailBridge ?? undefined,
      updateContent: (patch) => this.updateCardContent(card.id, patch),
      updateCard: (patch) => this.updateCardFields(card.id, patch),
      setMode: (mode) => this.setCardMode(card.id, mode),
      // 图标按钮（`O32`：链接卡的「打开」）—— `cards/` 不许 import obsidian，由这里画
      setIcon: (el, name) => setIcon(el, name),
      // 引用卡读完 Vault 才知道自己多高 —— 内容落地后必须让卡片层重量一次（T1.38）
      contentReady: () => this.cardLayer?.remeasure(card.id),
      // 内容自己要把卡撑大（`F4` 的脑图卡）：里面的节点永远 1:1，卡片长大到装得下
      //（"尺寸随内容自适应"，见 `requestCardSize`；只增不减、下一帧合并成一次提交）
      growTo: (size) => this.requestCardSize(card.id, size),
      // 同步便签（T7.04）：把正文写回整个同步组（一张改、全组一起改、一次重绘）
      writeSyncGroup: (key, md) => this.writeSyncGroup(key, md),
    };
  }

  // ── 白板级脑图（`2.2.0`）────────────────────────────────────

  /**
   * 这份脑图此刻的模型：内嵌读 `mind.mind`；**文件脑图去仓储取**（没读到就先起一次读盘）。
   *
   * ★ 读到之前返回 `null`：渲染层据此画一句"还没读到 / 文件没了"（`MindLayer`），
   *   而不是画一棵空树 —— 空树会让人以为"我的脑图被清空了"。
   */
  private mindModelOf(mind: Mind): MindFile | null {
    if (mind.path.length === 0) return mind.mind ?? null;
    const cached = this.plugin.mindRepository.get(mind.path);
    if (cached) return cached;
    // ★ `sync()` 每帧都跑：没读到过的路径**只试一次**（`triedMindPaths`），
    //   否则一个"文件没了"的脑图会在平移的每一帧都去发一次读盘请求。
    //   那次尝试失败之后就不必再试 —— 真等到文件回来，仓储的 `changed` 会把这条路重新放开。
    if (!this.triedMindPaths.has(mind.path)) void this.loadMindModel(mind.path);
    return null;
  }

  /**
   * 导出 / 缩略图用的**文件脑图**模型表（键 = 脑图 id，`2.2.0` 批 4）。
   *
   * ★ 内嵌脑图的模型就在 `board.minds[].mind` 里（`drawMinds` 自己会读），
   *   这里只补"指向一份 `.nestmind`"的那一些 —— 那份数据不在白板文件里。
   * ★ 没读到的不放进去：那一棵这一次就是没画（与缩略图同一条口径），
   *   而不是在导出的逐块绘制里同步等一次读盘（那会把 UI 卡住）。
   */
  private exportMindModels(board: BoardFile): ReadonlyMap<string, MindFile> {
    const models = new Map<string, MindFile>();
    for (const mind of board.minds ?? []) {
      if (mind.path.length === 0) continue;
      const model = this.plugin.mindRepository.get(mind.path);
      if (model) models.set(mind.id, model);
    }
    return models;
  }

  /**
   * 只在**已经读到**的前提下取模型（缩略图 / 导出用）：**绝不触发读盘**。
   *
   * ★ 与 `mindModelOf` 的分工：那个是渲染路径的口子（会顺手发起一次读盘），
   *   而这个会被缩略图每帧问一遍 —— 在那里发请求等于"平移一下就翻一次库"。
   *   文件脑图没读到就给 `null`（那一棵这一帧不画，读到之后那两条订阅会重画）。
   */
  private mindModelForMap(mind: Mind): MindFile | null {
    if (mind.path.length === 0) return mind.mind ?? null;
    return this.plugin.mindRepository.get(mind.path);
  }

  /** 正在读盘的脑图路径（同一路径不并发读两次） */
  private readonly loadingMindPaths = new Set<string>();
  /** 已经试过读、但没读到的路径（见 `mindModelOf`：避免每帧重试） */
  private readonly triedMindPaths = new Set<string>();

  private async loadMindModel(path: string): Promise<void> {
    if (this.loadingMindPaths.has(path)) return;
    this.loadingMindPaths.add(path);
    this.triedMindPaths.add(path);
    try {
      await this.plugin.mindRepository.open(path);
    } catch {
      // 文件没了 / 坏了：那句话由渲染层显示（这里不再打扰用户）
    } finally {
      this.loadingMindPaths.delete(path);
      // 读回来了（或失败了）⇒ 让渲染层重画一次（它自己不做异步）
      this.mindLayer?.sync(this.viewport.visibleBounds());
      // 节点盒子这一下才出现 ⇒ 连着它的线要跟着被画出来（`2.2.0` 批 3）
      this.edgeLayer?.invalidate();
      // 缩略图也才数得出这棵树（批 4）：`syncContent` 内部先比指纹，没变就不重建
      this.minimap?.syncContent();
    }
  }

  /**
   * **内嵌**脑图的读写口（`MindInlineSource`）：节点右键菜单与底部快捷栏两条路共用。
   *
   * ★ 文件脑图给 `undefined`：那份模型在文件里，读写都走 `.nestmind` 仓储
   *   （与卡片时代的分工一致）。
   */
  private inlineMindSource(mind: Mind): MindInlineSource | undefined {
    if (mind.path.length > 0) return undefined;
    const id = mind.id;
    return {
      cardId: id,
      read: () => this.board?.minds?.find((item) => item.id === id)?.mind ?? null,
      mutate: (mutator) => this.mutateMind(mind, mutator),
      requestEdit: (nodeId) => requestMindEdit(id, nodeId),
    };
  }

  /**
   * 改一次脑图的模型 —— 两条数据源与"从前的脑图卡"完全同路：
   *
   * * **内嵌**：一次 `commit` = 白板撤销栈里的**一步**（`⌘Z` 退得动）；
   * * **文件**：`mutate` 那份 `.nestmind`（原子写 + revision + 冲突检测）。
   *
   * ★ 与 `cards/mindCard` 同一条纪律：内嵌那份**深拷贝再改** —— 内存里那一份同时还是
   *   撤销栈的基线与别处的当前值，就地改会把历史一起改掉。
   */
  private mutateMind(mind: Mind, mutator: (file: MindFile) => void | boolean): boolean {
    if (mind.path.length > 0) {
      try {
        return this.plugin.mindRepository.mutate(mind.path, mutator);
      } catch {
        // 保护态（解析失败 / 只读）：一次写不进去不该把树画崩
        return false;
      }
    }
    const current = this.board?.minds?.find((item) => item.id === mind.id)?.mind;
    if (!current) return false;
    const next = cloneJson(current) as MindFile;
    if (mutator(next) === false) return false;
    return this.commit(t('history.mindEdit'), (board) => setMindModel(board, mind.id, next));
  }

  /** 脑图拖动会话的 window 监听（与卡片拖动那条**各用各的**，互不干扰） */
  private mindDragCleanup: (() => void) | null = null;

  /**
   * 从**根节点**上按下 = 拖整棵（无边界之后唯一一个"移动这棵树"的手势）。
   *
   * ★ 手势与卡片拖动同一套纪律：监听挂 `window`（指针拖出画布也收得到）、
   *   成对摘除；拖动中**只写 DOM**（`MindLayer.setPreview`），松手才提交一次 ——
   *   模型一动不动，撤销栈里只有一条"移动"。
   * ★ 不吸附网格 / 不出参考线：那是卡片的排版手段；脑图挪的是"树根那一个点"，
   *   先把基本手感做实（后续要加时，接口在这里，不必改模型）。
   */
  private beginMindDrag(mind: Mind, event: PointerEvent): void {
    if (this.mindDragCleanup) return;
    const startX = event.clientX;
    const startY = event.clientY;
    const origin = { x: mind.x, y: mind.y };
    let moved: Point | null = null;

    const onMove = (move: PointerEvent): void => {
      const zoom = this.viewport.zoom || 1;
      const point = {
        x: roundTo(origin.x + (move.clientX - startX) / zoom),
        y: roundTo(origin.y + (move.clientY - startY) / zoom),
      };
      moved = point;
      this.mindLayer?.setPreview(mind.id, point);
      // ★ 连线要跟着手走（`2.2.0` 批 3）：节点成了端点之后，"挪这棵树"也会挪动
      //   线的落点 —— 而连线是 Canvas，**不会**因为 DOM 变了就自己重画。
      //   卡片拖动那条路（`previewRects`）同样每帧标脏，理由一模一样。
      this.edgeLayer?.invalidate();
    };
    const finish = (commit: boolean): void => {
      this.mindDragCleanup?.();
      this.mindDragCleanup = null;
      // 交还给模型：预览撤掉之后，`sync()` 会按模型位置画（提交过的就是新位置）
      this.mindLayer?.setPreview(mind.id, null);
      // 取消那次（没提交）也要重画：线得从"跟着手"回到"按模型"的位置上
      this.edgeLayer?.invalidate();
      if (!commit) return;
      const target = moved;
      if (!target) return;
      this.commit(t('history.move'), (board) => moveMind(board, mind.id, target));
    };
    const onUp = (): void => finish(true);
    const onCancel = (): void => finish(false);

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    this.mindDragCleanup = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
    };
  }

  /**
   * 为卡片的**非渲染行为**构造上下文（T1.43 双击打开源笔记 / T1.45 重新链接）。
   *
   * 与 `createCardContext` 的关键区别：这里**不创建 `Component`** ——
   * 一次点击没必要挂一个 Markdown 内嵌组件再销毁（`Component` 不 load 完就 unload
   * 会报警告，load 了又要有地方 unload）。
   */
  private createActionContext(card: Card): CardActionContext {
    return {
      app: this.app,
      sourcePath: this.currentPath ?? '',
      notes: this.notesBridge ?? undefined,
      // 脑图卡（`F3a`）：双击 / 右键「打开脑图」都走它
      minds: this.mindsBridge(),
      shell: this.shellBridge ?? undefined,
      boards: this.boardNavBridge(),
      links: this.linkPreviewBridge ?? undefined,
      // 图片卡双击 = 在图上标注（T3.09）。★ 不给它"标的是哪张卡"：
      // 归属由笔迹落点算出来（`cards/ink.ts` 的 `inkHostCard`），这里只负责把笔递过去
      ink: { annotate: () => this.startInk('brush') },
      // 色卡双击弹调色板（`O29`）：与右键「卡片颜色 → 自定义颜色」共用同一个组件
      pickColor: (current, apply) => pickColor(this.app, current, apply),
      applyContent: (patch) => this.updateCardContent(card.id, patch),
    };
  }

  /**
   * 脑图桥（`F3a`）：白板 → `MindRepository` 的那道门。
   *
   * ★ 与 `notesBridge` 同一条分工：卡片层只声明能力形状（`mind/embed/MindBridge.ts`），
   *   读写策略（原子写 / revision / 冲突检测 / 保护态）全在仓储那一侧。
   * ★ `watch` 只挑**这份文件**的变化转发：仓储的事件是全局的，而每张脑图卡只关心自己
   *   那一份（不分流的话，改 A 板会把画布上所有脑图卡都重画一遍）。
   * ★ 懒建一次并缓存：它在每张卡**每一次重画**时都会被取用（`createCardContext`）。
   */
  private mindsBridge(): MindBridge {
    if (this.mindBridge) return this.mindBridge;
    const repository = this.plugin.mindRepository;
    const bridge: MindBridge = {
      exists: (path) => this.app.vault.getAbstractFileByPath(path) instanceof TFile,
      open: (path) => repository.open(path),
      get: (path) => repository.get(path),
      mutate: (path, mutator) => repository.mutate(path, mutator),
      isReadOnly: (path) => repository.isReadOnly(path),
      watch: (path, listener) =>
        repository.on('changed', (payload) => {
          if (payload.path === path) listener();
        }),
      openTab: (path) => {
        void openMindView(this.app, path);
      },
      nodeMenu: (request) => this.showMindNodeMenu(request),
      // 卡内点了一个节点 ⇒ 底部那条栏换成"这个节点"（`F4`，用户 2026-09-21）
      nodeFocus: (focus) => this.setMindNodeFocus(focus),
    };
    this.mindBridge = bridge;
    return bridge;
  }

  /**
   * 脑图卡里那个**节点**的右键菜单（`F3a`）。
   *
   * ★ 为什么画在这一层：菜单要 Obsidian 的 `Menu`，而卡片层不认识它 —— 卡片只把
   *   "哪个节点、哪一下"递出来（`MindBridge.nodeMenu`）。
   * ★ 每一项都是**一次 `mutate`**：与仓储同一条路（原子写 + revision + 冲突检测），
   *   改完由仓储的 `changed` 事件把卡片重画 —— 这里不手动重绘，免得两处各画一遍。
   * ★ 加节点之后**立刻把光标送进新节点**（`requestMindRefEdit`）：在画布上按 `Enter`/`Tab`
   *   就是那个手感，卡内不该变成"加了一个空白节点、然后自己去双击它"。
   * ★ 根节点不给「删除」：那会把整张图删掉（`ops.removeNodes` 也会跳过根，不如根本不摆）。
   */
  private showMindNodeMenu(request: MindNodeMenuRequest): void {
    const inline = request.inline;
    const mind = inline ? inline.read() : this.plugin.mindRepository.get(request.path);
    const node = mind?.nodes.find((item) => item.id === request.nodeId);
    if (!mind || !node) return;
    const isRoot = node.id === mind.rootId;
    const collapsed = node.collapsed === true;

    const add = (mutator: (target: MindFile) => void | boolean): boolean => {
      // 内嵌脑图卡（`F4`）：改的是卡片内容 ⇒ 一次 `updateContent` = 白板撤销栈里的一步
      if (inline) return inline.mutate(mutator);
      // 保护态（解析失败）会抛：一次写不进去不该把菜单点崩
      try {
        return this.plugin.mindRepository.mutate(request.path, mutator);
      } catch {
        return false;
      }
    };
    const focusNewNode = (nodeId: string): void => {
      if (inline) {
        inline.requestEdit(nodeId);
        return;
      }
      // ★ 键由**渲染方**给（`mindEditKeyOf`）：白板级脑图按脑图 id、老脑图卡按文件路径 ——
      //   写死任何一个都会让另一边的请求永远躺在槽里没人取（光标进不来）
      requestMindEdit(mindEditKeyOf(request), nodeId);
    };
    const addThenFocus = (create: (target: MindFile) => string | null): void => {
      let created: string | null = null;
      const changed = add((target) => {
        created = create(target);
        return created !== null;
      });
      if (changed && created !== null) focusNewNode(created);
    };

    // 这一个节点所在的**容器**（白板上的 `Mind`）—— 粘贴那条要改的是它里面的模型
    // （`request.cardId` 由渲染方给：白板级脑图与老脑图卡都是它）
    const container = request.cardId
      ? (this.board?.minds ?? []).find((item) => item.id === request.cardId)
      : undefined;

    const items: MenuItemSpec[] = [
      {
        id: 'mind-add-child',
        title: t('menu.mindAddChild'),
        icon: 'plus',
        run: () => addThenFocus((target) => addChild(target, node.id)),
      },
      {
        id: 'mind-add-sibling',
        title: t('menu.mindAddSibling'),
        icon: 'plus',
        run: () => addThenFocus((target) => addSibling(target, node.id)),
      },
      {
        id: 'mind-toggle-collapse',
        title: collapsed ? t('menu.mindExpand') : t('menu.mindCollapse'),
        icon: collapsed ? 'chevron-down' : 'chevron-right',
        run: () => {
          add((target) => setCollapsed(target, node.id, !collapsed));
        },
      },
      {
        // ★ 「粘贴」落在这**一个节点**上（`2.2.0` 收尾 · 用户 2026-09-23）：节点是树内部
        //   的东西，白板上别的落点对它没有意义 —— 菜单里指到哪个节点就粘到哪个节点下面。
        //   ★ 剪贴板里没有节点就置灰：不给"点了没反应"的菜单项。
        id: 'mind-paste',
        title: t('menu.mindPaste'),
        icon: 'clipboard-paste',
        // ★ 容器（白板上的那个 `Mind`）与 `mind`（模型）是两样东西：粘要改的是容器里的模型
        disabled: getMindClipboard() === null || container === undefined,
        run: () => {
          const payload = getMindClipboard();
          if (payload && container) this.pasteNodesInto(container, node.id, payload);
        },
      },
      {
        id: 'mind-delete',
        title: t('menu.mindDelete'),
        icon: 'trash-2',
        disabled: isRoot,
        run: () => {
          add((target) => removeNodes(target, new Set([node.id])));
        },
      },
    ];

    // 最后那一项：文件卡**打开**那份 `.nestmind`；内嵌卡没有文件 ⇒ 换成**导出**
    // （用户 2026-09-21：内嵌脑图卡"右键提供「导出为 `.nestmind`」"）
    if (inline) {
      items.push({
        id: 'mind-export',
        separatorBefore: true,
        title: t('menu.mindExportFile'),
        icon: 'file-output',
        run: () => {
          void this.exportInlineMind(mind);
        },
      });
    } else {
      items.push({
        id: 'mind-open',
        separatorBefore: true,
        title: t('menu.card.openMind'),
        icon: 'external-link',
        run: () => {
          void openMindView(this.app, request.path);
        },
      });
    }

    // ★ **根节点**那一份菜单还要并上"这一整张卡 / 这一整棵树"的项
    //   （用户 2026-09-21："这些功能都放到脑图的根节点上去"）：
    //   * 卡片级（颜色 / 锁定 / 复制…）—— `prepareCardMenu` 顺带把选区同步成那张卡；
    //   * **容器级**（`2.2.0`）：白板级脑图上"删掉这一整棵"只有这一个入口
    //     （无边界之后，它没有边框可以右键）。
    if (isRoot && request.cardId) {
      const cardItems = this.prepareCardMenu(request.cardId) ?? [];
      const containerItems = this.mindContainerMenuItems(request.cardId);
      const extra = [...cardItems, ...containerItems];
      // 第一项前面插一条分隔线（节点级那几项与"整棵 / 整卡"那几项是两码事）
      items.push(
        ...extra.map((item, index) => (index === 0 ? { ...item, separatorBefore: true } : item)),
      );
    }

    showMenuAtMouse(request.event, items);
  }

  /**
   * **容器级**（整棵脑图）的菜单项（`2.2.0`）—— 只有右键**根节点**时才并进来。
   *
   * ★ 与卡片级的分界：卡片那套是"一张卡的外观与复制粘贴"（`prepareCardMenu`），
   *   这里说的是"这一整棵树"——删掉它（连带挂在它身上的连线）。
   * ★ 传进来的 id 不是脑图（比如卡片）就给空数组：本方法只对 `board.minds` 里的 id 说话。
   */
  private mindContainerMenuItems(id: string): MenuItemSpec[] {
    const board = this.board;
    const mind = board?.minds?.find((item) => item.id === id);
    if (!mind) return [];
    return [
      {
        id: 'mind-container-delete',
        // ★ 与节点级的「删除节点」措辞上要分得清：这条删的是**整棵**
        title: t('menu.mindDeleteAll'),
        icon: 'trash',
        disabled: this.isReadOnly(),
        run: () => {
          this.commit(t('history.delete'), (draft) => removeMinds(draft, [id]));
        },
      },
      // 演示四项（`2.2.0` 收尾）：用户 2026-09-22 实测"菜单里没有这一项"。
      // ★ 放在**容器级**这一组里：根节点的右键菜单会并进这一组，而"加入演示"
      //   说的正是"这一整棵树"（与上面那条删除整棵同一个粒度）。
      // ★ 树身（不是节点上）的右键由 `onCanvasContextMenu` 的几何判据兜住，
      //   两条路都会走到这四项。
      ...this.mindPresentationItems(id).map((item, index) => ({
        ...item,
        separatorBefore: index === 0 ? true : item.separatorBefore,
      })),
    ];
  }

  /**
   * 把内嵌脑图卡里那份模型导出成一份 `.nestmind`（`F4`）。
   *
   * ★ 落盘走 `mind/io/newMind.writeMindToVault`：目录 / 重名顺延 / 序列化都在那一侧，
   *   这一层只说"把这份模型写出去，然后告诉用户写在哪了"。
   * ★ 导出**不改卡片**：用户想搬出去就搬，内嵌那份仍在板里（要"搬家"自己删卡即可）。
   */
  private async exportInlineMind(mind: MindFile): Promise<void> {
    try {
      // ★ 文件名按**根节点文字**（用户 2026-09-22）：根节点空着 ⇒ `未命名脑图`，
      //   重名由 `uniquePath` 顺延（那一侧本来就有）。模型里的 `meta.title` 对
      //   白板新建的树是空串，不能当文件名用（从前就落成"未命名脑图"）。
      const path = await writeMindToVault(this.plugin, mind, { title: rootTextOf(mind) });
      new Notice(t('notice.mindExported', { path }));
    } catch (error) {
      console.warn('[nestboard] 导出脑图失败', describeError(error));
      new Notice(t('notice.mindExportFailed', { error: describeError(error) }));
    }
  }

  /** 卸载挂在内容槽上的卡片级组件（换内容、节点回收、视图关闭都会走到） */
  private releaseCardContent(contentEl: HTMLElement): void {
    const component = this.cardComponents.get(contentEl);
    if (!component) return;
    this.cardComponents.delete(contentEl);
    component.unload();
  }

  /**
   * 这个端点（卡片 id 或分栏 id）能不能**作为整体**连线（`F4` 起）。
   *
   * ★ 无框卡（`chrome: 'bare'`，两张脑图卡）不行：用户 2026-09-21 —— "脑图……也不会作为
   *   整体对外连线"。它们连的是**卡内的节点**（下一步做），整张卡不参与。
   * ★ 分栏与其它类型一律能连（这一条只收走"没有盒子"的那些卡）。
   */
  private cardAttachableAsWhole(endpointId: string): boolean {
    const card = this.board?.cards.find((item) => item.id === endpointId);
    if (!card) return true;
    return this.cardRegistry.get(card.type)?.chrome !== 'bare';
  }

  // ── 快捷操作栏（`O38`）────────────────────────────────────

  /** 把"现在选中的那张卡"回灌给栏（没有就整条收起） */
  private syncQuickBar(): void {
    const bar = this.quickBar;
    if (!bar) return;

    // 卡内节点那一路什么时候失效：**选区里出现了别的卡**（用户改去看别的了）。
    // ★ 判据不是"选区必须等于那卡"：点卡里的节点**不会**选中那张卡（卡片自己
    //   `stopPropagation` 拦下了），要求等式成立的话这一路刚设上就被清掉。
    // ★ 也不要求选区非空：点了空白（选区清空）那一下由 `clearMindNodeFocus` 显式清
    //   —— 那里才是"用户点了空白"这个事实发生的地方。
    const selected = [...this.selection.cardIds];
    if (this.mindFocus && selected.some((id) => id !== this.mindFocus?.cardId)) {
      this.mindFocus = null;
    }

    // ★ 卡内脑图选着一个节点时，这条栏说的是**那个节点**（`F4`，用户 2026-09-21）——
    //   与"选中一张卡"是两条互斥的来路，先判它。
    const node = this.focusedMindNode();
    if (node) {
      const { node: item, mind } = node;
      bar.setState({
        writable: this.isMindNodeWritable(node.focus),
        features: MIND_NODE_BAR_FEATURES,
        node: {
          id: item.id,
          icon: item.icon ?? '',
          // ★ 默认值要按**层级**取（中心主题默认加粗）：与标签页那条栏逐字同一套
          //   （`titleBoldOf`），否则"看着是粗的、栏里没亮"，第一次点它反而写一个 `true`
          bold: item.style?.bold ?? titleBoldOf(depthOf(mind, item.id)),
          italic: item.style?.italic === true,
          underline: item.style?.underline === true,
          color: item.style?.color ?? null,
          ink: item.style?.ink ?? null,
          highlight: item.style?.highlight ?? null,
        },
      });
      return;
    }

    const card = this.quickBarTarget();
    const boardRef = card?.type === 'boardRef';
    bar.setState({
      writable: !this.isReadOnly(),
      // 两张卡**能改的东西不一样**：便签有"标题整条格式"，白板卡没有（它只有一个名字）；
      // 白板卡要的是"标记 / 底色 / 编辑标题"。不在集合里的按钮**不画**（不是置灰）
      features: boardRef
        ? BOARD_REF_BAR_FEATURES
        : card?.type === 'titleCard'
          ? TITLE_CARD_BAR_FEATURES
          : NOTE_BAR_FEATURES,
      editLabel: boardRef ? 'menu.card.editTitle' : 'mind.toolbar.editNote',
      node: card
        ? {
            id: card.id,
            // ★ 走 `cardIconOf` 而不是 `card.icon`：白板卡的标记在**内容**里
            //   （`BoardRefContent.icon`），读卡级那个键永远是空 ⇒ "点了没反应"
            icon: cardIconOf(card),
            bold: card.titleStyle?.bold === true,
            italic: card.titleStyle?.italic === true,
            underline: card.titleStyle?.underline === true,
            color: card.color,
            ink: card.titleStyle?.ink ?? null,
            // 文字高亮（`N3-f`）是**脑图标题**那一档格式，白板卡片没有这个概念
            highlight: null,
          }
        : null,
    });
  }

  /**
   * 栏里操作的那张卡：**恰好选中一张便签 / 仅标题卡 / 白板卡**时才有。
   *
   * ★ 只认这三类：别的不需要这条栏（图片卡 / 文件卡 / 待办卡各有各的编辑方式），
   *   "能改什么"由 {@link NOTE_BAR_FEATURES} / {@link TITLE_CARD_BAR_FEATURES} /
   *   {@link BOARD_REF_BAR_FEATURES} 说了算。
   * ★ 多选给 `null`（整条收起）：与脑图那条同一个口径。
   * ★ 仅标题卡（`A3`）**必须在列**：`syncQuickBar` 与 `TITLE_CARD_BAR_FEATURES` 早就
   *   备好了这一档（标记 / 粗 / 斜 / 下划线 / **字色** / 底色），但这里漏了它 ——
   *   于是那条栏在标题卡上永远不出现，用户报的"标题卡改不了字体颜色"就出在这一处。
   */
  private quickBarTarget(): Card | null {
    const ids = [...this.selection.cardIds];
    if (ids.length !== 1) return null;
    const card = this.board?.cards.find((item) => item.id === ids[0]);
    if (!card) return null;
    return card.type === 'note' || card.type === 'titleCard' || card.type === 'boardRef'
      ? card
      : null;
  }

  // ── 卡内脑图的节点 → 快捷操作栏（`F4`，用户 2026-09-21）───────

  /**
   * 卡内选中节点变了（`MindBridge.nodeFocus` 打上来的）。
   *
   * ★ `nodeId === null` = 卡内不再选中任何节点（节点被删、或卡被重画后那个节点没了）
   *   ⇒ 整条栏跟着收起，而不是停在"一个已经不存在的节点"上。
   */
  private setMindNodeFocus(focus: MindNodeFocus): void {
    if (focus.nodeId === null) {
      // 卡内不再选中任何节点 ⇒ 收起那一路（卡片选区不动：用户可能正拿着一张卡在做别的）
      this.mindFocus = null;
      this.syncQuickBar();
      return;
    }
    // ★ 把**键盘**交给画布（`2.2.0` 收尾 · Tab / 回车 / 方向键）：卡片里那个节点的
    //   `pointerdown` 会被卡内自己 `stopPropagation` 拦下（"按住节点不能变成拖整张卡"），
    //   于是画布**收不到那一下**、也就没机会 `focusCanvas()`。不补这一句的后果是
    //   "点了节点、按 Tab 毫无反应"，而且只在"用户还没点过画布"时复现（最难查的一类）。
    this.focusCanvas();

    // ★ 点节点 = "现在的目标就是这个节点" ⇒ 把**卡片选区**清掉。
    //   不清的话：用户先选了一张卡（哪怕是别的卡）再来点节点，下面 `syncQuickBar`
    //   那条失效判据会立刻把这一路清掉 —— 表现出来就是"点了节点，栏不出现"。
    //   也不反过来"把那张卡选上"：无框卡一选中就会画出一圈描边（那个"隐形的框"
    //   正是用户要去掉的东西）。
    this.selection.clear();
    this.mindFocus = focus;
    this.syncQuickBar();
  }

  /** 收掉"卡内选中的那个节点"（点了空白 / 换板时）—— 底部那条栏随之收起 */
  private clearMindNodeFocus(): void {
    if (!this.mindFocus) return;
    this.mindFocus = null;
    this.syncQuickBar();
  }

  /**
   * 现在被点中的那个卡内节点（连它的模型一起给出来）。
   *
   * ★ 每次都**现读模型**（内嵌卡读卡片内容、文件卡读仓储）：节点可能已经被改过好几轮
   *   （栏上的按钮、右键菜单、别处编辑），存一份快照就会"栏里显示的是旧值"。
   */
  private focusedMindNode(): { focus: MindNodeFocus; mind: MindFile; node: MindNode } | null {
    const focus = this.mindFocus;
    if (!focus?.nodeId) return null;
    const mind = focus.inline ? focus.inline.read() : this.plugin.mindRepository.get(focus.path);
    const node = mind?.nodes.find((item) => item.id === focus.nodeId) ?? null;
    if (!mind || !node) return null;
    return { focus, mind, node };
  }

  /**
   * 卡内节点的键位（`2.2.0` 收尾 · 用户 2026-09-23）—— **能接就接，接不了返回 `false`**。
   *
   * ── 与 `.nestmind` 视图的关系 ────────────────────────────────
   *
   * "哪个键干什么"全在 `mindKeyActionOf` 里（纯函数、两边共用）；这里只做**动作 → 调哪个口**：
   * 内嵌树走卡片内容（一次 `commit` = 一步撤销）、文件树走 `.nestmind` 仓储 —— 与节点右键
   * 菜单那几项完全同路（见 `mutateFocusedMind`）。
   *
   * ── 刻意**不**搬的两条（各有原因，不是漏了）──────────────────
   *
   * * `⌘[` / `⌘]`（进入当前主题 / 返回上一层）：那是**树视图的相机概念**（把某一支当作新的
   *   根重排），白板上的树是画布上的一个对象，没有"换根"这回事；
   * * `Space`（折叠 / 展开）与 `D`（拖拽辅助线）：白板把**空格**留给了"空格 + 拖动 = 平移"
   *   （`NavigationController` 在画布上就先 `preventDefault` 了），而辅助线是树视图自己的
   *   渲染辅助。折叠在白板上走节点右键菜单（那一项一直在）。
   */
  private handleMindNodeKey(event: KeyboardEvent): boolean {
    // ★ 落在**输入框 / 按钮 / 可编辑块**上的键整条让开（节点标题编辑器自己会
    //   `stopPropagation`，这一条挡的是其余那些 —— 比如焦点还在底部快捷栏的按钮上时按
    //   回车，那是"点那个按钮"，不该变成"加个同级节点"）
    if (isInteractiveKeyTarget(event.target)) return false;

    const current = this.focusedMindNode();
    if (!current) return false;

    const action = mindKeyActionOf(event);
    if (action.kind === 'none') return false;

    const { focus, mind, node } = current;
    switch (action.kind) {
      case 'add-child':
      case 'add-sibling': {
        if (!this.isMindNodeWritable(focus)) return false;
        const create = action.kind === 'add-child' ? addChild : addSibling;
        let created: string | null = null;
        const changed = this.mutateFocusedMind(focus, (file) => {
          created = create(file, node.id);
          return created !== null;
        });
        if (!changed || created === null) break;
        // ★ 先**选中新节点**再进编辑器（与 `.nestmind` 那条完全一致）：不选的话键盘还停在
        //   旧节点上，连按 `Tab` 会一路往同一个父下堆孩子（"我要往下长一层"变成"长一排"）
        this.focusMindNode(focus, created);
        // 加完**立刻把光标送进新节点**（与节点菜单那条同一个手感：按一下就打字）
        this.requestMindNodeEdit(focus, created);
        break;
      }
      case 'promote': {
        if (!this.isMindNodeWritable(focus)) return false;
        // 提升一层（与 `.nestmind` 的 `Shift+Tab` 同义）；根节点没有上一层 ⇒ `promote` 自己跳过
        this.mutateFocusedMind(focus, (file) => promote(file, node.id));
        break;
      }
      case 'edit-title': {
        if (!this.isMindNodeWritable(focus)) return false;
        this.requestMindNodeEdit(focus, node.id);
        break;
      }
      case 'delete': {
        // ★ 有**节点级框选**时让下面那道统一处理（它认整个选区，还管文件树那一半）；
        //   这里只管"只点了这一个节点、没框选别的东西"。
        if (this.selection.mindNodeKeys.size > 0) return false;
        if (!this.isMindNodeWritable(focus)) return false;
        // 借道 `deleteSelection`：内嵌进白板撤销栈、文件树写 `.nestmind` —— 与 Delete 键同源
        this.selection.set({ mindNodes: [nodeEndpointKey(focus.cardId, node.id)] });
        this.deleteSelection();
        break;
      }
      case 'move': {
        const next = neighborByArrow(mind, node.id, action.direction, {
          vertical: directionForStructure(mind.view.structure ?? 'logic-right') === 'down',
          // ★ 侧别问布局（`MindLayer.sideOf`）：左右镜像在"挂在左边的那一支"上是反的，
          //   而那是**布局**才知道的事（答不出时按"孩子在右"兜底）
          side: this.mindLayer?.sideOf(focus.cardId, node.id) ?? 1,
        });
        if (next === null) return false;
        this.focusMindNode(focus, next);
        break;
      }
      default:
        // 聚焦两键 / 折叠 / 辅助线：见上面那段"刻意不搬"（交给下面的分支或原地不动）
        return false;
    }

    event.preventDefault();
    event.stopPropagation();
    return true;
  }

  /**
   * 改一次**焦点节点所在**的那份模型。
   *
   * ★ 两条数据源各走各的（与节点右键菜单同源）：内嵌树在**卡片内容**里 ⇒ `inline.mutate`
   *   （一次 `commit` = 白板撤销栈里的一步）；文件树在 `.nestmind` 里 ⇒ 仓储
   *   （原子写 + revision + 冲突检测）。保护态 / 只读一律**安静地失败** ——
   *   一次写不进去不该把按键弄崩。
   */
  private mutateFocusedMind(
    focus: MindNodeFocus,
    mutator: (file: MindFile) => void | boolean,
  ): boolean {
    if (focus.inline) return focus.inline.mutate(mutator);
    try {
      return this.plugin.mindRepository.mutate(focus.path, mutator);
    } catch {
      return false;
    }
  }

  /**
   * 让卡内某个节点的标题**进编辑器**（"加完节点就打字" / `F2` 两处共用）。
   *
   * ★ 请求键与**渲染方取请求的那把**必须一致：白板级脑图（含文件树）按**脑图 id**
   *   （`MindLayer` 的 `takeEditRequest(mind) => takeMindEdit(mind.id)`），内嵌树走
   *   `inline.requestEdit` —— 写死成别的，请求会永远躺在槽里没人取（表现为"光标进不来"，
   *   这一条 `2.2.0` 批 4 修过一次）。
   */
  private requestMindNodeEdit(focus: MindNodeFocus, nodeId: string): void {
    if (focus.inline) {
      focus.inline.requestEdit(nodeId);
      return;
    }
    requestMindEdit(focus.cardId, nodeId);
  }

  /**
   * 把"现在选中的那个卡内节点"换成另一个（方向键）。
   *
   * ★ 优先让**渲染方**去选（`MindLayer.selectNode` ⇒ `EmbedMind.selectNode`）：那条路与
   *   "用户自己点一下"完全同路 —— 卡内选中框、底部那条快捷操作栏（经 `onSelect` 回到
   *   `setMindNodeFocus`）都会跟着到位。
   * ★ 那棵树此刻没挂载（屏幕外被裁掉 / 模型还没读到）⇒ 渲染方选不了，这里**自己记账**：
   *   至少让 Tab / 回车 / F2 接着落在正确的节点上（手里那把 `mindFocus` 就是"当前节点"）。
   */
  private focusMindNode(focus: MindNodeFocus, nodeId: string): void {
    if (this.mindLayer?.selectNode(focus.cardId, nodeId) === true) return;
    this.setMindNodeFocus({ ...focus, nodeId });
  }

  /** 卡内那个节点能不能改（白板只读 / 文件卡还要看那份 `.nestmind` 是不是保护态） */
  private isMindNodeWritable(focus: MindNodeFocus): boolean {
    if (this.isReadOnly()) return false;
    return focus.inline ? true : !this.plugin.mindRepository.isReadOnly(focus.path);
  }

  /**
   * 改卡内那个节点一次。
   *
   * ★ 两条数据源与右键菜单那一条**完全同路**（`showMindNodeMenu` 的 `add`）：
   *   内嵌卡走 `inline.mutate`（= 一次 `updateContent` = 白板撤销栈里的一步），
   *   文件卡走 `.nestmind` 仓储（原子写 + revision + 冲突检测）。
   * ★ 文件卡那边没有"白板提交 → 重画 → `syncQuickBar`"这条链，所以这里自己刷一次栏
   *   （内嵌卡刷两次也无害：同一个状态写两遍）。
   */
  private editFocusedMindNode(mutator: (mind: MindFile) => void | boolean): void {
    const target = this.focusedMindNode();
    if (!target || !this.isMindNodeWritable(target.focus)) return;
    const { focus } = target;
    if (focus.inline) {
      focus.inline.mutate(mutator);
    } else {
      // 保护态（解析失败的 `.nestmind`）会抛：一次写不进去不该把栏点崩
      try {
        this.plugin.mindRepository.mutate(focus.path, mutator);
      } catch {
        return;
      }
    }
    this.syncQuickBar();
  }

  /**
   * 把栏上那一下应用到**卡内那个节点**；没有节点在操作时返回 `false`（交给"改这张卡"）。
   *
   * 与 `MindView` 的 `applyNodeStyle` / `toggleTitleFlag` 逐项对齐：标记走 `setIcon`，
   * 其余（粗 / 斜 / 下划线 / 字色 / 高亮 / 底色）走 `setNodeStyle`。
   */
  private applyToFocusedMindNode(patch: {
    icon?: string;
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    color?: CardColor | null;
    ink?: HexColor | null;
    highlight?: HexColor | null;
  }): boolean {
    const target = this.focusedMindNode();
    if (!target) return false;
    const { node } = target;

    // 标记只对单个节点有意义（一个节点一个标记）—— 这里本来就是单选
    if (patch.icon !== undefined) {
      const icon = patch.icon;
      this.editFocusedMindNode((mind) => setMindNodeIcon(mind, node.id, icon));
      return true;
    }

    const style: MindStylePatch = {
      bold: patch.bold,
      italic: patch.italic,
      underline: patch.underline,
      color: patch.color,
      ink: patch.ink,
      highlight: patch.highlight,
    };
    this.editFocusedMindNode((mind) => setNodeStyle(mind, node.id, style));
    return true;
  }

  /**
   * 粗 / 斜 / 下划线的开关（卡内节点版）。
   *
   * ★ 判据是"**当前生效值**取反"：中心主题默认就是加粗的（`titleBoldOf`），
   *   按"数据键取反"的话第一次点它反而会写一个 `true` —— 看着像没反应（标签页那条踩过）。
   */
  private toggleFocusedMindNodeFlag(flag: 'bold' | 'italic' | 'underline'): boolean {
    const target = this.focusedMindNode();
    if (!target) return false;
    const { node, mind } = target;
    const current =
      flag === 'bold'
        ? (node.style?.bold ?? titleBoldOf(depthOf(mind, node.id)))
        : node.style?.[flag] === true;
    this.applyToFocusedMindNode({ [flag]: !current });
    return true;
  }

  /** 栏里改**卡面外观**（标记 / 粗斜下划线 / 字色）：一个入口，删键纪律都在 `updateCardLook` 里 */
  private applyCardLook(patch: {
    icon?: string | null;
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    ink?: HexColor | null;
  }): void {
    const card = this.quickBarTarget();
    if (!card) return;

    // ★ 白板卡的标记在**内容**里 ⇒ 走它自己的写入口（`setBoardRefIcon`：归一化 / 删键 /
    //   锁定判定 / `history.boardIcon` 都在那一处）。拿 `updateCardLook` 去写卡级 `icon`
    //   是"写进去了但渲染读的不是那一处"—— 用户看到的就是"换图标不生效"（真踩过）。
    //   它也没有"标题整条格式"那几项（栏里压根不会画出来，见 `BOARD_REF_BAR_FEATURES`）。
    if (card.type === 'boardRef') {
      if (patch.icon !== undefined) this.setBoardRefIcon(card.id, patch.icon);
      return;
    }

    this.commit(
      patch.icon !== undefined ? t('history.mindMark') : t('history.mindFormat'),
      (board) => updateCardLook(board, [card.id], patch),
    );
  }

  /** 栏里改**底色**：`color` 是卡片基类字段，走 `updateCards`；「默认」= 主题 1 色（`validate` 的兜底） */
  private applyCardColor(color: CardColor | null): void {
    const card = this.quickBarTarget();
    if (!card) return;
    this.commit(t('history.mindColor'), (board) =>
      updateCards(board, [card.id], { color: color ?? '1' }),
    );
  }

  /**
   * 加粗 / 斜体 / 下划线：**整条标题**的开关（`O38`，与脑图同一口径）。
   *
   * ★ 判据是"现在**生效值**取反"而不是"把 `titleStyle.bold` 取反"：便签标题的缺省
   *   不是加粗的，但"看数据不看效果"这种写法在将来改了缺省之后会立刻变得难以理解。
   */
  private toggleCardTitleFlag(flag: 'bold' | 'italic' | 'underline'): void {
    const card = this.quickBarTarget();
    if (!card) return;
    const current = card.titleStyle?.[flag] === true;
    this.applyCardLook({ [flag]: !current });
  }

  /** 色块画成**用户主题里那个色**（读不到计算值就写 `var(--color-*)`，CSS 自会解析） */
  private resolveSwatchColor(color: ThemeColor): string {
    return this.readThemeColor(color) || `var(${THEME_COLOR_VAR[color]})`;
  }

  /**
   * **这条底色上读得清**的墨色（`O38` 的撞色标题带用）。
   *
   * ★ 主题色必须解析成**计算后**的值：CSS 里的 `var(--color-red)` 是个引用，
   *   拿它算不出对比度（与连线层 `readEdgePalette` / 导出 `readPngPalette` 同一个坑）。
   * ★ 解析不出来（主题没定义这个变量）就把空串交给 `swatchInkColor` ——
   *   它算不出对比度时会退回**浅底墨色**（深色字），是保守的那一个。
   * ★ 自定义 HEX 直接用，不必碰 DOM。
   */
  private inkOn(color: CardColor): HexColor {
    const hex = isThemeColor(color) ? this.readThemeColor(color) : (normalizeHex(color) ?? '');
    return swatchInkColor(hex);
  }

  /** 读一次主题色变量（取计算值）。读不到给空串，由调用方决定怎么办 */
  private readThemeColor(color: ThemeColor): string {
    const host = this.canvasEl;
    if (!host) return '';
    return getComputedStyle(host).getPropertyValue(THEME_COLOR_VAR[color]).trim();
  }

  /**
   * 把内容改动写回模型（卡片定义通过 `CardRenderContext.updateContent` 调用）。
   *
   * ★ 写入内容 = 这次编辑的终点：先静默把状态机放回 IDLE，随后 `mutate` 的
   *   `changed` 事件触发的重绘就会**直接画显示态** —— 而不是"先重造一个编辑器再拆掉"。
   */
  private updateCardContent(cardId: string, patch: Partial<CardContentOf<CardType>>): void {
    const path = this.currentPath;
    if (!path || this.isReadOnly()) return;

    // 只有"提交的正是当前编辑的那张卡"才退出编辑态。
    // 否则会出现：双击卡片 B 进入编辑 → A 的编辑器失焦提交 → 把 B 的编辑态一起清掉。
    if (this.editingCardId === cardId) this.clearEditingState();

    const source = patch as unknown as Record<string, unknown>;
    const changed = this.plugin.repository.mutate(path, (board) => {
      const card = board.cards.find((item) => item.id === cardId);
      if (!card) return false;

      // 逐字段比对：值与现值全等时返回 false，避免"点进点出"也把文件标脏
      const current = card.content as unknown as Record<string, unknown>;
      let dirty = false;
      for (const key of Object.keys(source)) {
        if (current[key] !== source[key]) {
          dirty = true;
          break;
        }
      }
      if (!dirty) return false;

      card.content = { ...current, ...source } as unknown as Card['content'];
      return true;
    });

    // 没有模型变更就不会有 `changed` 事件 —— 仍需一次重绘把编辑器换回渲染结果
    if (!changed) this.refreshCards();
  }

  /**
   * 一次写回卡片的**标题与内容**（便签卡"标题框 + 正文框"两格编辑态的收口，O22）。
   *
   * ★ 为什么必须一次写：两格各自提交会在第一笔写入后触发重绘，而此刻这次编辑还没
   *   结束（`editingCardId` 未清）→ 编辑器被重造、另一格的现场丢失。合并成一次
   *   → 只重绘一次、只进一步撤销（与待办卡把 `title` 并进 `updateContent` 同一个道理）。
   * ★ 逐字段比对：值全等时返回 `false`，避免"点进点出"把文件标脏。
   */
  private updateCardFields(
    cardId: string,
    patch: { title?: string; content?: Partial<CardContentOf<CardType>> },
  ): void {
    const path = this.currentPath;
    if (!path || this.isReadOnly()) return;

    // 只有"提交的正是当前编辑的那张卡"才退出编辑态（同 `updateCardContent` 的理由）
    if (this.editingCardId === cardId) this.clearEditingState();

    const contentPatch = patch.content as unknown as Record<string, unknown> | undefined;
    const changed = this.plugin.repository.mutate(path, (board) => {
      const card = board.cards.find((item) => item.id === cardId);
      if (!card) return false;
      let dirty = false;

      if (patch.title !== undefined && card.title !== patch.title) {
        card.title = patch.title;
        dirty = true;
      }

      if (contentPatch) {
        const current = card.content as unknown as Record<string, unknown>;
        let contentDirty = false;
        for (const key of Object.keys(contentPatch)) {
          if (current[key] !== contentPatch[key]) {
            contentDirty = true;
            break;
          }
        }
        if (contentDirty) {
          // 与 `updateCardContent` 同一口径：浅合并，其余字段原样保留
          card.content = { ...current, ...contentPatch } as unknown as Card['content'];
          dirty = true;
        }
      }

      return dirty;
    });

    // 没有模型变更就不会有 `changed` 事件 —— 仍需一次重绘把编辑器换回渲染结果
    if (!changed) this.refreshCards();
  }

  /** 请求切换某张卡的呈现模式（卡片定义通过 `setMode` 调用） */
  private setCardMode(cardId: string, mode: CardViewMode): void {
    if (mode === 'edit') {
      this.enterEditMode(cardId);
    } else if (this.editingCardId === cardId) {
      this.leaveEditMode();
    }
  }

  /** 进入编辑态：登记卡片 + 让状态机进入 EDITING（命令层据此让出文本键） */
  private enterEditMode(cardId: string, entry: EditEntry = 'title'): void {
    if (this.isReadOnly() || this.editingCardId === cardId) return;
    // ★ 卡片必须还在。`setMode('edit')` 有可能在**一次异步写入之后**才被调用
    //   （T2.01 的引用卡写回失败要重开编辑态），那时这张卡可能已经被删掉了。
    //   放进一个不存在的卡会留下"状态机停在 EDITING、画布上却没有编辑器"的半截状态，
    //   表现是之后所有文本快捷键都没反应 —— 而这种状态用户没法自己退出来
    if (!this.board?.cards.some((card) => card.id === cardId)) return;
    // 已经在 EDITING（从 A 换到 B）时 `request` 会因同态返回 false，不能当成失败；
    // 只有"从 INK / CONNECTING 硬闯 EDITING"才拒绝 —— 半进半出会让拦截键盘的判断错位
    if (!this.pointerState.is('EDITING') && !this.pointerState.request('EDITING')) return;
    this.editEntry = entry;
    this.editingCardId = cardId;
    this.refreshCards();
  }

  /** 退出编辑态并重绘（编辑器被提交 / 取消时调用） */
  private leaveEditMode(): void {
    if (!this.editingCardId) return;
    this.clearEditingState();
    this.refreshCards();
  }

  /** 只复位状态，不触发重绘 —— 供"紧接着就会因别的原因重绘"的路径使用 */
  private clearEditingState(): void {
    this.editingCardId = null;
    this.editEntry = 'title';
    // 已在 IDLE 时 `escape()` 返回 false，是安全的空操作
    this.pointerState.escape();
  }

  private refreshCards(): void {
    // `refresh()` 只标脏；真正的挂载 / 重绘发生在 `syncCanvas()`（要裁剪，需要视口）
    // ★ 收起状态要**赶在**标脏之前推下去（O03）：晚一步的话这次刷新会按旧账本画一帧
    this.syncHiddenCards();
    this.cardLayer?.refresh();
    // 脑图层（`2.2.0`）没有"标脏等裁剪"那一套：容器数量是几十这一档，直接对齐最省事
    //（幂等：静止时只做几次数值比较，见 `MindLayer.sync`）
    this.mindLayer?.sync(this.viewport.visibleBounds());
    // 栏里的"现在按着哪个态"（标记 / 粗斜下划线 / 色块）跟着这一帧走：改了外观之后
    // 选区可能没变，只靠上面那次订阅会漏掉（与脑图 `paint()` 里那一句同一条理由）
    this.syncQuickBar();
    // 分栏也要一起重算：栏内的计数徽标、成员顺序都跟着卡片数据走，
    // 而**栏内滚动的占位块高度**还是拿"内容底边"算的（`ColumnLayer.measure`）。
    // ★ 用一个 `measure` 而不是 `refresh()`：后者只标脏，滚动条高度会停留在旧账本上。
    const board = this.board;
    if (board) this.columnLayer?.measure(board);
    else this.columnLayer?.refresh();
    // 走 `refresh` 的路径（进出编辑态等）不经过 `applyBoard`，但内容高度可能刚变过，
    // 偏移可能已经越界 —— 顺手钳一次（便宜：没有滚动时立刻返回）
    this.syncColumnScroll();
    this.syncCanvas();
  }

  private applyBoard(board: BoardFile): void {
    // ★★ 存量图片卡的"相框"归一到默认黑（用户 2026-09-17："图片卡，边框和背景颜色，默认黑色"）。
    //   新建的卡在创建时就拿到黑色了，这一句管的是**当年建的**那些 —— 它们拿的是"全局默认色"，
    //   看起来五颜六色。★ 判据是"它还等于全局默认色吗"：用户自己挑过颜色的（含"就挑了这个默认色"
    //   之外的任何值）一律不动。★ **只改内存、不主动写盘**：打开一块板不改文件；用户下次真的
    //   动了别的东西时它会跟着一起落盘。幂等（改完就是黑的，第二次进来直接跳过）。
    for (const card of board.cards) {
      const fallback = this.plugin.settings.defaultCardColor;
      if (card.type === 'image') {
        normalizeImageCardColor(card, fallback);
        continue;
      }
      // 视频 / 音频卡（`A1` / `A2`，用户 2026-09-18）：与图片卡同一条路 ——
      // "还没挑过颜色"的那张掰成各自的默认色（纯黑 / `#261f1b`），挑过的一个字节不动。
      // ★ 写成 `continue` 而不是嵌套：`card` 在 `=== 'image'` 那一支里已被收窄成图片卡，
      //   塞在里面的 `=== 'video'` 是永远不成立的比较（TS 会直接报"两端没有交集"）
      if (card.type === 'video') {
        normalizeVideoCardColor(card, fallback);
        continue;
      }
      if (card.type === 'audio') normalizeAudioCardColor(card, fallback);
    }

    // 正在编辑的卡片可能被外部改动删掉了 —— 留着一个悬空的编辑态会让键盘一直被拦截
    if (this.editingCardId && !board.cards.some((card) => card.id === this.editingCardId)) {
      this.clearEditingState();
    }

    // 选区同理：撤销 / 外部改动 / 重命名跟随都可能让选中的对象消失，
    // 留着幽灵 id 会让"删除选中项"之类的命令对着空气操作
    if (this.selection.size > 0) {
      const aliveCards = new Set(board.cards.map((card) => card.id));
      const aliveColumns = new Set(board.columns.map((column) => column.id));
      // 连线的同一种幽灵：删了一条线再撤销、或外部改了文件，都可能让选区里
      // 留下已不存在的边 id（下次按 Delete 就会去删空气）
      const aliveEdges = new Set(board.edges.map((edge) => edge.id));
      // 脑图（`2.2.0` 批 5）同理：框选之后再撤销掉"新建那棵树"，选区里那个 id 就悬空了
      const aliveMinds = new Set((board.minds ?? []).map((mind) => mind.id));

      const keptCards = [...this.selection.cardIds].filter((id) => aliveCards.has(id));
      const keptColumns = [...this.selection.columnIds].filter((id) => aliveColumns.has(id));
      const keptEdges = [...this.selection.edgeIds].filter((id) => aliveEdges.has(id));
      const keptMinds = [...this.selection.mindIds].filter((id) => aliveMinds.has(id));

      // ★ 四类一次 `set()` 给全：`set` 是"整体替换"，省略的那类会被清空
      if (
        keptCards.length !== this.selection.cardIds.size ||
        keptColumns.length !== this.selection.columnIds.size ||
        keptEdges.length !== this.selection.edgeIds.size ||
        keptMinds.length !== this.selection.mindIds.size
      ) {
        this.selection.set({
          cards: keptCards,
          columns: keptColumns,
          edges: keptEdges,
          minds: keptMinds,
        });
      }
    }

    this.background?.setBackground(board.view.background, board.settings.gridSize);
    // ★ 只读态要在 `setBoard` **之前**灌进去：`setBoard` 会让新挂载的栏立刻
    //   走一遍 `applyColumn`，反过来的话先挂上的那批栏要多等一次 sync 才摘掉"能拖"的指针
    this.columnLayer?.setReadOnly(this.isReadOnly());
    // ★ 收起的编组要在**这一次**同步里就藏起来（O03）：`setBoard` 会标脏，
    //   紧接着的 `syncCanvas()` 立刻重排 —— 晚一步设，收起的分组会先闪出来半帧
    this.syncHiddenCards();
    this.cardLayer?.setBoard(board);
    this.columnLayer?.setBoard(board);
    // ★ 连线层必须**显式**标脏：卡片层与分栏层靠 `setBoard` 记账，而 `syncCanvas()`
    //   里的 `EdgeLayer.sync()` 只在**相机或尺寸**变化时重绘（那是"视口跟随"的职责，
    //   内容变更不在其中）。漏掉这一句的表现是：新建 / 删除 / 改样式的连线
    //   **当场不出现**，要平移一下（相机变了才重画）或重开标签页才看得见。
    this.edgeLayer?.invalidate();
    // 内容变了要重绘：`setBoard` 只标脏，真正的挂载/回收发生在 `syncCanvas()`
    //
    // ★ 栏内滚动必须**赶在** `syncCanvas()` 之前同步：卡片层是在挂载/重绘那一刻
    //   读滚动状态的。晚一步的话，内容变矮（或栏被删）之后的第一帧会按旧偏移画 ——
    //   也就是"撤销一次插入，栏里的卡片先跳一下再回来"。
    this.syncColumnScroll();
    this.syncCanvas();
    // 内容变了，规模也可能变了（粘贴进来 500 张卡）：提示与折叠判断跟着重算
    this.refreshScaleHint(board);
    // 锁定状态也在这条路径上变（`setLocked` 会发 `changed`）：
    // 提示条、工具条的可用态都靠这一句跟上，不必让解锁命令自己记得刷
    this.refreshLockHint();
    // 浮层开着时清单可能已经过期（勾掉一条 / 撤销 / 别的视图写回）。
    // ★ 放在**最后**：`refresh()` 读的是"现在"的模型，必须在所有降级动作之后
    this.todoOverview?.refresh();
    // 断链清单要先重算：过滤靠它判"只看断链"，总览靠它列条目 —— 两者读的是
    // 同一份"现在"的模型（与待办浮层同理，放在所有降级动作之后）
    this.refreshBrokenRefs();
    this.syncCardFilter();
    this.linkOverview?.refresh();
    // 工具条（T3.21）：只读切换、网格吸附、缩放上下限都会改变某几格的
    // 可用 / 按下状态，而"板子变了"这条路径是它们**共同**的必经点。
    // ★ `sync()` 内部先比状态再写 DOM（见 `Toolbar.applied`），重复调不花钱
    this.toolbar?.sync();
    // 缩略图导航器（T5.09）：内容变了要重算映射与格子。
    // ★ 这是**它唯一的重内容入口**，而它内部先比"内容指纹 + 盒子尺寸"，
    //   没变就一个 DOM 都不碰 —— 自动高度、拖动落定都会走到这里，重算一遍指纹很便宜，
    //   重建几百个格子不是。相机变化不走这里（见 `syncCanvas`）。
    this.minimap?.syncContent();
    this.syncEmptyHint();
    // 演示路径（J-06）：删卡 / 撤销 / 外部改动都会让"第几步是哪张卡"过期。
    // ★ 放在**最后**：`refresh()` 读的是"现在"的卡片列表，必须等所有降级动作落定
    this.presentation?.refresh();
  }

  /**
   * 空板引导的显隐（T3.21）。
   *
   * ★ **只认"没有任何卡片"**：空白的分栏不算内容 —— 用户建了一栏却还没往里放卡，
   *   此刻正需要那句"用工具条加一张卡片"，把引导收掉等于在他最迷茫的时候熄灯。
   * ★ 一旦板上有了第一张卡就**再也不显示**：那块地方是画布正中，长期摆一句话
   *   会挡住卡片（引导只在"什么都没有"时有价值）。
   */
  private syncEmptyHint(): void {
    const hint = this.emptyHintEl;
    if (!hint) return;
    const board = this.board;
    // ★ 脑图也算内容（用户 2026-09-22 实测：往空板里插一棵树，那句"这块白板还是空的"
    //   还杵在那儿）。分栏**不算** —— 这条口径没变（见上面那段注释）。
    const visible = board !== null && board.cards.length === 0 && (board.minds?.length ?? 0) === 0;
    if (visible === this.lastEmptyHintVisible) return;
    this.lastEmptyHintVisible = visible;
    hint.toggleClass('is-visible', visible);
  }

  // ── 大文件分级退化（T2.16 / `02 §8.3`）────────────────────

  /**
   * 打开大板时先按规模降级，再交给 `applyBoard` 渲染。
   *
   * ★ 为什么必须在 `applyBoard` **之前**：先折再画。反过来的话，第一帧会把几千张卡
   *   全量挂上 DOM，紧接着又全部折回去 —— 界面闪一下，而最贵的那一帧白付了。
   * ★ 为什么只改内存模型、不走 `repository.mutate`：折叠是"为了看得动"的显示降级，
   *   不是内容改动。走 `mutate` 会让"打开一块大板"当场标脏并回写整个文件
   *   （5000 卡 ≈ 3MB），等于用户只是看了一眼就把文件重写一遍。
   *   用户之后真的编辑时，折叠状态会随那一次保存自然落盘。
   * ★ 每个路径只应用一次：用户手动展开后再切回来，不该被重新折回去。
   */
  private async applyScaleDegradation(path: string, board: BoardFile): Promise<void> {
    // 拿不到大小就传 `null`：`scaleAdviceOf` 只在**确实超限**时才提示，不编造一个 0
    const stat = await this.plugin.vaultIO.stat(path);
    this.scaleFileBytes = stat?.size ?? null;
    this.scaleAdvice = scaleAdviceOf({
      cards: board.cards.length,
      fileBytes: this.scaleFileBytes,
    });

    if (!this.scaleAdvice.collapseColumns || this.collapseDefaults.has(path)) return;
    this.collapseDefaults.add(path);
    for (const column of board.columns) setColumnCollapsed(board, column.id, true);
  }

  /**
   * 重算并渲染顶栏性能提示（T2.16）。
   *
   * 只提示**一件最该做的事**（拆板 > 退化 > 文件过大，见 `scaleHintKey`）：
   * 三条挤在一行里等于三条都没说。
   */
  private refreshScaleHint(board: BoardFile): void {
    const advice = scaleAdviceOf({ cards: board.cards.length, fileBytes: this.scaleFileBytes });
    this.scaleAdvice = advice;

    const hintEl = this.scaleHintEl;
    if (!hintEl) return;

    const key = scaleHintKey(advice);
    if (key === null) {
      this.hideScaleHint();
      return;
    }

    hintEl.empty();
    hintEl.removeClass('is-hidden');
    hintEl.createSpan({
      cls: 'nestboard-scale-hint__text',
      text: t(
        key,
        key === 'scale.hint.oversized'
          ? { size: formatBytes(this.scaleFileBytes ?? 0) }
          : { cards: board.cards.length },
      ),
    });

    // 按钮都按"当前实际状态"给：栏没折就不必给"展开"，不需要拆板就不给拆板
    if (board.columns.some((column) => column.collapsed)) {
      this.scaleHintButton(hintEl, t('scale.action.expandAll'), () => this.expandAllColumns());
    }
    if (advice.suggestSplit) {
      this.scaleHintButton(hintEl, t('scale.action.split'), () => this.openSplitBoard());
    }
    this.scaleHintButton(hintEl, '✕', () => this.hideScaleHint(), t('scale.action.dismiss'));
  }

  /**
   * 加一个提示条按钮。
   *
   * ★ 用裸 `addEventListener` 而不登记给 `teardownCanvas`：提示条的内容每次刷新都
   *   `empty()` 重建，旧按钮连着自己的监听器一起被丢弃，不存在跨板残留。
   */
  private scaleHintButton(
    parent: HTMLElement,
    label: string,
    onClick: () => void,
    ariaLabel?: string,
  ): void {
    const button = parent.createEl('button', { cls: 'nestboard-scale-hint__btn', text: label });
    if (ariaLabel) button.setAttribute('aria-label', ariaLabel);
    button.addEventListener('click', onClick);
  }

  /** 撤掉顶栏提示（没有提示 / 提示条还没建时是空操作） */
  private hideScaleHint(): void {
    const hintEl = this.scaleHintEl;
    if (!hintEl) return;
    hintEl.empty();
    hintEl.addClass('is-hidden');
  }

  // ── 归档锁定（T4.06 / `03 §2.5`）───────────────────────────

  /**
   * 同步「归档锁定」提示条的可见性。
   *
   * ★ 只认 `lockReason() === 'locked'`，**不认** `isReadOnly()`：保护态（解析失败）
   *   走的是另一条提示（打开时的通知 + 画布上的占位说明）。这里要是用
   *   `isReadOnly()`，一块损坏的板子会被说成"你把它锁了，点这里解锁"——
   *   而点下去什么也不会发生（`setLocked` 拒绝保护态）。
   */
  private refreshLockHint(): void {
    const visible = this.currentPath !== null && this.plugin.repository.isLocked(this.currentPath);
    // 没变就一个类名都不动：`applyBoard` 是内容变化时最热的那条路径
    if (visible === this.lastLockHintVisible) return;
    this.lastLockHintVisible = visible;

    const hintEl = this.lockHintEl;
    if (!hintEl) return;
    hintEl.toggleClass('is-hidden', !visible);
    // 根节点上留一个状态类：卡片层据此收起"可编辑"的指针样式（见 styles.css）
    this.contentEl.toggleClass('is-board-locked', visible);
  }

  /**
   * 锁定 / 解锁当前白板。
   *
   * ★ 顺序：**先退出编辑与手绘，再落锁**。反过来的话，锁上之后编辑器失焦提交会撞上
   *   `mutate` 的拒绝（抛错），用户看到的只是"点了一下，然后弹了个看不懂的错误"。
   *   `leaveEditMode()` 的语义正是"取消编辑、丢弃未提交的输入"，这里要的就是它。
   * ★ 解锁**不能**走 `commit`（那条路第一句就是 `if (this.isReadOnly()) return false`）——
   *   由 `repository.setLocked` 直接落，它是锁定板上唯一放行的写操作。
   */
  private async setBoardLocked(locked: boolean): Promise<void> {
    const path = this.currentPath;
    if (!path) return;
    // 已经是目标状态：可能来自两条入口（命令 / 提示条按钮）几乎同时到达
    if (this.plugin.repository.isLocked(path) === locked) return;

    if (locked) {
      this.inkController?.exit();
      this.leaveEditMode();
      // 选区留着（用户可能还想导出这一批卡）：`canManipulate*` 会当场变 false，
      // 所有会改内容的命令自动失效，不需要在这里手动清
    }

    // `setLocked` 内部会 `flush` 并把落盘 **await** 完，所以下面这句通知
    // 保证是在"锁已经写进文件"之后才说的 —— 见那里的注释
    const changed = await this.plugin.repository.setLocked(path, locked);
    if (!changed) return;

    // ★ 提示里**报板名不报路径**：用户眼前就是这块板，路径是一串噪点
    new Notice(t(locked ? 'notice.boardLocked' : 'notice.boardUnlocked'));
  }

  /** 命令可用条件：能把当前板锁起来（保护态与已锁定的板都不给） */
  get canLockBoard(): boolean {
    return !this.isReadOnly();
  }

  /** 命令可用条件：能解锁（只有**用户自己锁的**板子给，保护态不给） */
  get canUnlockBoard(): boolean {
    const path = this.currentPath;
    return path !== null && this.plugin.repository.isLocked(path);
  }

  /** 「锁定白板（只读）」命令入口 */
  lockBoard(): void {
    void this.setBoardLocked(true);
  }

  /** 「解锁白板」命令入口 */
  unlockBoard(): void {
    void this.setBoardLocked(false);
  }

  /**
   * 展开当前板的全部折叠分栏（提示条上的按钮）。
   *
   * ★ 这里走 `repository.mutate` **落盘**，与"打开时自动折叠"刻意不同：
   *   自动折叠是显示降级（不写盘），而用户点"展开全部"是他自己的决定，理应记住。
   */
  expandAllColumns(): void {
    const path = this.currentPath;
    if (!path) return;

    let count = 0;
    const applied = this.plugin.repository.mutate(path, (board) => {
      for (const column of board.columns) {
        if (setColumnCollapsed(board, column.id, false)) count += 1;
      }
      return count > 0;
    });
    // 本来就都展开着 → `mutate` 判为"无变化"，不发通知也不落盘
    if (!applied) return;
    new Notice(t('notice.columnsExpanded', { count }));
  }

  /** 命令可用性：至少要能拆成 2 组，拆板才有意义（1 组叫搬家） */
  get canSplitBoard(): boolean {
    const board = this.board;
    if (!board) return false;
    return splitGroupCount(board) >= SPLIT_MIN_GROUPS;
  }

  /**
   * 「拆分白板」向导（T2.16 / `02 §8.3`）。
   *
   * 拆不动时**说清楚为什么**（"没有非空分栏"而不是甩一个空面板），
   * 因为走进这个入口的人刚被告知"板太大了，建议拆"。
   */
  openSplitBoard(): void {
    const board = this.board;
    if (!board) return;

    const plan = splitBoardPlan(board, {
      fallbackTitle: (index) => `${t('column.title.placeholder')} ${index + 1}`,
    });
    if (!plan.ready) {
      new Notice(t('modal.splitBoard.empty'));
      return;
    }

    const total = board.cards.length;
    new SplitBoardModal(this.app, {
      children: plan.children,
      summarize: (selected) => {
        const moved = selected.reduce((sum, index) => sum + plan.children[index].cardIds.length, 0);
        return {
          text: t('modal.splitBoard.summary', {
            children: selected.length,
            moved,
            remaining: total - moved,
          }),
          ready: selected.length >= SPLIT_MIN_GROUPS,
        };
      },
      onConfirm: (selected) => void this.runSplit(plan, selected),
    }).open();
  }

  /**
   * 执行拆板。
   *
   * ★ 顺序不可颠倒：**先把所有子板写盘成功，再回头改原板**。
   *   反过来的话，中途某一块写失败时原板上那些卡片已经删掉了，
   *   而它们既不在新板里、也不在原板里 —— 内容真的丢了。
   *   代价是极端情况下可能留下几块"孤儿"子板（提示里已说明），这远好于丢内容。
   */
  private async runSplit(plan: SplitBoardPlan, selected: readonly number[]): Promise<void> {
    const path = this.currentPath;
    const board = this.board;
    if (!path || !board) return;

    const folder = this.plugin.settings.newBoardFolder;

    try {
      const moves: SplitMove[] = [];
      for (const index of selected) {
        const child: SplitChild = plan.children[index];
        // ★ 文件名要净化，卡片标题不用：分栏标题是用户随手打的，可能带 `/` `:` ——
        //   直接当文件名会建出意外的子目录或直接写失败；而标题本身照原样显示才不丢信息
        const childPath = await uniquePath(
          folder,
          sanitizeFileName(child.title, t('column.title.placeholder')),
          `.${BOARD_EXT}`,
          (candidate) => this.plugin.vaultIO.exists(candidate),
        );
        await this.plugin.repository.createBoard(
          childPath,
          // 第四参是**源板**路径：子板挂回源板，进子板时面包屑才显示「源板 → 子板」
          // （`F2-8-4`），`⌘U` 也才回得去 —— 与「新建子白板」写的是同一个字段
          buildSplitChildBoard(board, child, child.title, path),
        );
        await this.plugin.registry.upsert(childPath);
        moves.push({ ...child, path: childPath });
      }

      // 一次 mutate、一次落盘：拆板是用户明确点的，不做防抖 —— 多点几下的代价是写坏文件
      this.plugin.repository.mutate(path, (draft) => applySplitToSource(draft, moves), {
        immediate: true,
      });

      const paths = moves.map((move) => move.path);
      const shown = paths.length <= 3 ? paths.join(', ') : `${paths.slice(0, 3).join(', ')} …`;
      new Notice(t('notice.boardSplit', { count: moves.length, paths: shown }));
    } catch (error) {
      new Notice(t('notice.boardSplitFailed', { error: describeError(error) }));
    }
  }

  private renderUnavailable(path: string): void {
    const canvas = this.canvasEl;
    if (!canvas) return;
    this.cardLayer?.clear();
    this.mindLayer?.clear();
    this.columnLayer?.clear();
    canvas.querySelector('.nestboard-notice')?.remove();
    const notice = canvas.createDiv({ cls: 'nestboard-notice' });
    notice.createDiv({ cls: 'nestboard-notice-title', text: t('view.unavailable.title') });
    notice.createDiv({ text: t('view.unavailable.desc', { path }) });
  }

  // ── 视口 → 渲染 / 落盘 ──────────────────────────────────

  private readonly handleViewportChange = (): void => {
    // 相机变化是**高频事件流**（120Hz 触控板一帧能来好几个 wheel / pointermove）：
    // 合并成"一帧一次提交"，否则同一帧要把卡片层裁排与连线重绘跑好几遍（T2.14）。
    this.frameQueue.schedule(this.commitCamera);

    const path = this.currentPath;
    if (!path || this.restoringViewport) return;

    // W3：视口是**界面状态** —— 写文件但不递增 revision，也刻意不发 `changed`
    //（平移每秒变几十次，广播出去会让卡片层整层重渲染，GPU 合成的前提就没了）
    // ★ 落盘也合并到帧：状态在**提交那一刻**才读，写下去的必然是最后一个事件的值
    this.pendingViewPath = path;
    this.frameQueue.schedule(this.commitViewState);
  };

  /** 相机提交（帧任务）：把当前视口写进 DOM */
  private readonly commitCamera = (): void => {
    this.syncCanvas();
  };

  /**
   * 视口落盘（帧任务）。
   *
   * ★ 提交时再校验一次 `currentPath`：`handleViewportChange` 是同步排队的，
   *   而"排上队之后这一帧内换了白板"并非不可能（切标签很快）。少这一道校验，
   *   就会把**上一块板的视口状态写进刚打开的那块板**。
   */
  private readonly commitViewState = (): void => {
    const path = this.pendingViewPath;
    this.pendingViewPath = null;
    if (!path || path !== this.currentPath) return;
    this.plugin.repository.updateView(path, this.viewport.toState());
  };

  private syncCanvas(): void {
    const world = this.worldEl;
    if (world) world.style.transform = this.viewport.transform();
    if (this.canvasEl) {
      // 供 CSS 用：卡片字号在缩得太小时不再跟随缩小（02 §7）
      this.canvasEl.style.setProperty('--nestboard-zoom', String(roundTo(this.viewport.zoom, 4)));
    }
    this.background?.sync(this.viewport);
    // Canvas 层自己处理 DPR 与尺寸跟随（T1.27）：`EdgeLayer.sync` 里会顺带 `resize`，
    // 因为 `Viewport.setSize()` 不发通知，尺寸变化只能靠这条必经之路捎带同步。
    this.edgeLayer?.sync(this.viewport);
    // 弧度手柄（T7.12）也摆在这条必经路径上：它自己订阅了视口与选区，
    // 但"模型换了 / 换成另一块板 / 刚量到尺寸"这些变化没有别的通知点 ——
    // `sync()` 是幂等的，静止时只做几次比较
    this.edgeCurveController?.sync();
    // 可访问名里的卡片数（T3.26）：这里是最贴近"板子变了"的必经路径，
    // 且函数内部会先比对缓存，没变就不写 DOM
    this.syncBoardAriaLabel();
    // 工具条（T3.21）：缩放百分比那格**每帧都在变**，所以它必须挂在这条热路径上。
    // ★ 但这不违反"渲染路径上禁止每帧 DOM 写"（`02 §8.2`）—— `sync()` 内部先比
    //   状态、没变就一个属性都不写（见 `Toolbar.applied`），这里付出的只是
    //   一次数组构造与几次数值比较。反过来"只在缩放命令里调 `sync()`"是错的：
    //   滚轮缩放、触控板捏合、`fitContent` 各走各的路，漏掉任何一条都会让
    //   百分比停在旧值上 —— 那是最容易被用户当成"显示坏了"的一类缺陷
    this.toolbar?.sync();
    // 缩略图导航器（T5.09）：视口框得跟着相机走，所以也挂在这条热路径上。
    // ★ 与工具条同理，它内部**先比几何再写 DOM**（见 `Minimap.syncViewportRect`），
    //   而且只算一个矩形 —— 不做内容重算（那是 `syncContent` 的事，只在板子变了时调）。
    //   反过来"只在平移命令里调"是错的：滚轮、捏合、适应内容各走各的路。
    this.minimap?.syncCamera();
    // 手绘层同理：笔迹存的是世界坐标，缩放平移时只是**重画**，不必重算任何几何
    this.inkLayer?.sync(this.viewport);
    // 覆盖层是屏幕坐标，相机一动旧提示就错位 —— `sync` 负责清掉
    this.overlayLayer?.sync(this.viewport);
    // 裁剪依赖视口：平移缩放时旧卡片离场、新卡片进场，节点从复用池取（T1.25 / T1.26）
    this.cardLayer?.sync(this.viewport);
    // 脑图层（`2.2.0`）：与卡片同在世界层里，跟着同一份视口重排
    //（容器拖动期间它**不写位置** —— 那几帧归手势，见 `MindLayer.setPreview`）
    this.mindLayer?.sync(this.viewport.visibleBounds());
    // ★ 紧跟着补画拖动预览：`sync` 刚把卡片按模型位置重排过，手上那一张会弹回原位
    //   （T2.14，见 `reapplyDragPreview`）
    this.reapplyDragPreview();
    // ★ 编组框必须排在**拖动预览之后**：它的几何是从"卡片此刻的视觉矩形"算出来的，
    //   而上面那一行刚刚把预览贴回 DOM —— 反过来的话，一帧里永远是"卡在旧位置、
    //   框在新位置"（拖动时框会明显落后于卡片，看起来像两组东西在打架）
    this.syncGroupLayer();
    // 分栏层的裁剪同样依赖视口（T1.54）。★ 放在卡片层之后：
    // 两层都靠 `z-index` 竞争，DOM 里的先后只影响"同 z 平局"，而平局时卡片该赢
    // ★ 隐藏名单**挂在这条必经路上**（用户 2026-09-16："收起分组，分栏不消失，
    //   点一下才消失"）：原来挂在 `refreshCards` 上，而"收起编组"那条路不经过它 ——
    //   于是要等下一次点击 / 缩放的帧才把这份名单推下去。每帧推一次是免费的
    //   （`setHidden` 内容没变就直接返回）。
    const board = this.board;
    if (board) this.columnLayer?.setHidden(collapsedGroupColumnIds(board));
    this.columnLayer?.sync(this.viewport);
    this.drawInsertLine();
    // 智能参考线（T3.12）与插入线同理：覆盖层随相机变化被整体清空，必须补画，
    // 否则"一边拖一边滚轮缩放"时参考线会在缩放后凭空消失
    this.drawSmartGuides();
    // 外部拖入的幽灵卡 / 分栏插入线（T1.66）：与插入线同理，必须每帧补画 ——
    // 覆盖层随相机变化被整体清空，而"一边拖文件一边滚轮缩放"同样常见。
    // 拖动期间 `applyDropPreview` 只走 `beginFrame` 重画，不重跑 `syncCanvas`（省一次卡片层同步）
    this.drawDropPreview();
    this.drawDropColumnLine();
    // 演示高亮（J-06）：卡片层是池化的（离场的卡会被回收、复用到新卡上），
    // 上一帧打的 class 会随复用丢掉 —— 所以必须在**每帧渲染之后**补一次。
    // ★ 只在演示态下做：非演示态一次 `querySelectorAll` 都不做，热路径零开销
    if (this.presentation?.active) this.presentation.syncHighlight();
  }

  /**
   * 重画插入线（T1.55）。
   *
   * ★ 必须由 `syncCanvas` **每帧补画**，不能在拖动开始时画一次了事：
   *   覆盖层是屏幕坐标，每次相机变化都会整体清空（不清就会留下按旧缩放画出的残影），
   *   而"一边拖一边滚轮缩放"恰恰是用户在长白板上最常见的动作。
   */
  private drawInsertLine(): void {
    const overlay = this.overlayLayer;
    const target = this.dropTarget;
    if (!overlay || !target) return;
    // 只换算两端点的 y：线宽由覆盖层自己定（缩放不该把线缩成半像素而看不见）
    const left = this.viewport.toScreen({ x: target.line.x, y: target.line.y });
    const right = this.viewport.toScreen({
      x: target.line.x + target.line.width,
      y: target.line.y,
    });
    overlay.drawInsertLine({ x1: left.x, y1: left.y, x2: right.x, y2: right.y });
  }

  // ── 外部拖入：预览与落地（T1.63–T1.67，F6-01–F6-07） ─────

  /**
   * 外部拖入的落点预览（T1.66）。
   *
   * ★ 与 `dropTarget`（卡片内部拖动）是两条独立通路：这里由 `DragDropBridge` 的
   *   `onPreview` 高频驱动，`dragover` 每帧都来一次。
   *
   * ★ 每帧手动 `beginFrame` 而不是 `syncCanvas`：`syncCanvas` 会顺带重排卡片层 /
   *   分栏层，而拖动期间模型没变，重排纯属浪费。`beginFrame` 只清空覆盖层。
   */
  private applyDropPreview(preview: DragDropPreview | null): void {
    const overlay = this.overlayLayer;
    if (!overlay) return;

    if (!preview) {
      if (this.dropPreview === null && this.dropColumnLine === null) return;
      this.dropPreview = null;
      this.dropColumnLine = null;
      // 手动开一帧清掉幽灵卡；下一帧相机若变化，`syncCanvas` 也会自然补画
      overlay.beginFrame();
      return;
    }

    const canvas = this.canvasEl;
    if (!canvas) return;
    // ★ 指针坐标 → 世界坐标：先减画布原点（client 坐标是 window 系），再走视口换算
    const rect = canvas.getBoundingClientRect();
    const center = this.viewport.toWorld({
      x: preview.clientX - rect.left,
      y: preview.clientY - rect.top,
    });
    this.dropPreview = { center, items: preview.items };

    // 指针正好落在某个分栏上 → 整批会收进那一栏，插入线也要跟着画
    const board = this.board;
    this.dropColumnLine = board ? (findDropTarget(board, center)?.line ?? null) : null;

    overlay.beginFrame();
    this.drawDropPreview();
    this.drawDropColumnLine();
  }

  /**
   * 幽灵卡（T1.66 / F6-05）：屏幕坐标，每帧按当前视口现算。
   *
   * 只画**第一张**的框：一次拖十张时叠十个虚线框会让画布糊成一团，
   * 用户真正需要的信息是"会变成什么类型"与"数量"，两者都在标签里。
   */
  private drawDropPreview(): void {
    const overlay = this.overlayLayer;
    const preview = this.dropPreview;
    const first = preview?.items[0];
    if (!overlay || !preview || !first) return;

    // ★ 尺寸与 `cardsForDropPaths` 读同一张表：看到的框 = 落下的卡
    const { width, height } = DEFAULT_CARD_SIZES[first.kind];
    const zoom = this.viewport.zoom;
    const screen = this.viewport.toScreen(preview.center);
    overlay.drawDropGhost(
      {
        x: screen.x - (width * zoom) / 2,
        y: screen.y - (height * zoom) / 2,
        width: width * zoom,
        height: height * zoom,
      },
      this.dropPreviewLabel(preview.items),
    );
  }

  /** 预览标签：同类型说"会变成什么"，混合类型只说数量（列一长串名字会把提示撑到屏幕外） */
  private dropPreviewLabel(items: readonly DragPreviewItem[]): string {
    const first = items[0];
    if (!first) return '';
    if (!items.every((item) => item.kind === first.kind)) {
      return t('drop.hint.multiple', { count: items.length });
    }
    const hint = t(dropHintKey(first.kind));
    return items.length > 1 ? `${hint} ×${items.length}` : hint;
  }

  /** 外部拖入到分栏时的插入线（世界坐标 → 屏幕坐标），与 `drawInsertLine` 同一套画法 */
  private drawDropColumnLine(): void {
    const overlay = this.overlayLayer;
    const line = this.dropColumnLine;
    if (!overlay || !line) return;
    const left = this.viewport.toScreen({ x: line.x, y: line.y });
    const right = this.viewport.toScreen({ x: line.x + line.width, y: line.y });
    overlay.drawInsertLine({ x1: left.x, y1: left.y, x2: right.x, y2: right.y });
  }

  /**
   * 外部拖入落地（T1.63–T1.66）：把**已在库内**的路径变成卡片。
   *
   * 指针落在分栏里就整批收进去（插入线所指的那一行），否则在指针处错开落位。
   */
  private dropPathsAt(paths: readonly string[], clientX: number, clientY: number): void {
    const center = this.dropCenterOf(clientX, clientY);
    if (!center || paths.length === 0) return;
    const origins = cascadeOrigins(paths.length, center);
    // 两类对象两条落法：`.nestmind` 是**白板级脑图**（只有一个锚点），
    // 其余是有宽高的卡片 —— 两个函数各自认自己那一部分，互不干扰
    this.placeDropMinds(mindsForDropPaths(paths, origins));
    this.placeDropCards(cardsForDropPaths(paths, origins), center);
  }

  /**
   * 拖进来**一段文字**的落地（T6.11 / `F6-07`）。
   *
   * ★ 与"粘贴"刻意不同：画布上的 `⌘V` 遇到普通文本什么都不做（见 `onCanvasPaste`，
   *   那里的理由是"粘贴没有'把它放在哪'的意图"）。拖动**有** ——
   *   用户就是指着这个位置松的手，所以这里建卡不算"凭空造卡片"。
   */
  private dropTextAt(content: string, clientX: number, clientY: number): void {
    const center = this.dropCenterOf(clientX, clientY);
    if (!center) return;
    this.placeDropCards([noteCardForDropText(content, center)], center);
  }

  /** 指针位置（视口坐标）→ 世界坐标；画布还没量出尺寸时返回 `null` */
  private dropCenterOf(clientX: number, clientY: number): Point | null {
    const canvas = this.canvasEl;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return this.viewport.toWorld({ x: clientX - rect.left, y: clientY - rect.top });
  }

  /**
   * 「添加到白板」（T1.67）等**没有指针位置**的入口：落在视口中心。
   *
   * 返回值 = 是否真的落了卡（调用方据此决定要不要弹提示）。
   */
  async addFilesFromVault(paths: readonly string[], at?: Point): Promise<boolean> {
    const path = this.currentPath;
    if (!path || paths.length === 0) return false;
    // 视图可能刚被 `openBoardView` 唤起、板子还在读：这里等它就绪（已加载时同步返回）
    await this.plugin.repository.open(path);

    // 不指定落点时按**视口中心**（"拖进来 / 添加进来"一直的语义）；
    // `at` 是给"指定栏位"用的（`addFilesToUnsorted`，T5.07）
    const rect = this.canvasEl?.getBoundingClientRect();
    const center: Point =
      at ??
      (rect ? this.viewport.toWorld({ x: rect.width / 2, y: rect.height / 2 }) : { x: 0, y: 0 });
    return this.placeDroppedCards(paths, center);
  }

  /**
   * 把文件落到**收件箱分栏**（T5.07 / `F7-03`）。
   *
   * ★ 为什么这条逻辑在视图里而不是调用方：只有视图手上才有这块板的分栏几何
   *   （位置、尺寸、`commit` 之后重排过的结果）。调用方只该问一句"放进收件箱"，
   *   而不该自己算一个坐标塞进来 —— 那样两边的几何认知迟早会不一致。
   *
   * 板里没有收件箱那一栏时**退回视口中心**而不是失败：卡片放不进指定栏是小事，
   * 把用户刚选的文件整个丢掉是大事。
   */
  async addFilesToUnsorted(paths: readonly string[]): Promise<boolean> {
    const path = this.currentPath;
    if (!path || paths.length === 0) return false;
    await this.plugin.repository.open(path); // 先就绪，下面才读得到分栏
    const at = this.board ? unsortedDropPoint(this.board) : null;
    return this.addFilesFromVault(paths, at ?? undefined);
  }

  /** 路径 → 卡片 / 脑图 → 落地（`addFilesFromVault` 那条路没有指针位置，给它一个中心点） */
  private placeDroppedCards(paths: readonly string[], center: Point): boolean {
    if (paths.length === 0) return false;
    const origins = cascadeOrigins(paths.length, center);
    const placedMinds = this.placeDropMinds(mindsForDropPaths(paths, origins));
    const placedCards = this.placeDropCards(cardsForDropPaths(paths, origins), center);
    return placedMinds || placedCards;
  }

  /**
   * 脑图落地（`2.2.0`）：`.nestmind` 拖进来 = 白板上多出**一棵树**。
   *
   * ★ 与卡片那条路的三处不同，都是刻意的：
   *   ① **不进分栏** —— 栏是"一列卡片"的容器，一棵可向任意方向长的树塞进一栏没有意义；
   *   ② 不按类型问默认色 / 不做错开落位（一个落点就是一棵树，落点已经由调用方算好）；
   *   ③ 落完**不选中**（脑图这会儿还没有"容器级选区"，见 `12 §4.3`）—— 用户接着点节点就行。
   * ★ 模型不在文件里读：容器只记 `path`，渲染层读到之后自己画（`MindLayer`）。
   */
  private placeDropMinds(minds: readonly Mind[]): boolean {
    const board = this.board;
    if (!board || minds.length === 0 || this.isReadOnly()) return false;
    return this.commit(t('history.create'), (draft) => {
      for (const mind of minds) addMind(draft, mind);
      return true;
    });
  }

  /**
   * 落卡的核心：建卡 → （若指针在栏内）收进分栏 → 落盘 → 选中新卡。
   *
   * ★ 收的是**卡片本身**而不是路径：路径是"从外面来"的那一种建卡材料
   *   （还要先经过 `cardsForDropPaths` 认扩展名），而拖进来的一段文字（T6.11）
   *   压根没有路径可谈。两条来路的材料不同、落地该干的事一样，分界就画在这里。
   */
  private placeDropCards(cards: readonly Card[], center: Point): boolean {
    const board = this.board;
    if (!board || cards.length === 0 || this.isReadOnly()) return false;

    // 拖进来的卡与"双击新建"共用同一个默认色（T3.24）：同一条手势路径若两处取值不同，
    // 用户会看到"拖进来的卡是白的、双击建的是黄的"这种说不通的现象。
    // ★ 但"默认色"要**按类型问**（`newCardColor(type)`）：图片卡的默认是纯黑"相框"，
    //   而拖入正是图片最常见的进板方式 —— 不在这条路上认它，图片卡就永远拿不到那个黑框。
    // ★ 只覆盖**刚由拖入生成**的卡片（贴进来的、从文件里读出来的都不经过这里）⇒ 不会动已有的颜色。
    const colored = cards.map((card) => ({ ...card, color: this.newCardColor(card.type) }) as Card);
    const ids = colored.map((card) => card.id);
    const target = findDropTarget(board, center, undefined, (columnId) =>
      this.columnScrollOffsetOf(columnId),
    );

    const changed = this.commit(t('history.create'), (draft) => {
      // ★ 落的是 `colored`（按类型问过默认色的那一批），不是原始 `cards`：
      //   之前这里写的是 `cards`，于是上面那段"按类型取默认色"白算了 —— 图片卡拿不到
      //   纯黑相框、白板卡拿不到它自己的默认主色（拖进来的子白板入口会变成全局默认色）。
      if (!addCards(draft, colored)) return false;
      // 收进分栏：插到插入线指示的位置；`commit` 之后会统一重排整栏几何（见 `commit`）
      if (target) insertCardsIntoColumn(draft, ids, target.columnId, target.index);
      return true;
    });

    // 选中新卡：用户接着多半要拖 / 要编辑刚放进来这批
    if (changed) {
      this.selection.set({ cards: ids });
      // ★ 收进了某个栏 → 顺手滚到能看见它们：栏高封顶（T2.03）之后，
      //   往一个满栏里放东西在屏幕上是"没有变化"的，用户会以为没放进去
      if (target) this.revealCardInColumn(target.columnId, ids);
    }
    return changed;
  }

  // ── 拖出导出（T6.10 / `F6-04`） ──────────────────────────
  //
  // 三个阶段各占一个方法：**找落点**（DOM）→ **点亮它**（DOM）→ **写文件**（Vault）。
  // 三者都不属于画布 —— 指针早已拖出画布，判据全在侧栏的文件浏览器上。

  /**
   * 指针底下那个元素的库内路径。
   *
   * ★ 只认文件浏览器里的条目（`.nav-file-title` / `.nav-folder-title` 才自带 `data-path`），
   *   不认别处带这个属性的元素 —— 拖到标签页、搜索面板上不该被当成落点。
   * ★ 用 `closest` 往上找：指针十有八九落在标题里的图标或文字节点上，
   *   那些节点自己并没有 `data-path`。
   */
  private dropOutPathAt(clientX: number, clientY: number): string | null {
    const element = document.elementFromPoint(clientX, clientY);
    const row = element?.closest<HTMLElement>(
      '.nav-file-title[data-path], .nav-folder-title[data-path]',
    );
    return row?.dataset.path ?? null;
  }

  /**
   * 点亮落点文件夹。
   *
   * ★ 只点亮**文件夹行**（哪怕指针停在该文件夹里面的某个文件上）：用户要确认的是
   *   "会导出到哪儿"，该亮的就是那个文件夹。
   * ★ 两份侧栏可能都开着文件浏览器 → 全都点上。指针底下那个自然在视线里，
   *   而"另一边也亮着"不算错 —— 它们说的是同一个落点。
   */
  private highlightDropOutTarget(folder: string | null): void {
    for (const row of this.dragOutHighlight.splice(0)) row.removeClass(DROP_OUT_HIGHLIGHT_CLASS);
    if (!folder) return;
    for (const row of document.querySelectorAll<HTMLElement>(
      `.nav-folder-title[data-path="${CSS.escape(folder)}"]`,
    )) {
      row.addClass(DROP_OUT_HIGHLIGHT_CLASS);
      this.dragOutHighlight.push(row);
    }
  }

  /**
   * 把这几张卡写成 `.md`（T6.10）。
   *
   * ★ 走 `promoter.writeBacked`：它与"提升为笔记"是同一个动作，于是命名规则
   *   （空标题退回正文首行）、**重名顺延**全都免费继承 —— 而"绝不覆盖"正是这里
   *   最要紧的一条：导出的笔记是要拿去继续写的，拖第二次若按导出语义覆盖，
   *   用户在上面写的东西就没了。代价是"拖两次得到两份"，这比丢编辑轻得多。
   * ★ 一张都没内容（全是空卡 / 只有矢量笔迹）时不写空文件，直接明说 ——
   *   写出一堆空笔记，用户得到的结论是"导出坏了"。
   * ★ 串行写：一次拖十几张时并发落盘会在内存上顶出一个尖峰，而且串行才能让
   *   "导出了几篇"这个数字与实际写成功的数量一致。
   */
  private async exportCardsToNotes(cardIds: readonly string[], folder: string): Promise<void> {
    const board = this.board;
    const path = this.currentPath;
    const promoter = this.promoter;
    if (!board || !path || !promoter) return;

    const notes: { title: string; markdown: string }[] = [];
    for (const id of cardIds) {
      const card = board.cards.find((item) => item.id === id);
      if (!card) continue;
      const markdown = noteMarkdownOf(this.cardRegistry.toMarkdown(card, { sourcePath: path }));
      if (markdown === null) continue;
      notes.push({ title: card.title, markdown });
    }

    if (notes.length === 0) {
      new Notice(t('notice.dragOutEmpty'));
      return;
    }

    try {
      for (const note of notes) await promoter.writeBacked(note.title, note.markdown, folder);
    } catch (error) {
      console.warn('[nestboard] 拖出导出失败', describeError(error));
      new Notice(t('notice.dragOutFailed', { error: describeError(error) }));
      return;
    }

    // 根目录在界面上显示成 `/`，与面包屑同一套写法（空串是模型里的表示）
    new Notice(t('notice.dragOutExported', { count: String(notes.length), folder: folder || '/' }));
  }

  // ── 剪贴板（T1.49 / `F2-3-2`） ──────────────────────────

  /**
   * 画布上的 `⌘V`。
   *
   * 两种素材走两条分支，但**终点是同一个落卡入口**：
   *
   * 1. 剪贴板里有图片 → 先落库（`AttachmentManager.savePastedImage`）再建图片卡。
   *    ★ 图片不能像 URL 那样"只存个链接"：剪贴板数据随进程消失，
   *      不落库的话用户重启 Obsidian 就只剩一张挂掉的卡。
   * 2. 没有图片但有文本 → 交给 `resolveDropText`（与拖入同一套判定）；
   *    文本里是库内路径就建卡（从文件浏览器"复制 → 粘贴"的常见路径），
   *    否则**什么都不做** —— 普通文本粘贴到画布上没有合理语义，不能凭空造卡片。
   */
  private async onCanvasPaste(event: ClipboardEvent): Promise<void> {
    // ★ 编辑态直接放行：那里的 `⌘V` 是"粘贴文字"，抢过来建卡是灾难
    if (this.isEditingCard || this.isReadOnly() || !this.board) return;
    // ★ 演示态一律不落卡（J-06 的硬约束）：粘贴与拖入一样是"改白板"，而演示态关掉的
    //   正是所有编辑入口（指针 / 画布按键 / 命令面板）。中间那些入口都各自挡着，
    //   这一条是**按内容**进来的，不挡就会在讲课时凭空多出几张卡。
    if (this.presentation?.active) return;

    const clipboard = event.clipboardData;
    if (!clipboard) return;

    // ★ 节点剪贴板（`2.2.0` 收尾 · 用户 2026-09-23）：白板上**别的落点对它无效** ——
    //   它只认"指针下正好是一个脑图节点"（粘成那个节点的子级），没有目标就只说一句话。
    //   从前这一份是塞进卡片载荷的"合成容器"，于是粘到空白处会长出一棵棵新树。
    const nodePayload = nodeClipboardOf(
      clipboard.getData('text/html'),
      clipboard.getData('text/plain'),
    );
    if (nodePayload) {
      event.preventDefault();
      this.pasteMindNodes(nodePayload);
      return;
    }

    // ★ 卡片搬运（T4.15 / `F7-07`）**第一个判**：那是我们自己写进剪贴板的一段文本，
    //   认出来就直接落卡。不先判的话它会掉进下面的 `resolveDropText` —— 那段 JSON
    //   不是任何库内路径，会被当成"普通文本"丢掉：用户复制完切到另一块板子按 `⌘V`
    //   **毫无反应**，而且完全看不出为什么。
    const transferText = clipboard.getData('text/plain');
    const transfer = transferText.length > 0 ? parseCardTransfer(transferText) : null;
    if (transfer) {
      event.preventDefault();
      this.pasteCards(transfer);
      return;
    }

    const image = firstClipboardImage(clipboard);
    if (!image) {
      const text = clipboard.getData('text/plain');
      // ★ URL 要**先**判（T2.04 / `F2-4-1`）：`https://…` 不是任何库内路径，掉到
      //   `resolveDropText` 里会被当成"普通文本"丢掉 —— 于是"复制网址 → 粘到白板"
      //   这个最自然的动作会**毫无反应**，而用户完全看不出为什么
      const url = normalizeUrl(text);
      if (url !== null) {
        event.preventDefault();
        this.createLinkCardAt(url, this.pasteAnchor());
        return;
      }
      const items = resolveDropText(text, (path) => this.resolveVaultPath(path));
      if (items.length === 0) return;
      event.preventDefault();
      this.placeDroppedCards(
        items.map((item) => item.path),
        this.pasteAnchor(),
      );
      return;
    }

    // 先拦下事件：导入要走 IPC / 异步 IO，等 `await` 回来事件早被别处消费了
    event.preventDefault();
    try {
      const path = await this.plugin.attachments.savePastedImage(
        await image.arrayBuffer(),
        image.type,
        // 命名规则跟着设置走（F11-06 / T1.74），与拖入共用同一份
        this.plugin.attachmentOptions,
      );
      // `await` 期间用户可能切走 / 板子被改成只读：重新验一次再写
      if (this.isReadOnly()) return;
      this.placeDroppedCards([path], this.pasteAnchor());
      new Notice(t('notice.pastedImage', { path }));
    } catch (error) {
      new Notice(t('notice.attachmentFailed', { error: describeError(error) }));
    }
  }

  /**
   * 粘贴/新建的落点（世界坐标）：优先最后一次指针位置，拿不到（纯键盘触发）就落视口中心。
   * 与 `newNoteAtCursor` 同一条准则 —— 宁可落在中心，也别落在看不见的地方。
   */
  private pasteAnchor(): Point {
    const rect = this.canvasEl?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    const client = this.lastPointerClient;
    const screen = client
      ? { x: client.x - rect.left, y: client.y - rect.top }
      : { x: rect.width / 2, y: rect.height / 2 };
    return this.viewport.toWorld(screen);
  }

  // ── 卡片增删改：内部实现（T1.34–T1.48） ─────────────────

  /**
   * 变更 + 记历史。**所有会改白板内容的动作都必须走这里**（T1.48）。
   *
   * 三个关键点：
   *  * 快照在 `mutate` **之前**取 —— 之后 `board` 已经被就地改过了；
   *  * `applyingHistory` 期间不记 —— 否则"撤销"本身会成为新的一步（见字段注释）；
   *  * `mutate` 返回 `false` 时不记 —— 提前返回能省下一整份序列化，
   *    大板子上一份快照可能是几百 KB，而"点进点出"这种无变化操作非常频繁。
   */
  private commit(label: string, mutate: (board: BoardFile) => boolean, mergeKey?: string): boolean {
    const path = this.currentPath;
    if (!path || this.isReadOnly()) return false;
    const board = this.plugin.repository.get(path);
    if (!board) return false;

    const recording = !this.applyingHistory;
    const before = recording ? serializeContent(board) : null;
    // ★ 分栏的"归属 → 几何"是**派生**的（成员卡片的 x/y/宽高由栏算出来），
    //   所以任何改动落地之后都必须重排一次。放在 `commit` 这个唯一咽喉点上，
    //   就不必让"收进分栏 / 拖出 / 删栏 / 改栏尺寸"每个调用方各自记得重排 ——
    //   漏掉任何一处都会表现为"卡片进了栏，但还画在原地"。
    // ★ "内容变少时要收下来"（O05）的基准也在这里量：`shrinkColumnToFit` 要的是
    //   **改动之前**的内容总高，改完就只剩"现在的样子"了。量它只花一趟遍历，
    //   而漏量的代价是"收起一个编组之后栏里永远空着一截"——这种账不划算。
    const previousContent = new Map<string, number>();
    for (const column of board.columns) {
      previousContent.set(column.id, columnContentHeight(board, column));
    }
    const changed = this.plugin.repository.mutate(path, (draft) => {
      const did = mutate(draft);
      // ★ **空栏不再自动收壳**（用户 2026-09-16："即使分栏最后一张卡被移出，分栏依然应该存在"）。
      //   从前的 `O04` 是"空栏不留空壳"：一次改动把某一栏的成员全带走时连栏一起收掉。
      //   但"把最后一张卡拖出去"之后栏凭空消失，用户还得重新建一栏、重新摆位置 ——
      //   空栏本身也是他摆好的结构（导出、打印、缩略图三处都一直把它算进内容边界）。
      //   ⇒ 现在只有**显式**的删除（栏菜单 / Delete 键 / 整栏转分组）才会让栏消失。
      if (did && draft.columns.length > 0) {
        // 顺序不能反：先按 `order` 重排成员位置，再按新的内容总高撑高。
        // 反过来的话，撑高用的是"重排之前"的高度，最后一根卡片会被顶出栏外。
        relayoutColumns(draft);
        for (const column of draft.columns) {
          // 卡片长高（自动高度 / 手动缩放）不能把栏撑破：栏跟着内容长高。
          // `growColumnToFit` 只增不减，所以"用户把栏拖矮了"不会在每次提交时被弹回去，
          // 只在内容确实放不下时才长。
          growColumnToFit(draft, column.id);
          // 反过来那一半：内容变少（收起编组 / 拖出卡片 / 删卡）时把栏收下来。
          // ★ 必须**先 grow 再 shrink**：grow 负责 `height < content`，shrink 负责
          //   `height > content`，都以内容高度为基准；顺序反了的话，一根"比内容还矮"
          //   的栏会先被 shrink 的 `max(..., content)` 拉高，语义就混了。
          const previous = previousContent.get(column.id);
          if (previous !== undefined) shrinkColumnToFit(draft, column.id, previous);
        }
      }
      return did;
    });
    if (!changed || before === null) return changed;

    this.history.submit({ label, before, after: serializeContent(board), mergeKey });
    return true;
  }

  /** 批量改卡片的非几何字段（标题 / 显隐 / 配色 / 锁定），走 `commit` 记历史 */
  private patchSelection(label: string, patch: CardPatch): void {
    const ids = [...this.selection.cardIds];
    if (ids.length === 0) return;
    this.commit(label, (board) => updateCards(board, ids, patch));
  }

  // ── 连线（T1.68–T1.71，F3-01–F3-09） ────────────────────

  /**
   * 拖动预览（T1.70）：卡片层写 DOM，连线层读**同一份**临时几何。
   *
   * ★ 三件事（卡片几何 / 连线 / 参考线）必须由同一次 `preview` 回调驱动：
   *   拆成两个回调的话，总会有那么一帧是"卡片已经吸过去了、线或参考线还停在旧位置"。
   */
  private previewCardRects(rects: readonly CardRect[], guides: SmartGuides): void {
    // ① 模型侧那份临时几何**同步**更新：命中测试与落点判定读的就是它，
    //    晚一帧会把"松手时插进哪个分栏"判错（功能性错误，不只是观感）
    if (rects.length === 0) {
      this.dragPreviewRects = null;
      this.dragGuides = null;
    } else {
      const map = new Map<string, Rect>();
      for (const rect of rects) {
        map.set(rect.id, { x: rect.x, y: rect.y, width: rect.width, height: rect.height });
      }
      this.dragPreviewRects = map;
      // 参考线也**同步**记下：它要跟着上面的几何一起落进下一帧的覆盖层重画
      this.dragGuides =
        guides.verticals.length > 0 || guides.horizontals.length > 0 ? guides : null;
    }

    // ② 真正动 DOM / 重画连线 / 画参考线的部分延到帧（T2.14）：一帧内多个 pointermove
    //    只落地一次，而落地时用的是最新几何，中间态不会画出来
    this.pendingDragPreview = rects;
    this.frameQueue.schedule(this.commitDragPreview);
  }

  /**
   * 拖动预览提交（帧任务）：写卡片 DOM + 重画连线 + 重画参考线。
   *
   * ★ 三者必须在同一次提交里：拆开就会出现"卡片已经动了、线还拴在旧锚点"的一帧
   *   ——也就是用户看到的"连线在抖"（与 `preview` 回调合并成一次是同一条理由）。
   */
  private readonly commitDragPreview = (): void => {
    const rects = this.pendingDragPreview;
    this.pendingDragPreview = null;
    // 拖动已经结束（松手 / Esc 取消）：不再补画，否则会在模型已经落位之后
    // 又把卡片画回"拖动中的位置"，看起来是松手后卡片跳一下
    if (!rects) return;
    this.appliedDragPreview = rects;
    this.cardLayer?.previewRects(rects);
    // ★ 目标高亮（`B2`，用户 2026-09-18）：手里这批压在哪张白板卡上，就把那张标出来 ——
    //   没有这一步，"拖上去松手会搬进那块板"这件事在松手前完全看不见。
    //   判据与落卡时**同一个函数**（`dropIntoBoardPath`）⇒ 亮的那张与真正会收到的那张
    //   永远是同一张（两处各判一次的话，迟早出现"亮的是一张、搬进的是另一张"）。
    this.syncDropIntoHighlight(rects);
    // 编组框跟着手走（O03）：拖动期间模型一动没动，框只能从**视觉几何**重算 ——
    // 而这条"只写 DOM"的帧任务不经过 `syncCanvas()`，不在这里补一次，
    // 框会一直停在卡片**出发**的地方，直到松手才跳过去
    this.syncGroupLayer();
    this.edgeLayer?.invalidate();
    this.redrawDragOverlay();
  };

  /**
   * 把"松手会搬进哪张白板卡"这件事画在卡片上（`B2`）。
   *
   * ★ 只改一个类名（`is-drop-into`），样式表画一圈环 —— 不动几何、不重排，
   *   所以它能放在每帧都会跑的那条预览路径上。
   * ★ 高亮的那张与落卡时真正收到的那张**用的是同一个判据**（见 `commitDragPreview`）。
   * ★ 卡片 DOM 用 `data-card-id` 找（`HitTest` 那条 DOM 委托用的同一个属性名）——
   *   不必给卡片层再加一个"谁是落点"的状态。
   */
  private syncDropIntoHighlight(rects: readonly CardRect[] | null): void {
    // 传 `null` = 拖动结束了，把环收掉（复用同一条路，免得"收"与"亮"各写一遍）
    const path = rects === null ? null : this.dropIntoBoardPath(rects);
    const board = this.board;
    const next =
      path === null || !board
        ? null
        : (board.cards.find((card) => card.type === 'boardRef' && card.content.path === path)?.id ??
          null);

    if (this.highlightedDropBoardId !== next) {
      if (this.highlightedDropBoardId !== null) {
        this.cardElementOf(this.highlightedDropBoardId)?.classList.remove('is-drop-into');
      }
      if (next !== null) this.cardElementOf(next)?.classList.add('is-drop-into');
      this.highlightedDropBoardId = next;
    }

    // 被拖的这批卡变半透明（用户 2026-09-18："一旦进入触发区域，卡片会变半透明……
    // 移开触发区域，卡片恢复原先透明度"）：说的是"这些卡马上要进去了"，
    // 与目标那张的环一起构成一组完整的反馈。
    // ★ 先清上一帧标过的、再标这一帧的：查 DOM（`.is-drop-fading`）而不是另存一份 id ——
    //   拖动中途卡片可能被回收 / 重挂，存下来的 id 会指向已经不存在的节点。
    // ★ `rects === null`（拖动结束）时只清不标 ⇒ 松手 / Esc 都会恢复透明度。
    for (const fading of this.contentEl.querySelectorAll('.is-drop-fading')) {
      fading.classList.remove('is-drop-fading');
    }
    if (next !== null && rects !== null) {
      for (const rect of rects) this.cardElementOf(rect.id)?.classList.add('is-drop-fading');
    }
  }

  /** 一张卡的 DOM 外壳（`CardLayer` 写的是 `data-card-id`） */
  private cardElementOf(cardId: string): HTMLElement | null {
    return this.contentEl.querySelector<HTMLElement>(`[${CARD_ID_ATTR}="${cardId}"]`);
  }

  /**
   * 旋转预览（T7.06 / `F2-00-10`）：写 DOM 上的 `transform` + 记下临时角度。
   *
   * ★ 与 `previewCardRects` 的两段式**不一样**，这里同步做完：
   *   旋转不改几何，只有"卡片自己的样子"与"连线的锚点"要跟着走 ——
   *   前者一次 `style.transform`（不重排、不动别的卡片），
   *   后者本来就是帧节流的（`edgeLayer.invalidate()` 只打脏标记）。
   *   再套一层帧队列只会让"手柄拖到哪、卡片转到哪"慢一帧（手感发粘）。
   * ★ `dragRotation` 是同步更新的：连线层下一帧重画时读的就是它。
   */
  private previewCardRotation(cardId: string, degrees: number): void {
    this.dragRotation = new Map([[cardId, degrees]]);
    this.cardLayer?.previewRotation(cardId, degrees);
    this.edgeLayer?.invalidate();
  }

  /**
   * 提交旋转（T7.06 / `F2-00-10`）。
   *
   * ★ 单独一条提交路径，不并进 `commitDrag`：那个函数管的是**几何**，还挂着一串
   *   "这一拖是不是 Alt 复制 / 是不是拖出了导出 / 该不该退出分栏"的副作用 ——
   *   转个身与这些毫不相干，并进去就得在每一处副作用前加一遍"这次是不是旋转"的判断。
   * ★ 返回 `false`（角度原样不变）时控制器会 `resync()`：把 DOM 上那份预览撤掉，
   *   让屏幕回到模型的样子。
   */
  private commitRotation(cardId: string, degrees: number): boolean {
    return this.commit(t('history.rotate'), (board) =>
      applyCardRotations(board, [{ id: cardId, degrees }]),
    );
  }

  /**
   * 把卡片转回正（T7.06）：卡片菜单里那一项。
   *
   * ★ 走 `commit`（一次 `mutate`）而不是直接改模型：与拖动、缩放一样要能 `⌘Z`。
   * ★ 已经正着的卡片调它返回 `false`，`commit` 会识别成"没变化"（不进历史栈）——
   *   菜单项本身也只在对着一张转过的卡时才出现（见 `cardMenu` 的规格层）。
   */
  private resetRotation(cardId: string): void {
    this.commit(t('history.rotate'), (board) =>
      applyCardRotations(board, [{ id: cardId, degrees: 0 }]),
    );
  }

  /**
   * 重画拖动期间挂在覆盖层上的提示：分栏插入线 + 智能参考线（T3.12）。
   *
   * ★ 每次**整层重画**（`beginFrame`）而不是"擦掉旧的再补新的"：参考线每帧都可能换位置
   *   （从对齐 A 卡跳到对齐 B 卡），只补画不清理会在画布上留下一串旧线。
   * ★ 由 `commitDragPreview` 调用（帧节流），拖动中一帧内多次 pointermove 只重画一次。
   */
  private redrawDragOverlay(): void {
    const overlay = this.overlayLayer;
    if (!overlay) return;
    overlay.beginFrame();
    this.drawInsertLine();
    this.drawSmartGuides();
  }

  /**
   * 智能参考线（T3.12 / `F5-03`）：世界坐标 → 屏幕坐标后画成贯穿视口的长线。
   *
   * ★ 屏幕坐标**现算**而不是缓存：相机一变 `syncCanvas` 会把覆盖层清空并重画，
   *   缓存的旧屏幕坐标在缩放 / 平移后必然错位。
   */
  private drawSmartGuides(): void {
    const overlay = this.overlayLayer;
    const guides = this.dragGuides;
    if (!overlay || !guides) return;
    const verticals = guides.verticals.map((x) => this.viewport.toScreen({ x, y: 0 }).x);
    const horizontals = guides.horizontals.map((y) => this.viewport.toScreen({ x: 0, y }).y);
    overlay.drawGuides(verticals, horizontals);
  }

  /**
   * 相机变化后补画拖动预览（T2.14）。
   *
   * ★ 为什么必须有：`cardLayer.sync` 是按**模型**几何重排的，而拖动期间卡片层写的是
   *   另一份临时几何。用户"一边拖一边滚轮缩放"时，这一帧会把手上那张卡弹回原位、
   *   下一帧再被预览拉回来 —— 看起来就是卡片在抖。合并到帧之后，"相机提交"与
   *   "预览提交"谁先谁后取决于事件顺序，所以这层兜底不再是可选项。
   */
  private reapplyDragPreview(): void {
    if (!this.appliedDragPreview) return;
    // ★ 只在拖动**仍在进行**时补画。`DragController.finish()` / `cancel()` 都是
    //   "先清会话、再提交模型"，而提交会走 `syncCanvas` —— 不校验就会把已经作废的
    //   预览又贴回 DOM。Alt 复制时最明显：原卡会停在被拖到的位置，而不是留在原地。
    if (!this.dragController?.isActive) return;
    this.cardLayer?.previewRects(this.appliedDragPreview);
  }

  /**
   * 端点 id → 当前几何（卡片与分栏共用一张表，`O21`）。
   *
   * 拖动中的对象以**临时几何**为准 —— 命中测试必须打在用户看到的那条线上，
   * 否则拖动中点击连线会「点得中看不见的、点不中看得见的」。
   *
   * ★ 屏幕上不存在的卡片（收起编组的成员 O03、收起分栏的成员 `O16`）**不进这张表**：
   *   `edgePolyline` 在端点取不到矩形时返回 `null`，于是"连着被藏起来的卡的那些线"
   *   既不画、也点不中、框选也框不到 —— 一条悬在空气里指向虚空的线更让人困惑。
   *   （分栏本身没有"被藏起来"这回事：它收起时只是变矮，仍然看得见、也仍然能连。）
   * ★ **分栏也进这张表**（`O21`）：从栏上拉出的线、以及画到栏上的线，走的都是查询
   *   这一个函数。栏取 `columnRect`（折叠态用**显示高度**，与命中测试同一份几何）。
   *   漏掉的话，那些线在 `edgeEndpoints` 里取不到矩形 → **整条线一个字都不画**，
   *   而数据里明明有 —— "画布上没有、文件里有"是最难自查的一种坏。
   * ★ 关掉 `data-column-id` 这条路就等于关掉整个 `O21`：这张表是四条路径（绘制、
   *   命中、锚点、导出）里唯一给分栏补几何的地方。
   */
  private cardRectLookup(): RectLookup {
    const board = this.board;
    if (!board) return () => null;
    const hidden = this.hiddenCardIds(board);
    const rects = new Map<string, Rect>();
    for (const card of board.cards) {
      if (hidden.has(card.id)) continue;
      // ★ 高度走 `cardDisplayHeight`（`O31` 修复）：与**绘制**（`EdgeRenderer`）同一口径 ——
      //   收起时命中 / 锚点 / 智能路由障碍表全都要按"只有标题行那么高"算
      rects.set(card.id, {
        x: card.x,
        y: card.y,
        width: card.width,
        height: cardDisplayHeight(card),
      });
    }
    for (const column of board.columns) rects.set(column.id, columnRect(column));
    // 脑图节点（`2.2.0` 批 3）：键是 `脑图id/节点id`，几何由渲染层实测给出
    //（`MindLayer.nodeRects`）—— 与绘制侧那份**同源**，所以"画在节点上的线"
    // 也**点得中**（命中 / 框选 / 弧度手柄全走这一张表）
    for (const [key, rect] of this.mindLayer?.nodeRects() ?? []) rects.set(key, rect);
    // 视觉补丁（栏内滚动 + 拖动预览）要**盖住**模型值：命中的是屏幕上那条线
    const override = this.visualOverrides();
    if (override) {
      for (const [id, rect] of override) rects.set(id, rect);
    }
    return (endpointKey) => rects.get(endpointKey) ?? null;
  }

  /**
   * 连线命中 / 框选要用的几何选项（T7.06 / T7.11）。
   *
   * ★ 必须与**绘制时**喂进去的是同一份，否则"看到绕开了、点下去选中的是直线"：
   *   * `angleOf` —— 转过的卡片上锚点在别处（T7.06）；
   *   * `obstacles` —— Smart 路由要绕开的卡片矩形（T7.11），取视觉几何，
   *     与 `EdgeRenderer` 从同一张 `cardRectLookup` 里建的那份同源。
   * ★ 障碍表只在这块板**真的有 smart 线**时才建：一张全是 free 线的板子上
   *   每次点空白都要遍历一遍全部卡片，纯属白花钱。
   */
  private edgeHitOptions(): EdgeHitOptions {
    const board = this.board;
    if (!board) return {};
    const angleOf = (cardId: string) => this.angleOfCard(cardId);
    if (!board.edges.some((edge) => edge.routing === 'smart')) return { angleOf };
    const lookup = this.cardRectLookup();
    const obstacles: Rect[] = [];
    for (const card of board.cards) {
      const rect = lookup(card.id);
      if (rect) obstacles.push(rect);
    }
    return { angleOf, obstacles };
  }

  /** 屏幕坐标 → 命中的连线（T1.71 / `F3-07`）。容差按缩放反算（见常量注释） */
  private hitEdgeAt(screen: Point): string | null {
    const board = this.board;
    if (!board || board.edges.length === 0) return null;
    const world = this.viewport.toWorld(screen);
    const zoom = this.viewport.zoom || 1;
    return (
      hitTestEdge(
        board.edges,
        this.cardRectLookup(),
        world,
        EDGE_HIT_TOLERANCE_PX / zoom,
        this.edgeHitOptions(),
      )?.id ?? null
    );
  }

  /** 与矩形相交的连线 id（框选选中连线，T1.71） */
  private edgesIn(worldRect: Rect): string[] {
    const board = this.board;
    if (!board || board.edges.length === 0) return [];
    return edgesIntersecting(
      board.edges,
      this.cardRectLookup(),
      worldRect,
      this.edgeHitOptions(),
    ).map((edge) => edge.id);
  }

  /**
   * 建一条连线（T1.68 / T2.07）。
   *
   * 起点用**用户按下的那个锚点**（`fromSide`）—— 那是一个明确的表达；
   * 终点留 `null` 走自动选边 —— "从哪面进"用户通常没想，交给自动判定之后，
   * 卡片挪到另一侧时线会自动翻面，不必回来重连。
   *
   * 终点落在空白处时是**自由端**（`F3-02`）：`cardId` 写空串、坐标记进 `point`。
   * 自由端是"钉在画布上"的，卡片移动它不动 —— 这正是"指向某处"该有的行为。
   *
   * ★ 两端都可以是**分栏**（`O21`）：这里一行都不用改 —— 端点身份就是那个
   *   `cardId`（卡片 id 或分栏 id，共用同一套 id 空间），而"能不能连"的判定
   *   统一在 `model/edges.addEdges` 那一处（这一层不做第二遍校验）。
   */
  /**
   * 此刻能不能拖端点（`2.2.0` · O1）：**恰好选中一条线**、可写、非演示。
   *
   * ★ 与 `EdgeCurveController.activeCurveEdge()` 分开命名（那边还要求是自由走线）：
   *   端点重拖对**所有**线都有意义 —— 恰恰是"拖到空地上的自由端线"最需要它。
   */
  private activeEdgeForEndpointDrag(): { id: string; from: EdgeEndpoint; to: EdgeEndpoint } | null {
    const board = this.board;
    if (!board || this.isReadOnly() || this.presentation?.active) return null;
    if (this.selection.edgeIds.size !== 1) return null;
    const [id] = this.selection.edgeIds;
    const edge = board.edges.find((item) => item.id === id);
    return edge ? { id: edge.id, from: edge.from, to: edge.to } : null;
  }

  /**
   * 端点重拖落地（`2.2.0` · O1）：把某条线的一端改成新的落点。
   *
   * ★ 目标端点由**键**翻成 `EdgeEndpoint`（`endpointOfKey`；节点的键是 `脑图id/节点id`），
   *   与 `connectCards` 同一套 —— 两条路各写一份翻法迟早分叉。
   * ★ 一律 `side: null`（自动选边），与"拉新线时终点那一端"同一条。
   */
  private reconnectEdge(
    edgeId: string,
    end: 'from' | 'to',
    to: { key: string } | { key: null; point: Point },
  ): void {
    if (to.key === null) {
      const point = to.point;
      this.commit(t('history.connect'), (board) =>
        setEdgeEndpoint(board, edgeId, end, { key: null, point }),
      );
      return;
    }
    const { cardId, nodeId } = splitEndpointKey(to.key);
    this.commit(t('history.connect'), (board) =>
      setEdgeEndpoint(board, edgeId, end, {
        key: cardId,
        side: null,
        ...(nodeId === null ? {} : { nodeId }),
      }),
    );
  }

  private connectCards(
    fromKey: string,
    fromSide: AnchorSide,
    to: { key: string } | { key: null; point: Point },
  ): void {
    // ★ 两端都由**端点键**翻成 `EdgeEndpoint`（`endpointOfKey`，`2.2.0` 批 3）：
    //   卡片 / 分栏 / 整棵脑图是它们自己的 id，脑图节点是 `脑图id/节点id` ——
    //   翻法是纯字符串，控制器那边因此始终不必知道"节点"是什么。
    // ★ 起点用用户按下的那一面，终点一律"自动选边"（`side: null`）：从哪面进用户
    //   通常没想，交给自动判定之后节点挪到另一侧时线会自己翻面。
    const edge = createEdge(
      endpointOfKey(fromKey, fromSide),
      to.key === null ? { cardId: '', side: null, point: to.point } : endpointOfKey(to.key, null),
    );
    this.commit(t('history.connect'), (board) => addEdges(board, [edge]));
  }

  /**
   * 改名（T1.40）。由卡片层的就地标题输入框在提交时调用。
   *
   * 不进 `patchSelection`：那一个作用于**选区**，而标题编辑的目标永远是
   * "正在被编辑的那一张" —— 用户完全可能没选中它就把标题改完了。
   *
   * ★ `O30`：**文件卡指向 `.md` 时**，标题同时是文件名 —— 改标题就把真实文件也改名
   *   （路径由 `RenameWatcher` 跟随，卡片不会断链）。
   */
  private setCardTitle(cardId: string, title: string): void {
    const card = this.board?.cards.find((item) => item.id === cardId);
    // `O30` 文件卡（`.md`）/ `O37` 白板卡（`.nboard`）：卡片上的标题**就是文件名** ——
    // 改标题顺带把真实文件也改名（路径由 `RenameWatcher` 跟随，卡片不会断链）。
    // ★ 判据问**类型自己**（`CardTypeDefinition.titleFilePath`）："哪种卡的标题管着文件名"
    //   是那个类型的事，视图只负责执行 —— 名单写在这里，每加一种文件型的卡都要回来改它。
    if (card && this.cardRegistry.titleFilePath(card) !== null) {
      void this.renameCardFileWithTitle(card, title);
      return;
    }
    this.commit(t('history.title'), (board) => updateCards(board, [cardId], { title }));
  }

  /**
   * 「编辑标题」（T1.40）。由右键菜单那一项调用。
   *
   * ★ `O37`：文件卡（`.md`）/ 白板卡（`.nboard`）的标题**就是文件名**，所以输入框要
   *   **预填当前主名**（去掉扩展名）—— 不预填的话，用户点开看到的是一个空框，
   *   而卡片上明明写着名字；按一下 `Enter` 什么都不会发生，像是"编辑标题坏了"。
   *   预填的正是"改名时该打进去的那半截"（`renameCardFileWithTitle` 会把扩展名拼回去）。
   * ★ 白板卡的迷你形态与展开形态共用这一条路：卡面上的名字都取自 `content.path`，
   *   文件一改名，两处一起跟着变。
   * ★ `F5`：便签 / 同步便签的标题**也走这一条**（它们没有文件，改的就是 `card.title`），
   *   入口除了右键菜单还有"双击卡面标题行"（见 `editTitleFromTitleBand`）。
   *
   * @returns 是否真的把输入框开出来了（未挂载 / 锁定 / 已经在编辑标题 ⇒ `false`）。
   *          调用方据此决定要不要退回别的动作（双击那条路会退回内容编辑）。
   */
  private editCardTitle(cardId: string): boolean {
    const card = this.board?.cards.find((item) => item.id === cardId);
    if (!card) return false;
    const path = this.cardRegistry.titleFilePath(card);
    return (
      this.cardLayer?.editTitle(cardId, {
        initial: path === null ? card.title : splitName(path).base,
      }) ?? false
    );
  }

  /**
   * `O30` / `O37`：标题管着文件名的卡片改标题 → 把 Vault 里那个文件也改名。
   *
   * 顺序刻意是"**先写标题、再改名**"：改名失败（同名已存在 / 文件不在）时卡片上的名字
   * 仍然改了 —— 用户看到的是"名字变了、文件没动"，而不是"点了半天什么都没发生"。
   * ★ 空标题**绝不动文件**：那会变成"把一块板 / 一篇笔记改成无名文件"，不是用户的意思。
   * ★ 文件名先过 `sanitizeFileName`（与拆板落盘、重命名对话框同一把尺子）；净化后为空
   *   （用户只打了 `/` `:` 这类非法字符）同样不动文件；目标已存在则**放弃改名**并提示，
   *   绝不覆盖别人的文件。
   * ★ `content.path` 由 `RenameWatcher` 跟随（`retargetBoard` 的名单里同时有 `file` 与
   *   `boardRef`），这里一个字都不写。
   */
  private async renameCardFileWithTitle(card: Card, title: string): Promise<void> {
    this.commit(t('history.title'), (board) => updateCards(board, [card.id], { title }));

    const path = this.cardRegistry.titleFilePath(card);
    if (path === null) return;
    const base = sanitizeFileName(title.trim(), '');
    if (base.length === 0) return;

    const { dir, ext } = splitName(path);
    const fileName = `${base}${ext}`;
    const next = joinPath(dir, fileName);
    if (next === path) return;

    const file = this.app.vault.getAbstractFileByPath(path);
    // 文件不在（已被移走 / 删除）：只记一行日志，卡片自己会显示断链态
    if (!(file instanceof TFile)) return;
    if (this.app.vault.getAbstractFileByPath(next)) {
      new Notice(t('notice.fileCardRenameExists', { name: fileName }));
      return;
    }
    try {
      await this.app.fileManager.renameFile(file, next);
    } catch (error) {
      console.warn('[nestboard] 卡片标题改名跟随失败', path, error);
      new Notice(t('notice.fileCardRenameFailed'));
    }
  }

  /**
   * 收起 / 展开这一张卡（`O31`）。
   *
   * ★ `collapsed: false` 时**把键删掉**而不是写 `false`：这个字段是"缺省即展开"的可选字段，
   *   留着 `false` 只是给文件添噪声（与 `rotation` 归一成 0 时不留痕同一条）。
   * ★ 走 `commit` 的**直接 mutate**而不是 `updateCards`：后者只认 `CardPatch` 白名单，
   *   而这里要的正是"展开时删键"这个白名单表达不了的动作。
   */
  private toggleCardCollapsed(cardId: string): void {
    const card = this.board?.cards.find((item) => item.id === cardId);
    if (!card) return;
    const next = card.collapsed !== true;

    this.commit(t('history.collapse'), (board) => {
      const target = board.cards.find((item) => item.id === cardId);
      if (!target || (target.collapsed === true) === next) return false;
      if (next) target.collapsed = true;
      else delete target.collapsed;
      return true;
    });
  }

  /**
   * 拖动 / 缩放的提交分流。
   *
   * 「Alt + 拖动 = 原地复制」（`F2-00-6`）：原卡留在原地，用户拖走的是**副本**。
   * 为什么不在别处做：
   *  * 按下指针时就复制 → "Alt 点一下（没拖）"也会凭空多一张卡；
   *  * `finish()` 之后再单独提交一次 → 两次 `mutate` 会在历史里留下两条记录。
   * 所以在这里**一次 `mutate`** 里"先复制、再把副本挪到拖到的位置"。
   */
  /**
   * 跨板搬运留下的"同伴记录"（`B2`）：这一批卡被搬进了哪块板、目标板上新增了哪几个 id。
   *
   * ★ 只活在**这一份视图的会话**里，不落盘：它是"撤销怎么走"的记账，不是数据。
   * ★ 复制（`⌥` 拖）不记 —— 源板没删东西，撤销与目标板无关（见 `transferCardsIntoBoard`）。
   */
  private readonly moveCompanions: { targetPath: string; cardIds: string[] }[] = [];

  /**
   * 跨板搬运的**同伴撤销**（`B2` 收尾）：源板撤回到搬运之前时，把目标板里那批也撤掉 ——
   * 于是 `⌘Z` **一下**就把两边都退回去。
   *
   * ★ 判据是"**那批卡真的回到了这块板上**"，而不是"这一下撤销是不是搬运"：
   *   历史里夹着别的操作时（先搬、再改个颜色、再撤销），只有"卡回来了"才说明退回的
   *   正是那次搬运 —— 靠猜的话会平白删掉目标板里的东西。
   * ★ 只认**栈顶**那一条：更早的搬运还压在那批卡身上（它们此刻也不在这块板上），
   *   越过去处理会把不相干的同伴一起撤了。
   * ★ 目标板那一次删除走 `repository.mutate`（它自己发通知、落盘、并在目标板历史上留一条）
   *   ⇒ 目标板那边也仍然能单独撤销回来。
   */
  private revertMoveCompanions(): void {
    const record = this.moveCompanions.at(-1);
    const board = this.board;
    if (!record || !board) return;
    const back = record.cardIds.every((id) => board.cards.some((card) => card.id === id));
    if (!back) return;

    this.moveCompanions.pop();
    this.plugin.repository.mutate(record.targetPath, (target) =>
      removeCards(target, record.cardIds),
    );
  }

  /**
   * 松手时压在哪张**白板卡**上（没有就 `null`）—— 把卡片搬进那块板的入口判据（`B2`）。
   *
   * ★ 几何命中用的是仓库现成的 `hitTest`（带旋转反算、`z` 最大者胜），不另写一套。
   * ★ 只认**没被拖动**的那批：拖着一张白板卡压到它自己身上，不该把它搬进它自己。
   * ★ 用**最上面那张被拖的卡的中心**当测试点，而不是指针位置：拖动预览这条路上手里
   *   只有几何，"我这张卡压在哪块板上"正是用户眼里的意思（与指针几乎总是一致），
   *   而取中心还省掉一条"指针坐标一路传下来"的管道。
   */
  private dropIntoBoardPath(rects: readonly CardRect[]): string | null {
    const board = this.board;
    if (!board || this.dragKind !== 'move' || rects.length === 0) return null;

    const dragged = new Set(rects.map((rect) => rect.id));
    const candidates = board.cards.filter(
      (card) => card.type === 'boardRef' && !dragged.has(card.id) && card.content.path.length > 0,
    );
    if (candidates.length === 0) return null;

    // "最上面那张"要按**模型的 `z`** 判（`CardRect` 里没有 z —— 它只是几何快照）：
    // 先找出被拖的那批里 z 最大的卡，再取它的矩形
    const topId = board.cards
      .filter((card) => dragged.has(card.id))
      .reduce<Card | null>((best, card) => (best === null || card.z >= best.z ? card : best), null);
    const top = rects.find((rect) => rect.id === topId?.id) ?? rects[0];
    const hit = hitTest(candidates, {
      x: top.x + top.width / 2,
      y: top.y + top.height / 2,
    });
    return hit && hit.type === 'boardRef' ? hit.content.path : null;
  }

  /**
   * 把这几张卡搬进另一块白板（`B2`，用户 2026-09-18："在画布内把一张卡片拖动到一个
   * 白板卡上，相当于把这张卡片剪切进这个白板卡"）。
   *
   * ★ 搬内容复用**跨板复制粘贴**那一套（`buildCardTransfer` / `parseCardTransfer` /
   *   `pasteCardTransfer`）—— 那三个函数已经解决"引用关系、附件、尺寸归一"这些麻烦事，
   *   再写一条搬运路径就是让两套规则慢慢分家。
   * ★ 用 `repository.mutate(目标, …)` 写目标板：它自己会发通知、走防抖落盘、
   *   并在**目标板的历史**上留下一条记录 —— 于是"在目标板里撤销 = 撤掉这次粘贴"。
   * ★ `copy`（`⌥` 拖）：原卡留在源板，只做前半截。
   * ★ 目标板只读 / 打不开 ⇒ `mutate` 自己会拒绝（返回 `false`），这里**什么都不动**：
   *   宁可"这次拖动没反应"，也不要搬了一半（源板删了、目标板没写进去）。
   *
   * ⚠️ 已知取舍：源板与目标板的历史是**两套**，所以这次搬运目前是"两边各一条记录"，
   *    `⌘Z` 要按两下（先撤源板、再切过去撤目标板）。配对成一步在下一轮做
   *    （要给仓储加"配对撤销"，见 `10-2.1.0开发计划.md`）。
   */
  private async transferCardsIntoBoard(
    rects: readonly CardRect[],
    targetPath: string,
    copy: boolean,
    label: string,
  ): Promise<void> {
    const board = this.board;
    const path = this.currentPath;
    if (!board || !path || path === targetPath || this.isReadOnly()) return;

    const transfer = buildCardTransfer(
      board,
      rects.map((rect) => rect.id),
    );
    const payload = transfer === null ? null : parseCardTransfer(transfer);
    if (payload === null) return;

    try {
      // 目标板要先真的读进来：`mutate` 是对"已打开的板"做原地改写的口子
      const opened = await this.plugin.repository.open(targetPath);
      if (!opened) return;

      // 落点用目标板的**视口中心**：贴过去的卡片出现在对方"正看着的地方"，
      // 而不是世界的原点（那多半在很远之外，用户会以为"没搬进去"）。
      const at = {
        x: opened.view.x + (this.boardViewWidth() || 0) / 2,
        y: opened.view.y + (this.boardViewHeight() || 0) / 2,
      };
      // 贴进去的这几个 id 要记下来：撤销时靠它判断"那批卡回到源板了没有"，
      // 也靠它把目标板里那批删掉（见 `revertMoveCompanions`）
      let pastedIds: string[] = [];
      const pasted = this.plugin.repository.mutate(targetPath, (target) => {
        const added = pasteCardTransfer(target, payload, at);
        // ★ 只记**卡片**的 id（`2.2.0` 批 4 五起载荷里还可能有整棵脑图）：
        //   这一条路是"把卡片拖到另一块板"的同伴记账，撤销时要按 id 把那批卡删掉 ——
        //   而 `moveCompanions` 那一套只认卡片（拖出来的是卡片，脑图没有拖出去这个手势）
        pastedIds = added.cards.map((card) => card.id);
        return added.cards.length > 0 || added.minds.length > 0;
      });
      if (!pasted) return;

      if (copy) return;
      // 剪切：记一条同伴记录，再从源板删掉 —— 于是"源板撤销"能连带把目标板那批也撤了
      this.moveCompanions.push({ targetPath, cardIds: pastedIds });
      this.commit(label, (source) =>
        removeCards(
          source,
          rects.map((rect) => rect.id),
        ),
      );
    } catch (error) {
      console.warn('[nestboard] 把卡片搬进白板失败', error);
    }
  }

  /** 画布当前的像素尺寸（搬进别的板时用来把落点换算到"对方看着的地方"） */
  private boardViewWidth(): number {
    return this.canvasEl?.clientWidth ?? 0;
  }

  private boardViewHeight(): number {
    return this.canvasEl?.clientHeight ?? 0;
  }

  private commitDrag(rects: readonly CardRect[], label: string): boolean {
    // ★★ 放进白板卡（`B2`）：拖到一张白板卡**上面**松手 ⇒ 把这几张卡搬进那块板
    //   （`⌥` 拖 = 复制，原卡留下）。判据见 `dropIntoBoardPath`。
    const intoBoard = this.dropIntoBoardPath(rects);
    // 松手了：那圈"会搬进这块板"的环该收掉（不论这一下成不成 —— 亮着的环留着，
    // 用户会以为"还没放下"）。★ 必须在这里收，而不是等下一次拖动预览：松手之后
    // 那条帧路就断了（`commitDragPreview` 拿到 `null` 会直接返回）。
    this.syncDropIntoHighlight(null);
    if (intoBoard !== null) {
      void this.transferCardsIntoBoard(rects, intoBoard, this.dragAltKey, label);
      return true;
    }

    if (this.dragKind === 'move' && this.dragAltKey) {
      let clones: Card[] = [];
      const changed = this.commit(t('history.duplicate'), (board) => {
        clones = duplicateCards(
          board,
          rects.map((rect) => rect.id),
          { x: 0, y: 0 },
        );
        if (clones.length === 0) return false;
        // `duplicateCards` 与 `rectsOf` 都按 `board.cards` 顺序取卡，两个数组逐位对应
        applyCardRects(
          board,
          rects.map((rect, index) => ({ ...rect, id: clones[index].id })),
        );
        return true;
      });
      // 选中副本，用户才能接着拖 / 删刚刚复制出来的这一批
      if (changed) this.selection.set({ cards: clones.map((clone) => clone.id) });
      return changed;
    }
    return this.commit(label, (board) => {
      let did = applyCardRects(board, rects);
      // 拖到空白处松手 = 退出分栏（T1.56）。`detachCards` 对不在栏内的卡片是空操作，
      // 所以这里不需要先判断"有没有卡在栏里"。
      // ★ 与几何写在同一处 mutate 里：分成两次会让撤销链上留下
      //   "先挪了位置、再解除归属"两条记录，用户得按两下 ⌘Z 才回到原状。
      if (this.dragKind === 'move' && this.dropTarget === null) {
        if (
          detachCards(
            board,
            rects.map((rect) => rect.id),
          )
        )
          did = true;
      }
      // ★ 拖出分栏之后把迷你白板卡掰回正方形（`O18`）：栏会改写成员的宽高，
      //   而"拖出来"是几何原地保留 —— 不掰的话它就是用户报的"拖进分栏再拖出来变形"。
      //   与几何、解除归属写在**同一个 mutate** 里：否则撤销链上会多出一条
      //   "只改了尺寸"的记录（用户得按两下 ⌘Z 才回到原状）
      if (repinMiniBoardRefs(board)) did = true;
      return did;
    });
  }

  // ── 分栏：手势入口与提交（T1.54–T1.60 / F2-7-4 / F2-7-5） ──

  /**
   * 指针按在分栏上（`ColumnLayer` 已 `stopPropagation`，画布不会把它当成框选）。
   *
   * 一律先**选中这个栏**：拖动哪个栏与"当前选中哪个栏"应该是同一件事，
   * 否则右键菜单里的"删除分栏"会在用户拖完 A 栏之后去删 B 栏。
   */
  private beginColumnGesture(columnId: string, gesture: ColumnGesture, event: PointerEvent): void {
    const board = this.board;
    if (!board || this.isReadOnly()) return;
    const column = columnById(board, columnId);
    if (!column) return;

    this.selection.selectColumn(columnId);
    this.focusCanvas();

    this.startDragSession();
    const origin = this.dragCanvasOrigin ?? { x: 0, y: 0 };
    const world = this.viewport.toWorld({
      x: event.clientX - origin.x,
      y: event.clientY - origin.y,
    });
    this.columnDrag = {
      column,
      gesture,
      origin: world,
      startRect: { x: column.x, y: column.y, width: column.width, height: column.height },
      moved: false,
    };
    this.pendingColumnRects = null;
  }

  /** 分栏拖动 / 缩放的每帧预览（只写 DOM，同卡片拖动的纪律） */
  private updateColumnDrag(world: Point): void {
    const drag = this.columnDrag;
    const board = this.board;
    if (!drag || !board) return;

    const dx = world.x - drag.origin.x;
    const dy = world.y - drag.origin.y;
    // 与卡片一致：超过阈值才算"拖动了"。没超过的话松手应当理解为"点了一下栏"
    if (!drag.moved && Math.abs(dx) < DRAG_THRESHOLD_PX && Math.abs(dy) < DRAG_THRESHOLD_PX) return;
    drag.moved = true;

    const rects =
      drag.gesture.kind === 'move'
        ? columnMoveRects(board, drag.column, drag.startRect.x + dx, drag.startRect.y + dy)
        : columnResizeRects(
            board,
            drag.column,
            resizedRect({ id: drag.column.id, ...drag.startRect }, drag.gesture.handle, dx, dy, {
              min: { width: COLUMN_LAYOUT.minWidth, height: COLUMN_LAYOUT.minHeight },
            }),
          );

    this.pendingColumnRects = rects;
    // 折叠态的栏只占标题栏那么高：预览不能把它撑开，
    // 否则用户拖一个折叠栏时会看到它"啪"地展开成一个空盒子
    const previewColumn: ColumnRect = {
      ...rects.column,
      height: drag.column.collapsed ? COLUMN_LAYOUT.collapsedHeight : rects.column.height,
    };
    // ★ 拖的是**编组的标签条**时，组里**每一栏**都要一起预览（用户 2026-09-16：
    //   "分组下有两个分栏，只有一个跟着动"）—— 只预览锚点那一栏的话，其余栏留在原地，
    //   而编组框是"成员矩形的**并集**" ⇒ 框会一边挪一边**变形**（看起来像在缩放），
    //   松手时提交又把两栏都搬过去 ⇒ 于是"瞬间过去"。
    //   ★ 位移取**锚点实际落到的那个位移**（`columnMoveRects` 可能吸附 / 钳过），
    //   整组因此永远是一条心。
    const appliedDx = roundTo(rects.column.x - drag.startRect.x);
    const appliedDy = roundTo(rects.column.y - drag.startRect.y);
    const previewColumns: ColumnRect[] = [previewColumn];
    if (this.groupDrag) {
      for (const id of this.groupDrag.columns) {
        if (id === drag.column.id) continue;
        const column = columnById(board, id);
        if (!column) continue;
        previewColumns.push({
          id: column.id,
          ...columnRect(column),
          x: roundTo(column.x + appliedDx),
          y: roundTo(column.y + appliedDy),
        });
      }
    }
    this.columnLayer?.previewRects(previewColumns);
    // 成员卡片的几何是"分栏算出来的"，不是用户拖出来的 —— 预览也必须整批跟着走，
    // 否则用户会看到"栏动了、里面的卡没动"
    // ★ 这些矩形是**模型**值（`layoutRects` 算出来的），要叠上这一栏当前的滚动偏移
    //   才是用户看到的位置（T2.03）。不叠的话，拖一个滚过的栏会让里面的卡
    //   在按下的一瞬间"啪"地跳回未滚动的排布
    const offset = this.columnScrollOffsetOf(drag.column.id);
    const previewCards: readonly CardRect[] =
      offset > 0
        ? rects.cards.map((rect) => ({ ...rect, y: scrolledRect(rect, offset).y }))
        : rects.cards;
    this.cardLayer?.previewRects(previewCards);

    // ★ 临时几何还必须落进**覆盖表**（`O21`）：被拖的这一栏、以及跟着它一起走的成员卡片
    //   都可能挂着连线，而线画的是"指针底下的位置"。上面两句只写了 DOM，
    //   模型一动没动 —— 覆盖表里没有这一栏的话，线会一动不动地拴在出发点上，
    //   松手才"啪"地贴过去（与卡片拖动当年踩的是同一个坑，补法也同一个）。
    const preview = new Map<string, Rect>();
    preview.set(previewColumn.id, {
      x: previewColumn.x,
      y: previewColumn.y,
      width: previewColumn.width,
      height: previewColumn.height,
    });
    for (const rect of previewCards) {
      preview.set(rect.id, { x: rect.x, y: rect.y, width: rect.width, height: rect.height });
    }
    // ★ 组里其余成员栏内部的卡片、以及组里的**松散卡片**成员，也一起平移到同一个位移
    //   （纯平移 ⇒ 模型值 + 同一个位移就够，不必再跑一遍 `layoutRects`）。
    //   不补的话，那几栏会"空着箱子跑过去"、松手时卡片才跟上。
    if (this.groupDrag) {
      const movedColumns = new Set(this.groupDrag.columns);
      const shifted = (id: string): void => {
        const card = board.cards.find((item) => item.id === id);
        if (!card || preview.has(id)) return;
        preview.set(id, {
          x: roundTo(card.x + appliedDx),
          y: roundTo(card.y + appliedDy),
          width: card.width,
          height: card.height,
        });
      };
      for (const card of board.cards) {
        if (card.columnId !== null && movedColumns.has(card.columnId)) shifted(card.id);
      }
      for (const id of this.groupDrag.cards) shifted(id);
    }
    this.dragPreviewRects = preview;
    this.edgeLayer?.invalidate();
    // ★ 编组框也要跟着这一帧走（用户 2026-09-16："拖的时候分栏走了、分组框松手才跳过去"）：
    //   它的几何是从**视觉矩形**算的（`visualColumnRectOf` 优先取覆盖表），
    //   而这条"只写 DOM"的预览不经过 `syncCanvas()` —— 不在这里补一次，
    //   框就一直停在这几栏**出发**的地方，直到松手才瞬移过去。
    this.syncGroupLayer();
  }

  /** 松手：整栏移动 / 缩放提交一次 */
  private finishColumnDrag(): void {
    const drag = this.columnDrag;
    const rects = this.pendingColumnRects;
    this.columnDrag = null;
    this.pendingColumnRects = null;
    this.endDragSession();

    // 没真正拖动（按一下就松手）：那就是"点选一个栏"，选中态在按下时已经设好
    if (!drag || !rects || !drag.moved) {
      this.refreshCards();
      return;
    }

    // ★ 折叠态的栏：缩放/移动落盘时要把高度还原成**模型里的展开高度**。
    //   否则拖动预览用的那个 `collapsedHeight`（40）会被 `applyColumnRects`
    //   按最小高度钳成 120 写进模型 —— 用户一展开就得到一个空荡荡的怪盒子。
    const committed = drag.column.collapsed
      ? { ...rects, column: { ...rects.column, height: drag.column.height } }
      : rects;

    // ★ 拖的是**编组的标签条**时，组里其余分栏与成员卡片一起平移（用户 2026-09-16：
    //   "拖组带着分栏一起走"）—— 与 `applyColumnRects` 写在**同一次** `commit` 里：
    //   分两次会让撤销链上留下两条记录，用户得按两下 ⌘Z 才回到原状。
    const group = this.groupDrag;
    this.groupDrag = null;
    const delta = {
      x: roundTo(committed.column.x - drag.column.x),
      y: roundTo(committed.column.y - drag.column.y),
    };

    this.commit(
      t(drag.gesture.kind === 'move' ? 'history.moveColumn' : 'history.resizeColumn'),
      (board) => {
        let did = applyColumnRects(board, committed);
        if (group === null || (delta.x === 0 && delta.y === 0)) return did;
        for (const id of group.columns) {
          if (id === drag.column.id) continue;
          const column = columnById(board, id);
          if (!column) continue;
          column.x = roundTo(column.x + delta.x);
          column.y = roundTo(column.y + delta.y);
          did = true;
        }
        // 松散卡片成员也跟着走；栏内卡片由 `relayoutColumns` 按新栏位置重排（不必动）
        if (group.cards.length > 0 && translateCards(board, group.cards, delta.x, delta.y)) {
          did = true;
        }
        return did;
      },
    );
  }

  // ── 栏内滚动（T2.03 / F2-7-10） ──────────────────────────

  /**
   * 画布上的滚轮（**捕获**阶段，见 `ensureCanvas` 里的注册处）。
   *
   * 只做一件事：指针底下那一栏**能滚**的时候，把滚轮留给它，别给画布。
   */
  private onCanvasWheelCapture(event: WheelEvent): void {
    const body = this.scrollBodyUnder(event);
    if (!body) return;

    if (event.ctrlKey || event.metaKey) {
      // ⌘/Ctrl + 滚轮是捏合缩放：这里只掐掉内容槽的**原生**滚动，
      // ★ 不能 `stopPropagation` —— 那会把画布的缩放也一起掐掉（用户以为"缩放进栏里失效了"）
      event.preventDefault();
      return;
    }

    const delta = wheelDelta(event, body.clientHeight);
    // 横向滚动（触控板的 deltaX）交给画布：栏内滚动是纯纵向的
    if (delta === 0) return;

    event.preventDefault();
    // ★ 到这一步才拦：先 `preventDefault` 再 `stopPropagation`，
    //   画布的平移/缩放监听器在冒泡阶段，晚一步就会"滚了栏也平移了画布"
    event.stopPropagation();
    body.scrollTop += delta;
  }

  /**
   * 指针底下的内容槽（T2.03）。栏不存在 / 装得下 → `null`，滚轮照常归画布。
   *
   * ★ 按**几何**找，而不是 `event.target.closest()`：成员卡片与内容槽是兄弟节点，
   *   "滚在卡上"时事件的 target 就是卡本身，顺着 DOM 永远走不到那个槽。
   *   两者唯一的共同祖先是画布，所以只能拿指针位置回头问模型"这是哪一栏"。
   */
  private scrollBodyUnder(event: WheelEvent): HTMLElement | null {
    const canvas = this.canvasEl;
    const board = this.board;
    if (!canvas || !board) return null;
    const rect = canvas.getBoundingClientRect();
    const world = this.viewport.toWorld({
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    });

    let best: Column | null = null;
    for (const column of board.columns) {
      if (column.collapsed) continue;
      // 命中区用**可见高度**：栏内滚动之后，超出的部分不在屏幕上，也就不该抢滚轮
      const hit: Rect = {
        x: column.x,
        y: column.y,
        width: column.width,
        height: columnDisplayHeight(column),
      };
      if (!rectContainsPoint(hit, world)) continue;
      // 同 `HitTest.hitTest`：z 大者胜（两栏叠在一起时，用户瞄的是上面那个）
      if (!best || column.z >= best.z) best = column;
    }
    if (!best) return null;

    const body = this.columnLayer?.scrollBodyOf(best.id) ?? null;
    // 装得下就不拦（`F2-7-10` 要的是"栏内滚动**不影响**画布"，不是"滚轮归分栏"）
    if (!body || body.scrollHeight <= body.clientHeight + 1) return null;
    return body;
  }

  /** 视图回调：某一栏滚到某处了（`ColumnLayer` 报上来的，见 `onScroll`） */
  private onColumnScroll(columnId: string, offset: number): void {
    const board = this.board;
    const column = board ? columnById(board, columnId) : null;
    if (!board || !column) return;
    const next = clampColumnScroll(board, column, offset);
    if ((this.columnScroll.get(columnId) ?? 0) === next) return;
    this.columnScroll.set(columnId, next);
    this.syncColumnScroll();
  }

  /**
   * 把"栏内滚动"的当前状态同步给渲染层（卡片位移 + 裁剪 + 滚动条）。
   *
   * ★ 只要**白板内容**或**滚动偏移**变了就必须走这里。漏掉的表现很分裂：
   *   卡片挪了但连线还拴在旧位置、或者内容变矮了却还留着一个滚不动的偏移。
   */
  private syncColumnScroll(): void {
    const views = this.buildColumnScrollViews();
    this.cardLayer?.setColumnScroll(views);
    this.columnLayer?.setScrollOffsets(this.columnScroll);
    // 连线锚在卡片上：卡片挪了，线就得跟着重画
    this.edgeLayer?.invalidate();
  }

  /** 当前该生效的滚动状态（顺手清掉"栏没了 / 装得下"的陈旧偏移） */
  private buildColumnScrollViews(): Map<string, ColumnScrollView> {
    const views = new Map<string, ColumnScrollView>();
    const board = this.board;
    if (!board || this.columnScroll.size === 0) return views;
    // 复制一份再遍历：下面会删 `columnScroll`
    for (const [columnId, offset] of [...this.columnScroll]) {
      const column = columnById(board, columnId);
      const view = column ? columnScrollView(board, column, offset) : null;
      if (!view) {
        // 装得下 / 栏已被删：偏移作废。留着它，下次内容一多就会"莫名其妙又滚回那一段"
        this.columnScroll.delete(columnId);
        continue;
      }
      views.set(columnId, view);
    }
    return views;
  }

  /** 卡片所属分栏当前的滚动偏移（不属于分栏的卡片恒为 0） */
  private columnScrollOffsetOf(columnId: string | null): number {
    if (!columnId || this.columnScroll.size === 0) return 0;
    return this.columnScroll.get(columnId) ?? 0;
  }

  /**
   * 卡片的**视觉**矩形（栏内滚动之后"屏幕上看到的那一份几何"）。
   *
   * ★ 拖动、连线、命中测试一律用它，而不是 `toCardRect(card)`：
   *   模型里的成员坐标是**未滚动**的，两者差一个偏移。用错了的表现是
   *   "卡片明明在眼前，拖它却动不了"（因为拖的是它"模型所在"的位置）。
   */
  private visualRectOf(card: Card): CardRect {
    const offset = this.columnScrollOffsetOf(card.columnId);
    if (offset <= 0) return toCardRect(card);
    const visual = scrolledRect(card, offset);
    return { ...toCardRect(card), y: visual.y };
  }

  /**
   * 分栏的**视觉**矩形（`O21`）。
   *
   * ★ 走 `columnRect`（折叠态用**显示高度**）：收起时栏只有一条标题栏那么高，
   *   连线锚点必须落在用户看得见的那条上 —— 拿模型里的 `height` 算，锚点会浮在
   *   一个看不见的空盒子边上，成了"锚点飘了、连不上"。
   * ★ 拖动中的栏（移动 / 缩放 / 收放）优先取覆盖表：与卡片同一条纪律 ——
   *   模型要到松手才变，而锚点必须跟着手走，否则松手瞬间线会"啪"地跳一下。
   */
  private visualColumnRectOf(column: Column): Rect {
    return this.visualOverrides()?.get(column.id) ?? columnRect(column);
  }

  /**
   * 卡片的**视觉外接框**：{@link visualRectOf} 再套一层旋转（T7.06）。
   *
   * ★ 只给"按占位范围判断"的地方用（框选、适应内容取景、演示取景）——
   *   那里问的是"这张卡占了多大一块"，旋转当然要算进去。
   * ★ **绝不能**拿它去做拖动 / 缩放的几何：`x/y/width/height` 是没转过的**布局框**，
   *   把外接框写回模型等于"转一下卡片，宽度自己变大了"（见 `schema.CardBase.rotation`）。
   *   `deg === 0` 时 `rotatedBoundsOf` 原样返回，于是绝大多数卡片零开销。
   */
  private visualBoundsOf(card: Card): Rect {
    return rotatedBoundsOf(this.visualRectOf(card), card.rotation ?? 0);
  }

  /**
   * "视觉几何"的覆盖表：模型坐标与屏幕上的差异（栏内滚动 + 拖动预览）。
   *
   * 连线画的是**用户看到的位置**，所以覆盖表就是它的输入。
   * 两份都没有（没滚动、没在拖）时返回 `null` = "按模型画"，省掉一次全量建表。
   */
  private visualOverrides(): ReadonlyMap<string, Rect> | null {
    const board = this.board;
    if (!board) return this.dragPreviewRects;
    if (this.columnScroll.size === 0) return this.dragPreviewRects;
    const map = new Map<string, Rect>();
    for (const card of board.cards) {
      const offset = this.columnScrollOffsetOf(card.columnId);
      if (offset <= 0) continue;
      map.set(card.id, scrolledRect(card, offset));
    }
    if (this.dragPreviewRects) {
      // 拖动预览要**盖住**滚动位移：用户手里那张卡的位置由指针决定
      for (const [id, rect] of this.dragPreviewRects) map.set(id, rect);
    }
    return map;
  }

  /**
   * 把某一栏滚到"能看见这张卡"（插入 / 收进分栏之后调，T2.03）。
   *
   * ★ 必须做：栏高封顶之后，往一个满栏里插卡**看不到任何变化**
   *   （卡片落在滚动窗口下方），用户会以为"没收进去"，然后反复再拖一次。
   */
  private revealCardInColumn(columnId: string, cardIds: readonly string[]): void {
    const board = this.board;
    const column = board ? columnById(board, columnId) : null;
    if (!board || !column || cardIds.length === 0) return;
    const members = new Set(cardIds);
    const targets = board.cards.filter((card) => members.has(card.id));
    if (targets.length === 0) return;
    const viewport = columnViewport(column);
    if (viewport.height <= 0) return;

    let next = this.columnScrollOffsetOf(columnId);
    for (const card of targets) {
      const top = roundTo(card.y - viewport.top);
      const bottom = roundTo(card.y + card.height - viewport.bottom);
      // 落在窗口下方 → 滚到它整个露出来；落在上方（插到了第一行）→ 滚回它
      if (bottom > next) next = bottom;
      else if (top < next) next = top;
    }
    const clamped = clampColumnScroll(board, column, next);
    if (clamped === this.columnScrollOffsetOf(columnId)) return;
    this.columnScroll.set(columnId, clamped);
    this.syncColumnScroll();
  }

  /** 卡片落点（T1.55）：算插入线并画出来 */
  private updateDropTarget(world: Point): void {
    const board = this.board;
    const ids = this.selection.cardIds;
    if (!board || ids.size === 0) {
      this.clearDropTarget();
      return;
    }
    // ★ 把正在拖的卡片排除掉：不排除的话，插入线会被"这堆卡原来占的高度"带着走，
    //   看起来像插在自己下面，用户松手后位置和看到的不一样
    // ★ 把"这一栏滚到哪了"一并交给它：成员坐标是模型值，而用户是照着屏幕往下放的，
    //   不换算的话插入线与序号都会偏出滚动偏移那么多（T2.03）
    this.dropTarget = findDropTarget(board, world, ids, (columnId) =>
      this.columnScrollOffsetOf(columnId),
    );
    if (this.dropTarget) this.drawInsertLine();
    else this.clearDropTarget();
  }

  private clearDropTarget(): void {
    if (!this.dropTarget) return;
    this.dropTarget = null;
    // 覆盖层只在 `syncCanvas` 里被清空，而 `clearDropTarget` 可能发生在两次 sync 之间 ——
    // 手动开一帧，否则插入线会一直挂在画面上直到下一次视口变化
    this.overlayLayer?.beginFrame();
    // ★ 上面那一帧把参考线也一起擦了（整层清空）。拖动还在继续，所以必须补画回来，
    //   否则"拖出分栏 → 参考线消失"（用户会以为对齐功能坏了）
    this.drawSmartGuides();
  }

  /**
   * 分栏标题提交（T1.54）。
   * ★ 目标永远是"被编辑的那一栏"（`columnId`），不是选区 ——
   *   用户完全可能先点了别的栏，此时 `title` 提交到选区会改错栏。
   */
  private setColumnTitle(columnId: string, title: string): void {
    this.commit(t('history.title'), (board) => setColumnTitle(board, columnId, title));
  }

  /** 折叠 / 展开（T1.57）。折叠只改渲染高度，模型的 `height` 留着（展开要能回到原尺寸） */
  private toggleColumnCollapsed(columnId: string): void {
    const board = this.board;
    const column = board ? columnById(board, columnId) : null;
    if (!column) return;
    this.commit(t('history.column'), (draft) =>
      setColumnCollapsed(draft, columnId, !column.collapsed),
    );
  }

  /** 删除分栏（T1.60）：卡片留在原地，或连同卡片一起删 */
  private removeColumnById(columnId: string, mode: 'release' | 'delete'): void {
    this.commit(t('history.delete'), (board) => {
      let did = removeColumn(board, columnId, mode);
      // `release`（卡片留在原地）与"拖出分栏"是同一种结局：栏撑过的宽高要还给迷你卡
      if (repinMiniBoardRefs(board)) did = true;
      return did;
    });
  }

  /** 把某一栏里的卡片拆成同级并排分栏（T1.58 的栏菜单入口） */
  private splitColumnIntoColumns(columnId: string): void {
    const board = this.board;
    if (!board) return;
    const ids = cardsInColumn(board, columnId).map((card) => card.id);
    if (ids.length < 2) return;
    this.commit(t('history.create'), (draft) => splitIntoColumns(draft, ids).length > 0);
  }

  private showColumnMenu(columnId: string, event: MouseEvent): void {
    const board = this.board;
    if (!board) return;
    const column = columnById(board, columnId);
    if (!column) return;
    event.preventDefault();
    // 右击一栏就选中它：菜单里的动作必须作用在"用户正看着的那个东西"上。
    // ★ 但它**已经在选区里**（框选了好些栏）时保持选区不动 —— 与卡片菜单同一条约定
    //   （右击一张已选中的卡不会把选区收成一张），否则菜单里的「编组」就只剩这一栏了。
    if (!this.selection.hasColumn(columnId)) this.selection.selectColumn(columnId);
    showMenuAtMouse(
      event,
      buildColumnMenuSpec({
        column,
        memberCount: cardsInColumn(board, columnId).length,
        // 只读板（T4.06）：重命名 / 折叠 / 拆栏 / 对齐 / 删除全部置灰
        readOnly: this.isReadOnly(),
        actions: {
          rename: (id) => this.columnLayer?.editTitle(id),
          toggleCollapse: (id) => this.toggleColumnCollapsed(id),
          splitIntoColumns: (id) => this.splitColumnIntoColumns(id),
          // ★ 走 `groupSelection` 而不是"只收这一栏"：框选能同时框住**好几栏**
          //   （用户 2026-09-16），那时这一项该作用在整个选区上 —— 只收右击的那一栏
          //   会让其余几栏留在原地，用户以为"编组只成功了一半"。
          //   只选中一栏时两者完全等价（收的就是这一栏的全部成员）。
          toGroup: () => this.groupSelection(),
          alignRow: () => this.alignSelectedColumns(),
          // 分栏主色（用户 2026-09-18："分栏要允许设置颜色"）：写进撤销栈
          setColor: (id, color) =>
            this.commit(t('history.color'), (board) => updateColumns(board, [id], { color })),
          pickColor: (_id, current, apply) => pickColor(this.app, current, apply),
          remove: (id, mode) => this.removeColumnById(id, mode),
        },
      }),
    );
  }

  /**
   * ⌘⇧G / 右键「收进分栏」：选中的卡片收进一个**新建**的栏（T1.59）。
   *
   * ★ 收完顺手选中新栏：这个动作之后用户多半要给它改名或挪位置，
   *   而选中是这两件事的前提（尺寸手柄只在选中时出现）。
   */
  collectIntoColumn(): void {
    const ids = [...this.selection.cardIds];
    if (ids.length === 0) return;
    let created: string | null = null;
    const changed = this.commit(t('history.create'), (board) => {
      created = groupIntoNewColumn(board, ids);
      return created !== null;
    });
    if (changed && created) this.selection.selectColumn(created);
  }

  /** ⌘Enter / 右键「拆成多个分栏」：一卡一栏并排（T1.58） */
  splitSelectionIntoColumns(): void {
    const ids = [...this.selection.cardIds];
    if (ids.length < 2) return;
    this.commit(t('history.create'), (board) => splitIntoColumns(board, ids).length > 0);
  }

  /** 松手落在某个分栏里 → 插到插入线指的位置（T1.55） */
  private dropCardsIntoColumn(target: ColumnDropTarget): void {
    const ids = [...this.selection.cardIds];
    // ★ 不用 `dragController.finish()`：那条路会把预览的矩形原样落到模型上，
    //   而"进了栏"的卡片位置由分栏算（`commit` 里统一 `relayoutColumns`）——
    //   用户把它拖到哪不重要，插在第几位才重要。所以先 `cancel()` 撤掉预览，再单独提交。
    this.dragController?.cancel();
    this.dropTarget = null;
    this.endDragSession();
    this.dragAltKey = false;
    this.overlayLayer?.beginFrame();

    const changed = this.commit(t('history.column'), (board) =>
      insertCardsIntoColumn(board, ids, target.columnId, target.index),
    );
    // ★ 栏高封顶之后（T2.03），往一个满栏里插卡在屏幕上"看不出变化"
    //   （卡片落在滚动窗口下方）—— 用户会以为没收进去，然后再拖一次。
    //   所以插入成功后把栏滚到能看见这批卡的位置。
    if (changed) this.revealCardInColumn(target.columnId, ids);
  }

  /** 撤销 / 重做的公共流程：写回快照 → 过一遍 `mutate` → **最后**才动栈 */
  private applyHistory(direction: 'undo' | 'redo'): void {
    const path = this.currentPath;
    if (!path || this.isReadOnly()) return;

    const entry = direction === 'undo' ? this.history.peekUndo() : this.history.peekRedo();
    if (!entry) {
      new Notice(t(direction === 'undo' ? 'notice.undoEmpty' : 'notice.redoEmpty'));
      return;
    }
    const board = this.plugin.repository.get(path);
    if (!board) return;

    // ★ 顺序不可换：先写内容、再动栈。快照解析失败（文件被外部改坏过）时栈必须原样保留，
    //   否则用户按一次 ⌘Z 就永久失去了那一步 —— 这比"撤销没生效"糟得多。
    const restored =
      direction === 'undo'
        ? restoreContent(board, entry.before)
        : restoreContent(board, entry.after);
    if (!restored) return;

    this.applyingHistory = true;
    try {
      // 快照是**就地替换数组**的，必须过一遍 `mutate` 才会递增 revision、
      // 通知渲染层、排盘 —— 直接改对象等于白改。
      this.plugin.repository.mutate(path, () => true);
    } finally {
      this.applyingHistory = false;
    }

    if (direction === 'undo') {
      this.history.commitUndo();
      // ★ 同伴撤销（`B2` 收尾）：这一次撤销如果正是"把那一批卡搬回源板"，
      //   目标板里对应的那几张也一并撤掉 —— 于是 `⌘Z` **一下**回滚了两边。
      //   ★ 放在 `commitUndo()` **之后**：撤销栈先落定，再动目标板；
      //     反过来（先动目标板再落栈）万一目标板写失败，源板那一步已经退不回去了。
      //   ★ 只在 `undo` 这一侧：重做（`⌘⇧Z`）不恢复跨板的搬运 ——
      //     那需要重做时再把卡贴回去，属于"搬运本身的重做"，留给搬运那条路自己长。
      this.revertMoveCompanions();
    } else {
      this.history.commitRedo();
    }

    new Notice(t(direction === 'undo' ? 'notice.undone' : 'notice.redone', { label: entry.label }));
  }

  /** 新建一张便签卡并立刻进入编辑（空白处双击 / ⌘⇧E / 右键菜单） */
  private createNoteAt(world: Point): void {
    this.createCardAt(world, 'note');
  }

  /**
   * 新建卡片该用什么颜色（T3.24 / `F11-03`）。
   *
   * ★ 读的是**插件设置**而不是 `board.settings.defaultCardColor`：
   *   前者是"这个人的偏好"，后者是"这块板文件里存着的那个值"。
   *   用户在设置里改默认色，意图是"我以后新建的卡都长这样"，
   *   与当前打开的是哪块板无关（设置项的注释也写明了这一条）。
   * ★ 只影响**之后新建**的卡片：这里是一个取值函数，绝不回头去改已有卡片 ——
   *   "改一次默认值，一屏卡全变色"是不可接受的。
   */
  private newCardColor(type?: CardType): Card['color'] {
    // ★ 类型自己的默认色优先（`cards/image.ts` 的 `defaultColor` = 纯黑"相框"，
    //   用户 2026-09-17"默认应该是纯黑的卡片颜色和边框颜色"）；其余类型仍用设置里那个。
    //   做成"问定义"而不是在视图里写 `if (type === 'image')`：加类型时不必改视图。
    if (type) {
      const declared = this.cardRegistry.get(type)?.defaultColor;
      if (declared) return declared;
    }
    return this.plugin.settings.defaultCardColor;
  }

  /**
   * 新建一张指定类型的空白卡并立刻进入编辑（T1.34 便签 / T3.01 待办）。
   *
   * 默认尺寸取自卡片定义而不是硬编码 —— 新增一种"落点即编辑"的卡片时，
   * 只需在定义里给出 `defaultSize` 与 `createDefaultContent()`。
   */
  private createCardAt(world: Point, type: CardType): void {
    if (this.isReadOnly()) return;
    const definition = this.cardRegistry.get(type);
    // 定义没注册就不该"静默建一张画不出来的卡"：宁可什么都不做
    if (!definition) return;

    const content = definition.createDefaultContent();
    // ★ 尺寸：默认取类型的 `defaultSize`；类型若能**按内容算**（`sizeForContent`，
    //   `F4` 的内嵌脑图卡就是它）就以那个为准 —— 用户要的"尺寸随内容自适应"
    const size = definition.sizeForContent?.(content) ?? definition.defaultSize;
    const card = createCard(type, {
      // 以点击处为**中心**：双击空白时用户脑子里的位置是"就这儿"，
      // 让卡片左上角对齐光标会把它整体推到右下角
      x: roundTo(world.x - size.width / 2),
      y: roundTo(world.y - size.height / 2),
      width: size.width,
      height: size.height,
      title: '',
      // ★ 按**类型**取默认色（图片卡 = 纯黑"相框"）：见 `newCardColor` 的说明
      color: this.newCardColor(type),
      content,
    }) as Card;
    // ★ 上面这处 `as Card`：`type` 在这个位置是联合类型，`createCard` 返回的是
    //   `CardOf<联合>`（类型与内容仍一一对应），但 TS 无法把一次泛型调用证明成判别联合。
    //   放行点只此一处，形状由 `definition` 与 `createCard` 双重保证。

    // ★ 内嵌脑图卡（`F4`）：它**没有"整卡编辑态"**这回事（编辑发生在卡内那一层：
    //   点节点改名 / 右键加节点），改成"把光标送进中心主题"——与"加子节点之后立刻打字"
    //   共用同一个请求槽（`mind/embed/editRequest`）。
    //   ★★ 这一句**必须排在 `commit` 之前**：卡片是在 `commit` 里第一次被画出来的，
    //   而 `EmbedMind` 就在那一帧取这个请求。排在 commit 之后的话，那一帧已经过去了，
    //   再也没人来取（"新建之后光标没进中心主题"报的就是这个）。
    //   真正的聚焦由 `EmbedMind` 推迟一帧执行，所以下面那句 `focusCanvas()` 抢不走它。
    if (card.type === 'mind') requestMindEdit(card.id, card.content.mind.rootId);

    if (!this.commit(t('history.create'), (board) => addCards(board, [card]))) return;
    this.selection.set({ cards: [card.id] });
    this.focusCanvas();
    // 编辑态不是"落卡"的一部分，而是类型自己的选择（`autoEditOnCreate`，O13）：
    // 评论卡新建出来是一张空线程，用户第一件想做的事通常是**先把它拖到想说的地方**，
    // 所以它明确要求停在这一步（卡片已选中，拖拽区完整）。
    if (card.type !== 'mind' && definition.autoEditOnCreate !== false) this.enterEditMode(card.id);
  }

  /**
   * 进入某张卡的内容编辑态。
   *
   * 默认顺序刻意是"**先问类型、后进编辑态**"：引用卡的双击是"打开源笔记"（T1.43），
   * 反过来的话它会既跳转、又弹出一个空的正文编辑框。
   *
   * `force` 为真时跳过那一问 —— 给"明确要求编辑内容"的入口用（Enter / 右键
   * 「编辑内容」，T2.01）。这些手势已经表达过一次意图了，再被类型抢走就是抗命。
   *
   * `entry` 决定"从哪一步开始"（O01）：双击那条路带 `'title'`，`⌘`+双击 /
   * `⌘`+Enter 带 `'raw'`（跳过标题，直接给正文）。
   * ★ `F5` 起**便签 / 同步便签不再按它分支**：两者的编辑态都只有正文一格
   *   （与引用卡——`.md` 文档节点——同款），标题走卡面那一行的就地输入。
   */
  private editCard(id: string, force = false, entry: EditEntry = 'title'): void {
    if (this.isReadOnly()) return;
    const card = this.board?.cards.find((item) => item.id === id);
    // 未注册的类型不抢：其余类型保持只读展示
    if (!card || card.locked || !this.cardRegistry.has(card.type)) return;
    if (!force && this.cardRegistry.activate(card, this.createActionContext(card))) return;
    this.enterEditMode(card.id, entry);
  }

  /** 打开卡片的源笔记（引用卡双击 / 菜单里的「打开源笔记」） */
  private openSourceCard(card: Card): void {
    if (this.cardRegistry.activate(card, this.createActionContext(card))) return;
    // 没被类型接管、又确实有个不存在的路径 → 明说"源文件没了"，
    // 而不是让用户对着一次毫无反应的点击反复怀疑自己是不是点歪了。
    //
    // ★ 三种卡都可能走到这里：引用卡（笔记删除）、文件卡（附件移动）、
    //   白板卡（子板删除）。它们的 `onDoubleClick` 都在"目标不存在"时
    //   主动返回 `false` 把提示的责任交给视图 —— 集中在这里说，文案才不会各写各的。
    const sourcePath =
      card.type === 'noteRef' || card.type === 'file' || card.type === 'boardRef'
        ? card.content.path
        : '';
    if (sourcePath.length === 0) return;
    new Notice(
      t(card.type === 'noteRef' ? 'notice.sourceMissing' : 'notice.sourceMissingFile', {
        path: sourcePath,
      }),
    );
  }

  /** 断链重连（T1.45）：由卡片类型自己弹选择器并把新路径写回内容 */
  private relinkCard(id: string): void {
    if (this.isReadOnly()) return;
    const card = this.board?.cards.find((item) => item.id === id);
    if (!card) return;
    this.cardRegistry.relink(card, this.createActionContext(card));
  }

  // ───────────────────────────────────────────────────────────
  // 嵌套白板与导航（T1.61 / T1.62）
  // ───────────────────────────────────────────────────────────

  /** 右键"进入白板"：与双击同一条路，由白板卡自己的 `onDoubleClick` 决定去留 */
  private openBoardCard(card: Card): void {
    if (this.cardRegistry.activate(card, this.createActionContext(card))) return;
    // 类型没接管 → 目标板多半不在了，给一次明确反馈（交给 `openSourceCard` 统一文案）
    this.openSourceCard(card);
  }

  /**
   * 落一块"当前板的子板"并把它说给用户听（T1.61 / `F2-8-1`）。
   * 返回新板路径；只读 / 中途被切板 / 失败返回 `null`（失败已经提示过了）。
   *
   * 双击空格位与右键「新建子白板」共用这一处 —— 各写一份的话，
   * "通知说什么""只读时怎么办""切板了还写不写"迟早会各答一次。
   */
  private async createChildBoardFile(): Promise<string | null> {
    const parent = this.currentPath;
    if (!parent || this.isReadOnly()) return null;

    try {
      const created = await createBoardInVault(this.plugin, { parent });
      // ★ 与 `promoteCard` 同一条纪律：`await` 回来时视图可能已经被切到别的板上了，
      //   这时再往"当前板"写内容会写进**错误的文件**。新板已经建好，用户自己去认领它
      if (this.currentPath !== parent) return null;
      new Notice(t('notice.boardRefCreated', { path: created }));
      return created;
    } catch (error) {
      // 顶层板那句（`notice.boardCreateFailed`）在 `commands.ts` 里 —— 两句话不同，
      // 因为用户按的键不同，出错时得认得出是哪一次操作失败了
      new Notice(t('notice.boardRefFailed', { error: describeError(error) }));
      return null;
    }
  }

  /**
   * 为一张**还没有目标**的白板卡新建子板，并把新路径写回这张卡（T1.61 / `F2-8-1`）。
   *
   * 返回 `false` = 什么都没做（只读 / 卡片已经有目标 / 建文件失败 / 卡片已消失）。
   */
  private async createChildBoardForCard(cardId: string): Promise<boolean> {
    const card = this.board?.cards.find((item) => item.id === cardId);
    // ★ 只对"空格位"动手：已经有目标的卡被悄悄改个指向，等于把它原来指着的那块板
    //   从画布上抹掉 —— 用户没要求过这件事，所以这里宁可什么都不做
    if (!card || card.type !== 'boardRef' || card.content.path.length > 0) return false;

    const created = await this.createChildBoardFile();
    if (!created) return false;

    // 写回内容**走历史**（`commit`）而不是 `updateContent`：这张卡从"空格"变成
    // "子板入口"是一次可见的内容改动，⌘Z 该能退回去（`F1-08` 的可撤销约定）。
    return this.commit(t('history.createChildBoard'), (board) => {
      const target = board.cards.find((item) => item.id === cardId);
      // 这一小会儿里卡片可能被删了 / 被别的路径认领了 —— 那就不动它
      if (!target || target.type !== 'boardRef' || target.content.path.length > 0) return false;
      target.content = { ...target.content, path: created };
      return true;
    });
  }

  /**
   * 菜单里的"编辑说明文字"（T1.50）。
   *
   * ★ 直接派发一次 `dblclick` 而不是另开一条"开始编辑"的入口：用户双击说明文字
   *   走的就是那个监听器 —— 复用同一个入口，菜单触发与手势触发就不可能长歪。
   */
  private requestCaptionEdit(cardId: string): void {
    const caption = this.cardLayer
      ?.contentElementOf(cardId)
      ?.querySelector<HTMLElement>('.nestboard-image-caption');
    caption?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  }

  /**
   * 菜单里的"从图片吸色"（T3.05 / `F2.6`）。
   *
   * 流程是**跨卡片**的：在色板卡上发起，到图片卡上落地 —— 只有视图能驱动它
   * （卡片定义拿不到别的卡的 DOM）。会话本身在 `EyedropperSession` 里，
   * 这里只回答两个问题："点在什么位置上"与"取到了怎么办"。
   */
  private startEyedropper(swatchId: string): void {
    if (this.isReadOnly()) return;
    const card = this.board?.cards.find((item) => item.id === swatchId);
    const canvas = this.canvasEl;
    if (!card || card.type !== 'swatch' || card.locked || !canvas) return;

    // 再点一次菜单 = 重来：不先收掉旧会话的话，一次点击会被两个会话各采一次
    // （用户会看到颜色加了两次）
    this.eyedropper?.cancel();
    new Notice(t('notice.swatchPickStart'));

    const session = new EyedropperSession({
      host: canvas,
      // 刚点完右键菜单时焦点多半不在画布上：`Esc` 挂到文档上才收得到，
      // 否则用户按 Esc 没反应，只能靠点一下空白处退出
      keyTarget: canvas.ownerDocument,
      sampler: this.pixelSampler,
      resolve: (event) => this.eyedropperSource(event),
      onPick: (color, source) => this.applyPickedColor(swatchId, color, source.path),
      onMiss: (reason) => new Notice(t(EYEDROPPER_MISS_KEY[reason])),
      onEnd: () => {
        if (this.eyedropper === session) this.eyedropper = null;
      },
    });
    this.eyedropper = session;
    session.start();
  }

  /** 点在什么位置上：只有"真的加载出图来了的图片卡"能被吸色 */
  private eyedropperSource(event: PointerEvent): EyedropperSource | null {
    const canvas = this.canvasEl;
    if (!canvas) return null;
    const cardId = resolveCardId(event.target, canvas);
    if (!cardId) return null;

    const card = this.board?.cards.find((item) => item.id === cardId);
    if (!card || card.type !== 'image' || card.content.path.length === 0) return null;

    const image = this.cardLayer?.contentElementOf(cardId)?.querySelector('img') ?? null;
    // 图还没加载完（`naturalWidth` 为 0）时没有像素可取：当作"这里没有图"，
    // 而不是报"取色失败" —— 用户看到的确实还是一块空框
    if (!image || image.naturalWidth <= 0 || image.naturalHeight <= 0) return null;

    return { cardId, path: card.content.path, image, fit: card.content.fit };
  }

  /**
   * 取到的颜色写进色卡（T3.05 / `O19`）：**替换**，不是追加。
   *
   * ★ `O19` 之前这里是 `[...colors, color]`（一卡多格，一行一行往下加）。一张色卡现在
   *   就是一块颜色，吸管吸到的色只能是**这张卡的颜色**本身 —— 再往下加一格，用户看到的是
   *   "卡面还是上一个色，文件里却悄悄多了一格"（`05` 的验收标准：再次取色是替换而非并排第二格）。
   * ★ 判重的口径跟着变：只有"这张卡本来就是这一个色"才算重复（那种情况下写下去
   *   只是白白递增一次 revision、把文件标脏）。旧的多格卡里那些**非第一格**的颜色
   *   不算重复 —— 吸到它是有意义的一步：它会成为新的第一格，也就是卡面。
   *   但仍然要出声：静默无反应会让用户以为没取到，然后再点一遍同一格。
   */
  private applyPickedColor(swatchId: string, color: HexColor, path: string): void {
    const card = this.board?.cards.find((item) => item.id === swatchId);
    if (!card || card.type !== 'swatch') return;

    const next = swatchColorsAfterPick(card.content, color);
    if (next === null) {
      new Notice(t('notice.swatchDuplicate', { color }));
      return;
    }

    // `pickedFrom` 记下这一笔是从哪张图吸来的（`03 §2.7`）：
    // 色卡常和参考图一起用，想回原图核对时少了它就得靠记忆翻文件
    this.updateCardContent(swatchId, { colors: next, pickedFrom: path });
    new Notice(t('notice.swatchPicked', { color }));
  }

  // ── 手绘（T3.06 / `F4-01`、`F4-03`）─────────────────────
  //
  // 视图是这套交互的**唯一**协调者：笔迹要画在卡片之上、指针要在卡片之前拦下来，
  // 这两件事都跨出了卡片定义的边界（一张卡片只知道自己那块 DOM）。
  // 真正干活的是 `InkLayer`（画）与 `InkController`（收指针），这里只给命令层提供入口。

  /** 能不能手绘：只读白板不行，图层还没就绪也不行 */
  get canDrawInk(): boolean {
    // 演示态（J-06）不给进手绘：`D` / `E` 是**光秃秃的单键**（见 `commands.ts`），
    // 讲的时候无意识敲一下就进画笔画，观众那边看到的是"画面突然多了条线"
    return !this.isReadOnly() && this.inkLayer !== null && !this.presentation?.active;
  }

  /** 是否正在手绘态（`V` 命令靠它决定出不出现） */
  get isInking(): boolean {
    return this.inkController?.isActive === true;
  }

  /**
   * 板上有没有手绘（`⌘⇧⌫` 靠它决定出不出现）。
   *
   * ★ T3.08 之后笔迹 = `ink` 卡片，所以问的是**模型**而不是图层 ——
   *   图层只画进行中的那一笔，问它"有没有笔迹"永远是 `false`。
   */
  get hasInkStrokes(): boolean {
    return this.board?.cards.some((card) => card.type === 'ink') === true;
  }

  /**
   * 进入手绘（`D` 画笔 / `E` 橡皮）。进不去时说一句人话，而不是静默失效。
   *
   * 返回是否真的进去了：命令层不看返回值（它们本来就只在可用时出现），
   * 但卡片定义需要它（T3.09 图片卡双击 —— 进了才敢返回"这次双击我接管了"）。
   */
  startInk(tool: InkTool): boolean {
    // 卡片正在编辑时先退出编辑态：`EDITING → INK` 会被状态机拒绝（`03 §5` 星型图），
    // 而用户的意图很明确 —— 他都按了 `D`，就是要画，没道理要他自己先按一次 Esc。
    // ★ 走 `leaveEditMode()`：与"点了别的卡片"同一条路，编辑器按既有约定提交内容，
    //   不会把用户刚敲的字悄悄吞掉
    if (this.pointerState.is('EDITING')) this.leaveEditMode();

    if (this.inkController?.enter(tool) === true) return true;
    // 走到这里只剩"只读"这一个可解释的原因（图层未就绪时命令本身就不会出现）
    if (this.isReadOnly()) new Notice(t('notice.inkReadOnly'));
    return false;
  }

  /**
   * 退出手绘（`V` / `Esc`）。
   *
   * ★ 笔迹**留着**：退出的是"手里拿着笔"这件事，不是画过的内容。
   *   顺手清掉等于"按一下 V 就丢掉全部手绘" —— 那是灾难性的误解。
   */
  stopInk(): void {
    this.inkController?.exit();
  }

  /**
   * 清空手绘（`⌘⇧⌫`）：删掉板上**全部** `ink` 卡片。
   *
   * ★ 一次 `commit` 收掉所有手绘 = 撤销一步就能全拿回来，这正是 T3.08 要的"参与撤销"。
   * ★ 清完仍出声：这一步把画了几分钟的内容一次性收走，光靠撤销栈默默兜底不够 ——
   *   用户得知道刚才那一下干了什么。
   * ★ 有临时标注时**先清那一层**（T7.07）：`02 §4.1` 把这个键定给「清空临时标注」，
   *   而它同时是 T3.08 留下的"清空手绘"入口。两层都在时先清临时的那层 ——
   *   它不落盘、清掉零代价，而且正是用户此刻眼睛盯着的那一层。
   */
  clearInk(): void {
    if (this.clearAnnotation() > 0) return;

    const ids = (this.board?.cards ?? [])
      .filter((card) => card.type === 'ink')
      .map((card) => card.id);
    if (ids.length === 0) return;
    this.commit(t('history.inkClear'), (board) => removeCards(board, ids));
    new Notice(t('notice.inkCleared'));
  }

  /**
   * 清空临时标注层（工具条上的 ✕ / `⌘⇧⌫`）。返回清掉了几笔。
   *
   * ★ 它**不退出**手绘态：用户想的是"擦干净接着画"，不是"收工"。
   *   `Esc` 那条路才是"清空**并且**收工"—— 那一半挂在 `InkController.teardownMode` 上，
   *   两条路合起来正好覆盖「`Esc` 一键清空」与"清了还想接着画"两种意图。
   * ★ 清的是**不落盘**的那一层，所以这一步不进撤销栈（没有模型改动可退）。
   */
  clearAnnotation(): number {
    const cleared = this.inkController?.clearTransient() ?? 0;
    // 没东西可清就闭嘴：工具条的按钮本来就点不动，命令也只在有时才出现
    if (cleared === 0) return 0;
    new Notice(t('notice.inkAnnotationsCleared'));
    return cleared;
  }

  /**
   * `⌘⇧A`：临时标注的开关（T7.07）。
   *
   * ★ 再按一次 = 退出手绘：临时标注是"快速示意"，第二下意味着用户已经示意完了 ——
   *   按意图猜，他想收工（顺带清空，见 `InkLayer.clearTransient`），
   *   而不是"换回画笔继续画"。
   */
  toggleInkAnnotate(): void {
    if (this.isAnnotating) this.stopInk();
    else this.startInk('annotate');
  }

  /**
   * 抬笔落盘（T3.08）：一笔 → 一张 `ink` 卡片。
   *
   * ★ 落在**同步**的这一帧里（由 `InkLayer.endStroke` 直接调用）：图层紧接着就清掉
   *   画布上那一笔，卡片必须已经挂在那儿，否则会闪一帧空的。
   * ★ 不进选中态：连着画十笔，每一下都跳出选框把笔迹框住，画布会一直在抖。
   *   想编辑某一笔，画完再点它（命中区见 `cards/ink.ts`）。
   * ★ 每一笔单独一步撤销：`⌘Z` 就是"撤销我刚画的那一笔"，正合手感；
   *   想一次收掉整块手绘，用 `⌘⇧⌫`（`clearInk`）。
   */
  private persistInkStroke(path: InkPath): void {
    if (this.isReadOnly()) return;
    const card = inkCardFromStroke(path);
    // 一个点都没有的笔画不落盘（`inkCardFromStroke` 对空笔画也会返回 `null`）
    if (!card) return;
    this.commit(t('history.inkDraw'), (board) => addCards(board, [card]));
  }

  /**
   * 橡皮（T3.06 的语义）：擦掉经过 `point` 的笔迹 —— 现在是删掉对应的 `ink` 卡片。
   *
   * ★ 命中在 `cards/ink.ts`（那里才知道"卡片内坐标 ↔ 世界坐标"怎么换算）。
   * ★ `mergeKey`：拖着橡皮走时每个 `pointermove` 都擦一次，不给合并键的话
   *   一次拖动会在撤销栈里留下几十条"擦掉一笔"，`⌘Z` 得像缝纫机一样按。
   */
  private eraseInkAt(point: Point, radius: number): number {
    if (this.isReadOnly()) return 0;
    const board = this.board;
    if (!board) return 0;

    const ids: string[] = [];
    for (const card of board.cards) {
      if (card.type !== 'ink') continue;
      if (inkCardStrokeHits(card, point, radius).length > 0) ids.push(card.id);
    }
    if (ids.length === 0) return 0;

    const erased = ids.length;
    this.commit(t('history.inkErase'), (draft) => removeCards(draft, ids), 'ink-erase');
    return erased;
  }

  /**
   * 改一张手绘卡的颜色（右键菜单「笔迹颜色」，T3.08 的"可改色"）。
   *
   * ★ 改的是**内容**（`content.paths[i].color`）而不是卡片的 `accent`：
   *   笔迹的颜色是它自己的属性，而卡片背景色对一张没有背景的手绘卡毫无意义。
   * ★ `recolorPaths` 没变化时返回 `null`，据此不提交：反复点同一个颜色
   *   不该在撤销栈里堆一串"什么都没变"。
   */
  private recolorInkCard(cardId: string): void {
    if (this.isReadOnly()) return;
    const card = this.board?.cards.find((item) => item.id === cardId);
    if (!card || card.type !== 'ink' || card.locked) return;

    // 预置色板取这笔自己的颜色（用户想调的是"现在这个色"，不是"上次用的笔色"）
    const current = card.content.paths.find((path) => path.points.length > 0)?.color;
    pickColor(this.app, current ?? this.inkToolState.color, (color) => {
      this.commit(t('history.inkColor'), (board) => {
        const target = board.cards.find((item) => item.id === cardId);
        if (!target || target.type !== 'ink') return false;
        const paths = recolorPaths(target.content.paths, color);
        if (!paths) return false;
        target.content = { ...target.content, paths };
        return true;
      });
    });
  }

  /** 当前笔的样式状态（工具条靠它高亮；控制器还没建出来时给一份默认值） */
  get inkToolState(): InkToolState {
    return this.inkController?.toolState ?? defaultInkToolState();
  }

  /** 手里拿的是哪支笔（工具条靠它高亮；控制器还没建出来时当画笔） */
  get inkTool(): InkTool {
    return this.inkController?.tool ?? 'brush';
  }

  /** 是不是正拿着临时标注笔（`⌘⇧A` 的开关方向问这里） */
  get isAnnotating(): boolean {
    return this.isInking && this.inkTool === 'annotate';
  }

  /**
   * 临时标注层里现在有几笔（工具条「清空」的可用性与 `⌘⇧⌫` 的可用性问这里）。
   *
   * ★ 它只可能非零于**手绘态内**：那一层的生命周期长在手绘态上
   *   （见 `InkController.teardownMode`），退了手绘它一定已经空了。
   */
  get annotationCount(): number {
    return this.inkController?.annotationCount ?? 0;
  }

  /**
   * 选一支笔色（调色板 / 取色器 / `ink-color` 命令）。
   *
   * ★ 只影响**之后**画的笔画：笔迹各自存着自己的颜色（`InkPath.color`）。
   *   改已画好的笔迹颜色是 T3.08「笔画可编辑」的事 —— 两者共用同一个入口只会打架。
   */
  setInkColor(color: HexColor): void {
    this.inkController?.setColor(color);
    // 工具条自己不会知道状态变了（它是被动的），所以每次改完主动重画一次高亮
    this.inkBar?.render();
  }

  /** `X`：在当前色与"上一支"之间来回换 */
  swapInkColors(): void {
    this.inkController?.swapColors();
    this.inkBar?.render();
  }

  /** `1`–`4` / 工具条：换笔宽档位 */
  setInkWidth(index: number): void {
    this.inkController?.setWidthIndex(index);
    this.inkBar?.render();
  }

  /** 弹系统取色器（工具条的「自定义…」与 `ink-color` 命令）。取消则什么都不发生 */
  pickInkColor(): void {
    pickColor(this.app, this.inkToolState.color, (color) => this.setInkColor(color));
  }

  /**
   * 进入 / 换一支笔。
   *
   * 工具条只在**能调的笔**下显示：橡皮没有颜色与笔宽可调，一条点不动的工具条比没有更糟。
   * 画笔 / 荧光笔 / 临时标注三支共用一个调色板与一排笔宽，所以它们都带着工具条；
   * 切到橡皮时隐藏、切回来时带着上次的颜色与档位（状态存在 `InkController` 里）。
   */
  private onInkEnter(tool: InkTool): void {
    // 换支笔要说清楚"现在拿的是什么"：荧光笔与画笔长得像、临时标注更是画完才知道差别，
    // 而工具条只在**已经知道去哪看**的人眼里才是提示（见 `InkBar` 文件头）
    const key: MessageKey =
      tool === 'eraser'
        ? 'notice.inkEraser'
        : tool === 'marker'
          ? 'notice.inkMarker'
          : tool === 'annotate'
            ? 'notice.inkAnnotate'
            : 'notice.inkBrush';
    new Notice(t(key));
    // 先 render 再显隐：显示的那一帧就已经是高亮正确的状态，不会闪一下默认笔
    this.inkBar?.render();
    this.inkBar?.setVisible(tool !== 'eraser');
  }

  /**
   * 菜单里的"裁剪图片"（T2.02 / `F2-3-3`）。
   *
   * ★ 对话框只拿一个**已解析的 URL + 当前 crop**：它不碰 Vault、不写文件，
   *   结果回来之后才由本视图提交一次 `commit` —— 于是"撤销裁剪"就是把四个数
   *   换回去，而原图文件在整个过程中一个字节都没动。
   */
  /**
   * 图片卡：**显示 / 隐藏边框与底色**（用户 2026-09-17："取消边框实际上是把图片卡的
   * 背景和边框都隐藏掉"）。
   *
   * ★ 写的是可选字段的**缺省态**：`false` = 关掉；**删掉这个键** = 回到"有边框"。
   *   与 `collapsed` 同一条纪律（文件里看不见那个键就是默认态），于是"开关关掉再打开"
   *   写回去的文件与从没动过的一模一样。
   */
  private toggleCardBorderCard(cardId: string): void {
    this.commit(t('history.toggleCardBorder'), (board) => {
      const card = board.cards.find((item) => item.id === cardId);
      if (!card || card.locked) return false;
      if (card.showBorder === false) delete card.showBorder;
      else card.showBorder = false;
      return true;
    });
  }

  /**
   * 链接卡：完整卡 ⇄ 迷你书签（`A8`，用户 2026-09-18："链接卡迷你样式"）。
   *
   * ★ 内容（`style`）与**尺寸**在**同一次** `commit` 里改：分两次写的话，用户按一次
   *   `⌘Z` 只会退回一半（尺寸回去了、样式还留着，或者反过来）—— 那是最难解释的一种撤销。
   * ★ 尺寸只在换档时给默认值：这是这一档的语义（"书签"与"卡片"本来就不是一个形状），
   *   用户之后自己拉过的大小在下一次换档时会被覆盖一次 —— 想保留就只换一次。
   * ★ 默认那档**不写进文件**（`delete`）：与 `siteName` / `rotation` 同一条约定，
   *   于是"换回来"之后 `.nboard` 与从没换过的卡片逐字节一样。
   */
  private toggleLinkStyleCard(cardId: string): void {
    this.commit(t('history.toggleLinkStyle'), (board) => {
      const card = board.cards.find((item) => item.id === cardId);
      if (!card || card.locked || card.type !== 'link') return false;

      const mini = card.content.style === 'mini';
      if (mini) delete card.content.style;
      else card.content.style = 'mini';

      const size = mini ? LINK_DEFAULT_SIZE : LINK_MINI_SIZE;
      card.width = size.width;
      card.height = size.height;
      return true;
    });
  }

  private cropImageCard(cardId: string): void {
    if (this.isReadOnly()) return;
    const card = this.board?.cards.find((item) => item.id === cardId);
    if (!card || card.type !== 'image' || card.locked) return;

    const { path, crop } = card.content;
    const url = path ? (this.notesBridge?.resourceUrl(path) ?? null) : null;
    // 文件不在了：菜单项已经置灰，这里再兜一层 —— 宁可不弹，也不要弹出一块空白预览
    if (!url) return;

    new CropImageModal(this.app, url, crop, (next) => {
      this.commit(t('history.crop'), (board) => {
        const target = board.cards.find((item) => item.id === cardId);
        if (!target || target.type !== 'image') return false;
        // 又拖回原样 = 没改：不写盘，也不在历史里留一条假的"裁剪"记录
        if (cropEquals(target.content.crop, next)) return false;
        target.content = { ...target.content, crop: next };
        return true;
      });
    }).open();
  }

  /**
   * 右键「选择地图图片」：给已有地图卡换一张图（T7.03 / `F2.9`）。
   *
   * ★ 换图**保留图钉**（只改写 `path`）：用户多半是拿同一片区域的另一版来替
   *   （换分辨率、换一种标注样式的导出图），顺手把图钉清掉是净损失。
   * ★ 与 `cropImageCard` 同一条路：选择器只问"要哪一份"，答案回来之后才提交一次
   *   `commit` —— 于是"换错了图"按 `⌘Z` 就能换回去。
   */
  private pickMapImage(cardId: string): void {
    if (this.isReadOnly()) return;
    const card = this.board?.cards.find((item) => item.id === cardId);
    if (!card || card.type !== 'map' || card.locked) return;

    new VaultFilePickerModal(this.app, [...IMAGE_EXTENSIONS], (path) => {
      if (path === null) return; // 取消：他什么都没要求，不必给提示
      this.commit(t('history.pickMapImage'), (board) => {
        const target = board.cards.find((item) => item.id === cardId);
        if (!target || target.type !== 'map') return false;
        // 选了同一张 = 没改：不写盘，也不在历史里留一条假的"换图"记录
        if (target.content.path === path) return false;
        target.content = { ...target.content, path };
        return true;
      });
    }).open();
  }

  /**
   * 右键「粘贴地图链接」（`O08`）：把一条地图分享链接变成卡上的坐标（顺带可能是一张图）。
   *
   * 三段路，每段都能单独失败，但**都不需要用户重来**：
   *  1. 读剪贴板（`ClipboardBridge.readText`）—— 读不到（移动端常常如此）就弹输入框，
   *     让用户自己粘一次；
   *  2. 解析（`parseMapLink`）—— 认不出就把**读到的那段原文**预填进输入框，
   *     让用户看着改（多半是复制时多带了几个字）；
   *  3. 认出来了：先落一次 `commit` 存下 `sourceUrl` / `coords` / 地点名，再看用户
   *     有没有配静态图服务 —— 配了就下载一张图，成功后再落一次 `commit` 补上 `path`。
   *
   * ★ 第 3 段里**两次 `commit` 不合并**：下载可能要几百毫秒，期间用户看到的应当是
   *   "链接已经存下了"。攒成一次的话，按下去那几秒里卡片还是空的，用户会以为没反应
   *   又点一次 —— 而第二次会把第一次的结果覆盖掉。
   * ★ 也正因如此，取图那一步**失败不影响**上一步的成果：未启用 / 没网 / 服务商回错，
   *   卡片照样是一条可用的信息（见 `cards/map.ts` 的 `renderFallback`）。
   *
   * @returns 有没有真的在卡上落下一份可用信息（链接 / 坐标）。`O17` 的新建入口靠它
   *   决定"用户什么都没粘时要不要把刚落的空卡撤掉"；右键菜单那条路不看返回值。
   */
  private async pasteMapLink(cardId: string): Promise<boolean> {
    if (this.isReadOnly()) return false;
    const card = this.board?.cards.find((item) => item.id === cardId);
    if (!card || card.type !== 'map' || card.locked) return false;

    const fromClipboard = await this.clipboardBridge.readText();
    // 读不到剪贴板是**正常路径**（权限、失焦、移动端），不是错误 ——
    // 这时直接问用户要，而不是弹一句"读不到剪贴板"再让他自己去菜单里找输入框
    if (fromClipboard === null) {
      return this.askMapLink(cardId, '');
    }
    return this.applyMapLink(cardId, fromClipboard);
  }

  /**
   * 问用户要一条地图链接（`O08`）：读不到剪贴板时的退路，也是"粘进来的东西认不出"时的退路。
   *
   * @param initial 预填进输入框的内容。★ 认不出时传**原文** —— 让用户看见插件手上
   *   到底拿到了什么，比只回一句"认不出来"有用得多。
   * @returns 用户填的这一条有没有落到卡上（取消 = `false`，`O17` 的新建入口据此撤空卡）
   */
  private askMapLink(cardId: string, initial: string): Promise<boolean> {
    return new Promise((resolve) => {
      new LinkPromptModal(
        this.app,
        (text) => {
          // 取消：他什么都没要求，不必给提示（与 `pickMapImage` 同一条约定）
          if (text === null) {
            resolve(false);
            return;
          }
          void this.applyMapLink(cardId, text).then(resolve);
        },
        {
          title: t('modal.mapLink.title'),
          name: t('modal.mapLink.name'),
          desc: t('modal.mapLink.desc'),
          confirm: t('modal.mapLink.confirm'),
          initial,
        },
      ).open();
    });
  }

  /**
   * 把一段"应该是一条地图链接"的文字落到卡片上（`O08`）。
   *
   * ★ 顺手把 `sourceUrl` 存成**原文**而不是解析结果：解析认不出来（短链、新形态）时，
   *   用户看得见自己粘的是什么，也就知道该换成哪一条（见 `MapContent.sourceUrl`）。
   * ★ 地点名只在卡片**自己还没有名字**时才填：用户手写过的那一个永远比链接里的可信。
   *
   * @returns 链接（以及可能有的坐标 / 地点名）有没有落上卡。**取图失败也算 `true`** ——
   *   链接已经存下了，那张图只是附赠（`O17` 的新建入口据此判断"要不要撤掉空卡"）。
   */
  private async applyMapLink(cardId: string, text: string): Promise<boolean> {
    const raw = text.trim();
    const card = this.board?.cards.find((item) => item.id === cardId);
    if (!card || card.type !== 'map' || card.locked || raw.length === 0) return false;

    const link = parseMapLink(raw);
    if (link === null) {
      new Notice(t('notice.mapLinkUnknown'));
      return this.askMapLink(cardId, raw);
    }

    // 一次 commit 落三样：原文、经纬度、可能有的地点名 ——
    // 它们来自同一次粘贴，分开提交会让 ⌘Z 一次只退掉一部分
    this.commit(t('history.mapLink'), (board) => {
      const target = board.cards.find((item) => item.id === cardId);
      if (!target || target.type !== 'map') return false;
      const label = target.content.label.length > 0 ? target.content.label : link.label;
      target.content = {
        ...target.content,
        label,
        sourceUrl: raw,
        coords: { lat: link.lat, lon: link.lon },
      };
      return true;
    });

    const path = await this.fetchMapTile(cardId, link);
    if (path !== null) {
      // 图到手：另一次 commit 只补 `path`（第二次粘贴到同一张卡上时，
      // 上面那次已经把 `sourceUrl` 换成新的了，这里不再动它）
      this.commit(t('history.mapLink'), (board) => {
        const target = board.cards.find((item) => item.id === cardId);
        if (!target || target.type !== 'map') return false;
        target.content = { ...target.content, path };
        return true;
      });
      new Notice(t('notice.mapLinkFetched'));
      return true;
    }

    // 没取到图：区分"没配服务"（用户能去配）与"取图失败"（可以再试），
    // 这两句话的下一步动作完全不同，合并成一句等于让用户自己猜
    new Notice(
      this.mapTileBridge?.enabled === true
        ? t('notice.mapLinkFetchFailed')
        : t('notice.mapLinkSaved'),
    );
    return true;
  }

  /**
   * 去要一张静态地图并把附件路径拿回来（`O08`）。拿不到一律返回 `null`，
   * 调用方按"没图但有链接"降级 —— **这里不弹任何提示**，措辞归调用方决定。
   *
   * ★ 尺寸取卡片的**实际宽高 × 设备像素比**：静态图服务按像素出图，
   *   要一张 1:1 的图放到 2x 屏上会糊。上限由 `staticMapRequest` 按各家
   *   的规矩夹一次（这里只管"要多大"）。
   * ★ 附件名用坐标而不是地点名：地点名是**用户可编辑**的自由文本，
   *   里面可能有 `/`、`:` 这些在文件名里有别的意思的字符；坐标是纯数字，
   *   永远安全，而且它就是这张图的唯一身份。
   */
  private async fetchMapTile(cardId: string, link: MapLink): Promise<string | null> {
    const bridge = this.mapTileBridge;
    if (bridge === null || !bridge.enabled) return null;

    // 尺寸跟着**当前**卡片走（不是调用方传进来的快照）：请求要几百毫秒，
    // 期间用户可能已经把卡片拉大了 —— 按最新尺寸要图，回来时就不会明显糊
    const card = this.board?.cards.find((item) => item.id === cardId);
    const dpr = this.canvasEl?.ownerDocument.defaultView?.devicePixelRatio ?? 1;
    // 上限 4：Retina 之上再乘只是白要一张更大的图，而各家的尺寸上限
    // 由 `staticMapRequest` 自己夹（这里只管"要多大"）
    const scale = Math.min(Math.max(dpr, 1), 4);
    const width = Math.round((card?.width ?? 480) * scale);
    const height = Math.round((card?.height ?? 320) * scale);

    const request = staticMapRequest(link, {
      provider: this.plugin.settings.mapTileProvider,
      key: this.plugin.settings.mapTileKey,
      width,
      height,
    });
    if (request === null) return null;

    return await bridge.fetch(request, `${t('card.type.map')}-${coordsText(link.lat, link.lon)}`);
  }

  /** 右键「打开链接」（`O08`）：用系统浏览器打开卡上记着的地址 */
  private openMapLink(cardId: string): void {
    const card = this.board?.cards.find((item) => item.id === cardId);
    if (!card || card.type !== 'map') return;
    // 可选的键：从没贴过链接的卡上它**根本不存在**（见 `normalizeMapContent`）
    const url = card.content.sourceUrl ?? '';
    if (url.length === 0) return;
    void this.linkPreviewBridge?.openExternal(url);
  }

  /**
   * 从右键菜单抓一次链接预览（T2.05 / `F2-4-3`）。
   *
   * ★ 与卡片上的那个按钮**共用** `cards/link.ts` 的 `fetchLinkPreview`：两处各写
   *   一遍抓取流程，迟早会出现"按钮能抓、菜单抓不了"或"菜单落了盘、按钮没落"
   *   这类互相矛盾的现场。
   * ★ 菜单这条路拿不到卡片的 DOM（卡片可能压根没渲染），所以反馈只能靠 Notice；
   *   按钮那条路靠改自己的文案。两条路共用的只是**抓取**这一半。
   */
  private async fetchLinkPreviewCard(cardId: string): Promise<void> {
    const card = this.board?.cards.find((item) => item.id === cardId);
    if (!card || card.type !== 'link') return;

    const result = await fetchLinkPreview(card.content, {
      links: this.linkPreviewBridge ?? undefined,
      updateContent: (patch) => this.updateCardContent(cardId, patch),
      contentReady: () => this.cardLayer?.remeasure(cardId),
    });

    if (result === 'ok') new Notice(t('notice.linkFetched'));
    else if (result === 'failed') new Notice(t('notice.linkFetchFailed'));
    else if (result === 'blocked') new Notice(t('notice.linkBlocked'));
    else if (result === 'disabled') new Notice(t('notice.linkPreviewDisabled'));
  }

  // ── 待办总览浮层（T3.03 / `F2.5`）─────────────────────────

  /** 没有打开白板时浮层无处可聚合，命令应当藏起来（`available` 用它） */
  get canShowTodoOverview(): boolean {
    return this.board !== null;
  }

  /**
   * 命令入口：切换浮层显隐（T3.03）。
   *
   * ★ 只读板**允许**打开：这是只读操作（看清单不改文件），而"上手别人的板子先看
   *   还剩什么没做"正是只读场景的典型需求。能不能勾由面板自己按 `canToggle` 决定。
   */
  toggleTodoOverview(): void {
    this.todoOverview?.toggle();
  }

  // ── 卡片过滤 / 断链总览 / 复制为 Markdown（T3.17–T3.20）──────

  /**
   * 命令入口：切换画布过滤条显隐（T3.17 / T3.18）。
   *
   * ★ 关闭时**顺手清掉过滤条件**：过滤条藏起来之后，画布上那些变淡的卡片
   *   就没有任何"为什么是淡的"的线索了 —— 用户会以为白板坏了。
   */
  toggleCardFilter(): void {
    const bar = this.filterBar;
    if (!bar) return;
    if (bar.isOpen) {
      bar.close();
      this.applyCardFilter(NO_FILTER);
      new Notice(t('notice.filterCleared'));
      return;
    }
    // 打开时才重算断链：过滤条上的"只看断链"要用它
    this.refreshBrokenRefs();
    bar.show();
    this.syncCardFilter();
  }

  /** 过滤条件变化：更新状态并把结果同步到卡片外观（过滤条自己回填控件） */
  private applyCardFilter(filter: CardFilter): void {
    const wasOnlyBroken = this.cardFilter.onlyBroken;
    this.cardFilter = filter;
    // 刚勾上"只看断链"却一条都没有：解释一句，免得用户以为过滤坏了
    if (filter.onlyBroken && !wasOnlyBroken && this.brokenRefs.length === 0) {
      new Notice(t('notice.noBrokenLinks'));
    }
    this.syncCardFilter();
  }

  /**
   * 把过滤结果同步到卡片层（T3.17 / T3.18）。
   *
   * 编组外观（T3.14）也在这里一并刷新：两者都是"内容之外、需要逐卡改 class"的状态，
   * 共用同一个咽喉点可以少一次遍历（见 `CardLayer.setDimmed` / `setGrouped`）。
   */
  private syncCardFilter(): void {
    const board = this.board;
    const layer = this.cardLayer;
    if (!board || !layer) {
      this.filterBar?.refresh();
      return;
    }
    layer.setDimmed(filteredOutIds(board, this.cardFilter, (id) => this.brokenCardIds.has(id)));
    // 脑图节点也参与过滤（`2.2.0` 批 4）：**按节点**变淡（不是整棵），且**只认文本维度**
    //（节点没有类型 / 链接，见 `dimmedMindNodeKeys` 的两条口径）。
    // ★ 模型来源与搜索面板 / 缩略图同一个（`mindModelForMap` 是只读那一份）：
    //   读不到 `.nestmind` 的那一棵不参与（宁可少过滤一棵，也不在这层同步等读盘）。
    this.mindLayer?.setDimmed(
      dimmedMindNodeKeys(board, this.cardFilter, (mind) => this.mindModelForMap(mind)),
    );
    layer.setGrouped(groupedCardIdsOf(board));
    this.filterBar?.refresh();
  }

  /**
   * 屏幕上**不存在**的卡片：收起编组的成员（O03）+ **收起分栏**的成员（`O16`）。
   *
   * ★ 分栏的收起原本只改自己那 40px 的渲染高度（`columnDisplayHeight`），而栏内卡片是
   *   栏元素的**兄弟节点**、由 `CardLayer` 统一渲染 —— 卡片层根本不知道 `column.collapsed`，
   *   于是"收起"之后一栏卡片照旧浮在画布上。这一份集合就是把这件事补齐的地方。
   * ★ 只在**视图层**叠加，不动 `ops.collapsedCardIds`：那个函数还被 `visibleCardsInColumn`
   *   / `layoutRects` / `measureColumns` 用着（栏内堆叠与张数徽标），把分栏成员也算进去
   *   会让栏内所有卡叠在同一个 y（见 `layoutRects` 的注释）—— 排版语义得留在原处。
   * ★ 折叠栏成员的**几何保持不动**（`layoutColumn` 照旧按 order 重排，只是看不见），
   *   展开时原样回来，位置不会错乱。
   * ★ 两份判据各归一处在模型层算（`ops.collapsedCardIds` + `columns.collapsedColumnCardIds`），
   *   这里只做并集 —— 这一层不该自己扫一遍卡片。
   */
  private hiddenCardIds(board: BoardFile): Set<string> {
    const hidden = collapsedCardIds(board);
    for (const id of collapsedColumnCardIds(board)) hidden.add(id);
    // 树折叠（`F7`）：折叠父卡 ⇒ 整棵子树藏起来（父卡留着显示 +N）。
    // 判据照旧只有模型层一份 —— 连线 / 框选 / 命中问的是同一个问题。
    for (const id of collapsedTreeCardIds(board)) hidden.add(id);
    return hidden;
  }

  /**
   * 把"屏幕上不存在的卡片"推给卡片层（O03 / `O16`）。
   *
   * ★ 必须在 `syncCanvas()` **之前**调用：`setHidden` 只标脏，真正的取舍发生在
   *   下一次裁剪里 —— 晚一步就是"收起的分组先闪出半帧、再消失"。
   * ★ 判据只有一份（`hiddenCardIds`）：连线、框选、命中问的是同一个问题。
   */
  private syncHiddenCards(): void {
    const board = this.board;
    if (!board) return;
    this.cardLayer?.setHidden(this.hiddenCardIds(board));
  }

  /**
   * 参与框选 / 全选的卡片 = 全部卡片 − **屏幕上不存在的**（收起编组的成员 O03、
   * 收起分栏的成员 `O16`）。
   *
   * ★ 藏起来的卡片在屏幕上根本不存在（卡片层没挂载它们），能选中却看不见，
   *   会让"框一下再按 Delete"删掉一屏看不见的东西。
   * ★ 没有任何隐藏时**原样返回 `board.cards`**（不复制）：这是绝大多数情况，
   *   而 `getCards` 在框选期间每个 `pointermove` 都会被叫一次。
   */
  private selectableCards(): Card[] {
    const board = this.board;
    if (!board) return [];
    const hidden = this.hiddenCardIds(board);
    if (hidden.size === 0) return board.cards;
    return board.cards.filter((card) => !hidden.has(card.id));
  }

  /**
   * 给连线层用的板子：把屏幕上不存在的卡片摘掉（收起编组的成员 O03、
   * 收起分栏的成员 `O16`）。
   *
   * ★ 只摘 `cards`，不摘 `edges`：端点取不到矩形的连线由 `edgePolyline` 自己
   *   返回 `null`（绘制、命中、框选三条路共用这一个判据），这里再过滤一遍
   *   等于多出第二份"哪条线不该出现"的账本。
   * ★ 没有任何隐藏时**原样返回同一个对象**：静态板（绝大多数）不该为此每帧
   *   多产生一个对象，而且引用不变也让下游的比较短路。
   */
  private boardForEdges(): BoardFile | null {
    const board = this.board;
    if (!board) return null;
    const hidden = this.hiddenCardIds(board);
    if (hidden.size === 0) return board;
    return { ...board, cards: board.cards.filter((card) => !hidden.has(card.id)) };
  }

  /**
   * 同步编组框（O03）：挂在 `syncCanvas` 与拖动预览这两条必经路径上。
   *
   * ★ 几何**每帧现算**，不留缓存：成员可以是"拖动预览中的临时位置"
   *   （那一刻模型一个字段都没动），只有从视觉几何重算才对得上屏幕上看到的东西。
   * ★ 先建一张 id → 卡片的表：按 `cardIds` 逐个 `cards.find` 是
   *   `O(组数 × 成员数 × 卡片数)`，1000 张卡的白板上每帧就是几十万次比较。
   */
  private syncGroupLayer(): void {
    const board = this.board;
    const layer = this.groupLayer;
    if (!board || !layer) return;
    const overrides = this.visualOverrides();
    const byId = new Map<string, Card>();
    for (const card of board.cards) byId.set(card.id, card);
    // ★ 解析函数要认**两类成员**（用户 2026-09-16：分栏也能被编进组）：先当卡片找、
    //   再当分栏找 —— 分栏走 `visualColumnRectOf`（与连线端点同一份：收起态的高度、
    //   拖动中的临时矩形都在那一处收口，这里再算一遍迟早分叉）
    layer.sync(board.groups, (memberId) => {
      const card = byId.get(memberId);
      if (card) {
        const rect = overrides?.get(memberId) ?? this.visualRectOf(card);
        const angle = card.rotation ?? 0;
        // 转过的卡片按**外接框**算（与框选同一套判据）：成员转 45° 时，
        // 框若不跟着放大，卡片会从框里探出去一个角
        return angle === 0 ? rect : rotatedBoundsOf(rect, angle);
      }
      const column = columnById(board, memberId);
      return column ? this.visualColumnRectOf(column) : null;
    });
  }

  /**
   * 命令入口：切换断链总览浮层（T3.19 / `F8-07`）。
   *
   * ★ 一条断链都没有时**给提示而不是打开空浮层**：空浮层只说"没有失效引用"，
   *   与直接弹一句提示的信息量一样，却多占了一块屏幕。浮层的空态留给
   *   "开着的时候用户把断链修好了"这种真实场景（那时面板已经在屏幕上了）。
   */
  toggleLinkOverview(): void {
    if (this.linkOverview?.isOpen) {
      this.linkOverview.close();
      return;
    }
    this.refreshBrokenRefs();
    if (this.brokenRefs.length === 0) {
      new Notice(t('notice.noBrokenLinks'));
      return;
    }
    this.linkOverview?.show();
  }

  /**
   * 重算断链清单（T3.19）。
   *
   * ★ 判定走 `VaultIO.isFile`（同步）：`refExistsInVault` 对 URL 类引用用纯本地校验、
   *   对路径类引用查 Vault 索引 —— 两条都不需要异步，所以这里没有 async。
   *   放在内容变化之后同步跑，过滤与总览拿到的是**同一帧**的事实。
   */
  private refreshBrokenRefs(): void {
    const board = this.board;
    if (!board) {
      this.brokenRefs = [];
      this.brokenCardIds = new Set();
      return;
    }
    const io = this.plugin.vaultIO;
    this.brokenRefs = brokenRefsOf(board, (ref) =>
      refExistsInVault(ref, (path) => io.isFile(path)),
    );
    this.brokenCardIds = new Set(this.brokenRefs.map((ref) => ref.cardId));
  }

  /**
   * 命令可用条件：当前板有**可重连的**断链，且不是只读板（T4.07）。
   *
   * ★ 只读板不给：修复引用是写操作（`commit` 本来也会拦），让命令在面板里
   *   显示成一个点了没反应的项，比不显示更让人困惑。
   * ★ `link` 类引用不算数：URL 没有文件名，也就没有"同名文件"可谈 ——
   *   一块只有死链的板子里，"修复引用"什么也做不了。
   */
  get canRepairRefs(): boolean {
    return !this.isReadOnly() && this.brokenRefs.some((ref) => ref.kind !== 'link');
  }

  /**
   * 命令入口用：**重算**一遍断链，返回其中路径类的那些（T4.07 / `03 §9 R10`）。
   *
   * ★ 重算而不是读 `brokenRefs` 字段：命令可能从命令面板触发，而"活动视图"与
   *   "最后一次内容变化"之间隔着用户自己的操作（在别的笔记里删了个文件）。
   *   这里多扫一遍的代价是几十次同步查表，换来的是清单与此刻的库一致。
   */
  brokenVaultRefs(): CardRef[] {
    this.refreshBrokenRefs();
    return this.brokenRefs.filter((ref) => ref.kind !== 'link');
  }

  /**
   * 落地用户在对话框里勾选的修复（T4.07）。
   *
   * ★ 走 `commit`：一次修几十处路径是一个**大改动**，必须能一次 ⌘Z 退回去
   *   —— 用户如果发现自己点错了档位，唯一的出路就是撤销（重连之后的旧路径
   *   已经不在库里，靠"再修复一次"是回不去旧值的）。
   * ★ 返回**真正改掉的条数**：对话框是异步的，这期间用户可能撤销过、也可能
   *   自己重新链接过某张卡。逐条比对旧值（见 `applyRefRepairs`）之后，
   *   实际改动的条数与勾选的条数可能不同 —— 提示里要说的是前者。
   */
  repairRefs(repairs: readonly RefRepair[]): number {
    let applied = 0;
    const changed = this.commit(t('history.repairRefs'), (board) => {
      applied = applyRefRepairs(board, repairs);
      return applied > 0;
    });
    return changed ? applied : 0;
  }

  /**
   * 「修复引用」的完整流程（T4.07 / `03 §9 R10`）：问 Vault 要文件清单 → 摆清单 → 落地。
   *
   * ★ 流程留在视图里、不做成 `ui/*Actions.ts`：命令本来就拿到视图（`registerViewCommand`
   *   把 `view` 递给了 `run`），而这段流程要的是一个**具体的**视图 —— 它和"当前活动的
   *   视图"不是一回事（浮层上的按钮属于它自己那块板，哪怕焦点在别的标签页）。
   *   那几个动作层模块存在，是因为它们要在**库一级**找文件、找白板，这里没有那一层。
   * ★ 命令面板与断链总览的按钮共用这一个方法：两条入口的行为必须一模一样。
   */
  async openRefRepair(): Promise<void> {
    try {
      // ★ 先问视图再问 Vault：重算断链是同步的、几乎不花时间，而 `listAll()` 要读索引。
      //   板子上没有断链时直接给提示走人 —— 不必为一句"没有断链"去列一遍全库
      const broken = this.brokenVaultRefs();
      if (broken.length === 0) {
        new Notice(t('notice.repairRefsNone'));
        return;
      }

      // 库里**全部**文件（不是"附件目录"）：跨 Vault 迁移之后用户往往重新整理了目录结构，
      // 把范围限定在旧路径附近恰好会漏掉真正的目标
      const files = await this.plugin.vaultIO.listAll();
      const plan = planRefRepairs(broken, files);

      if (plan.suggestions.length === 0) {
        new Notice(t('notice.repairRefsUnmatched', { count: plan.unmatched.length }));
        return;
      }

      new RefRepairModal(this.app, {
        plan,
        onConfirm: (repairs) => {
          const applied = this.repairRefs(repairs);
          // ★ `applied === 0` 不是错误：对话框是异步的，用户可能在这期间撤销过、
          //   自己重新链接过，或者把板子锁上了。这时**什么都没改**才是正确结果，
          //   但要如实说一句，否则用户会以为修复生效了
          new Notice(
            applied > 0
              ? t('notice.repairRefsDone', { count: applied })
              : t('notice.repairRefsStale'),
          );
        },
      }).open();
    } catch (error) {
      new Notice(t('notice.repairRefsFailed', { message: describeError(error) }));
    }
  }

  /**
   * 命令入口：把整块白板复制为 Markdown 到剪贴板（T3.20 / `F9-08`）。
   *
   * ★ 与「导出 Markdown」共用**同一个** `exportBoardToMarkdown`：两条路的产物逐字节相同，
   *   差别只在"写文件"还是"进剪贴板"（用户可以粘进别人正在写的笔记里）。
   * ★ 只读操作：不改模型、不写盘，只读保护态下也放行。
   */
  copyMarkdownToClipboard(): void {
    const path = this.currentPath;
    const board = this.board;
    if (!path || !board) {
      new Notice(t('notice.markdownCopyEmpty'));
      return;
    }

    const result = exportBoardToMarkdown(board, this.cardRegistry, { sourcePath: path });
    if (result.exported === 0) {
      new Notice(t('notice.markdownCopyEmpty'));
      return;
    }

    void this.clipboardBridge.writeText(result.markdown).then((ok) => {
      if (!ok) {
        new Notice(t('notice.markdownCopyFailed'));
        return;
      }
      new Notice(
        result.skipped > 0
          ? t('notice.markdownCopiedSkipped', { count: result.skipped })
          : t('notice.markdownCopied'),
      );
    });
  }

  /**
   * 命令入口：把这块板的 `obsidian://` 链接复制到剪贴板（O11）。
   *
   * ★ 链接交给 `buildNestboardUri` 生成，**不自己拼字符串**：那是协议处理器
   *   解析时用的同一个函数，手写一份的话，一旦哪天参数名改了（`file` → `path`），
   *   症状是"发给别人的链接点了没反应"——而用户没有任何办法自检这件事。
   * ★ 不带 `card=`：菜单是"这块板"层级的操作。指到某一张卡的链接由卡片菜单负责
   *   （那才是"我要给别人看这一张"的地方）。
   * ★ 只读操作：不改模型、不写盘，只读保护态下也放行（一块只能看不能改的板子
   *   同样需要能被指给别人）。
   */
  copyBoardLink(): void {
    const path = this.currentPath;
    if (!path) {
      new Notice(t('notice.boardLinkUnavailable'));
      return;
    }

    void this.clipboardBridge.writeText(buildNestboardUri(path)).then((ok) => {
      new Notice(ok ? t('notice.boardLinkCopied') : t('notice.copyFailed'));
    });
  }

  /**
   * 勾掉浮层里的一条待办。
   *
   * ★ 走**卡片内勾选同一条通道**（`updateCardContent`）：同一个动作在两个入口必须
   *   产生同样的结果，否则会出现"浮层里能撤销、卡片里不能"这类诡异的不一致。
   *   落盘后 `changed → applyBoard → refresh()` 会把这一行从清单里抹掉。
   * ★ 卡片可能已经不在了（浮层开着时它被删掉 / 撤销掉）：静默返回 ——
   *   下一次 `applyBoard` 重画自然会把这一行清掉。
   */
  private completeTodoEntry(entry: OpenTodoEntry): void {
    const card = this.board?.cards.find((item) => item.id === entry.cardId);
    if (!card || card.type !== 'todo') return;
    this.updateCardContent(card.id, { items: toggleTodoItem(card.content.items, entry.index) });
  }

  /**
   * ⌘F：打开白板内搜索（T2.09 / `F8-01`）。
   *
   * ★ 搜索是**只读**操作，所以只读白板也照常打开：找东西不改文件，
   *   而"上次那个便签我放哪了"恰恰是只读板更需要回答的问题。
   */
  openSearch(state: { query: string; index: number } | null = null): void {
    // 已经开着就先关掉：两块面板叠在一起，用户得按两次 Esc 才干净
    this.closeSearch();

    const panel = new SearchPanel(this.app, {
      board: () => this.board,
      // 脑图节点的文字也要能搜（`2.2.0` 批 4）：指向 `.nestmind` 的树只有这里拿得到模型
      // ★ 用"只读"那一份（`mindModelForMap`）：搜索每敲一个字就重算一次，
      //   在那儿发读盘请求等于"打一句话翻好几次库"
      mindModelOf: (mind) => this.mindModelForMap(mind),
      onPick: (hit, index) => {
        // 每次落地都记一笔：用户一次键都没按就直接 Esc 时，进度也不至于丢
        this.lastSearch = { query: this.searchPanel?.query ?? '', index };
        if (hit.mind) this.revealMindNode(hit.mind.mindId, hit.mind.nodeId);
        else this.revealCard(hit.cardId);
      },
      onClose: (snapshot) => {
        // ★ 面板自己关掉（Esc）时视图也要放手，否则 ⌘G 会去操作一个已经关闭的面板
        if (this.searchPanel === panel) this.searchPanel = null;
        if (snapshot.query.trim().length > 0) this.lastSearch = snapshot;
      },
      initialQuery: state?.query ?? '',
      initialCursor: state?.index ?? 0,
    });

    this.searchPanel = panel;
    panel.open();
  }

  /**
   * ⌘G：跳到下一个搜索结果（T2.10）。
   *
   * 面板开着 → 交给它。已经关掉 → 用上次的词与进度**重开面板**再往下走 ——
   * 这正是浏览器查找栏的语义：Esc 只是让开视线，不是把搜索忘掉。
   */
  searchNext(): void {
    if (this.searchPanel) {
      this.searchPanel.next();
      return;
    }
    const last = this.lastSearch;
    if (!last || last.query.trim().length === 0) {
      // 还没搜过：无处可跳，按 ⌘F 的语义把面板打开更符合直觉
      this.openSearch();
      return;
    }
    this.openSearch({ query: last.query, index: last.index + 1 });
  }

  /** 关掉搜索面板（切板 / 视图卸载 / 重新打开时）。面板不在时是空操作 */
  private closeSearch(): void {
    this.searchPanel?.close();
    this.searchPanel = null;
  }

  /**
   * 飞到某张卡并高亮它（搜索 `T2.09` / 待办总览 `T3.03` 共用）。
   *
   * ★ 只平移、**不缩放**：当前倍率是用户自己挑的阅读档位，把视线挪过去的职责
   *   不包括顺手改字号（改完他还得再调回来，纯属添乱）。
   * ★ 卡片可能躲在分栏里、也可能被别的卡压着：先飞到中心，再**选中**它 ——
   *   选中框是"就是这张"的持续标记，闪烁只负责让人一眼看到它出现在哪儿。
   * ★ 找不到卡片就静默返回：调用方（搜索结果 / 待办浮层）手里的是**上一帧**的
   *   快照，卡片可能刚好在这中间被删掉或撤销掉。
   */
  private revealCard(cardId: string): void {
    const card = this.board?.cards.find((item) => item.id === cardId);
    if (!card) return;

    const rect = this.visualRectOf(card);
    this.viewport.centerOn({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
    this.selection.set({ cards: [card.id] });
    this.cardLayer?.flash(card.id);
  }

  /**
   * 飞到**脑图的某个节点**（`2.2.0` 批 4：搜索结果落在节点上时的落地动作）。
   *
   * ★ 与 `revealCard` 同一条思路：**先飞到中心，再选中它** —— 选中框是"就是这一个"
   *   的持续标记（`EmbedMind` 那圈描边 + 底部那条快捷操作栏）。
   * ★ 取不到那个节点的盒子（它所在的分支被折叠收起来了 / 那份 `.nestmind` 还没读到）
   *   ⇒ 退回"飞到树根那一点"：至少把那棵树送到眼前，比什么都不做好得多。
   */
  private revealMindNode(mindId: string, nodeId: string): void {
    const mind = this.board?.minds?.find((item) => item.id === mindId);
    if (!mind) return;

    const rect = this.mindLayer?.nodeRectOf(nodeEndpointKey(mindId, nodeId)) ?? null;
    const center = rect
      ? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
      : { x: mind.x, y: mind.y };
    this.viewport.centerOn(center);
    // 选中（连底部那条栏一起换过去）；节点已经不在画面上就什么都不做
    this.mindLayer?.focusNode(mindId, nodeId);
  }

  /** 白板未就绪时挂起的定位请求（见 `revealCardById`） */
  private pendingRevealCardId: string | null = null;
  /** 白板未就绪时挂起的"飞到某个脑图节点"（见 `revealMindNodeById`） */
  private pendingRevealMind: { mindId: string; nodeId: string } | null = null;

  /**
   * **外部**定位入口（T5.03 反链面板 / T5.06 `obsidian://` 协议）。
   *
   * ★ 与上面那个私有版本的唯一差别是**时机**。调用方几乎总是"刚 `openBoardView()`
   *   完就调"，而那一刻 `openBoard()` 可能还在读文件（`onLoadFile` 是异步的）——
   *   此刻 `this.board` 还是 `null`，直接调私有版本会静默扑空，用户看到的是
   *   "点了跳转，白板确实开了，但没定位到那张卡"。所以没就绪就先挂起，
   *   等 `openBoard()` 收尾时补做（那里卡片层已经画完，坐标算得出来）。
   */
  revealCardById(cardId: string): void {
    if (this.board) {
      this.revealCard(cardId);
      return;
    }
    this.pendingRevealCardId = cardId;
  }

  /**
   * **外部**定位到脑图的某个节点（`2.2.0` 批 4：跨板搜索结果落在节点上）。
   *
   * ★ 与 `revealCardById` 完全同形 —— 连"板子还没读完就先挂起"这条都一样，
   *   因为调用方几乎总是在 `openBoardView()` 之后立刻调。
   */
  revealMindNodeById(mindId: string, nodeId: string): void {
    if (this.board) {
      this.revealMindNode(mindId, nodeId);
      return;
    }
    this.pendingRevealMind = { mindId, nodeId };
  }

  /**
   * 粘贴一个 URL → 建一张链接卡（T2.04 / `F2-4-1`）。
   *
   * ★ 只在**粘贴**这条路线上建卡，拖拽那条路仍然丢弃 URL（`model/drop.ts` 里的
   *   `normalizeDropPath` 明确不认外链）：从浏览器往画布拖一个链接，拖的是"一个
   *   东西"，落成什么卡得看拖的是什么；而粘贴一条 URL 的意图非常明确 ——
   *   用户要的就是把这条链接钉在板上。
   * ★ 落点与"指针在栏内就收进栏"复用 `placeDroppedCards` 的同一条逻辑：不这么做
   *   会出现"拖进去的卡进栏、粘进去的落在栏外面压着栏"。
   */
  private createLinkCardAt(url: string, center: Point): boolean {
    const board = this.board;
    if (!board || this.isReadOnly()) return false;

    const size = DEFAULT_CARD_SIZES.link;
    const card = createCard('link', {
      x: roundTo(center.x - size.width / 2),
      y: roundTo(center.y - size.height / 2),
      width: size.width,
      height: size.height,
      color: this.newCardColor(),
      content: { url },
    });

    const target = findDropTarget(board, center, undefined, (columnId) =>
      this.columnScrollOffsetOf(columnId),
    );

    const changed = this.commit(t('history.create'), (draft) => {
      if (!addCards(draft, [card])) return false;
      if (target) insertCardsIntoColumn(draft, [card.id], target.columnId, target.index);
      return true;
    });

    if (changed) {
      this.selection.set({ cards: [card.id] });
      if (target) this.revealCardInColumn(target.columnId, [card.id]);
      // `O32`：填了有效链接就**自动抓一次**，不再要用户去点卡上的按钮。
      // ★ 总开关关着时**连 `fetchLinkPreviewCard` 都不调**：那条路会弹一句"抓取已关闭"，
      //   而用户只是粘了张卡 —— 卡面上已经有一句说明（见 `cards/link.ts`），不必再打断他。
      if (this.linkPreviewBridge?.enabled) void this.fetchLinkPreviewCard(card.id);
    }
    return changed;
  }

  /** 注入给卡片定义的导航端口（`cards/` 不认识视图，只认识这几个方法） */
  private boardNavBridge(): BoardNavBridge {
    // 拍一次局部变量：桥可能还没装配（画布没起来 / 已拆除），
    // 而闭包里再取一次 `this.boardThumbBridge` 会让 TS 的窄化失效（得写 `!`）
    const bridge = this.boardThumbBridge;
    return {
      open: (path) => this.openNestedBoard(path),
      summary: (path) => this.boardSummaryOf(path),
      // 空格位双击建子板（T1.61）：递给卡片层的只有"卡片 id"，
      // 落文件、写回内容、记历史全在视图这一层（见 `createChildBoardForCard`）
      createChildBoard: (cardId) => this.createChildBoardForCard(cardId),
      // 板缩略图（T4.16 / `F2-8-2`）：卡面预览区那块图。
      // ★ 形状与 `CardRenderContext.thumbnails` 完全相同（`ThumbnailBridge`），
      //   只是画的是"整块板"而不是一张图 —— 卡片层不必区分这两者。
      //   未就绪（画布还没装配 / 已拆除）时不传，卡面退回概要面板
      thumbnail: bridge ?? undefined,
      // 只读小窗（T7.09 / `F7-10`）：`readBoard` 给小窗模型、`watchBoard` 在那块板
      // 被保存时叫醒它。两者都借缩略图桥的手 —— "一块 `.nboard` 怎么读"只有那一份实现
      // ★ 没有桥时**两项都不给**（而不是给一个返回 `null` 的空壳）：端口层的约定是
      //   "能力缺失就不出现"，卡片据此退回概要面板；给空壳会让卡片以为小窗可用，
      //   然后画出一扇永远是空的窗
      readBoard: bridge ? (path) => bridge.readBoard(path) : undefined,
      watchBoard: bridge ? (path, listener) => bridge.watchBoard(path, listener) : undefined,
    };
  }

  /**
   * 注入给引用卡的反链端口（T5.04 / `F10-03`）。
   *
   * ★ 查询本身由插件级的 `LinkIndex` 负责（它扫的是全部 `.nboard` 的内联卡正文，
   *   Obsidian 的 `metadataCache` 不索引 `.nboard`）。这一层只做两件事：
   *   把 `LinkHit` 原样递出去，以及决定"点一条反链"到底怎么跳。
   */
  private backlinksBridge(): BacklinkBridge {
    const index = this.plugin.linkIndex;
    return {
      // ★ 用 getter 而不是拍一张快照：扫描是分片进行的，桥可能建得比扫描早得多
      get ready() {
        return index.isReady;
      },
      count: (notePath) => index.backlinksOf(notePath).length,
      // ★ 索引里的命中是**文档中立**的（`docPath` / `anchorId` / `label`，`06 §7.2`），
      //   而卡片层（`BacklinkHit`）说的是白板语汇 —— 这一处就是那层翻译。
      //   只改名不动语义：`...rest` 把 `excerpt` / `target` / `resolved` 原样带过。
      list: (notePath) =>
        index.backlinksOf(notePath).map(({ docPath, docTitle, anchorId, label, ...rest }) => ({
          boardPath: docPath,
          boardTitle: docTitle,
          cardId: anchorId,
          cardTitle: label,
          ...rest,
        })),
      open: (boardPath, cardId) => {
        // 反链很可能就在**当前这块板**上（同板内联卡提到了板外笔记）：
        // 那种情况下再"进一次板"是空转，原地定位才是用户要的
        if (boardPath === this.currentPath) {
          this.revealCardById(cardId);
          return;
        }
        // ★ 进板走 `openNestedBoard` 而不是另开标签：卡片就长在画布里，点它的语义
        //   是"从这块板走到那块板"，与双击白板卡完全相同（会记历史，⌘[ 能回来）。
        //   侧栏反链面板另开标签，是因为那是个全局面板，不该把用户当前这块板顶掉
        void this.openNestedBoard(boardPath).then((opened) => {
          if (opened) this.revealCardById(cardId);
        });
      },
      watch: (listener) => index.onChanged(listener),
    };
  }

  /**
   * 读目标板的概要（`F2-8-7`）。
   *
   * ★ 用 `notesBridge.read` 读**原始文本**再 `JSON.parse`，而不是
   *   `repository.open()`：后者会为该路径建一个 session 并挂上订阅 ——
   *   白板卡只是画个"有几张卡"，不该因此把一块块板常驻内存。
   */
  private async boardSummaryOf(path: string): Promise<BoardSummary | null> {
    const raw = await this.notesBridge?.read(path);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as {
        cards?: unknown;
        columns?: unknown;
        minds?: unknown;
      };
      return {
        cards: Array.isArray(parsed.cards) ? parsed.cards.length : 0,
        columns: Array.isArray(parsed.columns) ? parsed.columns.length : 0,
        // 脑图（`2.2.0` 收尾）：缺键 = 一块没有树的老板子，不是"读不出来"
        minds: Array.isArray(parsed.minds) ? parsed.minds.length : 0,
      };
    } catch {
      return null;
    }
  }

  /**
   * 进到另一块白板（`F2-8-3` / 面包屑跳转 / ⌘U）。
   *
   * ★ 在**当前 leaf 原地**切文件，而不是新开标签：面包屑与前进/后退都活在
   *   这一个视图里，每层都开新标签会让"回上一级"无处可回，标签栏也会很快被塞满。
   */
  private async openNestedBoard(path: string): Promise<boolean> {
    if (path.length === 0 || path === this.currentPath) return false;
    try {
      await this.leaf.setViewState({
        type: VIEW_TYPE_BOARD,
        state: { file: path },
        active: true,
      });
      return true;
    } catch {
      // 目标板可能已被删/改名：留在原地比跳进一个空视图好
      return false;
    }
  }

  /**
   * 读别的板子的 `meta.parent`（面包屑沿它往上走，`⌘U` 要用它）。
   *
   * ★ 这里**不读 `meta.title`**（`O15`）：那个字段只在建板时写过一次，改名后不会跟着走，
   *   拿它当显示名就会显示旧名。显示名一律用文件名（`boardTitleOf`）。
   */
  private async readBoardMeta(path: string): Promise<{ parent: string | null } | null> {
    const raw = await this.notesBridge?.read(path);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as { meta?: { parent?: unknown } };
      const meta = parsed.meta;
      return {
        parent: typeof meta?.parent === 'string' && meta.parent.length > 0 ? meta.parent : null,
      };
    } catch {
      return null;
    }
  }

  /**
   * 沿 `meta.parent` 往上收，得到"根 → 当前"的层级链（`F2-8-4`）。
   *
   * ★ 层级来自**父白板链**而不是文件夹：白板可以跨文件夹互相引用，
   *   若按文件夹算，用户点面包屑会跳到一块看起来毫不相关的板上去。
   * ★ `seen` 防环：手改过的 `.nboard` 完全可能 A↔B 互为父级，
   *   没有这道闸，面包屑会一直往上读文件直到把主线程卡死。
   */
  private async resolveTrail(path: string, currentTitle: string): Promise<TrailNode[]> {
    const chain: TrailNode[] = [{ path, title: currentTitle }];
    const seen = new Set<string>([path]);
    let cursor = (await this.readBoardMeta(path))?.parent ?? null;

    while (cursor && !seen.has(cursor) && chain.length < TRAIL_DEPTH_LIMIT) {
      seen.add(cursor);
      const meta = await this.readBoardMeta(cursor);
      // ★ 名字取**文件名**而不是 `meta.title`（`O15`）：后者只在建板时写过一次
      //   （`io/newBoard.ts`），改完名不会跟着走，面包屑就会一直显示旧名；
      //   而白板卡显示的一直是文件名（`cards/boardRef.ts`），两处当场对不上。
      //   显示口径统一为"文件名"。
      chain.unshift({ path: cursor, title: boardTitleOf(cursor) });
      cursor = meta?.parent ?? null;
    }
    return chain;
  }

  /** 重画面包屑。文件/板子换掉之后都要调它一次 */
  private async refreshBreadcrumb(): Promise<void> {
    const breadcrumb = this.breadcrumb;
    if (!breadcrumb) return;
    const path = this.currentPath;
    if (!path) {
      this.boardParentPath = null;
      breadcrumb.render(t('breadcrumb.root'), []);
      breadcrumb.updateHistoryButtons();
      return;
    }

    // ★ 显示名 = **文件名**（`O15`），与白板卡同一口径；`meta.title` 只在建板时写过一次，
    //   改名后不会跟着走，用它会让面包屑显示旧名
    const title = boardTitleOf(path);
    breadcrumb.setFullPathTip(path);
    // 同步调用可能晚于下一次导航（用户手快），所以先记下这次请求针对哪块板，
    // 回来时对不上就直接丢弃 —— 否则会给新板画上旧板的层级
    const requested = path;
    const chain = await this.resolveTrail(requested, title);
    if (this.currentPath !== requested || this.breadcrumb !== breadcrumb) return;
    // 顺带把父级缓存下来：`⌘U` 的出入口与可用态就不再需要第二次读盘
    this.boardParentPath = chain.length > 1 ? chain[chain.length - 2].path : null;
    breadcrumb.render(t('breadcrumb.root'), chain);
    breadcrumb.updateHistoryButtons();
  }

  /** 记一条历史（`F2-8-5`）。与浏览器一致：从历史中间开新板会截掉"前进"那一段 */
  private remember(path: string): void {
    if (this.navIndex >= 0 && this.navHistory[this.navIndex] === path) return;
    if (this.navIndex < this.navHistory.length - 1) this.navHistory.length = this.navIndex + 1;
    this.navHistory.push(path);
    this.navIndex = this.navHistory.length - 1;
  }

  get canNavigateBack(): boolean {
    return this.navIndex > 0;
  }

  get canNavigateForward(): boolean {
    return this.navIndex >= 0 && this.navIndex < this.navHistory.length - 1;
  }

  navigateBack(): void {
    if (!this.canNavigateBack) return;
    this.navIndex -= 1;
    void this.replayHistory();
  }

  navigateForward(): void {
    if (!this.canNavigateForward) return;
    this.navIndex += 1;
    void this.replayHistory();
  }

  /**
   * 这块白板被重命名 / 移动了（T1.73 / `F7-05`）：把视图里**所有按路径记账的地方**换过来。
   *
   * ★ 要换的不只是 `currentPath`。视图里一共有五处记账：
   *   - `currentPath` —— 下一次自动保存写哪儿。漏掉它的表现最糟：往**旧路径**写，
   *     轻则新建回一个"幽灵文件"，重则整段改动报错丢掉；
   *   - `navHistory` —— `⌘[` 跳回哪块板。漏掉它就会去打开一个不存在的文件；
   *   - `boardParentPath` —— `⌘U` 的可用态缓存；
   *   - `replayTarget` —— 回放的认领凭据，不跟着走会让下一次 `⌘[` 认错板；
   *   - **面包屑**（`O15`）—— 显示名取文件名，不补画一次就会停在旧名上。
   *
   * ★ **幂等**：`oldPath` 对不上就什么都不做。所以 `FileView.onRename` 钩子
   *   与 `main.ts` 里那条 `vault.on('rename')` 兜底可以同时存在，不会重复生效。
   */
  retargetPath(oldPath: string, newPath: string): void {
    if (oldPath === newPath) return;

    // ★ 只有"看的正是这块板"时才补画面包屑（`O15`）：改名后每一级都要**立刻**换成新名，
    //   而 `refreshBreadcrumb` 原本只在开板 / 切语言时被调，不补这一下就得重开一次才更新。
    //   兜底路径会对**所有**视图调本方法，其余的视图并没有改名，不必白读一遍父链。
    const wasCurrent = this.currentPath === oldPath;
    if (wasCurrent) this.currentPath = newPath;
    if (this.boardParentPath === oldPath) this.boardParentPath = newPath;
    if (this.replayTarget === oldPath) this.replayTarget = newPath;
    for (let index = 0; index < this.navHistory.length; index += 1) {
      if (this.navHistory[index] === oldPath) this.navHistory[index] = newPath;
    }
    if (wasCurrent) void this.refreshBreadcrumb();
  }

  /**
   * 回到历史里的当前项。
   *
   * 先挂上 `replayTarget` 再切文件：`openBoard` 会凭这个路径认出
   * "这一次加载是回放"，于是不记新历史（`⌘[` 才能再按第二次）。
   */
  private async replayHistory(): Promise<void> {
    const path = this.navHistory[this.navIndex];
    if (!path) return;
    // 同一块板（历史里相邻两项相同）—— `openNestedBoard` 会拒绝，`onLoadFile` 也不会来，
    // 那就没有"要不要记历史"的问题，只把按钮可用态刷一下
    if (path !== this.currentPath) {
      this.replayTarget = path;
      if (!(await this.openNestedBoard(path))) {
        // 目标没了（板被删/改名）：撤掉认领，免得下次用户手动打开这块板时被当成回放
        this.replayTarget = null;
      }
    }
    this.breadcrumb?.updateHistoryButtons();
  }

  /** 命令可用条件：⌘U 有父级可回（父级缓存来自上一次面包屑刷新，不额外读盘） */
  get canOpenParent(): boolean {
    return !this.isReadOnly() && this.boardParentPath !== null;
  }

  /** `⌘U`（`F2-8-5`）：回到父级白板 */
  openParentBoard(): void {
    const parent = this.boardParentPath;
    if (!parent) {
      new Notice(t('notice.noParent'));
      return;
    }
    void this.openNestedBoard(parent).then((opened) => {
      // 父级指向的板子没了（手改 / 删除）→ 说清楚是哪一块，
      // 而不是让用户对着"点了没动"的界面反复按 ⌘U
      if (!opened) new Notice(t('notice.sourceMissingFile', { path: parent }));
    });
  }

  /** 命令可用条件：选中的卡片够分栏（⌘Enter / ⌘⇧G 与命令面板共用） */
  get canCollectIntoColumn(): boolean {
    return this.canManipulateCards;
  }

  /** 命令可用条件：至少两张卡才谈得上"拆" */
  get canSplitIntoColumns(): boolean {
    return this.canManipulateCards && this.selection.cardIds.size >= 2;
  }

  /** 命令可用条件：当前选中了栏（折叠 / 展开） */
  get canToggleSelectedColumn(): boolean {
    return !this.isEditingCard && !this.isReadOnly() && this.selection.columnIds.size > 0;
  }

  /**
   * 命令面板 / 自定义热键入口：折叠或展开选中的栏（T1.57）。
   *
   * ★ 能选中**多栏**（框选，用户 2026-09-16）⇒ 一次提交改完，而不是逐个 `commit`
   *   （逐个的话按 N 下 ⌘Z 才退得回去）。
   * ★ 多选时统一到**一个**目标状态：选区里有展开的就全折上，全折上了才全展开 ——
   *   逐个 toggle 会在"三栏里两栏折着"这种选区里翻出一锅粥，而用户要的是"都收起来"。
   */
  toggleSelectedColumnCollapsed(): void {
    const board = this.board;
    if (!board) return;
    const ids = [...this.selection.columnIds].filter((id) => columnById(board, id) !== null);
    if (ids.length === 0) return;

    const collapsed = ids.some((id) => columnById(board, id)?.collapsed !== true);
    this.commit(t('history.column'), (draft) => {
      let did = false;
      for (const id of ids) {
        if (setColumnCollapsed(draft, id, collapsed)) did = true;
      }
      return did;
    });
  }

  /** 命令可用条件：能写这块板，就能切它的网格吸附开关 */
  get canToggleGridSnap(): boolean {
    return !this.isReadOnly();
  }

  /**
   * 网格吸附开关（T3.11 / `F5-02`）。
   *
   * ★ 走 `commit` 而不是裸改 `board.settings`：设置是白板文件的一部分，改动要落盘、
   *   要递增 `revision`（否则下次打开又变回去）。
   * ★ 但它**不进撤销栈** —— `serializeContent` 只快照五类**内容实体**
   *   （卡 / 分栏 / 脑图 / 线 / 编组，见 `model/history.ts`），
   *   所以 `⌘Z` 不会把网格开关翻回去（"撤销一下板子自己动了"很吓人）。
   * ★ 打开时提示里带上步长：用户改过 `gridSize` 之后，"吸附到 8 还是 16"是他最想确认的事。
   */
  toggleGridSnap(): void {
    const changed = this.commit(t('history.gridSnap'), (board) => {
      board.settings.snapToGrid = !board.settings.snapToGrid;
      return true;
    });
    if (!changed) return;

    const board = this.board;
    if (!board) return;
    new Notice(
      t(board.settings.snapToGrid ? 'notice.gridSnapOn' : 'notice.gridSnapOff', {
        size: normalizeGridSize(board.settings.gridSize),
      }),
    );
  }

  // ── 对齐 / 等距分布 / 编组 / 分栏对齐（T3.13–T3.15 / `F5-01`/`F5-04`/`F5-05`）──

  /**
   * 能参与"对齐 / 分布"的卡片：选区里**没被锁、也不在某栏里**的那几张。
   *
   * ★ 栏里的卡片几何由 `relayoutColumns` 说了算，拉出去对齐会被下一次重排抹掉；
   *   锁定的卡片按约定本来就不该被程序挪动（`canManipulateCard`）。两者都排除。
   *   排除之后若不足两张，命令就不可用 —— 这是"看得见的一致性"，
   *   而不是让用户点下去发现"有的卡没动"。
   */
  private alignTargets(): string[] {
    const board = this.board;
    if (!board) return [];
    return [...this.selection.cardIds].filter((id) => {
      const card = board.cards.find((item) => item.id === id);
      return card !== undefined && !card.locked && card.columnId === null;
    });
  }

  /** 命令可用条件：两张以上可动的卡片才有"对齐"可言 */
  get canAlignSelection(): boolean {
    return this.canManipulateSelection && this.alignTargets().length >= 2;
  }

  /** 命令可用条件：三张以上才谈得上"等距分布"（两张之间只有一段空隙，天然等距） */
  get canDistributeSelection(): boolean {
    return this.canManipulateSelection && this.alignTargets().length >= 3;
  }

  /**
   * 对齐选中卡片（T3.13 / `F5-04`）。
   *
   * 基准是这组卡片的**包围盒** —— 这正是 Figma 的行为：左对齐是"贴到最左那张的
   * 左边缘"，而不是"贴到坐标原点"。全部由模型层 `alignCards` 决定，视图只负责
   * 把选区与历史接上。
   */
  alignSelection(mode: AlignMode): void {
    const ids = this.alignTargets();
    if (ids.length < 2) return;
    this.commit(t('history.align'), (board) => alignCards(board, ids, mode));
  }

  /** 等距分布：**均分看得见的空隙**（不是等分中心点），首尾两张不动（T3.13 / `F5-04`） */
  distributeSelection(axis: DistributeAxis): void {
    const ids = this.alignTargets();
    if (ids.length < 3) return;
    this.commit(t('history.distribute'), (board) => distributeCards(board, ids, axis));
  }

  /**
   * 把"选中组内一张"扩成"选中整组"（T3.14 的整体移动 / 缩放）。
   *
   * ★ 挂在**选区通知**里而不是每个 `selection.set` 调用点：选区入口有十来处
   *   （框选、⌘A、粘贴、新建卡片……），逐个改必然漏一处 —— 而漏掉的那处就是
   *   "拖着组内一张卡，却只动了它自己"的怪 bug。挂在这里，新入口自动获得同一语义。
   * ★ 靠 `SelectionModel.set` 的**幂等**收敛：扩展后它会再发一次通知，那时集合已含整组、
   *   不再扩展，于是停在第二次而不会递归。
   * ★ 连线 / 分栏选中原样带上：`set` 是整体替换，省略哪类就清哪类。
   *
   * @returns 是否刚做了扩展（true = 外观同步交给紧随其后的那次通知，别在同一帧渲染两遍）
   */
  private expandSelectionToGroups(): boolean {
    const board = this.board;
    if (!board) return false;
    if (this.selection.cardIds.size === 0 && this.selection.columnIds.size === 0) return false;

    const cards = expandGroupSelection(board, this.selection.cardIds);
    // ★ 分栏成员同样处理（用户 2026-09-16）：点到组里的**一栏** = 整组一起选中。
    //   组里另一类成员也一并带上 —— 组是个整体，"只选中了一半"是最难解释的状态。
    const columns = new Set(this.selection.columnIds);
    for (const id of [...columns]) {
      const group = groupOfColumn(board, id);
      if (!group) continue;
      for (const member of group.cardIds) cards.add(member);
      for (const member of group.columnIds ?? []) columns.add(member);
    }
    if (
      cards.size === this.selection.cardIds.size &&
      columns.size === this.selection.columnIds.size
    ) {
      return false;
    }

    this.selection.set({
      cards,
      edges: this.selection.edgeIds,
      columns,
    });
    return true;
  }

  /** 选区里真实存在的卡片 id（编组对象：锁着的、栏里的都能进组 —— 编组不改几何） */
  private groupTargets(): string[] {
    const board = this.board;
    if (!board) return [];
    return [...this.selection.cardIds].filter((id) => board.cards.some((card) => card.id === id));
  }

  /**
   * 编组结构签名：只用来判断一次编组 / 取消编组是否**真的**改了结构。
   * ★ 不能拿 `groupCards` 的返回值（新组 id）当"改没改"的信号 —— 它在"选中几张
   *   本来就已经同属一个编组"时是空操作，却照样返回那个组 id（约定 3）。
   */
  private groupSignature(board: BoardFile): string {
    return board.groups
      .map(
        (group) =>
          `${group.id}:${[...group.cardIds].sort().join(',')}|${[...(group.columnIds ?? [])]
            .sort()
            .join(',')}`,
      )
      .join(';');
  }

  /** 选区里真实存在的分栏 id（编组的另一类成员） */
  private groupColumnTargets(): string[] {
    const board = this.board;
    if (!board) return [];
    return [...this.selection.columnIds].filter((id) => columnById(board, id) !== null);
  }

  /**
   * 命令可用条件：编组对象够两个（**分了栏与卡片两类成员**）。
   *
   * ★ 分栏也算：框选框住两栏之后按 `⌘G` 是很自然的动作（栏内卡片不参与框选，
   *   见 `MarqueeController`）—— 只按卡片判会让命令灰着、用户找不到原因。
   * ★ 一栏算**一个**成员（不是"栏里有几张卡"）：它编进组里去的是**栏自己**。
   */
  get canGroupSelection(): boolean {
    if (!this.canManipulateSelection) return false;
    return this.groupTargets().length + this.groupColumnTargets().length >= MIN_GROUP_SIZE;
  }

  /** 命令可用条件：选区里至少有一个成员（卡 / 栏）已经在编组里 */
  get canUngroupSelection(): boolean {
    const board = this.board;
    if (!board) return false;
    return (
      this.canManipulateSelection &&
      (this.groupTargets().some((id) => groupOfCard(board, id) !== null) ||
        this.groupColumnTargets().some((id) => groupOfColumn(board, id) !== null))
    );
  }

  /**
   * 编组（T3.14 / `F5-05`，`⌘G`）。
   *
   * 模型层 `groupCards` 负责"一张卡最多属于一个编组"（会把它从旧组里摘出来）与
   * "单成员组自动解散"；这里补三件事：**把选中分栏的成员并进来**（见下）、
   * 给不足两张时一句解释、以及**空操作不记历史**。
   */
  groupSelection(): void {
    const board = this.board;
    if (!board) return;

    // ★ 成员 = 选中的卡片 **+ 选中的分栏本身**（用户 2026-09-16："分栏也可以作为卡片
    //   被编入组中"）。分栏编进来**什么都不改**：栏不消失、栏里的卡片一张都不动
    //   （不像「整栏转编组」那样把栏换掉）—— 只是多了一层"它们是一伙的"。
    //   所以这里**不 detach、也不 release**，只把栏 id 记进组里。
    const cards = this.groupTargets();
    const columns = this.groupColumnTargets();
    if (cards.length + columns.length < MIN_GROUP_SIZE) {
      new Notice(t('notice.groupNeedsTwo'));
      return;
    }

    const changed = this.commit(t('history.group'), (draft) => {
      const before = this.groupSignature(draft);
      groupMembers(draft, { cardIds: cards, columnIds: columns });
      return this.groupSignature(draft) !== before;
    });
    if (changed) new Notice(t('notice.grouped', { count: cards.length + columns.length }));
  }

  /** 取消编组：把选区沾到的组整个解散（卡片成员与分栏成员都认） */
  ungroupSelection(): void {
    const board = this.board;
    if (!board) return;
    const cards = this.groupTargets().filter((id) => groupOfCard(board, id) !== null);
    const columns = this.groupColumnTargets().filter((id) => groupOfColumn(board, id) !== null);
    if (cards.length === 0 && columns.length === 0) {
      new Notice(t('notice.ungroupNeedsGroup'));
      return;
    }
    const changed = this.commit(t('history.ungroup'), (draft) => {
      const before = this.groupSignature(draft);
      ungroupMembers(draft, { cardIds: cards, columnIds: columns });
      return this.groupSignature(draft) !== before;
    });
    if (changed) new Notice(t('notice.ungrouped'));
  }

  /**
   * 收起 / 展开一个编组（O03）。标签条上那个开关的落点。
   *
   * ★ 走 `commit`：收起是**看得见的状态**，`⌘Z` 必须能撤回，而且两种方向各记一条
   *   （标签不同），用户按撤销时看到的提示就是"收起编组 / 展开编组"。
   * ★ 目标是**被点的那一组**（`groupId`），不是当前选区：用户完全可能先点了别处，
   *   此时按选区操作会收起另一组 —— 而他是冲着那个标签条点的。
   * ★ 空操作不记历史：模型层 `setGroupCollapsed` 已经是幂等的，
   *   这里把它的返回值直接当 `commit` 的"是否真的改了"。
   */
  private toggleGroupCollapsed(groupId: string): void {
    const board = this.board;
    const group = board ? groupById(board, groupId) : null;
    if (!group) return;
    const next = group.collapsed !== true;
    const changed = this.commit(
      t(next ? 'history.groupCollapse' : 'history.groupExpand'),
      (draft) => setGroupCollapsed(draft, groupId, next),
    );
    // ★ 收起之后成员在屏幕上**不存在**了，得把它们从选区里摘掉（O03）。
    //   框选那条防线（`selectableCards`）只拦得住"新框进来"的卡片，拦不住
    //   "先选了整组、再点收起"这种：那一刻选区里躺着的正是刚消失的这几张，
    //   此时按 Delete 就是**删掉一屏看不见的东西**。
    if (changed && next) this.dropFromSelection(group.cardIds);
  }

  /** 编组改名提交（双击标签条）。原样提交由模型层挡下，不记历史 */
  private commitGroupLabel(groupId: string, label: string): void {
    this.commit(t('history.groupLabel'), (board) => setGroupLabel(board, groupId, label));
  }

  /**
   * 把一批卡片从选区里摘掉（O03：收起编组时用）。
   *
   * ★ 只摘卡片，**连线与分栏选区原样带上**：`SelectionModel.set` 是"整体替换"，
   *   不带上就等于"点了个收起开关，顺手把我选中的那条连线也取消了"。
   */
  private dropFromSelection(cardIds: readonly string[]): void {
    const drop = new Set(cardIds);
    if (![...drop].some((id) => this.selection.hasCard(id))) return;
    this.selection.set({
      cards: [...this.selection.cardIds].filter((id) => !drop.has(id)),
      edges: [...this.selection.edgeIds],
      columns: [...this.selection.columnIds],
    });
  }

  /**
   * 按在组标签条上 = 选中整组并开始拖动（O03）。
   *
   * ★ 拖动**复用卡片拖动的入口**（`beginCardDrag`）：网格吸附、智能参考线、
   *   拖出导出、拖进分栏、撤销，全都白拿 —— 自己再写一条"移动一组矩形"的路，
   *   等于把这些行为重实现一遍，而且以后每加一条拖动行为都要记得补两处。
   * ★ 先 `selection.set(...)` 再进去：`beginCardDrag` 对"已经选中的卡"会**保留选区**
   *   （多选整体拖动就靠这一条），于是整组一起走。
   * ★ 锚点选**第一张没锁的成员**：`beginCardDrag` 遇到锁定的卡会直接返回，
   *   拿一张锁住的卡当锚点会让"整组都锁着"和"第一张锁着"变成同一种表现。
   * ★ 收起状态下成员没有 DOM，屏幕上只有标签条在动 —— 这是**对的**：
   *   框已经折叠成标签了，它跟着手走正是"我在拖这个组"。
   */
  /**
   * 正在拖的那个**编组**（拖它的标签条时记下来）。
   *
   * ★ 只在"这一组带着分栏成员"时有值：那时拖动走列拖动那条路，落盘时要把
   *   组里其余分栏与成员卡片按同一个位移一起搬（见列拖动提交处）。
   *   `null` = 普通拖动（拖卡片 / 拖单栏），与从前一模一样。
   */
  private groupDrag: { columns: string[]; cards: string[] } | null = null;

  private beginGroupDrag(groupId: string, event: PointerEvent): void {
    if (this.presentation?.active || this.isReadOnly()) return;
    const board = this.board;
    const group = board ? groupById(board, groupId) : null;
    if (!board || !group) return;
    // 只拿**还在**的成员：组里可能留着已被删除的 id（`pruneGroups` 之外的状态）
    const members = group.cardIds.filter((id) => board.cards.some((card) => card.id === id));
    const columns = (group.columnIds ?? []).filter((id) => columnById(board, id) !== null);
    const anchor = members.find(
      (id) => board.cards.find((card) => card.id === id)?.locked !== true,
    );

    // ★ 组里有**分栏成员**时走列拖动那条路（用户 2026-09-16："拖组带着分栏一起走"）：
    //   卡片拖动那条最后只 `applyCardRects`（卡片动了、栏没动），而栏没动的后果是
    //   `commit` 收尾的 `relayoutColumns` 又把栏内卡片按栏的旧位置排回去 ——
    //   整次拖动等于白做。列拖动那条路预览 / 吸附 / 撤销都齐，另外几类成员在那次提交里一起平移。
    if (columns.length > 0) {
      this.groupDrag = { columns, cards: members };
      this.selection.set({ cards: members, columns });
      this.beginColumnGesture(columns[0], { kind: 'move' }, event);
      return;
    }

    if (!anchor) return;
    this.groupDrag = null;
    this.selection.set({ cards: members });

    const host = this.canvasEl;
    if (!host) return;
    const bounds = host.getBoundingClientRect();
    const screen = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
    this.beginCardDrag({
      phase: 'pointerdown',
      cardId: anchor,
      element: event.target instanceof HTMLElement ? event.target : host,
      screen,
      world: this.viewport.toWorld(screen),
      original: event,
    });
  }

  /**
   * 当前该对齐哪一排分栏（T3.15 / `F5-01`）：选中某一栏 → 它所在的那一整排；
   * 没有栏被选中 → 用选区里卡片各自所属的栏。返回的是栏 id 列表。
   */
  private siblingColumnRow(): string[] {
    const board = this.board;
    if (!board) return [];
    const seeds = new Set<string>();
    // ★ 选中的栏可能不止一个（框选，用户 2026-09-16）—— 每一栏各自带出它那一排
    for (const id of this.selection.columnIds) seeds.add(id);
    for (const id of this.selection.cardIds) {
      const card = board.cards.find((item) => item.id === id);
      if (card?.columnId) seeds.add(card.columnId);
    }
    const row = new Set<string>();
    for (const seed of seeds) {
      for (const column of siblingColumnsOf(board, seed)) row.add(column.id);
    }
    return [...row];
  }

  /** 命令可用条件：至少能凑出两栏"同级"才谈得上对齐 */
  get canAlignSiblingColumns(): boolean {
    return !this.isEditingCard && !this.isReadOnly() && this.siblingColumnRow().length >= 2;
  }

  /**
   * 同组分栏对齐（T3.15 / `F5-01`）：顶部对齐 + 等宽 + 横向重排防重叠。
   * 模型层 `alignSiblingColumns` 负责几何，视图只接命令与历史。
   */
  alignSelectedColumns(): void {
    const ids = this.siblingColumnRow();
    if (ids.length < 2) return;
    this.commit(t('history.alignColumns'), (board) => alignSiblingColumns(board, ids));
  }

  /** 命令可用条件：可编辑的板子上才谈得上整理（编辑卡片时让路，与其它几何命令一致） */
  get canTidyBoard(): boolean {
    return !this.isEditingCard && !this.isReadOnly();
  }

  /**
   * 自动整理（T6.07 / `F5-06`）：把分栏与栏外卡片重排成整齐的行列。
   *
   * ★ 幂等：模型层在"没有可动的东西 / 已经整齐"时返回 `false`，`commit` 因此不记历史；
   *   这里再补一句"已经很整齐"，免得用户按了之后分不清是"没反应"还是"没变化"。
   */
  tidyBoard(): void {
    const changed = this.commit(t('history.tidyBoard'), (board) => tidyBoardModel(board));
    new Notice(changed ? t('notice.tidyBoardDone') : t('notice.tidyBoardNoChange'));
  }

  /** 命令可用条件：同 `canTidyBoard` —— 分栏要写模型，只读板上不给 */
  get canGroupByTag(): boolean {
    return !this.isEditingCard && !this.isReadOnly();
  }

  /**
   * 按标签自动分栏（T6.08 / `F5-07`）：把带同一标签的**栏外**散卡收进一个分栏。
   *
   * ★ 作用于**整块板子**而不是选中项（与 `tidyBoard` 同理）：只收选中的会让用户以为
   *   漏掉了一半卡片。已有同名分栏就收进去、不新建（模型层负责），所以连按两次不会翻倍。
   */
  groupByTag(): void {
    let summary: TagColumnsResult | null = null;
    const changed = this.commit(t('history.groupByTag'), (board) => {
      summary = columnsByTag(board);
      return summary.changed;
    });

    if (!changed || !summary) {
      // "没有可分的标签"与"只读 / 没有板子"共用一句：都不该静默 ——
      // 用户按了这个命令，得知道它是"没东西可分"而不是"坏了"
      new Notice(t('notice.groupByTagNone'));
      return;
    }
    const { created, reused } = summary;
    new Notice(t('notice.groupByTagDone', { created, reused }));
  }

  /**
   * 提升为笔记（T1.47）：写 `.md` → 把便签卡**就地换成**引用卡。
   *
   * ★ 写文件是异步的，写完之后必须重新确认这块板还在（用户完全可能在等待期间切走）——
   *   拿着 A 板的卡片 id 去改 B 板，最轻的后果是"提示说创建成功了，但卡片没变"。
   */
  private async promoteCard(cardId: string): Promise<void> {
    const path = this.currentPath;
    const board = this.board;
    const promoter = this.promoter;
    if (!path || !board || !promoter || this.isReadOnly()) return;

    const card = board.cards.find((item) => item.id === cardId);
    if (!card || card.type !== 'note') return;

    try {
      const created = await promoter.writeBacked(card.title, card.content.md, boardFolderOf(path));
      if (this.currentPath !== path) return;

      const next = promotedCard(card, created);
      const changed = this.commit(t('history.create'), (target) => {
        const index = target.cards.findIndex((item) => item.id === cardId);
        if (index === -1) return false;
        target.cards[index] = next;
        return true;
      });
      if (changed) new Notice(t('notice.promoteCreated', { path: created }));
    } catch (error) {
      new Notice(t('notice.promoteFailed', { error: describeError(error) }));
    }
  }

  // ── 指针 / 键盘：拖动、右键、双击、微移（T1.35–T1.41） ────

  /** 挂一个画布级监听器，并登记给 `teardownCanvas` 统一摘除 */
  private listenCanvas(
    canvas: HTMLElement,
    type: string,
    listener: EventListener,
    options?: AddEventListenerOptions,
  ): void {
    canvas.addEventListener(type, listener, options);
    this.canvasListeners.push({ type, listener, options });
  }

  /**
   * 卡片 pointerdown：选中 + 起拖（`F2-00-6`）。
   *
   * 四道门槛按顺序拦：
   *  1. 正在编辑**这张卡** → 指针归编辑器（放光标、选文字），不起拖；
   *  2. 正在编辑**别的卡** → 先把编辑态收掉（内容提交由编辑器的 blur 负责）；
   *  3. 抓到尺寸手柄 → 只缩放这一张（"把手柄群一起缩放"没有明确含义）；
   *  4. 锁定卡 → 可以选中，不能拖（`F6-05`）。
   */
  private beginCardDrag(detail: CardPointerDetail): void {
    // 演示态（J-06）下卡片不可拖、不可选：选区被改掉之后，菜单 / 键盘的可用态
    // 会跟着变，而演示要的是一块"只读的画布"（视图仍然可以平移缩放，那走别的路）
    if (this.presentation?.active) return;
    if (this.isReadOnly()) return;
    const card = this.board?.cards.find((item) => item.id === detail.cardId);
    if (!card) return;
    if (this.editingCardId === card.id) return;
    if (this.editingCardId) this.clearEditingState();

    const event = detail.original;
    const additive = event.shiftKey || event.metaKey || event.ctrlKey;
    if (additive) {
      const next = new Set(this.selection.cardIds);
      if (next.has(card.id)) next.delete(card.id);
      else next.add(card.id);
      this.selection.set({ cards: next });
    } else if (!this.selection.hasCard(card.id)) {
      // 点**已选中**的卡时保持选区：多选整体拖动就靠这一条
      this.selection.set({ cards: [card.id] });
    }

    this.focusCanvas();

    // 长按（T3.21 / `02 §4.3`）：移动端没有右键，卡片菜单只能靠长按唤出。
    // ★ 复用**这一次** `pointerdown`：按住不动 500ms 出菜单，挪出容差就自动作废，
    //   于是"长按"与"拖卡"不会互相抢（见 `LongPressDetector` 的类注释）。
    // ★ 只对触摸 / 笔生效：桌面鼠标按住不动半秒弹菜单是纯粹的干扰
    //   （而且桌面上右键本来就好用）。
    // ★ 放在选中之后：长按一张没选中的卡，菜单里的动作该作用在它身上。
    // ★ `original` 声明成 `MouseEvent`（因为要看 `button` / 修饰键），
    //   但委托层收到的其实是 `pointerdown` 那个 `PointerEvent` —— 收窄回来看 `pointerType`。
    //   不回退成"看 `event.button === 0` 就当作触摸"：鼠标主键也是 0，
    //   那样桌面上一按一停就会弹菜单。
    if ((event as PointerEvent).pointerType !== 'mouse') {
      this.longPressCardId = card.id;
      this.longPress?.start({ x: event.clientX, y: event.clientY });
    }

    const handle = resolveResizeHandle(event.target);
    if (handle && !card.locked) {
      // 视觉几何：从栏内滚过的卡片上拉手柄时，预览必须从"看到的位置"开始
      this.startDrag({
        kind: 'resize',
        origin: detail.world,
        rects: [this.visualRectOf(card)],
        handle,
        // 转过 90° 的卡片上，"右边"那个手柄在屏幕上其实是**下面** —— 控制器靠这个
        // 角度把指针位移投影回卡片自己的坐标轴（见 `localDelta`），手柄才跟手
        angle: card.rotation ?? 0,
      });
      return;
    }
    // 旋转手柄（T7.06 / `F2-00-10`）：同样"按在手柄上"，但动的不是几何。
    // ★ 与尺寸手柄互斥（两个属性名不同），顺序只影响可读性 —— 尺寸更常用，先认它。
    // ★ 只认**单选**：手柄本身就只在单选时显示（见 `CardLayer.setSelection`），
    //   这里再挡一次是为了确保 `rects[0]` 不会取到"多选里随便挑中的一张"。
    // ★ 分栏里的卡片不给转（用户 2026-09-17）：手柄本身也已经被隐藏（`CardLayer` 的
    //   `is-in-column`），这里是**第二道闸** —— 手柄与判据分散在两处时，只改一边就会出现
    //   "看不见的控件仍然能拖"那种鬼事。
    if (
      isRotateHandle(event.target) &&
      !card.locked &&
      card.columnId === null &&
      this.selection.cardIds.size === 1
    ) {
      this.startDrag({
        kind: 'rotate',
        origin: detail.world,
        // 起始几何用**视觉**矩形：旋转中心取它的中心，
        // 栏内滚过的卡片只有用视觉矩形算出来的中心才是屏幕上那个中心
        rects: [this.visualRectOf(card)],
        angle: card.rotation ?? 0,
      });
      return;
    }
    if (card.locked) return;

    // 标注（T3.09）跟着它标注的那张卡一起走：图片挪了位置、批注却留在原处，
    // 用户看到的就是"画好的标注丢了"（它看上去本来就是这张图的一部分）。
    // ★ 归属在**这一刻**算一次（纯函数），拖动过程里不重算 —— 否则图片一动归属
    //   就可能跳掉，标注会走一半停住，比不跟着走更让人困惑。
    // ★ 锁定卡会被 `rectsOf` 滤掉：锁住的标注也就钉在原地，与"锁定"的语义一致。
    const selected = [...this.selection.cardIds];
    const ids = [...selected];
    ids.push(...annotationsOn(this.board?.cards ?? [], selected));

    const rects = this.rectsOf(ids);
    if (rects.length === 0) return;
    // 拖出导出（T6.10 / `F6-04`）：只认**用户选中的卡片**，不认随行的标注 ——
    // 标注是"某张卡的批注"，它自己能 `toMarkdown` 也只是那几句批注；
    // 拖一张图片却额外多出一篇"批注"笔记，不是用户拖的时候想的事
    this.dragOut?.begin(selected);
    this.startDrag({
      kind: 'move',
      origin: detail.world,
      rects,
      align: this.alignConfig(ids),
    });
  }

  private startDrag(start: DragStart): void {
    this.dragKind = start.kind;
    this.dragAltKey = false;
    this.startDragSession();
    // 网格吸附（T3.11）：拖动开始那一刻取一份设置快照 —— 之后用户在别处改开关
    // 也不该让手里这张卡突然跳一格（见 `DragStart.grid`）
    this.dragController?.begin(
      start.kind === 'move' ? { ...start, grid: this.gridSnapConfig() } : start,
    );
  }

  /** 当前白板的网格吸附设置（T3.11）。`gridSize` 的坏值在 `normalizeGridSize` 里回落 */
  private gridSnapConfig(): GridSnapConfig {
    const board = this.board;
    return {
      enabled: board?.settings.snapToGrid === true,
      size: normalizeGridSize(board?.settings.gridSize ?? 0),
    };
  }

  /**
   * 智能参考线的对齐目标（T3.12）：除**正在拖**的那批之外的全部卡片。
   *
   * ★ 用视觉矩形（`visualRectOf`）而不是 `toCardRect`：参考线要对齐"屏幕上看到的位置"，
   *   而栏内滚动过的成员在模型里差着一整个滚动偏移（T2.03）；拿模型坐标算，
   *   会出现"参考线明明对着隔壁那张卡，卡片却停在别处"。
   * ★ 锁定的卡片**要**留在目标里 —— 它们不能被拖走，正是最可靠的参照物。
   * ★ 阈值由**屏幕像素**换算成世界像素（`÷ zoom`）：6px 说的是"眼睛看着够近"（详见
   *   `GUIDE_THRESHOLD_PX`）。缩到 30% 时若照搬 6 个世界像素，参考线几乎触发不了。
   */
  private alignConfig(movingIds: readonly string[]): AlignConfig {
    const moving = new Set(movingIds);
    const others: CardRect[] = [];
    for (const card of this.board?.cards ?? []) {
      if (moving.has(card.id)) continue;
      others.push(this.visualRectOf(card));
    }
    return { others, threshold: GUIDE_THRESHOLD_PX / this.viewport.zoom };
  }

  /**
   * 开启拖动会话：move / up / cancel 一律挂 window。
   *
   * 为什么挂 window：指针一旦拖出画布（甚至拖到侧栏）就收不到 move/up，
   * 拖动会"卡住"跟着鼠标不放，直到用户再点一下。代价是**必须成对摘除**，
   * 所以统一走 `startDragSession` / `endDragSession`。
   */
  private startDragSession(): void {
    this.endDragSession();
    const rect = this.canvasEl?.getBoundingClientRect();
    this.dragCanvasOrigin = rect ? { x: rect.left, y: rect.top } : { x: 0, y: 0 };

    const move = (event: PointerEvent): void => this.onDragMove(event);
    const up = (): void => this.onDragUp();
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    this.dragListeners = [
      () => window.removeEventListener('pointermove', move),
      () => window.removeEventListener('pointerup', up),
      () => window.removeEventListener('pointercancel', up),
    ];
  }

  private endDragSession(): void {
    for (const dispose of this.dragListeners.splice(0)) dispose();
    this.dragCanvasOrigin = null;
    // 还没落地的预览作废：松手后的位置由模型提交（`finish()`）来画，
    // 让这份迟到的预览再落地就是"松手后卡片跳回拖动中的位置"（T2.14）
    this.pendingDragPreview = null;
    this.appliedDragPreview = null;
    this.frameQueue.cancel(this.commitDragPreview);
    // 参考线是"拖动期间"的提示：手势一结束就得从画布上消失（T3.12）。
    // ★ 只在真的画过时才开帧清空，免得每次拖动结束都白刷一次整层
    if (this.dragGuides) {
      this.dragGuides = null;
      this.overlayLayer?.beginFrame();
    }
    // ★ 拖动结束 = 临时几何作废。不清掉的话连线会一直按"拖动中的位置"画：
    //   走 `finish()` 提交的路径上模型已经落到新位置，表现为"松手瞬间线抖一下"；
    //   走"收进分栏"的路径上卡片几何由栏算出来，线会**永远**停在一个错误的位置
    if (this.dragPreviewRects) {
      this.dragPreviewRects = null;
      this.edgeLayer?.invalidate();
    }
    // ★ 旋转的临时角度同理作废（T7.06）：不撤掉的话，转完一张接了线的卡之后，
    //   连线会一直按"手柄拖动中的角度"算锚点 —— 而那个角度早在松手时就落进模型了，
    //   唯一的结果是线头在一个错误的位置上钉死
    if (this.dragRotation) {
      this.dragRotation = null;
      this.edgeLayer?.invalidate();
    }
  }

  private onDragMove(event: PointerEvent): void {
    const origin = this.dragCanvasOrigin;
    if (!origin) return;
    // 手指一旦挪出容差就作废长按（T3.21）。★ 由检测器自己判距离，
    //   而不是"有 pointermove 就取消" —— 手指搭在屏幕上必然有微抖，
    //   那样写等于把长按彻底禁掉。
    this.longPress?.move({ x: event.clientX, y: event.clientY });
    // Alt 可能在拖动**中途**按下：每次都刷新，松手时才知道该不该复制
    this.dragAltKey = event.altKey;
    const world = this.viewport.toWorld({
      x: event.clientX - origin.x,
      y: event.clientY - origin.y,
    });

    // 分栏拖动走自己的会话（见 `columnDrag` 字段注释）
    if (this.columnDrag) {
      this.updateColumnDrag(world);
      return;
    }

    this.dragController?.update(world, {
      shift: event.shiftKey,
      alt: event.altKey,
      // Ctrl 临时反转网格吸附（T3.11）：开着变不吸、关着变吸
      ctrl: event.ctrlKey,
    });

    // 拖出导出（T6.10 / `F6-04`）：指针落到文件浏览器的文件夹上时，这一拖会变成"导出"。
    // ★ 必须排在落栏判断**之前** —— 后面要靠 `active` 决定谁让路
    // ★ Alt 中途按下就收起来（`suspend`）而不是 `cancel`：Alt 也能再松开，
    //   那时这条手势该重新变回"可能导出"。`cancel` 会把这一次拖动整个作废
    if (this.dragKind === 'move' && this.dragController?.isActive) {
      if (this.dragAltKey) this.dragOut?.suspend();
      else this.dragOut?.update(event.clientX, event.clientY);
    }

    // 只有"拖动卡片"才判落点：缩放一张卡不可能改它的归属（T1.55）。
    // Alt 复制也跳过 —— 复制出来的副本会落在拖到的位置，插进栏里不是用户要的
    if (this.dragOut?.active) {
      // 指针在文件浏览器上 → 这一拖的归宿是导出。画布里的落点提示必须让路，
      // 否则会同时亮着"插进这个分栏"和"导出到这个文件夹"两套提示
      this.clearDropTarget();
    } else if (this.dragKind === 'move' && !this.dragAltKey && this.dragController?.isActive) {
      this.updateDropTarget(world);
    } else {
      this.clearDropTarget();
    }
  }

  private onDragUp(): void {
    // 分栏拖动先分流：它有自己的一套提交（整栏 + 全部成员的几何）
    if (this.columnDrag) {
      this.finishColumnDrag();
      return;
    }

    // 拖出导出（T6.10 / `F6-04`）：松手落在文件浏览器的文件夹上 → 导出，并**取消**这次移动。
    // ★ 排在落栏判断之前：它要抢在"把卡插进某个栏"之前决定这一拖的归属
    // ★ 走取消而不是提交：导出是"另外存一份出去"，卡片留在原处才是这条手势的承诺 ——
    //   卡片跟着跳到侧栏外，用户的第一反应是"卡片被我弄丢了"
    if (this.dragKind === 'move' && this.dragOut?.finish()) {
      this.dragController?.cancel();
      this.clearDropTarget();
      this.longPress?.cancel();
      this.longPressCardId = null;
      this.dragAltKey = false;
      this.endDragSession();
      return;
    }

    // 落在某个分栏里 → 走"插入 + 重排"，而不是把拖到的坐标写死（T1.55）
    const target = this.dropTarget;
    if (target && this.dragKind === 'move' && !this.dragAltKey && this.dragController?.isActive) {
      this.dropCardsIntoColumn(target);
      return;
    }

    // 长按检测在这一刻收尾（T3.21）：松手了就绝不会再触发。
    // ★ 触发过长按（返回 `false`）时什么都不用补 —— `showCardMenuAtPoint`
    //   当时已经把拖动会话整个撤掉了，卡片一直停在原处。
    this.longPress?.cancel();
    this.longPressCardId = null;

    // 顺序：先 finish（此时 `dragAltKey` 还要用），再摘监听、最后复位修饰键
    this.dragController?.finish();
    // ★ `finish()` 之后再清落点：`commitDrag` 要读 `dropTarget` 是否为 `null`
    //   来决定"是不是拖出了分栏"（T1.56），提前清掉会让拖出的卡片一直留在栏里
    this.clearDropTarget();
    this.endDragSession();
    this.dragAltKey = false;
  }

  /** 卡片右键菜单（T1.41）。空白处右键由 `onCanvasContextMenu` 处理 */
  private showCardMenu(detail: CardPointerDetail): void {
    // 拦掉浏览器原生菜单；不拦的话会和系统右键菜单叠在一起
    detail.original.preventDefault();
    // 演示态（J-06）：卡片菜单全是编辑动作，一个都用不上；
    // 右上角的退出按钮与 Esc 已经够用（空白处右键另有一份演示菜单）
    if (this.presentation?.active) return;
    this.openCardMenu(detail.cardId, detail.original);
  }

  /**
   * 长按唤出卡片菜单（T3.21 / `02 §4.3`）。
   *
   * ★ 先把**拖动会话整条撤掉**再弹菜单：手指按住不动 500ms 的期间，
   *   `beginCardDrag` 早就已经 `startDrag` 了（它只看"按下"）。不撤的话
   *   用户松手时会走一次 `finish()`，把一次"静止的长按"提交成一条移动历史（距离为 0），
   *   历史面板里凭空多一条记录。
   *
   * ★ 撤销而不是 `cancel()` 后再补：`dragController.cancel()` 会把预览丢掉并重画，
   *   卡片原地不动 —— 这正是长按该有的表现。
   */
  private showCardMenuAtPoint(point: { x: number; y: number }): void {
    const cardId = this.longPressCardId;
    if (!cardId) return;
    // 长按期间用户可能已经松手去做别的（菜单在手指还按着时弹出 → up 事件会紧跟而来）。
    // 真的不在按了就什么都不做，免得弹出一个"鬼菜单"。
    this.dragController?.cancel();
    this.endDragSession();
    this.openCardMenu(cardId, point);
  }

  /**
   * 卡片定义上的 `menuItems`（`false` = 那一项**别摆**）→ 右键菜单规格层要的那份集合。
   *
   * ★ 一项都没关（或缺省）时给 `undefined`：规格层据此走"全都要"那条快路，
   *   不必每次右键都判一个空集合。
   */
  private hiddenMenuItemsOf(type: Card['type']): ReadonlySet<CardMenuItemKey> | undefined {
    const menuItems = this.cardRegistry.get(type)?.menuItems;
    if (!menuItems) return undefined;
    const hidden = new Set<CardMenuItemKey>();
    for (const [key, enabled] of Object.entries(menuItems)) {
      if (enabled === false) hidden.add(key as CardMenuItemKey);
    }
    return hidden.size > 0 ? hidden : undefined;
  }

  /**
   * 打开卡片菜单。`at` 可以是 `MouseEvent`（右键）或一个坐标（长按）。
   *
   * ★ 两个入口共用这一处：菜单里有什么、选中怎么变，**只写一遍**。
   *   分成两份实现的话，右键与长按迟早会漏掉彼此后来加的一项。
   */
  private openCardMenu(cardId: string, at: MouseEvent | { x: number; y: number }): void {
    const items = this.prepareCardMenu(cardId);
    if (items === null) return;
    if (at instanceof MouseEvent) showMenuAtMouse(at, items);
    else showMenuAtPoint(at, items);
  }

  /**
   * 卡片菜单的**那一串项**（右键 / 长按 / 脑图卡的**根节点**三处共用）。
   *
   * ★ 抽出来是为了根节点那一份（`F4`：无框之后卡片级入口挂在根节点上）能**原样**并进来 ——
   *   三处各写一份的话，往后加一项菜单必然漏掉其中一处。
   * ★ 副作用是有意的：右击 / 长按一张**没被选中**的卡要先把选区换成它。不换的话
   *   "改颜色"会作用在上一次选中的那批卡上 —— 用户看着 A 卡，改的却是 B 卡。
   *
   * @returns 菜单项；`null` = 没有这张卡（调用方什么都不做）
   */
  private prepareCardMenu(cardId: string): MenuItemSpec[] | null {
    const board = this.board;
    if (!board) return null;
    const card = board.cards.find((item) => item.id === cardId);
    if (!card) return null;

    if (!this.selection.hasCard(card.id)) this.selection.set({ cards: [card.id] });
    const ids = new Set(this.selection.cardIds);
    const selection = board.cards.filter((item) => ids.has(item.id));

    return buildCardMenuSpec({
      selection,
      target: card,
      actions: this.cardMenuActions(),
      typeItems: this.cardRegistry.contextMenu(card, { multiple: selection.length > 1 }),
      // 「编辑内容」只在"双击真的会进编辑态"的类型上给（`O35`）：文件 / 链接 / 图片 /
      // 地图 / 色板 / 白板 / 引用卡的双击都被类型自己接走，那一项点下去是跳转而不是编辑
      inlineEdit: this.cardRegistry.inlineEditable(card.type),
      // 类型**关掉**的通用菜单项（`A3` 仅标题卡：编辑内容 / 显示隐藏标题 / 收起卡片）：
      // 卡片定义里写 `menuItems: false` 的，在这里翻成一份集合递给规格层 ——
      // 规格层不认识类型名册（与 `inlineEdit` 同一种约定）
      hiddenItems: this.hiddenMenuItemsOf(card.type),
      grouped: groupOfCard(board, card.id) !== null,
      // 树关系（`F7`）：规格层看不见 `board.edges`，由这里算好递进去
      //（子级数 / 是否已折叠 / 有没有父级 —— 三个树菜单项的出场判据）
      tree: {
        childCount: treeChildrenIds(board, card.id).length,
        collapsed: card.treeCollapsed === true,
        hasParent: treeParentOf(board, card.id) !== null,
      },
      // 只读板（归档锁定 / 保护态）：规格层把会写模型的项全部置灰，
      // 只放行"打开源笔记 / 打开子板 / 拉预览"这三个纯读动作（T4.06）
      readOnly: this.isReadOnly(),
    });
  }

  /** 点卡片上的「+N」角标：展开子级（与菜单里「展开子级」同一条提交路径） */
  private dropTreeBadgeToggle(cardId: string): void {
    this.commit(t('history.treeCollapse'), (board) => {
      const card = board.cards.find((item) => item.id === cardId);
      return setTreeCollapsed(board, cardId, card?.treeCollapsed !== true);
    });
  }

  /**
   * 树连线松手（`F7`）：判定在模型层（`treeLinkState`），这里只分流 ——
   * `ok` 提交进撤销链；成环 / 已有父级弹提示（D1：拒绝，不静默、不覆盖）；
   * self（落回自己）= "算了"，静默取消。
   */
  private dropTreeLink(parentId: string, childId: string): void {
    const board = this.board;
    if (!board) return;
    const state = treeLinkState(board, parentId, childId);
    if (state === 'ok') {
      this.commit(t('history.treeLink'), (next) => linkTreeParent(next, parentId, childId));
      return;
    }
    if (state === 'cycle') new Notice(t('notice.treeCycle'));
    else if (state === 'has-parent') new Notice(t('notice.treeHasParent'));
    // 'self' / 'not-card'：前者是用户的"算了"，后者到不了这里（创建侧只认卡片）
  }

  /** 把菜单项接到视图能力上（`cards/` 层不认识这些方法，绑定在这一层完成） */
  private cardMenuActions(): CardMenuActions {
    const ids = (): string[] => [...this.selection.cardIds];
    return {
      edit: (id) => this.editCard(id),
      // 就地改名（`O37`：标题管着文件名的卡片要预填当前主名，见 `editCardTitle`）
      editTitle: (id) => this.editCardTitle(id),
      setShowTitle: (show) =>
        this.commit(t('history.title'), (board) => updateCards(board, ids(), { showTitle: show })),
      // 收起 / 展开（`O31`）：右键菜单那一项
      toggleCollapse: (id) => this.toggleCardCollapsed(id),
      // 树折叠（`F7`）：把这张卡的子级收成 +N / 展开回去（判定与展开的"删键"都在模型层）
      toggleTreeCollapse: (id) =>
        this.commit(t('history.treeCollapse'), (board) =>
          setTreeCollapsed(
            board,
            id,
            !(board.cards.find((c) => c.id === id)?.treeCollapsed === true),
          ),
        ),
      // 解除一层父子关系（`F7`）：删掉那条树线（子卡、孙卡都不动）
      unlinkTreeParent: (id) =>
        this.commit(t('history.treeUnlink'), (board) => unlinkTreeParent(board, id)),
      setColor: (color) =>
        this.commit(t('history.color'), (board) => updateCards(board, ids(), { color })),
      setAccent: (accent) =>
        this.commit(t('history.color'), (board) => updateCards(board, ids(), { accent })),
      pickColor: (current, apply) => pickColor(this.app, current, apply),
      bringToFront: () => this.bringSelectionToFront(),
      sendToBack: () => this.sendSelectionToBack(),
      copy: () => void this.copySelection(),
      cut: () => void this.cutSelection(),
      duplicate: () => this.duplicateSelection(),
      remove: () => this.deleteSelection(),
      promote: (id) => void this.promoteCard(id),
      toggleLock: (locked) =>
        this.commit(t('history.lock'), (board) => updateCards(board, ids(), { locked })),
      openSource: (card) => this.openSourceCard(card),
      relink: (id) => this.relinkCard(id),
      // 引用块（T7.10 / F10-07）：把引用卡定位到源笔记的某个标题 / 块
      pickBlock: (id) => this.openNoteRefTargetPicker(id),
      openBoard: (card) => this.openBoardCard(card),
      newChildBoard: (card) => void this.createChildBoardForCard(card.id),
      // 卡面预览档位（T7.09 / `F7-10` / `O09`）：菜单项只对着一张**有目标**的白板卡出现，
      // 档位是否等于当前值由下面那个方法自己判（规格层不该知道"点了没变"这件事）
      boardPreview: (card, preview) => this.setBoardRefPreview(card.id, preview),
      // 卡面图标（`O10`）：选择器只有视图弹得出来，选完照样走 `commit` 落盘
      pickBoardIcon: (id) => this.openBoardIconPicker(id),
      clearBoardIcon: (id) => this.setBoardRefIcon(id, null),
      // 深色便签（`O06`）：菜单项标题由规格层按当前变体取（"变深色" / "变浅色"），
      // 这里只管切一刀
      toggleNoteVariant: (id) => this.toggleNoteVariant(id),
      editCaption: (id) => this.requestCaptionEdit(id),
      // 明确的"我要改这张卡里的字"：跳过类型的 `activate`，直接进内容编辑态（T2.01）
      // ★ 连"先编标题"也一起跳过（O01）：这句话说得很死了 —— 是**字**，不是标题。
      //   想改标题的话，菜单里那一项就叫「编辑标题」，它就在旁边（O01 起它也不进阶到正文）
      editContent: (id) => this.editCard(id, true, 'raw'),
      cropImage: (id) => this.cropImageCard(id),
      toggleCardBorder: (id) => this.toggleCardBorderCard(id),
      // 卡片属性面板（`B1`）：右键第一项，打开右侧那个"这张卡的一切"的面板
      openInspector: (id) => this.openCardInspector(id),
      toggleLinkStyle: (id) => this.toggleLinkStyleCard(id),
      // 仅标题卡（`A3`）：**气泡 / 指针方向那两档已按用户要求去掉**（2026-09-18），
      // 所以这里不再有 `setTitleShape` / `setTitleTail` —— 那张卡现在只有纯圆角一种样子，
      // 样式（粗 / 斜 / 下划线 / 字色 / 底色 / 标记）全走通用的那几个口子。
      pickMapImage: (id) => this.pickMapImage(id),
      // 地图链接（O08）：粘贴一次 = 解析 + 存链接 + （配好了就）取一张静态地图
      pasteMapLink: (id) => void this.pasteMapLink(id),
      openMapLink: (id) => this.openMapLink(id),
      duplicateSyncNote: (id) => this.duplicateSyncNote(id),
      unsyncNote: (id) => this.unsyncNote(id),
      toggleCommentResolved: (id) => this.toggleCommentResolved(id),
      // 重置旋转（T7.06）：菜单项本身只在对着一张转过的卡时出现，这里不做判断
      resetRotation: (id) => this.resetRotation(id),
      pickFromImage: (id) => this.startEyedropper(id),
      inkColor: (id) => this.recolorInkCard(id),
      inkAnnotate: () => void this.startInk('brush'),
      fetchPreview: (id) => void this.fetchLinkPreviewCard(id),
      collectIntoColumn: () => this.collectIntoColumn(),
      splitIntoColumns: () => this.splitSelectionIntoColumns(),
      // 对齐 / 分布 / 编组（T3.13 / T3.14）：薄薄一层，规则全在模型层。
      // ★ 走 `alignTargets()` 而不是 `ids()`：栏内卡片与锁定卡不参与对齐
      //   （见 `alignTargets` 的说明），而"编组"用的是不排除任何卡片的另一份。
      align: (mode) => this.alignSelection(mode),
      distribute: (axis) => this.distributeSelection(axis),
      group: () => this.groupSelection(),
      ungroup: () => this.ungroupSelection(),
      // 演示路径（J-07）：菜单项由规格层按当前状态决定方向，这里只落地
      setPresentStep: (on) => this.setSelectionPresentStep(on),
      movePresentStep: (id, delta) => this.moveCardPresentStep(id, delta),
    };
  }

  /** 空白处双击 → 就地新建便签（`F1-07`） */
  private onCanvasDoubleClick(event: MouseEvent): void {
    // 演示态（J-06）：空白处双击本来是"就地在这一点新建便签"，
    // 而演示刻意不可编辑 —— 讲着讲着拍出一张新卡是最难收拾的一类误操作
    if (this.presentation?.active) return;
    const canvas = this.canvasEl;
    if (!canvas) return;

    // ★★ 两道闸，挡的都是"这一下双击**不是冲着我来的**"（真实报障：点开子板就多一张便签）：
    //   ① 画布这次装载之后必须先**被按下过**（换板时标记被清掉，见 `canvasPressSeen`）；
    //   ② 目标必须**真的在这个画布里**（换板那一刻 `event.target` 可能已经是摘掉的旧卡，
    //      那种元素 `contains` 为假 ⇒ 不能当"空白处双击"处理）。
    const pressed = this.canvasPressSeen;
    this.canvasPressSeen = false;
    if (!pressed) return;
    if (!(event.target instanceof Node) || !canvas.contains(event.target)) return;
    // 卡片上的双击由委托层处理，但事件仍会冒泡到 canvas ——
    // 不排掉就会变成"进编辑 + 在卡片屁股底下新建一张"
    if (resolveCardElement(event.target, canvas)) return;
    // 分栏背景上的双击不新建卡片（T1.54）：
    // ★ 为什么直接放弃而不是"新建到栏里"：`createNoteAt` 造出的是**自由卡片**，
    //   它会压在这一栏上面却**不属于**这一栏 —— 用户随后拖动这一栏时就会发现
    //   "这张卡怎么没跟着走"。想往栏里加卡片，拖进去（T1.55）是唯一不会产生歧义的路。
    if (isInsideColumn(event.target)) return;
    const rect = canvas.getBoundingClientRect();
    this.createNoteAt(
      this.viewport.toWorld({ x: event.clientX - rect.left, y: event.clientY - rect.top }),
    );
  }

  /** 空白处右键 → 画布菜单（`F1-08`） */
  private onCanvasContextMenu(event: MouseEvent): void {
    const canvas = this.canvasEl;
    if (!canvas) return;
    if (resolveCardElement(event.target, canvas)) return;
    // 分栏上的右键菜单由 `ColumnLayer` 自己弹（它已经 `preventDefault` 过了）。
    // ★ 不排掉这一路的话，右键一栏会连弹两个菜单：先栏的、再画布的，后者盖住前者 ——
    //   用户看到的是"分栏菜单里全是画布的动作"。
    if (isInsideColumn(event.target)) return;

    // 脑图容器上的右键（`2.2.0` 收尾 · 演示对接）：树是白板的一等公民，
    // 它该有自己的菜单（这一批放演示四项）。★ 节点上的右键由 `EmbedMind` 自己接走
    // （节点菜单），那一侧会 `preventDefault` + `stopPropagation`，到不了这里。
    const rect = canvas.getBoundingClientRect();
    const screen = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    // ★ 两条判据一起用：DOM 上找得到就最快（正好压在节点上那种），找不到再按**几何**
    //   判一次（树身上那些缝隙 —— 容器是 0×0 的锚点，DOM 那里根本没有可命中的面）。
    const mindId =
      this.resolveMindIdAt(event.target) ??
      this.mindLayer?.mindAtPoint(this.viewport.toWorld(screen)) ??
      null;
    if (mindId !== null) {
      event.preventDefault();
      if (!this.selection.hasMind(mindId)) this.selection.set({ minds: [mindId] });
      this.showMindMenu(mindId, event);
      return;
    }

    // 连线的右键（T1.69）：线画在空白处，不先判就会被画布菜单抢走。
    // ★ 右击一条没选中的线就选中它 —— 菜单里的动作必须作用在"用户指着的那条线"上，
    //   否则改样式会落在上一次选中的线上（与卡片菜单同一条纪律）
    const edgeId = this.hitEdgeAt(screen);
    if (edgeId) {
      event.preventDefault();
      if (!this.selection.hasEdge(edgeId)) this.selection.set({ edges: [edgeId] });
      this.showEdgeMenu(edgeId, event);
      return;
    }

    event.preventDefault();
    this.showCanvasMenu(this.viewport.toWorld(screen), event);
  }

  /**
   * 右键落点是不是某个脑图容器；是则给出它的 id。
   *
   * ★ 只认容器（`data-mind-id`）—— 节点自己有 `data-mind-node-id` 与一套菜单，
   *   由 `EmbedMind` 接走（见 `onCanvasContextMenu` 里的说明）。
   */
  private resolveMindIdAt(target: EventTarget | null): string | null {
    if (!(target instanceof HTMLElement)) return null;
    const el = target.closest<HTMLElement>(`[${MIND_CONTAINER_ID_ATTR}]`);
    return el?.getAttribute(MIND_CONTAINER_ID_ATTR) ?? null;
  }

  /**
   * 一棵脑图的右键菜单（`2.2.0` 收尾 · 演示对接）。
   *
   * ★ 与卡片菜单同一条纪律：菜单要 Obsidian 的 `Menu`，而 `MindLayer` 不认识它 ——
   *   视图在这一层把"规格（`buildMindMenuSpec`）"接到"能力（`commit` 那几个动作）"上。
   */
  private showMindMenu(mindId: string, event: MouseEvent): void {
    const board = this.board;
    if (!board) return;
    const mind = (board.minds ?? []).find((item) => item.id === mindId);
    if (!mind) return;

    showMenuAtMouse(event, this.mindPresentationItems(mindId));
  }

  /**
   * 一棵树的**演示四项**（`2.2.0` 收尾）。
   *
   * ★ 两处右键共用一份：**树身**（`showMindMenu`）与**树里的任意节点**
   *   （`showMindNodeMenu` —— 那一份菜单本来就有树级的「导出为 .nestmind」，
   *   用户 2026-09-22 实测的 F1 就是"在节点上右键，菜单里没有加入演示"）。
   *   两份各写一遍的话，加入演示的措辞与可用性迟早分叉。
   * ★ 动作按**树 id**走，不按选区：右键一棵树之后再选它与否，都该改这一棵。
   */
  private mindPresentationItems(mindId: string): MenuItemSpec[] {
    const board = this.board;
    if (!board) return [];
    const ordered = explicitPresentSteps(board);
    const index = ordered.findIndex((item) => item.id === mindId);
    return buildMindMenuSpec(
      {
        inPresentation: index >= 0,
        canMoveEarlier: index > 0,
        canMoveLater: index >= 0 && index < ordered.length - 1,
      },
      {
        addToPresentation: () => this.addMindToPresentation(mindId),
        removeFromPresentation: () => this.removeMindFromPresentation(mindId),
        moveEarlier: () => this.moveCardPresentStep(mindId, -1),
        moveLater: () => this.moveCardPresentStep(mindId, 1),
      },
    );
  }

  /** 把**这一棵**树加进演示路径（右键菜单用；与选区那条走同一个提交与提示） */
  private addMindToPresentation(mindId: string): void {
    this.commit(t('history.presentAdd'), (board) => addToPresentation(board, [mindId]));
    const step = this.presentStepOfId(mindId);
    if (step !== null) new Notice(t('notice.presentAdded', { step }));
  }

  /** 把**这一棵**树移出演示路径 */
  private removeMindFromPresentation(mindId: string): void {
    if (
      this.commit(t('history.presentRemove'), (board) => removeFromPresentation(board, [mindId]))
    ) {
      new Notice(t('notice.presentRemoved'));
    }
  }

  /**
   * 弹出画布菜单。`world` 是**按下的那一刻**锁定的世界坐标，`at` 是鼠标事件或坐标。
   *
   * ★ 右键与长按共用这一处（T3.21）：移动端没有右键，"长按空白 → 新建菜单"
   *   是同一张菜单的另一个入口（`02 §6`）。分两份写的话，两边迟早会漏掉彼此
   *   后来加的一项 —— 而"手机上少一个菜单项"是最难被发现的那种缺陷
   *   （开发在桌面上用的是右键）。
   */
  private showCanvasMenu(
    world: { x: number; y: number },
    at: MouseEvent | { x: number; y: number },
  ): void {
    // 演示态（J-06）：换成演示菜单 —— 画布菜单第一项是"新建便签"，
    // 而演示刻意不可编辑（"点了没反应"的一排编辑项比少几项更让人困惑）
    const presentation = this.presentation;
    if (presentation?.active) {
      const items = buildPresentationMenuSpec(
        {
          previous: () => presentation.previous(),
          next: () => presentation.next(),
          overview: () => presentation.overview(),
          exit: () => presentation.stop(),
        },
        { index: presentation.index, total: presentation.total },
      );
      if (at instanceof MouseEvent) showMenuAtMouse(at, items);
      else showMenuAtPoint(at, items);
      return;
    }

    const readOnly = this.isReadOnly();
    const items = buildCanvasMenuSpec({
      // 菜单项在**按下右键 / 长按触发时**就锁定了世界坐标：之后即便视口被键盘挪动，
      // "在这一处新建"仍然是用户当时指的那一处
      //
      // ★ 只读板（归档锁定 / 保护态）上会改模型的项**一个都不传**，只留"看"的与解锁：
      //   空白处右键本来就该是"在这儿放点什么"，一排灰着的"新建便签"没有信息量
      //   （卡片菜单那边相反的取舍 —— 那边是"这张卡能干嘛"，灰着才说得清边界）
      // 过滤条开关（`2.2.0` · O3）：**只读板上也给** —— 它不改模型，只是"换一种看法"
      toggleFilter: () => this.toggleCardFilter(),
      ...(readOnly
        ? {}
        : {
            newNote: () => this.createNoteAt(world),
            // 同步便签（T7.04）：与便签同在"空白纸"那一批
            newSyncNote: () => this.createSyncNoteAt(world),
            // 评论卡（T7.05）：同样是一张"落卡即写"的空白纸
            newComment: () => this.createCardAt(world, 'comment'),
            newTodo: () => this.createCardAt(world, 'todo'),
            newSwatch: () => this.createCardAt(world, 'swatch'),
            newLink: () => this.promptLinkAt(this.clientPointOf(world)),
            newColumn: () => this.createColumnAtClient(this.clientPointOf(world)),
            // 新增的四张卡（`A1`–`A4`，用户 2026-09-18："新增的卡片类型都要放到右键菜单里"）
            newTitleCard: () => this.createCardAt(world, 'titleCard'),
            newGallery: () => this.createCardAt(world, 'gallery'),
            // 内嵌脑图卡（`F4`，用户 2026-09-21："直接在白板内部建立的脑图"）——
            // 一张"空白纸"：落下来就是"中心主题 + 3 个空分支"，光标直接进中心主题
            newMind: () => this.createMindAt(world),
            // ★ 视频 / 音频要先弹库内文件选择器，而**菜单一关会把它一起带走** ⇒
            //   延到下一拍再开（菜单先收干净，模态框才不会被连带关掉）。
            //   用 `clientPointOf` 锁住"右键的那一处"，而不是"延后那一刻的指针"。
            newVideo: () => {
              const at = this.clientPointOf(world);
              setTimeout(() => this.openVaultFilePicker('video', at), 0);
            },
            newAudio: () => {
              const at = this.clientPointOf(world);
              setTimeout(() => this.openVaultFilePicker('audio', at), 0);
            },
            draw: () => this.startInk('brush'),
            // 整理类（T6.07 / T6.08）：都会重排/改写整块板子，只读板上同样不给
            tidyBoard: () => this.tidyBoard(),
            groupByTag: () => this.groupByTag(),
          }),
      // 演示（J-06）：**只读板上照样给** —— 演示不改任何数据（见 `cardMenu.ts`）
      startPresentation: () => this.startPresentation(),
      selectAll: () => this.selectAll(),
      // 编组 / 取消编组（`⌘G` 的另一条路）：框选能框住分栏，而那时右键落在空白处 ——
      // 没有这一对的话，"多栏编组"就只剩键盘与命令面板两条路（见 `CanvasMenuActions`）
      ...(this.canGroupSelection ? { group: () => this.groupSelection() } : {}),
      ...(this.canUngroupSelection ? { ungroup: () => this.ungroupSelection() } : {}),
      fitContent: () => this.fitContent(),
      zoomReset: () => this.zoomToActualSize(),
      // 锁定 / 解锁（T4.06）：只给**当下那个方向**，两个都给的话
      // 总有一行是点了必定失败的
      ...(this.canLockBoard ? { lockBoard: () => this.lockBoard() } : {}),
      ...(this.canUnlockBoard ? { unlockBoard: () => this.unlockBoard() } : {}),
    });

    if (at instanceof MouseEvent) showMenuAtMouse(at, items);
    else showMenuAtPoint(at, items);
  }

  /**
   * 世界坐标 → 客户端坐标（`null` = 画布还没量到尺寸）。
   *
   * ★ 存在的理由是"链接 / 分栏 / 白板"这三个入口走的是**同一个**落点参数
   *   （客户端坐标），而右键菜单手里只有世界坐标 —— 与其让它们各写一遍换算，
   *   不如在这里换算一次，让"落点"这个概念在整条链路上只有一个单位。
   */
  private clientPointOf(world: { x: number; y: number }): { x: number; y: number } | null {
    const rect = this.canvasEl?.getBoundingClientRect();
    if (!rect) return null;
    const screen = this.viewport.toScreen(world);
    return { x: screen.x + rect.left, y: screen.y + rect.top };
  }

  /**
   * 连线右键菜单（T1.69 / `F3-05`）：线型 / 箭头 / 走线 / 弧度 / 标签 / 颜色 / 删除。
   *
   * 规格由 `cardMenu.ts` 产出（可单测），这里只把动作接到视图能力上 ——
   * 与 `cardMenuActions()` 是同一种分层。
   *
   * ★ 动作一律作用在**右击的那一条**（`edgeId`）而不是选区：右击时 `onCanvasContextMenu`
   *   已经把它选上了，但"菜单改的是我指着的那条线"这件事应该由参数本身保证，
   *   而不是依赖另一段代码先做对了选择（否则将来多一个入口就会漏改）。
   */
  private showEdgeMenu(edgeId: string, event: MouseEvent): void {
    const edge = this.board ? edgeById(this.board, edgeId) : null;
    if (!edge) return;
    showMenuAtMouse(
      event,
      buildEdgeMenuSpec({
        edge,
        // 只读板（T4.06）：连线菜单没有"纯读"项，整个置灰
        readOnly: this.isReadOnly(),
        actions: {
          setStyle: (style) => this.patchEdge(edgeId, t('history.edgeStyle'), { style }),
          setEnds: (fromEnd, toEnd) =>
            this.patchEdge(edgeId, t('history.edgeStyle'), { fromEnd, toEnd }),
          setColor: (color) => this.patchEdge(edgeId, t('history.edgeColor'), { color }),
          pickColor: (current, apply) => pickColor(this.app, current, apply),
          // 走线方式（T7.11）：换成 smart 时**保留** `curve` 键 —— 它此刻不参与
          // 绘制（路由优先），但用户切回 free 时那条弯应该原样回来，而不是被这次
          // "换个走法"顺手删掉（那是一次看不见的数据丢失）
          setRouting: (routing) => this.patchEdge(edgeId, t('history.edgeRouting'), { routing }),
          // 拉直（T7.12）：删掉 `curve` 键。菜单里这一项只在确实弯着时出现
          straighten: () => this.patchEdge(edgeId, t('history.edgeStraighten'), { curve: null }),
          // 标签（T7.13）：空输入 = 清除，与 `EdgeLabelModal` 的约定同源
          editLabel: () =>
            new EdgeLabelModal(this.app, edge.label, (label) => {
              if (label === null) return; // 取消：什么都不做
              this.patchEdge(edgeId, t('history.edgeLabel'), { label });
            }).open(),
          clearLabel: () => this.patchEdge(edgeId, t('history.edgeLabel'), { label: '' }),
          // 删单条线也走 `deleteSelection`：这样"菜单删除"与"按 Delete"
          // 是**同一条**代码路径，不会出现"菜单能删、快捷键删不掉"这种分叉
          remove: () => {
            this.selection.set({ edges: [edgeId] });
            this.deleteSelection();
          },
        },
      }),
    );
  }

  /**
   * 改**指定的一条**连线字段，走 `commit` 记历史。
   *
   * ★ 与卡片那批 `patchSelection` 不同：连线的批量修改没有入口
   *   （画布上不会同时"选中几条线"再改样式），所以这里收 id 而不是读选区 ——
   *   少一条"选区此刻是什么"的隐含依赖。
   */
  private patchEdge(edgeId: string, label: string, patch: EdgePatch): void {
    this.commit(label, (board) => updateEdges(board, [edgeId], patch));
  }

  // ── 连线弧度手柄（T7.12 / F3-07） ─────────────────────────

  /**
   * 当前**可以**调弧度的那条线；没有则 `null`。
   *
   * 三条判断集中在这里，`EdgeCurveController` 不重复：
   *  * 单选一条线 —— 多选时"调哪条"没有答案；
   *  * `routing !== 'smart'` —— 智能走线是算出来的，拖一个手柄去改它没有意义
   *    （`schema.Edge.curve` 的注释写明了"只在 free 下有意义"）；
   *  * 只读 / 演示态 —— 与锚点、框选同一套守门（`canStart` 那一条只管起手，
   *    这里再挡一次是为了让"手柄根本不出现"，而不是"出现但拖不动"）。
   */
  private activeCurveEdge(): Edge | null {
    if (this.isReadOnly() || this.presentation?.active) return null;
    const board = this.board;
    if (!board || this.selection.edgeIds.size !== 1) return null;
    const [id] = this.selection.edgeIds;
    const edge = edgeById(board, id);
    if (!edge || edge.routing === 'smart') return null;
    return edge;
  }

  /**
   * 一条线的两端锚点（T7.12）。
   *
   * ★ 必须走**视觉**几何：栏内滚动（T2.03）、拖动预览（T1.70）、旋转（T7.06）
   *   都会让卡片出现在模型坐标之外的地方，而线本身是按视觉坐标画的 ——
   *   手柄按模型坐标算就会在滚过内容的栏里飘到别处（与 `hitEdgeAt` 同一条纪律）。
   */
  private curveEndpointsOf(edge: Edge): EdgeEndpoints | null {
    return edgeEndpoints(edge, this.cardRectLookup(), (cardId) => this.angleOfCard(cardId));
  }

  /** 卡片此刻的旋转角（度）：拖动预览覆盖模型值（T7.06） */
  private angleOfCard(cardId: string): number {
    const override = this.dragRotation?.get(cardId);
    if (override !== undefined) return override;
    return this.board?.cards.find((card) => card.id === cardId)?.rotation ?? 0;
  }

  /**
   * 拖动中的临时弧度（T7.12）：写覆盖表 + 重画连线，**不写模型**。
   *
   * ★ 拖动期间不提交，与卡片拖动同一个理由：每动一下就 `commit` 的话，
   *   一次拖动会在撤销栈里留下几百步。
   */
  private previewEdgeCurve(edgeId: string, curve: EdgeCurve | null): void {
    this.dragCurve = new Map([[edgeId, curve]]);
    this.edgeLayer?.invalidate();
  }

  /**
   * 撤掉临时弧度（松手 / Esc 取消都走这里）。
   *
   * ★ 是**删键**而不是"再 preview 一遍模型里的旧值"：后者会在覆盖表里留下一项
   *   "恰好等于模型值"的条目，以后模型真的变了，这一项还会盖住新值 ——
   *   典型的"改一次没反应、改第二次才对"。理由与 `onPreviewEnd` 的注释同源。
   */
  private endPreviewEdgeCurve(edgeId: string): void {
    if (!this.dragCurve?.has(edgeId)) return;
    const next = new Map(this.dragCurve);
    next.delete(edgeId);
    this.dragCurve = next.size > 0 ? next : null;
    this.edgeLayer?.invalidate();
  }

  /**
   * 松手：把弧度正式写进模型（一步撤销）。`null` = 拉直（删键）。
   *
   * ★ 值没变就**什么都不做**：在手柄上点一下不拖、或者拖回原位又松手，
   *   不应该在撤销栈里留下一步空操作（用户按 ⌘Z 会看到"什么都没发生"）。
   */
  private commitEdgeCurve(edgeId: string, curve: EdgeCurve | null): boolean {
    const board = this.board;
    const current = board ? edgeById(board, edgeId) : null;
    const next = normalizeEdgeCurve(curve);
    if (current && sameEdgeCurve(current.curve ?? null, next)) return false;
    return this.commit(t('history.edgeCurve'), (draft) =>
      updateEdges(draft, [edgeId], { curve: next }),
    );
  }

  /**
   * 画布按键（`02 §4.1`）。只处理"此刻没有更该拿键的人"的三件事，
   * 并且只在**画布持有焦点**时生效（监听挂在 canvas 上而非 window 上）。
   *
   * 方向键 / Delete / Enter 同时也在命令表里（用户能在设置里看见、能改键），
   * 所以这里先看 `defaultPrevented`：若 Obsidian 已在捕获阶段处理过，就不再重复执行一次。
   */
  private onCanvasKeyDown(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.isComposing) return;

    // 演示模式（J-06）：键盘先归它挑一遍 —— `→/←/1~9/O/Esc/⌘⇧P` 都在里面。
    // ★ 带 `⌘/⌥` 的组合键它会放行（缩放、切标签页、命令面板都得能用）
    if (this.presentation?.handleKey(event)) return;
    // 演示态下**其余编辑键全部失效**（Delete / Enter / 对齐 / 分栏…）。
    // ★ 只靠"进入时清空选区"是不够的：演示中仍可能用 Tab 把焦点移到某张卡上
    //   （`focusin` 会把选区同步过去），那时按 Delete 就删掉了正在讲的那张
    if (this.presentation?.active) return;

    // Esc：取消正在进行的拖动（其余 Esc 语义归框选控制器 / 状态机）
    if (event.key === 'Escape') {
      if (this.dragController?.isActive) {
        this.dragController.cancel();
        this.endDragSession();
        this.dragAltKey = false;
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }

    if (this.isEditingCard || this.isReadOnly()) return;

    // ★ 卡内节点（`2.2.0` 收尾 · 用户 2026-09-23）：**键盘先归它** —— Tab 加子级、
    //   回车加同级、方向键换选中、F2 改名、Shift+Tab 提升一层、Delete 删掉它，
    //   与 `.nestmind` 视图**同一张键位表**（`mindKeyActionOf`）。
    //   ★ 它在"只认卡片"的那些键**之前**：焦点在某个节点上时，Tab/回车该归那棵树，
    //     而不是去开卡片编辑器（那是"选中一张卡"的语义）。
    //   ★ 没接下的（返回 `false`）照旧往下走：`⌘` 组合、空格平移、卡片那一套都不受影响。
    if (this.handleMindNodeKey(event)) return;

    // 分栏相关的组合键（`F2-7-7` / `F2-7-8`）先处理：
    // ★ 它们与"选中了什么"无关（选区里没有卡片时也要能按），所以必须排在
    //   下面那句 `cardIds.size === 0` 的提前返回之前
    const modified = event.metaKey || event.ctrlKey;
    if (modified && event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      this.splitSelectionIntoColumns();
      return;
    }
    // 编组 / 取消编组（T3.14 / `F5-05`）。
    // ★ 键位：**`⌘⌥G` = 编组**、`⌘⇧G` = 取消编组（`⌘` 与 `⌘⌥⇧` 也放行）。
    //   `⌘G` **不能当主键**：Obsidian 自己占着它（「打开关系图谱」）——
    //   用户 2026-09-16 报"按 ⌘G 会打开关系图谱"，就是这个原因。
    //   所以编组挪到 `⌘⌥G`（不撞任何人）；`⌘G` 这里**照样接受**，
    //   用户在「设置 → 快捷键」里把关系图谱挪开之后它就归我们了。
    // ★ `⌘⌥G` 以前是"取消编组"（`T3.14` 的旧写法），现在让给编组 —— 编组是常用动作，
    //   得有一个**一定按得到**的键；取消编组跟着 `⇧` 走（与"编组 / 取消"这对的其余键位一致）。
    if (modified && (event.key === 'g' || event.key === 'G')) {
      event.preventDefault();
      event.stopPropagation();
      if (event.shiftKey) this.ungroupSelection();
      else this.groupSelection();
      return;
    }
    // 对齐（T3.13 / `F5-04`）：`⌥⌘` + 四向箭头。
    if (modified && event.altKey) {
      const mode = ALIGN_HOTKEYS[event.key];
      if (mode) {
        event.preventDefault();
        event.stopPropagation();
        this.alignSelection(mode);
        return;
      }
    }

    // 选中栏时 Delete 删的是**栏**（卡片留在画布上），想连卡片一起删有右键菜单里
    // 那条明确写着数量的项（T1.60）。
    // ★ 栏可以选中**多个**（框选，用户 2026-09-16）⇒ 一次提交全删掉，
    //   而不是逐个 `commit`（那样按 N 下 ⌘Z 才退得回去）
    const selectedColumns = [...this.selection.columnIds];
    if (selectedColumns.length > 0 && (event.key === 'Delete' || event.key === 'Backspace')) {
      event.preventDefault();
      event.stopPropagation();
      this.commit(t('history.delete'), (board) => {
        let did = false;
        for (const id of selectedColumns) {
          if (removeColumn(board, id, 'release')) did = true;
        }
        // `release`（卡片留在原地）与"拖出分栏"是同一种结局：栏撑过的宽高要还给迷你卡
        if (repinMiniBoardRefs(board)) did = true;
        return did;
      });
      return;
    }

    // ★ 删除**必须排在下面那道"只认卡片"的早退之前**（用户 2026-09-22 实测：C5/C6）：
    //   从前这里先 `if (cardIds.size === 0) return`，于是"只选中一棵树 / 几个节点"
    //   按 Delete **毫无反应** —— 而 `deleteSelection()` 早就两种都认。
    //   把它放在早退之前，是"这道早退管的是下面那些**只对卡片有意义**的键"这件事
    //   唯一说得通的写法。
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      event.stopPropagation();
      this.deleteSelection();
      return;
    }

    if (this.selection.cardIds.size === 0) return;

    const delta = nudgeDelta(event.key, event.shiftKey);
    if (delta) {
      event.preventDefault();
      event.stopPropagation();
      // 连按方向键合并成一步撤销：用户心里这就是"把这张卡挪过去"这一个动作
      this.commit(
        t('history.move'),
        (board) => translateCards(board, [...this.selection.cardIds], delta.x, delta.y),
        'nudge',
      );
      return;
    }

    if (event.key === 'Enter' && this.selection.cardIds.size === 1) {
      event.preventDefault();
      event.stopPropagation();
      // `⌘`+Enter 与 `⌘`+双击同义：跳过"先编标题"那一步，直接进正文（O01）
      this.editSelection(event.metaKey || event.ctrlKey);
    }
  }

  /**
   * 记下鼠标位置（**原始 client 坐标**）。
   *
   * 刻意**不换算成世界坐标**：那需要一次布局读（`getBoundingClientRect`），
   * 而鼠标每移动一像素都会触发这个监听。换算推迟到真正需要它的那一刻
   * （`newNoteAtCursor`），那时一次布局读完全承受得起。
   */
  private onCanvasPointerMove(event: PointerEvent): void {
    this.lastPointerClient = { x: event.clientX, y: event.clientY };
    // 长按空白期间的移动由检测器自己判距离（T3.21）：挪出容差就作废。
    // ★ 不能"有 move 就取消" —— 手指搭在屏幕上必然有微抖，那样等于把长按禁掉
    this.canvasLongPress?.move({ x: event.clientX, y: event.clientY });
  }

  /**
   * 空白处长按到点（T3.21）。
   *
   * ★ 换算成世界坐标**只在触发的那一刻**做一次：长按之前手指可能停在原地，
   *   期间视口可能被键盘 / 触控板挪动，所以"按住那一刻的世界坐标"必须在
   *   这一刻现算 —— 提前算好会得到一个过期落点。
   */
  private onCanvasLongPress(point: { x: number; y: number }): void {
    const rect = this.canvasEl?.getBoundingClientRect();
    if (!rect) return;
    this.showCanvasMenu(
      this.viewport.toWorld({ x: point.x - rect.left, y: point.y - rect.top }),
      point,
    );
  }

  /** 让画布拿到键盘焦点（否则方向键微移 / Delete / Enter 都收不到） */
  private onCanvasPointerDown(event: PointerEvent): void {
    // ★ 先记账：这一次装载之后画布上**真的被按过**（见 `canvasPressSeen` 的说明）。
    //   放在最前面 —— 连"点进输入框"那一路也要记上，否则"点在编辑器里"之后紧跟的双击
    //   会被当成来路不明的双击（那一档 `resolveCardElement` 本来就会拦，但两道判据
    //   互相独立更稳）
    this.canvasPressSeen = true;

    // 点输入框（标题框 / 正文编辑器）时不抢焦点，否则光标刚点进去就飞走
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      target.closest('input, textarea, [contenteditable="true"]')
    ) {
      return;
    }
    this.focusCanvas();
    // 演示聚焦还在飞（J-06）：用户一按指针就停飞 —— 让动画和手动平移抢画面，
    // 看起来像"这块板卡住了"（与 `cancelFlight` 的说明一致）
    this.presentation?.cancelFlight();

    // 按在**卡片之外**（空白 / 分栏背景）= "不看那个节点了"：卡内脑图那一路收掉，
    // 底部那条栏随之收起（`F4`）。
    // ★ 判据与下面那条长按同源（`resolveCardElement` 为 `null`）；点**卡片**的按下
    //   不会走到这一句（卡内节点自己 `stopPropagation`，卡片空白区则由选区订阅那条路
    //   处理 —— 那时选区换成了那张卡，`syncQuickBar` 会把旧节点清掉）。
    if (this.canvasEl !== null && resolveCardElement(event.target, this.canvasEl) === null) {
      this.clearMindNodeFocus();
    }

    // 空白处长按 → 新建菜单（T3.21 / `02 §6`）。★ 只对触摸 / 笔生效：
    // 桌面鼠标按住不动半秒弹菜单纯属干扰（而右键本来就好用）。
    // ★ 落在卡片 / 分栏上的按下要排掉：卡片走委托层（那里有卡片菜单），
    //   分栏有自己的菜单 —— 都轮不到画布菜单来抢。
    const canvas = this.canvasEl;
    if (
      event.pointerType !== 'mouse' &&
      canvas !== null &&
      !isInsideColumn(event.target) &&
      resolveCardElement(event.target, canvas) === null
    ) {
      this.canvasLongPress?.start({ x: event.clientX, y: event.clientY });
    }
  }

  /** 空白处长按期间的松手 / 系统打断：作废这次长按（T3.21） */
  private onCanvasPointerRelease(): void {
    this.canvasLongPress?.cancel();
  }

  private focusCanvas(): void {
    const canvas = this.canvasEl;
    if (!canvas || canvas.ownerDocument.activeElement === canvas) return;
    // `preventScroll`：聚焦画布不该让整个 leaf 滚一下
    canvas.focus({ preventScroll: true });
  }

  /**
   * 按 id 取**拖动目标**的矩形（保持 `board.cards` 顺序 —— `applyCardRects` 与复制对位依赖它）。
   *
   * ★ 取的是**视觉**几何（`visualRectOf`），因为这一个数组同时喂给两个地方：
   *   `DragController`（预览 = 用户看到的）与 `applyCardRects`（落盘）。
   *   两者必须是同一份 —— 在栏内滚动过的栏里，用模型值会让卡片在**按下的一瞬间**
   *   就跳出去（它"模型所在"的位置离屏幕上的位置差了整个滚动偏移）。
   *   成员卡片的位置本来就由 `relayoutColumns` 重新算，所以这里写视觉值不会被"记错"。
   *
   * ★ **锁定卡不在结果里**（T2.08 / `F2-00-6`）。选中框很容易顺手圈住一张锁定的卡，
   *   如果它跟着一起动，"锁定"在最常见的"框一片再拖"场景下就等于没锁。
   *   过滤放在这里而不是各个调用点：拖动、复制、拖出分栏的 id 列表**全都**来自
   *   这个数组，只有一处过滤才不会有漏网的那条路径。
   */
  private rectsOf(ids: readonly string[]): CardRect[] {
    const targets = new Set(ids);
    return (this.board?.cards ?? [])
      .filter((card) => targets.has(card.id) && !card.locked)
      .map((card) => this.visualRectOf(card));
  }

  /** 选区恰好只有一张卡片时返回它，否则 `null` */
  private selectionOnlyCard(): Card | null {
    if (this.selection.cardIds.size !== 1) return null;
    const [id] = this.selection.cardIds;
    return this.board?.cards.find((card) => card.id === id) ?? null;
  }

  // ── 自动高度（T1.38） ───────────────────────────────────

  /**
   * 内容量出来比卡片高 → 记下目标高度，**延到下一帧统一提交**。
   *
   * 为什么不能就地 `mutate`：调用链是
   * `mutate → changed → applyBoard → syncCanvas → 卡片层遍历 DOM → measureContent`，
   * 在遍历途中改模型会让 `board.cards` 在迭代中被替换 —— 轻则漏渲染，重则半截状态。
   */
  private growCard(cardId: string, height: number): void {
    const card = this.board?.cards.find((item) => item.id === cardId);
    if (!card) return;
    this.requestCardSize(cardId, { width: card.width, height });
  }

  /**
   * 把某张卡撑到**至少**这个尺寸（两个方向都只增不减，超出的部分下一帧一次性提交）。
   *
   * ★ 两个调用方：自动高度（`growCard`，宽度原样传回）与**脑图卡**的"内容说了算"
   *   （`F4`，见 `cards/registry.ts` 的 `growTo`）。
   * ★ 只增不减的理由（与自动高度同一条）：**分不清**"这个尺寸是内容撑出来的还是用户
   *   手拉的"，缩回去就是危险的那一侧 —— 用户摆好的版面被一次内容变动压扁，还没法撤销回来。
   *   （脑图卡现在没有缩放手柄，尺寸完全由内容决定，但这条纪律仍然留着：将来再加手动尺寸时
   *   不必回头改这里。）
   */
  private requestCardSize(cardId: string, size: Size): void {
    // `O31`：收起卡的内容槽是 `display:none`，此时量出来的尺寸没有意义
    const card = this.board?.cards.find((item) => item.id === cardId);
    if (!card || card.collapsed === true) return;
    if (!Number.isFinite(size.width) || !Number.isFinite(size.height)) return;

    const pending = this.pendingSizes.get(cardId);
    const next = {
      width: Math.max(size.width, pending?.width ?? 0),
      height: Math.max(size.height, pending?.height ?? 0),
    };
    // 现值已经够大 = 不用提交（这是绝大多数情况：内容没变过就不该碰模型）
    if (next.width <= card.width && next.height <= card.height) return;
    this.pendingSizes.set(cardId, next);
    this.flushSizes();
  }

  private flushSizes(): void {
    if (this.sizeFlushScheduled) return;
    this.sizeFlushScheduled = true;
    window.requestAnimationFrame(() => {
      this.sizeFlushScheduled = false;
      const targets = new Map(this.pendingSizes);
      this.pendingSizes.clear();
      if (targets.size === 0) return;

      this.commit(
        t('history.resize'),
        (board) => {
          const rects: CardRect[] = [];
          for (const [id, size] of targets) {
            const card = board.cards.find((item) => item.id === id);
            // 目标比现值小就跳过：卡片可能刚被用户手动拉大过（自动尺寸只增不减）
            if (!card) continue;
            const width = Math.max(size.width, card.width);
            const height = Math.max(size.height, card.height);
            if (width <= card.width && height <= card.height) continue;
            rects.push({ id, x: card.x, y: card.y, width, height });
          }
          return applyCardRects(board, rects);
        },
        // 同一批自动尺寸合并成一步撤销：否则"连加五个节点"会在历史里留下五条记录
        'auto-size',
      );
    });
  }

  private contentBounds(): Rect | null {
    const board = this.board;
    if (!board) return null;
    // 编组只是虚线框、连线本身没有面积，参与"适应内容"的只有卡片 / 分栏 / 脑图。
    // ★ 卡片取**外接框**（T7.06）：转 45° 的卡片比它的 `width/height` 高出小半张，
    //   按布局框"适应内容"会让它压在视口边上（缩到头也放不下整个白板）。
    //   0° 的卡片 `rotatedBoundsOf` 原样返回，于是这条改动对存量白板是零影响。
    // ★ 脑图（`2.2.0`）：它**模型里没有尺寸**，框只能问渲染层现算（`MindLayer.bounds`）——
    //   漏掉的话"缩放至全部"会把它留在屏幕外，而那看起来就像"脑图没被当回事"。
    return boundsOf([
      ...board.cards.map((card) => rotatedBoundsOf(card, card.rotation ?? 0)),
      ...board.columns,
      ...(this.mindLayer?.bounds().map((entry) => entry.rect) ?? []),
    ]);
  }

  // ───────────────────────────────────────────────────────────
  // 视图「…」菜单（`onPaneMenu`）
  // ───────────────────────────────────────────────────────────

  /**
   * Obsidian **自己的「…」菜单**里的那几项（`appendMenuItems` 消费）。
   *
   * ★ 没有一条是这里新造的能力：导出四件套 / 适应内容就是命令面板里那几个方法的
   *   本体，Home 走 `openHomeBoard`，复制链接走 {@link copyBoardLink} ——
   *   于是"从菜单点"与"从命令面板敲"逐字同一条路。
   * ★ 清单不缓存：每次点开都重新问一遍。"这块板现在有没有内容""能不能复制链接"都是
   *   **此刻**的事实（与 {@link toolbarItems} 那条 T3.28 教训同源）。
   */
  private viewMenuItems(): readonly MenuItemSpec[] {
    const actions: ViewMenuActions = {
      exportPng: () => this.exportPng(),
      exportSvg: () => this.exportSvg(),
      exportPdf: () => this.exportPdf(),
      exportMarkdown: () => this.exportMarkdown(),
      copyBoardLink: () => this.copyBoardLink(),
      openHome: () => openHomeBoard(this.plugin),
      fitContent: () => this.fitContent(),
    };

    return buildViewMenuItems(actions, {
      // 空板没有可适应的内容（`boundsOf([])` 给 `null`）；没有卡片也没有分栏时，
      // "适应全部内容"点下去和"回到 100%"是同一件事，不如置灰。
      hasContent: this.contentBounds() !== null,
      canCopyLink: this.currentPath !== null,
    });
  }

  /**
   * 注入 Obsidian **自己的「…」菜单**（`onPaneMenu`，用户 2026-09-17）。
   *
   * 用户原话："白板的右上角菜单，现在是我们单独做了一个悬浮菜单。里面有导出为 PNG / 导出为 SVG
   * 还有一些其他操作。**不要用我们自己做得悬浮菜单，而应该注入到 obsidian 本身的右上角有个"..."的
   * 菜单，目前里面只有左右分屏、上下分屏，把我们的菜单注入进去。**"
   *
   * ★ 从前那枚自绘的「⋯」浮标（`O11`）连同 `ui/ViewMenu.ts` 一起删了 —— 它的理由本来就是
   *   "避开 `leaf.view.addAction()` 那类改过签名的私有 API"，而 `onPaneMenu` 是**公开**的
   *   正式接口 ⇒ 没有理由再自绘一枚按钮（少一块浮层，画布右上角也干净）。
   * ★ 只接 `'more-options'`（那枚 `...`）：`'tab-header'` 是标签页右键菜单，用户没提，
   *   而且那里塞七项会让"重命名 / 关闭标签"这些系统项显得很挤。
   * ★ 清单仍然是 `viewMenuItems()` 那张**纯规格表**（导出四件套 / 复制链接 / Home / 适应内容）：
   *   宿主从"自绘浮层"换成 Obsidian 的 `Menu`，内容一个字都没动。
   * ★ 前面加一条分隔线：Obsidian 自己放着"左右分屏 / 上下分屏"，我们的项要与它们分开。
   */
  override onPaneMenu(menu: Menu, source: string): void {
    // ★★ **必须先让 Obsidian 铺它自己的项**：「左右分屏 / 上下分屏」就是基类那一段加的 ——
    //    覆写时忘了调 `super` 就等于把它们从菜单里删掉了（真实报障："测试下来的结果
    //    「左右分屏 / 上下分屏」消失了，其他没问题"）。我们的项接在它们后面。
    super.onPaneMenu(menu, source);

    if (source !== 'more-options') return;
    const items = this.viewMenuItems();
    if (items.length === 0) return;
    menu.addSeparator();
    appendMenuItems(menu, items);
  }

  // ───────────────────────────────────────────────────────────
  // 主工具条（T3.21 / T3.27）
  // ───────────────────────────────────────────────────────────

  /**
   * 工具条上的一格清单（`ui/Toolbar.ts` 消费）。
   *
   * ★ 工具条本身**一点都不认识白板**：它只渲染这张清单、把点击 / 拖拽回调回来。
   *   把清单放在视图里，是为了让"工具条 / 卡片右键菜单 / 命令面板"三条入口
   *   共用同一批方法 —— 分成三份实现的话，迟早会出现"点工具条与按快捷键结果不同"。
   *
   * ★ `enabled` / `pressed` 是**函数**而不是取好的值，所以每次 `sync()` 都拿到最新状态：
   *   "当前是否只读""是不是正在手绘"永远正确，不需要谁记得在切板后手动刷新。
   *
   * ★ 按钮组成按 `02 §2` 的层级图：`[选择][便签][图片][链接][文件][待办][分栏][白板][手绘]`
   *   加 `[−][100%][+][适应][网格]`。其中【色板】是这张图外面补的 ——
   *   它是注册表里一种正式卡片类型（有命令、有 `defaultSize`），
   *   而"图里没画"不该等于"用户只能用命令面板建"。
   */
  private toolbarItems(): readonly ToolbarItem[] {
    /**
     * ★ 这里**只允许**放"当下立刻用掉"的值，绝不缓存派生状态。
     *
     * 教训（T3.28 回归）：本方法第一次被调用是在 `buildCanvas()` 里（`toolbar.render()`），
     * 而 `onOpen` / `openBoard` 都是**先建画布、后设 `currentPath`** —— 那一刻
     * `isReadOnly()` 因为"路径还没认领"返回 `true`。当时这里写的是
     * `const readOnly = this.isReadOnly()` + `enabled: () => !readOnly`，
     * 于是每个建卡格的 `enabled` 被判成"永远 false"并被闭包固化下来：
     * 按钮看着是亮的（`sync()` 每帧重新问 items → `disabled = false`）、点下去却
     * 什么都不发生。而 `Toolbar.render()` 只把监听器绑一次，`sync()` 不重绑，
     * 所以这个"亮着但点不动"会一直持续到画布重建。
     *
     * 结论：`enabled` / `pressed` 这类会被**反复提问**的字段必须是纯取值函数，
     * 直接在函数体里读当前状态（`() => !this.isReadOnly()`）。
     */
    const snapOn = this.board?.settings.snapToGrid === true;

    /**
     * 一格"建卡"按钮：点击 = 在视口中心落一张，拖到画布 = 在指针处落一张。
     *
     * ★ `client` 传 `null` 表示"没有指针位置"，由 `worldFromClient` 换算成视口中心 ——
     *   点击这条最常用的路径因此不必先拖再放。
     */
    const create = (id: string, icon: string, label: MessageKey, type: CardType): ToolbarItem => ({
      id,
      icon,
      label: t(label),
      group: 'create',
      enabled: () => !this.isReadOnly(),
      activate: () => this.createCardAtClient(type, null),
      drop: (client) => this.createCardAtClient(type, client),
    });

    return [
      // ── 模式 ──
      {
        id: 'select',
        icon: 'mouse-pointer-2',
        label: t('toolbar.select'),
        group: 'mode',
        toggle: true,
        enabled: () => !this.isReadOnly(),
        pressed: () => !this.isInking,
        // 退出手绘 = 回到选择态。★ 不清选区：用户按 ⌘ 拖出一片选区后
        // 顺手画两笔、再点回选择，期待的是"我那批卡还在"
        activate: () => this.stopInk(),
      },
      {
        id: 'ink',
        icon: 'pencil',
        label: t('toolbar.ink'),
        group: 'mode',
        toggle: true,
        // 同上：手绘可用性必须在**点击的那一刻**取，不能吃构造时的快照
        enabled: () => this.canDrawInk,
        pressed: () => this.isInking,
        // `02 §3` 约定 3 的**唯一例外**：手绘是模式而不是"建一种卡"，
        // 点一下即进入（没有"拖到画布上"这回事 —— 笔是拿来用的，不是放下的）
        activate: () => {
          if (this.isInking) this.stopInk();
          else this.startInk('brush');
        },
      },

      // ── 建卡 ──
      // 白板卡（用户 2026-09-18："新建白板卡顺序移动到新建便签之前"）
      {
        id: 'board',
        icon: 'layout-dashboard',
        label: t('toolbar.board'),
        group: 'create',
        enabled: () => !this.isReadOnly(),
        activate: () => this.promptBoardAt(null),
        drop: (client) => this.promptBoardAt(client),
      },
      create('note', 'sticky-note', 'toolbar.note', 'note'),
      // 仅标题卡（用户 2026-09-18："新建标题卡也放到左侧菜单上，位置在便签卡之后"）
      create('titleCard', 'tag', 'toolbar.titleCard', 'titleCard'),
      // 内嵌脑图（`2.2.0`）：不再是"一种卡"，而是**白板级的一棵树**（`Mind`）
      // ★ 与其它几项同一套手势（点 = 落在视口中心 / 拖 = 落在松手处），只是落法不同：见 `createMindAtClient`
      {
        id: 'mind',
        icon: 'network',
        label: t('toolbar.mind'),
        group: 'create',
        enabled: () => !this.isReadOnly(),
        activate: () => this.createMindAtClient(null),
        drop: (client) => this.createMindAtClient(client),
      },
      // ★ `O26`：工具条**不再放「同步便签」**（用户要求收起来）。
      //   能力一个都没少 —— 命令面板里的「新建同步便签」（`COMMAND_IDS.newSyncNote`）、
      //   卡片右键的「新建同步副本」都仍在；要常驻工具条可自行绑定 / 反馈给我们。
      // 评论卡（T7.05）同理：落卡即进编辑态，等着写第一条
      {
        id: 'comment',
        icon: 'message-square',
        label: t('toolbar.comment'),
        group: 'create',
        enabled: () => !this.isReadOnly(),
        activate: () => this.createCommentAtClient(null),
        drop: (client) => this.createCommentAtClient(client),
      },
      // ★ `C1`（用户 2026-09-18："非常用卡收起到二级菜单：色卡、任务卡、地图卡"）：
      //   这三张不再各占一格，收进旁边这一格里（点开是 Obsidian 的 `Menu`）。
      //   留在主条上的是"建之前要先问一句"的那几张：便签 / 评论 / 图片 / 文件 / 链接。
      {
        id: 'more-cards',
        icon: 'plus',
        label: t('toolbar.moreCards'),
        group: 'create',
        enabled: () => !this.isReadOnly(),
        // ★ 没有 `drop`：这一格是"展开一个菜单"，拖到画布上该落哪张卡是说不清的
        activate: (event) => this.openMoreCardsMenu(event),
      },
      // 「图片」「文件」「链接」「白板」必须先问清"要哪一份 / 哪个网址"，
      // 所以它们的 `activate` / `drop` 只是**把落点记下来**（点击 = 视口中心，
      // 拖动 = 指针处），问到答案之后再落卡到这个点上
      //（先落一张空卡再问，卡会先闪一下再变形）
      {
        id: 'image',
        icon: 'image',
        label: t('toolbar.image'),
        group: 'create',
        enabled: () => !this.isReadOnly(),
        activate: () => this.openVaultFilePicker('image', null),
        drop: (client) => this.openVaultFilePicker('image', client),
      },
      {
        id: 'file',
        icon: 'file-text',
        label: t('toolbar.file'),
        group: 'create',
        enabled: () => !this.isReadOnly(),
        activate: () => this.openVaultFilePicker('file', null),
        drop: (client) => this.openVaultFilePicker('file', client),
      },
      // ★ 地图卡也收进「更多卡片」（`C1`）：它要先把静态图服务配好才有意义，
      //   是这一组里用得最不勤的一张 —— 能力一个都没少，`openMapPicker` 照旧从菜单进。
      {
        id: 'link',
        icon: 'link',
        label: t('toolbar.link'),
        group: 'create',
        enabled: () => !this.isReadOnly(),
        activate: () => this.promptLinkAt(null),
        drop: (client) => this.promptLinkAt(client),
      },
      // 分栏不是卡片，落点即建一个空栏
      {
        id: 'column',
        icon: 'columns-2',
        label: t('toolbar.column'),
        group: 'create',
        enabled: () => !this.isReadOnly(),
        activate: () => this.createColumnAtClient(null),
        drop: (client) => this.createColumnAtClient(client),
      },

      // ── 缩放 ──
      {
        id: 'zoom-out',
        icon: 'minus',
        label: t('toolbar.zoomOut'),
        group: 'zoom',
        // 到下限就灰掉：`zoomByStep` 自己会夹住不动，但"点了没反应"与
        // "看得出已经到头了"对用户是两件事
        enabled: () => this.viewport.zoom > MIN_ZOOM,
        activate: () => this.zoomByStep(-1),
      },
      {
        id: 'zoom-reset',
        // ★ 这一格是**文本**按钮（图标位留给百分比）—— 缩放数值本身就该是按钮：
        //   它同时是"当前多少"和"点一下回 100%"，比额外塞一个数字标签省一格宽度
        text: () => `${Math.round(this.viewport.zoom * 100)}%`,
        label: t('toolbar.zoomReset'),
        group: 'zoom',
        // 已经在 100% 时没有"回到"可言。浮点比较留一点余量，
        // 否则"100.00000001%"这种值会让它一直亮着
        enabled: () => Math.abs(this.viewport.zoom - 1) > 1e-3,
        activate: () => this.zoomToActualSize(),
      },
      {
        id: 'zoom-in',
        icon: 'plus',
        label: t('toolbar.zoomIn'),
        group: 'zoom',
        enabled: () => this.viewport.zoom < MAX_ZOOM,
        activate: () => this.zoomByStep(1),
      },
      {
        id: 'zoom-fit',
        icon: 'maximize',
        label: t('toolbar.zoomFit'),
        group: 'zoom',
        // 空板没有"内容"可适应 —— 点了只会把视口挪到一个没有意义的位置
        enabled: () => this.contentBounds() !== null,
        activate: () => this.fitContent(),
      },

      // ── 视图 ──
      {
        id: 'grid-snap',
        icon: 'grid-3x3',
        label: snapOn ? t('toolbar.gridSnapOn') : t('toolbar.gridSnapOff'),
        group: 'view',
        toggle: true,
        enabled: () => !this.isReadOnly(),
        pressed: () => this.board?.settings.snapToGrid === true,
        activate: () => this.toggleGridSnap(),
      },
    ];
  }

  /**
   * 一格客户端坐标是否落在画布上（工具条拖拽松手时判定"落点算不算数"）。
   *
   * ★ 用画布自身的 `getBoundingClientRect()` 而不是"屏幕减去 toolBar 宽度"这类推算：
   *   桌面是左侧竖条、移动端是底部横条，还会随侧栏折叠而变宽变窄 ——
   *   任何写死的偏移都会在某个布局下算错，而"拖到画布外松手"会被误判成创建。
   */
  private canvasContains(client: { x: number; y: number }): boolean {
    const rect = this.canvasEl?.getBoundingClientRect();
    if (!rect) return false;
    return rectContainsPoint(
      { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      client,
    );
  }

  /**
   * 把拖拽/粘贴里的路径解析成库内真实文件路径。
   *
   * 先精确匹配；Obsidian 拖拽文件浏览器/内部链接时给的经常是**短名**（`子板.nboard`），
   * 精确匹配会失败，所以用 `metadataCache.getFirstLinkpathDest` 按链接解析规则兜底。
   * 返回 `null` 表示不是库内文件。
   */
  private resolveVaultPath(path: string): string | null {
    // 规则本体在 `integration/vaultPath.ts`：拖拽 / 断链判定 / 附件整理三处必须同解
    return resolveFileInVault(this.app, path, this.currentPath ?? '');
  }

  /** 把客户端坐标（`null` = 视口正中）换成世界坐标。换不出来（画布未就绪）给 `null` */
  private worldFromClient(client: { x: number; y: number } | null): Point | null {
    const rect = this.canvasEl?.getBoundingClientRect();
    if (!rect) return null;
    const screen = client
      ? { x: client.x - rect.left, y: client.y - rect.top }
      : { x: rect.width / 2, y: rect.height / 2 };
    return this.viewport.toWorld(screen);
  }

  /** 工具条：在 `client` 处新建一张卡片（`note` / `todo` / `swatch`） */
  createCardAtClient(type: CardType, client: { x: number; y: number } | null): void {
    const world = this.worldFromClient(client);
    if (!world) return;
    this.createCardAt(world, type);
  }

  /** 工具条 / 画布菜单：在 `client` 处新建一棵**内嵌**脑图（`2.2.0`） */
  createMindAtClient(client: { x: number; y: number } | null): void {
    const world = this.worldFromClient(client);
    if (!world) return;
    this.createMindAt(world);
  }

  /**
   * 新建一棵**内嵌**脑图（`2.2.0`）：中心主题 + 3 个空分支，锚点落在点击处。
   *
   * ★ 与 `createCardAt` 分开（不是"给 `createCardAt` 加一个类型分支"）：脑图
   *   **没有宽高、没有整卡编辑态、不进分栏** —— 那几步对它是空转，混在一条路上
   *   只会让"卡片那条路"多出四处例外。
   * ★ 新建之后要做的事是"把光标送进中心主题"：请求必须排在 `commit` **之前**
   *   （`EmbedMind` 在第一次画完之后取这个请求，与 `F4` 那条手感同源）。
   */
  private createMindAt(world: Point): void {
    if (this.isReadOnly()) return;
    const model = newMindModel();
    const mind = createMind({
      // 锚点是**根节点中心**：以点击处为中心更符合"就放这儿"的直觉
      x: roundTo(world.x),
      y: roundTo(world.y),
      path: '',
      mind: model,
    });
    requestMindEdit(mind.id, model.rootId);
    if (!this.commit(t('history.create'), (board) => addMind(board, mind))) return;
    this.focusCanvas();
  }

  /** 工具条：新建一个空分栏（`02 §2` 的 [分栏]） */
  createColumnAtClient(client: { x: number; y: number } | null): void {
    const world = this.worldFromClient(client);
    const board = this.board;
    if (!world || !board || this.isReadOnly()) return;

    // ★ 空分栏也必须**记一条历史**：它同样会落盘、会改变视觉布局。
    //   不做的话"手滑建了一栏"只能手动删（而删除本身是可撤销的，很不对称）
    this.commit(t('history.create'), (draft) => {
      createColumnAt(draft, world.x, world.y);
      return true;
    });
  }

  /** 工具条：把库内路径落成卡片（[图片] / [文件] / [白板] 走这里） */
  createCardsFromPathsAt(
    paths: readonly string[],
    client: { x: number; y: number } | null,
  ): boolean {
    const world = this.worldFromClient(client);
    if (!world) return false;
    return this.placeDroppedCards(paths, world);
  }

  /**
   * 工具条：[图片] / [文件]。
   *
   * 先选文件再落卡（而不是先落一张空图片卡）：图片卡 / 文件卡的内容**就是一个路径**，
   * 没有路径的它们渲染出来是两个空格子 —— 先问清楚"要哪一份"更省一次操作。
   */
  openVaultFilePicker(
    kind: 'image' | 'file' | 'video' | 'audio',
    client: { x: number; y: number } | null,
  ): void {
    // 只给图片 / 视频 / 音频列扩展名：文件卡是"任意文件都能放"，不设过滤（`F6-04`）
    const extensions =
      kind === 'image'
        ? [...IMAGE_EXTENSIONS]
        : kind === 'video'
          ? [...VIDEO_EXTENSIONS]
          : kind === 'audio'
            ? [...AUDIO_EXTENSIONS]
            : null;
    new VaultFilePickerModal(this.app, extensions, (path) => {
      if (path === null) return; // 取消：他什么都没要求，不必给提示
      this.createCardsFromPathsAt([path], client);
    }).open();
  }

  /**
   * 工具条：[地图]。落一张地图卡，并**紧接着问链接**（`O17`）。
   *
   * ★ 以前这里弹的是库内图片选择器（"先挑一张本地地图图"），但用户的心智是
   *   "地图卡 = 我粘一条高德 / Google 分享链接" —— 第六批 `O08` 做的正是这件事，
   *   只是它挂在**已存在卡片**的右键菜单上，与新建入口对不上，于是"点地图卡却让我选文件"。
   *   现在新建入口直接进那条已经验证过的三段路（读剪贴板 / 解析 / 配了服务就取图）。
   * ★ 想拿一张库内图片当地图的人没有失去这条路：右键「选择地图图片」还在
   *   （`pickMapImage`，且换图保留图钉）。
   * ★ `client` 是落卡处（工具条拖拽给的是松手处的屏幕坐标）；`null` = 视图中心。
   */
  openMapPicker(client: { x: number; y: number } | null): void {
    const world = this.worldFromClient(client);
    if (world) void this.createMapCardWithLink(world);
  }

  /** 命令面板「新建地图卡」：落点与其它"在光标处新建"一致（`02 §4.3`） */
  newMapAtCursor(): void {
    const world = this.cursorWorld();
    if (world) void this.createMapCardWithLink(world);
  }

  /**
   * 新建地图卡的公共后半截（`O17`）：**先落一张空卡，紧接着问链接**。
   *
   * ★ 顺序是"先落卡再问"，为的是复用 `pasteMapLink` 那条路（读剪贴板 → 解析 → 取图），
   *   不再另写一套。`pasteMapLink` 会返回"有没有真的落到链接"：
   *   - 剪贴板里就是一条地图链接 → 一路落完，全程没有弹窗；
   *   - 读不到 / 认不出 → 弹输入框（预填读到的那段原文），填了就落；
   *   - **取消 → 把刚落的空卡撤掉**，否则画布上会留下一个"点了一下、什么都没得到"的空框。
   */
  private async createMapCardWithLink(center: Point): Promise<void> {
    const id = this.createMapCardAt('', center);
    if (id === null) return;
    if (await this.pasteMapLink(id)) return;

    // 没粘成：撤掉刚落的空卡。走的是一次正经 `commit`（而不是直接删内存）——
    // 这一下同样是用户看得见的一次改动，该进撤销栈
    this.commit(t('history.mapCardCancel'), (board) => {
      const index = board.cards.findIndex((card) => card.id === id);
      if (index < 0) return false;
      board.cards.splice(index, 1);
      return true;
    });
  }

  /**
   * 在 `center` 处落一张指向 `path` 的地图卡（图钉留空，等用户双击图上落钉）。
   *
   * ★ 返回新卡的 id（`O17` 起）：新建入口要在落卡之后**紧接着往这张卡上贴链接**，
   *   `null` = 没落成（只读 / 没有板子 / 提交没产生变更）。
   */
  private createMapCardAt(path: string, center: Point): string | null {
    const board = this.board;
    if (!board || this.isReadOnly()) return null;

    const size = DEFAULT_CARD_SIZES.map;
    const card = createCard('map', {
      x: roundTo(center.x - size.width / 2),
      y: roundTo(center.y - size.height / 2),
      width: size.width,
      height: size.height,
      color: this.newCardColor(),
      content: { path },
    });

    const target = findDropTarget(board, center, undefined, (columnId) =>
      this.columnScrollOffsetOf(columnId),
    );

    const changed = this.commit(t('history.create'), (draft) => {
      if (!addCards(draft, [card])) return false;
      if (target) insertCardsIntoColumn(draft, [card.id], target.columnId, target.index);
      return true;
    });

    if (changed) {
      this.selection.set({ cards: [card.id] });
      if (target) this.revealCardInColumn(target.columnId, [card.id]);
    }
    return changed ? card.id : null;
  }

  // ── 同步便签（T7.04 / `F2.9`）────────────────────────────

  /**
   * 把正文写回**整个同步组** —— 卡片定义通过 `CardRenderContext.writeSyncGroup`
   * 调用（只有同步便签会走到这里）。
   *
   * ★ **一次 `mutate` 改掉全组**：只标脏一次、只发一次 `changed`（一次重绘）。
   *   若改成"逐张调 `updateCardContent`"，同组三张会触发三次重绘，中间还会短暂画出
   *   "一张新、两张旧"的画面 —— 那是一次看得见的闪烁。
   * ★ 与 `updateCardContent` 一样走**裸 `mutate`**（正文编辑不进撤销栈），
   *   所以同步便签的编辑手感与普通便签完全一致。
   * ★ "只有提交的正是当前编辑的那张才退出编辑态"这条也照搬 —— 否则会把另一张卡
   *   正在进行的编辑一起清掉。
   */
  private writeSyncGroup(key: string, md: string): void {
    const path = this.currentPath;
    if (!path || this.isReadOnly()) return;

    const editing = this.editingCardId
      ? this.board?.cards.find((card) => card.id === this.editingCardId)
      : undefined;
    if (editing && editing.type === 'syncNote' && editing.content.key === key) {
      this.clearEditingState();
    }

    // 真正的"改哪些卡"是模型层的纯函数（`patchSyncGroup`）—— 视图只负责
    // "挑哪块板、什么时候不写盘"这层壳
    const changed = this.plugin.repository.mutate(path, (board) => patchSyncGroup(board, key, md));

    // 没有模型变更就不会有 `changed` 事件 —— 仍需一次重绘把编辑器换回渲染结果
    if (!changed) this.refreshCards();
  }

  /** 工具条：[同步便签]。在 `client` 处落一张新卡（T7.04） */
  createSyncNoteAtClient(client: { x: number; y: number } | null): void {
    const world = this.worldFromClient(client);
    if (world) this.createSyncNoteAt(world);
  }

  /** 命令面板「新建同步便签」：落点与其它"在光标处新建"一致（`02 §4.3`） */
  newSyncNoteAtCursor(): void {
    const world = this.cursorWorld();
    if (world) this.createSyncNoteAt(world);
  }

  /**
   * 在 `center` 处落一张**带新组键**的同步便签并立刻进入编辑。
   *
   * ★ 为什么新建时就发一个 `key`（而不是留空、等"新建同步副本"时才发）：
   *   留空的话，`⌘D` 复制出来的副本也是空 `key` —— 得到两张"看起来是同步便签"、
   *   却各改各的卡。而"复制一张同步便签 = 又摆一处同一个便签"正是这张卡的意义，
   *   所以从**第一张**起它就属于一个（此刻只有它自己的）同步组。
   */
  private createSyncNoteAt(center: Point): boolean {
    const board = this.board;
    if (!board || this.isReadOnly()) return false;

    const size = DEFAULT_CARD_SIZES.syncNote;
    const card = createCard('syncNote', {
      x: roundTo(center.x - size.width / 2),
      y: roundTo(center.y - size.height / 2),
      width: size.width,
      height: size.height,
      color: this.newCardColor(),
      content: { key: createId(ID_PREFIX.sync), md: '' },
    });

    if (!this.commit(t('history.newSyncNote'), (draft) => addCards(draft, [card]))) return false;
    this.selection.set({ cards: [card.id] });
    this.focusCanvas();
    this.enterEditMode(card.id);
    return true;
  }

  /**
   * 右键「新建同步副本」：给这张同步便签再摆一处（T7.04 / `F2.9`）。
   *
   * ★ 源便签**不在任何组里**（`key` 为空：手改过的老数据、或刚「取消同步」过）时
   *   当场开一个组 —— 给源卡和副本写同一个新 `key`。不这么做的话，用户按了"同步"
   *   却得到两张各改各的卡，这是最难解释的一类错。
   * ★ "给源卡补上 `key`"与"加副本"在**同一次 `commit`** 里：撤销一步整组退回。
   */
  duplicateSyncNote(id: string): void {
    const board = this.board;
    if (!board || this.isReadOnly()) return;
    const source = board.cards.find((card) => card.id === id);
    if (!source || source.type !== 'syncNote' || source.locked) return;

    const key = source.content.key.length > 0 ? source.content.key : createId(ID_PREFIX.sync);
    const card = createCard('syncNote', {
      x: roundTo(source.x + DUPLICATE_OFFSET.x),
      y: roundTo(source.y + DUPLICATE_OFFSET.y),
      width: source.width,
      height: source.height,
      color: source.color,
      content: { key, md: source.content.md },
    });

    const changed = this.commit(t('history.syncNoteDup'), (draft) => {
      const origin = draft.cards.find((item) => item.id === id);
      if (!origin || origin.type !== 'syncNote') return false;
      if (origin.content.key !== key) origin.content = { ...origin.content, key };
      addCards(draft, [card]);
      return true;
    });

    // 选中副本：用户接着要拖 / 要摆的显然是刚加的这一张（与 `⌘D` 同规矩）
    if (changed) this.selection.set({ cards: [card.id] });
  }

  /**
   * 右键「取消同步」：把这一张移出同步组（T7.04）。
   *
   * ★ **只改这一张**：同组其它张照旧互相同步 —— 这正是"取消同步"该有的意思。
   * ★ 只清 `key`、不换类型：它从此就是一张"不在任何组里"的同步便签，卡面角标随之
   *   消失（`cards/syncNote.ts`），用起来与普通便签无异。
   * ★ 本来就没同步（`key` 已空）时什么都不做：不写盘、也不在历史里留一条空记录。
   */
  unsyncNote(id: string): void {
    const board = this.board;
    if (!board || this.isReadOnly()) return;
    const card = board.cards.find((item) => item.id === id);
    if (!card || card.type !== 'syncNote' || card.locked) return;
    if (card.content.key.length === 0) return;

    this.commit(t('history.syncNoteDetach'), (draft) => {
      const target = draft.cards.find((item) => item.id === id);
      if (!target || target.type !== 'syncNote') return false;
      target.content = { ...target.content, key: '' };
      return true;
    });
  }

  /** 工具条：[评论卡]。在 `client` 处落一张新卡（T7.05）。落卡即进编辑态 —— 见 `createCardAt` */
  createCommentAtClient(client: { x: number; y: number } | null): void {
    const world = this.worldFromClient(client);
    if (world) this.createCardAt(world, 'comment');
  }

  /** 命令面板「新建评论卡」：落点与其它"在光标处新建"一致（`02 §4.3`） */
  newCommentAtCursor(): void {
    const world = this.cursorWorld();
    if (world) this.createCardAt(world, 'comment');
  }

  /**
   * 右键「标记为已解决」/「重新打开」：整条评论线程收口（T7.05 / `F2.9`）。
   *
   * ★ 与待办卡的逐项勾选不同：这里翻的是 `CommentContent.resolved` **一个字段**，
   *   一条都不删 —— 已解决的线程在卡面上置灰 + 打角标，内容照旧可读
   *   （见 `model/schema.ts` 里为什么"解决"不等于"清空"）。
   * ★ 锁定的卡不给改内容（与所有"改内容"的动作同一条规矩）。
   */
  toggleCommentResolved(id: string): void {
    const board = this.board;
    if (!board || this.isReadOnly()) return;
    const card = board.cards.find((item) => item.id === id);
    if (!card || card.type !== 'comment' || card.locked) return;

    const next = !card.content.resolved;
    this.commit(t(next ? 'history.commentResolve' : 'history.commentReopen'), (draft) => {
      const target = draft.cards.find((item) => item.id === id);
      if (!target || target.type !== 'comment') return false;
      // 已经是目标状态就不写：不留一条什么都没改的历史（与 `unsyncNote` 同规矩）
      if (target.content.resolved === next) return false;
      target.content = { ...target.content, resolved: next };
      return true;
    });
  }

  /**
   * 右键「深色便签」/「浅色便签」：在两种配色变体之间切（`O06`）。
   *
   * ★ 与 `toggleCommentResolved` 同一类：改的是**内容**（`NoteContent.variant`），
   *   走一次 `commit` 让它可以 `⌘Z` —— 顺手也把重绘带上了（卡片层按内容指纹重渲）。
   * ★ 写回时把 `light` 归成**缺席**（`delete`）：`light` 是默认值，写进文件的话
   *   "切回浅色"与"从没切过"就成了两份不同的字节
   *   （与 `BoardRefContent.icon` 清空 / `InkPath.alpha === 1` 同一条规矩）。
   * ★ 草稿上**再判一次**并跳过"值没变"的写入：留一条什么都没改的历史毫无意义
   *   （`commit` 与上面的读之间隔着一次可能的并发写）。
   * ★ 锁定的卡不给改内容（与所有"改内容"的动作同一条规矩）。
   */
  toggleNoteVariant(id: string): void {
    const board = this.board;
    if (!board || this.isReadOnly()) return;
    const card = board.cards.find((item) => item.id === id);
    if (!card || card.type !== 'note' || card.locked) return;
    const next: NoteVariant = card.content.variant === 'dark' ? 'light' : 'dark';

    this.commit(t('history.noteVariant'), (draft) => {
      const target = draft.cards.find((item) => item.id === id);
      if (!target || target.type !== 'note') return false;
      // 草稿上再判一次：`commit` 与上面的读之间隔着一次可能的并发写
      if ((target.content.variant ?? 'light') === next) return false;
      const content = { ...target.content };
      if (next === 'light') delete content.variant;
      else content.variant = next;
      target.content = content;
      return true;
    });
  }

  /**
   * 右键「卡面预览」：换白板卡的预览档位（T7.09 / `F7-10` / `O09`）。
   *
   * ★ 与 `toggleCommentResolved` 同一类：改的是**内容**（`BoardRefContent.preview`），
   *   走一次 `commit` 让它可以 `⌘Z` —— 顺手也把重绘带上了（卡片层按内容指纹重渲）。
   * ★ 选中的就是当前档位时**什么都不做**：不写盘、也不在历史里留一条空记录
   *   （菜单里那一项本来就有勾，点它是"再确认一次"，不是一次操作）。
   * ★ 不要求 `path` 非空：菜单在那个档位不出现，但命令面板 / 将来的脚本调用
   *   可以直接调到这里 —— 空卡的档位存着也无害（渲染时走 `is-empty` 那条路）。
   * ★ 锁定的卡不给改内容（与所有"改内容"的动作同一条规矩）。
   *
   * ★ 尺寸跟着形态走（`O18`）：mini 是**固定正方形**，所以换到这一档时必须同一次
   *   把它钉成 {@link BOARD_REF_MINI_SIZE}；换离这一档时，若它还正好停在这个正方形上，
   *   就还给该类型的默认尺寸 —— 否则用户切回缩略图会得到一张 87×87 的小小卡，
   *   看上去像"切档位把卡弄坏了"。两件事放进**同一条历史记录**：用户按一次 `⌘Z`
   *   应该把"档位 + 尺寸"一起退回去，分成两条就成了撤销栈里的两步。
   * ★ 尺寸判据写在这里（而不是靠 `applyCardRects` 之类的兜底去钳）：mini 卡压根
   *   没有尺寸手柄（样式表把它们藏了），这条是唯一的写入口；
   *   读入口那一条在 `model/validate`，两边判据必须一致。
   * ★ 与旧版 `O09` 兼容：那时 mini 是"用户拉多大就多大"。所以"已经选中 mini 再点一次"
   *   不做空操作 —— 那正是把存量卡片掰回正方形的**手动修复路径**（自动的那条在读入口）。
   */
  setBoardRefPreview(id: string, preview: BoardRefPreview): void {
    const board = this.board;
    if (!board || this.isReadOnly()) return;
    const card = board.cards.find((item) => item.id === id);
    if (!card || card.type !== 'boardRef' || card.locked) return;

    const nextSize = boardRefPreviewSize(preview, card);
    if (card.content.preview === preview && nextSize === null) return;

    this.commit(t('history.boardPreview'), (draft) => {
      const target = draft.cards.find((item) => item.id === id);
      if (!target || target.type !== 'boardRef') return false;
      // 草稿上再判一次：`commit` 与上面的读之间隔着一次可能的并发写。
      // ★ 两个字段各判各的、合起来决定"这次到底改没改"：档位没变但尺寸要掰回来时
      //   也必须返回 `true`（那是一次真实的修复），而两者都没变时必须返回 `false`
      let changed = false;
      if (target.content.preview !== preview) {
        target.content = { ...target.content, preview };
        changed = true;
      }
      if (
        nextSize !== null &&
        (target.width !== nextSize.width || target.height !== nextSize.height)
      ) {
        target.width = nextSize.width;
        target.height = nextSize.height;
        changed = true;
      }
      return changed;
    });
  }

  /**
   * 右键「选择图标…」（`O10`）：给白板卡挑一个 emoji 画在标题行左边。
   *
   * ★ 与 `setBoardRefPreview` 同一类（改的是**内容**，走一次 `commit` 让它可以 `⌘Z`），
   *   差别只在入口是一个 `SuggestModal`。
   * ★ 参数里再递一次当前图标（而不是让选择器自己去读模型）：选择器只需要"哪个是现在这个"，
   *   给它整张卡反而是把"改哪张"的责任分给了它。
   * ★ 锁定的卡不给改内容（与所有"改内容"的动作同一条规矩）。
   */
  private openBoardIconPicker(id: string): void {
    const board = this.board;
    if (!board || this.isReadOnly()) return;
    const card = board.cards.find((item) => item.id === id);
    if (!card || card.type !== 'boardRef' || card.locked) return;

    // ★ **优先用栏上那个标记弹层**（用户 2026-09-16："选图标的组件，应该用和便签卡选标记
    //   同样的组件"）：右键一张卡会先把它选成单选（`showCardMenu`），于是栏正显示着它 ——
    //   这一项就等于"打开那条栏上的标记"，与便签节点走的是**同一份实现**（`ui/QuickBar`）。
    // ★ 栏开不了（多选 / 只读 / 视图还没建起栏）才退回旧的搜索式弹窗：那条路旧，但没坏。
    if (this.quickBar?.openIconPicker() === true) return;

    new IconPickerModal(this.app, card.content.icon, (icon) => {
      this.setBoardRefIcon(id, icon);
    }).open();
  }

  /**
   * 写入白板卡的卡面图标（`O10`）。`null` = 清掉。
   *
   * ★ 与 `setBoardRefPreview` 一样在草稿上**再判一次**（`commit` 与上面的读之间
   *   隔着一次可能的并发写），并跳过"值没变"的写入 —— 不留空历史。
   * ★ 清掉时**删掉 `icon` 这个键**而不是写空串：`03 §2.7` 里"没有图标"就是一个
   *   缺席的键，写空串会让"清过图标"与"从来没设过"的卡片字节不同（`validate` 读入口
   *   也是这么归一化的 —— 两边必须一致）。
   * ★ 归一走 `normalizeIcon`（与读入口共用一份）：选择器可能收到系统面板粘进来的
   *   零宽 / 控制字符，落盘前先收干净。
   */
  setBoardRefIcon(id: string, icon: string | null): void {
    const board = this.board;
    if (!board || this.isReadOnly()) return;
    const card = board.cards.find((item) => item.id === id);
    if (!card || card.type !== 'boardRef' || card.locked) return;

    const next = icon === null ? '' : normalizeIcon(icon);
    if (normalizeIcon(card.content.icon) === next) return;

    this.commit(t('history.boardIcon'), (draft) => {
      const target = draft.cards.find((item) => item.id === id);
      if (!target || target.type !== 'boardRef') return false;
      // 草稿上再判一次（同 `setBoardRefPreview`）
      if (normalizeIcon(target.content.icon) === next) return false;
      if (next.length === 0) {
        const content = { ...target.content };
        delete content.icon;
        target.content = content;
      } else {
        target.content = { ...target.content, icon: next };
      }
      return true;
    });
  }

  /**
   * 右键「引用块…」（T7.10 / `F10-07`）：把引用卡定位到源笔记的某一处。
   *
   * ★ 与 `setBoardRefPreview` 同一类（改的是**内容**，走一次 `commit` 让它可以 `⌘Z`），
   *   但要先拿到正文 —— 目标清单只能从源笔记里读出来，所以整件事是异步的。
   * ★ 读不到正文（断链 / 权限）时只是**什么都不做**：菜单项在断链时本来就不出现，
   *   走到这里说明是在"菜单弹出之后、正文读完之前"那条缝里断的 —— 弹一个错也
   *   没有可操作的建议（用户该做的是重连），静默退出更不打扰。
   * ★ 没有任何可引用目标时用 `Notice` 说明并**不开弹窗**：一个只列着"整篇笔记"
   *   的选择器看着像坏了，而它能做的事和取消没区别。
   */
  private openNoteRefTargetPicker(id: string): void {
    const notes = this.notesBridge;
    const board = this.board;
    if (!notes || !board || this.isReadOnly()) return;
    const card = board.cards.find((item) => item.id === id);
    if (!card || card.type !== 'noteRef' || card.locked) return;

    const { path, subpath } = card.content;
    if (path.length === 0) return;

    void notes.read(path).then((markdown) => {
      // 读回来之后重新取一次卡片：这中间卡片可能被删了，或者被别处的写替换掉了
      const live = this.board?.cards.find((item) => item.id === id);
      if (markdown === null || !live || live.type !== 'noteRef') return;

      const anchors = listNoteRefAnchors(markdown);
      if (anchors.length <= 1) {
        new Notice(t('modal.noteRefTarget.empty'));
        return;
      }

      new NoteRefTargetModal(this.app, anchors, subpath, (next) => {
        if (next === null) return; // 取消
        this.setNoteRefTarget(id, next);
      }).open();
    });
  }

  /**
   * 写入引用卡的定位（T7.10）。
   *
   * ★ 与 `setBoardRefPreview` 一样在草稿上**再判一次**（`commit` 与上面的读之间
   *   隔着一次可能的并发写），并跳过"值没变"的写入 —— 不留空历史。
   * ★ `subpath` 的规范化（`null` = 整篇）由 `setNoteRefTarget` 的调用方保证：
   *   选择器递过来的就是 `NoteRefAnchor.subpath`。
   */
  setNoteRefTarget(id: string, subpath: string | null): void {
    const board = this.board;
    if (!board || this.isReadOnly()) return;
    const card = board.cards.find((item) => item.id === id);
    if (!card || card.type !== 'noteRef' || card.locked) return;
    if (card.content.subpath === subpath) return;

    this.commit(t('history.noteRefTarget'), (draft) => {
      const target = draft.cards.find((item) => item.id === id);
      if (!target || target.type !== 'noteRef') return false;
      if (target.content.subpath === subpath) return false;
      target.content = { ...target.content, subpath };
      return true;
    });
  }

  /** 工具条：[链接]。问到一个 URL 才落卡 */
  promptLinkAt(client: { x: number; y: number } | null): void {
    new LinkPromptModal(this.app, (url) => {
      if (url === null) return;
      const world = this.worldFromClient(client);
      if (!world) return;
      this.createLinkCardAt(url, world);
    }).open();
  }

  /**
   * 工具条：[白板]。挑一块已建好的白板落成卡片，或**新建一块子板**（T1.61）。
   *
   * ★ 一块白板都没有时**不再**提前弹"还没有白板"：选择器第一行那行
   *   「＋ 新建子白板」正是那种情况下的唯一出路，提前 return 会把它堵死。
   *   （`notice.noBoardYet` 仍归 `AddToBoard` 用 —— 那里点的是"添加"，
   *   新建确实不该混进去。）
   */
  promptBoardAt(client: { x: number; y: number } | null): void {
    new BoardPickerModal(
      this.app,
      this.plugin.registry.all(),
      (path) => {
        if (path === null) return; // 取消：他什么都没要求，不必给提示
        this.createCardsFromPathsAt([path], client);
      },
      { onCreateNew: () => void this.createChildBoardAt(client) },
    ).open();
  }

  /**
   * 新建一块"当前板的子板"并落成一张白板卡（T1.61 / `F2-8-1`）。
   *
   * ★ 落卡而**不**立刻打开新板：用户的下一步多半是"在里面再放点东西"，
   *   而一打开就把视图切走了 —— 这张刚建好的入口卡当场看不见（双击它才是"进去"）。
   */
  private async createChildBoardAt(client: { x: number; y: number } | null): Promise<void> {
    const created = await this.createChildBoardFile();
    if (!created) return;
    this.createCardsFromPathsAt([created], client);
  }

  // ───────────────────────────────────────────────────────────
  // 外观与性能（T3.24 / T3.22）
  // ───────────────────────────────────────────────────────────

  /**
   * 把"新建卡片外观"设置贴成 CSS 变量（T3.24 / `F11-03`）。
   *
   * ★ 走 CSS 变量而不是给每张卡写 inline style：一次写入作用于整层，
   *   拖动 / 缩放 / 换板都不必重算；而且 `styles.css` 里能读到它做 `color-mix`。
   * ★ 由 `main.ts` 在设置变更时 push 过来（见 `refreshLocalizedChrome`），
   *   也在画布装配完时调一次 —— 新开的视图立刻拿到当前设置。
   */
  applyAppearanceSettings(): void {
    // 变量挂在视图的根容器上：卡片层 / 分栏层都在它里面，一次写入全层生效
    applyCardStyleVariables(this.contentEl, this.plugin.settings);
    // ★ 外观档（原版 / 拟物，`F2`）**不在这里写**：它的作用面跨容器（白板 / 嵌入板 /
    //   右键菜单 / 设置面板），所以挂在 `document.body` 上，由 `main.ts` 统一维护 ——
    //   见那个 `applyStyleMode`。
  }

  /**
   * 「图片卡始终使用原图」（`A5`）改动后重画卡片。
   *
   * ★ 为什么不能只存设置：这一档是在**渲染图片卡的那一刻**判定的（`cards/image.ts`），
   *   已经画好的卡片不会自己知道设置变了 ⇒ 用户拨完开关回到白板，看到的还是旧样子，
   *   会以为"这开关没用"。
   * ★ 与 `applyMinimapSetting` 同一套分工：视图提供一个**语义明确**的入口，
   *   `main.ts` 只管推。
   */
  applyImageQualitySetting(): void {
    this.refreshCards();
  }

  // ── 卡片属性面板（`B1`，用户 2026-09-18）──────────────────────
  //
  // 入口是卡片右键的「属性…」；面板住在右侧边栏（`CardInspectorPanelView`）。
  // 这一侧只提供三件事：把面板打开并绑到某张卡、回答"这张卡现在什么样"、
  // 以及**代它写回**（写回走本视图的 `commit` ⇒ 与画布上的修改共享同一条历史，
  // 于是"在面板里改一个数"也是**一步撤销**）。

  /**
   * 打开侧栏「卡片属性」并让它看着这张卡。
   *
   * ★ `getRightLeaf(false)` + `setViewState`：与白板列表 / 搜索那两个侧栏面板同一条路。
   * ★ `bind()` 每次都会调：面板是**单例**（在 A 卡上点一次、在 B 卡上再点一次，
   *   换的是同一个标签页里的内容，而不是开出第二个"卡片属性"）。
   * ★ 打开之后**把焦点还给画布**：侧栏抢走焦点的话，用户接着按 `⌘Z` / 方向键会打到空处
   *   （面板里的输入框自己会重新拿焦点，那是用户点它的时候）。
   */
  openCardInspector(cardId: string): void {
    const card = this.cardOfInspector(cardId);
    if (!card) return;

    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) return;
    void leaf
      .setViewState({ type: VIEW_TYPE_CARD_INSPECTOR, active: true })
      .then(() => {
        const view = leaf.view;
        if (!(view instanceof CardInspectorPanelView)) return;
        view.bind(
          {
            cardOf: (id) => this.cardOfInspector(id),
            applyPatch: (id, patch) => this.applyCardInspectorPatch(id, patch),
            applyContent: (id, patch) => this.applyCardInspectorContent(id, patch),
            columnTitleOf: (id) => this.columnTitleOfInspector(id),
          },
          cardId,
        );
      })
      .catch((error: unknown) => {
        console.warn('[nestboard] 打开卡片属性面板失败', error);
      });
    this.focusCanvas();
  }

  /** 面板的窄接口：这张卡现在什么样（被删掉了给 `null`，面板会显示空白态） */
  cardOfInspector(cardId: string): Card | null {
    return this.board?.cards.find((item) => item.id === cardId) ?? null;
  }

  /** 面板的窄接口：所属分栏的名字（没进栏 / 找不到给 `null`） */
  columnTitleOfInspector(cardId: string): string | null {
    const board = this.board;
    const columnId = this.cardOfInspector(cardId)?.columnId ?? null;
    if (!board || columnId === null) return null;
    return columnById(board, columnId)?.title ?? null;
  }

  /**
   * 面板的窄接口：把这几项写回那张卡。
   *
   * ★ 走 `commit` ⇒ 一次编辑一条历史（面板里连点几个开关，`⌘Z` 就退几下，符合预期）。
   * ★ 用的是"**逐个字段**写 / 删"而不是 `Object.assign(card, patch)`：面板把
   *   "恢复默认"表达成 `undefined`（比如 `showBorder: undefined` = 有边框），
   *   而 `Object.assign` 会把键**留着但值为 `undefined`** —— 那在文件里是一个
   *   `"showBorder": null` 之类的怪东西（校验层能读回来，但落盘不干净）。
   * ★ `locked` 的卡不改：与画布上其它入口同一条规矩（锁了就是锁了）。
   */
  /**
   * 面板的窄接口：把**内容**写回那张卡（`B1` 收尾）。
   *
   * ★ 复用卡片层的那个口子（`updateCardContent`）—— 画布上的就地编辑与面板里改内容是
   *   同一件事，两条实现迟早会在"哪些字段要归一 / 要不要递增 revision"上分家。
   */
  applyCardInspectorContent(cardId: string, patch: Record<string, unknown>): void {
    const card = this.cardOfInspector(cardId);
    if (!card || card.locked) return;
    this.updateCardContent(cardId, patch as never);
  }

  applyCardInspectorPatch(cardId: string, patch: Record<string, unknown>): void {
    this.commit(t('menu.card.inspector'), (board) => {
      const card = board.cards.find((item) => item.id === cardId);
      if (!card || card.locked) return false;
      const target = card as unknown as Record<string, unknown>;
      for (const [key, value] of Object.entries(patch)) {
        // 身份与内容不归面板管（`CardPatch` 的类型上就排除了，这里是第二道闸门）
        if (key === 'id' || key === 'type' || key === 'content') continue;
        if (value === undefined) delete target[key];
        else target[key] = value;
      }
      return true;
    });
  }

  /**
   * 「更多卡片」弹出的那几项（`C1`，用户 2026-09-18："非常用卡收起到二级菜单"）。
   *
   * ★ 用 Obsidian 的 `Menu`：键盘导航、移动端点击、主题配色都是现成的，自己画一个浮层
   *   就得把这些重做一遍（`04 §13` 的合规那条也写着"菜单一律交给 `Menu`"）。
   * ★ 弹在**点击处**（有事件时）；键盘 / 程序触发没有坐标，退到画布中心 ——
   *   那里至少是用户此刻正在看的地方，比屏幕某个角强。
   * ★ 这三张的共同点：**落卡之前不用问任何问题**（问话的那几张留在主条上）。
   */
  private openMoreCardsMenu(event?: MouseEvent): void {
    if (this.isReadOnly()) return;

    // ★ 就地列出来、不另立一张全局表：它只在**这一刻**被读，多一层间接就等于
    //   "想改工具条得先找到那张表"—— 工具栏摆了哪些卡，本来就该在这一处看得全
    const more: readonly { id: string; icon: string; label: MessageKey; run: () => void }[] = [
      {
        id: 'todo',
        icon: 'list-checks',
        label: 'toolbar.todo',
        run: () => this.createCardAtClient('todo', null),
      },
      {
        id: 'swatch',
        icon: 'palette',
        label: 'toolbar.swatch',
        run: () => this.createCardAtClient('swatch', null),
      },
      // 视频卡（`A1`）：与图片 / 文件同一套"先选文件再落卡"（内容就是一个路径）
      {
        id: 'video',
        icon: 'film',
        label: 'toolbar.video',
        run: () => this.openVaultFilePicker('video', null),
      },
      // 音频卡（`A2`）：同上
      {
        id: 'audio',
        icon: 'disc',
        label: 'toolbar.audio',
        run: () => this.openVaultFilePicker('audio', null),
      },
      // 仅标题卡（`A3`）：不用先问"要哪一份"—— 它是一枚空标签，落下来就等着写字
      {
        id: 'titleCard',
        icon: 'tag',
        label: 'toolbar.titleCard',
        run: () => this.createCardAtClient('titleCard', null),
      },
      // 内嵌脑图（`2.2.0`）：白板级的一棵树（不再是卡）—— 落下来就是"中心主题 + 3 个空分支"
      {
        id: 'mind',
        icon: 'network',
        label: 'toolbar.mind',
        run: () => this.createMindAtClient(null),
      },
      {
        id: 'map',
        icon: 'map',
        label: 'toolbar.map',
        run: () => this.openMapPicker(null),
      },
    ];

    const items: MenuItemSpec[] = more.map((entry) => ({
      id: entry.id,
      title: t(entry.label),
      icon: entry.icon,
      run: entry.run,
    }));

    if (event) {
      showMenuAtMouse(event, items);
      return;
    }
    const rect = this.canvasEl?.getBoundingClientRect();
    if (!rect) return;
    showMenuAtPoint({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }, items);
  }

  /**
   * 刷新世界容器的可访问名（T3.26）："白板，共 12 张卡片"。
   *
   * ★ 只在**卡片总数变了**才写 DOM：`setAttribute` 会触发无障碍树重算，
   *   那是 DOM 里最贵的一类写操作，而这条路径每次平移缩放都会走到（见 `syncCanvas`）。
   * ★ 数的是 `board.cards.length`（总数）而不是"挂在 DOM 里的张数"：
   *   视口裁剪会让 DOM 里的数量随相机到处变，念一个会自己变的数字只会让人困惑。
   */
  private syncBoardAriaLabel(): void {
    const world = this.worldEl;
    if (!world) return;
    const label = boardAriaLabel(this.board?.cards.length ?? 0);
    if (label === this.lastBoardAriaLabel) return;
    this.lastBoardAriaLabel = label;
    world.setAttribute('aria-label', label);
  }

  /**
   * 卡片获得键盘焦点 → 把选区对齐过去（T3.26 / `02 §7`）。
   *
   * ★ 为什么必须对齐：读屏用户按 Tab 走到第三张卡时，按 Delete 删掉的必须是
   *   **第三张**。如果焦点在 A、选区还停在 B，他会删掉一张自己看不见的卡 ——
   *   而界面上没有任何东西提示这件事。
   * ★ 编辑中不抢选区：正在改标题时焦点在输入框里，此刻若有人用 `focusin`
   *   重设选区，会把"多选后一起改标题"这条路径打断。
   */
  private onCanvasFocusIn(event: FocusEvent): void {
    // 演示态（J-06）：Tab 到卡片时**不要**把选区搬过去。搬了以后卡上会出现
    // 选中框（看起来像"接下来要编辑它"），而演示刻意不可编辑
    if (this.presentation?.active) return;
    if (this.isEditingCard || this.isReadOnly()) return;
    const canvas = this.canvasEl;
    if (!canvas) return;
    // ★ 用 `resolveCardId` 而不是自己 `closest` + 读属性：那个函数还校验了
    //   "元素确实在本画布内"（嵌入其它视图的卡片不该被误判成本视图的焦点）
    const cardId = resolveCardId(event.target, canvas);
    if (!cardId || this.selection.hasCard(cardId)) return;
    this.selection.set({ cards: [cardId] });
  }

  /**
   * 重画所有"我们自己画的"文案（T3.23）。
   *
   * ★ 为什么需要它：Obsidian 没有"改一个已注册命令的名字"的 API，但工具条、
   *   右键菜单、浮层标题都是我们自己的 DOM —— 用户把界面语言从中文切到英文时，
   *   这些必须当场跟着变，而不是等重启。
   * ★ 只重建"文案"这几处，不整块 `buildCanvas()`：后者会把整个画布拆了重建，
   *   滚到一半的位置、正在编辑的卡片全没了。
   */
  refreshLocalizedLabels(): void {
    this.toolbar?.render();
    // 面包屑的 render 要"根 → 当前"的层级链，而链条是异步读出来的（可能跨文件），
    // 所以复用已有的那个方法，而不是在这里另起一条取数据的路径
    void this.refreshBreadcrumb();
    this.filterBar?.refresh();
    // 缩略图导航器（T5.09）：标题、无障碍名都是可见 / 可读文案，同样得当场跟着变
    this.minimap?.refreshLabels();
    this.linkOverview?.refresh();
    this.todoOverview?.refresh();
    // 画布提示是 `aria-describedby` 指向的一行隐藏文本，读屏只在聚焦时读它，
    // 但重建成本几乎为零，留着旧语言的文案反而会让人以为切换没生效
    const hint = this.contentEl.querySelector<HTMLElement>('.nestboard-visually-hidden');
    if (hint) hint.setText(canvasA11yHint());
    // 空板引导（T3.21）：它是**可见**文案，留着旧语言最扎眼。
    // ★ 这里也要按平台重新选一次，而不是复用建的时候那句 —— 同一块板
    //   可能在桌面标签和移动端标签里各开一份，两边的措辞本就该不同
    this.emptyHintEl?.setText(
      Platform.isMobile ? t('notice.mobileToolbarHint') : t('notice.emptyBoardHint'),
    );
  }

  /**
   * 切换缩略图导航器（T5.09 / `F1-06`）。
   *
   * ★ 它改的是**设置**，不是本次视图的临时状态。用户打开它是"我以后都想要它"、
   *   关掉它是"我不要了"；存成视图临时状态的话，下次打开标签它又会自己冒出来 ——
   *   "设置了但没记住"比没有这个开关更让人恼火。
   * ★ 于是它与另外两个入口**共用同一份真源**：设置面板里的那个开关、
   *   以及面板右上角那个 `×`（都落到 {@link setMinimapVisible}）。
   */
  toggleMinimap(): void {
    this.setMinimapVisible(!this.plugin.settings.minimap);
  }

  /**
   * 缩略图导航器的显隐（唯一入口）。
   *
   * ★ 先**就地**生效、再去落设置：等 `updateSettings` 回来才变的话，
   *   点一下要过一帧才看见反应（中间还要写一次盘）。
   *   其它已打开的视图由 `main.ts` 在设置落定后推给 `applyMinimapSetting` ——
   *   重入一次 `setVisible` 是幂等的（同一个值直接返回），不会打架。
   */
  private setMinimapVisible(visible: boolean): void {
    this.minimap?.setVisible(visible);
    void this.plugin.updateSettings({ minimap: visible });
  }

  /**
   * 设置变更后由 `main.ts` 推过来（T5.09）。
   *
   * ★ 不走 `refreshLocalizedChrome`：那个函数每次改"卡片圆角"都会跑一遍，
   *   而这是**一个开关的状态**，只在它真的变了时才该被推。
   */
  applyMinimapSetting(visible: boolean): void {
    this.minimap?.setVisible(visible);
  }

  /**
   * 把性能档位贴到视口与各画布层上（T3.22 / `02 §8.1`）。
   *
   * 三处一起改、一次改完：
   *  1. **裁剪外扩**（视口）：弱机上屏幕外每多留一张卡就是白建的 DOM；
   *  2. **复用池上限**（卡片层）：池子占的是常驻内存，手机上那是最稀缺的资源；
   *  3. **DPR 上限**（各 Canvas 层）：3x 屏的位图面积是 1x 的九倍，弱机扛不住。
   *
   * ★ 同时给根节点打上 `is-lite`：阴影 / 过渡 / 滤镜由 CSS 一夜之间全关，
   *   不必把每条规则在这里重写一遍。降级是"少一点装饰"，不是"少一点功能"。
   */
  private applyPerfProfile(): void {
    const profile = this.perfProfile;
    this.viewport.cullPadding = profile.cullPadding;
    this.contentEl.toggleClass('is-lite', !profile.decorations);

    // ★ 只有真正的 Canvas 图层有 DPR 一说。【背景层】不在名单里 ——
    //   它是 CSS 图案（`dataset.nestboardBg` 决定），没有位图，也就没有可以调低的分辨率。
    for (const layer of [this.edgeLayer, this.inkLayer, this.overlayLayer]) {
      layer?.capDevicePixelRatio(profile.maxDevicePixelRatio);
    }
    // 卡片层是 DOM（不是 Canvas），没有 DPR 一说 —— 它只有"池子多大"，
    // 而池子的上限是**构造时**吃进去的（见 `buildCanvas` 里传的 `maxPoolPerType`）：
    // 池子只在渲染过程中长，改一个数字不如重建时给对
  }
}

/**
 * 面包屑最多往上找几层。
 *
 * ★ 是一个**硬上限**而不只是"防环"：链再长，面包屑也放不下（`MAX_TRAIL_NODES`
 *   会把超出部分折成 `…`），继续逐级读文件只是白白花掉几次 IO。
 */
const TRAIL_DEPTH_LIMIT = 12;

/**
 * 点击选中连线的容差（**屏幕像素**，T1.71）。
 *
 * ★ 定义在屏幕像素上、使用时按 `zoom` 反算成世界距离：若直接写世界坐标里的 8，
 *   缩到 25% 时用户在屏幕上只有 2px 的瞄准余量 —— 而缩得越小，恰恰越需要
 *   靠连线看清板子结构。
 */
const EDGE_HIT_TOLERANCE_PX = 8;

/** 卡片 → 拖动控制器的矩形入参（只取几何，不带卡片引用） */
/** 这一下按键是不是落在"自己在用键"的元素上（输入框 / 按钮 / 可编辑块） */
function isInteractiveKeyTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.closest('input, textarea, select, button, [contenteditable="true"]') !== null;
}

function toCardRect(card: Card): CardRect {
  return {
    id: card.id,
    x: card.x,
    y: card.y,
    width: card.width,
    // ★ `O31`：收起时只有标题行那么高 —— 与 `CardLayer.cardRect` 同一个口径
    height: cardDisplayHeight(card),
  };
}

/**
 * 两个弧度是不是同一个（T7.12）。
 *
 * ★ `curve` 是对象，`===` 永远为 `false` —— 用它判"值没变"会导致
 *   每一次松手都记一步历史（哪怕用户只是点了一下手柄没拖）。
 * ★ `null` / `undefined` 都算"直线"，两者互等：模型里"没有弧度"有两种写法
 *   （键缺席 / 键为 null），比较时不能把它们当成不同的东西。
 */
function sameEdgeCurve(a: EdgeCurve | null, b: EdgeCurve | null): boolean {
  if (!a || !b) return !a && !b;
  return a.along === b.along && a.perp === b.perp;
}

/**
 * 滚轮 → 该滚多少像素（T2.03）。
 *
 * ★ 三种 `deltaMode` 都得认：鼠标滚轮大多是"像素"（一次 100），
 *   而 Firefox 的滚轮常给"行"（一次 3）—— 把 3 当成 3px 用，
 *   用户会觉得"栏里的滚动根本推不动"，而换个浏览器又好了。
 */
function wheelDelta(event: WheelEvent, clientHeight: number): number {
  const LINE_PX = 16;
  const unit =
    event.deltaMode === 1 ? LINE_PX : event.deltaMode === 2 ? Math.max(clientHeight, LINE_PX) : 1;
  const delta = event.deltaY * unit;
  // 触控板的惯性滚动偶尔会给出 `NaN` / `Infinity`；写进 `scrollTop` 会让它变成 NaN
  return Number.isFinite(delta) ? delta : 0;
}

/** 从事件目标向上找尺寸手柄，并校验方位名合法（DOM 属性可以被外部改坏） */
function resolveResizeHandle(target: EventTarget | null): ResizeHandle | null {
  if (!(target instanceof HTMLElement)) return null;
  const element = target.closest<HTMLElement>(`[${RESIZE_HANDLE_ATTR}]`);
  const value = element?.getAttribute(RESIZE_HANDLE_ATTR);
  if (!value) return null;
  return (RESIZE_HANDLES as readonly string[]).includes(value) ? (value as ResizeHandle) : null;
}

/**
 * 指针是不是按在旋转手柄上（T7.06 / `F2-00-10`）。
 *
 * ★ 只认属性在不在，不认值：旋转手柄只有一个，没有"是哪个"的问题
 *   （与尺寸手柄要校验 `nw` / `e`… 那张方位表不同）。
 */
function isRotateHandle(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.closest<HTMLElement>(`[${ROTATE_HANDLE_ATTR}]`) !== null;
}

/**
 * 剪贴板里的第一张图片。
 *
 * ★ `files` 与 `items` 两条路都要看：Chromium 系（Obsidian 桌面端）把粘贴的图片
 *   同时放进 `files` 与 `items`，但不同平台 / 版本实现并不一致，只认一条会漏。
 * ★ 只按 `type` 前缀判断，不判断大小 —— 截图大小没有下限，用户就是要粘那张小图。
 */
function firstClipboardImage(clipboard: DataTransfer): File | null {
  for (const file of Array.from(clipboard.files ?? [])) {
    if (file.type.startsWith('image/')) return file;
  }
  for (const item of Array.from(clipboard.items ?? [])) {
    if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;
    const file = item.getAsFile();
    if (file) return file;
  }
  return null;
}

/**
 * 解码一张图片供 Canvas 绘制（PNG 导出用，T2.11）。
 *
 * 失败返回 `null` 而**不抛**：缺图 / 坏图在导出时是常态（附件被移走、同步中的网盘文件），
 * 让一张图把整次导出带崩，用户得到的是"导出失败"，而他真正想导的另外三十张卡都没了。
 */
function loadCanvasImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = url;
  });
}
