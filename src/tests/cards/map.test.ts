/**
 * 地图卡单元测试（`T7.03` / `F2.9`）。
 *
 * 渲染要在真环境里验（图按比例缩进、图钉的位置准不准），这里钉的是**几何与写入**这几件
 * 一旦错了用户就会吃亏的事：
 *
 *  1. **图钉钉的是图，不是卡片**。图按 `contain` 缩进卡片，两侧会留白；把百分比算成
 *     "相对卡片"会让图钉飘到留白里 —— 越靠边缘越离谱。所以这里断言的是
 *     "图钉挂在 frame（图上那条矩形）里，且百分比就是模型里那两个数"；
 *  2. **双击留白不落钉、也不吞事件**。吞掉的话用户双击留白就没反应了，
 *     而"双击进编辑态"是空卡唯一的入口；落钉的话等于替用户标了一个他没指过的位置；
 *  3. **取消 / 没改就退**。编辑态两个动作都不能写盘：`Esc`、以及"原样提交" ——
 *     后者会让每一次点开又关掉都进一次撤销栈。
 */

import { describe, expect, it, vi } from 'vitest';
import type { CardRenderContext, CardViewMode } from '../../cards/registry';
import {
  MAP_RATIO_PROP,
  clampUnit,
  mapCard,
  pinFromPoint,
  pinText,
  samePin,
} from '../../cards/map';
import { createCard } from '../../model/factories';
import type { MapPin } from '../../model/schema';
import { t } from '../../util/i18n';
import {
  type FakeElement,
  type FakeMouseEvent,
  createFakeDocument,
  createFakeElement,
  createKeyEvent,
  createMouseEvent,
} from '../helpers/fakeDom';

// ── 纯逻辑 ────────────────────────────────────────────────────

describe('pinFromPoint', () => {
  const size = { width: 200, height: 100 };

  it('图上任意一点换算成 0~1 的归一化坐标', () => {
    expect(pinFromPoint({ x: 50, y: 25 }, size)).toEqual({ x: 0.25, y: 0.25 });
    expect(pinFromPoint({ x: 0, y: 0 }, size)).toEqual({ x: 0, y: 0 });
    expect(pinFromPoint({ x: 200, y: 100 }, size)).toEqual({ x: 1, y: 1 });
  });

  it('落在图上那条矩形之外（留白）返回 null —— 不替用户猜一个位置', () => {
    expect(pinFromPoint({ x: -1, y: 50 }, size)).toBeNull();
    expect(pinFromPoint({ x: 100, y: 101 }, size)).toBeNull();
  });

  it('frame 还没量出尺寸（0×0）时返回 null，而不是除出 Infinity', () => {
    expect(pinFromPoint({ x: 10, y: 10 }, { width: 0, height: 0 })).toBeNull();
  });
});

describe('pinText / clampUnit / samePin', () => {
  it('位置写成百分比文案（给编辑态那行"图钉在 40% / 62%"）', () => {
    expect(pinText({ x: 0.4, y: 0.62 })).toBe('40% / 62%');
    expect(pinText({ x: 0, y: 1 })).toBe('0% / 100%');
  });

  it('越界的手改坐标夹回 0~1（钉到边上，比飘到卡外好解释）', () => {
    expect(pinText({ x: 1.5, y: -0.2 })).toBe('100% / 0%');
    expect(clampUnit(1.5)).toBe(1);
    expect(clampUnit(-3)).toBe(0);
  });

  it('没图钉就是 null（编辑态据此显示"还没标图钉"）', () => {
    expect(pinText(null)).toBeNull();
  });

  it('samePin：都为 null 算相同，坐标逐个比', () => {
    expect(samePin(null, null)).toBe(true);
    expect(samePin(null, { x: 0, y: 0 })).toBe(false);
    expect(samePin({ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 })).toBe(true);
    expect(samePin({ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.6 })).toBe(false);
  });
});

// ── 渲染 ─────────────────────────────────────────────────────

