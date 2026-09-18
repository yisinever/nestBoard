/**
 * 脑图反序列化容错与非法状态修复（`06 §3.3`）。
 *
 * 三条原则（与白板 `model/validate.ts` 逐条对应）：
 *
 * 1. **信封严格、条目宽松**：整体不像脑图（不是对象 / 没有 `nodes` 数组 / 没有 `rootId`）
 *    → 判定失败，上层进入只读保护态、**绝不写回**；
 * 2. **单个节点坏掉不牵连整份文件**：只丢那一个并记账，其余内容照常读出 ——
 *    用户宁可丢一个节点，也不愿整份脑图打不开；
 * 3. **所有修复都留痕**：返回 `issues` 供上层提示"已修复 N 处 / 丢弃 N 项"。
 *
 * ★ 纯逻辑：不 import `obsidian`、不碰 DOM、数值一律过 `Number.isFinite`
 *   （JSON 里 `null`、字符串数字、`NaN` 都见过）。
 *
 * ★ 两处刻意的"从白板拿东西"（**只有类型与纯常量**，不碰白板的运行时设施）：
 *   `BoardBackground` / `BOARD_BACKGROUNDS` 与"什么算一个合法颜色"的判据
 *   （`isHexColor` / `isThemeColor`）—— 两边语义逐字相同，各抄一份只会漂移。
 *   这也是 `06 §2` 边界允许的：共用的是 `model/schema` 这种纯数据模块，不是 `view/` / `cards/`。
 */

import { ID_PREFIX, MIND_SPEC, MIND_VERSION } from '../../constants';
import { createId } from '../../util/id';
import { normalizeIcon } from '../../util/emoji';
import { BOARD_BACKGROUNDS, isHexColor, isThemeColor } from '../../model/schema';
import type { BoardBackground, CardColor } from '../../model/schema';
import type { ValidationIssue } from '../../model/validate';
import type {
  MindFile,
  MindLink,
  MindMeta,
  MindNode,
  MindNodeStyle,
  MindProp,
  MindRef,
  MindViewState,
} from './schema';
import {
  isFreeNode,
  isMindEdgeStyle,
  isMindPropValue,
  isMindRefKind,
  isMindStructure,
  normalizeLinkBend,
} from './schema';

// ─────────────────────────────────────────────────────────────
// 结果类型
// ─────────────────────────────────────────────────────────────

export type MindParseFailureReason = 'invalid-json' | 'not-a-mind';

export type ParseMindResult =
  | { ok: true; file: MindFile; issues: ValidationIssue[] }
  | { ok: false; reason: MindParseFailureReason };

export interface NormalizedMind {
  file: MindFile;
  issues: ValidationIssue[];
}

// ─────────────────────────────────────────────────────────────
// 基础读取器
// ─────────────────────────────────────────────────────────────

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 一个四行的 `JSON.parse` 兜底。
 *
 * ★ 不复用白板的 `safeJsonParse`：那会把白板的**整份校验器**（它牵连 factories / edges /
 *   schema 一长串）拉进脑图的模块图 —— 而 `06 §2` 要的正是"两个文档类型只在纯数据模块上相遇"。
 *   代价是这四行，值。
 */
export function safeJsonParse(raw: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch {
    return { ok: false };
  }
}

function readString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function readNumber(value: unknown, fallback: number): number {
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) ? num : fallback;
}

/** 属性 / 次序这类"必须是自然数"的字段：负号、小数都归一到合法值 */
function readCount(value: unknown, fallback: number): number {
  const num = readNumber(value, fallback);
  return num >= 0 ? Math.floor(num) : fallback;
}

function readColor(value: unknown): CardColor | undefined {
  if (typeof value !== 'string') return undefined;
  return isHexColor(value) || isThemeColor(value) ? value : undefined;
}

function readBackground(value: unknown, issues: ValidationIssue[]): BoardBackground {
  if (typeof value === 'string' && (BOARD_BACKGROUNDS as readonly string[]).includes(value)) {
    return value as BoardBackground;
  }
  if (value !== undefined) {
    issues.push({
      path: 'view.background',
      message: '不认识的画布背景，已改用点阵',
      action: 'fixed',
    });
  }
  return 'dots';
}

