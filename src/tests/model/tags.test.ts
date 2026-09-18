/**
 * 卡片标签解析（T6.08 / `F5-07`）的回归。
 *
 * 这条解析链上**没有异常、没有报错**：判错的唯一表现是"平白多出一个栏"
 * 或者"该聚起来的没聚起来"。而那种失败用户只会归咎于"这个功能不准"，
 * 所以每条规则都得在这里钉死。
 *
 * 重点盯三类：
 *  1. **不能乱认**：链接锚点（`#top`）与 Markdown 标题（`## 二级`）天天出现在便签里，
 *     认错了会造出一堆以标题首字命名的栏；
 *  2. **顺序**：一张卡有多个标签时，"第一个"决定它进哪个栏（`columnsByTag` 靠它），
 *     所以标题优先于正文这件事必须被断言；
 *  3. **大小写**：`#Idea` 与 `#idea` 必须落成同一个标签，但**显示**要留用户写的那个写法。
 */

import { describe, expect, it } from 'vitest';
import { createCard } from '../../model/factories';
import { tagKeyOf, tagsInText, tagsOfCard } from '../../model/tags';

function note(title = '', md = '') {
  return createCard('note', { title, content: { md } });
}

describe('tagsInText', () => {
  it('认出空白后 / 行首 / 标点后的标签', () => {
    expect(tagsInText('今天 #工作 和 #生活')).toEqual(['工作', '生活']);
    expect(tagsInText('#行首也认')).toEqual(['行首也认']);
    expect(tagsInText('看这个（#括号）')).toEqual(['括号']);
  });

  it('★ 链接锚点不算标签（`#` 前面必须是边界）', () => {
    // 这两种形态在便签里出现得极频繁，认错了会凭空多出 top / frag 两个栏
    expect(tagsInText('见 https://x.com/#top')).toEqual([]);
    expect(tagsInText('见 https://x.com/a#frag')).toEqual([]);
    // 紧贴着一个字也不行（`a#b` 不是两个东西）
    expect(tagsInText('a#b')).toEqual([]);
  });

  it('★ Markdown 标题不算标签（`#` 后面是空格或另一个 `#`）', () => {
    expect(tagsInText('# 一级标题')).toEqual([]);
    expect(tagsInText('## 二级标题')).toEqual([]);
    expect(tagsInText('### 三级')).toEqual([]);
  });

  it('★ 纯数字不算标签（Obsidian 也不认，而"#2026"几乎总是年份 / 期号）', () => {
    expect(tagsInText('第 #2026 期')).toEqual([]);
    // 含字母或数字以外字符的照认
    expect(tagsInText('#2026年报')).toEqual(['2026年报']);
  });

  it('尾部的 `-` / `/` 是标点，不粘进标签', () => {
    expect(tagsInText('写完了 #项目-')).toEqual(['项目']);
    expect(tagsInText('归到 #工作/')).toEqual(['工作']);
  });

  it('嵌套标签原样保留', () => {
    expect(tagsInText('#项目/子项目')).toEqual(['项目/子项目']);
  });

  it('超长的"标签"被截断：一段粘进来的长文不该把标题撑爆', () => {
    const found = tagsInText(`#${'x'.repeat(200)}`);
    expect(found).toHaveLength(1);
    expect(found[0]).toHaveLength(100);
  });

  it('同一段里的重复标签不去重（去重是 `tagsOfCard` 的活）', () => {
    // 这一层看不见"标题与正文"的边界，在这里去重会丢掉先后信息
    expect(tagsInText('#a #a')).toEqual(['a', 'a']);
  });
});

describe('tagKeyOf', () => {
  it('归一化键只比大小写', () => {
    expect(tagKeyOf('IDEA')).toBe('idea');
    expect(tagKeyOf('Idea')).toBe('idea');
    // 中文不受影响
    expect(tagKeyOf('项目')).toBe('项目');
  });
});

describe('tagsOfCard', () => {
  it('★ 标题里的标签排在正文之前（`columnsByTag` 靠它定归属）', () => {
    // 标题是用户给这张卡下的定义，正文里可能只是随手提了一句
    expect(tagsOfCard(note('#重要', '正文里提了 #工作'))).toEqual(['重要', '工作']);
  });

  it('★ `#Idea` 与 `#idea` 合成一个，显示留第一次出现的写法', () => {
    expect(tagsOfCard(note('', '想了个 #Idea，还有 #idea 和 #其它'))).toEqual(['Idea', '其它']);
  });

  it('待办卡的小项文本也算（与搜索认得的是同一份字段）', () => {
    const todo = createCard('todo', {
      title: '清单',
      content: { items: [{ text: '买牛奶 #采购', done: false }] },
    });
    expect(tagsOfCard(todo)).toEqual(['采购']);
  });

  it('没有标签就是空数组（色板 / 手绘这类没有文本的卡也一样）', () => {
    expect(tagsOfCard(note('', '一句普通的话'))).toEqual([]);
    expect(tagsOfCard(createCard('swatch'))).toEqual([]);
  });
});
