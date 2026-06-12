from __future__ import annotations

import json
import re
from difflib import SequenceMatcher
from typing import Any, Dict, List, Optional


STAGE_TYPES = {
    "planner": "规划阶段",
    "retriever": "证据/检索阶段",
    "tool_call": "工具调用阶段",
    "generator": "生成阶段",
    "verifier": "验证阶段",
    "retry": "重试阶段",
    "memory_update": "记忆更新阶段",
    "summarizer": "总结阶段",
    "unknown": "未知阶段",
}


FAILURE_TYPES = {
    "none": "未观察到失败",
    "fact_error": "事实错误",
    "unsupported_claim": "无证据断言",
    "tool_misuse": "工具/API调用失败",
    "retrieval_miss": "证据缺失",
    "planning_error": "规划不完整",
    "self_inconsistency": "步骤间自相矛盾",
    "constraint_violation": "验证未通过",
    "format_error": "输出格式不符",
    "hallucination": "缺少证据支撑",
    "invalid_retry": "无效重试",
    "cost_latency_anomaly": "成本或延迟偏高",
    "memory_pollution": "记忆污染",
    "context_omission": "上下文过长风险",
    "unknown": "未知问题",
}

FAILURE_DEFINITIONS = {
    "planning_error": {
        "zh_name": "计划错误",
        "definition": "任务拆解、步骤顺序、工具选择或停止条件不完整，导致后续步骤没有清晰检查目标。",
        "signals": ["stage=planner", "计划步骤过少", "需要文档/引用/计算但没有检索、工具或验证步骤", "后续多个步骤依赖同一粗计划"],
        "exclusions": ["工具失败优先 tool_misuse", "格式失败优先 format_error", "关键证据未进入上下文优先 retrieval_miss"],
    },
    "retrieval_miss": {
        "zh_name": "检索缺失",
        "definition": "正确证据可能在文档或知识库中，但当前步骤没有拿到，或没有进入后续上下文。",
        "signals": ["stage=retriever", "retrieved_chunks 为空或过短", "缺少问题关键实体", "无引用却给出证据性结论"],
        "exclusions": ["证据已出现但后续丢失优先 context_omission", "证据与答案冲突优先 fact_error"],
    },
    "context_omission": {
        "zh_name": "上下文遗漏",
        "definition": "关键实体、约束或证据曾在前序步骤出现，但没有被带入当前步骤或最终答案。",
        "signals": ["前序步骤有候选列表", "当前步骤实体数量明显下降", "输出声称缺少信息但前序已提供", "长上下文或压缩摘要"],
        "exclusions": ["用户明确要求过滤时不报", "检索阶段从未拿到信息优先 retrieval_miss"],
    },
    "self_inconsistency": {
        "zh_name": "步骤间自相矛盾",
        "definition": "同一执行链中，后续步骤与前序可靠结论冲突，或声称缺失前序已经给出的信息。",
        "signals": ["同一实体状态前后不一致", "前序提取多个实体后后续无理由减少", "后续说缺少信息但前序有描述"],
        "exclusions": ["后续有新证据推翻前序时不报", "单纯遗漏优先 context_omission"],
    },
    "unsupported_claim": {
        "zh_name": "无证据断言",
        "definition": "输出出现没有被文档、工具结果或历史上下文支持的事实性断言。",
        "signals": ["具体事实/数字/状态没有 source_ref", "citation 不支持 claim", "把可能/计划写成已完成"],
        "exclusions": ["有明确证据证明错误优先 fact_error", "开放创作类任务不报"],
    },
    "fact_error": {
        "zh_name": "事实错误",
        "definition": "输出与文档、工具结果、ground truth 或前序可靠结论冲突。",
        "signals": ["answer_claim 与 retrieved_chunk 矛盾", "tool_result 为 X 但答案写 Y", "状态/数字/时间被改写错"],
        "exclusions": ["没有证据时优先 unsupported_claim", "漏掉内容优先 context_omission"],
    },
    "tool_misuse": {
        "zh_name": "工具误用",
        "definition": "选错工具、漏用工具、传错参数、误读工具结果，或工具失败后继续生成答案。",
        "signals": ["stage=tool_call", "tool_error/exception/traceback", "tool_args 缺必填字段", "工具结果与最终答案不一致"],
        "exclusions": ["工具正确但生成解释错优先 fact_error", "JSON 解析失败优先 format_error"],
    },
    "format_error": {
        "zh_name": "格式错误",
        "definition": "输出没有满足 JSON、schema、字段名或表格等结构化格式要求。",
        "signals": ["json_parse_success=false", "schema_validation_failed", "required_keys missing", "字段类型不匹配"],
        "exclusions": ["无明确格式要求不报", "格式正确但无证据优先 unsupported_claim"],
    },
    "constraint_violation": {
        "zh_name": "约束违反",
        "definition": "没有遵守用户显式约束、业务规则或检查标准。",
        "signals": ["input 有 explicit constraints", "final_answer 缺少 required sections", "没有引用章节或 source_refs"],
        "exclusions": ["JSON 解析失败优先 format_error", "无证据支持优先 unsupported_claim"],
    },
}


FIX_SUGGESTIONS = {
    "format_error": ["把输出格式要求放在 System Prompt 前部", "给出严格 JSON schema", "要求模型只输出 JSON，不输出解释"],
    "retrieval_miss": ["补充可验证资料来源或检索 query", "要求本步骤输出引用到的事实依据", "后续生成步骤必须只使用本步骤证据"],
    "tool_misuse": ["检查 API Key、额度、模型 ID 和请求参数", "工具/API失败时停止后续写入版本", "在前端提示用户先恢复接口后再重跑"],
    "planning_error": ["补充子任务、输入、输出和验收标准", "增加计划审查步骤", "避免让后续步骤依赖空泛计划"],
    "self_inconsistency": ["增加跨步骤一致性检查", "要求后续步骤引用前序结构化结果", "发现前后冲突时回退到证据步骤重跑"],
    "unsupported_claim": ["每个事实结论必须绑定来源片段", "没有证据时输出“不确定”", "最终回答前做 claim-to-source alignment"],
    "hallucination": ["要求每个关键结论都对应来源句子", "没有证据时输出“不确定”而不是补全", "增加验证步骤检查证据覆盖"],
    "constraint_violation": ["把验证失败项回写到上游 Prompt", "输出前逐条核对约束", "失败时给出具体未通过字段"],
    "context_omission": ["压缩历史上下文", "保留用户硬约束和关键证据", "删除与当前步骤无关的中间输出"],
    "cost_latency_anomaly": ["减少无关上下文", "降低试运行 max_tokens", "必要时拆分长步骤"],
    "unknown": ["保留该步骤输入输出样本", "增加结构化日志", "拆分步骤后重新定位"],
    "none": [],
}


STAGE_KEYWORDS = {
    "planner": ["规划", "分解", "理解", "需求", "计划", "设计"],
    "retriever": ["检索", "收集", "查找", "信息", "资料", "证据", "案例", "来源"],
    "tool_call": ["工具", "调用", "执行", "代码", "计算", "api"],
    "generator": ["生成", "撰写", "回答", "输出", "解释", "归纳", "总结"],
    "verifier": ["验证", "检查", "评估", "审查", "质量", "准确", "完善"],
    "retry": ["重试", "修正", "重新"],
    "memory_update": ["记忆", "存档", "历史"],
    "summarizer": ["摘要", "总结", "归纳"],
}


HARD_ERROR_TERMS = [
    "API调用失败",
    "SetLimitExceeded",
    "quota",
    "429",
    "401",
    "403",
    "404",
    "exception",
    "traceback",
    "failed",
    "error:",
]

RETRIEVAL_MISS_TERMS = ["未找到", "没有相关", "无相关", "找不到", "缺少证据", "无法确认", "资料不足", "证据不足"]
VERIFIER_FAIL_TERMS = ["不正确", "未通过", "存在问题", "需要修正", "不满足", '"is_correct": false']
HALLUCINATION_TERMS = ["缺少证据", "没有证据", "证据不足", "无法验证", "未引用", "未提供来源"]

PROPAGATING_FAILURES = {
    "tool_misuse",
    "retrieval_miss",
    "format_error",
    "constraint_violation",
    "hallucination",
    "unsupported_claim",
    "planning_error",
    "self_inconsistency",
    "context_omission",
}

SOFT_FAILURES = {"cost_latency_anomaly"}


POTENTIAL_FIX_SUGGESTIONS = {
    "retrieval_miss": "要求该步骤输出引用的文件名、片段编号、日志行或原文句子；没有证据时必须写“证据不足”。",
    "context_omission": "把用户问题、文档片段和上一步输出压缩成待核对清单，先保留硬约束、时间、对象和异常文本。",
    "hallucination": "生成结论前逐条绑定证据来源，禁止把推断当成文档事实。",
    "planning_error": "先把原始问题中的对象、时间、约束、证据来源和交付要求拆成独立检查点，并说明每个检查点需要的证据类型。",
    "constraint_violation": "验证步骤必须回查原始问题、文档片段和上游结论，列出未满足项。",
    "format_error": "在 Prompt 中明确字段、证据来源字段和不确定性字段，避免自由文本遗漏关键信息。",
    "tool_misuse": "如果问题涉及 API、日志或执行失败，先确认错误码、请求参数和失败边界，再继续推理。",
    "fact_error": "涉及数字、表格、时间或专名时要求逐项复核来源，避免抄错或归纳过度。",
}

