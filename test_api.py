import httpx
import asyncio

async def test():
    api_key = "13d7a163-eaaf-4ebd-8cd1-0f444ccbfd24"
    
    # 测试可用的模型
    models = [
        "doubao-1-5-pro-32k-250115",
        "doubao-1-5-lite-32k-250115", 
        "doubao-seed-1-6-251015"
    ]
    
    payload = {
        "messages": [
            {"role": "user", "content": "What is 1+1?"}
        ],
        "temperature": 0.7
    }
    
    for model in models:
        print(f"\n=== Testing: {model} ===")
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json"
        }
        
        test_payload = {**payload, "model": model}
        
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.post(
                    "https://ark.cn-beijing.volces.com/api/v3/chat/completions",
                    headers=headers,
                    json=test_payload
                )
                print(f"Status: {response.status_code}")
                if response.status_code == 200:
                    result = response.json()
                    content = result.get("choices", [{}])[0].get("message", {}).get("content", "")
                    print(f"Response: {content[:200]}")
                else:
                    print(f"Response: {response.text[:200]}")
        except Exception as e:
            print(f"Error: {e}")

asyncio.run(test())
