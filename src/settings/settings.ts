/**
 * 插件设置（T1.74 / `F11-01`、`F11-05`、`F11-06`、`F11-10`、`F11-12`；
 * T3.23–T3.25 补 `F11-03`、`F11-04`、`F11-13`）。
 *
 * ★ 纯数据 + 纯函数，**零 Obsidian 依赖**：这样 `.data.json` 里的各种脏数据
 *   都能在 node 下直接喂进来测，而不必启动 Obsidian。
 *
 * ★ `normalizeSettings` 是脏数据的第一道闸，而且**必须有**：
 *   `.data.json` 是用户能拿编辑器直接改的普通文件，也可能是几个版本前写下的。
 *   放一个 `"abc"` 进 `autosaveDebounceMs` 一路走到 `setTimeout`，表现是
 *   "自动保存再也不触发" —— 而用户绝不会想到这跟设置文件有关。
 *   所以每个字段进门都要过一遍类型与范围，宁可回落到默认值。
 */

import {
  DEFAULT_AUTOSAVE_DEBOUNCE_MS,
  DEFAULT_BOARD_FOLDER,
  DEFAULT_HOME_BOARD_PATH,
  DEFAULT_INDEX_NOTE_FOLDER,
  DEFAULT_TEMPLATE_FOLDER,
} from '../constants';
import { BOARD_BACKGROUNDS } from '../model/schema';
import type { BoardBackground, CardColor } from '../model/schema';
import { normalizeBoardPath } from '../util/boardPath';
import { normalizeLinkBlocklist } from '../util/linkPreview';
import { MAP_TILE_PROVIDERS } from '../util/mapUrl';
import type { MapTileProvider } from '../util/mapUrl';
import { LANGUAGE_CHOICES } from '../util/i18n';
import type { LanguagePreference, MessageKey } from '../util/i18n';
import { normalizeRecentBoards } from './recentBoards';

/** 附件放哪儿（`F11-06`）：跟随 Obsidian 自己的附件设置，还是用插件里指定的目录 */
export type AttachmentLocation = 'vault' | 'custom';

/**
 * 附件怎么命名（`F11-06`）。
 *
 * ★ 默认 `timestamp`：系统截图与拖入文件叫 `image.png` 是常态，一个库里出现十几张
 *   同名图，不带时间戳就只能靠"顺延成 image 2.png"区分，用户根本认不出哪张是哪张。
 */
export type AttachmentNaming = 'timestamp' | 'original';

/**
 * 快照放哪儿（`F11-11` / 03 §1.4）。
 *
 * ★ `'plugin'` 默认：不污染用户的 Vault、不会被 Obsidian 索引、不会被搜索命中。
 *   `'vault'` 是给用 Git / Obsidian Sync 的人 —— 那个目录（`.nestboard-history/`）
 *   会被同步带走，于是"换台电脑也能回滚"才成立。
 */
export type SnapshotLocation = 'plugin' | 'vault';

