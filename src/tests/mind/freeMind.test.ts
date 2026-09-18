/**
 * 导出 FreeMind（`.mm`，`06 §11.51`）。
 *
 * 这一份钉的是**映射表**：`.mm` 的字段没有几个，每一档"我们的东西落到哪"都在
 * `toFreeMind.ts` 顶上那张表里写着 —— 表与实现对不上时，这里会红。
 *
 * ★ 纯函数（不 import `obsidian`、不碰 DOM）⇒ 跑在 node 环境下即可。
 */

import { describe, expect, it } from 'vitest';
import { createMindFile, createMindNode } from '../../mind/model/factories';
import type { MindFile } from '../../mind/model/schema';
import { mindToFreeMind } from '../../mind/export/toFreeMind';

/** 造一份：`[标题, 正文?, 父标题?]`，`order` 按数组顺序给 */
function mindOf(shape: readonly (readonly [string, string?, string?])[]): MindFile {
  const file = createMindFile({ title: 'T', now: () => 'T' });
  file.nodes = shape.map(([text, note, parentText], index) =>
    createMindNode({
      id: `n_${text}`,
      text,
      note: note ?? '',
      parentId: parentText === undefined ? null : `n_${parentText}`,
      order: index,
    }),
  );
  file.rootId = `n_${shape[0]?.[0] ?? ''}`;
  return file;
}

describe('导出 FreeMind（`N3-h`）', () => {
  it('★ 基本形状：XML 头 + `<map>` + 嵌套 `<node TEXT=… ID=…>`', () => {
    const xml = mindToFreeMind(
      mindOf([
        ['中心', '', undefined],
        ['甲', '', '中心'],
        ['甲1', '', '甲'],
      ]),
    );

    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('<map version="1.0.1">');
    expect(xml.trimEnd().endsWith('</map>')).toBe(true);

    // ★ 父子关系看**缩进**（比按整行字面量去匹配稳：第一层还会多一个 `POSITION`）
    const indentOf = (text: string): number => {
      const line = xml.split('\n').find((item) => item.includes(`TEXT="${text}"`)) ?? '';
      return line.search(/\S/);
    };
    expect(indentOf('甲1')).toBeGreaterThan(indentOf('甲'));
    expect(indentOf('甲')).toBeGreaterThan(indentOf('中心'));
  });

  it('★ 文字要转义（`&` / `<` / `"` 都会把 XML 弄坏）', () => {
    const xml = mindToFreeMind(mindOf([['A & B <c> "d"', '', undefined]]));

    expect(xml).toContain('TEXT="A &amp; B &lt;c&gt; &quot;d&quot;"');
  });

  it('折叠 ⇒ `FOLDED="true"`（`.mm` 里折叠是个**可编辑的状态**，照实导出）', () => {
    const file = mindOf([
      ['中心', '', undefined],
      ['甲', '', '中心'],
    ]);
    const jia = file.nodes.find((node) => node.id === 'n_甲');
    if (jia) jia.collapsed = true;

    expect(mindToFreeMind(file)).toContain('FOLDED="true"');
    expect(mindToFreeMind(mindOf([['中心', '', undefined]]))).not.toContain('FOLDED');
  });

  it('★ `done` / `icon` 都并进 `TEXT`（那边没有这两个字段）', () => {
    const file = mindOf([['甲', '', undefined]]);
    const jia = file.nodes[0];
    if (jia) {
      jia.done = true;
      jia.icon = '🔥';
    }

    expect(mindToFreeMind(file)).toContain('TEXT="✔ 🔥 甲"');
  });

  it('★ 颜色**只在用户设过时才写**（没设过的交给对方的默认观感）', () => {
    const plain = mindToFreeMind(mindOf([['甲', '', undefined]]));
    expect(plain).not.toContain('BACKGROUND_COLOR');

    const file = mindOf([['甲', '', undefined]]);
    const jia = file.nodes[0];
    if (jia) jia.style = { color: '3' };
    const colored = mindToFreeMind(file);
    expect(colored).toContain('BACKGROUND_COLOR="');
    expect(colored).toContain('COLOR="');
  });

  it('★ `POSITION` 只给**第一层**，且优先用调用方给的（布局里的左右）', () => {
    const file = mindOf([
      ['中心', '', undefined],
      ['甲', '', '中心'],
      ['甲1', '', '甲'],
    ]);

    const xml = mindToFreeMind(file, {
      positionOf: (id) => (id === 'n_甲' ? 'left' : null),
    });

    // 第一层写了（用我们给的 left），第二层没写
    expect(xml).toContain('POSITION="left"');
    expect(xml.match(/POSITION=/g)?.length).toBe(1);
  });

  it('★ 关联线 ⇒ `<arrowlink>`；箭头三态照搬（默认那档显式写 `None`）', () => {
    const file = mindOf([
      ['中心', '', undefined],
      ['甲', '', '中心'],
      ['乙', '', '中心'],
    ]);
    file.links = [
      { id: 'l_1', from: 'n_甲', to: 'n_乙', label: '依赖' },
      { id: 'l_2', from: 'n_乙', to: 'n_甲', arrow: 'both' },
    ];

    const xml = mindToFreeMind(file);

    // 没画箭头 ⇒ 两端都写 None（对方的默认是带箭头，不显式说就会平白多一个）
    expect(xml).toContain('<arrowlink DESTINATION="n_乙" STARTARROW="None" ENDARROW="None"/>');
    expect(xml).toContain(
      '<arrowlink DESTINATION="n_甲" STARTARROW="Default" ENDARROW="Default"/>',
    );
    // ★ 标签在 `.mm` 里没有落点（映射表里注明了）—— 别悄悄塞进 TEXT 里
    expect(xml).not.toContain('依赖');
  });

  it('★ 悬浮节点挂在根下（FreeMind 没有"游离节点"，但不能丢内容）', () => {
    const file = mindOf([['中心', '', undefined]]);
    file.nodes.push(
      createMindNode({ id: 'n_自由', text: '自由', note: '', parentId: null, order: 9 }),
    );

    const xml = mindToFreeMind(file);

    // 根与悬浮节点是**同一层**的两个 `<node>`（都挂在 `<map>` 下）
    expect(xml).toMatch(/<map version="1\.0\.1">\n {2}<node TEXT="中心"/);
    expect(xml).toContain('<node TEXT="自由" ID="n_自由"/>');
  });

  it('正文 ⇒ `<richcontent TYPE="NOTE">`，一行一个 `<p>`', () => {
    const xml = mindToFreeMind(mindOf([['甲', '第一行\n第二行', undefined]]));

    expect(xml).toContain('<richcontent TYPE="NOTE">');
    expect(xml).toContain('<p>第一行</p>');
    expect(xml).toContain('<p>第二行</p>');
  });

  it('空正文不写那一段（不留一个空的 `<richcontent>`）', () => {
    expect(mindToFreeMind(mindOf([['甲', '   ', undefined]]))).not.toContain('richcontent');
  });
});
