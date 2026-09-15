// 示例插件（MoonBit 写的）—— 演示两种可以替换的东西。
//
// 编译：bash plugins/build.sh
// 产物：plugins/example.wasm，在网站的「自定义外观」→「插件」页签里上传。
//
// ⚠️ 它只在你自己的浏览器里跑，别人看不到、也影响不到别人。

// ============================================================================
// ① 外观插件：theme(i) -> f64
//
// 为什么用「数字槽位」而不是返回字符串 / JSON：
//   · 不用传字符串 → 不用管 WASM 内存、不用编码转换
//   · 任何语言实现起来都是"返回几个数字"，五行就能写完
//   · 通用 JS 那一层负责把数字翻译成 CSS（见 app.js 的 wasmThemeToCss）
//
// 约定：返回**负数或 NaN = 这个槽位用站点默认值**，所以你可以只改想改的。
// ============================================================================
#export_name("theme")
pub fn theme(index : Int) -> Double {
  if index == 0 { 152.0 }        // 主题色 色相 0–360（152 ≈ 森林绿）
  else if index == 1 { 0.62 }    // 主题色 饱和度 0–1
  else if index == 2 { 0.42 }    // 主题色 亮度 0–1
  else if index == 3 { 2.0 }     // 圆角 px 0–24（2 ≈ 接近直角）
  else if index == 4 { 1240.0 }  // 页面最大宽度 px 700–1600
  else if index == 5 { 17.0 }    // 正文字号 px 12–20
  else if index == 6 { 22.0 }    // 卡片内边距 px 0–40
  else if index == 7 { 16.0 }    // 列表间距 px 0–30
  else { -1.0 }                  // 没定义的槽位 → 用默认
}

// ============================================================================
// ② 逻辑插件：hot_score(点赞, 回答, 浏览, 距今天数) -> 热度分
//    替换「热门」标签的排序算法。
// ============================================================================
#export_name("hot_score")
pub fn hot_score(votes : Double, answers : Double, views : Double, age_days : Double) -> Double {
  let base = votes * 3.0 + answers * 5.0 + views / 100.0
  // 时间衰减：30 天前发的，热度打对折，防止老帖永远霸榜
  let decay = 1.0 / (1.0 + age_days / 30.0)
  base * decay
}

// ===========================================================================
// ③ 搜索相关度打分：search_score(q_len, t_len) -> Double
// ---------------------------------------------------------------------------
// 和 C / C++ / Rust 用同一套缓冲区协议（说明见 c/example.c 的长注释）：
//   qa_buffer() 给出缓冲区地址，JS 把 query 和 text 的 UTF-8 字节写进去，
//   再调 search_score(qLen, tLen)。
//
// ⚠️ 我一开始以为 MoonBit 做不到这个 —— 因为标准库里确实**没有取地址的接口**
//    （core 里全量搜 *_ptr 是零命中）。但那只查了运行时 API，漏了两条路：
//      ① moon.pkg 的 link 配置里有 `export-memory-name`，写了才会导出内存
//      ② MoonBit 支持 **inline wasm**：`extern "wasm" fn f() = #|(func ...)`
//         可以直接写 wasm 指令，于是「返回一个常量地址」「从地址读一个字节」
//         这两件事都能表达
//    两条合起来，协议就成立了。教训：**别只查 API，也要查构建配置。**
//
// ⚠️ 缓冲区地址（下面 QA_BUF）必须和 moon.pkg 里的 heap-start-address 对上：
//    缓冲区放在堆下面，堆从 256KB 开始，缓冲区占 128KB~256KB。
//    改一个就要改另一个，不然会互相踩。
// ===========================================================================
const QA_BUF : Int = 131072          // 128KB —— 要和 moon.pkg 的 heap-start-address 配合
const QA_BUF_SIZE : Int = 131072     // 128KB

extern "wasm" fn qa_buf_addr() -> Int =
  #|(func (result i32) (i32.const 131072))

extern "wasm" fn qa_load8(addr : Int) -> Int =
  #|(func (param i32) (result i32) local.get 0 i32.load8_u)

fn qa_lower(c : Int) -> Int { if c >= 65 && c <= 90 { c + 32 } else { c } }

#export_name("qa_buffer")
pub fn qa_buffer() -> Int { qa_buf_addr() }

#export_name("search_score")
pub fn search_score(q_len : Int, t_len : Int) -> Double {
  if q_len <= 0 { return 0.0 }
  if q_len + t_len > QA_BUF_SIZE { return 0.0 }
  let text_base = QA_BUF + q_len
  let mut score = 0.0
  let mut i = 0
  while i < q_len {
    let c = qa_lower(qa_load8(QA_BUF + i))
    if c != 32 {
      let mut n = 0.0
      let mut j = 0
      while j < t_len {
        if qa_lower(qa_load8(text_base + j)) == c { n = n + 1.0 }
        j = j + 1
      }
      score = score + n
    }
    i = i + 1
  }
  score / q_len.to_double()
}
