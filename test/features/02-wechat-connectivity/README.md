# Feature 02: 微信 iLink Bot 联通

> 状态：✅ 已完成  |  测试：22/22 通过  |  日期：2026-06-15

---

## 一、功能概述

实现程序通过微信 iLink Bot API (`ilinkai.weixin.qq.com`) 完成微信消息收发。包括 QR 码登录、长轮询接收消息（文字/表情/语音/图片/文件/引用）、发送消息（文字/图片/文件），以及 bot_token 持久化。

### 核心能力

| 能力 | 说明 |
|------|------|
| QR 码登录 | 调用 iLink API 获取登录 URL，生成 QR 码图片，轮询扫码状态，获取 `bot_token` |
| Token 持久化 | 首次登录后 token 保存到文件，重启自动恢复，无需重复扫码 |
| 长轮询收消息 | POST `/ilink/bot/getupdates`，服务器 hold 35s，游标防重复，断线指数退避重连 |
| 文字消息解析 | 提取 `text_item.text`，含表情（如 `[大哭]` `[呲牙]`） |
| 语音消息解析 | 提取服务端转文字（`voice_item.text` 等 6 个候选字段）、时长、CDN 引用 |
| 图片消息解析 | 提取 `aeskey`（hex）、`media.encrypt_query_param`、尺寸信息 |
| 文件消息解析 | 提取文件名、MD5、大小、`media.encrypt_query_param` |
| 引用消息解析 | 提取 `ref_msg.{text, from_user_id, msg_id}` |
| 发送文字 | 正确构造 `base_info + msg` 包体，含 `client_id` |
| 发送图片 | CDN 上传全流程：getuploadurl → AES-ECB 加密 → POST CDN → sendmessage |
| 发送文件 | 同上，`media_type=3`，`file_item.len` 为字符串 |

---

## 二、模块架构

```
┌─────────────────────────────────────────────┐
│                  auth.ts                     │
│  QR 码获取 → 生成图片 → 轮询扫码状态         │
│  → bot_token 持久化                          │
└──────────────────┬──────────────────────────┘
                   │
┌──────────────────┴──────────────────────────┐
│                  api.ts                      │
│  HTTP 客户端：auth 头、base_info 包裹        │
│  所有 endpoint 封装                           │
└────┬──────────────┬──────────────┬──────────┘
     │              │              │
┌────┴────┐  ┌──────┴──────┐  ┌──┴──────────┐
│ poller   │  │  sender     │  │  crypto      │
│ 长轮询   │  │  发送消息   │  │  AES-128-ECB │
│ 消息解析 │  │  CDN 上传   │  │  MD5 / SHA256│
│ 退避重连 │  │  长文本分段 │  │  Key 生成    │
└─────────┘  └─────────────┘  └──────────────┘
```

---

## 三、API 端点 & 协议详解

### 3.1 基础信息

```
Base URL:  https://ilinkai.weixin.qq.com
CDN Base:  https://novac2c.cdn.weixin.qq.com/c2c
Channel:   1.0.2
```

### 3.2 鉴权头

未登录请求：
```
Content-Type: application/json
```

已登录请求（所有需要 bot_token 的端点）：
```
Content-Type:     application/json
AuthorizationType: ilink_bot_token
X-WECHAT-UIN:     <base64(utf8(random_uint31))>   ← 每次请求随机
Authorization:    Bearer <bot_token>
```

`X-WECHAT-UIN` 生成逻辑：随机生成一个 ≤ 2^31 的整数 → 转十进制字符串 → UTF-8 编码 → Base64。

---

## 四、入站消息（微信 → 程序）

### 4.1 消息包体结构

长轮询 `getupdates` 返回：
```json
{
  "ret": 0,
  "msgs": [ WeixinMessage, ... ],
  "get_updates_buf": "<游标，下次请求带上>",
  "longpolling_timeout_ms": 35000
}
```

### 4.2 WeixinMessage — 消息根对象