// ─────────────────────────────────────────────────────────────
// 整份文件
// ─────────────────────────────────────────────────────────────

/**
 * 读一份 `.nestmind`：失败 = `{ ok: false }`（上层只读保护），成功 = 规范化后的文件 + `issues`。
 *
 * ★ 幂等是硬要求：`normalize(normalize(x).file)` 必须**零 issue**。
 *   它是"读一遍写回去逐字节不变"的代理判据，也是这条纪律唯一的自动检查手段
 *   （没有序列化器的时候，幂等就是能测的那个等价物）。
 */
export function normalizeMindFile(
  raw: unknown,
): { ok: false; reason: MindParseFailureReason } | ({ ok: true } & NormalizedMind) {
  if (!isRecord(raw)) return { ok: false, reason: 'not-a-mind' };
  // 信封三件套：节点表是数组、中心主题有个 id。缺任何一件都不猜
  if (!Array.isArray(raw.nodes)) return { ok: false, reason: 'not-a-mind' };
  if (typeof raw.rootId !== 'string') return { ok: false, reason: 'not-a-mind' };

  const issues: ValidationIssue[] = [];
  const file: MindFile = {
    spec: readString(raw.spec, MIND_SPEC),
    version: readNumber(raw.version, MIND_VERSION),
    revision: readCount(raw.revision, 0),
    meta: readMeta(raw.meta, issues),
    view: readView(raw.view, issues),
    rootId: raw.rootId,
    nodes: [],
  };

  // ① 逐条读节点：坏的丢、重复的丢，都留痕
  const seen = new Set<string>();
  const byId = new Map<string, MindNode>();
  raw.nodes.forEach((entry: unknown, index: number) => {
    const path = `nodes[${index}]`;
    const node = readNode(entry, path, issues);
    if (!node) return;
    if (seen.has(node.id)) {
      issues.push({ path, message: `重复的节点 id：${node.id}`, action: 'dropped' });
      return;
    }
    seen.add(node.id);
    byId.set(node.id, node);
    file.nodes.push(node);
  });

  // ② 中心主题必须存在、且不能挂在别人下面（挂上去立刻就是一个环）
  const root = ensureRoot(file, byId, issues);
  file.rootId = root.id;

  // ③ 父指针悬空 / 自指 → 降级为悬浮节点（**保住内容**，别丢）
  for (const node of file.nodes) {
    if (node.id === file.rootId || node.parentId === null) continue;
    const parent = byId.get(node.parentId);
    if (!parent || parent.id === node.id) {
      issues.push({
        path: `nodes(${node.id}).parentId`,
        message: '父节点不在了（或指向自己），已改为悬浮节点',
        action: 'fixed',
      });
      node.parentId = null;
    }
  }

  breakCycles(file, issues);
  fixFreePositions(file, issues);
  normalizeOrder(file, issues);

  // 关联线（`N1`）放在**最后**读：它要按节点表判"两端还在不在"，得等节点都归一化完
  //（上面几步会把坏父节点改成悬浮节点、把环拆开 —— 那之后剩下的才是真节点）
  const links = readLinks(raw.links, byId, issues);
  if (links.length > 0) file.links = links;

  // 聚焦（`N3-e`）：目标不在这棵树上 ⇒ **丢掉这个键**（"没聚焦"本身是一个能站住的状态，
  // 不像 `links` 那样必须整条丢）。★ 纪律 2：丢掉之后就不再写回去。
  if (file.view.focus !== undefined && !byId.has(file.view.focus)) {
    issues.push({
      path: 'view.focus',
      message: '聚焦的节点不存在，已回到整棵树',
      action: 'fixed',
    });
    delete file.view.focus;
  }

  return { ok: true, file, issues };
}

