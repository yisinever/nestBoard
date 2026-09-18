/**
 * 脑图测试的公共夹具。
 *
 * ★ 直接拼结构、**不经过 `ops`**：被测的就是那些操作函数，用它们搭夹具的话，
 *   它们一坏，整套用例会一起红成一片，反而看不出坏在哪一条。
 */

import { createMindFile, createMindNode } from '../../mind/model/factories';
import type { MindFile, MindNode } from '../../mind/model/schema';
import type { NodeBox } from '../../mind/layout/tree';

/**
 * 按 `[文字, 父文字 | null]` 拼一份脑图。
 *
 * ★ id 直接用 `n_<文字>`，于是断言里写的就是读得懂的东西。
 * ★ 次序按"同一父节点下出现几次"给，与 `validate` 的归一化分组一致
 *   （根与悬浮节点同属 `parentId === null` 那一组）。
 * ★ 第一条就是根（`createMindFile` 造的那个会被换掉）。
 */
export function mindWith(shape: readonly (readonly [string, string | null])[]): MindFile {
  const file = createMindFile({ title: shape[0]?.[0] ?? '中心', now: () => 'T' });
  const counts = new Map<string | null, number>();
  file.nodes = shape.map(([text, parentText]) => {
    const key = parentText === null ? null : `n_${parentText}`;
    const order = counts.get(key) ?? 0;
    counts.set(key, order + 1);
    return createMindNode({ id: `n_${text}`, text, parentId: key, order });
  });
  file.rootId = `n_${shape[0]?.[0] ?? ''}`;
  return file;
}

/**
 * 一个布局盒（只写用例关心的那几个字段）。
 *
 * ★ `depth` 给"最深命中"用；`vertical` 给**纵向布局**（组织结构图）用 ——
 *   线怎么画、手柄朝哪边都看它（横向盒子的 `side` 也都是 1，分不出来）。
 */
export function boxOf(
  id: string,
  x: number,
  y: number,
  options: { width?: number; height?: number; depth?: number; vertical?: boolean } = {},
): NodeBox {
  return {
    id,
    x,
    y,
    width: options.width ?? 100,
    height: options.height ?? 40,
    depth: options.depth ?? 1,
    side: 1,
    free: false,
    ...(options.vertical ? { vertical: true } : {}),
  };
}

/** 取某个节点的文字（断言里读得懂） */
export function textOf(mind: MindFile, id: string): string {
  const node: MindNode | undefined = mind.nodes.find((item) => item.id === id);
  return node?.text ?? '?';
}
