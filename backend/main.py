"""
AI Agent 推理可视化系统后端
核心特性：
1. 问题分析规划器：根据用户问题动态决定需要哪些子过程
2. 准确率新定义：子过程对最终结果的影响程度（风险值）
3. 真实数据收集：从实际API调用获取耗时和准确率
"""
from fastapi import FastAPI, HTTPException, Header, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import PlainTextResponse, StreamingResponse
from pydantic import BaseModel
from typing import Optional, Dict, List, Any, Tuple
from contextvars import ContextVar
import httpx
import asyncio
import time
import uuid
from datetime import datetime
import json
import re
import os
import csv
import hashlib
import io
import zipfile
from urllib.parse import unquote
from xml.etree import ElementTree

try:
    from .diagnosis import attach_diagnosis, diagnose_step, diagnose_trace
except ImportError:
    from diagnosis import attach_diagnosis, diagnose_step, diagnose_trace

# 当前请求上下文里的 API Key / 模型 ID（每个请求独立）
_request_api_key: ContextVar[Optional[str]] = ContextVar("request_api_key", default=None)
_request_model: ContextVar[Optional[str]] = ContextVar("request_model", default=None)


def get_active_api_key() -> str:
    """优先使用请求里带的，没带就用全局默认"""
    key = _request_api_key.get() or DEFAULT_DOUBAO_API_KEY
    if not key:
        raise HTTPException(
            status_code=400,
            detail="缺少 API Key：请在前端右上角'设置'里填入你的火山方舟 API Key（或在服务器设置 ARK_API_KEY 环境变量）"
        )
    return key


def get_active_model() -> str:
    return _request_model.get() or DEFAULT_MODEL_NAME or "doubao-seed-1-6-251015"

app = FastAPI(title="Agent Visualizer API")

# CORS 配置
# 部署时可以用 ALLOWED_ORIGINS 环境变量收紧到具体域名（逗号分隔），默认 * 方便开发
_allowed_origins_env = os.getenv("ALLOWED_ORIGINS", "*")
_allowed_origins = (
    ["*"] if _allowed_origins_env.strip() == "*"
    else [o.strip() for o in _allowed_origins_env.split(",") if o.strip()]
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins,
    # allow_credentials 在 origin=* 时会被浏览器忽略，前端用 header 传 key 不依赖 cookie
    allow_credentials=False if _allowed_origins == ["*"] else True,
    allow_methods=["*"],
    allow_headers=["*", "X-Ark-Api-Key", "X-Ark-Model", "X-File-Name", "X-File-Type"],
)

# 豆包 API 配置（按优先级使用）：
#   1. 请求头 X-Ark-Api-Key / X-Ark-Model（用户在前端"设置"里填的）
#   2. 环境变量 ARK_API_KEY / DOUBAO_MODEL_NAME（部署者在服务器上配的）
#   3. 下面写死的 fallback（仅本地开发用，部署到公网时建议清空避免被盗用额度）
DEFAULT_DOUBAO_API_KEY = os.getenv("ARK_API_KEY", "")
DEFAULT_MODEL_NAME = os.getenv("DOUBAO_MODEL_NAME", "doubao-seed-1-6-251015")
DOUBAO_BASE_URL = os.getenv("ARK_BASE_URL", "https://ark.cn-beijing.volces.com/api/v3")

# 兼容旧代码的引用
DOUBAO_API_KEY = DEFAULT_DOUBAO_API_KEY
MODEL_NAME = DEFAULT_MODEL_NAME

# ==================== 问题分类系统 ====================

PROBLEM_TYPES = {
    "math": {
        "keywords": ["计算", "数学", "方程", "函数", "几何", "概率", "统计", "+", "-", "*", "/", "等于", "求解"],
        "required_skills": ["理解问题", "问题分解", "计算执行", "结果验证"],
        "risk_high": ["计算执行"],  # 计算错误会直接导致答案错误
        "risk_medium": ["问题分解"],
    },
    "code": {
        "keywords": ["代码", "程序", "函数", "算法", "bug", "import", "def ", "class ", "==", "!="],
        "required_skills": ["需求理解", "逻辑设计", "代码生成", "语法检查"],
        "risk_high": ["代码生成"],
        "risk_medium": ["逻辑设计"],
    },
    "science": {
        "keywords": ["为什么", "原理", "科学", "物理", "化学", "生物", "解释", "机制"],
        "required_skills": ["问题理解", "原理分析", "解释生成", "准确性检查"],
        "risk_high": ["原理分析"],
        "risk_medium": ["准确性检查"],
    },
    "general": {
        "keywords": [],  # 默认类型
        "required_skills": ["问题理解", "信息检索", "答案生成", "质量检查"],
        "risk_high": ["答案生成"],
        "risk_medium": ["质量检查"],
    }
}

# 可用的子过程技能定义
SKILL_DEFINITIONS: Dict[str, Dict[str, Any]] = {
    "理解问题": {
        "description": "分析问题的核心和关键要素",
        "system_prompt": """你是一个问题分析专家。请分析用户的问题：
1. 识别问题的核心是什么
2. 提取关键信息和要求
3. 判断问题类型（数学/编程/科学/常识）

输出JSON格式：
{
    "core": "核心问题",
    "key_info": ["关键信息1", "关键信息2"],
    "problem_type": "问题类型"
}""",
        "user_template": "请分析这个问题：\n{question}"
    },
    "问题分解": {
        "description": "将复杂问题拆分为可处理的步骤",
        "system_prompt": """你是一个问题分解专家。请将问题分解为可执行的步骤：
1. 识别前置条件
2. 列出需要解决的关键子问题
3. 确定执行顺序

输出JSON格式：
{
    "steps": ["步骤1", "步骤2", "步骤3"],
    "dependencies": {"步骤2": "步骤1"}
}""",
        "user_template": "请分解这个问题：\n{question}\n\n已知信息：\n{previous_output}"
    },
    "计算执行": {
        "description": "执行数学计算或逻辑推理",
        "system_prompt": """你是一个计算专家。请执行精确的计算：
1. 列出计算步骤
2. 执行每一步计算
3. 检查计算结果

输出JSON格式：
{
    "calculation_steps": ["步骤1: ...", "步骤2: ..."],
    "result": "最终结果",
    "verification": "验证说明"
}""",
        "user_template": "请执行计算：\n{question}\n\n问题分析：\n{previous_output}"
    },
    "结果验证": {
        "description": "验证推理过程和结果的正确性",
        "system_prompt": """你是一个验证专家。请验证推理结果的正确性：
1. 检查推理逻辑是否严密
2. 识别可能的错误或漏洞
3. 评估结果的可靠性

输出JSON格式：
{
    "is_correct": true/false,
    "confidence": 0.0-1.0,
    "issues": ["问题1", "问题2"],
    "suggestions": ["建议1"]
}""",
        "user_template": "请验证以下推理结果：\n问题：{question}\n\n推理过程：\n{previous_output}"
    },
    "需求理解": {
        "description": "理解编程或技术需求",
        "system_prompt": """你是一个需求分析专家。请理解编程需求：
1. 明确输入输出要求
2. 识别约束条件
3. 确定功能范围

输出JSON格式：
{
    "inputs": ["输入1", "输入2"],
    "outputs": ["输出1"],
    "constraints": ["约束1"],
    "functionality": "功能描述"
}""",
        "user_template": "请分析这个需求：\n{question}"
    },
    "逻辑设计": {
        "description": "设计算法逻辑和实现方案",
        "system_prompt": """你是一个算法设计专家。请设计解决方案：
1. 提出可行的算法思路
2. 分析时间和空间复杂度
3. 选择最优方案

输出JSON格式：
{
    "approaches": [{"name": "方法1", "complexity": "O(n)"}],
    "selected": "方法1",
    "reasoning": "选择原因"
}""",
        "user_template": "请设计解决方案：\n{question}\n\n需求分析：\n{previous_output}"
    },
    "代码生成": {
        "description": "生成可执行的代码",
        "system_prompt": """你是一个代码生成专家。请生成高质量代码：
1. 确保代码正确性和可读性
2. 添加必要的注释
3. 处理边界情况

只输出代码，不要解释。""",
        "user_template": "请生成代码：\n{question}\n\n设计方案：\n{previous_output}"
    },
    "语法检查": {
        "description": "检查代码语法和逻辑错误",
        "system_prompt": """你是一个代码审查专家。请检查代码：
1. 语法错误
2. 逻辑错误
3. 潜在问题
4. 改进建议

输出JSON格式：
{
    "has_errors": true/false,
    "errors": ["错误1"],
    "warnings": ["警告1"],
    "improvements": ["改进1"]
}""",
        "user_template": "请检查以下代码：\n{previous_output}"
    },
    "原理分析": {
        "description": "分析科学原理和机制",
        "system_prompt": """你是一个科学专家。请分析问题背后的原理：
1. 解释相关原理
2. 分析因果关系
3. 提供理论依据

输出JSON格式：
{
    "principles": ["原理1", "原理2"],
    "analysis": "详细分析",
    "references": ["参考1"]
}""",
        "user_template": "请分析这个科学问题：\n{question}"
    },
    "解释生成": {
        "description": "生成清晰易懂的解释",
        "system_prompt": """你是一个科普专家。请生成清晰易懂的解释：
1. 用通俗语言解释
2. 结合实例说明
3. 确保逻辑清晰

输出JSON格式：
{
    "summary": "简要总结",
    "explanation": "详细解释",
    "examples": ["例子1", "例子2"]
}""",
        "user_template": "请解释：\n{question}\n\n原理分析：\n{previous_output}"
    },
    "准确性检查": {
        "description": "检查答案的准确性和可靠性",
        "system_prompt": """你是一个质量检查专家。请检查答案质量：
1. 事实准确性
2. 逻辑完整性
3. 可靠性评估

输出JSON格式：
{
    "accuracy": 0.0-1.0,
    "issues": ["问题"],
    "corrections": ["修正"]
}""",
        "user_template": "请检查这个答案：\n问题：{question}\n\n答案：\n{previous_output}"
    },
    "问题理解": {
        "description": "理解问题的本质和意图",
        "system_prompt": """你是一个理解专家。请深度理解问题：
1. 理解用户真正想问什么
2. 识别隐含信息
3. 明确回答方向

输出JSON格式：
{
    "true_intent": "真实意图",
    "implied_info": ["隐含信息"],
    "answer_direction": "回答方向"
}""",
        "user_template": "请深入理解这个问题：\n{question}"
    },
    "信息检索": {
        "description": "检索和整合相关信息",
        "system_prompt": """你是一个信息整合专家。请整合相关信息：
1. 提取相关事实
2. 组织信息结构
3. 排除无关信息

输出JSON格式：
{
    "relevant_info": ["信息1", "信息2"],
    "sources": ["来源"],
    "relevance": "相关性说明"
}""",
        "user_template": "请检索整合信息：\n{question}\n\n问题理解：\n{previous_output}"
    },
    "答案生成": {
        "description": "综合信息生成最终答案",
        "system_prompt": """你是一个回答专家。请生成最终答案：
1. 综合所有分析
2. 给出清晰完整的答案
3. 确保有逻辑有依据

输出JSON格式：
{
    "answer": "最终答案",
    "confidence": 0.0-1.0,
    "basis": ["依据1", "依据2"]
}""",
        "user_template": "请生成最终答案：\n问题：{question}\n\n分析结果：\n{previous_output}"
    },
    "质量检查": {
        "description": "全面检查答案质量",
        "system_prompt": """你是一个质量评估专家。请全面评估答案：
1. 完整性检查
2. 准确性验证
3. 改进建议

输出JSON格式：
{
    "completeness": 0.0-1.0,
    "accuracy": 0.0-1.0,
    "overall_score": 0.0-1.0,
    "improvements": ["改进1"]
}""",
        "user_template": "请评估答案质量：\n问题：{question}\n\n答案：\n{previous_output}"
    }
}