/**
 * 关联线（`N1`）：**两端都在**节点表里才留。
 *
 * ★ 端点不在 ⇒ **整条丢掉**（与"父节点不在了就改成悬浮节点"不同：关联线没有"降级"的形态，
 *   留一条半截线只会逼渲染层去防一个不存在的框）。
 * ★ `from === to` 也丢掉：自连没有意义（交互层压根不让连，文件里手写了也当坏的）。
 * ★ 坏掉的数量**整批记一条**（与属性 / 引用同一条），不逐条刷屏。
 * ★ 纪律 2 照旧：`label` 归一化后为空、`arrow` 不认识 ⇒ **不写那个键**。
 */
function readLinks(
  raw: unknown,
  byId: ReadonlyMap<string, MindNode>,
  issues: ValidationIssue[],
): MindLink[] {
  if (!Array.isArray(raw)) {
    if (raw !== undefined) {
      issues.push({ path: 'links', message: '关联线不是一个数组，已忽略', action: 'fixed' });
    }
    return [];
  }

  const links: MindLink[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const entry of raw) {
    if (!isRecord(entry)) {
      dropped += 1;
      continue;
    }
    const { from, to } = entry;
    if (typeof from !== 'string' || typeof to !== 'string') {
      dropped += 1;
      continue;
    }
    if (!byId.has(from) || !byId.has(to) || from === to) {
      dropped += 1;
      continue;
    }

    const id =
      typeof entry.id === 'string' && entry.id.length > 0 ? entry.id : createId(ID_PREFIX.mindLink);
    // 同一个 id 出现两次 ⇒ 留第一条（与"重复节点丢后面的"同一条）。
    // ★ 注意：**允许**两个节点之间有多条线（不同标签），所以去重只看 id、不看端点对
    if (seen.has(id)) {
      dropped += 1;
      continue;
    }
    seen.add(id);

    const link: MindLink = { id, from, to };
    if (typeof entry.label === 'string' && entry.label.trim().length > 0) link.label = entry.label;
    if (entry.arrow === 'end' || entry.arrow === 'both') link.arrow = entry.arrow;
    // 实线：**只认 `true`** —— 缺席 = 虚线（默认那一档），于是 `false` 与缺席等价、一起丢掉
    if (entry.solid === true) link.solid = true;
    // 弯折（`N1-d`）：读到的值先**归一化**（非数 / 太小 / 太大都过一遍同一处口径）——
    // 太小会被归一成 `null` ⇒ 不写这个键（缺席 = 不弯，纪律 2）
    const bend = normalizeLinkBend(
      isRecord(entry.bend) && typeof entry.bend.x === 'number' && typeof entry.bend.y === 'number'
        ? { x: entry.bend.x, y: entry.bend.y }
        : undefined,
    );
    if (bend) link.bend = bend;
    // 线条颜色（`N1-e`）：只认主题色编号（`'1'`–`'6'`）—— 别的东西（色号 / 数字）一律当没写
    if (isThemeColor(entry.color)) link.color = entry.color;
    links.push(link);
  }

  if (dropped > 0) {
    issues.push({ path: 'links', message: `丢弃了 ${dropped} 条关联线`, action: 'dropped' });
  }
  return links;
}

/** 读一段磁盘文本（含 JSON 解析） */
export function parseMindFile(raw: string): ParseMindResult {
  const parsed = safeJsonParse(raw);
  if (!parsed.ok) return { ok: false, reason: 'invalid-json' };
  const result = normalizeMindFile(parsed.value);
  if (!result.ok) return result;
  return { ok: true, file: result.file, issues: result.issues };
}

// ─────────────────────────────────────────────────────────────
// 各块
// ─────────────────────────────────────────────────────────────

function readMeta(raw: unknown, issues: ValidationIssue[]): MindMeta {
  const record = isRecord(raw) ? raw : {};
  if (!isRecord(raw))
    issues.push({ path: 'meta', message: 'meta 不是一个对象，已重建', action: 'fixed' });

  const id = typeof record.id === 'string' && record.id.length > 0 ? record.id : '';
  if (id.length === 0) {
    issues.push({ path: 'meta.id', message: '缺少稳定 ID，已补一个', action: 'fixed' });
  }
  const title = readString(record.title, '');
  if (record.title !== undefined && typeof record.title !== 'string') {
    issues.push({ path: 'meta.title', message: '标题不是字符串，已置空', action: 'fixed' });
  }

  return {
    id: id.length > 0 ? id : createId(ID_PREFIX.mind),
    title,
    createdAt: readString(record.createdAt, ''),
    updatedAt: readString(record.updatedAt, ''),
  };
}

