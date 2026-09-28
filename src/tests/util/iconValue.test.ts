/**
 * `icon` 字段值解析（用户 2026-09-28 第二种图标）的模型层单测。
 * 渲染进 DOM 的部分在 fake DOM 下只验"清空 / 文本"两条（SVG 形状靠人眼）。
 */

import { describe, expect, it } from 'vitest';

import { PIXEL_ICON_GROUPS } from '../../ui/icons/pixelIcons';
import {
  PIXEL_ICON_PREFIX,
  composePixelIconSvg,
  iconExportText,
  parseIconValue,
  pixelIconSvg,
  pixelIconValue,
  renderIconInto,
} from '../../util/iconValue';
import { createFakeDocument } from '../helpers/fakeDom';

describe('parseIconValue', () => {
  it('emoji 原样保留；空串 = 没有图标', () => {
    expect(parseIconValue('🔴')).toEqual({ kind: 'emoji', text: '🔴' });
    expect(parseIconValue('')).toBeNull();
  });

  it('★ nb: 前缀解析成像素图标；越界编号 = null（手改文件的坏值不会画出半个东西）', () => {
    const first = PIXEL_ICON_GROUPS[0]!.icons[0]!;
    const value = pixelIconValue(first);
    expect(value.startsWith(PIXEL_ICON_PREFIX)).toBe(true);
    expect(parseIconValue(value)).toEqual({ kind: 'pixel', icon: first });
    expect(parseIconValue('nb:9999')).toBeNull();
  });
});

describe('composePixelIconSvg / pixelIconSvg', () => {
  it('★ 网格合成的 SVG：带 crispEdges、每种颜色一条 path、透明格不落笔', () => {
    const icon = PIXEL_ICON_GROUPS[0]!.icons[0]!;
    const svg = composePixelIconSvg(icon);
    expect(svg.startsWith('<svg xmlns')).toBe(true);
    expect(svg).toContain('shape-rendering="crispEdges"');
    expect(svg).toContain('viewBox="0 0 16 16"');
    // 出现在网格里的每个非透明色键都应有一条自己的 path
    const colorKeys = new Set(
      icon.grid
        .join('')
        .split('')
        .filter((ch) => ch !== '.'),
    );
    expect(svg.match(/<path /g)?.length).toBe(colorKeys.size);
  });

  it('pixelIconSvg 带缓存：同一 id 两次给同一串；不认识的 id 给 null', () => {
    const id = PIXEL_ICON_GROUPS[0]!.icons[0]!.id;
    expect(pixelIconSvg(id)).toBe(pixelIconSvg(id));
    expect(pixelIconSvg('9999')).toBeNull();
  });
});

describe('iconExportText（导出侧的 emoji 兜底口径）', () => {
  it('像素图标退回自带 emoji；emoji 原样；认不出 = 空', () => {
    const icon = PIXEL_ICON_GROUPS[0]!.icons[0]!;
    expect(iconExportText(pixelIconValue(icon))).toBe(icon.emoji);
    expect(iconExportText('📌')).toBe('📌');
    expect(iconExportText('nb:9999')).toBe('');
  });
});

describe('renderIconInto（fake DOM）', () => {
  it('emoji 走文本；认不出的值清空（与"没设"一致）', () => {
    const doc = createFakeDocument();
    const el = doc.createElement('span') as unknown as HTMLElement;
    renderIconInto(el, '📌');
    expect(el.textContent).toBe('📌');
    renderIconInto(el, 'nb:9999');
    expect(el.textContent).toBe('');
  });
});
