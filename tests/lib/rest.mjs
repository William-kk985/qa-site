/* ============================================================================
   Supabase REST 客户端：给「不经过浏览器、直接打数据库」的权限/通知测试用。

   URL 和 publishable key 直接从仓库根目录的 config.js 里读 —— 那份是前端公开配置，
   不复制一份是为了避免以后换后端时测试悄悄测到旧项目。
   （注意：publishable key 是给前端用的公开值，真正的安全边界在 RLS；千万别把
     service_role / sb_secret 之类的 key 弄进这里。）

   真实账号密码一律走 QA_EMAIL / QA_PASS 环境变量，见 cdp.mjs 的 needCreds()。
   ============================================================================ */

import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT, needCreds } from './cdp.mjs';

const cfgSrc = await fs.readFile(path.join(ROOT, 'config.js'), 'utf8');
const pick = key => {
  const m = cfgSrc.match(new RegExp(key + `\\s*:\\s*'([^']+)'`));
  if (!m) throw new Error(`config.js 里找不到 ${key}`);
  return m[1];
};

export const SUPABASE_URL = pick('SUPABASE_URL').replace(/\/$/, '');
export const SUPABASE_KEY = pick('SUPABASE_KEY');

/** HTTP 错误不当异常抛：权限测试要断言「被拒绝」，得看到 4xx 的响应体和状态码。 */
export async function call(method, apiPath, { token, body, prefer = true } = {}) {
  const headers = { apikey: SUPABASE_KEY, 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  if (prefer && ['POST', 'PATCH', 'DELETE'].includes(method)) headers.Prefer = 'return=representation';

  /* ⚠️ 出口走代理，偶发把到 Supabase 的连接掐断（实测一整轮里好几个脚本同时
     报 ECONNRESET 而红）。这类失败是网络抖动，不是应用 bug。所以只对
     「fetch 本身失败」重试（退避 3 次）：
       · HTTP 4xx / 5xx 一律**原样返回**，绝不重试 —— 权限用例就是靠状态码判
         「被拒绝」的，把 4xx 重试成 200 会直接掩盖提权/越权 bug；
       · 只有连 TCP/TLS 都没建起来的错误才重试。 */
  let lastErr;
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(SUPABASE_URL + apiPath, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      let data = null;
      if (text.trim()) {
        try { data = JSON.parse(text); } catch { data = text; }
      }
      return { status: res.status, data };
    } catch (e) {
      lastErr = e;
      const code = (e && e.cause && e.cause.code) || e.code || '';
      const transient = /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|EPIPE|UND_ERR/.test(String(code))
        || /socket hang up|fetch failed/i.test(String(e.message));
      if (attempt >= 2 || !transient) throw e;
      console.warn(`⚠️  ${method} ${apiPath} 网络抖动（${code || e.message}），重试第 ${attempt + 1} 次`);
      await new Promise(r => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  throw lastErr;   // 走不到，纯给读代码的人一个明确终点
}

/** 把 Supabase 的报错压成一行，方便写进 ❌ 的 detail 里。 */
export function msg(data) {
  if (data && typeof data === 'object') {
    return data.message || data.msg || data.error_description || data.error || JSON.stringify(data);
  }
  return String(data);
}

export async function login(email, password) {
  const { status, data } = await call('POST', '/auth/v1/token?grant_type=password', {
    body: { email, password },
  });
  if (data && data.access_token) {
    return { token: data.access_token, id: data.user.id, name: data.user.user_metadata?.display_name };
  }
  throw new Error(`登录失败（HTTP ${status}）：${msg(data)}`);
}

/** 注册；已存在时 Supabase 不会给 access_token，返回 null 让调用方改走 login。 */
export async function signup(email, password, meta = {}) {
  const { data } = await call('POST', '/auth/v1/signup', {
    body: { email, password, data: meta },
  });
  if (data && data.access_token) return { token: data.access_token, id: data.user.id };
  return null;
}

/** 注册过就登录，没注册过就注册 —— 让脚本可以反复跑。 */
export async function ensureUser(email, password, meta = {}) {
  const created = await signup(email, password, meta);
  if (created) return created;
  return login(email, password);
}

export async function adminLogin() {
  const { email, pass } = needCreds('直接打数据库的权限用例');
  return login(email, pass);
}
