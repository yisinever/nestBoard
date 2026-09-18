/**
 * 分栏渲染层（T1.54 / T1.57）—— 栏背景、标题栏、折叠开关、拖动把手、尺寸手柄。
 *
 * 与 `CardLayer` 三处刻意对齐（两边行为不一致，用户第一眼就会察觉）：
 *  * **常驻 DOM + 视口裁剪**：只挂载视口内的分栏，离场立刻摘掉。分栏不做节点复用池 ——
 *    池化是为了 5000 张卡的滚动帧率，而分栏通常只有几个，池带来的状态重置风险不划算。
 *  * **只写这 5 个数字**：`left / top / width / height / z-index`。几何一律由
 *    `model/columns.ts` 算好，本层一个像素都不自己推（自己推就会出现
 *    "预览时对齐、落盘后偏一格"这种查半天的 bug）。
 *  * **拖动中不改模型**：`previewRects()` 只写 DOM，松手由视图一次提交。
 *
 * ★ 分栏元素挂在**和卡片同一个宿主**（`world`）下，不另包一层容器：
 *   `z` 是同一套数（`factories.maxZ` 同时看 `cards` 与 `columns`），
 *   多包一层就多一个层叠上下文，成员卡片反而可能被别的分栏盖住。
 *
 * ★ `collapsed` 只改**渲染高度**（`columnDisplayHeight`），不回写模型的 `height`：
 *   折叠是"暂时看小一点"，用户拖出来的高度必须留着 —— 展开回不到原高度就是功能在捣乱。
 *
 * ★ 标题的就地编辑（双击）沿用 `CardLayer.editTitle` 的做法（临时 `<input>`）：
 *   临时节点**不进**本层的挂载表，否则 `sync()` 会把它当成"结构不对"而重建，
 *   用户正在打字的光标就飞了。
 */

import type { BoardFile, CardColor, Column, ThemeColor } from '../../model/schema';
import { isHexColor, isThemeColor } from '../../model/schema';
import { columnDisplayHeight, measureColumns } from '../../model/columns';
import { columnViewport } from '../../model/columnScroll';
import { rectsIntersect, roundTo, type Rect } from '../../util/geometry';
import { t } from '../../util/i18n';
import {
  cardColorValue,
  normalizeHex,
  relativeLuminance,
  THEME_COLOR_VAR,
} from '../../util/color';
import { RESIZE_HANDLE_ATTR, COLUMN_ID_ATTR } from '../../constants';
import { RESIZE_HANDLES, type ResizeHandle } from './CardLayer';
import type { Viewport } from '../../canvas/Viewport';

/** 抓在分栏上的手势类型：整栏移动，还是拖某条边/角 */
export type ColumnGesture = { kind: 'move' } | { kind: 'resize'; handle: ResizeHandle };

export interface ColumnLayerOptions {
  /**
   * 指针按在分栏上（标题栏 = 移动，手柄 = 缩放）。
   * ★ 视图必须在这一步 `stopPropagation` 已经做好（本层已经调过），
   *   否则画布会把它当成"点了空白处"而开始框选 + 清空选区。
   */
  onPointerDown: (columnId: string, gesture: ColumnGesture, event: PointerEvent) => void;
  /** 点折叠开关（T1.57） */
  onToggleCollapse: (columnId: string) => void;
  /** 就地改名提交（T1.54 的"标题"） */
  onTitleCommit: (columnId: string, title: string) => void;
  onContextMenu: (columnId: string, event: MouseEvent) => void;
  /**
   * 栏内滚动（T2.03 / `F2-7-10`）—— 内容槽被滚动时报告偏移。
   *
   * ★ 偏移是**视图状态**：本层只管把 DOM 的 `scrollTop` 报上去，绝不自己存
   *   （卡片、连线、落点判定都要用同一个值，各存一份必然对不上）。
   */
  onScroll?: (columnId: string, offset: number) => void;
}

