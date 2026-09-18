/**
 * 手绘层（T3.06 / T3.07 / T3.08 / `F4-01`、`F4-02`、`F4-04`）：Canvas + 脏区重绘 + 随视口变换。
 *
 * 位置在 `02 §2` 的层级④：**卡片之上**（`.nestboard-ink-canvas` 的 z-index 比
 * `.nestboard-world` 高）。理由是最常见的用法就是在图片卡上圈重点（T3.09）——
 * 画在卡片下面的笔迹等于没画。
 *
 * ★ 坐标系：笔画存**世界坐标**，与卡片、连线的世界坐标是同一套。
 *   于是平移 / 缩放期间不需要重算任何几何，只要让基类重绘即可 ——
 *   笔迹会像卡片一样"长在画布上"，而不是贴在屏幕上跟着手走。
 *
 * ★ 本层**不拦指针**（`pointer-events: none` 在 styles.css 里，与其它 Canvas 层一致）：
 *   笔迹要画在卡片上方，但事件必须由容器上的控制器代收（见 `InkController`），
 *   否则每一张卡片都会先吃掉笔画的第一下。
 *
 * ★ 骨架（相机跟随 / 脏区账本 / 重绘协议）都在 `DirtyCanvasLayer`，
 *   这里只回答"这一笔长什么样"与"改了一笔之后哪块脏了"。
 *   所有算术都在 `model/ink`，可单测；本文件的 Canvas 部分只能在 Obsidian 里肉眼验证。
 *
 * ★ 颜色 / 线宽 / 压感（T3.07）三条线在这里汇合，但**互不干扰**：
 *   颜色与基准线宽来自 `setStyle`（下一笔用），压感来自每个点自带的第三个元素
 *   （画的时候一并用掉）。所以"换个颜色再画"不会让已画的线变色，"换个设备再画"
 *   也不会让旧线变粗或变细。
 *
 * ★ T3.08 之后本层**只画正在画的那一笔**：抬笔就把这一笔（世界坐标）交出去
 *   （`options.onStroke`），由视图落盘成一张手绘卡。理由很硬 ——
 *   "笔迹住在哪"只能有一个答案。留在本层的内存里，就等于把同一份内容存两遍：
 *   橡皮要在两边各擦一次、改色要改两处、撤销要能同时回退两者，迟早对不上。
 *   本层因此不持有任何"已完成并落盘的笔迹"，`strokeCount` / `clearStrokes` 这类成员
 *   也随之消失（要问"有没有笔迹"，问的是模型里有没有 `ink` 卡片）。
 *
 * ★ **唯一的例外是临时标注层**（T7.07 / `F4-06`，`transient`）：它按定义就**不落盘**，
 *   所以"不留在本层"这条规矩对它不适用 —— 对它来说，留在本层**就是**唯一的那一份。
 *   上面那条"同一份内容存两遍"的顾虑在这里根本不成立（它不在模型里，没有第二份）。
 *   于是本层有了第二个成员状态：`transient`（已完成的临时笔画，仍是**世界坐标**，
 *   与正在画的那一笔同一套坐标 —— 平移缩放期间不必重算任何几何）。
 *   它的生命周期**长在手绘态上**：`InkController` 进手绘时清空、离开手绘时清空
 *   （于是票里那句「`Esc` 一键清空」自然成立），中途换笔不影响它，
 *   换板 / 关视图时随本层一起消失（`BoardView`）。
 */

import {
  DEFAULT_INK_COLOR,
  DEFAULT_INK_WIDTH,
  INK_SAMPLE_DISTANCE_PX,
  appendStroke,
  createStroke,
  isTapered,
  isTranslucent,
  removeStrokes,
  segmentDirtyRect,
  segmentWidthAt,
  shouldAppendPoint,
  strokeAlpha,
  strokeBounds,
  strokeWidthAt,
  strokesHitByEraser,
  styleAlpha,
  toInkPoint,
  type InkStyle,
} from '../../model/ink';
import type { InkPath } from '../../model/schema';
import { rectsIntersect, type Point, type Rect } from '../../util/geometry';
import { DirtyCanvasLayer } from './DirtyCanvasLayer';

