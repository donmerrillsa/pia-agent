import requests, json
r = requests.post('https://pia-agent.netlify.app/.netlify/functions/run-pipeline-daily', json={'client_id': '743c39c3-2ad3-47c0-a503-0fe39e2a800f', 'send_email': True})
print('Status:', r.status_code)
data = r.json()
print(json.dumps(data, indent=2))