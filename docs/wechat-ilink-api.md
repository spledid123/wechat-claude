# 微信 iLink Bot API 实战文档

本文档记录本项目实际接入微信 iLink Bot API 时使用到的接口、参数、消息结构、加密上传流程和踩坑记录。

这不是腾讯官方 SDK 文档，而是基于当前代码和实测行为整理的维护手册。对应实现主要在：

```text
src/features/02-wechat-connectivity/wechat/
```

## 1. 基本约定

| 项目 | 当前值 |
| --- | --- |
| API Base URL | `https://ilinkai.weixin.qq.com` |
| CDN Base URL | `https://novac2c.cdn.weixin.qq.com/c2c` |
| `channel_version` | `1.0.2` |
| 登录二维码类型 | `bot_type=3` |
| JSON Content-Type | `application/json` |
| CDN 上传 Content-Type | `application/octet-stream` |
| 普通 API 超时 | 40 秒 |
| `getupdates` 超时 | 45 秒 |
| CDN 上传/下载超时 | 30 秒 |

所有认证接口都需要以下 header：

| Header | 值 | 说明 |
| --- | --- | --- |
| `AuthorizationType` | `ilink_bot_token` | 固定值 |
| `Authorization` | `Bearer <bot_token>` | 扫码确认后拿到的 token |
| `X-WECHAT-UIN` | 随机 base64 字符串 | 当前实现用随机 uint32 转字符串后 base64 |

所有需要 `base_info` 的请求统一使用：

```json
{
  "base_info": {
    "channel_version": "1.0.2"
  }
}
```

## 2. 登录二维码

### 2.1 获取二维码

```http
GET /ilink/bot/get_bot_qrcode?bot_type=3
```

不需要认证 header。

响应字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `qrcode` | string | 后续轮询状态用的二维码标识 |
| `qrcode_img_content` | string | 可能是 base64 图片，也可能是二维码 URL |
| `baseurl` | string, optional | 服务端返回的 base URL，当前实现默认仍使用 `https://ilinkai.weixin.qq.com` |

踩坑：

| 问题 | 处理 |
| --- | --- |
| `qrcode_img_content` 有时不是纯 base64 | 如果以 `http` 开头，用 `qrcode` 包把 URL 重新生成二维码 PNG |
| 有时带 `data:image/png;base64,` 前缀 | 写文件前需要剥掉 data URL 前缀 |
| 没有 token 时服务不能直接退出 | 正式服务进入 `waiting_for_login`，保留管理面板让用户扫码 |

### 2.2 查询二维码状态

```http
GET /ilink/bot/get_qrcode_status?qrcode=<urlencoded qrcode>
```

不需要认证 header。

响应字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `status` | string | `pending`、`scanned`、`confirmed`、`expired`、`cancelled` |
| `bot_token` | string, optional | 仅 `confirmed` 时返回 |
| `baseurl` | string, optional | 服务端返回的 base URL |

当前登录流程：

```text
get_bot_qrcode -> 保存二维码图片 -> 每 1500ms 查询状态 -> confirmed 后写 bot_token.txt
```

踩坑：

| 问题 | 处理 |
| --- | --- |
| 保存 token 后，当前长轮询不会热替换 token | 管理面板提示重启服务 |
| 二维码会过期 | `expired` 或 `cancelled` 直接失败，用户刷新二维码 |
| 查询时间不能无限长 | 当前实现最长等待 180 秒 |

## 3. 长轮询接收消息

```http
POST /ilink/bot/getupdates
```

需要认证 header。

请求体：

```json
{
  "get_updates_buf": "",
  "base_info": {
    "channel_version": "1.0.2"
  }
}
```

请求参数：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `get_updates_buf` | string | 是 | 游标。首次启动传空字符串，之后必须回传服务端上次给的新值 |
| `base_info.channel_version` | string | 是 | 固定 `1.0.2` |