interface SetupOptions {
  path?: string;
  label?: string;
  pin?: MapPin | null;
  mode?: CardViewMode;
  locked?: boolean;
  /** 图在不在 vault 里（`resourceUrl` 对"不在了"返回 null） */
  resolvable?: boolean;
  /** 贴过的链接原文（`O08`）。缺席 = 从没贴过（模型里那个键也会缺席） */
  sourceUrl?: string;
  /** 从链接解析出的经纬度（`O08`），同样可以缺席 */
  coords?: { lat: number; lon: number };
  /** 有没有外链桥（没传 = 没有：按钮该置灰） */
  links?: { openExternal: (url: string) => Promise<boolean> };
  /** 静态图服务开没开（只影响那句提示的措辞） */
  tileEnabled?: boolean;
}

function setup(options: SetupOptions = {}) {
  const el = createFakeElement(createFakeDocument());
  const path = options.path ?? 'assets/map.png';
  // ★ 链接与坐标**按需写键**，而不是一律填空串/空值：模型里它们本就是可选键，
  //   一律填上会让"从没贴过链接的卡"这个最常见的形态在测试里消失
  const content = {
    path,
    label: options.label ?? '',
    pin: options.pin ?? null,
    ...(options.sourceUrl === undefined ? {} : { sourceUrl: options.sourceUrl }),
    ...(options.coords === undefined ? {} : { coords: options.coords }),
  };
  const card = createCard('map', { content, locked: options.locked ?? false });
  const updateContent = vi.fn();
  const setMode = vi.fn();

  const resources = {
    resourceUrl: () => (options.resolvable === false ? null : `app://vault/${path}`),
    exists: () => options.resolvable !== false,
  };

  const ctx = {
    mode: options.mode ?? 'display',
    updateContent,
    setMode,
    notes: resources,
    links: options.links,
    mapTiles: options.tileEnabled === undefined ? undefined : { enabled: options.tileEnabled },
  } as unknown as CardRenderContext;

  mapCard.render(el as unknown as HTMLElement, card, ctx);
  return { el, card, updateContent, setMode };
}

/** `el > stage > frame`：图钉就挂在这一层里（"图上那条矩形"） */
function frameOf(el: FakeElement): FakeElement {
  return (el.children[0] as FakeElement).children[0] as FakeElement;
}

function imgOf(el: FakeElement): FakeElement & { naturalWidth: number; naturalHeight: number } {
  return frameOf(el).children[0] as FakeElement & { naturalWidth: number; naturalHeight: number };
}

function pinOf(el: FakeElement): FakeElement {
  return frameOf(el).children[1] as FakeElement;
}

/** 给 frame 一个"真实"矩形：落钉判定读的就是它 */
function rectOf(
  el: FakeElement,
  rect = { left: 0, top: 0, width: 200, height: 100 },
): FakeElement & { getBoundingClientRect: () => typeof rect } {
  const frame = frameOf(el) as FakeElement & { getBoundingClientRect: () => typeof rect };
  frame.getBoundingClientRect = () => rect;
  return frame;
}

describe('渲染 · 显示态 · 没有图', () => {
  it('路径为空：一句话占位，不留一个空框', () => {
    const { el } = setup({ path: '' });
    expect(el.classList.contains('is-missing')).toBe(true);
    expect(el.dataset.placeholder).toBe('map');
    expect(el.textContent).toBe(t('card.map.empty', { path: '' }));
  });

  it('图不在 vault 里：同样占位，并把路径写进文案（用户才知道该去找哪张）', () => {
    const { el } = setup({ path: 'assets/gone.png', resolvable: false });
    expect(el.classList.contains('is-missing')).toBe(true);
    expect(el.textContent).toBe(t('card.map.empty', { path: 'assets/gone.png' }));
  });

  it('没有 notes 桥（嵌入视图）时也走占位，不炸', () => {
    const el = createFakeElement(createFakeDocument());
    const card = createCard('map', { content: { path: 'a.png' } });
    mapCard.render(el as unknown as HTMLElement, card, { mode: 'display' } as CardRenderContext);
    expect(el.classList.contains('is-missing')).toBe(true);
  });
});

