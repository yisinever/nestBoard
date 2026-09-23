/**
 * `MindBridge` 的两条**约定**（`2.2.0` 批 3 手工验收踩过的两处）。
 *
 * 节点菜单是"白板 → 脑图"这道门上最容易出错的地方：它一边要按**数据源**分支
 * （内嵌 / 文件），一边又要把动作**发回发起它的那个宿主**。这一步用的是
 * `mind/embed/editRequest` 那个一次性请求槽，而槽是**按一个字符串键**取的 ——
 * 键对不上，请求就永远躺在里面没人取：用户看到的是"加完节点，光标没进来"。
 *
 * 这里的键有两个来源：
 *
 * * **白板级脑图**（`MindLayer`）：按**脑图 id** 取（一个 id 只挂一份）；
 * * **老的脑图卡**（`cards/mindRef`）：按**文件路径**取（一张卡就是一个文件）。
 *
 * 所以菜单那一层不能写死任何一个，只能问请求里的 `editKey`。
 */

import { describe, expect, it } from 'vitest';
import { mindEditKeyOf, type MindNodeMenuRequest } from '../../mind/embed/MindBridge';

function request(overrides: Partial<MindNodeMenuRequest> = {}): MindNodeMenuRequest {
  return {
    path: 'Minds/一份脑图.nestmind',
    nodeId: 'n_1',
    event: {} as MouseEvent,
    ...overrides,
  };
}

describe('节点菜单 · "加完节点把光标送进新节点"用哪个键', () => {
  it('★ 渲染方给了 `editKey` 就用它（白板级脑图给的是**脑图 id**）', () => {
    expect(mindEditKeyOf(request({ cardId: 'nm_1', editKey: 'nm_1' }))).toBe('nm_1');
  });

  it('★ 没给就退回 `path`（老脑图卡的行为一字不变）', () => {
    expect(mindEditKeyOf(request({ cardId: 'c_1' }))).toBe('Minds/一份脑图.nestmind');
  });

  it('★ 内嵌脑图**不走这条路**（它用 `inline.requestEdit`，键是卡片 id）', () => {
    // 这条只是把分工写下来：内嵌那条路的键与 `path`（空串）无关，
    // 所以菜单里绝不能把"内嵌"当成"用 path 的那种"
    expect(mindEditKeyOf(request({ path: '', cardId: 'c_1', editKey: 'c_1' }))).toBe('c_1');
  });
});
