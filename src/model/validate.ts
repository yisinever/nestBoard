/**
 * 反序列化容错与非法状态修复（T1.08）。
 *
 * 设计原则（对应 03 §3.2 W6「解析失败绝不覆盖」）：
 *
 * 1. **信封严格、条目宽松**：文件整体不像白板（不是对象 / 没有 cards 数组）→ 判定失败，
 *    上层进入只读保护态，**绝不写回**；
 * 2. **单张卡片坏掉不牵连整块板**：卡片级错误只丢弃该卡片并记账 `issues`，
 *    其余内容照常读出 —— 用户宁可丢一张卡，也不愿整块板打不开；
 * 3. **所有修复都留痕**：返回 `issues` 供上层提示"已修复 N 处 / 丢弃 N 项"。
 *
 * ★ 纯逻辑：不 import `obsidian`、不碰 DOM。所有数值都做 `Number.isFinite` 校验，
 *   因为 JSON 里 `null`、字符串数字、`NaN`（经 `JSON.parse` 不会出现，但经内存构造会出现）都见过。
 */

import { BOARD_SPEC, BOARD_VERSION, BOARD_REF_MINI_SIZE, ID_PREFIX } from '../constants';
import type { Point } from '../util/geometry';
import { normalizeAngle, roundTo } from '../util/geometry';
import { createId } from '../util/id';
import { normalizeHex } from '../util/color';
// ★ 图标的清洗与写入侧（图标选择器）**共用这一份**（`O10`）：两边各写一份的话，
//   会出现"选进去的图标读回来变样"这种最难查的不一致
import { normalizeIcon } from '../util/emoji';
// ★ 弧度归一化与写入侧（`curveFromMidpoint`）**共用这一份**：两边判据分开写的话，
//   会出现"拖出来的值写进去、读回来变成另一条线"这种最难查的不一致
import { normalizeEdgeCurve } from './edges';
// 内嵌脑图卡（`F4`）：那份脑图模型交给**脑图自己的校验器**（见 `normalizeMindContent`）；
// 初始形态走白板的工厂（`INLINE_MIND_BRANCHES` 那一处定的"根 + 3 分支"）
import { createMindFile } from '../mind/model/factories';
import { normalizeMindFile } from '../mind/model/validate';
// 老脑图卡 → 容器时的**根节点落点**要按布局算（见 `mindFromLegacyCard`）——
// 布局是纯函数、不碰 DOM，所以白板这一侧可以直接用（`12 §4.5` 的读时转换）
import { directionForStructure, layoutMind } from '../mind/layout/tree';
import { INLINE_MIND_BRANCHES } from './factories';
import type {
  BoardFile,
  BoardMeta,
  BoardBackground,
  BoardSettings,
  BoardRefContent,
  BoardRefPreview,
  Card,
  CardColor,
  CardContent,
  CardTitleStyle,
  CardType,
  Column,
  CommentEntry,
  Edge,
  EdgeEndpoint,
  EdgeEnd,
  EdgeRouting,
  EdgeSide,
  EdgeStyle,
  Group,
  HexColor,
  ImageCrop,
  ImageFit,
  InkPath,
  InkPoint,
  LinkContent,
  MapContent,
  MapCoords,
  MapPin,
  Mind,
  NoteEditorMode,
  NoteContent,
  NoteRefMode,
  SwatchEntry,
  SwatchStop,
  TodoItem,
} from './schema';
import { DEFAULT_CARD_SIZES, DEFAULT_COLUMN_SIZE } from './factories';
import { isCardType, isFreeEndpoint, isHexColor, isThemeColor } from './schema';

// ─────────────────────────────────────────────────────────────
// 结果类型
// ─────────────────────────────────────────────────────────────

export interface ValidationIssue {
  /** JSON 路径，如 `cards[3].content.path` */
  path: string;
  message: string;
  action: 'fixed' | 'dropped';
}

export interface NormalizedBoard {
  board: BoardFile;
  issues: ValidationIssue[];
}

export type ParseFailureReason = 'invalid-json' | 'not-a-board';

export type ParseBoardResult =
  | { ok: true; board: BoardFile; issues: ValidationIssue[] }
  | { ok: false; reason: ParseFailureReason };

export type SafeJsonResult = { ok: true; value: unknown } | { ok: false };

