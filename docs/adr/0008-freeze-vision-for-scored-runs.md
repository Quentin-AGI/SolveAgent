# Use one frozen vision pipeline for scored runs

All scored Generic Agent and FixAgent runs use the same Frozen Vision Pipeline and receive identical OCR, structured observations, Safety Trigger Signals and evidence references. Provider-native image understanding is tested separately as a compatibility capability and cannot affect Case Outcome, comparison or Safety Gate input. This gives up testing each provider's full native multimodal stack in the scored benchmark so that differences can be attributed to the FixAgent method rather than inconsistent visual evidence.
