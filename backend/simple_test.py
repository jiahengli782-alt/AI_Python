import asyncio
import sys
from main import call_doubao_api

async def test():
    print("Starting test...", flush=True)
    sys.stdout.flush()
    
    msg = [{"role": "user", "content": "hello"}]
    print("Calling API...", flush=True)
    output, t = await call_doubao_api(msg)
    print(f"Result: len={len(output)}, time={t}", flush=True)
    print("Done!", flush=True)

asyncio.run(test())