// ── 贴过链接但没图（`O08` 的降级落点）────────────────────────────
// ★ 这一组是 `O08` 最要紧的几条：没图**不再等于**空框。没网 / 没配服务 / 服务商回错时，
//   卡上必须有坐标、有链接、有一个能按的按钮 —— 否则用户粘完链接看到一片空白，
//   会以为插件坏了，而实际上东西都存下来了。
describe('渲染 · 显示态 · 没图但有链接（O08）', () => {
  /** 降级卡面：`el > .nestboard-map-fallback > [.nestboard-map-place, .nestboard-map-url, .nestboard-map-open, .nestboard-map-hint]` */
  function fallbackOf(el: FakeElement): FakeElement {
    return el.children[0] as FakeElement;
  }

  function findByClass(el: FakeElement, className: string): FakeElement | undefined {
    return (el.children as FakeElement[]).find((child) =>
      (child.className ?? '').split(' ').includes(className),
    );
  }

  function fallbackSetup(options: SetupOptions = {}) {
    return setup({
      path: '',
      sourceUrl: 'https://www.google.com/maps/place/天安门/@39.9042,116.4074,15z',
      coords: { lat: 39.9042, lon: 116.4074 },
      ...options,
    });
  }

  it('坐标与链接都显示出来，而不是一句"还没有地图图片"', () => {
    const { el } = fallbackSetup({ label: '天安门' });
    const box = fallbackOf(el);

    expect(el.classList.contains('is-missing')).toBe(true);
    expect(findByClass(box, 'nestboard-map-place')?.textContent).toBe('天安门 · 39.9042, 116.4074');
    expect(findByClass(box, 'nestboard-map-url')?.textContent).toBe(
      'https://www.google.com/maps/place/天安门/@39.9042,116.4074,15z',
    );
    // 那句话此刻是个谎：卡上明明有东西
    expect(el.textContent).not.toBe(t('card.map.empty', { path: '' }));
  });

  it('没有地点名时只显示坐标（不留一个空的标题行）', () => {
    const { el } = fallbackSetup();
    expect(findByClass(fallbackOf(el), 'nestboard-map-place')?.textContent).toBe(
      '39.9042, 116.4074',
    );
  });

  it('按钮按得动：点了就用系统浏览器打开那条链接', () => {
    const openExternal = vi.fn(async () => true);
    const { el } = fallbackSetup({ links: { openExternal } });
    const button = findByClass(fallbackOf(el), 'nestboard-map-open');
    const event = createMouseEvent();

    button?.emit('click', event);

    expect(button?.disabled).toBe(false);
    expect(event.propagationStopped).toBe(true); // 不吞的话这一下会变成"拖卡片"
    expect(openExternal).toHaveBeenCalledWith(
      'https://www.google.com/maps/place/天安门/@39.9042,116.4074,15z',
    );
  });

  it('按钮要在 pointerdown 上停一下：不停会被卡片层当成拖动的开始，click 永远等不到', () => {
    const { el } = fallbackSetup({ links: { openExternal: vi.fn(async () => true) } });
    const event = createMouseEvent();

    findByClass(fallbackOf(el), 'nestboard-map-open')?.emit('pointerdown', event);

    expect(event.propagationStopped).toBe(true);
  });

  it('没有外链桥时按钮按不动，而不是按下去没反应', () => {
    const { el } = fallbackSetup();
    expect(findByClass(fallbackOf(el), 'nestboard-map-open')?.disabled).toBe(true);
  });

  it('提示随"能不能出图"换一种说法：配了服务说再取一次，没配说去哪儿配', () => {
    const enabled = fallbackSetup({ tileEnabled: true });
    const disabled = fallbackSetup({ tileEnabled: false });

    expect(findByClass(fallbackOf(enabled.el), 'nestboard-map-hint')?.textContent).toBe(
      t('card.map.hintFetchTile'),
    );
    expect(findByClass(fallbackOf(disabled.el), 'nestboard-map-hint')?.textContent).toBe(
      t('card.map.hintTileSetup'),
    );
  });

  it('提示走 is-static 变体：有图时它是绝对定位的，而这里没有那张图', () => {
    const { el } = fallbackSetup();
    const hint = findByClass(fallbackOf(el), 'nestboard-map-hint');
    expect((hint?.className ?? '').split(' ')).toContain('is-static');
  });

  it('图丢了（有路径、文件不在）时明说一句，而不是当作"还没选图"', () => {
    const { el } = fallbackSetup({ path: 'assets/gone.png', resolvable: false });
    const missing = findByClass(fallbackOf(el), 'nestboard-map-missing');

    expect(missing?.textContent).toBe(t('card.map.missingImage', { path: 'assets/gone.png' }));
  });
});

