/**
 * 卡片 / 画布右键菜单的**规格层**（T1.41 / T1.34）。
 *
 * 拆成两层是刻意的：
 *  * 本文件只产出「菜单长什么样」的纯数据（含各自的 `run` 回调），**不 import `obsidian`**
 *    —— 于是"多选时哪些项该置灰""改色应该作用到几张卡""引用卡额外有哪些项"
 *    这些真正容易错、又必须回归的规则可以在 node 下单测；
 *  * `ui/ContextMenus.ts` 负责把规格塞进 Obsidian 的 `Menu`。
 *
 * ★ 合规（`04 §13`）：菜单一律用 Obsidian 的 `Menu`，不自绘 div 菜单
 *   —— 自绘的菜单在手机上点不中、在弹出窗口里错位、主题一变就瞎眼。
 */

import { THEME_COLOR_OPTIONS, colorLabel } from '../../util/color';
import { t } from '../../util/i18n';
import { MIN_GROUP_SIZE, type AlignMode, type DistributeAxis } from '../../model/ops';
import type {
  BoardRefPreview,
  CardColor,
  Card,
  Column,
  Edge,
  EdgeEnd,
  EdgeRouting,
  HexColor,
} from '../../model/schema';
import type { CardMenuItemKey, CardTypeMenuItem } from '../../cards/registry';

/** 菜单项（与 `CardTypeMenuItem` 结构兼容，便于类型菜单直接并进来） */
export interface MenuItemSpec {
  id: string;
  title: string;
  icon?: string;
  checked?: boolean;
  disabled?: boolean;
  /** 在它之前插一条分隔线 */
  separatorBefore?: boolean;
  /** 子菜单：有一层嵌套就够（颜色、强调色）*/
  children?: MenuItemSpec[];
  run?: () => void;
}

/** 空白处右键 → 演示态下换成这一份（J-06） */
export interface PresentationMenuState {
  /** 当前步骤下标（`0` 起） */
  index: number;
  total: number;
}

/** 演示态下空白处右键能触发的一切 */
export interface PresentationMenuActions {
  previous(): void;
  next(): void;
  overview(): void;
  exit(): void;
}

/**
 * 演示态下的空白处右键菜单（J-06）。
 *
 * ★ 演示中右键**换菜单**而不是沿用画布菜单：后者第一个动作是"新建便签"，
 *   而演示态刻意不可编辑 —— 摆一排点了没反应的编辑项，比少几项更让人困惑。
 * ★ 上一步 / 下一步在两端**置灰**（与键盘的"到头停住"一致）：
 *   菜单是用户确认"我在哪、还能往哪走"的地方，灰着比消失更清楚。
 */
export function buildPresentationMenuSpec(
  actions: PresentationMenuActions,
  state: PresentationMenuState,
): MenuItemSpec[] {
  return [
    {
      id: 'present-previous',
      title: t('present.bar.previous'),
      icon: 'chevron-left',
      disabled: state.index <= 0,
      run: () => actions.previous(),
    },
    {
      id: 'present-next',
      title: t('present.bar.next'),
      icon: 'chevron-right',
      disabled: state.index >= state.total - 1,
      run: () => actions.next(),
    },
    {
      id: 'present-overview',
      title: t('present.bar.overview'),
      icon: 'maximize',
      separatorBefore: true,
      run: () => actions.overview(),
    },
    {
      id: 'present-exit',
      title: t('present.bar.exit'),
      icon: 'x',
      separatorBefore: true,
      run: () => actions.exit(),
    },
  ];
}

