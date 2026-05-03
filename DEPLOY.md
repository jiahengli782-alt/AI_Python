# 部署 & 分享指南

> 让别人通过一个网址就能访问你这个 AI Agent 项目，并且每个人都用自己的 API Key（不消耗你的额度）。

## 三种方案对比

| 方案 | 适用场景 | 难度 | 成本 | 持久 |
|---|---|---|---|---|
| **① cloudflared 临时分享** | 演示给朋友/老师看几小时 | ⭐ 最简单 | 免费 | 关电脑就失效 |
| **② Vercel + Render 免费部署** | 长期分享，公开访问 | ⭐⭐ 中等 | 免费（有空闲限制） | 持久 |
| **③ 自己买云服务器** | 公司项目 / 高频访问 | ⭐⭐⭐ 复杂 | 30~100元/月 | 持久稳定 |

---

## ① 方案：cloudflared 临时分享（5 分钟搞定）

适合：现在马上就要给别人看，不想折腾。

### 安装 cloudflared

下载 Windows 客户端：https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/

下载 `cloudflared-windows-amd64.exe`，放到一个固定文件夹，比如 `C:\tools\`。

### 启动后端 + 暴露到公网

打开两个 PowerShell 窗口：

**窗口 1：跑后端**
```powershell
cd D:\AI_Python\backend
python main.py
```

**窗口 2：开通隧道**
```powershell
C:\tools\cloudflared.exe tunnel --url http://localhost:8000
```

cloudflared 会输出类似这样的信息：

```
Your quick Tunnel has been created! Visit it at:
https://random-words-1234.trycloudflare.com
```

记下这个 URL，这就是你后端的临时公网地址。

### 启动前端 + 暴露到公网

**窗口 3：跑前端**
```powershell
cd D:\AI_Python\frontend
npm run dev -- --host
```

记下 vite 输出的端口（一般是 5173）。

**窗口 4：再开一个隧道暴露前端**
```powershell
C:\tools\cloudflared.exe tunnel --url http://localhost:5173
```

记下这个新 URL，比如 `https://abc-frontend-5678.trycloudflare.com`。

### 分享

把**前端 URL** 发给别人。对方打开后：

1. 网页右上角会闪烁的"⚠️ 请填 API Key" → 点开
2. 在"后端服务地址"里填**后端的 cloudflared URL**（`https://random-words-1234.trycloudflare.com`）
3. 在"API Key"里填他/她自己的火山方舟 Key
4. 点"测试连通性" → 看到"✅ 连通正常"
5. 点"保存"，开始用

> ⚠️ 注意：你两个 PowerShell 窗口都不能关，关了网址就失效。cloudflared 临时隧道每次启动 URL 都不一样。

---

## ② 方案：Vercel（前端）+ Render（后端）免费部署

适合：长期对外开放，希望网址固定。**完全免费**，但 Render 免费版有"无访问后休眠"的特点。

### 准备工作