/**
 * 本层要把"笔迹的生命周期"交给视图的两件事。
 *
 * ★ 为什么是回调而不是让本层直接持有卡片模型：图层的职责是"这一帧画什么"，
 *   改模型必须走 `BoardView.commit`（取快照、记撤销、触发重绘）。让图层认识
 *   `repository` 会把"一次指针事件"变成三处互相知道对方的状态变更。
 */
export interface InkLayerOptions {
  /**
   * 抬笔：把这一笔（**世界坐标**）交出去落盘。
   *
   * ★ 调用时机是"笔迹还在屏幕上"的那一瞬间，视图必须**同步**把它变成卡片 ——
   *   本层随后才清掉画布上那一笔（见 `endStroke`），顺序反了会闪一帧。
   */
  onStroke: (path: InkPath) => void;
  /** 橡皮擦到 `point`（世界坐标）：交给视图删掉对应的手绘卡，返回擦掉了几笔 */
  onErase: (point: Point, radius: number) => number;
  /**
   * 临时标注层的内容变了（T7.07）：加了一笔 / 清空 / 擦掉了一笔。
   *
   * ★ 工具条靠它同步「清空」按钮的显隐与可点性。那一层住在**本层**、不在模型里，
   *   所以没有 `mutate` 事件可订阅 —— 只能由唯一知道它变了的人（本层）出声。
   * ★ 可选：图层在单测与"临时标注没接线"的场景下也照常工作，不因为没人听就少做一件事。
   */
  onTransientChange?: () => void;
}

export class InkLayer extends DirtyCanvasLayer {
  /** 正在画的那一笔；`null` = 此刻没有笔尖按在画布上。**已完成的一律不留在本层** */
  private active: InkPath | null = null;

  /**
   * 当前画笔样式（颜色 + 基准线宽），由 `InkController` 在换笔时推过来。
   *
   * ★ 这是**下一笔**的样式，不是"整层的样式"：每一笔的 `color` / `width` 都随笔画
   *   一起交给视图存下来了（`InkPath` 自带这两个字段），所以换色之后已经画好的线不受影响。
   *   想让旧笔迹跟着变色，改的是那张卡的内容（T3.08「可改色」）。
   */
  private style: InkStyle = { color: DEFAULT_INK_COLOR, width: DEFAULT_INK_WIDTH };

  /**
   * 临时标注层（T7.07 / `F4-06`）：**已完成的、不落盘的**笔画，世界坐标。
   *
   * ★ 与 `active` 是两回事：`active` 是"笔尖此刻按着的那一笔"，这里是"抬过笔、但不该落盘的"。
   *   分开存的好处是"半途 `Esc`"有明确答案 —— `active` 会被收尾，而这里会被整体清空。
   */
  private transient: InkPath[] = [];

  /** 之后落下的笔是"交出去落盘"还是"留在 `transient`"（由 `InkController` 按笔型切换） */
  private transientEnabled = false;

  /**
   * 暂存层里最粗的一笔（世界单位），只增不减。
   *
   * ★ 只增不减：擦掉最粗的那笔之后它会**偏大**，而偏大只是清脏区时多清一点 ——
   *   安全的那一侧（少算才会留残影）。每次重绘都遍历一遍暂存层去求真实最大值，
   *   换来的是一模一样的结果，纯属白费。
   */
  private transientWidest = 0;

  constructor(
    host: HTMLElement,
    private readonly options: InkLayerOptions,
  ) {
    super(host, 'nestboard-ink-canvas');
  }

  get brushStyle(): InkStyle {
    return this.style;
  }

  /** 换画笔样式（调色板 / 笔宽档位 / `X` 换色都走这里）。只影响之后画的笔画 */
  setStyle(style: InkStyle): void {
    // 线宽是唯一能"把画布搞坏"的参数：0 或 NaN 会让笔画完全不可见（脏区也跟着算成 0）。
    // 颜色交给调用方保证（`withInkColor` 只接受规范化过的 HEX），这里只兜住宽度
    const width = Number.isFinite(style.width) && style.width > 0 ? style.width : DEFAULT_INK_WIDTH;
    // ★ `alpha` 也要跟着留住（T7.08）：只重建 `{ color, width }` 会把荧光笔悄悄变回
    //   一支不透明的画笔 —— 而且是"看不出来哪里错了"的那种错。兜底同线宽：
    //   越界 / 非有限值当缺省（不透明），绝不把"一支画不出东西的笔"（alpha 0）传下去。
    const alpha = styleAlpha(style);
    this.style = alpha < 1 ? { color: style.color, width, alpha } : { color: style.color, width };
  }

