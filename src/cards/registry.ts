/**
 * 卡片类型注册表（T1.32）—— `03 §7.1` 的 `cards/registry.ts`、`03 §7.3` 的接口。
 *
 * 存在的理由（`03 §7.2` 硬性规则最后一条）：
 * **新增一种卡片 = 新增一个文件 + 注册一行，核心代码一个字都不用动。**
 * `CardLayer` 只认识"注册表 + 一个槽位"，不认识便签/图片/待办任何一种具体卡片。
 *
 * ── 两条刻意设计 ──────────────────────────────────────────
 *
 * 1. **本文件不 import obsidian 的运行时导出**（只用 `import type`）。
 *    卡片定义因此能在 node 下直接单测，`MarkdownRenderer` 这类能力由视图
 *    通过 `CardRenderContext.renderMarkdown` 注入进来。
 * 2. **注册表允许"缺类型"**。`get()` 返回 `undefined` 是正常情况（本 Sprint 只有便签卡，
 *    其余 8 种还没实现），调用方回落到占位渲染 —— **绝不允许因为少注册一个类型就白屏**。
 *    同理 `register()` 对同一类型的重复注册直接抛错：静默覆盖会让"我明明改了却没生效"
 *    这种问题查上半天。
 */

import type { App, Component } from 'obsidian';
import type {
  BoardFile,
  Card,
  CardColor,
  CardContentOf,
  CardOfType,
  CardType,
  HexColor,
} from '../model/schema';
import type { Size } from '../util/geometry';
import { t, type MessageKey } from '../util/i18n';
// ★ 唯一一处"白板卡片层 → 脑图"的类型依赖（`F3a`）：只借一个**接口**，不借实现 ——
//   方向是 `cards/** → mind/**`（eslint 那条边界钉的是反过来那个方向）。
import type { MindBridge } from '../mind/embed/MindBridge';
// 各卡片定义只 `import type` 本文件 → 运行期没有循环依赖，可以放心在这里聚合
import { boardRefCard } from './boardRef';
import { commentCard } from './comment';
import { fileCard } from './file';
import { videoCard } from './video';
import { audioCard } from './audio';
import { titleCard } from './titleCard';
import { galleryCard } from './gallery';
import { canvasCard } from './canvas';
import { mindRefCard } from './mindRef';
import { mindCard } from './mindCard';
import { imageCard } from './image';
import { pdfCard } from './pdf';
import { inkCard } from './ink';
import { linkCard } from './link';
import { mapCard } from './map';
import { noteCard } from './note';
import { noteRefCard } from './noteRef';
import { swatchCard } from './swatch';
import { syncNoteCard } from './syncNote';
import { todoCard } from './todo';

/**
 * 卡片的**瞬时**呈现模式，由指针状态机（`02 §3`）决定，不落盘。
 *
 * 与 `NoteContent.editorMode` 不是一回事：后者是"这张卡偏好常驻源码编辑"的**持久偏好**，
 * 由卡片右键菜单写入（T1.41），渲染时按它决定进入哪种编辑形态。
 */
export type CardViewMode = 'display' | 'edit';

/**
 * 卡片类型自己贡献的右键菜单项（T1.41）。
 *
 * ★ 这里**不返回 Obsidian 的 `Menu`**（`03 §7.3` 的初版签名是那样）：
 *   一旦卡片定义要自己往 `Menu` 里塞项，它就必须 import `obsidian` 的运行时，
 *   于是"便签卡的多选置灰规则"这种逻辑再也没法在 node 下单测，
 *   `03 §7.2` 的"cards 层不依赖 Obsidian"也随之破功。
 *   改成返回纯数据后：卡片定义只描述"有什么项"，弹菜单的活留给 `ui/ContextMenus.ts`。
 */
export interface CardTypeMenuItem {
  id: string;
  title: string;
  icon?: string;
  checked?: boolean;
  disabled?: boolean;
  /**
   * 由视图代跑的**具名动作**。
   *
   * 引用卡的"打开源笔记""重新链接"必须落到 `CardMenuActions`（只有视图拿得到
   * `VaultBridge` 与选区），但卡片定义又不能写出那个接口 —— 于是这里只放一个动作名，
   * 由 `view/interact/cardMenu.ts` 做名字 → 实现的绑定。
   * 给了 `action` 时 `run` 被忽略（两者都写会让"到底跑了哪个"变成靠读代码才知道的事）。
   */
  action?:
    | 'openSource'
    | 'relink'
    | 'openBoard'
    | 'newChildBoard'
    | 'boardPreviewThumb'
    | 'boardPreviewLive'
    | 'boardPreviewNone'
    | 'boardPreviewMini'
    | 'toggleNoteVariant'
    | 'editCaption'
    | 'editContent'
    | 'cropImage'
    | 'toggleCardBorder'
    | 'fetchPreview'
    | 'pickFromImage'
    | 'pickMapImage'
    | 'pasteMapLink'
    | 'openMapLink'
    | 'inkColor'
    | 'inkAnnotate'
    | 'duplicateSyncNote'
    | 'unsyncNote'
    | 'toggleCommentResolved'
    | 'pickBoardIcon'
    | 'clearBoardIcon'
    | 'toggleLinkStyle'
    | 'set-title-pill'
    | 'set-title-bubble'
    | 'set-title-tail-bottom'
    | 'set-title-tail-top'
    | 'set-title-tail-left'
    | 'set-title-tail-right'
    | 'pickBlock';
  /**
   * 一层子菜单（T7.09）。
   *
   * ★ **只有一层**，而且是刻意只有一层：右键菜单里再深一层就开始出现
   *   "手要横着走"（悬停一级 → 再横移 → 再点）的问题，手机上尤其明显。
   *   真需要三层的时候，该改的是菜单要摆什么，不是往这里加深度。
   * ★ 带 `children` 的项自己**不该有动作**（它是"分组标题"）：点它只会展开。
   * ★ 绑定时若一个子项都绑不上（视图没那个能力），**整组不出现** ——
   *   留一个展开后空着的小三角，比少一项糟得多。
   */
  children?: CardTypeMenuItem[];
  run?: () => void;
}

/** 生成类型菜单项时的上下文 */
export interface CardTypeMenuContext {
  /**
   * 当前是否为多选。
   * 类型专属项（"编辑内容""打开源笔记"）在多选下通常说不通，应自行置灰 ——
   * 具体规则归类型自己判断，注册表不替它猜。
   */
  readonly multiple: boolean;
}

/**
 * 写回源笔记的结果（T2.01 / `F2-2-3`）。
 *
 * ★ 把"被别处改过"单独列成一个结果，而不是混进 `'failed'`：这两种情况对用户的
 * 含义完全不同（一个是"你落伍了，看看新版本"，一个是"磁盘/权限出问题了"），
 * 而且前者**必须**把用户手上的草稿留下来 —— 卡片层就是照这个分支做决定的。
 */
export type NoteWriteResult =
  /** 已写入 */
  | 'written'
  /** 基准对不上：源笔记在我们编辑期间被改过。**一个字都没写** */
  | 'conflict'
  /** 目标笔记不存在（被删 / 被改名 / 本来就是断链） */
  | 'missing'
  /** 写入失败（权限、适配器报错） */
  | 'failed';

/**
 * Vault 访问桥（T1.42–T1.47）。
 *
 * 引用卡要"读真实 `.md`、断链检查、双击打开源笔记、监听外部修改"，
 * 这些都是 Obsidian 运行时能力，而 `cards/` 层**不许 import 它**（`03 §7.2`）。
 * 所以能力由视图注入：生产实现是 `integration/ObsidianLinkBridge.ts`，
 * 单测里换成一个几行的假实现即可。
 *
 * 所有方法都**不抛异常**：卡片渲染路径上抛错会让整屏卡片一起挂掉。
 */