# ==================== 数据模型 ====================

class SolveRequest(BaseModel):
    question: str
    documentIds: Optional[List[str]] = None

class StreamSolveRequest(BaseModel):
    question: str
    startStepIndex: int = 0
    modifiedOutputs: Optional[Dict[str, str]] = None
    modifiedSteps: Optional[Dict[str, Any]] = None
    baseStages: Optional[List[Dict[str, Any]]] = None
    previewMode: bool = False
    reasoningEffort: str = "medium"
    documentIds: Optional[List[str]] = None

class ResearchCaseSaveRequest(BaseModel):
    title: Optional[str] = None
    objective: Optional[str] = None
    caseType: Optional[str] = "current_session"
    question: Optional[str] = None
    notes: Optional[str] = None
    tags: Optional[List[str]] = None
    expectedFailureTypes: Optional[List[str]] = None
    subprocesses: Optional[List[Dict[str, Any]]] = None
    traceDiagnosis: Optional[Dict[str, Any]] = None
    replayRecords: Optional[List[Dict[str, Any]]] = None
    uploadedDocuments: Optional[List[Dict[str, Any]]] = None

class UpdateSkillRequest(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    systemPrompt: Optional[str] = None
    userPromptTemplate: Optional[str] = None

class StepModification(BaseModel):
    """单个步骤的修改配置"""
    systemPrompt: Optional[str] = None
    userPromptTemplate: Optional[str] = None
    input: Optional[str] = None
    output: Optional[str] = None

# 修改后的步骤配置存储: {step_id: StepModification}
MODIFIED_STEPS: Dict[str, StepModification] = {}

# ==================== 存储数据 ====================

# 当前会话状态
CURRENT_SESSION: Dict[str, Any] = {
    "question": "",
    "subprocesses": [],
    "executionId": "",
    "timestamp": "",
    "currentSubprocess": None,
    "isRunning": False
}

# 执行历史记录
EXECUTION_HISTORY: List[Dict[str, Any]] = []

# 统计信息（真实数据）
STATS: Dict[str, Dict[str, Any]] = {}

# 上传文档只保存在当前后端进程内，避免把原文写入仓库或日志。
DOCUMENT_STORE: Dict[str, Dict[str, Any]] = {}
MAX_UPLOAD_BYTES = 8 * 1024 * 1024
MAX_DOCUMENT_CONTEXT_CHARS = 5200

# 研究级 failure case，同样只保存在当前后端进程内，便于本地复现实验。
RESEARCH_CASES: Dict[str, Dict[str, Any]] = {}


def compact_report_text(value: Any, limit: int = 900) -> str:
    text = str(value or "").strip()
    if len(text) <= limit:
        return text
    return text[:limit].rstrip() + "\n...（已在 UI/JSON 中保留完整内容）"


def failure_case_template() -> Dict[str, Any]:
    return {
        "schemaVersion": "research_case_v1",
        "requiredFields": [
            "title",
            "objective",
            "question",
            "input_artifacts",
            "expected_failure_types",
            "observed_failure_types",
            "step_diagnosis",
            "replay_records",
            "fix_hypotheses",
        ],
        "failureTaxonomy": [
            "fact_error",
            "unsupported_claim",
            "tool_misuse",
            "retrieval_miss",
            "planning_error",
            "self_inconsistency",
            "constraint_violation",
            "format_error",
            "hallucination",
            "invalid_retry",
            "cost_latency_anomaly",
            "memory_pollution",
            "context_omission",
        ],
        "reproductionChecklist": [
            "保存原始问题和上传文档/日志摘要",
            "保存每个 step 的输入、输出、失败类型、证据源和 provenance 边",
            "至少保存一次 replay：改了哪个 step、改前/改后最终输出、影响到哪些下游 step",
            "导出报告时保留 trace summary、step 级错误、真实证据和修复假设",
        ],
    }


def summarize_stage_for_case(stage: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "id": stage.get("id"),
        "order": stage.get("order"),
        "name": stage.get("name") or stage.get("skill"),
        "stage": stage.get("stage"),
        "diagnosis_status": stage.get("diagnosis_status"),
        "failure_type": stage.get("failure_type"),
        "failure_label": stage.get("failure_label"),
        "failure_confidence": stage.get("failure_confidence"),
        "evidence_source": stage.get("evidence_source"),
        "failure_reason_summary": stage.get("failure_reason_summary"),
        "failure_reason": stage.get("failure_reason"),
        "where_to_steps": stage.get("where_to_steps") or [],
        "affected_steps": stage.get("affected_steps") or [],
        "input": stage.get("input"),
        "output": stage.get("output"),
        "provenance_nodes": stage.get("provenance_nodes") or [],
        "provenance_edges": stage.get("provenance_edges") or [],
        "potential_risks": stage.get("potential_risks") or [],
        "suggested_fix": stage.get("suggested_fix") or [],
    }


def build_research_case_from_payload(payload: ResearchCaseSaveRequest) -> Dict[str, Any]:
    stages = payload.subprocesses if payload.subprocesses is not None else CURRENT_SESSION.get("subprocesses", [])
    trace = payload.traceDiagnosis if payload.traceDiagnosis is not None else CURRENT_SESSION.get("traceDiagnosis")
    question = payload.question or CURRENT_SESSION.get("question") or ""
    observed_failure_types = sorted({
        str(stage.get("failure_type"))
        for stage in stages
        if stage.get("failure_type") and stage.get("failure_type") != "none"
    })
    case_id = "case_" + hashlib.sha1(f"{payload.title}:{question}:{datetime.now().isoformat()}".encode("utf-8", errors="ignore")).hexdigest()[:12]
    replay_records = payload.replayRecords or []
    documents = payload.uploadedDocuments or [
        {
            "id": doc_id,
            "filename": DOCUMENT_STORE[doc_id].get("filename"),
            "charCount": len(DOCUMENT_STORE[doc_id].get("text", "")),
            "chunkCount": len(DOCUMENT_STORE[doc_id].get("chunks", [])),
        }
        for doc_id in (CURRENT_SESSION.get("documentIds") or [])
        if doc_id in DOCUMENT_STORE
    ]
    return {
        "id": case_id,
        "schemaVersion": "research_case_v1",
        "title": payload.title or (question[:28] + ("..." if len(question) > 28 else "")) or "未命名 failure case",
        "objective": payload.objective or "复现并解释一次 Agent 推理失败，定位 failure type、证据来源和下游传播。",
        "caseType": payload.caseType or "current_session",
        "question": question,
        "notes": payload.notes or "",
        "tags": payload.tags or [],
        "createdAt": datetime.now().isoformat(),
        "input_artifacts": {
            "documents": documents,
            "executionId": CURRENT_SESSION.get("executionId"),
            "historySize": len(EXECUTION_HISTORY),
        },
        "expected_failure_types": payload.expectedFailureTypes or [],
        "observed_failure_types": observed_failure_types,
        "traceDiagnosis": trace,
        "step_diagnosis": [summarize_stage_for_case(stage) for stage in stages],
        "replay_records": replay_records,
        "fix_hypotheses": [
            fix
            for stage in stages
            for fix in (stage.get("suggested_fix") or [])
        ][:12],
    }


def render_case_report(case: Dict[str, Any]) -> str:
    trace = case.get("traceDiagnosis") or {}
    lines = [
        f"# Research Failure Case: {case.get('title')}",
        "",
        "## 1. Case Metadata",
        f"- Case ID: `{case.get('id')}`",
        f"- Created At: {case.get('createdAt')}",
        f"- Type: {case.get('caseType')}",
        f"- Tags: {', '.join(case.get('tags') or []) or '无'}",
        "",
        "## 2. Research Objective",
        compact_report_text(case.get("objective"), 1200),
        "",
        "## 3. Original Question",
        compact_report_text(case.get("question"), 1800),
        "",
        "## 4. Failure Taxonomy",
        f"- Expected: {', '.join(case.get('expected_failure_types') or []) or '未预设'}",
        f"- Observed: {', '.join(case.get('observed_failure_types') or []) or '未观察到明确失败'}",
        f"- Trace Status: {trace.get('overall_status') or 'unknown'}",
        f"- Main Failure: {trace.get('main_failure_label') or trace.get('main_failure_type') or 'unknown'}",
        f"- Summary: {trace.get('summary') or '无'}",
        "",
        "## 5. Step-Level Diagnosis",
    ]
    for step in case.get("step_diagnosis") or []:
        risks = step.get("potential_risks") or []
        lines.extend([
            "",
            f"### Step {step.get('order')}: {step.get('name')}",
            f"- Status: {step.get('diagnosis_status') or 'normal'}",
            f"- Failure Type: {step.get('failure_label') or step.get('failure_type') or 'none'}",
            f"- Confidence: {step.get('failure_confidence') if step.get('failure_confidence') is not None else 'n/a'}",
            f"- Where To: {', '.join('Step ' + str(item) for item in (step.get('where_to_steps') or [])) or '无直接下游'}",
            f"- Affected Steps: {', '.join('Step ' + str(item) for item in (step.get('affected_steps') or [])) or '无'}",
            f"- Evidence Source: {compact_report_text(step.get('evidence_source'), 1200) or '无'}",
            f"- Why/How: {compact_report_text(step.get('failure_reason') or step.get('failure_reason_summary'), 1200) or '无'}",
        ])
        if risks:
            lines.append("- Potential Risks:")
            for risk in risks[:4]:
                lines.append(f"  - {risk.get('label') or risk.get('failure_type')}: {compact_report_text(risk.get('reason') or risk.get('reason_summary'), 500)}")
    lines.extend(["", "## 6. Replay / Counterfactual Records"])
    replay_records = case.get("replay_records") or []
    if not replay_records:
        lines.append("暂无 replay 记录。")
    for record in replay_records:
        lines.extend([
            "",
            f"### Replay: Step {record.get('stepOrder')} {record.get('stepName')}",
            f"- Prompt Change: {compact_report_text(record.get('promptSummary'), 600)}",
            f"- Changed Steps: {record.get('changedSteps') or []}",
            f"- Affected Steps: {record.get('affectedSteps') or []}",
            f"- Final Delta: {record.get('finalDelta')}%",
            f"- Before: {compact_report_text(record.get('finalBeforeFull') or record.get('finalBefore'), 1000)}",
            f"- After: {compact_report_text(record.get('finalAfterFull') or record.get('finalAfter'), 1000)}",
        ])
    lines.extend(["", "## 7. Fix Hypotheses"])
    fixes = case.get("fix_hypotheses") or []
    if fixes:
        lines.extend([f"- {fix}" for fix in fixes])
    else:
        lines.append("暂无修复假设。")
    if case.get("notes"):
        lines.extend(["", "## 8. Notes", compact_report_text(case.get("notes"), 1600)])
    return "\n".join(lines) + "\n"


def build_demo_research_cases() -> List[Dict[str, Any]]:
    demo_payloads = [
        ResearchCaseSaveRequest(
            title="Demo Case 1: 上线状态证据不足",
            objective="验证系统能把“正式上线”这类状态判断定位为证据不足，而不是把摘要里的完成字样当作事实。",
            caseType="demo_reproduction",
            question="请根据服务目录确认云岚社区健康服务平台二期目前已正式上线的核心功能有哪些？",
            expectedFailureTypes=["retrieval_miss", "unsupported_claim"],
            tags=["demo", "evidence", "status"],
            subprocesses=[
                {"id": "demo1_step1", "order": 1, "name": "识别问题对象与状态字段", "input": "用户要求确认二期正式上线功能", "output": "需要检查服务目录中的功能名称和上线状态。", "diagnosis_status": "normal", "failure_type": "none", "where_to_steps": [2]},
                {"id": "demo1_step2", "order": 2, "name": "检索服务目录证据", "input": "查找正式上线状态", "output": "只看到摘要写有已完成建设，未找到服务目录表或上线状态字段。", "diagnosis_status": "failure", "failure_type": "retrieval_miss", "failure_label": "证据缺失", "failure_confidence": 0.82, "evidence_source": "当前输出只提到“已完成建设”，没有文件名、表格行号或“正式上线”状态字段。", "failure_reason": "本步需要证明哪些功能正式上线，但检索结果没有拿到服务目录确认表或上线状态字段，所以后续不能直接下结论。", "where_to_steps": [3, 4], "affected_steps": [3, 4], "suggested_fix": ["要求检索步骤必须输出文件名、表格行号、功能名称和上线状态；找不到时写“证据不足”。"]},
                {"id": "demo1_step3", "order": 3, "name": "生成上线功能清单", "input": "使用 Step 2 证据", "output": "把已完成建设误写成正式上线。", "diagnosis_status": "warning", "failure_type": "unsupported_claim", "failure_label": "无证据断言", "failure_confidence": 0.68, "evidence_source": "Step 2 没有给出上线状态字段。", "where_to_steps": [4]},
                {"id": "demo1_step4", "order": 4, "name": "最终核验", "input": "核验清单", "output": "应要求补充服务目录表。", "diagnosis_status": "normal", "failure_type": "none"},
            ],
            traceDiagnosis={"overall_status": "partial_failure", "main_failure_type": "retrieval_miss", "main_failure_label": "证据缺失", "summary": "上线状态的关键证据没有进入检索步骤，后续生成步骤存在无证据断言风险。"},
            replayRecords=[{"stepOrder": 2, "stepName": "检索服务目录证据", "promptSummary": "强制输出文件名、表格行号、功能名称、上线状态；没有就写证据不足。", "changedSteps": [2, 3], "affectedSteps": [3, 4], "finalDelta": 46, "finalBefore": "列出已完成建设功能", "finalAfter": "无法确认正式上线功能，需补充服务目录确认表。"}],
        ),
        ResearchCaseSaveRequest(
            title="Demo Case 2: API 429 后继续生成结论",
            objective="验证工具/API 失败后是否停止后续业务结论生成，并把错误码传播到后续 step。",
            caseType="demo_reproduction",
            question="根据最新接口日志总结今天失败最多的支付错误类型。",
            expectedFailureTypes=["tool_misuse"],
            tags=["demo", "api", "log"],
            subprocesses=[
                {"id": "demo2_step1", "order": 1, "name": "确定日志查询范围", "input": "今天支付错误", "output": "需要查询 payment error logs。", "diagnosis_status": "normal", "failure_type": "none", "where_to_steps": [2]},
                {"id": "demo2_step2", "order": 2, "name": "调用日志接口", "input": "payment error logs", "output": "API调用失败: 429 - SetLimitExceeded", "diagnosis_status": "failure", "failure_type": "tool_misuse", "failure_label": "工具/API调用失败", "failure_confidence": 0.93, "evidence_source": "API调用失败: 429 - SetLimitExceeded", "failure_reason": "日志接口返回额度限制，当前没有真实日志结果。后续如果继续统计错误类型，就是基于失败工具结果的虚构结论。", "where_to_steps": [3, 4], "affected_steps": [3, 4], "suggested_fix": ["工具失败时停止生成业务统计结论，只输出错误码、失败接口和需要重试的条件。"]},
                {"id": "demo2_step3", "order": 3, "name": "聚合错误类型", "input": "使用 Step 2 日志", "output": "无法聚合，因为日志接口失败。", "diagnosis_status": "normal", "failure_type": "none"},
                {"id": "demo2_step4", "order": 4, "name": "输出报告", "input": "聚合结果", "output": "报告应提示 API 额度限制。", "diagnosis_status": "normal", "failure_type": "none"},
            ],
            traceDiagnosis={"overall_status": "failure", "main_failure_type": "tool_misuse", "main_failure_label": "工具/API调用失败", "summary": "真实失败来自日志接口 429，后续 step 应停止生成统计结论。"},
            replayRecords=[{"stepOrder": 2, "stepName": "调用日志接口", "promptSummary": "工具失败时输出错误边界并停止后续事实结论。", "changedSteps": [2, 3, 4], "affectedSteps": [3, 4], "finalDelta": 61, "finalBefore": "支付超时最多", "finalAfter": "API 429，无法确认今天失败最多的支付错误类型。"}],
        ),
        ResearchCaseSaveRequest(
            title="Demo Case 3: 长文档上下文遗漏",
            objective="验证前序文档片段中出现的硬约束是否被后续步骤继承。",
            caseType="demo_reproduction",
            question="根据上传的活动方案，生成对外宣传文案，但不能出现价格承诺和未审批合作方名称。",
            expectedFailureTypes=["context_omission", "constraint_violation"],
            tags=["demo", "context", "constraint"],
            subprocesses=[
                {"id": "demo3_step1", "order": 1, "name": "提取硬约束", "input": "上传活动方案", "output": "硬约束：不能出现价格承诺；不能出现未审批合作方名称。", "diagnosis_status": "normal", "failure_type": "none", "where_to_steps": [2, 3]},
                {"id": "demo3_step2", "order": 2, "name": "生成宣传文案", "input": "活动亮点", "output": "文案包含“最低价保障”和合作方 A。", "diagnosis_status": "failure", "failure_type": "context_omission", "failure_label": "关键上下文遗漏", "failure_confidence": 0.79, "evidence_source": "Step 1 已提取“不能出现价格承诺；不能出现未审批合作方名称”，但 Step 2 输出出现“最低价保障”和合作方 A。", "failure_reason": "上游硬约束没有被带入生成步骤，导致输出违反用户明确限制。", "where_to_steps": [3], "affected_steps": [3], "suggested_fix": ["生成步骤的输入必须显式包含硬约束清单，并在输出前逐条自检。"]},
                {"id": "demo3_step3", "order": 3, "name": "约束核验", "input": "检查宣传文案", "output": "发现价格承诺和未审批合作方名称。", "diagnosis_status": "failure", "failure_type": "constraint_violation", "failure_label": "约束违反", "failure_confidence": 0.86, "evidence_source": "输出文本包含“最低价保障”和合作方 A。", "failure_reason": "最终核验能看到明确违规文本，应标红并阻止作为最终答案。"},
            ],
            traceDiagnosis={"overall_status": "failure", "main_failure_type": "context_omission", "main_failure_label": "关键上下文遗漏", "summary": "硬约束在 Step 1 出现，但未进入 Step 2 生成输入，导致文案违反约束。"},
            replayRecords=[{"stepOrder": 2, "stepName": "生成宣传文案", "promptSummary": "把 Step 1 的硬约束原样带入生成输入，并要求逐条自检。", "changedSteps": [2, 3], "affectedSteps": [3], "finalDelta": 52, "finalBefore": "最低价保障，合作方 A 联合推出", "finalAfter": "删除价格承诺和未审批合作方名称，输出合规文案。"}],
        ),
    ]
    return [build_research_case_from_payload(payload) for payload in demo_payloads]


def decode_text_bytes(data: bytes) -> str:
    for encoding in ("utf-8-sig", "utf-8", "gb18030", "gbk"):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="ignore")


