/**
 * 引用卡「定位到某一处」（T7.10 / `F10-07`）的纯逻辑。
 *
 * 这里钉的是三件互相咬合的事：
 *  1. `parseNoteRefTarget`：`subpath` 文本 ↔ 目标的**翻译**。认不出来一律当"整篇"，
 *     绝不报错 —— 手改过的文件、别的工具写的 `#随便什么东西` 都会走到这条路；
 *  2. `listNoteRefAnchors`：菜单里能列出的候选。关键是标题要写成**完整层级链**
 *     （`#父#子`），否则同名子标题会互相指错；
 *  3. `sliceBySubpath`：真正切出来的那一段。**切不到时返回整篇 + `found: false`**，
 *     而不是空串 —— 这是"源笔记被改过"时卡面还看得见东西的唯一保证。
 *
 * 纯逻辑，跑在 node 下（无 DOM、无 obsidian）。
 */

import { describe, expect, it } from 'vitest';
import { listNoteRefAnchors, parseNoteRefTarget, sliceBySubpath } from '../../cards/noteRef';

const NOTE = [
  '---',
  'tags: [a]',
  '---',
  '',
  '# 项目',
  '',
  '项目总述。',
  '',
  '## 背景',
  '',
  '行业背景第一行。',
  '行业背景第二行。',
  '',
  '### 细节',
  '',
  '细节正文。',
  '',
  '## 目标',
  '',
  '目标正文。',
  '',
  '# 附录',
  '',
  '附录正文。',
  '',
  '这一段里有块标记。 ^blk1',
  '同一块的续行。',
  '',
  '独立的一段。',
].join('\n');

describe('parseNoteRefTarget —— 文本 → 目标', () => {
  it('缺省 / 空串 / 不以 # 开头 → 整篇', () => {
    expect(parseNoteRefTarget(null)).toEqual({ kind: 'whole' });
    expect(parseNoteRefTarget(undefined)).toEqual({ kind: 'whole' });
    expect(parseNoteRefTarget('')).toEqual({ kind: 'whole' });
    expect(parseNoteRefTarget('  ')).toEqual({ kind: 'whole' });
    expect(parseNoteRefTarget('随便什么')).toEqual({ kind: 'whole' });
  });

  it('单个 # → 整篇（看不出想指哪一段）', () => {
    expect(parseNoteRefTarget('#')).toEqual({ kind: 'whole' });
    expect(parseNoteRefTarget('#   ')).toEqual({ kind: 'whole' });
    expect(parseNoteRefTarget('##')).toEqual({ kind: 'whole' });
  });

  it('#标题 → heading；前后空白被吃掉', () => {
    expect(parseNoteRefTarget('# 背景 ')).toEqual({ kind: 'heading', levels: ['背景'] });
  });

  it('#父#子 → 完整层级链', () => {
    expect(parseNoteRefTarget('#项目#背景')).toEqual({
      kind: 'heading',
      levels: ['项目', '背景'],
    });
    // 链里的空段（`#项目##背景`）当没写，别生成一个永远匹配不上的空标题
    expect(parseNoteRefTarget('#项目##背景')).toEqual({
      kind: 'heading',
      levels: ['项目', '背景'],
    });
  });

  it('#^块id → block；`#^` 后面什么都没有则退回整篇', () => {
    expect(parseNoteRefTarget('#^blk1')).toEqual({ kind: 'block', id: 'blk1' });
    expect(parseNoteRefTarget('#^ blk1 ')).toEqual({ kind: 'block', id: 'blk1' });
    expect(parseNoteRefTarget('#^')).toEqual({ kind: 'whole' });
    expect(parseNoteRefTarget('#^   ')).toEqual({ kind: 'whole' });
  });
});

describe('listNoteRefAnchors —— 菜单候选', () => {
  it('第一项永远是「整篇笔记」', () => {
    const anchors = listNoteRefAnchors(NOTE);
    expect(anchors[0]).toEqual({ subpath: null, kind: 'whole', label: '', level: 0 });
  });

  it('frontmatter 内的 # 不算标题', () => {
    const anchors = listNoteRefAnchors('---\ntitle: # 假的\n---\n\n# 真的\n');
    expect(anchors.map((a) => a.subpath)).toEqual([null, '#真的']);
  });

  it('标题写成完整层级链，不是单独的标题名', () => {
    const anchors = listNoteRefAnchors(NOTE);
    expect(anchors.filter((a) => a.kind === 'heading').map((a) => a.subpath)).toEqual([
      '#项目',
      '#项目#背景',
      '#项目#背景#细节',
      '#项目#目标',
      '#附录',
    ]);
  });

  it('跳级时用空串占位，层级数不缩水', () => {
    // `#` 之后直接 `###`：Obsidian 靠"层级数量 + 逐级匹配"定位，
    // 补空串是为了让 `#a##c` 的段数与实际深度一致
    const anchors = listNoteRefAnchors('# A\n\n### C\n');
    const c = anchors.find((a) => a.label === 'C');
    expect(c?.subpath).toBe('#A##C');
    expect(c?.level).toBe(3);
  });

  it('标题文本剥掉行内 Markdown（`## **粗**` → `粗`）', () => {
    const anchors = listNoteRefAnchors('# 顶\n\n## **背景**\n');
    expect(anchors.some((a) => a.label === '背景')).toBe(true);
  });

  it('带块 id 的行按正文顺序列出；块标记必须在行尾', () => {
    const anchors = listNoteRefAnchors('第一段 ^blk1\n\n这是 3^2 不是块\n\n另一段 ^blk2\n');
    expect(anchors.filter((a) => a.kind === 'block')).toEqual([
      { subpath: '#^blk1', kind: 'block', label: 'blk1', level: 0 },
      { subpath: '#^blk2', kind: 'block', label: 'blk2', level: 0 },
    ]);
  });

  it('同名同级标题各列一项（已知取舍：指向同一个位置）', () => {
    const anchors = listNoteRefAnchors('# A\n\n## 同名\n\n## 同名\n');
    expect(anchors.filter((a) => a.label === '同名')).toHaveLength(2);
    expect(anchors.filter((a) => a.label === '同名').every((a) => a.subpath === '#A#同名')).toBe(
      true,
    );
  });
});

