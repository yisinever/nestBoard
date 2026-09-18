/**
 * 拖入内容 → 卡片（T1.63 / T1.64 / T1.65 / T1.66 的**纯逻辑部分**，`F6-01–F6-06`）。
 *
 * 拖放这件事里真正"脏"的只有两处：读 `DataTransfer`（DOM，只能在 `integration/` 里做）
 * 与把系统文件写进库（IO）。其余全是判定，全部收在本文件：
 *
 *   * 什么东西 → 哪种卡片（T1.63 的 `.nboard`、T1.64 的文件浏览器拖拽、T1.65 的任意系统文件）
 *   * 拖拽文本里哪些才是**库内路径**（`[[链接]]`、`[别名](路径)`、裸路径、`file://` URI）
 *   * 多张卡片落在哪（指针为中心，然后依次错开）
 *   * 拖进来的文本**不是**库内路径时（`F6-07`：从笔记编辑器拖选中文本）→ 变成一张便签卡
 *
 * ★ 划分的意义：这些判定决定了"拖进来会不会多出一张卡"，而它们在 node 下可以逐条钉死。
 *   留在 `view/` 里就只能靠手动拖文件去试。
 *
 * ★ 不 import `obsidian`、不碰 DOM。`inVault` 这类"外部世界的问题"一律由调用方注入。
 */

import { BOARD_EXT } from '../constants';
import type { Card, CardType } from './schema';
import { DEFAULT_CARD_SIZES, createCard, newBoardRefContent } from './factories';
import type { Point, Rect, Size } from '../util/geometry';
import { roundTo } from '../util/geometry';
import type { MessageKey } from '../util/i18n';

/**
 * 拖入能变成的卡片类型。
 *
 * 只取这四种：能拖进白板的东西必然是"库里已经有的一份文件"，
 * 而它对应哪种卡片完全由扩展名决定（`note` / `link` / `todo` 等没有可拖的实体）。
 */
export type DropKind = Extract<
  CardType,
  'noteRef' | 'image' | 'file' | 'video' | 'audio' | 'boardRef'
>;

/**
 * 拖入**预览幽灵卡**能出现的卡片种类（`F6-05`）。
 *
 * = 四种"库内文件"（`DropKind`）+ 便签（`F6-07`：从笔记编辑器拖进来的一段文本）。
 * 便签刻意**不进** `DropKind`：那个类型回答的是"这个扩展名对应哪种卡片"，
 * 而一段文本没有扩展名 —— 它是靠**内容**决定的另一条路（见 `noteContentFromDropText`）。
 * 混进去会让 `dropKindForPath` 多出一个永远返回不到的分支。
 */
export type DropCardKind = DropKind | 'note';

/** 图片扩展名（含 `svg`：Obsidian 能显示，且 T1.50 的图片卡就是按 `<img>` 渲染的） */
export const IMAGE_EXTENSIONS: readonly string[] = [
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'svg',
  'avif',
];

/**
 * 能就地播放的两种媒体的扩展名（`A1` 视频 / `A2` 音频）。
 *
 * ★ **与 Obsidian 自己的 `![[…]]` 嵌入能播的范围完全一致**：能不能播取决于
 *   Chromium 的解码器，跟扩展名像不像视频无关。`.mkv` / `.avi` 给一个播放器出来
 *   只会是黑框 —— 那比老老实实显示"文件卡"更糟（`03 §7.4` 的降级原则）。
 * ★ 名单放在 `model/` 而不是 `cards/file.ts`：**落卡的类型判定**（本文件）与
 *   **渲染时挑不挑播放器**（`cards/file.ts`）读的必须是同一份名单，而那两处
 *   一个在模型层、一个在卡片层 —— 放卡片层会让模型反向 import 卡片（成环）。
 * ★ `.ogg` 归音频（与 Obsidian 的归类一致）：它既可能是 Vorbis 也可能是 Theora，
 *   当成音频最坏只是"给了一个音频控件"；反过来则会得到一个放不出画面的视频框。
 */
