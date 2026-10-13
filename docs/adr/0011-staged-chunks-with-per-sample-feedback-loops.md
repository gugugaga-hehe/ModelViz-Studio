# Systems run in stages: chunks for feed-forward Blocks, samples inside feedback loops

ADR-0010 makes chunks the unit of execution, but a Block inside a feedback loop needs its own previous output before its next input exists, so a whole chunk cannot be handed to it at once. Each run therefore splits the System into strongly connected components processed in dependency order: a component without a cycle processes the entire chunk in one go (one `process` call for a Python Block), while a feedback loop is stepped sample by sample, calling any Python Block inside it with one-sample chunks through the same contract.

## Consequences

- Results are exact in both cases; Python Blocks inside loops are slower (one round trip per sample) but still use the single chunked `process` contract.
- Python Blocks always have direct feedthrough, so a loop needs another Block without feedthrough (typically the Plant); a loop of only feedthrough Blocks is reported as an algebraic loop.
