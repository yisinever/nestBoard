/**
 * 脏区账本（T1.27，连线层与手绘层共用）。
 *
 * Canvas 层不能用 CSS 类名局部刷新（那是 DOM 的特权），只能"清一小块 + 重画那一块"。
 * 于是每次改动都得回答一个问题：**这次脏了哪一块世界矩形？**
 * 本文件就是那个问题的答案，以及它的三条规矩：
 *
 *  1. 多个矩形**合并成包围盒**（而不是维护矩形列表）；
 *  2. 数字非法 / 没给矩形 → 一律降级成**整层重绘**（保守但绝不留残影）；
 *  3. `peek` 只看不消费，「先清账、再绘制」由调用方配合（`DirtyCanvasLayer`）。
 *
 * ★ 纯逻辑、不碰 DOM —— 可在 node 下单测。它的错误表现（"拖完卡片留下一道残影"）
 *   极难在真机上定位，所以规则必须被单测钉死。
 */

import { boundsOf, type Rect } from '../../util/geometry';

export interface DirtySnapshot {
  /** `true` 表示整层重绘（视口变了 / 换板 / 尺寸变了 / 遇到非法值） */
  all: boolean;
  /** 需要重绘的**世界**矩形；`all` 为 `true` 时无意义 */
  bounds: Rect | null;
}

function hasUsableNumbers(rect: Rect): boolean {
  return (
    Number.isFinite(rect.x) &&
    Number.isFinite(rect.y) &&
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height)
  );
}

/**
 * 脏区账本：只记"哪些世界矩形需要重绘"，并把它合并成一个包围盒。
 *
 * 合并成包围盒（而不是维护矩形列表）是刻意的取舍：
 * 拖动一张卡产生的脏区高度重叠，逐个精确求并集要写多边形布尔运算，
 * 而多清一小块矩形的代价只是多画几条重叠连线 —— 稳赚。
 */
export class DirtyRegion {
  private rect: Rect | null = null;
  private everything = false;

  get isEmpty(): boolean {
    return !this.everything && this.rect === null;
  }

  /** 标脏。`rect` 省略 / 为 `null` / 数字非法 → 视为整层重绘（保守但安全） */
  add(rect?: Rect | null): void {
    if (!rect || !hasUsableNumbers(rect)) {
      this.addAll();
      return;
    }
    this.rect = this.rect ? (boundsOf([this.rect, rect]) ?? rect) : rect;
  }

  /**
   * 整层重绘（视口变化、换板、尺寸变化）。
   * 顺手丢掉 `bounds`：保持不变式「`all` 为真 ⇒ `bounds` 为 null」，
   * 免得调用方看到两个都有效时还要猜哪个优先。
   */
  addAll(): void {
    this.everything = true;
    this.rect = null;
  }

  peek(): DirtySnapshot {
    return { all: this.everything, bounds: this.rect };
  }

  clear(): void {
    this.everything = false;
    this.rect = null;
  }
}