POTENTIAL_SUBTYPE_LABELS = {
    "planning_checklist_missing": "检查项拆分不足",
    "retrieval_scope_mismatch": "资料方向不匹配",
    "evidence_source_missing": "证据来源缺失",
    "log_locator_missing": "日志定位缺失",
    "status_verification_missing": "状态证据缺失",
    "function_evidence_missing": "功能依据缺失",
    "claim_without_citation": "结论缺少引用",
    "context_keypoint_loss": "关键上下文遗漏",
    "self_inconsistency_possible": "前后可能矛盾",
    "format_schema_missing": "结构字段缺失",
    "constraint_check_missing": "约束核验缺失",
    "numeric_status_risk": "数字/状态易错",
    "tool_boundary_missing": "工具边界不清",
}

DIAGNOSTIC_TERMS = ["when", "where", "why", "how", "什么时候", "哪里", "到哪里", "为什么", "怎么", "原因", "影响", "源头"]
LOG_TERMS = ["日志", "报错", "错误", "异常", "traceback", "exception", "stack", "error", "warning", "失败", "调用失败"]
DOCUMENT_TERMS = ["已上传文档", "片段", "文件名", "文档", "docx", "pdf", "csv", "表格", "资料", "原文"]
EVIDENCE_TERMS = ["证据", "来源", "引用", "片段", "原文", "日志", "行号", "依据"]
NUMERIC_TERMS = ["数据", "数字", "表格", "统计", "比例", "金额", "数量", "时间", "日期", "%", "元"]
CONSTRAINT_TERMS = ["必须", "要求", "不能", "不要", "确保", "只能", "需要", "约束", "标准"]
FORMAT_TERMS = ["json", "schema", "字段", "格式", "表格", "结构化", "required", "keys"]
TOOL_TERMS = ["api", "接口", "工具", "调用", "参数", "请求", "响应", "endpoint", "token", "额度", "模型"]
STATUS_TERMS = ["上线", "正式上线", "未上线", "灰度", "试运行", "发布", "投产", "状态", "已实现", "规划中"]
CLAIM_TERMS = ["结论", "说明", "可见", "证明", "已经", "具备", "支持", "能够", "应当", "因此"]
STOP_TERMS = {
    "问题", "文档", "片段", "根据", "分析", "输出", "输入", "要求", "需要", "可能", "当前", "步骤", "结果", "内容",
    "判断", "总结", "明确", "用户", "相关", "信息", "资料", "证据", "功能", "作用", "是否", "进行", "提供",
}


def clamp(value: float, low: float = 0.0, high: float = 1.0) -> float:
    return max(low, min(high, value))


def contains_any(text: str, terms: List[str]) -> bool:
    lowered = text.lower()
    return any(term.lower() in lowered for term in terms)


def infer_stage(step: Dict[str, Any]) -> str:
    raw_stage = step.get("stage")
    if raw_stage in STAGE_TYPES:
        return raw_stage
    text = " ".join(
        str(step.get(key, ""))
        for key in ("name", "skill", "description", "systemPrompt", "system_prompt")
    ).lower()
    for stage, keywords in STAGE_KEYWORDS.items():
        if any(keyword.lower() in text for keyword in keywords):
            return stage
    return "unknown"


def estimate_tokens(text: str) -> int:
    if not text:
        return 0
    ascii_chars = sum(1 for ch in text if ord(ch) < 128)
    cjk_chars = len(text) - ascii_chars
    return max(1, int(ascii_chars / 4 + cjk_chars / 1.7))


def normalize_score(value: Any, default: float) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    return clamp(number / 100 if number > 1 else number)


def wants_json(step: Dict[str, Any]) -> bool:
    prompt = str(step.get("systemPrompt") or step.get("system_prompt") or "")
    return "json" in prompt.lower() or "JSON" in prompt


def has_parseable_json(output: str) -> bool:
    start = output.find("{")
    end = output.rfind("}")
    if start < 0 or end <= start:
        return False
    try:
        json.loads(output[start:end + 1])
        return True
    except Exception:
        return False


def split_sentences(text: str) -> List[str]:
    clean = re.sub(r"\s+", " ", text or "").strip()
    if not clean:
        return []
    chunks = re.split(r"(?<=[。！？.!?；;])\s*", clean)
    return [chunk.strip() for chunk in chunks if chunk.strip()]


def find_evidence_snippet(text: str, terms: List[str], fallback: str = "") -> str:
    sentences = split_sentences(text)
    for sentence in sentences:
        if contains_any(sentence, terms):
            return sentence
    if fallback:
        return fallback
    return (text or "").strip()


def compact_snippet(text: str, max_len: int = 140) -> str:
    clean = re.sub(r"\s+", " ", text or "").strip()
    if len(clean) <= max_len:
        return clean
    return clean[:max_len - 3] + "..."


def extract_key_terms(text: str, limit: int = 6) -> List[str]:
    clean = re.sub(r"\s+", " ", text or "")
    candidates: List[str] = []
    candidates.extend(re.findall(r"[\u4e00-\u9fffA-Za-z0-9_-]{2,24}(?:平台|系统|服务|模块|功能|接口|目录|表|日志|错误|状态|时间|原因|资料|证据)", clean))
    candidates.extend(re.findall(r"[\u4e00-\u9fff]{2,12}", clean))
    candidates.extend(re.findall(r"[A-Za-z][A-Za-z0-9_/-]{2,}", clean))
    scored: Dict[str, int] = {}
    for term in candidates:
        term = term.strip("，。；：:,.!？?（）()[]【】")
        if len(term) < 2 or term in STOP_TERMS:
            continue
        if any(stop == term or term.startswith(stop) and len(term) <= len(stop) + 2 for stop in STOP_TERMS):
            continue
        score = clean.count(term) + min(len(term), 8)
        if any(key != term and term in key for key in scored):
            continue
        scored[term] = max(scored.get(term, 0), score)
    return [term for term, _ in sorted(scored.items(), key=lambda item: item[1], reverse=True)[:limit]]


def describe_terms(terms: List[str], fallback: str = "当前主题") -> str:
    clean_terms = [term for term in terms if term]
    return "、".join(clean_terms[:4]) if clean_terms else fallback


def has_document_citation(text: str) -> bool:
    return bool(re.search(r"(片段\s*\d+|第\s*\d+\s*页|来源|引用|文件|\.pdf|\.docx|\.csv|\.txt)", text or "", re.I))


def has_log_locator(text: str) -> bool:
    return bool(re.search(r"(\d{4}[-/]\d{1,2}[-/]\d{1,2}|traceback|exception|error|warning|错误码|接口|endpoint|line\s*\d+|第\s*\d+\s*行)", text or "", re.I))


def extract_focus_points(text: str, limit: int = 4) -> List[str]:
    scored: List[tuple[int, str]] = []
    chunks = [chunk.strip() for chunk in re.split(r"[\n。！？!?；;]+", text or "") if chunk.strip()]
    keywords = EVIDENCE_TERMS + CONSTRAINT_TERMS + ["功能", "作用", "上线", "是否", "哪些", "问题", "错误", "日志", "状态", "时间"]
    for sentence in chunks:
        hits = sum(1 for keyword in keywords if keyword.lower() in sentence.lower())
        if hits:
            length_bonus = 2 if len(sentence) >= 35 else 0
            scored.append((hits + length_bonus, compact_snippet(sentence, 90)))
    scored.sort(key=lambda item: item[0], reverse=True)
    points = [item[1] for item in scored[:limit]]
    if not points:
        for sentence in chunks[:limit]:
            points.append(compact_snippet(sentence, 90))
    return list(dict.fromkeys(point for point in points if point))


def missing_evidence_requirements(full_text: str, step_text: str, stage: str) -> List[str]:
    missing: List[str] = []
    output_like = step_text
    if contains_any(full_text, DOCUMENT_TERMS) and not has_document_citation(output_like):
        missing.append("文件名/片段编号/原文句子")
    if contains_any(full_text, LOG_TERMS) and not has_log_locator(output_like):
        missing.append("时间戳/错误码/接口名或日志行")
    if "上线" in full_text and not re.search(r"(上线|正式|已上线|未上线|发布|投产)", output_like):
        missing.append("上线状态证据")
    if "功能" in full_text and not re.search(r"(功能|模块|服务|能力|作用)", output_like):
        missing.append("功能名称及作用依据")
    if contains_any(full_text, ["when", "什么时候", "时间", "发生"]) and not re.search(r"(时间|日期|阶段|发生|when|\d{4}[-/年])", output_like, re.I):
        missing.append("when/发生时间")
    if contains_any(full_text, ["where", "哪里", "位置", "到哪里", "在哪"]) and not re.search(r"(位置|接口|模块|页面|步骤|where|到\s*Step|来源)", output_like, re.I):
        missing.append("where/发生位置")
    if contains_any(full_text, ["why", "为什么", "原因"]) and stage in {"generator", "summarizer", "verifier"} and not re.search(r"(因为|原因|导致|依据|why|证据)", output_like, re.I):
        missing.append("why/原因证据")
    return list(dict.fromkeys(missing))[:4]