export interface NestboardSettings {
  /** 新白板默认目录（`F11-05`）。`''` = 库根目录 */
  newBoardFolder: string;
  /**
   * 用户模板目录（T4.14 / `F7-06`）：`Templates`。「另存为模板」往这里写。
   *
   * ★ 与 `newBoardFolder` 分开：模板是"拿来用的原料"，白板是"正在做的事"。
   *   合在一起的话，每新建一块板都要在 `Boards/` 里跟一沓模板文件抢视线。
   * ★ `''` 是**合法值**（= 库根），但它有个副作用要留意：模板扫描只认这个目录**之下**的
   *   文件，`''` 时 `isTemplatePath` 会**拒绝所有**路径 —— "全库都是模板"不是任何人想要的。
   */
  templateFolder: string;
  attachmentLocation: AttachmentLocation;
  /** 仅 `attachmentLocation === 'custom'` 时生效；`''` = 库根目录 */
  customAttachmentFolder: string;
  attachmentNaming: AttachmentNaming;
  /**
   * 附件内容去重（T6.05 / `F2-3-10` / `F9-03`）：相同内容只存一份。
   *
   * ★ 默认 `false`，而且**不该**轻易改成 `true` 之外的默认值：同一次会话里把同一个
   *   文件拖两次常常是用户**明确的重复动作**，"第二次"可能是想放在别处、想改个名字。
   *   静默合并成一份会让人以为"第二次没生效" —— 这种困惑比多存一份贵得多。
   * ★ 打开后按 SHA-256 **内容**判重（不是文件名），且只在**同一次会话**内生效
   *   （跨会话复用需要落盘索引，见 `AttachmentManager.dedupeIndex`）。
   * ★ 与 `minimap` / `enableIndexNote` 同一条规矩：判定写成 `=== true`，旧数据文件里
   *   缺这个字段时升级后**不会**悄悄改变行为。
   */
  attachmentDedupe: boolean;
  /** 自动保存防抖（ms，`F11-10`） */
  autosaveDebounceMs: number;
  /**
   * 允许抓取网页预览（T2.05 / `F2-4-3` / `F11-07`）。
   *
   * ★ `O20` 起默认 `true`，判定写成 `!== false`。**授权点从来不是这个开关，
   *   而是用户那一次点击**（卡片上的「获取预览」/ 右键菜单）—— 这个开关只决定
   *   "点下去算不算数"。默认关着的日子里，新用户看到的是一个点了没反应的按钮，
   *   那不是隐私保护，那是一处看起来坏掉的功能。
   * ★ 但**保留显式关闭**，而且旧数据文件里已经写着 `false` 的用户升级后**保持关闭**：
   *   改默认值是一回事，改写用户已经表达过的意思（他当初真的点过关）是另一回事。
   * ★ 联网仍然**只**发生在用户动手之后：渲染、导出、翻遍整块板都不会调 `fetch`
   *   （见 `LinkPreviewBridge` 与 `cards/link.ts`），所以这个默认值改动的暴露面
   *   是"新用户的第一张链接卡能直接用"，不是"开板就联网"。
   */
  linkPreview: boolean;
  /**
   * 地图卡的**静态图服务**（`O08`）。`'none'` = 不出图（默认）。
   *
   * ★ 这是第二个联网旋钮，默认同样是关。它的语义比 `linkPreview` 窄得多：
   *   只有用户对着地图卡点「粘贴地图链接」时才会用一次 —— 渲染、导出、
   *   翻遍整块板都不会触发它（见 `MapTileBridge`）。
   * ★ 为什么给四档而不是一个布尔：能出图的服务商**互相不通**。Google 静态图在国内
   *   连不上、高德在境外用不了、OSM 的社区服务没有 SLA。与其替用户挑一个然后
   *   在某个网络环境下默默失败，不如把选择摆出来，默认那一档是"什么都不做"。
   * ★ `'osm'` 那一档不需要 key（用的是社区公共静态图服务），另外两档必须填 ——
   *   缺 key 时 `MapTileBridge.enabled` 为假，卡片会明说"还没配好"。
   */
  mapTileProvider: MapTileProvider;
  /** 静态图服务的 API key（`'osm'` 那一档忽略它）。空串 = 还没填 */
  mapTileKey: string;
  /**
   * 链接抓取的**域名黑名单**（T6.06 / `F2-4-6`）。空数组 = 不拦任何站。
   *
   * ★ 与总开关是**两个正交的旋钮**：总开关管"要不要联网"，黑名单管"哪些站不碰"。
   *   把它们合成一个（比如"只在黑名单外的站联网"）会让"临时想看一个被拦的站"变成
   *   改总开关，而不是把那一条删掉。
   * ★ 存进来的是**归一化后的域名**（小写、无 `www.`、无路径 / 端口 / 子域前缀，
   *   见 `normalizeLinkBlocklist`）—— 用户在输入框里粘一整条带参数的链接，
   *   落盘的是干净的域名，不留 `?utm_source=…` 那种尾巴。
   * ★ 匹配是**站点级**的：`bilibili.com` 同时拦 `m.bilibili.com`（见 `isHostBlocked`）。
   */
  linkPreviewBlocklist: string[];
  /**
   * 界面语言（T3.23 / `F11-13`）。`'auto'` = 跟随 Obsidian。
   * 真正生效的语言在 `util/i18n.ts` 的 `setLocale` 里解析（本文件只存偏好）。
   */
  language: LanguagePreference;
  /**
   * 新建卡片的默认颜色（T3.24 / `F11-03`）。
   *
   * ★ 只作用于**之后新建**的卡片，已有卡片一个都不动 —— "我改了个默认值，
   *   一屏卡全变色了"是不可接受的。同理这个值也**不写进白板文件**：
   *   它是"这个人的偏好"，不是"这块板的样子"。
   */
  defaultCardColor: CardColor;
  /** 卡片圆角（px，T3.24）。`0` = 直角 */
  cardCornerRadius: number;
  /** 卡片正文基础字号（px，T3.24） */
  cardFontSize: number;
  /** 卡片正文字体（CSS `font-family`，T3.24）。`''` = 跟随主题 */
  cardFontFamily: string;
  /**
   * **卡片外观档**（`F2` / `11 §6`）。
   *
   * * `classic` —— 2.1.3 那套（边框 + 单层阴影）。**默认，也是回归基线**：
   *   不切档时观感与 2.1.3 逐像素一致。
   * * `neumorph` —— 拟物档：保留卡片主色（§6 的 13a 选了 b），只借"双阴影 + 内阴影 + 无边框"
   *   的光影；额外参数与作用面见 `§6` 的 13a–13j。
   *
   * ★ 与 `cardCornerRadius` 同类：**全局一份偏好**，不写进白板文件 ——
   *   "我要不要拟物"是这个人对界面的口味，不是某块板的样子。
   * ★ 深色主题下**同样生效**（13c 选了 a：参数另调，而不是回落原版），
   *   所以这里没有"跟随主题"那一档（13j 选了 a：就两档）。
   */
  cardStyle: CardStyleMode;
  /**
   * 新建白板的默认背景（T3.25 / `F11-04`）。
   *
   * ★ 与 `defaultCardColor` 同一条规矩：写进**新文件**的 `view.background`，
   *   已经存在的白板保持自己的背景不变。
   */
  defaultBackground: BoardBackground;
  /**
   * 是否启用版本快照（T4.01 / `F11-11`）。
   *
   * ★ 默认 `true`，而且判定写成 `!== false`：这是"误删一屏卡片两小时后才发现"时
   *   唯一能救命的东西（风险表 R5），纯本地、无副作用。与 `minimap` / `enableIndexNote`
   *   的 `=== true`（占画布 / 改库要显式点头）刚好相反 —— 两个方向都是刻意的。
   *   （`O20` 起 `linkPreview` 也改成了 `!== false`，但它走的是第三条理由：
   *   那个开关不改变任何已有行为，只决定用户点下去算不算数。）
   */
  snapshotEnabled: boolean;
  /** 快照位置（03 §1.4）。切换不会搬走已有快照，只影响之后新拍的 */
  snapshotLocation: SnapshotLocation;
  /**
   * 是否显示缩略图导航器（T5.09 / `F1-06`）。
   *
   * ★ 默认 `false`：它是一块**常驻浮层**，占着画布右下角 —— 这件事该由用户点头，
   *   而不是替所有人决定（判定写成 `=== true`，与联网开关同一条规矩）。
   * ★ 它是**一块板一个开关**的那个开关：命令「切换缩略图导航器」、面板上的 `×`、
   *   设置面板里这一项，三个入口改的都是它（不放进视图临时状态 —— 那样"打开了
   *   下次又没了"）。
   */
  minimap: boolean;
  /**
   * Home 白板路径（T5.07 / `F7-03` / `F11-09`）。
   *
   * Home 是"**这块板放在手边**"的那一块：打开它不必先想清楚要去哪，往里丢东西
   * 也不必先挑目标 —— 它自带一栏 `Unsorted` 收件箱，是「添加到收件箱」的落点。
   *
   * ★ `''` 是**合法值**，表示"关掉 Home"（命令会提示未配置，而不是弹一个新建对话框）。
   *   这一条必须在 `normalizeHomeBoardPath` 里显式照顾到：如果把空串当"坏数据"
   *   回落成默认值，用户在设置里**永远清不掉**这个输入框 —— 一删就自己长回来。
   */
  homeBoardPath: string;
  /**
   * 「最近打开」的白板路径（T5.08 / `F7-04`）：新的在前，最多 `RECENT_BOARDS_LIMIT` 条。
   *
   * ★ 这是整份设置里**唯一一个由插件自己写、用户不该手动改**的字段（其余都是用户偏好）。
   *   它落在这里而不是另开一个文件：Obsidian 只给插件一份 `data.json`，另存一份就得
   *   自己管读写、迁移、以及和 Obsidian Sync 的冲突 —— 为 20 条路径不值当。
   * ★ 它**只是历史，不是真相**：列表里的路径可能早被改名或删掉了，所以侧栏渲染时
   *   必须逐条回 `BoardRegistry` 里核对（见 `ui/boardList.ts` 的 `recentBoards()`）——
   *   照单全收的话，"最近打开"里会出现一堆点开就报"文件不存在"的行。
   */
  recentBoards: string[];
  /**
   * 为每块白板维护一份索引笔记（T7.01 / `F10-09` / `F7-09`）。
   *
   * ★ 默认 `false`，判定写成 `=== true`：打开它会在**用户的库里生成一堆 .md 文件**，
   *   这些文件会出现在大纲、搜索、图谱与 Dataview 里 —— 这是一个**看得见**的改变。
   *   与 `minimap` 同一条规矩：改变库的可见状态，必须由用户点头。
   *   与 `attachmentDedupe` 也同一条：默认打开会"改变已有行为"，而用户不会预期到。
   *
   * ★ 关闭**不删**已生成的笔记（只停止维护）：用户可能已经把反链、查询挂在这些文件上，
   *   替他删掉就是替他做了一次不可预期的破坏。想清干净有专门一条命令（进回收站）。
   */
  enableIndexNote: boolean;
  /**
   * 索引笔记目录（`''` = 库根）。
   *
   * ★ 与 `newBoardFolder` 一样是**幂等**的路径设置：里面镜像白板在库内的层级，
   *   所以两块同名白板（`A/周报.nboard` 与 `B/周报.nboard`）不会互相覆盖
   *   （映射规则见 `model/indexNote.ts` 的 `indexNotePathOf`）。
   *
   * ★ 改这个值**不搬**已有笔记，但会触发一次迁移（新目录写一份、旧目录那份进回收站）——
   *   见 `IndexNoteBridge.relocate`。不这么做的话，用户改完目录会看到两份一模一样的
   *   索引笔记，而图谱里同一条边出现两次。
   */
  indexNoteFolder: string;
  /**
   * 图片卡**始终使用原图**（`A5`，用户 2026-09-18："图片卡清晰度应该保持原图清晰度"）。
   *
   * ★ 默认**开**：图片糊是"一眼就看见"的问题，而显存是"看不见"的问题 ——
   *   用户的诉求是前者，默认值就站在他那边（觉得大板子卡的，可以在设置里关掉）。
   * ★ 关掉之后回到**自动判定**（`shouldUseFullImage`：屏幕上要画的设备像素 > 缩略图边长
   *   才用原图）—— 那条判据本身就带 `devicePixelRatio`，所以关掉也不等于"一定会糊"。
   */
  alwaysFullImage: boolean;
}