def extract_docx_text(data: bytes) -> str:
    paragraphs: List[str] = []
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            xml_bytes = archive.read("word/document.xml")
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"无法读取 DOCX 内容：{exc}") from exc

    try:
        root = ElementTree.fromstring(xml_bytes)
    except ElementTree.ParseError as exc:
        raise HTTPException(status_code=400, detail=f"DOCX XML 解析失败：{exc}") from exc

    namespace = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
    for paragraph in root.findall(".//w:p", namespace):
        parts: List[str] = []
        for node in paragraph.iter():
            if node.tag.endswith("}t") and node.text:
                parts.append(node.text)
            elif node.tag.endswith("}tab"):
                parts.append("\t")
        text = "".join(parts).strip()
        if text:
            paragraphs.append(text)
    return "\n".join(paragraphs)


def extract_pdf_text(data: bytes) -> str:
    try:
        from pypdf import PdfReader  # type: ignore
    except Exception as exc:
        raise HTTPException(
            status_code=415,
            detail="当前后端未安装 pypdf，暂时无法解析 PDF。请先上传 txt/md/csv/docx，或安装 pypdf 后重启后端。"
        ) from exc

    try:
        reader = PdfReader(io.BytesIO(data))
        pages = []
        for index, page in enumerate(reader.pages):
            text = page.extract_text() or ""
            if text.strip():
                pages.append(f"【第 {index + 1} 页】\n{text.strip()}")
        return "\n\n".join(pages)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"PDF 解析失败：{exc}") from exc


def extract_uploaded_document_text(filename: str, content_type: str, data: bytes) -> str:
    suffix = os.path.splitext(filename.lower())[1]
    if suffix in {".txt", ".md", ".markdown", ".json", ".log"} or content_type.startswith("text/"):
        return decode_text_bytes(data)
    if suffix == ".csv":
        raw = decode_text_bytes(data)
        rows = list(csv.reader(io.StringIO(raw)))
        return "\n".join(" | ".join(cell.strip() for cell in row) for row in rows)
    if suffix == ".docx":
        return extract_docx_text(data)
    if suffix == ".pdf":
        return extract_pdf_text(data)
    fallback = decode_text_bytes(data).strip()
    if fallback:
        return fallback
    raise HTTPException(status_code=415, detail=f"暂不支持该文件类型：{suffix or content_type or 'unknown'}")


def chunk_document_text(text: str, chunk_size: int = 900, overlap: int = 120) -> List[Dict[str, Any]]:
    clean = re.sub(r"\r\n?", "\n", text or "").strip()
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n+", clean) if p.strip()]
    chunks: List[Dict[str, Any]] = []
    buffer = ""

    def flush_buffer():
        nonlocal buffer
        content = buffer.strip()
        if content:
            chunks.append({
                "index": len(chunks) + 1,
                "text": content,
                "preview": re.sub(r"\s+", " ", content)[:160],
            })
        buffer = ""

    for paragraph in paragraphs or [clean]:
        if len(paragraph) > chunk_size:
            flush_buffer()
            start = 0
            while start < len(paragraph):
                piece = paragraph[start:start + chunk_size].strip()
                if piece:
                    chunks.append({
                        "index": len(chunks) + 1,
                        "text": piece,
                        "preview": re.sub(r"\s+", " ", piece)[:160],
                    })
                start += max(1, chunk_size - overlap)
            continue
        if len(buffer) + len(paragraph) + 2 > chunk_size:
            flush_buffer()
        buffer = f"{buffer}\n\n{paragraph}".strip()
    flush_buffer()
    return chunks


