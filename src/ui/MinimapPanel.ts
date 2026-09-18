/**
 * 缩略图导航器（T5.09 / `F1-06`）：画布右下角那张小地图，点击 / 拖动定位。
 *
 * 几何全在 `ui/minimapGeometry.ts` 里（那份带单测）。这里只做三件事：
 * 把格子画成 DOM、把视口框跟着相机挪、把手势变成"把视口中心移到这个世界坐标"。
 *
 * ★ 文件名是 `MinimapPanel.ts` 而不是 `Minimap.ts`：一来与 `ui/BoardListPanel.ts`
 *   一个路数（面板类叫 `…Panel`），二来 macOS 默认大小写不敏感，`Minimap.ts` 与
 *   `minimapGeometry.ts` 这一对只差大小写的名字在那种文件系统上会互相覆盖
 *   （真发生过：写进去的内容静默变成空文件）。
 *
 * ## 四条刻意的设计
 *
 * 1. **不 import `obsidian`**（和 `ui/CardFilterBar.ts` 一样）。
 *    于是它能被 `src/tests/helpers/fakeDom.ts` 那套假 DOM 单测 —— 而这里真正值得钉的
 *    恰恰是"点在地图右下角 → 跳到世界的哪里"这种错了很难看出来的映射。
 *    `setIcon` 这类 Obsidian 糖因此不用：关闭键就是一个 `×` 文本按钮。
 * 2. **两条同步路径**，因为两者代价差着数量级：
 *    `syncContent()` 会遍历全部卡片（只在板子变了时调），`syncCamera()` 只算一个矩形
 *    （每帧都会调）。合在一起的话，平移时的每一帧都要扫一遍全部卡片。
 * 3. **内容指纹 + 盒子尺寸一起做键**：条件没变就一个 DOM 都不碰。
 *    这条路径被 `applyBoard` 调用，而自动高度、拖动落定都会走它。
 * 4. **拖动用 `setPointerCapture`**，不是往 document 上挂临时监听：
 *    拖到面板外再松手，没有捕获的话 `pointerup` 永远收不到，`dragging` 会一直挂着 ——
 *    之后**没按住**鼠标划过地图也会把画布拽走。
 *
 * ## 两个刻意的取舍
 *
 * * **键盘路径是"回到内容中心"**（Tab 到地图、Enter）。地图上"第 37 格是哪张卡"
 *   对键盘用户没有意义，而"回到全部内容"有明确含义 —— 与命令面板里的 `⌘0`（适应全部内容）
 *   同一个归宿。不这么做的话，这就是画布上唯一一个**只有鼠标能用**的东西。
 * * **视口框会被裁掉**（`.nestboard-minimap__map` 上 `overflow: hidden`）。
 *   相机跑到内容之外时，框整个在盒子外面，于是**什么都不画** —— 这是正确答案：
 *   "我不在任何内容附近"本身就是要传达的信息，画一个贴在边上的假框反而会让人
 *   以为自己正看着某片内容。
 */

import { rectCenter, type Point, type Rect } from '../util/geometry';
import { t } from '../util/i18n';
import {
  contentBounds,
  contentSignature,
  planMinimap,
  toMapRect,
  toWorldPoint,
  viewportWorldRect,
  type MinimapBox,
  type MinimapCamera,
  type MinimapPlan,
  type MinimapShape,
} from './minimapGeometry';

export interface MinimapOptions {
  /** 当前要画的格子（由调用方从白板取，见 `minimapShapes`） */
  shapes: () => readonly MinimapShape[];
  /** 相机快照（屏幕坐标） */
  camera: () => MinimapCamera;
  /** 手势落点 → 世界坐标。视图实现为"把视口中心挪过去" */
  onNavigate: (world: Point) => void;
  /** 面板上的 `×`：与命令走同一条路径（视图去改设置），地图自己不碰持久化 */
  onRequestHide: () => void;
}

/**
 * 量不到尺寸时的兜底盒子。
 *
 * ★ 真实浏览器里量不到只有一种情形：面板刚显示、布局还没算完（比如视图在非激活的
 *   标签页里）。这时按兜底尺寸先画一版，下次同步就会量到真值。
 * ★ 单测的假 DOM 没有布局，`clientWidth` 是 `undefined`，也落到这里 ——
 *   于是"渲染出几格、格子在哪"能被断言，而真值仍由 CSS 说了算（尺寸不写在 TS 里）。
 */
const FALLBACK_BOX: MinimapBox = { width: 176, height: 116 };

/** 手势事件里真正用到的字段（`PointerEvent` 在单测里是手工造的） */
interface PointerLike {
  pointerId: number;
  button: number;
  clientX: number;
  clientY: number;
  preventDefault: () => void;
}

export class Minimap {
  /** 面板根节点（挂到视图根容器上） */
  readonly el: HTMLElement;

  private readonly options: MinimapOptions;
  private readonly surface: HTMLElement;
  private readonly mapEl: HTMLElement;
  private readonly viewportEl: HTMLElement;
  private readonly titleEl: HTMLElement;
  private readonly hideButton: HTMLElement;