export const VIDEO_EXTENSIONS: readonly string[] = ['mp4', 'webm', 'ogv', 'mov'];

export const AUDIO_EXTENSIONS: readonly string[] = [
  'mp3',
  'wav',
  'm4a',
  '3gp',
  'flac',
  'ogg',
  'oga',
  'opus',
];

/** Markdown 笔记：只有它能当"引用卡"（引用卡读的是笔记正文，T1.42） */
export const NOTE_EXTENSIONS: readonly string[] = ['md', 'markdown'];

/** 多张卡依次错开的步长（世界坐标 px）：完全重叠会让用户以为"只放进来一张" */
export const DROP_CASCADE_STEP: Size = { width: 28, height: 28 };

/** 扩展名 → 卡片类型。构造一次查表，避免每次拖入都遍历三个数组 */
const KIND_BY_EXTENSION: Record<string, DropKind> = (() => {
  const table: Record<string, DropKind> = {};
  for (const ext of IMAGE_EXTENSIONS) table[ext] = 'image';
  // 视频（`A1`）：拖进来直接是**视频卡**（不是文件卡）—— 它就是拿来播的
  for (const ext of VIDEO_EXTENSIONS) table[ext] = 'video';
  // 音频（`A2`）：同上，落下来就是一张"留声机"卡
  for (const ext of AUDIO_EXTENSIONS) table[ext] = 'audio';
  for (const ext of NOTE_EXTENSIONS) table[ext] = 'noteRef';
  table[BOARD_EXT] = 'boardRef';
  return table;
})();

/** 取小写扩展名（不含点）。无扩展名 / 只有开头的点（`.gitignore`）→ `''` */
export function extensionOf(path: string): string {
  const slash = path.lastIndexOf('/');
  const dot = path.lastIndexOf('.');
  // `dot <= slash + 1` 同时挡住这两件事：`folder.name/file`（点在目录名里）
  // 与 `.gitignore`（点就是文件名的第一个字符 —— 它没有扩展名）
  if (dot <= slash + 1) return '';
  return path.slice(dot + 1).toLowerCase();
}

/** 取路径最后一段（`a/b/图.png` → `图.png`）。纯字符串，不碰文件系统 */
export function baseNameOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? path : path.slice(slash + 1);
}

/**
 * 路径 → 卡片类型。认不出来的一律当文件卡（`file`）——
 * `F6-04` 要的是"任意文件都能拖进来"，猜不出类型就退到最通用的那一种，
 * 而不是拒绝它（`file` 卡双击本来就能用系统应用打开）。
 */
export function dropKindForPath(path: string): DropKind {
  return KIND_BY_EXTENSION[extensionOf(path)] ?? 'file';
}

/**
 * 这份路径是**笔记**吗（`.md` / `.markdown`，即"会变成引用卡的那一类"）。
 *
 * ★ 与 `dropKindForPath(p) === 'noteRef'` 是同一个判定，单列出来只为让调用方读得懂：
 *   拖入导入要问的问题是"这是不是一篇笔记"，而不是"它是哪种卡" ——
 *   拿到一个 `DropKind` 再去比字符串，看代码的人会以为这里还有别的分支。
 * ★ 用它来决定**命不命名**（O14）：笔记保留原名，附件才套时间戳前缀。
 */
export function isNotePath(path: string): boolean {
  return NOTE_EXTENSIONS.includes(extensionOf(path));
}

/** 预览文案键（`F6-05`：拖拽时要说清楚"会变成什么"，而不是只给个高亮） */
export function dropHintKey(kind: DropCardKind): MessageKey {
  switch (kind) {
    case 'noteRef':
      return 'drop.hint.noteRef';
    case 'image':
      return 'drop.hint.image';
    case 'boardRef':
      return 'drop.hint.boardRef';
    case 'note':
      return 'drop.hint.note';
    default:
      return 'drop.hint.file';
  }
}

