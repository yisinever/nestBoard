/**
 * 断链总览浮层的单元测试（T3.19 / `F8-07`）。
 *
 * 浮层不认识白板、也不认识 Vault（数据靠 `entries()` 现取、存在性判断在视图层），
 * 所以这里钉的是三件"面板的行为"：
 *
 *  * 没有断链时给**空态文案**，而不是一个什么都没有的空面板；
 *  * 每条都写清"哪张卡 + 引用什么 + 为什么算断"，且点一下就能把卡片 id 交回去；
 *  * `refresh` 幂等（清单会随内容变化被反复重画，不能越画越多）。
 */

import { describe, expect, it, vi } from 'vitest';
import type { CardRef } from '../../model/links';
import { LinkOverview } from '../../ui/LinkOverview';
import { t } from '../../util/i18n';
import { type FakeElement, createFakeDocument, createFakeElement } from '../helpers/fakeDom';

const IMAGE_REF: CardRef = {
  cardId: 'card-1',
  cardTitle: '封面',
  cardType: 'image',
  kind: 'image',
  path: 'assets/gone.png',
};

const BOARD_REF: CardRef = {
  cardId: 'card-2',
  // 空标题：面板要退到"卡片类型"而不是显示一行空白
  cardTitle: '   ',
  cardType: 'boardRef',
  kind: 'boardRef',
  path: 'Boards/Missing.nboard',
};

function setup(
  entries: () => readonly CardRef[],
  repair?: { canRepair?: () => boolean; onRepair?: () => void },
) {
  const doc = createFakeDocument();
  const parent = createFakeElement(doc);
  const onPick = vi.fn();

  const panel = new LinkOverview(parent as unknown as HTMLElement, { entries, onPick, ...repair });
  // 构造不渲染（渲染只发生在 `show` / `refresh`）：先按当前清单画一次，
  // 与真实视图"每次 applyBoard 后刷新浮层"的节奏对齐
  panel.refresh();

  // 结构：root = [head, list]；head = [title, count, repair?, close]；row = [reason, body]
  // ★ 「修复引用」是**可选**的（只有视图给了 `onRepair` 才有），所以 close 一律取
  //   最后一个孩子 —— 按下标取死会在"有没有这个按钮"两种形态里错位
  const root = parent.children[0] as FakeElement;
  const head = root.children[0] as FakeElement;
  const list = root.children[1] as FakeElement;
  const kids = head.children as FakeElement[];
  const [title, count] = kids;
  const close = kids[kids.length - 1];
  const repairEl = repair?.onRepair ? kids[kids.length - 2] : null;

  return { doc, parent, panel, root, head, list, title, count, close, repairEl, onPick };
}

function rowParts(row: FakeElement): { reason: FakeElement; body: FakeElement } {
  const [reason, body] = row.children as FakeElement[];
  return { reason, body };
}

