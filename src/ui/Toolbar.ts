/**
 * 白板工具条（T3.21 / T3.27 / `02 §2` 的"工具栏"）。
 *
 * 位置按平台分叉（`02 §2` / `02 §6`）：
 *  * 桌面：左侧悬浮竖条；
 *  * 移动：底部横向滚动条，**每一格都 ≥44×44px**。
 *   两者共用同一份 DOM，只是 CSS 换个方向 —— 于是"手机上少一个按钮"
 *   这种分叉永远不会发生。
 *
 * ★ 本组件**不认识白板模型**：它只渲染 host 给的一张 `ToolbarItem[]`，
 *   回调也是 host 给的（见 `ToolbarOptions.items`）。这么做有两个好处：
 *   1. "这条工具条上有哪些格"是**一处**可读的清单（在 `BoardView.toolbarItems`），
 *      而不是散在 DOM 构建代码里的十几段 `if`；
 *   2. 拖拽手势、`aria-*`、抖动提示这些**交互细节**只写一遍，
 *      加一格新按钮时不必再复制一遍这些逻辑。
 *
 * ★ 当前版本已按用户要求改为"点击直接创建"：所有格子统一走 click，
 *   不再支持从工具栏拖到画布落点。
 */

import { setIcon } from 'obsidian';

import { t } from '../util/i18n';

/** 工具条上的一格 */
export interface ToolbarItem {
  /** 稳定 id：`sync()` 靠它把"新的状态"贴回"旧的节点" */
  id: string;
  /** Lucide 图标名（`02 §5.1`：图标一律 Lucide）。给了 `text` 时可以省略 */
  icon?: string;
  /** 只读文本（缩放百分比那格）。给了它就不再渲染图标 */
  text?: () => string;
  /** 无障碍名 + 悬停提示 */
  label: string;
  /** 分组：不同组之间画一条分隔线 */
  group: 'mode' | 'create' | 'zoom' | 'view';
  /** 是不是开关（用 `aria-pressed` 表达当前态） */
  toggle?: boolean;
  /** 当前是否处于按下态（`toggle` 用） */
  pressed?: () => boolean;
  /** 当前是否可用 */
  enabled?: () => boolean;
  /** 点击时执行。给了 `drop` 的格子，点击 = 在视口中心落卡 */
  /**
   * 点击时执行。
   *
   * ★ `event`（`C1`）：像"更多卡片"这种**点开一个菜单**的格子需要知道点在哪 ——
   *   菜单要弹在按钮旁边，而不是屏幕某个角上。老格子忽略这个参数即可
   *   （它是可选的，所以那些 `activate: () => …` 一个字都不用改）。
   */
  activate: (event?: MouseEvent) => void;
  /**
   * 拖到画布上松手时调用，**给了它就代表这一格支持拖拽落点**。
   * 直接点击走 `activate`（建卡类按钮 = 在视口中心落卡），不必再拖。
   */
  drop?: (client: { x: number; y: number }) => void;
}

export interface ToolbarOptions {
  /** 当前应该有哪些格子。每次 `render` / `sync` 都会重新问一遍 */
  items: () => readonly ToolbarItem[];
  /** 一个客户端坐标是否落在画布上（决定拖拽松手算不算数） */
  isOverCanvas: (client: { x: number; y: number }) => boolean;
}

/**
 * 一格上"已经贴在 DOM 里"的状态（见 `Toolbar.applied`）。
 *
 * ★ 存的是**算好的值**而不是回调：比对时不该再调一次 `item.text()` /
 *   `item.enabled()`，否则同一帧里问两遍可能得到两个答案
 *   （比如缩放值恰好在两次提问之间变了），比对结果就没意义了。
 */
interface AppliedState {
  label: string;
  enabled: boolean;
  pressed: boolean;
  /** `text` 格子的文本；图标格子为 `null` */
  text: string | null;
}

export class Toolbar {
  private readonly rootEl: HTMLElement;
  /** id → 节点，`sync()` 时按 id 找回来，避免整条重建 */
  private readonly nodes = new Map<string, HTMLButtonElement>();
  /**
   * 上一次真正写进 DOM 的状态（T3.22 / `02 §8.2`）。
   *
   * ★ `sync()` 会被视图在**每次平移 / 缩放帧**里调到（缩放百分比那格每帧都变），
   *   而 `setAttribute` 会触发无障碍树重算 —— 那是 DOM 里最贵的一类写操作。
   *   缓存一份状态、没变就一个属性都不写，`sync()` 于是变成纯字符串比较，
   *   可以放心挂在热路径上，而不必靠调用方记得"只在合适的时候调"。
   */
  private readonly applied = new Map<string, AppliedState>();

  constructor(
    parentEl: HTMLElement,
    private readonly options: ToolbarOptions,
  ) {
    this.rootEl = parentEl.createDiv({ cls: 'nestboard-toolbar' });
    // `role="toolbar"` + `aria-label`：读屏用户靠它把这一串按钮理解成一个整体
    this.rootEl.setAttribute('role', 'toolbar');
    this.rootEl.setAttribute('aria-label', t('toolbar.ariaLabel'));
  }

  /**
   * 是不是移动端布局（底部横向滚动）。由视图层在装配时告诉它。
   *
   * ★ `aria-orientation` 跟着一起改：桌面是竖条、移动是横条，
   *   读屏念错方向比不念更糟（用户会按着错误的方向键去导航）。
   */
  setMobile(isMobile: boolean): void {
    this.rootEl.toggleClass('is-mobile', isMobile);
    this.rootEl.setAttribute('aria-orientation', isMobile ? 'horizontal' : 'vertical');
  }