function readView(raw: unknown, issues: ValidationIssue[]): MindViewState {
  const record = isRecord(raw) ? raw : {};
  const zoom = readNumber(record.zoom, 1);
  const view: MindViewState = {
    x: readNumber(record.x, 0),
    y: readNumber(record.y, 0),
    // 缩放为 0 或负数会让整个视口退化成一个点，且用户没法自己转回来
    zoom: zoom > 0 ? zoom : 1,
    background: readBackground(record.background, issues),
  };

  // 大纲视图（`N3-a`）：**两个布尔都留着**（`false` 是"用户明确切回了树"，
  // 与 `structure` / `edge` 一样属于"这一眼怎么看"）；坏值（字符串 / 数字）丢掉、不补默认
  if (typeof record.outline === 'boolean') view.outline = record.outline;
  else if (record.outline !== undefined) {
    issues.push({ path: 'view.outline', message: '不是布尔值，已忽略', action: 'fixed' });
  }

  // 聚焦（`N3-e`）：这里只按"是不是个非空字符串"收下来 —— 它指向的节点**可能不在**
  // （要等节点表读完才知道），那一步在文件末尾与 `links` 一起做
  if (typeof record.focus === 'string' && record.focus.length > 0) view.focus = record.focus;
  else if (record.focus !== undefined) {
    issues.push({ path: 'view.focus', message: '聚焦的不是一个节点 id，已忽略', action: 'fixed' });
  }

  // ★ 结构与线型：**只认认识的值**，不认识的**丢掉那个键**（不整份文件判失败、也不补默认值）——
  //   丢掉之后视图那边按缺省走，正是"回落"，而文件里那个键下次保存时自然消失。
  if (isMindStructure(record.structure)) view.structure = record.structure;
  else if (record.structure !== undefined) {
    issues.push({
      path: 'view.structure',
      message: '不认识的总体结构，已改用向右的逻辑图',
      action: 'fixed',
    });
  }
  if (isMindEdgeStyle(record.edge)) view.edge = record.edge;
  else if (record.edge !== undefined) {
    issues.push({
      path: 'view.edge',
      message: '不认识的分支线形态，已改用曲线',
      action: 'fixed',
    });
  }

  return view;
}