/**
 * 卡片外观档（`F2`）。
 *
 * ★ 只两档、且**默认 `classic`**：旧数据文件里没有这个字段 ⇒ 升级后观感一个字都不变
 *   （`§7` 的回归基线正是"原版档与 2.1.3 逐像素一致"）。
 */
export type CardStyleMode = 'classic' | 'neumorph';

/** 与旧版 `--nestboard-radius-lg` 的兜底值（`--radius-m` 的 10px）保持一致，升级不改变观感 */
export const DEFAULT_CARD_CORNER_RADIUS = 10;
/** 与 `.nestboard-card` 原本继承的 `--font-ui-small`（≈13px）最接近的整数值 */
export const DEFAULT_CARD_FONT_SIZE = 13;

export const DEFAULT_SETTINGS: NestboardSettings = {
  newBoardFolder: DEFAULT_BOARD_FOLDER,
  templateFolder: DEFAULT_TEMPLATE_FOLDER,
  attachmentLocation: 'vault',
  customAttachmentFolder: '',
  attachmentNaming: 'timestamp',
  attachmentDedupe: false,
  autosaveDebounceMs: DEFAULT_AUTOSAVE_DEBOUNCE_MS,
  linkPreview: true,
  linkPreviewBlocklist: [],
  mapTileProvider: 'none',
  mapTileKey: '',
  language: 'auto',
  defaultCardColor: '1',
  cardCornerRadius: DEFAULT_CARD_CORNER_RADIUS,
  cardFontSize: DEFAULT_CARD_FONT_SIZE,
  cardFontFamily: '',
  cardStyle: 'classic',
  defaultBackground: 'dots',
  alwaysFullImage: true,
  snapshotEnabled: true,
  snapshotLocation: 'plugin',
  minimap: false,
  homeBoardPath: DEFAULT_HOME_BOARD_PATH,
  recentBoards: [],
  enableIndexNote: false,
  indexNoteFolder: DEFAULT_INDEX_NOTE_FOLDER,
};