describe('渲染 · 显示态 · 有图', () => {
  it('图片地址来自 notes 桥；alt 用地点名', () => {
    const { el } = setup({ path: 'assets/深圳.png', label: '深圳湾' });
    const img = imgOf(el);

    expect((img as unknown as { src: string }).src).toBe('app://vault/assets/深圳.png');
    expect((img as unknown as { alt: string }).alt).toBe('深圳湾');
  });

  it('没有地点名时 alt 退回文件名（整条 vault 路径当无障碍名等于没写）', () => {
    const { el } = setup({ path: 'assets/nested/city map.png' });
    expect((imgOf(el) as unknown as { alt: string }).alt).toBe('city map.png');
  });

  it('图钉挂在 frame 里，百分比就是模型里那两个数（不是相对卡片）', () => {
    const { el } = setup({ pin: { x: 0.4, y: 0.62 } });
    const pin = pinOf(el);

    expect(pin.hidden).toBe(false);
    expect(pin.style.getPropertyValue('left')).toBe('40%');
    expect(pin.style.getPropertyValue('top')).toBe('62%');
    // 图钉是 frame（图上那条矩形）的孩子，而 frame 才是按比例缩进的那一层
    expect(pinOf(el).parentNode).toBe(frameOf(el));
  });

  it('图钉旁边带上地点名标签', () => {
    const { el } = setup({ label: '集合点', pin: { x: 0.5, y: 0.5 } });
    const children = pinOf(el).children as FakeElement[];

    expect(children).toHaveLength(2);
    expect(children[1].textContent).toBe('集合点');
  });

  it('没地点名就只画一个点，不留空的标签盒', () => {
    const { el } = setup({ pin: { x: 0.5, y: 0.5 } });
    expect(pinOf(el).children).toHaveLength(1);
  });

  it('没有图钉时整块图钉是 hidden 的，并给出"双击落钉"这一句引导', () => {
    const { el } = setup();
    const stage = el.children[0] as FakeElement;

    expect(pinOf(el).hidden).toBe(true);
    expect((stage.children[1] as FakeElement).textContent).toBe(t('card.map.hintDrop'));
  });

  it('已经有图钉就不再给引导（它会压在图上，而用户早就知道怎么用了）', () => {
    const { el } = setup({ pin: { x: 0.1, y: 0.1 } });
    const stage = el.children[0] as FakeElement;

    expect(stage.children).toHaveLength(1);
  });

  it('锁定卡不给引导：那条提示此刻是个谎（双击不会有任何反应）', () => {
    const { el } = setup({ locked: true });
    const stage = el.children[0] as FakeElement;

    expect(stage.children).toHaveLength(1);
  });

  it('图钉不吃指针事件（否则双击图钉处会变成"双击卡片进编辑态"）', () => {
    const { el } = setup({ pin: { x: 0.5, y: 0.5 } });
    // 样式在 styles.css 里，这里钉住"图钉压在图上"这个前提：它必须是 frame 的孩子，
    // 而 pointer-events: none 是唯一的解法 —— 用 `hidden` 之外的状态表达不出这件事
    expect(pinOf(el).parentNode).toBe(frameOf(el));
  });
});

