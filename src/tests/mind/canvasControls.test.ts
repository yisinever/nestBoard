/**
 * 画布左下角那条浮层（`08 §1`）：缩放 + **结构 / 线型的图标选取器**。
 *
 * 它只认回调与三个"现在是什么"，所以在假 DOM 下能把**契约**逐条测掉：
 * 点 `+` 叫了谁、百分比怎么显示、菜单里有哪些档、哪几档不可选、按钮上现在是哪张图。
 * （真"点了缩放到底动没动视口"由视图那边接 —— 这两层分开测，才不会写成一坨。）
 */

import { describe, expect, it } from 'vitest';
import {
  MIND_EDGE_LABELS,
  MIND_PENDING_STRUCTURES,
  MIND_STRUCTURE_LABELS,
  buildCanvasControls,
} from '../../mind/view/CanvasControls';
import { MIND_ICON_ATTR, buildMindIcon } from '../../mind/view/mindIcons';
import { MIND_ICON_SHAPES } from '../../mind/view/mindIconShapes';
import { MIND_EDGE_STYLES, MIND_STRUCTURES } from '../../mind/model/schema';
import type { MindEdgeStyle, MindStructure } from '../../mind/model/schema';
import { createFakeDocument, type FakeElement } from '../helpers/fakeDom';
import { asEl, findAllByClass, mustFind } from '../helpers/fakeQuery';

const doc = () => createFakeDocument() as unknown as Document;

const ARIA_LABEL = 'aria-label';

interface Setup {
  root: FakeElement;
  calls: string[];
  percent: FakeElement;
  structure: FakeElement;
  edge: FakeElement;
  controls: ReturnType<typeof buildCanvasControls>;
}

function setup(overrides: Partial<{ structure: MindStructure; edge: MindEdgeStyle }> = {}): Setup {
  const calls: string[] = [];
  const controls = buildCanvasControls(doc(), {
    zoomIn: () => calls.push('in'),
    zoomOut: () => calls.push('out'),
    zoomReset: () => calls.push('reset'),
    fit: () => calls.push('fit'),
    structure: overrides.structure ?? 'logic-right',
    onStructure: (value) => calls.push(`structure:${value}`),
    edge: overrides.edge ?? 'curve',
    onEdge: (value) => calls.push(`edge:${value}`),
  });
  const root = asEl(controls.element);
  return {
    root,
    calls,
    controls,
    percent: mustFind(root, 'nestboard-mind-controls__percent'),
    structure: mustFind(root, 'is-structure'),
    edge: mustFind(root, 'is-edge'),
  };
}

/** 选取器按钮上**现在画的是哪张图**（`data-mind-icon`，见 `buildMindIcon`） */
function iconOf(picker: FakeElement): string | null {
  const button = mustFind(picker, 'nestboard-mind-controls__picker-button');
  const svg = mustFind(button, 'nestboard-mind-controls__picker-icon').children[0];
  return svg ? asEl(svg).getAttribute(MIND_ICON_ATTR) : null;
}

/** 打开菜单并读里面的行（每行 = 一个 `<button>`） */
function openMenu(picker: FakeElement): FakeElement[] {
  mustFind(picker, 'nestboard-mind-controls__picker-button').emit('click', {});
  return findAllByClass(picker, 'nestboard-mind-controls__menu-item');
}

/**
 * 菜单开着吗。
 *
 * ★ 断言**这个 class** 而不是"DOM 里还有没有那些行"：收起走的是 `is-open`（CSS 那条），
 *   行本身留在 DOM 里（下次打开重画一遍）。测"DOM 里没有"就测错了东西 ——
 *   以后要是改成"顺便清空"，这条用例会无缘无故地红。
 */
function menuOpen(picker: FakeElement): boolean {
  return picker.classList.contains('is-open');
}