/**
 * 设置面板里给的几档自动保存间隔。
 *
 * 给档位而不是自由输入：这个值决定了"最后一次改动之后多久落盘"，
 * 太小会让大板子频繁整份写盘，太大则窗口崩溃时丢得更多 —— 都不该让用户
 * 凭感觉填一个数字。手改 `.data.json` 塞进来的越界值由 `normalizeDebounce` 夹住。
 */
export const AUTOSAVE_CHOICES: readonly number[] = [200, 400, 800, 2000];

/**
 * 卡片外观的可调范围。
 *
 * ★ 给范围而不是随便填：圆角填 9999 会把卡片压成药丸、字号填 4 会让正文消失。
 *   两端都收敛到"看起来还像卡片"的区间里，越界值由 `normalizeRange` 夹住。
 */
export const CARD_CORNER_RADIUS_RANGE = { min: 0, max: 32, step: 2 } as const;
export const CARD_FONT_SIZE_RANGE = { min: 10, max: 24, step: 1 } as const;

const MIN_DEBOUNCE_MS = 50;
const MAX_DEBOUNCE_MS = 60_000;

/** 把任意来源的数据收敛成一份可用的设置（未知字段丢弃、坏字段回落默认值） */
export function normalizeSettings(raw: unknown): NestboardSettings {
  const source = isRecord(raw) ? raw : {};
  return {
    newBoardFolder: normalizeFolder(source.newBoardFolder, DEFAULT_SETTINGS.newBoardFolder),
    templateFolder: normalizeFolder(source.templateFolder, DEFAULT_SETTINGS.templateFolder),
    // ★ 用"是不是 custom"来判而不是查表：反过来写（默认 custom）会让旧数据文件里
    //   缺这个字段的用户在升级后突然开始用自定义目录，而那个字段是空的
    attachmentLocation: source.attachmentLocation === 'custom' ? 'custom' : 'vault',
    customAttachmentFolder: normalizeFolder(source.customAttachmentFolder, ''),
    attachmentNaming: source.attachmentNaming === 'original' ? 'original' : 'timestamp',
    // ★ 默认关：只有显式 `true` 才算开（与 `minimap` / `enableIndexNote` 同一条规矩 ——
    //   去重会**改变已有行为**：同名不同内容的图可能被合并，必须由用户点头）
    attachmentDedupe: source.attachmentDedupe === true,
    autosaveDebounceMs: normalizeDebounce(source.autosaveDebounceMs),
    // ★ 默认开（`O20`）：**只有显式 `false` 才算关**。旧数据文件里没有这个字段
    //   → 升级后默认可用；写过 `false` 的用户保持关闭（他的意思不因为改默认值而变）。
    //   注意这**不是**"改判定强度"：手改出来的 `"yes"` / `1` 依旧不算数，
    //   照样回落到默认值 —— 联网许可只认布尔里的那一个 `false`。
    linkPreview: source.linkPreview !== false,
    // 逐行归一化成域名并去重（`F2-4-6`）：`https://BiliBili.com/x?utm=a` → `bilibili.com`。
    // 坏数据（不是数组 / 混进数字）一律丢掉，绝不让它流进 `isHostBlocked` 的线性扫描
    linkPreviewBlocklist: normalizeLinkBlocklist(source.linkPreviewBlocklist),
    // ★ 查表而不是"不是 none 就当 osm"：将来加一档新的、而旧版本的代码读到那个值时，
    //   应该**退回不出图**，而不是替用户按一个他没选过的服务去联网
    mapTileProvider: normalizeMapTileProvider(source.mapTileProvider),
    // 只留一个去空白的字符串：key 里不会有换行，用户从网页上复制时却常常带上
    mapTileKey: typeof source.mapTileKey === 'string' ? source.mapTileKey.trim() : '',
    // ★ 默认开（`A5`）：**只有显式 `false` 才算关** —— 旧数据文件里没有这个字段，
    //   升级后应当直接拿到"原图清晰度"（用户报的正是它），而写过 `false` 的人保持关闭
    alwaysFullImage: source.alwaysFullImage !== false,
    language: normalizeLanguage(source.language),
    defaultCardColor: normalizeCardColor(source.defaultCardColor),
    cardCornerRadius: normalizeRange(
      source.cardCornerRadius,
      CARD_CORNER_RADIUS_RANGE,
      DEFAULT_SETTINGS.cardCornerRadius,
    ),
    cardFontSize: normalizeRange(
      source.cardFontSize,
      CARD_FONT_SIZE_RANGE,
      DEFAULT_SETTINGS.cardFontSize,
    ),
    cardFontFamily: normalizeFontFamily(source.cardFontFamily),
    // ★ 只有显式写成 `neumorph` 才切档：旧数据 / 手改坏的字符串一律留在原版 ——
    //   外观档是"要不要换个样子"的开关，猜错方向的代价（一屏卡突然全变）比保守大得多
    cardStyle: source.cardStyle === 'neumorph' ? 'neumorph' : 'classic',
    defaultBackground: normalizeBackground(source.defaultBackground),
    // ★ 默认开：只有显式 `false` 才算关。旧数据文件里没有这个字段 → 升级后自动有快照保护
    snapshotEnabled: source.snapshotEnabled !== false,
    snapshotLocation: source.snapshotLocation === 'vault' ? 'vault' : 'plugin',
    // ★ 必须严格 `=== true` 才算开（与 `enableIndexNote` 同一条规矩：这边是
    //   "**占画布**要显式点头"，那边是"改库要显式点头"）。旧数据文件里没有这个字段 →
    //   升级后不会凭空多出一块浮层
    minimap: source.minimap === true,
    homeBoardPath: normalizeHomeBoardPath(source.homeBoardPath),
    recentBoards: normalizeRecentBoards(source.recentBoards),
    // ★ 严格 `=== true`：这个开关会在用户库里**生成文件**（大纲、搜索、图谱里都看得见），
    //   与 `minimap` 同一条规矩 —— 改变库的可见状态要的是明确的"是"，
    //   而不是一个手改出来的 `"yes"` / `1`
    enableIndexNote: source.enableIndexNote === true,
    // ★ 这里**不用** `normalizeHomeBoardPath` 那套"空串先处理"的写法：对目录来说
    //   `''` 本来就等价于"库根"，`normalizeFolder` 天然认它；字段缺失（`undefined`）
    //   才回落到默认目录。两种意图被自然分开，不需要额外的分支
    indexNoteFolder: normalizeFolder(source.indexNoteFolder, DEFAULT_SETTINGS.indexNoteFolder),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 目录一律收敛成 vault 相对路径。
 *
 * ★ 顺带把 `\` 换成 `/`：Windows 上从资源管理器复制路径粘进来是常见动作，
 *   而 `Boards\图` 在 Vault 里是个**不存在的目录**，表现是"附件导入了但看不见"。
 */
function normalizeFolder(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  return value
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '');
}

/**
 * Home 白板路径（T5.07 / `F11-09`）。
 *
 * 与 `normalizeFolder` 的关键区别：走的是 `util/boardPath.ts` 那一套**白板路径**规则
 * （补扩展名、拒 `..`、拒别的扩展名），与 `obsidian://nestboard?file=` 完全同一份 ——
 * 用户在设置里填的路径，正是他以后手写链接时会照抄的那个。
 *
 * ★ 空串**先于**归一化处理：`''` 在这里是"关掉 Home"这个合法意图，不是坏数据。
 *   丢给 `normalizeBoardPath` 的话它会返回 `'empty'` 拒绝，我们再回落默认值，
 *   结果就是"输入框清不空"。
 */
function normalizeHomeBoardPath(value: unknown): string {
  if (typeof value === 'string' && value.trim() === '') return '';
  const result = normalizeBoardPath(value);
  if (result.ok) return result.path;
  // 只有一种"坏数据"会被静默换成默认值（拼错了扩展名 / 带 `..`）。
  // 换成 `''` 会更糟：用户明明填了东西，界面却报"未配置"，更没法自己诊断
  return DEFAULT_SETTINGS.homeBoardPath;
}

function normalizeDebounce(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_SETTINGS.autosaveDebounceMs;
  }
  return Math.min(MAX_DEBOUNCE_MS, Math.max(MIN_DEBOUNCE_MS, Math.round(value)));
}

/**
 * 语言偏好：只认 `LANGUAGE_CHOICES` 里的三个值，其余（含旧文件里的 `null`）一律 `auto`。
 *
 * ★ 不能写成"不是 zh-cn 就是 en"：`.data.json` 里手改出的 `'zh'` / `'chinese'`
 *   会把人锁在一个他从没选过的语言上，而 `auto` 至少是"跟着 Obsidian"这个正确默认。
 */
function normalizeLanguage(value: unknown): LanguagePreference {
  return typeof value === 'string' && (LANGUAGE_CHOICES as readonly string[]).includes(value)
    ? (value as LanguagePreference)
    : DEFAULT_SETTINGS.language;
}

/**
 * 卡片默认颜色：`'1'`–`'6'` 的主题色，或一个合法的 `#RGB` / `#RRGGBB`。
 * 其余一律回落默认色 —— 一个拼错的十六进制会让 `color-mix` 整条失效。
 *
 * ★ 不做 hex 大小写 / 缩写的"纠正"，只做**接受或拒绝**：值要么原样落进卡片，
 *   要么回到主题色；擅自改写用户填的颜色比拒绝更让人意外。
 */
function normalizeCardColor(value: unknown): CardColor {
  if (typeof value !== 'string') return DEFAULT_SETTINGS.defaultCardColor;
  if (value.length === 1 && '123456'.includes(value)) return value;
  return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value)
    ? value
    : DEFAULT_SETTINGS.defaultCardColor;
}

