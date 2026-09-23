/**
 * 白板 → 脑图的门（`F3a`）：那张脑图卡要读写 `.nestmind`，而 `cards/**` 不许
 * import `obsidian`（卡片定义要能在 node 下单测）。于是照 `VaultBridge` 的老办法，
 * 只声明**能力形状**，由视图（`BoardView`）按自己的仓储（`MindRepository`）实现。
 *
 * ★ 为什么放在 `mind/` 而不是 `cards/`：`F4`（白板内建脑图卡）与它共用同一套渲染，
 *   到时候两边引的是同一个接口；接口住在渲染层这一侧，`cards/**` 与 `mind/**` 都能引，
 *   而反向（`mind/**` → `cards/**`）被 eslint 钉着不许。
 * ★ 全部是**同步**方法，只有 `open` 是异步的（首次要读盘）：渲染路径上除它以外
 *   不该有 `await` —— 卡片渲染是同步的，进去一 `await` 就得处理"画完之前卡片已被回收"。
 */
import type { MindFile } from '../model/schema';

/**
 * 节点右键菜单要的那点上下文（这一层不认识 `Menu`，它只把意图递出去）。
 *
 * ★ 两种数据源：**文件卡**（`F3a`）给 `path`，菜单那一侧去仓储里读那份 `.nestmind`；
 *   **内嵌脑图卡**（`F4`）没有文件，模型就在卡片自己的 `content` 里 ⇒ 给 `inline`
 *   （读写两个口 + "打开"那一项不存在）。菜单项本身共用一份实现（`BoardView.showMindNodeMenu`）。
 */
export interface MindNodeMenuRequest {
  /** 哪一份脑图（`.nestmind` 的库内路径）；内嵌卡给空串 */
  path: string;
  nodeId: string;
  /** 触发它的那一下（视图据此定位菜单；位置取 `clientX/clientY`） */
  event: MouseEvent;
  /**
   * **是哪张卡**上的那次右键（两张脑图卡都给）。
   *
   * ★ 用来在**根节点**的菜单里并上"卡片级"那一套（用户 2026-09-21 定的：无框之后
   *   拖动 / 选中 / 菜单这些入口都挂到根节点上）—— 卡片菜单是**按卡**算的
   *   （颜色 / 锁定 / 复制 / 删除都在那张卡上），所以这一层必须知道是哪一张。
   * ★ 同一份 `.nestmind` 可能同时展现在好几张卡上；这里给的是**被右键的那一张**。
   */
  cardId?: string;
  /**
   * "加完节点之后把光标送进新节点"用的**请求键**（`mind/embed/editRequest` 的那个 key）。
   *
   * ★ 必须由**渲染那一侧**给：同一个动作在两种宿主上有两个不同的键 ——
   *   白板级脑图（`MindLayer`）按**脑图 id** 取（一个 id 只挂一份），
   *   而老的脑图**卡**按**文件路径**取（一张卡就是一个文件）。
   *   菜单这一层两种都不认识，只能被告诉。
   * ★ 缺席时退回 `path`（老行为）。**文件脑图**如果退回 `path` 就永远取不到：
   *   白板那侧写进槽里的是 `mind.id` —— 用户看到的正是"加完节点，光标没进来"。
   */
  editKey?: string;
  /** 内嵌脑图（`F4`）：**数据不在文件里**，通过这两个口读写 */
  inline?: MindInlineSource;
}

/**
 * 这次右键的"加完节点把光标送进哪"该用哪个**请求键**。
 *
 * ★ 抽成纯函数是为了能单测：菜单本身要 Obsidian 的 `Menu`（在视图里），
 *   而"两种宿主各用哪个键"正是这一批踩过一次的地方（见 `editKey`）。
 */
export function mindEditKeyOf(request: MindNodeMenuRequest): string {
  return request.editKey ?? request.path;
}

