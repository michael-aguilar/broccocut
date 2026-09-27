# Broccocut

Broccocut is a fork of [mifi/lossless-cut](https://github.com/mifi/lossless-cut)
with a few local changes. The `upstream` remote is lossless-cut; merge
`upstream/master` into `master` to pick up its releases. Keep local changes small
and contained so those merges stay easy.

## Design tokens

Broccocut matches the Brocco styleguide from the brocco monorepo
(`~/Documents/GitHub/brocco`). `src/renderer/src/brocco-tokens.css` is a copy of
its tokens, so don't edit that file here. To change a shared value, edit
`packages/tokens` in the monorepo, then run this from the monorepo root:

```
pnpm tokens:copy ../broccocut/src/renderer/src/brocco-tokens.css
```

`src/renderer/src/theme.css` points Cut's variables (`--surface`, `--accent-*`,
`--radius-control`, and the Radix gray and cyan scales) at the tokens, and
`App.tsx` sets `data-brocco-theme` on `<html>` to follow Cut's dark mode. Control
styling lives in the component `.module.css` files. Prefer changing those
variables and module styles over restructuring upstream components.