def tokenize_for_retrieval(text: str) -> List[str]:
    lowered = (text or "").lower()
    latin = re.findall(r"[a-z0-9_]{2,}", lowered)
    cjk = re.findall(r"[\u4e00-\u9fff]{2,}", lowered)
    cjk_terms: List[str] = []
    for token in cjk:
        cjk_terms.extend(token[i:i + 2] for i in range(max(0, len(token) - 1)))
        if len(token) >= 3:
            cjk_terms.extend(token[i:i + 3] for i in range(max(0, len(token) - 2)))
    return latin + cjk_terms


def retrieve_document_context(question: str, document_ids: Optional[List[str]]) -> str:
    if not document_ids:
        return ""
    query_terms = tokenize_for_retrieval(question)
    query_set = set(query_terms)
    candidates: List[Tuple[float, Dict[str, Any], Dict[str, Any]]] = []
    selected_docs = [DOCUMENT_STORE[doc_id] for doc_id in document_ids if doc_id in DOCUMENT_STORE]
    if not selected_docs:
        return ""

    for doc in selected_docs:
        for chunk in doc.get("chunks", []):
            chunk_terms = tokenize_for_retrieval(chunk.get("text", ""))
            if query_set and chunk_terms:
                overlap = sum(1 for term in chunk_terms if term in query_set)
                score = overlap / max(8, len(set(chunk_terms)))
            else:
                score = 0.01 if not candidates else 0.0
            if score > 0:
                candidates.append((score, doc, chunk))

    if not candidates:
        for doc in selected_docs:
            for chunk in doc.get("chunks", [])[:2]:
                candidates.append((0.01, doc, chunk))

    candidates.sort(key=lambda item: item[0], reverse=True)
    blocks: List[str] = []
    total = 0
    for _, doc, chunk in candidates[:8]:
        text = chunk.get("text", "").strip()
        if not text:
            continue
        block = f"[{doc['filename']} · 片段 {chunk['index']}]\n{text}"
        if total + len(block) > MAX_DOCUMENT_CONTEXT_CHARS:
            remaining = MAX_DOCUMENT_CONTEXT_CHARS - total
            if remaining <= 240:
                break
            block = block[:remaining]
        blocks.append(block)
        total += len(block)
        if total >= MAX_DOCUMENT_CONTEXT_CHARS:
            break
    return "\n\n".join(blocks)


def build_question_with_documents(question: str, document_ids: Optional[List[str]]) -> str:
    context = retrieve_document_context(question, document_ids)
    if not context:
        return question
    return (
        f"{question}\n\n"
        "【已上传文档的相关片段】\n"
        f"{context}\n\n"
        "【使用要求】\n"
        "1. 文档能支持的结论必须引用文件名和片段编号。\n"
        "2. 文档没有证据时要明确写“文档证据不足”，不能编造。\n"
        "3. 后续 when/where/why/how 诊断需要优先追踪这些文档片段。"
    )

# ==================== 豆包API调用 ====================

def compact_for_model(text: str, max_chars: int = 1600) -> str:
    """压缩试运行上下文，保留开头和结尾，减少预览时的模型输入token。"""
    clean = re.sub(r"\s+", " ", text or "").strip()
    if len(clean) <= max_chars:
        return clean
    head = int(max_chars * 0.62)
    tail = int(max_chars * 0.28)
    return f"{clean[:head]}\n...\n{clean[-tail:]}"


def is_quota_error(error_text: str) -> bool:
    """识别额度/限流错误，避免后续步骤继续无意义调用。"""
    text = error_text or ""
    return (
        "429" in text
        or "SetLimitExceeded" in text
        or "quota" in text.lower()
        or "limit" in text.lower()
    )


def _make_httpx_client(proxy: Optional[str] = None) -> httpx.AsyncClient:
    """创建 httpx 客户端，兼容新旧版本的代理参数名

    注意：trust_env=False 让 httpx 忽略系统的 HTTP_PROXY/HTTPS_PROXY 环境变量，
    避免 Clash/V2Ray 等代理软件干扰 HTTPS 连接导致 SSL_EOF 错误。
    如需主动走代理，请通过参数显式传 proxy。
    """
    # 提高连接池上限，降低高并发时的握手开销
    limits = httpx.Limits(max_keepalive_connections=20, max_connections=40, keepalive_expiry=60.0)
    if not proxy:
        return httpx.AsyncClient(timeout=120.0, trust_env=False, limits=limits)
    try:
        return httpx.AsyncClient(timeout=120.0, proxy=proxy, trust_env=False, limits=limits)   # httpx >= 0.20
    except TypeError:
        return httpx.AsyncClient(timeout=120.0, proxies=proxy, trust_env=False, limits=limits) # httpx < 0.20


# 全局复用的 httpx 客户端，避免每次调用都重建 TCP+SSL 连接（每次握手~200-500ms）
_GLOBAL_HTTPX_CLIENT: Optional[httpx.AsyncClient] = None


def get_global_client() -> httpx.AsyncClient:
    """获取全局复用的 httpx 客户端，懒初始化"""
    global _GLOBAL_HTTPX_CLIENT
    if _GLOBAL_HTTPX_CLIENT is None or _GLOBAL_HTTPX_CLIENT.is_closed:
        env_proxy = (
            os.environ.get("HTTPS_PROXY")
            or os.environ.get("https_proxy")
            or os.environ.get("HTTP_PROXY")
            or os.environ.get("http_proxy")
            or os.environ.get("ALL_PROXY")
        )
        _GLOBAL_HTTPX_CLIENT = _make_httpx_client(env_proxy)
    return _GLOBAL_HTTPX_CLIENT


@app.on_event("shutdown")
async def shutdown_httpx_client():
    """服务关闭时优雅关闭 httpx 客户端"""
    global _GLOBAL_HTTPX_CLIENT
    if _GLOBAL_HTTPX_CLIENT and not _GLOBAL_HTTPX_CLIENT.is_closed:
        await _GLOBAL_HTTPX_CLIENT.aclose()


async def call_doubao_api(
    messages: List[Dict],
    temperature: float = 0.7,
    max_tokens: Optional[int] = None,
    reasoning_effort: str = "medium"
) -> Tuple[str, float]:
    """调用豆包 API。API Key/Model 从当前请求上下文取（前端传的优先，回退到环境变量）"""
    api_key = get_active_api_key()  # 抛 400 如果没有 key
    model_name = get_active_model()
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json"
    }
    payload = {
        "model": model_name,
        "messages": messages,
        "reasoning_effort": reasoning_effort,
        "max_completion_tokens": max_tokens if max_tokens else 8192,
    }

    start_time = time.time()
    try:
        # 复用全局客户端，避免每次重建 TCP+SSL 连接
        client = get_global_client()
        response = await client.post(
            f"{DOUBAO_BASE_URL}/chat/completions",
            headers=headers,
            json=payload
        )

        elapsed_time = (time.time() - start_time) * 1000

        if response.status_code != 200:
            error_detail = response.text
            raise Exception(f"API调用失败: {response.status_code} - {error_detail}")

        result = response.json()
        content = result["choices"][0]["message"]["content"]

        if "<|FunctionExecuteResult|>" in content:
            content = content.split("<|FunctionExecuteResult|>")[-1]
            content = content.split("<|FunctionExecuteResultEnd|>")[0] if "<|FunctionExecuteResultEnd|>" in content else content

        return content.strip(), elapsed_time

    except httpx.HTTPStatusError as e:
        raise Exception(f"API调用失败: {e.response.status_code} - {e.response.text}")
    except Exception as e:
        raise Exception(f"API调用错误: {str(e)}")


# ==================== AI健康度评估 ====================

async def evaluate_step_health(
    step_name: str,
    step_description: str,
    input_data: str,
    output_data: str,
    time_ms: float
) -> dict:
    """基于可观测信号评估当前步骤的健康度（输出质量）。
    
    这里不再把健康度完全交给另一次模型主观打分，而是使用输出长度、
    错误信号、结构完整度、输入输出相关性、重复度和耗时等真实运行信号。
    """
    output = output_data or ""
    input_text = input_data or ""
    score = 100.0
    issues: List[str] = []
    suggestions: List[str] = []

    if not output.strip():
        score -= 65
        issues.append("输出为空，无法支撑后续推理")
    if "API调用失败" in output or "API调用错误" in output:
        score -= 70
        issues.append("模型调用失败，当前步骤没有真实推理输出")
    if len(output.strip()) < 20:
        score -= 25
        issues.append("输出过短，信息量不足")
    elif len(output.strip()) < 80:
        score -= 10
        suggestions.append("输出较短，建议补充关键依据")

    relevance = text_similarity(input_text, output)
    if input_text and relevance < 0.04:
        score -= 15
        issues.append("输入与输出文本相关性较低")

    if re.search(r"\{[\s\S]*\}", output):
        json_match = re.search(r"\{[\s\S]*\}", output)
        try:
            json.loads(json_match.group() if json_match else output)
        except json.JSONDecodeError:
            score -= 12
            issues.append("输出看起来像 JSON，但结构无法解析")

    if has_excessive_repetition(output):
        score -= 15
        issues.append("输出存在明显重复，可能降低可用性")

    if any(token in output for token in ["我不知道", "无法回答", "不确定", "占位", "TODO"]):
        score -= 12
        suggestions.append("输出包含不确定或占位表达，需要复核")

    if time_ms > 15000:
        score -= 8
        suggestions.append("执行时间偏长，可能需要缩短提示词或拆分步骤")
    elif time_ms == 0 and output.strip():
        suggestions.append("该步骤使用了人工提交输出，耗时不参与健康度扣分")

    score = int(round(clamp(score, 0, 100)))
    health = "green" if score >= 75 else "yellow" if score >= 50 else "red"

    return {
        "health": health,
        "health_score": score,
        "issues": issues,
        "suggestions": suggestions,
        "signals": {
            "length": len(output.strip()),
            "inputOutputSimilarity": round(relevance, 3),
            "timeMs": round(time_ms, 2)
        }
    }


def clamp(value: float, low: float = 0.0, high: float = 1.0) -> float:
    return max(low, min(high, value))


def text_ngrams(text: str, n: int = 2) -> set:
    compact = re.sub(r"\s+", "", text or "").lower()
    if not compact:
        return set()
    if len(compact) <= n:
        return {compact}
    return {compact[i:i + n] for i in range(len(compact) - n + 1)}


def text_similarity(a: str, b: str) -> float:
    """字符 bigram Jaccard，相比词切分更适合中英文混合文本。"""
    left = text_ngrams(a)
    right = text_ngrams(b)
    if not left or not right:
        return 0.0
    return len(left & right) / len(left | right)


def text_delta(a: str, b: str) -> float:
    if (a or "").strip() == (b or "").strip():
        return 0.0
    if not (a or "").strip() and not (b or "").strip():
        return 0.0
    return 1 - text_similarity(a, b)


def has_excessive_repetition(text: str) -> bool:
    compact = re.sub(r"\s+", "", text or "")
    if len(compact) < 80:
        return False
    chunks = [compact[i:i + 20] for i in range(0, len(compact) - 20, 20)]
    if not chunks:
        return False
    return len(set(chunks)) / len(chunks) < 0.55


def risk_level_to_score(level: str) -> float:
    return {"high": 0.88, "medium": 0.62, "low": 0.34}.get(level, 0.62)


def score_to_risk_level(score: float) -> str:
    if score >= 0.72:
        return "high"
    if score >= 0.45:
        return "medium"
    return "low"


