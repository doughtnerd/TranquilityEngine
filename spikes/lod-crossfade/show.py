#!/usr/bin/env python3
"""Pretty-print the runner's JSON output (stdin): python3 show.py < out.json  (or piped from run.mjs)."""
import json
import sys

t = sys.stdin.read()
i = t.index('{\n "info"')
d = json.loads(t[i:])
print("renderer:", d["info"]["renderer"])
for k, v in d["results"].items():
    print("==", k)
    if isinstance(v, dict) and "frames" in v:
        for f in v["frames"]:
            f2 = dict(f)
            log = f2.pop("log", None)
            print(json.dumps(f2))
            if log:
                print("  hook order:", " > ".join(log))
    else:
        print(json.dumps(v))
