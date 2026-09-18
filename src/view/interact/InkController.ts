/**
 * 手绘控制器（T3.06 / T3.07 / `F4-01`–`F4-03`、`F4-06`、`F4-07`）：
 * 把指针动作翻译成"落笔 / 追点 / 抬笔 / 擦除"。
 *
 * 四个职责都是别的层干不了的：
 *
 *  1. **代收指针**：手绘层自己不拦指针（笔迹要画在卡片**上方**，事件却被卡片先吃掉）。
 *     控制器挂在画布**容器**上，用**捕获阶段**抢先处理 —— 手绘态下按在画布上，
 *     无论是空白处、卡片上还是图片上，一律是"落笔"，卡片不会被你画线的同时拖走。
 *  2. **守住一次一笔**：只认第一个按下的指针，多指、多键一律吞掉。
 *  3. **掌着这支笔**（T3.07）：颜色、笔宽档位、前后色交换都存这里，落笔时推给手绘层。
 *     放在控制器而不是视图层，是因为它们**是笔的一部分**：换色后画出的下一笔必须已经
 *     带上新颜色 —— 中间多隔一层通知，就会出现"换完色第一笔画出来的还是旧色"。
 *  4. **决定这一笔去哪**（T7.07）：画笔与荧光笔交给视图落盘，临时标注则只留在图层里。
 *     这个"去向"由 `currentTool` 一处决定（见 `InkTool` 的说明），
 *     换笔时就地推给图层（`setTransient`）—— 于是**不存在**"笔换了但落点没换"的中间态。
 *
 * ★ 临时标注层的**生命周期**挂在"手绘态"上：`enter` 时按笔型切换去向，
 *   `teardownMode` 里整体清空。于是票里那句「`Esc` 一键清空」不需要单独一条代码路径 ——
 *   `Esc` 本来就是"退出 INK"（状态机的事），而"退出 INK"本来就该把临时层收干净。
 *   顺带还保证了一条更重要的：**下次进手绘时屏幕上一定是干净的**。
 *
 * ★ 为什么必须在 `NavigationController` **之前**创建（看看 BoardView 的装配顺序）：
 *   触屏拖动在 `NavigationController` 里就等于平移。当指针事件的**目标就是容器**时
 *   （点在空白处 —— 世界容器是 `pointer-events: none`，事件穿过所有 Canvas 层落到容器上），
 *   同一元素上的监听严格按**注册顺序**触发，`capture` 标志在这时并不顶用。
 *   晚注册一步，平板上就是"画一笔，画布跟着手平移"，而且极难归因。
 *
 * ★ 已知取舍：手绘态下不响应双指捏合（第二根手指会被吞掉）。
 *   手势归 `NavigationController` 所有，而它一旦开始平移就不可逆（指针捕获 + 位移已经发生）。
 *   要同时支持"单指画、双指缩放"，得把两套手势合并进同一个识别器 —— 那是移动端专项（v2）。
 *   桌面不受影响：滚轮缩放、中键平移在手绘态照常可用（见 `onPointerDown` 对按键的放行）。
 *
 * ★ 它不直接依赖 `InkLayer`，只依赖 `InkSurface`：本类里全是"谁吞事件、一次一笔、
 *   怎么退出、笔是什么样"这类与 Canvas 无关的规则，因此可以在 node 下用假面单测。
 */

import { OVERLAY_UI_ATTR } from '../../constants';
import {
  INK_ERASER_RADIUS_PX,
  defaultInkToolState,
  inkStrokeStyle,
  swapInkColors,
  withInkColor,
  withInkWidth,
  type InkStyle,
  type InkTool,
  type InkToolState,
} from '../../model/ink';
import type { HexColor } from '../../model/schema';
import type { Point } from '../../util/geometry';
import type { Viewport } from '../../canvas/Viewport';
import type { PointerStateMachine } from './PointerStateMachine';

/** 手绘态：整个画布换成十字光标（`02 §3`「INK：光标变十字」） */
export const INK_MODE_CLASS = 'nestboard-ink-mode';

