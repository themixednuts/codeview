# Project Rules

## Running the Project

Build + run via cargo (the `--` separates cargo args from binary args):
```
cargo run -p codeview-cli -- ui {path}
```

Examples:
- `cargo run -p codeview-cli -- ui .`
- `cargo run -p codeview-cli -- ui e:\projects\my-crate`
- `cargo run -p codeview-cli -- ui . --open` (also opens the browser)
- `cargo run -p codeview-cli -- ui . -- --all-features`

This compiles the CLI, runs rustdoc analysis, spawns the UI server, and prints the URL. Pass `--open` to also open the browser. The server process is tied to the CLI lifetime and terminates automatically when the CLI exits.

The binary is named `codeview` (not `codeview-cli`). Once built, you can run it directly:
```
codeview ui .
codeview ui . --open
```

To list running server instances:
```
cargo run -p codeview-cli -- ps
```

To generate a graph without opening the UI:
```
cargo run -p codeview-cli -- analyze --manifest-path {path/Cargo.toml} --out {output.json}
```

## Package Manager

Use **bun** for all package management operations:
- Install: `bun add <package>` or `bun add -D <package>` for dev dependencies
- Run scripts: `bun run <script>`
- Execute: `bunx <command>`

Do not use npm, yarn, or pnpm.