interface MountedColumn {
  element: HTMLElement;
  column: Column;
  titleEl: HTMLElement;
  countEl: HTMLElement;
  toggleEl: HTMLElement;
  /** 内容槽（滚动容器） */
  bodyEl: HTMLElement;
  /** 撑出滚动高度的占位块 —— 成员卡是分栏的**兄弟**，撑不了它 */
  spacerEl: HTMLElement;
}

const CLASSES = ['nestboard-column', 'is-collapsed', 'is-selected', 'is-readonly'] as const;

/**
 * 分栏标题栏的对比字色（用户 2026-09-18：分栏允许设色）。
 *
 * ★ 与卡片 `resolveInk` 同一判据（WCAG 相对亮度）：深底用白字、浅底用黑字，
 *   用户在色板里挑的红 / 黄 / 自定义 HEX 标题都读得清。
 * ★ 主题色（`1`~`6`）取的是**计算后的真实色值**：`getComputedStyle` 读到的
 *   是 `--color-red` 那一串 HEX，而不是 `var(...)` —— 用户换主题后字色照样对。
 */
function resolveColumnInk(host: HTMLElement, color: CardColor): string | null {
  let hex = '';
  if (isHexColor(color)) hex = normalizeHex(color) ?? '';
  else if (isThemeColor(color)) hex = getComputedStyle(host).getPropertyValue(THEME_COLOR_VAR[color as ThemeColor]).trim();
  if (!hex) return null;
  const lum = relativeLuminance(hex);
  if (lum === null) return null;
  return lum > 0.5 ? '#1f1f1f' : '#ffffff';
}

export class ColumnLayer {
  private readonly mounted = new Map<string, MountedColumn>();
  private columns: Column[] = [];
  /** 分栏 id → **看得见的**成员数（T1.57 折叠态要显示，收起的编组不算，`O05`） */
  private counts = new Map<string, number>();
  /** 分栏 id → 内容底边（T2.03 撑滚动高度用，与计数同一次遍历算好） */
  private contentBottom = new Map<string, number>();
  /** 视图回灌的滚动偏移（本层只用来恢复 `scrollTop`，不持有"真相"） */
  private scrollOffsets: ReadonlyMap<string, number> = new Map();
  private selected: ReadonlySet<string> = new Set();
  private dirty = true;
  private lastViewRect: Rect | null = null;
  /** 只读板（T4.06）：只影响"能拖 / 能改"的暗示，不影响内容渲染 */
  private readOnly = false;

  constructor(
    private readonly host: HTMLElement,
    private readonly options: ColumnLayerOptions,
  ) {}

  /** 已挂载的分栏数量（诊断 / 测试用） */
  get renderedCount(): number {
    return this.mounted.size;
  }

  /**
   * 换板：更新数据源并标脏，同时重建"成员计数"。
   */
  setBoard(board: BoardFile | null): void {
    if (!board) {
      this.clear();
      return;
    }
    // 按 `z` 升序：`zIndex` 才是叠放主依据，遍历顺序只给同 `z` 一个确定次序
    this.columns = [...board.columns].sort((a, b) => a.z - b.z);
    this.measure(board);
    this.lastViewRect = null;
  }

  /**
   * 重算"成员计数 + 内容底边"（T2.03），并标脏。
   *
   * ★ 内容变了但**没换板**的路径（`BoardView.refreshCards`：进出编辑态、拖动 resync）
   *   必须走它，不能只 `refresh()`：栏内滚动条的高度（占位块）是拿内容底边算的，
   *   只标脏不重算的话，卡片自动高度变高之后新内容"撑不出滚动条" ——
   *   用户加了东西却发现栏里滚不到它。
   *
   * ★ 计数搬进了模型层（`columns.measureColumns`，`O05`）：它要排除"收起编组里的成员"
   *   （栏标题上的数字与栏里看得见的张数必须一致），而"谁看得见"的判据在 `ops` 里。
   *   在本层自己算的话，判据就有两份了。一次遍历的复杂度没变。
   */
  measure(board: BoardFile): void {
    const measured = measureColumns(board);
    this.counts = measured.counts;
    this.contentBottom = measured.bottoms;
    this.dirty = true;
  }