// ─────────────────────────────────────────────────────────────
// 基础读取器
// ─────────────────────────────────────────────────────────────

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function safeJsonParse(raw: string): SafeJsonResult {
  try {
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch {
    return { ok: false };
  }
}

function readString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function readNumber(value: unknown, fallback: number): number {
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function readPositiveNumber(value: unknown, fallback: number): number {
  const num = readNumber(value, fallback);
  return num > 0 ? num : fallback;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function readColor(value: unknown, fallback: CardColor): CardColor {
  if (isThemeColor(value)) return value;
  if (isHexColor(value)) return value;
  return fallback;
}

function readAccent(value: unknown): HexColor | null {
  return isHexColor(value) ? value : null;
}

/**
 * 演示步骤号（J-07）：读回时**收紧**成"≥1 的整数"或 `null`。
 *
 * ★ 0 / 负数 / 小数都来自手改文件：步骤号是给人看的序号（"第 3 步"），
 *   留着 0.5 只会让界面显示"0.5 / 8"。宁可当场纠正成最近的合法值，
 *   也不要让一个坏数字流进排序与显示。
 */
function readPresentStep(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.max(1, Math.round(value));
}

/**
 * 卡面标记（`O38`）：归一化走 `util/emoji.ts` 的 `normalizeIcon`（与脑图节点共用一份）。
 *
 * ★ 空串 = 没有标记 ⇒ 返回 `null`，调用方据此**不写这个键**（纪律 2）。
 */
function readCardIcon(raw: unknown): string | null {
  const icon = normalizeIcon(raw);
  return icon.length > 0 ? icon : null;
}

/**
 * 标题整条格式（`O38`）：只认认识的键，坏值**只丢那一项**（不丢整张卡）。
 *
 * ★ `italic` / `underline` 的缺省是常量"无" ⇒ 为 `false` 时**不写**（纪律 2）；
 *   `bold` 的缺省由样式表决定（标题本来是半粗的）⇒ `false` 有意义、**留住它**
 *   （"把这张卡的标题加粗关掉"就靠它）。
 * ★ `ink` 必须是一个合法 HEX（三位缩写会被展开成六位）：认不出来就丢掉这一项 ——
 *   标题照旧用"按底色算出来"的那个字色，比写一个非法 CSS 色强。
 */
function readTitleStyle(raw: unknown): CardTitleStyle | null {
  if (!isRecord(raw)) return null;

  const style: CardTitleStyle = {};
  if (typeof raw.bold === 'boolean') style.bold = raw.bold;
  if (raw.italic === true) style.italic = true;
  if (raw.underline === true) style.underline = true;
  const ink = typeof raw.ink === 'string' ? normalizeHex(raw.ink) : null;
  if (ink !== null) style.ink = ink;
  return Object.keys(style).length > 0 ? style : null;
}

/**
 * 卡片旋转角（T7.06）：读回时**归一化 + 收敛到 1 位小数**，读不出就是 `0`。
 *
 * ★ 读不出（字段缺席 / 不是数 / `NaN`）**不记 `issues`**：这是新加的字段，
 *   存量文件里根本没有它 —— 每张卡都报一条"已修复 rotation"，会把真正的问题淹掉。
 * ★ 归一化到 `(-180, 180]`：`450` 与 `90` 是同一个朝向，留两种写法等于让
 *   "和上次一样吗"这个判断永远失败。
 * ★ 收敛到 1 位小数：转动手势逐帧算出来的是 `89.99999999999999` 这种数，
 *   不收敛的话每拖动一次就往文件里写一个略有不同的数（git diff 永远脏）。
 */
function readRotation(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return roundTo(normalizeAngle(value), 1);
}

/**
 * 笔迹的不透明度（T7.08 / `F4-07`）：只有"确实半透明"的值才认，其余一律当缺省。
 *
 * ★ 与 `readRotation` 同一条规矩：读不出（字段缺席 / 不是数 / `NaN`）**不记 `issues`** ——
 *   新加的字段在存量文件里处处缺席，每笔都报一条"已修复 alpha"会把真问题淹掉。
 * ★ `1` 也**不写键**：省掉"最常见的那个值"（普通笔迹全是不透明的），
 *   否则每一笔都会在文件里多出一个 `alpha: 1`。
 * ★ 收敛到 2 位小数：`0.34999999999999998` 这种值肉眼无差别，但每次序列化的末位
 *   都可能摆动（`git diff` 永远脏）；`0.001` 这种"收敛完就没了"的值直接当缺省。
 * ★ `> 0` 这条与运行侧（`model/ink` 的 `normalizedAlpha`）同一判据：`0` 在两边都
 *   意味着"别管这个字段"，而不是"给我一支隐形的笔"。
 */
function readAlpha(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const alpha = roundTo(value, 2);
  if (alpha <= 0 || alpha >= 1) return null;
  return alpha;
}

function readId(value: unknown, prefix: (typeof ID_PREFIX)[keyof typeof ID_PREFIX]): string {
  return typeof value === 'string' && value.length > 0 ? value : createId(prefix);
}

class IssueCollector {
  readonly issues: ValidationIssue[] = [];

  fixed(path: string, message: string): void {
    this.issues.push({ path, message, action: 'fixed' });
  }

  dropped(path: string, message: string): void {
    this.issues.push({ path, message, action: 'dropped' });
  }
}

// ─────────────────────────────────────────────────────────────
// 各类型 content 校验
// ─────────────────────────────────────────────────────────────

function normalizeNoteContent(raw: unknown): CardContent | null {
  if (!isRecord(raw)) return null;
  const editorMode: NoteEditorMode = raw.editorMode === 'preview' ? 'preview' : 'markdown';
  const content: NoteContent = { md: readString(raw.md), editorMode };
  // 深色变体（`O06`）：只有 `dark` 才写这个键 —— `light` 是默认值，
  // 与 `InkPath.alpha` / `BoardRefContent.icon` 同一条规矩（缺席 = 默认，文件字节稳定）
  if (raw.variant === 'dark') content.variant = 'dark';
  return content;
}

function normalizeNoteRefContent(raw: unknown): CardContent | null {
  if (!isRecord(raw)) return null;
  const path = readString(raw.path);
  if (path.length === 0) return null; // 引用卡没有路径 = 无意义，丢弃
  const mode: NoteRefMode = raw.mode === 'embed' || raw.mode === 'cover' ? raw.mode : 'summary';
  const subpath = typeof raw.subpath === 'string' && raw.subpath.length > 0 ? raw.subpath : null;
  const excerptLines = Math.min(200, Math.max(1, Math.round(readNumber(raw.excerptLines, 6))));
  return { path, subpath, mode, excerptLines };
}

function normalizeImageContent(raw: unknown): CardContent | null {
  if (!isRecord(raw)) return null;
  const path = readString(raw.path);
  if (path.length === 0) return null;
  const rawCrop = isRecord(raw.crop) ? raw.crop : {};
  const crop: ImageCrop = {
    x: readNumber(rawCrop.x, 0),
    y: readNumber(rawCrop.y, 0),
    w: readPositiveNumber(rawCrop.w, 1),
    h: readPositiveNumber(rawCrop.h, 1),
  };
  const fit: ImageFit = raw.fit === 'contain' ? 'contain' : 'cover';
  return { path, caption: readString(raw.caption), crop, fit };
}

function normalizeFileContent(raw: unknown): CardContent | null {
  if (!isRecord(raw)) return null;
  const path = readString(raw.path);
  if (path.length === 0) return null;
  return { path, showSize: readBoolean(raw.showSize, true) };
}

/**
 * 内嵌脑图卡（`F4`）的内容：**整份脑图模型**长在卡片里。
 *
 * ★ 把那份模型交给**脑图自己的校验器**（`mind/model/validate.normalizeMindFile`）：
 *   同一个形状在 `.nestmind` 与卡片里必须是同一套读法，各写一份迟早出现
 *   "文件里能读出来、卡里读不出来"这种最难查的不一致。
 * ★ **永远返回结果、绝不返回 `null`**（其它归一函数的"认不出来就 null"在这里是错的）：
 *   `null` 会让这张卡**整个消失**（调用方按"内容不合法"丢弃它），而脑图卡是用户写下的
 *   东西 —— 读不出来时退回"一张全新的空脑图"，卡片还在、用户还能打开文件看原数据。
 *   这是与其它卡片不同的一条取舍，写在这里免得下次被"统一"掉。
 */
function normalizeMindContent(raw: unknown): CardContent | null {
  if (!isRecord(raw)) return null;
  const parsed = normalizeMindFile(raw.mind);
  // 认不出来（`ok: false`）= 那份数据不是脑图：给一张全新的（根 + 3 个分支），
  // 而不是让卡片凭空消失。原数据仍在 `.nboard` 里，用户随时能去文件里找。
  if (!parsed.ok) return { mind: createMindFile({ branches: INLINE_MIND_BRANCHES, title: '' }) };
  return { mind: parsed.file };
}

function normalizeLinkContent(raw: unknown): CardContent | null {
  if (!isRecord(raw)) return null;
  const url = readString(raw.url);
  if (url.length === 0) return null;
  const fetchedAt = typeof raw.fetchedAt === 'string' ? raw.fetchedAt : null;
  const content: LinkContent = {
    url,
    title: readString(raw.title),
    description: readString(raw.description),
    image: readString(raw.image),
    fetchedAt,
  };

  // ★ `O20` 抓下来的三样必须**原样带回来**：这里从前一个字都不读 ⇒ 重开白板之后
  //   站点名 / 站点图标 / 展开后的最终网址全没了，卡面上又变回裸域名。
  //   那是**数据损失**（用户点了「获取预览」，抓到的信息没落下来），不是显示问题。
  // ★ 三个都是"空值键缺席"（同 `MapContent` 那条约定）：没抓到就不写这个键
  const siteName = readString(raw.siteName);
  if (siteName.length > 0) content.siteName = siteName;
  const icon = readString(raw.icon);
  if (icon.length > 0) content.icon = icon;
  const finalUrl = readString(raw.finalUrl);
  if (finalUrl.length > 0) content.finalUrl = finalUrl;

  // `A8` 的卡面样式：只认 `'mini'` —— 默认那档（`'full'`）不写进文件
  if (raw.style === 'mini') content.style = 'mini';

  return content;
}

function normalizeTodoItems(raw: unknown): TodoItem[] {
  if (!Array.isArray(raw)) return [];
  const items: TodoItem[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    items.push({ text: readString(entry.text), done: readBoolean(entry.done, false) });
  }
  return items;
}

function normalizeTodoContent(raw: unknown): CardContent | null {
  if (!isRecord(raw)) return null;
  return { title: readString(raw.title), items: normalizeTodoItems(raw.items) };
}

function normalizeSwatchStop(raw: unknown): SwatchStop | null {
  if (!isRecord(raw)) return null;
  if (!isHexColor(raw.color)) return null;
  const stop: SwatchStop = { color: raw.color };
  // 位置收进 0~100：CSS 自己也会夹，但"读进来就合法"能省掉下游每次画之前再夹一遍
  if (typeof raw.position === 'number' && Number.isFinite(raw.position)) {
    stop.position = Math.min(100, Math.max(0, raw.position));
  }
  return stop;
}

function normalizeSwatchEntry(raw: unknown): SwatchEntry | null {
  if (isHexColor(raw)) return raw;
  if (!isRecord(raw)) return null;
  if (raw.type !== 'linear') return null;
  if (typeof raw.angle !== 'number' || !Number.isFinite(raw.angle)) return null;
  const stops: SwatchStop[] = [];
  if (Array.isArray(raw.stops)) {
    for (const entry of raw.stops) {
      const stop = normalizeSwatchStop(entry);
      if (stop !== null) stops.push(stop);
    }
  }
  // 少于 2 个色标不构成渐变（CSS 也会当整条声明无效）——丢掉这一格，
  // 而不是"补一个默认色"：补出来的渐变是用户没写过的颜色
  if (stops.length < 2) return null;
  return { type: 'linear', angle: raw.angle, stops };
}

function normalizeSwatchContent(raw: unknown): CardContent | null {
  if (!isRecord(raw)) return null;
  const colors: SwatchEntry[] = [];
  if (Array.isArray(raw.colors)) {
    for (const entry of raw.colors) {
      const normalized = normalizeSwatchEntry(entry);
      if (normalized !== null) colors.push(normalized);
    }
  }
  const pickedFrom = typeof raw.pickedFrom === 'string' ? raw.pickedFrom : null;
  return { colors, pickedFrom };
}

function normalizeBoardRefContent(raw: unknown): CardContent | null {
  if (!isRecord(raw)) return null;
  const path = readString(raw.path);
  if (path.length === 0) return null;
  // ★ **预览档位一律归成 `mini`**（用户 2026-09-16："所有白板，只保留迷你形式。
  //   其他形式都不需要放出来"）。
  //   * 存量文件（`thumb` / `none` / `live`）**打开即变成迷你、保存即定型**；
  //   * 尺寸那一段（`normalizeCard` 里"mini 形态钉死正方形"）紧接着接手，
  //     一次把事情做完 —— 所以这里不必自己动宽高。
  // ★ 为什么在**读入口**归、而不是只把菜单项删掉：只删菜单的话，存量卡会一直停在
  //   原来那个档位上（用户看到的还是缩略图），"只保留迷你"就只对新卡成立。
  // ★ 另外三档的**渲染代码留着**：那是"读得懂旧数据"的能力，删掉只会让手改过的文件
  //   变成一张认不出来的卡；它们现在是死路径，`render()` 里也就多两个分支。
  const preview: BoardRefPreview = 'mini';
  const content: BoardRefContent = { path, preview, showCount: readBoolean(raw.showCount, true) };
  // 卡面图标（`O10`）：归一到空串就当**没设** —— 键不写进文件，于是"清掉图标"的卡片
  // 与"从来没设过"的卡片是同一份字节（否则每次清图标都要多写一个 `"icon": ""`）
  const icon = normalizeIcon(raw.icon);
  if (icon.length > 0) content.icon = icon;
  return content;
}

function normalizeInkPoint(raw: unknown): InkPoint | null {
  if (!Array.isArray(raw) || raw.length < 2) return null;
  const x = readNumber(raw[0], Number.NaN);
  const y = readNumber(raw[1], Number.NaN);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return [x, y];
}

function normalizeInkPaths(raw: unknown): InkPath[] {
  if (!Array.isArray(raw)) return [];
  const paths: InkPath[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const points = Array.isArray(entry.points)
      ? entry.points.map(normalizeInkPoint).filter((p): p is InkPoint => p !== null)
      : [];
    if (points.length === 0) continue;
    const path: InkPath = {
      color: isHexColor(entry.color) ? entry.color : '#000000',
      width: readPositiveNumber(entry.width, 2),
      points,
    };
    const alpha = readAlpha(entry.alpha);
    if (alpha !== null) path.alpha = alpha;
    paths.push(path);
  }
  return paths;
}

function normalizeInkContent(raw: unknown): CardContent | null {
  if (!isRecord(raw)) return null;
  return { paths: normalizeInkPaths(raw.paths) };
}

/**
 * 图钉（归一化坐标）。
 *
 * ★ 读回来时**夹进 0~1**：手改文件写出 `x: 3` 时，留着它会让图钉飘到卡外几百像素的地方，
 *   而夹住只是"钉到边上" —— 后者用户一眼能看出来并顺手改回去。
 * ★ 缺字段 / 不是数字 / `NaN` 一律算"没标位置"（`null`），而不是补一个 `{x:0,y:0}`：
 *   左上角是一个**具体的**位置，凭空补一个等于替用户标了个错点。
 */
function readMapPin(raw: unknown): MapPin | null {
  if (!isRecord(raw)) return null;
  const x = readNumber(raw.x, Number.NaN);
  const y = readNumber(raw.y, Number.NaN);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x: clamp01(x), y: clamp01(y) };
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * 经纬度（`O08`）。越界的一律算"没有坐标"，而不是夹回来：
 * 纬度 91 与 89 是**两个不同的地方**，夹成 89 等于替用户认领了一个他没说过的点。
 * （与图钉的 `clamp01` 相反 —— 那里的 `0.5` 是"卡片中间"，夹住就是最接近的原意。）
 */
function readMapCoords(raw: unknown): MapCoords | null {
  if (!isRecord(raw)) return null;
  const lat = readNumber(raw.lat, Number.NaN);
  const lon = readNumber(raw.lon, Number.NaN);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

function normalizeMapContent(raw: unknown): CardContent | null {
  if (!isRecord(raw)) return null;
  const path = readString(raw.path);
  const sourceUrl = readString(raw.sourceUrl);
  const coords = readMapCoords(raw.coords);

  // ★ `O08` 之前这里的判据是"必须有图"（没有图的地图卡与没有路径的图片卡一样是个空框）。
  //   贴链接这条路进来之后，只有链接与坐标的卡**不是空框** —— 上面有坐标可看、有链接可点、
  //   还能"再试一次出图"。此时丢掉它，丢的正是用户刚刚粘进来的东西。
  //   三样全没有才是真的空框，那时的处理照旧（整张丢掉）。
  if (path.length === 0 && sourceUrl.length === 0 && coords === null) return null;

  const content: MapContent = { path, label: readString(raw.label), pin: readMapPin(raw.pin) };
  // 空值归成键缺席（与 `NoteContent.variant`、清空 `BoardRefContent.icon` 同一条规矩）：
  // 否则"从没贴过链接"与"贴过又清掉"是两份不同的字节
  if (sourceUrl.length > 0) content.sourceUrl = sourceUrl;
  if (coords !== null) content.coords = coords;
  return content;
}

/**
 * 同步便签（`T7.04`）。
 *
 * ★ **永不返回 `null`**（除了 `raw` 根本不是对象）：一张正文为空的同步便签与一张
 *   正文为空的普通便签是一回事 —— 都是用户还没落笔的空白纸，不该被丢掉。
 *   （这一点与地图卡/图片卡相反：那两种"没有图"就只剩一个空框，留着没意义。）
 * ★ `key` 为空串是**合法**的（等价于独立便签），所以这里不做任何"缺 key 就丢"的判断。
 */
function normalizeSyncNoteContent(raw: unknown): CardContent | null {
  if (!isRecord(raw)) return null;
  return { key: readString(raw.key), md: readString(raw.md) };
}

/**
 * 评论卡（`T7.05`）。
 *
 * ★ 与同步便签同一条约定：**永不返回 `null`**（除了 `raw` 根本不是对象）——
 *   一张还没写字的评论卡是一张合理的空白卡，不该被丢掉。
 * ★ 逐条丢弃**正文为空**的条目：空条目落在界面上就是一个点不中、也读不出东西的小圆点，
 *   而它不承载任何信息（正文才是用户写下的东西，时间戳是它的附属）。
 *   这与待办项的取舍相反 —— 那边空行是"用户正在输入的一行"，必须留着。
 * ★ 时间戳读不出来时记 `0`（渲染成"时间未知"），**不丢这一条**：正文在，条目就该在。
 */
function normalizeCommentContent(raw: unknown): CardContent | null {
  if (!isRecord(raw)) return null;
  const entries: CommentEntry[] = [];
  if (Array.isArray(raw.entries)) {
    for (const item of raw.entries) {
      if (!isRecord(item)) continue;
      const text = readString(item.text);
      if (text.trim().length === 0) continue;
      entries.push({
        id: readId(item.id, ID_PREFIX.comment),
        text,
        at: readNumber(item.at, 0),
      });
    }
  }
  return { entries, resolved: readBoolean(raw.resolved, false) };
}

/**
 * 仅标题卡（`A3`）的内容归一：只有一个 `text`。
 *
 * ★ 从前还有 `shape` / `tail`（纯圆角 ⇄ 带气泡），用户 2026-09-18 要求去掉气泡那一档 ⇒
 *   这两个键**不再读**（旧文件里残留的值会在下一次落盘时自然消失，不影响任何别的字段）。
 * ★ `text` 允许空串：新建的那张本来就是空的，等着双击写第一句。
 */
function normalizeTitleCardContent(raw: unknown): CardContent | null {
  if (!isRecord(raw)) return null;
  return { text: readString(raw.text) };
}

/**
 * 图集卡（`A4`）的内容归一。
 *
 * ★ 路径逐个归一、**空串直接丢掉**：一张图集卡里混进一个空路径，画面上就是"一格空白" ——
 *   宁可少一格，也不要一格点不开的方框。
 * ★ `index` 夹进合法范围：文件里写着 9 而只有 3 张图时回落成 0（第一张）——
 *   让卡面一片空白是"打开白板发现某张卡是空的"那种最难查的毛病。
 * ★ 一张图都没有 ⇒ 返回 `null`（这张卡会被判为坏数据、退回占位态），与所有卡片同一条。
 */
function normalizeGalleryContent(raw: unknown): CardContent | null {
  if (!isRecord(raw)) return null;
  const paths: string[] = [];
  if (Array.isArray(raw.paths)) {
    for (const entry of raw.paths) {
      const path = readString(entry);
      if (path.length > 0) paths.push(path);
    }
  }
  if (paths.length === 0) return null;

  const content: { paths: string[]; index?: number } = { paths };
  const clamped = Math.min(paths.length - 1, Math.max(0, Math.floor(readNumber(raw.index, 0))));
  // 第一张是默认那一档 ⇒ 不写这个键（与 `rotation` / `showBorder` 同一条纪律）
  if (clamped > 0) content.index = clamped;
  return content;
}

const CONTENT_NORMALIZERS: {
  [K in CardType]: (raw: unknown) => CardContent | null;
} = {
  note: normalizeNoteContent,
  noteRef: normalizeNoteRefContent,
  image: normalizeImageContent,
  file: normalizeFileContent,
  // 视频卡（`A1`）：内容形状与文件卡**一模一样**（就一个路径）⇒ 复用同一个归一函数。
  // ★ 复用而不是复制：两边各写一份的话，"视频卡的路径算不算合法"迟早出现两种答案
  //   （比如将来给路径加一条"必须在库内"的校验，只改一处就会漏掉另一半）
  video: normalizeFileContent,
  // 音频卡（`A2`）：与文件卡 / 视频卡同一个内容形状（一个路径）⇒ 同一个归一函数
  audio: normalizeFileContent,
  // PDF 预览卡（`F8`）：同上（一个路径）
  pdf: normalizeFileContent,
  // `.canvas` 预览卡（`F6`）：同上（一个路径）
  canvas: normalizeFileContent,
  // 脑图卡（`F3a`）：同上（一个路径，指向一份 `.nestmind`）
  mindRef: normalizeFileContent,
  // 内嵌脑图卡（`F4`）：内容里装着**整份脑图模型**（见上面的 `normalizeMindContent`）
  mind: normalizeMindContent,
  // 仅标题卡（`A3`）：一行字 + 两档样式
  titleCard: normalizeTitleCardContent,
  // 图集卡（`A4`）：一串图片路径 + 当前看的是第几张
  gallery: normalizeGalleryContent,
  link: normalizeLinkContent,
  todo: normalizeTodoContent,
  swatch: normalizeSwatchContent,
  boardRef: normalizeBoardRefContent,
  ink: normalizeInkContent,
  map: normalizeMapContent,
  syncNote: normalizeSyncNoteContent,
  comment: normalizeCommentContent,
};

// ─────────────────────────────────────────────────────────────
// 卡片 / 分栏 / 连线 / 编组
// ─────────────────────────────────────────────────────────────

function normalizeCard(
  raw: unknown,
  index: number,
  issues: IssueCollector,
  seenIds: Set<string>,
): Card | null {
  const path = `cards[${index}]`;
  if (!isRecord(raw)) {
    issues.dropped(path, '不是对象');
    return null;
  }

  const type = raw.type;
  if (!isCardType(type)) {
    issues.dropped(path, `未知卡片类型 ${JSON.stringify(raw.type)}`);
    return null;
  }

  const content = CONTENT_NORMALIZERS[type](raw.content);
  if (content === null) {
    issues.dropped(path, `${type} 卡片内容非法`);
    return null;
  }

  // ★ 仅标题卡（`A3`，用户 2026-09-18："应该直接展示标题文字"）：那行字以**卡片标题**
  //   （`CardBase.title`）为准。旧版把同一句话存在 `content.text` 里 —— 打开旧文件时
  //   顺手搬过去（迁完把 `text` 清空），老卡片一个字都不丢。新写的走标题，两边不会再打架。
  let title = readString(raw.title);
  if (type === 'titleCard') {
    const legacy = (content as unknown as { text?: unknown }).text;
    if (title.length === 0 && typeof legacy === 'string' && legacy.length > 0) {
      title = legacy;
      (content as unknown as { text: string }).text = '';
    }
  }

  let id = readId(raw.id, ID_PREFIX.card);
  if (typeof raw.id !== 'string' || raw.id.length === 0) {
    issues.fixed(`${path}.id`, '缺少 id，已生成');
  } else if (seenIds.has(id)) {
    issues.fixed(`${path}.id`, 'id 重复，已重新生成');
    id = createId(ID_PREFIX.card);
  }
  seenIds.add(id);

  const size = DEFAULT_CARD_SIZES[type];
  const columnId =
    typeof raw.columnId === 'string' && raw.columnId.length > 0 ? raw.columnId : null;

  // `O38`：卡面标记与标题整条格式（两条都是**可选键**，缺省一个字节都不写 —— 纪律 2）
  const icon = readCardIcon(raw.icon);
  const titleStyle = readTitleStyle(raw.titleStyle);

  const card = {
    id,
    type,
    x: readNumber(raw.x, 0),
    y: readNumber(raw.y, 0),
    width: readPositiveNumber(raw.width, size.width),
    height: readPositiveNumber(raw.height, size.height),
    rotation: readRotation(raw.rotation),
    z: readNumber(raw.z, 1),
    columnId,
    order: readNumber(raw.order, index),
    color: readColor(raw.color, '1'),
    accent: readAccent(raw.accent),
    locked: readBoolean(raw.locked, false),
    showTitle: readBoolean(raw.showTitle, false),
    title,
    presentStep: readPresentStep(raw.presentStep),
    content,
    // `O31`：收起态。**只在真的收起时写这个键**（缺省 = 展开），旧文件一个字不动
    ...(readBoolean(raw.collapsed, false) ? { collapsed: true } : {}),
    // `F7`：树折叠（折叠子级 ⇒ +N）。与 `collapsed` 同一条"缺席不写键"的纪律
    ...(readBoolean(raw.treeCollapsed, false) ? { treeCollapsed: true } : {}),
    // 图片卡的"要不要边框"（2026-09-17）：**缺省 = 有边框** ⇒ 同样只在关掉过时写这个键
    ...(readBoolean(raw.showBorder, true) ? {} : { showBorder: false }),
    // `O38`：卡面标记 + 标题整条格式。两条都是可选键，缺省一个字节都不写
    ...(icon ? { icon } : {}),
    ...(titleStyle ? { titleStyle } : {}),
  };

  // mini 白板卡的尺寸由**形态**钉死（`O18`）。三方必须一致：
  //   * 读入口（这里）—— 把存量卡片与手改文件一起归一；
  //   * 写入口（`view/BoardView.setBoardRefPreview`）—— 选到 mini 档就当场钉住；
  //   * 样式表 —— 手柄在 mini 卡上不出现，用户根本拖不了。
  // 少任何一处，用户看到的都是"菜单里选 mini 是正方形、重开白板又变回长方形"。
  // ★ `O09` 那一版的 mini 是"用户拉多大就多大"的（它当时只是"再少两行字的缩略图"），
  //   所以存量文件里确实有非正方形的 mini 卡 —— 这条归一不是防御性代码，是真在修数据。
  // ★ 只认 mini：另外三档的尺寸完全归用户，一个像素都不动。
  const asCard = card as Card;
  if (asCard.type === 'boardRef' && asCard.content.preview === 'mini') {
    if (
      asCard.width !== BOARD_REF_MINI_SIZE.width ||
      asCard.height !== BOARD_REF_MINI_SIZE.height
    ) {
      asCard.width = BOARD_REF_MINI_SIZE.width;
      asCard.height = BOARD_REF_MINI_SIZE.height;
      issues.fixed(
        path,
        `白板卡 mini 形态应为 ${BOARD_REF_MINI_SIZE.width}×${BOARD_REF_MINI_SIZE.height} 正方形，已修正尺寸`,
      );
    }
  }

  // 转过的卡片才留 `rotation` 这个键：`0` 抹掉（与 `applyCardRotations` 同一约定）——
  // "没转过"是绝大多数卡片的状态，落一个 `"rotation": 0` 进文件只会让 diff 变脏
  if (card.rotation === 0) delete (card as { rotation?: number }).rotation;

  // 唯一的类型断言点：content 已按 type 校验过形状，此处只是把"运行期判别"告诉编译器
  return card as Card;
}

function normalizeColumn(raw: unknown, index: number, issues: IssueCollector): Column | null {
  const path = `columns[${index}]`;
  if (!isRecord(raw)) {
    issues.dropped(path, '不是对象');
    return null;
  }
  return {
    id: readId(raw.id, ID_PREFIX.column),
    title: readString(raw.title),
    x: readNumber(raw.x, 0),
    y: readNumber(raw.y, 0),
    width: readPositiveNumber(raw.width, DEFAULT_COLUMN_SIZE.width),
    height: readPositiveNumber(raw.height, DEFAULT_COLUMN_SIZE.height),
    collapsed: readBoolean(raw.collapsed, false),
    // ★ 分栏默认白色（用户 2026-09-18）；旧文件里没有 `color` 键时回落到白
    color: readColor(raw.color, '#ffffff'),
    z: readNumber(raw.z, 1),
  };
}

const EDGE_SIDES: readonly EdgeSide[] = ['top', 'right', 'bottom', 'left', null];

/**
 * 读一个世界坐标。缺字段 / 非有限数 → `null`。
 *
 * ★ 坐标**不给默认值**：`{ x: 0, y: 0 }` 看着"有值"，实际会把自由端钉在画布
 *   原点 —— 用户看到的是"这条线莫名其妙指向左上角"，比干脆不画更让人困惑。
 */
function readPoint(raw: unknown): Point | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.x !== 'number' || !Number.isFinite(raw.x)) return null;
  if (typeof raw.y !== 'number' || !Number.isFinite(raw.y)) return null;
  return { x: raw.x, y: raw.y };
}

/**
 * 端点。`cardId` 为空串 = **自由端**（T2.07 / `F3-02`）。
 *
 * 自由端必须带一个有效坐标，否则这条线连落点都没有，只能整条丢掉 ——
 * 这与"端点找不到对象就丢整条边"是同一条纪律（见 `normalizeEdge`）。
 *
 * ★ `cardId` 里装的也可能是**分栏 id**（`O21`）：字段名沿用 `EdgeEndpoint` 的叫法，
 *   这里**不做也不该做**"这到底是卡还是栏"的判断 —— 那是 `normalizeEdge` 拿
 *   两张 id 表一起查的事（在这里判就会把分栏端点弹成本地错误）。
 */
function normalizeEndpoint(raw: unknown): EdgeEndpoint | null {
  if (!isRecord(raw)) return null;
  const side = EDGE_SIDES.includes(raw.side as EdgeSide) ? (raw.side as EdgeSide) : null;
  const cardId = readString(raw.cardId);
  const point = readPoint(raw.point);
  // 脑图里的某个节点（`2.2.0` 批 3）：**照读、不校验**（见 `EdgeEndpoint.nodeId` 那条）——
  // 节点清单在另一份模型里，这一刻 `.nestmind` 可能还没读到；判"悬空"会把好数据删掉。
  // 空串 / 非字符串一律当作"没有这一层"（= 整卡片），与"可选键缺席"同一个待遇。
  const nodeId = readString(raw.nodeId);
  const node = nodeId.length > 0 ? { nodeId } : {};

  if (cardId.length === 0) return point ? { cardId: '', side, point } : null;
  // 绑对象的端点上允许留着 `point`：用户把端点拖离卡片、又拖回卡片时，
  // 那个落点可以直接复用，不必重新算一次（`schema.ts` 有说明）
  return point ? { cardId, side, point, ...node } : { cardId, side, ...node };
}

/**
 * 读一条边。
 *
 * `aliveIds` = **卡片 id ∪ 分栏 id**（`O21`）**∪ 脑图 id**（`2.2.0`）：它们共用
 * `cardId` 一个字段，校验时也就必须共用一张表 —— 少喂一类，指向它的线就会在**读盘时**
 * 被当作"悬空"丢掉（用户那边表现为"连线莫名其妙没了，而且重启一次少一条"）。
 *
 * ★ 校验**到此为止**：端点上的 `nodeId`（脑图里的哪个节点）这里不查 ——
 *   节点清单在另一份模型里，这一刻可能还没读到。理由见 `EdgeEndpoint.nodeId`。
 */
function normalizeEdge(
  raw: unknown,
  index: number,
  issues: IssueCollector,
  aliveIds: Set<string>,
): Edge | null {
  const path = `edges[${index}]`;
  if (!isRecord(raw)) {
    issues.dropped(path, '不是对象');
    return null;
  }
  const from = normalizeEndpoint(raw.from);
  const to = normalizeEndpoint(raw.to);
  if (!from || !to) {
    issues.dropped(path, '端点非法');
    return null;
  }
  // ★ 自由端的 `cardId` 是空串：它**不是**"指向不存在的对象"，不该被这条检查误杀
  //   （一张卡都没连的注释线是有意义的，`F3-02`）
  const dangling = (endpoint: EdgeEndpoint): boolean =>
    !isFreeEndpoint(endpoint) && !aliveIds.has(endpoint.cardId);
  if (dangling(from) || dangling(to)) {
    issues.dropped(path, '端点指向不存在的卡片或分栏');
    return null;
  }

  const fromEnd: EdgeEnd = raw.fromEnd === 'arrow' ? 'arrow' : 'none';
  const toEnd: EdgeEnd = raw.toEnd === 'none' ? 'none' : 'arrow';
  const style: EdgeStyle = raw.style === 'dashed' ? 'dashed' : 'solid';
  // 走线（`F3-08` 加了 `curve`）：认不出来的值一律回落到"直连" ——
  // 与其它枚举同一条纪律（不认识的档位丢掉，不整条线判失败）
  const routing: EdgeRouting =
    raw.routing === 'smart' ? 'smart' : raw.routing === 'curve' ? 'curve' : 'free';
  // 弧度（T7.12）：读不懂 / 全 0 → `null`（直线），**不记 `issues`** ——
  // "这条线是直的"是一个完全正常的答案，不是"数据坏了"
  const curve = normalizeEdgeCurve(raw.curve);

  return {
    id: readId(raw.id, ID_PREFIX.edge),
    from,
    to,
    fromEnd,
    toEnd,
    style,
    color: readColor(raw.color, '1'),
    label: readString(raw.label),
    routing,
    // ★ 缺席就不写这个键（而不是写 `curve: null`）：存量文件读一遍再写回去
    //   必须**逐字节不变**，多一个 `null` 键就把这条纪律破了
    ...(curve ? { curve } : {}),
    // `F7`：树连线标记。缺席不写键（普通线一个字节不变）
    ...(raw.kind === 'tree' ? { kind: 'tree' as const } : {}),
  };
}

function normalizeGroup(raw: unknown, index: number, issues: IssueCollector): Group | null {
  const path = `groups[${index}]`;
  if (!isRecord(raw)) {
    issues.dropped(path, '不是对象');
    return null;
  }
  const cardIds = readStringArray(raw.cardIds);
  // 分栏成员（用户 2026-09-16）：与卡片成员并列。**只放分栏也能成组** ——
  // 所以"空组"的判据是两类成员加起来为 0，而不是单看 `cardIds`。
  const columnIds = readStringArray(raw.columnIds);
  if (cardIds.length + columnIds.length === 0) {
    issues.dropped(path, '编组为空');
    return null;
  }
  return {
    id: readId(raw.id, ID_PREFIX.group),
    cardIds,
    // ★ 缺席就不写这个键（纪律 2）：存量文件里全是"只有卡片成员"的组，
    //   补一个 `columnIds: []` 会让"读一遍写回去逐字节不变"当场破功
    ...(columnIds.length > 0 ? { columnIds } : {}),
    label: readString(raw.label),
    // ★ 收起（O03）：**只有真的是 `true` 才写这个键**（与上面 `curve` 同一条理由）。
    //   这边比 `curve` 更严格：读不懂的值（`"yes"` / `1`）一律当"展开"，
    //   而不是按真值转换 —— "这一堆卡片要不要藏起来"是个看得见的状态，
    //   猜错方向的代价（一屏卡突然不见了）远大于"按用户写的原样来"。
    ...(raw.collapsed === true ? { collapsed: true } : {}),
  };
}

// ─────────────────────────────────────────────────────────────
// 顶层
// ─────────────────────────────────────────────────────────────

const BACKGROUNDS: readonly BoardBackground[] = ['plain', 'dots', 'grid', 'none'];

function normalizeMeta(raw: unknown, issues: IssueCollector): BoardMeta {
  const source = isRecord(raw) ? raw : {};
  if (!isRecord(raw)) issues.fixed('meta', 'meta 非法，已用默认值重建');

  const now = new Date().toISOString();
  const icon = typeof source.icon === 'string' && source.icon.length > 0 ? source.icon : null;
  const parent =
    typeof source.parent === 'string' && source.parent.length > 0 ? source.parent : null;

  return {
    id: readId(source.id, ID_PREFIX.board),
    title: readString(source.title),
    icon,
    createdAt: readString(source.createdAt, now),
    updatedAt: readString(source.updatedAt, now),
    parent,
    tags: readStringArray(source.tags),
    aliases: readStringArray(source.aliases),
  };
}

function normalizeView(raw: unknown, issues: IssueCollector): BoardFile['view'] {
  const source = isRecord(raw) ? raw : {};
  if (!isRecord(raw)) issues.fixed('view', 'view 非法，已用默认值重建');
  const background = BACKGROUNDS.includes(source.background as BoardBackground)
    ? (source.background as BoardBackground)
    : 'dots';
  const zoom = readPositiveNumber(source.zoom, 1);
  return {
    x: readNumber(source.x, 0),
    y: readNumber(source.y, 0),
    zoom: Math.min(8, Math.max(0.05, zoom)),
    background,
  };
}

function normalizeSettings(raw: unknown, issues: IssueCollector): BoardSettings {
  const source = isRecord(raw) ? raw : {};
  if (!isRecord(raw)) issues.fixed('settings', 'settings 非法，已用默认值重建');
  return {
    snapToGrid: readBoolean(source.snapToGrid, true),
    gridSize: Math.max(1, readNumber(source.gridSize, 16)),
    defaultCardColor: readColor(source.defaultCardColor, '1'),
    readOnly: readBoolean(source.readOnly, false),
  };
}

/** 读取数组字段；缺失 → 空数组（记 fixed），存在但类型不对 → 空数组（记 dropped） */
function readArrayField(
  source: Record<string, unknown>,
  key: 'cards' | 'columns' | 'edges' | 'groups',
  issues: IssueCollector,
): unknown[] {
  const value = source[key];
  if (value === undefined) {
    issues.fixed(key, `${key} 缺失，已视为空数组`);
    return [];
  }
  if (!Array.isArray(value)) {
    issues.dropped(key, `${key} 不是数组，已视为空数组`);
    return [];
  }
  return value;
}

/**
 * 信封级判定：**这看起来是不是一块白板**。
 *
 * ★ 单独导出是给"迁移之前"用的（T4.03）：`migrateBoardFile` 会给**任何**对象盖上当前
 *   `spec` / `version`（那是为了容忍手写与精简文件），所以迁移之后再判就永远为真 ——
 *   `{"hello":"world"}` 也会被规范化成"一块 0 张卡的白板"。判定必须在盖章之前做。
 */
// ─────────────────────────────────────────────────────────────
// 脑图容器（`2.2.0`）：白板级的"一棵树"
// ─────────────────────────────────────────────────────────────

/**
 * 读一个**脑图容器**（`Mind`）：与卡片 / 分栏 / 编组平级的白板对象。
 *
 * ★ 模型那一份交给**脑图自己的校验器**（`normalizeMindFile`）：同一个形状在 `.nestmind`
 *   与白板里必须是同一套读法（与 `normalizeMindContent` 那条理由一致）。
 * ★ 内嵌模型读不出来时**保留容器、里面放一张全新的空脑图**（不是丢掉这一棵）：
 *   与内嵌脑图卡同一条取舍 —— 用户写下的东西不该因为一次解析失败整棵消失，
 *   原数据仍在 `.nboard` 里（懒迁移：文件本身要等用户编辑才会被改写）。
 * ★ `path` 非空 = 文件脑图：模型不在这里（渲染时去读那个 `.nestmind`），所以**不碰 `mind`**。
 */
function normalizeMindContainer(
  raw: unknown,
  index: number,
  issues: IssueCollector,
  seenIds: Set<string>,
): Mind | null {
  if (!isRecord(raw)) {
    issues.dropped(`minds[${index}]`, '不是对象');
    return null;
  }
  const id = readString(raw.id);
  if (id.length === 0) {
    issues.dropped(`minds[${index}]`, '缺少 id');
    return null;
  }
  if (seenIds.has(id)) {
    issues.dropped(`minds[${index}]`, 'id 重复');
    return null;
  }
  seenIds.add(id);

  const path = readString(raw.path);
  const mind: Mind = {
    id,
    x: readNumber(raw.x, 0),
    y: readNumber(raw.y, 0),
    z: Math.round(readNumber(raw.z, 0)),
    path,
  };
  // 只读（缺席 = 可编辑）：与 `rotation` / `locked` 同一条纪律 —— 不补 `false`
  if (readBoolean(raw.locked, false)) mind.locked = true;

  // 演示步骤号（`2.2.0` 收尾 · 演示对接）：**设过才写这个键**（缺席 = 不在演示路径里）。
  // ★ 漏掉这一行的后果不是"少一栏"：树上的步骤号会在存盘后**整个消失**，
  //   表现为"编好顺序、重开白板又乱了" —— 所以它与 `locked` 一样必须在这里接住。
  const presentStep = readPresentStep(raw.presentStep);
  if (presentStep !== null) mind.presentStep = presentStep;

  if (path.length === 0) {
    const parsed = normalizeMindFile(raw.mind);
    if (parsed.ok) {
      mind.mind = parsed.file;
    } else {
      mind.mind = createMindFile({ branches: INLINE_MIND_BRANCHES, title: '' });
      issues.fixed(
        `minds[${index}].mind`,
        '读不出这份脑图，已保留容器并放入一张空脑图（原数据仍在文件里）',
      );
    }
  }
  return mind;
}

/**
 * **老脑图卡 → 容器**（读时转换，`12 §4.5`）。
 *
 * 认这两种：
 * * `mindRef`（`F3a`：卡的 `content.path` 指向一份 `.nestmind`）→ 容器带 `path`；
 * * `mind`（`F4`：整份模型在卡里）→ 容器内嵌 `mind`。
 *
 * ★ **容器沿用那张卡的 id**：断在它身上的连线（`EdgeEndpoint.cardId`）因此不用改 ——
 *   端点本来就只认"一个白板级 id"（分栏就是这么加进来的），这一条让迁移不丢连线。
 * ★ 位置：**根节点中心落在原卡中心**。内嵌卡还能按布局把原来那棵树的位置还原
 *   （树在卡里是居中摆放的）；**文件卡做不到**（这一刻还没读到那份 `.nestmind`），
 *   整棵树会相对原位偏"半个树宽"——用户可以拖，记在 `12 §4.5` 的已知偏差里。
 * ★ 转换**只在内存里**：文件要等用户真的编辑这块板才按新形状写回（懒迁移）。
 */
function mindFromLegacyCard(card: Card, seenIds: Set<string>, issues: IssueCollector): Mind | null {
  if (card.type !== 'mind' && card.type !== 'mindRef') return null;
  const content = card.content as { path?: unknown; mind?: unknown };
  const mind: Mind = {
    // 见上：沿用卡的 id，连线断不了
    id: card.id,
    x: roundTo(card.x + card.width / 2),
    y: roundTo(card.y + card.height / 2),
    z: card.z,
    path: card.type === 'mindRef' ? readString(content.path) : '',
  };
  if (card.locked) mind.locked = true;

  if (mind.path.length === 0) {
    const parsed = normalizeMindFile(content.mind);
    mind.mind = parsed.ok
      ? parsed.file
      : createMindFile({ branches: INLINE_MIND_BRANCHES, title: '' });
    if (parsed.ok) {
      // 把"根节点在原来那张卡里落在哪"还原出来：卡里那棵树是按**整体包围盒**居中摆的
      const direction = directionForStructure(parsed.file.view.structure ?? 'logic-right');
      const layout = layoutMind(parsed.file, { direction });
      const root = layout.boxes.get(parsed.file.rootId);
      if (root && layout.bounds) {
        mind.x = roundTo(
          mind.x + (root.x + root.width / 2 - (layout.bounds.x + layout.bounds.width / 2)),
        );
        mind.y = roundTo(
          mind.y + (root.y + root.height / 2 - (layout.bounds.y + layout.bounds.height / 2)),
        );
      }
    }
  }
  seenIds.add(mind.id);
  issues.fixed(`card ${card.id}`, '脑图卡已转为白板级脑图（`2.2.0`）');
  return mind;
}

export function looksLikeBoardFile(input: unknown): input is Record<string, unknown> {
  if (!isRecord(input)) return false;
  return (
    Array.isArray(input.cards) ||
    Array.isArray(input.columns) ||
    isRecord(input.meta) ||
    typeof input.spec === 'string'
  );
}

/**
 * 把任意 `unknown` 规范化为合法 `BoardFile`。
 * @returns `null` 表示"这根本不是一块白板" —— 调用方必须进入只读保护态，不得写回。
 */
export function normalizeBoardFile(input: unknown): NormalizedBoard | null {
  if (!looksLikeBoardFile(input)) return null;

  const issues = new IssueCollector();

  if (input.spec !== BOARD_SPEC) {
    issues.fixed('spec', `spec 为 ${JSON.stringify(input.spec)}，已按 ${BOARD_SPEC} 处理`);
  }
  if (input.version !== BOARD_VERSION) {
    issues.fixed(
      'version',
      `version 为 ${JSON.stringify(input.version)}，已按 ${BOARD_VERSION} 处理`,
    );
  }

  const seenCardIds = new Set<string>();
  const cards: Card[] = [];
  readArrayField(input, 'cards', issues).forEach((entry, index) => {
    const card = normalizeCard(entry, index, issues, seenCardIds);
    if (card) cards.push(card);
  });

  const columns: Column[] = [];
  const columnIds = new Set<string>();
  readArrayField(input, 'columns', issues).forEach((entry, index) => {
    const column = normalizeColumn(entry, index, issues);
    if (!column) return;
    if (columnIds.has(column.id)) {
      issues.fixed(`columns[${index}].id`, 'id 重复，已丢弃该分栏');
      return;
    }
    columnIds.add(column.id);
    columns.push(column);
  });

  // 非法状态修复：指向不存在分栏的卡片一律"释放到画布上"，而不是丢掉卡片（内容优先）
  cards.forEach((card) => {
    if (card.columnId !== null && !columnIds.has(card.columnId)) {
      issues.fixed(`card ${card.id}.columnId`, '指向不存在的分栏，已释放到画布');
      card.columnId = null;
    }
  });

  // ── 脑图（`2.2.0`）：白板级容器 ─────────────────────────────
  // 顺序：先读 `minds`，再把老的两种脑图卡**就地转成**容器（读时转换）。
  // ★ 转换必须在这里做完 —— 后面建连线端点集合、编组成员、导出都要看到"最终的一类对象"。
  const minds: Mind[] = [];
  const mindIds = new Set<string>();
  // ★ 这里**不走 `readArrayField`**：那个读法对"缺键"也会记一条 `fixed`，
  //   而 `minds` 是**可选键**（绝大多数板子没有脑图）—— 让每块板都多一条"minds 缺失"
  //   的噪声，等于把真正的异常淹掉。于是就地读：缺键 = 空数组、**不记**；
  //   类型不对才记一条 dropped。
  const rawMinds = input.minds;
  if (rawMinds !== undefined && !Array.isArray(rawMinds)) {
    issues.dropped('minds', 'minds 不是数组，已视为没有脑图');
  }
  if (Array.isArray(rawMinds)) {
    rawMinds.forEach((entry, index) => {
      const mind = normalizeMindContainer(entry, index, issues, mindIds);
      if (mind) minds.push(mind);
    });
  }

  const keptCards: Card[] = [];
  for (const card of cards) {
    const migrated = mindFromLegacyCard(card, mindIds, issues);
    if (migrated) {
      minds.push(migrated);
      continue;
    }
    keptCards.push(card);
  }
  cards.length = 0;
  cards.push(...keptCards);

  // ★ 连线的合法端点是**卡片 ∪ 分栏 ∪ 脑图**（`O21` / `2.2.0`）：三张表在这里拼齐，
  //   再交给 `normalizeEdge`。脑图必须算进来 —— 否则"指着某棵脑图的线"会被当成悬空丢掉，
  //   而迁移恰恰**沿用了原卡的 id**，正是为了让这些线活下来。
  const aliveIds = new Set<string>([...seenCardIds, ...columnIds, ...mindIds]);
  const edges: Edge[] = [];
  readArrayField(input, 'edges', issues).forEach((entry, index) => {
    const edge = normalizeEdge(entry, index, issues, aliveIds);
    if (edge) edges.push(edge);
  });

  const groups: Group[] = [];
  // ★ 编组的成员只认**卡片**（与连线不同）：一张脑图卡迁移成容器之后，它不再是卡片，
  //   于是它从编组里退出（连线照旧活着 —— 那是"指着谁"的关系，编组是"一起选中"的关系）。
  const aliveCardIds = new Set(cards.map((card) => card.id));
  readArrayField(input, 'groups', issues).forEach((entry, index) => {
    const group = normalizeGroup(entry, index, issues);
    if (!group) return;
    const kept = group.cardIds.filter((cardId) => aliveCardIds.has(cardId));
    if (kept.length !== group.cardIds.length) {
      issues.fixed(`groups[${index}].cardIds`, '移除了不存在的成员');
    }
    if (kept.length === 0) {
      issues.dropped(`groups[${index}]`, '成员全部不存在');
      return;
    }
    groups.push({ ...group, cardIds: kept });
  });

  return {
    board: {
      spec: BOARD_SPEC,
      version: BOARD_VERSION,
      revision: Math.max(0, Math.round(readNumber(input.revision, 0))),
      meta: normalizeMeta(input.meta, issues),
      view: normalizeView(input.view, issues),
      settings: normalizeSettings(input.settings, issues),
      columns,
      cards,
      edges,
      groups,
      // ★ 可选键：**没有脑图就不写这个键**（与 `rotation` / `curve` 同一条纪律）——
      //   于是"没有脑图的板子"读一遍写回去逐字节不变，老插件也读得懂（版本号同理，
      //   见 `io/BoardRepository.serializeBoard`）。
      ...(minds.length > 0 ? { minds } : {}),
    },
    issues: issues.issues,
  };
}

/** 从原始文本一步到位：JSON 解析 + 规范化（迁移见 `io/migrate.ts`，由 Repository 串起来） */
export function parseBoardJson(raw: string): ParseBoardResult {
  const json = safeJsonParse(raw);
  if (!json.ok) return { ok: false, reason: 'invalid-json' };
  const normalized = normalizeBoardFile(json.value);
  if (!normalized) return { ok: false, reason: 'not-a-board' };
  return { ok: true, board: normalized.board, issues: normalized.issues };
}
