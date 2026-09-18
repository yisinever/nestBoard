/**
 * 编组渲染层（O03）—— 组的**包围框** + 一条**标签条**（收起 / 展开 / 改名）。
 *
 * 与 `ColumnLayer` 同源（两边表现的同类东西，用户第一眼就会拿来比）：
 *  * **常驻 DOM，不做复用池**：分组的数量与卡片不是一个量级（几十 vs 几千），
 *    池化省下的那点内存换不回状态重置的风险。
 *  * **只写 `left / top / width / height` 这几个数字**：几何全部由 {@link groupFrameOf}
 *    从成员矩形算出来，本层一个像素都不自己推（自己推就会出现"框和卡片差半个像素"
 *    这种查半天的观感缺陷）。
 *  * **拖动中不改模型**：`sync()` 每帧重算即可，落盘由视图在手势结束时提交一次。
 *
 * ★ 元素挂在**和卡片同一个宿主**（`world`）下，且**早于**卡片层挂载：平 z 时卡片赢，
 *   与分栏那条"卡片必须能从容器上浮出来"的约定一致。
 * ★ 框与标签条都是 `pointer-events: none`，只有标签条**自己**可交互 —— 框罩住的是
 *   成员卡片，拦了指针就等于"编组之后这些卡点不动了"。
 * ★ 收起时框整条消失，只留标签条，且标签条**一动不动**（两种状态下它的偏移一样，
 *   只有外壳矩形在变，见 {@link GroupLayer.applyGroup}）—— 收起是个"缩小"的动作，
 *   标签条若也跟着跳一下，看起来就像点错了。
 *
 * ★ 不做视口裁剪：分组的数量与卡片不是一个量级，几十个 `div` 的常驻成本远小于
 *   裁剪判据本身要付出的复杂度 —— 收起态的标签条宽度是**自适应**的（随名字长短），
 *   没有实测宽度就算不出准确的裁剪矩形，猜一个常数只会在"放大到只看得到名字中间几个字"
 *   时把标签条裁掉（一个只在极端缩放下出现、却很难复现的 bug）。
 */

import type { Group } from '../../model/schema';
import { boundsOf, roundTo, type Rect } from '../../util/geometry';
import { t } from '../../util/i18n';
import { GROUP_ACTION_ATTR, GROUP_ID_ATTR } from '../../constants';

/** 外框与成员包围盒之间的留白（世界单位，随缩放一起缩放） */
export const GROUP_FRAME_PADDING = 16;
/** 标签条高度（世界单位） */
export const GROUP_CHIP_HEIGHT = 22;
/** 外框顶部为标签条留出的带宽 = 标签条高 + 上下呼吸 */
export const GROUP_CHIP_BAND = GROUP_CHIP_HEIGHT + 10;

export interface GroupLayerOptions {
  /**
   * 按在标签条上（不是那个收起开关）：视图据此**选中整组并开始拖动**。
   *
   * ★ 本层已经 `stopPropagation`：事件会冒泡到画布，而画布把"按在非卡片元素上"
   *   理解成"按在空白处" —— 不拦就会一边拖分组一边拉出一个选框。
   */
  onPointerDown: (groupId: string, event: PointerEvent) => void;
  /** 点收起 / 展开开关 */
  onToggleCollapse: (groupId: string) => void;
  /** 改名提交（双击标签条）。原样提交由模型层挡下，不产生历史记录 */
  onLabelCommit: (groupId: string, label: string) => void;
}

interface MountedGroup {
  element: HTMLElement;
  frameEl: HTMLElement;
  chipEl: HTMLElement;
  labelEl: HTMLElement;
  countEl: HTMLElement;
  toggleEl: HTMLElement;
  /** 上次写进 DOM 的几何（写 DOM 前先比一次，见 `applyRect`） */
  applied: Rect | null;
  /** 上次写进 DOM 的收起态（undefined = 还没写过） */
  appliedCollapsed?: boolean;
  /** 上次写进 DOM 的名字（就地改名期间靠它避免把输入框冲掉） */
  appliedLabel?: string;
  /** 上次写进 DOM 的成员数（卡片 / 分栏分开记：两类都要驱动重画） */
  appliedCount?: number;
  appliedColumnCount?: number;
}

/**
 * 一个组的**外框矩形**：成员包围盒 + 留白 + 顶部标签带宽（O03）。
 *
 * ★ 标签条之所以框在**顶部带**里而不是浮在框外面：浮在外面的话，
 *   视口上沿一旦切过框顶，标签条就整条滚出屏幕 —— 用户会以为"分组不见了"，
 *   而那时框的一部分明明还在屏幕上。框住它，"看得见框就看得见开关"永远成立。
 * ★ 成员一个都取不到（全被删了 / 数据坏）时返回 `null`：调用方据此跳过这个组，
 *   而不是画一个零尺寸的框在原点 —— 那会在 (0,0) 处堆出一个点不掉的标记。
 * ★ 收起态**仍然返回展开时的框**：标签条要停在"框的左上角"那个位置才不跳，
 *   而"要不要画框"是渲染的事（见 `GroupLayer.applyGroup`）。
 */