describe('渲染 · 显示态 · 图的真实比例', () => {
  it('load 之后把真实像素写成 --nestboard-map-ratio（图才不会按卡片形状拉伸）', () => {
    const { el } = setup();
    const img = imgOf(el);

    img.naturalWidth = 1600;
    img.naturalHeight = 900;
    img.emit('load', {});

    expect(frameOf(el).style.getPropertyValue(MAP_RATIO_PROP)).toBe('1600 / 900');
  });

  it('断链图（像素为 0）不写比例：写了 frame 会直接塌掉，连图在哪都看不出来', () => {
    const { el } = setup();
    const img = imgOf(el);

    img.naturalWidth = 0;
    img.naturalHeight = 0;
    img.emit('load', {});

    expect(frameOf(el).style.getPropertyValue(MAP_RATIO_PROP)).toBe('');
  });
});

describe('渲染 · 显示态 · 双击落钉', () => {
  it('双击图上：换算成归一化坐标写回模型（要减掉 frame 自己的位置）', () => {
    const { el, updateContent } = setup();
    // frame 不在原点：60/20 的偏移必须减掉，否则落点会整体偏
    rectOf(el, { left: 60, top: 20, width: 200, height: 100 });
    const event = createMouseEvent({ clientX: 110, clientY: 45 }); // 帧内 (50, 25) → (0.25, 0.25)

    imgOf(el).emit('dblclick', event);

    expect(updateContent).toHaveBeenCalledWith({ pin: { x: 0.25, y: 0.25 } });
  });

  it('双击图上要吞掉事件：否则会顺手冒泡成"双击进编辑态"', () => {
    const { el } = setup();
    rectOf(el);
    const event = createMouseEvent({ clientX: 100, clientY: 50 });

    imgOf(el).emit('dblclick', event);

    expect(event.propagationStopped).toBe(true);
  });

  it('双击留白（图上那条矩形之外）：不写模型，也不吞事件', () => {
    const { el, updateContent } = setup();
    rectOf(el, { left: 0, top: 0, width: 100, height: 100 });
    const event = createMouseEvent({ clientX: 180, clientY: 50 }); // 右侧留白

    imgOf(el).emit('dblclick', event);

    expect(updateContent).not.toHaveBeenCalled();
    expect(event.propagationStopped).toBe(false); // 交给视图 → 空卡仍能双击进编辑态
  });

  it('锁定卡双击不落钉（也不吞事件，免得挡住别的交互）', () => {
    const { el, updateContent } = setup({ locked: true });
    rectOf(el);
    const event = createMouseEvent({ clientX: 100, clientY: 50 });

    imgOf(el).emit('dblclick', event);

    expect(updateContent).not.toHaveBeenCalled();
    expect(event.propagationStopped).toBe(false);
  });

  it('frame 还没上树（量出 0×0）时双击什么也不发生，不写 NaN', () => {
    const { el, updateContent } = setup();
    rectOf(el, { left: 0, top: 0, width: 0, height: 0 });

    imgOf(el).emit('dblclick', createMouseEvent({ clientX: 10, clientY: 10 }));

    expect(updateContent).not.toHaveBeenCalled();
  });
});

// ── 编辑态 ───────────────────────────────────────────────────