/** 右键菜单会触发的一切；由 `BoardView` 实现，测试里换成 spy */
export interface CardMenuActions {
  /** 进入编辑态（内容） */
  edit(id: string): void;
  /** 就地重命名标题 */
  editTitle(id: string): void;
  setShowTitle(show: boolean): void;
  /** 收起 / 展开这一张卡（`O31`） */
  toggleCollapse(id: string): void;
  /** 树折叠（`F7`）：把这张卡的子级收成「+N」/ 展开回去 */
  toggleTreeCollapse(id: string): void;
  /** 解除这一张卡的树父子关系（`F7`）：删掉那条树线，子卡原样留着 */
  unlinkTreeParent(id: string): void;
  /** 改背景色（主题编号或自定义 HEX） */
  setColor(color: CardColor): void;
  /** 改左侧强调色条（`null` = 不显示色条） */
  setAccent(accent: HexColor | null): void;
  /** 弹取色器；确定后回调 */
  pickColor(current: string | null, apply: (color: HexColor) => void): void;
  bringToFront(): void;
  sendToBack(): void;
  /**
   * 复制进**系统剪贴板**（T4.15 / `F7-07`）。
   *
   * ★ 与 {@link duplicate} 是两件事：那个是"原地再拉一张出来"（不出这块板），
   *   这个是"装进剪贴板"（可以贴到**别的**白板、别的库、别的窗口）。
   */
  copy(): void;
  /** 复制进剪贴板并从当前板删掉（可 `⌘Z` 撤销） */
  cut(): void;
  duplicate(): void;
  remove(): void;
  promote(id: string): void;
  toggleLock(locked: boolean): void;
  openSource(card: Card): void;
  relink(id: string): void;
  /**
   * 把引用卡定位到源笔记的某一处（T7.10 / `F10-07`）：标题或块。
   *
   * ★ 可选：目标清单要从源笔记正文里读出来，只有视图拿得到 `VaultBridge`。
   *   能力缺失时整项不出现（与 `editContent` / `cropImage` 同一套约定）。
   * ★ 与 `editContent` 是两个意图：这个是"卡面显示哪一段"，不是"改源笔记的字"。
   */
  pickBlock?(id: string): void;
  /**
   * 进入白板卡指向的那块白板（T1.61 / `F2-8-3`）。
   *
   * ★ 可选：与下面两个动作同理 —— 不带白板导航能力的上下文（测试、
   *   将来的嵌入视图）里"进入白板"整项不出现，而不是留一个死项。
   */
  openBoard?(card: Card): void;
  /**
   * 为一张**还没指向任何板**的白板卡新建一块子板（T1.61 / `F2-8-1`）。
   *
   * ★ 收 `card` 而不是 `id`：与 `openBoard` 同一形状（这个动作要读卡片自己的内容
   *   才知道能不能动手，先看内容再决定比"先调了再被拒"更好解释）。
   * ★ 可选：能力缺失时整项不出现（与 `openBoard` / `cropImage` 同一套约定）。
   */
  newChildBoard?(card: Card): void;
  /** 就地编辑图片说明文字（T1.50）。视图拿不到内容槽时整项不出现 */
  editCaption?(id: string): void;
  /**
   * 进入卡片的**内容**编辑态（T2.01 / `F2-2-3`）。
   *
   * ★ 与 `openSource` 是两个意图：引用卡的源笔记可以既"打开去 Obsidian 里大改"
   *   （`openSource`），也可以"就在卡片里改两行"（这里）。合并成一个入口的话，
   *   选了其中一个语义就必然丢掉另一个。
   *   可选：不支持内联编辑的类型 / 上下文里整项不出现。
   */
  editContent?(id: string): void;
  /**
   * 打开图片卡的**非破坏性裁剪**（T2.02 / `F2-3-3`）。
   *
   * ★ 可选：裁剪要弹对话框、还要能解析资源 URL —— 这两样只有视图拿得到。
   *   能力缺失时整项不出现（与 `editCaption` / `openBoard` 同一套约定）。
   */
  cropImage?(id: string): void;
  /**
   * 图片卡：**显示 / 隐藏边框与底色**（用户 2026-09-17："取消边框实际上是把图片卡的
   * 背景和边框都隐藏掉"）。
   *
   * ★ 可选：它改的是卡片自己的显示字段（要写历史栈），只有视图做得到 ——
   *   能力缺失时整项不出现（与 `editCaption` / `cropImage` 同一套约定）。
   */
  toggleCardBorder?(id: string): void;
  /**
   * 打开侧栏「卡片属性」（`B1`，用户 2026-09-18）：右键菜单的**第一项**。
   *
   * ★ 它改的是"这张卡的一切"，所以排在编辑 / 复制那些单项动作之前。
   */
  openInspector?(id: string): void;
  /**
   * 链接卡：**完整卡 ⇄ 迷你书签**（`A8`）。
   *
   * ★ 改的是内容里的 `style` **加上**卡片尺寸（一行书签不需要 150px 高）——
   *   两件事必须落在**同一次** `commit` 里，否则用户按一次 `⌘Z` 只会退回一半。
   */
  toggleLinkStyle?(id: string): void;
  /**
   * 仅标题卡：**纯圆角 ⇄ 带气泡**（`A3`）。
   *
   * ★ 与链接卡那条同一个形状（`toggleLinkStyle`）：改的是**内容里的样式键**，
   *   而"默认那一档不写进文件"由视图那边 `delete` 保证。
   */
  setTitleShape?(id: string, shape: 'pill' | 'bubble'): void;
  /** 仅标题卡：气泡的**指针朝哪边**（`A3`）。`pill` 档下这一项不出现（没有指针可指） */
  setTitleTail?(id: string, tail: 'bottom' | 'top' | 'left' | 'right'): void;
  /**
   * 给地图卡换一张地图图（T7.03 / `F2.9`）。
   *
   * ★ 可选：要弹库内文件选择器，那是视图的能力。缺失时整项不出现
   *   （与 `cropImage` / `pickFromImage` 同一套约定）。
   *   ★ 换图**保留图钉**：见 `cards/map.ts` —— 新图多半是同一片区域的另一个版本。
   */
  pickMapImage?(id: string): void;
  /**
   * 给地图卡**粘贴一条地图分享链接**（`O08`）：认得出坐标就存下来，
   * 配好了静态图服务就顺带下载一张图。
   *
   * ★ 与 `fetchPreview`（链接卡「获取预览」）是同一类动作：会发网络请求，所以
   *   **只有用户点了菜单项才会发生**，渲染路径一次都不联网。
   * ★ 可选：解析、下载、落盘、写模型这一串全在视图层（要弹窗、要网络）。
   *   缺失时整项不出现（与 `pickMapImage` 同一套约定）。
   */
  pasteMapLink?(id: string): void;
  /**
   * 用系统浏览器打开地图卡记下的那条链接（`O08`）。
   *
   * ★ 它是**读**动作（不改卡片），但仍然走命名动作而不是让 `cards/` 层直接调
   *   `openExternal`：卡片定义那层拿不到外链桥（见 `CardRenderContext.links`），
   *   而且"外链一律由视图发起"这条规矩不该为一次双击破例。
   */
  openMapLink?(id: string): void;
  /**
   * 给一张同步便签**再摆一处**（T7.04 / `F2.9`）：新卡进同一个同步组。
   *
   * ★ 可选：要往模型里加卡，那是视图的能力。缺失时整项不出现
   *   （与 `cropImage` / `pickMapImage` 同一套约定）。
   */
  duplicateSyncNote?(id: string): void;
  /**
   * 把一张同步便签**移出同步组**（清空 `key`），它从此就是一张普通便签（T7.04）。
   *
   * ★ **只影响这一张**，同组的其它张照旧同步 —— 这正是"取消同步"该有的意思。
   * ★ 可选：与 `duplicateSyncNote` 同一套约定。
   */
  unsyncNote?(id: string): void;
  /**
   * 把一条评论线程标为已解决 / 重新打开（T7.05 / `F2.9`）。
   *
   * ★ 它是**改内容**（`CommentContent.resolved`），而卡片定义那层拿不到写内容的能力，
   *   所以走命名动作回到视图 —— 与 `duplicateSyncNote` 同一个理由。
   * ★ 可选：缺失时整项不出现。
   */
  toggleCommentResolved?(id: string): void;
  /**
   * 把一张卡片**转回正**（T7.06 / `F2-00-10`）。
   *
   * ★ 它是**改几何**（`card.rotation`），与 `align` 同一类 —— 不提供几何编辑能力的
   *   上下文里整项不出现；只读板由 `readOnly` 那条路统一置灰。
   * ★ 菜单里只有"回正"这一项，没有"转 90° / 15°"：那些有手柄
   *   （拖手柄 + `⇧` 吸附到 15°，见 `ROTATE_SNAP_STEP`），
   *   菜单里再摆一排角度只是把同一个能力说两遍。
   */
  resetRotation?(id: string): void;
  /**
   * 换白板卡的**卡面预览方式**（T7.09 / `F7-10` / `O09`）：
   * 缩略图 / 只读小窗 / 只留缩略图的 mini / 不预览。
   *
   * ★ 它是**改内容**（`BoardRefContent.preview`），与 `toggleCommentResolved` 同一类：
   *   卡片定义那层拿不到写内容的能力，所以走命名动作回到视图。
   * ★ 收一个档位而不是"切换"：菜单里四个档位各占一项（`checked` 标出当前那个），
   *   点了哪个就是哪个 —— "切换"要么得先知道当前值、要么在多选下没有唯一含义。
   * ★ 可选：缺失时四个档位整项不出现（与 `cropImage` / `pickMapImage` 同一套约定）。
   */
  boardPreview?(card: Card, preview: BoardRefPreview): void;
  /**
   * 换白板卡的**卡面图标**（`O10`）：弹一个 emoji 选择器，选完写回 `BoardRefContent.icon`。
   *
   * ★ 它是**改内容**（`BoardRefContent.icon`），与 `boardPreview` 同一类：
   *   卡片定义那层拿不到"弹窗 + 写内容"这两样，所以走命名动作回到视图。
   * ★ 可选：选择器只有视图弹得出来，缺失时整项不出现
   *   （与 `boardPreview` / `pickBlock` 同一套约定）。
   */
  pickBoardIcon?(id: string): void;
  /**
   * 清掉白板卡的卡面图标（`O10`）。
   *
   * ★ 与 `pickBoardIcon` 分成两个动作，而不是"在选择器里选空" ——
   *   那个入口只在卡片**有图标**时才出现，对应菜单里同样只在该出现时才摆的「清除」项
   *   （与 `edge-label-clear` / `clearLabel` 同一条取舍）。
   * ★ 可选：缺失时整项不出现。
   */
  clearBoardIcon?(id: string): void;
  /**
   * 切换便签的**深色变体**（`O06`）：浅色 ⇄ 黑底白字。
   *
   * ★ 它是**改内容**（`NoteContent.variant`），与 `boardPreview` 同一类：
   *   卡片定义那层拿不到写内容的能力，所以走命名动作回到视图
   *   （切换逻辑在 `BoardView.toggleNoteVariant`，写进撤销栈）。
   * ★ 这里是"切换"而不是"收一个变体值"：只有两种，菜单里摆两项
   *   （"变深色" / "变浅色"）每次必然要灰掉一项，而且灰掉的那项还占着位置。
   *   ★ 与 `boardPreview` 那条"不收切换"的取舍不矛盾：那边是四档、点哪档是实质选择，
   *   这边就两档、且是纯粹的开关。
   * ★ 可选：缺失时整项不出现（与 `clearBoardIcon` 同一套约定）。
   */
  toggleNoteVariant?(id: string): void;
  /**
   * 抓一次链接卡的网页预览（T2.05 / `F2-4-3`）。
   *
   * ★ 可选：抓取要走网络，只有视图那层拿得到 `LinkPreviewBridge`。
   *   能力缺失时整项不出现（与 `cropImage` / `editCaption` 同一套约定）。
   *   ★ 与卡片上的按钮同源：这里只是"从菜单再给一个入口"，实现只有一份。
   */
  fetchPreview?(id: string): void;
  /**
   * 从图片卡上吸一个像素的颜色，加进色板（T3.05 / `F2.6`）。
   *
   * ★ 可选：取色是一段**跨卡片**的交互（在色板卡上发起、到图片卡上落地），
   *   卡片定义自己拿不到别的卡的 DOM，只有视图能驱动。
   *   能力缺失时整项不出现（与 `cropImage` / `fetchPreview` 同一套约定）。
   */
  pickFromImage?(id: string): void;
  /**
   * 改一笔手绘的颜色（T3.08 / `F4-04`）。
   *
   * ★ 可选：要弹取色器（`pickColor`），那是视图的能力。缺失时整项不出现
   *   （与 `cropImage` / `pickFromImage` 同一套约定）。
   */
  inkColor?(id: string): void;
  /**
   * 进入手绘态、直接在卡片上标注（T3.09 / `F4-05`）。
   *
   * ★ **不收 id**：标注算谁的由笔迹的落点算出来（`cards/ink.ts` 的 `inkHostCard`），
   *   不靠"从哪张卡的菜单点进来"决定 —— 后者会让"右键选标注、却画到别处"的笔
   *   落成一张归属错误的卡。与 `inkColor` 同理：能力缺失时整项不出现。
   */
  inkAnnotate?(): void;
  /**
   * 把选中的卡片收进一个**新建**的分栏（T1.59 / `F2-7-8` / `⌘⇧G`）。
   *
   * ★ 可选：这两个动作要求视图有分栏能力。做成可选而不是必填，
   *   是为了让"不带分栏的轻量上下文"（测试、将来的嵌入视图）仍能复用这份菜单规格 ——
   *   能力缺失时**整项不出现**，而不是留一个点了没反应的死项。
   */
  collectIntoColumn?(): void;
  /** 把选中的卡片拆成一卡一栏（T1.58 / `F2-7-7` / `⌘Enter`） */
  splitIntoColumns?(): void;
  /**
   * 对齐（T3.13 / `F5-04`）。
   *
   * ★ 可选：嵌入视图等只读上下文里没有几何编辑能力，整项不出现
   *   （与 `collectIntoColumn` / `cropImage` 同一套约定）。
   */
  align?(mode: AlignMode): void;
  /** 等距分布（T3.13）：选中三张以上才有意义，视图负责把不足三张的置灰逻辑交给规格层 */
  distribute?(axis: DistributeAxis): void;
  /** 编组（T3.14 / `F5-05`）：至少两张 */
  group?(): void;
  /** 取消编组（T3.14） */
  ungroup?(): void;
  /**
   * 把**选中的全部卡片**放进 / 移出演示路径（J-07）。
   *
   * ★ 收布尔而不是"切换"：多选时"每张各自翻转"会得到一个混合状态
   *   （本来在路径里的被移出、不在的被加进来），而用户点这一项时心里只有
   *   一个方向。方向由规格层按当前状态定好再传进来。
   * ★ 可选：需要视图持有演示状态，缺失时整项不出现
   *   （与 `collectIntoColumn` / `cropImage` 同一套约定）。
   */
  setPresentStep?(on: boolean): void;
  /**
   * 把一张卡在演示路径里前移 / 后移一位（J-07）。
   *
   * ★ 只在**单选且它已在路径里**时出现：多选时"前移"要同时挪好几张，
   *   挪完的相对次序没有唯一合理解释；不在路径里也谈不上"第几步"。
   */
  movePresentStep?(id: string, delta: -1 | 1): void;
}

