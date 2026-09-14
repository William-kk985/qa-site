/* 示例插件（TypeScript 写的）—— 和 C / C++ / MoonBit / Rust 那几版**语义完全一样**。
 *
 * ⚠️ 先说清楚一件事：**TypeScript 不能直接编成 wasm。**
 *    （AssemblyScript 是另一个东西 —— 它长得像 TS，但其实是独立语言。）
 *    所以 TS 走的不是 wasm 那条路，而是：
 *
 *        tsc  →  example.js  →  在网站里上传这个 .js
 *
 *    网站有**两个插件后端**：.wasm 和 .js，ABI 完全一样（导出 theme / hot_score）。
 *    只是后端不同：wasm 跑在沙箱里碰不到页面，JS 跑在页面里、权限更大。
 *    ReScript 同理 —— 它也编 JS，所以也走这条路。
 *
 * 编译：
 *   tsc example.ts --target es2020 --module es2020 --outDir ../prebuilt-ts
 *   # 然后把 ../prebuilt-ts/example.js 传上去
 *
 * 或者直接 `bash plugins/build.sh`。
 *
 * ⚠️ 上传的 .js 会被当成 **ES Module** 加载（也兼容 CommonJS），
 *    所以请用 `export function` 导出，而不是 `window.theme = ...`。
 *
 * ⚠️ 它只在你自己的浏览器里跑，别人看不到、也影响不到别人。
 *    但正因为 JS 跑在页面里（不像 wasm 有沙箱），
 *    **别上传别人给你的 .js** —— 那等于把账号交给对方。
 */
/* ---------------------------------------------------------------------------
   ① 外观插件：theme(i) -> number
   i 是槽位号；返回**负数 = 这个槽位用站点默认值**，所以可以只改想改的。
   槽位表和范围见 plugins/README.md（网页上的「插件」页签里也有一份）。
   --------------------------------------------------------------------------- */
export function theme(i) {
    switch (i) {
        case 0: return 152.0; // 主题色 色相 0–360（152 ≈ 森林绿）
        case 1: return 0.62; // 主题色 饱和度 0–1
        case 2: return 0.42; // 主题色 亮度 0–1
        case 3: return 2.0; // 圆角 px 0–24（2 ≈ 接近直角）
        case 4: return 1240.0; // 页面最大宽度 px 700–1600
        case 5: return 17.0; // 正文字号 px 12–20
        case 6: return 22.0; // 卡片内边距 px 0–40
        case 7: return 16.0; // 列表间距 px 0–30
        default: return -1.0; // 没定义的槽位 → 用默认
    }
}
/* ---------------------------------------------------------------------------
   ② 逻辑插件：hot_score(点赞, 回答, 浏览, 距今天数) -> 热度分
      替换「热门」标签的排序算法，越大越靠前。
   --------------------------------------------------------------------------- */
export function hot_score(votes, answers, views, ageDays) {
    const base = votes * 3 + answers * 5 + views / 100;
    // 时间衰减：30 天前发的，热度打对折，防止老帖永远霸榜
    return base / (1 + ageDays / 30);
}