export function groupFrameOf(group: Group, rectOf: (memberId: string) => Rect | null): Rect | null {
  const rects: Rect[] = [];
  // ★ 两类成员走**同一个**解析函数（用户 2026-09-16：分栏也能被编进组）——
  //   由视图按 id 分辨"这是一张卡还是一栏"，本层不认识分栏（它只认矩形）。
  for (const id of [...group.cardIds, ...(group.columnIds ?? [])]) {
    const rect = rectOf(id);
    if (rect) rects.push(rect);
  }
  const bounds = boundsOf(rects);
  if (!bounds) return null;
  return {
    x: roundTo(bounds.x - GROUP_FRAME_PADDING),
    y: roundTo(bounds.y - GROUP_FRAME_PADDING - GROUP_CHIP_BAND),
    width: roundTo(bounds.width + GROUP_FRAME_PADDING * 2),
    height: roundTo(bounds.height + GROUP_FRAME_PADDING * 2 + GROUP_CHIP_BAND),
  };
}

export class GroupLayer {
  private readonly mounted = new Map<string, MountedGroup>();

  constructor(
    private readonly host: HTMLElement,
    private readonly options: GroupLayerOptions,
  ) {}

  /** 已挂载的分组数量（诊断 / 测试用） */
  get renderedCount(): number {
    return this.mounted.size;
  }

  /**
   * 每帧重算并同步（挂在 `syncCanvas` 这条必经路径上）。
   *
   * ★ 幂等且**先比后写**：静止时每个组只做几次数值比较，一个属性都不写
   *   （与 `Toolbar.sync` / `Minimap.syncCamera` 同一条纪律）。
   * ★ 必须每帧跑，而不是"只在模型变了时跑"：拖动一张成员卡时模型的 `x/y` 一动不动
   *   （预览只写 DOM），框要跟着走就只能从**视觉矩形**重算 —— 而这个换算只有这里做得了。
   */
  sync(groups: readonly Group[], rectOf: (cardId: string) => Rect | null): void {
    const seen = new Set<string>();
    for (const group of groups) {
      const frame = groupFrameOf(group, rectOf);
      if (!frame) continue;
      seen.add(group.id);
      const entry = this.mounted.get(group.id) ?? this.mount(group);
      this.applyGroup(entry, group, frame);
    }
    // 组没了（解散 / 撤销 / 换板）→ 摘掉节点。成员全丢的组走的是上面那条 `continue`，
    // 也会落到这里被回收
    for (const [id, entry] of this.mounted) {
      if (seen.has(id)) continue;
      entry.element.remove();
      this.mounted.delete(id);
    }
  }

  /** 就地把标签条变成输入框（双击 = 改名，与分栏标题同一个入口） */
  editLabel(groupId: string): void {
    const entry = this.mounted.get(groupId);
    if (!entry) return;
    startInlineRename(entry.labelEl, (value) => this.options.onLabelCommit(groupId, value));
  }

  /** 解散 / 换板：全部摘掉 */
  clear(): void {
    for (const entry of this.mounted.values()) entry.element.remove();
    this.mounted.clear();
  }

  dispose(): void {
    this.clear();
  }

  // ── 内部 ─────────────────────────────────────────────────

  private mount(group: Group): MountedGroup {
    const element = document.createElement('div');
    element.className = 'nestboard-group';
    element.setAttribute(GROUP_ID_ATTR, group.id);

    // 外框：纯视觉，永远不拦指针（它罩着的是成员卡片）
    const frameEl = document.createElement('div');
    frameEl.className = 'nestboard-group-frame';
    element.appendChild(frameEl);

    const chipEl = document.createElement('div');
    chipEl.className = 'nestboard-group-chip';
    element.appendChild(chipEl);

    const toggleEl = document.createElement('button');
    toggleEl.type = 'button';
    toggleEl.className = 'nestboard-group-toggle';
    toggleEl.setAttribute(GROUP_ACTION_ATTR, 'toggle');
    chipEl.appendChild(toggleEl);

    const labelEl = document.createElement('span');
    labelEl.className = 'nestboard-group-label';
    chipEl.appendChild(labelEl);

    const countEl = document.createElement('span');
    countEl.className = 'nestboard-group-count';
    chipEl.appendChild(countEl);

    chipEl.addEventListener('pointerdown', (event) => this.onPointerDown(group.id, event));
    chipEl.addEventListener('dblclick', (event) => {
      // 双击开关不落到改名上：那两下是"收起又展开"，不是"想改名字"
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (target.closest(`[${GROUP_ACTION_ATTR}]`)) return;
      event.stopPropagation();
      event.preventDefault();
      this.editLabel(group.id);
    });

    this.host.appendChild(element);
    const entry: MountedGroup = {
      element,
      frameEl,
      chipEl,
      labelEl,
      countEl,
      toggleEl,
      applied: null,
    };
    this.mounted.set(group.id, entry);
    return entry;
  }

