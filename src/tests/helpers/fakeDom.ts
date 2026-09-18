/**
 * 最小假 DOM（T1.32 / T1.33 的编辑器与卡片定义共用）。
 *
 * 单测跑在 node 环境，没有 DOM —— 但"卡片编辑"的行为恰恰是**对 DOM 的改写**
 * （插入前缀、移动光标、保住撤销栈）。与其起 jsdom 去模拟整套浏览器，
 * 不如只造出被用到的那几个能力：读写 `value`、读写选区、派发事件、`execCommand`。
 *
 * 两条刻意的设计：
 *
 *  * **`execCommand('insertText')` 是"忠实"实现**（真的按选区替换文本，并记下调用次数），
 *    否则单测只能覆盖到降级路径，而生产环境走的正是 `execCommand` 那条；
 *  * 假节点在传给被测代码前都断言成真类型，所以**方法签名不必与真实 DOM 对齐** ——
 *    假 DOM 只服务于断言，不服务于类型。
 */

export interface FakeDocument {
  /** `focus()` 会更新它；`execCommand` 只作用于它（与浏览器一致） */
  activeElement: FakeTextarea | null;
  /** `execCommand('insertText')` 的调用次数：用来证明"优先走原生插入" */
  insertTextCalls: number;
  createElement(tag: string): unknown;
  /**
   * 命名空间元素。手绘卡渲染的 `<svg>` 只能这么造（`createElementNS(SVG_NS, 'svg')`），
   * 而它身上的 `viewBox` / `preserveAspectRatio` 正是"卡片框 == 笔迹包围盒"的落点。
   */
  createElementNS(namespace: string, tag: string): unknown;
  /** 占位文字用的最小文本节点（卡片用 `replaceChildren(createTextNode(...))` 画空态） */
  createTextNode(text: string): unknown;
  execCommand?: (command: string, ui?: boolean, value?: string) => boolean;
}

export interface FakeStyle {
  setProperty: (name: string, value: string) => void;
  getPropertyValue: (name: string) => string;
  removeProperty: (name: string) => void;
  /** 直接属性赋值（`el.style.width = '50%'`）也能落进来 */
  [key: string]: unknown;
}