  /**
   * 切换"之后落下的笔去哪"（T7.07）：`true` = 只留在本层（临时标注），`false` = 交出去落盘。
   *
   * ★ 只切开关、**不动**已有内容：清空是 `clearTransient` 的事。两件事分开，是因为
   *   调用方有两处（换笔时只切开关、退出时既切开关又清空）；把"清空"藏进 setter，
   *   读代码的人就得多跳一层才知道东西是**什么时候**没的。
   */
  setTransient(enabled: boolean): void {
    this.transientEnabled = enabled;
  }

  /**
   * 临时标注层里有几笔（"有没有临时笔迹"问这里；"有没有落盘的笔迹"问模型）。
   *
   * ★ 是方法而不是 getter：`InkSurface`（控制器看到的窄接口）要把它与另外几个**动作**
   *   摆在一起，而"动作"在假面上就是 `vi.fn()` —— getter 没法这么伪造。
   */
  transientCount(): number {
    return this.transient.length;
  }

  /**
   * 清空临时标注层（`Esc` / 清空命令 / 离开手绘态）。返回清掉了几笔，供调用方决定要不要出声。
   *
   * ★ 逐笔标脏，而不是"把整层抹一下"：本层是**透明覆盖层**，底下压着卡片与连线，
   *   那些像素不归本层管 —— 整层 `clearRect` 会把它们一起抹掉，要等下一帧重绘才回来
   *   （表现是"清空标注"时整块画布闪一下）。按每笔的包围盒标脏，重画出来的就只是"没有笔迹"。
   */
  clearTransient(): number {
    const paths = this.transient;
    if (paths.length === 0) return 0;
    this.transient = [];
    this.transientWidest = 0;
    for (const path of paths) this.invalidate(strokeBounds(path));
    this.options.onTransientChange?.();
    return paths.length;
  }

  // ── 画笔 ────────────────────────────────────────────────

  /**
   * 落笔。`point` 是世界坐标，`pressure` 是数位笔的压感（鼠标传 `undefined`）。
   *
   * 第一点也要立刻标脏：`points.length === 1` 的笔画渲染成一个圆点，
   * "点一下必须看得见反应"，否则用户会以为画笔没生效而重复点。
   */
  beginStroke(point: Point, pressure?: number): void {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
    // 上一笔还没收尾（漏了 pointerup：切窗口、丢指针捕获）就先收掉，
    // 绝不让两笔叠在同一个 `active` 上 —— 那会让后一笔的点接进前一笔的轨迹里
    this.endStroke();

    const path = createStroke(point, this.style, pressure);
    this.active = path;
    // 脏区按**基准**线宽算：压感只会让实际线宽更细（`INK_PRESSURE_MIN ≤ 1`），
    // 于是这个矩形永远是实际笔迹的**外扩**版 —— 宁可多清一点，不能少算（少算就是残影）
    this.invalidate(segmentDirtyRect(null, point, path.width));
  }

  /** 追一个点。太近（手抖）就丢掉，见 `shouldAppendPoint` */
  extendStroke(point: Point, pressure?: number): void {
    const path = this.active;
    if (!path) return;

    // 采样阈值定在屏幕：放大到 4× 后按世界阈值采样，曲线会变成肉眼可见的折线
    const minDistance = INK_SAMPLE_DISTANCE_PX / this.safeZoom;
    if (!shouldAppendPoint(path.points, point, minDistance)) return;

    const previous = path.points[path.points.length - 1];
    // ★ 半透明笔不记压感（理由见 `createStroke`）：漏了这一处会变成"第一点没压力、
    //   后面的点有"，于是 `isTapered` 为真，又回到"逐段半透明在接缝处叠深"的老问题
    path.points.push(toInkPoint(point, isTranslucent(path) ? undefined : pressure));
    this.invalidate(segmentDirtyRect(previous, point, path.width));
  }

