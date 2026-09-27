// Public entry of @keith/core: start Keith in-process (tests/e2e) or through the `keith` CLI.

export { type BootstrapOptions, bootstrap, KEITH_VERSION, type Keith } from './bootstrap.ts'
export { runCli } from './cli/index.ts'
