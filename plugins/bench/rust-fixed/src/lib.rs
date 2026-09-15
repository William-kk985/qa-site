// 体积基准的中型任务 —— Rust 固定数组版（对照组）。
//
// 和 rust-vec 那份是**同一个算法、同一套 Cargo profile**，只差数组放栈上
// （[f64; 256]）还是放堆上（Vec）—— 这是刻意的：唯一变量只有一个，
// 体积差才只能归因到分配器，而不是构建参数。
//
// ⚠️ 不用 Vec 的收益是数量级的：一旦分配内存，dlmalloc + panic + fmt 会被
//    整个拖进来，体积从几百字节涨到 15KB 级（实测见 plugins/BENCH.md）。
#[no_mangle]
pub extern "C" fn hot_score(votes: f64, answers: f64, views: f64, age_days: f64) -> f64 {
    let mut n = answers as i64; if n < 1 { n = 1; } if n > 256 { n = 256; }
    let n = n as usize;
    let mut v = [0.0f64; 256];
    let mut s = votes + 1.0;
    for i in 0..n { s = (s * 1103515245.0 + 12345.0).fract(); v[i] = s; }
    for i in 1..n { let key = v[i]; let mut j = i;
        while j > 0 && v[j-1] > key { v[j] = v[j-1]; j -= 1; } v[j] = key; }
    let mut acc = 0.0;
    for i in 0..n { acc += v[i] * (i as f64 + 1.0); }
    let base = votes * 3.0 + answers * 5.0 + views / 100.0;
    (base + acc / 1e9) / (1.0 + age_days / 30.0)
}