  private plan: MinimapPlan | null = null;
  private bounds: Rect | null = null;
  private shapeEls: HTMLElement[] = [];

  /** 上一次画下去的内容指纹（含盒子尺寸）；`''` = 从没画过 */
  private appliedKey = '';
  /** 上一次写进视口框的几何；不动相机就不写 DOM */
  private appliedViewport = '';
  private visible = false;
  private dragging = false;

  constructor(parent: HTMLElement, options: MinimapOptions) {
    this.options = options;
    const doc = parent.ownerDocument;

    this.el = doc.createElement('div');
    this.el.className = 'nestboard-minimap is-hidden';

    const head = doc.createElement('div');
    head.className = 'nestboard-minimap__head';
    this.titleEl = doc.createElement('span');
    this.titleEl.className = 'nestboard-minimap__title';
    head.appendChild(this.titleEl);
    this.hideButton = doc.createElement('button');
    this.hideButton.className = 'nestboard-minimap__hide';
    // 不用 `setIcon`：obsidian 的图标 API 会把这个类拖进"不可单测"那一档（见文件头第 1 条）
    this.hideButton.textContent = '×';
    this.hideButton.addEventListener('click', () => {
      this.options.onRequestHide();
    });
    head.appendChild(this.hideButton);
    this.el.appendChild(head);

    // ★ `<button>` 而不是 `<div>`：它是画布上唯一一个"点哪儿去哪儿"的控件，
    //   键盘得能 Tab 到它（见文件头的取舍一）。指针事件照常走 pointerdown。
    this.surface = doc.createElement('button');
    this.surface.className = 'nestboard-minimap__surface';
    this.surface.setAttribute('type', 'button');
    this.surface.addEventListener('pointerdown', (event) => {
      this.onPointerDown(event as unknown as PointerLike);
    });
    this.surface.addEventListener('pointermove', (event) => {
      this.onPointerMove(event as unknown as PointerLike);
    });
    this.surface.addEventListener('pointerup', (event) => {
      this.onPointerUp(event as unknown as PointerLike);
    });
    this.surface.addEventListener('pointercancel', (event) => {
      this.onPointerUp(event as unknown as PointerLike);
    });
    this.surface.addEventListener('keydown', (event) => {
      this.onKeyDown(event as unknown as KeyboardEvent);
    });

    this.mapEl = doc.createElement('div');
    this.mapEl.className = 'nestboard-minimap__map';
    this.mapEl.setAttribute('aria-hidden', 'true');
    this.viewportEl = doc.createElement('div');
    this.viewportEl.className = 'nestboard-minimap__viewport is-hidden';
    this.mapEl.appendChild(this.viewportEl);
    this.surface.appendChild(this.mapEl);
    this.el.appendChild(this.surface);

    parent.appendChild(this.el);
    this.refreshLabels();
  }

  get isVisible(): boolean {
    return this.visible;
  }

  /**
   * 显示 / 隐藏。
   *
   * ★ 变成可见时**必须**重同步一次：隐藏期间量不到尺寸（`clientWidth === 0`），
   *   内容与视口框都没画过，靠每帧的 `syncCamera()` 补不回来 ——
   *   它只挪框，不会重建内容。
   */
  setVisible(visible: boolean): void {
    if (visible === this.visible) return;
    this.visible = visible;
    this.el.classList.toggle('is-hidden', !visible);
    if (visible) this.syncContent();
  }

  /** 文案刷新（语言切换时由视图推过来） */
  refreshLabels(): void {
    this.el.setAttribute('aria-label', t('minimap.title'));
    this.titleEl.textContent = t('minimap.title');
    this.hideButton.setAttribute('aria-label', t('minimap.hide'));
    this.surface.setAttribute('aria-label', t('minimap.surface'));
  }

  /** 内容变了（`BoardView.applyBoard`）：重算映射，必要时重建格子 */
  syncContent(): void {
    if (!this.visible) return;
    const shapes = this.options.shapes();
    const box = this.measureBox();
    // ★ 几何 + 尺寸合成一个键：两者任一变化都要重画（尺寸变化 = 移动端转屏 / 主题改了面板大小）
    const key = `${box.width}x${box.height}|${contentSignature(shapes)}`;
    if (key === this.appliedKey) {
      this.syncViewportRect();
      return;
    }
    this.appliedKey = key;
    this.bounds = contentBounds(shapes);
    this.plan = planMinimap(this.bounds, box);
    this.renderShapes(shapes);
    this.syncViewportRect();
  }

  /** 相机动了（`BoardView.syncCanvas`，每帧）：只挪视口框 */
  syncCamera(): void {
    if (!this.visible || !this.plan) return;
    this.syncViewportRect();
  }

  dispose(): void {
    this.el.remove();
    this.shapeEls = [];
  }

  // ── 内部 ──────────────────────────────────────────────

