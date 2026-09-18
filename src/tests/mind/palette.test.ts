/**
 * 快捷栏的"**共同值**"（`N2`：框选多个节点统一改样式）。
 *
 * 钉的是那条最容易写错的语义：**全一致才算** —— 任何一项不一致一律给 `fallback`
 * （= 栏上那一格**不亮**）。于是"点一下"自然等于"**全开**"，而不是"各翻各的"。
 */

import { describe, expect, it } from 'vitest';
import { commonTitleStyle, titleBoldOf } from '../../mind/model/palette';
import type { MindNodeStyle } from '../../mind/model/schema';

const node = (style?: MindNodeStyle, depth = 1) => ({ style, depth });

describe('commonTitleStyle（N2）', () => {
  it('全一致 ⇒ 原样给出（加粗取**生效值**：根默认就是加粗的）', () => {
    const common = commonTitleStyle([
      node({ color: '3', italic: true, highlight: '#fff3b0' }, 0),
      node({ color: '3', italic: true, highlight: '#fff3b0' }, 0),
    ]);

    expect(common).toEqual({
      bold: titleBoldOf(0),
      italic: true,
      underline: false,
      color: '3',
      ink: null,
      // 文字高亮（`N3-f`）也走同一套"全一致才算"
      highlight: '#fff3b0',
    });
  });

  it('★ 高亮不一致 ⇒ 那一格不亮（给 `null`）', () => {
    const common = commonTitleStyle([
      node({ highlight: '#fff3b0' }),
      node({ highlight: '#cfe8ff' }),
    ]);

    expect(common?.highlight).toBeNull();
  });

  it('★ 任何一项不一致 ⇒ 那一项给 fallback（`false` / `null` = 那一格不亮）', () => {
    const common = commonTitleStyle([node({ color: '3' }), node({ color: '5' })]);

    expect(common?.color).toBeNull();
    expect(common?.bold).toBe(false);
  });

  it('★ 加粗按**层级**算生效值：根与一层混选 ⇒ 不一致（两者的层级默认不同）', () => {
    // 都没设过 `bold`：根默认加粗、一层默认不加 ⇒ 混合
    expect(commonTitleStyle([node(undefined, 0), node(undefined, 1)])?.bold).toBe(false);
    // 同一个层级、都没设过 ⇒ 一致
    expect(commonTitleStyle([node(undefined, 1), node(undefined, 1)])?.bold).toBe(false);
    expect(commonTitleStyle([node(undefined, 0), node(undefined, 0)])?.bold).toBe(true);
  });

  it('空选区 ⇒ `null`（整条栏收起）', () => {
    expect(commonTitleStyle([])).toBeNull();
  });
});
