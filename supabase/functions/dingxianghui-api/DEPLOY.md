# 部署说明

这次提交没有部署。线上函数和 GitHub Pages 都还是旧版本。不要只发布前端，否则页面会先于函数更换。

照片已从站点移除。首页使用设计包中的原创工程线稿，不表示实景建筑或学校标志。许可阻塞因此不再来自这些校园照片。

## 可以部署的文件

`supabase/functions/dingxianghui-api/index.ts` 是入口。它保留原先的业务路由，并接上安全判断。数据库连接只用函数环境里的 `SUPABASE_DB_URL`，仓库里没有这份凭据。

不要再部署已经删除的 `index.mjs`。那个文件没有业务路由。

## 环境变量

默认即为关闭，不需要为了保持关闭而填写密钥。

- `DXH_ALLOW_DEMO_LOGIN` 未设置或不是 `true`：演示登录关闭，公开过的演示密码也不能建立会话。
- `DXH_ALLOW_DEMO_SELF_APPROVE` 未设置或不是 `true`：自助过审关闭。
- `DXH_ALLOWED_ORIGINS` 默认只有 `https://rickyskyman-cpu.github.io`。不要写成 `*`。
- 微信与短信没有接入真实服务。不要设置它们的密钥来“试一下”，缺少审核主体、回调域和短信模板时接口会保持关闭。

现有管理员继续用原来的密码登录。两步验证默认关闭，这套配置不会把他们锁在外面。

## 迁移

`supabase/migrations/20261107120000_dxh_security_additive.sql` 只对 `dxh` 增加可空的微信字段、默认关闭的两步开关，以及 `dxh.login_throttle`。

这张表开启行级安全，并撤销 `public`、`anon`、`authenticated` 的表权限。没有为这三方创建策略。函数用原来的 `SUPABASE_DB_URL` 连接，不走 anon key。表里只存账号和来源的哈希，不存密码。

它不修改已有业务行，不改已有六张表的策略，也不动 storage。已有六张表的行级安全是另一次只读核查看到的：已经开启且没有策略。这次迁移不重复改它们。

登录限流依赖这张表。表不可用时登录返回 503，不会退回进程内计数。同一来源对同一账号连续失败会被拦住；管理员从另一个来源仍可用原来的密码登录。这不是全网分布式防火墙，只是所有函数实例共用的数据库计数。

执行前确认目标库已经有原来的 `dxh.users`。如果没有，停下来，不要另建一套业务表。

## 建议顺序

1. 在不指向生产库的环境跑 `node --test --test-concurrency=1 tests/edge_routes.test.ts tests/security_policy.test.mjs tests/frontend_guards.test.mjs`。
2. 先执行上述迁移，再部署函数。沿用原来的 `SUPABASE_DB_URL`，不要轮换，不要把演示开关设为 `true`。
3. 前端和函数一起发布。不要只换页面。
4. 不要改共享项目里的 storage，包括已有的 `demand-media`。当前注册只在 `dxh.users.alumni_card_img` 写入固定占位名，不上传文件。
5. 上线后核对 `dxh.login_throttle` 的行级安全仍开启，且 anon、authenticated 没有表权限。已有六张表的策略这次没有改，验收时不要把它们写成新通过。