/**
 * 橡皮态的光标。
 *
 * ★ 拿着橡皮时，这是**唯一**能看出手里是哪支笔的信号：工具条在橡皮态是收起的
 *   （橡皮没有颜色与笔宽可调），而两支笔都是"按着拖"，画出来的东西在抬笔前看不出区别。
 */
export const INK_ERASER_CLASS = 'nestboard-ink-eraser';

/**
 * 荧光笔态的光标（T7.08）。
 *
 * ★ 荧光笔与画笔画出来的东西在抬笔前看得出区别（一个半透明一个不），但**笔尖大小**是
 *   随笔走的：光标跟着换成"粗一圈的十字"（样式在 `styles.css` 里，见那一段的取舍），
 *   落笔前就能看出这一下去会比画笔宽四倍。
 * ★ 不给临时标注（`annotate`）单独的光标类：它"长什么样"与画笔**完全一样**，
 *   区别只在画完之后去哪 —— 那是工具条上「临时」角标该说的事，
 *   让光标去表达"这一笔稍后会消失"只会让人以为它是另一支笔。
 */
export const INK_MARKER_CLASS = 'nestboard-ink-marker';

/** 能 `closest()` 的东西（= 元素）。结构类型，见 `InkController.isOverlayUi` */
interface ClosestCapable {
  closest(selector: string): unknown;
}

function hasClosest(target: EventTarget | null): target is EventTarget & ClosestCapable {
  return typeof (target as Partial<ClosestCapable> | null)?.closest === 'function';
}

/**
 * 控制器对手绘层的全部要求。
 *
 * 抽成接口而不是直接吃 `InkLayer`：本类的规则与 Canvas 无关，这样能用假面单测
 * （真 `InkLayer` 需要 2D 上下文，只能放进 Obsidian 里肉眼验证）。
 */
export interface InkSurface {
  /** `pressure` 只有数位笔才有（鼠标传 `undefined`，见 `pressureOf`） */
  beginStroke(point: Point, pressure?: number): void;
  extendStroke(point: Point, pressure?: number): void;
  endStroke(): void;
  /** 擦掉经过该点的笔画，返回擦掉几笔 */
  eraseAt(point: Point, radius: number): number;
  /** 换画笔样式（颜色 / 基准线宽 / 不透明度）。只影响之后画的笔画 */
  setStyle(style: InkStyle): void;
  /**
   * 切换"之后落下的笔去哪"（T7.07）：`true` = 只留在图层里（临时标注），`false` = 交出去落盘。
   * 只切开关，**不动**已有内容（清空是 `clearTransient` 的事）。
   */
  setTransient(enabled: boolean): void;
  /** 清空临时标注层，返回清掉了几笔 */
  clearTransient(): number;
  /** 临时标注层里有几笔（"清空按钮该不该可点"问这里） */
  transientCount(): number;
}

export interface InkControllerOptions {
  /** 手势表面（画布容器），与 `NavigationController` 共用同一个 */
  host: HTMLElement;
  viewport: Viewport;
  stateMachine: PointerStateMachine;
  /**
   * 手绘面（延迟解析）。
   *
   * ★ 用回调而不是直接传图层：图层必须挂在**卡片层之后**（z-index 层级决定了 DOM 顺序），
   *   而本控制器必须**最早**注册监听。两个时机对不上，只好在这里解开耦合。
   */
  surface: () => InkSurface | null;
  /** 已经在平移时不要落笔（兜底：万一监听顺序被人改动） */
  isPanning?: () => boolean;
  isReadOnly: () => boolean;
  /** 切换/进入工具后回调，供调用方提示"现在拿的是哪支笔"并显示工具条 */
  onEnter?: (tool: InkTool) => void;
  /**
   * 离开手绘态（`Esc` / `V` / `dispose`）后回调。
   *
   * ★ 退出**不一定**经过 `exit()`：`Esc` 是状态机自己处理的，本控制器是"跟着走"的那一方。
   *   所以工具条的收摊不能只挂在 `exit()` 上，否则按 `Esc` 之后工具条会永远留在屏幕上。
   */
  onExit?: () => void;
}

