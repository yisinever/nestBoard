/**
 * 取色会话（T3.05 / `F2.6`）—— 把"点图片取色"这段**有始有终的一次交互**收在一个对象里。
 *
 * 为什么单独一个类，而不是塞进 `BoardView`：
 *  * 它有一段生命周期（进入 → **恰好一次**点击 → 结束），必须保证只能采一次；
 *  * 它要吃掉那次点击与 `Esc` —— 不吃掉就会"一边取色一边把卡片拖走"；
 *  * 这些规则全是"读代码看不出来、错了却很难查"的那类，所以要有单测盯着，
 *    而 `BoardView` 那个上万行的类没法单测。
 *
 * 视图只负责回答两个问题：**点在什么位置上**（`resolve`）与**取到了颜色怎么办**
 * （`onPick` / `onMiss`）。措辞也归视图 —— 本模块只报结果，不产出文案。
 *
 * ★ 不 import `obsidian`：于是它能在 node 下用假 DOM 完整跑一遍。
 */

import type { PixelSamplerBridge } from '../../cards/registry';
import { contentRectOf, sourcePixelAt, type PixelPoint } from '../../model/pixel';
import type { HexColor, ImageFit } from '../../model/schema';
import type { Rect } from '../../util/geometry';

/** 取色模式挂在画布上的类：负责十字光标（`.nestboard-eyedropper`，见 `styles.css`） */
export const EYEDROPPER_CLASS = 'nestboard-eyedropper';

/** 被吸色的那张图。由视图解析 —— 只有它知道点在哪张卡上、那张卡此刻的 `<img>` 是谁 */
export interface EyedropperSource {
  cardId: string;
  /** 图片卡的路径，取到颜色后记进 `pickedFrom`（`03 §2.7`） */
  path: string;
  image: HTMLImageElement;
  fit: ImageFit;
}

/**
 * 没取到颜色的四种原因。**分开报**而不是一律"失败"：用户需要知道下一步该改什么
 * （点图 / 点图上别的位置 / 换一张图 / 换个环境），一句笼统的"取色失败"帮不上忙。
 */
export type EyedropperMiss =
  /** 点的地方不是图片卡（空白、便签、链接…） */
  | 'notImage'
  /** 点在图片卡上，但落在 `contain` 的留白里 —— 那里没有像素 */
  | 'outside'
  /** 像素是透明的，或图片读不出来（跨域脏画布、文件坏了） */
  | 'noColor'
  /** 这个环境没有采样能力（单测、将来的只读嵌入视图） */
  | 'unavailable';

export interface EyedropperPorts {
  /** 画布容器：十字光标挂在它上面，`pointerdown` 也收在这里 */
  readonly host: HTMLElement;
  /**
   * `Esc` / 右键的监听宿主。
   *
   * ★ 用 `ownerDocument` 而不是画布元素：刚点完右键菜单时焦点多半不在画布上，
   *   挂在画布上的 `keydown` 收不到那一下 `Esc` —— 用户会以为"卡住了，只能重开"。
   */
  readonly keyTarget: EventTarget;
  /** 采样桥。缺失 = 这个能力整体不可用（进入时会直接报 `unavailable`） */
  readonly sampler: PixelSamplerBridge | undefined;
  /** 点在什么位置上：不是"有图的图片卡"就返回 `null` */
  resolve(event: PointerEvent): EyedropperSource | null;
  /** 取到了颜色（视图决定写进哪张卡） */
  onPick(color: HexColor, source: { cardId: string; path: string }): void;
  /** 没取到（会话已经结束，视图只需说明原因） */
  onMiss(reason: EyedropperMiss): void;
  /** 会话结束：成功、取消、失败都会走这一条，视图用它清掉手里的引用 */
  onEnd(): void;
}

/**
 * 一次取色会话。用过即弃：`start()` 进入、结束后本对象不再可用
 * （视图在 `onEnd` 里丢掉引用）。
 */
export class EyedropperSession {
  private readonly ports: EyedropperPorts;
  private listening = false;

  constructor(ports: EyedropperPorts) {
    this.ports = ports;
  }

  /** 是否正在取色（视图用它挡住重复进入） */
  get active(): boolean {
    return this.listening;
  }