export interface VaultBridge {
  /** 路径是否存在于 Vault（**同步**：渲染必须立刻决定要不要画断链样式） */
  exists(path: string): boolean;
  /** 读取文本；文件不存在 / 读取失败都返回 `null` */
  read(path: string): Promise<string | null>;
  /**
   * 以 `expected` 为基准**原子写回**（compare-and-swap，T2.01 / `F2-2-3`）。
   *
   * 当前内容与 `expected` 不相等时**一个字都不写**，直接返回 `'conflict'`。
   *
   * ★ 为什么签名是"基准 + 新值"而不是 `transform(raw) => raw`：
   *   后者的调用方很容易在里面顺手做点转换，于是"比较"这件事就散落在各个调用方手里；
   *   而这里的比较基准只有一个含义 —— **用户看到的那一版**。把它做成参数，
   *   卡片层就不可能"忘了比较"（`03 §3.2` W1 的原子语义 + W4 的"绝不静默覆盖"）。
   *
   * ★ 比较必须发生在**原子窗口内部**。先 `read` 再决定写不写是不够的：
   *   两步之间仍然有一条缝，而那条缝恰好就是并发修改会钻进来的地方。
   */
  writeIfUnchanged(path: string, expected: string, next: string): Promise<NoteWriteResult>;
  /** 打开笔记（可带 `#标题` / `#^块` 定位）；`newLeaf` = 新标签打开 */
  open(path: string, subpath: string | null, newLeaf: boolean): void;
  /** 解析 Vault 内资源为可放进 `<img src>` 的 URL；解析不了返回 `null` */
  resourceUrl(path: string): string | null;
  /**
   * 订阅某篇笔记的修改（T1.44 双向同步）。
   * 返回退订函数 —— 卡片被回收时必须退订，否则"滚一圈"会攒下成千上万个监听器。
   */
  watch(path: string, listener: () => void): () => void;
  /** 弹笔记选择器（T1.45 断链重连）；取消返回 `null` */
  pickNote(current: string | null): Promise<string | null>;
}

/**
 * 缩略图桥（T1.51 / T1.52）。
 *
 * ★ 为什么做成"按路径"而不是"按 memoryKey"：`memoryKey` 需要 `mtime` + `size`，
 *   而这两个值只能从 `vault.adapter.stat()` **异步**拿。图片卡要在首帧就决定
 *   "用缩略图还是用原图"，那个决定必须是**同步**的（`peek`），
 *   所以"查 stat、算 key"这半件事留在集成层，卡片层只递一个 vault 路径。
 */
export interface ThumbnailBridge {
  /** 同步查内存：`null` = 还没生成好，先用原图顶着 */
  peek(path: string): string | null;
  /** 异步取（可能触发一次生成）。拿不到返回 `null`，卡片继续用原图 */
  get(path: string): Promise<string | null>;
}

/**
 * 系统文件操作桥（T1.53）。
 *
 * ★ 同样是为了不 import `obsidian`：`openWithDefaultApp` / `adapter.stat`
 *   都是运行时能力，卡片定义只描述"我想打开这个路径"，怎么做归集成层。
 *   两个方法都**不抛异常** —— 卡片渲染与交互路径上抛错会带走整屏。
 */
export interface ShellBridge {
  /** 用系统默认应用打开 Vault 内路径；打不开返回 `false` */
  openPath(path: string): Promise<boolean>;
  /**
   * 文件的**字节数与修改时间**（`A7`）。读不到返回 `null`（卡片就不画那一行）。
   *
   * ★ 从 `statSize` 升级而来：文件卡的第二行写成"大小 · 修改时间"，
   *   而这两项本来就是同一次 `adapter.stat` 的结果 —— 分成两个口子等于把同一次读盘问两遍。
   * ★ `mtime` 是**毫秒时间戳**（Obsidian `Stat.mtime`）；怎么显示是卡片的事
   *   （`cards/file.ts` 的 `formatFileTime`，纯函数可单测）。
   */
  statInfo(path: string): Promise<{ size: number; mtime: number } | null>;
}

/**
 * 剪贴板桥（T3.04 色板卡"点击复制"；T3.20「复制为 Markdown」也会用它）。
 *
 * ★ 与其它桥同一条铁律：**不抛异常**，失败返回 `false`（色板卡据此显示"复制失败"）。
 * ★ 桥**不负责措辞**：同一次复制，调用方想说的话可能完全不同（色板要"已复制 #4C8DFF"、
 *   导出要"已复制整块白板"），所以这里只把字放进剪贴板，提示留给调用方。
 * ★ 有能力缺失的语义：单测 / 将来的嵌入视图里不传，卡片必须退化成"复制失败"
 *   而不是崩掉（同 `VaultBridge` 的可选约定）。
 */
export interface ClipboardBridge {
  writeText(text: string): Promise<boolean>;
  /**
   * 读剪贴板里的**纯文本**（`O08` 地图卡"粘贴分享链接"）。读不到返回 `null`。
   *
   * ★ 读比写难得多：浏览器只在"文档获得焦点 + 用户刚做过一次粘贴动作"时
   *   才允许读；Obsidian 桌面端一般可以，移动端常常直接拒绝。所以调用方**必须**
   *   把 `null` 当成一个正常结果（退回到"让用户自己粘一次"），而不是错误。
   * ★ 与 `writeText` 同一条铁律：**不抛异常**。
   * ★ 刻意**不做** `execCommand('paste')` 兜底：那个命令在现代浏览器里
   *   一律被禁（安全原因），写上去只会让人以为"我们有兜底"。
   */
  readText(): Promise<string | null>;
}

/**
 * 像素采样桥（T3.05 色板卡"从图片吸色"）。
 *
 * ★ 参数是**已经加载好的 `<img>`**，不是路径。理由：取色要取"我看见的那一格"，
 *   而同一张图在画布上可能是缩略图（T1.51 在低缩放下换过）、也可能被裁过 ——
 *   按路径重新加载一张原图，取到的像素与屏幕上的不是同一个（缩略图与原图
 *   在某些细节上颜色就不一样）。屏幕上的那个元素本身，才是权限最高的答案。
 * ★ 与其它桥同一条铁律：**不抛异常**。跨域脏画布、图损坏、越界一律返回 `null`，
 *   调用方按"取不到颜色"提示。
 * ★ 它由**视图层**消费（取色模式要横跨多张卡，卡片定义自己拿不到别的卡的 DOM），
 *   所以不进 `CardRenderContext`。
 */
export interface PixelSamplerBridge {
  /** 取图源上某个像素的颜色；取不到返回 `null` */
  samplePixel(image: HTMLImageElement, pixel: { x: number; y: number }): Promise<HexColor | null>;
}

/**
 * 抓取到的一份网页预览（T2.05 / `O20`）。字段与 `util/linkPreview.ts` 的 `LinkMeta` 一致。
 *
 * ★ `siteName` / `icon` / `finalUrl` 与 `title` 一样是**字符串、空串即没抓到**：
 *   解析层不做"键在不在"那层区分（那是 `LinkContent` 的规矩），
 *   写卡片的 `cards/link.ts` 才决定哪些键值得落进内容。
 */
