/**
 * 全局常量（T1.06）。
 *
 * 只放"跨模块共享的字面量"，放业务语义的东西一律去 model/。
 * 本文件不得 import 任何模块（保持零依赖，可被任何层安全引用）。
 */

import type { Card } from './model/schema';

/** 视图类型（`registerView` / `getLeavesOfType` 用），T1.23 起使用 */
export const VIEW_TYPE_BOARD = 'nestboard-board';

/**
 * 侧栏「跨白板反链」视图类型（T5.03）。
 *
 * ★ 与 `VIEW_TYPE_BOARD` 平级放在这里，是因为它同样是**被 Obsidian 托管的视图**：
 *   `getLeavesOfType` 要用同一个字符串去找它，字面量写两处就是"改一处漏一处"。
 */
export const VIEW_TYPE_BACKLINK = 'nestboard-backlinks';

/**
 * 侧栏「卡片属性」（`B1`，用户 2026-09-18："打开一个右侧窗口操作卡片的全属性"）。
 *
 * ★ 用法与 `VIEW_TYPE_BACKLINK` 完全一样：`getLeavesOfType` 要用同一个字符串找它，
 *   所以它也必须住在 `constants.ts`（散在各处的话，改名就是一个安静的失效）。
 * ★ 它**没有**对应的文件扩展名 ⇒ 不 `registerExtensions`（只有 `registerView`）。
 */
export const VIEW_TYPE_CARD_INSPECTOR = 'nestboard-card-inspector';

/**
 * 侧栏「白板列表」视图类型（T5.08）。
 *
 * ★ 与 `VIEW_TYPE_BACKLINK` 同理：`getLeavesOfType` 要用同一个字符串去找它。
 */
export const VIEW_TYPE_BOARD_LIST = 'nestboard-board-list';

/**
 * 侧栏「跨白板搜索」视图类型（T7.02 / `F8-08`）。
 *
 * ★ 与 `VIEW_TYPE_BOARD_LIST` 同理：`getLeavesOfType` 要用同一个字符串去找它。
 */
export const VIEW_TYPE_BOARD_SEARCH = 'nestboard-board-search';

/**
 * 脑图视图类型（`06 §2`）。
 *
 * ★ 同 `VIEW_TYPE_BOARD_SEARCH`：`getLeavesOfType` 要用同一个字符串去找它，
 *   而"打开一份脑图"走的是与白板同一套三段式（见 `mind/view/host.ts`）。
 */
export const VIEW_TYPE_MIND = 'nestboard-mind';

/** 白板文件扩展名（不含点，03 §2.1） */
export const BOARD_EXT = 'nboard';

/**
 * 脑图文件扩展名（不含点，`06 §3`）。
 *
 * ★ 与 `BOARD_EXT` 平级放在这里，而不是塞进 `mind/`：它要被三处引用 —— 视图注册
 *   （`main.ts` 的 `registerExtensions`）、Vault 事件的分流、以及"这个文件该谁管"的判断，
 *   与 `.nboard` 当年遇到的是同一件事（字面量散开就是"改一处漏一处"的开始）。
 */
export const MIND_EXT = 'nestmind';

/**
 * JSON Canvas 1.0 的扩展名（T4.11 / T4.12）。
 *
 * ★ 定义在这里而不是写在 `export/jsonCanvas.ts` 里：`main.ts` 的文件右键菜单、
 *   动作层、导出层三处都要判断"这是不是一张画布"，而字面量散开正是那种
 *   "改一处漏一处"的开始（例如把 `.canvas` 误判成 `.nboard`）。
 */
export const CANVAS_EXT = 'canvas';

/** 规范标识与数据版本（03 §2.2） */
export const BOARD_SPEC = 'nestboard/1';
/**
 * 当前插件**认识**的最高数据版本（`03 §2.2`）。
 *
 * ★ `2` = 白板里可以出现 `minds[]`（脑图升格为白板对象，`2.2.0`）。v1 → v2 **不需要改
 *   任何文本**（新键是可选键），所以迁移链上那一步是恒等的，见 `io/migrate.ts`。
 * ★ **写盘时不一定写它**：见 {@link LEGACY_BOARD_VERSION} —— 文件的版本号跟着**它真正
 *   用到的东西**走。
 */
export const BOARD_VERSION = 2;