  /** 内容变更但未换板：标脏（与 `CardLayer.refresh` 同义） */
  refresh(): void {
    this.dirty = true;
  }

  /**
   * 被隐藏的分栏（用户 2026-09-16：收起的编组罩着的栏）与"这份名单刚变过"的标记。
   *
   * ★ `hiddenDirty` 是必需的：`sync` 的头一句是"视口没动就早退"，而隐藏名单的变化
   *   与视口无关 —— 少了这个标记，"收起编组"要等到下一次缩放 / 平移才生效
   *   （看起来就像那个开关按了没反应）。
   */
  private readonly hidden = new Set<string>();
  private hiddenDirty = false;

  /** 清空：立刻摘掉全部分栏元素，不等下一帧（换板时不能残留上一块板的栏） */
  clear(): void {
    for (const entry of this.mounted.values()) entry.element.remove();
    this.mounted.clear();
    this.columns = [];
    this.counts = new Map();
    this.contentBottom = new Map();
    this.scrollOffsets = new Map();
    this.dirty = true;
    this.lastViewRect = null;
  }

  /** 每帧入口：按视口裁剪，挂载进场分栏、摘掉离场分栏 */
  sync(viewport: Viewport): void {
    const viewRect = viewport.visibleBounds();
    if (!this.dirty && rectEquals(viewRect, this.lastViewRect) && !this.hiddenDirty) return;

    const forceApply = this.dirty;
    this.reconcile(viewRect, forceApply);
    this.lastViewRect = viewRect;
    this.dirty = false;
    this.hiddenDirty = false;
  }

  /**
   * 哪些栏此刻**不该出现在画布上**（用户 2026-09-16：被收起的编组里的分栏）。
   *
   * ★ 与"视口裁剪"是两件事，但落在同一个出口（`reconcile`）：一个是"看不见的地方，
   *   先不挂"，一个是"这一栏被藏起来了" —— 两者的效果都是"摘掉 DOM 节点"，
   *   而分开做两套摘除逻辑迟早出现"藏起来的又被挂回来"。
   */
  setHidden(ids: ReadonlySet<string>): void {
    if (this.hidden.size === ids.size) {
      let same = true;
      for (const id of ids) {
        if (!this.hidden.has(id)) {
          same = false;
          break;
        }
      }
      if (same) return;
    }
    this.hidden.clear();
    for (const id of ids) this.hidden.add(id);
    this.hiddenDirty = true;
  }

  /**
   * 选中外观（T1.31 的分栏版）。
   * ★ 只改 class，不改 `z-index`：选中不该顺手把分栏提到最前 —— 层序是数据。
   */
  setSelection(ids: ReadonlySet<string>): void {
    this.selected = ids;
    for (const [id, entry] of this.mounted) {
      entry.element.classList.toggle('is-selected', ids.has(id));
    }
  }

  /**
   * 只读外观（T4.06 / `03 §2.5`：归档锁定）。
   *
   * ★ 这里是 `COLUMN_STATE_CLASSES` 里 `is-readonly` 的**落地点** ——
   *   那个类名和 `styles.css` 里"不给能拖的暗示"一直是写好的，
   *   只是从来没有人生产过它：**声明了状态却没有生产者，等于一条永远不生效的规则**。
   * ★ 只改 class，不动任何几何：锁定的板子照样要能看、能读、能导出。
   */
  setReadOnly(value: boolean): void {
    if (value === this.readOnly) return;
    this.readOnly = value;
    for (const entry of this.mounted.values()) {
      entry.element.classList.toggle('is-readonly', value);
    }
  }

  /**
   * 回灌滚动偏移（T2.03）：重挂载 / 撤销 / 换板之后，栏要停在用户刚才看的那一段。
   *
   * ★ 视图是偏移的唯一真相。本层不自己记：滚动位置若出现两份，
   *   "撤销后回到哪一段"就会变成一件说不清的事。
   */
  setScrollOffsets(offsets: ReadonlyMap<string, number>): void {
    this.scrollOffsets = offsets;
    for (const entry of this.mounted.values()) this.applyScrollTop(entry);
  }