| 字段 | 类型 | 说明 |
|------|------|------|
| `from_user_id` | string | 发送者 ID，格式 `o9cq80xxx@im.wechat` |
| `to_user_id` | string | 接收者 Bot ID，格式 `e06c1ceea05e@im.bot` |
| `message_type` | number | **1**=用户→Bot（入站），**2**=Bot→用户（出站） |
| `message_state` | number | 消息状态 |
| `context_token` | string | **对话关联 token**，回复时必须原样带回 |
| `group_id` | string? | 群聊 ID（群聊消息才有） |
| `item_list` | MessageItem[] | 消息内容数组 |

### 4.3 MessageItem — 消息条目

**所有 item 类型的公共字段：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `type` | 1\|2\|3\|4\|5 | item 类型 |
| `create_time_ms` | number | 消息创建时间（毫秒时间戳） |
| `update_time_ms` | number | 消息更新时间 |
| `is_completed` | boolean | 消息是否完整 |
| `msg_id` | string | 消息唯一 ID，格式 `v1:数字` |
| `button_item_list` | array | 交互按钮（通常为空 `[]`） |

### 4.4 type=1: 文本消息 (text_item)

```typescript
text_item: {
  text: string;  // 消息文本内容
}
```

**表情消息：** 微信表情不是独立类型——表情以文本形式传递，如 `[大哭]` `[呲牙]` `[微笑]`。

**引用消息 (ref_msg)：** 当用户引用某条消息回复时，item 上会额外出现 `ref_msg` 字段：

```typescript
// MessageItem 上的附加字段（非 text_item 内部）
ref_msg?: {
  msg_id?: string;       // 被引用消息的 ID
  text?: string;         // 被引用消息的文本内容
  from_user_id?: string; // 被引用消息的发送者
}
```

### 4.5 type=2: 图片消息 (image_item)

```typescript
image_item: {
  aeskey: string;    // AES-128 密钥，32 hex chars（注意：无下划线）
  media: {           // CDN 引用信封
    encrypt_query_param: string;  // CDN 加密查询参数
    aes_key?: string;             // 出站格式的 AES key（base64）
  };
  mid_size:   number;  // 中等尺寸图片字节数
  hd_size:    number;  // 高清图片字节数
  thumb_size: number;  // 缩略图字节数
  thumb_width: number; // 缩略图宽度
  thumb_height: number; // 缩略图高度
}
```

**下载图片流程：**
1. 用 `encrypt_query_param` 构造 CDN 请求
2. 下载加密数据
3. 用 `aeskey`（hex → Buffer(16)）AES-128-ECB 解密

### 4.6 type=3: 语音消息 (voice_item)

```typescript
voice_item: {
  media: {                    // CDN 引用信封（silk 编码音频）
    encrypt_query_param: string;
    aes_key?: string;
  };
  text?: string;              // 🏆 服务端语音转文字（主要字段）
  trans_text?: string;        // 备选转录字段
  recognition_text?: string;  // 备选转录字段
  transcript?: string;        // 备选转录字段
  transcribed_text?: string;  // 备选转录字段
  speech_to_text?: string;    // 备选转录字段
  playtime: number;           // 语音时长（毫秒）
  encode_type: number;        // 编码类型
  bits_per_sample: number;    // 采样位深
  sample_rate: number;        // 采样率（Hz）
}
```

**⚠️ 转录文本可能出现在 6 个不同字段中**，必须全部检查。实测 `text` 字段返回转文字结果。

### 4.7 type=4: 文件消息 (file_item)

```typescript
file_item: {
  media: {                    // CDN 引用信封
    encrypt_query_param: string;
    aes_key?: string;
  };
  file_name: string;          // 文件名（如 "北京大学暑期学校报名表.docx"）
  md5: string;                // 文件 MD5（hex）
  len: number;                // 文件大小（字节）
}
```

### 4.8 type=5: 视频消息 (video_item)

```typescript
video_item: {
  media: {
    encrypt_query_param: string;
    aes_key?: string;
  };
  video_size?: number;        // 视频大小
  duration_ms?: number;       // 时长
}
```

---

## 五、出站消息（程序 → 微信）

### 5.1 发送消息包体结构

**所有 `sendmessage` 请求都用此结构：**

```json
{
  "base_info": {
    "channel_version": "1.0.2"
  },
  "msg": {
    "from_user_id": "",
    "to_user_id": "o9cq80xxx@im.wechat",
    "client_id": "wechat-claude-relay_<timestamp>_<random6>",
    "message_type": 2,
    "message_state": 2,
    "context_token": "<从入站消息取>",
    "item_list": [ ... ]
  }
}
```