/**
 * 类型贡献的菜单项：`CardTypeMenuItem` 结构上兼容 `MenuItemSpec`，额外多一个 `action`。
 *
 * ★ `children` 要在这里**再写一遍**（而不是靠 `MenuItemSpec` 那一份）：
 *   子项也可能是类型贡献的项（白板卡的"卡面预览"三个档位都带 `action`），
 *   而 `MenuItemSpec.children` 里没有 `action`，照抄过去就绑不上动作了。
 */
export interface TypeMenuInput extends MenuItemSpec {
  action?: CardTypeMenuItem['action'];
  children?: TypeMenuInput[];
}

export interface CardMenuInput {
  /** 当前选中的全部卡片（长度 > 1 即多选） */
  selection: readonly Card[];
  /** 被右击的那张 —— 单选时等于 `selection[0]`，多选时是"主目标" */
  target: Card;
  actions: CardMenuActions;
  /** 卡片类型提供的菜单项（引用卡的"打开源笔记""重新链接"…） */
  typeItems?: readonly TypeMenuInput[];
  /**
   * 被右击的这张卡是否已经在某个编组里（决定"取消编组"是否可用）。
   *
   * ★ 让规格层从输入里拿到这个事实，而不是自己去猜 `selection` 里有没有组 ——
   *   编组关系存在 `board.groups` 上、不在 `Card` 上（见 `model/ops.ts` 的约定），
   *   规格层看不见它，硬猜只会猜错。
   */
  grouped?: boolean;
  /**
   * 这张卡的**树关系**速览（`F7`）。省略 = 视图没给（老调用方 / 测试）⇒ 三个树菜单项都不出现。
   *
   * ★ 与 `grouped` 同一条约定：树关系存在 `board.edges` 上、不在 `Card` 上，
   *   规格层看不见它，由视图用 `model/tree` 算好递进来。
   */
  tree?: {
    /** 直接子级数（折叠菜单项与 +N 同一个数） */
    childCount: number;
    /** 当前是否已折叠子级 */
    collapsed: boolean;
    /** 这张卡有没有树父级（决定「解除父子关系」是否出现） */
    hasParent: boolean;
  };
  /**
   * 这个类型**双击会不会被自己接走**（`O35`）。省略 = `true`（双击进编辑态）。
   *
   * ★ 为 `false` 时「编辑内容」整项不出现：那些类型的双击是"打开文件 / 跳浏览器 /
   *   进子板 / 弹调色板"，这一项点下去是**跳转**而不是编辑 —— 名不副实
   *   （引用卡上还会与本类型自己的「编辑内容」重名成两条）。
   * ★ 由视图从注册表算好传进来（`CardTypeRegistry.inlineEditable`）：
   *   规格层不认识类型名册，也不该认识。
   */
  inlineEdit?: boolean;
  /**
   * 这个类型**关掉**的那几项通用菜单项（`A3` 仅标题卡，用户 2026-09-18："编辑内容 /
   * 收起卡片 / 显示隐藏标题 这些菜单对于标题卡没意义"）。
   *
   * ★ 与 `inlineEdit` 同一种约定：规格层不认识类型名册 —— 由视图从卡片定义上读
   *   `menuItems`、在这里递进来，规格层只负责"这几项别摆出来"。
   * ★ 命中的项**整项不出现**（不是置灰）：见 `CardMenuItemKey` 的说明。
   */
  hiddenItems?: ReadonlySet<CardMenuItemKey>;
  /**
   * 这块板是不是只读（归档锁定 / 保护态，T4.06 / `03 §2.5`）。
   *
   * ★ 规格层拿不到仓库，所以由视图把这个事实**递进来** —— 与 `grouped` 同一种约定：
   *   规格层只做"给定事实、摆出菜单"的纯计算，不去自己查状态。
   */
  readOnly?: boolean;
}

/**
 * 「纯读」的类型菜单动作：不往 `.nboard` 里写一个字节。
 *
 * ★ 只有这三个。**归档板不是要把一切都断掉** —— 打开源笔记、跳到子板、
 *   拉一次预览都不碰模型，锁了照样该能用。
 * ★ 用字符串集合而不是 `CardTypeMenuItem['action']` 的联合类型：将来类型定义
 *   新增动作时，这里**默认落到"不允许"**（集合里没有 = 置灰），
 *   而联合类型会让 TS 报错、逼着人在不认识的语义下做选择。
 *   宁可多灰一项，也不要在只读板上放一个能写文件的入口。
 */
const READ_ONLY_SAFE_ACTIONS: ReadonlySet<string> = new Set([
  'openSource',
  'openBoard',
  'fetchPreview',
]);

/**
 * 把类型贡献的菜单项绑到 `CardMenuActions` 上。
 *
 * 卡片定义只说"我要一个『打开源笔记』"，具体打开哪张卡由这里补上 `target` ——
 * `cards/` 层因此不认识 `CardMenuActions`，也就继续能在 node 下单测。
 *
 * ★ 返回 `null` = 视图没提供这个能力，**整项不出现**。
 *   类型定义是"常量声明"、能力是"视图可选的"，两者会脱钩（比如图片卡在
 *   嵌入视图里渲染时没有内容槽）。留一个点了没反应的死项，比少一项糟得多。
 */
function bindTypeItem(
  item: TypeMenuInput,
  target: Card,
  actions: CardMenuActions,
): MenuItemSpec | null {
  const spec: MenuItemSpec = {
    id: item.id,
    title: item.title,
    icon: item.icon,
    checked: item.checked,
    disabled: item.disabled,
    separatorBefore: item.separatorBefore,
  };

  // 分组项（T7.09）：自己没有动作，活的是子项。递归下去 —— 一层就是一层，
  // 但**必须递归**：子项也可能带 `action`，不递归等于把它们当成了死项。
  if (item.children && item.children.length > 0) {
    const children: MenuItemSpec[] = [];
    for (const child of item.children) {
      const bound = bindTypeItem(child, target, actions);
      if (bound) children.push(bound);
    }
    if (children.length === 0) return null;
    spec.children = children;
    return spec;
  }

  switch (item.action) {
    case 'openSource':
      spec.run = () => actions.openSource(target);
      break;
    case 'relink':
      spec.run = () => actions.relink(target.id);
      break;
    case 'pickBlock':
      if (!actions.pickBlock) return null;
      spec.run = () => actions.pickBlock?.(target.id);
      break;
    case 'openBoard':
      if (!actions.openBoard) return null;
      spec.run = () => actions.openBoard?.(target);
      break;
    case 'newChildBoard':
      if (!actions.newChildBoard) return null;
      spec.run = () => actions.newChildBoard?.(target);
      break;
    // 卡面预览档位（T7.09 / `F7-10` / `O09`）：四个动作形状相同、只差一个常量，
    // 但**不合并成一个分支** —— 合并要先把 `item.action` 重新解析回档位，
    // 那等于在绑定层再写一遍"动作名 → 语义"的映射，正是这一层要避免的事。
    case 'boardPreviewThumb':
      if (!actions.boardPreview) return null;
      spec.run = () => actions.boardPreview?.(target, 'thumb');
      break;
    case 'boardPreviewLive':
      if (!actions.boardPreview) return null;
      spec.run = () => actions.boardPreview?.(target, 'live');
      break;
    case 'boardPreviewNone':
      if (!actions.boardPreview) return null;
      spec.run = () => actions.boardPreview?.(target, 'none');
      break;
    case 'boardPreviewMini':
      if (!actions.boardPreview) return null;
      spec.run = () => actions.boardPreview?.(target, 'mini');
      break;
    // 卡面图标（`O10`）：选择 / 清除各一，都是"改这张卡的内容"
    case 'pickBoardIcon':
      if (!actions.pickBoardIcon) return null;
      spec.run = () => actions.pickBoardIcon?.(target.id);
      break;
    case 'clearBoardIcon':
      if (!actions.clearBoardIcon) return null;
      spec.run = () => actions.clearBoardIcon?.(target.id);
      break;
    // 深色便签（`O06`）：一个开关，所以是"切换"而不是"点哪档是哪档"
    case 'toggleNoteVariant':
      if (!actions.toggleNoteVariant) return null;
      spec.run = () => actions.toggleNoteVariant?.(target.id);
      break;
    case 'editCaption':
      if (!actions.editCaption) return null;
      spec.run = () => actions.editCaption?.(target.id);
      break;
    case 'editContent':
      if (!actions.editContent) return null;
      spec.run = () => actions.editContent?.(target.id);
      break;
    case 'cropImage':
      if (!actions.cropImage) return null;
      spec.run = () => actions.cropImage?.(target.id);
      break;
    case 'toggleCardBorder':
      if (!actions.toggleCardBorder) return null;
      spec.run = () => actions.toggleCardBorder?.(target.id);
      break;
    case 'toggleLinkStyle':
      if (!actions.toggleLinkStyle) return null;
      spec.run = () => actions.toggleLinkStyle?.(target.id);
      break;
    // 仅标题卡（`A3`）：**一个档位一个动作名**。
    // ★ `action` 是纯字符串、带不了参数（见 `CardTypeMenuItem.action` 的说明），
    //   所以"哪种形状 / 哪个方向"只能编进名字里 —— 与 `boardPreviewMini` /
    //   `boardPreviewLive` 那四档同一个做法。
    case 'set-title-pill':
      if (!actions.setTitleShape) return null;
      spec.run = () => actions.setTitleShape?.(target.id, 'pill');
      break;
    case 'set-title-bubble':
      if (!actions.setTitleShape) return null;
      spec.run = () => actions.setTitleShape?.(target.id, 'bubble');
      break;
    case 'set-title-tail-bottom':
      if (!actions.setTitleTail) return null;
      spec.run = () => actions.setTitleTail?.(target.id, 'bottom');
      break;
    case 'set-title-tail-top':
      if (!actions.setTitleTail) return null;
      spec.run = () => actions.setTitleTail?.(target.id, 'top');
      break;
    case 'set-title-tail-left':
      if (!actions.setTitleTail) return null;
      spec.run = () => actions.setTitleTail?.(target.id, 'left');
      break;
    case 'set-title-tail-right':
      if (!actions.setTitleTail) return null;
      spec.run = () => actions.setTitleTail?.(target.id, 'right');
      break;
    case 'pickMapImage':
      if (!actions.pickMapImage) return null;
      spec.run = () => actions.pickMapImage?.(target.id);
      break;
    // 地图链接（O08）：两项在 `pickMapImage` **前面**（顺序由各卡片自己的
    // `contextMenu` 决定，见 `MapCardType.contextMenu`），这里只管转发
    case 'pasteMapLink':
      if (!actions.pasteMapLink) return null;
      spec.run = () => actions.pasteMapLink?.(target.id);
      break;
    case 'openMapLink':
      if (!actions.openMapLink) return null;
      spec.run = () => actions.openMapLink?.(target.id);
      break;
    case 'duplicateSyncNote':
      if (!actions.duplicateSyncNote) return null;
      spec.run = () => actions.duplicateSyncNote?.(target.id);
      break;
    case 'unsyncNote':
      if (!actions.unsyncNote) return null;
      spec.run = () => actions.unsyncNote?.(target.id);
      break;
    case 'toggleCommentResolved':
      if (!actions.toggleCommentResolved) return null;
      spec.run = () => actions.toggleCommentResolved?.(target.id);
      break;
    case 'fetchPreview':
      if (!actions.fetchPreview) return null;
      spec.run = () => actions.fetchPreview?.(target.id);
      break;
    case 'pickFromImage':
      if (!actions.pickFromImage) return null;
      spec.run = () => actions.pickFromImage?.(target.id);
      break;
    case 'inkColor':
      if (!actions.inkColor) return null;
      spec.run = () => actions.inkColor?.(target.id);
      break;
    case 'inkAnnotate':
      if (!actions.inkAnnotate) return null;
      spec.run = () => actions.inkAnnotate?.();
      break;
    default:
      spec.run = item.run;
      break;
  }
  return spec;
}

