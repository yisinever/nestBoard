/**
 * 节点快捷操作栏（`08 §3`）。
 *
 * 它只认回调与"现在是什么"，所以在假 DOM 下能把**契约**逐条测掉：
 * 点 B 叫了谁、多选时整条藏没藏、只读时整排灰没灰、弹层里有哪些档。
 * （真"点了之后模型变没变"由 `ops` 的用例盯着 —— 两层分开测，才不会写成一坨。）
 */

import { describe, expect, it } from 'vitest';
import {
  MIND_TITLE_INKS,
  buildNodeToolbar,
  type NodeToolbarState,
  type QuickBarFeature,
} from '../../ui/QuickBar';
import { EMOJI_CHOICES, EMOJI_GROUPS } from '../../util/emoji';
import { THEME_COLOR_OPTIONS } from '../../util/color';
import { t } from '../../util/i18n';
import { createFakeDocument } from '../helpers/fakeDom';
import { asEl, childrenOf, findAllByClass, mustFind } from '../helpers/fakeQuery';

const doc = () => createFakeDocument() as unknown as Document;

const NODE: NonNullable<NodeToolbarState['node']> = {
  id: 'n_甲',
  icon: '',
  bold: false,
  italic: false,
  underline: false,
  color: null,
  ink: null,
  highlight: null,
};

interface Setup {
  root: ReturnType<typeof asEl>;
  calls: string[];
  setState: (state: NodeToolbarState) => void;
  toolbar: ReturnType<typeof buildNodeToolbar>;
}

function setup(): Setup {
  const calls: string[] = [];
  const toolbar = buildNodeToolbar(doc(), {
    onIcon: (icon) => calls.push(`icon:${icon}`),
    onBold: () => calls.push('bold'),
    onItalic: () => calls.push('italic'),
    onUnderline: () => calls.push('underline'),
    onColor: (color) => calls.push(`color:${String(color)}`),
    onInk: (ink) => calls.push(`ink:${String(ink)}`),
    onHighlight: (highlight) => calls.push(`highlight:${String(highlight)}`),
    onEditNote: () => calls.push('note'),
    onInsertImage: () => calls.push('image'),
    onLink: () => calls.push('link'),
    resolveTheme: () => '#123456',
  });
  return {
    root: asEl(toolbar.element),
    calls,
    toolbar,
    setState: (state) => toolbar.setState(state),
  };
}

// ─────────────────────────────────────────────────────────────
// 按钮集（`features`）：这条栏要同时伺候便签与白板卡
// ─────────────────────────────────────────────────────────────

describe('按钮集（`features`）', () => {
  /** 现在**画出来的**按钮（按 class 认人；特性集里没有的带 `is-hidden`） */
  const shown = (root: ReturnType<typeof asEl>): string[] =>
    [
      'is-icon',
      'is-bold',
      'is-italic',
      'is-underline',
      'is-ink',
      'is-color',
      'is-note',
      'is-image',
      'is-link',
    ].filter((name) => !mustFind(root, name).classList.contains('is-hidden'));

  it('不给 `features` = 全都画（脑图那条线的老样子；`N1-b` 之后是九格）', () => {
    const { root, setState } = setup();
    setState({ node: NODE, writable: true });

    expect(shown(root)).toHaveLength(9);
  });

  it('★ 白板卡那一组：只有 标记 / 底色 / 编辑标题（B I U 与字色**不画**）', () => {
    const { root, setState } = setup();
    const features = new Set<QuickBarFeature>(['icon', 'color', 'editNote']);
    setState({ node: NODE, writable: true, features });

    expect(shown(root)).toEqual(['is-icon', 'is-color', 'is-note']);
  });

  it('★ 两组都空时**两条分隔线也不画**（否则剩一道没来由的竖线）', () => {
    const { root, setState } = setup();
    const features = new Set<QuickBarFeature>(['icon', 'editNote']);
    setState({ node: NODE, writable: true, features });

    const seps = findAllByClass(root, 'nestboard-mind-toolbar__sep');
    expect(seps.length).toBeGreaterThan(0);
    expect(seps.every((sep) => sep.classList.contains('is-hidden'))).toBe(true);
  });

  it('★ `editLabel` 换掉最后那个按钮的名字（便签「编辑内容」/ 白板卡「编辑标题」）', () => {
    const { root, setState } = setup();
    setState({ node: NODE, writable: true, editLabel: 'menu.card.editTitle' });
    expect(mustFind(root, 'is-note').getAttribute('aria-label')).toBe(t('menu.card.editTitle'));

    // 不给就回到缺省（同一条栏先显示白板卡、再显示便签时，名字必须跟着换回去）
    setState({ node: NODE, writable: true });
    expect(mustFind(root, 'is-note').getAttribute('aria-label')).toBe(t('mind.toolbar.editNote'));
  });

  it('★ `openIconPicker`：从别处直接把标记弹层打开（白板卡右键菜单那一项用它）', () => {
    const { root, setState, toolbar } = setup();

    // 没选中 / 只读：开不了 —— 调用方据此退回旧的选择器，所以**必须**是 false 而不是抛错
    setState({ node: null, writable: true });
    expect(toolbar.openIconPicker()).toBe(false);
    setState({ node: NODE, writable: false });
    expect(toolbar.openIconPicker()).toBe(false);

    // 正常：打开，且里面**就是那套分组**（与点按钮打开的是同一个弹层）
    setState({ node: NODE, writable: true });
    expect(toolbar.openIconPicker()).toBe(true);
    const popover = mustFind(root, 'nestboard-mind-toolbar__popover');
    expect(popover.classList.contains('is-open')).toBe(true);
    expect(findAllByClass(popover, 'nestboard-mind-toolbar__group')).toHaveLength(
      EMOJI_GROUPS.length,
    );
  });

  it('★ 多选那一组（`MULTI_NODE_FEATURES`）：**没有**连线那一格', () => {
    const { root, setState } = setup();
    // 多选时栏上画的是这一组（`MindView`）—— 连线的起点必须是明确的"这一个"
    const features = new Set<QuickBarFeature>(['bold', 'italic', 'underline', 'ink', 'color']);
    setState({ node: NODE, writable: true, features });

    expect(shown(root)).not.toContain('is-link');
  });

  it('按钮集不改变"能点不能点"：只读时**画出来的**那些仍然全灰', () => {
    const { root, setState } = setup();
    const features = new Set<QuickBarFeature>(['icon', 'color', 'editNote']);
    setState({ node: NODE, writable: false, features });

    for (const name of shown(root)) {
      expect(mustFind(root, name).classList.contains('is-disabled')).toBe(true);
    }
  });
});

