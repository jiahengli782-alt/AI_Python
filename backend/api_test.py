"""
独立API测试脚本 - 诊断网络和API问题
在 backend/ 目录下运行: python api_test.py
"""
import httpx
import asyncio
import os
import socket

API_KEY = "13d7a163-eaaf-4ebd-8cd1-0f444ccbfd24"
BASE_URL = "https://ark.cn-beijing.volces.com/api/v3/chat/completions"
HOST = "ark.cn-beijing.volces.com"

def check_dns():
    print("\n【DNS解析测试】")
    try:
        ip = socket.gethostbyname(HOST)
        print(f"✅ DNS解析成功: {HOST} -> {ip}")
        return True
    except socket.gaierror as e:
        print(f"❌ DNS解析失败: {e}")
        print("   可能原因: 网络不通、DNS被污染、或需要代理")
        return False

def check_proxy():
    print("\n【代理设置检测】")
    keys = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY"]
    proxy = None
    for k in keys:
        v = os.environ.get(k)
        if v:
            print(f"✅ 发现代理环境变量: {k}={v}")
            proxy = v
            break
    if not proxy:
        print("⚠️  未检测到代理环境变量")
        print("   如果你的网络需要代理，请在命令行设置:")
        print('   set HTTPS_PROXY=http://127.0.0.1:你的代理端口')
    return proxy

async def test_api(proxy=None):
    print("\n【API连接测试】")
    payload = {
        "model": "doubao-seed-1-6-251015",
        "messages": [{"role": "user", "content": "你好"}],
        "reasoning_effort": "minimal",
        "max_completion_tokens": 50,
    }
    headers = {
        "Authorization": f"Bearer {API_KEY}",
        "Content-Type": "application/json"
    }
    print(f"目标地址: {BASE_URL}")
    print(f"使用代理: {proxy or '无'}")
    try:
        try:
            client = httpx.AsyncClient(timeout=30.0, proxy=proxy) if proxy else httpx.AsyncClient(timeout=30.0)
        except TypeError:
            client = httpx.AsyncClient(timeout=30.0, proxies=proxy) if proxy else httpx.AsyncClient(timeout=30.0)
        async with client as client:
            response = await client.post(BASE_URL, headers=headers, json=payload)
            print(f"HTTP状态码: {response.status_code}")
            if response.status_code == 200:
                data = response.json()
                content = data["choices"][0]["message"]["content"]
                print(f"✅ API调用成功! 回复: {content}")
            else:
                print(f"❌ API返回错误:")
                print(f"   {response.text[:800]}")
    except httpx.ConnectError as e:
        print(f"❌ 连接失败 (ConnectError): {e}")
        print("   建议: 检查网络连接，或设置代理后重试")
    except httpx.TimeoutException:
        print(f"❌ 连接超时，服务器无响应")
    except Exception as e:
        print(f"❌ 其他异常: {type(e).__name__}: {e}")

async def main():
    print("=" * 55)
    print("豆包API网络诊断工具")
    print("=" * 55)

    dns_ok = check_dns()
    proxy = check_proxy()

    await test_api(proxy)

    if not dns_ok:
        print("\n【建议解决方案】")
        print("1. 如果你有VPN或代理软件（Clash/V2Ray等），请开启")
        print("   然后在命令行运行:")
        print('   set HTTPS_PROXY=http://127.0.0.1:7890')
        print("   python api_test.py")
        print()
        print("2. 也可以直接在 main.py 顶部硬编码代理地址:")
        print('   PROXY_URL = "http://127.0.0.1:7890"  # 改成你的代理端口')

    print("\n" + "=" * 55)

asyncio.run(main())