响应字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `ret` | number | 返回码，非 0 应记录原始响应排查 |
| `msgs` | array, optional | 微信消息数组 |
| `get_updates_buf` | string, optional | 新游标 |
| `longpolling_timeout_ms` | number, optional | 服务端建议的长轮询等待时间 |

当前轮询策略：

```text
初始 get_updates_buf = ""
每次响应后保存新的 get_updates_buf
只处理 message_type === 1 的用户消息
普通错误指数退避，最长 30 秒
401/403 视为 token 失效
```

踩坑：

| 问题 | 处理 |
| --- | --- |
| 同一个 token 同时跑多个 poller 会抢消息 | 正式版本只保留一个 runtime poller，调试监听器不能并行跑 |
| `get_updates_buf` 不能丢 | 丢失后可能重复收旧消息或漏消息 |
| HTTP request helper 目前直接解析 JSON，不检查 `res.ok` | 调试失败时要记录原始 `ret` 和响应体 |
| `message_type` 有方向含义 | 用户发给 bot 是 `1`，bot 发给用户是 `2` |
| 长轮询请求必须能被 AbortSignal 中断 | 停止服务时要取消正在等待的请求 |

## 4. 入站消息结构

顶层消息（2026-08 实测全字段）：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `message_id` | **number** | **服务端消息 ID，引用时的匹配键**。19 位整数，见下方大数陷阱 |
| `seq` | number | 会话内递增序号 |
| `from_user_id` | string | 微信用户 ID，例如 `xxx@im.wechat` |
| `to_user_id` | string | bot ID，例如 `xxx@im.bot` |
| `client_id` | string | 客户端投递标识，含投递时间后缀 |
| `message_type` | number | 入站用户消息为 `1`，bot 消息为 `2` |
| `message_state` | number | 实测入站为 `2` |
| `create_time_ms` / `update_time_ms` | number | 毫秒时间戳 |
| `delete_time_ms` | number | 实测为 `0` |
| `context_token` | string | 回复时必须原样带回 |
| `session_id` / `group_id` | string | 实测为空串 |
| `root_id` / `parent_id` | number | 实测为 `0` |
| `item_list` | array | 消息气泡内的 item 列表 |

> **大数陷阱（关键）**：`message_id` 以 JSON **数字**下发（19 位，超过 JS 安全整数 2^53），`JSON.parse` 会静默舍入损坏它。而引用消息嵌套里的 `msg_id` 是**字符串**，精确无损——一边被污染一边精确，按 id 匹配永远失败，且无任何报错。
> **解决**：本项目在 `api.ts` 解析前把 `message_id`/`msg_id` 的 15 位以上裸数字正则转为字符串再 parse，三边（入站索引、引用查询、出站 msg_id）统一使用精确字符串 id。

Item 通用字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `type` | number | item 类型 |
| `create_time_ms` | number, optional | 创建时间（注意：与顶层 `message_id` 对应消息被引用时嵌套里的时间有 1~3 秒投递偏差，图片更大） |
| `update_time_ms` | number, optional | 更新时间 |
| `is_completed` | boolean, optional | 是否完成 |
| `msg_id` | string, optional | item 投递 ID，形如 `v1:...`。**与顶层 `message_id` 是两套无关的 id 空间**，仅用于投递去重，不能用于引用匹配 |
| `button_item_list` | array, optional | 按钮类扩展字段 |
| `at_bot_username_list` | array, optional | 实测为空 |
| `ref_msg` | object, optional | 微信引用消息，仅出现在文本 item 上 |

Item 类型：

| type | 名称 | 主要 payload |
| --- | --- | --- |
| `1` | 文本 | `text_item` |
| `2` | 图片 | `image_item` |
| `3` | 语音 | `voice_item` |
| `4` | 文件 | `file_item` |
| `5` | 视频 | `video_item` |
| `8` | 混合消息 | 当前仅做占位识别 |