  /**
   * 内容槽元素（滚动容器）。
   *
   * ★ 它是 `world` 坐标里"属于某一栏"的唯一滚动宿主，而成员卡是它的**兄弟节点**
   *   （不在它里面），所以"指针底下这一栏能滚吗"只能由外部按几何算出来，
   *   再回来问本层要这个元素。视图的滚轮拦截就靠它。
   */
  scrollBodyOf(columnId: string): HTMLElement | null {
    return this.mounted.get(columnId)?.bodyEl ?? null;
  }

  /**
   * 拖动预览（F2-7-4 / F2-7-5）：只写 DOM，一个字节都不落盘。
   * 松手后视图会从模型重画一遍，所以这里写坏了大不了重画，不存在数据风险。
   */
  previewRects(rects: readonly (Rect & { id: string })[]): void {
    for (const rect of rects) {
      const entry = this.mounted.get(rect.id);
      if (!entry) continue;
      const style = entry.element.style;
      style.left = `${rect.x}px`;
      style.top = `${rect.y}px`;
      style.width = `${rect.width}px`;
      style.height = `${rect.height}px`;
    }
  }

  /** 就地改标题（右键菜单"重命名分栏"也走这里，和双击是同一个入口） */
  editTitle(columnId: string): void {
    const entry = this.mounted.get(columnId);
    if (!entry) return;
    startInlineRename(entry.titleEl, entry.column.title, (value) => {
      this.options.onTitleCommit(columnId, value);
    });
  }

  dispose(): void {
    this.clear();
  }

  // ── 核心：裁剪 → 增删 ────────────────────────────────────

  private reconcile(viewRect: Rect, forceApply: boolean): void {
    // ★ 被收起的编组罩着的栏**不画**（用户 2026-09-16）：与视口裁剪走同一个出口 ——
    //   两者干的是同一件事（摘掉 DOM 节点），分两套迟早出现"藏起来的又被挂回来"
    const visible = this.columns.filter(
      (column) => !this.hidden.has(column.id) && rectsIntersect(columnRect(column), viewRect),
    );
    const visibleIds = new Set(visible.map((column) => column.id));

    for (const [id, entry] of this.mounted) {
      if (!visibleIds.has(id)) {
        entry.element.remove();
        this.mounted.delete(id);
      }
    }

    for (const column of visible) {
      const existing = this.mounted.get(column.id);
      if (existing) {
        // ★ 数据是**原地改**的：`column` 引用可能没变但字段变了，
        //   所以"是否重绘"不能靠引用比较，只能靠 `forceApply`（dirty）
        if (forceApply) this.applyColumn(existing);
        continue;
      }
      this.mount(column);
    }
  }