export interface LinkPreview {
  title: string;
  description: string;
  image: string;
  /** `og:site_name`（`O20`） */
  siteName: string;
  /** 站点图标地址（`O20`）：已补全的 `http(s)`，空串即没有 */
  icon: string;
  /** `og:url` 或重定向后的最终网址（`O20`），空串即没有 */
  finalUrl: string;
}

/**
 * 外链能力桥（T2.04–T2.06 / `F2-4-1`–`F2-4-5`）。
 *
 * 链接卡要"用系统浏览器打开""抓一次网页""把预览图落盘"，三件事都是 Obsidian /
 * 浏览器的运行时能力，而 `cards/` 层不许 import 它们（`03 §7.2`）。于是与
 * `ShellBridge` 同一套做法：能力在这里描述，实现放在 `integration/`。
 *
 * ★ `enabled` 是**只读属性**而不是方法：它直接对应设置里的总开关
 *   （`F11-07`；`O20` 起默认**开启**，"抓取仍要用户点一下"这条没变），
 *   卡片渲染时同步读一次就够了 —— 做成 `isEnabled()`
 *   会让人误以为"每次调用都该重新查"，于是在渲染循环里反复读设置。
 *
 * ★ 所有方法都**不抛异常**：链接卡的渲染与点击路径上抛错会带走整屏卡片。
 */
export interface LinkPreviewBridge {
  /** 设置里的总开关。关闭时 `fetch` 必须直接返回 `null`（桥自己再拦一次） */
  readonly enabled: boolean;
  /**
   * 这条链接的域名在不在用户的**黑名单**里（T6.06 / `F2-4-6`）。
   *
   * ★ 做成**方法**而不是像 `enabled` 那样的只读属性：`enabled` 是"渲染一次读一次"
   *   的总开关，而这一项只在用户**真的动手**时才被问（点按钮 / 走菜单 / 双击），
   *   每次都该拿到最新值 —— 用户刚把某个站加进黑名单，下一次点击就该被拦住。
   * ★ 桥内部**自己也要拦一次**（`fetch` 与 `cacheImage` 各一道），不能只靠调用方
   *   问这一句：调用方漏问一次，现场就是"黑名单里明明写着，它却还在抓"。
   * ★ 卡片渲染路径**刻意不问**它：那会把"读设置"带进每一帧的渲染循环
   *   （与 `enabled` 同一个理由）。被拦的卡照样有个"获取预览"按钮，点下去会
   *   直接告诉你"这个站被你屏蔽了" —— 比一个灰着不说原因的按钮更好懂。
   */
  isBlocked(url: string): boolean;
  /** 抓取网页元数据。未开启 / 被黑名单拦下 / 网络失败 / 不是 HTML → `null` */
  fetch(url: string): Promise<LinkPreview | null>;
  /**
   * 把远程图片落盘成 Vault 附件（T2.06 / `F2-4-4`），返回 vault 相对路径。
   * 落盘失败返回 `null` —— 卡片会退回到直接用远程地址（离线时图裂，但内容不丢）。
   */
  cacheImage(url: string): Promise<string | null>;
  /** 用系统默认浏览器打开外链；打不开返回 `false` */
  openExternal(url: string): Promise<boolean>;
}

/**
 * 静态地图瓦片桥（`O08` 地图卡"粘贴分享链接"）。
 *
 * 地图卡粘一条分享链接时，插件可以替用户**去下载那张静态地图**（`util/mapUrl.ts`
 * 拼地址、这里下载、落进附件目录），然后照旧当"一张本地图"来画。
 *
 * ★ 这是本插件**第二处**联网能力（第一处是 `LinkPreviewBridge`），所以规矩与它完全一致：
 *   * 默认**关闭**（设置里的 `mapTileProvider` 默认 `'none'`）—— `enabled` 为假时
 *     连请求都不发，卡片退化成"只显示链接与坐标"；
 *   * 只在用户**明确动手**（右键「粘贴地图链接」）时才发生，渲染路径一次都不联网；
 *   * 不抛异常，失败返回 `null`。
 *
 * ★ 与 `LinkPreviewBridge.cacheImage` 的分工：那个是"抓到的预览图顺带落盘"，
 *   这个是"用户指名要的一张图"。所以这里**没有黑名单**（用户粘的就是他自己要的地图，
 *   拦下来只会让人摸不着头脑），但 key 缺失时同样一个请求都不发 —— 与其发一个
 *   必定 401 的请求，不如当场告诉用户"还没填 key"。
 */
export interface MapTileBridge {
  /** 设置里挑好了服务商（且那一档需要的 key 也填了）才算"可用" */
  readonly enabled: boolean;
  /**
   * 下载一张静态地图图并落盘成 Vault 附件，返回 vault 相对路径。
   * 失败（没开 / 网络不通 / 服务商回错 / 落盘失败）一律返回 `null`。
   *
   * @param name 附件名的**基名**，不带扩展名（`地图-天安门`）。
   *   ★ 扩展名由实现按响应头决定：各家回的图有 png 也有 jpg，
   *     写死一个扩展名会让"附件名说 png、内容是 jpg"这种谎话流进用户的库。
   */
  fetch(url: string, name: string): Promise<string | null>;
}

/**
 * 白板导航桥（T1.61 / T1.62）。
 *
 * 白板卡要显示"里面有多少张卡"、双击要"进到那块白板里去"，但
 * **开 leaf 是视图的活**（白板卡不知道 `app.workspace` 的用法），
 * 读 `.nboard` 又是 io 层的活。两头都不该被卡片定义 import，于是中间放这个端口。
 */
export interface BoardNavBridge {
  /** 打开某块白板（通常新开一个 tab）；打不开返回 `false` */
  open(path: string): Promise<boolean>;
  /** 读某块白板的概要；读不到 / 解析不了返回 `null` */
  summary(path: string): Promise<BoardSummary | null>;
  /**
   * 为**这张白板卡**新建一块"当前板的子板"，并把新路径写回卡片（T1.61 / `F2-8-1`）。
   * 返回 `true` = 卡片已经指向了新板；`false` = 什么都没做（只读 / 已经有目标 / 失败）。
   *
   * ★ 参数是**卡片 id** 而不是父板路径：这张卡的"空格位"是它自己的状态，
   *   而"落一个文件 + 写回内容 + 记一条可撤销的历史 + 只读拦截"这四件事只有视图
   *   做得到。让卡片层分两步走（先建、再 `applyContent`）会有两个后果：
   *   写回被排除在撤销之外（`applyContent` 不走历史），以及两处入口
   *   （双击空格位 / 右键「新建子白板」）各自拼一遍流程。
   *
   * ★ 可选：能力缺失（单测、将来的嵌入视图）时双击**不接管** ——
   *   与文件卡"目标不存在就交回视图"同一条约定：宁可让视图去解释，也不要吞掉点击。
   */
  createChildBoard?(cardId: string): Promise<boolean>;
  /**
   * 板缩略图（T4.16 / `F2-8-2`）：卡面那块预览区里要显示的那张图。
   *
   * ★ 形状**刻意与 `ThumbnailBridge` 相同**（同步 `peek` + 异步 `get`）而不是
   *   另起一个接口：卡片在这件事上要的东西一模一样 —— "现在有没有一张能挂上去的图"、
   *   "没有的话帮我生成一张、好了告诉我"。那张图究竟是从原图缩来的、还是从模型画出来的，
   *   卡片不该也不需要知道。
   *
   * ★ 可选：能力缺失（单测、只有图片管线的场景）时卡面退回概要面板 ——
   *   与 `createChildBoard` 同一条约定，不吞掉任何交互，只是少一张图。
   */
  thumbnail?: ThumbnailBridge;
  /**
   * 读一块白板的**模型**（T7.09 / `F7-10`）：只读小窗要按卡面尺寸把目标板矢量重画，
   * 而缩略图那条路只给一张固定 256px 的图 —— 卡面比 256px 大时它就是糊的。
   *
   * ★ 与 `thumbnail` 的分工是"要不要那份模型"：缩略图要一张能落盘缓存、能复用的**图**；
   *   小窗要的是"这块板现在长什么样"，而且卡面每变一次尺寸就要重画一次 ——
   *   缓存一张固定尺寸的图对它没有意义。
   * ★ 只读：不建 session、不改任何东西（与 `summary` 同一条路，读不到返回 `null`）。
   * ★ 可选：能力缺失（单测、只有图片管线的场景）时 `preview: 'live'` 退回概要面板 ——
   *   与 `thumbnail` 同一条约定：少一扇窗，但不吞掉任何交互。
   */
  readBoard?(path: string): Promise<BoardFile | null>;
  /**
   * 订阅**某一块板**的文件变化（T7.09）：那块板被保存 / 删除时，小窗该重画。
   * 返回退订函数 —— 调用方（白板卡）必须在 `destroy` 时退订，否则卡面滚过去之后
   * 每保存一次文件都要叫醒一张已经不存在的卡的画布。
   *
   * ★ 与 `thumbnail` 背后的缓存失效订阅不是一回事：那条清的是**缓存表**
   *   （服务于"下次要图时别给旧的"），这条是替调用方转达"这块板变了"。
   * ★ 可选：不传 = 小窗画完就不更新（能看，只是不新鲜）。能力缺失不报错。
   */
  watchBoard?(path: string, listener: () => void): () => void;
}