/** 已确认在库内的一项待落卡内容 */
export interface DropItem {
  /** Vault 相对路径 */
  path: string;
  kind: DropKind;
  /** 展示用名字（文件名）。**不是**路径：预览标签里放整条路径会把提示撑到屏幕外 */
  name: string;
}

/**
 * 带 scheme 的 URL 一般不是库内路径（`http:` / `https:` / `data:` / `mailto:`）。
 * ★ 例外：`obsidian://open?file=…` 是 Obsidian 文件浏览器/内部链接拖拽时的标准形态，
 *   需要把 `file=` 参数解出来当库内路径处理。
 */
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** `file://` 前缀（`file:///Users/...` 三个斜杠，或 `file://host/path`） */
const FILE_SCHEME = /^file:\/\//i;

/** 百分号解码；解不开（文件名里真的有个 `%`）就原样返回 */
function decodeSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Obsidian 文件浏览器 / 内部链接拖拽时给的 `obsidian://open?file=…` 链接 → 库内相对路径。
 * 只认 `file=` 参数；别的 obsidian 动作（搜索、图谱、跨库链接等）不处理，让它走外链分支。
 * `file` 参数本身是 URL 编码的，需要解码（`%2F` → `/`）。
 */
function obsidianFilePath(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'obsidian:' || url.hostname !== 'open') return null;
    const file = url.searchParams.get('file');
    if (!file) return null;
    return decodeSafe(file);
  } catch {
    return null;
  }
}

/**
 * 把一条原始文本规范成候选路径。
 *
 * @param decode 是否做百分号解码。**只有 URI 形态**（`file://`、markdown 链接目标）才开：
 *   库内文件名里 `%` 是完全合法的（`50%.md`），无条件解码会把 `50%20.md` 变成
 *   `50 .md` —— 路径不存在 → 用户拖进来什么都没发生。
 */
export function normalizeDropPath(raw: string, decode = false): string {
  let value = raw.trim();
  if (value.length === 0) return '';

  // 系统文件管理器给的是绝对路径；解码后原样返回 —— 它**不是**库内路径，
  // 要么由调用方按文件名去 `dataTransfer.files` 里配对（T1.65），要么被丢掉
  if (FILE_SCHEME.test(value)) return decodeSafe(value.replace(FILE_SCHEME, ''));

  // `https://…` 这类外链不是文件，拖进来也不该变成卡片（合规：不抓取外部内容，03 §7.5）
  if (URL_SCHEME.test(value)) return '';

  if (decode) value = decodeSafe(value);

  // wikilink 的 `#小节` / `|别名`：`[[Note#标题|别名]]` 里两者可能同时出现，
  // 所以必须一次切掉**最先**出现的那个，分两步切会在 `[[Note|别名#标签]]` 上切错
  value = value.split(/[#|]/, 1)[0];

  return value
    .replace(/\\/g, '/') // Windows 风格的绝对/相对路径
    .replace(/^\.\//, '')
    .replace(/\/{2,}/g, '/')
    .replace(/\/$/, '')
    .trim();
}

/** 按正则抓捕获组，并把这些片段从文本里挖掉（剩下的再按行当裸路径处理） */
function collect(text: string, pattern: RegExp): { found: string[]; rest: string } {
  // ★ 每次重新构造正则：`g` 标志把扫描位置记在正则对象自己身上，
  //   复用同一个字面量会在第二次调用时从中间开始扫（只在"拖第二次"时才复现）
  const regex = new RegExp(pattern.source, 'g');
  const found: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) found.push(match[1]);
  return { found, rest: text.replace(regex, '\n') };
}

/**
 * 拖拽文本 → 候选路径（**未经校验**：调用方要用 `inVault` 过一遍）。
 *
 * 覆盖 Obsidian 文件浏览器与外部来源实际会给的五种形态：
 *   `![[attachments/图.png]]` / `[[Note#标题|别名]]` / `[标题](folder/Note.md)` /
 *   裸路径与 `file://` / `obsidian://open?file=folder%2FNote.md`
 *
 * 去重后按出现顺序返回 —— 多选拖拽时顺序就是用户在文件浏览器里的选择顺序，
 * 打乱它会让落位错乱（T1.66 的错开落位依赖这个顺序）。
 */
export function parseDropPaths(text: string): string[] {
  if (text.trim().length === 0) return [];

  const seen = new Set<string>();
  const result: string[] = [];
  const push = (candidate: string, decode: boolean): void => {
    const path = normalizeDropPath(candidate, decode);
    if (path.length === 0 || seen.has(path)) return;
    seen.add(path);
    result.push(path);
  };

  // `![[x]]` 的 `!` 只是"嵌入"，`[[x]]` 才是链接 —— 两者都是路径，一起收
  const wikilinks = collect(text, /!?\[\[([^\]]+)\]\]/);
  for (const candidate of wikilinks.found) push(candidate, false);

  // markdown 链接的目标按 URI 规范编码（`[x](a%20b.md)`），所以这里要解码
  const markdown = collect(wikilinks.rest, /\[[^\]]*\]\(([^)]+)\)/);
  for (const candidate of markdown.found) push(candidate, true);

  // 剩下的按行处理：Obsidian 文件浏览器拖出来的是 `obsidian://open?file=…`，
  // 需要单独解出来；其余普通文本走 `normalizeDropPath`。
  for (const line of markdown.rest.split('\n')) {
    const obsidian = obsidianFilePath(line);
    if (obsidian) push(obsidian, false);
    else push(line, false);
  }

  return result;
}

