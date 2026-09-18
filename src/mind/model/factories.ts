/**
 * 脑图工厂（`06 §3`）：**创建合法对象的唯一入口**。
 *
 * 与白板的 `model/factories.ts` 同一条理由：新加字段时只改这里，所有创建点自动带上默认值 ——
 * 否则迟早出现"某些入口少了字段"的隐性脏数据。
 *
 * ★ 纯逻辑：不 import `obsidian`、不碰 DOM、不 import 白板模块（`06 §2`）。
 */

import { ID_PREFIX, MIND_SPEC, MIND_VERSION } from '../../constants';
import { createId } from '../../util/id';
import { t } from '../../util/i18n';
import type { MindFile, MindMeta, MindNode, MindViewState } from './schema';

/**
 * 空白脑图的视口默认值。
 *
 * ★ 背景取 `dots`（点阵）：脑图里"节点之间是树干"这件事本身已经提供了结构感，
 *   点阵只用来提示"这里是画布、可以拖"，不像网格那样与连线抢注意力。
 */
export const DEFAULT_MIND_VIEW: MindViewState = { x: 0, y: 0, zoom: 1, background: 'dots' };

/** 新建节点的覆盖项：`id` 也能注入（粘贴 / 迁移时要保留 id） */
export type MindNodeOverrides = Partial<Omit<MindNode, 'id'>> & { id?: string };

/**
 * 新建一个节点。
 *
 * ★ **可选键按需写**：`collapsed` / `free` / `style` / `props` / `refs` 没有就一个键都不加 ——
 *   与 `validate` 的"缺席即默认"配套。这样"新建出来的文件"与"读一遍写回去的文件"
 *   是同一种字节形状，diff 里不会出现一堆 `"collapsed": false` 的噪声。
 */
export function createMindNode(overrides: MindNodeOverrides = {}): MindNode {
  const { id, text, note, parentId, order, collapsed, done, free, style, props, refs, icon } =
    overrides;
  const node: MindNode = {
    id: id ?? createId(ID_PREFIX.mindNode),
    text: text ?? '',
    note: note ?? '',
    parentId: parentId ?? null,
    order: order ?? 0,
  };
  if (collapsed === true) node.collapsed = true;
  // ★ 完成（`N3-g`）也必须在这里**接住**：复制 / 粘贴 / 复制一支走的都是这个工厂
  //   （`{ ...node, id: 新 id }`），漏掉的话"完成"会在粘贴时静默消失 ——
  //   与当初 `icon` 那一档是同一个坑
  if (done === true) node.done = true;
  if (free) node.free = { x: free.x, y: free.y };
  if (style) node.style = { ...style };
  if (props && props.length > 0) node.props = props.map((prop) => ({ ...prop }));
  if (refs && refs.length > 0) node.refs = refs.map((ref) => ({ ...ref }));
  if (icon !== undefined && icon.length > 0) node.icon = icon;
  return node;
}

export interface CreateMindFileOptions {
  /** 文件标题（`meta.title`），也是中心主题的初始文字 */
  title?: string;
  /** 中心主题的初始文字（默认跟标题走） */
  rootText?: string;
  view?: Partial<MindViewState>;
  /** 注入时钟，仅为可测试性（与 `createId` 的 `now` 同一条约定） */
  now?: () => string;
}

/**
 * 新建一份脑图。
 *
 * ★ **必定带一个中心主题**（`06 §1` 第 9 条）：`rootId` 指向它，而它是此时唯一的节点。
 *   空脑图不是一个合法状态 —— 没有中心主题，"加子节点""加兄弟节点"这些动作就没有起点。
 * ★ `revision` 从 0 起：它还没落过盘，第一次保存才递增（与白板 `createBoardFile` 同一口径）。
 */
export function createMindFile(options: CreateMindFileOptions = {}): MindFile {
  const now = (options.now ?? defaultNow)();
  // ★ 默认名走 i18n（`mind.untitled`），与白板的 `board.untitled` 同一条：
  //   这个字符串会写进 `meta.title`、也会当文件名，所以它必须是**当前语言**下的默认名
  //   —— 两处各写一份字面量迟早会分叉（`board.untitled` 的注释说的就是这件事）
  const title = options.title ?? t('mind.untitled');
  const root = createMindNode({ text: options.rootText ?? title, order: 0 });

  const meta: MindMeta = {
    id: createId(ID_PREFIX.mind),
    title,
    createdAt: now,
    updatedAt: now,
  };

  return {
    spec: MIND_SPEC,
    version: MIND_VERSION,
    revision: 0,
    meta,
    view: { ...DEFAULT_MIND_VIEW, ...options.view },
    rootId: root.id,
    nodes: [root],
  };
}

function defaultNow(): string {
  return new Date().toISOString();
}