/**
 * "什么新东西都没用到"的板子写回去的版本号（`1`）。
 *
 * ★ 为什么不是无脑写 `BOARD_VERSION`：老插件（`2.1.4` 及更早）见到 `version > 1` 会
 *   **进只读保护态**（`migrate.ts` 的 `future-version` + `main.ts` 的提示），那是刻意的
 *   保护 —— 但它意味着"升级一次，所有板子都打不开了"。
 * ★ 于是规则是：**一块板只要没有脑图（`minds` 缺席 / 空），就仍然写 `1`** ——
 *   这类板子老新版本**双向完全互通、一个字节都不差**（用户 2026-09-21 明确问过这一条）。
 *   真的建了脑图才写 `2`，那时老版本会**明确拒绝**（提示 + 只读保护 + 不写盘），
 *   而不是"能打开、保存时把脑图丢掉"。这条比"能打开"重要得多（见 `12 §4.6`）。
 */
export const LEGACY_BOARD_VERSION = 1;

/**
 * 脑图的规范标识与数据版本（`06 §3`）。
 *
 * ★ **各走各的版本号**：脑图加字段不该逼着白板"升版本"，反过来也一样。
 *   迁移表（`io/migrate.ts`）到时候也各有一份 —— 两种格式的字段几乎不重叠。
 */
export const MIND_SPEC = 'nestmind/1';
export const MIND_VERSION = 1;

/** 序列化缩进：2 空格，人类可读、git diff 友好（03 §2.1） */
export const BOARD_JSON_INDENT = 2;

/**
 * 白板级脑图**容器**元素上的属性名（`2.2.0`）。
 *
 * ★ 与 `CARD_ID_ATTR` / `COLUMN_ID_ATTR` / `GROUP_ID_ATTR` 同一套做法：
 *   命中测试、诊断、以及"这个 DOM 属于哪个白板对象"都读这一个名字，不散落字符串。
 * ★ 值 = 容器的 id（`Mind.id`）——连线端点、选区、撤销都认同一个 id。
 */
export const MIND_CONTAINER_ID_ATTR = 'data-mind-id';

/** 新白板目录的**默认值**（真正生效的值在 `settings.newBoardFolder`，T1.74 / `F11-05`） */
export const DEFAULT_BOARD_FOLDER = 'Boards';

/**
 * 新脑图目录的**默认值**（`06 §3`）。
 *
 * ★ `P0` 先写成常量：脑图还没有自己的设置页（设置项与白板并列要等 P2 的一批）。
 *   放在这里而不是硬编码在 `newMind.ts` 里，是为了**下一步接设置**时只改一处 ——
 *   与 `DEFAULT_BOARD_FOLDER` 当年"先常量、后设置"的路径完全一样。
 * ★ 与白板分目录：`Boards/` 里全是白板文件时，文件树一眼能看出"这堆是板"。
 */
export const DEFAULT_MIND_FOLDER = 'Minds';

/**
 * 用户模板目录的**默认值**（真正生效的值在 `settings.templateFolder`，T4.14 / `F7-06`）。
 *
 * ★ 默认取 `Templates` 而不是塞进 `Boards/` 下面：模板是**另一种用途的白板文件**，
 *   跟"已经开工的白板"混在一个目录里，用户翻文件时第一眼分不出哪个能动。
 *   代价是模板文件会出现在白板选择器里（它本来就是合法的 `.nboard`），
 *   这条取舍写在 README 的局限里，不是漏掉的。
 */
export const DEFAULT_TEMPLATE_FOLDER = 'Templates';

/**
 * Home 白板路径的**默认值**（T5.07 / `F7-03` / `F11-09`）。
 *
 * ★ 用**硬编码的 ASCII 文件名**而不是 `t('board.home')`：它是**数据**（会真的在用户库里
 *   落一个文件），不是一个界面文案。跟着语言走的话，同一个库在两台不同语言的机器上
 *   会指向两个不同的文件 —— 而 `.data.json` 里存的是路径字符串，不会跟着翻译。
 *
 * ★ 用 `Boards/` 而不是跟随 `settings.newBoardFolder`：默认值必须是**常量**，
 *   而"跟随另一个设置"意味着用户一改新建目录，Home 的位置就悄悄变了 ——
 *   已经落在旧位置的 Home 板上那些卡片会显得"不见了"。用户想改位置就自己去设置里改。
 */