def infer_potential_subtype(
    failure_type: str,
    stage: str,
    missing: List[str],
    expected_terms: List[str],
    actual_terms: List[str],
    full_text: str,
    step_output: str,
) -> str:
    if failure_type == "planning_error":
        return "planning_checklist_missing"
    if "时间戳/错误码/接口名或日志行" in missing:
        return "log_locator_missing"
    if "上线状态证据" in missing:
        return "status_verification_missing"
    if "功能名称及作用依据" in missing:
        return "function_evidence_missing"
    if "文件名/片段编号/原文句子" in missing:
        return "evidence_source_missing"
    if failure_type == "retrieval_miss":
        return "retrieval_scope_mismatch" if expected_terms and actual_terms else "evidence_source_missing"
    if failure_type in {"hallucination", "unsupported_claim"}:
        return "claim_without_citation"
    if failure_type == "context_omission":
        return "context_keypoint_loss"
    if failure_type == "self_inconsistency":
        return "self_inconsistency_possible"
    if failure_type == "format_error":
        return "format_schema_missing"
    if failure_type == "constraint_violation":
        return "constraint_check_missing"
    if failure_type == "tool_misuse":
        return "tool_boundary_missing"
    if failure_type == "fact_error" or contains_any(full_text + step_output, NUMERIC_TERMS):
        return "numeric_status_risk"
    return failure_type


def summarize_potential_reason(
    subtype: str,
    missing: List[str],
    expected_terms: List[str],
    actual_terms: List[str],
    step_name: str,
    step_output: str,
) -> str:
    expected_text = describe_terms(expected_terms[:3], "本步目标")
    actual_text = describe_terms(actual_terms[:3], "当前输出")
    missing_text = "、".join(missing[:3])
    if subtype == "planning_checklist_missing":
        return f"没有把“{expected_text}”拆成可验证检查项"
    if subtype == "retrieval_scope_mismatch":
        return f"应找“{expected_text}”，实际只覆盖“{actual_text}”"
    if subtype == "evidence_source_missing":
        return "缺少文件名、片段编号或原文句子"
    if subtype == "log_locator_missing":
        return "缺少时间戳、错误码、接口名或日志行"
    if subtype == "status_verification_missing":
        return "没有验证状态/上线结论的来源"
    if subtype == "function_evidence_missing":
        return "缺少功能名称和作用的原文依据"
    if subtype == "claim_without_citation":
        return "结论没有绑定可追溯证据"
    if subtype == "context_keypoint_loss":
        return f"后续会用到的“{expected_text}”没有完整保留"
    if subtype == "self_inconsistency_possible":
        return "当前说法可能与前序步骤已有信息冲突"
    if subtype == "format_schema_missing":
        return "缺少结构化字段，后续难以校验"
    if subtype == "constraint_check_missing":
        return f"没有逐条核验“{missing_text or expected_text}”"
    if subtype == "numeric_status_risk":
        return "数字、时间或状态结论需要逐项对照原文"
    if subtype == "tool_boundary_missing":
        return "工具/API错误边界没有隔离"
    output_hint = compact_snippet(step_output, 34)
    return f"{step_name} 的输出“{output_hint}”需要补充证据"


def summarize_reason_for_display(reason: str, fallback: str = "这一步的证据或结论需要复核") -> str:
    clean = re.sub(r"\s+", " ", reason or "").strip()
    if not clean:
        return fallback

    entity_drop = re.search(r"Step\s*(\d+)\s*有\s*(\d+)\s*个候选[：:](.+?)；当前只继承\s*(\d+)\s*个，缺少[：:](.+?)(?:。|$)", clean)
    if entity_drop:
        missing = compact_snippet(entity_drop.group(5), 32)
        return f"前面有 {entity_drop.group(2)} 个候选，当前无理由漏掉了“{missing}”"

    missing_after_previous = re.search(r"Step\s*(\d+)\s*已出现候选信息[：:](.+?)；当前 Step\s*(\d+)\s*又声称信息不足", clean)
    if missing_after_previous:
        return f"前面 Step {missing_after_previous.group(1)} 已给出信息，当前 Step {missing_after_previous.group(3)} 却说缺少信息"

    signal_match = re.search(r"可观测信号[：:](.+?)(?:。|$)", clean)
    if signal_match:
        return compact_snippet(signal_match.group(1).split("；")[0], 58)

    retrieval = re.search(r"应该围绕“([^”]+)”找证据。(?:实际输出主要是“([^”]+)”。)?", clean)
    if retrieval:
        expected = compact_snippet(retrieval.group(1), 24)
        actual = compact_snippet(retrieval.group(2) or "", 24)
        if actual:
            return f"应该找“{expected}”的证据，但输出主要在讲“{actual}”"
        return f"这一步需要先找“{expected}”的证据"

    missing_seen = re.search(r"(?:输出里|当前输出.*?里)没有看到“([^”]+)”", clean)
    if missing_seen:
        return f"长原因指出输出缺少“{compact_snippet(missing_seen.group(1), 34)}”"

    checklist = re.search(r"没有把“([^”]+)”作为独立检查点", clean)
    if checklist:
        return f"没有单独检查“{compact_snippet(checklist.group(1), 34)}”"

    keep = re.search(r"输出没有保留“([^”]+)”", clean)
    if keep:
        return f"输入目标里有“{compact_snippet(keep.group(1), 34)}”，但输出没保留下来"

    no_source_claim = re.search(r"该结论没有绑定(.+?)；", clean)
    if no_source_claim:
        return f"结论没有绑定{compact_snippet(no_source_claim.group(1), 28)}"

    verifier_missing = re.search(r"但当前输出“(.+?)”里没有看到“([^”]+)”", clean)
    if verifier_missing:
        return f"验证输出缺少“{compact_snippet(verifier_missing.group(2), 34)}”"

    if "声称缺少信息" in clean and "前序步骤已经给出" in clean:
        return "当前说缺少信息，但前序步骤已经给出相关内容"
    if "前序步骤已有多个候选实体" in clean and "无明确筛选理由" in clean:
        return "前面已有多个候选，当前无理由遗漏了一部分"
    if "无法解析为 JSON" in clean:
        return "要求结构化输出，但实际内容不能解析为 JSON"
    if "API/工具/系统错误" in clean:
        return "运行时出现 API 或工具错误，后续结果不能直接信任"
    if "没有找到相关信息" in clean or "证据不足" in clean:
        return "检索/证据步骤自己提示资料或证据不足"
    return compact_snippet(clean, 58)


def potential_risk_meta(
    failure_type: str,
    stage: str,
    step: Dict[str, Any],
    profile: Dict[str, Any],
) -> Dict[str, str]:
    full_text = profile["text"]
    step_name = str(step.get("name") or step.get("skill") or f"Step {step.get('order', '')}").strip()
    step_output = str(step.get("output") or "")
    step_input = str(step.get("input") or "")
    step_prompt = "\n".join(str(step.get(key, "")) for key in ("userPrompt", "systemPrompt", "userPromptTemplate", "description"))
    visible_step_result = step_output.strip() or step_input.strip() or step_prompt
    missing = missing_evidence_requirements(full_text, visible_step_result, stage)
    expected_terms = extract_key_terms("\n".join([step_name, step_prompt, step_input]), 6)
    actual_terms = extract_key_terms(step_output or step_input, 6)
    subtype = infer_potential_subtype(failure_type, stage, missing, expected_terms, actual_terms, full_text, step_output)
    summary = summarize_potential_reason(subtype, missing, expected_terms, actual_terms, step_name, step_output or step_input)
    return {
        "subtype": subtype,
        "label": POTENTIAL_SUBTYPE_LABELS.get(subtype, FAILURE_TYPES.get(failure_type, FAILURE_TYPES["unknown"])),
        "reason_summary": summary,
    }


