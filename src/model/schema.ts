/**
 * 数据模型类型定义（T1.07），**严格对齐 03 §2 的 `.nboard` 规范**。
 *
 * ★ 本文件是 `model/` 的入口契约，也是 §16 要求「两人并行前必须早对齐」的第一份契约。
 *   - 只放类型与运行期常量，不放逻辑；
 *   - **不得 import `obsidian`，不得碰 DOM**（03 §7.2 硬性规则）→ 保证可纯 Node 单测。
 *
 * 改这里的字段 = 改文件格式 → 必须同步 `io/migrate.ts` 的版本链与 `03 §2`。
 */

// ★ 只 import **类型**：`util/geometry` 是纯几何工具（不碰 DOM、不碰 obsidian），
//   而且 `import type` 会被编译器完全擦除 —— 本文件"运行期零依赖"的性质不变
import type { Point } from '../util/geometry';
// ★ 内嵌脑图卡（`F4`）的内容就是**整份** `MindFile`（形状与 `.nestmind` 逐字相同）。
//   这里与 `mind/model/schema` 之间是**类型级**的互相引用（那边也引了本文件的颜色类型）——
//   两边都是 `import type`，编译后被抹掉，**运行期不存在环**。用一个"结构相似的别名"
//   去绕开它，只会多出一份要跟着脑图 schema 同步的形状。
import type { MindFile } from '../mind/model/schema';

// ─────────────────────────────────────────────────────────────
// 卡片类型
// ─────────────────────────────────────────────────────────────

/**
 * 卡片类型（03 §2.7）。
 *
 * ★ 追加 `map`（地图卡，`T7.03`）、`syncNote`（同步便签，`T7.04`）与 `comment`
 *   （评论卡，`T7.05`）**都没有**递增 `BOARD_VERSION`：新类型是纯增量 —— 老文件里
 *   根本不会出现它们，所以没有任何旧数据需要迁移（`io/migrate.ts` 那条链只管
 *   "破坏性变更"）。反方向（老插件读新文件）不是要支持的场景：插件是整个换的。
 */
export const CARD_TYPES = [
  'note',
  'noteRef',
  'image',
  'file',
  'video',
  'audio',
  'titleCard',
  'gallery',
  'link',
  'todo',
  'swatch',
  'boardRef',
  'ink',
  'map',
  'syncNote',
  'comment',
  // PDF 预览卡（`F8`，用户 2026-09-21："支持 pdf 文件类型的预览"）
  'pdf',
  // `.canvas` 预览卡（`F6`，用户 2026-09-21："支持.canvas 类型文件预览"）
  'canvas',
  // 脑图卡（`F3a`，用户 2026-09-21："把我们的 nestmind 拖进 nboard 白板……在 nboard 依然
  // 可以对 nest 脑图进行操作"）—— 卡面就是那份 `.nestmind` 本身（可点、可改、可折叠）
  'mindRef',
  // 内嵌脑图卡（`F4`，用户 2026-09-21："直接在白板内部建立的脑图……只是不指向具体某个文件"）
  // —— 与 `mindRef` 同一套可编辑组件，只是**数据存在这张卡自己的 content 里**
  'mind',
] as const;

export type CardType = (typeof CARD_TYPES)[number];

export function isCardType(value: unknown): value is CardType {
  return typeof value === 'string' && (CARD_TYPES as readonly string[]).includes(value);
}

// ─────────────────────────────────────────────────────────────
// 颜色
// ─────────────────────────────────────────────────────────────

/** 主题 6 色编号：色值由应用映射到 Obsidian 主题色，不写进文件（03 §7.4） */
export type ThemeColor = '1' | '2' | '3' | '4' | '5' | '6';

export const THEME_COLORS: readonly ThemeColor[] = ['1', '2', '3', '4', '5', '6'];

/** `#RGB` / `#RRGGBB` */
export type HexColor = string;

export type CardColor = ThemeColor | HexColor;

export function isThemeColor(value: unknown): value is ThemeColor {
  return typeof value === 'string' && (THEME_COLORS as readonly string[]).includes(value);
}

export function isHexColor(value: unknown): value is HexColor {
  return typeof value === 'string' && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value);
}

// ─────────────────────────────────────────────────────────────
// 卡片内容（每种 type 一种形状，03 §2.7）
// ─────────────────────────────────────────────────────────────

export type NoteEditorMode = 'markdown' | 'preview';

/**
 * 便签的配色变体（`O06`）。
 *
 *  * `light` —— 跟随主题的普通便签（**默认**）；
 *  * `dark`  —— 黑底白字的"黑卡"：深色底 + 亮色正文，在浅色主题的名片上也很显眼。
 *
 * ★ **缺席 = `light`**，与 `InkPath.alpha` / `BoardRefContent.icon` 同一条规矩：
 *   `light` 不写进文件，于是"从没切过变体"与"切回浅色"的卡片是同一份字节。
 *   （类型上仍然保留 `light`，是为了让读入口 / 菜单判定写得出"当前是哪种"，
 *   而**写入口**只写 `dark`、把 `light` 归成缺席。）
 * ★ 只影响**画法**（底色与正文色），不影响内容 —— 所以导出 / 搜索 / 渲染正文那条路
 *   一个字都不用改，只有颜色要跟着走（见 `export/toPng.ts` 的 `isDarkNoteCard`）。
 */
export type NoteVariant = 'light' | 'dark';

/** 1) note —— 内联便签，内容存在白板文件里 */
export interface NoteContent {
  md: string;
  editorMode: NoteEditorMode;
  /** 配色变体（`O06`）。缺席 = `light`，见 {@link NoteVariant} */
  variant?: NoteVariant;
}

export type NoteRefMode = 'summary' | 'embed' | 'cover';

/** 2) noteRef —— 引用卡（★核心差异：内容 = 真实 `.md`，双链原生生效） */
export interface NoteRefContent {
  /** Vault 内相对路径，**不是** wikilink 文本 */
  path: string;
  /** `#标题` 或 `#^blockid`；null = 整篇 */
  subpath: string | null;
  mode: NoteRefMode;
  excerptLines: number;
}

