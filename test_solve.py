import httpx
import asyncio
import json

async def test():
    async with httpx.AsyncClient(timeout=120.0) as client:
        print("Testing /api/solve...")
        response = await client.post(
            "http://localhost:8000/api/solve",
            json={"question": "什么是人工智能？"}
        )
        print(f"Status: {response.status_code}")
        if response.status_code == 200:
            data = response.json()
            print(f"Stages count: {len(data.get('stages', []))}")
            for i, stage in enumerate(data.get('stages', [])[:2]):
                print(f"\nStage {i+1}: {stage.get('name')}")
                print(f"Output: {stage.get('output', '')[:300]}")
        else:
            print(f"Error: {response.text}")

asyncio.run(test())