def grounded_potential_reason(
    failure_type: str,
    stage: str,
    step: Dict[str, Any],
    profile: Dict[str, Any],
    default_reason: str,
) -> str:
    full_text = profile["text"]
    step_name = str(step.get("name") or step.get("skill") or f"Step {step.get('order', '')}").strip()
    step_output = str(step.get("output") or "")
    step_input = str(step.get("input") or "")
    step_prompt = "\n".join(str(step.get(key, "")) for key in ("userPrompt", "systemPrompt", "userPromptTemplate", "description"))
    step_focus_points = extract_focus_points("\n".join([step_name, step_prompt, step_input]), 3)
    global_focus_points = extract_focus_points(full_text, 3)
    visible_step_result = step_output.strip() or step_input.strip()
    missing = missing_evidence_requirements(full_text, visible_step_result or step_prompt, stage)
    output_snippet = compact_snippet(step_output or step_input or step_prompt, 120)
    focus_text = "；".join(step_focus_points[:2] or global_focus_points[:1]) if (step_focus_points or global_focus_points) else "当前问题要求"
    expected_terms = extract_key_terms("\n".join([step_name, step_prompt, step_input]), 6)
    actual_terms = extract_key_terms(step_output, 6)
    missing_terms = [term for term in expected_terms if term not in step_output][:4]
    expected_text = describe_terms(expected_terms[:3], "本步目标")
    actual_text = describe_terms(actual_terms[:3], "当前输出")
    missing_text = describe_terms(missing_terms[:3], "")

    if failure_type == "retrieval_miss":
        detail = f"本步是“{step_name}”，应该围绕“{expected_text}”找证据。"
        if actual_terms:
            detail += f"实际输出主要是“{actual_text}”。"
        if missing:
            detail += f"输出里没有看到“{'、'.join(missing)}”。"
        if missing_text:
            detail += f"尤其没有覆盖“{missing_text}”。"
        return detail + "所以可能是资料方向不完整，不能直接支撑本步结论。"

    if failure_type == "planning_error":
        detail = f"本步是“{step_name}”，需要把“{focus_text}”拆成后续可检查的小任务。"
        if actual_terms:
            detail += f"但当前输出只保留了“{actual_text}”。"
        if missing_text:
            detail += f"没有把“{missing_text}”作为独立检查点。"
        return detail + "所以后续步骤可能不知道要分别核对哪些证据。"

    if failure_type == "context_omission":
        detail = f"本步是“{step_name}”，它的输出会被后续步骤继续使用。"
        if missing:
            detail += f"但当前输出里缺少“{'、'.join(missing)}”。"
        if missing_text:
            detail += f"相比本步输入/目标，输出没有保留“{missing_text}”。"
        else:
            detail += f"当前输出“{output_snippet}”偏概括，可能不足以支撑后续精确判断。"
        return detail + "所以风险是上下文被压缩后，后续步骤拿不到关键证据。"

    if missing and failure_type in {"constraint_violation", "fact_error"}:
        return (
            f"本步是“{step_name}”，需要核对“{focus_text}”。"
            f"但当前输出“{output_snippet}”里没有看到“{'、'.join(missing)}”。"
            f"因此可能在 {FAILURE_TYPES.get(failure_type, failure_type)} 上漏检。"
        )

    if missing:
        return (
            f"本步是“{step_name}”，正在处理“{focus_text}”。"
            f"但当前输出“{output_snippet}”里没有看到“{'、'.join(missing)}”，"
            f"所以可能在 {FAILURE_TYPES.get(failure_type, failure_type)} 上漏掉关键依据。"
        )

    if failure_type == "hallucination":
        return (
            f"本步是“{step_name}”，输出结论是“{output_snippet}”。"
            f"但该结论没有绑定文件片段、日志行或上游证据；如果后续直接采用，容易把“{actual_text}”当成已证实事实。"
        )
    return (
        f"本步是“{step_name}”，当前输出为“{output_snippet or actual_text}”。"
        f"{default_reason} 该判断基于本步输入/输出，而不是全局套用。"
    )


def grounded_potential_fixes(
    failure_type: str,
    stage: str,
    step: Dict[str, Any],
    profile: Dict[str, Any],
) -> List[str]:
    full_text = profile["text"]
    step_name = str(step.get("name") or step.get("skill") or f"Step {step.get('order', '')}").strip()
    step_output = str(step.get("output") or "")
    step_input = str(step.get("input") or "")
    step_prompt = "\n".join(str(step.get(key, "")) for key in ("userPrompt", "systemPrompt", "userPromptTemplate", "description"))
    visible_step_result = step_output.strip() or step_input.strip()
    missing = missing_evidence_requirements(full_text, visible_step_result or step_prompt, stage)
    expected_terms = extract_key_terms("\n".join([step_name, step_prompt, step_input]), 5)
    expected_text = describe_terms(expected_terms[:3], "本步目标")
    missing_text = "、".join(missing) if missing else "证据来源字段"

    if failure_type == "retrieval_miss":
        return [
            f"System Prompt：把“{step_name}”改成先找证据再下结论，要求只围绕“{expected_text}”检索/筛选资料。",
            f"User Template：在输入里加入“必须输出文件名、片段编号、原文句子；如果找不到 {missing_text}，写证据不足”。",
            "输出格式：改成 {matched_evidence: [{source, snippet, supports}], missing_evidence: [], conclusion_allowed: true/false}。",
            "后续约束：下一步只能使用 matched_evidence 里的内容，不能直接使用没有来源的概括句。",
        ]

    if failure_type == "planning_error":
        return [
            f"System Prompt：要求“{step_name}”把任务拆成可验证清单，而不是只写总体目标。",
            "User Template：增加字段 target_object、required_evidence、explicit_constraints、acceptance_criteria，每个字段都从原始问题或上游输出中提取。",
            f"输出格式：每个子检查点都要包含 target、required_evidence、next_step_input，确保后续步骤知道要核对“{expected_text}”。",
            "如果某个检查点缺少资料，输出 missing_plan_items，不要让后续步骤默认已覆盖。",
        ]

    if failure_type == "constraint_violation":
        return [
            f"System Prompt：把“{step_name}”改成逐条核验，不允许用“可能/大概/已完成”替代证据。",
            f"User Template：加入“请逐项检查是否具备 {missing_text}；没有就标记 failed，不要给通过结论”。",
            "输出格式：改成 {check_item, evidence, pass, failed_reason, needs_rerun_step}，方便回退到对应上游步骤。",
            "确认提交前：如果 pass=false，右侧详细子过程不要进入最终总结，先回到证据收集步骤补资料。",
        ]

    if failure_type == "hallucination":
        return [
            f"System Prompt：要求“{step_name}”每个结论后面必须附 source/snippet，未引用的结论写“不确定”。",
            f"User Template：把上一步输出作为候选材料输入，并要求模型删除没有 {missing_text} 的句子。",
            "输出格式：改成 [{claim, source, snippet, confidence}]；confidence 不能高于证据完整度。",
            "最终回答：只允许汇总带 source 的 claim，没有 source 的内容放到“待补充证据”。",
        ]

    if failure_type == "context_omission":
        return [
            f"System Prompt：要求“{step_name}”先保留硬约束和关键证据，再压缩其他文字。",
            f"User Template：加入“请从输入中提取 must_keep 字段，至少包含 {expected_text} 和 {missing_text}”。",
            "输出格式：改成 {must_keep, dropped_context, compressed_summary}，让后续知道哪些信息被删掉了。",
            "如果 must_keep 为空或缺字段，停止后续步骤并提示重新提供/重新检索材料。",
        ]

    if failure_type == "fact_error":
        return [
            f"System Prompt：要求“{step_name}”对数字、时间、状态、专名逐项复核，不允许凭印象改写。",
            "User Template：加入“请列出原文值、你的改写值、是否一致”，不一致时输出 conflict。",
            "输出格式：改成 {field, original_value, generated_value, source, match}。",
            "后续总结只能使用 match=true 的字段；conflict 字段进入验证步骤。",
        ]

    return [
        f"System Prompt：让“{step_name}”先列证据和边界，再输出结论。",
        f"User Template：要求显式说明本步输入中哪些内容支持“{expected_text}”。",
        "输出格式：增加 evidence、missing、confidence 三个字段，避免只输出无法追踪的自然语言。",
    ]


def output_fingerprint(output: str) -> List[str]:
    candidates: List[str] = []
    for sentence in split_sentences(output):
        compact = sentence.strip()
        if 12 <= len(compact) <= 180:
            candidates.append(compact)
        if len(candidates) >= 4:
            break
    if not candidates and output:
        compact = re.sub(r"\s+", " ", output).strip()
        if len(compact) >= 12:
            candidates.append(compact[:160])
    return candidates


def later_step_uses_output(source_output: str, later_input: str) -> bool:
    if not source_output or not later_input:
        return False
    later = re.sub(r"\s+", " ", later_input)
    for fp in output_fingerprint(source_output):
        if fp and fp in later:
            return True
        ratio = SequenceMatcher(None, fp, later[: max(len(fp) * 3, 120)]).ratio()
        if ratio >= 0.72:
            return True
    return False


def source_refs_for_step(index: int, step: Dict[str, Any]) -> List[str]:
    refs = list(step.get("source_refs") or [])
    if not refs:
        refs.append("user_query" if index == 0 else f"previous_step_{index}")
    if step.get("systemPrompt") or step.get("system_prompt"):
        refs.append("system_prompt")
    if step.get("modified"):
        refs.append("prompt_patch")
    return list(dict.fromkeys(refs))


def step_full_text(step: Dict[str, Any]) -> str:
    return "\n".join(
        str(step.get(key, ""))
        for key in (
            "name",
            "skill",
            "description",
            "input",
            "output",
            "systemPrompt",
            "system_prompt",
            "userPrompt",
            "userPromptTemplate",
            "user_template",
            "reasoning",
        )
    )