/**
 * 卡片右键菜单。
 *
 * ★ 多选的取舍：**只保留"批量说得通"的操作**（改色 / 层级 / 复制 / 删除 / 锁定）。
 *   "编辑内容""编辑标题""提升为笔记"对 3 张卡没有明确含义 —— 与其猜一个
 *   （改第一张？全部？），不如置灰：用户看得见能力，但知道它需要一个目标。
 */
export function buildCardMenuSpec(input: CardMenuInput): MenuItemSpec[] {
  const {
    selection,
    target,
    actions,
    typeItems = [],
    readOnly = false,
    inlineEdit = true,
    hiddenItems,
    tree,
  } = input;
  const multiple = selection.length > 1;
  const count = selection.length;
  // 混合状态（一部分在路径里、一部分不在）按"还没全进去"处理 → 给"加入"：
  // 多选编演示时用户的意图通常是"把这一片都加进去"，而"移出"由单选或全选路径时给
  const allInPresentation = count > 0 && selection.every((card) => card.presentStep !== null);

  /**
   * 复制 / 剪切（T4.15 / `F7-07`）。
   *
   * ★ 与下面的「原地复制」是两件事：原地复制是"在这块板上再拉一张出来"，
   *   这两个装的是**系统剪贴板** —— 可以贴到另一块白板、另一个库、另一个窗口。
   * ★ 先定义成变量再入数组，是为了给只读判定留一份**引用**（见下面的 `safe`）：
   *   **复制不写模型**，归档板上照样该能用；剪切会删卡，得跟着写操作一起置灰。
   */
  const copyItem: MenuItemSpec = {
    id: 'copy',
    title: t('menu.card.copy'),
    icon: 'copy',
    run: () => actions.copy(),
  };
  const cutItem: MenuItemSpec = {
    id: 'cut',
    title: t('menu.card.cut'),
    icon: 'scissors',
    run: () => actions.cut(),
  };

  /**
   * 「编辑内容」（`O35`）：**只在"双击真的会进编辑态"的类型上给**。
   *
   * ★ 不置灰而是整项不出现：它不是一个"此刻不可用"的动作，而是**对该类型不成立** ——
   *   置灰会让用户以为"是不是哪里没满足"，而真相是这个类型根本没有可编辑的正文。
   */

  const items: MenuItemSpec[] =
    inlineEdit && !hiddenItems?.has('editContent')
      ? [
          {
            id: 'edit',
            title: t('menu.card.edit'),
            icon: 'pencil',
            disabled: multiple,
            run: () => actions.edit(target.id),
          },
        ]
      : [];

  /**
   * 只读板上**仍然可用**的项。
   *
   * ★ 按对象引用记，而不是给宿主的 `MenuItemSpec` 加一个 `readOnlySafe` 字段：
   *   那个类型是渲染层（`ui/ContextMenus`）的公共契约，为了菜单里的一处判断
   *   往上加字段，会把"只读"这个概念漏进一个本该不认识它的模块。
   */
  const safe = new Set<MenuItemSpec>();

  for (const item of typeItems) {
    const spec = bindTypeItem(item, target, actions);
    if (!spec) continue;
    items.push(spec);
    if (READ_ONLY_SAFE_ACTIONS.has(item.action ?? '')) safe.add(spec);
  }

  items.push(
    {
      id: 'edit-title',
      title: t('menu.card.editTitle'),
      icon: 'text-cursor-input',
      disabled: multiple,
      run: () => actions.editTitle(target.id),
    },
    // 显示 / 隐藏标题：**没有标题行**的类型（仅标题卡，那行字就是它的全部）整项不出现
    ...(hiddenItems?.has('showTitle')
      ? []
      : [
          {
            id: 'toggle-title',
            title: target.showTitle ? t('menu.card.hideTitle') : t('menu.card.showTitle'),
            icon: target.showTitle ? 'eye-off' : 'eye',
            run: () => actions.setShowTitle(!target.showTitle),
          },
        ]),
    // 收起 / 展开（`O31`）：菜单标题写的是"点下去会发生什么"（与「显示/隐藏标题」同一条）。
    // ★ 多选时置灰："把哪一张收起来"没有唯一答案。没有标题行的卡片仍可用菜单展开回去
    //   （画面上那个按钮藏在标题行里，见 `CardLayer`），所以这里不给"没标题就隐藏"。
    // ★ 对**仅标题卡**收起只会把唯一的内容藏掉（只剩空壳）⇒ 那一类整项不出现（`menuItems`）。
    ...(hiddenItems?.has('collapse')
      ? []
      : [
          {
            id: 'toggle-collapse',
            title: target.collapsed === true ? t('menu.card.expand') : t('menu.card.collapse'),
            icon: target.collapsed === true ? 'chevrons-up-down' : 'chevrons-down-up',
            disabled: multiple,
            run: () => actions.toggleCollapse(target.id),
          },
        ]),
    // 树折叠 / 解除父子（`F7`）：有子级才有"折叠"，有父级才谈"解除"。
    // ★ 不出现而不是置灰：没有树关系的卡占绝大多数（与"重置旋转"同一条取舍）。
    ...(tree && tree.childCount > 0 && !multiple
      ? [
          {
            id: 'toggle-tree-collapse',
            title: tree.collapsed
              ? t('menu.card.treeExpand', { count: tree.childCount })
              : t('menu.card.treeCollapse', { count: tree.childCount }),
            icon: 'list-tree',
            disabled: readOnly,
            run: () => actions.toggleTreeCollapse(target.id),
          },
        ]
      : []),
    ...(tree && tree.hasParent && !multiple
      ? [
          {
            id: 'unlink-tree-parent',
            title: t('menu.card.treeUnlink'),
            icon: 'unlink',
            disabled: readOnly,
            run: () => actions.unlinkTreeParent(target.id),
          },
        ]
      : []),
    // 重置旋转（T7.06 / `F2-00-10`）：只在**真的转过的**卡片上出现。
    // ★ 不出现而不是置灰：没转过的卡片占绝大多数，"重置旋转"在那儿永远点不动 ——
    //   一排永远灰着的项会让人以为功能没做好（与 `present-step-earlier` 同一条取舍）。
    // ★ 只在单选时给：旋转本身没有多选语义（见 `DragController` 的 rotate 分支），
    //   多选时这一项要"重置哪一张"没有答案。
    ...(actions.resetRotation && !multiple && (target.rotation ?? 0) !== 0
      ? [
          {
            id: 'reset-rotation',
            title: t('menu.card.resetRotation'),
            icon: 'rotate-ccw',
            run: () => actions.resetRotation?.(target.id),
          },
        ]
      : []),
    {
      id: 'color',
      title: t('menu.card.color'),
      icon: 'palette',
      separatorBefore: true,
      children: [
        ...THEME_COLOR_OPTIONS.map((color) => ({
          id: `color-${color}`,
          title: colorLabel(color),
          checked: target.color === color,
          run: () => actions.setColor(color),
        })),
        {
          id: 'color-custom',
          title: t('color.custom'),
          separatorBefore: true,
          run: () =>
            actions.pickColor(target.color, (hex) => {
              actions.setColor(hex);
            }),
        },
      ],
    },
    {
      id: 'bring-to-front',
      title: t('menu.card.bringToFront'),
      icon: 'bring-to-front',
      separatorBefore: true,
      run: () => actions.bringToFront(),
    },
    {
      id: 'send-to-back',
      title: t('menu.card.sendToBack'),
      icon: 'send-to-back',
      run: () => actions.sendToBack(),
    },
    // 卡片属性（`B1`，用户 2026-09-18："入口在卡片右键菜单 —— 打开一个右侧窗口操作卡片的
    // 全属性"）：**排在最前** —— 它管的是"这张卡的一切"，下面那些都是单项动作。
    // ★ 多选时置灰（"把哪一张的属性打开"没有唯一答案）；视图没接这个能力时整项不出现
    ...(actions.openInspector
      ? [
          {
            id: 'inspector',
            title: t('menu.card.inspector'),
            icon: 'sliders-horizontal',
            disabled: multiple,
            run: () => actions.openInspector?.(target.id),
          },
        ]
      : []),
    copyItem,
    cutItem,
    {
      id: 'duplicate',
      title: t('menu.card.duplicate'),
      icon: 'copy-plus',
      run: () => actions.duplicate(),
    },
    // 排版类动作（对齐 / 等距分布 / 编组 / 分栏）收进一个子菜单（`C2`，用户 2026-09-18：
    // "右键菜单整理"）。
    // ★ 这四类说的是**同一件事**："把这几张卡在板子上摆成某个样子" —— 与上面那些
    //   "改这一张卡"的动作（改名 / 改色 / 收起）不是一回事。平铺着摆的话，一份二十行的
    //   菜单里有一半是排版，找"删除"得从头读到尾。
    // ★ 子菜单里仍按原来的四段排、段间留分隔线（`separatorBefore` 在子菜单里同样生效，
    //   见 `ui/ContextMenus.ts` 的 `appendItems`）。
    // ★ 只有一层：`setSubmenu()` 那套刻意不支持"子菜单里再套子菜单"（`MenuItemSpec`
    //   的文件头写着理由 —— 手要横着走两遍）。所以原来那个「对齐」子菜单在这里**拍平**了。
    // ★ 一个子项都绑不上时整组不出现（`bindCardMenuItems` 的规矩），这里只管列出
    //   "视图给了能力的"那几项。
    ...(actions.align ||
    actions.group ||
    actions.ungroup ||
    actions.collectIntoColumn ||
    actions.splitIntoColumns
      ? [
          {
            id: 'arrange',
            title: t('menu.card.arrange'),
            icon: 'layout-grid',
            separatorBefore: true,
            children: [
              // 一张卡谈不上对齐 ⇒ 不足两张时这几项整批不出现
              ...(actions.align && count >= 2
                ? [
                    {
                      id: 'align-left',
                      title: t('menu.card.alignLeft'),
                      icon: 'align-start-vertical',
                      run: () => actions.align?.('left'),
                    },
                    {
                      id: 'align-right',
                      title: t('menu.card.alignRight'),
                      run: () => actions.align?.('right'),
                    },
                    {
                      id: 'align-top',
                      title: t('menu.card.alignTop'),
                      run: () => actions.align?.('top'),
                    },
                    {
                      id: 'align-bottom',
                      title: t('menu.card.alignBottom'),
                      run: () => actions.align?.('bottom'),
                    },
                    {
                      id: 'align-center-x',
                      title: t('menu.card.alignCenterX'),
                      run: () => actions.align?.('centerX'),
                    },
                    {
                      id: 'align-center-y',
                      title: t('menu.card.alignCenterY'),
                      run: () => actions.align?.('centerY'),
                    },
                  ]
                : []),
              // 分布要三张起（两张之间只有一段空隙，天然等距）→ 不足就置灰
              ...(actions.align && count >= 2
                ? [
                    {
                      id: 'distribute-x',
                      title: t('menu.card.distributeX'),
                      separatorBefore: true,
                      disabled: count < 3 || !actions.distribute,
                      run: () => actions.distribute?.('x'),
                    },
                    {
                      id: 'distribute-y',
                      title: t('menu.card.distributeY'),
                      disabled: count < 3 || !actions.distribute,
                      run: () => actions.distribute?.('y'),
                    },
                  ]
                : []),
              // "取消编组"的可用性由 `grouped` 决定 —— 选中的卡根本不在任何组里时置灰，
              // 比点下去弹一句"不在编组里"更早地把话说清
              ...(actions.group
                ? [
                    {
                      id: 'group',
                      title: t('menu.card.group'),
                      icon: 'group',
                      separatorBefore: true,
                      disabled: count < 2,
                      run: () => actions.group?.(),
                    },
                  ]
                : []),
              ...(actions.ungroup
                ? [
                    {
                      id: 'ungroup',
                      title: t('menu.card.ungroup'),
                      icon: 'ungroup',
                      disabled: !input.grouped,
                      run: () => actions.ungroup?.(),
                    },
                  ]
                : []),
              // 分栏（T1.58 / T1.59）：视图没提供这两个能力时整项不出现 ——
              // 菜单里最让人恼火的不是缺功能，而是有一项点下去什么都没发生
              ...(actions.collectIntoColumn
                ? [
                    {
                      id: 'collect-into-column',
                      title: t('menu.card.collect'),
                      icon: 'columns-3',
                      separatorBefore: true,
                      run: () => actions.collectIntoColumn?.(),
                    },
                  ]
                : []),
              ...(actions.splitIntoColumns
                ? [
                    {
                      id: 'split-into-columns',
                      title: t('menu.column.split'),
                      icon: 'columns-2',
                      // 一张卡拆成"一卡一栏"没有意义，至少要两张
                      disabled: count < 2,
                      run: () => actions.splitIntoColumns?.(),
                    },
                  ]
                : []),
            ],
          },
        ]
      : []),
    {
      id: 'toggle-lock',
      title: target.locked ? t('menu.card.unlock') : t('menu.card.lock'),
      icon: target.locked ? 'unlock' : 'lock',
      run: () => actions.toggleLock(!target.locked),
    },
    // 演示路径（J-07）：与"层级 / 复制"这些排版动作隔一条线 —— 它编排的是**讲的时候**
    // 的次序，不是卡片在板子上的样子。
    ...(actions.setPresentStep
      ? [
          {
            id: 'present-step',
            title: allInPresentation ? t('menu.card.presentRemove') : t('menu.card.presentAdd'),
            icon: 'presentation',
            separatorBefore: true,
            run: () => actions.setPresentStep?.(!allInPresentation),
          },
          ...(!multiple && target.presentStep !== null && actions.movePresentStep
            ? [
                {
                  id: 'present-step-earlier',
                  title: t('menu.card.presentEarlier'),
                  icon: 'arrow-up',
                  run: () => actions.movePresentStep?.(target.id, -1),
                },
                {
                  id: 'present-step-later',
                  title: t('menu.card.presentLater'),
                  icon: 'arrow-down',
                  run: () => actions.movePresentStep?.(target.id, 1),
                },
              ]
            : []),
        ]
      : []),
    {
      id: 'promote',
      title: t('menu.card.promote'),
      icon: 'file-plus',
      disabled: multiple,
      separatorBefore: true,
      run: () => actions.promote(target.id),
    },
    {
      id: 'delete',
      title: multiple ? `${t('menu.card.delete')} (${count})` : t('menu.card.delete'),
      icon: 'trash-2',
      separatorBefore: true,
      run: () => actions.remove(),
    },
  );

  // 「复制」是纯读动作（写的是系统剪贴板，不碰 `.nboard`），与上面三个同一档
  safe.add(copyItem);

  if (!readOnly) return items;

  // 只读板（归档锁定 / 保护态，T4.06）：除上面认定的"纯读"类型项，**一律置灰**。
  // ★ 置灰而不是不出现：菜单里少了一整排会让人以为"这块板少了功能"，
  //   灰着的一排配上屏幕上的锁定提示条，才说得清"是这块板不让改"。
  // ★ 判据是"会不会写模型"，不是"看不看得到" —— 打开源笔记 / 打开子板 /
  //   拉预览都不碰 `.nboard`，归档板上照样该能用（归档不等于要断掉一切。
  // ★ 子项要**跟着父项一起灰**：`disabled` 在子菜单父项上有两条渲染路径不生效
  //   （见 `ui/ContextMenus.ts`），只灰父项的话用户仍然能展开、点到里面那些能写的项 ——
  //   视图那层虽然也拦（每个动作都有 `isReadOnly()` 早退），但"点了没反应"正是
  //   这套菜单最想避免的事。
  return items.map((item) =>
    safe.has(item)
      ? item
      : {
          ...item,
          disabled: true,
          children: item.children?.map((child) => ({ ...child, disabled: true })),
        },
  );
}

