# pi-longrun

Independent Pi extension. Read README.md, ARCHITECTURE.md and SECURITY.md before
changing behavior. Never add a mandatory sibling extension dependency or read
another extension's private state. Keep files as the default storage backend.

Gitflow: feature/* from develop; integrate into develop; release/* from develop;
merge the validated release into main and back into develop. Never publish
without an explicit user request. Tests: npm test. Lint: npm run lint.
Build: npm run build. Benchmark: npm run benchmark. Schema changes require
backward compatibility or an explicit recoverable migration and tests.