**关键注意点：**
- `from_user_id` 固定为空字符串 `""`
- `client_id` 每次生成唯一值
- `context_token` 必须与入站消息一致
- `message_type: 2` 表示 Bot→用户

### 5.2 发送文字

```json
{
  "type": 1,
  "text_item": {
    "text": "回复内容"
  }
}
```

长文本（>1400 字）需要分段发送，优先在换行 → 句号 → 英文句点处断开。

### 5.3 发送图片 — 完整流程

**Step 1: 获取 CDN 上传 URL**
```bash
POST /ilink/bot/getuploadurl
```
```json
// Request
{
  "filekey":       "<random 16-byte hex>",
  "media_type":    1,                   // 1=image, 2=video, 3=file
  "to_user_id":    "o9cq80xxx@im.wechat",
  "rawsize":       13586,               // 原始文件大小
  "rawfilemd5":    "9b843b41...",       // 原始文件 MD5 (hex)
  "filesize":      13600,               // AES 加密后大小 = ceil((rawsize+1)/16)*16
  "no_need_thumb": true,
  "aeskey":        "fe578c4b...",       // 随机 16-byte AES key (hex)
  "base_info": {
    "channel_version": "1.0.2"
  }
}

// Response (成功, ret 字段可能不存在即为成功)
{
  "upload_param": "<长字符串>"   // 或 upload_full_url
}
```

**Step 2: 加密文件并上传到 CDN**

加密：AES-128-ECB，**默认 PKCS 填充**（不要 `setAutoPadding(false)`）。

CDN 上传 URL：
```
// 如果返回 upload_full_url → 直接用
// 如果返回 upload_param → 拼接：
https://novac2c.cdn.weixin.qq.com/c2c/upload
  ?encrypted_query_param=<upload_param>
  &filekey=<filekey>
```

```bash
POST <cdn_upload_url>
Content-Type: application/octet-stream
Body: <encrypted file bytes>

# 从响应头读取
x-encrypted-param: <encrypted_query_param 值>
```

**Step 3: 发送消息**

```json
{
  "type": 2,
  "image_item": {
    "media": {
      "encrypt_query_param": "<从 CDN 响应头获取的值>",
      "aes_key": "<base64(utf8(aesKeyHex))>",   // ⚠️ 注意转换方式
      "encrypt_type": 1
    }
  }
}
```

**⚠️ `media.aes_key` 格式转换：**
```
aesKeyHex = "fe578c4b104f897f480320b09b5e1f46"        // 32 hex chars
         → Buffer.from(aesKeyHex, "utf8")               // 32 bytes of UTF-8
         → .toString("base64")                           // 44 chars base64
         = "ZmU1NzhjNGIxMDRmODk3ZjQ4MDMyMGIwOWI1ZTFmNDY="
```
**注意：是 `base64(utf8(hex))`，不是 `base64(hex→bytes)`。**

### 5.4 发送文件

与图片相同流程，差异：
- `media_type: 3`（不是 1）
- `file_item.len` 是 **字符串**（不是 number）
- 最终 sendmessage 的 item 结构：

```json
{
  "type": 4,
  "file_item": {
    "media": {
      "encrypt_query_param": "...",
      "aes_key": "...",
      "encrypt_type": 1
    },
    "file_name": "document.pdf",
    "len": "102400"              // ← 字符串
  }
}
```

---

## 六、登录流程

### 6.1 获取 QR 码
```bash
GET /ilink/bot/get_bot_qrcode?bot_type=3
```
```json
// Response
{
  "ret": 0,
  "qrcode": "f5ff95a9f27d858c069779834be110c8",
  "qrcode_img_content": "https://liteapp.weixin.qq.com/q/7GiQu1?qrcode=..."  // ← URL，不是 base64!
}
```

`qrcode_img_content` 可能是 URL（`https://liteapp.weixin.qq.com/q/...`）或 base64 PNG。需要判断后处理：
- URL → 用 `qrcode` npm 包生成 QR 码 PNG
- base64 → 直接解码保存