  private mount(column: Column): void {
    const element = document.createElement('div');
    element.className = 'nestboard-column';
    element.setAttribute(COLUMN_ID_ATTR, column.id);

    // 标题栏**同时是拖动把手**（F2-7-4）：整栏移动的抓握区就是这条 40px 高的横条。
    // 单独做一个"拖动手柄"小图标会让用户得瞄准才能拖动一个 320px 宽的东西
    const header = document.createElement('div');
    header.className = 'nestboard-column-header';
    element.appendChild(header);

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'nestboard-column-toggle';
    toggle.setAttribute('data-column-action', 'toggle');
    header.appendChild(toggle);

    const titleEl = document.createElement('span');
    titleEl.className = 'nestboard-column-title';
    header.appendChild(titleEl);

    const countEl = document.createElement('span');
    countEl.className = 'nestboard-column-count';
    header.appendChild(countEl);

    // 内容槽（T2.03 / F2-7-10）：栏高封顶之后，装不下的成员靠它自己滚。
    // ★ 槽里**没有卡片**：成员卡和分栏是兄弟节点（同一套 world 坐标 + 同一套 z），
    //   所以滚动高度只能由一个占位块撑出来 —— 真想用卡片撑，就得把卡片塞进栏里，
    //   那会连带毁掉"卡片能拖出栏外、能压在别的栏上"这套（T1.55 起就是这么设计的）。
    const body = document.createElement('div');
    body.className = 'nestboard-column-body';
    const spacer = document.createElement('div');
    spacer.className = 'nestboard-column-spacer';
    body.appendChild(spacer);
    element.appendChild(body);

    // 8 个尺寸手柄，常驻 DOM（与卡片同理：命中测试要摸得到它们）
    for (const handle of RESIZE_HANDLES) {
      const node = document.createElement('div');
      node.className = `nestboard-handle nestboard-handle-${handle}`;
      node.setAttribute(RESIZE_HANDLE_ATTR, handle);
      element.appendChild(node);
    }

    /*
     * ★ 滚轮**不在这里**监听：成员卡与内容槽是兄弟节点，"滚轮落在卡上"根本到不了这个槽，
     *   而是直接冒泡到画布。所以拦截点必须是"卡与栏的共同祖先"（画布），
     *   由视图按几何算出指针底下是哪一栏，再回来问本层要 `scrollBodyOf()`。
     *   挂在槽上的话，用户会发现"只有滚在栏里的空隙上才滚得动"。
     */
    body.addEventListener('scroll', () => {
      // 浏览器在内容变矮时会自己钳 `scrollTop` —— 这个过程必须报上去，
      // 否则视图里还留着旧偏移，卡片会被"钳后的 DOM"与"没钳的模型"撕开
      this.options.onScroll?.(column.id, body.scrollTop);
    });
    body.addEventListener('wheel', (event) => {
      // 兜底：指针正好落在内容槽自己身上（栏里的空隙、占位块）时，
      // 也要挡住画布的平移/缩放 —— 判断"能不能滚"的活儿在视图那边做，
      // 这里只要"栏里有一条能滚的槽"就不该把滚轮让给画布
      if (event.ctrlKey || event.metaKey) return;
      if (body.scrollHeight > body.clientHeight + 1) event.stopPropagation();
    });

    element.addEventListener('pointerdown', (event) => this.onPointerDown(column.id, event));
    element.addEventListener('contextmenu', (event) =>
      this.options.onContextMenu(column.id, event),
    );
    element.addEventListener('dblclick', (event) => {
      // 双击标题栏 = 改名；双击别处不做事（分栏没有"进入编辑态"这回事）
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (!target.closest('.nestboard-column-title')) return;
      event.stopPropagation();
      this.editTitle(column.id);
    });

    this.host.appendChild(element);
    const entry: MountedColumn = {
      element,
      column,
      titleEl,
      countEl,
      toggleEl: toggle,
      bodyEl: body,
      spacerEl: spacer,
    };
    this.mounted.set(column.id, entry);
    this.applyColumn(entry);
  }

  private applyColumn(entry: MountedColumn): void {
    const { element, column } = entry;
    const collapsed = column.collapsed;

    element.classList.toggle('is-collapsed', collapsed);
    element.classList.toggle('is-selected', this.selected.has(column.id));
    element.classList.toggle('is-readonly', this.readOnly);
    element.setAttribute(COLUMN_ID_ATTR, column.id);

    const style = element.style;
    style.left = `${column.x}px`;
    style.top = `${column.y}px`;
    style.width = `${column.width}px`;
    // ★ 折叠时写的是**显示高度**（标题栏那么高），模型里的 `height` 原样不动
    style.height = `${columnDisplayHeight(column)}px`;
    style.zIndex = String(column.z);

    // 分栏主色（用户 2026-09-18："分栏要允许设置颜色"）：写在 CSS 变量上，
    // 标题栏背景 / 字色都跟它走（与卡片 `--nestboard-card-color` 同一个套路）。
    // 字色按底色对比度算（深色底用白字、浅色底用黑字），任意主题色 / 自定义 HEX 都读得清
    style.setProperty('--nestboard-column-color', cardColorValue(column.color));
    const ink = resolveColumnInk(element, column.color);
    if (ink) style.setProperty('--nestboard-column-ink', ink);
    else style.removeProperty('--nestboard-column-ink');

    this.applyScroll(entry);
    this.applyTitle(entry);
    entry.countEl.textContent = t('column.count', { count: this.counts.get(column.id) ?? 0 });

    entry.toggleEl.textContent = collapsed ? '▸' : '▾';
    entry.toggleEl.setAttribute('aria-label', t(collapsed ? 'column.expand' : 'column.collapse'));
    entry.toggleEl.setAttribute('aria-expanded', String(!collapsed));
  }

