// 体积基准的中型任务 —— Rust Vec 版（"一动堆就暴涨"的那一端）。
//
// 和 rust-fixed 那份是**同一个算法、同一套 Cargo profile**，只把
// [f64; 256] 换成 Vec：结果链接进了 dlmalloc 分配器、panic 机制和格式化
// 代码，体积从 533 B 涨到 15KB 级。
//
// ⚠️ 这个体积**不是 Rust 的硬下限**：换 wee_alloc 之类的小分配器、或者上
//    #![no_std] 都能压下去 —— 但那是要手动配置的 opt-in，而 MoonBit 那份
//    什么都不用配就是 4KB。详见 plugins/BENCH.md（那里也写明了哪些数字实测过、
//    哪些没测到）。
#[no_mangle]
pub extern "C" fn hot_score(votes: f64, answers: f64, views: f64, age_days: f64) -> f64 {
    let mut n = answers as i64; if n < 1 { n = 1; } if n > 256 { n = 256; }
    let n = n as usize;
    let mut v: Vec<f64> = Vec::with_capacity(n);
    let mut s = votes + 1.0;
    for _ in 0..n { s = (s * 1103515245.0 + 12345.0).fract(); v.push(s); }
    for i in 1..n { let key = v[i]; let mut j = i;
        while j > 0 && v[j-1] > key { v[j] = v[j-1]; j -= 1; } v[j] = key; }
    let mut acc = 0.0;
    for i in 0..n { acc += v[i] * (i as f64 + 1.0); }
    let base = votes * 3.0 + answers * 5.0 + views / 100.0;
    (base + acc / 1e9) / (1.0 + age_days / 30.0)
}