/** 白板卡预览要用的概要信息（`F2-8-3`） */
export interface BoardSummary {
  cards: number;
  columns: number;
  /**
   * 白板级脑图的棵数（`2.2.0` 收尾）。
   *
   * ★ 为什么不并进 `cards`：引用卡要能说清"这块板里有什么"。不数的话，
   *   一块**只有树**的白板会被判成"空板"（`cards === 0`）并写"0 张卡片" ——
   *   而它显然不是空的。
   * ★ 读的是 `.nboard` 里的 `minds` 数组（可选键，缺省 = 0）。
   */
  minds: number;
}

/**
 * 一条「跨白板反链」（T5.04 / `F10-03`）：某块白板的内联卡正文提到了某篇笔记。
 *
 * ★ 只留展示要用的五个字段：`cards/` 层不认识 `integration/LinkIndex`，而这个
 *   接口恰好就是引用卡要画的东西（板名 / 卡名 / 原话 / 往哪儿跳），不多也不少。
 *   链接索引那边多出来的 `target` / `resolved` 是实现细节，卡片不该看见。
 */
export interface BacklinkHit {
  /** 源白板的 vault 相对路径（跳转用） */
  boardPath: string;
  /** 源白板标题；可能为空串（板还没起名），此时卡片回落到路径 */
  boardTitle: string;
  /** 源卡片的 id（跳转用） */
  cardId: string;
  /** 源卡片标题；空串 = 那张卡没标题（内联卡很常见） */
  cardTitle: string;
  /** 提到这篇笔记的那句话 */
  excerpt: string;
}

/**
 * 跨白板反链查询桥（T5.04 / `F10-03`）。
 *
 * ## 为什么引用卡需要它
 *
 * 引用卡自己指向一篇 `.md`，而"**谁**提过这篇笔记"的答案散在全部 `.nboard` 的
 * 内联卡正文里。Obsidian 的 `metadataCache` 不索引 `.nboard`，所以这张卡的宿主
 * （视图）把插件自建的 `LinkIndex` 包成这个桥递进来。
 *
 * ## 三条约定
 *
 * 1. **能缺失**：单测 / 将来只有嵌入视图的场景不传 —— 卡片就只是少画一个角标，
 *    其余渲染一个字都不受影响（与 `notes` / `boards` 同一套约定）。
 * 2. **`count` 是同步的**：卡片渲染的首帧就要决定"画不画这个角标"，而它背后只是
 *    一次查表 —— 做成异步会把一行装饰变成一次重排。
 * 3. **订阅由卡片负责退订**：索引是分片异步扫的，画出来时可能还没扫到这篇笔记，
 *    所以卡片要 `watch` 它；`destroy` 时必须退订，否则"滚一圈"会攒下成千上万个监听器。
 */
export interface BacklinkBridge {
  /**
   * 全量扫描是否走完。
   *
   * ★ 没扫完时 `count` 返回 0 **不代表真的没有反链** —— 卡片据此区分
   *   "扫描中"与"确实没有"，不把 0 当成结论。
   */
  readonly ready: boolean;
  /** 提到这篇笔记的内联卡数量（同步；渲染首帧就要用） */
  count(notePath: string): number;
  /** 全部反链（点开列表时才调 —— 比 `count` 贵） */
  list(notePath: string): BacklinkHit[];
  /** 打开某块白板并定位到那张卡；若就是当前板则原地定位 */
  open(boardPath: string, cardId: string): void;
  /** 订阅索引变化（扫描分片 / 保存 / 外部改动）。返回退订函数 */
  watch(listener: () => void): () => void;
}

/**
 * 手绘标注桥（T3.09 / `F4-05`）：把图片卡的双击落到"进绘图态"上。
 *
 * ★ 只要一个方法：卡片定义唯一需要知道的只有"给我一支笔"。
 *   "这一笔算谁的标注"由笔迹自己算（`cards/ink.ts` 的 `inkHostCard`）——
 *   一张卡片连别的卡长什么样都看不见，也不该看见。
 */
export interface InkAnnotateBridge {
  /** 进入手绘态准备标注；返回是否真的进去了（只读白板 / 图层未就绪 → `false`） */
  annotate(): boolean;
}

/**
 * 这次编辑**从哪一步开始**（O01 / O02）。只在 `mode === 'edit'` 时有意义。
 *
 * * `'title'`（默认）：双击 / `Enter` 进来的"我要改这张卡"；
 * * `'raw'`：`⌘`+双击 / `⌘`+Enter / 右键「编辑内容」—— "我就是要改**正文**"，
 *   跳过标题那一格（待办卡这里是"整份源码"，连 `# 标题` 一起）。
 *
 * ★ 它是**入口意图**，不是"编辑器长什么样"：待办卡是"标题 + 清单两格"，按 `ctx.editEntry`
 *   在"两格"与"只有清单一格"之间分支（`cards/todo.ts`）。
 * ★ 便签 / 同步便签**不分支**（`F5`，用户 2026-09-21）：它们的编辑态只有正文一格，
 *   标题走卡面那一行的就地输入（与引用卡——`.md` 文档节点——同款，见 `cards/note.ts` 文件头）。
 */
export type EditEntry = 'title' | 'raw';

/**
 * 渲染一张卡所需的全部环境。由视图（`BoardView`）构造，卡片定义只读不改。
 *
 * 刻意把 `app` / `sourcePath` / `component` 都摊开给定义 —— 引用卡要读 Vault、
 * 图片卡要解析资源路径、链接卡要 hover 预览，这些能力只能从视图拿到。
 */