  private measureBox(): MinimapBox {
    // ★ 要 `clientWidth/Height`（内容 + 内边距）而不是 `getBoundingClientRect()`：
    //   绝对定位的格子以 **padding box** 为原点，而后者含边框 ——
    //   样式里给面板留边框的话，两套坐标会整体差 1px（`styles.css` 里也标了这条约束）。
    // ★ `|| 兜底`：0 与 `undefined`（假 DOM 没有布局）都当作"现在还量不到"。
    return {
      width: this.surface.clientWidth || FALLBACK_BOX.width,
      height: this.surface.clientHeight || FALLBACK_BOX.height,
    };
  }

  private renderShapes(shapes: readonly MinimapShape[]): void {
    const plan = this.plan;
    if (!plan) {
      this.clearShapes();
      return;
    }
    for (let i = 0; i < shapes.length; i += 1) {
      let el = this.shapeEls[i];
      if (!el) {
        el = this.mapEl.ownerDocument.createElement('div');
        this.mapEl.appendChild(el);
        this.shapeEls[i] = el;
      }
      // 格子在地图上是匿名的（没有身份），所以按**下标**复用元素：
      // 几何每次都会整份重写，多出来的末尾元素摘掉即可。
      const cls = `nestboard-minimap__shape is-${shapes[i].kind}`;
      if (el.className !== cls) el.className = cls;
      const rect = toMapRect(plan, shapes[i].rect);
      el.style.setProperty('transform', `translate(${rect.x}px, ${rect.y}px)`);
      el.style.setProperty('width', `${rect.width}px`);
      el.style.setProperty('height', `${rect.height}px`);
    }
    while (this.shapeEls.length > shapes.length) {
      this.shapeEls.pop()?.remove();
    }
  }

  private clearShapes(): void {
    while (this.shapeEls.length > 0) {
      this.shapeEls.pop()?.remove();
    }
  }

  private syncViewportRect(): void {
    const plan = this.plan;
    const world = plan ? viewportWorldRect(this.options.camera()) : null;
    const rect = plan && world ? toMapRect(plan, world) : null;
    const key = rect ? `${rect.x}|${rect.y}|${rect.width}|${rect.height}` : '';
    if (key === this.appliedViewport) return;
    this.appliedViewport = key;
    if (!rect) {
      // 相机还没尺寸 / 地图上没有内容：不画框，也不藏面板（地图本身还在，仍然可以点）
      this.viewportEl.classList.add('is-hidden');
      return;
    }
    this.viewportEl.classList.remove('is-hidden');
    this.viewportEl.style.setProperty('transform', `translate(${rect.x}px, ${rect.y}px)`);
    this.viewportEl.style.setProperty('width', `${rect.width}px`);
    this.viewportEl.style.setProperty('height', `${rect.height}px`);
  }

  private onPointerDown(event: PointerLike): void {
    // 只认主键：中键是画布的平移手势、右键是菜单，都不该被地图半路吃掉
    if (event.button !== 0 || !this.plan) return;
    event.preventDefault();
    // ★ 见文件头第 4 条。抓不到指针只损失"拖出面板还能继续拖"，
    //   所以是可选调用而不是 if 分支（假 DOM 里没有这个方法）。
    this.surface.setPointerCapture?.(event.pointerId);
    this.dragging = true;
    this.navigateTo(event);
  }

  private onPointerMove(event: PointerLike): void {
    if (!this.dragging) return;
    this.navigateTo(event);
  }

  private onPointerUp(event: PointerLike): void {
    if (!this.dragging) return;
    this.dragging = false;
    this.surface.releasePointerCapture?.(event.pointerId);
  }

  /**
   * 键盘：Enter / Space = 回到内容中心。
   *
   * ★ 不用 `click` 而用 `keydown`：`<button>` 被键盘激活时也会派发 `click`，
   *   而**触摸屏合成出来的 `click` 的 `detail` 同样是 0** —— 想用 `detail === 0`
   *   区分"键盘"和"手指"，会在手机上把一次正常点击变成"跳到内容中心"。
   *   这里 `preventDefault()` 顺手掐掉那次合成 `click`。
   */
  private onKeyDown(event: KeyboardEvent): void {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    if (!this.bounds) return;
    this.options.onNavigate(rectCenter(this.bounds));
  }

  private navigateTo(event: PointerLike): void {
    const plan = this.plan;
    if (!plan) return;
    this.options.onNavigate(toWorldPoint(plan, this.localPoint(event)));
  }

  private localPoint(event: PointerLike): Point {
    // ★ 用 `getBoundingClientRect()` 而不是 `event.offsetX`：`offsetX` 相对的是**事件目标**，
    //   而地图里的格子并不吃指针事件（CSS `pointer-events: none`）—— 一旦哪天有人在
    //   格子上挂了别的行为，`offsetX` 会安静地变成"相对那一格"，点哪儿偏哪儿。
    // ★ 假 DOM 没有布局（`getBoundingClientRect` 不存在），兜底成 (0,0)：
    //   单测里"客户端坐标 == 地图内坐标"，正好能把映射钉死。
    const rect = this.surface.getBoundingClientRect?.();
    return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) };
  }
}
