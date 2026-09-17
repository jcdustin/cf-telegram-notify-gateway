# Contributing

Thanks for helping keep Cloudflare Telegram Notify Gateway small and dependable.

## Workflow

1. Fork the repository.
2. Create a focused branch from the default branch.
3. Make the smallest change that solves the problem.
4. Add or update tests.
5. Run all checks:

   ```sh
   npm ci
   npm run typecheck
   npm run lint
   npm test
   ```

6. Open a pull request using the template.

Small, focused pull requests are preferred. Explain the motivation, behavior change, security impact, and verification performed.

## Design boundaries

The project is intentionally a stateless, single-destination text relay. Avoid adding frameworks, runtime dependencies, storage, dashboards, automatic formatting, generic Telegram proxy features, or unrelated provider logic without prior agreement.

Do not weaken authentication, destination controls, payload limits, safe logging, or error sanitization. Tests must never call the real Telegram API or require production secrets.

## Style

- Use strict TypeScript and native Web APIs.
- Prefer plain functions and direct control flow.
- Avoid `any`, unnecessary abstractions, and speculative features.
- Keep public behavior and documentation in sync.

By contributing, you agree that your work is licensed under the MIT License.