/**
 * 拖拽文本 → 真正的落卡项。
 *
 * `resolvePath` 是唯一的外部事实：拖拽文本里混着外链、已删除的文件、
 * 别的软件给的无意义字符串，而**只有库内文件能变成卡片**。
 * 它返回 `null` 的候选被静默丢掉 —— 拖一份网页链接进来什么都不发生，正是期望行为。
 *
 * ★ 解析器返回的是**库内真实路径**，而不一定是输入里的字符串：Obsidian 拖拽
 *   文件浏览器/笔记链接时常常给**短名**（`子板.nboard`），但库内实际路径是
 *   `Boards/子板.nboard`。把短名展开，卡片里存的就是能打开、能失效跟踪的完整路径。
 */
export function resolveDropText(
  text: string,
  resolvePath: (path: string) => string | null,
): DropItem[] {
  const items: DropItem[] = [];
  for (const raw of parseDropPaths(text)) {
    const path = resolvePath(raw);
    if (!path) continue;
    items.push({ path, name: baseNameOf(path), kind: dropKindForPath(path) });
  }
  return items;
}

/** 以 `point` 为**中心**的卡片矩形（与双击新建便签同一套直觉：光标处就是"就这儿"） */
export function rectAt(point: Point, size: Size): Rect {
  return {
    x: roundTo(point.x - size.width / 2),
    y: roundTo(point.y - size.height / 2),
    width: size.width,
    height: size.height,
  };
}

/**
 * 一次拖入多张时的错开落位（T1.66）：返回每张卡的**中心点**序列。
 *
 * 第一张以指针为中心，其后每张右下偏移 `step` —— 完全重叠时用户只看得见最后一张，
 * 会以为"只放进来一张"然后去文件浏览器里再拖一次（于是有了两张重叠的卡）。
 *
 * ★ 只算中心点、不算矩形：不同类型卡片的默认尺寸不同（便签 240×160、文件卡更矮），
 *   把尺寸也塞进来就会强迫"一次拖入的多张卡尺寸必须一样"，而现实是
 *   拖进一个 `.md` + 一张图时两者本来就该各用自己的默认尺寸。
 */