  /**
   * 内容槽的滚动几何（T2.03 / `F2-7-10`）。
   *
   * ★ 占位块高度 = `内容底边 − 窗口上沿`：
   *   减掉槽自身的可见高度之后，**恰好**等于模型算出的 `columnScrollLimit`。
   *   多给一个像素会在栏底留下一段永远滚不到的空白（用户会反复回滚找底），
   *   少给一个像素则最后一张卡永远差一点看不全 —— 两个方向都像 bug。
   */
  private applyScroll(entry: MountedColumn): void {
    const { column } = entry;
    const viewport = columnViewport(column);
    const bottom = this.contentBottom.get(column.id) ?? viewport.top;
    const extent = Math.max(0, roundTo(bottom - viewport.top));

    /*
     * ★ 补偿"CSS 里的槽高"与"模型窗口高"的差（T2.03）：
     *   模型没把栏的边框算进去（`viewport.height = 栏高 − padding − 头高 − 头间距`），
     *   而内容槽是栏的 flex 子项，实打实地被上下边框各挤掉一部分，所以它比 `viewport`
     *   高出来十几像素。滚动行程是 `scrollHeight − clientHeight`，不补这个差值的话，
     *   行程会**小于** `columnScrollLimit` —— 表现就是"滚到底了最后一张卡还差一截"，
     *   而肉眼看只会觉得是分栏高度不对，很难想到是这里差了几像素。
     * ★ 用实测的 `clientHeight` 而不是从 CSS 常量反推：栏一旦换主题、换边框宽度，
     *   反推的常数就悄悄错了，而实测永远是对的（且槽高由 flex 决定，与内容无关）。
     */
    const slack = entry.bodyEl.clientHeight - viewport.height;
    const height = slack > 0.5 ? roundTo(extent + slack) : extent;
    entry.spacerEl.style.height = `${height}px`;

    // 差 1px 以内不算能滚：亚像素舍入会在这里制造一堆"能滚 0.4px"的栏，
    // 于是它们都拿到了滚动条与"滚轮归我"的身份，实际却一动不动
    const scrollable = viewport.height > 0 && extent > viewport.height + 1;
    entry.bodyEl.classList.toggle('is-scrollable', scrollable);
    this.applyScrollTop(entry);
  }

  /**
   * 把偏移写回 DOM。
   *
   * ★ 只在**真的不同**时写：给 `scrollTop` 赋同一个值也会派发 `scroll` 事件，
   *   于是"每隔一帧重绘一次"就会变成"每隔一帧通知视图一次"，
   *   白白让卡片层与连线重画一遍（还容易顺手写出一个死循环）。
   */
  private applyScrollTop(entry: MountedColumn): void {
    const scrollable = entry.bodyEl.classList.contains('is-scrollable');
    const next = scrollable ? Math.max(0, this.scrollOffsets.get(entry.column.id) ?? 0) : 0;
    if (Math.abs(entry.bodyEl.scrollTop - next) < 0.5) return;
    entry.bodyEl.scrollTop = next;
  }

  private applyTitle(entry: MountedColumn): void {
    const { titleEl, column } = entry;
    const title = column.title.trim();
    titleEl.textContent = title || t('column.title.placeholder');
    if (title) titleEl.removeAttribute('data-placeholder');
    else titleEl.setAttribute('data-placeholder', 'true');
    titleEl.setAttribute('title', title || t('column.title.placeholder'));
  }