def assess_step_risk(step: Dict[str, Any], index: int, total: int) -> Dict[str, Any]:
    """评估步骤出错后对最终答案的后果风险。"""
    total = max(total, 1)
    raw_level = step.get("risk_level", "medium")
    planner_score = risk_level_to_score(raw_level)
    downstream_weight = (total - index) / total
    text = " ".join([
        step.get("name", ""),
        step.get("description", ""),
        step.get("system_prompt", ""),
        step.get("user_template", "")
    ]).lower()

    critical_keywords = [
        "最终", "结论", "答案", "计算", "证明", "代码", "生成", "原理",
        "事实", "检索", "推理", "决策", "评估", "final", "answer", "calculate"
    ]
    checking_keywords = ["验证", "检查", "复核", "质量", "校验", "review", "verify"]

    keyword_hits = sum(1 for word in critical_keywords if word in text)
    check_hits = sum(1 for word in checking_keywords if word in text)
    keyword_score = clamp(keyword_hits / 4, 0, 1)
    check_score = clamp(check_hits / 3, 0, 1)

    # 越早的步骤影响更多下游；最终生成/计算类步骤也有高后果风险。
    score = (
        planner_score * 0.32
        + downstream_weight * 0.28
        + keyword_score * 0.28
        + check_score * 0.12
    )
    score = clamp(score, 0.18, 0.98)

    return {
        "risk_level": score_to_risk_level(score),
        "risk_score": round(score, 3),
        "risk_factors": [
            f"规划器风险={raw_level}",
            f"下游影响权重={downstream_weight:.2f}",
            f"关键任务命中={keyword_hits}",
            f"校验任务命中={check_hits}"
        ]
    }