export class InkController {
  private readonly host: HTMLElement;
  private readonly viewport: Viewport;
  private readonly stateMachine: PointerStateMachine;
  private readonly surface: () => InkSurface | null;
  private readonly isPanning: () => boolean;
  private readonly isReadOnly: () => boolean;
  private readonly onEnter: ((tool: InkTool) => void) | undefined;
  private readonly onExit: (() => void) | undefined;

  private currentTool: InkTool = 'brush';
  /**
   * 笔的样式状态（颜色 + 前后色 + 笔宽档位）。
   *
   * ★ 跨"进入 / 退出手绘"保留（不在 `teardownMode` 里重置）：用户退出手绘是因为
   *   要去改卡片，回来接着画时笔还是刚才那支 —— 每次进来都跳回红笔才是真的烦人。
   *   只有 `dispose`（换板 / 关视图）才会连同控制器一起丢掉。
   */
  private state: InkToolState = defaultInkToolState();
  /** 正在画的那个指针；`null` = 此刻画布上没有笔尖 */
  private pointerId: number | null = null;
  /** 这一下是擦还是画 */
  private erasing = false;

  private readonly bound: Array<{ type: string; listener: EventListener }> = [];
  private readonly unsubscribes: Array<() => void> = [];

  constructor(options: InkControllerOptions) {
    this.host = options.host;
    this.viewport = options.viewport;
    this.stateMachine = options.stateMachine;
    this.surface = options.surface;
    this.isPanning = options.isPanning ?? (() => false);
    this.isReadOnly = options.isReadOnly;
    this.onEnter = options.onEnter;
    this.onExit = options.onExit;

    // ★ 捕获阶段：见文件头（必须抢在卡片委托、框选、平移之前）
    this.listen('pointerdown', (event) => this.onPointerDown(event as PointerEvent));
    this.listen('pointermove', (event) => this.onPointerMove(event as PointerEvent));
    this.listen('pointerup', (event) => this.onPointerUp(event as PointerEvent));
    this.listen('pointercancel', (event) => this.onPointerUp(event as PointerEvent));

    // Esc（以及将来的任何方式）把状态机带离 INK 时，光标与进行中的笔画都要收干净。
    // 不在这里抢 Esc：退出后的落点由状态机决定（`02 §4.1`），本控制器只跟着走。
    this.unsubscribes.push(
      this.stateMachine.onChange(({ from, to }) => {
        if (from === 'INK' && to !== 'INK') this.teardownMode();
      }),
    );
  }

  /** 手里拿的是哪支笔（仅在手绘态下有实际意义） */
  get tool(): InkTool {
    return this.currentTool;
  }

  /** 是不是正在手绘态 */
  get isActive(): boolean {
    return this.stateMachine.is('INK');
  }

  /** 笔尖是不是正按在画布上（供调用方判断，如"绘制中不弹右键菜单"） */
  get isDrawing(): boolean {
    return this.pointerId !== null;
  }

  /** 当前笔的完整状态（颜色 / 前后色 / 档位）。工具条据此高亮 */
  get toolState(): InkToolState {
    return this.state;
  }

  /** 当前笔的落笔样式（颜色 + 基准线宽 + 不透明度）。**随手上这支笔变**（T7.08） */
  get style(): InkStyle {
    return inkStrokeStyle(this.state, this.currentTool);
  }

  /** 临时标注层里有几笔（工具条的「清空」按钮据此决定可不可点） */
  get annotationCount(): number {
    return this.surface()?.transientCount() ?? 0;
  }

