# Math Agent 可视化推理系统

一个用于展示和调试数学解题Agent内部推理过程的Web应用。

## 功能特性

- **子任务拆分可视化**: 将数学问题分解为"问题理解→算式转换→计算执行→答案生成"四个环节
- **实时流程追踪**: 展示每个子过程的输入输出
- **量化指标卡片**: 显示准确率、平均耗时、健康度（红黄绿灯）
- **Prompt编辑**: 可在线修改每个环节的Prompt并重跑
- **统计重构**: 修改后自动重跑并更新指标

## 技术栈

- **后端**: FastAPI + Python
- **前端**: React + TypeScript + TailwindCSS
- **流程可视化**: ReactFlow
- **状态管理**: Zustand

## 快速开始

### 后端启动

```bash
cd backend
pip install -r requirements.txt
python main.py
```

后端运行在 http://localhost:8000

### 前端启动

```bash
cd frontend
npm install
npm run dev
```

前端运行在 http://localhost:5173

## API接口

### POST /api/solve
解题接口，输入数学问题，返回分解后的推理过程

### GET /api/stats
获取各环节统计指标

### PUT /api/prompts/{stage}
更新指定环节的Prompt

### POST /api/rerun
使用更新后的Prompt重新运行测试

## 架构说明

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  问题理解   │ ──▶ │  算式转换   │ ──▶ │  计算执行   │ ──▶ │  答案生成   │
│ (Understand)│     │(Expression) │     │ (Calculate) │     │  (Answer)  │
└─────────────┘     └─────────────┘     └─────────────┘     └─────────────┘
```

每个环节输出:
- `input`: 环节输入
- `output`: 环节输出
- `accuracy`: 在测试集上的准确率
- `avgTime`: 平均耗时(ms)
- `health`: 健康度状态 (green/yellow/red)