export interface CardRenderContext {
  readonly app: App;
  /** 所属白板文件路径：`MarkdownRenderer` 的 `sourcePath`、相对路径解析都靠它 */
  readonly sourcePath: string;
  /**
   * 卡片级生命周期宿主。
   * `MarkdownRenderer` 会把内嵌组件挂到它上面，卡片回收时必须随之销毁 ——
   * 挂在视图上而不销毁的话，滚一圈 1000 张卡就等于泄漏 1000 个组件。
   */
  readonly component: Component;
  /**
   * 把一段 Markdown 渲染进元素。**由视图注入**（内部走 `MarkdownRenderer`）：
   * 卡片定义因此不必 import `obsidian`，便签卡的渲染逻辑才测试得起来。
   */
  renderMarkdown(markdown: string, el: HTMLElement): Promise<void>;
  /**
   * 把剪贴板里的一张图片落进库并返回路径（`F5` 卡内粘贴图片）；失败给 `null`。
   *
   * ★ 与"直接粘在画布上变成图片卡"（`BoardView` 的 paste 分支）**共用同一份规则**
   *   （附件目录跟随用户设置、命名跟随 `attachmentOptions`）—— 两条路各读一遍设置，
   *   迟早出现"设置里改了但粘贴进来的图还是老名字"。
   * ★ 可选：缺席 = 卡内不支持粘贴图片（编辑器放行原生粘贴，正文里会出现 `image.png`）。
   */
  readonly pasteImage?: (file: File) => Promise<string | null>;
  /**
   * 敲 `[[` 时的候选来源（`F5` 链接补全）。**同步**返回库内文件。
   *
   * ★ 形状与 `editor/linkSuggest.LinkCandidate` 一致，但这里**故意写成结构类型**：
   *   卡片定义层不必为了一个字段去 import 编辑器模块（`registry` 是"卡片与环境"的
   *   边界，编辑器属于它的下游）。过滤与排序由编辑器那侧做，这里只给全量清单。
   * ★ 缺席 = 不做补全（`[[` 就是普通文本）。
   */
  readonly suggestLinks?: (query: string) => readonly { path: string; label?: string }[];
  /** 当前缩放比（`02 §8.2`：图片等按缩放降级到缩略图） */
  readonly zoom: number;
  /**
   * 图片卡**始终使用原图**（`A5`，用户 2026-09-18："图片卡清晰度应该保持原图清晰度"）。
   *
   * ★ 与 `zoom` 那条判据分开：`zoom` 那条是"缩略图在屏幕上够不够用"（自动，顺带省显存）；
   *   这一条是用户明确要"不管缩多小都给我用原图" —— 设置里默认开（`settings.alwaysFullImage`）。
   * ★ 缺席 = 关（回到自动判定）：单测与将来的嵌入视图不必知道这个设置。
   */
  readonly alwaysFullImage?: boolean;
  readonly mode: CardViewMode;
  /**
   * 这块白板现在是不是**只读**（T4.06 的归档锁定 / 演示态）。
   *
   * ★ 与 `minds.isReadOnly(path)` 是两件事：那一个是"这份 `.nestmind` 自己处于保护态
   *   （解析失败）"，这一个是"白板这一层不许改"。脑图卡（`F3a`）两个都要看 ——
   *   只读板上点节点改名，等于从白板绕过了一次只读。
   * ★ 缺席 = 不特殊处理（单测 / 嵌入视图）。
   */
  readonly readOnly?: boolean;
  /**
   * 本次编辑的入口（O01 / O02）。缺席 = `'title'`（双击那条路）。
   *
   * ★ `mode !== 'edit'` 时不传：显示态没有"从哪一步进来"这回事，
   *   卡片据此也不会在两种入口之间摇摆。
   */
  readonly editEntry?: EditEntry;
  /**
   * Vault 访问桥。**可选**：只有在 Obsidian 环境里渲染时才有 ——
   * 单测里不传，卡片必须优雅降级（引用卡就画成"读不到内容"而不是崩）。
   */
  readonly notes?: VaultBridge;
  /**
   * 脑图桥（`F3a`）：那张脑图卡要读写的 `.nestmind`。
   *
   * ★ 与 `notes` 同一条分工：这一层不认识 `MindRepository`，只声明能力形状
   *   （`mind/embed/MindBridge.ts`），实现由视图给。
   * ★ 不传 = 脑图卡画成"这份脑图读不出来"（单测 / 嵌入视图）。
   */
  readonly minds?: MindBridge;
  /** 缩略图桥（T1.52）。不传 = 图片卡只能直接用原图（单测/无缓存环境） */
  readonly thumbnails?: ThumbnailBridge;
  /** 系统文件操作桥（T1.53） */
  readonly shell?: ShellBridge;
  /** 剪贴板桥（T3.04：色板卡"点击复制"）。不传 = 卡片画成"复制失败" */
  readonly clipboard?: ClipboardBridge;
  /** 白板导航桥（T1.61） */
  readonly boards?: BoardNavBridge;
  /** 跨白板反链桥（T5.04）。不传 = 引用卡不画反链角标（单测/嵌入视图） */
  readonly backlinks?: BacklinkBridge;
  /** 外链能力桥（T2.04–T2.06）。不传 = 链接卡只显示域名，抓取/打开按钮都不出现 */
  readonly links?: LinkPreviewBridge;
  /**
   * 静态地图瓦片桥（`O08`）。不传 / 未启用 = 地图卡退化成"只显示链接与坐标"，
   * 卡上那句提示也跟着换一种说法（见 `cards/map.ts`）。
   */
  readonly mapTiles?: MapTileBridge;
  /** 把内容改动写回模型（只传改动的字段，其余原样保留） */
  updateContent(patch: Partial<CardContentOf<CardType>>): void;
  /**
   * 一次写回卡片的**标题与内容**（"标题 + 内容两格"编辑态的收口，`O22`）。
   *
   * ★ 为什么必须一次写：两格各自提交会在第一笔写入后触发重绘，而此刻这次编辑还没
   *   结束（`editingCardId` 未清）→ 编辑器被重造、另一格的现场丢失。合并成一次
   *   → 只重绘一次、只进一步撤销。只传改动的字段；都不变 = 什么都不写。
   * ★ 标题是**卡片级**字段（`card.title`）、正文是**内容级**字段（`card.content`），
   *   所以这个口子与 `updateContent` 分开。
   * ★ 现用户只剩**待办卡**（`cards/todo.ts`）与**仅标题卡**（`cards/titleCard.ts`）；
   *   便签 / 同步便签自 `F5` 起只有正文一格，走 `updateContent`（见 `cards/note.ts` 文件头）。
   */
  updateCard(patch: { title?: string; content?: Partial<CardContentOf<CardType>> }): void;
  /** 请求切换呈现模式（进入/退出编辑态） */
  setMode(mode: CardViewMode): void;
  /**
   * 给一个元素画上 Obsidian 图标（`O32`：链接卡那个「打开」按钮）。
   *
   * ★ 由视图注入（`obsidian.setIcon`）：`cards/` 不许 import `obsidian`（那会让卡片
   *   定义没法在 node 下单测）。不传时卡片退回文字按钮 —— 与 `links` / `clipboard`
   *   同一套"能力缺席就降级"的约定。
   */
  setIcon?(el: HTMLElement, name: string): void;
  /**
   * 异步内容**落地后**调用一次（T1.38 与 T1.44 的交点）。
   *
   * 卡片层量高度发生在 `render()` 返回的瞬间，而引用卡此刻还在等 `Vault.read()` ——
   * 量到的是一个空槽位。内容真正画完之后必须再喊一声，否则引用卡的自动高度永远不生效。
   * 不实现（便签卡）时卡片层不做任何事，没有代价。
   */
  contentReady?(): void;
  /**
   * 内容**自己**要把卡片撑到多大（两个方向都只增不减）。
   *
   * ★ 用户 2026-09-21（`F4` 的脑图卡）："我现在不断地增加节点，会让整个脑图的所有节点都
   *   缩小。应该是无论如何增加节点，脑图中节点尺寸不用相对白板等比缩小。"
   *   —— 那颗卡的内容（一张脑图）**不能靠缩放去迁就卡片**，只能反过来：
   *   卡片长大到装得下它。卡内的节点于是永远 1:1，与白板上的其它卡片"一样大"。
   * ★ 与 `measure`（只报**高度**，给"自适应高度"的便签 / 引用卡用）分开：
   *   那一条是"内容多高就多高、宽度由用户定"；这一条是"宽度也要跟着内容走"。
   *   两者是两种尺寸策略，不该塞进同一个返回形状里（一个 `number | Size` 的联合类型
   *   会让每个调用点都要先分辨"这是哪一种"）。
   * ★ 只增不减、并且**合并进一次提交**（视图那一侧实现，见 `BoardView.requestCardSize`）：
   *   连续加五个节点不该在历史里留五条记录。
   */
  growTo?(size: Size): void;
  /**
   * 把正文写回**整个同步组**（T7.04）。
   *
   * 同步便签（`cards/syncNote.ts`）的"同一份内容出现在多处"就靠它落地：`key` 相同的
   * 若干张在**一次**写入里一起改 —— 只发一次 `changed`（一次重绘），不会出现"一张新、
   * 两张旧"那种看得见的闪烁。
   *
   * ★ 可选：不传时（单测 / 将来的嵌入视图）同步便签退回单卡写回，表现得像一张普通
   *   便签，而不是"编辑了没反应"（与 `notes` / `boards` 同一套约定）。
   */
  writeSyncGroup?(key: string, md: string): void;
}