/**
 * 卡内脑图**此刻选中了哪个节点**（`F4`，用户 2026-09-21："点击脑图节点，在画布上，
 * 底部也可以出现对应节点的快捷操作栏"）。
 *
 * ★ 与 {@link MindNodeMenuRequest} 同一种做法（视图按它读写那份模型），区别是这条
 *   **不是一次性事件**：栏要一直记着"现在操作的是哪个节点"，所以调用方会把整份请求存下来，
 *   每次刷栏时按 `path` / `inline` 现读模型（节点可能已经被改过好几轮）。
 */
export interface MindNodeFocus {
  /** 哪一份脑图（`.nestmind` 的库内路径）；内嵌卡给空串 */
  path: string;
  /** 是哪张卡上的那次点击（栏的"只读"判定与后续写入都要知道是谁） */
  cardId: string;
  /** 选中的节点；`null` = 卡内此刻没有选中任何节点（栏收起） */
  nodeId: string | null;
  /** 内嵌脑图（`F4`）：**数据不在文件里**，通过这两个口读写 */
  inline?: MindInlineSource;
}

/** 内嵌脑图的读写口（`F4`：卡片内容里那一份模型） */
export interface MindInlineSource {
  /** 这张卡的 id（根节点菜单要按卡算"卡片级"那一套，见 `MindNodeMenuRequest.cardId`） */
  cardId: string;
  /** 此刻的模型（读不到给 `null` —— 菜单据此什么都不画） */
  read(): MindFile | null;
  /** 改一次（一次 `updateContent` = 白板撤销栈里的**一步**） */
  mutate(mutator: (mind: MindFile) => void | boolean): boolean;
  /** 加完节点后把光标送进新节点（`mind/embed/editRequest.ts`） */
  requestEdit(nodeId: string): void;
}

export interface MindBridge {
  /**
   * 这份 `.nestmind` 还在不在。
   *
   * ★ 与 `open()` 分开：`open()` 失败也可能是"文件坏了"（进保护态），
   *   两者在卡面上要显示不同的话（"文件没了" vs "读不出来"）。
   */
  exists(path: string): boolean;
  /** 打开并规范化（已经打开过就直接给内存里那份）；读不到 / 坏了给 `null` */
  open(path: string): Promise<MindFile | null>;
  /** 此刻内存里的模型（没打开过给 `null` —— 用来判断值不值得重画） */
  get(path: string): MindFile | null;
  /**
   * 改一次模型：**同步**应用、返回是否真的改了（`false` = 模型没动，别重画）。
   *
   * ★ 写回策略（原子写 / revision / 冲突检测 / 只读保护）全在仓储那一侧，
   *   卡片只管"我要把这条改成那样" —— 与引用卡的 CAS 写回同一条分工。
   * ★ 保护态（解析失败）时仓储会**抛错**：调用方（卡片）包一层 try 当作"没改成"，
   *   不让一次写入失败把整张卡画崩。
   */
  mutate(path: string, mutator: (mind: MindFile) => void | boolean): boolean;
  /** 这份脑图现在是不是**只读**（保护态）：只读时不接任何编辑手势 */
  isReadOnly(path: string): boolean;
  /**
   * 订阅这份脑图的变化（我们自己的改动、外部编辑、重载都会来）。
   *
   * @returns 退订函数（卡片被回收时必须调 —— 引用卡的 `watch` 是同一条纪律）
   */
  watch(path: string, listener: () => void): () => void;
  /** 在新标签打开它（双击卡的空白处 / 右键「打开脑图」） */
  openTab(path: string): void;
  /**
   * 节点右键菜单（可选）。
   *
   * ★ 菜单要 Obsidian 的 `Menu`，而 `cards/**` 不认识它 ⇒ 由视图注入。
   *   不给 = 卡上不接右键（其余手势照常）。
   */
  nodeMenu?(request: MindNodeMenuRequest): void;
  /**
   * 卡内**选中节点变了**（`F4`）。不接 = 卡内点节点不联动底部那条快捷操作栏。
   *
   * ★ 与 `nodeMenu` 分开而不是复用：那条是"一次右键"，这条是"一直记着现在选的是谁"，
   *   生命周期完全不同（一个是事件，一个是状态）。
   */
  nodeFocus?(focus: MindNodeFocus): void;
}