describe('显隐', () => {
  it('构造出来是收起的', () => {
    const { panel, root } = setup(() => []);
    expect(panel.isOpen).toBe(false);
    expect(root.classList.contains('is-hidden')).toBe(true);
  });

  it('show / close / toggle 来回切', () => {
    const { panel, root } = setup(() => [IMAGE_REF]);

    panel.show();
    expect(panel.isOpen).toBe(true);
    expect(root.classList.contains('is-hidden')).toBe(false);

    panel.toggle();
    expect(panel.isOpen).toBe(false);
  });

  it('Esc 关掉，并拦下事件', () => {
    const { panel, root } = setup(() => [IMAGE_REF]);
    panel.show();

    const event = { key: 'Escape', preventDefault: vi.fn() };
    root.emit('keydown', event);

    expect(panel.isOpen).toBe(false);
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it('dispose 把节点从父节点摘掉', () => {
    const { panel, parent } = setup(() => []);
    expect(parent.children).toHaveLength(1);

    panel.dispose();

    expect(parent.children).toHaveLength(0);
  });
});

describe('清单', () => {
  it('没有断链时给空态（而不是一个空面板）', () => {
    const { list } = setup(() => []);

    expect(list.children).toHaveLength(1);
    const empty = list.children[0] as FakeElement;
    expect(empty.className).toContain('nestboard-link-overview-empty');
    expect(empty.textContent).toBe(t('linkOverview.empty'));
  });

  it('逐条画：原因 + 来源 + 路径', () => {
    const { list, count } = setup(() => [IMAGE_REF, BOARD_REF]);

    expect(count.textContent).toBe('2');
    expect(list.children).toHaveLength(2);

    const first = rowParts(list.children[0] as FakeElement);
    expect(first.reason.textContent).toBe(t('linkOverview.reason.image'));
    const [source, path] = first.body.children as FakeElement[];
    expect(source.textContent).toBe('封面');
    expect(path.textContent).toBe('assets/gone.png');
    // 悬停要能看到完整路径：画面上它是被省略号裁掉的
    expect(path.title).toBe('assets/gone.png');
  });

  it('卡片没有标题时退到类型名（不显示一行空白）', () => {
    const { list } = setup(() => [BOARD_REF]);

    const { body } = rowParts(list.children[0] as FakeElement);
    const [source] = body.children as FakeElement[];
    expect(source.textContent).toBe(t('card.type.boardRef'));
  });

  it('点一行把引用交回去（视图据此飞到那张卡）', () => {
    const { list, onPick } = setup(() => [IMAGE_REF]);

    (list.children[0] as FakeElement).emit('pointerdown', { preventDefault: vi.fn() });

    expect(onPick).toHaveBeenCalledWith(IMAGE_REF);
  });

  it('refresh 幂等：反复重画不会累积条目', () => {
    const { list, panel } = setup(() => [IMAGE_REF]);

    panel.refresh();
    panel.refresh();
    panel.refresh();

    expect(list.children).toHaveLength(1);
  });

  it('清单从"有"变"没有"时立刻显示空态', () => {
    let entries: readonly CardRef[] = [IMAGE_REF];
    const { list, panel } = setup(() => entries);

    expect(list.children).toHaveLength(1);
    entries = [];
    panel.refresh();

    expect(list.children).toHaveLength(1);
    expect((list.children[0] as FakeElement).className).toContain('nestboard-link-overview-empty');
  });
});

/**
 * 「修复引用」入口（T4.07）。
 *
 * 浮层在这里只做两件事：**把动作交回视图**、**按视图的判断显隐自己**。
 * 所以钉的是这两条边界，而不是"点下去会发生什么"（那在视图与对话框里）。
 */
describe('修复引用入口', () => {
  it('视图没给 `onRepair` 就不造这个按钮（浮层不该凭空多一个动作）', () => {
    const { head } = setup(() => [IMAGE_REF]);

    // title + count + close，没有第四个孩子
    expect(head.children).toHaveLength(3);
  });

  it('给了 `onRepair`：头部多一个按钮，文案取自 i18n，默认可用', () => {
    const { repairEl } = setup(() => [IMAGE_REF], { onRepair: vi.fn() });

    expect(repairEl).not.toBeNull();
    expect(repairEl?.textContent).toBe(t('linkOverview.repair'));
    expect(repairEl?.hidden).toBe(false);
  });

  it('点按钮把动作交回视图（浮层不碰 Vault、也不认识对话框）', () => {
    const onRepair = vi.fn();
    const { repairEl } = setup(() => [IMAGE_REF], { onRepair });

    repairEl?.emit('click', {});

    expect(onRepair).toHaveBeenCalledTimes(1);
  });

  it('`canRepair` 说了算，且每次重画都重新问一遍（板子可能刚被锁上）', () => {
    let allowed = false;
    const { repairEl, panel } = setup(() => [IMAGE_REF], {
      canRepair: () => allowed,
      onRepair: vi.fn(),
    });

    // 只读板 / 只剩 URL 类断链：藏起来而不是灰着 —— 灰按钮会让人反复点它问"为什么不行"
    expect(repairEl?.hidden).toBe(true);

    allowed = true;
    panel.refresh();
    expect(repairEl?.hidden).toBe(false);

    allowed = false;
    panel.refresh();
    expect(repairEl?.hidden).toBe(true);
  });

  it('可见性只看 `canRepair`，不由清单条数推断', () => {
    // 空清单 + 允许修复 = 按钮仍在：该不该出现是视图的判断，浮层不替它猜
    const { repairEl } = setup(() => [], { canRepair: () => true, onRepair: vi.fn() });

    expect(repairEl?.hidden).toBe(false);
  });
});
