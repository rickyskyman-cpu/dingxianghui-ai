# 部署说明：短信、微信扫码与 DeepSeek

本文件描述新分支需要操作者自行准备的配置。仓库和函数响应里都没有密钥。这次没有部署。

先执行已有迁移，再执行本分支的迁移，然后同时发布前端和 `dingxianghui-api`。不要只换页面。

## 迁移顺序

1. `supabase/migrations/20261107120000_dxh_security_additive.sql`
2. `supabase/migrations/20261112020000_dxh_alt_login_ai.sql`

两份都只改 `dxh`。第二份给用户表增加 `wechat_openid` 和 `must_change_password`，给匹配表增加来源和模型字段，并新建短信验证码、微信 state、管理员审计、AI 配额和排序表。新表开启行级安全，并撤销 `public`、`anon`、`authenticated`。不改 storage，不改已有六张表的策略。

## 已有安全开关

- `SUPABASE_DB_URL`：函数连接串，只放在 Supabase secret。
- `DXH_ALLOW_DEMO_LOGIN`：保持不设置或不是 `true`。
- `DXH_ALLOW_DEMO_SELF_APPROVE`：保持不设置或不是 `true`。
- `DXH_ALLOWED_ORIGINS`：站点来源，默认 `https://rickyskyman-cpu.github.io`。

## 短信验证码登录

只有审核通过的校友会真正收到短信。未注册或未审核的手机号返回同样的提示，不说明账号是否存在。验证码只存哈希，5 分钟过期，用一次即失效。同一手机号 60 秒内不能重发，每小时最多 5 次，每天最多 10 次；来源地址同样计数。

未设置下列变量时，页面显示「暂未开通」：

- `SMS_PROVIDER`：`aliyun` 或 `tencent`
- `SMS_SIGN_NAME`
- `SMS_TEMPLATE_CODE`
- `SMS_CODE_PEPPER`：只放在函数 secret，用来哈希验证码
- 阿里云：`SMS_ACCESS_KEY_ID`、`SMS_ACCESS_KEY_SECRET`
- 腾讯云：`SMS_SECRET_ID`、`SMS_SECRET_KEY`、`SMS_SDK_APP_ID`

操作者需要准备企业认证通过的短信签名和验证码模板。模板变量使用 `code`。本仓库不代为开通。

## 微信网站应用扫码

未设置下列变量时，页面显示「暂未开通」：

- `WECHAT_OPEN_APPID`
- `WECHAT_OPEN_SECRET`
- `WECHAT_REDIRECT_URI`：必须同时出现在 `WECHAT_REDIRECT_ALLOWLIST`
- `WECHAT_REDIRECT_ALLOWLIST`：逗号分隔。未设置时只允许 `WECHAT_REDIRECT_URI`

操作者需要在微信开放平台注册网站应用，申请 `snsapi_login`，并把授权回调域设成上面的回调地址。只保存 unionid 和 openid。未绑定的微信不能新建账号。已审核用户可在个人页绑定或确认后解绑。

## DeepSeek 匹配

- `DEEPSEEK_API_KEY`：只放在函数 secret，不会发给浏览器
- `DEEPSEEK_MODEL`：默认 `deepseek-chat`
- `DXH_AI_DAILY_QUOTA`：每人每天次数，默认 20

请求发往 `https://api.deepseek.com/chat/completions`，超时约 20 秒，失败重试一次。没有密钥、超额或模型结果无效时，改用原来的关键词匹配，并标明「规则匹配」。发给模型的内容不含手机号和校友卡。

## 上线后核对

- 登录预检对允许来源返回 204 且没有正文。
- `dxh.login_throttle` 与本迁移新建的表都开启了行级安全，anon 和 authenticated 没有表权限。
- 已有六张表和 `demand-media` 与迁移前一致。
- 演示登录和自助过审仍然关闭。