/**
 * 卡片"行为"（非渲染）所需的上下文。
 *
 * 与 `CardRenderContext` 分开是刻意的：渲染上下文要求一个内容槽 + 一个
 * `Component`（`MarkdownRenderer` 要挂内嵌组件），而"双击这张卡该干嘛"
 * 不需要这些 —— 为了一次点击造一个 `Component` 再销毁，纯属浪费且容易漏掉销毁。
 */
export interface CardActionContext {
  readonly app: App;
  readonly sourcePath: string;
  readonly notes?: VaultBridge;
  /** 脑图桥（`F3a`）：脑图卡的双击 / 菜单要拿它打开那份 `.nestmind`（同 `CardRenderContext`） */
  readonly minds?: MindBridge;
  /** 系统文件操作桥（T1.53：双击文件卡用系统应用打开） */
  readonly shell?: ShellBridge;
  /** 白板导航桥（T1.61：双击白板卡进去） */
  readonly boards?: BoardNavBridge;
  /**
   * 外链能力桥（T2.04–T2.06：双击打开浏览器、菜单里抓预览）。
   *
   * ★ 能力缺失（单测、将来的嵌入视图）时双击**不接管** —— 与文件卡"目标不存在
   *   就交回视图"同一条约定：宁可让视图去解释，也不要吞掉一次点击。
   */
  readonly links?: LinkPreviewBridge;
  /**
   * 手绘标注桥（T3.09：双击图片卡直接在图上画）。
   *
   * ★ 不传（单测、将来的嵌入视图）时双击**不接管** —— 与文件卡"目标不存在就交回
   *   视图"同一条约定：宁可让视图去解释，也不要吞掉一次点击。
   */
  readonly ink?: InkAnnotateBridge;
  /**
   * 弹一个**调色板**（`O29`：色卡双击）。
   *
   * ★ `current` 是当前色（没有就给 `null`）；用户选定后回调 `apply`，取消则什么都不发生。
   * ★ 不传（单测 / 将来的嵌入视图）时**双击不接管** —— 与 `links` / `ink` 同一条约定：
   *   宁可让视图按通用行为处理，也不要吞掉一次点击。
   */
  readonly pickColor?: (current: string | null, apply: (color: HexColor) => void) => void;
  /**
   * 把内容改动写回模型。
   *
   * 类型自己接管的行为如果要改数据（"重新链接"选完笔记得写入 `path`），
   * 就需要这个口子 —— 否则 `cards/` 层只能认识 `BoardView` 才能落地，
   * 而这正是要避免的耦合。
   */
  readonly applyContent: (patch: Partial<CardContentOf<CardType>>) => void;
}

/** 导出为 Markdown 时的环境（`F9-01`，T1.72 消费） */
export interface CardExportContext {
  readonly sourcePath: string;
}

/**
 * 可以被卡片类型**关掉**的通用右键菜单项（见 {@link CardTypeDefinition.menuItems}）。
 *
 * ★ 只有这三条 —— 都是"某些类型的卡片上根本不存在这件事"的项：
 *   `editContent`（编辑内容）/ `showTitle`（显示 / 隐藏标题）/ `collapse`（收起 / 展开）。
 *   要再加一条，先回答"这张卡上到底有没有这件事"：只是"此刻不能做"的该用**置灰**，
 *   不是不出现（见 `menuItems` 的说明）。
 */
export type CardMenuItemKey = 'editContent' | 'showTitle' | 'collapse';

/**
 * 一种卡片类型的定义（`03 §7.3`）。
 *
 * `T` 用卡片类型字面量而不是 `CardType`：这样 `card.content` 在定义内部
 * **自动收窄到自己那一种形状**，写 `card.content.md` 不用断言。
 */