  /**
   * 抬笔：把这一笔交给视图落盘（临时标注态则留在本层），并清掉画布上那一笔。
   *
   * ★ 只交接、**不回滚**已经画出来的部分：中途按 `Esc` 退出时，
   *   屏幕上已经看得见的那半笔就该留下 —— 用户看到什么就是什么，
   *   悄悄撤掉一条自己刚画的线比留着它更让人困惑。
   *   （临时标注态是唯一例外，而且两件事不冲突：那半笔会被收进 `transient`，
   *   而 `Esc` 紧接着就把整层清空 —— 见 `clearTransient`。）
   * ★ 顺序是"先交出笔迹、后清画布"：交出去会**同步**建出手绘卡（卡片 DOM 立刻挂上），
   *   这时再清画布，画布上那一笔正好被下面那张卡顶替 —— 逐像素重合，看不出来。
   *   反过来（先清后交）会有一帧"画布空了、卡片还没出来"，笔迹闪一下。
   */
  endStroke(): void {
    const path = this.active;
    if (!path) return;
    this.active = null;
    // ★ 临时标注（T7.07）：这一笔**不交给视图**，就留在本层（见文件头那个"唯一例外"）。
    //   它不进模型 ⇒ 不进撤销栈、不落盘、不进导出与缩略图，全都自动成立，一行都不用写。
    if (this.transientEnabled) {
      this.transient = appendStroke(this.transient, path);
      this.transientWidest = Math.max(this.transientWidest, path.width);
      this.invalidate(strokeBounds(path));
      this.options.onTransientChange?.();
      return;
    }
    this.options.onStroke(path);
    this.invalidate(strokeBounds(path));
  }

  // ── 橡皮 ────────────────────────────────────────────────

  /**
   * 擦掉经过 `point` 的笔画（整笔删除，语义见 `model/ink.ts` 的 `strokesHitByEraser`）。
   * 返回擦掉了几笔，供调用方决定要不要出声。
   *
   * ★ 真正的判定在视图那边：要擦的是**卡片**，而卡片属于模型层。
   *   本层只把世界坐标的点转交出去。
   * ★ 例外是临时标注态：那些笔就在本层，视图擦不到，所以这里自己判、自己删。
   */
  eraseAt(point: Point, radius: number): number {
    if (this.transientEnabled) return this.eraseTransient(point, radius);
    return this.options.onErase(point, radius);
  }

  private eraseTransient(point: Point, radius: number): number {
    const hits = strokesHitByEraser(this.transient, point, radius);
    if (hits.length === 0) return 0;
    // 脏区必须在**删掉之前**算：删完再问"这几笔原来在哪"就问不到了。
    // ★ 一次性收集再统一标脏（而不是"删一笔标一次"）：脏区机制会把相邻矩形合并，
    //   分几次标会多算几次合并，而结果一样
    const dirty = hits.map((index) => strokeBounds(this.transient[index]));
    this.transient = removeStrokes(this.transient, hits);
    for (const box of dirty) this.invalidate(box);
    this.options.onTransientChange?.();
    return hits.length;
  }

  // ── 绘制 ────────────────────────────────────────────────

  protected clearPaddingPx(): number {
    // 笔宽是**世界**单位：3px 的笔在 4× 下屏幕上是 12px，
    // 清脏区时死记一个常量（连线层用的是 8）就会在放大后留下擦不掉的残影边
    return Math.ceil(this.widestWidth() * this.safeZoom) + 4;
  }

  protected paintContent(region: Rect): void {
    // ★ 临时标注（T7.07）住在本层，所以每次重绘都得自己画回来 —— 这就是
    //   "图层持有内容"要付的全部代价（其余一切照旧：脏区照算、坐标照世界）。
    //   先画暂存的、再画正在画的：与"落笔顺序"一致，后画的一笔压在上面
    for (const path of this.transient) {
      const box = strokeBounds(path);
      if (!box || !rectsIntersect(box, region)) continue;
      this.drawPath(path);
    }

    const path = this.active;
    if (!path) return;
    const box = strokeBounds(path);
    // 包围盒都算不出来（空笔画）就跳过；画在 region 之外纯属白费（下一帧就清了）
    if (!box || !rectsIntersect(box, region)) return;
    this.drawPath(path);
  }