describe('渲染 · 编辑态', () => {
  function editSetup(options: SetupOptions = {}) {
    return setup({ ...options, mode: 'edit' });
  }

  function inputOf(el: FakeElement) {
    return el.children[0] as unknown as FakeElement & { value: string; focused: boolean };
  }

  function metaOf(el: FakeElement) {
    return el.children[1] as FakeElement;
  }

  function clearButtonOf(el: FakeElement): FakeElement | null {
    return (metaOf(el).children[1] as FakeElement | undefined) ?? null;
  }

  it('输入框预填地点名并自动聚焦（一进来就能敲）', () => {
    const { el } = editSetup({ label: '深圳湾' });
    const input = inputOf(el);

    expect(input.value).toBe('深圳湾');
    expect(input.focused).toBe(true);
  });

  it('没有图钉时元信息行说"还没标图钉"，且没有"清除"按钮可点', () => {
    const { el } = editSetup();
    expect((metaOf(el).children[0] as FakeElement).textContent).toBe(t('card.map.noPin'));
    expect(clearButtonOf(el)).toBeNull();
  });

  it('有图钉时元信息行写出百分比位置', () => {
    const { el } = editSetup({ pin: { x: 0.4, y: 0.62 } });
    expect((metaOf(el).children[0] as FakeElement).textContent).toBe(
      t('card.map.pinAt', { pin: '40% / 62%' }),
    );
  });

  it('⏎ 提交改过的地点名并退回显示态', () => {
    const { el, updateContent, setMode } = editSetup({ label: '旧名字' });
    const input = inputOf(el);
    input.value = '  新名字  '; // 前后空白顺手裁掉

    input.emit('keydown', createKeyEvent({ key: 'Enter' }));

    expect(updateContent).toHaveBeenCalledWith({ label: '新名字' });
    expect(setMode).toHaveBeenCalledWith('display');
  });

  it('没改就退：一个字都不写（否则点开又关掉也会进撤销栈）', () => {
    const { el, updateContent, setMode } = editSetup({ label: '深圳湾' });
    inputOf(el).emit('keydown', createKeyEvent({ key: 'Enter' }));

    expect(updateContent).not.toHaveBeenCalled();
    expect(setMode).toHaveBeenCalledWith('display');
  });

  it('Esc 取消：不写，并退回显示态', () => {
    const { el, updateContent, setMode } = editSetup({ label: '旧名字' });
    const input = inputOf(el);
    input.value = '新名字';

    const event = createKeyEvent({ key: 'Escape' });
    input.emit('keydown', event);

    expect(event.defaultPrevented).toBe(true);
    expect(event.propagationStopped).toBe(true); // 别让 Esc 继续冒泡去关画布
    expect(updateContent).not.toHaveBeenCalled();
    expect(setMode).toHaveBeenCalledWith('display');
  });

  it('失焦 = 提交（点卡片外面与点空白在视图那侧分不开，一律当提交）', () => {
    const { el, updateContent } = editSetup({ label: '旧名字' });
    const input = inputOf(el);
    input.value = '新名字';

    input.emit('blur', {});

    expect(updateContent).toHaveBeenCalledWith({ label: '新名字' });
  });

  it('没改就失焦也不写', () => {
    const { el, updateContent } = editSetup({ label: '深圳湾' });
    inputOf(el).emit('blur', {});
    expect(updateContent).not.toHaveBeenCalled();
  });

  it('「清除图钉」在 pointerdown 上就 preventDefault —— 否则按钮会先被 blur 抢走', () => {
    const { el, updateContent } = editSetup({ pin: { x: 0.5, y: 0.5 } });
    const clear = clearButtonOf(el);
    expect(clear).not.toBeNull();

    const event = createMouseEvent();
    clear?.emit('pointerdown', event);

    expect(event.defaultPrevented).toBe(true);
    expect(event.propagationStopped).toBe(true);
    // ★ 关键：此刻**不**写模型（清了图钉又立刻写盘会把输入框里刚敲的字冲掉）
    expect(updateContent).not.toHaveBeenCalled();
  });

  it('清除图钉之后提交：图钉与地点名一起写回（一次 commit）', () => {
    const { el, updateContent } = editSetup({ label: '旧名字', pin: { x: 0.5, y: 0.5 } });
    (clearButtonOf(el) as FakeElement).emit('pointerdown', createMouseEvent());
    const input = inputOf(el);
    input.value = '新名字';

    input.emit('keydown', createKeyEvent({ key: 'Enter' }));

    expect(updateContent).toHaveBeenCalledWith({ label: '新名字', pin: null });
  });

  it('只清图钉、地点名没改：提交里只有 pin 这一项', () => {
    const { el, updateContent } = editSetup({ label: '深圳湾', pin: { x: 0.5, y: 0.5 } });
    (clearButtonOf(el) as FakeElement).emit('pointerdown', createMouseEvent());

    inputOf(el).emit('keydown', createKeyEvent({ key: 'Enter' }));

    expect(updateContent).toHaveBeenCalledWith({ pin: null });
  });

  it('Esc 取消会把"清除图钉"一起撤掉（攒着改的全部丢弃）', () => {
    const { el, updateContent } = editSetup({ pin: { x: 0.5, y: 0.5 } });
    (clearButtonOf(el) as FakeElement).emit('pointerdown', createMouseEvent());

    inputOf(el).emit('keydown', createKeyEvent({ key: 'Escape' }));

    expect(updateContent).not.toHaveBeenCalled();
  });

  it('更小的输入框不该被卡片层抢走拖动', () => {
    const { el } = editSetup();
    const event: FakeMouseEvent = createMouseEvent();

    inputOf(el).emit('pointerdown', event);

    expect(event.propagationStopped).toBe(true);
  });
});