/** 非破坏性裁剪参数：全部为 0~1 的比例（不改原图，T2.02） */
export interface ImageCrop {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type ImageFit = 'cover' | 'contain';

/** 3) image */
export interface ImageContent {
  path: string;
  caption: string;
  crop: ImageCrop;
  fit: ImageFit;
}

/** 4) file —— 任意文件（图标 + 文件名 + 大小） */
export interface FileContent {
  path: string;
  showSize: boolean;
}

/**
 * 脑图卡（`F3a`）的内容：**就是文件卡那一个路径**（指向一份 `.nestmind`）。
 *
 * ★ 别名而不是复制一份接口：`pdf` / `canvas` 两张预览卡也是这么做的（见 `CardContentMap`
 *   里那两条注释）—— 多立一个名字，读写两边就多一处要同步的映射。
 * ★ `showSize` 在这张卡上不画（卡面全给那张脑图）。
 */
export type MindRefContent = FileContent;

/**
 * 内嵌脑图卡（`F4`）的内容：**整份脑图模型**（不指向任何文件）。
 *
 * ★ 为什么包一层 `mind` 而不是把 `MindFile` 的键平铺进 `content`：平铺之后
 *   "这张卡的内容"与"一份脑图"就再也分不开了（将来想给这张卡加一个自己的键 ——
 *   比如"卡内只显示前几层"——就会被误当成脑图模型的字段写进校验与导出）。
 *   包一层只多两个字符，边界却是清楚的。
 */
export interface MindContent {
  mind: MindFile;
}

/** 5) link —— 链接卡（渲染不联网；抓取只在用户点「获取预览」之后，03 §7.5 合规第 5 条） */
export interface LinkContent {
  /** 用户粘贴进来的原始地址（短链就存短链，**不改写**它 —— 那是用户给的那个东西） */
  url: string;
  title: string;
  description: string;
  image: string;
  fetchedAt: string | null;
  /**
   * 站点名（`O20`，来自 `og:site_name`）。**可选，空值键缺席** ——
   * 与 `MapContent.sourceUrl` / `coords` 同一条约定：没抓到就不写这个键，
   * 否则"从没抓到"与"抓到是空"是两份不同的字节。
   */
  siteName?: string;
  /**
   * 站点图标（`O20`，页面 `<link rel="icon">` / `og:logo` 里声明的地址）。
   *
   * ★ 它是**远程地址**，与 `image`（落盘后的库内路径）不是一回事：图标只从
   *   "已经抓下来的那份 HTML"里取，**不额外发一次请求去发现它**（`O20` 的明示取舍）；
   *   卡面加载它失败时退回字母徽章，所以离线也不会留一个裂图。
   */
  icon?: string;
  /**
   * 重定向 / `og:url` 之后**最终**的网址（`O20`）。
   *
   * ★ 只在"与 `url` 不同"时才写（见 `cards/link.ts`）：短链展开、站点规范化之后
   *   这条才有信息量，而"最终就是原样"时多存一份只是噪声。
   * ★ 空值键缺席（同上）。
   */
  finalUrl?: string;
  /**
   * 卡面样式（`A8`："链接卡迷你样式"）。
   *
   * ★ **可选，缺省 = `'full'`**（完整卡：站点 + 标题 + 描述 + 预览图）。
   *   写 `'mini'` 时只画一行"站点图标 + 域名"，把链接当成一枚**书签**摆在板子上
   *   （卡片高度也随之换成 `LINK_MINI_SIZE`，见 `view/BoardView.ts` 的 `toggleLinkStyleCard`）。
   * ★ 与 `siteName` / `finalUrl` 同一条约定：**默认那档不写进文件** ——
   *   旧 `.nboard` 一个字节不动，读写两边都不需要迁移。
   */
  style?: LinkStyle;
}

/** 链接卡的两档卡面（`A8`） */
export type LinkStyle = 'full' | 'mini';

export interface TodoItem {
  text: string;
  done: boolean;
}

/** 6) todo —— 与标准 Markdown 任务语法 `- [ ]` 完全互换 */
export interface TodoContent {
  title: string;
  items: TodoItem[];
}

/**
 * 渐变色里的**一个色标**（`O07`）。
 *
 * ★ `position` 用**百分比 0~100**（与 CSS 的 `%` 同一个单位），不换成 0~1：
 *   色标位置天生就是按百分比写的，来回换算只会在大数上攒出舍入误差。
 * ★ 缺席 = **由 `stops` 的顺序均分**（CSS `linear-gradient` 的规矩），
 *   不是 0 —— 所以它必须可选，不能补成 0。
 */
export interface SwatchStop {
  color: HexColor;
  /** 0~100；缺席 = 均分 */
  position?: number;
}

/**
 * 渐变色（`O07`）。
 *
 * ★ 只支持 `linear`，`angle` 就是 **CSS 的 `deg`**（0 = 向上、90 = 向右，顺时针）——
 *   刻意不发明自己的角度约定：这样"从别处粘来的 CSS"存下去、再回显出来是**同一句话**，
 *   用户看不懂我们的数据模型，但他看得懂自己粘进来的那行 CSS。
 * ★ 为什么不做 radial / conic：色板卡的用途是"挑色"，线性渐变覆盖了 95% 的场景；
 *   其余两种的解析（`circle at ...` / `from ... at ...`）会把这一小块撑成一节解析课，
 *   留给真有人要的时候再说（`O07` 的范围就是 linear）。
 */
export interface SwatchGradient {
  type: 'linear';
  /** CSS 角度（deg）。读入口收进 0~359 */
  angle: number;
  /** 至少 2 个（少于 2 个不构成渐变，读入口直接丢掉） */
  stops: SwatchStop[];
}

/**
 * 色板里的一格：**纯色或渐变**（`O07`）。
 *
 * ★ 用联合而不是"渐变 = 两个颜色的纯色"：色板卡整体上是个"颜色列表"，
 *   把渐变当成列表里的一种**元素**，`colors` 这个名字和长度语义（几格）都不变，
 *   老文件（`colors: ['#ff0000']`）原样能读，不需要迁移。
 */
export type SwatchEntry = HexColor | SwatchGradient;

/** 7) swatch —— 色板卡 */
export interface SwatchContent {
  colors: SwatchEntry[];
  pickedFrom: string | null;
}

/**
 * 白板卡卡面显示什么（`F2-8-2` / T7.09 `F7-10`）：
 *
 *  * `thumb` —— 目标板的 **256px 缩略图**（落盘缓存，多张卡尺寸一致，最省）；
 *  * `live`  —— **只读小窗**：按卡面实际的像素尺寸把目标板**矢量重画**一遍（T7.09）。
 *    卡面比 256px 大时缩略图就是糊的，而小窗是按"现在多大"画的；代价是每次
 *    卡面尺寸变化 / 目标板保存都要重画一次，所以它是**选项**而不是默认；
 *  * `none`  —— 不画预览，只留标题 + 概要；
 *  * `mini`  —— **不预览内容**（`O18`）：卡面只剩正中一个图标（`icon`，没设就画一个
 *    强调色方块），名字挪到卡**外面**的正下方居中。尺寸由**形态**给 —— 固定正方形
 *    （`BOARD_REF_MINI_SIZE`，便签默认宽的三分之一），用户拖不动它（`O09` 的旧版是
 *    "只有缩略图"，尺寸仍归用户）。
 *
 *    ★ 这是唯一一档会**改写卡片尺寸**的档位：选到它时钉成正方形，离开它时还回默认尺寸
 *      （`cards/boardRef.ts` 的 `boardRefPreviewSize`）。判据在读写两个入口各有一份，
 *      必须一致（`view/BoardView.setBoardRefPreview` 与 `model/validate`）。
 */
export type BoardRefPreview = 'thumb' | 'none' | 'live' | 'mini';

/** 8) boardRef —— 嵌套白板 */
export interface BoardRefContent {
  path: string;
  preview: BoardRefPreview;
  showCount: boolean;
  /**
   * 卡面图标（`O10`）：一个 emoji（`"📌"`），画在卡面标题左边的格子里。
   * 缺省 = 没设 —— 那时那一格画的是"这是白板"的强调色小方块（老外观）。
   *
   * ★ 存的是**字符**而不是 Obsidian 的图标名：白板卡在卡面上要的是"一眼能认出来的记号"，
   *   而 Lucide 图标在这个尺寸上几乎分不出彼此；emoji 还能用系统的输入法面板挑。
   * ★ 长度上限与清理见 `util/emoji.ts` 的 `normalizeIcon`（写入口与读入口共用一份）。
   */
  icon?: string;
}

/**
 * 手绘点：`[x, y]` 元组，与 03 §2.7 示例一致。
 *
 * ★ 第三个元素（**压感** 0..1）是可选的，见 `05 §3.5` 的 `DrawProps`
 *   （`points: [number,number,number?][]`）。用元组而不是对象：
 *   一条手绘线动辄几百个点，`[x,y]` 落盘比 `{x,y}` 少一半字节。
 * ★ 只有**数位笔**才写第三项（鼠标的 `pressure` 恒为 0.5，见 `model/ink.ts`），
 *   所以"老文件 / 鼠标画的笔"与"带压感的笔"是同一个格式，读回来没有两个分支。
 */
export type InkPoint = [number, number, number?];

export interface InkPath {
  color: HexColor;
  width: number;
  points: InkPoint[];
  /**
   * 不透明度（`T7.08` 荧光笔）。缺省 = `1`（不透明）。
   *
   * ★ 半透明**单独一个字段**，而不是把颜色写成 8 位 `#rrggbbaa`：`HexColor` 是
   *   全项目通用的"颜色"表示法（主题色、卡片强调色、连线色都在用），为了一支笔
   *   给它加一条"有时候有 alpha 通道、有时候没有"的隐规则，会让每一处颜色比较
   *   （"和上次一样吗"）都得先归一化。
   * ★ 纯增量：存量文件里没有这个字段，读出来就是"不透明"（见 `validate.readAlpha`）。
   */
  alpha?: number;
}

/** 9) ink —— 手绘（矢量路径，非位图；可缩放、可改色、可单删） */
export interface InkContent {
  paths: InkPath[];
}

/**
 * 图钉在**地图图片上的位置**。
 *
 * ★ 存的是**归一化坐标**（0~1，相对图片左上角），不是像素、也不是经纬度：
 *   - 不是像素：图片换一张分辨率不同的、或卡片被缩放，像素值立刻失准；
 *   - 不是经纬度：本插件零网络（`01 §4`），没有地理配准就换不出经纬度，
 *     而"图片上的相对位置"是离线唯一能确定的东西。
 *   ★ 也正因为是"相对某张图"的位置，换图时它**保留**（`cards/map.ts` 里写明理由）。
 */
export interface MapPin {
  x: number;
  y: number;
}

/**
 * 经纬度（`O08`）。
 *
 * ★ 只有"从分享链接"这条路能产生它 —— 插件不会去定位、不会去反查地址。
 *   它的用处有两个：没图时卡上至少有一行可读的东西；有它才能"再试一次出图"。
 * ★ 存进来的是**原样解析出来的数**，不做坐标系换算（GCJ-02 / BD-09 与 WGS-84 之间
 *   那套偏移量不在本插件的能力范围里 —— 换个底图服务商就会有几百米偏差）。
 */
export interface MapCoords {
  lat: number;
  lon: number;
}

/**
 * 10) map —— 地图卡（`F2.9` / `T7.03`）。
 *
 * ★ 卡上贴的永远是**落在 vault 里的一张静态图**（截图、导出的地图、扫描件都算），
 *   插件负责把图钉钉在图上。**不画在线瓦片**：没有地图库、没有平移缩放、
 *   没有离线瓦片缓存 —— `01` 的能力对照表里这条本就被标成"⚠️ 仅静态图"。
 * ★ `O08` 之后多了一条**可选**的来路：粘贴一条分享链接时，如果用户在设置里
 *   挑了一个静态图服务（默认是"不出图"），插件会**替用户去下载那一张图**、
 *   存进附件目录，然后照旧按本地图来处理。也就是说联网这件事只发生在
 *   "用户明确点了一下、并且自己开了这一档"的时候，卡片的渲染与导出依旧是纯离线的。
 * ★ 于是"没有图"不再等于"空框"：贴了链接但没出图时，卡上有坐标与链接可看、可点开
 *   （`sourceUrl` / `coords`），校验层因此不再把没图的地图卡整张丢掉。
 */
export interface MapContent {
  /** Vault 内相对路径：那张静态地图图。空串 = 还没有图（此时 `sourceUrl` / `coords` 必须有一个，否则整张丢掉） */
  path: string;
  /** 地点名（图钉旁边的标签 / 导出与搜索用）；空串 = 只画一个光点 */
  label: string;
  /** 图钉位置；`null` = 还没标位置 */
  pin: MapPin | null;
  /**
   * 从分享链接粘贴进来的**原文**（`O08`，可选）。没图时卡上显示的就是它。
   * ★ 留着原文而不是只留解析结果：解析认不出来（短链、新形态）时，
   *   用户看得见自己粘的是什么，也就知道该换成哪一条。
   */
  sourceUrl?: string;
  /** 从链接解析出的经纬度（`O08`，可选） */
  coords?: MapCoords;
}

/**
 * 11) syncNote —— 同步便签（`T7.04`）：**同一便签在多处显示**。
 *
 * ★ 「同步」在这里指**同一块白板内的同步组**：`key` 相同的若干张同步便签共享同一份
 *   正文，编辑其中任意一张会把正文写回**整组**（`cards/syncNote.ts` 提交时走
 *   `CardRenderContext.writeSyncGroup` → `BoardView` 一次写入改掉全组）。
 *   于是"把同一张便签摆在多个位置"不需要用户手动对齐内容，也不存在
 *   "改了其中一张、另一张还是旧的"。
 *
 * ★ 为什么**不是**指向 `.md` 的引用：那正是引用卡（`noteRef`）已经做的事
 *   （读真实笔记 + CAS 写回 + 监听外部修改）。同步便签解决的是另一件事 ——
 *   同一份内容在**一块板上**出现多次，且**不牵扯任何库文件**。
 *
 * ★ 为什么每张各存一份 `md`、而不是"一张存正文、其余存 id 去引用它"：
 *   各存一份之后，渲染、导出（PNG/SVG、`.canvas`、Markdown）、搜索都**只看单张卡**
 *   就够了 —— 它们全都不需要"按 id 去别的卡里取正文"这一步（那些导出函数的入口
 *   只拿到一张卡）。一致性由**唯一的写入路径**保证：任何一次编辑都写全组，
 *   所以落盘时同组各份天然相等。
 *
 * ★ `key` 为空串 = 还没加入任何同步组（等价于一张普通便签）。这样"刚新建、还没建
 *   副本"的那一张不会因为 `key` 为空就在重新打开时被丢掉，用户也不必先想清楚要
 *   复制到哪儿才能落笔。
 */
export interface SyncNoteContent {
  /** 同步组 id；空串 = 独立便签（不参与同步）。同组 = 同一个非空 `key` */
  key: string;
  /** 正文（Markdown）。同组内每一张各存一份，由写入路径保证始终一致 */
  md: string;
}

/**
 * 线程里的一条备注（`T7.05`）。
 *
 * ★ 时间戳存 **epoch 毫秒**（`at`）而不是格式化字符串：格式化随语言 / 时区变，
 *   存字符串会让同一份数据在两台机器上"看起来不一样"，也没法可靠排序 ——
 *   而"这条是什么时候写的"恰恰是评论卡比便签多出来的唯一信息。
 * ★ `id` 不是可有可无的：删条目要靠它定位（数组下标在一次删除之后就整体错位了）。
 */
export interface CommentEntry {
  /** 条目 id（`ID_PREFIX.comment` 前缀） */
  id: string;
  /** 正文（Markdown，单条） */
  text: string;
  /** 写下的时间（epoch 毫秒） */
  at: number;
}

/**
 * 12) comment —— 评论卡（`F2.9` / `T7.05`）：**本地备注线程**。
 *
 * ★ "本地"是这张卡的定义的一半：`01` 的能力对照表里"评论"那一格是「⚠️ 仅本地备注」
 *   （对方是"✅ 协作型"）。本插件零网络、无账号、无同步（`01 §4`），所以这里做的
 *   不是"给别人的卡留言"，而是**给自己留一条带时间线的备注**：把一件事挂在它发生的
 *   地方，几天后回来还能看出"什么时候写的、后来怎么变的"。
 *
 * ★ 为什么是"线程"（`entries` 数组）而不是一张便签：便签只表达"现在是什么"，
 *   线程天然表达"**先这样，后来改成那样**"。追加是唯一的写入语义
 *   （见 `cards/comment.ts`），所以时间顺序恒等于数组顺序 —— 不需要额外的排序字段，
 *   也不会出现"旧的在新的下面"。
 *
 * ★ 每条**各存一份 `text`**，不做"主贴 + 回复"的两层结构：一条备注就是一条，
 *   没有主贴与回复之分 —— 用户不会去想"我这条算回复还是算主贴"。
 */
export interface CommentContent {
  /** 线程；按 `at` 升序（旧的在上），落笔顺序即数组顺序 */
  entries: CommentEntry[];
  /**
   * 已解决：勾上之后卡面置灰 + 打一角标，**但一条都不删**。
   *
   * ★ 与待办卡的"完成"不同：那边是逐项勾选，这边是**整条线程**收口 ——
   *   一叠短备注要么还没完、要么已经落地，不必细到每一条。
   * ★ 之所以不把已解决的条目直接删掉：备注的价值一半在"当时为什么这么写"，
   *   删了就只剩结论。所以"解决"是**卸掉它的分量**，不是清空。
   */
  resolved: boolean;
}

/** `type` → `content` 的映射表：Card 联合类型由它生成 */
/**
 * 仅标题卡（`A3`，用户 2026-09-18；同日按反馈简化：**只保留纯圆角**）。
 *
 * ★ 那行字住在**卡片标题**里（`CardBase.title`，用户 2026-09-18："它现在直接展示的是
 *   内容文字，实际上应该是直接展示标题文字"）：这张卡没有"标题 + 正文"两段，那行字
 *   就是它的全部。放 `title` 上之后，「编辑标题」/ 属性面板的「标题」/ 导出那一行读的
 *   都是同一处。
 * ★ 曾经的 `shape` / `tail`（纯圆角 ⇄ 带气泡）已按用户要求**去掉**：
 *   这一版还没发出去，旧文件里残留的那两个键在读入口直接忽略。
 * ★ 底色、边框、字色都不在这里：底色与边框跟**卡片颜色**（`CardBase.color`）走，
 *   字色默认白、挑过才写进 `CardBase.titleStyle.ink`。—— 这一张的"样式"全在
 *   卡片级字段上。
 * ★ `text` 是**旧字段**（早期版本把同一句话存在这里）：读入口 `model/validate` 会把它
 *   搬进 `title` 并清空，新写出来的永远是空串 —— 留着这个键只是让旧文件读得回来。
 */
export interface TitleCardContent {
  text: string;
}

/**
 * 图集卡（`A4`，用户 2026-09-18："支持图集卡片 —— 可上传多张图片（会放到 ob 仓库下），
 * 以卡牌形式展示，有一定层叠效果、有一定动效；点击之后会切换"）。
 *
 * ★ `paths` 是**有序**的：卡面上摆的顺序就是用户拖进来的顺序（第一张是当前那张）。
 * ★ `index` = 现在看的是第几张，**缺省 = 0**（第一张）—— 与其它"默认档不写"的字段同一条：
 *   没翻过的图集卡，文件里只有 `paths` 一个键。
 */
export interface GalleryContent {
  paths: string[];
  index?: number;
}

export interface CardContentMap {
  note: NoteContent;
  noteRef: NoteRefContent;
  image: ImageContent;
  file: FileContent;
  /**
   * 视频卡（`A1`）：内容与文件卡**同一个形状**（就一个路径）。
   * ★ 复用 `FileContent` 而不是另立一个"只多不少"的接口：多一个名字，读写两边就多
   *   一处要同步的映射；而它的确就是"指向库内一份文件"这件事。
   * ★ `showSize` 在视频卡上不画（那是文件卡的第二行），但字段留着 —— 形状共用。
   */
  video: FileContent;
  /** 音频卡（`A2`）：同 `video` —— 内容就是一个路径，形状与文件卡共用 */
  audio: FileContent;
  /** 仅标题卡（`A3`）：一行字 + 两档样式（见上面的 `TitleCardContent`） */
  titleCard: TitleCardContent;
  /** 图集卡（`A4`）：一串图片路径 + 当前看的是第几张（见上面的 `GalleryContent`） */
  gallery: GalleryContent;
  link: LinkContent;
  todo: TodoContent;
  swatch: SwatchContent;
  boardRef: BoardRefContent;
  ink: InkContent;
  map: MapContent;
  syncNote: SyncNoteContent;
  comment: CommentContent;
  /**
   * PDF 预览卡（`F8`）：内容与文件卡**同一个形状**（一个路径）—— 与 `video` / `audio`
   * 同一条理由：它也就是"指向库内一份文件"这件事，多立一个名字只会多一处要同步的映射。
   * `showSize` 不画（卡面全给那页纸），字段留着是为了形状共用。
   */
  pdf: FileContent;
  /**
   * `.canvas` 预览卡（`F6`）：与 PDF 卡同一个形状（一个路径）——
   * 同样是"指向库内一份文件"，卡面拿来看那份文件长什么样。
   */
  canvas: FileContent;
  /**
   * 脑图卡（`F3a`）：还是"指向库内一份文件"（那份 `.nestmind`），所以内容与文件卡共用同一个
   * 形状 —— 与 `pdf` / `canvas` 同一条理由。`showSize` 不画（卡面全给那张脑图），字段留着
   * 是为了形状共用，不另立一个"只少不多"的接口。
   */
  mindRef: FileContent;
  /**
   * 内嵌脑图卡（`F4`）：**脑图模型就长在这张卡里**（不指向任何文件）。
   *
   * ★ 存的是**整份 `MindFile`**（`spec` / `version` / `revision` / `meta` / `view` / `rootId` /
   *   `nodes`）而不是"只留 nodes 的瘦身版"：与 `.nestmind` 的形状**逐字相同**，于是
   *   ① 渲染、校验、导出（`.nestmind` / Markdown / 大纲）全部现成可复用；
   *   ② 右键「导出为 `.nestmind`」就是一次序列化，不丢任何字段；
   *   ③ 卡片的复制粘贴天然带上整份脑图（`{ ...card, id }` 那种复制不会漏）。
   *   多出来的那几个键在文件里只占几十字节，换来的是"两个脑图卡共用同一套代码"。
   */
  mind: MindContent;
}

export type CardContent = CardContentMap[CardType];

// ─────────────────────────────────────────────────────────────
// 卡片（基础字段 + content）
// ─────────────────────────────────────────────────────────────

export interface CardBase<T extends CardType, C> {
  id: string;
  type: T;
  x: number;
  y: number;
  width: number;
  height: number;
  /**
   * 旋转角度（度，**顺时针为正**），归一化到 `(-180, 180]`；缺席 = `0` = 没转过
   * （T7.06 / `F2-00-10`）。
   *
   * ★ `x/y/width/height` **始终是没转过的那个框**（下称"布局框"）。旋转只是"画的
   *   时候绕**自己的中心**转一下"，一个字都不改这四个数。
   *
   *   反过来定义（把 `x/y/width/height` 当成"转完的外接框"）会让"转 45°"和
   *   "宽高各乘 √2"变成同一份数据，而这两件事在拖动、缩放、分栏重排、吸附里
   *   必须能分开谈：用户转一下卡片，绝不该看到它的宽度变成另一个数字。
   *   代价是"这张卡占了多大地方"要现算（`util/geometry.rotatedBoundsOf`）——
   *   导出取景、缩略图、框选各用一次，四行代码换掉一整类"转一下尺寸就变"的账不平。
   *
   * ★ 旋转中心 = 布局框的中心。于是**视觉上的中心**与布局框中心永远重合，
   *   连线锚点、演示取景、缩略图都能继续用 `rectCenter`，不需要另一套中心算法。
   *
   * ★ `undefined` 与 `0` 是同一个意思。落盘时 `0` 会被 `validate` 抹掉这个键，
   *   于是"没转过"的卡片在 `.nboard` 里**一个字节都不多**。
   */
  rotation?: number;
  /** 层级，越大越靠上 */
  z: number;
  /** 所属分栏；null = 直接在画布上 */
  columnId: string | null;
  /** 分栏内排序位（仅 `columnId` 非空时有效） */
  order: number;
  color: CardColor;
  /** 左侧强调色条；null = 无 */
  accent: HexColor | null;
  locked: boolean;
  showTitle: boolean;
  title: string;
  /**
   * 卡面标记（一个 emoji，`O38`）：画在**标题栏最前面**，一张卡最多一个。
   *
   * ★ 存的是 **emoji 字符本身**（与 `BoardRefContent.icon` 同一条纪律）：换主题、换版本、
   *   换机器看到的都是同一个表情；存"图标名"就得跟着图标库的版本走。
   * ★ 可选，**缺省 = 没有标记**（纪律 2：不补空串，旧文件一个字不动）。
   */
  icon?: string;
  /**
   * 标题栏的**整条格式**（`O38`）：粗 / 斜 / 下划线 / 字色。
   *
   * ★ 作用对象是**整条标题**，不是选区 —— 与脑图节点同一条口径（那里写着理由：
   *   局部富文本要把标题改成 run 模型，牵动就地输入 / 导出 / 搜索的每一处）。
   * ★ `ink` 是**字色**，与 `color`（标题底色）不是一回事：底色决定"这张卡是什么色系"，
   *   字色默认由底色的对比度推出来（保证读得清），只在用户显式挑过时才写它。
   */
  titleStyle?: CardTitleStyle;
  /**
   * 卡片是否**收起**（`O31`）：收起后只留标题那一行，内容槽不画。
   *
   * ★ 可选，**缺省 = 展开**（文件里看不见这个键就是展开）—— 与 `rotation` 同一条约定：
   *   新字段不写进旧文件，读写两边都不需要迁移；只有用户真的收起过才写 `true`。
   * ★ 它属于**显示状态**、跟着文件走（重开白板仍保持收起），与 `showTitle` 同类。
   */
  collapsed?: boolean;
  /**
   * **树折叠**（`F7`）：把这张卡的**子级**收成「+N」（不是完全隐藏）。
   *
   * ★ 与 {@link Column.collapsed} / 编组的 `collapsed` 一样是"缺席 = 展开"的可选键；
   * ★ **不复用卡片自己的 `collapsed`**（定稿原文）：「收起自己」（标题行那个三角，
   *   卡片变矮）与「折叠子级」（子级藏起来、卡上出现 +N）是两件事，
   *   两个状态要能同时存在、互相独立 —— 挤进同一个字段的话，
   *   "收起自己顺带折叠子级"这种没人要的联动就写不开了。
   */
  treeCollapsed?: boolean;
  /**
   * 卡片是否**画边框与底色**（图片卡右键菜单里那一项，用户 2026-09-17）。
   *
   * ★ 可选，**缺省 = 有边框**（文件里看不见这个键就是"照常画"）—— 与 `collapsed` /
   *   `rotation` 同一条约定：新字段不写进旧文件，只有用户真的**关掉过**才写 `false`。
   * ★ 关掉之后只留内容本身（图片卡就是一张干干净净的照片），所以它同时收掉背景与阴影。
   */
  showBorder?: boolean;
  /**
   * 演示顺序（J-06 / J-07）：数值越小越先聚焦，`1` 是第一步；`null` = 不在演示路径中。
   *
   * ★ 挂在**卡片**上而不是 `board.presentation` 里：演示顺序是"这张卡的一个属性"，
   *   卡片被删时它跟着消失，不需要任何额外清理（`removeCards` 天然兜住）。
   *   集中的步骤表一旦与卡片列表脱钩，就会出现"某一步指向一张不存在的卡"。
   * ★ 没有"已排序 / 未排序"之外的状态：顺序编辑 = 改这几个数字
   *   （全部规则见 `model/presentation.ts`）。
   */
  presentStep: number | null;
  content: C;
}

/**
 * 标题栏的整条格式（`O38`）。
 *
 * ★ 字段**缺席 = 用缺省**（纪律 2）：`bold` 的缺省由样式表决定（标题本来是半粗的），
 *   所以"关掉加粗"要写成 `bold: false`；`italic` / `underline` / `ink` 的缺省是
 *   明确的"无"，所以它们**只在为真时才写** —— 同一份文件读一遍写回去必须逐字节不变。
 */
export interface CardTitleStyle {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  /** 标题字色（HEX）；缺席 = 按标题底色的对比度推 */
  ink?: HexColor;
}

export type CardOf<T extends CardType> = CardBase<T, CardContentMap[T]>;

/** 判别联合：`switch (card.type)` 能正确收窄 `card.content` */
export type Card = { [K in CardType]: CardOf<K> }[CardType];

export type CardContentOf<T extends CardType> = CardContentMap[T];

// ─────────────────────────────────────────────────────────────
// 分栏 / 连线 / 编组
// ─────────────────────────────────────────────────────────────

/**
 * 分栏。**约定：分栏不嵌套分栏** —— 数据类型上不提供 `parentColumnId`，
 * 从模型层杜绝非法状态（03 §2.6 / T1.60）。
 */
export interface Column {
  id: string;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  collapsed: boolean;
  color: CardColor;
  z: number;
}

/** `top|right|bottom|left`；null = 自动选边（按两端当前几何算，卡片换边时线会自己翻面） */
export type EdgeSide = 'top' | 'right' | 'bottom' | 'left' | null;

/**
 * 连线端点。
 *
 * `cardId` 是空串 = **自由端**（T2.07 / `F3-02`）：端点不跟任何卡片走，停在
 * `point` 这个画布坐标上。于是"从卡片拉一条线指到空地做标注"成为可能。
 *
 * ★ `cardId` 存的其实是一个**端点身份**（`O21` 起）：卡片 id，或者**分栏 id** ——
 *   两者共用一个 id 空间（`factories` 里 `ID_PREFIX.card` / `ID_PREFIX.column`
 *   前缀不同，天然不撞），而且在几何上是同一件事（都是"拿一个矩形去取锚点"）。
 *   于是不必新增 `kind` 字段，老文件照读照写。
 *   （字段名仍叫 `cardId`：改名等于让所有老 `.nboard` 都必须先迁移。）
 * ★ 用"空串 + 可选 `point`"而不是可辨识联合（`{ kind: 'card' | 'free' }`）：
 *   现有 `.nboard` 文件里全是 `{ cardId, side }`，改成联合类型会让**所有老文件
 *   都必须先迁移**才能读。空串在旧数据里从不出现，天生就是个闲置的值。
 * ★ `point` 只在 `cardId` 为空时参与几何计算；卡片端点上允许留着它 ——
 *   "把端点拖离卡片、又拖回来"时可以直接复用，不必重新算一次落点。
 */
export interface EdgeEndpoint {
  /** 绑定的端点 id：卡片 id、分栏 id（`O21`）或**脑图 id**（`2.2.0`）；空串 = 自由端（见上） */
  cardId: string;
  side: EdgeSide;
  /** 自由端的世界坐标。`cardId` 非空时无意义 */
  point?: Point;
  /**
   * **脑图里的某一个节点**（`2.2.0` 批 3）—— 缺席 = 整张卡片 / 分栏 / 整棵脑图。
   *
   * ★ 为什么是"`cardId` 定位哪棵脑图 + `nodeId` 定位里面的哪个节点"两个字段，
   *   而不是把节点 id 塞进 `cardId`：`cardId` 已经是"白板级对象"的位置
   *   （卡片 / 分栏 / 脑图，三者共用），节点**属于**其中一个对象 ——
   *   两个字段各说各的一层，任何一层都能单独取用（`removeMinds` 按 `cardId` 扫一遍
   *   就把整棵树的线清干净，不必知道节点 id 长什么样）。
   * ★ 端点的**身份键**（几何表用它查矩形）由 {@link endpointAnchorKey} 给，
   *   那边把两层拼成一个字符串 —— 表只有一层，不必为节点再造一张。
   * ★ 存量文件里没有这个键 ⇒ 读出来就是"整张卡片"，逐字节不变（与 `rotation` /
   *   `alpha` 同一条纪律）。
   * ★ **读盘时不校验它**（`validate`）：节点清单在另一份模型里，而 `.nboard`
   *   打开的那一刻那份 `.nestmind` 可能还没读到 —— 那一刻判"悬空"会把好数据删掉。
   *   取不到节点的矩形就**不画那条线**（`edgeEndpoints` 返回 `null`），
   *   节点回来的时候线自己就回来了。
   */
  nodeId?: string;
}

/** 端点是不是自由端（不绑任何卡片/分栏） */
export function isFreeEndpoint(endpoint: EdgeEndpoint): boolean {
  return endpoint.cardId.length === 0;
}

/**
 * 节点端点的**身份键**分隔符。
 *
 * ★ 可以放心用 `/` 拼：卡片 / 分栏 / 脑图 / 节点的 id 都由 `util/id` 生成
 *   （`c_…` / `col_…` / `nm_…` / `n_…`，Base32 字母表里没有 `/`）。
 * ★ 这个键**只活在内存里**（几何表 / 手势会话），不落盘 —— 文件里永远是
 *   两个字段（`cardId` + `nodeId`），老插件读不懂时最多"看不见那条线"，
 *   不会因为多了个拼接串而写坏。
 */
const NODE_KEY_SEPARATOR = '/';

/** 由"哪棵脑图 + 哪个节点"拼出端点身份键（几何表按它查矩形） */
export function nodeEndpointKey(mindId: string, nodeId: string): string {
  return `${mindId}${NODE_KEY_SEPARATOR}${nodeId}`;
}

/** 把端点身份键拆回两层；`nodeId` 为 `null` = 这不是一个节点端点 */
export function splitEndpointKey(key: string): { cardId: string; nodeId: string | null } {
  const index = key.indexOf(NODE_KEY_SEPARATOR);
  if (index < 0) return { cardId: key, nodeId: null };
  return { cardId: key.slice(0, index), nodeId: key.slice(index + 1) };
}

/**
 * 一个端点在**几何表**里的键（{@link RectLookup} 用它查矩形）。
 *
 * ★ 卡片 / 分栏 / 整棵脑图 ⇒ 就是 `cardId`（与从前一字不差，`O21` 的那些表不用改）；
 *   节点端点 ⇒ `脑图id/节点id`。
 * ★ 一处定义、两处使用（绘制侧的 `createRectLookup` 与命中侧的 `cardRectLookup`
 *   都往表里塞同一个键）：分头拼的话，"线画在节点上、点下去选不中"会以两种
 *   不同的形式冒出来。
 */
export function endpointAnchorKey(endpoint: EdgeEndpoint): string {
  return endpoint.nodeId ? nodeEndpointKey(endpoint.cardId, endpoint.nodeId) : endpoint.cardId;
}

/** 端点身份键 → 端点（`side` 由调用方给：起点用按下的那一面，终点一律自动选边） */
export function endpointOfKey(key: string, side: EdgeSide): EdgeEndpoint {
  const { cardId, nodeId } = splitEndpointKey(key);
  return nodeId === null ? { cardId, side } : { cardId, nodeId, side };
}

export type EdgeEnd = 'none' | 'arrow';
export type EdgeStyle = 'solid' | 'dashed';
/**
 * 走线方式。
 *
 * * `free` —— 直连（两端锚点一条直线，手工拖过中点就是弧线）；
 * * `smart` —— 智能绕开（正交折线，躲开中间挡路的卡片）；
 * * `curve` —— **曲线**（自动一条二次 Bezier 弧；手工拖过中点仍然可以改它的弯法）。
 */
export type EdgeRouting = 'free' | 'smart' | 'curve';

/**
 * Free 连线的弧度（T7.12 / `F3-07`）。
 *
 * 存的是**控制点相对两端中点的偏移**，两个分量都按**线段长度归一化**：
 *  * `along` —— 沿"起点 → 终点"方向；
 *  * `perp`  —— 垂直方向（正负就是线的哪一侧）。
 *
 * ★ 为什么不存**世界坐标**的控制点：卡片挪一下，世界坐标的弯就成了"线被拉长、
 *   弯还钉在原处"—— 一条斜着甩出去的怪线。按线段归一化之后，两端怎么动，
 *   这个弯都保持自己的**形状**（相对长度与相对方向），这才是"这条线是弯的"该有的语义。
 * ★ 归一化还顺带解决了缩放：视图缩放不影响世界坐标下的线段长度，所以与缩放无关。
 * ★ 两个分量都是 `0` 时**等于直线** —— 这种值一律归一化成"没有弧度"（不写键），
 *   否则文件里会积一堆 `{ along: 0, perp: 0 }` 这种"看着有弧度其实没有"的噪声。
 * ★ 与 `style` / `routing` 同一个待遇：JSON Canvas 规范里没有它，导出时按
 *   "必须被说出来的损失"记一笔（`export/jsonCanvas.ts`）。
 */
export interface EdgeCurve {
  along: number;
  perp: number;
}

/** 端点形状与 JSON Canvas 的 `fromEnd` / `toEnd` 语义完全一致，便于无损互转 */
export interface Edge {
  id: string;
  from: EdgeEndpoint;
  to: EdgeEndpoint;
  fromEnd: EdgeEnd;
  toEnd: EdgeEnd;
  style: EdgeStyle;
  color: CardColor;
  label: string;
  routing: EdgeRouting;
  /**
   * 弧度（T7.12）。**缺席 = 直线** —— 存量文件里没有这个键，读出来就是直线，
   * 所以加这个字段不需要动 `BOARD_VERSION`（与 `rotation` / `alpha` 同一条纪律）。
   *
   * ★ 在 `free` / `curve` 下有意义，`smart` 下没有：智能绕行的弯法由路由器决定，
   *   弯到哪儿去是算出来的，不是用户拖出来的（两者同时存在时以路由为准）。
   *   `curve` 档下它**覆盖自动的那条弧**（拖过中点就听手工的）。
   */
  curve?: EdgeCurve | null;
  /**
   * **树连线**（`F7`，设计定稿 `11 §3` D1 / D6）。缺席 = 普通连线 —— 两套并存、
   * 互不"升级"（定稿原文），所以这是一个可选标记而不是一条新记录类型。
   *
   * ★ 与 `curve` 同一条纪律：存量文件里没有这个键，读一遍写回去逐字节不变，
   *   不需要动 `BOARD_VERSION`。
   * ★ 树连线的几何与普通线**不同源**：两端锚在**卡片中心**（不是四边），
   *   中段被卡片自己盖住 ⇒ "不与卡片重叠的部分才显示"由层级关系白捡
   *   （连线层在卡片层背后，`02 §2` 层级③），几何侧只负责"从中心到中心"。
   *   锚点解析见 `edges.edgeEndpoints` 里 `kind === 'tree'` 那一支。
   * ★ 方向：`from` = **父级**，`to` = **子级**（发起方成为父级，D6）。
   *   箭头（`toEnd`）因此指向下级，与"从父到子"的读法一致。
   */
  kind?: 'tree';
}

/** 编组只存成员列表，包围盒由成员位置实时计算（避免两者不同步，03 §2.9） */
export interface Group {
  id: string;
  cardIds: string[];
  /**
   * 编组里的**分栏**成员（用户 2026-09-16）："分栏也像卡片一样被编进组里"。
   *
   * ★ 编组对它是**只读**的：栏**不消失**、栏里的卡片**一张都不动**（不从栏里摘出来）。
   *   这正是它与「整栏转编组」（`O04`）的分界 —— 那个是把栏**换掉**（卡片退出、栏消失），
   *   这个是把栏**编进去**（原样留着，只是多了一层"它们是一伙的"）。
   * ★ 缺席 = 这个组只有卡片成员（纪律 2：不补空数组，存量文件逐字节不变）。
   */
  columnIds?: string[];
  label: string;
  /**
   * 收起（O03）。**缺席 = 展开** —— 与 `rotation` / `alpha` / `curve` 同一条纪律：
   * 存量文件读一遍写回去必须逐字节不变，所以规范化**不在缺席时补 `false`**，
   * 只在真的收起时写 `true`。
   *
   * ★ 语义：收起是把成员**藏起来**，不是把它们删掉或挪走 ——
   *   展开后每张卡必须回到原来的位置（成员几何一个字段都没动，这也正是
   *   "包围盒由成员位置实时计算"那条设计顺带给的好处）。
   * ★ 与 `Column.collapsed` 是两套：分栏收起是"这一栏先不看了"（栏自己还在，
   *   有标题条和滚动位置），编组收起是"这一堆先不看了"（没有栏，只有个标签）。
   */
  collapsed?: boolean;
}

// ─────────────────────────────────────────────────────────────
// 白板文件
// ─────────────────────────────────────────────────────────────

export interface BoardMeta {
  /** 稳定 ID：跨重命名不变（快照 / 嵌套关系 / URI 都靠它） */
  id: string;
  title: string;
  /** Lucide 图标名；null = 无 */
  icon: string | null;
  createdAt: string;
  updatedAt: string;
  /** 父白板路径；null = 顶层白板 */
  parent: string | null;
  tags: string[];
  aliases: string[];
}

export type BoardBackground = 'plain' | 'dots' | 'grid' | 'none';

/**
 * 背景取值清单（T3.25 / `F11-04`）。
 *
 * ★ 必须在**类型旁边**给出一份运行时的数组：设置面板要拿它生成下拉、
 *   `normalizeSettings` 要拿它校验从 `.data.json` 读进来的字符串。
 *   只写 `type` 的话这两处都只能各自手抄一遍，抄漏一次就多一个"设置项点不动"的 bug。
 */
export const BOARD_BACKGROUNDS: readonly BoardBackground[] = ['plain', 'dots', 'grid', 'none'];

/** 视口是**界面状态**而非内容：只改视口**不递增** `revision`（03 §2.4 / W3） */
export interface BoardViewState {
  x: number;
  y: number;
  zoom: number;
  background: BoardBackground;
}

export interface BoardSettings {
  snapToGrid: boolean;
  gridSize: number;
  defaultCardColor: CardColor;
  /** 只读锁定（防误编辑，用于归档的板） */
  readOnly: boolean;
}

export interface BoardFile {
  spec: string;
  version: number;
  /** 单调递增修订号，用于冲突检测 */
  revision: number;
  meta: BoardMeta;
  view: BoardViewState;
  settings: BoardSettings;
  columns: Column[];
  cards: Card[];
  edges: Edge[];
  groups: Group[];
  /**
   * 脑图（`2.2.0`）：**一棵画在白板上的树**，与卡片 / 分栏 / 编组平级的白板对象。
   *
   * ★ 为什么它必须是白板对象而不是"某种卡片"（`12-2.2.0...重构方案`）：
   *   脑图的节点位置是**算出来的**（`layout/tree.ts`），而卡片的 `x/y/width/height` 是
   *   **用户数据** —— 把节点做成卡片，就得每次结构变化都把 N 个坐标写回模型（历史噪声、
   *   体积、多设备冲突）。所以这里只存**一个锚点**（根节点中心）与模型，其余全算。
   * ★ **可选键**（缺席 = 这块板没有脑图）：与 `rotation` / `alpha` / `curve` 同一条纪律 ——
   *   没有脑图的板子读一遍写回去必须**逐字节不变**（也因此老版本插件读它、写它都不丢东西）。
   */
  minds?: Mind[];
}

/**
 * 一块白板上的**一棵脑图**（`2.2.0`）。
 *
 * | 字段 | 说什么 |
 * | --- | --- |
 * | `x` / `y` | **根节点中心**的世界坐标。其它节点的位置由 `layout/` 算，**不落盘** |
 * | `z` | 与卡片 / 分栏共用的层序（它和卡片混排，不再是"整棵一个层级"） |
 * | `path` | 非空 = 这份脑图存在那个 `.nestmind` 里；空 = **内嵌**（模型在 `mind` 里） |
 * | `mind` | 内嵌模型。`path` 非空时不需要它（模型在文件里） |
 *
 * ★ **没有 `width` / `height`**：这是"无边界"在数据上的落实 —— 它没有边界，
 *   所以没有任何尺寸可以缩、可以撑、可以算错（`F4` 那两轮"节点越加越小 / 卡片跟着长"
 *   都是在跟一个不必要的尺寸字段较劲）。
 * ★ 只增不减那套自动尺寸（`requestCardSize`）与它无关：容器不进那张队列。
 */
export interface Mind {
  id: string;
  x: number;
  y: number;
  z: number;
  path: string;
  mind?: MindFile;
  /**
   * 演示步骤号（`2.2.0` 收尾 · 演示对接）：与卡片同一个口径 ——
   * 设过就按号升序讲，"一张都没编过"时按阅读顺序讲全部。
   *
   * ★ 可选键、**缺省 = 不在演示路径里**（存量文件里没有它，读一遍写回去逐字节不变，
   *   与 `Mind.path` 后面那些可选字段同一条纪律）。
   */
  presentStep?: number | null;
  /** 只读（缺席 = 可编辑）。与卡片的 `locked` 同一套语义：一个编辑手势都不接 */
  locked?: boolean;
}

/**
 * 按类型收窄卡片：`switch (card.type)` 或 `card.type === 'noteRef'` 直接可用，
 * 无需额外的类型谓词函数（TS 对判别联合原生支持）。
 */
export type CardOfType<T extends CardType> = Extract<Card, { type: T }>;
