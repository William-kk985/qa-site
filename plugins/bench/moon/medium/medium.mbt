// 体积基准的中型任务 —— MoonBit Array 版（GC 堆那一端，也是本基准的结论所在）。
//
// Array::make(n, 0.0) 走的是 MoonBit 自带的 GC 堆：**不链接系统分配器**，
// 所以同一个"要分配内存"的任务，它只扛一个紧凑的 GC 运行时（4.3KB），
// 而 Rust 要扛 dlmalloc + panic + fmt（15KB）。
//
// ⚠️ 这里是 Array 而不是 FixedArray —— 刻意选会分配的那种，好和 rust-vec 对齐。
//    三个变体算的是同一个算法，输出必须逐位相同（bench-size.sh 会验）。
// 配套阅读：plugins/BENCH.md
#export_name("hot_score")
pub fn hot_score(votes : Double, answers : Double, views : Double, age_days : Double) -> Double {
  let mut n = answers.to_int()
  if n < 1 { n = 1 }
  if n > 256 { n = 256 }
  let v : Array[Double] = Array::make(n, 0.0)
  let mut s = votes + 1.0
  let mut i = 0
  while i < n {
    s = (s * 1103515245.0 + 12345.0) % 1.0
    v[i] = s
    i = i + 1
  }
  i = 1
  while i < n {
    let key = v[i]
    let mut j = i
    while j > 0 && v[j - 1] > key {
      v[j] = v[j - 1]
      j = j - 1
    }
    v[j] = key
    i = i + 1
  }
  let mut acc = 0.0
  i = 0
  while i < n {
    acc = acc + v[i] * (i.to_double() + 1.0)
    i = i + 1
  }
  let base = votes * 3.0 + answers * 5.0 + views / 100.0
  (base + acc / 1.0e9) / (1.0 + age_days / 30.0)
}