def context_profile(all_steps: List[Dict[str, Any]]) -> Dict[str, Any]:
    full_text = "\n".join(step_full_text(step) for step in all_steps)
    token_count = estimate_tokens(full_text)
    return {
        "text": full_text,
        "has_documents": contains_any(full_text, DOCUMENT_TERMS) or "【已上传文档的相关片段】" in full_text,
        "has_logs": contains_any(full_text, LOG_TERMS),
        "asks_diagnosis": False,
        "needs_evidence": contains_any(full_text, EVIDENCE_TERMS) or contains_any(full_text, DOCUMENT_TERMS),
        "has_numbers": contains_any(full_text, NUMERIC_TERMS),
        "has_constraints": contains_any(full_text, CONSTRAINT_TERMS),
        "long_context": token_count > 3800 or len(full_text) > 9000,
        "token_count": token_count,
    }


def add_potential_risk(
    risks: List[Dict[str, Any]],
    failure_type: str,
    confidence: float,
    reason: str,
    source_excerpt: str,
    severity: str = "medium",
    suggested_fixes: Optional[List[str]] = None,
    subtype: Optional[str] = None,
    label: Optional[str] = None,
    reason_summary: Optional[str] = None,
    matched_signals: Optional[List[str]] = None,
) -> None:
    if any(item.get("failure_type") == failure_type and item.get("reason") == reason for item in risks):
        return
    fix_items = suggested_fixes or [POTENTIAL_FIX_SUGGESTIONS.get(failure_type, "给该步骤增加证据来源、边界条件和验收标准。")]
    readable_summary = summarize_reason_for_display(reason, reason_summary or label or FAILURE_TYPES.get(failure_type, failure_type))
    risks.append({
        "failure_type": failure_type,
        "subtype": subtype or failure_type,
        "label": label or FAILURE_TYPES.get(failure_type, FAILURE_TYPES["unknown"]),
        "confidence": round(clamp(confidence, 0.0, 0.95), 3),
        "reason_summary": readable_summary,
        "reason": reason,
        "source_excerpt": source_excerpt[:220],
        "matched_signals": matched_signals or [],
        "suggested_fix": fix_items[0],
        "suggested_fixes": fix_items,
        "severity": severity,
    })


def potential_risks_for_step(index: int, step: Dict[str, Any], all_steps: List[Dict[str, Any]], stage: str) -> List[Dict[str, Any]]:
    profile = context_profile(all_steps)
    step_text = step_full_text(step)
    full_text = profile["text"]
    step_name = str(step.get("name") or step.get("skill") or f"Step {step.get('order', index + 1)}").strip()
    step_output = str(step.get("output") or "")
    step_input = str(step.get("input") or "")
    step_prompt = "\n".join(str(step.get(key, "")) for key in ("systemPrompt", "system_prompt", "userPrompt", "userPromptTemplate", "description"))
    source_excerpt = find_evidence_snippet(
        step_text,
        DOCUMENT_TERMS + LOG_TERMS + EVIDENCE_TERMS + STATUS_TERMS + TOOL_TERMS,
        find_evidence_snippet(full_text, DOCUMENT_TERMS + LOG_TERMS + EVIDENCE_TERMS + STATUS_TERMS + TOOL_TERMS, step_text[:220] or full_text[:220]),
    )
    risks: List[Dict[str, Any]] = []
    total = max(len(all_steps), 1)
    downstream_weight = (total - index) / total
    risk_score = normalize_score(step.get("riskScore", step.get("risk_score")), 0.0)
    visible_step_result = str(step.get("output") or step.get("input") or "")
    current_missing = missing_evidence_requirements(full_text, visible_step_result, stage)
    prompt_and_input = "\n".join([step_name, step_prompt, step_input])
    expected_terms = extract_key_terms(prompt_and_input, 5)
    output_terms = extract_key_terms(step_output, 5)
    output_has_claim = len(step_output.strip()) >= 20 and contains_any(step_output, CLAIM_TERMS + STATUS_TERMS + NUMERIC_TERMS)
    has_format_request = contains_any(prompt_and_input, FORMAT_TERMS) or wants_json(step)
    has_tool_context = stage == "tool_call" or contains_any(step_text, TOOL_TERMS)
    inherited_issue = inherited_entity_issue(index, step, all_steps)

    def grounded(failure_type: str, default_reason: str) -> str:
        return grounded_potential_reason(failure_type, stage, step, profile, default_reason)

    def fixes_for(failure_type: str) -> List[str]:
        return grounded_potential_fixes(failure_type, stage, step, profile)

    def meta_for(failure_type: str) -> Dict[str, str]:
        return potential_risk_meta(failure_type, stage, step, profile)

    def add_signal_risk(
        failure_type: str,
        base_confidence: float,
        signals: List[str],
        default_reason: str,
        severity: str = "medium",
    ) -> None:
        clean_signals = list(dict.fromkeys(signal for signal in signals if signal))
        if not clean_signals:
            return
        signal_text = "；".join(clean_signals[:3])
        reason = f"{grounded(failure_type, default_reason)} 可观测信号：{signal_text}。"
        add_potential_risk(
            risks,
            failure_type,
            min(base_confidence + 0.04 * min(len(clean_signals), 3), 0.88),
            reason,
            source_excerpt,
            severity,
            suggested_fixes=fixes_for("hallucination" if failure_type == "unsupported_claim" else failure_type),
            matched_signals=clean_signals,
            **meta_for(failure_type),
        )

    planning_signals: List[str] = []
    if stage == "planner":
        if profile["has_documents"] and not contains_any(step_text, ["检索", "证据", "引用", "来源", "片段"]):
            planning_signals.append("用户问题涉及文档/引用，但计划里没有安排检索或证据步骤")
        if profile["has_constraints"] and not contains_any(step_text, ["验证", "检查", "约束", "标准", "通过", "失败"]):
            planning_signals.append("用户有显式约束，但计划没有验证标准")
        if len(extract_focus_points(step_output or step_prompt, 3)) <= 1 and downstream_weight >= 0.5:
            planning_signals.append("计划输出过粗，后续步骤难以知道要核对什么")
    add_signal_risk("planning_error", 0.58, planning_signals, "计划步骤需要围绕原始问题拆出对象、证据、约束和验收标准。", "medium")

    retrieval_signals: List[str] = []
    retrieval_stage_like = stage == "retriever" or (
        stage in {"planner", "unknown"} and contains_any(prompt_and_input, ["检索", "查找", "收集", "资料", "证据"])
    )
    if retrieval_stage_like:
        if profile["has_documents"] and not has_document_citation(step_output or step_text):
            retrieval_signals.append("证据步骤没有输出文件名、片段编号或原文句子")
        if contains_any(step_output, RETRIEVAL_MISS_TERMS):
            retrieval_signals.append("输出里出现未找到/证据不足/无法确认")
        missing_terms = [term for term in expected_terms if term and term not in step_output][:3]
        if missing_terms and step_output.strip():
            retrieval_signals.append(f"输入目标包含“{describe_terms(missing_terms)}”，但检索输出没有覆盖")
    add_signal_risk("retrieval_miss", 0.6, retrieval_signals, "证据选择步骤可能没有把关键资料带入后续上下文。", "high" if stage == "retriever" else "medium")

    context_signals: List[str] = []
    if inherited_issue and inherited_issue.get("failure_type") == "context_omission":
        context_signals.append(inherited_issue["source"])
    if profile["long_context"] and stage in {"generator", "verifier", "summarizer", "unknown"}:
        context_signals.append(f"当前链路上下文较长，估算 token 约 {profile['token_count']}")
    if downstream_weight >= 0.66 and risk_score >= 0.55 and stage in {"planner", "retriever", "unknown"}:
        context_signals.append("该步骤位于前段且后续依赖较多，摘要遗漏会向后传播")
    if current_missing and stage in {"generator", "summarizer"} and later_step_uses_output(step_output, str(all_steps[index + 1].get("input") or "")) if index + 1 < len(all_steps) else False:
        context_signals.append(f"本步输出会被下一步使用，但缺少 {'、'.join(current_missing[:2])}")
    add_signal_risk("context_omission", 0.54, context_signals, "上下文传递或压缩可能让后续步骤拿不到关键内容。", "medium")

    inconsistency_signals: List[str] = []
    if inherited_issue and inherited_issue.get("failure_type") == "self_inconsistency":
        inconsistency_signals.append(inherited_issue["source"])
    if says_missing_information(step_text) and index > 0 and any(extract_candidate_entities(str(prev.get("output") or "")) for prev in all_steps[:index]):
        inconsistency_signals.append("当前步骤声称缺少信息，但前序步骤已经出现候选实体或描述")
    add_signal_risk("self_inconsistency", 0.66, inconsistency_signals, "当前步骤可能与前序步骤已有信息不一致。", "high")

    unsupported_signals: List[str] = []
    if stage in {"generator", "summarizer", "verifier"} and profile["needs_evidence"] and output_has_claim and not has_document_citation(step_output):
        unsupported_signals.append("本步生成了事实/状态类结论，但没有引用来源片段")
    if contains_any(step_output, STATUS_TERMS) and not has_document_citation(step_output):
        unsupported_signals.append("输出包含上线/状态判断，但没有绑定状态表或原文依据")
    if contains_any(step_output, ["显然", "可见", "必然", "已经完成", "正式上线"]) and not has_document_citation(step_output):
        unsupported_signals.append("输出使用确定性结论词，但没有 source_ref")
    add_signal_risk("unsupported_claim", 0.6, unsupported_signals, "生成/总结步骤需要把每个事实结论绑定证据。", "high")

    fact_signals: List[str] = []
    if stage in {"generator", "verifier", "summarizer"} and contains_any(step_output + prompt_and_input, NUMERIC_TERMS + STATUS_TERMS):
        if not has_document_citation(step_output):
            fact_signals.append("数字、时间或状态结论没有可核对来源")
        if contains_any(step_output, ["冲突", "矛盾", "不一致", "不匹配"]):
            fact_signals.append("输出自己提到冲突/矛盾/不一致")
    add_signal_risk("fact_error", 0.52, fact_signals, "涉及数字、时间、表格或状态时，需要逐项对照原文。", "medium")

    tool_signals: List[str] = []
    if has_tool_context:
        if contains_any(step_text, HARD_ERROR_TERMS):
            tool_signals.append("日志或输出出现 API/工具错误码、异常或失败文本")
        if contains_any(step_text, ["参数", "schema", "请求体"]) and not contains_any(step_text, ["校验", "required", "必填", "字段"]):
            tool_signals.append("工具调用涉及参数，但没有看到参数校验")
        if profile["has_logs"] and not has_log_locator(step_text):
            tool_signals.append("问题涉及日志/API，但本步没有定位错误码、接口名或日志行")
    add_signal_risk("tool_misuse", 0.62, tool_signals, "工具或 API 步骤需要先确认参数、错误码和失败边界。", "high")

    format_signals: List[str] = []
    if has_format_request:
        if step_output.strip() and wants_json(step) and not has_parseable_json(step_output):
            format_signals.append("Prompt 要求 JSON/结构化输出，但当前输出不能解析为 JSON")
        if not contains_any(step_text, ["字段", "schema", "required", "格式", "JSON", "json"]):
            format_signals.append("任务需要结构化结果，但本步没有明确字段/schema")
    add_signal_risk("format_error", 0.58, format_signals, "格式类任务需要明确字段、类型和解析规则。", "medium")

    constraint_signals: List[str] = []
    if profile["has_constraints"] and stage in {"planner", "generator", "verifier", "summarizer"}:
        if not contains_any(step_text, ["必须", "不能", "不要", "只能", "约束", "检查", "通过", "未通过", "标准"]):
            constraint_signals.append("用户有显式约束，但本步没有保留或核验这些约束")
        if current_missing and stage == "verifier":
            constraint_signals.append(f"验证输出缺少 {'、'.join(current_missing[:2])}")
    add_signal_risk("constraint_violation", 0.56, constraint_signals, "有显式要求或业务规则时，本步必须逐条核验。", "medium")

    risks.sort(key=lambda item: item.get("confidence", 0), reverse=True)
    return risks[:3]


