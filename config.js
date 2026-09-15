// @ts-check
/* ============================================================================
   配置文件 —— 以后要改后端，只改这一个文件。
   ----------------------------------------------------------------------------
   这两个值在 Supabase 控制台的 Project Settings → API 里可以重新找到。

   ⚠️ 这两个值是**故意公开**的，放在前端代码里是正常做法：
      能不能改数据由数据库的权限规则（RLS，见 supabase/schema.sql）决定，
      而不是靠"把 key 藏起来"。

   ⚠️ 千万不要把 service_role key / sb_secret_... 开头的 key 写进这个文件，
      那个能绕过所有权限规则，一旦公开等于数据库裸奔。
   ============================================================================ */
window.QA_CONFIG = {
  SUPABASE_URL: 'https://csrzcbgfilsdxmkedhns.supabase.co',
  SUPABASE_KEY: 'sb_publishable_fPFZlYIpXPllKtSOIOAMcQ_FvqT0lMT',
};