describe('画布调节浮层 · 缩放', () => {
  it('★ 四个按钮各叫各的回调（百分比那个 = 回到 100%）', () => {
    const { calls, root, percent } = setup();

    mustFind(root, 'is-zoom-out').emit('click', {});
    mustFind(root, 'is-zoom-in').emit('click', {});
    percent.emit('click', {});
    mustFind(root, 'is-fit').emit('click', {});

    expect(calls).toEqual(['out', 'in', 'reset', 'fit']);
  });

  it('★ 百分比显示：正常四舍五入，很小的时候才留一位小数', () => {
    const { controls, percent } = setup();

    controls.setZoom(1);
    expect(percent.textContent).toBe('100%');
    controls.setZoom(0.5);
    expect(percent.textContent).toBe('50%');
    controls.setZoom(1.236);
    expect(percent.textContent).toBe('124%');
    // 6.3% 这种"小到看得出差别"的档位才留小数
    controls.setZoom(0.063);
    expect(percent.textContent).toBe('6.3%');
  });
});

describe('画布调节浮层 · 结构 / 线型的图标选取器', () => {
  it('★ 按钮上**只有图标**（没有文字），档位名走 `title` 与 `aria-label`', () => {
    const { structure } = setup({ structure: 'octopus' });
    const button = mustFind(structure, 'nestboard-mind-controls__picker-button');

    expect(button.textContent).toBe('');
    expect(iconOf(structure)).toBe('octopus');
    // 文字没丢，只是挪到可达性那一层
    expect(button.title).toContain(MIND_STRUCTURE_LABELS.octopus);
    expect(button.getAttribute('aria-label')).toContain(MIND_STRUCTURE_LABELS.octopus);
  });

  it('★ 结构菜单：五档都在、每档**只有一张图标**；**鱼骨图列出来但不可选**', () => {
    const { structure } = setup();
    const rows = openMenu(structure);

    expect(rows).toHaveLength(MIND_STRUCTURES.length);
    for (const [index, value] of MIND_STRUCTURES.entries()) {
      const row = rows[index] as FakeElement;
      const label = MIND_STRUCTURE_LABELS[value];
      // ★ 名字只在**可达性那一层**（用户 2026-09-16："图标统一替换，文字也去掉"）——
      //   菜单项自己一个字的文字都没有，`title` / `aria-label` 是唯一的语义来源
      expect(row.getAttribute(ARIA_LABEL)).toBe(
        MIND_PENDING_STRUCTURES.has(value) ? `${label}（待做）` : label,
      );
      expect(findAllByClass(row, 'nestboard-mind-controls__menu-label')).toHaveLength(0);
      // 每一行都画了图（图标化是这一轮的全部意义）
      expect(row.children.some((child) => asEl(child).getAttribute(MIND_ICON_ATTR) !== null)).toBe(
        true,
      );
      expect(row.classList.contains('is-disabled')).toBe(MIND_PENDING_STRUCTURES.has(value));
    }
  });

  it('★ 点一档：回调带上那个取值、按钮上的图跟着换、菜单收起', () => {
    const { calls, structure } = setup();
    const rows = openMenu(structure);

    rows[2]?.emit('click', {});

    expect(calls).toEqual(['structure:octopus']);
    expect(iconOf(structure)).toBe('octopus');
    expect(menuOpen(structure)).toBe(false);
  });

  it('★ **没有"待做"档**（鱼骨图已砍掉）：四档全部可选，点最后一档照常带上取值', () => {
    const { calls, structure } = setup();
    const rows = openMenu(structure);
    const last = rows[MIND_STRUCTURES.length - 1];

    expect(MIND_PENDING_STRUCTURES.size).toBe(0);
    expect(last?.classList.contains('is-disabled')).toBe(false);
    last?.emit('click', {});

    expect(calls).toEqual(['structure:org-down']);
    expect(menuOpen(structure)).toBe(false);
  });

  it('★ 线型菜单：四档、每档一张图、都可选', () => {
    const { edge } = setup();
    const rows = openMenu(edge);

    expect(rows).toHaveLength(MIND_EDGE_STYLES.length);
    expect(rows.every((row) => row.classList.contains('is-disabled') === false)).toBe(true);
    expect(rows.map((row) => row.getAttribute(ARIA_LABEL))).toEqual(
      MIND_EDGE_STYLES.map((value) => MIND_EDGE_LABELS[value]),
    );
  });

  it('现在的档位在打开时就标出来了（`is-current`）', () => {
    const { edge } = setup({ edge: 'elbow' });
    const rows = openMenu(edge);

    expect(rows[MIND_EDGE_STYLES.indexOf('elbow')]?.classList.contains('is-current')).toBe(true);
    expect(iconOf(edge)).toBe('elbow');
  });

  it('再点一次按钮 = 收起菜单（不用点别处）', () => {
    const { structure } = setup();
    const button = mustFind(structure, 'nestboard-mind-controls__picker-button');

    expect(openMenu(structure)).toHaveLength(MIND_STRUCTURES.length);
    expect(menuOpen(structure)).toBe(true);
    button.emit('click', {});
    expect(menuOpen(structure)).toBe(false);
  });

  it('外面把"现在是什么"改回去时，按钮上的图跟着走', () => {
    const { controls, structure, edge } = setup();

    controls.setStructure('logic-left');
    controls.setEdge('rounded');

    expect(iconOf(structure)).toBe('logicLeft');
    expect(iconOf(edge)).toBe('rounded');
  });

  it('`closeMenus` 由外面叫也能收（点画布别处走这一条）', () => {
    const { controls, structure } = setup();
    openMenu(structure);

    controls.closeMenus();
    expect(menuOpen(structure)).toBe(false);
  });
});