def calibrate_subprocess_risk(subprocesses: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    total = len(subprocesses)
    for index, step in enumerate(subprocesses):
        assessment = assess_step_risk(step, index, total)
        step["risk_level"] = assessment["risk_level"]
        step["risk_score"] = assessment["risk_score"]
        step["risk_factors"] = assessment["risk_factors"]
    return subprocesses


def calculate_expected_impact(
    risk_score: float,
    health_score: int,
    step_index: int,
    total_steps: int,
    output: str
) -> Tuple[float, Dict[str, Any]]:
    """无上一版本时，给出基于链路位置、风险和输出可用性的预期影响度。"""
    total_steps = max(total_steps, 1)
    downstream_weight = (total_steps - step_index) / total_steps
    output_quality = clamp(health_score / 100)
    if "API调用失败" in (output or ""):
        output_quality *= 0.25

    impact = clamp(
        risk_score * 0.48
        + downstream_weight * 0.34
        + output_quality * 0.18,
        0.03,
        0.99
    )
    return impact, {
        "mode": "expected",
        "riskScore": round(risk_score, 3),
        "downstreamWeight": round(downstream_weight, 3),
        "outputQuality": round(output_quality, 3)
    }


def apply_measured_impacts(
    stages: List[Dict[str, Any]],
    base_stages: Optional[List[Dict[str, Any]]],
    changed_step_index: int
) -> List[Dict[str, Any]]:
    """有上一版本时，用输出差异和最终答案差异更新实测影响度。"""
    if not base_stages:
        return stages

    old_final = base_stages[-1].get("output", "") if base_stages else ""
    new_final = stages[-1].get("output", "") if stages else ""
    final_delta = text_delta(old_final, new_final)

    for index, stage in enumerate(stages):
        if index < changed_step_index:
            continue
        old_output = base_stages[index].get("output", "") if index < len(base_stages) else ""
        output_delta = text_delta(old_output, stage.get("output", ""))
        measured = clamp(final_delta * 0.7 + output_delta * 0.3, 0.0, 1.0)
        if stage.get("metricBasis"):
            stage["metricBasis"].update({
                "mode": "measured",
                "finalDelta": round(final_delta, 3),
                "outputDelta": round(output_delta, 3)
            })
        else:
            stage["metricBasis"] = {
                "mode": "measured",
                "finalDelta": round(final_delta, 3),
                "outputDelta": round(output_delta, 3)
            }
        stage["accuracy"] = round(measured, 3)
        stage["measuredImpact"] = round(measured, 3)
    return stages


def apply_diagnosis_to_health(stage: Dict[str, Any]) -> Dict[str, Any]:
    """让健康度和诊断结果一致：内容错误源不能继续显示高健康度。"""
    status = stage.get("diagnosis_status")
    if status == "failure":
        current = int(stage.get("healthScore") or 80)
        stage["healthScore"] = min(current, 48)
        stage["health"] = "red" if stage["healthScore"] < 45 else "yellow"
        issue = stage.get("failure_label") or stage.get("failure_type") or "诊断发现内容错误源"
        issues = list(stage.get("healthIssues") or [])
        if issue not in issues:
            issues.insert(0, issue)
        stage["healthIssues"] = issues
    elif status == "warning":
        current = int(stage.get("healthScore") or 80)
        stage["healthScore"] = min(current, 72)
        if stage.get("health") == "green":
            stage["health"] = "yellow"
    elif stage.get("potential_risks"):
        current = int(stage.get("healthScore") or 80)
        strongest = max(
            (float(item.get("confidence") or 0) for item in stage.get("potential_risks", [])),
            default=0.0
        )
        stage["healthScore"] = min(current, 78 if strongest >= 0.68 else 86)
        if stage.get("health") == "green" and strongest >= 0.68:
            stage["health"] = "yellow"
        tags = stage.get("potential_issue_tags") or []
        if tags:
            issues = list(stage.get("healthIssues") or [])
            issue = f"潜在推理风险：{', '.join(tags[:2])}"
            if issue not in issues:
                issues.insert(0, issue)
            stage["healthIssues"] = issues
    return stage


def stage_to_subprocess(stage: Dict[str, Any], index: int) -> Dict[str, Any]:
    """将前端传回的上一版 stage 还原为可执行步骤，避免重跑时重新规划漂移。"""
    user_template = stage.get("userPromptTemplate") or "问题：{question}\n\n已知：\n{previous_output}"
    return {
        "id": stage.get("id", f"step_{index + 1}"),
        "name": stage.get("name", f"步骤{index + 1}"),
        "description": stage.get("description", ""),
        "system_prompt": stage.get("systemPrompt", ""),
        "user_template": user_template,
        "reasoning": stage.get("reasoning", "沿用上一版规划"),
        "risk_level": stage.get("riskLevel", "medium"),
        "risk_score": stage.get("riskScore", risk_level_to_score(stage.get("riskLevel", "medium"))),
        "risk_factors": stage.get("riskFactors", []),
        "order": stage.get("order", index + 1)
    }

# ==================== 问题分析规划器 ====================

def classify_problem(question: str) -> str:
    """根据关键词分类问题类型"""
    question_lower = question.lower()
    
    max_match = 0
    best_type = "general"
    
    for ptype, config in PROBLEM_TYPES.items():
        if ptype == "general":
            continue
        matches = sum(1 for kw in config["keywords"] if kw in question_lower)
        if matches > max_match:
            max_match = matches
            best_type = ptype
    
    return best_type

async def plan_subprocesses(question: str) -> List[Dict[str, Any]]:
    """动态规划子过程：根据具体问题生成独特的推理步骤"""

    planning_prompt = f"""你是一个AI推理规划专家。请分析以下问题，规划出最适合的推理步骤。

问题：{question}

要求：
1. 根据问题的具体内容和类型，生成独特的推理步骤序列
2. 每个步骤要有清晰的名称和描述
3. 步骤要具体、有针对性，不是固定的模板
4. 步骤数量根据问题复杂度决定（简单问题3-4步，复杂问题5-8步）

输出JSON格式（必须严格遵循）：
{{
    "steps": [
        {{
            "name": "步骤名称（简洁明了）",
            "description": "这个步骤做什么",
            "system_prompt": "给AI的具体指令，告诉AI在这个步骤应该做什么",
            "user_template": "用户的输入模板，使用{{question}}和{{previous_output}}占位",
            "risk_level": "high/medium/low"  // 这个步骤出错对最终答案的影响程度
        }}
    ]
}}

请直接输出JSON，不要有其他内容："""

    try:
        messages = [
            {"role": "system", "content": "你是一个专业的AI推理规划专家，擅长分析问题并设计最优的推理步骤。"},
            {"role": "user", "content": planning_prompt}
        ]

        # 规划阶段用 minimal 推理强度 + 较小 max_tokens：
        # 规划只是输出 JSON 结构，不需要深度思考，可以省 3-8 秒
        content, _ = await call_doubao_api(messages, reasoning_effort="minimal", max_tokens=2048)

        # 解析JSON
        json_match = re.search(r'\{[\s\S]*\}', content)
        if json_match:
            result = json.loads(json_match.group())
            if "steps" in result and isinstance(result["steps"], list):
                subprocesses = []
                for i, step in enumerate(result["steps"]):
                    subprocesses.append({
                        "id": f"step_{i+1}",
                        "name": step.get("name", f"步骤{i+1}"),
                        "description": step.get("description", ""),
                        "system_prompt": step.get("system_prompt", ""),
                        "user_template": step.get("user_template", "问题：{question}\n\n已知：\n{previous_output}"),
                        "reasoning": f"动态规划：{step.get('description', '')}",
                        "risk_level": step.get("risk_level", "medium"),
                        "order": i + 1
                    })
                return calibrate_subprocess_risk(subprocesses)

    except Exception as e:
        print(f"动态规划失败: {e}, 使用默认规划")

    # 降级方案：使用默认的通用规划
    return get_default_subprocesses(question)

def get_default_subprocesses(question: str) -> List[Dict[str, Any]]:
    """默认的通用规划（降级方案）"""
    return calibrate_subprocess_risk([
        {
            "id": "step_1",
            "name": "问题分析",
            "description": "分析问题类型和关键要素",
            "system_prompt": "你是一个专业的问题分析专家。请分析问题的类型、核心要点和解决方向。",
            "user_template": "问题：{question}\n\n请分析这个问题并给出你的分析。",
            "reasoning": "默认规划：问题分析",
            "risk_level": "medium",
            "order": 1
        },
        {
            "id": "step_2",
            "name": "深入推理",
            "description": "基于分析进行深入推理",
            "system_prompt": "你是一个专业的推理分析专家。请基于已有分析进行深入推理。",
            "user_template": "问题：{question}\n\n已知分析：\n{previous_output}\n\n请继续深入推理。",
            "reasoning": "默认规划：深入推理",
            "risk_level": "medium",
            "order": 2
        },
        {
            "id": "step_3",
            "name": "得出结论",
            "description": "综合推理结果给出最终答案",
            "system_prompt": "你是一个专业的总结专家。请基于之前的分析给出最终答案。",
            "user_template": "问题：{question}\n\n已知推理：\n{previous_output}\n\n请给出最终答案。",
            "reasoning": "默认规划：得出结论",
            "risk_level": "high",
            "order": 3
        },
    ])

# ==================== SSE事件生成器 ====================

async def generate_solve_events(
    question: str,
    start_step_index: int = 0,
    modified_outputs: dict = None,
    modified_steps: dict = None,
    base_stages: Optional[List[Dict[str, Any]]] = None,
    preview_mode: bool = False,
    reasoning_effort: str = "medium",
    api_key: Optional[str] = None,
    model_name: Optional[str] = None,
    document_ids: Optional[List[str]] = None,
):
    """生成SSE事件流

    Args:
        question: 问题
        start_step_index: 从哪个步骤开始执行（之前的步骤使用modified_outputs中的结果）
        modified_outputs: 修改后的输出，格式为 {step_id: output_content}
        modified_steps: 修改后的步骤配置，格式为 {step_id: {"systemPrompt": ..., "userPromptTemplate": ..., "input": ...}}
        base_stages: 上一版完整步骤，用于固定规划并做版本差异测量
        preview_mode: 树状图试运行模式，使用较短上下文和输出，且不写入正式会话/历史
        api_key: 本次请求使用的 API Key（前端传，覆盖默认值）
        model_name: 本次请求使用的模型 ID（前端传，覆盖默认值）
    """
    # 把请求级别的 key/model 注入到 ContextVar，让 call_doubao_api 自动取到
    token_key = _request_api_key.set(api_key) if api_key else None
    token_model = _request_model.set(model_name) if model_name else None
    try:
        async for chunk in _generate_solve_events_inner(
            question, start_step_index, modified_outputs, modified_steps,
            base_stages, preview_mode, reasoning_effort, document_ids
        ):
            yield chunk
    finally:
        if token_key is not None:
            _request_api_key.reset(token_key)
        if token_model is not None:
            _request_model.reset(token_model)


async def _generate_solve_events_inner(
    question: str,
    start_step_index: int = 0,
    modified_outputs: dict = None,
    modified_steps: dict = None,
    base_stages: Optional[List[Dict[str, Any]]] = None,
    preview_mode: bool = False,
    reasoning_effort: str = "medium",
    document_ids: Optional[List[str]] = None,
):
    """SSE 事件生成器（内层），由 generate_solve_events 包裹注入 ContextVar"""
    execution_id = str(uuid.uuid4())[:8]
    timestamp = datetime.now().isoformat()
    model_question = build_question_with_documents(question, document_ids)

    if base_stages is None and start_step_index > 0:
        session_stages = CURRENT_SESSION.get("subprocesses") or []
        same_question = CURRENT_SESSION.get("question") == question
        if same_question and session_stages:
            base_stages = session_stages

    # 发送开始事件
    yield f"event: start\ndata: {json.dumps({'executionId': execution_id, 'timestamp': timestamp, 'question': question})}\n\n"

    # 动态规划子过程。重跑某个版本时沿用上一版完整规划，避免步骤漂移。
    if base_stages:
        yield f"event: planning\ndata: {json.dumps({'message': '正在沿用上一版规划并准备重算后续步骤...'})}\n\n"
        subprocesses = calibrate_subprocess_risk([
            stage_to_subprocess(stage, index)
            for index, stage in enumerate(base_stages)
        ])
    else:
        yield f"event: planning\ndata: {json.dumps({'message': '正在分析问题并规划推理步骤...'})}\n\n"
        subprocesses = await plan_subprocesses(model_question)

    start_step_index = max(0, min(start_step_index, len(subprocesses) - 1 if subprocesses else 0))
    run_subprocesses = subprocesses[start_step_index:] if subprocesses else []

    # 发送规划完成事件
    plan_payload = {
        "subprocesses": [
            {
                "id": s["id"],
                "name": s["name"],
                "skill": s.get("skill", s.get("name", "")),
                "risk_level": s["risk_level"],
                "reasoning": s["reasoning"],
                "systemPrompt": s.get("system_prompt", ""),
                "userPrompt": s.get("user_template", ""),
            }
            for s in subprocesses
        ]
    }
    yield f"event: plan_complete\ndata: {json.dumps(plan_payload)}\n\n"
    
    preserved_stages = [dict(stage) for stage in (base_stages or [])[:start_step_index]]
    stages = preserved_stages.copy()
    current_output = stages[-1].get("output", model_question) if stages else model_question
    total_stages = max(len(subprocesses), 1)
    total_run_stages = max(len(run_subprocesses), 1)

    for idx, subprocess in enumerate(run_subprocesses):
        absolute_index = start_step_index + idx
        subprocess_id = subprocess["id"]
        subprocess_name = subprocess["name"]
        risk_level = subprocess["risk_level"]
        risk_score = float(subprocess.get("risk_score", risk_level_to_score(risk_level)))

        # 发送阶段开始事件
        stage_start_payload = {
            "stageId": subprocess_id,
            "name": subprocess_name,
            "skill": subprocess.get("skill", subprocess_name),
            "riskLevel": risk_level,
            "riskScore": round(risk_score * 100),
            "order": subprocess["order"],
            "progress": (absolute_index / total_stages) * 100,
            "reasoning": subprocess.get("reasoning", ""),
        }
        yield f"event: stage_start\ndata: {json.dumps(stage_start_payload)}\n\n"

        # 更新当前会话状态。试运行只返回临时预览，不污染正式会话。
        if not preview_mode:
            CURRENT_SESSION["currentSubprocess"] = subprocess_id
            CURRENT_SESSION["isRunning"] = True

        # 获取该步骤的修改配置
        step_mod = (modified_steps or {}).get(subprocess_id, {})

        # 构建消息 - 优先使用修改后的配置
        system_prompt = step_mod.get("systemPrompt") or subprocess.get("system_prompt", "")
        user_template = step_mod.get("userPromptTemplate") or subprocess.get("user_template", "问题：{question}\n\n已知：\n{previous_output}")

        # 如果有修改后的输入，优先使用
        step_input = step_mod.get("input") if step_mod.get("input") is not None else current_output
        model_system_prompt = system_prompt
        model_step_input = step_input
        model_user_template = user_template

        if preview_mode:
            model_system_prompt = (
                compact_for_model(system_prompt, 900)
                + "\n\n这是树状图试运行预览：只输出会影响后续步骤的关键结论，控制在350字以内，不要展开冗长解释。"
            )
            model_step_input = compact_for_model(step_input, 900)
            model_user_template = compact_for_model(user_template, 700)

        try:
            user_content = model_user_template.format(
                question=model_question,
                previous_output=model_step_input
            )
        except (KeyError, ValueError):
            user_content = f"{model_user_template}\n\n问题：{model_question}\n\n已知：\n{model_step_input}"
        if preview_mode:
            user_content = compact_for_model(user_content, 1600)
        messages = [{"role": "system", "content": model_system_prompt}]
        messages.append({"role": "user", "content": user_content})

        # 调用API
        time_ms = 0
        output = ""

        # 检查是否使用了修改后的输出
        is_modified = False
        if modified_outputs and subprocess_id in modified_outputs:
            modified_output = modified_outputs[subprocess_id]
            if modified_output and modified_output.strip():
                # 使用用户修改的输出，跳过API调用
                output = modified_output
                time_ms = 100  # 模拟耗时
                is_modified = True
                yield f"event: api_call_end\ndata: {json.dumps({'stageId': subprocess_id, 'timeMs': round(time_ms, 2), 'modified': True})}\n\n"
            elif modified_output == '':
                # 空字符串表示需要重新执行（用户没有提供新输出）
                is_modified = False

        if not is_modified:
            try:
                # 发送API调用开始
                yield f"event: api_call_start\ndata: {json.dumps({'stageId': subprocess_id, 'stageName': subprocess_name})}\n\n"

                # 速度优化：根据场景选择 max_tokens
                # - 试运行：4096（最快）
                # - 修改重算（base_stages 存在）：4096（重算只需看变化，不需要长输出）
                # - 正常推理：默认 8192
                if preview_mode:
                    step_max_tokens = 4096
                elif base_stages:
                    step_max_tokens = 4096
                else:
                    step_max_tokens = None  # 用 call_doubao_api 内的默认值 8192

                output, time_ms = await call_doubao_api(
                    messages,
                    temperature=0.25 if preview_mode else 0.7,
                    max_tokens=step_max_tokens,
                    reasoning_effort="minimal" if preview_mode else reasoning_effort
                )

                # 发送API调用完成
                yield f"event: api_call_end\ndata: {json.dumps({'stageId': subprocess_id, 'timeMs': round(time_ms, 2)})}\n\n"

            except Exception as e:
                error_text = str(e)
                output = f"API调用失败: {error_text}"
                time_ms = 0

                # 发送API错误
                yield f"event: api_error\ndata: {json.dumps({'stageId': subprocess_id, 'error': error_text})}\n\n"
                if is_quota_error(error_text):
                    if not preview_mode:
                        CURRENT_SESSION["currentSubprocess"] = None
                        CURRENT_SESSION["isRunning"] = False
                    return
        
        # ========== 健康度评估 ==========
        health_evaluation = await evaluate_step_health(
            step_name=subprocess_name,
            step_description=subprocess.get("description", ""),
            input_data=step_input,
            output_data=output,
            time_ms=time_ms
        )
        health = health_evaluation["health"]
        health_issues = health_evaluation.get("issues", [])
        health_suggestions = health_evaluation.get("suggestions", [])
        health_score = health_evaluation.get("health_score", 80)

        # ========== 影响度 ==========
        # 初始运行使用结构化预期影响度；版本重算完成后会再用最终答案差异覆盖为实测影响度。
        accuracy, metric_basis = calculate_expected_impact(
            risk_score=risk_score,
            health_score=health_score,
            step_index=absolute_index,
            total_steps=total_stages,
            output=output
        )
        
        # 获取统计信息
        stats = STATS.get(subprocess_id, {
            "avgTimeMs": 1000.0,
            "totalRuns": 0
        })
        
        stage_data = {
            "id": subprocess_id,
            "name": subprocess_name,
            "skill": subprocess.get("skill", subprocess_name),
            "description": subprocess.get("description", ""),
            "input": step_input,
            "output": output,
            "systemPrompt": system_prompt,
            "userPromptTemplate": user_template,
            "userPrompt": user_content,
            "timeMs": round(time_ms, 2),
            "avgTimeMs": stats.get("avgTimeMs", 1000.0),
            "accuracy": round(accuracy, 3),  # 影响度：对这个步骤影响最终答案的程度
            "riskLevel": risk_level,  # 风险等级：高/中/低
            "riskScore": round(risk_score * 100),  # 风险度：出错后影响最终答案的后果强度
            "riskFactors": subprocess.get("risk_factors", []),
            "health": health,  # 健康度：green/yellow/red
            "healthScore": health_score,  # 健康分数：0-100
            "healthIssues": health_issues,  # 发现的问题
            "healthSuggestions": health_suggestions,  # 改进建议
            "healthSignals": health_evaluation.get("signals", {}),
            "metricBasis": metric_basis,
            "order": subprocess["order"],
            "reasoning": subprocess.get("reasoning", ""),
            "modified": bool(step_mod) or (modified_outputs is not None and subprocess_id in modified_outputs)  # 标记是否有修改
        }
        stage_data.update(diagnose_step(stage_data, stages + [stage_data]))
        stage_data = apply_diagnosis_to_health(stage_data)
        
        stages.append(stage_data)
        
        # 更新统计
        if not preview_mode:
            update_stats(subprocess_id, time_ms, accuracy)
        current_output = output
        
        # 发送阶段完成事件
        yield f"event: stage_complete\ndata: {json.dumps({'stage': stage_data, 'progress': ((idx + 1) / total_run_stages) * 100})}\n\n"
    stages = [apply_diagnosis_to_health(stage) for stage in attach_diagnosis(apply_measured_impacts(stages, base_stages, start_step_index))]
    trace_diagnosis = diagnose_trace(stages)

    # 更新当前会话
    if not preview_mode:
        CURRENT_SESSION.update({
            "question": question,
            "documentIds": document_ids or [],
            "subprocesses": stages,
            "traceDiagnosis": trace_diagnosis,
            "executionId": execution_id,
            "timestamp": timestamp,
            "currentSubprocess": None,
            "isRunning": False
        })

        # 记录历史
        EXECUTION_HISTORY.append({
            "id": execution_id,
            "timestamp": timestamp,
            "question": question,
            "stages": stages,
            "finalOutput": stages[-1]["output"] if stages else "",
            "traceDiagnosis": trace_diagnosis
        })
    
    # 提取最终答案（从最终步骤的输出中提取有意义的内容）
    final_answer = extract_final_answer(stages[-1]["output"] if stages else "")

    # 把所有步骤的输出拼起来，作为"完整原文"提供给前端
    # 这样用户看到的不是只有最后一步的精简答案，而是 AI 推理过程中产生的所有内容
    all_stages_output = "\n\n".join([
        f"━━━━━━ 步骤 {i+1}: {s.get('name', '')} ━━━━━━\n{s.get('output', '').strip()}"
        for i, s in enumerate(stages) if (s.get('output') or '').strip()
    ]) if stages else ""

    # 发送完成事件
    complete_payload = {
        "executionId": execution_id,
        "timestamp": timestamp,
        "stages": stages,
        "traceDiagnosis": trace_diagnosis,
        "finalOutput": final_answer,
        "finalOutputFull": stages[-1]["output"] if stages else "",
        "allStagesOutput": all_stages_output,
    }
    yield f"event: complete\ndata: {json.dumps(complete_payload)}\n\n"


def extract_final_answer(output: str) -> str:
    """从输出中提取最终的、可读的答案"""
    if not output:
        return "（无输出）"
    
    # 如果输出是JSON格式，提取关键字段
    try:
        json_match = re.search(r'\{[\s\S]*\}', output)
        if json_match:
            data = json.loads(json_match.group())
            
            # 按优先级提取答案
            for key in ['answer', 'result', 'final', 'conclusion', 'output', 'content', '核心', '结果']:
                if key in data:
                    value = data[key]
                    if isinstance(value, str) and len(value) > 5:
                        return value
                    elif isinstance(value, dict):
                        # 如果是嵌套对象，尝试提取其中的文本
                        for subkey in ['result', 'content', 'text', 'value']:
                            if subkey in value and isinstance(value[subkey], str):
                                return value[subkey]
                    elif isinstance(value, list):
                        # 如果是列表，返回第一项（如果它是字符串）
                        if value and isinstance(value[0], str):
                            return value[0]
            
            # 如果没有找到标准字段，返回第一个非空字符串字段的值
            for k, v in data.items():
                if isinstance(v, str) and len(v) > 10:
                    return v
    
    except json.JSONDecodeError:
        pass
    
    # 如果不是JSON或解析失败，尝试清理并返回原始内容
    # 不再做 500 字截断，前端聊天框需要完整答案；前端会用 max-h + scroll 显示
    cleaned = re.sub(r'```json\n?', '', output)
    cleaned = re.sub(r'```\n?', '', cleaned).strip()
    return cleaned

def update_stats(stage_id: str, time_ms: float, accuracy: float):
    """更新统计信息（基于真实数据）"""
    if stage_id not in STATS:
        STATS[stage_id] = {
            "avgTimeMs": 0.0,
            "totalRuns": 0,
            "accuracy_sum": 0.0
        }
    
    STATS[stage_id]["totalRuns"] += 1
    STATS[stage_id]["accuracy_sum"] += accuracy
    
    if STATS[stage_id]["avgTimeMs"] == 0:
        STATS[stage_id]["avgTimeMs"] = time_ms
    else:
        # 移动平均
        STATS[stage_id]["avgTimeMs"] = round(
            STATS[stage_id]["avgTimeMs"] * 0.7 + time_ms * 0.3, 2
        )

# ==================== API接口 ====================

@app.get("/")
async def root():
    return {
        "message": "Agent Visualizer API",
        "version": "4.0.0",
        "model": MODEL_NAME,
        "features": [
            "动态子过程规划",
            "真实准确率（影响度）统计",
            "真实耗时统计"
        ]
    }

@app.get("/api/skills")
async def get_skills():
    """获取所有可用的技能定义"""
    skills = []
    for name, config in SKILL_DEFINITIONS.items():
        skills.append({
            "name": name,
            "description": config["description"],
            "systemPrompt": config["system_prompt"],
            "userPromptTemplate": config["user_template"]
        })
    return {"skills": skills}

@app.get("/api/stats")
async def get_stats():
    """获取统计信息（真实数据）"""
    result = []
    for stage_id, data in STATS.items():
        accuracy = data["accuracy_sum"] / data["totalRuns"] if data["totalRuns"] > 0 else 0.0
        health = "green"
        if data["avgTimeMs"] > 5000 or accuracy < 0.5:
            health = "red"
        elif data["avgTimeMs"] > 3000 or accuracy < 0.7:
            health = "yellow"
            
        result.append({
            "stage": stage_id,
            "name": stage_id.replace("step_", "步骤"),
            "avgTimeMs": data["avgTimeMs"],
            "totalRuns": data["totalRuns"],
            "accuracy": round(accuracy, 3),
            "health": health
        })
    return {"stats": result}


@app.post("/api/documents/upload")
async def upload_document(request: Request):
    """上传并解析文档。为避免额外 multipart 依赖，文件二进制直接放在 request body。"""
    data = await request.body()
    if not data:
        raise HTTPException(status_code=400, detail="文件内容为空")
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail=f"文件过大，当前上限为 {MAX_UPLOAD_BYTES // 1024 // 1024}MB")

    raw_filename = request.headers.get("X-File-Name") or "uploaded.txt"
    filename = unquote(raw_filename).strip() or "uploaded.txt"
    content_type = request.headers.get("X-File-Type") or ""
    text = extract_uploaded_document_text(filename, content_type, data).strip()
    if not text:
        raise HTTPException(status_code=400, detail="未能从文档中解析出可用文字")

    chunks = chunk_document_text(text)
    if not chunks:
        raise HTTPException(status_code=400, detail="文档内容过短，无法分块")

    doc_id = "doc_" + hashlib.sha1(f"{filename}:{len(data)}:{text[:500]}".encode("utf-8", errors="ignore")).hexdigest()[:12]
    DOCUMENT_STORE[doc_id] = {
        "id": doc_id,
        "filename": filename,
        "contentType": content_type,
        "size": len(data),
        "text": text,
        "chunks": chunks,
        "uploadedAt": datetime.now().isoformat(),
    }
    return {
        "id": doc_id,
        "filename": filename,
        "size": len(data),
        "charCount": len(text),
        "chunkCount": len(chunks),
        "preview": chunks[0]["preview"],
    }


