"""ModelViz Studio Python Block host.

Runs user-authored Python Blocks in the Project's environment, speaking JSON lines on
stdin/stdout. Contract of a Block module (see docs/python-blocks.md):

    class Block:
        def __init__(self, params: dict, sample_rate: float): ...
        def reset(self): ...
        def process(self, t: list[float], inputs: dict[str, list[float]]) -> dict[str, list[float]]:
            # one output value per input sample; output[k] may depend on inputs[0..k]
"""

import importlib.util
import json
import math
import os
import sys
import traceback

modules = {}
blocks = {}


def load_module(path):
    key = (path, os.stat(path).st_mtime_ns)
    mod = modules.get(key)
    if mod is None:
        name = "mvblock_%d" % len(modules)
        spec = importlib.util.spec_from_file_location(name, path)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        modules[key] = mod
    return mod


def where(exc):
    """file:line of the innermost frame inside user code."""
    tb = traceback.extract_tb(exc.__traceback__)
    user = [f for f in tb if not f.filename.endswith("runner.py")]
    frame = (user or tb)[-1]
    return "%s:%d" % (os.path.basename(frame.filename), frame.lineno)


def handle(msg):
    op = msg["op"]
    if op == "load":
        mod = load_module(msg["path"])
        cls = getattr(mod, msg.get("cls") or "Block", None)
        if cls is None:
            raise ValueError("module has no class %s" % (msg.get("cls") or "Block"))
        blocks[msg["handle"]] = (cls(dict(msg.get("params") or {}), float(msg["rate"])), msg["outputs"])
        return {}
    if op == "process":
        block, outputs = blocks[msg["handle"]]
        t = msg["t"]
        out = block.process(t, msg["inputs"])
        if not isinstance(out, dict):
            raise TypeError("process() must return a dict of output lists")
        result = {}
        for name in outputs:
            if name not in out:
                raise KeyError("process() returned no output %r" % name)
            values = [float(v) for v in out[name]]
            if len(values) != len(t):
                raise ValueError("output %r has %d values for %d samples" % (name, len(values), len(t)))
            for v in values:
                if not math.isfinite(v):
                    raise ValueError("output %r is not finite (%r)" % (name, v))
            result[name] = values
        return {"outputs": result}
    if op == "reset":
        block, _ = blocks[msg["handle"]]
        if hasattr(block, "reset"):
            block.reset()
        return {}
    if op == "drop":
        blocks.pop(msg["handle"], None)
        return {}
    raise ValueError("unknown op %r" % op)


def main():
    # Replies go to a private copy of stdout. Everything else written to stdout, by print() or by
    # extension modules writing to fd 1, goes to stderr, which the server shows as Block output.
    out = os.fdopen(os.dup(1), "w", encoding="utf-8")
    os.dup2(2, 1)
    sys.stdout = sys.stderr
    for line in sys.stdin:
        msg = json.loads(line)
        try:
            reply = handle(msg)
            reply["ok"] = True
        except Exception as exc:  # report every failure to the server, never crash
            reply = {"ok": False, "error": "%s: %s" % (type(exc).__name__, exc), "where": where(exc)}
        reply["id"] = msg.get("id")
        out.write(json.dumps(reply) + "\n")
        out.flush()


if __name__ == "__main__":
    main()
