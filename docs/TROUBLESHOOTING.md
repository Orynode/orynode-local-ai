# Orynode Local AI troubleshooting

[简体中文](TROUBLESHOOTING_zh-CN.md) | [English](TROUBLESHOOTING.md)

Start with:

```bash
npm run doctor
```

The diagnostic command does not upload anything and does not print documents,
prompts, or other private data.

## TurboFieldfare is not installed

Run `npm run turbo:install`, or run `npm run setup` for the complete setup.
The installer checks Apple Silicon, macOS, Swift, Xcode, and available disk
space before building.

## The first model download reports missing resume state

Update the project and run `npm run model:install` again. A new install no
longer enables resume mode until a checkpoint actually exists.

## A model download was interrupted

Run `npm run model:install` again. Existing completed ranges will be reused.

## No progress is visible during a download

The current installer displays completion percentage, downloaded size, speed,
and estimated time remaining. For a download started by an older script, open a
second terminal and run:

```bash
npm run model:progress
```

This only reads the local checkpoint and does not interfere with the download.

## A partial model cannot be resumed

Only when the installer explicitly asks for a reset, run:

```bash
npm run model:reset
npm run model:install
```

This removes an incomplete download. A complete verified model is not
automatically removed by the recovery flow.

## The model is already installed

Repeating `npm run model:install` is safe. The installer verifies the existing
model and does not download the 15 GB again when verification succeeds.

## Insufficient disk space

A new model installation requires at least 16 GiB free in the project volume.
Runtime files are stored under `.orynode/models/`. Do not manually move partial
or resume files while an installation is running.

## Port 8080 is occupied

`npm run local` reuses an existing TurboFieldfare service, but refuses to treat
an unrelated process on port 8080 as the model server.

## Port 3000 is occupied

Stop the previous Orynode development server, normally with `Control+C`, and
run `npm run local` again.

## npm warns about unknown `devdir` configuration

This is an old user-level npm configuration warning, not an Orynode error. It
does not block installation. Optionally remove it with:

```bash
npm config delete devdir
```

## GitHub or Hugging Face network errors

The current installer automatically retries temporary download failures four
times. Every retry uses the local checkpoint, so completed data is not
downloaded again.

`NSURLErrorDomain Code=-1200` or `TLS` errors usually indicate a temporary
secure-connection failure involving the network, a local proxy, or a VPN.
Restart the proxy or VPN, or configure `huggingface.co` and `*.hf.co` to bypass
it, then run `npm run model:install` again.

Do not immediately run `model:reset`; the existing checkpoint is normally
still usable. Run `npm run model:progress` to inspect the preserved progress.

Public access normally requires no account. If Hugging Face requests
authentication, set `HF_TOKEN` in the current terminal and retry. Never include
access tokens in screenshots, issues, README files, or Git commits.

## Full recovery sequence

```bash
npm run doctor
npm run turbo:install
npm run model:install
npm run local
```

Do not delete the entire `.orynode` directory as a first recovery step because
it may contain a large resumable model download.
