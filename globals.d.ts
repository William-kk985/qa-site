/* ============================================================================
   给 tsc 看的全局声明 —— 只影响类型检查，浏览器里不加载这个文件。
   ----------------------------------------------------------------------------
   为什么需要它：app.js / config.js 是**普通脚本**（不是 module），它们把
   QA_CONFIG / supabase / loadPyodide 这些东西挂在 window 上。
   而 window 的类型来自 TypeScript 自带的 DOM 库，那里当然没有我们自己的
   字段，tsc 会一律报「Property 'X' does not exist on type 'Window'」。

   在这里补上声明，app.js 里就不用为了消错误到处写类型断言。
   ============================================================================ */

/** config.js 里那份后端配置。两个字段都可能缺 —— 那就是「还没配好」，见 app.js 的 configError。 */
interface QAConfig {
  SUPABASE_URL?: string;
  SUPABASE_KEY?: string;
}

/* Python 插件后端用到的那一小部分 Pyodide 接口。
   只声明真正用到的三个成员，而不是把整个 Pyodide 类型都抄过来 ——
   用不到的部分抄了也只是负担。
   ⚠️ 返回值写成 unknown 而不是 any：调用方本来就要自己判断类型
      （见 loadPythonPlugin 里的 typeof 判断），unknown 正好逼着它做这个
      判断，不会悄悄放过。 */
interface PyodideLike {
  version: string;
  runPython(code: string): unknown;
  globals: {
    get(name: string): (...args: number[]) => unknown;
  };
}

interface Window {
  /** config.js 赋值；app.js 读它来建 Supabase 客户端。 */
  QA_CONFIG?: QAConfig;

  /* vendor/supabase.js 这个 UMD bundle 挂上来的入口。
     ⚠️ 返回类型只能是 any：那是别人压缩好的第三方产物，仓库里没有随包的
        类型声明。要精确建模它的链式查询构造器（from / select / eq …）
        得手工抄几百行，而且抄错会引入假报错 ——
        这个配置真正要抓的是**本站数据结构**上的错，不是 SDK 的用法错。
        这是全仓库唯一一处"没法标注"的 any。 */
  supabase?: { createClient(url: string, key: string): any };

  /** Python 插件第一次运行时按需从 CDN 拉 Pyodide，由它的脚本挂上来。 */
  loadPyodide?: (options: { indexURL: string }) => Promise<PyodideLike>;
}
