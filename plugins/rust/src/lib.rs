// 示例插件（Rust 写的）—— 和 C / C++ / MoonBit / TS / ReScript 那几版**语义完全一样**。
//
// 编译：
//   rustup target add wasm32-unknown-unknown          # 只需一次
//   cd plugins/rust && cargo build --release --target wasm32-unknown-unknown
//   # 产物：target/wasm32-unknown-unknown/release/qa_plugin_example.wasm
//
// 或者直接 `bash plugins/build.sh`。
//
// ⚠️ 三个关键点：
//   1. `crate-type = ["cdylib"]`（在 Cargo.toml 里）—— 否则编不出 .wasm
//   2. `#[no_mangle]` —— 否则 Rust 会做 name mangling，
//      导出的名字就不是 theme / hot_score 了，插件约定对不上
//   3. `extern "C"` —— 用 C 的调用约定，和 wasm 的 f64 ABI 对齐
//
// ⚠️ 它只在你自己的浏览器里跑，别人看不到、也影响不到别人。

/// ① 外观插件：theme(i) -> f64
///
/// i 是槽位号；返回**负数 = 这个槽位用站点默认值**，所以可以只改想改的。
/// 槽位表和范围见 plugins/README.md（网页上的「插件」页签里也有一份）。
#[no_mangle]
pub extern "C" fn theme(i: f64) -> f64 {
    // i 是槽位号，是整数值，但 ABI 上走 f64 —— 所以这里要转一下
    match i as i32 {
        0 => 152.0,  // 主题色 色相 0–360（152 ≈ 森林绿）
        1 => 0.62,   // 主题色 饱和度 0–1
        2 => 0.42,   // 主题色 亮度 0–1
        3 => 2.0,    // 圆角 px 0–24（2 ≈ 接近直角）
        4 => 1240.0, // 页面最大宽度 px 700–1600
        5 => 17.0,   // 正文字号 px 12–20
        6 => 22.0,   // 卡片内边距 px 0–40
        7 => 16.0,   // 列表间距 px 0–30
        _ => -1.0,   // 没定义的槽位 → 用默认
    }
}

/// ② 逻辑插件：hot_score(点赞, 回答, 浏览, 距今天数) -> 热度分
///
/// 替换「热门」标签的排序算法，越大越靠前。
#[no_mangle]
pub extern "C" fn hot_score(votes: f64, answers: f64, views: f64, age_days: f64) -> f64 {
    let base = votes * 3.0 + answers * 5.0 + views / 100.0;
    // 时间衰减：30 天前发的，热度打对折，防止老帖永远霸榜
    base / (1.0 + age_days / 30.0)
}
