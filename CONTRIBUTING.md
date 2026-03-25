# Contributing to TrustCore Engine

## Code Quality Standards

Every change to this codebase must pass lint and formatting checks before merge. These are hard rules, not guidelines.

---

### TypeScript — Strict Mode

`tsconfig.json` enforces full strict mode. In addition:

| Option | Reason |
|--------|--------|
| `noUnusedLocals` | Dead variables are bugs waiting to happen |
| `noUnusedParameters` | If a parameter isn't used, the function contract is wrong |
| `noImplicitReturns` | All code paths must return explicitly |

### ESLint — Rules That Matter

**No `console.log`.**
Use `console.error` or `console.warn` for all operational output. Agents and servers write to stderr. There is no logging framework — `console.error` is the logging framework.

**No `!` non-null assertions.**
Every `!` is a lie to the type system. The rule is: if you know a value is non-null, prove it with a check. If you can't prove it, your code has a null path that needs surfacing. Extract the value, check it, and throw a meaningful error if it's absent:

```typescript
// Wrong
return result.rows[0]!.id;

// Right
const row = result.rows[0];
if (!row) throw new Error('INSERT returned no row — database error');
return row.id;
```

Don't use optional chaining (`?.`) to silently swallow null — that hides the problem. Surface it.

**No `async` functions without `await`.**
If a function is marked `async` but doesn't `await` anything, either remove `async` and return `Promise.resolve(value)`, or restructure so it actually awaits.

**No misused promises.**
Async callbacks in `setInterval`, `process.on`, and event listeners don't have their rejected Promises caught. Use `.catch()` chains instead:

```typescript
// Wrong
setInterval(async () => { await doWork(); }, 1000);

// Right
setInterval(() => { doWork().catch((err) => console.error('Error:', err)); }, 1000);
```

**Type imports.**
If an import is only used as a type, use `import type { Foo }` rather than `import { Foo }`.

---

### Prettier — Formatting

`.prettierrc` is the source of truth. 2-space indent, single quotes, semicolons, 100-char line width. Run `npm run format` before committing.

---

### Workflow

```bash
# Before every commit:
npm run lint       # must exit 0
npm run format:check   # must exit 0
npm test           # 29 tests must pass
```

If lint fails, the commit should not happen. CI enforces this — fix the violations, don't disable the rules.

---

### Adding a New Agent

1. Extend `SubAgent` — the base class handles polling, task lifecycle, and idle logging
2. Add the slug to `REGISTERED_AGENTS` in [src/agents/registry.ts](src/agents/registry.ts)
3. Add an `INSERT` to [db/seed.sql](db/seed.sql)
4. Add a `case` to [src/index.ts](src/index.ts)
5. Create a `Soul.md` in `src/agents/<slug>/` — a missing Soul.md is a system error, not a degraded mode

### ASBCP Dispatch Standard

Every task Alex dispatches to a sub-agent must be a validated `TaskMessage` from `@asbcp/core`. Two-layer schema is mandatory:

- **Intent layer** — set once by the user/system, never modified
- **Enrichment layer** — appended by Alex only, additive

See [ARCHITECTURE.md](ARCHITECTURE.md) Part 9 for the full standard.