export const DEFAULT_HOME_BOARD_PATH = `${DEFAULT_BOARD_FOLDER}/Home.nboard`;

/**
 * 索引笔记目录的**默认值**（T7.01 / `F10-09` / `F7-09`）。
 *
 * ★ 三件事都照 `DEFAULT_HOME_BOARD_PATH` 的规矩来：硬编码 ASCII、不跟随
 *   `settings.newBoardFolder`、写在 `Boards/` 之下。
 *
 * ★ 之所以放在 `Boards/_index` 而不是库根：索引笔记是**生成物**，用户在大纲里翻到
 *   一沓不认识的文件会当成 bug。塞进一个带下划线的子目录，既能一眼看出"这堆是插件
 *   的东西"，又不会跟用户自己建的 `Boards/` 子目录混在一起（下划线开头的目录名在
 *   项目里已经表示"插件自己的"）。它仍然在 `Boards/` 之内，是为了让
 *   "整个白板体系"只用管一个顶层目录 —— 备份、同步、排除都只写一条规则。
 */
export const DEFAULT_INDEX_NOTE_FOLDER = `${DEFAULT_BOARD_FOLDER}/_index`;

/**
 * 收件箱分栏的标题（T5.07 / `F7-03`）。
 *
 * ★ 同样刻意**不翻译**，理由与 `DEFAULT_HOME_BOARD_PATH` 一致：它会被写进 `.nboard`
 *   文件的 `columns[].title`，是数据。而且"默认落点"这件事要靠**按标题找那一栏**来实现 ——
 *   标题一旦跟着语言变，`?file=` 那种跨设备场景下就找不到收件箱了。
 *   （用户在界面上看到的仍是这一栏自己的标题，他当然可以随时改名；改名之后
 *   "默认落点"会退回视口中心，而不是报错。）
 */
export const UNSORTED_COLUMN_TITLE = 'Unsorted';

/** 自动保存防抖的**默认值**（ms，03 §5；真正生效的值在 `settings.autosaveDebounceMs`） */
export const DEFAULT_AUTOSAVE_DEBOUNCE_MS = 400;

/** 外部改动重载防抖（ms）：比保存更短，外部编辑要尽快反映（03 §3.3 W4） */
export const DEFAULT_RELOAD_DEBOUNCE_MS = 100;

/** 定时兜底 flush 间隔（ms，T1.12 的第三道保险） */
export const FLUSH_INTERVAL_MS = 30_000;

/**
 * 快照（T4.01 / `F11-11`，03 §3.5）。
 *
 * ★ 为什么放在 `constants.ts` 而不是设置里：这三个值是"数据保护的安全底线"，
 *   不该让用户凭感觉调成 1 分钟 / 1000 份 —— 前者会让大板每拖一下就写一份快照，
 *   后者会让插件目录悄悄膨胀。用户可以整体关掉，但不提供细调旋钮。
 */
export const SNAPSHOT_MIN_INTERVAL_MS = 5 * 60 * 1000;
export const SNAPSHOT_MAX_COUNT = 50;
export const SNAPSHOT_MAX_BYTES = 20 * 1024 * 1024;

/** 快照放库内时的目录名（以 `.` 开头 → Obsidian 自动忽略，不进文件浏览器，03 §1.4 B 方案） */
export const SNAPSHOT_VAULT_DIR = '.nestboard-history';

/** 快照放插件目录时的子目录名（03 §1.4 A 方案，默认） */
export const SNAPSHOT_PLUGIN_DIR = 'snapshots';

/** ID 前缀（03 §2 示例：`nb_01H8XQ…`） */
export const ID_PREFIX = {
  board: 'nb',
  /** 脑图文件自己的稳定 ID（`06 §3` 的 `meta.id`） */
  mind: 'nm',
  card: 'c',
  /** 脑图节点（`06 §3`）：与卡片的 `c` 分开，光看 ID 就知道它属于哪个文档类型 */
  mindNode: 'n',
  column: 'col',
  edge: 'e',
  group: 'g',
  /**
   * 同步便签的**同步组** id（T7.04）。同组的多张同步便签共享它。
   *
   * ★ 单开一个前缀（而不是复用 `card`）：它**不是**任何一张卡的 id。在 `.nboard`
   *   里能一眼看出"这是一串组键，不是卡片引用"，排查"两张卡为什么一起变"时很省事。
   */
  sync: 'sy',
  /**
   * **关联线**（`N1`）的 id。
   *
   * ★ 单开一个前缀（而不是复用 `mindNode`）：它**不是**节点，而是"两个节点之间的一条线"——
   *   在 `.nestmind` 里一眼能看出这是线，排查"这条线为什么不见了"时省事。
   */
  mindLink: 'l',
  /**
   * 评论卡里**单条备注**的 id（T7.05）。
   *
   * ★ 单开一个前缀（而不是复用 `card`）：它不是任何一张卡的 id，而是"线程里的一条"。
   *   在 `.nboard` 里一眼能看出这是条目 id，排查"删错了哪一条"时很省事。
   * ★ 也不用 `c`：卡片 id 与条目 id 混在同一个命名空间里，`grep` 一个 id 会同时
   *   命中卡片和评论条目 —— 那种噪音在排查事件委托问题时最费时间。
   */
  comment: 'cmt',
} as const;