// ─────────────────────────────────────────────────────────────
// 连线菜单（T1.69 / F3-05）
// ─────────────────────────────────────────────────────────────

/**
 * 连线右键菜单能触发的一切。
 *
 * ★ **刻意没有"粗细"**：`Edge` 里没有线宽字段（JSON Canvas 规范也没有这一项）。
 *   要支持它就得往边对象上加一个非规范键 —— 那会让文件在别的白板工具里
 *   多出一个没人认识的字段（`03 §1` 要求落盘严格遵循规范）。
 *   "这条线正被选中"已经由选中态的加粗表达了，够用。
 */
export interface EdgeMenuActions {
  /** 线型：实线 / 虚线 */
  setStyle(style: Edge['style']): void;
  /** 两端箭头（`fromEnd` / `toEnd` 各取 `'none' | 'arrow'`） */
  setEnds(fromEnd: EdgeEnd, toEnd: EdgeEnd): void;
  /** 改颜色（主题编号或自定义 HEX） */
  setColor(color: CardColor): void;
  pickColor(current: string | null, apply: (hex: HexColor) => void): void;
  /** 走线方式：直连 / 智能绕开（T7.11） */
  setRouting(routing: EdgeRouting): void;
  /** 把弧线拉直（T7.12）。`curve` 没值时这一项整项不出现 */
  straighten(): void;
  /** 编辑标签文字（T7.13）。由视图弹出输入框 */
  editLabel(): void;
  /** 清掉标签（T7.13）。`label` 为空时这一项不出现 */
  clearLabel(): void;
  /** 删除这条连线 */
  remove(): void;
}