describe('快捷操作栏', () => {
  it('★ 没有选中节点时整条藏起来；选中一个才出现', () => {
    const { root, setState } = setup();

    setState({ node: null, writable: true });
    expect(root.classList.contains('is-hidden')).toBe(true);

    setState({ node: NODE, writable: true });
    expect(root.classList.contains('is-hidden')).toBe(false);
  });

  it('★ 加粗 / 斜体 / 下划线 / 编辑内容 / 插入图片：各叫各的回调', () => {
    const { root, calls, setState } = setup();
    setState({ node: NODE, writable: true });

    mustFind(root, 'is-bold').emit('click', {});
    mustFind(root, 'is-italic').emit('click', {});
    mustFind(root, 'is-underline').emit('click', {});
    mustFind(root, 'is-note').emit('click', {});
    mustFind(root, 'is-image').emit('click', {});

    expect(calls).toEqual(['bold', 'italic', 'underline', 'note', 'image']);
  });

  it('★ 三个开关的按下态跟着节点走（`bold` 是**生效值**：根节点默认就是按下的）', () => {
    const { root, setState } = setup();

    setState({ node: { ...NODE, bold: true, italic: true }, writable: true });
    expect(mustFind(root, 'is-bold').classList.contains('is-active')).toBe(true);
    expect(mustFind(root, 'is-italic').classList.contains('is-active')).toBe(true);
    expect(mustFind(root, 'is-underline').classList.contains('is-active')).toBe(false);

    setState({ node: NODE, writable: true });
    expect(mustFind(root, 'is-bold').classList.contains('is-active')).toBe(false);
  });

  it('★ 只读时整排置灰（点了也不叫回调）', () => {
    const { root, calls, setState } = setup();
    setState({ node: NODE, writable: false });

    for (const button of findAllByClass(root, 'nestboard-mind-toolbar__button')) {
      expect(button.classList.contains('is-disabled')).toBe(true);
    }
    mustFind(root, 'is-bold').emit('click', {});
    expect(calls).toEqual(['bold']);
  });

  it('★ 标记弹层：按分组摆出全部候选 + 清除项', () => {
    const { root, setState } = setup();
    setState({ node: NODE, writable: true });

    mustFind(root, 'is-icon').emit('click', {});
    const popover = mustFind(root, 'nestboard-mind-toolbar__popover');
    expect(popover.classList.contains('is-open')).toBe(true);

    const emojis = findAllByClass(popover, 'nestboard-mind-toolbar__emoji');
    // 每一组的候选都在（顺序 = `EMOJI_GROUPS` 的顺序）——这一条把"数据只有一份"钉住
    expect(emojis.map((button) => button.textContent)).toEqual([...EMOJI_CHOICES]);
    expect(findAllByClass(popover, 'nestboard-mind-toolbar__group')).toHaveLength(
      EMOJI_GROUPS.length,
    );
    // ★ 断言走 `t()` 而不是写死中文：文案是**语言相关**的，钉住中文会让英文环境下
    //   这条用例莫名其妙地红（而它要钉的是"有个清除项"，不是那句话怎么写）
    expect(mustFind(popover, 'nestboard-mind-toolbar__clear').textContent).toBe(
      t('mind.toolbar.clearMark'),
    );
  });

  it('★ 挑一个标记：回调带上那个 emoji，并收起弹层', () => {
    const { root, calls, setState } = setup();
    setState({ node: NODE, writable: true });
    mustFind(root, 'is-icon').emit('click', {});

    const first = findAllByClass(root, 'nestboard-mind-toolbar__emoji')[0];
    first?.emit('click', {});

    // ★ 断言"清单里的第一个"而不是写死某个 emoji：分组是按用途排的，
    //   哪天调整顺序（或换一套清单），这条用例不该跟着红 —— 它要钉的是
    //   "点哪一个就回哪一个"，不是"第一个是 📌"
    expect(calls).toEqual([`icon:${EMOJI_CHOICES[0]}`]);
    expect(mustFind(root, 'nestboard-mind-toolbar__popover').classList.contains('is-open')).toBe(
      false,
    );
  });

  it('★ 清除标记传的是**空串**（`ops.setIcon` 那边据此删键）', () => {
    const { root, calls, setState } = setup();
    setState({ node: { ...NODE, icon: '🔥' }, writable: true });
    mustFind(root, 'is-icon').emit('click', {});

    mustFind(root, 'nestboard-mind-toolbar__clear').emit('click', {});
    expect(calls).toEqual(['icon:']);
  });

  it('标记按钮上显示当前那个 emoji（没标记时是一个中性脸）', () => {
    const { root, setState } = setup();

    setState({ node: NODE, writable: true });
    expect(mustFind(root, 'is-icon').textContent).toBe('🙂');

    setState({ node: { ...NODE, icon: '🔥' }, writable: true });
    expect(mustFind(root, 'is-icon').textContent).toBe('🔥');
  });

  it('★ 底色弹层：6 个主题色（画成主题里的真色）+ 默认；挑一个回调带**编号**', () => {
    const { root, calls, setState } = setup();
    setState({ node: NODE, writable: true });
    mustFind(root, 'is-color').emit('click', {});

    const swatches = findAllByClass(root, 'nestboard-mind-toolbar__swatch');
    expect(swatches).toHaveLength(THEME_COLOR_OPTIONS.length);
    // 色块画的是注入进来的主题真色（不是近似表）
    expect(swatches[0]?.style.background).toBe('#123456');

    swatches[2]?.emit('click', {});
    expect(calls).toEqual([`color:${THEME_COLOR_OPTIONS[2]}`]);
  });

  it('★ 字色弹层：只给几个色块（含白，深底才读得清）+ 默认', () => {
    const { root, calls, setState } = setup();
    setState({ node: NODE, writable: true });
    mustFind(root, 'is-ink').emit('click', {});

    const swatches = findAllByClass(root, 'nestboard-mind-toolbar__swatch');
    expect(swatches).toHaveLength(MIND_TITLE_INKS.length);
    expect(MIND_TITLE_INKS).toContain('#ffffff');

    swatches[1]?.emit('click', {});
    expect(calls).toEqual(['ink:#ffffff']);
  });

  it('★ 换节点 / 变只读时把弹层收掉（留一个"上一个人的色块"会点错）', () => {
    const { root, setState } = setup();
    setState({ node: NODE, writable: true });
    mustFind(root, 'is-color').emit('click', {});
    expect(findAllByClass(root, 'nestboard-mind-toolbar__swatch')).toHaveLength(
      THEME_COLOR_OPTIONS.length,
    );

    setState({ node: { ...NODE, id: 'n_乙' }, writable: true });
    expect(findAllByClass(root, 'nestboard-mind-toolbar__swatch')).toHaveLength(0);
  });

  it('再点同一个按钮 = 收起弹层（不用点别处）', () => {
    const { root, setState } = setup();
    setState({ node: NODE, writable: true });

    mustFind(root, 'is-icon').emit('click', {});
    expect(findAllByClass(root, 'nestboard-mind-toolbar__emoji').length).toBeGreaterThan(0);
    mustFind(root, 'is-icon').emit('click', {});
    expect(findAllByClass(root, 'nestboard-mind-toolbar__emoji')).toHaveLength(0);
  });

  it('`closePopovers` 由外面叫也能收（点画布别处走这一条）', () => {
    const { root, toolbar, setState } = setup();
    setState({ node: NODE, writable: true });
    mustFind(root, 'is-icon').emit('click', {});

    toolbar.closePopovers();
    expect(findAllByClass(root, 'nestboard-mind-toolbar__emoji')).toHaveLength(0);
  });

  it('分隔线也在（三段式：标记 | 格式与配色 | 内容与图片）', () => {
    const { root, setState } = setup();
    setState({ node: NODE, writable: true });

    expect(
      childrenOf(root).filter((child) => child.classList.contains('nestboard-mind-toolbar__sep')),
    ).toHaveLength(2);
  });
});