@app.get("/api/documents")
async def list_documents():
    return {
        "documents": [
            {
                "id": doc["id"],
                "filename": doc["filename"],
                "size": doc["size"],
                "charCount": len(doc.get("text", "")),
                "chunkCount": len(doc.get("chunks", [])),
                "uploadedAt": doc.get("uploadedAt"),
            }
            for doc in DOCUMENT_STORE.values()
        ]
    }


@app.get("/api/solve/stream")
async def solve_stream(
    question: str,
    startStepIndex: int = 0,
    modifiedOutputs: str = None,
    modifiedSteps: str = None,
    baseStages: str = None,
    useSessionBase: bool = False,
    previewMode: bool = False,
    reasoningEffort: str = "medium",
    documentIds: str = None,
    apiKey: Optional[str] = None,
    model: Optional[str] = None,
    x_ark_api_key: Optional[str] = Header(None, alias="X-Ark-Api-Key"),
    x_ark_model: Optional[str] = Header(None, alias="X-Ark-Model"),
):
    """流式执行推理

    Query参数:
        question: 问题
        startStepIndex: 从哪个步骤开始执行（之前的步骤结果已提供）
        modifiedOutputs: JSON格式的修改后输出，格式为 {step_id: output_content}
        modifiedSteps: JSON格式的修改后步骤配置，格式为 {step_id: {"systemPrompt": ..., "userPromptTemplate": ..., "input": ...}}
        baseStages: JSON格式的上一版完整步骤，用于固定规划
        useSessionBase: 为1时从当前会话读取上一版步骤，避免GET URL过长
        previewMode: 为1时执行轻量试运行，不写入正式会话/历史
        reasoningEffort: 思考程度 minimal/low/medium/high
    """
    if not question or not question.strip():
        raise HTTPException(status_code=400, detail="Question is required")

    # 解析修改的输出
    parsed_modifications = None
    if modifiedOutputs:
        try:
            parsed_modifications = json.loads(modifiedOutputs)
        except json.JSONDecodeError:
            raise HTTPException(status_code=400, detail="Invalid modifiedOutputs JSON")

    # 解析修改的步骤配置
    parsed_step_mods = None
    if modifiedSteps:
        try:
            parsed_step_mods = json.loads(modifiedSteps)
        except json.JSONDecodeError:
            raise HTTPException(status_code=400, detail="Invalid modifiedSteps JSON")

    parsed_base_stages = None
    if baseStages:
        try:
            parsed_base_stages = json.loads(baseStages)
        except json.JSONDecodeError:
            raise HTTPException(status_code=400, detail="Invalid baseStages JSON")
    elif useSessionBase and CURRENT_SESSION.get("question") == question:
        parsed_base_stages = CURRENT_SESSION.get("subprocesses") or None

    parsed_document_ids: Optional[List[str]] = None
    if documentIds:
        try:
            loaded_ids = json.loads(documentIds)
            if isinstance(loaded_ids, list):
                parsed_document_ids = [str(item) for item in loaded_ids]
        except json.JSONDecodeError:
            parsed_document_ids = [item.strip() for item in documentIds.split(",") if item.strip()]

    # 优先使用请求头里的 key/model（更安全），其次 query param，最后 fallback 到环境变量
    effective_api_key = x_ark_api_key or apiKey
    effective_model = x_ark_model or model

    return StreamingResponse(
        generate_solve_events(
            question.strip(),
            startStepIndex,
            parsed_modifications,
            parsed_step_mods,
            parsed_base_stages,
            previewMode,
            reasoningEffort,
            api_key=effective_api_key,
            model_name=effective_model,
            document_ids=parsed_document_ids,
        ),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no"
        }
    )

@app.post("/api/solve/stream")
async def solve_stream_post(
    request: StreamSolveRequest,
    x_ark_api_key: Optional[str] = Header(None, alias="X-Ark-Api-Key"),
    x_ark_model: Optional[str] = Header(None, alias="X-Ark-Model"),
):
    """POST版流式推理。用于提交较长Prompt、输出和完整版本历史，避免URL长度限制。"""
    if not request.question or not request.question.strip():
        raise HTTPException(status_code=400, detail="Question is required")

    return StreamingResponse(
        generate_solve_events(
            request.question.strip(),
            request.startStepIndex,
            request.modifiedOutputs,
            request.modifiedSteps,
            request.baseStages,
            request.previewMode,
            request.reasoningEffort,
            api_key=x_ark_api_key,
            model_name=x_ark_model,
            document_ids=request.documentIds,
        ),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no"
        }
    )

