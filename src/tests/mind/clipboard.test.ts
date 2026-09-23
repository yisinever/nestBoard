/**
 * 子树复制粘贴（`mind/model/clipboard.ts`，P3-b）。
 *
 * 两条最要紧的性质：
 * ① **剪贴板是深拷贝** —— 复制之后接着改原节点（甚至删掉整支），粘贴时读到的必须还是
 *    复制那一刻的样子；
 * ② **粘贴出来的 id 全新、结构照旧** —— id 是身份，重复 id 会让 `validate` 判成坏文件。
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  copyForest,
  copySubtree,
  duplicateNodes,
  getMindClipboard,
  isOwnClipboardText,
  mindClipboardHtml,
  mindClipboardText,
  parseMindClipboardHtml,
  parseOutlineText,
  pasteForest,
  pasteSubtree,
  setMindClipboard,
} from '../../mind/model/clipboard';
import { childrenOf, setCollapsed } from '../../mind/model/ops';
import { boxOf, mindWith } from '../helpers/mindFixtures';

afterEach(() => {
  // 进程内的剪贴板是**共享**的（跨视图），用例之间必须擦干净
  setMindClipboard(null);
});

// ─────────────────────────────────────────────────────────────
// 系统剪贴板的两份行李（`N3-i`：粘贴时按**格式**认亲）
// ─────────────────────────────────────────────────────────────

describe('复制时写进系统剪贴板的两份行李', () => {
  const payload = () => {
    const mind = mindWith([
      ['中心', null],
      ['甲', '中心'],
      ['甲1', '甲'],
      ['乙', '中心'],
    ]);
    const copied = copyForest(mind, ['n_甲', 'n_乙']);
    if (!copied) throw new Error('夹具坏了');
    return copied;
  };

  it('★ `text/plain` 是**人读的缩进文字**（粘到笔记里得到的不是一串 JSON）', () => {
    expect(mindClipboardText(payload())).toBe('- 甲\n  - 甲1\n- 乙');
  });

  it('★ `text/html` 是**真嵌套列表**，根元素上带自家载荷', () => {
    const html = mindClipboardHtml(payload());
    expect(html).toContain('<li>甲<ul><li>甲1</li></ul></li>');
    expect(html).toContain('data-nestboard-mind-nodes=');
  });

  it('★★ 自己写的能**认回来**（往返一致）；外来的 HTML 一概不认', () => {
    const source = payload();
    const back = parseMindClipboardHtml(mindClipboardHtml(source));

    expect(back?.roots).toEqual(source.roots);
    expect(back?.nodes.length).toBe(source.nodes.length);

    // 外来的 / 坏的 ⇒ 一律 null（宁可让浏览器自己粘，也不猜）
    expect(parseMindClipboardHtml('')).toBeNull();
    expect(parseMindClipboardHtml('<ul><li>随便一段文字</li></ul>')).toBeNull();
    expect(parseMindClipboardHtml('<ul data-nestboard-mind-nodes="%7Bbad"></ul>')).toBeNull();
  });

  it('★ 特殊字符（`<` `&` 引号）既不会弄坏 HTML，也不影响认亲', () => {
    const mind = mindWith([
      ['中心', null],
      ['<a & b> "引号"', '中心'],
    ]);
    const copied = copyForest(mind, ['n_<a & b> "引号"']);
    if (!copied) throw new Error('夹具坏了');

    const html = mindClipboardHtml(copied);
    expect(html).toContain('&lt;a &amp; b&gt;');
    // 文字那一面保持原样（它不进 HTML 解析）
    expect(mindClipboardText(copied)).toBe('- <a & b> "引号"');
    // 认回来的仍是同一簇
    expect(parseMindClipboardHtml(html)?.nodes[0]?.text).toBe('<a & b> "引号"');
  });
});

describe('copySubtree', () => {
  it('连子孙一起复制（**含被折叠藏起来的**：收起只是显示状态）', () => {
    const mind = mindWith([
      ['中心', null],
      ['甲', '中心'],
      ['甲一', '甲'],
      ['甲二', '甲'],
      ['乙', '中心'],
    ]);
    setCollapsed(mind, 'n_甲', true);

    const payload = copySubtree(mind, 'n_甲');

    expect(payload?.roots).toEqual(['n_甲']);
    expect(payload?.nodes.map((node) => node.id).sort()).toEqual(['n_甲', 'n_甲一', 'n_甲二']);
  });

  it('★ 深拷贝：复制之后再改原节点，剪贴板里的那一份不受影响', () => {
    const mind = mindWith([
      ['中心', null],
      ['甲', '中心'],
      ['甲一', '甲'],
    ]);
    const payload = copySubtree(mind, 'n_甲');
    if (!payload) throw new Error('复制失败');

    // 改文字 + 给节点挂附件 + 把整支删掉（三种会碰同一批对象的写法）
    const jia = mind.nodes.find((node) => node.id === 'n_甲');
    if (jia) {
      jia.text = '改过了';
      jia.refs = [{ path: 'a.md', kind: 'note' }];
    }
    mind.nodes = mind.nodes.filter((node) => node.parentId !== 'n_甲' && node.id !== 'n_甲');

    const copied = payload.nodes.find((node) => node.id === 'n_甲');
    expect(copied?.text).toBe('甲');
    // 可选键**缺席就不补**：复制那一刻它还没有附件，剪贴板里也不该凭空长出一个空数组
    expect(copied?.refs).toBeUndefined();
    expect(payload.nodes).toHaveLength(2);
  });

  it('节点不存在时返回 `null`（不抛错）', () => {
    const mind = mindWith([['中心', null]]);
    expect(copySubtree(mind, 'n_不存在')).toBeNull();
  });
});

describe('pasteSubtree', () => {
  const payloadOf = (mind: ReturnType<typeof mindWith>, id: string) => {
    const payload = copySubtree(mind, id);
    if (!payload) throw new Error('复制失败');
    return payload;
  };

  it('★ 追加到目标节点的末尾，结构照旧，**id 全新**', () => {
    const mind = mindWith([
      ['中心', null],
      ['甲', '中心'],
      ['甲一', '甲'],
      ['甲二', '甲'],
    ]);
    const payload = payloadOf(mind, 'n_甲');

    const newRootId = pasteSubtree(mind, payload, 'n_中心');

    expect(newRootId).not.toBeNull();
    expect(newRootId).not.toBe('n_甲');
    // 追加在末尾（原来是 [甲]）
    expect(childrenOf(mind, 'n_中心').map((node) => node.text)).toEqual(['甲', '甲']);
    expect(childrenOf(mind, 'n_中心')[1]?.id).toBe(newRootId);
    // 子树结构照旧：新根下面还是两个孩子，文字与次序都不变
    const pasted = childrenOf(mind, newRootId ?? '');
    expect(pasted.map((node) => node.text)).toEqual(['甲一', '甲二']);
    // 原节点一个都没动
    expect(mind.nodes.some((node) => node.id === 'n_甲')).toBe(true);
    // 原来 4 个（中心 + 甲 + 甲一 + 甲二），粘进来 3 个
    expect(mind.nodes).toHaveLength(7);
  });

  it('★ 可选键原样带过（`collapsed` / `style` / `refs`），`free` 一律丢掉', () => {
    const mind = mindWith([
      ['中心', null],
      ['甲', '中心'],
      ['甲一', '甲'],
    ]);
    const jia = mind.nodes.find((node) => node.id === 'n_甲');
    const child = mind.nodes.find((node) => node.id === 'n_甲一');
    if (jia) {
      jia.style = { color: '3' };
      jia.refs = [{ path: 'a.md', kind: 'note' }];
    }
    // 子树里混一个悬浮节点（复制时它也在树里）：粘出来必须落成树上节点
    if (child) child.free = { x: 9, y: 9 };

    const newRootId = pasteSubtree(mind, payloadOf(mind, 'n_甲'), 'n_中心');
    const pasted = mind.nodes.find((node) => node.id === newRootId);
    const pastedChild = mind.nodes.find(
      (node) => node.parentId === newRootId && node.text === '甲一',
    );

    expect(pasted?.style).toEqual({ color: '3' });
    expect(pasted?.refs).toEqual([{ path: 'a.md', kind: 'note' }]);
    expect(pastedChild?.free).toBeUndefined();
  });

  it('粘两次是两棵互不相干的子树（id 不重复）', () => {
    const mind = mindWith([
      ['中心', null],
      ['甲', '中心'],
    ]);
    const payload = payloadOf(mind, 'n_甲');

    const first = pasteSubtree(mind, payload, 'n_中心');
    const second = pasteSubtree(mind, payload, 'n_中心');

    expect(first).not.toBe(second);
    const ids = mind.nodes.map((node) => node.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('粘到"自己这一支"下面会被数据层挡住吗？—— 挡不住，交互层不许这么给', () => {
    // ★ 这条刻意记下来：`pasteSubtree` 只管"接得上"，**不做环检测** ——
    //   挂到自己的后代下会造出一棵环状的树。交互层（`⌘V` 只粘成选中节点的子级，
    //   而剪贴板里的东西是从别处复制的）不会产生这种输入；真要防，该在 `validate` 那一层。
    const mind = mindWith([
      ['中心', null],
      ['甲', '中心'],
    ]);
    const payload = payloadOf(mind, 'n_甲');
    pasteSubtree(mind, payload, 'n_甲');
    // 粘出来的子树挂在 `n_甲` 下 —— 与原来那支并列，不是环
    const pasted = mind.nodes.filter((node) => node.parentId === 'n_甲');
    expect(pasted.map((node) => node.text)).toEqual(['甲']);
  });

  it('空剪贴板 / 父节点不存在 → `null`（不抛错）', () => {
    const mind = mindWith([['中心', null]]);

    expect(pasteSubtree(mind, null, 'n_中心')).toBeNull();
    expect(pasteSubtree(mind, { roots: ['x'], nodes: [] }, 'n_中心')).toBeNull();
    expect(pasteSubtree(mind, { roots: ['x'], nodes: [] }, 'n_不存在')).toBeNull();
  });
});

// ── 一簇（多选，P3-c）───────────────────────────────────────

describe('copyForest（一簇）', () => {
  const tree = () =>
    mindWith([
      ['中心', null],
      ['甲', '中心'],
      ['甲一', '甲'],
      ['乙', '中心'],
      ['乙一', '乙'],
    ]);

  it('★ 散落的几支一起进剪贴板，条目 = 它们的全部后代', () => {
    const mind = tree();

    const payload = copyForest(mind, ['n_甲', 'n_乙一']);

    expect(payload?.roots).toEqual(['n_甲', 'n_乙一']);
    // 条目按**文件顺序**（遍历一遍过筛，不重排）
    expect(payload?.nodes.map((node) => node.id)).toEqual(['n_甲', 'n_甲一', 'n_乙一']);
  });

  it('★ 选中了中心主题 = 复制整张图（不是"整张图 + 每个孩子再来一份"）', () => {
    const mind = tree();

    const payload = copyForest(mind, ['n_中心', 'n_甲', 'n_乙']);

    expect(payload?.roots).toEqual(['n_中心']);
    expect(payload?.nodes).toHaveLength(5);
  });

  it('父子同时选中时只留祖先（子孙已经在它那一支里了）', () => {
    const mind = tree();
    expect(copyForest(mind, ['n_甲', 'n_甲一'])?.roots).toEqual(['n_甲']);
  });

  it('一个有效节点都没有 → `null`', () => {
    const mind = tree();
    expect(copyForest(mind, ['n_幽灵'])).toBeNull();
  });
});

describe('pasteForest（一簇）', () => {
  it('★ 三支粘出来还是三支，结构照旧、id 全新', () => {
    const mind = mindWith([
      ['中心', null],
      ['甲', '中心'],
      ['甲一', '甲'],
      ['乙', '中心'],
      ['乙一', '乙'],
    ]);
    const payload = copyForest(mind, ['n_甲', 'n_乙']);
    if (!payload) throw new Error('复制失败');

    const created = pasteForest(mind, payload, 'n_中心');

    expect(created).toHaveLength(2);
    expect(created).not.toContain('n_甲');
    // 目标下现在有四个孩子：甲、乙 + 粘出来的两支
    expect(childrenOf(mind, 'n_中心')).toHaveLength(4);
    // 粘出来的第一支下面仍挂着它的孩子
    const pasted = childrenOf(mind, created?.[0] ?? '');
    expect(pasted.map((node) => node.text)).toEqual(['甲一']);
    expect(pasted[0]?.parentId).toBe(created?.[0]);
  });

  it('粘到不存在的父下 → `null`', () => {
    const mind = mindWith([['中心', null]]);
    expect(pasteForest(mind, { roots: ['x'], nodes: [] }, 'n_中心')).toBeNull();
  });
});

// ── 原地复制（右键菜单，`08 §2.1`）──────────────────────────

describe('duplicateNodes（原地复制）', () => {
  const tree = () =>
    mindWith([
      ['中心', null],
      ['甲', '中心'],
      ['甲一', '甲'],
      ['乙', '中心'],
    ]);

  it('★ 复制出一支，插在**原节点后面**（不是末尾），子孙跟着走、id 全新', () => {
    const mind = tree();
    const created = duplicateNodes(mind, new Set(['n_甲']));

    expect(created).toHaveLength(1);
    expect(childrenOf(mind, 'n_中心').map((node) => node.text)).toEqual(['甲', '甲', '乙']);
    expect(childrenOf(mind, created[0] ?? '').map((node) => node.text)).toEqual(['甲一']);
    expect(created[0]).not.toBe('n_甲');
  });

  it('★ 多选：各支各复制一份，且**都紧挨着自己**（逆序插入才不会被推走）', () => {
    const mind = mindWith([
      ['中心', null],
      ['甲', '中心'],
      ['乙', '中心'],
      ['丙', '中心'],
    ]);

    duplicateNodes(mind, new Set(['n_甲', 'n_乙']));

    expect(childrenOf(mind, 'n_中心').map((node) => node.text)).toEqual([
      '甲',
      '甲',
      '乙',
      '乙',
      '丙',
    ]);
  });

  it('★ 落点用过中间值之后 `order` 会被规整成 `0..n-1`（不留空洞与小数）', () => {
    const mind = tree();
    duplicateNodes(mind, new Set(['n_甲']));

    expect(childrenOf(mind, 'n_中心').map((node) => node.order)).toEqual([0, 1, 2]);
  });

  it('★ 中心主题与悬浮节点都跳过（"同一个父下"对它们没意义；菜单里也是灰的）', () => {
    const mind = tree();
    const free = mind.nodes.find((node) => node.id === 'n_乙');
    if (free) {
      free.parentId = null;
      free.free = { x: 10, y: 20 };
    }

    expect(duplicateNodes(mind, new Set([mind.rootId]))).toEqual([]);
    expect(duplicateNodes(mind, new Set(['n_乙']))).toEqual([]);
    // 不受影响：树上的那支照样能复制
    expect(duplicateNodes(mind, new Set(['n_甲']))).toHaveLength(1);
  });

  it('一个有效节点都没有 → 空数组（不抛错）', () => {
    const mind = tree();
    expect(duplicateNodes(mind, new Set(['n_幽灵']))).toEqual([]);
  });
});

describe('进程内的剪贴板', () => {
  it('写进去读得出来（跨视图共享一份）', () => {
    expect(getMindClipboard()).toBeNull();
    const mind = mindWith([['中心', null]]);
    setMindClipboard(copySubtree(mind, 'n_中心'));
    expect(getMindClipboard()?.roots).toEqual(['n_中心']);
  });

  it('`boxOf` 夹具没坏（拖拽那套用例与它共用）', () => {
    expect(boxOf('a', 1, 2)).toEqual({
      id: 'a',
      x: 1,
      y: 2,
      width: 100,
      height: 40,
      depth: 1,
      side: 1,
      free: false,
    });
  });
});

// ─────────────────────────────────────────────────────────────
// 从**外部**粘进来的文字（`N3-j`：一行一节点 → 认得出层级）
// ─────────────────────────────────────────────────────────────

describe('parseOutlineText（外部文字 → 层级）', () => {
  it('没有列表标记 ⇒ 一行一个节点、全部平级（散文不该被当成缩进结构）', () => {
    expect(parseOutlineText('第一行\n第二行\n\n第三行')).toEqual([
      { text: '第一行', children: [] },
      { text: '第二行', children: [] },
      { text: '第三行', children: [] },
    ]);
  });

  it('★ Markdown 列表（2 空格缩进）⇒ 建出父子层级，行首标记剥掉', () => {
    const items = parseOutlineText(
      ['- 甲', '  - 甲一', '    - 甲一一', '  - 甲二', '- 乙'].join('\n'),
    );
    expect(items).toEqual([
      {
        text: '甲',
        children: [
          { text: '甲一', children: [{ text: '甲一一', children: [] }] },
          { text: '甲二', children: [] },
        ],
      },
      { text: '乙', children: [] },
    ]);
  });

  it('★ 缩进宽度**不假设**：4 空格、Tab、`1.` / `1)` 序号都认', () => {
    const four = parseOutlineText(['* 甲', '    * 甲一'].join('\n'));
    expect(four[0]?.children.map((child) => child.text)).toEqual(['甲一']);

    const tab = parseOutlineText(['+ 甲', '\t+ 甲一'].join('\n'));
    expect(tab[0]?.children.map((child) => child.text)).toEqual(['甲一']);

    const ordered = parseOutlineText(['1. 甲', '   1) 甲一'].join('\n'));
    expect(ordered[0]?.children.map((child) => child.text)).toEqual(['甲一']);
  });

  it('缩进**变浅**就回到上一层（不是"缩进过就一直往下"）', () => {
    const items = parseOutlineText(['- 甲', '  - 甲一', '- 乙', '  - 乙一'].join('\n'));
    expect(items.map((item) => item.text)).toEqual(['甲', '乙']);
    expect(items[1]?.children.map((child) => child.text)).toEqual(['乙一']);
  });

  it('空行与空的列表项丢掉；整段空白 ⇒ 空数组（调用方据此提示"没东西可粘"）', () => {
    expect(parseOutlineText('   \n\n')).toEqual([]);
    expect(parseOutlineText('- \n- 甲')).toEqual([{ text: '甲', children: [] }]);
  });

  it('列表里夹着散文行 ⇒ 散文按自己的缩进落位', () => {
    const items = parseOutlineText(['- 甲', '  - 甲一', '散文'].join('\n'));
    expect(items.map((item) => item.text)).toEqual(['甲', '散文']);
  });
});

describe('isOwnClipboardText（只拿到纯文本时的认亲）', () => {
  const payload = () => {
    const mind = mindWith([
      ['中心', null],
      ['甲', '中心'],
      ['甲一', '甲'],
    ]);
    const copied = copySubtree(mind, 'n_甲');
    if (!copied) throw new Error('夹具坏了');
    return copied;
  };

  it('与自己写出去的 `text/plain` 一致 ⇒ 认为是"还是那次复制"', () => {
    const copied = payload();
    expect(isOwnClipboardText(copied, mindClipboardText(copied))).toBe(true);
  });

  it('换行 / 行尾空白被改写也认得出来（跨应用往返常发生）', () => {
    const copied = payload();
    const rewritten = mindClipboardText(copied).replace(/\n/g, '\r\n').replace(/甲一/g, '甲一   ');
    expect(isOwnClipboardText(copied, rewritten)).toBe(true);
  });

  it('★ 用户后来复制的**别的东西** ⇒ 不认（这正是那个 bug 的判据）', () => {
    const copied = payload();
    expect(isOwnClipboardText(copied, '一段完全无关的纯文本')).toBe(false);
    expect(isOwnClipboardText(copied, '')).toBe(false);
  });
});