/**
 * 卡片 DOM 上的 ID 属性名（T1.30）。
 *
 * 卡片层负责**写**（`CardLayer.applyCard`），命中测试/事件委托负责**读**
 * （`HitTest.resolveCardElement`）。写在常量里是为了让这两处不会各写一份字符串而漂移。
 */
export const CARD_ID_ATTR = 'data-card-id';

/**
 * 尺寸手柄的方位属性名（T1.37）。
 *
 * 与 `CARD_ID_ATTR` 同样的理由写进常量：卡片层负责**写**（`CardLayer.createNode`
 * 建 8 个手柄并把方位写进这个属性），拖动控制器负责**读**（判断用户抓住了哪条边/角）。
 * 两处各写一份字符串，改一个地方就是"手柄看得见却拖不动"。
 */
export const RESIZE_HANDLE_ATTR = 'data-resize-handle';

/**
 * 旋转手柄上的属性名（T7.06 / `F2-00-10`）。
 *
 * 与 `RESIZE_HANDLE_ATTR` 同源理由：卡片层负责**写**（`CardLayer.createNode`
 * 建这一个手柄），拖动控制器负责**读**（判断这一按是不是抓住了旋转柄）。
 *
 * ★ 与尺寸手柄分成**两个**属性，而不是共用一个靠"值"区分：尺寸手柄的值是方位名
 *   （`nw` / `e`…），旋转手柄没有方位 —— 共用一个属性就得往方位枚举里塞一个
 *   不是方位的值，于是命中测试、`resizedRect`、样式表每一处都要为它特判一次。
 */
export const ROTATE_HANDLE_ATTR = 'data-rotate-handle';

/**
 * 分栏元素上的 ID 属性名（T1.54）。
 *
 * 与 `CARD_ID_ATTR` 同源理由：`ColumnLayer` 负责**写**，命中测试与事件委托负责**读**。
 * ★ 分栏与卡片刻意用**两个**属性而不是共用一个：卡片拖动的落点判定要区分
 *   "拖到了另一张卡上"（编组）和"拖到了某个分栏里"（T1.55 收进分栏），
 *   一个属性会让这两条路径在 `closest()` 里互相污染。
 */
export const COLUMN_ID_ATTR = 'data-column-id';

/** 分栏标题栏上的动作属性（折叠开关）；写在常量里避免读写两处各写一份字符串 */
export const COLUMN_ACTION_ATTR = 'data-column-action';

/**
 * 编组元素上的 ID 属性名（O03）。
 *
 * 与 `COLUMN_ID_ATTR` 同源理由：`GroupLayer` 负责**写**，事件与测试负责**读**。
 */
export const GROUP_ID_ATTR = 'data-group-id';

/** 编组标签条上的动作属性（收起 / 展开开关）；与 `COLUMN_ACTION_ATTR` 同一套写法 */
export const GROUP_ACTION_ATTR = 'data-group-action';

/**
 * 画布**内部**的可交互控件标记（T3.07）。
 *
 * 像手绘工具条这种浮在画布上的控件，虽然视觉上属于界面，DOM 上却住在画布容器里 ——
 * 于是画布上的手势监听（捕获阶段的 `InkController`、`NavigationController`）
 * 会先于控件本身收到 `pointerdown`："点一下换颜色"顺手在画布上落一个点，
 * 触屏上还会连带把画布平移走。
 *
 * ★ 约定：任何控件只要带上这个属性，画布手势就必须让路（见 `InkController.onPointerDown`）。
 *   用 `closest()` 判定而不是逐个传元素，是为了嵌套的控件内部节点（图标、文字）也能被认出来。
 */