文本 item 的引用（`ref_msg`，2026-08 实测真实形态）：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `ref_msg.message_item` | object | **唯一**的嵌套内容，字段仅有 `type`（恒 0，无类型信息）、`msg_id`（**字符串**，服务端 id，可精确匹配）、`create_time_ms`、`update_time_ms`、`is_completed`、`button_item_list`、`at_bot_username_list` |
| `ref_msg.text` | — | **实测不存在**（纯文本引用也不带摘要） |
| `ref_msg.msg_id` | — | **实测不存在**（id 在嵌套 `message_item.msg_id` 里） |
| `ref_msg.from_user_id` | — | **实测不存在** |

图片 item：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `image_item.aeskey` | string, optional | 入站图片 AES key，注意字段名没有下划线 |
| `image_item.full_url` | string, optional | 下载 URL |
| `image_item.url` | string, optional | 下载 URL 备选字段 |
| `image_item.media` | object, optional | 嵌套媒体结构 |
| `image_item.mid_size` | number, optional | 图片大小 |
| `image_item.hd_size` | number, optional | 高清图大小 |
| `image_item.thumb_size` | number, optional | 缩略图大小 |
| `image_item.thumb_width` | number, optional | 缩略图宽 |
| `image_item.thumb_height` | number, optional | 缩略图高 |

语音 item：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `voice_item.media` | object, optional | 媒体下载信息 |
| `voice_item.trans_text` | string, optional | 微信语音转写字段之一 |
| `voice_item.text` | string, optional | 微信语音转写字段之一 |
| `voice_item.recognition_text` | string, optional | 微信语音转写字段之一 |
| `voice_item.transcript` | string, optional | 微信语音转写字段之一 |
| `voice_item.transcribed_text` | string, optional | 微信语音转写字段之一 |
| `voice_item.speech_to_text` | string, optional | 微信语音转写字段之一 |
| `voice_item.playtime` | number, optional | 语音时长，毫秒 |
| `voice_item.encode_type` | number, optional | 编码类型 |
| `voice_item.bits_per_sample` | number, optional | 采样位数 |
| `voice_item.sample_rate` | number, optional | 采样率 |

文件 item：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `file_item.media` | object, optional | 媒体下载信息 |
| `file_item.file_name` | string, optional | 文件名 |
| `file_item.md5` | string, optional | 原文件 MD5 |
| `file_item.len` | number, optional | 入站为 number，出站发送时为 string |

视频 item：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `video_item.media` | object, optional | 媒体下载信息 |
| `video_item.video_size` | number, optional | 视频大小 |
| `video_item.duration_ms` | number, optional | 视频时长 |

媒体结构：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `encrypt_query_param` | string | CDN 下载或发送消息时使用的加密参数 |
| `aes_key` | string | AES key，入站可能是多种编码，出站必须是 `base64(utf8(hexAesKey))` |
| `encrypt_type` | number | 当前使用 `1` |
| `full_url` | string, optional | 完整 CDN URL |
| `url` | string, optional | 备选 CDN URL |

踩坑：

| 问题 | 处理 |
| --- | --- |
| 图片入站 key 有时是 `aeskey`，不是 `aes_key` | 解析时必须同时兼容 `image_item.aeskey` 和 `image_item.media.aes_key` |
| 语音转写字段名不稳定 | 按 `trans_text`、`text`、`recognition_text`、`transcript`、`transcribed_text`、`speech_to_text` 顺序兜底 |
| 不要过滤“我发了一段语音” | 用户可能真的说了这句话，不能当成假转写丢弃 |
| 文件 `len` 入站和出站类型不同 | 入站通常 number，出站必须 string |
| 引用媒体经常只有文件名或占位信息 | 需要结合本地消息文本索引找 vision 描述/转写/提取结果 |
| 引用媒体解析失败不能静默丢弃 | 注入"引用内容未能解析"提示，由 AI 建议用户重发原始媒体 |

## 5. 发送文本消息

```http
POST /ilink/bot/sendmessage
```