def where_to_steps_for_step(index: int, all_steps: List[Dict[str, Any]]) -> List[int]:
    if index >= len(all_steps) - 1:
        return []
    current_output = str(all_steps[index].get("output") or "")
    destinations: List[int] = []
    for later_index in range(index + 1, len(all_steps)):
        later_input = str(all_steps[later_index].get("input") or "")
        if later_index == index + 1 and (current_output.strip() or later_input.strip()):
            destinations.append(later_index + 1)
            continue
        if later_step_uses_output(current_output, later_input):
            destinations.append(later_index + 1)
    return list(dict.fromkeys(destinations))


def affected_steps_for_step(index: int, all_steps: List[Dict[str, Any]], failure_type: str, confidence: float) -> List[int]:
    if failure_type not in PROPAGATING_FAILURES or confidence < 0.6:
        return []
    direct_destinations = where_to_steps_for_step(index, all_steps)
    if not direct_destinations:
        return []
    affected = set(direct_destinations)
    if index + 2 in affected:
        for later_index in range(index + 1, len(all_steps)):
            affected.add(later_index + 1)
    return sorted(affected)


def propagation_edges(index: int, affected_steps: List[int], failure_type: str, evidence_source: str) -> List[Dict[str, Any]]:
    return [
        {
            "from_step": index + 1,
            "to_step": target,
            "failure_type": failure_type,
            "source_excerpt": evidence_source,
            "reason": "后续步骤的输入实际使用了该步骤输出，因此该错误可能沿数据流传播。",
        }
        for target in affected_steps
    ]


def provenance_for_step(index: int, step: Dict[str, Any], all_steps: List[Dict[str, Any]]) -> Dict[str, List[Dict[str, Any]]]:
    """Build an observable provenance graph for the step.

    The graph is intentionally based on available runtime artifacts only:
    user question, previous-step outputs, uploaded/document references, tool/log
    hints, prompt text, and the current step output. It does not depend on hidden
    chain-of-thought.
    """
    step_no = index + 1
    step_name = str(step.get("name") or step.get("skill") or f"Step {step_no}")
    step_text = step_full_text(step)
    prompt_text = "\n".join(
        str(step.get(key, ""))
        for key in ("systemPrompt", "system_prompt", "userPrompt", "userPromptTemplate", "user_template")
    ).strip()
    input_text = str(step.get("input") or "")
    output_text = str(step.get("output") or "")
    refs = source_refs_for_step(index, step)
    has_runtime_error = contains_any(step_text, HARD_ERROR_TERMS) or has_log_locator(step_text)
    has_external_document = has_document_citation(step_text) or contains_any(step_text, DOCUMENT_TERMS)
    nodes: List[Dict[str, Any]] = []
    edges: List[Dict[str, Any]] = []

    def add_node(node_id: str, node_type: str, label: str, detail: str = "", status: str = "normal") -> None:
        if any(node.get("id") == node_id for node in nodes):
            return
        nodes.append({
            "id": node_id,
            "type": node_type,
            "label": label[:80],
            "detail": detail or "",
            "status": status,
        })

    def add_edge(source: str, target: str, relation: str, status: str = "normal", evidence: str = "") -> None:
        edge = {
            "source": source,
            "target": target,
            "relation": relation,
            "status": status,
            "evidence": evidence or "",
        }
        if edge not in edges:
            edges.append(edge)

    step_node = f"step:{step_no}"
    add_node(step_node, "step", f"Step {step_no}: {step_name}", output_text or input_text)

    if index == 0:
        add_node("source:user_query", "question", "User question", input_text or step_text)
        add_edge("source:user_query", step_node, "initial_input", evidence=input_text)
    else:
        prev_node = f"step:{index}"
        prev_output = str(all_steps[index - 1].get("output") or "")
        add_node(prev_node, "previous_step", f"上游输出 Step {index}: {all_steps[index - 1].get('name') or 'previous step'}", prev_output)
        add_edge(prev_node, step_node, "previous_output_to_input", evidence=input_text or prev_output)

    if prompt_text:
        prompt_node = f"prompt:{step_no}"
        add_node(prompt_node, "prompt", f"Prompt for Step {step_no}", prompt_text)
        add_edge(prompt_node, step_node, "controls_generation", evidence=prompt_text)

    for ref in refs:
        ref_text = str(ref)
        ref_id = "source:" + re.sub(r"[^a-zA-Z0-9_.:-]+", "_", ref_text)[:80]
        if ref_text.startswith("previous_step"):
            add_node(ref_id, "memory", ref_text, "Carried from an earlier step.")
            add_edge(ref_id, step_node, "context_carried", evidence=input_text)
        elif "tool" in ref_text.lower() or "api" in ref_text.lower() or contains_any(step_text, TOOL_TERMS):
            add_node(ref_id, "tool", ref_text, find_evidence_snippet(step_text, TOOL_TERMS, output_text or input_text))
            add_edge(ref_id, step_node, "tool_result_used", evidence=find_evidence_snippet(step_text, TOOL_TERMS, ""))
        elif ref_text != "user_query":
            doc_detail = find_evidence_snippet(step_text, DOCUMENT_TERMS, input_text or output_text)
            add_node(ref_id, "document", f"外部资料/检索来源：{ref_text}", doc_detail)
            add_edge(ref_id, step_node, "document_evidence_used", evidence=doc_detail)

    if has_external_document:
        doc_node = f"document:citation:{step_no}"
        doc_detail = find_evidence_snippet(step_text, DOCUMENT_TERMS, input_text or output_text)
        add_node(doc_node, "document", "文档/检索证据片段", doc_detail)
        add_edge(doc_node, step_node, "cited_evidence", evidence=doc_detail)

    if has_runtime_error:
        log_node = f"log:{step_no}"
        add_node(log_node, "log", "Runtime log / error text", find_evidence_snippet(step_text, LOG_TERMS + HARD_ERROR_TERMS, step_text), "warning")
        add_edge(log_node, step_node, "runtime_signal", "warning", find_evidence_snippet(step_text, LOG_TERMS + HARD_ERROR_TERMS, ""))

    for target in where_to_steps_for_step(index, all_steps):
        target_node = f"step:{target}"
        target_step = all_steps[target - 1] if 0 <= target - 1 < len(all_steps) else {}
        add_node(target_node, "downstream_step", f"Step {target}: {target_step.get('name') or 'downstream step'}", str(target_step.get("input") or target_step.get("output") or ""))
        add_edge(step_node, target_node, "output_used_by_downstream", evidence=output_text)

    return {"nodes": nodes, "edges": edges}