  /**
   * 清空临时标注层（`⌘⇧⌫` / 工具条上的「清空」）。返回清掉了几笔。
   *
   * ★ 它**不退出**手绘态：用户想的是"擦干净接着画"，不是"收工"。
   *   `Esc` 那条路才是"清空**并且**收工"—— 那一半挂在 `teardownMode` 上，
   *   两条路合起来正好覆盖票里说的「`Esc` 一键清空」与"清了还想接着画"。
   */
  clearTransient(): number {
    return this.surface()?.clearTransient() ?? 0;
  }

  // ── 笔（T3.07 / `F4-02`）────────────────────────────────

  /**
   * 选一支笔色（调色板 / 取色器）。
   *
   * ★ 只改**之后**画的笔画：已经落在画布上的笔迹各自存着自己的颜色，不会跟着变。
   *   想改旧笔迹的颜色是 T3.08「笔画可编辑」的事，与"换一支笔"是两码事。
   */
  setColor(color: HexColor): void {
    this.setState(withInkColor(this.state, color));
  }

  /** `X`：在当前色与"上一支"之间来回换 */
  swapColors(): void {
    this.setState(swapInkColors(this.state));
  }

  /** `1`–`4`：换笔宽档位 */
  setWidthIndex(index: number): void {
    this.setState(withInkWidth(this.state, index));
  }

  private setState(next: InkToolState): void {
    // 纯函数在"没变化"时返回同一个引用（见 `withInkColor`），于是这里的短路
    // 顺手解决了"反复按同一个档位会重画工具条"
    if (next === this.state) return;
    this.state = next;
    this.applyStyle();
  }

  /** 把当前样式推给手绘层。落笔前推，所以下一笔一定用的是新样式 */
  private applyStyle(): void {
    this.surface()?.setStyle(this.style);
  }

  // ── 进入 / 退出 ─────────────────────────────────────────

  /**
   * 进入手绘态并选择工具（`D` 画笔 / `E` 橡皮）。
   *
   * 返回是否真的进去了：只读白板、图层还没就绪、或者当前状态不允许（例如正在编辑文字）
   * 都会返回 `false`，由调用方决定怎么提示 —— 本控制器不弹通知（文案在视图层）。
   */
  enter(tool: InkTool): boolean {
    if (this.isReadOnly()) return false;
    if (!this.surface()) return false;

    // 已经在手绘态时只是换笔：`request('INK')` 会被状态机按"同态"拒绝，
    // 那不是失败，别把它当错误处理
    if (!this.stateMachine.is('INK') && !this.stateMachine.request('INK')) return false;

    this.currentTool = tool;
    // ★ 先定"去向"再推样式（T7.07）：两者都取决于 `currentTool`，但顺序在这里有实际意义 ——
    //   万一有人在 `setStyle` 里同步画了一笔（现在没有，将来也不该有），那一笔必须已经
    //   落在正确的去向里。规格与实现在这一步不该有歧义。
    this.surface()?.setTransient(tool === 'annotate');
    // 进手绘就把样式推过去：图层可能是刚建出来的（默认样式）或上一次手绘留下的，
    // 两种情况下都得以控制器里的状态为准
    this.applyStyle();
    this.applyCursor();
    this.onEnter?.(tool);
    return true;
  }

  /** 退出手绘态（`V` 选择工具 / `Esc`）。进行中的一笔就地收尾，见 `InkLayer.endStroke` */
  exit(): void {
    if (this.stateMachine.is('INK')) {
      this.stateMachine.escape();
      return;
    }
    // 状态已经不在 INK（被别人退出过）时的兜底：光标与笔画同样要收干净
    this.teardownMode();
  }

  dispose(): void {
    for (const { type, listener } of this.bound) {
      this.host.removeEventListener(type, listener, { capture: true });
    }
    this.bound.length = 0;
    for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe();
    if (this.pointerId !== null) {
      this.surface()?.endStroke();
      this.releaseCapture(this.pointerId);
    }
    this.pointerId = null;
    this.removeCursor();
    this.onExit?.();
  }

  // ── 指针 ────────────────────────────────────────────────

