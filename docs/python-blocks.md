# Python Blocks

A Python Block is a class in a Python file inside the Project, run in the Project's managed Python environment (ADR-0003, ADR-0005).

```yaml
# blocks/limiter.yaml
kind: python
module: python/limiter.py   # relative to the Project
class: Block                # default
inputs: [u]                 # default [u]
outputs: [y]                # default [y]
linear: false               # declare true only if the Block is linear
parameters:
  K: { default: 2 }
  limit: { default: 1 }
```

```python
# python/limiter.py
class Block:
    def __init__(self, params: dict, sample_rate: float):
        self.k = params["K"]
        self.limit = params["limit"]

    def reset(self):
        """Optional: return to the initial state."""

    def process(self, t: list[float], inputs: dict[str, list[float]]) -> dict[str, list[float]]:
        """One output value per input sample; output[k] may depend on inputs[0..k]."""
        return {"y": [max(-self.limit, min(self.limit, self.k * u)) for u in inputs["u"]]}
```

- `process` receives a chunk of samples (ADR-0010). Inside a feedback loop it is called with one-sample chunks (ADR-0011); keep state between calls in the instance.
- Outputs must be finite numbers, one per sample, for every declared output.
- Exceptions are reported with the file and line where they happened.
- Python Blocks have no analytic model: frequency-domain Analyses of Systems containing them use a measured Frequency Response.