export const OVERLAY_UI_ATTR = 'data-nestboard-ui';

/**
 * 自动高度（T1.38）每次最多长高多少 px。
 *
 * 量到内容需要 3000px 就真的把卡片撑到 3000px 是**灾难**：这张卡会盖住整块白板，
 * 用户连关掉它的手柄都找不到。超过这个增量时分批长高，用户能看见并中断
 * （拖一下卡片即可，因为高度写回是异步的）。
 */
export const AUTO_HEIGHT_MAX_STEP = 240;

/**
 * 卡片尺寸下限（世界坐标 px）。
 *
 * 两个地方都要用它：控制器钳制拖动结果（手感），`model/ops.applyCardRects` 兜底
 * （数据完整性）。小于这个尺寸的卡片在界面上是一根线，连尺寸手柄都点在卡片外面，
 * 用户没有任何办法把它抓回来 —— 所以这是**硬下限**，不是建议值。
 */
export const MIN_CARD_SIZE = { width: 80, height: 60 } as const;

/**
 * 白板卡 mini 形态的**固定正方形边长**（`O18`，世界坐标 px）。
 *
 * ★ 取**便签默认宽的三分之一**（`cards/note.ts` 的 `NOTE_DEFAULT_SIZE.width = 260`，
 *   260 ÷ 3 ≈ 87）：这个形态的用途是"把几块子板排成一排当目录看"（`O09`），
 *   一排里每一格占地越少越好，而 87px 是"手心里还认得清那个 emoji"的下限
 *   —— 再小就只剩一个色点，图标与文件名都白设了。
 * ★ 数值写死在这里而不是从 `NOTE_DEFAULT_SIZE` 算出来：本文件**不得 import 任何模块**
 *   （见文件头），而它是三个地方共用的那一份 —— 读入口（`model/validate` 归一存量卡）、
 *   写入口（`view/BoardView.setBoardRefPreview` 钉尺寸）、样式表（`styles.css` 的
 *   图标与字号都按这个量级估）。三处的一致性由
 *   `tests/cards/boardRef.test.ts` 里那条"等于便签默认宽 1/3"钉住。
 * ★ 87 > `MIN_CARD_SIZE.width`（80），所以不会被尺寸兜底钳掉 —— 这条很重要：
 *   一旦它小于下限，mini 卡会被 `applyCardRects` 静默撑大，正方形就不再是正方形了。
 */
export const BOARD_REF_MINI_SIZE = { width: 87, height: 87 } as const;

/**
 * 卡片**收起**后的显示高度（`O31`，世界坐标 px）。
 *
 * ★ 收起 = 只留标题那一行（内容槽 `display:none`）。这个数字必须与 `CardLayer`
 *   写进 `style.height` 的值、以及 {@link cardDisplayHeight} 给几何用的值**同源** ——
 *   否则"看到的高度"与"命中 / 连线 / 框选用到的高度"会差一截。
 * ★ 取的是一个**够放下一行标题**的固定值（与分栏的 `COLUMN_LAYOUT.collapsedHeight`
 *   同一套做法）：真正的行高随字号设置变，动态量一次会把这里变成每帧测量。
 */
export const CARD_COLLAPSED_HEIGHT = 34;

/**
 * 卡片在**屏幕上**的高度（`O31`）：收起时只有标题行那么高。
 *
 * ★ 单独抽出来是因为它有**四个**消费方（`CardLayer.cardRect`、`BoardView.toCardRect`、
 *   骨架写 `style.height`、以及"要不要跳过自动高度"），各算一遍迟早在某处漏掉。
 */
export function cardDisplayHeight(card: Pick<Card, 'height' | 'collapsed'>): number {
  return card.collapsed === true ? CARD_COLLAPSED_HEIGHT : card.height;
}

/** 方向键微移步长：`方向键` / `⇧`+方向键（`02 §4.1` 卡片操作表） */
export const NUDGE_STEP = { small: 1, large: 10 } as const;

/**
 * 旋转的 `⇧` 吸附步长（度，T7.06）。
 *
 * 15° 是**一整个圆 24 等分**：八个正方向（0 / 45 / 90 / …）与它们的半格全落在格点上，
 * 恰好盖住"把卡片摆正""摆成 45° 斜排""转 30° 做手写标注"这几个真实诉求。
 * 更细的格（1°、5°）靠手感就行，不需要吸附；更粗的格（30°/45°）又排不下 15° 这一档。
 */