export interface CardTypeDefinition<T extends CardType = CardType> {
  type: T;
  /** 显示名。用 getter 实现可让语言切换立刻生效 */
  readonly displayName: string;
  /** Lucide 图标名 */
  icon: string;
  defaultSize: Size;
  /**
   * 新建这张卡时，**尺寸按内容算**（不给 = 用 `defaultSize`）。
   *
   * ★ 内嵌脑图卡（`F4`）用它：用户 2026-09-21 要求"尺寸随内容自适应（不是固定值）"。
   *   算这件事需要内容 —— 而内容恰恰是 `createDefaultContent()` 刚造出来的那一份，
   *   所以判据交给类型自己（视图只知道"卡上有什么内容"，不知道"脑图该多大"）。
   * ★ 只影响**新建**：已存在的卡片尺寸仍然由用户（与拖拽 / 缩放）说了算，
   *   读入口不会按内容去改用户摆好的大小。
   */
  sizeForContent?(content: CardContentOf<T>): Size;
  /**
   * **新建**这张卡时的默认主色；不写 = 用设置里的「默认卡片颜色」（`F11-03`）。
   *
   * ★ 图片卡是它唯一的用户：照片默认配纯黑"相框"（用户 2026-09-17）。做成类型上的一个口头，
   *   而不是在视图里写 `if (type === 'image')` —— 视图那条路只管"问定义"，加类型时不必改视图。
   * ★ 只影响新建：已存在的卡片一个字节都不动。
   */
  defaultColor?: CardColor;
  /**
   * 新建这张卡后是否**立刻进入内容编辑态**（默认 `true`，与便签 / 待办的老规矩一致）。
   *
   * ★ 评论卡给 `false`（O13）：它新建出来是一张**空线程**，没有"急着要写"的东西；
   *   而编辑态会吃掉卡片下半张脸的拖拽区，用户此刻更想做的往往是"先把它拖到
   *   想说的地方去"。右键 / 双击仍然随时能编辑，一次都没少。
   * ★ 为什么放在**类型定义**里而不是让 `createCardAt` 按 `type === 'comment'` 判断：
   *   那会把一种具体卡片的规矩焊进视图，"以后再加一种不需要立刻编辑的卡"就得回头改视图。
   */
  autoEditOnCreate?: boolean;
  /**
   * 卡面**画不画那个盒子**（默认 `'card'` = 边框 / 底色 / 圆角 / 阴影都要）。
   *
   * ★ 脑图卡（`F3a` / `F4`）给 `'bare'`：用户 2026-09-21 —— "脑图是作为一个组件出现的，
   *   其实不用底下那个框"。它要的效果是"画面上就是一棵脑图"，而不是"脑图上盖着一个盒子"。
   * ★ 只去**视觉**、不去**几何**：卡片矩形、命中区、尺寸手柄、右键菜单、拖动全照旧 ——
   *   无框之后"看得见的那只手"由**根节点**承担（同一天定的：卡片级入口都挂到根节点上）。
   * ★ 为什么是类型定义上的一个口头而不是视图里的 `if (type === 'mind')`：与 `autoEditOnCreate`
   *   同一条理由 —— 视图只管"问定义"，以后再加一种不要框的卡（比如将来的"画布卡"）不必改视图。
   */
  chrome?: 'card' | 'bare';
  createDefaultContent(): CardContentOf<T>;
  /** 渲染卡片**主体**（骨架与定位由 `CardLayer` 负责，这里只管槽位里的内容） */
  render(el: HTMLElement, card: CardOfType<T>, ctx: CardRenderContext): void;
  /**
   * 按内容量出"内容需要多高"（T1.38 消费）。
   *
   * 只对**自适应尺寸**的卡片生效：返回内容所需高度，由卡片层与最小高度取大。
   * 往返成本不低（要量布局 → 可能 `await` 图片），所以卡片层只在
   * "内容指纹变了或宽度变了"时才调它。
   */
  measure?(el: HTMLElement, card: CardOfType<T>, ctx: CardRenderContext): number;
  /** 自己贡献的右键菜单项（T1.41 消费，见 `CardTypeMenuItem`） */
  contextMenu?(card: CardOfType<T>, ctx: CardTypeMenuContext): CardTypeMenuItem[];
  /**
   * 右键菜单里**通用项**的开关（`A3` 仅标题卡，用户 2026-09-18："编辑内容 / 收起卡片 /
   * 显示/隐藏标题 这些菜单对于标题卡没意义"）。
   *
   * ★ 缺省（不写）= 摆出来；显式 `false` = 那一项**整项不出现** —— 不是置灰：
   *   置灰是"这件事此刻不能做"，不出现是"这张卡上没有这件事"（与 `QuickBar` 的
   *   `features` 同一条取舍）。消费方是 `view/interact/cardMenu` 的 `buildCardMenuSpec`。
   */
  menuItems?: Partial<Record<CardMenuItemKey, boolean>>;
  /**
   * 双击整张卡（既不是链接、也不是内嵌可编辑区）时的默认动作（T1.43 消费）。
   *
   * 返回 `true` = 我处理了，视图不要再进入编辑态。引用卡靠这个打开源笔记；
   * 没实现它的类型（便签卡）走"进入编辑态"的老路。
   */
  onDoubleClick?(card: CardOfType<T>, ctx: CardActionContext): boolean;
  /**
   * **收起态**标题行里写什么（`O34`）。
   *
   * ★ 只在卡片自己的 `title` 为空时才问它：收起 = 只留标题那一行，而有些类型的"名字"
   *   根本不在 `CardBase.title` 上 —— 链接卡的网页标题在 `content.title` 里，
   *   `card.title` 从来是空的。不问这一步，收起的链接卡就是一条空白。
   * ★ 只影响收起态：显示态的标题行一个字不改（链接卡那一行本来归它自己的预览用）。
   * ★ 没声明的类型 = 空串（收起后那一行是空的，但 `▸` 展开按钮仍在）。
   */
  collapsedTitle?(card: CardOfType<T>): string;
  /**
   * 这张卡的**标题就是某个真实文件的名字**时，返回那个文件的路径；否则 `null`（`O37`）。
   *
   * ★ 声明"哪个类型的标题管着文件名"本该由类型自己说：`.md` 文件卡（`O30`）与 `.nboard`
   *   白板卡（`O37`）的标题就是文件名，而图片 / PDF / 表格卡的标题只是卡片上的字
   *   （跟着文件名的后果是"改一下卡片名字就把用户的文件改名了"）。视图只负责执行，
   *   不去猜类型 —— 那份名单长在 `setCardTitle` 里的话，每加一种"文件型的卡"都要回去改它。
   * ★ 返回的是**当前路径**而不是"能不能改"：调用方还要用它取预填的主名（`splitName`）。
   * ★ 空格位 / 断链（路径为空）时返回 `null` —— 没有文件可改。
   */
  titleFilePath?(card: CardOfType<T>): string | null;
  /**
   * "重新链接"动作（T1.45 消费）。返回 `true` = 已接管（通常会弹一个选择器）。
   *
   * 和 `onDoubleClick` 分开而不是合成一个 `handle(action)`：两者触发时机、
   * 返回语义（一个决定"要不要进编辑态"、一个只表示"我处理了"）都不同，
   * 合成一个只会让每个实现都写一堆 `if (action === …)`。
   */
  relink?(card: CardOfType<T>, ctx: CardActionContext): boolean;
  /** 导出为 Markdown 片段（T1.72 消费） */
  toMarkdown(card: CardOfType<T>, ctx: CardExportContext): string;
  /** 节点被回收进复用池前的清理（解绑事件、停掉异步任务） */
  destroy?(el: HTMLElement): void;
}

/** 抹掉 `T` 的注册表存储形态，让异质定义能放进同一个 Map */
type AnyCardTypeDefinition = CardTypeDefinition<CardType>;

/** 卡片类型 → 占位文案的 i18n 键（未注册类型的兜底显示） */
export const CARD_TYPE_LABEL_KEY: Record<CardType, MessageKey> = {
  note: 'card.type.note',
  noteRef: 'card.type.noteRef',
  image: 'card.type.image',
  file: 'card.type.file',
  video: 'card.type.video',
  audio: 'card.type.audio',
  // PDF 预览卡（`F8`）
  pdf: 'card.type.pdf',
  // `.canvas` 预览卡（`F6`）
  canvas: 'card.type.canvas',
  // 脑图卡（`F3a`）
  mindRef: 'card.type.mindRef',
  // 内嵌脑图卡（`F4`）
  mind: 'card.type.mind',
  titleCard: 'card.type.titleCard',
  gallery: 'card.type.gallery',
  link: 'card.type.link',
  todo: 'card.type.todo',
  swatch: 'card.type.swatch',
  boardRef: 'card.type.boardRef',
  ink: 'card.type.ink',
  map: 'card.type.map',
  syncNote: 'card.type.syncNote',
  comment: 'card.type.comment',
};

export class CardTypeRegistry {
  private readonly definitions = new Map<CardType, AnyCardTypeDefinition>();

  /**
   * 注册一种卡片类型。重复注册同一类型直接抛错（见文件头说明）。
   *
   * 参数保留 `T`（而不是直接收 `AnyCardTypeDefinition`）：`CardTypeDefinition` 的方法
   * 参数在 `T` 上是**逆变**的，抹平 `T` 之外的类型无法直接赋值。转换只在这里发生一次，
   * 后续 `render` / `toMarkdown` 取出时再按调用方给的同一张卡断言回去。
   */
  register<T extends CardType>(definition: CardTypeDefinition<T>): void {
    if (this.definitions.has(definition.type)) {
      throw new Error(`nestboard: card type "${definition.type}" is already registered`);
    }
    this.definitions.set(definition.type, definition as unknown as AnyCardTypeDefinition);
  }

