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

// ===========================================================================
// ③ 搜索相关度打分：search_score(qLen, tLen) -> f64
//    协议说明见 c/example.c 的注释（三个 wasm 语言用的是同一套）。
//    这边多一个 Rust 特有的坑：静态可变缓冲区要拿指针，得用 addr_of_mut!，
//    不能写 `&mut QA_BUF` —— 那会创建一个对 static mut 的引用，
//    新版 Rust 会直接报错（static_mut_refs）。
// ===========================================================================
const QA_BUF_SIZE: usize = 65536;
static mut QA_BUF: [u8; QA_BUF_SIZE] = [0; QA_BUF_SIZE];

#[no_mangle]
pub extern "C" fn qa_buffer() -> *mut u8 {
    // SAFETY: wasm 是单线程的，插件只被 JS 同步调用，不存在并发访问；
    //         返回裸指针给宿主写数据是这套协议的全部目的。
    unsafe { core::ptr::addr_of_mut!(QA_BUF) as *mut u8 }
}

#[inline]
fn qa_lower(c: u8) -> u8 {
    if c.is_ascii_uppercase() { c + 32 } else { c }
}

#[no_mangle]
pub extern "C" fn search_score(q_len: i32, t_len: i32) -> f64 {
    if q_len <= 0 { return 0.0; }
    if (q_len + t_len) as usize > QA_BUF_SIZE { return f64::NAN; }

    /* ⚠️ 这里**刻意用裸指针**，而不是 `&buf[..n]` 那样切片。
       切片下标会做越界检查，一越界就 panic —— 而 panic 会把整套格式化机制
       链进来，产物从几百字节直接涨到 ~15KB（实测 274 B → 14977 B）。
       这正好印证了 plugins/BENCH.md 里那条结论：**Rust 的体积拐点在"要不要
       链运行时"**，而"用不用堆"只是其中一种触发方式，panic 是另一种。

       SAFETY: 上面已经确认 q_len + t_len 不越界；
       wasm 是单线程、插件只被 JS 同步调用，指针在整个循环里有效。 */
    let base = unsafe { core::ptr::addr_of!(QA_BUF) as *const u8 };
    let mut score = 0.0f64;
    for i in 0..q_len {
        let c = qa_lower(unsafe { *base.offset(i as isize) });
        if c == b' ' { continue; }
        let mut n = 0f64;
        for j in 0..t_len {
            if qa_lower(unsafe { *base.offset((q_len + j) as isize) }) == c { n += 1.0; }
        }
        score += n;
    }
    score / q_len as f64
}