需要认证 header。

请求体：

```json
{
  "base_info": {
    "channel_version": "1.0.2"
  },
  "msg": {
    "from_user_id": "",
    "to_user_id": "USER_ID",
    "client_id": "wechat-claude-relay_1780000000000_abc123",
    "message_type": 2,
    "message_state": 2,
    "context_token": "CONTEXT_TOKEN",
    "item_list": [
      {
        "type": 1,
        "text_item": {
          "text": "你好"
        }
      }
    ]
  }
}
```

请求参数：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `base_info.channel_version` | string | 是 | 固定 `1.0.2` |
| `msg.from_user_id` | string | 是 | bot 发送时传空字符串 |
| `msg.to_user_id` | string | 是 | 目标用户 ID，通常用入站 `from_user_id` |
| `msg.client_id` | string | 是 | 客户端生成的唯一 ID |
| `msg.message_type` | number | 是 | bot 发给用户固定 `2` |
| `msg.message_state` | number | 是 | 当前固定 `2` |
| `msg.context_token` | string | 是 | 必须来自对应微信会话的入站消息 |
| `msg.item_list[].type` | number | 是 | 文本为 `1` |
| `msg.item_list[].text_item.text` | string | 是 | 文本内容 |

响应字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `ret` | number | 返回码 |
| `msg_id` | string, optional | 发送后的消息 ID |

踩坑：

| 问题 | 处理 |
| --- | --- |
| `context_token` 错误会导致发送异常或无感失败 | 回复、定时任务和管理后台创建任务都要保存可用 context token |
| 长文本一次发送容易失败或体验差 | 当前按约 1400 字拆气泡，并在气泡之间延迟 500ms |
| `from_user_id` 不要填 bot ID | 当前实测 bot 发送时为空字符串 |
| `client_id` 应唯一 | 当前格式为 `wechat-claude-relay_<timestamp>_<random>` |

## 6. 发送图片和文件

发送媒体分两步：

```text
getuploadurl -> 上传加密后的二进制到 CDN -> sendmessage 发送媒体 envelope
```

### 6.1 获取上传 URL

```http
POST /ilink/bot/getuploadurl
```

需要认证 header。

请求体：

```json
{
  "filekey": "16_BYTE_RANDOM_HEX",
  "media_type": 1,
  "to_user_id": "USER_ID",
  "rawsize": 12345,
  "rawfilemd5": "RAW_FILE_MD5_HEX",
  "filesize": 12352,
  "no_need_thumb": true,
  "aeskey": "16_BYTE_AES_KEY_HEX",
  "base_info": {
    "channel_version": "1.0.2"
  }
}
```

请求参数：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `filekey` | string | 是 | 随机 16 字节 hex，也就是 32 个 hex 字符 |
| `media_type` | number | 是 | `1` 图片，`2` 视频，`3` 文件 |
| `to_user_id` | string | 是 | 目标用户 ID |
| `rawsize` | number | 是 | 原始文件字节数 |
| `rawfilemd5` | string | 是 | 原始文件 MD5 hex |
| `filesize` | number | 是 | AES-ECB PKCS padding 后的加密大小 |
| `no_need_thumb` | boolean | 否 | 当前图片和文件发送都传 `true` |
| `aeskey` | string | 是 | 16 字节 AES key 的 hex 字符串 |
| `base_info.channel_version` | string | 是 | 固定 `1.0.2` |

响应字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `ret` | number | 返回码 |
| `upload_full_url` | string, optional | 完整上传 URL |
| `upload_param` | string, optional | 如果没有完整 URL，用它拼 CDN URL |
| `cdn_url` | string, optional | 当前实现不依赖 |

如果只有 `upload_param`，上传 URL 拼法为：

```text
https://novac2c.cdn.weixin.qq.com/c2c/upload?encrypted_query_param=<urlencoded upload_param>&filekey=<urlencoded filekey>
```

### 6.2 CDN 加密上传