export function cascadeOrigins(
  count: number,
  origin: Point,
  step: Size = DROP_CASCADE_STEP,
): Point[] {
  const origins: Point[] = [];
  const total = Math.max(0, Math.floor(count));
  for (let index = 0; index < total; index += 1) {
    origins.push({
      x: origin.x + index * step.width,
      y: origin.y + index * step.height,
    });
  }
  return origins;
}

/**
 * 库内路径 → 新卡片（T1.63–T1.66 的**建卡**部分）。
 *
 * `origins` 是每张卡的中心点（`cascadeOrigins` 的结果），缺项时退到最后一个 ——
 * 宁可多叠一张，也不要因为"少算了一个点"把卡片丢在 (0,0)。
 *
 * ★ 尺寸用**每种类型自己的默认值**（`DEFAULT_CARD_SIZES`）：一次拖进一个 `.md`
 *   与一张图，两者本来就该各长各的样。调用方（`BoardView`）画幽灵卡时读同一张表，
 *   于是"看到的框"与"落下的卡"尺寸一致。
 */
export function cardsForDropPaths(paths: readonly string[], origins: readonly Point[]): Card[] {
  // ★★ 图集卡（`A4`，用户 2026-09-18）：**一次拖进来两张以上图片**时合成**一张**图集卡。
  //    "我把这几张图一起拖进来"就是这个手势的自然意思 —— 落成三张散图，用户还得自己
  //    一张张摆到一块儿去。一张图仍是图片卡（原样不动）。
  // ★ 判据放在**这一个函数**里，而不是各调用方：它与"拖入落什么卡"是同一件事，
  //   在别处再判一次，迟早出现"某个入口拖三张图出来三张卡"这种不一致。
  // ★ 只有**全是图片**时才合（混着 pdf / 视频的一次拖入照旧一张一个卡）。
  if (paths.length > 1 && paths.every((path) => dropKindForPath(path) === 'image')) {
    const origin: Point = origins[0] ?? { x: 0, y: 0 };
    return [
      createCard('gallery', {
        ...rectAt(origin, DEFAULT_CARD_SIZES.gallery),
        content: { paths: [...paths] },
      }),
    ];
  }

  return paths.map((path, index) => {
    const kind = dropKindForPath(path);
    const fallback: Point = origins[origins.length - 1] ?? { x: 0, y: 0 };
    const origin = origins[index] ?? fallback;
    return cardOfKind(kind, path, rectAt(origin, DEFAULT_CARD_SIZES[kind]));
  });
}

/**
 * 按类型建卡。
 *
 * 写成 `switch` 而不是"拼一个联合类型的 overrides 再 `createCard(kind, …)`"：
 * 泛型 `T` 取联合类型时，`content` 的收窄会退化成四个类型的并集，
 * 分类型各写一行才能让 `createCard('noteRef', …)` 拿到真正精确的返回类型。
 */
function cardOfKind(kind: DropKind, path: string, rect: Rect): Card {
  switch (kind) {
    case 'noteRef':
      return createCard('noteRef', { ...rect, content: { path } });
    case 'image':
      return createCard('image', { ...rect, content: { path } });
    // 视频卡（`A1`）：内容与文件卡同形状（一个路径 + 不画大小的那一格）
    case 'video':
      return createCard('video', { ...rect, content: { path, showSize: false } });
    // 音频卡（`A2`）：同上
    case 'audio':
      return createCard('audio', { ...rect, content: { path, showSize: false } });
    case 'file':
      return createCard('file', { ...rect, content: { path } });
    case 'boardRef':
      // ★ 必须带上新建白板卡的默认内容（`preview: 'mini'` + 随机记号 + 计数开关），
      //   不能只塞 `{ path }`：那样这张卡就丢了 `preview`，渲染层于是走**完整版式**
      //   （标题行 + 预览区 + 计数），可它的尺寸是 87×87 的迷你正方形 —— 结果是一张
      //   "塞不下的四不像"。用户报的"新建子白板没有出现在画布上"（`F2-8-1`）就出在这一处：
      //   落下来的卡没有进迷你形态，看起来就不像一张刚建好的子白板入口。
      return createCard('boardRef', {
        ...rect,
        content: { ...newBoardRefContent(), path },
      });
  }
}