/** 一个节点；读不出一个"有 id 的对象"就返回 `null`（调用方记 `dropped`） */
function readNode(raw: unknown, path: string, issues: ValidationIssue[]): MindNode | null {
  if (!isRecord(raw)) {
    issues.push({ path, message: '不是一个对象', action: 'dropped' });
    return null;
  }
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (id.length === 0) {
    issues.push({ path, message: '没有 id（或 id 不是字符串）', action: 'dropped' });
    return null;
  }

  const node: MindNode = {
    id,
    text: readString(raw.text, ''),
    note: readString(raw.note, ''),
    parentId: typeof raw.parentId === 'string' && raw.parentId.length > 0 ? raw.parentId : null,
    order: readCount(raw.order, 0),
  };
  if (typeof raw.text !== 'string') {
    issues.push({ path: `${path}.text`, message: '标题不是字符串，已置空', action: 'fixed' });
  }
  if (typeof raw.note !== 'string') {
    issues.push({ path: `${path}.note`, message: '内容不是字符串，已置空', action: 'fixed' });
  }
  if (raw.parentId !== undefined && raw.parentId !== null && node.parentId === null) {
    issues.push({
      path: `${path}.parentId`,
      message: '父指针不是字符串，已按悬浮节点处理',
      action: 'fixed',
    });
  }

  // ★ 只在**真的收起**时写这个键（缺席 = 展开，与 `Group.collapsed` 同一条纪律）
  if (raw.collapsed === true) node.collapsed = true;

  // 完成（`N3-g`）：与 `collapsed` 同一条 —— **只认 `true`**，缺席 / `false` 都不写这个键。
  // ★ 别把坏值（`"yes"` / `1`）当 `true`：那会让"我明明没完成"变成一条删除线，
  //   而它又不像颜色那样有"看不出来"的中间态（要么有线要么没有）
  if (raw.done === true) node.done = true;

  if (isRecord(raw.free)) {
    const free = { x: readNumber(raw.free.x, 0), y: readNumber(raw.free.y, 0) };
    if (!Number.isFinite(raw.free.x) || !Number.isFinite(raw.free.y)) {
      issues.push({ path: `${path}.free`, message: '坐标不是有限数，已归零', action: 'fixed' });
    }
    node.free = free;
  } else if (raw.free !== undefined) {
    issues.push({ path: `${path}.free`, message: '坐标不是一个点，已忽略', action: 'fixed' });
  }

  // 节点标记（`08 §3.1`）：归一化之后为空 = 没有标记 ⇒ **不写这个键**（纪律 2）。
  // ★ 坏值（不是字符串 / 一长串文字）要**留个痕**：静默丢掉的话，用户只会看到
  //   "我明明设了图标怎么没了"（与坏颜色、坏坐标同一条纪律）。
  const icon = normalizeIcon(raw.icon);
  if (icon.length > 0) node.icon = icon;
  else if (raw.icon !== undefined) {
    issues.push({ path: `${path}.icon`, message: '不是一个可用的标记，已忽略', action: 'fixed' });
  }

  const style = readStyle(raw.style, `${path}.style`, issues);
  if (style) node.style = style;
  const props = readProps(raw.props, path, issues);
  if (props.length > 0) node.props = props;
  const refs = readRefs(raw.refs, path, issues);
  if (refs.length > 0) node.refs = refs;

  return node;
}

function readStyle(raw: unknown, path: string, issues: ValidationIssue[]): MindNodeStyle | null {
  if (raw === undefined) return null;
  if (!isRecord(raw)) {
    issues.push({ path, message: '配色不是一个对象，已忽略', action: 'fixed' });
    return null;
  }

  const style: MindNodeStyle = {};
  const color = readColor(raw.color);
  if (color !== undefined) style.color = color;
  else if (raw.color !== undefined) {
    issues.push({ path: `${path}.color`, message: '不认识的颜色，已忽略', action: 'fixed' });
  }

  if (isRecord(raw.override)) {
    const { title, body, ink } = raw.override;
    if (
      readColor(title) !== undefined ||
      readColor(body) !== undefined ||
      readColor(ink) !== undefined
    ) {
      // 三色**要么都写、要么都不写**：部分覆盖会让"这一组色长什么样"没有唯一答案
      issues.push({
        path: `${path}.override`,
        message: '手调配色不完整（三色必须齐），已忽略',
        action: 'fixed',
      });
    } else if (typeof title === 'string' && typeof body === 'string' && typeof ink === 'string') {
      style.override = { title, body, ink };
    }
  }

  // ★ 标题的整条格式（`08 §3.2`）。两句值得留意：
  //   ① `italic` / `underline` 的缺省是**常量** `false` ⇒ 为 `false` 时**删键**（纪律 2）；
  //   ② `bold` 的缺省**取决于层级**（根是加粗的）⇒ `false` 是有意义的值、**必须留住**
  //      （"把中心主题的加粗关掉"就靠它），所以它不适用"与缺省相同就删"那一条。
  for (const key of ['bold', 'italic', 'underline'] as const) {
    const value = raw[key];
    if (value === undefined) continue;
    if (typeof value !== 'boolean') {
      issues.push({ path: `${path}.${key}`, message: '不是一个开关，已忽略', action: 'fixed' });
      continue;
    }
    if (key !== 'bold' && value === false) continue;
    style[key] = value;
  }

  const ink = readColor(raw.ink);
  if (ink !== undefined) style.ink = ink;
  else if (raw.ink !== undefined) {
    issues.push({ path: `${path}.ink`, message: '不认识的标题字色，已忽略', action: 'fixed' });
  }

  // 文字高亮（`N3-f`）：与 `ink` 同一条 —— 认不出来就**丢掉这个键**（不补默认色：
  // "没有高亮"就是没有，补一个浅黄会让用户莫名其妙多出一块底）
  const highlight = readColor(raw.highlight);
  if (highlight !== undefined) style.highlight = highlight;
  else if (raw.highlight !== undefined) {
    issues.push({
      path: `${path}.highlight`,
      message: '不认识的文字高亮色，已忽略',
      action: 'fixed',
    });
  }

  return Object.keys(style).length > 0 ? style : null;
}