  /** 进入取色模式。已经在模式里时不重复挂监听（重复挂会让一次点击被采两次） */
  start(): void {
    if (this.listening) return;
    if (!this.ports.sampler) {
      // 能力缺失：明说，而不是进入一个点了没反应的模式
      this.ports.onMiss('unavailable');
      this.ports.onEnd();
      return;
    }

    this.listening = true;
    this.ports.host.classList.add(EYEDROPPER_CLASS);
    // 捕获阶段：拖拽 / 选择 / 双击都挂在画布上，放行一次就等于"取色的同时把卡片拖走了"
    this.ports.host.addEventListener('pointerdown', this.onPointerDown, true);
    this.ports.host.addEventListener('contextmenu', this.onContextMenu, true);
    this.ports.keyTarget.addEventListener('keydown', this.onKeyDown, true);
  }

  /** 退出取色（`Esc` / 右键 / 视图被拆掉）：不再响应点击，也**不会再回调 `onPick`** */
  cancel(): void {
    this.finish();
  }

  private readonly onPointerDown = (event: Event): void => {
    const pointer = event as PointerEvent;
    // 非主键放行：中键平移在取色期间照旧可用（它本来就不触发取色）
    if (pointer.button !== 0) return;

    // ★ 先吃掉事件再算：算的时候要读 `getBoundingClientRect()`，
    //   而下游那串监听器一旦跑起来（开始拖拽）布局就变了
    pointer.preventDefault();
    pointer.stopImmediatePropagation();

    const source = this.ports.resolve(pointer);
    if (!source) {
      this.finish('notImage');
      return;
    }

    const pixel = this.pixelOf(pointer, source);
    if (!pixel) {
      this.finish('outside');
      return;
    }

    // ★ 先结束再采样：`samplePixel` 是异步的（要解码图片像素），
    //   不先结束的话，等待期间再点一下就会并发采第二次
    this.finish();
    const sampler = this.ports.sampler;
    void sampler?.samplePixel(source.image, pixel).then((color) => {
      if (color) this.ports.onPick(color, { cardId: source.cardId, path: source.path });
      else this.ports.onMiss('noColor');
    });
  };

  private readonly onContextMenu = (event: Event): void => {
    // 右键 = 算了：菜单也不要弹（弹出来还得再点一次"取消"）
    event.preventDefault();
    event.stopImmediatePropagation();
    this.finish();
  };

  private readonly onKeyDown = (event: Event): void => {
    if ((event as KeyboardEvent).key !== 'Escape') return;
    event.preventDefault();
    // 不放行：画布自己也认 `Esc`（取消选择、退出编辑态），不该顺手把别的东西也取消掉
    event.stopPropagation();
    this.finish();
  };

  /** 点 → 图源像素。点在图外（`contain` 留白）时返回 `null` */
  private pixelOf(pointer: PointerEvent, source: EyedropperSource): PixelPoint | null {
    const { image } = source;
    const natural = { width: image.naturalWidth, height: image.naturalHeight };
    const bounds = image.getBoundingClientRect();
    const box: Rect = { x: bounds.left, y: bounds.top, width: bounds.width, height: bounds.height };
    const content = contentRectOf(box, natural, source.fit);
    if (!content) return null;
    return sourcePixelAt({ x: pointer.clientX, y: pointer.clientY }, content, natural);
  }

  /**
   * 收摊：摘类、摘监听、报结果。
   *
   * `miss` 省略 = 静默结束（用户主动取消，不必再说什么）。幂等 ——
   * 视图拆除时无条件 `cancel()` 一次，不会重复回调。
   */
  private finish(miss?: EyedropperMiss): void {
    if (!this.listening) return;
    this.listening = false;
    this.ports.host.classList.remove(EYEDROPPER_CLASS);
    this.ports.host.removeEventListener('pointerdown', this.onPointerDown, true);
    this.ports.host.removeEventListener('contextmenu', this.onContextMenu, true);
    this.ports.keyTarget.removeEventListener('keydown', this.onKeyDown, true);
    if (miss) this.ports.onMiss(miss);
    this.ports.onEnd();
  }
}
