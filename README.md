# AI Agent 动态推理可视化

一个把"AI 一步步思考"的过程可视化出来的工具：你输入问题，AI 自动规划成多个推理步骤，你能看到每一步的输入输出、健康度、影响度，还能随时修改任意一步的 Prompt 让它重新算。

后端 Python (FastAPI) + 前端 React/TypeScript (Vite)，模型用火山方舟豆包。

---

## 功能亮点

- **动态规划**：AI 根据问题自动决定要几步、每步做什么
- **真实指标**：每步显示健康度/影响度/风险度，全部基于实际运行信号
- **可修改重算**：修改任意步骤的 System Prompt → 自动从这步开始重算后续
- **目标-子过程树**：可视化整个推理链，支持试运行预览修改效果
- **对话历史**：所有对话自动保存到浏览器，按日期分组，支持搜索/重命名
- **每用户独立 Key**：分享应用给别人，每个人在前端填自己的 API Key，互不干扰
- **流式 SSE**：边推理边显示，看得到一步步进度

---

## 一、运行环境要求

| 工具 | 版本要求 | 验证命令 |
|---|---|---|
| **Python** | ≥ 3.9 | `python --version` |
| **Node.js** | ≥ 18.0 | `node --version` |
| **npm** | ≥ 9.0（装 Node 时自带） | `npm --version` |
| **Git** | 任意版本 | `git --version` |

如果上面任何一个命令报"找不到"，去对应官网装：
- Python：https://www.python.org/downloads/（**装的时候勾选 "Add to PATH"**）
- Node.js：https://nodejs.org/（选 LTS 版本）
- Git：https://git-scm.com/downloads

---

## 二、克隆项目

```powershell
git clone https://github.com/你的用户名/Qingshen_Python.git
cd Qingshen_Python
```

> 项目结构：
> - `backend/` 后端（FastAPI + 豆包调用）
> - `frontend/` 前端（React + Vite + Tailwind）
> - `DEPLOY.md` 部署上线指南
> - `README.md` 本文件

---

## 三、安装依赖

> ⚠️ **国内用户必看**：直接 `pip install` / `npm install` 经常超时或卡住，**强烈建议先换源**。

### 3.1 后端依赖（Python）

#### 一次性配置 pip 清华源（永久生效）

```powershell
pip config set global.index-url https://pypi.tuna.tsinghua.edu.cn/simple
```

#### 装依赖

```powershell
cd backend
pip install -r requirements.txt
```

如果上一步报 SSL 错误（`UNEXPECTED_EOF_WHILE_READING`），换阿里源：

```powershell
pip install -r requirements.txt -i https://mirrors.aliyun.com/pypi/simple/ --trusted-host mirrors.aliyun.com
```

#### 国内镜像列表（任选其一）

| 源 | URL |
|---|---|
| 清华 | `https://pypi.tuna.tsinghua.edu.cn/simple` |
| 阿里 | `https://mirrors.aliyun.com/pypi/simple/` |
| 中科大 | `https://pypi.mirrors.ustc.edu.cn/simple/` |
| 豆瓣 | `https://pypi.doubanio.com/simple/` |

### 3.2 前端依赖（Node）

#### 一次性配置 npm 淘宝源（永久生效）

```powershell
npm config set registry https://registry.npmmirror.com
```

#### 装依赖

```powershell
cd ../frontend
npm install
```

如果失败（很慢或卡在某个包），可以试：

```powershell
# 用 cnpm（更快）
npm install -g cnpm --registry=https://registry.npmmirror.com
cnpm install

# 或用 pnpm（占空间小）
npm install -g pnpm --registry=https://registry.npmmirror.com
pnpm install
```

---

## 四、启动应用（每次开机后）

需要**两个 PowerShell 窗口**同时跑：

### 窗口 1：启动后端（必须先开）

```powershell
cd D:\path\to\Qingshen_Python\backend
python main.py
```

看到 `Uvicorn running on http://0.0.0.0:8000` 就成功了。**这个窗口不能关**。

### 窗口 2：启动前端

```powershell
cd D:\path\to\Qingshen_Python\frontend
npm run dev
```