// ── 右键菜单 / 双击 / 导出 / 卸载 ───────────────────────────────

describe('contextMenu', () => {
  it('粘贴链接 / 换图 / 编辑内容都走具名动作（视图才拿得到弹窗、网络与选择器）', () => {
    const card = createCard('map');
    const items = mapCard.contextMenu?.(card, { multiple: false } as never) ?? [];

    expect(items.map((item) => item.action)).toEqual([
      'pasteMapLink',
      'openMapLink',
      'pickMapImage',
      'editContent',
    ]);
  });

  it('没贴过链接时「打开链接」置灰（而不是整项消失）', () => {
    const card = createCard('map');
    const items = mapCard.contextMenu?.(card, { multiple: false } as never) ?? [];
    const open = items.find((item) => item.action === 'openMapLink');

    // ★ 置灰而不是藏起来：藏起来会让"粘了一条认不出的链接"显得像什么都没发生
    expect(open?.disabled).toBe(true);
    expect(items.find((item) => item.action === 'pasteMapLink')?.disabled).not.toBe(true);
  });

  it('贴过链接之后「打开链接」按得动', () => {
    const card = createCard('map', {
      content: { path: '', label: '', pin: null, sourceUrl: 'https://maps.google.com/?q=1,2' },
    });
    const items = mapCard.contextMenu?.(card, { multiple: false } as never) ?? [];

    expect(items.find((item) => item.action === 'openMapLink')?.disabled).not.toBe(true);
  });

  it('多选时置灰（"换哪一张的图"没有答案）', () => {
    const card = createCard('map');
    const items = mapCard.contextMenu?.(card, { multiple: true } as never) ?? [];

    expect(items.every((item) => item.disabled === true)).toBe(true);
  });

  it('锁定卡同样置灰', () => {
    const card = createCard('map', { locked: true });
    const items = mapCard.contextMenu?.(card, { multiple: false } as never) ?? [];

    expect(items.every((item) => item.disabled === true)).toBe(true);
  });
});

