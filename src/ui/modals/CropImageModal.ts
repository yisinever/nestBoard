/**
 * 图片裁剪对话框（T2.02 / `F2-3-3`）。
 *
 * 只做三件事，其余都下放：
 *  * **摆一块预览**：把整图按"塞得进对话框"的尺寸铺开（`layoutStage`）；
 *  * **把鼠标位移换算成比例**：像素 ÷ 舞台边长，然后交给 `model/crop.ts` 的
 *    `moveCrop` / `resizeCrop` —— 拖出画布、拉到反向这些边界全在那边钉死；
 *  * **把结果交回去**：`onApply(clampCrop(crop))`，由视图写进卡片内容。
 *
 * ★ 对话框**不认识 Vault、也不碰文件**：只拿一个已经解析好的图片 URL 和一个
 *   当前的 `crop`。原图一个字节都不会被改（`F2-3-3` 的硬要求）—— 输出只是四个数。
 *
 * ★ 裁剪矩形用**百分比**定位（相对舞台）：舞台尺寸随图片变化，写像素值就得在
 *   每次尺寸变化时重算一遍，而百分比天然跟着走，窗口 resize 也不会错位。
 */

import { Modal } from 'obsidian';
import type { App } from 'obsidian';
import {
  CROP_HANDLES,
  IDENTITY_CROP,
  clampCrop,
  moveCrop,
  resizeCrop,
  type CropHandle,
} from '../../model/crop';
import type { ImageCrop } from '../../model/schema';
import { t } from '../../util/i18n';

/** 预览舞台的最大边长（px）。再大对话框就开始顶到屏幕边缘，手机上更是直接溢出 */
const MAX_STAGE_WIDTH = 520;
const MAX_STAGE_HEIGHT = 420;
/** 舞台最短边的下限：太小的话 5% 的最小裁剪框只有一两个像素，鼠标根本抓不住 */
const MIN_STAGE_SIDE = 160;
/** 小图的放大上限。放着不管的话一张 16px 图标会被放大成一块马赛克 */
const MAX_UPSCALE = 8;

interface DragState {
  /** `null` = 拖动整块（平移）；否则是正在拉伸的那条边 */
  handle: CropHandle | null;
  pointerId: number;
  startX: number;
  startY: number;
  /** 本次拖动的起点裁剪值：每帧都从它 + 总位移重算，避免逐帧累加漂移 */
  base: ImageCrop;
}

export class CropImageModal extends Modal {
  private crop: ImageCrop;
  private stageEl: HTMLElement | null = null;
  private rectEl: HTMLElement | null = null;
  /** 舞台的像素尺寸：像素位移 → 比例的换算只靠它 */
  private stageWidth = 0;
  private stageHeight = 0;
  private drag: DragState | null = null;

  // 存成字段而不是每次内联：`removeEventListener` 必须拿到同一个引用
  private readonly onPointerMove = (event: PointerEvent): void => this.handleMove(event);
  private readonly onPointerUp = (event: PointerEvent): void => this.endDrag(event);

  constructor(
    app: App,
    private readonly url: string,
    current: ImageCrop,
    private readonly onApply: (crop: ImageCrop) => void,
  ) {
    super(app);
    // 手改过的 `.nboard` 可能给出一个跑到画布外的裁剪框，进来先收敛一次
    this.crop = clampCrop(current);
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('nestboard-modal', 'nestboard-crop-modal');
    this.setTitle(t('modal.crop.title'));

    contentEl.createEl('p', { cls: 'nestboard-modal-desc', text: t('modal.crop.hint') });

    const stage = contentEl.createDiv({ cls: 'nestboard-crop-stage' });
    this.stageEl = stage;

    const status = contentEl.createDiv({
      cls: 'nestboard-crop-status',
      text: t('modal.crop.loading'),
    });

    const image = stage.createEl('img', { cls: 'nestboard-crop-image' });
    image.alt = '';

    const rect = stage.createDiv({ cls: 'nestboard-crop-rect' });
    this.rectEl = rect;
    for (const handle of CROP_HANDLES) {
      const knob = rect.createDiv({ cls: `nestboard-crop-handle is-${handle}` });
      knob.dataset.handle = handle;
    }
    rect.addEventListener('pointerdown', (event) => this.beginDrag(event));

    const actions = contentEl.createDiv({ cls: 'nestboard-crop-actions' });
    const resetButton = actions.createEl('button', {
      cls: 'nestboard-btn',
      text: t('modal.crop.reset'),
    });
    const cancelButton = actions.createEl('button', {
      cls: 'nestboard-btn',
      text: t('modal.cancel'),
    });
    const applyButton = actions.createEl('button', {
      cls: 'nestboard-btn mod-cta',
      text: t('modal.crop.apply'),
    });

    resetButton.addEventListener('click', () => {
      this.crop = { ...IDENTITY_CROP };
      this.syncRect();
    });
    cancelButton.addEventListener('click', () => this.close());
    applyButton.addEventListener('click', () => {
      const result = clampCrop(this.crop);
      this.close();
      this.onApply(result);
    });

    image.addEventListener('load', () => {
      status.remove();
      this.layoutStage(image.naturalWidth, image.naturalHeight);
    });
    image.addEventListener('error', () => {
      status.setText(t('modal.crop.loadFailed'));
      status.addClass('is-error');
      // 图都加载不出来，就别让用户"应用"一个自己根本没看见的裁剪
      applyButton.disabled = true;
    });
    image.src = this.url;
    // 缓存命中的图片挂上来时就已经 `complete`，那一刻不会再派发 `load`
    if (image.complete && image.naturalWidth > 0) {
      status.remove();
      this.layoutStage(image.naturalWidth, image.naturalHeight);
    }
  }