export interface EdgeMenuInput {
  edge: Edge;
  actions: EdgeMenuActions;
  /** 只读板（T4.06）：连线的每一项都是改写模型，全部置灰。见 `buildCardMenuSpec` 的说明 */
  readOnly?: boolean;
}

/**
 * 连线右键菜单（T1.69）。
 *
 * 三组样式都做成**子菜单 + 勾选态**而不是平铺：一组三五个选项平铺进来，
 * 菜单立刻变成十几行，用户得从头读到尾才能找到"虚线"。
 *
 * ★ 箭头列了**四种**（无 / 终点 / 起点 / 双向）而不是三种：`Edge` 允许
 *   "只有起点带箭头"（反向箭头），菜单若只给三种，遇到这种线时**四个选项
 *   一个都不会被勾上** —— 用户看到的是"这条线现在是什么状态？"的空白。
 */
export function buildEdgeMenuSpec(input: EdgeMenuInput): MenuItemSpec[] {
  const { edge, actions, readOnly = false } = input;
  const arrowNone = edge.fromEnd === 'none' && edge.toEnd === 'none';
  const arrowForward = edge.fromEnd === 'none' && edge.toEnd === 'arrow';
  const arrowBackward = edge.fromEnd === 'arrow' && edge.toEnd === 'none';
  const arrowBoth = edge.fromEnd === 'arrow' && edge.toEnd === 'arrow';

  // ★ 连线菜单里**没有**"纯读"项：线型 / 箭头 / 颜色 / 删除全是改写，
  //   所以只读时一律置灰（不像卡片菜单要留"打开源笔记"那几个）
  const items: MenuItemSpec[] = [
    {
      id: 'edge-style',
      title: t('menu.edge.style'),
      icon: 'minus',
      children: [
        {
          id: 'edge-style-solid',
          title: t('menu.edge.solid'),
          checked: edge.style === 'solid',
          run: () => actions.setStyle('solid'),
        },
        {
          id: 'edge-style-dashed',
          title: t('menu.edge.dashed'),
          checked: edge.style === 'dashed',
          run: () => actions.setStyle('dashed'),
        },
      ],
    },
    {
      id: 'edge-arrow',
      title: t('menu.edge.arrow'),
      icon: 'move-right',
      children: [
        {
          id: 'edge-arrow-none',
          title: t('menu.edge.arrowNone'),
          checked: arrowNone,
          run: () => actions.setEnds('none', 'none'),
        },
        {
          id: 'edge-arrow-forward',
          title: t('menu.edge.arrowForward'),
          checked: arrowForward,
          run: () => actions.setEnds('none', 'arrow'),
        },
        {
          id: 'edge-arrow-backward',
          title: t('menu.edge.arrowBackward'),
          checked: arrowBackward,
          run: () => actions.setEnds('arrow', 'none'),
        },
        {
          id: 'edge-arrow-both',
          title: t('menu.edge.arrowBoth'),
          checked: arrowBoth,
          run: () => actions.setEnds('arrow', 'arrow'),
        },
      ],
    },
    {
      id: 'edge-routing',
      title: t('menu.edge.routing'),
      icon: 'route',
      children: [
        {
          id: 'edge-routing-free',
          title: t('menu.edge.routingFree'),
          checked: edge.routing === 'free',
          run: () => actions.setRouting('free'),
        },
        {
          id: 'edge-routing-smart',
          title: t('menu.edge.routingSmart'),
          checked: edge.routing === 'smart',
          run: () => actions.setRouting('smart'),
        },
        {
          id: 'edge-routing-curve',
          title: t('menu.edge.routingCurve'),
          checked: edge.routing === 'curve',
          run: () => actions.setRouting('curve'),
        },
      ],
    },
    // 「拉直」只在**这条线确实是弯的**时候出现（T7.12）。
    // ★ 不做成恒定的灰项：弯与不弯是这条线自己的状态，"一直摆着一个灰的'拉直'"
    //   会让人以为它本来该能点 —— 而它此刻就是直的，没什么可拉。
    ...(edge.curve
      ? [
          {
            id: 'edge-straighten',
            title: t('menu.edge.straighten'),
            icon: 'minus',
            run: () => actions.straighten(),
          },
        ]
      : []),
    {
      id: 'edge-label',
      title: t('menu.edge.label'),
      icon: 'type',
      children: [
        {
          id: 'edge-label-edit',
          title: t('menu.edge.labelEdit'),
          run: () => actions.editLabel(),
        },
        // 「清除」同理：没标签时它没有任何作用
        ...(edge.label
          ? [
              {
                id: 'edge-label-clear',
                title: t('menu.edge.labelClear'),
                run: () => actions.clearLabel(),
              },
            ]
          : []),
      ],
    },
    {
      id: 'edge-color',
      title: t('menu.edge.color'),
      icon: 'palette',
      separatorBefore: true,
      children: [
        ...THEME_COLOR_OPTIONS.map((color) => ({
          id: `edge-color-${color}`,
          title: colorLabel(color),
          checked: edge.color === color,
          run: () => actions.setColor(color),
        })),
        {
          id: 'edge-color-custom',
          title: t('color.custom'),
          separatorBefore: true,
          run: () => actions.pickColor(edge.color, (hex) => actions.setColor(hex)),
        },
      ],
    },
    {
      id: 'edge-delete',
      title: t('menu.edge.delete'),
      icon: 'trash-2',
      separatorBefore: true,
      run: () => actions.remove(),
    },
  ];

  return readOnly ? items.map((item) => ({ ...item, disabled: true })) : items;
}

/**
 * 空白处右键菜单（T1.34）。
 * 只放"此刻确实能执行"的东西：没剪贴板内容就别出现"粘贴"，
 * 免得用户点了没反应以为坏了（粘贴随 T2.x 的剪贴板落地后再加）。
 *
 * ★ 会改模型的那几个一律**可选**：只读板（归档锁定 / 保护态）上视图什么都不传，
 *   整项就不出现。空白处右键在一张不能改的板上只该有"看"的动作 ——
 *   留一排点了没反应的"新建便签"，比少几项更难理解。
 */
export interface CanvasMenuActions {
  newNote?(): void;
  /**
   * 新建同步便签（T7.04）。
   * ★ 与便签同一批"空白纸"（不需要文件选择器，所以能进右键菜单），
   *   区别只在它一落卡就带一个同步组键 —— 见 `createSyncNoteAt`。
   */
  newSyncNote?(): void;
  /**
   * 新建评论卡（T7.05）。
   * ★ 同样属于"空白纸"那一批：不弹选择器、落卡即用，所以能进右键菜单。
   *   大多数时候它就该这么建 —— 挨着被评论的那张卡放。
   */
  newComment?(): void;
  /** 新建待办卡（T3.01）：与便签并列的第二张"空白纸" */
  newTodo?(): void;
  /** 新建色板（T3.27）：与工具条同一批动作，见 `buildCanvasMenuSpec` 的说明 */
  newSwatch?(): void;
  /** 新建链接卡（T3.27）。地址由调用方先问好再落卡 */
  newLink?(): void;
  /** 新建空分栏（T3.27） */
  newColumn?(): void;
  /**
   * 开关**画布过滤条**（`2.2.0` · O3）。
   *
   * ★ 为什么进右键菜单（用户 2026-09-22："可以把这个操作放到菜单里"）：过滤条是个
   *   "常驻但默认藏着"的面板，此前只有命令面板一条入口 —— 而"我想筛一下这块板"
   *   是个**看着画布**才想起的动作（与"新建一张卡"同一处境）。
   */
  toggleFilter?(): void;
  /** 新建仅标题卡（`A3`）：一张"空白纸"，落卡即写 —— 能直接进右键菜单 */
  newTitleCard?(): void;
  /** 新建空图集卡（`A4`）：先落一张空的，等着往里放图 */
  newGallery?(): void;
  /**
   * 新建**内嵌脑图卡**（`F4`）：又一张"空白纸"—— 落下来就是"中心主题 + 3 个空分支"，
   * 不弹选择器、不建文件，所以能直接进右键菜单。
   */
  newMind?(): void;
  /**
   * 新建视频卡 / 音频卡（`A1` / `A2`，用户 2026-09-18："新增的卡片类型都要放到右键菜单里"）。
   *
   * ★ 这两项**要先弹一个库内文件选择器** —— 而菜单一关会把它一起带走（见
   *   `buildCanvasMenuSpec` 里那条"图片 / 文件故意不放进来"的老说明）。
   *   所以调用方必须把选择器**延到下一拍**再开（`setTimeout(…, 0)`），
   *   等菜单自己收干净之后再弹 —— 这样它们就能进右键菜单，而模态框不会被连带关掉。
   */
  newVideo?(): void;
  newAudio?(): void;
  /**
   * 编组 / 取消编组（T3.14）。
   *
   * ★ 空白处菜单里也放这一对：框选**能框住分栏**（用户 2026-09-16），而那时右键多半
   *   落在空白处（栏上右键弹的是分栏菜单）—— 少了它，"多栏编组"就只剩 `⌘G`
   *   与命令面板两条路。与其它项同一条规矩：此刻做不到的**整项不出现**。
   */
  group?(): void;
  ungroup?(): void;
  /** 进入手绘（T3.27）。桌面上 `D` 键更快，但手机上虚拟键盘按不出 `D` */
  draw?(): void;
  selectAll(): void;
  fitContent(): void;
  zoomReset(): void;
  /**
   * 把这块板锁成只读（T4.06 / `03 §2.5`）。
   * ★ 只在这块板**还没被锁**时传入：画布菜单是"锁定归档板"最顺手的入口
   *   （尤其移动端，命令面板很难按）。
   */
  lockBoard?(): void;
  /** 解锁（T4.06）。只在**用户自己锁的**板上传入 —— 保护态不给这条路 */
  unlockBoard?(): void;
  /**
   * 进入演示模式（J-06）。
   *
   * ★ 可选：与"会改模型"的那几项不同，演示**不改任何数据**（只读板上照样能讲），
   *   所以只读板上它仍然出现、仍然可用。
   * ★ 右键菜单是移动端唯一的入口（虚拟键盘按不出 `⌘⇧P`），不能省。
   */
  startPresentation?(): void;
  /**
   * 自动整理（T6.07 / `F5-06`）：把分栏与栏外的卡片重排成整齐的行列。
   *
   * ★ 与"会改模型"的其它项一样**可选**：只读板上不传，整项不出现。
   * ★ 命令面板里有同名命令，但画布菜单是这个功能**唯一"看得见"的入口**
   *   —— "一键去混乱"这种动作，用户会先在空白处右键找它。
   */
  tidyBoard?(): void;
  /** 按标签自动分栏（T6.08 / `F5-07`）。同上：只读板上不传 */
  groupByTag?(): void;
}

