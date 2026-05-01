"""
AI Agent 推理可视化系统后端
核心特性：
1. 问题分析规划器：根据用户问题动态决定需要哪些子过程
2. 准确率新定义：子过程对最终结果的影响程度（风险值）
3. 真实数据收集：从实际API调用获取耗时和准确率
"""
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from typing import Optional, Dict, List, Any, Tuple
import httpx
import asyncio
import time
import uuid
from datetime import datetime
import json
import re
import os

app = FastAPI(title="Agent Visualizer API")

# CORS配置
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 豆包API配置
DOUBAO_API_KEY = os.getenv("ARK_API_KEY", "ark-a5594092-1603-42bb-9712-36a670b45718-36ecd")
DOUBAO_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3"
MODEL_NAME = os.getenv("DOUBAO_MODEL_NAME", "ep-m-20260414114056-685z2")

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

class StreamSolveRequest(BaseModel):
    question: str
    startStepIndex: int = 0
    modifiedOutputs: Optional[Dict[str, str]] = None
    modifiedSteps: Optional[Dict[str, Any]] = None
    baseStages: Optional[List[Dict[str, Any]]] = None
    previewMode: bool = False
    reasoningEffort: str = "medium"

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
    if not proxy:
        return httpx.AsyncClient(timeout=120.0, trust_env=False)
    try:
        return httpx.AsyncClient(timeout=120.0, proxy=proxy, trust_env=False)   # httpx >= 0.20
    except TypeError:
        return httpx.AsyncClient(timeout=120.0, proxies=proxy, trust_env=False) # httpx < 0.20


async def call_doubao_api(
    messages: List[Dict],
    temperature: float = 0.7,
    max_tokens: Optional[int] = None,
    reasoning_effort: str = "medium"
) -> Tuple[str, float]:
    """调用豆包API (doubao-seed-1-6-251015)"""
    headers = {
        "Authorization": f"Bearer {DOUBAO_API_KEY}",
        "Content-Type": "application/json"
    }
    payload = {
        "model": MODEL_NAME,
        "messages": messages,
        "reasoning_effort": reasoning_effort,
        "max_completion_tokens": max_tokens if max_tokens else 65535,
    }

    env_proxy = (
        os.environ.get("HTTPS_PROXY")
        or os.environ.get("https_proxy")
        or os.environ.get("HTTP_PROXY")
        or os.environ.get("http_proxy")
        or os.environ.get("ALL_PROXY")
    )

    start_time = time.time()
    try:
        async with _make_httpx_client(env_proxy) as client:
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

        content, _ = await call_doubao_api(messages)

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
    reasoning_effort: str = "medium"
):
    """生成SSE事件流

    Args:
        question: 问题
        start_step_index: 从哪个步骤开始执行（之前的步骤使用modified_outputs中的结果）
        modified_outputs: 修改后的输出，格式为 {step_id: output_content}
        modified_steps: 修改后的步骤配置，格式为 {step_id: {"systemPrompt": ..., "userPromptTemplate": ..., "input": ...}}
        base_stages: 上一版完整步骤，用于固定规划并做版本差异测量
        preview_mode: 树状图试运行模式，使用较短上下文和输出，且不写入正式会话/历史
    """
    execution_id = str(uuid.uuid4())[:8]
    timestamp = datetime.now().isoformat()

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
        subprocesses = await plan_subprocesses(question)

    start_step_index = max(0, min(start_step_index, len(subprocesses) - 1 if subprocesses else 0))
    run_subprocesses = subprocesses[start_step_index:] if subprocesses else []

    # 发送规划完成事件
    yield f"event: plan_complete\ndata: {json.dumps({'subprocesses': [
        {
            'id': s['id'],
            'name': s['name'],
            'skill': s.get('skill', s.get('name', '')),
            'risk_level': s['risk_level'],
            'reasoning': s['reasoning'],
            'systemPrompt': s.get('system_prompt', ''),
            'userPrompt': s.get('user_template', '')
        } for s in subprocesses
    ]})}\n\n"
    
    await asyncio.sleep(0.5)
    
    preserved_stages = [dict(stage) for stage in (base_stages or [])[:start_step_index]]
    stages = preserved_stages.copy()
    current_output = stages[-1].get("output", question) if stages else question
    total_stages = max(len(subprocesses), 1)
    total_run_stages = max(len(run_subprocesses), 1)

    for idx, subprocess in enumerate(run_subprocesses):
        absolute_index = start_step_index + idx
        subprocess_id = subprocess["id"]
        subprocess_name = subprocess["name"]
        risk_level = subprocess["risk_level"]
        risk_score = float(subprocess.get("risk_score", risk_level_to_score(risk_level)))

        # 发送阶段开始事件
        yield f"event: stage_start\ndata: {json.dumps({
            'stageId': subprocess_id,
            'name': subprocess_name,
            'skill': subprocess.get('skill', subprocess_name),
            'riskLevel': risk_level,
            'riskScore': round(risk_score * 100),
            'order': subprocess["order"],
            'progress': (absolute_index / total_stages) * 100,
            'reasoning': subprocess.get("reasoning", "")
        })}\n\n"

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
                question=question,
                previous_output=model_step_input
            )
        except (KeyError, ValueError):
            user_content = f"{model_user_template}\n\n问题：{question}\n\n已知：\n{model_step_input}"
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

                output, time_ms = await call_doubao_api(
                    messages,
                    temperature=0.25 if preview_mode else 0.7,
                    max_tokens=4096 if preview_mode else None,
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
        
        stages.append(stage_data)
        
        # 更新统计
        if not preview_mode:
            update_stats(subprocess_id, time_ms, accuracy)
        current_output = output
        
        # 发送阶段完成事件
        yield f"event: stage_complete\ndata: {json.dumps({'stage': stage_data, 'progress': ((idx + 1) / total_run_stages) * 100})}\n\n"
        
        if not preview_mode:
            await asyncio.sleep(0.3)
    stages = apply_measured_impacts(stages, base_stages, start_step_index)

    # 更新当前会话
    if not preview_mode:
        CURRENT_SESSION.update({
            "question": question,
            "subprocesses": stages,
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
            "finalOutput": stages[-1]["output"] if stages else ""
        })
    
    # 提取最终答案（从最终步骤的输出中提取有意义的内容）
    final_answer = extract_final_answer(stages[-1]["output"] if stages else "")
    
    # 发送完成事件
    yield f"event: complete\ndata: {json.dumps({
        'executionId': execution_id,
        'timestamp': timestamp,
        'stages': stages,
        'finalOutput': final_answer,
        'finalOutputFull': stages[-1]['output'] if stages else ""
    })}\n\n"


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
    cleaned = re.sub(r'```json\n?', '', output)
    cleaned = re.sub(r'```\n?', '', cleaned).strip()
    return cleaned if len(cleaned) < 500 else cleaned[:500] + "..."

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