def confidence_from_signal(
    base: float,
    evidence_source: str,
    health_score: float,
    failure_type: str,
) -> float:
    if failure_type in SOFT_FAILURES:
        return min(base, 0.42)
    source = evidence_source or ""
    specificity = 0.0
    if len(source) >= 30:
        specificity += 0.03
    if len(source) >= 90:
        specificity += 0.03
    if has_log_locator(source) or contains_any(source, HARD_ERROR_TERMS):
        specificity += 0.06
    if has_document_citation(source):
        specificity += 0.05
    if re.search(r"Step\s*\d+.*(?:缺少|只继承|声称信息不足)", source):
        specificity += 0.07
    if re.search(r"\d+\s*个候选|当前只继承\s*\d+", source):
        specificity += 0.04
    if contains_any(source, ["未找到", "证据不足", "无法确认", "未通过", "不正确", "无法解析"]):
        specificity += 0.05

    type_adjust = {
        "tool_misuse": 0.04,
        "format_error": 0.03,
        "self_inconsistency": 0.03,
        "context_omission": 0.02,
        "retrieval_miss": 0.02,
        "constraint_violation": 0.01,
        "unsupported_claim": 0.0,
        "unknown": -0.08,
    }.get(failure_type, 0.0)
    return clamp(base + specificity + type_adjust, 0.35, 0.96)


def evidence_strength_basis(failure_type: str, evidence_source: str, observed_signals: List[str]) -> List[str]:
    if failure_type == "none":
        return []
    basis: List[str] = []
    if observed_signals:
        basis.append(f"命中信号：{', '.join(observed_signals)}")
    if contains_any(evidence_source, HARD_ERROR_TERMS):
        basis.append("证据中包含明确 API/工具/系统错误文本")
    if has_log_locator(evidence_source):
        basis.append("证据中包含时间、错误码、接口名或日志行定位")
    if has_document_citation(evidence_source):
        basis.append("证据中包含文件、片段、页码或引用来源")
    if re.search(r"\d+\s*个候选|当前只继承\s*\d+", evidence_source or ""):
        basis.append("证据中包含前后候选数量变化")
    if contains_any(evidence_source, ["未找到", "证据不足", "无法确认", "未通过", "不正确", "无法解析"]):
        basis.append("步骤输出直接暴露失败或证据不足")
    if not basis and evidence_source:
        basis.append("基于当前步骤输出中的可定位文字片段")
    return basis


def extract_candidate_entities(text: str, limit: int = 12) -> List[str]:
    entities: List[str] = []
    for raw_line in (text or "").splitlines():
        line = raw_line.strip()
        bullet = re.match(r"^(?:[-*•]|\d+[.、)]|\([一二三四五六七八九十]\))\s*(.+)$", line)
        if bullet:
            value = re.split(r"[：:，,；;。]", bullet.group(1).strip())[0].strip()
            if 2 <= len(value) <= 28:
                entities.append(value)
    patterns = [
        r"[\u4e00-\u9fffA-Za-z0-9_-]{2,24}(?:平台|系统|服务|模块|功能|接口|目录|表|档案|预约|提醒|查询)",
        r"[\u4e00-\u9fff]{2,16}(?:上线|试运行|灰度|规划|已实现|未上线)",
    ]
    for pattern in patterns:
        for match in re.findall(pattern, text or ""):
            value = match.strip("，。；：:,.!？?（）()[]【】")
            if 2 <= len(value) <= 28:
                entities.append(value)
    cleaned: List[str] = []
    for entity in entities:
        if entity in STOP_TERMS:
            continue
        if any(entity != old and entity in old for old in cleaned):
            continue
        if entity not in cleaned:
            cleaned.append(entity)
    return cleaned[:limit]


def has_filter_reason(text: str) -> bool:
    return bool(re.search(r"(筛选|过滤|剔除|只保留|仅保留|因为.+不符合|不纳入|排除|按.+条件)", text or ""))


def says_missing_information(text: str) -> bool:
    return contains_any(text, ["缺少信息", "信息不足", "无法提取", "无法判断", "请补充", "未提供", "没有提供", "资料不足"])


