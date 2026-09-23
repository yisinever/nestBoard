/**
 * 白板变更操作（`03 §7.1` 的 `model/ops.ts`）。
 *
 * 本文件只放**纯函数**：直接就地修改传入的 `BoardFile`，返回"是否真的改动了"。
 * 落盘、事件、`revision` 递增由 `BoardRepository.mutate()` 负责
 * —— 这样这些操作既能在命令层复用，也能在单测里脱库跑。
 *
 * ── 两条贯穿全文件的纪律 ──────────────────────────────────
 *
 * 1. **返回值必须是"是否真的变了"**：选中项本来就压在顶层时若照样重排 z，
 *    会让 `mutate()` 把文件标脏、递增 `revision`、触发一次外部同步 ——
 *    用户只是按了下 `⌘⇧↑` 而已，不该产生任何副作用。所以每个函数都逐字段比对。
 * 2. **写进文件的数字必须 `roundTo`**：`0.30000000000000004` 会让 git diff 变成
 *    天书（`02 §12` 手工回归里"`.nboard` 仍可读"那条就是在说这件事）。
 *
 * 覆盖范围：层级（T1.31）、几何与增删改（T1.35–T1.40）、对齐与等距分布（T3.13）、
 * 编组与取消编组（T3.14）。分栏的自动对齐不在本文件 —— 它是分栏自己的版式算法
 * （`model/columns.ts` 的 `alignSiblingColumns`，T3.15）。
 */

import { BOARD_REF_MINI_SIZE, ID_PREFIX, MIN_CARD_SIZE } from '../constants';
import { createId } from '../util/id';
import { normalizeIcon } from '../util/emoji';
import { normalizeHex } from '../util/color';
import { boundsOf, normalizeAngle, roundTo, type Point, type Rect } from '../util/geometry';
import { createGroup, nextZ } from './factories';
// 换掉内嵌脑图的模型时顺带清"指向已删节点"的线（`2.2.0` 批 3）
import { pruneMindNodeEdges } from './edges';
import { removeNodes } from '../mind/model/ops';
import { splitEndpointKey } from './schema';
import type { BoardFile, Card, CardColor, CardTitleStyle, Group, HexColor, Mind } from './schema';
import type { MindFile } from '../mind/model/schema';

// ─────────────────────────────────────────────────────────────
// 查询
// ─────────────────────────────────────────────────────────────

export function cardById(board: BoardFile, id: string): Card | null {
  return board.cards.find((card) => card.id === id) ?? null;
}

// ─────────────────────────────────────────────────────────────
// 层级（T1.31）
// ─────────────────────────────────────────────────────────────