  /** 重建全部格子。设置变更 / 换板时调用 */
  render(): void {
    this.rootEl.empty();
    this.nodes.clear();
    // ★ 节点是新建的、身上一个属性都没有，所以缓存必须一起清掉 ——
    //   不清的话 `sync()` 会以为"状态没变"而跳过，新按钮就成了没有名字、
    //   没有 `aria-pressed` 的光板子
    this.applied.clear();

    let lastGroup: ToolbarItem['group'] | null = null;
    for (const item of this.options.items()) {
      // 分组之间插一条分隔线。★ 分隔线是 `aria-hidden` 的纯装饰：
      //   读屏用户已经能靠 `aria-label` 区分按钮，多念一句"分隔线"只会打断节奏
      if (lastGroup !== null && lastGroup !== item.group) {
        const separator = this.rootEl.createDiv({ cls: 'nestboard-toolbar-sep' });
        separator.setAttribute('aria-hidden', 'true');
      }
      lastGroup = item.group;

      const button = this.rootEl.createEl('button', { cls: 'nestboard-toolbar-btn' });
      button.type = 'button';
      // ★ `tabindex` 保持浏览器默认（工具栏用 Tab 逐个走一遍是**期望**行为，
      //   不做 roving tabindex —— 十几个按钮用 Tab 走完并不累，
      //   而 roving 会让"Tab 到下一个控件"变成"Tab 到工具栏内部"，
      //   反而把用户困在工具条里出不去）
      button.setAttribute('data-tool', item.id);
      this.nodes.set(item.id, button);

      const labelEl = button.createSpan({ cls: 'nestboard-toolbar-label' });
      this.paintLabel(labelEl, item, item.text?.() ?? null);

      // 所有格子统一走点击：用户明确不需要工具栏拖拽落点
      //
      // ★ 点击时**重新向 host 要一次"当前这一格"**，而不是用这里闭包捕获的 `item`。
      //   宿主第一次构造 item 的时机几乎总是早于"数据就绪"（白板视图就是如此：
      //   `onOpen` 先建画布、`openBoard` 之后才设 `currentPath`），那一刻算出来的
      //   `enabled` 会被闭包永久固化。而 `sync()` 每帧都会重新问一遍 host ——
      //   于是按钮**看起来是亮的**、点下去却什么都不发生（T3.28 的那个 bug）。
      //   按 id 现取一次，这类"亮着但点不动"就从结构上不可能再出现。
      button.addEventListener('click', (event) => {
        const current = this.options.items().find((candidate) => candidate.id === item.id);
        if (!current) return;
        if (current.enabled && !current.enabled()) return;
        // ★ 把事件交下去（`C1`）：需要"弹在按钮旁边"的格子（「更多卡片」）靠它定位；
        //   其余格子忽略这个参数 —— 所以在签名上它是可选的，老写法一个字都不用改
        current.activate(event);
      });
      if (item.drop) button.setAttribute('aria-disabled', 'false');
    }

    this.sync();
  }

  /**
   * 把 host 的当前状态贴到已有节点上。
   *
   * ★ 不重建 DOM，所以状态同步不会打断用户操作。
   * ★ 状态没变就一个属性都不写（见 `applied`）。重复调用完全安全。
   */

  sync(): void {
    for (const item of this.options.items()) {
      const button = this.nodes.get(item.id);
      if (!button) continue;

      const enabled = item.enabled ? item.enabled() : true;
      const pressed = item.toggle ? (item.pressed ? item.pressed() : false) : false;
      const text = item.text?.() ?? null;
      const previous = this.applied.get(item.id);

      if (
        previous !== undefined &&
        previous.label === item.label &&
        previous.enabled === enabled &&
        previous.pressed === pressed &&
        previous.text === text
      ) {
        continue;
      }
      this.applied.set(item.id, { label: item.label, enabled, pressed, text });

      button.toggleClass('is-disabled', !enabled);
      // 工具栏已改为纯点击交互；带 drop 的格子同样用 disabled 控制是否可点
      button.disabled = !enabled;

      button.setAttribute('aria-label', item.label);
      button.setAttribute('title', item.label);

      if (item.toggle) {
        button.setAttribute('aria-pressed', pressed ? 'true' : 'false');
        button.toggleClass('is-active', pressed);
      }

      const labelEl = button.querySelector<HTMLElement>('.nestboard-toolbar-label');
      if (labelEl) this.paintLabel(labelEl, item, text);
    }
  }

  dispose(): void {
    this.nodes.clear();
    this.applied.clear();
    this.rootEl.remove();
  }

  /**
   * 图标 / 文本二选一地画进那一格里。
   *
   * `text` 已经算好传进来（`sync` 用它做过"变没变"的比对），这里不再问一次
   * `item.text()` —— 两处各问一次的话，中间万一被别的代码改了状态，
   * 会比对的是一种值、画上去的是另一种。
   */
  private paintLabel(labelEl: HTMLElement, item: ToolbarItem, text: string | null): void {
    if (text !== null) {
      labelEl.setText(text);
      labelEl.addClass('is-text');
      return;
    }
    labelEl.removeClass('is-text');
    labelEl.empty();
    if (item.icon) setIcon(labelEl, item.icon);
  }
}