describe('图标数据（生成的 `mindIconShapes`）', () => {
  it('★ 八张图都在、都有形状（换图标要重跑生成脚本，别手改）', () => {
    expect(Object.keys(MIND_ICON_SHAPES).sort()).toEqual(
      ['curve', 'elbow', 'line', 'logicLeft', 'logicRight', 'octopus', 'orgDown', 'rounded'].sort(),
    );
    for (const [name, data] of Object.entries(MIND_ICON_SHAPES)) {
      expect(data.shapes.length, name).toBeGreaterThan(0);
      expect(data.viewBox.split(' ')).toHaveLength(4);
    }
  });

  it('★ 颜色一律 `currentColor`、并且**显式写 `fill`**（丢掉默认黑填充会画成黑饼）', () => {
    // 这两条是生成脚本干的事，脚本用完就删了 —— 所以把它的合同钉在用例里
    for (const data of Object.values(MIND_ICON_SHAPES)) {
      for (const shape of data.shapes) {
        if (shape.tag === 'g') continue;
        expect(shape.attrs.fill, `${shape.tag} 缺 fill`).toBeDefined();
        expect(shape.attrs.stroke ?? 'currentColor').toBe('currentColor');
      }
    }
  });

  it('★ 没有"盖住整张图"的实心形状（黑框 / 主题色框就是这么来的）', () => {
    // 生成器曾经把 `<defs><clipPath>` 里那个 26×26 的矩形当图形收进来 ⇒ 图标上
    // 盖了一个实心方框（填充色 = 黑或主题色）。这条断言把那个形状钉死：
    // 谁要是又把"模板里的东西"收进来，这里当场红。
    for (const [name, data] of Object.entries(MIND_ICON_SHAPES)) {
      const [, , boxW, boxH] = data.viewBox.split(' ').map(Number);
      for (const shape of data.shapes) {
        if (shape.tag !== 'rect' && shape.tag !== 'ellipse' && shape.tag !== 'circle') continue;
        const width = Number(shape.attrs.rx ?? 0) * 2 || Number(shape.attrs.width ?? 0);
        const height = Number(shape.attrs.ry ?? 0) * 2 || Number(shape.attrs.height ?? 0);
        expect(
          width >= boxW * 0.95 && height >= boxH * 0.95 && shape.attrs.fill === 'currentColor',
          `${name} 里有个盖住整张图的实心形状`,
        ).toBe(false);
      }
    }
  });

  it('★ 每张图都能建成 DOM：`aria-hidden` + 名字属性 + 正方形盒子', () => {
    const svg = asEl(buildMindIcon(doc(), 'orgDown', 16));

    expect(svg.getAttribute(MIND_ICON_ATTR)).toBe('orgDown');
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.getAttribute('width')).toBe('16');
    expect(svg.getAttribute('height')).toBe('16');
    // 形状真的建出来了。★ 只钉"确实建了形状"、**不钉具体张数**：张数随用户给的 SVG 变，
    //   钉死它只会让"换一套图标"变成必须改用例（这一条已经被咬过一次）
    expect(svg.children.length).toBeGreaterThan(0);
  });
});