  /**
   * 画一笔（只管"透明度 + 上下文收尾"）。
   *
   * ★ 透明度用 `globalAlpha`，**不是**把 alpha 揉进 `path.color`：颜色要与文件里
   *   的值逐字节一致（改色 / 去重 / diff 都靠它），而且"同一支颜色换个不透明度"
   *   不需要第二套颜色表示法（`HexColor` 没有 alpha 通道）。
   * ★ `save` / `restore` 必须**成对包住整个绘制**：`globalAlpha` 是上下文状态，
   *   漏了它，紧接着重绘的连线与卡片会一起变成半透明 —— 而且只在"有荧光笔"时才犯，
   *   特别难查。所以真正落笔的部分抽到 `paintStroke`，让本函数只有一个出口。
   */
  private drawPath(path: InkPath): void {
    if (path.points.length === 0) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = strokeAlpha(path);
    this.paintStroke(path);
    ctx.restore();
  }

  /** 真正落笔：所有提前返回都在这一层里面（于是调用方的 `save` / `restore` 不会被绕过） */
  private paintStroke(path: InkPath): void {
    const ctx = this.ctx;
    const first = path.points[0];
    if (!first) return;

    ctx.strokeStyle = path.color;
    ctx.fillStyle = path.color;
    ctx.lineWidth = path.width;
    // 圆头圆角：手绘线不该有方头与尖角（那是图表的画法，不是笔迹的画法）
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (path.points.length === 1) {
      // 一个点 = 圆点。`beginPath` 之后没有 `lineTo` 的路径 `stroke()` 什么都不画，
      // 所以"点一下"必须走 `arc + fill`，否则单击没有任何反馈
      ctx.beginPath();
      ctx.arc(first[0], first[1], Math.max(strokeWidthAt(path, 0), 0.5) / 2, 0, Math.PI * 2);
      ctx.fill();
      return;
    }

    if (!isTapered(path)) {
      // 一条 path 一次 `stroke()`：鼠标笔迹与所有不支持压感的设备都走这条路，
      // 这是 Canvas 画手绘线最快的方式。半透明笔（荧光笔）**永远**走这一支 ——
      // 它不记压感，而且逐段半透明会在接缝处叠深（见 `createStroke`）
      ctx.beginPath();
      ctx.moveTo(first[0], first[1]);
      for (let index = 1; index < path.points.length; index += 1) {
        ctx.lineTo(path.points[index][0], path.points[index][1]);
      }
      ctx.stroke();
      return;
    }

    this.drawTaperedPath(path);
  }

  /**
   * 带压感的笔画：**逐段**描边，每段一个 `lineWidth`。
   *
   * ★ Canvas 的一条路径只能有一个线宽，所以"粗细连续变化"只能拆段。
   *   代价是每段一次 `beginPath` / `stroke`，但段数 = 采样点数
   *   （`INK_SAMPLE_DISTANCE_PX` 的间距下画满一屏也就几百段），而且只有数位笔走这条路 ——
   *   鼠标笔迹仍是单次描边，不会因为加了压感就整体变慢。
   * ★ 圆头 + 相邻段在端点处重叠：接缝是"圆头压圆头"，看不到断口。
   *   换成方头会在拐弯的外侧露出一个个小缺口。
   */
  private drawTaperedPath(path: InkPath): void {
    const ctx = this.ctx;
    for (let index = 1; index < path.points.length; index += 1) {
      const from = path.points[index - 1];
      const to = path.points[index];
      ctx.lineWidth = Math.max(segmentWidthAt(path, index), 0.2);
      ctx.beginPath();
      ctx.moveTo(from[0], from[1]);
      ctx.lineTo(to[0], to[1]);
      ctx.stroke();
    }
  }

  // ── 小工具 ──────────────────────────────────────────────

  /** 视口倍率兜底为 1：`zoom` 为 0 会让采样阈值变成 `Infinity`（笔"画不动"且毫无提示） */
  private get safeZoom(): number {
    return this.cameraZoom > 0 ? this.cameraZoom : 1;
  }

  /** 最粗的一笔（世界单位）。同时照看"手里这支笔"、"正在画的那一笔"与暂存层 */
  private widestWidth(): number {
    // ★ 把"手里这支笔"也算进去：换到最粗的档但还没落笔时，清脏区的余量必须已经跟上，
    //   否则新笔第一段会紧贴脏区边界（屏幕像素一取整就被裁掉一条边）
    let widest = Math.max(DEFAULT_INK_WIDTH, this.style.width);
    if (this.active) widest = Math.max(widest, this.active.width);
    // ★ 暂存的笔也算进去（T7.07）：清掉一笔更粗的临时标注时余量不够，边缘会留残影
    widest = Math.max(widest, this.transientWidest);
    return Math.max(widest, 1);
  }
}
