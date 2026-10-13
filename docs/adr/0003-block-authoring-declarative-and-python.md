# Blocks are authored declaratively or in Python, not in JavaScript

Users author Blocks either as declarative mathematics (transfer functions, state space, difference equations, formulas) or as Python executed by the local server; firmware C source is planned as a third form. JavaScript/TypeScript Blocks are deliberately not supported, even though the application itself is JavaScript, to avoid maintaining three execution runtimes and because the scientific tooling users need already exists in Python.

## Consequences

- Python Block execution requires a Python environment on the user's machine, managed through the local server.
- The browser renders results; it does not execute user-authored Block code.