  private onPointerDown(event: PointerEvent): void {
    if (!this.stateMachine.is('INK')) return;
    // 只认主键：中键留给平移、右键留给菜单 —— 手绘态下这两件事都还有用
    // （尤其是平移：画到画布边缘想挪一下，不必先退出手绘）
    if (event.button !== 0) return;

    // ★ 画布**内部**的界面控件（手绘工具条）优先：本监听在捕获阶段，比控件自己早得多，
    //   不让路的话"点一下换颜色"会顺手在画布上落一个点。
    // ★ 只 `stopImmediatePropagation` 而**不** `preventDefault`：preventDefault 会掐掉
    //   这次 pointerdown 的默认行为，而按钮的 `click` 在个别实现里是跟着它走的 ——
    //   换颜色的按钮点了没反应，比多画一个点更难查。这一句足够挡住平移与卡片委托，
    //   而控件自己的 click 照常触发。
    if (this.isOverlayUi(event.target)) {
      event.stopImmediatePropagation();
      return;
    }

    // 第二个指针：吞掉。放它过去 = 触屏上 `NavigationController` 立刻开始平移，
    // 于是"一根手指画、另一根手指挪画布"，两边都在动
    if (this.pointerId !== null) {
      this.consume(event);
      return;
    }

    const surface = this.surface();
    if (!surface || this.isPanning()) return;

    this.consume(event);
    this.pointerId = event.pointerId;
    this.erasing = this.currentTool === 'eraser';
    // 聚焦由我们自己做：`NavigationController` 的那句 `host.focus()` 已经被拦在身后，
    // 而 `Esc` 得有人接着（它的 keydown 挂在画布上，画布没焦点就收不到）
    this.host.focus({ preventScroll: true });

    const world = this.toWorld(event);
    if (this.erasing) surface.eraseAt(world, this.eraserRadius());
    else surface.beginStroke(world, this.pressureOf(event));

    this.capture(event.pointerId);
  }

  private onPointerMove(event: PointerEvent): void {
    // 只跟"自己那根指针"：别人的移动（另一根手指、另一只鼠标）与这一笔无关
    if (this.pointerId === null || event.pointerId !== this.pointerId) return;
    const surface = this.surface();
    if (!surface) return;

    // 画到一半时也吞掉 move：否则卡片悬停锚点之类的"悬停态"会跟着笔尖一路闪
    this.consume(event);
    const world = this.toWorld(event);
    if (this.erasing) surface.eraseAt(world, this.eraserRadius());
    else surface.extendStroke(world, this.pressureOf(event));
  }

  private onPointerUp(event: PointerEvent): void {
    if (this.pointerId === null || event.pointerId !== this.pointerId) return;
    this.consume(event);
    // 橡皮没有"收尾"这一说；画笔则就地结束（已画出来的部分留下）
    if (!this.erasing) this.surface()?.endStroke();
    this.releaseCapture(this.pointerId);
    this.pointerId = null;
    this.erasing = false;
  }

  // ── 状态收尾 ────────────────────────────────────────────

  private teardownMode(): void {
    // 画到一半被 `Esc` 打断：收尾但**不回滚** —— 屏幕上已经看得见的那半笔就该留下
    // （临时标注态例外，但它不冲突：那半笔被收进暂存层，紧接着下一句就把它连同整层一起清掉）
    if (this.pointerId !== null) {
      if (!this.erasing) this.surface()?.endStroke();
      this.releaseCapture(this.pointerId);
      this.pointerId = null;
      this.erasing = false;
    }
    this.removeCursor();
    // ★ 临时标注层**长在手绘态上**：离开手绘态它就没了（T7.07）。
    //   先切开关再清空：反过来的话，`clearTransient` 与"新落一笔"之间会有一个
    //   "开关还开着"的窗口（这一层此刻没有事件循环，但顺序对了才经得起将来改动）。
    const surface = this.surface();
    surface?.setTransient(false);
    surface?.clearTransient();
    // 同 `dispose`：让工具条跟着收摊。`Esc` 走的是状态机，只有这里能收到信号
    this.onExit?.();
  }

