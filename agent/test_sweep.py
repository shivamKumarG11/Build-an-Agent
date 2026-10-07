import json, os, sys, time, urllib.request
env = dict(l.split("=", 1) for l in open("../../accounts/.env", encoding="utf8").read().splitlines() if "=" in l and not l.startswith("#"))
key = env["AGENT37_API_KEY"].split()[0]; inst = env["AGENT37_INSTANCE_ID"].split()[0]
p = open("sweep-prompt.md", encoding="utf8").read()
src = "- pricing: https://linear.app/pricing\n- changelog: https://linear.app/changelog\n- careers: https://linear.app/careers"
p = p.replace("{{name}}", "Linear").replace("{{slug}}", "linear").replace("{{sources}}", src).replace("{{baseline}}", "20260401")
t = time.time()
req = urllib.request.Request(f"https://{inst}.agent37.app/v1/responses", data=json.dumps({"input": p}).encode(),
                             headers={"X-Agent37-Key": key, "Content-Type": "application/json"})
try:
    out = urllib.request.urlopen(req, timeout=900).read().decode()
except urllib.error.HTTPError as e:
    out = "HTTP %s %s" % (e.code, e.read().decode()[:2000])
open("test-sweep-result.json", "w", encoding="utf8").write(out)
print("seconds:", int(time.time() - t)); print(out[:3000])
