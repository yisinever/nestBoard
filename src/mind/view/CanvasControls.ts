/**
 * 画布左下角那条浮层（`08 §1`）：**缩放** + **总体结构** + **分支线形态**。
 *
 * ── 分工（与底部居中的快捷操作栏划清楚）──────────────
 *
 * * 这一条是「**这一眼怎么看**」：缩放、结构、线型 —— 都是 `view` 上的状态，
 *   与平移同一个性质（不进撤销栈）；
 * * 底部居中那一条（`08 §3`）是「**这个节点怎么改**」：改的是节点本身。
 *
 * ── 为什么做成"端口进、句柄出" ──────────────────────────
 *
 * 它只认回调与三个"现在是什么"，**不 import `obsidian`、不认识模型** ⇒
 * 可以在假 DOM 下把"点 + 会调谁 / 显示几 %"逐条测掉；视图那边只负责把回调接上。
 * 与 `render.ts` 的 `GuideLayer` 同一条做法（返回**句柄**而不是让调用方去 `querySelector`——
 * 假 DOM 里没有 `querySelector`）。
 */

import { t } from '../../util/i18n';
import { MIND_EDGE_STYLES, MIND_STRUCTURES } from '../model/schema';
import type { MindEdgeStyle, MindStructure } from '../model/schema';
import {
  buildMindIcon,
  MIND_EDGE_ICONS,
  MIND_STRUCTURE_ICONS,
  type MindIconName,
} from './mindIcons';

/** 控件要画什么、点了叫谁 */
export interface CanvasControlsOptions {
  zoomIn: () => void;
  zoomOut: () => void;
  /** 回到 100% */
  zoomReset: () => void;
  /** 适应内容（`⌘0` 的另一半） */
  fit: () => void;
  structure: MindStructure;
  onStructure: (structure: MindStructure) => void;
  edge: MindEdgeStyle;
  onEdge: (edge: MindEdgeStyle) => void;
}

/**
 * 结构与线型的**界面文案**。
 *
 * ★ 文案与取值写在一起（不散在 i18n 的两个字典里各拼一次）：菜单的每一项都是
 *   "一个取值 + 一张图标 + 一句人话"，分开写迟早出现"加了一档但忘了加名字"。
 * ★ 按钮上显示的是**图标**（`mindIcons.ts`），文字走 `title` 与菜单项 ——
 *   认图标与认文字的人各取所需。
 */
export const MIND_STRUCTURE_LABELS: Readonly<Record<MindStructure, string>> = {
  'logic-right': '逻辑图（向右）',
  'logic-left': '逻辑图（向左）',
  octopus: '八爪鱼（左右都有）',
  'org-down': '组织结构图（向下）',
};

export const MIND_EDGE_LABELS: Readonly<Record<MindEdgeStyle, string>> = {
  curve: '曲线',
  line: '直线',
  elbow: '直角折线',
  rounded: '圆角折线',
};

/**
 * **还没实现的档位**（`08` 的 P8-d 鱼骨图 —— 只剩它）。
 *
 * ★ 它**照旧出现在菜单里、只是不可选**：用户提过这一档，列出来并标一句"待做"
 *   比"菜单里根本没有它"诚实得多 —— 后者会让人以为漏做了。
 * ★ 这一组是**会变短的**：每落地一档就从这里删一个（`org-down` 就是这么走的）。
 * ★ **现在是空的**：最后一档「鱼骨图」已按用户要求**砍掉**（2026-09-16 —— 体验一般、
 *   脑图里也不常用），所以四档结构都是可用的。
 *   这一组留着是因为**以后还会有新的档位**（比如"时间线""括号图"），它们照旧走
 *   这一条：先列出来标「待做」，落地了（或砍掉）再从这儿删一个。
 */
export const MIND_PENDING_STRUCTURES: ReadonlySet<MindStructure> = new Set();

/** 浮层的句柄：视图拿它同步"现在是什么" */
export interface CanvasControls {
  readonly element: HTMLElement;
  /** 缩放百分比（`1` = 100%） */
  setZoom(zoom: number): void;
  setStructure(structure: MindStructure): void;
  setEdge(edge: MindEdgeStyle): void;
  /** 收起两个图标菜单（点画布别处时调 —— 与快捷操作栏的 `closePopovers` 同一条） */
  closeMenus(): void;
}

