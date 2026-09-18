/**
 * 嵌入目标解析（T3.16）。
 *
 * "用户到底想嵌哪块板"全靠这个纯函数，而它的输入是**手写文本** —— 空行、`![[…]]`
 * 包装、别名、区块引用、大小写扩展名都会出现。用例逐条钉住这些形态：
 * 解析宽一点，用户少一次"明明写了路径却说没给路径"。
 */

import { describe, expect, it } from 'vitest';
import {
  EMBED_MAX_HEIGHT,
  EMBED_MIN_HEIGHT,
  isBoardPath,
  parseEmbedPath,
  parseEmbedSpec,
} from '../../util/embedTarget';

describe('parseEmbedPath', () => {
  it('裸路径', () => {
    expect(parseEmbedPath('Boards/路线图.nboard')).toBe('Boards/路线图.nboard');
  });

  it('前后空行 / 缩进照吃（代码块里常带空行）', () => {
    expect(parseEmbedPath('\n  Boards/A.nboard  \n')).toBe('Boards/A.nboard');
  });

  it('多行时取第一段非空行', () => {
    expect(parseEmbedPath('\n\nBoards/A.nboard\n随便写的注释\n')).toBe('Boards/A.nboard');
  });

  it('手滑写成 `![[…]]` 也认', () => {
    expect(parseEmbedPath('![[Boards/A.nboard]]')).toBe('Boards/A.nboard');
    expect(parseEmbedPath('[[Boards/A.nboard]]')).toBe('Boards/A.nboard');
  });

  it('剥掉别名（别名让人误会"这不是路径"）', () => {
    expect(parseEmbedPath('Boards/A.nboard|路线图')).toBe('Boards/A.nboard');
  });

  it('剥掉区块引用', () => {
    expect(parseEmbedPath('Boards/A.nboard#小结')).toBe('Boards/A.nboard');
  });

  it('别名与区块同时出现时取更靠前的那个', () => {
    expect(parseEmbedPath('Boards/A.nboard#小结|别名')).toBe('Boards/A.nboard');
  });

  it('没有可用路径时返回 null', () => {
    expect(parseEmbedPath('')).toBeNull();
    expect(parseEmbedPath('   \n  \n')).toBeNull();
    expect(parseEmbedPath('|只有别名')).toBeNull();
  });
});

describe('isBoardPath', () => {
  it('认扩展名，大小写不敏感', () => {
    expect(isBoardPath('Boards/A.nboard')).toBe(true);
    expect(isBoardPath('Boards/A.NBOARD')).toBe(true);
    expect(isBoardPath('  Boards/A.nboard  ')).toBe(true);
  });

  it('别的扩展名不算', () => {
    expect(isBoardPath('notes/A.md')).toBe(false);
    expect(isBoardPath('A.png')).toBe(false);
    expect(isBoardPath('')).toBe(false);
    // 只是名字里有 ".nboard" 不算：必须是结尾
    expect(isBoardPath('A.nboard.bak')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────
// 嵌入规格：`file:` / `height:`（T7.09 / F7-10）
//
// 从这里开始代码块里可以多写两行键值。三件事必须同时成立，缺一都会让
// **存量写法**（裸路径 / `![[…]]`）出现回归：
//   1. 键行认得出（含全角冒号、大小写、前后空格）；
//   2. 不认识的键**忽略**而不是当成路径；
//   3. 裸路径仍然认。
// ─────────────────────────────────────────────────────────────

describe('parseEmbedSpec', () => {
  it('裸路径（老写法）→ 路径照认、高度为"随内容"', () => {
    expect(parseEmbedSpec('Boards/路线图.nboard')).toEqual({
      path: 'Boards/路线图.nboard',
      height: null,
    });
  });

  it('`file:` 键行 → 取出路径（裸路径写法继续并列可用）', () => {
    expect(parseEmbedSpec('file: Boards/路线图.nboard').path).toBe('Boards/路线图.nboard');
    // 大小写不敏感、冒号前后随意空格
    expect(parseEmbedSpec('FILE:Boards/A.nboard').path).toBe('Boards/A.nboard');
    expect(parseEmbedSpec('  file  :  Boards/A.nboard  ').path).toBe('Boards/A.nboard');
  });

  it('★ 全角冒号也收（中文输入法顺手打出来的那个）', () => {
    expect(parseEmbedSpec('file：Boards/A.nboard').path).toBe('Boards/A.nboard');
    expect(parseEmbedSpec('height：480').height).toBe(480);
  });

  it('`height:` → 只读小窗的高度（整数化）', () => {
    expect(parseEmbedSpec('height: 480').height).toBe(480);
    expect(parseEmbedSpec('height: 480.6').height).toBe(481);
  });

  it('两个键一起给 → 各归各的', () => {
    expect(parseEmbedSpec('file: Boards/A.nboard\nheight: 320')).toEqual({
      path: 'Boards/A.nboard',
      height: 320,
    });
  });

  it('`file:` 的值也吃 `![[…]]` 包装、别名、区块引用（与裸路径同一套清理）', () => {
    expect(parseEmbedSpec('file: [[Boards/A.nboard|路线图]]').path).toBe('Boards/A.nboard');
    expect(parseEmbedSpec('file: Boards/A.nboard#小结').path).toBe('Boards/A.nboard');
  });

  it('`height:` 离谱时**夹到可用范围**（不是拒绝整行，也不是照单全收）', () => {
    // 照 100000 去建画布会当场把内存打爆；用户写它是想要"高一点"，不是"报错"
    expect(parseEmbedSpec(`height: ${EMBED_MAX_HEIGHT * 10}`).height).toBe(EMBED_MAX_HEIGHT);
    expect(parseEmbedSpec('height: 1').height).toBe(EMBED_MIN_HEIGHT);
  });

  it('`height:` 没写成（空 / 非数字 / 0 / 负数）→ 退回"随内容"，不报错', () => {
    for (const source of ['height:', 'height: abc', 'height: 0', 'height: -100']) {
      expect(parseEmbedSpec(source).height).toBeNull();
    }
  });

  it('★ 不认识的键直接忽略，且**不会**被当成路径', () => {
    // 宽进严出：多写一行不该让整块嵌入去查一个叫 "mode:" 的白板
    const spec = parseEmbedSpec('mode: readonly\nBoards/A.nboard');
    expect(spec).toEqual({ path: 'Boards/A.nboard', height: null });
  });

  it('路径只认第一处（后面再写一个路径行不会覆盖已认到的）', () => {
    expect(parseEmbedSpec('file: Boards/A.nboard\nBoards/B.nboard').path).toBe('Boards/A.nboard');
  });

  it('`file:` 的值是空的 → 还能被后面的裸路径救回来', () => {
    expect(parseEmbedSpec('file:\nBoards/A.nboard').path).toBe('Boards/A.nboard');
  });

  it('什么都没给 → 路径为 null（渲染层据此显示"没有给出白板路径"）', () => {
    expect(parseEmbedSpec('height: 480')).toEqual({ path: null, height: 480 });
  });
});

describe('parseEmbedPath × parseEmbedSpec 的关系', () => {
  it('前者就是后者的 `path`（一条实现，两处出口）', () => {
    const source = 'file: Boards/A.nboard\nheight: 300';
    expect(parseEmbedPath(source)).toBe(parseEmbedSpec(source).path);
  });
});