/** 分栏右键菜单能触发的一切（T1.54–T1.60） */
export interface ColumnMenuActions {
  /** 就地重命名（与双击标题栏同一个入口） */
  rename(id: string): void;
  /** 折叠 / 展开（T1.57） */
  toggleCollapse(id: string): void;
  /** 把栏里的卡片拆成同级并排分栏（T1.58） */
  splitIntoColumns(id: string): void;
  /**
   * 整栏转成一个**编组**（`O04`）：卡片留在原地，栏目本身消失。
   *
   * ★ 与「拆成多个分栏」是同一件事的两种方向（一个容器换成另一个容器），
   *   所以在菜单里紧挨着摆；栏里不足两张卡时置灰 —— 编组至少两张
   *   （`MIN_GROUP_SIZE`，单成员组会被自动解散，点了等于没点）。
   */
  toGroup(id: string): void;
  /**
   * 把这一栏所在的那一整排"同级分栏"对齐（T3.15 / `F5-01`）。
   * ★ 可选：嵌入视图等没有分栏编辑能力的上下文里整项不出现。
   */
  alignRow?(id: string): void;
  /**
   * 改分栏主色（用户 2026-09-18："分栏要允许设置颜色"）。
   *
   * ★ 与卡片 `setColor` 同一条套路：传主题色 / 自定义 HEX，写进撤销栈；
   *   没有这一项时（只读板）整项不出现。
   */
  setColor(id: string, color: CardColor): void;
  /**
   * 弹自定义取色器（与卡片同一套 `pickColor`），确定后回调挑到的 HEX。
   */
  pickColor(id: string, current: CardColor, apply: (hex: string) => void): void;
  /**
   * 删除分栏。
   * `release` = 卡片留在画布上；`delete` = 连卡片一起删（T1.60）。
   * ★ 两种语义共用一个入口但**分成两个菜单项**，而不是弹二次确认框：
   *   确认框会打断"批量清理"这种连续操作，而这两个选项本身已经说清了后果。
   */
  remove(id: string, mode: 'release' | 'delete'): void;
}

export interface ColumnMenuInput {
  column: Column;
  /** 栏内卡片数（决定"拆成多个分栏""删除并删卡"是否可用 / 是否有意义） */
  memberCount: number;
  actions: ColumnMenuActions;
  /**
   * 只读板（T4.06）。
   * ★ 注意"折叠"也算改写：`collapsed` 存在 `board.columns` 里、会写进文件，
   *   所以只读时它和"重命名""拆栏""删除"一样置灰。
   */
  readOnly?: boolean;
}

/**
 * 分栏右键菜单（T1.54–T1.60）。
 *
 * 与卡片菜单共用 `MenuItemSpec` 与同一个宿主 `Menu`（`04 §13`：不自绘菜单），
 * 规格在这里产出、单测在这里钉。
 */
export function buildColumnMenuSpec(input: ColumnMenuInput): MenuItemSpec[] {
  const { column, memberCount, actions, readOnly = false } = input;
  const items: MenuItemSpec[] = [
    {
      id: 'column-rename',
      title: t('menu.column.rename'),
      icon: 'text-cursor-input',
      run: () => actions.rename(column.id),
    },
    {
      id: 'column-collapse',
      title: column.collapsed ? t('menu.column.expand') : t('menu.column.collapse'),
      icon: column.collapsed ? 'chevrons-up-down' : 'chevrons-down-up',
      run: () => actions.toggleCollapse(column.id),
    },
    {
      id: 'column-split',
      title: t('menu.column.split'),
      icon: 'columns-2',
      separatorBefore: true,
      // 栏里只有一张卡时"拆"= 原地不动，给它置灰比让用户点了个寂寞好
      disabled: memberCount < 2,
      run: () => actions.splitIntoColumns(column.id),
    },
    // 整栏 → 编组（O04）：卡片留在原地，栏目本身消失。与「拆成多个分栏」同一个
    // 分隔段里（都是"换一种容器"），栏里不足两张卡时置灰 —— 编组至少两张
    {
      id: 'column-to-group',
      title: t('menu.column.toGroup'),
      icon: 'group',
      disabled: memberCount < MIN_GROUP_SIZE,
      run: () => actions.toGroup(column.id),
    },
    // 分栏主色（用户 2026-09-18："分栏要允许设置颜色"）：与卡片色板同一套
    // 主题色 + 自定义 HEX，当前色打勾；标题栏背景 / 字色都跟它走
    {
      id: 'column-color',
      title: t('menu.card.color'),
      icon: 'palette',
      separatorBefore: true,
      children: [
        ...THEME_COLOR_OPTIONS.map((color) => ({
          id: `column-color-${color}`,
          title: colorLabel(color),
          checked: column.color === color,
          run: () => actions.setColor(column.id, color),
        })),
        {
          id: 'column-color-custom',
          title: t('color.custom'),
          separatorBefore: true,
          run: () =>
            actions.pickColor(column.id, column.color, (hex) => {
              actions.setColor(column.id, hex);
            }),
        },
      ],
    },
    ...(actions.alignRow
      ? [
          {
            id: 'column-align-row',
            title: t('menu.column.align'),
            icon: 'align-start-vertical',
            run: () => actions.alignRow?.(column.id),
          },
        ]
      : []),
    {
      id: 'column-delete',
      title: t('menu.column.delete'),
      icon: 'trash-2',
      separatorBefore: true,
      run: () => actions.remove(column.id, 'release'),
    },
    // 空栏没有"连卡片一起删"这回事，不出现
    ...(memberCount > 0
      ? [
          {
            id: 'column-delete-cards',
            title: `${t('menu.column.deleteWithCards')} (${memberCount})`,
            icon: 'trash',
            run: () => actions.remove(column.id, 'delete'),
          },
        ]
      : []),
  ];

  // 分栏菜单同样没有"纯读"项（重命名 / 折叠 / 拆栏 / 对齐 / 删除都改写模型）
  return readOnly ? items.map((item) => ({ ...item, disabled: true })) : items;
}

/**
 * **脑图（整棵树）**的右键菜单动作（`2.2.0` 收尾 · 演示对接）。
 *
 * ★ 只放演示四项：树的其他动作（删除 / 复制 / 搬运）已经走**选区 + 命令**那条路
 *   （`2.2.0` 批 4 批 5 做的），这里不重复一份入口。
 */
export interface MindMenuActions {
  addToPresentation(): void;
  removeFromPresentation(): void;
  moveEarlier(): void;
  moveLater(): void;
}

/** 这棵树的演示状态（视图算好递进来，规格层不认识 board） */
export interface MindMenuState {
  /** 已经在演示路径里 */
  inPresentation: boolean;
  /** 还能前移 / 后移（到头的方向不出现，与卡片菜单同一条取舍） */
  canMoveEarlier: boolean;
  canMoveLater: boolean;
}

/**
 * 脑图容器的右键菜单（`2.2.0` 收尾）。
 *
 * ★ 与卡片那份分开而不是塞进 `buildCardMenuSpec`：卡片菜单有四十来项、
 *   还带着选择性置灰的规则，而树这一份只有演示四项 —— 混在一起读的人会以为
 *   树的菜单也该有"改颜色 / 裁剪图片"那些。
 */
