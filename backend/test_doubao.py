"""
独立测试豆包 API 是否可用，绕开 FastAPI / 前端，专门排查 API Key、模型名、网络。
直接运行：python test_doubao.py
"""
import httpx
import json

import os
API_KEY = os.getenv("ARK_API_KEY", "ark-a5594092-1603-42bb-9712-36a670b45718-36ecd")
BASE_URL = "https://ark.cn-beijing.volces.com/api/v3"
MODEL = "doubao-seed-1-6-251015"  # 直接用模型名（火山方舟文档推荐方式）

def main():
    headers = {
        "Authorization": f"Bearer {API_KEY}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": MODEL,
        "messages": [
            {"role": "user", "content": "你好，回复一个字"}
        ],
        "reasoning_effort": "minimal",
        "max_completion_tokens": 100,
    }

    print(f"[测试] 模型: {MODEL}")
    print(f"[测试] 调用: {BASE_URL}/chat/completions")
    print("-" * 60)

    try:
        # trust_env=False 让 httpx 忽略系统的 HTTP_PROXY/HTTPS_PROXY 环境变量
        # 避免代理软件（Clash 等）干扰 SSL 连接
        with httpx.Client(timeout=60.0, trust_env=False) as client:
            r = client.post(
                f"{BASE_URL}/chat/completions",
                headers=headers,
                json=payload,
            )
            print(f"HTTP 状态码: {r.status_code}")
            print(f"响应内容:")
            try:
                print(json.dumps(r.json(), ensure_ascii=False, indent=2))
            except Exception:
                print(r.text)

            if r.status_code == 200:
                print("\n[成功] API Key 和模型都正常，问题在 FastAPI 后端逻辑或前端")
            elif r.status_code == 401:
                print("\n[失败] API Key 无效或已过期，去火山方舟控制台重新生成")
            elif r.status_code == 404:
                print("\n[失败] 模型名不对，或者你的账户没有这个模型的权限")
            elif r.status_code == 429:
                print("\n[失败] 触发限流或额度耗尽，去控制台充值/检查 RPM 限额")
            else:
                print(f"\n[失败] 其他错误，看上面的响应内容")
    except httpx.ConnectError as e:
        print(f"[网络错误] 连不上火山方舟服务器: {e}")
        print("可能原因: 防火墙 / 代理 / DNS 问题")
    except Exception as e:
        print(f"[未知错误] {type(e).__name__}: {e}")


if __name__ == "__main__":
    main()