### 6.2 轮询扫码状态
```bash
GET /ilink/bot/get_qrcode_status?qrcode=<qrcode_token>
```
```json
// 等待中
{ "status": "pending" }

// 已扫码待确认
{ "status": "scanned" }

// 已确认
{ "status": "confirmed", "bot_token": "659d9e4e9d...", "baseurl": "https://ilinkai.weixin.qq.com" }

// 已过期
{ "status": "expired" }
```

### 6.3 Token 持久化

首次登录后 token 写入文件，后续启动时检查：
- 有 token → 跳过扫码，直接启动轮询
- 无 token → 走完整 QR 登录流程
- Token 可能过期 → 轮询收到 auth error 时需要重新登录

### 6.4 长轮询收消息
```bash
POST /ilink/bot/getupdates
```
```json
// Request
{
  "get_updates_buf": "",        // 首次为空，后续用上次返回的游标
  "base_info": {
    "channel_version": "1.0.2"
  }
}

// Response（服务器 hold 最多 35s）
{
  "ret": 0,
  "msgs": [ ... ],
  "get_updates_buf": "<新游标>",
  "longpolling_timeout_ms": 35000
}
```

**断线重连：** 指数退避 1s→2s→4s→8s→16s→30s 封顶。成功收到消息后重置计数器。Auth 错误直接停止。

---

## 七、已测试消息类型矩阵

| 消息类型 | type | 微信→程序 | 程序→微信 |
|---------|------|----------|----------|
| 文字 | 1 | ✅ 已测 | ✅ 已测 |
| 表情 `[大哭]` | 1 (text) | ✅ 已测 | — |
| 语音（转文字） | 3 | ✅ 已测 | — |
| 图片 | 2 | ✅ 已测 | ✅ 已测 |
| 文件 (.docx) | 4 | ✅ 已测 | ✅ 已测 |
| 文件 (.txt) | 4 | ✅ 已测 | — |
| 引用消息 | 1 (带 ref_msg) | ✅ 已测 | — |
| 视频 | 5 | 未测 | 未测 |

---

## 八、关键踩坑记录

| 坑 | 错误做法 | 正确做法 |
|----|---------|---------|
| `getuploadurl` 字段不全 | 只传 3 个字段 | 传 **8 个字段** + `base_info` 包裹 |
| MD5 字段名 | `file_md5` | `rawfilemd5` |
| AES 填充 | `setAutoPadding(false)` + 手动零填充 | **默认 PKCS 填充** |
| 上传 URL 获取 | 只用 `upload_full_url` | `upload_full_url` 或 `upload_param` → 拼接 CDN URL |
| `media.aes_key` 格式 | hex 直接传 | `base64(utf8(hex))` |
| `file_item.len` | number | **string** |
| 图片 AES key 字段 | `aes_key` (下划线) | `aeskey` (无下划线) |
| 入站媒体 CDN 引用 | 找 `cdn_url` 字段 | 在 `media.encrypt_query_param` 里 |
| 语音转录字段 | 只查 `trans_text` | 检查 **6 个候选字段**（实测在 `text`） |
| 语音 CDN | 找 `silk_url` | 在 `voice_item.media.encrypt_query_param` |
| `sendmessage` 包体 | 只有 `msg` | `base_info` + `msg`（含 `client_id`, `from_user_id`） |
| QR 码格式 | 假设是 base64 PNG | 可能是 **liteapp URL**，需生成 QR 码 |

---

## 九、文件清单

```
test/features/02-wechat-connectivity/
├── README.md                  ← 本文档
├── feature-02.test.ts         ← 22 个单元测试
└── wechat/
    ├── types.ts               ← 全部消息类型定义（入站+出站）
    ├── crypto.ts              ← AES-128-ECB, MD5, key 生成
    ├── api.ts                 ← HTTP 客户端，所有 endpoint
    ├── auth.ts                ← QR 登录 + token 持久化
    ├── poller.ts              ← 长轮询 + 消息解析
    └── sender.ts              ← 发送文字/图片/文件 + CDN 上传

scripts/
├── check-wechat-qr.ts         ← QR 码获取快速检查
├── debug-upload.ts            ← 上传协议调试（含完整字段）
└── wechat-integration.ts      ← 交互式集成测试（QR→收→发）
```