export interface FakeElement {
  dataset: Record<string, string>;
  textContent: string;
  className: string;
  /** 悬停提示（断链总览的行把它设成完整路径，画面上那行是被省略号裁掉的） */
  title: string;
  /**
   * 原生 `hidden`（断链总览的「修复引用」用它表达"此刻修不了"）。
   *
   * ★ 只是个普通可写属性就够：真实 DOM 里 `hidden` 还**反射**成同名属性，
   *   但我们既不给它写 CSS 属性选择器的测试，也不读 `attributes`，
   *   所以不必模拟反射 —— 模拟了反而多一份可能与真实行为不同步的真相。
   *   （`styles.css` 里确有一条 `[hidden]` 规则，那是给浏览器看的。）
   */
  hidden: boolean;
  /**
   * 原生 `disabled`（工具条的「清空」用它表达"此刻没有笔迹可清"）。
   *
   * ★ 和 `hidden` 一样只做普通可写属性：真实的 `disabled` 还会让浏览器**不再派发
   *   `click`**，这一条在假 DOM 里复现不了（也没有点击冒泡）—— 所以断言分成两处写：
   *   这里只看"属性写没写对"，而"点不动就不派发"由被测代码自己那道 `if` 兜底并单独断言。
   */
  disabled: boolean;
  children: unknown[];
  /**
   * 极简 `CSSStyleDeclaration`。
   *
   * ★ 只给 `setProperty` / `getPropertyValue` 就够（卡片代码一律走
   *   `style.setProperty('width', …)`）：裁剪把"整图放大多少"写成**行内**样式，
   *   断言"到底写了哪几个值"是唯一能在 node 下验证裁剪几何的方式。
   */
  style: FakeStyle;
  classList: {
    add: (...names: string[]) => void;
    remove: (...names: string[]) => void;
    contains: (name: string) => boolean;
    /** 与浏览器一致：给了 `force` 就听 `force`，否则按当前状态取反 */
    toggle: (name: string, force?: boolean) => boolean;
  };
  /** `setAttribute` 的落点（`dataset` 只管 `data-*` 的直接赋值） */
  attributes: Map<string, string>;
  /**
   * 标签名（大写，与真 DOM 一致）。
   *
   * ★ 加它是因为**一次真实报障**：大纲的行首圆点 / 三角当初建成 `<button>`，于是被
   *   Obsidian 自带的 `button:not(.clickable-icon) { background-color: … }`（特异性 0,1,1）
   *   糊上一层底色 —— 插件自己的类（0,1,0）压不住它。改成 `<span role="button">` 之后
   *   才干净。有了 `tagName`，这类"**元素类型本身**就是坑"的回归才拦得住
   *   （光断言 class / 属性是看不出来的）。
   */
  tagName: string;
  appendChild: (child: unknown) => void;
  /** 原生多参版本（`el.append(a, b, c)`）：过滤条 / 断链总览用它一次挂一排孩子 */
  append: (...nodes: unknown[]) => void;
  replaceChildren: (...nodes: unknown[]) => void;
  setAttribute: (name: string, value: string) => void;
  getAttribute: (name: string) => string | null;
  addEventListener: (type: string, listener: (event: never) => void) => void;
  /** 摘监听（取色会话退出时要摘干净：没摘掉的下一次点击会被采两次） */
  removeEventListener: (type: string, listener: (event: never) => void) => void;
  /** 测试专用：手动派发一个事件给已注册的监听器 */
  emit: (type: string, event: unknown) => void;
  /**
   * `createElement('input')` 用到的三个能力（地图卡的"地点名"是单行输入框，
   * 不是 textarea —— 那里 `⏎` 就该提交，不该换行）。
   *
   * ★ 为什么不把 `input` 也做成 `FakeTextarea`：`FakeTextarea` 没有 `classList` /
   *   `style` / `appendChild`，而卡片代码对创建出来的节点普遍要用这几个（见下方
   *   `createElement` 的注释）。给普通元素补上"输入框那点皮毛"是代价最小的一步。
   * ★ `focus()` **不**动 `doc.activeElement`：那一项是给 `execCommand` 用的，
   *   它只对 textarea 有意义（这里更不该假装聚焦，免得别的测试读到假状态）。
   */
  value: string;
  placeholder: string;
  /** `focus()` 是否被调用过 */
  focused: boolean;
  focus: () => void;
  /**
   * 全选输入框内容。标题类输入框在进入编辑时用它：原名要能被一键覆写
   * （`CardLayer.editTitle` / 待办卡的标题框 / 栏与分组的改名输入框）。
   *
   * ★ 假 DOM **不模拟选区**（`selectionStart/End` 那套只服务于 `execCommand`，
   *   而它长在 `FakeTextarea` 上），所以这里是空实现 —— 它只为"代码能一路跑下去"
   *   存在。这些地方的单测断言的是"谁拿到了焦点、值写对没有"，
   *   "全选了没有"在浏览器里肉眼可见，靠断言复现也不会有更多信息。
   */
  select: () => void;
  ownerDocument: FakeDocument;
  /** 父节点：`remove()` 靠它把自己从父节点的 `children` 里摘掉 */
  parentNode: FakeElement | null;
  /**
   * `parentElement`：与 `parentNode` **同一个节点**。
   *
   * ★ 真实 DOM 里两者只在"父节点不是元素"（`DocumentFragment` / `Document`）时才不同，
   *   假 DOM 里没有那种父节点，所以直接别名过去即可 —— 卡片代码用哪个都该跑得通
   *   （`O33` 的色卡要顺着 `parentElement` 认卡片外壳）。
   */
  readonly parentElement: FakeElement | null;
  /** 从父节点摘掉自己（卡片 / 浮层在 `dispose()` 里用它） */
  remove: () => void;
  /**
   * 自己是不是 `node` 的祖先（含自身）。
   *
   * ★ 工具条的**事件委托**要用它做归属校验："这个按钮是不是我这条工具条里的"——
   *   只靠 `closest('button')` 不够：将来工具条被嵌进别处时，别的界面的按钮
   *   也会被这条委托吃到（`InkBar.onClick`）。
   * ★ 顺着 `parentNode` 往上走而不是递归 `children`：假 DOM 的父子关系是双向记的
   *   （`appendChild` 同时写 `children` 与 `parentNode`），往上走只需要一个字段，
   *   而且循环深度天然等于树高。
   */
  contains: (node: unknown) => boolean;
}

