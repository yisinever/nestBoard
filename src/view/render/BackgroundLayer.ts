/**
 * 背景层：纯色 / 点阵 / 网格 / 无（T1.21，F1-05）。
 *
 * **为什么不用 Canvas 画背景**：背景是"无限重复的图案"，用 CSS
 * `background-image` + `background-size` / `background-position` 表达，
 * 平铺与相位偏移全部由合成器完成 —— 平移缩放时**零重绘**。
 * Canvas 方案每帧都要 `clearRect` 再把满屏圆点重画一遍，1000 卡场景下纯属浪费（02 §8.2）。
 *
 * 分层纪律（02 §5.1）：**图案本身与颜色留在 styles.css**（用 `data-*` 属性切换），
 * 这里只写"每帧都在变的动态值"（单元格尺寸、相位、点半径）—— 这类值无法静态化，
 * 是全插件唯一允许写 inline style 的地方之一。
 */

import type { BoardBackground } from '../../model/schema';
import { clamp, roundTo } from '../../util/geometry';
import type { Viewport } from '../../canvas/Viewport';

/**
 * 点阵/网格在屏幕上的单元格小于这个尺寸就不再绘制：
 * 缩到很小时图案会退化成摩尔纹 + 满屏噪点，比"没有背景"更难看，也更费合成。
 */
const MIN_PATTERN_CELL_PX = 8;

/** 点半径不跟随缩放无限变化：太小时看不见，太大时点会连成片 */
const DOT_RADIUS = { base: 1.25, min: 0.8, max: 2.4 } as const;

const FALLBACK_GRID_SIZE = 32;

export class BackgroundLayer {
  private mode: BoardBackground = 'dots';
  private gridSize = FALLBACK_GRID_SIZE;

  constructor(private readonly host: HTMLElement) {}

  /** 白板级设置入口：`view.background` + `settings.gridSize` */
  setBackground(mode: BoardBackground, gridSize: number): void {
    this.mode = mode;
    this.gridSize = Number.isFinite(gridSize) && gridSize > 0 ? gridSize : FALLBACK_GRID_SIZE;
    this.host.dataset.nestboardBg = this.mode;
  }

  get background(): BoardBackground {
    return this.mode;
  }

  get cellSize(): number {
    return this.gridSize;
  }

  /** 跟随视口同步平铺尺寸与相位。每次视口变化都会调用（廉价：只写 2~3 个属性） */
  sync(viewport: Viewport): void {
    if (this.mode !== 'dots' && this.mode !== 'grid') {
      this.reset();
      return;
    }

    const cell = this.gridSize * viewport.zoom;
    if (!Number.isFinite(cell) || cell < MIN_PATTERN_CELL_PX) {
      // 底色保留，只是不画图案（02 §4.3：缩到很小时允许降级）
      this.host.dataset.nestboardPattern = 'off';
      this.host.style.backgroundSize = '';
      this.host.style.backgroundPosition = '';
      return;
    }

    // 相位取模：画布可以平移到世界坐标 -1e6 之外，但 CSS 背景偏移始终保持在一个单元格内
    const phaseX = ((viewport.x % cell) + cell) % cell;
    const phaseY = ((viewport.y % cell) + cell) % cell;

    this.host.dataset.nestboardPattern = 'on';
    this.host.style.backgroundSize = `${roundTo(cell)}px ${roundTo(cell)}px`;
    this.host.style.backgroundPosition = `${roundTo(phaseX)}px ${roundTo(phaseY)}px`;

    if (this.mode === 'dots') {
      const radius = clamp(DOT_RADIUS.base * viewport.zoom, DOT_RADIUS.min, DOT_RADIUS.max);
      this.host.style.setProperty('--nestboard-dot-radius', `${roundTo(radius)}px`);
    }
  }

  private reset(): void {
    this.host.removeAttribute('data-nestboard-pattern');
    this.host.style.backgroundSize = '';
    this.host.style.backgroundPosition = '';
    this.host.style.removeProperty('--nestboard-dot-radius');
  }
}