  /**
   * 分栏上的 pointerdown。
   *
   * 目标按优先级分流，**每一路都要 `stopPropagation`**：
   * 事件会冒泡到 canvas，而画布上的框选控制器把"按在非卡片元素上"理解成
   * "按在空白处" —— 不拦就会一边拖动分栏一边拉出一个选框。
   */
  private onPointerDown(columnId: string, event: PointerEvent): void {
    if (event.button !== 0) return;
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;

    if (target.closest('[data-column-action="toggle"]')) {
      event.preventDefault();
      event.stopPropagation();
      this.options.onToggleCollapse(columnId);
      return;
    }

    // ★ 栏在滚的时候，按在内容区上是"滚"，不是"拖栏"：
    //   这里刻意**不** `preventDefault()`（那会掐掉触控的原生滑动），
    //   只 `stopPropagation` 把事件从画布手里拦下来。
    //   想拖动这种栏请抓标题栏 —— F2-7-4 本来就是"标题栏 = 把手"的设计。
    const body = target.closest<HTMLElement>('.nestboard-column-body');
    if (body?.classList.contains('is-scrollable')) {
      event.stopPropagation();
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const handle = resolveHandle(target);
    this.options.onPointerDown(
      columnId,
      handle ? { kind: 'resize', handle } : { kind: 'move' },
      event,
    );
  }
}

/** 分栏的世界矩形（折叠态用显示高度，命中测试才和看到的一致） */
export function columnRect(column: Column): Rect {
  return {
    x: column.x,
    y: column.y,
    width: column.width,
    height: columnDisplayHeight(column),
  };
}

/** 从事件目标向上找尺寸手柄（与 `BoardView.resolveResizeHandle` 同一套属性名） */
function resolveHandle(target: HTMLElement): ResizeHandle | null {
  const element = target.closest<HTMLElement>(`[${RESIZE_HANDLE_ATTR}]`);
  const value = element?.getAttribute(RESIZE_HANDLE_ATTR);
  if (!value) return null;
  return (RESIZE_HANDLES as readonly string[]).includes(value) ? (value as ResizeHandle) : null;
}

/**
 * 就地把一个元素变成输入框（双击标题栏改名）。
 *
 * ★ 提交完必须把原文本写回元素：这个 `<span>` 是常驻节点，留着 `contenteditable`
 *   会让它下次渲染时还是可编辑的，用户莫名其妙就能改标题。
 */
function startInlineRename(host: HTMLElement, value: string, commit: (next: string) => void): void {
  if (host.dataset.editing === 'true') return;
  host.dataset.editing = 'true';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'nestboard-column-title-input';
  input.value = value;
  input.placeholder = t('column.title.placeholder');

  const previous = host.textContent ?? '';
  host.textContent = '';
  host.appendChild(input);

  let done = false;
  const finish = (submit: boolean): void => {
    if (done) return;
    done = true;
    const next = submit ? input.value.trim() : value;
    // 先还原成文本节点，再外部提交 —— 否则提交引发的重绘会把 input 一起抹掉，
    // 用户会看到标题闪一下空白
    host.textContent = previous;
    delete host.dataset.editing;
    if (submit) commit(next);
  };

  input.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'Enter') {
      event.preventDefault();
      finish(true);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      finish(false);
    }
  });
  input.addEventListener('blur', () => finish(true));

  input.focus();
  input.select();
}

function rectEquals(a: Rect, b: Rect | null): boolean {
  if (!b) return false;
  return (
    roundTo(a.x) === roundTo(b.x) &&
    roundTo(a.y) === roundTo(b.y) &&
    roundTo(a.width) === roundTo(b.width) &&
    roundTo(a.height) === roundTo(b.height)
  );
}

// `CLASSES` 仅用于文档化"本层会往元素上加哪些状态 class"（测试按它断言不会漏摘）
export const COLUMN_STATE_CLASSES = CLASSES;