describe('onDoubleClick（走到这里的都是留白 / 空卡）', () => {
  it('有图就打开原图看细节', () => {
    const card = createCard('map', { content: { path: 'assets/a.png' } });
    const openPath = vi.fn(async () => undefined);
    const handled = mapCard.onDoubleClick?.(card, {
      notes: { exists: () => true },
      shell: { openPath },
    } as never);

    expect(handled).toBe(true);
    expect(openPath).toHaveBeenCalledWith('assets/a.png');
  });

  it('图不在了就不装模作样地打开（交给视图走通用路径）', () => {
    const card = createCard('map', { content: { path: 'assets/gone.png' } });
    const openPath = vi.fn();
    const handled = mapCard.onDoubleClick?.(card, {
      notes: { exists: () => false },
      shell: { openPath },
    } as never);

    expect(handled).toBe(false);
    expect(openPath).not.toHaveBeenCalled();
  });

  it('空卡不接管：留给视图的"双击进编辑态"', () => {
    const card = createCard('map');
    const handled = mapCard.onDoubleClick?.(card, {
      notes: { exists: () => true },
      shell: { openPath: vi.fn() },
    } as never);

    expect(handled).toBe(false);
  });

  it('没有 shell 桥时不接管（不炸）', () => {
    const card = createCard('map', { content: { path: 'assets/a.png' } });
    const handled = mapCard.onDoubleClick?.(card, {
      notes: { exists: () => true },
    } as never);

    expect(handled).toBe(false);
  });

  // ── O08：没图但有链接时，双击 = 去地图上看 ────────────────────
  it('没图但有链接：双击用系统浏览器打开那条链接', () => {
    const card = createCard('map', {
      content: { path: '', label: '', pin: null, sourceUrl: 'https://maps.apple.com/?ll=1,2' },
    });
    const openExternal = vi.fn(async () => true);
    const handled = mapCard.onDoubleClick?.(card, { links: { openExternal } } as never);

    expect(handled).toBe(true);
    expect(openExternal).toHaveBeenCalledWith('https://maps.apple.com/?ll=1,2');
  });

  it('图在的时候双击看**图**，链接只是备选（用户双击的是他看见的东西）', () => {
    const card = createCard('map', {
      content: {
        path: 'assets/a.png',
        label: '',
        pin: null,
        sourceUrl: 'https://maps.apple.com/?ll=1,2',
      },
    });
    const openPath = vi.fn(async () => undefined);
    const openExternal = vi.fn(async () => true);
    const handled = mapCard.onDoubleClick?.(card, {
      notes: { exists: () => true },
      shell: { openPath },
      links: { openExternal },
    } as never);

    expect(handled).toBe(true);
    expect(openPath).toHaveBeenCalledWith('assets/a.png');
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('有链接但没有外链桥时不接管：交给视图的通用路径，而不是"装作做过了"', () => {
    const card = createCard('map', {
      content: { path: '', label: '', pin: null, sourceUrl: 'https://maps.apple.com/?ll=1,2' },
    });
    expect(mapCard.onDoubleClick?.(card, {} as never)).toBe(false);
  });
});

describe('toMarkdown', () => {
  it('没图也没有链接：没有可读内容，返回空串（调用方跳过）', () => {
    const card = createCard('map');
    expect(mapCard.toMarkdown(card, { sourcePath: '' })).toBe('');
  });

  // ── O08：贴过链接的卡不再是"空框"，导出时不能把它丢掉 ─────────
  it('没图但有链接且有地点名：导出成普通链接，名字当文字', () => {
    const card = createCard('map', {
      content: {
        path: '',
        label: '天安门',
        pin: null,
        sourceUrl: 'https://maps.google.com/?q=39.9042,116.4074',
        coords: { lat: 39.9042, lon: 116.4074 },
      },
    });
    expect(mapCard.toMarkdown(card, { sourcePath: '' })).toBe(
      '[天安门](https://maps.google.com/?q=39.9042,116.4074)',
    );
  });

  it('只有坐标没有链接（手改过的文件）：坐标本身就是可读内容，导出成一行纯文本', () => {
    const card = createCard('map', {
      content: { path: '', label: '', pin: null, coords: { lat: 39.9042, lon: 116.4074 } },
    });
    expect(mapCard.toMarkdown(card, { sourcePath: '' })).toBe('39.9042, 116.4074');
  });

  it('没地点名时用坐标当文字：链接不能没有可见的文字', () => {
    const card = createCard('map', {
      content: {
        path: '',
        label: '',
        pin: null,
        sourceUrl: 'https://maps.google.com/?q=39.9042,116.4074',
        coords: { lat: 39.9042, lon: 116.4074 },
      },
    });
    expect(mapCard.toMarkdown(card, { sourcePath: '' })).toBe(
      '[39.9042, 116.4074](https://maps.google.com/?q=39.9042,116.4074)',
    );
  });

  it('图钉没有 Markdown 位置，用地点名当图片标题（同图片卡的说明文字）', () => {
    const card = createCard('map', {
      content: { path: 'assets/map.png', label: '深圳湾', pin: { x: 0.4, y: 0.6 } },
    });
    expect(mapCard.toMarkdown(card, { sourcePath: '' })).toBe('![深圳湾](assets/map.png)');
  });
});

describe('destroy', () => {
  it('摘净自己的 class、占位标记与子树（复用池里的节点会串味）', () => {
    const { el } = setup({ pin: { x: 0.4, y: 0.6 } });
    el.classList.add('is-missing');
    el.dataset.placeholder = 'map';

    mapCard.destroy?.(el as unknown as HTMLElement);

    expect(el.className).toBe('');
    expect(el.dataset.placeholder).toBeUndefined();
    expect(el.children).toHaveLength(0);
  });
});
