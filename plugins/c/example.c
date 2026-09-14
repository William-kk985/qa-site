/* 示例插件（C 写的）—— 和 MoonBit / Rust / C++ / TS 那几版**语义完全一样**。
 *
 * 编译（不需要 wasi-sdk，纯 clang 就够）：
 *   clang --target=wasm32 -nostdlib -O2 -B<放着 wasm-ld 的目录> \
 *         -Wl,--no-entry -Wl,--export=theme -Wl,--export=hot_score \
 *         -o ../prebuilt/c.wasm example.c
 *
 * 或者直接 `bash plugins/build.sh`（它会自己找工具链）。
 *
 * 关键点：
 *   · --target=wasm32      编到 wasm 而不是本机
 *   · -nostdlib            不链 libc —— 我们的 ABI 是纯数字，用不上
 *   · -Wl,--no-entry       没有 main()，别报"找不到入口"
 *   · export_name 属性     决定导出到 .wasm 导出表里的名字（下面那两个名字
 *                          就是插件约定，不能改）
 *
 * ⚠️ 它只在你自己的浏览器里跑，别人看不到、也影响不到别人。
 */

/* ---------------------------------------------------------------------------
   ① 外观插件：theme(i) -> double
   i 是槽位号；返回**负数 = 这个槽位用站点默认值**，所以可以只改想改的。
   槽位表和范围见 plugins/README.md（网页上的「插件」页签里也有一份）。
   --------------------------------------------------------------------------- */
__attribute__((export_name("theme")))
double theme(int i) {
  if (i == 0) return 152.0;   /* 主题色 色相 0–360（152 ≈ 森林绿） */
  if (i == 1) return 0.62;    /* 主题色 饱和度 0–1 */
  if (i == 2) return 0.42;    /* 主题色 亮度 0–1 */
  if (i == 3) return 2.0;     /* 圆角 px 0–24（2 ≈ 接近直角） */
  if (i == 4) return 1240.0;  /* 页面最大宽度 px 700–1600 */
  if (i == 5) return 17.0;    /* 正文字号 px 12–20 */
  if (i == 6) return 22.0;    /* 卡片内边距 px 0–40 */
  if (i == 7) return 16.0;    /* 列表间距 px 0–30 */
  return -1.0;                /* 没定义的槽位 → 用默认 */
}

/* ---------------------------------------------------------------------------
   ② 逻辑插件：hot_score(点赞, 回答, 浏览, 距今天数) -> 热度分
      替换「热门」标签的排序算法，越大越靠前。
   --------------------------------------------------------------------------- */
__attribute__((export_name("hot_score")))
double hot_score(double votes, double answers, double views, double age_days) {
  double base = votes * 3.0 + answers * 5.0 + views / 100.0;
  /* 时间衰减：30 天前发的，热度打对折，防止老帖永远霸榜 */
  return base / (1.0 + age_days / 30.0);
}