export interface FakeTextarea {
  className: string;
  value: string;
  placeholder: string;
  spellcheck: boolean;
  /** `input[type=checkbox]` 用的勾选态（`textarea` 用不到，默认 false） */
  checked: boolean;
  selectionStart: number;
  selectionEnd: number;
  /** `focus()` 是否被调用过（编辑器靠它把光标放到位） */
  focused: boolean;
  ownerDocument: FakeDocument;
  /** `setAttribute` 的落点（编辑器 / 评论卡给输入框挂 `aria-label` 这类无障碍属性） */
  attributes: Map<string, string>;
  setAttribute: (name: string, value: string) => void;
  getAttribute: (name: string) => string | null;
  setSelectionRange: (start: number, end: number) => void;
  addEventListener: (type: string, listener: (event: never) => void) => void;
  focus: () => void;
  /** 测试专用：手动派发一个事件给已注册的监听器 */
  emit: (type: string, event: unknown) => void;
}

export function createFakeDocument(options: { withExecCommand?: boolean } = {}): FakeDocument {
  const withExecCommand = options.withExecCommand ?? true;
  const doc: FakeDocument = {
    activeElement: null,
    insertTextCalls: 0,
    // ★ 按标签分派，**不要**把每个标签都当 textarea：卡片代码里
    //   `box.appendChild(...)` 这类写法要求创建出来的节点自己也能挂孩子。
    //   全给 textarea 的话这类代码一跑就炸，而它在真浏览器里完全正常 ——
    //   单测会因此冤枉一段好代码
    createElement: (tag: string) =>
      tag === 'textarea' ? createFakeTextarea(doc) : createFakeElement(doc, tag),
    // SVG 元素与普通元素共用同一套假节点：断言只看 `setAttribute` 落下来的
    // `viewBox` / `d` / `stroke-width`，命名空间的差别在这里没有意义
    createElementNS: (_namespace: string, _tag: string) => createFakeElement(doc),
    // 文本节点只被断言用到（`nodeType === 3`、`textContent`），不需要挂孩子
    createTextNode: (text: string) => ({ nodeType: 3, textContent: text }),
  };

  if (withExecCommand) {
    doc.execCommand = (command: string, _ui?: boolean, value?: string): boolean => {
      if (command !== 'insertText') return false;
      const el = doc.activeElement;
      // 真实浏览器里失焦时 `execCommand` 会返回 false 而不做事 —— 编辑器正是靠
      // "文本有没有真变"来识破"返回 true 却没插入"的实现，这里照实模拟
      if (!el) return false;

      const text = String(value ?? '');
      const start = el.selectionStart;
      el.value = el.value.slice(0, start) + text + el.value.slice(el.selectionEnd);
      el.setSelectionRange(start + text.length, start + text.length);
      doc.insertTextCalls += 1;
      return true;
    };
  }

  return doc;
}

export function createFakeTextarea(doc: FakeDocument): FakeTextarea {
  const listeners = new Map<string, (event: never) => void>();
  const attributes = new Map<string, string>();
  const textarea: FakeTextarea = {
    className: '',
    value: '',
    placeholder: '',
    spellcheck: true,
    checked: false,
    selectionStart: 0,
    selectionEnd: 0,
    focused: false,
    ownerDocument: doc,
    attributes,
    setAttribute: (name, value) => {
      attributes.set(name, value);
    },
    getAttribute: (name) => attributes.get(name) ?? null,
    setSelectionRange: (start, end) => {
      textarea.selectionStart = start;
      textarea.selectionEnd = end;
    },
    addEventListener: (type, listener) => {
      listeners.set(type, listener);
    },
    focus: () => {
      textarea.focused = true;
      doc.activeElement = textarea;
    },
    emit: (type, event) => {
      listeners.get(type)?.(event as never);
    },
  };
  return textarea;
}