  override onClose(): void {
    this.stopDrag();
    this.stageEl = null;
    this.rectEl = null;
    this.contentEl.empty();
  }

  /**
   * 按原图尺寸摆好舞台。
   *
   * ★ 大图只缩不放、小图最多放到 `MAX_UPSCALE`：一张 4000px 的截图直接铺开会有
   *   几屏那么宽，而一张 16px 的图标放大 20 倍后整块都是马赛克 —— 两个极端都
   *   让"选区域"这件事变得没法做。
   */
  private layoutStage(naturalWidth: number, naturalHeight: number): void {
    const stage = this.stageEl;
    if (!stage || naturalWidth <= 0 || naturalHeight <= 0) return;

    let scale = Math.min(MAX_STAGE_WIDTH / naturalWidth, MAX_STAGE_HEIGHT / naturalHeight);
    if (scale > 1) {
      scale = Math.min(
        MAX_UPSCALE,
        Math.max(1, MIN_STAGE_SIDE / Math.min(naturalWidth, naturalHeight)),
      );
    }

    this.stageWidth = Math.max(1, Math.round(naturalWidth * scale));
    this.stageHeight = Math.max(1, Math.round(naturalHeight * scale));
    stage.style.setProperty('width', `${this.stageWidth}px`);
    stage.style.setProperty('height', `${this.stageHeight}px`);
    stage.addClass('is-ready');
    this.syncRect();
  }

  /** 把当前的 `crop` 贴回裁剪框（百分比定位，随舞台尺寸自适应） */
  private syncRect(): void {
    const rect = this.rectEl;
    if (!rect) return;
    const crop = clampCrop(this.crop);
    rect.style.setProperty('left', `${crop.x * 100}%`);
    rect.style.setProperty('top', `${crop.y * 100}%`);
    rect.style.setProperty('width', `${crop.w * 100}%`);
    rect.style.setProperty('height', `${crop.h * 100}%`);
  }

  private beginDrag(event: PointerEvent): void {
    if (event.button !== 0) return;
    const rect = this.rectEl;
    if (!rect) return;
    // 不让事件传到卡片/画布上：否则对话框外面会跟着一起拖
    event.preventDefault();
    event.stopPropagation();

    this.drag = {
      handle: readHandle(event.target),
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      base: clampCrop(this.crop),
    };
    // 指针捕获：拖出对话框边界（甚至拖到窗口外）也还能收到 move
    rect.setPointerCapture?.(event.pointerId);
    rect.addEventListener('pointermove', this.onPointerMove);
    rect.addEventListener('pointerup', this.onPointerUp);
    rect.addEventListener('pointercancel', this.onPointerUp);
  }

  private handleMove(event: PointerEvent): void {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (this.stageWidth <= 0 || this.stageHeight <= 0) return;
    event.preventDefault();

    const dx = (event.clientX - drag.startX) / this.stageWidth;
    const dy = (event.clientY - drag.startY) / this.stageHeight;
    this.crop = drag.handle
      ? resizeCrop(drag.base, drag.handle, dx, dy)
      : moveCrop(drag.base, dx, dy);
    this.syncRect();
  }

  private endDrag(event: PointerEvent): void {
    if (!this.drag || event.pointerId !== this.drag.pointerId) return;
    this.stopDrag();
    const rect = this.rectEl;
    if (rect?.hasPointerCapture?.(event.pointerId)) rect.releasePointerCapture(event.pointerId);
  }

  private stopDrag(): void {
    if (!this.drag) return;
    const rect = this.rectEl;
    rect?.removeEventListener('pointermove', this.onPointerMove);
    rect?.removeEventListener('pointerup', this.onPointerUp);
    rect?.removeEventListener('pointercancel', this.onPointerUp);
    this.drag = null;
  }
}

/** 事件目标是不是某个拉伸柄；是就返回它负责的那条边 */
function readHandle(target: EventTarget | null): CropHandle | null {
  const element = target as HTMLElement | null;
  const value = element?.dataset?.handle;
  if (value && (CROP_HANDLES as readonly string[]).includes(value)) return value as CropHandle;
  return null;
}