看到类似下面的就成功了：
```
  ➜  Local:   http://localhost:5173/
```

打开浏览器访问 `http://localhost:5173`。

---

## 五、首次配置 API Key

第一次打开会自动弹出**设置面板**，需要填：

### 5.1 火山方舟 API Key

1. 去 [火山方舟控制台 - API Key 管理](https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey)
2. 点 **创建 API Key**
3. 创建时**勾选授权范围**：选择"全部接入点"或者具体勾选你要用的模型
4. 复制完整 Key（形如 `ark-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx-xxxxx`），粘贴到设置里

### 5.2 模型 ID

填 `doubao-seed-1-6-251015`（默认就是这个）。

如果你用的是自建接入点，去 [接入点页](https://console.volcengine.com/ark/region:ark+cn-beijing/endpoint) 复制 `ep-xxx-xxxx` 形式的 ID。

> ⚠️ **新模型必须先开通**：去 [开通管理](https://console.volcengine.com/ark/region:ark+cn-beijing/openManagement)，找到 "Doubao-Seed-1.6" 系列，点开通。第一次用要做实名认证。

### 5.3 后端服务地址

本地运行就保持默认 `http://localhost:8000`。

### 5.4 测试连通性

填完点**测试连通性**按钮：
- ✅ **连通正常** → 关掉设置面板，开始用
- 🔐 **API Key 无效** → Key 没勾对授权，回控制台编辑授权范围
- ⚠️ **模型不存在** → 模型没开通，去开通管理页面开通
- 🌐 **连不上服务器** → 后端没启动，或端口被占用，或代理软件干扰

---

## 六、常见问题排雷

### Q1：`pip install` 报 SSL 错误

```
SSLError(SSLEOFError(8, '[SSL: UNEXPECTED_EOF_WHILE_READING] EOF occurred...'))
```

99% 是代理软件（Clash、V2Ray 等）干扰了 HTTPS 连接。三种解决方法：

1. 临时关掉代理软件，再装一次
2. 加 `--trusted-host` 参数：
   ```powershell
   pip install -r requirements.txt -i https://mirrors.aliyun.com/pypi/simple/ --trusted-host mirrors.aliyun.com
   ```
3. 在代理软件里把 `pypi.org` 和 `tsinghua.edu.cn` 加进直连白名单

### Q2：`npm install` 卡在某个包

```powershell
# 删掉之前的安装残留
rd /s /q node_modules
del package-lock.json
# 用淘宝源重装
npm install --registry=https://registry.npmmirror.com
```

### Q3：后端启动报 `ModuleNotFoundError: No module named 'fastapi'`

依赖没装上。重新装：
```powershell
cd backend
pip install -r requirements.txt -i https://mirrors.aliyun.com/pypi/simple/ --trusted-host mirrors.aliyun.com
```

### Q4：前端启动报 `'vite' is not recognized`

`node_modules` 没装好。删了重装：
```powershell
cd frontend
rd /s /q node_modules
npm install --registry=https://registry.npmmirror.com
```

### Q5：浏览器打开页面，提示 `Failed to fetch`

100% 是后端没启动。看一下"窗口 1"那个 PowerShell，应该有输出 `Uvicorn running on http://0.0.0.0:8000`。如果窗口已经关了，重新跑一次 `python main.py`。

### Q6：后端启动报错 `ImportError: cannot import name 'Header' from 'fastapi'`

FastAPI 版本太老，升级一下：
```powershell
pip install --upgrade fastapi uvicorn pydantic -i https://mirrors.aliyun.com/pypi/simple/ --trusted-host mirrors.aliyun.com
```

### Q7：调用豆包 API 报 `401 AuthenticationError`

API Key 没勾对授权。回到火山方舟控制台 API Key 页，找到你的 Key，点编辑，勾选你要用的接入点/模型，保存。

### Q8：调用豆包 API 报 `model not found`

模型 ID 写错了，或者你账户下还没开通这个模型。去开通管理页面看一眼 "Doubao-Seed-1.6" 是不是"已开通"状态。

### Q9：Python 版本太低

```
ERROR: This package requires Python >=3.9
```

去 https://www.python.org/downloads/ 装新版本。装完用 `python --version` 验证。

### Q10：端口 8000 被占用

```
ERROR: [Errno 10048] address already in use
```

要么关掉占用 8000 端口的程序，要么改后端端口：
```powershell
cd backend
python -m uvicorn main:app --host 0.0.0.0 --port 8001
```
然后在前端设置里把"后端服务地址"改成 `http://localhost:8001`。

---

## 七、Git 上传到 GitHub（项目作者看）

### 7.1 第一次推送（如果项目还没在 GitHub 上）

#### Step 1：在 GitHub 网页上新建一个空仓库

去 https://github.com/new

- **Repository name**：`Qingshen_Python`（或别的名字）
- **Public** / **Private**：随便
- **不要勾**任何 "Initialize this repository with..."（README/.gitignore/license 全不勾）
- 点 **Create repository**

#### Step 2：本地推送

在项目根目录 `D:\Qingshen_Python` 里：

```powershell
# 初始化（如果还没初始化过）
git init
git branch -M main

# 配置你的 git 身份（第一次用 git 才需要）
git config --global user.name "你的名字"
git config --global user.email "你的邮箱"

# 添加所有文件（.gitignore 会自动排除 node_modules 等）
git add .

# 检查一下要提交的文件，确认 node_modules / .idea 没在里面
git status

# 第一次提交
git commit -m "init: AI Agent 动态推理项目"

# 关联远程仓库（替换成你的 GitHub 用户名）
git remote add origin https://github.com/你的用户名/Qingshen_Python.git

# 推送
git push -u origin main
```

如果推送时报 `Authentication failed`，GitHub 现在不支持密码登录了，需要：
- 方案 A：用 [GitHub Desktop](https://desktop.github.com/) 客户端，登录后图形界面操作
- 方案 B：在 GitHub 创建 [Personal Access Token](https://github.com/settings/tokens)，推送时密码栏粘 token

### 7.2 后续修改后再次推送

```powershell
git add .
git commit -m "描述这次改了什么"
git push
```

### 7.3 推送前检查清单

- [ ] `backend/main.py` 里 `DEFAULT_DOUBAO_API_KEY = os.getenv("ARK_API_KEY", "")` 是空字符串
- [ ] `backend/test_doubao.py` 和 `api_test.py` 里没有写死的 Key
- [ ] `git status` 看不到 `node_modules/`、`.idea/`、`__pycache__/`（如果看到说明 .gitignore 没生效，看下面如何救场）

如果不小心已经 commit 了 `node_modules`：
```powershell
git rm -r --cached frontend/node_modules
git rm -r --cached backend/__pycache__
git rm -r --cached .idea
git commit -m "fix: ignore generated files"
git push
```

---

## 八、别人下载后怎么跑（直接转发本节给他/她）

### 给新同学的快速指南

```powershell
# 1. 装好 Python 3.9+ 和 Node 18+（一次性）

# 2. 配国内源（一次性）
pip config set global.index-url https://pypi.tuna.tsinghua.edu.cn/simple
npm config set registry https://registry.npmmirror.com

# 3. 克隆项目
git clone https://github.com/原作者/Qingshen_Python.git
cd Qingshen_Python

# 4. 装依赖
cd backend && pip install -r requirements.txt && cd ..
cd frontend && npm install && cd ..

# 5. 跑后端（开一个窗口）
cd backend
python main.py

# 6. 跑前端（开另一个窗口）
cd frontend
npm run dev

# 7. 浏览器打开 http://localhost:5173
# 8. 在弹出的设置面板里填自己的火山方舟 API Key
```

### 一键脚本（Windows 用户）

项目根目录已经准备好两个 `.bat` 脚本（双击运行）：

- **`setup.bat`** - 一键配置国内源 + 装所有依赖（首次使用跑一次就行）
- **`start.bat`** - 一键开两个窗口跑前后端

---

## 九、其它文档

- **[DEPLOY.md](./DEPLOY.md)** - 怎么部署上线给陌生人通过 URL 访问

---

## 协议

MIT License — 随便用