  has(type: CardType): boolean {
    return this.definitions.has(type);
  }

  /**
   * 按类型取定义。
   *
   * 参数保留 `T` 是为了**把窄类型还回去**：`get('note')` 拿到的是
   * `CardTypeDefinition<'note'>`，`createDefaultContent()` 因此有确切返回类型，
   * 调用方不必再写 `as`（见 T1.34 新建便签）。与 `register` 同理，
   * 转换只在这一处发生 —— 注册时已经用同一套 `T` 校验过形状。
   */
  get<T extends CardType>(type: T): CardTypeDefinition<T> | undefined {
    return this.definitions.get(type) as unknown as CardTypeDefinition<T> | undefined;
  }

  get size(): number {
    return this.definitions.size;
  }

  /** 展示名：未注册的类型回落到 i18n 里的类型名，而不是空白 */
  labelOf(type: CardType): string {
    return this.definitions.get(type)?.displayName ?? t(CARD_TYPE_LABEL_KEY[type]);
  }

  /**
   * 渲染卡片主体。返回 `false` = 这个类型还没实现，调用方自己去画占位。
   *
   * 类型断言集中在这一个方法里：注册时 `type` 与定义的 `T` 已绑定，
   * `card.type`（由调用方从同一张卡上取）必然一致。
   */
  render(el: HTMLElement, card: Card, ctx: CardRenderContext): boolean {
    const definition = this.definitions.get(card.type);
    if (!definition) return false;
    (definition.render as (el: HTMLElement, card: Card, ctx: CardRenderContext) => void)(
      el,
      card,
      ctx,
    );
    return true;
  }

  /** 节点回收前的清理。未注册的类型无事可做 */
  destroy(el: HTMLElement, type: CardType): void {
    this.definitions.get(type)?.destroy?.(el);
  }

  /**
   * 收起态那一行写什么（`O34`）：`card.title` 优先，空则问类型的 {@link CardTypeDefinition.collapsedTitle}。
   *
   * ★ 放在注册表而不是 `CardLayer`：类型名册本来就在这儿，而 `CardLayer` 与类型打交道的
   *   唯一入口就是 `options.registry`（同 `contextMenu` / `toMarkdown` / `activate`）。
   * ★ 用户自己写过的标题**永远优先**：`collapsedTitle` 是"卡片没名字时替它说一句话"，
   *   不是"覆盖用户起的名字"。
   */
  collapsedTitle(card: Card): string {
    if (card.title.length > 0) return card.title;
    const definition = this.definitions.get(card.type);
    if (!definition?.collapsedTitle) return '';
    return (definition.collapsedTitle as (value: Card) => string)(card);
  }

  /**
   * 这个类型双击**会不会被自己接走**（`O35`）：有 `onDoubleClick` 就是会。
   *
   * ★ 右键菜单用它决定要不要给「编辑内容」：接走了就说明双击不是"进编辑态"，
   *   那一项点下去会跳到别处（打开文件 / 跳浏览器 / 进子板 / 弹调色板），名不副实。
   * ★ 判据是"有没有这个钩子"而不是"它这次返回什么"：返回值要真跑一遍才知道，
   *   而菜单得在点开**之前**就摆好。
   * ★ 例外只有一个：色卡双击弹调色板，但它**确有**内联编辑器（多行 / 渐变色号），
   *   于是由色卡自己在类型菜单里补一条 `editContent`（那条会**跳过** `activate`）。
   */
  inlineEditable(type: CardType): boolean {
    return this.definitions.get(type)?.onDoubleClick === undefined;
  }

  /**
   * 这张卡的标题是否管着某个真实文件名（`O30` / `O37`）。是则返回那个路径，否则 `null`。
   *
   * ★ 未注册的类型 / 没声明钩子的类型一律 `null`：改标题只写 `card.title`，一个文件都不碰。
   */
  titleFilePath(card: Card): string | null {
    const definition = this.definitions.get(card.type);
    if (!definition?.titleFilePath) return null;
    return (definition.titleFilePath as (value: Card) => string | null)(card);
  }

  /**
   * 双击动作。返回 `false` = 这个类型没接管，调用方按默认逻辑处理
   * （便签卡 = 进入编辑态）。
   */
  activate(card: Card, ctx: CardActionContext): boolean {
    const definition = this.definitions.get(card.type);
    if (!definition?.onDoubleClick) return false;
    return definition.onDoubleClick(card, ctx) === true;
  }

  /**
   * 取类型贡献的右键菜单项（T1.41）。
   *
   * `contextMenu` 的参数在 `T` 上逆变，抹平后无法直接调用 —— 这里的断言与
   * `render` / `toMarkdown` 同理：`card.type` 与定义注册时的 `T` 由注册表保证一致。
   */
  contextMenu(card: Card, ctx: CardTypeMenuContext): CardTypeMenuItem[] {
    const definition = this.definitions.get(card.type);
    if (!definition?.contextMenu) return [];
    return (definition.contextMenu as (card: Card, ctx: CardTypeMenuContext) => CardTypeMenuItem[])(
      card,
      ctx,
    );
  }

  /** "重新链接"（T1.45）。返回 `false` = 这个类型不支持重连 */
  relink(card: Card, ctx: CardActionContext): boolean {
    const definition = this.definitions.get(card.type);
    if (!definition?.relink) return false;
    return definition.relink(card, ctx) === true;
  }

  /** 导出片段。未注册的类型回落到空串（导出层会跳过并计数，T1.72） */
  toMarkdown(card: Card, ctx: CardExportContext): string {
    const definition = this.definitions.get(card.type);
    if (!definition) return '';
    return (definition.toMarkdown as (card: Card, ctx: CardExportContext) => string)(card, ctx);
  }
}

/**
 * 建一个装好**已实现**卡片类型的注册表。
 *
 * 现在有便签卡（T1.32）、引用卡（T1.42）、图片卡（T1.50）、文件卡（T1.53）、
 * 白板卡（T1.61）、链接卡（T1.70）、待办卡（T3.01）、色板卡（T3.04）、手绘卡（T3.08）、
 * 地图卡（T7.03）、同步便签卡（T7.04）。剩下的类型在后续任务里
 * 陆续 `register()` 进来 —— 注册表允许缺类型，缺失的类型由卡片层回落到占位渲染，
 * **任何阶段都不会白屏**。
 */
export function createCardRegistry(): CardTypeRegistry {
  const registry = new CardTypeRegistry();
  registry.register(noteCard);
  registry.register(noteRefCard);
  registry.register(imageCard);
  registry.register(fileCard);
  registry.register(videoCard);
  registry.register(audioCard);
  registry.register(titleCard);
  registry.register(galleryCard);
  registry.register(boardRefCard);
  registry.register(linkCard);
  registry.register(todoCard);
  registry.register(swatchCard);
  registry.register(inkCard);
  registry.register(mapCard);
  registry.register(syncNoteCard);
  registry.register(commentCard);
  // PDF 预览卡（`F8`，用户 2026-09-21）
  registry.register(pdfCard);
  // `.canvas` 预览卡（`F6`，用户 2026-09-21）
  registry.register(canvasCard);
  // 脑图卡（`F3a`，用户 2026-09-21）
  registry.register(mindRefCard);
  // 内嵌脑图卡（`F4`，用户 2026-09-21）
  registry.register(mindCard);
  return registry;
}