export function buildMindMenuSpec(state: MindMenuState, actions: MindMenuActions): MenuItemSpec[] {
  const items: MenuItemSpec[] = [
    state.inPresentation
      ? {
          id: 'mind-present-remove',
          title: t('menu.mind.presentRemove'),
          icon: 'minus-circle',
          run: () => actions.removeFromPresentation(),
        }
      : {
          id: 'mind-present-add',
          title: t('menu.mind.presentAdd'),
          icon: 'play-circle',
          run: () => actions.addToPresentation(),
        },
  ];

  if (state.inPresentation) {
    if (state.canMoveEarlier) {
      items.push({
        id: 'mind-present-earlier',
        title: t('menu.mind.presentEarlier'),
        icon: 'arrow-up',
        separatorBefore: true,
        run: () => actions.moveEarlier(),
      });
    }
    if (state.canMoveLater) {
      items.push({
        id: 'mind-present-later',
        title: t('menu.mind.presentLater'),
        icon: 'arrow-down',
        run: () => actions.moveLater(),
      });
    }
  }
  return items;
}

export function buildCanvasMenuSpec(actions: CanvasMenuActions): MenuItemSpec[] {
  return [
    // 与工具条对齐（T3.27）：工具条上能建的"空白纸"，右键菜单里也该有。
    // ★ 图片 / 文件 / 白板**故意不放进来**：它们要先弹一个文件选择器，
    //   而右键菜单一关就没了主人 —— 菜单项的模态框会跟着一起消失。
    //   那几种只能从工具条拖着建（拖拽手势不依赖菜单活着）。
    // 过滤条开关（`2.2.0` · O3）：放在最上面那一格旁边 —— 它是"看这块板"的动作，
    // 后面那些是"往板上加东西"的动作
    ...(actions.toggleFilter
      ? [
          {
            id: 'canvas-filter',
            title: t('menu.canvas.filter'),
            icon: 'filter',
            run: () => actions.toggleFilter?.(),
          },
        ]
      : []),
    ...(actions.newNote
      ? [
          {
            id: 'new-note',
            title: t('menu.canvas.newNote'),
            icon: 'sticky-note',
            // 与上面那条「过滤卡片…」之间画一条分隔线（"看板"的动作 / "加内容"的动作）
            separatorBefore: true,
            run: () => actions.newNote?.(),
          },
        ]
      : []),
    // 其余"空白纸"收进一个子菜单（`C2`，用户 2026-09-18："右键菜单整理"）。
    // ★ 便签留在**最上面一格**、不进子菜单：它是这份菜单里用得最多的一项，
    //   多一层展开就等于给最常见的动作平白加一次点击。
    // ★ 与左工具栏的「更多卡片」（`C1`）同一套形状 —— 两处摆法一致，用户不必分别记。
    // ★ 子菜单里同样只列**视图给了能力**的那些（不传 = 不出现，与从前逐项判断一致）；
    //   一个子项都绑不上时整组不出现（`bindCardMenuItems` 那边已经处理）。
    ...(actions.newSyncNote ||
    actions.newComment ||
    actions.newTodo ||
    actions.newSwatch ||
    actions.newLink ||
    actions.newColumn ||
    // 新增的四张卡（`A1`–`A4`）也算"有东西可建"—— 只传了它们时这一格同样该出现
    actions.newTitleCard ||
    actions.newGallery ||
    actions.newVideo ||
    actions.newAudio ||
    // 内嵌脑图卡（`F4`）同样属于"空白纸"
    actions.newMind
      ? [
          {
            id: 'new-cards',
            title: t('menu.canvas.moreCards'),
            icon: 'plus',
            children: [
              ...(actions.newSyncNote
                ? [
                    {
                      id: 'new-sync-note',
                      title: t('menu.canvas.newSyncNote'),
                      icon: 'files',
                      run: () => actions.newSyncNote?.(),
                    },
                  ]
                : []),
              ...(actions.newComment
                ? [
                    {
                      id: 'new-comment',
                      title: t('menu.canvas.newComment'),
                      icon: 'message-square',
                      run: () => actions.newComment?.(),
                    },
                  ]
                : []),
              ...(actions.newTodo
                ? [
                    {
                      id: 'new-todo',
                      title: t('menu.canvas.newTodo'),
                      icon: 'check-square',
                      run: () => actions.newTodo?.(),
                    },
                  ]
                : []),
              ...(actions.newSwatch
                ? [
                    {
                      id: 'new-swatch',
                      title: t('menu.canvas.newSwatch'),
                      icon: 'palette',
                      run: () => actions.newSwatch?.(),
                    },
                  ]
                : []),
              ...(actions.newLink
                ? [
                    {
                      id: 'new-link',
                      title: t('menu.canvas.newLink'),
                      icon: 'link',
                      run: () => actions.newLink?.(),
                    },
                  ]
                : []),
              ...(actions.newColumn
                ? [
                    {
                      id: 'new-column',
                      title: t('menu.canvas.newColumn'),
                      icon: 'columns-2',
                      run: () => actions.newColumn?.(),
                    },
                  ]
                : []),
              // 新增的四张卡（`A1`–`A4`，用户 2026-09-18："新增的卡片类型都要放到右键菜单里"）。
              // ★ 标签复用工具栏那一份（`toolbar.*`）：同一个东西在两处叫两个名字，
              //   用户会以为它们是两样东西。
              ...(actions.newTitleCard
                ? [
                    {
                      id: 'new-title-card',
                      title: t('toolbar.titleCard'),
                      icon: 'tag',
                      run: () => actions.newTitleCard?.(),
                    },
                  ]
                : []),
              ...(actions.newGallery
                ? [
                    {
                      id: 'new-gallery',
                      title: t('toolbar.gallery'),
                      icon: 'images',
                      run: () => actions.newGallery?.(),
                    },
                  ]
                : []),
              // 内嵌脑图卡（`F4`）：标签同样复用工具栏那一份
              ...(actions.newMind
                ? [
                    {
                      id: 'new-mind',
                      title: t('toolbar.mind'),
                      icon: 'network',
                      run: () => actions.newMind?.(),
                    },
                  ]
                : []),
              ...(actions.newVideo
                ? [
                    {
                      id: 'new-video',
                      title: t('toolbar.video'),
                      icon: 'film',
                      run: () => actions.newVideo?.(),
                    },
                  ]
                : []),
              ...(actions.newAudio
                ? [
                    {
                      id: 'new-audio',
                      title: t('toolbar.audio'),
                      icon: 'disc',
                      run: () => actions.newAudio?.(),
                    },
                  ]
                : []),
            ],
          },
        ]
      : []),
    ...(actions.draw
      ? [
          {
            id: 'draw',
            title: t('menu.canvas.draw'),
            icon: 'pencil',
            separatorBefore: true,
            run: () => actions.draw?.(),
          },
        ]
      : []),
    ...(actions.startPresentation
      ? [
          {
            id: 'start-presentation',
            title: t('menu.canvas.present'),
            icon: 'presentation',
            separatorBefore: true,
            run: () => actions.startPresentation?.(),
          },
        ]
      : []),
    // 整理类（T6.07 / T6.08）：都会重排整块板子，放在"看"的动作之前、单独一段
    ...(actions.tidyBoard
      ? [
          {
            id: 'tidy-board',
            title: t('menu.canvas.tidyBoard'),
            icon: 'layout-grid',
            separatorBefore: true,
            run: () => actions.tidyBoard?.(),
          },
        ]
      : []),
    ...(actions.groupByTag
      ? [
          {
            id: 'group-by-tag',
            title: t('menu.canvas.groupByTag'),
            icon: 'tags',
            run: () => actions.groupByTag?.(),
          },
        ]
      : []),
    // 编组 / 取消编组（T3.14）。为什么空白处也要有这一对：框选**能框住分栏**
    // （用户 2026-09-16），而那时右键多数落在空白处（栏上右键弹的是分栏菜单）。
    // 与分栏菜单那几项同一条规矩：此刻做不到的**整项不出现**（由视图算好）。
    ...(actions.group || actions.ungroup
      ? [
          ...(actions.group
            ? [
                {
                  id: 'group',
                  title: t('menu.card.group'),
                  icon: 'group',
                  separatorBefore: true,
                  run: () => actions.group?.(),
                },
              ]
            : []),
          ...(actions.ungroup
            ? [
                {
                  id: 'ungroup',
                  title: t('menu.card.ungroup'),
                  icon: 'ungroup',
                  run: () => actions.ungroup?.(),
                },
              ]
            : []),
        ]
      : []),
    {
      id: 'select-all',
      title: t('menu.canvas.selectAll'),
      icon: 'box-select',
      separatorBefore: true,
      run: () => actions.selectAll(),
    },
    {
      id: 'fit-content',
      title: t('menu.canvas.fitContent'),
      icon: 'maximize',
      run: () => actions.fitContent(),
    },
    {
      id: 'zoom-reset',
      title: t('menu.canvas.zoomReset'),
      icon: 'zoom-in',
      run: () => actions.zoomReset(),
    },
    // 锁定 / 解锁（T4.06）：与"看"的动作隔一条分隔线。
    // ★ 只放**当下那个方向**：锁着的板上给"解锁"，没锁的板上给"锁定"。
    //   两个都放会让用户先读两行才能决定，而其中一行永远是点了会失败的。
    ...(actions.lockBoard
      ? [
          {
            id: 'lock-board',
            title: t('menu.canvas.lock'),
            icon: 'lock',
            separatorBefore: true,
            run: () => actions.lockBoard?.(),
          },
        ]
      : []),
    ...(actions.unlockBoard
      ? [
          {
            id: 'unlock-board',
            title: t('menu.canvas.unlock'),
            icon: 'lock-open',
            separatorBefore: true,
            run: () => actions.unlockBoard?.(),
          },
        ]
      : []),
  ];
}