@app.post("/api/solve")
async def solve(request: SolveRequest):
    """执行推理（同步版本）"""
    execution_id = str(uuid.uuid4())[:8]
    timestamp = datetime.now().isoformat()
    model_question = build_question_with_documents(request.question, request.documentIds)
    
    # 动态规划子过程
    subprocesses = await plan_subprocesses(model_question)
    
    stages = []
    current_output = model_question
    
    for subprocess in subprocesses:
        # 构建消息
        messages = [{"role": "system", "content": subprocess.get("system_prompt", "")}]
        user_template = subprocess.get("user_template", "问题：{question}\n\n已知：\n{previous_output}")
        user_content = user_template.format(
            question=model_question,
            previous_output=current_output
        )
        messages.append({"role": "user", "content": user_content})
        
        # 调用API
        time_ms = 0
        output = ""
        
        try:
            output, time_ms = await call_doubao_api(messages)
        except Exception as e:
            output = f"API调用失败: {str(e)}"
        
        # 计算影响度
        impact_score = 1.0
        if "API调用失败" in output:
            impact_score = 0.3
        
        base_impact = {"high": 0.95, "medium": 0.7, "low": 0.4}.get(subprocess["risk_level"], 0.7)
        accuracy = base_impact * impact_score
        
        # 获取统计
        stats = STATS.get(subprocess["id"], {"avgTimeMs": 1000.0})
        
        stages.append({
            "id": subprocess["id"],
            "name": subprocess["name"],
            "skill": subprocess.get("skill", subprocess["name"]),
            "description": subprocess.get("description", ""),
            "input": current_output,
            "output": output,
            "systemPrompt": subprocess["system_prompt"],
            "userPrompt": user_content,
            "timeMs": round(time_ms, 2),
            "avgTimeMs": stats.get("avgTimeMs", 1000.0),
            "accuracy": round(accuracy, 3),
            "riskLevel": subprocess["risk_level"],
            "riskScore": round(risk_level_to_score(subprocess["risk_level"]) * 100),
            "health": "green" if accuracy > 0.7 else "yellow" if accuracy > 0.5 else "red",
            "healthScore": round(accuracy * 100),
            "order": subprocess["order"]
        })
        stages[-1].update(diagnose_step(stages[-1], stages))
        stages[-1] = apply_diagnosis_to_health(stages[-1])
        
        # 更新统计
        update_stats(subprocess["id"], time_ms, accuracy)
        current_output = output
        
        await asyncio.sleep(0.3)
    
    stages = [apply_diagnosis_to_health(stage) for stage in attach_diagnosis(stages)]
    trace_diagnosis = diagnose_trace(stages)

    # 更新当前会话
    CURRENT_SESSION.update({
        "question": request.question,
        "documentIds": request.documentIds or [],
        "subprocesses": stages,
        "traceDiagnosis": trace_diagnosis,
        "executionId": execution_id,
        "timestamp": timestamp
    })
    
    # 记录历史
    EXECUTION_HISTORY.append({
        "id": execution_id,
        "timestamp": timestamp,
        "question": request.question,
        "stages": stages,
        "finalOutput": stages[-1]["output"] if stages else "",
        "traceDiagnosis": trace_diagnosis
    })
    
    return {
        "executionId": execution_id,
        "timestamp": timestamp,
        "question": request.question,
        "stages": stages,
        "traceDiagnosis": trace_diagnosis,
        "finalOutput": stages[-1]["output"] if stages else ""
    }

@app.get("/api/session")
async def get_session():
    """获取当前会话状态"""
    return CURRENT_SESSION

@app.get("/api/history")
async def get_history(limit: int = 20):
    """获取执行历史"""
    return {
        "history": EXECUTION_HISTORY[-limit:] if len(EXECUTION_HISTORY) > limit else EXECUTION_HISTORY
    }

@app.get("/api/research/template")
async def get_research_case_template():
    """返回研究级 failure case 模板。"""
    return failure_case_template()


@app.get("/api/research/cases")
async def list_research_cases():
    """列出当前进程内保存的研究 case。"""
    cases = sorted(RESEARCH_CASES.values(), key=lambda item: item.get("createdAt", ""), reverse=True)
    return {
        "cases": [
            {
                "id": case.get("id"),
                "title": case.get("title"),
                "createdAt": case.get("createdAt"),
                "caseType": case.get("caseType"),
                "question": case.get("question"),
                "observed_failure_types": case.get("observed_failure_types") or [],
                "replayCount": len(case.get("replay_records") or []),
                "stepCount": len(case.get("step_diagnosis") or []),
            }
            for case in cases
        ]
    }


@app.get("/api/research/demo-cases")
async def get_demo_research_cases():
    """返回 3 个内置复现实验 case，不写入保存列表。"""
    return {"cases": build_demo_research_cases()}


@app.post("/api/research/demo-cases")
async def save_demo_research_cases():
    """把 3 个内置复现实验 case 保存到当前进程。"""
    cases = build_demo_research_cases()
    for case in cases:
        RESEARCH_CASES[case["id"]] = case
    return {"saved": len(cases), "cases": cases}


@app.post("/api/research/cases")
async def save_research_case(request: ResearchCaseSaveRequest):
    """保存当前会话或前端传入的诊断快照为研究级 failure case。"""
    case = build_research_case_from_payload(request)
    if not case.get("question") and not case.get("step_diagnosis"):
        raise HTTPException(status_code=400, detail="当前没有可保存的会话，请先运行一次问题或传入 subprocesses。")
    RESEARCH_CASES[case["id"]] = case
    return {"case": case, "report": render_case_report(case)}


@app.get("/api/research/cases/{case_id}")
async def get_research_case(case_id: str):
    case = RESEARCH_CASES.get(case_id)
    if not case:
        raise HTTPException(status_code=404, detail="Research case not found")
    return {"case": case}


@app.get("/api/research/cases/{case_id}/report", response_class=PlainTextResponse)
async def export_research_case_report(case_id: str):
    case = RESEARCH_CASES.get(case_id)
    if not case:
        raise HTTPException(status_code=404, detail="Research case not found")
    return PlainTextResponse(
        render_case_report(case),
        media_type="text/markdown; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{case_id}.md"'},
    )

@app.post("/api/rerun")
async def rerun():
    """重跑当前会话"""
    if not CURRENT_SESSION.get("question"):
        return {"message": "当前没有会话，请先输入问题"}
    
    return await solve(SolveRequest(
        question=CURRENT_SESSION["question"],
        documentIds=CURRENT_SESSION.get("documentIds") or []
    ))

@app.get("/api/rerun/stream")
async def rerun_stream():
    """流式重跑当前会话"""
    if not CURRENT_SESSION.get("question"):
        raise HTTPException(status_code=400, detail="当前没有会话，请先输入问题")
    
    return StreamingResponse(
        generate_solve_events(
            CURRENT_SESSION["question"],
            document_ids=CURRENT_SESSION.get("documentIds") or []
        ),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no"
        }
    )

@app.post("/api/reset")
async def reset():
    """重置所有统计"""
    global STATS
    STATS = {}
    return {"message": "统计已重置"}


# ==================== 标题生成 ====================

class TitleGenerateRequest(BaseModel):
    text: str
    max_length: int = 14


@app.post("/api/title/generate")
async def generate_title(
    request: TitleGenerateRequest,
    x_ark_api_key: Optional[str] = Header(None, alias="X-Ark-Api-Key"),
    x_ark_model: Optional[str] = Header(None, alias="X-Ark-Model"),
):
    """用 minimal 推理把用户问题压成精简标题（8-15 字）

    前端在新建会话第一次保存时调用，让侧边栏的对话标题更短更精炼。
    用 minimal 推理 + max_tokens=64，几乎瞬时返回。
    """
    # 注入请求级别的 key/model
    token_key = _request_api_key.set(x_ark_api_key) if x_ark_api_key else None
    token_model = _request_model.set(x_ark_model) if x_ark_model else None
    try:
        return await _generate_title_impl(request)
    finally:
        if token_key is not None:
            _request_api_key.reset(token_key)
        if token_model is not None:
            _request_model.reset(token_model)


async def _generate_title_impl(request: TitleGenerateRequest):
    raw_text = (request.text or "").strip()
    if not raw_text:
        return {"title": "新对话"}

    # 长度太短直接返回原文，没必要调模型
    if len(raw_text) <= request.max_length:
        return {"title": raw_text}

    try:
        messages = [
            {
                "role": "system",
                "content": (
                    f"你是标题生成助手。把用户输入压缩为不超过 {request.max_length} 个汉字的精炼标题，"
                    "只输出标题本身、不带引号、不带标点、不带额外解释。"
                    "标题需保留主题关键词，去除疑问词、客套词。"
                ),
            },
            {"role": "user", "content": raw_text},
        ]
        title, _ = await call_doubao_api(
            messages,
            reasoning_effort="minimal",
            max_tokens=64,
        )
        # 清洗：去引号、换行、首尾标点
        cleaned = re.sub(r'^["\'《【\s]+|["\'》】\s。.！!？?]+$', '', title.strip())
        cleaned = cleaned.split("\n")[0].strip()
        if not cleaned:
            cleaned = raw_text[: request.max_length]
        # 兜底：超长再截
        if len(cleaned) > request.max_length + 6:
            cleaned = cleaned[: request.max_length] + "..."
        return {"title": cleaned}
    except Exception as e:
        # AI 生成失败就用前 N 字兜底，不抛错
        print(f"[标题生成失败] {e}")
        return {"title": raw_text[: request.max_length] + ("..." if len(raw_text) > request.max_length else "")}


# ==================== API Key 连通性测试 ====================

class TestApiKeyRequest(BaseModel):
    apiKey: str
    model: Optional[str] = None


@app.post("/api/test-key")
async def test_api_key(request: TestApiKeyRequest):
    """测试用户填的 API Key 和模型 ID 是否能成功调用豆包

    返回 status: ok/auth_failed/model_invalid/network_error/quota_exceeded/unknown
    """
    test_key = (request.apiKey or "").strip()
    test_model = (request.model or DEFAULT_MODEL_NAME or "doubao-seed-1-6-251015").strip()

    if not test_key:
        return {"status": "auth_failed", "message": "API Key 为空", "model": test_model}

    headers = {
        "Authorization": f"Bearer {test_key}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": test_model,
        "messages": [{"role": "user", "content": "hi"}],
        "reasoning_effort": "minimal",
        "max_completion_tokens": 16,
    }

    try:
        client = get_global_client()
        start = time.time()
        response = await client.post(
            f"{DOUBAO_BASE_URL}/chat/completions",
            headers=headers,
            json=payload,
        )
        elapsed = round((time.time() - start) * 1000)

        if response.status_code == 200:
            data = response.json()
            content = data.get("choices", [{}])[0].get("message", {}).get("content", "")
            return {
                "status": "ok",
                "message": f"连通正常（{elapsed}ms）",
                "model": test_model,
                "sample_reply": (content or "")[:80],
            }
        elif response.status_code == 401:
            return {"status": "auth_failed", "message": "API Key 无效或未授权", "model": test_model}
        elif response.status_code == 404:
            return {"status": "model_invalid", "message": "模型 ID 不存在或未开通", "model": test_model}
        elif response.status_code == 429:
            return {"status": "quota_exceeded", "message": "触发限流或额度耗尽", "model": test_model}
        else:
            return {
                "status": "unknown",
                "message": f"HTTP {response.status_code}: {response.text[:200]}",
                "model": test_model,
            }
    except httpx.ConnectError as e:
        return {"status": "network_error", "message": f"连不上火山方舟服务器：{e}", "model": test_model}
    except Exception as e:
        return {"status": "unknown", "message": f"{type(e).__name__}: {e}", "model": test_model}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