export function createFakeElement(doc: FakeDocument, tag = 'div'): FakeElement {
  const classes = new Set<string>();
  const attributes = new Map<string, string>();
  const listeners = new Map<string, (event: never) => void>();
  const children: unknown[] = [];
  let text = '';
  const style: FakeStyle = {
    // `setProperty` 与直接赋值写进同一份记录：卡片代码两种写法都能用
    setProperty: (name, value) => {
      style[name] = value;
    },
    getPropertyValue: (name) => (typeof style[name] === 'string' ? (style[name] as string) : ''),
    removeProperty: (name) => {
      delete style[name];
    },
  };
  const element: FakeElement = {
    dataset: {},
    style,
    get textContent(): string {
      return text;
    },
    /**
     * ★ 给 `textContent` 赋值在真实 DOM 里会**抹掉全部子节点**，卡片代码普遍依赖这个
     *   语义（`el.textContent = ''` 之后再挂新内容）。不模拟的话，同一个槽位被重复
     *   渲染时旧节点会留在 `children` 里 —— 测试就会看到"上一帧的残留"，
     *   于是要么断言写得很别扭，要么干脆漏掉一个真实存在的 bug。
     */
    set textContent(value: string) {
      text = value;
      children.length = 0;
    },
    /**
     * ★ `className` 与 `classList` 必须是**同一份真相**（真实 DOM 里 `className` 就是
     *   class 列表的字符串视图）。早先它俩各存各的，于是"设了 `className`、
     *   查 `classList` 却是空"—— 一个只在测试里存在的失败，冤枉的却是浏览器里
     *   完全正常的代码（卡片大量用 `el.className = '…'` 起头）。
     */
    get className(): string {
      return [...classes].join(' ');
    },
    set className(value: string) {
      classes.clear();
      for (const name of value.split(/\s+/)) {
        if (name.length > 0) classes.add(name);
      }
    },
    children,
    attributes,
    tagName: tag.toUpperCase(),
    title: '',
    hidden: false,
    disabled: false,
    classList: {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      contains: (name) => classes.has(name),
      toggle: (name, force) => {
        const next = force ?? !classes.has(name);
        if (next) classes.add(name);
        else classes.delete(name);
        return next;
      },
    },
    appendChild: (child) => {
      children.push(child);
      (child as FakeElement).parentNode = element;
    },
    append: (...nodes) => {
      for (const node of nodes) element.appendChild(node);
    },
    replaceChildren: (...nodes) => {
      children.length = 0;
      children.push(...nodes);
      for (const node of nodes) (node as FakeElement).parentNode = element;
    },
    setAttribute: (name, value) => {
      attributes.set(name, value);
    },
    getAttribute: (name) => attributes.get(name) ?? null,
    addEventListener: (type, listener) => {
      listeners.set(type, listener);
    },
    removeEventListener: (type) => {
      listeners.delete(type);
    },
    emit: (type, event) => {
      listeners.get(type)?.(event as never);
    },
    ownerDocument: doc,
    value: '',
    placeholder: '',
    focused: false,
    focus: () => {
      element.focused = true;
    },
    select: () => {},
    parentNode: null,
    // 见接口上的说明：假 DOM 里"父节点"永远是元素，两个名字指同一个东西
    get parentElement(): FakeElement | null {
      return element.parentNode;
    },
    remove: () => {
      const parent = element.parentNode;
      if (!parent) return;
      const index = parent.children.indexOf(element);
      if (index >= 0) parent.children.splice(index, 1);
      element.parentNode = null;
    },
    contains: (node) => {
      let cursor = (node as FakeElement | null)?.parentNode ?? null;
      while (cursor) {
        if (cursor === element) return true;
        cursor = cursor.parentNode;
      }
      return false;
    },
  };
  return element;
}

export interface FakeKeyEventInit {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
}

export interface FakeKeyEvent extends FakeKeyEventInit {
  defaultPrevented: boolean;
  propagationStopped: boolean;
  preventDefault: () => void;
  stopPropagation: () => void;
}

export interface FakeMouseEventInit {
  clientX?: number;
  clientY?: number;
}

export interface FakeMouseEvent extends Required<FakeMouseEventInit> {
  defaultPrevented: boolean;
  propagationStopped: boolean;
  preventDefault: () => void;
  stopPropagation: () => void;
}

/**
 * 最小鼠标事件（双击落图钉要读 `clientX/clientY`，还要断言"吞没吞掉事件"）。
 * 与 `createKeyEvent` 同一套写法：坐标 + 两个可观测的副作用。
 */
export function createMouseEvent(init: FakeMouseEventInit = {}): FakeMouseEvent {
  const event: FakeMouseEvent = {
    clientX: 0,
    clientY: 0,
    ...init,
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault: () => {
      event.defaultPrevented = true;
    },
    stopPropagation: () => {
      event.propagationStopped = true;
    },
  };
  return event;
}

export function createKeyEvent(init: FakeKeyEventInit): FakeKeyEvent {
  const event: FakeKeyEvent = {
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    isComposing: false,
    keyCode: 0,
    ...init,
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault: () => {
      event.defaultPrevented = true;
    },
    stopPropagation: () => {
      event.propagationStopped = true;
    },
  };
  return event;
}