1. **注册账号**：
   - [Vercel](https://vercel.com) 用 GitHub 账号登录
   - [Render](https://render.com) 用 GitHub 账号登录
2. **把项目推到 GitHub**（如果还没推）：
   ```powershell
   cd D:\AI_Python
   git init
   git add .
   git commit -m "init"
   # 在 GitHub 新建 repo 后：
   git remote add origin https://github.com/你的用户名/AI_Python.git
   git push -u origin main
   ```
   > ⚠️ 推之前先确认 `backend/main.py` 里的 `DEFAULT_DOUBAO_API_KEY` 已经清空（默认空的，不要把自己 Key 写进去），不然别人 fork 你代码就能盗用你的额度。

### 部署后端到 Render

1. 在 Render 控制台点 **New → Web Service**
2. 选你的 GitHub 仓库
3. 配置：
   - **Name**：`agent-backend` （随便起）
   - **Root Directory**：`backend`
   - **Runtime**：`Python 3`
   - **Build Command**：`pip install -r requirements.txt`
   - **Start Command**：`uvicorn main:app --host 0.0.0.0 --port $PORT`
   - **Instance Type**：选 Free
4. **环境变量**（Environment Variables）添加：
   - `ARK_API_KEY`：留空（让用户自己在前端填）
   - `ALLOWED_ORIGINS`：暂时留 `*`，等前端部署后再改成具体域名
   - `DOUBAO_MODEL_NAME`（可选）：`doubao-seed-1-6-251015`
5. 点 **Create Web Service**，等 3-5 分钟构建完成
6. 拿到后端 URL，类似 `https://agent-backend-abcd.onrender.com`

### 部署前端到 Vercel

1. 在 Vercel 控制台点 **Add New → Project**
2. Import 你的 GitHub 仓库
3. 配置：
   - **Root Directory**：`frontend`
   - **Framework Preset**：会自动识别为 Vite
   - **Build Command**：`npm run build`
   - **Output Directory**：`dist`
4. 点 **Deploy**，等 1-2 分钟
5. 拿到前端 URL，类似 `https://qingshen-python.vercel.app`

### 锁定 CORS（推荐）

回到 Render 控制台，把 `ALLOWED_ORIGINS` 改成你的 Vercel 域名（不要加末尾斜杠）：
```
ALLOWED_ORIGINS=https://qingshen-python.vercel.app
```
保存后 Render 会自动重启。

### 分享

把 Vercel URL 发给别人。对方打开后：

1. 自动弹设置面板
2. **后端服务地址**填你的 Render URL：`https://agent-backend-abcd.onrender.com`
3. **API Key** 填自己的
4. 点测试 → 保存 → 开始用

> ⚠️ Render 免费版"15 分钟无访问就休眠"，第一次访问会冷启动 30~60 秒（前端会显示连不上）。再次访问就快了。如果需要永远在线，升级 Render 付费版（$7/月）或考虑方案 ③。

---

## ③ 方案：自己的云服务器

适合：你已经有阿里云/腾讯云/Vultr/Linode 服务器。

### 服务器要求
- Ubuntu 22.04+ / Debian 11+
- Python 3.10+，Node 18+
- 至少 1G 内存

### 步骤

1. SSH 上去：
   ```bash
   ssh root@你的服务器IP
   ```

2. 装环境：
   ```bash
   sudo apt update
   sudo apt install -y python3-pip python3-venv nodejs npm nginx
   curl -fsSL https://get.docker.com | sh   # 可选
   ```

3. clone 项目：
   ```bash
   git clone https://github.com/你的用户名/AI_Python.git
   cd AI_Python
   ```

4. 跑后端（systemd 服务保活）：
   ```bash
   cd backend
   python3 -m venv venv
   source venv/bin/activate
   pip install -r requirements.txt
   ```
   
   创建 `/etc/systemd/system/agent-backend.service`：
   ```ini
   [Unit]
   Description=Agent Backend
   After=network.target
   
   [Service]
   WorkingDirectory=/root/AI_Python/backend
   ExecStart=/root/AI_Python/backend/venv/bin/uvicorn main:app --host 0.0.0.0 --port 8000
   Restart=always
   Environment=ALLOWED_ORIGINS=https://你的前端域名.com
   
   [Install]
   WantedBy=multi-user.target
   ```
   
   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable --now agent-backend
   ```

5. 构建前端：
   ```bash
   cd ../frontend
   npm install
   npm run build
   sudo cp -r dist/* /var/www/html/
   ```

6. Nginx 反代：编辑 `/etc/nginx/sites-available/default`：
   ```nginx
   server {
     listen 80;
     server_name 你的域名.com;
     
     location / {
       root /var/www/html;
       try_files $uri /index.html;
     }
     
     location /api/ {
       proxy_pass http://127.0.0.1:8000;
       proxy_http_version 1.1;
       proxy_set_header Connection "";
       proxy_buffering off;     # SSE 必须关
       proxy_read_timeout 300s;
     }
   }
   ```
   
   ```bash
   sudo nginx -t && sudo systemctl reload nginx
   ```

7. 上 HTTPS（用 Certbot）：
   ```bash
   sudo apt install -y certbot python3-certbot-nginx
   sudo certbot --nginx -d 你的域名.com
   ```

8. 在前端用户的设置里：后端地址填 `https://你的域名.com`（不需要带端口和 /api）

---

## 通用注意事项

### 关于 API Key 安全

- **永远不要把自己的 API Key 提交到 GitHub 公开仓库**
- 如果之前提交过，立即去 [火山方舟控制台](https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey) 删掉那把 Key 重新生成
- 当前代码默认 `DEFAULT_DOUBAO_API_KEY` 是空的，请保持空状态部署

### 关于火山方舟接入点

如果你用的是接入点 ID（`ep-xxx-xxxx`），别人没有你的接入点权限，他们必须：
- 用模型名（`doubao-seed-1-6-251015`），不要用你的 endpoint ID
- 或者他们自己在自己账户下创建接入点

### 关于流式响应

- Render / 国内云服务器都支持 SSE
- Vercel **不能部署后端**（因为 Serverless 函数不支持长连接 SSE），所以前端 Vercel + 后端必须放别处

### 推荐组合

- **个人玩玩**：cloudflared 临时分享（方案 ①）
- **演示作品集**：Vercel + Render（方案 ②）
- **公司/课程项目**：阿里云轻量服务器 + 备案域名（方案 ③）