def inherited_entity_issue(index: int, step: Dict[str, Any], all_steps: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    if index <= 0:
        return None
    current_output = str(step.get("output") or "")
    current_text = step_full_text(step)
    current_entities = extract_candidate_entities(current_output or current_text)
    best_previous: Optional[Dict[str, Any]] = None
    for previous_index in range(0, index):
        previous_output = str(all_steps[previous_index].get("output") or "")
        previous_entities = extract_candidate_entities(previous_output)
        if len(previous_entities) >= 3 and (not best_previous or len(previous_entities) > len(best_previous["entities"])):
            best_previous = {
                "step": previous_index + 1,
                "entities": previous_entities,
                "output": previous_output,
            }
    if not best_previous:
        return None
    previous_entities = best_previous["entities"]
    inherited = [entity for entity in previous_entities if entity in current_text]
    retained_ratio = len(inherited) / max(len(previous_entities), 1)
    missing_entities = [entity for entity in previous_entities if entity not in inherited]
    if says_missing_information(current_text) and previous_entities:
        return {
            "failure_type": "self_inconsistency",
            "confidence": 0.76,
            "signal": "previous_info_declared_missing",
            "source": (
                f"Step {best_previous['step']} 已出现候选信息：{describe_terms(previous_entities[:5])}；"
                f"当前 Step {index + 1} 又声称信息不足。"
            ),
            "reason": "当前步骤声称缺少信息，但前序步骤已经给出可继承的候选实体或描述，前后结论可能矛盾。",
        }
    if len(previous_entities) >= 3 and retained_ratio < 0.7 and not has_filter_reason(current_text):
        return {
            "failure_type": "context_omission",
            "confidence": 0.7,
            "signal": "entity_carry_over_drop",
            "source": (
                f"Step {best_previous['step']} 有 {len(previous_entities)} 个候选：{describe_terms(previous_entities[:5])}；"
                f"当前只继承 {len(inherited)} 个，缺少：{describe_terms(missing_entities[:5])}。"
            ),
            "reason": "前序步骤已有多个候选实体，当前步骤无明确筛选理由却少保留了一大截，可能是上下文传递时漏掉了关键信息。",
        }
    return None


def diagnose_step(step: Dict[str, Any], all_steps: Optional[List[Dict[str, Any]]] = None) -> Dict[str, Any]:
    all_steps = all_steps or [step]
    index = max(0, int(step.get("order") or step.get("step_id") or 1) - 1)
    stage = infer_stage(step)
    output = str(step.get("output") or "")
    input_text = str(step.get("input") or "")
    prompt_text = "\n".join(str(step.get(key, "")) for key in ("userPrompt", "systemPrompt", "userPromptTemplate"))
    combined = f"{input_text}\n{prompt_text}\n{output}"
    input_tokens = int(step.get("input_tokens") or estimate_tokens(input_text))
    output_tokens = int(step.get("output_tokens") or estimate_tokens(output))
    latency_ms = int(step.get("latency_ms") or step.get("timeMs") or 0)
    source_refs = source_refs_for_step(index, step)
    health_score = normalize_score(step.get("healthScore", step.get("health_score")), 1.0)
    risk_score = normalize_score(step.get("riskScore", step.get("risk_score")), 0.0)
    impact_score = normalize_score(step.get("accuracy", step.get("impact_score")), 0.0)

    failure_type = "none"
    confidence = 0.0
    evidence_source = ""
    evidence: List[str] = []
    observed_signals: List[str] = []
    reason = "基于当前步骤的输入、输出和运行日志，未观察到足够证据判定失败。"
    inherited_issue = inherited_entity_issue(index, step, all_steps)

    if contains_any(combined, HARD_ERROR_TERMS):
        failure_type = "tool_misuse"
        evidence_source = find_evidence_snippet(combined, HARD_ERROR_TERMS)
        confidence = confidence_from_signal(0.9, evidence_source, health_score, failure_type)
        reason = "运行日志或输出中出现明确 API/工具/系统错误，后续步骤不应继续信任该结果。"
        observed_signals.append("hard_runtime_error")
    elif not output.strip() and step.get("timeMs", 0) != 0:
        failure_type = "unknown"
        evidence_source = "该步骤有耗时记录，但模型输出为空。"
        confidence = confidence_from_signal(0.68, evidence_source, health_score, failure_type)
        reason = "该步骤有运行记录但没有可用输出，无法为后续步骤提供可靠输入。"
        observed_signals.append("empty_output")
    elif wants_json(step) and output.strip() and not has_parseable_json(output):
        failure_type = "format_error"
        evidence_source = find_evidence_snippet(output, ["{", "}", "json"], output[:220])
        confidence = confidence_from_signal(0.8, evidence_source, health_score, failure_type)
        reason = "Prompt 明确要求 JSON/结构化输出，但实际输出无法解析为 JSON。"
        observed_signals.append("json_parse_failed")
    elif stage == "retriever" and contains_any(output, RETRIEVAL_MISS_TERMS):
        failure_type = "retrieval_miss"
        evidence_source = find_evidence_snippet(output, RETRIEVAL_MISS_TERMS)
        confidence = confidence_from_signal(0.72, evidence_source, health_score, failure_type)
        reason = "证据/检索阶段明确表示没有找到相关信息或证据不足。"
        observed_signals.append("retrieval_miss_terms")
    elif stage == "verifier" and contains_any(output, VERIFIER_FAIL_TERMS):
        failure_type = "constraint_violation"
        evidence_source = find_evidence_snippet(output, VERIFIER_FAIL_TERMS)
        confidence = confidence_from_signal(0.74, evidence_source, health_score, failure_type)
        reason = "验证阶段明确指出结果不正确、未通过或存在需要修正的问题。"
        observed_signals.append("verifier_failed")
    elif stage == "generator" and contains_any(output, HALLUCINATION_TERMS):
        failure_type = "unsupported_claim"
        evidence_source = find_evidence_snippet(output, HALLUCINATION_TERMS)
        confidence = confidence_from_signal(0.66, evidence_source, health_score, failure_type)
        reason = "生成阶段自己暴露出缺少证据、无法验证或未提供来源的问题。"
        observed_signals.append("evidence_gap_terms")
    elif inherited_issue:
        failure_type = inherited_issue["failure_type"]
        evidence_source = inherited_issue["source"]
        confidence = confidence_from_signal(inherited_issue["confidence"], evidence_source, health_score, failure_type)
        reason = inherited_issue["reason"]
        observed_signals.append(inherited_issue["signal"])
    elif input_tokens > 10000:
        failure_type = "context_omission"
        evidence_source = f"估算输入 token 约 {input_tokens}，超过上下文风险阈值。"
        confidence = confidence_from_signal(0.46, evidence_source, health_score, failure_type)
        reason = "输入上下文过长，存在关键约束或证据被稀释/遗漏的风险；这是弱提示，不作为红色错误源。"
        observed_signals.append("large_context")
    elif latency_ms > 60000 or input_tokens + output_tokens > 18000:
        failure_type = "cost_latency_anomaly"
        evidence_source = f"耗时 {latency_ms}ms，估算 token 总量 {input_tokens + output_tokens}。"
        confidence = confidence_from_signal(0.38, evidence_source, health_score, failure_type)
        reason = "该步骤耗时或 token 消耗偏高；这是成本/性能提示，不作为内容错误源。"
        observed_signals.append("cost_latency_signal")

    if evidence_source:
        evidence.append(f"错误证据文字源头：{evidence_source}")
    elif failure_type == "none":
        evidence.append("没有检测到明确错误日志、格式失败、检索失败、验证失败或证据缺失文本。")

    potential_risks = potential_risks_for_step(index, step, all_steps, stage)
    potential_issue_tags = list(dict.fromkeys(
        risk.get("label", risk.get("failure_type", "潜在风险"))
        for risk in potential_risks
    ))
    where_to_steps = where_to_steps_for_step(index, all_steps)
    affected_steps = affected_steps_for_step(index, all_steps, failure_type, confidence)
    status = "normal"
    if failure_type in PROPAGATING_FAILURES and confidence >= 0.6:
        status = "failure"
    elif failure_type != "none":
        status = "warning"
    failure_definition = FAILURE_DEFINITIONS.get(failure_type, {})
    likely_causes = failure_definition.get("signals", [])[:3] if failure_type != "none" else []
    exclusion_checked = failure_definition.get("exclusions", []) if failure_type != "none" else []
    failure_reason_summary = summarize_reason_for_display(
        reason,
        FAILURE_TYPES.get(failure_type, "这一步需要复核"),
    ) if failure_type != "none" else ""
    strength_basis = evidence_strength_basis(failure_type, evidence_source, observed_signals)
    provenance = provenance_for_step(index, step, all_steps)

    return {
        "step_id": index + 1,
        "stage": stage,
        "stage_label": STAGE_TYPES.get(stage, STAGE_TYPES["unknown"]),
        "health_score": round(health_score, 3),
        "risk_score": round(risk_score, 3),
        "impact_score": round(impact_score, 3),
        "latency_ms": latency_ms,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "source_refs": source_refs,
        "where_to_steps": where_to_steps,
        "affected_steps": affected_steps,
        "propagation_edges": propagation_edges(index, affected_steps, failure_type, evidence_source),
        "failure_type": failure_type,
        "failure_label": FAILURE_TYPES.get(failure_type, FAILURE_TYPES["unknown"]),
        "failure_confidence": round(confidence, 3),
        "evidence_strength_basis": strength_basis,
        "failure_reason_summary": failure_reason_summary,
        "failure_reason": reason,
        "likely_causes": likely_causes,
        "exclusion_checked": exclusion_checked,
        "related_stage": stage,
        "source_refs_used": source_refs,
        "diagnosis_status": status,
        "observed_signals": observed_signals,
        "evidence_source": evidence_source,
        "diagnosis_evidence": evidence,
        "provenance_nodes": provenance["nodes"],
        "provenance_edges": provenance["edges"],
        "potential_risks": potential_risks,
        "potential_issue_tags": potential_issue_tags,
        "suggested_fix": FIX_SUGGESTIONS.get(failure_type, FIX_SUGGESTIONS["unknown"]),
    }


def attach_diagnosis(steps: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    diagnosed: List[Dict[str, Any]] = []
    for index, step in enumerate(steps):
        enriched = dict(step)
        enriched["order"] = enriched.get("order") or index + 1
        enriched.update(diagnose_step(enriched, steps))
        diagnosed.append(enriched)
    return diagnosed


def diagnose_trace(steps: List[Dict[str, Any]]) -> Dict[str, Any]:
    if not steps:
        return {
            "overall_status": "success",
            "main_failure_type": "none",
            "failure_stage": None,
            "summary": "暂无执行步骤，因此没有可诊断的失败链路。",
            "suggested_fixes": [],
            "propagation_edges": [],
        }

    diagnosed = attach_diagnosis(steps)
    content_failures = [
        step for step in diagnosed
        if step.get("diagnosis_status") == "failure"
    ]
    warnings = [
        step for step in diagnosed
        if step.get("diagnosis_status") == "warning"
    ]
    potential_steps = [
        step for step in diagnosed
        if step.get("potential_risks")
    ]

    if not content_failures:
        if warnings:
            first_warning = warnings[0]
            return {
                "overall_status": "partial_failure",
                "main_failure_type": first_warning.get("failure_type", "unknown"),
                "main_failure_label": first_warning.get("failure_label", FAILURE_TYPES["unknown"]),
                "failure_stage": None,
                "summary": (
                    f"本次运行未发现明确内容错误源；另根据问题/文档/日志特征发现 {len(potential_steps)} 个潜在推理风险步骤。"
                    if potential_steps
                    else "本次运行未发现明确内容错误源；仅观察到成本、延迟或上下文类性能/上下文提示，不将其标红传播。"
                ),
                "suggested_fixes": first_warning.get("suggested_fix", [])[:4],
                "propagation_edges": [],
                "potential_risk_steps": [
                    {
                        "step": step.get("step_id") or step.get("order"),
                        "name": step.get("name"),
                        "risks": step.get("potential_risks", []),
                    }
                    for step in potential_steps
                ],
            }
        return {
            "overall_status": "success",
            "main_failure_type": "none",
            "failure_stage": None,
            "summary": (
                f"本次运行没有观察到明确失败信号；但基于问题/文档/日志特征，发现 {len(potential_steps)} 个步骤存在潜在推理风险。"
                if potential_steps
                else "本次运行没有观察到明确失败信号；当前诊断只记录阶段、来源和可观测指标，不强行判错。"
            ),
            "suggested_fixes": [],
            "propagation_edges": [],
            "potential_risk_steps": [
                {
                    "step": step.get("step_id") or step.get("order"),
                    "name": step.get("name"),
                    "risks": step.get("potential_risks", []),
                }
                for step in potential_steps
            ],
        }

    failures_by_time = sorted(content_failures, key=lambda step: int(step.get("step_id") or 999))
    first_failure = failures_by_time[0]
    strongest = max(
        content_failures,
        key=lambda step: (
            float(step.get("failure_confidence") or 0),
            float(step.get("impact_score") or 0),
            float(step.get("risk_score") or 0),
        ),
    )
    propagation = [
        edge
        for step in content_failures
        for edge in (step.get("propagation_edges") or [])
    ]
    fixes: List[str] = []
    for step in content_failures:
        for fix in step.get("suggested_fix") or []:
            if fix not in fixes:
                fixes.append(fix)

    return {
        "overall_status": "failure",
        "main_failure_type": strongest.get("failure_type", "unknown"),
        "main_failure_label": strongest.get("failure_label", FAILURE_TYPES["unknown"]),
        "failure_stage": first_failure.get("step_id"),
        "summary": (
            f"When: 最早内容错误源出现在 Step {first_failure.get('step_id')}（{first_failure.get('stage_label')}）。"
            f" Where: 来源为 {', '.join(first_failure.get('source_refs') or [])}，"
            f"实际影响后续 {first_failure.get('affected_steps') or '暂无明确下游使用'}。"
            f" Why/How: {first_failure.get('failure_reason')}"
        ),
        "suggested_fixes": fixes[:6],
        "propagation_edges": propagation,
    }
