// 示例插件（C++ 写的）—— 和 C / MoonBit / Rust / TS 那几版**语义完全一样**。
//
// 编译（纯 clang++ 就够，不需要 wasi-sdk）：
//   clang++ --target=wasm32 -nostdlib -O2 -B<放着 wasm-ld 的目录> \
//           -Wl,--no-entry -Wl,--export=theme -Wl,--export=hot_score \
//           -o ../prebuilt/cpp.wasm example.cpp
//
// 或者直接 `bash plugins/build.sh`（它会自己找工具链）。
//
// ⚠️ C++ 有两个坑：
//   1. 必须 extern "C" —— 否则 C++ 会做 name mangling，
//      导出的名字会变成 _Z5themei 这种，插件约定就对不上了。
//   2. 别用 iostream / std::string 之类 —— 它们要 libc++，
//      -nostdlib 下链不上。纯数字运算用不上它们。
//
// ⚠️ 它只在你自己的浏览器里跑，别人看不到、也影响不到别人。

// ---------------------------------------------------------------------------
// ① 外观插件：theme(i) -> double
//    i 是槽位号；返回**负数 = 这个槽位用站点默认值**。
//    槽位表和范围见 plugins/README.md（网页上的「插件」页签里也有一份）。
// ---------------------------------------------------------------------------
extern "C" __attribute__((export_name("theme")))
double theme(int i) {
  switch (i) {
    case 0: return 152.0;   // 主题色 色相 0–360（152 ≈ 森林绿）
    case 1: return 0.62;    // 主题色 饱和度 0–1
    case 2: return 0.42;    // 主题色 亮度 0–1
    case 3: return 2.0;     // 圆角 px 0–24（2 ≈ 接近直角）
    case 4: return 1240.0;  // 页面最大宽度 px 700–1600
    case 5: return 17.0;    // 正文字号 px 12–20
    case 6: return 22.0;    // 卡片内边距 px 0–40
    case 7: return 16.0;    // 列表间距 px 0–30
    default: return -1.0;   // 没定义的槽位 → 用默认
  }
}

// ---------------------------------------------------------------------------
// ② 逻辑插件：hot_score(点赞, 回答, 浏览, 距今天数) -> 热度分
//    替换「热门」标签的排序算法，越大越靠前。
// ---------------------------------------------------------------------------
extern "C" __attribute__((export_name("hot_score")))
double hot_score(double votes, double answers, double views, double age_days) {
  const double base = votes * 3.0 + answers * 5.0 + views / 100.0;
  // 时间衰减：30 天前发的，热度打对折，防止老帖永远霸榜
  return base / (1.0 + age_days / 30.0);
}
