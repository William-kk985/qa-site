// MoonBit 实现的「热门排序打分」插件。
//
// 编译：见 ../build.sh（或手动 `moon build --target wasm`）
// 产物：hot.wasm，导出 hot_score，被 js 端的 app.js 通过 WebAssembly 调用。
//
// 为什么选这个函数：数字进、数字出，WASM 边界最简单 ——
// 不用传字符串、不用管内存，任何语言都好实现。

#export_name("hot_score")
pub fn hot_score(votes : Double, answers : Double, views : Double, age_days : Double) -> Double {
  // 基础分：点赞权重最高，回答次之，浏览量权重最低
  let base = votes * 3.0 + answers * 5.0 + views / 100.0
  // 时间衰减：30 天前的热度打对折，防止老帖永远占榜首
  let decay = 1.0 / (1.0 + age_days / 30.0)
  base * decay
}