// ───────────────────────────────────────────────────────────
// 拖进来的一段文本（F6-07）：不是库内路径 → 便签卡
// ───────────────────────────────────────────────────────────

/**
 * 预览标签里放多少个字符。
 *
 * 40 是个"一眼能认出是哪段话、又不会把幽灵卡撑成一长条"的量；
 * 真正重要的不是这个数，而是**必须截断** —— 拖一段几千字的笔记进来时，
 * 标签会横穿整个画布并把幽灵卡挤到屏幕外。
 */
const PREVIEW_NAME_MAX = 40;

/**
 * 整段文本就是一个网址的形态（`https://…`、`mailto:…`、`file:///…`，且不含空白）。
 *
 * ★ 这条规则是**为了不改动既有行为**：拖一个外链进来什么都不发生是写进
 *   `resolveDropText` 注释、并钉在单测里的既定行为（合规：不抓取外部内容，`03 §7.5`）。
 *   `F6-07` 之后若不加这条，"拖个链接"会变成"多出一张只写着网址的便签卡"。
 */
const BARE_URL = /^[a-z][a-z0-9+.-]*:\S*$/i;

/**
 * 拖进来的文本能不能变成一张便签卡；能就返回**要写进卡里的正文**。
 *
 * 判定只有两条：
 *   1. 去掉首尾空白后不能是空的（拖了个空选区 / 只拖了换行 → 不该凭空多出一张空卡）；
 *   2. 不能是"整段就是一个网址"（见 `BARE_URL`）。
 *
 * ★ **不设长度上限**：便签卡本来就是正文容器（几千字的卡片在这个插件里是常态），
 *   而且"截断"意味着悄悄丢用户的内容 —— 比"多一张很大的卡"严重得多。
 * ★ 换行统一成 `\n`（Windows 拖过来的 `\r\n` 会让卡片正文里混进多余的 `\r`）。
 */
export function noteContentFromDropText(text: string): string | null {
  const content = text.replace(/\r\n?/g, '\n').trim();
  if (content.length === 0) return null;
  if (BARE_URL.test(content)) return null;
  return content;
}

/**
 * 便签幽灵卡上显示的短名：第一行，过长截断。
 *
 * 取**第一行**而不是首尾拼一段：拖进来一段带标题的文本时，第一行通常正是它
 * 最像"标题"的那部分 —— 这比截取前 40 个字符更能让用户确认"拖对了吗"。
 */
export function dropTextPreviewName(text: string): string {
  const lines = text.split('\n');
  const first = lines.find((line) => line.trim().length > 0) ?? '';
  const flat = first.trim().replace(/^#{1,6}\s*/, '');
  const shown = flat.length > 0 ? flat : text.trim();
  return shown.length > PREVIEW_NAME_MAX ? `${shown.slice(0, PREVIEW_NAME_MAX)}…` : shown;
}

/**
 * 一段文本 → 一张便签卡（`F6-07`）。
 *
 * ★ 正文**原样**存进 `content.md`：用户拖的是"这段字"，不是"这句话的意思"，
 *   任何"顺手清理一下格式"都是在改用户的输入。
 * ★ 尺寸取 `DEFAULT_CARD_SIZES.note`，与拖文件时读的是同一张表 ——
 *   于是幽灵卡与最终落下的卡一样大（`F6-05` 的承诺）。
 */
export function noteCardForDropText(content: string, origin: Point): Card {
  return createCard('note', {
    ...rectAt(origin, DEFAULT_CARD_SIZES.note),
    content: { md: content },
  });
}