export const ROTATE_SNAP_STEP = 15;

/**
 * `⌘D` 复制卡片的落点偏移（世界坐标 px）。
 *
 * 偏移 0 会让副本与原卡**完全重合** —— 用户看到"什么都没发生"，
 * 然后连续按 ⌘D 十次，得到十张叠在一起的卡。错开一点点是"看得见"的最低成本。
 */
export const DUPLICATE_OFFSET = { x: 24, y: 24 } as const;

/** 撤销栈深度上限与总体积预算（T1.48）：白板可能很大，栈不能无限长 */
export const HISTORY_LIMIT = 50;
export const HISTORY_BYTES_BUDGET = 8 * 1024 * 1024;

/** 同一次拖动的多次提交合并成一条历史的窗口（ms） */
export const HISTORY_MERGE_WINDOW_MS = 600;

/**
 * 「最近打开」保留多少块白板（T5.08 / `F7-04`）。
 *
 * ★ 有上限是**必须的**，不是为了省那点体积：这个列表每次打开一块板就要写一次
 *   `data.json`，无上限的话它会长成唯一一个"只增不减"的字段。
 */
export const RECENT_BOARDS_LIMIT = 20;

/**
 * 命令 ID。
 * ★ 合规要求（04 §13）：**不要**自己加 `nestboard-` 前缀，Obsidian 会自动加。
 */