function readProps(raw: unknown, path: string, issues: ValidationIssue[]): MindProp[] {
  if (!Array.isArray(raw)) {
    if (raw !== undefined) {
      issues.push({ path: `${path}.props`, message: '属性不是一个数组，已忽略', action: 'fixed' });
    }
    return [];
  }

  const props: MindProp[] = [];
  let dropped = 0;
  for (const entry of raw) {
    if (!isRecord(entry)) {
      dropped += 1;
      continue;
    }
    const key = typeof entry.key === 'string' ? entry.key.trim() : '';
    if (key.length === 0 || !isMindPropValue(entry.value)) {
      dropped += 1;
      continue;
    }
    props.push({
      id:
        typeof entry.id === 'string' && entry.id.length > 0
          ? entry.id
          : createId(ID_PREFIX.mindNode),
      key,
      value: entry.value,
    });
  }
  // ★ 坏属性**整批记一条**而不是逐条记：面板上"一条属性坏了"与"三条坏了"要做的处置是同一件事
  if (dropped > 0) {
    issues.push({ path: `${path}.props`, message: `丢弃了 ${dropped} 条属性`, action: 'dropped' });
  }
  return props;
}

function readRefs(raw: unknown, path: string, issues: ValidationIssue[]): MindRef[] {
  if (!Array.isArray(raw)) {
    if (raw !== undefined) {
      issues.push({ path: `${path}.refs`, message: '引用不是一个数组，已忽略', action: 'fixed' });
    }
    return [];
  }

  const refs: MindRef[] = [];
  let dropped = 0;
  const seen = new Set<string>();
  for (const entry of raw) {
    const okPath = isRecord(entry) && typeof entry.path === 'string' && entry.path.length > 0;
    if (!okPath || !isMindRefKind((entry as Record<string, unknown>).kind)) {
      dropped += 1;
      continue;
    }
    const ref = entry as { kind: MindRef['kind']; path: string; width?: unknown };
    // 同一份文件挂两次没有第二种意思（与色板的"重复格静默去重"同一条）
    if (seen.has(ref.path)) continue;
    seen.add(ref.path);
    refs.push(readRef(ref));
  }
  if (dropped > 0) {
    issues.push({ path: `${path}.refs`, message: `丢弃了 ${dropped} 条引用`, action: 'dropped' });
  }
  return refs;
}

/**
 * 一条引用：`kind` + `path` 已经在上游判过，这里只处理可选的**图片宽度**。
 *
 * ★ 宽度坏了（负数 / 字符串 / `NaN`）就**丢掉这个键**，不丢整条引用 ——
 *   用户最要紧的是"这个文件还挂着"，尺寸是次要的（与 `free` 那种"整条归零"不同）。
 * ★ 纪律 2：没有就是没有，不补默认值（补了会让"读一遍写回去逐字节不变"这条失效）。
 */
function readRef(raw: { kind: MindRef['kind']; path: string; width?: unknown }): MindRef {
  const ref: MindRef = { kind: raw.kind, path: raw.path };
  if (typeof raw.width === 'number' && Number.isFinite(raw.width) && raw.width > 0) {
    ref.width = raw.width;
  }
  return ref;
}

