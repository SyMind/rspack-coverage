# Rspack tooling monorepo

This repository contains focused tooling for understanding and improving Rspack bundles.

- [`rspack-coverage`](./packages/rspack-coverage/README.md) maps Chrome JavaScript Coverage back
  to Rspack chunks, modules, exports, and original source.
- [`star-export-loader`](./packages/star-export-loader/README.md) restores statically recognizable
  prebundled namespace runtimes to native `export * as namespace from` edges.

## Development

Requires Node.js 22.12+ and pnpm 11.

```bash
pnpm install
pnpm verify
```