  /** 写一个组的全部可变量（几何、收起态、文字） */
  private applyGroup(entry: MountedGroup, group: Group, frame: Rect): void {
    const collapsed = group.collapsed === true;

    if (entry.appliedCollapsed !== collapsed) {
      entry.element.classList.toggle('is-collapsed', collapsed);
      entry.appliedCollapsed = collapsed;
      // 收起时框整条消失：留着的话就是一个"装着空气的大框"，
      // 而用户点收起要的正是"这块地方先别再占我的视线"
      entry.frameEl.style.display = collapsed ? 'none' : '';
      entry.toggleEl.textContent = collapsed ? '▸' : '▾';
      entry.toggleEl.setAttribute('aria-label', t(collapsed ? 'group.expand' : 'group.collapse'));
      entry.toggleEl.setAttribute('aria-expanded', String(!collapsed));
    }

    // 收起态的**外壳缩到左上角一个点**：标签条是绝对定位的子节点，照常显示；
    // 两种状态下标签条的 CSS 偏移完全一样，所以它一动不动（见文件头第三条）
    this.applyRect(entry, collapsed ? { x: frame.x, y: frame.y, width: 0, height: 0 } : frame);

    // ★ 名字只在**真的变了**时才写，而且还得跳过"正在改名"的那一刻：
    //   `sync` 每帧都跑，而就地改名把输入框塞在这个 `<span>` 里 ——
    //   无脑 `textContent = ...` 会在按下双击后的**下一帧**把输入框冲掉，
    //   表现是"双击之后刚敲一个字就没了"（这一条靠肉眼几乎查不到）
    const label = group.label.trim();
    if (entry.labelEl.dataset.editing !== 'true' && entry.appliedLabel !== label) {
      entry.appliedLabel = label;
      entry.labelEl.textContent = label || t('group.defaultLabel');
      entry.labelEl.setAttribute('title', label || t('group.defaultLabel'));
      if (label) entry.labelEl.removeAttribute('data-placeholder');
      else entry.labelEl.setAttribute('data-placeholder', 'true');
    }

    // ★ 标签上的数字要**两类成员一起算**（用户 2026-09-16）：一个"两栏成组"的组里
    //   `cardIds` 是空的，只按它算会写着"0 张" —— 而屏幕上明明框着两栏东西。
    // ★ 有分栏成员时**换个说法**（"N 张 + M 栏"）：把数字直接加起来会把栏说成"张"，
    //   那比少算更难理解（"3 张"里其实有两栏）。
    const cards = group.cardIds.length;
    const columns = group.columnIds?.length ?? 0;
    if (entry.appliedCount !== cards || entry.appliedColumnCount !== columns) {
      entry.appliedCount = cards;
      entry.appliedColumnCount = columns;
      entry.countEl.textContent =
        columns === 0
          ? t('group.count', { count: cards })
          : t('group.countMixed', { cards, columns });
    }
  }

  /** 只在几何真的变了时才写 DOM（`sync` 每帧都跑，无脑写会让浏览器每帧重排） */
  private applyRect(entry: MountedGroup, rect: Rect): void {
    const last = entry.applied;
    if (
      last &&
      roundTo(last.x) === roundTo(rect.x) &&
      roundTo(last.y) === roundTo(rect.y) &&
      roundTo(last.width) === roundTo(rect.width) &&
      roundTo(last.height) === roundTo(rect.height)
    ) {
      return;
    }
    entry.applied = rect;
    const style = entry.element.style;
    style.left = `${rect.x}px`;
    style.top = `${rect.y}px`;
    style.width = `${rect.width}px`;
    style.height = `${rect.height}px`;
  }

  private onPointerDown(groupId: string, event: PointerEvent): void {
    if (event.button !== 0) return;
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;

    if (target.closest(`[${GROUP_ACTION_ATTR}="toggle"]`)) {
      event.preventDefault();
      event.stopPropagation();
      this.options.onToggleCollapse(groupId);
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    this.options.onPointerDown(groupId, event);
  }
}

/**
 * 就地把标签条变成输入框（双击改名）。
 *
 * 与 `ColumnLayer.startInlineRename` 同一套做法，只有一处不同：**初值是空的** ——
 * 分组的 `label` 绝大多数时候就是空串（显示的是"分组"这个占位文案），
 * 把占位文案塞进输入框会让用户以为"这组就叫分组"，一回车就把占位文案写成了真名字。
 */
function startInlineRename(host: HTMLElement, commit: (next: string) => void): void {
  if (host.dataset.editing === 'true') return;
  host.dataset.editing = 'true';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'nestboard-group-label-input';
  input.value = host.hasAttribute('data-placeholder') ? '' : (host.textContent ?? '');
  input.placeholder = t('group.defaultLabel');

  const previous = host.textContent ?? '';
  host.textContent = '';
  host.appendChild(input);

  let done = false;
  const finish = (submit: boolean): void => {
    if (done) return;
    done = true;
    const next = submit ? input.value.trim() : null;
    // 先还原成文本节点，再外部提交 —— 否则提交引发的重绘会把 input 一起抹掉，
    // 用户会看到标签闪一下空白
    host.textContent = previous;
    delete host.dataset.editing;
    if (next !== null) commit(next);
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
