import requests
import os

# 设置测试 API Key
os.environ['ARK_API_KEY'] = 'your-api-key-here'

# 测试同步 API
try:
    r = requests.post('http://localhost:8000/api/solve', json={'question': '1+1等于几'}, timeout=60)
    print(f"Status: {r.status_code}")
    print(f"Response: {r.text[:1000]}")
except Exception as e:
    print(f"Error: {e}")