/** 建出这一条浮层 */
export function buildCanvasControls(doc: Document, options: CanvasControlsOptions): CanvasControls {
  const root = doc.createElement('div');
  root.className = 'nestboard-mind-controls';

  // ── 缩放 ──
  const zoomRow = doc.createElement('div');
  zoomRow.className = 'nestboard-mind-controls__zoom';

  const out = iconButton(
    doc,
    'nestboard-mind-controls__button is-zoom-out',
    '−',
    t('mind.controls.zoomOut'),
    options.zoomOut,
  );
  const percent = doc.createElement('button');
  percent.className = 'nestboard-mind-controls__percent';
  percent.type = 'button';
  percent.title = t('mind.controls.zoomReset');
  percent.textContent = '100%';
  percent.addEventListener('click', () => options.zoomReset());
  const zin = iconButton(
    doc,
    'nestboard-mind-controls__button is-zoom-in',
    '+',
    t('mind.controls.zoomIn'),
    options.zoomIn,
  );
  const fit = iconButton(
    doc,
    'nestboard-mind-controls__button is-fit',
    '⤢',
    t('mind.controls.fit'),
    options.fit,
  );

  zoomRow.append(out, percent, zin, fit);
  root.appendChild(zoomRow);

  // ── 结构 / 线型 ──
  const pickers = doc.createElement('div');
  pickers.className = 'nestboard-mind-controls__pickers';

  const structure = buildPicker(
    doc,
    'nestboard-mind-controls__picker is-structure',
    t('mind.controls.structure'),
    MIND_STRUCTURES.map((value) => ({
      value,
      label: MIND_STRUCTURE_LABELS[value],
      icon: MIND_STRUCTURE_ICONS[value],
      disabled: MIND_PENDING_STRUCTURES.has(value),
    })),
    options.structure,
    (value) => options.onStructure(value as MindStructure),
  );
  const edge = buildPicker(
    doc,
    'nestboard-mind-controls__picker is-edge',
    t('mind.controls.edge'),
    MIND_EDGE_STYLES.map((value) => ({
      value,
      label: MIND_EDGE_LABELS[value],
      icon: MIND_EDGE_ICONS[value],
    })),
    options.edge,
    (value) => options.onEdge(value as MindEdgeStyle),
  );

  pickers.append(structure.element, edge.element);
  root.appendChild(pickers);

  return {
    element: root,
    setZoom(zoom: number): void {
      // 小于 10% 时不显示小数（"6.3%" 那种数字对用户没有意义）
      const value = zoom * 100;
      percent.textContent = `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10}%`;
    },
    setStructure(next: MindStructure): void {
      structure.setValue(next);
    },
    setEdge(next: MindEdgeStyle): void {
      edge.setValue(next);
    },
    closeMenus(): void {
      structure.close();
      edge.close();
    },
  };
}

function iconButton(
  doc: Document,
  className: string,
  text: string,
  label: string,
  onClick: () => void,
): HTMLElement {
  const button = doc.createElement('button');
  button.className = className;
  button.type = 'button';
  button.textContent = text;
  button.title = label;
  button.setAttribute('aria-label', label);
  button.addEventListener('click', onClick);
  return button;
}

interface PickerItem {
  value: string;
  label: string;
  icon: MindIconName;
  disabled?: boolean;
}

/**
 * 一个「图标按钮 + 图标菜单」。
 *
 * ★ **为什么不再是原生 `<select>`**：`<option>` 里**放不下 SVG**，而用户要的是
 *   "这两处显示图标而不是文字"（原生下拉只认纯文本）。代价是键盘 / 读屏要自己补：
 *   所以菜单项是真正的 `<button>`（Tab 走得到、回车敲得响），
 *   按钮与每一项都带 `aria-label`（图标本身对读屏是装饰）。
 * ★ 按钮上**只有图标**（用户要的）；档位名走 `title`，菜单里则**图标 + 文字**并排 ——
 *   八张抽象图标单看是猜谜，配上名字才是"选择"。
 * ★ `disabled` 的档位**照旧列出来**、点了不生效（见 {@link MIND_PENDING_STRUCTURES}）。
 */
function buildPicker(
  doc: Document,
  className: string,
  label: string,
  items: readonly PickerItem[],
  current: string,
  onPick: (value: string) => void,
): { element: HTMLElement; setValue: (value: string) => void; close: () => void } {
  const wrap = doc.createElement('div');
  wrap.className = className;

  const button = doc.createElement('button');
  button.type = 'button';
  button.className = 'nestboard-mind-controls__picker-button';
  button.setAttribute('aria-haspopup', 'true');
  const iconHost = doc.createElement('span');
  iconHost.className = 'nestboard-mind-controls__picker-icon';
  button.appendChild(iconHost);

  const menu = doc.createElement('div');
  menu.className = 'nestboard-mind-controls__menu';

  let picked = current;
  let open = false;

  function renderButton(): void {
    const item = items.find((entry) => entry.value === picked) ?? items[0];
    const name = item?.label ?? '';
    button.title = `${label}：${name}`;
    button.setAttribute('aria-label', `${label}：${name}`);
    iconHost.replaceChildren();
    if (item) iconHost.appendChild(buildMindIcon(doc, item.icon, 16));
  }

  function closeMenu(): void {
    if (!open) return;
    open = false;
    wrap.classList.remove('is-open');
  }

  function renderMenu(): void {
    menu.replaceChildren();
    for (const item of items) {
      const row = doc.createElement('button');
      row.type = 'button';
      row.className = 'nestboard-mind-controls__menu-item';
      row.classList.toggle('is-current', item.value === picked);
      row.classList.toggle('is-disabled', item.disabled === true);
      // ★ 菜单里**只有图标**（用户 2026-09-16："图标统一替换，文字也去掉"）：
      //   名字走 `title`（悬停）与 `aria-label`（读屏）—— 图标没了文字之后，
      //   那两处就是**唯一**的语义来源，都不能省。
      //   "（待做）"那半句也挪进提示里（菜单项自己不再有文字）。
      row.title = item.disabled === true ? `${item.label}（待做）` : item.label;
      row.setAttribute('aria-label', row.title);
      row.appendChild(buildMindIcon(doc, item.icon, 16));

      if (item.disabled !== true) {
        row.addEventListener('click', () => {
          picked = item.value;
          renderButton();
          onPick(item.value);
          closeMenu();
        });
      }
      menu.appendChild(row);
    }
  }

  button.addEventListener('click', () => {
    if (open) {
      closeMenu();
      return;
    }
    open = true;
    wrap.classList.add('is-open');
    renderMenu();
  });

  renderButton();
  wrap.append(button, menu);
  return {
    element: wrap,
    setValue(value: string): void {
      picked = value;
      renderButton();
      closeMenu();
    },
    close: closeMenu,
  };
}
