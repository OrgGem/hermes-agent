# Vendored js-tiktoken subset

This directory contains the minimal ESM subset of `js-tiktoken@1.0.21` needed
by Desktop Service X: the tokenizer core plus `o200k_base` and `cl100k_base`
rank data. The upstream package is MIT licensed and originates from
https://github.com/dqbd/tiktoken.

`base64.js` is a local Node/Electron adapter replacing the package's
`base64-js` runtime dependency, so the portable app remains self-contained
without changing the repository lockfile.