上传前加密：

| 项目 | 当前实现 |
| --- | --- |
| 算法 | `AES-128-ECB` |
| padding | Node crypto 默认 PKCS padding |
| key | `aeskey` hex 解码后的 16 字节 |
| `filesize` | `Math.ceil((rawsize + 1) / 16) * 16` |

上传请求：

```http
POST <upload_full_url 或拼出的 CDN upload URL>
Content-Type: application/octet-stream

<encrypted file bytes>
```

上传成功后必须读取响应 header：

```text
x-encrypted-param
```

踩坑：

| 问题 | 处理 |
| --- | --- |
| `filesize` 不是原文件大小 | 必须填加密 padding 后大小 |
| `rawfilemd5` 必须是原文件 MD5 | 不是加密后内容的 MD5 |
| `aeskey` 和 `media.aes_key` 格式不同 | `getuploadurl.aeskey` 是 hex，`sendmessage.media.aes_key` 是 base64(utf8(hex)) |
| CDN 响应体不是关键 | 关键字段在 header `x-encrypted-param` |
| `upload_full_url` 和 `upload_param` 两种响应都可能出现 | 两种都要支持 |

### 6.3 发送图片消息

CDN 上传成功后发送：

```json
{
  "base_info": {
    "channel_version": "1.0.2"
  },
  "msg": {
    "from_user_id": "",
    "to_user_id": "USER_ID",
    "client_id": "wechat-claude-relay_1780000000000_abc123",
    "message_type": 2,
    "message_state": 2,
    "context_token": "CONTEXT_TOKEN",
    "item_list": [
      {
        "type": 2,
        "image_item": {
          "media": {
            "encrypt_query_param": "X_ENCRYPTED_PARAM",
            "aes_key": "BASE64_UTF8_HEX_AES_KEY",
            "encrypt_type": 1
          }
        }
      }
    ]
  }
}
```

图片参数：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `type` | number | 是 | 图片固定 `2` |
| `image_item.media.encrypt_query_param` | string | 是 | CDN 上传返回的 `x-encrypted-param` |
| `image_item.media.aes_key` | string | 是 | `Buffer.from(aesKeyHex, "utf8").toString("base64")` |
| `image_item.media.encrypt_type` | number | 是 | 固定 `1` |
| `image_item.mid_size` | number | 否 | 当前发送图片不填 |

### 6.4 发送文件消息

CDN 上传成功后发送：

```json
{
  "base_info": {
    "channel_version": "1.0.2"
  },
  "msg": {
    "from_user_id": "",
    "to_user_id": "USER_ID",
    "client_id": "wechat-claude-relay_1780000000000_abc123",
    "message_type": 2,
    "message_state": 2,
    "context_token": "CONTEXT_TOKEN",
    "item_list": [
      {
        "type": 4,
        "file_item": {
          "media": {
            "encrypt_query_param": "X_ENCRYPTED_PARAM",
            "aes_key": "BASE64_UTF8_HEX_AES_KEY",
            "encrypt_type": 1
          },
          "file_name": "result.txt",
          "len": "12345"
        }
      }
    ]
  }
}
```

文件参数：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `type` | number | 是 | 文件固定 `4` |
| `file_item.media.encrypt_query_param` | string | 是 | CDN 上传返回的 `x-encrypted-param` |
| `file_item.media.aes_key` | string | 是 | `Buffer.from(aesKeyHex, "utf8").toString("base64")` |
| `file_item.media.encrypt_type` | number | 是 | 固定 `1` |
| `file_item.file_name` | string | 是 | 文件名，不含路径 |
| `file_item.len` | string | 是 | 原始文件大小字符串 |

## 7. 下载和解密入站媒体

入站图片、语音、文件、视频会带 CDN 下载信息。当前下载逻辑：

```text
优先使用 media.full_url 或 full_url
否则用 encrypt_query_param 拼 /download?encrypt_query_param=...
下载密文
用 AES-128-ECB 解密
写入 session/incoming
```

