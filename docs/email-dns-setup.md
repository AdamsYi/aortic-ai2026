⚠️ 此文档已更新为实际 IP：3.131.94.79（AWS us-east-2）

# AorticAI 邮件 DNS 配置（aortic.hk）

用于把 `aortic.hk` 邮件系统指向 Stalwart 服务器。

## 必填记录

| 类型 | 主机名 | 值 | TTL |
|---|---|---|---|
| A | `mail` | `3.131.94.79` | `300` |
| MX | `@` | `10 mail.aortic.hk.` | `300` |
| TXT | `@` | `v=spf1 mx a:mail.aortic.hk ~all` | `300` |
| TXT | `_dmarc` | `v=DMARC1; p=quarantine; adkim=s; aspf=s; rua=mailto:dmarc@aortic.hk; ruf=mailto:dmarc@aortic.hk; fo=1; pct=100` | `300` |

## DKIM（部署后填写）

| 类型 | 主机名 | 值 | TTL |
|---|---|---|---|
| TXT | `mail2026._domainkey` | `v=DKIM1; k=rsa; p=<DKIM_PUBLIC_KEY>` | `300` |

## Cloudflare 说明

- `mail.aortic.hk`（A 记录）请设为 **DNS only**（灰云）
- MX/TXT 天然不代理

## 验证命令

```bash
dig +short A mail.aortic.hk
dig +short MX aortic.hk
dig +short TXT aortic.hk
dig +short TXT _dmarc.aortic.hk
dig +short TXT mail2026._domainkey.aortic.hk
```
