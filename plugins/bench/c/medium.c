/* 体积基准的中型任务 —— C 固定数组版（最小的那一端）。
 *
 * 为什么是"固定数组 + 插入排序 + 聚合"：这三件事刚好把「零运行时」和
 * 「要运行时」分开。v[256] 在栈上，所以整个函数不需要 malloc、
 * 不需要 memcpy，编出来只有几百字节 —— 这是 C 的天然下限。
 *
 * ⚠️ 这个任务**不碰堆**，所以它量不出分配器的成本。要量那个得看
 *    bench/rust-vec/ 和 bench/moon/ —— 三个变体算的是同一个算法，
 *    输出必须逐位相同（bench-size.sh 会验）。
 * 配套阅读：plugins/BENCH.md */
__attribute__((export_name("hot_score")))
double hot_score(double votes, double answers, double views, double age_days) {
  int n = (int)answers; if (n < 1) n = 1; if (n > 256) n = 256;
  double v[256];
  double s = votes + 1.0;
  for (int i = 0; i < n; i++) { s = (s * 1103515245.0 + 12345.0); s = s - (long long)s; v[i] = s; }
  for (int i = 1; i < n; i++) { double key = v[i]; int j = i;
    while (j > 0 && v[j-1] > key) { v[j] = v[j-1]; j--; } v[j] = key; }
  double acc = 0.0;
  for (int i = 0; i < n; i++) acc += v[i] * (i + 1.0);
  double base = votes * 3.0 + answers * 5.0 + views / 100.0;
  return (base + acc / 1e9) / (1.0 + age_days / 30.0);
}