export const COMMAND_IDS = {
  createBoard: 'create-new-board',
  zoomIn: 'zoom-in',
  zoomOut: 'zoom-out',
  zoomReset: 'zoom-reset',
  zoomFit: 'zoom-fit-content',
  selectAll: 'select-all',
  bringToFront: 'bring-selection-to-front',
  sendToBack: 'send-selection-to-back',
  newNote: 'new-note',
  newTodo: 'new-todo',
  newSwatch: 'new-swatch',
  newMap: 'new-map',
  newSyncNote: 'new-sync-note',
  newComment: 'new-comment',
  editSelection: 'edit-selected-card',
  deleteSelection: 'delete-selection',
  duplicateSelection: 'duplicate-selection',
  copySelection: 'copy-selection',
  cutSelection: 'cut-selection',
  toggleTitle: 'toggle-card-title',
  toggleLock: 'toggle-card-lock',
  promoteSelection: 'promote-selection-to-note',
  undo: 'undo',
  redo: 'redo',
  // Sprint 4：分栏与嵌套白板（T1.58 / T1.59 / T1.61 / T1.62）
  splitIntoColumns: 'split-into-columns',
  collectIntoColumn: 'collect-into-column',
  toggleColumnCollapse: 'toggle-column-collapse',
  openParent: 'open-parent-board',
  navigateBack: 'navigate-back',
  navigateForward: 'navigate-forward',
  addToBoard: 'add-to-board',

  // Sprint 5：导出（T1.72）
  exportMarkdown: 'export-markdown',

  // Sprint 5：重命名 / 移动（T1.73）
  renameBoard: 'rename-board',

  // Sprint 6：白板内搜索（T2.09 / T2.10）
  search: 'search-in-board',
  searchNext: 'search-next-match',

  // Sprint 6：导出 PNG（T2.11）
  exportPng: 'export-png',

  // 期 4：导出 PDF（T4.10）
  exportPdf: 'export-pdf',

  // 期 6：导出 SVG（T6.01 / F9-06）
  exportSvg: 'export-svg',

  // 期 6：导出 ZIP（T6.02 / F9-07）
  exportZip: 'export-zip',

  // 期 6：打印（T6.03 / F9-10）
  printBoard: 'print-board',

  // 期 4：`.canvas` 互转（T4.11 / T4.12）
  exportCanvas: 'export-canvas',
  importCanvas: 'import-canvas',

  // Sprint 7：诊断信息面板（T2.17）
  showDiagnostics: 'show-diagnostics',

  // Sprint 7：大文件分级退化（T2.16）
  splitBoard: 'split-board',

  // Sprint 8：待办总览浮层（T3.03 / F2.5）
  todoOverview: 'toggle-todo-overview',

  // Sprint 8：手绘（T3.06 / F4-01、F4-03）
  inkBrush: 'ink-brush',
  inkEraser: 'ink-eraser',
  inkSelect: 'ink-select',
  clearInk: 'clear-ink',
  // 期 7：荧光笔 / 临时标注层（T7.08 / F4-07、T7.07 / F4-06）
  inkMarker: 'ink-marker',
  inkAnnotate: 'ink-annotate',
  // Sprint 8：手绘颜色与笔宽（T3.07 / F4-02）
  inkColor: 'ink-color',
  inkSwapColor: 'ink-swap-color',
  inkWidth1: 'ink-width-1',
  inkWidth2: 'ink-width-2',
  inkWidth3: 'ink-width-3',
  inkWidth4: 'ink-width-4',

  // Sprint 9：网格吸附（T3.11 / F5-02）
  toggleGridSnap: 'toggle-grid-snap',

  // Sprint 9：对齐 / 等距分布（T3.13 / F5-04）
  alignLeft: 'align-left',
  alignRight: 'align-right',
  alignTop: 'align-top',
  alignBottom: 'align-bottom',
  alignCenterX: 'align-center-x',
  alignCenterY: 'align-center-y',
  distributeX: 'distribute-horizontal',
  distributeY: 'distribute-vertical',

  // Sprint 9：编组 / 取消编组（T3.14 / F5-05）
  groupCards: 'group-cards',
  ungroupCards: 'ungroup-cards',

  // Sprint 9：同组分栏对齐（T3.15 / F5-01）
  alignColumns: 'align-columns',

  // Sprint 9：卡片类型 / 标签过滤（T3.17 / T3.18 / F8-04 / F8-06）
  toggleCardFilter: 'toggle-card-filter',

  // Sprint 9：断链总览（T3.19 / F8-07）
  linkOverview: 'toggle-link-overview',

  // Sprint 9：复制为 Markdown（T3.20 / F9-08）
  copyMarkdown: 'copy-as-markdown',

  // 期 4：版本快照（T4.01 / T4.02 / F11-11）
  createSnapshot: 'create-snapshot',
  snapshotHistory: 'open-snapshot-history',

  // 期 4：删除与同步冲突（T4.03 / T4.04）
  deleteBoard: 'delete-board',
  viewConflicts: 'view-sync-conflicts',

  // 期 4：归档只读（T4.06 / 03 §2.5）
  lockBoard: 'lock-board',
  unlockBoard: 'unlock-board',

  // 期 4：整理未使用附件（T4.05 / 03 §4）
  auditAttachments: 'audit-attachments',

  // 期 4：修复引用（T4.07 / 03 §9 R10）
  repairRefs: 'repair-refs',

  // 期 4：模板库（T4.14 / F7-06）
  newBoardFromTemplate: 'new-board-from-template',
  saveBoardAsTemplate: 'save-board-as-template',

  // 期 5：跨白板反链（T5.03 / F10-08）
  openBacklinks: 'open-backlinks',

  // 期 5：Home 白板 / 收件箱（T5.07 / F7-03 / F11-09）
  openHome: 'open-home-board',
  addToUnsorted: 'add-to-unsorted',

  // 期 5：白板列表侧栏（T5.08 / F7-04）
  openBoardList: 'open-board-list',

  // 期 5：缩略图导航器（T5.09 / F1-06）
  toggleMinimap: 'toggle-minimap',

  // 期 7：跨白板搜索（T7.02 / F8-08）
  openBoardSearch: 'open-board-search',

  // 期 5：演示模式（J-06 / J-07）
  startPresentation: 'start-presentation',
  endPresentation: 'end-presentation',
  presentNext: 'presentation-next-step',
  presentPrevious: 'presentation-previous-step',
  addToPresentation: 'add-to-presentation',
  removeFromPresentation: 'remove-from-presentation',
  clearPresentation: 'clear-presentation',

  // 期 6：自动整理 / 按标签自动分栏（T6.07 / T6.08 / F5-06 / F5-07）
  tidyBoard: 'tidy-board',
  groupByTag: 'group-by-tag',

  // 期 7：索引笔记（T7.01 / F10-09 / F7-09）
  rebuildIndexNotes: 'rebuild-index-notes',
  cleanupIndexNotes: 'delete-index-notes',

  // 优化（O11）：把这块板的 `obsidian://` 链接复制到剪贴板
  copyBoardLink: 'copy-board-link',
} as const;