下载 URL 拼法：

```text
https://novac2c.cdn.weixin.qq.com/c2c/download?encrypt_query_param=<urlencoded encrypt_query_param>
```

AES key 兼容格式：

| 格式 | 说明 |
| --- | --- |
| 32 位 hex | 直接按 hex 解码成 16 字节 |
| base64(hex string) | 先 base64 解码成 32 位 hex，再按 hex 解码 |
| base64(raw 16 bytes) | base64 解码后刚好 16 字节 |

踩坑：

| 问题 | 处理 |
| --- | --- |
| 入站和出站 AES key 格式不完全一致 | 下载侧必须做多格式兼容 |
| 有些消息只有 URL 没有 key，或只有 key 没有 URL | 不能给 AI 假装成功，媒体处理要返回失败 |
| 语音不需要把 silk 文件交给 AI | 优先使用微信转写文本；如果没有转写，再按产品要求回复失败或提示重发 |
| 引用图片/文件不需要把原文件传给 AI | 应使用索引里的 vision 描述+转录（图片）或文本抽取结果（文件） |

## 8. 正在输入状态

### 8.1 获取配置

```http
POST /ilink/bot/getconfig
```

需要认证 header，请求体为空对象：

```json
{}
```

响应字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `ret` | number | 返回码 |
| `typing_ticket` | string, optional | 调用 `sendtyping` 所需 ticket |

### 8.2 发送正在输入

```http
POST /ilink/bot/sendtyping
```

需要认证 header。

请求体：

```json
{
  "to_user_id": "USER_ID",
  "context_token": "CONTEXT_TOKEN",
  "typing_ticket": "TYPING_TICKET"
}
```

请求参数：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `to_user_id` | string | 是 | 目标用户 ID |
| `context_token` | string | 是 | 当前会话 context token |
| `typing_ticket` | string | 是 | `getconfig` 返回 |

踩坑：

| 问题 | 处理 |
| --- | --- |
| `getconfig` 可能不返回 `typing_ticket` | 当前实现打印 `Typing disabled` 并自动降级为 no-op |
| typing 不是核心功能 | 不应因为 typing 失败中断消息处理 |
| context token 仍然重要 | typing 和 sendmessage 一样需要当前会话 token |

## 9. 引用消息处理

引用出现在文本 item 的 `ref_msg` 上。**2026-08 实测真实结构**（与早期文档记载差异很大）：

```json
{
  "type": 1,
  "text_item": { "text": "这是？" },
  "ref_msg": {
    "message_item": {
      "type": 0,
      "create_time_ms": 1788018470000,
      "update_time_ms": 1788018470000,
      "is_completed": true,
      "msg_id": "7499493032427617800",
      "button_item_list": [],
      "at_bot_username_list": []
    }
  }
}
```

要点：

1. `ref_msg` 只有 `message_item` 一个字段；没有 `text` 摘要、没有 `from_user_id`、没有媒体信息（aeskey/URL 全无，**无法从引用重新取回媒体**）
2. 嵌套 `msg_id` 是字符串、精确；它指向**原消息顶层的 `message_id`**（不是 item 的 `v1:` id）
3. 嵌套 `create_time_ms` 是原消息的发送时间（秒级截断），与投递时间差 1~3 秒（图片更大）——仅作辅助信息，不作匹配键

当前产品规则：

| 场景 | 行为 |
| --- | --- |
| 引用任何已索引消息 | 按精确服务端 `msg_id` 查 `message_text_index`，把索引文本以 `[引用内容: ...]` 前缀注入 |
| 跨对话引用 | 天然支持（索引按用户全局存储，不分会话） |
| 引用图片/文件 | 注入的是解析文本（vision 描述+转录 / markitdown），**不会把原图重发给 AI**（引用元数据里无下载信息；本地 incoming/ 副本可用于未来增强） |
| 引用 agent 发出的图片 | 出站图片发送后按 sendmessage 返回的 `msg_id` 异步提取入库，同样可被引用 |
| 索引查不到 | 消息**不丢弃**：注入 `[引用的消息内容未能解析...]` 提示，由 AI 建议用户重发 |