/** 与 `CardLayer.sortCardsByZ` 同一套次序语义：z 为主，id 兜底保证确定性 */
function byZ(a: { z: number; id: string }, b: { z: number; id: string }): number {
  return a.z - b.z || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * 把选中的**内容对象**（卡片 + 脑图，`2.2.0` 收尾）整体移到最上层或最下层，
 * **保持它们彼此之间的相对次序**。
 *
 * 只改选中项自己的 `z`，不动其他对象的数值：
 * 全量重排 z 会把整份文件写花（几十张卡的数字全变），也让 diff 不可读。
 *
 * ★ 为什么卡片与脑图**放在同一个序列里**排：它们的 `z` 本来就是**共用的一格**
 *   （分栏 `1..n` 在最下面，卡片 / 脑图从 `10` 起混排，见 `templates.assignZ`），
 *   层序要表达的是"谁压在谁上面"—— 把两者分开排的话，"把这张卡置顶"会得到一个
 *   它仍压在树下面的结果（那时用户看到的是"置顶没生效"）。
 * ★ 分栏不参与：它的 z 是"栏底"那一层，`reorderSelection` 也从不带它。
 */
function reorderContent(board: BoardFile, ids: readonly string[], toFront: boolean): boolean {
  if (ids.length === 0) return false;

  const selectedIds = new Set(ids);
  const current = [...board.cards, ...(board.minds ?? [])].sort(byZ);
  const selected = current.filter((item) => selectedIds.has(item.id));
  const rest = current.filter((item) => !selectedIds.has(item.id));

  // 没选中任何对象 / 全选 → 次序不可能变
  if (selected.length === 0 || rest.length === 0) return false;

  const desired = toFront ? [...rest, ...selected] : [...selected, ...rest];
  if (desired.every((item, index) => item === current[index])) return false;

  // 锚点取"未选中对象"的最上/最下层，选中项贴着它排开，不与未选中项交错
  const anchor = toFront ? rest[rest.length - 1].z : rest[0].z;

  selected.forEach((item, index) => {
    item.z = toFront ? anchor + index + 1 : anchor - selected.length + index;
  });
  return true;
}

/** 置顶（`⌘⇧↑`，F2-00-4）：卡片与脑图都在这个集合里 */
export function bringToFront(board: BoardFile, ids: readonly string[]): boolean {
  return reorderContent(board, ids, true);
}

/** 置底（`⌘⇧↓`，F2-00-4） */
export function sendToBack(board: BoardFile, ids: readonly string[]): boolean {
  return reorderContent(board, ids, false);
}

// ─────────────────────────────────────────────────────────────
// 几何：移动 / 微移 / 缩放（T1.35 / T1.36 / T1.37）
// ─────────────────────────────────────────────────────────────

/** 一张卡片的目标几何（`width`/`height` 省略 = 不改尺寸，纯移动） */
export interface CardRect {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 批量写入卡片几何。移动、方向键微移、尺寸手柄三处都走它 ——
 * 它们的差别只在"谁来算这个矩形"，落到模型上必须是同一件事。
 *
 * ★ 尺寸在这里**兜底钳制**：控制器已经钳过一次，但 ops 是落盘前的最后一道，
 *   手改文件、脚本调用、将来的导入路径都绕不过它。宽高小于下限的卡片
 *   在界面上会变成一根线，用户完全没法把它抓回来（手柄都点在卡片外面）。
 */
export function applyCardRects(board: BoardFile, rects: readonly CardRect[], digits = 2): boolean {
  if (rects.length === 0) return false;
  const targets = new Map(rects.map((rect) => [rect.id, rect]));

  let changed = false;
  for (const card of board.cards) {
    const rect = targets.get(card.id);
    if (!rect) continue;

    const next = {
      x: roundTo(rect.x, digits),
      y: roundTo(rect.y, digits),
      width: roundTo(Math.max(rect.width, MIN_CARD_SIZE.width), digits),
      height: roundTo(Math.max(rect.height, MIN_CARD_SIZE.height), digits),
    };
    if (
      card.x === next.x &&
      card.y === next.y &&
      card.width === next.width &&
      card.height === next.height
    ) {
      continue;
    }
    card.x = next.x;
    card.y = next.y;
    card.width = next.width;
    card.height = next.height;
    changed = true;
  }
  return changed;
}

/** 一张卡片的目标旋转角（度，顺时针为正，T7.06） */
export interface CardRotation {
  id: string;
  degrees: number;
}

/**
 * 批量写入卡片旋转（T7.06 / `F2-00-10`）。
 *
 * ★ 与 `applyCardRects` **分开**，而不是把 `rotation` 并进 `CardRect`：
 *   旋转不改几何。并进去的话"移动"与"转身"会共用同一条历史记录
 *   （`commitDrag` 一次提交一批矩形），于是 `⌘Z` 分不清该退回哪一个 ——
 *   用户拖完一张卡再转一下，撤销一次会把两件事一起退掉。
 * ★ `0` 写成**删键**（与 `validate.readRotation` 同一约定）："没转过"是绝大多数卡片
 *   的状态，留一个 `rotation: 0` 在文件里只会让 diff 变脏。
 * ★ 角度在这里归一化并 `roundTo`：控制器逐帧算出来的是 `89.99999999999999` 这类数，
 *   这里是落盘前最后一道，手改文件 / 脚本调用也绕不过它。
 */
export function applyCardRotations(
  board: BoardFile,
  angles: readonly CardRotation[],
  digits = 1,
): boolean {
  if (angles.length === 0) return false;
  const targets = new Map(angles.map((item) => [item.id, item.degrees]));

  let changed = false;
  for (const card of board.cards) {
    const degrees = targets.get(card.id);
    if (degrees === undefined) continue;

    const next = roundTo(normalizeAngle(degrees), digits);
    // ★★ 分栏里的卡片**不旋转**（用户 2026-09-17："任何卡片，一旦拖动到分栏当中，
    //   旋转角度要改为 0，且在分栏当中不应该可以旋转"）。
    //   进栏那一下由 `insertCardsIntoColumn` 归零；这里挡住**之后**的所有非零角度 ——
    //   但**归零仍然放行**：那是把歪掉的旧数据掰回来的唯一入口（右键菜单的「重置角度」）。
    if (card.columnId !== null && next !== 0) continue;
    if ((card.rotation ?? 0) === next) continue;

    if (next === 0) delete card.rotation;
    else card.rotation = next;
    changed = true;
  }
  return changed;
}

/** 整体平移（方向键微移 / 拖动的"位移"形态） */
export function translateCards(
  board: BoardFile,
  ids: readonly string[],
  dx: number,
  dy: number,
): boolean {
  if (ids.length === 0 || (dx === 0 && dy === 0)) return false;
  const targets = new Set(ids);
  const rects: CardRect[] = [];
  for (const card of board.cards) {
    if (!targets.has(card.id)) continue;
    rects.push({
      id: card.id,
      x: card.x + dx,
      y: card.y + dy,
      width: card.width,
      height: card.height,
    });
  }
  return applyCardRects(board, rects);
}

// ─────────────────────────────────────────────────────────────
// 增删改（T1.34 / T1.35 / T1.39 / T1.40）
// ─────────────────────────────────────────────────────────────

/**
 * 往白板里加卡片。默认把它们放到最上层 ——
 * 新建的卡片被旧卡压住会让人以为"没建成功"（`nextZ` 保证不会与现有卡同 z）。
 */
export function addCards(board: BoardFile, cards: readonly Card[], toFront = true): boolean {
  if (cards.length === 0) return false;
  if (toFront) {
    let z = nextZ(board);
    for (const card of cards) card.z = z++;
  }
  board.cards.push(...cards);
  return true;
}

/**
 * 把正文写回**同步组**（T7.04 / `F2.9`）：`cards` 里所有"同步便签 + 同一个 `key`"
 * 的卡一起改掉。
 *
 * ★ **一次调用改全组**（视图侧只 `mutate` 一次 → 只发一次 `changed`、只重绘一次）：
 *   同组三张若逐张写，中间会画出"一张新、两张旧"的画面 —— 那是一次看得见的闪烁。
 * ★ `key` 为空时直接返回 `false`：空 key 不是"一个组"，而是"没在组里"
 *   （`cards/syncNote.ts` 那边同样不让空 key 走组写入）。
 * ★ 返回"是否真的改到了什么"：值全都一样时视图不必重绘。
 */
export function patchSyncGroup(board: BoardFile, key: string, md: string): boolean {
  if (key.length === 0) return false;

  let changed = false;
  for (const card of board.cards) {
    // 既要类型对、又要同组：别的类型身上也可能挂着一个同名字段
    if (card.type !== 'syncNote' || card.content.key !== key) continue;
    if (card.content.md === md) continue;
    // 换一个新 `content` 对象而不是就地改字段：老对象可能正被历史快照共享
    card.content = { ...card.content, md };
    changed = true;
  }
  return changed;
}

/**
 * 删除卡片，并**连带清掉悬空引用**。
 *
 * 只删卡片是错的：文件里会留下指向不存在卡片的连线和编组成员，
 * 下次打开时渲染层要么画出通往 (0,0) 的线，要么整块白板进保护态。
 * 模型层是唯一能保证这件事的地方 —— 界面层永远可能忘记。
 */
export function removeCards(board: BoardFile, ids: readonly string[]): boolean {
  if (ids.length === 0) return false;
  const targets = new Set(ids);
  const before = board.cards.length;

  board.cards = board.cards.filter((card) => !targets.has(card.id));
  if (board.cards.length === before) return false;

  board.edges = board.edges.filter(
    (edge) => !targets.has(edge.from.cardId) && !targets.has(edge.to.cardId),
  );
  for (const group of board.groups) {
    group.cardIds = group.cardIds.filter((id) => !targets.has(id));
  }
  // 成员被删空的编组留着就是空壳：界面上点不中、删不掉，只能手改文件。
  // ★ 边界是 `MIN_GROUP_SIZE` 而不是 0：只剩一张卡的编组在行为上与普通卡片毫无差别，
  //   留着它只会让白板慢慢攒下一堆看不见的壳（见 `MIN_GROUP_SIZE` 的注释）
  pruneGroups(board);
  return true;
}

/**
 * 原地复制（`Alt`+拖动，F2-00-6）。
 *
 * 新卡片压在最上层、位移 `offset`，**内容深拷贝** —— 共用 `content` 引用会让
 * 改一张便签把它的副本一起改掉（复制出来的卡片却在同步变化，最难查的一类 bug）。
 */
export function duplicateCards(
  board: BoardFile,
  ids: readonly string[],
  offset: Point = { x: 0, y: 0 },
): Card[] {
  if (ids.length === 0) return [];
  const targets = new Set(ids);
  const sources = board.cards.filter((card) => targets.has(card.id));
  if (sources.length === 0) return [];

  let z = nextZ(board);
  const clones = sources.map((source) => {
    const clone = {
      ...source,
      id: createId(ID_PREFIX.card),
      x: roundTo(source.x + offset.x),
      y: roundTo(source.y + offset.y),
      z: z++,
      content: cloneJson(source.content),
    };
    return clone as Card;
  });

  board.cards.push(...clones);
  return clones;
}

/**
 * 卡片可写的**非几何**字段（几何走 `applyCardRects`，两条路各自单一职责）。
 *
 * ---
 * ★ **这张表是运行时的铁闸，不是"只是类型"**：`updateCards` 只认这里列出的键，
 *   别的一律丢掉。原因见本文件顶部纪律第 2 条 —— 类型挡得住 TS 调用点，挡不住
 *   `as` 强转与 JS 调用；而一条漏过 `applyCardRects` 的 `x` / `y` 写入会同时绕过
 *   `roundTo`（`.nboard` 里留下 `0.30000000000000004`）、`MIN_CARD_SIZE` 钳制，
 *   以及"锁定 / 已入分栏的卡片不参与移动"这条规则。
 *
 *   键集与下面的 `PATCH_KEYS` 由编译期对齐（`satisfies` 双向检查）：
 *   谁加了字段忘了同步，`tsc` 就报错，不会静默把写入吞掉。
 */
export interface CardPatch {
  title?: string;
  showTitle?: boolean;
  color?: CardColor;
  accent?: HexColor | null;
  locked?: boolean;
  columnId?: string | null;
  order?: number;
  /**
   * 演示步骤号（J-07）。`null` = 移出演示路径。
   * ★ 顺序调整（前移 / 后移）不走这里：那要**成对**改两张卡
   *   （见 `model/presentation.ts` 的 `movePresentStep`），单个 patch 表达不了。
   */
  presentStep?: number | null;
}

/** `CardPatch` 的键集（运行时用）。与接口双向对齐：多一个少一个都编译不过 */
const PATCH_KEYS = {
  title: true,
  showTitle: true,
  color: true,
  accent: true,
  locked: true,
  columnId: true,
  order: true,
  presentStep: true,
} as const satisfies Record<keyof CardPatch, true>;

const CARD_PATCH_KEYS = Object.keys(PATCH_KEYS) as (keyof CardPatch)[];

/**
 * 把**离开分栏的迷你白板卡**钉回正方形（`O18` / `BOARD_REF_MINI_SIZE`）。
 *
 * ★ 修的是真实报障："迷你白板卡拖进分栏、再拖出来会变形"。
 *   根因：迷你档的尺寸由**形态**钉死（正方形，样式表连尺寸手柄都不给它），
 *   而**分栏会改写成员的 `width` / `height`**（栏有多宽它就多宽）——
 *   而"拖出分栏"的约定是**几何原地保留**（视觉上就是拖出来放开），
 *   于是那个被栏撑过的尺寸被一路带出栏，没人把它掰回正方形。
 * ★ **只碰不在栏里的卡**（`columnId === null`）：还在栏里的那些正跟着栏的版式走，
 *   在这里改它们的宽高会与下一次栏版式打架（一会儿方、一会儿宽，看着像抖）。
 * ★ 只认 `boardRef` + `preview === 'mini'`：别的档位、别的类型的尺寸是**用户的输入**，
 *   替用户改就是抹掉他刚做过的事（与 `boardRefPreviewSize` 里"离开 mini 档才还尺寸"
 *   是同一条道理）。
 * ★ 调用点：拖拽提交（`BoardView.commitDrag`）与删除分栏的"释放"档 ——
 *   所有"离开分栏"的路都经过这两处。
 */
export function repinMiniBoardRefs(board: BoardFile): boolean {
  let changed = false;
  for (const card of board.cards) {
    if (card.columnId !== null) continue;
    if (card.type !== 'boardRef' || card.content.preview !== 'mini') continue;
    if (card.width === BOARD_REF_MINI_SIZE.width && card.height === BOARD_REF_MINI_SIZE.height) {
      continue;
    }
    card.width = BOARD_REF_MINI_SIZE.width;
    card.height = BOARD_REF_MINI_SIZE.height;
    changed = true;
  }
  return changed;
}

/** 便签卡面外观（`O38`）：标记 + 标题整条格式；`null` = 清掉那一项 */
export interface CardLookPatch {
  /** 空串 / `null` = 摘掉标记 */
  icon?: string | null;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  /** `null` = 回到"按标题底色算出来"的那个字色 */
  ink?: HexColor | null;
}

/**
 * 改卡片的**卡面外观**（便签的快捷操作栏走这一条，`O38`）。
 *
 * ★ 为什么不并进 `updateCards`：那个的白名单是"卡片基类那些字段"，写法是
 *   `record[key] = value` —— 而这里的几项**清掉时要删键**（`icon` / `titleStyle`
 *   的缺省正是"没有"，留一个空串或空对象会让"读一遍写回去逐字节不变"多出噪声）。
 *   删键必须显式写，不能指望"写个 `null` 也算数"。
 * ★ 值没变返回 `false`：不写盘、不占撤销栈、不标脏（与全文件第一条纪律一致）。
 * ★ `bold: false` **留住**（缺省由样式表决定，它是"把加粗关掉"的唯一表达）；
 *   `italic` / `underline` 的缺省是常量"无" ⇒ 为 `false` 时删键。
 */
export function updateCardLook(
  board: BoardFile,
  ids: readonly string[],
  patch: CardLookPatch,
): boolean {
  if (ids.length === 0) return false;

  const targets = new Set(ids);
  const same = (a: unknown, b: unknown): boolean => (a ?? null) === (b ?? null);
  let changed = false;

  for (const card of board.cards) {
    if (!targets.has(card.id)) continue;

    if (patch.icon !== undefined) {
      const next = normalizeIcon(patch.icon ?? '');
      if ((card.icon ?? '') !== next) {
        if (next.length === 0) delete card.icon;
        else card.icon = next;
        changed = true;
      }
    }

    const style: CardTitleStyle = { ...(card.titleStyle ?? {}) };
    let styleDirty = false;
    if (patch.bold !== undefined && !same(patch.bold, card.titleStyle?.bold)) {
      style.bold = patch.bold;
      styleDirty = true;
    }
    for (const key of ['italic', 'underline'] as const) {
      const value = patch[key];
      if (value === undefined || same(value, card.titleStyle?.[key])) continue;
      if (value === false) delete style[key];
      else style[key] = true;
      styleDirty = true;
    }
    if (patch.ink !== undefined) {
      const next = patch.ink === null ? null : normalizeHex(patch.ink);
      if (!same(next, card.titleStyle?.ink)) {
        if (next === null) delete style.ink;
        else style.ink = next;
        styleDirty = true;
      }
    }
    if (styleDirty) {
      // 全空就连 `titleStyle` 一起删掉（纪律 2：缺省即"没有"）
      if (Object.keys(style).length === 0) delete card.titleStyle;
      else card.titleStyle = style;
      changed = true;
    }
  }

  return changed;
}

/** 批量改字段。逐字段比对，全都相等时返回 `false`（不产生"无变化的写入"） */
export function updateCards(board: BoardFile, ids: readonly string[], patch: CardPatch): boolean {
  if (ids.length === 0) return false;

  const incoming = patch as Record<string, unknown>;
  // 只收白名单里**确实传了值**的键（`undefined` 一律当"没传"；`null` / `0` / `false` 是有效值）
  const keys = CARD_PATCH_KEYS.filter((key) => incoming[key] !== undefined);
  if (keys.length === 0) return false;

  const targets = new Set(ids);
  let changed = false;
  for (const card of board.cards) {
    if (!targets.has(card.id)) continue;
    const record = card as unknown as Record<string, unknown>;
    for (const key of keys) {
      const value = incoming[key];
      if (record[key] === value) continue;
      record[key] = value;
      changed = true;
    }
  }
  return changed;
}

/** 改分栏字段（当前只用到 `color`，用户 2026-09-18："分栏要允许设置颜色"）。
 * ★ 与 `updateCards` 同一条"是否真改了"的纪律：没变就返回 `false`，不标脏、不递增 `revision` */
export function updateColumns(
  board: BoardFile,
  ids: readonly string[],
  patch: { color?: CardColor },
): boolean {
  if (ids.length === 0) return false;
  if (patch.color === undefined) return false;

  const targets = new Set(ids);
  let changed = false;
  for (const column of board.columns) {
    if (!targets.has(column.id)) continue;
    if (column.color === patch.color) continue;
    column.color = patch.color;
    changed = true;
  }
  return changed;
}

/**
 * 只保留"内容必须是可 JSON 化的纯数据"这一前提下的深拷贝。
 * 不用 `structuredClone`：目标环境（`tsconfig` 的 lib）不保证有它，
 * 而卡片内容本来就要能 `JSON.stringify` 进 `.nboard`（`CardLayer` 的指纹也依赖这点）。
 */
export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// ─────────────────────────────────────────────────────────────
// 对齐与等距分布（T3.13 / `F5-04`、PRD `D-05`）
// ─────────────────────────────────────────────────────────────

/**
 * 对齐方式。
 *
 * ★ 命名跟 Figma 一致：「水平居中」= 水平**方向**上的中心 → 全部卡片共用同一个 **x** 中心
 *   （视觉上排成一**竖**列）。这是中文界面里最容易搞反的一处，所以：
 *     * `centerX` = 水平居中 = 比 `x` 中心；
 *     * `centerY` = 垂直居中 = 比 `y` 中心。
 *   界面上给的中文标签一律带上"（同一 x 中心）"这类后缀（见 `i18n`），
 *   免得用户按下去才发现是另一根轴。
 */
export type AlignMode = 'left' | 'right' | 'top' | 'bottom' | 'centerX' | 'centerY';

/** 等距分布的轴：`x` = 水平方向排开，`y` = 垂直方向排开 */
export type DistributeAxis = 'x' | 'y';

/**
 * 从选区里挑出"这次真的能被摆动的卡片"。三种情况明确排除，且都**不进包围盒**：
 *
 * 1. **锁定的卡片**：它们挪不动。若把它们算进包围盒，"对齐"会以一张永远不动的卡
 *    为基准，其余卡片对完之后看起来**就是没对齐**（因为基准那根线并没有被"贴上"）。
 * 2. **栏内成员**：几何是派生状态，写完会被 `BoardView.commit()` 里的
 *    `relayoutColumns()` 按栏重排覆盖 —— 白做一趟，还会白记一条撤销。
 *    何况栏内本身就是"纵向单列流"，左对齐与等宽已经由 `layoutRects` 保证了。
 * 3. **幽灵 id**（选区里残留的已删卡片）：`board.cards` 里找不到的自然被跳过。
 */
function movableCards(board: BoardFile, ids: readonly string[]): Card[] {
  if (ids.length === 0) return [];
  const targets = new Set(ids);
  const picked: Card[] = [];
  for (const card of board.cards) {
    if (!targets.has(card.id) || card.locked || card.columnId !== null) continue;
    picked.push(card);
  }
  return picked;
}

/**
 * 对齐（`F5-04` 的前六项）。
 *
 * 基准是**可移动卡片的包围盒**（不是"第一张卡"）—— 用户选了一片东西按「左对齐」，
 * 期望的是"都靠到这片区域最左边那条线"，而不是"都跟先选中的那张对齐"
 * （后者在框选时完全不可预测）。
 *
 * ★ 需要 ≥ 2 张：一张卡谈"对齐"没有意义，此时返回 `false` 而不是静默挪一下。
 *
 * @returns 是否真的改动了模型（没变就不该产生历史记录，见文件头纪律 1）
 */
export function alignCards(
  board: BoardFile,
  ids: readonly string[],
  mode: AlignMode,
  digits = 2,
): boolean {
  const cards = movableCards(board, ids);
  if (cards.length < 2) return false;

  const bounds = boundsOf(cards);
  if (!bounds) return false;

  const right = bounds.x + bounds.width;
  const bottom = bounds.y + bounds.height;

  const rects: CardRect[] = cards.map((card) => {
    const next: CardRect = {
      id: card.id,
      x: card.x,
      y: card.y,
      width: card.width,
      height: card.height,
    };
    switch (mode) {
      case 'left':
        next.x = bounds.x;
        break;
      case 'right':
        next.x = right - card.width;
        break;
      case 'centerX':
        next.x = (bounds.x + right - card.width) / 2;
        break;
      case 'top':
        next.y = bounds.y;
        break;
      case 'bottom':
        next.y = bottom - card.height;
        break;
      case 'centerY':
        next.y = (bounds.y + bottom - card.height) / 2;
        break;
    }
    return next;
  });

  return applyCardRects(board, rects, digits);
}

/**
 * 等距分布（`F5-04` 的第七项）。
 *
 * ── 为什么是"等**间隙**"而不是"等中心点" ────────────────────────
 *
 * 卡片尺寸不一时，"中心点等距"会让**看得见的空隙**忽宽忽窄（宽卡两侧挤成一条缝、
 * 窄卡两侧留出一大片）。人对齐判断靠的是空隙，所以这里均分的是空隙。
 *
 * ── 首尾为什么不动 ──────────────────────────────────────────
 *
 * 选区两端是用户自己划定的边界，把它们挪走会让整块内容"漂移"到别处。
 * 于是：跨度 = 末张的终点 − 首张的起点，扣掉所有卡片的尺寸，剩下均分给 `n − 1` 个空隙。
 *
 * ★ 需要 ≥ 3 张：只有两张时"分布"无事可做（首尾本来就不动），
 *   返回 `false` 让它成为一次空操作，而不是白写一条历史。
 * ★ 跨度装不下所有卡片时间隙为**负**，卡片会均匀地叠在一起 —— 这是唯一自洽的结果
 *   （总不能把卡片压扁），刻意不做额外处理。
 *
 * @returns 是否真的改动了模型
 */
export function distributeCards(
  board: BoardFile,
  ids: readonly string[],
  axis: DistributeAxis,
  digits = 2,
): boolean {
  const cards = movableCards(board, ids);
  if (cards.length < 3) return false;

  const start = (card: Card): number => (axis === 'x' ? card.x : card.y);
  const length = (card: Card): number => (axis === 'x' ? card.width : card.height);

  // ★ 位置相同时用 id 兜底定序：`Array#sort` 的稳定只保证"保持输入顺序"，
  //   而 `board.cards` 的顺序可能被外部同步改过 —— 没有兜底，同一份文件
  //   在两台机器上会分布出不同的结果（而且看起来"只是顺序不一样"，极难排查）。
  const ordered = [...cards].sort(
    (a, b) => start(a) - start(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );

  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  const span = start(last) + length(last) - start(first);

  let occupied = 0;
  for (const card of ordered) occupied += length(card);
  const gap = (span - occupied) / (ordered.length - 1);

  const rects: CardRect[] = [];
  let cursor = start(first);
  for (const card of ordered) {
    const next: CardRect = {
      id: card.id,
      x: card.x,
      y: card.y,
      width: card.width,
      height: card.height,
    };
    if (axis === 'x') next.x = cursor;
    else next.y = cursor;
    rects.push(next);
    cursor += length(card) + gap;
  }

  return applyCardRects(board, rects, digits);
}

// ─────────────────────────────────────────────────────────────
// 编组 / 取消编组（T3.14 / `F5-05`、PRD `D-07`）
// ─────────────────────────────────────────────────────────────

/**
 * 编组的最小成员数。
 *
 * ★ 单成员编组在行为上与普通卡片**完全一样**（点中的还是它、拖动的还是它），
 *   文件里却多一条谁看不见的记录。所以任何可能让编组掉到 1 个成员的操作
 *   （删卡、编组、取消编组）都必须就地解散它 —— 否则白板会慢慢攒下一堆
 *   "点不中、删不掉、只能手改文件"的空壳。
 */
export const MIN_GROUP_SIZE = 2;

/** 这张卡属于哪个编组。卡片**最多**属于一个编组（见 `groupCards` 约定 1） */
export function groupOfCard(board: BoardFile, cardId: string): Group | null {
  return board.groups.find((group) => group.cardIds.includes(cardId)) ?? null;
}

/** 这一栏属于哪个编组（分栏成员，用户 2026-09-16）。一栏同样**最多**属于一个编组 */
export function groupOfColumn(board: BoardFile, columnId: string): Group | null {
  return board.groups.find((group) => group.columnIds?.includes(columnId) === true) ?? null;
}

/** 一个编组的成员总数（卡片 + 分栏） */
export function groupMemberCount(group: Group): number {
  return group.cardIds.length + (group.columnIds?.length ?? 0);
}

/** 解散成员数不足 `MIN_GROUP_SIZE` 的编组。返回是否真的动了模型 */
export function pruneGroups(board: BoardFile): boolean {
  const before = board.groups.length;
  // ★ 成员数算**两类之和**：一个"两栏成组"的组里 `cardIds` 是**空的**，
  //   只看它会被当成空组当场解散 —— 那正是分栏编组刚落地时最容易踩的一脚
  board.groups = board.groups.filter((group) => groupMemberCount(group) >= MIN_GROUP_SIZE);
  return board.groups.length !== before;
}

/** 按 id 取编组（收起开关按 id 找组）。找不到返回 `null` */
export function groupById(board: BoardFile, groupId: string): Group | null {
  return board.groups.find((group) => group.id === groupId) ?? null;
}

/**
 * 收起 / 展开一个编组（O03）。返回是否**真的**改动了模型。
 *
 * ★ 只动 `collapsed` 一个字段：成员位置与 `cardIds` 一个都不碰 ——
 *   展开后每张卡必须回到原处，而"包围盒由成员位置实时计算"（`03 §2.9`）
 *   让这件事天然成立：藏起来的只是渲染，模型里它们一直在原地。
 * ★ 展开是**删掉这个键**而不是写 `false`：存量文件读一遍写回去要逐字节不变
 *   （见 `Group.collapsed` 的注释），`false` 会留下一个"看着有状态其实没有"的键。
 * ★ 幂等：已经是目标状态时返回 `false`，调用方据此**不记历史** ——
 *   否则撤销栈里会攒一堆"点了一下、什么都没变"的记录。
 */
export function setGroupCollapsed(board: BoardFile, groupId: string, collapsed: boolean): boolean {
  const group = groupById(board, groupId);
  if (!group) return false;
  if ((group.collapsed === true) === collapsed) return false;
  if (collapsed) group.collapsed = true;
  else delete group.collapsed;
  return true;
}

/**
 * 改编组名（O03：双击标签条）。
 *
 * 与 `setColumnTitle` 同一套语义：原样提交（点开又原样关掉）返回 `false`，
 * 不产生历史记录、也不递增 revision。
 */
export function setGroupLabel(board: BoardFile, groupId: string, label: string): boolean {
  const group = groupById(board, groupId);
  if (!group || group.label === label) return false;
  group.label = label;
  return true;
}

/**
 * 被收起的编组里的**全部成员 id**（渲染 / 命中 / 框选据此把卡片藏起来）。
 *
 * ★ 返回 `Set` 而不是数组：调用方每帧都要问"这张卡在不在里面"，
 *   线性查找会让 1000 张卡的白板多出一次 `O(n·m)`。
 * ★ 没有收起编组时返回**空集**（而不是 `null`）：这是绝大多数情况，
 *   调用方因此少一个分支 —— 最常见的那条路必须是最省事的那条。
 */
export function collapsedCardIds(board: BoardFile): Set<string> {
  const hidden = new Set<string>();
  // ★ 收起组里的**分栏成员**连带它的全部卡片一起藏起来（用户 2026-09-16）：
  //   仅把栏藏掉的话，栏内的卡片会继续浮在画布上（它们不在 `group.cardIds` 里）——
  //   那正是"收起之后还剩一堆卡飘着"的来路。
  const hiddenColumns = collapsedGroupColumnIds(board);
  if (hiddenColumns.size > 0) {
    for (const card of board.cards) {
      if (card.columnId !== null && hiddenColumns.has(card.columnId)) hidden.add(card.id);
    }
  }
  for (const group of board.groups) {
    if (group.collapsed !== true) continue;
    for (const id of group.cardIds) hidden.add(id);
  }
  return hidden;
}

/**
 * 被收起的编组里的**分栏成员 id**（用户 2026-09-16）：栏本身要跟着隐藏。
 *
 * ★ 分栏**没有**"成员卡被藏起来"的表达方式（`Column.collapsed` 是"折成标题条"，
 *   栏还在），所以这件事只能由编组这一侧说 —— 而"谁被收起的组罩着"只有这里算得准。
 */
export function collapsedGroupColumnIds(board: BoardFile): Set<string> {
  const hidden = new Set<string>();
  for (const group of board.groups) {
    if (group.collapsed !== true) continue;
    for (const id of group.columnIds ?? []) hidden.add(id);
  }
  return hidden;
}

/**
 * 把一批卡片收进一个新编组（`⌘G`，`F5-05` / `D-07`）。
 *
 * 四条约定：
 *
 * 1. **一个成员最多属于一个编组**：先把它们从原有编组里摘出来（旧组因此掉到
 *    1 个成员时会被 `pruneGroups` 解散）。允许"一卡多组"会让 ⌘G / ⌘⇧G 变成
 *    二义的 —— 取消编组时到底取消哪一个？这个问题没有好答案。
 * 2. **不足 2 张不动手**：见 `MIN_GROUP_SIZE`。
 * 3. **已经整整齐齐同属一个编组时是空操作**：用户在已编组的选区上再按一次 ⌘G，
 *    期望的是"没变化"，而不是打散重建（重建会换掉 group id，撤销栈里多一条假记录）。
 * 4. **编组不改变几何**：包围盒实时由成员算出来（`03 §2.9`），成员原地不动。
 *
 * ★ 不要求成员"可移动"：锁定卡片当成员完全合理（它不能被拖走，但可以跟着组一起
 *   被别的成员带走 —— 拖动时逐张跳过锁定卡，见视图层）。
 *
 * @returns 编组 id；没有可编的卡片时返回 `null`
 */
export function groupCards(board: BoardFile, ids: readonly string[]): string | null {
  return groupMembers(board, { cardIds: ids });
}

/**
 * 把一批**卡片 + 分栏**收进一个新编组（`⌘G` 的模型层入口，用户 2026-09-16）。
 *
 * ★ 分栏成员是"像卡片一样"被编进来的：这一步**不碰栏、也不碰栏里的卡片** ——
 *   栏不消失、卡留在栏里，只是多了一层"它们是一伙的"（拖动 / 包围框跟着走）。
 *   与「整栏转编组」（`O04`）刚好相反：那个是拿栏**换**组，这个是把栏**编进去**。
 * ★ 其余四条约定与 {@link groupCards} 完全一样（一个成员最多属于一个组、不足两个不动手、
 *   已经同组时是空操作、不改几何），两类成员各按各的算。
 */
export function groupMembers(
  board: BoardFile,
  members: { cardIds?: Iterable<string>; columnIds?: Iterable<string> },
): string | null {
  const wantedCards = new Set(members.cardIds ?? []);
  const wantedColumns = new Set(members.columnIds ?? []);
  const cards = board.cards.filter((card) => wantedCards.has(card.id)).map((card) => card.id);
  const columns = board.columns
    .filter((column) => wantedColumns.has(column.id))
    .map((column) => column.id);
  // 两类加起来不足两个不动手（"一栏 + 一张卡"是合法的两成员组）
  if (cards.length + columns.length < MIN_GROUP_SIZE) return null;

  const cardSet = new Set(cards);
  const columnSet = new Set(columns);

  // 约定 3：已经整整齐齐同属一个编组 → 空操作（不重建、不换 id、不记历史）
  const existing = board.groups.find(
    (group) =>
      group.cardIds.length === cards.length &&
      group.cardIds.every((id) => cardSet.has(id)) &&
      (group.columnIds ?? []).length === columns.length &&
      (group.columnIds ?? []).every((id) => columnSet.has(id)),
  );
  if (existing) return existing.id;

  // 约定 1：一个成员最多属于一个编组
  for (const group of board.groups) {
    group.cardIds = group.cardIds.filter((id) => !cardSet.has(id));
    if (group.columnIds) {
      group.columnIds = group.columnIds.filter((id) => !columnSet.has(id));
    }
  }
  pruneGroups(board);

  const group = createGroup(cards);
  // 分栏成员**只在真有的时候写这个键**（纪律 2：不补 `columnIds: []`）
  if (columns.length > 0) group.columnIds = columns;
  board.groups.push(group);
  return group.id;
}

/**
 * 取消编组（`⌘⇧G`）：**整组一起解散**。
 *
 * ★ "选中一个成员就解散整组"，而不是"只把选中的成员摘出去"：⌘⇧G 在用户心里的语义
 *   是"把这个组拆开"。只摘一半会留下一个仍然成组的 3 人组，用户会以为操作失败了。
 *   想单独处理组内某一张卡，正确做法是先取消编组（T3.14 不做"进组"，
 *   即双击进入编组内部 —— 那需要一整套"组的层级"概念，见视图层注释）。
 *
 * @returns 是否真的改动了模型
 */
export function ungroupCards(board: BoardFile, ids: readonly string[]): boolean {
  return ungroupMembers(board, { cardIds: ids });
}

/**
 * 取消编组（`⌘⇧G`）。**卡片成员与分栏成员都认**（用户 2026-09-16）：
 * 选区里只要沾到某个组的任一成员（一张卡 / 一栏），那个组就整个解散 ——
 * 与卡片那条同一条语义（见 `ungroupCards` 的注释：不能只摘一半）。
 */
export function ungroupMembers(
  board: BoardFile,
  members: { cardIds?: Iterable<string>; columnIds?: Iterable<string> },
): boolean {
  const cards = new Set(members.cardIds ?? []);
  const columns = new Set(members.columnIds ?? []);
  if (cards.size === 0 && columns.size === 0) return false;

  const before = board.groups.length;
  board.groups = board.groups.filter(
    (group) =>
      !group.cardIds.some((id) => cards.has(id)) &&
      !(group.columnIds ?? []).some((id) => columns.has(id)),
  );
  return board.groups.length !== before;
}

/**
 * 把选区扩展成"完整的编组"：点到组内任意一张 = 选中整组。
 *
 * ★ 返回**新的** `Set` 而不是就地改传入的那个：调用方拿的往往是选区自己的那份快照，
 *   就地改会让"选中集"在渲染与命中测试之间悄悄变长，出了 bug 根本看不出是谁改的。
 * ★ 只扩展一层：卡片最多属于一个编组（约定 1），不存在嵌套。
 */
export function expandGroupSelection(board: BoardFile, ids: Iterable<string>): Set<string> {
  const expanded = new Set<string>();
  for (const id of ids) {
    expanded.add(id);
    const group = groupOfCard(board, id);
    if (!group) continue;
    for (const memberId of group.cardIds) expanded.add(memberId);
  }
  return expanded;
}

/**
 * 一个编组的**成员包围盒**（`O04`）—— 派生，**不落盘**。
 *
 * ★ 为什么"给编组补几何"最后落地的是一个函数而不是 `Group.bounds` 字段：
 *   `03 §2.9` 定下"组只存成员，框由成员位置实时算"（`GroupLayer` 一直照这个做）。
 *   往 `Group` 上再写一份 `bounds` 等于给同一件事留两份真相 —— 成员被拖走、卡片被
 *   自动高度改高、撤销回滚，每一处都得记得同步它，漏一处就是"框画在老地方"。
 *   `O04` 验收标准里"undo/redo 不破坏几何"这一条，正是靠**不存**才成立的。
 * ★ 与 `GroupLayer.groupFrameOf` 不是一回事：这里量的是**成员本身**的包围盒
 *   （不含框的留白与顶部标签带）。模型层要回答"这一组压在哪一栏上"时，
 *   多算那 16px 留白会让判据随视觉细节漂移。
 * ★ **只算卡片成员**（分栏成员不进这里）：它唯一的调用方是"这一组压在哪一栏上"
 *   （`groupOccupyingColumn`，判断删栏后邻居要不要合拢）—— 把栏算进来会让
 *   "组压在自己的成员栏上"变成自指。何况 `ops.ts` 不能 import `columns.ts`
 *   （会成环：栏高只有 `columnDisplayHeight` 说了算）。
 *   **画给用户看的那个框**在 `GroupLayer.groupFrameOf`，那里由视图喂进
 *   能解析两类成员的 `rectOf`。
 */
export function groupBounds(board: BoardFile, groupId: string): Rect | null {
  const group = groupById(board, groupId);
  if (!group) return null;
  const members = new Set(group.cardIds);
  return boundsOf(board.cards.filter((card) => members.has(card.id)));
}

// ─────────────────────────────────────────────────────────────
// 白板级脑图（`2.2.0`）：与卡片 / 分栏 / 编组平级的对象
//
// ★ 这里只放"改白板上那棵树"的动作（进出白板 / 挪位置 / 换模型 / 删掉）。
//   树内部的结构编辑（加节点 / 删除 / 折叠 / 改字）在 `mind/model/ops.ts` ——
//   脑图那一套操作与 `.nestmind` 完全共用，白板这一侧一个字都不重写。
// ─────────────────────────────────────────────────────────────

/** 这块板上的脑图（`minds` 缺席 = 没有）：给空数组，调用方不必到处判 `?.` */
export function mindsOf(board: BoardFile): readonly Mind[] {
  return board.minds ?? [];
}

export function mindById(board: BoardFile, id: string): Mind | null {
  return board.minds?.find((mind) => mind.id === id) ?? null;
}

/** 往白板里放一棵脑图（默认压到最上层，理由同 `addCards`） */
export function addMind(board: BoardFile, mind: Mind, toFront = true): boolean {
  if (toFront) mind.z = nextZ(board);
  if (!board.minds) board.minds = [];
  board.minds.push(mind);
  return true;
}

/**
 * 移动一棵脑图 —— 写的是**根节点中心**（`Mind.x/y`）。
 *
 * ★ 其它节点的位置**不落盘**（由 `layout/` 算）：这正是"脑图不是一堆卡片"在数据上的样子。
 *   拖整棵只有"挪那一个点"这一件事，与卡片"每张各记一份 x/y"形成对照。
 */
export function moveMind(board: BoardFile, id: string, point: Point): boolean {
  const mind = mindById(board, id);
  if (!mind) return false;
  const x = roundTo(point.x);
  const y = roundTo(point.y);
  if (mind.x === x && mind.y === y) return false;
  mind.x = x;
  mind.y = y;
  return true;
}

/**
 * 换掉一棵**内嵌**脑图的模型（结构编辑的写回口）。
 *
 * ★ 与 `patchSyncGroup` 同一条纪律：**不就地改** `mind.mind` 里的字段，而是整份换掉 ——
 *   老对象可能正被撤销栈的快照共享（"撤销之后又被写回一次"那类最难查的 bug）。
 * ★ 文件脑图走 `.nestmind` 仓储（`mutate`），**不经过这里**。
 * ★ 顺带清掉"指向这棵树里**已经不在的节点**"的连线（`2.2.0` 批 3）：与 `removeCards`
 *   同一条纪律 —— 删掉的东西不该在文件里留一堆既画不出来又删不掉的线。
 *   这里做得到是因为**清单就在手上**（`next` 就是新模型），而文件脑图那条路不做
 *   （清单在另一份文件里，见 `pruneMindNodeEdges` 的说明）。
 */
export function setMindModel(board: BoardFile, id: string, next: MindFile): boolean {
  const mind = mindById(board, id);
  if (!mind || mind.mind === next) return false;
  mind.mind = next;
  pruneMindNodeEdges(board, id, new Set(next.nodes.map((node) => node.id)));
  return true;
}

/**
 * 复制一棵脑图（`⌘D` 与剪贴板粘贴共用，`2.2.0` 批 4 五）。
 *
 * ── 两条口径 ──────────────────────────────────────────────
 *
 * * **内嵌脑图**：节点 id 必须换新（否则"复制出来的那棵"与原树共用一批节点 id，
 *   而连线端点正是按 `脑图id/节点id` 认节点的 —— 那种板子打开后线会串到另一棵树上）。
 *   `rootId` / `parentId` 一律按映射表重写，`meta.id` 也重新发一个（它是这份模型自己的身份）。
 * * **文件脑图**（`path` 非空）：**只复制容器**，`path` 照搬 —— 两份容器指向同一份
 *   `.nestmind`，与"两枚引用卡指向同一篇笔记"是同一条语义（改文件两边都变）。
 *   于是它的节点 id **一个都不改**：那些 id 属于那份文件，改了才是错的。
 *
 * ★ 与 `duplicateCards` 一样**不复制连线**：端点只在一侧的那些线搬过去就是悬空引用。
 *
 * @returns 新的容器（`x/y` 还没偏移，交给调用方）+ 它内部几层 id 的映射
 *   （`nodeIds`：老节点 id → 新节点 id；文件脑图给空表）
 */
export function cloneMindForCopy(mind: Mind): { mind: Mind; nodeIds: Map<string, string> } {
  const nodeIds = new Map<string, string>();
  const clone: Mind = { ...mind, id: createId(ID_PREFIX.mind) };
  if (mind.path.length > 0 || !mind.mind) {
    delete clone.mind;
    return { mind: clone, nodeIds };
  }

  const model = cloneJson(mind.mind) as MindFile;
  const nodes = model.nodes.map((node) => {
    const id = createId(ID_PREFIX.mindNode);
    nodeIds.set(node.id, id);
    return { ...node, id };
  });
  clone.mind = {
    ...model,
    meta: { ...model.meta, id: createId(ID_PREFIX.mind) },
    rootId: nodeIds.get(model.rootId) ?? model.rootId,
    // `parentId` 也要跟着换：漏一处就会得到"某些节点悬空、整支消失"的树
    nodes: nodes.map((node) =>
      node.parentId === null ? node : { ...node, parentId: nodeIds.get(node.parentId) ?? null },
    ),
  };
  return { mind: clone, nodeIds };
}

/**
 * 原地复制若干棵脑图（`⌘D`）：新 id + 偏移 + 压到最上层。
 *
 * ★ **不复制连线**（与 `duplicateCards` 同一条口径）；也**不进编组**（脑图不是编组成员）。
 * ★ 副本不继承 `locked` 之外的界面状态：那本来就只有 `locked` 一项存在模型里。
 */
export function duplicateMinds(
  board: BoardFile,
  ids: readonly string[],
  offset: Point = { x: 0, y: 0 },
): Mind[] {
  if (ids.length === 0) return [];
  const wanted = new Set(ids);
  const sources = (board.minds ?? []).filter((mind) => wanted.has(mind.id));
  if (sources.length === 0) return [];

  const clones: Mind[] = [];
  for (const source of sources) {
    const { mind } = cloneMindForCopy(source);
    mind.x = roundTo(source.x + offset.x);
    mind.y = roundTo(source.y + offset.y);
    mind.z = nextZ(board);
    // 直接推进去而不是走 `addMind`：`addMind` 会把 `z` 再抬一次，而这里已经算好了
    if (!board.minds) board.minds = [];
    board.minds.push(mind);
    clones.push(mind);
  }
  return clones;
}

/**
 * 删掉一棵脑图，并**连带清掉指着它的连线**（与 `removeCards` 同一条纪律）。
 *
 * ★ 连线端点只认"一个白板级 id"（`EdgeEndpoint.cardId`），所以这里只要按 id 扫一遍 ——
 *   分栏、卡片、脑图三种端点共用同一份清理逻辑，谁也漏不掉。
 * ★ 编组不用管：脑图不是编组成员（编组只装卡片与分栏）。
 */
/**
 * 删除若干**节点**（`2.2.0` 收尾 · 节点级框选）。
 *
 * @param keys 节点端点键（`nodeEndpointKey(脑图id, 节点id)`）
 *
 * ★ **只碰内嵌的树**：文件树的节点存在那份 `.nestmind` 里，这条纯函数读不到 ——
 *   调用方（`BoardView.deleteSelection`）另外走仓储，两条路合起来才是"删掉这些节点"。
 * ★ 删完**顺手清掉指向它们的连线**（`pruneMindNodeEdges`，与 `setMindModel` 同一条）：
 *   被删掉的节点不该在文件里留一堆画不出来又删不掉的线。
 *   ★ 文件树那一路**不清线**：节点清单在别处（`.nestmind`），而"那边删了节点、
 *     这边线先留着"是既有的口径（见 `pruneMindNodeEdges` 的注释）—— 加回来线就回来。
 * ★ 根节点由 `removeNodes` 自己跳过（删一棵树的根 = 删整棵树，那是另一个动作）。
 */
export function removeMindNodes(board: BoardFile, keys: readonly string[]): boolean {
  if (keys.length === 0 || !board.minds) return false;

  // 按树分组，只收**内嵌**那种（`path` 为空 = 树在板子里）
  const inline = new Map<string, Set<string>>();
  for (const key of keys) {
    const { cardId, nodeId } = splitEndpointKey(key);
    if (nodeId === null) continue;
    const mind = board.minds.find((item) => item.id === cardId);
    if (!mind || mind.path.length > 0 || !mind.mind) continue;
    const bucket = inline.get(cardId) ?? new Set<string>();
    bucket.add(nodeId);
    inline.set(cardId, bucket);
  }

  let changed = false;
  for (const [mindId, nodeIds] of inline) {
    const mind = board.minds.find((item) => item.id === mindId);
    if (!mind?.mind) continue;
    if (!removeNodes(mind.mind, nodeIds)) continue;
    changed = true;
    pruneMindNodeEdges(board, mindId, new Set(mind.mind.nodes.map((node) => node.id)));
  }
  return changed;
}

export function removeMinds(board: BoardFile, ids: readonly string[]): boolean {
  if (ids.length === 0 || !board.minds) return false;
  const targets = new Set(ids);
  const before = board.minds.length;
  board.minds = board.minds.filter((mind) => !targets.has(mind.id));
  if (board.minds.length === before) return false;

  board.edges = board.edges.filter(
    (edge) => !targets.has(edge.from.cardId) && !targets.has(edge.to.cardId),
  );
  // 全删光时把键去掉：与"可选键缺席即默认"同一条纪律（老插件读它要逐字节一样）
  if (board.minds.length === 0) delete board.minds;
  return true;
}