/** 数值字段收敛到 `[min, max]` 并吸附到 `step`；非有限值回落默认值 */
function normalizeRange(
  value: unknown,
  range: { min: number; max: number; step: number },
  fallback: number,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const clamped = Math.min(range.max, Math.max(range.min, value));
  const snapped = Math.round(clamped / range.step) * range.step;
  // 吸附后再夹一次：`max: 32, step: 2` 这类配置吸附不会越界，但别让未来的改配置踩坑
  return Math.min(range.max, Math.max(range.min, snapped));
}

/**
 * 字体名：只 trim，不做任何"合法性"校验。
 *
 * ★ `font-family` 的取值空间太大（字体名带空格、引号、多字体回退列表、`var(--x)`…），
 *   与其写一条必然漏掉一半的规则去拒绝，不如原样收下 —— 真正生效与否由浏览器决定，
 *   写错了最坏就是"没变化"，不会损坏任何数据。
 */
function normalizeFontFamily(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeBackground(value: unknown): BoardBackground {
  return typeof value === 'string' && (BOARD_BACKGROUNDS as readonly string[]).includes(value)
    ? (value as BoardBackground)
    : DEFAULT_SETTINGS.defaultBackground;
}

/**
 * 静态图服务（`O08`）：认不出的取值一律**退回"不出图"**。
 *
 * ★ 与 `normalizeBackground` 那句一样是查表，但方向相反：那里认不出就退回默认背景
 *   （最坏是看着不一样），这里认不出必须退回 `'none'` —— 认成一个用户没选过的服务商，
 *   表现是"它自己去联网了"，那是授权范围之外的事。
 * ★ 导出给设置面板用（下拉框 `onChange` 拿到的只是个 `string`）：那条收敛
 *   与这里必须是同一条 —— 两处各写一份折叠逻辑，迟早漂移成"面板能选、校验不认"。
 */
export function normalizeMapTileProvider(value: unknown): MapTileProvider {
  return typeof value === 'string' && (MAP_TILE_PROVIDERS as readonly string[]).includes(value)
    ? (value as MapTileProvider)
    : DEFAULT_SETTINGS.mapTileProvider;
}

/**
 * 背景取值 → 设置面板里的文案 key（T3.25 / `F11-04`）。
 *
 * ★ 做成查表而不是 `` `settings.canvas.background.${bg}` `` 的模板拼串：
 *   拼串一旦写错（比如背景多加了一档而这里没跟着改），表现是设置面板上直接显示
 *   `settings.canvas.background.xxx` 这样的原始 key —— 用户看不懂，静态检查也抓不住。
 *   `Record<BoardBackground, MessageKey>` 让"漏一档"在编译期就暴露。
 *
 * ★ 放在 `settings/` 而不是 `view/`：设置面板要用它，而 `settings/` 不该反向依赖 `view/`。
 */
export const BACKGROUND_LABEL_KEY: Record<BoardBackground, MessageKey> = {
  plain: 'settings.canvas.background.plain',
  dots: 'settings.canvas.background.dots',
  grid: 'settings.canvas.background.grid',
  none: 'settings.canvas.background.none',
};

/**
 * 静态图服务 → 设置面板下拉框里的文案 key（`O08`）。
 * 与 `BACKGROUND_LABEL_KEY` 同一个理由：`Record<MapTileProvider, MessageKey>`
 * 让"加了一档却忘了文案"在编译期就暴露。
 */
export const MAP_TILE_LABEL_KEY: Record<MapTileProvider, MessageKey> = {
  none: 'settings.mapTile.provider.none',
  osm: 'settings.mapTile.provider.osm',
  google: 'settings.mapTile.provider.google',
  amap: 'settings.mapTile.provider.amap',
};