  private applyCursor(): void {
    this.host.classList.add(INK_MODE_CLASS);
    this.host.classList.toggle(INK_ERASER_CLASS, this.currentTool === 'eraser');
    this.host.classList.toggle(INK_MARKER_CLASS, this.currentTool === 'marker');
  }

  private removeCursor(): void {
    this.host.classList.remove(INK_MODE_CLASS, INK_ERASER_CLASS, INK_MARKER_CLASS);
  }

  // ── 小工具 ──────────────────────────────────────────────

  /**
   * 吞掉这次指针事件：既不给默认行为（选中、拖拽、自动滚动），也不给别的控制器。
   * 「手绘态下画布是我的」这条规则只有这一处实现 —— 漏一处就会同时发生两件事。
   */
  private consume(event: PointerEvent): void {
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  /** 指针位置（视口坐标）→ 画布内的屏幕坐标 → 世界坐标 */
  private toWorld(event: PointerEvent): Point {
    const rect = this.host.getBoundingClientRect();
    return this.viewport.toWorld({
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    });
  }

  /** 橡皮半径（屏幕）→ 世界：手感跟眼睛走，放大后不用瞄得更准 */
  private eraserRadius(): number {
    const zoom = this.viewport.zoom > 0 ? this.viewport.zoom : 1;
    return INK_ERASER_RADIUS_PX / zoom;
  }

  /**
   * 取压感（0..1），**只认数位笔**。
   *
   * ★ 压感是**设备特性**，不是通用输入：按 Pointer Events 规范，鼠标在按键按下期间
   *   `pressure` 恒为 0.5，而多数触摸设备恒为 1。照着用的话，"鼠标画出来的线"
   *   会只有一半粗 —— 用户不会想到是压感在作怪，只会觉得"这支笔有问题"。
   *   所以只有 `pointerType === 'pen'`（Wacom / Apple Pencil / 数位屏）才取，
   *   其余设备一律 `undefined`，也就是"用满力"。
   *
   * ★ `pressure <= 0` 也当作没有：规范允许设备在"检测到笔但不接触"时上报 0，
   *   真按下去却报 0 的驱动也存在 —— 那种情况下宁可用满力。
   */
  private pressureOf(event: PointerEvent): number | undefined {
    if (event.pointerType !== 'pen') return undefined;
    const pressure = event.pressure;
    if (!Number.isFinite(pressure) || pressure <= 0) return undefined;
    return pressure;
  }

  /**
   * 事件目标是不是画布内的界面控件（带 `OVERLAY_UI_ATTR`）。见 `onPointerDown`。
   *
   * ★ 判定用"**有没有 `closest()`**"而不是 `instanceof Element`：本类要在 node 下单测，
   *   那里没有 DOM 全局，`instanceof Element` 会直接抛 `ReferenceError`
   *   （而这类"顺手用一下浏览器全局"的写法只在真机上报错，测试里永远不会暴露）。
   *   鸭子类型在这里并不更松：事件目标本来就只能是元素、`document` 或 `null`。
   */
  private isOverlayUi(target: EventTarget | null): boolean {
    return hasClosest(target) && target.closest(`[${OVERLAY_UI_ATTR}]`) !== null;
  }

  private capture(pointerId: number): void {
    try {
      this.host.setPointerCapture(pointerId);
    } catch {
      // 指针已经不存在（例如刚落笔就抬起）—— 没有捕获也能靠容器的 move 事件画完
    }
  }

  private releaseCapture(pointerId: number): void {
    try {
      if (this.host.hasPointerCapture(pointerId)) this.host.releasePointerCapture(pointerId);
    } catch {
      // 指针已经不存在 —— 无需处理
    }
  }

  private listen(type: string, listener: EventListener): void {
    // ★ 捕获阶段（见文件头）。移除时必须带同样的 capture，否则摘不掉
    this.host.addEventListener(type, listener, { capture: true });
    this.bound.push({ type, listener });
  }
}
