import asyncio
import json
from main import plan_subprocesses, call_doubao_api

async def test():
    question = "介绍一下广州的广州塔并思考考试分析如何将其用于服务设计升级"
    print("Test question:", question)
    
    # Test planning
    subs = await plan_subprocesses(question)
    print("Total steps:", len(subs))
    
    for i, s in enumerate(subs):
        print(f"\n--- Step {i+1}: {s['name']} ---")
        print("risk_level:", s.get("risk_level"))
        sp = s.get("system_prompt", "")[:100] if s.get("system_prompt") else "EMPTY"
        ut = s.get("user_template", "")[:100] if s.get("user_template") else "EMPTY"
        print("system_prompt:", sp)
        print("user_template:", ut)
        
        # Test API call for each step
        try:
            messages = [
                {"role": "system", "content": s.get("system_prompt", "")},
                {"role": "user", "content": ut.format(question=question, previous_output="")}
            ]
            output, t = await call_doubao_api(messages)
            print(f"API OK! time={t}ms, output_len={len(output)}")
        except Exception as e:
            print(f"API FAILED: {e}")

asyncio.run(test())