/** 中心主题兜底：没了就用第一个顶层节点顶替，一个都没有就补一个（无论如何都返回一个根） */
function ensureRoot(
  file: MindFile,
  byId: Map<string, MindNode>,
  issues: ValidationIssue[],
): MindNode {
  const existing = byId.get(file.rootId);
  if (existing && existing.parentId === null) return existing;

  if (existing) {
    // 中心主题挂在别人下面 = 立刻成环，直接断开（它是根，本来就不该有父）
    issues.push({
      path: `nodes(${existing.id}).parentId`,
      message: '中心主题不能挂在别的节点下，已断开',
      action: 'fixed',
    });
    existing.parentId = null;
    return existing;
  }

  const fallback = file.nodes.find((node) => node.parentId === null);
  if (fallback) {
    issues.push({
      path: 'rootId',
      message: '中心主题不在了，已改用第一个顶层节点顶替',
      action: 'fixed',
    });
    return fallback;
  }

  // 一个顶层节点都没有：补一个空的中心主题。宁可多一个空节点，也不要一份"没有起点"的脑图
  const created: MindNode = {
    id: createId(ID_PREFIX.mindNode),
    text: '',
    note: '',
    parentId: null,
    order: 0,
  };
  issues.push({
    path: 'rootId',
    message: '一份脑图必须有中心主题，已补一个空节点',
    action: 'fixed',
  });
  file.nodes.push(created);
  byId.set(created.id, created);
  return created;
}

/**
 * 破环：顺着 `parentId` 往上走，撞到自己走过的节点就说明成环。
 *
 * ★ 处理方式是**把当前这个节点改成悬浮**（而不是丢掉整棵子树）：环上的每个节点都有内容，
 *   丢任何一个都是数据损失；悬空后用户还能自己把它拖回去。
 */
function breakCycles(file: MindFile, issues: ValidationIssue[]): void {
  const byId = new Map(file.nodes.map((node) => [node.id, node]));
  for (const start of file.nodes) {
    if (start.parentId === null) continue;
    const seen = new Set<string>([start.id]);
    let cursor = byId.get(start.parentId) ?? null;
    while (cursor) {
      if (seen.has(cursor.id)) {
        issues.push({
          path: `nodes(${start.id}).parentId`,
          message: '父子关系成环，已把这个节点改为悬浮',
          action: 'fixed',
        });
        start.parentId = null;
        break;
      }
      seen.add(cursor.id);
      cursor = cursor.parentId === null ? null : (byId.get(cursor.parentId) ?? null);
    }
  }
}

/**
 * 坐标的归属（`06 §3` 纪律 1）：**只有悬浮节点有 `free`**。
 *
 * ★ 两个方向都要修：
 *   * 挂到树上的节点残留 `free` → 删掉（位置由布局算，留着就是个骗人的旧值）；
 *   * 悬浮节点没有 `free` → 补 `{ 0, 0 }`。这是**语义必需**的默认值（没有坐标它就没有位置），
 *     与 `collapsed` 那种"缺席即默认"不同 —— 所以它是唯一一处允许"补一个键"的地方。
 */
function fixFreePositions(file: MindFile, issues: ValidationIssue[]): void {
  for (const node of file.nodes) {
    if (isFreeNode(node, file.rootId)) {
      if (!node.free) {
        node.free = { x: 0, y: 0 };
        issues.push({
          path: `nodes(${node.id}).free`,
          message: '悬浮节点没有坐标，已放在原点',
          action: 'fixed',
        });
      }
      continue;
    }
    if (node.free) {
      delete node.free;
      issues.push({
        path: `nodes(${node.id}).free`,
        message: '这个节点已经挂在树上了，坐标由布局决定，已删掉旧坐标',
        action: 'fixed',
      });
    }
  }
}

/** 同父节点下的次序重排成 `0..n-1`（按原 `order`、再按 id 破平） */
function normalizeOrder(file: MindFile, issues: ValidationIssue[]): void {
  const groups = new Map<string | null, MindNode[]>();
  for (const node of file.nodes) {
    if (node.id === file.rootId) continue; // 根没有父，不参与排序
    const list = groups.get(node.parentId);
    if (list) list.push(node);
    else groups.set(node.parentId, [node]);
  }

  for (const list of groups.values()) {
    const sorted = [...list].sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1));
    sorted.forEach((node, index) => {
      if (node.order === index) return;
      node.order = index;
      issues.push({
        path: `nodes(${node.id}).order`,
        message: '同一父节点下的次序已重排为连续',
        action: 'fixed',
      });
    });
  }
}