describe('sliceBySubpath —— 切出要显示的那一段', () => {
  it('整篇 → 原文原样，found 为真', () => {
    expect(sliceBySubpath(NOTE, null)).toEqual({ markdown: NOTE, found: true });
    expect(sliceBySubpath(NOTE, '看不懂的东西').found).toBe(true);
  });

  it('标题段：切到下一个同级或更高级标题之前', () => {
    const slice = sliceBySubpath(NOTE, '#项目#背景');
    expect(slice.found).toBe(true);
    expect(slice.markdown).toContain('## 背景');
    expect(slice.markdown).toContain('### 细节');
    expect(slice.markdown).toContain('细节正文。');
    // `## 目标` 与 `# 附录` 都不该进来（同级 / 更高级）
    expect(slice.markdown).not.toContain('目标正文。');
    expect(slice.markdown).not.toContain('附录正文。');
  });

  it('叶子标题一直切到同级标题为止', () => {
    const slice = sliceBySubpath(NOTE, '#项目#目标');
    expect(slice.markdown).toContain('目标正文。');
    expect(slice.markdown).not.toContain('附录正文。');
  });

  it('顶层标题切到下一个顶层标题为止', () => {
    const slice = sliceBySubpath(NOTE, '#项目');
    expect(slice.markdown).toContain('项目总述。');
    expect(slice.markdown).toContain('细节正文。');
    expect(slice.markdown).not.toContain('附录正文。');
  });

  it('层级链中间断了 → 整篇 + found: false', () => {
    // `#项目#不存在` 里第二级匹配不上，但 `#项目` 本身是存在的 —— 仍然算"切不到"
    const slice = sliceBySubpath(NOTE, '#项目#不存在');
    expect(slice.found).toBe(false);
    expect(slice.markdown).toBe(NOTE);
  });

  it('标题完全不存在 → 整篇 + found: false', () => {
    const slice = sliceBySubpath(NOTE, '#没这标题');
    expect(slice.found).toBe(false);
    expect(slice.markdown).toBe(NOTE);
  });

  it('块：取整段连续非空行，并剥掉行尾的 ^id 标记', () => {
    const slice = sliceBySubpath(NOTE, '#^blk1');
    expect(slice.found).toBe(true);
    expect(slice.markdown).toBe('这一段里有块标记。\n同一块的续行。');
    // `^blk1` 是给人认的标记，不该出现在卡面上
    expect(slice.markdown).not.toContain('^blk1');
  });

  it('块 id 不存在 → 整篇 + found: false', () => {
    const slice = sliceBySubpath(NOTE, '#^没有这个块');
    expect(slice.found).toBe(false);
    expect(slice.markdown).toBe(NOTE);
  });

  it('块落在清单里 → 整张清单一起带走（刻意的取舍）', () => {
    const list = '- 第一条\n- 第二条 ^item\n- 第三条\n';
    expect(sliceBySubpath(list, '#^item').markdown).toBe('- 第一条\n- 第二条\n- 第三条');
  });

  it('空行是段落边界：不会把上下两段粘成一段', () => {
    const two = '第一段。 ^a\n\n第二段。\n';
    expect(sliceBySubpath(two, '#^a').markdown).toBe('第一段。');
  });

  it('找不到块标记时不会把"靠近的一句"当成命中', () => {
    // `^` 在正文中间（`3^2`）不是块标记 —— 否则会莫名其妙定位到那一段
    const weird = '计算 3^2 得到 9。\n';
    expect(sliceBySubpath(weird, '#^2').found).toBe(false);
  });

  it('CRLF 文件也能切', () => {
    const crlf = '# A\r\n\r\n正文 ^b\r\n';
    expect(sliceBySubpath(crlf, '#^b').markdown).toBe('正文');
  });
});