踩坑（历史结论，引以为鉴）：

| 问题 | 处理 |
| --- | --- |
| `message_id` 是 19 位 JSON 数字，`JSON.parse` 静默舍入 | 解析前把 15 位以上裸数字转字符串（`api.ts` 统一处理），否则引用永远匹配不上且无报错 |
| 顶层 `message_id`（服务端）与 item `msg_id`（`v1:` 投递 id）是两套无关 id 空间 | 索引和引用必须统一用服务端 `message_id`；`v1:` id 只能做投递去重 |
| 早期版本读 `ref_msg.msg_id`（不存在的字段）导致引用解析恒空 | id 在 `ref_msg.message_item.msg_id` |
| 引用失败不能静默降级 | 明确注入"未能解析"提示，不吞用户消息 |

## 10. 自动发送文件

Claude 工作区中约定：

```text
working/output_weixin/
```

新文件会被扫描并自动发送回微信。发送后写 `.sent.json` 去重。

当前发送路径：

```text
Claude 生成文件 -> output_weixin -> runtime 扫描 -> sendImage 或 sendFile -> 微信
```

踩坑：

| 问题 | 处理 |
| --- | --- |
| 需要避免重复发送 | 用 `.sent.json` 记录已发送文件 |
| 图片和普通文件走不同 item 类型 | 图片用 `type=2`，其他文件用 `type=4` |
| 发送文件仍依赖最近可用 context token | 自动发送必须绑定触发任务的微信会话 |

## 11. 调试建议

关键日志：

| 文件 | 说明 |
| --- | --- |
| `.wechat-claude/logs/service.log` | 正式服务日志 |
| `.wechat-claude/logs/quote-listener.jsonl` | 引用消息原始字段调试记录 |
| `.wechat-claude/bridge-data/relay.sqlite` | 会话、消息、引用索引、定时任务数据库 |

建议调试顺序：

1. 先确认只有一个服务进程在轮询同一个 bot token。
2. 确认 `bot_token.txt` 存在且服务已重启。
3. 看 `getupdates` 是否收到消息，特别是 `message_type`、`context_token`、`item_list`。
4. 发送失败时看 `sendmessage` 请求体里的 `to_user_id`、`context_token`、`message_type`、`message_state`。
5. 媒体失败时看 `getuploadurl` 是否返回 `upload_full_url` 或 `upload_param`。
6. CDN 上传失败时确认 `filesize` 是 padding 后大小，且读取了 `x-encrypted-param` header。
7. 引用失败时看 `quote-listener.jsonl` 和 SQLite 中的消息文本索引。

## 12. 代码索引

| 文件 | 作用 |
| --- | --- |
| `src/features/02-wechat-connectivity/wechat/api.ts` | HTTP client、登录、轮询、发送、上传 URL、typing |
| `src/features/02-wechat-connectivity/wechat/types.ts` | API 类型和消息结构 |
| `src/features/02-wechat-connectivity/wechat/auth.ts` | 二维码登录和 token 保存 |
| `src/features/02-wechat-connectivity/wechat/poller.ts` | 长轮询和入站消息解析 |
| `src/features/02-wechat-connectivity/wechat/sender.ts` | 文本、图片、文件发送 |
| `src/features/02-wechat-connectivity/wechat/media.ts` | 入站 CDN 下载和解密 |
| `src/features/02-wechat-connectivity/wechat/crypto.ts` | AES、MD5、client_id、X-WECHAT-UIN |
| `src/runtime/wechat-runtime.ts` | 正式 runtime 的微信发送包装、多气泡和 typing |
| `src/features/04-bridge/bridge.ts` | 引用、媒体预处理、AI 桥接和自动发送文件 |
