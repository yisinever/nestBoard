/**
 * 节点引用（`mind/model/refs.ts`，`06 §4.1` 的 `B`）。
 *
 * 这里钉四件事：**类型是按扩展名推出来的**、**一个节点一个附件**（多个文件取第一个、
 * 被舍掉的条数要如实报出来）、**名字是文件名**、**宽度算不算"变了"**。
 */

import { describe, expect, it } from 'vitest';
import {
  MIND_IMAGE_DEFAULT_WIDTH,
  MIND_IMAGE_MAX_WIDTH,
  MIND_IMAGE_MIN_WIDTH,
  firstRefOf,
  pickRef,
  refKindOfPath,
  refLabelOf,
  sameRef,
  sameRefs,
} from '../../mind/model/refs';
import { createMindNode } from '../../mind/model/factories';
import { parseDropPaths } from '../../model/drop';
import type { MindRef } from '../../mind/model/schema';

describe('refKindOfPath', () => {
  it('图片扩展名 → `image`（大小写不敏感）', () => {
    for (const path of ['a/图.png', 'b/照片.JPG', 'c/矢量.svg', 'd/x.webp']) {
      expect(refKindOfPath(path)).toBe('image');
    }
  });

  it('`.md` → `note`；其余 → `file`', () => {
    expect(refKindOfPath('笔记/方案.md')).toBe('note');
    expect(refKindOfPath('资源/表.xlsx')).toBe('file');
    expect(refKindOfPath('没有扩展名')).toBe('file');
  });

  it('目录名里的点不算扩展名', () => {
    expect(refKindOfPath('v1.2/说明')).toBe('file');
  });
});

describe('refLabelOf', () => {
  it('只给**文件名**（回形针悬停、提示语都用它）', () => {
    expect(refLabelOf('assets/深层/图.png')).toBe('图.png');
    expect(refLabelOf('无目录.md')).toBe('无目录.md');
  });
});

describe('pickRef（一个节点一个附件）', () => {
  it('多个文件一起拖进来：取第一个，其余条数如实报出来', () => {
    const { ref, extras } = pickRef(['a.png', 'b.md', 'c.pdf']);

    expect(ref).toEqual({ kind: 'image', path: 'a.png' });
    expect(extras).toBe(2);
  });

  it('空路径 / 纯空白先丢掉再取第一个（拖拽文本里混着空行是常事）', () => {
    const { ref, extras } = pickRef(['', '   ', '  ok.md  ']);

    expect(ref).toEqual({ kind: 'note', path: 'ok.md' });
    expect(extras).toBe(0);
  });

  it('一条可用路径都没有 → `ref` 为 `null`（调用方什么都不做）', () => {
    expect(pickRef([]).ref).toBeNull();
    expect(pickRef(['  ']).ref).toBeNull();
  });
});

describe('firstRefOf', () => {
  it('没挂东西 → `null`；挂了多条也**只认第一条**', () => {
    const refs: MindRef[] = [
      { kind: 'image', path: 'a.png' },
      { kind: 'note', path: 'b.md' },
    ];

    expect(firstRefOf(createMindNode({ text: '甲' }))).toBeNull();
    expect(firstRefOf(createMindNode({ text: '甲', refs }))?.path).toBe('a.png');
  });
});

describe('sameRef / sameRefs', () => {
  it('路径或类型不同就是不同', () => {
    expect(sameRef({ kind: 'note', path: 'a.md' }, { kind: 'note', path: 'a.md' })).toBe(true);
    expect(sameRef({ kind: 'file', path: 'a.md' }, { kind: 'note', path: 'a.md' })).toBe(false);
    expect(sameRef({ kind: 'note', path: 'a.md' }, { kind: 'note', path: 'b.md' })).toBe(false);
  });

  it('★ **宽度也算**：不然"把图片拉大一点"会被判成没改，`⌘Z` 退不回去', () => {
    const small: MindRef = { kind: 'image', path: 'a.png', width: 200 };
    const big: MindRef = { kind: 'image', path: 'a.png', width: 320 };

    expect(sameRef(small, big)).toBe(false);
    expect(sameRef(small, { kind: 'image', path: 'a.png', width: 200 })).toBe(true);
    // 缺席与 `undefined` 是一回事（可选键的老规矩）
    expect(sameRef(small, { kind: 'image', path: 'a.png' })).toBe(false);
    expect(sameRef({ kind: 'image', path: 'a.png' }, { kind: 'image', path: 'a.png' })).toBe(true);
  });

  it('`null` 与"没有"是一回事', () => {
    expect(sameRef(null, undefined)).toBe(true);
    expect(sameRef(null, { kind: 'note', path: 'a.md' })).toBe(false);
  });

  it('列表版逐条比（`ops.setRefs` 用它判"真的改了吗"）', () => {
    expect(sameRefs([{ kind: 'note', path: 'a.md' }], [{ kind: 'note', path: 'a.md' }])).toBe(true);
    expect(sameRefs([{ kind: 'note', path: 'a.md' }], [])).toBe(false);
    expect(sameRefs(undefined, [])).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// 拖拽文本 → 路径：**借白板那份解析**（`model/drop.ts` 的 `parseDropPaths`）
//
// ★ 为什么在这里钉一条"别人的函数"：脑图的拖入**依赖**它认识 Obsidian 文件浏览器
//   给的那种形态（`obsidian://open?file=…`）。曾经自己写了一份"按行当路径"的解析，
//   症状就是**环圈住了、松手没反应**（真实报障）。这条用例是那个依赖的**合同**：
//   哪天有人把那份解析改得不认这种形态了，这里会先炸。
// ─────────────────────────────────────────────────────────────

describe('拖拽文本解析（脑图借白板那份）', () => {
  it('★ 文件浏览器给的是 `obsidian://open?file=…`（**不是裸路径**）', () => {
    expect(parseDropPaths('obsidian://open?file=notes%2F%E7%94%B2.md')).toEqual(['notes/甲.md']);
  });

  it('wikilink / markdown 链接 / 裸路径都认', () => {
    expect(parseDropPaths('![[附件/图.png]]')).toEqual(['附件/图.png']);
    // wikilink 的 `#小节` 与 `|别名` 要切掉（先出现的那个）
    expect(parseDropPaths('[[笔记#小节|别名]]')).toEqual(['笔记']);
    // markdown 链接目标是 URI 编码的，要解码
    expect(parseDropPaths('[图](assets/a%20b.png)')).toEqual(['assets/a b.png']);
    expect(parseDropPaths('Notes/甲.md')).toEqual(['Notes/甲.md']);
  });
});

describe('图片宽度的上下限', () => {
  it('默认值落在上下限之间（否则新挂的图一上来就要被夹）', () => {
    expect(MIND_IMAGE_DEFAULT_WIDTH).toBeGreaterThanOrEqual(MIND_IMAGE_MIN_WIDTH);
    expect(MIND_IMAGE_DEFAULT_WIDTH).toBeLessThanOrEqual(MIND_IMAGE_MAX_WIDTH);
  });
});
