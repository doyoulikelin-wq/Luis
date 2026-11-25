# 触摸失活测试记录 · 2026-11-26

播放器基线为 [d535b3f](https://github.com/doyoulikelin-wq/Luis/tree/d535b3fa0fb3eeab0bf92712dd650d1e8cdddf28/platform/web/window)。Chromium 158.0.8127.37 使用 390 × 844 CSS px、DPR 1 的触屏模拟视口。全量基线跑在本机静态服务，公开 GitHub Pages 的 HTML、CSS、字体、三个 JS 文件及角色图共七个文件逐项 SHA-256 一致。另在公开 URL 对历史返回执行了浏览器自动化输入配对。公开预览、恢复阶梯及 Safari 是同一播放器上的独立补测，单独计数。

## 计数

Chromium 共 **79 个用例、每项两轮**，其中 4 项是观察器校准。158 次执行中，**138 通过、18 失败、2 未验证、0 执行错误**。通过次数包括观察器正确识别故障样本。每个失败用例仍独立记录后续新手势是否能用。

| 类别 | 用例数 | 通过次数 | 失败次数 | 未验证次数 | 执行错误 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 评测器校准 | 4 | 8 | 0 | 0 | 0 |
| 加载与连续使用 | 6 | 10 | 2 | 0 | 0 |
| 手势识别与输入排队 | 24 | 40 | 8 | 0 | 0 |
| 触点所有权 | 14 | 24 | 4 | 0 | 0 |
| 浏览器滚动与缩放 | 5 | 10 | 0 | 0 | 0 |
| 状态 × 终止事件 | 16 | 32 | 0 | 0 | 0 |
| 页面生命周期及渲染 | 10 | 14 | 4 | 2 | 0 |

普通版、透明层遮住触摸区、监听器吞下按下、固定帧盖住动画四项校准均有已知预期结果。

## 哪些故障影响下一次触摸

| 触发方式 | 对照及实际现象 | 影响 |
| --- | --- | --- |
| 同一旧触点的松手与失去指针捕获均被测试夹具截断 | 只截断松手时，浏览器仍发送失去捕获，控制器正常释放。两种终态都截断时，新的可信主指针已命中小窗，角色仍保持旧 drag。iOS 模拟器的应用事件回放也复现。 | 原触点已经结束，新触摸无法接管。此例是容错压力条件。 |
| 持按时离开，在另一页向浏览器发送松手，再通过历史返回 | 两轮均确认从浏览器往返缓存恢复。页面显示 idle，新的可信 down 命中 avatar，但被标为非主触点。原页先松手再离开则正常。公开预览上的两次配对也得到相同结果。 | 新手势无法接管。该结果限定于 Chromium 自动化输入与当前播放器组合。 |
| 仅发送带 persisted 标志的页面离开/返回信号，省略其他释放通知 | 原触点还保持 hold，后续新的主指针也被拒绝。真实浏览器缓存过程通常有更多生命周期信号，此行单独施加缺信号条件。 | 应用层故障注入，可独立验证恢复清理。 |

### 恢复需要多少干预

另用两轮独立场景复查两个会挡住下一次触摸的故障。每一级都重新检查新指送达、受理、左右可见变化和释放，成功即停止试验。四次切换标签均观察到可信的失焦与重新获焦，并确认返回同一份文档。

| 故障 | 第一次新指 | 第二次新指 | 实际切标签再回来 | 刷新页面 |
| --- | --- | --- | --- | --- |
| 同时吞掉旧指的两个终态 | 两轮均失败，新指为主触点 | 两轮均失败 | 两轮均恢复 | 前一级已恢复，到此停止 |
| Chromium 持按离页后缓存返回 | 两轮均失败，新指为非主触点 | 两轮均失败 | 两轮仍失败 | 两轮均恢复，新主触点重新生效 |

结果给出了在这些步骤中首次奏效的干预，持续时长只覆盖观察窗口。驱动在另一页处于前台时发出松手请求，另一页的 DOM 未记录到对应的终止事件。[逐级恢复证据](recovery-ladder.json)

## 哪些问题在抬手后恢复

| 操作 | 实测 |
| --- | --- |
| 短划之前先反向轻移 | 反向 7 CSS px 时可跟随主要滑动方向；反向 14 CSS px 时，左右镜像都锁在最先越过门槛的方向。先移动进入短划、持续按住后折返也锁在原方向。已经进入长按拖拽后，多次反向及停住再动可用。 |
| 第一指停在窗外，第二指在窗内操作 | 浏览器送达次触点，播放器忽略它。两指全部抬起后新触摸正常。这属于窗内与窗外触点归属的产品策略。 |
| 从素材就绪前一直按到就绪后 | 按下发生在控制器接入前，即使继续移动也不能在本次触摸内接管。松开重按恢复；如果在素材就绪前已经松开，加载后没有幽灵操作。 |
| 主线程被人为阻塞 480 ms 时短按 | 两轮事件时间戳对应 81 / 82 ms，处理时间跨度为 498 / 499 ms。短按进入长按分支，点按未触发。正常投递的同长度短按通过，新触点也能继续工作。 |

## 已验证的对照与证据边界

- 四个活跃手势状态分别遇到松手、取消、失去捕获、失焦。完整二维矩阵的逐格结果见下表。点按和短划允许走原有收尾动画，随后再验证计时器已经清理及下一次接管。
- 纵向拖动 120 CSS px 时，默认窗内滚动量为 0；允许浏览器接管后发生页面滚动并产生真实 pointercancel。默认两指外扩不改变视口缩放；允许原生缩放后，两指都收到取消。最初的缩放夹具没有把视觉视口恢复至 1，新探针打到错误位置。夹具增加实际缩放倍率检查，恢复探针增加命中位置检查。表中为修正后全套用例的两轮结果。[初次夹具记录](superseded-arbitration.json.gz)
- 独立强制冻结在这个执行环境没有留下可信的 freeze/resume 事件，故单列未验证。真实浏览器缓存往返样本另外记录到了对应事件。浏览器识别为可信的触摸来自自动化输入栈。
- iPhone 17 Pro 模拟器、iOS 26.3.1、Safari 26.3 共 9 项，8 通过、1 失败。按下/长按/拖拽取消、失去捕获、实际刷新、缓存返回、切换 Safari 标签、切到系统设置再返回均通过；省略全部终态时失败。原生 WebDriver 校准只观察到可信按下；这九项的触摸都用应用内 PointerEvent 回放。Safari 生命周期动作实际发生。模拟器执行左→右→松手并采样当前角色画布中的双眼位置，Chromium 恢复探针执行左→右→左并采样浏览器合成画面。两组单独报告。[Safari 证据](safari-simulator.json)
- 真机边缘手势、锁屏、系统来电、操作系统杀进程和重建、Android WebView、原生 iOS 容器以及手指触达到面板显示的绝对延迟仍缺少设备数据。[真机执行表](../device-protocol.md)

## 逐项结果

contract 为既有契约，policy 为候选产品策略，fault 为故障条件。时间、事件、每条断言与具体恢复层可在原始记录按 id 和 iteration 查找。[Chromium 完整记录（gzip JSON）](chromium.json.gz) · [公开预览的配对记录](github-pages.json)

| 类别 | 操作或问题 | 用例 ID | 判据 | 第一轮 | 第二轮 |
| --- | --- | --- | --- | --- | --- |
| 评测器校准 | 正常角色接受新的手势，实际左右画面可区分，同侧复测一致。 | `healthy-reference` | contract | 通过 | 通过 |
| 评测器校准 | 测试夹具吞掉按下事件。观察器应检出控制失败。 | `swallowed-input-control` | contract | 通过 | 通过 |
| 评测器校准 | 透明遮挡层截获浏览器命中，评测应定位到被遮挡的触摸区域。 | `covered-hit-surface-control` | contract | 通过 | 通过 |
| 评测器校准 | 手势和动画状态继续更新，屏幕覆盖一张固定帧；应仅判显示停滞。 | `frozen-presentation-control` | contract | 通过 | 通过 |
| 加载与连续使用 | 资源未就绪时已经松开的手指不会在加载后生成幽灵操作。 | `release-before-ready` | contract | 通过 | 通过 |
| 加载与连续使用 | 产品候选：加载完成时仍在窗内按住并移动，应能在同一触摸内取得控制。 | `held-across-readiness` | policy | 失败 | 失败 |
| 加载与连续使用 | 素材失败时提供可操作的重试入口；故障解除后能重新接管。 | `recover-from-texture-error` | fault | 通过 | 通过 |
| 加载与连续使用 | 资源已加载时断网，触摸、释放及后续接管继续工作。 | `offline-after-ready` | contract | 通过 | 通过 |
| 加载与连续使用 | 禁用 WebGL 后，2D 回退仍接受触点且画面持续可控。 | `canvas2d-fallback` | contract | 通过 | 通过 |
| 加载与连续使用 | 同一页面连续多轮点击、拖动、滑动和取消，每次新的按下都接管，旧计时器不污染末次释放。 | `repeated-sequences` | contract | 通过 | 通过 |
| 手势识别与输入排队 | 短接触移动 9 CSS px 后松开，识别为 tap | `slop-9px` | contract | 通过 | 通过 |
| 手势识别与输入排队 | 短接触移动 10 CSS px 后松开，识别为 tap | `slop-10px` | contract | 通过 | 通过 |
| 手势识别与输入排队 | 短接触移动 11 CSS px 后松开，识别为 swipe | `slop-11px` | contract | 通过 | 通过 |
| 手势识别与输入排队 | 保持静止允许持续长按，离开容差后能开始跟随，再回到起点仍能更新 | `stationary-hold-small-drag` | contract | 通过 | 通过 |
| 手势识别与输入排队 | 长按后四个象限反复换向，中间停住，再次移动无需重新落指 | `drag-pause-and-mirrored-reversals` | contract | 通过 | 通过 |
| 手势识别与输入排队 | 短时间多次反向后，渲染目标收敛到最后的触点 | `rapid-drag-roundtrip` | contract | 通过 | 通过 |
| 手势识别与输入排队 | 交替轻点四次且每次都在上一反应结束前重新按下，新触点都能接管 | `repeat-tap-preempts-tail` | contract | 通过 | 通过 |
| 手势识别与输入排队 | tap松手后即使没有后续输入，也要自行释放并回正，旧状态不能再次出现 | `unattended-release-tap` | contract | 通过 | 通过 |
| 手势识别与输入排队 | hold松手后即使没有后续输入，也要自行释放并回正，旧状态不能再次出现 | `unattended-release-hold` | contract | 通过 | 通过 |
| 手势识别与输入排队 | drag松手后即使没有后续输入，也要自行释放并回正，旧状态不能再次出现 | `unattended-release-drag` | contract | 通过 | 通过 |
| 手势识别与输入排队 | swipe松手后即使没有后续输入，也要自行释放并回正，旧状态不能再次出现 | `unattended-release-swipe` | contract | 通过 | 通过 |
| 手势识别与输入排队 | 前一tap的回正期限不能覆盖新的长按或拖拽 | `tap-tail-with-new-hold` | contract | 通过 | 通过 |
| 手势识别与输入排队 | 前一swipe的回正期限不能覆盖新的长按或拖拽 | `swipe-tail-with-new-hold` | contract | 通过 | 通过 |
| 手势识别与输入排队 | 单次短划以显著净位移为意图，逆向轻移后应采用主方向 | `main-swipe-left-after-7px` | policy | 通过 | 通过 |
| 手势识别与输入排队 | 单次短划以显著净位移为意图，逆向轻移后应采用主方向 | `main-swipe-right-after-7px` | policy | 通过 | 通过 |
| 手势识别与输入排队 | 单次短划以显著净位移为意图，逆向轻移后应采用主方向 | `main-swipe-left-after-14px` | policy | 失败 | 失败 |
| 手势识别与输入排队 | 单次短划以显著净位移为意图，逆向轻移后应采用主方向 | `main-swipe-right-after-14px` | policy | 失败 | 失败 |
| 手势识别与输入排队 | 用户持续触摸并改为跟随时，应有机会从先前认定的滑动恢复 | `early-move-pause-then-retarget` | policy | 失败 | 失败 |
| 手势识别与输入排队 | 仅抬起事件带有最终位移时仍能识别一次滑动 | `release-only-displacement` | contract | 通过 | 通过 |
| 手势识别与输入排队 | 无移动，实际接触时间位于长按门槛下方时仍确认点按 | `stationary-release-320ms` | contract | 通过 | 通过 |
| 手势识别与输入排队 | 无移动，实际接触时间位于长按门槛上方时确认长按并释放 | `stationary-release-380ms` | contract | 通过 | 通过 |
| 手势识别与输入排队 | 拖动时主线程阻塞，同一次触摸的折返和松手相继排队，恢复后能结束且不会重播过期拖动 | `release-queued-behind-drag` | fault | 通过 | 通过 |
| 手势识别与输入排队 | 事件时间中 80 ms 短按在正常投递时有点按响应 | `short-tap-load-control` | contract | 通过 | 通过 |
| 手势识别与输入排队 | 主线程一次性阻塞 480 ms，已按下又松开的短触点仍按物理输入时长识别 | `short-tap-blocked-delivery` | fault | 失败 | 失败 |
| 触点所有权 | 从四个边界分别拖出并返回，持有者仍能控制 | `outside-return` | contract | 通过 | 通过 |
| 触点所有权 | 拖到黑窗外再松开，原手势退出 | `outside-release` | contract | 通过 | 通过 |
| 触点所有权 | 窗外起手再进窗，无幽灵按下 | `outside-start` | contract | 通过 | 通过 |
| 触点所有权 | 一指停在窗外，另一指能否在窗内操作 | `outside-resting-contact` | policy | 失败 | 失败 |
| 触点所有权 | 遗漏按下，仅有移动和抬起，不生成幽灵触点 | `orphan-move-up` | fault | 通过 | 通过 |
| 触点所有权 | 次指先抬起，不影响主指 | `secondary-first-up` | contract | 通过 | 通过 |
| 触点所有权 | 主指先抬起，剩余触点不会维持旧拖动 | `owner-first-up` | contract | 通过 | 通过 |
| 触点所有权 | 系统取消双指输入，旧触点释放 | `multi-system-cancel` | contract | 通过 | 通过 |
| 触点所有权 | 单独取消次指，主指仍能控制 | `nonowner-cancel` | contract | 通过 | 通过 |
| 触点所有权 | 原指失去捕获，之后的移动不会复活旧手势 | `lost-capture` | contract | 通过 | 通过 |
| 触点所有权 | 上一触点迟到的终止事件不会终止新触点 | `stale-terminal` | contract | 通过 | 通过 |
| 触点所有权 | 手指持按时，鼠标不能夺取控制 | `mixed-mouse-touch` | contract | 通过 | 通过 |
| 触点所有权 | 仅丢松手，依靠失去捕获释放旧手势 | `missing-up` | fault | 通过 | 通过 |
| 触点所有权 | 同时丢松手与失去捕获，检查新主指接管 | `missing-up-and-capture-loss` | fault | 失败 | 失败 |
| 浏览器滚动与缩放 | 默认黑窗内竖划由角色接收，页面保持位置 | `browser-pan-inside-none` | contract | 通过 | 通过 |
| 浏览器滚动与缩放 | 允许原生滚动时，浏览器接管窗内竖划并真实取消指针，角色能放手 | `browser-pan-inside-auto` | contract | 通过 | 通过 |
| 浏览器滚动与缩放 | 从黑窗外起手，同一页面能原生滚动，角色不会抢占指针 | `browser-pan-outside` | contract | 通过 | 通过 |
| 浏览器滚动与缩放 | 黑窗默认双指外扩不放大视口，两根触点结束后角色可恢复 | `browser-pinch-none` | contract | 通过 | 通过 |
| 浏览器滚动与缩放 | 允许缩放时由浏览器接管两根触点，角色解除按压 | `browser-pinch-auto` | contract | 通过 | 通过 |
| 状态 × 终止事件 | press 收到 release 后退场；旧长按/收尾计时器不得重新夺取下一次触摸。 | `press-release-matrix` | contract | 通过 | 通过 |
| 状态 × 终止事件 | press 收到 cancel 后退场；旧长按/收尾计时器不得重新夺取下一次触摸。 | `press-cancel-matrix` | contract | 通过 | 通过 |
| 状态 × 终止事件 | press 收到 capture-loss 后退场；旧长按/收尾计时器不得重新夺取下一次触摸。 | `press-capture-loss-matrix` | contract | 通过 | 通过 |
| 状态 × 终止事件 | press 收到 blur 后退场；旧长按/收尾计时器不得重新夺取下一次触摸。 | `press-blur-matrix` | contract | 通过 | 通过 |
| 状态 × 终止事件 | hold 收到 release 后退场；旧长按/收尾计时器不得重新夺取下一次触摸。 | `hold-release-matrix` | contract | 通过 | 通过 |
| 状态 × 终止事件 | hold 收到 cancel 后退场；旧长按/收尾计时器不得重新夺取下一次触摸。 | `hold-cancel-matrix` | contract | 通过 | 通过 |
| 状态 × 终止事件 | hold 收到 capture-loss 后退场；旧长按/收尾计时器不得重新夺取下一次触摸。 | `hold-capture-loss-matrix` | contract | 通过 | 通过 |
| 状态 × 终止事件 | hold 收到 blur 后退场；旧长按/收尾计时器不得重新夺取下一次触摸。 | `hold-blur-matrix` | contract | 通过 | 通过 |
| 状态 × 终止事件 | drag 收到 release 后退场；旧长按/收尾计时器不得重新夺取下一次触摸。 | `drag-release-matrix` | contract | 通过 | 通过 |
| 状态 × 终止事件 | drag 收到 cancel 后退场；旧长按/收尾计时器不得重新夺取下一次触摸。 | `drag-cancel-matrix` | contract | 通过 | 通过 |
| 状态 × 终止事件 | drag 收到 capture-loss 后退场；旧长按/收尾计时器不得重新夺取下一次触摸。 | `drag-capture-loss-matrix` | contract | 通过 | 通过 |
| 状态 × 终止事件 | drag 收到 blur 后退场；旧长按/收尾计时器不得重新夺取下一次触摸。 | `drag-blur-matrix` | contract | 通过 | 通过 |
| 状态 × 终止事件 | swipe 收到 release 后退场；旧长按/收尾计时器不得重新夺取下一次触摸。 | `swipe-release-matrix` | contract | 通过 | 通过 |
| 状态 × 终止事件 | swipe 收到 cancel 后退场；旧长按/收尾计时器不得重新夺取下一次触摸。 | `swipe-cancel-matrix` | contract | 通过 | 通过 |
| 状态 × 终止事件 | swipe 收到 capture-loss 后退场；旧长按/收尾计时器不得重新夺取下一次触摸。 | `swipe-capture-loss-matrix` | contract | 通过 | 通过 |
| 状态 × 终止事件 | swipe 收到 blur 后退场；旧长按/收尾计时器不得重新夺取下一次触摸。 | `swipe-blur-matrix` | contract | 通过 | 通过 |
| 页面生命周期及渲染 | 另一个标签获得焦点后，即使原指没有送达抬起，回来也能恢复。 | `tab-focus-roundtrip` | contract | 通过 | 通过 |
| 页面生命周期及渲染 | 只送达隐藏和恢复信号也会撤销长按计时及原接触。 | `visibility-without-terminal` | contract | 通过 | 通过 |
| 页面生命周期及渲染 | 浏览器确实冻结期间用户松手，恢复后不会保留旧拖拽。 | `freeze-resume` | contract | 未验证 | 未验证 |
| 页面生命周期及渲染 | 刷新时的旧触点不会占用重新载入的页面。 | `reload-during-contact` | contract | 通过 | 通过 |
| 页面生命周期及渲染 | 先抬手再离开，返回后可按住、拖动、抬起，作为缓存路径的配对对照。 | `navigate-back-after-release` | contract | 通过 | 通过 |
| 页面生命周期及渲染 | 离开时未松手，离开后抬起，再返回后可接受新接触。 | `navigate-back-during-contact` | contract | 失败 | 失败 |
| 页面生命周期及渲染 | 若仅投递缓存离开/返回事件而抬起、失焦和隐藏都缺失，旧指不能永久阻塞新指。 | `persisted-page-only-no-release` | fault | 失败 | 失败 |
| 页面生命周期及渲染 | 拖动中说明弹窗抢占界面，在弹窗内抬起，关闭后小窗可继续使用。 | `modal-during-drag` | contract | 通过 | 通过 |
| 页面生命周期及渲染 | 拖动中画面改为横屏尺寸，允许取消，或用新边界继续跟随并在抬起时退出。 | `resize-during-drag` | contract | 通过 | 通过 |
| 页面生命周期及渲染 | 图形上下文丢失时仍处理抬起，上下文恢复后画布有内容且新手势有效。 | `webgl-loss-release-restore` | contract | 通过 | 通过 |
