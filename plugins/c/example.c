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

/* ===========================================================================
   ③ 搜索相关度打分：search_score(qLen, tLen) -> double
   ---------------------------------------------------------------------------
   这是**第一个要吃字符串**的插件，所以和上面两个（纯数字）不一样，
   需要一套把字符串送进 wasm 的协议：

     ① 插件导出 qa_buffer() -> 指向一块可写缓冲区的指针
     ② JS 把 query 的 UTF-8 字节写在缓冲区开头，紧接着写 text 的 UTF-8 字节
     ③ JS 调用 search_score(qLen, tLen)，qLen/tLen 是**字节数**

   所以插件内部看到的是：
        buf[0 .. qLen)               → query
        buf[qLen .. qLen + tLen)     → text

   ⚠️ 为什么用缓冲区而不是让 JS 传字符串指针：JS 没法直接构造 wasm 侧的
      字符串对象。给一块自己的缓冲区是最简单、零依赖、任何 wasm 语言都能做的。
   ⚠️ 缓冲区大小固定 64KB —— 超出就返回 NaN，上层会回退到内置顺序，
      不会崩。搜索框里的字不会长到 64KB。

   打分算法（**必须和各语言逐位一致**，所以定义得死板一点）：
      对 query 里每个非空格字节 c（ASCII 大写转小写），数 c 在 text 里
      出现多少次，累加；最后除以 query 的字节数。
      按 UTF-8 字节比较，所以中文也能用，且和 JS/Python 那边结果完全相同。
   =========================================================================== */
#define QA_BUF_SIZE 65536
static unsigned char qa_buf[QA_BUF_SIZE];

__attribute__((export_name("qa_buffer")))
unsigned char *qa_buffer(void) { return qa_buf; }

static int qa_lower(int c) { return (c >= 'A' && c <= 'Z') ? c + 32 : c; }

__attribute__((export_name("search_score")))
double search_score(int q_len, int t_len) {
  if (q_len <= 0) return 0.0;
  if (q_len + t_len > QA_BUF_SIZE) return 0.0 / 0.0;   /* NaN：让上层回退 */
  const int base = q_len;
  double score = 0.0;
  for (int i = 0; i < q_len; i++) {
    const int c = qa_lower(qa_buf[i]);
    if (c == ' ') continue;
    int n = 0;
    for (int j = 0; j < t_len; j++) {
      if (qa_lower(qa_buf[base + j]) == c) n++;
    }
    score += (double)n;
  }
  return score / (double)q_len;
}