@app.get("/api/solve/stream")
async def solve_stream(
    question: str,
    startStepIndex: int = 0,
    modifiedOutputs: str = None,
    modifiedSteps: str = None,
    baseStages: str = None,
    useSessionBase: bool = False,
    previewMode: bool = False,
    reasoningEffort: str = "medium"
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

    return StreamingResponse(
        generate_solve_events(
            question.strip(),
            startStepIndex,
            parsed_modifications,
            parsed_step_mods,
            parsed_base_stages,
            previewMode,
            reasoningEffort
        ),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no"
        }
    )

@app.post("/api/solve/stream")
async def solve_stream_post(request: StreamSolveRequest):
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
            request.reasoningEffort
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
    
    # 动态规划子过程
    subprocesses = await plan_subprocesses(request.question)
    
    stages = []
    current_output = request.question
    
    for subprocess in subprocesses:
        # 构建消息
        messages = [{"role": "system", "content": subprocess.get("system_prompt", "")}]
        user_template = subprocess.get("user_template", "问题：{question}\n\n已知：\n{previous_output}")
        user_content = user_template.format(
            question=request.question,
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
            "health": "green" if accuracy > 0.7 else "yellow" if accuracy > 0.5 else "red",
            "order": subprocess["order"]
        })
        
        # 更新统计
        update_stats(subprocess["id"], time_ms, accuracy)
        current_output = output
        
        await asyncio.sleep(0.3)
    
    # 更新当前会话
    CURRENT_SESSION.update({
        "question": request.question,
        "subprocesses": stages,
        "executionId": execution_id,
        "timestamp": timestamp
    })
    
    # 记录历史
    EXECUTION_HISTORY.append({
        "id": execution_id,
        "timestamp": timestamp,
        "question": request.question,
        "stages": stages,
        "finalOutput": stages[-1]["output"] if stages else ""
    })
    
    return {
        "executionId": execution_id,
        "timestamp": timestamp,
        "question": request.question,
        "stages": stages,
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

@app.post("/api/rerun")
async def rerun():
    """重跑当前会话"""
    if not CURRENT_SESSION.get("question"):
        return {"message": "当前没有会话，请先输入问题"}
    
    return await solve(SolveRequest(question=CURRENT_SESSION["question"]))

@app.get("/api/rerun/stream")
async def rerun_stream():
    """流式重跑当前会话"""
    if not CURRENT_SESSION.get("question"):
        raise HTTPException(status_code=400, detail="当前没有会话，请先输入问题")
    
    return StreamingResponse(
        generate_solve_events(CURRENT_SESSION["question"]),
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

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
