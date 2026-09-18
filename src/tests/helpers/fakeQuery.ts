/**
 * 假 DOM 上的"找元素"小工具（`mind/view/CanvasControls` 与 `NodeToolbar` 两组用例共用）。
 *
 * ★ 为什么不是 `querySelector`：假 DOM **只实现被测代码真正用到的那几个接口**
 *   （没有 `querySelector`、也没有 `tagName`）—— 这一点是刻意的，它逼着组件
 *   把"可被认出来的 class"补上（样式表本来也按 class 认人）。
 * ★ 抽出来而不是每份用例各抄一遍：抄第二遍之后，"找不到就报错"这种行为
 *   在两处会开始不一样，而这类小差异最难查。
 */

import type { FakeElement } from './fakeDom';

export const asEl = (value: unknown): FakeElement => value as FakeElement;

/** 在**前几层**里按 class 找一个（默认 4 层：容器的层级就这么深） */
export function findByClass(root: FakeElement, className: string, depth = 4): FakeElement | null {
  for (const child of root.children.map(asEl)) {
    if (child.classList.contains(className)) return child;
    if (depth > 0) {
      const found = findByClass(child, className, depth - 1);
      if (found) return found;
    }
  }
  return null;
}

/** 同上，但找不到就抛（用例里通常"找不到"本身就是失败，早报比晚报好读） */
export function mustFind(root: FakeElement, className: string): FakeElement {
  const found = findByClass(root, className);
  if (!found) throw new Error(`没找到 .${className}`);
  return found;
}

/** 按 class 找**全部**（含任意深度） */
export function findAllByClass(root: FakeElement, className: string): FakeElement[] {
  const out: FakeElement[] = [];
  for (const child of root.children.map(asEl)) {
    if (child.classList.contains(className)) out.push(child);
    out.push(...findAllByClass(child, className));
  }
  return out;
}

/** 直接孩子（假 DOM 的 `textContent` **不聚合**孩子，读文字常常要走进一层） */
export function childrenOf(element: FakeElement): FakeElement[] {
  return element.children.map(asEl);
}
