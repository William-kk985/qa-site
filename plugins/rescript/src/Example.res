/* 示例插件（ReScript 写的）—— 和 C / C++ / MoonBit / Rust / TS 那几版**语义完全一样**。
 *
 * ⚠️ 和 TypeScript 一样，**ReScript 不能直接编成 wasm**，它编成 JS：
 *
 *     rescript build  →  Example.mjs  →  在网站里上传这个 .mjs
 *
 *   网站有两个插件后端（.wasm 和 .js），ABI 完全一样，只是跑的沙箱不同。
 *
 * 编译：
 *   cd plugins/rescript && rescript build
 *   # 产物在 lib/es6/src/Example.mjs
 *
 * 或者直接 `bash plugins/build.sh`。
 *
 * ⚠️ ReScript 里浮点运算要写成 `+.` `*.` `/.`（带点），
 *    整数才是 `+` `*` `/` —— 写错了编译器会直接报类型错，不会默默算错。
 *
 * ⚠️ 它只在你自己的浏览器里跑，别人看不到、也影响不到别人。
 *    但 JS 插件跑在页面里（不像 wasm 有沙箱），
 *    **别上传别人给你的 .js / .mjs** —— 那等于把账号交给对方。
 */

// ---------------------------------------------------------------------------
// ① 外观插件：theme(i) -> float
//    i 是槽位号；返回**负数 = 这个槽位用站点默认值**。
//    槽位表和范围见 plugins/README.md（网页上的「插件」页签里也有一份）。
// ---------------------------------------------------------------------------
@export
let theme = (i: int): float =>
  switch i {
  | 0 => 152.0   // 主题色 色相 0–360（152 ≈ 森林绿）
  | 1 => 0.62    // 主题色 饱和度 0–1
  | 2 => 0.42    // 主题色 亮度 0–1
  | 3 => 2.0     // 圆角 px 0–24（2 ≈ 接近直角）
  | 4 => 1240.0  // 页面最大宽度 px 700–1600
  | 5 => 17.0    // 正文字号 px 12–20
  | 6 => 22.0    // 卡片内边距 px 0–40
  | 7 => 16.0    // 列表间距 px 0–30
  | _ => -1.0    // 没定义的槽位 → 用默认
  }

// ---------------------------------------------------------------------------
// ② 逻辑插件：hot_score(点赞, 回答, 浏览, 距今天数) -> 热度分
//    替换「热门」标签的排序算法，越大越靠前。
// ---------------------------------------------------------------------------
@export
let hot_score = (
  votes: float,
  answers: float,
  views: float,
  ageDays: float,
): float => {
  let base = votes *. 3.0 +. answers *. 5.0 +. views /. 100.0
  // 时间衰减：30 天前发的，热度打对折，防止老帖永远霸榜
  base /. (1.0 +. ageDays /. 30.0)
}

// ===========================================================================
// ③ 搜索相关度打分：search_score(query, text) -> float
// ---------------------------------------------------------------------------
// ReScript 编成 JS，所以字符串是原生的 —— 不需要 wasm 那套 qa_buffer 协议。
// 直接借宿主的 TextEncoder 把字符串转成 UTF-8 字节，保证和 C/C++/Rust
// 那一侧**逐位一致**（按 ReScript 字符串遍历的话，中文会对不上）。
// ===========================================================================

type textEncoder

@new external makeEncoder: unit => textEncoder = "TextEncoder"

// ⚠️ TextEncoder.encode 返回的是 Uint8Array，这里标成 array<int> 是个"善意的谎言"：
//    两者在下标访问和 .length 上行为完全一样，而 ReScript 不做运行时类型检查。
//    真写一个 Uint8Array 类型绑定要绕一圈，不值得。
@send external encode: (textEncoder, string) => array<int> = "encode"

let qaEncoder: textEncoder = makeEncoder()

let qaLower = b => if b >= 65 && b <= 90 { b + 32 } else { b }

@export
let search_score = (query: string, text: string): float => {
  let q = encode(qaEncoder, query)
  let t = encode(qaEncoder, text)
  let qLen = Array.length(q)
  if qLen == 0 {
    0.0
  } else {
    let tLen = Array.length(t)
    let score = ref(0.0)
    for i in 0 to qLen - 1 {
      let c = qaLower(Array.getUnsafe(q, i))
      if c != 32 {
        let n = ref(0.0)
        for j in 0 to tLen - 1 {
          if qaLower(Array.getUnsafe(t, j)) == c {
            n := n.contents +. 1.0
          }
        }
        score := score.contents +. n.contents
      }
    }
    score.contents /. Int.toFloat(qLen)
  }
}
